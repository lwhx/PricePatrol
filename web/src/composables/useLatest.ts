import { ref } from 'vue';
export function useLatest() {
  const loading = ref(false), error = ref('');
  let sequence = 0;
  async function load<T>(fetcher: () => Promise<T>, commit: (value: T) => void) {
    const current = ++sequence; loading.value = true; error.value = '';
    try { const value = await fetcher(); if (current === sequence) commit(value); }
    catch (cause) { if (current === sequence) error.value = cause instanceof Error ? cause.message : String(cause); }
    finally { if (current === sequence) loading.value = false; }
  }
  return { loading, error, load };
}
