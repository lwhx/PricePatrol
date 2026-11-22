<script setup lang="ts">
import { ref, onUnmounted, onMounted } from 'vue';
import type { Platform } from '../../../shared/contracts.js';
import { get, post, remove } from '../api/client';
import { useFeedback } from '../composables/useFeedback';
import ErrorBanner from './ErrorBanner.vue';
const props = defineProps<{ platform: Platform }>();
const emit = defineEmits<{ complete: []; close: [] }>();
const { busy, error, act } = useFeedback();
const sessionId = ref(''), screenshot = ref(''), text = ref(''), name = ref(''), image = ref<HTMLImageElement>();
const dragFrom = ref<{x: number; y: number} | null>(null);
let timer: ReturnType<typeof setInterval> | undefined, refreshing = false, closed = false;
async function refresh() {
  if (!sessionId.value || refreshing || closed) return;
  refreshing = true;
  try {
    const response = await fetch(`/api/login-sessions/${sessionId.value}/screenshot?t=${Date.now()}`, { credentials: 'include' });
    if (!response.ok) { const failure = await response.json().catch(() => ({})); throw new Error(failure.error || `获取截图失败（${response.status}）`); }
    const url = URL.createObjectURL(await response.blob());
    if (closed) { URL.revokeObjectURL(url); return; }
    if (screenshot.value) URL.revokeObjectURL(screenshot.value); screenshot.value = url; error.value = '';
  } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); }
  finally { refreshing = false; }
}
async function start() {
  await act(async () => {
    const result = await post<{ id: string }>('/login-sessions', { platform: props.platform });
    if (closed) { await remove(`/login-sessions/${result.id}`); return; }
    sessionId.value = result.id; await refresh(); timer = setInterval(() => { if (!document.hidden) void refresh(); }, 2500);
  });
}
async function action(body: object) { if (!sessionId.value) return; await act(async () => { await post(`/login-sessions/${sessionId.value}/action`, body); await refresh(); }); }
function toPagePoint(event: MouseEvent): {x: number; y: number} | null {
  const element = image.value; if (!element) return null;
  const bounds = element.getBoundingClientRect();
  return {
    x: Math.round((event.clientX - bounds.left) * element.naturalWidth / bounds.width),
    y: Math.round((event.clientY - bounds.top) * element.naturalHeight / bounds.height),
  };
}
function click(event: MouseEvent) {
  if (!image.value || busy.value || dragFrom.value) return;
  const point = toPagePoint(event); if (point) void action({ type: 'click', x: point.x, y: point.y });
}
// 拖拽（滑块验证）：在截图上按下 → 拖动 → 松开，松开处即终点。
function dragStart(event: MouseEvent) {
  if (!sessionId.value || busy.value) return;
  const point = toPagePoint(event); if (point) { dragFrom.value = point; event.preventDefault(); }
}
function dragEnd(event: MouseEvent) {
  const from = dragFrom.value; dragFrom.value = null;
  if (!from) return;
  const to = toPagePoint(event); if (!to) return;
  if (Math.abs(to.x - from.x) < 3 && Math.abs(to.y - from.y) < 3) { void action({ type: 'click', x: from.x, y: from.y }); return; }
  void action({ type: 'drag', x: from.x, y: from.y, x2: to.x, y2: to.y });
}
async function typeText() { const value = text.value; text.value = ''; await action({ type: 'type', text: value }); }
async function complete() { await act(async () => { await post(`/login-sessions/${sessionId.value}/complete`, { name: name.value || undefined, platform: props.platform }); emit('complete'); }, '登录会话已通过真实店铺核验并保存'); }
function close() { emit('close'); }
onMounted(start);
onUnmounted(() => { closed = true; if (timer) clearInterval(timer); if (screenshot.value) URL.revokeObjectURL(screenshot.value); if (sessionId.value) void remove(`/login-sessions/${sessionId.value}`).catch(() => undefined); });
</script>
<template><el-dialog :model-value="true" title="网页登录辅助" width="1100px" :close-on-click-modal="false" @close="close"><p class="muted">当前为服务端真实浏览器。点击截图定位输入框，再通过下方输入文字；<b>滑块验证请在截图上按住滑块拖到最右后松开</b>；也可手动扫码。保存时会重新核验店铺身份与权限。</p><ErrorBanner :message="error" /><div class="login-screen" v-loading="busy && !screenshot"><img v-if="screenshot" ref="image" :src="screenshot" alt="远程登录浏览器截图，点击可操作，拖动可拉滑块" :class="{ dragging: !!dragFrom }" @click="click" @mousedown="dragStart" @mouseup="dragEnd" /><el-empty v-else description="等待浏览器启动与截图" /></div><div class="remote-tools"><el-input v-model="text" type="password" show-password placeholder="先点击截图中的输入框，再输入内容" @keyup.enter="typeText" /><el-button :disabled="!sessionId || !text" :loading="busy" @click="typeText">输入文字</el-button><el-button :disabled="!sessionId || busy" @click="action({ type: 'press', key: 'Enter' })">Enter</el-button><el-button :disabled="!sessionId || busy" @click="action({ type: 'press', key: 'Tab' })">Tab</el-button><el-button :disabled="!sessionId || busy" @click="action({ type: 'press', key: 'Backspace' })">退格</el-button><el-button :disabled="!sessionId" @click="refresh">刷新截图</el-button></div><el-input v-model="name" placeholder="店铺备注名称（可选，真实身份以核验结果为准）" /><template #footer><el-button @click="close">关闭会话</el-button><el-button v-if="!sessionId" @click="start" :loading="busy">重新启动</el-button><el-button type="primary" :disabled="!sessionId" :loading="busy" @click="complete">已完成登录，核验并保存</el-button></template></el-dialog></template>
