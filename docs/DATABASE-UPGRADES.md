# Database upgrades

Fresh installations apply all migrations automatically through the Compose
migration service. **Do not run the manual backfills below on a fresh database.**
They apply only when upgrading an existing database that has not yet applied the
named migration. Check its applied migration list first. If a query refers to a
legacy table/column that has not been created yet, there are no existing rows
for that check. If a later migration already removed a column, that check is no
longer applicable.

## Inspect saved templates before replacing writers

Using the candidate checkout and its installed dependencies, run this read-only
check against the existing database before applying migrations or starting new
Web/Worker processes:

```sh
pnpm --filter @bitovp/db db:upgrade:preflight --admin-env /absolute/private/path/.env.migrate
```

The administrative role must be able to inspect every organization (superuser
or `BYPASSRLS`); a restricted runtime role is refused rather than reporting an
empty inventory as healthy. The check runs in a read-only, repeatable-read
transaction. Its JSON identifies affected template IDs, revisions, organization
IDs and associated watch-rule IDs, including whether each rule is enabled. It
does not print plans, object locations, names, ciphertext or secret values.
Keep the output private. Exit code `2` means one or more templates would be
refused by current structural validation or delivery commitments; `1` means
the check itself failed. Both require investigation. Warnings remain advisory
and are included in the report. This is not a provider-access, credential,
model-readiness or deployment-capability test; job submission still applies
those checks.

In particular, the v1.2.1 `mezz-h264-1080p-50m` and `mezz-h265-2160p` presets
used separate video/audio MP4 files. The current delivery specifications require
one MP4 containing both streams. Saved templates with the old shape and a
`REFUSE` delivery commitment are reported as
`RELOAD_DELIVERY_PRESET_AND_RESAVE`. Open the current delivery preset, rebind
its input/output credentials and locations, review the combined-stream file,
and save the reviewed plan into the existing template. If choosing a new
template ID, explicitly update the affected watch rules. Preserve those rules'
existing `WatchedObject` rows: deleting/recreating a rule or clearing its history
can rediscover old files and create additional billable jobs. The preflight
never rewrites templates, weakens `REFUSE` into `WARN`, enables watch rules or
creates jobs. Re-run it while writers remain paused after making the intended
corrections. Existing finished-job plans remain historical snapshots.

## Rehearse a version upgrade and database rollback

The local rehearsal uses one dedicated PostgreSQL fixture and synthetic data.
It does not connect to production, storage providers or an encoder:

```sh
node scripts/upgrade-rehearsal.mjs --base-ref v1.2.1 --output-directory /absolute/private/new-rehearsal-directory
```

The output directory must be new and outside the source checkout. The exact
baseline commit must exist locally. The runner applies that commit's migrations,
generates its matching Prisma client and uses its original encryption code to
seed a password-authenticated user and membership, settings, encrypted credentials, account configuration, the two delivery
templates, enabled watch rules, VOD history, Library registration and saved edit
history. It then takes a real `pg_dump`, runs the candidate preflight and
migrations, compares all pre-existing table contents, and checks decryption with
the same key, verification of the old password hash, tenant isolation and a write to the new preview task table.

Rollback restores the dump into a separate database and compares every table,
RLS policy, grant, index, constraint, trigger, function and enum fingerprint.
The exact baseline client and encryption code must read the restored settings,
credentials and edit history. The retained report contains hashes/counts and
identities; the key, database URLs and dump stay in the private temporary fixture
and are removed with its owned container. `cleanup: passed` is written only
after that cleanup succeeds.

This proves the synthetic database/schema/reader transition. It does not prove
a full Web/Worker image cutover, production host configuration or provider
behavior. Record the candidate commit and source digest from the report; a run
with `sourceClean: false` is development evidence and must be repeated on the
final clean candidate. The rehearsal creates no release or tag.

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

## Enable Library editing and derived sources

`20261101000000_library_editing` adds six tenant-scoped editing tables and the
`LibrarySource.sourceKind` discriminator. Existing sources become `VOD_JOB` and
retain their job provenance. Derived renders have artifact provenance; their
`originalJobId`, `encodingId` and `accountId` remain null.

