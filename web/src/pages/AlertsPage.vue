<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import type { Alert, Shop, Run, AlertRun } from '../../../shared/contracts.js';
import { get, patch } from '../api/client';
import { useLatest } from '../composables/useLatest';
import { useFeedback } from '../composables/useFeedback';
import { money, discount, dateTime } from '../lib/format';
import PageHeader from '../components/PageHeader.vue';
import StatCards from '../components/StatCards.vue';
import StatusTag from '../components/StatusTag.vue';
import ErrorBanner from '../components/ErrorBanner.vue';
import IncidentPanel from '../components/IncidentPanel.vue';

const route = useRoute(), router = useRouter();
const alerts = ref<Alert[]>([]), shops = ref<Shop[]>([]), runs = ref<Run[]>([]), alertRuns = ref<AlertRun[]>([]), selected = ref<Alert[]>([]);
const routeValue = (key: string) => typeof route.query[key] === 'string' ? String(route.query[key]) : '';
const focusIncidentId = computed(() => routeValue('incidentId'));
const tab = computed(() => !focusIncidentId.value && (routeValue('tab') === 'evidence' || routeValue('runId') || routeValue('alertRunId')) ? 'evidence' : 'incidents');
const state = ref<string | undefined>(''), shopId = ref<string | undefined>(''), runId = ref<string | undefined>(routeValue('runId')), alertRunId = ref<string | undefined>(routeValue('alertRunId'));
const editing = ref<Alert | null>(null), note = ref(''), editState = ref<Alert['state']>('pending');
const resource = useLatest(), references = useLatest(), { busy, error, act } = useFeedback();
const eventLabels = { first: '首次出现', continuing: '持续异常', worsened: '异常恶化', recovered: '已恢复' };
const legacyAlerts = computed(() => alerts.value.filter(alert => !alert.incidentId));
const evidenceRows = computed(() => state.value ? legacyAlerts.value : alerts.value);
const counts = computed(() => ({
  pending: legacyAlerts.value.filter(alert => alert.state === 'pending').length,
  confirmed: legacyAlerts.value.filter(alert => alert.state === 'confirmed').length,
  resolved: legacyAlerts.value.filter(alert => alert.state === 'resolved').length,
}));
let referencesLoaded = false;

function refresh() {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries({ state: state.value, shopId: shopId.value, runId: runId.value, alertRunId: alertRunId.value })) {
    if (value) params.set(key, value);
  }
  if (state.value) params.set('legacyOnly', 'true');
  return resource.load(() => get<{ alerts: Alert[] }>(`/alerts?${params}`), result => {
    alerts.value = result.alerts;
    selected.value = [];
  });
}
function refreshReferences() {
  return references.load(() => Promise.all([
    get<{ shops: Shop[] }>('/shops'),
    get<{ runs: Run[] }>('/runs'),
    get<{ runs: AlertRun[] }>('/alert-runs'),
  ]), ([a, b, c]) => {
    shops.value = a.shops; runs.value = b.runs; alertRuns.value = c.runs;
    referencesLoaded = true;
  });
}
function refreshEvidence() { void refresh(); void refreshReferences(); }

watch(() => [route.query.runId, route.query.alertRunId], () => {
  if (route.path !== '/alerts') return;
  runId.value = routeValue('runId'); alertRunId.value = routeValue('alertRunId');
});
watch([tab, state, shopId, runId, alertRunId], () => {
  if (route.path === '/alerts' && tab.value === 'evidence') void refresh();
}, { immediate: true });
watch(tab, value => {
  if (value === 'evidence' && !referencesLoaded) void refreshReferences();
}, { immediate: true });
function changeTab(value: string | number) {
  if (value === tab.value) return;
  editing.value = null; error.value = '';
  void router.push({ path: '/alerts', query: value === 'evidence' ? { tab: 'evidence' } : {} });
}
function showIncident(alert: Alert) {
  if (!alert.incidentId) return;
  editing.value = null; error.value = '';
  void router.push({ path: '/alerts', query: { incidentId: alert.incidentId } });
}
function open(alert: Alert) {
  if (busy.value) return;
  editing.value = alert; error.value = '';
  if (!alert.incidentId) { note.value = alert.note; editState.value = alert.state; }
}
function close() { if (!busy.value) editing.value = null; }
async function save() {
  const alert = editing.value;
  if (!alert || alert.incidentId || busy.value) return;
  await act(async () => {
    await patch(`/alerts/${encodeURIComponent(alert.id)}`, { state: editState.value, note: note.value });
    editing.value = null;
    await refresh();
  }, '旧版预警处理状态与备注已保存');
}
async function batch(state: Alert['state']) {
  if (busy.value || resource.loading.value) return;
  const ids = [...new Set(selected.value.filter(alert => !alert.incidentId).map(alert => alert.id))];
  if (!ids.length) return;
  await act(async () => {
    let failed = 0;
    for (const id of ids) {
      try { await patch(`/alerts/${encodeURIComponent(id)}`, { state }); }
      catch { failed++; }
    }
    await refresh();
    if (failed) throw new Error(`${ids.length - failed} 条已更新，${failed} 条提交失败，请重新选择后重试。`);
  }, `已更新 ${ids.length} 条旧版预警`);
}
</script>

