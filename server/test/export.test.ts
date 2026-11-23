import {afterEach,describe,expect,it,vi} from 'vitest';
import {Store,type RunRecord} from '../src/database.js';
import {buildExport,getExport} from '../src/export.js';
import {evaluateRules} from '../src/domain.js';
import type {Shop,MonitorTask,CollectedRow,ExportInput} from '../../shared/contracts.js';
const KEY='repository-test-key-at-least-thirty-two-characters';
const shop=(id='s1'):Shop=>({id,name:id,sellerId:`seller-${id}`,platform:'tmall',enabled:true,sessionStatus:'valid',lastVerifiedAt:null,lastError:null,createdAt:'2026-01-01T00:00:00Z',updatedAt:'2026-01-01T00:00:00Z',hasCookies:false});
const task=(id='t1',shopId='s1'):MonitorTask=>({id,shopId,name:id,enabled:true,scope:'all',productIds:[],rules:[],whitelist:{productIds:[],titleKeywords:[]},schedule:{kind:'manual',time:'09:00',days:[],timezone:'Asia/Shanghai'},notify:false,version:1,createdAt:'2026-01-01T00:00:00Z',updatedAt:'2026-01-01T00:00:00Z',nextRunAt:null});
const run=(id='r1',shopId='s1',taskId:string|null='t1'):RunRecord=>({id,shopId,taskId,taskName:taskId||'',shopName:shopId,status:'running',scope:'all',productIds:[],expected:0,processed:0,failed:0,rows:0,checked:0,excluded:0,matched:0,unknown:0,message:'',createdAt:'2026-01-01T00:00:00Z',startedAt:'2026-01-01T00:00:00Z',finishedAt:null,parentRunId:null,failedProductIds:[],notificationStatus:'pending',taskSnapshot:taskId?task(taskId,shopId):null});
const row=(productId='1000001',skuId='2000001',patch:Partial<CollectedRow>={}):CollectedRow=>({shopId:'s1',productId,skuId,title:'沙发',specs:'三人位 米白',seatSpec:'三人位',color:'米白',backendPrice:'100.00',before:'100.00',after:'85.00',backendVerified:true,status:'ok',sourceUrl:`https://detail.tmall.com/item.htm?id=${productId}`,backendSource:'seller',detailFetchedAt:'2026-01-01T00:00:00Z',backendFetchedAt:'2026-01-01T00:00:00Z',stock:3,...patch});
function seed(store:Store){store.saveShop(shop());store.saveTask(task());store.saveRun(run());}

