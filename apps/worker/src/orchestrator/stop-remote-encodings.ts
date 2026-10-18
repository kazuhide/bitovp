import { stepLogSchema } from "@bitovp/core";
import type { AppPrismaClient, Prisma } from "@bitovp/db";
import type { SdkOps } from "./sdk-ops";

/**
 * Stop the Bitmovin encodings of a job whose worker died — audit f63f76b
 * F63-RUN-009.
 *
 * A job can die OUTSIDE its processor: stalled twice, or lock lost. The `failed`
 * listener flips the row to ERROR so it does not wedge in QUEUED/RUNNING, and
 * that was the whole of the recovery. But by then the plan may have created a
 * Bitmovin encoding and started it, and nothing told the provider to stop:
 *
 *   - the processor's own cancel/stop paths never ran (its process is gone);
 *   - the cancel API refuses the row — it claims `status in (QUEUED, RUNNING)`,
 *     and the listener has just written ERROR, so every later cancel 409s.
 *
 * WHAT STOPPING COSTS, and why it is not unconditional. The first version of
 * this module asserted that "`retry` starts a NEW run rather than adopting the
 * old encoding". That was FALSE, and it was the premise the whole design rested
 * on: `retry/route.ts` says the opposite in its own docstring — FAILED steps
 * reset to PENDING, DONE steps KEEP their resource ids, so the orchestrator
 * RESUMES against the same encoding. (`re-run-as-new` is the route that starts
 * fresh.) `stall-policy.ts` records the measurement, : a real encoding
 * SIGKILLed twice landed ERROR at step 15/34 while it kept running and billing,
 * and `POST /retry` drove the same row to FINISHED 34/34 in seventy seconds,
 * untouched.
 *
 * Stopping the encoding destroys exactly that. A resumed job re-enters
 * AWAIT_ENCODING against a CANCELED encoding, which throws, and the only exit
 * left is a full re-encode from zero — so a fix written to stop a leaking bill
 * would have replaced a free 70-second recovery with a paid 4-hour one, landing
 * precisely on the stall case the repo measured as recoverable.
 *
 * So the stop is split by WHO CAN PRESS RETRY — the line `stall-policy.ts`
 * already draws:
 *   - UNATTENDED (createdBy `worker:*` — the watch sweep, the scheduler):
 *     nobody is watching, retry will never come, so stop at once.
 *   - ATTENDED (a user, a token, an interactive session): keep the encoding
 *     resumable, and let the periodic sweep stop it only after a grace window, so
 *     the bill is bounded without taking the recovery away.
 *
 * So the encoding kept billing per minute with no route to stop it from the
 * product at all. The reset SEES these rows (`unstoppedEncoders` reads any
 * status outside FINISHED/QC_FAILED that names an encoding) but only as a
 * refusal to proceed — seeing is not stopping.
 *
 * This is the stop. Same shape as the processor's own cancel sweep: ask the
 * provider for each encoding's status and stop only what is still QUEUED or
 * RUNNING, so a terminal encoding costs one GET and nothing else. Errors are
 * logged, never thrown — this runs from a failure handler and a boot sweep, and
 * neither may be killed by one unreachable encoding.
 */

export type StopRemoteDeps = {
	prisma: AppPrismaClient;
	revealBitmovinAccount: (accountId: string) => Promise<{
		apiKey: string;
		tenantOrgId: string | null;
	}>;
	makeSdk: (args: {
		apiKey: string;
		tenantOrgId: string | null;
		bitmovinAccountId: string;
		encodingJobId?: string;
		orphanStopOnly?: true;
	}) => SdkOps;
};

export type StopRemoteOutcome = {
	/** Encoding ids found in the job's step log. */
	found: string[];
	/** Encoding ids this call actually asked the provider to stop. */
	stopped: string[];
	/** Budget/ownership prevented examining the remaining resource IDs. */
	deferred?: boolean;
};

/** The states worth stopping — everything else is already over. */
const STOPPABLE = new Set(["QUEUED", "RUNNING"]);

/**
 * Nobody will press Retry on this job. `createdBy` is `worker:*` for the
 * unattended creators (watch sweep, scheduler) and a `user:`/`token:`/`session`
 * attribution — or null — for everything a human started.
 */
export function isUnattendedJob(createdBy: string | null): boolean {
	return createdBy?.startsWith("worker:") ?? false;
}

