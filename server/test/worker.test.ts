import {describe,it,expect,afterEach} from 'vitest';
import {Store} from '../src/database.js';
import {Worker} from '../src/worker.js';
import {AlertWorker} from '../src/alert-worker.js';
import type {AlertTask,Collector,VerifiedAccount,TaskInput,CollectedRow} from '../../shared/contracts.js';

const credentials:VerifiedAccount={sellerId:'seller-1',shopName:'测试店',platform:'tmall',cookies:[],userAgent:'test',appKey:'test'};
const cleanup:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const close of cleanup.splice(0))await close();});
function setup(collector:Collector){
 const store=new Store(':memory:','a'.repeat(64)),now=new Date().toISOString();
 store.saveShop({id:'shop1',name:'测试店',sellerId:'seller-1',platform:'tmall',enabled:true,sessionStatus:'valid',lastVerifiedAt:now,lastError:null,createdAt:now,updatedAt:now,hasCookies:true},credentials);
 const alertWorker=new AlertWorker(store),worker=new Worker(store,collector,run=>alertWorker.enqueueForCollection(run.id));
 cleanup.push(async()=>{await worker.close();await alertWorker.close();store.close();});
 const settle=async()=>{await worker.whenIdle();await alertWorker.whenIdle();};
 return {store,worker,settle};
}
function price(productId:string,title:string,after:string):CollectedRow{return {shopId:'shop1',productId,skuId:'999999999999',title,specs:'三人位',seatSpec:'三人位',color:'蓝色',backendPrice:'100.00',before:'100.00',after,backendVerified:true,status:'ok',sourceUrl:`https://detail.tmall.com/item.htm?id=${productId}`,backendSource:'mtop.tmall.sell.pc.manage.async',detailFetchedAt:new Date().toISOString(),backendFetchedAt:new Date().toISOString(),stock:10};}
const taskInput:TaskInput={shopId:'shop1',name:'全店',enabled:true,scope:'all',productIds:[],schedule:{kind:'daily',time:'09:00',days:[],timezone:'Asia/Shanghai'}};
function task(store:Store,id:string,alertPatch:Partial<AlertTask>={}){
 const now=new Date().toISOString();
 store.saveTask({...taskInput,id,version:1,createdAt:now,updatedAt:now,nextRunAt:null});
 const alert:AlertTask={id:`alert-${id}`,collectionTaskId:id,shopId:'shop1',name:`${id} 折扣预警`,enabled:true,scope:'all',productIds:[],rules:[{mode:'all',conditions:[{field:'discount',op:'lt',value:'8.5'}]}],whitelist:{productIds:[],titleKeywords:['自由岛']},notify:false,version:1,createdAt:now,updatedAt:now,...alertPatch};
 store.saveAlertTask(alert);return alert;
}

describe('worker run snapshots and queues',()=>{
 it('collects whitelisted products and excludes them only in the separate scheduled alert evaluation',async()=>{
  const collector:Collector={verify:async()=>credentials,collect:async o=>{
   for(const [id,title,after] of [['111111111111','普通沙发','82'],['222222222222','自由岛沙发','70'],['333333333333','普通等值','85']])await o.onProduct({productId:id!,title:title!,rows:[price(id!,title!,after!)]});
   return {cookies:[],expected:3,processed:3,failedProductIds:[],coverageComplete:true};
  }};
  const {store,worker,settle}=setup(collector);task(store,'t1');
  const run=worker.enqueue('shop1','t1',undefined,true);await settle();
  expect(store.getRun(run.id)).toMatchObject({status:'success',trigger:'scheduled',rows:3,checked:0,excluded:0,matched:0});
  expect(store.getRunPrices(run.id)).toHaveLength(3);
  expect(store.listAlertRuns({collectionRunId:run.id})[0]).toMatchObject({status:'success',checked:2,excluded:1,matched:1});
  expect(store.listAlerts()).toHaveLength(1);
  expect(store.listAlerts()[0]).toMatchObject({productId:'111111111111',taskId:'alert-t1'});
 });

 it('freezes rule and whitelist versions when queued and does not merge same-shop collection tasks',async()=>{
  let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);let calls=0;
  const collector:Collector={verify:async()=>credentials,collect:async o=>{
   calls++;if(calls===1)await gate;
   await o.onProduct({productId:'111111111111',title:'普通沙发',rows:[price('111111111111','普通沙发','82')]});
   return {cookies:[],expected:1,processed:1,failedProductIds:[],coverageComplete:true};
  }};
  const {store,worker,settle}=setup(collector);
  const first=task(store,'t1'),second=task(store,'t2',{whitelist:{productIds:['111111111111'],titleKeywords:[]}});
  const a=worker.enqueue('shop1','t1',undefined,true),b=worker.enqueue('shop1','t2',undefined,true);
  store.saveAlertTask({...first,rules:[{mode:'all',conditions:[{field:'discount',op:'lt',value:'7'}]}],version:2});
  store.saveAlertTask({...second,whitelist:{productIds:[],titleKeywords:[]},version:2});
  release();await settle();
  expect(a.id).not.toBe(b.id);expect(calls).toBe(2);
  expect(store.listAlertRuns({collectionRunId:a.id})[0]).toMatchObject({alertTaskId:first.id,ruleVersion:1,matched:1});
  expect(store.listAlertRuns({collectionRunId:b.id})[0]).toMatchObject({alertTaskId:second.id,ruleVersion:1,excluded:1,matched:0});
  expect(store.listAlerts()).toHaveLength(1);
 });

 it('manual failure retry creates a new related collection without alerts and preserves the original report',async()=>{
  let calls=0;
  const collector:Collector={verify:async()=>credentials,collect:async o=>{
   calls++;
   if(calls===1){await o.onProduct({productId:'111111111111',title:'失败',rows:[],error:'暂时失败'});return {cookies:[],expected:1,processed:1,failedProductIds:['111111111111'],coverageComplete:false};}
   expect(o.productIds).toEqual(['111111111111']);
   await o.onProduct({productId:'111111111111',title:'普通',rows:[price('111111111111','普通','80')]});
   return {cookies:[],expected:1,processed:1,failedProductIds:[],coverageComplete:true};
  }};
  const {store,worker,settle}=setup(collector);task(store,'t1');
  const a=worker.enqueue('shop1','t1',undefined,true);await settle();
  const old=JSON.stringify(store.getRun(a.id)),oldAlert=JSON.stringify(store.listAlertRuns({collectionRunId:a.id}));
  expect(store.listAlertRuns({collectionRunId:a.id})[0]).toMatchObject({status:'partial',unknown:1,matched:0});
  const b=worker.retry(a.id);await settle();
  expect(b.id).not.toBe(a.id);
  expect(store.getRun(b.id)).toMatchObject({status:'success',trigger:'manual',parentRunId:a.id,alertDispatchStatus:'not_applicable',alertTaskSnapshots:[],matched:0});
  expect(store.getRunPrices(b.id)[0]).toMatchObject({after:'80.00',stale:false});
  expect(store.listAlertRuns({collectionRunId:b.id})).toEqual([]);expect(store.listAlerts()).toEqual([]);
  expect(JSON.stringify(store.getRun(a.id))).toBe(old);
  expect(JSON.stringify(store.listAlertRuns({collectionRunId:a.id}))).toBe(oldAlert);
 });
});
