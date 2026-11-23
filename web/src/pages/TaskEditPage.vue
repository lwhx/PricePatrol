<script setup lang="ts">
import { ref, reactive, computed, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import type { CollectionTask, Shop } from '../../../shared/contracts.js';
import { get, post, patch } from '../api/client';
import { parseIds } from '../lib/format';
import { useFeedback } from '../composables/useFeedback';
import PageHeader from '../components/PageHeader.vue';
import ErrorBanner from '../components/ErrorBanner.vue';
type CollectionInput = Pick<CollectionTask, 'name' | 'shopId' | 'enabled' | 'scope' | 'productIds' | 'schedule'>;
const route = useRoute(), router = useRouter();
const editing = computed(() => typeof route.params.id === 'string' ? route.params.id : '');
const { busy, error, act } = useFeedback();
const loading = ref(true), shops = ref<Shop[]>([]), productText = ref(''), version = ref<number | null>(null);
const form = reactive<CollectionInput>({ name: '', shopId: '', enabled: true, scope: 'all', productIds: [], schedule: { kind: 'manual', time: '09:00', days: [1], timezone: 'Asia/Shanghai' } });
function payload(): CollectionInput {
  if (!form.name.trim()) throw new Error('请填写任务名称');
  if (!form.shopId) throw new Error('请选择真实店铺账号');
  const parsed = parseIds(productText.value);
  if (form.scope === 'selected' && parsed.invalid.length) throw new Error(`指定商品包含无效项：${parsed.invalid.slice(0, 5).join('、')}`);
  const productIds = form.scope === 'selected' ? parsed.ids : [];
  if (form.scope === 'selected' && !productIds.length) throw new Error('指定商品范围至少需要一个有效商品 ID');
  if (form.schedule.kind === 'weekly' && !form.schedule.days.length) throw new Error('每周计划至少选择一天');
  if (form.schedule.kind !== 'manual' && !/^\d{2}:\d{2}$/.test(form.schedule.time)) throw new Error('请设置计划运行时间');
  return { name: form.name.trim(), shopId: form.shopId, enabled: form.enabled, scope: form.scope, productIds, schedule: JSON.parse(JSON.stringify(form.schedule)) };
}
async function save() {
  if (busy.value || loading.value || (editing.value && version.value === null)) return;
  await act(async () => {
    const body = payload();
    if (editing.value) await patch(`/tasks/${editing.value}`, { ...body, expectedVersion: version.value });
    else await post('/tasks', body);
    await router.push('/tasks');
  }, '采集任务已保存，配置将在之后创建的采集批次生效');
}
onMounted(async () => {
  await act(async () => {
    shops.value = (await get<{ shops: Shop[] }>('/shops')).shops;
    if (editing.value) {
      const task = (await get<{ tasks: CollectionTask[] }>('/tasks')).tasks.find(item => item.id === editing.value);
      if (!task) throw new Error('该采集任务不存在或已删除');
      version.value = task.version;
      Object.assign(form, { name: task.name, shopId: task.shopId, enabled: task.enabled, scope: task.scope, productIds: task.productIds, schedule: task.schedule }); productText.value = task.productIds.join('\n');
    } else if (shops.value.length === 1) form.shopId = shops.value[0]!.id;
  }); loading.value = false;
});
</script>
<template>
  <div class="editor-width" v-loading="loading">
    <PageHeader :title="editing ? '编辑采集任务' : '新建采集任务'" description="设置采集商品和执行计划。一个采集任务可供多个预警任务共用价格证据。">
      <el-button @click="$router.push('/tasks')">返回列表</el-button><el-button type="primary" :loading="busy" :disabled="loading || (!!editing && version === null)" @click="save">保存任务</el-button>
    </PageHeader>
    <ErrorBanner :message="error" />
    <el-form label-position="top">
      <section class="panel">
        <div class="panel-head"><h2>01 · 基本信息与采集范围</h2><el-switch v-model="form.enabled" active-text="启用采集任务" /></div>
        <div class="panel-body">
          <div class="split-layout">
            <el-form-item label="任务名称" required><el-input v-model="form.name" maxlength="100" placeholder="如：每日全店价格采集" /></el-form-item>
            <el-form-item label="绑定店铺" required><el-select v-model="form.shopId" class="full-width" :disabled="!!editing" placeholder="请选择店铺"><el-option v-for="shop in shops" :key="shop.id" :value="shop.id" :label="`${shop.name}${shop.enabled ? '' : '（已停用）'}`" /></el-select></el-form-item>
          </div>
          <el-empty v-if="!shops.length && !loading" description="还没有店铺账号，请先连接店铺。"><el-button @click="$router.push('/shops')">连接店铺</el-button></el-empty>
          <el-form-item label="采集范围"><el-radio-group v-model="form.scope"><el-radio value="all">全店在售商品（每次重新发现）</el-radio><el-radio value="selected">指定商品</el-radio></el-radio-group></el-form-item>
          <el-form-item v-if="form.scope === 'selected'" label="商品 ID 或链接"><el-input v-model="productText" type="textarea" :rows="5" placeholder="每行一个 ID 或淘宝/天猫商品链接，自动去重；采集时核验商品所属店铺" /><span class="form-hint">有效 {{ parseIds(productText).ids.length }} 个，待修正 {{ parseIds(productText).invalid.length }} 项</span></el-form-item>
        </div>
      </section>
      <section class="panel">
        <div class="panel-head"><h2>02 · 采集计划</h2></div>
        <div class="panel-body">
          <el-form-item label="采集频率"><el-radio-group v-model="form.schedule.kind"><el-radio-button value="manual">仅手动采集</el-radio-button><el-radio-button value="daily">每天</el-radio-button><el-radio-button value="weekly">每周</el-radio-button></el-radio-group></el-form-item>
          <el-form-item v-if="form.schedule.kind === 'weekly'" label="星期"><el-checkbox-group v-model="form.schedule.days"><el-checkbox v-for="(day, index) in ['周日', '周一', '周二', '周三', '周四', '周五', '周六']" :key="index" :value="index">{{ day }}</el-checkbox></el-checkbox-group></el-form-item>
          <el-form-item v-if="form.schedule.kind !== 'manual'" label="执行时间（Asia/Shanghai）"><el-input v-model="form.schedule.time" type="time" style="width:180px" /></el-form-item>
          <div class="pill-note">手动采集不触发预警，也不发送自动汇总。只有按计划创建的采集批次完成或部分完成后，才执行已关联的预警任务。</div>
          <p class="form-hint">预警范围、条件、白名单与通知在“预警任务”中独立设置。修改任务只影响之后创建的采集批次。</p>
          <router-link v-if="editing" :to="{ path: '/alert-tasks/new', query: { collectionTaskId: editing } }">为此采集任务新增预警任务 →</router-link>
        </div>
      </section>
    </el-form>
    <div class="header-actions"><el-button @click="$router.push('/tasks')">返回列表</el-button><el-button type="primary" :loading="busy" :disabled="loading || (!!editing && version === null)" @click="save">保存任务</el-button></div>
  </div>
</template>
