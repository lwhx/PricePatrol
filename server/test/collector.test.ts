import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {afterEach, describe, expect, it} from 'vitest';
import type {CookieRecord, ProductCollection, VerifiedAccount} from '../../shared/contracts.js';
import {createCollector, defaultHttpTransport, type HttpTransport} from '../src/collector/index.js';

import {Store} from '../src/database.js';
import {Scheduler} from '../src/scheduler.js';
import {Worker} from '../src/worker.js';

// These fixtures describe protocol examples, never captured/live marketplace data.
const tokenName = ['_m_h5_', 'tk'].join('');
const ids = ['100001', '100002', '100003'];
const account: VerifiedAccount = {sellerId:'777777',shopName:'测试店',platform:'tmall',cookies:[{name:'unb',value:'42',domain:'.taobao.com'}],userAgent:'collector-test',appKey:'test-key'};
const product = (id:string, extra = false) => ({itemId:id,itemDesc:{desc:[{uiType:'link',text:`商品${id}`,url:`https://detail.tmall.com/item.htm?id=${id}`}]},skuList:[{skuId:`2${id}`,props:'颜色分类:蓝',price:'123.45',quantity:5},...(extra?[{skuId:`3${id}`,props:'颜色分类:红',price:'200.00',quantity:0}]:[])]});
function detail(id:string, seller='777777', price:any={priceMoney:'10000',priceText:'100.00',priceTitle:'优惠后'}) {
  return `<script>window.__ICE_APP_CONTEXT__=${JSON.stringify({loaderData:{home:{data:{res:{item:{itemId:id,title:`商品${id}`},seller:{userId:seller},shop:{title:'测试店'},skuBase:{props:[{pid:'1',name:'颜色分类',values:[{vid:'1',name:'蓝'}]}],skus:[{skuId:`2${id}`,propPath:'1:1'}]},skuCore:{sku2info:{[`2${id}`]:{price:{priceTitle:'优惠前',priceMoney:'12000',priceText:'120.00'},subPrice:price,quantity:5}}}}}}}})};</script>`;
}
function fixture(options:{list?:string[];backend?:string[];seller?:string;short?:boolean;duplicate?:boolean;total?:number;price?:any;ret?:string;business?:boolean;token?:boolean;principalChange?:boolean;wrongDetail?:boolean;delay?:number;backendExtra?:boolean;malformedSku?:string}={}) {
  const requests:{url:URL;headers:Record<string,string>;body?:string}[]=[];
  const transport:HttpTransport=async (url, init)=>{
    requests.push({url:new URL(url),headers:init.headers,body:init.body});
    if(options.delay) await new Promise(resolve=>setTimeout(resolve,options.delay));
    const u=new URL(url);
    if(u.hostname==='detail.tmall.com'||u.hostname==='item.taobao.com') return {status:200,headers:{},body:detail(options.wrongDetail?'999999':u.searchParams.get('id')!,options.seller,options.price)};
    const envelope=JSON.parse(new URLSearchParams(init.body).get('data')!);
    const query=JSON.parse(envelope.jsonBody);
    const all=query.tab==='on_sale'?(options.list??ids):(options.backend??ids);
    const current=query.pagination.current;
    let slice=all.slice((current-1)*2,current*2).map(id=>product(id,options.backendExtra??true));
    if(query.tab==='on_sale_skucenter') for(const p of slice) if(p.itemId===options.malformedSku) p.skuList[0].price='123.45–200';
    if(options.duplicate&&current===2) slice=[product(ids[0])];
    if(options.short&&current===1) slice=slice.slice(0,1);
    if(envelope.url.startsWith('/taobao/')) for(const p of slice) p.itemDesc.desc[0].url=p.itemDesc.desc[0].url.replace('detail.tmall.com','item.taobao.com');
    const needsToken=options.token&&!init.headers.Cookie?.includes(`${tokenName}=`);
    return {status:200,headers:{'set-cookie':needsToken?[`${tokenName}=fresh_123; Domain=.taobao.com; Path=/; Secure`]:options.principalChange?['unb=99; Domain=.taobao.com; Path=/']:[]},body:JSON.stringify({ret:[needsToken?'FAIL_SYS_TOKEN_EMPTY::token':options.ret??'SUCCESS::调用成功'],data:{result:JSON.stringify({success:options.business??true,data:{pagination:{current,pageSize:2,total:options.total??all.length},table:{dataSource:slice}}})}})};
  };
  return {transport,requests};
}
async function run(f=fixture(), productIds?:string[], extra:Record<string,unknown>={}) {
  const products:ProductCollection[]=[];const progress:any[]=[];
  const result=await createCollector({transport:f.transport}).collect({shopId:'shop',credentials:account,productIds,signal:new AbortController().signal,onProduct:p=>{products.push(p);},onProgress:p=>{progress.push(p);},...extra});
  return {result,products,progress,requests:f.requests};
}

