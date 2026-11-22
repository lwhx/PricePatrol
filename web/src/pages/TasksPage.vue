<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import type { CollectionTask, AlertTask, Run, Shop } from '../../../shared/contracts.js';
import { get, post, patch, remove } from '../api/client';
import { useFeedback, confirmAction } from '../composables/useFeedback';
import { useLatest } from '../composables/useLatest';
import { usePolling } from '../composables/usePolling';
import { dateTime } from '../lib/format';
import PageHeader from '../components/PageHeader.vue';
import ErrorBanner from '../components/ErrorBanner.vue';
import StatCards from '../components/StatCards.vue';
import RunTable from '../components/RunTable.vue';
const route = useRoute(), router = useRouter();
const tab = ref(route.query.tab === 'runs' ? 'runs' : 'tasks');
const tasks = ref<CollectionTask[]>([]), alertTasks = ref<AlertTask[]>([]), runs = ref<Run[]>([]), shops = ref<Shop[]>([]);
const runId = computed(() => typeof route.query.runId === 'string' ? route.query.runId : '');
const visibleRuns = computed(() => runId.value ? runs.value.filter(run => run.id === runId.value) : runs.value);
watch(() => route.query, () => { tab.value = route.query.tab === 'runs' || runId.value ? 'runs' : 'tasks'; });
const { busy, error, act } = useFeedback(), resource = useLatest();
function refresh() { return resource.load(() => Promise.all([get<{ tasks: CollectionTask[] }>('/tasks'), get<{ runs: Run[] }>(runId.value ? `/runs?runId=${encodeURIComponent(runId.value)}` : '/runs'), get<{ shops: Shop[] }>('/shops'), get<{ tasks: AlertTask[] }>('/alert-tasks')]), ([a, b, c, d]) => { tasks.value = a.tasks; runs.value = b.runs; shops.value = c.shops; alertTasks.value = d.tasks; }); }
async function run(task: CollectionTask) { await act(async () => { await post(`/tasks/${task.id}/run`); await router.replace({ path: '/tasks', query: { tab: 'runs' } }); tab.value = 'runs'; await refresh(); }, '已加入手动采集队列；只更新价格，不触发预警或自动汇总'); }
async function toggle(task: CollectionTask) { await act(async () => { await patch(`/tasks/${task.id}`, { enabled: !task.enabled }); await refresh(); }, '采集任务启用状态已更新'); }
async function duplicate(task: CollectionTask) { await act(async () => { await post(`/tasks/${task.id}/duplicate`); await refresh(); }, '已创建暂停状态的采集任务副本'); }
async function deleteTask(task: CollectionTask) { if (!await confirmAction(`删除采集任务「${task.name}」？该任务将不再创建新的定时批次，价格历史和预警记录仍会保留。`)) return; await act(async () => { await remove(`/tasks/${task.id}`); await refresh(); }, '采集任务已删除'); }
function schedule(task: CollectionTask) { if (task.schedule.kind === 'manual') return '仅手动采集'; const days = ['日', '一', '二', '三', '四', '五', '六']; return `${task.schedule.kind === 'daily' ? '每天' : `每周${task.schedule.days.map(day => days[day]).join('、')}`} ${task.schedule.time}`; }
async function clearRun() { await router.replace({ path: '/tasks', query: { tab: 'runs' } }); await refresh(); }
watch(runId, refresh);
usePolling(refresh, 5000);
</script>
<template>
  <div>
    <PageHeader title="采集任务" description="独立管理商品采集范围与计划。手动采集不触发预警；定时采集完成后可执行多个关联预警任务。"><el-button :loading="resource.loading.value" @click="refresh">刷新</el-button><el-button type="primary" @click="router.push('/tasks/new')">＋ 新建采集任务</el-button></PageHeader>
    <ErrorBanner :message="error || resource.error.value" />
    <StatCards :items="[{ label: '采集任务', value: tasks.length }, { label: '已启用', value: tasks.filter(t => t.enabled).length, tone: 'primary' }, { label: '采集 / 排队', value: runs.filter(r => ['running', 'queued'].includes(r.status)).length }, { label: '待恢复 / 验证', value: runs.filter(r => ['recoverable', 'auth_required'].includes(r.status)).length, tone: 'warning' }]" />
    <section class="panel">
      <el-tabs v-model="tab" class="table-tabs"><el-tab-pane label="采集任务列表" name="tasks" /><el-tab-pane :label="`采集记录（${visibleRuns.length}）`" name="runs" /></el-tabs>
      <el-table v-if="tab === 'tasks'" :data="tasks" v-loading="resource.loading.value" row-key="id" empty-text="暂无采集任务。先连接店铺，再新建采集任务。">
        <el-table-column label="采集任务 / 店铺" min-width="210"><template #default="{ row }"><router-link :to="`/tasks/${row.id}/edit`"><strong>{{ row.name }}</strong></router-link><div class="cell-sub">{{ shops.find(shop => shop.id === row.shopId)?.name || row.shopId }} · v{{ row.version }}</div></template></el-table-column>
        <el-table-column label="采集范围" min-width="145"><template #default="{ row }">{{ row.scope === 'all' ? '全店在售商品' : `${row.productIds.length} 个指定商品` }}</template></el-table-column>
        <el-table-column label="关联预警任务" min-width="145"><template #default="{ row }"><router-link :to="{ path: '/alert-tasks', query: { collectionTaskId: row.id } }">{{ alertTasks.filter(task => task.collectionTaskId === row.id).length }} 个预警任务</router-link><div class="cell-sub"><router-link :to="{ path: '/alert-tasks/new', query: { collectionTaskId: row.id } }">＋ 新增预警</router-link></div></template></el-table-column>
        <el-table-column label="计划 / 下次采集" min-width="195"><template #default="{ row }">{{ schedule(row) }}<div class="cell-sub">{{ dateTime(row.nextRunAt) }}</div></template></el-table-column>
        <el-table-column label="状态" width="95"><template #default="{ row }"><el-tag :type="row.enabled ? 'success' : 'info'" size="small">{{ row.enabled ? '启用' : '暂停' }}</el-tag></template></el-table-column>
        <el-table-column label="操作" min-width="320" fixed="right"><template #default="{ row }"><el-button text type="primary" :disabled="busy" title="只采集价格，不触发预警或自动汇总" @click="run(row)">立即采集</el-button><el-button text @click="router.push(`/tasks/${row.id}/edit`)">编辑</el-button><el-button text :disabled="busy" @click="toggle(row)">{{ row.enabled ? '暂停' : '启用' }}</el-button><el-button text :disabled="busy" @click="duplicate(row)">复制</el-button><el-button text type="danger" :disabled="busy" @click="deleteTask(row)">删除</el-button></template></el-table-column>
      </el-table>
      <template v-else><div v-if="runId" class="toolbar"><span>来源采集批次：{{ runId }}</span><el-button text @click="clearRun">查看全部采集记录</el-button></div><RunTable :runs="visibleRuns" :loading="resource.loading.value" @refresh="refresh" /></template>
    </section>
    <div class="pill-note">同店采集按序执行。恢复保留原采集来源和快照；手动重试失败项生成新的手动批次，不触发预警。预警检查与通知状态请在“预警任务 → 执行记录”查看。</div>
  </div>
</template>
