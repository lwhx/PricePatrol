// @vitest-environment jsdom
import { computed, defineComponent, h, inject, provide, type ComputedRef, type Component } from 'vue';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TaskEditPage from '../src/pages/TaskEditPage.vue';
import TasksPage from '../src/pages/TasksPage.vue';
import RunTable from '../src/components/RunTable.vue';
import { router as appRouter } from '../src/router';

const { getMock, postMock, patchMock, removeMock } = vi.hoisted(() => ({ getMock: vi.fn(), postMock: vi.fn(), patchMock: vi.fn(), removeMock: vi.fn() }));
vi.mock('../src/api/client', () => ({ get: getMock, post: postMock, patch: patchMock, remove: removeMock }));
vi.mock('element-plus', () => ({ ElMessage: { success: vi.fn(), error: vi.fn() }, ElMessageBox: { confirm: vi.fn().mockResolvedValue(true) } }));
const Box = defineComponent({ setup(_, { slots }) { return () => h('div', [slots.default?.(), slots.footer?.()]); } });
const FormItem = defineComponent({ props: ['label'], setup(props, { slots }) { return () => h('div', { 'data-label': props.label }, slots.default?.()); } });
const Button = defineComponent({ props: ['disabled'], emits: ['click'], setup(props, { slots, emit }) { return () => h('button', { disabled: props.disabled, onClick: () => emit('click') }, slots.default?.()); } });
const Input = defineComponent({ props: ['modelValue', 'type'], emits: ['update:modelValue'], setup(props, { emit }) { return () => h(props.type === 'textarea' ? 'textarea' : 'input', { value: props.modelValue, onInput: (event: Event) => emit('update:modelValue', (event.target as HTMLInputElement).value) }); } });
const Select = defineComponent({ name: 'ElSelect', props: ['modelValue', 'disabled', 'placeholder'], emits: ['update:modelValue', 'change'], setup(props, { slots, emit }) { return () => h('select', { value: props.modelValue, disabled: props.disabled, 'aria-label': props.placeholder, onChange: (event: Event) => { const value = (event.target as HTMLSelectElement).value; emit('update:modelValue', value); emit('change', value); } }, slots.default?.()); } });
const Option = defineComponent({ props: ['value', 'label'], setup(props) { return () => h('option', { value: props.value }, props.label); } });
const Group = defineComponent({ name: 'ElRadioGroup', props: ['modelValue'], emits: ['update:modelValue'], setup(_, { slots }) { return () => h('div', slots.default?.()); } });
const Table = defineComponent({ props: ['data'], setup(props, { slots }) { provide('tableRows', computed(() => props.data || [])); return () => h('div', slots.default?.()); } });
const Column = defineComponent({ props: ['label', 'prop', 'type'], setup(props, { slots }) { const rows = inject<ComputedRef<Record<string, unknown>[]>>('tableRows')!; return () => h('section', { 'data-column': props.label }, [props.label, ...rows.value.map(row => h('div', slots.default?.({ row }) || String(row[props.prop] ?? '')))]); } });
const stubs = { ElForm: Box, ElFormItem: FormItem, ElInput: Input, ElInputNumber: Input, ElSwitch: Box, ElRadioGroup: Group, ElRadio: Box, ElRadioButton: Box, ElSelect: Select, ElOption: Option, ElButton: Button, ElTable: Table, ElTableColumn: Column, ElTag: Box, ElAlert: Box, ElProgress: Box, ElTabs: Box, ElTabPane: Box, ElEmpty: Box, ElCheckboxGroup: Box, ElCheckbox: Box, ElDialog: Box, ElPagination: Box };
const collection = { id: 'collection-one', shopId: 'shop-one', name: '每日采集', enabled: true, scope: 'all', productIds: [], schedule: { kind: 'daily', time: '09:00', days: [1], timezone: 'Asia/Shanghai' }, version: 1, createdAt: '2026-11-22T00:00:00Z', updatedAt: '2026-11-22T00:00:00Z', nextRunAt: null };
const shop = { id: 'shop-one', name: '测试店铺', enabled: true };
const collectionRun = { id: 'collection-run', taskId: collection.id, shopId: shop.id, taskName: collection.name, shopName: shop.name, status: 'success', trigger: 'manual', scope: 'all', productIds: [], expected: 1, processed: 1, failed: 0, rows: 3, checked: 0, excluded: 0, matched: 0, unknown: 0, message: '', createdAt: collection.createdAt, startedAt: collection.createdAt, finishedAt: collection.createdAt, parentRunId: null, failedProductIds: [], notificationStatus: 'skipped' };
const alertTask = { id: 'alert-one', collectionTaskId: collection.id, shopId: shop.id, name: '低价预警', enabled: true, scope: 'all', productIds: [], rules: [{ mode: 'all', conditions: [{ field: 'discount', op: 'lt', value: '8.5' }] }], whitelist: { productIds: ['123456'], titleKeywords: ['样品'] }, notify: true, notificationPolicy: { cooldownHours: 0, notifyRecovery: true }, version: 3, createdAt: collection.createdAt, updatedAt: collection.createdAt };
const alertRun = { id: 'alert-run-one', alertTaskId: alertTask.id, collectionRunId: collectionRun.id, shopId: shop.id, shopName: shop.name, taskName: alertTask.name, status: 'partial', rows: 3, checked: 2, excluded: 1, matched: 1, unknown: 1, message: '来源批次部分完成，覆盖不完整', ruleVersion: 3, createdAt: collection.createdAt, startedAt: collection.createdAt, finishedAt: collection.createdAt, notificationStatus: 'failed', lifecycle: { first: 0, continuing: 1, worsened: 0, recovered: 1 }, notificationCount: 1 };
let wrapper: VueWrapper | undefined;
beforeEach(() => {
  getMock.mockImplementation(async (path: string) => path === '/shops' ? { shops: [shop] } : path.startsWith('/alert-runs') ? { runs: [alertRun] } : path.startsWith('/runs') ? { runs: [] } : path === '/alert-tasks' ? { tasks: [alertTask] } : path === '/overview' ? { recentRuns: [] } : { tasks: [collection] });
  postMock.mockResolvedValue({ run: collectionRun }); patchMock.mockResolvedValue({});
});
afterEach(() => { wrapper?.unmount(); wrapper = undefined; vi.clearAllMocks(); });
async function open(component: Component, path: string) {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/tasks', component: TasksPage }, { path: '/tasks/new', component: TaskEditPage }, { path: '/tasks/:id/edit', component: TaskEditPage }, { path: '/alert-tasks', component: Box }, { path: '/alert-tasks/new', component: Box }, { path: '/prices', component: Box }, { path: '/alerts', component: Box }] });
  await router.push(path); await router.isReady();
  wrapper = mount(component, { global: { plugins: [router], stubs, directives: { loading: () => {} } } }); await flushPromises();
  return { wrapper, router };
}
function button(target: VueWrapper, label: string) { const result = target.findAll('button').find(item => item.text() === label); if (!result) throw Error(`missing button ${label}`); return result; }
async function openRoute(path: string) {
  const router = createRouter({ history: createMemoryHistory(), routes: appRouter.options.routes });
  await router.push(path); await router.isReady();
  wrapper = mount(defineComponent({ template: '<router-view />' }), { global: { plugins: [router], stubs, directives: { loading: () => {} } } }); await flushPromises();
  return { wrapper, router };
}

