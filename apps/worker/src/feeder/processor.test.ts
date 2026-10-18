import {
	FEEDER_MAX_ACTIVE_SESSIONS,
	feederProcessMayBeAlive,
	HEARTBEAT_FUTURE_SKEW_TOLERANCE_MS,
	INGEST_CONNECTED_MAX_AGE_MS,
	parseFeederError,
	REDACTED,
} from "@bitovp/core";
import type { AppPrismaClient } from "@bitovp/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedCredential } from "../orchestrator/executor";
import { FEEDER_LEASE_TAKEOVER_MS } from "./ownership";
import {
	createFeederProcessor,
	FEEDER_TAKEOVER_DRAIN_MS,
	type FeederDeps,
	mayKeepPushing,
} from "./processor";
import {
	type FeederProcess,
	type FeederProcessEvents,
	KILL_GRACE_MS,
	type ProcessRunner,
} from "./supervisor";

// review-260 127-B3: capture the REAL supervisor deps so the watchdog's
// ingestConnected closure — sample selection, clock parse, prisma read —
// can be driven as wired, not re-implemented. The wrapper delegates to the
// actual implementation, so every other test keeps real behaviour.
const capturedSupervisorDeps = vi.hoisted(
	() =>
		[] as {
			mayKeepPushing?: () => Promise<{
				status: "CONNECTED" | "DISCONNECTED" | "UNKNOWN";
				sampledAt: string | null;
				probeStartedAt: string | null;
			}>;
		}[],
);
vi.mock("./supervisor", async () => {
	const actual =
		await vi.importActual<typeof import("./supervisor")>("./supervisor");
	return {
		...actual,
		createFeederSupervisor: (
			deps: Parameters<typeof actual.createFeederSupervisor>[0],
		) => {
			capturedSupervisorDeps.push(
				deps as unknown as {
					mayKeepPushing?: () => Promise<{
						status: "CONNECTED" | "DISCONNECTED" | "UNKNOWN";
						sampledAt: string | null;
						probeStartedAt: string | null;
					}>;
				},
			);
			return actual.createFeederSupervisor(deps);
		},
	};
});

const SESSION_ID = "00000000-0000-4000-8000-0000000000f1";
const CHANNEL_ID = "00000000-0000-4000-8000-0000000000bb";
const SOURCE_CRED_ID = "00000000-0000-4000-8000-0000000000c1";
const SRT_CRED_ID = "00000000-0000-4000-8000-0000000000c2";
const PASSPHRASE = "p".repeat(16);
const NOW = "2026-06-12T00:00:00.000Z";
/** This worker's host identity, persisted next to every recorded pid. */
const HOST = "worker-a";
/** : the two worker INSTANCES a takeover arm needs. */
const OWNER_A = "worker-a/100/aaaaaaaa";
const OWNER_B = "worker-b/200/bbbbbbbb";
/** : what fetch-source reports it hashed while spooling. */
const FETCHED_SHA256 = "a".repeat(64);

const PROBE_COPY = {
	streams: [
		{
			codec_type: "video",
			codec_name: "h264",
			pix_fmt: "yuv420p",
			//  (PR-C): the timing the normalizer reads — a 30 s CFR loop
			start_time: "0.000000",
			duration: "30.000000",
			nb_frames: "900",
			r_frame_rate: "30/1",
		},
		{
			codec_type: "audio",
			codec_name: "aac",
			start_time: "0.000000",
			duration: "30.000000",
		},
	],
	format: { duration: "30.0", start_time: "0.000000" },
};

/**
 *  (PR-C): the normalize argv the harness last saw per loop path —
 * the loop's probe is synthesized from it, so the fake models what the
 * normalizer pins (`-s`, `-r`, `-profile:v`, `-ar`, `-ac`) on top of the
 * raw source's attributes.
 */
const normalizeArgvByLoop = new Map<string, string[]>();
/** The abort signal the last normalize run received (rev429 R1 arm). */
let lastNormalizeSignal: AbortSignal | undefined;
// rev429 R3: the map is keyed by the (shared) loop path, so a test that never
// normalizes must not read the previous test's argv.
beforeEach(() => {
	normalizeArgvByLoop.clear();
	lastNormalizeSignal = undefined;
});

type ProbeJson = {
	streams?: Record<string, unknown>[];
	format?: Record<string, unknown>;
};

/** What ffprobe says about the NORMALIZED loop: h264/aac, the pinned attributes, a CFR span from pts 0. */
function synthesizeLoopProbe(
	argv: string[],
	sourceProbe: ProbeJson,
): ProbeJson {
	const flag = (name: string) => {
		const i = argv.indexOf(name);
		return i >= 0 ? argv[i + 1] : undefined;
	};
	const source = sourceProbe.streams ?? [];
	const srcVideo = source.find((st) => st.codec_type === "video") ?? {};
	const srcAudio = source.find((st) => st.codec_type === "audio") ?? {};
	const size = flag("-s");
	const [w, h] = size
		? size.split("x").map(Number)
		: [srcVideo.width, srcVideo.height];
	const vf = flag("-vf") ?? "";
	const fps = flag("-r") ?? vf.match(/fps=([^,]+)/)?.[1] ?? "30";
	const rate = Number.parseFloat(
		fps.includes("/")
			? String(Number(fps.split("/")[0]) / Number(fps.split("/")[1]))
			: fps,
	);
	const durationSec = Number.parseFloat(flag("-t") ?? "30");
	const profileFlag = flag("-profile:v");
	const profile = profileFlag
		? profileFlag.charAt(0).toUpperCase() + profileFlag.slice(1)
		: (srcVideo.profile as string | undefined);
	return {
		format: {
			duration: durationSec.toFixed(6),
			start_time: "0.000000",
			format_name: "mov,mp4,m4a,3gp,3g2,mj2",
		},
		streams: [
			{
				codec_type: "video",
				codec_name: "h264",
				pix_fmt: "yuv420p",
				...(w !== undefined ? { width: w } : {}),
				...(h !== undefined ? { height: h } : {}),
				...(profile !== undefined ? { profile } : {}),
				...(srcVideo.level !== undefined ? { level: srcVideo.level } : {}),
				r_frame_rate: fps.includes("/")
					? fps
					: `${Math.round(rate * 1000)}/1000`,
				start_time: "0.000000",
				duration: durationSec.toFixed(6),
				nb_frames: String(Math.round(durationSec * rate)),
			},
			{
				codec_type: "audio",
				codec_name: "aac",
				sample_rate:
					flag("-ar") ??
					(srcAudio.sample_rate as string | undefined) ??
					"48000",
				channels: Number(flag("-ac") ?? srcAudio.channels ?? 2),
				start_time: "0.000000",
				duration: durationSec.toFixed(6),
			},
		],
	};
}

/**  (PR-C): answers the normalize run and the loop probe; everything else falls through. */
function answerNormalization(
	argv: string[],
	sourceProbeStdout: string,
	knobs: {
		/** Non-zero: the normalize run fails with this code (rev429 R2). */
		normalizeExit?: number;
		/** Replaces the synthesized loop probe answer (rev429 R2). */
		loopProbe?: { code: number; stdout: string; stderr: string };
	} = {},
) {
	const joined = argv.join(" ");
	const loopPath = argv.find((a) => a.endsWith(".loop.mp4"));
	if (loopPath && joined.includes("-vf fps=")) {
		normalizeArgvByLoop.set(loopPath, argv);
		if (knobs.normalizeExit) {
			return {
				code: knobs.normalizeExit,
				stdout: "",
				stderr: "Error while filtering: Invalid argument\nConversion failed!\n",
			};
		}
		return { code: 0, stdout: "", stderr: "" };
	}
	if (loopPath && joined.includes("-show_streams")) {
		if (knobs.loopProbe) {
			return knobs.loopProbe;
		}
		let sourceProbe: ProbeJson = {};
		try {
			sourceProbe = JSON.parse(sourceProbeStdout) as ProbeJson;
		} catch {
			sourceProbe = {};
		}
		const loop = synthesizeLoopProbe(
			normalizeArgvByLoop.get(loopPath) ?? [],
			sourceProbe,
		);
		return { code: 0, stdout: JSON.stringify(loop), stderr: "" };
	}
	return undefined;
}

class FakeProc implements FeederProcess {
	killed: string[] = [];
	constructor(
		readonly pid: number,
		readonly argv: string[],
		readonly events: FeederProcessEvents,
	) {}
	kill(signal: "SIGTERM" | "SIGKILL"): void {
		this.killed.push(signal);
	}
	progress(outTimeUs: number): void {
		this.events.onStdoutLine(`out_time_us=${outTimeUs}`);
		this.events.onStdoutLine("progress=continue");
	}
	exit(code: number | null, signal: string | null = null): void {
		this.events.onExit(code, signal);
	}
}

type Row = Record<string, unknown>;

function setup(
	opts: {
		session?: Row;
		channelStatus?: string;
		probe?: { code: number; stdout: string; stderr: string };
		/** rev429 R2: the normalize run exits with this code. */
		normalizeExit?: number;
		/** rev429 R1: the normalize run only settles when its signal aborts. */
		normalizeHangs?: boolean;
		/** rev429 R2: the loop probe answer. */
		loopProbe?: { code: number; stdout: string; stderr: string };
		resolveCredential?: FeederDeps["resolveCredential"];
		fetchSource?: FeederDeps["fetchSource"];
		channelOnSleep?: (channel: Row, run: Row) => void;
		/** Run the supervisor's 5s bind sleeps; false isolates unrelated tests. */
		bindWatchdogSleeps?: boolean;
		/** The channel's live plan, for the ingest preflight . */
		channelPlan?: unknown;
		/**
		 *  — what the RUN is already ingesting. `runIngestMedia` is
		 * the recorded reference (`LiveChannelRun.ingestMedia`); `runHeartbeat`
		 * is the encoder's own persisted sample, the fallback reference.
		 */
		runIngestMedia?: unknown;
		runHeartbeat?: unknown;
		channelHeartbeat?: unknown;
		killPid?: FeederDeps["killPid"];
		readProcessCommand?: FeederDeps["readProcessCommand"];
		loopBoundaryCap?: number;
		/** : lease renewal cadence (arms observe renewals, not delays). */
		leaseRenewalIntervalMs?: number;
		/** 0 = the first unexpected exit is terminal (no respawn). */
		maxRestarts?: number;
		bindTimeoutMs?: number;
		bindProbeIntervalMs?: number;
		maxBindKills?: number;
		/** : an advancing clock, for the arms that watch a lease move. */
		now?: () => string;
		/**
		 * OTHER sessions on the same fake table — the predecessor a
		 * two-phase switch has to stop and wait out. Every fake below iterates
		 * `sessions`, with `session` still the first row every older arm reads.
		 */
		extraSessions?: Row[];
		/** : the schedule row a held session polls (null = none). */
		scheduleRow?: () => { status: string } | null;
		commitPollIntervalMs?: number;
		predecessorGoneTimeoutMs?: number;
		stageHoldTimeoutMs?: number;
		/**
		 * a sleep that yields to the MACROTASK queue. The default
		 * fake resolves in a microtask, which is fine for a wait the test
		 * releases from inside `channelOnSleep` — but a hold or a barrier that
		 * the TEST releases (a commit request written, a predecessor exiting)
		 * would spin on microtasks forever and never let the test's own turn
		 * come. One millisecond per poll; the arms still resolve on the writes
		 * they observe, never on this.
		 */
		realSleep?: boolean;
		/**
		 * review-365 I-3: make the LEASE RENEWAL write throw while this returns
		 * true — an unreachable database, not a lost lease. Scoped to the
		 * renewal shape so the rest of the session keeps working, which is the
		 * whole point: the worker is alive and pushing.
		 */
		leaseWritesFail?: () => boolean;
	} = {},
) {
	const session: Row = {
		id: SESSION_ID,
		liveChannelId: CHANNEL_ID,
		// A new ingest effect must be attributable to an exact current run.
		liveChannelRunId: "run-1",
		status: "CREATED",
		sourceCredentialId: SOURCE_CRED_ID,
		sourceBucket: "media",
		sourceKey: "loops/source.mp4",
		// : the identity seal. Null by default — the shape of a row
		// written before the seal existed, whose download demands nothing.
		sourceEtag: null,
		sourceVersionId: null,
		sourceGeneration: null,
		sourceSize: null,
		sourceSha256: null,
		protocol: "RTMP",
		target: { url: "rtmp://203.0.113.7/live", streamKey: "sk-secret" },
		pid: null,
		ownerHost: null,
		processGoneAt: null,
		// : the ownership lease. Unclaimed until a start job or a
		// takeover writes it — which is also the shape of every row written
		// before the columns existed.
		ownerId: null,
		ownerLeaseAt: null,
		ownerGeneration: 0,
		// : the two-phase columns. Null = an ordinary single-phase
		// session, which is what every arm outside the two-phase block wants.
		commitAt: null,
		readyAt: null,
		commitRequestedAt: null,
		committedAt: null,
		predecessorGoneAt: null,
		switchSeamMs: null,
		// the publisher claim. Null = never claimed, the
		// shape of every row written before the columns existed and of a
		// staged hold that has not committed.
		publisherClaimedAt: null,
		publisherReleasedAt: null,
		publisherGeneration: 0,
		loopBoundaries: [],
		logTail: [],
		startedAt: null,
		stoppedAt: null,
		error: null,
		...opts.session,
	};
	const sessions: Row[] = [session, ...(opts.extraSessions ?? [])];
	const channel: Row = {
		id: CHANNEL_ID,
		status: opts.channelStatus ?? "RUNNING",
		bitmovinEncodingId: "enc-1",
		liveEffectFenceVersion: 0,
		...(opts.channelHeartbeat !== undefined
			? { lastHeartbeat: opts.channelHeartbeat }
			: {}),
	};
	const run: Row = {
		id: session.liveChannelRunId,
		liveChannelId: CHANNEL_ID,
		bitmovinEncodingId: "enc-1",
		providerStatus: "RUNNING",
		// Future stamps are treated as fresh clock skew by the classifier. This
		// keeps ownership tests whose synthetic clocks jump hours focused on the
		// lease behavior they exercise.
		providerStatusObservedAt: new Date("2099-01-01T00:00:00.000Z"),
		providerUnknownSince: null,
		providerTerminalAt: null,
		createdAt: new Date(NOW),
		ingestMedia: opts.runIngestMedia ?? null,
		// The lock moves with the column it guards: a run that already
		// carries a reference was necessarily stamped when it was written.
		ingestMediaRecordedAt:
			opts.runIngestMedia === undefined ? null : new Date(1_000),
		lastHeartbeat: opts.runHeartbeat ?? null,
	};

	/**
	 * A nullable-column filter as Prisma spells it: `null` (IS NULL) or
	 * `{ not: null }` (IS NOT NULL). Anything else is "no filter".
	 */
	const nullFilterOk = (value: unknown, filter: unknown): boolean => {
		if (filter === null) {
			return value == null;
		}
		if (
			typeof filter === "object" &&
			filter !== null &&
			"not" in filter &&
			(filter as { not: unknown }).not === null
		) {
			return value != null;
		}
		return true;
	};

	const matchesRow = (row: Row, where: Row): boolean => {
		const id = where.id as string | { not?: string; in?: string[] } | undefined;
		if (typeof id === "string" && id !== row.id) {
			return false;
		}
		if (id && typeof id === "object") {
			if (id.not !== undefined && row.id === id.not) {
				return false;
			}
			if (id.in !== undefined && !id.in.includes(row.id as string)) {
				return false;
			}
		}
		if ("liveChannelId" in where && row.liveChannelId !== where.liveChannelId) {
			return false;
		}
		if (
			"liveChannelRunId" in where &&
			row.liveChannelRunId !== where.liveChannelRunId
		) {
			return false;
		}
		const status = where.status as string | { in: string[] } | undefined;
		if (typeof status === "string" && row.status !== status) {
			return false;
		}
		if (
			status &&
			typeof status === "object" &&
			!status.in.includes(row.status as string)
		) {
			return false;
		}
		if ("startedAt" in where && row.startedAt !== where.startedAt) {
			return false;
		}
		// The reclaim writes are guarded on processGoneAt (a concurrent
		// stop that got there first keeps its own proof), so the fake has
		// to honour it or every guard test passes vacuously. Both spellings
		// (LC-02): `null` for the reclaim guards, `{ not: null }` for the
		// proof-guarded claim releases.
		if (
			"processGoneAt" in where &&
			!nullFilterOk(row.processGoneAt, where.processGoneAt)
		) {
			return false;
		}
		// the PUBLISHER CLAIM. Key presence, like the
		// fence: the occupancy fragment's held-claim arm and setPushing's
		// claim guard both filter on these, and a fake that ignored them would
		// count every row as a claim holder (over-matching) or let an
		// unclaimed spawn record its pid (the invariant passing vacuously).
		if (
			"publisherClaimedAt" in where &&
			!nullFilterOk(row.publisherClaimedAt, where.publisherClaimedAt)
		) {
			return false;
		}
		if (
			"publisherReleasedAt" in where &&
			!nullFilterOk(row.publisherReleasedAt, where.publisherReleasedAt)
		) {
			return false;
		}
		// The publisher generation is the identity of one CLAIM incarnation.
		// A late process-gone proof from generation N must not release a newer
		// generation N+1 merely because the OS reused the same pid on the same
		// host. Ignoring this scalar would make that fence test vacuous.
		if (
			"publisherGeneration" in where &&
			row.publisherGeneration !== where.publisherGeneration
		) {
			return false;
		}
		//  — the OWNER FENCE. Key PRESENCE, not truthiness: Prisma
		// reads a supplied `null` on a scalar as IS NULL and an ABSENT key as
		// "no filter", and those are the same JS value — a fake that tested
		// truthiness would report a fence holding while the real query filtered
		// on nothing, and every takeover assertion would pass vacuously.
		if ("ownerId" in where && row.ownerId !== where.ownerId) {
			return false;
		}
		if (
			"ownerGeneration" in where &&
			row.ownerGeneration !== where.ownerGeneration
		) {
			return false;
		}
		// rev367 re-review P2: the HOST half of the fence. setPushing writes
		// pid and ownerHost together, and the revoked-owner proof write guards
		// on BOTH so a pid reused on another host cannot null a live push. The
		// fake ignored this key, so a P2-shaped arm would pass VACUOUSLY — the
		// proof would appear to match the new owner's row here while the real
		// query filtered it out. Honoured as key PRESENCE, like the pair above.
		if ("ownerHost" in where && row.ownerHost !== where.ownerHost) {
			return false;
		}
		//  — the two-phase CAS terms and the predecessor query's
		// `pid IS NOT NULL` half. Each is load-bearing for one arm: the commit
		// CAS on `readyAt: { not: null }` / `committedAt: null`, the request
		// CAS on `commitRequestedAt: null`, and the barrier's population.
		if ("readyAt" in where && !nullFilterOk(row.readyAt, where.readyAt)) {
			return false;
		}
		if (
			"commitRequestedAt" in where &&
			!nullFilterOk(row.commitRequestedAt, where.commitRequestedAt)
		) {
			return false;
		}
		if (
			"committedAt" in where &&
			!nullFilterOk(row.committedAt, where.committedAt)
		) {
			return false;
		}
		if ("pid" in where && !nullFilterOk(row.pid, where.pid)) {
			return false;
		}
		// The revoked owner's gone-proof is guarded on the EXACT pid this run
		// spawned (rev367 I-4) — a fake that read a number as "no filter"
		// would let the proof land on a successor's pid.
		if (typeof where.pid === "number" && row.pid !== where.pid) {
			return false;
		}
		if ("commitAt" in where && !nullFilterOk(row.commitAt, where.commitAt)) {
			return false;
		}
		// rev367 I-1: the barrier EXCLUDES held later switches with a NOT
		// clause. Prisma's NOT means "does not match this sub-where"; a fake
		// that dropped it would stop the very session the exclusion protects,
		// and the arm pinning the exclusion would pass vacuously against a
		// mutation that removes it.
		if (
			where.NOT !== undefined &&
			matchesRow(row, where.NOT as unknown as Row)
		) {
			return false;
		}
		if (
			Array.isArray(where.OR) &&
			!(where.OR as Row[]).some((arm) => matchesRow(row, arm))
		) {
			return false;
		}
		return true;
	};

	const feederSession = {
		findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
			const hit = sessions.find((row) => row.id === where.id);
			return hit ? { ...hit } : null;
		}),
		update: vi.fn(async ({ where, data }: { where?: Row; data: Row }) => {
			const hit =
				sessions.find(
					(row) => where?.id === undefined || row.id === where.id,
				) ?? session;
			Object.assign(hit, data);
			return { ...hit };
		}),
		updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
			const isRenewal =
				Object.keys(data).length === 1 && "ownerLeaseAt" in data;
			if (isRenewal && opts.leaseWritesFail?.()) {
				throw new Error("connection terminated unexpectedly");
			}
			let count = 0;
			for (const row of sessions) {
				if (!matchesRow(row, where)) {
					continue;
				}
				// review-365 I-4: `{ increment: n }` is an ATOMIC OPERATOR, not
				// a value. A fake that assigned it would put an object into
				// `ownerGeneration`, and every later fence comparison against a
				// number would silently fail to match — the arm would "pass"
				// while pinning nothing.
				const next: Row = { ...row };
				for (const [key, value] of Object.entries(data)) {
					if (
						value !== null &&
						typeof value === "object" &&
						"increment" in (value as Record<string, unknown>)
					) {
						const by = (value as { increment: number }).increment;
						next[key] = ((next[key] as number) ?? 0) + by;
					} else {
						next[key] = value;
					}
				}
				// the partial unique index
				// `FeederSession_one_publisher_claim_per_channel`, modelled: a
				// write that would leave THIS row holding a claim while ANOTHER
				// row on the channel holds one is a P2002 and applies nothing —
				// the DB's answer, which every "two at once → exactly one" arm
				// rests on. A unit test's fake Prisma enforces no index on its
				// own; the DB↔schema equivalence of the real one is proven by
				// `prisma migrate diff` and pinned by db's schema.test.ts.
				const wouldHold =
					next.publisherClaimedAt != null && next.publisherReleasedAt == null;
				if (
					wouldHold &&
					sessions.some(
						(other) =>
							other !== row &&
							other.liveChannelId === row.liveChannelId &&
							other.publisherClaimedAt != null &&
							other.publisherReleasedAt == null,
					)
				) {
					throw Object.assign(
						new Error(
							"Unique constraint failed on the fields: (`liveChannelId`)",
						),
						{
							code: "P2002",
							meta: { target: "FeederSession_one_publisher_claim_per_channel" },
						},
					);
				}
				Object.assign(row, next);
				count += 1;
			}
			return { count };
		}),
		/** The doors' admission read — the same fake filter as findMany. */
		count: vi.fn(async ({ where }: { where: Row }) => {
			return sessions.filter((row) => matchesRow(row, where)).length;
		}),
		/**
		 * 's takeover population. ONE row, so it cannot speak to
		 * ordering or the batch cap — but it DOES evaluate the two filters the
		 * sweep's safety rests on, which is what the arms need:
		 *
		 *  · `status.in`  — terminal sessions are never resumed;
		 *  · `ownerLeaseAt: { not: null, lt }` — both halves. Dropping `lt`
		 *    takes a live push from its owner; dropping `not: null` resumes a
		 *    session whose own start job is still in the queue. A fake that
		 *    ignored either would make both mutations survive.
		 */
		findMany: vi.fn(async ({ where }: { where: Row }) => {
			const lease = where.ownerLeaseAt as { not?: null; lt?: Date } | undefined;
			return sessions
				.filter((row) => {
					if (!matchesRow(row, where)) {
						return false;
					}
					if (lease) {
						const at = row.ownerLeaseAt as Date | null;
						if ("not" in lease && lease.not === null && at === null) {
							return false;
						}
						if (lease.lt !== undefined && !(at !== null && at < lease.lt)) {
							return false;
						}
					}
					return true;
				})
				.map((row) => ({ ...row }));
		}),
	};
	const liveChannel = {
		/**
		 * HONOURS `select`, which is the whole point of it.
		 *
		 * The first version returned `{status, plan}` unconditionally, and a
		 * mutation that dropped `plan` from the preflight's SELECT left all 21
		 * tests GREEN: the mock was lying about Prisma's projection, so the pin
		 * could not see a wrong SELECT at all. Projecting here makes it red.
		 *
		 * Honest about what that is worth: `tsc` ALSO rejects that mutation
		 * (`Property 'plan' does not exist on type '{ status: … }'`), so the
		 * compiler is the real guard and this is defence-in-depth, not a live
		 * hole closed. An earlier version of this comment claimed the mutation
		 * was "a silent no-op in production" — it is not, and the check that
		 * settled it was running tsc on the mutation rather than only vitest.
		 */
		findUnique: vi.fn(
			async ({
				where,
				select,
			}: {
				where: { id: string };
				select?: Record<string, boolean>;
			}) => {
				if (where.id !== channel.id) {
					return null;
				}
				const full: Record<string, unknown> = {
					id: channel.id,
					status: channel.status,
					plan: opts.channelPlan ?? null,
					// 127-B3: the watchdog closure selects these; mutable via
					// the returned channel object so a test can swap samples
					// between closure calls.
					lastHeartbeat: channel.lastHeartbeat ?? null,
					bitmovinEncodingId: channel.bitmovinEncodingId,
					liveEffectFenceVersion: channel.liveEffectFenceVersion,
					runs: channel.runs ?? [],
				};
				if (!select) {
					return full;
				}
				return Object.fromEntries(
					Object.entries(full).filter(([key]) => select[key]),
				);
			},
		),
		updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
			if (
				(where.id !== undefined && where.id !== channel.id) ||
				(where.liveEffectFenceVersion !== undefined &&
					where.liveEffectFenceVersion !== channel.liveEffectFenceVersion)
			) {
				return { count: 0 };
			}
			for (const [key, value] of Object.entries(data)) {
				if (
					value !== null &&
					typeof value === "object" &&
					"increment" in (value as Row)
				) {
					channel[key] =
						((channel[key] as number) ?? 0) +
						((value as { increment: number }).increment ?? 0);
				} else {
					channel[key] = value;
				}
			}
			return { count: 1 };
		}),
	};
	const effectClaims: Row[] = [];
	const effectMatches = (claim: Row, where: Row): boolean => {
		for (const key of [
			"id",
			"idempotencyKey",
			"token",
			"liveChannelId",
			"targetId",
		] as const) {
			if (where[key] !== undefined && claim[key] !== where[key]) return false;
		}
		const state = where.state as string | { in?: string[] } | undefined;
		if (typeof state === "string" && claim.state !== state) return false;
		if (
			state &&
			typeof state === "object" &&
			state.in &&
			!state.in.includes(claim.state as string)
		) {
			return false;
		}
		if (
			Array.isArray(where.OR) &&
			!(where.OR as Row[]).some((arm) => effectMatches(claim, arm))
		) {
			return false;
		}
		return true;
	};
	const applyEffectData = (claim: Row, data: Row): void => {
		for (const [key, value] of Object.entries(data)) {
			if (
				value !== null &&
				typeof value === "object" &&
				"increment" in (value as Row)
			) {
				claim[key] =
					((claim[key] as number) ?? 0) +
					((value as { increment: number }).increment ?? 0);
			} else {
				claim[key] = value;
			}
		}
	};
	const liveEffectClaim = {
		findUnique: vi.fn(
			async ({ where }: { where: Row }) =>
				effectClaims.find((claim) => effectMatches(claim, where)) ?? null,
		),
		findFirst: vi.fn(
			async ({ where }: { where: Row }) =>
				[...effectClaims]
					.reverse()
					.find((claim) => effectMatches(claim, where)) ?? null,
		),
		create: vi.fn(async ({ data }: { data: Row }) => {
			const claim: Row = {
				id: `effect-${effectClaims.length + 1}`,
				attempt: 1,
				createdAt: new Date(NOW),
				updatedAt: new Date(NOW),
				acknowledgedAt: null,
				dispatchedAt: null,
				failure: null,
				targetId: null,
				...data,
			};
			effectClaims.push(claim);
			return { ...claim };
		}),
		update: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
			const claim = effectClaims.find((row) => effectMatches(row, where));
			if (!claim) throw new Error("effect claim not found");
			applyEffectData(claim, data);
			return { ...claim };
		}),
		updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
			let count = 0;
			for (const claim of effectClaims) {
				if (!effectMatches(claim, where)) continue;
				applyEffectData(claim, data);
				count += 1;
			}
			return { count };
		}),
	};
	/**
	 * the schedule row a scheduled feed was armed from.
	 *
	 * It exists here BECAUSE the outcome writer is best-effort — without a stub
	 * its `prisma.liveSchedule` read throws, the catch swallows it, and every
	 * assertion about delivery would pass over a call that never happened.
	 */
	const liveSchedule = {
		updateMany: vi.fn(async () => ({ count: 1 })),
		// : the held session's own poll of the row that armed it.
		findFirst: vi.fn(async () => opts.scheduleRow?.() ?? null),
	};
	/**
	 * 's reference store. Honours `select` for the same reason
	 * `liveChannel` does, and simulates the CAS the recorder relies on: an
	 * `ingestMediaRecordedAt: null` filter matches only while the lock is
	 * still unset, so a test can prove the SECOND push does not redefine the
	 * reference it was just checked against.
	 *
	 * The `in` check is the faithful part. Prisma reads a supplied `null` on
	 * a scalar column as IS NULL and an ABSENT key as "no filter", and those
	 * two are the same JS value — so a fake that tested truthiness would
	 * report the CAS holding while the real query filtered on nothing.
	 */
	/** Every `where` the recorder issued — the CAS shape is under test. */
	const runUpdateWheres: Row[] = [];
	const liveChannelRun = {
		findFirst: vi.fn(
			async ({ select }: { select?: Record<string, boolean> } = {}) =>
				select
					? Object.fromEntries(
							Object.entries(run).filter(([key]) => select[key]),
						)
					: { ...run },
		),
		findUnique: vi.fn(
			async ({
				where,
				select,
			}: {
				where: { id: string };
				select?: Record<string, boolean>;
			}) => {
				if (where.id !== run.id) {
					return null;
				}
				return select
					? Object.fromEntries(
							Object.entries(run).filter(([key]) => select[key]),
						)
					: { ...run };
			},
		),
		updateMany: vi.fn(
			async ({
				where,
				data,
			}: {
				where: Row & { ingestMediaRecordedAt?: Date | null };
				data: Row;
			}) => {
				runUpdateWheres.push(where);
				if (where.id !== run.id) {
					return { count: 0 };
				}
				if (
					"ingestMediaRecordedAt" in where &&
					where.ingestMediaRecordedAt === null &&
					run.ingestMediaRecordedAt !== null
				) {
					return { count: 0 };
				}
				Object.assign(run, data);
				return { count: 1 };
			},
		),
	};
	const pushAttempts: Row[] = [];
	const feederPushAttempt = {
		create: vi.fn(async ({ data }: { data: Row }) => {
			const attempt = {
				id: `00000000-0000-4000-8000-${String(pushAttempts.length + 1).padStart(12, "0")}`,
				pid: null,
				processSpawnedAt: null,
				evidenceNotBefore: null,
				endedAt: null,
				providerStatus: "UNKNOWN",
				providerSampleAt: null,
				providerAcceptedAt: null,
				...data,
			};
			pushAttempts.push(attempt);
			return { id: attempt.id };
		}),
		updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
			const attempt = pushAttempts.find((item) => {
				if (item.id !== where.id) return false;
				if ("pid" in where && !nullFilterOk(item.pid, where.pid)) return false;
				if (
					"processSpawnedAt" in where &&
					!nullFilterOk(item.processSpawnedAt, where.processSpawnedAt)
				)
					return false;
				if (
					"evidenceNotBefore" in where &&
					!nullFilterOk(item.evidenceNotBefore, where.evidenceNotBefore)
				)
					return false;
				if ("endedAt" in where && !nullFilterOk(item.endedAt, where.endedAt))
					return false;
				return true;
			});
			if (!attempt) return { count: 0 };
			Object.assign(attempt, data);
			return { count: 1 };
		}),
	};
	/**
	 * LC-02: the commit-and-claim runs as ONE Prisma transaction. The batch
	 * form receives the already-issued (eager, in this fake) writes and
	 * settles them together, so a claim refused by the modelled index rejects
	 * the whole batch exactly as the real transaction rolls it back; the
	 * interactive form hands the fake back as `tx`.
	 */
	const $transaction = vi.fn(
		async (
			arg: Promise<unknown>[] | ((tx: AppPrismaClient) => Promise<unknown>),
		) =>
			Array.isArray(arg)
				? await Promise.all(arg)
				: await arg(prisma as unknown as AppPrismaClient),
	);
	const prisma = {
		feederSession,
		feederPushAttempt,
		liveChannel,
		liveSchedule,
		liveChannelRun,
		liveEffectClaim,
		$transaction,
	} as unknown as AppPrismaClient;

	const spawned: FakeProc[] = [];
	const runner: ProcessRunner = {
		spawn(_bin, argv, events) {
			const proc = new FakeProc(5000 + spawned.length, argv, events);
			spawned.push(proc);
			return proc;
		},
		run: vi.fn(
			async (
				_bin: string,
				argv: string[],
				options?: { signal?: AbortSignal },
			) => {
				const sourceAnswer = opts.probe ?? {
					code: 0,
					stdout: JSON.stringify(PROBE_COPY),
					stderr: "",
				};
				const isNormalize =
					argv.some((a) => a.endsWith(".loop.mp4")) &&
					argv.join(" ").includes("-vf fps=");
				if (isNormalize) {
					lastNormalizeSignal = options?.signal;
					if (opts.normalizeHangs) {
						// Like a long transcode: ends only when the signal kills it.
						return new Promise<{
							code: number | null;
							stdout: string;
							stderr: string;
						}>((resolve) => {
							options?.signal?.addEventListener("abort", () =>
								resolve({ code: null, stdout: "", stderr: "aborted" }),
							);
						});
					}
				}
				return (
					answerNormalization(argv, sourceAnswer.stdout, {
						...(opts.normalizeExit
							? { normalizeExit: opts.normalizeExit }
							: {}),
						...(opts.loopProbe ? { loopProbe: opts.loopProbe } : {}),
					}) ?? sourceAnswer
				);
			},
		),
	};

	const cleanup = vi.fn(async () => {});
	// : the processor's terminal-ERROR writers must notify. Wired
	// here so a reclaim that lands ERROR without an emit is visible to a test
	// rather than only to an operator who never gets told.
	const emitEvent = vi.fn(async () => {});
	const killPid = vi.fn(opts.killPid ?? (() => {}));
	const sleep = vi.fn(async (ms: number) => {
		opts.channelOnSleep?.(channel, run);
		if (ms >= 5_000 && !opts.bindWatchdogSleeps) {
			await new Promise<void>(() => {});
		}
		if (opts.realSleep) {
			await new Promise<void>((resolve) => setTimeout(resolve, 1));
		}
	});

	const now = opts.now ?? (() => NOW);
	/**
	 * build ANOTHER worker over the SAME fake database — the only
	 * way to exercise a takeover, which is by definition a fact about two
	 * processes. The overrides are the three things that make a worker a
	 * different worker: its instance id, its host, and its clock.
	 */
	const makeProcessor = (overrides: Partial<FeederDeps> = {}) =>
		createFeederProcessor({
			prisma,
			emitEvent,
			resolveCredential:
				opts.resolveCredential ??
				(async (credentialId: string): Promise<ResolvedCredential> => {
					if (credentialId === SRT_CRED_ID) {
						return {
							provider: "SRT_PASSPHRASE",
							config: {},
							secret: { passphrase: PASSPHRASE },
						};
					}
					return {
						provider: "AWS_S3",
						config: { region: "us-east-1" },
						secret: { accessKeyId: "a", secretAccessKey: "s" },
					};
				}),
			runner,
			ffmpegPath: "ffmpeg",
			ffprobePath: "ffprobe",
			spoolDir: "/tmp/spool-test",
			hostname: HOST,
			ownerId: OWNER_A,
			sleep,
			now,
			leaseRenewalIntervalMs: opts.leaseRenewalIntervalMs,
			channelPollIntervalMs: 1,
			channelWaitTimeoutMs: 50,
			commitPollIntervalMs: opts.commitPollIntervalMs ?? 1,
			predecessorGoneTimeoutMs: opts.predecessorGoneTimeoutMs,
			stageHoldTimeoutMs: opts.stageHoldTimeoutMs,
			fetchSource:
				opts.fetchSource ??
				(async () => ({
					path: "/tmp/spool-test/src.mp4",
					sha256: FETCHED_SHA256,
					bytes: 1024,
					pinned: true,
					cleanup,
				})),
			killPid,
			readProcessCommand: opts.readProcessCommand,
			maxRestarts: opts.maxRestarts ?? 1,
			backoffBaseMs: 1,
			killGraceMs: 1,
			bindTimeoutMs: opts.bindTimeoutMs,
			bindProbeIntervalMs: opts.bindProbeIntervalMs,
			maxBindKills: opts.maxBindKills,
			logFlushEveryLines: 1,
			loopBoundaryCap: opts.loopBoundaryCap,
			...overrides,
		});

	const processor = makeProcessor();

	return {
		processor,
		makeProcessor,
		session,
		sessions,
		channel,
		run,
		runUpdateWheres,
		spawned,
		runner,
		cleanup,
		killPid,
		emitEvent,
		sleep,
		feederSession,
		liveSchedule,
		effectClaims,
		pushAttempts,
	};
}

