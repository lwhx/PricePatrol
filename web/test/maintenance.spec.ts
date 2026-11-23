// @vitest-environment jsdom
import { defineComponent, h } from 'vue';
import { mount, flushPromises } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MaintenancePanel from '../src/components/MaintenancePanel.vue';

const { getMock, postMock, requestMock, confirmMock } = vi.hoisted(() => ({
  getMock: vi.fn(), postMock: vi.fn(), requestMock: vi.fn(), confirmMock: vi.fn(),
}));
vi.mock('../src/api/client', () => ({ get: getMock, post: postMock, request: requestMock, download: vi.fn() }));
vi.mock('element-plus', () => ({ ElMessage: { success: vi.fn(), error: vi.fn() }, ElMessageBox: { confirm: confirmMock } }));
const Box = defineComponent({ setup(_, { slots }) { return () => h('div', slots.default?.()); } });
const Button = defineComponent({ props: ['disabled'], emits: ['click'], setup(props, { slots, emit }) { return () => h('button', { disabled: props.disabled, onClick: () => emit('click') }, slots.default?.()); } });
const Input = defineComponent({ name: 'ElInput', props: ['modelValue'], emits: ['update:modelValue'], setup(props) { return () => h('input', { value: props.modelValue }); } });
const NumberInput = defineComponent({ name: 'ElInputNumber', props: ['modelValue'], emits: ['update:modelValue'], setup(props) { return () => h('input', { value: props.modelValue, type: 'number' }); } });
const stubs = { ElButton: Button, ElForm: Box, ElFormItem: Box, ElSwitch: Box, ElInput: Input, ElInputNumber: NumberInput, ErrorBanner: Box };
const settings = { retentionDays: 180, alertRetentionDays: 365, cleanupEnabled: false, backupsEnabled: true, backupIntervalHours: 24, backupKeep: 14 };
const status = { running: false, lastRunAt: null, lastBackupAt: null, lastCleanupAt: null, lastError: null, backupError: null, copyError: null, backupCount: 0, backupCopyConfigured: false, databaseBytes: 1024, lastDeleted: 0 };
const preview = { policy: { historyBefore: '2025-01-01T00:00:00.000Z', alertBefore: '2024-01-01T00:00:00.000Z' }, runs: 2, prices: 5, alertRuns: 1, alerts: 0, protectedRuns: 3, total: 8 };
beforeEach(() => { getMock.mockImplementation(async (url: string) => url === '/maintenance/settings' ? settings : url === '/operations' ? { build: { sha: 'test-sha', time: null, schema: {} } } : status); });
afterEach(() => { vi.resetAllMocks(); vi.useRealTimers(); });
const button = (wrapper: ReturnType<typeof mount>, text: string) => wrapper.findAll('button').find(item => item.text() === text)!;

describe('维护操作', () => {
  it('查看设置不创建任务；轮询不会覆盖未保存的表单', async () => {
    vi.useFakeTimers();
    const wrapper = mount(MaintenancePanel, { global: { stubs } }); await flushPromises();
    expect(postMock).not.toHaveBeenCalled();
    wrapper.findAllComponents(NumberInput)[0]!.vm.$emit('update:modelValue', 200);
    await vi.advanceTimersByTimeAsync(10000); await flushPromises();
    expect(wrapper.findAllComponents(NumberInput)[0]!.props('modelValue')).toBe(200);
    requestMock.mockResolvedValue({ ...settings, retentionDays: 200 });
    await button(wrapper, '保存维护设置').trigger('click'); await flushPromises();
    expect(requestMock).toHaveBeenCalledWith('/maintenance/settings', { method: 'PUT', body: { ...settings, retentionDays: 200 } });
    wrapper.unmount();
  });

  it('清理须先预览、确认，并使用预览的截止时间', async () => {
    const wrapper = mount(MaintenancePanel, { global: { stubs } }); await flushPromises();
    expect(wrapper.text()).not.toContain('备份后执行清理');
    postMock.mockResolvedValueOnce(preview);
    await button(wrapper, '预览可清理记录').trigger('click'); await flushPromises();
    expect(postMock).toHaveBeenLastCalledWith('/maintenance/cleanup/preview', {});
    confirmMock.mockRejectedValueOnce(new Error('cancel'));
    await button(wrapper, '备份后执行清理').trigger('click'); await flushPromises();
    expect(postMock).toHaveBeenCalledTimes(1);
    confirmMock.mockResolvedValueOnce('confirm'); postMock.mockResolvedValueOnce({ ...preview, deleted: 8 });
    await button(wrapper, '备份后执行清理').trigger('click'); await flushPromises();
    expect(postMock).toHaveBeenLastCalledWith('/maintenance/cleanup', { before: preview.policy.historyBefore });
    expect(wrapper.text()).not.toContain('备份后执行清理');
    wrapper.unmount();
  });

  it('修改日期使旧预览失效，立即备份只提交独立备份任务', async () => {
    const wrapper = mount(MaintenancePanel, { global: { stubs } }); await flushPromises();
    postMock.mockResolvedValueOnce(preview);
    await button(wrapper, '预览可清理记录').trigger('click'); await flushPromises();
    wrapper.findComponent(Input).vm.$emit('update:modelValue', '2025-02-01'); await flushPromises();
    expect(wrapper.text()).not.toContain('备份后执行清理');
    postMock.mockResolvedValueOnce({ accepted: true });
    await button(wrapper, '立即创建备份').trigger('click'); await flushPromises();
    expect(postMock).toHaveBeenLastCalledWith('/maintenance/run', { kind: 'backup' });
    expect(postMock.mock.calls.some(([url]) => url === '/maintenance/cleanup')).toBe(false);
    wrapper.unmount();
  });
});
