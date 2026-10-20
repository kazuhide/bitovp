import type { StepLogEntry } from "@bitovp/core";
import type { AppPrismaClient } from "./client";
import type { LiveEffectClaimHandle } from "./live-effect-claim";

/**
 * Appends ONE entry to a live channel's `stepLog` atomically.
 *
 * Read-modify-write on a JSON column loses (or reverts) entries when two
 * writers overlap, and there are real concurrent writers here: two ESAM
 * insertions, or an ESAM insertion racing `insertScte35` — whose read happens
 * BEFORE its Bitmovin call, so its window spans a network round-trip and its
 * stale snapshot can overwrite an entry written inside it (review catch).
 *
 * A Prisma interactive `$transaction` would NOT fix this: it defaults to Read
 * Committed, which does not prevent lost updates on read-modify-write. It would
 * need `FOR UPDATE` or Serializable. `jsonb ||` needs neither — the read never
 * happens, so there is no window.
 *
 * The array wrapper on the right-hand side is LOAD-BEARING, not cosmetic:
 * `jsonb || jsonb` MERGES when both sides are objects and concatenates only when
 * both are arrays. The column is `JSONB NOT NULL DEFAULT '[]'`, so wrapping the
 * entry keeps this unambiguously a concat; passing the bare object would be a
 * shape-dependent bug waiting for someone to "simplify" it (review catch).
 *
 * `entry` is typed, not `unknown`: `JSON.stringify([undefined])` is `"[null]"`,
 * and a JSON null in this array makes EVERY later `stepLogSchema.parse` on the
 * channel throw — the timeline degrades to "Step log unavailable" and provision
 * hard-errors. That is a bricked channel reachable from a public export, so the
 * type is the guard.
 *
 * Returns the number of rows updated: 0 means the channel was deleted
 * mid-flight, which callers treat as "nothing to record" rather than an error.
 */
export async function appendLiveChannelStepLogEntry(
	prisma: AppPrismaClient,
	liveChannelId: string,
	entry: StepLogEntry,
): Promise<number> {
	const updated = await prisma.$executeRaw`
		UPDATE "LiveChannel"
		SET "stepLog" = "stepLog" || ${JSON.stringify([entry])}::jsonb
		WHERE id = ${liveChannelId}::uuid
	`;
	if (updated === 0) {
		// Not an error — a deleted channel has no page to show this on. Logged for
		// the same reason the caller logs a failed append: silence here is
		// indistinguishable from "nothing happened".
		console.warn(
			`[step-log] no LiveChannel ${liveChannelId} to append a ${entry.kind} record to`,
		);
	}
	return updated;
}

/**
 * Persists one provider-success record against the effect's immutable airing.
 *
 * The run append is unconditional on current channel state but exact on the
 * claim's run/channel/provider tuple: a provider response that arrives after
 * STOP/re-air still belongs in the old run's evidence. The channel projection
 * is deliberately stricter. It lands only while the same claim token is still
 * DISPATCHING and the channel still owns the claim's provider generation, so a
 * late response can never contaminate the successor airing's current timeline.
 *
 * Both writes use `jsonb || [entry]` inside one transaction. This removes the
 * SCTE-vs-slate lost-update window without turning a channel projection miss
 * into a rollback of the old run's durable provider evidence.
 */
