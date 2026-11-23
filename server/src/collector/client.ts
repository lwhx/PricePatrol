import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import type { AccountCredentials, Platform } from '../../../shared/contracts.js';
import { importCookies } from './cookies.js';
import { checkAbort, CollectorError } from './errors.js';
import { defaultHttpTransport, globalLimiter, SessionHttp, type HttpTransport, type RequestLimiter } from './http.js';
const require = createRequire(import.meta.url);
export const core = require('./vendor/core.cjs');
export const backend = require('./vendor/backend.cjs');
export const platforms = require('./vendor/platform.cjs');
const tokenName = ['_m_h5_', 'tk'].join('');
const wireMoneyFields = new Set(['price', 'priceText', 'priceMoney']);
export const validId = (v: unknown): v is string => typeof v === 'string' && /^[1-9]\d{5,19}$/.test(v);
const sellerId = (v: unknown): string => typeof v === 'string' && /^\d{1,20}$/.test(v) ? v : typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? String(v) : '';
const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
interface PlatformInfo {
    id: Platform;
    api: string;
    route: string;
    detailHost: string;
}
export interface BackendProduct {
    productId: string;
    title: string;
    raw: any;
}
export interface Page {
    current: number;
    pageSize: number;
    total: number;
    products: BackendProduct[];
    at: string;
}
export interface CollectorConfiguration {
    transport?: HttpTransport;
    limiter?: RequestLimiter;
    now?: () => number;
    timeoutMs?: number;
}
export function fail(code: string, message: string): never { throw new CollectorError(code, message); }
function parseProviderJson(source: string): any {
    // Node 24 exposes the wire token for primitives before Number rounding.
    return JSON.parse(source, (key, value, context?: {source?: string}) => {
        if (typeof value !== 'number' || !wireMoneyFields.has(key))
            return value;
        if (context?.source === undefined)
            fail('INVALID_RESPONSE', '接口金额缺少可核验的原始数值');
        return context.source;
    });
}
function objectJson(value: unknown): any {
    if (typeof value === 'string') {
        try {
            return parseProviderJson(value);
        }
        catch {
            fail('INVALID_RESPONSE', '接口返回的数据无法解析');
        }
    }
    return value;
}
function businessFailure(value: any): void {
    const retCodes = Array.isArray(value?.ret) ? value.ret.filter((r: unknown) => typeof r === 'string').map((r: string) => r.split('::', 1)[0]) : [];
    const codes = [value?.code, value?.errorCode, value?.subCode, value?.status, ...retCodes];
    const code = codes.map(part => String(part ?? '').split('::', 1)[0]).join(' ');
    const message = [value?.message, value?.msg, value?.errorMsg].join(' ');
    if (/LIMIT|FREQUENCY|TRAFFIC|FLOOD|RGV587/i.test(code))
        fail('RATE_LIMIT', '接口访问频繁，请稍后重试');
    const explicitAuth = /TOKEN|SESSION|PERMISSION|AUTH|LOGIN|ILLEGAL_ACCESS|ACCESS_DENIED|INVALID_USER|USER_VALIDATE|SECURITY|RGV|FORBIDDEN|\b(?:401|403)\b/i.test(code);
    const authMessage = /未登录|请[^。；，]{0,12}登录|登录[^。；，]{0,8}(?:失效|过期)|(?:没有|缺少|无|不足)[^。；，]{0,8}权限|权限不足|(?:需要|请完成)人工验证/.test(message);
    if (explicitAuth || (value?.success !== true && !retCodes.includes('SUCCESS') && authMessage))
        fail('AUTH_REQUIRED', '会话失效、需要人工验证或没有商品读取权限');
}
function normalizePage(reply: any, current: number, platform: PlatformInfo, at: string): Page {
    businessFailure(reply);
    const result = objectJson(reply?.data?.result);
    businessFailure(result);
    if (!Array.isArray(reply?.ret) || !reply.ret.length || !reply.ret.every((r: unknown) => typeof r === 'string' && /^SUCCESS(?:::.*)?$/.test(r)))
        fail('MTOP_FAILED', '后台接口没有返回成功状态');
    if (result?.success !== true)
        fail('BUSINESS_FAILED', '后台业务查询没有成功');
    const page = result?.data?.pagination, source = result?.data?.table?.dataSource;
    const integer = (v: unknown) => typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : NaN;
    const actual = integer(page?.current), pageSize = integer(page?.pageSize), total = integer(page?.total);
    if (![actual, pageSize, total].every(Number.isSafeInteger) || actual !== current || pageSize < 1 || pageSize > 1000 || total < 0 || !Array.isArray(source))
        fail('INVALID_RESPONSE', '后台分页或商品数据格式无效');
    const wanted = Math.max(0, Math.min(pageSize, total - (current - 1) * pageSize));
    if (source.length !== wanted || current > Math.max(1, Math.ceil(total / pageSize)))
        fail('COVERAGE_INCOMPLETE', '后台分页覆盖不足，商品数量与分页声明不符');
    const seen = new Set<string>();
    const products: BackendProduct[] = [];
    for (const p of source) {
        const id = typeof p?.itemId === 'number' && Number.isSafeInteger(p.itemId) ? String(p.itemId) : p?.itemId;
        if (!validId(id))
            fail('INVALID_RESPONSE', '后台商品标识无效');
        if (seen.has(id))
            fail('COVERAGE_INCOMPLETE', '后台返回重复商品，无法确认覆盖完整');
        seen.add(id);
        const descriptions = p.itemDesc?.desc ?? [];
        if (!Array.isArray(descriptions))
            fail('INVALID_RESPONSE', '后台商品描述格式无效');
        for (const d of descriptions) {
            if (!d || typeof d !== 'object')
                fail('INVALID_RESPONSE', '后台商品描述格式无效');
            for (const value of [d.url, d.href, d.link]) {
                if (typeof value !== 'string')
                    continue;
                try {
                    const u = new URL(value, 'https://qn.taobao.com');
                    if (u.pathname === '/item.htm' && ['detail.tmall.com', 'item.taobao.com'].includes(u.hostname) && u.hostname !== platform.detailHost)
                        fail('PLATFORM_MISMATCH', '后台商品来源与所选平台不一致');
                }
                catch (e) {
                    if (e instanceof CollectorError)
                        throw e;
                }
            }
        }
        const title = descriptions.find(d => d.uiType === 'link')?.text;
        products.push({ productId: id, title: typeof title === 'string' ? title.trim() : '', raw: p });
    }
    return { current, pageSize, total, products, at };
}
export function pageInvariant(page: Page, baseline: Page | undefined, seen: Set<string>): void {
    if (baseline && (page.pageSize !== baseline.pageSize || page.total !== baseline.total))
        fail('COVERAGE_INCOMPLETE', '后台分页范围发生变化，请重新采集');
    for (const product of page.products) {
        if (seen.has(product.productId))
            fail('COVERAGE_INCOMPLETE', '不同后台页面返回重复商品，请重新采集');
        seen.add(product.productId);
    }
}
function identity(res: any): {
    sellerId: string;
    shopName: string;
} {
    const id = sellerId(res?.seller?.userId) || sellerId(res?.seller?.sellerId) || sellerId(res?.item?.sellerId) || sellerId(res?.shop?.userId);
    if (!id)
        fail('IDENTITY_UNVERIFIED', '详情没有可验证的卖家标识，不能绑定店铺');
    const name = [res?.seller?.shopName, res?.shop?.title, res?.shop?.name].find(v => typeof v === 'string' && v.trim());
    return { sellerId: id, shopName: name?.trim() ?? `卖家 ${id}` };
}
export const fatal = (e: unknown) => e instanceof CollectorError && ['AUTH_REQUIRED', 'COOKIE_INVALID', 'RATE_LIMIT', 'IDENTITY_CHANGED', 'IDENTITY_UNVERIFIED', 'PLATFORM_MISMATCH', 'ABORTED'].includes(e.code);
interface ProductDetail {
    res: any;
    url: string;
    at: string;
    identity: { sellerId: string; shopName: string };
}
export class Client {
    readonly http: SessionHttp;
    readonly platform: PlatformInfo;
    appKey: string;
    constructor(readonly credentials: AccountCredentials, private readonly config: CollectorConfiguration) {
        this.platform = platforms.byId(credentials.platform);
        if (!this.platform)
            fail('PLATFORM_INVALID', '平台无效');
        const ua = credentials.userAgent?.trim() || DEFAULT_UA;
        if (/[\r\n]/.test(ua) || ua.length > 2000)
            fail('INVALID_CONFIGURATION', 'User-Agent 格式无效');
        this.http = new SessionHttp(importCookies(credentials.cookies), ua, config.transport ?? defaultHttpTransport, config.limiter ?? globalLimiter, config.timeoutMs ?? 30000);
        this.appKey = credentials.appKey?.trim() ?? '';
        if (this.appKey && !/^[A-Za-z0-9_-]{1,100}$/.test(this.appKey))
            fail('INVALID_CONFIGURATION', 'appKey 格式无效');
    }
    stamp(): string { return new Date((this.config.now ?? Date.now)()).toISOString(); }
    async ensureKey(signal: AbortSignal): Promise<void> {
        if (this.appKey)
            return;
        const response = await this.http.send('https://qn.taobao.com/', { method: 'GET', accept: 'text/html' }, signal);
        const urls = response.body.replace(/&amp;/g, '&').match(/https?:\/\/h5api\.m\.taobao\.com\/h5\/[^\s"'<>]+/g) ?? [];
        for (const raw of urls) {
            try {
                const u = new URL(raw);
                if (u.pathname === `/h5/${this.platform.api}/1.0/` && u.searchParams.get('appKey')) {
                    this.appKey = u.searchParams.get('appKey')!;
                    return;
                }
            }
            catch { }
        }
        fail('APPKEY_REQUIRED', '无法从千牛响应确认公开 appKey；请填写当前平台后台实际使用的 appKey');
    }
    async page(tab: 'on_sale' | 'on_sale_skucenter', current: number, pageSize: number, signal: AbortSignal): Promise<Page> {
        await this.ensureKey(signal);
        const base = `https://h5api.m.taobao.com/h5/${this.platform.api}/1.0/`;
        const data = JSON.stringify({ url: this.platform.route, jsonBody: JSON.stringify({ tab, pagination: { current, pageSize }, filtertab: '', filter: {}, table: {} }) });
        for (let attempt = 0; attempt < 2; attempt++) {
            checkAbort(signal);
            const token = this.http.jar.getCookiesSync(base).find(c => c.key === tokenName)?.value.split('_')[0] ?? '';
            const t = String((this.config.now ?? Date.now)());
            const sign = createHash('md5').update(`${token}&${t}&${this.appKey}&${data}`).digest('hex');
            const query = new URLSearchParams({ jsv: '2.7.2', appKey: this.appKey, t, sign, api: this.platform.api, v: '1.0', type: 'originaljson', dataType: 'json' });
            const response = await this.http.send(`${base}?${query}`, { method: 'POST', body: new URLSearchParams({ data }).toString() }, signal);
            const reply = objectJson(response.body);
            if (attempt === 0 && Array.isArray(reply?.ret) && reply.ret.some((r: unknown) => typeof r === 'string' && /^FAIL_SYS_TOKEN_(?:EMPTY|EXOIRED|EXPIRED)(?:::|$)/.test(r)) && this.http.jar.getCookiesSync(base).some(c => c.key === tokenName))
                continue;
            return normalizePage(reply, current, this.platform, this.stamp());
        }
        fail('AUTH_REQUIRED', '令牌刷新失败，请重新登录');
    }
    backendRows(product: BackendProduct, at: string): any[] {
        let rows: any[];
        try {
            ({ rows } = backend.normalizeProduct(product.raw, at, this.platform.api));
        }
        catch {
            fail('BACKEND_SKU_INVALID', '后台 SKU 列表、标识或精确金额校验失败');
        }
        const ids = new Set<string>();
        return rows.map((row, index) => {
            if (ids.has(row.skuId))
                fail('BACKEND_SKU_INVALID', '后台 SKU 标识重复或冲突');
            ids.add(row.skuId);
            const props = product.raw.skuList[index].props;
            return { ...row, specs: typeof props === 'string' ? props : '' };
        });
    }
    async detail(id: string, signal: AbortSignal): Promise<ProductDetail> {
        const url = platforms.productUrl(this.platform.id, id);
        const response = await this.http.send(url, { method: 'GET', accept: 'text/html' }, signal);
        const at = this.stamp();
        if (/(?:login\.taobao\.com|login\.tmall\.com|验证码|访问验证)/i.test(response.body) && !response.body.includes('__ICE_APP_CONTEXT__'))
            fail('AUTH_REQUIRED', '详情要求登录或人工验证');
        let res: any;
        try {
            res = core.parseHtml(response.body, id, parseProviderJson);
            if (typeof res.item.itemId === 'number' && !Number.isSafeInteger(res.item.itemId))
                fail('DETAIL_INVALID', '详情标识使用了不安全的数值精度');
        }
        catch {
            fail('DETAIL_INVALID', '详情商品 ID 或页面数据校验失败');
        }
        return { res, url, at, identity: identity(res) };
    }
    detailRows(detail: ProductDetail, id: string): any[] {
        const { res, at, url } = detail;
        try {
            if (Array.isArray(res.skuBase?.skus) && res.skuBase.skus.some((sku: any) => typeof sku?.skuId === 'number' && !Number.isSafeInteger(sku.skuId)))
                fail('DETAIL_INVALID', '详情标识使用了不安全的数值精度');
            return core.rowsFromRes(res, id, at, url);
        }
        catch {
            fail('DETAIL_INVALID', '详情 SKU 或价格数据校验失败');
        }
    }
}

