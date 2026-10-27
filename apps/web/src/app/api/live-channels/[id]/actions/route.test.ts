import { createHash } from "node:crypto";
import { liveChannelJobSchema, liveChannelPlanSchema } from "@bitovp/core";
import { DB_NULL } from "@bitovp/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const findUnique = vi.fn();
const runFindFirst = vi.fn(
	async (): Promise<{
		id: string;
		seq: number;
		status: string;
		cancelRequested?: boolean;
		/** : the provider-lifecycle columns the route now reads. */
		providerStatus?: string | null;
		providerStatusObservedAt?: Date | null;
		providerUnknownSince?: Date | null;
		providerTerminalAt?: Date | null;
	} | null> => null,
);
const runCreate = vi.fn(async (_args?: { data: Record<string, unknown> }) => ({
	id: "run-1",
}));
const runUpdate = vi.fn(async () => ({}));
const update = vi.fn();
const updateMany = vi.fn();
const queueAdd = vi.fn();
const queueGetJob = vi.fn();
const effectClaimFindUnique = vi.fn();
type QueuedJob = {
	data: unknown;
	state: string;
	returnvalue?: unknown;
	getState(): Promise<string>;
	remove(): Promise<void>;
};
const queuedJobs = new Map<string, QueuedJob>();

function retainQueuedJob(
	jobId: string,
	data: unknown,
	state = "waiting",
	returnvalue?: unknown,
): QueuedJob {
	const job: QueuedJob = {
		data,
		state,
		returnvalue,
		getState: async () => job.state,
		remove: async () => {
			queuedJobs.delete(jobId);
		},
	};
	queuedJobs.set(jobId, job);
	return job;
}

vi.mock("@/lib/server/context", () => ({
	getServerContext: () => ({
		// : rail 3b's resolver. These five route tests are the
		// ones whose route reaches `submitterValidationOptions`, which now
		// REQUIRES it — the other ~85 context mocks in this app are
		// untouched because their routes never ask. An empty set is the
		// honest default here: "looked, found none", which is what a
		// deployment with no MSL credentials returns.
		credentials: {
			publishingAuthCredentialIds: async () => new Set<string>(),
		},
		//  PR3: start runs a transaction (claim + run row); the
		// mock hands the SAME delegates to the tx callback so assertions see
		// every write. Run-row stub: latest lookup + create/update spies.
		prisma: {
			liveChannel: { findUnique, update, updateMany },
			liveEffectClaim: { findUnique: effectClaimFindUnique },
			liveChannelRun: {
				findFirst: runFindFirst,
				create: runCreate,
				update: runUpdate,
			},
			$transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
				fn({
					liveChannel: { findUnique, update, updateMany },
					liveChannelRun: {
						findFirst: runFindFirst,
						create: runCreate,
						update: runUpdate,
					},
				}),
		},
	}),
}));

vi.mock("@/lib/server/queue", () => ({
	getLiveChannelQueue: () => ({ add: queueAdd, getJob: queueGetJob }),
}));

import { POST } from "./route";

const CHANNEL_ID = "00000000-0000-4000-8000-0000000000bb";
const RUN_ID = "11111111-1111-4111-8111-111111111111";
const REQUEST_ID = "00000000-0000-4000-8000-0000000000dd";

function postAction(body: unknown) {
	const payload =
		typeof body === "object" &&
		body !== null &&
		(body as { action?: unknown }).action === "scte35" &&
		!("requestId" in body)
			? { ...body, requestId: REQUEST_ID }
			: body;
	return POST(
		new Request(`http://test/api/live-channels/${CHANNEL_ID}/actions`, {
			method: "POST",
			body: JSON.stringify(payload),
		}),
		{ params: Promise.resolve({ id: CHANNEL_ID }) },
	);
}

/**
 * A schema-valid live plan for the re-air compile (built by the product's
 * own buildLiveChannelPlan from the wizard default state; the account id is
 * a fixture value — the compile never contacts Bitmovin).
 */
function reairPlan(): Record<string, unknown> {
	return {
		planVersion: 1,
		name: "red109-live-template",
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
				{
					name: "primary",
					streamKeyConfiguration: {
						type: "GENERATE",
					},
				},
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
			{
				key: "video",
				inputPath: "/",
				position: 0,
			},
			{
				key: "audio",
				inputPath: "/",
				position: 1,
			},
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
				destination: {
					outputKey: "origin",
					path: "live-red109/video/720p",
				},
			},
			{
				key: "a128",
				kind: "FMP4",
				streamKey: "a128",
				segmentLength: 6,
				segmentNaming: "segment_%number%.m4s",
				initSegmentName: "init.mp4",
				destination: {
					outputKey: "origin",
					path: "live-red109/audio/128000",
				},
			},
		],
		liveManifests: [
			{
				key: "hls",
				kind: "HLS",
				manifestName: "stream.m3u8",
				name: "Live HLS Manifest",
				destination: {
					outputKey: "origin",
					path: "live-red109",
				},
				audioGroupId: "audio",
				audioLanguage: "en",
				closedCaptions: "NONE",
			},
		],
		start: {
			streamKey: "redlaunch",
		},
	} as unknown as Record<string, unknown>;
}

function channel(overrides: Record<string, unknown> = {}) {
	return {
		id: CHANNEL_ID,
		status: "RUNNING",
		stepLog: [],
		// Every real channel row carries the create-validated plan; the
		// re-air branch parses it before the claim, so the base fixture
		// must too.
		plan: reairPlan(),
		bitmovinEncodingId: "bm-live-enc",
		liveEffectFenceVersion: 0,
		...overrides,
	};
}

function manualStopJobData(
	effectOverrides: Record<string, unknown> = {},
	jobOverrides: Record<string, unknown> = {},
) {
	return {
		liveChannelId: CHANNEL_ID,
		action: "stop",
		effect: {
			idempotencyKey: `manual:stop:${CHANNEL_ID}:${RUN_ID}`,
			liveChannelRunId: RUN_ID,
			providerEncodingId: "bm-live-enc",
			admissionFenceVersion: 0,
			action: "STOP",
			...effectOverrides,
		},
		...jobOverrides,
	};
}

function manualStopSuccess(overrides: Record<string, unknown> = {}) {
	return {
		acknowledged: true,
		liveChannelId: CHANNEL_ID,
		action: "stop",
		status: "STOPPED",
		...overrides,
	};
}

