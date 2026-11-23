import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, expect, it } from 'vitest';
import type { CollectionTask, Collector, Shop, VerifiedAccount } from '../../shared/contracts.js';
import { buildApp } from '../src/app.js';
import { Store, type RunRecord } from '../src/database.js';
import { getOperations } from '../src/operations.js';
import { cleanupRetention } from '../src/retention.js';
import { Scheduler } from '../src/scheduler.js';
import { Worker } from '../src/worker.js';

const key = 'x'.repeat(64);
const at = '2026-11-01T09:00:00.000Z';
const credentials: VerifiedAccount = { sellerId: 'seller', shopName: 'Fixture shop', platform: 'tmall', cookies: [], userAgent: 'test', appKey: '1' };
const collector: Collector = { verify: async () => credentials, collect: async () => ({ cookies: [], expected: 0, processed: 0, failedProductIds: [], coverageComplete: true }) };
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function seedShop(store: Store, sessionStatus: Shop['sessionStatus'] = 'valid'): Shop {
  const shop: Shop = { id: randomUUID(), sellerId: credentials.sellerId, name: credentials.shopName, platform: 'tmall', enabled: true, sessionStatus, lastVerifiedAt: at, lastError: null, createdAt: at, updatedAt: at, hasCookies: true };
  store.saveShop(shop, credentials);
  return shop;
}

function seedTask(store: Store, shop: Shop): CollectionTask {
  const task: CollectionTask = { id: randomUUID(), shopId: shop.id, name: 'Daily fixture', enabled: true, scope: 'all', productIds: [], schedule: { kind: 'daily', time: '09:00', days: [], timezone: 'UTC' }, version: 1, createdAt: at, updatedAt: at, nextRunAt: at };
  store.saveTask(task);
  return task;
}

function saveRun(store: Store, shop: Shop, status: RunRecord['status'], startedAt: string, finishedAt: string | null) {
  const id = randomUUID();
  store.saveRun({ id, shopId: shop.id, shopName: shop.name, taskId: null, taskName: 'Fixture', trigger: 'manual', status, createdAt: startedAt, startedAt, finishedAt, scope: 'all', productIds: [], expected: 0, processed: 0, failed: 0, rows: 0, checked: 0, excluded: 0, matched: 0, unknown: 0, message: '', parentRunId: null, failedProductIds: [], notificationStatus: 'disabled', taskSnapshot: null });
  return id;
}

function memoryStore() {
  const store = new Store(':memory:', key);
  cleanups.push(() => store.close());
  return store;
}

it('persists each due invalid-account skip across restart and deduplicates the same occurrence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pricepatrol-operations-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'monitor.sqlite');
  const store = new Store(path, key);
  cleanups.push(() => store.close());
  const task = seedTask(store, seedShop(store, 'auth_required'));
  const secondDue = new Date('2026-11-02T10:00:00.000Z');
  new Scheduler(store, new Worker(store, collector)).tick(secondDue);
  store.saveTask(task); // A stale schedule cursor must not create a second record.
  store.close();

  const reopened = new Store(path, key);
  cleanups.push(() => reopened.close());
  new Scheduler(reopened, new Worker(reopened, collector)).tick(secondDue);
  const events = getOperations(reopened, secondDue).recentSchedules;
  expect(events.map(({ scheduledFor, outcome, reason, runId }) => ({ scheduledFor, outcome, reason, runId }))).toEqual([
    { scheduledFor: '2026-11-02T09:00:00.000Z', outcome: 'skipped', reason: 'account_invalid', runId: null },
    { scheduledFor: at, outcome: 'skipped', reason: 'account_invalid', runId: null },
  ]);
  expect(reopened.getTask(task.id)?.nextRunAt).toBe('2026-11-03T09:00:00.000Z');
  expect(reopened.listRuns()).toEqual([]);
});

it('bounds catch-up after years offline and prunes expired schedule records', async () => {
  const store = memoryStore();
  const shop = seedShop(store);
  const task = seedTask(store, shop);
  store.saveTask({ ...task, nextRunAt: '2020-01-01T09:00:00.000Z' });
  const worker = new Worker(store, collector);
  const scheduler = new Scheduler(store, worker);
  const overdue = new Date(at);
  scheduler.tick(overdue);
  await worker.whenIdle();

  const events = getOperations(store, overdue).recentSchedules;
  expect(events).toHaveLength(31);
  const [latest, ...missed] = events;
  expect(latest).toMatchObject({ scheduledFor: at, outcome: 'enqueued', reason: 'queued' });
  expect(missed.every(event => event.outcome === 'skipped' && event.reason === 'missed')).toBe(true);
  const runs = store.listRuns();
  expect(runs).toHaveLength(1);
  expect(runs[0]).toMatchObject({ id: latest?.runId, status: 'success', trigger: 'scheduled' });

  store.saveTask({ ...store.getTask(task.id)!, enabled: false });
  scheduler.tick(new Date('2026-12-02T10:00:00.000Z'));
  expect(store.db.prepare('SELECT count(*) AS count FROM schedule_events').get()?.count).toBe(0);
});

