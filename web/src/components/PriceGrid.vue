<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue';
import { AgGridVue } from 'ag-grid-vue3';
import { themeQuartz, ModuleRegistry, AllCommunityModule } from 'ag-grid-community';
ModuleRegistry.registerModules([AllCommunityModule]);
import type { ColDef, GridApi, GridReadyEvent, SelectionChangedEvent, SortChangedEvent, ColumnState } from 'ag-grid-community';
import type { PriceRow, ProductRow } from '../../../shared/contracts.js';
import { money, discount, dateTime, statusLabels } from '../lib/format';
import { readPreference, writePreference } from '../lib/preferences';
const props = defineProps<{ rows: (PriceRow | ProductRow)[]; view: 'sku' | 'product'; selectedIds: string[]; loading: boolean }>();
const emit = defineEmits<{ select: [rows: (PriceRow | ProductRow)[]]; detail: [row: PriceRow | ProductRow]; sort: [field: string, order: 'asc' | 'desc'] }>();
const api = ref<GridApi>(), columnsOpen = ref(false); let restoring = false;
const gridTheme = themeQuartz.withParams({ accentColor: '#0e918b', backgroundColor: '#ffffff', headerBackgroundColor: '#f7f9fc', headerTextColor: '#73849a', borderColor: '#e7edf3', rowHoverColor: '#eff8f6', fontSize: 12, headerFontSize: 12, rowVerticalPaddingScale: 1.15, wrapperBorderRadius: 0, browserColorScheme: 'light' });
const priceColumn = (field: string, headerName: string, extra: Partial<ColDef> = {}): ColDef => ({ field, headerName, width: 100, minWidth: 88, valueFormatter: (p: { value?: string | null }) => money(p.value), type: 'numericColumn', cellClass: field === 'after' ? 'after-price' : '', ...extra });
const discountColumn = (field: string, headerName: string, extra: Partial<ColDef> = {}): ColDef => ({ field, headerName, width: 104, minWidth: 94, valueFormatter: (p: { value?: string | null }) => discount(p.value), tooltipValueGetter: (p: { value?: string | null }) => `${p.value ?? '无法判断'}；折扣＝优惠后价 ÷ 后台标价 × 10，比较不按显示值舍入`, ...extra });
const titleColumn: ColDef = { field: 'title', headerName: '商品标题', width: 190, minWidth: 170, maxWidth: 380, flex: 1, tooltipField: 'title' };
const statusColumn: ColDef = { field: 'status', headerName: '状态', width: 80, minWidth: 74, valueFormatter: (p: { value?: string }) => statusLabels[p.value || ''] || p.value || '—' };
// 默认只露出价格决策列：店铺、商品、标题、SKU、三价、状态与折扣。
// 规格与审计字段默认收起（可在“显示列”开启），让 1440px 视口无需横向滚动即可看到三价和折扣。
const skuColumns: ColDef[] = [
  { field: 'shopName', headerName: '店铺', width: 118, minWidth: 104, pinned: 'left', tooltipField: 'shopName' },
  { field: 'productId', headerName: '商品 ID', width: 124, minWidth: 108, tooltipField: 'productId' },
  titleColumn,
  { field: 'specs', headerName: '规格', width: 200, minWidth: 160, tooltipField: 'specs' },
  priceColumn('backendPrice', '后台标价'),
  priceColumn('before', '优惠前价'),
  priceColumn('after', '优惠后价'),
  statusColumn,
  { field: 'skuId', headerName: 'SKU ID', width: 124, minWidth: 110, tooltipField: 'skuId', hide: true },
  priceColumn('saving', '优惠金额', { hide: true }),
  priceColumn('priceDifference', '优惠前与后台差额', { hide: true, width: 150 }),
  { field: 'error', headerName: '失败原因', sortable: false, width: 250, tooltipField: 'error', hide: true },
  { field: 'backendSource', headerName: '后台来源', sortable: false, width: 180, hide: true },
  { field: 'backendFetchedAt', headerName: '后台采集时间', width: 180, valueFormatter: (p: { value?: string | null }) => dateTime(p.value), hide: true },
  { field: 'detailFetchedAt', headerName: '前台采集时间', width: 180, valueFormatter: (p: { value?: string | null }) => dateTime(p.value), hide: true },
  { field: 'tags', headerName: '标签', sortable: false, width: 140, valueFormatter: (p: { value?: string[] }) => p.value?.join('、') || '—', hide: true },
  { field: 'note', headerName: '备注', width: 180, hide: true },
  // 折扣是核心决策列，固定在右侧：横向滚动审计列时仍保持可见。
  discountColumn('discount', '实际折扣', { pinned: 'right' }),
];
const productColumns: ColDef[] = [
  { field: 'shopName', headerName: '店铺', width: 118, minWidth: 104, pinned: 'left', tooltipField: 'shopName' },
  { field: 'productId', headerName: '商品 ID', width: 124, minWidth: 108, tooltipField: 'productId' },
  titleColumn,
  { field: 'skuCount', headerName: 'SKU 数', width: 86, minWidth: 78 },
  discountColumn('minDiscount', '最低折扣'),
  discountColumn('maxDiscount', '最高折扣'),
  priceColumn('minAfter', '优惠后最低'),
  priceColumn('maxAfter', '优惠后最高'),
  statusColumn,
  { field: 'matchedSkuCount', headerName: '命中 SKU', width: 96, hide: true },
  { field: 'unknownCount', headerName: '无法判断', width: 96, hide: true },
  { field: 'updatedAt', headerName: '数据时间', width: 185, valueFormatter: (p: { value?: string | null }) => dateTime(p.value), hide: true },
];
const columns = computed<ColDef[]>(() => (props.view === 'sku' ? skuColumns : productColumns).map(column => ({ ...column })));
const layoutKey = computed(() => `columns-v3-${props.view}`);
const visible = ref<string[]>([]);
const columnFields = computed(() => columns.value.map(column => column.field).filter((field): field is string => !!field));
function chosenColumns(value: string[]) { api.value?.setColumnsVisible(columnFields.value, false); api.value?.setColumnsVisible(value, true); visible.value = value; saveColumns(); }
function saveColumns() { if (!api.value) return; const state = api.value.getColumnState().map(({ sort, sortIndex, ...column }) => column); writePreference(layoutKey.value, state); }
function resetColumns() {
  if (!api.value) return;
  writePreference(layoutKey.value, []);
  api.value.applyColumnState({ state: columns.value.flatMap(column => column.field ? [{ colId: column.field, width: column.width, hide: !!column.hide, pinned: (column.pinned ?? null) as ColumnState['pinned'], sort: null }] : []), applyOrder: true });
  visible.value = api.value.getColumnState().filter(column => !column.hide).map(column => column.colId);
  saveColumns();
}
const rowSelection = { mode: 'multiRow' as const, checkboxes: true, headerCheckbox: true, enableClickSelection: false };
async function syncSelection() { if (!api.value) return; restoring = true; const ids = new Set(props.selectedIds); api.value.forEachNode(node => node.setSelected(ids.has(node.data.id))); await nextTick(); restoring = false; }
function ready(event: GridReadyEvent) {
  api.value = event.api;
  const saved = readPreference<ColumnState[]>(layoutKey.value, []);
  if (saved.length) event.api.applyColumnState({ state: saved, applyOrder: true });
  visible.value = event.api.getColumnState().filter(col => !col.hide).map(col => col.colId); void syncSelection();
}
function changed(event: SelectionChangedEvent) { if (!restoring && event.source !== 'rowDataChanged' && event.source !== 'api') emit('select', event.api.getSelectedRows()); }
function sortChanged(event: SortChangedEvent) { const column = event.api.getColumnState().find(item => item.sort); emit('sort', column?.colId || 'updatedAt', column?.sort === 'asc' ? 'asc' : 'desc'); }
watch(layoutKey, () => { if (!api.value) return; const saved = readPreference<ColumnState[]>(layoutKey.value, []); if (saved.length) api.value.applyColumnState({ state: saved, applyOrder: true }); visible.value = api.value.getColumnState().filter(column => !column.hide).map(column => column.colId); });
watch(() => props.selectedIds, syncSelection, { deep: true });
defineExpose({ getColumns: () => api.value?.getColumnState().map(({ sort, sortIndex, ...column }) => column) || [], restoreColumns: (state: ColumnState[]) => { api.value?.applyColumnState({ state, applyOrder: true }); visible.value = api.value?.getColumnState().filter(column => !column.hide).map(column => column.colId) || []; saveColumns(); } });
</script>
<template><div><div class="toolbar" style="justify-content:space-between"><span class="muted">表头复选框只勾选当前页，跨页全选请点“选择全部筛选结果”。双击行查看详情与价格历史；拖动表头调整列顺序。折扣固定在右侧，SKU ID 与审计列默认收起，可随时开启。</span><el-popover v-model:visible="columnsOpen" placement="bottom-end" width="360" trigger="click"><template #reference><el-button size="small">显示列 / 列顺序</el-button></template><p class="muted">勾选展示字段，表格内拖动表头排序。</p><el-checkbox-group :model-value="visible" @change="(v: string[]) => chosenColumns(v)"><el-checkbox v-for="column in columns" :key="column.field" :value="column.field">{{ column.headerName }}</el-checkbox></el-checkbox-group><div style="margin-top:10px"><el-button text size="small" @click="resetColumns">恢复默认列</el-button></div></el-popover></div><div class="grid-wrap"><AgGridVue class="price-grid" :theme="gridTheme" :row-data="rows" :column-defs="columns" :default-col-def="{ sortable: true, comparator: () => 0, resizable: true, minWidth: 74, suppressMovable: false }" :get-row-id="p => p.data.id" :row-selection="rowSelection" :selection-column-def="{ pinned: 'left', width: 46, resizable: false }" :loading="loading" :row-height="48" :header-height="42" :tooltip-show-delay="250" overlay-no-rows-template="<div style='padding:30px;color:#8493a5'>暂无符合条件的数据库记录。请先连接账号并运行采集，或调整筛选条件。</div>" @grid-ready="ready" @selection-changed="changed" @row-data-updated="syncSelection" @sort-changed="sortChanged" @column-moved="saveColumns" @column-resized="saveColumns" @row-double-clicked="(e: { data?: PriceRow | ProductRow }) => e.data && emit('detail', e.data)" /></div></div></template>
<style>.price-grid .after-price{color:#07847d;font-weight:600}.price-grid .ag-cell.ag-right-aligned-cell{text-align:right}.price-grid .ag-pinned-right-header{border-left:1px solid #e7edf3}.price-grid .ag-cell[col-id="title"],.price-grid .ag-cell[col-id="specs"]{line-height:47px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}</style>