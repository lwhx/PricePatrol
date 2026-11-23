import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { AlertTask, CollectedRow, RuleGroup } from '../../shared/contracts.js';
import { Store, type RunRecord } from '../src/database.js';
import { AlertWorker } from '../src/alert-worker.js';
import { getIncident, listIncidents, ruleFingerprint, updateIncident } from '../src/incidents.js';
import { notifyAlertRun } from '../src/notifications.js';
import { Vault } from '../src/security.js';
import { buildApp } from '../src/app.js';

const epoch = '2025-01-01T00:00:00.000Z';
const key = 'incident-fixture-secret-for-local-sqlite';
const close: Array<() => void | Promise<void>> = [];
afterEach(async () => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); while (close.length) await close.pop()!(); });

function setup(path = ':memory:') {
  const store = new Store(path, key);
  const worker = new AlertWorker(store);
  close.push(async () => { await worker.close(); store.close(); });
  store.saveShop({ id:'s',name:'沙发店',sellerId:'seller',platform:'tmall',enabled:true,sessionStatus:'valid',lastVerifiedAt:epoch,lastError:null,createdAt:epoch,updatedAt:epoch,hasCookies:false });
  const collection = { id:'c',shopId:'s',name:'采集',enabled:true,scope:'all' as const,productIds:[],schedule:{kind:'daily' as const,time:'09:00',days:[],timezone:'Asia/Shanghai'},version:1,createdAt:epoch,updatedAt:epoch,nextRunAt:null };
  store.saveTask(collection);
  const task: AlertTask = { id:'a',collectionTaskId:'c',shopId:'s',name:'价格预警',enabled:true,scope:'all',productIds:[],rules:[{mode:'all',conditions:[{field:'after',op:'lt',value:'80'}]}],whitelist:{productIds:[],titleKeywords:[]},notify:true,version:1,createdAt:epoch,updatedAt:epoch };
  store.saveAlertTask(task);
  let serial = 0;
  function stage(rows: Partial<CollectedRow>[], frozen = store.getAlertTask(task.id)!, options: {at?: string; partial?: boolean; failed?: string[]} = {}) {
    const id = 'batch-' + (++serial);
    const at = options.at ?? new Date(Date.parse(epoch) + serial * 1000).toISOString();
    const source: RunRecord = { id,taskId:'c',shopId:'s',taskName:'采集',shopName:'沙发店',status:'running',scope:'all',productIds:[],expected:rows.length,processed:rows.length,failed:options.failed?.length??0,rows:rows.length,checked:0,excluded:0,matched:0,unknown:0,message:'fixture',createdAt:at,startedAt:at,finishedAt:null,parentRunId:null,failedProductIds:options.failed??[],notificationStatus:'disabled',trigger:'scheduled',alertDispatchStatus:'pending',taskSnapshot:collection,alertTaskSnapshots:[structuredClone(frozen)] };
    store.saveRun(source);
    for (const [i, patch] of rows.entries()) {
      const row: CollectedRow = {shopId:'s',productId:String(1000000+i),skuId:'sku',title:'产品'+i,specs:'规格',seatSpec:'',color:'',backendPrice:'100',before:'100',after:'70',backendVerified:true,status:'ok',sourceUrl:'',backendSource:'fixture',detailFetchedAt:at,backendFetchedAt:at,stock:1,...patch};
      store.saveProduct(id,{productId:row.productId,title:row.title,rows:[row]});
    }
    store.saveRun({...source,status:options.partial?'partial':'success',finishedAt:at});
    return id;
  }
  async function evaluate(id: string) {
    worker.enqueueForCollection(id);
    await worker.whenIdle();
    const run = store.getAlertRun(id+':a')!;
    expect(run.status).toMatch(/^(success|partial)$/);
    return run;
  }
  const batch = async (rows: Partial<CollectedRow>[], frozen?: AlertTask, options?: Parameters<typeof stage>[2]) => evaluate(stage(rows, frozen, options));
  const incidents = () => listIncidents(store, { status:'all',page:1,pageSize:100 }).incidents;
  return { store, task, stage, evaluate, batch, incidents, worker };
}

