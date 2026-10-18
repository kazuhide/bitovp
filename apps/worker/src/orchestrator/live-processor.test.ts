import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	compileLiveChannel,
	compileLiveRunStepLog,
	FEEDER_MAX_ACTIVE_SESSIONS,
	type FeederJob,
	feederOccupancyWhere,
	ingestConnectedFromHeartbeat,
	initStepLog,
	type LiveToVodRecord,
	liveChannelPlanSchema,
	liveToVodClaim,
	liveToVodFamilySupport,
	normalizeLiveToVodRecord,
	OPERATION_KINDS,
	persistedHeartbeatAtMs,
	REDACTED,
	RUNTIME_RECORD_KINDS,
	type StepLogEntry,
	stepLogSchema,
} from "@bitovp/core";
import type { AppPrismaClient } from "@bitovp/db";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	type MockInstance,
	vi,
} from "vitest";
import { fakeSdk as baseFakeSdk } from "./fake-sdk";
import {
	computeHeartbeatDeltas,
	createLiveChannelActions,
	createLiveChannelProcessor,
	createLiveHeartbeatSweep,
	HEARTBEAT_PRUNE_BATCH,
	HEARTBEAT_RETENTION_MS,
	type LiveChannelDeps,
	type PersistedHeartbeat,
} from "./live-processor";
import { VerificationProviderIdPersistenceError } from "./ops/encoding";
import type { LiveHeartbeatSample, SdkOps, TaskStatusResult } from "./sdk-ops";
import {
	type CreateStamp,
	VerificationProviderIdDefinitelyNotPersistedError,
	VerificationProviderOwnershipLostError,
} from "./stamping-fetch";

const liveEffectMocks = vi.hoisted(() => ({
	begin: vi.fn(),
	assertCurrent: vi.fn(),
	bindTarget: vi.fn(),
	markAcked: vi.fn(),
	markAmbiguous: vi.fn(),
	markFailed: vi.fn(),
	resolveAfterStop: vi.fn(),
}));

vi.mock("@bitovp/db", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@bitovp/db")>();
	return {
		...actual,
		beginLiveEffect: liveEffectMocks.begin,
		assertLiveEffectCurrent: liveEffectMocks.assertCurrent,
		bindLiveEffectTarget: liveEffectMocks.bindTarget,
		markLiveEffectAcked: liveEffectMocks.markAcked,
		markLiveEffectAmbiguous: liveEffectMocks.markAmbiguous,
		markLiveEffectFailed: liveEffectMocks.markFailed,
		resolveLiveEffectsAfterConfirmedStop: liveEffectMocks.resolveAfterStop,
	};
});

const fixturePath = join(
	__dirname,
	"../../../../packages/core/src/live/__fixtures__/live-rtmp-simple.plan.json",
);
const basePlan = liveChannelPlanSchema.parse(
	JSON.parse(readFileSync(fixturePath, "utf8")),
);
const ACCOUNT_ID = "00000000-0000-4000-8000-00000000000a";
const OTHER_ACCOUNT_ID = "00000000-0000-4000-8000-00000000ac02";
const CHANNEL_ID = "00000000-0000-4000-8000-0000000000bb";
const LIVE_TO_VOD_RUN_ID = "00000000-0000-4000-8000-0000000000cc";
let liveToVodAttemptSequence = 0;

function nextLiveToVodAttemptId(): string {
	liveToVodAttemptSequence += 1;
	return `00000000-0000-4000-8000-${String(liveToVodAttemptSequence).padStart(12, "0")}`;
}

function fakeSdk(overrides: Partial<SdkOps> = {}): SdkOps {
	return baseFakeSdk({
		createEncoding: vi.fn(() => Promise.resolve("bm-live-enc")),
		// AWAIT_LIVE_RUNNING succeeds on RUNNING — the live steady state.
		getEncodingStatus: vi.fn(() => Promise.resolve({ status: "RUNNING" })),
		...overrides,
	});
}

type Row = Record<string, unknown>;

function setup(
	rowOverrides: Row = {},
	sdkOverrides: Partial<SdkOps> = {},
	makeSdkSpy?: LiveChannelDeps["makeSdk"],
) {
	const plan = structuredClone(basePlan);
	plan.bitmovin.accountId = ACCOUNT_ID;
	const row: Row = {
		id: CHANNEL_ID,
		status: "CREATED",
		plan,
		stepLog: initStepLog(compileLiveChannel(plan)),
		bitmovinAccountId: null,
		bitmovinEncodingId: null,
		streamKey: null,
		encoderIp: null,
		lastHeartbeat: null,
		// beginLiveEffect advances an initial generation 0 claim to generation 1
		// before the processor receives its fence handle.
		liveEffectFenceVersion: 1,
		...rowOverrides,
	};
	const updates: Row[] = [];
	const liveChannel = {
		findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
			// A DETACHED clone, as Prisma returns. Handing back the live object
			// made every "stale read" in this harness observe later mutations,
			// so a read-before-claim followed by a write-during-claim looked
			// consistent — and the missing re-read after winning the
			// provisioning lease was invisible (review of  found it
			// with its own fake; this harness's docstring already admitted the
			// limitation).
			where.id === row.id ? (structuredClone(row) as Row) : null,
		),
		findMany: vi.fn(async () => [
			{
				id: row.id,
				updatedAt: new Date("2026-06-11T23:59:30.000Z"),
				// /review-223 F10: the sweep's own read carries the
				// program window to the alert engine.
				programStartAt:
					(rowOverrides.programStartAt as Date | null | undefined) ?? null,
				programEndAt:
					(rowOverrides.programEndAt as Date | null | undefined) ?? null,
			},
		]),
		update: vi.fn(async ({ data }: { data: Row }) => {
			// CLONE at push time: persist hands the SAME entries array on
			// every call, so pushing the reference makes every "snapshot"
			// display the final state — an instrument that cannot see history
			// (the write-order pin below read false against a correct order
			// before this clone existed).
			updates.push(structuredClone(data));
			Object.assign(row, data);
			return row;
		}),
		updateMany: vi.fn(
			async ({
				where,
				data,
			}: {
				where: {
					id?: string;
					status?: string | { in: string[] } | { not: string };
					liveEffectFenceVersion?: number;
					runs?: {
						some: { id: string; cancelRequested: boolean };
						none: { seq: { gt: number } };
					};
					provisionClaimedAt?: Date | null;
					bitmovinEncodingId?: string | null;
					error?: string | null;
					OR?: {
						provisionClaimedAt?: null | { lt: Date };
						status?: string | { in: string[] };
						error?: null | { not: null };
					}[];
					liveToVod?: { path: string[]; equals: unknown };
					AND?:
						| { liveToVod?: { path: string[]; equals: unknown } }
						| { liveToVod?: { path: string[]; equals: unknown } }[];
				};
				data: Row;
			}) => {
				const idOk = !where.id || where.id === row.id;
				const effectFenceOk =
					where.liveEffectFenceVersion === undefined ||
					where.liveEffectFenceVersion === row.liveEffectFenceVersion;
				// : the live-to-VOD save fences on the encoding id it is
				// archiving. A stub that ignored this key would report count:1 even
				// after a re-air changed the encoding, making the fence untestable
				// and its lost-write path unreachable — the exact trap the
				// provisionClaimedAt CAS below documents.
				const encOk =
					!("bitmovinEncodingId" in where) ||
					where.bitmovinEncodingId === (row.bitmovinEncodingId ?? null);
				if ("error" in where && where.error !== (row.error ?? null))
					return { count: 0 };
				// The lease's COMPARE-AND-SWAP: the renewal matches only while
				// `provisionClaimedAt` is still the value that worker wrote.
				// The stub ignored this key, so every renewal "succeeded" and
				// the lease-lost path was unreachable — the same defect the OR
				// clause had, found the same way.
				const cancelRunOk =
					!where.runs ||
					(runRows.some(
						(run) =>
							run.id === where.runs?.some.id &&
							run.cancelRequested === where.runs.some.cancelRequested,
					) &&
						!runRows.some(
							(run) => run.seq > (where.runs?.none.seq.gt ?? Infinity),
						));
				const held = row.provisionClaimedAt as Date | null | undefined;
				const casOk =
					!("provisionClaimedAt" in where) ||
					(where.provisionClaimedAt === null
						? held === null || held === undefined
						: held instanceof Date &&
							where.provisionClaimedAt instanceof Date &&
							held.getTime() === where.provisionClaimedAt.getTime());
				// : the provider-terminal channel write says
				// `status: { not: "STOPPED" }` — a confirmed clean stop must not
				// be flipped to ERROR by a late terminal reading.
				const statusOk =
					!where.status ||
					(typeof where.status === "string"
						? row.status === where.status
						: "in" in where.status
							? where.status.in.includes(row.status as string)
							: row.status !== where.status.not);
				const storedLiveToVod = row.liveToVod as
					| Record<string, unknown>
					| null
					| undefined;
				const liveToVodOk =
					!where.liveToVod ||
					storedLiveToVod?.[where.liveToVod.path[0] ?? ""] ===
						where.liveToVod.equals;
				const exactFilters = Array.isArray(where.AND)
					? where.AND
					: where.AND
						? [where.AND]
						: [];
				const exactFiltersOk = exactFilters.every(({ liveToVod }) => {
					return (
						!liveToVod ||
						storedLiveToVod?.[liveToVod.path[0] ?? ""] === liveToVod.equals
					);
				});
				// The OR arm is MODELLED, not ignored. It used to be dropped on
				// the floor, which made every conditional claim succeed —
				// including the provisioning lease (AKR-E57-003), whose entire
				// job is to make the SECOND caller fail. A stub that always
				// says count:1 turns that test into a tautology.
				const orOk =
					!where.OR ||
					where.OR.some((arm) => {
						if ("provisionClaimedAt" in arm) {
							if (arm.provisionClaimedAt === null) {
								return held === null || held === undefined;
							}
							const lt = arm.provisionClaimedAt?.lt;
							return lt !== undefined && held != null && held < lt;
						}
						const armStatus = arm.status;
						const sOk =
							armStatus === undefined
								? true
								: typeof armStatus === "string"
									? armStatus === row.status
									: armStatus.in.includes(row.status as string);
						const eOk =
							!("error" in arm) ||
							(arm.error === null
								? row.error == null
								: row.error !== null && row.error !== undefined);
						return sOk && eOk;
					});
				if (
					idOk &&
					effectFenceOk &&
					statusOk &&
					orOk &&
					casOk &&
					cancelRunOk &&
					encOk &&
					liveToVodOk &&
					exactFiltersOk
				) {
					// CLONE at push time (the same instrument rule as `update`
					// above): the fenced persist hands the SAME entries array on
					// every write, so a reference here would show every snapshot
					// in its final state and erase write-order evidence.
					updates.push(structuredClone(data));
					for (const [key, value] of Object.entries(data)) {
						if (
							value !== null &&
							typeof value === "object" &&
							"increment" in value
						) {
							row[key] =
								Number(row[key] ?? 0) +
								Number((value as { increment: number }).increment);
						} else {
							row[key] = value;
						}
					}
					return { count: 1 };
				}
				return { count: 0 };
			},
		),
	};
	// Attached feeder sessions (P3-PR3 coupling): stopChannel queries the
	// active ones and enqueues a stop per session.
	/**
	 *  / : the sessions the feeder actions READ back — a
	 * stateful map, because the commit's compare-and-swap and the duplicate
	 * guard both decide on a session's current columns. `create` registers
	 * what it made so a re-delivered start can find it; `updateMany` honours
	 * the four filters the commit CAS is made of.
	 */
	const feederRows = new Map<string, Record<string, unknown>>();
	const feederSession = {
		// Two readers: the stop coupling projects `{ id }`; the LC-02 occupancy
		// door projects the occupant's status/pid/host for its refusal text.
		findMany: vi.fn(
			async () =>
				[] as {
					id: string;
					status?: string;
					pid?: number | null;
					ownerHost?: string | null;
				}[],
		),
		findFirst: vi.fn(async () => null as { id: string } | null),
		//  — scheduled feeder starts create sessions here.
		count: vi.fn(async () => 0),
		create: vi.fn(async (args: { data: Record<string, unknown> }) => {
			feederRows.set("fs-sched-1", {
				id: "fs-sched-1",
				status: "CREATED",
				readyAt: null,
				commitRequestedAt: null,
				error: null,
				...args.data,
			});
			return { id: "fs-sched-1" };
		}),
		update: vi.fn(async () => ({})),
		findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
			const hit = feederRows.get(where.id);
			return hit ? { ...hit } : null;
		}),
		updateMany: vi.fn(
			async ({
				where,
				data,
			}: {
				where: {
					id: string;
					status?: string;
					readyAt?: null | { not: null };
					commitRequestedAt?: null;
				};
				data: Record<string, unknown>;
			}) => {
				const hit = feederRows.get(where.id);
				if (!hit) {
					return { count: 0 };
				}
				if (where.status !== undefined && hit.status !== where.status) {
					return { count: 0 };
				}
				if ("readyAt" in where) {
					const want = where.readyAt;
					if (want === null ? hit.readyAt != null : hit.readyAt == null) {
						return { count: 0 };
					}
				}
				if ("commitRequestedAt" in where && hit.commitRequestedAt != null) {
					return { count: 0 };
				}
				Object.assign(hit, data);
				return { count: 1 };
			},
		),
	};
	// Heartbeat time-series table: the sweep appends one row per poll and
	// prunes rows past the retention window (best-effort) — the prune reads
	// the stale ids in a capped batch, then deletes by id; two stale rows by
	// default so the delete statement is observable.
	const liveHeartbeat = {
		create: vi.fn(async () => ({})),
		findMany: vi.fn(async () => [{ id: "hb-stale-1" }, { id: "hb-stale-2" }]),
		deleteMany: vi.fn(async () => ({ count: 0 })),
	};
	const enqueueFeederJob = vi.fn(async (_job: FeederJob) => {});
	// review-223 F6: insert-content writes its window-closed note here;
	// #96's supersession guard reads rows through findUnique/findFirst.
	/**
	 * the schedule row REMEMBERS the session its start stamped, so
	 * a second delivery of the same job reads it back the way Postgres would.
	 * rev367 I-3 adds its STATUS (default FIRED — what every start/immediate
	 * job runs against; stage arms set ARMED) and makes the stamp's status
	 * CAS real: a `where.status` that does not match writes nothing, which is
	 * the exact behaviour the ended-mid-stage arm pins.
	 */
	const scheduleRow = {
		feederSessionId: null as string | null,
		status: "FIRED" as string,
	};
	const liveSchedule = {
		updateMany: vi.fn(
			async ({
				where,
				data,
			}: {
				where?: { status?: string };
				data?: { feederSessionId?: string };
			}) => {
				if (
					where?.status !== undefined &&
					where.status !== scheduleRow.status
				) {
					return { count: 0 };
				}
				if (typeof data?.feederSessionId === "string") {
					scheduleRow.feederSessionId = data.feederSessionId;
				}
				return { count: 1 };
			},
		),
		findUnique: vi.fn(async () => ({
			fireAt: new Date("2026-06-12T00:00:00Z"),
			feederSessionId: scheduleRow.feederSessionId,
			status: scheduleRow.status,
		})),
		findFirst: vi.fn(async () => null as { id: string } | null),
	};
	//  PR2: a minimal STATEFUL run-row stub — ensureCurrentRun
	// creates, mirror reads the latest back, update records the mirrored
	// data. One channel per harness, so a single slot suffices.
	const runRows: Array<{
		id: string;
		seq: number;
		status: string;
		liveChannelId?: string;
		bitmovinEncodingId?: string | null;
		outputPrefix?: string;
		/** What an earlier live-to-VOD roll of that run recorded (review-357). */
		liveToVod?: unknown;
		/** : the provider-lifecycle columns and the poll token. */
		heartbeatPollEpoch?: number;
		providerStatus?: string | null;
		providerStatusObservedAt?: Date | null;
		providerUnknownSince?: Date | null;
		providerUnknownAlertedAt?: Date | null;
		providerTerminalAt?: Date | null;
		providerFeederStopsEnqueuedAt?: Date | null;
		lastHeartbeat?: unknown;
		lastHeartbeatAt?: Date | null;
		[key: string]: unknown;
	}> =
		row.status === "RUNNING" && typeof row.bitmovinEncodingId === "string"
			? [
					{
						id: LIVE_TO_VOD_RUN_ID,
						seq: 1,
						status: "RUNNING",
						bitmovinEncodingId: row.bitmovinEncodingId,
						heartbeatPollEpoch: 0,
						providerStatus: "RUNNING",
						providerStatusObservedAt: new Date("2099-01-01T00:00:00.000Z"),
						providerUnknownSince: null,
						providerTerminalAt: null,
						lastHeartbeatAt: null,
						createdAt: new Date("2026-06-11T23:00:00.000Z"),
						streamKey: row.streamKey,
						encoderIp: row.encoderIp,
					},
				]
			: [];
	const liveChannelRun = {
		/**
		 * honours `where.bitmovinEncodingId` (the heartbeat history's
		 * run lookup) — after a re-air the OLD encoding's sample must find the
		 * OLD run, not the newest row; every other read is "the current run".
		 */
		findFirst: vi.fn(
			async (args?: { where?: { bitmovinEncodingId?: string } }) => {
				const want = args?.where?.bitmovinEncodingId;
				const pool =
					want === undefined
						? runRows
						: runRows.filter((r) => r.bitmovinEncodingId === want);
				return pool[pool.length - 1] ?? null;
			},
		),
		findMany: vi.fn(async () => runRows),
		/**
		 * the fenced run writes — the poll-token claim, the provider
		 * lifecycle CAS, the heartbeat door — are MODELLED, not answered
		 * `count: 1` regardless. A stub that matches every `where` turns every
		 * fence test into a tautology (the exact trap the channel stub's
		 * `provisionClaimedAt` CAS documents above). Equality, `null`, `{ not }`,
		 * `{ in }` and the atomic `{ increment }` are all it needs.
		 */
		updateMany: vi.fn(
			async ({
				where,
				data,
			}: {
				where?: Record<string, unknown>;
				data: Record<string, unknown>;
			}) => {
				const matches = runRows.filter((r) => {
					for (const [key, want] of Object.entries(where ?? {})) {
						if (key === "liveChannelId") {
							continue;
						}
						if (key === "liveToVod") {
							const filter = want as { path: string[]; equals: unknown };
							const stored = r.liveToVod as Record<string, unknown> | undefined;
							if (stored?.[filter.path[0] ?? ""] !== filter.equals) {
								return false;
							}
							continue;
						}
						if (key === "AND") {
							const filters = Array.isArray(want) ? want : [want];
							const stored = r.liveToVod as Record<string, unknown> | undefined;
							const exact = filters.every((entry) => {
								const filter = (
									entry as {
										liveToVod?: { path: string[]; equals: unknown };
									}
								).liveToVod;
								return (
									!filter || stored?.[filter.path[0] ?? ""] === filter.equals
								);
							});
							if (!exact) return false;
							continue;
						}
						const have = r[key];
						if (want !== null && typeof want === "object") {
							const cond = want as { not?: unknown; in?: unknown[] };
							if ("not" in cond && have === cond.not) {
								return false;
							}
							if ("in" in cond && !cond.in?.includes(have)) {
								return false;
							}
							continue;
						}
						if (want === null ? have != null : have !== want) {
							return false;
						}
					}
					return true;
				});
				for (const r of matches) {
					for (const [key, value] of Object.entries(data)) {
						if (
							value !== null &&
							typeof value === "object" &&
							"increment" in (value as object)
						) {
							r[key] =
								((r[key] as number | undefined) ?? 0) +
								(value as { increment: number }).increment;
						} else {
							r[key] = structuredClone(value);
						}
					}
				}
				return { count: matches.length };
			},
		),
		create: vi.fn(async (args: { data: Record<string, unknown> }) => {
			const created = {
				id: `run-${runRows.length + 1}`,
				seq: (args.data.seq as number) ?? runRows.length + 1,
				status: (args.data.status as string) ?? "CREATED",
			};
			runRows.push(created);
			return { id: created.id };
		}),
		update: vi.fn(
			async (args: {
				where: { id: string };
				data: Record<string, unknown>;
			}) => {
				const row = runRows.find((r) => r.id === args.where.id);
				if (row) {
					// Every mirrored column lands ( needs the mirror's
					// `bitmovinEncodingId` so a provisioned run carries its
					// identity into the sweep); status stays the field tests read.
					Object.assign(row, args.data);
				}
				return {};
			},
		),
	};
	//  PR1: the provision arms write startup samples (best-effort).
	const startupSample = {
		upsert: vi.fn(async () => ({})),
		findUnique: vi.fn(async () => null),
		create: vi.fn(async () => ({})),
	};
	// Model the atomic ordering a real database transaction provides. Without
	// serialization, one failed callback can restore its snapshot over another
	// concurrent callback that already committed, making the harness invent a
	// lost fence that production cannot produce.
	let transactionTail = Promise.resolve();
	const prisma = {
		liveChannel,
		feederSession,
		liveHeartbeat,
		liveSchedule,
		liveChannelRun,
		startupSample,
		$transaction: vi.fn(async <T>(fn: (tx: AppPrismaClient) => Promise<T>) => {
			let release = () => {};
			const predecessor = transactionTail;
			transactionTail = new Promise<void>((resolve) => {
				release = resolve;
			});
			await predecessor;
			// Transaction writes in this fake replace fields rather than mutating
			// nested values. A shallow snapshot therefore restores both value and
			// identity (notably Date anchors asserted with `toBe`).
			const rowBefore = { ...row };
			const runsBefore = runRows.map((current) => ({ ...current }));
			try {
				return await fn(prisma as unknown as AppPrismaClient);
			} catch (err) {
				for (const key of Object.keys(row)) delete row[key];
				Object.assign(row, rowBefore);
				for (let index = 0; index < runRows.length; index += 1) {
					const current = runRows[index];
					const previous = runsBefore[index];
					if (!current || !previous) continue;
					for (const key of Object.keys(current)) delete current[key];
					Object.assign(current, previous);
				}
				runRows.splice(
					runsBefore.length,
					Math.max(0, runRows.length - runsBefore.length),
				);
				for (
					let index = runRows.length;
					index < runsBefore.length;
					index += 1
				) {
					const previous = runsBefore[index];
					if (previous) runRows.push(previous);
				}
				throw err;
			} finally {
				release();
			}
		}),
		/**
		 * The atomic append the worker now uses for runtime records
		 * (`appendLiveChannelStepLogEntry` → `jsonb ||`, no read). Modelled here
		 * rather than mocked away so the tests still observe the record landing.
		 *
		 * NOTE FOR ANYONE WRITING A LOST-UPDATE TEST: `findUnique` above returns
		 * the SAME object reference, so a "stale" read in this harness observes
		 * later mutations and no lost update can ever be reproduced here. That is
		 * why the concurrent-clobber finding was argued from call order and the
		 * db module's own docstring rather than from a test — building a fake
		 * that returns detached copies specifically to make the hypothesis
		 * reproducible would have been building the instrument to fit it.
		 */
		$executeRaw: vi.fn(async (strings: unknown, ...values: unknown[]) => {
			const sql = Array.isArray(strings) ? strings.join("?") : String(strings);
			const appended = JSON.parse(String(values[0])) as unknown[];
			if (sql.includes('UPDATE "LiveChannelRun"')) {
				const [, runId, channelId, providerEncodingId] = values;
				const exactRun = runRows.find(
					(run) =>
						run.id === runId &&
						(run.liveChannelId ?? CHANNEL_ID) === channelId &&
						run.bitmovinEncodingId === providerEncodingId,
				);
				if (!exactRun) return 0;
				exactRun.stepLog = [
					...((exactRun.stepLog as unknown[]) ?? []),
					...appended,
				];
				return 1;
			}
			if (sql.includes('UPDATE "LiveChannel" AS channel')) {
				const [, channelId, providerEncodingId, generation] = values;
				if (
					channelId !== row.id ||
					providerEncodingId !== row.bitmovinEncodingId ||
					generation !== row.liveEffectFenceVersion
				) {
					return 0;
				}
			}
			row.stepLog = [
				...((row.stepLog as unknown[]) ?? []),
				...appended,
			] as Row["stepLog"];
			return 1;
		}),
	} as unknown as AppPrismaClient;
	const sdk = fakeSdk(sdkOverrides);
	const deps: LiveChannelDeps = {
		prisma,
		enqueueFeederJob,
		revealBitmovinAccount: vi.fn(async () => ({
			apiKey: "key",
			tenantOrgId: null,
		})),
		resolveCredential: vi.fn(async () => ({
			provider: "AWS_S3",
			config: {},
			secret: { accessKeyId: "a", secretAccessKey: "s" },
		})),
		makeSdk: makeSdkSpy ?? (() => sdk),
		sleep: () => Promise.resolve(),
		pollIntervalMs: 1,
		pollTimeoutMs: 1000,
		now: () => "2026-06-12T00:00:00.000Z",
	};
	const rawProcess = createLiveChannelProcessor(deps);
	const actionToEffect = {
		stop: "STOP",
		restart: "RESTART",
		"reset-timeshift": "TIMESHIFT_RESET",
		scte35: "SCTE35",
		"insert-content": "SLATE_INSERT",
		"register-slate-content": "SLATE_REGISTER",
		"feeder-start": "FEEDER_START",
		"feeder-switch": "FEEDER_COMMIT",
		"feeder-commit": "FEEDER_COMMIT",
	} as const;
	const processWithEffect = (jobData: unknown) => {
		if (
			typeof jobData !== "object" ||
			jobData === null ||
			!("action" in jobData) ||
			typeof jobData.action !== "string" ||
			!(jobData.action in actionToEffect) ||
			"effect" in jobData
		) {
			return rawProcess(jobData);
		}
		const action = jobData.action as keyof typeof actionToEffect;
		const params =
			"params" in jobData && typeof jobData.params === "object"
				? (jobData.params as Record<string, unknown>)
				: undefined;
		return rawProcess({
			...jobData,
			effect: {
				idempotencyKey: `test:${action}:${randomUUID()}`,
				liveChannelRunId: "00000000-0000-4000-8000-0000000000cc",
				providerEncodingId: "bm-live-enc",
				admissionFenceVersion: 0,
				action: actionToEffect[action],
				...(typeof params?.scheduleId === "string"
					? { scheduleId: params.scheduleId }
					: {}),
			},
		});
	};
	return {
		process: processWithEffect,
		rawProcess,
		actions: createLiveChannelActions(deps),
		sweep: createLiveHeartbeatSweep(deps),
		deps,
		row,
		updates,
		liveChannelRun,
		runRows,
		sdk,
		liveChannel,
		liveSchedule,
		scheduleRow,
		feederSession,
		feederRows,
		liveHeartbeat,
		startupSample,
		enqueueFeederJob,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	liveToVodAttemptSequence = 0;
	liveEffectMocks.begin.mockImplementation(
		async (_prisma: unknown, input: Record<string, unknown>) => ({
			kind: "EXECUTE",
			claim: {
				id: `claim:${String(input.idempotencyKey)}`,
				idempotencyKey: input.idempotencyKey,
				token: `token:${String(input.idempotencyKey)}`,
				liveChannelId: input.liveChannelId,
				liveChannelRunId: input.liveChannelRunId,
				providerEncodingId: input.providerEncodingId,
				action: input.action,
				generation: 1,
				expiresAt: new Date("2026-06-12T00:20:00.000Z"),
			},
		}),
	);
	liveEffectMocks.assertCurrent.mockResolvedValue(true);
	liveEffectMocks.bindTarget.mockResolvedValue(true);
	liveEffectMocks.markAcked.mockResolvedValue(true);
	liveEffectMocks.markAmbiguous.mockResolvedValue(true);
	liveEffectMocks.markFailed.mockResolvedValue(true);
	liveEffectMocks.resolveAfterStop.mockResolvedValue({
		kind: "RESOLVED",
		count: 0,
	});
});

describe("run-bound redundant RTMP ingest update", () => {
	function rtmpJob() {
		const plan = structuredClone(basePlan);
		plan.liveInput = {
			key: "main",
			kind: "REDUNDANT_RTMP",
			name: "Redundant",
			ingestPoints: [
				{ applicationName: "primary", streamKey: "secret-primary" },
				{ applicationName: "backup", streamKey: "secret-backup" },
			],
		};
		const params = { pointIndexes: [1] };
		const requestSha256 = createHash("sha256")
			.update(
				JSON.stringify({
					runId: LIVE_TO_VOD_RUN_ID,
					...params,
					ingestPoints: [plan.liveInput.ingestPoints?.[1]],
				}),
			)
			.digest("hex");
		return {
			plan,
			job: {
				liveChannelId: CHANNEL_ID,
				action: "update-rtmp-ingest",
				params,
				effect: {
					idempotencyKey: "rtmp-request",
					action: "RTMP_INGEST_UPDATE",
					requestSha256,
					liveChannelRunId: LIVE_TO_VOD_RUN_ID,
					providerEncodingId: "bm-live-enc",
					admissionFenceVersion: 0,
				},
			},
		};
	}
	function harness(overrides: Partial<SdkOps> = {}) {
		const { plan, job } = rtmpJob();
		return {
			...setup(
				{
					status: "RUNNING",
					bitmovinEncodingId: "bm-live-enc",
					bitmovinAccountId: ACCOUNT_ID,
					plan,
				},
				overrides,
			),
			job,
		};
	}
	it("sends only selected declared points after the durable send fence", async () => {
		const t = harness();
		expect(await t.rawProcess(t.job)).toMatchObject({ status: "RUNNING" });
		expect(t.sdk.updateLiveRtmpIngestPoints).toHaveBeenCalledWith(
			"bm-live-enc",
			[{ applicationName: "backup", streamKey: "secret-backup" }],
		);
		expect(liveEffectMocks.assertCurrent).toHaveBeenCalled();
		expect(liveEffectMocks.markAcked).toHaveBeenCalled();
	});
	it("fails before send when the RUNNING channel encoding differs from the admitted run and claim", async () => {
		const t = harness();
		t.row.bitmovinEncodingId = "unrelated-encoding";
		// The durable claim and its current run still identify bm-live-enc.
		expect(t.runRows[0]?.bitmovinEncodingId).toBe("bm-live-enc");
		const beforeChannel = structuredClone(t.row);
		const beforeRun = structuredClone(t.runRows);
		const makeSdk = vi.fn(t.deps.makeSdk);
		t.deps.makeSdk = makeSdk;
		let effectState = "CLAIMED";
		liveEffectMocks.markFailed.mockImplementationOnce(
			async (_prisma, claim) => {
				expect(claim.providerEncodingId).toBe("bm-live-enc");
				effectState = "FAILED";
				return true;
			},
		);
		await expect(t.rawProcess(t.job)).rejects.toThrow(/encoding.*claim/i);
		expect(makeSdk).not.toHaveBeenCalled();
		expect(t.sdk.updateLiveRtmpIngestPoints).not.toHaveBeenCalled();
		expect(liveEffectMocks.markAcked).not.toHaveBeenCalled();
		expect(liveEffectMocks.markAmbiguous).not.toHaveBeenCalled();
		expect(liveEffectMocks.markFailed).toHaveBeenCalledOnce();
		expect(effectState).toBe("FAILED");
		expect(t.row).toEqual(beforeChannel);
		expect(t.runRows).toEqual(beforeRun);
		expect(t.updates).toEqual([]);
	});
	it.each([
		"STALE",
		"BLOCKED",
	])("never sends when the durable claim is %s (stale run, stop or reset)", async (kind) => {
		liveEffectMocks.begin.mockResolvedValueOnce({
			kind,
			reason: "fenced",
			state: "CLAIMED",
		});
		const t = harness();
		await t.rawProcess(t.job);
		expect(t.sdk.updateLiveRtmpIngestPoints).not.toHaveBeenCalled();
	});
	it("refuses a reset/stop fence lost immediately before send", async () => {
		const t = harness();
		liveEffectMocks.assertCurrent.mockResolvedValue(false);
		await expect(t.rawProcess(t.job)).rejects.toThrow(/refused|fence/i);
		expect(t.sdk.updateLiveRtmpIngestPoints).not.toHaveBeenCalled();
		expect(liveEffectMocks.markFailed).toHaveBeenCalled();
	});
	it("does not send edited indexes and records a provider failure as ambiguous without secrets", async () => {
		const tampered = harness();
		tampered.job.params.pointIndexes = [0];
		await expect(tampered.rawProcess(tampered.job)).rejects.toThrow(
			/admitted plan/,
		);
		expect(tampered.sdk.updateLiveRtmpIngestPoints).not.toHaveBeenCalled();
		const t = harness({
			updateLiveRtmpIngestPoints: vi.fn(async () => {
				throw new Error("secret-backup https://secret");
			}),
		});
		expect(await t.rawProcess(t.job)).toMatchObject({
			status: "EFFECT_AMBIGUOUS",
		});
		expect(
			JSON.stringify(liveEffectMocks.markAmbiguous.mock.calls),
		).not.toContain("secret-backup");
		expect(liveEffectMocks.markAcked).not.toHaveBeenCalled();
	});
});

describe("live channel provisioning", () => {
	it("two concurrent provisions build ONE encoding tree, not two", async () => {
		/**
		 * AKR-E57-003, RUNTIME-VERIFIED against the real API before this fix:
		 * two complete encoding trees on one channel, writing the same output
		 * prefix, both billed.
		 *
		 * How both jobs got in: create enqueues `jobId: <channelId>` and leaves
		 * the row CREATED; a start arriving before that job runs atomically
		 * claims the row into PROVISIONING and enqueues its OWN job under a
		 * timestamped id BullMQ cannot dedupe against the first. `provision`
		 * then accepted CREATED *and* PROVISIONING, so both passed — at live
		 * concurrency 8 they ran side by side.
		 *
		 * Asserted at the OUTCOME an operator is billed for: how many encodings
		 * were created. Asserting "the second returned early" would pass on a
		 * guard that returned early for the wrong reason.
		 */
		const { process, sdk } = setup();
		const results = await Promise.all([
			process({ liveChannelId: CHANNEL_ID }),
			process({ liveChannelId: CHANNEL_ID }),
		]);
		expect(sdk.createEncoding).toHaveBeenCalledTimes(1);
		expect(sdk.startLiveEncoding).toHaveBeenCalledTimes(1);
		// One of them did the work; neither threw.
		expect(results.filter((r) => r.status === "RUNNING")).toHaveLength(1);
	});

	it("replays the step log as it stands AFTER winning the lease, not before", async () => {
		/**
		 * The winner must RE-READ. The first cut asserted it did — in the code
		 * comment and in the commit message — and there was exactly one
		 * `findUnique`, taken BEFORE the claim, with everything below parsing
		 * that stale snapshot.
		 *
		 * Why it matters: the start action rewrites the step log inside its own
		 * atomic claim, and a re-air gets a fresh log rebased into its own
		 * subtree (#155). A job that read the row before that claim and won the
		 * lease after it would replay the OLD log — writing the new run's
		 * segments under the previous airing's prefix, the exact hazard #155
		 * exists to prevent.
		 *
		 * Simulated at the seam: the row's step log is replaced with an
		 * Simulated at the seam: the row's plan is rewritten immediately after
		 * the pre-claim read, and the observable is the Bitmovin account the run
		 * authenticates as — read out of the row AFTER the claim. (Two earlier
		 * observables did not work and are worth naming: a finished step log is
		 * re-seeded to PENDING by the stale-RTMP guard, and the encoding name is
		 * baked into the step log at compile time rather than read from the row.)
		 */
		const { process, row, deps } = setup();
		const realFindUnique = deps.prisma.liveChannel.findUnique;
		let reads = 0;
		(
			deps.prisma.liveChannel as {
				findUnique: (a: unknown) => Promise<unknown>;
			}
		).findUnique = async (args: unknown) => {
			const out = await (realFindUnique as (a: unknown) => Promise<unknown>)(
				args,
			);
			// After the FIRST read — the pre-claim snapshot — someone else's
			// claim rewrites the row.
			if (++reads === 1) {
				const plan = structuredClone(row.plan) as {
					bitmovin: { accountId: string };
				};
				plan.bitmovin.accountId = OTHER_ACCOUNT_ID;
				row.plan = plan;
			}
			return out;
		};
		await process({ liveChannelId: CHANNEL_ID });
		expect(reads).toBeGreaterThan(1); // it read again after claiming
		// The account the run authenticates as comes out of the row AFTER the
		// claim. A run replaying its pre-claim snapshot would use the old one.
		expect(deps.revealBitmovinAccount).toHaveBeenCalledWith(OTHER_ACCOUNT_ID);
	});

	it("RENEWS the lease while it waits — a 636s Osaka provision keeps it", async () => {
		/**
		 * The lease is a staleness window, not a provision budget.
		 *
		 * The first cut fixed it at ten minutes and justified that with a
		 * sub-minute figure that exists nowhere in this repo — for a corpus with
		 * zero live scenarios. The measured reality is Osaka: 197 / 424 / 562 /
		 * 595 / 595 / 605 / 614 / 636 seconds, median 589.5s. Three of eight
		 * exceed ten minutes, so a fixed window would hand the lease to a second
		 * worker MID-PROVISION, restoring the exact double-provision this exists
		 * to prevent .
		 *
		 * So it heartbeats on the poll tick. This drives one real poll by making
		 * the encoding report QUEUED once before RUNNING, which is the only way
		 * a processor test reaches `ctx.poll.sleep` at all — `poll-sleep.ts`
		 * says so in its own docstring, and that is why the renewal needs its
		 * own arm rather than riding an existing one.
		 */
		let calls = 0;
		const { process, row, updates } = setup(
			{},
			{
				getEncodingStatus: vi.fn(() =>
					Promise.resolve({ status: ++calls === 1 ? "QUEUED" : "RUNNING" }),
				),
			},
		);
		const claimedFirst = row.provisionClaimedAt as Date | null;
		await process({ liveChannelId: CHANNEL_ID });
		expect(calls).toBeGreaterThan(1); // it really polled
		// The lease moved: the heartbeat wrote a fresh stamp during the wait —
		// read from the WRITES, because the row itself no longer carries the
		// lease once the provision leaves PROVISIONING (: the fence
		// releases on leaving, as the VOD twin does).
		const renewals = updates
			.map(
				(u) => (u as { provisionClaimedAt?: Date | null }).provisionClaimedAt,
			)
			.filter((d): d is Date => d instanceof Date);
		expect(renewals.length).toBeGreaterThan(1);
		expect(renewals.some((d) => d !== claimedFirst)).toBe(true);
		expect(row.status).toBe("RUNNING");
		expect(row.provisionClaimedAt).toBeNull();
	});

	it("STOPS when the lease is lost mid-provision instead of building a second tree", async () => {
		// The compare-and-swap's whole point: a renewal that no longer matches
		// means another worker owns this channel. Continuing would be the
		// double-provision again, just later in the run.
		let calls = 0;
		let row: Record<string, unknown> | undefined;
		const harness = setup(
			{},
			{
				getEncodingStatus: vi.fn(() => {
					// Steal the lease BETWEEN polls — this runs before the sleep,
					// so the renewal that follows finds a timestamp that is no
					// longer the one we wrote. Deterministic, unlike a timer.
					if (++calls === 1 && row) {
						row.provisionClaimedAt = new Date("2030-01-01T00:00:00.000Z");
					}
					return Promise.resolve({
						status: calls === 1 ? "QUEUED" : "RUNNING",
					});
				}),
			},
		);
		row = harness.row;
		/**
		 * It returns QUIETLY. The first cut threw a plain Error, and review
		 * measured what that actually did: the throw happens inside
		 * `executeStep`, so the step loop's catch marked the row ERROR, stamped
		 * a FAILED startup sample, emitted CHANNEL_ERROR and persisted this
		 * run's stale entries — then rethrew into BullMQ's failed handler,
		 * which flips PROVISIONING to ERROR and retires transitional runs with
		 * no attemptsMade guard.
		 *
		 * Every one of those lands on the WINNER: a healthy channel another
		 * worker is provisioning correctly. Status writes went
		 * PROVISIONING, PROVISIONING, ERROR.
		 */
		const result = await harness.process({ liveChannelId: CHANNEL_ID });
		expect(result).toMatchObject({ status: "PROVISIONING" });
		// The winner's row is untouched by the loser.
		expect(harness.row.status).not.toBe("ERROR");
		expect(harness.row.status).not.toBe("RUNNING");
		expect(harness.row.error ?? null).toBeNull();
		// And no operator-facing alarm was raised about a healthy channel.
		const emit = harness.deps.emitEvent as
			| { mock: { calls: unknown[][] } }
			| undefined;
		const kinds = (emit?.mock.calls ?? []).map(
			(c) => (c[0] as { kind?: string })?.kind,
		);
		expect(kinds).not.toContain("CHANNEL_ERROR");
	});

	it("a STALE lease is takeable — a dead worker must not wedge the channel", async () => {
		// The lease expires rather than being released by name, so a worker
		// killed mid-provision leaves the row claimable. Without this the fix
		// would trade a double-billing bug for a permanently stuck channel.
		const { process, row, sdk } = setup();
		row.provisionClaimedAt = new Date(
			new Date("2026-06-12T00:00:00.000Z").getTime() - 60 * 60 * 1000,
		);
		const result = await process({ liveChannelId: CHANNEL_ID });
		expect(result).toMatchObject({ status: "RUNNING" });
		expect(sdk.createEncoding).toHaveBeenCalledTimes(1);
	});

	it("a FRESH lease held by someone else is refused", async () => {
		// The other end of the same rule: within the window, a second worker
		// does nothing. Without this arm the stale-lease test above would pass
		// on a lease that never blocks anything.
		const { process, row, sdk } = setup();
		row.provisionClaimedAt = new Date("2026-06-12T00:00:00.000Z");
		row.status = "PROVISIONING";
		const result = await process({ liveChannelId: CHANNEL_ID });
		expect(sdk.createEncoding).not.toHaveBeenCalled();
		expect(result).toMatchObject({ status: "PROVISIONING" });
	});

	it("replays every step to RUNNING and persists encoder coordinates", async () => {
		const { process, row, updates, sdk } = setup();
		const result = await process({ liveChannelId: CHANNEL_ID });
		expect(result).toMatchObject({ action: "provision", status: "RUNNING" });
		expect(row.status).toBe("RUNNING");
		expect(row.bitmovinEncodingId).toBe("bm-live-enc");
		// rev431: the pointer write voids any stop/CREATED confirmation
		expect(
			updates.some(
				(u) =>
					u.bitmovinEncodingId === "bm-live-enc" &&
					u.encoderStoppedConfirmedFor === null,
			),
		).toBe(true);
		// Columns carry the readable ingest coordinates (ledger exception).
		expect(row.streamKey).toBe("fakeStreamKey");
		expect(row.encoderIp).toBe("203.0.113.10");
		// RTMP resolved by list; the start request zipped V2 + stream key.
		expect(sdk.listRtmpInputs).toHaveBeenCalled();
		expect(sdk.startLiveEncoding).toHaveBeenCalledWith(
			"bm-live-enc",
			expect.objectContaining({ manifestGenerator: "V2" }),
		);
		const entries = row.stepLog as StepLogEntry[];
		expect(entries.every((e) => e.status === "DONE")).toBe(true);
		// Status walked CREATED → PROVISIONING → RUNNING.
		const statusUpdates = updates
			.map((u) => u.status)
			.filter((s): s is string => typeof s === "string");
		expect(statusUpdates[0]).toBe("PROVISIONING");
		expect(statusUpdates.at(-1)).toBe("RUNNING");
	});

	it("acknowledges cancellation during startup as STOPPED, never RUNNING or CHANNEL_ERROR", async () => {
		const h = setup(
			{},
			{
				getEncodingStatus: vi.fn(async () => ({
					status: "CANCELED",
					messages: ["Encoding stopped by user"],
				})),
			},
		);
		h.deps.emitEvent = vi.fn(async () => {});
		await expect(
			h.process({ liveChannelId: CHANNEL_ID }),
		).resolves.toMatchObject({ status: "STOPPED" });
		expect(h.row).toMatchObject({
			status: "STOPPED",
			error: null,
			bitmovinEncodingId: "bm-live-enc",
			provisionClaimedAt: null,
		});
		expect(h.runRows[0]).toMatchObject({
			status: "STOPPED",
			providerStatus: "CANCELED",
		});
		expect(h.deps.emitEvent).toHaveBeenCalledWith(
			expect.objectContaining({ kind: "CHANNEL_STOPPED" }),
		);
		expect(h.deps.emitEvent).not.toHaveBeenCalledWith(
			expect.objectContaining({ kind: "CHANNEL_ERROR" }),
		);
		expect(h.sdk.getLiveEncodingDetails).not.toHaveBeenCalled();
		const entry = (h.row.stepLog as StepLogEntry[]).find(
			(e) => e.kind === "AWAIT_LIVE_RUNNING",
		);
		expect(entry?.response).toMatchObject({
			status: "CANCELED",
			messages: ["Encoding stopped by user"],
		});
		expect(h.runRows[0]?.stepLog).toEqual(h.row.stepLog);
		const outcomes = h.liveSchedule.updateMany.mock.calls
			.map((call) => (call[0] as { data?: { outcome?: string } }).data?.outcome)
			.filter(Boolean);
		expect(outcomes).toContain("FAILED");
		expect(outcomes).not.toContain("DELIVERED");
		await expect(
			h.process({ liveChannelId: CHANNEL_ID }),
		).resolves.toMatchObject({ status: "STOPPED" });
		expect(h.sdk.createEncoding).toHaveBeenCalledTimes(1);
	});

	it.each([
		"ERROR",
		"TRANSFER_ERROR",
	])("keeps provider %s a failure even with cancellation-like text", async (status) => {
		const h = setup(
			{},
			{
				getEncodingStatus: vi.fn(async () => ({
					status,
					messages: ["Encoding stopped by user"],
				})),
			},
		);
		await expect(h.process({ liveChannelId: CHANNEL_ID })).rejects.toThrow(
			`ended ${status}`,
		);
		expect(h.row.status).toBe("ERROR");
	});

	it("does not overwrite a new lease when CANCELED returns to the old startup worker", async () => {
		const h = setup();
		h.sdk.getEncodingStatus = vi.fn(async () => {
			h.row.provisionClaimedAt = new Date("2030-01-01T00:00:00.000Z");
			return { status: "CANCELED" };
		});
		h.deps.emitEvent = vi.fn(async () => {});
		await expect(
			h.process({ liveChannelId: CHANNEL_ID }),
		).resolves.toMatchObject({ status: "PROVISIONING" });
		expect(h.row.status).toBe("PROVISIONING");
		expect(h.row.provisionClaimedAt).toEqual(
			new Date("2030-01-01T00:00:00.000Z"),
		);
		expect(h.deps.emitEvent).not.toHaveBeenCalled();
	});

	it.each([
		2, 3,
	])("keeps a cancellation on finalize read %s STOPPED without a startup success", async (cancelRead) => {
		let reads = 0;
		const h = setup(
			{},
			{
				getEncodingStatus: vi.fn(async () => ({
					status: ++reads >= cancelRead ? "CANCELED" : "RUNNING",
				})),
			},
		);
		h.deps.emitEvent = vi.fn(async () => {});
		await expect(
			h.process({ liveChannelId: CHANNEL_ID }),
		).resolves.toMatchObject({ status: "STOPPED" });
		expect(h.row).toMatchObject({ status: "STOPPED", error: null });
		expect(h.runRows[0]).toMatchObject({
			status: "STOPPED",
			providerStatus: "CANCELED",
		});
		expect(h.deps.emitEvent).not.toHaveBeenCalledWith(
			expect.objectContaining({ kind: "CHANNEL_RUNNING" }),
		);
	});

	it("snapshots the C7 start request onto the await entry, redacted", async () => {
		const { process, row, sdk } = setup();
		await process({ liveChannelId: CHANNEL_ID });
		expect(sdk.getLiveStartRequest).toHaveBeenCalledWith("bm-live-enc");
		const entries = row.stepLog as StepLogEntry[];
		const awaitEntry = entries.find((e) => e.kind === "AWAIT_LIVE_RUNNING");
		expect(awaitEntry?.response).toMatchObject({
			status: "RUNNING",
			// Snapshots stay masked — only the columns carry the values.
			live: { streamKey: REDACTED, encoderIp: "203.0.113.10" },
			startRequest: { streamKey: REDACTED },
		});
	});

	it("resumes by reusing DONE resource ids when the RTMP input is unchanged", async () => {
		const { process, row, sdk } = setup();
		const entries = row.stepLog as StepLogEntry[];
		const first = entries[0]; // live-input:main (CREATE_INPUT_RTMP)
		const second = entries[1]; // output:origin
		if (!first || !second) {
			throw new Error("fixture entries missing");
		}
		// The DONE input id matches the account's current RTMP input → not stale.
		first.status = "DONE";
		first.resourceId = "bm-rtmp-default";
		second.status = "DONE";
		second.resourceId = "bm-existing-output";
		await process({ liveChannelId: CHANNEL_ID });
		// Resume now RE-RESOLVES the RTMP input to check for a frozen-stale id…
		expect(sdk.listRtmpInputs).toHaveBeenCalled();
		// …unchanged ⇒ DONE steps are reused (output not recreated), input reused.
		expect(sdk.createS3Output).not.toHaveBeenCalled();
		// Live streams reference the input directly (no IngestInputStream) — the
		// resolved RTMP input id rides on createStream's StreamInput (C13).
		expect(sdk.createStream).toHaveBeenCalledWith(
			"bm-live-enc",
			expect.objectContaining({ inputId: "bm-rtmp-default" }),
		);
	});

	it("rebuilds from the input when the frozen RTMP id is stale (fixes 2025 at start)", async () => {
		// A failed channel whose encoding froze a now-stale input id: the account
		// RTMP input re-resolves to a DIFFERENT id, so a plain resume would start
		// the dead encoding and hit "input could not be found" (2025) again. The
		// provision must rebuild the input layer + a fresh encoding against the
		// current input.
		const { process, row, sdk } = setup({ status: "PROVISIONING" });
		const entries = row.stepLog as StepLogEntry[];
		const input = entries.find((e) => e.kind === "CREATE_INPUT_RTMP");
		const encoding = entries.find((e) => e.kind === "CREATE_ENCODING");
		if (!input || !encoding) {
			throw new Error("fixture entries missing");
		}
		input.status = "DONE";
		input.resourceId = "bm-stale-rtmp"; // ≠ the account's "bm-rtmp-default"
		encoding.status = "DONE";
		encoding.resourceId = "bm-stale-enc";
		await process({ liveChannelId: CHANNEL_ID });
		// Re-resolved, found stale → the DONE encoding is rebuilt, not reused…
		expect(sdk.createEncoding).toHaveBeenCalled();
		// …and the new input streams reference the FRESH account input id.
		// Live streams reference the input directly (no IngestInputStream) — the
		// resolved RTMP input id rides on createStream's StreamInput (C13).
		expect(sdk.createStream).toHaveBeenCalledWith(
			"bm-live-enc",
			expect.objectContaining({ inputId: "bm-rtmp-default" }),
		);
		expect(row.status).toBe("RUNNING");
		const rebuiltInput = (row.stepLog as StepLogEntry[]).find(
			(e) => e.kind === "CREATE_INPUT_RTMP",
		);
		expect(rebuiltInput?.resourceId).toBe("bm-rtmp-default");
	});

	it("provision stamps as the CHANNEL — window opens only for the crash-leftover step", async () => {
		// Live job identity = the channel id, and the
		// adoption window mirrors the VOD processor's lifecycle exactly.
		const seen: Array<{ step: string | undefined; window: boolean }> = [];
		let stampRef:
			| {
					jobId: string;
					currentStep: () => string | undefined;
					adoptWindow?: () => boolean;
			  }
			| undefined;
		const harness = setup({ status: "PROVISIONING" }, {}, (args) => {
			stampRef = args.stamp;
			return new Proxy(harness.sdk, {
				get(target, prop, receiver) {
					const value = Reflect.get(target, prop, receiver);
					if (typeof value !== "function") {
						return value;
					}
					return (...callArgs: unknown[]) => {
						seen.push({
							step: stampRef?.currentStep(),
							window: stampRef?.adoptWindow?.() ?? false,
						});
						return (value as (...a: unknown[]) => unknown).apply(
							target,
							callArgs,
						);
					};
				},
			});
		});
		const entries = harness.row.stepLog as StepLogEntry[];
		const crashStep = entries[0]?.step as string;
		(entries[0] as { status: string }).status = "RUNNING";
		await harness.process({ liveChannelId: CHANNEL_ID });
		expect(stampRef?.jobId).toBe(CHANNEL_ID);
		const inCrash = seen.filter((c) => c.step === crashStep);
		const elsewhere = seen.filter((c) => c.step !== crashStep);
		expect(inCrash.length).toBeGreaterThan(0);
		expect(elsewhere.length).toBeGreaterThan(0);
		expect(inCrash.every((c) => c.window)).toBe(true);
		expect(elsewhere.every((c) => !c.window)).toBe(true);
		expect(stampRef?.adoptWindow?.()).toBe(false);
	});

	it("re-opens provider adoption for a verification CREATE reseeded from ERROR to PENDING", async () => {
		let observedWindow: boolean | undefined;
		let stampRef: CreateStamp | undefined;
		const harness = setup(
			{
				status: "PROVISIONING",
				verificationKey: "verify:run-1:retry:LIVE_CHANNEL",
				verificationRequestSha256: "b".repeat(64),
			},
			{},
			(args) => {
				stampRef = args.stamp;
				return fakeSdk({
					createEncoding: vi.fn(async () => {
						observedWindow = stampRef?.adoptWindow?.();
						return "bm-live-recovered";
					}),
				});
			},
		);
		const create = (harness.row.stepLog as StepLogEntry[]).find(
			(entry) => entry.kind === "CREATE_ENCODING",
		);
		if (!create) throw new Error("fixture CREATE_ENCODING missing");
		create.status = "PENDING";
		create.startedAt = "2026-06-11T23:59:00.000Z";
		create.finishedAt = "2026-06-11T23:59:01.000Z";
		await harness.process({ liveChannelId: CHANNEL_ID });
		expect(observedWindow).toBe(true);
	});

	it("the stale-RTMP rebuild bumps the stamp GENERATION — step#1, never bare", async () => {
		// The one path that legitimately creates twice from the same step id.
		// Without the generation, the rebuilt CREATE_ENCODING's failed-create
		// re-look could adopt the ABANDONED encoding (frozen on the stale
		// input) — a zombie the rebuild exists to bury .
		const seen: Array<{ step: string; window: boolean }> = [];
		let stampRef:
			| {
					currentStep: () => string | undefined;
					adoptWindow?: () => boolean;
			  }
			| undefined;
		const harness = setup(
			{
				status: "PROVISIONING",
				verificationKey: "verify:run-1:rebuild:LIVE_CHANNEL",
				verificationRequestSha256: "c".repeat(64),
			},
			{},
			(args) => {
				stampRef = args.stamp;
				return new Proxy(harness.sdk, {
					get(target, prop, receiver) {
						const value = Reflect.get(target, prop, receiver);
						if (typeof value !== "function") {
							return value;
						}
						return (...callArgs: unknown[]) => {
							const step = stampRef?.currentStep();
							if (step !== undefined) {
								seen.push({
									step,
									window: stampRef?.adoptWindow?.() ?? false,
								});
							}
							return (value as (...a: unknown[]) => unknown).apply(
								target,
								callArgs,
							);
						};
					},
				});
			},
		);
		const entries = harness.row.stepLog as StepLogEntry[];
		const input = entries.find((e) => e.kind === "CREATE_INPUT_RTMP");
		const encoding = entries.find((e) => e.kind === "CREATE_ENCODING");
		if (!input || !encoding) {
			throw new Error("fixture entries missing");
		}
		input.status = "DONE";
		input.resourceId = "bm-stale-rtmp";
		encoding.status = "DONE";
		encoding.resourceId = "bm-stale-enc";
		encoding.startedAt = "2026-06-11T23:58:00.000Z";
		encoding.finishedAt = "2026-06-11T23:59:00.000Z";
		await harness.process({ liveChannelId: CHANNEL_ID });
		// The rebuilt steps stamped with the BUMPED generation…
		const gen1 = seen.filter(({ step }) => step.endsWith("#1"));
		expect(gen1.length).toBeGreaterThan(0);
		expect(gen1.some(({ step }) => step.startsWith(encoding.step))).toBe(true);
		// This is a deliberately NEW generation, not a retry of #0. Its inherited
		// timestamps must not open adoption and bind it back to the stale encoder.
		expect(
			gen1
				.filter(({ step }) => step.startsWith(encoding.step))
				.every(({ window }) => !window),
		).toBe(true);
		// …and the re-seeded entries persist attempt=1 for the NEXT resume.
		const rebuilt = (harness.row.stepLog as StepLogEntry[]).find(
			(e) => e.kind === "CREATE_ENCODING",
		);
		expect(rebuilt?.attempt).toBe(1);
		// THE WRITE ORDER (review-172's forward note): attempt is the one
		// mutable identity component, so the bump must be DURABLE before the
		// create that stamps with it — otherwise a crash after the create
		// resumes on the old attempt and adopts the abandoned generation.
		// Proof from the persisted snapshots themselves: some stepLog write
		// carries the bumped CREATE_ENCODING entry with NO resourceId yet
		// (bump persisted strictly before the create's result existed).
		const persistedBeforeCreate = harness.updates.some((update) => {
			const log = (update as { stepLog?: StepLogEntry[] }).stepLog;
			const enc = log?.find((e) => e.kind === "CREATE_ENCODING");
			return enc?.attempt === 1 && enc.resourceId === undefined;
		});
		expect(persistedBeforeCreate).toBe(true);
	});

	it("does not execute a runtime record the stale-RTMP reset revived", async () => {
		/**
		 * The blocker a review found. The stale-RTMP guard re-seeds EVERY entry
		 * from the RTMP step to the end of the array to PENDING, and runtime
		 * records (cues, ESAM points) are appended at the end — so a DONE record
		 * arrives at the replay loop as PENDING through no author's mistake. The
		 * executor throws on such an entry by design, which bricked the channel:
		 * `rtmpStep` was PENDING so the guard would not re-fire, the record stayed
		 * PENDING forever, and every subsequent Start threw at the same line.
		 * Unrecoverable without DB surgery.
		 */
		const { process, row, sdk } = setup({ status: "PROVISIONING" });
		const entries = row.stepLog as StepLogEntry[];
		const input = entries.find((e) => e.kind === "CREATE_INPUT_RTMP");
		const encoding = entries.find((e) => e.kind === "CREATE_ENCODING");
		if (!input || !encoding) {
			throw new Error("fixture entries missing");
		}
		input.status = "DONE";
		input.resourceId = "bm-stale-rtmp";
		encoding.status = "DONE";
		encoding.resourceId = "bm-stale-enc";
		/**
		 * One record per runtime-record kind, DERIVED from the set rather than
		 * hand-listed.
		 *
		 * This is the correction that matters. The previous fixture said "one of
		 * each kind" and pushed two — while there were three. The absent one,
		 * `SLATE_INSERTED`, was also the one absent from `RUNTIME_RECORD_KINDS`,
		 * so the test that existed to prove records survive the reset asserted it
		 * over a population that excluded the only kind that did not. Both halves
		 * were short the same member, which is why 3,990 green tests said nothing
		 * about a KEY feature  wedging its channel forever.
		 *
		 * Deriving the fixtures means a fourth kind is covered the day it is
		 * added, by whoever adds it, without remembering this test exists.
		 */
		// No cardinality floor here. The first version asserted
		// `kinds.length > 2`, and review-298 showed it did more harm than good:
		// it short-circuits BEFORE any behaviour runs, so a mutation that
		// removed a kind "failed" this test without ever exercising the replay
		// path — a kill that proved nothing. It also decays, passing again as
		// soon as a fourth kind is registered. The set's completeness is pinned
		// by EQUALITY in packages/core/src/plan/steplog.test.ts, and by tsc via
		// the exhaustive OPERATION_KIND_EXECUTION record. This fixture's job is
		// the behaviour: every classified kind survives the reset.
		const kinds = [...RUNTIME_RECORD_KINDS];
		entries.push(
			...kinds.map(
				(kind, i) =>
					({
						step: `${kind.toLowerCase()}:2026-08-06T00:${String(i).padStart(2, "0")}:00.000Z`,
						kind,
						payload: {
							at: `2026-08-06T00:${String(i).padStart(2, "0")}:00.000Z`,
						},
						refs: { encodingId: "bm-stale-enc" },
						status: "DONE",
					}) as StepLogEntry,
			),
		);
		await process({ liveChannelId: CHANNEL_ID });
		// The channel provisions instead of wedging.
		expect(row.status).toBe("RUNNING");
		expect(row.error ?? null).toBeNull();
		// And the records were neither executed nor re-fired into the live stream:
		// every kind's firing SDK call, not just the cue's.
		expect(sdk.insertScte35Cue).not.toHaveBeenCalled();
		expect(sdk.scheduleInsertableContent).not.toHaveBeenCalled();
	});

	it("does not rebuild when the account has multiple RTMP inputs (can't disambiguate)", async () => {
		// Degenerate: with >1 RTMP input the id can't be re-resolved
		// deterministically, so the stale-input guard is a no-op (no worse than
		// before the fix) — the executor's >1 error / start diagnostic surface it
		// rather than silently rebuilding against an arbitrary input.
		const { process, row, sdk } = setup(
			{ status: "PROVISIONING" },
			{
				listRtmpInputs: vi.fn(() =>
					Promise.resolve([{ id: "bm-rtmp-a" }, { id: "bm-rtmp-b" }]),
				),
			},
		);
		const entries = row.stepLog as StepLogEntry[];
		const input = entries.find((e) => e.kind === "CREATE_INPUT_RTMP");
		const encoding = entries.find((e) => e.kind === "CREATE_ENCODING");
		if (!input || !encoding) {
			throw new Error("fixture entries missing");
		}
		input.status = "DONE";
		input.resourceId = "bm-stale-rtmp";
		encoding.status = "DONE";
		encoding.resourceId = "bm-stale-enc";
		await process({ liveChannelId: CHANNEL_ID });
		// No deterministic fresh id → no reset → the DONE encoding is reused.
		expect(sdk.createEncoding).not.toHaveBeenCalled();
	});

	it("marks the failing step and the channel on error — no sibling stops (single encoding)", async () => {
		const { process, row, sdk } = setup(
			{},
			{
				createEncoding: vi.fn(() =>
					Promise.reject(new Error("region rejected")),
				),
			},
		);
		await expect(process({ liveChannelId: CHANNEL_ID })).rejects.toThrow(
			"region rejected",
		);
		expect(row.status).toBe("ERROR");
		expect(row.error).toBe("region rejected");
		const entries = row.stepLog as StepLogEntry[];
		const failed = entries.find((e) => e.kind === "CREATE_ENCODING");
		expect(failed?.status).toBe("FAILED");
		expect(entries[0]?.status).toBe("DONE");
		expect(sdk.stopEncoding).not.toHaveBeenCalled();
		expect(sdk.stopLiveEncoding).not.toHaveBeenCalled();
	});

	it("sets ERROR when finalize cannot read the live details", async () => {
		const { process, row } = setup(
			{},
			{
				getLiveEncodingDetails: vi.fn(() =>
					Promise.reject(new Error("details unavailable")),
				),
			},
		);
		await expect(process({ liveChannelId: CHANNEL_ID })).rejects.toThrow(
			"details unavailable",
		);
		expect(row.status).toBe("ERROR");
		// Steps stayed DONE — a retry resumes at finalize only.
		const entries = row.stepLog as StepLogEntry[];
		expect(entries.every((e) => e.status === "DONE")).toBe(true);
	});

	it("samples startup time on the RUNNING transition — and mirrors queueSeconds onto the run (ledger #160 PR1)", async () => {
		const { process, startupSample, liveChannelRun } = setup();
		await process({ liveChannelId: CHANNEL_ID });
		expect(startupSample.upsert).toHaveBeenCalledWith(
			expect.objectContaining({
				create: expect.objectContaining({
					source: "CHANNEL",
					outcome: "RUNNING",
				}),
				// The upsert's update arm overwrites a provisional FAILED row the
				// reconciler may have written while the run fought the queue.
				update: expect.objectContaining({ outcome: "RUNNING" }),
			}),
		);
		expect(liveChannelRun.update).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					queueSeconds: expect.any(Number),
				}),
			}),
		);
	});

	it("records a FAILED startup sample when a provision step dies (ledger #160 PR1)", async () => {
		const { process, startupSample } = setup(
			{},
			{
				createEncoding: vi.fn(() =>
					Promise.reject(new Error("region rejected")),
				),
			},
		);
		await expect(process({ liveChannelId: CHANNEL_ID })).rejects.toThrow(
			"region rejected",
		);
		expect(startupSample.create).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					outcome: "FAILED",
					// The step ID (not the kind): "encoding" is what the step-loop
					// catch hands over — the stable per-step identifier.
					failedPhase: "encoding",
				}),
			}),
		);
		expect(startupSample.upsert).not.toHaveBeenCalled();
	});

	it("never resurrects a STOPPED verification channel when its delayed create enqueue arrives", async () => {
		// POST can commit the local row, then recovery can stop it before the
		// route's queue.add completes. The later provision job must remain a no-op.
		const { process, row, sdk } = setup({
			status: "STOPPED",
			verificationKey: "verify:run:scenario:LIVE_CHANNEL",
			verificationRequestSha256: "a".repeat(64),
		});
		const result = await process({ liveChannelId: CHANNEL_ID });
		expect(result.status).toBe("STOPPED");
		expect(row.status).toBe("STOPPED");
		expect(sdk.startLiveEncoding).not.toHaveBeenCalled();
	});

	it("provisions rows the start action claimed into PROVISIONING", async () => {
		// The actions route's atomic CREATED|ERROR → PROVISIONING claim is
		// the lock; the worker must accept the claimed state.
		const { process, row } = setup({ status: "PROVISIONING" });
		const result = await process({ liveChannelId: CHANNEL_ID });
		expect(result).toMatchObject({ action: "provision", status: "RUNNING" });
		expect(row.status).toBe("RUNNING");
	});

	it("skips stale provision jobs on ERROR rows (start re-claims explicitly)", async () => {
		// ERROR means a failure path or the dead-job sweep released the
		// claim — a zombie job re-running provision would be the
		// double-provision race the route claim exists to prevent.
		const { process, row, sdk } = setup({ status: "ERROR" });
		const result = await process({ liveChannelId: CHANNEL_ID });
		expect(result.status).toBe("ERROR");
		expect(row.status).toBe("ERROR");
		expect(sdk.listRtmpInputs).not.toHaveBeenCalled();
		expect(sdk.startLiveEncoding).not.toHaveBeenCalled();
	});

	it("acknowledges missing channels without throwing", async () => {
		const { process } = setup();
		const result = await process({
			liveChannelId: "00000000-0000-4000-8000-0000000000ff",
		});
		expect(result.status).toBe("MISSING");
	});
});

/**
 * A real step log with the CREATE_ENCODING entry pointing at a DIFFERENT encoding than the column.
 *
 * Hand-built entries do not survive `stepLogSchema.parse`, and a rejected log falls back to the
 * column alone — which is the very state under test, so the test would have passed for the wrong
 * reason. Built from the compiler's own log instead.
 */
function stepLogNaming(encodingId: string) {
	const plan = structuredClone(basePlan);
	plan.bitmovin.accountId = ACCOUNT_ID;
	const entries = initStepLog(compileLiveChannel(plan));
	for (const entry of entries) {
		if (entry.kind === "CREATE_ENCODING") {
			entry.status = "DONE";
			entry.resourceId = encodingId;
		}
	}
	return entries;
}

describe("live channel actions", () => {
	const runningRow = {
		status: "RUNNING",
		bitmovinAccountId: ACCOUNT_ID,
		bitmovinEncodingId: "bm-live-enc",
	};

	it("stops a RUNNING channel: STOPPING → stop API → STOPPED", async () => {
		try {
			const { process, row, updates, sdk } = setup(runningRow, {
				getEncodingStatus: async () => ({ status: "FINISHED" }) as never,
			});
			const result = await process({
				liveChannelId: CHANNEL_ID,
				action: "stop",
			});
			expect(result).toMatchObject({ action: "stop", status: "STOPPED" });
			expect(sdk.stopLiveEncoding).toHaveBeenCalledWith("bm-live-enc");
			const statusUpdates = updates.map((u) => u.status);
			expect(statusUpdates).toEqual(["STOPPING", "STOPPED"]);
			expect(row.status).toBe("STOPPED");
		} finally {
			vi.unstubAllEnvs();
		}
	});

	it("an UNCONFIRMED stop keeps its evidence — STOPPED with error null is a promise", async () => {
		/**
		 * The most expensive lie this system can tell, as a test.
		 *
		 * The stop path polls until the encoding reaches a terminal state; when
		 * it does not, it pushed the failure onto `failures`, logged it, and
		 * then wrote `status: "STOPPED", error: null` UNCONDITIONALLY — clearing
		 * the one field that could have carried the evidence. The row was then
		 * indistinguishable from a clean stop, and 's reset
		 * classified it as safe to delete: a live encoder billing per minute,
		 * with its only local record removed (#48). Reported by review-265.
		 *
		 * `error` now carries the unconfirmed-stop message, which is what makes
		 * `STOPPED` mean stopped-and-CONFIRMED when it is null.
		 */
		const { process, row } = setup(runningRow, {
			// Never reaches a terminal state, so the stop cannot be confirmed.
			getEncodingStatus: async () => ({ status: "RUNNING" }) as never,
		});
		const result = await process({ liveChannelId: CHANNEL_ID, action: "stop" });
		expect(result).toMatchObject({ status: "EFFECT_AMBIGUOUS" });
		expect(liveEffectMocks.markAmbiguous).toHaveBeenCalledOnce();
		expect(row.status).toBe("STOPPED");
		expect(row.error).toMatch(/stop did not confirm/);
	});

	it("a stop whose status could NEVER be read is unconfirmed, not clean", async () => {
		/**
		 * The third arm, and the one with the least evidence of all.
		 *
		 * The two arms around this one cover a status that stays RUNNING
		 * (unconfirmed) and one that reaches FINISHED (confirmed). Neither makes
		 * the status GET *throw* — and that path had its own answer: the poll
		 * starts at the sentinel "unknown", the catch breaks out on the first
		 * failure leaving it unassigned, and "unknown" was itself listed as an
		 * accepted terminal state. So a stop we could not observe AT ALL was
		 * recorded exactly like a stop we watched reach FINISHED: `STOPPED`,
		 * `error: null`.
		 *
		 * That is the combination #130's reset reads as safe to delete, so the
		 * row vanished while the encoder kept billing (#48). Fewer observations
		 * must never produce a cleaner record.
		 */
		const { process, row } = setup(runningRow, {
			getEncodingStatus: async () => {
				throw new Error("502 Bad Gateway from the status endpoint");
			},
		});
		const result = await process({ liveChannelId: CHANNEL_ID, action: "stop" });
		expect(result).toMatchObject({ status: "EFFECT_AMBIGUOUS" });
		expect(liveEffectMocks.markAmbiguous).toHaveBeenCalledOnce();
		expect(row.status).toBe("STOPPED");
		expect(row.error).toMatch(/stop did not confirm/);
		expect(row.error).toMatch(/could never be read/);
	});

	it("a CONFIRMED stop clears the error — the flag must not be sticky", async () => {
		// The local fake answers RUNNING (the live steady state, which
		// AWAIT_LIVE_RUNNING needs), so a stop NEVER confirms under it — which
		// means the pin above passed for a reason that had nothing to do with
		// its subject until this arm existed. Confirming needs a terminal
		// status, and both arms have to be real for either to mean anything.
		const { process, row, runRows } = setup(
			{ ...runningRow, error: "an older failure" },
			{ getEncodingStatus: async () => ({ status: "FINISHED" }) as never },
		);
		await process({ liveChannelId: CHANNEL_ID, action: "stop" });
		expect(row.status).toBe("STOPPED");
		// Null is the assertion the reset reads as "confirmed", so a stop that
		// DID confirm has to clear whatever was there.
		expect(row.error).toBeNull();
		expect(runRows[0]).toMatchObject({
			id: LIVE_TO_VOD_RUN_ID,
			providerStatus: "FINISHED",
			providerStatusObservedAt: new Date("2026-06-12T00:00:00.000Z"),
			providerTerminalAt: new Date("2026-06-12T00:00:00.000Z"),
		});
		expect(liveEffectMocks.resolveAfterStop).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				liveChannelRunId: LIVE_TO_VOD_RUN_ID,
				providerEncodingId: "bm-live-enc",
			}),
		);
	});

	it("keeps STOP ambiguous while a feeder still occupies the exact ended run", async () => {
		const t = setup(runningRow, {
			getEncodingStatus: async () => ({ status: "FINISHED" }) as never,
		});
		t.feederSession.findFirst.mockResolvedValue({ id: "feed-still-pushing" });

		const result = await t.process({
			liveChannelId: CHANNEL_ID,
			action: "stop",
		});

		expect(result).toMatchObject({ status: "EFFECT_AMBIGUOUS" });
		expect(t.row.error).toMatch(/publisher termination was not confirmed/);
		expect(liveEffectMocks.resolveAfterStop).not.toHaveBeenCalled();
		expect(liveEffectMocks.markAmbiguous).toHaveBeenCalledOnce();
	});

	it.each([
		"ERROR",
		"STOPPED",
	])("repeated %s cleanup preserves first end clocks but refreshes provider observation", async (status) => {
		const t = setup(runningRow, {
			getEncodingStatus: async () => ({ status: "FINISHED" }) as never,
		});
		const first = new Date("2026-06-11T15:12:00.000Z");
		Object.assign(t.row, { status, error: "old cleanup failure" });
		const run = t.runRows[0];
		if (!run) throw new Error("missing run fixture");
		Object.assign(run, {
			status,
			error: "old cleanup failure",
			endedAt: first,
			providerTerminalAt: first,
		});
		await t.process({ liveChannelId: CHANNEL_ID, action: "stop" });
		expect(t.runRows[0]).toMatchObject({
			status: "STOPPED",
			error: null,
			endedAt: first,
			providerTerminalAt: first,
			providerStatusObservedAt: new Date("2026-06-12T00:00:00.000Z"),
		});
	});

	it("retains a provider terminal clock committed during a concurrent stop readback", async () => {
		const first = new Date("2026-06-11T23:59:00.000Z");
		const t = setup(runningRow, {
			getEncodingStatus: async () => ({ status: "FINISHED" }) as never,
		});
		const write = t.liveChannelRun.updateMany.getMockImplementation();
		const run = t.runRows[0];
		if (!write || !run) throw new Error("missing run fixture");
		t.liveChannelRun.updateMany.mockImplementation(async (args) => {
			if (
				"providerStatusObservedAt" in args.data ||
				"providerTerminalAt" in args.data
			) {
				run.providerTerminalAt ??= first;
			}
			return write(args);
		});
		await t.process({ liveChannelId: CHANNEL_ID, action: "stop" });
		expect(t.runRows[0]?.providerTerminalAt).toEqual(first);
		expect(t.row.error).toBeNull();
	});

	it("a queued retry can stop a STOPPED row whose previous stop never confirmed", async () => {
		/**
		 * The route now hands the stop to BullMQ before its best-effort STOPPING
		 * projection. The worker can therefore win that race while the row still
		 * has the retry shape produced by an unconfirmed stop: STOPPED + error.
		 * Rejecting that shape here would make the route's documented retry
		 * nondeterministic — it would work only when the HTTP process won the race.
		 */
		const { process, row, sdk, runRows } = setup(
			{
				...runningRow,
				status: "STOPPED",
				error: "stop did not confirm — bm-live-enc: still RUNNING",
			},
			{ getEncodingStatus: async () => ({ status: "FINISHED" }) as never },
		);
		runRows.push({
			id: LIVE_TO_VOD_RUN_ID,
			seq: 1,
			status: "STOPPED",
			bitmovinEncodingId: "bm-live-enc",
			providerStatus: "RUNNING",
			providerStatusObservedAt: new Date("2099-01-01T00:00:00.000Z"),
			providerUnknownSince: null,
			providerTerminalAt: null,
		});

		const result = await process({
			liveChannelId: CHANNEL_ID,
			action: "stop",
		});

		expect(result).toMatchObject({ action: "stop", status: "STOPPED" });
		expect(sdk.stopLiveEncoding).toHaveBeenCalledWith("bm-live-enc");
		expect(row.status).toBe("STOPPED");
		expect(row.error).toBeNull();
	});

	it("stops EVERY encoding the channel knows about, not just the column's", async () => {
		/**
		 * The seven-hour leak, as a test.
		 *
		 * Four channels reported STOPPED while Bitmovin had four DIFFERENT encodings of the same
		 * channels RUNNING — the oldest for 7h19m, billing the whole time. For `live-rtmp-simple`
		 * the column held `63c65f0d…` and the step log's `CREATE_ENCODING` held `f0c0e872…`, and
		 * `f0c0e872…` was the one running. Stop read the column, stopped something already
		 * terminal, and reported success.
		 *
		 * `live-processor.ts` stated the assumption in a comment — "stop/restart require RUNNING and
		 * read the column, not the step log" — which is only safe while the two agree, and nothing
		 * made them agree. Stopping an already-terminal encoding is a no-op; failing to stop a
		 * running one is a bill, and those errors are not symmetrical.
		 */
		const { process, sdk } = setup({
			...runningRow,
			stepLog: stepLogNaming("bm-live-enc-ORPHAN"),
		});
		await process({ liveChannelId: CHANNEL_ID, action: "stop" });
		// `fakeSdk` types its members as plain functions, so the mock surface needs the cast the
		// rest of this file already uses for the prisma stub.
		const stopped = vi.mocked(sdk.stopLiveEncoding).mock.calls.map((c) => c[0]);
		expect(stopped).toContain("bm-live-enc");
		expect(stopped, "the step log's encoding must be stopped too").toContain(
			"bm-live-enc-ORPHAN",
		);
	});

	it("does not fail the whole stop when a SECONDARY encoding refuses", async () => {
		/**
		 * The primary id's failure must still mark ERROR and propagate — two tests pin that, and it
		 * is right. But a secondary id that refuses must not convert a successful primary stop into
		 * an ERROR, or the channel becomes unstoppable through the normal path.
		 */
		const { process, sdk, row } = setup({
			...runningRow,
			stepLog: stepLogNaming("bm-live-enc-ORPHAN"),
		});
		vi.mocked(sdk.stopLiveEncoding).mockImplementation(async (id) => {
			if (id === "bm-live-enc-ORPHAN") {
				throw new Error("410 Gone");
			}
		});
		const result = await process({ liveChannelId: CHANNEL_ID, action: "stop" });
		expect(result).toMatchObject({ status: "EFFECT_AMBIGUOUS" });
		expect(liveEffectMocks.markAmbiguous).toHaveBeenCalledOnce();
		expect(row.status).toBe("STOPPED");
	});

	it("rejects stopping a channel that is not stoppable", async () => {
		const { process, sdk } = setup({
			...runningRow,
			status: "CREATED",
		});
		await expect(
			process({ liveChannelId: CHANNEL_ID, action: "stop" }),
		).rejects.toThrow(/cannot be stopped from status CREATED/);
		expect(sdk.stopLiveEncoding).not.toHaveBeenCalled();
	});

	it("marks ERROR and rethrows when the stop API fails", async () => {
		const { process, row } = setup(runningRow, {
			stopLiveEncoding: vi.fn(() => Promise.reject(new Error("stop refused"))),
		});
		const result = await process({ liveChannelId: CHANNEL_ID, action: "stop" });
		expect(result).toMatchObject({ status: "EFFECT_AMBIGUOUS" });
		expect(liveEffectMocks.markAmbiguous).toHaveBeenCalledOnce();
		expect(row.status).toBe("ERROR");
		expect(row.error).toBe("stop refused");
	});

	it("stop ALSO stops attached active feeder sessions (P3-PR3 coupling contract)", async () => {
		const { process, feederSession, enqueueFeederJob } = setup(runningRow);
		feederSession.findMany.mockResolvedValueOnce([
			{ id: "feed-1" },
			{ id: "feed-2" },
		]);
		await process({ liveChannelId: CHANNEL_ID, action: "stop" });
		// Active sessions — PLUS any terminal row still holding shared occupancy
		// (audit 2026-08-29 CRITICAL-2): a dead START job leaves an ERROR
		// row whose `-stream_loop -1` ffmpeg is still pushing, and a channel
		// stop is exactly when that orphan must be reclaimed. A terminal row
		// with no process reference is still never re-stopped.
		expect(feederSession.findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					liveChannelId: CHANNEL_ID,
					OR: [
						feederOccupancyWhere(),
						{ status: { in: ["CREATED", "DOWNLOADING", "PUSHING"] } },
					],
				}),
			}),
		);
		expect(enqueueFeederJob.mock.calls.map((c) => c[0])).toEqual([
			{ feederSessionId: "feed-1", action: "stop" },
			{ feederSessionId: "feed-2", action: "stop" },
		]);
	});

	it("feeder stops propagate the stop INTENT even when the stop API then fails", async () => {
		const { process, feederSession, enqueueFeederJob } = setup(runningRow, {
			stopLiveEncoding: vi.fn(() => Promise.reject(new Error("stop refused"))),
		});
		feederSession.findMany.mockResolvedValueOnce([{ id: "feed-1" }]);
		const result = await process({ liveChannelId: CHANNEL_ID, action: "stop" });
		expect(result).toMatchObject({ status: "EFFECT_AMBIGUOUS" });
		expect(liveEffectMocks.markAmbiguous).toHaveBeenCalledOnce();
		expect(enqueueFeederJob).toHaveBeenCalledWith({
			feederSessionId: "feed-1",
			action: "stop",
		});
	});

	it("a failed feeder-stop enqueue SURFACES into the channel error, without blocking the stop", async () => {
		// It must not BLOCK the channel stop — the encodings still have to be
		// stopped — but it must NOT be swallowed either: a stop that never reached
		// the queue leaves the feeder's `-stream_loop -1` ffmpeg pushing into a
		// dead ingest, and logging-and-continuing reported the channel torn down
		// while that push kept running (the paid-audit false-clean). The failure
		// is folded into `error`, the same durable field the provider-stop
		// confirmation writes, so `STOPPED` with a null error keeps meaning
		// stopped-and-confirmed-clean end to end — and the verify cleanup seal
		// reads it as a not-confirmed provider terminal.
		// The PROVIDER stop is confirmed terminal (FINISHED), so the ONLY fault is
		// the feeder-stop enqueue — the error carries it and nothing else.
		const { process, row, feederSession, enqueueFeederJob, sdk } = setup(
			runningRow,
			{ getEncodingStatus: async () => ({ status: "FINISHED" }) as never },
		);
		feederSession.findMany.mockResolvedValueOnce([{ id: "feed-1" }]);
		enqueueFeederJob.mockRejectedValueOnce(new Error("redis down"));
		const result = await process({ liveChannelId: CHANNEL_ID, action: "stop" });
		// Not blocked: the channel still reaches STOPPED and the encodings stop.
		expect(result).toMatchObject({ status: "EFFECT_AMBIGUOUS" });
		expect(liveEffectMocks.markAmbiguous).toHaveBeenCalledOnce();
		expect(sdk.stopLiveEncoding).toHaveBeenCalled();
		expect(row.status).toBe("STOPPED");
		// Not swallowed: the enqueue failure is durable on the channel error, so
		// `STOPPED` here is NOT the confirmed-clean shape (error is non-null).
		expect(row.error).toMatch(/feeder stop could not be enqueued/);
		expect(row.error).toContain("feed-1");
		expect(row.error).toContain("redis down");
	});

	it("a clean channel stop with every feeder-stop enqueued keeps error null", async () => {
		// The control for the surfacing above: with the provider stop CONFIRMED
		// terminal (getEncodingStatus FINISHED) and the enqueue landing, `error`
		// stays null — the mutation that reverts to log-and-continue would leave
		// this green while turning the assertion above red.
		const { process, row, feederSession } = setup(runningRow, {
			getEncodingStatus: async () => ({ status: "FINISHED" }) as never,
		});
		feederSession.findMany.mockResolvedValueOnce([{ id: "feed-1" }]);
		await process({ liveChannelId: CHANNEL_ID, action: "stop" });
		expect(row.status).toBe("STOPPED");
		expect(row.error).toBeNull();
	});

	/**
	 * a restart reconciles the provider's lifecycle for the run's
	 * EXACT encoding first, so every restart test seeds the run row that
	 * carries it (production rows always do — #240's backfill and the start
	 * routes; a channel with no run has no identity to reconcile onto and is
	 * refused, pinned further down).
	 */
	const seedRun = (
		t: ReturnType<typeof setup>,
		over: Partial<(typeof t.runRows)[number]> = {},
	) => {
		t.runRows.push({
			id: "run-1",
			seq: 1,
			status: "RUNNING",
			bitmovinEncodingId: "bm-live-enc",
			heartbeatPollEpoch: 0,
			providerStatus: null,
			providerStatusObservedAt: null,
			providerUnknownSince: null,
			providerUnknownAlertedAt: null,
			providerTerminalAt: null,
			providerFeederStopsEnqueuedAt: null,
			...over,
		});
		return t.runRows[0] as NonNullable<(typeof t.runRows)[0]>;
	};

	it("a restart that loses its effect fence before send cannot overwrite the winning STOP", async () => {
		const t = setup({
			...runningRow,
			status: "PROVISIONING",
			liveEffectFenceVersion: 1,
		});
		seedRun(t);
		liveEffectMocks.assertCurrent.mockImplementation(async () => {
			// The same-run manual STOP atomically superseded this restart.
			t.row.status = "STOPPING";
			t.row.liveEffectFenceVersion = 2;
			return false;
		});

		await expect(
			t.process({ liveChannelId: CHANNEL_ID, action: "restart" }),
		).rejects.toThrow(/exact run\/generation fence/);
		expect(t.sdk.restartLiveEncoding).not.toHaveBeenCalled();
		expect(t.row.status).toBe("STOPPING");
		expect(t.updates).not.toEqual(
			expect.arrayContaining([expect.objectContaining({ status: "ERROR" })]),
		);
		expect(liveEffectMocks.assertCurrent).toHaveBeenCalledTimes(2);
	});

	it("a restart response that loses to STOP cannot late-mark the channel ERROR", async () => {
		const t = setup({
			...runningRow,
			status: "PROVISIONING",
			liveEffectFenceVersion: 1,
		});
		seedRun(t);
		let fenceChecks = 0;
		liveEffectMocks.assertCurrent.mockImplementation(async () => {
			fenceChecks += 1;
			if (fenceChecks === 1) return true;
			// Simulate STOP committing immediately after the catch's claim read.
			// Returning the now-stale true snapshot forces the ERROR write's own
			// generation CAS—not a check-then-write—to preserve STOPPING.
			t.row.status = "STOPPING";
			t.row.liveEffectFenceVersion = 2;
			return true;
		});
		vi.mocked(t.sdk.restartLiveEncoding).mockImplementation(async () => {
			// The request crossed its send boundary before its response was lost.
			throw new Error("restart response was lost");
		});

		await expect(
			t.process({ liveChannelId: CHANNEL_ID, action: "restart" }),
		).resolves.toMatchObject({ status: "EFFECT_AMBIGUOUS" });
		expect(t.sdk.restartLiveEncoding).toHaveBeenCalledOnce();
		expect(t.row.status).toBe("STOPPING");
		expect(t.updates).not.toEqual(
			expect.arrayContaining([expect.objectContaining({ status: "ERROR" })]),
		);
		expect(liveEffectMocks.assertCurrent).toHaveBeenCalledTimes(2);
		expect(liveEffectMocks.markAmbiguous).toHaveBeenCalled();
	});

	it("restarts a route-claimed channel back to RUNNING only after the exact encoding reads back RUNNING and its fresh details (row #280)", async () => {
		// The actions route claims RUNNING|ERROR → PROVISIONING; the worker job
		// arrives with the claim already held.
		const t = setup({
			...runningRow,
			status: "PROVISIONING",
			streamKey: "old",
			encoderIp: "198.51.100.1",
		});
		const run = seedRun(t);
		const { process, row, sdk, liveChannel } = t;
		const result = await process({
			liveChannelId: CHANNEL_ID,
			action: "restart",
		});
		expect(result).toMatchObject({ action: "restart", status: "RUNNING" });
		expect(sdk.restartLiveEncoding).toHaveBeenCalledWith("bm-live-enc");
		expect(row.status).toBe("RUNNING");
		// encoderIp can change across restarts — refreshed from live get.
		expect(row.encoderIp).toBe("203.0.113.10");
		// The provider was asked BEFORE the restart call, after it reached
		// RUNNING, and once more after the potentially slow details GET. RUNNING
		// was written only after that final observation.
		const statusReads = vi.mocked(sdk.getEncodingStatus).mock
			.invocationCallOrder;
		const restartCall = vi.mocked(sdk.restartLiveEncoding).mock
			.invocationCallOrder[0] as number;
		expect(statusReads.length).toBeGreaterThanOrEqual(3);
		expect(statusReads[0] as number).toBeLessThan(restartCall);
		expect(statusReads[1] as number).toBeGreaterThan(restartCall);
		const runningWriteIndex = liveChannel.updateMany.mock.calls.findIndex(
			(call) => (call[0] as { data: Row }).data.status === "RUNNING",
		);
		expect(runningWriteIndex).toBeGreaterThanOrEqual(0);
		const runningWrite = liveChannel.updateMany.mock.invocationCallOrder[
			runningWriteIndex
		] as number;
		expect(statusReads.at(-1) as number).toBeLessThan(runningWrite);
		expect(liveChannel.updateMany.mock.calls[runningWriteIndex]?.[0]).toEqual(
			expect.objectContaining({
				where: expect.objectContaining({
					bitmovinEncodingId: "bm-live-enc",
					provisionClaimedAt: null,
				}),
			}),
		);
		// The observation that licensed RUNNING is on the run.
		expect(run.providerStatus).toBe("RUNNING");
		expect(run.providerStatusObservedAt).toBeInstanceOf(Date);
		expect(run.providerUnknownSince).toBeNull();
	});

	it("restart clears stale ingest coordinates when the fresh details omit them", async () => {
		const t = setup(
			{
				...runningRow,
				status: "PROVISIONING",
				streamKey: "stale-key",
				encoderIp: "198.51.100.1",
			},
			{
				getLiveEncodingDetails: vi.fn(async () => ({ application: "live" })),
			},
		);
		const run = seedRun(t, {
			streamKey: "stale-key",
			encoderIp: "198.51.100.1",
		});

		await t.process({ liveChannelId: CHANNEL_ID, action: "restart" });

		expect(t.row.streamKey).toBeNull();
		expect(t.row.encoderIp).toBeNull();
		expect(run.streamKey).toBeNull();
		expect(run.encoderIp).toBeNull();
	});

	it("restart NEVER writes a startup sample — it reuses a live encoding and measures nothing (ledger #160 PR1)", async () => {
		const t = setup({
			...runningRow,
			status: "PROVISIONING",
		});
		seedRun(t);
		await t.process({ liveChannelId: CHANNEL_ID, action: "restart" });
		expect(t.startupSample.upsert).not.toHaveBeenCalled();
		expect(t.startupSample.create).not.toHaveBeenCalled();
	});

	it("refuses restart jobs without a held claim (stalled duplicates)", async () => {
		// A duplicate arriving after the first restart completed sees
		// RUNNING — bailing here prevents a second stream interruption.
		const { process, row, sdk } = setup(runningRow);
		await expect(
			process({ liveChannelId: CHANNEL_ID, action: "restart" }),
		).rejects.toThrow(/not claimed for restart \(status RUNNING\)/);
		expect(sdk.restartLiveEncoding).not.toHaveBeenCalled();
		expect(row.status).toBe("RUNNING");
	});

	it("a restart whose fresh details cannot be read lands ERROR with every id kept — RUNNING over the previous coordinates is a dead ingest presented as live (row #280, rewrites the old best-effort pin)", async () => {
		// This test used to assert the OPPOSITE ("keeps RUNNING when the
		// post-restart detail refresh fails"). item 6
		// makes the fresh details part of what licenses RUNNING: ingest
		// coordinates can change across a restart, and a channel shown RUNNING
		// with the old IP sends the operator's encoder at a dead ingest.
		const t = setup(
			{ ...runningRow, status: "PROVISIONING", streamKey: "old" },
			{
				getLiveEncodingDetails: vi.fn(() =>
					Promise.reject(new Error("not up yet")),
				),
			},
		);
		seedRun(t);
		const result = await t.process({
			liveChannelId: CHANNEL_ID,
			action: "restart",
		});
		expect(result).toMatchObject({ status: "EFFECT_AMBIGUOUS" });
		expect(liveEffectMocks.markAmbiguous).toHaveBeenCalledOnce();
		expect(t.row.status).toBe("ERROR");
		expect(t.row.error).toMatch(/not up yet/);
		// Every id kept: the operator's Start (revive) re-reads the details at
		// finalize; nothing was deleted or cleared.
		expect(t.row.bitmovinEncodingId).toBe("bm-live-enc");
		expect(t.runRows[0]?.bitmovinEncodingId).toBe("bm-live-enc");
	});

	describe("provider lifecycle at restart", () => {
		it("details delay race: RUNNING before the GET but FINISHED after it never commits local RUNNING", async () => {
			let detailsReturned = false;
			const t = setup(
				{ ...runningRow, status: "PROVISIONING" },
				{
					getEncodingStatus: vi.fn(async () => ({
						status: detailsReturned ? "FINISHED" : "RUNNING",
					})),
					getLiveEncodingDetails: vi.fn(async () => {
						detailsReturned = true;
						return {
							streamKey: "too-late",
							encoderIp: "203.0.113.10",
						};
					}),
				},
			);
			const run = seedRun(t);

			const result = await t.process({
				liveChannelId: CHANNEL_ID,
				action: "restart",
			});
			expect(result).toMatchObject({ status: "EFFECT_AMBIGUOUS" });
			expect(liveEffectMocks.markAmbiguous).toHaveBeenCalledOnce();

			expect(t.updates.map((u) => u.status)).not.toContain("RUNNING");
			expect(t.row.status).toBe("STOPPED");
			expect(run.providerTerminalAt).toBeInstanceOf(Date);
			expect(t.sdk.getEncodingStatus).toHaveBeenCalledTimes(3);
		});

		it("provider FINISHED → restart: provider restart call 0, local RUNNING 0; the run is terminalised, the channel's coordinates and heartbeat are cleared, the id is kept, and the run's feeders are stopped", async () => {
			// The observed paid sequence, step 2: the auto-shutdown FINISHED
			// encoding met a Restart. The old code called the vendor (409),
			// marked ERROR with nothing recording WHY, and the next Start revived
			// the finished encoding. Now the provider is asked first.
			const t = setup(
				{
					...runningRow,
					status: "PROVISIONING",
					streamKey: "old",
					encoderIp: "198.51.100.1",
					lastHeartbeat: {
						at: "2026-06-11T23:59:30.000Z",
						raw: {},
						deltas: {},
					},
					runningSince: new Date("2026-06-11T23:00:00.000Z"),
				},
				{ getEncodingStatus: vi.fn(async () => ({ status: "FINISHED" })) },
			);
			const run = seedRun(t);
			t.feederSession.findMany.mockResolvedValueOnce([{ id: "feed-1" }]);
			await expect(
				t.process({ liveChannelId: CHANNEL_ID, action: "restart" }),
			).rejects.toThrow(/FINISHED/);
			expect(liveEffectMocks.markAmbiguous).not.toHaveBeenCalled();
			expect(t.sdk.restartLiveEncoding).not.toHaveBeenCalled();
			expect(t.updates.map((u) => u.status)).not.toContain("RUNNING");
			expect(t.row.status).toBe("STOPPED");
			expect(t.row.error).toBeNull();
			// The run carries the terminal stamp — what makes the next Start a
			// RE-AIR (the route reads it) instead of a revive.
			expect(run.status).toBe("STOPPED");
			expect(run.providerTerminalAt).toBeInstanceOf(Date);
			expect(run.providerStatus).toBe("FINISHED");
			expect(run.endedAt).toBeInstanceOf(Date);
			// Active coordinates and the heartbeat are cleared; the provider id is
			// KEPT on both rows (the stop/reset sweeps and the operator must still
			// find the encoding — false-fix list: never delete the old id first).
			expect(t.row.streamKey).toBeNull();
			expect(t.row.encoderIp).toBeNull();
			expect(t.row.runningSince).toBeNull();
			expect(t.row.bitmovinEncodingId).toBe("bm-live-enc");
			expect(run.bitmovinEncodingId).toBe("bm-live-enc");
			// That run's feeders get a stop enqueued.
			expect(t.enqueueFeederJob).toHaveBeenCalledWith({
				feederSessionId: "feed-1",
				action: "stop",
			});
			expect(t.feederSession.findMany).toHaveBeenCalledWith(
				expect.objectContaining({
					where: expect.objectContaining({ liveChannelRunId: "run-1" }),
				}),
			);
		});

		it("an UNKNOWN readback at restart calls no provider restart, lands ERROR with a retryable reason, opens the unknown window, and keeps every id and coordinate", async () => {
			const t = setup(
				{ ...runningRow, status: "PROVISIONING", streamKey: "old" },
				{
					getEncodingStatus: vi.fn(async () => {
						throw new Error("request timed out after 10000ms");
					}),
				},
			);
			const run = seedRun(t);
			await expect(
				t.process({ liveChannelId: CHANNEL_ID, action: "restart" }),
			).rejects.toThrow(/cannot be confirmed/);
			expect(t.sdk.restartLiveEncoding).not.toHaveBeenCalled();
			expect(t.row.status).toBe("ERROR");
			expect(t.row.error).toMatch(/retry/);
			expect(t.row.error).toMatch(/timed out/);
			// Nothing cleaned up: UNKNOWN is not terminal.
			expect(t.row.bitmovinEncodingId).toBe("bm-live-enc");
			expect(t.row.streamKey).toBe("old");
			expect(run.providerTerminalAt).toBeNull();
			expect(run.providerUnknownSince).toBeInstanceOf(Date);
			expect(t.enqueueFeederJob).not.toHaveBeenCalled();
		});

		it("route-admission race: RUNNING at entry, FINISHED after the restart call → reconciled terminal, local RUNNING 0", async () => {
			// The route admitted the restart while the provider still said
			// RUNNING; the encoding ended before the readback. Acceptance of the
			// restart call is not a lifecycle observation.
			const statuses = ["RUNNING", "FINISHED", "FINISHED"];
			const t = setup(
				{ ...runningRow, status: "PROVISIONING" },
				{
					getEncodingStatus: vi.fn(async () => ({
						status: statuses.shift() ?? "FINISHED",
					})),
				},
			);
			const run = seedRun(t);
			const result = await t.process({
				liveChannelId: CHANNEL_ID,
				action: "restart",
			});
			expect(result).toMatchObject({ status: "EFFECT_AMBIGUOUS" });
			expect(liveEffectMocks.markAmbiguous).toHaveBeenCalledOnce();
			expect(t.sdk.restartLiveEncoding).toHaveBeenCalledTimes(1);
			expect(t.updates.map((u) => u.status)).not.toContain("RUNNING");
			expect(t.row.status).toBe("STOPPED");
			expect(run.providerTerminalAt).toBeInstanceOf(Date);
			expect(run.status).toBe("STOPPED");
		});

		it("a restart whose readback never reaches RUNNING (QUEUED for every attempt) lands ERROR — never RUNNING on the 2xx alone", async () => {
			const statuses = ["RUNNING"]; // the entry reconcile; then QUEUED forever
			const t = setup(
				{ ...runningRow, status: "PROVISIONING" },
				{
					getEncodingStatus: vi.fn(async () => ({
						status: statuses.shift() ?? "QUEUED",
					})),
				},
			);
			seedRun(t);
			const result = await t.process({
				liveChannelId: CHANNEL_ID,
				action: "restart",
			});
			expect(result).toMatchObject({ status: "EFFECT_AMBIGUOUS" });
			expect(liveEffectMocks.markAmbiguous).toHaveBeenCalledOnce();
			expect(t.row.status).toBe("ERROR");
			expect(t.updates.map((u) => u.status)).not.toContain("RUNNING");
			// Bounded: 12 readback attempts after the entry read.
			expect(t.sdk.getEncodingStatus).toHaveBeenCalledTimes(13);
		});

		it("a channel with no run row has no identity to reconcile onto — refused, restart call 0", async () => {
			const t = setup({ ...runningRow, status: "PROVISIONING" });
			await expect(
				t.process({ liveChannelId: CHANNEL_ID, action: "restart" }),
			).rejects.toThrow(/no run row/);
			expect(t.sdk.restartLiveEncoding).not.toHaveBeenCalled();
		});
	});

	it("routes reset-timeshift params to the SDK on RUNNING channels only", async () => {
		const { process, sdk } = setup(runningRow);
		await process({
			liveChannelId: CHANNEL_ID,
			action: "reset-timeshift",
			params: { residualPeriodInSeconds: 600, manifestIds: ["m-1"] },
		});
		expect(sdk.resetLiveManifestTimeshift).toHaveBeenCalledWith("bm-live-enc", {
			residualPeriodInSeconds: 600,
			manifestIds: ["m-1"],
		});

		const stopped = setup({ ...runningRow, status: "STOPPED" });
		await expect(
			stopped.process({
				liveChannelId: CHANNEL_ID,
				action: "reset-timeshift",
				params: {},
			}),
		).rejects.toThrow(/RUNNING channel/);
	});

	it("inserts SCTE-35 cues and validates params at the worker boundary", async () => {
		const { process, sdk } = setup(runningRow);
		await process({
			liveChannelId: CHANNEL_ID,
			action: "scte35",
			params: { cueDuration: 30 },
		});
		expect(sdk.insertScte35Cue).toHaveBeenCalledWith("bm-live-enc", {
			cueDuration: 30,
		});
		await expect(
			process({ liveChannelId: CHANNEL_ID, action: "scte35", params: {} }),
		).rejects.toThrow(); // cueDuration is required
	});

	it("re-derives the slate duration from slateUntil AT INSERT TIME — queue retries must not stretch the cover into the program (review-223 F6)", async () => {
		const { process, sdk } = setup(runningRow);
		// now is fixed at 2026-06-12T00:00:00Z; the window ends 90.7s later.
		// The sweep computed some other number when it fired — what the SDK
		// gets is floor(remaining AT THE CALL): 90.
		await process({
			liveChannelId: CHANNEL_ID,
			action: "insert-content",
			params: {
				insertableContentId: "99999999-9999-4999-8999-999999999999",
				durationSeconds: 300, // stale sweep-time number — must NOT win
				slateUntil: "2026-06-12T00:01:30.700Z",
				scheduleId: "33333333-3333-4333-8333-333333333333",
			},
		});
		expect(sdk.scheduleInsertableContent).toHaveBeenCalledWith("bm-live-enc", {
			contentId: "99999999-9999-4999-8999-999999999999",
			durationSeconds: 90,
		});
	});

	it("does NOT insert a second slate when the provider already holds this one (lost-response retry)", async () => {
		/**
		 * The insert is a POST, the queue retries it
		 * up to five times, and the history row is written only AFTER it
		 * returns — so a provider that ACCEPTED the insertion and then lost the
		 * response left no local trace at all, and the retry covered the
		 * program with a SECOND slate.
		 *
		 * This is the retry: the provider already lists the insertion as
		 * SCHEDULED. Nothing local says so, and nothing local can.
		 */
		const { process, sdk } = setup(runningRow, {
			listScheduledInsertableContent: vi.fn(async () => [
				{
					id: "ent-1",
					contentId: "99999999-9999-4999-8999-999999999999",
					status: "SCHEDULED",
					// now is fixed at 2026-06-12T00:00:00Z — 30s ago, i.e. inside
					// the retry window, which is what makes this a RETRY.
					createdAt: "2026-06-11T23:59:30.000Z",
				},
			]),
		});
		await process({
			liveChannelId: CHANNEL_ID,
			action: "insert-content",
			params: {
				insertableContentId: "99999999-9999-4999-8999-999999999999",
				durationSeconds: 60,
			},
		});
		expect(sdk.listScheduledInsertableContent).toHaveBeenCalledWith(
			"bm-live-enc",
		);
		expect(sdk.scheduleInsertableContent).not.toHaveBeenCalled();
	});

	it("DOES insert when the provider's only entry for this slate is spent", async () => {
		/**
		 * The arm that makes the pin above mean something. DESCHEDULED and ERROR
		 * are not live states — a previous slate that already ran or failed must
		 * never suppress the next one, or the skip would silently disarm slate insertion
		 * for the rest of the channel's life.
		 */
		const { process, sdk } = setup(runningRow, {
			listScheduledInsertableContent: vi.fn(async () => [
				{
					id: "ent-2",
					contentId: "99999999-9999-4999-8999-999999999999",
					status: "DESCHEDULED",
					createdAt: "2026-06-11T23:59:30.000Z",
				},
				{
					id: "ent-3",
					contentId: "some-other-slate",
					status: "SCHEDULED",
					createdAt: "2026-06-11T23:59:30.000Z",
				},
			]),
		});
		await process({
			liveChannelId: CHANNEL_ID,
			action: "insert-content",
			params: {
				insertableContentId: "99999999-9999-4999-8999-999999999999",
				durationSeconds: 60,
			},
		});
		expect(sdk.scheduleInsertableContent).toHaveBeenCalledWith("bm-live-enc", {
			contentId: "99999999-9999-4999-8999-999999999999",
			durationSeconds: 60,
		});
	});

	it("STILL fires a repeat slate whose earlier airing the provider never retired", async () => {
		/**
		 * The arm that keeps the fix from becoming a worse bug than the one it
		 * fixes.
		 *
		 * Slate content is adopted BY NAME, so one contentId serves every slate insertion
		 * on the channel — the 10:00 airing and the 14:00 airing are the same
		 * content id. If the provider leaves a played entry sitting in
		 * CREATED/SCHEDULED (and whether it does is not knowable from here
		 * without the live API), a contentId+status match alone would skip every
		 * later insert FOREVER: the feature would silently stop covering, which
		 * is far worse than the double-insert being fixed.
		 *
		 * So the match is time-bounded to the retry window. This entry is hours
		 * old — a different airing, not this attempt.
		 */
		const { process, sdk } = setup(runningRow, {
			listScheduledInsertableContent: vi.fn(async () => [
				{
					id: "ent-4",
					contentId: "99999999-9999-4999-8999-999999999999",
					status: "SCHEDULED",
					// now is 2026-06-12T00:00:00Z; this is ~4h earlier.
					createdAt: "2026-06-11T20:00:00.000Z",
				},
			]),
		});
		await process({
			liveChannelId: CHANNEL_ID,
			action: "insert-content",
			params: {
				insertableContentId: "99999999-9999-4999-8999-999999999999",
				durationSeconds: 60,
			},
		});
		expect(sdk.scheduleInsertableContent).toHaveBeenCalledWith("bm-live-enc", {
			contentId: "99999999-9999-4999-8999-999999999999",
			durationSeconds: 60,
		});
	});

	it("FIRES a second armed 蓋被せ inside the retry window — the reviewer's construction", async () => {
		/**
		 * review-299's refutation of the original 15-minute window, as a test.
		 *
		 * `liveScheduleArmSchema` REQUIRES a SLATE_IN row to name existing READY
		 * content, and POST /live-channels/[id]/schedules enforces only
		 * `fireAt > now` — no uniqueness, spacing or overlap check between rows.
		 * So two manually-armed covers naming ONE slate are legal at ANY spacing,
		 * and `slateDurationSeconds` allows 1s.
		 *
		 * TWO MINUTES apart on purpose: INSIDE the retry window. A nine-minute
		 * gap would let the narrowed window pass this test on its own, and the
		 * mutation loop caught exactly that — deleting the discriminator left all
		 * 78 tests green, because the window was doing the work. Inside the
		 * window nothing but the prior-airing record can tell the two apart.
		 *
		 * The provider still lists the first airing as SCHEDULED (the world the
		 * guard exists for), so contentId + window alone would have skipped the
		 * second cover — and the segment that must not air, airs. What tells them
		 * apart is our OWN step log: the first airing left a record, so the
		 * provider entry is explained and this is not a lost response.
		 */
		const running = {
			...runningRow,
			// The first cover's own record — what the second fire reads to tell
			// a legitimate repeat from a lost response.
			stepLog: [
				{
					step: "slate:2026-06-11T23:58:00.000Z",
					kind: "SLATE_INSERTED",
					payload: {
						at: "2026-06-11T23:58:00.000Z", // 2 minutes before now — INSIDE the window
						insertableContentId: "99999999-9999-4999-8999-999999999999",
						durationSeconds: 120,
						// OUR airing created this provider entry — the identity link.
						providerEntryId: "ent-5",
					},
					refs: {},
					status: "DONE",
				} as StepLogEntry,
			],
		};
		const { process, sdk } = setup(running, {
			listScheduledInsertableContent: vi.fn(async () => [
				{
					id: "ent-5",
					contentId: "99999999-9999-4999-8999-999999999999",
					status: "SCHEDULED",
					createdAt: "2026-06-11T23:58:00.000Z",
				},
			]),
		});
		await process({
			liveChannelId: CHANNEL_ID,
			action: "insert-content",
			params: {
				insertableContentId: "99999999-9999-4999-8999-999999999999",
				durationSeconds: 120,
			},
		});
		expect(sdk.scheduleInsertableContent).toHaveBeenCalledWith("bm-live-enc", {
			contentId: "99999999-9999-4999-8999-999999999999",
			durationSeconds: 120,
		});
	});

	it("SKIPS a lost-response retry that FOLLOWS another airing — surplus, not existence", async () => {
		/**
		 * review-299 I1. The first version asked "does ANY prior airing explain
		 * this?" and, when yes, excused EVERY provider entry — so one record
		 * licensed an unbounded number of inserts:
		 *   10:00 cover A fires, record A written.
		 *   10:02 cover B fires — A explains it, insert. The POST lands and the
		 *         response is LOST, so no record B.
		 *   10:02:05 the queue redelivers B. A still explains, so we insert AGAIN
		 *         — #173's double-insert, straight back.
		 *
		 * This is that redelivery: the provider holds TWO live entries, we can
		 * account for ONE. The surplus is our lost response, so we skip.
		 */
		const running = {
			...runningRow,
			stepLog: [
				{
					step: "slate:2026-06-11T23:58:00.000Z",
					kind: "SLATE_INSERTED",
					payload: {
						at: "2026-06-11T23:58:00.000Z", // cover A, 2 min ago
						insertableContentId: "99999999-9999-4999-8999-999999999999",
						durationSeconds: 120,
						// A CLAIMS its entry. Without this the record claims nothing,
						// and under the symmetric null-id rule we could not conclude
						// that ent-7 is not A — so we would insert. The scenario only
						// means what it says when A's identity is expressed.
						providerEntryId: "ent-6",
					},
					refs: {},
					status: "DONE",
				} as StepLogEntry,
			],
		};
		const { process, sdk, row } = setup(running, {
			listScheduledInsertableContent: vi.fn(async () => [
				{
					id: "ent-6",
					contentId: "99999999-9999-4999-8999-999999999999",
					status: "SCHEDULED",
					createdAt: "2026-06-11T23:58:00.000Z", // A
				},
				{
					id: "ent-7",
					contentId: "99999999-9999-4999-8999-999999999999",
					status: "SCHEDULED",
					createdAt: "2026-06-11T23:59:55.000Z", // B's landed POST
				},
			]),
		});
		await process({
			liveChannelId: CHANNEL_ID,
			action: "insert-content",
			params: {
				insertableContentId: "99999999-9999-4999-8999-999999999999",
				durationSeconds: 120,
			},
		});
		expect(sdk.scheduleInsertableContent).not.toHaveBeenCalled();
		/**
		 * WHICH entry was attributed — not merely that we skipped.
		 *
		 * review-300 measured this test passing with its step-log fixture DELETED
		 * outright: the verdict is SKIP either way, because with no records at all
		 * the FIRST entry is unclaimed and satisfies the assertion just as well.
		 * The fixture was decorative and the test had quietly become a duplicate
		 * of "still skips a true retry".
		 *
		 * Attribution is what the fixture actually changes: with A's record
		 * claiming ent-6, the unclaimed entry is B's (ent-7). Delete or mis-key
		 * the fixture and it becomes ent-6, so this line fails.
		 */
		const entries = row.stepLog as StepLogEntry[];
		const record = entries.filter((e) => e.kind === "SLATE_INSERTED").pop();
		expect(record?.payload).toMatchObject({
			skipped: true,
			providerEntryId: "ent-7",
		});
	});

	it("counts only OUR records — a reseeded PENDING one still counts", async () => {
		/**
		 * Why there is no `status === "DONE"` filter on our side, against the
		 * reviewer's suggested shape. The stale-RTMP guard RESETS tail entries to
		 * PENDING, payload intact, so a DONE filter would discard a record that
		 * genuinely is ours and re-enter the false skip. Presence is the
		 * evidence; status is not — and since  the record is written
		 * RUNNING in the first place, so a DONE filter would now discard EVERY
		 * one of them.
		 */
		const running = {
			...runningRow,
			stepLog: [
				{
					step: "slate:2026-06-11T23:58:00.000Z",
					kind: "SLATE_INSERTED",
					payload: {
						at: "2026-06-11T23:58:00.000Z",
						insertableContentId: "99999999-9999-4999-8999-999999999999",
						durationSeconds: 120,
						// OUR airing created this provider entry — the identity link.
						providerEntryId: "ent-8",
					},
					refs: {},
					status: "PENDING", // reseeded by the stale-RTMP guard
				} as StepLogEntry,
			],
		};
		const { process, sdk } = setup(running, {
			listScheduledInsertableContent: vi.fn(async () => [
				{
					id: "ent-8",
					contentId: "99999999-9999-4999-8999-999999999999",
					status: "SCHEDULED",
					createdAt: "2026-06-11T23:58:00.000Z",
				},
			]),
		});
		await process({
			liveChannelId: CHANNEL_ID,
			action: "insert-content",
			params: {
				insertableContentId: "99999999-9999-4999-8999-999999999999",
				durationSeconds: 120,
			},
		});
		expect(sdk.scheduleInsertableContent).toHaveBeenCalled();
	});

	it("a cover SKIPPED earlier does NOT suppress a later legitimate one", async () => {
		/**
		 * review-300 Important 2. My first version excluded skipped records from
		 * the accounting on the reasoning that "a skip aired nothing, so it can
		 * license no insert" — and that produced a false skip: cover #1 is
		 * skipped, its provider entry stays unexplained, and the NEXT legitimate
		 * cover sees a surplus it did not cause and is suppressed. The segment
		 * that must not air, airs.
		 *
		 * A skip still EVIDENCES that an insertion exists at the provider — that
		 * is precisely why it skipped. It just is not evidence about THIS row,
		 * which the scheduleId key settles instead.
		 */
		const running = {
			...runningRow,
			stepLog: [
				{
					step: "slate:2026-06-11T23:58:00.000Z",
					kind: "SLATE_INSERTED",
					payload: {
						at: "2026-06-11T23:58:00.000Z",
						insertableContentId: "99999999-9999-4999-8999-999999999999",
						durationSeconds: 120,
						// OUR airing created this provider entry — the identity link.
						providerEntryId: "ent-9",
						skipped: true,
						scheduleId: "11111111-1111-4111-8111-111111111111",
					},
					refs: {},
					status: "DONE",
				} as StepLogEntry,
			],
		};
		const { process, sdk } = setup(running, {
			listScheduledInsertableContent: vi.fn(async () => [
				{
					id: "ent-9",
					contentId: "99999999-9999-4999-8999-999999999999",
					status: "SCHEDULED",
					createdAt: "2026-06-11T23:58:00.000Z",
				},
			]),
		});
		await process({
			liveChannelId: CHANNEL_ID,
			action: "insert-content",
			params: {
				insertableContentId: "99999999-9999-4999-8999-999999999999",
				durationSeconds: 120,
				scheduleId: "22222222-2222-4222-8222-222222222222",
			},
		});
		expect(sdk.scheduleInsertableContent).toHaveBeenCalled();
	});

	it("SKIPS a stall redelivery of the SAME schedule row — the idempotency key", async () => {
		/**
		 * review-300 Critical 1, and a REGRESSION my own counting fix introduced.
		 *
		 * Attempt 1 of row R POSTs the slate AND writes its record, then the
		 * worker dies before BullMQ acks. The queue stall-redelivers. Counting
		 * cannot see this: attempt 1's own record credits against attempt 1's own
		 * provider entry, the surplus is zero, and we insert a SECOND slate ON
		 * AIR. stall-policy.ts:74-78 warns about exactly this — the insert guards
		 * only on `row.status !== "RUNNING"` and the channel stays RUNNING
		 * throughout — and stall-policy.ts:99 names the fix: an idempotency key,
		 * "the schedule row id is already in hand at enqueue time".
		 *
		 * A row fires ONCE (ARMED→FIRED), so a non-skipped record carrying our
		 * scheduleId can only be our own earlier attempt.
		 */
		const ROW = "33333333-3333-4333-8333-333333333333";
		const running = {
			...runningRow,
			stepLog: [
				{
					step: "slate:2026-06-11T23:59:30.000Z",
					kind: "SLATE_INSERTED",
					payload: {
						at: "2026-06-11T23:59:30.000Z",
						insertableContentId: "99999999-9999-4999-8999-999999999999",
						durationSeconds: 120,
						scheduleId: ROW,
					},
					refs: {},
					status: "DONE",
				} as StepLogEntry,
			],
		};
		const { process, sdk, row } = setup(running, {
			listScheduledInsertableContent: vi.fn(async () => [
				{
					id: "ent-10",
					contentId: "99999999-9999-4999-8999-999999999999",
					status: "SCHEDULED",
					createdAt: "2026-06-11T23:59:30.000Z",
				},
			]),
		});
		await process({
			liveChannelId: CHANNEL_ID,
			action: "insert-content",
			params: {
				insertableContentId: "99999999-9999-4999-8999-999999999999",
				durationSeconds: 120,
				scheduleId: ROW,
			},
		});
		expect(sdk.scheduleInsertableContent).not.toHaveBeenCalled();
		// Settled by the key, so the provider is never asked.
		expect(sdk.listScheduledInsertableContent).not.toHaveBeenCalled();
		/**
		 * WITNESS (review-300 F4): the two assertions above are both negative, so
		 * they are equally satisfied by the action never running — an early
		 * `return` passed this test. The record proves the path executed, and
		 * `skipped: true` proves it reached the decision rather than the insert.
		 */
		const written = (row.stepLog as StepLogEntry[])
			.filter((e) => e.kind === "SLATE_INSERTED")
			.pop();
		expect(written?.payload).toMatchObject({ skipped: true, scheduleId: ROW });
	});

	it("a redelivery of a row whose earlier attempt was SKIPPED still fires", async () => {
		/**
		 * The `skipped !== true` clause inside the idempotency key, pinned — my
		 * own mutation loop found it unpinned, and it survives as a false skip.
		 *
		 * Row R's first attempt skipped, so it aired NOTHING. If the key treated
		 * that record as "we already fired", the redelivery would skip too and R
		 * would never cover at all. Here the provider is holding nothing any more
		 * (the entry that caused the skip has been retired or descheduled), so
		 * there is no longer anything covering the program and this delivery must
		 * insert.
		 */
		const ROW = "44444444-4444-4444-8444-444444444444";
		const running = {
			...runningRow,
			stepLog: [
				{
					step: "slate:2026-06-11T23:59:30.000Z",
					kind: "SLATE_INSERTED",
					payload: {
						at: "2026-06-11T23:59:30.000Z",
						insertableContentId: "99999999-9999-4999-8999-999999999999",
						durationSeconds: 120,
						scheduleId: ROW,
						skipped: true,
					},
					refs: {},
					status: "DONE",
				} as StepLogEntry,
			],
		};
		const { process, sdk } = setup(running, {
			// Nothing live at the provider now.
			listScheduledInsertableContent: vi.fn(async () => []),
		});
		await process({
			liveChannelId: CHANNEL_ID,
			action: "insert-content",
			params: {
				insertableContentId: "99999999-9999-4999-8999-999999999999",
				durationSeconds: 120,
				scheduleId: ROW,
			},
		});
		expect(sdk.scheduleInsertableContent).toHaveBeenCalled();
	});

	it("WRITES scheduleId into the record — the key it will be read by next time", async () => {
		/**
		 * review-300 F7, and it became load-bearing under my own fix: the
		 * idempotency key READS `payload.scheduleId`, so a record written without
		 * it can never be recognised as our own earlier attempt and a stall
		 * redelivery double-fires. The sweep-side producer was pinned; this one,
		 * which writes the field the key depends on, was not. Dropping the spread
		 * left all 85 tests green.
		 */
		const ROW = "55555555-5555-4555-8555-555555555555";
		const { process, row } = setup(runningRow);
		await process({
			liveChannelId: CHANNEL_ID,
			action: "insert-content",
			params: {
				insertableContentId: "99999999-9999-4999-8999-999999999999",
				durationSeconds: 60,
				scheduleId: ROW,
			},
		});
		const entries = row.stepLog as StepLogEntry[];
		const record = entries.filter((e) => e.kind === "SLATE_INSERTED").pop();
		expect(record?.payload).toMatchObject({
			insertableContentId: "99999999-9999-4999-8999-999999999999",
			scheduleId: ROW,
		});
	});

	it("RECORDS the provider entry id the POST returned — the producer of the link", async () => {
		/**
		 * The wiring, pinned. My own mutation loop found it unpinned: dropping the
		 * assignment left all 88 tests green, and without it NO later cover can
		 * attribute our own airing, so every one of them reads the entry as a
		 * stranger and skips. Third time this branch that I tested a rule and not
		 * the wiring that feeds it.
		 */
		const { process, row } = setup(runningRow, {
			scheduleInsertableContent: vi.fn(async () => "ent-created-by-post"),
		});
		await process({
			liveChannelId: CHANNEL_ID,
			action: "insert-content",
			params: {
				insertableContentId: "99999999-9999-4999-8999-999999999999",
				durationSeconds: 60,
			},
		});
		const entries = row.stepLog as StepLogEntry[];
		const record = entries.filter((e) => e.kind === "SLATE_INSERTED").pop();
		expect(record?.payload).toMatchObject({
			providerEntryId: "ent-created-by-post",
		});
	});

	it("PROBE J: a key-skip does not disable the guard for the next row", async () => {
		/**
		 * review-300 probe J — the guard's own SUCCESS path was manufacturing the
		 * degradation that `haveUnclaimedRecord` exists to detect.
		 *
		 * A key-skip short-circuits before the provider lookup, so it has neither
		 * a created nor an attributed id: its record is unclaimable by
		 * construction. Counting it meant EVERY redelivery skip turned the guard
		 * off for the whole window — and did so during exactly the queue
		 * turbulence in which a lost response is most likely.
		 *
		 * Here: row S fired and claimed ent-1; row S was redelivered and
		 * key-skipped, leaving an unclaimable record; row T now fires with its own
		 * POST already landed and its response lost. ent-2 is a genuine surplus
		 * and must be skipped.
		 */
		const running = {
			...runningRow,
			stepLog: [
				{
					step: "slate:2026-06-11T23:58:00.000Z",
					kind: "SLATE_INSERTED",
					payload: {
						at: "2026-06-11T23:58:00.000Z",
						insertableContentId: "99999999-9999-4999-8999-999999999999",
						durationSeconds: 120,
						scheduleId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
						providerEntryId: "ent-1",
					},
					refs: {},
					status: "DONE",
				} as StepLogEntry,
				{
					// The key-skip: no providerEntryId, by construction.
					step: "slate:2026-06-11T23:58:30.000Z",
					kind: "SLATE_INSERTED",
					payload: {
						at: "2026-06-11T23:58:30.000Z",
						insertableContentId: "99999999-9999-4999-8999-999999999999",
						durationSeconds: 120,
						scheduleId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
						skipped: true,
					},
					refs: {},
					status: "DONE",
				} as StepLogEntry,
			],
		};
		const { process, sdk } = setup(running, {
			listScheduledInsertableContent: vi.fn(async () => [
				{
					id: "ent-1",
					contentId: "99999999-9999-4999-8999-999999999999",
					status: "SCHEDULED",
					createdAt: "2026-06-11T23:58:00.000Z",
				},
				{
					id: "ent-2", // row T's landed POST, response lost
					contentId: "99999999-9999-4999-8999-999999999999",
					status: "SCHEDULED",
					createdAt: "2026-06-11T23:59:55.000Z",
				},
			]),
		});
		await process({
			liveChannelId: CHANNEL_ID,
			action: "insert-content",
			params: {
				insertableContentId: "99999999-9999-4999-8999-999999999999",
				durationSeconds: 120,
				scheduleId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", // row T
			},
		});
		expect(sdk.scheduleInsertableContent).not.toHaveBeenCalled();
	});

	it("PROBE K: an unparseable `at` fails the same way a missing one does", async () => {
		// Two rules pointing opposite ways, one level below where they were just
		// unified: `Math.abs(NaN) <= W` is false, so a garbage timestamp
		// SUPPRESSED while a missing one covered.
		const running = {
			...runningRow,
			stepLog: [
				{
					step: "slate:garbage",
					kind: "SLATE_INSERTED",
					payload: {
						at: "not-a-date",
						insertableContentId: "99999999-9999-4999-8999-999999999999",
						durationSeconds: 120,
					},
					refs: {},
					status: "DONE",
				} as StepLogEntry,
			],
		};
		const { process, sdk } = setup(running, {
			listScheduledInsertableContent: vi.fn(async () => [
				{
					id: "ent-stranger",
					contentId: "99999999-9999-4999-8999-999999999999",
					status: "SCHEDULED",
					createdAt: "2026-06-11T23:59:30.000Z",
				},
			]),
		});
		await process({
			liveChannelId: CHANNEL_ID,
			action: "insert-content",
			params: {
				insertableContentId: "99999999-9999-4999-8999-999999999999",
				durationSeconds: 120,
			},
		});
		expect(sdk.scheduleInsertableContent).toHaveBeenCalled();
	});

	it("N2: a FAILED record write does not fail the insert — the slate already aired", async () => {
		/**
		 * review-300 N2: a `throw` inside the record-write catch left the whole
		 * suite green, so the catch — which now guards the DISCRIMINATOR itself —
		 * was entered by no test at all. The least-covered load-bearing path in
		 * the change.
		 *
		 * The contract it holds: the slate HAS fired, so failing the job would
		 * re-run an insert that already landed. The write is best-effort and
		 * loud, never fatal.
		 */
		const { process, deps, sdk } = setup(runningRow);
		(
			deps.prisma as unknown as { $executeRaw: ReturnType<typeof vi.fn> }
		).$executeRaw.mockRejectedValueOnce(new Error("db down"));
		await expect(
			process({
				liveChannelId: CHANNEL_ID,
				action: "insert-content",
				params: {
					insertableContentId: "99999999-9999-4999-8999-999999999999",
					durationSeconds: 60,
				},
			}),
		).resolves.toBeDefined();
		// The insert itself still happened — the record loss must not undo it.
		expect(sdk.scheduleInsertableContent).toHaveBeenCalled();
	});

	it("PROBE I: a recent record of OURS claiming no entry must not suppress either", async () => {
		/**
		 * review-300 probe I, and the asymmetry behind it. The null-id rule was
		 * applied to THEIR entries and not to OURS, which made it two opposite
		 * rules: a null id on the provider side disabled the guard (double insert,
		 * the stated trade), while a null id on our side made every later cover
		 * SUPPRESSED — content airs, the one direction this work rejects.
		 *
		 * Here we hold a recent record that names no entry — which is what the
		 * fake SDK produces BY DEFAULT (`scheduleInsertableContent` resolves
		 * null), so this shape is the common one, not the exotic one. We cannot
		 * prove the stranger entry is not that airing, so we cover.
		 */
		const running = {
			...runningRow,
			stepLog: [
				{
					step: "slate:2026-06-11T23:58:00.000Z",
					kind: "SLATE_INSERTED",
					payload: {
						at: "2026-06-11T23:58:00.000Z",
						insertableContentId: "99999999-9999-4999-8999-999999999999",
						durationSeconds: 120,
						// no providerEntryId — claims nothing
					},
					refs: {},
					status: "DONE",
				} as StepLogEntry,
			],
		};
		const { process, sdk } = setup(running, {
			listScheduledInsertableContent: vi.fn(async () => [
				{
					id: "ent-stranger",
					contentId: "99999999-9999-4999-8999-999999999999",
					status: "SCHEDULED",
					createdAt: "2026-06-11T23:59:30.000Z",
				},
			]),
		});
		await process({
			liveChannelId: CHANNEL_ID,
			action: "insert-content",
			params: {
				insertableContentId: "99999999-9999-4999-8999-999999999999",
				durationSeconds: 120,
			},
		});
		expect(sdk.scheduleInsertableContent).toHaveBeenCalled();
	});

	it("a FUTURE-dated record of ours still counts as unclaimed — the sign flips per side", async () => {
		/**
		 * The signs differ between the two sides on purpose: each drops whichever
		 * way fails toward covering. A future-dated PROVIDER entry is dropped
		 * (fewer suppressors); a future-dated record of OURS is KEPT (more reasons
		 * not to suppress). That is also what keeps probe G shut — the direct
		 * route stamps `at` with the WEB process's clock, so a record running
		 * ahead of the worker's must not be discarded into a false skip.
		 */
		const running = {
			...runningRow,
			stepLog: [
				{
					step: "slate:2026-06-12T00:00:30.000Z",
					kind: "SLATE_INSERTED",
					payload: {
						at: "2026-06-12T00:00:30.000Z", // 30s AHEAD of the worker
						insertableContentId: "99999999-9999-4999-8999-999999999999",
						durationSeconds: 120,
					},
					refs: {},
					status: "DONE",
				} as StepLogEntry,
			],
		};
		const { process, sdk } = setup(running, {
			listScheduledInsertableContent: vi.fn(async () => [
				{
					id: "ent-stranger",
					contentId: "99999999-9999-4999-8999-999999999999",
					status: "SCHEDULED",
					createdAt: "2026-06-11T23:59:30.000Z",
				},
			]),
		});
		await process({
			liveChannelId: CHANNEL_ID,
			action: "insert-content",
			params: {
				insertableContentId: "99999999-9999-4999-8999-999999999999",
				durationSeconds: 120,
			},
		});
		expect(sdk.scheduleInsertableContent).toHaveBeenCalled();
	});

	it("a POST that returns NO id writes a record claiming nothing", async () => {
		/**
		 * The PRODUCTION side of the degraded case, which nothing pinned.
		 *
		 * review-300 caught the fake-sdk comment claiming "tests that want the
		 * degraded case now say so explicitly" when no test did — the only
		 * override in the file returns a healthy id. The consumption side WAS
		 * covered (a seeded record with no `providerEntryId` must not suppress),
		 * but that is a different assertion from "when the provider gives us no
		 * id, this is what we write". Only one of the two had an arm, and the
		 * comment asserted both.
		 *
		 * This is the arm that makes the sentence true, and it is deliberately
		 * the DEGRADED response — which is exactly why it must be explicit now
		 * that the fake's default is the healthy one.
		 */
		const { process, row, sdk } = setup(runningRow, {
			scheduleInsertableContent: vi.fn(async () => null),
		});
		await process({
			liveChannelId: CHANNEL_ID,
			action: "insert-content",
			params: {
				insertableContentId: "99999999-9999-4999-8999-999999999999",
				durationSeconds: 60,
			},
		});
		expect(sdk.scheduleInsertableContent).toHaveBeenCalled();
		const entries = row.stepLog as StepLogEntry[];
		const record = entries.filter((e) => e.kind === "SLATE_INSERTED").pop();
		// Absent, not null: `typeof … === "string"` is what reads it, so an
		// explicit null would behave the same — but the record should not carry a
		// key whose value claims nothing.
		expect(record?.payload).not.toHaveProperty("providerEntryId");
	});

	it("an entry with NO id does not suppress — unknown identity fails toward covering", async () => {
		/**
		 * `entry.id !== null` is a direction choice and it was unpinned. A
		 * provider that stops returning ids should DISABLE this guard, not
		 * suppress every slate on the channel: an unidentifiable entry can never
		 * be claimed, so treating it as unaccounted would skip forever.
		 */
		const { process, sdk } = setup(runningRow, {
			listScheduledInsertableContent: vi.fn(async () => [
				{
					id: null,
					contentId: "99999999-9999-4999-8999-999999999999",
					status: "SCHEDULED",
					createdAt: "2026-06-11T23:59:30.000Z",
				},
			]),
		});
		await process({
			liveChannelId: CHANNEL_ID,
			action: "insert-content",
			params: {
				insertableContentId: "99999999-9999-4999-8999-999999999999",
				durationSeconds: 60,
			},
		});
		expect(sdk.scheduleInsertableContent).toHaveBeenCalled();
	});

	it("N1/PROBE-D: a RETIRED prior airing no longer masks a lost response", async () => {
		/**
		 * The case counting could not get right in either direction (review-300
		 * N1, probes D and E). Cover A aired 2 min ago and the provider has since
		 * RETIRED its entry, so it is gone from the live list. Cover B's POST then
		 * landed with its response lost. Under the count, ours(1) cancelled
		 * entries(1) and we inserted a SECOND slate; under identity, A's record
		 * names an id that is no longer live and cannot cancel anything, while B's
		 * entry is unclaimed — so we skip, correctly.
		 */
		const running = {
			...runningRow,
			stepLog: [
				{
					step: "slate:2026-06-11T23:58:00.000Z",
					kind: "SLATE_INSERTED",
					payload: {
						at: "2026-06-11T23:58:00.000Z",
						insertableContentId: "99999999-9999-4999-8999-999999999999",
						durationSeconds: 120,
						providerEntryId: "ent-retired-A",
					},
					refs: {},
					status: "DONE",
				} as StepLogEntry,
			],
		};
		const { process, sdk } = setup(running, {
			listScheduledInsertableContent: vi.fn(async () => [
				// A is gone (retired). Only B's lost-response entry is live.
				{
					id: "ent-lost-B",
					contentId: "99999999-9999-4999-8999-999999999999",
					status: "SCHEDULED",
					createdAt: "2026-06-11T23:59:55.000Z",
				},
			]),
		});
		await process({
			liveChannelId: CHANNEL_ID,
			action: "insert-content",
			params: {
				insertableContentId: "99999999-9999-4999-8999-999999999999",
				durationSeconds: 120,
			},
		});
		expect(sdk.scheduleInsertableContent).not.toHaveBeenCalled();
		expect(sdk.listScheduledInsertableContent).toHaveBeenCalledWith(
			"bm-live-enc",
		);
	});

	it("records WHICH entry a skip attributed, so it is not attributed twice", async () => {
		// Without this, one unclaimed entry suppresses every later cover of the
		// slate until it ages out — Important 2 arriving through identity.
		const { process, row } = setup(runningRow, {
			listScheduledInsertableContent: vi.fn(async () => [
				{
					id: "ent-stranger",
					contentId: "99999999-9999-4999-8999-999999999999",
					status: "SCHEDULED",
					createdAt: "2026-06-11T23:59:30.000Z",
				},
			]),
		});
		await process({
			liveChannelId: CHANNEL_ID,
			action: "insert-content",
			params: {
				insertableContentId: "99999999-9999-4999-8999-999999999999",
				durationSeconds: 60,
			},
		});
		const entries = row.stepLog as StepLogEntry[];
		const record = entries.filter((e) => e.kind === "SLATE_INSERTED").pop();
		expect(record?.payload).toMatchObject({
			skipped: true,
			providerEntryId: "ent-stranger",
		});
	});

	it("INSERTS when our own step log cannot be parsed — unreadable is not accounted-for", async () => {
		/**
		 * review-300 F5, a direction inversion I shipped. The parse catch returned
		 * `[]` and called that "costs us the memory, not the cover" — backwards.
		 * `[]` means nothing is accounted for, so any live provider entry reads as
		 * a surplus and the cover is SUPPRESSED: on a corrupt step log the guard
		 * silently reverted to exactly the behaviour this work exists to refute,
		 * while the same function states the opposite invariant four times.
		 *
		 * Unreadable must be distinct from "no records": we cannot account for
		 * anything, so a surplus proves nothing, so we cover the program.
		 */
		const { process, sdk } = setup(
			{ ...runningRow, stepLog: "corrupt-not-an-array" as never },
			{
				listScheduledInsertableContent: vi.fn(async () => [
					{
						id: "ent-corrupt",
						contentId: "99999999-9999-4999-8999-999999999999",
						status: "SCHEDULED",
						createdAt: "2026-06-11T23:59:30.000Z",
					},
				]),
			},
		);
		await process({
			liveChannelId: CHANNEL_ID,
			action: "insert-content",
			params: {
				insertableContentId: "99999999-9999-4999-8999-999999999999",
				durationSeconds: 60,
			},
		});
		expect(sdk.scheduleInsertableContent).toHaveBeenCalled();
	});

	it("a DIFFERENT row still fires, even inside the window", async () => {
		// The arm that stops the key from becoming a blanket suppressor: row B is
		// a separate armed cover, not a redelivery of row A.
		const running = {
			...runningRow,
			stepLog: [
				{
					step: "slate:2026-06-11T23:58:00.000Z",
					kind: "SLATE_INSERTED",
					payload: {
						at: "2026-06-11T23:58:00.000Z",
						insertableContentId: "99999999-9999-4999-8999-999999999999",
						durationSeconds: 120,
						// OUR airing created this provider entry — the identity link.
						providerEntryId: "ent-11",
						scheduleId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
					},
					refs: {},
					status: "DONE",
				} as StepLogEntry,
			],
		};
		const { process, sdk } = setup(running, {
			listScheduledInsertableContent: vi.fn(async () => [
				{
					id: "ent-11",
					contentId: "99999999-9999-4999-8999-999999999999",
					status: "SCHEDULED",
					createdAt: "2026-06-11T23:58:00.000Z",
				},
			]),
		});
		await process({
			liveChannelId: CHANNEL_ID,
			action: "insert-content",
			params: {
				insertableContentId: "99999999-9999-4999-8999-999999999999",
				durationSeconds: 120,
				scheduleId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
			},
		});
		expect(sdk.scheduleInsertableContent).toHaveBeenCalled();
	});

	it("still skips a true retry — no prior airing of ours explains the entry", async () => {
		/**
		 * The arm that keeps the pin above from simply disabling the guard. Same
		 * provider state, but NO local record: the insert's record is written
		 * after the SDK call, so a lost response leaves none. That is the lost
		 * response, and it must still be caught.
		 */
		const { process, sdk } = setup(runningRow, {
			listScheduledInsertableContent: vi.fn(async () => [
				{
					id: "ent-12",
					contentId: "99999999-9999-4999-8999-999999999999",
					status: "SCHEDULED",
					createdAt: "2026-06-11T23:59:30.000Z",
				},
			]),
		});
		await process({
			liveChannelId: CHANNEL_ID,
			action: "insert-content",
			params: {
				insertableContentId: "99999999-9999-4999-8999-999999999999",
				durationSeconds: 60,
			},
		});
		expect(sdk.scheduleInsertableContent).not.toHaveBeenCalled();
		// WITNESS (review-300 F4): a lone `not.toHaveBeenCalled` cannot tell
		// "correctly skipped" from "the code never ran" — inserting an early
		// `return` at the top of the action passed this test. Assert the guard
		// actually reached the provider.
		expect(sdk.listScheduledInsertableContent).toHaveBeenCalledWith(
			"bm-live-enc",
		);
	});

	it("marks a skip as skipped — it must not read as an airing", async () => {
		// A wrongly-skipped slate insertion was indistinguishable from a successful one on
		// the operator's timeline; only a console.warn said otherwise.
		const { process, row } = setup(runningRow, {
			listScheduledInsertableContent: vi.fn(async () => [
				{
					id: "ent-13",
					contentId: "99999999-9999-4999-8999-999999999999",
					status: "SCHEDULED",
					createdAt: "2026-06-11T23:59:30.000Z",
				},
			]),
		});
		await process({
			liveChannelId: CHANNEL_ID,
			action: "insert-content",
			params: {
				insertableContentId: "99999999-9999-4999-8999-999999999999",
				durationSeconds: 60,
			},
		});
		const entries = row.stepLog as StepLogEntry[];
		const record = entries.filter((e) => e.kind === "SLATE_INSERTED").pop();
		expect(record?.payload).toMatchObject({ skipped: true });
	});

	it("does NOT match a FUTURE-dated entry — clock skew must not suppress a slate", async () => {
		/**
		 * `age >= 0` is the safety clause, and it was pinned by nothing
		 * (review-299 F6: dropping it left all 74 tests green).
		 *
		 * Bitmovin's clock and ours are not the same clock. A scheduled entry
		 * stamped a few seconds in OUR future is ordinary drift — and without
		 * this clause it matches, the insert is suppressed, and the program airs
		 * uncovered. That is the "silently disarms slate insertion" outcome the time bound
		 * exists to prevent, reachable by nothing more exotic than NTP.
		 */
		const { process, sdk } = setup(runningRow, {
			listScheduledInsertableContent: vi.fn(async () => [
				{
					id: "ent-14",
					contentId: "99999999-9999-4999-8999-999999999999",
					status: "SCHEDULED",
					// now is 2026-06-12T00:00:00Z; this is 30s AHEAD of us.
					createdAt: "2026-06-12T00:00:30.000Z",
				},
			]),
		});
		await process({
			liveChannelId: CHANNEL_ID,
			action: "insert-content",
			params: {
				insertableContentId: "99999999-9999-4999-8999-999999999999",
				durationSeconds: 60,
			},
		});
		expect(sdk.scheduleInsertableContent).toHaveBeenCalled();
	});

	it("treats a scheduled entry with no createdAt as NOT this attempt", async () => {
		// Fallback direction, again: unknown age ⇒ insert.
		const { process, sdk } = setup(runningRow, {
			listScheduledInsertableContent: vi.fn(async () => [
				{
					id: "ent-15",
					contentId: "99999999-9999-4999-8999-999999999999",
					status: "SCHEDULED",
					createdAt: null,
				},
			]),
		});
		await process({
			liveChannelId: CHANNEL_ID,
			action: "insert-content",
			params: {
				insertableContentId: "99999999-9999-4999-8999-999999999999",
				durationSeconds: 60,
			},
		});
		expect(sdk.scheduleInsertableContent).toHaveBeenCalled();
	});

	it("inserts anyway when the provider lookup itself fails — a missed 蓋被せ is worse than a doubled one", async () => {
		/**
		 * The direction of the fallback, pinned. This is why the guard is a
		 * provider LOOKUP and not a local claim written before the POST: a claim
		 * would make a crash between claim and call read as "already done" and
		 * drop the cover. The feature exists to keep something off air, so the
		 * only safe way to fail is toward covering.
		 */
		const { process, sdk } = setup(runningRow, {
			listScheduledInsertableContent: vi.fn(async () => {
				throw new Error("503 from the schedule listing");
			}),
		});
		await process({
			liveChannelId: CHANNEL_ID,
			action: "insert-content",
			params: {
				insertableContentId: "99999999-9999-4999-8999-999999999999",
				durationSeconds: 60,
			},
		});
		expect(sdk.scheduleInsertableContent).toHaveBeenCalledWith("bm-live-enc", {
			contentId: "99999999-9999-4999-8999-999999999999",
			durationSeconds: 60,
		});
	});

	it("SKIPS the insert when the window closed while the job waited, and says so on the row", async () => {
		const { process, sdk, liveSchedule } = setup(runningRow);
		await process({
			liveChannelId: CHANNEL_ID,
			action: "insert-content",
			params: {
				insertableContentId: "99999999-9999-4999-8999-999999999999",
				durationSeconds: 300,
				slateUntil: "2026-06-11T23:59:59.000Z", // 1s BEFORE now
				scheduleId: "33333333-3333-4333-8333-333333333333",
			},
		});
		// Never a 1-second-late slate ON TOP of the program: no SDK call, and
		// the row flips FIRED→MISSED (review-223b: a slate that never aired
		// must not read as success on the timeline) with the reason attached.
		expect(sdk.scheduleInsertableContent).not.toHaveBeenCalled();
		expect(liveSchedule.updateMany).toHaveBeenCalledWith({
			where: { id: "33333333-3333-4333-8333-333333333333", status: "FIRED" },
			data: {
				status: "MISSED",
				note: expect.stringContaining("slate window closed before the insert"),
			},
		});
	});

	it("feeder-start creates a session with the DERIVED rtmp target and hands it to the feeder queue (ledger #96)", async () => {
		const rtmpPlan = structuredClone(basePlan) as unknown as {
			liveInput: unknown;
		};
		rtmpPlan.liveInput = { key: "main", kind: "RTMP" };
		const t = setup({
			status: "RUNNING",
			bitmovinAccountId: ACCOUNT_ID,
			bitmovinEncodingId: "bm-live-enc",
			plan: rtmpPlan,
			streamKey: "sched-key",
			encoderIp: "203.0.113.9",
		});
		const result = await t.process({
			liveChannelId: CHANNEL_ID,
			action: "feeder-start",
			params: {
				scheduleId: "33333333-3333-4333-8333-333333333333",
				source: {
					credentialId: "00000000-0000-4000-8000-0000000000c1",
					bucket: "in",
					key: "slate.mp4",
				},
			},
		});
		expect(result).toMatchObject({ status: "fs-sched-1" });
		expect(t.feederSession.create).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					liveChannelId: CHANNEL_ID,
					protocol: "RTMP",
					sourceKey: "slate.mp4",
					target: { url: "rtmp://203.0.113.9/live", streamKey: "sched-key" },
				}),
			}),
		);
		expect(t.enqueueFeederJob).toHaveBeenCalledWith({
			feederSessionId: "fs-sched-1",
			action: "start",
		});
	});

	/**
	 *  (audit 2026-08-29 HIGH-4): the version the create route sealed
	 * at ARM has to reach the SESSION, or the download has nothing to demand.
	 * This is the one hop where the seal could be dropped silently — the sweep
	 * parses it off the row, and this is what writes it down.
	 */
	it("feeder-start stamps the ARM-TIME seal onto the session it creates", async () => {
		const rtmpPlan = structuredClone(basePlan) as unknown as {
			liveInput: unknown;
		};
		rtmpPlan.liveInput = { key: "main", kind: "RTMP" };
		const t = setup({
			status: "RUNNING",
			bitmovinAccountId: ACCOUNT_ID,
			bitmovinEncodingId: "bm-live-enc",
			plan: rtmpPlan,
			streamKey: "sched-key",
			encoderIp: "203.0.113.9",
		});
		await t.process({
			liveChannelId: CHANNEL_ID,
			action: "feeder-start",
			params: {
				scheduleId: "33333333-3333-4333-8333-333333333333",
				source: {
					credentialId: "00000000-0000-4000-8000-0000000000c1",
					bucket: "in",
					key: "slate.mp4",
					identity: { etag: '"abc123"', versionId: "v-1", size: 4096 },
				},
			},
		});
		expect(t.feederSession.create).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					sourceEtag: '"abc123"',
					sourceVersionId: "v-1",
					sourceGeneration: null,
					sourceSize: 4096n,
				}),
			}),
		);
	});

	it("a row armed with NO seal creates an UNSEALED session — the pre-seal behaviour, unchanged", async () => {
		const rtmpPlan = structuredClone(basePlan) as unknown as {
			liveInput: unknown;
		};
		rtmpPlan.liveInput = { key: "main", kind: "RTMP" };
		const t = setup({
			status: "RUNNING",
			bitmovinAccountId: ACCOUNT_ID,
			bitmovinEncodingId: "bm-live-enc",
			plan: rtmpPlan,
			streamKey: "sched-key",
			encoderIp: "203.0.113.9",
		});
		await t.process({
			liveChannelId: CHANNEL_ID,
			action: "feeder-start",
			params: {
				scheduleId: "33333333-3333-4333-8333-333333333333",
				source: {
					credentialId: "00000000-0000-4000-8000-0000000000c1",
					bucket: "in",
					key: "slate.mp4",
				},
			},
		});
		const data = t.feederSession.create.mock.calls[0]?.[0]?.data as Record<
			string,
			unknown
		>;
		expect(data).not.toHaveProperty("sourceSize");
	});

	it("feeder-start derives the target from the CURRENT RUN when it disagrees with the channel (ledger #108 PR2b)", async () => {
		const rtmpPlan = structuredClone(basePlan) as unknown as {
			liveInput: unknown;
		};
		rtmpPlan.liveInput = { key: "main", kind: "RTMP" };
		const t = setup({
			status: "RUNNING",
			bitmovinAccountId: ACCOUNT_ID,
			bitmovinEncodingId: "bm-live-enc",
			plan: rtmpPlan,
			// The STALE channel columns — the pre-restart encoder.
			streamKey: "old-key",
			encoderIp: "203.0.113.9",
		});
		// The restart's run row carries the NEW encoder's coordinates. Writer-
		// coupled (design R5): the run and the channel DISAGREE, and the run
		// must win — feeding the old IP after a restart is dead air.
		t.liveChannelRun.findFirst.mockResolvedValue({
			id: "run-9",
			seq: 9,
			status: "RUNNING",
			bitmovinEncodingId: "bm-live-enc",
			providerStatus: "RUNNING",
			providerStatusObservedAt: new Date("2099-01-01T00:00:00.000Z"),
			streamKey: "new-key",
			encoderIp: "198.51.100.7",
		} as never);
		await t.process({
			liveChannelId: CHANNEL_ID,
			action: "feeder-start",
			params: {
				scheduleId: "33333333-3333-4333-8333-333333333333",
				source: {
					credentialId: "00000000-0000-4000-8000-0000000000c1",
					bucket: "in",
					key: "slate.mp4",
				},
			},
		});
		expect(t.feederSession.create).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					liveChannelRunId: "run-9",
					target: {
						url: "rtmp://198.51.100.7/live",
						streamKey: "new-key",
					},
				}),
			}),
		);
	});

	it("feeder-start with the encoder IP not yet known THROWS — BullMQ retries land it moments later", async () => {
		const rtmpPlan = structuredClone(basePlan) as unknown as {
			liveInput: unknown;
		};
		rtmpPlan.liveInput = { key: "main", kind: "RTMP" };
		const t = setup({
			status: "RUNNING",
			bitmovinAccountId: ACCOUNT_ID,
			bitmovinEncodingId: "bm-live-enc",
			plan: rtmpPlan,
			streamKey: "sched-key",
			encoderIp: null,
		});
		await expect(
			t.process({
				liveChannelId: CHANNEL_ID,
				action: "feeder-start",
				params: {
					scheduleId: "33333333-3333-4333-8333-333333333333",
					source: {
						credentialId: "00000000-0000-4000-8000-0000000000c1",
						bucket: "in",
						key: "slate.mp4",
					},
				},
			}),
		).rejects.toThrow(/encoder IP/);
		expect(t.feederSession.create).not.toHaveBeenCalled();
	});

	it("feeder-start on a non-RTMP-family channel is REFUSED with the reason on the schedule row", async () => {
		// basePlan is live-rtmp-simple — load the ZIXI fixture for the
		// unsupported case (the first cut ASSUMED basePlan was zixi and the
		// test silently exercised the happy path instead).
		const zixiPlan = liveChannelPlanSchema.parse(
			JSON.parse(
				readFileSync(
					join(
						__dirname,
						"../../../../packages/core/src/live/__fixtures__/live-zixi.plan.json",
					),
					"utf8",
				),
			),
		) as unknown as Record<string, unknown>;
		(zixiPlan as { bitmovin: { accountId: string } }).bitmovin.accountId =
			ACCOUNT_ID;
		const t = setup({
			status: "RUNNING",
			bitmovinAccountId: ACCOUNT_ID,
			bitmovinEncodingId: "bm-live-enc",
			plan: zixiPlan,
			encoderIp: "203.0.113.9",
		});
		const result = await t.process({
			liveChannelId: CHANNEL_ID,
			action: "feeder-start",
			params: {
				scheduleId: "33333333-3333-4333-8333-333333333333",
				source: {
					credentialId: "00000000-0000-4000-8000-0000000000c1",
					bucket: "in",
					key: "slate.mp4",
				},
			},
		});
		expect(result).toMatchObject({ status: "REFUSED" });
		expect(t.feederSession.create).not.toHaveBeenCalled();
	});

	it("a SUPERSEDED feeder-start does nothing — a late slate retry must not open a second push against the switched ingest (review-226 I4)", async () => {
		const rtmpPlan = structuredClone(basePlan) as unknown as {
			liveInput: unknown;
		};
		rtmpPlan.liveInput = { key: "main", kind: "RTMP" };
		const t = setup({
			status: "RUNNING",
			bitmovinAccountId: ACCOUNT_ID,
			bitmovinEncodingId: "bm-live-enc",
			plan: rtmpPlan,
			streamKey: "sched-key",
			encoderIp: "203.0.113.9",
		});
		// A LATER feeder row (the switch) already FIRED.
		t.liveSchedule.findFirst.mockResolvedValueOnce({ id: "row-switch" });
		const result = await t.process({
			liveChannelId: CHANNEL_ID,
			action: "feeder-start",
			params: {
				scheduleId: "33333333-3333-4333-8333-333333333333",
				source: {
					credentialId: "00000000-0000-4000-8000-0000000000c1",
					bucket: "in",
					key: "slate.mp4",
				},
			},
		});
		expect(result).toMatchObject({ status: "SUPERSEDED" });
		expect(t.feederSession.create).not.toHaveBeenCalled();
		expect(t.enqueueFeederJob).not.toHaveBeenCalled();
		expect(t.liveSchedule.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					note: expect.stringContaining("superseded by feeder row"),
				}),
			}),
		);
	});

	/**
	 *  — the switch is two-phase. The arm this replaces pinned the
	 * defect: `feeder-switch` enqueued a STOP for the slate loop and then
	 * created the program feed, which downloaded its whole source after air
	 * time while nothing waited for the stop to complete.
	 */
	function rtmpRunning() {
		const rtmpPlan = structuredClone(basePlan) as unknown as {
			liveInput: unknown;
		};
		rtmpPlan.liveInput = { key: "main", kind: "RTMP" };
		return setup({
			status: "RUNNING",
			bitmovinAccountId: ACCOUNT_ID,
			bitmovinEncodingId: "bm-live-enc",
			plan: rtmpPlan,
			streamKey: "sched-key",
			encoderIp: "203.0.113.9",
		});
	}
	const SCHED_ID = "44444444-4444-4444-8444-444444444444";
	const PROGRAM_SOURCE = {
		credentialId: "00000000-0000-4000-8000-0000000000c1",
		bucket: "in",
		key: "ep1.mp4",
	};
	const STAGED_SESSION = "00000000-0000-4000-8000-0000000000f1";
	const T0 = new Date("2026-06-12T00:00:00.000Z");

	it("feeder-switch (the immediate form) stages the program feed with the commit pre-requested and enqueues NO stop — the feeder worker stops the actives once the new source is READY (row #240)", async () => {
		const t = rtmpRunning();
		t.feederSession.findMany.mockResolvedValueOnce([{ id: "fs-slate" }]);
		const result = await t.process({
			liveChannelId: CHANNEL_ID,
			action: "feeder-switch",
			params: { scheduleId: SCHED_ID, source: PROGRAM_SOURCE },
		});
		expect(result).toMatchObject({ status: "fs-sched-1" });
		expect(t.enqueueFeederJob.mock.calls.map((call) => call[0])).toEqual([
			{ feederSessionId: "fs-sched-1", action: "start" },
		]);
		expect(t.feederSession.create).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ commitAt: T0, commitRequestedAt: T0 }),
			}),
		);
		expect(t.liveSchedule.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				// rev367 I-3: the immediate form runs against a FIRED row.
				where: { id: SCHED_ID, status: "FIRED" },
				data: expect.objectContaining({
					note: expect.stringContaining("staged for an immediate switch"),
					feederSessionId: "fs-sched-1",
				}),
			}),
		);
	});

	/**
	 * a scheduled ORDINARY start had no
	 * per-channel door at all. It now asks core's occupancy question and
	 * refuses — FAILED, naming the occupant — instead of creating a session
	 * whose worker would spawn beside a push that is not proven gone.
	 */
	it("feeder-start on an OCCUPIED channel is REFUSED — OCCUPIED, schedule FAILED naming the occupant, nothing created or enqueued (LC-02)", async () => {
		const t = rtmpRunning();
		t.feederSession.findMany.mockResolvedValue([
			{ id: "fs-old", status: "ERROR", pid: 4242, ownerHost: "worker-z" },
		]);
		const result = await t.process({
			liveChannelId: CHANNEL_ID,
			action: "feeder-start",
			params: { scheduleId: SCHED_ID, source: PROGRAM_SOURCE },
		});
		expect(result).toMatchObject({ status: "OCCUPIED" });
		// The question asked is core's fragment, not a hand-written list.
		expect(t.feederSession.findMany).toHaveBeenCalledWith(
			expect.objectContaining({ where: feederOccupancyWhere(CHANNEL_ID) }),
		);
		expect(t.feederSession.create).not.toHaveBeenCalled();
		expect(t.enqueueFeederJob).not.toHaveBeenCalled();
		expect(t.liveSchedule.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: SCHED_ID },
				data: {
					error: expect.stringContaining(
						"fs-old (ERROR, pid 4242 on worker-z)",
					),
				},
			}),
		);
		expect(t.liveSchedule.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					outcome: "FAILED",
					outcomeNote: expect.stringContaining("arm a FEEDER_SWITCH"),
				}),
			}),
		);
	});

	it("scheduled feeder admission refuses when global publisher OCCUPANCY reaches the cap, even with empty active slots (LC-02)", async () => {
		const t = rtmpRunning();
		t.feederSession.count
			.mockResolvedValueOnce(0)
			.mockResolvedValueOnce(FEEDER_MAX_ACTIVE_SESSIONS);
		await expect(
			t.process({
				liveChannelId: CHANNEL_ID,
				action: "feeder-start",
				params: { scheduleId: SCHED_ID, source: PROGRAM_SOURCE },
			}),
		).rejects.toThrow(/publisher occupancy limit/i);
		expect(t.feederSession.count).toHaveBeenNthCalledWith(2, {
			where: feederOccupancyWhere(),
		});
		expect(t.feederSession.create).not.toHaveBeenCalled();
		expect(t.enqueueFeederJob).not.toHaveBeenCalled();
	});

	it("scheduled two-phase stage is not charged against publisher occupancy — its commit owns the claim", async () => {
		const t = rtmpRunning();
		// The only legitimate count is the active worker-slot population. If a
		// second (publisher occupancy) count is added, make it hit the cap.
		t.feederSession.count
			.mockResolvedValueOnce(0)
			.mockResolvedValue(FEEDER_MAX_ACTIVE_SESSIONS);
		const result = await t.process({
			liveChannelId: CHANNEL_ID,
			action: "feeder-switch",
			params: { scheduleId: SCHED_ID, source: PROGRAM_SOURCE },
		});
		expect(result).toMatchObject({ status: "fs-sched-1" });
		expect(t.feederSession.create).toHaveBeenCalledTimes(1);
		expect(t.feederSession.count).not.toHaveBeenCalledWith({
			where: feederOccupancyWhere(),
		});
	});

	it("feeder-switch and feeder-stage are EXEMPT from the occupancy door — they coordinate through the barrier and claim only at their commit (LC-02)", async () => {
		const t = rtmpRunning();
		t.feederSession.findMany.mockResolvedValue([
			{ id: "fs-old", status: "PUSHING", pid: 4242, ownerHost: "worker-a" },
		]);
		const switched = await t.process({
			liveChannelId: CHANNEL_ID,
			action: "feeder-switch",
			params: { scheduleId: SCHED_ID, source: PROGRAM_SOURCE },
		});
		expect(switched).toMatchObject({ status: "fs-sched-1" });
		expect(t.feederSession.create).toHaveBeenCalledTimes(1);
		// Nothing asked the occupancy question on this path.
		expect(t.feederSession.findMany).not.toHaveBeenCalled();
	});

	it("feeder-stage creates a STAGED session carrying the row's commit instant, with no commit request yet", async () => {
		const t = rtmpRunning();
		// A stage runs against a row that has NOT fired (rev367 I-3).
		t.scheduleRow.status = "ARMED";
		const commitAt = "2026-06-12T00:10:00.000Z";
		await t.process({
			liveChannelId: CHANNEL_ID,
			action: "feeder-stage",
			params: { scheduleId: SCHED_ID, source: PROGRAM_SOURCE, commitAt },
		});
		expect(t.feederSession.create).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					commitAt: new Date(commitAt),
					commitRequestedAt: null,
				}),
			}),
		);
		expect(t.enqueueFeederJob.mock.calls.map((call) => call[0])).toEqual([
			{ feederSessionId: "fs-sched-1", action: "start" },
		]);
		// The stamp is a CAS on the row still being ARMED (rev367 I-3).
		expect(t.liveSchedule.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: SCHED_ID, status: "ARMED" },
				data: expect.objectContaining({
					note: expect.stringContaining(`commit planned for ${commitAt}`),
					feederSessionId: "fs-sched-1",
				}),
			}),
		);
	});

	it("feeder-stage on a row that already ENDED creates nothing — ROW_ENDED, and the row keeps its own story (rev367 I-3)", async () => {
		// The shape the review found: a stage claim stranded past fireAt was
		// re-added while the due scan landed the row MISSED "not staged" in
		// the same tick — and the late stage job then downloaded a whole
		// source and overwrote the refused row's note with "staged".
		const t = rtmpRunning();
		t.scheduleRow.status = "MISSED";
		const result = await t.process({
			liveChannelId: CHANNEL_ID,
			action: "feeder-stage",
			params: {
				scheduleId: SCHED_ID,
				source: PROGRAM_SOURCE,
				commitAt: "2026-06-12T00:10:00.000Z",
			},
		});
		expect(result).toMatchObject({ status: "ROW_ENDED" });
		expect(t.feederSession.create).not.toHaveBeenCalled();
		expect(t.enqueueFeederJob).not.toHaveBeenCalled();
		expect(t.liveSchedule.updateMany).not.toHaveBeenCalled();
	});

	it("a row that ends BETWEEN the check and the stamp keeps its note — the stamp is a CAS, not a write (rev367 I-3)", async () => {
		const t = rtmpRunning();
		t.scheduleRow.status = "ARMED";
		// The row ends while the stage is mid-flight: the harness flips it
		// when the session is created, which sits between the status read and
		// the stamp.
		t.feederSession.create.mockImplementationOnce(
			async (args: { data: Record<string, unknown> }) => {
				t.scheduleRow.status = "MISSED";
				t.feederRows.set("fs-sched-1", {
					id: "fs-sched-1",
					status: "CREATED",
					readyAt: null,
					commitRequestedAt: null,
					error: null,
					...args.data,
				});
				return { id: "fs-sched-1" };
			},
		);
		await t.process({
			liveChannelId: CHANNEL_ID,
			action: "feeder-stage",
			params: {
				scheduleId: SCHED_ID,
				source: PROGRAM_SOURCE,
				commitAt: "2026-06-12T00:10:00.000Z",
			},
		});
		// The stamp lost its CAS: the MISSED row was not repointed at the
		// session and its note was not rewritten.
		expect(t.scheduleRow.feederSessionId).toBeNull();
	});

	it("feeder-commit requests the commit on a READY session with ONE compare-and-swap, and notes it on the row", async () => {
		const t = rtmpRunning();
		t.feederRows.set(STAGED_SESSION, {
			id: STAGED_SESSION,
			status: "DOWNLOADING",
			readyAt: new Date("2026-06-11T23:58:00.000Z"),
			commitRequestedAt: null,
			error: null,
		});
		const result = await t.process({
			liveChannelId: CHANNEL_ID,
			action: "feeder-commit",
			params: { scheduleId: SCHED_ID, feederSessionId: STAGED_SESSION },
		});
		expect(result).toMatchObject({ status: "COMMIT_REQUESTED" });
		expect(t.feederRows.get(STAGED_SESSION)?.commitRequestedAt).toEqual(T0);
		// The CAS names every condition: the session, its channel, READY, and
		// no request yet.
		expect(t.feederSession.updateMany).toHaveBeenCalledWith({
			where: {
				id: STAGED_SESSION,
				liveChannelId: CHANNEL_ID,
				status: "DOWNLOADING",
				readyAt: { not: null },
				commitRequestedAt: null,
			},
			data: { commitRequestedAt: T0 },
		});
		expect(t.liveSchedule.updateMany).toHaveBeenCalledWith({
			where: { id: SCHED_ID },
			data: { note: expect.stringContaining("switch committed") },
		});
		// Nothing was stopped from here: the holder stops the predecessors.
		expect(t.enqueueFeederJob).not.toHaveBeenCalled();
	});

	it("feeder-commit on a session that is NOT ready writes the FAILED outcome 'not staged' and requests nothing", async () => {
		const t = rtmpRunning();
		t.feederRows.set(STAGED_SESSION, {
			id: STAGED_SESSION,
			status: "DOWNLOADING",
			readyAt: null,
			commitRequestedAt: null,
			error: null,
		});
		const result = await t.process({
			liveChannelId: CHANNEL_ID,
			action: "feeder-commit",
			params: { scheduleId: SCHED_ID, feederSessionId: STAGED_SESSION },
		});
		expect(result).toMatchObject({ status: "NOT_READY" });
		expect(t.feederRows.get(STAGED_SESSION)?.commitRequestedAt).toBeNull();
		expect(t.liveSchedule.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({ id: SCHED_ID }),
				data: expect.objectContaining({
					outcome: "FAILED",
					outcomeNote: expect.stringContaining("not staged"),
				}),
			}),
		);
		expect(t.enqueueFeederJob).not.toHaveBeenCalled();
	});

	it("feeder-commit re-delivered after its request landed is idempotent — no second FAILED, no second request", async () => {
		const t = rtmpRunning();
		t.feederRows.set(STAGED_SESSION, {
			id: STAGED_SESSION,
			status: "DOWNLOADING",
			readyAt: new Date("2026-06-11T23:58:00.000Z"),
			commitRequestedAt: new Date("2026-06-11T23:59:59.000Z"),
			error: null,
		});
		const result = await t.process({
			liveChannelId: CHANNEL_ID,
			action: "feeder-commit",
			params: { scheduleId: SCHED_ID, feederSessionId: STAGED_SESSION },
		});
		expect(result).toMatchObject({ status: "ALREADY_REQUESTED" });
		expect(t.feederRows.get(STAGED_SESSION)?.commitRequestedAt).toEqual(
			new Date("2026-06-11T23:59:59.000Z"),
		);
		expect(t.liveSchedule.updateMany).not.toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ outcome: "FAILED" }),
			}),
		);
	});

	/**
	 *  — the same feeder-start job delivered twice creates ONE
	 * session. The row's `feederSessionId` is stamped only after the create
	 * and the enqueue, and nothing read it: a job re-delivered after a worker
	 * death (this queue's default maxStalledCount is 1 — exactly one re-run)
	 * or re-added by the outbox created a second session with its own start
	 * job — two pushes at one ingest.
	 */
	it("the same feeder-start job delivered twice creates ONE session and ONE start job (row #262)", async () => {
		const t = rtmpRunning();
		const job = {
			liveChannelId: CHANNEL_ID,
			action: "feeder-start" as const,
			params: { scheduleId: SCHED_ID, source: PROGRAM_SOURCE },
		};
		await expect(t.process(job)).resolves.toMatchObject({
			status: "fs-sched-1",
		});
		await expect(t.process(job)).resolves.toMatchObject({
			status: "ALREADY_STARTED",
		});
		expect(t.feederSession.create).toHaveBeenCalledTimes(1);
		expect(t.enqueueFeederJob).toHaveBeenCalledTimes(1);
	});

	it("a re-delivered feeder-start whose first session already ENDED may start again — the guard is on a live session, not on the stamp (row #262)", async () => {
		const t = rtmpRunning();
		const job = {
			liveChannelId: CHANNEL_ID,
			action: "feeder-start" as const,
			params: { scheduleId: SCHED_ID, source: PROGRAM_SOURCE },
		};
		await t.process(job);
		const first = t.feederRows.get("fs-sched-1");
		if (first) {
			first.status = "ERROR";
		}
		await expect(t.process(job)).resolves.toMatchObject({
			status: "fs-sched-1",
		});
		expect(t.feederSession.create).toHaveBeenCalledTimes(2);
	});

	it("records the fired cue as a DONE SCTE35_CUE step-log entry (C14)", async () => {
		const { process, row } = setup(runningRow);
		await process({
			liveChannelId: CHANNEL_ID,
			action: "scte35",
			params: { cueDuration: 45, manifestIds: ["m-1", "m-2"] },
		});
		const entries = row.stepLog as StepLogEntry[];
		const cue = entries.find((e) => e.kind === "SCTE35_CUE");
		// status DONE so any later provision/restart replay skips it.
		expect(cue?.status).toBe("DONE");
		expect(cue?.payload).toEqual({
			at: "2026-06-12T00:00:00.000Z",
			cueDuration: 45,
			manifestIds: ["m-1", "m-2"],
			providerEntryId: "fake-scte35-cue",
		});
		// The entry is schema-valid (the detail page safeParses the whole log).
		expect(() => stepLogSchema.parse(entries)).not.toThrow();
		// It still validates as a CompiledOperation kind (shared union).
		expect(OPERATION_KINDS).toContain("SCTE35_CUE");
	});

	it("omits manifestIds from the cue record when the cue targets all manifests", async () => {
		const { process, row } = setup(runningRow);
		await process({
			liveChannelId: CHANNEL_ID,
			action: "scte35",
			params: { cueDuration: 30 },
		});
		const cue = (row.stepLog as StepLogEntry[]).find(
			(e) => e.kind === "SCTE35_CUE",
		);
		expect(cue?.payload).not.toHaveProperty("manifestIds");
	});

	it("atomically appends SCTE evidence without erasing a slate recorded during the provider call", async () => {
		const concurrentSlate: StepLogEntry = {
			step: "slate:2026-06-12T00:00:00.500Z",
			kind: "SLATE_INSERTED",
			payload: {
				at: "2026-06-12T00:00:00.500Z",
				insertableContentId: "content-concurrent",
				providerEntryId: "slate-concurrent",
			},
			refs: {},
			status: "DONE",
			startedAt: "2026-06-12T00:00:00.500Z",
			finishedAt: "2026-06-12T00:00:00.500Z",
		};
		let harness: ReturnType<typeof setup>;
		harness = setup(runningRow, {
			insertScte35Cue: vi.fn(async () => {
				// This is the state an atomic slate append commits while the
				// Bitmovin SCTE request is in flight.
				harness.row.stepLog = [
					...(harness.row.stepLog as StepLogEntry[]),
					concurrentSlate,
				];
				return { id: "provider-cue-concurrent" };
			}),
		});

		await harness.process({
			liveChannelId: CHANNEL_ID,
			action: "scte35",
			params: { cueDuration: 30 },
		});

		const entries = harness.row.stepLog as StepLogEntry[];
		expect(entries).toContainEqual(concurrentSlate);
		expect(entries).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: "SCTE35_CUE",
					payload: expect.objectContaining({
						providerEntryId: "provider-cue-concurrent",
					}),
				}),
			]),
		);
	});

	it("keeps a late SCTE provider success on its claimed old run after STOP and re-air", async () => {
		const successorMarker: StepLogEntry = {
			step: "successor-run-marker",
			kind: "SCTE35_CUE",
			payload: {
				at: "2026-06-12T00:01:00.000Z",
				cueDuration: 15,
				providerEntryId: "successor-own-cue",
			},
			refs: {},
			status: "DONE",
			startedAt: "2026-06-12T00:01:00.000Z",
			finishedAt: "2026-06-12T00:01:00.000Z",
		};
		const successorRunId = "00000000-0000-4000-8000-0000000000dd";
		let harness: ReturnType<typeof setup>;
		harness = setup(runningRow, {
			insertScte35Cue: vi.fn(async () => {
				const oldRun = harness.runRows[0];
				if (!oldRun) throw new Error("old run fixture missing");
				oldRun.status = "STOPPED";
				harness.row.status = "RUNNING";
				harness.row.bitmovinEncodingId = "bm-live-enc-successor";
				harness.row.liveEffectFenceVersion = 3;
				harness.row.stepLog = [successorMarker];
				harness.runRows.push({
					id: successorRunId,
					seq: 2,
					status: "RUNNING",
					bitmovinEncodingId: "bm-live-enc-successor",
					stepLog: [successorMarker],
				});
				return { id: "provider-cue-old-run" };
			}),
		});
		liveEffectMocks.markAcked.mockResolvedValueOnce(false);

		await expect(
			harness.process({
				liveChannelId: CHANNEL_ID,
				action: "scte35",
				params: { cueDuration: 30 },
			}),
		).resolves.toMatchObject({ status: "EFFECT_ACK_FENCE_LOST" });

		expect(harness.row.stepLog).toEqual([successorMarker]);
		const successor = harness.runRows.find((run) => run.id === successorRunId);
		expect(successor?.stepLog).toEqual([successorMarker]);
		const oldRun = harness.runRows.find((run) => run.id === LIVE_TO_VOD_RUN_ID);
		expect(oldRun?.stepLog).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: "SCTE35_CUE",
					payload: expect.objectContaining({
						providerEntryId: "provider-cue-old-run",
					}),
				}),
			]),
		);
	});

	it("refuses actions on channels without a Bitmovin encoding", async () => {
		const { actions, liveChannel } = setup({
			status: "RUNNING",
			bitmovinEncodingId: null,
		});
		await expect(actions.stopChannel(CHANNEL_ID)).rejects.toThrow(
			/no Bitmovin encoding/,
		);
		// POSITION, not just the throw: the guard must refuse BEFORE any state
		// write — a refactor moving it below updateMany would keep the throw
		// and still flip an unprovisioned channel to STOPPING (review-180 N2).
		expect(liveChannel.updateMany).not.toHaveBeenCalled();
	});
});

/**
 * (row 266) — the run-generation fence for a
 * scheduled action retrying INSIDE the queue.
 *
 * Every run-acting job carries the run it was PLANNED for. A BullMQ backoff
 * or stalled-job re-run can deliver it AFTER the channel has stopped and
 * RE-AIRED onto a new run; acting then would push a previous airing's source,
 * slate or stop onto the new run's ingest. Row 241's sweep-time check cannot
 * see a job that turns stale after it was enqueued — the fence at the top of
 * each dispatch case can.
 *
 * The table drives one arm per run-acting action so that removing ANY ONE of
 * the six fences turns exactly that action's arm red (each arm asserts its own
 * action's side effect did NOT happen and the result is SKIPPED_STALE_
 * GENERATION — both of which flip the moment its fence is gone, and neither of
 * which another action's fence can affect). The control arm proves the same
 * job runs when its planned run IS the current one.
 */
describe("durable external-effect fence (SC-01)", () => {
	const scheduleId = "33333333-3333-4333-8333-333333333333";
	const contentId = "99999999-9999-4999-8999-999999999999";
	const stagedSessionId = "00000000-0000-4000-8000-0000000000f1";
	const source = {
		credentialId: "00000000-0000-4000-8000-0000000000c1",
		bucket: "in",
		key: "slate.mp4",
	};
	const running = {
		status: "RUNNING",
		bitmovinAccountId: ACCOUNT_ID,
		bitmovinEncodingId: "bm-live-enc",
	};

	function rtmpRunning() {
		const plan = structuredClone(basePlan) as unknown as { liveInput: unknown };
		plan.liveInput = { key: "main", kind: "RTMP" };
		return {
			...running,
			plan,
			streamKey: "sched-key",
			encoderIp: "203.0.113.9",
		};
	}

	function firstCallOrder(mock: MockInstance): number {
		return mock.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY;
	}

	it("fails closed when an irreversible legacy job has no run-bound intent", async () => {
		const t = setup(running, {
			getEncodingStatus: async () => ({ status: "FINISHED" }) as never,
		});
		const result = await t.rawProcess({
			liveChannelId: CHANNEL_ID,
			action: "stop",
		});
		expect(result).toMatchObject({ status: "EFFECT_REFUSED" });
		expect(t.sdk.stopLiveEncoding).not.toHaveBeenCalled();
		expect(liveEffectMocks.begin).not.toHaveBeenCalled();
	});

	it("executes the exact queue-first manual stop intent once across a duplicate delivery", async () => {
		const runId = "11111111-1111-4111-8111-111111111111";
		const job = {
			liveChannelId: CHANNEL_ID,
			action: "stop",
			effect: {
				idempotencyKey: `manual:stop:${CHANNEL_ID}:${runId}:0`,
				liveChannelRunId: runId,
				providerEncodingId: "bm-live-enc",
				admissionFenceVersion: 0,
				action: "STOP",
			},
		};
		const t = setup(running, {
			getEncodingStatus: async () => ({ status: "FINISHED" }) as never,
		});
		if (!t.runRows[0]) throw new Error("fixture run missing");
		t.runRows[0].id = runId;

		const first = await t.rawProcess(job);
		expect(first).toMatchObject({ status: "STOPPED" });
		expect(liveEffectMocks.begin).toHaveBeenNthCalledWith(
			1,
			expect.anything(),
			expect.objectContaining({
				idempotencyKey: job.effect.idempotencyKey,
				liveChannelRunId: runId,
				providerEncodingId: "bm-live-enc",
				expectedFenceVersion: 0,
				action: "STOP",
			}),
		);

		// Model the real claim table observing the first ACK on redelivery.
		liveEffectMocks.begin.mockResolvedValueOnce({
			kind: "ACKED",
			claimId: "claim:manual-stop",
		});
		const duplicate = await t.rawProcess(job);

		expect(duplicate).toMatchObject({ status: "EFFECT_ALREADY_ACKNOWLEDGED" });
		expect(t.sdk.stopLiveEncoding).toHaveBeenCalledTimes(1);
	});

	it("recovers a clean STOP after crashing before its claim ACK without stopping the provider twice", async () => {
		const runId = "11111111-1111-4111-8111-111111111111";
		const job = {
			liveChannelId: CHANNEL_ID,
			action: "stop" as const,
			effect: {
				idempotencyKey: `manual:stop:${CHANNEL_ID}:${runId}:0`,
				liveChannelRunId: runId,
				providerEncodingId: "bm-live-enc",
				admissionFenceVersion: 0,
				action: "STOP" as const,
			},
		};
		const t = setup(running, {
			getEncodingStatus: async () => ({ status: "FINISHED" }) as never,
		});
		if (!t.runRows[0]) throw new Error("fixture run missing");
		t.row.status = "STOPPED";
		t.runRows[0].id = runId;
		t.runRows[0].status = "STOPPED";
		liveEffectMocks.begin.mockResolvedValueOnce({
			kind: "BLOCKED",
			claimId: "claim:manual-stop",
			state: "DISPATCHING",
			reason: "the idempotency key is already DISPATCHING",
		});

		await expect(t.rawProcess(job)).resolves.toMatchObject({
			status: "STOPPED",
		});
		expect(liveEffectMocks.resolveAfterStop).toHaveBeenCalledWith(
			expect.anything(),
			{
				liveChannelId: CHANNEL_ID,
				liveChannelRunId: runId,
				providerEncodingId: "bm-live-enc",
				stopClaimId: "claim:manual-stop",
				stopIdempotencyKey: job.effect.idempotencyKey,
				at: expect.any(Date),
			},
		);
		expect(t.sdk.stopLiveEncoding).not.toHaveBeenCalled();
		expect(liveEffectMocks.markAcked).not.toHaveBeenCalled();
	});

	it("retries rather than reporting STOPPED when crash recovery lacks exact terminal evidence", async () => {
		const runId = "11111111-1111-4111-8111-111111111111";
		const job = {
			liveChannelId: CHANNEL_ID,
			action: "stop" as const,
			effect: {
				idempotencyKey: `manual:stop:${CHANNEL_ID}:${runId}:0`,
				liveChannelRunId: runId,
				providerEncodingId: "bm-live-enc",
				admissionFenceVersion: 0,
				action: "STOP" as const,
			},
		};
		const t = setup(running);
		if (!t.runRows[0]) throw new Error("fixture run missing");
		t.row.status = "STOPPED";
		t.runRows[0].id = runId;
		t.runRows[0].status = "STOPPED";
		liveEffectMocks.begin.mockResolvedValueOnce({
			kind: "BLOCKED",
			claimId: "claim:manual-stop",
			state: "DISPATCHING",
			reason: "the idempotency key is already DISPATCHING",
		});
		liveEffectMocks.resolveAfterStop.mockResolvedValueOnce({
			kind: "BLOCKED",
			reason:
				"the exact provider encoding has no authoritative terminal readback",
		});

		await expect(t.rawProcess(job)).rejects.toThrow(
			/LIVE_STOP_RECONCILIATION_BLOCKED/,
		);
		expect(t.sdk.stopLiveEncoding).not.toHaveBeenCalled();
		expect(liveEffectMocks.markAcked).not.toHaveBeenCalled();
	});

	it("persists DISPATCHING and rechecks the exact fence before a stop send", async () => {
		const t = setup(running, {
			getEncodingStatus: async () => ({ status: "FINISHED" }) as never,
		});
		await t.process({ liveChannelId: CHANNEL_ID, action: "stop" });
		expect(firstCallOrder(liveEffectMocks.begin)).toBeLessThan(
			firstCallOrder(liveEffectMocks.assertCurrent),
		);
		expect(firstCallOrder(liveEffectMocks.assertCurrent)).toBeLessThan(
			firstCallOrder(t.sdk.stopLiveEncoding as unknown as MockInstance),
		);
		expect(liveEffectMocks.resolveAfterStop).toHaveBeenCalledOnce();
		expect(liveEffectMocks.markAcked).not.toHaveBeenCalled();
	});

	it("never sends STOP after its prepared generation loses the STOPPING transition CAS", async () => {
		const t = setup(
			{
				...running,
				status: "STOPPING",
				// The prepared STOP owns generation 1; model a winner advancing the
				// channel between beginLiveEffect and stopChannel's transition.
				liveEffectFenceVersion: 2,
			},
			{ getEncodingStatus: async () => ({ status: "FINISHED" }) as never },
		);

		await expect(
			t.rawProcess({
				liveChannelId: CHANNEL_ID,
				action: "stop",
				effect: {
					idempotencyKey: `manual:stop:${CHANNEL_ID}:${LIVE_TO_VOD_RUN_ID}:0`,
					liveChannelRunId: LIVE_TO_VOD_RUN_ID,
					providerEncodingId: "bm-live-enc",
					admissionFenceVersion: 0,
					action: "STOP",
				},
			}),
		).rejects.toThrow(/cannot be stopped|generation/i);
		expect(t.sdk.stopLiveEncoding).not.toHaveBeenCalled();
		expect(t.row.status).toBe("STOPPING");
		expect(liveEffectMocks.markFailed).toHaveBeenCalled();
	});

	it("re-delivers one SCTE request as one provider cue and one ACKED claim", async () => {
		const requestSha256 = "d".repeat(64);
		const claim = {
			id: "claim-scte-1",
			idempotencyKey: "manual:scte35:channel:request",
			token: "token-scte-1",
			liveChannelId: CHANNEL_ID,
			liveChannelRunId: LIVE_TO_VOD_RUN_ID,
			providerEncodingId: "bm-live-enc",
			action: "SCTE35",
			generation: 1,
			expiresAt: new Date("2026-06-12T00:20:00.000Z"),
		};
		liveEffectMocks.begin
			.mockResolvedValueOnce({ kind: "EXECUTE", claim })
			.mockResolvedValueOnce({
				kind: "ACKED",
				claimId: claim.id,
				providerResultId: null,
			});
		const t = setup(running, {
			insertScte35Cue: vi.fn(async () => ({ id: "provider-cue-1" })),
		});
		const job = {
			liveChannelId: CHANNEL_ID,
			action: "scte35" as const,
			params: { cueDuration: 30 },
			effect: {
				idempotencyKey: claim.idempotencyKey,
				requestSha256,
				liveChannelRunId: LIVE_TO_VOD_RUN_ID,
				providerEncodingId: "bm-live-enc",
				admissionFenceVersion: 0,
				action: "SCTE35" as const,
			},
		};

		await expect(t.rawProcess(job)).resolves.toMatchObject({
			status: "RUNNING",
		});
		await expect(t.rawProcess(job)).resolves.toMatchObject({
			status: "EFFECT_ALREADY_ACKNOWLEDGED",
		});

		expect(t.sdk.insertScte35Cue).toHaveBeenCalledTimes(1);
		expect(liveEffectMocks.markAcked).toHaveBeenCalledWith(
			expect.anything(),
			claim,
			expect.any(Date),
			{ providerResultId: "provider-cue-1" },
		);
		const cueLog = (
			t.row.stepLog as { kind: string; payload?: unknown }[]
		).find((entry) => entry.kind === "SCTE35_CUE");
		expect(cueLog?.payload).toMatchObject({
			providerEntryId: "provider-cue-1",
		});
		expect(liveEffectMocks.begin).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ requestSha256 }),
		);
	});

	it("a lost slate fence is FAILED before POST and never reaches the provider", async () => {
		liveEffectMocks.assertCurrent.mockResolvedValueOnce(false);
		const t = setup(running);
		await expect(
			t.process({
				liveChannelId: CHANNEL_ID,
				action: "insert-content",
				params: { insertableContentId: contentId, durationSeconds: 30 },
			}),
		).rejects.toThrow(/exact run\/generation fence/);
		expect(t.sdk.scheduleInsertableContent).not.toHaveBeenCalled();
		expect(liveEffectMocks.markFailed).toHaveBeenCalled();
		expect(liveEffectMocks.markAmbiguous).not.toHaveBeenCalled();
	});

	it("a lost slate response is AMBIGUOUS and is never reported as retryable", async () => {
		const t = setup(running, {
			scheduleInsertableContent: vi.fn(async () => {
				throw new Error("provider response lost");
			}),
		});
		const result = await t.process({
			liveChannelId: CHANNEL_ID,
			action: "insert-content",
			params: { insertableContentId: contentId, durationSeconds: 30 },
		});
		expect(result).toMatchObject({ status: "EFFECT_AMBIGUOUS" });
		expect(t.sdk.scheduleInsertableContent).toHaveBeenCalledOnce();
		expect(liveEffectMocks.markAmbiguous).toHaveBeenCalledOnce();
		expect(liveEffectMocks.markFailed).not.toHaveBeenCalled();
	});

	it("stays AMBIGUOUS when a compound stop loses its fence after the first send", async () => {
		liveEffectMocks.assertCurrent
			.mockResolvedValueOnce(true)
			.mockResolvedValueOnce(false);
		const t = setup(
			{
				...running,
				stepLog: stepLogNaming("bm-live-enc-secondary"),
			},
			{ getEncodingStatus: async () => ({ status: "FINISHED" }) as never },
		);
		const result = await t.process({
			liveChannelId: CHANNEL_ID,
			action: "stop",
		});
		expect(result).toMatchObject({ status: "EFFECT_AMBIGUOUS" });
		expect(t.sdk.stopLiveEncoding).toHaveBeenCalledTimes(1);
		expect(liveEffectMocks.markFailed).not.toHaveBeenCalled();
		expect(liveEffectMocks.markAmbiguous).toHaveBeenCalled();
	});

	it("binds a scheduled feeder start to its durable claim before enqueue", async () => {
		const t = setup(rtmpRunning());
		await t.process({
			liveChannelId: CHANNEL_ID,
			action: "feeder-start",
			params: { scheduleId, source },
		});
		expect(firstCallOrder(liveEffectMocks.begin)).toBeLessThan(
			firstCallOrder(liveEffectMocks.bindTarget),
		);
		expect(firstCallOrder(liveEffectMocks.bindTarget)).toBeLessThan(
			firstCallOrder(t.enqueueFeederJob),
		);
	});

	it("keeps feeder staging outside the effect fence, then fences commit", async () => {
		const stage = setup(rtmpRunning());
		stage.scheduleRow.status = "ARMED";
		await stage.process({
			liveChannelId: CHANNEL_ID,
			action: "feeder-stage",
			params: {
				scheduleId,
				source,
				commitAt: "2026-06-12T00:10:00.000Z",
			},
		});
		expect(liveEffectMocks.begin).not.toHaveBeenCalled();

		vi.clearAllMocks();
		liveEffectMocks.begin.mockImplementation(
			async (_prisma: unknown, input: Record<string, unknown>) => ({
				kind: "EXECUTE",
				claim: {
					id: "claim:commit",
					idempotencyKey: input.idempotencyKey,
					token: "token:commit",
					liveChannelId: input.liveChannelId,
					liveChannelRunId: input.liveChannelRunId,
					providerEncodingId: input.providerEncodingId,
					action: input.action,
					generation: 1,
					expiresAt: new Date("2026-06-12T00:20:00.000Z"),
				},
			}),
		);
		liveEffectMocks.assertCurrent.mockResolvedValue(true);
		liveEffectMocks.markFailed.mockResolvedValue(true);
		const commit = setup(rtmpRunning());
		commit.feederRows.set(stagedSessionId, {
			id: stagedSessionId,
			status: "DOWNLOADING",
			readyAt: new Date("2026-06-11T23:58:00.000Z"),
			commitRequestedAt: null,
			error: null,
		});
		await commit.process({
			liveChannelId: CHANNEL_ID,
			action: "feeder-commit",
			params: { scheduleId, feederSessionId: stagedSessionId },
		});
		expect(firstCallOrder(liveEffectMocks.begin)).toBeLessThan(
			firstCallOrder(liveEffectMocks.assertCurrent),
		);
		expect(firstCallOrder(liveEffectMocks.assertCurrent)).toBeLessThan(
			firstCallOrder(commit.feederSession.updateMany),
		);
	});
});

describe("run-generation fence for queue retries", () => {
	// Distinct run ids: RUN_1 is the airing the job was planned for, RUN_2 is
	// the airing the channel is on NOW (it re-aired while the job sat queued).
	const RUN_1 = "11111111-1111-4111-8111-111111111111";
	const RUN_2 = "22222222-2222-4222-8222-222222222222";
	const SCHEDULE_ID = "33333333-3333-4333-8333-333333333333";
	const CRED_ID = "00000000-0000-4000-8000-0000000000c1";
	const CONTENT_ID = "99999999-9999-4999-8999-999999999999";
	const STAGED_SESSION = "00000000-0000-4000-8000-0000000000f1";
	const SOURCE = { credentialId: CRED_ID, bucket: "in", key: "slate.mp4" };

	// A RUNNING RTMP channel (feeder actions derive the ingest target from it).
	function rtmpChannel() {
		const rtmpPlan = structuredClone(basePlan) as unknown as {
			liveInput: unknown;
		};
		rtmpPlan.liveInput = { key: "main", kind: "RTMP" };
		return {
			status: "RUNNING",
			bitmovinAccountId: ACCOUNT_ID,
			bitmovinEncodingId: "bm-live-enc",
			plan: rtmpPlan,
			streamKey: "sched-key",
			encoderIp: "203.0.113.9",
		} as const;
	}
	// A RUNNING channel with an encoding but no RTMP plan (stop / slate).
	function plainChannel() {
		return {
			status: "RUNNING",
			bitmovinAccountId: ACCOUNT_ID,
			bitmovinEncodingId: "bm-live-enc",
		} as const;
	}

	type Harness = ReturnType<typeof setup>;
	type FenceCase = {
		action: string;
		channel: () => Record<string, unknown>;
		// Per-action harness state (a staged session, an ARMED row).
		prep?: (t: Harness) => void;
		// The full queue job, armed for `plannedRunId`.
		job: (plannedRunId: string) => Record<string, unknown>;
		// The spy that fires ONLY when the action runs PAST the fence — the
		// "nothing was pushed" probe for the stale arm and the "it ran" probe
		// for the control arm. The load-bearing per-fence pin.
		sideEffect: (t: Harness) => MockInstance;
		// The result status the action returns when it is allowed to run.
		ranStatus: string;
	};

	const CASES: FenceCase[] = [
		{
			action: "feeder-start",
			channel: rtmpChannel,
			job: (run) => ({
				liveChannelId: CHANNEL_ID,
				action: "feeder-start",
				plannedLiveChannelRunId: run,
				params: { scheduleId: SCHEDULE_ID, source: SOURCE },
			}),
			sideEffect: (t) => t.feederSession.create,
			ranStatus: "fs-sched-1",
		},
		{
			action: "feeder-switch",
			channel: rtmpChannel,
			job: (run) => ({
				liveChannelId: CHANNEL_ID,
				action: "feeder-switch",
				plannedLiveChannelRunId: run,
				params: { scheduleId: SCHEDULE_ID, source: SOURCE },
			}),
			sideEffect: (t) => t.feederSession.create,
			ranStatus: "fs-sched-1",
		},
		{
			action: "feeder-stage",
			channel: rtmpChannel,
			// A stage runs against a row that has NOT fired yet (rev367 I-3).
			prep: (t) => {
				t.scheduleRow.status = "ARMED";
			},
			job: (run) => ({
				liveChannelId: CHANNEL_ID,
				action: "feeder-stage",
				plannedLiveChannelRunId: run,
				params: {
					scheduleId: SCHEDULE_ID,
					source: SOURCE,
					commitAt: "2026-06-12T00:10:00.000Z",
				},
			}),
			sideEffect: (t) => t.feederSession.create,
			ranStatus: "fs-sched-1",
		},
		{
			action: "feeder-commit",
			channel: rtmpChannel,
			// A READY staged session for the commit to CAS against.
			prep: (t) => {
				t.feederRows.set(STAGED_SESSION, {
					id: STAGED_SESSION,
					status: "DOWNLOADING",
					readyAt: new Date("2026-06-11T23:58:00.000Z"),
					commitRequestedAt: null,
					error: null,
				});
			},
			job: (run) => ({
				liveChannelId: CHANNEL_ID,
				action: "feeder-commit",
				plannedLiveChannelRunId: run,
				params: { scheduleId: SCHEDULE_ID, feederSessionId: STAGED_SESSION },
			}),
			sideEffect: (t) => t.feederSession.updateMany,
			ranStatus: "COMMIT_REQUESTED",
		},
		{
			action: "insert-content",
			channel: plainChannel,
			job: (run) => ({
				liveChannelId: CHANNEL_ID,
				action: "insert-content",
				plannedLiveChannelRunId: run,
				params: {
					insertableContentId: CONTENT_ID,
					durationSeconds: 30,
					scheduleId: SCHEDULE_ID,
				},
			}),
			// The provider POST that actually covers the programme.
			sideEffect: (t) =>
				t.sdk.scheduleInsertableContent as unknown as MockInstance,
			ranStatus: "RUNNING",
		},
		{
			action: "stop",
			channel: plainChannel,
			prep: (t) => {
				vi.mocked(t.sdk.getEncodingStatus).mockResolvedValue({
					status: "FINISHED",
				} as never);
			},
			job: (run) => ({
				liveChannelId: CHANNEL_ID,
				action: "stop",
				plannedLiveChannelRunId: run,
			}),
			// The STOPPING claim — stopChannel's first write.
			sideEffect: (t) => t.liveChannel.updateMany,
			ranStatus: "STOPPED",
		},
	];

	for (const c of CASES) {
		it(`REFUSES a stale ${c.action} — nothing acts on the new run, and the row is terminated SKIPPED_STALE_GENERATION with a FAILED outcome`, async () => {
			const t = setup(c.channel());
			// The channel has RE-AIRED onto RUN_2; this job was armed for RUN_1.
			t.runRows.push({
				id: RUN_2,
				seq: 2,
				status: "RUNNING",
				bitmovinEncodingId: "bm-live-enc",
				providerStatus: "RUNNING",
				providerStatusObservedAt: new Date("2099-01-01T00:00:00.000Z"),
			});
			c.prep?.(t);
			const result = await t.process(c.job(RUN_1));
			expect(result).toMatchObject({ status: "SKIPPED_STALE_GENERATION" });
			// Nothing was pushed / stopped / inserted, and nothing spawned.
			expect(c.sideEffect(t)).not.toHaveBeenCalled();
			expect(t.enqueueFeederJob).not.toHaveBeenCalled();
			// The row is terminated SKIPPED_STALE_GENERATION with a TERMINAL
			// outcome — never left PENDING (row 263's lesson).
			expect(t.liveSchedule.updateMany).toHaveBeenCalledWith(
				expect.objectContaining({
					data: expect.objectContaining({
						status: "SKIPPED_STALE_GENERATION",
					}),
				}),
			);
			expect(t.liveSchedule.updateMany).toHaveBeenCalledWith(
				expect.objectContaining({
					data: expect.objectContaining({ outcome: "FAILED" }),
				}),
			);
		});

		it(`a ${c.action} whose planned run IS the current run runs normally (control)`, async () => {
			const t = setup(c.channel());
			t.runRows.push({
				id: RUN_2,
				seq: 2,
				status: "RUNNING",
				bitmovinEncodingId: "bm-live-enc",
				providerStatus: "RUNNING",
				providerStatusObservedAt: new Date("2099-01-01T00:00:00.000Z"),
			});
			c.prep?.(t);
			const result = await t.process(c.job(RUN_2));
			expect(c.sideEffect(t)).toHaveBeenCalled();
			expect(result).toMatchObject({ status: c.ranStatus });
		});
	}

	it("a legacy job with no attributable run is refused before creating an ingest effect", async () => {
		const t = setup(rtmpChannel());
		t.runRows.length = 0;
		await expect(
			t.process({
				liveChannelId: CHANNEL_ID,
				action: "feeder-start",
				params: { scheduleId: SCHEDULE_ID, source: SOURCE },
			}),
		).rejects.toThrow(/exact live run and encoding/);
		expect(t.feederSession.create).not.toHaveBeenCalled();
	});
});

/**
 *  — FIRED is not DELIVERED.
 *
 * The 2026-08-29 live audit (HIGH-1) fired a slate insertion on a paid run, the
 * provider's scheduled entry went ERROR, the picture never changed, and this
 * system recorded `SLATE_INSERTED / DONE` with the schedule row FIRED and
 * green. Every arm below asserts the OUTCOME the provider (or the channel)
 * reported, never the request we sent.
 */
describe("schedule delivery outcomes (ledger #238)", () => {
	it("normal provider FINISHED during a running sweep stops the airing without rewriting delivery outcomes", async () => {
		const h = setup(
			{
				status: "RUNNING",
				bitmovinAccountId: ACCOUNT_ID,
				bitmovinEncodingId: "bm-live-enc",
			},
			{ getEncodingStatus: vi.fn(async () => ({ status: "FINISHED" })) },
		);
		h.deps.emitEvent = vi.fn(async () => {});
		await h.sweep();
		expect(h.row).toMatchObject({
			status: "STOPPED",
			error: null,
			bitmovinEncodingId: "bm-live-enc",
		});
		expect(h.runRows[0]).toMatchObject({
			status: "STOPPED",
			error: null,
			providerStatus: "FINISHED",
		});
		expect(h.deps.emitEvent).toHaveBeenCalledWith(
			expect.objectContaining({ kind: "CHANNEL_STOPPED" }),
		);
		expect(h.deps.emitEvent).not.toHaveBeenCalledWith(
			expect.objectContaining({ kind: "CHANNEL_ERROR" }),
		);
		expect(h.liveSchedule.updateMany).not.toHaveBeenCalled();
	});

	it("normal FINISHED cannot clear a concurrent independent channel error", async () => {
		const h = setup({
			status: "RUNNING",
			bitmovinAccountId: ACCOUNT_ID,
			bitmovinEncodingId: "bm-live-enc",
		});
		h.deps.emitEvent = vi.fn(async () => {});
		vi.mocked(h.sdk.getEncodingStatus).mockImplementation(async () => {
			h.row.error = "feeder cleanup unconfirmed";
			return { status: "FINISHED" };
		});
		await h.sweep();
		expect(h.row.error).toBe("feeder cleanup unconfirmed");
		expect(h.runRows[0]).toMatchObject({
			status: "STOPPED",
			error: null,
			providerStatus: "FINISHED",
		});
		expect(h.deps.emitEvent).not.toHaveBeenCalledWith(
			expect.objectContaining({ kind: "CHANNEL_STOPPED" }),
		);
	});

	it("a stale RUNNING sweep cannot erase a concurrent run failure with FINISHED", async () => {
		const h = setup({
			status: "RUNNING",
			bitmovinAccountId: ACCOUNT_ID,
			bitmovinEncodingId: "bm-live-enc",
		});
		h.deps.emitEvent = vi.fn(async () => {});
		vi.mocked(h.sdk.getEncodingStatus).mockImplementation(async () => {
			const run = h.runRows[0];
			if (!run) throw new Error("missing fixture run");
			run.status = "ERROR";
			run.error = "independent processing failure";
			return { status: "FINISHED" };
		});
		await h.sweep();
		expect(h.runRows[0]).toMatchObject({
			status: "ERROR",
			error: "independent processing failure",
			providerTerminalAt: null,
		});
		expect(h.deps.emitEvent).not.toHaveBeenCalledWith(
			expect.objectContaining({ kind: "CHANNEL_STOPPED" }),
		);
	});
	function trackStartOutcomes(
		h: ReturnType<typeof setup>,
		rows: Array<Record<string, unknown>>,
	) {
		h.liveSchedule.updateMany.mockImplementation(async ({ where, data }) => {
			const matches = rows.filter((row) =>
				Object.entries((where ?? {}) as Record<string, unknown>).every(
					([key, value]) => {
						if (value && typeof value === "object" && "in" in value)
							return (value.in as unknown[]).includes(row[key]);
						return row[key] === value;
					},
				),
			);
			for (const row of matches) Object.assign(row, data);
			return { count: matches.length };
		});
	}

	it("preserves delivered START after normal stop and old provision redelivery", async () => {
		const h = setup();
		const schedule = {
			liveChannelId: CHANNEL_ID,
			liveChannelRunId: "run-1",
			action: "START",
			status: "FIRED",
			outcome: "PENDING",
		};
		trackStartOutcomes(h, [schedule]);
		await h.process({ liveChannelId: CHANNEL_ID });
		expect(schedule.outcome).toBe("DELIVERED");
		const run = h.runRows[0];
		if (!run) throw new Error("fixture run missing");
		run.liveChannelId = CHANNEL_ID;
		run.id = LIVE_TO_VOD_RUN_ID;
		schedule.liveChannelRunId = LIVE_TO_VOD_RUN_ID;
		vi.mocked(h.sdk.getEncodingStatus).mockResolvedValue({
			status: "FINISHED",
		});
		await h.process({
			liveChannelId: CHANNEL_ID,
			action: "stop",
			effect: {
				idempotencyKey: "test:stop:scheduled-start",
				liveChannelRunId: LIVE_TO_VOD_RUN_ID,
				providerEncodingId: "bm-live-enc",
				admissionFenceVersion: 0,
				action: "STOP",
			},
		});
		expect(h.row.status).toBe("STOPPED");
		expect(h.row.error).toBeNull();
		h.liveSchedule.updateMany.mockClear();
		await h.process({ liveChannelId: CHANNEL_ID });
		expect(schedule.outcome).toBe("DELIVERED");
		expect(h.liveSchedule.updateMany).not.toHaveBeenCalled();
	});

	it("fails only the current pending START on cancellation, preserving other runs and settled outcomes", async () => {
		const h = setup(
			{},
			{ getEncodingStatus: vi.fn(async () => ({ status: "CANCELED" })) },
		);
		const base = {
			liveChannelId: CHANNEL_ID,
			action: "START",
			status: "FIRED",
		};
		const schedules = [
			{ ...base, liveChannelRunId: "run-1", outcome: "PENDING" },
			{ ...base, liveChannelRunId: "old-run", outcome: "PENDING" },
			{ ...base, liveChannelRunId: "old-run", outcome: "DELIVERED" },
			{ ...base, liveChannelRunId: "run-1", outcome: "DELIVERED" },
			{ ...base, liveChannelRunId: "run-1", outcome: "UNKNOWN" },
			{ ...base, liveChannelRunId: null, outcome: "PENDING" },
		];
		trackStartOutcomes(h, schedules);
		await expect(
			h.process({ liveChannelId: CHANNEL_ID }),
		).resolves.toMatchObject({ status: "STOPPED" });
		expect(schedules.map((s) => s.outcome)).toEqual([
			"FAILED",
			"PENDING",
			"DELIVERED",
			"DELIVERED",
			"UNKNOWN",
			"PENDING",
		]);
	});

	const runningRow = {
		status: "RUNNING",
		bitmovinAccountId: ACCOUNT_ID,
		bitmovinEncodingId: "bm-live-enc",
	};
	const CONTENT_ID = "99999999-9999-4999-8999-999999999999";
	const SCHEDULE_ID = "33333333-3333-4333-8333-333333333333";

	/** Every `liveSchedule.updateMany` that carried an outcome, in order. */
	const outcomeWrites = (liveSchedule: {
		updateMany: { mock: { calls: unknown[][] } };
	}) =>
		liveSchedule.updateMany.mock.calls
			.map((call) => call[0] as { data?: { outcome?: string } })
			.filter((arg) => arg.data?.outcome !== undefined);

	const fireSlate = async (
		harness: ReturnType<typeof setup>,
		extra: Record<string, unknown> = {},
	) =>
		await harness.process({
			liveChannelId: CHANNEL_ID,
			action: "insert-content",
			params: {
				insertableContentId: CONTENT_ID,
				durationSeconds: 60,
				scheduleId: SCHEDULE_ID,
				...extra,
			},
		});

	it("a provider entry the encoder ARMED marks the row SLATE_ARMED, not DELIVERED (audit HIGH-5)", async () => {
		// The fake's POST records what it created and lists it SCHEDULED — the
		// healthiest realistic answer. But SCHEDULED means only ARMED: the SDK
		// has no played/finished status, so there is NO witness the slate aired.
		// The outcome is SLATE_ARMED (a non-green "accepted"), never DELIVERED —
		// an armed entry that never loaded real media must not read as success.
		// SLATE_ARMED climbs from PENDING only, so its WHERE is `["PENDING"]`.
		const harness = setup(runningRow);
		await fireSlate(harness);
		const entries = harness.row.stepLog as StepLogEntry[];
		expect(
			entries.filter((e) => e.kind === "SLATE_CONFIRMED").pop(),
		).toMatchObject({ status: "DONE" });
		expect(outcomeWrites(harness.liveSchedule)).toEqual([
			{
				where: { id: SCHEDULE_ID, outcome: { in: ["PENDING"] } },
				data: expect.objectContaining({ outcome: "SLATE_ARMED" }),
			},
		]);
	});

	it("the POST record is never DONE on its own — the provider has not answered yet", async () => {
		/**
		 * The audit's literal artefact: `SLATE_INSERTED / DONE` written the
		 * moment the POST returned. The record still lands (the idempotency
		 * guard reads it, and moving it after the wait would let a crashed
		 * attempt suppress the next legitimate cover), but it lands RUNNING.
		 */
		const harness = setup(runningRow);
		await fireSlate(harness);
		const posted = (harness.row.stepLog as StepLogEntry[])
			.filter((e) => e.kind === "SLATE_INSERTED")
			.pop();
		expect(posted?.status).toBe("RUNNING");
		expect(posted?.finishedAt).toBeUndefined();
	});

	it("a provider entry that reached ERROR is SLATE_FAILED and FAILED — the audit's paid run #4", async () => {
		const harness = setup(runningRow, {
			listScheduledInsertableContent: vi.fn(async () => [
				{
					id: "ent-fake-created",
					contentId: CONTENT_ID,
					status: "ERROR",
					// Outside the guard's 5-minute window, so the PRE-post read
					// ignores it and this test is about the poll, not the guard.
					createdAt: "2026-06-11T00:00:00.000Z",
				},
			]),
		});
		await fireSlate(harness);
		const entries = harness.row.stepLog as StepLogEntry[];
		expect(entries.filter((e) => e.kind === "SLATE_CONFIRMED")).toHaveLength(0);
		const failed = entries.filter((e) => e.kind === "SLATE_FAILED").pop();
		expect(failed).toMatchObject({ status: "FAILED" });
		expect(failed?.error).toMatch(/reached ERROR/);
		expect(outcomeWrites(harness.liveSchedule)).toEqual([
			{
				where: {
					id: SCHEDULE_ID,
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
					outcomeNote: expect.stringMatching(/reached ERROR/),
				}),
			},
		]);
	});

	/**
	 * WP-A3 — the provider's REASON for an ERROR entry. The scheduled entry
	 * carries no text; the encoding's status messages do. Three arms, one per
	 * honest answer: the provider's words, no message, unreadable.
	 */
	describe("the provider's reason for an ERROR entry (WP-A3)", () => {
		const erroredEntry = vi.fn(async () => [
			{
				id: "ent-fake-created",
				contentId: CONTENT_ID,
				status: "ERROR",
				createdAt: "2026-06-11T00:00:00.000Z",
			},
		]);

		it("quotes the first ERROR/WARNING dated since the fire in the note, keeps every attributable one on the step log, and logs one line", async () => {
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
			const getEncodingMessages = vi.fn(async () => [
				// An hour-old warning from an earlier insertion: NOT this one's.
				{
					type: "WARNING",
					text: "old warning from another slate",
					date: "2026-06-11T23:00:00.000Z",
				},
				// INFO chatter after the fire: wrong severity.
				{
					type: "INFO",
					text: "Scheduled insertable content",
					date: "2026-06-12T00:00:05.000Z",
				},
				{
					type: "ERROR",
					text: "Insertable content does not match the live stream: frame rate",
					date: "2026-06-12T00:00:21.000Z",
				},
				{
					type: "WARNING",
					text: "Reverting to the live input",
					date: "2026-06-12T00:00:22.000Z",
				},
			]);
			const harness = setup(runningRow, {
				listScheduledInsertableContent: erroredEntry,
				getEncodingMessages,
			});
			await fireSlate(harness);
			expect(getEncodingMessages).toHaveBeenCalledWith("bm-live-enc");
			const failed = (harness.row.stepLog as StepLogEntry[])
				.filter((e) => e.kind === "SLATE_FAILED")
				.pop();
			expect(failed?.error).toContain(
				"provider: Insertable content does not match the live stream: frame rate",
			);
			expect(failed?.payload).toMatchObject({
				providerMessages: [
					{
						type: "ERROR",
						text: "Insertable content does not match the live stream: frame rate",
						date: "2026-06-12T00:00:21.000Z",
					},
					{
						type: "WARNING",
						text: "Reverting to the live input",
						date: "2026-06-12T00:00:22.000Z",
					},
				],
			});
			expect(JSON.stringify(failed?.payload)).not.toContain("old warning");
			expect(JSON.stringify(failed?.payload)).not.toContain(
				"Scheduled insertable",
			);
			expect(outcomeWrites(harness.liveSchedule)).toEqual([
				expect.objectContaining({
					data: expect.objectContaining({
						outcome: "FAILED",
						outcomeNote: expect.stringContaining(
							"provider: Insertable content does not match the live stream: frame rate",
						),
					}),
				}),
			]);
			const line = warn.mock.calls
				.map((call) => String(call[0]))
				.find((text) => text.includes("reached ERROR"));
			expect(line).toContain(`schedule ${SCHEDULE_ID}`);
			expect(line).toContain("provider entry ent-fake-created");
			expect(line).toContain(
				"provider: Insertable content does not match the live stream: frame rate",
			);
			warn.mockRestore();
		});

		it("says so when the provider reported no message", async () => {
			const harness = setup(runningRow, {
				listScheduledInsertableContent: erroredEntry,
				getEncodingMessages: vi.fn(async () => []),
			});
			await fireSlate(harness);
			const failed = (harness.row.stepLog as StepLogEntry[])
				.filter((e) => e.kind === "SLATE_FAILED")
				.pop();
			expect(failed?.error).toMatch(/reached ERROR/);
			expect(failed?.error).toContain("provider reported no message");
			expect(failed?.payload).not.toHaveProperty("providerMessages");
			expect(outcomeWrites(harness.liveSchedule)[0]?.data).toMatchObject({
				outcome: "FAILED",
				outcomeNote: expect.stringContaining("provider reported no message"),
			});
		});

		it("says why when the messages could not be read — the verdict is still FAILED", async () => {
			const harness = setup(runningRow, {
				listScheduledInsertableContent: erroredEntry,
				getEncodingMessages: vi.fn(async () => {
					throw new Error("status read timed out");
				}),
			});
			await fireSlate(harness);
			const failed = (harness.row.stepLog as StepLogEntry[])
				.filter((e) => e.kind === "SLATE_FAILED")
				.pop();
			expect(failed).toMatchObject({ status: "FAILED" });
			expect(failed?.error).toContain(
				"provider messages could not be read: status read timed out",
			);
			expect(outcomeWrites(harness.liveSchedule)[0]?.data).toMatchObject({
				outcome: "FAILED",
			});
		});

		it("a CONFIRMED entry never reads the messages", async () => {
			const getEncodingMessages = vi.fn(async () => []);
			const harness = setup(runningRow, { getEncodingMessages });
			await fireSlate(harness);
			expect(getEncodingMessages).not.toHaveBeenCalled();
		});

		/**
		 * Connecting the failure to the check that never ran: a slate whose
		 * compatibility preflight stood down carries `preflight UNVERIFIED (…)`
		 * on its schedule row (worker-registered) or on the provider content's
		 * description (route-registered). Either is named in the verdict.
		 */
		it("names a stood-down preflight recorded on the schedule row", async () => {
			const harness = setup(runningRow, {
				listScheduledInsertableContent: erroredEntry,
			});
			harness.liveSchedule.findUnique.mockImplementation(async () => ({
				fireAt: new Date("2026-06-12T00:00:00Z"),
				feederSessionId: null,
				status: "FIRED",
				note: "slate content registered (c1); preflight UNVERIFIED (no ingest reference)",
			}));
			await fireSlate(harness);
			const failed = (harness.row.stepLog as StepLogEntry[])
				.filter((e) => e.kind === "SLATE_FAILED")
				.pop();
			expect(failed?.error).toContain(
				"preflight UNVERIFIED (no ingest reference) — the compatibility check stood down",
			);
			expect(outcomeWrites(harness.liveSchedule)[0]?.data).toMatchObject({
				outcome: "FAILED",
				outcomeNote: expect.stringContaining(
					"preflight UNVERIFIED (no ingest reference)",
				),
			});
		});

		it("names a stood-down preflight recorded on the provider content's description", async () => {
			const harness = setup(runningRow, {
				listScheduledInsertableContent: erroredEntry,
				listLiveInsertableContent: vi.fn(async () => [
					{
						id: CONTENT_ID,
						name: "brb",
						status: "READY",
						description:
							"preflight UNVERIFIED (NO_CREDENTIAL): no vaulted storage credential can read in/brb.mp4, so the clip was not probed",
					},
				]),
			});
			await fireSlate(harness);
			const failed = (harness.row.stepLog as StepLogEntry[])
				.filter((e) => e.kind === "SLATE_FAILED")
				.pop();
			expect(failed?.error).toContain("preflight UNVERIFIED (NO_CREDENTIAL)");
		});

		it("says nothing about the preflight when the slate was verified", async () => {
			const harness = setup(runningRow, {
				listScheduledInsertableContent: erroredEntry,
				listLiveInsertableContent: vi.fn(async () => [
					{ id: CONTENT_ID, name: "brb", status: "READY", description: null },
				]),
			});
			await fireSlate(harness);
			const failed = (harness.row.stepLog as StepLogEntry[])
				.filter((e) => e.kind === "SLATE_FAILED")
				.pop();
			expect(failed?.error).toMatch(/reached ERROR/);
			expect(failed?.error).not.toContain("preflight UNVERIFIED");
		});
	});

	it("an entry still CREATED when the deadline passes is UNCONFIRMED — never DONE", async () => {
		/**
		 * The third value exists because "we could not find out" is not
		 * "it failed". The row goes UNKNOWN, the step goes FAILED with the
		 * reason, and nothing anywhere reads as a delivered slate insertion.
		 */
		const list = vi.fn(async () => [
			{
				id: "ent-fake-created",
				contentId: CONTENT_ID,
				status: "CREATED",
				createdAt: "2026-06-11T00:00:00.000Z",
			},
		]);
		const harness = setup(runningRow, {
			listScheduledInsertableContent: list,
		});
		await fireSlate(harness);
		const entries = harness.row.stepLog as StepLogEntry[];
		expect(entries.filter((e) => e.kind === "SLATE_CONFIRMED")).toHaveLength(0);
		const unconfirmed = entries
			.filter((e) => e.kind === "SLATE_UNCONFIRMED")
			.pop();
		expect(unconfirmed).toMatchObject({ status: "FAILED" });
		expect(unconfirmed?.error).toMatch(/still CREATED/);
		expect(outcomeWrites(harness.liveSchedule)).toEqual([
			{
				where: { id: SCHEDULE_ID, outcome: { in: ["PENDING"] } },
				data: expect.objectContaining({ outcome: "UNKNOWN" }),
			},
		]);
		// It POLLED rather than giving up after the guard's single read: one
		// pre-POST read plus SLATE_CONFIRM_ATTEMPTS.
		expect(list.mock.calls.length).toBeGreaterThan(2);
	});

	it("a POST that returns no id cannot be confirmed at all — UNKNOWN, and no poll", async () => {
		const list = vi.fn(async () => []);
		const harness = setup(runningRow, {
			scheduleInsertableContent: vi.fn(async () => null),
			listScheduledInsertableContent: list,
		});
		await fireSlate(harness);
		expect(
			(harness.row.stepLog as StepLogEntry[])
				.filter((e) => e.kind === "SLATE_UNCONFIRMED")
				.pop()?.error,
		).toMatch(/returned no id/);
		// One read only — the guard's. There is nothing to ask about.
		expect(list).toHaveBeenCalledTimes(1);
	});

	it("a CONFIRMED stop marks its scheduled STOP row DELIVERED", async () => {
		// The harness default reports RUNNING forever (it is AWAIT_LIVE_RUNNING's
		// steady state), which is the UNCONFIRMED arm below — an OBSERVED
		// terminal encoding is what makes a stop confirmed.
		const harness = setup(runningRow, {
			getEncodingStatus: async () => ({ status: "FINISHED" }) as never,
		});
		await harness.process({ liveChannelId: CHANNEL_ID, action: "stop" });
		expect(outcomeWrites(harness.liveSchedule)).toEqual([
			{
				where: {
					liveChannelId: CHANNEL_ID,
					action: "STOP",
					status: "FIRED",
					outcome: {
						in: [
							"PENDING",
							"PROCESS_PUSHING",
							"INGEST_CONNECTED",
							"SLATE_ARMED",
						],
					},
				},
				data: expect.objectContaining({
					outcome: "DELIVERED",
					outcomeNote: null,
				}),
			},
		]);
	});

	it("an UNCONFIRMED stop is UNKNOWN, not DELIVERED — the encoder may still be billing", async () => {
		const harness = setup(runningRow, {
			getEncodingStatus: async () => ({ status: "RUNNING" }) as never,
		});
		await harness.process({ liveChannelId: CHANNEL_ID, action: "stop" });
		expect(outcomeWrites(harness.liveSchedule)).toEqual([
			expect.objectContaining({
				data: expect.objectContaining({
					outcome: "UNKNOWN",
					outcomeNote: expect.stringMatching(/stop did not confirm/),
				}),
			}),
		]);
	});

	it("a stop rejected after send is AMBIGUOUS and leaves schedule evidence fail-closed", async () => {
		const harness = setup(runningRow, {
			stopLiveEncoding: vi.fn(async () => {
				throw new Error("409 the encoding cannot be stopped");
			}),
		});
		const result = await harness.process({
			liveChannelId: CHANNEL_ID,
			action: "stop",
		});
		expect(result).toMatchObject({ status: "EFFECT_AMBIGUOUS" });
		expect(liveEffectMocks.markAmbiguous).toHaveBeenCalledOnce();
		expect(outcomeWrites(harness.liveSchedule)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					data: expect.objectContaining({
						outcome: "UNKNOWN",
						outcomeNote: expect.stringMatching(/cannot be stopped/),
					}),
				}),
			]),
		);
	});

	it("a provision that reaches RUNNING marks the channel's FIRED START row DELIVERED", async () => {
		/**
		 * review-350 HIGH-2: plain START is the commonest scheduled action and
		 * was the one with NO outcome writer, so the panel — correctly reading
		 * the outcome — rendered every successful scheduled start permanently
		 * amber.
		 */
		const harness = setup();
		await harness.process({ liveChannelId: CHANNEL_ID });
		expect(outcomeWrites(harness.liveSchedule)).toEqual([
			{
				where: {
					liveChannelId: CHANNEL_ID,
					action: "START",
					status: "FIRED",
					outcome: {
						in: [
							"PENDING",
							"PROCESS_PUSHING",
							"INGEST_CONNECTED",
							"SLATE_ARMED",
						],
					},
				},
				data: expect.objectContaining({ outcome: "DELIVERED" }),
			},
		]);
	});

	it("a provision that ends in ERROR marks that row FAILED, with the reason", async () => {
		const harness = setup(
			{},
			{
				createEncoding: vi.fn(() =>
					Promise.reject(new Error("region rejected")),
				),
			},
		);
		await expect(
			harness.process({ liveChannelId: CHANNEL_ID }),
		).rejects.toThrow("region rejected");
		expect(outcomeWrites(harness.liveSchedule)).toEqual([
			{
				where: {
					liveChannelId: CHANNEL_ID,
					action: "START",
					status: "FIRED",
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
					outcomeNote: "region rejected",
				}),
			},
		]);
	});

	it("a provision that LOST the lease writes no verdict — the winner answers for the row", async () => {
		/**
		 * `provision` returns PROVISIONING when another worker holds the
		 * lease. Writing DELIVERED or FAILED from the loser would be exactly
		 * the unfenced write  removed everywhere else.
		 */
		const harness = setup({
			status: "PROVISIONING",
			// A lease renewed a moment ago: this job cannot claim the row.
			provisionClaimedAt: new Date("2026-06-12T00:00:00.000Z"),
		});
		const result = await harness.process({ liveChannelId: CHANNEL_ID });
		expect(result).toMatchObject({ status: "PROVISIONING" });
		expect(outcomeWrites(harness.liveSchedule)).toEqual([]);
	});

	it("a scheduled feeder start BINDS its session to the row — the reverse lookup the outcome writers use", async () => {
		const rtmpPlan = structuredClone(basePlan) as unknown as {
			liveInput: unknown;
		};
		rtmpPlan.liveInput = { key: "main", kind: "RTMP" };
		const harness = setup({
			...runningRow,
			plan: rtmpPlan,
			streamKey: "sched-key",
			encoderIp: "203.0.113.9",
		});
		await harness.process({
			liveChannelId: CHANNEL_ID,
			action: "feeder-start",
			params: {
				scheduleId: SCHEDULE_ID,
				source: {
					credentialId: "00000000-0000-4000-8000-0000000000c1",
					bucket: "media",
					key: "loops/source.mp4",
				},
			},
		});
		expect(harness.liveSchedule.updateMany).toHaveBeenCalledWith({
			// rev367 I-3: the bind is a CAS on the row still being FIRED.
			where: { id: SCHEDULE_ID, status: "FIRED" },
			data: {
				note: "feeder session fs-sched-1 started",
				feederSessionId: "fs-sched-1",
			},
		});
	});
});

describe("heartbeat polling", () => {
	function sample(
		counters: Partial<Record<string, number>>,
	): LiveHeartbeatSample {
		return {
			timestamp: "2026-06-12T00:00:00Z",
			ingest: { status: "CONNECTED", healthy: true, ...counters },
			// The SDK's delivery-side half  — in every sample so
			// the capture pin reads the same shape real polls produce.
			output: {
				manifests: { updatedManifests: 2 },
				segments: { writtenSegments: 42 },
			},
			events: [],
		};
	}

	it("computes deltas against the previous cumulative sample", () => {
		expect(
			computeHeartbeatDeltas(
				sample({ droppedPacketsVideo: 10, corruptPacketsAudio: 2 }),
				sample({ droppedPacketsVideo: 25, corruptPacketsAudio: 2 }),
			),
		).toEqual({ droppedPacketsVideo: 15, corruptPacketsAudio: 0 });
	});

	it("yields zero deltas on the first poll and restart-relative on resets", () => {
		// No previous sample → no observed interval; the lifetime cumulative
		// must NOT masquerade as a per-poll spike (it stays visible in raw).
		expect(
			computeHeartbeatDeltas(undefined, sample({ droppedPacketsVideo: 7 })),
		).toEqual({ droppedPacketsVideo: 0 });
		// current < previous → the encoder restarted and reset its counters.
		expect(
			computeHeartbeatDeltas(
				sample({ droppedPacketsVideo: 500 }),
				sample({ droppedPacketsVideo: 4 }),
			),
		).toEqual({ droppedPacketsVideo: 4 });
	});

	it("persists { at, raw, deltas } and deltas against the stored sample", async () => {
		const previous: PersistedHeartbeat = {
			at: "2026-06-11T23:59:30.000Z",
			raw: sample({ droppedPacketsVideo: 10, droppedPacketsAudio: 1 }),
			deltas: { droppedPacketsVideo: 10, droppedPacketsAudio: 1 },
		};
		const { actions, row } = setup(
			{
				status: "RUNNING",
				bitmovinAccountId: ACCOUNT_ID,
				bitmovinEncodingId: "bm-live-enc",
				lastHeartbeat: previous,
			},
			{
				getLiveHeartbeat: vi.fn(() =>
					Promise.resolve(
						sample({ droppedPacketsVideo: 30, droppedPacketsAudio: 1 }),
					),
				),
			},
		);
		const persisted = await actions.pollHeartbeat(CHANNEL_ID);
		expect(persisted.at).toBe("2026-06-12T00:00:00.000Z");
		expect(persisted.raw.ingest?.droppedPacketsVideo).toBe(30);
		// : the SDK's fourth field — delivery-side health — must
		// survive to the stored sample. The raw round-trip always carried
		// it; the TYPE dropped it, so typed readers were blind to the
		// output half while ingest was fully modelled.
		expect(persisted.raw.output?.manifests).toEqual({ updatedManifests: 2 });
		expect(persisted.raw.output?.segments).toEqual({ writtenSegments: 42 });
		expect(persisted.deltas).toEqual({
			droppedPacketsVideo: 20,
			droppedPacketsAudio: 0,
		});
		expect(row.lastHeartbeat).toMatchObject({
			at: "2026-06-12T00:00:00.000Z",
			raw: { ingest: { droppedPacketsVideo: 30 } },
			deltas: { droppedPacketsVideo: 20 },
		});
		// review-224 C1: the #95 fire-gate predicate must read THIS — the
		// writer's actual persisted bytes, not a shape a fixture imagined.
		// The first cut read `sample.ingest` (a level the writer never
		// emits), was constant-false, and shipped all three #95 fixes
		// inverted under green tests. This assertion couples the predicate
		// to the single production writer for good.
		expect(ingestConnectedFromHeartbeat(row.lastHeartbeat)).toBe(true);
		// : same coupling for the dashboard's staleness parser —
		// its first cut read `observedAt`, a key these bytes never carry.
		expect(persistedHeartbeatAtMs(row.lastHeartbeat)).toBe(
			Date.parse("2026-06-12T00:00:00.000Z"),
		);
	});

	it("timestamps a heartbeat at probe start so a pre-spawn request cannot become post-spawn evidence when it returns", async () => {
		let resolveHeartbeat: ((sample: LiveHeartbeatSample) => void) | undefined;
		let clock = "2026-06-12T00:00:00.000Z";
		const { actions, deps, sdk } = setup(
			{
				status: "RUNNING",
				bitmovinAccountId: ACCOUNT_ID,
				bitmovinEncodingId: "bm-live-enc",
			},
			{
				getLiveHeartbeat: vi.fn(
					() =>
						new Promise<LiveHeartbeatSample>((resolve) => {
							resolveHeartbeat = resolve;
						}),
				),
			},
		);
		deps.now = () => clock;

		const pending = actions.pollHeartbeat(CHANNEL_ID);
		await vi.waitFor(() =>
			expect(sdk.getLiveHeartbeat).toHaveBeenCalledTimes(1),
		);
		// A feeder process spawns while this old provider request is in flight.
		clock = "2026-06-12T00:00:01.000Z";
		resolveHeartbeat?.(sample({ droppedPacketsVideo: 1 }));

		const persisted = await pending;
		expect(persisted.at).toBe("2026-06-12T00:00:00.000Z");
	});

	it("appends a LiveHeartbeat history row AND prunes rows past the retention window", async () => {
		const { actions, liveHeartbeat } = setup(
			{
				status: "RUNNING",
				bitmovinAccountId: ACCOUNT_ID,
				bitmovinEncodingId: "bm-live-enc",
			},
			{
				getLiveHeartbeat: vi.fn(() =>
					Promise.resolve(sample({ droppedPacketsVideo: 5 })),
				),
			},
		);
		await actions.pollHeartbeat(CHANNEL_ID);
		// Insert the sample (redacted { at, raw, deltas }) into the time-series.
		expect(liveHeartbeat.create).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					liveChannelId: CHANNEL_ID,
					at: new Date("2026-06-12T00:00:00.000Z"),
					raw: expect.objectContaining({
						ingest: expect.objectContaining({ droppedPacketsVideo: 5 }),
					}),
					deltas: expect.objectContaining({ droppedPacketsVideo: 0 }),
				}),
			}),
		);
		// Prune everything older than now − retention (cutoff is exact): the
		// stale rows are read by id through the (liveChannelId, at) index in a
		// capped, oldest-first batch, then deleted by id.
		const cutoff = new Date(
			Date.parse("2026-06-12T00:00:00.000Z") - HEARTBEAT_RETENTION_MS,
		);
		expect(liveHeartbeat.findMany).toHaveBeenCalledWith({
			where: { liveChannelId: CHANNEL_ID, at: { lt: cutoff } },
			orderBy: { at: "asc" },
			take: HEARTBEAT_PRUNE_BATCH,
			select: { id: true },
		});
		expect(liveHeartbeat.deleteMany).toHaveBeenCalledWith({
			where: { id: { in: ["hb-stale-1", "hb-stale-2"] } },
		});
	});

	it("the retention window is 7 days — a run page must answer for yesterday's broadcast", () => {
		expect(HEARTBEAT_RETENTION_MS).toBe(7 * 24 * 60 * 60 * 1000);
	});

	it("honours an overridden retention window for the prune cutoff", async () => {
		const { actions, deps, liveHeartbeat } = setup({
			status: "RUNNING",
			bitmovinAccountId: ACCOUNT_ID,
			bitmovinEncodingId: "bm-live-enc",
		});
		deps.heartbeatRetentionMs = 60_000; // 1 minute
		await actions.pollHeartbeat(CHANNEL_ID);
		const cutoff = new Date(Date.parse("2026-06-12T00:00:00.000Z") - 60_000);
		expect(liveHeartbeat.findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { liveChannelId: CHANNEL_ID, at: { lt: cutoff } },
			}),
		);
	});

	it("nothing past the cutoff ⇒ no DELETE statement at all", async () => {
		const { actions, liveHeartbeat } = setup({
			status: "RUNNING",
			bitmovinAccountId: ACCOUNT_ID,
			bitmovinEncodingId: "bm-live-enc",
		});
		liveHeartbeat.findMany.mockResolvedValueOnce([]);
		await actions.pollHeartbeat(CHANNEL_ID);
		expect(liveHeartbeat.deleteMany).not.toHaveBeenCalled();
	});

	it("logs ONE line per heartbeat state change against the previously persisted sample — and none on an unchanged poll", async () => {
		const info = vi.spyOn(console, "info").mockImplementation(() => {});
		try {
			const { actions, row, sdk } = setup(
				{
					status: "RUNNING",
					bitmovinAccountId: ACCOUNT_ID,
					bitmovinEncodingId: "bm-live-enc",
					lastHeartbeat: {
						at: "2026-06-11T23:59:30.000Z",
						raw: {
							ingest: { status: "WAITING_FOR_FIRST_CONNECT" },
							events: [],
						},
						deltas: {},
					},
				},
				{
					getLiveHeartbeat: vi.fn(() =>
						Promise.resolve({
							...sample({}),
							events: [
								{
									time: "2026-06-11T23:59:49.000Z",
									details: { eventType: "FIRST_CONNECT", message: null },
								},
							],
						}),
					),
				},
			);
			await actions.pollHeartbeat(CHANNEL_ID);
			expect(info.mock.calls.map((call) => call[0])).toEqual([
				`[live-channel] ${CHANNEL_ID} heartbeat ingest WAITING_FOR_FIRST_CONNECT → CONNECTED`,
				`[live-channel] ${CHANNEL_ID} heartbeat event FIRST_CONNECT @2026-06-11T23:59:49.000Z`,
			]);
			// The column now carries the CONNECTED sample; the same sample again
			// is not a change.
			expect(row.lastHeartbeat).toMatchObject({
				raw: { ingest: { status: "CONNECTED" } },
			});
			info.mockClear();
			await actions.pollHeartbeat(CHANNEL_ID);
			expect(sdk.getLiveHeartbeat).toHaveBeenCalledTimes(2);
			expect(info).not.toHaveBeenCalled();
		} finally {
			info.mockRestore();
		}
	});

	it("a history-write failure never breaks the lastHeartbeat update or the poll", async () => {
		const { actions, row, liveHeartbeat } = setup(
			{
				status: "RUNNING",
				bitmovinAccountId: ACCOUNT_ID,
				bitmovinEncodingId: "bm-live-enc",
			},
			{
				getLiveHeartbeat: vi.fn(() =>
					Promise.resolve(sample({ droppedPacketsVideo: 9 })),
				),
			},
		);
		liveHeartbeat.create.mockRejectedValueOnce(new Error("relation missing"));
		// The poll resolves and lastHeartbeat is still written despite the
		// time-series insert throwing (best-effort, after the column update).
		const persisted = await actions.pollHeartbeat(CHANNEL_ID);
		expect(persisted.raw.ingest?.droppedPacketsVideo).toBe(9);
		expect(row.lastHeartbeat).toMatchObject({
			raw: { ingest: { droppedPacketsVideo: 9 } },
		});
	});

	it("a fenced history-write failure fails the sweep without publishing a partial sample", async () => {
		const { sweep, liveHeartbeat } = setup({
			status: "RUNNING",
			bitmovinAccountId: ACCOUNT_ID,
			bitmovinEncodingId: "bm-live-enc",
		});
		liveHeartbeat.create.mockRejectedValueOnce(new Error("relation missing"));
		// A sweep sample is one fenced evidence tuple: run projection, channel
		// projection and history. Publishing only two of the three would let the
		// current-state panel disagree with its trend/evidence record.
		await expect(sweep()).resolves.toEqual({ polled: 0, failed: 1 });
	});

	it("sweeps RUNNING channels and isolates per-channel failures", async () => {
		const { sweep } = setup(
			{
				status: "RUNNING",
				bitmovinAccountId: ACCOUNT_ID,
				bitmovinEncodingId: "bm-live-enc",
			},
			{
				getLiveHeartbeat: vi.fn(() =>
					Promise.reject(new Error("heartbeat 404")),
				),
			},
		);
		await expect(sweep()).resolves.toEqual({ polled: 0, failed: 1 });
	});
});

describe("heartbeat sweep — concurrency, timeout, no-overlap", () => {
	const okRaw: LiveHeartbeatSample = {
		timestamp: "2026-06-12T00:00:00Z",
		ingest: { status: "CONNECTED", healthy: true },
		output: {
			manifests: { updatedManifests: 0 },
			segments: { writtenSegments: 0 },
		},
		events: [],
	};

	it("WIRING: a hung getLiveHeartbeat is abandoned at the per-channel deadline — the sweep completes instead of hanging", async () => {
		vi.useFakeTimers();
		try {
			const t = setup({
				status: "RUNNING",
				bitmovinAccountId: ACCOUNT_ID,
				bitmovinEncodingId: "bm-live-enc",
			});
			// The poll never settles — the exact hung-channel shape MODERATE-1
			// is about. Without the deadline the whole sweep would hang here.
			vi.mocked(t.sdk.getLiveHeartbeat).mockImplementation(
				() => new Promise<LiveHeartbeatSample>(() => {}),
			);
			const sweep = createLiveHeartbeatSweep({
				...t.deps,
				perChannelTimeoutMs: 5_000,
				sweepConcurrency: 2,
			});
			const done = sweep();
			let settled = false;
			void done.then(() => {
				settled = true;
			});
			// Still inside the budget: the sweep is genuinely WAITING on the poll,
			// not silently skipping the channel.
			await vi.advanceTimersByTimeAsync(4_999);
			expect(settled).toBe(false);
			// Past the deadline: the channel is abandoned and the sweep finishes.
			await vi.advanceTimersByTimeAsync(2);
			await expect(done).resolves.toEqual({ polled: 0, failed: 1 });
		} finally {
			vi.useRealTimers();
		}
	});

	it("WIRING: an overlapping sweep tick is skipped while one is in flight (single-flight guard applied)", async () => {
		const t = setup({
			status: "RUNNING",
			bitmovinAccountId: ACCOUNT_ID,
			bitmovinEncodingId: "bm-live-enc",
		});
		// One event-loop turn flushes the WHOLE sweep→poll chain (findMany,
		// loadChannel, reveal, makeSdk) — more reliable than counting microtask
		// hops, since the chain queues new microtasks as it runs.
		const macroFlush = () => new Promise<void>((r) => setTimeout(r, 0));
		let pollCount = 0;
		let releasePoll: ((raw: LiveHeartbeatSample) => void) | undefined;
		vi.mocked(t.sdk.getLiveHeartbeat).mockImplementation(() => {
			pollCount += 1;
			return new Promise<LiveHeartbeatSample>((resolve) => {
				releasePoll = resolve;
			});
		});
		const sweep = createLiveHeartbeatSweep({
			...t.deps,
			perChannelTimeoutMs: 60_000,
			sweepConcurrency: 2,
		});
		const first = sweep(); // enters the sweep, hangs on the poll
		await macroFlush();
		expect(pollCount).toBe(1);
		// Overlapping tick, exactly what the 30s repeat scheduler produces on a
		// fleet whose sweep runs long.
		const secondP = sweep();
		await macroFlush();
		// A removed guard would have entered the sweep and polled a SECOND time
		// (pollCount 2) — a clean assertion failure here, never a hang.
		expect(pollCount).toBe(1);
		await expect(secondP).resolves.toEqual({
			polled: 0,
			failed: 0,
			skipped: true,
		});
		// Release the first poll so it drains cleanly to completion.
		releasePoll?.(okRaw);
		await expect(first).resolves.toEqual({ polled: 1, failed: 0 });
	});

	it("WIRING: a hung channel is timed out while the OTHER channel is polled and alerted within the tick", async () => {
		vi.useFakeTimers();
		try {
			const t = setup({
				status: "RUNNING",
				bitmovinAccountId: ACCOUNT_ID,
				bitmovinEncodingId: "enc-hung",
			});
			t.runRows.length = 0;
			const HUNG = CHANNEL_ID;
			const OK = "00000000-0000-4000-8000-0000000000cc";
			t.liveChannel.findMany.mockResolvedValue([
				{
					id: HUNG,
					updatedAt: new Date("2026-06-11T23:59:30.000Z"),
					programStartAt: null,
					programEndAt: null,
					purpose: null,
				},
				{
					id: OK,
					updatedAt: new Date("2026-06-11T23:59:30.000Z"),
					programStartAt: null,
					programEndAt: null,
					purpose: null,
				},
			] as unknown as Awaited<ReturnType<typeof t.liveChannel.findMany>>);
			t.liveChannel.findUnique.mockImplementation(
				(async ({ where }: { where: { id: string } }) =>
					({
						id: where.id,
						status: "RUNNING",
						bitmovinAccountId: ACCOUNT_ID,
						bitmovinEncodingId: where.id === HUNG ? "enc-hung" : "enc-ok",
						plan: t.row.plan,
						lastHeartbeat: null,
					}) as unknown as typeof t.row) as typeof t.liveChannel.findUnique,
			);
			// HUNG never settles; OK resolves immediately.
			vi.mocked(t.sdk.getLiveHeartbeat).mockImplementation((encodingId) =>
				encodingId === "enc-hung"
					? new Promise<LiveHeartbeatSample>(() => {})
					: Promise.resolve(okRaw),
			);
			// `_id: string` types the recorded call tuple so `c[0]` below is the
			// channel id the sweep passed (its actual first arg).
			const alertEngine = vi.fn((_id: string) =>
				Promise.resolve({ opened: 0, resolved: 0 }),
			);
			const sweep = createLiveHeartbeatSweep({
				...t.deps,
				alertEngine,
				perChannelTimeoutMs: 5_000,
				sweepConcurrency: 2,
			});
			const result = sweep();
			// Trip the hung channel's deadline; the OK channel resolved on its own
			// microtasks well before this.
			await vi.advanceTimersByTimeAsync(5_000);
			await expect(result).resolves.toEqual({ polled: 1, failed: 1 });
			// OK was fully evaluated; HUNG was abandoned BEFORE its alert step.
			const okCalls = alertEngine.mock.calls.filter((c) => c[0] === OK);
			const hungCalls = alertEngine.mock.calls.filter((c) => c[0] === HUNG);
			expect(okCalls).toHaveLength(1);
			expect(hungCalls).toHaveLength(0);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("live-to-VOD", () => {
	function claimStoppedChannel(
		t: ReturnType<typeof setup>,
		attemptId = nextLiveToVodAttemptId(),
	): void {
		const entries = stepLogSchema.parse(t.row.stepLog);
		const support = liveToVodFamilySupport(entries);
		const claim = liveToVodClaim({
			existing: normalizeLiveToVodRecord(t.row.liveToVod),
			requested: support.supported,
			explicit: false,
			support,
			requestedAt: "2026-06-12T00:00:00.000Z",
			attemptId,
			queueJobId: `${CHANNEL_ID}-live-to-vod-${attemptId}`,
			liveChannelRunId: LIVE_TO_VOD_RUN_ID,
			outputKey: "origin",
		});
		t.row.liveToVod = claim;
		const existingRun = t.runRows.find((run) => run.id === LIVE_TO_VOD_RUN_ID);
		if (existingRun) {
			existingRun.liveToVod = structuredClone(claim);
			existingRun.bitmovinEncodingId = "bm-live-enc";
			existingRun.liveChannelId = CHANNEL_ID;
			return;
		}
		t.runRows.push({
			id: LIVE_TO_VOD_RUN_ID,
			seq: 1,
			status: "STOPPED",
			liveChannelId: CHANNEL_ID,
			bitmovinEncodingId: "bm-live-enc",
			liveToVod: structuredClone(claim),
		});
	}

	/** A provisioned+stopped channel: encoding id, DONE output step. */
	function stoppedChannel(sdkOverrides: Partial<SdkOps> = {}) {
		const t = setup({}, sdkOverrides);
		const entries = t.row.stepLog as {
			step: string;
			status: string;
			resourceId?: string;
		}[];
		for (const entry of entries) {
			entry.status = "DONE";
			if (entry.step === "output:origin") {
				entry.resourceId = "bm-output-origin";
			}
		}
		t.row.status = "STOPPED";
		t.row.bitmovinEncodingId = "bm-live-enc";
		t.row.bitmovinAccountId = ACCOUNT_ID;
		claimStoppedChannel(t);
		return t;
	}

	/**
	 * The 2701 population, read the way the worker reads it: the muxing
	 * destination paths this channel's step log RECORDS. Derived rather than
	 * transcribed, so a fixture whose paths change cannot leave these
	 * assertions agreeing with a world that no longer exists.
	 */
	function recordedMuxingPaths(row: Row): string[] {
		return (row.stepLog as StepLogEntry[])
			.filter((entry) => entry.kind.startsWith("CREATE_MUXING_"))
			.map((entry) => String(entry.payload.outputPath));
	}

	/** `<path>/<manifestName>` for every manifest the LIVE plan itself writes. */
	function liveManifestFiles(row: Row): string[] {
		return (row.stepLog as StepLogEntry[])
			.filter((entry) => entry.kind.startsWith("CREATE_MANIFEST_"))
			.map(
				(entry) =>
					`${String(entry.payload.outputPath)}/${String(entry.payload.manifestName)}`,
			);
	}

	function finishedManifests(): Partial<SdkOps> {
		return {
			createDefaultHlsManifest: vi.fn(() => Promise.resolve("bm-vod-hls")),
			createDefaultDashManifest: vi.fn(() => Promise.resolve("bm-vod-dash")),
			getHlsManifestStatus: vi.fn(() =>
				Promise.resolve({ status: "FINISHED" }),
			),
			getDashManifestStatus: vi.fn(() =>
				Promise.resolve({ status: "FINISHED" }),
			),
		};
	}

	function cleanupSnapshots(
		t: ReturnType<typeof stoppedChannel>,
		family: "HLS" | "DASH",
	): Array<Record<string, unknown>> {
		return t.updates.flatMap((update) => {
			const record = normalizeLiveToVodRecord(update.liveToVod);
			const entry = record?.families?.find(
				(candidate) => candidate.type === family,
			);
			return entry && "cleanup" in entry && entry.cleanup
				? [entry.cleanup as Record<string, unknown>]
				: [];
		});
	}

	/**
	 *  — the provider-side ledger: every default manifest a create
	 * RETURNED, minus every one deleted. "Orphan/duplicate 0" is asserted as
	 * `aliveManifests(t)` set-equal to the ids the record accounts for — a
	 * manifest alive at the provider that no record names is an orphan, and a
	 * second id for one family is a duplicate; both fail that equality.
	 */
	async function aliveManifests(
		t: ReturnType<typeof stoppedChannel>,
	): Promise<string[]> {
		const created: string[] = [];
		for (const create of [
			t.sdk.createDefaultHlsManifest,
			t.sdk.createDefaultDashManifest,
		]) {
			for (const result of vi.mocked(create).mock.settledResults) {
				if (result.type === "fulfilled") {
					created.push(result.value);
				}
			}
		}
		const deleted = [
			...vi.mocked(t.sdk.deleteHlsManifest).mock.calls,
			...vi.mocked(t.sdk.deleteDashManifest).mock.calls,
		].map((call) => call[0]);
		return created.filter((id) => !deleted.includes(id));
	}

	/** The ids the record names — every family that holds one, whatever its status. */
	function recordedManifestIds(t: ReturnType<typeof stoppedChannel>): string[] {
		const record = normalizeLiveToVodRecord(t.row.liveToVod);
		return (record?.families ?? []).flatMap((f) =>
			"manifestId" in f && f.manifestId !== undefined ? [f.manifestId] : [],
		);
	}

	/**
	 * What the ROUTE does on a re-submit: claim RUNNING again, carrying a
	 * PARTIAL/ERROR record's families forward (`liveToVodClaim`). Modelled here
	 * verbatim so the worker's retry arms start from the claim the route
	 * really writes, not from a hand-shaped record.
	 */
	function resubmitThroughRoute(
		t: ReturnType<typeof stoppedChannel>,
		manifests?: ("HLS" | "DASH")[],
	): void {
		const entries = stepLogSchema.parse(t.row.stepLog);
		const support = liveToVodFamilySupport(entries);
		t.row.liveToVod = liveToVodClaim({
			existing: normalizeLiveToVodRecord(t.row.liveToVod),
			requested: manifests ?? support.supported,
			explicit: manifests !== undefined,
			support,
			requestedAt: "2026-06-12T00:05:00.000Z",
			attemptId: nextLiveToVodAttemptId(),
			queueJobId: `${CHANNEL_ID}-live-to-vod-retry`,
			liveChannelRunId: LIVE_TO_VOD_RUN_ID,
			outputKey: "origin",
		});
		const run = t.runRows.find(
			(candidate) => candidate.id === LIVE_TO_VOD_RUN_ID,
		);
		if (run) run.liveToVod = structuredClone(t.row.liveToVod);
	}

	/** A provisioned+stopped SEGMENTED-TS channel — the audit's own topology . */
	function stoppedTsChannel(sdkOverrides: Partial<SdkOps> = {}) {
		const plan = liveChannelPlanSchema.parse(
			JSON.parse(
				readFileSync(
					join(
						__dirname,
						"../../../../packages/core/src/live/__fixtures__/live-hls-ts-muxed.plan.json",
					),
					"utf8",
				),
			),
		);
		plan.bitmovin.accountId = ACCOUNT_ID;
		const t = setup(
			{ plan, stepLog: initStepLog(compileLiveChannel(plan)) },
			sdkOverrides,
		);
		const entries = t.row.stepLog as {
			step: string;
			status: string;
			resourceId?: string;
		}[];
		for (const entry of entries) {
			entry.status = "DONE";
			if (entry.step === "output:origin") {
				entry.resourceId = "bm-output-origin";
			}
		}
		t.row.status = "STOPPED";
		t.row.bitmovinEncodingId = "bm-live-enc";
		t.row.bitmovinAccountId = ACCOUNT_ID;
		claimStoppedChannel(t);
		return t;
	}

	it("generates BOTH default manifests over the stopped encoding with LEGACY", async () => {
		const t = stoppedChannel(finishedManifests());
		await t.actions.liveToVod(CHANNEL_ID, {});
		expect(t.sdk.createDefaultHlsManifest).toHaveBeenCalledWith({
			encodingId: "bm-live-enc",
			manifestName: "vod.m3u8",
			name: expect.stringContaining("VOD HLS"),
			destination: {
				outputId: "bm-output-origin",
				outputPath: expect.any(String),
			},
			strictIdentity: true,
			allowCreate: true,
		});
		// C3's single exception: V2 cannot enumerate a live encoding's muxings.
		expect(t.sdk.startHlsManifest).toHaveBeenCalledWith("bm-vod-hls", {
			manifestGenerator: "LEGACY",
		});
		expect(t.sdk.startDashManifest).toHaveBeenCalledWith("bm-vod-dash", {
			manifestGenerator: "LEGACY",
		});
		const record = t.row.liveToVod as {
			status: string;
			manifests: { type: string; manifestId: string; url: string }[];
			finishedAt?: string;
		};
		expect(record.status).toBe("FINISHED");
		expect(record.finishedAt).toBeDefined();
		expect(record.manifests).toEqual([
			{
				type: "HLS",
				manifestId: "bm-vod-hls",
				url: expect.stringContaining(".m3u8"),
			},
			{
				type: "DASH",
				manifestId: "bm-vod-dash",
				url: expect.stringContaining(".mpd"),
			},
		]);
	});

	it("keeps the roll claimed RUNNING until the terminal record is sealed with finishedAt", async () => {
		const t = stoppedChannel(finishedManifests());
		await t.actions.liveToVod(CHANNEL_ID, {});

		const records = t.updates.flatMap((update) => {
			const record = normalizeLiveToVodRecord(update.liveToVod);
			return record === null ? [] : [record];
		});
		const terminal = records.filter((record) => record.status !== "RUNNING");

		// The last family can reach FINISHED before the worker has sealed the roll.
		// Exposing that intermediate snapshot as terminal lets the route accept a
		// second roll while this worker can still perform its final write and clobber
		// the new claim. Terminal is therefore one atomic final snapshot: it carries
		// finishedAt, and no earlier write is externally retryable.
		expect(terminal).toHaveLength(1);
		expect(terminal[0]).toMatchObject({
			status: "FINISHED",
			finishedAt: "2026-06-12T00:00:00.000Z",
		});
	});

	it("honours a manifests filter and an explicit path that is an ANCESTOR of the recording", async () => {
		const t = stoppedChannel(finishedManifests());
		// `output` is above the muxings — the only shape a default manifest
		// may take. `archive/2026/vod`, the value this test used to pass, is
		// refused now; the refusal has its own test below.
		await t.actions.liveToVod(CHANNEL_ID, {
			manifests: ["DASH"],
			path: "output",
		});
		expect(t.sdk.createDefaultHlsManifest).not.toHaveBeenCalled();
		expect(t.sdk.createDefaultDashManifest).toHaveBeenCalledWith(
			expect.objectContaining({
				destination: { outputId: "bm-output-origin", outputPath: "output" },
			}),
		);
		const record = t.row.liveToVod as { manifests: { url: string }[] };
		expect(record.manifests.map((m) => m.url)).toEqual(["output/vod.mpd"]);
	});

	/**
	 * C35 / . A Bitmovin DEFAULT manifest enumerates the encoding's
	 * muxings and writes RELATIVE segment URIs, so its `outputPath` must be a
	 * PARENT of every muxing's — anything else is refused with
	 * `code 2701 … not a sub path`. The old default, `<run outputPrefix>/vod`
	 * (and `<channel name>/vod` before it), was a SIBLING of the muxings, so
	 * every roll died at the first manifest against the real provider.
	 *
	 * The parent property is asserted here with a plain segment-prefix check
	 * rather than by calling core's `isPathParentOf`: a pin that uses the
	 * production predicate to judge the production predicate cannot see it
	 * being wrong.
	 */
	it("puts the default manifest ABOVE every recorded muxing path (C35 / code 2701)", async () => {
		const t = stoppedChannel(finishedManifests());
		const muxings = recordedMuxingPaths(t.row);
		// The fixture must actually exercise the rule: sibling rendition
		// directories under one parent is the shape `<parent>/vod` failed on.
		expect(muxings.length).toBeGreaterThan(1);
		await t.actions.liveToVod(CHANNEL_ID, {});
		for (const create of [
			t.sdk.createDefaultHlsManifest,
			t.sdk.createDefaultDashManifest,
		]) {
			const arg = vi.mocked(create).mock.calls[0]?.[0] as {
				manifestName: string;
				destination: { outputPath: string };
			};
			const path = arg.destination.outputPath;
			for (const muxing of muxings) {
				expect(
					muxing === path || muxing.startsWith(`${path}/`),
					`manifest at "${path}" is not a parent of muxing "${muxing}"`,
				).toBe(true);
			}
			// …and the manifest FILE must not be one the live plan writes.
			expect(liveManifestFiles(t.row)).not.toContain(
				`${path}/${arg.manifestName}`,
			);
		}
		// The defect, stated as the counterfactual: the old default is a
		// sibling of every muxing, never their parent.
		expect(
			muxings.some((m) => m.startsWith("output/live-rtmp-simple/vod/")),
		).toBe(false);
	});

	it("defaults to the plan's own output base for a run at the plan's own paths (pre-#155 prefix)", async () => {
		const t = stoppedChannel(finishedManifests());
		await t.actions.liveToVod(CHANNEL_ID, { manifests: ["DASH"] });
		expect(t.sdk.createDefaultDashManifest).toHaveBeenCalledWith(
			expect.objectContaining({
				destination: {
					outputId: "bm-output-origin",
					outputPath: "output/live-rtmp-simple",
				},
			}),
		);
		const record = t.row.liveToVod as {
			path: string;
			manifests: { url: string }[];
		};
		expect(record.path).toBe("output/live-rtmp-simple");
		expect(record.manifests.map((m) => m.url)).toEqual([
			"output/live-rtmp-simple/vod.mpd",
		]);
	});

	it("keeps a run-scoped recording's VOD asset inside that run's own subtree (ledger #155 isolation survives C35)", async () => {
		const t = stoppedChannel(finishedManifests());
		// The REAL provisioning compile for a re-air, not a hand-typed
		// prefix: seq ≥ 2 rebases every destination into `…/runs/<seq>-<id8>`.
		const { entries, outputPrefix } = compileLiveRunStepLog(
			liveChannelPlanSchema.parse(t.row.plan),
			{ seq: 2, runId: "cafebabe-0000-4000-8000-000000000002" },
		);
		t.row.stepLog = entries.map((entry) => ({
			...entry,
			status: "DONE" as const,
			...(entry.step === "output:origin"
				? { resourceId: "bm-output-origin" }
				: {}),
		}));
		expect(outputPrefix).toBe("output/live-rtmp-simple/runs/2-cafebabe");
		await t.actions.liveToVod(CHANNEL_ID, { manifests: ["HLS"] });
		expect(t.sdk.createDefaultHlsManifest).toHaveBeenCalledWith(
			expect.objectContaining({
				manifestName: "vod.m3u8",
				destination: {
					outputId: "bm-output-origin",
					outputPath: outputPrefix,
				},
			}),
		);
		// Inside the run subtree AND above every one of that run's muxings.
		for (const muxing of recordedMuxingPaths(t.row)) {
			expect(muxing.startsWith(`${outputPrefix}/`)).toBe(true);
		}
	});

	it("refuses an explicit path that is not a parent of the recording, before any manifest is created", async () => {
		const t = stoppedChannel(finishedManifests());
		// The provider is not our validator: this path can ONLY come back as
		// code 2701, so it must never be sent.
		const roll = () =>
			t.actions.liveToVod(CHANNEL_ID, { path: "archive/2026/vod" });
		await expect(roll()).rejects.toThrow(
			/not a parent of the recording's muxing output paths/,
		);
		await expect(roll()).rejects.toThrow(/2701/);
		// It must name the path that WOULD work, not just say no.
		await expect(roll()).rejects.toThrow(/output\/live-rtmp-simple/);
		expect(t.sdk.createDefaultHlsManifest).not.toHaveBeenCalled();
		expect(t.sdk.createDefaultDashManifest).not.toHaveBeenCalled();
	});

	/**
	 * review-357. A FINISHED roll does not block another one — the route's 409
	 * is RUNNING-only — and the second roll derives the SAME path from the same
	 * step log. The previous roll's manifests are nowhere in that step log;
	 * they live in the records, and the run mirror is where they survive the
	 * route's RUNNING claim.
	 */
	it("does not overwrite an earlier roll's manifest when the channel is rolled again", async () => {
		const t = stoppedChannel(finishedManifests());
		t.runRows.push({
			id: "run-1",
			seq: 1,
			status: "STOPPED",
			liveToVod: {
				status: "FINISHED",
				manifests: [
					{
						type: "HLS",
						manifestId: "bm-vod-hls-1",
						url: "output/live-rtmp-simple/vod.m3u8",
					},
				],
			},
		});
		await t.actions.liveToVod(CHANNEL_ID, { manifests: ["HLS"] });
		expect(t.sdk.createDefaultHlsManifest).toHaveBeenCalledWith(
			expect.objectContaining({
				manifestName: "vod-2.m3u8",
				// Same PATH — the muxings did not move. Only the FILE differs.
				destination: {
					outputId: "bm-output-origin",
					outputPath: "output/live-rtmp-simple",
				},
			}),
		);
		const record = t.row.liveToVod as { manifests: { url: string }[] };
		expect(record.manifests.map((m) => m.url)).toEqual([
			"output/live-rtmp-simple/vod-2.m3u8",
		]);
		// And the read happens BEFORE the first save, which replaces the run's
		// record with this roll's RUNNING one — otherwise the set is always empty.
		const readAt = t.liveChannelRun.findMany.mock.invocationCallOrder[0] ?? 0;
		const firstMirror =
			t.liveChannelRun.updateMany.mock.invocationCallOrder[0] ??
			Number.MAX_SAFE_INTEGER;
		expect(readAt).toBeLessThan(firstMirror);
	});

	it("retains the complete filename history across three exact-run claims", async () => {
		const t = stoppedChannel(finishedManifests());
		await t.actions.liveToVod(CHANNEL_ID, { manifests: ["HLS"] });

		// This is the production route seam: the next claim atomically replaces
		// both the channel and exact run record before the worker can read either.
		resubmitThroughRoute(t, ["HLS"]);
		await t.actions.liveToVod(CHANNEL_ID, { manifests: ["HLS"] });
		resubmitThroughRoute(t, ["HLS"]);
		await t.actions.liveToVod(CHANNEL_ID, { manifests: ["HLS"] });

		expect(
			vi
				.mocked(t.sdk.createDefaultHlsManifest)
				.mock.calls.map(([request]) => request.manifestName),
		).toEqual(["vod.m3u8", "vod-2.m3u8", "vod-3.m3u8"]);
		expect((t.row.liveToVod as LiveToVodRecord).manifests).toEqual([
			expect.objectContaining({ url: "output/live-rtmp-simple/vod-3.m3u8" }),
		]);
	});

	it("does not forget an HLS filename when an intervening roll publishes DASH only", async () => {
		const t = stoppedChannel(finishedManifests());
		await t.actions.liveToVod(CHANNEL_ID, { manifests: ["HLS"] });

		resubmitThroughRoute(t, ["DASH"]);
		await t.actions.liveToVod(CHANNEL_ID, { manifests: ["DASH"] });

		resubmitThroughRoute(t, ["HLS"]);
		await t.actions.liveToVod(CHANNEL_ID, { manifests: ["HLS"] });

		expect(
			vi
				.mocked(t.sdk.createDefaultHlsManifest)
				.mock.calls.map(([request]) => request.manifestName),
		).toEqual(["vod.m3u8", "vod-2.m3u8"]);
		expect(
			vi
				.mocked(t.sdk.createDefaultDashManifest)
				.mock.calls.map(([request]) => request.manifestName),
		).toEqual(["vod.mpd"]);
	});

	it("gives the VOD manifest a name no live manifest already owns", async () => {
		const t = stoppedChannel(finishedManifests());
		// Nothing stops an operator naming a LIVE manifest `vod.m3u8`; the VOD
		// roll now writes into the same directory, so a fixed name would
		// overwrite the manifest of the very run it archives.
		const log = t.row.stepLog as StepLogEntry[];
		const hls = log.find((entry) => entry.kind === "CREATE_MANIFEST_HLS");
		if (!hls) {
			throw new Error("fixture has no live HLS manifest to collide with");
		}
		hls.payload = { ...hls.payload, manifestName: "vod.m3u8" };
		await t.actions.liveToVod(CHANNEL_ID, { manifests: ["HLS"] });
		expect(t.sdk.createDefaultHlsManifest).toHaveBeenCalledWith(
			expect.objectContaining({ manifestName: "vod-2.m3u8" }),
		);
	});

	it("refuses a channel that is not STOPPED (a growing recording truncates)", async () => {
		const t = stoppedChannel(finishedManifests());
		t.row.status = "RUNNING";
		await expect(t.actions.liveToVod(CHANNEL_ID, {})).rejects.toThrow(
			/needs a STOPPED channel/,
		);
		expect(t.sdk.createDefaultHlsManifest).not.toHaveBeenCalled();
	});

	it("refuses an output the plan does not carry, and one never provisioned", async () => {
		const t = stoppedChannel(finishedManifests());
		await expect(
			t.actions.liveToVod(CHANNEL_ID, { outputKey: "nope" }),
		).rejects.toThrow(/does not match claimed output/);
		// Provisioned-but-unrecorded: strip the resourceId from the output step.
		const entries = t.row.stepLog as { step: string; resourceId?: string }[];
		for (const entry of entries) {
			if (entry.step === "output:origin") {
				entry.resourceId = undefined;
			}
		}
		await expect(t.actions.liveToVod(CHANNEL_ID, {})).rejects.toThrow(
			/carries no provisioned output/,
		);
	});

	it("refuses an Akamai MSL output — it has no path to write a VOD asset to", async () => {
		//  / review-4 #7. MSL is addressed by streamId + eventName;
		// there is no bucket and no path, so `${name}/vod` means nothing there.
		// The default is `outputs[0]`, so an MSL-first channel would have
		// picked it with no argument passed at all.
		const t = stoppedChannel(finishedManifests());
		const plan = t.row.plan as {
			outputs: Record<string, unknown>[];
		};
		plan.outputs.unshift({
			key: "msl",
			kind: "AKAMAI_MSL",
			credentialId: "00000000-0000-4000-8000-000000000003",
			streamFormat: "HLS",
			mslVersion: "MSL4",
			name: "Akamai MSL Output",
		});
		// review-5 S4: the step log must carry the MSL output as PROVISIONED,
		// or neutering the guard fails on "carries no provisioned output"
		// instead — a real channel has provisioned it, and a mutation that
		// passes through a different refusal proves the wrong thing.
		const log = t.row.stepLog as {
			step: string;
			kind: string;
			status: string;
			resourceId?: string;
		}[];
		const originStep = log.find((e) => e.step.startsWith("output:"));
		if (!originStep) {
			throw new Error("fixture has no output step to clone");
		}
		log.unshift({
			...originStep,
			step: "output:msl",
			kind: "CREATE_OUTPUT_AKAMAI_MSL",
			status: "DONE",
			resourceId: "bm-msl-output",
		});
		const claim = t.row.liveToVod as LiveToVodRecord;
		claim.outputKey = "msl";
		const exactRun = t.runRows.find((run) => run.id === LIVE_TO_VOD_RUN_ID);
		if (exactRun) exactRun.liveToVod = structuredClone(claim);
		await expect(t.actions.liveToVod(CHANNEL_ID, {})).rejects.toThrow(
			/Akamai MSL live destination/,
		);
		// And the refusal must name a real alternative from THIS plan, not a
		// hand-typed list (the first cut offered "Akamai NetStorage", which the
		// schema does not have — it is ).
		await expect(t.actions.liveToVod(CHANNEL_ID, {})).rejects.toThrow(
			/"origin" \(S3\)/,
		);
		expect(t.sdk.createDefaultHlsManifest).not.toHaveBeenCalled();
		// Naming a real storage output explicitly still works — the refusal is
		// about the output picked, not about the channel having an MSL output.
		claim.outputKey = "origin";
		if (exactRun) exactRun.liveToVod = structuredClone(claim);
		await t.actions.liveToVod(CHANNEL_ID, { outputKey: "origin" });
		expect(t.sdk.createDefaultHlsManifest).toHaveBeenCalled();
	});

	it("records PARTIAL (and rethrows) when one family fails — the other family's manifest survives, channel status untouched", async () => {
		// This test used to pin the DEFECT:
		// a whole-record ERROR with `manifests: []`, because the loop stopped at
		// the first failure and the delivered family was reported as nothing.
		// Families are independent now: the failure is recorded on ITS family,
		// the other one still runs, and the record says PARTIAL.
		const t = stoppedChannel({
			...finishedManifests(),
			getHlsManifestStatus: vi.fn(() =>
				Promise.resolve({ status: "ERROR", messages: ["no muxings"] }),
			),
		});
		await expect(t.actions.liveToVod(CHANNEL_ID, {})).rejects.toThrow(
			/live-to-VOD PARTIAL: HLS: .*ended ERROR: no muxings/,
		);
		const record = t.row.liveToVod as LiveToVodRecord;
		expect(record.status).toBe("PARTIAL");
		expect(record.technicalDetail).toContain("ended ERROR");
		expect(record.families).toEqual([
			expect.objectContaining({
				type: "HLS",
				status: "ERROR",
				errorCode: "L2V_PROVIDER_STATUS_FAILED",
				manifestId: "bm-vod-hls",
				technicalDetail: expect.stringContaining("ended ERROR: no muxings"),
			}),
			expect.objectContaining({
				type: "DASH",
				status: "FINISHED",
				manifestId: "bm-vod-dash",
				url: "output/live-rtmp-simple/vod.mpd",
			}),
		]);
		// manifests[] is the FINISHED projection — the delivered DASH is there.
		expect(record.manifests).toEqual([
			{
				type: "DASH",
				manifestId: "bm-vod-dash",
				url: "output/live-rtmp-simple/vod.mpd",
			},
		]);
		expect(record.finishedAt).toBeDefined();
		expect(t.sdk.createDefaultDashManifest).toHaveBeenCalledTimes(1);
		// A live-to-VOD failure is NOT a channel failure.
		expect(t.row.status).toBe("STOPPED");
	});

	it("records ERROR only when NO family finished — both ids still retained for the retry", async () => {
		const t = stoppedChannel({
			...finishedManifests(),
			getHlsManifestStatus: vi.fn(() =>
				Promise.resolve({ status: "ERROR", messages: ["no muxings"] }),
			),
			getDashManifestStatus: vi.fn(() =>
				Promise.resolve({ status: "CANCELED" }),
			),
		});
		await expect(t.actions.liveToVod(CHANNEL_ID, {})).rejects.toThrow(
			/live-to-VOD ERROR: HLS: .*; DASH: .*ended CANCELED/,
		);
		const record = t.row.liveToVod as LiveToVodRecord;
		expect(record.status).toBe("ERROR");
		expect(record.manifests).toEqual([]);
		expect(
			record.families?.map((f) => [
				f.type,
				f.status,
				"manifestId" in f ? f.manifestId : undefined,
			]),
		).toEqual([
			["HLS", "ERROR", "bm-vod-hls"],
			["DASH", "ERROR", "bm-vod-dash"],
		]);
		expect(t.row.status).toBe("STOPPED");
	});

	it("abandons its record write when the channel is re-aired mid-roll (row #257)", async () => {
		// A scheduler re-air of a STOPPED channel (sweep.ts case "STOPPED")
		// nulls bitmovinEncodingId + liveToVod and mints a new run in ONE
		// claim. Model it landing AFTER the first (RUNNING) save and BEFORE
		// the next one: the HLS create is the seam it fires at.
		let reaired = false;
		const t = stoppedChannel({
			...finishedManifests(),
			createDefaultHlsManifest: vi.fn(async () => {
				if (!reaired) {
					reaired = true;
					// Exactly what the sweep's re-air claim writes onto the row.
					t.row.bitmovinEncodingId = null;
					t.row.status = "PROVISIONING";
					t.row.liveToVod = null;
				}
				return "bm-vod-hls";
			}),
		});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		// Two families, so a save runs AFTER the re-aired seam.
		await expect(
			t.actions.liveToVod(CHANNEL_ID, { manifests: ["HLS", "DASH"] }),
		).resolves.toBeUndefined();
		// The new run's PROVISIONING state (liveToVod nulled by the re-air) is
		// INTACT — the stale roll did not write the old run's record over it.
		expect(t.row.liveToVod).toBeNull();
		// It gave up loudly, and never went on to the DASH manifest.
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining(
				"lost its exact channel/run fence; abandoning stale delivery",
			),
		);
		expect(t.sdk.createDefaultDashManifest).not.toHaveBeenCalled();
		// The exact old run already owns a durable provider identity from BEFORE
		// the POST. A stale channel fence must not issue an untracked delete; the
		// archived run can reconcile this one provider object by exact identity.
		expect(t.sdk.deleteHlsManifest).not.toHaveBeenCalled();
		expect(await aliveManifests(t)).toEqual(["bm-vod-hls"]);
		warn.mockRestore();
	});

	it("still writes its record on the run it is archiving — fence holds (control, row #257)", async () => {
		const t = stoppedChannel(finishedManifests());
		await t.actions.liveToVod(CHANNEL_ID, { manifests: ["HLS", "DASH"] });
		// The progress write is a fenced updateMany carrying the encoding this
		// roll archives — not a blind update on { id } alone.
		expect(t.liveChannel.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					id: CHANNEL_ID,
					bitmovinEncodingId: "bm-live-enc",
				}),
				data: { liveToVod: expect.anything() },
			}),
		);
		// The fence held on every save, so the record reached FINISHED.
		const record = t.row.liveToVod as { status: string; manifests: unknown[] };
		expect(record.status).toBe("FINISHED");
		expect(record.manifests).toHaveLength(2);
	});

	it("ends cleanly (never rethrows) when a re-air lands during a FAILING roll (row #257)", async () => {
		// The error path saves too. If the roll errored AND was re-aired, the
		// save fence trips and the job must END rather than throw — a throw
		// would fail the job and wake the dead-job reaper (index.ts) to stamp
		// ERROR onto whatever the new run just claimed.
		let reaired = false;
		const t = stoppedChannel({
			...finishedManifests(),
			createDefaultHlsManifest: vi.fn(async () => {
				if (!reaired) {
					reaired = true;
					t.row.bitmovinEncodingId = null;
					t.row.status = "PROVISIONING";
					t.row.liveToVod = null;
				}
				return "bm-vod-hls";
			}),
			getHlsManifestStatus: vi.fn(() =>
				Promise.resolve({ status: "ERROR", messages: ["no muxings"] }),
			),
		});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		await expect(t.actions.liveToVod(CHANNEL_ID, {})).resolves.toBeUndefined();
		expect(t.row.liveToVod).toBeNull();
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining(
				"lost its exact channel/run fence; abandoning stale delivery",
			),
		);
		warn.mockRestore();
	});

	it("dispatches the live-to-vod action through the queue processor", async () => {
		const t = stoppedChannel(finishedManifests());
		await expect(
			t.process({
				liveChannelId: CHANNEL_ID,
				action: "live-to-vod",
				params: { manifests: ["HLS"] },
				attemptId: (t.row.liveToVod as LiveToVodRecord).attemptId,
				liveChannelRunId: LIVE_TO_VOD_RUN_ID,
				encodingId: "bm-live-enc",
			}),
		).resolves.toMatchObject({
			acknowledged: true,
			action: "live-to-vod",
			status: "VOD_MANIFESTS_GENERATED",
		});
	});

	it("refuses a queue delivery whose claimed new-format record normalized to invalid", async () => {
		const t = stoppedChannel(finishedManifests());
		const current = t.row.liveToVod as LiveToVodRecord;
		const invalid = {
			...current,
			families: [
				{
					type: "HLS",
					status: "PENDING",
					providerIdentity: {
						attemptId: current.attemptId,
						encodingId: "bm-live-enc",
						outputId: "bm-output-origin",
						outputPath: "output/live-rtmp-simple",
						manifestName: "vod.m3u8",
					},
					// Missing createIntent: the earlier provider outcome is unresolved.
				},
			],
		};
		t.row.liveToVod = invalid;
		const run = t.runRows.find(
			(candidate) => candidate.id === LIVE_TO_VOD_RUN_ID,
		);
		if (run) run.liveToVod = structuredClone(invalid);

		await expect(
			t.actions.liveToVod(
				CHANNEL_ID,
				{ manifests: ["HLS"] },
				{
					attemptId: current.attemptId as string,
					liveChannelRunId: LIVE_TO_VOD_RUN_ID,
					encodingId: "bm-live-enc",
				},
			),
		).rejects.toThrow(/record is invalid/i);
		expect(t.sdk.createDefaultHlsManifest).not.toHaveBeenCalled();
	});

	it("two concurrent deliveries of one exact attempt perform only one provider create", async () => {
		const t = stoppedChannel(finishedManifests());
		await Promise.all([
			t.actions.liveToVod(CHANNEL_ID, { manifests: ["HLS"] }),
			t.actions.liveToVod(CHANNEL_ID, { manifests: ["HLS"] }),
		]);
		expect(t.sdk.createDefaultHlsManifest).toHaveBeenCalledTimes(1);
		expect(t.sdk.startHlsManifest).toHaveBeenCalledTimes(1);
		expect((t.row.liveToVod as LiveToVodRecord).status).toBe("FINISHED");
	});

	it("a response-lost create is reconciled by exact durable intent without a second provider POST", async () => {
		let providerCreates = 0;
		let providerExists = false;
		const create = vi.fn(
			async (args: Parameters<SdkOps["createDefaultHlsManifest"]>[0]) => {
				if (args.allowCreate === false) {
					if (providerExists) return "bm-vod-hls";
					throw new Error("exact manifest absent");
				}
				providerCreates += 1;
				providerExists = true;
				throw new Error("provider created the manifest but response was lost");
			},
		);
		const t = stoppedChannel({
			...finishedManifests(),
			createDefaultHlsManifest: create,
		});
		await expect(
			t.actions.liveToVod(CHANNEL_ID, { manifests: ["HLS"] }),
		).rejects.toThrow(/response was lost/);
		const failed = (t.row.liveToVod as LiveToVodRecord).families?.find(
			(family) => family.type === "HLS",
		);
		expect(failed).toMatchObject({
			status: "ERROR",
			errorCode: "L2V_PROVIDER_CREATE_FAILED",
			providerIdentity: { manifestName: "vod.m3u8" },
			createIntent: { status: "CREATE_PENDING" },
		});
		// BullMQ re-delivers the SAME queue payload/attempt. Its new worker token
		// is reconciliation-only (`allowCreate:false`), so it may adopt but POST 0.
		await t.actions.liveToVod(CHANNEL_ID, { manifests: ["HLS"] });
		expect(create.mock.calls.map(([args]) => args.allowCreate)).toEqual([
			true,
			false,
		]);
		expect(providerCreates).toBe(1);
		expect((t.row.liveToVod as LiveToVodRecord).status).toBe("FINISHED");
	});

	/**
	 * The paid run rolled a
	 * segmented-TS channel with no body: the default asked for HLS AND DASH, the
	 * HLS manifest was generated, the DASH create came back 400 / code 2700 (a
	 * DASH default manifest enumerates fMP4 muxings only), and the record said
	 * ERROR with `manifests: []`. Two invariants: the default is the family set
	 * the RECORDED muxings support; a family's failure never erases another's
	 * success. Every arm below ends with the provider ledger equal to what the
	 * record accounts for — orphan 0, duplicate 0.
	 */
	describe("muxing-compatible families and per-family results (ledger #283)", () => {
		it("TS-only default rolls HLS alone: HLS FINISHED, DASH SDK calls 0, DASH recorded SKIPPED_UNSUPPORTED with the reason", async () => {
			const t = stoppedTsChannel(finishedManifests());
			// Premise: the fixture really is TS-only.
			const kinds = (t.row.stepLog as StepLogEntry[])
				.filter((e) => e.kind.startsWith("CREATE_MUXING_"))
				.map((e) => e.kind);
			expect(new Set(kinds)).toEqual(new Set(["CREATE_MUXING_TS"]));
			// Audio is muxed INTO each TS variant, so every muxing sits under
			// `…/video` and that is the C35 parent the manifest lands at.
			const vodPath = "output/live-hls-ts-muxed/video";
			for (const muxing of recordedMuxingPaths(t.row)) {
				expect(muxing.startsWith(`${vodPath}/`)).toBe(true);
			}
			await t.actions.liveToVod(CHANNEL_ID, {});
			expect(t.sdk.createDefaultHlsManifest).toHaveBeenCalledWith(
				expect.objectContaining({
					encodingId: "bm-live-enc",
					manifestName: "vod.m3u8",
					destination: {
						outputId: "bm-output-origin",
						outputPath: vodPath,
					},
				}),
			);
			expect(t.sdk.startHlsManifest).toHaveBeenCalledWith("bm-vod-hls", {
				manifestGenerator: "LEGACY",
			});
			// The defect: a DASH default manifest over TS. Zero calls, of any kind.
			expect(t.sdk.createDefaultDashManifest).not.toHaveBeenCalled();
			expect(t.sdk.startDashManifest).not.toHaveBeenCalled();
			expect(t.sdk.getDashManifestStatus).not.toHaveBeenCalled();
			const record = t.row.liveToVod as LiveToVodRecord;
			expect(record.status).toBe("FINISHED");
			expect(record.manifests).toEqual([
				{
					type: "HLS",
					manifestId: "bm-vod-hls",
					url: "output/live-hls-ts-muxed/video/vod.m3u8",
				},
			]);
			expect(record.families).toEqual([
				expect.objectContaining({
					type: "HLS",
					status: "FINISHED",
					manifestId: "bm-vod-hls",
					url: "output/live-hls-ts-muxed/video/vod.m3u8",
				}),
				expect.objectContaining({
					type: "DASH",
					status: "SKIPPED_UNSUPPORTED",
					reasonCode: "L2V_UNSUPPORTED_FAMILY",
					reason: expect.stringMatching(/CREATE_MUXING_TS.*2700.*HLS only/),
				}),
			]);
			expect(await aliveManifests(t)).toEqual(recordedManifestIds(t));
		});

		it("TS-only + explicit DASH is refused before any provider call, naming the muxing and the families that work", async () => {
			const t = stoppedTsChannel(finishedManifests());
			await expect(
				t.actions.liveToVod(CHANNEL_ID, { manifests: ["HLS", "DASH"] }),
			).rejects.toThrow(/DASH cannot be generated over this recording/);
			await expect(
				t.actions.liveToVod(CHANNEL_ID, { manifests: ["DASH"] }),
			).rejects.toThrow(/code 2700.*HLS only/);
			expect(t.sdk.createDefaultHlsManifest).not.toHaveBeenCalled();
			expect(t.sdk.createDefaultDashManifest).not.toHaveBeenCalled();
			// Nothing was claimed either: the refusal precedes the first save.
			expect(t.liveChannel.updateMany).not.toHaveBeenCalled();
		});

		it("fMP4 default keeps HLS + DASH (§14.2 non-regression), with no SKIPPED entry", async () => {
			const t = stoppedChannel(finishedManifests());
			await t.actions.liveToVod(CHANNEL_ID, {});
			expect(t.sdk.createDefaultHlsManifest).toHaveBeenCalledTimes(1);
			expect(t.sdk.createDefaultDashManifest).toHaveBeenCalledTimes(1);
			const record = t.row.liveToVod as LiveToVodRecord;
			expect(record.status).toBe("FINISHED");
			expect(record.families?.map((f) => [f.type, f.status])).toEqual([
				["HLS", "FINISHED"],
				["DASH", "FINISHED"],
			]);
			expect(await aliveManifests(t)).toEqual(recordedManifestIds(t));
		});

		it("HLS success + an injected DASH create error (the audit's 2700) is PARTIAL with the HLS id retained", async () => {
			const t = stoppedChannel({
				...finishedManifests(),
				createDefaultDashManifest: vi.fn(() =>
					Promise.reject(
						new Error(
							"POST /encoding/manifests/dash/default failed (400): Muxing type not supported for DASH manifest (code 2700)",
						),
					),
				),
			});
			await expect(t.actions.liveToVod(CHANNEL_ID, {})).rejects.toThrow(
				/live-to-VOD PARTIAL: DASH: .*code 2700/,
			);
			const record = t.row.liveToVod as LiveToVodRecord;
			expect(record.status).toBe("PARTIAL");
			expect(record.manifests).toEqual([
				{
					type: "HLS",
					manifestId: "bm-vod-hls",
					url: "output/live-rtmp-simple/vod.m3u8",
				},
			]);
			expect(record.families).toEqual([
				expect.objectContaining({
					type: "HLS",
					status: "FINISHED",
					manifestId: "bm-vod-hls",
					url: "output/live-rtmp-simple/vod.m3u8",
				}),
				expect.objectContaining({
					type: "DASH",
					status: "ERROR",
					errorCode: "L2V_PROVIDER_CREATE_FAILED",
					technicalDetail: expect.stringContaining("code 2700"),
				}),
			]);
			// The HLS manifest was started and polled exactly as on a clean roll.
			expect(t.sdk.startHlsManifest).toHaveBeenCalledTimes(1);
			expect(await aliveManifests(t)).toEqual(recordedManifestIds(t));
		});

		it("a retry re-runs only the failed family: HLS re-CREATE 0, and the failed DASH manifest is read back and cleaned before its replacement", async () => {
			// Roll 1: HLS delivered, DASH generation ended ERROR (id retained).
			let oldDeleted = false;
			const dashStatus = vi.fn<(id: string) => Promise<TaskStatusResult>>(
				(id) =>
					id === "bm-vod-dash" && oldDeleted
						? Promise.reject(
								Object.assign(new Error("not found"), { httpStatusCode: 404 }),
							)
						: Promise.resolve({ status: "ERROR", messages: ["boom"] }),
			);
			const t = stoppedChannel({
				...finishedManifests(),
				createDefaultDashManifest: vi
					.fn<() => Promise<string>>()
					.mockResolvedValueOnce("bm-vod-dash")
					.mockResolvedValueOnce("bm-vod-dash-2"),
				getDashManifestStatus: dashStatus,
				deleteDashManifest: vi.fn(async () => {
					oldDeleted = true;
				}),
			});
			await expect(t.actions.liveToVod(CHANNEL_ID, {})).rejects.toThrow(
				/PARTIAL/,
			);
			expect(t.sdk.createDefaultHlsManifest).toHaveBeenCalledTimes(1);
			// The operator re-submits; the route carries the record forward.
			resubmitThroughRoute(t);
			// The provider now answers FINISHED for the replacement only; the old
			// id still reads back as its ERROR.
			dashStatus.mockImplementation((id: string) => {
				if (id === "bm-vod-dash") {
					return oldDeleted
						? Promise.reject(
								Object.assign(new Error("not found"), { httpStatusCode: 404 }),
							)
						: Promise.resolve({ status: "ERROR", messages: ["boom"] });
				}
				return Promise.resolve({ status: "FINISHED" });
			});
			await t.actions.liveToVod(CHANNEL_ID, {});
			// HLS: no second create, no second start — its FINISHED entry was kept.
			expect(t.sdk.createDefaultHlsManifest).toHaveBeenCalledTimes(1);
			expect(t.sdk.startHlsManifest).toHaveBeenCalledTimes(1);
			// DASH: the saved id was read back FIRST, deleted (terminal cleanup),
			// and only then was a replacement created — under the NEXT filename.
			expect(t.sdk.deleteDashManifest).toHaveBeenCalledWith("bm-vod-dash");
			expect(t.sdk.createDefaultDashManifest).toHaveBeenCalledTimes(2);
			expect(t.sdk.createDefaultDashManifest).toHaveBeenLastCalledWith(
				expect.objectContaining({ manifestName: "vod.mpd" }),
			);
			const deleteOrder =
				vi.mocked(t.sdk.deleteDashManifest).mock.invocationCallOrder[0] ?? 0;
			const secondCreate =
				vi.mocked(t.sdk.createDefaultDashManifest).mock
					.invocationCallOrder[1] ?? 0;
			expect(deleteOrder).toBeLessThan(secondCreate);
			const cleanup = cleanupSnapshots(t, "DASH");
			const pendingIndex = cleanup.findIndex(
				(snapshot) => snapshot.status === "DELETE_PENDING",
			);
			const confirmedIndex = cleanup.findIndex(
				(snapshot) => snapshot.status === "DELETE_CONFIRMED",
			);
			expect(cleanup[pendingIndex]).toMatchObject({
				providerId: "bm-vod-dash",
				requestedAt: expect.any(String),
			});
			expect(cleanup[confirmedIndex]).toMatchObject({
				providerId: "bm-vod-dash",
				requestedAt: expect.any(String),
				confirmedAt: expect.any(String),
			});
			expect(pendingIndex).toBeGreaterThanOrEqual(0);
			expect(confirmedIndex).toBeGreaterThan(pendingIndex);
			const record = t.row.liveToVod as LiveToVodRecord;
			expect(record.status).toBe("FINISHED");
			expect(record.manifests).toEqual([
				{
					type: "HLS",
					manifestId: "bm-vod-hls",
					url: "output/live-rtmp-simple/vod.m3u8",
				},
				{
					type: "DASH",
					manifestId: "bm-vod-dash-2",
					url: "output/live-rtmp-simple/vod.mpd",
				},
			]);
			expect(await aliveManifests(t)).toEqual(recordedManifestIds(t));
		});

		it("fault: CREATE succeeded but the id save failed — exact durable intent remains for one-create reconciliation", async () => {
			const t = stoppedChannel(finishedManifests());
			// Arm the DB failure for the save that would carry the HLS id.
			vi.mocked(t.sdk.createDefaultHlsManifest).mockImplementationOnce(
				async () => {
					t.liveChannel.updateMany.mockRejectedValueOnce(
						new Error("connection reset"),
					);
					return "bm-vod-hls";
				},
			);
			await expect(t.actions.liveToVod(CHANNEL_ID, {})).rejects.toThrow(
				/could not be persisted: connection reset/,
			);
			expect(t.sdk.deleteHlsManifest).not.toHaveBeenCalled();
			// It stopped there: no start, no DASH — the DB cannot record either.
			expect(t.sdk.startHlsManifest).not.toHaveBeenCalled();
			expect(t.sdk.createDefaultDashManifest).not.toHaveBeenCalled();
			expect(await aliveManifests(t)).toEqual(["bm-vod-hls"]);
			const pending = (t.row.liveToVod as LiveToVodRecord).families?.find(
				(family) => family.type === "HLS",
			);
			expect(pending).toMatchObject({
				status: "PENDING",
				providerIdentity: {
					attemptId: (t.row.liveToVod as LiveToVodRecord).attemptId,
					manifestName: "vod.m3u8",
				},
				createIntent: { status: "CREATE_PENDING" },
			});
		});

		it("fault: id saved, then START failed — the retry reads the id back and starts the SAME manifest (create 0)", async () => {
			const t = stoppedChannel(finishedManifests());
			vi.mocked(t.sdk.startDashManifest).mockRejectedValueOnce(
				new Error(
					"POST /encoding/manifests/dash/bm-vod-dash/start failed (503)",
				),
			);
			await expect(t.actions.liveToVod(CHANNEL_ID, {})).rejects.toThrow(
				/PARTIAL: DASH: .*503/,
			);
			// The id was durable BEFORE the start was attempted.
			const failed = (t.row.liveToVod as LiveToVodRecord).families?.find(
				(f) => f.type === "DASH",
			);
			expect(failed).toMatchObject({
				status: "ERROR",
				manifestId: "bm-vod-dash",
				providerIdentity: {
					manifestName: "vod.mpd",
					outputPath: "output/live-rtmp-simple",
				},
			});
			// The provider says the manifest exists and was never started.
			vi.mocked(t.sdk.getDashManifestStatus)
				.mockResolvedValueOnce({ status: "CREATED" })
				.mockResolvedValue({ status: "FINISHED" });
			resubmitThroughRoute(t);
			await t.actions.liveToVod(CHANNEL_ID, {});
			expect(t.sdk.createDefaultDashManifest).toHaveBeenCalledTimes(1);
			expect(t.sdk.createDefaultHlsManifest).toHaveBeenCalledTimes(1);
			expect(t.sdk.startDashManifest).toHaveBeenCalledTimes(2);
			expect(t.sdk.startDashManifest).toHaveBeenLastCalledWith("bm-vod-dash", {
				manifestGenerator: "LEGACY",
			});
			expect(t.sdk.deleteDashManifest).not.toHaveBeenCalled();
			const record = t.row.liveToVod as LiveToVodRecord;
			expect(record.status).toBe("FINISHED");
			expect(record.manifests.map((m) => m.manifestId)).toEqual([
				"bm-vod-hls",
				"bm-vod-dash",
			]);
			expect(await aliveManifests(t)).toEqual(recordedManifestIds(t));
		});

		it("fault: START reached the provider but its response was lost — the retry reads FINISHED back and adopts it (start 1, create 1, duplicate 0)", async () => {
			// The ORDER-SENSITIVE base fake (review-208): a manifest reports
			// CREATED until its start is called, FINISHED after. The lost response
			// is modelled as: the start LANDS (the fake registers it) and then the
			// call throws — exactly undici's "Premature close".
			const t = stoppedChannel();
			const start = vi.mocked(t.sdk.startDashManifest);
			const landed = start.getMockImplementation();
			if (!landed) {
				throw new Error(
					"the base fake has no startDashManifest implementation",
				);
			}
			start.mockImplementationOnce(async (id, p) => {
				await landed(id, p);
				throw new Error("Premature close");
			});
			await expect(t.actions.liveToVod(CHANNEL_ID, {})).rejects.toThrow(
				/PARTIAL: DASH: .*Premature close/,
			);
			resubmitThroughRoute(t);
			await t.actions.liveToVod(CHANNEL_ID, {});
			// Read back FINISHED → adopted. No second start, no second create.
			expect(start).toHaveBeenCalledTimes(1);
			expect(t.sdk.createDefaultDashManifest).toHaveBeenCalledTimes(1);
			expect(t.sdk.deleteDashManifest).not.toHaveBeenCalled();
			const record = t.row.liveToVod as LiveToVodRecord;
			expect(record.status).toBe("FINISHED");
			expect(record.families?.find((f) => f.type === "DASH")).toMatchObject({
				status: "FINISHED",
				manifestId: "bm-2",
			});
			expect(await aliveManifests(t)).toEqual(recordedManifestIds(t));
		});

		it("a saved id the provider no longer has (404) is replaced, never left as a phantom", async () => {
			const t = stoppedChannel(finishedManifests());
			vi.mocked(t.sdk.startDashManifest).mockRejectedValueOnce(
				new Error("start failed"),
			);
			await expect(t.actions.liveToVod(CHANNEL_ID, {})).rejects.toThrow(
				/PARTIAL/,
			);
			vi.mocked(t.sdk.getDashManifestStatus)
				.mockRejectedValueOnce(
					Object.assign(new Error("not found"), { httpStatusCode: 404 }),
				)
				.mockResolvedValue({ status: "FINISHED" });
			vi.mocked(t.sdk.createDefaultDashManifest).mockResolvedValueOnce(
				"bm-vod-dash-2",
			);
			resubmitThroughRoute(t);
			await t.actions.liveToVod(CHANNEL_ID, {});
			expect(t.sdk.deleteDashManifest).not.toHaveBeenCalled();
			expect(t.sdk.createDefaultDashManifest).toHaveBeenCalledTimes(2);
			expect(t.sdk.createDefaultDashManifest).toHaveBeenLastCalledWith(
				expect.objectContaining({ manifestName: "vod.mpd" }),
			);
			expect((t.row.liveToVod as LiveToVodRecord).status).toBe("FINISHED");
		});

		it("a failed manifest that cannot be deleted blocks its replacement — no create before the cleanup decision", async () => {
			const t = stoppedChannel({
				...finishedManifests(),
				getDashManifestStatus: vi.fn(() =>
					Promise.resolve({ status: "ERROR", messages: ["boom"] }),
				),
				deleteDashManifest: vi.fn(() => Promise.reject(new Error("403"))),
			});
			await expect(t.actions.liveToVod(CHANNEL_ID, {})).rejects.toThrow(
				/PARTIAL/,
			);
			resubmitThroughRoute(t);
			await expect(t.actions.liveToVod(CHANNEL_ID, {})).rejects.toThrow(
				/could not be deleted — no replacement is created/,
			);
			expect(t.sdk.createDefaultDashManifest).toHaveBeenCalledTimes(1);
			// The id stays on the record so the next retry tries the cleanup again.
			expect(
				(t.row.liveToVod as LiveToVodRecord).families?.find(
					(f) => f.type === "DASH",
				),
			).toMatchObject({ status: "ERROR", manifestId: "bm-vod-dash" });
			expect(
				(t.row.liveToVod as LiveToVodRecord).families?.find(
					(f) => f.type === "DASH",
				),
			).toMatchObject({
				cleanup: {
					providerId: "bm-vod-dash",
					status: "DELETE_PENDING",
				},
			});
			expect(cleanupSnapshots(t, "DASH")).not.toEqual(
				expect.arrayContaining([
					expect.objectContaining({ status: "DELETE_CONFIRMED" }),
				]),
			);
		});

		it("a successful DELETE without 404 readback remains pending and cannot authorize replacement", async () => {
			const t = stoppedChannel({
				...finishedManifests(),
				getDashManifestStatus: vi.fn(() =>
					Promise.resolve({ status: "ERROR", messages: ["still present"] }),
				),
				deleteDashManifest: vi.fn(() => Promise.resolve()),
			});
			await expect(t.actions.liveToVod(CHANNEL_ID, {})).rejects.toThrow(
				/PARTIAL/,
			);
			resubmitThroughRoute(t);
			await expect(t.actions.liveToVod(CHANNEL_ID, {})).rejects.toThrow(
				/could not be deleted — no replacement is created/,
			);

			expect(t.sdk.deleteDashManifest).toHaveBeenCalledTimes(1);
			expect(t.sdk.createDefaultDashManifest).toHaveBeenCalledTimes(1);
			expect(
				(t.row.liveToVod as LiveToVodRecord).families?.find(
					(family) => family.type === "DASH",
				),
			).toMatchObject({
				status: "ERROR",
				manifestId: "bm-vod-dash",
				cleanup: {
					providerId: "bm-vod-dash",
					status: "DELETE_PENDING",
				},
			});
			expect(cleanupSnapshots(t, "DASH")).not.toEqual(
				expect.arrayContaining([
					expect.objectContaining({ status: "DELETE_CONFIRMED" }),
				]),
			);
		});

		it("a LEGACY ERROR record (no families) is a NEW roll — its manifests are not promoted and nothing is resumed (§14.6 item 6)", async () => {
			const t = stoppedChannel(finishedManifests());
			// The old all-or-error shape: HLS was delivered, DASH failed, and the
			// record said ERROR. As in production it sits on the channel column AND
			// in the run mirror (every worker save mirrors it), which is where the
			// filename rule reads it back from after the route's claim replaces
			// the column.
			const legacy = {
				status: "ERROR",
				outputId: "bm-output-origin",
				path: "output/live-rtmp-simple",
				manifests: [
					{
						type: "HLS",
						manifestId: "bm-legacy-hls",
						url: "output/live-rtmp-simple/vod.m3u8",
					},
				],
				error: "live-to-vod:dash ended ERROR",
			};
			t.row.liveToVod = legacy;
			t.runRows.push({
				id: "run-1",
				seq: 1,
				status: "STOPPED",
				liveToVod: legacy,
			});
			resubmitThroughRoute(t);
			// The claim carried nothing: no families to resume, no manifests.
			expect(
				(t.row.liveToVod as LiveToVodRecord).families?.map((f) => f.status),
			).toEqual(["PENDING", "PENDING"]);
			expect((t.row.liveToVod as LiveToVodRecord).manifests).toEqual([]);
			await t.actions.liveToVod(CHANNEL_ID, {});
			// Both families were generated afresh; the legacy HLS was neither
			// reused nor promoted, and its filename was not overwritten.
			expect(t.sdk.createDefaultHlsManifest).toHaveBeenCalledWith(
				expect.objectContaining({ manifestName: "vod-2.m3u8" }),
			);
			const record = t.row.liveToVod as LiveToVodRecord;
			expect(record.manifests.map((m) => m.manifestId)).toEqual([
				"bm-vod-hls",
				"bm-vod-dash",
			]);
		});

		it("a re-targeted retry does not reuse ids created elsewhere: the unfinished one is cleaned up, the roll starts fresh at the new path", async () => {
			let deleted = false;
			const t = stoppedChannel({
				...finishedManifests(),
				deleteDashManifest: vi.fn(async () => {
					deleted = true;
				}),
				getDashManifestStatus: vi.fn(async (id: string) => {
					if (deleted && id === "bm-vod-dash") {
						throw Object.assign(new Error("not found"), {
							httpStatusCode: 404,
						});
					}
					return { status: "FINISHED" };
				}),
			});
			vi.mocked(t.sdk.startDashManifest).mockRejectedValueOnce(
				new Error("start failed"),
			);
			await expect(t.actions.liveToVod(CHANNEL_ID, {})).rejects.toThrow(
				/PARTIAL/,
			);
			resubmitThroughRoute(t);
			vi.mocked(t.sdk.createDefaultDashManifest).mockResolvedValueOnce(
				"bm-vod-dash-2",
			);
			vi.mocked(t.sdk.createDefaultHlsManifest).mockResolvedValueOnce(
				"bm-vod-hls-2",
			);
			await t.actions.liveToVod(CHANNEL_ID, { path: "output" });
			expect(t.sdk.deleteDashManifest).toHaveBeenCalledWith("bm-vod-dash");
			expect(t.sdk.deleteHlsManifest).not.toHaveBeenCalled();
			const record = t.row.liveToVod as LiveToVodRecord;
			expect(record.path).toBe("output");
			expect(record.manifests.map((m) => m.manifestId)).toEqual([
				"bm-vod-hls-2",
				"bm-vod-dash-2",
			]);
		});

		it("an automatic retry after unconfirmed re-target cleanup still deletes the old destination before any adoption", async () => {
			let deleteCalls = 0;
			let oldReadbacks = 0;
			const t = stoppedChannel({
				...finishedManifests(),
				deleteDashManifest: vi.fn(async () => {
					deleteCalls += 1;
				}),
				getDashManifestStatus: vi.fn(async (id: string) => {
					if (id !== "bm-vod-dash") {
						return { status: "FINISHED" };
					}
					oldReadbacks += 1;
					if (deleteCalls >= 2) {
						throw Object.assign(new Error("not found"), {
							httpStatusCode: 404,
						});
					}
					// First re-target: DELETE returned but readback still sees the old
					// object. With the bug, the next delivery calls status before DELETE,
					// sees RUNNING and later FINISHED, and adopts the wrong destination.
					return { status: oldReadbacks >= 3 ? "FINISHED" : "RUNNING" };
				}),
			});
			vi.mocked(t.sdk.startDashManifest).mockRejectedValueOnce(
				new Error("start failed"),
			);
			await expect(t.actions.liveToVod(CHANNEL_ID, {})).rejects.toThrow(
				/PARTIAL/,
			);

			resubmitThroughRoute(t);
			await expect(
				t.actions.liveToVod(CHANNEL_ID, { path: "output" }),
			).rejects.toThrow(/deletion was not confirmed/);
			expect(t.sdk.deleteDashManifest).toHaveBeenCalledTimes(1);

			vi.mocked(t.sdk.createDefaultHlsManifest).mockResolvedValueOnce(
				"bm-vod-hls-2",
			);
			vi.mocked(t.sdk.createDefaultDashManifest).mockResolvedValueOnce(
				"bm-vod-dash-2",
			);
			// Same BullMQ attempt, no route re-claim: cleanup state and old provider
			// identity must themselves keep this delivery in re-target mode.
			await t.actions.liveToVod(CHANNEL_ID, { path: "output" });

			expect(t.sdk.deleteDashManifest).toHaveBeenCalledTimes(2);
			expect(t.sdk.createDefaultHlsManifest).toHaveBeenCalledTimes(2);
			expect(t.sdk.createDefaultDashManifest).toHaveBeenCalledTimes(2);
			const record = t.row.liveToVod as LiveToVodRecord;
			expect(record.path).toBe("output");
			expect(record.manifests.map((manifest) => manifest.manifestId)).toEqual([
				"bm-vod-hls-2",
				"bm-vod-dash-2",
			]);
		});
	});
});

/**
 * review-83b I1: the sweep↔engine seam had ZERO pins — the reviewer's two
 * mutations (drop the failure-isolation try/catch; corrupt the "RUNNING"
 * literal) survived the whole 856-test worker suite. These watch the seam.
 */
describe("heartbeat sweep ↔ alert engine seam (review-83b I1)", () => {
	function sweepWith(over: {
		alertEngine?: (
			liveChannelId: string,
			channelStatus: string,
			lastTouchedAt?: string,
		) => Promise<{ opened: number; resolved: number }>;
		resolveOrphanedAlerts?: (
			runningChannelIds: ReadonlySet<string>,
		) => Promise<{ resolved: number }>;
	}) {
		const t = setup({
			status: "RUNNING",
			bitmovinAccountId: ACCOUNT_ID,
			bitmovinEncodingId: "bm-live-enc",
		});
		t.runRows.length = 0;
		return {
			...t,
			sweep: createLiveHeartbeatSweep({
				...t.deps,
				...(over.alertEngine ? { alertEngine: over.alertEngine } : {}),
				...(over.resolveOrphanedAlerts
					? { resolveOrphanedAlerts: over.resolveOrphanedAlerts }
					: {}),
			}),
		};
	}

	it("the stale anchor is the RUN's lastHeartbeatAt — NON-heartbeat mirror writes cannot reset the clock (review-109pr1's pre-build catch)", async () => {
		const alertEngine = vi.fn(async () => ({ opened: 0, resolved: 0 }));
		const t = sweepWith({ alertEngine });
		// A run whose encoder last spoke LONG ago — while OTHER mirror
		// writes (status transitions, step logs) kept touching the row.
		// Under the old channel-updatedAt anchor those writes faked life;
		// the run's lastHeartbeatAt only moves when a heartbeat lands.
		const staleAt = new Date("2026-06-12T00:00:00.000Z");
		const bornAt = new Date("2026-06-11T00:00:00.000Z");
		t.runRows.push({
			id: "run-1",
			seq: 1,
			status: "RUNNING",
			lastHeartbeatAt: staleAt,
			createdAt: bornAt,
		} as (typeof t.runRows)[number]);
		// Poll FAILS (no heartbeat write this sweep) — the exact scenario
		// HEARTBEAT_STALE exists for.
		vi.mocked(t.sdk.getLiveHeartbeat).mockRejectedValueOnce(
			new Error("poll down"),
		);
		await t.sweep();
		expect(alertEngine).toHaveBeenCalledWith(
			CHANNEL_ID,
			"RUNNING",
			staleAt.toISOString(),
			expect.anything(),
			//  / review-347: the SAME row now serves two different
			// questions and they must not be confused. The anchor is "when did
			// the encoder last speak" (lastHeartbeatAt, above); the run scope
			// is "which rows belong to this airing" (createdAt). This row makes
			// them a day apart on purpose, so handing the scope the anchor —
			// the obvious copy-paste — cannot pass.
			{ id: "run-1", createdAt: bornAt },
		);
	});

	it("a run with NO sample anchors from its own createdAt — a fresh run never inherits the previous run's grace (R5/I3)", async () => {
		const alertEngine = vi.fn(async () => ({ opened: 0, resolved: 0 }));
		const t = sweepWith({ alertEngine });
		const bornAt = new Date("2026-06-12T09:00:00.000Z");
		t.runRows.push({
			id: "run-2",
			seq: 2,
			status: "PROVISIONING",
			lastHeartbeatAt: null,
			createdAt: bornAt,
		} as (typeof t.runRows)[number]);
		vi.mocked(t.sdk.getLiveHeartbeat).mockRejectedValueOnce(
			new Error("poll down"),
		);
		await t.sweep();
		expect(alertEngine).toHaveBeenCalledWith(
			CHANNEL_ID,
			"RUNNING",
			bornAt.toISOString(),
			expect.anything(),
			// The one case where anchor and scope legitimately coincide (no
			// sample yet ⇒ the anchor falls back to createdAt) — the arm above
			// is the discriminating one.
			{ id: "run-2", createdAt: bornAt },
		);
	});

	it("evaluates each polled channel as RUNNING with its last-touch anchor", async () => {
		const alertEngine = vi.fn(async () => ({ opened: 0, resolved: 0 }));
		const { sweep } = sweepWith({ alertEngine });
		await sweep();
		// The literal matters: corrupting "RUNNING" silently kills
		// HEARTBEAT_STALE (the evaluator's status guard) — one of the two
		// rules PR3 seeds by default.
		expect(alertEngine).toHaveBeenCalledWith(
			CHANNEL_ID,
			"RUNNING",
			"2026-06-11T23:59:30.000Z",
			// review-223 F10: the window rides the sweep's own channel read —
			// null here because this channel has no scheduled slot.
			{ programStartAt: null, programEndAt: null },
			// : no run row for this harness channel — the sweep
			// LOOKED and says so, so the engine takes the unscoped path
			// without re-asking (null, never undefined).
			null,
		);
	});

	it("threads the SCHEDULED window from its own select into the engine (review-223 F10/F9)", async () => {
		const alertEngine = vi.fn(async () => ({ opened: 0, resolved: 0 }));
		const start = new Date("2026-06-12T00:10:00.000Z");
		const end = new Date("2026-06-12T01:00:00.000Z");
		const t = setup({
			status: "RUNNING",
			bitmovinAccountId: ACCOUNT_ID,
			bitmovinEncodingId: "bm-live-enc",
			programStartAt: start,
			programEndAt: end,
		});
		t.runRows.length = 0;
		const sweep = createLiveHeartbeatSweep({ ...t.deps, alertEngine });
		await sweep();
		// PROGRAM_START_NO_INGEST only exists if these actually arrive: a
		// select that stopped carrying the columns would pass null here and
		// the metric would never breach anywhere (the named-slot lesson).
		expect(alertEngine).toHaveBeenCalledWith(
			CHANNEL_ID,
			"RUNNING",
			"2026-06-11T23:59:30.000Z",
			{ programStartAt: start, programEndAt: end },
			null,
		);
	});

	it("an engine THROW is isolated — the sweep still reports the poll and continues", async () => {
		const alertEngine = vi.fn(async () => {
			throw new Error("evaluator exploded");
		});
		const resolveOrphanedAlerts = vi.fn(async () => ({ resolved: 0 }));
		const { sweep } = sweepWith({ alertEngine, resolveOrphanedAlerts });
		await expect(sweep()).resolves.toEqual({ polled: 1, failed: 0 });
		// And the orphan pass still ran after the throwing engine.
		expect(resolveOrphanedAlerts).toHaveBeenCalledTimes(1);
	});

	it("the orphan resolver receives the RUNNING id set (review-83b C1's escape hatch)", async () => {
		const resolveOrphanedAlerts = vi.fn(async () => ({ resolved: 0 }));
		const { sweep } = sweepWith({ resolveOrphanedAlerts });
		await sweep();
		expect(resolveOrphanedAlerts).toHaveBeenCalledWith(new Set([CHANNEL_ID]));
	});

	it("an orphan-resolver THROW never fails the sweep", async () => {
		const resolveOrphanedAlerts = vi.fn(async () => {
			throw new Error("resolver exploded");
		});
		const { sweep } = sweepWith({ resolveOrphanedAlerts });
		await expect(sweep()).resolves.toEqual({ polled: 1, failed: 0 });
	});

	it("WIRING: the run heartbeat summarizer runs once per tick, before the RUNNING poll loop", async () => {
		const order: string[] = [];
		const summarizeEndedRuns = vi.fn(async () => {
			order.push("summarize");
			return { summarized: 0 };
		});
		const t = setup({
			status: "RUNNING",
			bitmovinAccountId: ACCOUNT_ID,
			bitmovinEncodingId: "bm-live-enc",
		});
		t.runRows.length = 0;
		vi.mocked(t.sdk.getLiveHeartbeat).mockImplementation(async () => {
			order.push("poll");
			return { ingest: { status: "CONNECTED" }, events: [] };
		});
		const sweep = createLiveHeartbeatSweep({ ...t.deps, summarizeEndedRuns });
		await expect(sweep()).resolves.toEqual({ polled: 1, failed: 0 });
		expect(summarizeEndedRuns).toHaveBeenCalledTimes(1);
		expect(order).toEqual(["summarize", "poll"]);
	});

	it("a summarizer THROW never fails the sweep", async () => {
		const summarizeEndedRuns = vi.fn(async () => {
			throw new Error("summarizer exploded");
		});
		const t = setup({
			status: "RUNNING",
			bitmovinAccountId: ACCOUNT_ID,
			bitmovinEncodingId: "bm-live-enc",
		});
		t.runRows.length = 0;
		const sweep = createLiveHeartbeatSweep({ ...t.deps, summarizeEndedRuns });
		await expect(sweep()).resolves.toEqual({ polled: 1, failed: 0 });
	});
});

describe("dual-write to runs (ledger #108 PR2) — writer-coupled, per R5's cure", () => {
	it("provision creates the run row and mirrors PROVISIONING → step log → RUNNING with encoder facts", async () => {
		const h = setup();
		await h.process({ liveChannelId: CHANNEL_ID, action: "provision" });
		// The run was ensured before the channel transition…
		expect(h.liveChannelRun.create).toHaveBeenCalled();
		expect(h.runRows[0]?.status).toBe("RUNNING");
		// …and the mirrored updates carried the run facts: some update wrote
		// the step log, and some update wrote the RUNNING transition.
		const datas = [
			...h.liveChannelRun.update.mock.calls,
			...h.liveChannelRun.updateMany.mock.calls,
		].map((c) => (c[0] as { data: Record<string, unknown> }).data);
		expect(datas.some((d) => d.stepLog !== undefined)).toBe(true);
		expect(datas.some((d) => d.status === "RUNNING")).toBe(true);
	});

	it("stop mirrors STOPPING then STOPPED (with the run's own endedAt)", async () => {
		const h = setup({ status: "RUNNING", bitmovinEncodingId: "enc-1" });
		h.runRows.push({ id: "run-1", seq: 1, status: "RUNNING" });
		await h.actions.stopChannel(CHANNEL_ID);
		const datas = h.liveChannelRun.update.mock.calls.map(
			(c) => (c[0] as { data: Record<string, unknown> }).data,
		);
		expect(datas.some((d) => d.status === "STOPPING")).toBe(true);
		const stopped = datas.find((d) => d.status === "STOPPED");
		if (!stopped) {
			throw new Error("no STOPPED mirror");
		}
		expect(h.runRows.at(-1)?.endedAt).toBeInstanceOf(Date);
	});
});

describe("the provisioning lease is a WRITE fence (ledger #216, re-audit BLOCKER-1)", () => {
	const STOLEN = new Date("2030-01-01T00:00:00.000Z");

	it("a lease taken DURING a long SDK call cannot land that call's result on the winner's row", async () => {
		// Worker A is inside createEncoding when B takes the lease. A's DONE
		// write (step log + provider encoding id) must be refused; the first
		// cut wrote it unconditionally and B's channel carried A's encoding.
		let row: Record<string, unknown> | undefined;
		const harness = setup(
			{},
			{
				createEncoding: vi.fn(async () => {
					if (row) {
						row.provisionClaimedAt = STOLEN;
					}
					return "bm-live-enc-A";
				}),
			},
		);
		row = harness.row;
		const result = await harness.process({ liveChannelId: CHANNEL_ID });
		expect(result).toMatchObject({ status: "PROVISIONING" });
		expect(harness.row.bitmovinEncodingId ?? null).toBeNull();
		expect(
			harness.updates.some(
				(u) =>
					(u as { bitmovinEncodingId?: string }).bitmovinEncodingId ===
					"bm-live-enc-A",
			),
		).toBe(false);
		// The loser neither marks the winner's row nor keeps the stolen token.
		expect(harness.row.status).not.toBe("ERROR");
		expect(harness.row.status).not.toBe("RUNNING");
		expect(harness.row.provisionClaimedAt).toBe(STOLEN);
	});

	it("a finalize that fails AFTER the lease was taken does not mark the winner's row ERROR", async () => {
		let row: Record<string, unknown> | undefined;
		const harness = setup(
			{},
			{
				getLiveEncodingDetails: vi.fn(async () => {
					if (row) {
						row.provisionClaimedAt = STOLEN;
					}
					throw new Error("details read failed after the takeover");
				}),
			},
		);
		row = harness.row;
		const result = await harness.process({ liveChannelId: CHANNEL_ID });
		expect(result).toMatchObject({ status: "PROVISIONING" });
		expect(harness.row.status).not.toBe("ERROR");
		expect(harness.row.error ?? null).toBeNull();
		expect(
			harness.updates.some(
				(u) => (u as { status?: string }).status === "ERROR",
			),
		).toBe(false);
	});

	it("a lease taken after the final provider readback rolls back both RUNNING projections", async () => {
		let row: Record<string, unknown> | undefined;
		let finalRead = false;
		const harness = setup(
			{},
			{
				getLiveStartRequest: vi.fn(async () => {
					finalRead = true;
					return { streamKey: "fresh-key" } as never;
				}),
				getEncodingStatus: vi.fn(async () => {
					if (finalRead && row) row.provisionClaimedAt = STOLEN;
					return { status: "RUNNING" };
				}),
			},
		);
		row = harness.row;

		const result = await harness.process({ liveChannelId: CHANNEL_ID });

		expect(result).toMatchObject({ status: "PROVISIONING" });
		expect(harness.row.provisionClaimedAt).toEqual(STOLEN);
		expect(harness.row.status).not.toBe("RUNNING");
		expect(harness.row.status).not.toBe("ERROR");
		expect(harness.runRows[0]?.status).not.toBe("RUNNING");
		expect(harness.runRows[0]?.providerStatus ?? null).toBeNull();
	});

	it("renews the lease DURING a long SDK call, not only between polls", async () => {
		// A create that outlives the renewal interval: the ticker must write a
		// fresh stamp while the call is in flight, so a healthy worker's lease
		// cannot go stale inside its own SDK call.
		let tick = 0;
		// The fake call returns only after the ticker has renewed TWICE while
		// it was in flight — observed, not timed. A fixed 40 ms delay against
		// a 5 ms ticker starved under two concurrent gate runs (2026-08-29)
		// and read as a lost renewal; a ticker that never renews now hangs
		// this call into vitest's timeout, which is still red.
		const renewalsSoFar = () =>
			updatesRef.filter(
				(u) => Object.keys(u).length === 1 && "provisionClaimedAt" in u,
			).length;
		let updatesRef: Row[] = [];
		const harness = setup(
			{},
			{
				createEncoding: vi.fn(
					() =>
						new Promise<string>((resolve) => {
							const poll = () => {
								if (renewalsSoFar() >= 2) {
									resolve("bm-live-enc");
								} else {
									setTimeout(poll, 1);
								}
							};
							poll();
						}),
				),
			},
		);
		updatesRef = harness.updates;
		harness.deps.leaseRenewalIntervalMs = 5;
		harness.deps.now = () =>
			new Date(
				Date.parse("2026-06-12T00:00:00.000Z") + ++tick * 1_000,
			).toISOString();
		const before = harness.updates.length;
		const result = await harness.process({ liveChannelId: CHANNEL_ID });
		expect(result).toMatchObject({ status: "RUNNING" });
		const renewalsDuringCreate = harness.updates
			.slice(before)
			.filter((u) => Object.keys(u).length === 1 && "provisionClaimedAt" in u);
		expect(renewalsDuringCreate.length).toBeGreaterThan(1);
	});

	it("issues ONE renewal compare-and-swap at a time — the ticker never races an in-flight renewal (review-336 I2)", async () => {
		// Two compare-and-swaps in flight against the same token would make
		// the second read as a lost lease, and a HEALTHY worker would abort
		// its own provision. The ticker here fires far faster than a renewal
		// completes; the single-flight guard must collapse those firings onto
		// the renewal already in flight.
		let tick = 0;
		// Resolves after THREE observed renewals, not after a fixed 60 ms —
		// same reason as the arm above.
		let renewals = 0;
		const harness = setup(
			{},
			{
				createEncoding: vi.fn(
					() =>
						new Promise<string>((resolve) => {
							const poll = () => {
								if (renewals >= 3) {
									resolve("bm-live-enc");
								} else {
									setTimeout(poll, 1);
								}
							};
							poll();
						}),
				),
			},
		);
		harness.deps.leaseRenewalIntervalMs = 1;
		harness.deps.now = () =>
			new Date(
				Date.parse("2026-06-12T00:00:00.000Z") + ++tick * 1_000,
			).toISOString();
		const original = harness.liveChannel.updateMany.getMockImplementation();
		if (!original) {
			throw new Error("harness updateMany carries no implementation");
		}
		let inFlight = 0;
		let maxInFlight = 0;
		harness.liveChannel.updateMany.mockImplementation(async (args) => {
			const isRenewal =
				Object.keys(args.data).length === 1 &&
				"provisionClaimedAt" in args.data;
			if (!isRenewal) {
				return original(args);
			}
			renewals += 1;
			inFlight += 1;
			maxInFlight = Math.max(maxInFlight, inFlight);
			try {
				const result = await original(args);
				// A renewal that takes longer than the ticker interval.
				await new Promise((resolve) => setTimeout(resolve, 8));
				return result;
			} finally {
				inFlight -= 1;
			}
		});
		const result = await harness.process({ liveChannelId: CHANNEL_ID });
		expect(result).toMatchObject({ status: "RUNNING" });
		expect(renewals).toBeGreaterThan(1);
		expect(maxInFlight).toBe(1);
	});

	it("a setup failure AFTER a takeover does not stamp ERROR over the winner's row (review-336 C2)", async () => {
		// The fifth write: plan parse / account reveal / makeSdk fail after
		// the claim. Unfenced, a worker that stalled inside the reveal past
		// the lease window wrote its stale ERROR over whatever the winner had
		// done since — including RUNNING.
		const harness = setup();
		const winner = new Date("2026-06-12T00:05:00.000Z");
		harness.deps.revealBitmovinAccount = vi.fn(async () => {
			// Another worker takes the lease while this one is inside the reveal.
			harness.row.provisionClaimedAt = winner;
			harness.row.status = "RUNNING";
			throw new Error("MASTER_KEY unavailable");
		});
		const result = await harness.process({ liveChannelId: CHANNEL_ID });
		expect(result).toMatchObject({ status: "PROVISIONING" });
		expect(harness.row.status).toBe("RUNNING");
		expect(harness.row.error ?? null).toBeNull();
		expect(harness.row.provisionClaimedAt).toBe(winner);
		expect(
			harness.updates.some(
				(u) => (u as { status?: string }).status === "ERROR",
			),
		).toBe(false);
	});

	it("a setup failure that still holds the lease marks ERROR, releases the lease and mirrors the run (review-336 C2)", async () => {
		const harness = setup();
		harness.runRows.push({ id: "run-1", seq: 1, status: "CREATED" });
		harness.deps.revealBitmovinAccount = vi.fn(async () => {
			throw new Error("MASTER_KEY unavailable");
		});
		await expect(
			harness.process({ liveChannelId: CHANNEL_ID }),
		).rejects.toThrow(/MASTER_KEY/);
		expect(harness.row.status).toBe("ERROR");
		expect(harness.row.provisionClaimedAt).toBeNull();
		expect(harness.row.error).toMatch(/MASTER_KEY/);
		// The reaper no longer retires runs for a flip it did not win, so this
		// path carries the run to ERROR itself.
		expect(harness.liveChannelRun.update).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ status: "ERROR" }),
			}),
		);
	});

	it("the live `failed` handler flips only a row whose lease is stale or absent, and releases it", () => {
		// Pinned by shape, like #200's VOD twin: a redelivered failure must not
		// mark a channel another worker is still renewing.
		const index = readFileSync(join(__dirname, "../index.ts"), "utf8");
		const handler = index.slice(
			index.indexOf('status: { in: ["CREATED", "PROVISIONING", "STOPPING"] }'),
		);
		expect(handler.slice(0, 900)).toMatch(/\{ provisionClaimedAt: null \}/);
		expect(handler.slice(0, 900)).toMatch(
			/lt: new Date\(Date\.now\(\) - PROVISION_LEASE_MS\)/,
		);
		expect(handler.slice(0, 1200)).toContain("provisionClaimedAt: null,");
		// review-336 C3: the run retirement rides the channel flip's count —
		// a loser that did not win the flip must not retire the winner's run.
		const gated = handler.slice(0, 3200);
		expect(gated).toMatch(
			/\.then\(\(\{ count \}\) => \{[\s\S]*?if \(count === 0\) \{\s*return;\s*\}[\s\S]*?retireTransitionalRuns\(/,
		);
		expect(gated.indexOf("retireTransitionalRuns(")).toBeGreaterThan(
			gated.indexOf(".then(({ count })"),
		);
	});
});

describe("verification provider identity durability", () => {
	it("refuses an incomplete live verification identity before provider create", async () => {
		const h = setup({
			verificationKey: "verify:run-1:live-1:LIVE_CHANNEL",
			verificationRequestSha256: null,
		});
		await expect(
			h.process({ liveChannelId: CHANNEL_ID, action: "provision" }),
		).rejects.toMatchObject({ code: "VERIFICATION_IDENTITY_INCOMPLETE" });
		expect(h.sdk.createEncoding).not.toHaveBeenCalled();
	});

	it("records the provider id before a live CREATE_ENCODING step becomes DONE", async () => {
		const key = "verify:run-1:live-1:LIVE_CHANNEL";
		const sha = "b".repeat(64);
		let callbackResult: string | undefined;
		const h = setup(
			{ verificationKey: key, verificationRequestSha256: sha },
			{},
			(args) =>
				fakeSdk({
					createEncoding: vi.fn(async () => {
						callbackResult = await args.stamp?.onEncodingCreated?.(
							"bm-live-verified",
							"created",
						);
						return "bm-live-verified";
					}),
				}),
		);
		expect(
			await h.process({ liveChannelId: CHANNEL_ID, action: "provision" }),
		).toMatchObject({ status: "RUNNING" });
		expect(callbackResult).toBe("PERSISTED");
		const early = h.updates.find((update) =>
			(update.stepLog as StepLogEntry[] | undefined)?.some(
				(entry) =>
					entry.kind === "CREATE_ENCODING" &&
					entry.status === "RUNNING" &&
					entry.resourceId === "bm-live-verified",
			),
		);
		expect(early).toMatchObject({ bitmovinEncodingId: "bm-live-verified" });
		const earlyIndex = h.updates.indexOf(early as Row);
		const doneIndex = h.updates.findIndex((update) =>
			(update.stepLog as StepLogEntry[] | undefined)?.some(
				(entry) => entry.kind === "CREATE_ENCODING" && entry.status === "DONE",
			),
		);
		expect(doneIndex).toBeGreaterThan(earlyIndex);
	});

	it("maps the provider-id barrier's ownership loss to the live lease-lost exit", async () => {
		let callbackResult: string | undefined;
		let h: ReturnType<typeof setup>;
		h = setup(
			{
				verificationKey: "verify:run-1:live-1:LIVE_CHANNEL",
				verificationRequestSha256: "e".repeat(64),
			},
			{},
			(args) =>
				fakeSdk({
					createEncoding: vi.fn(async () => {
						h.row.provisionClaimedAt = new Date("2030-01-01T00:00:00.000Z");
						callbackResult = await args.stamp?.onEncodingCreated?.(
							"bm-live-lost-owner",
							"created",
						);
						if (callbackResult === "OWNERSHIP_LOST") {
							throw new VerificationProviderOwnershipLostError(
								"bm-live-lost-owner",
							);
						}
						return "bm-live-lost-owner";
					}),
				}),
		);
		expect(
			await h.process({ liveChannelId: CHANNEL_ID, action: "provision" }),
		).toMatchObject({ status: "PROVISIONING" });
		expect(callbackResult).toBe("OWNERSHIP_LOST");
		expect(h.updates.some((update) => update.status === "ERROR")).toBe(false);
	});

	it("serializes provider-id persistence with a concurrent lease renewal", async () => {
		vi.useFakeTimers();
		try {
			let callbackResult: string | undefined;
			const h = setup(
				{
					verificationKey: "verify:run-1:live-race:LIVE_CHANNEL",
					verificationRequestSha256: "9".repeat(64),
				},
				{},
				(args) =>
					fakeSdk({
						createEncoding: vi.fn(async () => {
							callbackResult = await args.stamp?.onEncodingCreated?.(
								"bm-live-race",
								"created",
							);
							if (callbackResult === "OWNERSHIP_LOST") {
								throw new VerificationProviderOwnershipLostError(
									"bm-live-race",
								);
							}
							return "bm-live-race";
						}),
					}),
			);
			h.deps.leaseRenewalIntervalMs = 1;
			let clockMs = Date.parse("2026-06-12T00:00:00.000Z");
			h.deps.now = () => new Date(clockMs++).toISOString();
			const updateMany = h.liveChannel.updateMany;
			const original = updateMany.getMockImplementation();
			if (!original)
				throw new Error("live updateMany carries no implementation");
			let releaseProviderWrite: (() => void) | undefined;
			const providerWriteGate = new Promise<void>((resolve) => {
				releaseProviderWrite = resolve;
			});
			let providerWriteEntered: (() => void) | undefined;
			const entered = new Promise<void>((resolve) => {
				providerWriteEntered = resolve;
			});
			let delayed = false;
			updateMany.mockImplementation(async (args) => {
				const hasProviderId = (
					args.data.stepLog as StepLogEntry[] | undefined
				)?.some(
					(entry) =>
						entry.kind === "CREATE_ENCODING" &&
						entry.status === "RUNNING" &&
						entry.resourceId === "bm-live-race",
				);
				if (hasProviderId && !delayed) {
					delayed = true;
					providerWriteEntered?.();
					await providerWriteGate;
				}
				return original(args);
			});
			const running = h.process({
				liveChannelId: CHANNEL_ID,
				action: "provision",
			});
			await entered;
			// Fire the ticker while the provider-id persist owns the old fence token.
			// Without one shared serialization boundary, renewal wins the CAS and
			// the healthy persist is misclassified as ownership loss.
			await vi.advanceTimersByTimeAsync(1);
			releaseProviderWrite?.();
			await expect(running).resolves.toMatchObject({ status: "RUNNING" });
			expect(callbackResult).toBe("PERSISTED");
		} finally {
			vi.useRealTimers();
		}
	});

	it("fails closed without an unhandled rejection when a lease renewal DB call rejects", async () => {
		vi.useFakeTimers();
		try {
			let createEntered: (() => void) | undefined;
			const entered = new Promise<void>((resolve) => {
				createEntered = resolve;
			});
			let releaseCreate: (() => void) | undefined;
			const gate = new Promise<void>((resolve) => {
				releaseCreate = resolve;
			});
			const h = setup(
				{
					verificationKey: "verify:run-1:live-renew-fail:LIVE_CHANNEL",
					verificationRequestSha256: "7".repeat(64),
				},
				{},
				() =>
					fakeSdk({
						createEncoding: vi.fn(async () => {
							createEntered?.();
							await gate;
							return "bm-live-after-renew-failure";
						}),
					}),
			);
			h.deps.leaseRenewalIntervalMs = 1;
			const original = h.liveChannel.updateMany.getMockImplementation();
			if (!original)
				throw new Error("live updateMany carries no implementation");
			let renewalRejected = false;
			h.liveChannel.updateMany.mockImplementation(async (args) => {
				const data = args.data as Record<string, unknown>;
				if (
					!renewalRejected &&
					"provisionClaimedAt" in data &&
					!("stepLog" in data) &&
					!("status" in data)
				) {
					renewalRejected = true;
					throw Object.assign(new Error("lease renewal DB unavailable"), {
						code: "P1001",
					});
				}
				return original(args);
			});
			const running = h.process({
				liveChannelId: CHANNEL_ID,
				action: "provision",
			});
			await entered;
			await vi.advanceTimersByTimeAsync(1);
			releaseCreate?.();
			await expect(running).resolves.toMatchObject({ status: "PROVISIONING" });
			expect(renewalRejected).toBe(true);
			expect(h.updates.some((update) => update.status === "ERROR")).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not classify a post-primary run-mirror P1001 as safe-to-compensate", async () => {
		let callbackResult: string | undefined;
		const h = setup(
			{
				verificationKey: "verify:run-1:live-mirror:LIVE_CHANNEL",
				verificationRequestSha256: "8".repeat(64),
			},
			{},
			(args) =>
				fakeSdk({
					createEncoding: vi.fn(async () => {
						callbackResult = await args.stamp?.onEncodingCreated?.(
							"bm-live-primary-landed",
							"created",
						);
						return "bm-live-primary-landed";
					}),
				}),
		);
		const original = h.liveChannelRun.update.getMockImplementation();
		if (!original) throw new Error("run mirror update has no implementation");
		let failedProviderMirror = false;
		h.liveChannelRun.update.mockImplementation(async (args) => {
			if (
				!failedProviderMirror &&
				(args.data as Record<string, unknown>).bitmovinEncodingId ===
					"bm-live-primary-landed"
			) {
				failedProviderMirror = true;
				throw Object.assign(new Error("run mirror database unavailable"), {
					code: "P1001",
				});
			}
			return original(args);
		});
		const warning = vi
			.spyOn(console, "warn")
			.mockImplementation(() => undefined);
		try {
			await expect(
				h.process({ liveChannelId: CHANNEL_ID, action: "provision" }),
			).resolves.toMatchObject({ status: "RUNNING" });
		} finally {
			warning.mockRestore();
		}
		expect(callbackResult).toBe("PERSISTED");
		expect(h.row.bitmovinEncodingId).toBe("bm-live-primary-landed");
		expect(h.sdk.stopLiveEncoding).not.toHaveBeenCalled();
		const persisted = (h.row.stepLog as StepLogEntry[]).find(
			(entry) => entry.kind === "CREATE_ENCODING",
		);
		expect(persisted?.response).toMatchObject({
			providerBarrier: {
				providerId: "bm-live-primary-landed",
				durability: "PROVIDER_ID_PERSISTED",
				runMirror: "PERSISTENCE_UNKNOWN_RETRY_PENDING",
			},
		});
	});

	it("classifies live P1001 before the provider-id write as safe-to-compensate", async () => {
		let callbackError: unknown;
		const h = setup(
			{
				verificationKey: "verify:run-1:live-1:LIVE_CHANNEL",
				verificationRequestSha256: "f".repeat(64),
			},
			{},
			(args) =>
				fakeSdk({
					createEncoding: vi.fn(async () => {
						try {
							await args.stamp?.onEncodingCreated?.(
								"bm-live-db-down",
								"created",
							);
						} catch (err) {
							callbackError = err;
							throw new VerificationProviderIdPersistenceError(
								"bm-live-db-down",
								"created",
								"DEFINITELY_NOT_PERSISTED",
								{ stop: "FAILED", delete: "SUCCEEDED" },
								err,
							);
						}
						return "bm-live-db-down";
					}),
				}),
		);
		const updateMany = h.liveChannel.updateMany;
		const original = updateMany.getMockImplementation();
		if (!original) {
			throw new Error("harness updateMany carries no implementation");
		}
		updateMany.mockImplementation(async (args) => {
			const hasUnpersistedId = (
				args.data.stepLog as StepLogEntry[] | undefined
			)?.some(
				(entry) =>
					entry.kind === "CREATE_ENCODING" &&
					entry.status === "RUNNING" &&
					entry.resourceId === "bm-live-db-down",
			);
			if (hasUnpersistedId) {
				throw Object.assign(new Error("database unreachable"), {
					code: "P1001",
				});
			}
			return original(args);
		});
		await expect(
			h.process({ liveChannelId: CHANNEL_ID, action: "provision" }),
		).rejects.toBeInstanceOf(VerificationProviderIdPersistenceError);
		expect(callbackError).toBeInstanceOf(
			VerificationProviderIdDefinitelyNotPersistedError,
		);
		const failed = (h.row.stepLog as StepLogEntry[]).find(
			(entry) => entry.kind === "CREATE_ENCODING",
		);
		expect(failed).toMatchObject({
			status: "FAILED",
			resourceId: "bm-live-db-down",
			response: {
				providerId: "bm-live-db-down",
				source: "created",
				durability: "DEFINITELY_NOT_PERSISTED",
				compensation: { stop: "FAILED", delete: "SUCCEEDED" },
			},
		});
	});
});

describe("provider lifecycle reconciliation — sweep, provision, effects (row #280)", () => {
	const NOW = "2026-06-12T00:00:00.000Z";
	const liveRow = {
		status: "RUNNING",
		bitmovinAccountId: ACCOUNT_ID,
		bitmovinEncodingId: "bm-live-enc",
		streamKey: "sk-1",
		encoderIp: "198.51.100.1",
	};
	const seedRun = (
		t: ReturnType<typeof setup>,
		over: Partial<(typeof t.runRows)[number]> = {},
	) => {
		const seeded = {
			id: "run-1",
			seq: 1,
			status: "RUNNING",
			bitmovinEncodingId: "bm-live-enc",
			heartbeatPollEpoch: 0,
			providerStatus: null,
			providerStatusObservedAt: null,
			providerUnknownSince: null,
			providerUnknownAlertedAt: null,
			providerTerminalAt: null,
			providerFeederStopsEnqueuedAt: null,
			lastHeartbeatAt: null,
			createdAt: new Date("2026-06-11T23:00:00.000Z"),
			...over,
		};
		if (t.runRows[0]?.id === LIVE_TO_VOD_RUN_ID) {
			Object.assign(t.runRows[0], seeded);
			return t.runRows[0] as NonNullable<(typeof t.runRows)[0]>;
		}
		t.runRows.push(seeded);
		return t.runRows[t.runRows.length - 1] as NonNullable<
			(typeof t.runRows)[0]
		>;
	};
	const macroFlush = () => new Promise<void>((r) => setTimeout(r, 0));
	// A fake-timer test that fails mid-way must not leak its clock into the
	// next test (a real-timer macroFlush under fake timers hangs forever).
	afterEach(() => {
		vi.useRealTimers();
	});

	it("RUNNING → UNKNOWN → RUNNING keeps the same identity, opens and closes the unknown window, and never greens or cleans up in between", async () => {
		const answers: Array<() => Promise<{ status: string }>> = [
			async () => ({ status: "RUNNING" }),
			async () => {
				throw new Error("ECONNRESET");
			},
			async () => ({ status: "RUNNING" }),
		];
		const t = setup(liveRow, {
			getEncodingStatus: vi.fn(() =>
				(answers.shift() ?? (async () => ({ status: "RUNNING" })))(),
			),
		});
		const run = seedRun(t);
		// Tick 1: confirmed.
		await expect(t.sweep()).resolves.toEqual({ polled: 1, failed: 0 });
		expect(run.providerStatus).toBe("RUNNING");
		expect(run.providerStatusObservedAt).toEqual(new Date(NOW));
		expect(run.providerUnknownSince).toBeNull();
		expect(run.heartbeatPollEpoch).toBe(1);
		// Tick 2: the readback fails → UNKNOWN. The heartbeat is still polled
		// (ingest health keeps flowing), but nothing about the run moves.
		await expect(t.sweep()).resolves.toEqual({ polled: 1, failed: 0 });
		expect(run.providerUnknownSince).toEqual(new Date(NOW));
		expect(run.providerStatus).toBe("RUNNING"); // last SUCCESSFUL word
		expect(run.providerTerminalAt).toBeNull();
		expect(run.status).toBe("RUNNING");
		expect(t.row.status).toBe("RUNNING");
		expect(t.row.bitmovinEncodingId).toBe("bm-live-enc");
		expect(t.row.streamKey).toBe("sk-1");
		expect(run.bitmovinEncodingId).toBe("bm-live-enc");
		expect(t.enqueueFeederJob).not.toHaveBeenCalled();
		// Tick 3: the provider answers again → the window closes on the SAME
		// run/encoding; no new run was created.
		await expect(t.sweep()).resolves.toEqual({ polled: 1, failed: 0 });
		expect(run.providerUnknownSince).toBeNull();
		expect(run.id).toBe("run-1");
		expect(t.runRows).toHaveLength(1);
		expect(t.liveChannelRun.create).not.toHaveBeenCalled();
		expect(t.sdk.getLiveHeartbeat).toHaveBeenCalledTimes(3);
	});

	it("RUNNING → UNKNOWN → TERMINAL reconciles the terminal state: run stamped, channel ERROR with coordinates cleared and id kept, feeders stopped, heartbeat NOT polled on that tick", async () => {
		const answers: Array<() => Promise<{ status: string }>> = [
			async () => ({ status: "RUNNING" }),
			async () => {
				throw new Error("504 Gateway Timeout");
			},
			async () => ({ status: "FINISHED" }),
		];
		const t = setup(liveRow, {
			getEncodingStatus: vi.fn(() =>
				(answers.shift() ?? (async () => ({ status: "FINISHED" })))(),
			),
		});
		const run = seedRun(t);
		await t.sweep();
		await t.sweep();
		expect(run.providerUnknownSince).toEqual(new Date(NOW));
		t.feederSession.findMany.mockResolvedValueOnce([{ id: "feed-9" }]);
		const heartbeatsBefore = vi.mocked(t.sdk.getLiveHeartbeat).mock.calls
			.length;
		await expect(t.sweep()).resolves.toEqual({
			polled: 0,
			failed: 0,
			terminal: 1,
		});
		expect(vi.mocked(t.sdk.getLiveHeartbeat).mock.calls.length).toBe(
			heartbeatsBefore,
		);
		expect(run.status).toBe("STOPPED");
		expect(run.providerTerminalAt).toEqual(new Date(NOW));
		expect(run.providerStatus).toBe("FINISHED");
		expect(run.providerUnknownSince).toBeNull();
		expect(t.row.status).toBe("STOPPED");
		expect(t.row.error).toBeNull();
		expect(t.row.streamKey).toBeNull();
		expect(t.row.encoderIp).toBeNull();
		expect(t.row.bitmovinEncodingId).toBe("bm-live-enc");
		expect(t.enqueueFeederJob).toHaveBeenCalledWith({
			feederSessionId: "feed-9",
			action: "stop",
		});
	});

	it("retries a terminal run's feeder-stop intent after the channel has already left RUNNING", async () => {
		const t = setup(liveRow, {
			getEncodingStatus: vi.fn(async () => ({ status: "FINISHED" })),
		});
		const run = seedRun(t);
		t.feederSession.findMany.mockResolvedValue([{ id: "feed-retry" }]);
		t.enqueueFeederJob.mockRejectedValueOnce(new Error("redis unavailable"));
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			await expect(t.sweep()).resolves.toEqual({
				polled: 0,
				failed: 0,
				terminal: 1,
			});
			expect(t.row.status).toBe("STOPPED");
			expect(run.providerTerminalAt).toEqual(new Date(NOW));
			expect(run.providerFeederStopsEnqueuedAt).toBeNull();

			// The production query is RUNNING-only; model the now-STOPPED channel's
			// absence while the separate terminal-run retry still executes first.
			t.liveChannel.findMany.mockResolvedValueOnce([]);
			await expect(t.sweep()).resolves.toEqual({ polled: 0, failed: 0 });
			expect(t.enqueueFeederJob).toHaveBeenCalledTimes(2);
			expect(run.providerFeederStopsEnqueuedAt).toEqual(new Date(NOW));
			expect(t.sdk.getEncodingStatus).toHaveBeenCalledTimes(1);
		} finally {
			errorSpy.mockRestore();
		}
	});

	it("UNKNOWN past grace persists and emits one transition even when the first observed tick is late", async () => {
		const failing = {
			getEncodingStatus: vi.fn(async () => {
				throw new Error("401 Unauthorized");
			}),
		};
		const nowMs = Date.parse(NOW);
		// Exactly at grace: the edge tick.
		const edge = setup(liveRow, failing);
		const edgeRun = seedRun(edge, {
			providerStatus: "RUNNING",
			providerUnknownSince: new Date(nowMs - 5 * 60_000),
		});
		const emitAtEdge = vi.fn(async () => {});
		const sweepAtEdge = createLiveHeartbeatSweep({
			...edge.deps,
			emitEvent: emitAtEdge,
		});
		await sweepAtEdge();
		expect(emitAtEdge).toHaveBeenCalledTimes(1);
		expect(emitAtEdge).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: "CHANNEL_ERROR",
				liveChannelId: CHANNEL_ID,
				error: expect.stringMatching(/unconfirmed since/),
			}),
		);
		expect(edgeRun.providerUnknownAlertedAt).toEqual(new Date(NOW));
		await sweepAtEdge();
		expect(emitAtEdge).toHaveBeenCalledTimes(1);
		// One tick short of grace: nothing yet.
		const early = setup(liveRow, failing);
		const earlyRun = seedRun(early, {
			providerStatus: "RUNNING",
			providerUnknownSince: new Date(nowMs - 5 * 60_000 + 1),
		});
		const emitEarly = vi.fn(async () => {});
		await createLiveHeartbeatSweep({ ...early.deps, emitEvent: emitEarly })();
		expect(emitEarly).not.toHaveBeenCalled();
		expect(earlyRun.providerUnknownAlertedAt).toBeNull();
		// Well past the edge: a worker outage must not lose the transition.
		const late = setup(liveRow, failing);
		const lateRun = seedRun(late, {
			providerStatus: "RUNNING",
			providerUnknownSince: new Date(nowMs - 5 * 60_000 - 30_000),
		});
		const emitLate = vi.fn(async () => {});
		await createLiveHeartbeatSweep({ ...late.deps, emitEvent: emitLate })();
		expect(emitLate).toHaveBeenCalledTimes(1);
		expect(lateRun.providerUnknownAlertedAt).toEqual(new Date(NOW));
		// And the channel stayed RUNNING with every id throughout: an alert is
		// not a cleanup.
		for (const h of [edge, early, late]) {
			expect(h.row.status).toBe("RUNNING");
			expect(h.row.bitmovinEncodingId).toBe("bm-live-enc");
			expect(h.runRows[0]?.providerTerminalAt).toBeNull();
		}
	});

	it("heartbeat A times out → B succeeds → A completes late: A's sample, history row, alert evaluation AND state-change log line are all discarded (MEDIUM-1)", async () => {
		vi.useFakeTimers();
		// The state-change log narrates the sample that LANDED, never a fenced-out
		// late result: A's late answer would otherwise log the same "(none) →
		// CONNECTED" transition B already logged — a transition the row never
		// carried from A (review rev405 R1).
		const info = vi.spyOn(console, "info").mockImplementation(() => {});
		const heartbeatLines = () =>
			info.mock.calls
				.map((call) => String(call[0]))
				.filter((line) => line.includes("heartbeat"));
		try {
			const t = setup(liveRow);
			const run = seedRun(t);
			let releaseA: ((raw: LiveHeartbeatSample) => void) | undefined;
			const okRaw: LiveHeartbeatSample = {
				timestamp: "2026-06-12T00:00:00Z",
				ingest: { status: "CONNECTED", healthy: true },
				events: [],
			};
			vi.mocked(t.sdk.getLiveHeartbeat)
				.mockImplementationOnce(
					() =>
						new Promise<LiveHeartbeatSample>((resolve) => {
							releaseA = resolve;
						}),
				)
				.mockImplementationOnce(async () => okRaw);
			const alertEngine = vi.fn(async () => ({ opened: 0, resolved: 0 }));
			// Two sweep instances = two worker processes: each has its own
			// single-flight guard, so only the DB token separates them.
			const sweepA = createLiveHeartbeatSweep({
				...t.deps,
				alertEngine,
				perChannelTimeoutMs: 5_000,
			});
			const sweepB = createLiveHeartbeatSweep({
				...t.deps,
				alertEngine,
				perChannelTimeoutMs: 5_000,
			});
			const a = sweepA();
			// Under fake timers a real-timer flush would hang; advancing the
			// clock by a tick runs the queued microtasks the same way.
			await vi.advanceTimersByTimeAsync(1);
			expect(run.heartbeatPollEpoch).toBe(1); // A's claim
			expect(releaseA).toBeDefined();
			await vi.advanceTimersByTimeAsync(5_001);
			await expect(a).resolves.toEqual({ polled: 0, failed: 1 });
			// B claims the channel (epoch 2) and lands its sample.
			await expect(sweepB()).resolves.toEqual({ polled: 1, failed: 0 });
			expect(run.heartbeatPollEpoch).toBe(2);
			expect(run.lastHeartbeat).toBeTruthy();
			expect(t.liveHeartbeat.create).toHaveBeenCalledTimes(1);
			expect(alertEngine).toHaveBeenCalledTimes(1);
			const landedAt = run.lastHeartbeatAt;
			// B's landed sample logged the ONE transition (the channel had no
			// sample before it).
			const linesAfterB = heartbeatLines();
			expect(linesAfterB).toEqual([
				`[live-channel] ${CHANNEL_ID} heartbeat ingest (none) → CONNECTED`,
			]);
			// A's poll finally settles — with epoch 1 against a row at epoch 2.
			releaseA?.({ ...okRaw, timestamp: "2026-06-11T23:59:00Z" });
			await vi.advanceTimersByTimeAsync(1);
			await vi.advanceTimersByTimeAsync(1);
			expect(t.liveHeartbeat.create).toHaveBeenCalledTimes(1);
			expect(alertEngine).toHaveBeenCalledTimes(1);
			expect(run.lastHeartbeatAt).toBe(landedAt);
			expect(
				(run.lastHeartbeat as { raw: LiveHeartbeatSample }).raw.timestamp,
			).toBe("2026-06-12T00:00:00Z");
			// The channel column was not repainted by A either.
			const columnWrites = t.updates.filter((u) => "lastHeartbeat" in u);
			expect(columnWrites).toHaveLength(1);
			// …and A's discarded result narrated nothing: the log is B's alone.
			expect(heartbeatLines()).toEqual(linesAfterB);
		} finally {
			info.mockRestore();
			vi.useRealTimers();
		}
	});

	it("two concurrent sweeps → one poll per channel: the second claim loses the epoch CAS and polls nothing", async () => {
		const t = setup(liveRow);
		const run = seedRun(t);
		const sweepA = createLiveHeartbeatSweep(t.deps);
		const sweepB = createLiveHeartbeatSweep(t.deps);
		const [a, b] = await Promise.all([sweepA(), sweepB()]);
		expect([a, b]).toEqual(
			expect.arrayContaining([
				{ polled: 1, failed: 0 },
				{ polled: 0, failed: 0, claimSkipped: 1 },
			]),
		);
		expect(t.sdk.getLiveHeartbeat).toHaveBeenCalledTimes(1);
		expect(t.sdk.getEncodingStatus).toHaveBeenCalledTimes(1);
		expect(run.heartbeatPollEpoch).toBe(1);
	});

	it("a lifecycle observation fenced out by a newer epoch is discarded before a failing heartbeat can relabel it", async () => {
		let runRef: { heartbeatPollEpoch?: number } | undefined;
		const t = setup(liveRow, {
			getEncodingStatus: vi.fn(async () => {
				if (runRef) runRef.heartbeatPollEpoch = 2;
				return { status: "RUNNING" };
			}),
			getLiveHeartbeat: vi.fn(async () => {
				throw new Error("must not poll after losing lifecycle fence");
			}),
		});
		runRef = seedRun(t);
		await expect(t.sweep()).resolves.toEqual({
			polled: 0,
			failed: 0,
			discarded: 1,
		});
		expect(t.sdk.getLiveHeartbeat).not.toHaveBeenCalled();
		expect(t.liveHeartbeat.create).not.toHaveBeenCalled();
	});

	it("an old run's sample is never written to a NEW run — the token binds the poll to the run and encoding it read", async () => {
		const t = setup(liveRow);
		const oldRun = seedRun(t);
		let release: ((raw: LiveHeartbeatSample) => void) | undefined;
		vi.mocked(t.sdk.getLiveHeartbeat).mockImplementationOnce(
			() =>
				new Promise<LiveHeartbeatSample>((resolve) => {
					release = resolve;
				}),
		);
		const sweep = createLiveHeartbeatSweep({
			...t.deps,
			perChannelTimeoutMs: 60_000,
		});
		const pending = sweep();
		await macroFlush();
		// Re-air while the poll hangs: the old run ends, a new run with a new
		// encoding takes the channel.
		oldRun.status = "STOPPED";
		const newRun = seedRun(t, {
			id: "run-2",
			seq: 2,
			bitmovinEncodingId: "bm-live-enc-2",
		});
		t.row.bitmovinEncodingId = "bm-live-enc-2";
		t.row.lastHeartbeat = null;
		release?.({
			timestamp: "2026-06-11T23:59:00Z",
			ingest: { status: "CONNECTED", healthy: true },
			events: [],
		});
		await pending;
		expect(newRun.lastHeartbeat).toBeFalsy();
		expect(newRun.lastHeartbeatAt).toBeFalsy();
		// The channel column (the UI's fallback for a run with no sample yet)
		// did not inherit the previous encoding's sample either.
		expect(t.row.lastHeartbeat).toBeNull();
		// The sample was polled for bm-live-enc, never for the new encoding.
		expect(t.sdk.getLiveHeartbeat).toHaveBeenCalledWith("bm-live-enc");
		expect(t.sdk.getLiveHeartbeat).not.toHaveBeenCalledWith("bm-live-enc-2");
	});

	it("UNKNOWN: Stop succeeds; SCTE-35, timeshift, slate insertion and a scheduled feeder start are refused retryably; ids, coordinates and the run stay put", async () => {
		const t = setup(liveRow, {
			getEncodingStatus: vi.fn(async () => ({ status: "FINISHED" })),
		});
		const run = seedRun(t, {
			providerStatus: "RUNNING",
			providerUnknownSince: new Date(Date.parse(NOW) - 60_000),
		});
		for (const job of [
			{ action: "scte35", params: { cueDuration: 30 } },
			{ action: "reset-timeshift", params: {} },
			{
				action: "insert-content",
				params: {
					insertableContentId: "00000000-0000-4000-8000-00000000ce01",
					durationSeconds: 30,
				},
			},
			{
				action: "feeder-start",
				params: {
					scheduleId: "33333333-3333-4333-8333-333333333333",
					source: {
						credentialId: "00000000-0000-4000-8000-0000000000c1",
						bucket: "in",
						key: "slate.mp4",
					},
				},
			},
		] as const) {
			await expect(
				t.process({ liveChannelId: CHANNEL_ID, ...job }),
			).rejects.toThrow(
				/refused: the provider's status .* cannot be confirmed/,
			);
		}
		expect(t.sdk.insertScte35Cue).not.toHaveBeenCalled();
		expect(t.sdk.resetLiveManifestTimeshift).not.toHaveBeenCalled();
		expect(t.sdk.scheduleInsertableContent).not.toHaveBeenCalled();
		expect(t.feederSession.create).not.toHaveBeenCalled();
		expect(t.row.status).toBe("RUNNING");
		expect(t.row.bitmovinEncodingId).toBe("bm-live-enc");
		expect(t.row.streamKey).toBe("sk-1");
		expect(run.providerUnknownSince).not.toBeNull();
		// Stop is NOT gated: a channel we cannot see must stay stoppable (#48).
		await t.process({ liveChannelId: CHANNEL_ID, action: "stop" });
		expect(t.sdk.stopLiveEncoding).toHaveBeenCalledWith("bm-live-enc");
		expect(t.row.status).toBe("STOPPED");
	});

	it("a TERMINAL persisted view refuses new effects too, naming the fresh-run remedy", async () => {
		const t = setup(liveRow);
		seedRun(t, {
			providerStatus: "FINISHED",
			providerTerminalAt: new Date(NOW),
		});
		await expect(
			t.process({
				liveChannelId: CHANNEL_ID,
				action: "scte35",
				params: { cueDuration: 30 },
			}),
		).rejects.toThrow(/fresh run/);
		expect(t.sdk.insertScte35Cue).not.toHaveBeenCalled();
	});

	it("revalidates the exact fresh RUNNING run immediately before the slate POST", async () => {
		const t = setup(liveRow, {
			listScheduledInsertableContent: vi.fn(async () => {
				const current = t.runRows.at(-1);
				if (current) {
					current.providerStatus = "QUEUED";
					current.providerStatusObservedAt = new Date(NOW);
				}
				return [];
			}),
		});
		seedRun(t, {
			providerStatus: "RUNNING",
			providerStatusObservedAt: new Date(NOW),
		});

		await expect(
			t.process({
				liveChannelId: CHANNEL_ID,
				action: "insert-content",
				params: {
					insertableContentId: "00000000-0000-4000-8000-00000000ce01",
					durationSeconds: 30,
				},
			}),
		).rejects.toThrow(/not RUNNING/);
		expect(t.sdk.scheduleInsertableContent).not.toHaveBeenCalled();
	});

	it("refuses a slate POST when the current run changes after admission", async () => {
		const t = setup(liveRow, {
			listScheduledInsertableContent: vi.fn(async () => {
				t.runRows.push({
					id: "run-2",
					seq: 2,
					status: "RUNNING",
					bitmovinEncodingId: "bm-live-enc-2",
					providerStatus: "RUNNING",
					providerStatusObservedAt: new Date(NOW),
				});
				return [];
			}),
		});
		seedRun(t, {
			providerStatus: "RUNNING",
			providerStatusObservedAt: new Date(NOW),
		});

		await expect(
			t.process({
				liveChannelId: CHANNEL_ID,
				action: "insert-content",
				params: {
					insertableContentId: "00000000-0000-4000-8000-00000000ce01",
					durationSeconds: 30,
				},
			}),
		).rejects.toThrow(/run changed/);
		expect(t.sdk.scheduleInsertableContent).not.toHaveBeenCalled();
	});

	describe("provision entry and finalize (Start/revive)", () => {
		/** Every step DONE with a resource id: the revive that used to green. */
		function allDoneLog(encodingId: string) {
			const plan = structuredClone(basePlan);
			plan.bitmovin.accountId = ACCOUNT_ID;
			const entries = initStepLog(compileLiveChannel(plan));
			let n = 0;
			for (const entry of entries) {
				entry.status = "DONE";
				// The RTMP input must match the fake account's ONE input, or the
				// stale-input guard (error 2025) rebuilds from the input step and
				// the replay is no longer the skip-everything revive under test.
				entry.resourceId =
					entry.kind === "CREATE_ENCODING"
						? encodingId
						: entry.kind === "CREATE_INPUT_RTMP"
							? "bm-rtmp-default"
							: `bm-${++n}`;
			}
			return entries;
		}

		it("the observed sequence, step 3: Start (revive) of a run whose encoding is FINISHED at the provider never writes RUNNING — the run is terminalised and the provision fails naming a fresh run; start/restart calls 0", async () => {
			const t = setup(
				{
					status: "PROVISIONING",
					bitmovinAccountId: ACCOUNT_ID,
					bitmovinEncodingId: "bm-live-enc",
					streamKey: "old-key",
					encoderIp: "198.51.100.1",
					stepLog: allDoneLog("bm-live-enc"),
				},
				{ getEncodingStatus: vi.fn(async () => ({ status: "FINISHED" })) },
			);
			const run = seedRun(t, { status: "PROVISIONING" });
			await expect(
				t.process({ liveChannelId: CHANNEL_ID, action: "provision" }),
			).rejects.toThrow(/FINISHED/);
			expect(t.sdk.startLiveEncoding).not.toHaveBeenCalled();
			expect(t.sdk.restartLiveEncoding).not.toHaveBeenCalled();
			expect(t.sdk.getLiveEncodingDetails).not.toHaveBeenCalled();
			expect(t.updates.map((u) => u.status)).not.toContain("RUNNING");
			expect(t.row.status).toBe("ERROR");
			expect(t.row.error).toMatch(/fresh run/);
			expect(t.row.provisionClaimedAt).toBeNull();
			expect(t.row.streamKey).toBeNull();
			expect(t.row.bitmovinEncodingId).toBe("bm-live-enc");
			expect(run.status).toBe("ERROR");
			expect(run.providerTerminalAt).toBeInstanceOf(Date);
			expect(run.providerStatus).toBe("FINISHED");
		});

		it("a revive whose provider readback is UNKNOWN is refused retryably with every id kept — the DONE step log is not replayed against an encoding we cannot see", async () => {
			const t = setup(
				{
					status: "PROVISIONING",
					bitmovinAccountId: ACCOUNT_ID,
					bitmovinEncodingId: "bm-live-enc",
					stepLog: allDoneLog("bm-live-enc"),
				},
				{
					getEncodingStatus: vi.fn(async () => {
						throw new Error("request timed out after 10000ms");
					}),
				},
			);
			const run = seedRun(t, { status: "PROVISIONING" });
			await expect(
				t.process({ liveChannelId: CHANNEL_ID, action: "provision" }),
			).rejects.toThrow(/cannot be confirmed/);
			expect(t.row.status).toBe("ERROR");
			expect(t.row.error).toMatch(/retry/);
			expect(t.row.bitmovinEncodingId).toBe("bm-live-enc");
			expect(run.providerTerminalAt).toBeNull();
			expect(run.providerUnknownSince).toBeInstanceOf(Date);
			expect(run.bitmovinEncodingId).toBe("bm-live-enc");
		});

		it("a revive whose encoding reads back RUNNING proceeds and stamps the licensing observation on the run", async () => {
			const t = setup({
				status: "PROVISIONING",
				bitmovinAccountId: ACCOUNT_ID,
				bitmovinEncodingId: "bm-live-enc",
				stepLog: allDoneLog("bm-live-enc"),
			});
			const run = seedRun(t, { status: "PROVISIONING" });
			const result = await t.process({
				liveChannelId: CHANNEL_ID,
				action: "provision",
			});
			expect(result).toMatchObject({ status: "RUNNING" });
			expect(t.row.status).toBe("RUNNING");
			expect(run.providerStatus).toBe("RUNNING");
			expect(run.providerStatusObservedAt).toBeInstanceOf(Date);
			// A true revive: nothing was recreated, the DONE log was replayed.
			expect(t.sdk.createEncoding).not.toHaveBeenCalled();
			expect(t.sdk.startLiveEncoding).not.toHaveBeenCalled();
		});

		it("finalize clears stale ingest coordinates when the fresh details omit them", async () => {
			const t = setup(
				{
					status: "PROVISIONING",
					bitmovinAccountId: ACCOUNT_ID,
					bitmovinEncodingId: "bm-live-enc",
					streamKey: "stale-key",
					encoderIp: "198.51.100.1",
					stepLog: allDoneLog("bm-live-enc"),
				},
				{
					getLiveEncodingDetails: vi.fn(async () => ({ application: "live" })),
				},
			);
			const run = seedRun(t, {
				status: "PROVISIONING",
				streamKey: "stale-key",
				encoderIp: "198.51.100.1",
			});

			await t.process({ liveChannelId: CHANNEL_ID, action: "provision" });

			expect(t.row.streamKey).toBeNull();
			expect(t.row.encoderIp).toBeNull();
			expect(run.streamKey).toBeNull();
			expect(run.encoderIp).toBeNull();
		});

		it("start-request delay race: a provider readback that becomes UNKNOWN never commits local RUNNING", async () => {
			let startRequestReturned = false;
			const t = setup(
				{
					status: "PROVISIONING",
					bitmovinAccountId: ACCOUNT_ID,
					bitmovinEncodingId: "bm-live-enc",
					stepLog: allDoneLog("bm-live-enc"),
				},
				{
					getEncodingStatus: vi.fn(async () => {
						if (startRequestReturned) {
							throw new Error("provider status timed out after details");
						}
						return { status: "RUNNING" };
					}),
					getLiveStartRequest: vi.fn(async () => {
						startRequestReturned = true;
						return { streamKey: "redacted" } as never;
					}),
				},
			);
			const run = seedRun(t, { status: "PROVISIONING" });

			await expect(
				t.process({ liveChannelId: CHANNEL_ID, action: "provision" }),
			).rejects.toThrow(/timed out after details/);

			expect(t.updates.map((u) => u.status)).not.toContain("RUNNING");
			expect(t.row.status).toBe("ERROR");
			expect(run.providerUnknownSince).toBeInstanceOf(Date);
			expect(t.sdk.getEncodingStatus).toHaveBeenCalledTimes(3);
		});

		it("finalize refuses to write RUNNING when the fresh readback is terminal — the details GET answering is not a lifecycle observation", async () => {
			// Entry reconcile says RUNNING; by finalize the encoding has ended.
			const statuses = ["RUNNING", "FINISHED"];
			const t = setup(
				{
					status: "PROVISIONING",
					bitmovinAccountId: ACCOUNT_ID,
					bitmovinEncodingId: "bm-live-enc",
					stepLog: allDoneLog("bm-live-enc"),
				},
				{
					getEncodingStatus: vi.fn(async () => ({
						status: statuses.shift() ?? "FINISHED",
					})),
				},
			);
			const run = seedRun(t, { status: "PROVISIONING" });
			await expect(
				t.process({ liveChannelId: CHANNEL_ID, action: "provision" }),
			).rejects.toThrow(/FINISHED/);
			expect(t.sdk.getLiveEncodingDetails).not.toHaveBeenCalled();
			expect(t.updates.map((u) => u.status)).not.toContain("RUNNING");
			expect(t.row.status).toBe("ERROR");
			expect(run.providerTerminalAt).toBeInstanceOf(Date);
			// The failed-start sample was still recorded for the startup profile.
			expect(t.startupSample.create).toHaveBeenCalled();
		});
	});
});

it("journals, stops and acknowledges a deferred Live CREATE after reset erases its row", async () => {
	let resolveCreate!: (id: string) => void;
	const create = vi.fn(
		() =>
			new Promise<string>((resolve) => {
				resolveCreate = resolve;
			}),
	);
	const t = setup({}, { createEncoding: create });
	const journal = vi.fn(async () => true);
	const ack = vi.fn(async () => {});
	t.deps.journalResetEncoding = journal;
	t.deps.acknowledgeResetEntity = ack;
	const pending = t.process({ liveChannelId: CHANNEL_ID, action: "provision" });
	await vi.waitFor(() => expect(create).toHaveBeenCalled());
	t.liveChannel.findUnique.mockResolvedValue(null);
	t.liveChannel.updateMany.mockResolvedValue({ count: 0 });
	resolveCreate("late-live");
	await expect(pending).resolves.toMatchObject({ status: "PROVISIONING" });
	expect(journal).toHaveBeenCalledWith(
		`liveChannel:${CHANNEL_ID}`,
		"late-live",
		ACCOUNT_ID,
	);
	expect(t.sdk.stopLiveEncoding).toHaveBeenCalledWith("late-live");
	expect(ack).toHaveBeenCalledWith(
		`liveChannel:${CHANNEL_ID}`,
		expect.any(String),
	);
	expect(t.sdk.startLiveEncoding).not.toHaveBeenCalled();
});

it("journals and stops a deferred RESTART after reset, then acknowledges its exact effect token", async () => {
	let release!: () => void;
	const restart = vi.fn(
		() =>
			new Promise<void>((resolve) => {
				release = resolve;
			}),
	);
	const t = setup(
		{
			status: "PROVISIONING",
			bitmovinAccountId: ACCOUNT_ID,
			bitmovinEncodingId: "bm-live-enc",
		},
		{ restartLiveEncoding: restart },
	);
	t.runRows.push({
		id: "run-1",
		seq: 1,
		status: "RUNNING",
		bitmovinEncodingId: "bm-live-enc",
		heartbeatPollEpoch: 0,
		providerStatus: null,
		providerStatusObservedAt: null,
		providerUnknownSince: null,
		providerUnknownAlertedAt: null,
		providerTerminalAt: null,
		providerFeederStopsEnqueuedAt: null,
	});
	const journal = vi.fn(async () => true);
	const ack = vi.fn(async () => {});
	t.deps.journalResetEncoding = journal;
	t.deps.acknowledgeResetEntity = ack;
	Object.assign(t.deps.prisma, {
		liveEffectClaim: { findUnique: vi.fn(async () => null) },
	});
	const pending = t.process({ liveChannelId: CHANNEL_ID, action: "restart" });
	await vi.waitFor(() => expect(restart).toHaveBeenCalled());
	t.liveChannel.findUnique.mockResolvedValue(null);
	t.liveChannel.updateMany.mockResolvedValue({ count: 0 });
	t.runRows.length = 0;
	release();
	await pending;
	expect(journal).toHaveBeenCalledWith(
		expect.stringMatching(/^liveEffectClaim:/),
		"bm-live-enc",
		ACCOUNT_ID,
	);
	expect(t.sdk.stopLiveEncoding).toHaveBeenCalledWith("bm-live-enc");
	expect(t.sdk.stopEncoding).not.toHaveBeenCalled();
	expect(ack).toHaveBeenCalledWith(
		expect.stringMatching(/^liveEffectClaim:/),
		expect.stringMatching(/^token:/),
	);
	expect(journal.mock.invocationCallOrder[0]).toBeLessThan(
		ack.mock.invocationCallOrder[0] as number,
	);
});

function cancelCurrentRun(h: ReturnType<typeof setup>) {
	const run = h.runRows[0];
	if (!run) throw new Error("Expected current fixture run");
	run.cancelRequested = true;
}

describe("cooperative startup cancellation", () => {
	it("does not START after cancellation arrives during CREATE_ENCODING", async () => {
		const h = setup();
		h.sdk.createEncoding = vi.fn(async () => {
			cancelCurrentRun(h);
			return "bm-live-enc";
		});
		h.sdk.getEncodingStatus = vi.fn(async () => ({ status: "CREATED" }));
		await expect(
			h.process({ liveChannelId: CHANNEL_ID }),
		).resolves.toMatchObject({ status: "STOPPED" });
		expect(h.sdk.startLiveEncoding).not.toHaveBeenCalled();
		expect(h.row.status).toBe("STOPPED");
		expect(h.row.encoderStoppedConfirmedFor).toBe("bm-live-enc");
	});
	it("automatically stops when cancellation arrives while queued after START", async () => {
		const h = setup();
		let stopping = false;
		h.sdk.startLiveEncoding = vi.fn(async () => {
			cancelCurrentRun(h);
		});
		h.sdk.stopLiveEncoding = vi.fn(async () => {
			stopping = true;
		});
		h.sdk.getEncodingStatus = vi.fn(async () => ({
			status: stopping ? "FINISHED" : "QUEUED",
		}));
		await expect(
			h.process({ liveChannelId: CHANNEL_ID }),
		).resolves.toMatchObject({ status: "STOPPED" });
		expect(h.sdk.stopLiveEncoding).toHaveBeenCalledWith("bm-live-enc");
		expect(h.sdk.getLiveEncodingDetails).not.toHaveBeenCalled();
	});
});

describe("startup cancellation races and redelivery", () => {
	it("recovers a lost CREATE response then stops without submitting START", async () => {
		const h = setup();
		let calls = 0;
		h.sdk.createEncoding = vi.fn(async () => {
			cancelCurrentRun(h);
			if (++calls === 1) throw new Error("lost response");
			return "adopted-original";
		});
		h.sdk.getEncodingStatus = vi.fn(async () => ({ status: "CREATED" }));
		await expect(
			h.process({ liveChannelId: CHANNEL_ID }),
		).resolves.toMatchObject({ status: "STOPPED" });
		expect(h.row.bitmovinEncodingId).toBe("adopted-original");
		expect(h.sdk.startLiveEncoding).not.toHaveBeenCalled();
	});
	it("keeps failed stop pending for automatic retry, never false STOPPED", async () => {
		const h = setup();
		h.runRows.push({ id: LIVE_TO_VOD_RUN_ID, seq: 1, status: "CREATED" });
		h.sdk.startLiveEncoding = vi.fn(async () => {
			cancelCurrentRun(h);
		});
		h.sdk.getEncodingStatus = vi.fn(async () => ({ status: "QUEUED" }));
		h.sdk.stopLiveEncoding = vi.fn(async () => {
			throw new Error("not running yet");
		});
		await expect(
			h.process({ liveChannelId: CHANNEL_ID }),
		).resolves.toMatchObject({ status: "STOPPING" });
		expect(h.row.status).toBe("STOPPING");
		expect(h.runRows[0]?.cancelRequested).toBe(true);
		expect(h.row.encoderStoppedConfirmedFor).not.toBe("bm-live-enc");
		h.sdk.stopLiveEncoding = vi.fn(async () => {});
		h.sdk.getEncodingStatus = vi.fn(async () => ({ status: "FINISHED" }));
		await expect(
			h.process({
				liveChannelId: CHANNEL_ID,
				params: { cancelRunId: LIVE_TO_VOD_RUN_ID },
			}),
		).resolves.toMatchObject({ status: "STOPPED" });
		expect(h.sdk.startLiveEncoding).toHaveBeenCalledTimes(1);
	});
	it("ignores a cancellation-only delivery for an old run", async () => {
		const h = setup();
		h.runRows.push({
			id: LIVE_TO_VOD_RUN_ID,
			seq: 2,
			status: "PROVISIONING",
			cancelRequested: false,
		});
		await expect(
			h.process({
				liveChannelId: CHANNEL_ID,
				params: { cancelRunId: "00000000-0000-4000-8000-0000000000dd" },
			}),
		).resolves.toMatchObject({ status: "STALE_CANCEL" });
		expect(h.sdk.createEncoding).not.toHaveBeenCalled();
		expect(h.row.status).toBe("CREATED");
	});
});

describe("startup cancellation checkpoints and recovery ownership", () => {
	it("cancels an untouched queued run without needing account credentials", async () => {
		const h = setup({ status: "STOPPING" });
		h.runRows.push({
			id: LIVE_TO_VOD_RUN_ID,
			seq: 1,
			status: "STOPPING",
			cancelRequested: true,
		});
		h.deps.revealBitmovinAccount = vi.fn(async () => {
			throw new Error("account was deleted");
		});
		await expect(
			h.process({
				liveChannelId: CHANNEL_ID,
				params: { cancelRunId: LIVE_TO_VOD_RUN_ID },
			}),
		).resolves.toMatchObject({ status: "STOPPED" });
		expect(h.deps.revealBitmovinAccount).not.toHaveBeenCalled();
		expect(h.sdk.createEncoding).not.toHaveBeenCalled();
	});
	it("checks cancellation again after credential resolution, before the first START send", async () => {
		const h = setup();
		const entries = h.row.stepLog as StepLogEntry[];
		const start = entries.find((entry) => entry.kind === "START_LIVE_ENCODING");
		if (!start) throw new Error("Expected START fixture step");
		start.payload.esamSettings = {
			poisCredentialId: LIVE_TO_VOD_RUN_ID,
			poisEndpoint: "https://pois.example.invalid",
		};
		const ordinary = h.deps.resolveCredential;
		h.deps.resolveCredential = vi.fn(async (id) => {
			if (id !== LIVE_TO_VOD_RUN_ID) return ordinary(id);
			cancelCurrentRun(h);
			return {
				provider: "POIS_ENDPOINT",
				config: {},
				secret: { username: "test", password: "test" },
			};
		});
		h.sdk.getEncodingStatus = vi.fn(async () => ({ status: "CREATED" }));
		await expect(
			h.process({ liveChannelId: CHANNEL_ID }),
		).resolves.toMatchObject({ status: "STOPPED" });
		expect(h.sdk.startLiveEncoding).not.toHaveBeenCalled();
		expect(h.sdk.stopLiveEncoding).not.toHaveBeenCalled();
	});
	it("keeps the cancelled ERROR run on restart recovery rather than creating a new run", async () => {
		const h = setup({
			status: "ERROR",
			bitmovinEncodingId: "bm-live-enc",
			bitmovinAccountId: ACCOUNT_ID,
		});
		h.row.stepLog = (h.row.stepLog as StepLogEntry[]).map((entry) => ({
			...entry,
			status: "DONE",
			resourceId: entry.kind === "CREATE_ENCODING" ? "bm-live-enc" : undefined,
		}));
		h.runRows.push({
			id: LIVE_TO_VOD_RUN_ID,
			seq: 1,
			status: "ERROR",
			cancelRequested: true,
			bitmovinEncodingId: "bm-live-enc",
		});
		h.sdk.getEncodingStatus = vi.fn(async () => ({ status: "FINISHED" }));
		await expect(
			h.process({
				liveChannelId: CHANNEL_ID,
				params: { cancelRunId: LIVE_TO_VOD_RUN_ID },
			}),
		).resolves.toMatchObject({
			status: "STOPPED",
		});
		expect(h.runRows).toHaveLength(1);
		expect(h.runRows[0]?.id).toBe(LIVE_TO_VOD_RUN_ID);
		expect(h.sdk.createEncoding).not.toHaveBeenCalled();
		expect(h.sdk.startLiveEncoding).not.toHaveBeenCalled();
	});
	it("does not claim STOPPED if the lost CREATE cannot yet be identified", async () => {
		const h = setup();
		h.sdk.createEncoding = vi.fn(async () => {
			cancelCurrentRun(h);
			throw new Error("provider lookup unavailable");
		});
		await expect(
			h.process({ liveChannelId: CHANNEL_ID }),
		).resolves.toMatchObject({ status: "STOPPING" });
		expect(h.row.status).toBe("STOPPING");
		expect(h.sdk.startLiveEncoding).not.toHaveBeenCalled();
	});
});

describe("reviewed startup cancellation race fences", () => {
	it.each([
		false,
		true,
	])("does not claim a newer run after its cancellation snapshot (generation changes=%s)", async (changeGeneration) => {
		const h = setup({ status: "STOPPING", liveEffectFenceVersion: 4 });
		h.runRows.push({
			id: LIVE_TO_VOD_RUN_ID,
			seq: 1,
			status: "STOPPING",
			cancelRequested: true,
		});
		const original = h.liveChannel.updateMany.getMockImplementation();
		if (!original) throw new Error("Missing channel CAS fixture");
		let raced = false;
		h.liveChannel.updateMany.mockImplementation(async (args) => {
			if (!raced && args.where.OR) {
				raced = true;
				h.row.status = "PROVISIONING";
				if (changeGeneration) h.row.liveEffectFenceVersion = 5;
				h.runRows.push({
					id: "00000000-0000-4000-8000-0000000000dd",
					seq: 2,
					status: "PROVISIONING",
					cancelRequested: false,
				});
			}
			return original(args);
		});
		await h.process({
			liveChannelId: CHANNEL_ID,
			params: { cancelRunId: LIVE_TO_VOD_RUN_ID },
		});
		expect(h.row.status).toBe("PROVISIONING");
		expect(h.row.provisionClaimedAt ?? null).toBeNull();
		expect(h.runRows[1]?.status).toBe("PROVISIONING");
		expect(h.sdk.createEncoding).not.toHaveBeenCalled();
	});
	it("restores the verification active CREATE for adopt-only cancellation after restart", async () => {
		let callbackResult: string | undefined;
		const create = vi.fn();
		const h = setup(
			{
				status: "STOPPING",
				verificationKey: "verify:run-1:cancel:LIVE_CHANNEL",
				verificationRequestSha256: "a".repeat(64),
			},
			{},
			(args) =>
				fakeSdk({
					createEncoding: create.mockImplementation(async () => {
						expect(args.stamp?.allowCreate?.()).toBe(false);
						callbackResult = await args.stamp?.onEncodingCreated?.(
							"adopted-verified-original",
							"adopted",
						);
						return "adopted-verified-original";
					}),
					getEncodingStatus: vi.fn(async () => ({ status: "CREATED" })),
				}),
		);
		const entries = h.row.stepLog as StepLogEntry[];
		const encoding = entries.find((entry) => entry.kind === "CREATE_ENCODING");
		if (!encoding) throw new Error("Missing CREATE fixture");
		encoding.status = "RUNNING";
		encoding.startedAt = "2026-06-11T23:59:00.000Z";
		h.runRows.push({
			id: LIVE_TO_VOD_RUN_ID,
			seq: 1,
			status: "STOPPING",
			cancelRequested: true,
		});
		await expect(
			h.process({
				liveChannelId: CHANNEL_ID,
				params: { cancelRunId: LIVE_TO_VOD_RUN_ID },
			}),
		).resolves.toMatchObject({ status: "STOPPED" });
		expect(callbackResult).toBe("PERSISTED");
		expect(h.row.bitmovinEncodingId).toBe("adopted-verified-original");
		expect(create).toHaveBeenCalledTimes(1);
		expect(h.sdk.startLiveEncoding).not.toHaveBeenCalled();
	});
});