<template>
  <div>
    <PageHeader title="预警记录" description="持续异常合并为独立处理事项。每次定时检查保留价格证据、变化及通知结果。">
      <el-button v-if="tab === 'evidence'" :loading="resource.loading.value || references.loading.value" @click="refreshEvidence">刷新记录</el-button>
    </PageHeader>
    <el-tabs :model-value="tab" @update:model-value="changeTab"><el-tab-pane label="异常处理" name="incidents" /><el-tab-pane label="检查证据 / 旧版记录" name="evidence" /></el-tabs>
    <IncidentPanel v-if="tab === 'incidents'" :focus-id="focusIncidentId" />
    <template v-else>
      <ErrorBanner :message="error || resource.error.value || references.error.value" />
      <p class="pill-note">检查证据保留每次检查的结果。关联异常的当前处理状态请在“异常处理”中查看。旧版独立预警仍可在此处理。</p>
      <StatCards :items="[{ label: '检查证据 / 旧版记录', value: evidenceRows.length, hint: '接口最多返回最近 1,000 条' }, { label: '旧版待处理', value: counts.pending, tone: 'warning' }, { label: '旧版已确认', value: counts.confirmed, tone: 'primary' }, { label: '旧版已处理', value: counts.resolved }]" />
      <section class="panel">
        <div class="toolbar">
          <el-select v-model="state" clearable placeholder="全部旧版处理状态" style="width:190px"><el-option value="pending" label="旧版待处理" /><el-option value="confirmed" label="旧版已确认" /><el-option value="resolved" label="旧版已处理" /></el-select>
          <el-select v-model="shopId" clearable placeholder="全部店铺" style="width:190px"><el-option v-for="shop in shops" :key="shop.id" :value="shop.id" :label="shop.name" /></el-select>
          <el-select v-model="runId" filterable clearable placeholder="全部采集批次" style="width:290px">
            <el-option v-for="run in runs" :key="run.id" :value="run.id" :label="`${run.shopName} / ${dateTime(run.createdAt)}`" />
            <el-option v-if="runId && !runs.some(run => run.id === runId)" :value="runId" :label="`历史采集批次 · ${runId}`" />
          </el-select>
          <el-select v-model="alertRunId" filterable clearable placeholder="全部预警执行" style="width:290px">
            <el-option v-for="run in alertRuns" :key="run.id" :value="run.id" :label="`${run.taskName} / ${dateTime(run.createdAt)}`" />
            <el-option v-if="alertRunId && !alertRuns.some(run => run.id === alertRunId)" :value="alertRunId" :label="`预警执行 · ${alertRunId}`" />
          </el-select>
          <span class="spacer" /><span class="muted">已选 {{ selected.length }}</span>
          <el-button :disabled="!selected.length || busy || resource.loading.value" @click="batch('confirmed')">批量确认旧版</el-button>
          <el-button type="primary" plain :disabled="!selected.length || busy || resource.loading.value" @click="batch('resolved')">批量处理旧版</el-button>
        </div>
        <el-table :data="evidenceRows" v-loading="resource.loading.value" row-key="id" max-height="650" empty-text="暂无符合条件的检查证据。" @selection-change="(rows: Alert[]) => selected = rows.filter(row => !row.incidentId)">
          <el-table-column type="selection" width="48" :selectable="(row: Alert) => !row.incidentId" />
          <el-table-column label="商品 / 店铺" min-width="280"><template #default="{ row }"><a class="cell-title" @click="open(row)">{{ row.title }}</a><div class="cell-sub">{{ row.shopName }} · {{ row.productId }}</div><div class="cell-sub">{{ row.specs }} · SKU {{ row.skuId || '商品级' }}</div></template></el-table-column>
          <el-table-column label="后台 / 优惠前 / 优惠后" min-width="170"><template #default="{ row }"><div>{{ money(row.backendPrice) }} / {{ money(row.before) }}</div><strong style="color:#0e918b">{{ money(row.after) }}</strong> <span class="muted">{{ discount(row.discount) }}</span></template></el-table-column>
          <el-table-column label="异常变化" width="110"><template #default="{ row }">{{ eventLabels[row.event as keyof typeof eventLabels] || '旧版记录' }}</template></el-table-column>
          <el-table-column label="触发原因" min-width="230"><template #default="{ row }"><div v-for="reason in row.reasons" :key="reason" class="reason-line">{{ reason }}</div></template></el-table-column>
          <el-table-column label="旧版处理状态" width="120"><template #default="{ row }"><span v-if="row.incidentId" class="muted">关联异常</span><StatusTag v-else :value="row.state" /></template></el-table-column>
          <el-table-column label="旧版备注" min-width="170"><template #default="{ row }">{{ row.incidentId ? '—' : row.note || '—' }}</template></el-table-column>
          <el-table-column label="检查时间" width="180"><template #default="{ row }">{{ dateTime(row.createdAt) }}</template></el-table-column>
          <el-table-column label="操作" width="110" fixed="right"><template #default="{ row }"><el-button text type="primary" @click="open(row)">{{ row.incidentId ? '查看证据' : '处理详情' }}</el-button></template></el-table-column>
        </el-table>
      </section>
      <el-dialog :model-value="!!editing" :title="editing?.incidentId ? '检查证据' : '旧版预警详情与处理'" width="700px" :show-close="!busy" :close-on-click-modal="!busy" :close-on-press-escape="!busy" @close="close">
        <template v-if="editing">
          <ErrorBanner :message="error" />
          <h3 style="font-size:16px">{{ editing.title }}</h3>
          <p class="muted">{{ editing.shopName }} · 商品 {{ editing.productId }} · SKU {{ editing.skuId || '商品级' }}</p>
          <p class="muted">{{ editing.specs }} · {{ dateTime(editing.createdAt) }}</p>
          <div class="inline-metrics pill-note"><span>后台 {{ money(editing.backendPrice) }}</span><span>优惠前 {{ money(editing.before) }}</span><span>优惠后 {{ money(editing.after) }}</span><span>{{ discount(editing.discount) }}</span></div>
          <ul><li v-for="reason in editing.reasons" :key="reason">{{ reason }}</li></ul>
          <p class="muted">
            来源采集批次 <router-link :to="{ path: '/tasks', query: { tab: 'runs', runId: editing.runId } }">{{ editing.runId }}</router-link><br>
            预警任务 ID {{ editing.taskId || '旧版本记录' }}<br>
            <template v-if="editing.alertRunId">预警执行 <router-link :to="{ path: '/alert-tasks', query: { tab: 'runs', collectionRunId: editing.runId, ...(editing.taskId ? { alertTaskId: editing.taskId } : {}) } }">{{ editing.alertRunId }}</router-link></template>
            <template v-else>旧版本预警证据</template>
          </p>
          <el-form v-if="!editing.incidentId" label-position="top" :disabled="busy">
            <el-form-item label="处理状态"><el-radio-group v-model="editState"><el-radio-button value="pending">待处理</el-radio-button><el-radio-button value="confirmed">已确认</el-radio-button><el-radio-button value="resolved">已处理</el-radio-button></el-radio-group></el-form-item>
            <el-form-item label="处理备注"><el-input v-model="note" type="textarea" :rows="4" maxlength="2000" placeholder="记录排查结论与处理动作" /></el-form-item>
          </el-form>
          <router-link :to="{ path: '/prices', state: { priceQuery: { view: 'sku', runId: editing.runId } } }">查询来源批次价格证据 →</router-link>
        </template>
        <template #footer>
          <el-button :disabled="busy" @click="close">{{ editing?.incidentId ? '关闭' : '取消' }}</el-button>
          <el-button v-if="editing?.incidentId" type="primary" @click="showIncident(editing)">查看并处理关联异常</el-button>
          <el-button v-else-if="editing" type="primary" :loading="busy" @click="save">保存处理记录</el-button>
        </template>
      </el-dialog>
    </template>
  </div>
</template>