function manualStopClaim(
	state: string,
	overrides: Record<string, unknown> = {},
) {
	return {
		liveChannelId: CHANNEL_ID,
		requestSha256: null,
		liveChannelRunId: RUN_ID,
		providerEncodingId: "bm-live-enc",
		action: "STOP",
		scheduleId: null,
		targetId: null,
		state,
		...overrides,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	queuedJobs.clear();
	effectClaimFindUnique.mockReset();
	effectClaimFindUnique.mockResolvedValue(null);
	queueGetJob.mockImplementation(
		async (jobId: string) => queuedJobs.get(jobId) ?? null,
	);
	queueAdd.mockImplementation(
		async (_name: string, data: unknown, options: { jobId?: string }) => {
			if (options.jobId && !queuedJobs.has(options.jobId)) {
				retainQueuedJob(options.jobId, data);
			}
		},
	);
	vi.stubEnv("MASTER_KEY", Buffer.alloc(32, 7).toString("base64"));
	findUnique.mockResolvedValue(channel());
	runFindFirst.mockReset();
	runFindFirst.mockResolvedValue({
		id: RUN_ID,
		seq: 1,
		status: "RUNNING",
		providerStatus: "RUNNING",
		providerStatusObservedAt: new Date(),
		providerUnknownSince: null,
		providerTerminalAt: null,
	});
	updateMany.mockResolvedValue({ count: 1 });
});

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("POST /api/live-channels/[id]/actions", () => {
	it.each([
		"start",
		"restart",
	])("refuses %s of a legacy fallback-bearing plan before any mutation or queue delivery", async (action) => {
		const saved = liveChannelPlanSchema.parse(reairPlan());
		saved.bitmovin.fallbackCloudRegions = ["AWS_US_EAST_1", "AUTO"];
		findUnique.mockResolvedValue(
			channel({
				status: "ERROR",
				plan: saved,
				stepLog: [
					{
						step: "encoding",
						kind: "CREATE_ENCODING",
						payload: {
							fallbackCloudRegions: saved.bitmovin.fallbackCloudRegions,
						},
						refs: {},
						status: "FAILED",
						error: "previous attempt failed",
					},
				],
			}),
		);
		runFindFirst.mockResolvedValue({
			id: RUN_ID,
			seq: 1,
			status: "ERROR",
			providerStatus: "RUNNING",
			providerStatusObservedAt: new Date(),
		});
		const response = await postAction({ action });
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({
			details: {
				issues: [expect.objectContaining({ code: "LIVE_FALLBACK_REGIONS" })],
			},
		});
		expect(update).not.toHaveBeenCalled();
		expect(updateMany).not.toHaveBeenCalled();
		expect(runCreate).not.toHaveBeenCalled();
		expect(runUpdate).not.toHaveBeenCalled();
		expect(queueAdd).not.toHaveBeenCalled();
		expect(saved.bitmovin.fallbackCloudRegions).toEqual([
			"AWS_US_EAST_1",
			"AUTO",
		]);
	});

	it("still allows stopping a legacy fallback-bearing channel", async () => {
		const saved = liveChannelPlanSchema.parse(reairPlan());
		saved.bitmovin.fallbackCloudRegions = ["AUTO"];
		findUnique.mockResolvedValue(channel({ plan: saved }));
		const response = await postAction({ action: "stop" });
		expect(response.status).toBe(202);
		expect(queueAdd).toHaveBeenCalledWith(
			"live-channel",
			expect.objectContaining({ action: "stop" }),
			expect.anything(),
		);
	});

	it.each([
		"STOPPING",
		"STOPPED",
		"ERROR",
	])("refuses RTMP update on %s without queueing", async (status) => {
		findUnique.mockResolvedValue(channel({ status }));
		expect(
			(
				await postAction({
					action: "update-rtmp-ingest",
					runId: RUN_ID,
					requestId: REQUEST_ID,
					pointIndexes: [0],
				})
			).status,
		).toBe(409);
		expect(queueAdd).not.toHaveBeenCalled();
	});
	it("rejects undeclared points and a conflicting winner of the RTMP queue race", async () => {
		const plan = reairPlan();
		plan.liveInput = {
			key: "main",
			kind: "REDUNDANT_RTMP",
			ingestPoints: [{ applicationName: "primary", streamKey: "private-key" }],
		};
		findUnique.mockResolvedValue(channel({ status: "RUNNING", plan }));
		expect(
			(
				await postAction({
					action: "update-rtmp-ingest",
					runId: RUN_ID,
					requestId: REQUEST_ID,
					pointIndexes: [1],
				})
			).status,
		).toBe(422);
		expect(queueAdd).not.toHaveBeenCalled();
		queueAdd.mockImplementationOnce(async (_name, data, options) => {
			retainQueuedJob(options.jobId, {
				...data,
				params: { pointIndexes: [1] },
			});
		});
		expect(
			(
				await postAction({
					action: "update-rtmp-ingest",
					runId: RUN_ID,
					requestId: REQUEST_ID,
					pointIndexes: [0],
				})
			).status,
		).toBe(409);
	});
	it("queues only declared redundant RTMP points, bound to the displayed run", async () => {
		const plan = reairPlan();
		plan.liveInput = {
			key: "main",
			kind: "REDUNDANT_RTMP",
			ingestPoints: [
				{ applicationName: "primary", streamKey: "private-primary" },
				{ applicationName: "backup", streamKey: "private-backup" },
			],
		};
		findUnique.mockResolvedValue(channel({ status: "RUNNING", plan }));
		const res = await postAction({
			action: "update-rtmp-ingest",
			runId: RUN_ID,
			requestId: REQUEST_ID,
			pointIndexes: [1],
		});
		expect(res.status).toBe(202);
		expect(queueAdd).toHaveBeenCalledWith(
			"live-channel",
			expect.objectContaining({
				action: "update-rtmp-ingest",
				params: { pointIndexes: [1] },
				effect: expect.objectContaining({
					action: "RTMP_INGEST_UPDATE",
					liveChannelRunId: RUN_ID,
					requestSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
				}),
			}),
			expect.anything(),
		);
		expect(JSON.stringify(queueAdd.mock.calls)).not.toContain("private-");
	});
	it("refuses RTMP changes from a stale displayed run or arbitrary key", async () => {
		findUnique.mockResolvedValue(channel({ status: "RUNNING" }));
		expect(
			(
				await postAction({
					action: "update-rtmp-ingest",
					runId: REQUEST_ID,
					requestId: REQUEST_ID,
					pointIndexes: [0],
				})
			).status,
		).toBe(409);
		expect(
			(
				await postAction({
					action: "update-rtmp-ingest",
					runId: RUN_ID,
					requestId: REQUEST_ID,
					pointIndexes: [0],
					streamKey: "secret",
				})
			).status,
		).toBe(400);
		expect(queueAdd).not.toHaveBeenCalled();
	});
	it("rejects unknown actions and invalid ids", async () => {
		expect((await postAction({ action: "explode" })).status).toBe(400);
		const res = await POST(
			new Request("http://test/api/live-channels/nope/actions", {
				method: "POST",
				body: JSON.stringify({ action: "stop" }),
			}),
			{ params: Promise.resolve({ id: "nope" }) },
		);
		expect(res.status).toBe(400);
		expect(queueAdd).not.toHaveBeenCalled();
	});

	it("404s on unknown channels", async () => {
		findUnique.mockResolvedValueOnce(null);
		expect((await postAction({ action: "stop" })).status).toBe(404);
	});

	it.each([
		"STOPPED",
		"ERROR",
	])("returns an actionable 400 for an old MSL5 plan re-aired from %s", async (status) => {
		const raw = reairPlan();
		const plan = liveChannelPlanSchema.parse({
			...raw,
			bitmovin: { ...(raw.bitmovin as object), encoderVersion: "2.281.0" },
			outputs: [
				{
					key: "origin",
					kind: "AKAMAI_MSL",
					credentialId: "00000000-0000-4000-8000-000000000003",
					streamFormat: "CMAF",
					mslVersion: "MSL5",
				},
			],
		});
		findUnique.mockResolvedValueOnce(channel({ status, plan, error: null }));
		runFindFirst.mockResolvedValueOnce({
			id: "run-old",
			seq: 1,
			status: "STOPPED",
		});
		const response = await postAction({ action: "start" });
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({
			details: {
				issues: [
					{
						code: "MSL_ENCODER_VERSION",
						level: "error",
						path: "bitmovin.encoderVersion",
						message: expect.stringContaining("2.283.0"),
					},
				],
			},
		});
		expect(updateMany).not.toHaveBeenCalled();
		expect(runCreate).not.toHaveBeenCalled();
		expect(runUpdate).not.toHaveBeenCalled();
		expect(queueAdd).not.toHaveBeenCalled();
	});
	it("does not classify an unrelated compiler-path failure as a version refusal", async () => {
		findUnique.mockResolvedValueOnce(
			channel({ status: "STOPPED", error: null }),
		);
		runFindFirst.mockRejectedValueOnce(new Error("unrelated failure"));
		expect((await postAction({ action: "start" })).status).toBe(500);
		expect(queueAdd).not.toHaveBeenCalled();
	});
	it("start on STOPPED: a NEW run (seq+1, fresh columns) — the re-air #107/#110 could not have (ledger #108 PR3)", async () => {
		findUnique.mockResolvedValueOnce(
			channel({
				status: "STOPPED",
				bitmovinEncodingId: "enc-old",
				plan: reairPlan(),
			}),
		);
		updateMany.mockResolvedValueOnce({ count: 1 });
		runFindFirst.mockResolvedValueOnce({
			id: "run-1",
			seq: 1,
			status: "STOPPED",
		});
		const res = await postAction({ action: "start" });
		expect(res.status).toBe(200);
		const claim = updateMany.mock.calls[0]?.[0] as {
			data: Record<string, unknown>;
		};
		// The per-run channel columns are FREED so provision builds a fresh
		// encoding (C30: the finished one is never touched); the old run row
		// keeps the history.
		expect(claim.data.bitmovinEncodingId).toBeNull();
		/*
		 * The COMPILED fresh log, not []. This assertion USED to read
		 * `toEqual([])` — pinning the defect itself: the route wrote an empty
		 * log believing "a fresh step log compiles", but the worker's
		 * provision EXECUTES the row's log and never compiles (the create
		 * route is the only compiler). The first real re-air walked zero
		 * steps and died at finalize ("Step log carries no CREATE_ENCODING
		 * resource id"), stranding the channel at ERROR — found 2026-08-21 on
		 * channel edc041f5, run #2. A re-air's log must look exactly like a
		 * create's: PENDING entries with a CREATE_ENCODING and no resource
		 * ids.
		 */
		const stepLog = claim.data.stepLog as {
			kind: string;
			status: string;
			resourceId?: string;
		}[];
		expect(stepLog.length).toBeGreaterThan(0);
		expect(stepLog.map((e) => e.kind)).toContain("CREATE_ENCODING");
		for (const entry of stepLog) {
			expect(entry.status).toBe("PENDING");
			expect(entry.resourceId).toBeUndefined();
		}
		// #155: the new run row carries a pre-minted id and the prefix its
		// compiled log writes under — `<base>/runs/<seq>-<id8>` — and the log's
		// paths live INSIDE that subtree, with the plan's own segment path gone
		// (its presence would be exactly the overwrite-the-previous-run defect).
		const created = runCreate.mock.calls[0]?.[0] as unknown as {
			data: { id: string; seq: number; outputPrefix: string };
		};
		expect(created.data.seq).toBe(2);
		expect(created.data.id).toMatch(/^[0-9a-f-]{36}$/);
		expect(created.data.outputPrefix).toBe(
			`live-red109/runs/2-${created.data.id.replace(/-/g, "").slice(0, 8)}`,
		);
		const wire = JSON.stringify(stepLog);
		expect(wire).toContain(`${created.data.outputPrefix}/video/720p`);
		expect(wire).not.toContain('"live-red109/video/720p"');
		expect(runCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ seq: 2, status: "PROVISIONING" }),
			}),
		);
		expect(queueAdd).toHaveBeenCalledWith(
			"live-channel",
			{ liveChannelId: CHANNEL_ID, action: "provision" },
			expect.anything(),
		);
	});

	it("ERROR resume with an EMPTY log compiles fresh — the stranded-corpse recovery (ledger #108)", async () => {
		// The exact shape the old re-air bug left behind: channel ERROR,
		// latest run ERROR, stepLog []. Reseeding [] would walk zero steps
		// and die at finalize again — this start must compile instead.
		findUnique.mockResolvedValueOnce(
			channel({ status: "ERROR", stepLog: [], plan: reairPlan() }),
		);
		updateMany.mockResolvedValueOnce({ count: 1 });
		runFindFirst.mockResolvedValueOnce({
			id: "run-2",
			seq: 2,
			status: "ERROR",
		});
		const res = await postAction({ action: "start" });
		expect(res.status).toBe(200);
		const claim = updateMany.mock.calls[0]?.[0] as {
			data: Record<string, unknown>;
		};
		const stepLog = claim.data.stepLog as { kind: string; status: string }[];
		expect(stepLog.length).toBeGreaterThan(0);
		expect(stepLog.map((e) => e.kind)).toContain("CREATE_ENCODING");
		// #155: the corpse's recompiled log is rebased for the REVIVED run's
		// own coordinates (seq 2, id "run-2" → id8 "run2"), and the revival
		// stamps that prefix onto the run row it heals.
		expect(JSON.stringify(stepLog)).toContain(
			"live-red109/runs/2-run2/video/720p",
		);
		expect(runUpdate).toHaveBeenCalledWith({
			where: { id: "run-2" },
			data: {
				status: "PROVISIONING",
				error: null,
				endedAt: null,
				// rev431: the revived run restarts the same encoding
				encoderStoppedConfirmedFor: null,
				heartbeatSummary: DB_NULL,
				heartbeatSummaryAt: null,
				outputPrefix: "live-red109/runs/2-run2",
			},
		});
		expect(runCreate).not.toHaveBeenCalled();
	});

	it("start refuses while a run is LIVE — one channel, one live run (#48), named 409", async () => {
		findUnique.mockResolvedValueOnce(channel({ status: "ERROR" }));
		updateMany.mockResolvedValueOnce({ count: 1 });
		runFindFirst.mockResolvedValueOnce({
			id: "run-2",
			seq: 2,
			status: "RUNNING",
		});
		const res = await postAction({ action: "start" });
		expect(res.status).toBe(409);
		expect((await res.json()).error).toMatch(/one live run/i);
		expect(runCreate).not.toHaveBeenCalled();
		expect(queueAdd).not.toHaveBeenCalled();
	});

	it("start on ERROR REVIVES the latest run — a resume is the same airing, not a new one", async () => {
		// A RESUMABLE log (a DONE step to keep) — the plain-resume arm, which
		// must NOT touch outputPrefix: the run's paths are already baked into
		// its DONE resources, and restamping would lie about where they live
		// (#155 pins the untouched prefix here, the recompiled one below).
		findUnique.mockResolvedValueOnce(
			channel({
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
		);
		updateMany.mockResolvedValueOnce({ count: 1 });
		runFindFirst.mockResolvedValueOnce({
			id: "run-3",
			seq: 3,
			status: "ERROR",
		});
		const res = await postAction({ action: "start" });
		expect(res.status).toBe(200);
		expect(runUpdate).toHaveBeenCalledWith({
			where: { id: "run-3" },
			// endedAt clears WITH the revival (review-259 116-A2): the stale
			// ERROR stamp made a revived run "end" before it began — bogus end
			// time in runs-panel, zero airtime in insights. BOTH heartbeat
			// summary columns clear with it (rev405 R4): the lock, so the
			// resumed airing is summarized again when it really ends, and the
			// JSON, so the RUNNING revived run does not serve the aborted
			// airing's figures meanwhile.
			data: {
				status: "PROVISIONING",
				error: null,
				endedAt: null,
				// rev431: the revived run restarts the same encoding
				encoderStoppedConfirmedFor: null,
				heartbeatSummary: DB_NULL,
				heartbeatSummaryAt: null,
			},
		});
		expect(runCreate).not.toHaveBeenCalled();
		// rev431: the channel claim clears its stop/CREATED confirmation too
		// (PROVISION_LEASE_RELEASE) — a revive keeps the CREATED encoding's id
		expect(updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: "PROVISIONING",
					encoderStoppedConfirmedFor: null,
				}),
			}),
		);
	});

	it("start: resets failed steps, claims ERROR → PROVISIONING and enqueues provisioning", async () => {
		findUnique.mockResolvedValueOnce(
			channel({
				status: "ERROR",
				stepLog: [
					{
						step: "live-input:main",
						kind: "CREATE_INPUT_RTMP",
						payload: {},
						refs: {},
						status: "DONE",
						resourceId: "bm-rtmp",
					},
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
		);
		runFindFirst.mockResolvedValueOnce({
			id: "run-error",
			seq: 1,
			status: "ERROR",
			providerStatus: null,
			providerStatusObservedAt: null,
			providerUnknownSince: null,
			providerTerminalAt: null,
		});
		const res = await postAction({ action: "start" });
		expect(res.status).toBe(200);
		const claim = updateMany.mock.calls[0]?.[0] as {
			where: { OR: unknown[] };
			data: {
				status: string;
				stepLog: { step: string; status: string; resourceId?: string }[];
			};
		};
		//  PR3: STOPPED joined the startable set — a re-air is a
		// NEW run, the affordance #107/#110 could not have.
		//  C-fold round 2: the STOPPED arm gained `error: null`, so
		// the claim is an OR. A stop that never confirmed must not be re-aired
		// — that would clear the evidence, the pointer and the step log, i.e.
		// the warning AND its remedy, and start a second encoding beside a
		// possibly-live first one, unattended.
		expect(claim.where.OR).toEqual([
			{ status: { in: ["CREATED", "ERROR"] } },
			{ status: "STOPPED", error: null },
		]);
		// The claim IS the lock: the transition leaves the claimable set, so
		// a concurrent second start matches zero rows and 409s.
		expect(claim.data.status).toBe("PROVISIONING");
		expect(claim.data.stepLog).toEqual([
			expect.objectContaining({ status: "DONE", resourceId: "bm-rtmp" }),
			expect.objectContaining({ step: "encoding", status: "PENDING" }),
		]);
		expect(queueAdd).toHaveBeenCalledWith(
			"live-channel",
			{ liveChannelId: CHANNEL_ID, action: "provision" },
			expect.objectContaining({ jobId: expect.stringContaining(CHANNEL_ID) }),
		);
	});

	it("start's atomic claim RELEASES the provisioning lease (AKR-E57-003)", async () => {
		/**
		 * The wiring, which nothing pinned: deleting `provisionClaimedAt: null`
		 * from the claim left this whole file green.
		 *
		 * What it costs is one service away, which is why it needs saying here.
		 * `provision` refuses a channel whose lease is still live, and the
		 * lease expires on a 10-minute timer rather than being released by name
		 * (so a dead worker cannot wedge a channel). A re-air is a FRESH run and
		 * must be provisionable at once — so the start that claims the row has
		 * to clear the previous run's lease in the SAME atomic update, or the
		 * operator waits out an expiry window for no reason.
		 */
		findUnique.mockResolvedValueOnce(
			channel({
				status: "STOPPED",
				bitmovinEncodingId: "enc-old",
				plan: reairPlan(),
			}),
		);
		updateMany.mockResolvedValueOnce({ count: 1 });
		runFindFirst.mockResolvedValueOnce({
			id: "run-1",
			seq: 1,
			status: "STOPPED",
		});
		await postAction({ action: "start" });
		const claim = updateMany.mock.calls.find(
			(c) =>
				(c[0] as { data?: { status?: string } })?.data?.status ===
				"PROVISIONING",
		);
		expect(claim, "no PROVISIONING claim was issued").toBeDefined();
		expect(
			(claim?.[0] as { data: Record<string, unknown> }).data,
		).toMatchObject({ provisionClaimedAt: null });
	});

	it("start: 409s for channels that are not startable", async () => {
		findUnique.mockResolvedValueOnce(channel({ status: "RUNNING" }));
		const res = await postAction({ action: "start" });
		expect(res.status).toBe(409);
		expect(queueAdd).not.toHaveBeenCalled();
	});

	it("stop: returns a truthful queued handoff and bounded retry policy without a route-side state write", async () => {
		const res = await postAction({ action: "stop" });
		expect(res.status).toBe(202);
		expect(await res.json()).toMatchObject({
			action: "stop",
			status: "RUNNING",
			handoffStatus: "QUEUED",
		});
		expect(queueAdd).toHaveBeenCalledWith(
			"live-channel",
			expect.objectContaining({
				liveChannelId: CHANNEL_ID,
				action: "stop",
				effect: expect.objectContaining({
					idempotencyKey: `manual:stop:${CHANNEL_ID}:${RUN_ID}`,
					action: "STOP",
					liveChannelRunId: RUN_ID,
					providerEncodingId: "bm-live-enc",
					admissionFenceVersion: 0,
				}),
			}),
			expect.objectContaining({
				jobId: `manual-stop-${CHANNEL_ID}-${RUN_ID}`,
				attempts: 5,
				backoff: { type: "exponential", delay: 5_000 },
			}),
		);
		expect(updateMany).not.toHaveBeenCalled();
	});

	it("stop: a queue rejection leaves status and effect fence completely untouched", async () => {
		queueAdd.mockRejectedValueOnce(new Error("redis unavailable"));

		const res = await postAction({ action: "stop" });

		expect(res.status).toBe(500);
		expect(updateMany).not.toHaveBeenCalled();
		expect(update).not.toHaveBeenCalled();
	});

	it.each([
		"failed",
		"completed",
	])("stop: reclaims a retained %s job before retrying the same handoff", async (state) => {
		const remove = vi.fn(async () => undefined);
		const getState = vi.fn(async () => state);
		queueGetJob.mockResolvedValueOnce({ getState, remove });

		const res = await postAction({ action: "stop" });

		expect(res.status).toBe(202);
		expect(queueGetJob).toHaveBeenCalledWith(
			`manual-stop-${CHANNEL_ID}-${RUN_ID}`,
		);
		expect(remove).toHaveBeenCalledOnce();
		expect(remove.mock.invocationCallOrder[0]).toBeLessThan(
			queueAdd.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
		);
	});

	it.each([
		["RUNNING", "active", null],
		["ERROR", "waiting", "provider read failed"],
		["STOPPED", "active", "stop never confirmed"],
	] as const)("stop: %s reuses an exact %s handoff without asking BullMQ to dedupe it", async (status, state, error) => {
		findUnique.mockResolvedValueOnce(channel({ status, error }));
		const jobId = `manual-stop-${CHANNEL_ID}-${RUN_ID}`;
		const retained = retainQueuedJob(jobId, manualStopJobData(), state);

		const res = await postAction({ action: "stop" });

		expect(res.status).toBe(202);
		await expect(res.json()).resolves.toMatchObject({
			idempotentReplay: true,
			handoffStatus: "QUEUED",
		});
		expect(retained.state).toBe(state);
		expect(queueAdd).not.toHaveBeenCalled();
	});

	it.each([
		["a malformed effect", { effect: { action: "STOP" } }],
		[
			"another run",
			manualStopJobData({
				liveChannelRunId: "22222222-2222-4222-8222-222222222222",
			}),
		],
		[
			"another provider",
			manualStopJobData({ providerEncodingId: "bm-other-enc" }),
		],
		[
			"a scheduled effect",
			manualStopJobData({
				scheduleId: "33333333-3333-4333-8333-333333333333",
			}),
		],
		["a target-bound effect", manualStopJobData({ targetId: "slate-1" })],
		[
			"a request-hash-bound effect",
			manualStopJobData({ requestSha256: "a".repeat(64) }),
		],
		[
			"unexpected action params",
			manualStopJobData({}, { params: { source: "scheduled" } }),
		],
		[
			"a stale planned run",
			manualStopJobData(
				{},
				{
					plannedLiveChannelRunId: "22222222-2222-4222-8222-222222222222",
				},
			),
		],
		[
			"a live-to-VOD attempt id",
			manualStopJobData(
				{},
				{ attemptId: "33333333-3333-4333-8333-333333333333" },
			),
		],
		[
			"an outer run id",
			manualStopJobData(
				{},
				{ liveChannelRunId: "44444444-4444-4444-8444-444444444444" },
			),
		],
		[
			"an outer encoding id",
			manualStopJobData({}, { encodingId: "bm-stale-encoding" }),
		],
	] as const)("stop: refuses an in-progress deterministic job carrying %s", async (_case, data) => {
		const jobId = `manual-stop-${CHANNEL_ID}-${RUN_ID}`;
		retainQueuedJob(jobId, data, "active");

		const res = await postAction({ action: "stop" });

		expect(res.status).toBe(409);
		expect(queueAdd).not.toHaveBeenCalled();
	});

	it("stop: refuses an exact deterministic job in an unknown queue state", async () => {
		const jobId = `manual-stop-${CHANNEL_ID}-${RUN_ID}`;
		retainQueuedJob(jobId, manualStopJobData(), "unknown");

		const res = await postAction({ action: "stop" });

		expect(res.status).toBe(409);
		expect(queueAdd).not.toHaveBeenCalled();
	});

	it("stop: validates the BullMQ winner when another payload wins the add race", async () => {
		const jobId = `manual-stop-${CHANNEL_ID}-${RUN_ID}`;
		queueGetJob.mockResolvedValueOnce(null);
		queueAdd.mockImplementationOnce(async () => {
			retainQueuedJob(
				jobId,
				manualStopJobData({ providerEncodingId: "bm-racing-enc" }),
				"waiting",
			);
		});

		const res = await postAction({ action: "stop" });

		expect(res.status).toBe(409);
		expect(queueAdd).toHaveBeenCalledOnce();
	});

	it("stop: never readds a settled job whose durable claim is AMBIGUOUS", async () => {
		const jobId = `manual-stop-${CHANNEL_ID}-${RUN_ID}`;
		const retained = retainQueuedJob(
			jobId,
			manualStopJobData(),
			"completed",
			manualStopSuccess({ status: "EFFECT_AMBIGUOUS" }),
		);
		effectClaimFindUnique.mockResolvedValueOnce(manualStopClaim("AMBIGUOUS"));

		const res = await postAction({ action: "stop" });

		expect(res.status).toBe(409);
		expect(queueAdd).not.toHaveBeenCalled();
		expect(queuedJobs.get(jobId)).toBe(retained);
	});

	it.each([
		"CLAIMED",
		"DISPATCHING",
	])("stop: refuses an exact %s claim without its exact in-progress queue job", async (state) => {
		effectClaimFindUnique.mockResolvedValueOnce(manualStopClaim(state));

		const res = await postAction({ action: "stop" });

		expect(res.status).toBe(409);
		expect(queueAdd).not.toHaveBeenCalled();
	});

	it("stop: does not remove a settled queue job while its exact DISPATCHING claim is open", async () => {
		const jobId = `manual-stop-${CHANNEL_ID}-${RUN_ID}`;
		const retained = retainQueuedJob(jobId, manualStopJobData(), "failed");
		effectClaimFindUnique.mockResolvedValueOnce(manualStopClaim("DISPATCHING"));

		const res = await postAction({ action: "stop" });

		expect(res.status).toBe(409);
		expect(queueAdd).not.toHaveBeenCalled();
		expect(queuedJobs.get(jobId)).toBe(retained);
	});

	it("stop: refuses an ACKED claim instead of enqueueing an effect no-op", async () => {
		effectClaimFindUnique.mockResolvedValueOnce(manualStopClaim("ACKED"));

		const res = await postAction({ action: "stop" });

		expect(res.status).toBe(409);
		expect(queueAdd).not.toHaveBeenCalled();
	});

	it.each([
		"CLAIMED",
		"DISPATCHING",
	])("stop: replays an exact active queue job with its matching %s claim", async (state) => {
		effectClaimFindUnique.mockResolvedValue(manualStopClaim(state));
		retainQueuedJob(
			`manual-stop-${CHANNEL_ID}-${RUN_ID}`,
			manualStopJobData(),
			"active",
		);

		const res = await postAction({ action: "stop" });

		expect(res.status).toBe(202);
		expect(queueAdd).not.toHaveBeenCalled();
	});

	it("stop: refuses replay when an exact DISPATCHING claim becomes AMBIGUOUS during admission", async () => {
		effectClaimFindUnique
			.mockResolvedValueOnce(manualStopClaim("DISPATCHING"))
			.mockResolvedValueOnce(manualStopClaim("AMBIGUOUS"));
		retainQueuedJob(
			`manual-stop-${CHANNEL_ID}-${RUN_ID}`,
			manualStopJobData(),
			"active",
		);

		const res = await postAction({ action: "stop" });

		expect(res.status).toBe(409);
		expect(queueAdd).not.toHaveBeenCalled();
		expect(effectClaimFindUnique).toHaveBeenCalledTimes(2);
	});

	it("stop: retries a settled queue job only for the same exact FAILED claim", async () => {
		const failed = manualStopClaim("FAILED");
		effectClaimFindUnique.mockResolvedValue(failed);
		const jobId = `manual-stop-${CHANNEL_ID}-${RUN_ID}`;
		const retained = retainQueuedJob(jobId, manualStopJobData(), "failed");

		const res = await postAction({ action: "stop" });

		expect(res.status).toBe(202);
		expect(queueAdd).toHaveBeenCalledOnce();
		expect(queuedJobs.get(jobId)).not.toBe(retained);
	});

	it.each([
		[
			"another channel",
			{ liveChannelId: "55555555-5555-4555-8555-555555555555" },
		],
		[
			"another run",
			{ liveChannelRunId: "66666666-6666-4666-8666-666666666666" },
		],
		["another provider", { providerEncodingId: "bm-other-enc" }],
		["another action", { action: "RESTART" }],
		[
			"a scheduled claim",
			{ scheduleId: "77777777-7777-4777-8777-777777777777" },
		],
		["a targeted claim", { targetId: "slate-1" }],
		["a request-bound claim", { requestSha256: "a".repeat(64) }],
	] as const)("stop: refuses a durable claim bound to %s", async (_case, overrides) => {
		effectClaimFindUnique.mockResolvedValueOnce(
			manualStopClaim("FAILED", overrides),
		);

		const res = await postAction({ action: "stop" });

		expect(res.status).toBe(409);
		expect(queueAdd).not.toHaveBeenCalled();
	});

	it("stop: refuses an unknown durable claim state", async () => {
		effectClaimFindUnique.mockResolvedValueOnce(
			manualStopClaim("UNKNOWN_STATE"),
		);

		const res = await postAction({ action: "stop" });

		expect(res.status).toBe(409);
		expect(queueAdd).not.toHaveBeenCalled();
	});

	it("stop: rechecks a claim that becomes AMBIGUOUS while the queue winner is waiting", async () => {
		effectClaimFindUnique
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce(manualStopClaim("AMBIGUOUS"));

		const res = await postAction({ action: "stop" });

		expect(res.status).toBe(409);
		expect(queueAdd).toHaveBeenCalledOnce();
	});

	it.each([
		["an exact STOPPED result without a durable ACK", manualStopSuccess()],
		["a missing result", undefined],
		["a malformed result", "STOPPED"],
		["an unacknowledged result", manualStopSuccess({ acknowledged: false })],
		[
			"another channel's result",
			manualStopSuccess({
				liveChannelId: "55555555-5555-4555-8555-555555555555",
			}),
		],
		["another action's result", manualStopSuccess({ action: "restart" })],
		[
			"an otherwise-successful result with extra fields",
			manualStopSuccess({ providerResultId: "provider-stop-1" }),
		],
		[
			"a stale-generation no-op",
			manualStopSuccess({ status: "SKIPPED_STALE_GENERATION" }),
		],
		[
			"an effect-conflict no-op",
			manualStopSuccess({ status: "EFFECT_REQUEST_CONFLICT" }),
		],
		["an ambiguous effect", manualStopSuccess({ status: "EFFECT_AMBIGUOUS" })],
	] as const)("stop: refuses a completed deterministic winner with %s", async (_case, returnvalue) => {
		const jobId = `manual-stop-${CHANNEL_ID}-${RUN_ID}`;
		queueGetJob.mockResolvedValueOnce(null);
		queueAdd.mockImplementationOnce(async (_name, data) => {
			retainQueuedJob(jobId, data, "completed", returnvalue);
		});

		const res = await postAction({ action: "stop" });

		expect(res.status).toBe(409);
	});

	it("stop: concurrent exact admissions retain one executable provider effect", async () => {
		let initialReads = 0;
		let releaseInitialReads: (() => void) | undefined;
		const bothReadAbsent = new Promise<void>((resolve) => {
			releaseInitialReads = resolve;
		});
		queueGetJob.mockImplementation(async (jobId: string) => {
			if (initialReads < 2) {
				initialReads += 1;
				if (initialReads === 2) {
					releaseInitialReads?.();
				}
				await bothReadAbsent;
				return null;
			}
			return queuedJobs.get(jobId) ?? null;
		});

		const [first, second] = await Promise.all([
			postAction({ action: "stop" }),
			postAction({ action: "stop" }),
		]);

		expect([first.status, second.status]).toEqual([202, 202]);
		expect(queueAdd).toHaveBeenCalledTimes(2);
		expect(queuedJobs).toHaveLength(1);
		expect(
			liveChannelJobSchema.parse(
				queuedJobs.get(`manual-stop-${CHANNEL_ID}-${RUN_ID}`)?.data,
			),
		).toMatchObject(manualStopJobData());
	});

	it("stop: replays the exact active handoff after the worker has moved the channel to STOPPING", async () => {
		findUnique.mockResolvedValueOnce(channel({ status: "STOPPING" }));
		const jobId = `manual-stop-${CHANNEL_ID}-${RUN_ID}`;
		retainQueuedJob(jobId, manualStopJobData(), "active");

		const res = await postAction({ action: "stop" });

		expect(res.status).toBe(202);
		await expect(res.json()).resolves.toMatchObject({
			action: "stop",
			status: "STOPPING",
			handoffStatus: "QUEUED",
			idempotentReplay: true,
		});
		expect(queueAdd).not.toHaveBeenCalled();
	});

	it.each([
		[
			"another run",
			{ liveChannelRunId: "22222222-2222-4222-8222-222222222222" },
		],
		["another provider", { providerEncodingId: "bm-other-enc" }],
		["a scheduled stop", { scheduleId: "schedule-1" }],
		["an invalid admission fence", { admissionFenceVersion: undefined }],
	])("stop: refuses a STOPPING replay bound to %s", async (_case, effectOverride) => {
		findUnique.mockResolvedValueOnce(channel({ status: "STOPPING" }));
		const jobId = `manual-stop-${CHANNEL_ID}-${RUN_ID}`;
		retainQueuedJob(
			jobId,
			{
				liveChannelId: CHANNEL_ID,
				action: "stop",
				effect: {
					idempotencyKey: `manual:stop:${CHANNEL_ID}:${RUN_ID}`,
					liveChannelRunId: RUN_ID,
					providerEncodingId: "bm-live-enc",
					admissionFenceVersion: 0,
					action: "STOP",
					...effectOverride,
				},
			},
			"active",
		);

		const res = await postAction({ action: "stop" });

		expect(res.status).toBe(409);
		expect(queueAdd).not.toHaveBeenCalled();
	});

	it.each([
		"failed",
		"completed",
		"unknown",
	])("stop: refuses a STOPPING replay whose exact job is %s", async (state) => {
		findUnique.mockResolvedValueOnce(channel({ status: "STOPPING" }));
		const jobId = `manual-stop-${CHANNEL_ID}-${RUN_ID}`;
		retainQueuedJob(
			jobId,
			{
				liveChannelId: CHANNEL_ID,
				action: "stop",
				effect: {
					idempotencyKey: `manual:stop:${CHANNEL_ID}:${RUN_ID}`,
					liveChannelRunId: RUN_ID,
					providerEncodingId: "bm-live-enc",
					admissionFenceVersion: 0,
					action: "STOP",
				},
			},
			state,
		);

		const res = await postAction({ action: "stop" });

		expect(res.status).toBe(409);
		expect(queueAdd).not.toHaveBeenCalled();
	});

	it("stop: fails closed when a retained terminal job cannot be removed", async () => {
		const remove = vi.fn(async () => {
			throw new Error("redis removal failed");
		});
		queueGetJob.mockResolvedValueOnce({
			getState: vi.fn(async () => "failed"),
			remove,
		});

		const res = await postAction({ action: "stop" });

		expect(res.status).toBe(500);
		expect(remove).toHaveBeenCalledOnce();
		expect(queueAdd).not.toHaveBeenCalled();
		expect(updateMany).not.toHaveBeenCalled();
		expect(update).not.toHaveBeenCalled();
	});

	it("stop: a route death after Redis accepts leaves a schema-valid executable stop job", async () => {
		let acceptedPayload: unknown;
		queueAdd.mockImplementationOnce(async (_name, payload) => {
			// Model Redis committing the add before the HTTP process loses the
			// response/dies. The caller sees an error, but the captured job exists.
			acceptedPayload = payload;
			throw new Error("KILL_AFTER_REDIS_ACCEPT");
		});

		const res = await postAction({ action: "stop" });

		expect(res.status).toBe(500);
		expect(queueAdd).toHaveBeenCalledTimes(1);
		expect(liveChannelJobSchema.parse(acceptedPayload)).toMatchObject({
			liveChannelId: CHANNEL_ID,
			action: "stop",
			effect: {
				idempotencyKey: `manual:stop:${CHANNEL_ID}:${RUN_ID}`,
				liveChannelRunId: RUN_ID,
				providerEncodingId: "bm-live-enc",
				admissionFenceVersion: 0,
				action: "STOP",
			},
		});
		// There is no local transition or fallback ERROR write that could hide
		// or invalidate the already-durable stop intent.
		expect(updateMany).not.toHaveBeenCalled();
		expect(update).not.toHaveBeenCalled();
	});

	it("stop: a worker that finishes first cannot be overwritten back to STOPPING", async () => {
		const state = { status: "RUNNING", liveEffectFenceVersion: 0 };
		effectClaimFindUnique
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce(manualStopClaim("ACKED"));
		queueAdd.mockImplementationOnce(async (_name, data, options) => {
			// Simulate the worker claiming generation 1 and completing the stop
			// before queue.add returns to the route.
			retainQueuedJob(options.jobId, data, "completed", manualStopSuccess());
			state.liveEffectFenceVersion = 1;
			state.status = "STOPPED";
		});
		const res = await postAction({ action: "stop" });

		expect(res.status).toBe(202);
		expect(state).toEqual({ status: "STOPPED", liveEffectFenceVersion: 1 });
		expect(updateMany).not.toHaveBeenCalled();
	});

	it("stop: reports a fast failed handoff without leaving a false STOPPING projection", async () => {
		const state = { status: "RUNNING", liveEffectFenceVersion: 0 };
		queueAdd.mockImplementationOnce(async (_name, data, options) => {
			// The job was durable and ran, but died before beginLiveEffect. The
			// dead-job handler intentionally cannot flip a still-RUNNING row.
			retainQueuedJob(options.jobId, data, "failed");
		});
		updateMany.mockImplementationOnce(async (args) => {
			state.status = String(args.data.status);
			return { count: 1 };
		});

		const res = await postAction({ action: "stop" });

		expect(res.status).toBe(409);
		// Leaving RUNNING makes the bounded BullMQ retry executable; a route-side
		// STOPPING write here would recreate the billing wedge.
		expect(state).toEqual({ status: "RUNNING", liveEffectFenceVersion: 0 });
		expect(updateMany).not.toHaveBeenCalled();
	});

	it("stop: 409s before enqueue when the channel is not RUNNING/ERROR", async () => {
		findUnique.mockResolvedValueOnce(channel({ status: "CREATED" }));
		const res = await postAction({ action: "stop" });
		expect(res.status).toBe(409);
		expect(await res.json()).toMatchObject({
			details: { code: "LIVE_ACTION_NOT_STOPPABLE", status: "CREATED" },
		});
		expect(queueAdd).not.toHaveBeenCalled();
		expect(updateMany).not.toHaveBeenCalled();
	});

	it("stop: 409s when the channel has no Bitmovin encoding yet", async () => {
		findUnique.mockResolvedValueOnce(channel({ bitmovinEncodingId: null }));
		const res = await postAction({ action: "stop" });
		expect(res.status).toBe(409);
	});

	it("restart: claims → PROVISIONING and enqueues for RUNNING/ERROR", async () => {
		// NOT for STOPPED — this test used to assert the opposite, which is
		// how the false affordance survived . See the STOPPED
		// case below for what Bitmovin actually does.
		findUnique.mockResolvedValueOnce(channel({ status: "ERROR" }));
		const res = await postAction({ action: "restart" });
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ status: "PROVISIONING" });
		// Same transition-is-the-lock pattern as start: a duplicate restart
		// must not enqueue a second stream interruption.
		expect(updateMany).toHaveBeenCalledWith({
			where: expect.objectContaining({
				id: CHANNEL_ID,
				status: { in: ["RUNNING", "ERROR"] },
				liveEffectFenceVersion: 0,
				effectClaims: expect.anything(),
			}),
			// review-336 S2: the restart claim releases a stale lease like start's.
			data: expect.objectContaining({
				status: "PROVISIONING",
				error: null,
				provisionClaimedAt: null,
				liveEffectFenceVersion: { increment: 1 },
			}),
		});
		expect(queueAdd).toHaveBeenCalledWith(
			"live-channel",
			expect.objectContaining({
				liveChannelId: CHANNEL_ID,
				action: "restart",
				effect: expect.objectContaining({ action: "RESTART" }),
			}),
			expect.anything(),
		);

		findUnique.mockResolvedValueOnce(channel({ status: "PROVISIONING" }));
		expect((await postAction({ action: "restart" })).status).toBe(409);
	});

	it("restart: a STOPPED channel is refused, naming the real recovery (ledger #107)", async () => {
		// An operator hit this for real on 2026-08-16: the button was offered
		// on a stopped channel and Bitmovin answered
		//   409 … code 2028: Restarting the encoding … is not possible in its
		//   current state 'FINISHED'
		// because stopChannel calls stopLiveEncoding, so a stopped channel's
		// encoding is FINISHED by construction and its infrastructure is
		// deallocated. The recovery is a NEW encoding (Duplicate; C30 — confirmed via the vendor's docs assistant, which notes no public state matrix exists),
		// and the refusal has to say so — a bare "not restartable" would send
		// the operator back to the same button.
		findUnique.mockResolvedValueOnce(channel({ status: "STOPPED" }));
		const res = await postAction({ action: "restart" });
		expect(res.status).toBe(409);
		const body = (await res.json()) as { error: string };
		expect(body.error).toMatch(/FINISHED/);
		// Since the run model  the real recovery is START — a
		// re-air run with a fresh encoding on the SAME channel. The old
		// advice ("duplicate the channel") predated re-airs and sent the
		// operator to a heavier remedy than the one that now works (proved
		// by the real 2026-08-21 re-air).
		expect(body.error).toMatch(/START the channel/i);
		expect(body.error).not.toMatch(/ledger|STATUS #|task #/i);
		expect(body).toMatchObject({
			details: { code: "LIVE_ACTION_RESTART_REQUIRES_NEW_RUN" },
		});
		// And it must refuse BEFORE claiming or enqueueing: a claim would
		// park the channel in PROVISIONING for a restart that cannot happen.
		expect(updateMany).not.toHaveBeenCalled();
		expect(queueAdd).not.toHaveBeenCalled();
	});

	it("restart: 409s when a concurrent restart wins the claim", async () => {
		findUnique.mockResolvedValueOnce(channel({ status: "RUNNING" }));
		updateMany.mockResolvedValueOnce({ count: 0 });
		const res = await postAction({ action: "restart" });
		expect(res.status).toBe(409);
		expect(queueAdd).not.toHaveBeenCalled();
	});

	it("reset-timeshift: validates params and forwards them to the worker", async () => {
		const res = await postAction({
			action: "reset-timeshift",
			residualPeriodInSeconds: 600,
			manifestIds: ["m-1"],
		});
		expect(res.status).toBe(200);
		expect(queueAdd).toHaveBeenCalledWith(
			"live-channel",
			expect.objectContaining({
				liveChannelId: CHANNEL_ID,
				action: "reset-timeshift",
				params: { residualPeriodInSeconds: 600, manifestIds: ["m-1"] },
				effect: expect.objectContaining({ action: "TIMESHIFT_RESET" }),
			}),
			expect.anything(),
		);

		expect(
			(await postAction({ action: "reset-timeshift", manifestIds: [] })).status,
		).toBe(400);
	});

	it("scte35: requires a positive cueDuration and a RUNNING channel", async () => {
		const res = await postAction({ action: "scte35", cueDuration: 30 });
		expect(res.status).toBe(200);
		expect(queueAdd).toHaveBeenCalledWith(
			"live-channel",
			expect.objectContaining({
				liveChannelId: CHANNEL_ID,
				action: "scte35",
				params: { cueDuration: 30 },
				effect: expect.objectContaining({ action: "SCTE35" }),
			}),
			expect.anything(),
		);

		expect((await postAction({ action: "scte35" })).status).toBe(400);

		findUnique.mockResolvedValueOnce(channel({ status: "STOPPED" }));
		expect(
			(await postAction({ action: "scte35", cueDuration: 30 })).status,
		).toBe(409);
	});

	it("scte35: replays one request id once, rejects payload rebinding, and a new id creates a second cue", async () => {
		const first = await postAction({
			action: "scte35",
			requestId: REQUEST_ID,
			cueDuration: 30,
		});
		expect(first.status).toBe(200);
		expect(queueAdd).toHaveBeenCalledTimes(1);
		expect(queueAdd).toHaveBeenLastCalledWith(
			"live-channel",
			expect.objectContaining({
				effect: expect.objectContaining({
					idempotencyKey: `manual:scte35:${CHANNEL_ID}:${REQUEST_ID}`,
					requestSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
				}),
			}),
			expect.objectContaining({
				jobId: `${CHANNEL_ID}-scte35-${REQUEST_ID}`,
			}),
		);

		const replay = await postAction({
			action: "scte35",
			requestId: REQUEST_ID,
			cueDuration: 30,
		});
		expect(replay.status).toBe(200);
		expect((await replay.json()).idempotentReplay).toBe(true);
		expect(queueAdd).toHaveBeenCalledTimes(1);

		const rebound = await postAction({
			action: "scte35",
			requestId: REQUEST_ID,
			cueDuration: 60,
		});
		expect(rebound.status).toBe(409);
		expect(queueAdd).toHaveBeenCalledTimes(1);

		const nextRequestId = "00000000-0000-4000-8000-0000000000ee";
		expect(
			(
				await postAction({
					action: "scte35",
					requestId: nextRequestId,
					cueDuration: 30,
				})
			).status,
		).toBe(200);
		expect(queueAdd).toHaveBeenCalledTimes(2);
	});

	it("scte35: an ACKED database claim returns idempotent success without a second queue delivery", async () => {
		effectClaimFindUnique.mockResolvedValueOnce({
			requestSha256: "ignored-until-digest-is-known",
			liveChannelRunId: "run-current",
			providerEncodingId: "bm-live-enc",
			state: "ACKED",
		});
		const probe = await postAction({
			action: "scte35",
			requestId: REQUEST_ID,
			cueDuration: 30,
		});
		// Replace the digest-independent fixture with the digest emitted by a
		// first admission, then exercise the durable replay path.
		expect(probe.status).toBe(409);
		const firstDigest = (
			queueAdd.mock.calls[0]?.[1] as { effect?: { requestSha256?: string } }
		)?.effect?.requestSha256;
		if (!firstDigest) {
			// The 409 above intentionally queues nothing; obtain the canonical
			// digest through a normal admission.
			effectClaimFindUnique.mockResolvedValueOnce(null);
			await postAction({
				action: "scte35",
				requestId: REQUEST_ID,
				cueDuration: 30,
			});
		}
		const digest = (
			queueAdd.mock.calls.at(-1)?.[1] as {
				effect: { requestSha256: string };
			}
		).effect.requestSha256;
		queuedJobs.clear();
		queueAdd.mockClear();
		effectClaimFindUnique.mockResolvedValueOnce({
			requestSha256: digest,
			liveChannelRunId: RUN_ID,
			providerEncodingId: "bm-live-enc",
			action: "SCTE35",
			state: "ACKED",
			providerResultId: "provider-cue-1",
		});
		const replay = await postAction({
			action: "scte35",
			requestId: REQUEST_ID,
			cueDuration: 30,
		});
		expect(replay.status).toBe(200);
		expect(await replay.json()).toMatchObject({
			acknowledged: true,
			providerResultId: "provider-cue-1",
		});
		expect(queueAdd).not.toHaveBeenCalled();
	});

	it("scte35: never replays an ACK from an older run as success on the current run", async () => {
		const requestSha256 = createHash("sha256")
			.update(JSON.stringify({ cueDuration: 30, manifestIds: [] }))
			.digest("hex");
		effectClaimFindUnique.mockResolvedValueOnce({
			requestSha256,
			liveChannelRunId: "22222222-2222-4222-8222-222222222222",
			providerEncodingId: "bm-live-enc-old",
			action: "SCTE35",
			state: "ACKED",
			providerResultId: "provider-cue-old",
		});

		const replay = await postAction({
			action: "scte35",
			requestId: REQUEST_ID,
			cueDuration: 30,
		});

		expect(replay.status).toBe(409);
		expect(queueAdd).not.toHaveBeenCalled();
	});

	it("scte35: removes a retained terminal job and retries a conclusively FAILED claim", async () => {
		const first = await postAction({
			action: "scte35",
			requestId: REQUEST_ID,
			cueDuration: 30,
		});
		expect(first.status).toBe(200);
		const jobId = `${CHANNEL_ID}-scte35-${REQUEST_ID}`;
		const retained = queuedJobs.get(jobId);
		if (!retained) throw new Error("queued fixture missing");
		retained.state = "completed";
		const requestSha256 = (
			retained.data as { effect: { requestSha256: string } }
		).effect.requestSha256;
		effectClaimFindUnique.mockResolvedValueOnce({
			requestSha256,
			liveChannelRunId: RUN_ID,
			providerEncodingId: "bm-live-enc",
			action: "SCTE35",
			state: "FAILED",
		});

		const retry = await postAction({
			action: "scte35",
			requestId: REQUEST_ID,
			cueDuration: 30,
		});

		expect(retry.status).toBe(200);
		expect(queueAdd).toHaveBeenCalledTimes(2);
		expect(queuedJobs.get(jobId)).not.toBe(retained);
	});

	it("scte35: rejects a queued replay bound to an older run even when its payload digest matches", async () => {
		const first = await postAction({
			action: "scte35",
			requestId: REQUEST_ID,
			cueDuration: 30,
		});
		expect(first.status).toBe(200);
		const jobId = `${CHANNEL_ID}-scte35-${REQUEST_ID}`;
		const retained = queuedJobs.get(jobId);
		if (!retained) throw new Error("queued fixture missing");
		(
			retained.data as {
				effect: { liveChannelRunId: string; providerEncodingId: string };
			}
		).effect.liveChannelRunId = "22222222-2222-4222-8222-222222222222";

		const replay = await postAction({
			action: "scte35",
			requestId: REQUEST_ID,
			cueDuration: 30,
		});

		expect(replay.status).toBe(409);
		expect(queueAdd).toHaveBeenCalledTimes(1);
	});
});

