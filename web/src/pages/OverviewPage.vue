<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import type { Overview, Shop } from '../../../shared/contracts.js';
import { get } from '../api/client';
import { useLatest } from '../composables/useLatest';
import { usePolling } from '../composables/usePolling';
import PageHeader from '../components/PageHeader.vue';
import StatCards from '../components/StatCards.vue';
import RunTable from '../components/RunTable.vue';
import StatusTag from '../components/StatusTag.vue';
import ErrorBanner from '../components/ErrorBanner.vue';
const router = useRouter();
const overview = ref<Overview | null>(null), shops = ref<Shop[]>([]);
const { loading, error, load } = useLatest();
function refresh() { return load(() => Promise.all([get<Overview>('/overview'), get<{ shops: Shop[] }>('/shops')]), ([result, accounts]) => { overview.value = result; shops.value = accounts.shops; }); }
usePolling(refresh);
</script>
<template><div><PageHeader title="工作总览" description="了解店铺会话、采集进度与待处理异常。页面每 10 秒更新。"><el-button :loading="loading" @click="refresh">刷新数据</el-button><el-button type="primary" @click="router.push('/tasks/new')">＋ 新建采集任务</el-button></PageHeader><ErrorBanner :message="error" /><StatCards :items="[{ label: '已连接店铺', value: overview?.shops ?? '—', hint: '独立账号与采集会话' }, { label: '数据库商品', value: overview?.products ?? '—', hint: `${overview?.skus ?? '—'} 个 SKU` }, { label: '采集中任务', value: overview?.running ?? '—', hint: `共 ${overview?.tasks ?? '—'} 个采集任务`, tone: 'primary' }, { label: '待处理预警', value: overview?.pendingAlerts ?? '—', hint: '需要人工确认与处理', tone: 'warning' }, { label: '失败 / 陈旧 SKU', value: overview?.failedRows ?? '—', hint: '查看最新尝试与原因', tone: 'danger' }]" /><section class="panel"><div class="panel-head"><div><h2>最近采集</h2><p>已处理数据逐批入库，停止与失败记录持续保留。</p></div><router-link to="/tasks?tab=runs">全部采集 →</router-link></div><RunTable :runs="overview?.recentRuns ?? []" :loading="loading" @refresh="refresh" /></section><section class="panel"><div class="panel-head"><h2>店铺连接状态</h2><router-link to="/shops">管理账号 →</router-link></div><el-table :data="shops" empty-text="尚未连接店铺，请前往店铺账号导入 Cookie 或使用网页登录。"><el-table-column prop="name" label="店铺" min-width="180" /><el-table-column label="平台" width="100"><template #default="{ row }">{{ row.platform === 'tmall' ? '天猫' : '淘宝' }}</template></el-table-column><el-table-column label="会话状态" width="160"><template #default="{ row }"><StatusTag :value="row.sessionStatus" /></template></el-table-column><el-table-column label="启用状态" width="120"><template #default="{ row }"><el-tag :type="row.enabled ? 'success' : 'info'" size="small">{{ row.enabled ? '已启用' : '已停用' }}</el-tag></template></el-table-column><el-table-column label="最近错误" min-width="250"><template #default="{ row }"><span :class="row.lastError ? 'danger-text' : 'muted'">{{ row.lastError || '暂无错误' }}</span></template></el-table-column></el-table></section></div></template>
