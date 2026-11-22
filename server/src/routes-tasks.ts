import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {taskSchema} from './validation.js';
import {nextRunAt} from './scheduler.js';
import {requireValue,publicRun,type ApiContext} from './api-context.js';
export function registerTasks(ctx:ApiContext):void{
  const {app,store}=ctx;
  app.get('/api/tasks',async()=>({tasks:store.listTasks()}));
  app.post('/api/tasks',async request=>{const input=taskSchema.parse(request.body);requireValue(store.getShop(input.shopId),'店铺不存在');const at=new Date().toISOString();const task={...input,id:randomUUID(),version:1,createdAt:at,updatedAt:at,nextRunAt:input.enabled?nextRunAt(input.schedule):null};store.saveTask(task);return {task};});
  app.patch<{Params:{id:string}}>('/api/tasks/:id',async request=>{const prior=requireValue(store.getTask(request.params.id),'任务不存在');const patch=z.record(z.string(),z.unknown()).parse(request.body);const input=taskSchema.parse({...prior,...patch});requireValue(store.getShop(input.shopId),'店铺不存在');const task={...input,id:prior.id,version:prior.version+1,createdAt:prior.createdAt,updatedAt:new Date().toISOString(),nextRunAt:input.enabled?nextRunAt(input.schedule):null};store.saveTask(task);if(!task.enabled)for(const run of store.operationalRuns(['queued']))if(run.taskId===task.id&&run.trigger==='scheduled')ctx.worker.stop(run.id);return {task};});
  app.delete<{Params:{id:string}}>('/api/tasks/:id',async request=>{requireValue(store.getTask(request.params.id));for(const run of store.operationalRuns(['queued']))if(run.taskId===request.params.id&&run.trigger==='scheduled')ctx.worker.stop(run.id);store.deleteTask(request.params.id);return {ok:true};});
  app.post<{Params:{id:string}}>('/api/tasks/:id/run',async request=>{const task=requireValue(store.getTask(request.params.id));return {run:publicRun(ctx.worker.enqueue(task.shopId,task.id))};});
  app.post<{Params:{id:string}}>('/api/tasks/:id/duplicate',async request=>{const prior=requireValue(store.getTask(request.params.id));const at=new Date().toISOString();const task={...structuredClone(prior),id:randomUUID(),name:prior.name+' 副本',enabled:false,version:1,nextRunAt:null,createdAt:at,updatedAt:at};store.saveTask(task);return {task};});
}
