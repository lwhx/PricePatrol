import { it, expect } from 'vitest';
import { Store } from '../src/database.js';
import { buildApp } from '../src/app.js';
import { CollectorError } from '../src/collector/errors.js';
import { createCollector } from '../src/collector/index.js';
import type { Collector } from '../../shared/contracts.js';

function deferred(){
  let release!:()=>void;
  const promise=new Promise<void>(resolve=>{release=resolve;});
  return {promise,resolve:release};
}

it('reports missing appKey separately and never echoes raw transport credentials', async () => {
  let failure: Error = new CollectorError('APPKEY_REQUIRED', 'internal details');
  const collector: Collector = {
    verify: async () => { throw failure; },
    collect: async () => { throw new Error('unused'); },
  };
  const store = new Store(':memory:', 'a'.repeat(64));
  const { app } = await buildApp({ store, collector, dataDir: '.local/test-data', serveStatic: false });
  try {
    const auth = await app.inject({ method: 'POST', url: '/api/auth/setup', payload: { password: 'test-password-for-fixture' } });
    const cookie = auth.cookies.map(c => `${c.name}=${c.value}`).join('; ');
    const submit = () => app.inject({ method: 'POST', url: '/api/shops', headers: { cookie }, payload: { platform: 'tmall', cookies: 'cookie2=fixture-secret' } });
    const missing = await submit();
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error).toContain('缺少 appKey');
    failure = new Error('https://remote.example?cookie2=fixture-secret');
    const unknown = await submit();
    expect(unknown.statusCode).toBe(500);
    expect(unknown.body).not.toContain('fixture-secret');
    expect(unknown.body).not.toContain('remote.example');
    expect(store.listShops()).toHaveLength(0);
  } finally { await app.close(); store.close(); }
});

it('accepts an alphanumeric appKey on both account creation and credential updates', async () => {
  const appKey = ['fixture', 'Key', '2026'].join('_') + '-a';
  const seen: string[] = [];
  const collector: Collector = {
    verify: async input => {
      seen.push(input.appKey || '');
      return { sellerId: 'fixture-seller', shopName: 'Fixture shop', platform: input.platform, cookies: [{ name: 'cookie2', value: 'fixture-session', domain: '.taobao.com' }], userAgent: input.userAgent || 'Fixture browser', appKey: input.appKey || '' };
    },
    collect: async () => { throw new Error('unused'); },
  };
  const store = new Store(':memory:', 'a'.repeat(64));
  const { app } = await buildApp({ store, collector, dataDir: '.local/test-data', serveStatic: false });
  try {
    const auth = await app.inject({ method: 'POST', url: '/api/auth/setup', payload: { password: 'fixture_password_long' } });
    const cookie = auth.cookies.map(c => `${c.name}=${c.value}`).join('; ');
    const created = await app.inject({ method: 'POST', url: '/api/shops', headers: { cookie }, payload: { platform: 'tmall', cookies: 'cookie2=fixture-session', appKey } });
    expect(created.statusCode).toBe(200);
    const updated = await app.inject({ method: 'PATCH', url: `/api/shops/${created.json().shop.id}`, headers: { cookie }, payload: { appKey } });
    expect(updated.statusCode).toBe(200);
    expect(seen).toEqual([appKey, appKey]);
    const rejected = await app.inject({ method: 'PATCH', url: `/api/shops/${created.json().shop.id}`, headers: { cookie }, payload: { appKey: 'invalid key' } });
    expect(rejected.statusCode).toBe(400);
  } finally { await app.close(); store.close(); }
});

it('returns typed verification errors and only invalidates saved credentials on confirmed authorization failure', async () => {
  let errorCode:string|undefined;
  const collector:Collector={
    verify:async input=>{
      if(errorCode)throw new CollectorError(errorCode,'fixture-secret');
      return {sellerId:'123456',shopName:'Fixture shop',platform:input.platform,cookies:[{name:'unb',value:'fixture-secret'}],userAgent:'Fixture browser',appKey:'fixture-key'};
    },
    collect:async()=>{throw Error('unused');},
  };
  const store=new Store(':memory:','a'.repeat(64));
  const {app}=await buildApp({store,collector,dataDir:'.local/test-data',serveStatic:false});
  try{
    const auth=await app.inject({method:'POST',url:'/api/auth/setup',payload:{password:'fixture_password_long'}});
    const headers={cookie:auth.cookies.map(c=>`${c.name}=${c.value}`).join('; ')};
    const created=await app.inject({method:'POST',url:'/api/shops',headers,payload:{platform:'tmall',cookies:'unb=fixture-secret'}});
    const shop=created.json().shop;
    const request=()=>app.inject({method:'POST',url:`/api/shops/${shop.id}/verify`,headers});
    for(errorCode of ['RATE_LIMIT','NETWORK_ERROR','TIMEOUT','IDENTITY_UNVERIFIED']){
      const response=await request();
      expect(response.json()).toMatchObject({code:errorCode,error:expect.any(String)});
      expect(response.body).not.toContain('fixture-secret');
      expect(store.getShop(shop.id)).toMatchObject({sessionStatus:'valid',lastVerifiedAt:shop.lastVerifiedAt});
    }
    errorCode='AUTH_REQUIRED';
    expect((await request()).json()).toMatchObject({code:'AUTH_REQUIRED'});
    expect(store.getShop(shop.id)).toMatchObject({sessionStatus:'auth_required',lastVerifiedAt:shop.lastVerifiedAt});
  }finally{await app.close();store.close();}
});