Stop all old web/worker processes and other source readers before deploying
writers that create `DERIVED_RENDER`. Apply the migration, replace every reader
and analysis sweeper with a source-kind-aware version, then reopen admission.
Do not mix an old analysis worker with derived-source writes. The migration is
additive for existing VOD data, but an old image cannot interpret derived rows.

Verify the six tables' forced organization RLS, tenant-bound foreign keys, source
kind check and immutable edit/artifact guards from the migration. Confirm that
existing VOD sources still have their original IDs. Test a synthetic clip through
material preparation, saved revision, preview, export and Library playback before
admitting real editing work. Reset deliberately blocks dependent categories while
editing records exist. For rollback after derived writes, preserve all output
identities and restore a verified pre-upgrade snapshot with matching old images;
do not relabel a derived row as a VOD job.

`20261101010000_render_artifact_recovery` separately records the pending artifact
attempt token, so changing a render lease does not lose a completed output that
has not yet been adopted. It backfills UUID lease tokens on existing VALIDATING
runs. Replace workers before reopening editing admission; recovery of a sealed
output remains possible after the render-attempt budget is exhausted.

`20261101020000_media_output_credential` makes the editing material's output
credential a required, tenant-bound RESTRICT reference. It backfills from the
saved output locator and verifies prepared/output credential agreement. An
unresolvable or inconsistent historical locator aborts the migration; preserve
and investigate it rather than guessing the input credential or deleting data.
READY evidence is unlocked only inside the table-locked migration transaction
while this additional reference is backfilled, then its immutable trigger is
restored. Deploy the API that writes the new required field with this migration.

`20261101030000_analysis_binding` adds `LibraryAnalysisBinding` as a separate,
append-only proof for one organization/media-version/analysis-revision tuple.
Apply it before deploying binding writers. It does not backfill or UPDATE READY
media, immutable analysis, existing projects or artifacts. Keep the READY-media
immutable guard enabled. Same-organization composite foreign keys protect both
parents; the verifier separately checks their source identity and proof contents.

Use the migration wrapper so runtime-role/default grants are prepared before
and refreshed after deployment. Verify forced organization RLS, the unique tuple
index, both deferred tenant foreign keys, and rejection of every UPDATE,
including an identical proof or other no-op UPDATE. DELETE remains available
for explicit, child-first maintenance; neither parent cascades binding rows.
Selected reset counts and retains bindings with the protected editing chain and
continues to refuse Library/credential deletion while those records exist.

For an application rollback, retain the additive table and all proof rows. Stop
binding-dependent automatic generation until compatible readers are restored;
do not copy the proof into READY `probe` or drop proof history to run an old
image. A destructive database rollback requires the verified snapshot and its
matching image set described above.

`20261102000000_content_production` adds tenant-scoped
`LibraryEvidenceReceipt`, `LibraryMediaTask`, `LibraryImageAsset` and
`EditProjectResource`. It also links editor-confirmed analysis associations to
their immutable receipt. Apply it through the migration wrapper before replacing
all web and worker images together. Old images cannot execute these tasks or read
composition documents. Do not mix old workers with the new task queues.

This migration does not rewrite existing analysis, prepared sources, edit
documents, revisions or MP4 artifacts, and does not attest historical AISA JSON.
Check forced RLS, tenant-bound foreign keys, immutable receipts/assets/task
intent, terminal task protection and project resource references. Exercise source
preparation, generation, caption/tracking tasks and a composition export in an
isolated database before reopening admission.

Job deletion and job-history reset retain jobs referenced by input or analysis
receipts. The application reports `JOB_LIBRARY_EVIDENCE_REFERENCES` instead of
discarding those records; bulk deletion skips retained jobs and processes other
eligible items. Library and credential reset also retain the full editing chain.
For rollback, preserve the additive tables and all files, close production-task
admission and restore compatible images. Never remove evidence to make an older
image accept the database.

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

Comment corrections also change a migration file's checksum even when its SQL
is unchanged. A successful `migrate deploy` does not prove historical checksums
match. Compare the statements and test the upgrade on a restored copy.

Do not reset a database containing required history or edit migration bookkeeping
merely to silence a mismatch. Establish schema equivalence, inspect hand-written
objects and data effects, preserve a verified backup, and resolve the specific
divergence. `migrate resolve --applied` records a migration as applied; it does
not execute its SQL.