export async function appendLiveEffectStepLogEntry(
	prisma: AppPrismaClient,
	claim: LiveEffectClaimHandle,
	entry: StepLogEntry,
): Promise<{ runUpdated: number; channelUpdated: number }> {
	const serialised = JSON.stringify([entry]);
	return prisma.$transaction(async (tx) => {
		// Match owned transitions and reset without discarding an old run's facts.
		await tx.$queryRaw`SELECT id FROM "LiveChannel" WHERE id = ${claim.liveChannelId}::uuid FOR UPDATE`;
		const runUpdated = await tx.$executeRaw`
			UPDATE "LiveChannelRun"
			SET "stepLog" = "stepLog" || ${serialised}::jsonb
			WHERE id = ${claim.liveChannelRunId}::uuid
				AND "liveChannelId" = ${claim.liveChannelId}::uuid
				AND "bitmovinEncodingId" = ${claim.providerEncodingId}
				AND EXISTS (
					SELECT 1
					FROM "LiveEffectClaim" AS effect
					WHERE effect.id = ${claim.id}::uuid
						AND effect.token = ${claim.token}::uuid
						AND effect."liveChannelId" = ${claim.liveChannelId}::uuid
						AND effect."liveChannelRunId" = ${claim.liveChannelRunId}::uuid
						AND effect."providerEncodingId" = ${claim.providerEncodingId}
						AND effect.generation = ${claim.generation}
						AND effect.action = ${claim.action}
				)
		`;
		if (runUpdated !== 1) {
			return { runUpdated, channelUpdated: 0 };
		}
		const channelUpdated = await tx.$executeRaw`
			UPDATE "LiveChannel" AS channel
			SET "stepLog" = channel."stepLog" || ${serialised}::jsonb
			WHERE channel.id = ${claim.liveChannelId}::uuid
				AND channel."bitmovinEncodingId" = ${claim.providerEncodingId}
				AND channel."liveEffectFenceVersion" = ${claim.generation}
				AND EXISTS (
					SELECT 1
					FROM "LiveEffectClaim" AS effect
					WHERE effect.id = ${claim.id}::uuid
						AND effect.token = ${claim.token}::uuid
						AND effect."liveChannelId" = ${claim.liveChannelId}::uuid
						AND effect."liveChannelRunId" = ${claim.liveChannelRunId}::uuid
						AND effect."providerEncodingId" = ${claim.providerEncodingId}
						AND effect.generation = ${claim.generation}
						AND effect.action = ${claim.action}
						AND effect.state = 'DISPATCHING'
				)
		`;
		return { runUpdated, channelUpdated };
	});
}

/**
 * Replaces provisioning/runtime snapshots while retaining this run's canonical
 * automatic-stop receipts. Incoming copies are never authoritative: they may
 * be stale or belong to an earlier airing. One UPDATE reads the locked row's
 * current receipts, so a concurrent append cannot be lost between a read and
 * a replacement. This operation only locks the run; it never takes a channel
 * lock after it, preserving the append helper's channel-to-run lock order.
 */
export async function replaceLiveRunStepLogSnapshot(
	prisma: Pick<AppPrismaClient, "$executeRaw">,
	liveChannelId: string,
	liveChannelRunId: string,
	snapshot: readonly unknown[],
): Promise<number> {
	if (!Array.isArray(snapshot))
		throw new Error("A live run step-log snapshot must be an array");
	return prisma.$executeRaw`
		UPDATE "LiveChannelRun" AS run
		SET "stepLog" =
			COALESCE((
				SELECT jsonb_agg(incoming.entry ORDER BY incoming.ord)
				FROM jsonb_array_elements(${JSON.stringify(snapshot)}::jsonb)
					WITH ORDINALITY AS incoming(entry, ord)
				WHERE incoming.entry->>'kind' IS DISTINCT FROM 'LIVE_AUTO_SHUTDOWN_UPDATE'
			), '[]'::jsonb)
			|| COALESCE((
				SELECT jsonb_agg(canonical.entry ORDER BY canonical.ord)
				FROM jsonb_array_elements(run."stepLog")
					WITH ORDINALITY AS canonical(entry, ord)
				WHERE canonical.entry->>'kind' = 'LIVE_AUTO_SHUTDOWN_UPDATE'
			), '[]'::jsonb)
		WHERE run.id = ${liveChannelRunId}::uuid
			AND run."liveChannelId" = ${liveChannelId}::uuid
	`;
}