it('protects refreshed credentials and concurrent shop metadata from stale verification', async () => {
  let hold:{started:ReturnType<typeof deferred>;release:ReturnType<typeof deferred>;fail:boolean}|undefined;
  const collector:Collector={
    verify:async input=>{
      const session=typeof input.cookies==='string'?input.cookies.split('=')[1]:input.cookies[0].value;
      if(session==='original'&&hold){
        const pending=hold;
        pending.started.resolve();
        await pending.release.promise;
        if(pending.fail)throw new CollectorError('AUTH_REQUIRED','original session expired');
      }
      return {sellerId:'123456',shopName:'Fixture shop',platform:input.platform,cookies:[{name:'unb',value:session}],userAgent:'Fixture browser',appKey:'fixture-key'};
    },
    collect:async()=>{throw Error('unused');},
  };
  const store=new Store(':memory:','a'.repeat(64));
  const {app}=await buildApp({store,collector,dataDir:'.local/test-data',serveStatic:false});
  try{
    const auth=await app.inject({method:'POST',url:'/api/auth/setup',payload:{password:'fixture_password_long'}});
    const headers={cookie:auth.cookies.map(c=>`${c.name}=${c.value}`).join('; ')};
    const created=await app.inject({method:'POST',url:'/api/shops',headers,payload:{platform:'tmall',cookies:'unb=original'}});
    const {id}=created.json().shop;
    const verify=()=>app.inject({method:'POST',url:`/api/shops/${id}/verify`,headers});
    const patch=(payload:object)=>app.inject({method:'PATCH',url:`/api/shops/${id}`,headers,payload});
    for(const fail of [false,true]){
      expect((await patch({cookies:'unb=original'})).statusCode).toBe(200);
      hold={started:deferred(),release:deferred(),fail};
      const stale=verify();
      try{
        await hold.started.promise;
        expect((await patch({cookies:'unb=refreshed',name:'Renamed shop',enabled:false})).statusCode).toBe(200);
      }finally{hold.release.resolve();}
      const response=await stale;
      expect(response.json().code).toBe(fail?'AUTH_REQUIRED':'CREDENTIALS_CHANGED');
      expect(store.getCredentials(id).cookies[0].value).toBe('refreshed');
      expect(store.getShop(id)).toMatchObject({sessionStatus:'valid',name:'Renamed shop',enabled:false,lastError:null});
      hold=undefined;
    }
    await patch({cookies:'unb=original'});
    hold={started:deferred(),release:deferred(),fail:false};
    const active=verify();
    try{
      await hold.started.promise;
      expect((await patch({name:'Metadata changed',enabled:true})).statusCode).toBe(200);
    }finally{hold.release.resolve();}
    expect((await active).json().shop).toMatchObject({name:'Metadata changed',enabled:true});
  }finally{await app.close();store.close();}
});

it('preserves the saved session on ordinary un-followed redirects and invalidates it on a login redirect',async()=>{
  const requests:string[]=[];
  let location:string|string[]|undefined;
  let status=307;
  const collector=createCollector({transport:async url=>{
    requests.push(url);
    return {status,headers:{location,'set-cookie':'unb=changed; Domain=.taobao.com; Path=/'},body:''};
  }});
  const store=new Store(':memory:','a'.repeat(64));
  const shop={id:'fixture-shop',name:'Fixture shop',sellerId:'123456',platform:'tmall',enabled:true,sessionStatus:'valid',lastVerifiedAt:new Date().toISOString(),lastError:null,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),hasCookies:true} as const;
  const credentials={platform:'tmall',sellerId:shop.sellerId,shopName:shop.name,cookies:[{name:'unb',value:'fixture-session',domain:'.taobao.com'}],appKey:'fixture-key',userAgent:'Fixture browser'} as const;
  store.saveShop(shop,{...credentials,cookies:[...credentials.cookies]});
  const version=store.getCredentialVersion(shop.id);
  const {app}=await buildApp({store,collector,dataDir:'.local/test-data',serveStatic:false});
  try{
    const auth=await app.inject({method:'POST',url:'/api/auth/setup',payload:{password:'fixture_password_long'}});
    const headers={cookie:auth.cookies.map(c=>`${c.name}=${c.value}`).join('; ')};
    const verify=()=>app.inject({method:'POST',url:`/api/shops/${shop.id}/verify`,headers});
    const inconclusive=[
      {status:307,location:'/maintenance'},
      {status:302,location:'https://login.taobao.com/maintenance'},
      {status:302,location:'https://login.taobao.com.untrusted.example/member/login.jhtml'},
      {status:304,location:'https://login.taobao.com/member/login.jhtml'},
      {status:302,location:['/maintenance','https://login.taobao.com/member/login.jhtml']},
    ];
    for(const response of inconclusive){
      ({status,location}=response);
      expect((await verify()).json()).toMatchObject({code:'HTTP_ERROR'});
      expect(store.getShop(shop.id)).toMatchObject({sessionStatus:'valid',lastVerifiedAt:shop.lastVerifiedAt});
    }
    status=302;
    location='https://login.taobao.com/member/login.jhtml?redirect=fixture-secret';
    const failure=await verify();
    expect(failure.json()).toMatchObject({code:'AUTH_REQUIRED'});
    expect(failure.body).not.toContain('fixture-secret');
    expect(store.getShop(shop.id)).toMatchObject({sessionStatus:'auth_required',lastVerifiedAt:shop.lastVerifiedAt});
    expect(store.getCredentials(shop.id)).toEqual(credentials);
    expect(store.getCredentialVersion(shop.id)).toBe(version);
    expect(requests).toHaveLength(inconclusive.length+1);
    expect(requests.every(url=>new URL(url).hostname==='h5api.m.taobao.com')).toBe(true);
  }finally{await app.close();store.close();}
});
