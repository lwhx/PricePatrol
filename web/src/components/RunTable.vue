<script setup lang="ts">
import { post } from '../api/client';
import type { Run } from '../../../shared/contracts.js';
import { dateTime } from '../lib/format';
import { useFeedback, confirmAction } from '../composables/useFeedback';
import StatusTag from './StatusTag.vue';
import ErrorBanner from './ErrorBanner.vue';
defineProps<{ runs: Run[]; loading?: boolean }>();
const emit = defineEmits<{ refresh: [] }>();
const { busy, error, act } = useFeedback();
const source = (run: Run) => run.trigger === 'manual' ? '手动采集' : run.trigger === 'scheduled' ? '定时采集' : '旧版本';
async function action(run: Run, type: 'stop' | 'resume' | 'retry') {
  if (type === 'stop' && !await confirmAction('停止后会保留已采集数据，可稍后继续此执行。恢复保留原采集来源。')) return;
  await act(async () => { await post(`/runs/${run.id}/${type}`); emit('refresh'); }, type === 'retry' ? '已创建手动重试批次，不触发预警；原报告保持不变' : type === 'resume' ? '已恢复原采集批次，来源与配置快照保持不变' : '已停止采集');
}
</script>
<template>
  <ErrorBanner :message="error" />
  <el-table :data="runs" v-loading="loading" row-key="id" empty-text="暂无采集记录，请先创建并运行采集任务。" stripe>
    <el-table-column type="expand"><template #default="{ row }"><div class="run-details">
      <p><b>采集批次 ID</b> {{ row.id }} <span v-if="row.parentRunId"> / 手动重试自 {{ row.parentRunId }}</span></p>
      <p>{{ row.message || '暂无采集说明' }}</p>
      <div class="inline-metrics"><span>入库 SKU {{ row.rows }}</span><span>采集来源 {{ source(row) }}</span></div>
      <div v-if="!row.trigger || row.trigger === 'legacy'" class="inline-metrics"><span>旧版本检查 {{ row.checked }}</span><span>排除 {{ row.excluded }}</span><span>命中 {{ row.matched }}</span><span>无法判断 {{ row.unknown }}</span></div>
      <p v-if="row.trigger === 'manual'">此批次只采集价格，不触发预警或自动汇总。</p>
      <p v-else-if="row.trigger === 'scheduled'">此批次完成或部分完成后执行关联预警。预警检查结果与通知状态独立保留。</p>
      <p v-else>旧版本批次缺少可信来源，仅保留历史证据，不补发预警。</p>
      <p>启动：{{ dateTime(row.startedAt) }} · 结束：{{ dateTime(row.finishedAt) }}</p>
      <p v-if="row.failedProductIds.length">失败商品：{{ row.failedProductIds.join('、') }}</p>
      <p v-if="['stopped', 'recoverable', 'auth_required'].includes(row.status)">恢复保留原采集来源；定时批次恢复完成后仍会执行原快照中的关联预警。</p>
      <router-link :to="{ path: '/prices', state: { priceQuery: { view: 'sku', runId: row.id } } }">查询本批次价格</router-link>
      <router-link v-if="row.trigger === 'scheduled'" :to="{ path: '/alert-tasks', query: { tab: 'runs', collectionRunId: row.id } }">查看关联预警执行</router-link>
      <router-link v-else-if="!row.trigger || row.trigger === 'legacy'" :to="{ path: '/alerts', query: { runId: row.id } }">查看历史预警</router-link>
    </div></template></el-table-column>
    <el-table-column label="采集任务 / 店铺" min-width="210"><template #default="{ row }"><strong>{{ row.taskName || '临时采集' }}</strong><div class="cell-sub">{{ row.shopName }}</div></template></el-table-column>
    <el-table-column label="来源" width="110"><template #default="{ row }"><el-tag :type="row.trigger === 'scheduled' ? 'primary' : 'info'" size="small">{{ source(row) }}</el-tag></template></el-table-column>
    <el-table-column label="采集状态" width="145"><template #default="{ row }"><StatusTag :value="row.status" /></template></el-table-column>
    <el-table-column label="商品进度" min-width="170"><template #default="{ row }"><div class="progress-label">{{ row.processed }} / {{ row.expected || '待发现' }}<span>失败 {{ row.failed }}</span></div><el-progress :percentage="row.expected ? Math.min(100, Math.round(row.processed / row.expected * 100)) : 0" :show-text="false" :stroke-width="5" /></template></el-table-column>
    <el-table-column prop="rows" label="入库 SKU" width="100" />
    <el-table-column label="创建时间" min-width="170"><template #default="{ row }">{{ dateTime(row.createdAt) }}</template></el-table-column>
    <el-table-column label="操作" min-width="220" fixed="right"><template #default="{ row }"><el-button v-if="['queued', 'running', 'auth_required'].includes(row.status)" text type="danger" :disabled="busy" @click="action(row, 'stop')">停止</el-button><el-button v-if="['stopped', 'recoverable', 'auth_required'].includes(row.status)" text type="primary" :disabled="busy" @click="action(row, 'resume')">继续 / 恢复</el-button><el-button v-if="['success', 'partial', 'failed'].includes(row.status) && row.failedProductIds.length" text type="primary" :disabled="busy" title="创建新手动批次，不触发预警" @click="action(row, 'retry')">手动重试失败项</el-button></template></el-table-column>
  </el-table>
</template>
