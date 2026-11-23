import type {Store} from './database.js';
import {COLLECTION_SUBMISSION_TTL_MS} from './collection-submissions.js';
import type {RetentionPolicy,CleanupPreview} from '../../shared/operations.js';
export type {RetentionPolicy,CleanupPreview} from '../../shared/operations.js';

// Parent identity is required whenever an unfinished retry saves progress or resumes.
export const unfinishedRetryParentGuard = (alias:string) => `AND NOT EXISTS(
 SELECT 1 FROM runs child WHERE json_extract(child.payload,'$.parentRunId')=${alias}.id
 AND (json_extract(child.payload,'$.finishedAt') IS NULL
 OR json_extract(child.payload,'$.status') NOT IN('success','partial','failed'))
)`;

function candidates(store:Store,policy:RetentionPolicy):void {
 const history=Date.parse(policy.historyBefore),alerts=Date.parse(policy.alertBefore);
 if(!Number.isFinite(history)||!Number.isFinite(alerts)||alerts>history)throw Error('预警证据保留期限不能短于普通历史');
 const hasIncidents=!!store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='alert_incidents'").get();
 const hasReceipts=!!store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='collection_submissions'").get();
 const receiptProtection=hasReceipts?'AND r.id NOT IN(SELECT run_id FROM collection_submissions WHERE submitted_at>?)':'';
 const incidentProtection=hasIncidents?`AND r.id NOT IN (
   SELECT json_extract(payload,'$.firstCollectionRunId') FROM alert_incidents WHERE json_extract(payload,'$.status')='active' AND json_extract(payload,'$.firstCollectionRunId') IS NOT NULL
   UNION SELECT json_extract(payload,'$.lastCollectionRunId') FROM alert_incidents WHERE json_extract(payload,'$.status')='active' AND json_extract(payload,'$.lastCollectionRunId') IS NOT NULL
 )`:'';
 const evidenceJoin=hasIncidents?"LEFT JOIN alert_incidents i ON i.id=json_extract(a.payload,'$.incidentId')":'';
 const evidencePayload=hasIncidents?"CASE WHEN json_extract(a.payload,'$.incidentId') IS NOT NULL THEN i.payload ELSE a.payload END":'a.payload';
 const evidenceResolved=`coalesce(json_extract(${evidencePayload},'$.resolvedAt'),CASE WHEN json_extract(a.payload,'$.incidentId') IS NULL THEN json_extract(a.payload,'$.createdAt') END)`;
 store.db.exec('CREATE TEMP TABLE IF NOT EXISTS retention_candidates(id TEXT PRIMARY KEY); DELETE FROM retention_candidates');
 store.db.prepare(`INSERT INTO retention_candidates
  SELECT r.id FROM runs r
  WHERE json_extract(r.payload,'$.finishedAt') IS NOT NULL
   AND julianday(json_extract(r.payload,'$.finishedAt'))<julianday(?)
   AND json_extract(r.payload,'$.status') IN('success','partial','failed')
   AND coalesce(json_extract(r.payload,'$.alertDispatchStatus'),'not_applicable')!='pending'
   AND NOT EXISTS(SELECT 1 FROM latest l WHERE l.run_id=r.id)
   AND NOT EXISTS(SELECT 1 FROM alerts a ${evidenceJoin} WHERE a.run_id=r.id AND (
    coalesce(json_extract(${evidencePayload},'$.state'),'pending')!='resolved'
    OR julianday(${evidenceResolved}) IS NULL
    OR julianday(${evidenceResolved})>=julianday(?)
    OR julianday(json_extract(a.payload,'$.createdAt'))>=julianday(?)
   ))
   AND NOT EXISTS(SELECT 1 FROM alert_runs e WHERE e.collection_run_id=r.id AND (
    json_extract(e.payload,'$.finishedAt') IS NULL
    OR json_extract(e.payload,'$.status') NOT IN('success','partial','failed')
    OR coalesce(json_extract(e.payload,'$.notificationStatus'),'pending') IN('pending','sending','failed','not_configured')
    OR (coalesce(json_extract(e.payload,'$.matched'),0)>0 AND julianday(json_extract(e.payload,'$.finishedAt'))>=julianday(?))
   )) ${incidentProtection} ${receiptProtection} ${unfinishedRetryParentGuard('r')}`).run(policy.historyBefore,policy.alertBefore,policy.alertBefore,policy.alertBefore,...(hasReceipts?[Date.now()-COLLECTION_SUBMISSION_TTL_MS]:[]));
}

function counts(store:Store,policy:RetentionPolicy):CleanupPreview {
 const count=(sql:string,...args:string[])=>Number(store.db.prepare(sql).get(...args)?.n||0);
 const runs=count('SELECT count(*) n FROM retention_candidates');
 const prices=count('SELECT count(*) n FROM prices WHERE run_id IN(SELECT id FROM retention_candidates)');
 const alertRuns=count('SELECT count(*) n FROM alert_runs WHERE collection_run_id IN(SELECT id FROM retention_candidates)');
 const alerts=count('SELECT count(*) n FROM alerts WHERE run_id IN(SELECT id FROM retention_candidates)');
 const older=count("SELECT count(*) n FROM runs WHERE json_extract(payload,'$.finishedAt') IS NOT NULL AND julianday(json_extract(payload,'$.finishedAt'))<julianday(?)",policy.historyBefore);
 return {policy,runs,prices,alertRuns,alerts,protectedRuns:older-runs,total:runs+prices+alertRuns+alerts};
}

/** Preview and execution deliberately share the same candidate selection. */
export function previewRetention(store:Store,policy:RetentionPolicy):CleanupPreview {
 return store.transaction(()=>{candidates(store,policy);return counts(store,policy);});
}

export function cleanupRetention(store:Store,policy:RetentionPolicy):CleanupPreview&{deleted:number} {
 return store.transaction(()=>{
  candidates(store,policy);const result=counts(store,policy);
  for(const [table,column] of [['alerts','run_id'],['alert_runs','collection_run_id'],['prices','run_id'],['runs','id']])
   store.db.prepare(`DELETE FROM ${table} WHERE ${column} IN(SELECT id FROM retention_candidates)`).run();
  return {...result,deleted:result.total};
 });
}
