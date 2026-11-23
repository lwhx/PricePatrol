import {afterEach, expect, it, vi} from 'vitest';
import {Store, type AlertRunRecord, type RunRecord} from '../src/database.js';
import {Worker} from '../src/worker.js';
import {AlertWorker} from '../src/alert-worker.js';
import {listIncidents} from '../src/incidents.js';
import type {AlertTask, Collector, CollectedRow, VerifiedAccount} from '../../shared/contracts.js';

const at = '2026-11-23T00:00:00.000Z';
const credentials: VerifiedAccount = {sellerId:'seller',shopName:'店铺',platform:'tmall',cookies:[],userAgent:'test',appKey:'test'};
const price = (productId='1000001', patch:Partial<CollectedRow>={}):CollectedRow => ({shopId:'s',productId,skuId:'2000001',title:'沙发',specs:'三人位',seatSpec:'三人位',color:'白',backendPrice:'100',before:'100',after:'70',backendVerified:true,status:'ok',sourceUrl:'',backendSource:'test',detailFetchedAt:at,backendFetchedAt:at,stock:1,...patch});
const result = {cookies:[],expected:1,processed:1,failedProductIds:[],coverageComplete:true};
const cleanup:(()=>Promise<void>)[]=[];
afterEach(async()=>{vi.restoreAllMocks(); for(const close of cleanup.splice(0))await close();});
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return {promise,resolve};}
function setup(collect?:Collector['collect'],notify?:(run:AlertRunRecord)=>Promise<void>,dispatch=true){
  const store=new Store(':memory:','test-collection-alert-worker-key-64-characters');
  store.saveShop({id:'s',name:'店铺',sellerId:'seller',platform:'tmall',enabled:true,sessionStatus:'valid',lastVerifiedAt:at,lastError:null,createdAt:at,updatedAt:at,hasCookies:true},credentials);
  store.saveTask({id:'c',shopId:'s',name:'每日采集',enabled:true,scope:'all',productIds:[],schedule:{kind:'daily',time:'09:00',days:[],timezone:'Asia/Shanghai'},version:1,createdAt:at,updatedAt:at,nextRunAt:null});
  const alert:AlertTask={id:'a',collectionTaskId:'c',shopId:'s',name:'折扣预警',enabled:true,scope:'all',productIds:[],rules:[{mode:'all',conditions:[{field:'discount',op:'lt',value:'8.5'}]}],whitelist:{productIds:[],titleKeywords:[]},notify:false,version:1,createdAt:at,updatedAt:at};
  store.saveAlertTask(alert);
  const alerts=new AlertWorker(store,notify);
  const worker=new Worker(store,{verify:async()=>credentials,collect:collect||(async options=>{await options.onProduct({productId:'1000001',title:'沙发',rows:[price()]});return result;})},dispatch?run=>alerts.enqueueForCollection(run.id):undefined);
  cleanup.push(async()=>{await worker.close();await alerts.close();store.close();});
  const idle=async()=>{await worker.whenIdle();await alerts.whenIdle();};
  return {store,worker,alerts,alert,idle};
}

it('scheduled completion dispatches multiple frozen alert tasks once and records independent evidence',async()=>{
  const {store,worker,alerts,alert,idle}=setup();
  store.saveAlertTask({...alert,id:'b',name:'第二条规则',version:3});
  store.saveAlertTask({...alert,id:'disabled',enabled:false});
  const source=worker.enqueue('s','c',undefined,true);
  store.saveAlertTask({...alert,version:2,rules:[{mode:'all',conditions:[{field:'discount',op:'lt',value:'6'}]}]});
  await idle(); alerts.enqueueForCollection(source.id); alerts.recover(); await alerts.whenIdle();
  expect(store.getRun(source.id)).toMatchObject({trigger:'scheduled',status:'success',matched:0,alertDispatchStatus:'dispatched'});
  expect(store.listAlertRuns()).toHaveLength(2);
  expect(store.listAlertRuns().map(r=>r.ruleVersion).sort()).toEqual([1,3]);
  expect(store.listAlertRuns().every(r=>r.status==='success'&&r.matched===1)).toBe(true);
  expect(store.listAlerts()).toHaveLength(2);
  expect(new Set(store.listAlerts().map(a=>a.alertRunId)).size).toBe(2);
  expect(store.listAlerts({alertRunId:store.listAlertRuns()[0]!.id})).toHaveLength(1);
});