/**
 * the route's half of the
 * observed paid sequence: a run the PROVIDER ended is never restarted and
 * never revived; UNKNOWN refuses new effects retryably. The persisted view
 * (`deriveProviderLifecycle` over the run columns) is what the route reads;
 * the worker re-reads the provider itself at every entry.
 */
describe("provider lifecycle admission (row #280)", () => {
	const terminalRun = () => ({
		id: "run-3",
		seq: 3,
		status: "ERROR",
		providerStatus: "FINISHED",
		providerStatusObservedAt: new Date(),
		providerUnknownSince: null,
		providerTerminalAt: new Date(),
	});
	const unknownRun = () => ({
		id: "run-3",
		seq: 3,
		status: "RUNNING",
		providerStatus: "RUNNING",
		providerStatusObservedAt: new Date(Date.now() - 10_000),
		providerUnknownSince: new Date(Date.now() - 5_000),
		providerTerminalAt: null,
	});
	/** A DONE CREATE_ENCODING — the log the audited revive replayed. */
	const doneLog = () => [
		{
			step: "live-input:main",
			kind: "CREATE_INPUT_RTMP",
			payload: {},
			refs: {},
			status: "DONE",
			resourceId: "bm-rtmp",
		},
		{
			step: "encoding",
			kind: "CREATE_ENCODING",
			payload: {},
			refs: {},
			status: "DONE",
			resourceId: "bm-live-enc",
		},
	];

	it("restart: a run the provider ENDED is refused before any claim or enqueue — provider restart calls 0 — naming a fresh Start", async () => {
		// The observed sequence, step 2: the old route claimed and enqueued,
		// the worker hit the vendor's 409 on the FINISHED encoding, and local
		// went ERROR with nothing recording why.
		findUnique.mockResolvedValueOnce(channel({ status: "ERROR" }));
		runFindFirst.mockResolvedValueOnce(terminalRun());
		const res = await postAction({ action: "restart" });
		expect(res.status).toBe(409);
		const body = (await res.json()) as {
			error: string;
			details: { code: string };
		};
		expect(body.error).toMatch(/has ended/);
		expect(body.error).toMatch(/START the channel/);
		expect(body.details.code).toBe("LIVE_ACTION_PROVIDER_TERMINAL");
		expect(updateMany).not.toHaveBeenCalled();
		expect(queueAdd).not.toHaveBeenCalled();
	});

	it("restart: an UNKNOWN provider view is refused retryably, with no claim and no enqueue", async () => {
		findUnique.mockResolvedValueOnce(channel({ status: "RUNNING" }));
		runFindFirst.mockResolvedValueOnce(unknownRun());
		const res = await postAction({ action: "restart" });
		expect(res.status).toBe(409);
		const body = (await res.json()) as {
			error: string;
			details: { code: string };
		};
		expect(body.error).toMatch(/cannot be confirmed/);
		expect(body.error).toMatch(/retry/);
		expect(body.details.code).toBe("LIVE_ACTION_PROVIDER_UNKNOWN");
		expect(updateMany).not.toHaveBeenCalled();
		expect(queueAdd).not.toHaveBeenCalled();
	});

	it.each([
		["no current run", null, /no current live run/],
		[
			"an unobserved current run",
			{
				id: "run-3",
				seq: 3,
				status: "RUNNING",
				providerStatus: null,
				providerStatusObservedAt: null,
				providerUnknownSince: null,
				providerTerminalAt: null,
			},
			/not been observed/,
		],
		[
			"a transitional current run",
			{
				id: "run-3",
				seq: 3,
				status: "RUNNING",
				providerStatus: "QUEUED",
				providerStatusObservedAt: new Date(),
				providerUnknownSince: null,
				providerTerminalAt: null,
			},
			/not RUNNING/,
		],
	] as const)("restart refuses %s before claim or enqueue", async (_name, run, reason) => {
		findUnique.mockResolvedValueOnce(channel({ status: "RUNNING" }));
		runFindFirst.mockResolvedValueOnce(run);
		const res = await postAction({ action: "restart" });
		expect(res.status).toBe(409);
		expect(((await res.json()) as { error: string }).error).toMatch(reason);
		expect(updateMany).not.toHaveBeenCalled();
		expect(queueAdd).not.toHaveBeenCalled();
	});

	it("restart: a run with a fresh confirmed RUNNING view is admitted as before", async () => {
		findUnique.mockResolvedValueOnce(channel({ status: "RUNNING" }));
		runFindFirst.mockResolvedValueOnce({
			id: "run-3",
			seq: 3,
			status: "RUNNING",
			providerStatus: "RUNNING",
			providerStatusObservedAt: new Date(),
			providerUnknownSince: null,
			providerTerminalAt: null,
		});
		const res = await postAction({ action: "restart" });
		expect(res.status).toBe(200);
		expect(queueAdd).toHaveBeenCalledWith(
			"live-channel",
			expect.objectContaining({
				liveChannelId: CHANNEL_ID,
				action: "restart",
				effect: expect.objectContaining({ action: "RESTART" }),
			}),
			expect.anything(),
		);
	});

	it("start from an ERROR run the provider ENDED is a RE-AIR — seq+1, a new run row, a fresh compiled log (no DONE step reused), channel columns cleared — never a revive", async () => {
		// The observed sequence, step 3: the old route saw channel ERROR × run
		// ERROR and REVIVED — same run, same FINISHED encoding id, DONE steps
		// kept — and provision wrote RUNNING over a dead encoder.
		findUnique.mockResolvedValueOnce(
			channel({ status: "ERROR", stepLog: doneLog() }),
		);
		runFindFirst.mockResolvedValueOnce(terminalRun());
		const res = await postAction({ action: "start" });
		expect(res.status).toBe(200);
		// A NEW run, next in sequence; the terminal run is left as history.
		expect(runUpdate).not.toHaveBeenCalled();
		expect(runCreate).toHaveBeenCalledTimes(1);
		const created = runCreate.mock.calls[0]?.[0]?.data as {
			seq: number;
			status: string;
			id?: string;
		};
		expect(created.seq).toBe(4);
		expect(created.status).toBe("PROVISIONING");
		expect(created.id).toBeDefined();
		// The channel's per-run columns are freed so provision builds a FRESH
		// encoding at fresh coordinates; the compiled log carries no resource
		// id from the finished run.
		const claim = updateMany.mock.calls[0]?.[0] as {
			data: {
				bitmovinEncodingId?: string | null;
				streamKey?: string | null;
				encoderIp?: string | null;
				stepLog: { kind: string; status: string; resourceId?: string }[];
			};
		};
		expect(claim.data.bitmovinEncodingId).toBeNull();
		expect(claim.data.streamKey).toBeNull();
		expect(claim.data.encoderIp).toBeNull();
		const encodingStep = claim.data.stepLog.find(
			(e) => e.kind === "CREATE_ENCODING",
		);
		expect(encodingStep?.status).toBe("PENDING");
		expect(encodingStep?.resourceId).toBeUndefined();
		expect(claim.data.stepLog.every((e) => e.status === "PENDING")).toBe(true);
		expect(queueAdd).toHaveBeenCalledWith(
			"live-channel",
			{ liveChannelId: CHANNEL_ID, action: "provision" },
			expect.anything(),
		);
	});

	it("control: start from an ERROR run WITHOUT a terminal provider view still revives (the same airing continues)", async () => {
		findUnique.mockResolvedValueOnce(
			channel({ status: "ERROR", stepLog: doneLog() }),
		);
		runFindFirst.mockResolvedValueOnce({
			id: "run-3",
			seq: 3,
			status: "ERROR",
			providerStatus: null,
			providerStatusObservedAt: null,
			providerUnknownSince: null,
			providerTerminalAt: null,
		});
		const res = await postAction({ action: "start" });
		expect(res.status).toBe(200);
		expect(runCreate).not.toHaveBeenCalled();
		expect(runUpdate).toHaveBeenCalledWith(
			expect.objectContaining({ where: { id: "run-3" } }),
		);
	});

	it.each([
		"scte35",
		"reset-timeshift",
	] as const)("%s on a RUNNING channel whose provider view is UNKNOWN or TERMINAL is refused; a confirmed one is forwarded", async (action) => {
		const body = action === "scte35" ? { action, cueDuration: 30 } : { action };
		findUnique.mockResolvedValueOnce(channel({ status: "RUNNING" }));
		runFindFirst.mockResolvedValueOnce(unknownRun());
		expect((await postAction(body)).status).toBe(409);
		findUnique.mockResolvedValueOnce(channel({ status: "RUNNING" }));
		runFindFirst.mockResolvedValueOnce({
			...terminalRun(),
			status: "RUNNING",
		});
		expect((await postAction(body)).status).toBe(409);
		expect(queueAdd).not.toHaveBeenCalled();
		findUnique.mockResolvedValueOnce(channel({ status: "RUNNING" }));
		runFindFirst.mockResolvedValueOnce({
			id: "run-3",
			seq: 3,
			status: "RUNNING",
			providerStatus: "RUNNING",
			providerStatusObservedAt: new Date(),
			providerUnknownSince: null,
			providerTerminalAt: null,
		});
		expect((await postAction(body)).status).toBe(200);
		expect(queueAdd).toHaveBeenCalledTimes(1);
	});
});