/**
 * How long an ATTENDED job keeps its encoding after dying, so Retry still
 * resumes. Long enough for an operator to come back to a failed job; short
 * enough that a forgotten one is not an open-ended bill. Periodic-sweep only —
 * unattended jobs are stopped immediately and never wait this out.
 */
export const ATTENDED_STOP_GRACE_MS = 2 * 60 * 60 * 1000;

export async function stopRemoteEncodingsFor(
	deps: StopRemoteDeps,
	encodingJobId: string,
	opts: {
		unattendedOnly?: boolean;
		eligibleBefore?: Date;
		afterEncodingId?: string | null;
		beforeEncoding?: (encodingId: string) => Promise<boolean>;
	} = {},
): Promise<StopRemoteOutcome> {
	const out: StopRemoteOutcome = { found: [], stopped: [] };
	const row = await deps.prisma.encodingJob.findUnique({
		where: { id: encodingJobId },
		select: {
			id: true,
			status: true,
			updatedAt: true,
			remoteStopRequestedAt: true,
			stepLog: true,
			bitmovinAccountId: true,
			createdBy: true,
		},
	});
	if (row?.status !== "ERROR") return out;
	if (
		opts.eligibleBefore &&
		!row.remoteStopRequestedAt &&
		row.updatedAt >= opts.eligibleBefore
	)
		return out;
	if (opts.unattendedOnly && row && !isUnattendedJob(row.createdBy)) {
		// Attended: leave the encoding resumable for Retry ('s
		// measured 70-second recovery). The boot sweep's grace window is what
		// bounds the bill if nobody ever comes back.
		return out;
	}
	if (!row?.bitmovinAccountId) {
		// No account resolved ⇒ the run died before it could create anything
		// on the provider. Nothing to stop, and no way to authenticate anyway.
		return out;
	}
	let entries: ReturnType<typeof stepLogSchema.parse>;
	try {
		entries = stepLogSchema.parse(row.stepLog);
	} catch {
		// A step log we cannot parse must not silence the sweep for other jobs.
		console.error(
			`[orchestrator] stop-remote: job ${encodingJobId} has an unparseable step log`,
		);
		return out;
	}
	for (const entry of entries) {
		if (entry.kind === "CREATE_ENCODING" && entry.resourceId) {
			if (!out.found.includes(entry.resourceId))
				out.found.push(entry.resourceId);
		}
	}
	if (out.found.length === 0) {
		return out;
	}
	let sdk: SdkOps;
	try {
		const account = await deps.revealBitmovinAccount(row.bitmovinAccountId);
		sdk = deps.makeSdk({
			apiKey: account.apiKey,
			tenantOrgId: account.tenantOrgId,
			bitmovinAccountId: row.bitmovinAccountId,
			encodingJobId,
			orphanStopOnly: true,
		});
	} catch (err) {
		console.error(
			`[orchestrator] stop-remote: cannot reach the Bitmovin account for job ${encodingJobId} — ${out.found.length} encoding(s) may still be RUNNING and billing:`,
			err instanceof Error ? err.message : err,
		);
		return out;
	}
	for (const encodingId of [...out.found].sort()) {
		if (opts.afterEncodingId && encodingId <= opts.afterEncodingId) continue;
		if (opts.beforeEncoding && !(await opts.beforeEncoding(encodingId))) {
			out.deferred = true;
			break;
		}
		try {
			const task = await sdk.getEncodingStatus(encodingId);
			if (!STOPPABLE.has(String(task.status))) {
				continue;
			}
			// Retry and STOP intent compete on the SAME row. A read alone would
			// leave a TOCTOU window. No provider I/O is held inside a DB transaction.
			const fresh = await deps.prisma.encodingJob.findUnique({
				where: { id: encodingJobId },
				select: {
					status: true,
					updatedAt: true,
					remoteStopRequestedAt: true,
					bitmovinAccountId: true,
					stepLog: true,
				},
			});
			if (
				fresh?.status !== "ERROR" ||
				fresh.bitmovinAccountId !== row.bitmovinAccountId ||
				JSON.stringify(fresh.stepLog) !== JSON.stringify(row.stepLog)
			)
				continue;
			if (
				opts.eligibleBefore &&
				!fresh.remoteStopRequestedAt &&
				fresh.updatedAt >= opts.eligibleBefore
			)
				continue;
			const claimed = await deps.prisma.encodingJob.updateMany({
				where: {
					id: encodingJobId,
					status: "ERROR",
					updatedAt: fresh.updatedAt,
					bitmovinAccountId: row.bitmovinAccountId,
					stepLog: { equals: row.stepLog as Prisma.InputJsonValue },
					remoteStopRequestedAt: fresh.remoteStopRequestedAt,
				},
				data: {
					remoteStopRequestedAt: fresh.remoteStopRequestedAt ?? new Date(),
				},
			});
			if (claimed.count !== 1) continue;
			await sdk.stopEncoding(encodingId);
			out.stopped.push(encodingId);
			// LOUD on success too: this is a billing event an operator reading
			// the log after an incident needs to be able to find.
			console.warn(
				`[orchestrator] stop-remote: requested STOP for encoding ${encodingId} left running by dead job ${encodingJobId}; terminal confirmation is separate`,
			);
		} catch (err) {
			console.error(
				`[orchestrator] stop-remote: failed to stop encoding ${encodingId} of job ${encodingJobId} (it may still be billing):`,
				err instanceof Error ? err.message : err,
			);
		}
	}
	return out;
}

