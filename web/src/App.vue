<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import { useRoute } from 'vue-router';
import { get, post } from './api/client';
import AuthPage from './pages/AuthPage.vue';
import ErrorBanner from './components/ErrorBanner.vue';
const route = useRoute();
const configured = ref(false), authenticated = ref(false), checking = ref(true), error = ref('');
const setupTokenRequired = ref(false);
const nav = [ ['/', '◈', '工作总览'], ['/shops', '▣', '店铺账号'], ['/prices', '▤', '商品价格'], ['/tasks', '◷', '采集任务'], ['/alert-tasks', '◉', '预警任务'], ['/alerts', '◇', '预警记录'], ['/settings', '⚙', '系统设置'] ];
async function refreshAuth() {
  error.value = ''; checking.value = true;
  try { const result = await get<{ configured: boolean; authenticated: boolean; setupTokenRequired: boolean }>('/auth/status'); configured.value = result.configured; authenticated.value = result.authenticated; setupTokenRequired.value = result.setupTokenRequired; }
  catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); }
  finally { checking.value = false; }
}
function expired() { authenticated.value = false; }
async function logout() {
  try { await post('/auth/logout'); authenticated.value = false; }
  catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); }
}
onMounted(() => { void refreshAuth(); window.addEventListener('session-expired', expired); });
onUnmounted(() => window.removeEventListener('session-expired', expired));
</script>
<template>
  <div v-if="checking" class="boot-state"><div class="brand-mark">价</div><p>正在连接管理服务…</p></div>
  <div v-else-if="error && !authenticated" class="boot-state"><ErrorBanner :message="error" /><el-button @click="refreshAuth">重新连接</el-button></div>
  <AuthPage v-else-if="!authenticated" :configured="configured" :setup-token-required="setupTokenRequired" @authenticated="refreshAuth" />
  <div v-else class="app-shell">
    <aside class="sidebar"><a class="brand" href="/"><span class="brand-mark">价</span><span>价巡<small>电商价格监控</small></span></a>
      <div class="nav-caption">工作空间</div><nav><router-link v-for="[path, icon, label] in nav" :key="path" :to="path" :class="{ active: path === '/' ? route.path === '/' : route.path.startsWith(path!) }"><span class="nav-icon">{{ icon }}</span>{{ label }}</router-link></nav>
      <div class="sidebar-bottom"><span class="live-dot" /> 数据库实时工作台<small>Asia / Shanghai · 单管理员</small></div>
    </aside>
    <div class="workspace"><header class="topbar"><div class="breadcrumb">工作空间 <span>/</span> {{ route.meta.title }}</div><div class="topbar-right"><span class="admin-avatar">管</span><span>管理员</span><el-button text @click="logout">退出登录</el-button></div></header>
      <main class="main-content"><ErrorBanner :message="error" /><router-view v-slot="{ Component }"><keep-alive :include="['PricesPage']"><component :is="Component" :key="route.path" /></keep-alive></router-view></main>
      <footer class="workspace-footer">价巡 PRICE MONITOR <span>金额单位：元 · 商品与 SKU ID 按文本保存</span></footer>
    </div>
  </div>
</template>
