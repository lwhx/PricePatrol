import {randomUUID} from 'node:crypto';
import {chromium, type Browser, type BrowserContext, type Page} from 'playwright';
import type {CookieRecord, Platform} from '../../../shared/contracts.js';

const VIEWPORT = {width: 1280, height: 800};
const IDLE_TTL_MS = 10 * 60_000;
const MAX_SESSIONS = 5;
const LOGIN_URLS: Record<Platform, string> = {
  taobao: 'https://login.taobao.com/member/login.jhtml',
  tmall: 'https://login.tmall.com/',
};
const ALLOWED_KEYS = new Set(['Enter', 'Tab', 'Shift+Tab', 'Backspace', 'Delete', 'Escape', 'Space',
  'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown', 'Control+A', 'Meta+A']);

export interface LoginAction {type: 'click'|'type'|'press'|'drag'; x?: number; y?: number; x2?: number; y2?: number; text?: string; key?: string}
interface LoginSession {context: BrowserContext; page: Page; touchedAt: number; tail: Promise<unknown>}

// Only messages constructed here are safe to expose through the API handler.
class BrowserLoginError extends Error {readonly statusCode = 400;}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const inViewport = (x: unknown, y: unknown): boolean =>
  Number.isFinite(x) && Number.isFinite(y) && (x as number) >= 0 && (y as number) >= 0 &&
  (x as number) < VIEWPORT.width && (y as number) < VIEWPORT.height;

function validateAction(value: LoginAction): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BrowserLoginError('登录操作格式无效');
  const fields = value.type === 'click' ? ['type', 'x', 'y']
    : value.type === 'type' ? ['type', 'text']
    : value.type === 'press' ? ['type', 'key']
    : value.type === 'drag' ? ['type', 'x', 'y', 'x2', 'y2'] : [];
  if (!fields.length || Object.keys(value).length !== fields.length || Object.keys(value).some(key => !fields.includes(key))) throw new BrowserLoginError('登录操作格式无效');
  if (value.type === 'click' && !inViewport(value.x, value.y)) throw new BrowserLoginError('点击坐标超出登录画面');
  if (value.type === 'drag' && (!inViewport(value.x, value.y) || !inViewport(value.x2, value.y2))) throw new BrowserLoginError('拖动坐标超出登录画面');
  if (value.type === 'type' && (typeof value.text !== 'string' || !value.text.length || value.text.length > 4096 || value.text.includes('\0'))) throw new BrowserLoginError('输入内容须为1至4096字符');
  if (value.type === 'press' && (typeof value.key !== 'string' || !ALLOWED_KEYS.has(value.key))) throw new BrowserLoginError('不支持该登录按键');
}

/** In-memory contexts only; dataDir belongs to the parent encrypted account store. */
export class BrowserLoginService {
  private readonly sessions = new Map<string, LoginSession>();
  private readonly creations = new Set<Promise<{id: string}>>();
  private browserPromise?: Promise<Browser>;
  private stopped = false;
  private readonly sweep: ReturnType<typeof setInterval>;

  constructor(options: {dataDir: string}) {
    if (!options || typeof options.dataDir !== 'string' || !options.dataDir.trim()) throw new BrowserLoginError('登录服务数据目录无效');
    this.sweep = setInterval(() => {
      for (const [id, session] of this.sessions) {
        if (Date.now() - session.touchedAt >= IDLE_TTL_MS) void this.close(id);
      }
    }, 30_000);
    this.sweep.unref?.();
  }

  private browser(): Promise<Browser> {
    if (!this.browserPromise) {
      const pending: Promise<Browser> = chromium.launch({headless: true, timeout: 20_000}).then(browser => {
        browser.on('disconnected', () => {
          if (this.browserPromise === pending) {
            this.browserPromise = undefined;
            this.sessions.clear();
          }
        });
        return browser;
      }).catch(() => {
        if (this.browserPromise === pending) this.browserPromise = undefined;
        throw new BrowserLoginError('浏览器登录依赖不可用，请运行 npx playwright install chromium；Linux 请使用 npx playwright install --with-deps chromium 安装系统依赖');
      });
      this.browserPromise = pending;
    }
    return this.browserPromise;
  }

  async create(platform: Platform): Promise<{id: string}> {
    if (platform !== 'taobao' && platform !== 'tmall') throw new BrowserLoginError('不支持的店铺平台');
    if (this.stopped) throw new BrowserLoginError('浏览器登录服务已关闭');
    if (this.sessions.size + this.creations.size >= MAX_SESSIONS) throw new BrowserLoginError('登录会话已达上限，请先关闭其他登录画面');
    const pending = this.createSession(platform);
    this.creations.add(pending);
    try { return await pending; } finally { this.creations.delete(pending); }
  }

