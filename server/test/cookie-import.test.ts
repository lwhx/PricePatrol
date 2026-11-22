import {it,expect} from 'vitest';
import {importCookies} from '../src/collector/cookies.js';
import {cookieSchema} from '../src/validation.js';

it('accepts JSON cookie arrays without domain and scopes them to both marketplace roots',()=>{
  const parsed=cookieSchema.parse([{name:'cookie2',value:'abc'},{name:'sgcookie',value:'def',domain:'.taobao.com'}]);
  const jar=importCookies(parsed);
  expect(jar.getCookieStringSync('https://taobao.com/')).toContain('cookie2=abc');
  expect(jar.getCookieStringSync('https://tmall.com/')).toContain('cookie2=abc');
  expect(jar.getCookieStringSync('https://taobao.com/')).toContain('sgcookie=def');
});
it('reports a Chinese error for invalid cookie input',()=>{
  const result=cookieSchema.safeParse(12345);
  expect(result.success).toBe(false);
  if(!result.success)expect(result.error.issues[0].message).toContain('Cookie 格式无效');
});
it('still accepts plain header strings',()=>{
  const jar=importCookies('cookie2=xyz; unb=qq');
  expect(jar.getCookieStringSync('https://h5api.m.taobao.com/')).toContain('cookie2=xyz');
});
it('skips non-marketplace domains but keeps usable ones',()=>{
  const jar=importCookies([{name:'track',value:'1',domain:'.example.com'},{name:'cookie2',value:'ok',domain:'.taobao.com'}]);
  const header=jar.getCookieStringSync('https://taobao.com/');
  expect(header).toContain('cookie2=ok');
  expect(header).not.toContain('track');
});
