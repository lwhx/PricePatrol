import {afterEach,it,expect,vi} from 'vitest';
import {Store,type RunRecord} from '../src/database.js';
import {AlertWorker} from '../src/alert-worker.js';
import {initializeIncidents,listIncidents} from '../src/incidents.js';
import {notifyAlertRun} from '../src/notifications.js';
import {Vault} from '../src/security.js';
import {cleanupRetention} from '../src/retention.js';
import type {CollectionTask,AlertTask} from '../../shared/contracts.js';
const closers:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of closers.splice(0))await close();vi.useRealTimers();vi.unstubAllGlobals();});
function setup(){
 const key='independent-core-review-only-key-long';const store=new Store(':memory:',key),worker=new AlertWorker(store),vault=new Vault(key);
 closers.push(async()=>{await worker.close();store.close();});
 const at='2026-01-01T09:00:00.000Z';
 store.saveShop({id:'s',name:'s',sellerId:'seller',platform:'tmall',enabled:true,sessionStatus:'valid',hasCookies:false,lastVerifiedAt:at,lastError:null,createdAt:at,updatedAt:at});
 const task:CollectionTask={id:'c',shopId:'s',name:'c',enabled:true,scope:'all',productIds:[],schedule:{kind:'daily',time:'09:00',days:[],timezone:'UTC'},version:1,createdAt:at,updatedAt:at,nextRunAt:null};store.saveTask(task);
 const alert:AlertTask={id:'a',collectionTaskId:'c',shopId:'s',name:'a',enabled:true,scope:'all',productIds:[],rules:[{mode:'all',conditions:[{field:'after',op:'lt',value:'80'}]}],whitelist:{productIds:[],titleKeywords:[]},notify:true,notificationPolicy:{cooldownHours:24,notifyRecovery:true},version:1,createdAt:at,updatedAt:at};store.saveAlertTask(alert);
 function create(id:string){
  const at=new Date().toISOString();
  const run:RunRecord={id,taskId:'c',shopId:'s',shopName:'s',taskName:'c',status:'running',scope:'all',productIds:[],expected:1,processed:0,failed:0,rows:0,checked:0,excluded:0,matched:0,unknown:0,message:'',createdAt:at,startedAt:at,finishedAt:null,parentRunId:null,failedProductIds:[],notificationStatus:'disabled',trigger:'scheduled',alertDispatchStatus:'pending',taskSnapshot:task,alertTaskSnapshots:[alert]};
  store.saveRun(run);
  return run;
 }
 function complete(run:RunRecord,after:string) {
  const at=new Date().toISOString();
  store.saveRun({...run,status:'running'});
  store.saveProduct(run.id,{productId:'1000001',title:'p',skuSetComplete:true,rows:[{
    shopId:'s',productId:'1000001',skuId:'2000001',title:'p',specs:'',seatSpec:'',color:'',
    backendPrice:'100',before:'100',after,backendVerified:true,status:'ok',sourceUrl:'',
    backendSource:'test',backendFetchedAt:at,detailFetchedAt:at,stock:1,
  }]});
  store.saveRun({...run,status:'success',expected:1,processed:1,rows:1,finishedAt:at});
 }
 async function finish(run:RunRecord,after:string) {
  complete(run,after);
  worker.enqueueForCollection(run.id);
  await worker.whenIdle();
  return store.getAlertRun(run.id+':a')!;
 }
 return {store,worker,vault,create,complete,finish,incidents:()=>listIncidents(store,{status:'all',page:1,pageSize:100}).incidents};
}
it('uses a fresh SKU collected when an older scheduled batch is resumed',async()=>{
 vi.useFakeTimers({toFake:['Date']});vi.setSystemTime('2026-01-01T10:00:00Z');const f=setup();
 const old=f.create('old');f.store.saveRun({...old,status:'stopped'});
 vi.setSystemTime('2026-01-01T11:00:00Z');const newer=f.create('new');await f.finish(newer,'70');
 vi.setSystemTime('2026-01-01T12:00:00Z');const resumed=await f.finish(old,'50');
 expect(resumed.lifecycle?.worsened).toBe(1);
 expect(resumed.notificationCount).toBe(1);
});
it('does not spend the reminder cooldown on a globally disabled delivery',async()=>{
 vi.useFakeTimers({toFake:['Date']});vi.setSystemTime('2026-01-01T10:00:00Z');const f=setup();
 f.store.setConfig('notification.key',f.vault.seal('SCTfixture'));
 const first=await f.finish(f.create('one'),'70');await notifyAlertRun(f.store,f.vault,first);
 expect(f.store.getAlertRun(first.id)?.notificationStatus).toBe('disabled');
 f.store.setConfig('notification.enabled',true);
 const fetch=vi.fn(async()=>Response.json({code:0}));vi.stubGlobal('fetch',fetch);
 vi.setSystemTime('2026-01-01T11:00:00Z');const next=await f.finish(f.create('two'),'70');await notifyAlertRun(f.store,f.vault,next);
 expect(next.notificationCount).toBe(1);
 expect(fetch).toHaveBeenCalledTimes(1);
});

