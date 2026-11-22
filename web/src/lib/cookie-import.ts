import type { CookieInput, Platform } from '../../../shared/contracts.js';

export interface CookieImport {
  cookies?: CookieInput;
  platform?: Platform;
  userAgent?: string;
  appKey?: string;
}

/** Parse the exact text pasted into the account form, including ScriptCat export metadata. */
export function parseCookieImport(text: string): CookieImport {
  const raw = text.trim();
  if (!raw) return {};
  if (!raw.startsWith('[') && !raw.startsWith('{')) return { cookies: raw };
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { throw new Error('Cookie JSON 解析失败：请检查粘贴内容是否完整'); }
  const isPackage = !Array.isArray(parsed);
  if (isPackage && (!parsed || typeof parsed !== 'object')) throw new Error('完整导入包格式无效');
  const pkg = parsed as Record<string, unknown>;
  const cookies: unknown = isPackage ? pkg.cookies : parsed;
  if (!Array.isArray(cookies) || !cookies.length || !cookies.every(item =>
    item && typeof item === 'object' && typeof item.name === 'string' && typeof item.value === 'string'
      && (item.domain === undefined || typeof item.domain === 'string'))) {
    throw new Error('Cookie JSON 必须包含非空 cookies 数组，每条含 name、value（domain 可选）');
  }
  const result: CookieImport = { cookies };
  if (isPackage) {
    if (pkg.platform !== undefined && pkg.platform !== 'taobao' && pkg.platform !== 'tmall') throw new Error('导入包的平台无效');
    if (pkg.appKey !== undefined && (typeof pkg.appKey !== 'string' || !pkg.appKey.trim())) throw new Error('导入包的 appKey 格式无效');
    if (pkg.userAgent !== undefined && typeof pkg.userAgent !== 'string') throw new Error('导入包的 User-Agent 格式无效');
    result.platform = pkg.platform as Platform | undefined;
    result.appKey = typeof pkg.appKey === 'string' ? pkg.appKey.trim() : undefined;
    result.userAgent = typeof pkg.userAgent === 'string' ? pkg.userAgent.trim() : undefined;
  }
  return result;
}
