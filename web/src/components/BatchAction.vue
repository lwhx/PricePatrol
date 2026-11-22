<script setup lang="ts">
import { ref, onMounted, computed } from 'vue';
import { ElMessage } from 'element-plus';
import type { AlertTask, CollectionTask, PriceRow, ProductRow } from '../../../shared/contracts.js';
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
onMounted(() => {
  if (props.type === 'task') void act(async () => { tasks.value = (await get<{ tasks: CollectionTask[] }>('/tasks')).tasks; });
  if (props.type === 'whitelist') void act(async () => { tasks.value = (await get<{ tasks: AlertTask[] }>('/alert-tasks')).tasks; });
});
async function submit() {
  if (!props.rows.length) { error.value = '请先勾选记录'; return; }
  const count = groups.value.reduce((sum, group) => sum + group.productIds.length, 0);
  if (props.type === 'collect' && !await confirmAction(`将对 ${groups.value.length} 家店铺的 ${count} 个商品发起真实采集，仅更新价格，不触发预警或自动汇总通知。是否开始？`)) return;
  await act(async () => {
    if (props.type === 'task' || props.type === 'whitelist') {
      const task = available.value.find(task => task.id === taskId.value); if (!task) throw new Error(props.type === 'task' ? '请选择同店铺的指定商品采集任务' : '请选择同店铺的预警任务');
      const ids = groups.value[0]!.productIds;
      if (props.type === 'task') await patch(`/tasks/${task.id}`, { productIds: [...new Set([...task.productIds, ...ids])] });
      else { const result = await post<{ added: number; existing: number }>(`/alert-tasks/${task.id}/whitelist`, { productIds: ids }); ElMessage.success(`白名单新增 ${result.added}，已存在 ${result.existing}`); }
    } else for (const group of groups.value) {
      if (props.type === 'collect') await post(`/shops/${group.shopId}/collect`, { productIds: group.productIds });
      else {
        if (!updateTags.value && !updateNote.value) throw new Error('请至少选择一个要更新的字段');
        await patch('/prices/annotations', { ...group, tags: updateTags.value ? lines(tags.value) : undefined, note: updateNote.value ? note.value : undefined });
      }
    }
    emit('complete');
  }, props.type === 'whitelist' ? '' : '批量操作已完成');
}
</script>
<template><el-dialog :model-value="true" :title="titles[type]" width="640px" :close-on-click-modal="false" @close="emit('close')"><ErrorBanner :message="error" /><div class="pill-note">已勾选 {{ rows.length }} 行，按店铺＋商品去重后共 {{ groups.reduce((sum, group) => sum + group.productIds.length, 0) }} 个商品，涉及 {{ groups.length }} 家店铺。商品级操作覆盖该商品全部 SKU。</div><el-table :data="groups.map(group => ({ shop: rows.find(row => row.shopId === group.shopId)?.shopName, count: group.productIds.length }))" style="margin:15px 0"><el-table-column prop="shop" label="店铺" /><el-table-column prop="count" label="商品数" width="120" /></el-table><template v-if="type === 'task' || type === 'whitelist'"><el-select v-model="taskId" class="full-width" :placeholder="type === 'task' ? '选择同店的指定商品采集任务' : '选择同店的预警任务'"><el-option v-for="task in available" :key="task.id" :value="task.id" :label="task.name" /></el-select><p class="form-hint">{{ groups.length > 1 ? '当前选择跨店铺，请按店铺分别加入任务。' : type === 'task' ? '只能加入指定商品采集任务；全店采集任务会自动发现商品。' : '白名单只影响此预警任务，仍采集并保留价格。' }}</p></template><p v-if="type === 'collect'" class="pill-note">本次为手动采集，仅更新价格，不触发预警或自动汇总通知。</p><template v-if="type === 'annotation'"><el-checkbox v-model="updateTags">覆盖标签（留空清除）</el-checkbox><el-input v-model="tags" :disabled="!updateTags" placeholder="多个标签用逗号分隔" style="margin:8px 0 16px" /><el-checkbox v-model="updateNote">覆盖备注（留空清除）</el-checkbox><el-input v-model="note" :disabled="!updateNote" type="textarea" :rows="4" style="margin-top:8px" /></template><template #footer><el-button @click="emit('close')">取消</el-button><el-button type="primary" :loading="busy" @click="submit">确认{{ type === 'collect' ? '采集' : '保存' }}</el-button></template></el-dialog></template>
