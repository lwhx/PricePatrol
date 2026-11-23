import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h } from 'vue';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import type { ProductRow } from '../../shared/contracts.js';
import BatchAction from '../src/components/BatchAction.vue';

const { confirmMock } = vi.hoisted(() => ({ confirmMock: vi.fn() }));
vi.mock('element-plus', () => ({ ElMessage: { success: vi.fn(), error: vi.fn() }, ElMessageBox: { confirm: confirmMock } }));
const Box = defineComponent({ setup(_, { slots }) { return () => h('div', [slots.default?.(), slots.footer?.()]); } });
const Select = defineComponent({ name: 'ElSelect', props: ['modelValue'], emits: ['update:modelValue'], setup(_, { slots }) { return () => h('div', slots.default?.()); } });
const Option = defineComponent({ props: ['label', 'value'], setup(props) { return () => h('span', { 'data-option': props.value }, props.label); } });
const Button = defineComponent({ props: ['disabled'], emits: ['click'], setup(props, { slots, emit }) { return () => h('button', { disabled: props.disabled, onClick: () => emit('click') }, slots.default?.()); } });
const stubs = { ElDialog: Box, ElButton: Button, ElSelect: Select, ElOption: Option, ElTable: Box, ElTableColumn: Box, ElAlert: Box, ElCheckbox: Box, ElInput: Box };
const rows: ProductRow[] = [{ id: 'a:200', shopId: 'a', shopName: '首店', productId: '200', title: '商品', sourceUrl: '', skuCount: 2, matchedSkuCount: 2, unknownCount: 0, minDiscount: null, maxDiscount: null, minAfter: null, maxAfter: null, updatedAt: '', status: 'ok', skuIds: ['1', '2'] }];
const collections = [{ id: 'collection', shopId: 'a', name: '每日采集', scope: 'selected', productIds: ['100', '200'] }, { id: 'all-collection', shopId: 'a', name: '全店采集', scope: 'all', productIds: [] }];
const alertTasks = [{ id: 'alert-a', collectionTaskId: 'collection', shopId: 'a', name: '低价预警', scope: 'all', productIds: [] }, { id: 'alert-b', collectionTaskId: 'other-collection', shopId: 'b', name: '别店预警', scope: 'all', productIds: [] }];
const reply = (data: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(data) });
const fetcher = vi.fn(async (url: string, _options?: { body?: string; method?: string }) => {
  if (url === '/api/tasks') return reply({ tasks: collections });
  if (url === '/api/alert-tasks') return reply({ tasks: alertTasks });
  if (url.endsWith('/collect')) return reply({ run: { id: `run-${url.split('/')[3]}` } });
  return reply({ added: 1, existing: 0 });
});
let wrapper: VueWrapper | undefined;
beforeEach(() => { fetcher.mockClear(); confirmMock.mockResolvedValue(undefined); vi.stubGlobal('fetch', fetcher); });
afterEach(() => { wrapper?.unmount(); wrapper = undefined; vi.clearAllMocks(); vi.unstubAllGlobals(); });
async function open(type: 'task' | 'whitelist' | 'collect', selectedRows = rows) { wrapper = mount(BatchAction, { props: { rows: selectedRows, type }, global: { stubs } }); await flushPromises(); return wrapper; }
async function chooseAndSave(id: string) { wrapper!.findComponent(Select).vm.$emit('update:modelValue', id); await flushPromises(); await wrapper!.findAll('button').find(button => button.text() === '确认保存')!.trigger('click'); await flushPromises(); }

describe('采集范围与预警白名单分别操作', () => {
  it('白名单只列出同店预警任务并提交到预警白名单接口', async () => {
    await open('whitelist');
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual(['/api/alert-tasks']);
    expect(wrapper!.text()).toContain('低价预警');
    expect(wrapper!.text()).not.toContain('别店预警');
    expect(wrapper!.text()).not.toContain('每日采集');
    await chooseAndSave('alert-a');
    const mutation = fetcher.mock.calls.find(([url]) => url === '/api/alert-tasks/alert-a/whitelist');
    expect(mutation?.[1]?.method).toBe('POST');
    expect(JSON.parse(mutation![1]!.body!)).toEqual({ productIds: ['200'] });
    expect(wrapper!.emitted('complete')).toHaveLength(1);
  });

  it('通过追加接口提交选中的商品，不发送旧任务范围', async () => {
    await open('task');
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual(['/api/tasks']);
    expect(wrapper!.find('[data-option="collection"]').text()).toBe('每日采集');
    expect(wrapper!.find('[data-option="all-collection"]').exists()).toBe(false);
    await chooseAndSave('collection');
    const mutation = fetcher.mock.calls.find(([url]) => url === '/api/tasks/collection/products');
    expect(mutation?.[1]?.method).toBe('POST');
    expect(JSON.parse(mutation![1]!.body!)).toEqual({ productIds: ['200'] });
    expect(fetcher.mock.calls.some(([url]) => url.startsWith('/api/alert-tasks'))).toBe(false);
  });

  it('重采确认明确只更新价格，不会触发预警或汇总通知', async () => {
    await open('collect');
    expect(wrapper!.text()).toContain('不触发预警');
    await wrapper!.findAll('button').find(button => button.text() === '确认采集')!.trigger('click'); await flushPromises();
    expect(confirmMock.mock.calls[0]?.[0]).toContain('不触发预警');
    const mutation = fetcher.mock.calls.find(([url]) => url === '/api/shops/a/collect');
    expect(JSON.parse(mutation![1]!.body!)).toEqual({ productIds: ['200'], idempotencyKey: expect.any(String) });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('重试仅提交失败店铺，为丢失的响应沿用原请求标识', async () => {
    fetcher.mockResolvedValueOnce(reply({ run: { id: 'accepted-a' } }))
      .mockRejectedValueOnce(new Error('连接中断'))
      .mockResolvedValueOnce(reply({ run: { id: 'accepted-c' } }));
    const selected = [...rows, ...['b', 'c'].map(shopId => ({ ...rows[0]!, id: `${shopId}:200`, shopId }))];
    await open('collect', selected);
    await wrapper!.findAll('button').find(button => button.text() === '确认采集')!.trigger('click'); await flushPromises();
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual(['/api/shops/a/collect', '/api/shops/b/collect', '/api/shops/c/collect']);
    expect(wrapper!.emitted('complete')).toBeUndefined();
    const requests = fetcher.mock.calls.map(([, options]) => JSON.parse(options!.body!));
    expect(new Set(requests.map(body => body.idempotencyKey)).size).toBe(3);
    await wrapper!.findAll('button').find(button => button.text() === '重试失败店铺')!.trigger('click'); await flushPromises();
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(fetcher.mock.calls[3]).toEqual(fetcher.mock.calls[1]);
    expect(confirmMock.mock.calls[1]![0]).toContain('1 家店铺');
    expect(wrapper!.emitted('complete')).toHaveLength(1);
  });
});
