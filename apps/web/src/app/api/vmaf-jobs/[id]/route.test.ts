import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { gzipSync } from "node:zlib";
import {
	assessBandingFrames,
	computeBandingPooled,
	computePooled,
	encodingPlanSchema,
	enumerateQcTargets,
	type VmafFrame,
} from "@bitovp/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const findUnique = vi.fn();
const resultFindFirst = vi.fn(async (args) => {
	const job = await findUnique.mock.results.at(-1)?.value;
	return (
		job?.results.find(
			(result: { id: string }) =>
				result.id === args.where.id && job.id === args.where.vmafJobId,
		) ?? null
	);
});
const computeFindMany = vi.fn();
const jobDeleteMany = vi.fn();
const auditCreate = vi.fn();

// Interactive $transaction: invoke the callback with a tx exposing the model
// method the route uses (vmafJob.deleteMany).
const tx = { vmafJob: { deleteMany: jobDeleteMany } };
const $transaction = vi.fn((cb: (t: typeof tx) => Promise<unknown>) => cb(tx));

let qcVmafEnabled = true;

vi.mock("@/lib/server/context", () => ({
	getServerContext: () => ({
		tenant: { organizationId: "00000000-0000-4000-8000-000000000001" },
		prisma: {
			// : the flag gate reads through the same context. The
			// harness default is ON so every pre-existing case keeps testing
			// what it was written for; the off-case pin flips it.
			appSetting: {
				findUnique: async () => ({ value: { qcVmaf: qcVmafEnabled } }),
			},
			vmafJob: { findUnique, deleteMany: jobDeleteMany },
			vmafResult: { findFirst: resultFindFirst },
			vmafComputeTask: { findMany: computeFindMany },
			auditLog: { create: auditCreate },
			$transaction,
		},
	}),
}));

import { DELETE, GET } from "./route";

const JOB_ID = "00000000-0000-4000-8000-0000000000a1";

function frames(scores: number[]): VmafFrame[] {
	return scores.map((vmaf, frameNum) => ({ frameNum, vmaf }));
}
function gz(f: VmafFrame[]): Buffer {
	return gzipSync(Buffer.from(JSON.stringify(f), "utf8"));
}
function req() {
	return new Request(`http://test/api/vmaf-jobs/${JOB_ID}`);
}
function params(id: string) {
	return { params: Promise.resolve({ id }) };
}
function delReq(id = JOB_ID) {
	return DELETE(
		new Request(`http://test/api/vmaf-jobs/${id}`, { method: "DELETE" }),
		params(id),
	);
}

beforeEach(() => {
	qcVmafEnabled = true;
	vi.clearAllMocks();
	// Guarded delete affects 1 row by default (terminal row present).
	jobDeleteMany.mockResolvedValue({ count: 1 });
	auditCreate.mockResolvedValue({});
});

