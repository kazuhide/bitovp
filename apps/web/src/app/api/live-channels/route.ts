import {
	compileLiveChannel,
	deriveFeederRtmpTarget,
	deriveProgramSchedule,
	FEEDER_SUPPORTED_PROVIDERS,
	initStepLog,
	isFeederSupportedProvider,
	isSlateSupportedProvider,
	liveChannelPlanSchema,
	liveProgramScheduleSchema,
	liveRunWindow,
	masterKeyFromEnv,
	type PlanIssue,
	planHasErrors,
	programEndBeyondRunWindow,
	programScheduleWindowError,
	type SealedFeederSource,
	SLATE_SUPPORTED_PROVIDERS,
	type SlateSource,
	type SourceIdentity,
	scheduleBeyondRunWindow,
	VERIFICATION_DISPATCH_FENCE_REJECTED,
	VERIFICATION_DISPATCH_FENCE_REQUIRED,
	VERIFICATION_KEY_SHA_CONFLICT,
	VERIFICATION_REQUEST_SHA_MISMATCH,
	validateLiveChannel,
	verificationRequestBodySha256,
} from "@bitovp/core";
import type { Prisma } from "@bitovp/db";
import { NextResponse } from "next/server";
import { z } from "zod";
import { actorFrom } from "@/lib/server/audit";
import { getServerContext, type ServerContext } from "@/lib/server/context";
import {
	jsonError,
	readJson,
	routeError,
	validationError,
} from "@/lib/server/http";
import { latestRunsFor } from "@/lib/server/latest-runs";
import {
	recordUnrestrictedEgress,
	submitterValidationOptions,
} from "@/lib/server/plan-validation";
import { getLiveChannelQueue } from "@/lib/server/queue";
import { sealSourceIdentity } from "@/lib/server/storage";
import {
	assertVerificationDispatchFence,
	VerificationDispatchFenceError,
} from "@/lib/server/verification-dispatch";
import {
	isVerificationKeyConflict,
	VERIFICATION_DISPATCH_KEY_PAIR_MESSAGE,
	VERIFICATION_KEY_FIELDS,
	VERIFICATION_KEY_PAIR_MESSAGE,
	verificationDispatchHasKeyPair,
	verificationKeyPairComplete,
	verificationReplay,
} from "@/lib/server/verification-key";

/**
 * attach the seal taken for this source, if one could be taken.
 *
 * Keyed on the same NUL-joined triple the cache used — the fields are free
 * text (a bucket may legally contain any of `/`, `:` or `-`), and a separator
 * a value can contain is how two different sources collide onto one seal.
 */
function sealed(
	source: SlateSource,
	seals: ReadonlyMap<string, SourceIdentity | null>,
): SealedFeederSource {
	const identity = seals.get(
		`${source.credentialId}\u0000${source.bucket}\u0000${source.key}`,
	);
	return identity ? { ...source, identity } : source;
}

const bodySchema = z
	.object({
		plan: z.unknown(),
		/**
		 * Template provenance  — both-or-neither, the revision
		 * the launcher LOADED (client-supplied by design, same reasoning as the
		 * encoding-jobs route: a server re-read would misreport a raced edit).
		 */
		presetId: z.uuid().optional(),
		presetRevision: z.number().int().min(1).optional(),
		/**
		 * the broadcast slot, scheduled AT creation. The server
		 * derives the rows; the client never posts row-level schedules here.
		 * Since #125 the channel provisions IMMEDIATELY either way (billing
		 * starts at creation — the wizard says so): no START row is derived;
		 * streamUpAt anchors the slate/feeder rows only. An earlier revision
		 * of this comment still described the pre-#125 wait-for-START world
		 * (caught during #125's close-out run, 2026-08-22).
		 */
		schedule: liveProgramScheduleSchema.optional(),
		/**
		 * EV-01: the verification harness's
		 * idempotency pair — a channel bills from creation, so a
		 * lost create response must be answerable by the key alone. See
		 * `verification-key.ts`.
		 */
		...VERIFICATION_KEY_FIELDS,
	})
	.refine(
		(v) => (v.presetId === undefined) === (v.presetRevision === undefined),
		{ message: "presetId and presetRevision go together" },
	)
	.refine(verificationKeyPairComplete, {
		message: VERIFICATION_KEY_PAIR_MESSAGE,
	})
	.refine(verificationDispatchHasKeyPair, {
		message: VERIFICATION_DISPATCH_KEY_PAIR_MESSAGE,
	});

