import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import type { MaintenanceSettings, MaintenanceStatus } from '../../shared/operations.js';
import { HttpError } from './api-context.js';
import { backupName, copyBackup, ownedBackups, rotateBackups } from './backup.js';
import type { Store } from './database.js';
import { cleanupRetention, previewRetention, type RetentionPolicy } from './retention.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const defaults: MaintenanceSettings = {
  retentionDays: 180, alertRetentionDays: 365, cleanupEnabled: false,
  backupsEnabled: true, backupIntervalHours: 24, backupKeep: 14,
};
const fields = z.strictObject({
  retentionDays: z.number().int().min(7).max(3650),
  alertRetentionDays: z.number().int().min(7).max(3650),
  cleanupEnabled: z.boolean(),
  backupsEnabled: z.boolean(),
  backupIntervalHours: z.number().int().min(1).max(24 * 365),
  backupKeep: z.number().int().min(1).max(365),
});
const settingsPatch = fields.partial();
const settingsSchema = fields.refine(settings => settings.alertRetentionDays >= settings.retentionDays, {
  path: ['alertRetentionDays'], message: '预警证据保留期限不能短于普通历史',
});

interface Journal {
  lastRunAt: string | null;
  backupAttempt: string | null;
  cleanupAttempt: string | null;
  lastBackupAt: string | null;
  lastCleanupAt: string | null;
  lastDeleted: number;
  backupError: string | null;
  copyError: string | null;
  cleanupError: string | null;
  active: 'backup' | 'copy' | 'cleanup' | null;
}
const initialJournal: Journal = {
  lastRunAt: null, backupAttempt: null, cleanupAttempt: null, lastBackupAt: null,
  lastCleanupAt: null, lastDeleted: 0, backupError: null, copyError: null, cleanupError: null, active: null,
};
export type MaintenanceKind = 'all' | 'backup';
export interface MaintenanceOptions { dataDir: string; backupDir?: string; backupCopyDir?: string }
type CleanupResult = ReturnType<typeof cleanupRetention>;

function due(attempt: string | null, success: string | null, failed: boolean, interval: number): boolean {
  if (!attempt) return true;
  const delay = failed || !success ? HOUR : interval;
  return Date.now() >= Date.parse(attempt) + delay;
}

// Expose a stable diagnostic without recording filenames, paths or database contents in status.
function diagnostic(stage: string, error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  const reason: Record<string, string> = {
    EACCES: '权限不足', EPERM: '权限不足', ENOSPC: '空间不足', EROFS: '只读文件系统',
    ENOTDIR: '目标目录不可用', ENOENT: '目录或文件不可用', EEXIST: '目标已存在', EIO: '存储设备读写失败',
  };
  return stage + '失败' + (code && Object.hasOwn(reason, code) ? '（' + reason[code] + '）' : '');
}

export class MaintenanceService {
  private readonly directory: string;
  private readonly copyDirectory?: string;
  private readonly owner: string;
  private readonly journal: Journal;
  private current?: Promise<CleanupResult | undefined>;
  private timer?: NodeJS.Timeout;
  private closed = false;

  constructor(private readonly store: Store, options: MaintenanceOptions) {
    this.directory = resolve(options.backupDir || process.env.BACKUP_DIR || join(options.dataDir, 'backups'));
    const copy = options.backupCopyDir ?? process.env.BACKUP_COPY_DIR;
    if (copy) this.copyDirectory = resolve(copy);
    this.owner = store.transaction(() => {
      const owner = store.getConfig<string | null>('maintenance.owner', null);
      if (owner && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(owner)) return owner;
      const id = randomUUID();
      store.setConfig('maintenance.owner', id);
      return id;
    });
    this.journal = { ...initialJournal, ...store.getConfig<Partial<Journal>>('maintenance.journal', {}) };
    const active = this.journal.active;
    if (active) {
      const slot = active === 'backup' ? 'backupError' : active === 'copy' ? 'copyError' : 'cleanupError';
      this.save({ active: null, [slot]: '上次维护中断，等待重试',
        ...(this.journal.cleanupAttempt === this.journal.lastRunAt && { cleanupError: '上次清理中断，等待重试' }) });
    }
  }

  getSettings(): MaintenanceSettings {
    const retentionDays = this.store.getConfig('retentionDays', defaults.retentionDays);
    const settings = { ...defaults, ...this.store.getConfig<Partial<MaintenanceSettings>>('maintenance.settings', {}), retentionDays };
    // Older configurations persisted only retentionDays, which can exceed the newer evidence default.
    return { ...settings, alertRetentionDays: Math.max(settings.alertRetentionDays, retentionDays) };
  }

  updateSettings(input: Partial<MaintenanceSettings>): MaintenanceSettings {
    const updated = settingsSchema.parse({ ...this.getSettings(), ...settingsPatch.parse(input) });
    const { retentionDays, ...other } = updated;
    this.store.transaction(() => {
      this.store.setConfig('retentionDays', retentionDays);
      this.store.setConfig('maintenance.settings', other);
    });
    return updated;
  }

  async status(): Promise<MaintenanceStatus> {
    let backupCount = 0;
    let listingError: string | null = null;
    try { backupCount = (await ownedBackups(this.directory, this.owner)).length; }
    catch (error) { listingError = diagnostic('读取本地备份目录', error); }
    const { lastRunAt, lastBackupAt, lastCleanupAt, lastDeleted, copyError, cleanupError } = this.journal;
    const backupError = this.journal.backupError || listingError;
    const db = this.store.db;
    const databaseBytes = Number(db.prepare('PRAGMA page_count').get()?.page_count)
      * Number(db.prepare('PRAGMA page_size').get()?.page_size);
    return {
      running: Boolean(this.current), lastRunAt, lastBackupAt, lastCleanupAt, lastDeleted,
      lastError: backupError || copyError || cleanupError, backupError, copyError,
      backupCount, backupCopyConfigured: Boolean(this.copyDirectory), databaseBytes,
    };
  }

