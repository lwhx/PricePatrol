import {mkdtempSync,readdirSync,rmSync,writeFileSync,existsSync,unlinkSync,renameSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {text} from 'node:stream/consumers';
import {afterEach,expect,it,vi} from 'vitest';
import type {CollectedRow,ExportInput,ExportResult} from '../../shared/contracts.js';
import type {ExportJob} from '../../shared/export-jobs.js';
import {Store} from '../src/database.js';
import {ExportJobs} from '../src/export-jobs.js';
import {buildExport,getExport} from '../src/export.js';

const key='export-job-test-fixture-32-characters';
const resources:Array<{store:Store;service:ExportJobs;dir:string}>=[];
const base:ExportInput={query:{sort:'skuId',order:'asc'},scope:'all',fields:['skuId','title','after'],format:'csv',header:true};
function fixture(count:number){
 const dir=mkdtempSync(join(tmpdir(),'pricepatrol-file-export-'));
 const store=new Store(join(dir,'prices.sqlite'),key);
 const at=new Date().toISOString();
 store.saveShop({id:'s',sellerId:'fixture',name:'fixture',platform:'tmall',enabled:true,sessionStatus:'valid',hasCookies:false,createdAt:at,updatedAt:at,lastError:null,lastVerifiedAt:null});
 store.saveRun({id:'r',shopId:'s',taskId:null,shopName:'fixture',taskName:'fixture',status:'running',scope:'all',productIds:[],expected:2,processed:0,failed:0,rows:0,checked:0,excluded:0,matched:0,unknown:0,message:'',createdAt:at,startedAt:at,finishedAt:null,parentRunId:null,failedProductIds:[],notificationStatus:'disabled',taskSnapshot:null});
 const rows=(productId:string,n:number,offset:number):CollectedRow[]=>Array.from({length:n},(_,i)=>({
  shopId:'s',productId,skuId:String(offset+i).padStart(6,'0'),title:'=原始,"沙发"|\n换行',specs:'规格',seatSpec:'',color:'',backendPrice:'100',before:'100',after:i%3?'80':'90',backendVerified:true,status:'ok',sourceUrl:'',backendSource:'fixture',detailFetchedAt:at,backendFetchedAt:at,stock:0,
 }));
 store.saveProduct('r',{productId:'100001',title:'fixture',rows:rows('100001',count,0)});
 store.saveProduct('r',{productId:'100002',title:'fixture',rows:rows('100002',1,count)});
 const resource={store,service:new ExportJobs(store,dir),dir};resources.push(resource);return resource;
}
afterEach(async()=>{
 for(const {store,service,dir} of resources.splice(0)){await service.close();store.close();rmSync(dir,{recursive:true,force:true});}
});
async function ready(service:ExportJobs,id:string){
 for(let i=0;i<500;i++){
  const result=service.get(id)!;
  if(result.status==='ready')return result;
  if(result.status==='failed')throw Error(result.error||'export failed');
  await delay(10);
 }
 throw Error('export did not finish');
}
it('encodes each format identically on a real file worker, with compatible small copy snapshots',async()=>{
 const {store,service}=fixture(3);
 const inline=await service.submit(base) as ExportResult;
 expect(inline.content).toContain(`"'=原始,""沙发""|\n换行"`);
 expect(getExport(store,inline.token)).toEqual(inline);
 store.annotate('s',['100001'],['标签'],'注释');
 const formats:ExportInput['format'][]=['tsv','csv','text','markdown','json','ids','titles','id-title'];
 for(const format of formats){
  const input:ExportInput={...base,format,query:{view:'product',sort:'maxAfter',order:'asc',groups:[{mode:'all',conditions:[{field:'after',op:'lt',value:'85'}]}]},allSkus:true,fields:['id','title','status','after','skuId','note','tags'],separator:'|'};
  const small=buildExport(store,input);
  const {job}=await service.submit(input,true) as {job:ExportJob};
  const completed=await ready(service,job.id);
  expect(completed).toMatchObject({bytes:small.bytes,rowCount:small.rowCount,sourceCount:small.sourceCount,preview:small.preview});
  expect(await text((await service.download(job.id)).stream)).toBe(small.content);
 }
},20000);
it('auto-selects disk for a large snapshot, returns bounded metadata and preserves bytes across changes',async()=>{
 const {store,service,dir}=fixture(2300);
 const input:ExportInput={...base,fields:['skuId','note'],header:false};
 store.annotate('s',['100001'],[],'before');
 const {job}=await service.submit(input) as {job:ExportJob};
 expect(job.status).toBe('running');
 store.annotate('s',['100001'],[],'after');
 const completed=await ready(service,job.id);
 expect(completed).toMatchObject({rowCount:2301,sourceCount:2301});
 expect(completed).not.toHaveProperty('content');
 const output=await text((await service.download(job.id)).stream);
 expect(output.split('\n')).toHaveLength(2301);
 expect(output).toContain('002299,before');expect(output).not.toContain('after');
 expect(Buffer.byteLength(output)).toBe(completed.bytes);
 expect(String(store.db.prepare('SELECT payload FROM export_jobs WHERE id=?').get(job.id)?.payload).length).toBeLessThan(2000);
 expect(store.db.prepare("SELECT name FROM sqlite_master WHERE name='export_snapshots'").get()).toBeUndefined();
 expect(readdirSync(join(dir,'export-jobs'))).toEqual([job.id+'.export']);
},20000);
it('rejects a full queue, cancels queued and active work, recovers interruptions, and expires owned files',async()=>{
 const f=fixture(1);
 const tasks=await Promise.all(Array.from({length:20},()=>f.service.submit(base,true) as Promise<{job:ExportJob}>));
 await expect(f.service.submit(base,true)).rejects.toMatchObject({statusCode:429});
 expect((await f.service.cancel(tasks[1]!.job.id)).status).toBe('cancelled');
 expect((await f.service.cancel(tasks[0]!.job.id)).status).toBe('cancelled');
 await expect(f.service.download(tasks[0]!.job.id)).rejects.toMatchObject({statusCode:409});
 await f.service.close();
 const id=tasks[0]!.job.id;
 const stale={...f.service.get(id)!,status:'running'};
 f.store.db.prepare('UPDATE export_jobs SET status=?,payload=? WHERE id=?').run('running',JSON.stringify(stale),id);
 const dir=join(f.dir,'export-jobs');
 writeFileSync(join(dir,id+'.partial'),'interrupted');writeFileSync(join(dir,'other-file'),'keep');
 f.service=new ExportJobs(f.store,f.dir);
 expect(f.service.get(id)).toMatchObject({status:'failed',error:expect.stringContaining('中断')});
 expect(existsSync(join(dir,id+'.partial'))).toBe(false);expect(existsSync(join(dir,'other-file'))).toBe(true);
 const {job}=await f.service.submit(base,true) as {job:ExportJob};await ready(f.service,job.id);
 await f.service.close();f.store.db.prepare('UPDATE export_jobs SET expires_at=0 WHERE id=?').run(job.id);
 f.service=new ExportJobs(f.store,f.dir);
 expect(f.service.get(job.id)).toBeUndefined();expect(existsSync(join(dir,job.id+'.export'))).toBe(false);
 const missing=await f.service.submit(base,true) as {job:ExportJob};await ready(f.service,missing.job.id);
 unlinkSync(join(dir,missing.job.id+'.export'));
 await expect(f.service.download(missing.job.id)).rejects.toMatchObject({statusCode:410});
 expect(f.service.get(missing.job.id)?.status).toBe('failed');
},20000);

it('switches an oversized cell to a file, caps its preview, and publishes no partial file on failure',async()=>{
 const {store,service,dir}=fixture(1);
 const large='注'.repeat(1_800_000);
 store.annotate('s',['100001'],[],large);
 const {job}=await service.submit({...base,query:{productIds:['100001']},fields:['note'],header:false}) as {job:ExportJob};
 const result=await ready(service,job.id);
 expect(result).toMatchObject({sourceCount:1,rowCount:1,bytes:Buffer.byteLength(large)});
 expect(result.preview.length).toBeLessThanOrEqual(32*1024+1);
 const invalid=await service.submit({...base,query:{sort:'unsupported'}},true) as {job:ExportJob};
 await expect(ready(service,invalid.job.id)).rejects.toThrow('不支持的排序字段');
 expect(service.get(invalid.job.id)?.status).toBe('failed');
 expect(readdirSync(join(dir,'export-jobs'))).toEqual([job.id+'.export']);
},20000);

it('retains ownership of a queued automatic request when cancellation cannot be persisted',async()=>{
 const {service,store}=fixture(2);
 await service.submit(base,true);
 const waiting=service.submit(base);
 const queued=String(store.db.prepare("SELECT id FROM export_jobs WHERE status='queued'").get()!.id);
 store.db.exec("CREATE TRIGGER block_cancel BEFORE UPDATE ON export_jobs WHEN NEW.status='cancelled' BEGIN SELECT RAISE(ABORT,'fixture'); END");
 await expect(service.cancel(queued)).rejects.toThrow();
 expect(service.get(queued)?.status).toBe('queued');
 store.db.exec('DROP TRIGGER block_cancel');
 await expect(waiting).resolves.toHaveProperty('content');
});
it('cleans a file whose ready receipt failed and reconciles its interrupted job when writes recover',async()=>{
 const {service,store,dir}=fixture(2);
 store.db.exec("CREATE TRIGGER block_terminal BEFORE UPDATE ON export_jobs WHEN NEW.status IN('ready','failed') BEGIN SELECT RAISE(ABORT,'fixture'); END");
 const {job}=await service.submit(base,true) as {job:ExportJob};
 await vi.waitFor(()=>expect(service.get(job.id)?.status).toBe('failed'));
 expect(store.db.prepare('SELECT status FROM export_jobs WHERE id=?').get(job.id)?.status).toBe('running');
 expect(readdirSync(join(dir,'export-jobs'))).toEqual([]);
 store.db.exec('DROP TRIGGER block_terminal');
 expect(service.get(job.id)?.status).toBe('failed');
 expect(store.db.prepare('SELECT status FROM export_jobs WHERE id=?').get(job.id)?.status).toBe('failed');
 await expect(service.download(job.id)).rejects.toMatchObject({statusCode:409});
});
it('settles active and queued requests on close even while failed statuses cannot be written',async()=>{
 const {service,store}=fixture(2);
 const completions=Promise.allSettled([service.submit(base),service.submit(base),service.submit(base)]);
 const ids=store.db.prepare('SELECT id FROM export_jobs').all().map(row=>String(row.id));
 store.db.exec("CREATE TRIGGER block_failure BEFORE UPDATE ON export_jobs WHEN NEW.status='failed' BEGIN SELECT RAISE(ABORT,'fixture'); END");
 await service.close();
 expect(await completions).toEqual(ids.map(()=>({status:'rejected',reason:expect.objectContaining({statusCode:503})})));
 store.db.exec('DROP TRIGGER block_failure');
 for(const id of ids)expect(service.get(id)?.status).toBe('failed');
 expect(store.db.prepare("SELECT count(*) n FROM export_jobs WHERE status='failed'").get()?.n).toBe(3);
});
it('isolates a non-directory export destination from database startup and ordinary queries',async()=>{
 const f=fixture(1);
 await f.service.close();
 writeFileSync(join(f.dir,'export-jobs'),'fixture file');
 f.service=new ExportJobs(f.store,f.dir);
 expect(f.store.query({}).total).toBe(2);
 await expect(f.service.submit(base)).rejects.toMatchObject({statusCode:500,message:'文件导出失败，请重试'});
 expect(f.store.db.prepare("SELECT count(*) n FROM export_jobs WHERE status='failed'").get()?.n).toBe(1);
});

it('retries an unavailable startup sweep after directory recovery while a worker owns staging paths',async()=>{
 const f=fixture(1),dir=join(f.dir,'export-jobs'),offline=join(f.dir,'offline');
 const {job:completed}=await f.service.submit(base,true) as {job:ExportJob};
 await ready(f.service,completed.id);
 await f.service.close();
 const orphan='12345678-1234-1234-1234-123456789abc';
 const garbage=['partial','sqlite','sqlite-shm','sqlite-wal','sqlite-journal','export'].map(suffix=>orphan+'.'+suffix);
 for(const name of [...garbage,'operator.txt'])writeFileSync(join(dir,name),'fixture');
 renameSync(dir,offline);
 writeFileSync(dir,'temporarily unavailable');
 vi.useFakeTimers({toFake:['setInterval','clearInterval']});
 try{
  f.service=new ExportJobs(f.store,f.dir); // Real ENOTDIR at startup.
  unlinkSync(dir);renameSync(offline,dir);
  const {job:active}=await f.service.submit(base,true) as {job:ExportJob};
  const activeSidecar=join(dir,active.id+'.sqlite-shm');
  writeFileSync(activeSidecar,'active fixture');
  vi.advanceTimersByTime(60_000);
  for(const name of garbage)expect(existsSync(join(dir,name))).toBe(false);
  expect(existsSync(activeSidecar)).toBe(true);
  expect(existsSync(join(dir,completed.id+'.export'))).toBe(true);
  expect(existsSync(join(dir,'operator.txt'))).toBe(true);
  unlinkSync(activeSidecar);
  await ready(f.service,active.id);
 }finally{await f.service.close();vi.useRealTimers();}
});