it('keeps one work item across continuing, worsening and cooldown reminders and freezes a recovery-only message', async () => {
  vi.useFakeTimers({toFake:['Date']});
  vi.setSystemTime(epoch);
  const f = setup();
  f.store.saveAlertTask({...f.task,notificationPolicy:{cooldownHours:24,notifyRecovery:true}});
  const initial = await f.batch([{}]);
  expect(initial.lifecycle).toEqual({first:1,continuing:0,worsened:0,recovered:0});
  const incident = f.incidents()[0];
  const record = f.store.getAlert(initial.notificationCandidateIds![0]);
  updateIncident(f.store,incident.id,{state:'confirmed',note:'已联系店铺'});
  f.store.saveAlertTask({...f.store.getAlertTask('a')!,name:'重命名',version:2,rules:[{mode:'any',conditions:[{field:'after',op:'lt',value:'80.00'}]}]});
  const again = await f.batch([{}]);
  expect(again).toMatchObject({matched:1,notificationCount:0,notificationStatus:'skipped',lifecycle:{continuing:1}});
  expect(f.incidents()).toHaveLength(1);
  expect(f.incidents()[0]).toMatchObject({id:incident.id,state:'confirmed',status:'active'});
  const worse = await f.batch([{after:'69.99'}]);
  expect(worse).toMatchObject({notificationCount:1,lifecycle:{worsened:1}});
  vi.setSystemTime(Date.parse(epoch)+24*3_600_000);
  expect(await f.batch([{after:'70'}])).toMatchObject({notificationCount:1,lifecycle:{continuing:1}});
  expect(f.incidents()).toHaveLength(1);
  updateIncident(f.store,incident.id,{state:'resolved'});
  expect(getIncident(f.store,incident.id)).toMatchObject({status:'active',state:'resolved'});
  const recovered = await f.batch([{after:'80'}]);
  expect(recovered).toMatchObject({matched:0,notificationCount:1,lifecycle:{recovered:1}});
  expect(f.store.getAlert(recovered.notificationCandidateIds![0])).toMatchObject({event:'recovered',after:'80.00',incidentId:incident.id});
  expect(getIncident(f.store,incident.id)).toMatchObject({status:'recovered',state:'resolved'});
  expect(f.store.getAlert(initial.notificationCandidateIds![0])).toEqual(record);
  const reopened = await f.batch([{after:'75'}]);
  expect(reopened.lifecycle?.first).toBe(1);
  expect(f.incidents()).toHaveLength(2);
  const fresh = f.incidents().find(item=>item.status==='active')!;
  expect(fresh).toMatchObject({identity:incident.identity,state:'pending',note:''});
  expect(fresh.id).not.toBe(incident.id);
});

it('protects active anomalies from unknown, absent, excluded, stale and product-incomplete false observations', async () => {
  const f = setup();
  await f.batch([{}]);
  const active = f.incidents()[0];
  for (const result of [
    await f.batch([{after:null}]), await f.batch([]),
    await f.batch([{after:'90'}],{...f.task,whitelist:{productIds:['1000000'],titleKeywords:[]}}),
    await f.batch([{after:'90',status:'stale'}]),
    await f.batch([{after:'90'}],f.task,{partial:true,failed:['1000000']}),
  ]) expect(result.lifecycle?.recovered).toBe(0);
  expect(getIncident(f.store,active.id)).toEqual(active);
  // A fully observed SKU can recover in a partial batch when only a different product failed.
  expect(await f.batch([{after:'90'}],f.task,{partial:true,failed:['2000000']}))
    .toMatchObject({matched:0,notificationCount:0,notificationStatus:'skipped',lifecycle:{recovered:1}});
});

