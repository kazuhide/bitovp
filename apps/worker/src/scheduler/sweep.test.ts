import { feederError } from "@bitovp/core";
import { type AppPrismaClient, DB_NULL, projectSelected } from "@bitovp/db";
import { describe, expect, it, vi } from "vitest";
import { releaseDeadStageClaim } from "../live/dead-job-outcome";
import { recordScheduleOutcome } from "./schedule-outcome";
import {
	createScheduleSweep,
	DUE_SCAN_BUDGET,
	REARM_REPLAY_CAP,
	REGISTRATION_SCAN_BUDGET,
} from "./sweep";

/**
 *  scheduler contract, rewritten with review-190:
 * the sweep must make the ROUTE's channel claims and never report success
 * for work that did not happen. The store is STATEFUL with real
 * compare-and-set semantics on BOTH tables — review-190 proved the first
 * cut's defects lived exactly in the seam a mock-count store cannot see.
 */

const CH = "11111111-1111-4111-8111-111111111111";
const ROW_ID = "22222222-2222-4222-8222-222222222222";
const CONTENT_ID = "99999999-9999-4999-8999-999999999999";

type Row = {
	id: string;
	liveChannelId: string;
	action: "START" | "STOP" | "SLATE_IN" | "FEEDER_START" | "FEEDER_SWITCH";
	fireAt: Date;
	insertableContentId: string | null;
	slateDurationSeconds: number | null;
	status:
		| "ARMED"
		| "FIRED"
		| "COMPLETED"
		| "CANCELED"
		| "MISSED"
		| "ERROR"
		| "SKIPPED_STALE_GENERATION";
	firedAt: Date | null;
	/** : the airing this row was armed for (null = not yet bound). */
	liveChannelRunId: string | null;
	/** : the queue-handoff outbox stamp. */
	dispatchedAt: Date | null;
	dispatchJobId: string | null;
	note: string | null;
	error: string | null;
	/**  creation-time slate fields. */
	slateSource: unknown;
	slateUntil: Date | null;
	contentClaimedAt: Date | null;
	/**  feeder-chain fields. */
	feederSource: unknown;
	/**  PR2 deadline fields. */
	airAt: Date | null;
	deadlineMarginSeconds: number;
	deadlineNotifiedAt: Date | null;
	/**  PR3. */
	autoLeadTime: boolean;
	/** : the two-phase switch's session pointer and stage outbox. */
	feederSessionId: string | null;
	stagedAt: Date | null;
	stageDispatchedAt: Date | null;
	readyAt: Date | null;
	switchSeamMs: number | null;
	outcome?: string;
	outcomeNote?: string | null;
	outcomeEvidenceVersion?: number | null;
	outcomeEvidenceKind?: string | null;
	outcomeEvidenceAt?: Date | null;
};

/** : what the sweep reads of a staged FeederSession. */
type SessionRow = {
	id: string;
	status: string;
	readyAt: Date | null;
	error: string | null;
};

type Channel = {
	id: string;
	status: string;
	bitmovinEncodingId: string | null;
	stepLog: unknown;
	maxRunMinutes: number | null;
	runningSince: Date | null;
	error: string | null;
	/** : the slate fire gate reads the persisted ingest state. */
	lastHeartbeat: unknown;
	/** : the STOPPED and empty-log arms compile the plan here. */
	plan: unknown;
	liveEffectFenceVersion: number;
};

/**
 * A schema-valid live plan for the sweep's #155 compiles (the same
 * product-built shape the actions route test uses; the compile never
 * contacts Bitmovin). Base path `live-sweep` — the rebase pins read it.
 */
function sweepPlan(): Record<string, unknown> {
	return {
		planVersion: 1,
		name: "live-sweep",
		bitmovin: {
			cloudRegion: "AWS_AP_NORTHEAST_1",
			encoderVersion: "STABLE",
			accountId: "490e5e74-2ea2-44c2-a8d6-0d51ba4ce84d",
		},
		liveInput: {
			key: "main",
			kind: "REDUNDANT_RTMP",
			name: "Redundant RTMP Input",
			staticIngestPoints: [
				{ name: "primary", streamKeyConfiguration: { type: "GENERATE" } },
			],
		},
		outputs: [
			{
				key: "origin",
				kind: "S3",
				credentialId: "4c885bd1-33ef-47b0-9506-3b765f91f324",
				bucket: "ap-northeast-1-output",
				name: "S3 Output",
			},
		],
		ingest: [
			{ key: "video", inputPath: "/", position: 0 },
			{ key: "audio", inputPath: "/", position: 1 },
		],
		renditions: [
			{
				key: "v720",
				ingestKey: "video",
				codec: "H264",
				name: "Live H264 720p",
				height: 720,
				bitrate: 3000000,
				level: null,
				presetConfiguration: "LIVE_STANDARD",
				mode: "STANDARD",
			},
			{
				key: "a128",
				ingestKey: "audio",
				codec: "AAC",
				bitrate: 128000,
				rate: 48000,
				channelLayout: "CL_STEREO",
			},
		],
		muxings: [
			{
				key: "v720",
				kind: "FMP4",
				streamKey: "v720",
				segmentLength: 6,
				segmentNaming: "segment_%number%.m4s",
				initSegmentName: "init.mp4",
				destination: { outputKey: "origin", path: "live-sweep/video/720p" },
			},
			{
				key: "a128",
				kind: "FMP4",
				streamKey: "a128",
				segmentLength: 6,
				segmentNaming: "segment_%number%.m4s",
				initSegmentName: "init.mp4",
				destination: { outputKey: "origin", path: "live-sweep/audio/128000" },
			},
		],
		liveManifests: [
			{
				key: "hls",
				kind: "HLS",
				manifestName: "stream.m3u8",
				name: "Live HLS Manifest",
				destination: { outputKey: "origin", path: "live-sweep" },
				audioGroupId: "audio",
				audioLanguage: "en",
				closedCaptions: "NONE",
			},
		],
		start: { streamKey: "sweeplaunch" },
	} as unknown as Record<string, unknown>;
}

function makeRow(over: Partial<Row> = {}): Row {
	return {
		id: ROW_ID,
		liveChannelId: CH,
		action: "START",
		// One minute overdue at the default now of 2_000_000.
		fireAt: new Date(1_940_000),
		insertableContentId: null,
		slateDurationSeconds: null,
		status: "ARMED",
		firedAt: null,
		liveChannelRunId: null,
		dispatchedAt: null,
		dispatchJobId: null,
		note: null,
		error: null,
		slateSource: null,
		slateUntil: null,
		contentClaimedAt: null,
		feederSource: null,
		airAt: null,
		deadlineMarginSeconds: 300,
		deadlineNotifiedAt: null,
		autoLeadTime: false,
		feederSessionId: null,
		stagedAt: null,
		stageDispatchedAt: null,
		readyAt: null,
		switchSeamMs: null,
		...over,
	};
}

/**
 * A persisted heartbeat COLUMN value proving the ingest is CONNECTED — the
 * production wrapper `{ at, raw, deltas }` (review-224 C1: the first fixture
 * here hand-built a flat `{ ingest }` shape the writer never emits, and the
 * constant-false predicate shipped green under it).
 */
const HB_CONNECTED = {
	// ON the injected clock (review-260 127-A8): the sweep's default now is
	// new Date(2_000_000), and a 2026 date here rode the future-skew
	// tolerance — green, but through the wrong branch, and any tightening of
	// skew handling would break every user of this fixture for an unrelated
	// reason. 30s before now = a realistically fresh sample.
	at: new Date(2_000_000 - 30_000).toISOString(),
	raw: { ingest: { status: "CONNECTED", healthy: true } },
	deltas: {},
};

function makeChannel(over: Partial<Channel> = {}): Channel {
	return {
		id: CH,
		status: "CREATED",
		bitmovinEncodingId: null,
		stepLog: [],
		maxRunMinutes: null,
		runningSince: null,
		error: null,
		lastHeartbeat: null,
		plan: sweepPlan(),
		liveEffectFenceVersion: 0,
		...over,
	};
}

/** The `(fireAt, id)` keyset cursor the sweep pages both ARMED scans with. */
type ScanCursorArg = {
	AND?: Array<{
		OR?: Array<{
			fireAt?: { gt?: Date } | Date;
			id?: { gt: string } | { in: string[] };
		}>;
	}>;
};

/**
 *  — ORDER, WINDOW and CURSOR, honoured for real on the two ARMED
 * scans.
 *
 * The fake used to return every matching row in insertion order and ignore
 * `orderBy`/`take` entirely, which made the starving window INVISIBLE: the
 * pre-fix `orderBy fireAt asc, take 100` looked like it read the whole due
 * set, so a test for starvation would have gone green against the defect. A
 * loose mock manufactures findings as readily as it hides them, so this
 * models the three parts the fix depends on.
 *
 * The two outbox recovery scans also honour this window. Deadline and
 * initial pre-stage scans retain their separate filtering behaviour.
 */
function applyWindow(
	rows: Row[],
	args: {
		where: ScanCursorArg;
		orderBy?:
			| { fireAt?: "asc" | "desc"; id?: "asc" | "desc" }
			| Array<{ fireAt?: "asc" | "desc"; id?: "asc" | "desc" }>;
		take?: number;
	},
): Row[] {
	// The window arrives as ONE `AND` element holding ONE `OR`:
	// `[{fireAt:{gt}}, {fireAt, id:{gt}}]` plus, when the scan owes
	// re-examinations, `{id:{in:[...]}}`. Under AND because the registration
	// scan spends its object's top-level OR on claim staleness — honouring
	// the nesting here is what makes the shape assertion below meaningful.
	const clause = args.where.AND?.[0]?.OR;
	const gt = clause?.[0]?.fireAt;
	const tie = clause?.[1];
	const cursor =
		gt &&
		typeof gt === "object" &&
		"gt" in gt &&
		gt.gt &&
		tie?.id &&
		"gt" in tie.id
			? { fireAt: tie.fireAt as Date, id: tie.id.gt }
			: null;
	// Review #356 v2: a replayed id matches REGARDLESS of the cursor. A fake
	// that dropped this term would answer the same rows with and without the
	// replay set and green the whole mechanism.
	const replayTerm = clause?.[2]?.id;
	const replay =
		replayTerm && "in" in replayTerm
			? new Set(replayTerm.in)
			: new Set<string>();
	const after = cursor
		? rows.filter(
				(row) =>
					row.fireAt.getTime() > cursor.fireAt.getTime() ||
					(row.fireAt.getTime() === cursor.fireAt.getTime() &&
						row.id > cursor.id) ||
					replay.has(row.id),
			)
		: rows;
	const keys = Array.isArray(args.orderBy)
		? args.orderBy
		: args.orderBy
			? [args.orderBy]
			: [];
	const sorted = [...after].sort((a, b) => {
		for (const key of keys) {
			if (key.fireAt) {
				const delta = a.fireAt.getTime() - b.fireAt.getTime();
				if (delta !== 0) {
					return key.fireAt === "asc" ? delta : -delta;
				}
			}
			if (key.id) {
				// Plain comparison, the same one `advanceCursor` and the
				// `id: { gt }` keyset term use — a locale-aware collation here
				// could order the fake differently from the code under test.
				const delta = a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
				if (delta !== 0) {
					return key.id === "asc" ? delta : -delta;
				}
			}
		}
		return 0;
	});
	return typeof args.take === "number" ? sorted.slice(0, args.take) : sorted;
}

