<script setup lang="ts">
import { ref, reactive, computed, onMounted, onActivated, onBeforeUnmount, watch, nextTick } from 'vue';
import type { ColumnState } from 'ag-grid-community';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import type { QueryInput, QueryResult, PriceRow, ProductRow, Shop, AlertTask, Run } from '../../../shared/contracts.js';
import { get, post, remove, request } from '../api/client';
import { useLatest } from '../composables/useLatest';
import { useFeedback, confirmAction } from '../composables/useFeedback';
import { parseIds, dateTime } from '../lib/format';
import { readPreference, writePreference } from '../lib/preferences';
import { fromDateTimeLocal, toDateTimeLocal, readPriceQuery, savePriceQuery, legacyPriceQuery, takePriceNavigation } from '../lib/price-query-state';
import { updatePageSelection, loadAllSelection, SelectionSnapshotChangedError } from '../lib/selection';
import PageHeader from '../components/PageHeader.vue';
import StatCards from '../components/StatCards.vue';
import ErrorBanner from '../components/ErrorBanner.vue';
import RuleEditor from '../components/RuleEditor.vue';
import PriceGrid from '../components/PriceGrid.vue';
import CopyDialog from '../components/CopyDialog.vue';
import PriceHistory from '../components/PriceHistory.vue';
import RunCompare from '../components/RunCompare.vue';
import BatchAction from '../components/BatchAction.vue';
defineOptions({ name: 'PricesPage' });
const route = useRoute(), router = useRouter();
const baseQuery = (): QueryInput => ({ view: 'sku', matchMode: 'any', shopIds: [], groups: [], productIds: [], skuIds: [], search: '', sort: 'updatedAt', order: 'desc', page: 1, pageSize: readPreference('page-size', 50), whitelistMode: 'all' });
function incomingQuery(): QueryInput | null { return takePriceNavigation() ?? legacyPriceQuery(route.query.q, route.query.run); }
function formQuery(input: QueryInput): QueryInput {
  return { ...JSON.parse(JSON.stringify(input)), from: toDateTimeLocal(input.from), to: toDateTimeLocal(input.to) };
}
function hasAdvancedFilters(input: QueryInput): boolean {
  return !!(input.runId || input.taskId || input.from || input.to || input.groups?.length);
}
const startingQuery: QueryInput = { ...baseQuery(), ...(incomingQuery() ?? readPriceQuery()) };
savePriceQuery(startingQuery);
const draft = reactive(formQuery(startingQuery)), applied = ref<QueryInput>(startingQuery);
const idsText = ref(draft.productIds?.join('\n') || ''), skuText = ref(draft.skuIds?.join('\n') || '');
const result = ref<QueryResult>({ rows: [], total: 0, productCount: 0, skuCount: 0, page: 1, pageSize: 50, revision: 0 });
const shops = ref<Shop[]>([]), tasks = ref<AlertTask[]>([]), runs = ref<Run[]>([]);
interface SavedQuery { id: string; name: string; query: QueryInput }
const savedQueries = ref<SavedQuery[]>([]), savedId = ref(''), savedName = ref(''), saveDialog = ref(false), advanced = ref(hasAdvancedFilters(startingQuery));
const selected = ref(new Map<string, PriceRow | ProductRow>()), selectionHint = ref('');
const grid = ref<InstanceType<typeof PriceGrid>>();
interface SavedLayout { columns: ColumnState[]; copy: Record<string, unknown> | null }
const copyOpen = ref(false), history = ref<PriceRow | ProductRow | null>(null), comparing = ref(false), batchType = ref<'task' | 'whitelist' | 'collect' | 'annotation' | null>(null);
const resource = useLatest(), referenceResource = useLatest(), feedback = useFeedback();
const activeFilters = computed(() => {
  const input = applied.value;
  const filters: string[] = [];
  if (input.shopIds?.length) {
    const names = input.shopIds.slice(0, 3).map(id => shops.value.find(shop => shop.id === id)?.name || id);
    filters.push(`店铺 ${names.join('、')}${input.shopIds.length > names.length ? ` 等 ${input.shopIds.length} 家` : ''}`);
  }
  if (input.search) filters.push(`关键词 ${input.search}`);
  if (input.productIds?.length) filters.push(`商品 ID ${input.productIds.length} 个`);
  if (input.skuIds?.length) filters.push(`SKU ID ${input.skuIds.length} 个`);
  if (input.runId) {
    const run = runs.value.find(item => item.id === input.runId);
    filters.push(`数据批次 ${run ? `${run.shopName} / ${dateTime(run.createdAt)}` : input.runId}`);
  }
  if (input.taskId) {
    filters.push(`预警任务 ${tasks.value.find(task => task.id === input.taskId)?.name || input.taskId}`);
    if (input.whitelistMode === 'excluded') filters.push('仅白名单排除');
    if (input.whitelistMode === 'included') filters.push('仅白名单未排除');
  }
  if (input.from) filters.push(`采集起始 ${toDateTimeLocal(input.from).replace('T', ' ')}`);
  if (input.to) filters.push(`采集截止 ${toDateTimeLocal(input.to).replace('T', ' ')}`);
  if (input.groups?.length) filters.push(`自定义条件 ${input.groups.length} 组`);
  if (input.view === 'product' && input.matchMode === 'all') filters.push('全部 SKU 满足');
  return filters.join(' · ');
});
const selectionSummary = computed(() => selected.value.size > 0 && selected.value.size === result.value.total ? `已选择全部筛选结果，共 ${selected.value.size} 行（包含所有分页）。` : selectionHint.value);
const selectedRows = computed(() => [...selected.value.values()]), selectedIds = computed(() => [...selected.value.keys()]);
const selectingAll = ref(false), selectionProgress = ref(0);
let selectionController: AbortController | undefined;
function cancelSelecting() { selectionController?.abort(); selectionController = undefined; selectingAll.value = false; }
onBeforeUnmount(cancelSelecting);
function clearSelection(reason = '') { cancelSelecting(); selectionHint.value = reason; if (selected.value.size && reason) { selectionHint.value = reason; ElMessage.info(reason); } selected.value = new Map(); }
function choose(rows: (PriceRow | ProductRow)[]) { cancelSelecting(); selected.value = updatePageSelection(selected.value, result.value.rows, rows); selectionHint.value = ''; }
async function selectAllMatching() {
  if (resource.loading.value || selectingAll.value || !result.value.total) return;
  const controller = new AbortController(); selectionController = controller;
  selectingAll.value = true; selectionProgress.value = 0; feedback.error.value = '';
  try {
    const all = await loadAllSelection(applied.value, result.value,
      input => request<QueryResult>('/prices/query', { method: 'POST', body: input, signal: controller.signal }),
      controller.signal, count => { if (selectionController === controller) selectionProgress.value = count; });
    if (selectionController === controller && !controller.signal.aborted) {
      selected.value = all; selectionHint.value = `已选择全部筛选结果，共 ${all.size} 行（包含所有分页）。`;
    }
  } catch (error) {
    if (!controller.signal.aborted) {
      if (error instanceof SelectionSnapshotChangedError) selected.value = new Map();
      feedback.error.value = error instanceof Error ? error.message : '全选失败，请重试';
    }
  } finally { if (selectionController === controller) { selectionController = undefined; selectingAll.value = false; } }
}
async function query(input: QueryInput) {
  cancelSelecting();
  const snapshot: QueryInput = JSON.parse(JSON.stringify(input));
  await resource.load(() => post<QueryResult>('/prices/query', snapshot), data => {
    if (result.value.revision && data.revision !== result.value.revision) clearSelection('数据库版本已变化，已清空旧选择，请重新勾选。');
    result.value = data; applied.value = snapshot; writePreference('page-size', data.pageSize);
    savePriceQuery(snapshot);
  });
}
function apply() {
  const parsed = parseIds(idsText.value), skus = parseIds(skuText.value);
  if (parsed.invalid.length || skus.invalid.length) { feedback.error.value = `存在无效 ID 或链接：${[...parsed.invalid, ...skus.invalid].slice(0, 5).join('、')}`; return; }
  let from: string | undefined, to: string | undefined;
  try {
    from = fromDateTimeLocal(draft.from, applied.value.from);
    to = fromDateTimeLocal(draft.to, applied.value.to);
  } catch {
    feedback.error.value = '采集起始或截止时间无效';
    return;
  }
  feedback.error.value = ''; clearSelection('查询条件已改变，已清空跨页选择。');
  void query({ ...draft, productIds: parsed.ids, skuIds: skus.ids, from, to, page: 1 });
}
function reset() { restoreDraft(baseQuery()); savedId.value = ''; apply(); }
function page(value: number) { void query({ ...applied.value, page: value }); }
function pageSize(value: number) { void query({ ...applied.value, pageSize: value, page: 1 }); }
function sort(field: string, order: 'asc' | 'desc') { if (applied.value.sort === field && applied.value.order === order) return; Object.assign(draft, { sort: field, order }); void query({ ...applied.value, sort: field, order, page: 1 }); }
async function references() {
  await referenceResource.load(() => Promise.all([get<{ shops: Shop[] }>('/shops'), get<{ tasks: AlertTask[] }>('/alert-tasks'), get<{ runs: Run[] }>('/runs'), get<{ queries: SavedQuery[] }>('/queries')]),
    ([a, b, c, d]) => { shops.value = a.shops; tasks.value = b.tasks; runs.value = c.runs; savedQueries.value = d.queries; });
}
async function refreshPage() { await Promise.all([references(), query(applied.value)]); }
function shopDropdown(open: boolean) { if (open) void references(); }
async function saveQuery() { await feedback.act(async () => { if (!savedName.value.trim()) throw new Error('请输入查询名称'); const result = await post<SavedQuery>('/queries', { name: savedName.value.trim(), query: applied.value }); savedQueries.value.push(result); writePreference(`query-layout-${result.id}`, { columns: grid.value?.getColumns() || [], copy: readPreference('copy-options', null) }); savedId.value = result.id; saveDialog.value = false; savedName.value = ''; }, '已保存当前已应用的查询条件'); }
async function restoreQuery(id: string) {
  const saved = savedQueries.value.find(item => item.id === id); if (!saved) return;
  const snapshot = { ...baseQuery(), ...saved.query };
  restoreDraft(snapshot);
  clearSelection('已加载命名查询，旧选择已清空。');
  await query(snapshot);
  await nextTick();
  const layout = readPreference<SavedLayout | null>(`query-layout-${id}`, null);
  if (layout) { grid.value?.restoreColumns(layout.columns); if (layout.copy) writePreference('copy-options', layout.copy); }
}
async function deleteQuery() { if (!savedId.value || !await confirmAction('删除选中的命名查询？')) return; await feedback.act(async () => { await remove(`/queries/${savedId.value}`); savedQueries.value = savedQueries.value.filter(item => item.id !== savedId.value); savedId.value = ''; }, '命名查询已删除'); }
function completeBatch() { batchType.value = null; void query(applied.value); void references(); }
function restoreDraft(input: QueryInput) {
  Object.keys(draft).forEach(key => delete draft[key as keyof QueryInput]);
  Object.assign(draft, formQuery(input));
  idsText.value = input.productIds?.join('\n') || '';
  skuText.value = input.skuIds?.join('\n') || '';
  advanced.value = hasAdvancedFilters(input);
}
function restoreIncoming(input: QueryInput) {
  const snapshot = { ...baseQuery(), ...input };
  restoreDraft(snapshot);
  applied.value = snapshot; clearSelection(); savePriceQuery(snapshot);
}
async function cleanPriceUrl() {
  if (route.path === '/prices' && (Object.keys(route.query).length || route.hash)) await router.replace({ path: '/prices', query: {}, hash: '' });
}
watch(() => [route.query.q, route.query.run], async ([q, run]) => {
  if (route.path !== '/prices' || (q === undefined && run === undefined)) return;
  restoreIncoming(incomingQuery() || {}); await cleanPriceUrl(); await refreshPage();
});
onMounted(async () => { await cleanPriceUrl(); await refreshPage(); });
// PricesPage is kept alive: mounting only once must not freeze shop/task/run options.
let firstActivation = true;
onActivated(() => {
  if (firstActivation) { firstActivation = false; return; }
  const incoming = incomingQuery(); if (incoming) restoreIncoming(incoming);
  void cleanPriceUrl().then(refreshPage);
});
</script>
<template><div><PageHeader title="商品价格" description="查询数据库中的商品与 SKU，采集仅由明确操作触发。支持跨页勾选、全量复制与历史追溯。"><el-button @click="comparing = true">比较两次执行</el-button><el-button :loading="resource.loading.value || referenceResource.loading.value" @click="refreshPage">刷新数据库</el-button><el-button type="primary" @click="copyOpen = true">复制 / 导出</el-button></PageHeader><ErrorBanner :message="feedback.error.value || resource.error.value || referenceResource.error.value" /><StatCards :items="[{ label: '筛选命中商品', value: result.productCount }, { label: '筛选命中 SKU', value: result.skuCount }, { label: applied.view === 'product' ? '商品结果行数' : 'SKU 结果行数', value: result.total }, { label: '跨页已勾选', value: selected.size, hint: `数据版本 ${result.revision}`, tone: 'primary' }]" /><section class="panel"><div class="panel-head"><h2>数据库查询</h2><div class="header-actions"><el-select v-model="savedId" placeholder="加载命名查询" clearable style="width:200px" @change="restoreQuery"><el-option v-for="saved in savedQueries" :key="saved.id" :label="saved.name" :value="saved.id" /></el-select><el-button text @click="saveDialog = true">保存当前查询</el-button><el-button v-if="savedId" text type="danger" @click="deleteQuery">删除</el-button></div></div><div class="panel-body"><el-form label-position="top" @submit.prevent="apply"><div class="filter-grid"><el-form-item label="店铺（可多选）"><el-select v-model="draft.shopIds" @visible-change="shopDropdown" multiple collapse-tags collapse-tags-tooltip clearable placeholder="全部店铺" class="full-width"><el-option v-for="shop in shops" :key="shop.id" :value="shop.id" :label="shop.name" /></el-select></el-form-item><el-form-item label="标题 / 规格关键词"><el-input v-model="draft.search" clearable placeholder="输入关键词" @keyup.enter="apply" /></el-form-item><el-form-item label="展示视图"><el-select v-model="draft.view" class="full-width"><el-option value="sku" label="SKU 明细（每行一个规格）" /><el-option value="product" label="商品汇总（每行一个商品）" /></el-select></el-form-item><el-form-item label="商品命中方式"><el-select v-model="draft.matchMode" class="full-width"><el-option value="any" label="任意 SKU 满足" /><el-option value="all" label="全部 SKU 满足（未知不判真）" /></el-select></el-form-item><el-form-item label="商品 ID / 链接（批量）" class="filter-wide"><el-input v-model="idsText" type="textarea" :rows="2" placeholder="每行或逗号分隔，支持淘宝 / 天猫商品链接" /><span v-if="idsText" class="form-hint">有效 {{ parseIds(idsText).ids.length }} 个 · 无效 {{ parseIds(idsText).invalid.length }} 项</span></el-form-item><el-form-item label="SKU ID（批量）" class="filter-wide"><el-input v-model="skuText" type="textarea" :rows="2" placeholder="多个 SKU ID 用换行或逗号分隔，按字符串精确查找" /></el-form-item></div><div v-if="advanced" style="margin-top:18px"><div class="filter-grid"><el-form-item label="数据批次"><el-select v-model="draft.runId" clearable filterable placeholder="最新价格视图" class="full-width"><el-option v-for="run in runs" :key="run.id" :value="run.id" :label="`${run.shopName} / ${dateTime(run.createdAt)}`" /></el-select></el-form-item><el-form-item label="预警任务白名单上下文"><el-select v-model="draft.taskId" clearable placeholder="未选择预警任务" class="full-width"><el-option v-for="task in tasks" :key="task.id" :value="task.id" :label="task.name" /></el-select></el-form-item><el-form-item label="白名单命中"><el-select v-model="draft.whitelistMode" :disabled="!draft.taskId" class="full-width"><el-option value="all" label="全部" /><el-option value="excluded" label="被此预警任务白名单排除" /><el-option value="included" label="未被此预警任务排除" /></el-select></el-form-item><el-form-item label="采集起始时间"><el-input v-model="draft.from" type="datetime-local" step="any" /></el-form-item><el-form-item label="采集截止时间"><el-input v-model="draft.to" type="datetime-local" step="any" /></el-form-item></div><div style="margin-top:16px"><p class="section-title">价格、折扣与文本条件</p><RuleEditor :model-value="draft.groups || []" @update:model-value="v => draft.groups = v" /></div></div><div class="toolbar" style="padding:18px 0 0;border:0"><el-button type="primary" :loading="resource.loading.value" native-type="submit">应用查询</el-button><el-button @click="reset">重置</el-button><el-button text type="primary" @click="advanced = !advanced">{{ advanced ? '收起' : '展开' }}高级条件 {{ draft.groups?.length ? `（${draft.groups.length} 组）` : '' }}</el-button><span class="spacer" /><span class="muted">筛选修改后点击“应用查询”生效</span></div></el-form>
<div v-if="activeFilters" class="pill-note" aria-live="polite" style="margin-top:12px;overflow-wrap:anywhere">
  <strong>已应用筛选</strong> {{ activeFilters }}