describe('采集与预警分离交互', () => {
  it('采集任务编辑只提交范围与计划，不携带规则、白名单或通知字段', async () => {
    const { wrapper, router } = await open(TaskEditPage, '/tasks/new');
    await wrapper.get('[data-label="任务名称"] input').setValue('每日价格采集');
    await button(wrapper, '保存任务').trigger('click'); await flushPromises();
    expect(postMock).toHaveBeenCalledWith('/tasks', expect.objectContaining({ name: '每日价格采集', shopId: shop.id, scope: 'all' }));
    const body = postMock.mock.calls[0]![1];
    expect(body).not.toHaveProperty('rules'); expect(body).not.toHaveProperty('whitelist'); expect(body).not.toHaveProperty('notify');
    expect(wrapper.text()).not.toContain('预警条件'); expect(router.currentRoute.value.path).toBe('/tasks');
  });
  it('保存现有采集任务时发送打开编辑页时的版本', async () => {
    const { wrapper } = await open(TaskEditPage, `/tasks/${collection.id}/edit`);
    await wrapper.get('[data-label="任务名称"] input').setValue('修改采集名称');
    await button(wrapper, '保存任务').trigger('click'); await flushPromises();
    expect(patchMock).toHaveBeenCalledExactlyOnceWith(`/tasks/${collection.id}`, expect.objectContaining({ expectedVersion: collection.version, name: '修改采集名称' }));
  });
  it('有每日计划的采集任务仍使用手动采集入口并明确不会触发预警', async () => {
    const { wrapper } = await open(TasksPage, '/tasks');
    expect(wrapper.text()).toContain('手动采集不触发预警');
    await button(wrapper, '立即采集').trigger('click'); await flushPromises();
    expect(postMock).toHaveBeenCalledExactlyOnceWith(`/tasks/${collection.id}/run`);
    expect(postMock.mock.calls.some(([path]) => String(path).startsWith('/alert-'))).toBe(false);
  });
  it('采集记录区分来源，不再提供采集级汇总重发', async () => {
    const { wrapper } = await open(defineComponent({ components: { RunTable }, setup: () => ({ runs: [collectionRun, { ...collectionRun, id: 'legacy-run', trigger: undefined }] }), template: '<RunTable :runs="runs" />' }), '/tasks?tab=runs');
    expect(wrapper.text()).toContain('手动采集'); expect(wrapper.text()).toContain('旧版本');
    expect(wrapper.text()).not.toContain('重发汇总'); expect(wrapper.find('[data-column="命中 SKU"]').exists()).toBe(false);
  });
  it('恢复保留同一批次而失败项重试提示新建手动采集', async () => {
    const { wrapper } = await open(defineComponent({ components: { RunTable }, setup: () => ({ runs: [{ ...collectionRun, id: 'scheduled-stopped', status: 'stopped', trigger: 'scheduled' }, { ...collectionRun, id: 'scheduled-partial', status: 'partial', trigger: 'scheduled', failedProductIds: ['123456'] }] }), template: '<RunTable :runs="runs" />' }), '/tasks?tab=runs');
    await button(wrapper, '继续 / 恢复').trigger('click'); await flushPromises();
    await button(wrapper, '手动重试失败项').trigger('click'); await flushPromises();
    expect(postMock.mock.calls).toEqual([['/runs/scheduled-stopped/resume'], ['/runs/scheduled-partial/retry']]);
    expect(wrapper.text()).toContain('恢复保留原采集来源');
  });
  it('独立创建预警任务绑定采集任务，提交规则白名单与通知且不重复配置采集计划', async () => {
    const { wrapper, router } = await openRoute(`/alert-tasks/new?collectionTaskId=${collection.id}`);
    await wrapper.get('[data-label="预警任务名称"] input').setValue('低价规则 A');
    await wrapper.get('[data-label="排除商品 ID / 链接"] textarea').setValue('123456');
    await button(wrapper, '保存预警任务').trigger('click'); await flushPromises();
    expect(postMock).toHaveBeenCalledWith('/alert-tasks', expect.objectContaining({ name: '低价规则 A', collectionTaskId: collection.id, rules: expect.any(Array), whitelist: { productIds: ['123456'], titleKeywords: [] }, notify: true, notificationPolicy: { cooldownHours: 24, notifyRecovery: false } }));
    expect(postMock.mock.calls[0]![1]).not.toHaveProperty('shopId'); expect(postMock.mock.calls[0]![1]).not.toHaveProperty('schedule');
    await vi.waitFor(() => expect(router.currentRoute.value.path).toBe('/alert-tasks'));
  });
  it('编辑预警任务锁定来源，白名单预览与保存使用预警接口', async () => {
    const { wrapper } = await openRoute(`/alert-tasks/${alertTask.id}/edit`);
    expect(wrapper.get('[data-label="关联采集任务"] select').attributes('disabled')).toBeDefined();
    expect(wrapper.get<HTMLInputElement>('[data-label="持续异常提醒间隔（小时）"] input').element.value).toBe('0');
    postMock.mockResolvedValueOnce({ count: 1, products: [{ productId: '123456', title: '样品沙发' }] });
    await button(wrapper, '预览数据库命中').trigger('click'); await flushPromises();
    expect(postMock).toHaveBeenCalledWith(`/alert-tasks/${alertTask.id}/whitelist/preview`, alertTask.whitelist);
    await button(wrapper, '保存预警任务').trigger('click'); await flushPromises();
    expect(patchMock).toHaveBeenCalledWith(`/alert-tasks/${alertTask.id}`, expect.objectContaining({ collectionTaskId: collection.id, whitelist: alertTask.whitelist, notificationPolicy: alertTask.notificationPolicy }));
    expect(getMock).toHaveBeenCalledWith('/alert-tasks');
  });
  it('多个预警任务共享采集任务且列表只提供独立预警配置操作', async () => {
    getMock.mockImplementation(async (path: string) => path === '/shops' ? { shops: [shop] } : path === '/tasks' ? { tasks: [collection] } : path === '/alert-tasks' ? { tasks: [alertTask, { ...alertTask, id: 'alert-two', name: '价差规则 B' }] } : { runs: [alertRun] });
    const { wrapper } = await openRoute(`/alert-tasks?collectionTaskId=${collection.id}`);
    expect(wrapper.text()).toContain('低价预警'); expect(wrapper.text()).toContain('价差规则 B');
    expect(wrapper.findAll('a').filter(link => link.attributes('href') === `/tasks/${collection.id}/edit`)).toHaveLength(2);
    expect(wrapper.text()).not.toContain('立即采集');
  });
  it('预警执行按来源批次查询，独立重发通知并链接冻结价格与异常记录', async () => {
    const { wrapper } = await openRoute(`/alert-tasks?tab=runs&collectionRunId=${collectionRun.id}`);
    expect(getMock).toHaveBeenCalledWith(`/alert-runs?collectionRunId=${collectionRun.id}`);
    expect(wrapper.text()).toContain('覆盖不完整'); expect(wrapper.text()).toContain('规则 v3');
    expect(wrapper.text()).toContain('持续 1');
    expect(wrapper.text()).toContain('恢复 1');
    expect(wrapper.text()).toContain('本次通知候选 1');
    const links = wrapper.findAll('a').map(link => link.attributes('href'));
    expect(links).toContain(`/tasks?tab=runs&runId=${collectionRun.id}`);
    expect(links).toContain(`/alerts?alertRunId=${alertRun.id}`); expect(links).toContain('/prices');
    await button(wrapper, '重发汇总').trigger('click'); await flushPromises();
    expect(postMock).toHaveBeenCalledExactlyOnceWith(`/alert-runs/${alertRun.id}/notify`);
  });
  it('预警记录支持独立预警执行来源，并保留旧批次过滤', async () => {
    getMock.mockImplementation(async (path: string) => path.startsWith('/alerts') ? { alerts: [] } : path === '/shops' ? { shops: [shop] } : path.startsWith('/alert-runs') ? { runs: [alertRun] } : { runs: [collectionRun] });
    const { router } = await openRoute(`/alerts?alertRunId=${alertRun.id}`);
    expect(getMock.mock.calls.some(([path]) => String(path).startsWith('/alerts?') && new URLSearchParams(String(path).split('?')[1]).get('alertRunId') === alertRun.id)).toBe(true);
    await router.push(`/alerts?runId=${collectionRun.id}`); await flushPromises();
    const request = getMock.mock.calls.filter(([path]) => String(path).startsWith('/alerts?')).at(-1)![0];
    expect(new URLSearchParams(String(request).split('?')[1]).get('runId')).toBe(collectionRun.id);
    expect(new URLSearchParams(String(request).split('?')[1]).has('alertRunId')).toBe(false);
  });
  it('清空预警处理状态不会发送字符串 undefined 或 null', async () => {
    getMock.mockImplementation(async (path: string) => path.startsWith('/alerts') ? { alerts: [] } : path === '/shops' ? { shops: [shop] } : { runs: [] });
    const { wrapper } = await openRoute('/alerts?tab=evidence');
    const select = wrapper.findAllComponents(Select).find(component => component.props('placeholder') === '全部旧版处理状态')!;
    select.vm.$emit('update:modelValue', undefined); select.vm.$emit('change', undefined); await flushPromises();
    const request = getMock.mock.calls.filter(([path]) => String(path).startsWith('/alerts')).at(-1)![0];
    expect(request).not.toContain('undefined'); expect(request).not.toContain('null');
  });
});
