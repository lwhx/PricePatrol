import { afterEach, expect, it, vi } from 'vitest';
import { Store } from '../src/database.js';
import { Worker } from '../src/worker.js';
import type { Collector, VerifiedAccount } from '../../shared/contracts.js';

const disposals: Array<() => Promise<void>> = [];
afterEach(async () => { for (const dispose of disposals.splice(0)) await dispose(); });
function fixture(concurrency?: number) {
  const store = new Store(':memory:', 'concurrency-fixture-key-at-least-32-chars');
  const at = new Date().toISOString();
  const credentials: VerifiedAccount = { sellerId: 'seller-a', shopName: 'A', platform: 'tmall', cookies: [], userAgent: 'fixture', appKey: 'test' };
  for (const id of ['a', 'b', 'c']) store.saveShop({ id, name: id, sellerId: 'seller-' + id, platform: 'tmall', enabled: true, sessionStatus: 'valid', hasCookies: true, lastVerifiedAt: at, lastError: null, createdAt: at, updatedAt: at }, { ...credentials, sellerId: 'seller-' + id });
  const calls: Array<{shopId:string;release:()=>void;aborted:()=>boolean}> = [];
  const collector: Collector = { verify: async () => credentials, collect: async options => {
    await new Promise<void>(resolve => {
      calls.push({ shopId: options.shopId, release: resolve, aborted: () => options.signal.aborted });
      options.signal.addEventListener('abort', () => resolve(), { once: true });
    });
    return { cookies: [], expected: 0, processed: 0, failedProductIds: [], coverageComplete: true };
  } };
  const completed = vi.fn();
  const worker = new Worker(store, collector, completed, undefined, concurrency);
  disposals.push(async () => { await worker.close(); store.close(); });
  return { store, worker, collector, completed, calls };
}

it('keeps default collection sequential and rejects unbounded concurrency', async () => {
  const { worker, store, collector, calls } = fixture();
  expect(() => new Worker(store, collector, undefined, undefined, 5)).toThrow();
  worker.enqueue('a');
  await vi.waitFor(() => expect(calls.map(call => call.shopId)).toEqual(['a']));
  worker.enqueue('b');
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(calls).toHaveLength(1);
  calls[0]!.release();
  await vi.waitFor(() => expect(calls.map(call => call.shopId)).toEqual(['a', 'b']));
  calls[1]!.release(); await worker.whenIdle();
});

it('uses an available cross-shop slot while another shop is blocked and serializes same-shop runs', async () => {
  const { worker, store, completed, calls } = fixture(2);
  const a = worker.enqueue('a');
  await vi.waitFor(() => expect(calls).toHaveLength(1));
  const a2 = worker.enqueue('a'), b = worker.enqueue('b');
  await vi.waitFor(() => expect(calls.map(call => call.shopId)).toEqual(['a', 'b']));
  const c = worker.enqueue('c');
  expect(store.getRun(a2.id)?.status).toBe('queued');
  expect(store.getRun(c.id)?.status).toBe('queued');
  worker.stop(a.id);
  expect(() => worker.resume(a.id)).toThrow(/正在结束/);
  await vi.waitFor(() => expect(calls).toHaveLength(3));
  expect(calls[2]!.shopId).toBe('a');
  expect(calls[1]!.aborted()).toBe(false);
  expect(store.getRun(a.id)?.status).toBe('stopped');
  expect(store.getRun(b.id)?.status).toBe('running');
  calls[1]!.release(); calls[2]!.release();
  await vi.waitFor(() => expect(calls).toHaveLength(4));
  calls[3]!.release(); await worker.whenIdle();
  expect(store.getRun(a2.id)).toMatchObject({ status: 'success', trigger: 'manual', alertDispatchStatus: 'not_applicable' });
  expect(completed).not.toHaveBeenCalled();
});

it('aborts every active shop during close and leaves queued work for explicit recovery', async () => {
  const { worker, store, collector, calls } = fixture(2);
  const a = worker.enqueue('a');
  await vi.waitFor(() => expect(calls).toHaveLength(1));
  const b = worker.enqueue('b');
  await vi.waitFor(() => expect(calls).toHaveLength(2));
  const c = worker.enqueue('c');
  await worker.close();
  expect(calls.every(call => call.aborted())).toBe(true);
  expect(store.getRun(a.id)?.status).toBe('stopped');
  expect(store.getRun(b.id)?.status).toBe('stopped');
  expect(store.getRun(c.id)?.status).toBe('queued');
  const restarted = new Worker(store, collector, undefined, undefined, 2);
  restarted.recover();
  expect(store.getRun(c.id)?.status).toBe('recoverable');
  await restarted.close();
  expect(calls).toHaveLength(2);
});
