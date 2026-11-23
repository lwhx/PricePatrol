<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import type { AlertTask, CollectionTask, AlertRun, Shop } from '../../../shared/contracts.js';
import { get, post, patch, remove } from '../api/client';
import { useFeedback, confirmAction } from '../composables/useFeedback';
import { useLatest } from '../composables/useLatest';
import { usePolling } from '../composables/usePolling';
import PageHeader from '../components/PageHeader.vue';
import ErrorBanner from '../components/ErrorBanner.vue';
import StatCards from '../components/StatCards.vue';
import AlertRunTable from '../components/AlertRunTable.vue';
const route = useRoute(), router = useRouter();
const queryString = (name: string) => typeof route.query[name] === 'string' ? String(route.query[name]) : '';
const tab = ref(queryString('tab') === 'runs' || queryString('collectionRunId') || queryString('alertTaskId') ? 'runs' : 'tasks');
const collectionTaskId = ref(queryString('collectionTaskId')), alertTaskId = ref(queryString('alertTaskId')), collectionRunId = ref(queryString('collectionRunId'));
const tasks = ref<AlertTask[]>([]), collections = ref<CollectionTask[]>([]), runs = ref<AlertRun[]>([]), shops = ref<Shop[]>([]);
const visibleTasks = computed(() => collectionTaskId.value ? tasks.value.filter(task => task.collectionTaskId === collectionTaskId.value) : tasks.value);
const { busy, error, act } = useFeedback(), resource = useLatest();
function refresh() {
  const params = new URLSearchParams(); if (collectionRunId.value) params.set('collectionRunId', collectionRunId.value); if (alertTaskId.value) params.set('alertTaskId', alertTaskId.value);
  return resource.load(() => Promise.all([get<{ tasks: AlertTask[] }>('/alert-tasks'), get<{ tasks: CollectionTask[] }>('/tasks'), get<{ runs: AlertRun[] }>(`/alert-runs${params.size ? `?${params}` : ''}`), get<{ shops: Shop[] }>('/shops')]), ([a, b, c, d]) => { tasks.value = a.tasks; collections.value = b.tasks; runs.value = c.runs; shops.value = d.shops; });
}
watch(() => route.query, () => { collectionTaskId.value = queryString('collectionTaskId'); alertTaskId.value = queryString('alertTaskId'); collectionRunId.value = queryString('collectionRunId'); tab.value = queryString('tab') === 'runs' || collectionRunId.value || alertTaskId.value ? 'runs' : 'tasks'; void refresh(); });
async function filterRuns() { await router.replace({ path: '/alert-tasks', query: { tab: 'runs', ...(alertTaskId.value ? { alertTaskId: alertTaskId.value } : {}), ...(collectionRunId.value ? { collectionRunId: collectionRunId.value } : {}) } }); }
async function clearSource() { collectionRunId.value = ''; await filterRuns(); }
function sourceStatus(id: string) { const task = collections.value.find(item => item.id === id); return !task ? '来源已删除 · 不再创建批次' : !task.enabled ? '来源已暂停 · 等待启用' : task.schedule.kind === 'manual' ? '仅手动采集 · 不自动预警' : '由来源定时批次触发'; }
async function toggle(task: AlertTask) { await act(async () => { await patch(`/alert-tasks/${task.id}`, { enabled: !task.enabled }); await refresh(); }, '预警任务状态已更新；已入队批次的快照继续保留'); }
async function duplicate(task: AlertTask) { await act(async () => { await post(`/alert-tasks/${task.id}/duplicate`); await refresh(); }, '已创建暂停状态的预警任务副本'); }
async function deleteTask(task: AlertTask) { if (!await confirmAction(`删除预警任务「${task.name}」？已入队批次的快照、历史预警执行和价格证据仍会保留。`)) return; await act(async () => { await remove(`/alert-tasks/${task.id}`); await refresh(); }, '预警任务已删除'); }
usePolling(refresh, 5000);
</script>
<template>
  <div>
    <PageHeader title="预警任务" description="共用定时采集价格，独立配置每个预警任务的范围、规则、白名单与通知。手动采集不会执行预警。"><el-button :loading="resource.loading.value" @click="refresh">刷新</el-button><el-button type="primary" @click="router.push({ path: '/alert-tasks/new', query: collectionTaskId ? { collectionTaskId } : {} })">＋ 新建预警任务</el-button></PageHeader>
    <ErrorBanner :message="error || resource.error.value" />
    <StatCards :items="[{ label: '预警任务', value: tasks.length }, { label: '已启用', value: tasks.filter(task => task.enabled).length, tone: 'primary' }, { label: '检查 / 排队', value: runs.filter(run => ['running', 'queued'].includes(run.status)).length }, { label: '本页覆盖不完整', value: runs.filter(run => run.status === 'partial').length, tone: 'warning' }]" />
    <section class="panel">
      <el-tabs v-model="tab" class="table-tabs"><el-tab-pane label="预警任务列表" name="tasks" /><el-tab-pane :label="`预警执行记录（${runs.length}）`" name="runs" /></el-tabs>
      <template v-if="tab === 'tasks'">
        <div class="toolbar"><el-select v-model="collectionTaskId" clearable filterable placeholder="全部采集任务" style="width:300px"><el-option v-for="task in collections" :key="task.id" :value="task.id" :label="task.name" /></el-select></div>
        <el-table :data="visibleTasks" v-loading="resource.loading.value" row-key="id" empty-text="暂无预警任务。新建并关联一个采集任务即可配置预警。">
          <el-table-column label="预警任务 / 店铺" min-width="210"><template #default="{ row }"><router-link :to="`/alert-tasks/${row.id}/edit`"><strong>{{ row.name }}</strong></router-link><div class="cell-sub">{{ shops.find(shop => shop.id === row.shopId)?.name || row.shopId }} · v{{ row.version }}</div></template></el-table-column>
          <el-table-column label="关联采集任务" min-width="190"><template #default="{ row }"><router-link v-if="collections.some(task => task.id === row.collectionTaskId)" :to="`/tasks/${row.collectionTaskId}/edit`">{{ collections.find(task => task.id === row.collectionTaskId)?.name }}</router-link><span v-else class="muted">已删除的采集任务</span><div class="cell-sub">{{ sourceStatus(row.collectionTaskId) }}</div></template></el-table-column>
          <el-table-column label="范围 / 白名单" min-width="175"><template #default="{ row }">{{ row.scope === 'all' ? '本批次全部商品' : `${row.productIds.length} 个指定商品` }}<div class="cell-sub">排除 {{ row.whitelist.productIds.length }} 个 ID · {{ row.whitelist.titleKeywords.length }} 个关键词</div></template></el-table-column>
          <el-table-column label="条件 / 通知" min-width="150"><template #default="{ row }">{{ row.rules.reduce((sum: number, group: { conditions: unknown[] }) => sum + group.conditions.length, 0) }} 项条件<div class="cell-sub">{{ row.notify ? `持续异常每 ${row.notificationPolicy?.cooldownHours ?? 24} 小时提醒` : '不发送外部通知' }}</div></template></el-table-column>
          <el-table-column label="状态" width="95"><template #default="{ row }"><el-tag :type="row.enabled ? 'success' : 'info'" size="small">{{ row.enabled ? '启用' : '暂停' }}</el-tag></template></el-table-column>
          <el-table-column label="操作" min-width="320" fixed="right"><template #default="{ row }"><el-button text type="primary" @click="router.push({ path: '/alert-tasks', query: { tab: 'runs', alertTaskId: row.id } })">执行记录</el-button><el-button text @click="router.push(`/alert-tasks/${row.id}/edit`)">编辑</el-button><el-button text :disabled="busy" @click="toggle(row)">{{ row.enabled ? '暂停' : '启用' }}</el-button><el-button text :disabled="busy" @click="duplicate(row)">复制</el-button><el-button text type="danger" :disabled="busy" @click="deleteTask(row)">删除</el-button></template></el-table-column>
        </el-table>
      </template>
      <template v-else>
        <div class="toolbar"><el-select v-model="alertTaskId" clearable filterable placeholder="全部预警任务" style="width:280px" @change="filterRuns"><el-option v-for="task in tasks" :key="task.id" :value="task.id" :label="task.name" /></el-select><template v-if="collectionRunId"><span class="muted">来源批次：{{ collectionRunId }}</span><el-button text @click="clearSource">清除批次筛选</el-button></template></div>
        <AlertRunTable :runs="runs" :loading="resource.loading.value" @refresh="refresh" />
      </template>
    </section>
    <div class="pill-note">只使用来源采集批次中的价格。部分完成会标明覆盖不完整，缺失价格不视为正常；通知失败可独立重试，不重新采集或评估。</div>
  </div>
</template>