const stores:Store[]=[];afterEach(()=>{stores.splice(0).forEach(s=>s.close());});
function fixture(){const s=new Store(':memory:',KEY);stores.push(s);seed(s);return s;}
const input=(patch:Partial<ExportInput>={}):ExportInput=>({query:{sort:'productId',order:'asc',pageSize:2},scope:'all',fields:['productId','title','after'],format:'tsv',header:true,...patch});
describe('frozen exports',()=>{
 it('reads only selected SKU identities inside SQLite',()=>{
  const s=fixture();s.saveProduct('r1',{productId:'1000001',title:'',rows:Array.from({length:100},(_,i)=>row('1000001',String(i)))});
  let evaluated=0;s.db.function('rule_state',(payload,groups)=>{evaluated++;return Number(evaluateRules(JSON.parse(String(payload)),JSON.parse(String(groups))).value);});
  expect(buildExport(s,input({scope:'selected',selectedIds:['s1:1000001:99'],fields:['skuId']})).rowCount).toBe(1);expect(evaluated).toBe(1);
 });
 it('guards the bounded synchronous copy path and expires small copy snapshots',()=>{
  const s=fixture();s.saveProduct('r1',{productId:'1000001',title:'',rows:Array.from({length:2001},(_,i)=>row('1000001',String(i).padStart(6,'0')))});
  expect(()=>buildExport(s,input({fields:['skuId'],header:false}))).toThrow('文件导出任务');
  const small=fixture();small.saveProduct('r1',{productId:'1000001',title:'',rows:[row('1000001','000000')]});small.annotate('s1',['1000001'],[],'a'.repeat(5*1024*1024+1));
  expect(()=>buildExport(small,input({scope:'selected',selectedIds:['s1:1000001:000000'],fields:['note'],header:false}))).toThrow('文件导出任务');
  expect(small.db.prepare("SELECT name FROM sqlite_master WHERE name='export_snapshots'").get()).toBeUndefined();
  const first=buildExport(s,input({scope:'selected',selectedIds:[],fields:['skuId']}));for(let i=0;i<32;i++)buildExport(s,input({scope:'selected',selectedIds:[],fields:['skuId']}));expect(getExport(s,first.token)).toBeUndefined();
  const last=buildExport(s,input({scope:'selected',selectedIds:[],fields:['skuId']}));const now=Date.now();const clock=vi.spyOn(Date,'now').mockReturnValue(now+16*60*1000);try{expect(getExport(s,last.token)).toBeUndefined();}finally{clock.mockRestore();}
 },30000);

 it('renders all formats with exact strings, safe cells and per-shop product deduplication',()=>{
  const s=fixture(),product='99999999999999999999';s.saveProduct('r1',{productId:product,title:'',rows:[row(product,'a',{title:'=1+1|沙发,"米白"\n换行'}),row(product,'b',{title:'=1+1|沙发,"米白"\n换行'})]});
  s.saveShop(shop('s2'));s.saveTask(task('t2','s2'));s.saveRun(run('r2','s2','t2'));s.saveProduct('r2',{productId:product,title:'',rows:[row(product,'a',{shopId:'s2',title:'同名'})]});
  const ids=buildExport(s,input({format:'ids',fields:[],header:false}));expect(ids.content).toBe(`${product}\n${product}`);expect(ids.rowCount).toBe(2);expect(ids.sourceCount).toBe(3);
  expect(buildExport(s,input({format:'titles',fields:[],header:false})).rowCount).toBe(2);
  expect(buildExport(s,input({format:'id-title',fields:[],header:true})).content.startsWith('商品ID\t标题\n')).toBe(true);
  const json=buildExport(s,input({format:'json',fields:['productId','skuId','after','tags'],header:false}));expect(JSON.parse(json.content)[0]).toMatchObject({productId:product,skuId:'a',after:'85.00',tags:[]});expect(json.mime).toContain('application/json');
  const csv=buildExport(s,input({format:'csv',fields:['title','skuId'],header:true}));expect(csv.content).toContain(`"'=1+1|沙发,""米白""\n换行"`);
  const tsv=buildExport(s,input({fields:['title','skuId'],header:false}));expect(tsv.content.startsWith("'=1+1")).toBe(true);
  const markdown=buildExport(s,input({format:'markdown',fields:['title','skuId'],header:true}));expect(markdown.content).toContain('\\|');expect(markdown.content).toContain('<br>');
  const text=buildExport(s,input({format:'text',fields:['title','skuId'],header:false,separator:'|'}));expect(text.content).toContain('\\|');expect(text.content).toContain('\\n');
  expect(()=>buildExport(s,input({fields:['cookies']}))).toThrow();
 });
 it('expands filtered products to matching SKUs unless allSkus is explicitly enabled',()=>{
  const s=fixture();s.saveProduct('r1',{productId:'1000001',title:'沙发',rows:[row('1000001','a',{after:'80'}),row('1000001','b',{after:'90'})]});
  const query={view:'product' as const,groups:[{mode:'all' as const,conditions:[{field:'discount' as const,op:'lt' as const,value:'8.5'}]}]};
  const chosen=input({query,scope:'selected',selectedIds:['s1:1000001'],fields:['productId','skuId','after'],header:false});
  expect(buildExport(s,chosen)).toMatchObject({rowCount:1,content:'1000001\ta\t80.00'});expect(buildExport(s,{...chosen,allSkus:true}).rowCount).toBe(2);
  expect(buildExport(s,input({fields:['productId','title'],header:false})).rowCount).toBe(1);expect(buildExport(s,input({fields:['productId','skuId'],header:false})).rowCount).toBe(2);
 });
 it('copies every filtered page with ordered fields and keeps frozen content after updates',()=>{
  const s=fixture();for(let i=0;i<8;i++){const product=String(1000000+i);s.saveProduct('r1',{productId:product,title:'沙发',rows:[row(product)]});}
  const exported=buildExport(s,input());expect(exported.rowCount).toBe(8);expect(exported.sourceCount).toBe(8);expect(exported.content.split('\n')).toHaveLength(9);expect(exported.content.split('\n')[0]).toBe('商品ID\t标题\t优惠后价');expect(exported.preview.split('\n')).toHaveLength(6);expect(exported.bytes).toBe(Buffer.byteLength(exported.content));
  s.saveRun(run('r2'));s.saveProduct('r2',{productId:'1000000',title:'新标题',rows:[row('1000000','2000001',{title:'新标题',after:'10'})]});s.annotate('s1',['1000001'],[],'新备注');expect(getExport(s,exported.token)).toEqual(exported);expect(getExport(s,'missing')).toBeUndefined();
  expect(buildExport(s,input({scope:'page'})).rowCount).toBe(2);
  expect(buildExport(s,input({scope:'selected',selectedIds:['s1:1000007:2000001']})).content).toContain('1000007');
 });
});
