const fallback = new Map<string, string>();
export function readPreference<T>(key: string, initial: T): T {
  try { const text = globalThis.localStorage?.getItem(`price-monitor:${key}`) ?? fallback.get(key); return text ? JSON.parse(text) as T : initial; }
  catch { return initial; }
}
export function writePreference(key: string, value: unknown) {
  const text = JSON.stringify(value); fallback.set(key, text);
  try { globalThis.localStorage?.setItem(`price-monitor:${key}`, text); } catch { /* preferences remain in memory */ }
}