/**
 * Lean projection — never plan/stepLog/lastHeartbeat in lists (schema
 * contract; the heartbeat sample carries per-stream arrays).
 */
const LIST_SELECT = {
	id: true,
	name: true,
	status: true,
	error: true,
	bitmovinEncodingId: true,
	bitmovinAccountId: true,
	createdAt: true,
	updatedAt: true,
} as const;

const querySchema = z.object({
	limit: z.coerce.number().int().min(1).max(100).default(50),
	cursor: z.uuid().optional(),
	/** #160 PR4: probes are hidden by default; "only" feeds the probe list. */
	probes: z.enum(["exclude", "include", "only"]).default("exclude"),
});

/**
 * Feeder rows the health digest reads. Bounded, newest first: a channel that
 * has been re-aired for weeks can carry hundreds of terminal sessions, and the
 * two numbers this produces (active now, errored on THIS run) live at the top
 * of that order by construction — an active session is by definition not old,
 * and the current run is the newest one.
 */
const FEEDER_SCAN_LIMIT = 20;
const HEALTH_FEEDER_STATUSES = [
	"CREATED",
	"DOWNLOADING",
	"PUSHING",
	"ERROR",
] as const;
const ACTIVE_FEEDER_STATUSES = new Set<string>([
	"CREATED",
	"DOWNLOADING",
	"PUSHING",
]);

type HeartbeatDigest = {
	at: string;
	raw: { ingest: { status: string | null; healthy: boolean | null } };
};

/**
 * The persisted `{ at, raw, deltas }` column reduced to what a freshness
 * verdict needs, in the SHAPE core's helpers read — so the browser answers
 * "is this channel's ingest connected NOW" with `ingestConnectedTriState`,
 * the same function the detail page uses, rather than a second rule.
 *
 * Everything else the column carries (per-stream arrays, cumulative packet
 * counters, the event list) stays here: the lean-list contract is about what
 * crosses, and this crosses two scalars.
 */
function heartbeatDigest(sample: unknown): HeartbeatDigest | null {
	if (typeof sample !== "object" || sample === null) {
		return null;
	}
	const at = (sample as { at?: unknown }).at;
	if (typeof at !== "string") {
		return null;
	}
	const raw = (sample as { raw?: unknown }).raw;
	const ingest =
		typeof raw === "object" && raw !== null
			? (raw as { ingest?: unknown }).ingest
			: null;
	const record =
		typeof ingest === "object" && ingest !== null
			? (ingest as Record<string, unknown>)
			: null;
	return {
		at,
		raw: {
			ingest: {
				status:
					typeof record?.status === "string" && record.status !== ""
						? record.status
						: null,
				healthy: typeof record?.healthy === "boolean" ? record.healthy : null,
			},
		},
	};
}

/**
 * The origin observer's per-run state (#161) counted down to what a table cell
 * can hold. `null` means nothing was observed AND no reason was recorded —
 * unknown, which the list must not render as "no output": an unobservable
 * driver (MSL, NetStorage, SFTP, role-based S3) answers with a reason, and a
 * channel that simply has not been swept yet answers with neither.
 */
