import { VMAF_SCORING_VERSION } from "@bitovp/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cloudProfile } from "@/test/vmaf-cloud-profile";

const findMany = vi.fn();
const computeFindMany = vi.fn();
const profileFindMany = vi.fn(async () => [] as unknown[]);
const jobFindUnique = vi.fn();
const vmafCreate = vi.fn();
const vmafUpdate = vi.fn();
const vmafCount = vi.fn();
const queueAdd = vi.fn();
const activeCount = vi.fn(async () => 0);
const lockedJobFind = vi.fn(async () => ({ status: "FINISHED" }));
const tx = {
	$queryRaw: vi.fn(async () => []),
	encodingJob: { findUnique: lockedJobFind },
	vmafJob: {
		create: vmafCreate,
		count: (args: { where: { status?: unknown } }) =>
			args.where.status ? activeCount() : vmafCount(args),
	},
};

let qcVmafEnabled = true;

vi.mock("@/lib/server/context", () => ({
	getServerContext: () => ({
		prisma: {
			$transaction: (fn: (value: typeof tx) => Promise<unknown>) => fn(tx),
			vmafExecutionProfile: { findMany: profileFindMany },
			vmafComputeTask: { findMany: computeFindMany },
			// : the flag gate reads through the same context. The
			// harness default is ON so every pre-existing case keeps testing
			// what it was written for; the off-case pin flips it.
			appSetting: {
				findUnique: async () => ({ value: { qcVmaf: qcVmafEnabled } }),
			},
			vmafJob: {
				findMany,
				create: vmafCreate,
				update: vmafUpdate,
				count: vmafCount,
			},
			encodingJob: { findUnique: jobFindUnique },
		},
	}),
}));

vi.mock("@/lib/server/queue", () => ({
	getVmafQueue: () => ({ add: queueAdd }),
}));

import { GET, POST } from "./route";

beforeEach(() => {
	qcVmafEnabled = true;
	vi.clearAllMocks();
	profileFindMany.mockResolvedValue([]);
	activeCount.mockResolvedValue(0);
	lockedJobFind.mockResolvedValue({ status: "FINISHED" });
});
afterEach(() => vi.unstubAllEnvs());

