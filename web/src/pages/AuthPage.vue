<script setup lang="ts">
import { computed, ref } from 'vue';
import { post } from '../api/client';
import { useFeedback } from '../composables/useFeedback';
import ErrorBanner from '../components/ErrorBanner.vue';
const props = defineProps<{ configured: boolean; setupTokenRequired?: boolean }>();
const emit = defineEmits<{ authenticated: [] }>();
const password = ref(''), confirmation = ref(''), setupToken = ref('');
const needsSetupToken = computed(() => !props.configured && props.setupTokenRequired);
const { busy, error, act } = useFeedback();
async function submit() {
  if (password.value.length < 10) { error.value = '密码至少需要 10 个字符'; return; }
  if (!props.configured && confirmation.value !== password.value) { error.value = '两次输入的密码不一致'; return; }
  const token = setupToken.value.trim();
  if (needsSetupToken.value && !token) { error.value = '请输入初始化令牌'; return; }
  const payload = { password: password.value, ...(needsSetupToken.value ? { setupToken: token } : {}) };
  const result = await act(async () => { await post(`/auth/${props.configured ? 'login' : 'setup'}`, payload); return true; });
  password.value = ''; confirmation.value = ''; setupToken.value = '';
  if (result) emit('authenticated');
}
</script>
<template>
  <div class="auth-screen">
    <section class="auth-intro">
      <div class="brand-mark large">价</div>
      <div class="eyebrow">PRICE MONITOR / OPERATION CONSOLE</div>
      <h1>每一次价格变化，<br>都有据可循。</h1>
      <p>连接店铺，持续采集。让价格查询、独立任务与预警处理在一个工作台里完成。</p>
      <div class="auth-features"><span>多店会话隔离</span><span>SKU 三价追踪</span><span>规则独立留存</span></div>
    </section>
    <section class="auth-card">
      <div class="eyebrow">安全访问</div>
      <h2>{{ configured ? '登录管理后台' : '初始化管理员' }}</h2>
      <p class="muted">{{ configured ? '请输入管理员密码以继续。' : '首次使用请设置至少 10 个字符的管理员密码。' }}</p>
      <ErrorBanner :message="error" />
      <el-form label-position="top" @submit.prevent="submit">
        <el-form-item v-if="needsSetupToken" label="初始化令牌">
          <el-input v-model="setupToken" type="password" show-password autocomplete="off" placeholder="输入初始化令牌" size="large" />
          <div class="muted">使用部署时设置的 SETUP_TOKEN，或从服务器数据目录的 .setup-token 文件读取。</div>
        </el-form-item>
        <el-form-item label="管理员密码">
          <el-input v-model="password" type="password" show-password :autocomplete="configured ? 'current-password' : 'new-password'" placeholder="至少 10 个字符" size="large" />
        </el-form-item>
        <el-form-item v-if="!configured" label="再次输入密码">
          <el-input v-model="confirmation" type="password" show-password autocomplete="new-password" size="large" />
        </el-form-item>
        <el-button native-type="submit" type="primary" size="large" :loading="busy" class="full-width">{{ configured ? '登录' : '设置密码并进入' }}</el-button>
      </el-form>
    </section>
  </div>
</template>