function originDigest(observation: unknown): {
	observed: number;
	stale: number;
	endlist: number;
	unavailableReason: string | null;
} | null {
	if (typeof observation !== "object" || observation === null) {
		return null;
	}
	const state = observation as {
		unavailableReason?: unknown;
		lastVerdicts?: unknown;
	};
	const verdicts =
		typeof state.lastVerdicts === "object" &&
		state.lastVerdicts !== null &&
		!Array.isArray(state.lastVerdicts)
			? Object.values(state.lastVerdicts as Record<string, unknown>)
			: [];
	let observed = 0;
	let stale = 0;
	let endlist = 0;
	for (const verdict of verdicts) {
		if (typeof verdict !== "object" || verdict === null) {
			continue;
		}
		observed += 1;
		const row = verdict as { stale?: unknown; endlist?: unknown };
		if (row.stale === true) {
			stale += 1;
		}
		if (row.endlist === true) {
			endlist += 1;
		}
	}
	const unavailableReason =
		typeof state.unavailableReason === "string" &&
		state.unavailableReason !== ""
			? state.unavailableReason
			: null;
	if (observed === 0 && unavailableReason === null) {
		return null;
	}
	return { observed, stale, endlist, unavailableReason };
}

/**
 * Open alerts for the whole page in ONE grouped read — the cockpit needs a
 * per-channel number and a query per row is what the audit asked us not to
 * build.
 *
 * A failure degrades to `null` — rendered as `"unknown"` — rather than failing
 * the request or printing a green zero: the alert
 * table is the one thing on this screen whose absence and whose emptiness look
 * identical and mean opposite things.
 */
async function openAlertCounts(
	prisma: ServerContext["prisma"],
	channelIds: readonly string[],
): Promise<Map<string, number> | null> {
	if (channelIds.length === 0) {
		return new Map();
	}
	try {
		const grouped = await prisma.alertEvent.groupBy({
			by: ["liveChannelId"],
			where: { resolvedAt: null, liveChannelId: { in: [...channelIds] } },
			_count: { _all: true },
		});
		return new Map(grouped.map((row) => [row.liveChannelId, row._count._all]));
	} catch {
		return null;
	}
}

