export type Platform = 'taobao' | 'tmall';
export interface CookieRecord {name:string;value:string;domain?:string;path?:string;expires?:number;expirationDate?:number;secure?:boolean;httpOnly?:boolean;sameSite?:string;session?:boolean}
export type CookieInput = string | CookieRecord[];
export interface AccountCredentials {cookies:CookieInput;platform:Platform;userAgent?:string;appKey?:string}
export interface VerifiedAccount {sellerId:string;shopName:string;platform:Platform;cookies:CookieRecord[];userAgent:string;appKey:string}
export interface Shop {id:string;name:string;sellerId:string;platform:Platform;enabled:boolean;sessionStatus:string;lastVerifiedAt:string|null;lastError:string|null;createdAt:string;updatedAt:string;hasCookies:boolean}
export type Compare = 'lt'|'lte'|'eq'|'ne'|'gte'|'gt'|'between';
export type RuleField = 'discount'|'backendPrice'|'before'|'after'|'saving'|'priceDifference'|'title'|'specs'|'productId'|'skuId'|'status';
export interface Condition {field:RuleField;op:Compare|'contains'|'notContains'|'in'|'notIn';value:string;upper?:string;includeLower?:boolean;includeUpper?:boolean}
export interface RuleGroup {mode:'all'|'any';conditions:Condition[]}
export interface Whitelist {productIds:string[];titleKeywords:string[]}
export interface Schedule {kind:'manual'|'daily'|'weekly';time:string;days:number[];timezone:string}
export interface CollectionTask {id:string;shopId:string;name:string;enabled:boolean;scope:'all'|'selected';productIds:string[];schedule:Schedule;version:number;createdAt:string;updatedAt:string;nextRunAt:string|null}
/** Serialized pre-split configuration, retained only for historical evidence. */
export interface MonitorTask extends CollectionTask {rules:RuleGroup[];whitelist:Whitelist;notify:boolean}
export type TaskInput = Omit<CollectionTask,'id'|'version'|'createdAt'|'updatedAt'|'nextRunAt'>;
export type CollectionTaskInput = TaskInput;
export interface AlertTask {id:string;collectionTaskId:string;shopId:string;name:string;enabled:boolean;scope:'all'|'selected';productIds:string[];rules:RuleGroup[];whitelist:Whitelist;notify:boolean;version:number;createdAt:string;updatedAt:string}
export type AlertTaskInput = Omit<AlertTask,'id'|'shopId'|'version'|'createdAt'|'updatedAt'>;
export type PriceStatus = 'ok'|'partial'|'error'|'backend_only'|'stale';
export interface CollectedRow {shopId:string;productId:string;skuId:string;title:string;specs:string;seatSpec:string;color:string;backendPrice:string|null;before:string|null;after:string|null;backendVerified:boolean;status:PriceStatus;error?:string;sourceUrl:string;backendSource:string;detailFetchedAt:string|null;backendFetchedAt:string|null;stock:number|null}
export interface PriceRow extends CollectedRow {id:string;runId:string;shopName:string;discount:string|null;saving:string|null;priceDifference:string|null;updatedAt:string;tags:string[];note:string;stale:boolean}
export interface ProductRow {id:string;shopId:string;shopName:string;productId:string;title:string;sourceUrl:string;skuCount:number;matchedSkuCount:number;unknownCount:number;minDiscount:string|null;maxDiscount:string|null;minAfter:string|null;maxAfter:string|null;updatedAt:string;status:string;skuIds:string[]}
export interface QueryInput {shopIds?:string[];groups?:RuleGroup[];productIds?:string[];skuIds?:string[];search?:string;runId?:string;view?:'sku'|'product';matchMode?:'any'|'all';sort?:string;order?:'asc'|'desc';page?:number;pageSize?:number;from?:string;to?:string;taskId?:string;whitelistMode?:'all'|'excluded'|'included'}
export interface QueryResult {rows:(PriceRow|ProductRow)[];total:number;productCount:number;skuCount:number;page:number;pageSize:number;revision:number}
export interface ExportInput {query:QueryInput;scope:'selected'|'page'|'all';selectedIds?:string[];fields:string[];format:'ids'|'titles'|'id-title'|'tsv'|'csv'|'text'|'json'|'markdown';header:boolean;allSkus?:boolean;separator?:string}
export interface ExportResult {token:string;content:string;preview:string;rowCount:number;sourceCount:number;bytes:number;downloadRecommended:boolean;filename:string;mime:string}
export type RunStatus='queued'|'running'|'success'|'partial'|'failed'|'stopped'|'auth_required'|'recoverable';
export type RunTrigger = 'manual'|'scheduled'|'legacy';
export type AlertDispatchStatus = 'not_applicable'|'pending'|'dispatched'|'skipped';
export interface Run {id:string;taskId:string|null;shopId:string;taskName:string;shopName:string;status:RunStatus;scope:'all'|'selected';productIds:string[];expected:number;processed:number;failed:number;rows:number;checked:number;excluded:number;matched:number;unknown:number;message:string;createdAt:string;startedAt:string|null;finishedAt:string|null;parentRunId:string|null;failedProductIds:string[];notificationStatus:string;trigger?:RunTrigger;alertDispatchStatus?:AlertDispatchStatus}
export interface AlertRun {id:string;alertTaskId:string;collectionRunId:string;shopId:string;shopName:string;taskName:string;status:'queued'|'running'|'success'|'partial'|'failed';rows:number;checked:number;excluded:number;matched:number;unknown:number;message:string;ruleVersion:number;createdAt:string;startedAt:string|null;finishedAt:string|null;notificationStatus:string}
export interface Alert {id:string;runId:string;taskId:string|null;alertRunId?:string|null;ruleVersion?:number;shopId:string;shopName:string;productId:string;skuId:string;title:string;specs:string;backendPrice:string|null;before:string|null;after:string|null;discount:string|null;reasons:string[];state:'pending'|'confirmed'|'resolved';note:string;createdAt:string;resolvedAt?:string|null}
export interface CollectorProgress {phase:string;expected:number;processed:number;failed:number;message:string}
/** Only a fully verified SKU listing may retire absent rows from the current-price view. */
export interface ProductCollection {productId:string;title:string;rows:CollectedRow[];error?:string;skuSetComplete?:boolean}
export interface CollectOptions {shopId:string;credentials:VerifiedAccount;productIds?:string[];skipProductIds?:string[];signal:AbortSignal;onProgress:(progress:CollectorProgress)=>void|Promise<void>;onProduct:(product:ProductCollection)=>void|Promise<void>}
export interface CollectionResult {cookies:CookieRecord[];expected:number;processed:number;failedProductIds:string[];coverageComplete:boolean}
export interface Collector {verify:(credentials:AccountCredentials,signal?:AbortSignal)=>Promise<VerifiedAccount>;collect:(options:CollectOptions)=>Promise<CollectionResult>}
export interface NotificationMessage {title:string;description:string;short?:string}
export interface NotificationSettings {enabled:boolean;hasSendKey:boolean;lastError:string|null}
export interface Overview {shops:number;tasks:number;alertTasks?:number;products:number;skus:number;pendingAlerts:number;running:number;failedRows:number;recentRuns:Run[]}
