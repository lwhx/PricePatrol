import { randomUUID } from 'node:crypto';
import type { OperationsOverview, ScheduleEvent } from '../../shared/operations.js';
import { getBuildInfo } from './build-info.js';
import type { Store } from './database.js';

export type { OperationsOverview, ScheduleEvent } from '../../shared/operations.js';

const SCHEDULE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_SCHEDULE_EVENTS = 1000;
const initialized = new WeakSet<Store>();

export function initializeOperations(store: Store): void {
  if (initialized.has(store)) return;
  store.transaction(() => {
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS schedule_events (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        shop_id TEXT NOT NULL,
        scheduled_for TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        outcome TEXT NOT NULL CHECK(outcome IN ('enqueued', 'skipped', 'failed')),
        reason TEXT NOT NULL,
        run_id TEXT,
        UNIQUE(task_id, scheduled_for)
      );
      CREATE INDEX IF NOT EXISTS schedule_events_time ON schedule_events(scheduled_for DESC, id DESC);
      INSERT INTO config(key, payload) VALUES('schema.schedule-events', '1') ON CONFLICT(key) DO NOTHING;
    `);
    if (!store.getConfig<number>('schema.collection-health', 0)) initializeCollectionHealth(store);
  });
  if (!store.db.isTransaction) initialized.add(store);
}

function initializeCollectionHealth(store: Store): void {
  const newFinished = "json_extract(NEW.payload, '$.finishedAt')";
  const newStatus = "json_extract(NEW.payload, '$.status')";
  const oldAttempt = "coalesce(json_extract(OLD.payload, '$.finishedAt'), json_extract(OLD.payload, '$.startedAt'), OLD.created_at)";
  const oldStatus = "json_extract(OLD.payload, '$.status')";
  const saveReset = `
    INSERT INTO shop_collection_health(shop_id, last_success_at, reset_at, reset_id)
    VALUES(NEW.shop_id, CASE WHEN ${newStatus} = 'success' THEN ${newFinished} ELSE '' END, ${newFinished}, NEW.id)
    ON CONFLICT(shop_id) DO UPDATE SET
      last_success_at = max(last_success_at, excluded.last_success_at),
      archived_failures = CASE WHEN (excluded.reset_at, excluded.reset_id) > (reset_at, reset_id) THEN 0 ELSE archived_failures END,
      reset_id = CASE WHEN (excluded.reset_at, excluded.reset_id) > (reset_at, reset_id) THEN excluded.reset_id ELSE reset_id END,
      reset_at = max(reset_at, excluded.reset_at);
  `;
  store.db.exec(`
    CREATE TABLE shop_collection_health (
      shop_id TEXT PRIMARY KEY REFERENCES shops(id) ON DELETE CASCADE,
      last_success_at TEXT NOT NULL DEFAULT '',
      reset_at TEXT NOT NULL DEFAULT '',
      reset_id TEXT NOT NULL DEFAULT '',
      archived_failures INTEGER NOT NULL DEFAULT 0,
      archived_at TEXT NOT NULL DEFAULT '',
      archived_id TEXT NOT NULL DEFAULT '',
      archived_status TEXT
    );
    CREATE TRIGGER collection_health_insert AFTER INSERT ON runs
    WHEN ${newStatus} IN ('success', 'partial') AND ${newFinished} IS NOT NULL
    BEGIN ${saveReset} END;
    CREATE TRIGGER collection_health_update AFTER UPDATE OF payload ON runs
    WHEN ${newStatus} IN ('success', 'partial') AND ${newFinished} IS NOT NULL
      AND (${newStatus} IS NOT ${oldStatus} OR ${newFinished} IS NOT json_extract(OLD.payload, '$.finishedAt'))
    BEGIN ${saveReset} END;

    -- Cleanup only archives aggregate health facts. Retained attempts remain the source of live status.
    CREATE TRIGGER collection_health_archive AFTER DELETE ON runs
    BEGIN
      INSERT INTO shop_collection_health(shop_id) VALUES(OLD.shop_id) ON CONFLICT(shop_id) DO NOTHING;
      UPDATE shop_collection_health SET archived_failures = archived_failures + 1
        WHERE shop_id = OLD.shop_id AND ${oldStatus} IN ('failed', 'auth_required')
          AND (${oldAttempt}, OLD.id) > (reset_at, reset_id);
      UPDATE shop_collection_health SET archived_at = ${oldAttempt}, archived_id = OLD.id, archived_status = ${oldStatus}
        WHERE shop_id = OLD.shop_id AND (${oldAttempt}, OLD.id) > (archived_at, archived_id);
    END;

    WITH completed AS (
      SELECT shop_id, id, json_extract(payload, '$.finishedAt') AS finished_at, json_extract(payload, '$.status') AS status
      FROM runs WHERE json_extract(payload, '$.status') IN ('success', 'partial') AND json_extract(payload, '$.finishedAt') IS NOT NULL
    ), ranked AS (
      SELECT shop_id, id, finished_at,
        row_number() OVER(PARTITION BY shop_id ORDER BY finished_at DESC, id DESC) AS position,
        max(CASE WHEN status = 'success' THEN finished_at ELSE '' END) OVER(PARTITION BY shop_id) AS last_success
      FROM completed
    )
    INSERT INTO shop_collection_health(shop_id, last_success_at, reset_at, reset_id)
      SELECT shop_id, last_success, finished_at, id FROM ranked WHERE position = 1;
  `);
  store.setConfig('schema.collection-health', 1);
}

export function scheduleRetentionStart(at: Date): Date {
  return new Date(at.getTime() - SCHEDULE_RETENTION_MS);
}

export function hasScheduleEvent(store: Store, taskId: string, scheduledFor: string): boolean {
  return !!store.db.prepare('SELECT 1 FROM schedule_events WHERE task_id = ? AND scheduled_for = ?').get(taskId, scheduledFor);
}

export function recordScheduleEvent(store: Store, event: Omit<ScheduleEvent, 'id'>): boolean {
  return store.db.prepare(`
    INSERT INTO schedule_events (id, task_id, shop_id, scheduled_for, recorded_at, outcome, reason, run_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(task_id, scheduled_for) DO NOTHING
  `).run(randomUUID(), event.taskId, event.shopId, event.scheduledFor, event.recordedAt, event.outcome, event.reason, event.runId).changes === 1;
}

export function pruneScheduleEvents(store: Store, at: Date): void {
  store.transaction(() => {
    store.db.prepare('DELETE FROM schedule_events WHERE scheduled_for < ?').run(scheduleRetentionStart(at).toISOString());
    store.db.prepare(`
      DELETE FROM schedule_events WHERE id IN (
        SELECT id FROM schedule_events ORDER BY scheduled_for DESC, id DESC LIMIT -1 OFFSET ?
      )
    `).run(MAX_SCHEDULE_EVENTS);
  });
}

export function getOperations(store: Store, at = new Date()): OperationsOverview {
  initializeOperations(store);
  const health = store.db.prepare(`
    WITH attempts AS (
      SELECT shop_id, id, json_extract(payload, '$.status') AS status,
        coalesce(json_extract(payload, '$.finishedAt'), json_extract(payload, '$.startedAt'), created_at) AS attempt_at
      FROM runs
    ), ranked AS (
      SELECT *, row_number() OVER(PARTITION BY shop_id ORDER BY attempt_at DESC, id DESC) AS position FROM attempts
    )
    SELECT ranked.shop_id,
      max(CASE WHEN position = 1 THEN attempt_at END) AS last_attempt_at,
      max(CASE WHEN position = 1 THEN id END) AS last_attempt_id,
      max(CASE WHEN position = 1 THEN status END) AS last_status,
      sum(CASE WHEN status IN ('failed', 'auth_required') AND
        (attempt_at, id) > (coalesce(checkpoint.reset_at, ''), coalesce(checkpoint.reset_id, ''))
        THEN 1 ELSE 0 END) AS consecutive_failures
    FROM ranked LEFT JOIN shop_collection_health checkpoint ON checkpoint.shop_id = ranked.shop_id
    GROUP BY ranked.shop_id
  `).all();
  const byShop = new Map(health.map(row => [row.shop_id, row]));
  const checkpoints = store.db.prepare('SELECT * FROM shop_collection_health').all();
  const checkpointByShop = new Map(checkpoints.map(row => [row.shop_id, row]));
  const shops = store.listShops().map(shop => {
    const metric = byShop.get(shop.id);
    const checkpoint = checkpointByShop.get(shop.id);
    const lastSuccessAt = String(checkpoint?.last_success_at || '') || null;
    const lastSuccessMs = lastSuccessAt ? Date.parse(lastSuccessAt) : NaN;
    const retainedAt = String(metric?.last_attempt_at || '');
    const archivedAt = String(checkpoint?.archived_at || '');
    const archivedIsLatest = archivedAt > retainedAt ||
      (archivedAt === retainedAt && String(checkpoint?.archived_id || '') > String(metric?.last_attempt_id || ''));
    const lastStatus = archivedIsLatest ? checkpoint?.archived_status : metric?.last_status;
    return {
      shopId: shop.id,
      shopName: shop.name,
      lastSuccessAt,
      dataAgeSeconds: Number.isFinite(lastSuccessMs) ? Math.max(0, Math.floor((at.getTime() - lastSuccessMs) / 1000)) : null,
      consecutiveFailures: Number(metric?.consecutive_failures ?? 0) + Number(checkpoint?.archived_failures ?? 0),
      lastAttemptAt: (archivedIsLatest ? archivedAt : retainedAt) || null,
      lastStatus: typeof lastStatus === 'string' ? lastStatus : null,
    };
  });
  const collection = store.db.prepare(`
    SELECT count(*) FILTER (WHERE json_extract(payload, '$.status') = 'queued') AS queued,
      count(*) FILTER (WHERE json_extract(payload, '$.status') = 'running') AS running
    FROM runs
  `).get()!;
  const alerts = store.db.prepare(`
    WITH evaluations AS (
      SELECT json_extract(payload, '$.status') AS status, json_extract(payload, '$.notificationStatus') AS notification,
        json_extract(payload, '$.finishedAt') AS finished_at FROM alert_runs
    )
    SELECT count(*) FILTER (WHERE status = 'queued') AS queued,
      count(*) FILTER (WHERE status = 'running') AS running,
      count(*) FILTER (WHERE notification = 'sending' OR
        (notification = 'pending' AND finished_at IS NOT NULL AND status IN ('success', 'partial'))) AS pending,
      count(*) FILTER (WHERE notification = 'failed') AS failed
    FROM evaluations
  `).get()!;
  const recentSchedules = store.db.prepare(`
    SELECT id, task_id AS taskId, shop_id AS shopId, scheduled_for AS scheduledFor, recorded_at AS recordedAt,
      outcome, reason, run_id AS runId FROM schedule_events
    WHERE scheduled_for >= ? ORDER BY scheduled_for DESC, id DESC LIMIT 100
  `).all(scheduleRetentionStart(at).toISOString()) as unknown as ScheduleEvent[];
  return {
    shops,
    queues: {
      collectionQueued: Number(collection.queued), collectionRunning: Number(collection.running),
      alertQueued: Number(alerts.queued), alertRunning: Number(alerts.running),
      notificationPending: Number(alerts.pending), notificationFailed: Number(alerts.failed),
    },
    recentSchedules,
    build: getBuildInfo(store),
  };
}
