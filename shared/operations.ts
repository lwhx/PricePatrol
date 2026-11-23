export interface MaintenanceSettings {
 retentionDays:number;
 alertRetentionDays:number;
 cleanupEnabled:boolean;
 backupsEnabled:boolean;
 backupIntervalHours:number;
 backupKeep:number;
}
export interface RetentionPolicy {historyBefore:string;alertBefore:string}
export interface CleanupPreview {policy:RetentionPolicy;runs:number;prices:number;alertRuns:number;alerts:number;protectedRuns:number;total:number}
export interface MaintenanceStatus {
 running:boolean;
 lastRunAt:string|null;
 lastBackupAt:string|null;
 lastCleanupAt:string|null;
 lastError:string|null;
 backupError:string|null;
 copyError:string|null;
 backupCount:number;
 backupCopyConfigured:boolean;
 databaseBytes:number;
 lastDeleted:number;
}
export interface BuildInfo {sha:string;time:string|null;schema:Record<string,number>}
export interface ScheduleEvent {id:string;taskId:string;shopId:string;scheduledFor:string;recordedAt:string;outcome:'enqueued'|'skipped'|'failed';reason:string;runId:string|null}
export interface ShopHealth {shopId:string;shopName:string;lastSuccessAt:string|null;dataAgeSeconds:number|null;consecutiveFailures:number;lastAttemptAt:string|null;lastStatus:string|null}
export interface OperationsOverview {
 shops:ShopHealth[];
 queues:{collectionQueued:number;collectionRunning:number;alertQueued:number;alertRunning:number;notificationPending:number;notificationFailed:number};
 recentSchedules:ScheduleEvent[];
 build:BuildInfo;
}
