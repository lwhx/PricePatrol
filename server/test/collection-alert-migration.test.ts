import {afterEach,describe,expect,it,vi} from 'vitest';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store,type RunRecord} from '../src/database.js';
import {AlertWorker} from '../src/alert-worker.js';
import {migrateCollectionAlerts} from '../src/migrations.js';
import {Vault} from '../src/security.js';
import type {Alert,AlertTask,MonitorTask,PriceRow,Shop,VerifiedAccount} from '../../shared/contracts.js';

const KEY='migration-fixture-encryption-key-more-than-thirty-two-characters';
const at='2026-01-01T00:00:00.000Z',finished='2026-01-01T01:00:00.000Z';
const shop:Shop={id:'s',name:'原有店铺',sellerId:'seller',platform:'tmall',enabled:true,sessionStatus:'valid',lastVerifiedAt:at,lastError:null,createdAt:at,updatedAt:at,hasCookies:true};
const credentials:VerifiedAccount={sellerId:'seller',shopName:'原有店铺',platform:'tmall',cookies:[{name:'session',value:'migration-fixture-private-cookie',domain:'.tmall.com'}],userAgent:'fixture',appKey:'fixture'};
const task:MonitorTask={id:'t',shopId:'s',name:'原定时监控',enabled:true,scope:'selected',productIds:['1000001'],schedule:{kind:'daily',time:'09:30',days:[],timezone:'Asia/Shanghai'},rules:[{mode:'all',conditions:[{field:'discount',op:'lt',value:'8.5'}]}],whitelist:{productIds:['1000002'],titleKeywords:['不预警']},notify:true,version:7,createdAt:at,updatedAt:finished,nextRunAt:'2026-01-02T01:30:00.000Z'};
const legacyRun:RunRecord={id:'old-run',taskId:'t',shopId:'s',taskName:task.name,shopName:shop.name,status:'success',scope:'selected',productIds:['1000001'],expected:1,processed:1,failed:0,rows:1,checked:1,excluded:0,matched:1,unknown:0,message:'旧版采集完成',createdAt:at,startedAt:at,finishedAt:finished,parentRunId:null,failedProductIds:[],notificationStatus:'accepted',taskSnapshot:task};
const price:PriceRow={id:'s:1000001:2000001',runId:'old-run',shopId:'s',shopName:shop.name,productId:'1000001',skuId:'2000001',title:'沙发',specs:'三人位',seatSpec:'三人位',color:'白',backendPrice:'100.00',before:'100.00',after:'80.00',backendVerified:true,status:'ok',sourceUrl:'https://detail.tmall.com/item.htm?id=1000001',backendSource:'fixture',detailFetchedAt:at,backendFetchedAt:at,stock:2,discount:'8.0000',saving:'20.00',priceDifference:'0.00',updatedAt:at,tags:[],note:'',stale:false};
const legacyAlert:Alert={id:'old-alert',runId:legacyRun.id,taskId:task.id,shopId:shop.id,shopName:shop.name,productId:price.productId,skuId:price.skuId,title:price.title,specs:price.specs,backendPrice:price.backendPrice,before:price.before,after:price.after,discount:price.discount,reasons:['原规则命中'],state:'confirmed',note:'保留原人工确认',createdAt:finished};

