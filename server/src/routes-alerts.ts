import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {getIncident,listIncidents,updateIncident} from './incidents.js';
import type {AlertRun, AlertTask, ProductRow} from '../../shared/contracts.js';
import type {AlertRunRecord, Store} from './database.js';
import {alertTaskSchema, whitelistSchema} from './validation.js';
import {HttpError, requireValue, type ApiContext} from './api-context.js';

const objectInput=z.record(z.string(),z.unknown());

function checkBinding(store:Store,task:Pick<AlertTask,'collectionTaskId'|'shopId'>):void {
  const collection=requireValue(store.getTask(task.collectionTaskId),'关联的采集任务不存在或已删除');
  if(collection.shopId!==task.shopId)throw new HttpError(400,'预警任务与采集任务必须属于同一店铺');
}

function publicAlertRun(run:AlertRunRecord):AlertRun {
  const {taskSnapshot:_,...result}=run;
  return result;
}

export function registerAlertTasks(ctx:ApiContext):void {
  const {app,store}=ctx;
  const state=z.enum(['pending','confirmed','resolved']);
  app.get('/api/incidents',async request=>listIncidents(store,z.object({
    status:z.enum(['all','active','recovered','superseded']).default('active'),state:state.optional(),
    shopId:z.string().min(1).max(100).optional(),alertTaskId:z.string().min(1).max(100).optional(),
    page:z.coerce.number().int().min(1).max(1000000).default(1),pageSize:z.coerce.number().int().min(1).max(200).default(100),
  }).parse(request.query)));
  app.get<{Params:{id:string}}>('/api/incidents/:id',async request=>({incident:getIncident(store,request.params.id)}));
  app.patch<{Params:{id:string}}>('/api/incidents/:id',async request=>{
    const patch=z.strictObject({state:state.optional(),note:z.string().max(2000).optional()}).parse(request.body);
    return {incident:updateIncident(store,request.params.id,patch)};
  });
  app.get('/api/alert-tasks',async()=>({tasks:store.listAlertTasks()}));
  app.get<{Params:{id:string}}>('/api/alert-tasks/:id',async request=>({task:requireValue(store.getAlertTask(request.params.id),'预警任务不存在')}));
  app.post('/api/alert-tasks',async request=>{
    const body=objectInput.parse(request.body),input=alertTaskSchema.parse(body);
    const collection=requireValue(store.getTask(input.collectionTaskId),'关联的采集任务不存在或已删除');
    if(body.shopId!==undefined&&body.shopId!==collection.shopId)throw new HttpError(400,'预警任务与采集任务必须属于同一店铺');
    const at=new Date().toISOString();
    const task:AlertTask={...input,id:randomUUID(),shopId:collection.shopId,version:1,createdAt:at,updatedAt:at};
    store.saveAlertTask(task);
    return {task};
  });
  app.patch<{Params:{id:string}}>('/api/alert-tasks/:id',async request=>{
    const prior=requireValue(store.getAlertTask(request.params.id),'预警任务不存在');
    const patch=objectInput.parse(request.body);
    if(patch.collectionTaskId!==undefined&&patch.collectionTaskId!==prior.collectionTaskId)throw new HttpError(400,'预警任务创建后不可更换关联的采集任务，请新建或复制任务');
    if(patch.shopId!==undefined&&patch.shopId!==prior.shopId)throw new HttpError(400,'预警任务所属店铺不可更改');
    const input=alertTaskSchema.parse({...prior,...patch});
    const task:AlertTask={...input,id:prior.id,shopId:prior.shopId,version:prior.version+1,createdAt:prior.createdAt,updatedAt:new Date().toISOString()};
    checkBinding(store,task);
    store.saveAlertTask(task);
    return {task};
  });
  app.delete<{Params:{id:string}}>('/api/alert-tasks/:id',async request=>{
    requireValue(store.getAlertTask(request.params.id),'预警任务不存在');
    store.deleteAlertTask(request.params.id);
    return {ok:true};
  });
  app.post<{Params:{id:string}}>('/api/alert-tasks/:id/duplicate',async request=>{
    const prior=requireValue(store.getAlertTask(request.params.id),'预警任务不存在');
    checkBinding(store,prior);
    const at=new Date().toISOString();
    const task:AlertTask={...structuredClone(prior),id:randomUUID(),name:prior.name.slice(0,97)+' 副本',enabled:false,version:1,createdAt:at,updatedAt:at};
    store.saveAlertTask(task);
    return {task};
  });
  app.post<{Params:{id:string}}>('/api/alert-tasks/:id/whitelist',async request=>{
    const input=whitelistSchema.parse(request.body===undefined?{}:request.body);
    return store.transaction(()=>{
      const prior=requireValue(store.getAlertTask(request.params.id),'预警任务不存在');
      checkBinding(store,prior);
      const ids=new Set(prior.whitelist.productIds),words=new Set(prior.whitelist.titleKeywords);
      let added=0,existing=0;
      for(const id of input.productIds){if(ids.has(id))existing++;else{ids.add(id);added++;}}
      for(const word of input.titleKeywords){if(words.has(word))existing++;else{words.add(word);added++;}}
      const whitelist=whitelistSchema.parse({productIds:[...ids],titleKeywords:[...words]});
      const task:AlertTask={...prior,whitelist,version:prior.version+1,updatedAt:new Date().toISOString()};
      store.saveAlertTask(task);
      return {task,added,existing};
    });
  });
  app.post<{Params:{id:string}}>('/api/alert-tasks/:id/whitelist/preview',async request=>{
    const task=requireValue(store.getAlertTask(request.params.id),'预警任务不存在');
    checkBinding(store,task);
    const list=whitelistSchema.parse(request.body);
    // The task query context intersects the collection scope, alert scope and shop.
    const products=store.queryAll({taskId:task.id,view:'product',groups:[],whitelistMode:'all'}) as ProductRow[];
    const matched=products.filter(product=>list.productIds.includes(product.productId)||list.titleKeywords.some(word=>product.title.includes(word)));
    return {count:matched.length,products:matched.slice(0,20).map(product=>({productId:product.productId,title:product.title}))};
  });
  app.get('/api/alert-runs',async request=>{
    const filters=z.object({collectionRunId:z.string().min(1).max(100).optional(),alertTaskId:z.string().min(1).max(100).optional()}).parse(request.query);
    return {runs:store.listAlertRuns(filters).map(publicAlertRun)};
  });
  app.post<{Params:{id:string}}>('/api/alert-runs/:id/notify',async request=>{
    const run=requireValue(store.getAlertRun(request.params.id),'预警执行不存在');
    await ctx.notifyAlert(run,true);
    const current=requireValue(store.getAlertRun(run.id),'预警执行不存在');
    return {accepted:current.notificationStatus==='accepted',notificationStatus:current.notificationStatus};
  });
}
