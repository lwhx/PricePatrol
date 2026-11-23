import {randomUUID} from 'node:crypto';
import type {Collector, CollectedRow} from '../../shared/contracts.js';
import type {Store, RunRecord} from './database.js';
import {isInvalidCredentialCode} from './collector/errors.js';
import {HttpError} from './api-context.js';
import type {DiagnosticReporter} from './diagnostics.js';

const now = () => new Date().toISOString();

/** Collects prices only. Alert dispatch happens after the collection report is committed. */
export class Worker {
  private active = new Map<string, {shopId:string;controller:AbortController}>();
  private jobs = new Map<string, Promise<void>>();
  private draining: Promise<void> | null = null;
  private closed = false;

  constructor(private store: Store, private collector: Collector,
    private onCompleted?: (run: RunRecord) => void | Promise<void>,
    private report?: DiagnosticReporter, private concurrency = 1) {
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) throw new Error('采集并发数必须是 1–4 的整数');
  }

  recover(): void {
    for (const run of this.store.operationalRuns(['running', 'queued'])) {
      run.status = 'recoverable'; run.message = '进程中断，核验账号后可继续'; this.store.saveRun(run);
    }
  }

  enqueue(shopId: string, taskId: string | null = null, productIds?: string[], scheduled = false): RunRecord {
    const shop = this.store.getShop(shopId);
    if (!shop?.enabled) throw new HttpError(400, '店铺不存在或已停用');
    if (shop.sessionStatus !== 'valid') throw new HttpError(400, '账号需要重新验证');
    const task = taskId ? this.store.getTask(taskId) : null;
    if (taskId && (!task || task.shopId !== shopId)) throw new HttpError(400, '采集任务不属于该店铺');
    if (scheduled && (!task?.enabled || task.schedule.kind === 'manual')) throw new HttpError(400, '该任务未启用定时采集');
    const trigger = scheduled ? 'scheduled' : 'manual';
    // A manual click must never merge into a scheduled run (or inherit its alerts).
    if (taskId) {
      const pending = this.store.operationalRuns(['queued', 'running']).filter(r => r.taskId === taskId && r.trigger === trigger);
      const queued = pending.find(r => r.status === 'queued');
      if (queued) {
        if (scheduled) {queued.mergedSchedules = (queued.mergedSchedules || 0) + 1; this.store.saveRun(queued);}
        return queued;
      }
      if (pending.length && !scheduled) return pending[0]!;
    }
    const ids = [...new Set(productIds ?? (task?.scope === 'selected' ? task.productIds : []))];
    const run: RunRecord = {
      id: randomUUID(), taskId, shopId, taskName: task?.name || '手动采集', shopName: shop.name,
      status: 'queued', trigger, alertDispatchStatus: scheduled ? 'pending' : 'not_applicable',
      scope: ids.length ? 'selected' : 'all', productIds: ids, expected: ids.length,
      processed: 0, failed: 0, rows: 0, checked: 0, excluded: 0, matched: 0, unknown: 0,
      message: '等待采集', createdAt: now(), startedAt: null, finishedAt: null, parentRunId: null,
      failedProductIds: [], notificationStatus: 'disabled', taskSnapshot: task ? structuredClone(task) : null,
      alertTaskSnapshots: scheduled ? structuredClone(this.store.listAlertTasks().filter(t => t.collectionTaskId === taskId && t.enabled).map(t => ({...t,notificationPolicy:t.notificationPolicy??{cooldownHours:24,notifyRecovery:false}}))) : [],
    };
    this.store.saveRun(run); this.kick(); return run;
  }

  stop(id: string): RunRecord {
    const run = this.requireRun(id);
    if (!['running', 'queued', 'auth_required', 'recoverable'].includes(run.status)) throw new HttpError(400, '该采集不能停止');
    this.active.get(id)?.controller.abort();
    run.status = 'stopped'; run.message = '已停止，可继续'; this.store.saveRun(run); return run;
  }

  resume(id: string): RunRecord {
    const run = this.requireRun(id);
    if (!['stopped', 'recoverable', 'auth_required'].includes(run.status)) throw new HttpError(400, '该采集不能继续，请重新运行或重试失败项');
    this.requireValidShop(run.shopId);
    if (this.active.has(id)) throw new HttpError(400, '正在结束请求，请稍后继续');
    // Resume preserves the original provenance and frozen alert configuration.
    run.status = 'queued'; run.message = '等待继续'; run.finishedAt = null;
    this.store.saveRun(run); this.kick(); return run;
  }

  retry(id: string): RunRecord {
    const prior = this.requireRun(id);
    if (!['success', 'partial', 'failed'].includes(prior.status) || !prior.failedProductIds.length) throw new HttpError(400, '没有可重试的失败商品');
    this.requireValidShop(prior.shopId);
    const existing = this.store.operationalRuns(['queued', 'running']).find(r => r.parentRunId === id);
    if (existing) return existing;
    // A retry is a new, explicitly manual collection, even when its parent was scheduled.
    const run: RunRecord = {
      ...structuredClone(prior), id: randomUUID(), trigger: 'manual', alertDispatchStatus: 'not_applicable', alertTaskSnapshots: [],
      status: 'queued', scope: 'selected', productIds: [...prior.failedProductIds], expected: prior.failedProductIds.length,
      processed: 0, failed: 0, rows: 0, checked: 0, excluded: 0, matched: 0, unknown: 0,
      message: '等待手动重试失败商品', createdAt: now(), startedAt: null, finishedAt: null,
      parentRunId: id, failedProductIds: [], notificationStatus: 'disabled', mergedSchedules: 0,
    };
    this.store.saveRun(run); this.kick(); return run;
  }

  async whenIdle(): Promise<void> {while (this.draining || this.jobs.size) await Promise.all([this.draining, ...this.jobs.values()]);}
  async close(): Promise<void> {this.closed = true; for (const item of this.active.values()) item.controller.abort(); await this.whenIdle();}
  private requireRun(id: string): RunRecord {const run = this.store.getRun(id); if (!run) throw new HttpError(400, '采集记录不存在'); return run;}
  private requireValidShop(id: string): void {
    const shop = this.store.getShop(id);
    if (!shop?.enabled || shop.sessionStatus !== 'valid') throw new HttpError(400, '请先验证店铺登录状态');
  }
  private kick(): void {
    if (this.closed || this.draining) return;
    this.draining = Promise.resolve().then(() => this.drain()).finally(() => {
      this.draining = null;
      if (!this.closed && this.jobs.size < this.concurrency) {
        const shops = new Set([...this.active.values()].map(item => item.shopId));
        if (this.store.operationalRuns(['queued']).some(run => !shops.has(run.shopId))) this.kick();
      }
    });
  }
  private drain(): void {
    if (this.closed) return;
    const shops = new Set([...this.active.values()].map(item => item.shopId));
    for (const run of this.store.operationalRuns(['queued'])) {
      if (this.jobs.size >= this.concurrency) break;
      if (shops.has(run.shopId)) continue;
      shops.add(run.shopId);
      const job = this.execute(run).catch(() => {
        this.report?.('collection_failed', {runId:run.id});
        const current = this.store.getRun(run.id);
        if (current && !current.finishedAt) {
          current.status = 'failed'; current.finishedAt = now(); current.message = '采集异常中止，请查看账号状态或重试';
          if (current.trigger === 'scheduled') current.alertDispatchStatus = 'skipped';
          this.store.saveRun(current);
        }
      }).finally(() => {
        this.active.delete(run.id); this.jobs.delete(run.id); this.kick();
      });
      this.jobs.set(run.id, job);
    }
  }

  private async execute(run: RunRecord): Promise<void> {
    const controller = new AbortController(); this.active.set(run.id, {shopId:run.shopId, controller});
    run.status = 'running'; run.startedAt ??= now(); run.message = '正在读取商品'; this.store.saveRun(run);
    const priorRows = this.store.getRunPrices(run.id), productStates = new Map<string, boolean>();
    run.rows = priorRows.length;
    for (const row of priorRows) productStates.set(row.productId, (productStates.get(row.productId) ?? true) && row.status === 'ok' && !row.stale);
    const completed = new Set([...productStates].filter(([,ok]) => ok).map(([id]) => id));
    const failures = new Set([...productStates].filter(([,ok]) => !ok).map(([id]) => id));
    const attempted = new Set(productStates.keys());
    const credentialVersion = this.store.getCredentialVersion(run.shopId);
    try {
      const shop = this.store.getShop(run.shopId);
      if (!shop?.enabled || shop.sessionStatus !== 'valid') throw Object.assign(Error('请先更新登录状态'), {code:'AUTH_REQUIRED'});
      const credentials = this.store.getCredentials(run.shopId);
      const result = await this.collector.collect({
        shopId: run.shopId, credentials, productIds: run.scope === 'selected' ? run.productIds : undefined,
        skipProductIds: [...completed], signal: controller.signal,
        onProgress: progress => {if (!controller.signal.aborted) {run.expected = Math.max(run.expected, progress.expected); run.message = progress.message; this.store.saveRun(run);}},
        onProduct: product => {
          if (controller.signal.aborted || completed.has(product.productId)) return;
          if (run.scope === 'selected' && !run.productIds.includes(product.productId)) throw Error('采集结果超出指定商品范围');
          this.assertProduct(run, product.rows); run.rows += this.store.saveProduct(run.id, product); attempted.add(product.productId);
          if (product.error || !product.rows.length || product.rows.some(row => row.status !== 'ok')) failures.add(product.productId);
          else {failures.delete(product.productId); completed.add(product.productId);}
          run.processed = attempted.size; run.failed = failures.size; this.store.saveRun(run);
        },
      });
      if (controller.signal.aborted) {run.status = 'stopped'; run.message = '已停止，可继续'; return;}
      // Account verification may have replaced credentials while the network request was in flight.
      const currentShop = this.store.getShop(run.shopId);
      if (currentShop && this.store.getCredentialVersion(run.shopId) === credentialVersion)
        this.store.saveShop({...currentShop, sessionStatus:'valid', lastError:null, updatedAt:now()}, {...credentials, cookies:result.cookies});
      // A saved row stays immutable even when the resumed listing reports its product missing.
      for (const id of result.failedProductIds) failures.add(id);
      if (run.scope === 'selected') run.productIds.filter(id => !completed.has(id)).forEach(id => failures.add(id));
      run.failedProductIds = [...failures]; run.failed = failures.size; run.processed = attempted.size;
      run.expected = Math.max(run.expected, result.expected); run.rows = this.store.countRunPrices(run.id);
      run.status = run.failed || !result.coverageComplete || run.processed < run.expected ? 'partial' : 'success';
      run.message = run.status === 'success' ? '采集完成' : '部分完成，请查看失败与覆盖范围'; run.finishedAt = now();
    } catch (error) {
      if (controller.signal.aborted) {run.status = 'stopped'; run.message = '已停止，可继续';}
      else if (isInvalidCredentialCode((error as {code?:unknown} | null)?.code)) {
        this.report?.('collection_auth_required', {runId:run.id});
        run.status = 'auth_required'; run.message = '登录失效或权限不足，请更新Cookie并验证后继续';
        const shop = this.store.getShop(run.shopId);
        if (shop && this.store.getCredentialVersion(run.shopId) === credentialVersion)
          this.store.saveShop({...shop, sessionStatus:'auth_required', lastError:run.message, updatedAt:now()});
      } else {
        this.report?.('collection_failed', {runId:run.id});
        run.status = 'failed'; run.finishedAt = now(); run.message = '采集失败，请查看账号状态或重试';
        if (run.scope === 'selected') run.productIds.filter(id => !completed.has(id)).forEach(id => failures.add(id));
        if (run.trigger === 'scheduled') run.alertDispatchStatus = 'skipped';
      }
    } finally {
      run.failedProductIds = [...failures]; run.failed = failures.size; run.processed = attempted.size;
      run.rows = this.store.countRunPrices(run.id);
      this.store.saveRun(run);
    }
    if (run.trigger === 'scheduled' && run.finishedAt && ['success', 'partial'].includes(run.status) && this.onCompleted) {
      // Failure here leaves a durable pending dispatch; startup recovery can safely retry it.
      try {await this.onCompleted(run);} catch {this.report?.('alert_dispatch_failed', {runId:run.id});}
    }
  }

  private assertProduct(run: RunRecord, rows: CollectedRow[]): void {
    for (const row of rows) if (row.shopId !== run.shopId || !/^[0-9]{6,20}$/.test(row.productId) || (row.skuId && !/^[0-9]{6,20}$/.test(row.skuId))) throw Error('采集结果身份校验失败');
  }
}