it('uses exact ratio deterioration and oriented greater-than metrics, with no worsening for textual or equality predicates', async () => {
  const f = setup();
  const change = (rules:RuleGroup[]) => f.store.saveAlertTask({...f.task,rules,version:(f.store.getAlertTask('a')?.version??0)+1});
  change([{mode:'all',conditions:[{field:'discount',op:'lt',value:'9'}]}]);
  const first = await f.batch([{after:'70000.00',backendPrice:'100000.00'}]);
  const worse = await f.batch([{after:'69999.99',backendPrice:'100000.00'}]);
  expect(f.store.getAlert(first.notificationCandidateIds![0])?.discount).toBe(f.store.getAlert(worse.notificationCandidateIds![0])?.discount);
  expect(worse.lifecycle?.worsened).toBe(1);
  change([{mode:'all',conditions:[{field:'after',op:'gte',value:'90'}]}]);
  await f.batch([{after:'90071992547409.90'}]);
  expect((await f.batch([{after:'90071992547409.91'}])).lifecycle?.worsened).toBe(1);
  change([{mode:'any',conditions:[{field:'title',op:'contains',value:'品'},{field:'after',op:'eq',value:'15'}]}]);
  await f.batch([{after:'15'}]);
  expect((await f.batch([{after:'1'}])).lifecycle?.continuing).toBe(1);
});

it.each(['edit','delete'])('completes a queued frozen eligible notification after task %s and keeps the obsolete episode superseded', async action => {
  const f = setup();
  const source = f.stage([{}]);
  if(action==='delete') f.store.deleteAlertTask('a');
  else f.store.saveAlertTask({...f.task,notify:false,version:2,rules:[{mode:'all',conditions:[{field:'after',op:'lt',value:'1'}]}]});
  const result = await f.evaluate(source);
  expect(result).toMatchObject({matched:1,notificationStatus:'pending',notificationCount:1,lifecycle:{first:1}});
  expect(f.incidents()[0].status).toBe('superseded');
  const later = f.stage([{}],f.task);
  expect(await f.evaluate(later)).toMatchObject({matched:1,notificationCount:0,lifecycle:{continuing:1}});
  expect(f.incidents()).toHaveLength(1);
  if(action==='edit'){
    expect(await f.batch([{after:'0.80'}])).toMatchObject({matched:1,notificationCount:0,lifecycle:{first:1}});
    expect(f.incidents().filter(incident=>incident.status==='active')).toHaveLength(1);
  }
});

it('archives old matches and never rewinds a newer recovery when an older frozen source completes late', async () => {
  const f = setup();
  await f.batch([{}]);
  const older = f.stage([{after:'50'}]);
  const latest = await f.batch([{after:'95'}]);
  const recovered = f.incidents()[0];
  expect(recovered).toMatchObject({status:'recovered',lastCollectionRunId:latest.collectionRunId});
  expect(await f.evaluate(older)).toMatchObject({matched:1,notificationCount:0});
  expect(f.incidents()).toEqual([recovered]);
});

it('rolls back evidence, notification reservations and incident state together if the evaluation cannot commit', async () => {
  const f = setup();
  const id = f.stage([{}]);
  const failure = vi.spyOn(f.store,'saveAlert').mockImplementationOnce(()=>{throw new Error('fixture write failure');});
  f.worker.enqueueForCollection(id);
  await f.worker.whenIdle();
  expect(f.store.getAlertRun(id+':a')).toMatchObject({status:'failed',notificationStatus:'skipped'});
  expect(f.incidents()).toEqual([]);
  expect(f.store.listAlerts({runId:id})).toEqual([]);
  failure.mockRestore();
  expect(await f.batch([{}])).toMatchObject({notificationCount:1,lifecycle:{first:1}});
});

it('delivers only the reserved records after restart, including recovery, and keeps an accepted batch idempotent', async () => {
  const dir = await mkdtemp(join(tmpdir(),'pricepatrol-incidents-'));
  close.push(()=>rm(dir,{recursive:true,force:true}));
  const db = join(dir,'price.sqlite'), f = setup(db);
  f.store.saveAlertTask({...f.task,notificationPolicy:{cooldownHours:24,notifyRecovery:true}});
  await f.batch([{title:'持续商品'},{title:'恢复商品'}]);
  const next = await f.batch([{title:'持续商品'},{after:'90',title:'恢复商品'},{title:'首次商品'}]);
  expect(next).toMatchObject({matched:2,notificationCount:2,lifecycle:{continuing:1,recovered:1,first:1}});
  const ids = next.notificationCandidateIds!;
  const vault = new Vault(key);
  f.store.setConfig('notification.enabled',true); f.store.setConfig('notification.key',vault.seal('SCTfixture'));
  await f.worker.close(); f.store.close();
  const reopened = new Store(db,key);
  close.push(()=>reopened.close());
  const transport = vi.fn(async (_url:string, _init:RequestInit)=>Response.json({code:0}));
  vi.stubGlobal('fetch',transport);
  await notifyAlertRun(reopened,vault,next);
  const text = String(new URLSearchParams(transport.mock.calls[0][1].body as URLSearchParams).get('desp'));
  expect(text).toContain('恢复商品'); expect(text).toContain('首次商品'); expect(text).not.toContain('持续商品');
  await notifyAlertRun(reopened,vault,next);
  expect(transport).toHaveBeenCalledTimes(1);
  expect(reopened.getAlertRun(next.id)).toMatchObject({notificationCandidateIds:ids,notificationStatus:'accepted'});
});