it('records a failed enqueue without leaving a partial scheduled collection', () => {
  const store = memoryStore();
  const task = seedTask(store, seedShop(store));
  store.db.exec("CREATE TRIGGER fail_schedule BEFORE INSERT ON runs BEGIN SELECT RAISE(ABORT, 'test database failure'); END;");
  const scheduler = new Scheduler(store, new Worker(store, collector));
  const due = new Date(at);
  scheduler.tick(due);
  expect(getOperations(store, due).recentSchedules).toMatchObject([{ taskId: task.id, outcome: 'failed', reason: 'enqueue_failed', runId: null }]);
  expect(store.listRuns()).toEqual([]);
  expect(store.getTask(task.id)?.nextRunAt).toBe('2026-11-02T09:00:00.000Z');
});

it('uses the last complete success for data age and counts trailing failed attempts', () => {
  const store = memoryStore();
  const shop = seedShop(store);
  const empty = seedShop(store);
  saveRun(store, shop, 'failed', '2026-11-01T09:00:00.000Z', '2026-11-01T09:05:00.000Z');
  saveRun(store, shop, 'success', '2026-11-02T09:00:00.000Z', '2026-11-02T09:05:00.000Z');
  saveRun(store, shop, 'failed', '2026-11-03T09:00:00.000Z', '2026-11-03T09:05:00.000Z');
  saveRun(store, shop, 'auth_required', '2026-11-04T09:00:00.000Z', null);
  saveRun(store, shop, 'running', '2026-11-04T09:35:00.000Z', null);
  const overview = getOperations(store, new Date('2026-11-04T09:40:00.000Z'));
  expect(overview.shops.find(row => row.shopId === shop.id)).toMatchObject({
    lastSuccessAt: '2026-11-02T09:05:00.000Z', dataAgeSeconds: 174900, consecutiveFailures: 2,
    lastAttemptAt: '2026-11-04T09:35:00.000Z', lastStatus: 'running',
  });
  expect(overview.shops.find(row => row.shopId === empty.id)).toMatchObject({ lastSuccessAt: null, dataAgeSeconds: null, consecutiveFailures: 0 });
  expect(overview.queues).toMatchObject({ collectionRunning: 1, collectionQueued: 0 });
});

it('preserves the success date and failure streak after retained batch evidence is cleaned up', () => {
  const store = memoryStore();
  const shop = seedShop(store);
  saveRun(store, shop, 'failed', '2026-11-01T09:00:00.000Z', '2026-11-01T09:05:00.000Z');
  saveRun(store, shop, 'success', '2026-11-02T09:00:00.000Z', '2026-11-02T09:05:00.000Z');
  saveRun(store, shop, 'failed', '2026-11-03T09:00:00.000Z', '2026-11-03T09:05:00.000Z');
  const retry = saveRun(store, shop, 'auth_required', '2026-11-04T09:00:00.000Z', null);
  const now = new Date('2026-11-06T10:00:00.000Z');
  const metrics = () => getOperations(store, now).shops[0]!;
  expect(metrics().consecutiveFailures).toBe(2);
  const prune = () => cleanupRetention(store, { historyBefore: now.toISOString(), alertBefore: at });
  expect(prune().runs).toBe(3);
  expect(metrics()).toMatchObject({ lastSuccessAt: '2026-11-02T09:05:00.000Z', consecutiveFailures: 2 });

  const run = store.getRun(retry)!;
  store.saveRun({ ...run, status: 'queued' });
  store.saveRun({ ...run, status: 'failed', finishedAt: '2026-11-04T10:05:00.000Z' });
  expect(prune().runs).toBe(1);
  expect(metrics()).toMatchObject({ consecutiveFailures: 2, lastStatus: 'failed', lastAttemptAt: '2026-11-04T10:05:00.000Z' });

  saveRun(store, shop, 'partial', '2026-11-05T09:00:00.000Z', '2026-11-05T09:05:00.000Z');
  expect(metrics()).toMatchObject({ lastSuccessAt: '2026-11-02T09:05:00.000Z', consecutiveFailures: 0, lastStatus: 'partial' });
});

