/**
 * Real-account HTTP acceptance harness. Reads current local seller cookies through
 * the paired sctl browser, keeps them in memory only, runs the actual app worker
 * against the Node collector, then verifies DB/query/export and cleanup.
 */
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {Store} from '../src/database.js';
import {Worker} from '../src/worker.js';
import {createCollector} from '../src/collector/index.js';
import {buildExport} from '../src/export.js';
import type {CookieRecord,ProductRow,PriceRow,VerifiedAccount} from '../../shared/contracts.js';

const browser=process.argv[2];
const productIds=(process.argv[3]||'').split(',').filter(Boolean);
if(!browser||!productIds.length)throw Error('用法：tsx server/scripts/real-acceptance.ts <browserId> <商品ID,...>');

function sctl(...args:string[]):unknown{
  const output=execFileSync('sctl',[...args,'-o','json'],{encoding:'utf8',maxBuffer:32*1024*1024});
  return JSON.parse(output);
}
function cookies():CookieRecord[]{
  const all:CookieRecord[]=[];
  for(const domain of ['taobao.com','tmall.com']){
    const data=sctl('cookies','list','--browser',browser,'--domain',domain,'--limit','1000') as {items:CookieRecord[];hasMore?:boolean};
    if(data.hasMore)throw Error('Cookie导出被截断，拒绝继续');
    all.push(...data.items);
  }
  return all;
}
const userAgent='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';
const page=(sctl('tabs','list','--browser',browser) as {tabs:{tabId:number;url:string;title:string}[]}).tabs.find(tab=>tab.url.includes('qn.taobao.com/home.htm/SellManage/'));
if(!page)throw Error('请先在配对浏览器打开千牛“我的商品”页面以便取得实际公开 appKey');
const probe=execFileSync('sctl',['page','eval','--browser',browser,'--tab',String(page.tabId),'--timeout','25s','(function(){var r=performance.getEntriesByType("resource").filter(function(e){return e.name.indexOf("/mtop.")!==-1&&e.name.indexOf(".sell.pc.manage.")!==-1});var last=r[r.length-1];return last?new URL(last.name).searchParams.get("appKey"):"";})()'],{encoding:'utf8'});
const raw=probe.slice(probe.indexOf(':')+1).trim();
const parsed=raw?JSON.parse(raw):'';
const appKey=String(parsed??'').trim();
if(!/^\d+$/.test(appKey))throw Error('无法从当前千牛页取得公开appKey');

const dir=mkdtempSync(join(tmpdir(),'price-acceptance-'));
const store=new Store(join(dir,'monitor.sqlite'),'acceptance-'.padEnd(64,'x'));
const collector=createCollector();
const worker=new Worker(store,collector);
try{
  const account:VerifiedAccount=await collector.verify({platform:'tmall',cookies:cookies(),userAgent,appKey},AbortSignal.timeout(120000));
  const at=new Date().toISOString();
  store.saveShop({id:'acceptance',name:account.shopName,sellerId:account.sellerId,platform:account.platform,enabled:true,sessionStatus:'valid',lastVerifiedAt:at,lastError:null,createdAt:at,updatedAt:at,hasCookies:true},account);
  store.saveTask({id:'accept-task',shopId:'acceptance',name:'真实账号验收',enabled:false,scope:'selected',productIds,rules:[{mode:'all',conditions:[{field:'discount',op:'lt',value:'8.5'}]}],whitelist:{productIds:[],titleKeywords:['自由岛']},schedule:{kind:'manual',time:'09:00',days:[],timezone:'Asia/Shanghai'},notify:false,version:1,createdAt:at,updatedAt:at,nextRunAt:null});
  const run=worker.enqueue('acceptance','accept-task');
  const deadline=Date.now()+15*60*1000;
  while(Date.now()<deadline){await new Promise(resolve=>setTimeout(resolve,1000));if(['success','partial','failed','stopped','auth_required'].includes(store.getRun(run.id)!.status))break;}
  await worker.whenIdle();
  const saved=store.getRun(run.id)!;
  const rows=store.getRunPrices(run.id);
  const three=rows.filter(row=>row.backendPrice&&row.before&&row.after);
  const verified=rows.filter(row=>row.backendVerified);
  const query=store.query({shopIds:['acceptance'],view:'sku',groups:[{mode:'all',conditions:[{field:'discount',op:'lt',value:'9.5'}]}],page:1,pageSize:50});
  const products=store.query({shopIds:['acceptance'],view:'product',page:1,pageSize:50});
  const exported=buildExport(store,{query:{shopIds:['acceptance'],view:'product'},scope:'all',fields:['productId','title'],format:'id-title',header:false});
  const ids=[...new Set(rows.map(row=>row.productId))];
  const summary={run:{id:saved.id,status:saved.status,expected:saved.expected,processed:saved.processed,failed:saved.failed,message:saved.message},
    shop:{name:account.shopName,platform:account.platform,sellerIdPresent:!!account.sellerId},
    rows:rows.length,backendVerified:verified.length,threePrices:three.length,products:ids,queryTotal:query.total,productRows:products.total,
    exportRowCount:exported.rowCount,exportPreviewLines:exported.preview.split('\n').length,
    alerts:store.listAlerts({runId:run.id}).length,sample:three.slice(0,3).map(row=>({skuId:row.skuId,backendPrice:row.backendPrice,before:row.before,after:row.after,discount:row.discount}))};
  console.log(JSON.stringify(summary,null,2));
  if(saved.status!=='success'&&saved.status!=='partial')process.exitCode=2;
  if(!three.length||three.length!==verified.length)process.exitCode=3;
  if(exported.rowCount!==new Set(three.map(row=>row.productId)).size)process.exitCode=4;
}finally{await worker.close();store.close();rmSync(dir,{recursive:true,force:true});}