function makeStore(
	rows: Row[],
	channels: Channel[] = [makeChannel()],
	sessions: SessionRow[] = [],
) {
	let nextId = 0;
	// review-284 N2a: claim-scope writes must arrive through the TX HANDLE
	// while a transaction is open — see the $transaction docstring below.
	let inTx = false;
	let viaTx = false;
	const through = async (call: () => Promise<unknown>) => {
		viaTx = true;
		try {
			return await call();
		} finally {
			viaTx = false;
		}
	};
	const guardEscape = (name: string) => {
		if (inTx && !viaTx) {
			throw new Error(
				`write escaped the transaction: ${name} ran on the ROOT client while a tx was open`,
			);
		}
	};
	const store = {
		runs: [] as Array<{
			id: string;
			liveChannelId?: string;
			seq: number;
			status: string;
			outputPrefix?: string;
			providerStatus?: string | null;
			providerStatusObservedAt?: Date | null;
			providerUnknownSince?: Date | null;
			providerTerminalAt?: Date | null;
			lastHeartbeat?: unknown;
			endedAt?: Date | null;
			heartbeatSummary?: unknown;
			heartbeatSummaryAt?: Date | null;
			bitmovinEncodingId?: string | null;
			encoderStoppedConfirmedFor?: string | null;
		}>,
		rows,
		channels,
		/** : the staged sessions the commit gate reads. */
		sessions,
		latch: null as null | { expected: number; waiters: (() => void)[] },
		/**
		 * The DISPATCHER scan's own latch (rev346 LOW-1). Separate from
		 * `latch` on purpose: they release every waiter that ever queued, so
		 * one shared latch would be satisfied by the dispatcher pass and then
		 * let `fireDue`'s racing readers straight through — silently
		 * un-latching the arm above it.
		 */
		dispatchLatch: null as null | {
			expected: number;
			waiters: (() => void)[];
		},
		prisma: {
			/**
			 * Interactive-tx fake WITH rollback semantics (review-284 N2): the
			 * sweep's claimWithRun expects a failed run write to roll the
			 * channel claim back — a fake that kept the claim would green a
			 * world real Postgres refuses to produce. Data-only snapshot; the
			 * vi.fn delegates live outside it.
			 *
			 * And WITH connection fidelity (review-284 N2a): the tx callback
			 * receives a DISTINCT handle whose writes route through
			 * `through`; the claim-scope write fns themselves throw when a
			 * tx is open and the call did not come through that handle — so
			 * `tx.liveChannelRun.create` silently rewritten to
			 * `deps.prisma.…` (a write that would ESCAPE the rollback on real
			 * Postgres, the exact N2 class) fails the suite instead of
			 * greening. Honest limits, stated: the restore is WHOLESALE over
			 * the three arrays (fine single-threaded, would over-revert an
			 * interleaved legitimate write), and the fake never raises P2002
			 * organically — unique-index refusals are asserted by injection,
			 * not modelled.
			 */
			$transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
				const snapshot = structuredClone({
					rows: store.rows,
					channels: store.channels,
					runs: store.runs,
				});
				inTx = true;
				const tx = {
					...store.prisma,
					liveSchedule: {
						...store.prisma.liveSchedule,
						updateMany: (args: unknown) =>
							through(() =>
								(
									store.prisma.liveSchedule.updateMany as (
										a: unknown,
									) => Promise<unknown>
								)(args),
							),
					},
					liveChannel: {
						...store.prisma.liveChannel,
						updateMany: (args: unknown) =>
							through(() =>
								(
									store.prisma.liveChannel.updateMany as (
										a: unknown,
									) => Promise<unknown>
								)(args),
							),
					},
					liveChannelRun: {
						...store.prisma.liveChannelRun,
						create: (args: unknown) =>
							through(() =>
								(
									store.prisma.liveChannelRun.create as (
										a: unknown,
									) => Promise<unknown>
								)(args),
							),
						update: (args: unknown) =>
							through(() =>
								(
									store.prisma.liveChannelRun.update as (
										a: unknown,
									) => Promise<unknown>
								)(args),
							),
					},
				};
				try {
					return await fn(tx);
				} catch (err) {
					store.rows = snapshot.rows;
					store.channels = snapshot.channels;
					store.runs = snapshot.runs;
					throw err;
				} finally {
					inTx = false;
				}
			},
			/**
			 * : the SESSION the commit gate reads. Only the projection
			 * the sweep selects, honoured by id.
			 */
			feederSession: {
				findUnique: vi.fn(async (args: { where: { id: string } }) => {
					const hit = store.sessions.find((s) => s.id === args.where.id);
					return hit ? { ...hit } : null;
				}),
			},
			liveSchedule: {
				findMany: vi.fn(
					async (args: {
						where: {
							fireAt?: { lte?: Date; gt?: Date };
							firedAt?: { lt: Date };
							status?: string | { in: string[] };
							dispatchedAt?: null;
							insertableContentId?: null;
							contentClaimedAt?: null;
							OR?: Array<{ contentClaimedAt: null | { lt: Date } }>;
							action?: string;
							airAt?: { not: null; lte?: Date };
							deadlineNotifiedAt?: null;
							stagedAt?: null | { not: null; lt: Date };
							stageDispatchedAt?: null;
						} & ScanCursorArg;
						// : both honoured for the two ARMED scans.
						orderBy?:
							| { fireAt?: "asc" | "desc"; id?: "asc" | "desc" }
							| Array<{ fireAt?: "asc" | "desc"; id?: "asc" | "desc" }>;
						take?: number;
					}) => {
						if ("stageDispatchedAt" in args.where) {
							// : the dispatcher's STAGE half — ARMED switch
							// rows whose stage claim is older than the grace and
							// carries no handoff stamp. Every term honoured: the
							// `lt` keeps a claim still being added out of the
							// recovery, the stamp keeps healthy stages out of it,
							// and the fireAt lower bound (rev367 I-3) keeps a claim
							// stranded PAST its fire time with the due scan, which
							// refuses the row instead of re-staging it.
							const claim = args.where.stagedAt as
								| { not: null; lt: Date }
								| undefined;
							const notYetDue = args.where.fireAt?.gt;
							return applyWindow(
								store.rows.filter(
									(row) =>
										row.status === "ARMED" &&
										row.action === "FEEDER_SWITCH" &&
										row.stagedAt !== null &&
										row.stageDispatchedAt === null &&
										(claim?.lt === undefined ||
											row.stagedAt.getTime() < claim.lt.getTime()) &&
										(notYetDue === undefined ||
											row.fireAt.getTime() > notYetDue.getTime()),
								),
								args,
							).map((row) => ({ ...row }));
						}
						if ("stagedAt" in args.where) {
							// : the pre-stage scan — unstaged switch rows
							// inside the maximum lead and (rev367 I-3) not yet due.
							// The per-row lead decision is the sweep's own, so the
							// fake returns the whole window.
							const horizon = args.where.fireAt?.lte;
							const notYetDue = args.where.fireAt?.gt;
							return store.rows
								.filter(
									(row) =>
										row.status === "ARMED" &&
										row.action === "FEEDER_SWITCH" &&
										row.stagedAt === null &&
										(horizon === undefined ||
											row.fireAt.getTime() <= horizon.getTime()) &&
										(notYetDue === undefined ||
											row.fireAt.getTime() > notYetDue.getTime()),
								)
								.map((row) => ({ ...row }));
						}
						if ("dispatchedAt" in args.where) {
							// : the outbox dispatcher's scan — FIRED rows
							// with no handoff stamp whose claim is older than the
							// grace. Every filter is honoured because each one is
							// load-bearing: dropping `dispatchedAt` would re-dispatch
							// healthy rows, and dropping `firedAt` would race the
							// tick that is still adding the job.
							const olderThan = args.where.firedAt;
							if (store.dispatchLatch) {
								const { dispatchLatch } = store;
								await new Promise<void>((resolve) => {
									dispatchLatch.waiters.push(resolve);
									if (dispatchLatch.waiters.length >= dispatchLatch.expected) {
										for (const release of dispatchLatch.waiters) {
											release();
										}
									}
								});
							}
							return applyWindow(
								store.rows.filter(
									(row) =>
										row.status === "FIRED" &&
										row.dispatchedAt === null &&
										row.firedAt !== null &&
										(olderThan === undefined ||
											row.firedAt.getTime() < olderThan.lt.getTime()),
								),
								args,
							).map((row) => ({ ...row }));
						}
						if (args.where.airAt !== undefined) {
							//  PR2: the deadline scan — START rows with an
							// airAt inside the horizon, no stamp yet, and not CANCELED.
							// Must be dispatched BEFORE the fireAt-undefined slate
							// branch, which would otherwise swallow it.
							const horizon = args.where.airAt.lte;
							return store.rows
								.filter(
									(row) =>
										row.action === "START" &&
										row.airAt !== null &&
										(horizon === undefined ||
											(row.airAt as Date).getTime() <= horizon.getTime()) &&
										row.deadlineNotifiedAt === null &&
										row.status !== "CANCELED",
								)
								.map((row) => ({ ...row }));
						}
						if (args.where.fireAt === undefined) {
							// : the registration pass — ARMED SLATE_IN rows
							// with a source, no content id and an ABSENT or STALE
							// claim (review-223 F1's reaper). Honouring each filter
							// matters: the CAS depends on them.
							const orClauses = args.where.OR ?? [{ contentClaimedAt: null }];
							const claimMatches = (claim: Date | null) =>
								orClauses.some((clause) =>
									clause.contentClaimedAt === null
										? claim === null
										: claim !== null &&
											claim.getTime() < clause.contentClaimedAt.lt.getTime(),
								);
							return applyWindow(
								store.rows.filter(
									(row) =>
										row.status === "ARMED" &&
										row.action === "SLATE_IN" &&
										row.insertableContentId === null &&
										claimMatches(row.contentClaimedAt) &&
										row.slateSource !== null,
								),
								args,
							).map((row) => ({ ...row }));
						}
						const fireAt = args.where.fireAt;
						if (store.latch) {
							const { latch } = store;
							await new Promise<void>((resolve) => {
								latch.waiters.push(resolve);
								if (latch.waiters.length >= latch.expected) {
									for (const release of latch.waiters) {
										release();
									}
								}
							});
						}
						// The due scan always sends `lte` (`fireAt: { lte: now }`);
						// the optionality above exists for the two stage scans.
						const due = fireAt.lte;
						return applyWindow(
							store.rows.filter(
								(row) =>
									row.status === "ARMED" &&
									due !== undefined &&
									row.fireAt.getTime() <= due.getTime(),
							),
							args,
						).map((row) => ({ ...row }));
					},
				),
				updateMany: vi.fn(
					async (args: {
						where: {
							id?: string;
							liveChannelId?: string;
							action?: string;
							status?: string | { in: string[] };
							contentClaimedAt?: null | Date;
							insertableContentId?: null;
							deadlineNotifiedAt?: null;
							dispatchedAt?: null;
							liveChannelRunId?: string | null;
							stagedAt?: null;
							stageDispatchedAt?: null;
							outcome?: { in: string[] };
						};
						data: Partial<Row>;
					}) => {
						guardEscape("liveSchedule.updateMany");
						let count = 0;
						for (const row of store.rows) {
							if (args.where.id !== undefined && row.id !== args.where.id) {
								continue;
							}
							if (
								(args.where.liveChannelId !== undefined &&
									row.liveChannelId !== args.where.liveChannelId) ||
								(args.where.action !== undefined &&
									row.action !== args.where.action)
							)
								continue;
							if (
								typeof args.where.status === "string" &&
								row.status !== args.where.status
							) {
								continue;
							}
							if (
								args.where.status &&
								typeof args.where.status === "object" &&
								!args.where.status.in.includes(row.status)
							) {
								continue;
							}
							// Two-phase CAS terms (row 240): the stage claim and its
							// handoff stamp are each written once. A fake that ignored
							// them would let two ticks stage one row twice.
							if (
								"stagedAt" in args.where &&
								row.stagedAt !== args.where.stagedAt
							) {
								continue;
							}
							if (
								"stageDispatchedAt" in args.where &&
								row.stageDispatchedAt !== args.where.stageDispatchedAt
							) {
								continue;
							}
							// The outcome writer's precedence (row 238), as it spells
							// it: the row's current outcome must be in the set the
							// write may replace (an absent outcome is PENDING).
							if (
								args.where.outcome &&
								!args.where.outcome.in.includes(row.outcome ?? "PENDING")
							) {
								continue;
							}
							//  CAS: the handoff is stamped ONCE. A fake
							// that ignored this would let a second dispatch overwrite
							// a truthful stamp and hide a double-stamp bug.
							if (
								"dispatchedAt" in args.where &&
								row.dispatchedAt !== args.where.dispatchedAt
							) {
								continue;
							}
							// #94 CAS filters — a mock that ignored them would
							// make double-claims invisible (the QC-mock lesson).
							// The claim CAS carries the READ value (null or the
							// stale Date, review-223 F1) — instants, not identity.
							if ("contentClaimedAt" in args.where) {
								const want = args.where.contentClaimedAt as Date | null;
								const have = row.contentClaimedAt;
								const same =
									want === null || have === null
										? want === have
										: want.getTime() === have.getTime();
								if (!same) {
									continue;
								}
							}
							if (
								"insertableContentId" in args.where &&
								row.insertableContentId !== args.where.insertableContentId
							) {
								continue;
							}
							// #160 PR2 CAS: the deadline stamp claims only unstamped rows.
							if (
								"deadlineNotifiedAt" in args.where &&
								row.deadlineNotifiedAt !== args.where.deadlineNotifiedAt
							) {
								continue;
							}
							//  CAS: the lazy generation bind stamps a row
							// exactly once. A fake that ignored this filter would
							// let a second tick overwrite an existing bind — the
							// one thing the CAS exists to prevent.
							if (
								"liveChannelRunId" in args.where &&
								row.liveChannelRunId !== args.where.liveChannelRunId
							) {
								continue;
							}
							Object.assign(row, args.data);
							count += 1;
						}
						return { count };
					},
				),
				findFirst: vi.fn(
					async (args: {
						where: { liveChannelId: string; note: string; fireAt: Date };
					}) => {
						const hit = store.rows.find(
							(row) =>
								row.liveChannelId === args.where.liveChannelId &&
								row.note === args.where.note &&
								row.fireAt.getTime() === args.where.fireAt.getTime(),
						);
						return hit ? { id: hit.id } : null;
					},
				),
				create: vi.fn(async (args: { data: Partial<Row> }) => {
					// The partial unique index: one cap row per (channel, fireAt).
					if (
						args.data.note === "max-run-cap" &&
						store.rows.some(
							(row) =>
								row.liveChannelId === args.data.liveChannelId &&
								row.note === "max-run-cap" &&
								row.fireAt?.getTime() === (args.data.fireAt as Date).getTime(),
						)
					) {
						const err = new Error("unique") as Error & { code: string };
						err.code = "P2002";
						throw err;
					}
					nextId += 1;
					const row: Row = {
						...makeRow(),
						...args.data,
						id: `33333333-3333-4333-8333-33333333333${nextId}`,
					};
					store.rows.push(row);
					return { ...row };
				}),
			},
			//  PR2: the sweep mirrors channel transitions onto the
			// current run — a stateful single-slot stub, same shape as the
			// live-processor harness's.
			liveChannelRun: {
				updateMany: vi.fn(
					async (args: {
						where: { id: string; status: string; endedAt: null };
						data: { endedAt: Date };
					}) => {
						guardEscape("liveChannelRun.updateMany");
						const run = store.runs.find(
							(r) =>
								r.id === args.where.id &&
								r.status === args.where.status &&
								r.endedAt == null,
						);
						if (!run) return { count: 0 };
						run.endedAt = args.data.endedAt;
						return { count: 1 };
					},
				),
				// #160 PR1 reconciler scan (stuck PROVISIONING). The run store here
				// carries no createdAt, so the default answer is "none stuck";
				// reconciler behaviour is unit-tested in startup-sample.test.ts.
				findMany: vi.fn(async () => []),
				findFirst: vi.fn(
					async (args?: { where?: { liveChannelId?: string } }) =>
						[...store.runs]
							.reverse()
							.find(
								(run) =>
									run.liveChannelId === undefined ||
									run.liveChannelId === args?.where?.liveChannelId,
							) ?? null,
				),
				create: vi.fn(async (args: { data: Record<string, unknown> }) => {
					guardEscape("liveChannelRun.create");
					const created = {
						// #155: the sweep pre-mints the id (it is baked into the
						// compiled log's paths) — a fake that re-minted here
						// would hide an id/prefix mismatch.
						id: (args.data.id as string) ?? `run-${store.runs.length + 1}`,
						seq: (args.data.seq as number) ?? store.runs.length + 1,
						status: (args.data.status as string) ?? "CREATED",
						outputPrefix: (args.data.outputPrefix as string) ?? "",
					};
					store.runs.push(created);
					return { id: created.id };
				}),
				update: vi.fn(
					async (args: {
						where: { id: string };
						data: Record<string, unknown>;
					}) => {
						guardEscape("liveChannelRun.update");
						const row = store.runs.find((r) => r.id === args.where.id);
						if (row) {
							if (typeof args.data.status === "string") {
								row.status = args.data.status;
							}
							if (typeof args.data.outputPrefix === "string") {
								row.outputPrefix = args.data.outputPrefix;
							}
							// The revival's clears land as NULLS, not as absent keys —
							// a fake that ignored them would let the revive arm drop
							// any of the clears without a red test. The Json column's
							// clear is Prisma's DbNull sentinel; the store records it
							// as the SQL NULL a reader would get back.
							for (const key of ["endedAt", "heartbeatSummaryAt"] as const) {
								if (key in args.data) {
									row[key] = args.data[key] as Date | null;
								}
							}
							// rev431 R3: the revive's stamp clear is a NULL too
							if ("encoderStoppedConfirmedFor" in args.data) {
								row.encoderStoppedConfirmedFor = args.data
									.encoderStoppedConfirmedFor as string | null;
							}
							if ("heartbeatSummary" in args.data) {
								row.heartbeatSummary =
									args.data.heartbeatSummary === DB_NULL
										? null
										: args.data.heartbeatSummary;
							}
						}
						return {};
					},
				),
			},
			//  PR1: runOnce ends with a best-effort startup-sample
			// reconcile. Default: no stuck runs (the reconciler's own behaviour
			// is unit-tested in startup-sample.test.ts; here we pin only the
			// seam — it runs, and its failure cannot break the tick).
			startupSample: {
				findUnique: vi.fn(async () => null),
				create: vi.fn(async () => ({})),
			},
			liveChannel: {
				// Projects the SELECT (review-223): a mock returning every
				// column hides a select that stopped carrying what its caller
				// reads — the named-slot-not-filled failure mode.
				findUnique: vi.fn(
					async (args: {
						where: { id: string };
						select?: Record<string, unknown>;
					}) => {
						const hit = store.channels.find(
							(channel) => channel.id === args.where.id,
						);
						if (!hit) {
							return null;
						}
						//  PR2b: the run-first readers select a runs
						// include — served from the harness's run store (latest
						// only, as the take:1 orderBy seq desc asks). A channel
						// with no run rows answers [], which is the REAL shape
						// for a never-run channel.
						const latestRun = [...store.runs]
							.reverse()
							.find(
								(run) =>
									run.liveChannelId === undefined ||
									run.liveChannelId === hit.id,
							);
						const withRuns = {
							...hit,
							runs: latestRun ? [latestRun] : [],
						};
						return args.select
							? projectSelected(withRuns, args.select)
							: withRuns;
					},
				),
				findMany: vi.fn(async () =>
					store.channels
						.filter(
							(channel) =>
								channel.status === "RUNNING" &&
								channel.maxRunMinutes !== null &&
								channel.runningSince !== null,
						)
						.map((channel) => ({
							id: channel.id,
							maxRunMinutes: channel.maxRunMinutes,
							runningSince: channel.runningSince,
							liveEffectFenceVersion: channel.liveEffectFenceVersion,
						})),
				),
				updateMany: vi.fn(
					async (args: {
						where: {
							id: string;
							status?: string | { in: string[] };
							error?: null;
							liveEffectFenceVersion?: number;
						};
						data: Partial<Channel>;
					}) => {
						guardEscape("liveChannel.updateMany");
						let count = 0;
						for (const channel of store.channels) {
							if (channel.id !== args.where.id) {
								continue;
							}
							if (
								args.where.liveEffectFenceVersion !== undefined &&
								channel.liveEffectFenceVersion !==
									args.where.liveEffectFenceVersion
							) {
								continue;
							}
							// A mock that ignored the `error` term would make the
							// re-air-over-an-unconfirmed-stop refusal invisible —
							// the same shape as the CAS filters above.
							if (
								args.where.error === null &&
								channel.error !== null &&
								channel.error !== undefined
							) {
								continue;
							}
							const want = args.where.status;
							if (typeof want === "string" && channel.status !== want) {
								continue;
							}
							if (
								want &&
								typeof want === "object" &&
								!want.in.includes(channel.status)
							) {
								continue;
							}
							for (const [key, value] of Object.entries(args.data)) {
								if (
									value !== null &&
									typeof value === "object" &&
									"increment" in (value as Record<string, unknown>)
								) {
									(channel as unknown as Record<string, unknown>)[key] =
										(((channel as unknown as Record<string, unknown>)[
											key
										] as number) ?? 0) +
										((value as { increment: number }).increment ?? 0);
								} else {
									(channel as unknown as Record<string, unknown>)[key] = value;
								}
							}
							count += 1;
						}
						return { count };
					},
				),
			},
		},
	};
	const needsCurrentRun =
		store.channels.some(
			(channel) =>
				channel.status === "RUNNING" && channel.maxRunMinutes !== null,
		) || store.rows.some((row) => row.action !== "START");
	if (needsCurrentRun && store.runs.length === 0) {
		for (const [index, running] of store.channels
			.filter((channel) => channel.status === "RUNNING")
			.entries()) {
			running.bitmovinEncodingId ??= "enc-current";
			const runId = `cccccccc-3333-4333-8333-${String(index + 1).padStart(12, "0")}`;
			store.runs.push({
				id: runId,
				liveChannelId: running.id,
				seq: 1,
				status: "RUNNING",
				providerStatus: "RUNNING",
				providerStatusObservedAt: new Date(2_000_000),
				lastHeartbeat: running.lastHeartbeat,
			});
			for (const row of store.rows) {
				if (
					row.liveChannelId === running.id &&
					row.status === "FIRED" &&
					row.action !== "START" &&
					row.liveChannelRunId === null
				) {
					row.liveChannelRunId = runId;
				}
			}
		}
	}
	return store;
}

function makeSweep(
	store: ReturnType<typeof makeStore>,
	over: {
		allowNewWork?: () => Promise<boolean>;
		now?: () => Date;
		enqueue?: (job: unknown, dedupeId: string) => Promise<void>;
		emitEvent?: (event: { kind: string }) => Promise<void>;
	} = {},
) {
	const enqueue = vi.fn(over.enqueue ?? (async () => {}));
	const emitEvent = vi.fn(
		over.emitEvent ?? (async (_event: { kind: string }) => {}),
	);
	const sweep = createScheduleSweep({
		prisma: store.prisma as unknown as AppPrismaClient,
		allowNewWork: over.allowNewWork,
		enqueue,
		emitEvent,
		now: over.now ?? (() => new Date(2_000_000)),
		startGraceMinutes: 10,
	});
	return { sweep, enqueue, emitEvent };
}