it('requires authentication for operations and reports unknown database errors without leaking request data', async () => {
  const store = memoryStore();
  let output = '';
  const logStream = new Writable({ write(chunk, _encoding, callback) { output += chunk.toString(); callback(); } });
  const { app } = await buildApp({ store, collector, dataDir: '.local/operations-tests', serveStatic: false, logStream });
  cleanups.push(() => app.close());
  expect((await app.inject('/api/operations')).statusCode).toBe(401);
  expect((await app.inject('/api/health')).json()).toEqual({ ok: true, version: '0.1.0' });
  const login = await app.inject({ method: 'POST', url: '/api/auth/setup', payload: { password: 'sensitive-admin-password' } });
  const headers = { cookie: login.cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; '), 'request-id': 'untrusted-client-request-id' };
  expect((await app.inject({ url: '/api/operations', headers })).statusCode).toBe(200);
  expect((await app.inject({ url: '/api/unknown-sensitive-path', headers })).statusCode).toBe(404);
  const malformed = await app.inject({ method: 'POST', url: '/api/prices/query', headers, payload: { sort: 'not-a-supported-sort' } });
  expect(malformed.statusCode).toBe(400);
  store.db.exec('DROP TABLE latest');
  const failure = await app.inject({ method: 'POST', url: '/api/prices/query?remote=https%3A%2F%2Fexample.invalid%2Fsecret-url', headers, payload: { search: 'sensitive-send-key' } });
  expect(failure.statusCode).toBe(500);
  expect(failure.body).not.toContain('no such table');
  const records = output.trim().split('\n').map(line => JSON.parse(line));
  expect(records).toContainEqual(expect.objectContaining({ event: 'request_completed', statusCode: 500, route: '/api/prices/query', reqId: expect.any(String) }));
  expect(records).toContainEqual(expect.objectContaining({ event: 'request_failed', errorKind: 'internal' }));
  for (const secret of ['sensitive-admin-password', 'sensitive-send-key', 'secret-url', 'untrusted-client-request-id', 'unknown-sensitive-path', 'no such table', login.cookies[0]!.value]) expect(output).not.toContain(secret);
});

it('correlates a background collection failure with its run without logging the remote error', async () => {
  const store = memoryStore();
  const shop = seedShop(store);
  const failure = 'Cookie=private-cookie-symbol; https://user:password@example.invalid/private';
  let output = '';
  const logStream = new Writable({ write(chunk, _encoding, callback) { output += chunk.toString(); callback(); } });
  const { app, worker } = await buildApp({ store, dataDir: '.local/operations-tests', serveStatic: false, logStream, collector: { ...collector, collect: async () => { throw Error(failure); } } });
  cleanups.push(() => app.close());
  const run = worker.enqueue(shop.id);
  await worker.whenIdle();
  expect(store.getRun(run.id)?.status).toBe('failed');
  expect(output).not.toContain('private-cookie-symbol');
  expect(output).not.toContain('example.invalid');
  const records = output.trim().split('\n').map(line => JSON.parse(line));
  expect(records).toContainEqual(expect.objectContaining({ event: 'collection_failed', runId: run.id }));
});

it('logs the source run when dispatch fails and leaves dispatch pending for recovery', async () => {
  const store = memoryStore();
  const shop = seedShop(store);
  const task = seedTask(store, shop);
  store.saveAlertTask({ id: randomUUID(), collectionTaskId: task.id, shopId: shop.id, name: 'Fixture alert', enabled: true, scope: 'all', productIds: [], version: 1, createdAt: at, updatedAt: at, rules: [], whitelist: { productIds: [], titleKeywords: [] }, notify: false });
  store.db.exec("CREATE TRIGGER fail_alert_dispatch BEFORE INSERT ON alert_runs BEGIN SELECT RAISE(ABORT, 'private-database-error-body'); END;");
  let output = '';
  const logStream = new Writable({ write(chunk, _encoding, callback) { output += chunk.toString(); callback(); } });
  const { app, scheduler, worker } = await buildApp({ store, collector, dataDir: '.local/operations-tests', serveStatic: false, logStream });
  cleanups.push(() => app.close());
  scheduler.tick(new Date(at));
  await worker.whenIdle();
  const run = store.listRuns()[0]!;
  expect(run).toMatchObject({ status: 'success', alertDispatchStatus: 'pending' });
  expect(store.listAlertRuns()).toEqual([]);
  const records = output.trim().split('\n').map(line => JSON.parse(line));
  expect(records).toContainEqual(expect.objectContaining({ event: 'alert_dispatch_failed', runId: run.id }));
  expect(output).not.toContain('private-database-error-body');
});
