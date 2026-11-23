import { mkdtemp, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { Store } from '../src/database.js';
import { buildApp } from '../src/app.js';
import type { Collector } from '../../shared/contracts.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
const collector: Collector = { verify: async () => { throw new Error('No network'); }, collect: async () => { throw new Error('No network'); } };
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'pricepatrol-export-api-'));
  const store = new Store(join(dir, 'monitor.sqlite'), 'fixture-encryption-key-long-enough');
  const ctx = await buildApp({ store, collector, dataDir: dir, serveStatic: false });
  cleanup.push(async () => { await ctx.app.close(); store.close(); await rm(dir, { recursive: true, force: true }); });
  const auth = await ctx.app.inject({ method: 'POST', url: '/api/auth/setup', payload: { password: 'export-test-password' } });
  const headers = { cookie: auth.cookies.map(item => `${item.name}=${item.value}`).join('; ') };
  const at = new Date().toISOString();
  store.saveShop({ id: 'shop', name: '测试店', sellerId: 'seller', platform: 'tmall', enabled: true, sessionStatus: 'valid', hasCookies: false, lastError: null, lastVerifiedAt: at, createdAt: at, updatedAt: at });
  store.saveRun({ id: 'run', shopId: 'shop', shopName: '测试店', taskId: null, taskName: '手动', status: 'running', scope: 'all', productIds: [], expected: 1, processed: 0, failed: 0, rows: 0, checked: 0, excluded: 0, matched: 0, unknown: 0, message: '', createdAt: at, startedAt: at, finishedAt: null, parentRunId: null, failedProductIds: [], notificationStatus: 'disabled', taskSnapshot: null });
  store.saveProduct('run', { productId: '1000001', title: '沙发', rows: [{ shopId: 'shop', productId: '1000001', skuId: '2000001', title: '沙发', specs: '', seatSpec: '', color: '', backendPrice: '100', before: '100', after: '80', backendVerified: true, status: 'ok', sourceUrl: '', backendSource: 'fixture', detailFetchedAt: at, backendFetchedAt: at, stock: 1 }] });
  return { ...ctx, store, headers, dir };
}
const input = { query: { view: 'sku' }, scope: 'all', fields: ['productId', 'after'], format: 'csv', header: true };

it('preserves small-copy API and returns an authenticated streamed file for explicit jobs', async () => {
  const { app, exportJobs, headers, dir } = await setup();
  const small = await app.inject({ method: 'POST', url: '/api/exports', headers, payload: input });
  expect(small.statusCode).toBe(200); expect(small.json().content).toContain('1000001,80.00');
  const submitted = await app.inject({ method: 'POST', url: '/api/exports', headers, payload: { ...input, mode: 'file' } });
  expect(submitted.statusCode).toBe(202); expect(submitted.json()).not.toHaveProperty('content');
  const id = submitted.json().job.id;
  expect((await app.inject(`/api/export-jobs/${id}`)).statusCode).toBe(401);
  expect((await app.inject(`/api/export-jobs/${id}/download`)).statusCode).toBe(401);
  expect((await app.inject({method:'HEAD',url:`/api/export-jobs/${id}/download`})).statusCode).toBe(401);
  await vi.waitFor(async () => {
    const status = await app.inject({ url: `/api/export-jobs/${id}`, headers });
    expect(status.statusCode).toBe(200); expect(status.json().job.status).toBe('ready');
    expect(status.body).not.toContain(dir); expect(status.json().job).not.toHaveProperty('content');
  }, { timeout: 10000 });
  const file = await app.inject({ url: `/api/export-jobs/${id}/download`, headers });
  expect(file.statusCode).toBe(200); expect(file.body).toBe(small.json().content);
  const streamDownload=vi.spyOn(exportJobs,'download');
  const head = await app.inject({ method:'HEAD',url: `/api/export-jobs/${id}/download`, headers });
  expect(head.statusCode).toBe(200); expect(head.body).toBe('');
  expect(streamDownload).not.toHaveBeenCalled();
  expect(head.headers['content-length']).toBe(file.headers['content-length']);
  expect(head.headers['content-disposition']).toBe(file.headers['content-disposition']);
  expect(head.headers['content-type']).toBe(file.headers['content-type']);
  expect(file.headers['content-disposition']).toContain('attachment');
  expect(Number(file.headers['content-length'])).toBe(Buffer.byteLength(file.body));
  expect((await app.inject({ method: 'DELETE', url: `/api/export-jobs/${id}`, headers })).statusCode).toBe(409);
  await unlink(join(dir,'export-jobs',id+'.export'));
  expect((await app.inject({method:'HEAD',url:`/api/export-jobs/${id}/download`,headers})).statusCode).toBe(410);
}, 15000);

it('rejects invalid job input and keeps legacy inline download authentication and expiry', async () => {
  const { app, headers, store } = await setup();
  expect((await app.inject({ method: 'POST', url: '/api/exports', headers, payload: { ...input, mode: 'server-path', path: '/untrusted' } })).statusCode).toBe(400);
  const badQuery = await app.inject({ method: 'POST', url: '/api/exports', headers, payload: { ...input, query: { sort: 'unsupported-field' } } });
  expect(badQuery.statusCode).toBe(400);
  const small = (await app.inject({ method: 'POST', url: '/api/exports', headers, payload: input })).json();
  expect((await app.inject(`/api/exports/${small.token}/download`)).statusCode).toBe(401);
  expect((await app.inject({ url: `/api/exports/${small.token}/download`, headers })).body).toBe(small.content);
  const submitted = (await app.inject({ method: 'POST', url: '/api/exports', headers, payload: { ...input, mode: 'file' } })).json();
  await vi.waitFor(async () => expect((await app.inject({ url: `/api/export-jobs/${submitted.job.id}`, headers })).json().job.status).toBe('ready'), { timeout: 10000 });
  store.db.prepare('UPDATE export_jobs SET expires_at=0 WHERE id=?').run(submitted.job.id);
  expect((await app.inject({method:'HEAD',url:`/api/export-jobs/${submitted.job.id}/download`,headers})).statusCode).toBe(404);
  expect((await app.inject({ url: `/api/export-jobs/${submitted.job.id}/download`, headers })).statusCode).toBe(404);
}, 15000);

it('settles export requests before Fastify starts waiting for HTTP connections to drain',async()=>{
 const {app,exportJobs}=await setup();
 const closeJobs=vi.spyOn(exportJobs,'close');
 const serverClose=app.server.close.bind(app.server);
 let jobsStoppedBeforeDrain=false;
 vi.spyOn(app.server,'close').mockImplementation(callback=>{
  jobsStoppedBeforeDrain=closeJobs.mock.calls.length===1;
  return serverClose(callback);
 });
 await app.close();
 expect(jobsStoppedBeforeDrain).toBe(true);
});
