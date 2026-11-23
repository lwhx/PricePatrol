import type {FastifyInstance} from 'fastify';
import type {Collector,VerifiedAccount,Shop,Run} from '../../shared/contracts.js';
import type {Store,RunRecord,AlertRunRecord} from './database.js';
import type {Worker} from './worker.js';
import type {AlertWorker} from './alert-worker.js';
import type {Scheduler} from './scheduler.js';
import type {BrowserLoginService} from './integrations/browser-login.js';
import type {Vault} from './security.js';
import type {MaintenanceService} from './maintenance.js';
export interface ApiContext {app:FastifyInstance;store:Store;collector:Collector;worker:Worker;alertWorker:AlertWorker;scheduler:Scheduler;browser:BrowserLoginService;maintenance:MaintenanceService;dataDir:string;vault:Vault;notifyAlert:(run:AlertRunRecord,force?:boolean)=>Promise<void>}
export class HttpError extends Error {constructor(public statusCode:number,message:string){super(message);}}
export function requireValue<T>(value:T|null|undefined,message='记录不存在'):T{if(value===undefined||value===null)throw new HttpError(404,message);return value;}
export function publicRun(run:RunRecord):Run{const {taskSnapshot:_,alertTaskSnapshots:__,...rest}=run;return rest;}
