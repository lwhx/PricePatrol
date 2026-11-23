<script setup lang="ts">
import type { AlertRun } from '../../../shared/contracts.js';
import { post } from '../api/client';
import { dateTime } from '../lib/format';
import { useFeedback } from '../composables/useFeedback';
import StatusTag from './StatusTag.vue';
import ErrorBanner from './ErrorBanner.vue';
defineProps<{ runs: AlertRun[]; loading?: boolean }>();
const emit = defineEmits<{ refresh: [] }>();
const { busy, error, act } = useFeedback();
function canNotify(run: AlertRun) { return ['success', 'partial'].includes(run.status) && !['disabled', 'skipped', 'sending', 'accepted', 'sent'].includes(run.notificationStatus); }
async function notify(run: AlertRun) {
  await act(async () => { await post(`/alert-runs/${run.id}/notify`); emit('refresh'); }, '汇总通知重试已提交；不会重新采集或评估规则');
}
</script>
<template>
  <ErrorBanner :message="error" />
  <el-table :data="runs" v-loading="loading" row-key="id" empty-text="暂无预警执行。关联的定时采集完成或部分完成后，将自动创建独立预警执行。" stripe>
    <el-table-column type="expand"><template #default="{ row }"><div class="run-details">
      <p><b>预警执行 ID</b> {{ row.id }} · 规则 v{{ row.ruleVersion }}</p>
      <p>{{ row.message || '暂无预警执行说明' }}</p>
      <p v-if="row.status === 'partial'" class="warning-text">覆盖不完整：本次只检查来源批次中可用的价格，未覆盖或无法判断的商品不能视为价格正常。</p>
      <p v-else-if="row.unknown" class="warning-text">存在无法判断的 SKU；缺失价格不视为价格正常。</p>
      <div class="inline-metrics"><span>来源 SKU {{ row.rows }}</span><span>已检查 {{ row.checked }}</span><span>白名单排除 {{ row.excluded }}</span><span>命中 {{ row.matched }}</span><span>无法判断 {{ row.unknown }}</span></div>
      <div v-if="row.lifecycle" class="inline-metrics"><span>首次 {{ row.lifecycle.first }}</span><span>持续 {{ row.lifecycle.continuing }}</span><span>恶化 {{ row.lifecycle.worsened }}</span><span>恢复 {{ row.lifecycle.recovered }}</span><span>本次通知候选 {{ row.notificationCount ?? 0 }}</span></div>
      <p>启动：{{ dateTime(row.startedAt) }} · 结束：{{ dateTime(row.finishedAt) }}</p>
      <p>来源采集批次：<router-link :to="{ path: '/tasks', query: { tab: 'runs', runId: row.collectionRunId } }">{{ row.collectionRunId }}</router-link></p>
      <router-link :to="{ path: '/prices', state: { priceQuery: { view: 'sku', runId: row.collectionRunId } } }">查看来源批次价格证据</router-link>
      <router-link :to="{ path: '/alerts', query: { alertRunId: row.id } }">查看本次预警记录</router-link>
      <p class="muted">通知与采集状态独立。重试汇总仅投递本次预警执行结果，不会重新采集或重新判断。</p>
    </div></template></el-table-column>
    <el-table-column label="预警任务 / 店铺" min-width="210"><template #default="{ row }"><strong>{{ row.taskName }}</strong><div class="cell-sub">{{ row.shopName }} · 规则 v{{ row.ruleVersion }}</div></template></el-table-column>
    <el-table-column label="检查状态" min-width="145"><template #default="{ row }"><el-tag v-if="row.status === 'running'" type="primary" size="small">检查中</el-tag><StatusTag v-else :value="row.status" /><div v-if="row.status === 'partial'" class="cell-sub warning-text">覆盖不完整</div></template></el-table-column>
    <el-table-column label="检查 / 排除" min-width="125"><template #default="{ row }">{{ row.checked }} / {{ row.excluded }}<div class="cell-sub">来源 SKU {{ row.rows }}</div></template></el-table-column>
    <el-table-column label="命中 / 无法判断" min-width="135"><template #default="{ row }"><strong>{{ row.matched }}</strong> / {{ row.unknown }}</template></el-table-column>
    <el-table-column label="通知" width="115"><template #default="{ row }"><StatusTag :value="row.notificationStatus" /><div v-if="row.notificationCount !== undefined" class="cell-sub">本次 {{ row.notificationCount }} 条</div></template></el-table-column>
    <el-table-column label="创建时间" min-width="170"><template #default="{ row }">{{ dateTime(row.createdAt) }}</template></el-table-column>
    <el-table-column label="操作" min-width="200" fixed="right"><template #default="{ row }"><router-link :to="{ path: '/alerts', query: { alertRunId: row.id } }">预警记录</router-link><el-button v-if="canNotify(row)" text :disabled="busy" @click="notify(row)">重发汇总</el-button></template></el-table-column>
  </el-table>
</template>
