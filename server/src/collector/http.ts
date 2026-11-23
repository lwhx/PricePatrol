import { setTimeout as delay } from 'node:timers/promises';
import { request } from 'undici';
import { Cookie, type CookieJar } from 'tough-cookie';
import { allowedDomain } from './cookies.js';
import { checkAbort, CollectorError } from './errors.js';
export interface HttpRequest {
    method: 'GET' | 'POST';
    headers: Record<string, string>;
    body?: string;
    signal: AbortSignal;
}
export interface HttpResponse {
    status: number;
    headers: Record<string, string | string[] | undefined>;
    body: string;
    url?: string;
}
export type HttpTransport = (url: string, request: HttpRequest) => Promise<HttpResponse>;
export interface RequestLimiter {
    run<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T>;
}
export class Semaphore implements RequestLimiter {
    private active = 0;
    private readonly waiting: (() => void)[] = [];
    constructor(private readonly max = 5) { }
    async run<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
        checkAbort(signal);
        await new Promise<void>((resolve, reject) => {
            let settled = false;
            const grant = () => { if (settled)
                return; settled = true; signal.removeEventListener('abort', abort); this.active++; resolve(); };
            const abort = () => { if (settled)
                return; settled = true; const index = this.waiting.indexOf(grant); if (index >= 0)
                this.waiting.splice(index, 1); try { checkAbort(signal); } catch (error) { reject(error); } };
            if (this.active < this.max)
                grant();
            else {
                this.waiting.push(grant);
                signal.addEventListener('abort', abort, { once: true });
                if (signal.aborted)
                    abort();
            }
        });
        try {
            checkAbort(signal);
            return await operation();
        }
        finally {
            this.active--;
            this.waiting.shift()?.();
        }
    }
}
export const globalLimiter = new Semaphore(5);
const TRANSIENT_RETRY_DELAY_MS = 250;
const MAX_RETRY_AFTER_MS = 2000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const LOGIN_ORIGINS = new Set(['https://login.taobao.com', 'https://login.tmall.com']);
const LOGIN_PATHS = new Set(['/', '/member/login.jhtml']);

function isLoginRedirect(location: string | string[] | undefined, target: URL): boolean {
    if (typeof location !== 'string' || /[\x00-\x20\x7f\\]/.test(location.trim()))
        return false;
    const url = URL.parse(location, target);
    return url !== null && !url.username && !url.password && LOGIN_ORIGINS.has(url.origin) && LOGIN_PATHS.has(url.pathname);
}

function httpDateMs(value: string, now: number): number {
    const rfc850 = /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), (\d{2})-([A-Z][a-z]{2})-(\d{2}) (\d{2}:\d{2}:\d{2}) GMT$/.exec(value);
    const asctime = /^([A-Z][a-z]{2}) ([A-Z][a-z]{2}) ( \d|\d{2}) (\d{2}:\d{2}:\d{2}) (\d{4})$/.exec(value);
    let canonical = value;
    if (rfc850) {
        const [, weekday, day, month, yearDigits, time] = rfc850;
        const latestYear = new Date(now).getUTCFullYear() + 50;
        const year = latestYear - (latestYear - Number(yearDigits)) % 100;
        const limit = new Date(now);
        limit.setUTCFullYear(latestYear);
        const dateAt = Date.parse(`${day} ${month} ${year} ${time} GMT`);
        canonical = `${weekday.slice(0, 3)}, ${day} ${month} ${dateAt > limit.getTime() ? year - 100 : year} ${time} GMT`;
    }
    else if (asctime) {
        const [, weekday, month, day, time, year] = asctime;
        canonical = `${weekday}, ${day.replace(/^ /, '0')} ${month} ${year} ${time} GMT`;
    }
    if (!/^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(canonical))
        return NaN;
    const leapSecond = canonical.endsWith('23:59:60 GMT');
    const normalized = leapSecond ? canonical.replace(/:60 GMT$/, ':59 GMT') : canonical;
    const date = new Date(normalized);
    return date.toUTCString() === normalized ? date.getTime() + (leapSecond ? 1000 : 0) : NaN;
}

function retryAfterMs(header: string | string[] | undefined): number {
    if (typeof header !== 'string')
        return Infinity;
    const value = header.trim();
    if (/^\d+$/.test(value))
        return Number(value) * 1000;
    const now = Date.now();
    const at = httpDateMs(value, now);
    return Number.isFinite(at) ? Math.max(at - now, 0) : Infinity;
}
async function waitForRetry(ms: number, signal: AbortSignal): Promise<void> {
    try {
        await delay(ms, undefined, { signal });
    }
    catch (error) {
        checkAbort(signal);
        throw error;
    }
}

