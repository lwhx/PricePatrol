<script setup lang="ts">
import { ref, reactive, computed, onMounted, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import type { AlertTask, AlertTaskInput, CollectionTask, Shop } from '../../../shared/contracts.js';
import { get, post, patch } from '../api/client';
import { parseIds, lines } from '../lib/format';
import { useFeedback } from '../composables/useFeedback';
import PageHeader from '../components/PageHeader.vue';
import ErrorBanner from '../components/ErrorBanner.vue';
import RuleEditor from '../components/RuleEditor.vue';
const route = useRoute(), router = useRouter();
const editing = computed(() => typeof route.params.id === 'string' ? route.params.id : '');
const { busy, error, act } = useFeedback();
const loading = ref(true), collections = ref<CollectionTask[]>([]), shops = ref<Shop[]>([]);
const productText = ref(''), whiteIdText = ref(''), whiteKeywordText = ref('');
const preview = ref<{ count: number; products: { productId: string; title: string }[] } | null>(null);
const form = reactive<AlertTaskInput>({ name: '', collectionTaskId: '', enabled: true, scope: 'all', productIds: [], rules: [{ mode: 'all', conditions: [{ field: 'discount', op: 'lt', value: '8.5' }] }], whitelist: { productIds: [], titleKeywords: [] }, notify: true });
const source = computed(() => collections.value.find(task => task.id === form.collectionTaskId));
function sourceName(task: CollectionTask) { return `${task.name} · ${shops.value.find(shop => shop.id === task.shopId)?.name || task.shopId}${task.enabled ? '' : '（已暂停）'}`; }
function validateIds(text: string, label: string) { const result = parseIds(text); if (result.invalid.length) throw new Error(`${label}包含无效项：${result.invalid.slice(0, 5).join('、')}`); return result.ids; }
watch([whiteIdText, whiteKeywordText], () => { preview.value = null; });
function whitelist() { return { productIds: validateIds(whiteIdText.value, '白名单'), titleKeywords: lines(whiteKeywordText.value) }; }
function payload(): AlertTaskInput {
  if (!form.name.trim()) throw new Error('请填写预警任务名称');
  if (!form.collectionTaskId) throw new Error('请选择关联采集任务');
  const productIds = form.scope === 'selected' ? validateIds(productText.value, '指定商品') : [];
  if (form.scope === 'selected' && !productIds.length) throw new Error('指定预警范围至少需要一个有效商品 ID');
  if (!form.rules.length) throw new Error('请至少添加一组预警条件');
  if (form.rules.some(group => !group.conditions.length || group.conditions.some(condition => !condition.value.trim()))) throw new Error('请填写全部规则值，并移除空条件组');
  return JSON.parse(JSON.stringify({ name: form.name.trim(), collectionTaskId: form.collectionTaskId, enabled: form.enabled, scope: form.scope, productIds, rules: form.rules, whitelist: whitelist(), notify: form.notify }));
}
async function save() { await act(async () => { const body = payload(); if (editing.value) await patch(`/alert-tasks/${editing.value}`, body); else await post('/alert-tasks', body); await router.push('/alert-tasks'); }, '预警任务已保存，配置将在之后创建的定时批次生效'); }
async function previewWhitelist() { if (!editing.value) return; await act(async () => { preview.value = await post(`/alert-tasks/${editing.value}/whitelist/preview`, whitelist()); }); }
onMounted(async () => {
  await act(async () => {
    const [taskResult, shopResult] = await Promise.all([get<{ tasks: CollectionTask[] }>('/tasks'), get<{ shops: Shop[] }>('/shops')]); collections.value = taskResult.tasks; shops.value = shopResult.shops;
    if (editing.value) {
      const task = (await get<{ tasks: AlertTask[] }>('/alert-tasks')).tasks.find(item => item.id === editing.value);
      if (!task) throw new Error('该预警任务不存在或已删除');
      Object.assign(form, { name: task.name, collectionTaskId: task.collectionTaskId, enabled: task.enabled, scope: task.scope, productIds: task.productIds, rules: task.rules, whitelist: task.whitelist, notify: task.notify });
      productText.value = task.productIds.join('\n'); whiteIdText.value = task.whitelist.productIds.join('\n'); whiteKeywordText.value = task.whitelist.titleKeywords.join('\n');
    } else {
      const requested = typeof route.query.collectionTaskId === 'string' ? route.query.collectionTaskId : '';
      if (collections.value.some(task => task.id === requested)) form.collectionTaskId = requested;
      else if (collections.value.length === 1) form.collectionTaskId = collections.value[0]!.id;
    }
  }); loading.value = false;
});
</script>
<template>
  <div class="editor-width" v-loading="loading">
    <PageHeader :title="editing ? '编辑预警任务' : '新建预警任务'" description="关联一个采集任务，独立设置预警范围、条件、白名单与通知。一个采集任务可以关联多个预警任务。"><el-button @click="$router.push('/alert-tasks')">返回列表</el-button><el-button type="primary" :loading="busy" :disabled="loading" @click="save">保存预警任务</el-button></PageHeader>
    <ErrorBanner :message="error" />
    <el-form label-position="top">
      <section class="panel">
        <div class="panel-head"><h2>01 · 基本信息与来源</h2><el-switch v-model="form.enabled" active-text="启用预警任务" /></div>
        <div class="panel-body">
          <div class="split-layout">
            <el-form-item label="预警任务名称" required><el-input v-model="form.name" maxlength="100" placeholder="如：低于 8.5 折预警" /></el-form-item>
            <el-form-item label="关联采集任务" required><el-select v-model="form.collectionTaskId" class="full-width" :disabled="!!editing" placeholder="请选择采集任务"><el-option v-for="task in collections" :key="task.id" :value="task.id" :label="sourceName(task)" /><el-option v-if="editing && form.collectionTaskId && !source" :value="form.collectionTaskId" :label="`已删除采集任务 · ${form.collectionTaskId}`" /></el-select><span class="form-hint">店铺由采集任务确定；保存后不可更换关联。</span></el-form-item>
          </div>
          <el-empty v-if="!collections.length && !loading && !editing" description="请先创建一个采集任务。"><el-button @click="$router.push('/tasks/new')">新建采集任务</el-button></el-empty>
          <div v-if="source" class="pill-note">来源：{{ sourceName(source) }} · {{ source.scope === 'all' ? '全店采集' : `${source.productIds.length} 个指定商品` }}。<router-link :to="`/tasks/${source.id}/edit`">查看采集计划 →</router-link></div>
          <p v-if="source?.schedule.kind === 'manual'" class="form-hint warning-text">关联采集任务当前仅手动运行，不会自动执行预警。请在采集任务中设置每天或每周计划。</p>
          <p v-else-if="source && !source.enabled" class="form-hint warning-text">关联采集任务已暂停，启用后才会创建新的定时批次。</p>
          <p v-else-if="editing && !source && !loading" class="form-hint warning-text">关联采集任务已删除，不会创建新的定时批次；历史执行仍可查看。</p>
          <el-form-item label="预警范围"><el-radio-group v-model="form.scope"><el-radio value="all">检查采集批次中的全部商品</el-radio><el-radio value="selected">只检查指定商品</el-radio></el-radio-group><span class="form-hint">只检查来源批次实际采集的价格；指定预警商品不会扩大采集范围。</span></el-form-item>
          <el-form-item v-if="form.scope === 'selected'" label="预警商品 ID 或链接"><el-input v-model="productText" type="textarea" :rows="5" placeholder="每行一个商品 ID 或淘宝/天猫商品链接" /><span class="form-hint">有效 {{ parseIds(productText).ids.length }} 个，待修正 {{ parseIds(productText).invalid.length }} 项</span></el-form-item>
        </div>
      </section>
      <section class="panel"><div class="panel-head"><h2>02 · 预警条件</h2><span class="muted">按 SKU 判断，保留全部触发原因</span></div><div class="panel-body"><RuleEditor v-model="form.rules" /><p v-if="!form.rules.length" class="pill-note">请至少添加一组预警条件后保存任务。</p></div></section>
      <section class="panel">
        <div class="panel-head"><h2>03 · 预警白名单</h2><el-button :disabled="!editing || loading" :loading="busy" @click="previewWhitelist">预览数据库命中</el-button></div>
        <div class="panel-body"><div class="split-layout"><el-form-item label="排除商品 ID / 链接"><el-input v-model="whiteIdText" type="textarea" :rows="5" placeholder="每行一个，排除该商品全部 SKU" /></el-form-item><el-form-item label="排除标题关键词"><el-input v-model="whiteKeywordText" type="textarea" :rows="5" placeholder="每行一个普通文本关键词，包含任意一条即排除" /></el-form-item></div><div class="pill-note">白名单只影响当前预警任务；商品仍会采集、入库并保留价格历史，其他预警任务独立判断。</div><div v-if="preview" style="margin-top:16px"><p class="section-title">命中 {{ preview.count }} 个商品（展示部分）</p><el-table :data="preview.products" max-height="260" empty-text="当前数据库没有命中商品"><el-table-column prop="productId" label="商品 ID" width="190" /><el-table-column prop="title" label="标题" /></el-table></div></div>
      </section>
      <section class="panel"><div class="panel-head"><h2>04 · 预警汇总通知</h2></div><div class="panel-body"><el-form-item label="Server酱汇总通知"><el-switch v-model="form.notify" active-text="预警检查完成后发送汇总" /><span class="form-hint">需要在系统设置中启用 Server酱并配置 SendKey。通知失败可在预警执行记录中独立重试。</span></el-form-item><div class="pill-note">只有定时采集批次完成或部分完成后才执行预警。预警配置在定时采集入队时固定，修改只影响之后创建的批次。手动采集不触发预警或自动汇总。</div></div></section>
    </el-form>
    <div class="header-actions"><el-button @click="$router.push('/alert-tasks')">返回列表</el-button><el-button type="primary" :loading="busy" :disabled="loading" @click="save">保存预警任务</el-button></div>
  </div>
</template>