export async function GET(req: Request) {
	const url = new URL(req.url);
	const parsed = querySchema.safeParse({
		limit: url.searchParams.get("limit") ?? undefined,
		cursor: url.searchParams.get("cursor") ?? undefined,
		probes: url.searchParams.get("probes") ?? undefined,
	});
	if (!parsed.success) {
		return validationError(parsed.error);
	}
	const { limit, cursor, probes } = parsed.data;
	try {
		const ctx = await getServerContext();
		const rows = await ctx.prisma.liveChannel.findMany({
			// Probes are infrastructure, not content (#160 PR4): the default
			// list hides them; the settings probe list asks for "only".
			where:
				probes === "exclude"
					? { purpose: null }
					: probes === "only"
						? { purpose: "PROBE" }
						: {},
			orderBy: [{ createdAt: "desc" }, { id: "desc" }],
			take: limit + 1,
			...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
			select: {
				...LIST_SELECT,
				// Runtime cap + its epoch  — the list's elapsed /
				// remaining cell. Scalars, so the projection stays lean.
				maxRunMinutes: true,
				runningSince: true,
				// Next-fire badge : the soonest ARMED row, if any.
				schedules: {
					where: { status: "ARMED" },
					orderBy: { fireAt: "asc" },
					take: 1,
					select: { fireAt: true, action: true },
				},
				// The newest run is NOT selected here : a nested
				// `runs: { take: 1 }` compiles to a runs query with no LIMIT,
				// so every airing of every channel on the page — heartbeat and
				// origin JSON included — was read and discarded in the engine.
				// `latestRunsFor` asks for it with a per-channel LIMIT 1.
				feederSessions: {
					where: { status: { in: [...HEALTH_FEEDER_STATUSES] } },
					orderBy: { createdAt: "desc" },
					take: FEEDER_SCAN_LIMIT,
					select: { status: true, liveChannelRunId: true },
				},
			},
		});
		const page = rows.slice(0, limit);
		const pageIds = page.map((row) => row.id);
		/**
		 * Two page-wide reads, both bounded, both issued at once: the grouped
		 * alert counts and the newest run per channel (the nested
		 * `runs: { take: 1 }` this replaces read every airing of every channel
		 * on the page). Concurrent rather than sequential because neither
		 * depends on the other, so the page still costs the operator one round
		 * trip's worth of latency.
		 */
		const [openAlertsByChannel, latestRuns] = await Promise.all([
			openAlertCounts(ctx.prisma, pageIds),
			latestRunsFor(ctx.prisma, pageIds),
		]);
		const items = page.map(
			({ schedules, feederSessions, runningSince, maxRunMinutes, ...item }) => {
				/*
				 * Run-first for the same reason every other reader is (#108
				 * PR2b): the CURRENT airing's evidence, never the previous
				 * one's afterglow. A channel that has never aired is absent
				 * from the map, which is the presence-level "not started".
				 */
				const run = latestRuns.get(item.id) ?? null;
				// A stand-in (or a pre-#250 cached shape) can hand back a row
				// without the relations; the digest degrades instead of throwing.
				const sessions = feederSessions ?? [];
				return {
					...item,
					nextSchedule: schedules?.[0] ?? null,
					health: {
						heartbeat: heartbeatDigest(run ? run.lastHeartbeat : null),
						openAlerts: openAlertsByChannel
							? (openAlertsByChannel.get(item.id) ?? 0)
							: ("unknown" as const),
						activeFeeders: sessions.filter((s) =>
							ACTIVE_FEEDER_STATUSES.has(s.status),
						).length,
						// Run-scoped: a re-air provisions a fresh encoder, so the
						// previous airing's dead feeder is not this airing's fault
						// (#108/#127/#155, the same lesson those three record).
						erroredFeeders: sessions.filter(
							(s) =>
								s.status === "ERROR" &&
								s.liveChannelRunId === (run?.id ?? null),
						).length,
						origin: originDigest(run ? run.originObservation : null),
						// Presence-level (review-243 R1): a run that exists but has
						// not started reads as "not started", not as the previous
						// run's elapsed time.
						runningSince: run ? run.runningSince : (runningSince ?? null),
						// The run's own end, so a finished broadcast's Runtime cell
						// reports how long it RAN instead of a forever-growing
						// elapsed — the owner's "36406s ago" complaint about the
						// detail strip, in the shape a list would repeat it.
						endedAt: run?.endedAt ?? null,
						maxRunMinutes: maxRunMinutes ?? null,
						// The browser owns freshness because it keeps ticking even
						// when a request stalls. Four scalars from the same newest run
						// are enough to derive UNKNOWN / UNOBSERVED without shipping
						// any additional JSON evidence column.
						provider: run
							? {
									providerStatus: run.providerStatus ?? null,
									providerStatusObservedAt:
										run.providerStatusObservedAt ?? null,
									providerUnknownSince: run.providerUnknownSince ?? null,
									providerTerminalAt: run.providerTerminalAt ?? null,
								}
							: null,
					},
				};
			},
		);
		return NextResponse.json({
			items,
			nextCursor: rows.length > limit ? items[items.length - 1]?.id : undefined,
			// The list judges heartbeat freshness and schedule countdowns on the
			// SERVER's clock, never the viewer's (review-260 127-A5, the same
			// anchor the detail route hands out).
			serverNow: new Date().toISOString(),
		});
	} catch (err) {
		return routeError(err);
	}
}

/** The projection a replay answers with — the create's own 201 shape. */
const CREATE_SELECT = {
	...LIST_SELECT,
	programStartAt: true,
	programEndAt: true,
	maxRunMinutes: true,
} as const;

/**
 * EV-01: the channel a repeated verification key already created, if any,
 * answered as the create would have (with its schedule rows) — or 409.
 */