/** Every `liveSchedule.updateMany` that carried a delivery outcome. */
function outcomeWrites(liveSchedule: {
	updateMany: { mock: { calls: unknown[][] } };
}) {
	return liveSchedule.updateMany.mock.calls
		.map(
			(call) =>
				call[0] as { data?: { outcome?: string; outcomeNote?: string } },
		)
		.filter((arg) => arg.data?.outcome !== undefined);
}

const startJob = { feederSessionId: SESSION_ID, action: "start" } as const;
const stopJob = { feederSessionId: SESSION_ID, action: "stop" } as const;

describe("feeder processor — start", () => {
	it("refuses the first spawn when the exact run is no longer fresh RUNNING", async () => {
		let s: ReturnType<typeof setup>;
		s = setup({
			fetchSource: async () => {
				s.run.providerStatus = "QUEUED";
				s.run.providerStatusObservedAt = new Date(NOW);
				return {
					path: "/tmp/spool-test/src.mp4",
					sha256: FETCHED_SHA256,
					bytes: 1024,
					pinned: true,
					cleanup: vi.fn(async () => {}),
				};
			},
		});

		await expect(s.processor.process(startJob)).rejects.toThrow(/not RUNNING/);
		expect(s.spawned).toHaveLength(0);
		expect(s.session.status).toBe("ERROR");
	});

	it("refuses the first spawn when the session's run is no longer current", async () => {
		let s: ReturnType<typeof setup>;
		s = setup({
			fetchSource: async () => {
				s.run.id = "run-2";
				return {
					path: "/tmp/spool-test/src.mp4",
					sha256: FETCHED_SHA256,
					bytes: 1024,
					pinned: true,
					cleanup: vi.fn(async () => {}),
				};
			},
		});

		await expect(s.processor.process(startJob)).rejects.toThrow(
			/exact live run/,
		);
		expect(s.spawned).toHaveLength(0);
		expect(s.session.status).toBe("ERROR");
	});

	it("refuses the first spawn after this worker loses the exact owner generation", async () => {
		let s: ReturnType<typeof setup>;
		s = setup({
			fetchSource: async () => {
				s.session.ownerGeneration = 2;
				s.session.ownerId = OWNER_B;
				return {
					path: "/tmp/spool-test/src.mp4",
					sha256: FETCHED_SHA256,
					bytes: 1024,
					pinned: true,
					cleanup: vi.fn(async () => {}),
				};
			},
		});

		await expect(s.processor.process(startJob)).resolves.toMatchObject({
			status: "TAKEN_OVER",
		});
		expect(s.spawned).toHaveLength(0);
		expect(s.session.ownerId).toBe(OWNER_B);
		expect(s.session.ownerGeneration).toBe(2);
	});

	it("claims CREATED → DOWNLOADING → PUSHING, then lands STOPPED via a stop job (registry hit)", async () => {
		const s = setup();
		const run = s.processor.process(startJob);
		await vi.waitFor(() => expect(s.spawned).toHaveLength(1));
		expect(s.session.status).toBe("PUSHING");
		expect(s.session.pid).toBe(5000);
		// The pid is only signallable where it was minted, so the host is
		// written WITH it — a later stop (or the boot reconciler) reads this
		// before it sends anything (audit 2026-08-29 CRITICAL-2).
		expect(s.session.ownerHost).toBe(HOST);
		expect(s.session.startedAt).toEqual(new Date(NOW));

		const stop = await s.processor.process(stopJob);
		expect(stop.status).toBe("STOPPING"); // start job owns persistence
		const proc = s.spawned[0];
		expect(proc?.killed).toContain("SIGTERM");
		proc?.exit(null, "SIGTERM");

		await expect(run).resolves.toMatchObject({ status: "STOPPED" });
		expect(s.session.status).toBe("STOPPED");
		expect(s.session.pid).toBeNull();
		// Host identity is released with the pid: they are one fact.
		expect(s.session.ownerHost).toBeNull();
		expect(s.session.stoppedAt).toEqual(new Date(NOW));
		expect(s.cleanup).toHaveBeenCalled();
		// The push command stays out of the row in raw form: the tail logs
		// the redacted argv only.
		const tail = (s.session.logTail as string[]).join("\n");
		expect(tail).toContain(`rtmp://203.0.113.7/live/${REDACTED}`);
		expect(tail).not.toContain("sk-secret");
	});

	it("stale duplicate start skips non-CREATED rows (the claim is the lock)", async () => {
		const s = setup({ session: { status: "PUSHING" } });
		await expect(s.processor.process(startJob)).resolves.toMatchObject({
			status: "PUSHING",
		});
		expect(s.spawned).toHaveLength(0);
	});

	it("waits for a PROVISIONING channel to reach RUNNING before pushing", async () => {
		const s = setup({
			channelStatus: "PROVISIONING",
			channelOnSleep: (channel) => {
				channel.status = "RUNNING";
			},
		});
		const run = s.processor.process(startJob);
		await vi.waitFor(() => expect(s.spawned).toHaveLength(1));
		expect(s.sleep).toHaveBeenCalled();
		const proc = s.spawned[0];
		await s.processor.process(stopJob);
		proc?.exit(null, "SIGTERM");
		await run;
	});

	it("fails fast when the channel is terminal — feeders never push at a stopped ingest", async () => {
		const s = setup({ channelStatus: "STOPPED" });
		await expect(s.processor.process(startJob)).rejects.toThrow(
			/only pushes into a RUNNING channel/,
		);
		expect(s.session.status).toBe("ERROR");
		expect(s.session.error).toMatch(/STOPPED/);
		expect(s.spawned).toHaveLength(0);
	});

	it("fails when ffprobe fails, with the last stderr line in the error", async () => {
		const s = setup({
			probe: { code: 1, stdout: "", stderr: "x\nmoov atom not found" },
		});
		await expect(s.processor.process(startJob)).rejects.toThrow(
			/ffprobe failed \(code 1\): moov atom not found/,
		);
		expect(s.session.status).toBe("ERROR");
	});

	it("resolves the SRT passphrase from the vault at spawn only (argv yes, row never)", async () => {
		const s = setup({
			session: {
				protocol: "SRT_CALLER",
				target: {
					host: "srt.example",
					port: 2090,
					passphraseCredentialId: SRT_CRED_ID,
				},
			},
		});
		const run = s.processor.process(startJob);
		await vi.waitFor(() => expect(s.spawned).toHaveLength(1));
		const proc = s.spawned[0];
		// The spawn argv carries the resolved passphrase (process-only)…
		expect(proc?.argv.at(-1)).toBe(
			`srt://srt.example:2090?mode=caller&passphrase=${PASSPHRASE}&pbkeylen=16`,
		);
		await s.processor.process(stopJob);
		proc?.exit(null, "SIGTERM");
		await run;
		// …and never any persisted field.
		expect(JSON.stringify(s.session)).not.toContain(PASSPHRASE);
	});

	it("rejects a non-SRT_PASSPHRASE credential behind the vault ref (provider gate)", async () => {
		const s = setup({
			session: {
				protocol: "SRT_CALLER",
				target: {
					host: "srt.example",
					port: 2090,
					passphraseCredentialId: SRT_CRED_ID,
				},
			},
			resolveCredential: async () => ({
				provider: "ZIXI",
				config: {},
				secret: { password: "zzz" },
			}),
		});
		await expect(s.processor.process(startJob)).rejects.toThrow(
			/needs an SRT_PASSPHRASE credential/,
		);
		expect(s.session.status).toBe("ERROR");
		expect(s.spawned).toHaveLength(0);
	});

	it("marks ERROR after the supervisor exhausts its restarts", async () => {
		const s = setup(); // maxRestarts: 1, instant backoff
		const run = s.processor.process(startJob);
		await vi.waitFor(() => expect(s.spawned).toHaveLength(1));
		s.spawned[0]?.exit(1);
		await vi.waitFor(() => expect(s.spawned).toHaveLength(2));
		s.spawned[1]?.exit(1);
		await expect(run).resolves.toMatchObject({ status: "ERROR" });
		expect(s.session.status).toBe("ERROR");
		expect(s.session.error).toMatch(/restart attempts are exhausted/);
	});

	/**
	 *  — the schedule row that armed this session learns what
	 * happened to it.
	 *
	 * Before this, the only writer of a feeder schedule's failure lived in the
	 * worker's out-of-process dead-job handler, which fires when the JOB dies.
	 * Every ORDINARY failure — and every ordinary success — left the row FIRED,
	 * which the panel painted green.
	 */
	it("a session that reaches PUSHING marks its schedule row PROCESS_PUSHING, not DELIVERED (audit HIGH-4)", async () => {
		/**
		 * The push starting is NOT delivery — the paid run measured this write
		 * landing ~16s before the provider even bound the ingest. The row climbs
		 * to a green only once the channel heartbeat confirms the ingest
		 * (INGEST_CONNECTED, exercised below). PROCESS_PUSHING may replace only
		 * PENDING, so a restart cannot drag an already-connected row down.
		 */
		const s = setup();
		const run = s.processor.process(startJob);
		await vi.waitFor(() => expect(s.session.status).toBe("PUSHING"));
		expect(outcomeWrites(s.liveSchedule)).toEqual([
			{
				where: {
					feederSessionId: SESSION_ID,
					outcome: { in: ["PENDING"] },
				},
				data: expect.objectContaining({ outcome: "PROCESS_PUSHING" }),
			},
		]);
		await s.processor.process(stopJob);
		s.spawned[0]?.exit(null, "SIGTERM");
		await expect(run).resolves.toMatchObject({ status: "STOPPED" });
	});

	it("a session whose exact run heartbeat reports the ingest CONNECTED climbs to INGEST_CONNECTED (audit HIGH-4)", async () => {
		/**
		 * The bind-watchdog reads the exact run's persisted heartbeat; the SAME
		 * read is the provider's own word that it bound the ingest. A fresh
		 * CONNECTED sample WHILE we push lifts PROCESS_PUSHING → INGEST_CONNECTED
		 * (the feeder's terminal-positive green) — reusing the watchdog's read,
		 * no new poll. `channelOnSleep` swaps in the connected sample right
		 * before the watchdog's post-bindTimeout probe fires.
		 */
		let heartbeatSequence = 0;
		const s = setup({
			bindWatchdogSleeps: true,
			channelOnSleep: (_channel, run) => {
				heartbeatSequence += 1;
				run.lastHeartbeat = {
					// The persisted timestamp is the heartbeat request start. It must
					// be causally after this feeder's spawn boundary, not merely equal.
					at: new Date(Date.parse(NOW) + heartbeatSequence).toISOString(),
					raw: {
						timestamp: new Date(
							Date.parse(NOW) + heartbeatSequence,
						).toISOString(),
						ingest: { status: "CONNECTED" },
					},
				};
			},
		});
		const run = s.processor.process(startJob);
		await vi.waitFor(() =>
			expect(
				outcomeWrites(s.liveSchedule).some(
					(w) => w.data?.outcome === "INGEST_CONNECTED",
				),
			).toBe(true),
		);
		// The order is the ladder: PROCESS_PUSHING first, then the green.
		expect(outcomeWrites(s.liveSchedule).map((w) => w.data?.outcome)).toEqual([
			"PROCESS_PUSHING",
			"INGEST_CONNECTED",
		]);
		expect(outcomeWrites(s.liveSchedule).at(-1)).toEqual({
			where: {
				feederSessionId: SESSION_ID,
				outcome: { in: ["PENDING", "PROCESS_PUSHING"] },
			},
			data: expect.objectContaining({ outcome: "INGEST_CONNECTED" }),
		});
		expect(s.pushAttempts).toHaveLength(1);
		expect(s.pushAttempts[0]).toMatchObject({
			feederSessionId: SESSION_ID,
			liveChannelRunId: "run-1",
			ownerGeneration: 1,
			publisherGeneration: 1,
			attemptNo: 1,
			pid: 5000,
			startedAt: new Date(NOW),
			processSpawnedAt: new Date(NOW),
			evidenceNotBefore: new Date(NOW),
			sourceSha256: FETCHED_SHA256,
			sanitizedTarget: `rtmp://203.0.113.7/live/${REDACTED}`,
			providerStatus: "CONNECTED",
			providerSampleAt: new Date(Date.parse(NOW) + 2),
			providerAcceptedAt: new Date(NOW),
		});
		expect(s.pushAttempts[0]?.codecDecision).toMatchObject({ mode: "copy" });
		expect(JSON.stringify(s.pushAttempts[0])).not.toContain("sk-secret");
		await s.processor.process(stopJob);
		s.spawned[0]?.exit(null, "SIGTERM");
		await expect(run).resolves.toMatchObject({ status: "STOPPED" });
		expect(s.pushAttempts[0]).toMatchObject({
			endedAt: new Date(NOW),
			exitCode: null,
			exitSignal: "SIGTERM",
		});
	});

	it("a session that ERRORS marks its schedule row FAILED with the reason", async () => {
		const s = setup();
		const run = s.processor.process(startJob);
		await vi.waitFor(() => expect(s.spawned).toHaveLength(1));
		s.spawned[0]?.exit(1);
		await vi.waitFor(() => expect(s.spawned).toHaveLength(2));
		s.spawned[1]?.exit(1);
		await expect(run).resolves.toMatchObject({ status: "ERROR" });
		// The PROCESS_PUSHING write from the first push is there too — this
		// asserts the FAILED one lands AFTER it, and that its WHERE lets it win
		// over every non-terminal positive on the ladder.
		expect(outcomeWrites(s.liveSchedule).at(-1)).toEqual({
			where: {
				feederSessionId: SESSION_ID,
				outcome: {
					in: [
						"PENDING",
						"PROCESS_PUSHING",
						"INGEST_CONNECTED",
						"SLATE_ARMED",
						"DELIVERED",
						"UNKNOWN",
					],
				},
			},
			data: expect.objectContaining({
				outcome: "FAILED",
				outcomeNote: expect.stringMatching(/restart attempts are exhausted/),
			}),
		});
	});

	it("bind-evidence exhaustion closes one attempt, process, session, and schedule as one explicit failure", async () => {
		const s = setup({
			runHeartbeat: null,
			bindWatchdogSleeps: true,
			bindProbeIntervalMs: 1,
			bindTimeoutMs: 1,
			maxBindKills: 1,
		});
		const run = s.processor.process(startJob);
		await vi.waitFor(() => expect(s.spawned).toHaveLength(1));
		await vi.waitFor(() => expect(s.spawned[0]?.killed).toContain("SIGTERM"));
		s.spawned[0]?.exit(null, "SIGTERM");
		await expect(run).resolves.toMatchObject({ status: "ERROR" });

		expect(s.session).toMatchObject({
			status: "ERROR",
			pid: null,
			processGoneAt: new Date(NOW),
		});
		expect(s.session.error).toMatch(/bounded attempts/);
		expect(s.cleanup).toHaveBeenCalledTimes(1);
		expect(s.pushAttempts).toHaveLength(1);
		expect(s.pushAttempts[0]).toMatchObject({
			providerStatus: "UNKNOWN",
			providerAcceptedAt: null,
			endedAt: new Date(NOW),
			exitSignal: "SIGTERM",
		});
		expect(outcomeWrites(s.liveSchedule).at(-1)).toEqual({
			where: expect.objectContaining({ feederSessionId: SESSION_ID }),
			data: expect.objectContaining({
				outcome: "FAILED",
				outcomeNote: expect.stringMatching(/bounded attempts/),
			}),
		});
	});

	it("a CONNECTED sample from before this spawn stays recorded but never turns the schedule green", async () => {
		const s = setup({
			runHeartbeat: {
				at: new Date(Date.parse(NOW) - 1).toISOString(),
				raw: { ingest: { status: "CONNECTED" } },
			},
			bindWatchdogSleeps: true,
			bindProbeIntervalMs: 1,
			bindTimeoutMs: 1,
			maxBindKills: 1,
		});
		const run = s.processor.process(startJob);
		await vi.waitFor(() => expect(s.spawned).toHaveLength(1));
		await vi.waitFor(() => expect(s.spawned[0]?.killed).toContain("SIGTERM"));
		expect(
			outcomeWrites(s.liveSchedule).map((write) => write.data?.outcome),
		).not.toContain("INGEST_CONNECTED");
		expect(s.pushAttempts[0]).toMatchObject({
			providerStatus: "CONNECTED",
			providerSampleAt: null,
			providerAcceptedAt: null,
		});
		s.spawned[0]?.exit(null, "SIGTERM");
		await expect(run).resolves.toMatchObject({ status: "ERROR" });
		expect(outcomeWrites(s.liveSchedule).at(-1)?.data?.outcome).toBe("FAILED");
	});

	it("a post-spawn poll of a pre-spawn provider sample never turns the schedule green", async () => {
		const s = setup({
			runHeartbeat: {
				at: new Date(Date.parse(NOW) + 1).toISOString(),
				raw: {
					timestamp: new Date(Date.parse(NOW) - 1).toISOString(),
					ingest: { status: "CONNECTED" },
				},
			},
			bindWatchdogSleeps: true,
			bindProbeIntervalMs: 1,
			bindTimeoutMs: 1,
			maxBindKills: 1,
		});
		const run = s.processor.process(startJob);
		await vi.waitFor(() => expect(s.spawned).toHaveLength(1));
		await vi.waitFor(() => expect(s.spawned[0]?.killed).toContain("SIGTERM"));
		expect(
			outcomeWrites(s.liveSchedule).map((write) => write.data?.outcome),
		).not.toContain("INGEST_CONNECTED");
		expect(s.pushAttempts[0]).toMatchObject({
			providerStatus: "CONNECTED",
			providerSampleAt: new Date(Date.parse(NOW) - 1),
			providerAcceptedAt: null,
		});
		s.spawned[0]?.exit(null, "SIGTERM");
		await expect(run).resolves.toMatchObject({ status: "ERROR" });
	});

	it("a session that never reaches PUSHING writes FAILED and no DELIVERED at all", async () => {
		/**
		 * "Never connected" is the shape the audit's operator cares about: the
		 * row must not sit amber-forever pretending an answer is still coming
		 * when the session is already terminal.
		 */
		const s = setup({
			fetchSource: async () => {
				throw new Error("the source object could not be fetched");
			},
		});
		await expect(s.processor.process(startJob)).rejects.toThrow(
			/could not be fetched/,
		);
		expect(outcomeWrites(s.liveSchedule).map((w) => w.data?.outcome)).toEqual([
			"FAILED",
		]);
	});

	/**
	 *  (audit 2026-08-29 HIGH-4): the session's seal has to REACH the
	 * download, and what arrived has to be recorded. Enforcement itself is
	 * `fetch-source`'s; these pin the wiring, which nothing else does.
	 */
	it("hands the session's SEAL to the download as the version to demand", async () => {
		const seen: unknown[] = [];
		const s = setup({
			session: {
				sourceEtag: '"abc123"',
				sourceVersionId: "v-1",
				sourceGeneration: null,
				sourceSize: 9n,
			},
			fetchSource: async (a: unknown) => {
				seen.push(a);
				return {
					path: "/tmp/spool-test/src.mp4",
					sha256: FETCHED_SHA256,
					bytes: 9,
					pinned: true,
					cleanup: async () => {},
				};
			},
		});
		const run = s.processor.process(startJob);
		await vi.waitFor(() => expect(s.spawned).toHaveLength(1));
		expect(seen[0]).toMatchObject({
			expect: { etag: '"abc123"', versionId: "v-1", size: 9 },
		});
		await s.processor.process(stopJob);
		s.spawned[0]?.exit(null, "SIGTERM");
		await expect(run).resolves.toMatchObject({ status: "STOPPED" });
	});

	it("an UNSEALED session demands nothing — the pre-seal behaviour, unchanged", async () => {
		const seen: unknown[] = [];
		const s = setup({
			fetchSource: async (a: unknown) => {
				seen.push(a);
				return {
					path: "/tmp/spool-test/src.mp4",
					sha256: FETCHED_SHA256,
					bytes: 9,
					pinned: false,
					cleanup: async () => {},
				};
			},
		});
		const run = s.processor.process(startJob);
		await vi.waitFor(() => expect(s.spawned).toHaveLength(1));
		expect(seen[0]).not.toHaveProperty("expect");
		await s.processor.process(stopJob);
		s.spawned[0]?.exit(null, "SIGTERM");
		await expect(run).resolves.toMatchObject({ status: "STOPPED" });
	});

	it("records the downloaded bytes' SHA-256 on the session — the audit trail", async () => {
		const s = setup();
		const run = s.processor.process(startJob);
		await vi.waitFor(() => expect(s.spawned).toHaveLength(1));
		expect(s.session.sourceSha256).toBe(FETCHED_SHA256);
		await s.processor.process(stopJob);
		s.spawned[0]?.exit(null, "SIGTERM");
		await expect(run).resolves.toMatchObject({ status: "STOPPED" });
	});

	it("a version mismatch lands the session ERROR and its schedule row FAILED, naming both identities", async () => {
		const s = setup({
			fetchSource: async () => {
				throw new Error(
					'the object at media/loops/source.mp4 is no longer the version that was recorded — sealed at arm: etag "abc123", size 9; found now: etag "replaced", size 9',
				);
			},
		});
		await expect(s.processor.process(startJob)).rejects.toThrow(
			/no longer the version that was recorded/,
		);
		expect(s.session.status).toBe("ERROR");
		expect(outcomeWrites(s.liveSchedule).at(-1)?.data).toMatchObject({
			outcome: "FAILED",
			outcomeNote: expect.stringMatching(/sealed at arm.*found now/s),
		});
		expect(s.emitEvent).toHaveBeenCalledWith(
			expect.objectContaining({ kind: "FEEDER_ERROR" }),
		);
	});

	it("a stop during DOWNLOADING lands STOPPED without ever spawning ffmpeg", async () => {
		let releaseFetch: (() => void) | undefined;
		const cleanup = vi.fn(async () => {});
		const s = setup({
			fetchSource: () =>
				new Promise((resolve) => {
					releaseFetch = () =>
						resolve({
							path: "/tmp/spool-test/src.mp4",
							sha256: FETCHED_SHA256,
							bytes: 1024,
							pinned: true,
							cleanup,
						});
				}),
		});
		const run = s.processor.process(startJob);
		await vi.waitFor(() => expect(s.session.status).toBe("DOWNLOADING"));
		await vi.waitFor(() => expect(releaseFetch).toBeDefined());
		await expect(s.processor.process(stopJob)).resolves.toMatchObject({
			status: "STOPPING",
		});
		releaseFetch?.();
		await expect(run).resolves.toMatchObject({ status: "STOPPED" });
		expect(s.session.status).toBe("STOPPED");
		expect(s.spawned).toHaveLength(0);
		expect(cleanup).toHaveBeenCalled();
	});

	it("a stop during DOWNLOADING aborts the in-flight transfer promptly (signal threaded)", async () => {
		let seenSignal: AbortSignal | undefined;
		const s = setup({
			// Never resolves on its own — only the abort tears it down, like a
			// stalled multi-GB object download.
			fetchSource: (args) =>
				new Promise((_resolve, reject) => {
					seenSignal = args.signal;
					args.signal.addEventListener("abort", () =>
						reject(new Error("transfer aborted")),
					);
				}),
		});
		const run = s.processor.process(startJob);
		await vi.waitFor(() => expect(seenSignal).toBeDefined());
		expect(seenSignal?.aborted).toBe(false);
		await expect(s.processor.process(stopJob)).resolves.toMatchObject({
			status: "STOPPING",
		});
		expect(seenSignal?.aborted).toBe(true);
		// The abort-induced rejection resolves as a clean STOPPED, not ERROR.
		await expect(run).resolves.toMatchObject({ status: "STOPPED" });
		expect(s.session.status).toBe("STOPPED");
		expect(s.session.error).toBeNull();
		expect(s.spawned).toHaveLength(0);
	});

	it("a stop that lands STOPPED between the publisher claim and the PUSHING write tears the fresh push down (lost-stop race)", async () => {
		// Simulates the registry-miss interleaving AFTER the claim (LC-02 moved
		// the claim in front of the spawn, so this is the window that remains):
		// the row flips STOPPED once ffmpeg is spawned but before setPushing's
		// guarded transition (a stop consumed between the claim and
		// registry.set).
		const s = setup();
		const realSpawn = s.runner.spawn.bind(s.runner);
		s.runner.spawn = (bin, argv, events) => {
			const proc = realSpawn(bin, argv, events);
			s.session.status = "STOPPED";
			s.session.stoppedAt = new Date(NOW);
			return proc;
		};
		const run = s.processor.process(startJob);
		await vi.waitFor(() => expect(s.spawned).toHaveLength(1));
		const proc = s.spawned[0];
		// The guard matched zero rows → the controller stops the supervisor.
		await vi.waitFor(() => expect(proc?.killed).toContain("SIGTERM"));
		proc?.exit(null, "SIGTERM");
		await expect(run).resolves.toMatchObject({ status: "STOPPED" });
		expect(s.session.status).toBe("STOPPED");
		expect(s.session.pid).toBeNull();
		// The guarded transition never resurrected the row: the startedAt
		// stamp (which only follows a successful PUSHING claim) stayed null.
		expect(s.session.startedAt).toBeNull();
		// LC-02: the racing stop was a pid-null rewrite, NOT proof — the claim
		// this run took stayed held until the owner observed its child's exit,
		// which is what released it (and stamped the proof) here.
		expect(s.session.publisherReleasedAt).toEqual(new Date(NOW));
		expect(s.session.processGoneAt).toEqual(new Date(NOW));
	});

	it("a stop that lands STOPPED before the publisher claim never spawns at all (LC-02)", async () => {
		// The older shape of the race above: the row flips STOPPED during the
		// download. The claim CAS is fenced on DOWNLOADING, so it matches zero
		// rows, the run reads the stop, and no ffmpeg is ever started — the
		// stop is honoured one step earlier than it used to be.
		let flipToStopped: (() => void) | undefined;
		const s = setup({
			fetchSource: async () => {
				flipToStopped?.();
				return {
					path: "/tmp/spool-test/src.mp4",
					sha256: FETCHED_SHA256,
					bytes: 1024,
					pinned: true,
					cleanup: async () => {},
				};
			},
		});
		flipToStopped = () => {
			s.session.status = "STOPPED";
			s.session.stoppedAt = new Date(NOW);
		};
		await expect(s.processor.process(startJob)).resolves.toMatchObject({
			status: "STOPPED",
		});
		expect(s.spawned).toHaveLength(0);
		expect(s.session.status).toBe("STOPPED");
		expect(s.session.publisherClaimedAt).toBeNull();
		expect(s.session.startedAt).toBeNull();
		// Nothing spawned, so nothing was proven: no fabricated proof.
		expect(s.session.processGoneAt).toBeNull();
	});

	it("caps persisted loop boundaries at the configured window (most recent kept)", async () => {
		const s = setup({ loopBoundaryCap: 3 }); // source duration 30s
		const run = s.processor.process(startJob);
		await vi.waitFor(() => expect(s.spawned).toHaveLength(1));
		const proc = s.spawned[0];
		if (!proc) throw new Error("no spawn");
		proc.progress(1_000_000); // anchor → loop 0
		proc.progress(31_000_000); // wrap → loop 1
		proc.progress(61_000_000); // wrap → loop 2
		proc.progress(91_000_000); // wrap → loop 3 (cap engages)
		proc.progress(121_000_000); // wrap → loop 4
		await vi.waitFor(() => {
			const persisted = s.session.loopBoundaries as { loopIndex: number }[];
			expect(persisted.map((b) => b.loopIndex)).toEqual([2, 3, 4]);
		});
		await s.processor.process(stopJob);
		proc.exit(null, "SIGTERM");
		await expect(run).resolves.toMatchObject({ status: "STOPPED" });
		// Strictly increasing indices keep the trimmed head detectable.
		const persisted = s.session.loopBoundaries as { loopIndex: number }[];
		expect(persisted).toHaveLength(3);
		expect(persisted[0]?.loopIndex).toBe(2);
	});
});

