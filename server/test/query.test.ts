import {afterEach,describe,expect,it} from 'vitest';
import {Store,type RunRecord} from '../src/database.js';
import type {Shop,MonitorTask,CollectedRow,RuleGroup,PriceRow,ProductRow} from '../../shared/contracts.js';
const KEY='repository-test-key-at-least-thirty-two-characters';
const shop=(id='s1'):Shop=>({id,name:id,sellerId:`seller-${id}`,platform:'tmall',enabled:true,sessionStatus:'valid',lastVerifiedAt:null,lastError:null,createdAt:'2026-01-01T00:00:00Z',updatedAt:'2026-01-01T00:00:00Z',hasCookies:false});
const task=(id='t1',shopId='s1'):MonitorTask=>({id,shopId,name:id,enabled:true,scope:'all',productIds:[],rules:[],whitelist:{productIds:[],titleKeywords:[]},schedule:{kind:'manual',time:'09:00',days:[],timezone:'Asia/Shanghai'},notify:false,version:1,createdAt:'2026-01-01T00:00:00Z',updatedAt:'2026-01-01T00:00:00Z',nextRunAt:null});
const run=(id='r1',shopId='s1',taskId:string|null='t1'):RunRecord=>({id,shopId,taskId,taskName:taskId||'',shopName:shopId,status:'running',scope:'all',productIds:[],expected:0,processed:0,failed:0,rows:0,checked:0,excluded:0,matched:0,unknown:0,message:'',createdAt:'2026-01-01T00:00:00Z',startedAt:'2026-01-01T00:00:00Z',finishedAt:null,parentRunId:null,failedProductIds:[],notificationStatus:'pending',taskSnapshot:taskId?task(taskId,shopId):null});
const row=(productId='1000001',skuId='2000001',patch:Partial<CollectedRow>={}):CollectedRow=>({shopId:'s1',productId,skuId,title:'沙发',specs:'三人位 米白',seatSpec:'三人位',color:'米白',backendPrice:'100.00',before:'100.00',after:'85.00',backendVerified:true,status:'ok',sourceUrl:`https://detail.tmall.com/item.htm?id=${productId}`,backendSource:'seller',detailFetchedAt:'2026-01-01T00:00:00Z',backendFetchedAt:'2026-01-01T00:00:00Z',stock:3,...patch});
function seed(store:Store){store.saveShop(shop());store.saveTask(task());store.saveRun(run());}

