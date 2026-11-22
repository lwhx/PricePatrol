import {afterEach, describe, expect, it, vi} from 'vitest';
import type {Alert, AlertTask, CollectionTask} from '../../shared/contracts.js';
import {Store, type AlertRunRecord, type RunRecord} from '../src/database.js';
import {Vault} from '../src/security.js';
import * as notifications from '../src/notifications.js';

const at='2026-11-23T00:00:00.000Z';
const key='alert-notifications-test-encryption-key-64-characters';
const stores:Store[]=[];
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();for(const store of stores.splice(0))store.close();});

function setup(options:{notify?:boolean;notificationStatus?:string;status?:AlertRunRecord['status'];sourceStatus?:'success'|'partial';noAlerts?:boolean}={}) {
  const store=new Store(':memory:',key);stores.push(store);
  const vault=new Vault(key);
  store.saveShop({id:'s',name:'测试店',sellerId:'seller',platform:'tmall',enabled:true,sessionStatus:'valid',lastVerifiedAt:at,lastError:null,createdAt:at,updatedAt:at,hasCookies:false});
  const collection:CollectionTask={id:'c',shopId:'s',name:'每日采集',enabled:true,scope:'all',productIds:[],schedule:{kind:'daily',time:'09:00',days:[],timezone:'Asia/Shanghai'},version:1,createdAt:at,updatedAt:at,nextRunAt:null};
  store.saveTask(collection);
  const task:AlertTask={id:'a',collectionTaskId:collection.id,shopId:'s',name:'八五折规则',enabled:true,scope:'all',productIds:[],rules:[{mode:'all',conditions:[{field:'discount',op:'lt',value:'8.5'}]}],whitelist:{productIds:[],titleKeywords:[]},notify:options.notify??true,version:3,createdAt:at,updatedAt:at};
  store.saveAlertTask(task);
  const source:RunRecord={id:'collection-run',taskId:collection.id,shopId:'s',shopName:'测试店',taskName:collection.name,status:options.sourceStatus??'success',trigger:'scheduled',alertDispatchStatus:'dispatched',scope:'all',productIds:[],expected:3,processed:2,failed:options.sourceStatus==='partial'?1:0,rows:2,checked:0,excluded:0,matched:0,unknown:0,message:'采集已完成',createdAt:at,startedAt:at,finishedAt:at,parentRunId:null,failedProductIds:options.sourceStatus==='partial'?['1000009']:[],notificationStatus:'disabled',taskSnapshot:collection,alertTaskSnapshots:[task]};
  store.saveRun(source);
  const status=options.status??'success';
  const run:AlertRunRecord={id:'alert-run',alertTaskId:task.id,collectionRunId:source.id,shopId:'s',shopName:'测试店',taskName:task.name,status,rows:2,checked:2,excluded:0,matched:options.noAlerts?0:1,unknown:1,message:'预警检查完成',ruleVersion:task.version,createdAt:at,startedAt:status==='queued'?null:at,finishedAt:['queued','running'].includes(status)?null:at,notificationStatus:options.notificationStatus??'pending',taskSnapshot:structuredClone(task)};
  store.saveAlertRun(run);
  const alerts:Alert[]=[{id:'own-event',runId:source.id,alertRunId:run.id,taskId:task.id,shopId:'s',shopName:'测试店',productId:'1000001',skuId:'2000001',title:'本任务商品',specs:'三人位',backendPrice:'100.00',before:'100.00',after:'70.00',discount:'7',reasons:['低于8.5折'],state:'pending',note:'',createdAt:at},{id:'other-event',runId:source.id,alertRunId:'another-alert-run',taskId:'another-task',shopId:'s',shopName:'测试店',productId:'1000002',skuId:'2000002',title:'另一任务独有商品',specs:'四人位',backendPrice:'100.00',before:'100.00',after:'60.00',discount:'6',reasons:['低于7折'],state:'pending',note:'',createdAt:at}];
  const listAlerts=vi.spyOn(store,'listAlerts').mockImplementation(filters=>options.noAlerts?[]:alerts.filter(alert=>!filters?.alertRunId||alert.alertRunId===filters.alertRunId));
  store.setConfig('notification.enabled',true);store.setConfig('notification.key',vault.seal('SCTlocalTestOnly'));
  const transport=vi.fn<typeof fetch>().mockImplementation(async()=>Response.json({code:0}));
  vi.stubGlobal('fetch',transport);
  return {store,vault,task,run,source:store.getRun(source.id)!,transport,listAlerts};
}

