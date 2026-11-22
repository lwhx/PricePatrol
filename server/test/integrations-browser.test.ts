import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium, type Browser, type BrowserContext, type Page} from 'playwright';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {BrowserLoginService} from '../src/integrations/browser-login.js';

// Chromium is the external boundary: these tests exercise our isolation,
// validation and resource lifecycle without contacting a merchant account.
function browserBoundary() {
  const contexts: {context: BrowserContext; page: Page; closed: boolean; events: string[]; typed: string[]; cookieValue: string}[] = [];
  const browser = {
    isConnected: () => true,
    close: vi.fn(async () => undefined),
    on: vi.fn(),
    newContext: vi.fn(async (options: {acceptDownloads?: boolean}) => {
      expect(options.acceptDownloads).toBe(false);
      const record = {context: null as unknown as BrowserContext, page: null as unknown as Page, closed: false, events: [] as string[], typed: [] as string[], cookieValue: `session-${contexts.length}`};
      record.page = {
        goto: vi.fn(async (url: string) => { record.events.push(url); }),
        screenshot: vi.fn(async (options: {type: string}) => {
          expect(options.type).toBe('png');
          return Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
        }),
        mouse: {click: vi.fn(async (x: number, y: number) => {record.events.push(`click:${x},${y}`);})},
        keyboard: {
          insertText: vi.fn(async (text: string) => {record.typed.push(text);}),
          type: vi.fn(async (text: string, options?: {delay?: number}) => {expect(options?.delay).toBeGreaterThan(0);record.typed.push(text);}),
          press: vi.fn(async (key: string) => {record.events.push(`press:${key}`);}),
        },
        on: vi.fn(),
        isClosed: () => false,
      } as unknown as Page;
      record.context = {
        newPage: vi.fn(async () => record.page),
        cookies: vi.fn(async () => [{name: 'sid', value: record.cookieValue, domain: '.taobao.com', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax'}]),
        close: vi.fn(async () => { record.closed = true; }),
        setDefaultTimeout: vi.fn(),
        on: vi.fn(),
      } as unknown as BrowserContext;
      contexts.push(record);
      return record.context;
    }),
  } as unknown as Browser;
  vi.spyOn(chromium, 'launch').mockResolvedValue(browser);
  return {browser, contexts};
}

let service: BrowserLoginService;
beforeEach(() => { service = new BrowserLoginService({dataDir: 'unused-private-data-dir'}); });
afterEach(async () => {
  await service.closeAll();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('网页登录辅助的隔离、验证及生命周期', () => {
  it('账号使用独立context及随机ID，Cookie不串号', async () => {
    const {contexts} = browserBoundary();
    const first = await service.create('taobao');
    const second = await service.create('tmall');
    expect(first.id).not.toBe(second.id);
    expect(first.id.length).toBeGreaterThanOrEqual(32);
    expect(contexts).toHaveLength(2);
    expect(contexts[0].events[0]).toMatch(/^https:\/\/(login\.taobao\.com|myseller\.taobao\.com)\//);
    expect(contexts[1].events[0]).toMatch(/^https:\/\/(login\.tmall\.com|myseller\.taobao\.com|seller\.tmall\.com)\//);
    expect((await service.cookies(first.id))[0].value).toBe('session-0');
    expect((await service.cookies(second.id))[0].value).toBe('session-1');
    expect((await service.cookies(first.id))[0]).toMatchObject({name: 'sid', domain: '.taobao.com', session: true});
    await service.close(first.id);
    expect(contexts[0].closed).toBe(true);
    expect(contexts[1].closed).toBe(false);
    await expect(service.cookies(first.id)).rejects.toThrow(/不存在|过期/);
  });

  it('PNG截图、坐标点击、手动输入和按键作用于所选会话', async () => {
    const {contexts} = browserBoundary();
    const {id} = await service.create('taobao');
    expect((await service.screenshot(id)).subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    await service.action(id, {type: 'click', x: 12, y: 34});
    await service.action(id, {type: 'type', text: '用户手动输入验证码'});
    await service.action(id, {type: 'press', key: 'Enter'});
    expect(contexts[0].events.slice(1)).toEqual(['click:12,34', 'press:Enter']);
    expect(contexts[0].typed).toEqual('用户手动输入验证码'.split(''));
  });

  it.each([
    {type: 'click', x: -1, y: 0}, {type: 'click', x: NaN, y: 0}, {type: 'click', x: 0, y: Infinity},
    {type: 'click', x: 1280, y: 0}, {type: 'click', x: 0, y: 800}, {type: 'click', x: 1},
    {type: 'type', text: 'x'.repeat(4097)}, {type: 'type', text: ''}, {type: 'type', text: 123},
    {type: 'press', key: 'F12'}, {type: 'press', key: ''}, {type: 'press', key: 'Enter', text: 'unexpected'},
    {type: 'evaluate', text: 'document.cookie'}, {type: 'click', x: 1, y: 2, script: 'anything'}, null,
  ])('拒绝非法事件且不发送到页面：%j', async action => {
    const {contexts} = browserBoundary();
    const {id} = await service.create('taobao');
    await expect(service.action(id, action as never)).rejects.toThrow(/操作|坐标|输入|按键/);
    expect(contexts[0].events).toHaveLength(1);
    expect(contexts[0].typed).toHaveLength(0);
  });

  it('不支持的平台在启动浏览器前报错', async () => {
    const {contexts} = browserBoundary();
    await expect(service.create('other' as never)).rejects.toThrow(/平台/);
    expect(contexts).toHaveLength(0);
  });

  it('本机缺少Chromium时返回中文安装指引且不包含底层异常', async () => {
    vi.spyOn(chromium, 'launch').mockRejectedValue(new Error('Executable missing: private-path-and-cookie'));
    const error = await service.create('taobao').catch(error => error);
    expect(String(error)).toMatch(/npx playwright install chromium/);
    expect(String(error)).not.toContain('private-path-and-cookie');
    expect(error.cause).toBeUndefined();
    // The API exposes only explicitly safe 4xx errors; preserve this install hint.
    expect(error.statusCode).toBe(400);
  });

  it('创建失败清理context，不保留泄密异常', async () => {
    const {contexts} = browserBoundary();
    const original = (await chromium.launch()).newContext.bind(await chromium.launch());
    vi.spyOn(await chromium.launch(), 'newContext').mockImplementation(async options => {
      const context = await original(options);
      vi.spyOn(context, 'newPage').mockRejectedValue(new Error('cookie=secret'));
      return context;
    });
    await expect(service.create('taobao')).rejects.toThrow(/浏览器|登录/);
    expect(contexts[0].closed).toBe(true);
  });

  it('空闲10分钟回收，合法操作刷新TTL，关闭全部释放浏览器', async () => {
    vi.useFakeTimers();
    // Recreate after fake timers so the actual sweep timer is controlled.
    await service.closeAll();
    service = new BrowserLoginService({dataDir: 'unused'});
    const {browser, contexts} = browserBoundary();
    const first = await service.create('taobao');
    const second = await service.create('tmall');
    await vi.advanceTimersByTimeAsync(9 * 60_000);
    await service.screenshot(second.id);
    await vi.advanceTimersByTimeAsync(61_000);
    expect(contexts[0].closed).toBe(true);
    expect(contexts[1].closed).toBe(false);
    await expect(service.screenshot(first.id)).rejects.toThrow(/不存在|过期/);
    await service.closeAll();
    expect(contexts[1].closed).toBe(true);
    expect(browser.close).toHaveBeenCalled();
  });

  it('并发创建只启动一次浏览器，close幂等', async () => {
    const {contexts} = browserBoundary();
    const sessions = await Promise.all([service.create('taobao'), service.create('taobao')]);
    expect(chromium.launch).toHaveBeenCalledTimes(1);
    expect(contexts).toHaveLength(2);
    await service.close(sessions[0].id);
    await service.close(sessions[0].id);
  });

  it('未知会话无法读取截图、执行事件或导出Cookie', async () => {
    await expect(service.screenshot('unknown')).rejects.toThrow(/不存在|过期/);
    await expect(service.action('unknown', {type: 'press', key: 'Enter'})).rejects.toThrow(/不存在|过期/);
    await expect(service.cookies('unknown')).rejects.toThrow(/不存在|过期/);
  });
});

// RUN_BROWSER_TESTS=1 enables the real Chromium path in CI/local verification.
// Merchant HTTP is intercepted with a fixture; this never claims a real login.
describe.runIf(process.env.RUN_BROWSER_TESTS === '1')('真实Chromium本地页面交互', () => {
  it('截图真实PNG，点击输入表单并仅导出本会话Cookie', async () => {
    const dataDir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), 'price-monitor-browser-'));
    await service.closeAll();
    service = new BrowserLoginService({dataDir});
    const launch = chromium.launch.bind(chromium);
    vi.spyOn(chromium, 'launch').mockImplementation(async options => {
      const browser = await launch(options);
      const newContext = browser.newContext.bind(browser);
      vi.spyOn(browser, 'newContext').mockImplementation(async contextOptions => {
        const context = await newContext(contextOptions);
        await context.route('**/*', route => route.fulfill({contentType: 'text/html', body: '<html><body style="margin:0"><input style="position:absolute;left:0;top:0;width:200px;height:80px" oninput="document.cookie=\'manual=\'+this.value+\';path=/;SameSite=Lax\'"></body></html>'}));
        return context;
      });
      return browser;
    });
    try {
      const first = await service.create('taobao');
      const second = await service.create('taobao');
      await service.action(first.id, {type: 'click', x: 40, y: 30});
      await service.action(first.id, {type: 'type', text: 'verified'});
      await service.action(first.id, {type: 'press', key: 'Tab'});
      const png = await service.screenshot(first.id);
      expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      expect(png.length).toBeGreaterThan(1000);
      expect(await service.cookies(first.id)).toContainEqual(expect.objectContaining({name: 'manual', value: 'verified'}));
      expect(await service.cookies(second.id)).not.toContainEqual(expect.objectContaining({name: 'manual'}));
    } finally {
      await service.closeAll();
      await rm(dataDir, {recursive: true, force: true});
    }
  }, 30000);
});