const directories:string[]=[],stores:Store[]=[],workers:AlertWorker[]=[],connections:DatabaseSync[]=[];
afterEach(async()=>{
 for(const worker of workers.splice(0))await worker.close();
 for(const store of stores.splice(0))store.close();
 for(const db of connections.splice(0))db.close();
 for(const directory of directories.splice(0))rmSync(directory,{recursive:true,force:true});
});
function legacyFile(){
 const directory=mkdtempSync(join(tmpdir(),'pricepatrol-migration-'));directories.push(directory);
 const filename=join(directory,'prices.sqlite');const db=new DatabaseSync(filename);
 // This is the persisted pre-split schema, including its inline alert uniqueness rule.
 db.exec(`PRAGMA foreign_keys=ON;
  CREATE TABLE config(key TEXT PRIMARY KEY,payload TEXT NOT NULL);
  CREATE TABLE shops(id TEXT PRIMARY KEY,payload TEXT NOT NULL,credentials TEXT);
  CREATE TABLE tasks(id TEXT PRIMARY KEY,shop_id TEXT NOT NULL REFERENCES shops(id),payload TEXT NOT NULL,deleted INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE runs(id TEXT PRIMARY KEY,shop_id TEXT NOT NULL REFERENCES shops(id),task_id TEXT REFERENCES tasks(id),created_at TEXT NOT NULL,payload TEXT NOT NULL);
  CREATE TABLE latest(id TEXT PRIMARY KEY,shop_id TEXT NOT NULL REFERENCES shops(id),product_id TEXT NOT NULL,sku_id TEXT NOT NULL,run_id TEXT NOT NULL REFERENCES runs(id),payload TEXT NOT NULL);
  CREATE TABLE prices(run_id TEXT NOT NULL REFERENCES runs(id),id TEXT NOT NULL,shop_id TEXT NOT NULL REFERENCES shops(id),product_id TEXT NOT NULL,sku_id TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(run_id,id));
  CREATE TABLE alerts(id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES runs(id),shop_id TEXT NOT NULL REFERENCES shops(id),product_id TEXT NOT NULL,sku_id TEXT NOT NULL,payload TEXT NOT NULL,UNIQUE(run_id,shop_id,product_id,sku_id));
  CREATE TABLE annotations(shop_id TEXT NOT NULL REFERENCES shops(id),product_id TEXT NOT NULL,tags TEXT NOT NULL,note TEXT NOT NULL,PRIMARY KEY(shop_id,product_id));
  CREATE TABLE queries(id TEXT PRIMARY KEY,payload TEXT NOT NULL);
  CREATE TABLE metadata(revision INTEGER NOT NULL);
  INSERT INTO metadata VALUES(42);
  CREATE TRIGGER revision_tasks_UPDATE AFTER UPDATE ON tasks BEGIN UPDATE metadata SET revision=revision+1; END;
 `);
 db.prepare('INSERT INTO config VALUES(?,?)').run('preserved-settings',JSON.stringify({enabled:true,theme:'dark'}));
 db.prepare('INSERT INTO shops VALUES(?,?,?)').run(shop.id,JSON.stringify(shop),new Vault(KEY).seal(credentials));
 db.prepare('INSERT INTO tasks VALUES(?,?,?,?)').run(task.id,shop.id,JSON.stringify(task),0);
 const deleted={...task,id:'deleted-task',name:'历史已删除任务'};
 db.prepare('INSERT INTO tasks VALUES(?,?,?,?)').run(deleted.id,shop.id,JSON.stringify(deleted),1);
 for(const value of [legacyRun,{...legacyRun,id:'deleted-task-run',taskId:deleted.id,taskName:deleted.name,taskSnapshot:deleted}])db.prepare('INSERT INTO runs VALUES(?,?,?,?,?)').run(value.id,shop.id,value.taskId,value.createdAt,JSON.stringify(value));
 db.prepare('INSERT INTO prices VALUES(?,?,?,?,?,?)').run(price.runId,price.id,price.shopId,price.productId,price.skuId,JSON.stringify(price));
 db.prepare('INSERT INTO latest VALUES(?,?,?,?,?,?)').run(price.id,price.shopId,price.productId,price.skuId,price.runId,JSON.stringify(price));
 db.prepare('INSERT INTO alerts VALUES(?,?,?,?,?,?)').run(legacyAlert.id,legacyAlert.runId,legacyAlert.shopId,legacyAlert.productId,legacyAlert.skuId,JSON.stringify(legacyAlert));
 db.close();return filename;
}
function open(filename:string){const store=new Store(filename,KEY);stores.push(store);return store;}
function worker(store:Store){const notify=vi.fn(async()=>{});const instance=new AlertWorker(store,notify);workers.push(instance);return {instance,notify};}
function scheduledSource(store:Store,id:string,tasks:AlertTask[],after='80.00'){
 const source:RunRecord={...legacyRun,id,taskSnapshot:store.getTask(task.id)!,trigger:'scheduled',alertDispatchStatus:'pending',alertTaskSnapshots:tasks,status:'running',finishedAt:null,rows:0,checked:0,matched:0,notificationStatus:'disabled'};
 store.saveRun(source);store.saveProduct(id,{productId:price.productId,title:price.title,rows:[{...price,after}]});
 store.saveRun({...source,status:'success',rows:1,finishedAt:finished});
}

