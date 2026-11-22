# Collection and alert separation implementation plan

> **For agentic workers:** Follow the frozen interfaces below; implement independently owned files, then perform an independent whole-branch review.

**Goal:** Only scheduled collections automatically dispatch independent alert evaluations; all manual collections remain data-only.

**Architecture:** Keep collection jobs in the existing task/run tables. Add alert task/run persistence, transactional migration, durable source attribution, and an independent evaluation/notification worker with unique source-batch dispatch.

**Tech Stack:** Node.js 24, TypeScript, Fastify, SQLite, Vue 3, Vitest.

**Spec:** ../specs/2026-11-23-collection-alerts-design.md

## Global constraints

- No real merchant requests or real notification deliveries in tests.
- Existing data must survive migration; legacy runs never auto-dispatch.
- Manual and scheduled provenance is determined by server entry points, not client input.
- Preserve frozen historical reports and exact integer-money comparisons.
- Keep source changes on feat/separate-collection-alerts; deliver a reviewable PR without merging/deploying.

## Review focus

- Manual/automatic coalescing must not elevate a manual run into an alert-triggering run.
- Recovery after collection commit must dispatch once even if the process died before evaluation.
- Multiple alert tasks on one batch must not collide on the existing SKU unique constraint.
- Migration must preserve old tasks, alerts, credentials and query context without replaying notifications.
- Delayed collection callbacks must not overwrite newer credentials or discard recovered prices.

## Task 1: persistence and collection lifecycle

Files: shared/contracts.ts; server/src/database.ts; server/src/validation.ts; server/src/worker.ts; server/src/scheduler.ts; server/src/routes-tasks.ts; server/test/collection-alerts.test.ts; server/test/task-migration.test.ts; affected worker tests.

- [x] Write and observe failing tests for manual collections producing no alerts and separate collection/alert task API contracts.
- [x] Add CollectionTask, AlertTask, AlertRun and RunTrigger contracts; migrate legacy task payloads and alert uniqueness transactionally.
- [x] Persist immutable trigger and alert snapshots; separate scheduled/manual queue coalescing and make retry manual.
- [x] Use uncapped operational queue reads; protect newer credentials and permit unfinished failed SKU records to recover.
- [x] Verify migration round trips and collection control tests.

## Task 2: independent alert execution and API

Files: server/src/alert-worker.ts; server/src/routes-alerts.ts; server/src/notifications.ts; server/src/app.ts; server/src/api-context.ts; server/src/main.ts; server/src/query.ts; relevant server tests.

Interfaces: AlertWorker.enqueueForCollection(runId), recover(), whenIdle(), close(); Store.listAlertTasks/getAlertTask/saveAlertTask/deleteAlertTask; Store.listAlertRuns/getAlertRun/saveAlertRun; AlertRunRecord adds taskSnapshot to public AlertRun; alerts retain runId=collectionRunId and add alertRunId.

- [x] Write failing scheduled/partial/manual/recovery/idempotency tests using real SQLite and local collector fixtures.
- [x] Create unique alert runs from frozen snapshots after eligible collection completion; evaluate only source-batch prices in a transaction.
- [x] Expose alert task CRUD, whitelist and execution endpoints; move delivery state/retry to alert runs.
- [x] Wire startup and shutdown recovery; update price-query alert-task context and protect pending evidence during cleanup.
- [x] Verify no manual route, retries, or fabricated request body can trigger alert execution.

## Task 3: separate user flows

Files: web/src/pages/*Task*.vue; web/src/components/RunTable.vue; new AlertRunTable.vue; BatchAction.vue; PricesPage.vue; AlertsPage.vue; router.ts; App.vue; web/test/*.

- [x] Add failing component tests for manual-only collection action and separate alert configuration.
- [x] Provide collection-only task editor and list, independent alert editor/list with binding/rules/whitelist, and separate run records.
- [x] Display provenance and source-batch links; route whitelist operations to alert tasks and range additions to collection tasks.
- [x] Verify component tests, vue-tsc and build.

## Task 4: integration, review and delivery

- [x] Update README and API contracts with trigger matrix, migration and recovery semantics.
- [x] Run npm run check; review migration, retry and notification state behavior independently.
- [x] Address important review findings with regression tests; verify git diff and full suite.
- [x] Commit, push feature branch and open a draft pull request with validation evidence.

## Verification record

- Full `npm run check` passed after integration and independent review fixes.
- Main suite: 223 passed, 1 optional real-Chromium test skipped. UI suite: 51 passed. Type checks and production build passed.
- Independent review found and resolved notification blocking, whitelist preview source-scope intersection, and compatibility of explicit collection-status rules. Regression tests cover each fix.
- Real merchant collection and external notification delivery were not performed. Tests use local collector fixtures and intercepted notification transport.

## Delivery

- Implementation commit: `bb5ea19df02763b675d313bc205370d3f1af19b6`.
- Feature branch: `feat/separate-collection-alerts`.
- Draft pull request: https://github.com/lwhx/PricePatrol/pull/1.
- Remote implementation tree matches the locally verified tree exactly; no merge or deployment was performed.
