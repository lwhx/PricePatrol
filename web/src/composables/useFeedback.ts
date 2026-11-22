import { ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
export function useFeedback() {
  const busy = ref(false), error = ref('');
  async function act<T>(operation: () => Promise<T>, success = ''): Promise<T | undefined> {
    busy.value = true; error.value = '';
    try { const result = await operation(); if (success) ElMessage.success(success); return result; }
    catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); ElMessage.error(error.value); return undefined; }
    finally { busy.value = false; }
  }
  return { busy, error, act };
}
export async function confirmAction(message: string) {
  try { await ElMessageBox.confirm(message, '请确认操作', { confirmButtonText: '确认', cancelButtonText: '取消', type: 'warning' }); return true; }
  catch { return false; }
}