it.each([false,true])('keeps queued manual and scheduled runs separate when scheduled-first=%s',async scheduledFirst=>{
  const notify=vi.fn(async()=>{});const {store,worker,alerts,alert,idle}=setup(undefined,notify);
  store.saveAlertTask({...alert,notify:true});
  const first=worker.enqueue('s','c',undefined,scheduledFirst);
  const second=worker.enqueue('s','c',undefined,!scheduledFirst);
  expect(first.id).not.toBe(second.id);
  expect(worker.enqueue('s','c').id).toBe(scheduledFirst?second.id:first.id);
  expect(worker.enqueue('s','c',undefined,true).id).toBe(scheduledFirst?first.id:second.id);
  await idle();
  const manual=store.listRuns().find(r=>r.trigger==='manual')!;
  alerts.enqueueForCollection(manual.id);await alerts.whenIdle();
  expect(store.listAlertRuns()).toHaveLength(1);expect(notify).toHaveBeenCalledTimes(1);
  expect(store.listAlerts({runId:manual.id})).toEqual([]);
  expect(manual).toMatchObject({alertTaskSnapshots:[],alertDispatchStatus:'not_applicable',matched:0});
  expect(()=>store.saveRun({...manual,trigger:'scheduled'})).toThrow('来源');
});

it('manual retry of a partial scheduled batch updates prices without dispatching or changing the parent report',async()=>{
  let calls=0;
  const {store,worker,idle}=setup(async options=>{
    if(++calls===1){await options.onProduct({productId:'1000001',title:'沙发',rows:[price()]});await options.onProduct({productId:'1000002',title:'失败',rows:[],error:'失败'});return {...result,expected:2,processed:2,failedProductIds:['1000002'],coverageComplete:false};}
    expect(options.productIds).toEqual(['1000002']);await options.onProduct({productId:'1000002',title:'沙发',rows:[price('1000002')]});return result;
  });
  const source=worker.enqueue('s','c',undefined,true);await idle();
  const report=JSON.stringify(store.getRun(source.id));
  expect(store.listAlertRuns()[0]).toMatchObject({status:'partial',matched:1,unknown:1});
  const retry=worker.retry(source.id);await idle();
  expect(store.getRun(retry.id)).toMatchObject({trigger:'manual',status:'success',parentRunId:source.id,alertTaskSnapshots:[],alertDispatchStatus:'not_applicable'});
  expect(store.listAlertRuns()).toHaveLength(1);expect(store.listAlerts({runId:retry.id})).toHaveLength(0);
  expect(JSON.stringify(store.getRun(source.id))).toBe(report);
});

it('resuming a stopped scheduled batch upgrades failed evidence, retains provenance and dispatches only after completion',async()=>{
  const started=deferred();let calls=0;
  const {store,worker,idle}=setup(async options=>{
    if(++calls===1){await options.onProduct({productId:'1000001',title:'失败',rows:[price('1000001',{after:null,status:'partial',error:'失败'})],error:'失败'});started.resolve();await new Promise<void>(resolve=>options.signal.addEventListener('abort',()=>resolve(),{once:true}));return {...result,failedProductIds:['1000001'],coverageComplete:false};}
    expect(options.skipProductIds).toEqual([]);await options.onProduct({productId:'1000001',title:'沙发',rows:[price()]});return result;
  });
  const source=worker.enqueue('s','c',undefined,true);await started.promise;worker.stop(source.id);await idle();
  expect(store.listAlertRuns()).toHaveLength(0);expect(store.getRun(source.id)?.trigger).toBe('scheduled');
  worker.resume(source.id);await idle();
  expect(store.getRunPrices(source.id)).toHaveLength(1);expect(store.getRunPrices(source.id)[0]).toMatchObject({after:'70.00',status:'ok',stale:false});
  expect(store.listAlertRuns()[0]).toMatchObject({matched:1,unknown:0,status:'success'});
});

it('a fatal scheduled failure never evaluates even when it already collected a matching product',async()=>{
  const {store,worker,idle}=setup(async options=>{await options.onProduct({productId:'1000001',title:'沙发',rows:[price()]});throw Error('later request failed');});
  store.saveTask({...store.getTask('c')!,scope:'selected',productIds:['1000001','1000002']});
  const source=worker.enqueue('s','c',undefined,true);await idle();
  expect(store.getRun(source.id)).toMatchObject({status:'failed',processed:1,failed:1,failedProductIds:['1000002'],alertDispatchStatus:'skipped'});
  expect(store.listAlertRuns()).toEqual([]);expect(store.listAlerts()).toEqual([]);
});

