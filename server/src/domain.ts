import type {Compare,Condition,RuleGroup,PriceRow,CollectedRow,Whitelist} from '../../shared/contracts.js';
export type Truth=boolean|null;
export function moneyCents(value:unknown):number|null {
  if(typeof value!=='string' && typeof value!=='number')return null;
  const text=String(value).trim();
  if(!/^\d+(?:\.\d{1,2})?$/.test(text))return null;
  const [whole,decimal='']=text.split('.');
  const cents=BigInt(whole!)*100n+BigInt(decimal.padEnd(2,'0'));
  return cents<=BigInt(Number.MAX_SAFE_INTEGER)?Number(cents):null;
}
export function moneyText(cents:number|null):string|null{if(cents===null)return null;const integer=BigInt(cents),absolute=integer<0n?-integer:integer;return `${integer<0n?'-':''}${absolute/100n}.${String(absolute%100n).padStart(2,'0')}`;}
function threshold(value:string):bigint|null{
  const text=value.trim().replace(/折$/,'');const cents=moneyCents(text);
  return cents!==null&&cents>0&&cents<=1000?BigInt(cents):null;
}
export function compareInteger(left:bigint,right:bigint,op:string):boolean {
  switch(op){case 'lt':return left<right;case 'lte':return left<=right;case 'eq':return left===right;case 'ne':return left!==right;case 'gte':return left>=right;case 'gt':return left>right;default:throw Error('不支持的比较方式');}
}
export function compareDiscount(backend:string|null,after:string|null,op:Compare,value:string,upper?:string,includeLower=true,includeUpper=true):Truth {
  const base=moneyCents(backend),current=moneyCents(after),limit=threshold(value);
  if(base===null||base===0||current===null||limit===null)return null;
  const left=BigInt(current)*1000n,right=BigInt(base)*limit;
  if(op!=='between')return compareInteger(left,right,op);
  const high=threshold(upper||'');if(high===null||high<limit)return null;
  return compareInteger(left,right,includeLower?'gte':'gt')&&compareInteger(left,BigInt(base)*high,includeUpper?'lte':'lt');
}
export function formatDiscount(backend:string|null,after:string|null):string|null{
  const base=moneyCents(backend),current=moneyCents(after);
  return base&&current!==null?(current/base*10).toFixed(4):null;
}
export function rowKey(row:Pick<CollectedRow,'shopId'|'productId'|'skuId'>):string{return `${row.shopId}:${row.productId}:${row.skuId||'@product'}`;}
export function whitelistReason(row:Pick<CollectedRow,'productId'|'title'>,list:Whitelist):string|null {
  if(list.productIds.includes(row.productId))return '商品ID白名单';
  const word=list.titleKeywords.map(w=>w.trim()).find(w=>w&&row.title.includes(w));
  return word?`标题包含：${word}`:null;
}
function combine(values:Truth[],mode:'all'|'any'):Truth {
  if(mode==='all'){if(values.includes(false))return false;return values.includes(null)?null:true;}
  if(values.includes(true))return true;return values.includes(null)?null:false;
}
function amountField(row:PriceRow,field:string):number|null{
  const base=moneyCents(row.backendPrice),before=moneyCents(row.before),after=moneyCents(row.after);
  if(row.stale)return null;
  if(field==='backendPrice')return row.backendVerified?base:null;
  if(field==='before')return before;if(field==='after')return after;
  if(field==='saving')return row.backendVerified&&base!==null&&after!==null?base-after:null;
  if(field==='priceDifference')return row.backendVerified&&base!==null&&before!==null?before-base:null;
  return null;
}
function signedMoney(value:string):number|null{
  const minus=value.startsWith('-'),parsed=moneyCents(minus?value.slice(1):value);return parsed===null?null:(minus?-parsed:parsed);
}
export function evaluateCondition(row:PriceRow,condition:Condition):Truth{
  const {field,op,value,upper}=condition;
  if(['title','specs','productId','skuId','status'].includes(field)){
    const actual=String(row[field as 'title']??'');
    if(op==='contains')return actual.includes(value);if(op==='notContains')return !actual.includes(value);
    if(op==='in'||op==='notIn'){const match=value.split(/[\s,，;；]+/).includes(actual);return op==='in'?match:!match;}
    if(op==='eq')return actual===value;if(op==='ne')return actual!==value;return null;
  }
  if(field==='discount')return row.stale||!row.backendVerified?null:compareDiscount(row.backendPrice,row.after,op as Compare,value,upper,condition.includeLower,condition.includeUpper);
  const actual=amountField(row,field),limit=signedMoney(value);if(actual===null||limit===null)return null;
  if(op==='between'){const high=signedMoney(upper||'');if(high===null||high<limit)return null;return compareInteger(BigInt(actual),BigInt(limit),condition.includeLower===false?'gt':'gte')&&compareInteger(BigInt(actual),BigInt(high),condition.includeUpper===false?'lt':'lte');}
  return ['lt','lte','eq','ne','gte','gt'].includes(op)?compareInteger(BigInt(actual),BigInt(limit),op):null;
}
export function evaluateRules(row:PriceRow,groups:RuleGroup[]):{value:Truth;reasons:string[]}{
  const evaluated=groups.map(group=>({value:combine(group.conditions.map(c=>evaluateCondition(row,c)),group.mode),reasons:group.conditions.filter(c=>evaluateCondition(row,c)===true).map(c=>`${c.field} ${c.op} ${c.value}${c.upper?` ~ ${c.upper}`:''}`)}));
  return {value:combine(evaluated.map(g=>g.value),'all'),reasons:evaluated.flatMap(g=>g.reasons)};
}
export function parseProductIds(input:string|string[]):{ids:string[];invalid:string[]}{
  const tokens=Array.isArray(input)?input:input.split(/[\s,，;；]+/);const ids=new Set<string>(),invalid:string[]=[];
  for(const raw of tokens){if(!raw.trim())continue;let value=raw.trim();if(/^https?:/.test(value)){try{const url=new URL(value);if(!['detail.tmall.com','item.taobao.com'].includes(url.hostname))throw Error();value=url.searchParams.get('id')||'';}catch{invalid.push(raw);continue;}}
    if(/^\d{6,20}$/.test(value))ids.add(value);else invalid.push(raw);
  }return {ids:[...ids],invalid};
}
