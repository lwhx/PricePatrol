import { afterEach, beforeEach, expect, it } from 'vitest';
import { getBuildInfo } from '../src/build-info.js';
import { Store } from '../src/database.js';

let store: Store;
beforeEach(() => { store = new Store(':memory:', 'a'.repeat(64)); });
afterEach(() => store.close());

it('returns safe local build defaults and only numeric schema markers', () => {
  store.setConfig('admin.hash', 'unrelated-private-value');
  store.setConfig('schema.invalid', 'unrelated-private-value');
  store.setConfig('schema.future-test', 2);
  expect(getBuildInfo(store, {})).toEqual({ sha: 'dev', time: null, schema: { 'collection-alerts': 1, 'future-test': 2 } });
  expect(getBuildInfo(store, { BUILD_SHA: 'invalid-value', BUILD_TIME: 'invalid-date' })).toEqual(getBuildInfo(store, {}));
});

it('reports the baked commit and UTC build time', () => {
  const sha = '0123456789abcdef0123456789abcdef01234567';
  expect(getBuildInfo(store, { BUILD_SHA: sha, BUILD_TIME: '2026-11-23T16:30:00Z' })).toEqual({
    sha, time: '2026-11-23T16:30:00.000Z', schema: { 'collection-alerts': 1 },
  });
});
