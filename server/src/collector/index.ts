import type { AccountCredentials, Collector, CollectOptions, CollectedRow, Platform, VerifiedAccount } from '../../../shared/contracts.js';
import { exportCookies } from './cookies.js';
import { checkAbort, CollectorError } from './errors.js';
import { Client, backend, fail, fatal, pageInvariant, platforms, validId, type Page, type CollectorConfiguration } from './client.js';
export { CollectorError } from './errors.js';
export { defaultHttpTransport, Semaphore, globalLimiter } from './http.js';
export type { HttpTransport, HttpRequest, HttpResponse, RequestLimiter } from './http.js';
export type { CollectorConfiguration } from './client.js';
export type { Collector } from '../../../shared/contracts.js';
const MAX_VERIFICATION_PAGES_PER_TAB = 5;

async function findVerificationProduct(client: Client, signal: AbortSignal): Promise<string> {
    const listing = new Set<string>(), sku = new Set<string>();
    let listingBaseline: Page | undefined, skuBaseline: Page | undefined;
    for (let current = 1; current <= MAX_VERIFICATION_PAGES_PER_TAB; current++) {
        if (!listingBaseline || current <= Math.ceil(listingBaseline.total / listingBaseline.pageSize)) {
            const page = await client.page('on_sale', current, listingBaseline?.pageSize ?? 20, signal);
            pageInvariant(page, listingBaseline, listing);
            listingBaseline ??= page;
            const common = page.products.find(product => sku.has(product.productId));
            if (common)
                return common.productId;
        }
        if (!skuBaseline || current <= Math.ceil(skuBaseline.total / skuBaseline.pageSize)) {
            const page = await client.page('on_sale_skucenter', current, skuBaseline?.pageSize ?? 20, signal);
            pageInvariant(page, skuBaseline, sku);
            skuBaseline ??= page;
            const common = page.products.find(product => listing.has(product.productId));
            if (common)
                return common.productId;
        }
        if (!listingBaseline.total || !skuBaseline.total || (listing.size === listingBaseline.total && sku.size === skuBaseline.total))
            break;
    }
    fail('IDENTITY_UNVERIFIED', '在核验范围内未找到同时存在于商品列表和 SKU 后台的商品，无法核验店铺身份');
}