const stores:Store[]=[];afterEach(()=>{stores.splice(0).forEach(s=>s.close());});
function fixture(){const s=new Store(':memory:',KEY);stores.push(s);seed(s);return s;}
const discount=(op:'lt'|'eq'|'ne'|'between',value='8.5'):RuleGroup[]=>[{mode:'all',conditions:[{field:'discount',op,value}]}];
describe('SQL price queries',()=>{
 it('requires only the fields used by a rule and respects open interval endpoints',()=>{
  const s=fixture();s.saveProduct('r1',{productId:'1000001',title:'',rows:[row('1000001','a',{before:null,after:null,status:'partial'})]});
  const groups:RuleGroup[]=[{mode:'all',conditions:[{field:'backendPrice',op:'eq',value:'100'}]}];
  expect(s.query({view:'product',matchMode:'all',groups}).total).toBe(1);
  s.saveProduct('r1',{productId:'1000002',title:'',rows:[row('1000002','b',{before:null,after:'85'})]});
  expect(s.query({groups:[{mode:'all',conditions:[{field:'discount',op:'between',value:'8.5',upper:'9',includeLower:false}]}]}).total).toBe(0);
  expect(s.query({groups:[{mode:'all',conditions:[{field:'discount',op:'between',value:'8.5',upper:'9'}]}]}).total).toBe(1);
 });
 it('applies SKU filters without shrinking the product all-SKU universe',()=>{
  const s=fixture();s.saveProduct('r1',{productId:'1000001',title:'',rows:[row('1000001','a',{specs:'蓝色'}),row('1000001','b',{specs:'米白'})]});
  expect(s.query({view:'product',skuIds:['a']}).rows[0]).toMatchObject({skuCount:2,matchedSkuCount:1});
  expect(s.query({view:'product',skuIds:['a'],matchMode:'all'}).total).toBe(0);
  expect(s.query({view:'product',search:'蓝色'}).rows[0]).toMatchObject({skuCount:2,matchedSkuCount:1});
  expect(s.query({view:'product',search:'蓝色',matchMode:'all'}).total).toBe(0);
 });
 it('sorts nearly identical ratios exactly rather than by floating-point equality',()=>{
  const s=fixture();s.saveProduct('r1',{productId:'1000001',title:'',rows:[row('1000001','a',{backendPrice:'90071992547409.90',after:'90071992547409.89'})]});
  s.saveProduct('r1',{productId:'1000002',title:'',rows:[row('1000002','b',{backendPrice:'90071992547409.89',after:'90071992547409.88'})]});
  expect(s.query({sort:'discount',order:'asc'}).rows.map(r=>r.productId)).toEqual(['1000002','1000001']);
  expect(s.query({view:'product',sort:'minDiscount',order:'asc'}).rows.map(r=>r.productId)).toEqual(['1000002','1000001']);
 });
 it('loads task rules and isolated whitelists with historical task snapshots',()=>{
  const s=fixture();s.saveTask({...task(),rules:discount('lt'),whitelist:{productIds:['1000001'],titleKeywords:[]}});s.saveTask({...task('t2'),rules:discount('eq'),whitelist:{productIds:[],titleKeywords:['自由岛']}});
  s.saveProduct('r1',{productId:'1000001',title:'沙发',rows:[row('1000001','a',{after:'80'})]});s.saveProduct('r1',{productId:'1000002',title:'自由岛',rows:[row('1000002','b',{title:'自由岛'})]});
  expect(s.query({taskId:'t1',whitelistMode:'excluded'}).rows.map(r=>r.productId)).toEqual(['1000001']);expect(s.query({taskId:'t1',whitelistMode:'included'}).total).toBe(0);
  expect(s.query({taskId:'t2',whitelistMode:'excluded'}).rows.map(r=>r.productId)).toEqual(['1000002']);expect(s.query({taskId:'t1',groups:[],whitelistMode:'included'}).rows.map(r=>r.productId)).toEqual(['1000002']);
  expect(s.query({taskId:'t1',runId:'r1',whitelistMode:'excluded'}).total).toBe(0);
  expect(()=>s.query({whitelistMode:'excluded'})).toThrow();expect(()=>s.query({taskId:'missing'})).toThrow();
  s.annotate('s1',['1000001'],['重点'],'已记录');expect((s.query({productIds:['1000001']}).rows[0] as PriceRow).note).toBe('已记录');
 });
 it('aggregates products in SQL with any/all and unknown SKU semantics',()=>{
  const s=fixture();s.saveProduct('r1',{productId:'1000001',title:'沙发',rows:[row('1000001','a',{after:'80'}),row('1000001','b',{after:'90'}),row('1000001','c',{after:null,status:'partial'})]});
  s.saveProduct('r1',{productId:'1000002',title:'沙发',rows:[row('1000002','d',{after:'80'})]});
  const result=s.query({view:'product',groups:discount('lt'),sort:'productId',order:'asc',pageSize:1});expect(result).toMatchObject({total:2,productCount:2,skuCount:2});expect(result.rows[0]).toMatchObject({id:'s1:1000001',skuCount:3,matchedSkuCount:1,unknownCount:1,minAfter:'80.00',maxAfter:'90.00',minDiscount:'8.0000',maxDiscount:'9.0000'});
  expect(s.query({view:'product',groups:discount('lt'),matchMode:'all'}).rows.map(r=>r.productId)).toEqual(['1000002']);
  expect(s.queryAll({view:'product',pageSize:1})).toHaveLength(2);
 });
 it('compares true ratios exactly before pagination and sorts with stable identity',()=>{
  const s=fixture();for(const [product,price] of [['1000001','84999.99'],['1000002','85000.00'],['1000003','85000.01'],['1000004',null]] as const)s.saveProduct('r1',{productId:product,title:'沙发',rows:[row(product,'sku',{backendPrice:'100000.00',after:price})]});
  expect(s.query({groups:discount('lt'),pageSize:1}).rows.map(r=>r.productId)).toEqual(['1000001']);
  expect(s.query({groups:discount('eq')}).rows.map(r=>r.productId)).toEqual(['1000002']);
  expect(s.query({groups:discount('ne')}).total).toBe(2);
  const result=s.query({pageSize:1,page:2,sort:'after',order:'desc'});expect(result).toMatchObject({total:4,productCount:4,skuCount:4,page:2,pageSize:1});expect(result.rows[0].productId).toBe('1000002');
  expect(s.queryAll({pageSize:1,page:4})).toHaveLength(4);
  expect(s.query({search:"%' OR 1=1 --"}).total).toBe(0);expect(s.query({productIds:["' OR 1=1 --"]}).total).toBe(0);expect(()=>s.query({sort:'after); DROP TABLE shops;--'})).toThrow();expect(s.listShops()).toHaveLength(1);
 });
});
