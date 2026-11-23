import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { defineComponent } from 'vue';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import PricesPage from '../src/pages/PricesPage.vue';
import { savePriceQuery } from '../src/lib/price-query-state';
vi.mock('../src/components/PriceGrid.vue', () => ({ default: { name: 'PriceGrid', template: '<div />' } }));
vi.mock('element-plus', () => ({ ElMessage: { info: vi.fn(), success: vi.fn(), error: vi.fn() }, ElMessageBox: { confirm: vi.fn() } }));
const shopA = { id: 'a', name: '首店' }, shopB = { id: 'b', name: '新增店' };
let shops = [shopA];
const dateRange = { from: '2026-11-22T04:21:07.232Z', to: '2026-11-23T05:00:00.000Z' };
let wrapper: VueWrapper | undefined;
const reply = (data: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(data) });
const fetcher = vi.fn(async (url: string, _options?: { body?: string }) => {
  if (url === '/api/shops') return reply({ shops: shops.map(s => ({ ...s })) });
  if (url === '/api/alert-tasks') return reply({ tasks: [{ id: 'legacy-task-id', name: '独立低价预警', shopId: 'a' }] });
  if (url === '/api/queries') return reply({ queries: [{ id: 'named-range', name: '日期查询', query: dateRange }] });
  if (url === '/api/prices/query') return reply({ rows: [], total: 0, productCount: 0, skuCount: 0, page: 1, pageSize: 50, revision: 1 });
  return reply({ tasks: [], runs: [], queries: [] });
});
const passthrough = { template: '<div><slot /><slot name="footer" /></div>' };
const stubs = {
  PageHeader: passthrough, StatCards: true, ErrorBanner: true, RuleEditor: true, CopyDialog: true, PriceHistory: true, RunCompare: true, BatchAction: true,
  ElForm: { emits: ['submit'], template: '<form @submit.prevent="$emit(\'submit\', $event)"><slot /></form>' }, ElFormItem: { props: ['label'], template: '<div :data-label="label"><slot /></div>' },
  ElButton: { props: ['nativeType'], template: '<button :type="nativeType || \'button\'"><slot /></button>' },
  ElSelect: { name: 'ElSelect', emits: ['visible-change', 'update:modelValue', 'change'], template: '<div class="test-select" @click="$emit(\'visible-change\', true)"><slot /></div>' },
  ElOption: { props: ['label', 'value'], template: '<span :data-option="value">{{ label }}</span>' },
  ElInput: { props: ['modelValue'], emits: ['update:modelValue'], template: '<input :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />' },
  ElDialog: true, ElPagination: true, ElDatePicker: true, ElRadioGroup: passthrough, ElRadio: passthrough,
};
beforeEach(() => { shops = [shopA]; fetcher.mockClear(); sessionStorage.clear(); history.replaceState({}, ''); vi.stubGlobal('fetch', fetcher); });
afterEach(() => { wrapper?.unmount(); wrapper = undefined; vi.unstubAllGlobals(); });
async function openCachedPrices(legacy = true) {
  const query = { shopIds: ['a'], search: '已应用关键词', page: 1, pageSize: 50, view: 'sku' };
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/prices', component: PricesPage }, { path: '/shops', component: { template: '<div>账号页</div>' } }] });
  await router.push(legacy ? { path: '/prices', query: { q: JSON.stringify(query) } } : '/prices'); await router.isReady();
  wrapper = mount(defineComponent({ template: '<router-view v-slot="{ Component }"><keep-alive :include="[\'PricesPage\']"><component :is="Component" :key="$route.path" /></keep-alive></router-view>' }), { global: { plugins: [router], stubs } });
  await flushPromises();
  return router;
}
function shopOptions() { return wrapper!.get('[data-label="店铺（可多选）"]').text(); }
it('refreshes shop options on return to the cached page, retaining draft input and applied private filters', async () => {
  const router = await openCachedPrices();
  expect(shopOptions()).toContain('首店'); expect(shopOptions()).not.toContain('新增店');
  await wrapper!.get('[data-label="标题 / 规格关键词"] input').setValue('尚未应用的草稿');
  const before = router.currentRoute.value.query.q;
  await router.push('/shops'); await flushPromises(); shops = [shopA, shopB];
  await router.push({ path: '/prices', query: { q: before } }); await flushPromises();
  expect(shopOptions()).toContain('新增店');
  expect((wrapper!.get('[data-label="标题 / 规格关键词"] input').element as HTMLInputElement).value).toBe('尚未应用的草稿');
  expect(router.currentRoute.value.query.q).toBe(before);
});
it('refresh database reloads shop references as well as price rows', async () => {
  await openCachedPrices(); shops = [shopA, shopB];
  await wrapper!.findAll('button').find(b => b.text() === '刷新数据库')!.trigger('click'); await flushPromises();
  expect(shopOptions()).toContain('新增店');
});
it('opening the shop selector sees shops added elsewhere without resetting the query', async () => {
  const router = await openCachedPrices(); const before = router.currentRoute.value.query.q; shops = [shopA, shopB];
  await wrapper!.get('[data-label="店铺（可多选）"] .test-select').trigger('click'); await flushPromises();
  expect(shopOptions()).toContain('新增店'); expect(router.currentRoute.value.query.q).toBe(before);
});
it('an older reference request cannot overwrite a more recent shop list', async () => {
  let release!: (value: ReturnType<typeof reply>) => void;
  fetcher.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  await openCachedPrices();
  expect(fetcher.mock.calls[0]![0]).toBe('/api/shops');
  shops = [shopA, shopB];
  await wrapper!.get('[data-label="店铺（可多选）"] .test-select').trigger('click'); await flushPromises();
  expect(shopOptions()).toContain('新增店');
  release(reply({ shops: [shopA] })); await flushPromises();
  expect(shopOptions()).toContain('新增店');
});

