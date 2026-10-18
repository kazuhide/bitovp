# Database upgrades

Fresh installations apply all migrations automatically through the Compose
migration service. **Do not run the manual backfills below on a fresh database.**
They apply only when upgrading an existing database that has not yet applied the
named migration. Check its applied migration list first. If a query refers to a
legacy table/column that has not been created yet, there are no existing rows
for that check. If a later migration already removed a column, that check is no
longer applicable.

## Before upgrading an existing database

1. Record the current image revisions and active external resources. Close job,
   feeder, scheduler, and verification admission; stop **all** application database
   writers, including detached command-line processes and host workers. Inspect
   the actual running image/process inventory, not only deployment logs.
2. Before any repair UPDATE or pending migration, run the applicable resume-link
   preflight below. Resolve or preserve every unresolved link before proceeding.
3. With writers still stopped, take a full database backup and preserve private
   environment files, `MASTER_KEY`, and verification signing keys. Restrict access
   and retain an off-host copy and checksum. Test a restore into an isolated
   database; `pg_restore --list` alone proves only archive readability.
4. Perform the applicable preflight checks below. Keep admission closed while
   applying migrations and replacing every affected writer. Never mix old and
   new publisher or verifier processes across these boundaries.
5. Read back the required objects/data, check migration status and the live
   database-to-schema diff, then start only compatible images and reopen admission.

