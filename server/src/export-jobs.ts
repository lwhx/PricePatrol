import {randomUUID} from 'node:crypto';
import {mkdirSync,readdirSync,unlinkSync,renameSync,openSync,closeSync} from 'node:fs';
import {open} from 'node:fs/promises';
import {join} from 'node:path';
import {backup} from 'node:sqlite';
import {Worker} from 'node:worker_threads';
import type {ExportInput} from '../../shared/contracts.js';
import type {ExportJob,ExportSubmission} from '../../shared/export-jobs.js';
import type {Store} from './database.js';
import {HttpError} from './api-context.js';
import {exportFileInfo,exportFields,saveExportSnapshot} from './export.js';
import type {ExportMessage} from './export-executor.js';

const ttl=24*60*60*1000;
const capacity=20;
const ownedFile=/^([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.(partial|export|sqlite(?:-wal|-shm|-journal)?)$/;
interface Pending {
 job:ExportJob;
 input:ExportInput;
 forceFile:boolean;
 resolve:(result:ExportSubmission)=>void;
 reject:(reason:Error)=>void;
}
function remove(path:string){
 try{unlinkSync(path);}catch(error){if(!['ENOENT','ENOTDIR'].includes((error as NodeJS.ErrnoException).code??''))throw error;}
}
export class ExportJobs{
 private readonly directory:string;
 private readonly queue:Pending[]=[];
 private active?:Pending;
 private thread?:Worker;
 private processing?:Promise<void>;
 private readonly timer:NodeJS.Timeout;
 private closed=false;
 private orphanScanPending=true;

 constructor(private readonly store:Store,dataDir:string){
  this.directory=join(dataDir,'export-jobs');
  store.db.exec('CREATE TABLE IF NOT EXISTS export_jobs(id TEXT PRIMARY KEY,status TEXT NOT NULL,expires_at INTEGER NOT NULL,payload TEXT NOT NULL); CREATE INDEX IF NOT EXISTS export_jobs_expiry ON export_jobs(expires_at)');
  store.db.prepare("INSERT OR IGNORE INTO config(key,payload) VALUES('schema.export-jobs','1')").run();
  this.cleanup();
  this.timer=setInterval(()=>{
   try{this.cleanup();}catch{console.warn('导出文件清理暂未完成，将在下次维护时重试');}
  },60_000);
  this.timer.unref();
 }
 private change(job:ExportJob,patch:Partial<ExportJob>){
  const updated={...job,...patch};
  if(patch.status&&['ready','failed','cancelled'].includes(patch.status))updated.expiresAt=new Date(Date.now()+ttl).toISOString();
  const result=this.store.db.prepare('UPDATE export_jobs SET status=?,expires_at=?,payload=? WHERE id=?')
   .run(updated.status,Date.parse(updated.expiresAt),JSON.stringify(updated),job.id);
  if(!result.changes)throw new Error('导出任务状态未保存');
  Object.assign(job,updated);
 }
 private file(id:string,extension:string){return join(this.directory,id+'.'+extension);}
 private readonly cleanupRetry=new Set<string>();
 private tryRemove(path:string):boolean{
  try{remove(path);this.cleanupRetry.delete(path);return true;}
  catch{this.cleanupRetry.add(path);return false;}
 }
 private recoverInterrupted(job:ExportJob):ExportJob{
  if(!['queued','running'].includes(job.status)||this.active?.job.id===job.id||this.queue.some(item=>item.job.id===job.id))return job;
  // A crash or failed terminal UPDATE can leave a file without a committed ready receipt.
  this.tryRemove(this.file(job.id,'export'));
  const failed={status:'failed' as const,error:'导出进程已中断，请重新生成'};
  try{this.change(job,failed);return job;}
  catch{return {...job,...failed};} // Retry persistence on the next lookup or maintenance pass.
 }
 private scanOrphans(){
  let files:string[];
  try{files=readdirSync(this.directory);}catch{return;}
  for(const name of files){
   const match=ownedFile.exec(name);
   if(!match||this.active?.job.id===match[1])continue;
   if(match[2]!=='export'||this.get(match[1]!)?.status!=='ready')this.tryRemove(join(this.directory,name));
  }
  // Once the startup sweep succeeds, individual unlink failures are tracked separately.
  this.orphanScanPending=false;
 }
 private cleanup(){
  if(this.orphanScanPending)this.scanOrphans();
  for(const row of this.store.db.prepare("SELECT payload FROM export_jobs WHERE status IN('queued','running')").all()){
   this.recoverInterrupted(JSON.parse(String(row.payload)) as ExportJob);
  }
  for(const path of this.cleanupRetry)this.tryRemove(path);
  const expired=this.store.db.prepare("SELECT id FROM export_jobs WHERE expires_at<=? AND status NOT IN ('queued','running')").all(Date.now());
  for(const row of expired){
   const id=String(row.id);
   if(!this.tryRemove(this.file(id,'export')))continue;
   this.store.db.prepare('DELETE FROM export_jobs WHERE id=?').run(id);
  }
 }
 get(id:string):ExportJob|undefined{
  const row=this.store.db.prepare("SELECT payload FROM export_jobs WHERE id=? AND (expires_at>? OR status IN('queued','running'))").get(id,Date.now());
  return row?this.recoverInterrupted(JSON.parse(String(row.payload)) as ExportJob):undefined;
 }
 async submit(input:ExportInput,forceFile=false):Promise<ExportSubmission>{
  if(this.closed)throw new HttpError(503,'服务正在关闭');
  if(this.queue.length+Number(!!this.active)>=capacity)throw new HttpError(429,'导出队列已满，请稍后重试');
  exportFields(input);
  if(input.scope==='selected'&&!input.selectedIds?.length)throw new HttpError(400,'请先勾选记录');
  const now=Date.now();
  const job:ExportJob={id:randomUUID(),status:'queued',createdAt:new Date(now).toISOString(),expiresAt:new Date(now+ttl).toISOString(),preview:'',sourceCount:0,rowCount:0,bytes:0,error:null,...exportFileInfo(input.format)};
  this.store.db.prepare('INSERT INTO export_jobs VALUES(?,?,?,?)').run(job.id,job.status,now+ttl,JSON.stringify(job));
  return new Promise<ExportSubmission>((resolve,reject)=>{
   this.queue.push({job,input:structuredClone(input),forceFile,resolve,reject});
   if(forceFile)resolve({job:{...job}});
   this.kick();
  });
 }
 private kick(){
  if(this.closed||this.active)return;
  const pending=this.queue.shift();
  if(!pending)return;
  this.active=pending;
  this.processing=this.run(pending).catch(()=>{
   // Keep the queue draining if the job database itself is temporarily unavailable.
   pending.reject(new HttpError(500,'导出状态更新失败，请重新生成'));
  }).finally(()=>{
   this.thread=undefined;this.active=undefined;this.processing=undefined;this.kick();
  });
 }
 private async run(pending:Pending){
  const {job}=pending,partial=this.file(job.id,'partial');
  const memorySource=this.file(job.id,'sqlite');
  let copied=false;
  try{
   this.change(job,{status:'running'});
   mkdirSync(this.directory,{recursive:true,mode:0o700});
   let database=this.store.db.location();
   if(!database){
    // A worker cannot reopen :memory:. Snapshot that case with private permissions.
    closeSync(openSync(memorySource,'wx',0o600));copied=true;
    await backup(this.store.db,memorySource);
    database=memorySource;
   }
   if(job.status==='cancelled')return;
   if(this.closed)throw new HttpError(503,'导出进程已中断，请重新生成');
   const output=await this.execute(pending,database,partial);
   if((job as ExportJob).status==='cancelled')return;
   if(this.closed)throw new HttpError(503,'导出进程已中断，请重新生成');
   if(output.content!==undefined){
    const result={...output.metrics,token:job.id,filename:job.filename,mime:job.mime,downloadRecommended:false,content:output.content};
    this.store.transaction(()=>{
     saveExportSnapshot(this.store,result);
     this.store.db.prepare('DELETE FROM export_jobs WHERE id=?').run(job.id);
    });
    pending.resolve(result);
   }else{
    renameSync(partial,this.file(job.id,'export'));
    this.change(job,{...output.metrics,status:'ready'});
    pending.resolve({job:{...job}});
   }
  }catch(error){
   if(job.status!=='cancelled'){
    const safe=this.closed?new HttpError(503,'导出进程已中断，请重新生成'):error instanceof HttpError?error:new HttpError(500,'文件导出失败，请重试');
    this.tryRemove(this.file(job.id,'export'));
    try{this.change(job,{status:'failed',error:safe.message});}
    finally{pending.reject(safe);}
   }
  }finally{
   this.tryRemove(partial);
   if(copied)for(const suffix of ['','-wal','-shm','-journal'])this.tryRemove(memorySource+suffix);
  }
 }
 private execute(pending:Pending,database:string,partial:string):Promise<Extract<ExportMessage,{kind:'done'}>>{
  return new Promise((resolve,reject)=>{
   const thread=new Worker(new URL('./export-worker.mjs',import.meta.url),{workerData:{database,partial,input:pending.input,forceFile:pending.forceFile},execArgv:[],env:{}});
   this.thread=thread;
   let done:Extract<ExportMessage,{kind:'done'}>|undefined;
   let failure:Error|undefined;
   thread.on('message',(message:ExportMessage)=>{
    if(message.kind==='file')pending.resolve({job:{...pending.job}});
    else if(message.kind==='error')failure=new HttpError(message.status,message.message);
    else done=message;
   });
   thread.once('error',()=>{failure=new Error('导出工作线程异常');});
   thread.once('exit',code=>{
    if(!failure&&code===0&&done)resolve(done);
    else reject(failure??new Error('导出工作线程已停止'));
   });
  });
 }
 async cancel(id:string):Promise<ExportJob>{
  const record=this.get(id);
  if(!record)throw new HttpError(404,'导出任务不存在或已过期');
  if(record.status==='cancelled')return record;
  if(record.status!=='running'&&record.status!=='queued')throw new HttpError(409,'仅能取消进行中的导出任务');
  const queued=this.queue.findIndex(item=>item.job.id===id);
  const pending=queued>=0?this.queue[queued]:this.active;
  if(!pending||pending.job.id!==id)throw new HttpError(409,'导出状态已变化');
  this.change(pending.job,{status:'cancelled',error:null});
  if(queued>=0)this.queue.splice(queued,1);
  pending.resolve({job:{...pending.job}});
  if(this.active===pending&&this.thread)void this.thread.terminate();
  return {...pending.job};
 }
 private async openDownload(id:string){
  const job=this.get(id);
  if(!job)throw new HttpError(404,'导出任务不存在或已过期');
  if(job.status!=='ready')throw new HttpError(409,'导出文件尚不可下载');
  // Pin the file across expiry cleanup. The caller releases the descriptor.
  let handle;
  try{handle=await open(this.file(job.id,'export'),'r');}
  catch(error){
   if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
   this.change(job,{status:'failed',error:'导出文件不存在，请重新生成'});
   throw new HttpError(410,'导出文件不存在，请重新生成');
  }
  return {handle,filename:job.filename,mime:job.mime,bytes:job.bytes};
 }
 async head(id:string){
  const {handle,...metadata}=await this.openDownload(id);
  await handle.close();
  return metadata;
 }
 async download(id:string){
  const {handle,...metadata}=await this.openDownload(id);
  return {stream:handle.createReadStream(),...metadata};
 }
 async close(){
  this.closed=true;
  clearInterval(this.timer);
  // Keep interrupted tasks inspectable, with the same outcome as startup recovery.
  for(const queued of this.queue.splice(0)){
   try{this.change(queued.job,{status:'failed',error:'导出进程已中断，请重新生成'});}
   catch{/* The queued record is recovered on a lookup, cleanup pass or restart. */}
   queued.reject(new HttpError(503,'服务正在关闭'));
  }
  this.active?.reject(new HttpError(503,'服务正在关闭'));
  try{if(this.thread)await this.thread.terminate();}
  finally{
   await this.processing;
   try{this.cleanup();}catch{/* Startup will retry unavailable database and file operations. */}
  }
 }
}
