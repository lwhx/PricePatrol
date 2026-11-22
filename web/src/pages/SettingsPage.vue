<script setup lang="ts">
import { ref, reactive, onMounted } from 'vue';
import type { NotificationSettings } from '../../../shared/contracts.js';
import { get, post, request, download } from '../api/client';
import { useFeedback, confirmAction } from '../composables/useFeedback';
import PageHeader from '../components/PageHeader.vue';
import ErrorBanner from '../components/ErrorBanner.vue';
interface Settings { notification: NotificationSettings; retentionDays: number; timezone: string }
const settings = ref<Settings | null>(null), keyMode = ref<'keep' | 'replace' | 'clear'>('keep'), sendKey = ref(''), cleanupBefore = ref('');
const form = reactive({ notificationEnabled: false, retentionDays: 180 });
const { busy, error, act } = useFeedback();
const cleanupCount = ref<number | null>(null);
function applySettings(result: Settings) { settings.value = result; form.notificationEnabled = result.notification.enabled; form.retentionDays = result.retentionDays; }
async function refresh() { await act(async () => { applySettings(await get<Settings>('/settings')); }); }
async function save() {
  if (keyMode.value === 'replace' && !sendKey.value.trim()) { error.value = '请输入新的 SendKey，或选择保留/清除'; return; }
  const action = keyMode.value;
  await act(async () => {
    const body = { ...form, ...(action === 'keep' ? {} : { sendKey: action === 'clear' ? '' : sendKey.value.trim() }) };
    try { applySettings(await request<Settings>('/settings', { method: 'PUT', body })); keyMode.value = 'keep'; }
    finally { sendKey.value = ''; }
  }, '设置已保存，SendKey 不回显');
}
async function test() { await act(async () => { await post('/notifications/test'); }, 'Server酱已接受真实测试消息，请在通知接收端查看'); }
async function backup() { await act(() => download('/maintenance/backup', 'POST', 'price-monitor-backup.sqlite'), '一致性备份已下载'); }
async function cleanup() {
  if (!cleanupBefore.value) { error.value = '请选择清理截止日期'; return; }
  if (!await confirmAction(`清理 ${cleanupBefore.value} 之前的历史价格？预警关联证据由服务端保护，请先下载备份。`)) return;
  const result = await act(() => post<{ deleted: number }>('/maintenance/cleanup', { before: new Date(`${cleanupBefore.value}T00:00:00+08:00`).toISOString() }));
  if (result) cleanupCount.value = result.deleted;
}
onMounted(refresh);
</script>
<template><div class="editor-width"><PageHeader title="系统设置" description="配置 Server酱通知、历史保留与数据库备份。敏感凭据保存后不回显。"><el-button :loading="busy" @click="refresh">重新读取</el-button><el-button type="primary" :loading="busy" @click="save">保存设置</el-button></PageHeader><ErrorBanner :message="error" /><section class="panel"><div class="panel-head"><div><h2>Server酱通知</h2><p>监控任务完成后发送汇总，通知失败可独立重试。</p></div><el-switch v-model="form.notificationEnabled" active-text="启用通知" /></div><div class="panel-body"><div class="key-status"><el-tag :type="settings?.notification.hasSendKey ? 'success' : 'info'" effect="plain">{{ settings?.notification.hasSendKey ? '已保存 SendKey' : '尚未配置 SendKey' }}</el-tag><span class="muted">支持 SCT 与 Server酱 3（sctp…）SendKey</span></div><el-form label-position="top"><el-form-item label="SendKey 保存方式"><el-radio-group v-model="keyMode" @change="sendKey = ''"><el-radio value="keep">保留已保存密钥</el-radio><el-radio value="replace">更新密钥</el-radio><el-radio value="clear">清除密钥</el-radio></el-radio-group></el-form-item><el-form-item v-if="keyMode === 'replace'" label="新的 SendKey"><el-input v-model="sendKey" type="password" show-password autocomplete="off" placeholder="输入 SCT… 或 sctp… 密钥" style="max-width:620px" /><span class="form-hint">保存完成后立即清空输入框；后端仅返回是否已配置。</span></el-form-item></el-form><ErrorBanner :message="settings?.notification.lastError || ''" /><div class="toolbar" style="padding:0;border:0"><el-button :loading="busy" :disabled="!settings?.notification.hasSendKey" @click="test">发送真实测试通知</el-button><span class="muted">测试使用已保存配置；修改后请先保存。</span></div></div></section><section class="panel"><div class="panel-head"><h2>数据保留与运行时区</h2></div><div class="panel-body"><el-form label-position="top"><div class="split-layout"><el-form-item label="历史保留天数"><el-input-number v-model="form.retentionDays" :min="7" :max="3650" /><span class="form-hint">预警关联证据保留到明确清理，不随删除任务清空。</span></el-form-item><el-form-item label="调度时区"><el-input :model-value="settings?.timezone || 'Asia/Shanghai'" disabled /><span class="form-hint">所有任务计划与界面时间统一使用当前配置时区。</span></el-form-item></div></el-form></div></section><section class="panel"><div class="panel-head"><h2>数据库备份</h2><el-button type="primary" plain :loading="busy" @click="backup">下载一致性 SQLite 备份</el-button></div><div class="panel-body"><p class="muted" style="margin:0">备份由服务端使用 SQLite 一致性机制生成，包含运行中的已提交数据。恢复时需要同时保留部署使用的原加密密钥，以解密账号凭据。请将数据库备份和密钥分别妥善保管。</p></div></section><section class="panel"><div class="panel-head"><h2>历史清理</h2><el-tag type="warning" effect="plain">建议先备份</el-tag></div><div class="panel-body"><p class="muted">删除指定日期之前可清理的历史记录，服务端保护预警关联证据。此操作会实际删除数据。</p><div class="remote-tools"><el-input v-model="cleanupBefore" type="date" style="max-width:250px" /><el-button type="danger" plain :loading="busy" @click="cleanup">清理历史记录</el-button></div><div v-if="cleanupCount !== null" class="pill-note">本次已删除 {{ cleanupCount }} 条历史记录。</div></div></section></div></template>
