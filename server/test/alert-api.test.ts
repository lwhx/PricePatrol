import {afterEach, describe, expect, it, vi} from 'vitest';
import {Store, type AlertRunRecord, type RunRecord} from '../src/database.js';
import {buildApp} from '../src/app.js';
import type {AlertTask, CollectionTask, Collector, VerifiedAccount} from '../../shared/contracts.js';

const at = '2026-11-23T00:00:00.000Z';
const key = 'alert-api-test-encryption-key-64-characters';
const credentials: VerifiedAccount = {sellerId:'seller',shopName:'测试店',platform:'tmall',cookies:[],userAgent:'fixture',appKey:'fixture'};
const collector: Collector = {verify:async()=>credentials,collect:async()=>({cookies:[],expected:0,processed:0,failedProductIds:[],coverageComplete:true})};
const closes: (()=>Promise<void>)[] = [];
afterEach(async()=>{for(const close of closes.splice(0))await close();vi.restoreAllMocks();vi.unstubAllGlobals();});

function collection(id:string,shopId='s'):CollectionTask {
  return {id,shopId,name:'每日采集',enabled:true,scope:'all',productIds:[],schedule:{kind:'daily',time:'09:00',days:[],timezone:'Asia/Shanghai'},version:1,createdAt:at,updatedAt:at,nextRunAt:null};
}
function input(patch:Record<string,unknown>={}) {
  return {collectionTaskId:'c',name:'低于八五折',enabled:true,scope:'all',productIds:[],rules:[{mode:'all',conditions:[{field:'discount',op:'lt',value:'8.5'}]}],whitelist:{productIds:[],titleKeywords:[]},notify:false,...patch};
}
async function setup() {
  const store = new Store(':memory:',key);
  for(const id of ['s','s2'])store.saveShop({id,name:id==='s'?'测试店':'另一店',sellerId:'seller',platform:'tmall',enabled:true,sessionStatus:'valid',lastVerifiedAt:at,lastError:null,createdAt:at,updatedAt:at,hasCookies:true},credentials);
  store.saveTask(collection('c'));store.saveTask(collection('c2'));store.saveTask(collection('other','s2'));
  const ctx=await buildApp({store,collector,dataDir:'/tmp/pricepatrol-alert-api-tests',encryptionKey:key,serveStatic:false});
  closes.push(async()=>{await ctx.app.close();store.close();});
  const auth=await ctx.app.inject({method:'POST',url:'/api/auth/setup',payload:{password:'fixture-long-password'}});
  expect(auth.statusCode).toBe(200);
  const headers={cookie:auth.cookies.map(cookie=>`${cookie.name}=${cookie.value}`).join('; ')};
  const create=async(patch:Record<string,unknown>={})=>ctx.app.inject({method:'POST',url:'/api/alert-tasks',headers,payload:input(patch)});
  return {...ctx,store,headers,create};
}

function saveSource(store:Store,id:string,taskId:string,products:{id:string;title:string}[]=[],tasks:AlertTask[]=[],trigger:'manual'|'scheduled'='scheduled'):RunRecord {
  const task=store.getTask(taskId)!;
  const run:RunRecord={id,taskId,shopId:task.shopId,shopName:'测试店',taskName:task.name,status:'running',scope:'all',productIds:[],expected:products.length,processed:0,failed:0,rows:0,checked:0,excluded:0,matched:0,unknown:0,message:'采集中',createdAt:at,startedAt:at,finishedAt:null,parentRunId:null,failedProductIds:[],notificationStatus:'disabled',trigger,alertDispatchStatus:trigger==='scheduled'?'dispatched':'not_applicable',taskSnapshot:task,alertTaskSnapshots:tasks};
  store.saveRun(run);
  for(const product of products)store.saveProduct(id,{productId:product.id,title:product.title,rows:[{shopId:task.shopId,productId:product.id,skuId:'2'+product.id,title:product.title,specs:'三人位',seatSpec:'三人位',color:'白色',backendPrice:'100.00',before:'100.00',after:'95.00',backendVerified:true,status:'ok',sourceUrl:'',backendSource:'fixture',detailFetchedAt:at,backendFetchedAt:at,stock:1}]});
  store.saveRun({...store.getRun(id)!,status:'success',processed:products.length,rows:products.length,message:'采集完成',finishedAt:at});
  return store.getRun(id)!;
}