it('keeps equal-timestamp ordering after the newer clean source expires',async()=>{
 vi.useFakeTimers({toFake:['Date']});vi.setSystemTime('2020-01-01T10:00:00Z');const f=setup();
 const old=f.create('old');f.complete(old,'70');
 const newer=f.create('new');await f.finish(newer,'95');
 vi.setSystemTime('2026-01-01T12:00:00Z');const current=f.create('current');
 f.store.saveProduct(current.id,{productId:'1000001',title:'p',rows:[{...f.store.getRunPrices('new')[0]!,detailFetchedAt:new Date().toISOString(),backendFetchedAt:new Date().toISOString()}]});
 const removed=cleanupRetention(f.store,{historyBefore:'2025-01-01T00:00:00.000Z',alertBefore:'2024-01-01T00:00:00.000Z'});
 expect(removed.runs).toBe(1);expect(f.store.getRun('new')).toBeUndefined();
 f.worker.enqueueForCollection('old');await f.worker.whenIdle();const result=f.store.getAlertRun('old:a')!;
 expect(result.notificationCount).toBe(0);
 expect(f.incidents().filter(i=>i.status==='active')).toHaveLength(0);
});

it('honors the original timestamp of a successful SKU already collected before the scheduled batch stopped',async()=>{
 vi.useFakeTimers({toFake:['Date']});
 vi.setSystemTime('2026-01-01T10:00:00Z');
 const f=setup(),old=f.create('stopped');
 const at=new Date().toISOString();
 f.store.saveProduct(old.id,{productId:'1000001',title:'p',rows:[{
   shopId:'s',productId:'1000001',skuId:'2000001',title:'p',specs:'',seatSpec:'',color:'',
   backendPrice:'100',before:'100',after:'50',backendVerified:true,status:'ok',sourceUrl:'',backendSource:'test',
   backendFetchedAt:at,detailFetchedAt:at,stock:1,
 }]});
 f.store.saveRun({...old,status:'stopped'});
 vi.setSystemTime('2026-01-01T11:00:00Z');await f.finish(f.create('newer'),'70');
 vi.setSystemTime('2026-01-01T12:00:00Z');
 const resumed=await f.finish(old,'50');
 expect(f.store.getRunPrices(old.id)[0].updatedAt).toBe(at);
 expect(resumed.notificationCount).toBe(0);
 expect(f.incidents()[0].lastCollectionRunId).toBe('newer');
});

it('releases a definitely unconfigured delivery and keeps its original frozen candidates available for explicit retry',async()=>{
 vi.useFakeTimers({toFake:['Date']});vi.setSystemTime('2026-01-01T10:00:00Z');
 const f=setup();f.store.setConfig('notification.enabled',true);
 const first=await f.finish(f.create('unconfigured'),'70');
 await notifyAlertRun(f.store,f.vault,first);
 expect(f.store.getAlertRun(first.id)).toMatchObject({notificationStatus:'not_configured',notificationCandidateIds:first.notificationCandidateIds});
 f.store.setConfig('notification.key',f.vault.seal('SCTfixture'));
 const send=vi.fn(async()=>Response.json({code:0}));vi.stubGlobal('fetch',send);
 vi.setSystemTime('2026-01-01T11:00:00Z');
 const next=await f.finish(f.create('configured'),'70');
 expect(next.notificationCount).toBe(1);
 await notifyAlertRun(f.store,f.vault,first,true);
 expect(f.store.getAlertRun(first.id)).toMatchObject({notificationStatus:'accepted',notificationCandidateIds:first.notificationCandidateIds});
 expect(send).toHaveBeenCalledTimes(1);
});

it('releases only the disabled owner, preserving later pending and earlier accepted reservations',async()=>{
 vi.useFakeTimers({toFake:['Date']});vi.setSystemTime('2026-01-01T10:00:00Z');
 const f=setup();f.store.setConfig('notification.enabled',true);f.store.setConfig('notification.key',f.vault.seal('SCTfixture'));
 const send=vi.fn(async()=>Response.json({code:0}));vi.stubGlobal('fetch',send);
 const first=await f.finish(f.create('one'),'70');
 vi.setSystemTime('2026-01-01T11:00:00Z');
 const worse=await f.finish(f.create('two'),'60');
 expect([first.notificationCount,worse.notificationCount]).toEqual([1,1]);
 f.store.setConfig('notification.enabled',false);
 await notifyAlertRun(f.store,f.vault,first);
 f.store.setConfig('notification.enabled',true);
 expect((await f.finish(f.create('three'),'60')).notificationCount).toBe(0);
 await notifyAlertRun(f.store,f.vault,worse);
 const later=await f.finish(f.create('four'),'50');
 f.store.setConfig('notification.enabled',false);
 await notifyAlertRun(f.store,f.vault,later);
 f.store.setConfig('notification.enabled',true);
 expect((await f.finish(f.create('five'),'50')).notificationCount).toBe(0);
 expect(send).toHaveBeenCalledTimes(1);
 vi.setSystemTime('2026-01-02T11:00:00Z');
 expect((await f.finish(f.create('six'),'50')).notificationCount).toBe(1);
});