/**
 * Merges ONE named snapshot into an encoding job's `snapshots` object,
 * atomically.
 *
 * Same reasoning as `appendLiveChannelStepLogEntry` above — read-modify-write on
 * a JSON column loses a concurrent writer's key, and a Prisma interactive
 * `$transaction` would not fix it (Read Committed does not prevent lost updates;
 * it would need `FOR UPDATE` or Serializable). `jsonb ||` needs neither, because
 * the read never happens.
 *
 * Concurrency here is real but mild: the per-title backfill route is
 * double-clickable, and two clicks racing each other converge on the same key.
 * What the read-modify-write version actually risked was a FUTURE second writer
 * of a different key — `snapshots` is a shared column by design — losing its
 * write to a stale in-memory copy taken before a network round-trip to Bitmovin.
 *
 * `||` MERGES when both sides are objects, which is the whole point. The CASE is
 * load-bearing: on a column holding anything other than an object (JSON null, or
 * an array — `'[1]'::jsonb || '{"a":1}'::jsonb` yields `[1,{"a":1}]`, not an
 * error), `||` would produce a shape nothing can read. The column's contract is
 * an object of named snapshots, so a non-object is corrupt with nothing worth
 * preserving and is replaced.
 *
 * The status predicate is an ATOMIC CLAIM, not decoration — the same shape
 * `retry/route.ts` uses. Its caller checks the job is terminal, then spends seconds
 * reading Bitmovin before writing; in that window a Retry can flip the row back to
 * QUEUED and the orchestrator can take it RUNNING, so an unconditional write lands
 * on an active row — precisely what the caller's own docstring says must never
 * happen (review finding). With the predicate the write simply does not apply.
 *
 * ONE MORE REASON THIS IS RAW, and it is easy to undo: `EncodingJob.updatedAt` is
 * `@updatedAt`, which Prisma maintains from the CLIENT — there is no DB default and
 * no trigger. So `prisma.encodingJob.update` bumps it, and the jobs list renders
 * a terminal job's Duration as `formatDuration(createdAt, updatedAt)`. The previous
 * read-modify-write version therefore rewrote a job's displayed run time from
 * "4m 12s" to however long ago it ran, every time someone backfilled it — silent,
 * user-visible, and untested (review catch). This statement's SET list touches
 * `snapshots` only. Do NOT "fix" it by adding `"updatedAt" = now`, and do not go
 * back to a Prisma `update`: either reintroduces it, and nothing would catch that.
 *
 * Returns rows updated: 0 means the job was deleted, or is no longer terminal,
 * which the caller reports rather than treating as a successful write.
 */
export async function mergeEncodingJobSnapshot(
	prisma: AppPrismaClient,
	encodingJobId: string,
	/**
	 * The patch, e.g. `{perTitleResults: snapshot}`. Serialised here, and the reason
	 * is `Date` — NOT `undefined`, which an earlier version of this comment claimed.
	 * A review measured Prisma's own serializer: nested `undefined` in a Json value
	 * is silently dropped, no error. What Prisma does do is RETAG a `Date` as
	 * `{"$type":"DateTime",…}`, and every Bitmovin codec config carries real Date
	 * instances (`BitmovinResource` maps `createdAt`/`modifiedAt` through `Date`), so
	 * without this round-trip the column would hold tagged objects instead of ISO
	 * strings. With `$executeRaw` the value never touches Prisma's Json input path
	 * anyway — it is a text parameter cast to jsonb.
	 */
	patch: Record<string, unknown>,
): Promise<number> {
	const json = JSON.stringify(patch);
	const updated = await prisma.$executeRaw`
		UPDATE "EncodingJob"
		SET "snapshots" = CASE
			WHEN jsonb_typeof("snapshots") = 'object'
				THEN "snapshots" || ${json}::jsonb
			ELSE ${json}::jsonb
		END
		WHERE id = ${encodingJobId}::uuid
			AND "status" NOT IN ('QUEUED', 'RUNNING')
	`;
	return updated;
}
