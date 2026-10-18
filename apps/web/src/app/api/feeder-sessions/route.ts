import {
	createFeederSessionSchema,
	enqueueFeederJob,
	FEEDER_ACTIVE_STATUSES,
	FEEDER_MAX_ACTIVE_SESSIONS,
	feederJobId,
	feederOccupancyWhere,
	masterKeyFromEnv,
} from "@bitovp/core";
import type { Prisma } from "@bitovp/db";
import type { Queue } from "bullmq";
import { NextResponse } from "next/server";
import { z } from "zod";
import { customerErrorDetails } from "@/lib/customer-error";
import { isInternalFeederError } from "@/lib/feeder-error-audience";
import { getServerContext } from "@/lib/server/context";
import {
	jsonError,
	readJson,
	routeError,
	validationError,
} from "@/lib/server/http";
import { getFeederQueue } from "@/lib/server/queue";
import { sealSourceIdentity } from "@/lib/server/storage";

/**
 * a P2002 from the partial unique index
 * `FeederSession_one_active_pusher_per_channel` — the DB's atomic single-pusher
 * guarantee. Matched structurally (no runtime Prisma error-class import;
 * `code`/`meta` are public fields of PrismaClientKnownRequestError).
 *
 * The only unique a `feederSession.create` in this route can violate is that
 * index (the id is a fresh uuid), so a P2002 here IS that, by construction. The
 * name/column check keeps a FUTURE second unique from silently borrowing this
 * 409 — tolerating both `meta.target` shapes (a raw partial index surfaces as
 * its index name, a modeled one as its field list) and an adapter that omits
 * `target` entirely.
 */
function isActivePusherViolation(err: unknown): boolean {
	if (typeof err !== "object" || err === null) {
		return false;
	}
	const e = err as { code?: unknown; meta?: { target?: unknown } };
	if (e.code !== "P2002") {
		return false;
	}
	const target = String(e.meta?.target ?? "");
	return (
		target === "" ||
		target.includes("FeederSession_one_active_pusher_per_channel") ||
		target.includes("liveChannelId")
	);
}

/**
 * Lean projection — NEVER target (it carries the RTMP streamKey),
 * logTail or loopBoundaries in lists (the live-channels list contract).
 */
const LIST_SELECT = {
	id: true,
	liveChannelId: true,
	status: true,
	protocol: true,
	sourceBucket: true,
	sourceKey: true,
	// The process ledger (audit 2026-08-29 CRITICAL-2): a terminal row that
	// still records an unreclaimed pid is stoppable and NOT deletable, and the
	// list is where an operator sees that — without these two fields the row
	// looks finished and the stop affordance disappears with the status.
	pid: true,
	processGoneAt: true,
	// The two-phase columns (row 240) the lists render as a phase chip — a
	// DOWNLOADING row that is READY is holding for a switch, not downloading.
	commitAt: true,
	readyAt: true,
	committedAt: true,
	switchSeamMs: true,
	// the publisher claim, so the panel's "this channel
	// is occupied — offer the switch" decision reads the SAME three facts the
	// server's admission counts (claim held / process may be alive / active
	// single-phase) instead of the status alone.
	publisherClaimedAt: true,
	publisherReleasedAt: true,
	startedAt: true,
	stoppedAt: true,
	error: true,
	createdAt: true,
	updatedAt: true,
} as const;

const querySchema = z.object({
	limit: z.coerce.number().int().min(1).max(100).default(50),
	cursor: z.uuid().optional(),
	/** Channel detail views list their attached feeders with this. */
	liveChannelId: z.uuid().optional(),
	/**
	 * Row 268: opt-in per-session `queued` — whether
	 * the feeder queue still holds a pending job for the session. Off by default
	 * so the UI list stays Redis-free; the verify cleanup seal turns it on to
	 * prove the queue is drained for a channel BEFORE calling teardown clean.
	 */
	queue: z.enum(["1"]).optional(),
});

/**
 * Does the feeder queue still hold a PENDING (not-settled) job for this session?
 * Row 268: a queued-but-not-yet-spawned start job is a push the process scan
 * cannot see yet, so the drained check is first-class, not inferred from status.
 * `null` = the queue could not be read (Redis down) — which cannot prove 0 jobs.
 */
