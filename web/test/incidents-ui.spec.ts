import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { computed, defineComponent, h, inject, provide, type ComputedRef } from 'vue';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import type { Alert } from '../../shared/contracts.js';
import type { Incident } from '../../shared/incidents.js';
import AlertsPage from '../src/pages/AlertsPage.vue';

const { getMock, patchMock, success, failure } = vi.hoisted(() => ({
  getMock: vi.fn(), patchMock: vi.fn(), success: vi.fn(), failure: vi.fn(),
}));
vi.mock('../src/api/client', () => ({ get: getMock, patch: patchMock }));
vi.mock('element-plus', () => ({ ElMessage: { success, error: failure }, ElMessageBox: { confirm: vi.fn() } }));
const Box = defineComponent({ setup(_, { slots }) { return () => h('div', slots.default?.()); } });
const Dialog = defineComponent({
  name: 'ElDialog', props: ['modelValue', 'title'],
  setup(props, { slots }) { return () => props.modelValue ? h('div', { role: 'dialog', 'aria-label': props.title }, [slots.default?.(), slots.footer?.()]) : null; },
});
const Button = defineComponent({
  props: ['disabled'], emits: ['click'],
  setup(props, { slots, emit }) { return () => h('button', { disabled: props.disabled, onClick: () => emit('click') }, slots.default?.()); },
});
const Table = defineComponent({
  name: 'ElTable', props: ['data'], emits: ['selection-change'],
  setup(props, { slots }) { provide('rows', computed(() => props.data)); return () => h('div', slots.default?.()); },
});
const Column = defineComponent({
  props: ['label'],
  setup(props, { slots }) {
    const rows = inject<ComputedRef<Incident[] | Alert[]>>('rows')!;
    return () => h('section', { 'data-column': props.label }, rows.value.map(row => h('div', { key: row.id }, slots.default?.({ row }))));
  },
});
const Selection = defineComponent({ name: 'ElSelect', props: ['modelValue', 'placeholder'], emits: ['update:modelValue', 'change'], setup: (_, { slots }) => () => h('div', slots.default?.()) });
const Pagination = defineComponent({ name: 'ElPagination', props: ['currentPage', 'pageSize', 'total'], emits: ['update:currentPage'], template: '<div />' });
const Tabs = defineComponent({ name: 'ElTabs', props: ['modelValue'], emits: ['update:modelValue'], setup: (_, { slots }) => () => h('div', slots.default?.()) });
const RadioGroup = defineComponent({ name: 'ElRadioGroup', props: ['modelValue'], emits: ['update:modelValue'], setup: (_, { slots }) => () => h('div', slots.default?.()) });
const Input = defineComponent({
  props: ['modelValue'], emits: ['update:modelValue'],
  setup(props, { emit }) { return () => h('textarea', { value: props.modelValue, onInput: (event: Event) => emit('update:modelValue', (event.target as HTMLTextAreaElement).value) }); },
});
const Stats = defineComponent({
  props: { items: { type: Array<{ label: string; value: number }>, required: true } },
  setup(props) { return () => h('div', props.items.map(item => h('div', { 'data-stat': item.label }, String(item.value)))); },
});
const AlertBanner = defineComponent({ props: ['title'], setup: props => () => h('div', { role: 'alert' }, props.title) });
const stubs = {
  PageHeader: true, StatCards: Stats,
  ElTabs: Tabs, ElTabPane: Box, ElTable: Table, ElTableColumn: Column, ElTag: Box,
  ElSelect: Selection, ElOption: Box, ElButton: Button, ElPagination: Pagination,
  ElDialog: Dialog, ElForm: Box, ElFormItem: Box, ElRadioGroup: RadioGroup,
  ElRadioButton: Box, ElInput: Input, ElAlert: AlertBanner,
};
const at = '2026-11-22T00:00:00Z';
const incident: Incident = {
  id: 'incident:precise-1', identity: 'price-incident', ruleFingerprint: 'rule-v1',
  alertTaskId: 'alert-task', shopId: 'shop', shopName: '样品店',
  productId: '100001', skuId: '200001', title: '同一次持续异常', specs: '灰色',
  status: 'active', state: 'pending', note: '原有备注', resolvedAt: null,
  firstSeenAt: at, lastSeenAt: at, firstCollectionRunId: 'run-1',
  lastCollectionRunId: 'run-2', lastAlertRunId: 'evaluation-2', lastEvent: 'continuing',
};
const recovered: Incident = {
  ...incident, id: 'incident:recovered', title: '已观察到恢复的商品', status: 'recovered', lastEvent: 'recovered',
};
const evidence: Alert = {
  id: 'evidence-1', incidentId: incident.id, event: 'first', runId: 'run-1', alertRunId: 'evaluation-1',
  taskId: incident.alertTaskId, shopId: incident.shopId, shopName: incident.shopName, productId: incident.productId,
  skuId: incident.skuId, title: '首次证据', specs: incident.specs, backendPrice: '10.00', before: '12.00',
  after: '8.00', discount: '6.6667', reasons: ['价格低于预警阈值'], state: 'pending', note: '', createdAt: at,
};
const repetition: Alert = { ...evidence, id: 'evidence-2', title: '持续证据', event: 'continuing', runId: 'run-2', alertRunId: 'evaluation-2' };
const old: Alert = { ...evidence, id: 'legacy', title: '旧版异常记录', incidentId: undefined, event: undefined };
let wrapper: VueWrapper | undefined;
beforeEach(() => {
  vi.resetAllMocks();
  getMock.mockImplementation(async (path: string) => {
    if (path.startsWith('/incidents?')) return { incidents: [incident], total: 1 };
    if (path === `/incidents/${encodeURIComponent(incident.id)}`) return { incident };
    if (path.startsWith('/alerts?')) return { alerts: [evidence, repetition, old] };
    if (path === '/shops') return { shops: [] };
    return { runs: [] };
  });
  patchMock.mockResolvedValue({});
});
afterEach(() => {
  wrapper?.unmount(); wrapper = undefined;
  vi.restoreAllMocks(); vi.useRealTimers();
});
async function open(path = '/alerts') {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/alerts', component: AlertsPage }, { path: '/tasks', component: Box },
      { path: '/alert-tasks', component: Box }, { path: '/prices', component: Box },
    ],
  });
  await router.push(path); await router.isReady();
  wrapper = mount(defineComponent({ template: '<router-view />' }), { global: { plugins: [router], stubs, directives: { loading: () => {} } } });
  await flushPromises();
  return router;
}
function button(label: string) {
  const match = wrapper!.findAll('button').find(item => item.text() === label);
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
}
function requestParams(prefix = '/incidents?') {
  const url = getMock.mock.calls.map(([path]) => path as string).filter(path => path.startsWith(prefix)).at(-1);
  return new URLSearchParams(url?.split('?')[1]);
}