it('keeps in-flight and uncertain submissions reserved when an explicit retry sees a disabled channel',async()=>{
 vi.useFakeTimers({toFake:['Date']});vi.setSystemTime('2026-01-01T10:00:00Z');
 const f=setup();f.store.setConfig('notification.enabled',true);f.store.setConfig('notification.key',f.vault.seal('SCTfixture'));
 let fail!:(error:Error)=>void;
 vi.stubGlobal('fetch',vi.fn(()=>new Promise<Response>((_resolve,reject)=>{fail=reject;})));
 const first=await f.finish(f.create('one'),'70'),sending=notifyAlertRun(f.store,f.vault,first);
 expect(f.store.getAlertRun(first.id)?.notificationStatus).toBe('sending');
 f.store.setConfig('notification.enabled',false);
 await expect(notifyAlertRun(f.store,f.vault,first,true)).rejects.toMatchObject({statusCode:409});
 expect((await f.finish(f.create('two'),'70')).notificationCount).toBe(0);
 fail(Error('transport result unknown'));await sending;
 await expect(notifyAlertRun(f.store,f.vault,first,true)).rejects.toMatchObject({statusCode:400});
 expect(f.store.getAlertRun(first.id)?.notificationStatus).toBe('failed');
 f.store.setConfig('notification.enabled',true);
 expect((await f.finish(f.create('three'),'70')).notificationCount).toBe(0);
});

it('upgrades v1 watermark and reservation data from retained frozen evidence without replaying reports',async()=>{
 vi.useFakeTimers({toFake:['Date']});vi.setSystemTime('2026-01-01T10:00:00Z');
 const f=setup(),first=f.create('v1');
 vi.setSystemTime('2026-01-01T12:00:00Z');
 const run=await f.finish(first,'70');await notifyAlertRun(f.store,f.vault,run);
 const prior=f.store.getAlertRun(run.id);
 f.store.db.exec(`DROP TRIGGER incident_source_sequence_insert; DROP TRIGGER incident_retained_cooldown; DROP TABLE incident_source_sequence;
   DROP TABLE incident_notification_reservations; ALTER TABLE alert_observation_order DROP COLUMN source_sequence;
   UPDATE alert_observation_order SET source_at='2026-01-01T10:00:00.000Z';
   UPDATE alert_incidents SET payload=json_set(payload,'$.lastReservedAt','2026-01-01T12:00:00.000Z');
   UPDATE config SET payload='1' WHERE key='schema.incidents'`);
 initializeIncidents(f.store.db);
 const watermark=f.store.db.prepare('SELECT source_at,source_sequence FROM alert_observation_order').get();
 expect(watermark).toMatchObject({source_at:'2026-01-01T12:00:00.000Z',source_sequence:1});
 expect(f.store.getAlertRun(run.id)).toEqual(prior);
 f.store.setConfig('notification.enabled',true);f.store.setConfig('notification.key',f.vault.seal('SCTfixture'));
 vi.setSystemTime('2026-01-01T13:00:00Z');
 expect((await f.finish(f.create('next'),'70')).notificationCount).toBe(1);
});

it('cascades expired report owners while retaining the effective cooldown of a submitted historical reminder',async()=>{
 vi.useFakeTimers({toFake:['Date']});vi.setSystemTime('2026-01-01T10:00:00Z');
 const f=setup();f.store.setConfig('notification.enabled',true);f.store.setConfig('notification.key',f.vault.seal('SCTfixture'));
 vi.stubGlobal('fetch',vi.fn(async()=>Response.json({code:0})));
 const first=await f.finish(f.create('first'),'70');await notifyAlertRun(f.store,f.vault,first);
 vi.setSystemTime('2026-01-01T11:00:00Z');
 const worse=await f.finish(f.create('worse'),'50');await notifyAlertRun(f.store,f.vault,worse);
 vi.setSystemTime('2026-01-01T12:00:00Z');await f.finish(f.create('latest'),'50');
 f.store.db.exec("DELETE FROM alerts WHERE run_id='worse'; DELETE FROM alert_runs WHERE collection_run_id='worse'; DELETE FROM prices WHERE run_id='worse'; DELETE FROM runs WHERE id='worse'");
 expect(f.store.db.prepare('SELECT 1 FROM incident_notification_reservations WHERE run_id=?').get(worse.id)).toBeUndefined();
 expect(f.store.db.prepare('SELECT 1 FROM incident_source_sequence WHERE run_id=?').get('worse')).toBeUndefined();
 expect(f.store.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
 vi.setSystemTime('2026-01-02T10:30:00Z');expect((await f.finish(f.create('within'),'50')).notificationCount).toBe(0);
 vi.setSystemTime('2026-01-02T11:00:00Z');expect((await f.finish(f.create('due'),'50')).notificationCount).toBe(1);
});