describe("START — dispatched by CHANNEL state (review-190 C1)", () => {
	it.each([
		"CREATED",
		"STOPPED",
		"ERROR",
	] as const)("%s START binds its initially null run before dispatch and cancellation updates only that stored row", async (status) => {
		const store = makeStore([makeRow()], [makeChannel({ status })]);
		if (status === "ERROR")
			store.runs.push({ id: "prior-error-run", seq: 1, status: "ERROR" });
		const { sweep, enqueue } = makeSweep(store, {
			enqueue: async () => {
				expect(store.rows[0]?.liveChannelRunId).toBe(store.runs.at(-1)?.id);
			},
		});
		expect(store.rows[0]?.liveChannelRunId).toBeNull();
		await sweep();
		expect(enqueue).toHaveBeenCalledOnce();
		const run = store.runs.at(-1);
		if (!run) throw new Error("expected a claimed run");
		expect(store.rows[0]?.liveChannelRunId).toBe(run.id);
		store.rows.push(
			makeRow({
				id: "old-start",
				status: "FIRED",
				liveChannelRunId: "old-run",
				outcome: "DELIVERED",
			}),
		);
		await expect(
			recordScheduleOutcome(
				store.prisma as unknown as AppPrismaClient,
				{
					canceledChannelStart: { liveChannelId: CH, liveChannelRunId: run.id },
				},
				"FAILED",
				"startup canceled",
				new Date(2_000_000),
				"EFFECT_FAILED",
			),
		).resolves.toBe(1);
		expect(store.rows[0]?.outcome).toBe("FAILED");
		expect(store.rows[1]?.outcome).toBe("DELIVERED");
	});

	it.each([
		"CREATED",
		"STOPPED",
		"ERROR",
	] as const)("%s START binding failure rolls back the channel/run claim and never enqueues", async (status) => {
		const store = makeStore([makeRow()], [makeChannel({ status })]);
		if (status === "ERROR")
			store.runs.push({ id: "prior-error-run", seq: 1, status: "ERROR" });
		const original =
			store.prisma.liveSchedule.updateMany.getMockImplementation();
		if (!original) throw new Error("fixture update missing");
		store.prisma.liveSchedule.updateMany.mockImplementation(async (args) => {
			if (typeof args.data.liveChannelRunId === "string") return { count: 0 };
			return original(args);
		});
		const runsBefore = structuredClone(store.runs);
		const { sweep, enqueue } = makeSweep(store);
		await sweep();
		expect(store.channels[0]?.status).toBe(status);
		expect(store.rows[0]?.status).toBe("ARMED");
		expect(store.rows[0]?.liveChannelRunId).toBeNull();
		expect(store.runs).toEqual(runsBefore);
		expect(enqueue).not.toHaveBeenCalled();
	});

	it("CREATED fires provision under the route's PROVISIONING claim", async () => {
		const store = makeStore([makeRow()], [makeChannel()]);
		const { sweep, enqueue, emitEvent } = makeSweep(store);
		const stats = await sweep();
		expect(stats.fired).toBe(1);
		// rev431: every PROVISIONING claim voids the stop/CREATED confirmation
		expect(store.channels[0]).toMatchObject({
			status: "PROVISIONING",
			encoderStoppedConfirmedFor: null,
		});
		expect(store.rows[0]).toMatchObject({ status: "FIRED" });
		expect(enqueue).toHaveBeenCalledWith(
			{ liveChannelId: CH, action: "provision" },
			`sched-${ROW_ID}`,
		);
		expect(emitEvent).toHaveBeenCalledWith(
			expect.objectContaining({ kind: "SCHEDULE_FIRED" }),
		);
	});

	it.each([
		"STOPPED",
		"ERROR",
	])("refuses %s re-air with the specific MSL5 floor issue before claiming or enqueueing", async (status) => {
		const plan = sweepPlan();
		plan.bitmovin = { ...(plan.bitmovin as object), encoderVersion: "2.281.0" };
		plan.outputs = [
			{
				key: "origin",
				kind: "AKAMAI_MSL",
				credentialId: "4c885bd1-33ef-47b0-9506-3b765f91f324",
				streamFormat: "CMAF",
				mslVersion: "MSL5",
			},
		];
		const store = makeStore(
			[makeRow()],
			[makeChannel({ status, plan, error: null })],
		);
		store.runs.push({ id: "run-old", seq: 1, status: "STOPPED" });
		const channelsBefore = structuredClone(store.channels);
		const runsBefore = structuredClone(store.runs);
		const { sweep, enqueue, emitEvent } = makeSweep(store);
		const stats = await sweep();
		expect(stats.errors).toBe(1);
		expect(store.rows[0]).toMatchObject({
			status: "ERROR",
			error: expect.stringContaining("2.283.0"),
		});
		expect(store.channels).toEqual(channelsBefore);
		expect(store.runs).toEqual(runsBefore);
		expect(enqueue).not.toHaveBeenCalled();
		expect(emitEvent).toHaveBeenCalledWith(
			expect.objectContaining({ kind: "SCHEDULE_MISSED" }),
		);
	});

	it("does NOT re-air a stop that never confirmed — unattended is the dangerous half (ledger #130 C-fold)", async () => {
		// The channel says STOPPED and carries the evidence that Bitmovin never
		// confirmed it. Re-airing would clear that error, the encoder pointer
		// and the step log in one write — deleting the warning AND the only
		// in-app way to retry the stop — and then start a SECOND encoding while
		// the first may still be billing. Off an armed START row, with nobody
		// watching.
		const store = makeStore(
			[makeRow()],
			[
				makeChannel({
					status: "STOPPED",
					bitmovinEncodingId: "enc-1",
					error: "stop did not confirm — enc-1: still RUNNING",
				}),
			],
		);
		store.runs.push({ id: "run-1", seq: 1, status: "STOPPED" });
		const { sweep } = makeSweep(store);
		await sweep();
		// Untouched: still STOPPED, still naming its encoder, still carrying
		// the evidence the reset and the channel page both read.
		expect(store.channels[0]).toMatchObject({
			status: "STOPPED",
			bitmovinEncodingId: "enc-1",
		});
		expect(store.channels[0]?.error).toMatch(/did not confirm/);
	});

	it("both scheduler arms RELEASE the provisioning lease when they claim (ledger #182)", async () => {
		/**
		 * The unattended half of the lease, pinned per ARM.
		 *
		 * The lease's first cut released it only in the web start action. These
		 * two arms claimed a channel into PROVISIONING and left the previous
		 * run's lease standing, so the provision job they enqueue refused it and
		 * returned SUCCESSFULLY — the channel sits in PROVISIONING with no retry
		 * and no alarm, which for an unattended scheduler is a silently missed
		 * airing.
		 *
		 * Asserted on the CHANNEL after the sweep rather than on the payload
		 * text: a file-level text guard was the first attempt and review showed
		 * it passing while one of these two arms had its release deleted.
		 */
		const stale = new Date("2026-06-12T11:00:00.000Z");
		for (const startStatus of ["STOPPED", "ERROR"] as const) {
			const store = makeStore(
				[makeRow()],
				[
					makeChannel({
						status: startStatus,
						bitmovinEncodingId: "enc-1",
						provisionClaimedAt: stale,
					} as Parameters<typeof makeChannel>[0]),
				],
			);
			const { sweep } = makeSweep(store);
			await sweep();
			const channel = store.channels[0];
			expect(channel?.status, `${startStatus} arm did not claim`).toBe(
				"PROVISIONING",
			);
			expect(
				(channel as { provisionClaimedAt?: unknown })?.provisionClaimedAt ??
					null,
				`the ${startStatus} arm claimed the channel but left the previous run's lease standing — the provision job it enqueues will refuse it and the airing is silently missed`,
			).toBeNull();
		}
	});

	it("STOPPED starts a NEW RUN via provision — #110 CLOSED (this test used to PIN the defect)", async () => {
		// History, kept on purpose: this test's previous body asserted the
		// restart-enqueue — "STOPPED fires RESTART … enqueue provision.
		// Never." — pinning the unattended 409 #110 recorded. The run model
		// makes the honest behaviour possible: a scheduled START on a STOPPED
		// channel frees the per-run columns, creates run seq+1, and enqueues
		// PROVISION for a fresh encoding. C30 stands: the finished encoding
		// is never touched.
		const store = makeStore(
			[makeRow()],
			[
				makeChannel({
					status: "STOPPED",
					bitmovinEncodingId: "enc-1",
					// The previous airing's afterglow — K1's fixture: this
					// MUST be cleaned by the scheduled re-air. (liveToVod is
					// outside the harness Channel type; its DB_NULL side is
					// covered by the claim-data shape below.)
					lastHeartbeat: HB_CONNECTED,
				}),
			],
		);
		store.runs.push({ id: "run-1", seq: 1, status: "STOPPED" });
		const { sweep, enqueue } = makeSweep(store);
		const stats = await sweep();
		expect(stats.fired).toBe(1);
		expect(store.channels[0]).toMatchObject({
			status: "PROVISIONING",
			bitmovinEncodingId: null,
		});
		/*
		 * The COMPILED fresh log, not [] (#155). This assertion used to read
		 * `stepLog: []` — pinning the same defect the route's first cut had:
		 * provision EXECUTES the row's log and never compiles, so a scheduled
		 * re-air provisioned zero steps and stranded the channel at ERROR.
		 * And the log is REBASED into the new run's own subtree: the plan's
		 * segment path must be GONE (its presence is the
		 * overwrite-the-previous-airing defect §4 names).
		 */
		const claimedLog = store.channels[0]?.stepLog as {
			kind: string;
			status: string;
		}[];
		expect(claimedLog.length).toBeGreaterThan(0);
		expect(claimedLog.map((e) => e.kind)).toContain("CREATE_ENCODING");
		for (const entry of claimedLog) {
			expect(entry.status).toBe("PENDING");
		}
		const newRun = store.runs[1] as {
			id: string;
			outputPrefix?: string;
		};
		expect(newRun.outputPrefix).toBe(
			`live-sweep/runs/2-${newRun.id.replace(/-/g, "").slice(0, 8)}`,
		);
		const wire = JSON.stringify(claimedLog);
		expect(wire).toContain(`${newRun.outputPrefix}/video/720p`);
		expect(wire).not.toContain('"live-sweep/video/720p"');
		// review-244 K1: the UNATTENDED re-air must clean the display columns
		// too — the manual path always did; without this the detail page
		// showed the previous airing's sample as ingest-connected while the
		// new run was provisioning (value-level display is only sound if
		// re-air cleans the column).
		expect(store.channels[0]?.lastHeartbeat).not.toEqual(HB_CONNECTED);
		// A NEW run row (the previous is terminal), not a resurrection.
		expect(store.runs.length).toBe(2);
		expect(store.runs[1]).toMatchObject({ seq: 2 });
		expect(enqueue).toHaveBeenCalledWith(
			{ liveChannelId: CH, action: "provision" },
			`sched-${ROW_ID}`,
		);
		// The restart the vendor cannot do is NEVER enqueued — the inverted
		// direction of the old pin.
		expect(enqueue).not.toHaveBeenCalledWith(
			expect.objectContaining({ action: "restart" }),
			expect.anything(),
		);
	});

	it("ERROR with an EMPTY log REVIVES the corpse run with a recompiled, rebased log (#155)", async () => {
		// The exact shape the old re-air bug left: channel ERROR, latest run
		// ERROR, stepLog []. Reseeding [] would walk zero steps and die at
		// finalize forever; the route grew this recovery on 2026-08-21 and
		// the sweep must match — a scheduled START is the unattended path.
		const store = makeStore(
			[makeRow()],
			[makeChannel({ status: "ERROR", stepLog: [] })],
		);
		store.runs.push({ id: "run-2corpse", seq: 2, status: "ERROR" });
		const { sweep, enqueue } = makeSweep(store);
		const stats = await sweep();
		expect(stats.fired).toBe(1);
		const claimedLog = store.channels[0]?.stepLog as { kind: string }[];
		expect(claimedLog.length).toBeGreaterThan(0);
		expect(claimedLog.map((e) => e.kind)).toContain("CREATE_ENCODING");
		// Recompiled for the REVIVED run's own coordinates (id8 "run2corp")
		// — same row, same seq, prefix stamped by the revival.
		expect(JSON.stringify(claimedLog)).toContain(
			"live-sweep/runs/2-run2corp/video/720p",
		);
		expect(store.runs).toHaveLength(1);
		expect(store.runs[0]).toMatchObject({
			id: "run-2corpse",
			status: "PROVISIONING",
			outputPrefix: "live-sweep/runs/2-run2corp",
		});
		expect(enqueue).toHaveBeenCalledWith(
			{ liveChannelId: CH, action: "provision" },
			`sched-${ROW_ID}`,
		);
	});

	it("ERROR beside a LIVE run RESUMES it — the stranded-enqueue world heals unattended (review-284 m6)", async () => {
		// The route's enqueue-failure path marks the channel ERROR while its
		// committed run row stays PROVISIONING. The pre-#155 sweep healed
		// this (ensure joins the live run, provision re-enqueued); the first
		// cut of the live-run guard regressed it into wait-until-MISSED.
		const store = makeStore(
			[makeRow()],
			[
				makeChannel({
					status: "ERROR",
					stepLog: [
						{
							step: "encoding",
							kind: "CREATE_ENCODING",
							payload: {},
							refs: {},
							status: "FAILED",
							error: "Enqueue failed — start again",
						},
					],
				}),
			],
		);
		store.runs.push({ id: "run-1", seq: 1, status: "PROVISIONING" });
		const { sweep, enqueue } = makeSweep(store);
		const stats = await sweep();
		expect(stats.fired).toBe(1);
		expect(stats.waiting).toBe(0);
		// The SAME live row joined — no twin, no revive-update needed.
		expect(store.runs).toHaveLength(1);
		expect(enqueue).toHaveBeenCalledWith(
			{ liveChannelId: CH, action: "provision" },
			`sched-${ROW_ID}`,
		);

		// The CREATED × live-run cell stays a WAIT — a mid-write world.
		const store2 = makeStore([makeRow()], [makeChannel({ status: "CREATED" })]);
		store2.runs.push({ id: "run-1", seq: 1, status: "PROVISIONING" });
		const second = makeSweep(store2);
		const stats2 = await second.sweep();
		expect(stats2.waiting).toBe(1);
		expect(stats2.fired).toBe(0);
		expect(second.enqueue).not.toHaveBeenCalled();
	});

	it("ERROR beside a STOPPED run RE-AIRS — fresh compiled log, fresh subtree, never a resume of an ended airing (review-284 M1/M3)", async () => {
		// The latest airing ENDED (run STOPPED): resuming the channel's log
		// would restart a FINISHED encoding (C30), and the old drift cell —
		// ensure minting a "" row while the log walks other paths — is dead:
		// the fresh row carries the prefix its log writes under. Both the
		// empty-log corpse AND a stale resumable log land here.
		for (const stepLog of [
			[],
			[
				{
					step: "encoding",
					kind: "CREATE_ENCODING",
					payload: {},
					refs: {},
					status: "FAILED",
					error: "boom",
				},
			],
		]) {
			const store = makeStore(
				[makeRow()],
				[
					makeChannel({
						status: "ERROR",
						stepLog,
						bitmovinEncodingId: "enc-old",
						lastHeartbeat: HB_CONNECTED,
					}),
				],
			);
			store.runs.push({ id: "run-1", seq: 1, status: "STOPPED" });
			const { sweep, enqueue } = makeSweep(store);
			const stats = await sweep();
			expect(stats.fired).toBe(1);
			const claimedLog = store.channels[0]?.stepLog as { kind: string }[];
			expect(claimedLog.map((e) => e.kind)).toContain("CREATE_ENCODING");
			const newRun = store.runs[1] as { id: string; outputPrefix?: string };
			expect(newRun.outputPrefix).toBe(
				`live-sweep/runs/2-${newRun.id.replace(/-/g, "").slice(0, 8)}`,
			);
			expect(JSON.stringify(claimedLog)).toContain(
				`${newRun.outputPrefix}/video/720p`,
			);
			// Route parity: the per-run channel columns are freed (K1).
			expect(store.channels[0]).toMatchObject({
				status: "PROVISIONING",
				bitmovinEncodingId: null,
			});
			expect(enqueue).toHaveBeenCalledWith(
				{ liveChannelId: CH, action: "provision" },
				`sched-${ROW_ID}`,
			);
		}
	});

	it("ERROR beside a provider-terminal run RE-AIRS instead of reviving the ended encoding", async () => {
		const store = makeStore(
			[makeRow()],
			[
				makeChannel({
					status: "ERROR",
					stepLog: [
						{
							step: "encoding",
							kind: "CREATE_ENCODING",
							payload: {},
							refs: {},
							status: "DONE",
							resourceId: "enc-ended",
						},
					],
					bitmovinEncodingId: "enc-ended",
					lastHeartbeat: HB_CONNECTED,
				}),
			],
		);
		store.runs.push({
			id: "run-ended",
			seq: 1,
			status: "ERROR",
			providerStatus: "FINISHED",
			providerStatusObservedAt: new Date(1_900_000),
			providerTerminalAt: new Date(1_900_000),
		});

		const { sweep, enqueue } = makeSweep(store);
		const stats = await sweep();

		expect(stats.fired).toBe(1);
		expect(store.runs).toHaveLength(2);
		expect(store.runs[0]).toMatchObject({
			id: "run-ended",
			status: "ERROR",
			providerStatus: "FINISHED",
		});
		expect(store.runs[1]).toMatchObject({
			seq: 2,
			status: "PROVISIONING",
		});
		expect(store.runs[1]?.id).not.toBe("run-ended");
		expect(store.channels[0]).toMatchObject({
			status: "PROVISIONING",
			bitmovinEncodingId: null,
		});
		expect(JSON.stringify(store.channels[0]?.stepLog)).not.toContain(
			"enc-ended",
		);
		expect(enqueue).toHaveBeenCalledWith(
			{ liveChannelId: CH, action: "provision" },
			`sched-${ROW_ID}`,
		);
	});

	it("ERROR corpse with NO runs at all compiles seq 1 at the plan's paths — heals, never strands (review-284 M1)", async () => {
		const store = makeStore(
			[makeRow()],
			[makeChannel({ status: "ERROR", stepLog: [] })],
		);
		const { sweep, enqueue } = makeSweep(store);
		const stats = await sweep();
		expect(stats.fired).toBe(1);
		const claimedLog = store.channels[0]?.stepLog as { kind: string }[];
		expect(claimedLog.map((e) => e.kind)).toContain("CREATE_ENCODING");
		// Seq 1 writes at the plan's own paths (prefix "") — the seq rule.
		expect(store.runs).toHaveLength(1);
		expect(store.runs[0]).toMatchObject({
			seq: 1,
			status: "PROVISIONING",
			outputPrefix: "",
		});
		expect(JSON.stringify(claimedLog)).toContain('"live-sweep/video/720p"');
		expect(enqueue).toHaveBeenCalled();
	});

	it("ERROR beside a LIVE run with an EMPTY log WAITS — a torn mid-write world, never a zero-step join (review-284 M1)", async () => {
		const store = makeStore(
			[makeRow()],
			[makeChannel({ status: "ERROR", stepLog: [] })],
		);
		store.runs.push({ id: "run-1", seq: 1, status: "PROVISIONING" });
		const { sweep, enqueue } = makeSweep(store);
		const stats = await sweep();
		expect(stats.waiting).toBe(1);
		expect(stats.fired).toBe(0);
		expect(enqueue).not.toHaveBeenCalled();
	});

	it("a failed run-row write ROLLS the claim back whole — no orphan log, no mislabel, row re-armed (review-284 M2→N2)", async () => {
		// The class-deleting form: claim + run write commit together, so a
		// failed create (P2002 race or a plain DB blip — the causes the old
		// bare catch conflated) leaves the channel EXACTLY as it was: still
		// STOPPED, its step log untouched, no error stamped, nothing to
		// mislabel. The row re-arms and the next tick re-decides.
		for (const failure of [
			Object.assign(new Error("unique"), { code: "P2002" }),
			new Error("connection reset"),
		]) {
			const store = makeStore(
				[makeRow()],
				[
					makeChannel({
						status: "STOPPED",
						bitmovinEncodingId: "enc-1",
						stepLog: [],
					}),
				],
			);
			store.runs.push({ id: "run-1", seq: 1, status: "STOPPED" });
			store.prisma.liveChannelRun.create.mockRejectedValueOnce(failure);
			const { sweep, enqueue } = makeSweep(store);
			const stats = await sweep();
			expect(stats.errors).toBe(1);
			// The CLAIM ROLLED BACK: channel untouched in every column the
			// claim would have written.
			expect(store.channels[0]).toMatchObject({
				status: "STOPPED",
				error: null,
				bitmovinEncodingId: "enc-1",
				stepLog: [],
			});
			// No orphan run row either, and the row is re-armed, not
			// FIRED-and-forgotten.
			expect(store.runs).toHaveLength(1);
			expect(store.rows[0]?.status).toBe("ARMED");
			expect(enqueue).not.toHaveBeenCalled();
		}
	});

	it("ERROR resume REVIVES the latest ERROR run — never a seq+1 twin for the same airing", async () => {
		// Pre-#155 the sweep's resume went through the lazy ensure, which
		// treats a terminal latest as "create seq+1": one airing's history
		// split across two rows while the route revived. Route parity now.
		const store = makeStore(
			[makeRow()],
			[
				makeChannel({
					status: "ERROR",
					stepLog: [
						{
							step: "encoding",
							kind: "CREATE_ENCODING",
							payload: {},
							refs: {},
							status: "FAILED",
							error: "boom",
						},
					],
				}),
			],
		);
		store.runs.push({
			id: "run-1",
			seq: 1,
			status: "ERROR",
			// The ended airing was already summarized; the revival must clear
			// BOTH summary columns WITH endedAt — the lock so the resumed airing
			// is re-summarized over all its rows when it really ends, the JSON so
			// the RUNNING revived run does not serve the aborted airing's figures
			// (rev405 R4).
			endedAt: new Date("2026-08-13T09:00:00Z"),
			heartbeatSummary: { version: 1, sampleCount: 12 },
			heartbeatSummaryAt: new Date("2026-08-13T09:00:30Z"),
			// rev431 R3: the reconcile confirmed this CREATED encoding; the
			// revive restarts it under the same id, so the stamp must go
			bitmovinEncodingId: "enc-created",
			encoderStoppedConfirmedFor: "enc-created",
		} as (typeof store.runs)[number]);
		const { sweep } = makeSweep(store);
		const stats = await sweep();
		expect(stats.fired).toBe(1);
		// The SAME row, revived — and its prefix untouched: a plain resume's
		// paths are already baked into the log being reseeded.
		expect(store.runs).toHaveLength(1);
		expect(store.runs[0]).toMatchObject({
			id: "run-1",
			seq: 1,
			status: "PROVISIONING",
			endedAt: null,
			heartbeatSummary: null,
			heartbeatSummaryAt: null,
			// rev431 R3: same pointer, confirmation gone
			bitmovinEncodingId: "enc-created",
			encoderStoppedConfirmedFor: null,
		});
		expect(store.runs[0]?.outputPrefix).toBeUndefined();
	});

	it("RUNNING completes the row WITH a note and enqueues NOTHING (design §3.1)", async () => {
		const store = makeStore([makeRow()], [makeChannel({ status: "RUNNING" })]);
		const { sweep, enqueue, emitEvent } = makeSweep(store);
		const stats = await sweep();
		expect(stats).toMatchObject({ fired: 0, completed: 1 });
		expect(store.rows[0]).toMatchObject({ status: "COMPLETED" });
		expect(store.rows[0]?.note).toMatch(/already RUNNING/);
		expect(enqueue).not.toHaveBeenCalled();
		expect(emitEvent).not.toHaveBeenCalled();
	});

	it("PROVISIONING waits — an in-flight provision can still FAIL (review-190 re-verify N1)", async () => {
		// A row COMPLETED here could never retry inside its grace if the
		// provision then landed ERROR; only RUNNING proves the start.
		const store = makeStore(
			[makeRow()],
			[makeChannel({ status: "PROVISIONING" })],
		);
		const { sweep, enqueue } = makeSweep(store);
		const stats = await sweep();
		expect(stats.waiting).toBe(1);
		expect(store.rows[0]).toMatchObject({ status: "ARMED" });
		expect(enqueue).not.toHaveBeenCalled();
	});

	it("ERROR re-seeds FAILED/RUNNING steps to PENDING inside the claim (route resume pattern)", async () => {
		const store = makeStore(
			[makeRow()],
			[
				makeChannel({
					status: "ERROR",
					stepLog: [
						{
							step: "a",
							kind: "CREATE_INPUT_S3",
							payload: {},
							refs: {},
							status: "DONE",
							resourceId: "keep",
						},
						{
							step: "b",
							kind: "CREATE_ENCODING",
							payload: {},
							refs: {},
							status: "FAILED",
							error: "boom",
						},
					],
				}),
			],
		);
		const { sweep, enqueue } = makeSweep(store);
		await sweep();
		expect(store.channels[0]).toMatchObject({ status: "PROVISIONING" });
		const reseeded = store.channels[0]?.stepLog as {
			status: string;
			resourceId?: string;
			error?: string;
		}[];
		expect(reseeded[0]).toMatchObject({ status: "DONE", resourceId: "keep" });
		expect(reseeded[1]?.status).toBe("PENDING");
		expect(reseeded[1]?.error).toBeUndefined();
		expect(enqueue).toHaveBeenCalledWith(
			{ liveChannelId: CH, action: "provision" },
			`sched-${ROW_ID}`,
		);
	});

	it("STOPPING waits — the row stays ARMED for the next tick", async () => {
		const store = makeStore([makeRow()], [makeChannel({ status: "STOPPING" })]);
		const { sweep, enqueue } = makeSweep(store);
		const stats = await sweep();
		expect(stats.waiting).toBe(1);
		expect(store.rows[0]).toMatchObject({ status: "ARMED" });
		expect(enqueue).not.toHaveBeenCalled();
	});

	it("a lost channel claim RE-ARMS the row instead of reporting success", async () => {
		const store = makeStore([makeRow()], [makeChannel()]);
		// Sabotage: the channel moves between the read and the claim.
		const original = store.prisma.liveChannel.findUnique;
		store.prisma.liveChannel.findUnique = vi.fn(async (args) => {
			const result = await original(args);
			const channel = store.channels[0];
			if (channel) {
				channel.status = "PROVISIONING"; // route's start won the race
			}
			return result;
		}) as typeof original;
		const { sweep, enqueue } = makeSweep(store);
		const stats = await sweep();
		expect(stats.fired).toBe(0);
		expect(store.rows[0]).toMatchObject({ status: "ARMED" });
		expect(enqueue).not.toHaveBeenCalled();
	});
});

describe("STOP — claims like the route, waits out transitions (review-190 C2)", () => {
	it("RUNNING claims STOPPING then enqueues stop", async () => {
		const store = makeStore(
			[makeRow({ action: "STOP" })],
			[makeChannel({ status: "RUNNING" })],
		);
		const { sweep, enqueue } = makeSweep(store);
		const stats = await sweep();
		expect(stats.fired).toBe(1);
		expect(store.channels[0]).toMatchObject({ status: "STOPPING" });
		expect(enqueue).toHaveBeenCalledWith(
			expect.objectContaining({ liveChannelId: CH, action: "stop" }),
			`sched-${ROW_ID}`,
		);
	});

	it("PROVISIONING waits — no unclaimed stop is thrown into a transition", async () => {
		const store = makeStore(
			[makeRow({ action: "STOP" })],
			[makeChannel({ status: "PROVISIONING" })],
		);
		const { sweep, enqueue } = makeSweep(store);
		const stats = await sweep();
		expect(stats.waiting).toBe(1);
		expect(store.rows[0]).toMatchObject({ status: "ARMED" });
		expect(store.channels[0]).toMatchObject({ status: "PROVISIONING" });
		expect(enqueue).not.toHaveBeenCalled();
	});

	it("STOPPED completes with a note — nothing to stop is not a failure", async () => {
		const store = makeStore(
			[makeRow({ action: "STOP" })],
			[makeChannel({ status: "STOPPED" })],
		);
		const { sweep, enqueue } = makeSweep(store);
		const stats = await sweep();
		expect(stats.completed).toBe(1);
		expect(store.rows[0]?.note).toMatch(/nothing to stop/);
		expect(enqueue).not.toHaveBeenCalled();
	});

	it("a STOP overdue by HOURS still fires — no grace on stops", async () => {
		const store = makeStore(
			[
				makeRow({
					action: "STOP",
					fireAt: new Date(2_000_000 - 5 * 3_600_000),
				}),
			],
			[makeChannel({ status: "RUNNING" })],
		);
		const { sweep } = makeSweep(store);
		expect((await sweep()).fired).toBe(1);
	});

	it("enqueue failure marks the channel (route pattern), RE-ARMS the row, and the NEXT tick self-heals (review-190 C3)", async () => {
		const store = makeStore(
			[makeRow({ action: "STOP" })],
			[makeChannel({ status: "RUNNING" })],
		);
		let calls = 0;
		const { sweep, enqueue } = makeSweep(store, {
			enqueue: async () => {
				calls += 1;
				if (calls === 1) {
					throw new Error("redis gone");
				}
			},
		});
		const first = await sweep();
		expect(first.errors).toBe(1);
		expect(store.rows[0]).toMatchObject({ status: "ARMED" }); // NOT terminal
		expect(store.channels[0]).toMatchObject({
			status: "ERROR",
			error: "Enqueue failed — stop again",
		});
		// Next tick: ERROR is in the stop-claim set — the row fires again.
		const second = await sweep();
		expect(second.fired).toBe(1);
		expect(store.rows[0]).toMatchObject({ status: "FIRED" });
		expect(store.channels[0]).toMatchObject({ status: "STOPPING" });
		expect(enqueue).toHaveBeenCalledTimes(2);
	});
});

describe("SLATE_IN (蓋被せ)", () => {
	const slateRow = (over: Partial<Row> = {}) =>
		makeRow({
			action: "SLATE_IN",
			insertableContentId: CONTENT_ID,
			slateDurationSeconds: 300,
			...over,
		});

	it("R1: a run with NO sample refuses the slate — the previous airing's afterglow is not proof (review-243)", async () => {
		// The 2026-08-15 failure, reconstructed on a re-air: run N+1 flips
		// RUNNING, its first poll hasn't landed (run.lastHeartbeat null),
		// while the CHANNEL column still holds run N's final sample — recent
		// precisely because run N just ended. Value-level ?? passed the gate
		// on that afterglow; presence-level refuses until THIS run proves
		// ingest.
		const store = makeStore(
			[slateRow()],
			[makeChannel({ status: "RUNNING", lastHeartbeat: HB_CONNECTED })],
		);
		store.runs.push({ id: "run-2", seq: 2, status: "RUNNING" });
		const { sweep, enqueue } = makeSweep(store);
		const stats = await sweep();
		expect(enqueue).not.toHaveBeenCalled();
		expect(stats.waiting).toBeGreaterThan(0);
	});

	it("fires insert-content into a RUNNING channel with the row's params", async () => {
		const store = makeStore(
			[slateRow()],
			[makeChannel({ status: "RUNNING", lastHeartbeat: HB_CONNECTED })],
		);
		const { sweep, enqueue } = makeSweep(store);
		await sweep();
		expect(enqueue).toHaveBeenCalledWith(
			expect.objectContaining({
				liveChannelId: CH,
				action: "insert-content",
				// scheduleId rides EVERY slate row now, not only windowed ones
				// (review-299): the insert record is the operator's trace of
				// which row aired, and a wrongly-skipped slate insertion is only traceable
				// if the record names one.
				params: {
					insertableContentId: CONTENT_ID,
					durationSeconds: 300,
					scheduleId: ROW_ID,
				},
			}),
			`sched-${ROW_ID}`,
		);
	});

	it("a row MISSING its content fields is refused BEFORE any claim (review-190 I4)", async () => {
		const store = makeStore(
			[slateRow({ insertableContentId: null })],
			[makeChannel({ status: "RUNNING" })],
		);
		const { sweep, enqueue, emitEvent } = makeSweep(store);
		const stats = await sweep();
		expect(stats.errors).toBe(1);
		expect(store.rows[0]).toMatchObject({ status: "ERROR" });
		expect(enqueue).not.toHaveBeenCalled();
		expect(emitEvent).toHaveBeenCalledWith(
			expect.objectContaining({ kind: "SCHEDULE_MISSED" }),
		);
	});

	it("a non-RUNNING channel makes the slate WAIT (grace still bounds it)", async () => {
		const store = makeStore(
			[slateRow()],
			[makeChannel({ status: "PROVISIONING" })],
		);
		const { sweep, enqueue } = makeSweep(store);
		const stats = await sweep();
		expect(stats.waiting).toBe(1);
		expect(store.rows[0]).toMatchObject({ status: "ARMED" });
		expect(enqueue).not.toHaveBeenCalled();
	});
});

