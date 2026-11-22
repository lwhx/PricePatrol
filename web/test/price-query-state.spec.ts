import { beforeEach, expect, it } from 'vitest';
import { legacyPriceQuery, normalizePriceQuery, readPriceQuery, savePriceQuery, takePriceNavigation } from '../src/lib/price-query-state';
beforeEach(() => { sessionStorage.clear(); history.replaceState({}, ''); });
it('stores business filters in the tab session without changing the browser URL', () => {
  const before = location.href;
  const query = { view: 'sku' as const, shopIds: ['fixture-shop'], productIds: ['100000'], search: '私有关键词', page: 3, pageSize: 1000, runId: 'fixture-run' };
  savePriceQuery(query);
  expect(readPriceQuery()).toEqual(query);
  expect(location.href).toBe(before);
});
it('rejects invalid object shapes and drops unknown or malformed UI fields from legacy input', () => {
  expect(normalizePriceQuery(null)).toBeNull(); expect(normalizePriceQuery([])).toBeNull();
  expect(legacyPriceQuery('{', undefined)).toEqual({});
  expect(legacyPriceQuery('[1]', undefined)).toEqual({});
  expect(normalizePriceQuery({ cookies: 'never restore', productIds: 'bad', groups: [{ mode: 'all', conditions: [null] }], from: 'bad-date', pageSize: 50000, search: '保留' })).toEqual({ search: '保留' });
});
it('consumes hidden run navigation exactly once while preserving router history metadata', () => {
  const before = location.href;
  history.replaceState({ position: 4, back: '/tasks', scroll: { top: 120 }, priceQuery: { view: 'sku', runId: 'fixture-run' } }, '');
  const cachedState = { ...history.state };
  expect(takePriceNavigation()).toEqual({ view: 'sku', runId: 'fixture-run' });
  expect(takePriceNavigation()).toBeNull();
  expect({ ...cachedState, ...history.state }.priceQuery).toBeNull();
  expect(history.state).toEqual({ position: 4, back: '/tasks', scroll: { top: 120 }, priceQuery: null });
  expect(location.href).toBe(before);
});
