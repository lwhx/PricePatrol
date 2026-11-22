<script setup lang="ts">
import { ref, reactive, onMounted } from 'vue';
import type { Shop, Platform } from '../../../shared/contracts.js';
import { get, post, patch, remove } from '../api/client';
import { dateTime } from '../lib/format';
import { parseCookieImport } from '../lib/cookie-import';
import { useFeedback, confirmAction } from '../composables/useFeedback';
import { useLatest } from '../composables/useLatest';
import PageHeader from '../components/PageHeader.vue';
import ErrorBanner from '../components/ErrorBanner.vue';
import StatusTag from '../components/StatusTag.vue';
import RemoteLogin from '../components/RemoteLogin.vue';
const shops = ref<Shop[]>([]), dialog = ref(false), login = ref(false), editing = ref<Shop | null>(null);
const form = reactive({ name: '', platform: 'tmall' as Platform, cookies: '', userAgent: '', appKey: '' });
const { busy, error, act } = useFeedback(); const resource = useLatest();
async function refresh() { await resource.load(() => get<{ shops: Shop[] }>('/shops'), result => { shops.value = result.shops; }); }
function open(shop?: Shop) { editing.value = shop || null; Object.assign(form, { name: shop?.name || '', platform: shop?.platform || 'tmall', cookies: '', userAgent: '', appKey: '' }); error.value = ''; dialog.value = true; }

async function save() {
  await act(async () => {
    const imported = parseCookieImport(form.cookies);
    const cookies = imported.cookies; if (!editing.value && !cookies) throw new Error('请导入 Cookie 字符串、JSON 数组或完整导入包');
    const body = { name: form.name || undefined, cookies, userAgent: form.userAgent.trim() || imported.userAgent, appKey: form.appKey.trim() || imported.appKey };
    if (editing.value) await patch(`/shops/${editing.value.id}`, body); else await post('/shops', { ...body, platform: imported.platform || form.platform });
    form.cookies = ''; form.userAgent = ''; form.appKey = ''; dialog.value = false; await refresh();
  }, '账号已核验并保存');
}
async function verify(shop: Shop) { await act(async () => { await post(`/shops/${shop.id}/verify`); await refresh(); }, '真实店铺与商品权限核验通过'); }
async function toggle(shop: Shop) { await act(async () => { await patch(`/shops/${shop.id}`, { enabled: !shop.enabled }); await refresh(); }, '账号状态已更新'); }
async function collect(shop: Shop) { if (!await confirmAction(`将为「${shop.name}」全店获取最新价格并写入数据库。本次为手动采集，不触发预警或自动汇总。是否开始？`)) return; await act(async () => { await post(`/shops/${shop.id}/collect`, {}); }, '手动采集已创建，可前往采集任务页查看进度'); }
async function deleteShop(shop: Shop) { if (!await confirmAction(`删除「${shop.name}」？服务端会停用此账号，历史价格与预警证据保持不变。`)) return; await act(async () => { await remove(`/shops/${shop.id}`); await refresh(); }, '账号已停用，历史证据保留'); }
function remoteComplete() { login.value = false; void refresh(); }
onMounted(refresh);
</script>
<template><div><PageHeader title="店铺账号" description="每个账号绑定一家真实店铺。导入、更新和登录均核验商家身份与商品权限。"><el-button :loading="resource.loading.value" @click="refresh">刷新</el-button><el-dropdown @command="(v: Platform) => { form.platform = v; login = true; }"><el-button plain>网页登录 ▾</el-button><template #dropdown><el-dropdown-menu><el-dropdown-item command="tmall">天猫网页登录</el-dropdown-item><el-dropdown-item command="taobao">淘宝网页登录</el-dropdown-item></el-dropdown-menu></template></el-dropdown><el-button type="primary" @click="open()">＋ 导入账号 Cookie</el-button></PageHeader><ErrorBanner :message="error || resource.error.value" /><section class="panel"><div class="panel-head"><h2>已连接账号 <span class="muted">{{ shops.length }}</span></h2><span class="muted">凭据加密存储，Cookie 不回显</span></div><el-table :data="shops" v-loading="resource.loading.value" row-key="id" empty-text="暂无店铺账号。点击“导入账号 Cookie”或“网页登录”开始连接。"><el-table-column label="店铺 / 商家身份" min-width="210"><template #default="{ row }"><strong>{{ row.name }}</strong><div class="cell-sub">Seller ID · {{ row.sellerId }}</div></template></el-table-column><el-table-column label="平台" width="90"><template #default="{ row }"><el-tag size="small" :type="row.platform === 'tmall' ? 'danger' : 'warning'">{{ row.platform === 'tmall' ? '天猫' : '淘宝' }}</el-tag></template></el-table-column><el-table-column label="会话" width="140"><template #default="{ row }"><StatusTag :value="row.sessionStatus" /><div class="cell-sub">{{ row.enabled ? '账号已启用' : '账号已停用' }}</div></template></el-table-column><el-table-column label="最近核验 / 错误" min-width="230"><template #default="{ row }">{{ dateTime(row.lastVerifiedAt) }}<div class="cell-sub">{{ row.lastError || '暂无错误' }}</div></template></el-table-column><el-table-column label="操作" min-width="310" fixed="right"><template #default="{ row }"><el-button text type="primary" :disabled="busy" @click="verify(row)">{{ row.sessionStatus === 'auth_required' ? '重新核验' : '核验' }}</el-button><el-button text type="primary" @click="open(row)">更新凭据</el-button><el-button text :disabled="busy || !row.enabled" @click="collect(row)" title="手动采集，只更新价格，不触发预警">采集全店</el-button><el-button text :disabled="busy" @click="toggle(row)">{{ row.enabled ? '停用' : '启用' }}</el-button><el-button text type="danger" :disabled="busy" @click="deleteShop(row)">停用并移除</el-button></template></el-table-column></el-table></section><div class="pill-note">Cookie 失效后需要重新登录或导入。平台的令牌续签不会自动重新登录商家账号；会话错误会保留在此页面。</div><el-dialog v-model="dialog" :title="editing ? '更新店铺凭据' : '导入店铺账号'" width="650px" :close-on-click-modal="false" @closed="form.cookies = ''"><ErrorBanner :message="error" /><el-form label-position="top" @submit.prevent="save"><el-form-item label="备注名称（可选）"><el-input v-model="form.name" placeholder="真实店铺身份由平台核验" /></el-form-item><el-form-item label="平台"><el-radio-group v-model="form.platform" :disabled="!!editing"><el-radio-button value="tmall">天猫</el-radio-button><el-radio-button value="taobao">淘宝</el-radio-button></el-radio-group></el-form-item><el-form-item :label="editing ? '更新 Cookie（留空保留原凭据）' : 'Cookie 字符串 / JSON 数组 / 完整导入包'"><el-input v-model="form.cookies" type="textarea" :rows="7" placeholder='name=value; name2=value2 或 [{"name":"...","value":"...","domain":".taobao.com"}]' /></el-form-item><div class="split-layout"><el-form-item label="User-Agent（可选）"><el-input v-model="form.userAgent" /></el-form-item><el-form-item label="App Key（可选）"><el-input v-model="form.appKey" /></el-form-item></div><p class="muted">保存会发起真实核验。更新 Cookie 不允许将其他店铺身份覆盖到当前账号。</p></el-form><template #footer><el-button @click="dialog = false">取消</el-button><el-button type="primary" :loading="busy" @click="save">核验并保存</el-button></template></el-dialog><RemoteLogin v-if="login" :platform="form.platform" @close="login = false" @complete="remoteComplete" /></div></template>
