import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { Store } from '../src/database.js';
import { buildApp } from '../src/app.js';
import type { Collector } from '../../shared/contracts.js';

const close: Array<() => Promise<void>> = [];
afterEach(async () => { for (const action of close.splice(0)) await action(); });
const collector: Collector = { verify: async () => { throw new Error('No external requests in maintenance tests'); }, collect: async () => { throw new Error('No collection in maintenance tests'); } };
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'patrol-maintenance-api-'));
  const store = new Store(join(dir, 'monitor.sqlite'), 'test-only-maintenance-encryption-key');
  const ctx = await buildApp({ store, collector, dataDir: dir, serveStatic: false });
  close.push(async () => { await ctx.app.close(); store.close(); await rm(dir, { recursive: true, force: true }); });
  const auth = await ctx.app.inject({ method: 'POST', url: '/api/auth/setup', payload: { password: 'local-test-password' } });
  const headers = { cookie: auth.cookies.map(item => `${item.name}=${item.value}`).join('; ') };
  return { ...ctx, store, headers, dir };
}

it('requires authentication and rejects filesystem paths supplied through maintenance settings', async () => {
  const { app, headers, dir } = await setup();
  for (const url of ['/api/maintenance/settings', '/api/maintenance/status']) expect((await app.inject(url)).statusCode).toBe(401);
  expect((await app.inject({ method: 'POST', url: '/api/maintenance/run', payload: { kind: 'backup' } })).statusCode).toBe(401);
  const settings = await app.inject({ url: '/api/maintenance/settings', headers });
  expect(settings.json()).toMatchObject({ retentionDays: 180, alertRetentionDays: 365, cleanupEnabled: false, backupsEnabled: true, backupKeep: 14 });
  expect((await app.inject({ method: 'PUT', url: '/api/maintenance/settings', headers, payload: { backupDir: '/untrusted' } })).statusCode).toBe(400);
  const status = await app.inject({ url: '/api/maintenance/status', headers });
  expect(status.json()).toMatchObject({ running: false, backupCount: 0 });
  expect(status.body).not.toContain(dir);
});

it('validates legacy retention before modifying notification settings', async () => {
  const { app, store, headers } = await setup();
  const invalid = await app.inject({ method: 'PUT', url: '/api/settings', headers, payload: { retentionDays: 730, sendKey: 'SCT-fixture-only', notificationEnabled: true } });
  expect(invalid.statusCode).toBe(400);
  expect(store.getConfig('notification.enabled', false)).toBe(false);
  expect(store.getConfig('notification.key', '')).toBe('');
  expect((await app.inject({ url: '/api/settings', headers })).json().retentionDays).toBe(180);
  expect((await app.inject({ method: 'PUT', url: '/api/maintenance/settings', headers, payload: { retentionDays: 730, alertRetentionDays: 730 } })).statusCode).toBe(200);
  expect((await app.inject({ url: '/api/settings', headers })).json().retentionDays).toBe(730);
});

it('previews without side effects and backs up before the authenticated legacy cleanup route deletes rows', async () => {
  const { app, store, headers } = await setup();
  const at = '2020-01-01T00:00:00.000Z';
  store.db.prepare('INSERT INTO shops(id,payload) VALUES (?,?)').run('shop', '{}');
  store.db.prepare('INSERT INTO runs(id,shop_id,created_at,payload) VALUES (?,?,?,?)').run('old', 'shop', at, JSON.stringify({ id: 'old', status: 'success', finishedAt: at }));
  const payload = { before: '2021-01-01T00:00:00.000Z' };
  const preview = await app.inject({ method: 'POST', url: '/api/maintenance/cleanup/preview', headers, payload });
  expect(preview.statusCode).toBe(200); expect(preview.json().runs).toBe(1);
  expect((await app.inject({ url: '/api/maintenance/status', headers })).json().backupCount).toBe(0);
  const result = await app.inject({ method: 'POST', url: '/api/maintenance/cleanup', headers, payload });
  expect(result.statusCode).toBe(200); expect(result.json().deleted).toBe(1);
  const status = (await app.inject({ url: '/api/maintenance/status', headers })).json();
  expect(status).toMatchObject({ backupCount: 1, lastDeleted: 1 });
  expect(status.lastBackupAt).toBeTruthy(); expect(status.lastCleanupAt).toBeTruthy();
  expect(store.db.prepare('SELECT id FROM runs WHERE id=?').get('old')).toBeUndefined();
});
