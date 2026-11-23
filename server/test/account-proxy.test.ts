import {Writable} from 'node:stream';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {afterEach,describe,expect,it} from 'vitest';
import type {AccountCredentials,Collector,Shop,VerifiedAccount} from '../../shared/contracts.js';
import {accountSchema} from '../src/validation.js';
import {Store} from '../src/database.js';
import {buildApp} from '../src/app.js';
import {CollectorError} from '../src/collector/errors.js';

const proxy='http://fixture-user:fixture-password@proxy.example:8080/';
const fixture={platform:'tmall' as const,cookies:'cookie2=fixture-cookie',userAgent:'Fixture browser',appKey:'fixture_Key-2026'};
const account:VerifiedAccount={sellerId:'proxy-fixture-seller',shopName:'Proxy fixture',platform:'tmall',cookies:[{name:'cookie2',value:'fixture-cookie'}],userAgent:fixture.userAgent,appKey:fixture.appKey};
const closes:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const close of closes.splice(0))await close();});

function proxyOf(value:object):unknown{return (value as {proxy?:unknown}).proxy;}
function expectPrivate(text:string){
  for(const secret of ['fixture-user','fixture-password','proxy.example','fixture-cookie',proxy])expect(text).not.toContain(secret);
  expect(text).not.toMatch(/"proxy"\s*:/);
}
async function setup(collector?:Collector){
  const seen:AccountCredentials[]=[];
  const logs:string[]=[];
  const logStream=new Writable({write(chunk,_encoding,done){logs.push(String(chunk));done();}});
  const store=new Store(':memory:','a'.repeat(64));
  // CI runners have no TMPDIR; create an owned scratch directory instead of relying on ambient env.
  const dataDir=mkdtempSync(join(tmpdir(),'account-proxy-test-'));
  const result=await buildApp({store,collector:collector??{
    verify:async input=>{seen.push(input);return {...account,userAgent:input.userAgent??account.userAgent,appKey:input.appKey??account.appKey};},
    collect:async()=>({cookies:[{name:'cookie2',value:'fixture-refreshed-cookie'}],expected:0,processed:0,failedProductIds:[],coverageComplete:true}),
  },dataDir,serveStatic:false,logStream});
  closes.push(async()=>{await result.app.close();store.close();rmSync(dataDir,{recursive:true,force:true});});
  const auth=await result.app.inject({method:'POST',url:'/api/auth/setup',payload:{password:'fixture_password_long'}});
  expect(auth.statusCode).toBe(200);
  const headers={cookie:auth.cookies.map(cookie=>`${cookie.name}=${cookie.value}`).join('; ')};
  const request=(method:'GET'|'POST'|'PATCH'|'DELETE',url:string,payload?:object)=>result.app.inject({method,url,headers,payload});
  const create=async(value:object={proxy})=>{
    const response=await request('POST','/api/shops',{...fixture,...value});
    expect(response.statusCode).toBe(200);
    return response;
  };
  return {...result,store,seen,logs,request,create};
}

describe('account proxy schema',()=>{
  // Missing transforms silently discard a proxy, or allow an unusable value into the encrypted vault.
  it.each([
    [' HTTP://Proxy.Example:8080 ','http://proxy.example:8080/'],
    ['https://proxy.example:443/','https://proxy.example/'],
    ['http://proxy.example:80','http://proxy.example/'],
    ['socks://proxy.example','socks://proxy.example:1080/'],
    ['socks5://proxy.example/','socks5://proxy.example:1080/'],
    ['socks5://proxy.example:1081','socks5://proxy.example:1081/'],
    ['http://fixture%40user:fixture%3Apass@Proxy.Example:8080','http://fixture%40user:fixture%3Apass@proxy.example:8080/'],
    ['socks5://[::1]:1080/','socks5://[::1]:1080/'],
    ['',undefined],['   ',undefined],[null,undefined],[undefined,undefined],
  ])('normalizes supported endpoints and clearing values (%#)',(value,expected)=>{
    const parsed=accountSchema.parse({...fixture,proxy:value});
    expect(proxyOf(parsed)).toBe(expected);
    expect(proxyOf(accountSchema.parse(parsed))).toBe(expected);
  });
  it.each([
    'ftp://proxy.example:21','socks4://proxy.example:1080','proxy.example:8080',
    'http://','socks5://','http:///proxy.example','http://proxy.example:0','socks5://proxy.example:0',
    'socks5://proxy.example:65536','http://proxy.example:abc','http://proxy.example:',
    'http://proxy.example/path','http://proxy.example/./','http://proxy.example/%2e',
    'http://proxy.example?','http://proxy.example?token=fixture-password','http://proxy.example#',
    'http://proxy.example/#fragment','http://proxy.ex\nample','\thttp://proxy.example',
    'http://fixture%ZZ:fixture-password@proxy.example','http://fixture-user:fixture%E0%A4@proxy.example',
    'http://fixture-user:fixture%0Apassword@proxy.example','http://fixture-user:fixture%7Fpassword@proxy.example',
    'http://proxy.example\\','socks5://bad%ZZ:1080',
  ])('rejects unsupported or ambiguous endpoints (%#)',value=>{
    const parsed=accountSchema.safeParse({...fixture,proxy:value});
    expect(parsed.success).toBe(false);
    if(!parsed.success){
      expect(parsed.error.issues.some(issue=>issue.path.join('.')==='proxy')).toBe(true);
      expectPrivate(parsed.error.message);
    }
  });
});