describe("stopping a stop that never confirmed (ledger #130 C-fold)", () => {
	async function stopClaim() {
		findUnique.mockResolvedValueOnce(
			channel({
				status: "STOPPED",
				bitmovinEncodingId: "enc-1",
				error: "the previous stop did not confirm",
			}),
		);
		const res = await postAction({ action: "stop" });
		expect(res.status).toBe(202);
		return queueAdd.mock.calls[0]?.[1] as {
			effect?: { action?: string };
		};
	}

	it("a STOPPED channel WITH an error can be stopped again — the remedy for the block", async () => {
		// This is the one state carrying positive recorded evidence that an
		// encoder may still be billing (the stop path persists its unconfirmed
		// outcome now). Before this, the app's only action for such a row was
		// deleting the local record —  as the easy path. A refusal
		// without a remedy is a trap, not a guard.
		const queued = await stopClaim();
		expect(queued.effect).toMatchObject({ action: "STOP" });
		expect(updateMany).not.toHaveBeenCalled();
	});

	it("a cleanly STOPPED channel still cannot — the error is the discriminator", async () => {
		findUnique.mockResolvedValueOnce(
			channel({
				status: "STOPPED",
				bitmovinEncodingId: "enc-1",
				error: null,
			}),
		);
		const res = await postAction({ action: "stop" });
		expect(res.status).toBe(409);
		expect(queueAdd).not.toHaveBeenCalled();
		expect(updateMany).not.toHaveBeenCalled();
	});
});

