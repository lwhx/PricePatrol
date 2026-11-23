<script setup lang="ts">
import { ref, onMounted, computed } from 'vue';
import { ElMessage } from 'element-plus';
import type { AlertTask, CollectionTask, PriceRow, ProductRow, Run } from '../../../shared/contracts.js';
import { get, post, patch } from '../api/client';
import { groupSelectedProducts } from '../lib/selection';
import { lines } from '../lib/format';
import { useFeedback, confirmAction } from '../composables/useFeedback';
import ErrorBanner from './ErrorBanner.vue';
const props = defineProps<{ rows: (PriceRow | ProductRow)[]; type: 'task' | 'whitelist' | 'collect' | 'annotation' }>();
const emit = defineEmits<{ close: []; complete: [] }>();
const tasks = ref<(CollectionTask | AlertTask)[]>([]), taskId = ref(''), tags = ref(''), note = ref(''), updateTags = ref(true), updateNote = ref(true);
const groups = computed(() => groupSelectedProducts(props.rows));
const { busy, error, act } = useFeedback();
const titles = { task: '加入采集任务范围', whitelist: '加入预警任务白名单', collect: '重采选中商品（仅采集）', annotation: '编辑商品标签与备注' };
const available = computed(() => tasks.value.filter(task => groups.value.length === 1 && task.shopId === groups.value[0]!.shopId && (props.type !== 'task' || task.scope === 'selected')));
const groupRows = computed(() => groups.value.map(group => ({
  ...group,
  shop: props.rows.find(row => row.shopId === group.shopId)?.shopName || group.shopId,
  count: group.productIds.length,
})));
type CollectionGroup = (typeof groupRows.value)[number] & {
  idempotencyKey: string;
  status: string;
  runId?: string;
};
const collectionGroups = ref<CollectionGroup[]>([]);
const confirming = ref(false);
const submitting = computed(() => busy.value || confirming.value);
const tableRows = computed(() => collectionGroups.value.length ? collectionGroups.value : groupRows.value);
const count = computed(() => tableRows.value.reduce((sum, group) => sum + group.count, 0));
onMounted(() => {
  if (props.type === 'task') void act(async () => { tasks.value = (await get<{ tasks: CollectionTask[] }>('/tasks')).tasks; });
  if (props.type === 'whitelist') void act(async () => { tasks.value = (await get<{ tasks: AlertTask[] }>('/alert-tasks')).tasks; });
});
function close() {
  if (!submitting.value) emit('close');
}
async function submitCollections() {
  const pending = collectionGroups.value.length ? collectionGroups.value.filter(group => !group.runId) : groupRows.value;
  const productCount = pending.reduce((sum, group) => sum + group.count, 0);
  confirming.value = true;
  let confirmed: boolean;
  try {
    confirmed = await confirmAction(`将对 ${pending.length} 家店铺的 ${productCount} 个商品发起真实采集，仅更新价格，不触发预警或自动汇总通知。是否开始？`);
  } finally { confirming.value = false; }
  if (!confirmed) return;
  await act(async () => {
    if (!collectionGroups.value.length) collectionGroups.value = pending.map(group => ({
      ...group,
      // getRandomValues is also available when a local deployment uses HTTP.
      idempotencyKey: Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join(''),
      status: '等待提交',
    }));
    for (const group of collectionGroups.value) {
      if (group.runId) continue;
      group.status = '正在提交';
      try {
        const { run } = await post<{ run: Run }>(`/shops/${group.shopId}/collect`, {
          productIds: group.productIds,
          idempotencyKey: group.idempotencyKey,
        });
        if (!run?.id) throw new Error('未收到采集批次编号');
        group.runId = run.id;
        group.status = '已受理';
      } catch (cause) {
        group.status = `提交失败：${cause instanceof Error ? cause.message : String(cause)}`;
      }
    }
    const accepted = collectionGroups.value.filter(group => group.runId).length;
    const failed = collectionGroups.value.length - accepted;
    if (failed) {
      error.value = `已受理 ${accepted} 家店铺，${failed} 家提交失败。可重试失败店铺。`;
      return;
    }
    ElMessage.success('已受理全部店铺的手动采集请求');
    emit('complete');
  });
}
async function submit() {
  if (submitting.value) return;
  if (!props.rows.length && !collectionGroups.value.length) { error.value = '请先勾选记录'; return; }
  if (props.type === 'collect') return submitCollections();
  await act(async () => {
    if (props.type === 'task' || props.type === 'whitelist') {
      const task = available.value.find(task => task.id === taskId.value); if (!task) throw new Error(props.type === 'task' ? '请选择同店铺的指定商品采集任务' : '请选择同店铺的预警任务');
      const ids = groups.value[0]!.productIds;
      if (props.type === 'task') await post(`/tasks/${task.id}/products`, { productIds: ids });
      else { const result = await post<{ added: number; existing: number }>(`/alert-tasks/${task.id}/whitelist`, { productIds: ids }); ElMessage.success(`白名单新增 ${result.added}，已存在 ${result.existing}`); }
    } else {
      if (!updateTags.value && !updateNote.value) throw new Error('请至少选择一个要更新的字段');
      for (const group of groups.value) {
        await patch('/prices/annotations', { ...group, tags: updateTags.value ? lines(tags.value) : undefined, note: updateNote.value ? note.value : undefined });
      }
    }
    emit('complete');
  }, props.type === 'whitelist' ? '' : '批量操作已完成');
}
</script>
<template>
  <el-dialog :model-value="true" :title="titles[type]" width="640px" :close-on-click-modal="false"
    :show-close="!submitting" :close-on-press-escape="!submitting" @close="close">
    <ErrorBanner :message="error" />
    <div class="pill-note">已勾选 {{ rows.length }} 行，按店铺和商品去重后共 {{ count }} 个商品，涉及 {{ tableRows.length }} 家店铺。商品级操作覆盖该商品全部 SKU。</div>
    <el-table :data="tableRows" style="margin:15px 0">
      <el-table-column prop="shop" label="店铺" />
      <el-table-column prop="count" label="商品数" width="120" />
      <el-table-column v-if="collectionGroups.length" prop="status" label="采集请求状态" min-width="220" />
    </el-table>
    <template v-if="type === 'task' || type === 'whitelist'">
      <el-select v-model="taskId" class="full-width" :placeholder="type === 'task' ? '选择同店的指定商品采集任务' : '选择同店的预警任务'">
        <el-option v-for="task in available" :key="task.id" :value="task.id" :label="task.name" />
      </el-select>
      <p class="form-hint">{{ groups.length > 1 ? '当前选择跨店铺，请按店铺分别加入任务。' : type === 'task' ? '只能加入指定商品采集任务；全店采集任务会自动发现商品。' : '白名单只影响此预警任务，仍采集并保留价格。' }}</p>
    </template>
    <p v-if="type === 'collect'" class="pill-note">本次为手动采集，仅更新价格，不触发预警或自动汇总通知。</p>
    <template v-if="type === 'annotation'">
      <el-checkbox v-model="updateTags">覆盖标签（留空清除）</el-checkbox>
      <el-input v-model="tags" :disabled="!updateTags" placeholder="多个标签用逗号分隔" style="margin:8px 0 16px" />
      <el-checkbox v-model="updateNote">覆盖备注（留空清除）</el-checkbox>
      <el-input v-model="note" :disabled="!updateNote" type="textarea" :rows="4" style="margin-top:8px" />
    </template>
    <template #footer>
      <el-button :disabled="submitting" @click="close">{{ collectionGroups.length ? '关闭' : '取消' }}</el-button>
      <el-button type="primary" :loading="busy" :disabled="confirming" @click="submit">
        {{ type === 'collect' ? (collectionGroups.length ? '重试失败店铺' : '确认采集') : '确认保存' }}
      </el-button>
    </template>
  </el-dialog>
</template>
