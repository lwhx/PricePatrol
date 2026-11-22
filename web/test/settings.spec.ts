// @vitest-environment jsdom
import { defineComponent, h } from 'vue';
import { mount, flushPromises } from '@vue/test-utils';
import { describe, it, expect, vi, afterEach } from 'vitest';
import SettingsPage from '../src/pages/SettingsPage.vue';
const { getMock, requestMock, postMock } = vi.hoisted(() => ({ getMock: vi.fn(), requestMock: vi.fn(), postMock: vi.fn() }));
vi.mock('../src/api/client', () => ({ get: getMock, request: requestMock, post: postMock, download: vi.fn() }));
vi.mock('element-plus', () => ({ ElMessage: { success: vi.fn(), error: vi.fn() }, ElMessageBox: { confirm: vi.fn() } }));
const Box = defineComponent({ setup(_, { slots }) { return () => h('div', slots.default?.()); } });
const RadioGroup = defineComponent({ name: 'ElRadioGroup', props: ['modelValue'], emits: ['update:modelValue', 'change'], setup(_, { slots }) { return () => h('div', slots.default?.()); } });
const Input = defineComponent({ name: 'ElInput', props: ['modelValue', 'type'], emits: ['update:modelValue'], setup(props) { return () => h('input', { type: props.type || 'text', value: props.modelValue }); } });
const Button = defineComponent({ props: ['disabled'], emits: ['click'], setup(props, { slots, emit }) { return () => h('button', { disabled: props.disabled, onClick: () => emit('click') }, slots.default?.()); } });
const stubs = { ElForm: Box, ElFormItem: Box, ElSwitch: Box, ElTag: Box, ElRadioGroup: RadioGroup, ElRadio: Box, ElInput: Input, ElInputNumber: Box, ElButton: Button, ElAlert: Box };
const settings = { notification: { enabled: true, hasSendKey: true, lastError: null }, retentionDays: 180, timezone: 'Asia/Shanghai' };
afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); });
describe('SendKey 凭据交互', () => {
  it('只发送本次输入密钥，保存后清空并在后续请求中省略', async () => {
    getMock.mockResolvedValue(settings); requestMock.mockResolvedValue(settings);
    const wrapper = mount(SettingsPage, { global: { stubs } }); await flushPromises();
    wrapper.findComponent(RadioGroup).vm.$emit('update:modelValue', 'replace'); await flushPromises();
    const password = wrapper.findAllComponents(Input).find(input => input.props('type') === 'password')!;
    password.vm.$emit('update:modelValue', 'SCT-secret-test'); await flushPromises();
    const save = () => wrapper.findAll('button').find(button => button.text() === '保存设置')!;
    await save().trigger('click'); await flushPromises();
    expect(requestMock).toHaveBeenLastCalledWith('/settings', { method: 'PUT', body: { notificationEnabled: true, retentionDays: 180, sendKey: 'SCT-secret-test' } });
    expect(wrapper.html()).not.toContain('SCT-secret-test'); expect(wrapper.find('input[type="password"]').exists()).toBe(false);
    await save().trigger('click'); await flushPromises(); expect(requestMock).toHaveBeenCalledTimes(2); expect(requestMock.mock.calls[1]![1].body).not.toHaveProperty('sendKey'); wrapper.unmount();
  });
  it('测试通知仅在用户点击时触发真实配置接口', async () => {
    getMock.mockResolvedValue(settings); postMock.mockResolvedValue({ accepted: true });
    const wrapper = mount(SettingsPage, { global: { stubs } }); await flushPromises(); expect(postMock).not.toHaveBeenCalled();
    await wrapper.findAll('button').find(button => button.text() === '发送真实测试通知')!.trigger('click'); await flushPromises(); expect(postMock).toHaveBeenCalledWith('/notifications/test'); wrapper.unmount();
  });
});
