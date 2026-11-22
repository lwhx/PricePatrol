import { it, expect } from 'vitest';
import { Store } from '../src/database.js';
import { buildApp } from '../src/app.js';
import { CollectorError } from '../src/collector/errors.js';
import type { Collector } from '../../shared/contracts.js';

it('reports missing appKey separately and never echoes raw transport credentials', async () => {
  let failure: Error = new CollectorError('APPKEY_REQUIRED', 'internal details');
  const collector: Collector = {
    verify: async () => { throw failure; },
    collect: async () => { throw new Error('unused'); },
  };
  const store = new Store(':memory:', 'a'.repeat(64));
  const { app } = await buildApp({ store, collector, dataDir: '.local/test-data', serveStatic: false });
  try {
    const auth = await app.inject({ method: 'POST', url: '/api/auth/setup', payload: { password: 'test-password-for-fixture' } });
    const cookie = auth.cookies.map(c => `${c.name}=${c.value}`).join('; ');
    const submit = () => app.inject({ method: 'POST', url: '/api/shops', headers: { cookie }, payload: { platform: 'tmall', cookies: 'cookie2=fixture-secret' } });
    const missing = await submit();
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error).toContain('缺少 appKey');
    failure = new Error('https://remote.example?cookie2=fixture-secret');
    const unknown = await submit();
    expect(unknown.statusCode).toBe(400);
    expect(unknown.body).not.toContain('fixture-secret');
    expect(unknown.body).not.toContain('remote.example');
    expect(store.listShops()).toHaveLength(0);
  } finally { await app.close(); store.close(); }
});

it('accepts an alphanumeric appKey on both account creation and credential updates', async () => {
  const appKey = ['fixture', 'Key', '2026'].join('_') + '-a';
  const seen: string[] = [];
  const collector: Collector = {
    verify: async input => {
      seen.push(input.appKey || '');
      return { sellerId: 'fixture-seller', shopName: 'Fixture shop', platform: input.platform, cookies: [{ name: 'cookie2', value: 'fixture-session', domain: '.taobao.com' }], userAgent: input.userAgent || 'Fixture browser', appKey: input.appKey || '' };
    },
    collect: async () => { throw new Error('unused'); },
  };
  const store = new Store(':memory:', 'a'.repeat(64));
  const { app } = await buildApp({ store, collector, dataDir: '.local/test-data', serveStatic: false });
  try {
    const auth = await app.inject({ method: 'POST', url: '/api/auth/setup', payload: { password: 'fixture_password_long' } });
    const cookie = auth.cookies.map(c => `${c.name}=${c.value}`).join('; ');
    const created = await app.inject({ method: 'POST', url: '/api/shops', headers: { cookie }, payload: { platform: 'tmall', cookies: 'cookie2=fixture-session', appKey } });
    expect(created.statusCode).toBe(200);
    const updated = await app.inject({ method: 'PATCH', url: `/api/shops/${created.json().shop.id}`, headers: { cookie }, payload: { appKey } });
    expect(updated.statusCode).toBe(200);
    expect(seen).toEqual([appKey, appKey]);
    const rejected = await app.inject({ method: 'PATCH', url: `/api/shops/${created.json().shop.id}`, headers: { cookie }, payload: { appKey: 'invalid key' } });
    expect(rejected.statusCode).toBe(400);
  } finally { await app.close(); store.close(); }
});