async function feederJobPending(
	queue: Queue,
	sessionId: string,
): Promise<boolean | null> {
	try {
		for (const action of ["start", "stop"] as const) {
			const job = await queue.getJob(
				feederJobId({ feederSessionId: sessionId, action }),
			);
			if (!job) {
				continue;
			}
			const state = await job.getState();
			// `enqueueFeederJob` retains settled jobs (removeOnComplete/Fail 1000),
			// so a completed/failed job is present but DRAINED — only an unsettled
			// state is a job still to run.
			if (state !== "completed" && state !== "failed") {
				return true;
			}
		}
		return false;
	} catch {
		return null;
	}
}

export async function GET(req: Request) {
	const url = new URL(req.url);
	const parsed = querySchema.safeParse({
		limit: url.searchParams.get("limit") ?? undefined,
		cursor: url.searchParams.get("cursor") ?? undefined,
		liveChannelId: url.searchParams.get("liveChannelId") ?? undefined,
		queue: url.searchParams.get("queue") ?? undefined,
	});
	if (!parsed.success) {
		return validationError(parsed.error);
	}
	const { limit, cursor, liveChannelId, queue } = parsed.data;
	try {
		const ctx = await getServerContext();
		const rows = await ctx.prisma.feederSession.findMany({
			...(liveChannelId ? { where: { liveChannelId } } : {}),
			orderBy: [{ createdAt: "desc" }, { id: "desc" }],
			take: limit + 1,
			...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
			select: { ...LIST_SELECT, liveChannel: { select: { name: true } } },
		});
		const items = rows.slice(0, limit);
		const customerItems = items.map((item) => {
			const internalFailure =
				typeof item.error === "string" && isInternalFeederError(item.error);
			return {
				...item,
				error: internalFailure ? null : item.error,
				internalFailure,
			};
		});
		const withQueue = queue === "1";
		// `getFeederQueue` itself can throw with no broker — degrade to
		// `queued: null` (unknown) rather than failing the whole list.
		const feederQueue = withQueue
			? (() => {
					try {
						return getFeederQueue();
					} catch {
						return undefined;
					}
				})()
			: undefined;
		const itemsOut = withQueue
			? await Promise.all(
					customerItems.map(async (item) => ({
						...item,
						queued: feederQueue
							? await feederJobPending(feederQueue, item.id)
							: null,
					})),
				)
			: customerItems;
		return NextResponse.json({
			items: itemsOut,
			nextCursor: rows.length > limit ? items[items.length - 1]?.id : undefined,
		});
	} catch (err) {
		return routeError(err);
	}
}

/**
 * Creates a feeder session and enqueues its start job. The channel must
 * exist and be RUNNING|PROVISIONING — the worker still WAITS for RUNNING
 * before pushing (lifecycle coupling), this gate just rejects sessions
 * that could never start (stopped/error channels). The SRT passphrase is
 * accepted only as a vault credential ref (schema-strict — a literal
 * passphrase field 400s); referenced credentials are existence/provider
 * checked here for fail-fast, and re-gated by the worker at spawn.
 */
