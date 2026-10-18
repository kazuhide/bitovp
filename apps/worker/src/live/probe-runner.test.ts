import type { AppPrismaClient } from "@bitovp/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

const deleteUnderPrefix = vi.fn(async (_input: unknown) => ({
	deleted: 3,
}));
vi.mock("@bitovp/storage", async (orig) => ({
	...(await orig<Record<string, unknown>>()),
	probeReaperForCredential: () => ({
		deleteObjectsUnderPrefix: (input: unknown) => deleteUnderPrefix(input),
		verifyDeletePermission: async () => ({ ok: true, detail: "" }),
	}),
}));

import {
	createProbeBatchProcessor,
	PROBE_SETTING_KEY,
	reconcileAbandonedProbes,
} from "./probe-runner";

/**
 *  PR4 — the batch runner's contracts: serial execution, the
 * abandon deadline's CENSORED record, resume-by-name, reap scope, and the
 * cleanup-failure note. The fake advances its clock ON sleep and mutates
 * channel status per a per-channel SCRIPT — the runner only ever observes
 * what the "worker" did, exactly like production.
 */

const DESIGNATION = {
	credentialId: "00000000-0000-4000-8000-00000000c0de",
	bitmovinAccountId: "00000000-0000-4000-8000-00000000acc7",
	bucket: "probe-bucket",
	prefix: "probes/startup/",
	abandonDeadlineMinutes: 8,
};

type FakeChannel = {
	id: string;
	name: string;
	purpose: string | null;
	status: string;
	createdAtMs: number;
	updatedAtMs: number;
	runningSinceMs?: number | null;
	bitmovinEncodingId?: string | null;
};

