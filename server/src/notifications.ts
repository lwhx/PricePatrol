import type {Alert,NotificationMessage,NotificationSettings} from '../../shared/contracts.js';
import type {Store,RunRecord,AlertRunRecord} from './database.js';
import {reserveFrozenSubmission,releaseUnsentReservations} from './incidents.js';
import {Vault} from './security.js';
import {sendServerChan} from './integrations/serverchan.js';
import {HttpError,requireValue,type ApiContext} from './api-context.js';
import {z} from 'zod';
export function notificationSettings(store:Store):NotificationSettings{return {enabled:store.getConfig('notification.enabled',false),hasSendKey:!!store.getConfig('notification.key',''),lastError:store.getConfig<string|null>('notification.error',null)};}
function getKey(store:Store,vault:Vault):string{const sealed=store.getConfig<string>('notification.key','');if(!sealed)throw new HttpError(400,'请先配置Server酱SendKey');try{return vault.open<string>(sealed);}catch{throw new HttpError(400,'通知密钥无法读取，请重新配置');}}
function report(run:AlertRunRecord,source:RunRecord,alerts:Alert[]):NotificationMessage{
  const safe=(value:string)=>value.replace(/[|\r\n]/g,' ');
  const events={first:'首次',continuing:'持续',worsened:'恶化',recovered:'恢复'};
  const rows=alerts.slice(0,60).map(a=>`| ${a.event?events[a.event]:'命中'} | ${a.productId} | ${safe(a.title).slice(0,60)} | ${safe(a.specs).slice(0,70)} | ${a.backendPrice??'缺失'} | ${a.after??'缺失'} | ${a.discount??'未知'} |`).join('\n');
  const count=run.notificationCount??run.matched;
  const coverage=source.status==='partial'||run.status==='partial'?'覆盖不完整：只检查本批已采集的数据；未采集或无法判断的 SKU 不代表价格正常。':'仅依据本批采集价格检查；无法判断的 SKU 不代表价格正常。';
  return {title:run.notificationCount===undefined?`${run.shopName}：${run.matched}个SKU触发价格预警`:`${run.shopName}：${count}项价格预警动态`,short:`${run.taskName}，检查${run.checked}，排除${run.excluded}，无法判断${run.unknown}`,
    description:`### ${safe(run.taskName)}\n\n店铺：${safe(run.shopName)}\n\n预警状态：${run.status}；规则版本：${run.ruleVersion}；检查 SKU：${run.checked}；排除 SKU：${run.excluded}；无法判断 SKU：${run.unknown}。\n\n采集状态：${source.status}；完成商品：${source.processed}/${source.expected}；失败商品：${source.failed}。${coverage}\n\n| 动态 | 商品ID | 标题 | 规格 | 后台标价 | 页面优惠后 | 折扣 |\n|---|---|---|---|---|---|---|\n${rows}\n\n${count>60||alerts.length>60?'仅展示前60条，完整结果请在预警记录中查看。':''}\n采集批次：${run.collectionRunId}\n预警执行：${run.id}\n完成时间：${run.finishedAt}`};
}
export async function notifyAlertRun(store:Store,vault:Vault,input:AlertRunRecord,force=false):Promise<void>{
  let run=requireValue(store.getAlertRun(input.id),'预警执行不存在');
  const source=requireValue(store.getRun(run.collectionRunId),'来源采集批次不存在');
  if(source.trigger!=='scheduled')throw new HttpError(400,'只有定时采集产生的预警可以发送通知');
  if(!source.finishedAt||!['success','partial'].includes(source.status))throw new HttpError(400,'来源采集尚未成功或部分完成');
  if(!run.finishedAt||!['success','partial'].includes(run.status))throw new HttpError(400,'预警尚未成功或部分完成');
  // Check submission state before configuration, so clearing a key cannot erase idempotency.
  if(['accepted','sending'].includes(run.notificationStatus)){if(force)throw new HttpError(409,'该预警执行已提交通知，请勿重复发送');return;}
  // Delivery failures, including uncertain in-flight deliveries recovered after restart, need an explicit retry.
  if(run.notificationStatus==='failed'&&!force)return;
  const saveStatus=(status:string)=>{run={...requireValue(store.getAlertRun(run.id),'预警执行不存在'),notificationStatus:status};store.saveAlertRun(run);};
  const unsent=(status:'disabled'|'not_configured')=>{
    // An earlier uncertain submission remains uncertain even when its explicit retry has no usable channel.
    if(run.notificationStatus==='failed')return;
    store.transaction(()=>{saveStatus(status);releaseUnsentReservations(store,run);});
  };
  if(!run.taskSnapshot.notify){unsent('disabled');if(force)throw new HttpError(400,'该批次冻结的预警任务未启用通知');return;}
  if(run.notificationCandidateIds?.length===0){saveStatus('skipped');return;}
  const config=notificationSettings(store);
  if(!config.enabled){unsent('disabled');if(force)throw new HttpError(400,'通知尚未启用');return;}
  if(!config.hasSendKey){unsent('not_configured');if(force)throw new HttpError(400,'请先配置Server酱SendKey');return;}
  // Pre-upgrade finished reports keep their original delivery contract. New reports use only their frozen subset.
  const alerts=run.notificationCandidateIds===undefined?store.listAlerts({alertRunId:run.id}):
    run.notificationCandidateIds.slice(0,60).map(id=>{
      const alert=store.getAlert(id);
      if(!alert||alert.alertRunId!==run.id)throw Error('冻结的预警通知证据不可用');
      return alert;
    });
  if(!alerts.length){saveStatus('skipped');return;}
  store.transaction(()=>{saveStatus('sending');reserveFrozenSubmission(store,run);});
  try{
    const result=await sendServerChan(getKey(store,vault),report(run,source,alerts));
    if(!result.accepted)throw Error('通知未被接受');
    saveStatus('accepted');store.setConfig('notification.error',null);
  }catch{
    saveStatus('failed');store.setConfig('notification.error','Server酱投递失败，请检查SendKey、网络或额度');
    if(force)throw new HttpError(502,'Server酱投递失败，请检查SendKey、网络或额度');
  }
}
export function registerSettings(ctx:ApiContext):void{
  const {app,store,vault}=ctx;const settings=()=>({notification:notificationSettings(store),retentionDays:ctx.maintenance.getSettings().retentionDays,timezone:'Asia/Shanghai'});
  app.get('/api/settings',async()=>settings());
  app.put('/api/settings',async request=>{const input=z.object({sendKey:z.string().trim().max(1000).optional(),notificationEnabled:z.boolean().optional(),retentionDays:z.number().int().min(7).max(3650).optional()}).parse(request.body);if(input.retentionDays!==undefined)ctx.maintenance.updateSettings({retentionDays:input.retentionDays});if(input.sendKey!==undefined)store.setConfig('notification.key',input.sendKey?vault.seal(input.sendKey):'');if(input.notificationEnabled!==undefined)store.setConfig('notification.enabled',input.notificationEnabled);store.setConfig('notification.error',null);return settings();});
  app.post('/api/notifications/test',async()=>{const key=getKey(store,vault);try{const result=await sendServerChan(key,{title:'电商价格监控通知测试',description:'Server酱通知连接测试。此消息由管理界面手动触发。'});if(!result.accepted)throw Error();return {accepted:true};}catch{throw new HttpError(502,'Server酱测试发送失败，请检查SendKey、网络或额度');}});
  app.post<{Params:{id:string}}>('/api/runs/:id/notify',async request=>{requireValue(store.getRun(request.params.id));throw new HttpError(400,'采集任务不发送预警，请使用 /api/alert-runs/:id/notify 重试独立预警汇总');});
}