it('fingerprints logical order, set membership and numeric equivalents without dropping range endpoints', () => {
  const money = {field:'after',op:'lt',value:'70'} as const;
  const title = {field:'title',op:'in',value:'沙发,椅子'} as const;
  expect(ruleFingerprint([{mode:'all',conditions:[money,title]}])).toBe(ruleFingerprint([
    {mode:'any',conditions:[{...title,value:'椅子 沙发'}]}, {mode:'all',conditions:[{...money,value:'70.00'}]},
  ]));
  const between = {field:'discount',op:'between',value:'5',upper:'8'} as const;
  expect(ruleFingerprint([{mode:'all',conditions:[between]}])).not.toBe(ruleFingerprint([{mode:'all',conditions:[{...between,includeUpper:false}]}]));
});

it('keeps chronology per SKU so an absent or unknown SKU in a newer partial source cannot suppress an older valid match', async () => {
  const f = setup();
  const earlier = f.stage([{title:'稍早观测'}]);
  await f.batch([{productId:'1000002',title:'另一商品'}, {productId:'1000000',after:null}],f.task,{partial:true,failed:['1000000']});
  expect(await f.evaluate(earlier)).toMatchObject({notificationCount:1,lifecycle:{first:1}});
  expect(f.incidents().find(item=>item.productId==='1000000')?.status).toBe('active');
});

it('requires authentication for incident history, bounds pages and keeps operator decisions separate from immutable evidence', async () => {
  const f = setup();
  const dir = await mkdtemp(join(tmpdir(),'pricepatrol-incident-api-'));
  close.push(()=>rm(dir,{recursive:true,force:true}));
  const { app } = await buildApp({store:f.store,dataDir:dir,encryptionKey:key,serveStatic:false,collector:{
    verify:async()=>{throw Error('unused');},collect:async()=>{throw Error('unused');},
  }});
  close.push(()=>app.close());
  const first = await f.batch([{},{}]);
  const { id } = f.incidents()[0];
  expect((await app.inject({method:'GET',url:'/api/incidents'})).statusCode).toBe(401);
  const auth = await app.inject({method:'POST',url:'/api/auth/setup',payload:{password:'incident-test-password'}});
  expect(auth.statusCode).toBe(200);
  const cookie = auth.cookies.map(item=>item.name+'='+item.value).join('; ');
  const headers = {cookie};
  const listing = await app.inject({method:'GET',url:'/api/incidents?pageSize=1',headers});
  expect(listing.json()).toMatchObject({total:2,page:1,pageSize:1});
  expect(listing.json().incidents).toHaveLength(1);
  expect((await app.inject({method:'GET',url:'/api/incidents?pageSize=201',headers})).statusCode).toBe(400);
  expect((await app.inject({method:'PATCH',url:'/api/incidents/'+id,headers,payload:{state:'resolved',note:'已复核'}})).json().incident)
    .toMatchObject({id,status:'active',state:'resolved',note:'已复核'});
  expect((await app.inject({method:'GET',url:'/api/incidents/'+id,headers})).json().incident).toMatchObject({id,status:'active',state:'resolved'});
  expect(f.store.overview().pendingAlerts).toBe(1);
  expect(f.store.getAlert(first.notificationCandidateIds![0])?.state).toBe('pending');
});