describe("re-airing over an unconfirmed stop (ledger #130 C-fold, round 2)", () => {
	it("refuses: the claim requires error null on the STOPPED arm", async () => {
		findUnique.mockResolvedValueOnce(
			channel({
				status: "STOPPED",
				bitmovinEncodingId: "enc-1",
				error: "stop did not confirm — enc-1: still RUNNING",
			}),
		);
		// The claim matches zero rows, which is the same shape as a concurrent
		// start losing the race — and the same 409.
		runFindFirst.mockResolvedValueOnce({
			id: "run-stopped",
			seq: 1,
			status: "STOPPED",
			providerStatus: "FINISHED",
			providerStatusObservedAt: new Date(),
			providerUnknownSince: null,
			providerTerminalAt: new Date(),
		});
		updateMany.mockResolvedValueOnce({ count: 0 });
		const res = await postAction({ action: "start" });
		expect(res.status).toBe(409);
		const claim = updateMany.mock.calls[0]?.[0] as {
			where: { OR: unknown[] };
		};
		expect(claim.where.OR).toContainEqual({
			status: "STOPPED",
			error: null,
		});
	});
});

describe("durable startup cancellation", () => {
	it("accepts a provisioning cancel before an encoding exists", async () => {
		findUnique.mockResolvedValue({
			id: CHANNEL_ID,
			status: "PROVISIONING",
			bitmovinEncodingId: null,
			liveEffectFenceVersion: 4,
		});
		runFindFirst.mockResolvedValue({
			id: RUN_ID,
			seq: 1,
			status: "PROVISIONING",
		});
		const response = await postAction({
			action: "cancel-start",
			generation: 4,
			runId: RUN_ID,
		});
		expect(response.status).toBe(202);
		expect(runUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: RUN_ID },
				data: expect.objectContaining({ cancelRequested: true }),
			}),
		);
		expect(queueAdd).toHaveBeenCalledWith(
			"live-channel",
			expect.objectContaining({
				action: "provision",
				params: { cancelRunId: RUN_ID },
			}),
			expect.anything(),
		);
		expect(update).not.toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ status: "STOPPED" }),
			}),
		);
	});
	it("rejects a delayed cancellation from a previous generation", async () => {
		findUnique.mockResolvedValue({
			id: CHANNEL_ID,
			status: "PROVISIONING",
			liveEffectFenceVersion: 5,
		});
		const response = await postAction({
			action: "cancel-start",
			generation: 4,
			runId: RUN_ID,
		});
		expect(response.status).toBe(409);
		expect(runUpdate).not.toHaveBeenCalled();
		expect(queueAdd).not.toHaveBeenCalled();
	});
});

