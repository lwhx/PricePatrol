import type { QueryInput, RuleGroup } from '../../../shared/contracts.js';

const storageKey = 'price-monitor:price-query';
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const fields = new Set(['discount', 'backendPrice', 'before', 'after', 'saving', 'priceDifference', 'title', 'specs', 'productId', 'skuId', 'status']);
const operators = new Set(['lt', 'lte', 'eq', 'ne', 'gte', 'gt', 'between', 'contains', 'notContains', 'in', 'notIn']);
/** Whitelist the shape before restoring legacy URLs or browser storage into reactive UI fields. */
export function normalizePriceQuery(value: unknown): QueryInput | null {
  if (!object(value)) return null;
  const query: QueryInput = {};
  for (const key of ['shopIds', 'productIds', 'skuIds'] as const) {
    const items = value[key];
    if (Array.isArray(items) && items.length <= 20000 && items.every(item => typeof item === 'string')) query[key] = [...items];
  }
  for (const key of ['search', 'sort', 'runId', 'taskId'] as const) {
    if (typeof value[key] === 'string' && value[key].length <= 200) query[key] = value[key];
  }
  for (const key of ['from', 'to'] as const) {
    if (typeof value[key] === 'string' && Number.isFinite(Date.parse(value[key]))) query[key] = value[key];
  }
  if (value.view === 'sku' || value.view === 'product') query.view = value.view;
  if (value.matchMode === 'any' || value.matchMode === 'all') query.matchMode = value.matchMode;
  if (value.order === 'asc' || value.order === 'desc') query.order = value.order;
  if (value.whitelistMode === 'all' || value.whitelistMode === 'included' || value.whitelistMode === 'excluded') query.whitelistMode = value.whitelistMode;
  if (Number.isSafeInteger(value.page) && Number(value.page) >= 1 && Number(value.page) <= 100000) query.page = Number(value.page);
  if (Number.isSafeInteger(value.pageSize) && Number(value.pageSize) >= 1 && Number(value.pageSize) <= 1000) query.pageSize = Number(value.pageSize);
  if (Array.isArray(value.groups) && value.groups.length <= 10 && value.groups.every(group => object(group)
    && (group.mode === 'all' || group.mode === 'any') && Array.isArray(group.conditions) && group.conditions.length >= 1 && group.conditions.length <= 30
    && group.conditions.every(c => object(c) && typeof c.field === 'string' && fields.has(c.field) && typeof c.op === 'string' && operators.has(c.op)
      && typeof c.value === 'string' && c.value.length <= 20000 && (c.upper === undefined || typeof c.upper === 'string')
      && (c.includeLower === undefined || typeof c.includeLower === 'boolean') && (c.includeUpper === undefined || typeof c.includeUpper === 'boolean')))) {
    query.groups = value.groups.map(group => ({ mode: group.mode, conditions: group.conditions.map((c: Record<string, unknown>) => ({
      field: c.field, op: c.op, value: c.value, upper: c.upper, includeLower: c.includeLower, includeUpper: c.includeUpper,
    })) })) as RuleGroup[];
  }
  return query;
}

export function readPriceQuery(): QueryInput {
  try { return normalizePriceQuery(JSON.parse(globalThis.sessionStorage?.getItem(storageKey) || 'null')) || {}; }
  catch { return {}; }
}
export function savePriceQuery(query: QueryInput): void {
  try { globalThis.sessionStorage?.setItem(storageKey, JSON.stringify(query)); }
  catch { /* Keep the current reactive state when session storage is unavailable. */ }
}
export function legacyPriceQuery(q: unknown, run: unknown): QueryInput | null {
  if (q === undefined && run === undefined) return null;
  let query: QueryInput = {};
  try { if (typeof q === 'string') query = normalizePriceQuery(JSON.parse(q)) || {}; } catch { /* Invalid legacy input uses defaults. */ }
  if (typeof run === 'string' && run.length <= 100) query.runId = run;
  return query;
}
/** Consume a router-link's hidden state once so returning later does not overwrite newer filters. */
export function takePriceNavigation(): QueryInput | null {
  try {
    const state: unknown = globalThis.history?.state;
    if (!object(state) || !Object.hasOwn(state, 'priceQuery') || state.priceQuery === null) return null;
    const priceQuery = state.priceQuery;
    // Keep a consumed marker: Vue Router merges its cached state with the browser's state when navigating.
    // Deleting the property would allow that merge to resurrect the original navigation filters.
    globalThis.history.replaceState({ ...state, priceQuery: null }, '');
    return normalizePriceQuery(priceQuery);
  } catch { return null; }
}
