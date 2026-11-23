import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { computed, defineComponent, h, inject, provide, ref, watch, type ComputedRef } from 'vue';
import ShopsPage from '../src/pages/ShopsPage.vue';

vi.mock('element-plus', () => ({
  ElMessageBox: { confirm: vi.fn() },
  ElMessage: { success: vi.fn(), error: vi.fn() },
}));

const Box = defineComponent({ setup(_, { slots }) { return () => h('div', slots.default?.()); } });
const Button = defineComponent({
  props: ['disabled', 'type', 'nativeType'], emits: ['click'],
  setup(props, { slots, emit }) { return () => h('button', { type: props.nativeType || 'button', disabled: props.disabled, onClick: () => emit('click') }, slots.default?.()); },
});
const Table = defineComponent({
  props: ['data'],
  setup(props, { slots }) { provide('rows', computed(() => props.data)); return () => h('div', slots.default?.()); },
});
const Column = defineComponent({
  setup(_, { slots }) {
    const rows = inject<ComputedRef<Record<string, unknown>[]>>('rows')!;
    return () => h('div', rows.value.map(row => h('div', { 'data-shop': row.id }, slots.default?.({ row }))));
  },
});
// Element Plus keeps a closed dialog's form mounted. Do the same so resetting only
// when the next dialog opens cannot make the sensitive-field cleanup tests pass.
const Dialog = defineComponent({
  props: ['modelValue', 'title'], emits: ['update:modelValue', 'close'],
  setup(props, { slots, emit }) {
    const closing = ref(false);
    watch(() => props.modelValue, visible => { if (visible) closing.value = false; });
    // X/Escape emit close before the leave animation updates modelValue.
    const close = () => { closing.value = true; emit('close'); };
    return () => h('section', {
      role: 'dialog', hidden: !props.modelValue || closing.value, 'aria-label': props.title,
      onKeydown: (event: KeyboardEvent) => { if (event.key === 'Escape') close(); },
    }, [h('button', { type: 'button', 'aria-label': '关闭', onClick: close }, '×'), slots.default?.(), slots.footer?.()]);
  },
});
const Form = defineComponent({
  emits: ['submit'], setup(_, { slots, emit }) { return () => h('form', { onSubmit: (event: Event) => emit('submit', event) }, slots.default?.()); },
});
const Alert = defineComponent({
  props: ['title'], setup(props) { return () => h('div', { role: 'alert' }, props.title); },
});
const FormItem = defineComponent({
  props: ['label'], setup(props, { slots }) { return () => h('label', [props.label, slots.default?.()]); },
});
const Input = defineComponent({
  inheritAttrs: false, props: ['modelValue', 'type', 'showPassword'], emits: ['update:modelValue'],
  setup(props, { attrs, emit }) {
    return () => h(props.type === 'textarea' ? 'textarea' : 'input', {
      ...attrs, type: props.type === 'textarea' ? undefined : props.type || 'text', value: props.modelValue,
      'data-show-password': props.showPassword ? 'true' : undefined,
      onInput: (event: Event) => emit('update:modelValue', (event.target as HTMLInputElement).value),
    });
  },
});
interface RadioContext { value: ComputedRef<string>; disabled: ComputedRef<boolean>; update: (value: string) => void }
const RadioGroup = defineComponent({
  props: ['modelValue', 'disabled'], emits: ['update:modelValue'],
  setup(props, { slots, emit }) {
    provide('radio', { value: computed(() => props.modelValue), disabled: computed(() => props.disabled), update: (value: string) => emit('update:modelValue', value) });
    return () => h('div', slots.default?.());
  },
});
const RadioButton = defineComponent({
  props: ['value'],
  setup(props, { slots }) {
    const group = inject<RadioContext>('radio')!;
    return () => h('label', [h('input', {
      type: 'radio', value: props.value, checked: group.value.value === props.value, disabled: group.disabled.value,
      onChange: () => group.update(props.value),
    }), slots.default?.()]);
  },
});

interface Request { url: string; method: string; body?: Record<string, unknown> }
const proxy = 'socks5://fixture-user:fixture-password@proxy.invalid:1080';
const secrets = { cookies: 'cookie2=fixture-cookie', userAgent: 'Fixture user agent', appKey: 'fixture_key-2026', proxy };
let wrapper: VueWrapper | undefined;
afterEach(() => { wrapper?.unmount(); wrapper = undefined; vi.unstubAllGlobals(); vi.clearAllMocks(); });