describe("feeder processor — stop", () => {
	it("registry miss: verified kill — a pid that dies within the grace gets SIGTERM but never SIGKILL", async () => {
		let termed = false;
		const s = setup({
			session: { status: "PUSHING", pid: 4242 },
			killPid: (_pid, signal) => {
				if (signal === 0 && termed) {
					throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
				}
				if (signal === "SIGTERM") {
					termed = true;
				}
			},
		});
		await expect(s.processor.process(stopJob)).resolves.toMatchObject({
			status: "STOPPED",
		});
		const signals = s.killPid.mock.calls.map((c) => c[1]);
		expect(signals).toContain(0); // existence probes
		expect(signals).toContain("SIGTERM");
		expect(signals).not.toContain("SIGKILL");
		expect(s.session.status).toBe("STOPPED");
		expect(s.session.pid).toBeNull();
	});

	/**
	 * Review HIGH — the landing state is the ladder's ANSWER, not the attempt.
	 *
	 * This arm used to assert STOPPED with the pid released after an EXHAUSTED
	 * ladder, which is the same end-state CRITICAL-2 is about, reached by a
	 * different trigger: `feederProcessMayBeAlive` goes false, DELETE becomes
	 * legal, and the boot sweep — which finds rows by `pid IS NOT NULL` —
	 * can never see that pid again, while ffmpeg keeps pushing and billing.
	 */
	it("registry miss: a pid that survives SIGKILL lands ERROR and KEEPS its pid — no unearned proof", async () => {
		// Default killPid never throws → the probe always reports alive.
		const s = setup({
			session: { status: "PUSHING", pid: 4242, ownerHost: HOST },
		});
		await expect(s.processor.process(stopJob)).resolves.toMatchObject({
			status: "ERROR",
		});
		const signals = s.killPid.mock.calls.map((c) => c[1]);
		expect(signals).toEqual([0, "SIGTERM", 0, "SIGKILL", 0]); // ladder order
		expect(s.killPid.mock.calls.every((c) => c[0] === 4242)).toBe(true);
		// ERROR, not STOPPED: the operator asked for a stop and did not get one.
		expect(s.session.status).toBe("ERROR");
		expect(s.session.pid).toBe(4242);
		expect(s.session.ownerHost).toBe(HOST);
		expect(s.session.processGoneAt).toBeNull();
		expect(s.session.error).toContain("NOT confirmed gone");
		// Still visible to every reclaim path: the DELETE guard, the next stop
		// and the boot sweep all key off exactly this predicate.
		expect(feederProcessMayBeAlive(s.session as never)).toBe(true);
		// : ERROR is the state that notifies, whichever writer lands it.
		expect(s.emitEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: "FEEDER_ERROR",
				feederSessionId: SESSION_ID,
				liveChannelId: CHANNEL_ID,
			}),
		);
	});

	it("registry miss: a VERIFIED kill lands STOPPED, releases the pid and stamps the proof", async () => {
		let termed = false;
		const s = setup({
			session: { status: "PUSHING", pid: 4242 },
			killPid: (_pid, signal) => {
				if (signal === 0 && termed) {
					throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
				}
				if (signal === "SIGTERM") {
					termed = true;
				}
			},
		});
		await expect(s.processor.process(stopJob)).resolves.toMatchObject({
			status: "STOPPED",
		});
		expect(s.session.status).toBe("STOPPED");
		expect(s.session.pid).toBeNull();
		expect(s.session.ownerHost).toBeNull();
		expect(s.session.processGoneAt).toEqual(new Date(NOW));
		expect(feederProcessMayBeAlive(s.session as never)).toBe(false);
		// A clean stop is not an incident — nothing to notify about.
		expect(s.emitEvent).not.toHaveBeenCalled();
	});

	it("registry miss: an immediately-ESRCH pid persists STOPPED directly (no signals sent)", async () => {
		const s = setup({
			session: { status: "PUSHING", pid: 4242 },
			killPid: () => {
				throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
			},
		});
		await expect(s.processor.process(stopJob)).resolves.toMatchObject({
			status: "STOPPED",
		});
		// One existence probe, then straight to persistence.
		expect(s.killPid.mock.calls).toEqual([[4242, 0]]);
		expect(s.session.status).toBe("STOPPED");
	});

	it("is idempotent on terminal rows (route + channel-coupling double stop)", async () => {
		const s = setup({ session: { status: "STOPPED" } });
		await expect(s.processor.process(stopJob)).resolves.toMatchObject({
			status: "STOPPED",
		});
		expect(s.killPid).not.toHaveBeenCalled();
		const s2 = setup({ session: { status: "ERROR" } });
		await expect(s2.processor.process(stopJob)).resolves.toMatchObject({
			status: "ERROR",
		});
	});

	it("acknowledges unknown sessions without inventing rows", async () => {
		const s = setup();
		await expect(
			s.processor.process({
				feederSessionId: "00000000-0000-4000-8000-00000000dead",
				action: "stop",
			}),
		).resolves.toMatchObject({ status: "MISSING" });
	});
});

/**
 * Audit 2026-08-29 CRITICAL-2 — the reclaim path for a session whose START
 * job died OUTSIDE the worker.
 *
 * The dead-job handler (apps/worker/src/index.ts) marks such a session ERROR
 * and KEEPS its pid on purpose: a `-stream_loop -1` ffmpeg outlives the worker
 * that spawned it, and the pid is the only pointer to it. Every product path
 * then read ERROR as "nothing to do" — stop returned before this ladder — so
 * the process pushed into a live ingest with no way to reach it.
 *
 * These arms pin what a stop is now allowed to CLAIM about that pid, which is
 * the whole point: an unverified kill that stamps "gone" is worse than no
 * stamp at all, because the DELETE guard hangs off exactly that stamp.
 */
describe("feeder processor — stop reclaims a dead job's orphaned ffmpeg", () => {
	const errored = (session: Row = {}): Row => ({
		status: "ERROR",
		pid: 4242,
		ownerHost: HOST,
		error:
			"Worker lost the session (job stalled) — a pushing ffmpeg may be orphaned at pid 4242 — check it",
		...session,
	});

	it("ERROR + a live pid on this host: runs the kill ladder, keeps ERROR, stamps the proof and releases the pid", async () => {
		let termed = false;
		const s = setup({
			session: errored(),
			killPid: (_pid, signal) => {
				if (signal === 0 && termed) {
					throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
				}
				if (signal === "SIGTERM") {
					termed = true;
				}
			},
		});
		await expect(s.processor.process(stopJob)).resolves.toMatchObject({
			status: "ERROR",
		});
		const signals = s.killPid.mock.calls.map((c) => c[1]);
		expect(signals).toContain(0);
		expect(signals).toContain("SIGTERM");
		expect(s.killPid.mock.calls.every((c) => c[0] === 4242)).toBe(true);
		// The run DID fail — rewriting that to STOPPED would erase the only
		// record of it. What changes is the process ledger.
		expect(s.session.status).toBe("ERROR");
		expect(s.session.pid).toBeNull();
		expect(s.session.ownerHost).toBeNull();
		expect(s.session.processGoneAt).toEqual(new Date(NOW));
		expect(s.session.error).toContain("is gone");
		// The original failure text survives alongside the reclaim note.
		expect(s.session.error).toContain("Worker lost the session");
	});

	it("ERROR + a pid that is already gone: proves absence with one probe and sends no signal", async () => {
		const s = setup({
			session: errored(),
			killPid: () => {
				throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
			},
		});
		await expect(s.processor.process(stopJob)).resolves.toMatchObject({
			status: "ERROR",
		});
		expect(s.killPid.mock.calls).toEqual([[4242, 0]]);
		expect(s.session.pid).toBeNull();
		expect(s.session.processGoneAt).toEqual(new Date(NOW));
	});

	it("ERROR + a pid that survives SIGKILL: KEEPS the pid and says it was not confirmed gone", async () => {
		// Default killPid never throws → the probe always reports alive.
		const s = setup({ session: errored() });
		await expect(s.processor.process(stopJob)).resolves.toMatchObject({
			status: "ERROR",
		});
		expect(s.killPid.mock.calls.map((c) => c[1])).toEqual([
			0,
			"SIGTERM",
			0,
			"SIGKILL",
			0,
		]);
		// No proof ⇒ no stamp: the row still "may own a process", so DELETE
		// keeps refusing it and the stop can be retried.
		expect(s.session.pid).toBe(4242);
		expect(s.session.processGoneAt).toBeNull();
		expect(s.session.error).toContain("NOT confirmed gone");
	});

	it("ERROR + a pid on ANOTHER host: signals nothing and records where the process lives", async () => {
		const s = setup({ session: errored({ ownerHost: "worker-b" }) });
		await expect(s.processor.process(stopJob)).resolves.toMatchObject({
			status: "ERROR",
		});
		// A pid is a bare number off its own host: signalling it here would
		// kill whatever local process happens to be wearing 4242.
		expect(s.killPid).not.toHaveBeenCalled();
		expect(s.session.pid).toBe(4242);
		expect(s.session.processGoneAt).toBeNull();
		expect(s.session.error).toContain("worker-b");
		expect(s.session.error).toContain(HOST);
	});

	it("ERROR + a RECYCLED pid: kills nothing, and treats the reuse as proof our ffmpeg exited", async () => {
		const s = setup({
			session: errored(),
			readProcessCommand: async () => "/usr/sbin/nginx -g daemon off;",
		});
		await expect(s.processor.process(stopJob)).resolves.toMatchObject({
			status: "ERROR",
		});
		expect(s.killPid).not.toHaveBeenCalled();
		expect(s.session.pid).toBeNull();
		expect(s.session.processGoneAt).toEqual(new Date(NOW));
		expect(s.session.error).toContain("unrelated process");
	});

	it("ERROR + a pid whose command line IS our ffmpeg: the veto does not fire and the ladder runs", async () => {
		const s = setup({
			session: errored(),
			readProcessCommand: async () =>
				`ffmpeg -hide_banner -nostdin -re -stream_loop -1 -i /tmp/spool-test/${SESSION_ID}.mp4 -c copy -f flv rtmp://203.0.113.7/live/sk`,
			killPid: () => {
				throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
			},
		});
		await s.processor.process(stopJob);
		expect(s.killPid).toHaveBeenCalled();
		expect(s.session.processGoneAt).toEqual(new Date(NOW));
	});

	it("a concurrent stop that got there first keeps its own proof (guarded write matches zero rows)", async () => {
		// Review LOW-1: the reclaim write is optimistic — `processGoneAt: null`
		// in its WHERE — because two stops can reach one row. Here the other
		// writer lands between our read and our write; ours must match nothing
		// and leave the winner's stamp and note exactly as they are.
		const holder: { row?: Row } = {};
		const OTHER_NOW = "2026-06-11T00:00:00.000Z";
		const s = setup({
			session: errored(),
			killPid: () => {
				const row = holder.row;
				if (row && row.processGoneAt === null) {
					Object.assign(row, {
						pid: null,
						ownerHost: null,
						processGoneAt: new Date(OTHER_NOW),
						error: "the other stop reclaimed it",
					});
				}
				throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
			},
		});
		holder.row = s.session;
		await expect(s.processor.process(stopJob)).resolves.toMatchObject({
			status: "ERROR",
		});
		// Not overwritten with OUR timestamp or OUR note.
		expect(s.session.processGoneAt).toEqual(new Date(OTHER_NOW));
		expect(s.session.error).toBe("the other stop reclaimed it");
		expect(s.session.pid).toBeNull();
	});

	it("a reclaimed row is idempotent: a second stop runs no ladder at all", async () => {
		const s = setup({
			session: errored({ pid: null, processGoneAt: new Date(NOW) }),
		});
		await expect(s.processor.process(stopJob)).resolves.toMatchObject({
			status: "ERROR",
		});
		expect(s.killPid).not.toHaveBeenCalled();
	});

	/**
	 * review-365 I-4 — a cross-host stop used to be a NOTE and nothing else.
	 *
	 * This arm previously pinned that as correct ("never marked STOPPED — that
	 * would lie about a live push"). The claim was true of the PROCESS and left
	 * the OPERATOR with no stop at all: the job completes, nothing retries, and
	 * with N replicas the queue hands the stop to a non-owner (N−1)/N of the
	 * time. The lease supplies the lever that was missing — revoke the owner's
	 * authority and the push ends within one renewal — so the row now lands
	 * STOPPED while the PROCESS ledger keeps saying exactly what is known.
	 */
	it("an ACTIVE row owned by another host is STOPPED by revoking the owner's generation, with the pid kept", async () => {
		const s = setup({
			session: {
				status: "PUSHING",
				pid: 4242,
				ownerHost: "worker-b",
				ownerId: OWNER_B,
				ownerGeneration: 7,
			},
		});
		await expect(s.processor.process(stopJob)).resolves.toMatchObject({
			status: "STOPPED",
		});
		// Nothing was signalled: a pid on another host is a bare number here.
		expect(s.killPid).not.toHaveBeenCalled();
		expect(s.session.status).toBe("STOPPED");
		// The FENCE: the owner's next renewal cannot match this row any more.
		expect(s.session.ownerGeneration).toBe(8);
		// And we did not take the session over — only retired it.
		expect(s.session.ownerId).toBe(OWNER_B);
		// The process ledger is untouched, so DELETE still refuses the row
		// until that host proves the pid gone.
		expect(s.session.pid).toBe(4242);
		expect(s.session.ownerHost).toBe("worker-b");
		expect(s.session.processGoneAt).toBeNull();
		expect(feederProcessMayBeAlive(s.session as never)).toBe(true);
		// The note still names the host to check.
		expect(s.session.error).toContain("worker-b");
	});
});

describe("feeder processor — stopAll (worker shutdown)", () => {
	it("signals every running supervisor so ffmpeg children do not outlive the worker", async () => {
		const s = setup();
		const run = s.processor.process(startJob);
		await vi.waitFor(() => expect(s.spawned).toHaveLength(1));
		expect(s.processor.stopAll()).toEqual([SESSION_ID]);
		const proc = s.spawned[0];
		expect(proc?.killed).toContain("SIGTERM");
		proc?.exit(null, "SIGTERM");
		await expect(run).resolves.toMatchObject({ status: "STOPPED" });
	});
});

/**
 *  — the ingest preflight, pinned at the PROCESSOR.
 *
 * `command.test.ts` already exercises the pure check. That is not the thing
 * that failed: the whole point of #46 is that a correct helper one hop from
 * the shipping path is worth nothing. What these assert is that the processor
 * REACHES it, and reaches it before spawning ffmpeg.
 */
describe("createFeederProcessor — ingest preflight (ledger #46)", () => {
	/** Declares a video ingest and an audio ingest — the redundant-RTMP shape. */
	const PLAN_WANTING_AUDIO = {
		ingest: [
			{ key: "video", position: 0 },
			{ key: "audio", position: 1 },
		],
		renditions: [
			{ ingestKey: "video", codec: "H264" },
			{ ingestKey: "audio", codec: "AAC" },
		],
	};
	/** b01.mov: h264, then a tmcd TIMECODE track. No audio. */
	const PROBE_VIDEO_ONLY = {
		streams: [
			{ codec_type: "video", codec_name: "h264", pix_fmt: "yuv420p" },
			{ codec_type: "data", codec_name: "tmcd" },
		],
		format: { duration: "45.0" },
	};

	it("fails the session with the reason, and never spawns ffmpeg", async () => {
		const s = setup({
			channelStatus: "RUNNING",
			channelPlan: PLAN_WANTING_AUDIO,
			probe: { code: 0, stdout: JSON.stringify(PROBE_VIDEO_ONLY), stderr: "" },
		});

		// Same shape as the ffprobe-failure path above: the job rejects and the
		// row lands ERROR carrying the reason.
		await expect(s.processor.process(startJob)).rejects.toThrow(
			/ingestUnsatisfied/,
		);
		expect(s.session.status).toBe("ERROR");

		// The spawn is the assertion that matters: the check has to happen
		// BEFORE it, or the session pushes into a void exactly as it did.
		expect(s.spawned).toHaveLength(0);

		// : the refusal is stored STRUCTURED — the code plus the dynamic
		// problem detail as a param, not the English sentence. The panel
		// translates the wrapper ("… publish nothing") around this detail.
		// Reverting the writer to an English sentence makes `parseFeederError`
		// return null → `parsed?.code` undefined → red.
		const parsed = parseFeederError(String(s.session.error ?? ""));
		expect(parsed?.code).toBe("ingestUnsatisfied");
		const detail = String(parsed?.params.detail ?? "");
		expect(detail).toContain('ingest "audio" needs audio');
		// Names what the source DOES carry, so the operator can see why.
		expect(detail).toContain("data");
	});

	it("proceeds normally when the source satisfies the plan", async () => {
		const s = setup({
			channelStatus: "RUNNING",
			channelPlan: PLAN_WANTING_AUDIO,
			// PROBE_COPY is video at 0, audio at 1 — satisfies it.
		});
		const run = s.processor.process(startJob);
		await vi.waitFor(() => expect(s.spawned).toHaveLength(1));
		await s.processor.process(stopJob);
		s.spawned[0]?.exit(null, "SIGTERM");
		await expect(run).resolves.toMatchObject({ status: "STOPPED" });
	});

	it("does not block a push when the channel has no readable plan", async () => {
		// channelPlan defaults to null: an unreadable or unmodelled plan is not
		// a reason to refuse, so behaviour is identical to before the check.
		const s = setup({ channelStatus: "RUNNING" });
		const run = s.processor.process(startJob);
		await vi.waitFor(() => expect(s.spawned).toHaveLength(1));
		await s.processor.process(stopJob);
		s.spawned[0]?.exit(null, "SIGTERM");
		await expect(run).resolves.toMatchObject({ status: "STOPPED" });
	});
});