it('stores a normalized proxy encrypted while public account responses expose only hasProxy',async()=>{
  const {create,request,store,logs,seen}=await setup();
  const created=await create({proxy:` ${proxy.slice(0,-1)} `});
  const shop=created.json().shop as Shop;
  expect(shop.hasProxy).toBe(true);
  expect(proxyOf(store.getCredentials(shop.id))).toBe(proxy);
  expect(proxyOf(seen[0])).toBe(proxy);
  const record=store.db.prepare('SELECT payload,credentials FROM shops WHERE id=?').get(shop.id)!;
  expect(typeof record.credentials).toBe('string');
  expectPrivate(JSON.stringify(record));
  const listed=await request('GET','/api/shops');
  expect(listed.json().shops[0].hasProxy).toBe(true);
  const renamed=await request('PATCH',`/api/shops/${shop.id}`,{name:'Renamed fixture'});
  expect(renamed.json().shop.hasProxy).toBe(true);
  expect(proxyOf(store.getCredentials(shop.id))).toBe(proxy);
  expect(seen).toHaveLength(1);
  for(const response of [created,listed,renamed])expectPrivate(response.body);
  expect(logs.length).toBeGreaterThan(0);
  expectPrivate(logs.join(''));
});

it('re-verifies a proxy-only update and persists the input even when verification returns a stale proxy',async()=>{
  const seen:AccountCredentials[]=[];
  const {create,request,store}=await setup({
    verify:async input=>{seen.push(input);return {...account,proxy:'http://stale.example:8080/'} as VerifiedAccount;},
    collect:async()=>{throw Error('unused');},
  });
  const id=(await create({proxy:''})).json().shop.id;
  expect(proxyOf(store.getCredentials(id))).toBeUndefined();
  const updated=await request('PATCH',`/api/shops/${id}`,{proxy:` ${proxy.slice(0,-1)} `});
  expect(updated.statusCode).toBe(200);
  expect(updated.json().shop.hasProxy).toBe(true);
  expect(seen).toHaveLength(2);
  expect(proxyOf(seen[1])).toBe(proxy);
  expect(proxyOf(store.getCredentials(id))).toBe(proxy);
  expect((await request('GET','/api/shops')).json().shops[0].hasProxy).toBe(true);
  expectPrivate(updated.body);
});

it.each([null,'','   '])('explicit clearing values re-verify direct access and remove the encrypted proxy (%#)',async value=>{
  const seen:AccountCredentials[]=[];
  const {create,request,store,logs}=await setup({
    verify:async input=>{seen.push(input);return {...account,proxy} as VerifiedAccount;},
    collect:async()=>{throw Error('unused');},
  });
  const id=(await create()).json().shop.id;
  const version=store.getCredentialVersion(id);
  const cleared=await request('PATCH',`/api/shops/${id}`,{proxy:value});
  expect(cleared.statusCode).toBe(200);
  expect(seen).toHaveLength(2);
  expect(proxyOf(seen[1])).toBeUndefined();
  expect(proxyOf(store.getCredentials(id))).toBeUndefined();
  expect(store.getCredentialVersion(id)).toBe(version+1);
  expect(cleared.json().shop.hasProxy).toBe(false);
  expect((await request('GET','/api/shops')).json().shops[0].hasProxy).toBe(false);
  expectPrivate(cleared.body);expectPrivate(logs.join(''));
});