it.each(['expired', 'changed principal', 'replaced during request'])('pauses scheduled collection on %s credentials and resumes its original run', async scenario => {
  const store = new Store(':memory:', 'scheduled-credential-regression-key');
  const at = '2026-11-01T00:00:00.000Z';
  const shop = {id:'shop', sellerId:account.sellerId, name:account.shopName, platform:account.platform, enabled:true, sessionStatus:'valid' as const,
    lastVerifiedAt:at, lastError:null, createdAt:at, updatedAt:at, hasCookies:true};
  const expired = [{name:'unb',value:'fixture',domain:'.taobao.com',expires:1}];
  store.saveShop(shop, {...account, cookies:scenario === 'expired' ? expired : account.cookies});
  store.saveTask({id:'task',shopId:shop.id,name:'daily',enabled:true,scope:'all',productIds:[],
    schedule:{kind:'daily',time:'08:00',days:[],timezone:'Asia/Shanghai'},version:1,createdAt:at,updatedAt:at,nextRunAt:at});
  const changed = fixture({principalChange:true}), healthy = fixture({list:[], backend:[]});
  let repaired = false;
  const replacement = {...account, cookies:[{name:'unb',value:'replacement',domain:'.taobao.com'}]};
  const worker = new Worker(store, createCollector({transport:async (url,init) => {
    if (repaired) return healthy.transport(url,init);
    if (scenario === 'replaced during request') store.saveShop(shop, replacement);
    return changed.transport(url,init);
  }}));
  try {
    const scheduler = new Scheduler(store, worker);
    scheduler.tick(new Date(at));
    await worker.whenIdle();
    const [run] = store.listRuns();
    expect(run).toMatchObject({trigger:'scheduled',status:'auth_required',finishedAt:null,alertDispatchStatus:'pending'});
    expect(changed.requests).toHaveLength(scenario === 'expired' ? 0 : 1);
    if (scenario === 'replaced during request') {
      expect(store.getShop(shop.id)?.sessionStatus).toBe('valid');
      expect(store.getCredentials(shop.id)).toEqual(replacement);
    } else {
      expect(store.getShop(shop.id)?.sessionStatus).toBe('auth_required');
      scheduler.tick(new Date('2026-11-02T00:00:00Z'));
      await worker.whenIdle();
      expect(store.listRuns()).toHaveLength(1);
      expect(store.db.prepare("SELECT reason FROM schedule_events WHERE outcome='skipped'").get()?.reason).toBe('account_invalid');
      store.saveShop(shop, replacement);
    }
    repaired = true;
    worker.resume(run!.id);
    await worker.whenIdle();
    expect(store.getRun(run!.id)).toMatchObject({status:'success',trigger:'scheduled'});
    expect(store.listRuns()).toHaveLength(1);
  } finally { await worker.close(); store.close(); }
});