describe("GET /api/vmaf-jobs/[id]", () => {
	it.each([
		true,
		false,
	])("projects a time-based pinned CAMBI preview without reference FPS (bandingOnly=%s)", async (bandingOnly) => {
		const plan = encodingPlanSchema.parse({
			...JSON.parse(
				readFileSync(
					resolve(
						process.cwd(),
						"../../packages/core/src/plan/__fixtures__/fixed-bitrate-hls-on-aws.plan.json",
					),
					"utf8",
				),
			),
			qc: { vmaf: false, banding: true, only: true },
		});
		const target = enumerateQcTargets(
			encodingPlanSchema.parse({ ...plan, qc: { vmaf: true } }),
		)[0];
		if (!target) throw new Error("Missing fixture target");
		const banding = [
			{ frameNum: 0, timestampSeconds: 0, durationSeconds: 0.08, cambi: 9 },
		];
		const resultId = "00000000-0000-4000-8000-0000000000b1";
		findUnique.mockResolvedValueOnce({
			id: JOB_ID,
			mode: "VOD",
			model: bandingOnly ? "CAMBI" : "vmaf_v0.6.1",
			params: bandingOnly ? { kind: "BANDING" } : { banding: true },
			encodingJob: { name: "Measured", plan },
			createdAt: new Date(),
			updatedAt: new Date(),
			results: [
				{
					id: resultId,
					renditionRef: { renditionKey: target.renditionKey },
					pooled: {
						...(!bandingOnly ? computePooled(frames([95])) : {}),
						banding: computeBandingPooled(banding),
					},
					framesGzip: gzipSync(
						JSON.stringify({
							kind: "QC_FRAMES",
							version: 1,
							banding,
							...(!bandingOnly ? { vmaf: frames([95]) } : {}),
						}),
					),
					provenance: {
						distorted: {
							bucket: "sample-output-bucket",
							key: target.distorted.path,
							pinned: true,
							bytes: 10,
							identity: { size: 10, etag: "private-version" },
						},
					},
				},
			],
		});
		const response = await GET(req(), params(JOB_ID));
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body.results[0].bandingPreview).toEqual({
			url: `/api/vmaf-jobs/${JOB_ID}/preview?resultId=${resultId}&metric=banding&expectedOrganizationId=00000000-0000-4000-8000-000000000001`,
		});
		expect(JSON.stringify(body)).not.toMatch(
			/private-version|sample-output-bucket|credentialId|provenance/,
		);
		if (bandingOnly) expect(body.results[0]).not.toHaveProperty("preview");
		else
			expect(body.results[0].preview).toEqual({
				unavailableReason: "MISSING_FPS",
			});
	});
	it("returns full-frame CAMBI evidence with no VMAF model, pooled scores or fabricated frames", async () => {
		const banding = Array.from({ length: 1502 }, (_, frameNum) => ({
			frameNum,
			timestampSeconds: frameNum * 0.04,
			durationSeconds: 0.04,
			cambi: frameNum === 1000 ? 12 : 1,
			computedCambi: frameNum === 1000 ? 12.001 : 1,
		}));
		const pooled = computeBandingPooled(banding);
		const assessment = {
			...assessBandingFrames(banding, { warningThreshold: 5 }),
			warningThreshold: 5,
		};
		findUnique.mockResolvedValueOnce({
			id: JOB_ID,
			model: "CAMBI",
			mode: "VOD",
			params: {
				kind: "BANDING",
				execution: { backend: "LOCAL", localMode: "AUTO" },
				reference: { width: 1920, height: 1080 },
			},
			scoringVersion: 11,
			status: "FINISHED",
			createdAt: new Date(),
			updatedAt: new Date(),
			results: [
				{
					id: "banding-result",
					renditionRef: { label: "360p" },
					pooled: { banding: pooled, bandingAssessment: assessment },
					framesGzip: gzipSync(
						JSON.stringify({ kind: "QC_FRAMES", version: 1, banding }),
					),
					provenance: {
						privatePath: "/private/source.mp4",
						bandingExecution: {
							version: 1,
							metric: "CAMBI_NR",
							backend: "cuda",
							implementation: "bitovp-owned",
							decisionSource: "CPU_REFERENCE",
							coverage: {
								complete: true,
								frameCount: banding.length,
								durationSeconds: pooled.durationSeconds,
							},
							receipt: { privatePath: "/private/receipt.json" },
						},
					},
				},
			],
		});
		const response = await GET(req(), params(JOB_ID));
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body).toMatchObject({
			kind: "BANDING",
			model: null,
			detector: "CAMBI",
			reference: null,
		});
		expect(body.results[0].pooled).toEqual({ banding: pooled });
		expect(body.results[0]).not.toHaveProperty("frames");
		expect(body.results[0].bandingFrames.length).toBeLessThanOrEqual(1500);
		expect(body.results[0].bandingAssessment).toEqual(assessment);
		expect(body.results[0].bandingFrameCount).toBe(1502);
		expect(JSON.stringify(body)).not.toMatch(/private|receipt/);
	});

	it("does not reinterpret a historical model string as a Banding discriminator", async () => {
		const original = frames([95]);
		findUnique.mockResolvedValueOnce({
			id: JOB_ID,
			model: "CAMBI",
			params: {},
			createdAt: new Date(),
			updatedAt: new Date(),
			results: [
				{
					id: "legacy",
					renditionRef: {},
					pooled: computePooled(original),
					framesGzip: gz(original),
				},
			],
		});
		const response = await GET(req(), params(JOB_ID));
		const body = await response.json();
		expect(body.model).toBe("CAMBI");
		expect(body).not.toHaveProperty("kind");
		expect(body.results[0].frames).toEqual([{ ...original[0], worst: true }]);
		expect(body.results[0]).not.toHaveProperty("bandingFrames");
	});
	it.each([
		"cpu",
		"cuda",
	] as const)("projects safe per-result %s scoring provenance", async (backend) => {
		const localExecution = {
			version: 1,
			requestedDecode: "auto",
			device: 0,
			decode: {
				reference: { backend: "cuda" },
				distorted: { backend: "cpu", reason: "CUDA_UNSUPPORTED_CODEC" },
			},
			scoring:
				backend === "cpu"
					? { backend, implementation: "libvmaf", model: "vmaf_v1.0.16_3d0h" }
					: {
							backend,
							implementation: "vmafx",
							model: "vmaf_v1.0.16_3d0h",
							modelSha256: "a".repeat(64),
							bitDepth: 10,
							distortedOriginal: { width: 1280, height: 720, bitdepth: 8 },
							features: ["adm_cuda"],
						},
			attempts: 1,
		};
		findUnique.mockResolvedValueOnce({
			id: JOB_ID,
			params: {},
			createdAt: new Date(),
			updatedAt: new Date(),
			results: [
				{
					id: "result-id",
					renditionRef: {},
					pooled: computePooled(frames([95])),
					framesGzip: null,
					provenance: {
						reference: { path: "/private/input.mp4" },
						stderr: "private diagnostic",
						localExecution,
					},
				},
			],
		});
		const response = await GET(req(), params(JOB_ID));
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body.results[0].localExecution).toEqual(localExecution);
		expect(JSON.stringify(body)).not.toMatch(/private|stderr|provenance/);
	});

	it.each([
		undefined,
		null,
		{ version: 2 },
		{ version: 1, stderr: "/private/input.mp4" },
	])("omits unknown or invalid local execution metadata: %j", async (localExecution) => {
		findUnique.mockResolvedValueOnce({
			id: JOB_ID,
			params: {},
			createdAt: new Date(),
			updatedAt: new Date(),
			results: [
				{
					id: "result-id",
					renditionRef: {},
					pooled: computePooled(frames([95])),
					framesGzip: null,
					provenance: { localExecution },
				},
			],
		});
		const response = await GET(req(), params(JOB_ID));
		const body = await response.json();
		expect(body.results[0]).not.toHaveProperty("localExecution");
	});

	it("projects safe cloud task status without private configuration or provider errors", async () => {
		const now = new Date("2026-09-24T00:00:00Z");
		const execution = {
			backend: "CLOUD",
			profileId: "aws-test",
			budgetUsd: 12,
		};
		findUnique.mockResolvedValueOnce({
			id: JOB_ID,
			params: { execution, secret: "private" },
			results: [],
			createdAt: now,
			updatedAt: now,
		});
		computeFindMany.mockResolvedValueOnce([
			{
				id: "task-id",
				profileId: "aws-test",
				state: "CLEANUP_PENDING",
				reservedUsd: 2,
				createdAt: now,
				cleanedAt: null,
				error: "https://private-token",
				profile: { secret: "private" },
				providerId: "private-provider",
			},
		]);
		const response = await GET(req(), params(JOB_ID));
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body.execution).toEqual(execution);
		expect(body.computeTasks).toEqual([
			{
				id: "task-id",
				profileId: "aws-test",
				state: "CLEANUP_PENDING",
				reservedUsd: 2,
				createdAt: now.toISOString(),
				cleanedAt: null,
				error: "Cloud task needs operator attention",
				current: true,
				attempt: 1,
				progress: null,
			},
		]);
		expect(JSON.stringify(body)).not.toContain("private");
		expect(computeFindMany.mock.calls[0]?.[0]?.select).not.toHaveProperty(
			"profile",
		);
		expect(computeFindMany.mock.calls[0]?.[0]?.select).not.toHaveProperty(
			"providerId",
		);
	});

	it("projects the measured-media descriptor without exposing the plan or provenance", async () => {
		const plan = encodingPlanSchema.parse({
			...JSON.parse(
				readFileSync(
					resolve(
						process.cwd(),
						"../../packages/core/src/plan/__fixtures__/fixed-bitrate-hls-on-aws.plan.json",
					),
					"utf8",
				),
			),
			qc: { vmaf: true },
		});
		const target = enumerateQcTargets(plan)[0];
		if (!target) throw new Error("Missing fixture target");
		const resultId = "00000000-0000-4000-8000-0000000000b1";
		findUnique.mockResolvedValueOnce({
			id: JOB_ID,
			encodingJobId: "00000000-0000-4000-8000-0000000000e1",
			encodingJob: { name: "test", plan },
			mode: "VOD",
			params: { reference: { fps: 24 } },
			createdAt: new Date(),
			updatedAt: new Date(),
			results: [
				{
					id: resultId,
					renditionRef: { renditionKey: target.renditionKey },
					pooled: computePooled(frames([95])),
					framesGzip: null,
					provenance: {
						distorted: {
							bucket: "sample-output-bucket",
							key: target.distorted.path,
							pinned: true,
							bytes: 10,
							identity: { size: 10, etag: '"private-identity"' },
						},
					},
				},
			],
		});
		const res = await GET(req(), params(JOB_ID));
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.results[0].preview).toEqual({
			url: `/api/vmaf-jobs/${JOB_ID}/preview?resultId=${resultId}&expectedOrganizationId=00000000-0000-4000-8000-000000000001`,
		});
		expect(JSON.stringify(body)).not.toMatch(
			/private-identity|sample-output-bucket|credentialId|provenance/,
		);
		expect(findUnique.mock.calls[0]?.[0]).toMatchObject({
			select: {
				encodingJob: { select: { plan: true } },
				results: { select: { provenance: true } },
			},
		});
	});
	it("400s a non-uuid id", async () => {
		const res = await GET(new Request("http://test/api/vmaf-jobs/nope"), {
			params: Promise.resolve({ id: "nope" }),
		});
		expect(res.status).toBe(400);
		expect(findUnique).not.toHaveBeenCalled();
	});

	it("404s a missing job", async () => {
		findUnique.mockResolvedValueOnce(null);
		const res = await GET(req(), params(JOB_ID));
		expect(res.status).toBe(404);
	});

	it("returns pooled exactly and a downsampled series that keeps the worst frame", async () => {
		// 20k frames with a buried dip — must come back downsampled but with the
		// dip intact (the whole point of the report).
		const scores = Array.from({ length: 20_000 }, () => 95);
		const worstIdx = 12_345;
		scores[worstIdx] = 12;
		const f = frames(scores);
		const pooled = computePooled(f);

		findUnique.mockResolvedValueOnce({
			id: JOB_ID,
			encodingJobId: "00000000-0000-4000-8000-0000000000e1",
			encodingJob: { name: "bbb-pte-crf-17" },
			mode: "VOD",
			model: "vmaf_v0.6.1",
			scoringVersion: 2,
			status: "FINISHED",
			error: null,
			totalUnits: 3,
			doneUnits: 3,
			cores: 8,
			threads: 4,
			concurrency: 2,
			createdAt: new Date("2026-06-18T00:00:00Z"),
			updatedAt: new Date("2026-06-18T00:00:00Z"),
			results: [
				{
					id: "00000000-0000-4000-8000-0000000000b1",
					renditionRef: { label: "1080p", height: 1080, bitrate: 4_500_000 },
					pooled,
					framesGzip: gz(f),
				},
			],
		});

		const res = await GET(req(), params(JOB_ID));
		expect(res.status).toBe(200);
		const body = await res.json();
		const result = body.results[0];

		// progress + execution observability fields are projected through, plus
		// the linked encoding's name (the report's human title).
		expect(body).toMatchObject({
			encodingName: "bbb-pte-crf-17",
			/**
			 * The scoring generation must SURVIVE the response, not merely be
			 * selected. It shipped selected-but-dropped here too, and the visible
			 * result was a red "gen 1 — understated" badge on this very screen for
			 * every report, including the freshly-corrected ones. No component test
			 * could see it: they mock `apiFetch` and supply what the route omitted.
			 *
			 * Asserted from a SECOND row below as well, because this value alone
			 * cannot fail for the way the code would plausibly break: a hardcoded
			 * `scoringVersion: 2` in the payload would satisfy it (review catch).
			 */
			scoringVersion: 2,
			totalUnits: 3,
			doneUnits: 3,
			cores: 8,
			threads: 4,
			concurrency: 2,
		});

		// frameCount discloses the true size; frames are downsampled (<= cap).
		expect(result.frameCount).toBe(20_000);
		expect(result.preview).toEqual({ unavailableReason: "MISSING_FPS" });
		expect(result.frames.length).toBeLessThanOrEqual(1500);
		expect(result.frames.length).toBeGreaterThan(0);

		// pooled is byte-for-byte the stored value.
		expect(result.pooled.mean).toBeCloseTo(pooled.mean, 6);
		expect(result.pooled.worstFrame).toEqual({ frameNum: worstIdx, vmaf: 12 });

		// the worst frame survived downsampling and is flagged.
		const worst = result.frames.find(
			(x: { frameNum: number }) => x.frameNum === worstIdx,
		);
		expect(worst).toMatchObject({ frameNum: worstIdx, vmaf: 12, worst: true });
	});

	it("reflects the ROW's scoring generation, not a constant", async () => {
		/**
		 * The companion to the assertion above. One row at generation 2 proves the
		 * field crosses; it does not prove the value came from the row. A second row
		 * at generation 1 does, and it is the assertion that fails if someone writes
		 * a literal into the payload.
		 */
		findUnique.mockResolvedValueOnce({
			id: JOB_ID,
			encodingJobId: null,
			encodingJob: null,
			mode: "LIVE",
			model: "vmaf_v0.6.1",
			scoringVersion: 1,
			status: "FINISHED",
			error: null,
			totalUnits: 0,
			doneUnits: 0,
			cores: 8,
			threads: 4,
			concurrency: 1,
			createdAt: new Date("2026-06-18T00:00:00Z"),
			updatedAt: new Date("2026-06-18T00:00:00Z"),
			results: [],
		});
		const res = await GET(req(), params(JOB_ID));
		expect(res.status).toBe(200);
		expect((await res.json()).scoringVersion).toBe(1);
	});

	it("tolerates a result with no framesGzip (empty series, frameCount 0)", async () => {
		findUnique.mockResolvedValueOnce({
			id: JOB_ID,
			encodingJobId: "00000000-0000-4000-8000-0000000000c1",
			// encodingJob unselected/absent → encodingName falls back to null.
			encodingJob: null,
			mode: "VOD",
			model: "vmaf_v0.6.1",
			status: "RUNNING",
			error: null,
			createdAt: new Date(),
			updatedAt: new Date(),
			results: [
				{
					id: "00000000-0000-4000-8000-0000000000b2",
					renditionRef: { label: "720p" },
					pooled: computePooled(frames([90])),
					framesGzip: null,
				},
			],
		});
		const res = await GET(req(), params(JOB_ID));
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.encodingName).toBeNull();
		expect(body.results[0].frames).toEqual([]);
		expect(body.results[0].frameCount).toBe(0);
	});
});

