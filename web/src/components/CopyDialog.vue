<script setup lang="ts">
import { ref, reactive, computed, watch, onUnmounted } from 'vue';
import { ElMessage } from 'element-plus';
import type { QueryInput, ExportInput, ExportResult } from '../../../shared/contracts.js';
import type { ExportSubmission, ExportJob } from '../../../shared/export-jobs.js';
import { get, post, remove, download, downloadStream } from '../api/client';
import { useFeedback } from '../composables/useFeedback';
import { usePolling } from '../composables/usePolling';
import { dateTime } from '../lib/format';
import { readPreference, writePreference } from '../lib/preferences';
import { exportFields, defaultFields, orderedFields, moveField } from '../lib/exportFields';
import ErrorBanner from './ErrorBanner.vue';
const props = defineProps<{ query: QueryInput; selectedIds: string[]; total: number }>();
const emit = defineEmits<{ close: [] }>();
const defaults = { fields: defaultFields, format: 'tsv' as ExportInput['format'], header: true, separator: '\t' };
const saved = readPreference('copy-options', defaults);
const options = reactive({ ...defaults, ...saved, fields: orderedFields(saved.fields), scope: (props.selectedIds.length ? 'selected' : 'all') as ExportInput['scope'], allSkus: false });
const snapshot = ref<ExportResult | null>(null), manual = ref(false), dragIndex = ref(-1);
const job = ref<ExportJob | null>(null), lastJobId = ref(readPreference<string | null>('last-export-job', null));
const jobRunning = computed(() => !!job.value && ['queued', 'running'].includes(job.value.status));
const downloadable = computed(() => !!snapshot.value || job.value?.status === 'ready');
const jobLabels = { queued: '等待导出', running: '正在后台生成', ready: '文件已就绪', failed: '导出失败', cancelled: '已取消' };
const { busy, error, act } = useFeedback();
const fieldKeys = computed(() => exportFields.map(([key]) => key));
const labels = Object.fromEntries(exportFields);
const formats: [ExportInput['format'], string][] = [['ids', '仅商品 ID'], ['titles', '仅商品标题'], ['id-title', 'ID＋标题'], ['tsv', 'Excel / 飞书 TSV'], ['csv', 'CSV'], ['text', '自定义文本'], ['json', 'JSON'], ['markdown', 'Markdown 表格']];
let sequence = 0, jobSequence = 0;
watch(options, () => { sequence++; jobSequence++; snapshot.value = null; job.value = null; manual.value = false; error.value = ''; }, { deep: true });
onUnmounted(() => { sequence++; jobSequence++; });
async function refreshJob() {
  const prior = job.value; if (!prior || !jobRunning.value || busy.value) return;
  const current = ++jobSequence;
  try { const result = await get<{job: ExportJob}>(`/export-jobs/${prior.id}`); if (current === jobSequence && job.value?.id === prior.id) job.value = result.job; }
  catch (cause) { if (current === jobSequence) { error.value = cause instanceof Error ? cause.message : '无法读取导出进度'; if (cause && typeof cause === 'object' && 'status' in cause && cause.status === 404) job.value = {...prior,status:'failed',error:error.value}; } }
}
usePolling(refreshJob, 2000);
async function generate() {
  const current = ++sequence;
  jobSequence++; job.value = null; snapshot.value = null; manual.value = false;
  await act(async () => {
    if (!['ids', 'titles', 'id-title'].includes(options.format) && !options.fields.length) throw new Error('请至少选择一个输出字段');
    if (options.scope === 'selected' && !props.selectedIds.length) throw new Error('当前没有勾选行');
    writePreference('copy-options', { fields: options.fields, format: options.format, header: options.header, separator: options.separator });
    const likelyLarge = options.scope === 'all' ? props.total > 2000 : options.scope === 'selected' ? props.selectedIds.length > 2000 : false;
    const result = await post<ExportSubmission>('/exports', { query: props.query, ...options, ...(likelyLarge ? { mode: 'file' } : {}), selectedIds: props.selectedIds, header: ['ids', 'titles', 'id-title'].includes(options.format) ? false : options.header, fields: options.format === 'ids' ? ['productId'] : options.format === 'titles' ? ['title'] : options.format === 'id-title' ? ['productId', 'title'] : options.fields, separator: options.separator.replace(/\\t/g, '\t').replace(/\\n/g, '\n') });
    if ('job' in result) { lastJobId.value = result.job.id; writePreference('last-export-job', result.job.id); if (current === sequence) job.value = result.job; }
    else if (current === sequence) snapshot.value = result;
  });
  await refreshJob();
}
async function copy() {
  if (!snapshot.value) return;
  if (snapshot.value.downloadRecommended) { error.value = '该快照超过建议复制上限，请下载完整结果。'; return; }
  try { await navigator.clipboard.writeText(snapshot.value.content); manual.value = false; ElMessage.success('完整快照已复制'); }
  catch { manual.value = true; error.value = '浏览器未授予剪贴板权限，请在下方文本框中全选后手动复制。'; }
}
async function restoreJob() {
  if (!lastJobId.value) return;
  const current = ++sequence; jobSequence++;
  await act(async () => { const result = await get<{job: ExportJob}>(`/export-jobs/${lastJobId.value}`); if (current === sequence) { job.value = result.job; snapshot.value = null; manual.value = false; } });
}
async function cancelJob() {
  const prior = job.value; if (!prior) return;
  jobSequence++;
  await act(async () => { const result = await remove<{job: ExportJob}>(`/export-jobs/${prior.id}`); if (job.value?.id === prior.id) job.value = result.job; }, '导出任务已取消');
}
async function save() {
  const result = snapshot.value, file = job.value;
  if (file) await act(async () => { const fresh = (await get<{job: ExportJob}>(`/export-jobs/${file.id}`)).job; if (job.value?.id === file.id) job.value = fresh; if (fresh.status !== 'ready') throw new Error('文件尚未就绪或已失效，请重新生成'); await downloadStream(`/export-jobs/${file.id}/download`, fresh.filename); }, '文件下载已开始');
  else if (result) await act(() => download(`/exports/${result.token}/download`, 'GET', result.filename));
}
function toggleFields(value: unknown) { options.fields = orderedFields(value as string[]); }
function drop(index: number) { options.fields = moveField(options.fields, dragIndex.value, index); dragIndex.value = -1; }
</script>
<template><el-dialog :model-value="true" title="复制与导出" width="980px" :close-on-click-modal="false" @close="emit('close')"><ErrorBanner :message="error" /><el-form label-position="top"><div class="split-layout"><el-form-item label="行范围"><el-select v-model="options.scope" class="full-width"><el-option value="selected" :label="`勾选行（${selectedIds.length}）`" :disabled="!selectedIds.length" /><el-option value="page" label="当前页" /><el-option value="all" :label="`全部筛选结果（${total}）`" /></el-select></el-form-item><el-form-item label="输出格式"><el-select v-model="options.format" class="full-width"><el-option v-for="[value, label] in formats" :key="value" :value="value" :label="label" /></el-select></el-form-item></div><el-form-item v-if="query.view === 'product'" label="商品展开方式"><el-radio-group v-model="options.allSkus"><el-radio :value="false">仅原查询命中的 SKU</el-radio><el-radio :value="true">所选商品的全部 SKU</el-radio></el-radio-group></el-form-item><template v-if="!['ids', 'titles', 'id-title'].includes(options.format)"><div class="toolbar" style="padding:0 0 12px;border:0"><strong class="section-title" style="margin:0">独立选择输出字段</strong><span class="spacer" /><el-button text type="primary" @click="options.fields = [...fieldKeys]">全选</el-button><el-button text @click="options.fields = []">清空</el-button><el-button text @click="options.fields = [...defaultFields]">默认字段</el-button></div><el-checkbox-group :model-value="options.fields" @update:model-value="toggleFields"><el-checkbox v-for="[value, label] in exportFields" :key="value" :value="value">{{ label }}</el-checkbox></el-checkbox-group><p class="form-hint">输出顺序（拖动下方字段或用箭头调整；与表格可见列互不影响）</p><div class="field-list" data-test="ordered-fields"><div v-for="(field, index) in options.fields" :key="field" class="field-chip" draggable="true" @dragstart="dragIndex = index" @dragover.prevent @drop.prevent="drop(index)"><span>{{ index + 1 }}. {{ labels[field] }}</span><button :disabled="index === 0" title="前移" @click="options.fields = moveField(options.fields, index, index - 1)">←</button><button :disabled="index === options.fields.length - 1" title="后移" @click="options.fields = moveField(options.fields, index, index + 1)">→</button></div><span v-if="!options.fields.length" class="muted">请选择输出字段</span></div><div class="remote-tools"><el-checkbox v-model="options.header">包含表头</el-checkbox><el-input v-if="options.format === 'text'" v-model="options.separator" style="max-width:240px" placeholder="自定义分隔符，支持 \t 和 \n" /></div></template></el-form><p class="muted">预览、计数、复制和下载使用同一固定数据快照。只选商品字段时按店铺＋商品去重；包含 SKU 字段时保留明细。长 ID 在 Excel 中请按文本导入。</p><el-button type="primary" plain :loading="busy" :disabled="jobRunning" @click="generate">{{ snapshot || job ? '重新生成快照' : '生成快照与预览' }}</el-button><el-button v-if="lastJobId && job?.id !== lastJobId" :disabled="busy" @click="restoreJob">查看上次后台导出</el-button><div v-if="job" class="pill-note" data-test="export-job"><strong>{{ jobLabels[job.status] }}</strong> · 任务 {{ job.id }}<p v-if="jobRunning">后台正在按同一数据库快照生成文件。关闭窗口后可通过“查看上次后台导出”继续查看。</p><p v-if="job.error" class="danger-text">{{ job.error }}</p><template v-if="job.status === 'ready'"><div class="copy-meta"><span>源行 {{ job.sourceCount }}</span><span>输出 {{ job.rowCount }} 行</span><span>{{ (job.bytes / 1024).toFixed(1) }} KiB</span></div><p>可下载至 {{ dateTime(job.expiresAt) }}。以下为有限预览，完整内容在下载文件中。</p><pre class="text-preview">{{ job.preview || '查询结果为空' }}</pre></template><el-button v-if="jobRunning" :loading="busy" @click="cancelJob">取消后台导出</el-button></div><template v-if="snapshot"><div class="copy-meta"><span>源行 {{ snapshot.sourceCount }}</span><span>输出 {{ snapshot.rowCount }} 行</span><span>{{ (snapshot.bytes / 1024).toFixed(1) }} KiB</span><span>快照 {{ snapshot.token.slice(0, 8) }}</span></div><el-alert v-if="snapshot.downloadRecommended" title="结果较大，请下载完整快照；不会静默截断。" type="warning" show-icon :closable="false" /><pre class="text-preview">{{ snapshot.preview || '查询结果为空' }}</pre><el-input v-if="manual" :model-value="snapshot.content" type="textarea" :rows="8" readonly aria-label="手动复制完整结果" @focus="(e: FocusEvent) => (e.target as HTMLTextAreaElement).select()" /></template><template #footer><el-button @click="emit('close')">关闭</el-button><el-button :disabled="!downloadable || busy" :loading="busy" @click="save">下载同一快照</el-button><el-button type="primary" :disabled="!snapshot || snapshot.downloadRecommended" @click="copy">复制完整结果</el-button></template></el-dialog></template>