describe("startup cancellation durability", () => {
	it("keeps accepted cancellation durable when Redis rejects the wake", async () => {
		findUnique.mockResolvedValue(
			channel({ status: "PROVISIONING", liveEffectFenceVersion: 4 }),
		);
		queueAdd.mockRejectedValueOnce(new Error("Redis down"));
		const response = await postAction({
			action: "cancel-start",
			generation: 4,
			runId: RUN_ID,
		});
		expect(response.status).toBe(202);
		expect(await response.json()).toMatchObject({
			status: "STOPPING",
			cancellationRequested: true,
		});
		expect(runUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				data: { cancelRequested: true, status: "STOPPING" },
			}),
		);
	});
	it("creates the cancellation run for an untouched CREATED channel", async () => {
		findUnique.mockResolvedValue(
			channel({ status: "CREATED", liveEffectFenceVersion: 0, stepLog: [] }),
		);
		runFindFirst.mockResolvedValue(null);
		runCreate.mockResolvedValueOnce({ id: RUN_ID });
		expect(
			(await postAction({ action: "cancel-start", generation: 0 })).status,
		).toBe(202);
		expect(runCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					seq: 1,
					cancelRequested: true,
					status: "STOPPING",
				}),
			}),
		);
	});
	it("reconciles a concurrent worker-created initial run instead of losing cancellation", async () => {
		findUnique.mockResolvedValue(
			channel({ status: "PROVISIONING", liveEffectFenceVersion: 0 }),
		);
		runFindFirst
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce({ id: RUN_ID, seq: 1, status: "PROVISIONING" });
		runCreate.mockRejectedValueOnce(
			Object.assign(new Error("concurrent run insert"), { code: "P2002" }),
		);
		expect(
			(await postAction({ action: "cancel-start", generation: 0 })).status,
		).toBe(202);
		expect(runCreate).toHaveBeenCalledTimes(1);
		expect(runUpdate).toHaveBeenCalledWith(
			expect.objectContaining({ where: { id: RUN_ID } }),
		);
	});
	it("does not revive or restart a pending cancellation after a dead-job ERROR", async () => {
		findUnique.mockResolvedValue(
			channel({ status: "ERROR", liveEffectFenceVersion: 4 }),
		);
		runFindFirst.mockResolvedValue({
			id: RUN_ID,
			seq: 1,
			status: "ERROR",
			cancelRequested: true,
			providerStatus: "RUNNING",
			providerStatusObservedAt: new Date(),
		});
		expect((await postAction({ action: "start" })).status).toBe(409);
		expect((await postAction({ action: "restart" })).status).toBe(409);
		expect(queueAdd).not.toHaveBeenCalled();
		expect(runUpdate).not.toHaveBeenCalled();
	});
});
