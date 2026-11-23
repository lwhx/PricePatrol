import {afterEach, expect, it} from 'vitest';
import {Store} from '../src/database.js';
import {buildApp} from '../src/app.js';
import {AlertWorker} from '../src/alert-worker.js';
import {Scheduler} from '../src/scheduler.js';
import type {Collector,CollectOptions,CollectionTask,AlertTask,VerifiedAccount} from '../../shared/contracts.js';

const account:VerifiedAccount={sellerId:'removal-fixture',shopName:'移除测试店',platform:'tmall',cookies:[{name:'unb',value:'fixture-session'}],userAgent:'Fixture browser',appKey:'fixture-key'};
const closes:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const close of closes.splice(0))await close();});
function gate(){let resolve!:()=>void;const promise=new Promise<void>(done=>resolve=done);return {promise,resolve};}
async function setup(collector:Collector={verify:async()=>account,collect:async()=>({cookies:[],expected:0,processed:0,failedProductIds:[],coverageComplete:true})}){
 const store=new Store(':memory:','a'.repeat(64));
 const result=await buildApp({store,collector,dataDir:'.local/test-data',serveStatic:false});
 closes.push(async()=>{await result.app.close();store.close();});
 const auth=await result.app.inject({method:'POST',url:'/api/auth/setup',payload:{password:'fixture_password_long'}});
 const headers={cookie:auth.cookies.map(c=>`${c.name}=${c.value}`).join('; ')};
 const request=(method:'GET'|'POST'|'PATCH'|'DELETE',url:string,payload?:object)=>result.app.inject({method,url,headers,payload});
 const imported=await request('POST','/api/shops',{platform:'tmall',cookies:'unb=fixture-session'});
 expect(imported.statusCode).toBe(200);
 const shop=imported.json().shop;
 const at='2026-11-22T00:00:00.000Z';
 const task:CollectionTask={id:'collection',shopId:shop.id,name:'每日采集',enabled:true,scope:'all',productIds:[],schedule:{kind:'daily',time:'09:00',days:[],timezone:'Asia/Shanghai'},version:3,createdAt:at,updatedAt:at,nextRunAt:'2026-11-23T01:00:00.000Z'};
 const alert:AlertTask={id:'warning',shopId:shop.id,collectionTaskId:task.id,name:'低价预警',enabled:true,scope:'all',productIds:[],rules:[{mode:'all',conditions:[{field:'after',op:'lt',value:'100'}]}],whitelist:{productIds:[],titleKeywords:[]},notify:true,version:4,createdAt:at,updatedAt:at};
 store.saveTask(task);store.saveAlertTask(alert);
 return {...result,store,shop,task,alert,request};
}

it('removes the connected account, clears credentials and keeps its price/alert evidence and historical filters',async()=>{
 const collector:Collector={verify:async()=>account,collect:async o=>{
  await o.onProduct({productId:'123456',title:'历史商品',rows:[{shopId:o.shopId,productId:'123456',skuId:'999999',title:'历史商品',specs:'',seatSpec:'',color:'',backendPrice:'100',before:'100',after:'80',backendVerified:true,status:'ok',sourceUrl:'',backendSource:'fixture',detailFetchedAt:null,backendFetchedAt:null,stock:1}]});
  return {cookies:[],expected:1,processed:1,failedProductIds:[],coverageComplete:true};
 }};
 const {store,worker,alertWorker,shop,task,alert,request}=await setup(collector);
 const run=worker.enqueue(shop.id,task.id,undefined,true);await worker.whenIdle();await alertWorker.whenIdle();
 const history=store.history(shop.id,'123456');const alerts=store.listAlerts();const reports=store.listAlertRuns();const report=store.getRun(run.id);
 expect(history).toHaveLength(1);expect(alerts).toHaveLength(1);
 const before=store.getCredentialVersion(shop.id);
 expect((await request('DELETE',`/api/shops/${shop.id}`)).statusCode).toBe(200);
 expect((await request('GET','/api/shops')).json().shops).toEqual([]);
 expect(store.overview().shops).toBe(0);
 expect(store.getShop(shop.id)).toMatchObject({enabled:false,hasCookies:false,archivedAt:expect.any(String)});
 expect(()=>store.getCredentials(shop.id)).toThrow();
 expect(store.db.prepare('SELECT credentials FROM shops WHERE id=?').get(shop.id)?.credentials).toBeNull();
 expect(store.getCredentialVersion(shop.id)).toBeGreaterThan(before);
 expect(store.history(shop.id,'123456')).toEqual(history);expect(store.listAlerts()).toEqual(alerts);expect(store.listAlertRuns()).toEqual(reports);expect(store.getRun(run.id)).toEqual(report);
 expect(store.query({shopIds:[shop.id]}).total).toBe(1);
 const historical=(await request('GET','/api/shops?includeArchived=true')).json().shops;
 expect(historical).toHaveLength(1);expect(historical[0].archivedAt).toBeTruthy();
 expect(store.getTask(task.id)).toMatchObject({enabled:false,nextRunAt:null,version:4});
 expect(store.getAlertTask(alert.id)).toMatchObject({enabled:false,version:5});
 for(const [method,url,payload] of [['PATCH',`/api/shops/${shop.id}`,{enabled:true}],['POST',`/api/shops/${shop.id}/verify`,{}],['POST',`/api/shops/${shop.id}/collect`,{}],['POST',`/api/tasks/${task.id}/run`,{}],['PATCH',`/api/tasks/${task.id}`,{enabled:true}],['PATCH',`/api/alert-tasks/${alert.id}`,{enabled:true}]] as const){
  expect((await request(method,url,payload)).statusCode).toBeGreaterThanOrEqual(400);
 }
 expect((await request('DELETE',`/api/shops/${shop.id}`)).statusCode).toBe(200);
 expect(store.getCredentialVersion(shop.id)).toBe(before+1);
});

