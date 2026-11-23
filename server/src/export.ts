import {randomUUID} from 'node:crypto';
import type {ExportInput,ExportResult,PriceRow,ProductRow} from '../../shared/contracts.js';
import type {Store} from './database.js';
import {HttpError} from './api-context.js';
import {readSnapshot,iterateExportRows,type QueryReader} from './query.js';
const headers:Record<string,string>={shopId:'店铺ID',shopName:'店铺',productId:'商品ID',title:'标题',sourceUrl:'商品链接',skuId:'SKU ID',specs:'完整规格',seatSpec:'座位规格',color:'颜色',backendPrice:'后台标价',before:'优惠前价',after:'优惠后价',discount:'实际折扣',saving:'优惠金额',priceDifference:'价格差额',detailFetchedAt:'详情采集时间',backendFetchedAt:'后台采集时间',updatedAt:'更新时间',status:'状态',error:'错误原因',note:'备注',tags:'标签',skuCount:'SKU数',matchedSkuCount:'命中SKU数',unknownCount:'未知SKU数',minDiscount:'最低折扣',maxDiscount:'最高折扣',minAfter:'最低优惠后价',maxAfter:'最高优惠后价',skuIds:'SKU列表',stock:'库存',id:'记录ID',stale:'陈旧数据',backendSource:'后台来源',backendVerified:'后台已核验',runId:'作业ID'};
type Row=PriceRow|ProductRow;
const skuFields=new Set(['skuId','specs','seatSpec','color','backendPrice','before','after','discount','saving','priceDifference','detailFetchedAt','backendFetchedAt','error','stock','backendSource','backendVerified','runId','stale']);
function cell(row:Row,field:string):string{const value=(row as unknown as Record<string,unknown>)[field];return value==null?'':Array.isArray(value)?value.join('、'):String(value);}
function setup(store:Store):void{store.db.exec('CREATE TABLE IF NOT EXISTS export_snapshots(token TEXT PRIMARY KEY,expires_at INTEGER NOT NULL,payload TEXT NOT NULL)');store.db.prepare('DELETE FROM export_snapshots WHERE expires_at<=?').run(Date.now());}
const formats:Record<ExportInput['format'],[string,string]>={ids:['txt','text/plain'],titles:['txt','text/plain'],'id-title':['txt','text/plain'],tsv:['tsv','text/tab-separated-values'],csv:['csv','text/csv'],text:['txt','text/plain'],json:['json','application/json'],markdown:['md','text/markdown']};
const numeric=new Set(['backendPrice','before','after','discount','saving','priceDifference','minAfter','maxAfter','minDiscount','maxDiscount','stock','skuCount','matchedSkuCount','unknownCount']);
const previewLimit=32*1024;
export const INLINE_EXPORT_LIMITS={sourceRows:2000,bytes:5*1024*1024} as const;