describe("creation-time slates (ledger #94)", () => {
	const SOURCE = {
		credentialId: "00000000-0000-4000-8000-0000000000c1",
		bucket: "in",
		key: "slate.mp4",
	};

	it("registers a pending slate on a RUNNING channel: CAS claim + one enqueue", async () => {
		const row = makeRow({
			action: "SLATE_IN",
			// Fire time still ahead — registration runs EARLY on purpose.
			fireAt: new Date(3_000_000),
			slateSource: SOURCE,
			slateUntil: new Date(3_600_000),
		});
		const store = makeStore([row], [makeChannel({ status: "RUNNING" })]);
		const { sweep, enqueue } = makeSweep(store);
		await sweep();

		expect(enqueue).toHaveBeenCalledWith(
			expect.objectContaining({
				liveChannelId: CH,
				action: "register-slate-content",
				params: { scheduleId: ROW_ID, source: SOURCE },
			}),
			// review-223 F1 (CRITICAL): the job id carries the CLAIM EPOCH.
			// BullMQ's jobId dedupe consults the completed/failed sets too, so
			// a bare `sched-content-<row>` silently swallowed every
			// re-registration after a released claim (verified on real Redis).
			// Within one claim, redeliveries still dedupe; a NEW claim (new
			// epoch — now here is pinned at 2_000_000) is a runnable job.
			`sched-content-${ROW_ID}-2000000`,
		);
		expect(store.rows[0]?.contentClaimedAt).not.toBeNull();
		// The CAS itself, verbatim: claim FROM the read value (null here) —
		// two workers that both read null cannot both win.
		expect(store.prisma.liveSchedule.updateMany).toHaveBeenCalledWith({
			where: { id: ROW_ID, contentClaimedAt: null, status: "ARMED" },
			data: { contentClaimedAt: new Date(2_000_000) },
		});

		// Second tick: the claim holds — no duplicate registration. This is
		// the CAS the projecting mock filters exist for.
		await sweep();
		const registrations = enqueue.mock.calls.filter(
			(call) =>
				(call[0] as { action?: string }).action === "register-slate-content",
		);
		expect(registrations).toHaveLength(1);
	});

	it("does not claim while the channel is not RUNNING — registration needs an encoding", async () => {
		const row = makeRow({
			action: "SLATE_IN",
			fireAt: new Date(3_000_000),
			slateSource: SOURCE,
			slateUntil: new Date(3_600_000),
		});
		const store = makeStore([row], [makeChannel({ status: "PROVISIONING" })]);
		const { sweep, enqueue } = makeSweep(store);
		await sweep();
		expect(enqueue).not.toHaveBeenCalled();
		expect(store.rows[0]?.contentClaimedAt).toBeNull();
	});

	it("releases the claim when the enqueue fails, so the next tick retries", async () => {
		const row = makeRow({
			action: "SLATE_IN",
			fireAt: new Date(3_000_000),
			slateSource: SOURCE,
			slateUntil: new Date(3_600_000),
		});
		const store = makeStore([row], [makeChannel({ status: "RUNNING" })]);
		const { sweep } = makeSweep(store, {
			enqueue: async () => {
				throw new Error("redis down");
			},
		});
		await sweep();
		expect(store.rows[0]?.contentClaimedAt).toBeNull();
		expect(store.rows[0]?.status).toBe("ARMED");
	});

	it("a DUE pending-registration slate WAITS instead of erroring — the old validation would have killed it", async () => {
		const row = makeRow({
			action: "SLATE_IN",
			fireAt: new Date(1_940_000), // due, 1m overdue, inside grace
			slateSource: SOURCE,
			slateUntil: new Date(3_600_000),
			contentClaimedAt: new Date(1_900_000), // registration in flight
		});
		const store = makeStore([row], [makeChannel({ status: "RUNNING" })]);
		const { sweep, enqueue } = makeSweep(store);
		await sweep();
		// Not FIRED, not ERROR, not MISSED: waiting on the content id, which
		// only appears once the content is READY (the fire gate).
		expect(store.rows[0]?.status).toBe("ARMED");
		const inserts = enqueue.mock.calls.filter(
			(call) => (call[0] as { action?: string }).action === "insert-content",
		);
		expect(inserts).toHaveLength(0);
	});

	it("computes the duration AT FIRE TIME from slateUntil — a fixed one would overrun the program", async () => {
		const row = makeRow({
			action: "SLATE_IN",
			fireAt: new Date(1_940_000),
			insertableContentId: CONTENT_ID,
			slateSource: SOURCE,
			// 90.4s after now (2_000_000): pins FLOOR — rounding up would put
			// 0.4s of slate on top of the program (review-223 F6).
			slateUntil: new Date(2_090_400),
		});
		const store = makeStore(
			[row],
			[makeChannel({ status: "RUNNING", lastHeartbeat: HB_CONNECTED })],
		);
		const { sweep, enqueue } = makeSweep(store);
		await sweep();
		expect(enqueue).toHaveBeenCalledWith(
			expect.objectContaining({
				liveChannelId: CH,
				action: "insert-content",
				params: {
					insertableContentId: CONTENT_ID,
					durationSeconds: 90,
					// F6: the WINDOW rides along — queue retries can run the
					// insert ~75s after this computation, and the processor
					// re-derives the duration at the moment of the SDK call.
					slateUntil: new Date(2_090_400).toISOString(),
					scheduleId: ROW_ID,
				},
			}),
			`sched-${ROW_ID}`,
		);
		expect(store.rows[0]?.status).toBe("FIRED");
	});

	it("re-claims a STALE claim with a NEW epoch job id — a dead job's leavings do not pin the row (review-223 F1)", async () => {
		const row = makeRow({
			action: "SLATE_IN",
			fireAt: new Date(3_000_000),
			slateSource: SOURCE,
			slateUntil: new Date(3_600_000),
			// Older than STALE_CLAIM_MS (11m) before now=2_000_000: the job
			// that claimed it stalled and died — the liveChannel queue runs
			// maxStalledCount 1 , so BullMQ never retries it.
			contentClaimedAt: new Date(1_000_000),
		});
		const store = makeStore([row], [makeChannel({ status: "RUNNING" })]);
		const { sweep, enqueue } = makeSweep(store);
		await sweep();
		expect(enqueue).toHaveBeenCalledWith(
			expect.objectContaining({ action: "register-slate-content" }),
			// The NEW claim's epoch — a runnable job id, not the dead claim's
			// deduped one.
			`sched-content-${ROW_ID}-2000000`,
		);
		expect(store.rows[0]?.contentClaimedAt?.getTime()).toBe(2_000_000);
	});

	it("a slate 12m past fireAt with 48m of window left WAITS — the deadline is the WINDOW, not fireAt+grace (review-223 F2)", async () => {
		const row = makeRow({
			action: "SLATE_IN",
			// 12 minutes overdue: PAST the 10-minute fixed grace that used to
			// kill it (the reviewer's case — provisioning alone took 12m while
			// the pre-air window still had 48m of cover to give).
			fireAt: new Date(2_000_000 - 12 * 60_000),
			slateSource: SOURCE,
			slateUntil: new Date(2_000_000 + 48 * 60_000),
			contentClaimedAt: new Date(1_900_000), // registration in flight
		});
		const store = makeStore([row], [makeChannel({ status: "RUNNING" })]);
		const { sweep, enqueue } = makeSweep(store);
		await sweep();
		expect(store.rows[0]?.status).toBe("ARMED");
		expect(enqueue).not.toHaveBeenCalled();
	});

	it("MISSES the same overdue slate once the WINDOW is inside MIN_SLATE_FIRE_SECONDS", async () => {
		const row = makeRow({
			action: "SLATE_IN",
			fireAt: new Date(2_000_000 - 12 * 60_000),
			slateSource: SOURCE,
			slateUntil: new Date(2_000_000 + 4_000), // 4s < MIN (5s)
			contentClaimedAt: new Date(1_900_000),
		});
		const store = makeStore([row], [makeChannel({ status: "RUNNING" })]);
		const { sweep, enqueue } = makeSweep(store);
		await sweep();
		expect(store.rows[0]?.status).toBe("MISSED");
		expect(store.rows[0]?.note).toContain("slate window closed");
		expect(enqueue).not.toHaveBeenCalled();
	});

	it("a RUNNING channel with NO CONNECTED ingest makes the slate WAIT — a splice into a no-input encoder renders nothing (ledger #95)", async () => {
		const row = makeRow({
			action: "SLATE_IN",
			fireAt: new Date(1_940_000),
			insertableContentId: CONTENT_ID,
			slateSource: SOURCE,
			slateUntil: new Date(2_000_000 + 20 * 60_000),
		});
		// RUNNING, but the last heartbeat still says WAITING_FOR_FIRST_CONNECT
		// — the 2026-08-15 incident shape: encoder up, feeder pushing into a
		// dead session, schedule promising a slate no one can see.
		const store = makeStore(
			[row],
			[
				makeChannel({
					status: "RUNNING",
					lastHeartbeat: {
						at: "2026-08-15T00:58:00.000Z",
						raw: {
							ingest: {
								status: "WAITING_FOR_FIRST_CONNECT",
								healthy: false,
							},
						},
						deltas: {},
					},
				}),
			],
		);
		const { sweep, enqueue } = makeSweep(store);
		await sweep();
		expect(store.rows[0]?.status).toBe("ARMED");
		expect(enqueue).not.toHaveBeenCalled();

		// The instant the ingest is PROVEN connected, the same row fires.
		const channel = store.channels[0];
		if (channel) {
			channel.lastHeartbeat = HB_CONNECTED;
		}
		const currentRun = store.runs.at(-1);
		if (currentRun) currentRun.lastHeartbeat = HB_CONNECTED;
		await sweep();
		expect(store.rows[0]?.status).toBe("FIRED");
	});

	it("a STALE CONNECTED sample makes the slate WAIT — a revived run keeps its pre-error proof on the SAME row (ledger #127)", async () => {
		// review-243 R1's presence-level read cannot help here: resume reuses
		// the run row, so the pre-error CONNECTED sample is PRESENT and only
		// its AGE says the proof expired. Without the freshness gate this is
		// the 2026-08-15 incident again through the revive door.
		const row = makeRow({
			action: "SLATE_IN",
			fireAt: new Date(1_940_000),
			insertableContentId: CONTENT_ID,
			slateSource: SOURCE,
			slateUntil: new Date(2_000_000 + 20 * 60_000),
		});
		const staleConnected = {
			// 10 minutes BEFORE the injected now (2_000_000) — CONNECTED in
			// content, expired in time.
			at: new Date(2_000_000 - 10 * 60_000).toISOString(),
			raw: { ingest: { status: "CONNECTED", healthy: true } },
			deltas: {},
		};
		const store = makeStore(
			[row],
			[makeChannel({ status: "RUNNING", lastHeartbeat: staleConnected })],
		);
		const { sweep, enqueue } = makeSweep(store);
		await sweep();
		expect(store.rows[0]?.status).toBe("ARMED");
		expect(enqueue).not.toHaveBeenCalled();

		// A fresh sample on the same row fires it — proving WAIT was the
		// freshness gate, not some other refusal.
		const channel = store.channels[0];
		if (channel) {
			channel.lastHeartbeat = {
				at: new Date(2_000_000 - 30_000).toISOString(),
				raw: { ingest: { status: "CONNECTED", healthy: true } },
				deltas: {},
			};
		}
		const currentRun = store.runs.at(-1);
		if (currentRun) currentRun.lastHeartbeat = channel?.lastHeartbeat;
		await sweep();
		expect(store.rows[0]?.status).toBe("FIRED");
	});

	it("MISSES a slate whose window is already over at fire time — never covers the program", async () => {
		const row = makeRow({
			action: "SLATE_IN",
			fireAt: new Date(1_940_000),
			insertableContentId: CONTENT_ID,
			slateSource: SOURCE,
			slateUntil: new Date(2_000_000), // exactly now: 0s of window left
		});
		const store = makeStore([row], [makeChannel({ status: "RUNNING" })]);
		const { sweep, enqueue } = makeSweep(store);
		await sweep();
		expect(store.rows[0]?.status).toBe("MISSED");
		// review-223 F2: the WINDOW deadline (slateUntil − MIN) owns this
		// MISSED now — fireSlate's own remaining-check is the last-line racer.
		expect(store.rows[0]?.note).toContain("slate window closed");
		expect(enqueue).not.toHaveBeenCalled();
	});
});

describe("feeder-chain rows (ledger #96)", () => {
	const SOURCE = {
		credentialId: "00000000-0000-4000-8000-0000000000c1",
		bucket: "in",
		key: "slate.mp4",
	};

	it("fires feeder-start into a RUNNING channel with the row's source", async () => {
		const row = makeRow({
			action: "FEEDER_START",
			fireAt: new Date(1_940_000),
			feederSource: SOURCE,
			slateUntil: new Date(2_000_000 + 20 * 60_000),
		});
		const store = makeStore([row], [makeChannel({ status: "RUNNING" })]);
		const { sweep, enqueue } = makeSweep(store);
		await sweep();
		expect(enqueue).toHaveBeenCalledWith(
			expect.objectContaining({
				liveChannelId: CH,
				action: "feeder-start",
				params: { scheduleId: ROW_ID, source: SOURCE },
			}),
			`sched-${ROW_ID}`,
		);
		expect(store.rows[0]?.status).toBe("FIRED");
	});

	it("a FEEDER_SWITCH never fires the single-phase switch action — an unstaged switch at fire time is refused (row #240)", async () => {
		const row = makeRow({
			action: "FEEDER_SWITCH",
			fireAt: new Date(1_940_000),
			feederSource: SOURCE,
			slateUntil: new Date(2_000_000 + 60 * 60_000),
		});
		const store = makeStore([row], [makeChannel({ status: "RUNNING" })]);
		const { sweep, enqueue } = makeSweep(store);
		await sweep();
		// The old contract enqueued `feeder-switch` here — stop the actives,
		// then start a download at air time: the seam the audit measured.
		expect(enqueue).not.toHaveBeenCalledWith(
			expect.objectContaining({ action: "feeder-switch" }),
			expect.anything(),
		);
		expect(store.rows[0]?.status).toBe("MISSED");
		expect(store.rows[0]?.note).toContain("not staged");
	});

	it("waits while the channel is not yet RUNNING — the useful-until window bounds it", async () => {
		const row = makeRow({
			action: "FEEDER_START",
			fireAt: new Date(1_940_000),
			feederSource: SOURCE,
			slateUntil: new Date(2_000_000 + 20 * 60_000),
		});
		const store = makeStore([row], [makeChannel({ status: "PROVISIONING" })]);
		const { sweep, enqueue } = makeSweep(store);
		await sweep();
		expect(store.rows[0]?.status).toBe("ARMED");
		expect(enqueue).not.toHaveBeenCalled();
	});

	it("MISSES a feeder row whose useful-until window closed — same F2 machinery as slates", async () => {
		const row = makeRow({
			action: "FEEDER_START",
			fireAt: new Date(2_000_000 - 12 * 60_000),
			feederSource: SOURCE,
			slateUntil: new Date(2_000_000 + 4_000), // 4s < MIN(5s)
		});
		const store = makeStore([row], [makeChannel({ status: "RUNNING" })]);
		const { sweep, enqueue } = makeSweep(store);
		await sweep();
		expect(store.rows[0]?.status).toBe("MISSED");
		expect(store.rows[0]?.note).toContain("feeder window closed");
		expect(enqueue).not.toHaveBeenCalled();
	});

	it("a feeder row with NO valid source is refused as ERROR before any claim", async () => {
		const row = makeRow({
			action: "FEEDER_START",
			fireAt: new Date(1_940_000),
			feederSource: { nope: true },
			slateUntil: new Date(2_000_000 + 20 * 60_000),
		});
		const store = makeStore([row], [makeChannel({ status: "RUNNING" })]);
		const { sweep, enqueue } = makeSweep(store);
		await sweep();
		expect(store.rows[0]?.status).toBe("ERROR");
		expect(enqueue).not.toHaveBeenCalled();
	});
});

describe("grace asymmetry", () => {
	it.each([
		"START",
		"SLATE_IN",
	] as const)("a %s overdue past grace is MISSED, never fired late", async (action) => {
		const store = makeStore(
			[
				makeRow({
					action,
					fireAt: new Date(1_000_000), // ~16.7m > 10m grace
					insertableContentId: action === "SLATE_IN" ? CONTENT_ID : null,
					slateDurationSeconds: action === "SLATE_IN" ? 60 : null,
				}),
			],
			[makeChannel({ status: "RUNNING" })],
		);
		const { sweep, enqueue, emitEvent } = makeSweep(store);
		const stats = await sweep();
		expect(stats.missed).toBe(1);
		expect(store.rows[0]).toMatchObject({ status: "MISSED" });
		// RUNNING would have COMPLETED a start / fired a slate — grace
		// wins first: nothing was enqueued, nothing claimed.
		expect(enqueue).not.toHaveBeenCalled();
		expect(emitEvent).toHaveBeenCalledWith(
			expect.objectContaining({ kind: "SCHEDULE_MISSED" }),
		);
	});

	// NOTE deliberately absent: a same-instance overlap test — the
	// reentrancy guard (review-190 I2) makes the second call a no-op
	// before it ever reads, so a same-instance latch would deadlock. The
	// cross-process shape below is the race the row claim exists for.
	it("two sweep INSTANCES racing (cross-process shape) still fire once", async () => {
		const store = makeStore([makeRow()], [makeChannel()]);
		store.latch = { expected: 2, waiters: [] };
		const first = makeSweep(store);
		const second = makeSweep(store);
		const [a, b] = await Promise.all([first.sweep(), second.sweep()]);
		expect(a.fired + b.fired).toBe(1);
		expect(
			first.enqueue.mock.calls.length + second.enqueue.mock.calls.length,
		).toBe(1);
	});
});

describe("maxRunMinutes cap (runningSince column, atomic claim)", () => {
	const T0 = 10_000_000;
	const runningChannel = (over: Partial<Channel> = {}) =>
		makeChannel({
			status: "RUNNING",
			maxRunMinutes: 60,
			runningSince: new Date(T0),
			...over,
		});

	it("past the deadline: claims STOPPING, records the epoch row, enqueues ONE deterministic stop", async () => {
		const store = makeStore([], [runningChannel()]);
		const { sweep, enqueue, emitEvent } = makeSweep(store, {
			now: () => new Date(T0 + 61 * 60_000),
		});
		const stats = await sweep();
		expect(stats.capStops).toBe(1);
		expect(store.channels[0]).toMatchObject({ status: "STOPPING" });
		const deadline = T0 + 60 * 60_000;
		// : ONE id rule — derived from the epoch ROW (itself
		// unique per channel+deadline under the partial index), so the
		// outbox dispatcher can rebuild it after a crash.
		expect(enqueue).toHaveBeenCalledWith(
			expect.objectContaining({ liveChannelId: CH, action: "stop" }),
			`sched-${store.rows[0]?.id}`,
		);
		expect(store.rows[0]).toMatchObject({
			action: "STOP",
			status: "FIRED",
			note: "max-run-cap",
		});
		expect(store.rows[0]?.fireAt.getTime()).toBe(deadline);
		expect(emitEvent).toHaveBeenCalledWith(
			expect.objectContaining({ kind: "SCHEDULE_FIRED" }),
		);
		// Second tick: channel is STOPPING — the claim is the lock, nothing
		// doubles.
		const again = await sweep();
		expect(again.capStops).toBe(0);
		expect(enqueue).toHaveBeenCalledTimes(1);
	});

	it("TWO racing cap sweeps: the channel claim admits exactly one (review-190 I1)", async () => {
		const store = makeStore([], [runningChannel()]);
		const first = makeSweep(store, { now: () => new Date(T0 + 61 * 60_000) });
		const second = makeSweep(store, { now: () => new Date(T0 + 61 * 60_000) });
		const [a, b] = await Promise.all([first.sweep(), second.sweep()]);
		expect(a.capStops + b.capStops).toBe(1);
		expect(
			first.enqueue.mock.calls.length + second.enqueue.mock.calls.length,
		).toBe(1);
		expect(store.rows).toHaveLength(1);
	});

	it("the P2002 epoch branch is a BACKSTOP for a future RUNNING-writer that skips runningSince", async () => {
		// review-190 re-verify I2: this cannot occur in production TODAY —
		// both RUNNING writers rewrite runningSince, so a restart yields a
		// DIFFERENT deadline and cannot collide. The branch (and the partial
		// unique index) guard a future writer that sets RUNNING without
		// touching the column; a real crash between create and enqueue is
		// the I1 wedge, recovered by the release-on-failure path below.
		const store = makeStore([], [runningChannel()]);
		const deadline = T0 + 60 * 60_000;
		// The backstop world: an epoch row already exists at the SAME
		// deadline while the channel reads RUNNING.
		store.rows.push(
			makeRow({
				id: "44444444-4444-4444-8444-444444444444",
				action: "STOP",
				fireAt: new Date(deadline),
				status: "FIRED",
				note: "max-run-cap",
			}),
		);
		const { sweep, enqueue } = makeSweep(store, {
			now: () => new Date(T0 + 61 * 60_000),
		});
		const stats = await sweep();
		expect(stats.capStops).toBe(1);
		// Same deterministic id — BullMQ dedupes if the job DID survive. The
		// id comes from the EXISTING epoch row the P2002 lookup found
		// , which is what keeps it stable across the collision.
		expect(enqueue).toHaveBeenCalledWith(
			expect.objectContaining({ liveChannelId: CH, action: "stop" }),
			"sched-44444444-4444-4444-8444-444444444444",
		);
		expect(store.rows).toHaveLength(1); // no second epoch row
	});

	it("within the deadline or without runningSince: untouched", async () => {
		const store = makeStore(
			[],
			[
				runningChannel(),
				runningChannel({
					id: "55555555-5555-4555-8555-555555555555",
					runningSince: null,
				}),
			],
		);
		const { sweep, enqueue } = makeSweep(store, {
			now: () => new Date(T0 + 59 * 60_000),
		});
		expect((await sweep()).capStops).toBe(0);
		expect(enqueue).not.toHaveBeenCalled();
	});

	it("a NON-P2002 create failure fails closed — it never fabricates RUNNING without a provider observation", async () => {
		// There is no durable STOP row to recover here. ERROR is the honest
		// state: the provider may still be running, while RUNNING would be an
		// invented lifecycle observation.
		const store = makeStore([], [runningChannel()]);
		let creates = 0;
		const originalCreate = store.prisma.liveSchedule.create;
		store.prisma.liveSchedule.create = vi.fn(async (args) => {
			creates += 1;
			if (creates === 1) {
				const err = new Error("pool exhausted") as Error & { code: string };
				err.code = "P2024";
				throw err;
			}
			return originalCreate(args);
		}) as typeof originalCreate;
		const { sweep, enqueue } = makeSweep(store, {
			now: () => new Date(T0 + 61 * 60_000),
		});
		const first = await sweep();
		expect(first.errors).toBe(1);
		expect(first.capStops).toBe(0);
		expect(store.channels[0]).toMatchObject({
			status: "ERROR",
			error: expect.stringContaining("runtime-cap STOP handoff failed"),
		});
		expect(enqueue).not.toHaveBeenCalled();
		// ERROR is not silently promoted back to RUNNING on the next tick.
		const second = await sweep();
		expect(second.capStops).toBe(0);
		expect(store.channels[0]).toMatchObject({ status: "ERROR" });
		expect(enqueue).not.toHaveBeenCalled();
	});

	it("cap enqueue failure keeps STOPPING and its durable outbox; the next tick re-dispatches it", async () => {
		const store = makeStore([], [runningChannel()]);
		let calls = 0;
		let nowMs = T0 + 61 * 60_000;
		const { sweep, enqueue } = makeSweep(store, {
			now: () => new Date(nowMs),
			enqueue: async () => {
				calls += 1;
				if (calls === 1) {
					throw new Error("redis gone");
				}
			},
		});
		const first = await sweep();
		expect(first.errors).toBe(1);
		expect(store.channels[0]).toMatchObject({ status: "STOPPING" });
		expect(store.rows[0]).toMatchObject({
			status: "FIRED",
			dispatchedAt: null,
			note: expect.stringContaining("runtime-cap STOP handoff failed"),
		});
		nowMs += 61_000;
		const second = await sweep();
		expect(second.capStops).toBe(0);
		expect(second.redispatched).toBe(1);
		expect(store.channels[0]).toMatchObject({ status: "STOPPING" });
		expect(enqueue).toHaveBeenCalledTimes(2);
	});
});

