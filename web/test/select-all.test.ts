import { it, expect, vi } from 'vitest';
import type { QueryInput, QueryResult, PriceRow } from '../../shared/contracts.js';
import { loadAllSelection } from '../src/lib/selection';
import { querySchema } from '../../server/src/validation.js';
const row = (i: number) => ({ id: `shop:product:${i}`, shopId: 'shop', productId: String(100000 + i) } as PriceRow);
const response = (page: number, rows: PriceRow[], total = 920, revision = 12): QueryResult => ({ rows, total, revision, page, pageSize: 500, skuCount: total, productCount: total });
it('selects all 920 matching rows across pages, preserving applied filters and sort without mutating the visible page', async () => {
  const query: QueryInput = { search: '沙发', shopIds: ['shop'], view: 'sku', sort: 'after', order: 'asc', page: 3, pageSize: 200 };
  const snapshot = JSON.stringify(query);
  const fetchPage = vi.fn(async (q: QueryInput) => response(q.page!, Array.from({ length: q.page === 1 ? 500 : 420 }, (_, i) => row((q.page! - 1) * 500 + i))));
  const selected = await loadAllSelection(query, { total: 920, revision: 12 }, fetchPage);
  expect(selected.size).toBe(920);
  expect(selected.has('shop:product:919')).toBe(true);
  expect(fetchPage.mock.calls.map(([q]) => q)).toEqual([{ ...query, page: 1, pageSize: 500 }, { ...query, page: 2, pageSize: 500 }]);
  expect(JSON.stringify(query)).toBe(snapshot);
});
it('does not return a partial selection when database revision changes during pagination', async () => {
  let calls = 0;
  await expect(loadAllSelection({}, { total: 920, revision: 12 }, async () => {
    calls++; return response(calls, Array.from({ length: calls === 1 ? 500 : 420 }, (_, i) => row((calls - 1) * 500 + i)), 920, calls === 1 ? 12 : 13);
  })).rejects.toThrow('数据已变化');
});
it('detects truncated results, changed totals and duplicate IDs rather than calling a partial result all', async () => {
  for (const result of [response(1, [row(0)], 920), response(1, [row(0)], 1), response(1, Array.from({ length: 500 }, () => row(0)))]) {
    await expect(loadAllSelection({}, { total: 920, revision: 12 }, async () => result)).rejects.toThrow();
  }
});
it('cancels an in-flight selection before any later pages or stale selection are committed', async () => {
  const controller = new AbortController();
  const fetchPage = vi.fn(async () => { controller.abort(); return response(1, Array.from({ length: 500 }, (_, i) => row(i))); });
  await expect(loadAllSelection({}, { total: 920, revision: 12 }, fetchPage, controller.signal)).rejects.toThrow();
  expect(fetchPage).toHaveBeenCalledTimes(1);
});
it('handles zero matches without fetching, reports network failure and enforces the same 20,000 row limit as selected exports', async () => {
  const fetchPage = vi.fn(async (): Promise<QueryResult> => { throw new Error('网络异常'); });
  expect((await loadAllSelection({}, { total: 0, revision: 12 }, fetchPage)).size).toBe(0);
  expect(fetchPage).not.toHaveBeenCalled();
  await expect(loadAllSelection({}, { total: 20001, revision: 12 }, fetchPage)).rejects.toThrow('20,000');
  expect(fetchPage).not.toHaveBeenCalled();
  await expect(loadAllSelection({}, { total: 920, revision: 12 }, fetchPage)).rejects.toThrow('网络异常');
});
it('accepts 1,000 rows per page at the HTTP validation boundary and rejects requests beyond it', () => {
  expect(querySchema.parse({ pageSize: 1000 }).pageSize).toBe(1000);
  expect(querySchema.safeParse({ pageSize: 1001 }).success).toBe(false);
});
