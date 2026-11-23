import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { AlertTask, Condition, PriceRow, RuleGroup } from '../../shared/contracts.js';
import type { Incident, IncidentEvent, IncidentState, IncidentStatus } from '../../shared/incidents.js';
import type { AlertRunRecord, RunRecord, Store } from './database.js';
import { evaluateCondition, moneyCents } from './domain.js';
import { HttpError } from './api-context.js';

export function initializeIncidents(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS alert_incidents(
    id TEXT PRIMARY KEY, identity TEXT NOT NULL, alert_task_id TEXT NOT NULL, payload TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS incidents_identity ON alert_incidents(identity,json_extract(payload,'$.firstSeenAt') DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS incidents_active ON alert_incidents(identity) WHERE json_extract(payload,'$.status')='active';
    CREATE INDEX IF NOT EXISTS incidents_task ON alert_incidents(alert_task_id);
    CREATE INDEX IF NOT EXISTS incidents_listing ON alert_incidents(json_extract(payload,'$.status'),json_extract(payload,'$.lastSeenAt') DESC,id DESC);
    CREATE TABLE IF NOT EXISTS alert_observation_order(
      identity TEXT PRIMARY KEY,source_at TEXT NOT NULL,source_id TEXT NOT NULL);
    INSERT OR IGNORE INTO config(key,payload) VALUES('schema.incidents','1');`);
  const version = Number(db.prepare("SELECT payload FROM config WHERE key='schema.incidents'").get()?.payload);
  if (version >= 2) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    if (Number(db.prepare("SELECT payload FROM config WHERE key='schema.incidents'").get()?.payload) >= 2) {
      db.exec('COMMIT');
      return;
    }
    // The sequence is assigned when a scheduled source is inserted. INTEGER PRIMARY KEY survives VACUUM/restore.
    db.exec(`CREATE TABLE incident_source_sequence(
        id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT UNIQUE NOT NULL REFERENCES runs(id) ON DELETE CASCADE);
      INSERT INTO incident_source_sequence(run_id) SELECT id FROM runs WHERE json_extract(payload,'$.trigger')='scheduled' ORDER BY rowid;
      CREATE TRIGGER incident_source_sequence_insert AFTER INSERT ON runs WHEN json_extract(NEW.payload,'$.trigger')='scheduled'
        BEGIN INSERT INTO incident_source_sequence(run_id) VALUES(NEW.id); END;
      ALTER TABLE alert_observation_order ADD COLUMN source_sequence INTEGER NOT NULL DEFAULT 0;
      CREATE TABLE incident_notification_reservations(
        incident_id TEXT NOT NULL REFERENCES alert_incidents(id) ON DELETE CASCADE,
        run_id TEXT NOT NULL REFERENCES alert_runs(id) ON DELETE CASCADE,reserved_at TEXT NOT NULL,
        PRIMARY KEY(incident_id,run_id));
      CREATE INDEX incident_reservation_time ON incident_notification_reservations(incident_id,reserved_at);
      CREATE INDEX incident_reservation_owner ON incident_notification_reservations(run_id);
      CREATE INDEX incident_reservation_expiry ON incident_notification_reservations(reserved_at);
      CREATE TRIGGER incident_retained_cooldown BEFORE DELETE ON alert_runs
      WHEN json_extract(OLD.payload,'$.notificationStatus') IN ('accepted','sending','failed') BEGIN
        UPDATE alert_incidents SET payload=json_set(payload,'$.lastReservedAt',max(coalesce(json_extract(payload,'$.lastReservedAt'),''),
          (SELECT reserved_at FROM incident_notification_reservations WHERE incident_id=alert_incidents.id AND run_id=OLD.id)))
          WHERE id IN (SELECT incident_id FROM incident_notification_reservations WHERE run_id=OLD.id);
      END;`);
    upgradeWatermarks(db);
    upgradeReservations(db);
    db.exec("UPDATE config SET payload='2' WHERE key='schema.incidents'; COMMIT");
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

}

const textFields = new Set(['title', 'specs', 'productId', 'skuId', 'status']);
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const unique = (values: string[]) => [...new Set(values)].sort();

function canonicalCondition(condition: Condition): string {
  const { field, op } = condition;
  function value(raw: string) {
    if (op === 'in' || op === 'notIn') return unique(raw.split(/[\s,，;；]+/));
    if (textFields.has(field)) return raw;
    const number = field === 'discount' ? raw.trim().replace(/折$/, '') : raw;
    const negative = number.startsWith('-');
    const cents = moneyCents(negative ? number.slice(1) : number);
    return cents === null ? raw : (negative ? -cents : cents);
  }
  const parts: unknown[] = [field, op, value(condition.value)];
  if (op === 'between') parts.push(value(condition.upper ?? ''), condition.includeLower !== false, condition.includeUpper !== false);
  return JSON.stringify(parts);
}

export function ruleFingerprint(rules: RuleGroup[]): string {
  // Groups combine with AND. Expand nested ANDs and normalize order, duplicate predicates and numeric literals.
  const clauses = rules.flatMap(group => {
    const terms = unique(group.conditions.map(canonicalCondition));
    return group.mode === 'all' ? terms.map(term => JSON.stringify([term])) : [JSON.stringify(terms)];
  });
  return hash(unique(clauses));
}

function upgradeWatermarks(db: DatabaseSync): void {
  // A retained v1 source can have several frozen rules and several SKUs with different observation times.
  const prices = db.prepare('SELECT payload FROM prices WHERE run_id=?');
  const update = db.prepare('UPDATE alert_observation_order SET source_at=?,source_sequence=? WHERE identity=? AND source_id=?');
  const sources = db.prepare(`SELECT r.id,r.payload,s.id AS sequence FROM
    (SELECT DISTINCT source_id FROM alert_observation_order) w JOIN runs r ON r.id=w.source_id
    JOIN incident_source_sequence s ON s.run_id=r.id`);
  for (const source of sources.iterate()) {
    const snapshots: AlertTask[] = JSON.parse(String(source.payload)).alertTaskSnapshots ?? [];
    const tasks = snapshots.map(task => ({ id: task.id, fingerprint: ruleFingerprint(task.rules) }));
    for (const price of prices.iterate(source.id)) {
      const row: PriceRow = JSON.parse(String(price.payload));
      for (const task of tasks) update.run(row.updatedAt, source.sequence,
        hash([task.id, task.fingerprint, row.shopId, row.productId, row.skuId]), source.id);
    }
  }
  // If v1 already expired the source, its original watermark is the surviving lower bound.
  // Treat same-time samples as older when the original tie cannot be reconstructed.
  db.exec('UPDATE alert_observation_order SET source_sequence=9223372036854775807 WHERE source_sequence=0');
}

const maxCooldown = 8760 * 3_600_000;
function upgradeReservations(db: DatabaseSync): void {
  // Rebuild v1 reservations from immutable candidates and their durable delivery disposition without any delivery.
  db.exec(`CREATE TEMP TABLE migrated_incident_reservations AS
    SELECT i.id AS incident_id,e.id AS run_id,json_extract(a.payload,'$.createdAt') AS reserved_at,
      json_extract(e.payload,'$.notificationStatus') AS status
    FROM alert_runs e JOIN json_each(e.payload,'$.notificationCandidateIds') c
    JOIN alerts a ON a.id=c.value JOIN alert_incidents i ON i.id=json_extract(a.payload,'$.incidentId');
    INSERT OR IGNORE INTO incident_notification_reservations
      SELECT incident_id,run_id,reserved_at FROM migrated_incident_reservations WHERE status IN ('pending','accepted','sending','failed');
    CREATE INDEX migrated_incident_reservations_owner ON migrated_incident_reservations(incident_id,reserved_at);
    UPDATE alert_incidents SET payload=json_set(payload,'$.lastReservedAt',NULL)
      WHERE EXISTS (SELECT 1 FROM migrated_incident_reservations m WHERE m.incident_id=alert_incidents.id
        AND m.reserved_at>=coalesce(json_extract(alert_incidents.payload,'$.lastReservedAt'),''));
    DROP TABLE migrated_incident_reservations;`);
}

export function releaseUnsentReservations(store: Store, run: AlertRunRecord): void {
  store.db.prepare('DELETE FROM incident_notification_reservations WHERE run_id=?').run(run.id);
}

export function reserveFrozenSubmission(store: Store, run: AlertRunRecord): void {
  if (!run.notificationCandidateIds?.length) return;
  // Explicit retry of a previously disabled delivery again owns a reservation for its original candidate subset.
  store.db.prepare(`INSERT OR IGNORE INTO incident_notification_reservations(incident_id,run_id,reserved_at)
    SELECT json_extract(a.payload,'$.incidentId'),?,? FROM json_each(?) c JOIN alerts a ON a.id=c.value
    WHERE a.alert_run_id=? AND json_extract(a.payload,'$.incidentId') IS NOT NULL`)
    .run(run.id, new Date().toISOString(), JSON.stringify(run.notificationCandidateIds), run.id);
}

export function supersedeTaskIncidents(db: DatabaseSync, taskId: string, rules?: RuleGroup[]): void {
  const current = rules ? ruleFingerprint(rules) : null;
  db.prepare(`UPDATE alert_incidents SET payload=json_set(payload,'$.status','superseded')
    WHERE alert_task_id=? AND json_extract(payload,'$.status')='active'
    AND (? IS NULL OR json_extract(payload,'$.ruleFingerprint')!=?)`).run(taskId, current, current);
}

type Metric = [numerator: string, denominator: string];
type Metrics = Record<string, Metric>;
interface StoredIncident extends Incident { metrics: Metrics; lastReservedAt: string | null }

function measures(row: PriceRow, rules: RuleGroup[]): Metrics {
  const metrics: Metrics = {};
  const parts = [row.backendPrice, row.after, row.before].map(value => {
    const cents = moneyCents(value);
    return cents === null ? null : BigInt(cents);
  });
  const [base, after, before] = parts;
  for (const group of rules) for (const condition of group.conditions) {
    const { field, op } = condition;
    if (!['lt', 'lte', 'gt', 'gte'].includes(op) || evaluateCondition(row, condition) !== true) continue;
    let n: bigint | null, d = 1n;
    switch (field) {
      case 'discount': n = after; d = base ?? 0n; break;
      case 'backendPrice': n = base; break;
      case 'after': n = after; break;
      case 'before': n = before; break;
      case 'saving': n = base !== null && after !== null ? base - after : null; break;
      case 'priceDifference': n = before !== null && base !== null ? before - base : null; break;
      default: continue;
    }
    if (n !== null && d > 0n) metrics[canonicalCondition(condition)] = [String(op === 'lt' || op === 'lte' ? -n : n), String(d)];
  }
  return metrics;
}

function worsened(prior: Metrics, current: Metrics): boolean {
  const keys = Object.keys(current);
  if (!keys.length || keys.length !== Object.keys(prior).length) return false;
  let worse = false;
  for (const key of keys) {
    if (!prior[key]) return false;
    const [a, b] = prior[key], [c, d] = current[key];
    const change = BigInt(c) * BigInt(b) - BigInt(a) * BigInt(d);
    if (change < 0n) return false;
    if (change > 0n) worse = true;
  }
  return worse;
}

function save(db: DatabaseSync, incident: StoredIncident): void {
  db.prepare(`INSERT INTO alert_incidents(id,identity,alert_task_id,payload) VALUES(?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET payload=excluded.payload`).run(incident.id, incident.identity, incident.alertTaskId, JSON.stringify(incident));
}
function publicIncident(incident: StoredIncident): Incident {
  const { metrics, lastReservedAt, ...result } = incident;
  return result;
}
function decode(row?: Record<string, unknown>): StoredIncident | undefined {
  return row ? JSON.parse(String(row.payload)) as StoredIncident : undefined;
}

export function listIncidents(store: Store, filter: {
  status: IncidentStatus | 'all'; state?: IncidentState; shopId?: string; alertTaskId?: string; page: number; pageSize: number;
}): { incidents: Incident[]; total: number; page: number; pageSize: number } {
  const clauses: string[] = [], args: string[] = [];
  for (const [key, column] of [['status', "json_extract(payload,'$.status')"], ['state', "json_extract(payload,'$.state')"],
    ['shopId', "json_extract(payload,'$.shopId')"], ['alertTaskId', 'alert_task_id']] as const) {
    const value = filter[key];
    if (value && !(key === 'status' && value === 'all')) { clauses.push(column + '=?'); args.push(value); }
  }
  const where = clauses.length ? ' WHERE ' + clauses.join(' AND ') : '';
  const total = Number(store.db.prepare('SELECT count(*) AS n FROM alert_incidents' + where).get(...args)?.n);
  const rows = store.db.prepare(`SELECT payload FROM alert_incidents ${where}
    ORDER BY json_extract(payload,'$.lastSeenAt') DESC,id DESC LIMIT ? OFFSET ?`)
    .all(...args, filter.pageSize, (filter.page - 1) * filter.pageSize);
  return { incidents: rows.map(row => publicIncident(decode(row)!)), total, page: filter.page, pageSize: filter.pageSize };
}

export function getIncident(store: Store, id: string): Incident {
  const incident = decode(store.db.prepare('SELECT payload FROM alert_incidents WHERE id=?').get(id));
  if (!incident) throw new HttpError(404, '异常事件不存在');
  return publicIncident(incident);
}

export function updateIncident(store: Store, id: string, patch: {state?: IncidentState; note?: string}): Incident {
  return store.transaction(() => {
    const incident = decode(store.db.prepare('SELECT payload FROM alert_incidents WHERE id=?').get(id));
    if (!incident) throw new HttpError(404, '异常事件不存在');
    if (patch.state && patch.state !== incident.state) {
      incident.state = patch.state;
      incident.resolvedAt = patch.state === 'resolved' ? new Date().toISOString() : null;
    }
    if (patch.note !== undefined) incident.note = patch.note;
    save(store.db, incident);
    return publicIncident(incident);
  });
}

export function beginObservations(store: Store, run: AlertRunRecord, source: RunRecord) {
  const task = run.taskSnapshot, fingerprint = ruleFingerprint(task.rules);
  const live = store.getAlertTask(task.id);
  const superseded = !live || ruleFingerprint(live.rules) !== fingerprint;
  // Keep one authoritative source watermark per SKU/rule, including clean observations.
  // Missing rows in a newer partial batch cannot suppress another SKU's first valid observation.
  const lastSource = store.db.prepare('SELECT source_at,CAST(source_sequence AS TEXT) AS seq FROM alert_observation_order WHERE identity=?');
  const sourceSequence = BigInt(String(store.db.prepare('SELECT CAST(id AS TEXT) AS seq FROM incident_source_sequence WHERE run_id=?').get(source.id)!.seq));
  const recordSource = store.db.prepare(`INSERT INTO alert_observation_order(identity,source_at,source_id,source_sequence) VALUES(?,?,?,?)
    ON CONFLICT(identity) DO UPDATE SET source_at=excluded.source_at,source_id=excluded.source_id,source_sequence=excluded.source_sequence`);
  store.db.prepare('DELETE FROM incident_notification_reservations WHERE reserved_at<?').run(new Date(Date.now()-maxCooldown).toISOString());
  const lastReservation = store.db.prepare('SELECT max(reserved_at) AS at FROM incident_notification_reservations WHERE incident_id=?');
  const reserve = store.db.prepare('INSERT INTO incident_notification_reservations VALUES(?,?,?)');
  const at = new Date().toISOString();
  const failed = new Set(source.failedProductIds);
  const policy = task.notificationPolicy ?? { cooldownHours: 24, notifyRecovery: false };
  const lookup = store.db.prepare(`SELECT payload FROM alert_incidents WHERE identity=?
    ORDER BY json_extract(payload,'$.firstSeenAt') DESC,rowid DESC LIMIT 1`);

  return (row: PriceRow, match: boolean): { incident: Incident; event: IncidentEvent; notify: boolean } | null => {
    if (!match && (row.stale || row.status !== 'ok' || failed.has(row.productId) ||
        task.rules.some(group => group.conditions.some(condition => evaluateCondition(row, condition) === null)))) return null;
    const identity = hash([task.id, fingerprint, row.shopId, row.productId, row.skuId]);
    const previous = lastSource.get(identity);
    const observedAt = Date.parse(row.updatedAt);
    const priorAt = previous ? Date.parse(String(previous.source_at)) : -Infinity;
    const earlier = previous && (observedAt < priorAt || observedAt === priorAt && sourceSequence < BigInt(String(previous.seq)));
    if (!earlier) recordSource.run(identity, row.updatedAt, source.id, sourceSequence);
    if (earlier && !match) return null;
    const last = decode(lookup.get(identity));
    const open = last && (last.status === 'active' || superseded && last.status === 'superseded' && last.lastEvent !== 'recovered');
    if (!match && !open) return null;
    // Late matches keep their immutable evidence without altering current incidents.
    if (earlier && last) return { incident: publicIncident(last), event: 'continuing', notify: false };
    const metrics = match ? measures(row, task.rules) : {};
    const event: IncidentEvent = !match ? 'recovered' : !open ? 'first' : worsened(last!.metrics, metrics) ? 'worsened' : 'continuing';
    const incident: StoredIncident = open ? last! : {
      id: randomUUID(), identity, ruleFingerprint: fingerprint, alertTaskId: task.id, shopId: row.shopId, shopName: run.shopName,
      productId: row.productId, skuId: row.skuId, title: row.title, specs: row.specs, status: 'active',
      state: 'pending', note: '', resolvedAt: null, firstSeenAt: at, lastSeenAt: at,
      firstCollectionRunId: source.id, lastCollectionRunId: source.id, lastAlertRunId: run.id,
      lastEvent: event, metrics: {}, lastReservedAt: null,
    };
    incident.status = superseded || earlier ? 'superseded' : match ? 'active' : 'recovered';
    incident.title = row.title; incident.specs = row.specs; incident.shopName = run.shopName;
    incident.lastCollectionRunId = source.id; incident.lastAlertRunId = run.id;
    incident.lastSeenAt = at; incident.lastEvent = event; incident.metrics = metrics;
    const reservation = String(lastReservation.get(incident.id)?.at ?? '');
    const reservedAt = reservation > (incident.lastReservedAt ?? '') ? reservation : incident.lastReservedAt;
    const cooled = !reservedAt || Date.parse(at) - Date.parse(reservedAt) >= policy.cooldownHours * 3_600_000;
    const notify = !earlier && task.notify && (event === 'recovered' ? policy.notifyRecovery : event !== 'continuing' || cooled);
    save(store.db, incident);
    if (notify) reserve.run(incident.id, run.id, at);
    return { incident: publicIncident(incident), event, notify };
  };
}