describe('HTTP collector',()=>{
  it('verifies and collects using a supported first-page size without accepting empty declared pages',async()=>{
    const f=fixture();
    const transport:HttpTransport=async(url,init)=>{
      if(init.body){
        const q=JSON.parse(JSON.parse(new URLSearchParams(init.body).get('data')!).jsonBody);
        if(q.pagination.pageSize>20)return {status:200,headers:{},body:JSON.stringify({ret:['SUCCESS::ok'],data:{result:JSON.stringify({success:true,data:{pagination:{...q.pagination,total:3},table:{dataSource:[]}}})}})};
      }
      return f.transport(url,init);
    };
    const collector=createCollector({transport});
    expect(await collector.verify(account)).toMatchObject({sellerId:account.sellerId});
    const products:ProductCollection[]=[];
    const result=await collector.collect({shopId:'shop',credentials:account,signal:new AbortController().signal,onProduct:p=>{products.push(p);},onProgress:()=>{}});
    expect(result).toMatchObject({expected:3,processed:3,failedProductIds:[],coverageComplete:true});
    expect(products.map(p=>p.productId)).toEqual(ids);
  });

  it.each(['tmall','taobao'] as const)('verifies %s sessions when the management endpoint requires a language preference',async platform=>{
    const f=fixture();
    const transport:HttpTransport=async(url,init)=>{
      if(new URL(url).hostname==='h5api.m.taobao.com'&&!Object.entries(init.headers).some(([key,value])=>key.toLowerCase()==='accept-language'&&value.includes('zh-CN')))
        return {status:200,headers:{},body:JSON.stringify({ret:['FAIL_SYS_USER_VALIDATE::challenge','RGV587_ERROR::challenge']})};
      return f.transport(url,init);
    };
    const actual=await createCollector({transport}).verify({...account,platform});
    expect(actual).toMatchObject({sellerId:account.sellerId,shopName:account.shopName,platform});
    expect(f.requests.filter(r=>r.body).length).toBeGreaterThanOrEqual(2);
  });

  it('exports a Collector implementation',()=>{expect(createCollector()).toHaveProperty('collect');});
  it('verifies permission and actual seller identity, receives and signs with renewed token',async()=>{
    const f=fixture({token:true});
    const actual=await createCollector({transport:f.transport,now:()=>1700000000000}).verify({platform:'tmall',cookies:'unb=42',appKey:'test-key'});
    expect(actual).toMatchObject({sellerId:'777777',shopName:'测试店',platform:'tmall'});
    expect(actual.cookies.some(c=>c.name===tokenName&&c.value==='fresh_123')).toBe(true);
    const r=f.requests.find(r=>r.headers.Cookie?.includes(`${tokenName}=`))!;
    const data=new URLSearchParams(r.body).get('data');
    expect(r.url.searchParams.get('sign')).toBe(createHash('md5').update(`fresh&1700000000000&test-key&${data}`).digest('hex'));
    expect(JSON.parse(data!).url).toBe('/tmall/manager/table.htm');
  });
  it('uses returned pageSize, preserves backend-only SKUs and emits every product',async()=>{
    const {result,products,progress,requests}=await run();
    expect(result).toMatchObject({expected:3,processed:3,failedProductIds:[],coverageComplete:true});
    expect(products.map(p=>p.productId)).toEqual(ids);
    expect(products[0].rows).toEqual(expect.arrayContaining([expect.objectContaining({skuId:'2100001',backendPrice:'123.45',before:'120.00',after:'100.00',backendVerified:true,status:'ok'}),expect.objectContaining({skuId:'3100001',backendPrice:'200.00',after:null,status:'backend_only',stock:0})]));
    expect(products[0].skuSetComplete).not.toBe(true);
    expect(progress.at(-1)).toMatchObject({expected:3,processed:3});
    const second=requests.filter(r=>r.body).map(r=>JSON.parse(JSON.parse(new URLSearchParams(r.body).get('data')!).jsonBody)).filter(q=>q.pagination.current===2);
    expect(second.length).toBeGreaterThanOrEqual(2);
    expect(second.every(q=>q.pagination.pageSize===2)).toBe(true);
  });
  it('limits detail and product callbacks to selected IDs, reporting missing targets individually',async()=>{
    const {result,products,requests}=await run(fixture(),['100003','999999']);
    expect(products.map(p=>p.productId)).toEqual(['100003','999999']);
    expect(products[1]).toMatchObject({rows:[],error:expect.any(String)});
    expect(result).toMatchObject({expected:2,processed:2,failedProductIds:['999999'],coverageComplete:false});
    expect(requests.filter(r=>r.url.pathname==='/item.htm').every(r=>r.url.searchParams.get('id')==='100003')).toBe(true);
  });
  it('ignores malformed SKU prices on unselected products while marking an agreeing SKU set complete',async()=>{
    const {products,result,requests}=await run(fixture({backendExtra:false,malformedSku:'100002'}),['100001']);
    expect(products).toEqual([expect.objectContaining({productId:'100001',skuSetComplete:true})]);
    expect(result).toMatchObject({processed:1,failedProductIds:[],coverageComplete:true});
    expect(requests.filter(r=>r.url.pathname==='/item.htm').map(r=>r.url.searchParams.get('id'))).toEqual(['100001']);
  });
  it('isolates invalid exact backend prices and continues with the next product on the same page',async()=>{
    const {products,result}=await run(fixture({backendExtra:false,malformedSku:'100001'}));
    expect(products).toHaveLength(3);
    expect(products[0]).toMatchObject({productId:'100001',error:expect.any(String),rows:[expect.objectContaining({skuId:'2100001',after:'100.00',backendPrice:null,backendVerified:false,status:'partial'})]});
    expect(products[0].skuSetComplete).not.toBe(true);
    expect(products[1]).toMatchObject({productId:'100002',skuSetComplete:true});
    expect(result).toMatchObject({processed:3,failedProductIds:['100001'],coverageComplete:false});
  });
  it('rejects MTOP auth and nested business failure without echoing remote text',async()=>{
    for(const options of [{ret:'FAIL_SYS_SESSION_EXPIRED::secret-session'},{business:false}]){
      const f=fixture(options);
      try {await run(f);throw Error('must reject');} catch(e:any){expect(e.code).toMatch(/AUTH_REQUIRED|BUSINESS_FAILED/);expect(e.message).not.toContain('secret-session');}
    }
  });
  it('classifies authorization from the protocol code before decoding an invalid result',async()=>{
    const verify=async(ret:string,result:unknown)=>{
      const transport:HttpTransport=async()=>({status:200,headers:{},body:JSON.stringify({ret:[ret],data:{result}})});
      return createCollector({transport}).verify({platform:'tmall',cookies:'unb=42',appKey:'test-key'});
    };
    await expect(verify('FAIL_SYS_SESSION_EXPIRED::expired','invalid')).rejects.toMatchObject({code:'AUTH_REQUIRED'});
    await expect(verify('FAIL_SYS_SERVICE_BUSY::authentication service temporarily unavailable',{success:false})).rejects.toMatchObject({code:'MTOP_FAILED'});
  });
  it('does not declare complete coverage for a short page or cross-page duplicate',async()=>{
    for(const options of [{short:true},{duplicate:true}]) await expect(run(fixture(options))).rejects.toMatchObject({code:'COVERAGE_INCOMPLETE'});
  });
  it('fails empty shop verification rather than trusting an imported principal',async()=>{
    await expect(createCollector({transport:fixture({list:[],backend:[]}).transport}).verify({platform:'tmall',cookies:'unb=42',appKey:'test-key'})).rejects.toMatchObject({code:'IDENTITY_UNVERIFIED'});
  });
  it('checks additional pages for common membership and respects the probe limit',async()=>{
    const crossPage=fixture({list:['100001','100002','100003'],backend:['100004','100005','100003'],malformedSku:'100003'});
    const verify=(transport:HttpTransport)=>createCollector({transport}).verify({platform:'tmall',cookies:'unb=42',appKey:'test-key'});
    await expect(verify(crossPage.transport)).resolves.toMatchObject({sellerId:'777777'});
    expect(crossPage.requests.filter(r=>r.url.pathname==='/item.htm').map(r=>r.url.searchParams.get('id'))).toEqual(['100003']);
    const list=Array.from({length:50},(_,index)=>String(100001+index));
    const backend=Array.from({length:49},(_,index)=>String(200001+index)).concat(list[49]);
    const farAway=fixture({list,backend});
    await expect(verify(farAway.transport)).rejects.toMatchObject({code:'IDENTITY_UNVERIFIED'});
    expect(farAway.requests.length).toBeLessThanOrEqual(10);
    expect(farAway.requests.every(r=>r.body)).toBe(true);
  });
  it('keeps backend data when detail ID mismatches and never joins an unrelated SKU',async()=>{
    const {products,result}=await run(fixture({wrongDetail:true}),['100001']);
    expect(products[0].rows.every(r=>r.after===null&&r.before===null)).toBe(true);
    expect(result.failedProductIds).toEqual(['100001']);
  });
  it('stops on a changed seller or changed session principal before writing data',async()=>{
    await expect(run(fixture({seller:'888888'}))).rejects.toMatchObject({code:'IDENTITY_CHANGED'});
    await expect(run(fixture({principalChange:true}))).rejects.toMatchObject({code:'IDENTITY_CHANGED'});
    const f=fixture({seller:'888888'});
    const transport:HttpTransport=async(url,init)=>{
      const response=await f.transport(url,init);
      if(new URL(url).pathname==='/item.htm')response.body=response.body.replace('"skuId":"2100001"','"skuId":"broken"');
      return response;
    };
    const observed:string[]=[];
    await expect(run({...f,transport},['100001'],{onProduct:(p:ProductCollection)=>observed.push(p.productId)})).rejects.toMatchObject({code:'IDENTITY_CHANGED'});
    expect(observed).toEqual([]);
  });
  it('keeps exact-price rejection visible for range and hidden prices',async()=>{
    for(const price of [{priceMoney:'10000',priceText:'100.00',priceTitle:'优惠后',priceDesc:'起'},{priceMoney:'10000',priceTitle:'优惠后',hiddenPrice:true},{priceText:'90071992547409.92',priceTitle:'优惠后'}]){
      const {products}=await run(fixture({price,backendExtra:false}),['100001']);
      expect(products[0].rows[0].after).toBeNull();
      expect(products[0].rows[0].status).toBe('partial');
      expect(products[0].skuSetComplete).not.toBe(true);
    }
  });
  it('preserves the final cent for a large safe detail price',async()=>{
    const price={priceMoney:'9007199254740990',priceText:'90071992547409.90',priceTitle:'优惠后'};
    const {products}=await run(fixture({price,backendExtra:false}),['100001']);
    expect(products[0].rows[0].after).toBe('90071992547409.90');
  });
  it.each([
    {price:'70368744177664.01',cents:'',nested:false,valid:true},
    {price:'90071992547409.91',cents:'"priceMoney":9007199254740991,',nested:true,valid:true},
    {price:'90071992547409.92',cents:'',nested:true,valid:false},
  ])('preserves raw numeric price $price in backend and detail payloads',async({price,cents,nested,valid})=>{
    const result=`{"success":true,"data":{"pagination":{"current":1,"pageSize":100,"total":1},"table":{"dataSource":[{"itemId":100001,"skuList":[{"skuId":2100001,"price":${price},"quantity":7}]}]}}}`;
    const table=`{"ret":["SUCCESS"],"data":{"result":${nested?JSON.stringify(result):result}}}`;
    const html=`<script>window.__ICE_APP_CONTEXT__={"loaderData":{"home":{"data":{"res":{"item":{"itemId":100001,"title":"Fixture"},"seller":{"userId":777777},"skuBase":{"props":[{"pid":"1","name":"颜色分类","values":[{"vid":"1","name":"蓝"}]}],"skus":[{"skuId":2100001,"propPath":"1:1"}]},"skuCore":{"sku2info":{"2100001":{"price":{${cents}"priceText":${price},"priceTitle":"售价"},"quantity":2}}}}}}}};</script>`;
    const transport:HttpTransport=async url=>({status:200,headers:{},body:new URL(url).pathname==='/item.htm'?html:table});
    const {products}=await run({transport,requests:[]},['100001']);
    const [collected]=products;
    expect(collected.rows[0]).toMatchObject({
      productId:'100001',skuId:'2100001',
      before:valid?price:null,after:valid?price:null,backendPrice:valid?price:null,
      stock:valid?7:2,status:valid?'ok':'partial',
    });
    expect(collected.skuSetComplete===true).toBe(valid);
  });
  it('rejects invalid/foreign cookies and respects expiry/domain/path',async()=>{
    for(const cookies of ['', '[]', [{name:'unb',value:'x',domain:'evil.example'}], [{name:'unb',value:'x',domain:'.taobao.com',expires:1}]]) await expect(createCollector().verify({platform:'tmall',cookies:cookies as CookieRecord[],appKey:'test-key'})).rejects.toMatchObject({code:'COOKIE_INVALID'});
    const f=fixture();await createCollector({transport:f.transport}).verify({platform:'tmall',appKey:'test-key',cookies:JSON.stringify([{name:'unb',value:'42',domain:'.taobao.com'},{name:'scoped',value:'yes',domain:'h5api.m.taobao.com',path:'/h5/'},{name:'notSent',value:'no',domain:'.tmall.com',path:'/private'}])});
    expect(f.requests.find(r=>r.body)!.headers.Cookie).toContain('scoped=yes');expect(f.requests.some(r=>r.headers.Cookie?.includes('notSent='))).toBe(false);
  });
  it('aborts between product commits and propagates persistence failures',async()=>{
    const controller=new AbortController();const written:string[]=[];
    await expect(run(fixture(),undefined,{signal:controller.signal,onProduct:(p:ProductCollection)=>{written.push(p.productId);controller.abort();}})).rejects.toMatchObject({code:'ABORTED'});
    expect(written).toEqual(['100001']);
    await expect(run(fixture(),undefined,{onProduct:()=>{throw Error('database unavailable');}})).rejects.toThrow('database unavailable');
  });
  it('revalidates backend membership on resume without refetching or rewriting successful products',async()=>{
    const {products,result,requests}=await run(fixture(),undefined,{skipProductIds:['100001','100002']});
    expect(products.map(p=>p.productId)).toEqual(['100003']);
    expect(result).toMatchObject({expected:1,processed:1,coverageComplete:true});
    expect(requests.filter(r=>r.url.pathname==='/item.htm').map(r=>r.url.searchParams.get('id'))).toEqual(['100003']);
    expect(requests.filter(r=>r.body).length).toBe(4);
  });
  it('reports missing resumed products without invoking onProduct for them',async()=>{
    const {products,result}=await run(fixture({list:['100002'],backend:['100002']}),['100001','100002'],{skipProductIds:['100001']});
    expect(products.map(p=>p.productId)).toEqual(['100002']);
    expect(result).toMatchObject({expected:1,processed:1,failedProductIds:['100001'],coverageComplete:false});
  });
  it('rejects a response token forever after at most one refresh retry',async()=>{
    const f=fixture({ret:'FAIL_SYS_TOKEN_EXPIRED::do-not-log',token:true});
    await expect(createCollector({transport:f.transport}).verify({platform:'tmall',cookies:'unb=42',appKey:'test-key'})).rejects.toMatchObject({code:'AUTH_REQUIRED'});
    expect(f.requests).toHaveLength(2);
  });
  it('classifies rate limits and rejects cross-platform links or redirect targets',async()=>{
    await expect(run(fixture({ret:'FAIL_SYS_TRAFFIC_LIMIT::secret'}))).rejects.toMatchObject({code:'RATE_LIMIT'});
    const f=fixture();
    const transport:HttpTransport=async(url,init)=>{const r=await f.transport(url,init);return {...r,url:'https://evil.example/item.htm?id=100001'};};
    await expect(createCollector({transport}).verify({platform:'tmall',cookies:'unb=42',appKey:'test-key'})).rejects.toMatchObject({code:'UNSAFE_REDIRECT'});
  });
  it('retries only a bounded short HTTP rate-limit cooldown and preserves the terminal error',async()=>{
    const verify=(transport:HttpTransport)=>createCollector({transport}).verify({platform:'tmall',cookies:'unb=42',appKey:'test-key'});
    const cases=[
      ['0',2],['120',1],['0.5',1],['1994-11-06T08:49:37Z',1],
      ['Wed, 30 Feb 1994 08:49:37 GMT',1],['Mon, 06 Nov 1994 08:49:37 GMT',1],
      ['Sun, 06 Nov 1994 08:49:37 GMT',2],['Sunday, 06-Nov-94 08:49:37 GMT',2],['Sun Nov  6 08:49:37 1994',2],
      [new Date(Date.now()+120_000).toUTCString(),1],
    ] as const;
    for(const [retryAfter,attempts] of cases){
      let requests=0;
      await expect(verify(async()=>{requests++;return {status:429,headers:{'retry-after':retryAfter},body:''};})).rejects.toMatchObject({code:'RATE_LIMIT'});
      expect(requests,retryAfter).toBe(attempts);
    }
  });
  it('retries a transient connection error once',async()=>{
    let requests=0;
    const transport:HttpTransport=async()=>{requests++;throw Error('fixture connection error');};
    await expect(createCollector({transport}).verify({platform:'tmall',cookies:'unb=42',appKey:'test-key'})).rejects.toMatchObject({code:'NETWORK_ERROR'});
    expect(requests).toBe(2);
  });
  it('does not accept malformed pagination metadata as a zero-product shop',async()=>{
    const f=fixture({list:[],backend:[]});
    const transport:HttpTransport=async(url,init)=>{const r=await f.transport(url,init);const reply=JSON.parse(r.body);const result=JSON.parse(reply.data.result);result.data.pagination.total='';reply.data.result=result;return {...r,body:JSON.stringify(reply)};};
    await expect(createCollector({transport}).verify({platform:'tmall',cookies:'unb=42',appKey:'test-key'})).rejects.toMatchObject({code:'INVALID_RESPONSE'});
  });
  it('enforces five global in-flight requests across Collector instances and isolates cookie jars',async()=>{
    let active=0,max=0;const values=new Set<string>();
    await Promise.all(Array.from({length:12},async(_,i)=>{
      const f=fixture();
      const transport:HttpTransport=async(url,init)=>{active++;max=Math.max(max,active);try{values.add(init.headers.Cookie);await new Promise(resolve=>setTimeout(resolve,3));return await f.transport(url,init);}finally{active--;}};
      return createCollector({transport}).verify({platform:'tmall',cookies:`unb=${i}`,appKey:'test-key'});
    }));
    expect(max).toBe(5);expect(values.size).toBeGreaterThanOrEqual(12);
  });
  it('honors a pre-aborted signal before any network request',async()=>{
    const f=fixture();const controller=new AbortController();controller.abort();
    await expect(run(f,undefined,{signal:controller.signal})).rejects.toMatchObject({code:'ABORTED'});expect(f.requests).toHaveLength(0);
  });
  it('rejects unsafe numeric detail identifiers even when their rounded text matches a backend ID',async()=>{
    const id='9007199254740992';const f=fixture({list:[id],backend:[id]});
    const transport:HttpTransport=async(url,init)=>{const r=await f.transport(url,init);return new URL(url).pathname==='/item.htm'?{...r,body:r.body.replace(`"itemId":"${id}"`,`"itemId":${id}`)}:r;};
    const {products,result}=await run({...f,transport},[id]);
    expect(products[0].rows.every(row=>row.before===null&&row.after===null)).toBe(true);
    expect(result.failedProductIds).toEqual([id]);
  });
  it('uses the taobao API, route and detail host together',async()=>{
    const f=fixture();const verified=await createCollector({transport:f.transport}).verify({platform:'taobao',cookies:'unb=42',appKey:'test-key'});
    expect(verified.platform).toBe('taobao');expect(f.requests.filter(r=>r.body).every(r=>r.url.pathname.includes('mtop.taobao.sell.pc.manage.async')&&JSON.parse(new URLSearchParams(r.body).get('data')!).url==='/taobao/manager/table.htm')).toBe(true);
    expect(f.requests.some(r=>r.url.hostname==='item.taobao.com')).toBe(true);
  });
});

