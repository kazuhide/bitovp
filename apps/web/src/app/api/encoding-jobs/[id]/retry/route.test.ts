import {
	type EncodingPlan,
	encodingPlanSchema,
	validatePlan,
} from "@bitovp/core";
import type { VodInputTimelinePlacedClip } from "@bitovp/core/vod-input-timeline";
import { buildPlan, DEFAULT_WIZARD_STATE } from "@bitovp/core/wizard";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const findUnique = vi.fn();
const updateMany = vi.fn();
const update = vi.fn();
const queueAdd = vi.fn();

vi.mock("@/lib/server/context", () => ({
	getServerContext: () => ({
		prisma: { encodingJob: { findUnique, updateMany, update } },
	}),
}));

vi.mock("@/lib/server/queue", () => ({
	getOrchestratorQueue: () => ({ add: queueAdd }),
}));

import { POST } from "./route";

const ID = "00000000-0000-4000-8000-0000000000aa";
const params = { params: Promise.resolve({ id: ID }) };
const req = () => new Request("http://test", { method: "POST" });

function nativeQcPlan(only = false): EncodingPlan {
	return encodingPlanSchema.parse({
		planVersion: 1,
		name: "native HEVCv2 retained failed plan",
		bitmovin: {},
		generation: { timing: "JUST_IN_TIME" },
		inputs: [{ key: "main", kind: "S3", credentialId: ID, bucket: "input" }],
		outputs: [
			{ key: "origin", kind: "S3", credentialId: ID, bucket: "output" },
		],
		ingest: [
			{
				key: "video",
				inputKey: "main",
				inputPath: "bbb.mov",
				selectionMode: "VIDEO_RELATIVE",
				position: 0,
			},
		],
		renditions: [
			{
				key: "v1080",
				codec: "H265",
				ingestKey: "video",
				width: 1920,
				height: 1080,
				bitrate: 2_000_000,
				rate: 24,
				mode: "STANDARD",
			},
		],
		muxings: [
			{
				key: "video",
				kind: "FMP4",
				streamKey: "v1080",
				segmentLength: 4,
				destination: { outputKey: "origin", path: "video/1080/" },
			},
		],
		internal: { hevcV2: { bcfVersion: "v2.325.0-461-g85df7fd6c6" } },
		qc: { vmaf: false, banding: true, only },
	});
}

function independentConcatenationPlan(aligned = false): EncodingPlan {
	const clip = (
		n: number,
		sourceKey: string,
		startMs: number,
		inMs: number,
		outMs: number,
	): VodInputTimelinePlacedClip => ({
		id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
		sourceKey,
		startMs,
		inMs,
		outMs,
	});
	const videoClips = [
		clip(2, "bbb", 0, 10_000, 18_000),
		clip(3, "normalized", 8000, 0, 2000),
		clip(4, "still", 10_000, 0, 2000),
		clip(5, "normalized", 12_000, 4000, 8000),
		clip(6, "bbb", 16_000, 60_000, 68_000),
	];
	return encodingPlanSchema.parse(
		buildPlan({
			...structuredClone(DEFAULT_WIZARD_STATE),
			name: "Retained five-video/three-audio qualification",
			accountId: ID,
			inputFiles: ["bbb", "normalized", "still"].map((key) => ({
				key,
				inputKey: "source",
				kind: "S3",
				credentialId: ID,
				bucket: "input",
				path: `${key}.mp4`,
			})),
			output: {
				...DEFAULT_WIZARD_STATE.output,
				credentialId: ID,
				bucket: "output",
			},
			videos: [{ height: 360, bitrate: 400_000 }],
			audios: [{ bitrate: 96_000, rate: 48_000 }],
			manifests: { hls: false, dash: false },
			inputTimeline: {
				schemaVersion: 2,
				id: ID,
				audioEnabled: true,
				durationMs: 24_000,
				videoClips,
				audioClips: aligned
					? structuredClone(videoClips)
					: [
							clip(7, "bbb", 0, 10_000, 18_000),
							clip(8, "normalized", 8000, 0, 8000),
							clip(9, "bbb", 16_000, 60_000, 68_000),
						],
			},
		}),
	);
}