describe("reentrancy (review-190 I2)", () => {
	it("an in-flight runOnce makes the overlapping call a no-op", async () => {
		const store = makeStore([makeRow()], [makeChannel()]);
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { sweep } = makeSweep(store, {
			enqueue: async () => {
				await gate; // hold the first tick open
			},
		});
		const first = sweep();
		// Give the first tick a beat to take the guard.
		await new Promise((resolve) => setTimeout(resolve, 10));
		const second = await sweep();
		expect(second).toMatchObject({ fired: 0, waiting: 0, missed: 0 });
		release();
		const firstStats = await first;
		expect(firstStats.fired).toBe(1);
	});
});

describe("auto-lead grace — MISSED runs from airAt, not the early fireAt (ledger #160 PR3)", () => {
	it("a lead-window row well past fireAt+grace still FIRES while air time lies ahead", async () => {
		// fireAt 1_000_000 (overdue ~17min > 10min grace) but airAt 3_600_000
		// — the whole point of an early fire time is that the window is real.
		const store = makeStore(
			[
				makeRow({
					fireAt: new Date(1_000_000),
					airAt: new Date(3_600_000),
					autoLeadTime: true,
				}),
			],
			[makeChannel()],
		);
		const { sweep } = makeSweep(store);
		const stats = await sweep();
		expect(stats.fired).toBe(1);
		expect(store.rows[0]).toMatchObject({ status: "FIRED" });
	});

	it("past airAt+grace the auto-lead row goes MISSED like any other", async () => {
		// airAt 1_200_000: now(2_000_000) − airAt = 13m20s > 10m grace.
		const store = makeStore(
			[
				makeRow({
					fireAt: new Date(900_000),
					airAt: new Date(1_200_000),
					autoLeadTime: true,
				}),
			],
			[makeChannel()],
		);
		const { sweep } = makeSweep(store);
		const stats = await sweep();
		expect(stats.missed).toBe(1);
		expect(store.rows[0]).toMatchObject({ status: "MISSED" });
	});

	it("a NON-auto-lead START with the same early fireAt keeps the fireAt-anchored grace — the derivation is opt-in", async () => {
		const store = makeStore(
			[
				makeRow({
					fireAt: new Date(1_000_000),
					airAt: new Date(3_600_000),
					autoLeadTime: false,
				}),
			],
			[makeChannel()],
		);
		const { sweep } = makeSweep(store);
		const stats = await sweep();
		expect(stats.missed).toBe(1);
	});
});

describe("deadline backstop — SCHEDULE_NOT_RUNNING_AT_DEADLINE (ledger #160 PR2)", () => {
	// Future fireAt keeps fireDue out of the picture: these rows are ARMED but
	// not due, so the only sweep pass that can touch them is fireDeadlines.
	const FUTURE_FIRE = new Date(3_000_000);

	it("fires ONCE past airAt − margin when the channel is not RUNNING, and never again", async () => {
		// now = 2_000_000; airAt 2_200_000 with 300s margin → deadline 1_900_000,
		// already past; channel still CREATED.
		const store = makeStore(
			[makeRow({ fireAt: FUTURE_FIRE, airAt: new Date(2_200_000) })],
			[makeChannel()],
		);
		const { sweep, emitEvent } = makeSweep(store);
		await sweep();
		expect(emitEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: "SCHEDULE_NOT_RUNNING_AT_DEADLINE",
				scheduleId: ROW_ID,
				liveChannelId: CH,
				airAt: new Date(2_200_000).toISOString(),
				channelStatus: "CREATED",
				path: `/live/${CH}`,
			}),
		);
		expect(store.rows[0]?.deadlineNotifiedAt).not.toBeNull();
		// Second tick: the stamp keeps the row out of the scan — no re-alert.
		emitEvent.mockClear();
		await sweep();
		expect(emitEvent).not.toHaveBeenCalled();
	});

	it("stamps silently when the channel IS running by the deadline", async () => {
		const store = makeStore(
			[makeRow({ fireAt: FUTURE_FIRE, airAt: new Date(2_200_000) })],
			[makeChannel({ status: "RUNNING" })],
		);
		const { sweep, emitEvent } = makeSweep(store);
		await sweep();
		expect(store.rows[0]?.deadlineNotifiedAt).not.toBeNull();
		expect(emitEvent).not.toHaveBeenCalledWith(
			expect.objectContaining({ kind: "SCHEDULE_NOT_RUNNING_AT_DEADLINE" }),
		);
	});

	it("waits while the deadline is still ahead — no stamp, no event", async () => {
		// airAt 2_400_000 → deadline 2_100_000, still in the future of now.
		const store = makeStore(
			[makeRow({ fireAt: FUTURE_FIRE, airAt: new Date(2_400_000) })],
			[makeChannel()],
		);
		const { sweep, emitEvent } = makeSweep(store);
		await sweep();
		expect(store.rows[0]?.deadlineNotifiedAt).toBeNull();
		expect(emitEvent).not.toHaveBeenCalledWith(
			expect.objectContaining({ kind: "SCHEDULE_NOT_RUNNING_AT_DEADLINE" }),
		);
	});

	it("a CANCELED broadcast never deadline-alerts — the operator said it will not happen", async () => {
		const store = makeStore(
			[
				makeRow({
					fireAt: FUTURE_FIRE,
					airAt: new Date(2_200_000),
					status: "CANCELED",
				}),
			],
			[makeChannel()],
		);
		const { sweep, emitEvent } = makeSweep(store);
		await sweep();
		expect(store.rows[0]?.deadlineNotifiedAt).toBeNull();
		expect(emitEvent).not.toHaveBeenCalledWith(
			expect.objectContaining({ kind: "SCHEDULE_NOT_RUNNING_AT_DEADLINE" }),
		);
	});

	it("a lost CAS race emits nothing (two overlapping sweeps → one alert)", async () => {
		const store = makeStore(
			[
				makeRow({
					fireAt: FUTURE_FIRE,
					airAt: new Date(2_200_000),
					// A concurrent sweep already stamped between our read and CAS:
					// the scan is faked open below, so ONLY the CAS can dedupe.
					deadlineNotifiedAt: null,
				}),
			],
			[makeChannel()],
		);
		// Force the row to stay visible to the scan, then make the CAS lose:
		// stamp it out from under the sweep on first updateMany contact.
		const original =
			store.prisma.liveSchedule.updateMany.getMockImplementation();
		store.prisma.liveSchedule.updateMany.mockImplementationOnce(
			async (args: { where: { id?: string }; data: Partial<Row> }) => {
				// The competing sweep wins first…
				const row = store.rows.find((r) => r.id === args.where.id);
				if (row) {
					row.deadlineNotifiedAt = new Date(1_999_999);
				}
				// …then OUR CAS runs against the now-stamped row.
				return (original as (a: unknown) => Promise<{ count: number }>)(args);
			},
		);
		const { sweep, emitEvent } = makeSweep(store);
		await sweep();
		expect(emitEvent).not.toHaveBeenCalledWith(
			expect.objectContaining({ kind: "SCHEDULE_NOT_RUNNING_AT_DEADLINE" }),
		);
	});

	it("an emit failure rolls the stamp back — the alert retries instead of being lost", async () => {
		const store = makeStore(
			[makeRow({ fireAt: FUTURE_FIRE, airAt: new Date(2_200_000) })],
			[makeChannel()],
		);
		const errorSpy = vi
			.spyOn(console, "error")
			.mockImplementation(() => undefined);
		try {
			const { sweep, emitEvent } = makeSweep(store);
			emitEvent.mockRejectedValueOnce(new Error("notify queue down"));
			await sweep();
			// Stamp rolled back: the row is still scannable.
			expect(store.rows[0]?.deadlineNotifiedAt).toBeNull();
			// Next tick delivers.
			await sweep();
			const deadlineEmits = (
				emitEvent.mock.calls as unknown as Array<[{ kind?: string }]>
			).filter(([event]) => event.kind === "SCHEDULE_NOT_RUNNING_AT_DEADLINE");
			expect(deadlineEmits).toHaveLength(2);
			expect(store.rows[0]?.deadlineNotifiedAt).not.toBeNull();
		} finally {
			errorSpy.mockRestore();
		}
	});

	it("a reconciler failure cannot break the tick (best-effort seam)", async () => {
		const store = makeStore([makeRow()], [makeChannel()]);
		store.prisma.liveChannelRun.findMany.mockRejectedValueOnce(
			new Error("db down"),
		);
		const errorSpy = vi
			.spyOn(console, "error")
			.mockImplementation(() => undefined);
		try {
			const { sweep } = makeSweep(store);
			const stats = await sweep();
			expect(stats.fired).toBe(1);
			expect(errorSpy).toHaveBeenCalledWith(
				"startup-sample reconcile failed:",
				"db down",
			);
		} finally {
			errorSpy.mockRestore();
		}
	});
});

/**
 *  — the queue-handoff OUTBOX (audit 2026-08-29 §4 CRITICAL-1).
 *
 * Every fire path commits its CLAIM (the row to FIRED, and where one exists
 * the channel: START→PROVISIONING, STOP and the cap→STOPPING) and calls
 * `queue.add` afterwards. A synchronous add failure re-arms; a SIGKILL does
 * not, and nothing re-read those rows — `fireDue` selects ARMED only. So a
 * START that never ran read FIRED, and a STOP that was lost left the
 * encoding billing.
 *
 * The kill is modelled by an `enqueue` that NEVER RESOLVES, which is what a
 * process death between the two writes actually looks like from the
 * database's side: the claim is committed, the add never completed, and the
 * sweep's own catch — which would have re-armed — never runs. Recovery is
 * then asserted through a SECOND sweep instance over the same store, i.e.
 * the replacement worker.
 */
describe("the queue-handoff outbox (ledger #236)", () => {
	const CRASH_AT = 2_000_000;
	/** Past DISPATCH_GRACE_MS (2 × 30s) from the claim above. */
	const RECOVERY_AT = CRASH_AT + 61_000;

	/**
	 * Run a sweep that dies with its `queue.add` in flight. Resolves once the
	 * add has been reached — i.e. once the claim is committed — so the
	 * assertions never race the dying tick.
	 */
	async function killDuringHandoff(
		store: ReturnType<typeof makeStore>,
	): Promise<void> {
		let reachedAdd: () => void = () => undefined;
		const reached = new Promise<void>((resolve) => {
			reachedAdd = resolve;
		});
		const { sweep } = makeSweep(store, {
			now: () => new Date(CRASH_AT),
			enqueue: () => {
				reachedAdd();
				// The process is gone: this promise never settles, so neither
				// the stamp below it nor the catch beside it ever runs.
				return new Promise<void>(() => undefined);
			},
		});
		void sweep();
		await reached;
	}

	/** A queue that dedupes by jobId the way BullMQ does. */
	function dedupingQueue() {
		const added: Array<{ job: unknown; jobId: string }> = [];
		const seen = new Set<string>();
		return {
			added,
			add: vi.fn(async (job: unknown, jobId: string) => {
				// BullMQ consults the COMPLETED/FAILED sets too, so an id it
				// has ever seen is never re-run.
				if (seen.has(jobId)) {
					return;
				}
				seen.add(jobId);
				added.push({ job, jobId });
			}),
		};
	}

	it("START: a kill between the claim and the add is recovered by the next sweep", async () => {
		const store = makeStore([makeRow()], [makeChannel()]);
		await killDuringHandoff(store);
		// The world the crash left: claimed, and no record of a handoff.
		expect(store.channels[0]).toMatchObject({ status: "PROVISIONING" });
		expect(store.rows[0]).toMatchObject({
			status: "FIRED",
			dispatchedAt: null,
		});

		const { sweep, enqueue } = makeSweep(store, {
			now: () => new Date(RECOVERY_AT),
		});
		const stats = await sweep();
		expect(stats.redispatched).toBe(1);
		expect(enqueue).toHaveBeenCalledWith(
			{ liveChannelId: CH, action: "provision" },
			`sched-${ROW_ID}`,
		);
		expect(store.rows[0]?.dispatchedAt).toBeInstanceOf(Date);
		expect(store.rows[0]?.dispatchJobId).toBe(`sched-${ROW_ID}`);
	});

	it("re-air START (STOPPED channel): the fresh run row is claimed and the lost provision comes back", async () => {
		const store = makeStore(
			[makeRow()],
			[makeChannel({ status: "STOPPED", bitmovinEncodingId: "enc-1" })],
		);
		store.runs.push({ id: "run-1", seq: 1, status: "STOPPED" });
		await killDuringHandoff(store);
		expect(store.channels[0]).toMatchObject({ status: "PROVISIONING" });
		// The re-air's own run row committed WITH the claim (#155/N2) — the
		// recovery must not mint a second one.
		expect(store.runs).toHaveLength(2);
		expect(store.rows[0]).toMatchObject({
			status: "FIRED",
			dispatchedAt: null,
		});

		const { sweep, enqueue } = makeSweep(store, {
			now: () => new Date(RECOVERY_AT),
		});
		expect((await sweep()).redispatched).toBe(1);
		expect(enqueue).toHaveBeenCalledWith(
			{ liveChannelId: CH, action: "provision" },
			`sched-${ROW_ID}`,
		);
		expect(store.runs).toHaveLength(2);
		expect(store.rows[0]?.dispatchedAt).toBeInstanceOf(Date);
	});

	it("STOP: the channel is left STOPPING and the lost stop is re-dispatched (the billing case)", async () => {
		const store = makeStore(
			[makeRow({ action: "STOP" })],
			[makeChannel({ status: "RUNNING" })],
		);
		await killDuringHandoff(store);
		expect(store.channels[0]).toMatchObject({ status: "STOPPING" });
		expect(store.rows[0]).toMatchObject({
			status: "FIRED",
			dispatchedAt: null,
		});

		const { sweep, enqueue } = makeSweep(store, {
			now: () => new Date(RECOVERY_AT),
		});
		expect((await sweep()).redispatched).toBe(1);
		// STOPPING is exactly the state `stopChannel` accepts, so the claim
		// is deliberately NOT released — releasing it would strand the
		// channel instead of the row.
		expect(store.channels[0]).toMatchObject({ status: "STOPPING" });
		expect(enqueue).toHaveBeenCalledWith(
			expect.objectContaining({ liveChannelId: CH, action: "stop" }),
			`sched-${ROW_ID}`,
		);
		expect(store.rows[0]?.dispatchedAt).toBeInstanceOf(Date);
	});

	it("SLATE_IN: the lost insert comes back with the duration re-derived at recovery time", async () => {
		const row = makeRow({
			action: "SLATE_IN",
			insertableContentId: CONTENT_ID,
			slateDurationSeconds: 45,
			slateUntil: new Date(CRASH_AT + 30 * 60_000),
		});
		const store = makeStore(
			[row],
			[makeChannel({ status: "RUNNING", lastHeartbeat: HB_CONNECTED })],
		);
		await killDuringHandoff(store);
		expect(store.rows[0]).toMatchObject({
			status: "FIRED",
			dispatchedAt: null,
		});

		const { sweep, enqueue } = makeSweep(store, {
			now: () => new Date(RECOVERY_AT),
		});
		expect((await sweep()).redispatched).toBe(1);
		// review-223 F6's rule applied to the recovery: the window is
		// measured from NOW, so the outage is not covered with slate.
		const untilMs = row.slateUntil?.getTime() ?? 0;
		expect(enqueue).toHaveBeenCalledWith(
			expect.objectContaining({
				liveChannelId: CH,
				action: "insert-content",
				params: {
					insertableContentId: CONTENT_ID,
					durationSeconds: Math.floor((untilMs - RECOVERY_AT) / 1000),
					scheduleId: ROW_ID,
					slateUntil: row.slateUntil?.toISOString(),
				},
			}),
			`sched-${ROW_ID}`,
		);
	});

	it("SLATE_IN whose window closed during the outage is MISSED, never inserted late", async () => {
		const store = makeStore(
			[
				makeRow({
					action: "SLATE_IN",
					status: "FIRED",
					firedAt: new Date(1_900_000),
					insertableContentId: CONTENT_ID,
					slateDurationSeconds: 45,
					// 4s of window left at now (2_000_000) — under MIN(5s).
					slateUntil: new Date(2_000_000 + 4_000),
				}),
			],
			[makeChannel({ status: "RUNNING", lastHeartbeat: HB_CONNECTED })],
		);
		const { sweep, enqueue, emitEvent } = makeSweep(store);
		expect((await sweep()).redispatched).toBe(0);
		expect(enqueue).not.toHaveBeenCalled();
		expect(store.rows[0]?.status).toBe("MISSED");
		expect(store.rows[0]?.note).toContain("window closed");
		expect(emitEvent).toHaveBeenCalledWith(
			expect.objectContaining({ kind: "SCHEDULE_MISSED" }),
		);
	});

	it("two dispatcher passes racing on one closed window emit exactly ONE missed notification", async () => {
		/**
		 * rev346 LOW-1. Two passes CAN reach the refusal for one row: the
		 * boot `dispatchPending` in index.ts is not under the tick's
		 * `inFlight` latch, so it overlaps the first tick, and in a rolling
		 * deploy two workers' boot passes overlap each other. Both read the
		 * row while it is still FIRED; only one CAS matches. The notification
		 * has to follow the WRITE, or an operator is paged twice for one
		 * missed slate.
		 *
		 * Latched at the SCAN so both readers genuinely hold the pre-write
		 * row — sequential calls could never produce this world, because the
		 * second scan would not select a row already MISSED.
		 */
		const store = makeStore(
			[
				makeRow({
					action: "SLATE_IN",
					status: "FIRED",
					firedAt: new Date(1_900_000),
					insertableContentId: CONTENT_ID,
					slateDurationSeconds: 45,
					// 4s of window left at now (2_000_000) — under MIN(5s).
					slateUntil: new Date(2_000_000 + 4_000),
				}),
			],
			[makeChannel({ status: "RUNNING", lastHeartbeat: HB_CONNECTED })],
		);
		store.dispatchLatch = { expected: 2, waiters: [] };
		const first = makeSweep(store);
		const second = makeSweep(store);
		const [a, b] = await Promise.all([
			first.sweep.dispatchPending(),
			second.sweep.dispatchPending(),
		]);
		expect(a + b).toBe(0);
		expect(store.rows[0]?.status).toBe("MISSED");
		const missed = [
			...(first.emitEvent.mock.calls as unknown as Array<[{ kind?: string }]>),
			...(second.emitEvent.mock.calls as unknown as Array<[{ kind?: string }]>),
		].filter(([event]) => event.kind === "SCHEDULE_MISSED");
		expect(missed).toHaveLength(1);
	});

	it("FEEDER_START: the lost feed comes back with the row's own source", async () => {
		const SOURCE = {
			credentialId: "00000000-0000-4000-8000-0000000000c1",
			bucket: "in",
			key: "program.mp4",
		};
		const store = makeStore(
			[
				makeRow({
					action: "FEEDER_START",
					feederSource: SOURCE,
					slateUntil: new Date(CRASH_AT + 60 * 60_000),
				}),
			],
			[makeChannel({ status: "RUNNING" })],
		);
		await killDuringHandoff(store);
		expect(store.rows[0]).toMatchObject({
			status: "FIRED",
			dispatchedAt: null,
		});

		const { sweep, enqueue } = makeSweep(store, {
			now: () => new Date(RECOVERY_AT),
		});
		expect((await sweep()).redispatched).toBe(1);
		expect(enqueue).toHaveBeenCalledWith(
			expect.objectContaining({
				liveChannelId: CH,
				action: "feeder-start",
				params: { scheduleId: ROW_ID, source: SOURCE },
			}),
			`sched-${ROW_ID}`,
		);
		expect(store.rows[0]?.dispatchedAt).toBeInstanceOf(Date);
	});

	it("the runtime cap: a kill after RUNNING→STOPPING still stops the encoding", async () => {
		const T0 = 10_000_000;
		const store = makeStore(
			[],
			[
				makeChannel({
					status: "RUNNING",
					maxRunMinutes: 60,
					runningSince: new Date(T0),
				}),
			],
		);
		let reachedAdd: () => void = () => undefined;
		const reached = new Promise<void>((resolve) => {
			reachedAdd = resolve;
		});
		const dying = makeSweep(store, {
			now: () => new Date(T0 + 61 * 60_000),
			enqueue: () => {
				reachedAdd();
				return new Promise<void>(() => undefined);
			},
		});
		void dying.sweep();
		await reached;
		// The wedge the audit named: channel STOPPING, epoch row written, no
		// job anywhere, and nothing that reads either again.
		expect(store.channels[0]).toMatchObject({ status: "STOPPING" });
		expect(store.rows[0]).toMatchObject({
			action: "STOP",
			status: "FIRED",
			note: "max-run-cap",
			dispatchedAt: null,
		});
		const capRowId = store.rows[0]?.id as string;

		const { sweep, enqueue } = makeSweep(store, {
			// The crash instant + 61s: past DISPATCH_GRACE_MS (2 × 30s).
			now: () => new Date(T0 + 61 * 60_000 + 61_000),
		});
		const stats = await sweep();
		expect(stats.redispatched).toBe(1);
		// No SECOND epoch row: the cap did not re-run, the outbox did.
		expect(stats.capStops).toBe(0);
		expect(store.rows).toHaveLength(1);
		expect(enqueue).toHaveBeenCalledWith(
			expect.objectContaining({ liveChannelId: CH, action: "stop" }),
			`sched-${capRowId}`,
		);
		expect(store.rows[0]?.dispatchedAt).toBeInstanceOf(Date);
	});

	it("a handoff that DID land is not run twice — the job id is derived, so BullMQ dedupes", async () => {
		const store = makeStore(
			[makeRow({ status: "FIRED", firedAt: new Date(1_900_000) })],
			[makeChannel({ status: "PROVISIONING" })],
		);
		const queue = dedupingQueue();
		const { sweep } = makeSweep(store, { enqueue: queue.add });
		expect(await sweep.dispatchPending()).toBe(1);
		expect(queue.added).toHaveLength(1);
		expect(store.rows[0]?.dispatchedAt).toBeInstanceOf(Date);

		// A stamped row leaves the scan entirely.
		expect(await sweep.dispatchPending()).toBe(0);
		expect(queue.added).toHaveLength(1);

		// And when the STAMP itself was the write that was lost, the re-add
		// resolves against the job already in the queue rather than running
		// the action a second time.
		const row = store.rows[0];
		if (row) {
			row.dispatchedAt = null;
			row.dispatchJobId = null;
		}
		expect(await sweep.dispatchPending()).toBe(1);
		expect(queue.added).toHaveLength(1);
		expect(queue.added[0]?.jobId).toBe(`sched-${ROW_ID}`);
		expect(store.rows[0]?.dispatchedAt).toBeInstanceOf(Date);
	});

	it("the BOOT pass recovers a stale row and leaves a fresh one to the tick", async () => {
		const stale = makeRow({
			id: "55555555-5555-4555-8555-555555555555",
			status: "FIRED",
			// 100s before now — past the 60s grace.
			firedAt: new Date(1_900_000),
		});
		const fresh = makeRow({
			id: "66666666-6666-4666-8666-666666666666",
			status: "FIRED",
			// 10s before now — INSIDE the grace: this is a healthy dispatch
			// whose stamp is still in flight, and re-adding it would be the
			// dispatcher racing the tick that owns it.
			firedAt: new Date(1_990_000),
		});
		const store = makeStore(
			[stale, fresh],
			[makeChannel({ status: "PROVISIONING" })],
		);
		const { sweep, enqueue } = makeSweep(store);
		expect(await sweep.dispatchPending()).toBe(1);
		expect(enqueue).toHaveBeenCalledTimes(1);
		expect(enqueue).toHaveBeenCalledWith(
			{ liveChannelId: CH, action: "provision" },
			`sched-${stale.id}`,
		);
		expect(store.rows[0]?.dispatchedAt).toBeInstanceOf(Date);
		expect(store.rows[1]?.dispatchedAt).toBeNull();
	});

	it("a notification failure does not stall the rows behind it", async () => {
		const first = makeRow({
			id: "77777777-7777-4777-8777-777777777777",
			status: "FIRED",
			firedAt: new Date(1_900_000),
		});
		const second = makeRow({
			id: "88888888-8888-4888-8888-888888888888",
			status: "FIRED",
			firedAt: new Date(1_901_000),
		});
		const store = makeStore(
			[first, second],
			[makeChannel({ status: "PROVISIONING" })],
		);
		const errorSpy = vi
			.spyOn(console, "error")
			.mockImplementation(() => undefined);
		try {
			const { sweep, enqueue, emitEvent } = makeSweep(store);
			emitEvent.mockRejectedValueOnce(new Error("notify queue down"));
			// Both recovered: a broken notify channel on the first row would
			// otherwise abort the pass before the second, every tick, while
			// whatever it was stopping kept billing.
			expect(await sweep.dispatchPending()).toBe(2);
			expect(enqueue).toHaveBeenCalledTimes(2);
			expect(store.rows[0]?.dispatchedAt).toBeInstanceOf(Date);
			expect(store.rows[1]?.dispatchedAt).toBeInstanceOf(Date);
		} finally {
			errorSpy.mockRestore();
		}
	});

	it("a re-dispatch that cannot be enqueued keeps the row recoverable (no re-arm)", async () => {
		const store = makeStore(
			[makeRow({ status: "FIRED", firedAt: new Date(1_900_000) })],
			[makeChannel({ status: "PROVISIONING" })],
		);
		const errorSpy = vi
			.spyOn(console, "error")
			.mockImplementation(() => undefined);
		try {
			const { sweep } = makeSweep(store, {
				enqueue: async () => {
					throw new Error("redis down");
				},
			});
			expect(await sweep.dispatchPending()).toBe(0);
			// Still FIRED and still unstamped: the claim was committed by a
			// process that is gone, so there is no channel state to hand back
			// — the next pass tries again.
			expect(store.rows[0]).toMatchObject({
				status: "FIRED",
				dispatchedAt: null,
			});
			expect(store.channels[0]).toMatchObject({ status: "PROVISIONING" });
		} finally {
			errorSpy.mockRestore();
		}
	});

	it("a healthy fire stamps the handoff, so the dispatcher never sees it", async () => {
		const store = makeStore([makeRow()], [makeChannel()]);
		const { sweep } = makeSweep(store);
		await sweep();
		expect(store.rows[0]).toMatchObject({
			status: "FIRED",
			dispatchJobId: `sched-${ROW_ID}`,
		});
		expect(store.rows[0]?.dispatchedAt).toBeInstanceOf(Date);
		// Even well past the grace, a stamped row is out of scope.
		const later = makeSweep(store, { now: () => new Date(9_000_000) });
		expect(await later.sweep.dispatchPending()).toBe(0);
		expect(later.enqueue).not.toHaveBeenCalled();
	});

	it("a re-armed row closes its outbox — the next firing is not read as already handed off", async () => {
		const store = makeStore([makeRow()], [makeChannel()]);
		const { sweep } = makeSweep(store, {
			enqueue: async () => {
				throw new Error("redis down");
			},
		});
		await sweep();
		expect(store.rows[0]).toMatchObject({
			status: "ARMED",
			firedAt: null,
			dispatchedAt: null,
			dispatchJobId: null,
		});
	});
});

