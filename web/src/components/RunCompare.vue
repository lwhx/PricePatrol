<script setup lang="ts">
import { ref, onMounted, computed, watch } from 'vue';
import type { Run, PriceRow } from '../../../shared/contracts.js';
import { get, post } from '../api/client';
import { useFeedback } from '../composables/useFeedback';
import { dateTime, money, discount, moneyDifference } from '../lib/format';
import ErrorBanner from './ErrorBanner.vue';
import StatusTag from './StatusTag.vue';
interface ComparisonRow { id: string; shopId: string; productId: string; skuId: string; left: PriceRow | null; right: PriceRow | null }
const emit = defineEmits<{ close: [] }>();
const runs = ref<Run[]>([]), left = ref(''), right = ref(''), rows = ref<ComparisonRow[]>([]), onlyChanged = ref(false), compared = ref(false);
const { busy, error, act } = useFeedback();
const changed = (row: ComparisonRow) => !row.left || !row.right || ['backendPrice', 'before', 'after', 'status'].some(field => row.left![field as 'after'] !== row.right![field as 'after']);
const visibleRows = computed(() => onlyChanged.value ? rows.value.filter(changed) : rows.value);
watch([left, right], () => { rows.value = []; compared.value = false; });
async function compare() {
  if (!left.value || !right.value || left.value === right.value) { error.value = '请选择两个不同的已结束执行'; return; }
  const a = left.value, b = right.value;
  await act(async () => { const result = await post<{ rows: ComparisonRow[] }>('/prices/compare', { leftRunId: a, rightRunId: b }); if (a === left.value && b === right.value) { rows.value = result.rows; compared.value = true; } });
}
onMounted(() => act(async () => { runs.value = (await get<{ runs: Run[] }>('/runs')).runs.filter(run => ['success', 'partial', 'failed'].includes(run.status)); }));
</script>
<template><el-dialog :model-value="true" title="比较两次执行" width="1180px" @close="emit('close')"><p class="muted">按店铺＋商品＋SKU 对齐历史快照，仅支持同一家店的两次执行。两次范围不一致的记录标为未覆盖，缺价不按零计算。</p><ErrorBanner :message="error" /><div class="toolbar"><el-select v-model="left" placeholder="原执行" filterable style="width:340px"><el-option v-for="run in runs" :key="run.id" :value="run.id" :label="`${run.shopName} / ${run.taskName || '临时采集'} / ${dateTime(run.createdAt)}`" /></el-select><span>→</span><el-select v-model="right" placeholder="新执行" filterable style="width:340px"><el-option v-for="run in runs" :key="run.id" :value="run.id" :label="`${run.shopName} / ${run.taskName || '临时采集'} / ${dateTime(run.createdAt)}`" /></el-select><el-button type="primary" :loading="busy" @click="compare">比较快照</el-button></div><div v-if="compared" class="toolbar"><strong>对齐 {{ rows.length }} 条，变化 {{ rows.filter(changed).length }} 条</strong><span class="spacer" /><el-checkbox v-model="onlyChanged">仅看价格或状态变化</el-checkbox></div><el-table :data="visibleRows" max-height="440" :empty-text="compared ? '暂无符合条件的比较记录' : '选择两个执行并点击比较'"><el-table-column label="商品 / SKU" min-width="240"><template #default="{ row }"><strong>{{ row.right?.title || row.left?.title }}</strong><div class="cell-sub">{{ row.right?.shopName || row.left?.shopName }} · {{ row.productId }}</div><div class="cell-sub">{{ row.right?.specs || row.left?.specs }} · {{ row.skuId || '商品级' }}</div></template></el-table-column><el-table-column label="原快照三价" min-width="190"><template #default="{ row }"><template v-if="row.left"><div>后台 {{ money(row.left.backendPrice) }}</div><div>优惠前 {{ money(row.left.before) }}</div><strong>优惠后 {{ money(row.left.after) }}</strong><div class="cell-sub">{{ discount(row.left.discount) }}</div><StatusTag :value="row.left.stale ? 'stale' : row.left.status" /></template><el-tag v-else type="info" size="small">原执行未覆盖</el-tag></template></el-table-column><el-table-column label="新快照三价" min-width="190"><template #default="{ row }"><template v-if="row.right"><div>后台 {{ money(row.right.backendPrice) }}</div><div>优惠前 {{ money(row.right.before) }}</div><strong>优惠后 {{ money(row.right.after) }}</strong><div class="cell-sub">{{ discount(row.right.discount) }}</div><StatusTag :value="row.right.stale ? 'stale' : row.right.status" /></template><el-tag v-else type="info" size="small">新执行未覆盖</el-tag></template></el-table-column><el-table-column label="优惠后价变化（新−原）" min-width="180"><template #default="{ row }"><span v-if="row.left && row.right && !row.left.stale && !row.right.stale">{{ money(moneyDifference(row.left.after, row.right.after)) }}</span><span v-else class="muted">无法判断</span></template></el-table-column></el-table><template #footer><el-button @click="emit('close')">关闭</el-button></template></el-dialog></template>

