import { Cookie, CookieJar } from 'tough-cookie';
import type { CookieInput, CookieRecord } from '../../../shared/contracts.js';
import { CollectorError } from './errors.js';
export const allowedDomain = (domain: string) => /(^|\.)(?:taobao|tmall)\.com$/i.test(domain.replace(/^\./, ''));
export function importCookies(input: CookieInput): CookieJar {
    const jar = new CookieJar();
    try {
        if (typeof input === 'string') {
            const raw = input.trim();
            if (raw.startsWith('[') || raw.startsWith('{')) {
                const parsed = JSON.parse(raw);
                input = Array.isArray(parsed) ? parsed : parsed.cookies;
            }
            else {
                if (!raw || /[\r\n]/.test(raw))
                    throw Error();
                for (const part of raw.replace(/^Cookie:\s*/i, '').split(';')) {
                    const at = part.indexOf('=');
                    if (at <= 0)
                        throw Error();
                    const name = part.slice(0, at).trim(), value = part.slice(at + 1).trim();
                    if (!/^[!#$%&'*+.^_`|~\w-]+$/.test(name) || /[\x00-\x20\x7f;]/.test(value))
                        throw Error();
                    // A Cookie header has no scope metadata. Deliberately scope it to the
                    // two marketplace roots, and return explicit domain/path records.
                    for (const domain of ['taobao.com', 'tmall.com'])
                        jar.setCookieSync(new Cookie({ key: name, value, domain, path: '/', secure: true }), `https://${domain}/`);
                }
                input = [];
            }
        }
        if (!Array.isArray(input))
            throw Error();
        for (const item of input) {
            if (!item || typeof item.name !== 'string' || typeof item.value !== 'string')
                throw Error();
            if (item.domain !== undefined && typeof item.domain !== 'string')
                throw Error();
            if (item.domain && !allowedDomain(item.domain)) {
                // 只保留淘宝/天猫域下的 Cookie；其他域（如 login.taobao.com 以外的统计域）跳过即可。
                continue;
            }
            if (!/^[!#$%&'*+.^_`|~\w-]+$/.test(item.name) || /[\x00-\x20\x7f;]/.test(item.value))
                throw Error();
            const expiry = item.expirationDate ?? item.expires;
            if (expiry !== undefined && !Number.isFinite(expiry))
                throw Error();
            if (expiry !== undefined && expiry >= 0 && expiry * 1000 <= Date.now())
                continue;
            // domain 缺失时，按 Cookie header 的处理方式挂到两个市场根域，保证会话可用。
            const hasDomain = typeof item.domain === 'string' && item.domain.trim() !== '';
            const domain = hasDomain ? item.domain!.replace(/^\./, '').toLowerCase() : '';
            const path = item.path ?? '/';
            if (!path.startsWith('/'))
                throw Error();
            const sameSite = item.sameSite?.toLowerCase();
            const cookie = new Cookie({ key: item.name, value: item.value, ...(hasDomain ? { domain, hostOnly: !item.domain!.startsWith('.') } : { domain: 'taobao.com', hostOnly: false }), path, secure: !!item.secure, httpOnly: !!item.httpOnly,                expires: expiry !== undefined && expiry > 0 ? new Date(expiry * 1000) : 'Infinity',
                ...(sameSite && ['strict', 'lax', 'none'].includes(sameSite) ? { sameSite: sameSite as 'strict' | 'lax' | 'none' } : {}) });
            if (hasDomain)
                jar.setCookieSync(cookie, `https://${domain}${path}`);
            else
                for (const root of ['taobao.com', 'tmall.com'])
                    jar.setCookieSync(new Cookie({ ...cookie, domain: root, hostOnly: false }), `https://${root}/`);
        }
        if (!(jar.serializeSync()?.cookies ?? []).length)
            throw Error();
        return jar;
    }
    catch {
        throw new CollectorError('COOKIE_INVALID', 'Cookie 为空、已过期或格式无效；请导入淘宝/天猫的 Cookie');
    }
}
export function exportCookies(jar: CookieJar): CookieRecord[] {
    const cookies = (jar.serializeSync()?.cookies ?? []).map(c => Cookie.fromJSON(c)).filter((c): c is Cookie => !!c);
    return cookies.filter(c => allowedDomain(c.domain ?? '') && (c.expiryTime() ?? Infinity) > Date.now()).map(c => ({
        name: c.key, value: c.value, domain: c.hostOnly ? c.domain! : '.' + c.domain!, path: c.path ?? '/', secure: !!c.secure, httpOnly: !!c.httpOnly,
        ...(c.sameSite ? { sameSite: c.sameSite } : {}), ...(c.expires instanceof Date ? { expires: c.expires.getTime() / 1000 } : { session: true })
    }));
}