function makeWorld(
	opts: {
		/** status sequence a channel walks through, one step per POLL. */
		script?: string[];
		designation?: Partial<typeof DESIGNATION> | null;
		channels?: FakeChannel[];
	} = {},
) {
	let clock = 1_000_000;
	const channels: FakeChannel[] = opts.channels ?? [];
	const samples = new Map<string, Record<string, unknown>>();
	const enqueued: Array<{
		job: { liveChannelId: string; action: string };
		dedupe: string;
	}> = [];
	const events: string[] = [];
	const runsByChannel = new Map<string, { id: string }>();
	const script = opts.script ?? [];
	let scriptIndex = 0;

	const prisma = {
		appSetting: {
			findUnique: vi.fn(async ({ where }: { where: { key: string } }) =>
				where.key === PROBE_SETTING_KEY && opts.designation !== null
					? { key: PROBE_SETTING_KEY, value: opts.designation ?? DESIGNATION }
					: null,
			),
		},
		liveChannel: {
			findFirst: vi.fn(
				async ({ where }: { where: { name: string } }) =>
					channels.find((c) => c.name === where.name) ?? null,
			),
			findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
				const hit = channels.find((c) => c.id === where.id);
				return hit ? { status: hit.status } : null;
			}),
			findMany: vi.fn(
				async ({
					where,
				}: {
					where: {
						status?: string;
						runningSince?: { not: null; lt: Date };
						bitmovinEncodingId?: { not: null };
						updatedAt?: { lt: Date };
					};
				}) =>
					channels
						.filter(
							(c) =>
								c.purpose === "PROBE" &&
								(!where.status || c.status === where.status) &&
								(!where.runningSince ||
									(c.runningSinceMs != null &&
										c.runningSinceMs < where.runningSince.lt.getTime())) &&
								(!where.bitmovinEncodingId || c.bitmovinEncodingId != null) &&
								(!where.updatedAt ||
									c.updatedAtMs < where.updatedAt.lt.getTime()),
						)
						.map((c) => ({ id: c.id })),
			),
			create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
				const created: FakeChannel = {
					id: data.id as string,
					name: data.name as string,
					purpose: data.purpose as string,
					status: data.status as string,
					createdAtMs: clock,
					updatedAtMs: clock,
				};
				channels.push(created);
				runsByChannel.set(created.id, { id: `run-${created.id.slice(0, 4)}` });
				events.push(`create:${created.name}`);
				return { id: created.id };
			}),
			updateMany: vi.fn(
				async ({
					where,
					data,
				}: {
					where: { id: string; status: string };
					data: { status: string };
				}) => {
					const hit = channels.find(
						(c) => c.id === where.id && c.status === where.status,
					);
					if (hit) {
						hit.status = data.status;
						events.push(`claim:${hit.name}:${data.status}`);
						return { count: 1 };
					}
					return { count: 0 };
				},
			),
		},
		liveChannelRun: {
			findFirst: vi.fn(
				async ({ where }: { where: { liveChannelId: string } }) =>
					runsByChannel.get(where.liveChannelId) ?? null,
			),
			updateMany: vi.fn(async () => ({ count: 1 })),
		},
		startupSample: {
			findFirst: vi.fn(
				async ({ where }: { where: { failedPhase?: string } }) =>
					[...samples.values()].find(
						(row) => row.failedPhase === where.failedPhase,
					) ?? null,
			),
			findUnique: vi.fn(
				async ({ where }: { where: { liveChannelRunId: string } }) =>
					samples.get(where.liveChannelRunId) ?? null,
			),
			create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
				samples.set(
					(data.liveChannelRunId as string) ?? (data.failedPhase as string),
					data,
				);
				events.push(`sample:${data.outcome}`);
				return data;
			}),
			update: vi.fn(
				async ({
					where,
					data,
				}: {
					where: { liveChannelRunId: string };
					data: Record<string, unknown>;
				}) => {
					const row = samples.get(where.liveChannelRunId) ?? {};
					samples.set(where.liveChannelRunId, { ...row, ...data });
					return data;
				},
			),
		},
	};

	const processor = createProbeBatchProcessor({
		prisma: prisma as unknown as AppPrismaClient,
		enqueueLiveJob: async (job, dedupe) => {
			enqueued.push({ job, dedupe });
			events.push(`enqueue:${job.action}`);
		},
		resolveCredential: async () => ({
			provider: "AWS_S3",
			config: {},
			secret: { accessKeyId: "a", secretAccessKey: "s" },
		}),
		now: () => new Date(clock),
		sleep: async (ms) => {
			clock += ms;
			// One script step per poll-sleep: the "worker" advances the newest
			// non-terminal probe.
			const target = channels.findLast(
				(c) => c.status !== "STOPPED" && c.status !== "ERROR",
			);
			if (target && scriptIndex < script.length) {
				const next = script[scriptIndex];
				scriptIndex += 1;
				if (next && next !== "-") {
					target.status = next;
					target.updatedAtMs = clock;
					events.push(`worker:${target.name}:${next}`);
				}
			}
		},
		pollIntervalMs: 5_000,
	});
	return {
		processor,
		prisma,
		channels,
		samples,
		enqueued,
		events,
		clockMs: () => clock,
		advance: (ms: number) => {
			clock += ms;
		},
	};
}

const BATCH = {
	requestId: "11111111-2222-4333-8444-555555555555",
	regions: ["AWS_AP_NORTHEAST_1"],
	perRegion: 1,
};

beforeEach(() => {
	deleteUnderPrefix.mockClear();
});