async function setup(options: { hasProxy?: boolean; mutationError?: boolean; legacyProxy?: string } = {}) {
  const requests: Request[] = [];
  const shop = {
    id: 'fixture-shop', name: '代理测试店', sellerId: 'fixture-seller', platform: 'tmall', enabled: true,
    sessionStatus: 'valid', hasCookies: true, hasProxy: options.hasProxy ?? true,
    lastVerifiedAt: null, lastError: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    ...(options.legacyProxy ? { proxy: options.legacyProxy } : {}),
  };
  vi.stubGlobal('fetch', async (url: string, init: { method?: string; body?: string } = {}) => {
    const method = init.method || 'GET';
    requests.push({ url, method, ...(init.body ? { body: JSON.parse(init.body) as Record<string, unknown> } : {}) });
    const failed = method !== 'GET' && options.mutationError;
    return {
      ok: !failed, status: failed ? 400 : 200,
      text: async () => JSON.stringify(failed ? { error: '测试核验失败，请修正配置' } : method === 'GET' ? { shops: [shop] } : { shop }),
    };
  });
  wrapper = mount(ShopsPage, { global: {
    stubs: {
      PageHeader: Box, StatusTag: true, RemoteLogin: true, ElButton: Button, ElTable: Table, ElTableColumn: Column,
      ElTag: Box, ElAlert: Alert, ElDropdown: Box, ElDropdownItem: true, ElDropdownMenu: true, ElDialog: Dialog,
      ElInput: Input, ElForm: Form, ElFormItem: FormItem, ElRadioGroup: RadioGroup, ElRadioButton: RadioButton,
    }, directives: { loading: () => {} },
  } });
  await flushPromises();
  return requests;
}
function button(text: string) {
  const result = wrapper!.findAll('button').find(item => item.text() === text);
  expect(result, `button ${text}`).toBeDefined();
  return result!;
}
function field(label: string) {
  const item = wrapper!.findAll('label').find(item => item.text().startsWith(label) && item.find('input:not([type="radio"]),textarea').exists());
  expect(item, `input ${label}`).toBeDefined();
  return item!.get<HTMLInputElement | HTMLTextAreaElement>('input:not([type="radio"]),textarea');
}
async function openEdit() { await button('更新凭据').trigger('click'); }
async function chooseProxy(action: 'keep' | 'replace' | 'direct') {
  const input = wrapper!.find<HTMLInputElement>(`input[type="radio"][value="${action}"]`);
  expect(input.exists(), `proxy action ${action}`).toBe(true);
  await input.setValue(true);
}
async function submit() { await button('核验并保存').trigger('click'); await flushPromises(); }
function mutations(requests: Request[]) { return requests.filter(request => request.method !== 'GET'); }
async function fillSecrets() {
  await field('更新 Cookie').setValue(secrets.cookies);
  await field('User-Agent').setValue(secrets.userAgent);
  await field('App Key').setValue(secrets.appKey);
  await chooseProxy('replace');
  await field('代理地址').setValue(proxy);
}
function expectCleared() {
  for (const input of wrapper!.findAll<HTMLInputElement | HTMLTextAreaElement>('input:not([type="radio"]),textarea')) {
    expect(Object.values(secrets)).not.toContain(input.element.value);
  }
  expect(field('更新 Cookie').element.value).toBe('');
  expect(field('User-Agent').element.value).toBe('');
  expect(field('App Key').element.value).toBe('');
  expect(field('代理地址').element.value).toBe('');
}