async function verificationKeyReplay(
	prisma: ServerContext["prisma"],
	verificationKey: string,
	requestSha256: string,
) {
	const existing = await prisma.liveChannel.findUnique({
		where: { verificationKey },
		select: { ...CREATE_SELECT, verificationRequestSha256: true },
	});
	const verdict = verificationReplay(existing, requestSha256);
	if (verdict.kind === "replay") {
		const schedules = await prisma.liveSchedule.findMany({
			where: { liveChannelId: verdict.row.id },
			orderBy: { fireAt: "asc" },
		});
		// 200, not 201: nothing was created by THIS request.
		return NextResponse.json(
			{ ...verdict.row, issues: [], schedules, replayed: true },
			{ status: 200 },
		);
	}
	if (verdict.kind === "conflict") {
		return jsonError(
			409,
			"verificationKey was already used for a different request",
			{ code: VERIFICATION_KEY_SHA_CONFLICT, verificationKey },
		);
	}
	return undefined;
}

/**
 * Creates a live channel: parse plan (strict), run the live constraint
 * validator (error-level rails reject), compile, persist the parsed plan +
 * initialized step log as CREATED (the worker replays THIS — never
 * recompiles), then enqueue provisioning. jobId = row id so BullMQ dedupes
 * double-submits.
 */