export const defaultHttpTransport: HttpTransport = async (url, init) => {
    const response = await request(url, { method: init.method, headers: init.headers, body: init.body, signal: init.signal, headersTimeout: 25000, bodyTimeout: 25000 });
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of response.body) {
        size += chunk.length;
        if (size > 20000000) {
            response.body.destroy();
            throw new CollectorError('RESPONSE_TOO_LARGE', '响应内容超过采集上限');
        }
        chunks.push(Buffer.from(chunk));
    }
    const headers = response.headers as Record<string, string | string[] | undefined>;
    const contentType = String(headers['content-type'] ?? '');
    const encoding = /charset\s*=\s*["']?(gbk|gb2312|gb18030)/i.test(contentType) ? 'gb18030' : 'utf-8';
    return { status: response.statusCode, headers, body: new TextDecoder(encoding).decode(Buffer.concat(chunks)), url };
};
export class SessionHttp {
    private readonly principal: string;
    constructor(readonly jar: CookieJar, readonly userAgent: string, private readonly transport: HttpTransport, private readonly limiter: RequestLimiter, private readonly timeoutMs: number) {
        this.principal = this.currentPrincipal();
    }
    private currentPrincipal(): string { return this.jar.getCookiesSync('https://h5api.m.taobao.com/h5/').filter(c => c.key === 'unb').map(c => c.value).join('|'); }
    assertIdentity(): void { if (this.currentPrincipal() !== this.principal)
        throw new CollectorError('IDENTITY_CHANGED', '登录账号发生变化，请重新核验店铺'); }
    async send(url: string, init: {
        method: 'GET' | 'POST';
        body?: string;
        accept?: string;
    }, signal: AbortSignal): Promise<HttpResponse> {
        checkAbort(signal);
        this.assertIdentity();
        const target = new URL(url);
        if (target.protocol !== 'https:' || !allowedDomain(target.hostname) || target.username || target.password)
            throw new CollectorError('INVALID_URL', '请求来源不受支持');
        let retried = false;
        while (true) {
            let response: HttpResponse;
            try {
                response = await this.sendOnce(target, url, init, signal);
            }
            catch (error) {
                checkAbort(signal);
                if (retried || !(error instanceof CollectorError) || !['NETWORK_ERROR', 'TIMEOUT'].includes(error.code))
                    throw error;
                retried = true;
                await waitForRetry(TRANSIENT_RETRY_DELAY_MS, signal);
                continue;
            }
            if (response.status !== 429)
                return response;
            const cooldown = retryAfterMs(response.headers['retry-after'] ?? response.headers['Retry-After']);
            if (retried || cooldown > MAX_RETRY_AFTER_MS)
                throw new CollectorError('RATE_LIMIT', '请求过于频繁，请稍后重试');
            retried = true;
            await waitForRetry(cooldown, signal);
        }
    }
    private sendOnce(target: URL, url: string, init: {
        method: 'GET' | 'POST';
        body?: string;
        accept?: string;
    }, signal: AbortSignal): Promise<HttpResponse> {
        return this.limiter.run(async () => {
            this.assertIdentity();
            const timeout = AbortSignal.timeout(this.timeoutMs);
            const combined = AbortSignal.any([signal, timeout]);
            let response: HttpResponse;
            try {
                response = await this.transport(url, { method: init.method, body: init.body, signal: combined, headers: {
                        'User-Agent': this.userAgent, 'Accept': init.accept ?? 'application/json', 'Accept-Language': 'zh-CN,zh;q=0.9', 'Origin': 'https://qn.taobao.com', 'Referer': 'https://qn.taobao.com/',
                        ...(init.body ? { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' } : {}), Cookie: this.jar.getCookieStringSync(url)
                    } });
            }
            catch (error) {
                checkAbort(signal);
                if (error instanceof CollectorError)
                    throw error;
                const code = (error as {code?:string} | null)?.code;
                const timedOut = timeout.aborted || /^UND_ERR_.*TIMEOUT$/.test(code ?? '');
                throw new CollectorError(timedOut ? 'TIMEOUT' : 'NETWORK_ERROR', timedOut ? '请求超时，请稍后重试' : '采集网络请求失败，请检查出口连接');
            }
            checkAbort(signal);
            checkAbort(timeout);
            const finalUrl = response.url ?? url;
            if (finalUrl !== url) {
                let final: URL;
                try {
                    final = new URL(finalUrl);
                }
                catch {
                    throw new CollectorError('UNSAFE_REDIRECT', '响应跳转无法验证');
                }
                if (final.origin !== target.origin || final.pathname !== target.pathname || final.searchParams.get('id') !== target.searchParams.get('id'))
                    throw new CollectorError('UNSAFE_REDIRECT', '响应跳转来源或商品身份变化');
            }
            if (response.status >= 300 && response.status < 400) {
                const location = response.headers.location ?? response.headers.Location;
                if (REDIRECT_STATUSES.has(response.status) && isLoginRedirect(location, target))
                    throw new CollectorError('AUTH_REQUIRED', '站点要求重新登录，请重新核验会话');
                throw new CollectorError('HTTP_ERROR', '采集接口返回无法核验的跳转');
            }
            const set = response.headers['set-cookie'] ?? response.headers['Set-Cookie'];
            // Each Set-Cookie must remain a separate header: Expires itself contains commas.
            for (const raw of typeof set === 'string' ? [set] : set ?? []) {
                try {
                    const cookie = Cookie.parse(raw);
                    if (cookie && (!cookie.domain || allowedDomain(cookie.domain))) {
                        if (cookie.maxAge !== null) {
                            // Anchor Max-Age to receipt. Jar lookups update lastAccessed.
                            const expiry = cookie.expiryTime(new Date()) ?? Infinity;
                            cookie.expires = expiry === Infinity ? 'Infinity' : new Date(Math.max(0, Math.min(expiry, 8.64e15)));
                            cookie.maxAge = null;
                        }
                        this.jar.setCookieSync(cookie, url);
                    }
                }
                catch { /* Ignore a provider cookie outside the request's valid scope. */ }
            }
            this.assertIdentity();
            if (response.status === 429)
                return response;
            if (response.status === 401 || response.status === 403)
                throw new CollectorError('AUTH_REQUIRED', '会话失效或权限不足，请重新登录');
            if (response.status !== 200)
                throw new CollectorError('HTTP_ERROR', '采集接口返回非成功状态');
            return response;
        }, signal);
    }
}