export async function POST(req: Request) {
	const body = createFeederSessionSchema.safeParse(await readJson(req));
	if (!body.success) {
		return validationError(body.error);
	}
	const data = body.data;
	try {
		// Fail fast: the worker must decrypt the source (and SRT) credential;
		// with a broken MASTER_KEY the session would just wedge.
		masterKeyFromEnv();
		const ctx = await getServerContext();
		// Stop-slot guarantee: every active session holds a feeder-worker
		// slot for its WHOLE push, so admissions are capped BELOW the worker
		// concurrency — a stop job must always find a free slot (soft cap:
		// the count-then-create window is unguarded, acceptable for an
		// operator tool; the worst case is one extra session, still < the
		// concurrency because the cap is concurrency − 1).
		// The SLOT population — every active row, staged holds included, because
		// each one's START job occupies a worker slot for its whole life. This
		// is deliberately NOT replaced by publisher occupancy (
		// LC-02): that would omit staged holds and break the reserved stop-slot
		// guarantee. The separate publisher-cap question follows immediately.
		const activeSessions = await ctx.prisma.feederSession.count({
			where: { status: { in: [...FEEDER_ACTIVE_STATUSES] } },
		});
		if (activeSessions >= FEEDER_MAX_ACTIVE_SESSIONS) {
			return jsonError(
				409,
				`File-input session limit reached (${activeSessions}/${FEEDER_MAX_ACTIVE_SESSIONS}) — stop a session before starting another`,
				customerErrorDetails("FEEDER_LIMIT_REACHED", {
					current: activeSessions,
					limit: FEEDER_MAX_ACTIVE_SESSIONS,
				}),
			);
		}
		// LC-02: the stop-slot cap and the publisher cap protect different
		// resources. A staged hold consumes a long-lived worker slot but owns no
		// publisher; conversely, a terminal row whose claim/process is unproven
		// consumes no BullMQ slot but must still count against publisher
		// admission. Keep both gates, and ask core's shared occupancy predicate
		// here exactly as the worker and per-channel doors do.
		if (!data.switchFromActive) {
			const publisherOccupancies = await ctx.prisma.feederSession.count({
				where: feederOccupancyWhere(),
			});
			if (publisherOccupancies >= FEEDER_MAX_ACTIVE_SESSIONS) {
				return jsonError(
					409,
					`Concurrent file-input limit reached (${publisherOccupancies}/${FEEDER_MAX_ACTIVE_SESSIONS}) — stop a session and wait for shutdown to complete before starting another`,
					customerErrorDetails("FEEDER_LIMIT_REACHED", {
						current: publisherOccupancies,
						limit: FEEDER_MAX_ACTIVE_SESSIONS,
					}),
				);
			}
		}
		const channel = await ctx.prisma.liveChannel.findUnique({
			where: { id: data.liveChannelId },
			select: { id: true, status: true },
		});
		if (!channel) {
			return jsonError(
				400,
				"Live channel does not exist",
				customerErrorDetails("FEEDER_CHANNEL_NOT_FOUND"),
			);
		}
		if (channel.status !== "RUNNING" && channel.status !== "PROVISIONING") {
			return jsonError(
				409,
				`File input is available only while the channel is RUNNING or PROVISIONING (current status: ${channel.status})`,
				customerErrorDetails("FEEDER_CHANNEL_NOT_READY", {
					status: channel.status,
				}),
			);
		}
		/**
		 * rev367 S-1 — the SERVER owns the single-pusher rule. The panel
		 * offers the switch checkbox only while a feeder is active, but the
		 * flag arrived unchecked: an ordinary create beside an active session
		 * opened a second push at one ingest (the jammed-socket class), and a
		 * stale switch flag staged a swap from nothing. Both directions are
		 * refused with the way forward in the message. Soft like the global
		 * cap above: the count-then-create window is unguarded, acceptable
		 * for an operator tool.
		 *
		 * "active" was the STATUS list, and a
		 * row that left it with its ffmpeg still pushing — a cross-host takeover
		 * refusal (ERROR, pid kept), a stop the owner's host could not verify,
		 * a dead START job — was invisible here for up to a lease renewal plus
		 * a kill grace, so an ordinary create was admitted beside a live push.
		 * The population is now the channel's OCCUPANCY, core's one fragment
		 * (a held publisher claim, a process nobody has proven gone, an active
		 * uncoordinated session; a staged hold for a LATER switch is none of
		 * these). The worker refuses to spawn against the same fragment and the
		 * DB refuses a second claim, so this count is the door's UX, not the
		 * guarantee — but it is the same door the audit walked through.
		 */
		const occupiedOnChannel = await ctx.prisma.feederSession.count({
			where: feederOccupancyWhere(data.liveChannelId),
		});
		if (occupiedOnChannel > 0 && !data.switchFromActive) {
			return jsonError(
				409,
				"This channel already has an active file input. Start the new file as a staged switch, or stop the active input first. A previous session whose shutdown is not yet confirmed also occupies the channel.",
				customerErrorDetails("FEEDER_CHANNEL_OCCUPIED"),
			);
		}
		if (data.switchFromActive && occupiedOnChannel === 0) {
			return jsonError(
				409,
				"A staged switch needs an active file input on this channel. Start this file as a normal input instead.",
				customerErrorDetails("FEEDER_SWITCH_REQUIRES_ACTIVE"),
			);
		}
		const sourceCredential = await ctx.credentials.get(
			data.source.credentialId,
		);
		if (!sourceCredential) {
			return jsonError(
				400,
				"Source storage credential does not exist",
				customerErrorDetails("FEEDER_SOURCE_CREDENTIAL_MISSING"),
			);
		}
		if (
			data.protocol === "SRT_CALLER" &&
			data.target.passphraseCredentialId !== undefined
		) {
			const passCred = await ctx.credentials.get(
				data.target.passphraseCredentialId,
			);
			if (!passCred) {
				return jsonError(
					400,
					"SRT passphrase credential does not exist",
					customerErrorDetails("FEEDER_SRT_CREDENTIAL_INVALID"),
				);
			}
			if (passCred.provider !== "SRT_PASSPHRASE") {
				return jsonError(
					400,
					`SRT passphrase credential must have provider SRT_PASSPHRASE (got ${passCred.provider})`,
					customerErrorDetails("FEEDER_SRT_CREDENTIAL_INVALID"),
				);
			}
		}
		/**
		 * SEAL the bytes at creation — the IMMEDIATE door's half of
		 * the same rule the scheduled door follows. An immediate session is
		 * short-lived, but "short" is not "atomic": the download still runs
		 * behind a channel wait, an ffprobe and a compatibility gate, and an
		 * object replaced in that window used to be pushed with no trace.
		 *
		 * A read failure is a 422 here rather than a 502: the operator picked
		 * this object seconds ago and can pick another, and creating a session
		 * whose source cannot be read only moves the failure to the worker.
		 */
		const seal = await sealSourceIdentity(
			ctx,
			data.source.credentialId,
			data.source.bucket,
			data.source.key,
		);
		if (!seal.ok) {
			return jsonError(
				422,
				`Source object cannot be read: ${seal.message}`,
				customerErrorDetails("FEEDER_SOURCE_UNREADABLE"),
			);
		}
		//  PR2 + SC-01: a manual feeder is admitted against one exact airing. A nullable run
		// cannot be fenced at the eventual process-spawn boundary, so legacy
		// never-run channels fail closed instead of creating an unbound session.
		const currentRun = await ctx.prisma.liveChannelRun.findFirst({
			where: { liveChannelId: data.liveChannelId },
			orderBy: { seq: "desc" },
			select: { id: true },
		});
		if (!currentRun) {
			return jsonError(
				409,
				"Feeder start needs a current live run — start the channel and wait for its run to be created, then retry",
				customerErrorDetails("FEEDER_RUN_MISSING"),
			);
		}
		/**
		 * an immediate SWITCH is the scheduled switch with lead 0 —
		 * the commit instant is now and the commit is requested at creation,
		 * so the feeder worker stages first, stops the active feeder only
		 * once the new source is READY, and spawns after it is proven gone.
		 */
		const now = new Date();
		const row = await ctx.prisma.feederSession
			.create({
				data: {
					liveChannelId: data.liveChannelId,
					liveChannelRunId: currentRun.id,
					...(data.switchFromActive
						? { commitAt: now, commitRequestedAt: now }
						: {}),
					status: "CREATED",
					sourceCredentialId: data.source.credentialId,
					sourceBucket: data.source.bucket,
					sourceKey: data.source.key,
					// : null throughout when the driver cannot name a
					// version — the download then demands nothing, which is the
					// pre-seal behaviour, named rather than pretended away.
					...(seal.identity
						? {
								sourceEtag: seal.identity.etag ?? null,
								sourceVersionId: seal.identity.versionId ?? null,
								sourceGeneration: seal.identity.generation ?? null,
								sourceSize: BigInt(seal.identity.size),
							}
						: {}),
					protocol: data.protocol,
					// streamKey inside target rides the ledgered LiveChannel.streamKey
					// redaction exception (schema comment); the SRT passphrase is a
					// vault ref only and never reaches this row.
					target: data.target as unknown as Prisma.InputJsonValue,
				},
				select: LIST_SELECT,
			})
			// the count above is check-then-act
			// — two concurrent creates on one channel both clear it. The partial
			// unique index is the ATOMIC backstop: the racing loser's INSERT is a
			// P2002, caught here and returned as a clean 409 (not a 500) below. A
			// null means "lost the single-pusher race"; create never returns null
			// otherwise.
			.catch((createErr: unknown) => {
				if (isActivePusherViolation(createErr)) {
					return null;
				}
				throw createErr;
			});
		if (row === null) {
			return jsonError(
				409,
				"This channel already has an active file input. Stop it first, or start the new file as a staged switch.",
				customerErrorDetails("FEEDER_CHANNEL_OCCUPIED"),
			);
		}
		try {
			// Shared producer convention: start jobs dedupe on the bare row id.
			await enqueueFeederJob(getFeederQueue(), {
				feederSessionId: row.id,
				action: "start",
			});
		} catch (enqueueErr) {
			// Redis down: sessions have no re-start action (stop-only), so the
			// row goes ERROR with a recreate hint instead of wedging CREATED.
			await ctx.prisma.feederSession.update({
				where: { id: row.id },
				data: {
					status: "ERROR",
					error: "Enqueue failed — create a new session",
				},
			});
			throw enqueueErr;
		}
		return NextResponse.json(row, { status: 201 });
	} catch (err) {
		return routeError(err);
	}
}