it('migrates a legacy query URL into private state and never puts applied filters back into the URL', async () => {
  const router = await openCachedPrices();
  expect(router.currentRoute.value.fullPath).toBe('/prices');
  expect((wrapper!.get('[data-label="标题 / 规格关键词"] input').element as HTMLInputElement).value).toBe('已应用关键词');
  await wrapper!.get('[data-label="标题 / 规格关键词"] input').setValue('私有筛选内容');
  await wrapper!.get('form').trigger('submit'); await flushPromises();
  expect(router.currentRoute.value.fullPath).toBe('/prices');
  const sent = fetcher.mock.calls.filter(([url]) => url === '/api/prices/query').at(-1)!;
  expect(JSON.parse(sent[1]!.body!).search).toBe('私有筛选内容');
});
it('restores applied filters on a full remount at a clean URL using this tab session', async () => {
  await openCachedPrices();
  await wrapper!.get('[data-label="标题 / 规格关键词"] input').setValue('刷新后保留');
  await wrapper!.get('form').trigger('submit'); await flushPromises();
  wrapper!.unmount(); wrapper = undefined;
  const router = await openCachedPrices(false);
  expect(router.currentRoute.value.fullPath).toBe('/prices');
  expect((wrapper!.get('[data-label="标题 / 规格关键词"] input').element as HTMLInputElement).value).toBe('刷新后保留');
});
it('uses hidden navigation state when opening a different historical run in the cached page', async () => {
  const router = await openCachedPrices();
  await router.push('/shops'); await flushPromises();
  history.replaceState({ ...history.state, priceQuery: { view: 'sku', runId: 'fixture-run' } }, '');
  await router.push('/prices'); await flushPromises();
  expect(router.currentRoute.value.fullPath).toBe('/prices');
  const sent = fetcher.mock.calls.filter(([url]) => url === '/api/prices/query').at(-1)!;
  expect(JSON.parse(sent[1]!.body!).runId).toBe('fixture-run');
  expect(history.state.priceQuery).toBeNull();
});
it('keeps the URL clean when browser session storage is unavailable', async () => {
  vi.stubGlobal('sessionStorage', { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } });
  const router = await openCachedPrices();
  expect(router.currentRoute.value.fullPath).toBe('/prices');
  expect((wrapper!.get('[data-label="标题 / 规格关键词"] input').element as HTMLInputElement).value).toBe('已应用关键词');
});