describe('独立预警汇总通知',()=>{
  it('sends only this alert execution and changes no collection report or price data',async()=>{
    const {store,vault,run,source,transport,listAlerts}=setup();
    const saveRun=vi.spyOn(store,'saveRun'),saveProduct=vi.spyOn(store,'saveProduct');
    await notifications.notifyAlertRun(store,vault,run);
    expect(listAlerts).toHaveBeenCalledWith({alertRunId:run.id});
    expect(transport).toHaveBeenCalledTimes(1);
    const fields=new URLSearchParams(transport.mock.calls[0]![1]!.body as URLSearchParams);
    expect(fields.get('desp')).toContain('本任务商品');
    expect(fields.get('desp')).not.toContain('另一任务独有商品');
    expect(fields.get('desp')).toContain(source.id);
    expect(fields.get('desp')).toContain(run.id);
    expect(store.getAlertRun(run.id)).toEqual({...run,notificationStatus:'accepted'});
    expect(store.getRun(source.id)).toEqual(source);
    expect(saveRun).not.toHaveBeenCalled();expect(saveProduct).not.toHaveBeenCalled();
  });

  it('uses the frozen notification choice even after the live task is enabled',async()=>{
    const {store,vault,run,task,transport}=setup({notify:false});
    store.saveAlertTask({...task,notify:true,version:task.version+1});
    await notifications.notifyAlertRun(store,vault,{...run,taskSnapshot:{...task,notify:true}});
    expect(store.getAlertRun(run.id)?.notificationStatus).toBe('disabled');
    await expect(notifications.notifyAlertRun(store,vault,run,true)).rejects.toMatchObject({statusCode:400});
    expect(transport).not.toHaveBeenCalled();
  });

  it('keeps the frozen enabled choice when the live task is later paused or deleted',async()=>{
    const {store,vault,run,task,transport}=setup();
    store.saveAlertTask({...task,notify:false,enabled:false,version:4});store.deleteAlertTask(task.id);
    await notifications.notifyAlertRun(store,vault,run);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(store.getAlertRun(run.id)?.notificationStatus).toBe('accepted');
  });

  it.each(['accepted','sending'])('keeps %s idempotent after the global setting and key are cleared',async notificationStatus=>{
    const {store,vault,run,transport}=setup({notificationStatus});
    store.setConfig('notification.enabled',false);store.setConfig('notification.key','');
    await notifications.notifyAlertRun(store,vault,run);
    expect(store.getAlertRun(run.id)?.notificationStatus).toBe(notificationStatus);
    await expect(notifications.notifyAlertRun(store,vault,run,true)).rejects.toMatchObject({statusCode:409});
    expect(store.getAlertRun(run.id)?.notificationStatus).toBe(notificationStatus);
    expect(transport).not.toHaveBeenCalled();
  });

  it.each(['manual','legacy',undefined] as const)('refuses a %s source even when explicitly retried',async trigger=>{
    const {store,vault,run,source,transport}=setup();
    vi.spyOn(store,'getRun').mockReturnValue({...source,trigger});
    await expect(notifications.notifyAlertRun(store,vault,run,true)).rejects.toMatchObject({statusCode:400});
    expect(store.getAlertRun(run.id)?.notificationStatus).toBe('pending');
    expect(transport).not.toHaveBeenCalled();
  });

  it.each(['queued','running','failed'] as const)('does not notify an alert execution with status %s',async status=>{
    const {store,vault,run,transport}=setup({status});
    await expect(notifications.notifyAlertRun(store,vault,run,true)).rejects.toMatchObject({statusCode:400});
    expect(transport).not.toHaveBeenCalled();
  });

  it('marks partial source coverage explicitly in the summary',async()=>{
    const {store,vault,run,transport}=setup({sourceStatus:'partial',status:'partial'});
    await notifications.notifyAlertRun(store,vault,run);
    const fields=new URLSearchParams(transport.mock.calls[0]![1]!.body as URLSearchParams);
    expect(fields.get('desp')).toContain('覆盖不完整');
    expect(fields.get('desp')).toContain('本批');
    expect(fields.get('desp')).toContain('无法判断');
  });

  it('skips empty results without posting a message',async()=>{
    const {store,vault,run,transport}=setup({noAlerts:true});
    await notifications.notifyAlertRun(store,vault,run,true);
    expect(store.getAlertRun(run.id)?.notificationStatus).toBe('skipped');
    expect(transport).not.toHaveBeenCalled();
  });

  it.each([
    {enabled:false,key:true,status:'disabled'},
    {enabled:true,key:false,status:'not_configured'},
  ])('reports missing channel configuration safely: %j',async config=>{
    const {store,vault,run,transport}=setup();
    store.setConfig('notification.enabled',config.enabled);if(!config.key)store.setConfig('notification.key','');
    await notifications.notifyAlertRun(store,vault,run);
    expect(store.getAlertRun(run.id)?.notificationStatus).toBe(config.status);
    await expect(notifications.notifyAlertRun(store,vault,run,true)).rejects.toMatchObject({statusCode:400});
    expect(transport).not.toHaveBeenCalled();
  });

  it('records a transport failure without altering collection results, and retries only on explicit force',async()=>{
    const {store,vault,run,source,transport}=setup();
    transport.mockRejectedValueOnce(new Error('SCTlocalTestOnly secret transport failure'));
    await notifications.notifyAlertRun(store,vault,run);
    expect(store.getAlertRun(run.id)?.notificationStatus).toBe('failed');
    expect(store.getRun(source.id)).toEqual(source);
    expect(store.getConfig('notification.error','')).not.toContain('SCTlocalTestOnly');
    await notifications.notifyAlertRun(store,vault,run);
    expect(transport).toHaveBeenCalledTimes(1);
    await notifications.notifyAlertRun(store,vault,run,true);
    expect(transport).toHaveBeenCalledTimes(2);
    expect(store.getAlertRun(run.id)?.notificationStatus).toBe('accepted');
    expect(store.getConfig('notification.error',null)).toBeNull();
  });

  it('rejects a concurrent retry while the first notification is in flight',async()=>{
    const {store,vault,run,transport}=setup();
    let complete!:(response:Response)=>void;
    transport.mockImplementationOnce(()=>new Promise(resolve=>{complete=resolve;}));
    const first=notifications.notifyAlertRun(store,vault,run,true);
    expect(store.getAlertRun(run.id)?.notificationStatus).toBe('sending');
    await expect(notifications.notifyAlertRun(store,vault,run,true)).rejects.toMatchObject({statusCode:409});
    complete(Response.json({code:0}));await first;
    expect(transport).toHaveBeenCalledTimes(1);
    expect(store.getAlertRun(run.id)?.notificationStatus).toBe('accepted');
  });
});