describe("mayKeepPushing (review-260 127-A3/A4 — the watchdog's no-kill-on-no-information invariant)", () => {
	const T = Date.parse("2026-08-18T00:00:00.000Z");
	const wrap = (status: string, atMsAgo: number) => ({
		at: new Date(T - atMsAgo).toISOString(),
		raw: { ingest: { status } },
		deltas: {},
	});

	it("classifies fresh provider evidence without collapsing UNKNOWN into success", () => {
		expect(mayKeepPushing(wrap("WAITING_FOR_FIRST_CONNECT", 10_000), T)).toBe(
			"DISCONNECTED",
		);
		expect(mayKeepPushing(wrap("CONNECTED", 10_000), T)).toBe("CONNECTED");
	});

	it("stale, missing, or malformed samples are no-information — the push keeps running", () => {
		// The revived run's pre-error CONNECTED sample and a sweep outage both
		// land here: staleness must not shoot a healthy push.
		expect(
			mayKeepPushing(wrap("WAITING_FOR_FIRST_CONNECT", 10 * 60_000), T),
		).toBe("UNKNOWN");
		expect(mayKeepPushing(null, T)).toBe("UNKNOWN");
		expect(mayKeepPushing({ raw: {} }, T)).toBe("UNKNOWN");
	});

	it("a broken clock is no-information — the push keeps running (127-A4)", () => {
		expect(
			mayKeepPushing(wrap("WAITING_FOR_FIRST_CONNECT", 10_000), Number.NaN),
		).toBe("UNKNOWN");
	});

	// the freshness gate is SYMMETRIC. A
	// FUTURE stamp beyond the shared skew tolerance describes a moment that has
	// not happened — no-information, NOT a fresh explicit failure. The old
	// one-sided check scored its negative age as fresh and restarted a HEALTHY
	// feeder on a future WAITING_FOR_FIRST_CONNECT.
	it("a future WAITING sample beyond the skew tolerance is no-information — a healthy feeder is NOT restarted (row #270)", () => {
		// One hour ahead: the exact clock-skew shape that faked freshness and
		// killed a healthy push under the dropped lower bound.
		expect(
			mayKeepPushing(wrap("WAITING_FOR_FIRST_CONNECT", -60 * 60_000), T),
		).toBe("UNKNOWN");
		// A future CONNECTED sample cannot vouch either; its keep-pushing
		// verdict is the same, so the WAITING arm above is the discriminating
		// one — dropping the lower bound flips ONLY the WAITING arm.
		expect(mayKeepPushing(wrap("CONNECTED", -60 * 60_000), T)).toBe("UNKNOWN");
	});

	it("a future sample WITHIN the skew tolerance is fresh — a WAITING there still stops the push", () => {
		// Inside [-skew, 0]: ordinary NTP drift, treated as fresh, so a genuine
		// #95 WAITING that is merely skew-early still kills and restarts.
		expect(
			mayKeepPushing(
				wrap(
					"WAITING_FOR_FIRST_CONNECT",
					-(HEARTBEAT_FUTURE_SKEW_TOLERANCE_MS - 1),
				),
				T,
			),
		).toBe("DISCONNECTED");
	});

	it("the future skew boundary is exact to ±1 ms", () => {
		// atMsAgo = -TOL → at = T + TOL → age = -TOL → age >= -TOL is TRUE →
		// fresh → a WAITING stops the push.
		expect(
			mayKeepPushing(
				wrap("WAITING_FOR_FIRST_CONNECT", -HEARTBEAT_FUTURE_SKEW_TOLERANCE_MS),
				T,
			),
		).toBe("DISCONNECTED");
		// One ms further ahead → age < -TOL → NOT fresh → no-information → keep
		// pushing. This single ms IS the lower bound  restores.
		expect(
			mayKeepPushing(
				wrap(
					"WAITING_FOR_FIRST_CONNECT",
					-(HEARTBEAT_FUTURE_SKEW_TOLERANCE_MS + 1),
				),
				T,
			),
		).toBe("UNKNOWN");
	});

	it("the past maxAge boundary is exact to ±1 ms — a past sample within maxAge is still fresh", () => {
		// age = maxAge → fresh → a WAITING stops the push.
		expect(
			mayKeepPushing(
				wrap("WAITING_FOR_FIRST_CONNECT", INGEST_CONNECTED_MAX_AGE_MS),
				T,
			),
		).toBe("DISCONNECTED");
		// age = maxAge + 1 → stale → no-information → keep pushing.
		expect(
			mayKeepPushing(
				wrap("WAITING_FOR_FIRST_CONNECT", INGEST_CONNECTED_MAX_AGE_MS + 1),
				T,
			),
		).toBe("UNKNOWN");
	});
});

describe("the watchdog closure AS WIRED (review-260 127-B3)", () => {
	it("drives the real closure: run-first selection, clock parse, freshness — through the real prisma read", async () => {
		capturedSupervisorDeps.length = 0;
		const s = setup();
		const run = s.processor.process(startJob);
		await vi.waitFor(() => expect(s.spawned).toHaveLength(1));
		const deps = capturedSupervisorDeps[0];
		expect(deps?.mayKeepPushing).toBeTypeOf("function");
		const probe = deps?.mayKeepPushing;
		if (!probe) {
			throw new Error("closure not captured");
		}

		// NOW is the harness clock ("2026-06-12T00:00:00.000Z"). A fresh
		// WAITING sample on the exact session run = the #95 shape → false.
		s.run.lastHeartbeat = {
			at: new Date(Date.parse(NOW) - 10_000).toISOString(),
			raw: { ingest: { status: "WAITING_FOR_FIRST_CONNECT" } },
			deltas: {},
		};
		await expect(probe()).resolves.toMatchObject({
			status: "DISCONNECTED",
		});

		// Stale WAITING = no information → keep pushing (127-A3).
		s.run.lastHeartbeat = {
			at: new Date(Date.parse(NOW) - 10 * 60_000).toISOString(),
			raw: { ingest: { status: "WAITING_FOR_FIRST_CONNECT" } },
			deltas: {},
		};
		await expect(probe()).resolves.toMatchObject({ status: "UNKNOWN" });

		// Presence-level, as wired: a run row exists with a null sample — the
		// channel's fresh WAITING must NOT be borrowed.
		s.run.lastHeartbeat = null;
		s.channel.lastHeartbeat = {
			at: new Date(Date.parse(NOW) - 10_000).toISOString(),
			raw: { ingest: { status: "WAITING_FOR_FIRST_CONNECT" } },
			deltas: {},
		};
		await expect(probe()).resolves.toMatchObject({ status: "UNKNOWN" });

		// And a run row carrying its own fresh WAITING kills again.
		s.run.lastHeartbeat = {
			at: new Date(Date.parse(NOW) - 5_000).toISOString(),
			raw: { ingest: { status: "WAITING_FOR_FIRST_CONNECT" } },
			deltas: {},
		};
		await expect(probe()).resolves.toMatchObject({ status: "DISCONNECTED" });

		// Wind down the push.
		const stop = await s.processor.process(stopJob);
		expect(stop.status).toBe("STOPPING");
		s.spawned[0]?.exit(null, "SIGTERM");
		await expect(run).resolves.toMatchObject({ status: "STOPPED" });
	});

	it("never borrows a successor run's advancing heartbeat for the session-bound spawn", async () => {
		capturedSupervisorDeps.length = 0;
		const s = setup();
		const running = s.processor.process(startJob);
		await vi.waitFor(() => expect(s.spawned).toHaveLength(1));
		const probe = capturedSupervisorDeps[0]?.mayKeepPushing;
		if (!probe) throw new Error("closure not captured");

		// The session is bound to run-1, which has no heartbeat. A re-air has
		// already created run-2 and its provider poll is advancing CONNECTED.
		// The old implementation selected `runs orderBy seq desc take 1`, so it
		// incorrectly returned CONNECTED for the old feeder.
		s.run.lastHeartbeat = null;
		s.channel.bitmovinEncodingId = "enc-2";
		s.channel.runs = [
			{
				id: "run-2",
				lastHeartbeat: {
					at: "2026-06-12T00:00:01.000Z",
					raw: {
						timestamp: "2026-06-12T00:00:01.000Z",
						ingest: { status: "CONNECTED" },
					},
					deltas: {},
				},
			},
		];
		await expect(probe()).resolves.toMatchObject({ status: "UNKNOWN" });

		// Even the exact id is insufficient if that row does not belong to this
		// channel/provider tuple.
		s.channel.bitmovinEncodingId = "enc-1";
		s.run.liveChannelId = "00000000-0000-4000-8000-0000000000bc";
		s.run.lastHeartbeat = {
			at: "2026-06-12T00:00:02.000Z",
			raw: {
				timestamp: "2026-06-12T00:00:02.000Z",
				ingest: { status: "CONNECTED" },
			},
			deltas: {},
		};
		await expect(probe()).resolves.toMatchObject({ status: "UNKNOWN" });

		// The callback also re-proves the owner/session binding. A takeover or
		// session rebind cannot retain a positive sample captured by this owner.
		s.run.liveChannelId = CHANNEL_ID;
		s.session.ownerId = OWNER_B;
		s.run.lastHeartbeat = {
			at: "2026-06-12T00:00:02.000Z",
			raw: {
				timestamp: "2026-06-12T00:00:02.000Z",
				ingest: { status: "CONNECTED" },
			},
			deltas: {},
		};
		await expect(probe()).resolves.toMatchObject({ status: "UNKNOWN" });

		s.spawned[0]?.exit(null, "SIGTERM");
		await expect(running).resolves.toMatchObject({ status: "TAKEN_OVER" });
	});
});

describe("createFeederProcessor — source compatibility gate (ledger #239)", () => {
	const RUN_ID = "00000000-0000-4000-8000-0000000000a1";

	/**
	 * What the 2026-08-29 paid run was ingesting when the switch fired.
	 *
	 * These are the BEFORE side of the negative control's own heartbeat
	 * warning — audit §3.2, `30000/1001 → 24/1`, `77 → 100`, `41 → 40`,
	 * `1920x1080 → 1920x1012` — and NOT §3.1, whose positive-control pair
	 * both ran at 24 fps: H264 Main / level 41 / yuv420p / 1920x1080 /
	 * 29.97, AAC 48 kHz stereo after the RTMP downmix.
	 */
	const RECORDED_REFERENCE = {
		video: {
			codec: "h264",
			width: 1920,
			height: 1080,
			frameRate: 30000 / 1001,
			frameRateText: "30000/1001",
			profile: "Main",
			level: 41,
			pixelFormat: "yuv420p",
		},
		audio: [{ codec: "aac", sampleRate: 48000, channels: 2 }],
	};

	/** The source the audit switched TO — h264/yuv420p, so it takes the copy path. */
	const PROBE_INCOMPATIBLE = {
		streams: [
			{
				codec_type: "video",
				codec_name: "h264",
				profile: "High",
				level: 40,
				pix_fmt: "yuv420p",
				width: 1920,
				height: 1012,
				r_frame_rate: "24/1",
			},
			{
				codec_type: "audio",
				codec_name: "aac",
				sample_rate: "48000",
				channels: 2,
			},
		],
		format: { duration: "121.0" },
	};

	/** The positive control: the same attributes, a different programme. */
	const PROBE_MATCHING = {
		streams: [
			{
				codec_type: "video",
				codec_name: "h264",
				profile: "Main",
				level: 41,
				pix_fmt: "yuv420p",
				width: 1920,
				height: 1080,
				r_frame_rate: "30000/1001",
			},
			{
				codec_type: "audio",
				codec_name: "aac",
				sample_rate: "48000",
				channels: 2,
			},
		],
		format: { duration: "45.0" },
	};

	it("normalizes the switch that used to freeze the picture onto the run's reference — the push is copy and never changes the encoder's stream (row #256)", async () => {
		const s = setup({
			session: { liveChannelRunId: RUN_ID },
			runIngestMedia: RECORDED_REFERENCE,
			probe: {
				code: 0,
				stdout: JSON.stringify(PROBE_INCOMPATIBLE),
				stderr: "",
			},
		});
		const run = s.processor.process(startJob);
		await vi.waitFor(() => expect(s.spawned).toHaveLength(1));
		// the normalizer pinned the loop to the reference …
		const norm =
			normalizeArgvByLoop
				.get(`/tmp/spool-test/${SESSION_ID}.loop.mp4`)
				?.join(" ") ?? "";
		expect(norm).toContain("-s 1920x1080");
		expect(norm).toMatch(/-r (30000\/1001|29\.97)/);
		expect(norm).toContain("-profile:v main");
		// … and the push copies the loop, never the raw source
		const push = s.spawned[0]?.argv.join(" ") ?? "";
		expect(push).toContain(`-i /tmp/spool-test/${SESSION_ID}.loop.mp4`);
		expect(push).toContain("-c copy");
		expect(push).not.toContain("-c:v");
		const profile = s.session.loopProfile as {
			mode?: string;
			frames?: number;
			normalise?: Record<string, unknown>;
		} | null;
		expect(profile?.mode).toBe("normalized");
		expect(profile?.frames).toBeGreaterThan(0);
		// the pins the loop was encoded with ride in the profile, so the VMAF
		// side can rebuild the same loop when the spool copy is gone
		expect(profile?.normalise).toMatchObject({
			width: 1920,
			height: 1080,
			profile: "main",
			sampleRate: 48000,
			channels: 2,
		});
		await s.processor.process(stopJob);
		s.spawned[0]?.exit(null, "SIGTERM");
		await expect(run).resolves.toMatchObject({ status: "STOPPED" });
	});

	it("rev429 R1: a stop during the normalize aborts the transcode (signal threaded) and lands STOPPED without a push", async () => {
		const s = setup({
			session: { liveChannelRunId: RUN_ID },
			runIngestMedia: RECORDED_REFERENCE,
			probe: {
				code: 0,
				stdout: JSON.stringify(PROBE_INCOMPATIBLE),
				stderr: "",
			},
			normalizeHangs: true,
		});
		const run = s.processor.process(startJob);
		await vi.waitFor(() => expect(lastNormalizeSignal).toBeDefined());
		expect(lastNormalizeSignal?.aborted).toBe(false);
		await expect(s.processor.process(stopJob)).resolves.toMatchObject({
			status: "STOPPING",
		});
		expect(lastNormalizeSignal?.aborted).toBe(true);
		await expect(run).resolves.toMatchObject({ status: "STOPPED" });
		expect(s.session.status).toBe("STOPPED");
		expect(s.spawned).toHaveLength(0);
	});

	it("rev429 R2: a failing normalize lands ERROR with the ffmpeg tail, never spawns a push, and notifies", async () => {
		const s = setup({
			session: { liveChannelRunId: RUN_ID },
			normalizeExit: 1,
		});
		await expect(s.processor.process(startJob)).rejects.toThrow(
			/normalizing the source loop failed \(code 1\): Conversion failed!/,
		);
		expect(s.spawned).toHaveLength(0);
		expect(s.session.status).toBe("ERROR");
		const event = (
			s.emitEvent.mock.calls as unknown as ReadonlyArray<
				[{ kind: string; error?: string }]
			>
		)
			.map((call) => call[0])
			.find((e) => e.kind === "FEEDER_ERROR");
		expect(event?.error).toContain("normalizing the source loop failed");
	});

	it("rev429 R2: a takeover whose loop does not reproduce the profile this session already pushed is refused before any spawn", async () => {
		const s = setup({
			session: {
				liveChannelRunId: RUN_ID,
				loopProfile: {
					version: 1,
					mode: "normalized",
					fps: 30,
					frames: 100,
					loopSeconds: 100 / 30,
					audioEndSec: 100 / 30,
					sourceSha256: "a".repeat(64),
					normalizer: { version: 1 },
					recordedAt: "2026-09-07T00:00:00.000Z",
				},
			},
		});
		await expect(s.processor.process(startJob)).rejects.toThrow(
			/does not reproduce the profile this session already pushed \(100 at 30\)/,
		);
		expect(s.spawned).toHaveLength(0);
		expect(s.session.status).toBe("ERROR");
	});

	it("rev429 R2: a loop whose probe shows no video stream is refused, never pushed", async () => {
		const s = setup({
			session: { liveChannelRunId: RUN_ID },
			loopProbe: {
				code: 0,
				stdout: JSON.stringify({ streams: [] }),
				stderr: "",
			},
		});
		await expect(s.processor.process(startJob)).rejects.toThrow(
			/normalized loop has no video stream/,
		);
		expect(s.spawned).toHaveLength(0);
		expect(s.session.status).toBe("ERROR");
	});

	//  review: the SAME refusal reaches locale-less notification
	// surfaces (Slack, the schedule-outcome note) that were built for the old
	// English sentence — so those render the ENGLISH, while the DB `error`
	// column keeps the STRUCTURED payload the panels localize.
	it("emits the refusal to Slack and the schedule note as ENGLISH, keeping the row STRUCTURED", async () => {
		// : geometry/rate differences are now normalized away, so the
		// refusal that still exists is the one the normalizer cannot pin — a
		// reference profile x264 cannot produce in yuv420p.
		const s = setup({
			session: { liveChannelRunId: RUN_ID },
			runIngestMedia: {
				...RECORDED_REFERENCE,
				video: { ...RECORDED_REFERENCE.video, profile: "High 10" },
			},
			probe: { code: 0, stdout: JSON.stringify(PROBE_MATCHING), stderr: "" },
		});
		await expect(s.processor.process(startJob)).rejects.toThrow(
			/sourceMismatch/,
		);

		expect(parseFeederError(String(s.session.error ?? ""))?.code).toBe(
			"sourceMismatch",
		);

		const event = (
			s.emitEvent.mock.calls as unknown as ReadonlyArray<
				[{ kind: string; error?: string }]
			>
		)
			.map((call) => call[0])
			.find((e) => e.kind === "FEEDER_ERROR");
		expect(event?.error).toContain(
			"does not match what this channel is ingesting",
		);
		expect(event?.error).toContain("the source this run started on");
		expect(event?.error).not.toContain("sourceMismatch");
		expect(event?.error).not.toContain('{"code"');

		const note = outcomeWrites(s.liveSchedule).at(-1)?.data?.outcomeNote;
		expect(note).toContain("does not match what this channel is ingesting");
		expect(note).not.toContain("sourceMismatch");
	});

	it("accepts the exact-compatible source (the A/B's positive control)", async () => {
		const s = setup({
			session: { liveChannelRunId: RUN_ID },
			runIngestMedia: RECORDED_REFERENCE,
			probe: { code: 0, stdout: JSON.stringify(PROBE_MATCHING), stderr: "" },
		});
		const run = s.processor.process(startJob);
		await vi.waitFor(() => expect(s.spawned).toHaveLength(1));
		await s.processor.process(stopJob);
		s.spawned[0]?.exit(null, "SIGTERM");
		await expect(run).resolves.toMatchObject({ status: "STOPPED" });
	});

	it("uses the encoder's own heartbeat when nothing was recorded — the loop is pinned to it (row #256)", async () => {
		const s = setup({
			session: { liveChannelRunId: RUN_ID },
			runHeartbeat: {
				at: NOW,
				raw: {
					ingest: {
						status: "CONNECTED",
						streams: [
							{ mediaType: "VIDEO", width: 1920, height: 1080, rate: 29.97 },
							{ mediaType: "AUDIO", numberOfAudioChannels: 2 },
						],
					},
				},
			},
			probe: {
				code: 0,
				stdout: JSON.stringify(PROBE_INCOMPATIBLE),
				stderr: "",
			},
		});
		const run = s.processor.process(startJob);
		await vi.waitFor(() => expect(s.spawned).toHaveLength(1));
		const norm =
			normalizeArgvByLoop
				.get(`/tmp/spool-test/${SESSION_ID}.loop.mp4`)
				?.join(" ") ?? "";
		expect(norm).toContain("-s 1920x1080");
		expect(norm).toContain("-r 29.97");
		// a heartbeat carries no profile, so none is pinned
		expect(norm).not.toContain("-profile:v");
		await s.processor.process(stopJob);
		s.spawned[0]?.exit(null, "SIGTERM");
		await expect(run).resolves.toMatchObject({ status: "STOPPED" });
	});

	it("records the run's reference once — a later push cannot redefine it", async () => {
		const s = setup({
			session: { liveChannelRunId: RUN_ID },
			probe: { code: 0, stdout: JSON.stringify(PROBE_MATCHING), stderr: "" },
		});
		const run = s.processor.process(startJob);
		await vi.waitFor(() => expect(s.spawned).toHaveLength(1));
		// The first push defines what every later one is checked against.
		expect(s.run.ingestMedia).toMatchObject({
			video: { width: 1920, height: 1080, profile: "Main", level: 41 },
			audio: [{ codec: "aac", sampleRate: 48000, channels: 2 }],
		});
		await s.processor.process(stopJob);
		s.spawned[0]?.exit(null, "SIGTERM");
		await expect(run).resolves.toMatchObject({ status: "STOPPED" });

		// A second session on the same run: the CAS keeps the first reference,
		// so a switch can never overwrite the thing it was just checked against.
		const s2 = setup({
			session: { liveChannelRunId: RUN_ID },
			runIngestMedia: RECORDED_REFERENCE,
			probe: { code: 0, stdout: JSON.stringify(PROBE_MATCHING), stderr: "" },
		});
		const run2 = s2.processor.process(startJob);
		await vi.waitFor(() => expect(s2.spawned).toHaveLength(1));
		expect(s2.run.ingestMedia).toBe(RECORDED_REFERENCE);
		await s2.processor.process(stopJob);
		s2.spawned[0]?.exit(null, "SIGTERM");
		await expect(run2).resolves.toMatchObject({ status: "STOPPED" });
	});

	it("locks on a DateTime, never on the Json column (row #254, the live-to-VOD sentinel finding — PR #349)", async () => {
		// The CAS's SHAPE, not its effect.  (PR #349) measured
		// `{ equals: Prisma.DbNull }` matching NOTHING against a SQL-NULL Json
		// column in the deployed bundled image while the same predicate
		// matched from a plain process. The failure would be SILENT here —
		// zero rows matched is indistinguishable from "another push won the
		// race", so the reference would never be recorded and the gate would
		// stand down forever. Asserting the predicate is the only way to see
		// it: no behavioural test can, because both spellings behave
		// identically in-process, which is exactly what #254 was about.
		const s = setup({
			session: { liveChannelRunId: RUN_ID },
			probe: { code: 0, stdout: JSON.stringify(PROBE_MATCHING), stderr: "" },
		});
		const run = s.processor.process(startJob);
		await vi.waitFor(() => expect(s.spawned).toHaveLength(1));

		expect(s.runUpdateWheres).toHaveLength(1);
		const where = s.runUpdateWheres[0] as Record<string, unknown>;
		expect(where).toEqual({
			id: RUN_ID,
			ingestMediaRecordedAt: null,
		});
		// Named explicitly, so re-introducing a Json-column predicate under
		// any spelling — DbNull, JsonNull, AnyNull — goes red here.
		expect(where).not.toHaveProperty("ingestMedia");
		// And the lock is written in the SAME update as what it guards, so
		// the two can never disagree.
		expect(s.run.ingestMediaRecordedAt).toBeInstanceOf(Date);
		expect(s.run.ingestMedia).not.toBeNull();

		await s.processor.process(stopJob);
		s.spawned[0]?.exit(null, "SIGTERM");
		await expect(run).resolves.toMatchObject({ status: "STOPPED" });
	});

	it("pins the NORMALIZED loop onto the reference instead of refusing the source (row #256: the pins live in the normalizer, the push is copy)", async () => {
		const s = setup({
			session: { liveChannelRunId: RUN_ID },
			runIngestMedia: RECORDED_REFERENCE,
			probe: {
				code: 0,
				stdout: JSON.stringify({
					streams: [
						{
							codec_type: "video",
							codec_name: "hevc",
							pix_fmt: "yuv420p10le",
							width: 1280,
							height: 720,
							r_frame_rate: "25/1",
						},
						{
							codec_type: "audio",
							codec_name: "ac3",
							sample_rate: "44100",
							channels: 6,
						},
					],
					format: { duration: "60.0" },
				}),
				stderr: "",
			},
		});
		const run = s.processor.process(startJob);
		await vi.waitFor(() => expect(s.spawned).toHaveLength(1));
		const norm =
			normalizeArgvByLoop
				.get(`/tmp/spool-test/${SESSION_ID}.loop.mp4`)
				?.join(" ") ?? "";
		expect(norm).toContain("-s 1920x1080");
		expect(norm).toMatch(/-r (30000\/1001|29\.97)/);
		expect(norm).toContain("-profile:v main");
		expect(norm).toContain("-ar 48000");
		expect(norm).toContain("-ac 2");
		const push = s.spawned[0]?.argv.join(" ") ?? "";
		expect(push).toContain("-c copy");
		expect(push).not.toContain("-s 1920x1080");
		await s.processor.process(stopJob);
		s.spawned[0]?.exit(null, "SIGTERM");
		await expect(run).resolves.toMatchObject({ status: "STOPPED" });
	});

	it("refuses an UNPINNABLE profile through the real path, in TRANSCODE mode", async () => {
		// PR #352 BLOCKER. The unit table proved this rule against a candidate
		// built by `sourceMediaAttributes`; production builds it with
		// `pushedMediaAttributes`, which dropped `profile` whenever there was
		// no pin to carry — so the profile branch of the comparison could not
		// evaluate at all and the gate passed on the one attribute it was
		// asked about. A rule tested through a shape the caller never
		// constructs is not tested.
		//
		// The run is bound to High 10, which maps to no x264 token, so the
		// transcode cannot emit `-profile:v` and the encoder WOULD see the
		// change. Everything else is deliberately identical: geometry, frame
		// rate and pixel format all match, so profile is the only variable and
		// a pass here can only mean the profile was never compared.
		const s = setup({
			session: { liveChannelRunId: RUN_ID },
			runIngestMedia: {
				...RECORDED_REFERENCE,
				video: { ...RECORDED_REFERENCE.video, profile: "High 10" },
			},
			probe: {
				code: 0,
				stdout: JSON.stringify({
					streams: [
						{
							codec_type: "video",
							// hevc forces TRANSCODE; the transcode then re-encodes
							// to h264, so the codec itself is NOT the difference.
							codec_name: "hevc",
							profile: "Main",
							pix_fmt: "yuv420p",
							width: 1920,
							height: 1080,
							r_frame_rate: "30000/1001",
						},
						{
							codec_type: "audio",
							codec_name: "aac",
							sample_rate: "48000",
							channels: 2,
						},
					],
					format: { duration: "60.0" },
				}),
				stderr: "",
			},
		});

		await expect(s.processor.process(startJob)).rejects.toThrow(
			/sourceMismatch/,
		);
		expect(s.spawned).toHaveLength(0);
		// : the profile diff rides in the structured `differences` param.
		const parsed = parseFeederError(String(s.session.error ?? ""));
		expect(parsed?.code).toBe("sourceMismatch");
		expect(parsed?.differences).toContainEqual({
			attribute: "H.264 profile",
			reference: "High 10",
			candidate: "Main",
			blocking: true,
		});
		expect(parsed?.params.differences).toContain(
			"H.264 profile High 10 → Main",
		);
	});

	it("stands down when the run has neither a reference nor a heartbeat", async () => {
		// Nothing to compare against is not a reason to refuse: behaviour is
		// identical to before the gate existed.
		const s = setup({
			session: { liveChannelRunId: RUN_ID },
			probe: {
				code: 0,
				stdout: JSON.stringify(PROBE_INCOMPATIBLE),
				stderr: "",
			},
		});
		const run = s.processor.process(startJob);
		await vi.waitFor(() => expect(s.spawned).toHaveLength(1));
		await s.processor.process(stopJob);
		s.spawned[0]?.exit(null, "SIGTERM");
		await expect(run).resolves.toMatchObject({ status: "STOPPED" });
	});

	it("a session with no run reads the CHANNEL's heartbeat, never a run's — and pins the loop to it (row #256)", async () => {
		// The manual-feeder-on-a-never-run-channel shape: liveChannelRunId is
		// null, so the channel column is the only thing the sample could mean.
		// : the geometry difference is normalized away, so the proof
		// that the CHANNEL heartbeat was read is the normalizer's pins; the
		// push itself is then refused by the spawn guard (no exact run).
		const s = setup({
			session: { liveChannelRunId: null },
			channelHeartbeat: {
				at: NOW,
				raw: {
					ingest: {
						status: "CONNECTED",
						streams: [
							{ mediaType: "VIDEO", width: 1920, height: 1080, rate: 29.97 },
						],
					},
				},
			},
			probe: {
				code: 0,
				stdout: JSON.stringify(PROBE_INCOMPATIBLE),
				stderr: "",
			},
		});
		await expect(s.processor.process(startJob)).rejects.toThrow(
			/not bound to an exact live run/,
		);
		expect(s.spawned).toHaveLength(0);
		const norm =
			normalizeArgvByLoop
				.get(`/tmp/spool-test/${SESSION_ID}.loop.mp4`)
				?.join(" ") ?? "";
		expect(norm).toContain("-s 1920x1080");
		expect(norm).toContain("-r 29.97");
	});
});