  private async createSession(platform: Platform): Promise<{id: string}> {
    const browser = await this.browser();
    let context: BrowserContext | undefined;
    try {
      context = await browser.newContext({viewport: VIEWPORT, locale: 'zh-CN', acceptDownloads: false});
      context.setDefaultTimeout(10_000);
      const page = await context.newPage();
      await page.goto(LOGIN_URLS[platform], {waitUntil: 'domcontentloaded', timeout: 25_000});
      if (this.stopped) throw new BrowserLoginError('Service stopped');
      const session: LoginSession = {context, page, touchedAt: Date.now(), tail: Promise.resolve()};
      this.watchPopups(session, page);
      const id = randomUUID();
      this.sessions.set(id, session);
      return {id};
    } catch {
      await context?.close().catch(() => undefined);
      throw new BrowserLoginError('无法打开浏览器登录页面，请检查网络或稍后重试');
    }
  }

  private watchPopups(session: LoginSession, page: Page): void {
    page.on('popup', popup => {
      const previous = session.page;
      session.page = popup;
      this.watchPopups(session, popup);
      popup.on('close', () => { if (!previous.isClosed()) session.page = previous; });
    });
  }

  private session(id: string): LoginSession {
    const session = this.sessions.get(id);
    if (!session || Date.now() - session.touchedAt >= IDLE_TTL_MS) {
      if (session) void this.close(id);
      throw new BrowserLoginError('登录会话不存在或已过期，请重新创建');
    }
    session.touchedAt = Date.now();
    return session;
  }

  private async run<T>(id: string, operation: (session: LoginSession) => Promise<T>): Promise<T> {
    const session = this.session(id);
    const pending = session.tail.then(() => operation(session));
    session.tail = pending.catch(() => undefined);
    try { return await pending; } catch {
      throw new BrowserLoginError('浏览器登录操作失败，请刷新画面或重新创建会话');
    }
  }

  async screenshot(id: string): Promise<Buffer> {
    return this.run(id, session => session.page.screenshot({type: 'png', fullPage: false, timeout: 10_000}));
  }

  /** 拟人拖拽：加速—减速轨迹并带轻微纵向抖动，避免滑块风控判定为机器直线拖动。 */
  private async drag(session: LoginSession, from: {x: number; y: number}, to: {x: number; y: number}): Promise<void> {
    const page = session.page;
    const steps = Math.max(12, Math.min(40, Math.round(Math.hypot(to.x - from.x, to.y - from.y) / 8)));
    await page.mouse.move(from.x, from.y);
    await sleep(90 + Math.random() * 120);
    await page.mouse.down();
    await sleep(60 + Math.random() * 90);
    for (let step = 1; step <= steps; step++) {
      const ratio = step / steps;
      // easeInOutQuad：起手慢、中段快、收尾慢，接近人工滑动的手感。
      const eased = ratio < 0.5 ? 2 * ratio * ratio : 1 - Math.pow(-2 * ratio + 2, 2) / 2;
      const jitter = Math.sin(ratio * Math.PI) * (Math.random() - 0.5) * 2.4;
      await page.mouse.move(
        Math.round(from.x + (to.x - from.x) * eased),
        Math.round(from.y + (to.y - from.y) * eased + jitter),
      );
      await sleep(12 + Math.random() * 22);
    }
    await page.mouse.move(to.x, to.y);
    await sleep(120 + Math.random() * 160);
    await page.mouse.up();
  }

  async action(id: string, action: LoginAction): Promise<void> {
    validateAction(action);
    await this.run(id, async session => {
      if (action.type === 'click') await session.page.mouse.click(action.x!, action.y!);
      // 与真实键盘一致：逐字符发送 keydown/keypress/input 事件。淘宝登录页等自定义组件
      // 监听键盘事件而非仅读 value，insertText 只改 DOM 不触发监听，表现为“打不进字”。
      if (action.type === 'type') for (const character of action.text!) await session.page.keyboard.type(character, {delay: 25});
      if (action.type === 'press') await session.page.keyboard.press(action.key!);
      // 滑块验证必须按下并移动（mouse.move），单纯 click 或设置 value 都不会触发校验。
      if (action.type === 'drag') await this.drag(session, {x: action.x!, y: action.y!}, {x: action.x2!, y: action.y2!});
    });
  }

  async cookies(id: string): Promise<CookieRecord[]> {
    return this.run(id, async session => (await session.context.cookies()).map(cookie => ({
      name: cookie.name, value: cookie.value, domain: cookie.domain, path: cookie.path,
      ...(cookie.expires > 0 ? {expires: cookie.expires, expirationDate: cookie.expires} : {session: true}),
      secure: cookie.secure, httpOnly: cookie.httpOnly, sameSite: cookie.sameSite,
    })));
  }

  async close(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return;
    this.sessions.delete(id);
    await session.tail;
    await session.context.close().catch(() => undefined);
  }

  async closeAll(): Promise<void> {
    this.stopped = true;
    clearInterval(this.sweep);
    await Promise.allSettled([...this.creations]);
    await Promise.all([...this.sessions.keys()].map(id => this.close(id)));
    const browser = await this.browserPromise?.catch(() => undefined);
    this.browserPromise = undefined;
    await browser?.close().catch(() => undefined);
  }
}
