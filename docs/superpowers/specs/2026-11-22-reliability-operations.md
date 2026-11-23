# PricePatrol reliability and operations

## Authorization and order

The user asked to execute all recommendations from the optimization review, in order. Implement three release stages in one isolated feature branch: (1) collection/data correctness and initialization, (2) long-running operations, (3) alert lifecycle and performance. Existing authorization includes merging and pushing completed changes. No access to live merchant accounts or production deployment is implied.

## Binding behavior

- Only completed scheduled collections dispatch price alert evaluations. Manual collection and manual retry never dispatch them. Resuming a scheduled batch preserves provenance and frozen configuration.
- Preserve existing SQLite data, immutable run reports, credential encryption, exact monetary arithmetic, unknown-price semantics, and notification submission idempotency.
- Keep external Docker port `6300:3000`; support AMD64/ARM64 and Node 24. No unnecessary infrastructure dependency.
- Regression tests use fixtures/in-memory databases; never send real merchant requests or notifications.

## Stage 1

1. Verification failures retain typed causes. Transient rate limit/network/timeout errors do not invalidate a valid account; authenticated failures do. Guard in-flight verification against changed credentials. Bound retry/cooling at the transport layer.
2. Keep page identity/coverage validation, isolate invalid price/SKU data to its product, skip irrelevant selected products without letting their bad price poison the selected collection. Preserve exact money rejection. Bounded identity probing can inspect additional pages; Cookie serialization preserves effective Max-Age expiry.
3. `ProductCollection.skuSetComplete?: boolean` is authoritative only when true and there is no product error. Reconcile absent SKU IDs from `latest` only for such results. Never delete historical price snapshots or remove missing SKUs on partial data. `Store.saveProduct` returns inserted row-count delta and `countRunPrices` avoids loading payloads for progress.
4. Atomic task product append endpoint; expectedVersion for full task edits; persistent idempotency keys for shop collection submissions; batch UI tracks success/failure and retries only failed groups. Token reuse with different payload returns 409.
5. Product-level export fields retain aggregate values; SKU detail uses deliberate field projection. Datetime-local values are converted when restoring API UTC values, active filters remain visible.
6. Existing configured administrators continue unchanged. Uninitialized production instance requires a one-time bootstrap token or ADMIN_PASSWORD. Compose passes supported bootstrap variables; token is generated persistently with restrictive permissions and is not returned by public APIs.

## Stage 2

1. Maintenance settings expose normal history retention (default 180 days), alert evidence retention (default 365 days), automatic cleanup switch (default off to avoid upgrade-triggered deletion), backups enabled (default on), daily interval, and backup count (default 14). Unresolved alerts, active incidents, unfinished runs, pending dispatch/delivery and latest-price source rows remain protected.
2. Preview and cleanup use identical eligibility rules. Old zero-match completed evaluations are reclaimable; resolved alert evidence can expire after its separate retention period. Delete dependent records transactionally. Daily maintenance applies enabled settings, reports counts/errors, and is restart-safe.
3. Consistent backups run outside the main event loop, use unique files, verify integrity, rotate only owned completed backups, and optionally copy to an administrator-configured mounted off-host directory. Never expose secrets or arbitrary server paths through client request input. Documentation must distinguish a local backup volume from an off-host backup destination and preserve original ENCRYPTION_KEY.
4. Add business health data: last successful collection, data age, consecutive failures, queues, skipped schedule reasons, maintenance status, build SHA/time/schema. Record skipped scheduling occurrences durably with bounded retention. Structured redacted logs correlate request/run/evaluation IDs; unknown errors are 500, known input/business errors remain 4xx.
5. Build identity is baked into Docker image by CI and shown in authenticated settings. Document version pinning, upgrade backup and compatible database restore.

## Stage 3

1. Incident lifecycle is separate from immutable per-run evidence: first anomaly, continuing anomaly, worsened anomaly, recovered. Stable identity includes alert task and semantic rule fingerprint plus shop/product/SKU; changes unrelated to rules do not reopen incidents. Unknown/missing/excluded rows never imply recovery. Cooldown default 24 hours; recovery notification configurable (default off). Every scheduled evaluation remains recorded; notification subset is frozen and idempotent.
2. A worsening event requires numeric rule-oriented deterioration (lower for lt/lte, higher for gt/gte; no arbitrary worsening for text/complex equality). Recovery requires valid current evaluation to false and sufficient coverage. Separate acknowledged/resolved user workflow from observed anomaly lifecycle.
3. Optimize repeated counts/queries without changing filtering, exact decimal sorting or snapshot consistency. Add bounded keyset/batched query iterators for file export. Large exports are jobs rendered to files in a worker thread/process, return preview/metadata and stream authenticated downloads; small-copy workflows remain compatible. Persist job states and handle restart/failure/expiry without full content stored in SQLite.
4. Preserve platform throttles; configurable limited cross-shop execution can be enabled (default 1), never more than one running collection per shop. Close/stop/resume/recover behavior and manual/scheduled separation remain correct.

## Completion

Targeted regressions, full typecheck/server/UI/build, independent review of correctness/security/maintenance, then PR CI and merge/push. Verify the final main workflow and image publication. Report actual checks, defaults, and any host configuration the user must supply.
