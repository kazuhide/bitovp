import { describe, expect, it, vi } from "vitest";
import { compilePlan } from "./compiler";
import { INTERNAL_HEVC_V2_BCF_VERSION } from "./internal-hevc-v2";
import { type EncodingPlan, encodingPlanSchema } from "./schema";
import { submitEncodingJob } from "./submit";
import { loadPlan } from "./test-support";
import { validatePlan } from "./validate";

const ACCOUNT = "00000000-0000-4000-8000-0000000000aa";
const CODE = "PLAN_INTERNAL_HEVC_V2_MULTIPLE_MUXINGS";
const ladder = [
	[1920, 1080, 2_000_000],
	[1280, 720, 1_000_000],
	[960, 540, 600_000],
	[640, 360, 300_000],
] as const;

function nativePlan(qc?: Record<string, unknown>): EncodingPlan {
	const base = loadPlan("fixed-bitrate-hls-on-aws");
	return encodingPlanSchema.parse({
		...base,
		bitmovin: { ...base.bitmovin, accountId: ACCOUNT, encoderVersion: "BETA" },
		internal: { hevcV2: { bcfVersion: INTERNAL_HEVC_V2_BCF_VERSION } },
		renditions: ladder.map(([width, height, bitrate]) => ({
			key: `v${height}`,
			codec: "H265",
			ingestKey: "video",
			mode: "STANDARD",
			width,
			height,
			bitrate,
			rate: 24,
			pixelFormat: "YUV420P",
		})),
		muxings: ladder.map(([, height]) => ({
			key: `v${height}`,
			kind: "FMP4",
			streamKey: `v${height}`,
			segmentLength: 4,
			destination: { outputKey: "origin", path: `comparison/video/${height}/` },
		})),
		manifests: [],
		qc,
	});
}

function conflicts(plan: EncodingPlan) {
	return validatePlan(plan).filter((issue) => issue.code === CODE);
}

describe("native HEVCv2 SMART_PASS emitted muxing limit", () => {
	it.each([
		{ vmaf: true },
		{ vmaf: false, psnr: true },
		{ vmaf: false, banding: true },
	])("refuses a generated QC MP4 plus delivery per stream: %j", (qc) => {
		const plan = nativePlan(qc);
		const muxings = compilePlan(plan).filter((op) =>
			op.kind.startsWith("CREATE_MUXING_"),
		);
		expect(muxings).toHaveLength(8);
		for (const rendition of plan.renditions)
			expect(
				muxings.filter((op) => op.refs.streamId === `stream:${rendition.key}`),
			).toHaveLength(2);
		expect(conflicts(plan)).toHaveLength(4);
		expect(conflicts(plan)[0]).toMatchObject({
			level: "error",
			path: "renditions.0",
			message: expect.stringMatching(/SMART_PASS.*QC.*qc\.only/s),
		});
	});

	it("blocks the failing QC shape at submission before job creation or enqueue", async () => {
		const createJob = vi.fn(async () => ({ id: "must-not-exist" }));
		const enqueue = vi.fn(async () => {});
		const result = await submitEncodingJob(
			nativePlan({ vmaf: false, banding: true }),
			{
				validationOptions: {},
				internalHevcV2AccountId: ACCOUNT,
				loadAccountDefaults: async () => ({ defaults: {} }),
				recordEgress: vi.fn(async () => {}),
				createJob,
				enqueue,
				markEnqueueFailed: vi.fn(async () => {}),
			},
		);
		expect(result).toMatchObject({ ok: false, code: "VALIDATION" });
		expect(createJob).not.toHaveBeenCalled();
		expect(enqueue).not.toHaveBeenCalled();
	});

	it("accepts four QC-only MP4s, even with several unused destination hints", () => {
		const plan = nativePlan({ vmaf: false, banding: true, only: true });
		const muxing = plan.muxings[0];
		if (!muxing) throw new Error("Missing muxing fixture");
		plan.muxings.push({ ...muxing, key: "unused-delivery-hint" });
		expect(
			validatePlan(plan).filter((issue) => issue.level === "error"),
		).toEqual([]);
		const muxings = compilePlan(plan).filter((op) =>
			op.kind.startsWith("CREATE_MUXING_"),
		);
		expect(muxings).toHaveLength(4);
		expect(muxings.every((op) => op.kind === "CREATE_MUXING_MP4")).toBe(true);
	});

	it("refuses two explicit delivery muxings without QC", () => {
		const plan = nativePlan();
		const muxing = plan.muxings[0];
		if (!muxing) throw new Error("Missing muxing fixture");
		plan.muxings.push({ ...muxing, key: "second-delivery" });
		expect(conflicts(plan)).toHaveLength(1);
	});

	it("counts a delivery MP4 separately from the generated QC MP4", () => {
		const plan = nativePlan({ vmaf: true });
		plan.muxings = plan.muxings.map((muxing) => ({
			key: muxing.key,
			kind: "MP4",
			streamKey: muxing.streamKey,
			filename: `${muxing.key}.mp4`,
			destination: muxing.destination,
		}));
		expect(conflicts(plan)).toHaveLength(4);
	});

	it("keeps one delivery muxing per stream valid without automatic QC", () => {
		expect(
			validatePlan(nativePlan()).filter((issue) => issue.level === "error"),
		).toEqual([]);
	});

	it("does not count storage mirrors as additional muxing resources", () => {
		const plan = nativePlan();
		const output = plan.outputs[0];
		if (!output) throw new Error("Missing output fixture");
		plan.outputs.push({ ...output, key: "replica" });
		plan.deliveryMirrors = [{ outputKey: "replica" }];
		expect(conflicts(plan)).toEqual([]);
	});

	it("leaves ordinary HEVCv1 delivery plus QC unchanged", () => {
		const plan = nativePlan({ vmaf: true });
		delete plan.internal;
		expect(conflicts(plan)).toEqual([]);
	});

	it("does not add a duplicate muxing error to an already unsupported native profile", () => {
		const plan = nativePlan({ vmaf: true });
		const rendition = plan.renditions[0];
		if (rendition?.codec !== "H265") throw new Error("Missing video fixture");
		rendition.encodingMode = "TWO_PASS";
		expect(
			validatePlan(plan).some(
				(issue) => issue.code === "PLAN_INTERNAL_HEVC_V2_UNSUPPORTED",
			),
		).toBe(true);
		expect(conflicts(plan)).toEqual([]);
	});

	it("retains the existing invalid Per-Title bitrate error without adding muxing noise", () => {
		const plan = nativePlan({ vmaf: true });
		const rendition = plan.renditions[0];
		if (rendition?.codec !== "H265") throw new Error("Missing video fixture");
		rendition.mode = "PER_TITLE_TEMPLATE";
		expect(
			validatePlan(plan).some(
				(issue) => issue.code === "PLAN_PER_TITLE_BITRATE",
			),
		).toBe(true);
		expect(conflicts(plan)).toEqual([]);
	});
});
