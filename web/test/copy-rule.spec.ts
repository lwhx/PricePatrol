// @vitest-environment jsdom
import { defineComponent, h, reactive } from 'vue';
import { mount, flushPromises } from '@vue/test-utils';
import { describe, it, expect, vi, afterEach } from 'vitest';
import CopyDialog from '../src/components/CopyDialog.vue';
import RuleEditor from '../src/components/RuleEditor.vue';
const { postMock, downloadMock } = vi.hoisted(() => ({ postMock: vi.fn(), downloadMock: vi.fn() }));
vi.mock('../src/api/client', () => ({ post: postMock, download: downloadMock }));
vi.mock('element-plus', () => ({ ElMessage: { success: vi.fn(), error: vi.fn() }, ElMessageBox: { confirm: vi.fn() } }));
const Box = defineComponent({ setup(_, { slots }) { return () => h('div', [slots.default?.(), slots.footer?.()]); } });
const Button = defineComponent({ props: ['disabled', 'loading'], emits: ['click'], setup(props, { slots, emit }) { return () => h('button', { disabled: props.disabled, onClick: () => emit('click') }, slots.default?.()); } });
const Group = defineComponent({ name: 'ElCheckboxGroup', props: ['modelValue'], emits: ['update:modelValue'], setup(_, { slots }) { return () => h('div', slots.default?.()); } });
const Select = defineComponent({ name: 'ElSelect', props: ['modelValue'], emits: ['update:modelValue'], setup(_, { slots }) { return () => h('div', slots.default?.()); } });
const stubs = { ElDialog: Box, ElForm: Box, ElFormItem: Box, ElButton: Button, ElSelect: Select, ElOption: Box, ElCheckboxGroup: Group, ElCheckbox: Box, ElRadioGroup: Box, ElRadio: Box, ElInput: Box, ElAlert: Box };
afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); });
const snapshot = { token: 'fixed-token', content: '完整结果', preview: '预览', rowCount: 3, sourceCount: 5, bytes: 20, downloadRecommended: false, filename: 'prices.tsv', mime: 'text/tab-separated-values' };
function button(wrapper: ReturnType<typeof mount>, label: string) { const found = wrapper.findAll('button').find(item => item.text() === label); if (!found) throw Error(`missing button ${label}`); return found; }
describe('复制快照交互', () => {
  it('独立字段有序提交、全量范围走服务端且下载复用同一token', async () => {
    postMock.mockResolvedValue(snapshot); downloadMock.mockResolvedValue(undefined);
    const wrapper = mount(CopyDialog, { props: { query: { view: 'sku', page: 3 }, selectedIds: [], total: 500 }, global: { stubs } });
    wrapper.findComponent(Group).vm.$emit('update:modelValue', ['title', 'productId', 'after']); await flushPromises();
    await button(wrapper, '生成快照与预览').trigger('click'); await flushPromises();
    expect(postMock).toHaveBeenCalledWith('/exports', expect.objectContaining({ scope: 'all', fields: ['title', 'productId', 'after'], query: { view: 'sku', page: 3 } }));
    expect(wrapper.text()).toContain('源行 5'); expect(wrapper.text()).toContain('输出 3 行');
    await button(wrapper, '下载同一快照').trigger('click'); await flushPromises(); expect(downloadMock).toHaveBeenCalledWith('/exports/fixed-token/download', 'GET', 'prices.tsv');
    wrapper.findComponent(Group).vm.$emit('update:modelValue', ['productId']); await flushPromises(); expect(button(wrapper, '下载同一快照').attributes('disabled')).toBeDefined(); wrapper.unmount();
  });
  it('剪贴板失败时保留完整文本用于手动复制', async () => {
    postMock.mockResolvedValue(snapshot); vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockRejectedValue(Error('denied')) } });
    const wrapper = mount(CopyDialog, { props: { query: { view: 'product' }, selectedIds: ['one'], total: 5 }, global: { stubs } });
    await button(wrapper, '生成快照与预览').trigger('click'); await flushPromises(); await button(wrapper, '复制完整结果').trigger('click'); await flushPromises();
    expect(wrapper.find('[aria-label="手动复制完整结果"]').exists()).toBe(true); expect(postMock).toHaveBeenCalledWith('/exports', expect.objectContaining({ scope: 'selected', selectedIds: ['one'], allSkus: false })); wrapper.unmount();
  });
});
describe('规则编辑', () => {
  it('添加条件组能够处理Vue响应式输入且不修改父级原始规则', async () => {
    const groups = reactive([{ mode: 'all' as const, conditions: [{ field: 'discount' as const, op: 'lt' as const, value: '8.5' }] }]);
    const wrapper = mount(RuleEditor, { props: { modelValue: groups }, global: { stubs } }); await button(wrapper, '＋ 添加条件组').trigger('click');
    expect(groups).toHaveLength(1); expect(wrapper.emitted('update:modelValue')?.[0]?.[0]).toHaveLength(2); wrapper.unmount();
  });
});