function saveAlertExecution(store:Store,id:string,task:AlertTask,source:RunRecord,patch:Partial<AlertRunRecord>={}):AlertRunRecord {
  const run:AlertRunRecord={id,alertTaskId:task.id,collectionRunId:source.id,shopId:source.shopId,shopName:source.shopName,taskName:task.name,status:'success',rows:source.rows,checked:source.rows,excluded:0,matched:1,unknown:0,message:'预警检查完成',ruleVersion:task.version,createdAt:at,startedAt:at,finishedAt:at,notificationStatus:'pending',taskSnapshot:structuredClone(task),...patch};
  store.saveAlertRun(run);return store.getAlertRun(id)!;
}

describe('独立预警任务 API',()=>{
  it('requires authentication and supports independent create/read/update/duplicate/delete',async()=>{
    const {app,store,headers,create}=await setup();
    expect((await app.inject('/api/alert-tasks')).statusCode).toBe(401);
    const created=await create();expect(created.statusCode).toBe(200);
    const task=created.json().task as AlertTask;
    expect(task).toMatchObject({collectionTaskId:'c',shopId:'s',version:1,enabled:true});
    expect(task).not.toHaveProperty('schedule');
    expect(store.getTask('c')).toEqual(collection('c'));
    const sibling=await create({name:'另一套规则',notify:true});expect(sibling.statusCode).toBe(200);
    expect(sibling.json().task.id).not.toBe(task.id);
    expect((await app.inject({url:'/api/alert-tasks',headers})).json().tasks).toHaveLength(2);
    expect((await app.inject({url:`/api/alert-tasks/${task.id}`,headers})).json().task).toEqual(task);
    const changed=await app.inject({method:'PATCH',url:`/api/alert-tasks/${task.id}`,headers,payload:{name:'更新规则',notify:true}});
    expect(changed.statusCode).toBe(200);
    expect(changed.json().task).toMatchObject({id:task.id,name:'更新规则',notify:true,version:2,createdAt:task.createdAt,collectionTaskId:'c',shopId:'s'});
    const duplicated=await app.inject({method:'POST',url:`/api/alert-tasks/${task.id}/duplicate`,headers});
    expect(duplicated.statusCode).toBe(200);
    expect(duplicated.json().task).toMatchObject({name:'更新规则 副本',enabled:false,version:1,collectionTaskId:'c',shopId:'s',notify:true});
    expect(duplicated.json().task.id).not.toBe(task.id);
    expect((await app.inject({method:'DELETE',url:`/api/alert-tasks/${task.id}`,headers})).json()).toEqual({ok:true});
    expect((await app.inject({url:`/api/alert-tasks/${task.id}`,headers})).statusCode).toBe(404);
    expect(store.listAlertTasks().map(task=>task.id)).not.toContain(task.id);
  });

  it('rejects missing/deleted collection bindings, cross-shop input and binding changes',async()=>{
    const {app,store,headers,create}=await setup();
    expect((await create({collectionTaskId:'missing'})).statusCode).toBe(404);
    expect((await create({shopId:'s2'})).statusCode).toBe(400);
    store.deleteTask('c2');
    expect((await create({collectionTaskId:'c2'})).statusCode).toBe(404);
    const created=await create();expect(created.statusCode).toBe(200);
    const task=created.json().task as AlertTask;
    for(const patch of [{collectionTaskId:'other'},{collectionTaskId:'c2'},{shopId:'s2'}]) {
      const response=await app.inject({method:'PATCH',url:`/api/alert-tasks/${task.id}`,headers,payload:patch});
      expect(response.statusCode).toBe(400);
    }
    expect(store.getAlertTask(task.id)).toEqual(task);
    store.deleteTask('c');
    expect((await app.inject({method:'PATCH',url:`/api/alert-tasks/${task.id}`,headers,payload:{enabled:true}})).statusCode).toBe(404);
    expect((await app.inject({method:'POST',url:`/api/alert-tasks/${task.id}/duplicate`,headers})).statusCode).toBe(404);
  });

  it.each([
    {name:''},
    {scope:'selected',productIds:[]},
    {productIds:['not-a-product-id']},
    {rules:[]},
    {rules:[{mode:'all',conditions:[{field:'discount',op:'contains',value:'8.5'}]}]},
    {whitelist:{productIds:[],titleKeywords:[' ']}},
    {notify:'true'},
  ])('validates alert configuration before saving: %j',async patch=>{
    const {create,store}=await setup();
    expect((await create(patch)).statusCode).toBe(400);
    expect(store.listAlertTasks()).toHaveLength(0);
  });

  it('merges whitelist additions atomically, deduplicates and preserves other configuration',async()=>{
    const {app,headers,store,create}=await setup();
    const created=await create({whitelist:{productIds:['1000001'],titleKeywords:['自由岛']}});
    expect(created.statusCode).toBe(200);
    const task=created.json().task as AlertTask;
    const merged=await app.inject({method:'POST',url:`/api/alert-tasks/${task.id}/whitelist`,headers,payload:{productIds:['1000001','1000002','1000002'],titleKeywords:['自由岛',' 新品 ']}});
    expect(merged.statusCode).toBe(200);
    expect(merged.json()).toMatchObject({added:2,existing:3,task:{version:2,whitelist:{productIds:['1000001','1000002'],titleKeywords:['自由岛','新品']},rules:task.rules}});
    const additions=await Promise.all(['1000003','1000004'].map(productId=>app.inject({method:'POST',url:`/api/alert-tasks/${task.id}/whitelist`,headers,payload:{productIds:[productId]}})));
    expect(additions.map(response=>response.statusCode)).toEqual([200,200]);
    const combined=store.getAlertTask(task.id)!;
    expect(combined).toMatchObject({version:4,whitelist:{titleKeywords:['自由岛','新品']}});
    expect(combined.whitelist.productIds.sort()).toEqual(['1000001','1000002','1000003','1000004']);
    const before=store.getAlertTask(task.id);
    expect((await app.inject({method:'POST',url:`/api/alert-tasks/${task.id}/whitelist`,headers,payload:{productIds:['bad-id']}})).statusCode).toBe(400);
    expect(store.getAlertTask(task.id)).toEqual(before);
  });

  it('rolls back an append that would exceed the combined whitelist limit',async()=>{
    const {app,headers,store,create}=await setup();
    const created=await create({whitelist:{productIds:[],titleKeywords:Array.from({length:1000},(_,index)=>`词${index}`)}});
    expect(created.statusCode).toBe(200);
    const task=created.json().task as AlertTask;
    expect((await app.inject({method:'POST',url:`/api/alert-tasks/${task.id}/whitelist`,headers,payload:{titleKeywords:['额外词']}})).statusCode).toBe(400);
    expect(store.getAlertTask(task.id)).toEqual(task);
  });

  it('previews all current matching products within the alert scope and shop without applying alert rules',async()=>{
    const {app,headers,store,create}=await setup();
    saveSource(store,'preview-source','c',[{id:'1000001',title:'新品沙发'},{id:'1000002',title:'新品边几'},{id:'1000003',title:'新品茶几'}],[],'manual');
    saveSource(store,'other-shop-source','other',[{id:'1000001',title:'新品另一店商品'}],[],'manual');
    const created=await create({scope:'selected',productIds:['1000001','1000002']});
    expect(created.statusCode).toBe(200);
    const task=created.json().task as AlertTask;
    const preview=await app.inject({method:'POST',url:`/api/alert-tasks/${task.id}/whitelist/preview`,headers,payload:{productIds:['1000003'],titleKeywords:['新品']}});
    expect(preview.statusCode).toBe(200);
    expect(preview.json().count).toBe(2);
    expect(preview.json().products.sort((left:{productId:string},right:{productId:string})=>left.productId.localeCompare(right.productId))).toEqual([{productId:'1000001',title:'新品沙发'},{productId:'1000002',title:'新品边几'}]);
    expect(store.getAlertTask(task.id)).toEqual(task);
    expect((await app.inject({method:'POST',url:`/api/alert-tasks/${task.id}/whitelist/preview`,headers,payload:{productIds:['invalid']}})).statusCode).toBe(400);
  });

  it.each([
    {scope:'all',productIds:[],expected:['1000001']},
    {scope:'selected',productIds:['1000001','1000002'],expected:['1000001']},
    {scope:'selected',productIds:['1000002'],expected:[]},
  ])('intersects whitelist preview with the bound collection scope: %j',async({scope,productIds,expected})=>{
    const {app,headers,store,create}=await setup();
    saveSource(store,'latest-from-another-task','c2',[{id:'1000001',title:'新品沙发'},{id:'1000002',title:'新品边几'}],[],'manual');
    saveSource(store,'latest-from-another-shop','other',[{id:'1000001',title:'新品另一店商品'}],[],'manual');
    store.saveTask({...store.getTask('c')!,scope:'selected',productIds:['1000001']});
    const created=await create({scope,productIds});expect(created.statusCode).toBe(200);
    const task=created.json().task as AlertTask;
    const preview=await app.inject({method:'POST',url:`/api/alert-tasks/${task.id}/whitelist/preview`,headers,payload:{productIds:['1000002'],titleKeywords:['新品']}});
    expect(preview.statusCode).toBe(200);
    expect(preview.json().count).toBe(expected.length);
    expect(preview.json().products).toEqual(expected.map(productId=>({productId,title:'新品沙发'})));
    expect(store.getAlertTask(task.id)).toEqual(task);
  });

  it('lists public alert executions with intersecting collection/task filters',async()=>{
    const {app,headers,store,create}=await setup();
    const first=(await create()).json().task as AlertTask;
    const second=(await create({name:'第二规则'})).json().task as AlertTask;
    const source1=saveSource(store,'collection-1','c',[],[first,second]);
    const source2=saveSource(store,'collection-2','c',[],[first]);
    saveAlertExecution(store,'alert-a1',first,source1);
    saveAlertExecution(store,'alert-b1',second,source1);
    saveAlertExecution(store,'alert-a2',first,source2);
    const all=await app.inject({url:'/api/alert-runs',headers});
    expect(all.statusCode).toBe(200);expect(all.json().runs).toHaveLength(3);
    expect(all.body).not.toContain('taskSnapshot');
    for(const [query,ids] of [[`collectionRunId=${source1.id}`,['alert-a1','alert-b1']],[`alertTaskId=${first.id}`,['alert-a1','alert-a2']],[`collectionRunId=${source1.id}&alertTaskId=${first.id}`,['alert-a1']]] as const) {
      const response=await app.inject({url:`/api/alert-runs?${query}`,headers});
      expect(response.statusCode).toBe(200);
      expect(response.json().runs.map((run:AlertRunRecord)=>run.id).sort()).toEqual([...ids].sort());
    }
    expect((await app.inject({url:'/api/alert-runs?alertTaskId=',headers})).statusCode).toBe(400);
    expect((await app.inject({url:'/api/alert-runs?alertTaskId=a&alertTaskId=b',headers})).statusCode).toBe(400);
  });

  it('notifies a selected alert execution once, and rejects the old collection notification endpoint',async()=>{
    const {app,headers,store,create}=await setup();
    const task=(await create({notify:true})).json().task as AlertTask;
    const sibling=(await create({name:'另一预警任务'})).json().task as AlertTask;
    const source=saveSource(store,'notify-source','c',[{id:'1000001',title:'本任务商品'}],[task,sibling]);
    const pending=saveAlertExecution(store,'notify-execution',task,source,{status:'running',finishedAt:null});
    store.saveAlert({id:'event',runId:source.id,taskId:task.id,alertRunId:pending.id,ruleVersion:task.version,shopId:'s',shopName:'测试店',productId:'1000001',skuId:'21000001',title:'本任务商品',specs:'三人位',backendPrice:'100.00',before:'100.00',after:'95.00',discount:'9.5',reasons:['测试规则'],state:'pending',note:'',createdAt:at});
    store.saveAlertRun({...pending,status:'success',finishedAt:at});const run=store.getAlertRun(pending.id)!;
    const siblingRun=saveAlertExecution(store,'sibling-execution',sibling,source,{status:'running',finishedAt:null});
    store.saveAlert({...store.getAlert('event')!,id:'sibling-event',taskId:sibling.id,alertRunId:siblingRun.id,ruleVersion:sibling.version});
    store.saveAlertRun({...siblingRun,status:'success',finishedAt:at});
    const byExecution=await app.inject({url:`/api/alerts?alertRunId=${run.id}`,headers});
    expect(byExecution.json().alerts.map((alert:{id:string})=>alert.id)).toEqual(['event']);
    expect((await app.inject({url:`/api/alerts?runId=${source.id}`,headers})).json().alerts).toHaveLength(2);
    const transport=vi.fn<typeof fetch>().mockImplementation(async()=>Response.json({code:0}));vi.stubGlobal('fetch',transport);
    expect((await app.inject({method:'PUT',url:'/api/settings',headers,payload:{sendKey:'SCTlocalTestOnly',notificationEnabled:true}})).statusCode).toBe(200);
    const old=await app.inject({method:'POST',url:`/api/runs/${source.id}/notify`,headers});
    expect(old.statusCode).toBe(400);expect(old.json().error).toContain('/api/alert-runs/');
    expect(transport).not.toHaveBeenCalled();
    const sent=await app.inject({method:'POST',url:`/api/alert-runs/${run.id}/notify`,headers});
    expect(sent.statusCode).toBe(200);expect(sent.json()).toEqual({accepted:true,notificationStatus:'accepted'});
    expect((await app.inject({method:'POST',url:`/api/alert-runs/${run.id}/notify`,headers})).statusCode).toBe(409);
    expect((await app.inject({method:'POST',url:'/api/alert-runs/missing/notify',headers})).statusCode).toBe(404);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(store.getRun(source.id)).toEqual(source);
  });
});