describe('shop proxy configuration', () => {
  it('uses only the public configured flag and never fills an existing proxy URL', async () => {
    await setup({ legacyProxy: proxy });
    expect(wrapper!.find('[data-shop="fixture-shop"]').exists()).toBe(true);
    expect(wrapper!.text()).toContain('代理已配置');
    await openEdit();
    expect(wrapper!.get<HTMLInputElement>('input[value="keep"]').element.checked).toBe(true);
    await chooseProxy('replace');
    expect(field('代理地址').element.value).toBe('');
    expect(wrapper!.html()).not.toContain(proxy);
    expect(wrapper!.text()).not.toContain('fixture-password');
  });

  it('defaults to preserving an existing proxy by omitting it from PATCH', async () => {
    const requests = await setup(); await openEdit();
    expect(wrapper!.get<HTMLInputElement>('input[value="keep"]').element.checked).toBe(true);
    await submit();
    expect(mutations(requests)).toEqual([{ url: '/api/shops/fixture-shop', method: 'PATCH', body: { name: '代理测试店' } }]);
  });

  it('leaves the existing proxy unchanged when replacement input is empty', async () => {
    const requests = await setup(); await openEdit(); await chooseProxy('replace');
    await field('代理地址').setValue('   '); await submit();
    expect(mutations(requests)[0].body).not.toHaveProperty('proxy');
  });

  it('sends a masked replacement URL and clears secrets after success', async () => {
    const requests = await setup(); await openEdit(); await fillSecrets();
    expect(field('代理地址').attributes('type')).toBe('password');
    expect(field('代理地址').attributes('data-show-password')).toBeUndefined();
    await submit();
    expect(mutations(requests)).toEqual([{ url: '/api/shops/fixture-shop', method: 'PATCH', body: { name: '代理测试店', ...secrets } }]);
    expect(wrapper!.get('[role="dialog"]').attributes('hidden')).toBeDefined();
    expectCleared();
  });

  it('sends explicit null to restore a direct connection even after entering a replacement', async () => {
    const requests = await setup(); await openEdit(); await chooseProxy('replace');
    await field('代理地址').setValue(proxy); await chooseProxy('direct'); await submit();
    expect(mutations(requests)[0]).toEqual({ url: '/api/shops/fixture-shop', method: 'PATCH', body: { name: '代理测试店', proxy: null } });
    expect(JSON.stringify(mutations(requests))).not.toContain('fixture-password');
  });

  it('omits a draft replacement after switching back to keep', async () => {
    const requests = await setup(); await openEdit(); await chooseProxy('replace');
    await field('代理地址').setValue(proxy); await chooseProxy('keep'); await submit();
    expect(mutations(requests)[0].body).not.toHaveProperty('proxy');
  });

  it.each([undefined, proxy])('imports a new account with an optional proxy (%s)', async (value) => {
    const requests = await setup({ hasProxy: false }); await button('＋ 导入账号 Cookie').trigger('click');
    await field('Cookie 字符串').setValue(secrets.cookies);
    expect(field('代理地址').attributes('type')).toBe('password');
    if (value) await field('代理地址').setValue(` ${value} `);
    await submit();
    expect(mutations(requests)).toEqual([{ url: '/api/shops', method: 'POST', body: { platform: 'tmall', cookies: secrets.cookies, ...(value ? { proxy: value } : {}) } }]);
    expect(field('Cookie 字符串').element.value).toBe('');
    expect(field('代理地址').element.value).toBe('');
  });

  it.each(['取消', '关闭', 'Escape'])('clears all sensitive fields immediately on %s, without waiting for a closed animation', async (exit) => {
    const requests = await setup(); await openEdit(); await fillSecrets();
    if (exit === 'Escape') await wrapper!.get('[role="dialog"]').trigger('keydown', { key: 'Escape' });
    else if (exit === '关闭') await wrapper!.get('button[aria-label="关闭"]').trigger('click');
    else await button(exit).trigger('click');
    expect(wrapper!.get('[role="dialog"]').attributes('hidden')).toBeDefined();
    expectCleared();
    expect(mutations(requests)).toEqual([]);
    if (exit !== '取消') wrapper!.findComponent(Dialog).vm.$emit('update:modelValue', false);
    await flushPromises();
    await openEdit();
    expect(wrapper!.get<HTMLInputElement>('input[value="keep"]').element.checked).toBe(true);
    await chooseProxy('replace');
    expectCleared();
  });

  it('keeps submitted secrets for correction after a failed save, then clears them on close', async () => {
    const requests = await setup({ mutationError: true }); await openEdit(); await fillSecrets(); await submit();
    expect(mutations(requests)).toHaveLength(1);
    expect(wrapper!.get('[role="dialog"]').attributes('hidden')).toBeUndefined();
    expect(wrapper!.findAll('[role="alert"]').some(item => item.text().includes('测试核验失败'))).toBe(true);
    expect(field('更新 Cookie').element.value).toBe(secrets.cookies);
    expect(field('User-Agent').element.value).toBe(secrets.userAgent);
    expect(field('App Key').element.value).toBe(secrets.appKey);
    expect(field('代理地址').element.value).toBe(proxy);
    await button('取消').trigger('click');
    expectCleared();
  });
});