/**
 *  — the OWNER LEASE (audit 2026-08-29 HIGH-5).
 *
 * Every arm here is a fact about TWO processes, which is what the finding is:
 * the registry that knew who was pushing lived in one of them. The second
 * worker is a real `createFeederProcessor` over the SAME fake database, with
 * its own instance id, its own host and its own clock — never a re-implemented
 * takeover.
 *
 * Timing arms resolve on OBSERVED renewals and observed spawns, never on a
 * delay: a ticker raced against a fixed sleep passes alone and fails under the
 * full gate.
 */
describe("feeder processor — ownership lease (row #242)", () => {
	/** An advancing clock: one millisecond per read. */
	const advancingClock = (fromIso = NOW) => {
		let ms = Date.parse(fromIso);
		return () => {
			ms += 1;
			return new Date(ms).toISOString();
		};
	};

	/** The renewal writes, recognised by their SHAPE (lease and nothing else). */
	const renewals = (feederSession: {
		updateMany: { mock: { calls: unknown[][] } };
	}): Date[] =>
		feederSession.updateMany.mock.calls
			.map((call) => call[0] as { data: Record<string, unknown> })
			.filter(
				(arg) =>
					Object.keys(arg.data).length === 1 && "ownerLeaseAt" in arg.data,
			)
			.map((arg) => arg.data.ownerLeaseAt as Date);

	/**
	 * review-365 I-2, the DURATION half — pinned as arithmetic, deliberately.
	 *
	 * Stopping a resumed session is SIGTERM -> `KILL_GRACE_MS` -> SIGKILL -> a
	 * terminal write, so the shutdown drain's budget has to CONTAIN the grace
	 * window with room left over. A wall-clock arm for that would measure the
	 * machine under the parallel gate rather than the budget (this repo already
	 * has a ``asyncUtilTimeout` raised from 1 s to 10 s (apps/web setup.ts) and a 20 s vitest `testTimeout` — two different ceilings for exactly that reason),
	 * so the property is asserted against the two real constants instead, and
	 * the drain's ORDERING/naming behaviour is pinned in lifecycle.test.ts.
	 *
	 * DERIVED, not spelled: raising the grace cannot silently outgrow the
	 * budget that has to contain it.
	 */
	it("the takeover drain's budget contains the kill grace with margin", () => {
		expect(FEEDER_TAKEOVER_DRAIN_MS).toBeGreaterThan(KILL_GRACE_MS);
		// A margin for the terminal write and its emit, not a second grace
		// window — the timeout is a bound, not a target.
		expect(FEEDER_TAKEOVER_DRAIN_MS - KILL_GRACE_MS).toBeGreaterThanOrEqual(
			5_000,
		);
	});

	/**
	 * review-365 I-3 — SELF-FENCING.
	 *
	 * "A throw is not a lost lease" was safe while nothing else could take the
	 * session. The cross-host takeover this row added is exactly something
	 * else, and it does not kill first — it cannot signal a pid on another
	 * machine. So a worker that is alive and pushing but cannot reach Postgres
	 * for longer than the takeover window is, from every other worker's point
	 * of view, gone: B claims and spawns, and both push until A's next
	 * SUCCESSFUL renewal.
	 *
	 * Both arms drive an INJECTED clock and resolve on OBSERVED renewal
	 * ATTEMPTS. Nothing here waits on wall time.
	 */
	const controllableClock = (fromIso = NOW) => {
		let ms = Date.parse(fromIso);
		return {
			now: () => new Date(ms).toISOString(),
			advance: (delta: number) => {
				ms += delta;
			},
		};
	};

	/** Renewal writes ISSUED, whether they landed, lost or threw. */
	const renewalAttempts = (feederSession: {
		updateMany: { mock: { calls: unknown[][] } };
	}): number =>
		feederSession.updateMany.mock.calls.filter((call) => {
			const data = (call[0] as { data: Record<string, unknown> }).data;
			return Object.keys(data).length === 1 && "ownerLeaseAt" in data;
		}).length;

	it("keeps pushing when renewals THROW for less than the takeover window", async () => {
		const clock = controllableClock();
		let failing = true;
		const s = setup({
			leaseRenewalIntervalMs: 1,
			now: clock.now,
			leaseWritesFail: () => failing,
		});
		const run = s.processor.process(startJob);
		await vi.waitFor(() => expect(s.spawned).toHaveLength(1));

		// A blip that stays INSIDE the window: no other worker could have
		// claimed this session yet, so standing down would be a self-inflicted
		// outage.
		clock.advance(FEEDER_LEASE_TAKEOVER_MS - 1);
		const before = renewalAttempts(s.feederSession);
		await vi.waitFor(() =>
			expect(renewalAttempts(s.feederSession)).toBeGreaterThanOrEqual(
				before + 3,
			),
		);
		expect(s.spawned.at(0)?.killed).toEqual([]);

		// The database comes back and the lease resumes moving.
		failing = false;
		await vi.waitFor(() => expect(s.session.ownerLeaseAt).toBeInstanceOf(Date));
		expect(s.session.status).toBe("PUSHING");

		await s.processor.process(stopJob);
		s.spawned.at(0)?.exit(0, "SIGTERM");
		await expect(run).resolves.toMatchObject({ status: "STOPPED" });
	});

	it("stands down — writing NOTHING — when renewals throw for longer than the window", async () => {
		const clock = controllableClock();
		const s = setup({
			leaseRenewalIntervalMs: 1,
			now: clock.now,
			leaseWritesFail: () => true,
		});
		const run = s.processor.process(startJob);
		await vi.waitFor(() => expect(s.spawned).toHaveLength(1));
		expect(s.session.status).toBe("PUSHING");

		// Past the window: from every other worker's side this session is
		// takeable, so the owner must stop before it becomes a second pusher.
		clock.advance(FEEDER_LEASE_TAKEOVER_MS + 1);
		await vi.waitFor(() =>
			expect(s.spawned.at(0)?.killed).toContain("SIGTERM"),
		);
		s.spawned.at(0)?.exit(255, "SIGTERM");
		await expect(run).resolves.toMatchObject({ status: "TAKEN_OVER" });

		// NOTHING written. The fence would still MATCH this row — nobody
		// actually took it in this arm — so only the stand-down itself keeps
		// the postmortem off a row a takeover is about to claim.
		expect(s.session.status).toBe("PUSHING");
		expect(s.session.ownerId).toBe(OWNER_A);
		expect(s.session.stoppedAt).toBeNull();
		expect(s.emitEvent).not.toHaveBeenCalled();
		expect(
			outcomeWrites(s.liveSchedule).map((write) => write.data?.outcome),
		).not.toContain("FAILED");
	});

	/**
	 * The other half of self-fencing, and the one that makes
	 * `lastRenewedOkMs = tickMs` load-bearing: a LANDING renewal must refresh
	 * the confirmation.
	 *
	 * Found by mutation — dropping that assignment survived every arm above,
	 * because none of them let the clock run past the window while renewals
	 * were succeeding. Without it, EVERY push in the product tears itself down
	 * one window after it starts, healthy database and all.
	 *
	 * The clock moves in steps SMALLER than the window with an observed
	 * renewal between them, because that is what a running system does. A
	 * single jump larger than the window is a different fact — nothing
	 * confirmed the lease across it — and the owner is right to stand down
	 * there.
	 */
	it("a healthy push survives a clock running far past the window", async () => {
		const clock = controllableClock();
		const s = setup({ leaseRenewalIntervalMs: 1, now: clock.now });
		const run = s.processor.process(startJob);
		await vi.waitFor(() => expect(s.spawned).toHaveLength(1));

		const step = Math.floor(FEEDER_LEASE_TAKEOVER_MS / 2);
		for (let elapsed = 0; elapsed < FEEDER_LEASE_TAKEOVER_MS * 2; ) {
			const before = renewalAttempts(s.feederSession);
			clock.advance(step);
			elapsed += step;
			// Resolve on renewals SEEN across the step, never on a delay.
			await vi.waitFor(() =>
				expect(renewalAttempts(s.feederSession)).toBeGreaterThanOrEqual(
					before + 2,
				),
			);
			expect(s.spawned.at(0)?.killed).toEqual([]);
		}
		expect(s.session.status).toBe("PUSHING");

		await s.processor.process(stopJob);
		s.spawned.at(0)?.exit(0, "SIGTERM");
		await expect(run).resolves.toMatchObject({ status: "STOPPED" });
	});

	it("does not stand down on an unreadable clock (no information is not a stale lease)", async () => {
		const s = setup({
			leaseRenewalIntervalMs: 1,
			now: () => "not a timestamp",
			leaseWritesFail: () => true,
		});
		const run = s.processor.process(startJob);
		await vi.waitFor(() => expect(s.spawned).toHaveLength(1));
		const before = renewalAttempts(s.feederSession);
		await vi.waitFor(() =>
			expect(renewalAttempts(s.feederSession)).toBeGreaterThanOrEqual(
				before + 3,
			),
		);
		expect(s.spawned.at(0)?.killed).toEqual([]);

		await s.processor.process(stopJob);
		s.spawned.at(0)?.exit(0, "SIGTERM");
		await run;
	});

	/**
	 * review-365 I-4, end to end: the stop reaches the PUSH, not just the row.
	 *
	 * With N replicas the feeder queue hands a stop to a worker that is not the
	 * owner (N−1)/N of the time, and that worker cannot signal a pid on another
	 * machine. Revoking the generation is what turns "I cannot reach it" into
	 * "it stops anyway": the owner's next renewal — at most one interval away —
	 * matches zero rows and tears the push down itself.
	 */
	it("a stop consumed on ANOTHER host ends the owner's push within one renewal", async () => {
		const s = setup({ leaseRenewalIntervalMs: 1 });
		const runA = s.processor.process(startJob);
		await vi.waitFor(() => expect(s.spawned).toHaveLength(1));
		expect(s.session.ownerHost).toBe(HOST);
		expect(s.session.ownerGeneration).toBe(1);

		// The operator's stop is delivered to a worker on another host.
		const workerB = s.makeProcessor({ ownerId: OWNER_B, hostname: "worker-b" });
		await expect(workerB.process(stopJob)).resolves.toMatchObject({
			status: "STOPPED",
		});
		expect(s.session.ownerGeneration).toBe(2);
		expect(s.killPid).not.toHaveBeenCalled();

		// A's next renewal loses, and A stops pushing on its own.
		await vi.waitFor(() =>
			expect(s.spawned.at(0)?.killed).toContain("SIGTERM"),
		);
		s.spawned.at(0)?.exit(255, "SIGTERM");
		await expect(runA).resolves.toMatchObject({ status: "TAKEN_OVER" });

		// The stop STANDS: the loser wrote nothing terminal over it. What it
		// DID write is proof (rev367 I-4): its supervisor reaped the child
		// before `run` resolved, so the one process that could ever verify
		// the pid stamps it gone, fence-free — the delete guard releases
		// honestly instead of holding a pid nobody could check, and a
		// cross-host switch's barrier can complete on it.
		expect(s.session.status).toBe("STOPPED");
		expect(s.session.pid).toBeNull();
		expect(s.session.processGoneAt).toEqual(new Date(NOW));
	});

	/**
	 * review-365 S-4: the loser's registry entry outlives its lease.
	 *
	 * `runSession`'s `finally` deletes it, and that does not run until the
	 * ffmpeg has actually exited. A stop landing in that window used to be
	 * answered STOPPING by a supervisor that no longer owned anything, while
	 * the new owner kept pushing — and nothing retried, because the stop job
	 * had completed successfully.
	 */
	it("a stop is NOT consumed by a supervisor that has already lost its lease", async () => {
		const s = setup({ leaseRenewalIntervalMs: 1 });
		const runA = s.processor.process(startJob);
		await vi.waitFor(() => expect(s.spawned).toHaveLength(1));

		// Somebody else claimed the row (the shape a takeover leaves behind).
		s.session.ownerId = OWNER_B;
		s.session.ownerGeneration = 2;
		s.session.ownerHost = "worker-b";
		// A has noticed and is winding down, but its ffmpeg has not exited, so
		// its controller is still in this process's registry.
		await vi.waitFor(() =>
			expect(s.spawned.at(0)?.killed).toContain("SIGTERM"),
		);

		// The stop must go to the DATABASE, not to the loser sitting in the
		// registry — STOPPING would be an answer about a push nobody owns.
		const result = await s.processor.process(stopJob);
		expect(result.status).not.toBe("STOPPING");
		expect(result.status).toBe("STOPPED");
		expect(s.session.status).toBe("STOPPED");
		expect(s.session.ownerGeneration).toBe(3);

		s.spawned.at(0)?.exit(255, "SIGTERM");
		await expect(runA).resolves.toMatchObject({ status: "TAKEN_OVER" });
		expect(s.session.status).toBe("STOPPED");
	});

	it("takes the lease with the CREATED claim and renews it on a ticker", async () => {
		const s = setup({ leaseRenewalIntervalMs: 1, now: advancingClock() });
		const run = s.processor.process(startJob);
		await vi.waitFor(() => expect(s.spawned).toHaveLength(1));
		// The claim and the lease are ONE write: a claimed session is never
		// momentarily ownerless, so no sweep can see it as abandoned.
		expect(s.session.ownerId).toBe(OWNER_A);
		expect(s.session.ownerGeneration).toBe(1);
		expect(s.session.ownerLeaseAt).toBeInstanceOf(Date);

		// Resolve on SEEN renewals, then assert the lease actually moves —
		// a ticker that fires and writes the same instant forever would keep
		// no session alive.
		await vi.waitFor(() =>
			expect(renewals(s.feederSession).length).toBeGreaterThanOrEqual(3),
		);
		const seen = renewals(s.feederSession);
		expect(seen.at(-1)?.getTime() ?? 0).toBeGreaterThan(
			seen.at(0)?.getTime() ?? 0,
		);
		// The CLAIM compare-and-swaps on the generation it READ (0), so a
		// takeover landing between the read and the claim wins rather than
		// being overwritten with a stale number.
		const wheres = s.feederSession.updateMany.mock.calls.map(
			(call) => (call[0] as { where: Record<string, unknown> }).where,
		);
		expect(wheres.at(0)).toMatchObject({
			status: "CREATED",
			ownerGeneration: 0,
		});
		// And every write AFTER it carries the pair this run holds — the fence
		// is what makes a superseded owner's late write match zero rows.
		const fenced = wheres.filter((where) => where.ownerId !== undefined);
		expect(fenced.length).toBeGreaterThan(0);
		for (const where of fenced) {
			expect(where).toMatchObject({ ownerId: OWNER_A, ownerGeneration: 1 });
		}

		await s.processor.process(stopJob);
		s.spawned[0]?.exit(0, "SIGTERM");
		await run;
		// Terminal releases the lease; the generation is monotonic and stays.
		expect(s.session.ownerId).toBeNull();
		expect(s.session.ownerLeaseAt).toBeNull();
		expect(s.session.ownerGeneration).toBe(1);
	});

	it("stops pushing and writes NOTHING terminal when the lease is lost", async () => {
		const s = setup({ leaseRenewalIntervalMs: 1 });
		const run = s.processor.process(startJob);
		await vi.waitFor(() => expect(s.spawned).toHaveLength(1));

		// Somebody else claimed the row (the shape a takeover leaves behind).
		s.session.ownerId = OWNER_B;
		s.session.ownerGeneration = 2;
		s.session.ownerHost = "worker-b";

		// The losing renewal tears the push down — otherwise two ffmpegs push
		// into one ingest, which is the failure the whole lease exists for.
		await vi.waitFor(() => expect(s.spawned[0]?.killed).toContain("SIGTERM"));
		s.spawned[0]?.exit(255, "SIGTERM");
		await expect(run).resolves.toMatchObject({ status: "TAKEN_OVER" });

		// And it lands NOTHING: the row is the winner's, and a terminal write
		// here would bury a healthy session under its predecessor's postmortem.
		expect(s.session.status).toBe("PUSHING");
		expect(s.session.ownerId).toBe(OWNER_B);
		expect(s.session.stoppedAt).toBeNull();
		expect(s.emitEvent).not.toHaveBeenCalled();
		expect(
			outcomeWrites(s.liveSchedule).map((w) => w.data?.outcome),
		).not.toContain("FAILED");
	});

	it("REFUSES to resume a live pid on ANOTHER host it cannot prove gone — no second push, a terminal ERROR", async () => {
		const s = setup({ leaseRenewalIntervalMs: 1 });
		const runA = s.processor.process(startJob);
		await vi.waitFor(() => expect(s.spawned).toHaveLength(1));
		expect(s.session.ownerHost).toBe(HOST);
		expect(s.session.pid).toBe(5000);

		// Worker B: a different instance, a different host, a clock ten minutes
		// on — so A's lease is three renewal windows stale from where B stands.
		// A's pid is on worker-a and unreachable from here: NOTHING here can
		// prove that push stopped, and a network partition could have it still
		// pushing. §16-2 — a replacement must not spawn on a bare note.
		const workerB = s.makeProcessor({
			ownerId: OWNER_B,
			hostname: "worker-b",
			now: () => new Date(Date.parse(NOW) + 10 * 60_000).toISOString(),
			leaseRenewalIntervalMs: 1,
		});
		// Nothing taken over, and — the whole point — NO second ffmpeg.
		await expect(workerB.takeOverStale()).resolves.toEqual([]);
		expect(s.spawned).toHaveLength(1);
		// RETIRED, not resumed: ERROR (which notifies), the old owner revoked by
		// a generation bump, and B is NOT its owner (no ownership transfer).
		expect(s.session.status).toBe("ERROR");
		expect(s.session.ownerId).toBe(OWNER_A);
		expect(s.session.ownerGeneration).toBe(2);
		// The pid STAYS with no proof, so `feederProcessMayBeAlive` is still true
		// and DELETE keeps refusing the row until that host accounts for it.
		expect(s.session.pid).toBe(5000);
		expect(s.session.ownerHost).toBe(HOST);
		expect(s.session.processGoneAt).toBeNull();
		expect(String(s.session.error)).toContain("cannot prove");
		expect(String(s.session.error)).toContain("second push");
		// Nothing was signalled — a pid on another host is a bare number here.
		expect(s.killPid).not.toHaveBeenCalled();
		// ERROR notifies : an operator whose push could not be
		// safely resumed must be told, not left reading a green STOPPED.
		expect(s.emitEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: "FEEDER_ERROR",
				feederSessionId: SESSION_ID,
			}),
		);

		// The generation bump REVOKES A: its next renewal (1ms cadence) matches
		// zero rows, it self-fences its own ffmpeg down, and its lease-lost path
		// stamps the proof that finally releases the pid on the ERROR row.
		await vi.waitFor(() => expect(s.spawned[0]?.killed).toContain("SIGTERM"));
		s.spawned[0]?.exit(255, "SIGTERM");
		await expect(runA).resolves.toMatchObject({ status: "TAKEN_OVER" });
		await vi.waitFor(() => expect(s.session.pid).toBeNull());
		expect(s.session.processGoneAt).toBeInstanceOf(Date);
		// Still no second push, ever, and the row stays the ERROR it was retired
		// to — the old owner's proof released the pid, it did not resurrect it.
		expect(s.spawned).toHaveLength(1);
		expect(s.session.status).toBe("ERROR");
	});

	it("RESUMES a cross-host session whose previous push was PROVEN gone (processGoneAt stamped) — #240's completion path", async () => {
		// The revoked owner's lease-lost path  nulls the pid AND
		// stamps processGoneAt in ONE write, so a proven-gone cross-host push
		// arrives at the sweep with pid NULL — the safe branch. This is the
		// takeover the BLOCKER-5 refusal must NOT block; it stays green while
		// the refusal arm above goes red under the mutation.
		//
		// (This slot once pinned rev367 P2 — the proof write's host term, which
		// kept a pid REUSED across a cross-host takeover from being nulled by
		// the old owner's proof. That collision needed the takeover to re-spawn
		// a live cross-host pid, exactly what the BLOCKER-5 refusal now forbids:
		// a proven-gone takeover re-spawns only AFTER the old proof already
		// fired, so it can never collide. The host term stays in the proof write
		// as defense for this completion path.)
		const s = setup({
			session: {
				status: "PUSHING",
				// Released by the old owner's proof write, together with its host.
				pid: null,
				ownerHost: null,
				// The proof: the old owner noticed, tore down, and stamped it.
				processGoneAt: new Date(Date.parse(NOW)),
				ownerId: "worker-a/999/deadbeef",
				ownerGeneration: 4,
				ownerLeaseAt: new Date(Date.parse(NOW)),
			},
		});
		const workerB = s.makeProcessor({
			ownerId: OWNER_B,
			hostname: "worker-b",
			now: () => new Date(Date.parse(NOW) + 10 * 60_000).toISOString(),
		});
		// Proven gone → resumed. Nothing to kill (the pid was already released).
		await expect(workerB.takeOverStale()).resolves.toEqual([SESSION_ID]);
		expect(s.session.ownerId).toBe(OWNER_B);
		expect(s.session.ownerGeneration).toBe(5);
		expect(s.session.status).toBe("DOWNLOADING");
		// The note names the proof, so a reader can tell a proven-gone resume
		// from a never-spawned one.
		expect(String(s.session.error)).toContain("proven gone");
		expect(s.killPid).not.toHaveBeenCalled();
		await vi.waitFor(() => expect(s.spawned).toHaveLength(1));

		await workerB.process(stopJob);
		s.spawned[0]?.exit(0, "SIGTERM");
		await workerB.drainTakeovers();
		expect(s.session.status).toBe("STOPPED");
	});

	/**
	 * The FENCE on `markTerminal`, which the arms above could not reach.
	 *
	 * Found by mutation: replacing that write's `where: fence` with
	 * `where: { id }` SURVIVED the whole suite, because every other lease arm
	 * takes the `controller.leaseLost` early return and never reaches the
	 * write at all. The dangerous case is the one where the loser never
	 * NOTICED — its renewal is not due, or it finishes between two ticks — and
	 * then lands its own postmortem on the winner's live row: status ERROR, a
	 * FEEDER_ERROR incident, and the schedule row written off, for a push that
	 * is pushing.
	 *
	 * So worker A here has a renewal interval longer than the test: nothing
	 * tells it anything, and only the fence stands between it and the row.
	 */
	it("a superseded owner that never NOTICED still cannot write the winner's row", async () => {
		// `maxRestarts: 0` so A's first unexpected exit is TERMINAL: the arm
		// needs A to reach `markTerminal`'s ERROR branch, and a respawn would
		// have its own fenced `setPushing` notice the loss first and turn the
		// run into a quiet STOPPED — a second guard, but not the one under test.
		// B takes over on the SAME host, so the verified kill ladder can PROVE
		// A's pid gone — post BLOCKER-5, that is the only legitimate way for B to
		// own the row while A's supervisor is still alive and unaware (a
		// cross-host takeover of A's LIVE pid now refuses). A never learns the
		// lease loss (its renewal interval outlasts the test); it only sees its
		// own ffmpeg exit and reaches markTerminal with a stale generation.
		const alive = new Set([5000]);
		const s = setup({
			leaseRenewalIntervalMs: 60_000,
			maxRestarts: 0,
			killPid: (pid, signal) => {
				if (!alive.has(pid)) {
					throw new Error("ESRCH");
				}
				if (signal === "SIGKILL") {
					alive.delete(pid);
				}
			},
			readProcessCommand: async () =>
				`ffmpeg -re -stream_loop -1 -i /tmp/spool-test/${SESSION_ID}.mp4`,
		});
		const runA = s.processor.process(startJob);
		await vi.waitFor(() => expect(s.spawned).toHaveLength(1));

		const workerB = s.makeProcessor({
			ownerId: OWNER_B,
			now: () => new Date(Date.parse(NOW) + 10 * 60_000).toISOString(),
			leaseRenewalIntervalMs: 60_000,
		});
		await expect(workerB.takeOverStale()).resolves.toEqual([SESSION_ID]);
		await vi.waitFor(() => expect(s.session.status).toBe("PUSHING"));
		expect(s.session.pid).toBe(5001);

		// Now A's push fails for good, while A still believes it owns the
		// session.
		s.spawned[0]?.exit(1);
		await expect(runA).resolves.toMatchObject({ status: "ERROR" });

		// Nothing of A's landed: not the status, not the incident, not the
		// schedule outcome.
		expect(s.session.status).toBe("PUSHING");
		expect(s.session.ownerId).toBe(OWNER_B);
		expect(s.session.pid).toBe(5001);
		expect(s.session.stoppedAt).toBeNull();
		expect(s.emitEvent).not.toHaveBeenCalled();
		expect(
			outcomeWrites(s.liveSchedule).map((write) => write.data?.outcome),
		).not.toContain("FAILED");

		await workerB.process(stopJob);
		s.spawned[1]?.exit(0, "SIGTERM");
		await workerB.drainTakeovers();
	});

	it("leaves a session whose lease is still FRESH alone", async () => {
		// A renewal interval longer than the test: the only lease on the row is
		// the claim's, so the arm turns on the WINDOW and nothing else.
		const s = setup({ leaseRenewalIntervalMs: 60_000 });
		const runA = s.processor.process(startJob);
		await vi.waitFor(() => expect(s.spawned).toHaveLength(1));

		const workerB = s.makeProcessor({
			ownerId: OWNER_B,
			hostname: "worker-b",
			now: () => new Date(Date.parse(NOW) + 1_000).toISOString(),
		});
		await expect(workerB.takeOverStale()).resolves.toEqual([]);
		expect(s.spawned).toHaveLength(1);
		expect(s.session.ownerId).toBe(OWNER_A);
		expect(s.session.ownerGeneration).toBe(1);

		await s.processor.process(stopJob);
		s.spawned[0]?.exit(0, "SIGTERM");
		await runA;
	});

	it("never resumes a session nobody has claimed (a NULL lease is not a stale one)", async () => {
		// The row the create route writes: CREATED, no lease, its start job
		// still in the queue. Racing that job would spawn a second ffmpeg for
		// one session — which is why the sweep's filter carries `not: null`.
		const s = setup({ session: { status: "DOWNLOADING" } });
		const workerB = s.makeProcessor({
			ownerId: OWNER_B,
			hostname: "worker-b",
			now: () => new Date(Date.parse(NOW) + 60 * 60_000).toISOString(),
		});
		await expect(workerB.takeOverStale()).resolves.toEqual([]);
		expect(s.spawned).toHaveLength(0);
		expect(s.session.ownerId).toBeNull();
	});

	it("runs the verified kill ladder before resuming a live pid on its OWN host", async () => {
		const alive = new Set([5000]);
		const s = setup({
			leaseRenewalIntervalMs: 60_000,
			killPid: (pid, signal) => {
				if (!alive.has(pid)) {
					throw new Error("ESRCH");
				}
				if (signal === "SIGKILL") {
					alive.delete(pid);
				}
			},
			readProcessCommand: async () =>
				`ffmpeg -re -stream_loop -1 -i /tmp/spool-test/${SESSION_ID}.mp4`,
		});
		const runA = s.processor.process(startJob);
		await vi.waitFor(() => expect(s.spawned).toHaveLength(1));

		// Same host, so the ladder is available AND obligatory: taking the
		// session over while its ffmpeg is still pushing is the double push.
		const workerB = s.makeProcessor({
			ownerId: OWNER_B,
			now: () => new Date(Date.parse(NOW) + 10 * 60_000).toISOString(),
		});
		await expect(workerB.takeOverStale()).resolves.toEqual([SESSION_ID]);
		expect(s.killPid).toHaveBeenCalledWith(5000, "SIGTERM");
		expect(s.killPid).toHaveBeenCalledWith(5000, "SIGKILL");
		// Proof, so proof is recorded: the pid is released and stamped.
		expect(s.session.processGoneAt).toBeInstanceOf(Date);
		expect(s.session.ownerId).toBe(OWNER_B);

		await vi.waitFor(() => expect(s.spawned).toHaveLength(2));
		await workerB.process(stopJob);
		s.spawned[1]?.exit(0, "SIGTERM");
		await workerB.drainTakeovers();
		await s.processor.process(stopJob);
		s.spawned[0]?.exit(0, "SIGTERM");
		await runA;
	});

	it("REFUSES to resume a live same-host pid it cannot identify", async () => {
		// `readProcessCommand` unwired: the pid answers an existence probe and
		// nothing can say whether it is still our ffmpeg. An operator-issued
		// stop still acts on it; an unbidden sweep must not, because "no
		// information" becoming a second pusher is the one outcome with no
		// recovery. Same rule as reconcile-orphans.ts's identity gate.
		const s = setup({ leaseRenewalIntervalMs: 60_000 });
		const runA = s.processor.process(startJob);
		await vi.waitFor(() => expect(s.spawned).toHaveLength(1));

		const workerB = s.makeProcessor({
			ownerId: OWNER_B,
			now: () => new Date(Date.parse(NOW) + 10 * 60_000).toISOString(),
		});
		await expect(workerB.takeOverStale()).resolves.toEqual([]);
		expect(s.spawned).toHaveLength(1);
		expect(s.session.ownerId).toBe(OWNER_A);
		// Nothing was signalled — only the existence probe ran.
		expect(s.killPid).not.toHaveBeenCalledWith(5000, "SIGTERM");

		await s.processor.process(stopJob);
		s.spawned[0]?.exit(0, "SIGTERM");
		await runA;
	});

	it("REFUSES to resume a same-host ffmpeg that survived SIGKILL", async () => {
		const s = setup({
			leaseRenewalIntervalMs: 60_000,
			// Never throws: the pid outlives every rung of the ladder.
			killPid: () => {},
			readProcessCommand: async () =>
				`ffmpeg -re -stream_loop -1 -i /tmp/spool-test/${SESSION_ID}.mp4`,
		});
		const runA = s.processor.process(startJob);
		await vi.waitFor(() => expect(s.spawned).toHaveLength(1));

		const workerB = s.makeProcessor({
			ownerId: OWNER_B,
			now: () => new Date(Date.parse(NOW) + 10 * 60_000).toISOString(),
		});
		await expect(workerB.takeOverStale()).resolves.toEqual([]);
		expect(s.killPid).toHaveBeenCalledWith(5000, "SIGKILL");
		expect(s.spawned).toHaveLength(1);
		expect(s.session.ownerId).toBe(OWNER_A);

		await s.processor.process(stopJob);
		s.spawned[0]?.exit(0, "SIGTERM");
		await runA;
	});

	it("resumes a session whose owner died BEFORE it spawned anything", async () => {
		// DOWNLOADING with a lease and no pid: the shape a worker killed during
		// the source transfer leaves behind. The orphan sweep cannot see it at
		// all (its population is `pid IS NOT NULL`), so before the lease this
		// row was unrecoverable on every host including its own.
		const s = setup({
			session: {
				status: "DOWNLOADING",
				ownerId: "worker-a/999/deadbeef",
				ownerGeneration: 4,
				ownerLeaseAt: new Date(Date.parse(NOW)),
			},
		});
		const workerB = s.makeProcessor({
			ownerId: OWNER_B,
			hostname: "worker-b",
			now: () => new Date(Date.parse(NOW) + 10 * 60_000).toISOString(),
		});
		await expect(workerB.takeOverStale()).resolves.toEqual([SESSION_ID]);
		expect(s.session.ownerGeneration).toBe(5);
		expect(s.killPid).not.toHaveBeenCalled();
		await vi.waitFor(() => expect(s.spawned).toHaveLength(1));

		await workerB.process(stopJob);
		s.spawned[0]?.exit(0, "SIGTERM");
		await workerB.drainTakeovers();
		expect(s.session.status).toBe("STOPPED");
	});

	it("a resumed session inherits the loop boundaries and continues their numbering", async () => {
		// `appendBoundary` rewrites the WHOLE array, so a takeover that started
		// from an empty list would erase the loop ledger P4's live VMAF
		// alignment reads — and a numbering that restarted at 0 would break the
		// strictly-increasing property the cap's trimmed-head detection needs.
		//
		// The old owner was on another host and PROVED its push gone ( —
		// pid released, `processGoneAt` stamped in one write), so this cross-host
		// resume takes the safe branch: the BLOCKER-5 refusal only blocks a
		// takeover whose old pid is still LIVE.
		const s = setup({
			session: {
				status: "PUSHING",
				pid: null,
				ownerHost: null,
				processGoneAt: new Date(Date.parse(NOW)),
				ownerId: "worker-a/999/deadbeef",
				ownerGeneration: 1,
				ownerLeaseAt: new Date(Date.parse(NOW)),
				loopBoundaries: [
					{ loopIndex: 0, wallClock: NOW, streamTimeSec: 0 },
					{ loopIndex: 1, wallClock: NOW, streamTimeSec: 30 },
				],
			},
		});
		const workerB = s.makeProcessor({
			ownerId: OWNER_B,
			hostname: "worker-b",
			now: () => new Date(Date.parse(NOW) + 10 * 60_000).toISOString(),
		});
		await expect(workerB.takeOverStale()).resolves.toEqual([SESSION_ID]);
		await vi.waitFor(() => expect(s.spawned).toHaveLength(1));

		s.spawned[0]?.progress(1_000_000);
		await vi.waitFor(() =>
			expect(s.session.loopBoundaries as unknown[]).toHaveLength(3),
		);
		const kept = s.session.loopBoundaries as { loopIndex: number }[];
		expect(kept.map((b) => b.loopIndex)).toEqual([0, 1, 2]);

		await workerB.process(stopJob);
		s.spawned[0]?.exit(0, "SIGTERM");
		await workerB.drainTakeovers();
	});

	/**
	 * THE QUEUE-SLOT DECISION, pinned behaviourally .
	 *
	 * The lease could have replaced the BullMQ job as the session's liveness,
	 * letting the start job return as soon as the supervisor owns the row and
	 * freeing a slot for the whole push. It does NOT, and this arm is what
	 * would go red if someone made it — because five mechanisms read "the start
	 * job is still active" as "a worker owns this push", and three of them kill
	 * or notify:
	 *
	 *  1. `lifecycle.ts` — a graceful stop signals the supervisors and then
	 *     `worker.close` waits for ACTIVE jobs. That wait is what lands every
	 *     session on STOPPED before the process exits. A returned job is not
	 *     waited on, and the deploy exits with ffmpeg still pushing.
	 *  2. `reconcile-orphans.ts` gate 2 — DEAD_STATES contains `completed`, so
	 *     a start job that returned early makes every healthy push look like an
	 *     orphan, and its identity check would MATCH (the ffmpeg really is
	 *     ours). The sweep would SIGKILL live pushes on a 60s tick.
	 *  3. `index.ts`'s failed handler → `recordDeadFeederJob`, which only fires
	 *     for jobs that FAIL. A completed job never does.
	 *  4. `stall-policy.ts` raises `maxStalledCount` precisely because this job
	 *     is long-lived; the redelivery that buys disappears with it.
	 *  5. `FEEDER_MAX_ACTIVE_SESSIONS` (= `FEEDER_CONCURRENCY` − 1 = 7) exists
	 *     to keep a slot free for stop jobs.
	 *
	 * What returning early would buy is (5): an admission cap of 7 concurrent
	 * feeders per install, enforced at two call sites. That is a real limit and
	 * it is the honest cost of this decision — but it is a cap on a number, and
	 * the other four are correctness. The lease makes the job's LOSS
	 * recoverable, which was the finding; it does not make the job unnecessary.
	 */
	it("the START job holds its slot for the whole push, and stop jobs still reach the registry", async () => {
		const s = setup();
		let settled = false;
		const run = s.processor.process(startJob).then((result) => {
			settled = true;
			return result;
		});
		await vi.waitFor(() => expect(s.spawned).toHaveLength(1));
		expect(s.session.status).toBe("PUSHING");
		// The push is live and the job has NOT resolved: its slot is what
		// `worker.close` waits on and what BullMQ's stalled machinery watches.
		expect(settled).toBe(false);
		// Meanwhile a stop reaches the in-process supervisor (concurrency > 1).
		await expect(s.processor.process(stopJob)).resolves.toMatchObject({
			status: "STOPPING",
		});
		expect(settled).toBe(false);
		s.spawned[0]?.exit(0, "SIGTERM");
		await expect(run).resolves.toMatchObject({ status: "STOPPED" });
	});
});

