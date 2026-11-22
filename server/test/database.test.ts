import {afterEach,describe,expect,it} from 'vitest';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store,type RunRecord} from '../src/database.js';
import type {Shop,MonitorTask,CollectedRow,VerifiedAccount} from '../../shared/contracts.js';
export const KEY='repository-test-key-at-least-thirty-two-characters';
export const shop=(id='s1'):Shop=>({id,name:id,sellerId:`seller-${id}`,platform:'tmall',enabled:true,sessionStatus:'valid',lastVerifiedAt:null,lastError:null,createdAt:'2026-01-01T00:00:00Z',updatedAt:'2026-01-01T00:00:00Z',hasCookies:false});
export const task=(id='t1',shopId='s1'):MonitorTask=>({id,shopId,name:id,enabled:true,scope:'all',productIds:[],rules:[],whitelist:{productIds:[],titleKeywords:[]},schedule:{kind:'manual',time:'09:00',days:[],timezone:'Asia/Shanghai'},notify:false,version:1,createdAt:'2026-01-01T00:00:00Z',updatedAt:'2026-01-01T00:00:00Z',nextRunAt:null});
export const run=(id='r1',shopId='s1',taskId:string|null='t1'):RunRecord=>({id,shopId,taskId,taskName:taskId||'',shopName:shopId,status:'running',scope:'all',productIds:[],expected:0,processed:0,failed:0,rows:0,checked:0,excluded:0,matched:0,unknown:0,message:'',createdAt:'2026-01-01T00:00:00Z',startedAt:'2026-01-01T00:00:00Z',finishedAt:null,parentRunId:null,failedProductIds:[],notificationStatus:'pending',taskSnapshot:taskId?task(taskId,shopId):null});
export const row=(productId='1000001',skuId='2000001',patch:Partial<CollectedRow>={}):CollectedRow=>({shopId:'s1',productId,skuId,title:'沙发',specs:'三人位 米白',seatSpec:'三人位',color:'米白',backendPrice:'100.00',before:'100.00',after:'85.00',backendVerified:true,status:'ok',sourceUrl:`https://detail.tmall.com/item.htm?id=${productId}`,backendSource:'seller',detailFetchedAt:'2026-01-01T00:00:00Z',backendFetchedAt:'2026-01-01T00:00:00Z',stock:3,...patch});
export function seed(store:Store){store.saveShop(shop());store.saveTask(task());store.saveRun(run());}
const paths:string[]=[];const stores:Store[]=[];
afterEach(()=>{for(const s of stores.splice(0))s.close();for(const p of paths.splice(0))rmSync(p,{recursive:true,force:true});});
const file=()=>{const p=mkdtempSync(join(process.env.TMPDIR||tmpdir(),'price-repository-'));paths.push(p);return join(p,'prices.sqlite');};
const open=(path=':memory:')=>{const s=new Store(path,KEY);stores.push(s);return s;};
describe('SQLite repository',()=>{
 it('freezes ended run reports while allowing independent notification delivery state',()=>{
  const s=open();seed(s);const ended={...run(),status:'success' as const,processed:2,finishedAt:'2026-01-01T01:00:00Z'};s.saveRun(ended);
  expect(()=>s.saveRun({...ended,status:'running',finishedAt:null,processed:0})).toThrow();
  s.saveRun({...ended,notificationStatus:'sent'});expect(s.getRun('r1')).toMatchObject({status:'success',processed:2,notificationStatus:'sent'});
 });
 it('preserves every cent near the safe-integer boundary and rejects fractional cents atomically',()=>{
  const s=open();seed(s);const amount='90071992547409.90';s.saveProduct('r1',{productId:'1000001',title:'',rows:[row('1000001','a',{backendPrice:amount,before:amount,after:amount})]});
  expect(s.getRunPrices('r1')[0].after).toBe(amount);
  expect(()=>s.saveProduct('r1',{productId:'1000002',title:'',rows:[row('1000002','a'),row('1000002','b',{after:'0.001'})]})).toThrow();expect(s.history('s1','1000002')).toEqual([]);
 });
 it('soft deletes tasks and protects alert evidence during cleanup and consistent backup',async()=>{
  const path=file();const s=open(path);seed(s);s.saveProduct('r1',{productId:'1000001',title:'沙发',rows:[row()]});
  const price=s.getRunPrices('r1')[0];const alert={id:'a1',runId:'r1',taskId:'t1',shopId:'s1',shopName:'s1',productId:price.productId,skuId:price.skuId,title:price.title,specs:price.specs,backendPrice:price.backendPrice,before:price.before,after:price.after,discount:price.discount,reasons:['低折扣'],state:'pending' as const,note:'',createdAt:'2026-01-01T00:00:00Z'};
  s.saveAlert(alert);s.saveAlert({...alert,id:'a2'});expect(s.listAlerts()).toHaveLength(1);expect(s.updateAlert('a1',{state:'confirmed',note:'已核验'}).state).toBe('confirmed');expect(s.getAlert('a1')?.note).toBe('已核验');
  expect(()=>s.saveAlert({...alert,id:'invalid',shopId:'missing'})).toThrow();expect(()=>s.updateAlert('a1',{runId:'fake'} as never)).toThrow();
  expect(s.annotate('s1',[price.productId],['重点'],'备注')).toBe(1);
  const saved=s.saveQuery('低折扣',{view:'sku'});expect(s.listQueries()).toEqual([saved]);s.deleteQuery(saved.id);expect(s.listQueries()).toEqual([]);
  s.saveRun({...run(),status:'success',finishedAt:'2026-01-01T01:00:00Z'});s.saveRun(run('r2'));s.saveProduct('r2',{productId:'1000001',title:'',rows:[row('1000001','2000001',{after:'80'})]});s.saveRun({...run('r2'),status:'success',finishedAt:'2026-01-02T01:00:00Z'});
  expect(s.compare('r1','r2')[0]).toMatchObject({shopId:'s1',productId:'1000001',skuId:'2000001'});
  s.deleteTask('t1');expect(s.getTask('t1')).toBeUndefined();expect(s.listTasks()).toEqual([]);expect(s.getRun('r1')?.taskSnapshot?.id).toBe('t1');
  expect(s.cleanup('2027-01-01T00:00:00Z')).toBeGreaterThan(0);expect(s.getRunPrices('r1')).toHaveLength(1);expect(s.getRun('r1')).toBeDefined();expect(s.getRunPrices('r2')).toEqual([]);
  expect(s.overview()).toMatchObject({shops:1,tasks:0,products:1,skus:1});
  const backup=join(path,'..','backup.sqlite');await s.backup(backup);const restored=open(backup);expect(restored.getAlert('a1')?.note).toBe('已核验');expect(restored.getRunPrices('r1')).toHaveLength(1);expect(restored.db.prepare('PRAGMA quick_check').get()?.quick_check).toBe('ok');
 });
 it('keeps historical evidence while failed retries retain stale last-success prices',()=>{
  const s=open();seed(s);s.saveProduct('r1',{productId:'1000001',title:'沙发',rows:[row(),row('1000001','missing')]});
  s.saveRun({...run(),status:'success',finishedAt:'2026-01-01T01:00:00Z'});
  s.saveRun({...run('r2'),parentRunId:'r1'});s.saveProduct('r2',{productId:'1000001',title:'沙发',error:'详情失败',rows:[row('1000001','2000001',{after:null,status:'partial',error:'详情失败',detailFetchedAt:null})]});
  const failed=s.getRunPrices('r2');expect(failed).toHaveLength(2);expect(failed.every(r=>r.stale&&r.after==='85.00')).toBe(true);expect(failed.every(r=>r.error==='详情失败')).toBe(true);
  expect(s.getRunPrices('r1').every(r=>!r.stale&&r.status==='ok')).toBe(true);
  expect(()=>s.saveProduct('r1',{productId:'new-product',title:'',rows:[row('new-product')]})).toThrow();
  s.saveRun({...run('r3'),parentRunId:'r2'});s.saveProduct('r3',{productId:'1000001',title:'沙发',rows:[],error:'会话失效'});expect(s.getRunPrices('r3')).toHaveLength(2);expect(s.getRunPrices('r3')[0]).toMatchObject({status:'stale',after:'85.00',error:'会话失效'});
  s.saveProduct('r3',{productId:'1000001',title:'',rows:[],error:'另一次失败'});expect(s.getRunPrices('r3')[0].error).toBe('会话失效');
 });
 it('reopens real files, encrypts credentials and never returns them in shops',()=>{
  const path=file();const s=open(path);const credentials:VerifiedAccount={sellerId:'seller-s1',shopName:'s1',platform:'tmall',cookies:[{name:'session',value:'fixture-cookie-private-value',domain:'.tmall.com'}],userAgent:'test',appKey:'test-key'};
  s.saveShop(shop(),credentials);s.setConfig('settings',{enabled:true});s.close();
  const reopened=open(path);expect(reopened.getConfig('settings',{})).toEqual({enabled:true});expect(reopened.getCredentials('s1')).toEqual(credentials);expect(reopened.listShops()).toEqual([{...shop(),hasCookies:true}]);expect(JSON.stringify(reopened.getShop('s1'))).not.toContain('cookies');expect(readFileSync(path).includes(Buffer.from('fixture-cookie-private-value'))).toBe(false);
 });
 it('persists run snapshots, validates ownership and makes duplicate callbacks idempotent',()=>{
  const path=file();const s=open(path);seed(s);s.saveProduct('r1',{productId:'1000001',title:'沙发',rows:[row()]});s.saveProduct('r1',{productId:'1000001',title:'沙发',rows:[row()]});
  expect(s.getRunPrices('r1')).toHaveLength(1);expect(s.getRunPrices('r1')[0]).toMatchObject({after:'85.00',stock:3,discount:'8.5000',stale:false});
  expect(()=>s.saveProduct('missing',{productId:'1000001',title:'',rows:[row()]})).toThrow();
  expect(()=>s.saveProduct('r1',{productId:'1000001',title:'',rows:[row('1000001','other',{shopId:'s2'})]})).toThrow();
  expect(()=>s.saveTask(task('bad','missing'))).toThrow();expect(()=>s.saveRun(run('bad','missing'))).toThrow();
  s.close();const reopened=open(path);expect(reopened.getRunPrices('r1')).toHaveLength(1);expect(reopened.history('s1','1000001')).toHaveLength(1);
 });
});
