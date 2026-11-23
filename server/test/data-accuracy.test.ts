import {afterEach, expect, it} from 'vitest';
import {Store, type RunRecord} from '../src/database.js';
import {buildExport} from '../src/export.js';
import type {CollectedRow, CollectionTask} from '../../shared/contracts.js';

const at='2026-01-01T00:00:00.000Z';
const stores:Store[]=[];
afterEach(()=>stores.splice(0).forEach(store=>store.close()));
function fixture(){
 const store=new Store(':memory:','data-accuracy-fixture-key-32-characters');stores.push(store);
 store.saveShop({id:'s',sellerId:'seller',name:'shop',platform:'tmall',enabled:true,sessionStatus:'valid',hasCookies:false,lastError:null,lastVerifiedAt:null,createdAt:at,updatedAt:at});
 const task:CollectionTask={id:'t',shopId:'s',name:'collection',enabled:true,scope:'all',productIds:[],schedule:{kind:'manual',time:'09:00',days:[],timezone:'Asia/Shanghai'},version:1,createdAt:at,updatedAt:at,nextRunAt:null};
 store.saveTask(task);
 const run=(id:string):RunRecord=>({id,taskId:'t',shopId:'s',taskName:'collection',shopName:'shop',status:'running',trigger:'manual',alertDispatchStatus:'not_applicable',scope:'all',productIds:[],expected:1,processed:0,failed:0,rows:0,checked:0,excluded:0,matched:0,unknown:0,message:'fixture',createdAt:at,startedAt:at,finishedAt:null,parentRunId:null,failedProductIds:[],notificationStatus:'disabled',taskSnapshot:task});
 const start=(id:string)=>{const value=run(id);store.saveRun(value);return value;};
 const row=(skuId:string,patch:Partial<CollectedRow>={}):CollectedRow=>({shopId:'s',productId:'1000001',skuId,title:'沙发',specs:skuId,seatSpec:'',color:'',backendPrice:'100',before:'100',after:'80',backendVerified:true,status:'ok',sourceUrl:'',backendSource:'fixture',detailFetchedAt:at,backendFetchedAt:at,stock:1,...patch});
 return {store,start,row};
}
it('retires absent latest SKUs only on authoritative complete success and preserves historical evidence',()=>{
 const {store,start,row}=fixture();const first=start('r1');
 store.saveProduct('r1',{productId:'1000001',title:'沙发',skuSetComplete:true,rows:[row('a'),row('b')]});
 store.saveRun({...first,status:'success',finishedAt:at});start('r2');
 store.saveProduct('r2',{productId:'1000001',title:'沙发',skuSetComplete:true,rows:[row('a',{after:'70'})]});
 expect(store.queryAll({view:'sku'}).map(value=>('skuId'in value?value.skuId:''))).toEqual(['a']);
 expect(store.getRunPrices('r1').map(value=>value.skuId)).toEqual(['a','b']);
 expect(()=>store.saveProduct('r1',{productId:'1000001',title:'',skuSetComplete:true,rows:[]})).toThrow('已结束');
 expect(store.queryAll({view:'sku'})).toHaveLength(1);
});
it.each([undefined,false])('retains missing SKUs when authority is %s',skuSetComplete=>{
 const {store,start,row}=fixture();start('r1');store.saveProduct('r1',{productId:'1000001',title:'',rows:[row('a'),row('b')]});
 start('r2');store.saveProduct('r2',{productId:'1000001',title:'',skuSetComplete,rows:[row('a')]});
 expect(store.queryAll({view:'sku'})).toHaveLength(2);
});
it('retains missing SKUs on partial data even if completeness is incorrectly asserted',()=>{
 const {store,start,row}=fixture();start('r1');store.saveProduct('r1',{productId:'1000001',title:'',rows:[row('a'),row('b')]});
 start('r2');store.saveProduct('r2',{productId:'1000001',title:'',skuSetComplete:true,rows:[row('a',{status:'partial',after:null})]});
 expect(store.queryAll({view:'sku'})).toHaveLength(2);
});
it('returns exact row-count deltas for duplicate callbacks and replacement of failed placeholders',()=>{
 const {store,start,row}=fixture();start('r1');
 expect(store.saveProduct('r1',{productId:'1000001',title:'',rows:[],error:'timeout'})).toBe(1);
 expect(store.saveProduct('r1',{productId:'1000001',title:'',rows:[row('a'),row('b')],skuSetComplete:true})).toBe(1);
 expect(store.saveProduct('r1',{productId:'1000001',title:'',rows:[row('a'),row('b')],skuSetComplete:true})).toBe(0);
 expect(store.countRunPrices('r1')).toBe(2);
});
it('reconciles a resumed partial product after an intervening run retired its previous SKUs',()=>{
 const {store,start,row}=fixture();const first=start('r1');
 store.saveProduct('r1',{productId:'1000001',title:'',rows:[row('a'),row('b',{after:null,status:'partial'})]});
 store.saveRun({...first,status:'stopped'});
 const other=start('r2');store.saveProduct('r2',{productId:'1000001',title:'',skuSetComplete:true,rows:[row('c')]});
 store.saveRun({...other,status:'success',finishedAt:at});
 store.saveRun({...first,status:'running'});
 expect(store.saveProduct('r1',{productId:'1000001',title:'',skuSetComplete:true,rows:[row('a',{after:'72'}),row('d',{after:'68'})]})).toBe(0);
 expect(store.getRunPrices('r1').map(value=>[value.skuId,value.after])).toEqual([['a','72.00'],['d','68.00']]);
 expect(store.queryAll({view:'sku',sort:'skuId',order:'asc'}).map(value=>[('skuId'in value?value.skuId:''),('after'in value?value.after:null)])).toEqual([['a','72.00'],['d','68.00']]);
 expect(store.getRunPrices('r2').map(value=>value.skuId)).toEqual(['c']);
});
it('preserves product aggregate fields when exporting annotations or expanded SKU detail',()=>{
 const {store,start,row}=fixture();start('r1');
 store.saveProduct('r1',{productId:'1000001',title:'',rows:[row('a'),row('b',{status:'partial',after:null})]});
 store.annotate('s',['1000001'],['重点'],'核验');
 const product=store.queryAll({view:'product'})[0]!;
 const output=buildExport(store,{query:{view:'product'},scope:'all',fields:['id','productId','status','updatedAt','note','tags'],format:'json',header:false});
 expect(JSON.parse(output.content)).toEqual([{id:product.id,productId:'1000001',status:'partial',updatedAt:product.updatedAt,note:'核验',tags:['重点']}]);
 const expanded=buildExport(store,{query:{view:'product'},scope:'all',fields:['id','skuId','status','after','note'],format:'json',header:false});
 expect(JSON.parse(expanded.content)).toEqual([{id:product.id,skuId:'a',status:'partial',after:'80.00',note:'核验'},{id:product.id,skuId:'b',status:'partial',after:null,note:'核验'}]);
});