  private policy(before?: string): RetentionPolicy {
    const now = Date.now();
    const settings = this.getSettings();
    const history = before === undefined ? now - settings.retentionDays * DAY : Date.parse(before);
    if (!Number.isFinite(history) || history > now) throw new HttpError(400, '清理截止时间无效或晚于现在');
    return {
      historyBefore: new Date(history).toISOString(),
      alertBefore: new Date(Math.min(history, now - settings.alertRetentionDays * DAY)).toISOString(),
    };
  }

  preview(before?: string) {
    return previewRetention(this.store, this.policy(before));
  }

  private save(patch: Partial<Journal>) {
    this.store.setConfig('maintenance.journal', { ...this.journal, ...patch });
    Object.assign(this.journal, patch);
  }

  private async perform(cleanup?: RetentionPolicy, automaticCleanup = false): Promise<CleanupResult | undefined> {
    const at = new Date();
    const attempt = at.toISOString();
    this.save({ active: 'backup', lastRunAt: attempt, backupAttempt: attempt, ...(cleanup && { cleanupAttempt: attempt }) });
    const settings = this.getSettings();
    const file = backupName(this.owner, at);
    const local = join(this.directory, file);
    let operation = '本地备份';
    try {
      await this.store.backup(local);
      this.save({ lastBackupAt: new Date().toISOString(), backupError: null });
      operation = '轮换本地备份';
      await rotateBackups(this.directory, this.owner, settings.backupKeep, file);
      if (this.copyDirectory) {
        operation = '异地备份';
        this.save({ active: 'copy' });
        await copyBackup(local, join(this.copyDirectory, file));
        operation = '轮换异地备份';
        await rotateBackups(this.copyDirectory, this.owner, settings.backupKeep, file);
      }
      if (cleanup && automaticCleanup) {
        // A setting can change while the background snapshot is being written.
        if (!this.getSettings().cleanupEnabled) cleanup = undefined;
        else {
          const current = this.policy();
          if (current.historyBefore < cleanup.historyBefore) cleanup.historyBefore = current.historyBefore;
          if (current.alertBefore < cleanup.alertBefore) cleanup.alertBefore = current.alertBefore;
        }
      }
      operation = '历史清理';
      this.save({ active: cleanup ? 'cleanup' : null, copyError: null });
      if (cleanup) {
        const policy = cleanup;
        // Commit the counts with deletion. Update the in-memory journal only after COMMIT succeeds.
        const { result, journal } = this.store.transaction(() => {
          const result = cleanupRetention(this.store, policy);
          const journal = { ...this.journal, active: null, lastCleanupAt: new Date().toISOString(), lastDeleted: result.deleted, cleanupError: null };
          this.store.setConfig('maintenance.journal', journal);
          return { result, journal };
        });
        Object.assign(this.journal, journal);
        return result;
      }
    } catch (error) {
      const stage = this.journal.active;
      const message = diagnostic(operation, error);
      const field = stage === 'copy' ? 'copyError' : stage === 'cleanup' ? 'cleanupError' : 'backupError';
      this.save({ active: null, [field]: message, ...(cleanup && stage !== 'cleanup' && { cleanupError: '备份未完成，已跳过清理' }) });
      throw new Error(message, { cause: error });
    }
  }

  private launch(cleanup?: RetentionPolicy, automaticCleanup = false) {
    if (this.closed) throw new HttpError(503, '维护服务已关闭');
    if (this.current) throw new HttpError(409, '已有维护任务正在执行');
    this.current = this.perform(cleanup, automaticCleanup).finally(() => { this.current = undefined; });
    return this.current;
  }

  async cleanupBefore(before?: string): Promise<CleanupResult> {
    const result = await this.launch(this.policy(before));
    return result!;
  }

  private manual(kind: MaintenanceKind) {
    const settings = this.getSettings();
    if (kind === 'all' && settings.cleanupEnabled) return this.launch(this.policy(), true);
    if (kind === 'backup' || settings.backupsEnabled) return this.launch();
    throw new HttpError(400, '请先启用定期备份或自动清理');
  }

  kick(kind: MaintenanceKind): void {
    void this.manual(kind).catch(() => { /* status retains background failures */ });
  }

  async run(kind: MaintenanceKind): Promise<void> {
    await this.manual(kind);
  }

  async tick(): Promise<void> {
    if (this.closed || this.current) return;
    const settings = this.getSettings();
    const j = this.journal;
    const cleanup = settings.cleanupEnabled && due(j.cleanupAttempt, j.lastCleanupAt, Boolean(j.cleanupError), DAY);
    const backup = settings.backupsEnabled && due(j.backupAttempt, j.lastBackupAt, Boolean(j.backupError || j.copyError), settings.backupIntervalHours * HOUR);
    if (cleanup || backup) await this.launch(cleanup ? this.policy() : undefined, true);
  }

  start(): void {
    if (this.closed || this.timer) return;
    const check = () => { void this.tick().catch(() => { /* retry from the durable attempt time */ }); };
    this.timer = setInterval(check, 60_000);
    this.timer.unref();
    check();
  }

  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.timer);
    await this.current?.catch(() => {});
  }
}