it('defaults to paged pending incidents across observed statuses and ignores an older page response', async () => {
  let resolvePageTwo!: (result: { incidents: Incident[]; total: number }) => void;
  getMock.mockImplementation(async (path: string) => {
    const params = new URLSearchParams(path.split('?')[1]);
    if (params.get('page') === '2') return new Promise(resolve => { resolvePageTwo = resolve; });
    return params.get('status') === 'recovered'
      ? { incidents: [recovered], total: 1 }
      : { incidents: [incident, recovered], total: 61 };
  });
  await open();
  expect(Object.fromEntries(requestParams())).toEqual({ status: 'all', state: 'pending', page: '1', pageSize: '50' });
  expect(wrapper!.get('[data-column="异常状态"]').text()).toContain('持续异常');
  expect(wrapper!.get('[data-column="异常状态"]').text()).toContain('已恢复');
  expect(wrapper!.get('[data-column="人工处理"]').text()).toBe('待处理待处理');
  expect(getMock.mock.calls.some(([path]) => path.startsWith('/alerts?'))).toBe(false);
  const pagination = wrapper!.findComponent(Pagination);
  expect(pagination.props()).toMatchObject({ pageSize: 50, currentPage: 1, total: 61 });

  pagination.vm.$emit('update:currentPage', 2); await flushPromises();
  expect(requestParams().get('page')).toBe('2');
  const select = wrapper!.findAllComponents(Selection).find(item => item.attributes('aria-label') === '异常状态')!;
  select.vm.$emit('update:modelValue', 'recovered'); select.vm.$emit('change', 'recovered'); await flushPromises();
  expect(Object.fromEntries(requestParams())).toEqual({ status: 'recovered', state: 'pending', page: '1', pageSize: '50' });
  resolvePageTwo({ incidents: [incident], total: 61 }); await flushPromises();
  expect(wrapper!.text()).toContain(recovered.title);
  expect(wrapper!.text()).not.toContain(incident.title);
  expect(pagination.props('total')).toBe(1);
});

