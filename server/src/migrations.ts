import type {DatabaseSync} from 'node:sqlite';
import type {AlertTask, CollectionTask, MonitorTask} from '../../shared/contracts.js';

/** SQLite DDL is transactional: either the complete split is visible, or none of it. */
export function migrateCollectionAlerts(db: DatabaseSync): void {
  const version = db.prepare("SELECT payload FROM config WHERE key='schema.collection-alerts'").get();
  if (version && JSON.parse(String(version.payload)) >= 1) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS alert_tasks (
        id TEXT PRIMARY KEY, collection_task_id TEXT NOT NULL REFERENCES tasks(id),
        shop_id TEXT NOT NULL REFERENCES shops(id), payload TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS alert_runs (
        id TEXT PRIMARY KEY, collection_run_id TEXT NOT NULL REFERENCES runs(id),
        alert_task_id TEXT NOT NULL REFERENCES alert_tasks(id), created_at TEXT NOT NULL, payload TEXT NOT NULL,
        UNIQUE(collection_run_id,alert_task_id)
      );
      CREATE INDEX IF NOT EXISTS alert_runs_source ON alert_runs(collection_run_id);
      CREATE TABLE alerts_split (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), shop_id TEXT NOT NULL REFERENCES shops(id),
        product_id TEXT NOT NULL, sku_id TEXT NOT NULL, payload TEXT NOT NULL,
        alert_run_id TEXT REFERENCES alert_runs(id)
      );
      INSERT INTO alerts_split(id,run_id,shop_id,product_id,sku_id,payload)
        SELECT id,run_id,shop_id,product_id,sku_id,payload FROM alerts;
      DROP TABLE alerts;
      ALTER TABLE alerts_split RENAME TO alerts;
      CREATE UNIQUE INDEX alerts_evaluation_sku ON alerts(coalesce(alert_run_id,''),run_id,shop_id,product_id,sku_id);
      ALTER TABLE shops ADD COLUMN credential_version INTEGER NOT NULL DEFAULT 0;
    `);
    for (const row of db.prepare('SELECT id,payload,deleted FROM tasks').all()) {
      const legacy = JSON.parse(String(row.payload)) as MonitorTask;
      const {rules, whitelist, notify, ...collection} = legacy;
      if (Array.isArray(rules)) {
        const task: AlertTask = {id:legacy.id,collectionTaskId:legacy.id,shopId:legacy.shopId,name:legacy.name,
          enabled:legacy.enabled,scope:legacy.scope,productIds:legacy.productIds,rules,
          whitelist:whitelist || {productIds:[],titleKeywords:[]},notify:!!notify,
          version:legacy.version,createdAt:legacy.createdAt,updatedAt:legacy.updatedAt};
        db.prepare('INSERT INTO alert_tasks VALUES(?,?,?,?,?)').run(task.id,task.collectionTaskId,task.shopId,JSON.stringify(task),Number(row.deleted));
      }
      db.prepare('UPDATE tasks SET payload=? WHERE id=?').run(JSON.stringify(collection satisfies CollectionTask),String(row.id));
    }
    // Provenance cannot be inferred from an old task's schedule: old manual runs used it too.
    db.exec(`UPDATE runs SET payload=json_set(payload,'$.trigger','legacy','$.alertDispatchStatus','not_applicable','$.alertTaskSnapshots',json('[]'))`);
    db.prepare("INSERT INTO config(key,payload) VALUES('schema.collection-alerts','1')").run();
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
