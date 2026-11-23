import {randomUUID} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {mkdir,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {z} from 'zod';
import {buildExport,getExport} from './export.js';
import {querySchema,exportSchema} from './validation.js';
import {requireValue,HttpError,publicRun,type ApiContext} from './api-context.js';
export function registerData(ctx:ApiContext):void{
  const {app,store}=ctx;
  app.get('/api/overview',async()=>store.overview());
  app.post('/api/prices/query',async request=>store.query(querySchema.parse(request.body||{})));
  app.get('/api/prices/history',async request=>{const query=z.object({shopId:z.string().min(1),productId:z.string().regex(/^\d{6,20}$/),skuId:z.string().optional()}).parse(request.query);return {rows:store.history(query.shopId,query.productId,query.skuId)};});
  app.post('/api/prices/compare',async request=>{const input=z.object({leftRunId:z.string(),rightRunId:z.string()}).parse(request.body);const left=requireValue(store.getRun(input.leftRunId)),right=requireValue(store.getRun(input.rightRunId));if(left.shopId!==right.shopId)throw new HttpError(400,'请选择同一家店的两次采集');if(!left.finishedAt||!right.finishedAt)throw new HttpError(400,'仅能比较已结束作业');return {rows:store.compare(input.leftRunId,input.rightRunId)};});
  app.patch('/api/prices/annotations',async request=>{const input=z.object({shopId:z.string(),productIds:z.array(z.string().regex(/^\d{6,20}$/)).min(1).max(20000),tags:z.array(z.string().trim().max(50)).max(30).optional(),note:z.string().max(2000).optional()}).parse(request.body);if(!store.getShop(input.shopId))throw new HttpError(400,'店铺不存在');return {updated:store.annotate(input.shopId,input.productIds,input.tags,input.note)};});
  app.post('/api/exports',async request=>{const input=exportSchema.parse(request.body);if(input.scope==='selected'&&!input.selectedIds?.length)throw new HttpError(400,'请先勾选记录');return buildExport(store,input);});
  app.get<{Params:{token:string}}>('/api/exports/:token/download',async(request,reply)=>{const output=requireValue(getExport(store,request.params.token),'复制快照已过期，请重新生成');reply.header('content-disposition',`attachment; filename*=UTF-8''${encodeURIComponent(output.filename)}`).type(output.mime);return output.content;});
  app.get('/api/queries',async()=>({queries:store.listQueries()}));
  app.post('/api/queries',async request=>{const input=z.object({name:z.string().trim().min(1).max(100),query:querySchema}).parse(request.body);return store.saveQuery(input.name,input.query);});
  app.delete<{Params:{id:string}}>('/api/queries/:id',async request=>{store.deleteQuery(request.params.id);return {ok:true};});
  app.get('/api/runs',async request=>{const {runId}=z.object({runId:z.string().optional()}).parse(request.query);return {runs:(runId?[requireValue(store.getRun(runId),'采集记录不存在')]:store.listRuns()).map(publicRun)};});
  app.post<{Params:{id:string}}>('/api/runs/:id/stop',async request=>({run:publicRun(ctx.worker.stop(request.params.id))}));
  app.post<{Params:{id:string}}>('/api/runs/:id/resume',async request=>({run:publicRun(ctx.worker.resume(request.params.id))}));
  app.post<{Params:{id:string}}>('/api/runs/:id/retry',async request=>({run:publicRun(ctx.worker.retry(request.params.id))}));
  app.get('/api/alerts',async request=>{const input=z.object({state:z.string().optional(),shopId:z.string().optional(),runId:z.string().optional(),alertRunId:z.string().optional()}).parse(request.query);return {alerts:store.listAlerts(input)};});
  app.patch<{Params:{id:string}}>('/api/alerts/:id',async request=>{requireValue(store.getAlert(request.params.id));const patch=z.object({state:z.enum(['pending','confirmed','resolved']).optional(),note:z.string().max(2000).optional()}).parse(request.body);return {alert:store.updateAlert(request.params.id,patch)};});
  app.post('/api/maintenance/backup',async(_request,reply)=>{const dir=join(ctx.dataDir,'backups');await mkdir(dir,{recursive:true});const path=join(dir,`price-monitor-${randomUUID()}.sqlite`);await store.backup(path);const stream=createReadStream(path);stream.on('close',()=>{void unlink(path).catch(()=>{});});reply.type('application/octet-stream').header('content-disposition','attachment; filename="price-monitor-backup.sqlite"');return reply.send(stream);});
  app.post('/api/maintenance/cleanup',async request=>{const {before}=z.strictObject({before:z.iso.datetime({offset:true}).optional()}).parse(request.body??{});return ctx.maintenance.cleanupBefore(before);});
}
