<script setup lang="ts">
import {ref} from 'vue';
import type {OperationsOverview} from '../../../shared/operations.js';
import {get} from '../api/client';
import {useLatest} from '../composables/useLatest';
import {usePolling} from '../composables/usePolling';
import {dateTime} from '../lib/format';
import ErrorBanner from './ErrorBanner.vue';
import StatusTag from './StatusTag.vue';
const operations=ref<OperationsOverview|null>(null),resource=useLatest();
const reasons:Record<string,string>={queued:'已创建采集',merged:'已合并到排队批次',missed:'停机期间错过计划',account_invalid:'等待账号验证',shop_disabled:'店铺已停用',shop_missing:'店铺不存在',schedule_invalid:'计划配置无效',enqueue_failed:'创建采集失败'};
function refresh(){return resource.load(()=>get<OperationsOverview>('/operations'),value=>{operations.value=value;});}
usePolling(refresh);
function age(seconds:number|null){if(seconds===null)return '尚未完整成功';if(seconds<3600)return `${Math.floor(seconds/60)} 分钟`;if(seconds<86400)return `${(seconds/3600).toFixed(1)} 小时`;return `${(seconds/86400).toFixed(1)} 天`;}
</script>
<template>
 <section class="panel"><div class="panel-head"><div><h2>运行健康</h2><p>查看每家店最近的完整成功采集，区分价格正常和未能采集。</p></div><el-button :loading="resource.loading.value" @click="refresh">刷新运行状态</el-button></div>
  <ErrorBanner :message="resource.error.value" />
  <div v-if="operations" class="panel-body"><div class="inline-metrics pill-note"><span>采集排队 {{ operations.queues.collectionQueued }}</span><span>正在采集 {{ operations.queues.collectionRunning }}</span><span>预警排队 {{ operations.queues.alertQueued }}</span><span>正在检查 {{ operations.queues.alertRunning }}</span><span>待投递 {{ operations.queues.notificationPending }}</span><span>投递失败 {{ operations.queues.notificationFailed }}</span></div></div>
  <el-table :data="operations?.shops??[]" empty-text="暂无店铺运行记录"><el-table-column prop="shopName" label="店铺" min-width="160" /><el-table-column label="最近完整成功" min-width="190"><template #default="{row}">{{ dateTime(row.lastSuccessAt) }}</template></el-table-column><el-table-column label="距完整成功" min-width="150"><template #default="{row}">{{ age(row.dataAgeSeconds) }}</template></el-table-column><el-table-column label="连续失败" width="110"><template #default="{row}"><span :class="row.consecutiveFailures?'danger-text':''">{{ row.consecutiveFailures }}</span></template></el-table-column><el-table-column label="最近采集状态" min-width="150"><template #default="{row}"><StatusTag v-if="row.lastStatus" :value="row.lastStatus" /><span v-else>尚未采集</span></template></el-table-column></el-table>
 </section>
 <section class="panel"><div class="panel-head"><h2>最近计划执行情况</h2><span class="muted">保留近期执行与跳过原因</span></div><el-table :data="operations?.recentSchedules??[]" max-height="320" empty-text="暂无定时执行记录"><el-table-column label="计划时间" min-width="190"><template #default="{row}">{{ dateTime(row.scheduledFor) }}</template></el-table-column><el-table-column label="店铺" min-width="150"><template #default="{row}">{{ operations?.shops.find(shop=>shop.shopId===row.shopId)?.shopName||row.shopId }}</template></el-table-column><el-table-column label="结果" min-width="180"><template #default="{row}">{{ reasons[row.reason]||row.reason }}</template></el-table-column><el-table-column label="采集记录" min-width="150"><template #default="{row}"><router-link v-if="row.runId" :to="{path:'/tasks',query:{tab:'runs',runId:row.runId}}">查看采集批次 →</router-link><span v-else>本轮未执行采集</span></template></el-table-column></el-table></section>
</template>