describe("probe batch runner", () => {
	it("happy path: create → provision → RUNNING → stop claim → reap the probe's OWN subtree", async () => {
		const world = makeWorld({ script: ["RUNNING", "-", "STOPPED"] });
		const result = (await world.processor(BATCH)) as {
			outcomes: Array<Record<string, unknown>>;
		};
		expect(result.outcomes[0]).toMatchObject({ outcome: "RUNNING" });
		expect(world.enqueued.map((e) => e.job.action)).toEqual([
			"provision",
			"stop",
		]);
		const channelId = world.channels[0]?.id as string;
		// The reap scope is the designated area + THIS probe — never wider.
		expect(deleteUnderPrefix).toHaveBeenCalledWith({
			bucket: "probe-bucket",
			prefix: `probes/startup/${channelId}/`,
		});
		// The stop rode a claim, not a bare enqueue.
		expect(world.events).toContain(
			`claim:probe-11111111-AWS_AP_NORTHEAST_1-1:STOPPING`,
		);
	});

	it("abandon deadline: still PROVISIONING past the deadline records CENSORED and moves on", async () => {
		// Script never reaches RUNNING; sleeps advance 5s each — the deadline
		// (8 min) passes after ~96 polls.
		const world = makeWorld({ script: [] });
		const result = (await world.processor(BATCH)) as {
			outcomes: Array<Record<string, unknown>>;
		};
		expect(result.outcomes[0]).toMatchObject({ outcome: "CENSORED" });
		const sample = [...world.samples.values()][0];
		expect(sample).toMatchObject({ source: "PROBE", outcome: "CENSORED" });
		// No stop was enqueued — the in-flight provision is not fought; the
		// fuse + reconciler own the encoder side.
		expect(world.enqueued.map((e) => e.job.action)).toEqual(["provision"]);
	});

	it("a probe that never got a RUN still leaves evidence — no-run CENSORED with a dedupe marker (review-pr34 m2), and a CREATED resume re-enqueues provision", async () => {
		// The channel row exists (a prior attempt crashed between create and
		// enqueue) but no run was ever provisioned. The old recorders
		// returned early on !runId — the batch "finished" with a silent hole
		// in the region's history.
		const world = makeWorld({
			script: [],
			channels: [
				{
					id: "orphan-created",
					name: "probe-11111111-AWS_AP_NORTHEAST_1-1",
					purpose: "PROBE",
					status: "CREATED",
					createdAtMs: 0,
					updatedAtMs: 0,
				},
			],
		});
		const result = (await world.processor(BATCH)) as {
			outcomes: Array<Record<string, unknown>>;
		};
		expect(result.outcomes[0]).toMatchObject({ outcome: "CENSORED" });
		const sample = [...world.samples.values()].find(
			(row) => row.failedPhase === "no-run:orphan-created",
		);
		expect(sample).toMatchObject({ source: "PROBE", outcome: "CENSORED" });
		// The resume arm re-enqueued provision for the CREATED row — same
		// dedupe id, so a still-queued original makes this a no-op.
		expect(world.enqueued.map((e) => e.job.action)).toEqual(["provision"]);
	});

	it("serial per region: probe 2 is not created until probe 1 is terminal", async () => {
		const world = makeWorld({
			script: ["RUNNING", "STOPPED", "RUNNING", "STOPPED"],
		});
		await world.processor({ ...BATCH, perRegion: 2 });
		const createTwo = world.events.indexOf(
			"create:probe-11111111-AWS_AP_NORTHEAST_1-2",
		);
		const oneStopped = world.events.findIndex((e) =>
			e.includes("probe-11111111-AWS_AP_NORTHEAST_1-1:STOPPED"),
		);
		expect(createTwo).toBeGreaterThan(oneStopped);
	});

	it("resume: a terminal probe of the same batch is SKIPPED — no second billing", async () => {
		const world = makeWorld({
			channels: [
				{
					id: "existing-1",
					name: "probe-11111111-AWS_AP_NORTHEAST_1-1",
					purpose: "PROBE",
					status: "STOPPED",
					createdAtMs: 0,
					updatedAtMs: 0,
				},
			],
		});
		const result = (await world.processor(BATCH)) as {
			outcomes: Array<Record<string, unknown>>;
		};
		expect(result.outcomes[0]).toMatchObject({ outcome: "SKIPPED" });
		expect(world.enqueued).toHaveLength(0);
	});

	it("a cleanup failure is recorded ON the sample — SANITIZED (C20): the class persists, the raw driver text stays in the log", async () => {
		deleteUnderPrefix.mockRejectedValueOnce(
			Object.assign(new Error("Access Denied: arn:aws:iam::12345:user/x"), {
				Code: "AccessDenied",
				$metadata: { httpStatusCode: 403 },
			}),
		);
		const world = makeWorld({ script: ["RUNNING", "-", "STOPPED"] });
		const result = (await world.processor(BATCH)) as {
			outcomes: Array<Record<string, unknown>>;
		};
		expect(result.outcomes[0]).toMatchObject({
			outcome: "RUNNING",
			cleanupError: "Storage request failed: AccessDenied (upstream 403)",
		});
		const sample = [...world.samples.values()][0] as {
			cleanupError?: string;
		};
		expect(sample.cleanupError).toBe(
			"Storage request failed: AccessDenied (upstream 403)",
		);
		// The IAM arn from the raw message must NOT reach the persisted column.
		expect(sample.cleanupError).not.toContain("arn:aws");
	});

	it("refuses to run without a designation — loudly, not silently", async () => {
		const world = makeWorld({ designation: null });
		await expect(world.processor(BATCH)).rejects.toThrow(/designated/);
	});

	it("a LEGACY designation missing the Bitmovin account is treated as no-designation — the loader guard is load-bearing (review-287 M2)", async () => {
		// The row exists but predates the account requirement. loadProbeDesignation
		// must return null (not a half-built plan that dies at provision), so the
		// batch refuses loudly and NO probe channel is created.
		const world = makeWorld({
			designation: {
				credentialId: DESIGNATION.credentialId,
				bucket: DESIGNATION.bucket,
				prefix: DESIGNATION.prefix,
				abandonDeadlineMinutes: DESIGNATION.abandonDeadlineMinutes,
				// bitmovinAccountId deliberately absent (legacy shape).
			},
		});
		await expect(world.processor(BATCH)).rejects.toThrow(/designated/);
		expect(world.events.filter((e) => e.startsWith("create:"))).toEqual([]);
	});
});