/**
 * The boot half. The failure-time call covers the common case, but it runs
 * in-process: a worker that is itself dying (OOM, SIGKILL, the box going away)
 * never gets to make it, and every job stranded before this code existed has
 * nobody to make it at all.
 *
 * Scoped to ERROR rows that NAME an encoding. RUNNING/QUEUED rows are excluded
 * on purpose — a live worker owns those, and stopping one out from under its
 * processor is the opposite of this module's job. FINISHED/QC_FAILED are over.
 *
 * ERROR rows do not self-drain. A durable keyset cursor visits immutable job
 * and resource IDs, wraps at the end, and survives restarts. Each resource is
 * checkpointed BEFORE its request: a crash cannot pin every boot to that same
 * resource; it will be retried on the next rotation. Cursor CAS loss aborts
 * this pass, not a newer worker's progress. Reset preserves AppSetting; a
 * deleted cursor job is harmless because keyset scans do not require it.
 *
 * NOT filtered on `bitmovinEncodingId`. That column is denormalised and
 * `processor.ts` writes it ONLY when the job has exactly one CREATE_ENCODING
 * step (`soleEncodingStepId` returns null for a ladder — its own comment says
 * so). Selecting on it made this sweep blind to every MULTI-encoding job: the
 * Dolby ladders, which compile to two and three encodings and are the most
 * expensive population there is. The work already walks the step log and
 * returns early for a job that created nothing, so the filter bought nothing
 * and cost the case that mattered most (review-299 I1).
 */