export function createCollector(configuration: CollectorConfiguration = {}): Collector {
    async function attempt(credentials: Parameters<Collector['verify']>[0], signal: AbortSignal): Promise<VerifiedAccount> {
        const client = new Client(credentials, configuration, signal);
        try {
            const productId = await findVerificationProduct(client, signal);
            const detail = await client.detail(productId, signal);
            client.http.assertIdentity();
            checkAbort(signal);
            return { ...detail.identity, platform: client.platform.id, cookies: exportCookies(client.http.jar), userAgent: client.http.userAgent, appKey: client.appKey, ...(client.proxy ? {proxy:client.proxy} : {}) };
        } finally {
            await client.close();
        }
    }
    // A cookie only works against its own platform's management API: pointing a Tmall cookie at
    // the Taobao API returns a security challenge the user cannot resolve by verifying. When we
    // see that challenge, ask the other platform once (a single listing page) to tell a genuinely
    // challenged session apart from a valid cookie imported under the wrong platform.
    async function otherPlatformAccepts(credentials: AccountCredentials, signal: AbortSignal): Promise<Platform | null> {
        const alternative: Platform = credentials.platform === 'tmall' ? 'taobao' : 'tmall';
        const client = new Client({ ...credentials, platform: alternative }, configuration, signal);
        try {
            await client.page('on_sale', 1, 20, signal);
            return alternative;
        }
        catch (error) {
            if (error instanceof CollectorError && error.code === 'ABORTED')
                throw error;
            return null;
        }
        finally {
            await client.close();
        }
    }
    return {
        async verify(credentials, signal = new AbortController().signal) {
            try {
                return await attempt(credentials, signal);
            }
            catch (error) {
                if (!(error instanceof CollectorError) || error.code !== 'VERIFICATION_REQUIRED')
                    throw error;
                const other = await otherPlatformAccepts(credentials, signal);
                if (!other)
                    throw error;
                checkAbort(signal);
                const label = platforms.byId(other)?.label ?? other;
                throw new CollectorError('PLATFORM_MISMATCH', `这份 Cookie 属于${label}店铺：请把平台切换为${label}后重新导入`);
            }
        },
        async collect(options) { return collect(options, configuration); }
    };
}
async function collect(options: CollectOptions, configuration: CollectorConfiguration) {
    const client = new Client(options.credentials, configuration, options.signal);
    try {
        return await collectWithClient(options, client);
    } finally {
        await client.close();
    }
}
async function collectWithClient(options: CollectOptions, client: Client) {
    const { signal, credentials } = options;
    const selected = options.productIds === undefined ? undefined : [...new Set(options.productIds)];
    const skip = new Set(options.skipProductIds ?? []);
    if (selected?.some(id => !validId(id)) || [...skip].some(id => !validId(id)))
        fail('INVALID_PRODUCT_IDS', '商品 ID 格式无效');
    let expected = selected?.filter(id => !skip.has(id)).length ?? 0, processed = 0;
    const failedProductIds: string[] = [];
    const progress = async (phase: string, message: string) => { checkAbort(signal); client.http.assertIdentity(); await options.onProgress({ phase, expected, processed, failed: failedProductIds.length, message }); checkAbort(signal); };
    await progress('discovering', '正在核验后台商品范围');
    const wanted = new Set(selected ?? []), discovered = new Map<string, string>();
    let baseline: Page | undefined;
    const listingSeen = new Set<string>();
    for (let current = 1; !baseline || current <= Math.ceil(baseline.total / baseline.pageSize); current++) {
        checkAbort(signal);
        const page = await client.page('on_sale', current, baseline?.pageSize ?? 20, signal);
        pageInvariant(page, baseline, listingSeen);
        baseline ??= page;
        for (const p of page.products)
            if (!selected || wanted.has(p.productId))
                discovered.set(p.productId, p.title);
        expected = selected ? selected.filter(id => !skip.has(id)).length : baseline.total - [...skip].filter(id => listingSeen.has(id)).length;
        await progress('discovering', `已读取商品列表第 ${current} 页`);
        if (selected && selected.every(id => discovered.has(id)))
            break;
    }
    expected = selected ? selected.filter(id => !skip.has(id)).length : [...discovered.keys()].filter(id => !skip.has(id)).length;
    const done = new Set<string>(), backendSeen = new Set<string>();
    let backendBaseline: Page | undefined;
    const commit = async (productId: string, title: string, rows: CollectedRow[], error?: string) => {
        checkAbort(signal);
        client.http.assertIdentity();
        const skuSetComplete = !error && rows.length > 0 && rows.every(row => row.status === 'ok');
        await options.onProduct({ productId, title, rows, ...(error ? { error } : {}), ...(skuSetComplete ? { skuSetComplete } : {}) });
        processed++;
        if (error)
            failedProductIds.push(productId);
        done.add(productId);
        await progress('collecting', `本轮已处理 ${processed}/${expected} 个商品`);
    };
    if (discovered.size) {
        for (let current = 1; !backendBaseline || current <= Math.ceil(backendBaseline.total / backendBaseline.pageSize); current++) {
            checkAbort(signal);
            const page = await client.page('on_sale_skucenter', current, backendBaseline?.pageSize ?? 20, signal);
            pageInvariant(page, backendBaseline, backendSeen);
            backendBaseline ??= page;
            if (!selected && page.total !== baseline!.total)
                fail('COVERAGE_INCOMPLETE', '商品列表与 SKU 后台的商品总数不一致，请重新采集');
            for (const product of page.products) {
                const id = product.productId;
                if (!discovered.has(id))
                    continue;
                if (skip.has(id)) {
                    done.add(id);
                    continue;
                }
                let front: any[] = [];
                let at: string | null = null, error: string | undefined;
                let backendRows: any[] = [];
                try {
                    backendRows = client.backendRows(product, page.at);
                }
                catch (e) {
                    if (!(e instanceof CollectorError) || e.code !== 'BACKEND_SKU_INVALID')
                        throw e;
                    error = e.message;
                }
                try {
                    const detail = await client.detail(id, signal);
                    if (detail.identity.sellerId !== credentials.sellerId)
                        fail('IDENTITY_CHANGED', '商品实际卖家与绑定店铺不一致，已停止采集');
                    front = client.detailRows(detail, id);
                    at = detail.at;
                }
                catch (e) {
                    if (fatal(e))
                        throw e;
                    error ??= e instanceof CollectorError ? e.message : '详情读取失败';
                }
                const rows: CollectedRow[] = [], sourceUrl = platforms.productUrl(client.platform.id, id);
                const attached = backend.attach(front, backendRows), frontIds = new Set(front.map(row => row.skuId));
                for (const row of attached) {
                    const complete = row.backendVerified && row.before !== '' && row.after !== '' && row.status === '完整';
                    rows.push({ shopId: options.shopId, productId: id, skuId: row.skuId, title: row.title || product.title, specs: row.specs, seatSpec: row.seatSpec, color: row.color,
                        backendPrice: row.backendPrice || null, before: row.before || null, after: row.after || null, backendVerified: !!row.backendVerified,
                        status: complete ? 'ok' : 'partial', ...(!complete ? { error: row.status === '完整' ? row.backendStatus : row.status } : {}), sourceUrl, backendSource: row.backendSource || client.platform.api,
                        detailFetchedAt: at, backendFetchedAt: row.backendFetchedAt || null, stock: row.backendQuantity !== '' ? row.backendQuantity : typeof row.quantity === 'number' ? row.quantity : null });
                }
                for (const row of backendRows)
                    if (!frontIds.has(row.skuId))
                        rows.push({ shopId: options.shopId, productId: id, skuId: row.skuId, title: product.title, specs: row.specs ?? '', seatSpec: '', color: '',
                            backendPrice: row.backendPrice, before: null, after: null, backendVerified: true, status: 'backend_only', error: error ?? '详情中没有该后台 SKU', sourceUrl, backendSource: client.platform.api,
                            detailFetchedAt: null, backendFetchedAt: row.backendFetchedAt, stock: row.backendQuantity !== '' ? row.backendQuantity : null });
                if (!rows.length)
                    error ??= '商品没有可核验的 SKU 价格数据';
                await commit(id, product.title, rows, error);
            }
            if (selected && [...discovered.keys()].every(id => done.has(id)))
                break;
        }
    }
    for (const id of selected ?? discovered.keys()) {
        if (skip.has(id) || done.has(id))
            continue;
        await commit(id, discovered.get(id) ?? '', [], discovered.has(id) ? 'SKU 后台未找到此商品，无法核验后台价格' : '所选店铺的在售商品后台未找到此商品');
    }
    for (const id of selected ?? skip)
        if (skip.has(id) && (!discovered.has(id) || !backendSeen.has(id)) && !failedProductIds.includes(id))
            failedProductIds.push(id);
    await progress('completed', failedProductIds.length ? '采集完成，存在失败商品' : '采集完成');
    return { cookies: exportCookies(client.http.jar), expected, processed, failedProductIds, coverageComplete: failedProductIds.length === 0 };
}

