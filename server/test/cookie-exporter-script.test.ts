/**
 * 导出的 JSON 必须能被应用真正导入：这里直接调用产品的 cookieSchema + importCookies，
 * 而不是复制一份判断逻辑，避免“测试通过但应用不认”。
 */
import {it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {fileURLToPath} from 'node:url';
import {cookieSchema,accountSchema} from '../src/validation.js';
import {importCookies} from '../src/collector/cookies.js';
import type {CookieInput} from '../../shared/contracts.js';

const scriptPath=fileURLToPath(new URL('../../tools/scriptcat/taobao-cookie-exporter.user.js',import.meta.url));
const source=readFileSync(scriptPath,'utf8');
function loadCore(){
  // 真实浏览器沙箱有 URL/performance/navigator；vm 默认没有，缺了会让 new URL() 抛错被 catch 吞成 null，
  // 造成“测试通过但真实页面也不工作”或相反的假象。这里显式补齐与浏览器一致的内建对象。
  const sandbox={module:{exports:{}},URL,URLSearchParams,performance:{getEntriesByType:()=>[]}};
  runInNewContext(source,sandbox,{filename:scriptPath});
  return sandbox.module.exports;
}
const core=loadCore() as {
  normalizeCookie:(raw:unknown,now?:number)=>Record<string,unknown>|null;
  dedupeCookies:(list:unknown,now?:number)=>Record<string,unknown>[];
  toImportPayload:(input:unknown)=>Record<string,unknown>;
  toHeaderString:(cookies:unknown)=>string;
  extractAppKey:(resources:unknown,platform?:string)=>string;
  platformForHost:(host:string)=>string;
  summarize:(cookies:unknown)=>Record<string,unknown>;
  isMarketDomain:(domain:string)=>boolean;
  platformFromDetailUrl:(value:string)=>string|null;
  detectPlatform:(resources:unknown,hrefs:unknown)=>{platform:string|null;conflicting:string[];appKeys:string[]};
};

// normalizeCookie 的 now 参数是毫秒，Cookie expirationDate 是秒；两者别混。
const NOW_MS=Date.now();
const NOW_S=Math.floor(NOW_MS/1000);

it('产物在无 document 环境导出纯逻辑，且元信息声明了 GM_cookie 与两个平台',()=>{
  expect(typeof core.normalizeCookie).toBe('function');
  expect(source).toContain('// @grant        GM_cookie');
  expect(source).toContain('@match        https://*.taobao.com/*');
  expect(source).toContain('@match        https://*.tmall.com/*');
});

it('保留 HttpOnly 与 domain/path/过期时间，供签名请求使用',()=>{
  const cookie=core.normalizeCookie({name:'cookie2',value:'abc123',domain:'.taobao.com',path:'/',secure:true,httpOnly:true,expirationDate:NOW_S+86400,sameSite:'no_restriction'},NOW_MS)!;
  expect(cookie).toMatchObject({name:'cookie2',value:'abc123',domain:'.taobao.com',path:'/',secure:true,httpOnly:true});
  expect(cookie.expires).toBe(NOW_S+86400);
  // sameSite 非法值不应写入（应用只接受 strict/lax/none）
  expect(cookie.sameSite).toBeUndefined();
});

it('丢弃已过期、非市场域、以及名称/值非法的 Cookie',()=>{
  expect(core.normalizeCookie({name:'a',value:'b',domain:'.taobao.com',expirationDate:NOW_S-86400},NOW_MS)).toBeNull();
  expect(core.normalizeCookie({name:'a',value:'b',domain:'.example.com'},NOW_MS)).toBeNull();
  expect(core.normalizeCookie({name:'bad name',value:'b',domain:'.taobao.com'},NOW_MS)).toBeNull();
  expect(core.normalizeCookie({name:'a',value:'has space',domain:'.taobao.com'},NOW_MS)).toBeNull();
  expect(core.normalizeCookie({name:'a',value:'b;c',domain:'.taobao.com'},NOW_MS)).toBeNull();
  expect(core.normalizeCookie(null,NOW_MS)).toBeNull();
});

it('同一 domain+path+name 去重并保留更晚过期的一条',()=>{
  const list=core.dedupeCookies([
    {name:'sgcookie',value:'old',domain:'.taobao.com',path:'/',expirationDate:NOW_S+10},
    {name:'sgcookie',value:'new',domain:'.taobao.com',path:'/',expirationDate:NOW_S+9999},
    {name:'sgcookie',value:'other',domain:'.tmall.com',path:'/',expirationDate:NOW_S+10},
  ],NOW_MS);
  expect(list).toHaveLength(2);
  expect(list.find(c=>c.domain==='.taobao.com')!.value).toBe('new');
});

it('输出的导入包能被应用的 cookieSchema 接受，并真的装进 CookieJar',()=>{
  const payload=core.toImportPayload({
    platform:'tmall',
    cookies:[
      {name:'cookie2',value:'17d5f2ffabc',domain:'.taobao.com',path:'/',secure:true,httpOnly:true,expirationDate:NOW_S+86400},
      {name:'_tb_token_',value:'58abc',domain:'.tmall.com',path:'/',secure:true,httpOnly:false,expirationDate:NOW_S+86400},
      {name:'track',value:'x',domain:'.example.com',path:'/',expirationDate:NOW_S+86400},
    ],
    userAgent:'Mozilla/5.0 test',
    appKey:'12574478',
  });
  const parsed=cookieSchema.parse(payload.cookies);
  expect(parsed).toHaveLength(2);
  const jar=importCookies(parsed as CookieInput);
  const header=jar.getCookieStringSync('https://h5api.m.taobao.com/h5/mtop.tmall.sell.pc.manage.async/1.0/');
  expect(header).toContain('cookie2=17d5f2ffabc');
  // 应用侧 accountSchema 也必须接受整包
  const account=accountSchema.parse(payload);
  expect(account.platform).toBe('tmall');
  expect(account.appKey).toBe('12574478');
});

it('没有合法 appKey 时不写入，避免应用拿到无效值',()=>{
  expect(core.toImportPayload({cookies:[],appKey:'has space'}).appKey).toBeUndefined();
  expect(core.toImportPayload({cookies:[],appKey:''}).appKey).toBeUndefined();
  expect(core.toImportPayload({cookies:[],appKey:' 12574478 '}).appKey).toBe('12574478');
});

it('从千牛性能资源里取到实际 appKey，且区分平台',()=>{
  const tmall=['https://h5api.m.taobao.com/h5/mtop.tmall.sell.pc.manage.async/1.0/?jsv=2.5&appKey=12574478&t=1','https://h5api.m.taobao.com/h5/mtop.taobao.sell.pc.manage.async/1.0/?appKey=99999999'];
  expect(core.extractAppKey(tmall,'tmall')).toBe('12574478');
  expect(core.extractAppKey(tmall,'taobao')).toBe('99999999');
  expect(core.extractAppKey([],'tmall')).toBe('');
});

it('Cookie 头按首次出现去重，避免重复 name 造成服务端解析异常',()=>{
  const header=core.toHeaderString([
    {name:'cookie2',value:'a',domain:'.taobao.com'},
    {name:'cookie2',value:'b',domain:'.tmall.com'},
    {name:'unb',value:'c',domain:'.taobao.com'},
  ]);
  expect(header).toBe('cookie2=a; unb=c');
});

it('按站点推断默认平台',()=>{
  expect(core.platformForHost('qn.taobao.com')).toBe('taobao');
  expect(core.platformForHost('detail.tmall.com')).toBe('tmall');
  expect(core.platformForHost('myseller.taobao.com')).toBe('taobao');
});

it('平台按页面证据判定：千牛同域承载天猫与淘宝，绝不能按域名猜',()=>{
  // 真实取证：qn.taobao.com 上的天猫店，详情链接全是 detail.tmall.com，管理 API 是 mtop.tmall.*
  const resources=[
    'https://h5api.m.taobao.com/h5/mtop.tmall.sell.pc.manage.render/1.0/?jsv=2.5&appKey=12574478',
    'https://h5api.m.taobao.com/h5/mtop.tmall.sell.pc.manage.async/1.0/?jsv=2.5&appKey=12574478&t=1',
    'https://h5api.m.taobao.com/h5/mtop.taobao.pc.trade.list/1.0/?appKey=999',
  ];
  const hrefs=['https://detail.tmall.com/item.htm?id=673735070264','https://detail.tmall.com/item.htm?id=651467000020'];
  const result=core.detectPlatform(resources,hrefs);
  expect(result.platform).toBe('tmall');
  expect(result.appKeys).toEqual(['12574478']);
  // 与域名无关：即便页面在 qn.taobao.com，也判天猫
  expect(core.platformForHost('qn.taobao.com')).toBe('taobao'); // 旧域名函数保留，但不用于定平台
});

it('平台识别：淘宝证据、无证据、冲突三种情况',()=>{
  expect(core.detectPlatform(['https://h5api.m.taobao.com/h5/mtop.taobao.sell.pc.manage.async/1.0/?appKey=999'],
    ['https://item.taobao.com/item.htm?id=123456789012']).platform).toBe('taobao');
  expect(core.detectPlatform([],[]).platform).toBeNull();
  const conflict=core.detectPlatform(['https://h5api.m.taobao.com/h5/mtop.taobao.sell.pc.manage.async/1.0/?appKey=1'],
    ['https://detail.tmall.com/item.htm?id=651467000020']);
  expect(conflict.platform).toBeNull();
  expect(conflict.conflicting).toEqual(['taobao','tmall']);
});

it('详情链接校验：非 item.htm、非详情域、非数字ID 都不算证据',()=>{
  expect(core.platformFromDetailUrl('https://detail.tmall.com/item.htm?id=651467000020')).toBe('tmall');
  expect(core.platformFromDetailUrl('https://item.taobao.com/item.htm?id=123456789012')).toBe('taobao');
  // 相对链接会被解析到 qn.taobao.com，无法据此判定平台，必须返回 null（不能猜）
  expect(core.platformFromDetailUrl('/item.htm?id=651467000020')).toBeNull();
  expect(core.platformFromDetailUrl('https://detail.tmall.com/other.htm?id=651467000020')).toBeNull();
  expect(core.platformFromDetailUrl('https://detail.tmall.com/item.htm?id=123')).toBeNull();
  expect(core.platformFromDetailUrl('https://detail.tmall.com/item.htm?id=abc')).toBeNull();
  expect(core.platformFromDetailUrl('https://evil.com/item.htm?id=651467000020')).toBeNull();
});

it('appKey 不限于 sell.pc.manage.*：千牛各业务 API 共用同一个公开 appKey',()=>{
  // 真实页面观测：22 个 mtop 资源里 appKey 只有一个值 12574478，而 manage.* 仅 render/async
  const resources=[
    'https://h5api.m.taobao.com/h5/mtop.taobao.multi.resource.menu.my.all.v2/1.0/?appKey=12574478',
    'https://h5api.m.taobao.com/h5/mtop.taobao.qianniu.red.list.get.v2/1.0/?appKey=12574478',
    'https://h5api.m.taobao.com/h5/mtop.tmall.sell.pc.manage.render/1.0/?appKey=12574478',
  ];
  const result=core.detectPlatform(resources,['https://detail.tmall.com/item.htm?id=673735070264']);
  expect(result.platform).toBe('tmall');
  expect(result.appKeys).toEqual(['12574478']);
});

it('appKey 只采信与已确认平台同前缀的资源，平台未定时不猜',()=>{
  const tmallRes='https://h5api.m.taobao.com/h5/mtop.tmall.ow.resource.notice.all/1.0/?appKey=TMALLKEY';
  const taobaoRes='https://h5api.m.taobao.com/h5/mtop.taobao.ow.resource.notice.all/1.0/?appKey=TBKEY';
  // 天猫证据 + 两种前缀资源：只取天猫前缀的 key
  expect(core.detectPlatform([tmallRes,taobaoRes],['https://detail.tmall.com/item.htm?id=673735070264']).appKeys).toEqual(['TMALLKEY']);
  // 淘宝证据：只取淘宝前缀
  expect(core.detectPlatform([tmallRes,taobaoRes],['https://item.taobao.com/item.htm?id=123456789012']).appKeys).toEqual(['TBKEY']);
  // 无平台证据：即便有 appKey 也不输出，避免把另一平台的 key 塞进来
  expect(core.detectPlatform([tmallRes,taobaoRes],[]).appKeys).toEqual([]);
});

it('非管理类 API 不参与平台判定，避免把另一平台的后台接口当成店铺证据',()=>{
  // 真实页面里千牛会加载 mtop.taobao.* 的公共接口（菜单、红点、公告）。
  // 这些只能说明“在千牛”，不能说明店铺是淘宝；若据此判平台会与详情链接冲突。
  const publicTaobao='https://h5api.m.taobao.com/h5/mtop.taobao.ow.resource.notice.all/1.0/?appKey=12574478';
  const manageTmall='https://h5api.m.taobao.com/h5/mtop.tmall.sell.pc.manage.async/1.0/?appKey=12574478';
  // 天猫店：公共淘宝接口 + 天猫管理接口 + 天猫详情 -> 仍判天猫
  expect(core.detectPlatform([publicTaobao,manageTmall],['https://detail.tmall.com/item.htm?id=673735070264']).platform).toBe('tmall');
  // 只有公共淘宝接口 + 天猫详情链接 -> 不冲突，判天猫
  const r=core.detectPlatform([publicTaobao],['https://detail.tmall.com/item.htm?id=673735070264']);
  expect(r.platform).toBe('tmall');
  expect(r.conflicting).toEqual(['tmall']);
});