it('preserves an omitted proxy through credential updates, explicit verification and worker cookie refresh',async()=>{
  const {create,request,store,worker,seen,logs}=await setup();
  const id=(await create()).json().shop.id;
  const updated=await request('PATCH',`/api/shops/${id}`,{cookies:'cookie2=fixture-updated-cookie',userAgent:'Updated fixture browser',appKey:'updated_Key-2026'});
  expect(updated.statusCode).toBe(200);
  expect(proxyOf(seen[1])).toBe(proxy);
  expect(store.getCredentials(id)).toMatchObject({proxy,userAgent:'Updated fixture browser',appKey:'updated_Key-2026'});
  expect(updated.json().shop.hasProxy).toBe(true);
  const verified=await request('POST',`/api/shops/${id}/verify`);
  expect(verified.statusCode).toBe(200);
  expect(proxyOf(seen[2])).toBe(proxy);
  const run=worker.enqueue(id);
  await worker.whenIdle();
  expect(store.getRun(run.id)?.status).toBe('success');
  expect(store.getCredentials(id)).toMatchObject({proxy,cookies:[{name:'cookie2',value:'fixture-refreshed-cookie'}]});
  expect((await request('GET','/api/shops')).json().shops[0].hasProxy).toBe(true);
  expectPrivate(updated.body);expectPrivate(verified.body);expectPrivate(logs.join(''));
});

it('rejects malformed proxies before verification and never exposes submitted authentication in responses or logs',async()=>{
  const {create,request,store,seen,logs}=await setup();
  const id=(await create()).json().shop.id;
  const version=store.getCredentialVersion(id);
  for(const value of ['http://fixture-user:fixture%ZZpassword@proxy.example','http://fixture-user:fixture-password@proxy.example/private','http://fixture-user:fixture-password@proxy.example?token=fixture-cookie',123,{},[]]){
    for(const method of ['POST','PATCH'] as const){
      const response=await request(method,method==='POST'?'/api/shops':`/api/shops/${id}`,method==='POST'?{...fixture,proxy:value}:{proxy:value});
      expect(response.statusCode).toBe(400);
      expectPrivate(response.body);
    }
  }
  expect(seen).toHaveLength(1);
  expect(store.listShops()).toHaveLength(1);
  expect(store.getCredentialVersion(id)).toBe(version);
  expect(proxyOf(store.getCredentials(id))).toBe(proxy);
  expectPrivate(logs.join(''));
});

it('maps INVALID_CONFIGURATION to a safe typed message without replacing saved credentials',async()=>{
  let fail=false;
  const {create,request,store,logs}=await setup({
    verify:async()=>{if(fail)throw new CollectorError('INVALID_CONFIGURATION',`Cannot connect using ${proxy}`);return account;},
    collect:async()=>{throw Error('unused');},
  });
  const id=(await create()).json().shop.id;
  const version=store.getCredentialVersion(id);
  fail=true;
  for(const method of ['POST','PATCH'] as const){
    const response=await request(method,method==='POST'?`/api/shops/${id}/verify`:`/api/shops/${id}`,method==='PATCH'?{proxy:null}:undefined);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({code:'INVALID_CONFIGURATION',error:expect.any(String)});
    expectPrivate(response.body);
  }
  expect(store.getShop(id)?.sessionStatus).toBe('valid');
  expect(proxyOf(store.getCredentials(id))).toBe(proxy);
  expect(store.getCredentialVersion(id)).toBe(version);
  expectPrivate(logs.join(''));
});

it('reports no proxy after account removal and reimport without a proxy',async()=>{
  const {create,request,store}=await setup();
  const id=(await create()).json().shop.id;
  expect((await request('DELETE',`/api/shops/${id}`)).statusCode).toBe(200);
  expect((await request('GET','/api/shops?includeArchived=true')).json().shops[0].hasProxy).toBe(false);
  expect(()=>store.getCredentials(id)).toThrow();
  const restored=await create({proxy:null});
  expect(restored.json().shop).toMatchObject({id,hasProxy:false});
  expect(proxyOf(store.getCredentials(id))).toBeUndefined();
  expectPrivate(restored.body);
});