/**
 *  (audit 2026-08-29 IMPORTANT-3). The due scan was
 * `orderBy fireAt asc, take 100`, and a row that is due but cannot fire yet
 * stays ARMED by design — so it keeps the oldest fireAt and re-occupies the
 * head of that window on every tick. A hundred of them on one channel and
 * no other channel is ever LOOKED AT again.
 *
 * The harness makes this visible only because `applyWindow` above honours
 * `orderBy`/`take`/cursor for real: against the old all-rows fake, the
 * pre-fix query returned everything and the defect was unreachable.
 */
describe("row #245 — the due scan cannot starve (paged, resuming cursor)", () => {
	const OTHER = "33333333-3333-4333-8333-333333333333";
	const VICTIM = "44444444-4444-4444-8444-444444444444";

	/** A STOP row: blocked on PROVISIONING, fires on RUNNING, no grace. */
	function stopRow(id: string, channelId: string, fireAtMs: number): Row {
		return makeRow({
			id,
			liveChannelId: channelId,
			action: "STOP",
			fireAt: new Date(fireAtMs),
		});
	}

	/** N due-but-blocked STOP rows on a PROVISIONING channel, oldest first. */
	function blocked(count: number, startMs = 1_000_000): Row[] {
		return Array.from({ length: count }, (_, i) =>
			// Padded so the id order matches the fireAt order — a cursor bug
			// that fell back on ids would otherwise be masked by luck.
			stopRow(
				`aaaaaaaa-0000-4000-8000-${String(i).padStart(12, "0")}`,
				CH,
				startMs + i,
			),
		);
	}

	it("a due row behind a full window of blocked rows fires THIS tick", async () => {
		// Exactly the old window: 100 rows that can never fire, all older than
		// the one that can. Under `take: 100` the victim is row 101 and is
		// never read; there is no tick, ever, on which it would be.
		const store = makeStore(
			[...blocked(100), stopRow(VICTIM, OTHER, 1_900_000)],
			[
				makeChannel({ status: "PROVISIONING" }),
				makeChannel({ id: OTHER, status: "RUNNING" }),
			],
		);
		const { sweep, enqueue } = makeSweep(store);
		const stats = await sweep();
		expect(stats.waiting).toBe(100);
		expect(stats.fired).toBe(1);
		expect(enqueue).toHaveBeenCalledWith(
			expect.objectContaining({ liveChannelId: OTHER, action: "stop" }),
			`sched-${VICTIM}`,
		);
		expect(store.channels[1]).toMatchObject({ status: "STOPPING" });
	});

	it("a backlog past the tick budget resumes on the NEXT tick instead of restarting", async () => {
		// Derived from the exported budget, not a copy of it: raise the budget
		// and this arm still describes "one more row than a tick can examine".
		const store = makeStore(
			[...blocked(DUE_SCAN_BUDGET), stopRow(VICTIM, OTHER, 1_900_000)],
			[
				makeChannel({ status: "PROVISIONING" }),
				makeChannel({ id: OTHER, status: "RUNNING" }),
			],
		);
		const { sweep, enqueue } = makeSweep(store);
		const first = await sweep();
		// Tick one spends the whole budget on the blocked head.
		expect(first.waiting).toBe(DUE_SCAN_BUDGET);
		expect(first.fired).toBe(0);
		const second = await sweep();
		// Tick two RESUMES past it — the victim is reached, once.
		expect(second.fired).toBe(1);
		expect(enqueue).toHaveBeenCalledTimes(1);
		expect(enqueue).toHaveBeenCalledWith(
			expect.objectContaining({ liveChannelId: OTHER, action: "stop" }),
			`sched-${VICTIM}`,
		);
	});

	it("rows examined and skipped are re-examined later, and fire once unblocked", async () => {
		// The other half of the guarantee: reaching the tail must RESET the
		// cursor, or a row that was passed over while blocked would never be
		// read again and would sit ARMED forever.
		//
		// One channel PER row on purpose: the first STOP to fire claims its
		// channel RUNNING→STOPPING, so three stops against ONE channel would
		// legitimately fire once and wait twice — an arm that could not tell
		// "the cursor reset" from "the claim was taken".
		const ids = [0, 1, 2].map(
			(i) => `cccccccc-0000-4000-8000-${String(i).padStart(12, "0")}`,
		);
		const store = makeStore(
			ids.map((id, i) => stopRow(`stop-${i}`, id, 1_000_000 + i)),
			ids.map((id) => makeChannel({ id, status: "PROVISIONING" })),
		);
		const { sweep, enqueue } = makeSweep(store);
		const first = await sweep();
		expect(first.waiting).toBe(3);
		expect(enqueue).not.toHaveBeenCalled();
		expect(store.rows.every((row) => row.status === "ARMED")).toBe(true);
		// The channels finish provisioning between ticks.
		for (const [index, channel] of store.channels.entries()) {
			channel.status = "RUNNING";
			channel.bitmovinEncodingId = "enc-current";
			store.runs.push({
				id: `dddddddd-4444-4444-8444-${String(index + 1).padStart(12, "0")}`,
				liveChannelId: channel.id,
				seq: 1,
				status: "RUNNING",
			});
		}
		const second = await sweep();
		expect(second.fired).toBe(3);
		expect(enqueue).toHaveBeenCalledTimes(3);
	});

	it("the ordinary case is unchanged: one due row, one due query, fires on tick one", async () => {
		// The timing pin. Paging must not cost the common case a tick or a
		// round trip — a SHORT page proves the tail without a second query.
		const store = makeStore(
			[makeRow({ action: "STOP" })],
			[makeChannel({ status: "RUNNING" })],
		);
		const { sweep, enqueue } = makeSweep(store);
		const stats = await sweep();
		expect(stats.fired).toBe(1);
		expect(enqueue).toHaveBeenCalledTimes(1);
		const dueQueries = store.prisma.liveSchedule.findMany.mock.calls.filter(
			(call) =>
				call[0]?.where?.fireAt !== undefined &&
				// : the pre-stage scan also carries a fireAt bound (its
				// window is fireAt ≤ now + max lead) — it is a different scan,
				// not a second due page, so the pin counts due queries only.
				!("stagedAt" in call[0].where),
		);
		expect(dueQueries).toHaveLength(1);
	});
});

describe("row #245 — bounded outbox recovery fairness", () => {
	it.each([
		["fire", 300],
		["fire", 301],
		["stage", 300],
		["stage", 301],
	] as const)("%s reaches all %i rows despite an outage, then recovers", async (kind, count) => {
		const rows = Array.from({ length: count }, (_, index) =>
			makeRow({
				id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
				// Equal timestamps demand the id tie-breaker; storage order is reversed.
				fireAt: new Date(kind === "stage" ? 3_000_000 : 1_000_000),
				status: kind === "stage" ? "ARMED" : "FIRED",
				action: kind === "stage" ? "FEEDER_SWITCH" : "START",
				firedAt: kind === "fire" ? new Date(1_900_000) : null,
				stagedAt: kind === "stage" ? new Date(1_900_000) : null,
				feederSource: {
					credentialId: "00000000-0000-4000-8000-0000000000c1",
					bucket: "in",
					key: "program.mp4",
					identity: { etag: '"abc"', size: 725_000_000 },
				},
			}),
		);
		const store = makeStore([...rows].reverse(), [
			makeChannel({ status: "PROVISIONING" }),
		]);
		const attempted = new Set<string>();
		let failing = true;
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const { sweep, enqueue } = makeSweep(store, {
				enqueue: async (_job, id) => {
					attempted.add(id);
					if (failing) throw new Error("persistent queue failure");
				},
			});
			for (let tick = 0; tick < 4; tick += 1) {
				const before = enqueue.mock.calls.length;
				expect(await sweep.dispatchPending()).toBe(0);
				expect(enqueue.mock.calls.length - before).toBeLessThanOrEqual(100);
			}
			expect(attempted.size).toBe(count);
			expect(
				rows.every(
					(row) => row.dispatchedAt === null && row.stageDispatchedAt === null,
				),
			).toBe(true);
			failing = false;
			let recovered = 0;
			for (let tick = 0; tick < 4; tick += 1)
				recovered += await sweep.dispatchPending();
			expect(recovered).toBe(count);
			expect(
				rows.every(
					(row) =>
						(kind === "fire"
							? row.dispatchedAt
							: row.stageDispatchedAt) instanceof Date,
				),
			).toBe(true);
			// Successful stamps evict the rows, and retries keep deterministic ids.
			expect(await sweep.dispatchPending()).toBe(0);
			expect(attempted.size).toBe(count);
		} finally {
			errorSpy.mockRestore();
		}
	});
	it("coalesces overlapping boot and tick recovery before advancing the cursor", async () => {
		const store = makeStore([
			makeRow({ status: "FIRED", firedAt: new Date(1_900_000) }),
		]);
		let release = () => {};
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { sweep, enqueue } = makeSweep(store, { enqueue: () => blocked });
		const first = sweep.dispatchPending();
		const second = sweep.dispatchPending();
		// Resolve even if the assertion fails, so the test leaks no pending pass.
		try {
			await vi.waitFor(() => expect(enqueue).toHaveBeenCalledTimes(1));
		} finally {
			release();
			await Promise.all([first, second]);
		}
		expect(enqueue).toHaveBeenCalledTimes(1);
		expect(await sweep.dispatchPending()).toBe(0);
	});
});

/**
 *  — the two-phase feeder switch (audit 2026-08-29 HIGH-3).
 *
 * The switch used to be one event at fireAt: stop the actives, create the
 * replacement, and let it download the whole source AFTER air time (paid run
 * #5: 29 s to PUSHING for 725 MB). Now the sweep hands a switch off twice —
 * the PRE-STAGE at fireAt − lead (download, probe, gate, then hold) and the
 * COMMIT at fireAt, for a READY session only. A switch that is not READY at
 * fireAt does not fire: the row lands MISSED, its outcome FAILED "not
 * staged", and the previous feed keeps pushing.
 */
