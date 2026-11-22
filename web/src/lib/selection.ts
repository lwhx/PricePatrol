import type { QueryInput, QueryResult, PriceRow, ProductRow } from '../../../shared/contracts.js';

export interface IdentifiedRow { id: string; shopId: string; productId: string }
export function updatePageSelection<T extends IdentifiedRow>(previous: Map<string, T>, pageRows: T[], selectedPage: T[]): Map<string, T> {
  const next = new Map(previous);
  for (const row of pageRows) next.delete(row.id);
  for (const row of selectedPage) next.set(row.id, row);
  return next;
}
export function groupSelectedProducts(rows: IdentifiedRow[]) {
  const grouped = new Map<string, Set<string>>();
  for (const row of rows) { if (!grouped.has(row.shopId)) grouped.set(row.shopId, new Set()); grouped.get(row.shopId)!.add(row.productId); }
  return [...grouped].map(([shopId, ids]) => ({ shopId, productIds: [...ids] }));
}

export class SelectionSnapshotChangedError extends Error {
  constructor() { super('数据已变化，请刷新列表后重新选择全部筛选结果。'); }
}

/** Collect matching rows atomically: never expose a partial or mixed-revision selection. */
export async function loadAllSelection(
  input: QueryInput,
  expected: Pick<QueryResult, 'total' | 'revision'>,
  fetchPage: (query: QueryInput) => Promise<QueryResult>,
  signal?: AbortSignal,
  progress?: (count: number) => void,
): Promise<Map<string, PriceRow | ProductRow>> {
  const selected = new Map<string, PriceRow | ProductRow>();
  if (expected.total > 20000) throw new Error('一次最多勾选 20,000 行，请缩小筛选范围；复制 / 导出可直接选择全部筛选结果。');
  const snapshot: QueryInput = JSON.parse(JSON.stringify(input));
  for (let page = 1; selected.size < expected.total; page++) {
    signal?.throwIfAborted();
    const result = await fetchPage({ ...snapshot, page, pageSize: 500 });
    signal?.throwIfAborted();
    if (result.revision !== expected.revision || result.total !== expected.total) throw new SelectionSnapshotChangedError();
    if (result.page !== page || result.pageSize !== 500 || result.rows.length !== Math.min(500, expected.total - selected.size)) throw new Error('筛选结果未完整返回，请刷新后重试。');
    for (const row of result.rows) {
      if (selected.has(row.id)) throw new Error('筛选结果包含重复行，请刷新后重试。');
      selected.set(row.id, row);
    }
    progress?.(selected.size);
  }
  return selected;
}
