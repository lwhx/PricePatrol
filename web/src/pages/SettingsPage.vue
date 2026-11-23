<script setup lang="ts">
import { ref, reactive, onMounted } from 'vue';
import type { NotificationSettings } from '../../../shared/contracts.js';
import { get, post, request } from '../api/client';
import { useFeedback } from '../composables/useFeedback';
import PageHeader from '../components/PageHeader.vue';
import ErrorBanner from '../components/ErrorBanner.vue';
import MaintenancePanel from '../components/MaintenancePanel.vue';
interface Settings { notification: NotificationSettings; retentionDays: number; timezone: string }
const settings = ref<Settings | null>(null), keyMode = ref<'keep' | 'replace' | 'clear'>('keep'), sendKey = ref('');
const form = reactive({ notificationEnabled: false });
const { busy, error, act } = useFeedback();
function applySettings(result: Settings) { settings.value = result; form.notificationEnabled = result.notification.enabled; }
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
onMounted(refresh);
</script>
<template><div class="editor-width"><PageHeader title="系统设置" description="配置 Server酱通知、历史保留与数据库备份。敏感凭据保存后不回显。"><el-button :loading="busy" @click="refresh">重新读取</el-button><el-button type="primary" :loading="busy" @click="save">保存设置</el-button></PageHeader><ErrorBanner :message="error" /><section class="panel"><div class="panel-head"><div><h2>Server酱通知</h2><p>监控任务完成后发送汇总，通知失败可独立重试。</p></div><el-switch v-model="form.notificationEnabled" active-text="启用通知" /></div><div class="panel-body"><div class="key-status"><el-tag :type="settings?.notification.hasSendKey ? 'success' : 'info'" effect="plain">{{ settings?.notification.hasSendKey ? '已保存 SendKey' : '尚未配置 SendKey' }}</el-tag><span class="muted">支持 SCT 与 Server酱 3（sctp…）SendKey</span></div><el-form label-position="top"><el-form-item label="SendKey 保存方式"><el-radio-group v-model="keyMode" @change="sendKey = ''"><el-radio value="keep">保留已保存密钥</el-radio><el-radio value="replace">更新密钥</el-radio><el-radio value="clear">清除密钥</el-radio></el-radio-group></el-form-item><el-form-item v-if="keyMode === 'replace'" label="新的 SendKey"><el-input v-model="sendKey" type="password" show-password autocomplete="off" placeholder="输入 SCT… 或 sctp… 密钥" style="max-width:620px" /><span class="form-hint">保存完成后立即清空输入框；后端仅返回是否已配置。</span></el-form-item></el-form><ErrorBanner :message="settings?.notification.lastError || ''" /><div class="toolbar" style="padding:0;border:0"><el-button :loading="busy" :disabled="!settings?.notification.hasSendKey" @click="test">发送真实测试通知</el-button><span class="muted">测试使用已保存配置；修改后请先保存。</span></div></div></section><section class="panel"><div class="panel-head"><h2>运行时区</h2></div><div class="panel-body"><p>任务调度使用 {{ settings?.timezone || 'Asia/Shanghai' }}；筛选时间按浏览器所在时区显示并转换后查询。</p></div></section><MaintenancePanel /></div></template>