describe("reconcileAbandonedProbes", () => {
	it("also stops an ERROR probe still holding an encoding pointer (review-pr34 Q3) — and leaves pointer-less ERROR rows alone", async () => {
		const world = makeWorld({
			channels: [
				{
					id: "err-with-encoding",
					name: "probe-err-1",
					purpose: "PROBE",
					status: "ERROR",
					createdAtMs: 0,
					updatedAtMs: 0,
					bitmovinEncodingId: "enc-1",
				},
				{
					// ERROR before an encoding ever existed — nothing to stop.
					id: "err-bare",
					name: "probe-err-2",
					purpose: "PROBE",
					status: "ERROR",
					createdAtMs: 0,
					updatedAtMs: 0,
					bitmovinEncodingId: null,
				},
			],
		});
		const enqueued: Array<{ action: string }> = [];
		const stopped = await reconcileAbandonedProbes(
			world.prisma as unknown as AppPrismaClient,
			async (job) => {
				enqueued.push({ action: job.action });
			},
			new Date(10 * 60_000),
		);
		expect(stopped).toBe(1);
		expect(enqueued).toEqual([{ action: "stop" }]);
		expect(world.channels[0]?.status).toBe("STOPPING");
		expect(world.channels[1]?.status).toBe("ERROR");
	});

	it("stops a RUNNING probe nobody is driving — even while the heartbeat sweep keeps bumping updatedAt (review-pr34 B2)", async () => {
		// updatedAtMs is FRESH on purpose: the heartbeat sweep polls every
		// RUNNING channel every 30s and bumps it, which made an updatedAt
		// cutoff dead code. The reconciler must key on runningSince — the
		// event time the probe owns.
		const world = makeWorld({
			channels: [
				{
					id: "zombie-1",
					name: "probe-dead-runner-1",
					purpose: "PROBE",
					status: "RUNNING",
					createdAtMs: 0,
					updatedAtMs: 10 * 60_000 - 1_000,
					runningSinceMs: 0,
				},
				{
					// runningSince NULL — RUNNING in our row but the event time
					// never landed (mid-transition). The `not: null` half of the
					// filter must leave it for the deadline/caps paths.
					id: "mid-transition",
					name: "probe-dead-runner-2",
					purpose: "PROBE",
					status: "RUNNING",
					createdAtMs: 0,
					updatedAtMs: 0,
					runningSinceMs: null,
				},
			],
		});
		const enqueued: Array<{ action: string }> = [];
		const stopped = await reconcileAbandonedProbes(
			world.prisma as unknown as AppPrismaClient,
			async (job) => {
				enqueued.push({ action: job.action });
			},
			new Date(10 * 60_000),
		);
		expect(stopped).toBe(1);
		expect(enqueued).toEqual([{ action: "stop" }]);
		expect(world.channels[0]?.status).toBe("STOPPING");
		expect(world.channels[1]?.status).toBe("RUNNING");
	});
});