const failedStart = [
	{
		step: "start",
		kind: "START_ENCODING",
		status: "FAILED",
		payload: {},
		refs: { encodingId: "encoding" },
		error: "provider rejected start",
	},
];

beforeEach(() => {
	vi.clearAllMocks();
	vi.stubEnv("MASTER_KEY", Buffer.alloc(32, 7).toString("base64"));
	updateMany.mockResolvedValue({ count: 1 });
	queueAdd.mockResolvedValue({});
});

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("POST /api/encoding-jobs/[id]/retry", () => {
	it("does not reset steps or enqueue a prepared-input retry without current owned evidence", async () => {
		const plan = nativeQcPlan();
		plan.inputTimelinePreparation = { taskId: ID, requestHash: "a".repeat(64) };
		findUnique.mockResolvedValueOnce({
			id: ID,
			status: "ERROR",
			plan,
			stepLog: failedStart,
		});
		const response = await POST(req(), params);
		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({
			details: { code: "INPUT_PREPARATION_INVALID" },
		});
		expect(updateMany).not.toHaveBeenCalled();
		expect(update).not.toHaveBeenCalled();
		expect(queueAdd).not.toHaveBeenCalled();
	});
	it.each([
		"failed start",
		"failed await after completed start",
	])("refuses the retained unqualified five-video/three-audio plan with %s before changing or enqueueing it", async (shape) => {
		const plan = independentConcatenationPlan();
		expect(
			plan.concatenationStreams.map((item) => item.sources.length),
		).toEqual([5, 3]);
		expect(validatePlan(plan)).toContainEqual(
			expect.objectContaining({
				code: "PLAN_CONCATENATION_AV_UNQUALIFIED",
				level: "error",
			}),
		);
		const stepLog = [
			{
				step: "encoding",
				kind: "CREATE_ENCODING",
				status: "DONE",
				payload: {},
				refs: {},
				resourceId: "retained-encoding",
			},
			{
				...failedStart[0],
				status: shape === "failed start" ? "FAILED" : "DONE",
			},
			{
				step: "await",
				kind: "AWAIT_ENCODING",
				status: shape === "failed start" ? "PENDING" : "FAILED",
				payload: {},
				refs: { encodingId: "retained-encoding" },
			},
		];
		const row = { id: ID, status: "ERROR", plan, stepLog };
		const snapshot = structuredClone(row);
		findUnique.mockResolvedValueOnce(row);
		const response = await POST(req(), params);
		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({
			details: { code: "PLAN_CONCATENATION_AV_UNQUALIFIED" },
			error: expect.stringContaining("corrected new job"),
		});
		expect(row).toEqual(snapshot);
		expect(updateMany).not.toHaveBeenCalled();
		expect(update).not.toHaveBeenCalled();
		expect(queueAdd).not.toHaveBeenCalled();
	});

	it("preserves retry of a qualified aligned AV concatenation", async () => {
		const plan = independentConcatenationPlan(true);
		expect(
			validatePlan(plan).filter((issue) => issue.level === "error"),
		).toEqual([]);
		findUnique.mockResolvedValueOnce({
			id: ID,
			status: "ERROR",
			plan,
			stepLog: failedStart,
		});
		expect((await POST(req(), params)).status).toBe(200);
		expect(updateMany).toHaveBeenCalledOnce();
		expect(queueAdd).toHaveBeenCalledOnce();
	});

	it.each([
		"generated QC mirror",
		"two delivery muxings",
	])("refuses retained native HEVCv2 with %s before claiming or enqueueing", async (shape) => {
		const plan = nativeQcPlan();
		if (shape === "two delivery muxings") {
			delete plan.qc;
			const muxing = plan.muxings[0];
			if (!muxing) throw new Error("Missing muxing fixture");
			plan.muxings.push({ ...muxing, key: "second-delivery" });
		}
		findUnique.mockResolvedValueOnce({
			id: ID,
			status: "ERROR",
			plan,
			stepLog: failedStart,
		});
		const response = await POST(req(), params);
		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({
			details: { code: "PLAN_INTERNAL_HEVC_V2_MULTIPLE_MUXINGS" },
			error: expect.stringContaining("SMART_PASS"),
		});
		expect(updateMany).not.toHaveBeenCalled();
		expect(update).not.toHaveBeenCalled();
		expect(queueAdd).not.toHaveBeenCalled();
	});

	it.each([
		"native QC-only",
		"ordinary HEVCv1",
		"native legacy unrelated validation error",
	])("preserves compiled retry semantics for %s", async (shape) => {
		const plan = nativeQcPlan(shape !== "ordinary HEVCv1");
		if (shape === "ordinary HEVCv1") delete plan.internal;
		if (shape === "native legacy unrelated validation error") {
			plan.ingest = [];
			expect(validatePlan(plan).some((issue) => issue.level === "error")).toBe(
				true,
			);
		}
		findUnique.mockResolvedValueOnce({
			id: ID,
			status: "ERROR",
			plan,
			stepLog: failedStart,
		});
		const response = await POST(req(), params);
		expect(response.status).toBe(200);
		expect(updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: "QUEUED",
					stepLog: [
						expect.objectContaining({
							step: "start",
							status: "PENDING",
							refs: { encodingId: "encoding" },
						}),
					],
				}),
			}),
		);
		expect(queueAdd).toHaveBeenCalledOnce();
	});

	it("refuses irreversible remote STOP intent even if the job remains ERROR", async () => {
		findUnique.mockResolvedValueOnce({
			id: ID,
			status: "ERROR",
			stepLog: [],
			remoteStopRequestedAt: new Date("2026-09-01T00:00:00Z"),
		});
		const res = await POST(req(), params);
		expect(res.status).toBe(409);
		expect(await res.json()).toMatchObject({
			error: expect.stringContaining("re-run-as-new"),
		});
		expect(updateMany).not.toHaveBeenCalled();
		expect(queueAdd).not.toHaveBeenCalled();
	});
	it("404s unknown jobs", async () => {
		findUnique.mockResolvedValueOnce(null);
		expect((await POST(req(), params)).status).toBe(404);
	});

	it("409s when the job is not in ERROR", async () => {
		findUnique.mockResolvedValueOnce({ id: ID, status: "RUNNING" });
		expect((await POST(req(), params)).status).toBe(409);
		expect(queueAdd).not.toHaveBeenCalled();
	});

	it("resets failed steps, claims atomically, and re-enqueues", async () => {
		findUnique.mockResolvedValueOnce({
			id: ID,
			status: "ERROR",
			stepLog: [
				{
					step: "input:main",
					kind: "CREATE_INPUT_S3",
					payload: {},
					refs: {},
					status: "DONE",
					resourceId: "bm-1",
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
		});
		const res = await POST(req(), params);
		expect(res.status).toBe(200);

		const args = updateMany.mock.calls[0]?.[0] as {
			where: unknown;
			data: { stepLog: { step: string; status: string }[] };
		};
		expect(args.where).toEqual({
			id: ID,
			status: "ERROR",
			remoteStopRequestedAt: null,
		});
		// rev431: a retry may resume the same encoding, so any stop/CREATED
		// confirmation for its pointer is cleared with the QUEUED flip
		expect(
			(args.data as { encoderStoppedConfirmedFor?: unknown })
				.encoderStoppedConfirmedFor,
		).toBeNull();
		expect(args.data.stepLog.find((s) => s.step === "input:main")?.status).toBe(
			"DONE",
		);
		expect(args.data.stepLog.find((s) => s.step === "encoding")?.status).toBe(
			"PENDING",
		);
		expect(queueAdd).toHaveBeenCalled();
	});

	it("409s when another retry claimed the row first", async () => {
		findUnique.mockResolvedValueOnce({ id: ID, status: "ERROR", stepLog: [] });
		updateMany.mockResolvedValueOnce({ count: 0 });
		expect((await POST(req(), params)).status).toBe(409);
		expect(queueAdd).not.toHaveBeenCalled();
	});

	it("marks the row ERROR again when enqueue fails", async () => {
		findUnique.mockResolvedValueOnce({ id: ID, status: "ERROR", stepLog: [] });
		queueAdd.mockRejectedValueOnce(new Error("redis down"));
		const res = await POST(req(), params);
		expect(res.status).toBe(500);
		expect(update).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ status: "ERROR" }),
			}),
		);
	});
});
