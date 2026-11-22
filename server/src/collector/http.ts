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
                this.waiting.splice(index, 1); reject(new CollectorError('ABORTED', '采集已停止')); };
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
        return this.limiter.run(async () => {
            const timeout = AbortSignal.timeout(this.timeoutMs);
            const combined = AbortSignal.any([signal, timeout]);
            let response: HttpResponse;
            try {
                response = await this.transport(url, { method: init.method, body: init.body, signal: combined, headers: {
                        'User-Agent': this.userAgent, 'Accept': init.accept ?? 'application/json', 'Origin': 'https://qn.taobao.com', 'Referer': 'https://qn.taobao.com/',
                        ...(init.body ? { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' } : {}), Cookie: this.jar.getCookieStringSync(url)
                    } });
            }
            catch (error) {
                checkAbort(signal);
                if (error instanceof CollectorError)
                    throw error;
                throw new CollectorError(timeout.aborted ? 'TIMEOUT' : 'NETWORK_ERROR', timeout.aborted ? '请求超时，请稍后重试' : '采集网络请求失败，请检查出口连接');
            }
            checkAbort(signal);
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
            const set = response.headers['set-cookie'] ?? response.headers['Set-Cookie'];
            // Each Set-Cookie must remain a separate header: Expires itself contains commas.
            for (const raw of typeof set === 'string' ? [set] : set ?? []) {
                try {
                    const cookie = Cookie.parse(raw);
                    if (cookie && (!cookie.domain || allowedDomain(cookie.domain)))
                        this.jar.setCookieSync(cookie, url);
                }
                catch { /* Ignore a provider cookie outside the request's valid scope. */ }
            }
            this.assertIdentity();
            if (response.status === 429)
                throw new CollectorError('RATE_LIMIT', '请求过于频繁，请稍后重试');
            if (response.status === 401 || response.status === 403)
                throw new CollectorError('AUTH_REQUIRED', '会话失效或权限不足，请重新登录');
            if (response.status >= 300 && response.status < 400)
                throw new CollectorError('AUTH_REQUIRED', '站点要求跳转或登录验证，请重新核验会话');
            if (response.status !== 200)
                throw new CollectorError('HTTP_ERROR', '采集接口返回非成功状态');
            return response;
        }, signal);
    }
}