/**
 * THE TWO-PHASE SWITCH — audit 2026-08-29 HIGH-3, ledger row 240.
 *
 * The old switch stopped the running feeder and created its replacement in
 * one breath; the replacement then downloaded the whole source AFTER air
 * time and nothing waited for the old push to end. Every arm here is about
 * the two barriers that replace that: a session with a commit instant HOLDS
 * after staging until the commit is requested, and once requested it spawns
 * only after every predecessor on the channel is proven gone. Time resolves
 * on writes the arms observe (READY recorded, a SIGTERM delivered, a row
 * landing STOPPED), never on a delay racing a timer.
 */
describe("feeder processor — the two-phase switch (row #240)", () => {
	const OLD_ID = "00000000-0000-4000-8000-0000000000f0";
	/** rev367 I-1: a session staged for a LATER switch on the same channel. */
	const HELD_ID = "00000000-0000-4000-8000-0000000000f2";
	const oldStart = { feederSessionId: OLD_ID, action: "start" } as const;
	const AT = new Date(NOW);

	/** The feed already on the channel — the pre-air slate loop. */
	function predecessor(over: Row = {}): Row {
		return {
			id: OLD_ID,
			liveChannelId: CHANNEL_ID,
			liveChannelRunId: "run-1",
			status: "CREATED",
			sourceCredentialId: SOURCE_CRED_ID,
			sourceBucket: "media",
			sourceKey: "loops/slate.mp4",
			sourceEtag: null,
			sourceVersionId: null,
			sourceGeneration: null,
			sourceSize: null,
			sourceSha256: null,
			protocol: "RTMP",
			target: { url: "rtmp://203.0.113.7/live", streamKey: "sk-secret" },
			pid: null,
			ownerHost: null,
			processGoneAt: null,
			ownerId: null,
			ownerLeaseAt: null,
			ownerGeneration: 0,
			commitAt: null,
			readyAt: null,
			commitRequestedAt: null,
			committedAt: null,
			predecessorGoneAt: null,
			switchSeamMs: null,
			publisherClaimedAt: null,
			publisherReleasedAt: null,
			publisherGeneration: 0,
			loopBoundaries: [],
			logTail: [],
			startedAt: null,
			stoppedAt: null,
			error: null,
			...over,
		};
	}

	/** A predecessor pushing on a host this worker cannot signal. */
	function foreignPredecessor(): Row {
		return predecessor({
			status: "PUSHING",
			pid: 4242,
			ownerHost: "worker-z",
			ownerId: "worker-z/9/zzzzzzzz",
			ownerLeaseAt: null,
			ownerGeneration: 3,
			startedAt: AT,
		});
	}

	it("revalidates provider lifecycle and the session fence before committing the switch", async () => {
		const old = foreignPredecessor();
		const s = setup({
			session: { commitAt: AT },
			extraSessions: [old],
			realSleep: true,
		});
		const running = s.processor.process(startJob);
		const refused = expect(running).rejects.toThrow(/not RUNNING/);
		await vi.waitFor(() => expect(s.session.readyAt).toEqual(AT));
		s.run.providerStatus = "QUEUED";
		s.run.providerStatusObservedAt = new Date(NOW);
		s.session.commitRequestedAt = AT;

		await refused;
		expect(s.spawned).toHaveLength(0);
		expect(s.session.committedAt).toBeNull();
		expect(old.status).toBe("PUSHING");
		expect(old.ownerGeneration).toBe(3);
		expect(s.feederSession.findUnique).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: SESSION_ID },
				select: expect.objectContaining({
					liveChannelRunId: true,
					ownerId: true,
					ownerGeneration: true,
				}),
			}),
		);
	});

	it("stages, records READY on the session and its row, then HOLDS — no ffmpeg until the commit is requested", async () => {
		const s = setup({ session: { commitAt: AT }, realSleep: true });
		const run = s.processor.process(startJob);
		await vi.waitFor(() => expect(s.session.readyAt).toEqual(AT));
		// The row's write-once RECORD of readiness.
		expect(s.liveSchedule.updateMany).toHaveBeenCalledWith({
			where: { feederSessionId: SESSION_ID, readyAt: null },
			data: { readyAt: AT },
		});
		// Inside the hold: the row is polled for its commit again and again,
		// and nothing spawns while it is.
		await vi.waitFor(() =>
			expect(s.liveSchedule.findFirst.mock.calls.length).toBeGreaterThanOrEqual(
				3,
			),
		);
		expect(s.spawned).toHaveLength(0);
		expect(s.session.committedAt).toBeNull();
		expect(s.session.status).toBe("DOWNLOADING");
		// The commit request — what the sweep's feeder-commit writes.
		s.session.commitRequestedAt = AT;
		await vi.waitFor(() => expect(s.spawned).toHaveLength(1));
		expect(s.session.committedAt).toEqual(AT);
		expect(s.session.status).toBe("PUSHING");
		// No predecessor: the seam is measured from the request itself.
		expect(s.session.predecessorGoneAt).toBeNull();
		expect(s.session.switchSeamMs).toBe(0);
		await s.processor.process(stopJob);
		s.spawned[0]?.exit(null, "SIGTERM");
		await expect(run).resolves.toMatchObject({ status: "STOPPED" });
	});

	it("the commit waits for the predecessor to be GONE before the new spawn — never a second push beside the first", async () => {
		const s = setup({
			session: { commitAt: AT, commitRequestedAt: AT },
			extraSessions: [predecessor()],
			realSleep: true,
		});
		const runOld = s.processor.process(oldStart);
		await vi.waitFor(() => expect(s.spawned).toHaveLength(1));
		const old = s.sessions[1] as Row;
		expect(old.status).toBe("PUSHING");

		const runNew = s.processor.process(startJob);
		// The barrier asked the predecessor to stop…
		await vi.waitFor(() => expect(s.spawned[0]?.killed).toContain("SIGTERM"));
		// …and while it is still alive, nothing else has spawned and no commit
		// point was taken — the new source is READY and waiting.
		expect(s.spawned).toHaveLength(1);
		expect(s.session.committedAt).toBeNull();
		expect(s.session.readyAt).toEqual(AT);
		// The predecessor exits; its own run lands it STOPPED, pid released.
		s.spawned[0]?.exit(null, "SIGTERM");
		await expect(runOld).resolves.toMatchObject({ status: "STOPPED" });
		await vi.waitFor(() => expect(s.spawned).toHaveLength(2));
		expect(s.session.committedAt).toEqual(AT);
		expect(s.session.status).toBe("PUSHING");
		expect(s.session.predecessorGoneAt).toEqual(old.stoppedAt);
		expect(s.session.switchSeamMs).toBe(0);
		expect(s.liveSchedule.updateMany).toHaveBeenCalledWith({
			where: { feederSessionId: SESSION_ID, switchSeamMs: null },
			data: { switchSeamMs: 0 },
		});
		await s.processor.process(stopJob);
		s.spawned[1]?.exit(null, "SIGTERM");
		await expect(runNew).resolves.toMatchObject({ status: "STOPPED" });
	});

	it("measures the seam from the predecessor's gone instant to the first push, on the session and the row", async () => {
		// A clock that moves one second per read, so the two instants differ.
		let tick = 0;
		const s = setup({
			session: { commitAt: AT, commitRequestedAt: AT },
			extraSessions: [predecessor()],
			realSleep: true,
			now: () => new Date(Date.parse(NOW) + tick++ * 1_000).toISOString(),
		});
		const runOld = s.processor.process(oldStart);
		await vi.waitFor(() => expect(s.spawned).toHaveLength(1));
		const runNew = s.processor.process(startJob);
		await vi.waitFor(() => expect(s.spawned[0]?.killed).toContain("SIGTERM"));
		s.spawned[0]?.exit(null, "SIGTERM");
		await expect(runOld).resolves.toMatchObject({ status: "STOPPED" });
		await vi.waitFor(() => expect(s.spawned).toHaveLength(2));
		const goneAt = (s.sessions[1] as Row).stoppedAt as Date;
		const startedAt = s.session.startedAt as Date;
		expect(s.session.predecessorGoneAt).toEqual(goneAt);
		expect(startedAt.getTime()).toBeGreaterThan(goneAt.getTime());
		expect(s.session.switchSeamMs).toBe(startedAt.getTime() - goneAt.getTime());
		expect(s.liveSchedule.updateMany).toHaveBeenCalledWith({
			where: { feederSessionId: SESSION_ID, switchSeamMs: null },
			data: { switchSeamMs: s.session.switchSeamMs },
		});
		await s.processor.process(stopJob);
		s.spawned[1]?.exit(null, "SIGTERM");
		await expect(runNew).resolves.toMatchObject({ status: "STOPPED" });
	});

	it("a predecessor that cannot be confirmed gone lands the switch ERROR and never spawns — dead air over overlap", async () => {
		const s = setup({
			session: { commitAt: AT, commitRequestedAt: AT },
			extraSessions: [foreignPredecessor()],
			realSleep: true,
			predecessorGoneTimeoutMs: 30,
		});
		await expect(s.processor.process(startJob)).rejects.toThrow(
			/not confirmed gone/,
		);
		expect(s.spawned).toHaveLength(0);
		expect(s.session.status).toBe("ERROR");
		expect(s.session.committedAt).toBeNull();
		expect(String(s.session.error)).toContain(
			"dead air is preferred over overlap",
		);
		// rev367 I-4: the operator text tells the truth. The predecessors were
		// ASKED to stop (the cross-host stop below retires the row, and the
		// revoked owner tears its own push down within a renewal) — so "the
		// previous feed keeps it" was false here, and the sentence now says
		// what is known: nothing is confirmed, in either direction.
		expect(String(s.session.error)).toContain(
			"were asked to stop but not confirmed gone",
		);
		expect(String(s.session.error)).toContain(
			"the ingest is NOT confirmed fed",
		);
		expect(String(s.session.error)).toContain(
			"pid 4242 on host worker-z — unverified from this worker, confirm it there",
		);
		expect(String(s.session.error)).not.toContain("previous feed keeps");
		// The previous feed's PROCESS was not lied about. The cross-host stop
		// (review-365 I-4) retires the SESSION — STOPPED, the owner's
		// generation revoked so its next renewal tears the push down — but
		// the process ledger keeps saying what is actually known: the pid
		// stays, nothing proves it gone, and nothing was signalled from here.
		// That unproven pid is exactly why the barrier refused: "may hold the
		// ingest" is the population, and STOPPED-with-a-pid is inside it.
		expect(s.sessions[1]?.status).toBe("STOPPED");
		expect(s.sessions[1]?.pid).toBe(4242);
		expect(s.sessions[1]?.processGoneAt).toBeNull();
		expect(s.sessions[1]?.ownerGeneration).toBe(4);
		expect(s.killPid).not.toHaveBeenCalled();
		// The schedule row learns the failure and the operator is told.
		expect(outcomeWrites(s.liveSchedule).map((w) => w.data?.outcome)).toContain(
			"FAILED",
		);
		expect(s.emitEvent).toHaveBeenCalledWith(
			expect.objectContaining({ kind: "FEEDER_ERROR" }),
		);
	});

	it("a session HELD for a LATER switch on the same channel is neither stopped nor waited on (rev367 I-1)", async () => {
		// The review's P1 probe shape: switch A committing now, switch B
		// staged READY for a commit five minutes out. A's barrier must leave
		// B alone — B cannot spawn before its own commit request, and
		// stopping it would cancel the programme it is holding for: at B's
		// fire time the sweep would read its session STOPPED and land the row
		// MISSED, "not staged".
		const heldLater = predecessor({
			id: HELD_ID,
			status: "DOWNLOADING",
			commitAt: new Date(Date.parse(NOW) + 5 * 60_000),
			readyAt: AT,
			commitRequestedAt: null,
			ownerId: "worker-z/9/zzzzzzzz",
			ownerLeaseAt: new Date(NOW),
			ownerGeneration: 3,
		});
		const s = setup({
			session: { commitAt: AT, commitRequestedAt: AT },
			extraSessions: [heldLater],
			realSleep: true,
		});
		const run = s.processor.process(startJob);
		await vi.waitFor(() => expect(s.spawned).toHaveLength(1));
		expect(s.session.status).toBe("PUSHING");
		// The later switch is untouched: still staged, still READY, no stop
		// note — and the committing switch never waited on it.
		expect(s.sessions[1]?.status).toBe("DOWNLOADING");
		expect(s.sessions[1]?.readyAt).toEqual(AT);
		expect(s.sessions[1]?.error).toBeNull();
		expect(s.sessions[1]?.ownerGeneration).toBe(3);
		await s.processor.process(stopJob);
		s.spawned[0]?.exit(null, "SIGTERM");
		await expect(run).resolves.toMatchObject({ status: "STOPPED" });
	});

	it("two switch commits requested at once yield exactly ONE publisher at every instant — the claim index decides, and no barrier stops a switch that has not claimed (rev367 S-4 → LC-02)", async () => {
		// rev367 S-4 had the barrier STOP a later switch the moment its commit
		// was requested — a would-be pusher, it said. LC-02 sharpens this: an
		// uncommitted switch holds no claim and no pid, so it is neither stopped
		// nor waited on; two switches whose commits are requested together both
		// wait out the predecessor and then compete INSIDE their commit CAS,
		// where the partial unique index lets exactly one claim land. (Stopping
		// each other instead could have stopped BOTH and left the ingest dark.)
		const laterSwitch = predecessor({
			id: HELD_ID,
			commitAt: AT,
			commitRequestedAt: null,
		});
		const s = setup({
			session: { commitAt: AT, commitRequestedAt: null },
			extraSessions: [predecessor(), laterSwitch],
			realSleep: true,
			predecessorGoneTimeoutMs: 3_000,
		});
		// Publisher cardinality, observed at the process level: how many
		// spawned ffmpegs are alive at once, over the whole run.
		let alive = 0;
		let maxAlive = 0;
		const realSpawn = s.runner.spawn.bind(s.runner);
		s.runner.spawn = (bin, argv, events) => {
			alive += 1;
			maxAlive = Math.max(maxAlive, alive);
			return realSpawn(bin, argv, {
				...events,
				onExit: (code, signal) => {
					alive -= 1;
					events.onExit(code, signal);
				},
			});
		};
		const runOld = s.processor.process(oldStart);
		await vi.waitFor(() => expect(s.spawned).toHaveLength(1));
		const runX = s.processor.process(startJob);
		const runY = s.processor.process({
			feederSessionId: HELD_ID,
			action: "start",
		} as const);
		// SC-01 may refuse one contender at the durable effect claim before the
		// publisher index. Observe that rejection immediately so it cannot become
		// an unhandled promise while this test drives the winning predecessor.
		void runX.catch(() => {});
		void runY.catch(() => {});
		await vi.waitFor(() => expect(s.session.readyAt).toEqual(AT));
		await vi.waitFor(() => expect(s.sessions[2]?.readyAt).toEqual(AT));
		// Two holds coexist WITHOUT claims, and the predecessor is untouched.
		expect(s.session.publisherClaimedAt).toBeNull();
		expect(s.sessions[2]?.publisherClaimedAt).toBeNull();
		expect(s.spawned[0]?.killed).toEqual([]);
		// Both commits requested in the same instant.
		s.session.commitRequestedAt = AT;
		(s.sessions[2] as Row).commitRequestedAt = AT;
		await vi.waitFor(() => expect(s.spawned[0]?.killed).toContain("SIGTERM"));
		// Neither requested switch stopped the OTHER. SC-01 serialises the two
		// external effects even earlier than LC-02's publisher claim: one keeps
		// waiting on the predecessor and the other is refused fail-closed.
		await vi.waitFor(() => {
			const rows = [s.session, s.sessions[2] as Row];
			expect(rows.filter((row) => row.status === "DOWNLOADING")).toHaveLength(
				1,
			);
			expect(rows.filter((row) => row.status === "ERROR")).toHaveLength(1);
		});
		s.spawned[0]?.exit(null, "SIGTERM");
		await expect(runOld).resolves.toMatchObject({ status: "STOPPED" });
		// Exactly one of the two ends up pushing. The other lost the claim —
		// refused by the index at its commit (ERROR naming the holder) — or,
		// when its barrier polled after the first commit landed, it stopped the
		// first as an ARRIVAL and committed once that one was proven gone. The
		// driver below plays the real ffmpeg's part for that second path: a
		// process a barrier SIGTERMs exits.
		const exited = new Set<number>();
		await vi.waitFor(() => {
			for (const proc of s.spawned.slice(1)) {
				if (proc.killed.includes("SIGTERM") && !exited.has(proc.pid)) {
					exited.add(proc.pid);
					proc.exit(null, "SIGTERM");
				}
			}
			const rows = [s.session, s.sessions[2] as Row];
			expect(rows.filter((row) => row.status === "PUSHING")).toHaveLength(1);
			expect(
				rows.filter(
					(row) => row.status === "ERROR" || row.status === "STOPPED",
				),
			).toHaveLength(1);
		});
		const winner = [s.session, s.sessions[2] as Row].find(
			(row) => row.status === "PUSHING",
		) as Row;
		const loser = [s.session, s.sessions[2] as Row].find(
			(row) => row !== winner,
		) as Row;
		expect(winner.publisherClaimedAt).toEqual(AT);
		expect(winner.publisherReleasedAt).toBeNull();
		if (loser.status === "ERROR") {
			// Refused either by the durable effect claim or the publisher claim;
			// both happen before spawn and leave the losing row unclaimed.
			expect(String(loser.error)).toMatch(
				/durable effect claim is (BLOCKED|STALE)|publisher slot is held/,
			);
			expect(loser.publisherClaimedAt).toBeNull();
		} else {
			// Committed first, then stopped by the other's barrier: its claim
			// was released by its OWN exit proof, never by the stop.
			expect(loser.publisherClaimedAt).toEqual(AT);
			expect(loser.publisherReleasedAt).toEqual(AT);
			expect(loser.processGoneAt).toEqual(AT);
		}
		// THE INVARIANT: never two ffmpegs at the ingest, at any instant.
		expect(maxAlive).toBe(1);
		// Wind down whichever is pushing.
		await s.processor.process({
			feederSessionId: winner.id as string,
			action: "stop",
		} as const);
		const live = s.spawned.find((proc) => proc.pid === winner.pid);
		live?.exit(null, "SIGTERM");
		await Promise.allSettled([runX, runY]);
		expect(maxAlive).toBe(1);
		expect(winner.status).toBe("STOPPED");
		// The winner's own exit proof released its claim.
		expect(winner.publisherReleasedAt).toEqual(AT);
	});

	it("a cross-host switch COMPLETES once the revoked owner proves its own pid gone (rev367 I-4)", async () => {
		// Worker A (this harness's default) pushes the predecessor on host
		// worker-a. Worker B stages the switch on worker-b: its stop cannot
		// signal A's pid — review-365 I-4 retires the row and revokes A's
		// generation instead. A's next renewal fails, A tears its ffmpeg down,
		// and — holding the only real proof there will ever be — stamps the
		// pid gone, fence-free. That proof is what lets B's barrier complete
		// instead of refusing at the timeout on a pid nobody could verify.
		const s = setup({
			session: { commitAt: AT, commitRequestedAt: AT },
			extraSessions: [predecessor()],
			leaseRenewalIntervalMs: 1,
			realSleep: true,
			predecessorGoneTimeoutMs: 3_000,
		});
		const runOld = s.processor.process(oldStart);
		await vi.waitFor(() => expect(s.spawned).toHaveLength(1));
		expect(s.sessions[1]?.ownerHost).toBe(HOST);

		const spawnedB: FakeProc[] = [];
		const runnerB: ProcessRunner = {
			spawn(_bin, argv, events) {
				const proc = new FakeProc(7000 + spawnedB.length, argv, events);
				spawnedB.push(proc);
				return proc;
			},
			run: s.runner.run,
		};
		const workerB = s.makeProcessor({
			ownerId: OWNER_B,
			hostname: "worker-b",
			runner: runnerB,
			leaseRenewalIntervalMs: 60_000,
		});
		const runNew = workerB.process(startJob);
		// B's barrier asked the predecessor to stop; from worker-b that is the
		// cross-host retirement — row STOPPED, pid kept, generation revoked.
		await vi.waitFor(() => expect(s.sessions[1]?.status).toBe("STOPPED"));
		expect(s.sessions[1]?.pid).toBe(5000);
		// A's losing renewal tears its ffmpeg down…
		await vi.waitFor(() => expect(s.spawned[0]?.killed).toContain("SIGTERM"));
		s.spawned[0]?.exit(255, "SIGTERM");
		await expect(runOld).resolves.toMatchObject({ status: "TAKEN_OVER" });
		// …and the proof it stamps is what unblocks B.
		await vi.waitFor(() => expect(spawnedB).toHaveLength(1));
		expect(s.sessions[1]?.pid).toBeNull();
		expect(s.sessions[1]?.processGoneAt).toEqual(new Date(NOW));
		expect(s.session.predecessorGoneAt).toEqual(new Date(NOW));
		expect(s.session.status).toBe("PUSHING");
		expect(s.session.ownerHost).toBe("worker-b");
		await workerB.process(stopJob);
		spawnedB[0]?.exit(0, "SIGTERM");
		await expect(runNew).resolves.toMatchObject({ status: "STOPPED" });
	});

	it("a fresh pid clears an older gone-proof — the process ledger describes THIS process, not its predecessor (rev367 I-4)", async () => {
		// The resumed-session shape one write later: a takeover's same-host
		// ladder stamps processGoneAt for the OLD pid, then the resumed run
		// spawns a new one. Without clearing the stamp, the LIVE push would
		// read as proven gone and the DELETE guard would let the row go.
		const s = setup({ session: { processGoneAt: new Date(1_000) } });
		const run = s.processor.process(startJob);
		await vi.waitFor(() => expect(s.session.status).toBe("PUSHING"));
		expect(s.session.pid).toBe(5000);
		expect(s.session.processGoneAt).toBeNull();
		await s.processor.process(stopJob);
		s.spawned[0]?.exit(null, "SIGTERM");
		await expect(run).resolves.toMatchObject({ status: "STOPPED" });
	});

	it("the immediate form stages FIRST: the predecessor is untouched until the new source is downloaded, probed and READY", async () => {
		let releaseFetch: () => void = () => undefined;
		const fetchGate = new Promise<void>((resolve) => {
			releaseFetch = resolve;
		});
		let killedAtFetch: string[] | null = null;
		const s = setup({
			session: { commitAt: AT, commitRequestedAt: AT },
			extraSessions: [predecessor()],
			realSleep: true,
			fetchSource: async ({ sessionId }) => {
				if (sessionId === SESSION_ID) {
					killedAtFetch = [...(spawnedRef[0]?.killed ?? [])];
					await fetchGate;
				}
				return {
					path: "/tmp/spool-test/src.mp4",
					sha256: FETCHED_SHA256,
					bytes: 1024,
					pinned: true,
					cleanup: async () => undefined,
				};
			},
		});
		const spawnedRef = s.spawned;
		const runOld = s.processor.process(oldStart);
		await vi.waitFor(() => expect(s.spawned).toHaveLength(1));
		const runNew = s.processor.process(startJob);
		// Whichever comes first — the download beginning, or the predecessor
		// being signalled — so a switch that stopped BEFORE staging fails on
		// the signal it sent rather than on a download it never reached.
		await vi.waitFor(() =>
			expect(
				killedAtFetch !== null || (s.spawned[0]?.killed.length ?? 0) > 0,
			).toBe(true),
		);
		// The download has begun and the predecessor has heard nothing.
		expect(s.spawned[0]?.killed).toEqual([]);
		expect(killedAtFetch).toEqual([]);
		expect(s.session.readyAt).toBeNull();
		releaseFetch();
		await vi.waitFor(() => expect(s.spawned[0]?.killed).toContain("SIGTERM"));
		// READY preceded the stop.
		expect(s.session.readyAt).toEqual(AT);
		s.spawned[0]?.exit(null, "SIGTERM");
		await expect(runOld).resolves.toMatchObject({ status: "STOPPED" });
		await vi.waitFor(() => expect(s.spawned).toHaveLength(2));
		await s.processor.process(stopJob);
		s.spawned[1]?.exit(null, "SIGTERM");
		await expect(runNew).resolves.toMatchObject({ status: "STOPPED" });
	});

	it("a staged session taken over after a stale lease commits under the NEW owner only", async () => {
		const gateA = { release: null as null | (() => void) };
		const gateB = { release: null as null | (() => void) };
		const s = setup({
			session: { commitAt: AT, commitRequestedAt: AT },
			extraSessions: [foreignPredecessor()],
			leaseRenewalIntervalMs: 60_000,
		});
		const workerA = s.makeProcessor({
			sleep: () =>
				new Promise<void>((resolve) => {
					gateA.release = resolve;
				}),
		});
		const runA = workerA.process(startJob);
		// A staged (READY under generation 1) and is parked in its barrier:
		// the predecessor lives on a host A cannot signal.
		await vi.waitFor(() => expect(gateA.release).not.toBeNull());
		expect(s.session.readyAt).toEqual(AT);
		expect(s.session.ownerId).toBe(OWNER_A);
		expect(s.session.ownerGeneration).toBe(1);
		expect(s.spawned).toHaveLength(0);

		// B: another instance, another host, ten minutes on — A's lease is
		// stale from where B stands. Its own runner, so a spawn is attributable.
		const spawnedB: FakeProc[] = [];
		const runnerB: ProcessRunner = {
			spawn(_bin, argv, events) {
				const proc = new FakeProc(7000 + spawnedB.length, argv, events);
				spawnedB.push(proc);
				return proc;
			},
			run: s.runner.run,
		};
		const nowB = () => new Date(Date.parse(NOW) + 10 * 60_000).toISOString();
		const workerB = s.makeProcessor({
			ownerId: OWNER_B,
			hostname: "worker-b",
			now: nowB,
			runner: runnerB,
			leaseRenewalIntervalMs: 60_000,
			sleep: () =>
				new Promise<void>((resolve) => {
					gateB.release = resolve;
				}),
		});
		await expect(workerB.takeOverStale()).resolves.toEqual([SESSION_ID]);
		// The claim re-stages: readiness and the commit point are cleared
		// under the new generation, in the same fenced write.
		expect(s.feederSession.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					ownerId: OWNER_A,
					ownerGeneration: 1,
				}),
				data: expect.objectContaining({
					ownerId: OWNER_B,
					ownerGeneration: 2,
					readyAt: null,
					committedAt: null,
				}),
			}),
		);
		// B stages again and parks in ITS barrier behind the same predecessor.
		await vi.waitFor(() => expect(gateB.release).not.toBeNull());
		expect(s.session.ownerGeneration).toBe(2);
		expect(s.session.readyAt).toEqual(new Date(nowB()));

		// The predecessor goes away on its own host.
		Object.assign(s.sessions[1] as Row, {
			status: "STOPPED",
			pid: null,
			ownerHost: null,
			processGoneAt: new Date(Date.parse(NOW) + 9 * 60_000),
			stoppedAt: new Date(Date.parse(NOW) + 9 * 60_000),
		});
		// A wakes first — and commits NOTHING: the commit point is fenced on
		// the pair that staged the source, and that pair is B's now. Resolve
		// on whichever comes first, A settling or A spawning, so an unfenced
		// commit fails on the spawn it made rather than on a hung promise.
		let settledA = false;
		void runA.then(() => {
			settledA = true;
		});
		gateA.release?.();
		await vi.waitFor(() => expect(settledA || s.spawned.length > 0).toBe(true));
		expect(s.spawned).toHaveLength(0);
		await expect(runA).resolves.toMatchObject({ status: "TAKEN_OVER" });
		expect(s.session.committedAt).toBeNull();
		expect(s.session.ownerId).toBe(OWNER_B);
		// B wakes — and commits, under generation 2.
		gateB.release?.();
		await vi.waitFor(() => expect(spawnedB).toHaveLength(1));
		expect(s.session.committedAt).toEqual(new Date(nowB()));
		expect(s.session.status).toBe("PUSHING");
		expect(s.session.pid).toBe(7000);
		expect(s.session.ownerHost).toBe("worker-b");
		expect(s.spawned).toHaveLength(0);
		await workerB.process(stopJob);
		spawnedB[0]?.exit(0, "SIGTERM");
		await workerB.drainTakeovers();
		expect(s.session.status).toBe("STOPPED");
	});

	it("a switch that COMMITTED and then lost its owner is re-committed by the new owner — the commit point is per generation", async () => {
		// A commits and pushes; then its lease goes stale. B's takeover claim
		// must clear the commit point along with readiness, or B re-stages a
		// source it can never commit and the session sits DOWNLOADING with an
		// owner that is not running it.
		// B takes over on the SAME host, so the verified kill ladder can PROVE
		// A's pid gone — post BLOCKER-5, the legitimate way to resume a session
		// whose owner is still alive (a cross-host takeover of A's LIVE pid now
		// refuses). A's own losing renewal then tears its ffmpeg down.
		const alive = new Set([5000]);
		const s = setup({
			session: { commitAt: AT, commitRequestedAt: AT },
			leaseRenewalIntervalMs: 1,
			killPid: (pid, signal) => {
				if (!alive.has(pid)) {
					throw new Error("ESRCH");
				}
				if (signal === "SIGKILL") {
					alive.delete(pid);
				}
			},
			readProcessCommand: async () =>
				`ffmpeg -re -stream_loop -1 -i /tmp/spool-test/${SESSION_ID}.mp4`,
		});
		const runA = s.processor.process(startJob);
		await vi.waitFor(() => expect(s.spawned).toHaveLength(1));
		expect(s.session.committedAt).toEqual(AT);
		expect(s.session.status).toBe("PUSHING");

		const nowB = () => new Date(Date.parse(NOW) + 10 * 60_000).toISOString();
		const workerB = s.makeProcessor({
			ownerId: OWNER_B,
			now: nowB,
			leaseRenewalIntervalMs: 1,
		});
		await expect(workerB.takeOverStale()).resolves.toEqual([SESSION_ID]);
		// B re-staged, re-committed under generation 2, and spawned.
		await vi.waitFor(() => expect(s.spawned).toHaveLength(2));
		expect(s.session.committedAt).toEqual(new Date(nowB()));
		expect(s.session.ownerId).toBe(OWNER_B);
		expect(s.session.ownerGeneration).toBe(2);
		// A's push is torn down by its own losing renewal .
		await vi.waitFor(() => expect(s.spawned[0]?.killed).toContain("SIGTERM"));
		s.spawned[0]?.exit(255, "SIGTERM");
		await expect(runA).resolves.toMatchObject({ status: "TAKEN_OVER" });
		await vi.waitFor(() => expect(s.session.status).toBe("PUSHING"));
		expect(s.session.pid).toBe(5001);
		await workerB.process(stopJob);
		s.spawned[1]?.exit(0, "SIGTERM");
		await workerB.drainTakeovers();
		expect(s.session.status).toBe("STOPPED");
	});

	it("a held session whose owner cannot confirm its lease stands down without committing — the hold honours the self-fence (review-365 I-3)", async () => {
		// The lease's self-fence (their arm: renewals throwing for longer than
		// the takeover window → requestTakeover, write nothing) must also end
		// a HOLD: a holder that cannot prove its lease may be taken over at any
		// moment, so it must not sit on a source it may no longer own, and it
		// must never reach the commit point.
		let dbDown = false;
		let clock = Date.parse(NOW);
		const s = setup({
			session: { commitAt: AT },
			realSleep: true,
			leaseRenewalIntervalMs: 1,
			leaseWritesFail: () => dbDown,
			now: () => new Date(clock).toISOString(),
		});
		const run = s.processor.process(startJob);
		await vi.waitFor(() => expect(s.session.readyAt).not.toBeNull());
		expect(s.spawned).toHaveLength(0);
		// The database goes away, and stays away past the takeover window.
		dbDown = true;
		clock += FEEDER_LEASE_TAKEOVER_MS + 1_000;
		await expect(run).resolves.toMatchObject({ status: "TAKEN_OVER" });
		expect(s.spawned).toHaveLength(0);
		expect(s.session.committedAt).toBeNull();
		// Nothing terminal was written: the row is another worker's to resume,
		// and its readiness is that worker's to re-establish.
		expect(s.session.status).toBe("DOWNLOADING");
		expect(s.session.ownerId).toBe(OWNER_A);
		expect(s.cleanup).toHaveBeenCalled();
	});

	it("a held session whose schedule row ended stands down: STOPPED with the reason, no ffmpeg, no incident", async () => {
		let scheduleStatus = "ARMED";
		const s = setup({
			session: { commitAt: AT },
			realSleep: true,
			scheduleRow: () => ({ status: scheduleStatus }),
			// Short, so a hold that ignored the row would end by the OTHER
			// message inside the test's own budget instead of hanging it.
			stageHoldTimeoutMs: 200,
		});
		const run = s.processor.process(startJob);
		await vi.waitFor(() =>
			expect(s.liveSchedule.findFirst.mock.calls.length).toBeGreaterThanOrEqual(
				2,
			),
		);
		scheduleStatus = "CANCELED";
		await expect(run).resolves.toMatchObject({ status: "STOPPED" });
		expect(s.spawned).toHaveLength(0);
		expect(s.session.status).toBe("STOPPED");
		expect(String(s.session.error)).toContain("released without pushing");
		expect(String(s.session.error)).toContain("CANCELED");
		expect(s.emitEvent).not.toHaveBeenCalled();
		expect(outcomeWrites(s.liveSchedule)).toEqual([]);
		expect(s.cleanup).toHaveBeenCalled();
	});

	it("a commit that never arrives releases the held source after the hold timeout, measured from the planned commit instant", async () => {
		const s = setup({
			session: { commitAt: new Date(Date.parse(NOW) - 5_000) },
			realSleep: true,
			stageHoldTimeoutMs: 1_000,
		});
		await expect(s.processor.process(startJob)).resolves.toMatchObject({
			status: "STOPPED",
		});
		expect(String(s.session.error)).toContain("no commit arrived");
		expect(s.spawned).toHaveLength(0);
		expect(s.cleanup).toHaveBeenCalled();
	});

	it("a stop during the hold lands STOPPED cleanly and releases the spool", async () => {
		const s = setup({ session: { commitAt: AT }, realSleep: true });
		const run = s.processor.process(startJob);
		await vi.waitFor(() => expect(s.session.readyAt).toEqual(AT));
		await expect(s.processor.process(stopJob)).resolves.toMatchObject({
			status: "STOPPING",
		});
		await expect(run).resolves.toMatchObject({ status: "STOPPED" });
		expect(s.spawned).toHaveLength(0);
		expect(s.session.error).toBeNull();
		expect(s.cleanup).toHaveBeenCalled();
	});

	it("an ordinary session — no commit instant — is untouched by the two phases", async () => {
		// This arm used to run beside a PUSHING foreign predecessor and assert
		// it was "neither stopped nor waited on" — which is exactly the second
		// publisher LC-02 forbids (that shape now lives in the publisher-claim
		// block below, as a refusal). What the two phases must NOT touch is
		// pinned on an unoccupied channel: no readiness, no commit, no seam.
		const s = setup();
		const run = s.processor.process(startJob);
		await vi.waitFor(() => expect(s.spawned).toHaveLength(1));
		expect(s.session.readyAt).toBeNull();
		expect(s.session.committedAt).toBeNull();
		expect(s.session.switchSeamMs).toBeNull();
		expect(s.liveSchedule.updateMany).not.toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ readyAt: AT }),
			}),
		);
		await s.processor.process(stopJob);
		s.spawned[0]?.exit(null, "SIGTERM");
		await expect(run).resolves.toMatchObject({ status: "STOPPED" });
	});
});