it('aborts active collection, retires queued work and never auto-resumes old plans after reimport',async()=>{
 const started=gate(),release=gate();let options!:CollectOptions;let collections=0;
 const collector:Collector={verify:async()=>account,collect:async o=>{collections++;options=o;started.resolve();await release.promise;
  await o.onProgress({phase:'fixture',expected:10,processed:10,failed:0,message:'迟到结果'});
  await o.onProduct({productId:'123456',title:'迟到商品',rows:[],error:'fixture'});
  return {cookies:[{name:'unb',value:'stale-session'}],expected:10,processed:10,failedProductIds:[],coverageComplete:true};
 }};
 const {store,worker,shop,task,request}=await setup(collector);
 const active=worker.enqueue(shop.id,task.id,undefined,true);await started.promise;
 const queued=worker.enqueue(shop.id,null,['123456']);
 try{
  await request('DELETE',`/api/shops/${shop.id}`);
  expect(options.signal.aborted).toBe(true);
  expect(store.getRun(queued.id)).toMatchObject({status:'stopped',finishedAt:expect.any(String)});
  expect(store.getRun(active.id)).toMatchObject({status:'stopped'});
  expect(()=>worker.resume(active.id)).toThrow();
  const version=store.getCredentialVersion(shop.id);
  const restored=await request('POST','/api/shops',{platform:'tmall',cookies:'unb=new-session'});
  expect(restored.statusCode).toBe(200);expect(restored.json().shop).toMatchObject({id:shop.id,enabled:true,hasCookies:true});expect(restored.json().shop.archivedAt).toBeFalsy();
  // The returned object is built in memory; the account list is read back from the database,
  // so the cleared archive marker must survive the round trip or the shop never reappears.
  expect(store.listShops().map(s=>s.id)).toContain(shop.id);
  expect(store.getShop(shop.id)?.archivedAt).toBeNull();
  expect(store.db.prepare('SELECT archived_at FROM shops WHERE id=?').get(shop.id)?.archived_at).toBeNull();
  expect((await request('GET','/api/shops')).json().shops.map((s:{id:string})=>s.id)).toContain(shop.id);
  expect(store.getCredentialVersion(shop.id)).toBeGreaterThan(version);
  new Scheduler(store,worker).tick(new Date('2026-11-24T01:00:00.000Z'));
 }finally{release.resolve();}
 await worker.whenIdle();
 expect(collections).toBe(1);expect(store.getRun(active.id)).toMatchObject({status:'stopped',rows:0,finishedAt:expect.any(String)});
 expect(store.getRun(queued.id)?.status).toBe('stopped');expect(store.getCredentials(shop.id).cookies[0].value).toBe('fixture-session');
 expect(store.query({}).total).toBe(0);expect(store.listAlertRuns()).toEqual([]);expect(store.getTask(task.id)?.enabled).toBe(false);
});

it('an in-flight verification or import cannot resurrect an account removed while it was verifying',async()=>{
 const started=gate(),release=gate();let hold=false;
 const collector:Collector={verify:async()=>{if(hold){started.resolve();await release.promise;}return account;},collect:async()=>{throw Error('unused');}};
 const {store,shop,request}=await setup(collector);hold=true;
 const stale=request('POST','/api/shops',{platform:'tmall',cookies:'unb=old-session'});
 try{await started.promise;await request('DELETE',`/api/shops/${shop.id}`);}finally{release.resolve();}
 expect((await stale).statusCode).toBe(409);expect(store.listShops()).toHaveLength(0);expect(()=>store.getCredentials(shop.id)).toThrow();
});

it('cancels pending frozen alert dispatch/evaluation/notifications and recovery cannot revive them',async()=>{
 const {store,worker,shop,task,request}=await setup();
 // Keep completed scheduled sources durable without dispatching until after removal.
 const source=worker.enqueue(shop.id,task.id,undefined,true);
 await worker.whenIdle();
 const completed=store.getRun(source.id)!;
 // The empty source has an existing evaluation; add a separate unfinished frozen evaluation fixture.
 const original=store.listAlertRuns()[0];expect(original).toBeDefined();
 const pending={...original,id:'pending-evaluation',status:'queued' as const,finishedAt:null,notificationStatus:'pending'};
 store.db.prepare('DELETE FROM alert_runs WHERE id=?').run(original.id);
 store.saveAlertRun(pending);
 completed.alertDispatchStatus='pending';
 store.db.prepare('UPDATE runs SET payload=? WHERE id=?').run(JSON.stringify(completed),completed.id);
 await request('DELETE',`/api/shops/${shop.id}`);
 expect(store.getRun(source.id)?.alertDispatchStatus).toBe('skipped');
 expect(store.getAlertRun(pending.id)).toMatchObject({status:'failed',notificationStatus:'skipped',finishedAt:expect.any(String)});
 const deliveries:string[]=[];const recovery=new AlertWorker(store,async run=>{deliveries.push(run.id);});
 recovery.recover();await recovery.whenIdle();await recovery.close();
 expect(deliveries).toEqual([]);expect(store.operationalAlertRuns(['queued','running'])).toEqual([]);
});
