import { it, expect } from 'vitest';
import { parseCookieImport } from '../src/lib/cookie-import';
import { accountSchema } from '../../server/src/validation.js';
import { importCookies } from '../../server/src/collector/cookies.js';

const appKey = ['fixture', 'Key', '2026'].join('_') + '-a';
const cookies = [{ name: 'cookie2', value: 'fixture-session', domain: '.taobao.com', path: '/', httpOnly: true }];
it('the pasted full ScriptCat package preserves appKey, UA, platform and cookie scope through the actual API schema', () => {
  const text = JSON.stringify({ platform: 'tmall', cookies, userAgent: 'Fixture browser', appKey });
  const parsed = parseCookieImport(text);
  expect(parsed).toEqual({ platform: 'tmall', cookies, userAgent: 'Fixture browser', appKey });
  const request = accountSchema.parse(parsed);
  expect(request.appKey).toBe(appKey);
  expect(request.userAgent).toBe('Fixture browser');
  expect(importCookies(request.cookies).getCookieStringSync('https://h5api.m.taobao.com/')).toContain('cookie2=fixture-session');
});
it('also accepts plain Cookie headers, arrays without domain, and empty input for metadata-only updates', () => {
  expect(parseCookieImport(' cookie2=fixture-session ')).toEqual({ cookies: 'cookie2=fixture-session' });
  expect(parseCookieImport('[{"name":"cookie2","value":"fixture-session"}]').cookies).toEqual([{ name: 'cookie2', value: 'fixture-session' }]);
  expect(parseCookieImport(' ')).toEqual({});
});
it('rejects truncated packages and malformed cookie records without echoing secrets', () => {
  for (const text of ['{"cookies":', '{"userAgent":"fixture-secret"}', '{"cookies":[]}', '{"cookies":[{"name":"x"}]}', '[{"name":"x","value":"fixture-secret","domain":2}]']) {
    try { parseCookieImport(text); throw new Error('should have rejected'); }
    catch (error) {
      expect((error as Error).message).not.toContain('fixture-secret');
      expect((error as Error).message).not.toBe('should have rejected');
    }
  }
});