</div>
</div></section><section class="panel"><div class="toolbar selection-toolbar"><strong>已选 {{ selected.size }} {{ applied.view === 'product' ? '个商品' : '条 SKU' }}</strong><el-button size="small" :disabled="!result.rows.length || resource.loading.value || selectingAll" @click="choose(result.rows)">勾选当前页</el-button><el-button type="primary" plain size="small" :loading="selectingAll" :disabled="!result.total || resource.loading.value" @click="selectAllMatching">{{ selectingAll ? `正在全选 ${selectionProgress} / ${result.total}` : `选择全部筛选结果（${result.total}）` }}</el-button><el-button text :disabled="!selected.size && !selectingAll" @click="clearSelection()">{{ selectingAll ? '取消全选' : '清空选择' }}</el-button><span class="spacer" /><el-button size="small" :disabled="!selected.size || selectingAll || resource.loading.value" @click="batchType = 'task'">加入采集任务范围</el-button><el-button size="small" :disabled="!selected.size || selectingAll || resource.loading.value" @click="batchType = 'whitelist'">加入预警任务白名单</el-button><el-button size="small" :disabled="!selected.size || selectingAll || resource.loading.value" @click="batchType = 'annotation'">标签 / 备注</el-button><el-button size="small" :disabled="!selected.size || selectingAll || resource.loading.value" @click="batchType = 'collect'">重采选中商品（仅采集）</el-button><el-button type="primary" size="small" @click="copyOpen = true">复制 / 导出</el-button></div><div v-if="selectionSummary" class="pill-note" role="status" style="margin:12px">{{ selectionSummary }}</div><PriceGrid ref="grid" :key="applied.view" :rows="result.rows" :view="applied.view || 'sku'" :selected-ids="selectedIds" :loading="resource.loading.value" @select="choose" @detail="row => history = row" @sort="sort" /><el-pagination :current-page="result.page" :page-size="result.pageSize" :page-sizes="[20, 50, 100, 200, 500, 1000]" :total="result.total" layout="total, sizes, prev, pager, next, jumper" @current-change="page" @size-change="pageSize" /></section><CopyDialog v-if="copyOpen" :query="applied" :selected-ids="selectedIds" :total="result.total" @close="copyOpen = false" /><PriceHistory v-if="history" :row="history" @close="history = null" /><RunCompare v-if="comparing" @close="comparing = false" /><BatchAction v-if="batchType" :rows="selectedRows" :type="batchType" @close="batchType = null" @complete="completeBatch" /><el-dialog v-model="saveDialog" title="保存命名查询" width="440px"><p class="muted">保存当前已应用的筛选、视图与排序条件，加载时读取最新数据库数据；列与复制设置保存在当前浏览器。</p><el-input v-model="savedName" placeholder="如：全店低于 8.5 折" @keyup.enter="saveQuery" /><template #footer><el-button @click="saveDialog = false">取消</el-button><el-button type="primary" :loading="feedback.busy.value" @click="saveQuery">保存查询</el-button></template></el-dialog></div></template>