describe("row #240 — the two-phase feeder switch", () => {
	const NOW = 2_000_000;
	const SESSION_ID = "00000000-0000-4000-8000-0000000000f1";
	/** The audit's 725 MB source, sealed — so the lead is size-derived. */
	const SEALED = {
		credentialId: "00000000-0000-4000-8000-0000000000c1",
		bucket: "in",
		key: "program.mp4",
		identity: { etag: '"abc"', size: 725_000_000 },
	};
	/** 120 s + 725 MB at 10 MB/s = 192.5 s (`stage-lead.test.ts`). */
	const LEAD_MS = 192_500;

	function switchRow(over: Partial<Row> = {}): Row {
		return makeRow({
			action: "FEEDER_SWITCH",
			feederSource: SEALED,
			slateUntil: new Date(NOW + 60 * 60_000),
			...over,
		});
	}

	it("stages a switch at fireAt − lead: the claim is stamped, the row stays ARMED, and the stage job carries the commit instant", async () => {
		// One second INSIDE the lead window.
		const fireAt = new Date(NOW + LEAD_MS - 1_000);
		const store = makeStore(
			[switchRow({ fireAt })],
			[makeChannel({ status: "RUNNING" })],
		);
		const { sweep, enqueue } = makeSweep(store);
		const stats = await sweep();
		expect(stats.staged).toBe(1);
		expect(stats.fired).toBe(0);
		expect(enqueue).toHaveBeenCalledTimes(1);
		expect(enqueue).toHaveBeenCalledWith(
			expect.objectContaining({
				liveChannelId: CH,
				action: "feeder-stage",
				params: {
					scheduleId: ROW_ID,
					source: SEALED,
					commitAt: fireAt.toISOString(),
				},
			}),
			// rev367 I-2: the id carries the CLAIM instant (this tick).
			`sched-${ROW_ID}:stage:${NOW}`,
		);
		expect(store.rows[0]).toMatchObject({
			status: "ARMED",
			stagedAt: new Date(NOW),
			stageDispatchedAt: new Date(NOW),
			firedAt: null,
		});
	});

	it("a switch OUTSIDE its lead is left alone — the lead is size-derived, not the maximum", async () => {
		// One second before the lead window opens.
		const store = makeStore(
			[switchRow({ fireAt: new Date(NOW + LEAD_MS + 1_000) })],
			[makeChannel({ status: "RUNNING" })],
		);
		const { sweep, enqueue } = makeSweep(store);
		const stats = await sweep();
		expect(stats.staged).toBe(0);
		expect(enqueue).not.toHaveBeenCalled();
		expect(store.rows[0]?.stagedAt).toBeNull();
	});

	it("a staged row is not staged twice, and does not fire while its fire time lies ahead", async () => {
		const store = makeStore(
			[
				switchRow({
					fireAt: new Date(NOW + 60_000),
					stagedAt: new Date(NOW - 30_000),
					stageDispatchedAt: new Date(NOW - 30_000),
				}),
			],
			[makeChannel({ status: "RUNNING" })],
		);
		const { sweep, enqueue } = makeSweep(store);
		await sweep();
		expect(enqueue).not.toHaveBeenCalled();
		expect(store.rows[0]?.status).toBe("ARMED");
	});

	it("the pre-stage waits for a RUNNING channel — the staged session needs the run's ingest reference", async () => {
		const store = makeStore(
			[switchRow({ fireAt: new Date(NOW + 60_000) })],
			[makeChannel({ status: "PROVISIONING" })],
		);
		const { sweep, enqueue } = makeSweep(store);
		await sweep();
		expect(enqueue).not.toHaveBeenCalled();
		expect(store.rows[0]?.stagedAt).toBeNull();
	});

	it("a stage enqueue failure releases the claim so the next tick can stage again", async () => {
		const store = makeStore(
			[switchRow({ fireAt: new Date(NOW + 60_000) })],
			[makeChannel({ status: "RUNNING" })],
		);
		const { sweep, enqueue } = makeSweep(store, {
			enqueue: async () => {
				throw new Error("redis down");
			},
		});
		const stats = await sweep();
		expect(enqueue).toHaveBeenCalledTimes(1);
		expect(stats.staged).toBe(0);
		expect(stats.errors).toBe(1);
		expect(store.rows[0]).toMatchObject({
			status: "ARMED",
			stagedAt: null,
			stageDispatchedAt: null,
		});
	});

	it("commits a READY session at fireAt: the row goes FIRED and feeder-commit names the session the sweep judged", async () => {
		const store = makeStore(
			[
				switchRow({
					fireAt: new Date(NOW - 10_000),
					stagedAt: new Date(NOW - 200_000),
					stageDispatchedAt: new Date(NOW - 200_000),
					feederSessionId: SESSION_ID,
				}),
			],
			[makeChannel({ status: "RUNNING" })],
			[
				{
					id: SESSION_ID,
					status: "DOWNLOADING",
					readyAt: new Date(NOW - 100_000),
					error: null,
				},
			],
		);
		const { sweep, enqueue, emitEvent } = makeSweep(store);
		const stats = await sweep();
		expect(stats.fired).toBe(1);
		expect(enqueue).toHaveBeenCalledTimes(1);
		expect(enqueue).toHaveBeenCalledWith(
			expect.objectContaining({
				liveChannelId: CH,
				action: "feeder-commit",
				params: { scheduleId: ROW_ID, feederSessionId: SESSION_ID },
			}),
			`sched-${ROW_ID}`,
		);
		expect(store.rows[0]).toMatchObject({
			status: "FIRED",
			firedAt: new Date(NOW),
			dispatchedAt: new Date(NOW),
		});
		expect(emitEvent).toHaveBeenCalledWith(
			expect.objectContaining({ kind: "SCHEDULE_FIRED", scheduleId: ROW_ID }),
		);
	});

	it("a session that is NOT ready at fireAt does not fire: MISSED, outcome FAILED 'not staged', and no job — the previous feed keeps pushing", async () => {
		const store = makeStore(
			[
				switchRow({
					fireAt: new Date(NOW - 10_000),
					stagedAt: new Date(NOW - 20_000),
					stageDispatchedAt: new Date(NOW - 20_000),
					feederSessionId: SESSION_ID,
				}),
			],
			[makeChannel({ status: "RUNNING" })],
			[
				// Still downloading: READY was never recorded.
				{ id: SESSION_ID, status: "DOWNLOADING", readyAt: null, error: null },
			],
		);
		const { sweep, enqueue, emitEvent } = makeSweep(store);
		const stats = await sweep();
		expect(stats.fired).toBe(0);
		expect(stats.missed).toBe(1);
		expect(enqueue).not.toHaveBeenCalled();
		expect(store.rows[0]).toMatchObject({
			status: "MISSED",
			firedAt: null,
			outcome: "FAILED",
		});
		expect(store.rows[0]?.note).toContain("not staged");
		expect(store.rows[0]?.note).toContain("has not finished downloading");
		expect(store.rows[0]?.outcomeNote).toContain("not staged");
		expect(emitEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: "SCHEDULE_MISSED",
				scheduleId: ROW_ID,
				reason: expect.stringContaining("previous feed keeps pushing"),
			}),
		);
	});

	it("a staged session that FAILED its gates is refused with the session's own error in the note", async () => {
		const store = makeStore(
			[
				switchRow({
					fireAt: new Date(NOW - 10_000),
					stagedAt: new Date(NOW - 200_000),
					stageDispatchedAt: new Date(NOW - 200_000),
					feederSessionId: SESSION_ID,
				}),
			],
			[makeChannel({ status: "RUNNING" })],
			[
				{
					id: SESSION_ID,
					status: "ERROR",
					readyAt: null,
					error: "Source does not match what this channel is ingesting",
				},
			],
		);
		const { sweep, enqueue } = makeSweep(store);
		await sweep();
		expect(enqueue).not.toHaveBeenCalled();
		expect(store.rows[0]?.status).toBe("MISSED");
		expect(store.rows[0]?.note).toContain("ERROR");
		expect(store.rows[0]?.note).toContain("does not match");
	});

	//  review: a staged session's error is now a STRUCTURED payload on
	// the row, and it flows into the MISSED note (verbatim in the panel) and the
	// SCHEDULE_MISSED Slack event. Both are locale-less, so the sweep renders the
	// ENGLISH sentence — never the `{code, params}` JSON.
	it("a STRUCTURED staged-session error becomes ENGLISH in the note and the SCHEDULE_MISSED event", async () => {
		const store = makeStore(
			[
				switchRow({
					fireAt: new Date(NOW - 10_000),
					stagedAt: new Date(NOW - 200_000),
					stageDispatchedAt: new Date(NOW - 200_000),
					feederSessionId: SESSION_ID,
				}),
			],
			[makeChannel({ status: "RUNNING" })],
			[
				{
					id: SESSION_ID,
					status: "ERROR",
					readyAt: null,
					error: feederError("sourceMismatch", {
						originKind: "runSource",
						differences: "frame rate 30000/1001 → 24/1",
					}),
				},
			],
		);
		const { sweep, emitEvent } = makeSweep(store);
		await sweep();
		expect(store.rows[0]?.status).toBe("MISSED");
		// Note (verbatim in the schedule panel): the English sentence + origin.
		expect(store.rows[0]?.note).toContain(
			"does not match what this channel is ingesting",
		);
		expect(store.rows[0]?.note).toContain("the source this run started on");
		expect(store.rows[0]?.note).not.toContain("sourceMismatch");
		expect(store.rows[0]?.outcomeNote).not.toContain("sourceMismatch");
		// SCHEDULE_MISSED (→ Slack): English reason, never the JSON payload.
		expect(emitEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: "SCHEDULE_MISSED",
				reason: expect.stringContaining(
					"does not match what this channel is ingesting",
				),
			}),
		);
		const missed = (
			emitEvent.mock.calls as unknown as ReadonlyArray<
				[{ kind: string; reason?: string }]
			>
		)
			.map((call) => call[0])
			.find((e) => e.kind === "SCHEDULE_MISSED");
		expect(missed?.reason).not.toContain("sourceMismatch");
	});

	it("a stage claim whose handoff was lost is re-added by the dispatcher under the stage id — and a healthy one is not", async () => {
		const LOST_ID = "22222222-2222-4222-8222-222222222223";
		const store = makeStore(
			[
				// Claimed 61 s ago, never handed off: the crash-between shape.
				switchRow({
					id: LOST_ID,
					fireAt: new Date(NOW + 120_000),
					stagedAt: new Date(NOW - 61_000),
					stageDispatchedAt: null,
				}),
				// Claimed and handed off: healthy.
				switchRow({
					fireAt: new Date(NOW + 120_000),
					stagedAt: new Date(NOW - 61_000),
					stageDispatchedAt: new Date(NOW - 61_000),
				}),
			],
			[makeChannel({ status: "RUNNING" })],
		);
		const { sweep, enqueue } = makeSweep(store);
		const stats = await sweep();
		expect(stats.redispatched).toBe(1);
		expect(enqueue).toHaveBeenCalledTimes(1);
		expect(enqueue).toHaveBeenCalledWith(
			{
				liveChannelId: CH,
				action: "feeder-stage",
				params: {
					scheduleId: LOST_ID,
					source: SEALED,
					commitAt: new Date(NOW + 120_000).toISOString(),
				},
			},
			// rev367 I-2: the SAME claim instant the row carries, so a handoff
			// that DID land dedupes.
			`sched-${LOST_ID}:stage:${NOW - 61_000}`,
		);
		expect(store.rows[0]?.stageDispatchedAt).toEqual(new Date(NOW));
		expect(store.rows[0]?.status).toBe("ARMED");
	});

	it("a FIRED switch whose COMMIT handoff was lost comes back as feeder-commit for the row's own session", async () => {
		const store = makeStore(
			[
				switchRow({
					status: "FIRED",
					fireAt: new Date(NOW - 120_000),
					firedAt: new Date(NOW - 61_000),
					dispatchedAt: null,
					stagedAt: new Date(NOW - 300_000),
					stageDispatchedAt: new Date(NOW - 300_000),
					feederSessionId: SESSION_ID,
				}),
			],
			[makeChannel({ status: "RUNNING" })],
		);
		const { sweep, enqueue } = makeSweep(store);
		const stats = await sweep();
		expect(stats.redispatched).toBe(1);
		expect(enqueue).toHaveBeenCalledWith(
			expect.objectContaining({
				liveChannelId: CH,
				action: "feeder-commit",
				params: { scheduleId: ROW_ID, feederSessionId: SESSION_ID },
			}),
			`sched-${ROW_ID}`,
		);
		expect(store.rows[0]?.dispatchedAt).toEqual(new Date(NOW));
	});

	it("the stage and the commit are two handoffs under two ids — a dedupe on the first must not swallow the second", async () => {
		const seen = new Set<string>();
		const store = makeStore(
			[switchRow({ fireAt: new Date(NOW + 60_000) })],
			[makeChannel({ status: "RUNNING" })],
			[
				{
					id: SESSION_ID,
					status: "DOWNLOADING",
					readyAt: new Date(NOW),
					error: null,
				},
			],
		);
		const { sweep, enqueue } = makeSweep(store, {
			enqueue: async (_job, jobId) => {
				seen.add(jobId);
			},
		});
		await sweep();
		// The stage action stamps the session onto the row; the fake stands
		// in for it, then the clock reaches fireAt.
		const row = store.rows[0] as Row;
		row.feederSessionId = SESSION_ID;
		const { sweep: later } = makeSweep(store, {
			now: () => new Date(NOW + 61_000),
			enqueue: async (_job, jobId) => {
				seen.add(jobId);
			},
		});
		await later();
		expect(enqueue).toHaveBeenCalledTimes(1);
		expect(store.rows[0]?.status).toBe("FIRED");
		expect([...seen].sort()).toEqual(
			[`sched-${ROW_ID}`, `sched-${ROW_ID}:stage:${NOW}`].sort(),
		);
	});

	it("a stage whose JOB DIED is staged again under a NEW id — the dead job's id cannot swallow the retry (rev367 I-2)", async () => {
		// liveChannel jobs are KEPT on failure (removeOnFail: 1000), and
		// BullMQ's jobId dedupe consults the failed set too: a re-add under
		// the dead job's own id returns it and queues NOTHING — so a released
		// claim's retry was a permanent no-op, refused at fireAt as "the
		// pre-stage job has not created a session yet". The claim instant in
		// the id is what makes the retry a genuinely new job.
		const seen = new Set<string>();
		const added: string[] = [];
		const dedupingEnqueue = async (_job: unknown, jobId: string) => {
			if (seen.has(jobId)) {
				return;
			}
			seen.add(jobId);
			added.push(jobId);
		};
		const store = makeStore(
			[switchRow({ fireAt: new Date(NOW + 120_000) })],
			[makeChannel({ status: "RUNNING" })],
		);
		const { sweep } = makeSweep(store, { enqueue: dedupingEnqueue });
		await sweep();
		expect(added).toEqual([`sched-${ROW_ID}:stage:${NOW}`]);
		// The stage job dies out-of-process; the failed handler releases the
		// claim (nothing was created — feederSessionId is still null).
		await releaseDeadStageClaim(store.prisma as unknown as AppPrismaClient, {
			data: {
				liveChannelId: CH,
				action: "feeder-stage",
				params: { scheduleId: ROW_ID },
			},
		});
		expect(store.rows[0]).toMatchObject({
			stagedAt: null,
			stageDispatchedAt: null,
		});
		// The next tick stages again — and its add RUNS.
		const { sweep: later } = makeSweep(store, {
			now: () => new Date(NOW + 30_000),
			enqueue: dedupingEnqueue,
		});
		const stats = await later();
		expect(stats.staged).toBe(1);
		expect(added).toEqual([
			`sched-${ROW_ID}:stage:${NOW}`,
			`sched-${ROW_ID}:stage:${NOW + 30_000}`,
		]);
	});

	it("a stage claim stranded PAST its fire time is not recovered — the due scan refuses the row instead (rev367 I-3)", async () => {
		// The dispatcher runs BEFORE the due scan: re-adding this claim would
		// download a whole source for a switch that can no longer happen, and
		// the late stage would then overwrite the MISSED row's story.
		const store = makeStore(
			[
				switchRow({
					fireAt: new Date(NOW - 10_000),
					stagedAt: new Date(NOW - 90_000),
					stageDispatchedAt: null,
				}),
			],
			[makeChannel({ status: "RUNNING" })],
		);
		const { sweep, enqueue } = makeSweep(store);
		const stats = await sweep();
		expect(stats.redispatched).toBe(0);
		expect(enqueue).not.toHaveBeenCalledWith(
			expect.objectContaining({ action: "feeder-stage" }),
			expect.anything(),
		);
		expect(store.rows[0]).toMatchObject({
			status: "MISSED",
			outcome: "FAILED",
		});
		expect(store.rows[0]?.note).toContain("not staged");
	});

	it("a switch already past its fire time is never staged — refusing it is the due scan's job (rev367 I-3)", async () => {
		const store = makeStore(
			[switchRow({ fireAt: new Date(NOW - 10_000) })],
			[makeChannel({ status: "RUNNING" })],
		);
		const { sweep, enqueue } = makeSweep(store);
		const stats = await sweep();
		expect(stats.staged).toBe(0);
		expect(enqueue).not.toHaveBeenCalled();
		expect(store.rows[0]).toMatchObject({ status: "MISSED", stagedAt: null });
		expect(store.rows[0]?.note).toContain("no pre-stage ran");
	});
});

/**
 * , the registration half. `registerPendingSlates` read `take: 20`
 * ARMED SLATE_IN rows and skipped any whose channel was not RUNNING WITHOUT
 * changing the row — the identical starving head, one pass over.
 */
describe("row #245 — the registration scan cannot starve", () => {
	const OTHER = "55555555-5555-4555-8555-555555555555";
	const VICTIM = "66666666-6666-4666-8666-666666666666";
	const SOURCE = {
		credentialId: "77777777-7777-4777-8777-777777777777",
		bucket: "slates",
		key: "bumper.mp4",
	};

	/** Registration runs AHEAD of fireAt, so these are deliberately future. */
	function pending(id: string, channelId: string, fireAtMs: number): Row {
		return makeRow({
			id,
			liveChannelId: channelId,
			action: "SLATE_IN",
			fireAt: new Date(fireAtMs),
			slateSource: SOURCE,
			slateUntil: new Date(fireAtMs + 60_000),
		});
	}

	it("a registrable row behind a full window of unregistrable ones is still claimed", async () => {
		const store = makeStore(
			[
				...Array.from({ length: 20 }, (_, i) =>
					pending(
						`bbbbbbbb-0000-4000-8000-${String(i).padStart(12, "0")}`,
						CH,
						3_000_000 + i,
					),
				),
				pending(VICTIM, OTHER, 3_900_000),
			],
			[
				// Not RUNNING: registration needs an encoding, so all twenty are
				// skipped untouched and hold the head of the window.
				makeChannel({ status: "PROVISIONING" }),
				makeChannel({ id: OTHER, status: "RUNNING" }),
			],
		);
		const { sweep, enqueue } = makeSweep(store);
		await sweep();
		const registrations = enqueue.mock.calls.filter(
			(call) =>
				(call[0] as { action?: string })?.action === "register-slate-content",
		);
		expect(registrations).toHaveLength(1);
		expect(registrations[0]?.[0]).toMatchObject({
			liveChannelId: OTHER,
			action: "register-slate-content",
		});
		expect(
			store.rows.find((row) => row.id === VICTIM)?.contentClaimedAt,
		).toBeInstanceOf(Date);
	});
});
/**
 * , review #356 v2 (CRITICAL). `pageScan` advances its cursor past a
 * row BEFORE running the handler, and it must — the handler normally moves
 * the row out of the scan. The exception is a RE-ARM: the row goes back to
 * ARMED at its own fireAt, behind the cursor.
 *
 * The first rework rewound the cursor for it, alternating so an outage could
 * not pin the scan on the head. That was the wrong shape, and the reason is
 * worth keeping: rewinding spends TICKS, which is the resource forward
 * progress needs, so under SUSTAINED re-arming the scan cycled between its
 * first two windows forever. These arms pin both halves — the one-shot case
 * retried next tick, and the sustained case still walking to the tail.
 */
describe("row #245 review #356 v2 — re-examination never costs the forward scan a tick", () => {
	const BLOCKED = "77777777-0000-4000-8000-000000000001";
	const VICTIM_CH = "77777777-0000-4000-8000-000000000002";
	const VICTIM = "88888888-0000-4000-8000-000000000000";

	function stop(id: string, channelId: string, fireAtMs: number): Row {
		return makeRow({
			id,
			liveChannelId: channelId,
			action: "STOP",
			fireAt: new Date(fireAtMs),
		});
	}

	function backlog(count: number, offsetMs: number): Row[] {
		return Array.from({ length: count }, (_, i) =>
			stop(
				`dddddddd-${String(offsetMs).padStart(4, "0")}-4000-8000-${String(i).padStart(12, "0")}`,
				BLOCKED,
				offsetMs + i,
			),
		);
	}

	/** N STOP rows, each on its OWN RUNNING channel, so every one can fire. */
	function ownChannelRows(count: number, prefix: string) {
		const rows: Row[] = [];
		const channels: Channel[] = [];
		for (let i = 0; i < count; i++) {
			const channelId = `${prefix}-0000-4000-8000-${String(i).padStart(12, "0")}`;
			rows.push(
				stop(
					`${prefix}-1111-4000-8000-${String(i).padStart(12, "0")}`,
					channelId,
					1_000_000 + i,
				),
			);
			channels.push(makeChannel({ id: channelId, status: "RUNNING" }));
		}
		return { rows, channels };
	}

	it("M7: a one-shot enqueue failure inside a 1011-row backlog retries on tick 2", async () => {
		const store = makeStore(
			[
				...backlog(10, 1_000_000),
				stop(VICTIM, VICTIM_CH, 1_100_000),
				...backlog(1000, 1_200_000),
			],
			[
				makeChannel({ id: BLOCKED, status: "PROVISIONING" }),
				makeChannel({ id: VICTIM_CH, status: "RUNNING" }),
			],
		);
		let thrown = false;
		const { sweep } = makeSweep(store, {
			enqueue: async (_job, dedupeId) => {
				// Once, and only for the victim: a Redis blip, not an outage.
				if (dedupeId === `sched-${VICTIM}` && !thrown) {
					thrown = true;
					throw new Error("redis blip");
				}
			},
		});
		let firedOnTick = 0;
		for (let tick = 1; tick <= 8 && firedOnTick === 0; tick++) {
			await sweep();
			if (store.rows.find((row) => row.id === VICTIM)?.dispatchedAt) {
				firedOnTick = tick;
			}
		}
		expect(thrown).toBe(true);
		// Two, not four: the id rode the next tick's query instead of waiting
		// for the cursor's lap.
		expect(firedOnTick).toBe(2);
	});

	it("v2: a SUSTAINED outage over 3x the budget still reaches the tail in ceil(rows/budget) ticks", async () => {
		/**
		 * The reviewer's proof world, and the one the alternating rework
		 * failed: 1500 rows, one channel each, EVERY enqueue throwing. The
		 * cursor must keep walking while re-arms are replayed beside it.
		 */
		const total = DUE_SCAN_BUDGET * 3;
		const { rows, channels } = ownChannelRows(total, "eeeeeeee");
		const store = makeStore(rows, channels);
		const attempted = new Set<string>();
		let down = true;
		const { sweep } = makeSweep(store, {
			enqueue: async (_job, dedupeId) => {
				attempted.add(dedupeId);
				if (down) {
					throw new Error("redis is down");
				}
			},
		});
		const tail = rows[rows.length - 1] as Row;
		let tailOnTick = 0;
		let allOnTick = 0;
		for (let tick = 1; tick <= 8; tick++) {
			await sweep();
			if (tailOnTick === 0 && attempted.has(`sched-${tail.id}`)) {
				tailOnTick = tick;
			}
			if (allOnTick === 0 && attempted.size === total) {
				allOnTick = tick;
			}
			if (allOnTick !== 0) {
				break;
			}
		}
		// ceil(1500/500) = 3, with no penalty for the fact that every single
		// row re-armed on every single tick.
		expect(tailOnTick).toBe(3);
		expect(allOnTick).toBe(3);
		// And recovery: the outage lifts and every row is FIRED within
		// ceil(rows/budget) more ticks — the replayed ids on the first tick,
		// the rest as the cursor laps. Measured, not assumed: 3 for 1500 rows
		// at a 500 budget, which is the SAME lap bound the scan has with no
		// outage at all. Re-arming 1500 rows three times over costs the
		// recovery nothing.
		down = false;
		let recoveryTicks = 0;
		for (let tick = 1; tick <= 8; tick++) {
			await sweep();
			if (store.rows.every((row) => row.dispatchedAt !== null)) {
				recoveryTicks = tick;
				break;
			}
		}
		expect(recoveryTicks).toBe(Math.ceil(total / DUE_SCAN_BUDGET));
		expect(store.rows.filter((row) => row.status === "ARMED")).toHaveLength(0);
		// 1,500 rows × 3 ticks of a fully-throwing enqueue is CPU work, not waiting:
		// 7.6 s at load average 47 on 2026-09-02 (two gate runs red for it) against
		// vitest's 5 s default. The ceiling is the machine under parallel gates — the
		// same lesson as apps/web's asyncUtilTimeout (2026-08-29).
		// (WP-G G-2 measured the same arm at 7.3 s under the worker suite's load and
		// asked for 30 s; main's 60 s is the larger budget and is kept.)
	}, 60_000);

	it("a queue outage inside the 2x-budget zone reaches the tail on tick 2", async () => {
		// The 600-row arm from the first rework, kept: it is the smaller world
		// where the tail sits inside one replay-plus-budget allowance.
		const CH_ONE = "99999999-0000-4000-8000-000000000001";
		const rows = Array.from({ length: DUE_SCAN_BUDGET + 100 }, (_, i) =>
			stop(
				`ffffffff-0000-4000-8000-${String(i).padStart(12, "0")}`,
				CH_ONE,
				1_000_000 + i,
			),
		);
		const tail = rows[rows.length - 1] as Row;
		const store = makeStore(rows, [
			makeChannel({ id: CH_ONE, status: "RUNNING" }),
		]);
		const attempted: string[] = [];
		const { sweep } = makeSweep(store, {
			enqueue: async (_job, dedupeId) => {
				attempted.push(dedupeId);
				throw new Error("redis is down");
			},
		});
		let reachedOnTick = 0;
		for (let tick = 1; tick <= 6 && reachedOnTick === 0; tick++) {
			await sweep();
			if (attempted.includes(`sched-${tail.id}`)) {
				reachedOnTick = tick;
			}
		}
		expect(reachedOnTick).toBe(2);
	});

	it("overflow: the OLDEST re-arms keep the fast path, the drops are counted, and a dropped row still fires on the next lap", async () => {
		/**
		 * A tick can produce more re-arms than the cap (its allowance is
		 * budget + replay), so the queue must choose. It keeps the ids that
		 * have waited longest and drops the newcomers — a dropped id is still
		 * ARMED and is examined when the cursor's lap reaches it, which is the
		 * pre-replay behaviour and never worse.
		 */
		const total = REARM_REPLAY_CAP * 2 + 200;
		const { rows, channels } = ownChannelRows(total, "aaaabbbb");
		const store = makeStore(rows, channels);
		let down = true;
		const { sweep } = makeSweep(store, {
			enqueue: async () => {
				if (down) {
					throw new Error("redis is down");
				}
			},
		});
		// Tick 1 examines a budget's worth and re-arms every one: exactly the
		// cap, nothing dropped yet.
		const first = await sweep();
		expect(first.rearmsDropped).toBe(0);
		// Tick 2's allowance is budget + cap, so it re-arms twice the cap and
		// the queue must refuse half of them.
		const second = await sweep();
		expect(second.rearmsDropped).toBe(REARM_REPLAY_CAP);
		// Oldest-wins: the ids still owed a replay are the FIRST ones armed.
		const owed = rows.slice(0, REARM_REPLAY_CAP).map((row) => row.id);
		const dropped = rows[REARM_REPLAY_CAP + 10] as Row;
		expect(owed).not.toContain(dropped.id);
		// The dropped row is not lost: the outage lifts and the cursor's lap
		// reaches it.
		down = false;
		let firedOnTick = 0;
		for (let tick = 1; tick <= 8 && firedOnTick === 0; tick++) {
			await sweep();
			if (store.rows.find((row) => row.id === dropped.id)?.dispatchedAt) {
				firedOnTick = tick;
			}
		}
		expect(firedOnTick).toBeGreaterThan(0);
	});

	it("the where-clause SHAPE: the replay term rides an AND element, never a second OR key", async () => {
		/**
		 * A structural assertion, because the store fake would happily accept
		 * a clobbered clause. Two `OR:` keys cannot coexist in one Prisma
		 * object literal — the later one REPLACES the earlier with no error —
		 * and the registration scan already spends its top-level `OR` on claim
		 * staleness. So the cursor-plus-replay window must arrive as its own
		 * `AND` element, and the staleness `OR` must survive beside it.
		 */
		const source = {
			credentialId: "00000000-0000-4000-8000-0000000000f1",
			bucket: "slates",
			key: "bumper.mp4",
		};
		const CH_B = "cccc0000-0000-4000-8000-000000000002";
		// BOTH scans need a cursor that survives tick one, or `scanWindow`
		// returns {} and the collision this arm exists for is never composed.
		// The registration scan's own budget is the threshold for its half.
		const { rows, channels } = ownChannelRows(DUE_SCAN_BUDGET + 50, "bbbbcccc");
		const slates = Array.from(
			{ length: REGISTRATION_SCAN_BUDGET + 20 },
			(_, i) =>
				makeRow({
					id: `cccc1111-0000-4000-8000-${String(i).padStart(12, "0")}`,
					liveChannelId: CH_B,
					action: "SLATE_IN",
					// Future: registration runs AHEAD of fireAt, and this keeps
					// them out of the due scan entirely.
					fireAt: new Date(9_000_000 + i),
					slateSource: source,
					slateUntil: new Date(9_600_000 + i),
				}),
		);
		const store = makeStore(
			[...rows, ...slates],
			// PROVISIONING: registration needs RUNNING, so every slate row is
			// skipped untouched and the scan keeps a live cursor.
			[...channels, makeChannel({ id: CH_B, status: "PROVISIONING" })],
		);
		const { sweep } = makeSweep(store, {
			enqueue: async () => {
				throw new Error("redis is down");
			},
		});
		await sweep();
		await sweep();
		const calls = store.prisma.liveSchedule.findMany.mock.calls.map(
			(call) => call[0],
		);
		const dueCalls = calls.filter((call) => call?.where?.fireAt !== undefined);
		const registrationCalls = calls.filter(
			(call) =>
				call?.where?.fireAt === undefined && call?.where?.action === "SLATE_IN",
		);
		expect(dueCalls.length).toBeGreaterThan(0);
		expect(registrationCalls.length).toBeGreaterThan(0);
		// The registration scan: BOTH survive — its own staleness OR at the
		// top level, and the window nested under AND.
		for (const call of registrationCalls) {
			// The staleness OR, intact. A bare `OR:` key from the window would
			// have REPLACED it silently — no error, no failing query, just a
			// scan that stopped reaping stale claims.
			expect(call?.where?.OR).toHaveLength(2);
			expect(call?.where?.OR?.[0]).toHaveProperty("contentClaimedAt");
			expect(call?.where?.OR?.[1]).toHaveProperty("contentClaimedAt");
		}
		const registrationWindowed = registrationCalls.filter(
			(call) => call?.where?.AND !== undefined,
		);
		expect(registrationWindowed.length).toBeGreaterThan(0);
		for (const call of registrationWindowed) {
			expect(call?.where?.AND).toHaveLength(1);
			expect(Array.isArray(call?.where?.AND?.[0]?.OR)).toBe(true);
		}
		// The due scan: the window is an AND element; there is NO bare top
		// level `OR` for it to have collided with.
		const windowed = dueCalls.filter((call) => call?.where?.AND !== undefined);
		expect(windowed.length).toBeGreaterThan(0);
		for (const call of windowed) {
			expect(call?.where?.AND).toHaveLength(1);
			expect(Array.isArray(call?.where?.AND?.[0]?.OR)).toBe(true);
			expect(call?.where).not.toHaveProperty("OR");
		}
		// A tick with re-arms owed carries the third disjunct.
		const withReplay = windowed.filter(
			(call) => (call?.where?.AND?.[0]?.OR ?? []).length === 3,
		);
		expect(withReplay.length).toBeGreaterThan(0);
	});
});