const closers:(()=>Promise<void>)[]=[];
afterEach(async()=>{await Promise.all(closers.splice(0).map(f=>f()));});
it('treats epoch-zero cookies as expired and preserves host-only cookie scope',async()=>{
  await expect(createCollector().verify({platform:'tmall',appKey:'test-key',cookies:[{name:'unb',value:'42',domain:'.taobao.com',expires:0}]})).rejects.toMatchObject({code:'COOKIE_INVALID'});
  const f=fixture();await createCollector({transport:f.transport}).verify({platform:'tmall',appKey:'test-key',cookies:[{name:'unb',value:'42',domain:'.taobao.com'},{name:'hostOnly',value:'local',domain:'taobao.com'}]});
  expect(f.requests.some(r=>r.headers.Cookie.includes('hostOnly='))).toBe(false);
});
it('returns an HTTP redirect from the real local transport without following Location',async()=>{
  const paths:string[]=[];
  const server=createServer((req,res)=>{
    paths.push(req.url!);
    if(req.url==='/redirect')res.writeHead(307,{Location:'/landing'});
    res.end();
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  closers.push(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
  const {port}=server.address() as {port:number};
  const response=await defaultHttpTransport(`http://127.0.0.1:${port}/redirect`,{method:'GET',headers:{},signal:new AbortController().signal});
  expect(response.status).toBe(307);
  expect(response.headers.location).toBe('/landing');
  expect(paths).toEqual(['/redirect']);
});
it('persists the effective Max-Age expiry when Expires conflicts',async()=>{
  const f=fixture();
  let sent=false;
  const transport:HttpTransport=async(url,init)=>{
    const response=await f.transport(url,init);
    if(!sent && new URL(url).hostname==='h5api.m.taobao.com'){
      sent=true;
      response.headers['set-cookie']=['fresh=value; Domain=.taobao.com; Path=/; Max-Age=60; Expires=Thu, 01 Jan 1970 00:00:00 GMT'];
    }
    return response;
  };
  const start=Date.now()/1000;
  const verified=await createCollector({transport}).verify({platform:'tmall',cookies:'unb=42',appKey:'test-key'});
  const renewal=verified.cookies.find(cookie=>cookie.name==='fresh');
  expect(renewal?.expires).toBeGreaterThanOrEqual(start+60);
  expect(renewal?.expires).toBeLessThanOrEqual(Date.now()/1000+60);
  expect(renewal?.session).toBeUndefined();
});
it('runs verification and collection through real local HTTP without replacing signing or cookie handling',async()=>{
  const f=fixture({token:true});
  const server=createServer(async(req,res)=>{
    try {
      let body='';for await(const chunk of req)body+=chunk;
      const target=new URL(req.url!,'http://local').searchParams.get('target')!;
      const headers:Record<string,string>={Cookie:String(req.headers.cookie??'')};
      const reply=await f.transport(target,{method:req.method as 'GET'|'POST',headers,body:body||undefined,signal:new AbortController().signal});
      for(const [key,value] of Object.entries(reply.headers))if(value!==undefined)res.setHeader(key,value);
      res.writeHead(reply.status);res.end(reply.body);
    }catch{res.writeHead(500);res.end('fixture-server-error');}
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));closers.push(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
  const address=server.address() as {port:number};
  const transport:HttpTransport=async(url,init)=>({...await defaultHttpTransport(`http://127.0.0.1:${address.port}/?target=${encodeURIComponent(url)}`,init),url});
  const collector=createCollector({transport});
  const verified=await collector.verify({platform:'tmall',cookies:'unb=42',appKey:'test-key'});
  const products:ProductCollection[]=[];
  const result=await collector.collect({shopId:'shop',credentials:verified,productIds:['100001'],signal:new AbortController().signal,onProgress:()=>{},onProduct:p=>{products.push(p);}});
  expect(result).toMatchObject({processed:1,coverageComplete:true});expect(products[0].rows[0].after).toBe('100.00');
  expect(verified.cookies.some(c=>c.name===tokenName)).toBe(true);
});
it('exercises real Node HTTP transport with a local server, preserving separate Set-Cookie headers',async()=>{
  const server=createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;res.setHeader('Set-Cookie',['a=1; Path=/','b=2; Path=/']);res.end(`${req.method}:${body}`);});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));closers.push(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
  const address=server.address() as {port:number};
  const r=await defaultHttpTransport(`http://127.0.0.1:${address.port}/`,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'data=abc',signal:new AbortController().signal});
  expect(r.body).toBe('POST:data=abc');expect(r.headers['set-cookie']).toHaveLength(2);
});