describe("GET /api/vmaf-jobs", () => {
	it("exposes current cloud pair progress in the list without private params", async () => {
		const now = new Date("2026-09-25T00:00:00Z");
		findMany.mockResolvedValueOnce([
			{
				id: "job",
				status: "RUNNING",
				params: {
					execution: { backend: "CLOUD", profileId: "test", budgetUsd: 10 },
					secret: "private-value",
				},
				createdAt: now,
				results: [],
			},
		]);
		const task = {
			id: "old",
			vmafJobId: "job",
			targetKey: "pair",
			attempt: 0,
			profileId: "test",
			state: "CLEANED",
			reservedUsd: 1,
			createdAt: now,
			cleanedAt: now,
			error: null,
			progress: null,
		};
		computeFindMany.mockResolvedValueOnce([
			task,
			{
				...task,
				id: "new",
				attempt: 1,
				state: "RUNNING",
				cleanedAt: null,
				progress: {
					version: 1,
					phase: "SCORING",
					updatedAt: now.toISOString(),
					framesProcessed: 4,
					totalFrames: 10,
					provisioningModel: "SPOT",
					signedUrl: "private-value",
				},
			},
		]);
		const response = await GET(new Request("http://localhost/api/vmaf-jobs"));
		const body = await response.json();
		expect(body.items[0].computeTasks).toHaveLength(1);
		expect(body.items[0].computeTasks[0]).toMatchObject({
			id: "new",
			attempt: 2,
			current: true,
			provisioningModel: "SPOT",
			progress: { phase: "SCORING", framesProcessed: 4, totalFrames: 10 },
		});
		expect(JSON.stringify(body)).not.toContain("private-value");
	});

	it("projects a lean list with per-rendition mean VMAF and never selects framesGzip", async () => {
		findMany.mockResolvedValueOnce([
			{
				id: "00000000-0000-4000-8000-0000000000a3",
				encodingJobId: "00000000-0000-4000-8000-0000000000e1",
				encodingJob: { name: "bbb-pte-crf-17" },
				mode: "VOD",
				model: "vmaf_v0.6.1",
				scoringVersion: 2,
				status: "FINISHED",
				error: null,
				createdAt: new Date("2026-06-18T00:00:00Z"),
				results: [
					{ renditionRef: { label: "360p" }, pooled: { mean: 84.2 } },
					{
						renditionRef: { height: 1080, bitrate: 4_500_000 },
						pooled: { mean: 96.1 },
					},
				],
			},
			{
				// A LIVE job has no encodingJob → encodingName resolves to null.
				id: "00000000-0000-4000-8000-0000000000a4",
				encodingJobId: null,
				encodingJob: null,
				mode: "LIVE",
				model: "vmaf_v0.6.1",
				scoringVersion: 1,
				status: "FINISHED",
				error: null,
				createdAt: new Date("2026-06-18T00:00:00Z"),
				results: [],
			},
		]);

		const res = await GET(new Request("http://test/api/vmaf-jobs"));
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.items).toHaveLength(2);
		// the linked encoding's name is surfaced as the report label.
		expect(body.items[0].encodingName).toBe("bbb-pte-crf-17");
		// a LIVE job (no encodingJob) falls back to null.
		expect(body.items[1].encodingName).toBeNull();
		expect(body.items[0].renditionMeans).toEqual([
			{ label: "360p", mean: 84.2 },
			{ label: "1080p · 4500k", mean: 96.1 },
		]);
		/**
		 * The scoring generation must SURVIVE the response, not merely be selected.
		 *
		 * It shipped selected-but-dropped: both routes hand-build a response
		 * literal, the field was optional on the wire type, and `tsc` accepted the
		 * omission in silence. Every component test mocks `apiFetch` and supplies
		 * what the route omitted, so none of them could see it — and the visible
		 * result was worse than the silent chart the field exists to prevent: a
		 * red "gen 1 — understated" badge on every report, including the
		 * freshly-corrected ones. This assertion is the layer that catches it.
		 */
		expect(body.items[0].scoringVersion).toBe(2);
		expect(body.items[1].scoringVersion).toBe(1);

		// the select must not leak the per-frame blob.
		const arg = findMany.mock.calls[0]?.[0] as {
			select: { results: { select: Record<string, boolean> } };
		};
		expect(arg.select.results.select).not.toHaveProperty("framesGzip");
		expect(arg.select.results.select).not.toHaveProperty("frames");
	});

	it("passes an encodingJobId filter through to the where clause", async () => {
		findMany.mockResolvedValueOnce([]);
		await GET(
			new Request(
				"http://test/api/vmaf-jobs?encodingJobId=00000000-0000-4000-8000-0000000000e1",
			),
		);
		const arg = findMany.mock.calls[0]?.[0] as {
			where?: { encodingJobId: string };
		};
		expect(arg.where).toEqual({
			encodingJobId: "00000000-0000-4000-8000-0000000000e1",
		});
	});

	it("400s an invalid cursor", async () => {
		const res = await GET(
			new Request("http://test/api/vmaf-jobs?cursor=not-a-uuid"),
		);
		expect(res.status).toBe(400);
		expect(findMany).not.toHaveBeenCalled();
	});
});

/**
 *  tier 1: measure an EXISTING finished job. The qc-mirror gate
 * sits in front of the create (a mirror-less job is refused with the honest
 * alternative), and the created row's triggerKey carries the lab-manual
 * ordinal so same-model re-measures keep both rows.
 */