export async function POST(req: Request) {
	const rawBody = await readJson(req);
	const body = bodySchema.safeParse(rawBody);
	if (!body.success) {
		return validationError(body.error);
	}
	const { verificationKey, requestSha256, verificationDispatch } = body.data;
	if (
		verificationKey !== undefined &&
		requestSha256 !== undefined &&
		verificationRequestBodySha256(rawBody) !== requestSha256
	) {
		return jsonError(400, "requestSha256 does not match the request body", {
			code: VERIFICATION_REQUEST_SHA_MISMATCH,
			verificationKey,
		});
	}
	if (verificationKey !== undefined && requestSha256 !== undefined) {
		// EV-01: a repeat of a key this deployment already honoured answers with
		// that channel (or 409) BEFORE validation and creation — a harness whose
		// response was lost gets its channel back, never a second billed one.
		try {
			const replay = await verificationKeyReplay(
				(await getServerContext()).prisma,
				verificationKey,
				requestSha256,
			);
			if (replay) {
				return replay;
			}
			if (verificationDispatch === undefined) {
				return jsonError(
					409,
					"a current verification dispatch fence is required for a new paid resource",
					{
						code: VERIFICATION_DISPATCH_FENCE_REQUIRED,
						verificationKey,
					},
				);
			}
		} catch (err) {
			return routeError(err);
		}
	}
	const parsedPlan = liveChannelPlanSchema.safeParse(body.data.plan);
	if (!parsedPlan.success) {
		return validationError(parsedPlan.error);
	}
	const plan = parsedPlan.data;
	const issues = validateLiveChannel(
		plan,
		await submitterValidationOptions(
			(await getServerContext()).prisma,
			(await getServerContext()).credentials,
		),
	);
	if (planHasErrors(issues)) {
		return jsonError(400, "Live channel plan validation failed", { issues });
	}

	if (!plan.bitmovin.accountId) {
		return jsonError(
			400,
			"plan.bitmovin.accountId is required to provision a live channel",
		);
	}
	try {
		// Fail fast before persisting: with a broken MASTER_KEY the worker
		// cannot decrypt anything, so the channel would just wedge.
		masterKeyFromEnv();
		const ctx = await getServerContext();
		// Filed once the plan is accepted, before anything is persisted or
		// enqueued — the record is about admitting the plan, not the outcome.
		await recordUnrestrictedEgress(ctx.prisma, issues, {
			path: "/api/live-channels",
			bitmovinAccountId: plan.bitmovin.accountId,
			actor: actorFrom(req),
		});
		const account = await ctx.bitmovinAccounts.get(plan.bitmovin.accountId);
		if (!account) {
			return jsonError(400, "Bitmovin account does not exist");
		}
		if (body.data.presetId !== undefined) {
			// Scoped to the LIVE kind — a job template's id is a client bug,
			// refused as such (400), not an FK 500.
			const preset = await ctx.prisma.preset.findFirst({
				where: { id: body.data.presetId, kind: "LIVE_PLAN" },
				select: { id: true },
			});
			if (!preset) {
				return jsonError(400, "Unknown template");
			}
		}
		const schedule = body.data.schedule;
		if (schedule) {
			const windowError = programScheduleWindowError(schedule, new Date());
			if (windowError) {
				return jsonError(422, windowError);
			}
			// review-223 F4: the slate credential is exercised at REGISTRATION,
			// minutes-to-days after this request — a form bypass (API caller,
			// deleted credential) surfaced there as a scheduled failure. Refuse
			// at creation, where the operator is still looking.
			if (schedule.slate) {
				const cred = await ctx.prisma.credential.findUnique({
					where: { id: schedule.slate.source.credentialId },
					select: { provider: true },
				});
				if (!cred) {
					return jsonError(422, "slate source credential does not exist");
				}
				// review-226 I2: SWAP the check per branch, never disable it —
				// a chain slate is downloaded by the FEEDER (its 7-driver
				// set), a splice slate by insertable content (its 6).
				if (schedule.programFeed) {
					if (!isFeederSupportedProvider(cred.provider)) {
						return jsonError(
							422,
							`slate source provider ${cred.provider} is not supported by the feeder (supported: ${FEEDER_SUPPORTED_PROVIDERS.join(", ")})`,
						);
					}
				} else if (!isSlateSupportedProvider(cred.provider)) {
					return jsonError(
						422,
						`slate source provider ${cred.provider} is not supported for insertable content (supported: ${SLATE_SUPPORTED_PROVIDERS.join(", ")})`,
					);
				}
			}
			if (schedule.programFeed) {
				//  — refuse at creation, not at air time (#95's
				// lesson: the operator is still looking NOW).
				const cred = await ctx.prisma.credential.findUnique({
					where: { id: schedule.programFeed.source.credentialId },
					select: { provider: true },
				});
				if (!cred) {
					return jsonError(422, "program feed credential does not exist");
				}
				if (!isFeederSupportedProvider(cred.provider)) {
					// review-226 I2: existence alone let an SFTP/role-based
					// credential 201 and fail AT AIR — the exact class the
					// comment above promises to refuse at creation.
					return jsonError(
						422,
						`program feed provider ${cred.provider} is not supported by the feeder (supported: ${FEEDER_SUPPORTED_PROVIDERS.join(", ")})`,
					);
				}
				// The same derivation the worker uses at fire time, probed with
				// no runtime columns: `pending` means the plan SHAPE works;
				// a named refusal here would otherwise surface at air.
				const probe = deriveFeederRtmpTarget(plan, null, null);
				if (probe.ok === false) {
					return jsonError(422, probe.reason);
				}
			}
		}
		// : creation IS provisioning, so one clock reading anchors
		// both the derived runtime cap and the auto-shutdown cross-check below.
		const provisionAtMs = Date.now();
		const derived = schedule
			? deriveProgramSchedule(schedule, { provisionAtMs })
			: null;
		/**
		 *  — SEAL each derived FEEDER row's source (audit 2026-08-29
		 * HIGH-4). This is the ONLY door that creates feeder rows
		 * (`liveScheduleArmSchema` refuses a manual FEEDER arm), so it is the
		 * only place an arm-time seal can be taken.
		 *
		 * Sealed per DISTINCT source, not per row: a chain whose slate and
		 * program feed name the same object would otherwise HEAD it twice, and
		 * two reads could legitimately disagree — which would then be recorded
		 * as two different armings of one file.
		 *
		 * `identity: null` (a driver with no `headObject`) leaves the row
		 * unsealed and the feed behaves exactly as it did before. A read
		 * FAILURE is a 422, matching the provider gates above: the operator is
		 * still looking now, and a source that cannot be read at creation will
		 * not have become readable by air.
		 */
		const seals = new Map<string, SourceIdentity | null>();
		for (const row of derived?.rows ?? []) {
			if (!row.feederSource) {
				continue;
			}
			const src = row.feederSource;
			const cacheKey = `${src.credentialId}\u0000${src.bucket}\u0000${src.key}`;
			if (seals.has(cacheKey)) {
				continue;
			}
			const seal = await sealSourceIdentity(
				ctx,
				src.credentialId,
				src.bucket,
				src.key,
			);
			if (!seal.ok) {
				return jsonError(
					422,
					`feed source ${src.bucket}/${src.key} cannot be read: ${seal.message}`,
				);
			}
			seals.set(cacheKey, seal.identity);
		}
		/**
		 *  — the plan's own automatic shutdown against the slot it
		 * was submitted with. The 2026-08-29 audit's paid runs #1/#2 set
		 * `streamTimeoutMinutes = 6` and got a full slot's rows accepted; the
		 * provider ended the encoding at 6 minutes and every later row fired
		 * into nothing. Refused HERE, at creation, where the operator is still
		 * looking — the same reasoning as the slate/feeder credential checks
		 * above. Only the HARD knobs refuse (see `run-window.ts`); the
		 * conditional ones ride the 201 as warnings.
		 */
		const scheduleWarnings: PlanIssue[] = [];
		if (derived) {
			const runWindow = liveRunWindow(plan, provisionAtMs, {
				maxRunMinutes: derived.maxRunMinutes,
			});
			const endRefusal = programEndBeyondRunWindow(
				runWindow,
				derived.programEndAt.getTime(),
			);
			if (endRefusal) {
				return jsonError(422, endRefusal);
			}
			for (const row of derived.rows) {
				// Every derived row is at or before programEndAt today, so this
				// loop is redundant with the check above — deliberately: a
				// derivation that later emits a row past the program end would
				// otherwise be admitted by a check that never looked at rows.
				const rowRefusal = scheduleBeyondRunWindow(runWindow, {
					action: row.action,
					fireAtMs: row.fireAt.getTime(),
				});
				if (rowRefusal) {
					return jsonError(422, rowRefusal);
				}
			}
			for (const note of runWindow.conditional) {
				scheduleWarnings.push({
					code: "LIVE_AUTO_SHUTDOWN_CONDITIONAL",
					level: "warning",
					message: note.message,
					path: `start.autoShutdown.${note.knob}`,
				});
			}
		}
		const stepLog = initStepLog(compileLiveChannel(plan));
		// One transaction: a channel with half its schedule rows would fire a
		// START with no STOP — worse than either failing whole.
		const created = await ctx.prisma.$transaction(async (tx) => {
			if (
				verificationKey !== undefined &&
				requestSha256 !== undefined &&
				verificationDispatch !== undefined
			) {
				await assertVerificationDispatchFence(tx, {
					fence: verificationDispatch,
					kind: "LIVE_CHANNEL",
					verificationKey,
					requestSha256,
				});
			}
			const row = await tx.liveChannel.create({
				data: {
					name: plan.name,
					status: "CREATED",
					// #32 §5: who created this channel — user:<id> / token:<id>.
					createdBy: actorFrom(req),
					plan: plan as unknown as Prisma.InputJsonValue,
					stepLog: stepLog as unknown as Prisma.InputJsonValue,
					bitmovinAccountId: plan.bitmovin.accountId,
					presetId: body.data.presetId ?? null,
					presetRevision: body.data.presetRevision ?? null,
					// EV-01: the harness's key and its digest of this request, in
					// the SAME insert as the row — no window between "exists" and
					// "carries its key".
					...(verificationKey !== undefined && requestSha256 !== undefined
						? {
								verificationKey,
								verificationRequestSha256: requestSha256,
							}
						: {}),
					...(derived
						? {
								programStartAt: derived.programStartAt,
								programEndAt: derived.programEndAt,
								// The runaway backstop for the day the sweep is down
								// (the 7h19m lesson) — visible in the response, not
								// silently clamped (C8's ethos).
								maxRunMinutes: derived.maxRunMinutes,
							}
						: {}),
				},
				// review-223 F8: LIST_SELECT alone dropped the derived window
				// and cap from the 201 — the caller had no way to see what the
				// server derived without a second GET.
				select: CREATE_SELECT,
			});
			if (derived) {
				await tx.liveSchedule.createMany({
					data: derived.rows.map((r) => ({
						liveChannelId: row.id,
						action: r.action,
						fireAt: r.fireAt,
						...(r.slateSource
							? {
									slateSource:
										r.slateSource as unknown as Prisma.InputJsonValue,
								}
							: {}),
						// : FEEDER rows carry their file here.
						// : with the version sealed onto it, so the
						// worker's download can demand the bytes the operator
						// chose rather than whatever the key holds at air.
						...(r.feederSource
							? {
									feederSource: sealed(
										r.feederSource,
										seals,
									) as unknown as Prisma.InputJsonValue,
								}
							: {}),
						...(r.slateUntil ? { slateUntil: r.slateUntil } : {}),
					})),
				});
			}
			return row;
		});
		const schedules = derived
			? await ctx.prisma.liveSchedule.findMany({
					where: { liveChannelId: created.id },
					orderBy: { fireAt: "asc" },
				})
			: [];
		// Every channel creation provisions immediately:
		// the scheduled path used to wait for its derived START row, and
		// the owner wants the instance up from creation (billing starts
		// here; the wizard states it). The derived rows keep STOP, slate
		// and the runtime cap; START is no longer derived at all.
		try {
			// The parent lock and local row committed together. If recovery wins
			// before this delayed add, it stops the durable row first; the Live
			// processor's STOPPED guard refuses to provision it again.
			await getLiveChannelQueue().add(
				"live-channel",
				{ liveChannelId: created.id, action: "provision" },
				{ jobId: created.id, removeOnComplete: 1000, removeOnFail: 1000 },
			);
		} catch (enqueueErr) {
			// Redis down: mark a still-CREATED row ERROR so start can recover it.
			// Recovery may already have made it STOPPED while queue.add was in flight;
			// the expected-state CAS must not undo that terminal fence.
			await ctx.prisma.liveChannel.updateMany({
				where: { id: created.id, status: "CREATED" },
				data: {
					status: "ERROR",
					error: "Enqueue failed — start the channel again",
				},
			});
			throw enqueueErr;
		}
		return NextResponse.json(
			{ ...created, issues: [...issues, ...scheduleWarnings], schedules },
			{ status: 201 },
		);
	} catch (err) {
		if (err instanceof VerificationDispatchFenceError) {
			return jsonError(
				409,
				"verification dispatch authority changed; paid create refused",
				{
					code: VERIFICATION_DISPATCH_FENCE_REJECTED,
					...(verificationKey !== undefined ? { verificationKey } : {}),
				},
			);
		}
		if (
			verificationKey !== undefined &&
			requestSha256 !== undefined &&
			isVerificationKeyConflict(err)
		) {
			// EV-01: two sends of one key raced past the pre-check; the loser's
			// insert hit the unique key (the transaction rolled back, so no
			// half-created schedule rows). The winner's channel is the answer.
			try {
				const replay = await verificationKeyReplay(
					(await getServerContext()).prisma,
					verificationKey,
					requestSha256,
				);
				if (replay) {
					return replay;
				}
			} catch (lookupErr) {
				return routeError(lookupErr);
			}
		}
		return routeError(err);
	}
}