describe('collection and alert migration on existing SQLite files',()=>{
 it('splits configuration while preserving encrypted accounts and all historical evidence without replay',async()=>{
  const store=open(legacyFile());
  const {rules,whitelist,notify,...collection}=task;
  expect(store.getTask(task.id)).toEqual(collection);
  expect(store.getAlertTask(task.id)).toEqual({id:task.id,collectionTaskId:task.id,shopId:task.shopId,name:task.name,enabled:task.enabled,scope:task.scope,productIds:task.productIds,rules,whitelist,notify,version:task.version,createdAt:task.createdAt,updatedAt:task.updatedAt});
  expect(store.getCredentials(shop.id)).toEqual(credentials);
  expect(store.getConfig('preserved-settings',null)).toEqual({enabled:true,theme:'dark'});
  expect(store.getRun(legacyRun.id)).toEqual({...legacyRun,trigger:'legacy',alertDispatchStatus:'not_applicable',alertTaskSnapshots:[]});
  expect(store.getRunPrices(legacyRun.id)).toEqual([price]);
  expect(store.getAlert(legacyAlert.id)).toEqual(legacyAlert);
  expect(store.query({runId:legacyRun.id,taskId:task.id}).rows).toEqual([price]);
  const {instance,notify:send}=worker(store);instance.recover();instance.enqueueForCollection(legacyRun.id);await instance.whenIdle();
  expect(store.listAlertRuns()).toEqual([]);expect(store.listAlerts()).toEqual([legacyAlert]);expect(send).not.toHaveBeenCalled();
  expect(store.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
 });

 it('preserves prior deletions and never recreates removed or edited alert tasks on reopen',()=>{
  const filename=legacyFile();const first=open(filename);
  expect(first.getTask('deleted-task')).toBeUndefined();expect(first.getAlertTask('deleted-task')).toBeUndefined();
  expect(first.db.prepare('SELECT deleted FROM alert_tasks WHERE id=?').get('deleted-task')?.deleted).toBe(1);
  expect(first.getRun('deleted-task-run')?.taskSnapshot?.name).toBe('历史已删除任务');
  const renamed={...first.getTask(task.id)!,name:'拆分后修改名称'};first.saveTask(renamed);first.deleteAlertTask(task.id);first.close();
  const reopened=open(filename);
  expect(reopened.getTask(task.id)?.name).toBe(renamed.name);expect(reopened.listAlertTasks()).toEqual([]);
  expect(reopened.getRun(legacyRun.id)?.taskSnapshot).toEqual(task);
  expect(reopened.getAlert(legacyAlert.id)).toEqual(legacyAlert);
  expect(reopened.db.prepare('SELECT count(*) AS count FROM alert_tasks').get()?.count).toBe(2);
 });

 it('permits multiple alert tasks to independently flag one SKU in a single scheduled batch',async()=>{
  const store=open(legacyFile()),first=store.getAlertTask(task.id)!;
  const second={...first,id:'second-alert',name:'第二套规则'};store.saveAlertTask(second);
  scheduledSource(store,'new-source',[first,second]);
  const {instance}=worker(store);instance.enqueueForCollection('new-source');await instance.whenIdle();
  instance.enqueueForCollection('new-source');instance.recover();await instance.whenIdle();
  const alerts=store.listAlerts({runId:'new-source'});
  expect(alerts).toHaveLength(2);expect(new Set(alerts.map(value=>value.taskId))).toEqual(new Set([first.id,second.id]));
  expect(store.listAlertRuns({collectionRunId:'new-source'})).toHaveLength(2);
  expect(alerts.every(value=>value.productId===price.productId&&value.skuId===price.skuId)).toBe(true);
  store.updateAlert(alerts[0]!.id,{state:'resolved',note:'仅处理此规则'});
  expect(store.getAlert(alerts[1]!.id)?.state).toBe('pending');
  expect(store.getAlert(legacyAlert.id)).toEqual(legacyAlert);
 });

 it('keeps the source evidence of a completed zero-match evaluation during history cleanup',async()=>{
  const store=open(legacyFile()),alertTask=store.getAlertTask(task.id)!;
  scheduledSource(store,'zero-match-source',[alertTask],'100.00');
  const {instance}=worker(store);instance.enqueueForCollection('zero-match-source');await instance.whenIdle();
  expect(store.listAlerts({runId:'zero-match-source'})).toHaveLength(0);
  expect(store.listAlertRuns({collectionRunId:'zero-match-source'})[0]).toMatchObject({status:'success',matched:0,checked:1});
  store.cleanup('2027-01-01T00:00:00.000Z');
  expect(store.getRunPrices('zero-match-source')).toHaveLength(1);
  expect(store.getRun('zero-match-source')).toBeDefined();
 });

 it('rolls back schema and data together when a migration write fails, then can retry safely',()=>{
  const filename=legacyFile(),db=new DatabaseSync(filename);connections.push(db);
  db.exec("PRAGMA foreign_keys=ON; CREATE TRIGGER fail_migration BEFORE UPDATE ON tasks BEGIN SELECT RAISE(ABORT,'fixture write failure'); END;");
  expect(()=>migrateCollectionAlerts(db)).toThrow('fixture write failure');
  expect(db.isTransaction).toBe(false);
  expect(JSON.parse(String(db.prepare('SELECT payload FROM tasks WHERE id=?').get(task.id)?.payload))).toEqual(task);
  expect(JSON.parse(String(db.prepare('SELECT payload FROM runs WHERE id=?').get(legacyRun.id)?.payload))).toEqual(legacyRun);
  expect(JSON.parse(String(db.prepare('SELECT payload FROM alerts WHERE id=?').get(legacyAlert.id)?.payload))).toEqual(legacyAlert);
  expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN('alert_tasks','alert_runs','alerts_split')").all()).toEqual([]);
  expect(db.prepare('PRAGMA table_info(shops)').all().map(value=>value.name)).not.toContain('credential_version');
  expect(db.prepare("SELECT payload FROM config WHERE key='schema.collection-alerts'").get()).toBeUndefined();
  expect(()=>db.prepare('INSERT INTO alerts VALUES(?,?,?,?,?,?)').run('duplicate-old-alert',legacyAlert.runId,legacyAlert.shopId,legacyAlert.productId,legacyAlert.skuId,JSON.stringify(legacyAlert))).toThrow(/UNIQUE/);
  expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  db.exec('DROP TRIGGER fail_migration');db.close();connections.splice(connections.indexOf(db),1);
  const store=open(filename);expect(store.getAlertTask(task.id)?.rules).toEqual(task.rules);expect(store.getRunPrices(legacyRun.id)).toEqual([price]);
 });
});
