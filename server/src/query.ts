import type {DatabaseSync,SQLInputValue} from 'node:sqlite';
import type {QueryInput,QueryResult,PriceRow,ProductRow,RuleGroup,Whitelist,AlertTask,CollectionTask,MonitorTask} from '../../shared/contracts.js';
import type {Store} from './database.js';
import {evaluateRules,moneyCents,formatDiscount,whitelistReason} from './domain.js';

export function registerQueryFunctions(db:DatabaseSync):void{
 db.function('rule_state',{deterministic:true},(payload,groups)=>{const value=evaluateRules(JSON.parse(String(payload)) as PriceRow,JSON.parse(String(groups)) as RuleGroup[]).value;return value===null?null:Number(value);});
 // Safe integer denominators are below 10^16: distinct ratios differ by more than 10^-32.
 // Forty fractional digits therefore preserve their exact order with a fixed-width SQL text key.
 db.function('discount_sort',{deterministic:true},payload=>{const row=JSON.parse(String(payload)) as PriceRow,base=moneyCents(row.backendPrice),after=moneyCents(row.after);if(row.stale||!row.backendVerified||!base||after===null)return null;return String(BigInt(after)*10n**41n/BigInt(base)).padStart(58,'0');});
 db.function('whitelist_hit',{deterministic:true},(payload,list)=>Number(!!whitelistReason(JSON.parse(String(payload)) as PriceRow,JSON.parse(String(list)) as Whitelist)));
 db.function('price_unknown',{deterministic:true},payload=>{const row=JSON.parse(String(payload)) as PriceRow;return Number(row.stale||!row.backendVerified||!moneyCents(row.backendPrice)||moneyCents(row.after)===null);});
 db.function('product_view',{deterministic:true},(payload,matched,unknown)=>{
  const rows=(JSON.parse(String(payload)) as string[]).map(text=>JSON.parse(text) as PriceRow).sort((a,b)=>a.skuId.localeCompare(b.skuId));const first=rows[0]!;
  const valid=rows.filter(r=>!r.stale&&r.backendVerified&&moneyCents(r.backendPrice)!>0&&moneyCents(r.after)!==null);
  const discounts=[...valid].sort((a,b)=>{const left=BigInt(moneyCents(a.after)!)*BigInt(moneyCents(b.backendPrice)!),right=BigInt(moneyCents(b.after)!)*BigInt(moneyCents(a.backendPrice)!);return left<right?-1:left>right?1:0;});
  const prices=rows.filter(r=>!r.stale&&moneyCents(r.after)!==null).sort((a,b)=>moneyCents(a.after)!-moneyCents(b.after)!);
  const result:ProductRow={id:`${first.shopId}:${first.productId}`,shopId:first.shopId,shopName:first.shopName,productId:first.productId,title:first.title,sourceUrl:first.sourceUrl,skuCount:rows.length,matchedSkuCount:Number(matched),unknownCount:Number(unknown),minDiscount:discounts.length?formatDiscount(discounts[0]!.backendPrice,discounts[0]!.after):null,maxDiscount:discounts.length?formatDiscount(discounts.at(-1)!.backendPrice,discounts.at(-1)!.after):null,minAfter:prices[0]?.after??null,maxAfter:prices.at(-1)?.after??null,updatedAt:rows.reduce((a,r)=>r.updatedAt>a?r.updatedAt:a,''),status:rows.some(r=>r.stale)?'stale':rows.some(r=>r.status!=='ok')?'partial':'ok',skuIds:rows.map(r=>r.skuId)};
  return JSON.stringify(result);
 });
 db.function('amount_cents',{deterministic:true},value=>{if(value===null)return null;const text=String(value),negative=text.startsWith('-'),cents=moneyCents(negative?text.slice(1):text);return cents===null?null:negative?-cents:cents;});
}
export function readSnapshot<T>(store:Store,fn:()=>T):T{
 if(store.db.isTransaction)return fn();store.db.exec('BEGIN');try{const value=fn();store.db.exec('COMMIT');return value;}catch(error){store.db.exec('ROLLBACK');throw error;}
}
interface Plan{cte:string;args:SQLInputValue[];sort:string;page:number;pageSize:number}
function isLegacyMonitorTask(task:CollectionTask|null):task is MonitorTask{
 const legacy=task as MonitorTask|null;
 return !!legacy&&Array.isArray(legacy.rules)&&Array.isArray(legacy.whitelist?.productIds)&&Array.isArray(legacy.whitelist?.titleKeywords);
}
function plan(store:Store,input:QueryInput,selectedIds?:string[]):Plan{
 const where:string[]=[],args:SQLInputValue[]=[];
 let groups=input.groups||[];
 if(selectedIds){where.push(`${input.view==='product'?"p.shop_id||':'||p.product_id":'p.id'} IN(SELECT value FROM json_each(?))`);args.push(JSON.stringify(selectedIds));}
 if(input.whitelistMode&&input.whitelistMode!=='all'&&!input.taskId)throw Error('白名单查询需要指定任务');
 if(input.taskId){
  let task:AlertTask|MonitorTask|undefined;
  let source:Pick<CollectionTask,'scope'|'productIds'>;
  if(input.runId){
   const history=store.getRun(input.runId);if(!history)throw Error('采集批次不存在');
   task=history.alertTaskSnapshots?.find(snapshot=>snapshot.id===input.taskId&&snapshot.collectionTaskId===history.taskId&&snapshot.shopId===history.shopId);
   // Existing reports retain their original combined-task snapshot after migration.
   if(!task&&(!history.trigger||history.trigger==='legacy')&&history.taskId===input.taskId&&isLegacyMonitorTask(history.taskSnapshot))task=history.taskSnapshot;
   if(!task)throw Error('该采集批次没有此预警任务的历史快照');
   source=history;
  }else{
   task=store.getAlertTask(input.taskId);if(!task)throw Error('预警任务不存在');
   const collection=store.getTask(task.collectionTaskId);if(!collection)throw Error('关联采集任务不存在');
   source=collection;
  }
  groups=input.groups??task.rules;
  where.push('p.shop_id=?');args.push(task.shopId);
  // An alert scope can narrow its source collection, but cannot add uncollected products.
  for(const scope of [source,task])if(scope.scope==='selected'){where.push('p.product_id IN(SELECT value FROM json_each(?))');args.push(JSON.stringify(scope.productIds));}
  if(input.whitelistMode&&input.whitelistMode!=='all'){where.push(`whitelist_hit(p.payload,?)=${input.whitelistMode==='excluded'?1:0}`);args.push(JSON.stringify(task.whitelist));}
 }
 if(input.runId){where.push('p.run_id=?');args.push(input.runId);}
 for(const [values,column] of [[input.shopIds,'p.shop_id'],[input.productIds,'p.product_id']] as const)if(values?.length){where.push(`${column} IN(SELECT value FROM json_each(?))`);args.push(JSON.stringify(values));}
 const rowWhere:string[]=[],rowArgs:SQLInputValue[]=[];
 if(input.skuIds?.length){rowWhere.push('sku_id IN(SELECT value FROM json_each(?))');rowArgs.push(JSON.stringify(input.skuIds));}
 if(input.search){rowWhere.push("(instr(json_extract(payload,'$.title'),?)>0 OR instr(json_extract(payload,'$.specs'),?)>0)");rowArgs.push(input.search,input.search);}
 if(input.from){rowWhere.push("julianday(json_extract(payload,'$.updatedAt'))>=julianday(?)");rowArgs.push(input.from);}
 if(input.to){rowWhere.push("julianday(json_extract(payload,'$.updatedAt'))<=julianday(?)");rowArgs.push(input.to);}
 const state=rowWhere.length?`CASE WHEN ${rowWhere.join(' AND ')} THEN rule_state(payload,?) ELSE 0 END`:'rule_state(payload,?)';
 const product=input.view==='product';
 const unknown=groups.some(group=>group.conditions.length)?'matched IS NULL':'price_unknown(payload)=1';
 const aggregate=`SELECT shop_id,product_id,'' sku_id,product_view(json_group_array(payload),sum(matched=1),sum(${unknown})) payload,sum(matched=1) matched_count,min(discount_key) discount_min_key,max(discount_key) discount_max_key FROM evaluated GROUP BY shop_id,product_id HAVING ${input.matchMode==='all'?`sum(matched=1)=count(*) AND sum(${unknown})=0`:'sum(matched=1)>0'}`;
 const cte=`WITH base AS MATERIALIZED(SELECT p.shop_id,p.product_id,p.sku_id,json_set(p.payload,'$.tags',json(coalesce(a.tags,'[]')),'$.note',coalesce(a.note,'')) payload FROM ${input.runId?'prices':'latest'} p LEFT JOIN annotations a ON a.shop_id=p.shop_id AND a.product_id=p.product_id ${where.length?'WHERE '+where.join(' AND '):''}), evaluated AS MATERIALIZED(SELECT *,${state} matched,discount_sort(payload) discount_key FROM base), matched AS(SELECT *,1 matched_count FROM evaluated WHERE matched=1), result AS(${product?aggregate:'SELECT * FROM matched'})`;
 args.push(...rowArgs,JSON.stringify(groups));
 const field=input.sort||'updatedAt';
 const text=['id','shopId','shopName','productId','skuId','title','specs','seatSpec','color','status','updatedAt','detailFetchedAt','backendFetchedAt','note'];
 const amounts=['backendPrice','before','after','saving','priceDifference','minAfter','maxAfter'];
 let expr:string;
 if(text.includes(field))expr=`json_extract(payload,'$.${field}')`;
 else if(amounts.includes(field))expr=`amount_cents(json_extract(payload,'$.${field}'))`;
 else if(['skuCount','matchedSkuCount','unknownCount'].includes(field))expr=`CAST(json_extract(payload,'$.${field}') AS REAL)`;
 else if(['discount','minDiscount','maxDiscount'].includes(field))expr=product?(field==='maxDiscount'?'discount_max_key':'discount_min_key'):'discount_key';
 else throw Error('不支持的排序字段');
 const order=input.order==='asc'?'ASC':'DESC';
 const sort=`(${expr}) IS NULL ASC,${expr} ${order},shop_id ASC,product_id ASC,sku_id ASC`;
 const integer=(value:number|undefined,fallback:number)=>Number.isSafeInteger(value)&&value!>0?value!:fallback;
 return {cte,args,sort,page:integer(input.page,1),pageSize:Math.min(integer(input.pageSize,100),1000)};
}
export function queryStore(store:Store,input:QueryInput):QueryResult{return readSnapshot(store,()=>{
 const p=plan(store,input),count=store.db.prepare(`${p.cte} SELECT count(*) total,coalesce(sum(matched_count),0) skus FROM result`).get(...p.args)!;
 const products=store.db.prepare(`${p.cte} SELECT count(*) n FROM(SELECT 1 FROM result GROUP BY shop_id,product_id)`).get(...p.args)!;
 const rows=store.db.prepare(`${p.cte} SELECT payload FROM result ORDER BY ${p.sort} LIMIT ? OFFSET ?`).all(...p.args,p.pageSize,(p.page-1)*p.pageSize).map(row=>JSON.parse(String(row.payload)) as PriceRow);
 return {rows,total:Number(count.total),productCount:Number(products.n),skuCount:Number(count.skus),page:p.page,pageSize:p.pageSize,revision:Number(store.db.prepare('SELECT revision FROM metadata').get()?.revision||0)};
 });}
export function queryAllStore(store:Store,input:QueryInput,selectedIds?:string[]):(PriceRow|ProductRow)[]{return readSnapshot(store,()=>{const p=plan(store,input,selectedIds);return store.db.prepare(`${p.cte} SELECT payload FROM result ORDER BY ${p.sort}`).all(...p.args).map(row=>JSON.parse(String(row.payload)) as PriceRow);});}