Run migrations with the private administrative environment; web and worker use
restricted runtime roles. Preserve [organization isolation](./OPERATIONS.md#upgrades).

## Preserve verification resume links

Before `20260830130000_verification_seal_authority`, run this while every writer
is paused, **before any other repair UPDATE or pending migration**:

```sql
SELECT
  count(*) FILTER (WHERE current."resumedFromRunId" IS NOT NULL) AS resume_links,
  count(*) FILTER (WHERE current."resumedFromRunId" IS NOT NULL
                    AND prior.id IS NOT NULL) AS resolvable,
  count(*) FILTER (WHERE current."resumedFromRunId" IS NOT NULL
                    AND prior.id IS NULL) AS unresolved
FROM "VerificationRun" AS current
LEFT JOIN "VerificationRun" AS prior
  ON current."resumedFromRunId" = prior."runId";
```

Save these counts privately. Abort if `unresolved <> 0`: repair or explicitly
preserve each historical link first. The migration converts resolvable text
links to `resumedFromId` and drops the old column. Afterward, while writers remain
paused, require the non-null `resumedFromId` count to equal saved `resume_links`
and confirm `resumedFromRunId` is absent.

An image-only rollback across this boundary is unsafe. An emergency compatibility
bridge, with all writers still stopped, is:

```sql
BEGIN;
ALTER TABLE "VerificationRun"
  ADD COLUMN IF NOT EXISTS "resumedFromRunId" TEXT;
UPDATE "VerificationRun" AS current
SET "resumedFromRunId" = prior."runId"
FROM "VerificationRun" AS prior
WHERE current."resumedFromId" = prior."id";
COMMIT;
```

This restores only that column's compatibility; it does not reverse data changes
or runtime semantics. Full rollback requires the verified pre-upgrade snapshot
and exact old image set. First terminate and verify cleanup of external resources
created since the backup, so restoring the database does not lose their identifiers.

Keep old signing keys in `VERIFY_SEAL_KEYS` when rotating the active
`VERIFY_SEAL_KEY_ID`; earlier signed evidence needs its original key. Release-mode
verification requires an active key ID and matching private key material. Never
store signing secrets in the database or public evidence.

## Recover lost schedule dispatches

Before `20260829130000_live_schedule_dispatch_outbox`, identify already-fired
START/STOP actions that may never have reached the queue:

```sql
SELECT s.id, s.action, s.note, s."fireAt", s."firedAt",
       c.id AS "liveChannelId", c.name AS channel, c.status,
       c."provisionClaimedAt"
FROM "LiveSchedule" s
JOIN "LiveChannel" c ON c.id = s."liveChannelId"
WHERE s.status = 'FIRED'
  AND s."firedAt" < now() - interval '15 minutes'
  AND ((s.action = 'START' AND c.status = 'PROVISIONING')
    OR (s.action = 'STOP' AND c.status = 'STOPPING'))
ORDER BY s."firedAt";
```

Allow longer than 15 minutes if normal provisioning/stopping takes longer.
For START, a null `provisionClaimedAt` also indicates that no provisioning job
took the lease. Zero rows need no action. For confirmed lost dispatches, either
resolve them through the channel controls before maintenance and repeat the
query, or save their IDs and, immediately after migration, reopen only those rows:

```sql
UPDATE "LiveSchedule" SET "dispatchedAt" = NULL WHERE id IN ('<confirmed-id>');
```

The new dispatcher requeues them after startup. The migration otherwise stamps
all historical FIRED rows as dispatched, permanently removing this distinction.
This query cannot identify lost slate/feeder actions because they leave no
channel-state signature. Inspect their schedule, insertion, and feeder records;
expired windowed actions are missed rather than played late.

## Bind armed schedules to the current broadcast

For `20260830010000_schedule_run_generation_and_source_seal`, inspect ARMED
schedules on RUNNING channels and each channel's latest run before migration.

```sql
SELECT s.id, s.action, s."fireAt", c.name AS channel, c.status,
       r.id AS "currentRunId", r.seq, r.status AS "runStatus"
FROM "LiveSchedule" s
JOIN "LiveChannel" c ON c.id = s."liveChannelId"
JOIN LATERAL (
  SELECT id, seq, status FROM "LiveChannelRun"
  WHERE "liveChannelId" = c.id ORDER BY seq DESC LIMIT 1
) r ON TRUE
WHERE s.status = 'ARMED' AND c.status = 'RUNNING'
ORDER BY c.name, s."fireAt";
```

Zero rows need no action. Existing rows default to lazy binding, so leaving them unchanged is safe.
Only if every selected row belongs to the broadcast currently on air, bind it
after migration:

```sql
UPDATE "LiveSchedule" s
SET "liveChannelRunId" = r.id
FROM "LiveChannel" c
JOIN LATERAL (
  SELECT id FROM "LiveChannelRun"
  WHERE "liveChannelId" = c.id ORDER BY seq DESC LIMIT 1
) r ON TRUE
WHERE s."liveChannelId" = c.id AND s.status = 'ARMED'
  AND c.status = 'RUNNING' AND s."liveChannelRunId" IS NULL;
```

Do not bind stopped channels to their last completed run. If only some rows
belong to the current broadcast, restrict the UPDATE to their inspected IDs.
Historical feeder source-version fields remain null: the original object bytes
cannot be recovered from a storage location alone.

## Establish a single feeder publisher

Before `20260830070000_feeder_publisher_claim`, close feeder create/stage/commit
and scheduler dispatch, then drain and stop **every** old publisher-capable
worker. This migration has no supported rolling handoff. If a maintenance pause
is impossible, do not apply it using a mixed-version rollout.

Run the duplicate scan while admission remains closed:

```sql
SELECT "liveChannelId", string_agg(id::text, ', ' ORDER BY "createdAt") AS candidates,
       count(*)
FROM "FeederSession"
WHERE status = 'PUSHING'
   OR (pid IS NOT NULL AND "processGoneAt" IS NULL)
   OR ("startedAt" IS NOT NULL AND "processGoneAt" IS NULL)
GROUP BY "liveChannelId" HAVING count(*) > 1;
```

At most one candidate per channel may retain a claim. Stop other processes on
the host that owns their PID, using the feeder stop action before the writer
pause if needed. Only if a host no longer exists may an operator attest process
termination by setting `processGoneAt`, clearing `pid`/`ownerHost`, and recording
the host, time, operator, and checked inventories in the row's error note.
Never invent process-gone evidence for a running host. STOPPED/ERROR status or a
missing PID alone does not prove termination.

Only after establishing that proof, apply the row-level repair:

```sql
UPDATE "FeederSession"
SET "processGoneAt" = now(), "pid" = NULL, "ownerHost" = NULL,
    "error" = COALESCE("error" || ' — ', '') ||
      'host <name> decommissioned <date>; process gone; inventories <checked>; operator <name>'
WHERE id = '<proven-gone-session-id>';
```

For legacy candidates with no owner/PID, first verify all possible publisher
runtimes are stopped and no ffmpeg remains, and require zero nonterminal rows
(`status NOT IN ('STOPPED', 'ERROR')`) and zero present PIDs. Only then attest
individually as above. Repeat the scan
and candidate count; both duplicate-channel and remaining legacy-candidate
counts must be zero before migration in this all-stopped repair case.

The migration transaction backfills claims and refuses duplicates. Afterward,
read `FeederSession_one_publisher_claim_per_channel` from `pg_indexes`, verify it
is valid, and check held claims against the candidates that were retained.
Start only claim-aware workers before reopening admission.

## Enable feeder attempt records

For `20260830080000_feeder_push_attempt`, keep feeder create/stage/commit paused,
apply the migration, verify `FeederPushAttempt` and its unique index, and replace
every publisher-capable worker before resuming.

In the first non-production feeder check, require one attempt row per process
spawn, `evidenceNotBefore >= startedAt`, no `providerAcceptedAt` until a provider
sample at or after that boundary, and `endedAt` plus exit code or signal for
each exited process. An old worker can publish without these records and must
not remain active.

## Preserve nonzero restart counters

Before `20260901020000_prisma_schema_drift_reconciliation`, require both counts
to be zero while writers are stopped:

```sql
SELECT count(*) FROM "FeederSession" WHERE "restartCount" <> 0;
SELECT count(*) FROM "LiveChannelRun" WHERE "encoderRestartCount" <> 0;
```

Abort on any nonzero value; preserve and explain that evidence before a separate
reviewed data migration. Do not zero values to bypass the guard. After migration,
confirm both columns are absent and the three renamed indexes and one renamed
foreign key use the exact target names in the migration, with no old truncated
names remaining. Require clean migration status and schema diff.

## Fence verification recovery

Before `20260901040000_verification_run_recovery_fence`, keep every writer pause
in force, close `verify run` and `verify recover`, and stop all pre-fence verifier
processes, including detached CLI sessions and host workers. Abort if their
absence cannot be established from the image/process inventory.

After migration, read back exactly `recoveryOwner`, `recoveryLeaseUntil`, and
`recoveryGeneration` on `VerificationRun`. The generation must be integer,
NOT NULL, default 0; the two lease columns must be nullable. Require clean
migration status and schema diff before starting only fence-aware images and
reopening verification. A rollback to pre-fence verification requires the
verified database snapshot and matching old image set, with verification closed
until both are restored.

## Schema checks and migration mismatches

`prisma migrate status` alone does not prove schema equality or detect every
checksum mismatch. A schema diff also cannot establish historical INSERT,
UPDATE, or DELETE effects, and the Prisma datamodel does not represent every
partial index, trigger, function, or CHECK constraint. Inspect these objects in
both directions against committed migrations.

Do not reset a database containing required history or edit migration bookkeeping
merely to silence a mismatch. Establish schema equivalence, inspect hand-written
objects and data effects, preserve a verified backup, and resolve the specific
divergence. `migrate resolve --applied` records a migration as applied; it does
not execute its SQL.