/**
 *  (audit 2026-08-29 HIGH-4) — a schedule row bound only to the
 * CHANNEL outlives the airing it was armed for. After a re-air, an old STOP
 * could take the new programme off the air, a slate could name an
 * insertable-content id that died with the previous encoding, and a feeder
 * could push the previous airing's filler over the new run.
 */
describe("generation bind — a row fires only into the airing it was armed for (row #241)", () => {
	const RUN_1 = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
	const RUN_2 = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
	const FEED = {
		credentialId: "00000000-0000-4000-8000-0000000000c1",
		bucket: "in",
		key: "slate.mp4",
	};

	/** A store whose channel is RUNNING on `runs`, newest last (seq order). */
	function runningOn(
		rows: Row[],
		runIds: string[],
		channel: Partial<Channel> = {},
	) {
		const store = makeStore(rows, [
			makeChannel({
				status: "RUNNING",
				lastHeartbeat: HB_CONNECTED,
				...channel,
			}),
		]);
		store.runs.push(
			...runIds.map((id, index) => ({
				id,
				seq: index + 1,
				status: "RUNNING",
				outputPrefix: "",
				bitmovinEncodingId: "enc-current",
				lastHeartbeat: HB_CONNECTED,
			})),
		);
		return store;
	}

	it("STOP armed for run 1 is REFUSED once the channel is on run 2 — never a live programme taken off the air", async () => {
		const store = runningOn(
			[makeRow({ action: "STOP", liveChannelRunId: RUN_1 })],
			[RUN_1, RUN_2],
		);
		const { sweep, enqueue, emitEvent } = makeSweep(store);
		const stats = await sweep();
		expect(store.rows[0]?.status).toBe("SKIPPED_STALE_GENERATION");
		expect(stats.skippedStale).toBe(1);
		expect(stats.fired).toBe(0);
		// No dispatch, and the channel is untouched — the claim never happened.
		expect(enqueue).not.toHaveBeenCalled();
		expect(store.channels[0]?.status).toBe("RUNNING");
		// BOTH run ids in the note: that is what makes the refusal auditable.
		expect(store.rows[0]?.note).toContain(RUN_1);
		expect(store.rows[0]?.note).toContain(RUN_2);
		expect(store.rows[0]).toMatchObject({
			outcome: "FAILED",
			outcomeEvidenceVersion: 1,
			outcomeEvidenceKind: "STALE_GENERATION_REFUSAL",
		});
		const staleWrites = store.prisma.liveSchedule.updateMany.mock.calls.filter(
			(call) => call[0]?.data?.status === "SKIPPED_STALE_GENERATION",
		);
		expect(staleWrites).toHaveLength(1);
		expect(staleWrites[0]?.[0]?.data).toMatchObject({
			status: "SKIPPED_STALE_GENERATION",
			outcome: "FAILED",
			outcomeEvidenceKind: "STALE_GENERATION_REFUSAL",
		});
		expect(emitEvent).toHaveBeenCalledWith(
			expect.objectContaining({ kind: "SCHEDULE_MISSED" }),
		);
	});

	it("SLATE_IN armed for run 1 is REFUSED on run 2 — its content id died with the old encoding", async () => {
		const store = runningOn(
			[
				makeRow({
					action: "SLATE_IN",
					liveChannelRunId: RUN_1,
					insertableContentId: CONTENT_ID,
					slateDurationSeconds: 30,
				}),
			],
			[RUN_1, RUN_2],
		);
		const { sweep, enqueue } = makeSweep(store);
		await sweep();
		expect(store.rows[0]?.status).toBe("SKIPPED_STALE_GENERATION");
		expect(enqueue).not.toHaveBeenCalled();
	});

	it("FEEDER_START armed for run 1 is REFUSED on run 2 — the audit's own case", async () => {
		const store = runningOn(
			[
				makeRow({
					action: "FEEDER_START",
					liveChannelRunId: RUN_1,
					feederSource: FEED,
					slateUntil: new Date(2_000_000 + 20 * 60_000),
				}),
			],
			[RUN_1, RUN_2],
		);
		const { sweep, enqueue } = makeSweep(store);
		await sweep();
		expect(store.rows[0]?.status).toBe("SKIPPED_STALE_GENERATION");
		expect(enqueue).not.toHaveBeenCalled();
	});

	it("a row armed for the CURRENT run fires exactly as before", async () => {
		const store = runningOn(
			[makeRow({ action: "STOP", liveChannelRunId: RUN_2 })],
			[RUN_1, RUN_2],
		);
		const { sweep, enqueue } = makeSweep(store);
		const stats = await sweep();
		expect(stats.skippedStale).toBe(0);
		expect(stats.fired).toBe(1);
		expect(store.rows[0]?.status).toBe("FIRED");
		expect(enqueue).toHaveBeenCalledWith(
			// (row 266): the bound airing now rides the
			// payload so the processor can fence a queue retry after a re-air.
			expect.objectContaining({
				liveChannelId: CH,
				action: "stop",
				plannedLiveChannelRunId: RUN_2,
				effect: expect.objectContaining({ action: "STOP" }),
			}),
			`sched-${ROW_ID}`,
		);
	});

	it("the fired feeder payload CARRIES the planned run id — the fence the processor needs against a queue retry", async () => {
		const store = runningOn(
			[
				makeRow({
					action: "FEEDER_START",
					liveChannelRunId: RUN_2,
					feederSource: FEED,
					slateUntil: new Date(2_000_000 + 20 * 60_000),
				}),
			],
			[RUN_1, RUN_2],
		);
		const { sweep, enqueue } = makeSweep(store);
		await sweep();
		// The processor cannot fence a stale queue retry without WHICH airing
		// the job was for — so the sweep must stamp it. Dropping the stamp in
		// `fireFeeder` drops this key and this arm goes red.
		expect(enqueue).toHaveBeenCalledWith(
			expect.objectContaining({
				action: "feeder-start",
				plannedLiveChannelRunId: RUN_2,
			}),
			`sched-${ROW_ID}`,
		);
	});

	it("the fired SLATE (insert-content) payload CARRIES the planned run id", async () => {
		// No runs pushed: the slate's run-level ingest check falls back to the
		// channel heartbeat and the generation guard fails open — the row is
		// still BOUND to RUN_2, which is what the payload must carry. Dropping
		// the stamp in `fireSlate` drops this key and turns this arm red.
		const store = runningOn(
			[
				makeRow({
					action: "SLATE_IN",
					liveChannelRunId: RUN_2,
					insertableContentId: CONTENT_ID,
					slateDurationSeconds: 300,
				}),
			],
			[RUN_2],
		);
		const { sweep, enqueue } = makeSweep(store);
		await sweep();
		expect(enqueue).toHaveBeenCalledWith(
			expect.objectContaining({
				action: "insert-content",
				plannedLiveChannelRunId: RUN_2,
			}),
			`sched-${ROW_ID}`,
		);
	});

	it("the STAGED feeder-switch payload CARRIES the planned run id", async () => {
		const SEALED = {
			credentialId: "00000000-0000-4000-8000-0000000000c1",
			bucket: "in",
			key: "program.mp4",
			identity: { etag: '"abc"', size: 725_000_000 },
		};
		const LEAD_MS = 192_500; // 120s + 725MB @ 10MB/s (stage-lead.test.ts)
		const store = runningOn(
			[
				makeRow({
					action: "FEEDER_SWITCH",
					liveChannelRunId: RUN_2,
					feederSource: SEALED,
					slateUntil: new Date(2_000_000 + 60 * 60_000),
					// One second INSIDE the size-derived lead window.
					fireAt: new Date(2_000_000 + LEAD_MS - 1_000),
				}),
			],
			[RUN_1, RUN_2],
		);
		const { sweep, enqueue } = makeSweep(store);
		const stats = await sweep();
		expect(stats.staged).toBe(1);
		expect(enqueue).toHaveBeenCalledWith(
			expect.objectContaining({
				action: "feeder-stage",
				plannedLiveChannelRunId: RUN_2,
			}),
			expect.stringContaining(`sched-${ROW_ID}:stage:`),
		);
	});

	it("the COMMITTED feeder-switch payload CARRIES the planned run id", async () => {
		const SESSION_ID = "00000000-0000-4000-8000-0000000000f1";
		const SEALED = {
			credentialId: "00000000-0000-4000-8000-0000000000c1",
			bucket: "in",
			key: "program.mp4",
			identity: { etag: '"abc"', size: 725_000_000 },
		};
		const store = makeStore(
			[
				makeRow({
					action: "FEEDER_SWITCH",
					liveChannelRunId: RUN_2,
					feederSource: SEALED,
					slateUntil: new Date(2_000_000 + 60 * 60_000),
					fireAt: new Date(2_000_000 - 10_000), // due
					stagedAt: new Date(2_000_000 - 200_000),
					stageDispatchedAt: new Date(2_000_000 - 200_000),
					feederSessionId: SESSION_ID,
				}),
			],
			[makeChannel({ status: "RUNNING", lastHeartbeat: HB_CONNECTED })],
			[
				{
					id: SESSION_ID,
					status: "DOWNLOADING",
					readyAt: new Date(2_000_000 - 100_000),
					error: null,
				},
			],
		);
		store.runs.push(
			{ id: RUN_1, seq: 1, status: "RUNNING", outputPrefix: "" },
			{ id: RUN_2, seq: 2, status: "RUNNING", outputPrefix: "" },
		);
		const { sweep, enqueue } = makeSweep(store);
		const stats = await sweep();
		expect(stats.fired).toBe(1);
		expect(enqueue).toHaveBeenCalledWith(
			expect.objectContaining({
				action: "feeder-commit",
				plannedLiveChannelRunId: RUN_2,
			}),
			`sched-${ROW_ID}`,
		);
	});

	it("a pre-air row with NO bind FIRES on the first run and is BOUND to it", async () => {
		// The creation-time shape: the row was written inside the channel's own
		// create transaction, before any run existed.
		const store = runningOn(
			[
				makeRow({
					action: "FEEDER_START",
					liveChannelRunId: null,
					feederSource: FEED,
					slateUntil: new Date(2_000_000 + 20 * 60_000),
				}),
			],
			[RUN_1],
		);
		const { sweep, enqueue } = makeSweep(store);
		await sweep();
		expect(store.rows[0]?.status).toBe("FIRED");
		expect(store.rows[0]?.liveChannelRunId).toBe(RUN_1);
		expect(enqueue).toHaveBeenCalledWith(
			expect.objectContaining({ action: "feeder-start" }),
			`sched-${ROW_ID}`,
		);
	});

	it("an unbound row on a RE-AIRED channel binds to the CURRENT run and fires — never refused for the airing it belongs to", async () => {
		// The direction a bind written in the START path would get WRONG: a
		// creation-time row nailed to run 1 at provisioning time would refuse
		// its own programme after the channel errored and was re-aired.
		const store = runningOn(
			[makeRow({ action: "STOP", liveChannelRunId: null })],
			[RUN_1, RUN_2],
		);
		const { sweep, enqueue } = makeSweep(store);
		await sweep();
		expect(store.rows[0]?.status).toBe("FIRED");
		expect(store.rows[0]?.liveChannelRunId).toBe(RUN_2);
		expect(enqueue).toHaveBeenCalledTimes(1);
	});

	it("a START row is NOT gated — a scheduled re-air still fires against a newer run", async () => {
		// Deliberate exclusion: START CREATES a generation. Gating it would
		// drop a scheduled broadcast because an unrelated run happened first.
		const store = makeStore(
			[makeRow({ action: "START", liveChannelRunId: RUN_1 })],
			[makeChannel({ status: "CREATED" })],
		);
		store.runs.push(
			{ id: RUN_1, seq: 1, status: "STOPPED", outputPrefix: "" },
			{ id: RUN_2, seq: 2, status: "STOPPED", outputPrefix: "" },
		);
		const { sweep, enqueue } = makeSweep(store);
		const stats = await sweep();
		expect(stats.skippedStale).toBe(0);
		expect(store.rows[0]?.status).toBe("FIRED");
		expect(enqueue).toHaveBeenCalledWith(
			{ liveChannelId: CH, action: "provision" },
			`sched-${ROW_ID}`,
		);
	});

	it("a bound legacy row with no current run fails closed instead of issuing an un-attributable STOP", async () => {
		const store = makeStore(
			[makeRow({ action: "STOP", liveChannelRunId: RUN_1 })],
			[makeChannel({ status: "RUNNING", lastHeartbeat: HB_CONNECTED })],
		);
		store.runs = [];
		const { sweep, enqueue } = makeSweep(store);
		await sweep();
		expect(store.rows[0]).toMatchObject({
			status: "ERROR",
			outcome: "UNKNOWN",
			error: expect.stringContaining("no exact current live run/provider"),
		});
		expect(enqueue).not.toHaveBeenCalled();
	});
});

/**
 * , review-358 IMPORTANT — the PANEL-ARMED row, and why NULL was not
 * enough.
 *
 * The lazy bind only runs when a row is first evaluated as DUE. A row armed
 * from the panel while run 1 was live, whose fireAt lands after run 1 ended
 * and run 2 began, is never evaluated during run 1 at all — so if it carries
 * NULL it binds to run 2 and fires into an airing nobody armed it for. The
 * arm route now stamps the live run at arm time; this is what that stamp buys
 * at the tick, and the creation-time row beside it is the case that must NOT
 * change.
 */
describe("a panel-armed row survives a re-air it never saw (row #241)", () => {
	const RUN_1 = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
	const RUN_2 = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
	const PANEL_ROW = "33333333-3333-4333-8333-333333333333";
	const CREATION_ROW = "44444444-4444-4444-8444-444444444444";

	it("the panel row (armed for run 1) is REFUSED while the creation-time row (NULL) binds to run 2 and fires", async () => {
		// ONE tick, ONE channel, TWO rows that differ only in the bind — so
		// the assertion is a difference, not two separate stories.
		const store = makeStore(
			[
				makeRow({
					id: PANEL_ROW,
					action: "STOP",
					liveChannelRunId: RUN_1,
				}),
				makeRow({
					id: CREATION_ROW,
					action: "STOP",
					liveChannelRunId: null,
				}),
			],
			[makeChannel({ status: "RUNNING", lastHeartbeat: HB_CONNECTED })],
		);
		// Run 1 ended; the channel re-aired as run 2, which is what is on now.
		store.runs.push(
			{ id: RUN_1, seq: 1, status: "STOPPED", outputPrefix: "" },
			{ id: RUN_2, seq: 2, status: "RUNNING", outputPrefix: "" },
		);
		const { sweep, enqueue } = makeSweep(store);
		const stats = await sweep();

		const panel = store.rows.find((r) => r.id === PANEL_ROW);
		const creation = store.rows.find((r) => r.id === CREATION_ROW);
		expect(
			panel?.status,
			`the panel row was armed for run ${RUN_1}; this tick found run ${RUN_2} on the air, so it must be refused rather than stop an airing nobody armed it for`,
		).toBe("SKIPPED_STALE_GENERATION");
		expect(panel?.note).toContain(RUN_1);
		expect(panel?.note).toContain(RUN_2);
		expect(stats.skippedStale).toBe(1);

		// The creation-time row is the case that must NOT change: it was
		// written before any run existed, so it belongs to whatever is on now.
		expect(
			creation?.status,
			`the creation-time row carries no bind, so this tick must bind it to run ${RUN_2} and fire it`,
		).toBe("FIRED");
		expect(creation?.liveChannelRunId).toBe(RUN_2);

		// Exactly ONE stop reached the queue, and it is the creation-time
		// row's — the panel row dispatched nothing.
		expect(enqueue).toHaveBeenCalledTimes(1);
		expect(enqueue).toHaveBeenCalledWith(
			// (row 266): the creation-time row bound to
			// run 2 THIS tick, and the payload carries that just-bound airing —
			// proof the lazy bind is reflected onto the stamp, not the null the
			// row was read as.
			expect.objectContaining({
				liveChannelId: CH,
				action: "stop",
				plannedLiveChannelRunId: RUN_2,
				effect: expect.objectContaining({ action: "STOP" }),
			}),
			`sched-${CREATION_ROW}`,
		);
	});
});
it("inactive organization suppresses new ARMED work while STOP schedules remain eligible", async () => {
	const start = makeRow({ id: "inactive-start", action: "START" }),
		stop = makeRow({ id: "inactive-stop", action: "STOP" });
	const store = makeStore(
		[start, stop],
		[
			makeChannel({
				status: "RUNNING",
				bitmovinEncodingId: "running-provider",
				lastHeartbeat: HB_CONNECTED,
			}),
		],
	);
	const { sweep, enqueue } = makeSweep(store, {
		allowNewWork: async () => false,
	});
	await sweep();
	expect(start.status).toBe("CANCELED");
	expect(start.note).toContain("inactive");
	expect(
		enqueue.mock.calls.some(
			([job]) => (job as { action: string }).action === "provision",
		),
	).toBe(false);
	expect(
		enqueue.mock.calls.every(
			([job]) => (job as { action: string }).action === "stop",
		),
	).toBe(true);
});
it("inactive undispatched START releases its transitional channel instead of leaving an endless handoff", async () => {
	const row = makeRow({ status: "FIRED", firedAt: new Date(1_800_000) });
	const channel = makeChannel({
		status: "PROVISIONING",
		bitmovinEncodingId: null,
		stepLog: [],
	});
	const store = makeStore([row], [channel]);
	const { sweep, enqueue } = makeSweep(store, {
		allowNewWork: async () => false,
	});
	await sweep.dispatchPending();
	expect(row.status).toBe("CANCELED");
	expect(channel.status).toBe("ERROR");
	expect(enqueue).not.toHaveBeenCalled();
});