it('waiting for login never dispatches and a later resume retains the scheduled trigger',async()=>{
  let calls=0;const {store,worker,idle}=setup(async options=>{
    if(++calls===1)throw Object.assign(Error('expired'),{code:'AUTH_REQUIRED'});
    await options.onProduct({productId:'1000001',title:'沙发',rows:[price()]});return result;
  });
  const source=worker.enqueue('s','c',undefined,true);await idle();
  expect(store.getRun(source.id)?.status).toBe('auth_required');expect(store.listAlertRuns()).toEqual([]);
  store.saveShop({...store.getShop('s')!,sessionStatus:'valid'},credentials);
  worker.resume(source.id);await idle();expect(store.listAlertRuns()[0]).toMatchObject({collectionRunId:source.id,matched:1});
});

it.each(['partial','backend_only','stale','error'] as const)('can alert on explicit %s status while unavailable or stale prices stay unknown',async status=>{
  const {store,worker,alert,idle}=setup(async options=>{
    await options.onProduct({productId:'1000001',title:'采集异常',rows:status==='error'?[]:[price('1000001',{status,after:status==='stale'?'70':null})],error:'采集未完整'});
    return {...result,failedProductIds:['1000001'],coverageComplete:false};
  });
  store.saveAlertTask({...alert,id:'status-alert',rules:[{mode:'all',conditions:[{field:'status',op:'eq',value:status}]}]});
  const source=worker.enqueue('s','c',undefined,true);await idle();
  expect(store.listAlertRuns().find(run=>run.alertTaskId==='a')).toMatchObject({status:'partial',matched:0,unknown:1});
  expect(store.listAlertRuns().find(run=>run.alertTaskId==='status-alert')).toMatchObject({status:'partial',matched:1,unknown:0});
  expect(store.listAlerts({runId:source.id})).toHaveLength(1);
});

it('recovery finds an old pending dispatch beyond the 200-row UI window and evaluates its batch instead of latest prices',async()=>{
  const {store,worker,alerts,idle}=setup(undefined,undefined,false);
  const source=worker.enqueue('s','c',undefined,true);await worker.whenIdle();
  // New manual prices must neither replace the scheduled evidence nor hide its recovery work.
  for(let i=0;i<205;i++){
    const newer:RunRecord={...store.getRun(source.id)!,id:`newer-${i}`,trigger:'manual',alertDispatchStatus:'not_applicable',alertTaskSnapshots:[],status:'running',finishedAt:null,createdAt:'2026-12-01T00:00:00.000Z'};
    store.saveRun(newer);
    if(i===0)store.saveProduct(newer.id,{productId:'1000001',title:'沙发',rows:[price('1000001',{after:'99'})]});
    store.saveRun({...newer,status:'success',finishedAt:'2026-12-01T00:01:00.000Z'});
  }
  expect(store.listRuns().some(r=>r.id===source.id)).toBe(false);
  store.cleanup('2027-01-01T00:00:00.000Z');expect(store.getRunPrices(source.id)).toHaveLength(1);
  alerts.recover();await idle();
  expect(store.listAlertRuns()[0]).toMatchObject({matched:1,collectionRunId:source.id});
  expect(store.listAlerts()[0]?.after).toBe('70.00');
  store.cleanup('2027-01-01T00:00:00.000Z');expect(store.getRunPrices(source.id)).toHaveLength(1);
});

it('protects zero-match evaluation evidence from cleanup and leaves collection success intact when an alert task fails',async()=>{
  const {store,worker,alerts,alert,idle}=setup(undefined,undefined,false);
  store.saveAlertTask({...alert,id:'b',rules:[{mode:'all',conditions:[{field:'discount',op:'lt',value:'6'}]}]});
  const source=worker.enqueue('s','c',undefined,true);await worker.whenIdle();
  vi.spyOn(store,'saveAlert').mockImplementationOnce(()=>{throw Error('storage failure');});
  alerts.enqueueForCollection(source.id);await idle();
  expect(store.getRun(source.id)?.status).toBe('success');
  expect(store.listAlertRuns().find(r=>r.alertTaskId==='a')).toMatchObject({status:'failed'});
  expect(store.listAlertRuns().find(r=>r.alertTaskId==='b')).toMatchObject({status:'success',matched:0});
  store.cleanup('2027-01-01T00:00:00.000Z');expect(store.getRunPrices(source.id)).toHaveLength(1);
});

it('a slow alert notification does not block subsequent collection work',async()=>{
  const started=deferred(),release=deferred();
  const {store,worker,alerts,alert}=setup(undefined,async()=>{started.resolve();await release.promise;});
  store.saveAlertTask({...alert,notify:true});
  worker.enqueue('s','c',undefined,true);await started.promise;
  const manual=worker.enqueue('s','c');await worker.whenIdle();
  expect(store.getRun(manual.id)?.status).toBe('success');
  release.resolve();await alerts.whenIdle();
});

