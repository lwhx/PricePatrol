import {afterEach, expect, it} from 'vitest';
import {Store} from '../src/database.js';
import {buildApp} from '../src/app.js';
import type {Collector, CollectedRow, VerifiedAccount} from '../../shared/contracts.js';

const key = 'collection-alert-tests-encryption-key-64-characters';
const at = '2026-11-23T00:00:00.000Z';
const credentials: VerifiedAccount = {sellerId:'seller',shopName:'店铺',platform:'tmall',cookies:[],userAgent:'fixture',appKey:'fixture'};
const price: CollectedRow = {shopId:'s',productId:'1000001',skuId:'2000001',title:'沙发',specs:'三人位',seatSpec:'三人位',color:'白',backendPrice:'100',before:'100',after:'70',backendVerified:true,status:'ok',sourceUrl:'',backendSource:'fixture',detailFetchedAt:at,backendFetchedAt:at,stock:1};
const close: (()=>Promise<void>)[] = [];
afterEach(async()=>{for(const fn of close.splice(0))await fn();});

async function setup(collector?: Collector) {
  const store = new Store(':memory:', key);
  store.saveShop({id:'s',name:'店铺',sellerId:'seller',platform:'tmall',enabled:true,sessionStatus:'valid',lastVerifiedAt:at,lastError:null,createdAt:at,updatedAt:at,hasCookies:true}, credentials);
  const ctx = await buildApp({store, dataDir:'/tmp/pricepatrol-collection-alert-tests', encryptionKey:key, serveStatic:false, collector:collector || {verify:async()=>credentials, collect:async o=>{await o.onProduct({productId:price.productId,title:price.title,rows:[price]});return {cookies:[],expected:1,processed:1,failedProductIds:[],coverageComplete:true};}}});
  close.push(async()=>{await ctx.app.close();store.close();});
  const login = await ctx.app.inject({method:'POST',url:'/api/auth/setup',payload:{password:'fixture-long-password'}});
  const headers = {cookie:login.cookies.map(c=>`${c.name}=${c.value}`).join('; ')};
  return {...ctx,store,headers};
}

it('manual execution of a scheduled task only collects prices and never creates alerts',async()=>{
  const {store,worker}=await setup();
  store.saveTask({id:'c',shopId:'s',name:'每日采集',enabled:true,scope:'all',productIds:[],schedule:{kind:'daily',time:'09:00',days:[],timezone:'Asia/Shanghai'},version:1,createdAt:at,updatedAt:at,nextRunAt:null});
  store.saveAlertTask({id:'a',collectionTaskId:'c',shopId:'s',name:'预警',enabled:true,scope:'all',productIds:[],version:1,createdAt:at,updatedAt:at,
    rules:[{mode:'all',conditions:[{field:'discount',op:'lt',value:'8.5'}]}],whitelist:{productIds:[],titleKeywords:[]},notify:false});
  const run=worker.enqueue('s','c');await worker.whenIdle();
  expect(store.getRunPrices(run.id)).toHaveLength(1);
  expect(store.listAlerts()).toHaveLength(0);
  expect(store.getRun(run.id)).toMatchObject({status:'success',trigger:'manual',matched:0});
});

it('creates collection and alert configurations independently',async()=>{
  const {app,headers}=await setup();
  const collection=await app.inject({method:'POST',url:'/api/tasks',headers,payload:{shopId:'s',name:'每日取价',enabled:true,scope:'all',productIds:[],schedule:{kind:'daily',time:'09:00',days:[],timezone:'Asia/Shanghai'}}});
  expect(collection.statusCode).toBe(200);
  expect(collection.json().task).not.toHaveProperty('rules');
  const alert=await app.inject({method:'POST',url:'/api/alert-tasks',headers,payload:{collectionTaskId:collection.json().task.id,name:'低于八五折',enabled:true,scope:'all',productIds:[],rules:[{mode:'all',conditions:[{field:'discount',op:'lt',value:'8.5'}]}],whitelist:{productIds:[],titleKeywords:[]},notify:false}});
  expect(alert.statusCode).toBe(200);
  expect(alert.json().task).toMatchObject({shopId:'s',collectionTaskId:collection.json().task.id});
});

it('only the scheduler can create scheduled provenance; manual API bodies cannot opt into alerts',async()=>{
  const {app,headers,store,worker,alertWorker,scheduler}=await setup();
  store.saveTask({id:'c',shopId:'s',name:'每日采集',enabled:true,scope:'all',productIds:[],schedule:{kind:'daily',time:'09:00',days:[],timezone:'Asia/Shanghai'},version:1,createdAt:at,updatedAt:at,nextRunAt:'2026-11-22T01:00:00.000Z'});
  store.saveAlertTask({id:'a',collectionTaskId:'c',shopId:'s',name:'预警',enabled:true,scope:'all',productIds:[],version:1,createdAt:at,updatedAt:at,rules:[{mode:'all',conditions:[{field:'discount',op:'lt',value:'8.5'}]}],whitelist:{productIds:[],titleKeywords:[]},notify:false});
  for(const url of ['/api/tasks/c/run','/api/shops/s/collect']){
    const response=await app.inject({method:'POST',url,headers,payload:{trigger:'scheduled',scheduled:true}});
    expect(response.statusCode).toBe(200);expect(response.json().run.trigger).toBe('manual');
  }
  await worker.whenIdle();await alertWorker.whenIdle();expect(store.listAlertRuns()).toEqual([]);
  scheduler.tick(new Date('2026-11-23T02:00:00.000Z'));await worker.whenIdle();await alertWorker.whenIdle();
  expect(store.listAlertRuns()).toHaveLength(1);
  const source=store.getRun(store.listAlertRuns()[0]!.collectionRunId)!;
  expect(source).toMatchObject({trigger:'scheduled',status:'success'});
  const response=await app.inject({method:'GET',url:`/api/runs?runId=${source.id}`,headers});
  expect(response.json().runs).toHaveLength(1);expect(response.json().runs[0]).not.toHaveProperty('alertTaskSnapshots');
});
