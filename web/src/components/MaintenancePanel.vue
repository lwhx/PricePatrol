<script setup lang="ts">
import {ref,reactive,onMounted,watch} from 'vue';
import type {MaintenanceSettings,MaintenanceStatus,CleanupPreview,OperationsOverview,BuildInfo} from '../../../shared/operations.js';
import {get,post,request,download} from '../api/client';
import {useFeedback,confirmAction} from '../composables/useFeedback';
import {usePolling} from '../composables/usePolling';
import {dateTime} from '../lib/format';
import ErrorBanner from './ErrorBanner.vue';
const form=reactive<MaintenanceSettings>({retentionDays:180,alertRetentionDays:365,cleanupEnabled:false,backupsEnabled:true,backupIntervalHours:24,backupKeep:14});
const loaded=ref(false),status=ref<MaintenanceStatus|null>(null),build=ref<BuildInfo|null>(null),before=ref(''),preview=ref<CleanupPreview|null>(null);
const {busy,error,act}=useFeedback();
async function refreshStatus(){try{status.value=await get<MaintenanceStatus>('/maintenance/status');}catch(cause){error.value=cause instanceof Error?cause.message:'无法读取维护状态';}}
onMounted(()=>{void act(async()=>{const [settings,operations]=await Promise.all([get<MaintenanceSettings>('/maintenance/settings'),get<OperationsOverview>('/operations')]);Object.assign(form,settings);build.value=operations.build;loaded.value=true;});});
usePolling(refreshStatus);
watch(before,()=>{preview.value=null;});
async function save(){await act(async()=>{Object.assign(form,await request<MaintenanceSettings>('/maintenance/settings',{method:'PUT',body:{...form}}));preview.value=null;await refreshStatus();},'数据维护设置已保存');}
async function backup(){await act(async()=>{await post('/maintenance/run',{kind:'backup'});await refreshStatus();},'备份任务已创建，可在下方查看执行结果');}
async function downloadBackup(){await act(()=>download('/maintenance/backup','POST','price-monitor-backup.sqlite'),'一致性备份已下载');}
async function previewCleanup(){await act(async()=>{preview.value=await post<CleanupPreview>('/maintenance/cleanup/preview',before.value?{before:new Date(`${before.value}T00:00:00+08:00`).toISOString()}:{});});}
async function cleanup(){
 const selected=preview.value;if(!selected)return;
 if(!await confirmAction(`将清理预计 ${selected.total} 条到期记录。系统会先完成一致性备份，并重新检查保护条件。是否继续？`))return;
 await act(async()=>{const result=await post<CleanupPreview&{deleted:number}>('/maintenance/cleanup',{before:selected.policy.historyBefore});preview.value=null;await refreshStatus();return result;},'历史清理已完成，可查看最新维护结果');
}
const bytes=(value?:number)=>value===undefined?'—':`${(value/1024/1024).toFixed(1)} MiB`;
</script>
<template>
 <section class="panel">
  <div class="panel-head"><div><h2>历史保留与自动维护</h2><p>普通采集与预警证据分开保留；清理前先生成一致性备份。</p></div><el-button :loading="busy" :disabled="!loaded||status?.running" @click="save">保存维护设置</el-button></div>
  <div class="panel-body">
   <ErrorBanner :message="error" />
   <el-form label-position="top"><div class="split-layout">
    <el-form-item label="普通采集历史保留天数"><el-input-number v-model="form.retentionDays" :min="7" :max="3650" /></el-form-item>
    <el-form-item label="已处理预警证据保留天数"><el-input-number v-model="form.alertRetentionDays" :min="form.retentionDays" :max="3650" /></el-form-item>
    <el-form-item label="自动清理"><el-switch v-model="form.cleanupEnabled" active-text="每天清理到期记录" /><span class="form-hint">默认关闭。未处理预警、当前价格、未完成执行和待投递通知受到保护。</span></el-form-item>
    <el-form-item label="定期备份"><el-switch v-model="form.backupsEnabled" active-text="按间隔自动备份" /></el-form-item>
    <el-form-item label="备份间隔（小时）"><el-input-number v-model="form.backupIntervalHours" :min="1" :max="8760" /></el-form-item>
    <el-form-item label="保留备份份数"><el-input-number v-model="form.backupKeep" :min="1" :max="365" /></el-form-item>
   </div></el-form>
   <p class="pill-note">预警证据从人工处理与证据产生的较晚时间起计算保留期。零命中的预警检查随普通历史到期清理。仍在持续的异常保留其关联证据。</p>
  </div>
 </section>
 <section class="panel">
  <div class="panel-head"><h2>备份与维护状态</h2><div class="header-actions"><el-button :loading="busy" @click="downloadBackup">下载一致性备份</el-button><el-button type="primary" plain :disabled="busy||status?.running" @click="backup">立即创建备份</el-button></div></div>
  <div class="panel-body">
   <ErrorBanner :message="[status?.lastError,status?.backupError,status?.copyError].filter(Boolean).join('；')" />
   <div class="inline-metrics pill-note"><span>{{ status?.running?'维护正在执行':'维护空闲' }}</span><span>数据库 {{ bytes(status?.databaseBytes) }}</span><span>本地备份 {{ status?.backupCount??'—' }} 份</span></div>
   <p>最近成功备份：{{ dateTime(status?.lastBackupAt) }}；最近成功清理：{{ dateTime(status?.lastCleanupAt) }}；最近删除 {{ status?.lastDeleted??0 }} 条。</p>
   <p class="muted">{{ status?.backupCopyConfigured?'已配置额外备份目录；复制失败会显示在上方。':'尚未配置额外备份目录。本地备份卷不能防止整台服务器丢失，请按部署说明挂载异机存储。' }} 恢复时必须保留原 ENCRYPTION_KEY，数据库备份不包含部署密钥。</p>
  </div>
 </section>
 <section class="panel">
  <div class="panel-head"><h2>预览并清理历史</h2></div>
  <div class="panel-body">
   <p class="muted">留空时使用已保存的保留期限；指定日期按北京时间零点处理。最终清理量会根据执行时的保护条件重新计算。</p>
   <div class="remote-tools"><el-input v-model="before" type="date" style="max-width:240px" aria-label="清理截止日期" /><el-button :loading="busy" :disabled="status?.running" @click="previewCleanup">预览可清理记录</el-button></div>
   <div v-if="preview" class="pill-note" style="margin-top:14px">预计清理 {{ preview.runs }} 个采集批次、{{ preview.prices }} 条价格、{{ preview.alertRuns }} 次预警检查及 {{ preview.alerts }} 条已处理预警；{{ preview.protectedRuns }} 个到期批次仍受保护。<el-button type="danger" plain :disabled="!preview.total||busy||status?.running" @click="cleanup">备份后执行清理</el-button></div>
  </div>
 </section>
 <section v-if="build" class="panel"><div class="panel-head"><h2>当前运行版本</h2></div><div class="panel-body"><p>构建提交：<code>{{ build.sha }}</code></p><p>构建时间：{{ dateTime(build.time) }}</p><p class="muted">数据库版本：{{ Object.entries(build.schema).map(([name,version])=>`${name}: ${version}`).join('，')||'—' }}</p></div></section>
</template>