describe("DELETE /api/vmaf-jobs/[id]", () => {
	it("400s a non-uuid id before touching the DB", async () => {
		const res = await delReq("nope");
		expect(res.status).toBe(400);
		expect(findUnique).not.toHaveBeenCalled();
		expect(jobDeleteMany).not.toHaveBeenCalled();
	});

	it("404s a missing report", async () => {
		findUnique.mockResolvedValueOnce(null);
		const res = await delReq();
		expect(res.status).toBe(404);
		expect(jobDeleteMany).not.toHaveBeenCalled();
	});

	it.each([
		"PENDING",
		"RUNNING",
	])("409s an in-flight report (%s) without deleting", async (status) => {
		findUnique.mockResolvedValueOnce({ id: JOB_ID, status });
		const res = await delReq();
		expect(res.status).toBe(409);
		expect($transaction).not.toHaveBeenCalled();
		expect(jobDeleteMany).not.toHaveBeenCalled();
	});

	it.each([
		"FINISHED",
		"ERROR",
	])("deletes a terminal report (%s) via the atomically-guarded deleteMany — results cascade by FK", async (status) => {
		findUnique.mockResolvedValueOnce({ id: JOB_ID, status });
		const res = await delReq();
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ id: JOB_ID, deleted: true });
		expect(jobDeleteMany).toHaveBeenCalledWith({
			where: { id: JOB_ID, status: { in: ["FINISHED", "ERROR"] } },
		});
		expect(auditCreate).toHaveBeenCalledTimes(1);
		const arg = auditCreate.mock.calls[0]?.[0] as {
			data: Record<string, unknown>;
		};
		expect(arg.data).toMatchObject({
			method: "DELETE",
			path: `/api/vmaf-jobs/${JOB_ID}`,
			statusCode: 200,
		});
	});

	it("rolls back and 409s when the report races out of a terminal state (guarded delete hits 0 rows)", async () => {
		// findUnique sees a terminal report, but the atomic deleteMany matches 0
		// rows (the worker re-flipped it to RUNNING between read and write).
		findUnique.mockResolvedValueOnce({ id: JOB_ID, status: "FINISHED" });
		jobDeleteMany.mockResolvedValueOnce({ count: 0 });
		const res = await delReq();
		expect(res.status).toBe(409);
		expect(await res.json()).toMatchObject({
			error: expect.stringMatching(/changed state/i),
		});
		expect(auditCreate).not.toHaveBeenCalled();
	});
});

