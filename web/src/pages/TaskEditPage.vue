<script setup lang="ts">
import { ref, reactive, computed, onMounted, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import type { TaskInput, MonitorTask, Shop } from '../../../shared/contracts.js';
import { get, post, patch } from '../api/client';
import { parseIds, lines } from '../lib/format';
import { useFeedback } from '../composables/useFeedback';
import PageHeader from '../components/PageHeader.vue';
import ErrorBanner from '../components/ErrorBanner.vue';
import RuleEditor from '../components/RuleEditor.vue';
const route = useRoute(), router = useRouter();
const editing = computed(() => typeof route.params.id === 'string' ? route.params.id : '');
const { busy, error, act } = useFeedback();
const loading = ref(true), shops = ref<Shop[]>([]), productText = ref(''), whiteIdText = ref(''), whiteKeywordText = ref('');
const preview = ref<{ count: number; products: { productId: string; title: string }[] } | null>(null);
const form = reactive<TaskInput>({ name: '', shopId: '', enabled: true, scope: 'all', productIds: [], rules: [{ mode: 'all', conditions: [{ field: 'discount', op: 'lt', value: '8.5' }] }], whitelist: { productIds: [], titleKeywords: [] }, schedule: { kind: 'manual', time: '09:00', days: [1], timezone: 'Asia/Shanghai' }, notify: true });
function validateIds(text: string, label: string) { const result = parseIds(text); if (result.invalid.length) throw new Error(`${label}包含无效项：${result.invalid.slice(0, 5).join('、')}`); return result.ids; }
watch([whiteIdText, whiteKeywordText], () => { preview.value = null; });
function whitelist() { return { productIds: validateIds(whiteIdText.value, '白名单'), titleKeywords: lines(whiteKeywordText.value) }; }
function payload(): TaskInput {
  if (!form.name.trim()) throw new Error('请填写任务名称');
  if (!form.shopId) throw new Error('请选择真实店铺账号');
  const productIds = form.scope === 'selected' ? validateIds(productText.value, '指定商品') : [];
  if (form.scope === 'selected' && !productIds.length) throw new Error('指定商品范围至少需要一个有效商品 ID');
  if (form.schedule.kind === 'weekly' && !form.schedule.days.length) throw new Error('每周计划至少选择一天');
  if (form.schedule.kind !== 'manual' && !/^\d{2}:\d{2}$/.test(form.schedule.time)) throw new Error('请设置计划运行时间');
  if (!form.rules.length) throw new Error('请至少添加一组预警条件');
  if (form.rules.some(group => !group.conditions.length || group.conditions.some(condition => !condition.value.trim()))) throw new Error('请填写全部规则值，并移除空条件组');
  return JSON.parse(JSON.stringify({ ...form, name: form.name.trim(), productIds, whitelist: whitelist() }));
}
async function save() { await act(async () => { const body = payload(); if (editing.value) await patch(`/tasks/${editing.value}`, body); else await post('/tasks', body); await router.push('/tasks'); }, '任务已保存，配置将在下次执行生效'); }
async function previewWhitelist() { if (!editing.value) { error.value = '请先保存任务，再预览当前数据库中的白名单命中'; return; } await act(async () => { preview.value = await post(`/tasks/${editing.value}/whitelist/preview`, whitelist()); }); }
onMounted(async () => {
  await act(async () => { const result = await get<{ shops: Shop[] }>('/shops'); shops.value = result.shops;
    if (editing.value) { const result = await get<{ tasks: MonitorTask[] }>('/tasks'); const task = result.tasks.find(item => item.id === editing.value); if (!task) throw new Error('该任务不存在或已删除'); const { id, version, createdAt, updatedAt, nextRunAt, ...input } = task; Object.assign(form, input); productText.value = task.productIds.join('\n'); whiteIdText.value = task.whitelist.productIds.join('\n'); whiteKeywordText.value = task.whitelist.titleKeywords.join('\n'); }
    else if (shops.value.length === 1) form.shopId = shops.value[0]!.id;
  }); loading.value = false;
});
</script>
<template><div class="editor-width" v-loading="loading"><PageHeader :title="editing ? '编辑监控任务' : '新建监控任务'" description="规则和白名单在执行开始时固定为快照，历史报告不会随配置修改。"><el-button @click="$router.push('/tasks')">返回列表</el-button><el-button type="primary" :loading="busy" @click="save">保存任务</el-button></PageHeader><ErrorBanner :message="error" /><el-form label-position="top"><section class="panel"><div class="panel-head"><h2>01 · 基本信息</h2><el-switch v-model="form.enabled" active-text="启用任务" /></div><div class="panel-body"><div class="split-layout"><el-form-item label="任务名称" required><el-input v-model="form.name" maxlength="100" placeholder="如：全店低于 8.5 折" /></el-form-item><el-form-item label="绑定店铺" required><el-select v-model="form.shopId" class="full-width" :disabled="!!editing" placeholder="请选择店铺"><el-option v-for="shop in shops" :key="shop.id" :value="shop.id" :label="`${shop.name}${shop.enabled ? '' : '（已停用）'}`" /></el-select></el-form-item></div><el-empty v-if="!shops.length && !loading" description="还没有店铺账号，请先连接店铺。"><el-button @click="$router.push('/shops')">连接店铺</el-button></el-empty><el-form-item label="采集范围"><el-radio-group v-model="form.scope"><el-radio value="all">全店在售商品（每次重新发现）</el-radio><el-radio value="selected">指定商品</el-radio></el-radio-group></el-form-item><el-form-item v-if="form.scope === 'selected'" label="商品 ID 或链接"><el-input v-model="productText" type="textarea" :rows="5" placeholder="每行一个 ID 或淘宝/天猫商品链接，自动去重；采集时核验商品所属店铺" /><span class="form-hint">有效 {{ parseIds(productText).ids.length }} 个，待修正 {{ parseIds(productText).invalid.length }} 项</span></el-form-item></div></section><section class="panel"><div class="panel-head"><h2>02 · 预警条件</h2><span class="muted">按 SKU 判断，保留全部触发原因</span></div><div class="panel-body"><RuleEditor v-model="form.rules" /><p v-if="!form.rules.length" class="pill-note">请至少添加一组预警条件后保存任务。</p></div></section><section class="panel"><div class="panel-head"><h2>03 · 任务白名单</h2><el-button :disabled="!editing" :loading="busy" @click="previewWhitelist">预览数据库命中</el-button></div><div class="panel-body"><div class="split-layout"><el-form-item label="排除商品 ID / 链接"><el-input v-model="whiteIdText" type="textarea" :rows="5" placeholder="每行一个，精确排除该商品全部 SKU" /></el-form-item><el-form-item label="排除标题关键词"><el-input v-model="whiteKeywordText" type="textarea" :rows="5" placeholder="每行一个普通文本关键词，如：自由岛；任意一条包含即排除" /></el-form-item></div><div class="pill-note">白名单商品仍会采集、入库和保留历史，仅本任务不生成报警。编辑文本可批量新增或移除规则。</div><div v-if="preview" style="margin-top:16px"><p class="section-title">命中 {{ preview.count }} 个商品（展示部分）</p><el-table :data="preview.products" max-height="260" empty-text="当前数据库没有命中商品"><el-table-column prop="productId" label="商品 ID" width="190" /><el-table-column prop="title" label="标题" /></el-table></div></div></section><section class="panel"><div class="panel-head"><h2>04 · 执行计划与通知</h2></div><div class="panel-body"><el-form-item label="运行频率"><el-radio-group v-model="form.schedule.kind"><el-radio-button value="manual">手动运行</el-radio-button><el-radio-button value="daily">每天</el-radio-button><el-radio-button value="weekly">每周</el-radio-button></el-radio-group></el-form-item><el-form-item v-if="form.schedule.kind === 'weekly'" label="星期"><el-checkbox-group v-model="form.schedule.days"><el-checkbox v-for="(day, index) in ['周日', '周一', '周二', '周三', '周四', '周五', '周六']" :key="index" :value="index">{{ day }}</el-checkbox></el-checkbox-group></el-form-item><el-form-item v-if="form.schedule.kind !== 'manual'" label="执行时间（Asia/Shanghai）"><el-input v-model="form.schedule.time" type="time" style="width:180px" /></el-form-item><el-form-item label="Server酱汇总通知"><el-switch v-model="form.notify" active-text="执行完成后发送汇总" /><span class="form-hint">需要在系统设置中配置并启用 Server酱 SendKey。投递失败可在执行记录独立重发。</span></el-form-item></div></section></el-form><div class="header-actions"><el-button @click="$router.push('/tasks')">返回列表</el-button><el-button type="primary" :loading="busy" @click="save">保存任务</el-button></div></div></template>
