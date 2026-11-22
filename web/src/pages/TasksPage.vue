<script setup lang="ts">
import { ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import type { MonitorTask, Run, Shop } from '../../../shared/contracts.js';
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
const tasks = ref<MonitorTask[]>([]), runs = ref<Run[]>([]), shops = ref<Shop[]>([]);
const { busy, error, act } = useFeedback(), resource = useLatest();
function refresh() { return resource.load(() => Promise.all([get<{ tasks: MonitorTask[] }>('/tasks'), get<{ runs: Run[] }>('/runs'), get<{ shops: Shop[] }>('/shops')]), ([a, b, c]) => { tasks.value = a.tasks; runs.value = b.runs; shops.value = c.shops; }); }
async function run(task: MonitorTask) { await act(async () => { await post(`/tasks/${task.id}/run`); tab.value = 'runs'; await refresh(); }, '已加入执行队列；已有执行时将复用当前作业'); }
async function toggle(task: MonitorTask) { await act(async () => { await patch(`/tasks/${task.id}`, { enabled: !task.enabled }); await refresh(); }, '任务启用状态已更新'); }
async function duplicate(task: MonitorTask) { await act(async () => { await post(`/tasks/${task.id}/duplicate`); await refresh(); }, '已创建暂停状态的任务副本'); }
async function deleteTask(task: MonitorTask) { if (!await confirmAction(`删除任务「${task.name}」？价格历史和预警记录仍会保留。`)) return; await act(async () => { await remove(`/tasks/${task.id}`); await refresh(); }, '任务已删除'); }
function schedule(task: MonitorTask) { if (task.schedule.kind === 'manual') return '仅手动'; const days = ['日', '一', '二', '三', '四', '五', '六']; return `${task.schedule.kind === 'daily' ? '每天' : `每周${task.schedule.days.map(day => days[day]).join('、')}`} ${task.schedule.time}`; }
usePolling(refresh, 5000);
</script>
<template><div><PageHeader title="监控任务" description="同一店铺可配置多个独立任务。采集范围、规则、白名单和执行证据分别保留。"><el-button :loading="resource.loading.value" @click="refresh">刷新</el-button><el-button type="primary" @click="router.push('/tasks/new')">＋ 新建任务</el-button></PageHeader><ErrorBanner :message="error || resource.error.value" /><StatCards :items="[{ label: '全部任务', value: tasks.length }, { label: '已启用', value: tasks.filter(t => t.enabled).length, tone: 'primary' }, { label: '采集 / 排队', value: runs.filter(r => ['running', 'queued'].includes(r.status)).length }, { label: '待恢复 / 验证', value: runs.filter(r => ['recoverable', 'auth_required'].includes(r.status)).length, tone: 'warning' }]" /><section class="panel"><el-tabs v-model="tab" class="table-tabs"><el-tab-pane label="任务列表" name="tasks" /><el-tab-pane :label="`执行记录（${runs.length}）`" name="runs" /></el-tabs><el-table v-if="tab === 'tasks'" :data="tasks" v-loading="resource.loading.value" row-key="id" empty-text="暂无监控任务。先连接店铺，再新建任务。"><el-table-column label="任务 / 店铺" min-width="210"><template #default="{ row }"><router-link :to="`/tasks/${row.id}/edit`"><strong>{{ row.name }}</strong></router-link><div class="cell-sub">{{ shops.find(shop => shop.id === row.shopId)?.name || row.shopId }} · v{{ row.version }}</div></template></el-table-column><el-table-column label="范围 / 白名单" min-width="170"><template #default="{ row }">{{ row.scope === 'all' ? '全店在售商品' : `${row.productIds.length} 个指定商品` }}<div class="cell-sub">{{ row.whitelist.productIds.length }} 个 ID · {{ row.whitelist.titleKeywords.length }} 个关键词</div></template></el-table-column><el-table-column label="规则 / 通知" min-width="140"><template #default="{ row }">{{ row.rules.reduce((sum: number, group: { conditions: unknown[] }) => sum + group.conditions.length, 0) }} 项条件<div class="cell-sub">{{ row.notify ? '完成后发送汇总' : '不发送外部通知' }}</div></template></el-table-column><el-table-column label="计划 / 下次运行" min-width="195"><template #default="{ row }">{{ schedule(row) }}<div class="cell-sub">{{ dateTime(row.nextRunAt) }}</div></template></el-table-column><el-table-column label="状态" width="95"><template #default="{ row }"><el-tag :type="row.enabled ? 'success' : 'info'" size="small">{{ row.enabled ? '启用' : '暂停' }}</el-tag></template></el-table-column><el-table-column label="操作" min-width="310" fixed="right"><template #default="{ row }"><el-button text type="primary" :disabled="busy" @click="run(row)">立即运行</el-button><el-button text @click="router.push(`/tasks/${row.id}/edit`)">编辑</el-button><el-button text :disabled="busy" @click="toggle(row)">{{ row.enabled ? '暂停' : '启用' }}</el-button><el-button text :disabled="busy" @click="duplicate(row)">复制</el-button><el-button text type="danger" :disabled="busy" @click="deleteTask(row)">删除</el-button></template></el-table-column></el-table><RunTable v-else :runs="runs" :loading="resource.loading.value" @refresh="refresh" /></section><div class="pill-note">同店作业自动排队。修改任务只影响下次执行；继续使用原作业快照，失败项重试会生成关联的新执行。</div></div></template>
