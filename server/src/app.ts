import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import staticPlugin from '@fastify/static';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {randomBytes} from 'node:crypto';
import {ZodError} from 'zod';
import type {Collector} from '../../shared/contracts.js';
import type {Store} from './database.js';
import {Worker} from './worker.js';
import {AlertWorker} from './alert-worker.js';
import {Scheduler} from './scheduler.js';
import {Vault} from './security.js';
import {registerAuth} from './auth.js';
import {registerAccounts} from './routes-accounts.js';
import {registerData} from './routes-data.js';
import {registerTasks} from './routes-tasks.js';
import {registerAlertTasks} from './routes-alerts.js';
import {notifyAlertRun,registerSettings} from './notifications.js';
import {BrowserLoginService} from './integrations/browser-login.js';
import type {ApiContext} from './api-context.js';
export interface AppOptions {store:Store;collector:Collector;dataDir:string;encryptionKey?:string;allowedOrigins?:string[];browser?:BrowserLoginService;serveStatic?:boolean}
export async function buildApp(options:AppOptions){
  const app=Fastify({bodyLimit:2*1024*1024,logger:false});await app.register(cookie);await app.register(rateLimit,{max:1200,timeWindow:'1 minute'});
  app.setErrorHandler((error,_request,reply)=>{if(error instanceof ZodError)return reply.code(400).send({error:error.issues.slice(0,3).map(i=>`${i.path.join('.')}: ${i.message}`).join('；')});const status=(error as {statusCode?:number}).statusCode;const safe=status&&status>=400&&status<500;return reply.code(status||400).send({error:safe&&error instanceof Error?error.message:'操作失败，请检查输入或账号状态'});});
  const vault=new Vault(options.encryptionKey||randomBytes(32).toString('hex'));
  const notifyAlert=(run:Parameters<typeof notifyAlertRun>[2],force=false)=>notifyAlertRun(options.store,vault,run,force);
  const alertWorker=new AlertWorker(options.store,async run=>notifyAlert(run));
  const worker=new Worker(options.store,options.collector,run=>alertWorker.enqueueForCollection(run.id));const scheduler=new Scheduler(options.store,worker);
  const browser=options.browser||new BrowserLoginService({dataDir:options.dataDir});
  const ctx:ApiContext={app,store:options.store,collector:options.collector,worker,alertWorker,scheduler,browser,dataDir:options.dataDir,vault,notifyAlert};
  await registerAuth(app,options.store,options.allowedOrigins||['http://localhost:5173','http://127.0.0.1:5173']);
  app.get('/api/health',async()=>({ok:true,version:'0.1.0'}));registerAccounts(ctx);registerData(ctx);registerTasks(ctx);registerAlertTasks(ctx);registerSettings(ctx);
  const webDir=resolve('web/dist');if(options.serveStatic!==false&&existsSync(webDir)){await app.register(staticPlugin,{root:webDir,prefix:'/'});app.setNotFoundHandler((request,reply)=>request.url.startsWith('/api/')?reply.code(404).send({error:'接口不存在'}):reply.sendFile('index.html'));}
  app.addHook('onClose',async()=>{scheduler.stop();await worker.close();await alertWorker.close();await browser.closeAll();});await app.ready();return {app,worker,alertWorker,scheduler,browser};
}
