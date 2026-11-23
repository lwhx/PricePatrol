import type {Store, AlertRunRecord} from './database.js';
import {beginObservations} from './incidents.js';
import {evaluateRules, whitelistReason} from './domain.js';
import type {DiagnosticReporter} from './diagnostics.js';

const now = () => new Date().toISOString();

/** Evaluates only immutable, completed scheduled collection batches. */
export class AlertWorker {
  private draining: Promise<void> | null = null;
  private delivering: Promise<void> | null = null;
  private notificationQueue = new Set<string>();
  private closed = false;
  constructor(private store: Store, private notify?: (run: AlertRunRecord) => Promise<void>, private report?: DiagnosticReporter) {}

  enqueueForCollection(collectionRunId: string): void {
    this.store.transaction(() => {
      const source = this.store.getRun(collectionRunId);
      if (!source || source.trigger !== 'scheduled' || source.alertDispatchStatus !== 'pending' ||
          !source.finishedAt || !['success', 'partial'].includes(source.status)) return;
      const tasks = (source.alertTaskSnapshots || []).filter(task => task.enabled);
      for (const task of tasks) {
        const id = `${source.id}:${task.id}`;
        if (this.store.getAlertRun(id)) continue;
        this.store.saveAlertRun({
          id, collectionRunId: source.id, alertTaskId: task.id, shopId: source.shopId, shopName: source.shopName,
          taskName: task.name, taskSnapshot: task, ruleVersion: task.version, status: 'queued', rows: 0,
          checked: 0, excluded: 0, matched: 0, unknown: 0, message: '等待预警检查', createdAt: now(),
          startedAt: null, finishedAt: null, notificationStatus: task.notify ? 'pending' : 'disabled',
        });
      }
      source.alertDispatchStatus = tasks.length ? 'dispatched' : 'skipped';
      this.store.saveRun(source);
    });
    this.kick();
  }

  recover(): void {
    for (const run of this.store.operationalAlertRuns(['running'])) {
      run.status = 'queued'; run.message = '进程中断，重新检查冻结采集批次'; this.store.saveAlertRun(run);
    }
    for (const run of this.store.interruptedAlertNotifications()) {
      // Delivery may already have reached the provider: never automatically send it twice.
      run.notificationStatus = 'failed'; this.store.saveAlertRun(run);
      this.store.setConfig('notification.error', '服务中断前有通知正在发送，投递结果未知，请先核对已收到的消息再决定是否重试');
    }
    for (const run of this.store.pendingAlertNotifications()) this.queueNotification(run);
    for (const source of this.store.pendingAlertCollections()) {
      try {this.enqueueForCollection(source.id);}
      catch (error) {this.report?.('alert_dispatch_failed', {runId:source.id}); throw error;}
    }
    this.kick();
  }

  async whenIdle(): Promise<void> {while (this.draining || this.delivering) await Promise.all([this.draining, this.delivering]);}
  async close(): Promise<void> {this.closed = true; await this.whenIdle();}
  private kick(): void {
    if (this.closed || this.draining) return;
    this.draining = Promise.resolve().then(() => this.drain()).finally(() => {
      this.draining = null;
      if (!this.closed && this.store.operationalAlertRuns(['queued']).length) this.kick();
    });
  }
  private async drain(): Promise<void> {
    while (!this.closed) {
      const run = this.store.operationalAlertRuns(['queued'])[0];
      if (!run) break;
      try {await this.execute(run);}
      catch {
        this.report?.('alert_evaluation_failed', {runId:run.collectionRunId,evaluationId:run.id});
        const saved = this.store.getAlertRun(run.id);
        if (saved && !saved.finishedAt) {
          saved.status = 'failed'; saved.finishedAt = now(); saved.message = '预警检查失败，采集结果已保留';
          saved.notificationStatus = 'skipped'; this.store.saveAlertRun(saved);
        }
      }
    }
  }
  private async execute(run: AlertRunRecord): Promise<void> {
    run.status = 'running'; run.startedAt ??= now(); run.message = '正在检查采集批次'; this.store.saveAlertRun(run);
    this.store.transaction(() => {
      const source = this.store.getRun(run.collectionRunId)!;
      const task = run.taskSnapshot;
      const sourceScope = source.scope === 'selected' ? new Set(source.productIds) : null;
      const alertScope = task.scope === 'selected' ? new Set(task.productIds) : null;
      const rows = this.store.getRunPrices(source.id).filter(row =>
        (!sourceScope || sourceScope.has(row.productId)) && (!alertScope || alertScope.has(row.productId)));
      run.rows = rows.length; run.checked = 0; run.excluded = 0; run.matched = 0; run.unknown = 0;
      const observe = beginObservations(this.store, run, source);
      run.lifecycle = { first: 0, continuing: 0, worsened: 0, recovered: 0 };
      run.notificationCandidateIds = [];
      for (const row of rows) {
        if (whitelistReason(row, task.whitelist)) {run.excluded++; continue;}
        // Price fields retain three-valued missing/stale semantics; status rules can
        // still explicitly report a collection error without inventing a price.
        const result = evaluateRules(row, task.rules);
        if (result.value === null) {run.unknown++; continue;}
        run.checked++;
        if (result.value) run.matched++;
        const observed = observe(row, result.value);
        if (!observed) continue;
        const {incident,event,notify} = observed;
        run.lifecycle[event]++;
        const id = `${run.id}:${row.id}`;
        if (notify) run.notificationCandidateIds.push(id);
        this.store.saveAlert({
          id, incidentId: incident.id, event, alertRunId: run.id, runId: source.id, taskId: task.id, ruleVersion: run.ruleVersion,
          shopId: run.shopId, shopName: run.shopName, productId: row.productId, skuId: row.skuId,
          title: row.title, specs: row.specs, backendPrice: row.backendPrice, before: row.before, after: row.after,
          discount: row.discount, reasons: event === 'recovered' ? ['本次有效检查已不再命中冻结规则'] : result.reasons, state: incident.state, note: incident.note, resolvedAt: incident.resolvedAt, createdAt: now(),
        });
      }
      run.notificationCount = run.notificationCandidateIds.length;
      if (task.notify && !run.notificationCount) run.notificationStatus = 'skipped';
      run.status = source.status === 'partial' || run.unknown ? 'partial' : 'success'; run.finishedAt = now();
      run.message = run.status === 'partial' ? '预警检查完成；来源采集覆盖不完整或存在无法判断的数据' : '预警检查完成';
      this.store.saveAlertRun(run);
    });
    this.queueNotification(run);
  }
  private queueNotification(run: AlertRunRecord): void {
    if (run.notificationStatus !== 'pending' || !run.taskSnapshot.notify || !this.notify) return;
    this.notificationQueue.add(run.id); this.kickNotifications();
  }
  private kickNotifications(): void {
    if (this.closed || this.delivering || !this.notify) return;
    this.delivering = Promise.resolve().then(async () => {
      while (!this.closed && this.notificationQueue.size) {
        const id = this.notificationQueue.values().next().value!;
        this.notificationQueue.delete(id);
        const run = this.store.getAlertRun(id);
        if (!run || run.notificationStatus !== 'pending') continue;
        try {await this.notify!(run);}
        catch {
          this.report?.('notification_failed', {runId:run.collectionRunId,evaluationId:run.id});
          const saved = this.store.getAlertRun(id)!;
          if (saved.notificationStatus !== 'accepted') {saved.notificationStatus = 'failed'; this.store.saveAlertRun(saved);}
        }
      }
    }).finally(() => {
      this.delivering = null;
      if (!this.closed && this.notificationQueue.size) this.kickNotifications();
    });
  }
}