/**
 * `params.subsample` → `subsample`, asserted from TWO rows for the same reason the
 * scoring-generation assertion needs two: a hardcoded `subsample: null` in the
 * response literal would satisfy a single-row test, and `tsc` accepts it because
 * the field is present. The compiler catches an OMITTED field (verified: dropping
 * it yields `TS2741 Property 'subsample' is missing`); only a test can catch a
 * WRONG one.
 */
describe("GET /api/vmaf-jobs/[id] — the subsample stride", () => {
	function row(over: Record<string, unknown>) {
		return {
			id: JOB_ID,
			encodingJobId: null,
			encodingJob: null,
			mode: "VOD",
			model: "vmaf_v0.6.1",
			scoringVersion: 2,
			status: "FINISHED",
			error: null,
			totalUnits: 1,
			doneUnits: 1,
			cores: 8,
			threads: 4,
			concurrency: 1,
			createdAt: new Date("2026-06-18T00:00:00Z"),
			updatedAt: new Date("2026-06-18T00:00:00Z"),
			results: [],
			...over,
		};
	}

	it("reports the stride a subsampled run recorded", async () => {
		findUnique.mockResolvedValueOnce(row({ params: { subsample: 4 } }));
		const body = await (await GET(req(), params(JOB_ID))).json();
		expect(body.subsample).toBe(4);
	});

	it("reports null for a full-precision run, and for a row from before the field existed", async () => {
		// Both spellings, because `1` is what a `VMAF_SUBSAMPLE=1` run would write and
		// `{}` is every row written before the worker recorded it. Reporting `1` as a
		// stride would make every historical report disagree with every new one.
		findUnique.mockResolvedValueOnce(row({ params: { subsample: 1 } }));
		expect(
			(await (await GET(req(), params(JOB_ID))).json()).subsample,
		).toBeNull();
		findUnique.mockResolvedValueOnce(row({ params: {} }));
		expect(
			(await (await GET(req(), params(JOB_ID))).json()).subsample,
		).toBeNull();
	});

	it("does not trust the shape of a JSON column", async () => {
		// `params` is operator-invisible JSON written by a worker; a string, a float
		// or a negative must not reach the UI as a stride.
		for (const bad of [
			{ subsample: "4" },
			{ subsample: 2.5 },
			{ subsample: -1 },
			null,
		]) {
			findUnique.mockResolvedValueOnce(row({ params: bad }));
			expect(
				(await (await GET(req(), params(JOB_ID))).json()).subsample,
			).toBeNull();
		}
	});
});
