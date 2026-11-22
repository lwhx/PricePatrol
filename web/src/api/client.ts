export class ApiError extends Error {
  constructor(message: string, public status: number) { super(message); }
}
export async function request<T>(path: string, options: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method: options.method || 'GET', credentials: 'include', signal: options.signal,
    headers: options.body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  let payload: unknown;
  try { payload = text ? JSON.parse(text) : {}; } catch { throw new ApiError(`服务响应不是有效 JSON（HTTP ${response.status}）`, response.status); }
  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new Event('session-expired'));
    const message = payload && typeof payload === 'object' && 'error' in payload ? String(payload.error) : `请求失败（HTTP ${response.status}）`;
    throw new ApiError(message, response.status);
  }
  return payload as T;
}
export const get = <T>(path: string) => request<T>(path);
export const post = <T>(path: string, body?: unknown) => request<T>(path, { method: 'POST', body });
export const patch = <T>(path: string, body: unknown) => request<T>(path, { method: 'PATCH', body });
export const remove = <T>(path: string) => request<T>(path, { method: 'DELETE' });
export function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export async function download(path: string, method = 'GET', fallbackName = 'download') {
  const response = await fetch(`/api${path}`, { method, credentials: 'include' });
  if (!response.ok) {
    let message = `下载失败（HTTP ${response.status}）`;
    try { message = (await response.json()).error || message; } catch { /* preserve HTTP error */ }
    throw new ApiError(message, response.status);
  }
  const disposition = response.headers.get('content-disposition') || '';
  const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  saveBlob(await response.blob(), encoded ? decodeURIComponent(encoded) : fallbackName);
}
