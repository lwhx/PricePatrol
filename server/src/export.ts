import {randomUUID} from 'node:crypto';
import type {ExportInput,ExportResult,PriceRow,ProductRow} from '../../shared/contracts.js';
import type {Store} from './database.js';
import {readSnapshot,queryAllStore} from './query.js';
const headers:Record<string,string>={shopId:'店铺ID',shopName:'店铺',productId:'商品ID',title:'标题',sourceUrl:'商品链接',skuId:'SKU ID',specs:'完整规格',seatSpec:'座位规格',color:'颜色',backendPrice:'后台标价',before:'优惠前价',after:'优惠后价',discount:'实际折扣',saving:'优惠金额',priceDifference:'价格差额',detailFetchedAt:'详情采集时间',backendFetchedAt:'后台采集时间',updatedAt:'更新时间',status:'状态',error:'错误原因',note:'备注',tags:'标签',skuCount:'SKU数',matchedSkuCount:'命中SKU数',unknownCount:'未知SKU数',minDiscount:'最低折扣',maxDiscount:'最高折扣',minAfter:'最低优惠后价',maxAfter:'最高优惠后价',skuIds:'SKU列表',stock:'库存',id:'记录ID',stale:'陈旧数据',backendSource:'后台来源',backendVerified:'后台已核验',runId:'作业ID'};
type Row=PriceRow|ProductRow;
const skuFields=new Set(['skuId','specs','seatSpec','color','backendPrice','before','after','discount','saving','priceDifference','detailFetchedAt','backendFetchedAt','error','stock','backendSource','backendVerified','runId','stale']);
const productKey=(row:Row)=>JSON.stringify([row.shopId,row.productId]);
function cell(row:Row,field:string):string{const value=(row as unknown as Record<string,unknown>)[field];return value==null?'':Array.isArray(value)?value.join('、'):String(value);}
function setup(store:Store):void{store.db.exec('CREATE TABLE IF NOT EXISTS export_snapshots(token TEXT PRIMARY KEY,expires_at INTEGER NOT NULL,payload TEXT NOT NULL)');store.db.prepare('DELETE FROM export_snapshots WHERE expires_at<=?').run(Date.now());}
export function buildExport(store:Store,input:ExportInput):ExportResult{
 const fields=input.format==='ids'?['productId']:input.format==='titles'?['title']:input.format==='id-title'?['productId','title']:[...input.fields];if(!fields.length||fields.some(field=>!Object.hasOwn(headers,field)))throw Error('无效导出字段');
 let sourceCount=0;
 const rows=readSnapshot(store,()=>{
  let rows=input.scope==='page'?store.query(input.query).rows:queryAllStore(store,input.query,input.scope==='selected'?(input.selectedIds||[]):undefined);
  const granular=fields.some(field=>skuFields.has(field));
  if(input.query.view==='product'&&rows.length&&(granular||fields.some(field=>['note','tags'].includes(field)))){
   const products=new Map(rows.map((row,index)=>[productKey(row),{row,index}]));
   const query={...input.query,view:'sku' as const,shopIds:[...new Set(rows.map(row=>row.shopId))],productIds:[...new Set(rows.map(row=>row.productId))],sort:'skuId',order:'asc' as const};
   if(input.allSkus){query.groups=[];query.skuIds=undefined;query.search=undefined;query.from=undefined;query.to=undefined;}
   rows=store.queryAll(query).filter(row=>products.has(productKey(row))).sort((a,b)=>products.get(productKey(a))!.index-products.get(productKey(b))!.index).map(row=>({...products.get(productKey(row))!.row,...row}));
  }
  sourceCount=rows.length;
  if(!granular){const seen=new Set<string>();rows=rows.filter(row=>{const key=productKey(row);if(seen.has(key))return false;seen.add(key);return true;});}
  return rows;
 });
 const numeric=new Set(['backendPrice','before','after','discount','saving','priceDifference','minAfter','maxAfter','minDiscount','maxDiscount','stock','skuCount','matchedSkuCount','unknownCount']);
 const safe=(value:string,field:string)=>!numeric.has(field)&&/^[\s\u0000-\u001f]*[=+@-]/.test(value)?`'${value}`:value;
 const escaped=(value:string,separator:string)=>{let text=value.replace(/\\/g,'\\\\').replace(/\r/g,'\\r').replace(/\n/g,'\\n').replace(/\t/g,'\\t');if(separator&&!['\t','\n','\r'].includes(separator))text=text.split(separator).join(`\\${separator}`);return text;};
 const formats:Record<ExportInput['format'],[string,string]>={ids:['txt','text/plain'],titles:['txt','text/plain'],'id-title':['txt','text/plain'],tsv:['tsv','text/tab-separated-values'],csv:['csv','text/csv'],text:['txt','text/plain'],json:['json','application/json'],markdown:['md','text/markdown']};
 if(!formats[input.format])throw Error('无效导出格式');
 const render=(rows:Row[]):string=>{
  if(input.format==='json')return JSON.stringify(rows.map(row=>Object.fromEntries(fields.map(field=>[field,(row as unknown as Record<string,unknown>)[field]??null]))),null,2);
  const labels=fields.map(field=>headers[field]!);
  const table=rows.map(row=>fields.map(field=>cell(row,field)));
  if(input.format==='markdown'){
   const md=(value:string)=>value.replace(/\\/g,'\\\\').replace(/\|/g,'\\|').replace(/\r?\n/g,'<br>').replace(/\r/g,'<br>');
   const line=(values:string[])=>`| ${values.map(md).join(' | ')} |`;
   return [...(input.header?[line(labels),line(fields.map(()=>'---'))]:[]),...table.map(line)].join('\n');
  }
  if(input.format==='csv'){
   const quote=(value:string)=>/[",\r\n]/.test(value)?`"${value.replace(/"/g,'""')}"`:value;
   return [...(input.header?[labels.map(quote).join(',')]:[]),...table.map(values=>values.map((value,index)=>quote(safe(value,fields[index]!))).join(','))].join('\n');
  }
  const separator=input.format==='ids'||input.format==='titles'?'':input.format==='text'?(input.separator??'\t'):'\t';
  return [...(input.header?[labels.map(value=>escaped(value,separator)).join(separator)]:[]),...table.map(values=>values.map((value,index)=>escaped(['tsv','id-title'].includes(input.format)?safe(value,fields[index]!):value,separator)).join(separator))].join('\n');
 };
 const content=render(rows),bytes=Buffer.byteLength(content,'utf8');
 const result:ExportResult={token:randomUUID(),content,preview:render(rows.slice(0,5)),rowCount:rows.length,sourceCount,bytes,downloadRecommended:bytes>5*1024*1024||rows.length>20000,filename:`prices-${new Date().toISOString().replace(/[:.]/g,'-')}.${formats[input.format][0]}`,mime:`${formats[input.format][1]}; charset=utf-8`};
 setup(store);store.db.prepare('INSERT INTO export_snapshots VALUES(?,?,?)').run(result.token,Date.now()+15*60*1000,JSON.stringify(result));store.db.exec('DELETE FROM export_snapshots WHERE token NOT IN(SELECT token FROM export_snapshots ORDER BY expires_at DESC,rowid DESC LIMIT 32)');return result;
}
export function getExport(store:Store,token:string):ExportResult|undefined{setup(store);const row=store.db.prepare('SELECT payload FROM export_snapshots WHERE token=?').get(token);return row?JSON.parse(String(row.payload)) as ExportResult:undefined;}