export async function reconcileUnstoppedEncodings(
	deps: StopRemoteDeps,
	limit = 200,
	opts: {
		graceMs?: number;
		now?: () => Date;
		clock?: () => number;
		maxMs?: number;
		maxEncodings?: number;
	} = {},
): Promise<number> {
	if (!Number.isInteger(limit) || limit < 1)
		throw new Error("Invalid orphan sweep limit");
	limit = Math.min(limit, 200);
	const graceMs = opts.graceMs ?? ATTENDED_STOP_GRACE_MS;
	const now = opts.now?.() ?? new Date();
	const eligibleBefore = new Date(now.getTime() - graceMs);
	const clock = opts.clock ?? Date.now;
	const deadline =
		clock() + Math.max(1, Math.min(opts.maxMs ?? 30_000, 30_000));
	let remaining = Math.max(1, Math.min(opts.maxEncodings ?? 200, 200));
	const setting = await deps.prisma.appSetting.upsert({
		where: { key: ORPHAN_STOP_CURSOR_KEY },
		create: { key: ORPHAN_STOP_CURSOR_KEY, value: EMPTY_CURSOR },
		update: {},
	});
	let cursor = parseCursor(setting.value);
	let lost = false;
	const advance = async (next: StopCursor): Promise<boolean> => {
		const result = await deps.prisma.appSetting.updateMany({
			where: { key: ORPHAN_STOP_CURSOR_KEY, value: { equals: cursor } },
			data: { value: next },
		});
		if (result.count !== 1) {
			lost = true;
			console.warn(
				"[orchestrator] orphan cursor changed; yielding without overwriting another sweep",
			);
			return false;
		}
		cursor = next;
		return true;
	};
	const rows = await deps.prisma.encodingJob.findMany({
		// The grace window is what keeps Retry working (see the module doc):
		// a job that died minutes ago may still be resumed by its operator, and
		// stopping its encoding would make that resume throw on a CANCELED
		// encoding. Old enough, and nobody is coming.
		where: {
			status: "ERROR",
			OR: [
				{ updatedAt: { lt: eligibleBefore } },
				{ remoteStopRequestedAt: { not: null } },
			],
			...(cursor.afterId
				? {
						id: cursor.complete
							? { gt: cursor.afterId }
							: { gte: cursor.afterId },
					}
				: {}),
		},
		select: { id: true },
		orderBy: { id: "asc" },
		take: limit,
	});
	if (rows.length === limit) {
		console.warn(
			`[orchestrator] unstopped-encoding sweep hit its ${limit}-row cap — durable cursor continues on the next pass`,
		);
	}
	let stopped = 0;
	for (const row of rows) {
		if (lost || remaining === 0 || clock() >= deadline) break;
		let deferred = false;
		try {
			const outcome = await stopRemoteEncodingsFor(deps, row.id, {
				eligibleBefore,
				afterEncodingId:
					cursor.afterId === row.id && !cursor.complete
						? cursor.encodingAfter
						: null,
				beforeEncoding: async (encodingId) => {
					if (lost || remaining === 0 || clock() >= deadline) return false;
					const previous = cursor;
					if (
						!(await advance({
							afterId: row.id,
							encodingAfter: encodingId,
							complete: false,
						}))
					)
						return false;
					remaining -= 1;
					if (clock() < deadline) return true;
					// This resource was NOT dispatched. Restore only our own
					// checkpoint, so repeated slow preceding reads cannot skip it
					// on every lap. An ambiguous restore must not complete the row.
					try {
						await advance(previous);
					} catch {
						lost = true;
						console.error(
							"[orchestrator] orphan cursor restore unverified; ending pass without marking the resource checked",
						);
					}
					return false;
				},
			});
			stopped += outcome.stopped.length;
			deferred = outcome.deferred ?? false;
		} catch (err) {
			// PER-ROW isolation. The module doc promises errors are "logged,
			// never thrown", and the loop did not honour it: `findUnique` sits
			// outside the inner try blocks, so one row's DB error abandoned every
			// LATER row in the sweep — each of which may name an encoding that is
			// still billing. One unreachable job must not cost the rest
			// (review-299 F4, proven by construction).
			console.error(
				`[orchestrator] stop-remote: sweep failed on job ${row.id} (continuing with the rest):`,
				err instanceof Error ? err.message : err,
			);
		}
		if (lost || deferred) break;
		if (
			!(await advance({ afterId: row.id, encodingAfter: null, complete: true }))
		)
			break;
	}
	if (rows.length === 0 && cursor.afterId) await advance(EMPTY_CURSOR);
	return stopped;
}

/** Internal checkpoint, not an operator setting or proof of provider cleanup. */
export const ORPHAN_STOP_CURSOR_KEY = "internal:vod-orphan-stop-cursor:v1";
type StopCursor = {
	afterId: string | null;
	encodingAfter: string | null;
	complete: boolean;
};
const EMPTY_CURSOR: StopCursor = {
	afterId: null,
	encodingAfter: null,
	complete: true,
};
function parseCursor(value: Prisma.JsonValue): StopCursor {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).sort().join(",") !== "afterId,complete,encodingAfter" ||
		!(value.afterId === null || typeof value.afterId === "string") ||
		!(
			value.encodingAfter === null || typeof value.encodingAfter === "string"
		) ||
		typeof value.complete !== "boolean"
	)
		throw new Error("Invalid orphan sweep cursor");
	if (
		(value.afterId === null &&
			(!value.complete || value.encodingAfter !== null)) ||
		(value.complete && value.encodingAfter !== null)
	)
		throw new Error("Inconsistent orphan sweep cursor");
	return {
		afterId: value.afterId,
		encodingAfter: value.encodingAfter,
		complete: value.complete,
	};
}

/** SDK transport abort/cancellation is awaited, never detached by Promise.race.
 * The 30s budget stops NEW checks; DB/audit waits are not hard-time-bounded. */
export function createUnstoppedEncodingReconciler(deps: StopRemoteDeps) {
	let active = false;
	return async (): Promise<number> => {
		if (active) return 0;
		active = true;
		try {
			return await reconcileUnstoppedEncodings(deps);
		} finally {
			active = false;
		}
	};
}
