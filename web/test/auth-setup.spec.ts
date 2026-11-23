import { flushPromises, mount } from '@vue/test-utils';
import ElementPlus from 'element-plus';
import { afterEach, expect, it, vi } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';
import App from '../src/App.vue';

afterEach(() => vi.unstubAllGlobals());

async function openAuth(configured: boolean, setupTokenRequired: boolean) {
  const fetch = vi.fn(async (_url: string, _options: RequestInit) => Response.json({ configured, authenticated: false, setupTokenRequired }));
  vi.stubGlobal('fetch', fetch);
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { render: () => null } }] });
  await router.push('/');
  const wrapper = mount(App, { global: { plugins: [router, ElementPlus] } });
  await flushPromises();
  return { wrapper, fetch };
}

it('shows and submits the setup token when the server requires it', async () => {
  const { wrapper, fetch } = await openAuth(false, true);
  try {
    const [token, password, confirmation] = wrapper.findAll('input[type=password]');
    expect(token?.attributes('placeholder')).toBe('输入初始化令牌');
    await token!.setValue('unit-test-only-setup-token');
    await password!.setValue('long-test-password');
    await confirmation!.setValue('long-test-password');
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    expect(fetch).toHaveBeenCalledWith('/api/auth/setup', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ password: 'long-test-password', setupToken: 'unit-test-only-setup-token' }),
    }));
  } finally {
    wrapper.unmount();
  }
});

it('omits the setup token when signing in with an existing password', async () => {
  const { wrapper, fetch } = await openAuth(true, false);
  try {
    const passwords = wrapper.findAll('input[type=password]');
    expect(passwords).toHaveLength(1);
    await passwords[0]!.setValue('long-test-password');
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    expect(fetch).toHaveBeenCalledWith('/api/auth/login', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ password: 'long-test-password' }),
    }));
  } finally {
    wrapper.unmount();
  }
});
