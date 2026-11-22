import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {afterEach, describe, expect, it} from 'vitest';
import type {CookieRecord, ProductCollection, VerifiedAccount} from '../../shared/contracts.js';
import {createCollector, defaultHttpTransport, type HttpTransport} from '../src/collector/index.js';

// These fixtures describe protocol examples, never captured/live marketplace data.
const tokenName = ['_m_h5_', 'tk'].join('');
const ids = ['100001', '100002', '100003'];
const account: VerifiedAccount = {sellerId:'777777',shopName:'测试店',platform:'tmall',cookies:[{name:'unb',value:'42',domain:'.taobao.com'}],userAgent:'collector-test',appKey:'test-key'};
const product = (id:string, extra = false) => ({itemId:id,itemDesc:{desc:[{uiType:'link',text:`商品${id}`,url:`https://detail.tmall.com/item.htm?id=${id}`}]},skuList:[{skuId:`2${id}`,props:'颜色分类:蓝',price:'123.45',quantity:5},...(extra?[{skuId:`3${id}`,props:'颜色分类:红',price:'200.00',quantity:0}]:[])]});
function detail(id:string, seller='777777', price:any={priceMoney:'10000',priceText:'100.00',priceTitle:'优惠后'}) {
  return `<script>window.__ICE_APP_CONTEXT__=${JSON.stringify({loaderData:{home:{data:{res:{item:{itemId:id,title:`商品${id}`},seller:{userId:seller},shop:{title:'测试店'},skuBase:{props:[{pid:'1',name:'颜色分类',values:[{vid:'1',name:'蓝'}]}],skus:[{skuId:`2${id}`,propPath:'1:1'}]},skuCore:{sku2info:{[`2${id}`]:{price:{priceTitle:'优惠前',priceMoney:'12000',priceText:'120.00'},subPrice:price,quantity:5}}}}}}}})};</script>`;
}
function fixture(options:{list?:string[];backend?:string[];seller?:string;short?:boolean;duplicate?:boolean;total?:number;price?:any;ret?:string;business?:boolean;token?:boolean;principalChange?:boolean;wrongDetail?:boolean;delay?:number}={}) {
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
    let slice=all.slice((current-1)*2,current*2).map(id=>product(id,true));
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

describe('HTTP collector',()=>{
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
  it('rejects MTOP auth and nested business failure without echoing remote text',async()=>{
    for(const options of [{ret:'FAIL_SYS_SESSION_EXPIRED::secret-session'},{business:false}]){
      const f=fixture(options);
      try {await run(f);throw Error('must reject');} catch(e:any){expect(e.code).toMatch(/AUTH_REQUIRED|BUSINESS_FAILED/);expect(e.message).not.toContain('secret-session');}
    }
  });
  it('does not declare complete coverage for a short page or cross-page duplicate',async()=>{
    for(const options of [{short:true},{duplicate:true}]) await expect(run(fixture(options))).rejects.toMatchObject({code:'COVERAGE_INCOMPLETE'});
  });
  it('fails empty shop verification rather than trusting an imported principal',async()=>{
    await expect(createCollector({transport:fixture({list:[],backend:[]}).transport}).verify({platform:'tmall',cookies:'unb=42',appKey:'test-key'})).rejects.toMatchObject({code:'IDENTITY_UNVERIFIED'});
  });
  it('keeps backend data when detail ID mismatches and never joins an unrelated SKU',async()=>{
    const {products,result}=await run(fixture({wrongDetail:true}),['100001']);
    expect(products[0].rows.every(r=>r.after===null&&r.before===null)).toBe(true);
    expect(result.failedProductIds).toEqual(['100001']);
  });
  it('stops on a changed seller or changed session principal before writing data',async()=>{
    await expect(run(fixture({seller:'888888'}))).rejects.toMatchObject({code:'IDENTITY_CHANGED'});
    await expect(run(fixture({principalChange:true}))).rejects.toMatchObject({code:'IDENTITY_CHANGED'});
  });
  it('keeps exact-price rejection visible for range and hidden prices',async()=>{
    for(const price of [{priceMoney:'10000',priceText:'100.00',priceTitle:'优惠后',priceDesc:'起'},{priceMoney:'10000',priceTitle:'优惠后',hiddenPrice:true}]){
      const {products}=await run(fixture({price}),['100001']);expect(products[0].rows[0].after).toBeNull();expect(products[0].rows[0].status).toBe('partial');
    }
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
