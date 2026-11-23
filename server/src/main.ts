import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {join,resolve} from 'node:path';
import {Store} from './database.js';
import {buildApp} from './app.js';
import {createCollector} from './collector/index.js';
import {prepareBootstrap} from './bootstrap.js';
const dataDir=resolve(process.env.DATA_DIR||'data');await mkdir(dataDir,{recursive:true});
let encryptionKey=process.env.ENCRYPTION_KEY||'';
if(!encryptionKey){const keyFile=join(dataDir,'.encryption-key');try{encryptionKey=(await readFile(keyFile,'utf8')).trim();}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;encryptionKey=randomBytes(32).toString('hex');await writeFile(keyFile,encryptionKey,{mode:0o600,flag:'wx'});}}
const store=new Store(join(dataDir,'monitor.sqlite'),encryptionKey);
const setupToken=await prepareBootstrap(store,dataDir);
const port=Number(process.env.PORT||3000);const host=process.env.HOST||'127.0.0.1';
const allowedOrigins=(process.env.ALLOWED_ORIGINS||'http://localhost:5173,http://127.0.0.1:5173').split(',').filter(Boolean);
const {app,worker,alertWorker,scheduler,maintenance}=await buildApp({store,collector:createCollector(),dataDir,encryptionKey,allowedOrigins,setupToken});worker.recover();alertWorker.recover();scheduler.start();maintenance.start();
await app.listen({host,port});console.log(`电商价格监控已启动：http://${host}:${port}`);
let stopping=false;async function close(){if(stopping)return;stopping=true;await app.close();store.close();process.exit(0);}
process.on('SIGINT',()=>void close());process.on('SIGTERM',()=>void close());