it('a slow first notification does not delay checking other alert tasks on the same batch',async()=>{
  const started=deferred(),release=deferred();
  const {store,worker,alerts,alert}=setup(undefined,async()=>{started.resolve();await release.promise;});
  store.saveAlertTask({...alert,notify:true});store.saveAlertTask({...alert,id:'b',notify:true});
  worker.enqueue('s','c',undefined,true);await started.promise;
  try {
    await vi.waitFor(()=>expect(store.listAlertRuns().filter(run=>run.status==='success')).toHaveLength(2));
    expect(store.listAlerts()).toHaveLength(2);
  } finally {release.resolve();await alerts.whenIdle();}
});

it('collection cannot overwrite credentials refreshed while its request was in flight',async()=>{
  const started=deferred(),release=deferred();
  const {store,worker,idle}=setup(async options=>{started.resolve();await release.promise;await options.onProduct({productId:'1000001',title:'沙发',rows:[price()]});return {...result,cookies:[{name:'session',value:'old'}]};});
  worker.enqueue('s','c');await started.promise;
  store.saveShop(store.getShop('s')!,{...credentials,cookies:[{name:'session',value:'new'}]});release.resolve();await idle();
  expect(store.getCredentials('s').cookies[0]?.value).toBe('new');
});

it('drains more than 200 queued collections without using the display limit',async()=>{
  let count=0;const {store,worker,idle}=setup(async()=>{count++;return {...result,expected:0,processed:0};});
  for(let i=0;i<205;i++)worker.enqueue('s');await idle();
  expect(count).toBe(205);expect(store.operationalRuns(['queued','running'])).toEqual([]);
});

it('recovers pending notification after committed evaluation but never automatically resends an uncertain sending delivery',async()=>{
  const notify=vi.fn(async(run:AlertRunRecord)=>{store.saveAlertRun({...run,notificationStatus:'accepted'});});
  const {store,worker,alerts,alert,idle}=setup(undefined,undefined);
  store.saveAlertTask({...alert,notify:true});worker.enqueue('s','c',undefined,true);await idle();
  const evaluation=store.listAlertRuns()[0]!;expect(evaluation.notificationStatus).toBe('pending');
  const recovered=new AlertWorker(store,notify);cleanup.unshift(async()=>recovered.close());
  recovered.recover();await recovered.whenIdle();expect(notify).toHaveBeenCalledTimes(1);
  store.saveAlertRun({...store.getAlertRun(evaluation.id)!,notificationStatus:'sending'});
  recovered.recover();await recovered.whenIdle();
  expect(store.getAlertRun(evaluation.id)?.notificationStatus).toBe('failed');expect(notify).toHaveBeenCalledTimes(1);
});

it.each(['missing', 'covered'])('checks resumed membership before recovering a %s product from a saved row', async membership => {
  const productId = '1000001';
  const saved = deferred();
  let attempt = 0;
  const { store, worker, idle, alert } = setup(async options => {
    attempt++;
    if (attempt === 3) {
      expect(options.skipProductIds).toEqual([productId]);
      const missing = membership === 'missing' ? productId : '1000002';
      return { ...result, processed:0, failedProductIds:[missing], coverageComplete:false };
    }
    const row = price(productId, { after:attempt === 1 ? '70' : '95' });
    await options.onProduct({ productId, title:row.title, rows:[row], skuSetComplete:true });
    if (attempt === 2) {
      saved.resolve();
      await new Promise<void>(resolve => options.signal.addEventListener('abort', () => resolve(), { once:true }));
    }
    return result;
  });
  store.saveAlertTask({ ...alert, notify:true, notificationPolicy:{ cooldownHours:24, notifyRecovery:true } });
  const first = worker.enqueue('s', 'c', undefined, true);
  await idle();
  expect(store.getAlertRun(first.id + ':a')).toMatchObject({ lifecycle:{ first:1 }, notificationCount:1 });
  const run = worker.enqueue('s', 'c', undefined, true);
  await saved.promise;
  worker.stop(run.id);
  await idle();
  const evidence = store.getRunPrices(run.id);
  worker.resume(run.id);
  await idle();
  expect(store.getRunPrices(run.id)).toEqual(evidence);
  const recovered = membership === 'covered';
  expect(store.getRun(run.id)).toMatchObject({ status:'partial', failed:1, failedProductIds:[recovered ? '1000002' : productId] });
  expect(store.getAlertRun(run.id + ':a')).toMatchObject({ lifecycle:{ recovered:Number(recovered) }, notificationCount:Number(recovered) });
  expect(listIncidents(store, { status:'all', page:1, pageSize:5 }).incidents[0]?.status).toBe(recovered ? 'recovered' : 'active');
});
