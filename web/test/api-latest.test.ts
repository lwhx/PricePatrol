// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { request } from '../src/api/client';
import { useLatest } from '../src/composables/useLatest';
afterEach(() => vi.unstubAllGlobals());
function response(status: number, body: unknown) { return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body), headers: { get: () => null } } as unknown as Response; }
describe('真实请求约定', () => {
  it('变更请求带会话并发送 JSON', async () => {
    const fetcher = vi.fn().mockResolvedValue(response(200, { ok: true })); vi.stubGlobal('fetch', fetcher);
    expect(await request('/settings', { method: 'PUT', body: { notificationEnabled: true } })).toEqual({ ok: true });
    expect(fetcher).toHaveBeenCalledWith('/api/settings', expect.objectContaining({ method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: '{"notificationEnabled":true}' }));
  });
  it('将服务端错误传播给界面并在401时触发会话退出', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(401, { error: '登录已过期' })));
    const expired = vi.fn(); window.addEventListener('session-expired', expired);
    await expect(request('/shops')).rejects.toThrow('登录已过期'); expect(expired).toHaveBeenCalledOnce(); window.removeEventListener('session-expired', expired);
  });
});
describe('异步结果防竞态', () => {
  it('旧响应不能覆盖新结果或提前关闭加载状态', async () => {
    const state = useLatest(); let older!: (value: string) => void, newer!: (value: string) => void; const commit = vi.fn();
    const first = state.load(() => new Promise<string>(resolve => { older = resolve; }), commit);
    const second = state.load(() => new Promise<string>(resolve => { newer = resolve; }), commit);
    older('旧数据'); await first; expect(state.loading.value).toBe(true); expect(commit).not.toHaveBeenCalled();
    newer('最新数据'); await second; expect(commit).toHaveBeenCalledOnce(); expect(commit).toHaveBeenCalledWith('最新数据'); expect(state.loading.value).toBe(false);
  });
  it('旧失败不会覆盖新成功后的错误状态', async () => {
    const state = useLatest(); let fail!: (reason: Error) => void; const first = state.load(() => new Promise<string>((_, reject) => { fail = reject; }), vi.fn());
    await state.load(async () => '最新', vi.fn()); fail(new Error('过时失败')); await first; expect(state.error.value).toBe('');
  });
});