export function exportFileInfo(format:ExportInput['format']){
 if(!Object.hasOwn(formats,format))throw new HttpError(400,'无效导出格式');
 const [extension,type]=formats[format];
 return {filename:`prices-${new Date().toISOString().replace(/[:.]/g,'-')}.${extension}`,mime:`${type}; charset=utf-8`};
}
export function exportFields(input:ExportInput):string[]{
 const fields=input.format==='ids'?['productId']:input.format==='titles'?['title']:input.format==='id-title'?['productId','title']:input.fields;
 if(!fields.length||fields.some(field=>!Object.hasOwn(headers,field)))throw new HttpError(400,'无效导出字段');
 return fields;
}
function escaped(value:string,separator:string){
 let text=value.replace(/\\/g,'\\\\').replace(/\r/g,'\\r').replace(/\n/g,'\\n').replace(/\t/g,'\\t');
 if(separator&&!['\t','\n','\r'].includes(separator))text=text.split(separator).join(`\\${separator}`);
 return text;
}
function rowFormatter(input:ExportInput,fields:string[]){
 const labels=fields.map(field=>headers[field]!);
 const safe=(value:string,field:string)=>!numeric.has(field)&&/^[\s\u0000-\u001f]*[=+@-]/.test(value)?`'${value}`:value;
 const csv=(value:string)=>/[",\r\n]/.test(value)?`"${value.replace(/"/g,'""')}"`:value;
 const markdown=(values:string[])=>`| ${values.map(v=>v.replace(/\\/g,'\\\\').replace(/\|/g,'\\|').replace(/\r?\n/g,'<br>').replace(/\r/g,'<br>')).join(' | ')} |`;
 const separator=input.format==='ids'||input.format==='titles'?'':input.format==='text'?(input.separator??'\t'):'\t';
 const line=(values:string[],headers:boolean)=>{
  if(input.format==='markdown')return markdown(values);
  if(input.format==='csv')return values.map((v,i)=>csv(headers?v:safe(v,fields[i]!))).join(',');
  return values.map((v,i)=>escaped(!headers&&['tsv','id-title'].includes(input.format)?safe(v,fields[i]!):v,separator)).join(separator);
 };
 const header=input.header&&input.format!=='json'?line(labels,true)+(input.format==='markdown'?'\n'+markdown(fields.map(()=>'---')):''):null;
 return {header,render(row:Row){
  if(input.format==='json'){
   const record=row as unknown as Record<string,unknown>;
   return JSON.stringify(Object.fromEntries(fields.map(field=>[field,record[field]??null])),null,2).replace(/^/gm,'  ');
  }
  return line(fields.map(field=>cell(row,field)),false);
 }};
}

export type ExportMetrics=Pick<ExportResult,'rowCount'|'sourceCount'|'preview'|'bytes'>;
/** Both the synchronous copy path and file workers consume the same snapshot, projection and encoder. */
export function renderExport(store:QueryReader,input:ExportInput,write:(chunk:string)=>void,onSource?:(count:number)=>void):ExportMetrics{
 const fields=exportFields(input),formatter=rowFormatter(input,fields);
 const granular=fields.some(field=>skuFields.has(field));
 const expand=input.query.view==='product'&&(granular||fields.some(field=>field==='tags'||field==='note'));
 const json=input.format==='json';
 let preview='',previewCut=false,bytes=0,rowCount=0,sourceCount=0;
 function previewChunk(chunk:string){
  if(previewCut)return;
  const left=previewLimit-preview.length;
  preview+=chunk.slice(0,left);
  if(chunk.length>left){preview+='…';previewCut=true;}
 }
 function chunk(value:string,show:boolean){
  bytes+=Buffer.byteLength(value);write(value);
  if(show)previewChunk(value);
 }
 return readSnapshot(store,()=>{
  if(json)chunk('[',true);
  else if(formatter.header!==null)chunk(formatter.header,true);
  for(const entry of iterateExportRows(store,input,expand,granular)){
   sourceCount++;onSource?.(sourceCount);
   if(!entry.emit)continue;
   let row=entry.row;
   if(entry.detail){
    const detail=entry.detail as unknown as Record<string,unknown>;
    row={...row,...Object.fromEntries(fields.filter(field=>skuFields.has(field)||field==='tags'||field==='note').map(field=>[field,detail[field]]))};
   }
   const prefix=json?(rowCount?',\n':'\n'):(rowCount||formatter.header!==null?'\n':'');
   chunk(prefix+formatter.render(row),rowCount<5);rowCount++;
  }
  if(json)chunk(rowCount?'\n]':']',true);
  return {sourceCount,rowCount,bytes,preview};
 });
}
export function saveExportSnapshot(store:Store,result:ExportResult):void{
 setup(store);
 store.db.prepare('INSERT INTO export_snapshots VALUES(?,?,?)').run(result.token,Date.now()+15*60*1000,JSON.stringify(result));
 store.db.exec('DELETE FROM export_snapshots WHERE token NOT IN(SELECT token FROM export_snapshots ORDER BY expires_at DESC,rowid DESC LIMIT 32)');
}
export function buildExport(store:Store,input:ExportInput):ExportResult{
 const info=exportFileInfo(input.format);
 const chunks:string[]=[];
 let inlineBytes=0;
 const tooLarge=()=>{throw new HttpError(413,'导出超过复制上限，请创建文件导出任务');};
 const metrics=renderExport(store,input,chunk=>{
  inlineBytes+=Buffer.byteLength(chunk);
  if(inlineBytes>INLINE_EXPORT_LIMITS.bytes)tooLarge();
  chunks.push(chunk);
 },count=>{if(count>INLINE_EXPORT_LIMITS.sourceRows)tooLarge();});
 const result={...metrics,...info,token:randomUUID(),content:chunks.join(''),downloadRecommended:false};
 saveExportSnapshot(store,result);
 return result;
}
export function getExport(store:Store,token:string):ExportResult|undefined{setup(store);const row=store.db.prepare('SELECT payload FROM export_snapshots WHERE token=?').get(token);return row?JSON.parse(String(row.payload)) as ExportResult:undefined;}
