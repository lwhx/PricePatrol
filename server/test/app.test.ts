import {it,expect,afterEach,vi} from 'vitest';
import {Store} from '../src/database.js';
import {buildApp} from '../src/app.js';
import {hashPassword} from '../src/security.js';
import type {Collector,VerifiedAccount} from '../../shared/contracts.js';
const verified:VerifiedAccount={sellerId:'merchant-1',shopName:'真正的店',platform:'tmall',cookies:[{domain:'.taobao.com',name:'cookie2',value:'never-return-this-secret'}],userAgent:'test',appKey:'12574478'};
const collector:Collector={verify:async()=>verified,collect:async()=>({cookies:verified.cookies,expected:0,processed:0,failedProductIds:[],coverageComplete:true})};
const closes:(()=>Promise<void>)[]=[];afterEach(async()=>{vi.unstubAllEnvs();for(const close of closes.splice(0))await close();});
const password = 'long-test-password';
const setupToken = 'unit-test-only-setup-token';
async function setupAuth(options: {setupToken?: string; existingAdmin?: boolean} = {}) {
  const store = new Store(':memory:', 'a'.repeat(64));
  closes.push(async () => store.close());
  if (options.existingAdmin) store.setConfig('admin.hash', await hashPassword(password));
  const {app} = await buildApp({store, collector, dataDir: '.local/test-data', setupToken: options.setupToken});
  closes.unshift(async () => app.close());
  return app;
}

it('requires the bootstrap token exactly once on protected administrator setup', async () => {
  const app = await setupAuth({setupToken});
  const status = await app.inject('/api/auth/status');
  expect(status.json()).toEqual({configured: false, authenticated: false, setupTokenRequired: true});
  expect(status.body).not.toContain(setupToken);

  for (const payload of [{password}, {password, setupToken: 'wrong-token'}]) {
    const rejected = await app.inject({method: 'POST', url: '/api/auth/setup', payload});
    expect(rejected.statusCode).toBe(403);
    expect(rejected.cookies).toEqual([]);
  }
  const attempts = await Promise.all([1, 2].map(() => app.inject({method: 'POST', url: '/api/auth/setup', payload: {password, setupToken}})));
  expect(attempts.map(result => result.statusCode).sort()).toEqual([200, 409]);
  const successful = attempts.find(result => result.statusCode === 200)!;
  expect(successful.json()).toEqual({ok: true});
  const cookie = successful.cookies.map(entry => `${entry.name}=${entry.value}`).join('; ');
  expect((await app.inject({url: '/api/auth/status', headers: {cookie}})).json()).toEqual({configured: true, authenticated: true, setupTokenRequired: false});
});

it('fails closed for a fresh production app missing bootstrap credentials', async () => {
  vi.stubEnv('NODE_ENV', 'production');
  await expect(setupAuth()).rejects.toThrow(/SETUP_TOKEN/);
});

it('keeps existing production administrators able to sign in without a setup token', async () => {
  vi.stubEnv('NODE_ENV', 'production');
  const app = await setupAuth({existingAdmin: true});
  expect((await app.inject('/api/auth/status')).json()).toEqual({configured: true, authenticated: false, setupTokenRequired: false});
  const login = await app.inject({method: 'POST', url: '/api/auth/login', payload: {password}});
  expect(login.statusCode).toBe(200);
  expect(login.cookies).toHaveLength(1);
});
async function setup(){const store=new Store(':memory:','a'.repeat(64));const ctx=await buildApp({store,collector,dataDir:'.local/test-data'});closes.push(async()=>{await ctx.app.close();store.close();});const auth=await ctx.app.inject({method:'POST',url:'/api/auth/setup',payload:{password:'long-test-password'}});expect(auth.statusCode).toBe(200);const cookie=auth.cookies.map(c=>`${c.name}=${c.value}`).join('; ');return {...ctx,store,cookie};}
it('requires auth, checks origin, and never returns imported cookie secrets',async()=>{const {app,cookie}=await setup();expect((await app.inject('/api/shops')).statusCode).toBe(401);expect((await app.inject({method:'POST',url:'/api/shops',headers:{cookie,origin:'https://malicious.example'},payload:{}})).statusCode).toBe(403);const added=await app.inject({method:'POST',url:'/api/shops',headers:{cookie},payload:{platform:'tmall',cookies:'cookie2=secret'}});expect(added.statusCode).toBe(200);expect(added.body).not.toContain('never-return-this-secret');const list=await app.inject({url:'/api/shops',headers:{cookie}});expect(list.json().shops).toHaveLength(1);expect(list.body).not.toContain('cookie2');});
it('stores independent multiple tasks per shop and rejects invalid scopes',async()=>{const {app,cookie}=await setup();const headers={cookie};const shop=(await app.inject({method:'POST',url:'/api/shops',headers,payload:{platform:'tmall',cookies:'cookie2=secret'}})).json().shop;const base={shopId:shop.id,name:'全店8.5',enabled:true,scope:'all',productIds:[],rules:[{mode:'all',conditions:[{field:'discount',op:'lt',value:'8.5'}]}],whitelist:{productIds:[],titleKeywords:['自由岛']},schedule:{kind:'manual',time:'09:00',days:[],timezone:'Asia/Shanghai'},notify:false};const a=await app.inject({method:'POST',url:'/api/tasks',headers,payload:base});const b=await app.inject({method:'POST',url:'/api/tasks',headers,payload:{...base,name:'指定8折',scope:'selected',productIds:['123456789012']}});expect(a.statusCode).toBe(200);expect(b.statusCode).toBe(200);expect(a.json().task.id).not.toBe(b.json().task.id);expect((await app.inject({url:'/api/tasks',headers})).json().tasks).toHaveLength(2);expect((await app.inject({method:'POST',url:'/api/tasks',headers,payload:{...base,scope:'selected'}})).statusCode).toBe(400);});
it('does not reveal ServerChan key and rejects tests when not configured',async()=>{const {app,cookie}=await setup();const headers={cookie};expect((await app.inject({method:'POST',url:'/api/notifications/test',headers})).statusCode).toBe(400);const changed=await app.inject({method:'PUT',url:'/api/settings',headers,payload:{sendKey:'SCT-secret-private-key',notificationEnabled:false}});expect(changed.statusCode).toBe(200);expect(changed.body).not.toContain('SCT-secret-private-key');expect(changed.json().notification.hasSendKey).toBe(true);});
