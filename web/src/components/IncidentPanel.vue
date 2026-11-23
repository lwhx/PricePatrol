<script setup lang="ts">
import { ref, watch } from 'vue';
import type { Incident, IncidentState, IncidentStatus } from '../../../shared/incidents.js';
import { get, patch } from '../api/client';
import { useLatest } from '../composables/useLatest';
import { useFeedback } from '../composables/useFeedback';
import { usePolling } from '../composables/usePolling';
import { dateTime } from '../lib/format';
import StatusTag from './StatusTag.vue';
import ErrorBanner from './ErrorBanner.vue';
const props = defineProps<{ focusId?: string }>();
const incidents = ref<Incident[]>([]), selected = ref<Incident[]>([]), total = ref(0), page = ref(1);
const pageSize = 50;
const status = ref<IncidentStatus | 'all'>('all'), state = ref<IncidentState | ''>('pending');
const editing = ref<Incident | null>(null), note = ref(''), editState = ref<IncidentState>('pending');
const resource = useLatest(), { busy, error, act } = useFeedback();
const focusError = ref('');
let detailRequest = 0;
const statusNames = { active: '仍在发生', recovered: '已恢复', superseded: '规则已变更或任务已删除' };
const events = { first: '首次出现', continuing: '持续异常', worsened: '异常恶化', recovered: '已恢复' };
function refresh() {
  const params = new URLSearchParams({ status: status.value, page: String(page.value), pageSize: String(pageSize) });
  if (state.value) params.set('state', state.value);
  return resource.load(() => get<{ incidents: Incident[]; total: number }>(`/incidents?${params}`), result => {
    total.value = result.total;
    const lastPage = Math.max(1, Math.ceil(result.total / pageSize));
    if (page.value > lastPage) page.value = lastPage;
    else { incidents.value = result.incidents; selected.value = []; }
  });
}
function filter() {
  if (page.value === 1) void refresh();
  else page.value = 1;
}
watch(page, () => { void refresh(); });
function open(incident: Incident) {
  detailRequest++;
  editing.value = incident; note.value = incident.note; editState.value = incident.state;
  error.value = ''; focusError.value = '';
}
watch(() => props.focusId, async (id, _, onCleanup) => {
  const request = ++detailRequest;
  if (!id) return;
  focusError.value = '';
  onCleanup(() => { if (detailRequest === request) detailRequest++; });
  try {
    const { incident } = await get<{ incident: Incident }>(`/incidents/${encodeURIComponent(id)}`);
    if (detailRequest === request) open(incident);
  } catch (cause) {
    if (detailRequest === request) focusError.value = cause instanceof Error ? cause.message : String(cause);
  }
}, { immediate: true });
function close() { if (!busy.value) editing.value = null; }
async function save() {
  const incident = editing.value;
  if (!incident || busy.value) return;
  const changes: { state?: IncidentState; note?: string } = {};
  if (editState.value !== incident.state) changes.state = editState.value;
  if (note.value !== incident.note) changes.note = note.value;
  if (!Object.keys(changes).length) { close(); return; }
  await act(async () => {
    await patch(`/incidents/${encodeURIComponent(incident.id)}`, changes);
    editing.value = null;
    await refresh();
  }, '异常处理记录已保存');
}
async function batch(next: IncidentState) {
  if (busy.value || resource.loading.value || !selected.value.length) return;
  const ids = [...new Set(selected.value.map(item => item.id))];
  await act(async () => {
    let failed = 0;
    for (const id of ids) { try { await patch(`/incidents/${encodeURIComponent(id)}`, { state: next }); } catch { failed++; } }
    await refresh();
    if (failed) throw new Error(`${ids.length - failed} 条已更新，${failed} 条提交失败，请重新选择后重试。`);
  }, `已更新 ${ids.length} 条异常处理记录`);
}
usePolling(() => { if (!busy.value && !resource.loading.value && !selected.value.length) void refresh(); });
</script>
<template>
  <section class="panel">
    <div class="panel-head"><div><h2>异常处理</h2><p>同一轮持续异常只保留一个处理事项，每次检查的价格证据独立保存。</p></div><el-button :loading="resource.loading.value" @click="refresh">刷新异常</el-button></div>
    <ErrorBanner :message="error || focusError || resource.error.value" />
    <div class="toolbar">
      <el-select v-model="status" style="width:210px" aria-label="异常状态" @change="filter"><el-option value="all" label="全部异常状态" /><el-option value="active" label="仍在发生" /><el-option value="recovered" label="已恢复" /><el-option value="superseded" label="规则变更 / 任务删除" /></el-select>
      <el-select v-model="state" style="width:170px" aria-label="处理状态" @change="filter"><el-option value="" label="全部处理状态" /><el-option value="pending" label="待处理" /><el-option value="confirmed" label="已确认" /><el-option value="resolved" label="已处理" /></el-select>
      <span class="muted">共 {{ total }} 条 · 已选 {{ selected.length }}</span><span class="spacer" />
      <el-button :disabled="!selected.length || busy || resource.loading.value" @click="batch('confirmed')">批量确认异常</el-button><el-button :disabled="!selected.length || busy || resource.loading.value" @click="batch('resolved')">批量处理异常</el-button>
    </div>
    <el-table :data="incidents" row-key="id" max-height="650" empty-text="暂无符合条件的异常。恢复状态只依据有效采集，缺失或未知价格不会被判为恢复。" @selection-change="(rows: Incident[]) => selected = rows">
      <el-table-column type="selection" width="48" />
      <el-table-column label="商品 / 店铺" min-width="260"><template #default="{row}"><a class="cell-title" @click="open(row)">{{ row.title }}</a><div class="cell-sub">{{ row.shopName }} · {{ row.productId }}</div><div class="cell-sub">{{ row.specs }} · SKU {{ row.skuId || '商品级' }}</div></template></el-table-column>
      <el-table-column label="异常状态" min-width="180"><template #default="{row}">{{ statusNames[row.status as keyof typeof statusNames] }}<div class="cell-sub">{{ events[row.lastEvent as keyof typeof events] }}</div></template></el-table-column>
      <el-table-column label="人工处理" width="110"><template #default="{row}"><StatusTag :value="row.state" /></template></el-table-column>
      <el-table-column label="首次 / 最近观察" min-width="200"><template #default="{row}">{{ dateTime(row.firstSeenAt) }}<div class="cell-sub">{{ dateTime(row.lastSeenAt) }}</div></template></el-table-column>
      <el-table-column label="处理备注" min-width="180"><template #default="{row}">{{ row.note || '—' }}</template></el-table-column>
      <el-table-column label="操作" min-width="160" fixed="right"><template #default="{row}"><el-button text type="primary" @click="open(row)">处理异常</el-button><router-link :to="{path:'/alerts',query:{alertRunId:row.lastAlertRunId}}">最近证据</router-link></template></el-table-column>
    </el-table>
    <div class="toolbar"><el-pagination v-model:current-page="page" :page-size="pageSize" :total="total" layout="prev, pager, next, total" /></div>
    <div class="panel-body"><p class="muted">人工标记“已处理”不会修改价格，也不代表异常已经恢复。改规则或删除任务会将原规则的异常归档，不会显示为价格恢复。</p></div>
  </section>
  <el-dialog :model-value="!!editing" title="异常详情与处理" width="680px" :show-close="!busy" :close-on-click-modal="!busy" :close-on-press-escape="!busy" @close="close">
    <template v-if="editing"><ErrorBanner :message="error" /><h3>{{ editing.title }}</h3><p>{{ editing.shopName }} · 商品 {{ editing.productId }} · SKU {{ editing.skuId || '商品级' }}</p><p>异常状态：{{ statusNames[editing.status] }}；最近变化：{{ events[editing.lastEvent] }}</p><p class="muted">首次观察 {{ dateTime(editing.firstSeenAt) }} · 最近观察 {{ dateTime(editing.lastSeenAt) }}</p>
      <el-form label-position="top" :disabled="busy"><el-form-item label="人工处理状态"><el-radio-group v-model="editState"><el-radio-button value="pending">待处理</el-radio-button><el-radio-button value="confirmed">已确认</el-radio-button><el-radio-button value="resolved">已处理</el-radio-button></el-radio-group></el-form-item><el-form-item label="处理备注"><el-input v-model="note" type="textarea" :rows="4" maxlength="2000" /></el-form-item></el-form>
      <router-link :to="{path:'/alerts',query:{alertRunId:editing.lastAlertRunId}}">查看最近一次检查证据 →</router-link>
    </template>
    <template #footer><el-button :disabled="busy" @click="close">取消</el-button><el-button type="primary" :loading="busy" @click="save">保存异常处理记录</el-button></template>
  </el-dialog>
</template>
