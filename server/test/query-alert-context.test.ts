import {afterEach,describe,expect,it} from 'vitest';
import {Store,type RunRecord} from '../src/database.js';
import type {AlertTask,CollectionTask,CollectedRow,MonitorTask,RuleGroup} from '../../shared/contracts.js';

const at='2026-11-23T00:00:00.000Z';
const rules=(value='8.5'):RuleGroup[]=>[{mode:'all',conditions:[{field:'discount',op:'lt',value}]}];
const collection=(patch:Partial<CollectionTask>={}):CollectionTask=>({id:'c',shopId:'s',name:'每日采集',enabled:true,scope:'all',productIds:[],schedule:{kind:'daily',time:'09:00',days:[],timezone:'Asia/Shanghai'},version:1,createdAt:at,updatedAt:at,nextRunAt:null,...patch});
const alert=(patch:Partial<AlertTask>={}):AlertTask=>({id:'a',collectionTaskId:'c',shopId:'s',name:'折扣预警',enabled:true,scope:'all',productIds:[],rules:rules(),whitelist:{productIds:[],titleKeywords:[]},notify:false,version:1,createdAt:at,updatedAt:at,...patch});
const run=(patch:Partial<RunRecord>={}):RunRecord=>({id:'r',shopId:'s',taskId:'c',taskName:'每日采集',shopName:'店铺',status:'running',scope:'all',productIds:[],expected:0,processed:0,failed:0,rows:0,checked:0,excluded:0,matched:0,unknown:0,message:'',createdAt:at,startedAt:at,finishedAt:null,parentRunId:null,failedProductIds:[],notificationStatus:'disabled',taskSnapshot:collection(),trigger:'scheduled',alertDispatchStatus:'pending',alertTaskSnapshots:[alert()],...patch});
const price=(productId:string,after='80'):CollectedRow=>({shopId:'s',productId,skuId:'2000001',title:'沙发',specs:'三人位',seatSpec:'三人位',color:'白',backendPrice:'100',before:'100',after,backendVerified:true,status:'ok',sourceUrl:'',backendSource:'fixture',detailFetchedAt:at,backendFetchedAt:at,stock:1});
const stores:Store[]=[];
afterEach(()=>{for(const store of stores.splice(0))store.close();});
function fixture(c=collection(),a=alert(),r=run({taskSnapshot:c,alertTaskSnapshots:[a]})){
 const store=new Store(':memory:','query-alert-context-encryption-key-thirty-two-characters');stores.push(store);
 store.saveShop({id:'s',name:'店铺',sellerId:'seller',platform:'tmall',enabled:true,sessionStatus:'valid',lastVerifiedAt:at,lastError:null,createdAt:at,updatedAt:at,hasCookies:false});
 store.saveTask(c);store.saveAlertTask(a);store.saveRun(r);return store;
}
function add(store:Store,productId:string,after='80',runId='r'){store.saveProduct(runId,{productId,title:'沙发',rows:[price(productId,after)]});}

describe('separate alert query context',()=>{
 it('intersects the current collection and alert scopes and keeps independent rule sets',()=>{
  const c=collection({scope:'selected',productIds:['1000001','1000002']});
  const a=alert({scope:'selected',productIds:['1000002','1000003']});
  const store=fixture(c,a);
  for(const id of ['1000001','1000002','1000003'])add(store,id);
  store.saveAlertTask(alert({id:'a2',rules:rules('7.5')}));
  expect(store.query({taskId:'a'}).rows.map(row=>row.productId)).toEqual(['1000002']);
  expect(store.query({taskId:'a2'}).total).toBe(0);
  expect(store.query({taskId:'a2',groups:[]}).rows.map(row=>row.productId).sort()).toEqual(['1000001','1000002']);
 });

 it('keeps historical rules, whitelists and source scope after editing or deleting tasks',()=>{
  const a=alert({whitelist:{productIds:['1000001'],titleKeywords:[]}});
  const source=run({scope:'selected',productIds:['1000001','1000002'],alertTaskSnapshots:[a]});
  const store=fixture(collection(),a,source);
  for(const id of ['1000001','1000002','1000003'])add(store,id);
  store.saveAlertTask({...a,rules:rules('7.0'),whitelist:{productIds:['1000002'],titleKeywords:[]},version:2});
  store.saveTask(collection({scope:'selected',productIds:['1000003'],version:2}));
  expect(store.query({runId:'r',taskId:'a',whitelistMode:'included'}).rows.map(row=>row.productId)).toEqual(['1000002']);
  expect(store.query({runId:'r',taskId:'a',whitelistMode:'excluded'}).rows.map(row=>row.productId)).toEqual(['1000001']);
  expect(store.query({taskId:'a'}).total).toBe(0);
  store.deleteTask('c');
  expect(store.query({runId:'r',taskId:'a',whitelistMode:'included'}).rows.map(row=>row.productId)).toEqual(['1000002']);
  expect(()=>store.query({taskId:'a'})).toThrow();
 });

 it('does not substitute current alert configuration for manual or unlinked historical batches',()=>{
  const store=fixture();add(store,'1000001');
  store.saveRun(run({id:'manual',trigger:'manual',alertDispatchStatus:'not_applicable',alertTaskSnapshots:[]}));add(store,'1000001','70','manual');
  store.saveAlertTask(alert({id:'added-after-run'}));
  expect(()=>store.query({runId:'manual',taskId:'a'})).toThrow(/快照/);
  expect(()=>store.query({runId:'r',taskId:'added-after-run'})).toThrow(/快照/);
  expect(()=>store.query({runId:'missing',taskId:'a'})).toThrow();
  expect(store.query({runId:'manual'}).rows[0]).toMatchObject({after:'70.00'});
 });

 it('still reads migrated legacy monitor snapshots without depending on current tasks',()=>{
  const legacy:MonitorTask={...collection(),rules:rules(),whitelist:{productIds:['1000001'],titleKeywords:[]},notify:false};
  const store=fixture(collection(),alert(),run({trigger:'legacy',alertDispatchStatus:'not_applicable',alertTaskSnapshots:[],taskSnapshot:legacy}));
  add(store,'1000001');add(store,'1000002');
  store.deleteTask('c');
  expect(store.query({runId:'r',taskId:'c',whitelistMode:'included'}).rows.map(row=>row.productId)).toEqual(['1000002']);
  expect(store.query({runId:'r',taskId:'c',whitelistMode:'excluded'}).rows.map(row=>row.productId)).toEqual(['1000001']);
 });
});