describe("POST /api/vmaf-jobs (ledger #122)", () => {
	const JOB = "00000000-0000-4000-8000-0000000000e1";
	const qcPlan = {
		planVersion: 1,
		name: "with-qc",
		bitmovin: {},
		inputs: [
			{
				key: "in",
				kind: "S3",
				credentialId: "00000000-0000-4000-8000-000000000001",
				bucket: "b",
			},
		],
		outputs: [
			{
				key: "out",
				kind: "S3",
				credentialId: "00000000-0000-4000-8000-000000000002",
				bucket: "b",
			},
		],
		ingest: [
			{
				key: "video",
				inputKey: "in",
				inputPath: "a.mp4",
				selectionMode: "VIDEO_RELATIVE",
			},
		],
		renditions: [
			{
				key: "v",
				codec: "H264",
				ingestKey: "video",
				height: 360,
				bitrate: 300000,
			},
		],
		muxings: [
			{
				key: "v",
				kind: "FMP4",
				streamKey: "v",
				destination: { outputKey: "out", path: "x/video" },
			},
		],
		manifests: [],
		generation: { timing: "JUST_IN_TIME" },
		qc: { vmaf: true },
	};

	describe("manual comparison over existing metric-independent QC mirrors", () => {
		beforeEach(() => {
			jobFindUnique.mockReset();
			vmafCount.mockReset().mockResolvedValue(0);
			vmafCreate.mockReset().mockResolvedValue({ id: "report" });
		});
		afterEach(() => {
			jobFindUnique.mockReset();
			vmafCount.mockReset();
			vmafCreate.mockReset();
		});
		function bandingParent(shape: string) {
			return {
				...qcPlan,
				qc: { vmaf: false, banding: true, only: shape === "qc-only" },
				...(shape === "per-title"
					? {
							renditions: [
								{
									...qcPlan.renditions[0],
									mode: "PER_TITLE_TEMPLATE",
									height: null,
									bitrate: null,
								},
							],
							muxings: [
								{
									...qcPlan.muxings[0],
									destination: {
										outputKey: "out",
										path: "x/{height}_{bitrate}_{uuid}",
									},
								},
							],
						}
					: {}),
			};
		}
		it.each(
			["standard", "qc-only", "per-title"].flatMap((shape) => [
				{ shape, banding: false, cloud: false },
				{ shape, banding: false, cloud: true },
				{ shape, banding: true, cloud: false },
				{ shape, banding: true, cloud: true },
			]),
		)("remeasures a $shape Banding-only parent (combined=$banding, cloud=$cloud)", async ({
			shape,
			banding,
			cloud,
		}) => {
			const plan = bandingParent(shape);
			const before = JSON.stringify(plan);
			vi.stubEnv("VMAF_COMPUTE_PROFILES", JSON.stringify([cloudProfile]));
			jobFindUnique.mockResolvedValue({ id: JOB, status: "FINISHED", plan });
			const execution = cloud
				? { backend: "CLOUD", profileId: cloudProfile.id, budgetUsd: 10 }
				: { backend: "LOCAL", localMode: "CPU" };
			const response = await post({
				encodingJobId: JOB,
				model: "vmaf_v0.6.1",
				banding,
				execution,
			});
			if (banding && cloud) {
				expect(response.status).toBe(400);
				expect(jobFindUnique).not.toHaveBeenCalled();
				expect(vmafCreate).not.toHaveBeenCalled();
				expect(queueAdd).not.toHaveBeenCalled();
			} else {
				expect(response.status).toBe(201);
				expect(vmafCreate.mock.calls[0]?.[0].data).toMatchObject({
					model: "vmaf_v0.6.1",
					scoringVersion: VMAF_SCORING_VERSION,
					params: { source: "QC_MIRROR", banding, execution },
				});
				expect(queueAdd).toHaveBeenCalledOnce();
			}
			expect(JSON.stringify(plan)).toBe(before);
		});
		it.each([
			"qc-only",
			"per-title",
		])("accepts full-frame cloud validation of a %s Banding-only parent", async (shape) => {
			const plan = bandingParent(shape);
			const before = JSON.stringify(plan);
			vi.stubEnv("VMAF_COMPUTE_PROFILES", JSON.stringify([cloudProfile]));
			jobFindUnique.mockResolvedValue({ id: JOB, status: "FINISHED", plan });
			const response = await post({
				encodingJobId: JOB,
				source: "QC_MIRROR",
				model: "vmaf_v0.6.1",
				measurementMethod: "FRAME_INDEX_BT709_10BIT",
				execution: {
					backend: "CLOUD",
					profileId: cloudProfile.id,
					budgetUsd: 10,
				},
			});
			expect(response.status).toBe(201);
			expect(vmafCreate.mock.calls[0]?.[0].data).toMatchObject({
				scoringVersion: 6,
				params: {
					source: "QC_MIRROR",
					banding: false,
					measurementMethod: "FRAME_INDEX_BT709_10BIT",
				},
			});
			expect(JSON.stringify(plan)).toBe(before);
		});
		it.each([
			{ label: "missing reference", changes: { ingest: [] } },
			{
				label: "unreadable reference",
				changes: {
					inputs: [{ key: "in", kind: "HTTPS", host: "source.example.com" }],
				},
			},
			{
				label: "unreadable encoded output",
				changes: {
					outputs: [
						{
							key: "out",
							kind: "SFTP",
							credentialId: "00000000-0000-4000-8000-000000000002",
						},
					],
				},
			},
		])("rejects $label before creating any VMAF measurement", async ({
			label,
			changes,
		}) => {
			const plan = { ...qcPlan, ...changes };
			jobFindUnique.mockResolvedValue({ id: JOB, status: "FINISHED", plan });
			const response = await post({
				encodingJobId: JOB,
				source: "QC_MIRROR",
				model: "vmaf_v0.6.1",
			});
			expect(response.status).toBe(409);
			expect((await response.json()).error).toMatch(
				label === "missing reference" ? /no usable QC mirror/ : /readable/,
			);
			expect(vmafCreate).not.toHaveBeenCalled();
			expect(queueAdd).not.toHaveBeenCalled();
		});
		it("rejects a combined measurement when only part of its output population has references", async () => {
			const plan = {
				...qcPlan,
				qc: { vmaf: true, banding: true },
				renditions: [
					...qcPlan.renditions,
					{ ...qcPlan.renditions[0], key: "unreferenced", ingestKey: "trim" },
				],
				trimmingStreams: [
					{ key: "trim", kind: "TIME_BASED", sourceKey: "video", offset: 1 },
				],
				muxings: [
					...qcPlan.muxings,
					{
						...qcPlan.muxings[0],
						key: "unreferenced",
						streamKey: "unreferenced",
						destination: { outputKey: "out", path: "x/unreferenced" },
					},
				],
			};
			jobFindUnique.mockResolvedValue({ id: JOB, status: "FINISHED", plan });
			const response = await post({
				encodingJobId: JOB,
				source: "QC_MIRROR",
				model: "vmaf_v0.6.1",
				banding: true,
			});
			expect(response.status).toBe(409);
			expect((await response.json()).error).toMatch(
				/same.*population|reference/,
			);
			expect(vmafCreate).not.toHaveBeenCalled();
			expect(queueAdd).not.toHaveBeenCalled();
		});
		it("does not require a readable reference for Banding-only measurement", async () => {
			const plan = {
				...bandingParent("qc-only"),
				inputs: [{ key: "in", kind: "HTTPS", host: "source.example.com" }],
			};
			jobFindUnique.mockResolvedValue({ id: JOB, status: "FINISHED", plan });
			expect((await post({ encodingJobId: JOB, kind: "BANDING" })).status).toBe(
				201,
			);
			expect(queueAdd).toHaveBeenCalledOnce();
		});
		it("defaults to VMAF-only over a Banding-only parent's existing mirror", async () => {
			jobFindUnique.mockResolvedValue({
				id: JOB,
				status: "FINISHED",
				plan: bandingParent("qc-only"),
			});
			expect(
				(await post({ encodingJobId: JOB, model: "vmaf_v0.6.1" })).status,
			).toBe(201);
			expect(vmafCreate.mock.calls[0]?.[0].data.params).toMatchObject({
				source: "QC_MIRROR",
				banding: false,
			});
		});
		it("rejects unreadable members of a mixed reference population rather than dropping them", async () => {
			const plan = {
				...qcPlan,
				inputs: [
					...qcPlan.inputs,
					{ key: "unreadable", kind: "HTTPS", host: "source.example.com" },
				],
				ingest: [
					...qcPlan.ingest,
					{ ...qcPlan.ingest[0], key: "other", inputKey: "unreadable" },
				],
				renditions: [
					...qcPlan.renditions,
					{ ...qcPlan.renditions[0], key: "other", ingestKey: "other" },
				],
				muxings: [
					...qcPlan.muxings,
					{
						...qcPlan.muxings[0],
						key: "other",
						streamKey: "other",
						destination: { outputKey: "out", path: "x/other" },
					},
				],
			};
			jobFindUnique.mockResolvedValue({ id: JOB, status: "FINISHED", plan });
			const response = await post({
				encodingJobId: JOB,
				source: "QC_MIRROR",
				model: "vmaf_v0.6.1",
			});
			expect(response.status).toBe(409);
			expect((await response.json()).error).toMatch(/readable.*reference/);
			expect(vmafCreate).not.toHaveBeenCalled();
			expect(queueAdd).not.toHaveBeenCalled();
		});
		it("still rejects transformed Banding-only mirrors for full-source frame-index validation", async () => {
			vi.stubEnv("VMAF_COMPUTE_PROFILES", JSON.stringify([cloudProfile]));
			const plan = {
				...bandingParent("qc-only"),
				trimmingStreams: [
					{ key: "trim", kind: "TIME_BASED", sourceKey: "video", offset: 1 },
				],
			};
			jobFindUnique.mockResolvedValue({ id: JOB, status: "FINISHED", plan });
			const response = await post({
				encodingJobId: JOB,
				source: "QC_MIRROR",
				model: "vmaf_v0.6.1",
				measurementMethod: "FRAME_INDEX_BT709_10BIT",
				execution: {
					backend: "CLOUD",
					profileId: cloudProfile.id,
					budgetUsd: 10,
				},
			});
			expect(response.status).toBe(409);
			expect(vmafCreate).not.toHaveBeenCalled();
			expect(queueAdd).not.toHaveBeenCalled();
		});
		it("requires readable encoded output even for Banding-only measurement", async () => {
			const plan = {
				...bandingParent("qc-only"),
				outputs: [
					{
						key: "out",
						kind: "SFTP",
						credentialId: "00000000-0000-4000-8000-000000000002",
					},
				],
			};
			jobFindUnique.mockResolvedValue({ id: JOB, status: "FINISHED", plan });
			expect((await post({ encodingJobId: JOB, kind: "BANDING" })).status).toBe(
				409,
			);
			expect(vmafCreate).not.toHaveBeenCalled();
			expect(queueAdd).not.toHaveBeenCalled();
		});
	});

	it("creates target-only CAMBI measurement without a reference or model", async () => {
		const plan = {
			...qcPlan,
			qc: undefined,
			trimmingStreams: [
				{ key: "trim", kind: "TIME_BASED", sourceKey: "video", offset: 1 },
			],
			renditions: [{ ...qcPlan.renditions[0], ingestKey: "trim" }],
			muxings: [{ ...qcPlan.muxings[0], kind: "MP4", filename: "video.mp4" }],
		};
		jobFindUnique.mockResolvedValueOnce({ id: JOB, status: "FINISHED", plan });
		vmafCount.mockResolvedValueOnce(0);
		vmafCreate.mockResolvedValueOnce({ id: "report" });
		const response = await post({
			encodingJobId: JOB,
			kind: "BANDING",
			execution: { backend: "LOCAL", localMode: "AUTO" },
		});
		expect(response.status).toBe(201);
		expect(vmafCreate.mock.calls[0]?.[0].data).toMatchObject({
			model: "CAMBI",
			scoringVersion: 11,
			params: {
				kind: "BANDING",
				banding: true,
				source: "OUTPUT_MP4",
				execution: { backend: "LOCAL", localMode: "AUTO" },
			},
		});
		expect(await response.json()).toMatchObject({
			kind: "BANDING",
			detector: "CAMBI",
			model: null,
		});
		expect(queueAdd).toHaveBeenCalledOnce();
	});

	it.each([
		{ label: "historical VMAF", qc: { vmaf: true }, perTitle: false },
		{
			label: "historical PSNR",
			qc: { vmaf: false, psnr: true },
			perTitle: false,
		},
		{
			label: "historical QC-only",
			qc: { vmaf: true, only: true },
			perTitle: false,
		},
		{ label: "historical Per-Title", qc: { vmaf: true }, perTitle: true },
	])("measures CAMBI from a $label mirror without changing the original plan", async ({
		qc,
		perTitle,
	}) => {
		const plan = {
			...qcPlan,
			qc,
			// QC-only retains the base coordinates used for its QC mirrors;
			// the compiler omits delivery output creation when qc.only is set.
			...(perTitle
				? {
						renditions: [
							{
								...qcPlan.renditions[0],
								mode: "PER_TITLE_TEMPLATE",
								height: null,
								bitrate: null,
							},
						],
						muxings: [
							{
								...qcPlan.muxings[0],
								destination: {
									outputKey: "out",
									path: "x/{height}_{bitrate}_{uuid}",
								},
							},
						],
					}
				: {}),
		};
		const before = JSON.stringify(plan);
		jobFindUnique.mockResolvedValueOnce({ id: JOB, status: "FINISHED", plan });
		vmafCount.mockResolvedValueOnce(0);
		vmafCreate.mockResolvedValueOnce({ id: "report" });
		const response = await post({
			encodingJobId: JOB,
			kind: "BANDING",
			source: "QC_MIRROR",
			execution: { backend: "LOCAL", localMode: "CPU" },
		});
		expect(response.status).toBe(201);
		expect(vmafCreate.mock.calls[0]?.[0].data).toMatchObject({
			model: "CAMBI",
			scoringVersion: 11,
			params: { kind: "BANDING", source: "QC_MIRROR" },
		});
		expect(JSON.stringify(plan)).toBe(before);
		expect(queueAdd).toHaveBeenCalledOnce();
	});

	it.each([
		{ backend: "LOCAL", explicitOff: false },
		{ backend: "LOCAL", explicitOff: true },
		{ backend: "CLOUD", explicitOff: false },
		{ backend: "CLOUD", explicitOff: true },
	] as const)("persists VMAF-only intent over a combined parent ($backend, explicit off=$explicitOff)", async ({
		backend,
		explicitOff,
	}) => {
		const plan = { ...qcPlan, qc: { vmaf: true, psnr: true, banding: true } };
		const before = JSON.stringify(plan);
		vi.stubEnv("VMAF_COMPUTE_PROFILES", JSON.stringify([cloudProfile]));
		jobFindUnique.mockResolvedValueOnce({ id: JOB, status: "FINISHED", plan });
		vmafCount.mockResolvedValueOnce(0);
		vmafCreate.mockResolvedValueOnce({ id: "report" });
		const execution =
			backend === "CLOUD"
				? { backend, profileId: cloudProfile.id, budgetUsd: 10 }
				: { backend, localMode: "CPU" };
		const response = await post({
			encodingJobId: JOB,
			model: "vmaf_v0.6.1",
			execution,
			...(explicitOff ? { banding: false } : {}),
		});
		expect(response.status).toBe(201);
		expect(vmafCreate.mock.calls[0]?.[0].data.params).toMatchObject({
			banding: false,
			execution,
			source: "QC_MIRROR",
		});
		expect(vmafCreate.mock.calls[0]?.[0].data.params).not.toHaveProperty(
			"kind",
		);
		expect(JSON.stringify(plan)).toBe(before);
		expect(queueAdd).toHaveBeenCalledOnce();
	});

	it.each([
		{ model: "CAMBI" },
		{ model: "../private-model" },
		{ kind: "BANDING", model: "vmaf_v0.6.1" },
		{ kind: "BANDING", psnr: true },
		{ kind: "BANDING", measurementMethod: "FRAME_INDEX_BT709_10BIT" },
		{
			kind: "BANDING",
			execution: { backend: "CLOUD", profileId: "cloud", budgetUsd: 10 },
		},
		{
			banding: true,
			execution: { backend: "CLOUD", profileId: "cloud", budgetUsd: 10 },
		},
	])("explicitly rejects incompatible Banding request before creating anything: %j", async (options) => {
		const response = await post({ encodingJobId: JOB, ...options });
		expect(response.status).toBe(400);
		expect(jobFindUnique).not.toHaveBeenCalled();
		expect(vmafCreate).not.toHaveBeenCalled();
		expect(queueAdd).not.toHaveBeenCalled();
	});

	it("keeps the VMAF model and generation for one combined measurement", async () => {
		jobFindUnique.mockResolvedValueOnce({
			id: JOB,
			status: "FINISHED",
			plan: qcPlan,
		});
		vmafCount.mockResolvedValueOnce(0);
		vmafCreate.mockResolvedValueOnce({ id: "report" });
		const response = await post({
			encodingJobId: JOB,
			banding: true,
			model: "vmaf_v0.6.1",
		});
		expect(response.status).toBe(201);
		expect(vmafCreate.mock.calls[0]?.[0].data).toMatchObject({
			model: "vmaf_v0.6.1",
			scoringVersion: VMAF_SCORING_VERSION,
			params: { banding: true },
		});
	});

	it("measures existing MP4 outputs without changing a mirror-less encoding plan", async () => {
		const plan = {
			...qcPlan,
			qc: undefined,
			muxings: [{ ...qcPlan.muxings[0], kind: "MP4", filename: "video.mp4" }],
		};
		const before = JSON.stringify(plan);
		vi.stubEnv("VMAF_COMPUTE_PROFILES", JSON.stringify([cloudProfile]));
		jobFindUnique.mockResolvedValueOnce({ id: JOB, status: "FINISHED", plan });
		vmafCount.mockResolvedValueOnce(0);
		vmafCreate.mockResolvedValueOnce({ id: "report" });
		const response = await post({
			encodingJobId: JOB,
			psnr: true,
			measurementMethod: "FRAME_INDEX_BT709_10BIT",
			execution: {
				backend: "CLOUD",
				profileId: cloudProfile.id,
				budgetUsd: 10,
			},
		});
		expect(response.status).toBe(201);
		expect(vmafCreate.mock.calls[0]?.[0].data).toMatchObject({
			scoringVersion: 6,
			params: {
				source: "OUTPUT_MP4",
				psnr: true,
				measurementMethod: "FRAME_INDEX_BT709_10BIT",
			},
		});
		expect(JSON.stringify(plan)).toBe(before);
		expect(queueAdd).toHaveBeenCalledTimes(1);
	});

	it("queues full-frame generation6 for a Per-Title QC mirror without changing its plan", async () => {
		const plan = {
			...qcPlan,
			renditions: [
				{
					...qcPlan.renditions[0],
					mode: "PER_TITLE_TEMPLATE",
					height: null,
					bitrate: null,
				},
			],
			muxings: [
				{
					...qcPlan.muxings[0],
					destination: {
						outputKey: "out",
						path: "x/{height}_{bitrate}_{uuid}",
					},
				},
			],
		};
		const before = JSON.stringify(plan);
		vi.stubEnv("VMAF_COMPUTE_PROFILES", JSON.stringify([cloudProfile]));
		jobFindUnique.mockResolvedValueOnce({ id: JOB, status: "FINISHED", plan });
		vmafCount.mockResolvedValueOnce(0);
		vmafCreate.mockResolvedValueOnce({ id: "report" });
		const response = await post({
			encodingJobId: JOB,
			source: "QC_MIRROR",
			model: "vmaf_v1.0.16_3d0h",
			measurementMethod: "FRAME_INDEX_BT709_10BIT",
			execution: {
				backend: "CLOUD",
				profileId: cloudProfile.id,
				budgetUsd: 10,
			},
		});
		expect(response.status).toBe(201);
		expect(vmafCreate.mock.calls[0]?.[0].data).toMatchObject({
			scoringVersion: 6,
			params: {
				source: "QC_MIRROR",
				measurementMethod: "FRAME_INDEX_BT709_10BIT",
			},
		});
		expect(JSON.stringify(plan)).toBe(before);
		expect(queueAdd).toHaveBeenCalledTimes(1);
	});

	it("refuses a trimmed QC mirror before any generation6 report is created", async () => {
		vi.stubEnv("VMAF_COMPUTE_PROFILES", JSON.stringify([cloudProfile]));
		jobFindUnique.mockResolvedValueOnce({
			id: JOB,
			status: "FINISHED",
			plan: {
				...qcPlan,
				trimmingStreams: [
					{ key: "trim", kind: "TIME_BASED", sourceKey: "video", offset: 1 },
				],
			},
		});
		const response = await post({
			encodingJobId: JOB,
			source: "QC_MIRROR",
			measurementMethod: "FRAME_INDEX_BT709_10BIT",
			execution: {
				backend: "CLOUD",
				profileId: cloudProfile.id,
				budgetUsd: 10,
			},
		});
		expect(response.status).toBe(409);
		expect(vmafCreate).not.toHaveBeenCalled();
		expect(queueAdd).not.toHaveBeenCalled();
	});

	it("rejects the frame-index method locally before creating a job", async () => {
		const result = await post({
			encodingJobId: JOB,
			source: "OUTPUT_MP4",
			measurementMethod: "FRAME_INDEX_BT709_10BIT",
		});
		expect(result.status).toBe(400);
		expect(jobFindUnique).not.toHaveBeenCalled();
		expect(vmafCreate).not.toHaveBeenCalled();
	});
	function post(body: unknown) {
		return POST(
			new Request("http://test/api/vmaf-jobs", {
				method: "POST",
				body: JSON.stringify(body),
			}),
		);
	}

	it.each([
		{ backend: "CLOUD", profileId: "approved" },
		{ backend: "CLOUD", profileId: "approved", budgetUsd: 0 },
		{ backend: "CLOUD", profileId: "approved", budgetUsd: -1 },
		{ backend: "CLOUD", profileId: "approved", budgetUsd: "10" },
		{ backend: "LOCAL", profileId: "approved", budgetUsd: 10 },
		{ backend: "LOCAL", localMode: "CUDA" },
		{ backend: "LOCAL", localMode: "AUTO", nativePath: "/private/native" },
		{
			backend: "CLOUD",
			profileId: "approved",
			budgetUsd: 10,
			localMode: "AUTO",
		},
	])("rejects invalid execution before any job read: %j", async (execution) => {
		expect((await post({ encodingJobId: JOB, execution })).status).toBe(400);
		expect(jobFindUnique).not.toHaveBeenCalled();
		expect(vmafCreate).not.toHaveBeenCalled();
		expect(queueAdd).not.toHaveBeenCalled();
	});
	it.each([
		"CPU",
		"AUTO",
	] as const)("persists the requested local %s mode and model", async (localMode) => {
		jobFindUnique.mockResolvedValueOnce({
			id: JOB,
			status: "FINISHED",
			plan: qcPlan,
		});
		vmafCount.mockResolvedValueOnce(0);
		vmafCreate.mockResolvedValueOnce({ id: "vmaf-new" });
		const execution = { backend: "LOCAL", localMode };
		const response = await post({
			encodingJobId: JOB,
			execution,
			model: "vmaf_v1.0.16_3d0h",
		});
		expect(response.status).toBe(201);
		expect(vmafCreate.mock.calls[0]?.[0].data).toMatchObject({
			model: "vmaf_v1.0.16_3d0h",
			params: { execution },
		});
		expect(queueAdd).toHaveBeenCalledOnce();
	});

	it("rejects an unconfigured cloud profile before creating a job", async () => {
		vi.stubEnv("VMAF_COMPUTE_PROFILES", "[]");
		expect(
			(
				await post({
					encodingJobId: JOB,
					execution: { backend: "CLOUD", profileId: "unknown", budgetUsd: 10 },
				})
			).status,
		).toBe(400);
		expect(vmafCreate).not.toHaveBeenCalled();
		expect(queueAdd).not.toHaveBeenCalled();
	});

	it("fails cloud configuration closed without exposing its contents", async () => {
		vi.stubEnv("VMAF_COMPUTE_PROFILES", "secret-invalid-config");
		const response = await post({
			encodingJobId: JOB,
			execution: { backend: "CLOUD", profileId: "approved", budgetUsd: 10 },
		});
		expect(response.status).toBe(503);
		expect(await response.text()).not.toContain("secret-invalid-config");
		expect(vmafCreate).not.toHaveBeenCalled();
	});

	it("creates + enqueues for a FINISHED job whose plan asked for qc", async () => {
		vi.stubEnv("VMAF_COMPUTE_PROFILES", "malformed-but-local-does-not-need-it");
		jobFindUnique.mockResolvedValueOnce({
			id: JOB,
			status: "FINISHED",
			plan: qcPlan,
		});
		vmafCount.mockResolvedValueOnce(1);
		vmafCreate.mockResolvedValueOnce({ id: "vmaf-new" });
		const res = await post({ encodingJobId: JOB, model: "vmaf_v0.6.1" });
		expect(res.status).toBe(201);
		const data = vmafCreate.mock.calls[0]?.[0]?.data;
		expect(data).toMatchObject({
			encodingJobId: JOB,
			mode: "VOD",
			model: "vmaf_v0.6.1",
			triggerKey: `lab-manual:${JOB}:vmaf_v0.6.1:2`,
			params: { execution: { backend: "LOCAL" } },
		});
		expect(queueAdd).toHaveBeenCalledWith(
			"vmaf",
			{ vmafJobId: "vmaf-new" },
			expect.objectContaining({ jobId: "vmaf-new" }),
		);
	});

	it("persists only an allowlisted cloud request with its explicit budget", async () => {
		vi.stubEnv("VMAF_COMPUTE_PROFILES", JSON.stringify([cloudProfile]));
		jobFindUnique.mockResolvedValueOnce({
			id: JOB,
			status: "FINISHED",
			plan: qcPlan,
		});
		vmafCount.mockResolvedValueOnce(0);
		vmafCreate.mockResolvedValueOnce({ id: "vmaf-cloud" });
		const execution = {
			backend: "CLOUD",
			profileId: cloudProfile.id,
			budgetUsd: 12,
		};
		expect((await post({ encodingJobId: JOB, execution })).status).toBe(201);
		expect(vmafCreate.mock.calls[0]?.[0]?.data.params).toEqual({
			banding: false,
			execution,
			executionProfile: cloudProfile,
			source: "QC_MIRROR",
		});
		expect(queueAdd).toHaveBeenCalledTimes(1);
	});

	it("pins the selected DB profile version so later edits cannot move queued work", async () => {
		vi.stubEnv("VMAF_COMPUTE_PROFILES", "[]");
		profileFindMany.mockResolvedValue([
			{
				id: cloudProfile.id,
				label: cloudProfile.label,
				config: cloudProfile,
				version: 7,
				enabled: true,
			},
		]);
		jobFindUnique.mockResolvedValueOnce({
			id: JOB,
			status: "FINISHED",
			plan: qcPlan,
		});
		vmafCount.mockResolvedValueOnce(0);
		vmafCreate.mockResolvedValueOnce({ id: "snapshot" });
		expect(
			(
				await post({
					encodingJobId: JOB,
					execution: {
						backend: "CLOUD",
						profileId: cloudProfile.id,
						budgetUsd: 12,
					},
				})
			).status,
		).toBe(201);
		expect(vmafCreate.mock.calls[0]?.[0]?.data.params.executionProfile).toEqual(
			{ ...cloudProfile, profileVersion: 7 },
		);
	});

	it("refuses a mirror-less job with the honest alternative — and never creates", async () => {
		jobFindUnique.mockResolvedValueOnce({
			id: JOB,
			status: "FINISHED",
			plan: { ...qcPlan, qc: undefined },
		});
		const res = await post({ encodingJobId: JOB });
		expect(res.status).toBe(409);
		expect((await res.json()).error).toMatch(/no usable QC mirror/);
		expect(vmafCreate).not.toHaveBeenCalled();
		expect(queueAdd).not.toHaveBeenCalled();
	});

	it("refuses a measurement already running without enqueueing again", async () => {
		jobFindUnique.mockResolvedValueOnce({
			id: JOB,
			status: "FINISHED",
			plan: qcPlan,
		});
		activeCount.mockResolvedValueOnce(1);
		expect((await post({ encodingJobId: JOB })).status).toBe(409);
		expect(vmafCreate).not.toHaveBeenCalled();
		expect(queueAdd).not.toHaveBeenCalled();
	});

	it("refuses a non-FINISHED job", async () => {
		jobFindUnique.mockResolvedValueOnce({
			id: JOB,
			status: "RUNNING",
			plan: qcPlan,
		});
		const res = await post({ encodingJobId: JOB });
		expect(res.status).toBe(409);
		expect(vmafCreate).not.toHaveBeenCalled();
	});
});
