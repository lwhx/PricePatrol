import {afterEach,expect,it} from 'vitest';
import {Store,type RunRecord,type AlertRunRecord} from '../src/database.js';
import {previewRetention,cleanupRetention} from '../src/retention.js';
import type {CollectionTask,AlertTask,CollectedRow} from '../../shared/contracts.js';
const at='2020-01-01T00:00:00.000Z';
const policy={historyBefore:'2024-01-01T00:00:00.000Z',alertBefore:'2023-01-01T00:00:00.000Z'};
const stores:Store[]=[];afterEach(()=>stores.splice(0).forEach(store=>store.close()));
function fixture(){
 const store=new Store(':memory:','retention-fixture-key-at-least-32-characters');stores.push(store);
 store.saveShop({id:'s',name:'shop',sellerId:'seller',platform:'tmall',enabled:true,sessionStatus:'valid',lastVerifiedAt:at,lastError:null,createdAt:at,updatedAt:at,hasCookies:false});
 const task:CollectionTask={id:'c',shopId:'s',name:'collection',enabled:true,scope:'all',productIds:[],schedule:{kind:'daily',time:'09:00',days:[],timezone:'Asia/Shanghai'},version:1,createdAt:at,updatedAt:at,nextRunAt:null};store.saveTask(task);
 const alertTask:AlertTask={id:'a',collectionTaskId:'c',shopId:'s',name:'alert',enabled:true,scope:'all',productIds:[],rules:[],whitelist:{productIds:[],titleKeywords:[]},notify:false,version:1,createdAt:at,updatedAt:at};store.saveAlertTask(alertTask);
 function batch(id:string,options:{matched?:boolean;state?:'pending'|'confirmed'|'resolved';notificationStatus?:string;unfinished?:boolean;dispatchPending?:boolean;latest?:boolean;resolvedAt?:string}={}){
  const run:RunRecord={id,shopId:'s',taskId:'c',shopName:'shop',taskName:'collection',status:'running',trigger:'scheduled',alertDispatchStatus:'pending',scope:'all',productIds:[],expected:1,processed:1,failed:0,rows:1,checked:0,excluded:0,matched:0,unknown:0,message:'fixture',createdAt:at,startedAt:at,finishedAt:null,parentRunId:null,failedProductIds:[],notificationStatus:'disabled',taskSnapshot:task,alertTaskSnapshots:[alertTask]};store.saveRun(run);
  const row:CollectedRow={shopId:'s',productId:'1000001',skuId:'2000001',title:'fixture',specs:'',seatSpec:'',color:'',backendPrice:'100',before:'100',after:'80',backendVerified:true,status:'ok',sourceUrl:'',backendSource:'fixture',detailFetchedAt:at,backendFetchedAt:at,stock:1};store.saveProduct(id,{productId:row.productId,title:'',rows:[row]});
  if(!options.latest)store.db.prepare('DELETE FROM latest WHERE run_id=?').run(id);
  if(options.unfinished)return;
  store.saveRun({...run,status:'success',finishedAt:at,alertDispatchStatus:options.dispatchPending?'pending':'dispatched'});
  if(options.dispatchPending)return;
  const evaluation:AlertRunRecord={id:id+':a',collectionRunId:id,alertTaskId:'a',shopId:'s',shopName:'shop',taskName:'alert',taskSnapshot:alertTask,ruleVersion:1,status:'running',rows:1,checked:1,excluded:0,matched:options.matched?1:0,unknown:0,message:'fixture',createdAt:at,startedAt:at,finishedAt:null,notificationStatus:options.notificationStatus||'disabled'};store.saveAlertRun(evaluation);
  if(options.matched)store.saveAlert({id:id+':event',alertRunId:evaluation.id,runId:id,taskId:'a',ruleVersion:1,shopId:'s',shopName:'shop',productId:row.productId,skuId:row.skuId,title:'fixture',specs:'',backendPrice:'100',before:'100',after:'80',discount:'8',reasons:[],state:options.state||'resolved',note:'',createdAt:at,...(options.resolvedAt?{resolvedAt:options.resolvedAt}:{})});
  store.saveAlertRun({...evaluation,status:'success',finishedAt:at});
 }
 return {store,batch};
}
it('previews and reclaims expired zero-hit evaluations and resolved evidence, leaving current prices intact',()=>{
 const {store,batch}=fixture();batch('zero');batch('resolved',{matched:true});batch('latest',{latest:true});
 const preview=previewRetention(store,policy);expect(preview).toMatchObject({runs:2,prices:2,alertRuns:2,alerts:1,protectedRuns:1,total:7});
 expect(store.getRun('zero')).toBeDefined();expect(cleanupRetention(store,policy)).toEqual({...preview,deleted:7});
 expect(store.getRun('zero')).toBeUndefined();expect(store.getAlert('resolved:event')).toBeUndefined();expect(store.getRunPrices('latest')).toHaveLength(1);
 expect(store.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
});
it('protects unresolved, recently resolved, unfinished, pending dispatch and failed or in-flight delivery evidence',()=>{
 const {store,batch}=fixture();batch('pending',{matched:true,state:'pending'});batch('confirmed',{matched:true,state:'confirmed'});batch('recent-resolution',{matched:true,resolvedAt:'2025-01-01T00:00:00.000Z'});
 batch('unfinished',{unfinished:true});batch('dispatch',{dispatchPending:true});
 for(const notificationStatus of ['pending','sending','failed','not_configured'])batch('delivery-'+notificationStatus,{notificationStatus});
 expect(cleanupRetention(store,policy).deleted).toBe(0);expect(store.listRuns()).toHaveLength(9);
});
it('protects active incident first and last evidence even after manual acknowledgement',()=>{
 const {store,batch}=fixture();batch('first',{matched:true});batch('last');batch('unrelated');
 store.db.exec('CREATE TABLE alert_incidents(id TEXT PRIMARY KEY,payload TEXT NOT NULL)');
 store.db.prepare('INSERT INTO alert_incidents VALUES(?,?)').run('incident',JSON.stringify({status:'active',firstCollectionRunId:'first',lastCollectionRunId:'last'}));
 expect(cleanupRetention(store,policy)).toMatchObject({runs:1,alertRuns:1,prices:1,alerts:0});expect(store.getRun('first')).toBeDefined();expect(store.getRun('last')).toBeDefined();
});
it('starts the evidence retention period when an old pending alert is resolved',()=>{
 const {store,batch}=fixture();batch('old',{matched:true,state:'pending'});
 const resolved=store.updateAlert('old:event',{state:'resolved'});
 expect(resolved.resolvedAt).toEqual(expect.any(String));
 expect(store.updateAlert('old:event',{note:'confirmed resolution'}).resolvedAt).toBe(resolved.resolvedAt);
 expect(cleanupRetention(store,policy).deleted).toBe(0);
 expect(store.updateAlert('old:event',{state:'pending'}).resolvedAt).toBeUndefined();
});
