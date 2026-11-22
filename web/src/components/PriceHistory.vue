<script setup lang="ts">
import { ref, onMounted } from 'vue';
import type { PriceRow, ProductRow } from '../../../shared/contracts.js';
import { get } from '../api/client';
import { dateTime, money, discount } from '../lib/format';
import { useLatest } from '../composables/useLatest';
import ErrorBanner from './ErrorBanner.vue';
import StatusTag from './StatusTag.vue';
const props = defineProps<{ row: PriceRow | ProductRow }>();
const emit = defineEmits<{ close: [] }>();
const rows = ref<PriceRow[]>([]), { loading, error, load } = useLatest();
const params = new URLSearchParams({ shopId: props.row.shopId, productId: props.row.productId });
if ('skuId' in props.row && props.row.skuId) params.set('skuId', props.row.skuId);
onMounted(() => load(() => get<{ rows: PriceRow[] }>(`/prices/history?${params}`), result => { rows.value = result.rows; }));
</script>
<template><el-dialog :model-value="true" title="商品详情与价格历史" width="1120px" @close="emit('close')"><div class="history-summary"><el-tag effect="plain">{{ row.shopName }}</el-tag><el-tag type="info" effect="plain">商品 {{ row.productId }}</el-tag><el-tag v-if="'skuId' in row" type="info" effect="plain">SKU {{ row.skuId || '商品级记录' }}</el-tag></div><h3 style="font-size:16px">{{ row.title }}</h3><p v-if="'specs' in row" class="muted">{{ row.specs }}</p><a v-if="row.sourceUrl" :href="row.sourceUrl" target="_blank" rel="noopener noreferrer">查看原商品 ↗</a><ErrorBanner :message="error" /><el-table :data="rows" v-loading="loading" max-height="480" style="margin-top:18px" empty-text="暂无该商品的价格历史"><el-table-column label="采集时间" min-width="180"><template #default="{ row: item }">{{ dateTime(item.updatedAt) }}<div v-if="item.stale" class="cell-sub">上次成功旧价，本次不可判断</div></template></el-table-column><el-table-column prop="specs" label="规格" min-width="180" /><el-table-column label="后台标价" width="120"><template #default="{ row: item }">{{ money(item.backendPrice) }}</template></el-table-column><el-table-column label="优惠前" width="120"><template #default="{ row: item }">{{ money(item.before) }}</template></el-table-column><el-table-column label="优惠后" width="120"><template #default="{ row: item }">{{ money(item.after) }}</template></el-table-column><el-table-column label="折扣" width="115"><template #default="{ row: item }"><span :title="item.discount || '缺值不可判断'">{{ discount(item.discount) }}</span></template></el-table-column><el-table-column label="状态 / 原因" min-width="200"><template #default="{ row: item }"><StatusTag :value="item.status" /><div class="cell-sub">{{ item.error }}</div></template></el-table-column><el-table-column label="执行批次" width="140"><template #default="{ row: item }"><router-link :to="{ path: '/prices', query: { run: item.runId } }" @click="emit('close')">{{ item.runId.slice(0, 10) }}…</router-link></template></el-table-column></el-table><template #footer><el-button @click="emit('close')">关闭，保留查询和选中</el-button></template></el-dialog></template>