it('keeps linked evidence out of old pending counts and opens the precise incident without patching evidence', async () => {
  const router = await open('/alerts?alertRunId=evaluation-2');
  expect(wrapper!.get('[data-stat="旧版待处理"]').text()).toBe('1');
  expect(wrapper!.get('[data-column="异常变化"]').text()).toContain('持续异常');
  await button('查看证据').trigger('click');
  const dialog = wrapper!.get('[role="dialog"]');
  expect(dialog.find('textarea').exists()).toBe(false);
  expect(dialog.text()).not.toContain('保存处理记录');
  expect(patchMock).not.toHaveBeenCalled();

  await button('查看并处理关联异常').trigger('click'); await flushPromises();
  expect(router.currentRoute.value.query.incidentId).toBe(incident.id);
  expect(getMock).toHaveBeenCalledWith(`/incidents/${encodeURIComponent(incident.id)}`);
  expect(wrapper!.get('[role="dialog"]').text()).toContain(incident.title);
  await wrapper!.get('textarea').setValue('独立异常备注');
  wrapper!.findComponent(RadioGroup).vm.$emit('update:modelValue', 'resolved');
  await button('保存异常处理记录').trigger('click'); await flushPromises();
  expect(patchMock).toHaveBeenCalledExactlyOnceWith(`/incidents/${encodeURIComponent(incident.id)}`, { state: 'resolved', note: '独立异常备注' });
});

it('sends the old-state filter only for legacy evidence and excludes linked rows from legacy batch mutations', async () => {
  await open('/alerts?tab=evidence');
  const selection = wrapper!.findAllComponents(Selection).find(item => item.props('placeholder') === '全部旧版处理状态')!;
  selection.vm.$emit('update:modelValue', 'pending'); await flushPromises();
  expect(Object.fromEntries(requestParams('/alerts?'))).toEqual({ state: 'pending', legacyOnly: 'true' });
  expect(wrapper!.get('[data-column="商品 / 店铺"]').text()).not.toContain(repetition.title);
  wrapper!.findComponent(Table).vm.$emit('selection-change', [old, repetition]); await flushPromises();
  await button('批量处理旧版').trigger('click'); await flushPromises();
  expect(patchMock).toHaveBeenCalledExactlyOnceWith('/alerts/legacy', { state: 'resolved' });
});

it('a polling refresh leaves unsaved notes intact and a note-only update omits the old state', async () => {
  vi.useFakeTimers();
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  await open();
  await button('处理异常').trigger('click');
  await wrapper!.get('textarea').setValue('未提交的备注');
  getMock.mockResolvedValueOnce({ incidents: [{ ...incident, note: '服务器备注', state: 'confirmed' }], total: 1 });
  await vi.advanceTimersByTimeAsync(10_000); await flushPromises();
  expect(wrapper!.get('[data-column="人工处理"]').text()).toContain('已确认');
  expect(wrapper!.get<HTMLTextAreaElement>('textarea').element.value).toBe('未提交的备注');
  await button('保存异常处理记录').trigger('click'); await flushPromises();
  expect(patchMock).toHaveBeenCalledExactlyOnceWith(`/incidents/${encodeURIComponent(incident.id)}`, { note: '未提交的备注' });
});

it('reports partial incident batch updates and attempts rows after a failure', async () => {
  const later = { ...incident, id: 'later' };
  getMock.mockResolvedValue({ incidents: [incident, recovered, later], total: 3 });
  patchMock.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('暂时失败')).mockResolvedValueOnce({});
  await open();
  wrapper!.findComponent(Table).vm.$emit('selection-change', [incident, recovered, later]); await flushPromises();
  await button('批量确认异常').trigger('click'); await flushPromises();
  expect(patchMock.mock.calls).toEqual([incident, recovered, later].map(row => [`/incidents/${encodeURIComponent(row.id)}`, { state: 'confirmed' }]));
  expect(wrapper!.get('[role="alert"]').text()).toContain('2 条已更新，1 条提交失败');
  expect(success).not.toHaveBeenCalled();
});