it('sorting and pagination update only private query state', async () => {
  const router = await openCachedPrices();
  wrapper!.findComponent({ name: 'PriceGrid' }).vm.$emit('sort', 'after', 'asc'); await flushPromises();
  wrapper!.findComponent({ name: 'ElPagination' }).vm.$emit('current-change', 3); await flushPromises();
  expect(router.currentRoute.value.fullPath).toBe('/prices');
  const sent = fetcher.mock.calls.filter(([url]) => url === '/api/prices/query').at(-1)!;
  expect(JSON.parse(sent[1]!.body!)).toMatchObject({ page: 3, sort: 'after', order: 'asc', search: '已应用关键词' });
});

it('白名单上下文加载独立预警任务并保留 taskId 查询协议', async () => {
  await openCachedPrices();
  expect(fetcher.mock.calls.some(([url]) => url === '/api/alert-tasks')).toBe(true);
  expect(fetcher.mock.calls.some(([url]) => url === '/api/tasks')).toBe(false);
  await wrapper!.findAll('button').find(button => button.text().startsWith('展开高级条件'))!.trigger('click'); await flushPromises();
  const context = wrapper!.get('[data-label="预警任务白名单上下文"]');
  expect(context.text()).toContain('独立低价预警');
  context.findComponent({ name: 'ElSelect' }).vm.$emit('update:modelValue', 'legacy-task-id'); await flushPromises();
  await wrapper!.get('form').trigger('submit'); await flushPromises();
  const sent = fetcher.mock.calls.filter(([url]) => url === '/api/prices/query').at(-1)!;
  expect(JSON.parse(sent[1]!.body!)).toMatchObject({ taskId: 'legacy-task-id' });
});

it('restores session dates in local input fields and keeps applied filters visible with advanced controls collapsed', async () => {
  savePriceQuery({ ...dateRange, runId: 'fixture-run' });
  await openCachedPrices(false);
  const from = wrapper!.get<HTMLInputElement>('[data-label="采集起始时间"] input');
  const to = wrapper!.get<HTMLInputElement>('[data-label="采集截止时间"] input');
  expect(new Date(from.element.value).toISOString()).toBe(dateRange.from);
  expect(new Date(to.element.value).toISOString()).toBe(dateRange.to);
  expect(from.element.value.endsWith('Z')).toBe(false);
  expect(to.element.value.endsWith('Z')).toBe(false);
  await wrapper!.findAll('button').find(button => button.text().startsWith('收起高级条件'))!.trigger('click');
  expect(wrapper!.find('[data-label="采集起始时间"]').exists()).toBe(false);
  expect(wrapper!.text()).toContain('数据批次 fixture-run');
  expect(wrapper!.text()).toContain('采集截止');
  await wrapper!.get('form').trigger('submit'); await flushPromises();
  const sent = fetcher.mock.calls.filter(([url]) => url === '/api/prices/query').at(-1)!;
  expect(JSON.parse(sent[1]!.body!)).toMatchObject(dateRange);
});

it('loads named time filters as local input values and queries the API with absolute timestamps', async () => {
  await openCachedPrices(false);
  wrapper!.findAllComponents({ name: 'ElSelect' }).find(select => select.text() === '日期查询')!.vm.$emit('change', 'named-range');
  await flushPromises();
  const from = wrapper!.get<HTMLInputElement>('[data-label="采集起始时间"] input');
  expect(new Date(from.element.value).toISOString()).toBe(dateRange.from);
  expect(from.element.value.endsWith('Z')).toBe(false);
  const sent = fetcher.mock.calls.filter(([url]) => url === '/api/prices/query').at(-1)!;
  expect(JSON.parse(sent[1]!.body!)).toMatchObject(dateRange);
});
