import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {WorkerOptions} from 'node:worker_threads';
import {expect,it,vi} from 'vitest';
import {Store} from '../src/database.js';
import {backupDatabase} from '../src/backup.js';
import {ExportJobs} from '../src/export-jobs.js';

const launches=vi.hoisted(()=>[] as {url:string;options?:WorkerOptions}[]);
vi.mock('node:worker_threads',async importOriginal=>{
 const threads=await importOriginal<typeof import('node:worker_threads')>();
 return {...threads,Worker:class extends threads.Worker {
  constructor(file:string|URL,options?:WorkerOptions){
   super(file,options);
   launches.push({url:String(file),options});
  }
 }};
});

it('starts real backup and export workers with an explicit empty environment',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'pricepatrol-worker-env-'));
 const store=new Store(join(dir,'fixture.sqlite'),'fixture-database-key'.repeat(2));
 const jobs=new ExportJobs(store,dir);
 try{
  for(const key of ['ENCRYPTION_KEY','ADMIN_PASSWORD','SETUP_TOKEN'])vi.stubEnv(key,'fixture-parent-secret');
  await backupDatabase(store.db,join(dir,'backup.sqlite'));
  await jobs.submit({query:{},scope:'all',fields:['productId'],format:'ids',header:false});
  expect(launches.map(({url})=>url.split('/').pop())).toEqual(['backup-worker.mjs','export-worker.mjs']);
  for(const {options} of launches){
   expect(options?.env).toStrictEqual({});
   expect(JSON.stringify(options?.workerData)).not.toContain('fixture-parent-secret');
  }
 }finally{
  vi.unstubAllEnvs();
  await jobs.close();store.close();await rm(dir,{recursive:true,force:true});
 }
});
