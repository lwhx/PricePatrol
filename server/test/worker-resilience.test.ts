import {it,expect,afterEach} from 'vitest';
import {Store} from '../src/database.js';
import {Worker} from '../src/worker.js';
import type {Collector,VerifiedAccount,MonitorTask} from '../../shared/contracts.js';
const all:Store[]=[];afterEach(()=>all.splice(0).forEach(s=>s.close()));
const credentials:VerifiedAccount={sellerId:'seller',shopName:'测试',platform:'tmall',cookies:[],userAgent:'t',appKey:'1'};
function setup(collector:Collector){const store=new Store(':memory:','y'.repeat(64));all.push(store);const at=new Date().toISOString();store.saveShop({id:'s',sellerId:'seller',name:'测试',platform:'tmall',enabled:true,sessionStatus:'valid',lastVerifiedAt:at,lastError:null,createdAt:at,updatedAt:at,hasCookies:true},credentials);const task:MonitorTask={id:'t',shopId:'s',name:'任务',enabled:true,scope:'all',productIds:[],rules:[{mode:'all',conditions:[{field:'discount',op:'lt',value:'8.5'}]}],whitelist:{productIds:[],titleKeywords:[]},schedule:{kind:'manual',time:'09:00',days:[],timezone:'Asia/Shanghai'},notify:false,version:1,createdAt:at,updatedAt:at,nextRunAt:null};store.saveTask(task);return {store,worker:new Worker(store,collector)};}
it('marks an unexpected worker exception as failed instead of leaving the run stuck or rejecting',async()=>{
  const collector:Collector={verify:async()=>credentials,collect:async()=>{throw Object.assign(new Error('boom'),{code:'UNEXPECTED_INTERNAL'});}};
  const {store,worker}=setup(collector);
  const run=worker.enqueue('s','t');
  await worker.whenIdle();
  const saved=store.getRun(run.id)!;
  expect(saved.status).toBe('failed');
  expect(saved.finishedAt).not.toBeNull();
  expect(saved.message.length).toBeGreaterThan(0);
});
it('keeps processing later queued runs after one run crashes',async()=>{
  let calls=0;
  const collector:Collector={verify:async()=>credentials,collect:async options=>{calls+=1;if(calls===1)throw Error('explode');await options.onProduct({productId:'123456789012',title:'沙发',rows:[{shopId:'s',productId:'123456789012',skuId:'999999999999',title:'沙发',specs:'蓝',seatSpec:'三',color:'蓝',backendPrice:'100.00',before:'100.00',after:'80.00',backendVerified:true,status:'ok',sourceUrl:'https://detail.tmall.com/item.htm?id=123456789012',backendSource:'mtop.tmall.sell.pc.manage.async',detailFetchedAt:new Date().toISOString(),backendFetchedAt:new Date().toISOString(),stock:1}]});return {cookies:[],expected:1,processed:1,failedProductIds:[],coverageComplete:true};}};
  const {store,worker}=setup(collector);
  const first=worker.enqueue('s','t');await worker.whenIdle();
  const second=worker.enqueue('s','t');await worker.whenIdle();
  expect(store.getRun(first.id)!.status).toBe('failed');
  expect(store.getRun(second.id)!.status).toBe('success');
  expect(store.getRun(second.id)!.rows).toBe(1);
});
