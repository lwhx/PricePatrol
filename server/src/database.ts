import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {backupDatabase} from './backup.js';
import {Vault} from './security.js';
import {queryStore,queryAllStore,registerQueryFunctions} from './query.js';
import {moneyCents,formatDiscount,rowKey} from './domain.js';
import {migrateCollectionAlerts,migrateShopArchival} from './migrations.js';
import {COLLECTION_SUBMISSION_TTL_MS} from './collection-submissions.js';
import {initializeIncidents,supersedeTaskIncidents} from './incidents.js';
import {unfinishedRetryParentGuard} from './retention.js';
import type {Run,RunStatus,CollectionTask,AlertTask,AlertRun,Shop,VerifiedAccount,ProductCollection,PriceRow,Alert,QueryInput,QueryResult,ProductRow,Overview} from '../../shared/contracts.js';
// Serialize integer cents without routing through floating-point division.
function moneyText(cents:number|null):string|null{if(cents===null)return null;const integer=BigInt(cents),absolute=integer<0n?-integer:integer;return `${integer<0n?'-':''}${absolute/100n}.${String(absolute%100n).padStart(2,'0')}`;}
export type RunRecord=Run&{taskSnapshot:CollectionTask|null;alertTaskSnapshots?:AlertTask[];mergedSchedules?:number};
export type AlertRunRecord=AlertRun&{taskSnapshot:AlertTask};
export class Store {
 db:DatabaseSync;
 private vault:Vault;
 private closed=false;
 constructor(filename:string,key:string){
  this.vault=new Vault(key);this.db=new DatabaseSync(filename);
  this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
   CREATE TABLE IF NOT EXISTS config(key TEXT PRIMARY KEY,payload TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS shops(id TEXT PRIMARY KEY,payload TEXT NOT NULL,credentials TEXT);
   CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,shop_id TEXT NOT NULL REFERENCES shops(id),payload TEXT NOT NULL,deleted INTEGER NOT NULL DEFAULT 0);
   CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,shop_id TEXT NOT NULL REFERENCES shops(id),task_id TEXT REFERENCES tasks(id),created_at TEXT NOT NULL,payload TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS latest(id TEXT PRIMARY KEY,shop_id TEXT NOT NULL REFERENCES shops(id),product_id TEXT NOT NULL,sku_id TEXT NOT NULL,run_id TEXT NOT NULL REFERENCES runs(id),payload TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS prices(run_id TEXT NOT NULL REFERENCES runs(id),id TEXT NOT NULL,shop_id TEXT NOT NULL REFERENCES shops(id),product_id TEXT NOT NULL,sku_id TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(run_id,id));
   CREATE INDEX IF NOT EXISTS prices_product ON prices(shop_id,product_id,sku_id);
   CREATE INDEX IF NOT EXISTS latest_product ON latest(shop_id,product_id,sku_id);
   CREATE TABLE IF NOT EXISTS annotations(shop_id TEXT NOT NULL REFERENCES shops(id),product_id TEXT NOT NULL,tags TEXT NOT NULL,note TEXT NOT NULL,PRIMARY KEY(shop_id,product_id));
   CREATE TABLE IF NOT EXISTS alerts(id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES runs(id),shop_id TEXT NOT NULL REFERENCES shops(id),product_id TEXT NOT NULL,sku_id TEXT NOT NULL,payload TEXT NOT NULL,UNIQUE(run_id,shop_id,product_id,sku_id));
   CREATE TABLE IF NOT EXISTS queries(id TEXT PRIMARY KEY,payload TEXT NOT NULL);
  `);
  migrateCollectionAlerts(this.db);
  migrateShopArchival(this.db);
  // The collection/alert migration rebuilds alerts. Install retention indexes on the final schema.
  this.db.exec(`CREATE INDEX IF NOT EXISTS latest_run ON latest(run_id);
   CREATE INDEX IF NOT EXISTS alerts_run ON alerts(run_id);`);
  initializeIncidents(this.db);
  this.db.exec('CREATE TABLE IF NOT EXISTS metadata(revision INTEGER NOT NULL); INSERT INTO metadata SELECT 0 WHERE NOT EXISTS(SELECT 1 FROM metadata)');
  for(const table of ['latest','prices','annotations','tasks','alert_tasks'])for(const action of ['INSERT','UPDATE','DELETE'])this.db.exec(`CREATE TRIGGER IF NOT EXISTS revision_${table}_${action} AFTER ${action} ON ${table} BEGIN UPDATE metadata SET revision=revision+1; END`);
  registerQueryFunctions(this.db);
 }
 close(){if(!this.closed){this.db.close();this.closed=true;}}
 saveShop(shop:Shop,credentials?:VerifiedAccount):void{
  const previous=this.getShop(shop.id);
  if(previous&&(previous.sellerId!==shop.sellerId||previous.platform!==shop.platform))throw Error('店铺身份不可更改');
  if(credentials&&(credentials.sellerId!==shop.sellerId||credentials.platform!==shop.platform))throw Error('凭据与店铺不匹配');
  // Saving live credentials onto an archived (removed) row would silently resurrect the account.
  if(previous?.archivedAt&&!credentials&&previous.hasCookies)throw Error('店铺已移除，请重新导入核验后再启用');
  // An explicit null means "restore this account": null must overwrite the stored marker instead
  // of falling back to it, otherwise a re-imported shop stays hidden from listShops() forever.
  const archivedAt=shop.archivedAt===undefined?previous?.archivedAt??null:shop.archivedAt;
  const safe:Shop={id:shop.id,name:shop.name,sellerId:shop.sellerId,platform:shop.platform,enabled:shop.enabled,sessionStatus:shop.sessionStatus,lastVerifiedAt:shop.lastVerifiedAt,lastError:shop.lastError,createdAt:shop.createdAt,updatedAt:shop.updatedAt,hasCookies:!!credentials||!!previous?.hasCookies,...(archivedAt===null&&previous?.archivedAt===undefined?{}:{archivedAt})};
  this.db.prepare('INSERT INTO shops(id,payload,credentials,credential_version,archived_at) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,credentials=coalesce(excluded.credentials,shops.credentials),credential_version=shops.credential_version+excluded.credential_version,archived_at=excluded.archived_at').run(shop.id,JSON.stringify(safe),credentials?this.vault.seal(credentials):null,credentials?1:0,archivedAt);
 }
 getShop(id:string):Shop|undefined{return this.readOne<Shop>('SELECT payload FROM shops WHERE id=?',id);}
 listShops():Shop[]{return this.readMany<Shop>("SELECT payload FROM shops WHERE archived_at IS NULL ORDER BY id");}
 listArchivedShops():Shop[]{return this.readMany<Shop>('SELECT payload FROM shops WHERE archived_at IS NOT NULL ORDER BY id');}
 /** Removing an account keeps its evidence but permanently destroys the stored credentials. */
 removeShop(id:string):void{
  const shop=this.getShop(id);
  if(!shop)throw Error('店铺不存在');
  if(shop.archivedAt)return;
  const at=new Date().toISOString();
  const archived:Shop={...shop,enabled:false,sessionStatus:'disabled',lastError:null,hasCookies:false,updatedAt:at,archivedAt:at};
  this.db.prepare('UPDATE shops SET payload=?,credentials=NULL,credential_version=credential_version+1,archived_at=? WHERE id=?').run(JSON.stringify(archived),at,id);
  // Archived rows are valid evidence owners but must never pass the live-account guards.
  for(const table of ['tasks','alert_tasks']){
   const rows=this.db.prepare(`SELECT id,payload FROM ${table} WHERE shop_id=? AND deleted=0`).all(id) as {id:string;payload:string}[];
   for(const row of rows){
    const payload=JSON.parse(row.payload) as {enabled:boolean;version:number};
    const updated=JSON.stringify({...payload,enabled:false,nextRunAt:null,updatedAt:at,version:payload.version+1});
    this.db.prepare(`UPDATE ${table} SET payload=? WHERE id=?`).run(updated,row.id);
   }
  }
 }
 getCredentials(id:string):VerifiedAccount{const record=this.db.prepare('SELECT credentials FROM shops WHERE id=?').get(id);if(!record?.credentials)throw Error('店铺未配置凭据');return this.vault.open<VerifiedAccount>(String(record.credentials));}
 getCredentialVersion(id:string):number{return Number(this.db.prepare('SELECT credential_version FROM shops WHERE id=?').get(id)?.credential_version||0);}
 setConfig(key:string,value:unknown):void{this.db.prepare('INSERT INTO config VALUES(?,?) ON CONFLICT(key) DO UPDATE SET payload=excluded.payload').run(key,JSON.stringify(value));}
 getConfig<T>(key:string,fallback:T):T{return this.readOne<T>('SELECT payload FROM config WHERE key=?',key)??fallback;}
 saveTask(task:CollectionTask):void{
  const shop=this.getShop(task.shopId);
  if(!shop)throw Error('店铺不存在');
  if(shop.archivedAt&&task.enabled)throw Error('店铺已移除，任务不可启用，请重新导入账号');
  const previous=this.readOne<CollectionTask>('SELECT payload FROM tasks WHERE id=?',task.id);
  if(previous&&previous.shopId!==task.shopId)throw Error('任务归属不可更改');
  const {id,shopId,name,enabled,scope,productIds,schedule,version,createdAt,updatedAt,nextRunAt}=task;
  this.db.prepare('INSERT INTO tasks(id,shop_id,payload) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(id,shopId,JSON.stringify({id,shopId,name,enabled,scope,productIds,schedule,version,createdAt,updatedAt,nextRunAt}));
 }
 getTask(id:string):CollectionTask|undefined{return this.readOne<CollectionTask>('SELECT payload FROM tasks WHERE id=? AND deleted=0',id);}
 listTasks():CollectionTask[]{return this.readMany<CollectionTask>('SELECT payload FROM tasks WHERE deleted=0 ORDER BY id');}
 deleteTask(id:string):void{this.transaction(()=>{for(const row of this.db.prepare('SELECT id FROM alert_tasks WHERE collection_task_id=?').all(id))supersedeTaskIncidents(this.db,String(row.id));this.db.prepare('UPDATE tasks SET deleted=1 WHERE id=?').run(id);this.db.prepare('UPDATE alert_tasks SET deleted=1 WHERE collection_task_id=?').run(id);});}
 saveAlertTask(task:AlertTask):void{
  const collection=this.getTask(task.collectionTaskId);
  if(!collection||collection.shopId!==task.shopId)throw Error('预警任务与采集任务店铺不匹配');
  const shop=this.getShop(task.shopId);
  if(shop?.archivedAt&&task.enabled)throw Error('店铺已移除，任务不可启用，请重新导入账号');
  const old=this.readOne<AlertTask>('SELECT payload FROM alert_tasks WHERE id=?',task.id);
  if(old&&(old.collectionTaskId!==task.collectionTaskId||old.shopId!==task.shopId))throw Error('预警任务归属不可更改');
  this.transaction(()=>{
   this.db.prepare('INSERT INTO alert_tasks(id,collection_task_id,shop_id,payload) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(task.id,task.collectionTaskId,task.shopId,JSON.stringify(task));
   supersedeTaskIncidents(this.db,task.id,task.rules);
  });
 }
 getAlertTask(id:string):AlertTask|undefined{return this.readOne<AlertTask>('SELECT payload FROM alert_tasks WHERE id=? AND deleted=0',id);}
 listAlertTasks():AlertTask[]{return this.readMany<AlertTask>('SELECT payload FROM alert_tasks WHERE deleted=0 ORDER BY id');}
 deleteAlertTask(id:string):void{this.transaction(()=>{supersedeTaskIncidents(this.db,id);this.db.prepare('UPDATE alert_tasks SET deleted=1 WHERE id=?').run(id);});}
 saveRun(run:RunRecord):void{
  if(!this.getShop(run.shopId))throw Error('店铺不存在');
  const task=run.taskId?this.readOne<CollectionTask>('SELECT payload FROM tasks WHERE id=?',run.taskId):undefined;
  if(run.taskId&&(!task||task.shopId!==run.shopId))throw Error('作业与任务店铺不匹配');
  if(run.taskSnapshot&&(run.taskSnapshot.shopId!==run.shopId||run.taskSnapshot.id!==run.taskId))throw Error('任务快照归属不匹配');
  if(run.parentRunId&&this.getRun(run.parentRunId)?.shopId!==run.shopId)throw Error('父作业归属不匹配');
  const old=this.getRun(run.id);
  if(old&&(old.shopId!==run.shopId||old.taskId!==run.taskId))throw Error('作业归属不可更改');
  if(old&&run.trigger!==undefined&&run.trigger!==old.trigger)throw Error('采集执行来源不可更改');
  const value:RunRecord={...run,trigger:old?.trigger||run.trigger||'legacy',alertDispatchStatus:run.alertDispatchStatus||old?.alertDispatchStatus||'not_applicable',createdAt:old?.createdAt||run.createdAt,taskSnapshot:old?old.taskSnapshot:run.taskSnapshot,alertTaskSnapshots:old?(old.alertTaskSnapshots||[]):(run.alertTaskSnapshots||[])};
  if(old&&['dispatched','skipped'].includes(old.alertDispatchStatus||'')&&value.alertDispatchStatus!==old.alertDispatchStatus)throw Error('预警派发状态不可回退');
  if(value.trigger!=='scheduled'&&(value.alertTaskSnapshots!.length||value.alertDispatchStatus!=='not_applicable'))throw Error('手动或旧版采集不能派发预警');
  for(const snapshot of value.alertTaskSnapshots!)if(snapshot.shopId!==run.shopId||snapshot.collectionTaskId!==run.taskId)throw Error('预警快照归属不匹配');
  if(old?.finishedAt&&['success','partial','failed'].includes(old.status)){
   for(const key of new Set([...Object.keys(old),...Object.keys(value)]))if(!['notificationStatus','alertDispatchStatus'].includes(key)&&JSON.stringify((old as unknown as Record<string,unknown>)[key])!==JSON.stringify((value as unknown as Record<string,unknown>)[key]))throw Error('已结束作业报告不可更改');
  }
  this.db.prepare('INSERT INTO runs VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(run.id,run.shopId,run.taskId,old?.createdAt||run.createdAt,JSON.stringify(value));
 }
 getRun(id:string):RunRecord|undefined{return this.readOne<RunRecord>('SELECT payload FROM runs WHERE id=?',id);}
 listRuns():RunRecord[]{return this.readMany<RunRecord>('SELECT payload FROM runs ORDER BY created_at DESC,id DESC LIMIT 200');}
 operationalRuns(statuses:RunStatus[]):RunRecord[]{return this.readMany<RunRecord>("SELECT payload FROM runs WHERE json_extract(payload,'$.status') IN(SELECT value FROM json_each(?)) ORDER BY created_at,id",JSON.stringify(statuses));}
 pendingAlertCollections():RunRecord[]{return this.readMany<RunRecord>("SELECT payload FROM runs WHERE json_extract(payload,'$.trigger')='scheduled' AND json_extract(payload,'$.alertDispatchStatus')='pending' AND json_extract(payload,'$.finishedAt') IS NOT NULL AND json_extract(payload,'$.status') IN('success','partial') AND shop_id NOT IN(SELECT id FROM shops WHERE archived_at IS NOT NULL) ORDER BY created_at,id");}
 saveAlertRun(run:AlertRunRecord):void{
  const source=this.getRun(run.collectionRunId);
  const task=this.readOne<AlertTask>('SELECT payload FROM alert_tasks WHERE id=?',run.alertTaskId);
  if(!source||source.trigger!=='scheduled'||!source.finishedAt||!['success','partial'].includes(source.status))throw Error('只有已完成的定时采集可以执行预警');
  if(!task||task.shopId!==run.shopId||source.shopId!==run.shopId||source.taskId!==task.collectionTaskId||run.taskSnapshot.id!==task.id||run.taskSnapshot.collectionTaskId!==source.taskId||run.taskSnapshot.shopId!==run.shopId)throw Error('预警执行归属不匹配');
  const old=this.getAlertRun(run.id);
  if(old&&(old.collectionRunId!==run.collectionRunId||old.alertTaskId!==run.alertTaskId))throw Error('预警执行归属不可更改');
  const value={...run,createdAt:old?.createdAt||run.createdAt,taskSnapshot:old?old.taskSnapshot:run.taskSnapshot};
  if(old?.finishedAt){for(const key of new Set([...Object.keys(old),...Object.keys(value)]))if(key!=='notificationStatus'&&JSON.stringify((old as any)[key])!==JSON.stringify((value as any)[key]))throw Error('已结束预警报告不可更改');}
  this.db.prepare('INSERT INTO alert_runs VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(run.id,run.collectionRunId,run.alertTaskId,value.createdAt,JSON.stringify(value));
 }
 getAlertRun(id:string):AlertRunRecord|undefined{return this.readOne<AlertRunRecord>('SELECT payload FROM alert_runs WHERE id=?',id);}
 listAlertRuns(filters:{collectionRunId?:string;alertTaskId?:string}={}):AlertRunRecord[]{
  const clauses:string[]=[],args:string[]=[];
  for(const [key,column] of [['collectionRunId','collection_run_id'],['alertTaskId','alert_task_id']] as const)if(filters[key]){clauses.push(`${column}=?`);args.push(filters[key]!);}
  return this.readMany<AlertRunRecord>(`SELECT payload FROM alert_runs ${clauses.length?'WHERE '+clauses.join(' AND '):''} ORDER BY created_at DESC,id DESC LIMIT 200`,...args);
 }
 operationalAlertRuns(statuses:AlertRun['status'][]):AlertRunRecord[]{return this.readMany<AlertRunRecord>("SELECT payload FROM alert_runs WHERE json_extract(payload,'$.status') IN(SELECT value FROM json_each(?)) ORDER BY created_at,id",JSON.stringify(statuses));}
 interruptedAlertNotifications():AlertRunRecord[]{return this.readMany<AlertRunRecord>("SELECT payload FROM alert_runs WHERE json_extract(payload,'$.notificationStatus')='sending'");}
 pendingAlertNotifications():AlertRunRecord[]{return this.readMany<AlertRunRecord>("SELECT payload FROM alert_runs WHERE json_extract(payload,'$.notificationStatus')='pending' AND json_extract(payload,'$.finishedAt') IS NOT NULL AND json_extract(payload,'$.status') IN('success','partial') ORDER BY created_at,id");}
 transaction<T>(fn:()=>T):T{
  if(this.db.isTransaction)return fn();this.db.exec('BEGIN IMMEDIATE');
  try{const value=fn();this.db.exec('COMMIT');return value;}catch(error){this.db.exec('ROLLBACK');throw error;}
 }
 saveProduct(runId:string,product:ProductCollection):number{
  const run=this.getRun(runId);if(!run)throw Error('作业不存在');const shop=this.getShop(run.shopId);if(!shop)throw Error('店铺不存在');
  if(run.finishedAt)throw Error('已结束作业快照不可更改');
  for(const row of product.rows){
   if(row.shopId!==run.shopId||row.productId!==product.productId)throw Error('采集结果店铺或商品归属不匹配');
   for(const field of ['backendPrice','before','after'] as const)if(row[field]!==null&&moneyCents(row[field])===null)throw Error('金额必须为安全整数分');
  }
  return this.transaction(()=>{
   let inserted=0;
   const complete=product.skuSetComplete===true&&!product.error&&product.rows.every(row=>row.status==='ok');
   if(complete){
    const priorProduct=this.readMany<PriceRow>('SELECT payload FROM prices WHERE run_id=? AND shop_id=? AND product_id=?',runId,run.shopId,product.productId);
    // An unfinished partial product is one replaceable snapshot. Refresh all its
    // SKUs together so a resumed authoritative result cannot retain stale success
    // evidence while losing current rows after another run changed the SKU set.
    if(priorProduct.some(row=>row.status!=='ok'||row.stale))inserted-=Number(this.db.prepare('DELETE FROM prices WHERE run_id=? AND shop_id=? AND product_id=?').run(runId,run.shopId,product.productId).changes);
   }
   const existing=this.readMany<PriceRow>('SELECT payload FROM latest WHERE shop_id=? AND product_id=?',run.shopId,product.productId);
   const existingById=new Map(existing.map(row=>[row.id,row]));
   const sources=[...product.rows];
   if(product.error){for(const old of existing)if(!sources.some(r=>rowKey(r)===old.id))sources.push({...old,status:'stale',error:product.error});}
   if(!sources.length&&product.error)sources.push({shopId:run.shopId,productId:product.productId,skuId:'',title:product.title,specs:'',seatSpec:'',color:'',backendPrice:null,before:null,after:null,backendVerified:false,status:'error',error:product.error,sourceUrl:'',backendSource:'',detailFetchedAt:null,backendFetchedAt:null,stock:null});
   // Legacy collectors without an authoritative set can still replace a failed placeholder.
   if(!run.finishedAt&&!product.error&&sources.length&&sources.every(row=>row.status==='ok')){
    inserted-=Number(this.db.prepare("DELETE FROM prices WHERE run_id=? AND shop_id=? AND product_id=? AND sku_id='' AND json_extract(payload,'$.status')!='ok'").run(runId,run.shopId,product.productId).changes);
    this.db.prepare("DELETE FROM latest WHERE shop_id=? AND product_id=? AND sku_id='' AND json_extract(payload,'$.status')!='ok'").run(run.shopId,product.productId);
   }
   for(let source of sources){
    const id=rowKey(source),priorRow=this.readOne<PriceRow>('SELECT payload FROM prices WHERE run_id=? AND id=?',runId,id);
    if(priorRow&&(run.finishedAt||priorRow.status==='ok'&&!priorRow.stale||source.status!=='ok'||!!product.error))continue;
    if(run.finishedAt)throw Error('已结束作业快照不可更改');
    const old=existingById.get(id);
    const stale=source.status==='stale'||!!old&&((source.after===null&&old.after!==null)||(source.backendPrice===null&&old.backendPrice!==null));
    if(stale&&old)source={...source,backendPrice:source.backendPrice??old.backendPrice,before:source.before??old.before,after:source.after??old.after,detailFetchedAt:source.detailFetchedAt??old.detailFetchedAt,backendFetchedAt:source.backendFetchedAt??old.backendFetchedAt,status:'stale',error:source.error||product.error};
    const backendPrice=moneyText(moneyCents(source.backendPrice)),before=moneyText(moneyCents(source.before)),after=moneyText(moneyCents(source.after));
    const base=moneyCents(backendPrice),current=moneyCents(after),prior=moneyCents(before);
    const row:PriceRow={...source,backendPrice,before,after,id,runId,shopName:shop.name,discount:source.backendVerified&&!stale?formatDiscount(backendPrice,after):null,saving:source.backendVerified&&base!==null&&current!==null?moneyText(base-current):null,priceDifference:source.backendVerified&&base!==null&&prior!==null?moneyText(prior-base):null,updatedAt:new Date().toISOString(),tags:[],note:'',stale};
    const payload=JSON.stringify(row);this.db.prepare('INSERT INTO prices VALUES(?,?,?,?,?,?) ON CONFLICT(run_id,id) DO UPDATE SET payload=excluded.payload').run(runId,id,run.shopId,row.productId,row.skuId,payload);
    if(!priorRow)inserted++;
    this.db.prepare('INSERT INTO latest VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET run_id=excluded.run_id,payload=excluded.payload').run(id,run.shopId,row.productId,row.skuId,runId,payload);
   }
   // Absence is meaningful only when the collector explicitly verified the whole
   // SKU set. Failed/partial responses must never remove known current prices.
   if(complete){
    this.db.prepare('DELETE FROM latest WHERE shop_id=? AND product_id=? AND id NOT IN(SELECT value FROM json_each(?))').run(run.shopId,product.productId,JSON.stringify(product.rows.map(rowKey)));
   }
   return inserted;
  });
 }
 countRunPrices(runId:string):number{return Number(this.db.prepare('SELECT count(*) n FROM prices WHERE run_id=?').get(runId)?.n||0);}
 getRunPrices(runId:string):PriceRow[]{return this.readMany<PriceRow>('SELECT payload FROM prices WHERE run_id=? ORDER BY shop_id,product_id,sku_id',runId);}
 history(shopId:string,productId:string,skuId?:string):PriceRow[]{return this.readMany<PriceRow>(`SELECT p.payload FROM prices p JOIN runs r ON r.id=p.run_id WHERE p.shop_id=? AND p.product_id=? ${skuId===undefined?'':'AND p.sku_id=?'} ORDER BY r.created_at DESC,p.run_id DESC,p.sku_id LIMIT 1000`,...([shopId,productId,...(skuId===undefined?[]:[skuId])]));}
 saveAlert(alert:Alert):void{
  const run=this.getRun(alert.runId);
  const evaluation=alert.alertRunId?this.getAlertRun(alert.alertRunId):undefined;
  if(!run||run.shopId!==alert.shopId)throw Error('预警归属不匹配');
  if(alert.alertRunId){if(!evaluation||evaluation.collectionRunId!==run.id||evaluation.alertTaskId!==alert.taskId||evaluation.shopId!==alert.shopId||evaluation.finishedAt||alert.ruleVersion!==evaluation.ruleVersion)throw Error('预警执行归属不匹配');}
  else if(run.trigger!=='legacy'||run.taskId!==alert.taskId)throw Error('预警必须属于独立的定时预警执行');
  if(!this.db.prepare('SELECT 1 FROM prices WHERE run_id=? AND shop_id=? AND product_id=? AND sku_id=?').get(alert.runId,alert.shopId,alert.productId,alert.skuId))throw Error('预警价格证据不存在');
  this.db.prepare('INSERT OR IGNORE INTO alerts VALUES(?,?,?,?,?,?,?)').run(alert.id,alert.runId,alert.shopId,alert.productId,alert.skuId,JSON.stringify(alert),alert.alertRunId||null);
 }
 listAlerts(filters:{state?:string;shopId?:string;runId?:string;alertRunId?:string;legacyOnly?:boolean}={}):Alert[]{
  const conditions:string[]=[],args:string[]=[];
  if(filters.legacyOnly)conditions.push("json_extract(payload,'$.incidentId') IS NULL");
  for(const [key,column] of [['state',"json_extract(payload,'$.state')"],['shopId','shop_id'],['runId','run_id'],['alertRunId','alert_run_id']] as const)if(filters[key]){conditions.push(`${column}=?`);args.push(filters[key]!);}
  return this.readMany<Alert>(`SELECT payload FROM alerts ${conditions.length?'WHERE '+conditions.join(' AND '):''} ORDER BY json_extract(payload,'$.createdAt') DESC,id DESC LIMIT 1000`,...args);
 }
 getAlert(id:string):Alert|undefined{return this.readOne<Alert>('SELECT payload FROM alerts WHERE id=?',id);}
 updateAlert(id:string,patch:Partial<Pick<Alert,'state'|'note'>>):Alert{
  if(Object.keys(patch).some(key=>!['state','note'].includes(key)))throw Error('只允许更新预警状态和备注');
  if(patch.state&&!['pending','confirmed','resolved'].includes(patch.state))throw Error('无效预警状态');
  const old=this.getAlert(id);if(!old)throw Error('预警不存在');if(old.incidentId)throw Error('请在异常事件中更新处理状态，检查证据不可改写');const alert={...old,...patch};
  if(patch.state==='resolved'&&old.state!=='resolved')alert.resolvedAt=new Date().toISOString();
  else if(patch.state&&patch.state!=='resolved')delete alert.resolvedAt;
  this.db.prepare('UPDATE alerts SET payload=? WHERE id=?').run(JSON.stringify(alert),id);return alert;
 }
 annotate(shopId:string,productIds:string[],tags?:string[],note?:string):number{
  if(!this.getShop(shopId))throw Error('店铺不存在');
  return this.transaction(()=>{let count=0;for(const productId of new Set(productIds)){
   if(!this.db.prepare('SELECT 1 FROM latest WHERE shop_id=? AND product_id=?').get(shopId,productId))continue;
   const old=this.db.prepare('SELECT tags,note FROM annotations WHERE shop_id=? AND product_id=?').get(shopId,productId);
   this.db.prepare('INSERT INTO annotations VALUES(?,?,?,?) ON CONFLICT(shop_id,product_id) DO UPDATE SET tags=excluded.tags,note=excluded.note').run(shopId,productId,tags===undefined?String(old?.tags||'[]'):JSON.stringify([...new Set(tags)]),note??String(old?.note||''));count++;
  }return count;});
 }
 saveQuery(name:string,query:QueryInput):{id:string;name:string;query:QueryInput}{const value={id:randomUUID(),name,query};this.db.prepare('INSERT INTO queries VALUES(?,?)').run(value.id,JSON.stringify(value));return value;}
 listQueries():{id:string;name:string;query:QueryInput}[]{return this.readMany('SELECT payload FROM queries ORDER BY id');}
 deleteQuery(id:string):void{this.db.prepare('DELETE FROM queries WHERE id=?').run(id);}
 compare(leftRunId:string,rightRunId:string):object[]{
  const left=this.getRun(leftRunId),right=this.getRun(rightRunId);if(!left?.finishedAt||!right?.finishedAt)throw Error('仅能比较已结束作业');
  const a=new Map(this.getRunPrices(leftRunId).map(row=>[row.id,row])),b=new Map(this.getRunPrices(rightRunId).map(row=>[row.id,row]));
  return [...new Set([...a.keys(),...b.keys()])].sort().map(id=>{const l=a.get(id),r=b.get(id),row=(r||l)!;return {id,shopId:row.shopId,productId:row.productId,skuId:row.skuId,left:l??null,right:r??null};});
 }
 cleanup(before:string):number{
  if(!Number.isFinite(Date.parse(before)))throw Error('无效清理时间');
  return this.transaction(()=>{
   const hasReceipts=!!this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='collection_submissions' AND type='table'").get();
   const protectedReceipts=hasReceipts?' AND id NOT IN(SELECT run_id FROM collection_submissions WHERE submitted_at>?)':'';
   const args=hasReceipts?[before,Date.now()-COLLECTION_SUBMISSION_TTL_MS]:[before];
   const eligible=`SELECT id FROM runs r WHERE json_extract(payload,'$.finishedAt') IS NOT NULL AND julianday(json_extract(payload,'$.finishedAt'))<julianday(?) AND coalesce(json_extract(payload,'$.alertDispatchStatus'),'not_applicable')!='pending' AND id NOT IN(SELECT run_id FROM alerts) AND id NOT IN(SELECT collection_run_id FROM alert_runs)${protectedReceipts} ${unfinishedRetryParentGuard('r')}`;
   const prices=this.db.prepare(`DELETE FROM prices WHERE run_id IN(${eligible})`).run(...args);
   const runs=this.db.prepare(`DELETE FROM runs WHERE id IN(${eligible}) AND id NOT IN(SELECT run_id FROM latest)`).run(...args);
   return Number(prices.changes)+Number(runs.changes);
  });
 }
 overview():Overview{
  const scalar=(sql:string)=>Number(this.db.prepare(sql).get()?.n||0);
  return {shops:scalar('SELECT count(*) n FROM shops WHERE archived_at IS NULL'),tasks:scalar('SELECT count(*) n FROM tasks WHERE deleted=0'),alertTasks:scalar('SELECT count(*) n FROM alert_tasks WHERE deleted=0'),products:scalar('SELECT count(*) n FROM(SELECT 1 FROM latest GROUP BY shop_id,product_id)'),skus:scalar('SELECT count(*) n FROM latest'),pendingAlerts:scalar("SELECT (SELECT count(*) FROM alert_incidents WHERE json_extract(payload,'$.state')='pending') + (SELECT count(*) FROM alerts WHERE json_extract(payload,'$.state')='pending' AND json_extract(payload,'$.incidentId') IS NULL) n"),running:scalar("SELECT count(*) n FROM runs WHERE json_extract(payload,'$.status') IN('queued','running')"),failedRows:scalar("SELECT count(*) n FROM latest WHERE json_extract(payload,'$.stale')=1 OR json_extract(payload,'$.status')!='ok'"),recentRuns:this.listRuns().slice(0,10).map(({taskSnapshot:_,alertTaskSnapshots:__,...run})=>run)};
 }
 backup(destination:string):Promise<void>{return backupDatabase(this.db,destination);}
 query(input:QueryInput):QueryResult{return queryStore(this,input);}
 queryAll(input:QueryInput):(PriceRow|ProductRow)[]{return queryAllStore(this,input);}
 private readOne<T>(sql:string,...args:string[]):T|undefined{const record=this.db.prepare(sql).get(...args);return record?JSON.parse(String(record.payload)) as T:undefined;}
 private readMany<T>(sql:string,...args:string[]):T[]{return this.db.prepare(sql).all(...args).map(record=>JSON.parse(String(record.payload)) as T);}
}