describe("feeder processor — the publisher claim", () => {
	const OLD_ID = "00000000-0000-4000-8000-0000000000f0";
	const NEW_ID = "00000000-0000-4000-8000-0000000000f3";
	const NEW2_ID = "00000000-0000-4000-8000-0000000000f4";
	const AT = new Date(NOW);

	/** Another row on the same channel, in the shape `over` describes. */
	function other(over: Row): Row {
		return {
			id: OLD_ID,
			liveChannelId: CHANNEL_ID,
			// LC-01 fail-closed provider effects require every row this LC-02
			// block may actually spawn to be bound to the current fresh run.
			// Individual occupancy-only cases can still override this to null.
			liveChannelRunId: "run-1",
			status: "CREATED",
			sourceCredentialId: SOURCE_CRED_ID,
			sourceBucket: "media",
			sourceKey: "loops/other.mp4",
			sourceEtag: null,
			sourceVersionId: null,
			sourceGeneration: null,
			sourceSize: null,
			sourceSha256: null,
			protocol: "RTMP",
			target: { url: "rtmp://203.0.113.7/live", streamKey: "sk-secret" },
			pid: null,
			ownerHost: null,
			processGoneAt: null,
			ownerId: null,
			ownerLeaseAt: null,
			ownerGeneration: 0,
			commitAt: null,
			readyAt: null,
			commitRequestedAt: null,
			committedAt: null,
			predecessorGoneAt: null,
			switchSeamMs: null,
			publisherClaimedAt: null,
			publisherReleasedAt: null,
			publisherGeneration: 0,
			loopBoundaries: [],
			logTail: [],
			startedAt: null,
			stoppedAt: null,
			error: null,
			...over,
		};
	}

	/** The audit's row: terminal, pid kept, nothing proven — BLOCKER-2. */
	function unprovenTerminal(over: Row = {}): Row {
		return other({
			status: "ERROR",
			pid: 4242,
			ownerHost: "worker-z",
			ownerId: "worker-z/9/zzzzzzzz",
			ownerGeneration: 3,
			processGoneAt: null,
			startedAt: AT,
			stoppedAt: AT,
			...over,
		});
	}

	function secondRunner(firstPid = 7000) {
		const spawned: FakeProc[] = [];
		const runner: ProcessRunner = {
			spawn(_bin, argv, events) {
				const proc = new FakeProc(firstPid + spawned.length, argv, events);
				spawned.push(proc);
				return proc;
			},
			run: vi.fn(
				async (_bin: string, argv: string[]) =>
					answerNormalization(argv, JSON.stringify(PROBE_COPY)) ?? {
						code: 0,
						stdout: JSON.stringify(PROBE_COPY),
						stderr: "",
					},
			),
		};
		return { runner, spawned };
	}

	function globalClaimHolders(): Row[] {
		return Array.from({ length: FEEDER_MAX_ACTIVE_SESSIONS }, (_, index) =>
			other({
				id: `global-holder-${index}`,
				liveChannelId: `global-channel-${index}`,
				status: "ERROR",
				startedAt: AT,
				publisherClaimedAt: AT,
				publisherReleasedAt: null,
				publisherGeneration: 1,
			}),
		);
	}

	it("takes the claim BEFORE the spawn and releases it on the owner's exit proof — a clean stop leaves processGoneAt stamped, not a lost pointer", async () => {
		const s = setup();
		const run = s.processor.process(startJob);
		await vi.waitFor(() => expect(s.spawned).toHaveLength(1));
		expect(s.session.status).toBe("PUSHING");
		expect(s.session.publisherClaimedAt).toEqual(AT);
		expect(s.session.publisherReleasedAt).toBeNull();
		expect(s.session.publisherGeneration).toBe(1);
		await s.processor.process(stopJob);
		s.spawned[0]?.exit(null, "SIGTERM");
		await expect(run).resolves.toMatchObject({ status: "STOPPED" });
		// The supervisor observed its child's exit: that is the proof, and it
		// both releases the claim and stamps the process gone (audit §6.4: a
		// clean stop no longer reads like a pointer that was merely lost).
		expect(s.session.publisherReleasedAt).toEqual(AT);
		expect(s.session.processGoneAt).toEqual(AT);
		expect(s.session.pid).toBeNull();
	});

	it("setPushing refuses to record a pid on a row whose claim is not held — the spawn is torn down, never booked", async () => {
		// The write-level backstop behind the pre-spawn claim: if the claim is
		// gone by the time the pid would be persisted (here: released under the
		// spawn, the way a mixed-version writer or a repair could), the PUSHING
		// write matches zero rows and the fresh ffmpeg is torn down like a lost
		// stop — a pid never enters the books without a held claim.
		const s = setup();
		const realSpawn = s.runner.spawn.bind(s.runner);
		s.runner.spawn = (bin, argv, events) => {
			const proc = realSpawn(bin, argv, events);
			s.session.publisherReleasedAt = AT;
			return proc;
		};
		const run = s.processor.process(startJob);
		await vi.waitFor(() => expect(s.spawned).toHaveLength(1));
		const proc = s.spawned[0];
		await vi.waitFor(() => expect(proc?.killed).toContain("SIGTERM"));
		proc?.exit(null, "SIGTERM");
		await expect(run).resolves.toMatchObject({ status: "STOPPED" });
		// Never booked: no pid on the row, no startedAt, status untouched by
		// the PUSHING write (the stop path landed STOPPED).
		expect(s.session.startedAt).toBeNull();
		expect(s.session.pid).toBeNull();
		expect(s.session.status).toBe("STOPPED");
	});

	it("ERROR + pid + no proof on the channel → an ordinary session is REFUSED before spawning: 0 ffmpeg, ERROR naming the holder, schedule FAILED, operator told", async () => {
		// The pre-claim shape (a row this migration's backfill would claim, or
		// one written by a door that predates the claim): no claim to collide
		// with, so the OCCUPANCY read is what refuses it — the half the index
		// cannot see.
		const s = setup({ extraSessions: [unprovenTerminal()] });
		await expect(s.processor.process(startJob)).rejects.toThrow(
			/publisher slot is held/,
		);
		expect(s.spawned).toHaveLength(0);
		expect(s.session.status).toBe("ERROR");
		expect(s.session.publisherClaimedAt).toBeNull();
		expect(String(s.session.error)).toContain(OLD_ID);
		expect(String(s.session.error)).toContain(
			"pid 4242 on host worker-z — unverified from this worker",
		);
		expect(String(s.session.error)).toContain(
			"dead air is preferred over overlap",
		);
		// The occupant was not touched: its pid and its lack of proof stand.
		expect(s.sessions[1]?.pid).toBe(4242);
		expect(s.sessions[1]?.processGoneAt).toBeNull();
		expect(outcomeWrites(s.liveSchedule).map((w) => w.data?.outcome)).toContain(
			"FAILED",
		);
		expect(s.emitEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: "FEEDER_ERROR",
				feederSessionId: SESSION_ID,
			}),
		);
	});

	it("STOPPED + pid + no proof (the not-ours stop shape) refuses an ordinary session too — terminal status is not process-gone proof", async () => {
		const s = setup({
			extraSessions: [unprovenTerminal({ status: "STOPPED" })],
		});
		await expect(s.processor.process(startJob)).rejects.toThrow(
			/publisher slot is held/,
		);
		expect(s.spawned).toHaveLength(0);
	});

	it("a claim that lands between the occupancy read and the claim CAS is refused by the INDEX (P2002 handled, holder named) — never a second spawn", async () => {
		// The race the index exists for: the occupancy read sees an empty
		// channel, and another row's commit takes the claim before this one's
		// CAS. The fake models the partial unique index; the P2002 must be
		// recognised and answered as a refusal that names the holder, not as
		// a bare database error.
		const rival = other({ status: "DOWNLOADING", commitAt: AT });
		const s = setup({ extraSessions: [rival] });
		const realFindMany = s.feederSession.findMany.getMockImplementation();
		s.feederSession.findMany.mockImplementationOnce(async (args) => {
			const result = await (realFindMany as (a: unknown) => Promise<Row[]>)(
				args,
			);
			// The rival's commit CAS lands right after the read.
			rival.publisherClaimedAt = AT;
			rival.publisherGeneration = 1;
			return result;
		});
		await expect(s.processor.process(startJob)).rejects.toThrow(
			/publisher slot is held by feeder session 00000000-0000-4000-8000-0000000000f0/,
		);
		expect(s.spawned).toHaveLength(0);
		expect(s.session.status).toBe("ERROR");
		expect(s.session.publisherClaimedAt).toBeNull();
		// The rival's claim stands untouched.
		expect(rival.publisherClaimedAt).toEqual(AT);
		expect(rival.publisherReleasedAt).toBeNull();
	});

	it("the ordinary pre-spawn gate refuses when shared global occupancy is already over capacity", async () => {
		// Seven held publishers plus this active uncoordinated row are eight
		// occupancies. Admission checks are intentionally soft; the process
		// boundary is the final guard against a racing/directly-created row.
		const s = setup({ extraSessions: globalClaimHolders() });
		await expect(s.processor.process(startJob)).rejects.toThrow(
			/publisher occupancy limit/i,
		);
		expect(s.spawned).toHaveLength(0);
		expect(s.session.publisherClaimedAt).toBeNull();
	});

	it("an ordinary start never overwrites its own unproven prior claim merely because the pid pointer is null", async () => {
		const prior = new Date(Date.parse(NOW) - 60_000);
		const s = setup({
			session: {
				publisherClaimedAt: prior,
				publisherReleasedAt: null,
				publisherGeneration: 1,
				startedAt: prior,
				pid: null,
				processGoneAt: null,
			},
		});
		s.runner.spawn = () => {
			throw new Error("spawned over its own unproven prior claim");
		};
		await expect(s.processor.process(startJob)).rejects.toThrow(
			/prior publisher.*not proven gone/i,
		);
		expect(s.session.publisherGeneration).toBe(1);
		expect(s.session.publisherReleasedAt).toBeNull();
	});

	it("a two-phase commit refuses when taking its claim would exceed shared global occupancy", async () => {
		// The staged self is not occupancy. Seven publishers are already the
		// full cap, so this commit cannot add an eighth claim.
		const s = setup({
			session: { commitAt: AT, commitRequestedAt: AT },
			extraSessions: globalClaimHolders(),
		});
		await expect(s.processor.process(startJob)).rejects.toThrow(
			/publisher occupancy limit/i,
		);
		expect(s.spawned).toHaveLength(0);
		expect(s.session.publisherClaimedAt).toBeNull();
		expect(s.session.committedAt).toBeNull();
	});

	it("every respawn revalidates the exact held claim generation before the process effect", async () => {
		const s = setup({ maxRestarts: 1 });
		const realSpawn = s.runner.spawn.bind(s.runner);
		let spawnAttempts = 0;
		s.runner.spawn = (bin, argv, events) => {
			spawnAttempts += 1;
			if (spawnAttempts > 1) {
				throw new Error("a respawn crossed the claim-generation fence");
			}
			return realSpawn(bin, argv, events);
		};
		const run = s.processor.process(startJob);
		await vi.waitFor(() => expect(s.spawned).toHaveLength(1));
		expect(s.session.publisherGeneration).toBe(1);

		// A newer claim incarnation appears before the restart. The provider
		// boundary still passes; only the exact publisher boundary can stop the
		// next process effect before `spawn` is called.
		s.session.publisherGeneration = 2;
		s.spawned[0]?.exit(1);
		await expect(run).resolves.toMatchObject({ status: "TAKEN_OVER" });
		expect(spawnAttempts).toBe(1);
		expect(s.session.publisherGeneration).toBe(2);
		expect(s.session.publisherReleasedAt).toBeNull();
	});

	it("cross-host partition: the refused takeover KEEPS the claim, a successor on the other host is refused, and it spawns only after the revoked owner proves its child gone", async () => {
		const s = setup({ leaseRenewalIntervalMs: 1 });
		const runA = s.processor.process(startJob);
		await vi.waitFor(() => expect(s.spawned).toHaveLength(1));
		expect(s.session.publisherClaimedAt).toEqual(AT);

		// Worker B, ten minutes on: A's lease is stale from where B stands, and
		// A's pid is on worker-a — nothing here can prove that push stopped.
		const b = secondRunner();
		const workerB = s.makeProcessor({
			ownerId: OWNER_B,
			hostname: "worker-b",
			runner: b.runner,
			now: () => new Date(Date.parse(NOW) + 10 * 60_000).toISOString(),
			leaseRenewalIntervalMs: 60_000,
		});
		await expect(workerB.takeOverStale()).resolves.toEqual([]);
		expect(s.session.status).toBe("ERROR");
		expect(s.session.pid).toBe(5000);
		expect(s.session.processGoneAt).toBeNull();
		// The refusal keeps pid, owner host AND the claim: the row still
		// occupies the channel, whatever its status says.
		expect(s.session.publisherClaimedAt).toEqual(AT);
		expect(s.session.publisherReleasedAt).toBeNull();

		// A successor created on the channel (by a door that let it through)
		// tries to start on host B while A's ffmpeg may still be pushing.
		s.sessions.push(other({ id: NEW_ID }));
		await expect(
			workerB.process({ feederSessionId: NEW_ID, action: "start" }),
		).rejects.toThrow(/publisher slot is held by feeder session/);
		expect(b.spawned).toHaveLength(0);
		expect(s.spawned).toHaveLength(1);
		const refused = s.sessions.find((row) => row.id === NEW_ID) as Row;
		expect(refused.status).toBe("ERROR");
		expect(String(refused.error)).toContain(SESSION_ID);
		expect(String(refused.error)).toContain("pid 5000 on host worker-a");

		// A's next renewal fails (revoked), it tears its ffmpeg down, and its
		// lease-lost path stamps the ONLY proof there will ever be — which
		// releases the claim.
		await vi.waitFor(() => expect(s.spawned[0]?.killed).toContain("SIGTERM"));
		s.spawned[0]?.exit(255, "SIGTERM");
		await expect(runA).resolves.toMatchObject({ status: "TAKEN_OVER" });
		await vi.waitFor(() => expect(s.session.pid).toBeNull());
		expect(s.session.processGoneAt).toBeInstanceOf(Date);
		expect(s.session.publisherReleasedAt).toBeInstanceOf(Date);
		expect(s.session.status).toBe("ERROR");

		// Now — and only now — a successor spawns on host B.
		s.sessions.push(other({ id: NEW2_ID }));
		const runN2 = workerB.process({
			feederSessionId: NEW2_ID,
			action: "start",
		});
		await vi.waitFor(() => expect(b.spawned).toHaveLength(1));
		const successor = s.sessions.find((row) => row.id === NEW2_ID) as Row;
		expect(successor.status).toBe("PUSHING");
		expect(successor.publisherClaimedAt).toBeInstanceOf(Date);
		expect(successor.ownerHost).toBe("worker-b");
		await workerB.process({ feederSessionId: NEW2_ID, action: "stop" });
		b.spawned[0]?.exit(null, "SIGTERM");
		await expect(runN2).resolves.toMatchObject({ status: "STOPPED" });
		// Still exactly one ffmpeg ever on host A, one on host B, never at once.
		expect(s.spawned).toHaveLength(1);
		expect(b.spawned).toHaveLength(1);
	});

	it("a stale session that still HOLDS a publisher claim but lost its pid pointer is retired, never resumed without process-gone proof", async () => {
		const claimedAt = new Date(Date.parse(NOW) - 10 * 60_000);
		const s = setup({
			session: {
				status: "PUSHING",
				pid: null,
				ownerHost: null,
				processGoneAt: null,
				ownerId: "worker-a/999/deadbeef",
				ownerGeneration: 4,
				ownerLeaseAt: claimedAt,
				publisherClaimedAt: claimedAt,
				publisherReleasedAt: null,
				publisherGeneration: 1,
				startedAt: claimedAt,
			},
		});
		const b = secondRunner();
		const workerB = s.makeProcessor({
			ownerId: OWNER_B,
			hostname: "worker-b",
			runner: b.runner,
			now: () => new Date(Date.parse(NOW) + 10 * 60_000).toISOString(),
		});

		await expect(workerB.takeOverStale()).resolves.toEqual([]);
		expect(b.spawned).toHaveLength(0);
		expect(s.session.status).toBe("ERROR");
		// Revocation stops a healed old owner from continuing, but this worker
		// proved nothing about the old publisher: its claim and missing proof stay.
		expect(s.session.ownerId).toBe("worker-a/999/deadbeef");
		expect(s.session.ownerGeneration).toBe(5);
		expect(s.session.processGoneAt).toBeNull();
		expect(s.session.publisherClaimedAt).toEqual(claimedAt);
		expect(s.session.publisherReleasedAt).toBeNull();
		expect(String(s.session.error)).toContain("publisher claim generation 1");
		expect(s.emitEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: "FEEDER_ERROR",
				feederSessionId: SESSION_ID,
			}),
		);
	});

	it("after a lost-pid takeover refusal, the revoked owner can release its exact claim with its own child-exit proof", async () => {
		const s = setup({ leaseRenewalIntervalMs: 1 });
		const runA = s.processor.process(startJob);
		await vi.waitFor(() => expect(s.spawned).toHaveLength(1));
		expect(s.session.publisherGeneration).toBe(1);
		// The persisted pointer is lost while A still supervises the child. The
		// claim is the durable fact that prevents this becoming a false-open.
		s.session.pid = null;
		s.session.ownerHost = null;

		const b = secondRunner();
		const workerB = s.makeProcessor({
			ownerId: OWNER_B,
			hostname: "worker-b",
			runner: b.runner,
			now: () => new Date(Date.parse(NOW) + 10 * 60_000).toISOString(),
		});
		await expect(workerB.takeOverStale()).resolves.toEqual([]);
		expect(b.spawned).toHaveLength(0);
		expect(s.session.publisherReleasedAt).toBeNull();

		// B's refusal revoked A's owner generation. A then stops and observes
		// its own child exit: exact claim generation 1 is sufficient to bind the
		// proof even though the row no longer carries the pid pointer.
		await vi.waitFor(() => expect(s.spawned[0]?.killed).toContain("SIGTERM"));
		s.spawned[0]?.exit(255, "SIGTERM");
		await expect(runA).resolves.toMatchObject({ status: "TAKEN_OVER" });
		expect(s.session.processGoneAt).toEqual(AT);
		expect(s.session.publisherGeneration).toBe(1);
		expect(s.session.publisherReleasedAt).toEqual(AT);
	});

	it("a revoked owner's late exit proof cannot release a newer claim when pid and host are reused", async () => {
		let oldPidAlive = true;
		const s = setup({
			leaseRenewalIntervalMs: 1,
			killPid: (_pid, signal) => {
				if (signal === 0 && !oldPidAlive) {
					throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
				}
				if (signal === "SIGTERM") {
					oldPidAlive = false;
				}
			},
			readProcessCommand: async () =>
				`ffmpeg -re -stream_loop -1 -i /tmp/spool-test/${SESSION_ID}.mp4`,
		});
		const runA = s.processor.process(startJob);
		await vi.waitFor(() => expect(s.spawned).toHaveLength(1));
		expect(s.session.publisherGeneration).toBe(1);

		// Same host, and deliberately the same numeric pid: after the takeover's
		// positive kill proof releases generation 1, the OS may reuse the number
		// for generation 2 before A's supervisor receives its exit event.
		const b = secondRunner(5000);
		const workerB = s.makeProcessor({
			ownerId: OWNER_B,
			hostname: HOST,
			runner: b.runner,
			now: () => new Date(Date.parse(NOW) + 10 * 60_000).toISOString(),
			leaseRenewalIntervalMs: 60_000,
		});
		await expect(workerB.takeOverStale()).resolves.toEqual([SESSION_ID]);
		await vi.waitFor(() => expect(b.spawned).toHaveLength(1));
		expect(s.session.pid).toBe(5000);
		expect(s.session.ownerHost).toBe(HOST);
		expect(s.session.publisherGeneration).toBe(2);
		expect(s.session.publisherReleasedAt).toBeNull();

		await vi.waitFor(() => expect(s.spawned[0]?.killed).toContain("SIGTERM"));
		s.spawned[0]?.exit(255, "SIGTERM");
		await expect(runA).resolves.toMatchObject({ status: "TAKEN_OVER" });
		// A proved only its generation-1 child gone. Generation 2 still owns the
		// reused pid/host tuple, so none of its process or claim ledger moved.
		expect(s.session.pid).toBe(5000);
		expect(s.session.processGoneAt).toBeNull();
		expect(s.session.publisherGeneration).toBe(2);
		expect(s.session.publisherReleasedAt).toBeNull();

		await workerB.process(stopJob);
		b.spawned[0]?.exit(null, "SIGTERM");
		await workerB.drainTakeovers();
		expect(s.session.publisherReleasedAt).toEqual(
			new Date(Date.parse(NOW) + 10 * 60_000),
		);
	});

	it("two hosts reach the spawn point at once — an ordinary session on A, an immediate switch on B — and exactly one publisher results at every instant", async () => {
		// Two ORDINARY active rows on one channel cannot coexist ('s
		// index refuses the second INSERT), so the pair the doors legitimately
		// admit together is an ordinary session and an immediate switch (the
		// create route admits a switch beside an active session by design).
		// Their spawn points are the pre-spawn claim and the commit CAS; the
		// publisher index decides between them whatever the interleaving.
		const gate = { release: null as null | (() => void) };
		const opened = new Promise<void>((resolve) => {
			gate.release = resolve;
		});
		let arrived = 0;
		const s = setup({
			session: { id: NEW_ID },
			extraSessions: [
				other({ id: NEW2_ID, commitAt: AT, commitRequestedAt: AT }),
			],
			fetchSource: async () => {
				arrived += 1;
				await opened;
				return {
					path: "/tmp/spool-test/src.mp4",
					sha256: FETCHED_SHA256,
					bytes: 1024,
					pinned: true,
					cleanup: async () => undefined,
				};
			},
			leaseRenewalIntervalMs: 1,
			realSleep: true,
			predecessorGoneTimeoutMs: 3_000,
		});
		const b = secondRunner();
		const workerB = s.makeProcessor({
			ownerId: OWNER_B,
			hostname: "worker-b",
			runner: b.runner,
			leaseRenewalIntervalMs: 1,
		});
		// Publisher cardinality at the process level, across BOTH hosts.
		let alive = 0;
		let maxAlive = 0;
		for (const runner of [s.runner, b.runner]) {
			const realSpawn = runner.spawn.bind(runner);
			runner.spawn = (bin, argv, events) => {
				alive += 1;
				maxAlive = Math.max(maxAlive, alive);
				return realSpawn(bin, argv, {
					...events,
					onExit: (code, signal) => {
						alive -= 1;
						events.onExit(code, signal);
					},
				});
			};
		}
		const runA = s.processor.process({
			feederSessionId: NEW_ID,
			action: "start",
		});
		const runB = workerB.process({ feederSessionId: NEW2_ID, action: "start" });
		void runA.catch(() => {});
		void runB.catch(() => {});
		// Both downloads are in flight; release them together so both reach
		// their spawn points in the same breath.
		await vi.waitFor(() => expect(arrived).toBe(2));
		gate.release?.();
		// Drive to the end: a process a barrier SIGTERMs exits (a real ffmpeg
		// would), until one row pushes and the other is settled — refused by
		// the index (ERROR), or stopped as the other's predecessor (STOPPED).
		const rows = [NEW_ID, NEW2_ID].map(
			(id) => s.sessions.find((row) => row.id === id) as Row,
		);
		const exited = new Set<number>();
		await vi.waitFor(
			() => {
				for (const proc of [...s.spawned, ...b.spawned]) {
					if (proc.killed.includes("SIGTERM") && !exited.has(proc.pid)) {
						exited.add(proc.pid);
						proc.exit(null, "SIGTERM");
					}
				}
				expect(rows.filter((row) => row.status === "PUSHING")).toHaveLength(1);
				expect(
					rows.filter(
						(row) => row.status === "ERROR" || row.status === "STOPPED",
					),
				).toHaveLength(1);
			},
			{ timeout: 4_000 },
		);
		expect(maxAlive).toBe(1);
		const winner = rows.find((row) => row.status === "PUSHING") as Row;
		const loser = rows.find((row) => row !== winner) as Row;
		expect(winner.publisherClaimedAt).toBeInstanceOf(Date);
		expect(winner.publisherReleasedAt).toBeNull();
		if (loser.status === "ERROR") {
			expect(String(loser.error)).toMatch(
				/durable effect claim is (BLOCKED|STALE)|publisher slot is held/,
			);
			expect(loser.publisherClaimedAt).toBeNull();
		} else {
			// Stopped as the switch's predecessor: the cross-host stop never
			// released the claim. The original owner releases it with its OWN
			// positive proof: either its child exited, or the final effect-boundary
			// check lost the lease before spawn and therefore no child ever existed.
			expect(loser.publisherReleasedAt).toBeInstanceOf(Date);
			if (loser.startedAt === null) {
				expect(loser.processGoneAt).toBeNull();
			} else {
				expect(loser.processGoneAt).toBeInstanceOf(Date);
			}
		}
		// Wind down the winner on whichever host spawned it.
		const owner = winner.ownerHost === HOST ? s.processor : workerB;
		await owner.process({
			feederSessionId: winner.id as string,
			action: "stop",
		});
		const proc = [...s.spawned, ...b.spawned].find(
			(candidate) => candidate.pid === winner.pid,
		);
		proc?.exit(null, "SIGTERM");
		await Promise.allSettled([runA, runB]);
		expect(maxAlive).toBe(1);
		expect(winner.status).toBe("STOPPED");
	});

	it("several future stage/holds coexist WITHOUT claims and serialise only at their commits", async () => {
		const HOLD_B = NEW_ID;
		const HOLD_C = NEW2_ID;
		const s = setup({
			session: { commitAt: AT, commitRequestedAt: null },
			extraSessions: [
				other({ id: HOLD_B, commitAt: new Date(Date.parse(NOW) + 5 * 60_000) }),
				other({
					id: HOLD_C,
					commitAt: new Date(Date.parse(NOW) + 10 * 60_000),
				}),
			],
			realSleep: true,
			predecessorGoneTimeoutMs: 3_000,
		});
		const rowB = s.sessions.find((row) => row.id === HOLD_B) as Row;
		const rowC = s.sessions.find((row) => row.id === HOLD_C) as Row;
		const runA = s.processor.process(startJob);
		const runB = s.processor.process({
			feederSessionId: HOLD_B,
			action: "start",
		});
		const runC = s.processor.process({
			feederSessionId: HOLD_C,
			action: "start",
		});
		await vi.waitFor(() => expect(s.session.readyAt).toEqual(AT));
		await vi.waitFor(() => expect(rowB.readyAt).toEqual(AT));
		await vi.waitFor(() => expect(rowC.readyAt).toEqual(AT));
		// Three holds, three READY sources, zero claims, zero ffmpeg.
		for (const row of [s.session, rowB, rowC]) {
			expect(row.status).toBe("DOWNLOADING");
			expect(row.publisherClaimedAt).toBeNull();
		}
		expect(s.spawned).toHaveLength(0);

		// Commit A: it claims and spawns; B and C keep holding, unclaimed and
		// untouched.
		s.session.commitRequestedAt = AT;
		await vi.waitFor(() => expect(s.spawned).toHaveLength(1));
		expect(s.session.status).toBe("PUSHING");
		expect(s.session.publisherClaimedAt).toEqual(AT);
		expect(rowB.status).toBe("DOWNLOADING");
		expect(rowB.publisherClaimedAt).toBeNull();
		expect(rowC.status).toBe("DOWNLOADING");
		expect(rowC.publisherClaimedAt).toBeNull();

		// Commit B: A is now its predecessor — stopped, waited out, then B
		// claims and spawns. C still holds.
		rowB.commitRequestedAt = AT;
		await vi.waitFor(() => expect(s.spawned[0]?.killed).toContain("SIGTERM"));
		expect(s.spawned).toHaveLength(1);
		expect(rowB.publisherClaimedAt).toBeNull();
		s.spawned[0]?.exit(null, "SIGTERM");
		await expect(runA).resolves.toMatchObject({ status: "STOPPED" });
		expect(s.session.publisherReleasedAt).toEqual(AT);
		await vi.waitFor(() => expect(s.spawned).toHaveLength(2));
		expect(rowB.status).toBe("PUSHING");
		expect(rowB.publisherClaimedAt).toEqual(AT);
		expect(rowB.predecessorGoneAt).toEqual(AT);
		expect(rowC.status).toBe("DOWNLOADING");
		expect(rowC.publisherClaimedAt).toBeNull();

		// Commit C: the same handover, one more time.
		rowC.commitRequestedAt = AT;
		await vi.waitFor(() => expect(s.spawned[1]?.killed).toContain("SIGTERM"));
		s.spawned[1]?.exit(null, "SIGTERM");
		await expect(runB).resolves.toMatchObject({ status: "STOPPED" });
		await vi.waitFor(() => expect(s.spawned).toHaveLength(3));
		expect(rowC.status).toBe("PUSHING");
		expect(rowC.publisherClaimedAt).toEqual(AT);
		await s.processor.process({ feederSessionId: HOLD_C, action: "stop" });
		s.spawned[2]?.exit(null, "SIGTERM");
		await expect(runC).resolves.toMatchObject({ status: "STOPPED" });
	});

	it("the reclaim proofs release the claim; an unproven pid keeps it (registry-miss stops)", async () => {
		// Verified kill ladder on this host: proof → released.
		const signalled: string[] = [];
		const proven = setup({
			session: {
				status: "PUSHING",
				pid: 4242,
				ownerHost: HOST,
				publisherClaimedAt: AT,
				publisherGeneration: 1,
			},
			killPid: (_pid, signal) => {
				if (signal === 0 && signalled.includes("SIGTERM")) {
					throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
				}
				if (signal !== 0) {
					signalled.push(signal);
				}
			},
		});
		await expect(proven.processor.process(stopJob)).resolves.toMatchObject({
			status: "STOPPED",
		});
		expect(proven.session.processGoneAt).toEqual(AT);
		expect(proven.session.publisherReleasedAt).toEqual(AT);

		// An ERROR row whose pid is already gone (ESRCH at once): proof →
		// released, status kept.
		const esrch = setup({
			session: {
				status: "ERROR",
				pid: 4242,
				ownerHost: HOST,
				publisherClaimedAt: AT,
				publisherGeneration: 1,
			},
			killPid: () => {
				throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
			},
		});
		await expect(esrch.processor.process(stopJob)).resolves.toMatchObject({
			status: "ERROR",
		});
		expect(esrch.session.status).toBe("ERROR");
		expect(esrch.session.publisherReleasedAt).toEqual(AT);

		// A pid that survives SIGKILL: no proof → the claim STAYS with the pid.
		const unkillable = setup({
			session: {
				status: "PUSHING",
				pid: 4242,
				ownerHost: HOST,
				publisherClaimedAt: AT,
				publisherGeneration: 1,
			},
			killPid: () => {},
		});
		await expect(unkillable.processor.process(stopJob)).resolves.toMatchObject({
			status: "ERROR",
		});
		expect(unkillable.session.pid).toBe(4242);
		expect(unkillable.session.publisherReleasedAt).toBeNull();

		// A pid on another host: not signalled, no proof → the claim STAYS.
		const foreign = setup({
			session: {
				status: "PUSHING",
				pid: 4242,
				ownerHost: "worker-z",
				ownerId: "worker-z/9/zzzzzzzz",
				ownerGeneration: 3,
				publisherClaimedAt: AT,
				publisherGeneration: 1,
			},
		});
		await expect(foreign.processor.process(stopJob)).resolves.toMatchObject({
			status: "STOPPED",
		});
		expect(foreign.session.pid).toBe(4242);
		expect(foreign.session.publisherReleasedAt).toBeNull();
		expect(foreign.killPid).not.toHaveBeenCalled();
	});

	it("a registry-miss stop's old-process proof cannot release a successor claim that reused the pid", async () => {
		let termSent = false;
		let s: ReturnType<typeof setup>;
		s = setup({
			session: {
				status: "PUSHING",
				pid: 4242,
				ownerHost: HOST,
				ownerId: OWNER_A,
				ownerGeneration: 1,
				publisherClaimedAt: AT,
				publisherReleasedAt: null,
				publisherGeneration: 1,
			},
			killPid: (_pid, signal) => {
				if (signal === "SIGTERM") {
					termSent = true;
					return;
				}
				if (signal === 0 && termSent) {
					// Between the ladder's signal and its positive ESRCH proof, a
					// takeover released generation 1 and a successor claimed the
					// same row. The OS reused the pid on the same host.
					Object.assign(s.session, {
						status: "PUSHING",
						pid: 4242,
						ownerHost: HOST,
						ownerId: OWNER_B,
						ownerGeneration: 2,
						processGoneAt: null,
						publisherClaimedAt: new Date(Date.parse(NOW) + 1_000),
						publisherReleasedAt: null,
						publisherGeneration: 2,
					});
					throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
				}
			},
		});

		await expect(s.processor.process(stopJob)).resolves.toMatchObject({
			status: "PUSHING",
		});
		// The proof was for generation 1 only. Generation 2 and its live process
		// remain untouched, despite identical id/pid/host values.
		expect(s.session.status).toBe("PUSHING");
		expect(s.session.pid).toBe(4242);
		expect(s.session.ownerId).toBe(OWNER_B);
		expect(s.session.ownerGeneration).toBe(2);
		expect(s.session.processGoneAt).toBeNull();
		expect(s.session.publisherGeneration).toBe(2);
		expect(s.session.publisherReleasedAt).toBeNull();
	});

	it("a stale claim that outlived its proof is released by the next stop (the repair), and a claim with NO proof is not", async () => {
		const stale = setup({
			session: {
				status: "STOPPED",
				pid: null,
				processGoneAt: AT,
				publisherClaimedAt: AT,
				publisherGeneration: 1,
			},
		});
		await expect(stale.processor.process(stopJob)).resolves.toMatchObject({
			status: "STOPPED",
		});
		expect(stale.session.publisherReleasedAt).toEqual(AT);

		const unproven = setup({
			session: {
				status: "STOPPED",
				pid: null,
				processGoneAt: null,
				publisherClaimedAt: AT,
				publisherGeneration: 1,
			},
		});
		await expect(unproven.processor.process(stopJob)).resolves.toMatchObject({
			status: "STOPPED",
		});
		expect(unproven.session.publisherReleasedAt).toBeNull();
	});

	it("a stale owner whose exact claim was released before spawn may be resumed and re-claim — no processGoneAt is fabricated", async () => {
		const claimedAt = new Date(Date.parse(NOW) - 10 * 60_000);
		const releasedAt = new Date(Date.parse(NOW) - 9 * 60_000);
		const s = setup({
			session: {
				status: "DOWNLOADING",
				pid: null,
				ownerHost: null,
				ownerId: "worker-a/999/deadbeef",
				ownerGeneration: 4,
				ownerLeaseAt: claimedAt,
				publisherClaimedAt: claimedAt,
				publisherReleasedAt: releasedAt,
				publisherGeneration: 1,
				startedAt: null,
				processGoneAt: null,
			},
		});

		await expect(s.processor.takeOverStale()).resolves.toEqual([SESSION_ID]);
		await vi.waitFor(() => expect(s.spawned).toHaveLength(1));
		// The previous release is itself the positive "spawn never occurred"
		// proof. Reusing the row takes a fresh generation; it does not manufacture
		// a gone timestamp for a process that never existed.
		expect(s.session.processGoneAt).toBeNull();
		expect(s.session.publisherGeneration).toBe(2);
		expect(s.session.publisherReleasedAt).toBeNull();
		expect(s.session.status).toBe("PUSHING");

		await s.processor.process(stopJob);
		s.spawned[0]?.exit(null, "SIGTERM");
		await s.processor.drainTakeovers();
		expect(s.session.status).toBe("STOPPED");
		expect(s.session.processGoneAt).toEqual(AT);
		expect(s.session.publisherReleasedAt).toEqual(AT);
	});

	it("a same-host takeover's verified kill releases the dead owner's claim and the resumed run re-claims under the next generation", async () => {
		const s = setup({
			session: {
				status: "PUSHING",
				pid: 4242,
				ownerHost: HOST,
				ownerId: "worker-a/999/deadbeef",
				ownerGeneration: 4,
				ownerLeaseAt: new Date(Date.parse(NOW) - 10 * 60_000),
				publisherClaimedAt: new Date(Date.parse(NOW) - 10 * 60_000),
				publisherGeneration: 1,
				startedAt: new Date(Date.parse(NOW) - 10 * 60_000),
			},
			killPid: () => {
				throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
			},
			readProcessCommand: async () => null,
		});
		await expect(s.processor.takeOverStale()).resolves.toEqual([SESSION_ID]);
		// The ladder's proof released the dead owner's claim in the same write…
		expect(s.session.processGoneAt).toEqual(AT);
		await vi.waitFor(() => expect(s.spawned).toHaveLength(1));
		// …and the resumed run took its own claim before spawning: generation 2,
		// held, with the stale proof cleared for the NEW process.
		expect(s.session.publisherGeneration).toBe(2);
		expect(s.session.publisherClaimedAt).toEqual(AT);
		expect(s.session.publisherReleasedAt).toBeNull();
		expect(s.session.status).toBe("PUSHING");
		await s.processor.process(stopJob);
		s.spawned[0]?.exit(null, "SIGTERM");
		await s.processor.drainTakeovers();
		expect(s.session.status).toBe("STOPPED");
		expect(s.session.publisherReleasedAt).toEqual(AT);
	});

	it("a stale takeover cannot apply the old pid's kill proof after the same owner respawns", async () => {
		const staleAt = new Date(Date.parse(NOW) - 10 * 60_000);
		let termSent = false;
		let s: ReturnType<typeof setup>;
		s = setup({
			session: {
				status: "PUSHING",
				pid: 4242,
				ownerHost: HOST,
				ownerId: "worker-a/999/deadbeef",
				ownerGeneration: 4,
				ownerLeaseAt: staleAt,
				publisherClaimedAt: staleAt,
				publisherReleasedAt: null,
				publisherGeneration: 1,
				startedAt: staleAt,
			},
			killPid: (_pid, signal) => {
				if (signal === "SIGTERM") {
					termSent = true;
					return;
				}
				if (signal === 0 && termSent) {
					// The old supervisor restarted under the same owner and claim
					// generations before the takeover persisted its old-child proof.
					Object.assign(s.session, {
						pid: 5000,
						ownerHost: HOST,
						processGoneAt: null,
					});
					throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
				}
			},
			readProcessCommand: async () =>
				`ffmpeg -re -stream_loop -1 -i /tmp/spool-test/${SESSION_ID}.mp4`,
		});

		await expect(s.processor.takeOverStale()).resolves.toEqual([]);
		expect(s.spawned).toHaveLength(0);
		expect(s.session.pid).toBe(5000);
		expect(s.session.ownerId).toBe("worker-a/999/deadbeef");
		expect(s.session.ownerGeneration).toBe(4);
		expect(s.session.publisherGeneration).toBe(1);
		expect(s.session.publisherReleasedAt).toBeNull();
		expect(s.session.processGoneAt).toBeNull();
	});
});
