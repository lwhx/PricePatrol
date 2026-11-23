import { expect, it } from 'vitest';
import { createCollector, type HttpTransport } from '../src/collector/index.js';
import { Store } from '../src/database.js';
import { Worker } from '../src/worker.js';
import { buildApp } from '../src/app.js';
import type { VerifiedAccount } from '../../shared/contracts.js';

const credentials: VerifiedAccount = { platform: 'taobao', sellerId: '777777', shopName: 'Fixture shop', cookies: [{ name: 'unb', value: 'fixture-user', domain: '.taobao.com' }], userAgent: 'fixture-browser', appKey: 'fixture-key' };
function challenge(ret: string[], nested = false) {
  let calls = 0;
  const transport: HttpTransport = async () => {
    calls++;
    return { status: 200, headers: {}, body: JSON.stringify(nested
      ? { ret: ['SUCCESS::ok'], data: { result: { success: false, code: ret[0] } } }
      : { ret, data: { url: 'https://example.invalid/verify?secret=fixture-private-token' } }) };
  };
  return { collector: createCollector({ transport }), calls: () => calls };
}

it.each([
  ['FAIL_SYS_USER_VALIDATE::需要验证'],
  ['RGV587_ERROR::安全验证'],
  ['FAIL_SYS_USER_VALIDATE::需要验证', 'RGV587_ERROR::blocked'],
])('recognizes marketplace verification challenges rather than misleading users to wait for a rate limit: %j', async (...codes: string[]) => {
  const { collector, calls } = challenge(codes);
  await expect(collector.verify(credentials)).rejects.toMatchObject({ code: 'VERIFICATION_REQUIRED' });
  // One listing call on the chosen platform plus a single probe on the other platform.
  expect(calls()).toBe(2);
});

it('recognizes a nested business verification challenge without exposing its remote text', async () => {
  const { collector, calls } = challenge(['RGV587_ERROR'], true);
  await expect(collector.verify(credentials)).rejects.toMatchObject({ code: 'VERIFICATION_REQUIRED' });
  expect(calls()).toBe(2);
});

it('keeps true marketplace traffic limits distinct from security verification', async () => {
  const { collector } = challenge(['FAIL_SYS_TRAFFIC_LIMIT::slow down']);
  await expect(collector.verify(credentials)).rejects.toMatchObject({ code: 'RATE_LIMIT' });
});

it('pauses the real collection worker for verification while preserving saved credentials', async () => {
  const store = new Store(':memory:', 'x'.repeat(64));
  const at = new Date().toISOString();
  store.saveShop({ id: 'fixture-shop', sellerId: credentials.sellerId, name: credentials.shopName, platform: 'taobao', enabled: true, sessionStatus: 'valid', hasCookies: true, lastVerifiedAt: at, lastError: null, createdAt: at, updatedAt: at }, credentials);
  const { collector, calls } = challenge(['FAIL_SYS_USER_VALIDATE::blocked', 'RGV587_ERROR::blocked']);
  const worker = new Worker(store, collector);
  try {
    const run = worker.enqueue('fixture-shop');
    await worker.whenIdle();
    expect(store.getRun(run.id)).toMatchObject({ status: 'auth_required', finishedAt: null });
    expect(store.getShop('fixture-shop')).toMatchObject({ sessionStatus: 'auth_required' });
    expect(store.getCredentials('fixture-shop')).toEqual(credentials);
    expect(calls()).toBe(1);
    expect(() => worker.enqueue('fixture-shop')).toThrow('账号需要重新验证');
  } finally { await worker.close(); store.close(); }
});

it('returns an actionable verification instruction when adding an account, without saving unverified credentials', async () => {
  const store = new Store(':memory:', 'x'.repeat(64));
  const { collector, calls } = challenge(['FAIL_SYS_USER_VALIDATE::blocked', 'RGV587_ERROR::blocked']);
  const { app } = await buildApp({ store, collector, dataDir: '.local/test-data', serveStatic: false });
  try {
    const auth = await app.inject({ method: 'POST', url: '/api/auth/setup', payload: { password: 'fixture-password-long' } });
    const cookie = auth.cookies.map(c => `${c.name}=${c.value}`).join('; ');
    const response = await app.inject({ method: 'POST', url: '/api/shops', headers: { cookie }, payload: { platform: 'taobao', cookies: 'unb=fixture-user', appKey: 'fixture-key' } });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'VERIFICATION_REQUIRED', error: expect.stringContaining('安全验证') });
    expect(response.body).not.toContain('限流');
    expect(response.body).not.toContain('fixture-private-token');
    expect(store.listShops()).toEqual([]);
    expect(calls()).toBe(2);
  } finally { await app.close(); store.close(); }
});
