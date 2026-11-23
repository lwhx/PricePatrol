import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import staticPlugin from '@fastify/static';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import type {Writable} from 'node:stream';
import type {Collector} from '../../shared/contracts.js';
import type {Store} from './database.js';
import {Worker} from './worker.js';
import {AlertWorker} from './alert-worker.js';
import {Scheduler} from './scheduler.js';
import {Vault} from './security.js';
import {registerAuth} from './auth.js';
import {hasAdminPassword} from './bootstrap.js';
import {registerAccounts} from './routes-accounts.js';
import {registerData} from './routes-data.js';
import {registerTasks} from './routes-tasks.js';
import {registerAlertTasks} from './routes-alerts.js';
import {notifyAlertRun,registerSettings} from './notifications.js';
import {BrowserLoginService} from './integrations/browser-login.js';
import {HttpError,type ApiContext} from './api-context.js';
import {backgroundDiagnostics,diagnosticLogger,registerDiagnostics} from './diagnostics.js';
import {getOperations} from './operations.js';
import {MaintenanceService} from './maintenance.js';
import {registerMaintenance} from './routes-maintenance.js';
import {ExportJobs} from './export-jobs.js';
export interface AppOptions {store:Store;collector:Collector;dataDir:string;encryptionKey?:string;allowedOrigins?:string[];browser?:BrowserLoginService;serveStatic?:boolean;setupToken?:string;logStream?:Writable;maintenance?:MaintenanceService;collectionConcurrency?:number}
export async function buildApp(options:AppOptions){
  const setupToken = options.setupToken?.trim();
  if (process.env.NODE_ENV === 'production' && !setupToken && !hasAdminPassword(options.store)) {
    throw new Error('生产环境首次使用需要 SETUP_TOKEN 或已初始化的管理员密码');
  }
  const app=Fastify({bodyLimit:2*1024*1024,logger:diagnosticLogger(options.logStream),
    logController:new Fastify.LogController({disableRequestLogging:true}),requestIdHeader:false,genReqId:()=>randomUUID()});
  await app.register(cookie);
  await app.register(rateLimit,{max:1200,timeWindow:'1 minute',errorResponseBuilder:(_request,context)=>new HttpError(context.statusCode,'请求过于频繁，请稍后再试')});
  registerDiagnostics(app);
  const vault=new Vault(options.encryptionKey||randomBytes(32).toString('hex'));
  const report=backgroundDiagnostics(app.log);
  const notifyAlert=async(run:Parameters<typeof notifyAlertRun>[2],force=false)=>{
    await notifyAlertRun(options.store,vault,run,force);
    if(!force&&run.notificationStatus!=='failed'&&options.store.getAlertRun(run.id)?.notificationStatus==='failed'){
      report('notification_failed',{runId:run.collectionRunId,evaluationId:run.id});
    }
  };
  const alertWorker=new AlertWorker(options.store,async run=>notifyAlert(run),report);
  const worker=new Worker(options.store,options.collector,run=>alertWorker.enqueueForCollection(run.id),report,options.collectionConcurrency??1);
  const scheduler=new Scheduler(options.store,worker,report);
  const browser=options.browser||new BrowserLoginService({dataDir:options.dataDir});
  const maintenance=options.maintenance||new MaintenanceService(options.store,{dataDir:options.dataDir});
  const exportJobs=new ExportJobs(options.store,options.dataDir);
  const ctx:ApiContext={app,store:options.store,collector:options.collector,worker,alertWorker,scheduler,browser,maintenance,exportJobs,dataDir:options.dataDir,vault,notifyAlert};
  await registerAuth(app,options.store,options.allowedOrigins||['http://localhost:5173','http://127.0.0.1:5173'],setupToken);
  app.get('/api/health',async()=>({ok:true,version:'0.1.0'}));
  app.get('/api/operations',async()=>getOperations(options.store));
  registerAccounts(ctx);registerData(ctx);registerTasks(ctx);registerAlertTasks(ctx);registerSettings(ctx);registerMaintenance(ctx,maintenance);
  const webDir=resolve('web/dist');if(options.serveStatic!==false&&existsSync(webDir)){await app.register(staticPlugin,{root:webDir,prefix:'/'});app.setNotFoundHandler((request,reply)=>request.url.startsWith('/api/')?reply.code(404).send({error:'接口不存在'}):reply.sendFile('index.html'));}
  // Release auto-export HTTP requests before Fastify waits for connections to drain.
  app.addHook('preClose',async()=>{await exportJobs.close();});
  app.addHook('onClose',async()=>{scheduler.stop();await worker.close();await alertWorker.close();await maintenance.close();await browser.closeAll();});await app.ready();return {app,worker,alertWorker,scheduler,browser,maintenance,exportJobs};
}
