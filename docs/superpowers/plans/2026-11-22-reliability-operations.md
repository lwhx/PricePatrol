# Reliability and operations implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox tracking.

**Goal:** Complete the ordered optimization review while preserving scheduled-only price alerts.

**Architecture:** Keep the single-service SQLite deployment. Add focused maintenance, incident and export modules; use immutable evidence with independent operational state. Stage integration is sequential; independent file ownership within each stage permits parallel work.

**Tech Stack:** TypeScript, Fastify, Vue 3, Node 24 SQLite, Vitest, Docker Compose.

**Spec:** `docs/superpowers/specs/2026-11-22-reliability-operations.md`

## Global Constraints

- Only completed scheduled collections dispatch price alert evaluations; manual collection/retry never do.
- Preserve immutable reports, exact money, unknown data, encryption and notification idempotency.
- Keep `6300:3000`, Node 24, AMD64/ARM64, existing data migration and no new external infrastructure requirement.
- Do not request real merchant data, send external notifications or deploy to production.
- No Codex attribution; use existing repository author identity for commits.

## Review Focus

- Transient verification concurrent with credential replacement must not overwrite the fresh account.
- Partial SKU sets, null price and unknown rules must not imply removals or recovery.
- Cleanup must not remove evidence needed by unresolved incidents, delivery or current latest prices.
- Accepted work with a lost HTTP response must not duplicate manual collection or notifications.
- Restart during backup/export/notification must leave inspectable recoverable state without replaying unknown deliveries.

### Task 1: Collection reliability

**Files:** collector/*.ts, routes-accounts.ts, regression tests. Contracts addition owned by controller.
**Interfaces:** Produces `ProductCollection.skuSetComplete`; typed verification classification. Consumes existing Collector interface.
- [x] Write fixtures for transient verification, stale credential race, unrelated invalid SKU, partial product isolation, Max-Age and bounded identity discovery.
- [x] Run targeted tests to establish failures.
- [x] Implement errors, isolation, authoritative SKU marker and bounded probes; no relaxation of ownership validation.
- [x] Run collector/account regressions and review diff.

### Task 2: Data accuracy and UI operations

**Files:** database.ts, export.ts, worker.ts (controller); routes-tasks.ts, new collection-submissions.ts, web BatchAction/TaskEdit/PricesPage and tests (UI agent).
**Interfaces:** `saveProduct(...):number` returns net newly inserted batch rows; `countRunPrices(runId):number`. POST `/tasks/:id/products` appends `{productIds}` atomically. PATCH task optionally accepts `expectedVersion`. Collection submission helper receives Store, Worker, shop ID, product IDs and optional idempotency key.
- [x] Pin complete vs partial SKU reconciliation and aggregate export projection regressions.
- [x] Implement authoritative latest reconciliation, incremental counts and export field projection.
- [x] Implement atomic append, version conflicts, persisted bounded idempotency records and per-shop batch retry UI.
- [x] Convert restored timestamps to datetime-local and display active filter summary.
- [x] Run related server/UI tests and review.

### Task 3: Production bootstrap protection and build identity

**Files:** auth.ts, main.ts, app.ts wiring, new bootstrap/build-info modules, Dockerfile, both Compose/env examples, container.yml, AuthPage and tests.
**Interfaces:** AppOptions adds bootstrap token; auth status adds `setupTokenRequired`. Bootstrap file persists under DATA_DIR, or ADMIN_PASSWORD preinitializes. Build info is available to authenticated settings/health details.
- [x] Prove fresh protected setup rejects absent/wrong token, accepts once, and existing admins remain compatible.
- [x] Implement initialization, Compose passthrough, auth token field and documented retrieval.
- [x] Bake BUILD_SHA/BUILD_TIME in image and test safe local defaults.
- [x] Run auth/deploy regressions; integrate and commit stage 1 after review.

### Task 4: Maintenance and retention

**Files:** new maintenance/retention/backup modules and worker, database integration, settings/data routes, SettingsPage, regression tests.
**Interfaces:** authenticated maintenance settings/status/preview/run APIs; service start/close hooks. Defaults and retention protection exactly as spec.
- [x] Write retention tests for zero-hit, resolved, unresolved, active/latest and pending delivery evidence.
- [x] Implement transactional preview/cleanup and daily configured scheduler.
- [x] Implement verified background backups, owned-file rotation and optional configured copy destination.
- [x] Add settings UI, preview confirmations, error/status display, volume configuration and restore documentation.
- [x] Run targeted tests including interrupted backup/restart; review maintenance independently.

### Task 5: Business health and diagnostics

**Files:** new operations module, scheduler.ts, app.ts, worker.ts, health routes, OverviewPage/SettingsPage, tests.
**Interfaces:** durable schedule events, authenticated operations overview, structured logger without sensitive payloads; real build/schema identity.
- [x] Test invalid account schedule skip record, last success/data age and unknown-error 500.
- [x] Implement metrics and bounded schedule event storage with safe logs and explicit business errors.
- [x] Expose usable status UI and last backup/cleanup results; review and commit stage 2.

### Task 6: Incident lifecycle and notification reduction

**Files:** new incidents module, alert-worker.ts, notifications.ts, shared contracts, validation, alert task UI/records, tests.
**Interfaces:** optional task notification policy; persistent incident state and immutable evaluation summary including notification candidate IDs. Legacy tasks receive safe policy defaults.
- [x] Test first/continuing/worse/recovery/unknown/manual/rule-change/restart/idempotency cases.
- [x] Implement atomic incident updates alongside evaluation evidence and frozen notification candidates.
- [x] Send first/worsening/cooldown reminders and optional recovery; retain every evaluation.
- [x] Add task controls and lifecycle labels.
- [x] Complete independent scoped re-review of lifecycle fixes.

### Task 7: Performance and export jobs

**Files:** query.ts, new export jobs/worker/files modules, export routes, CopyDialog, worker.ts, tests.
**Interfaces:** asynchronous file-export creation/status/download, bounded preview and metadata, authenticated expiry-safe file lookup. Existing small copy API remains compatible.
- [x] Measure baseline count/query repetition with fixtures; optimize repeated operations with equal results.
- [x] Add file-backed worker export jobs, format-equivalent streaming and bounded batch iteration.
- [x] Handle restart/expiry/failure and make UI poll/cancel or download without receiving full large content.
- [x] Add configurable cross-shop concurrency default 1 with shop exclusion and stop/recovery tests.
- [x] Run targeted regressions, including export failure recovery and metadata-only download preflight.
- [x] Complete independent scoped re-review of export fixes.

### Task 8: Integration, release and documentation

**Files:** README, API contracts, implementation report, CI as necessary.
This checklist is the pre-merge implementation snapshot. Final branch CI, merge and image publication results are recorded by [PR #2](https://github.com/lwhx/PricePatrol/pull/2) and its linked Actions runs, so no new release is created solely to update post-publication checkboxes.

- [x] Run `npm run check` after final review fixes: 335 server tests and 70 UI tests passed, one optional local Chromium skip; typecheck and production frontend build passed.
- [x] Independent full-branch review of data retention, provenance, lifecycle, auth, exports and UI; five final findings fixed in `6339427`, scoped re-review clean.
- [x] Publish feature branch/PR #2; initial CI including real Chromium and Compose validation passed. Updated-head CI is still a required merge gate tracked in Actions.
- [ ] Merge/push with expected head, verify main workflow and multiarch images.
- [x] Record implemented defaults, local checks and host configuration requirements in `docs/优化实施记录.md`; final release status is recorded by the PR and Actions run.
