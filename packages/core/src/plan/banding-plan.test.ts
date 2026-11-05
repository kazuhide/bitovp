import { describe, expect, it } from "vitest";
import { compileExpectedArtefacts } from "../verify/expected";
import {
	enumerateBandingQcTargets,
	enumerateBandingTargets,
	enumerateExistingBandingMp4Targets,
	enumerateExistingQcMirrorTargets,
	enumerateFrameIndexQcTargets,
	enumerateQcTargets,
	sameQcTargetPopulation,
} from "../vmaf/targets";
import { buildPlan } from "../wizard/build-plan";
import { planToWizardState } from "../wizard/plan-to-wizard";
import { compilePlan } from "./compiler";
import { encodingPlanSchema } from "./schema";
import { validatePlan } from "./validate";

function plan(qc: Record<string, unknown> = { vmaf: false, banding: true }) {
	return encodingPlanSchema.parse({
		planVersion: 1,
		name: "banding",
		bitmovin: {},
		inputs: [{ key: "in", kind: "HTTPS", host: "cdn.example.com" }],
		outputs: [
			{
				key: "out",
				kind: "S3",
				credentialId: "00000000-0000-4000-8000-000000000002",
				bucket: "out",
			},
		],
		ingest: [
			{
				key: "video",
				inputKey: "in",
				inputPath: "source.mp4",
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
				key: "mp4",
				kind: "MP4",
				streamKey: "v",
				filename: "video.mp4",
				destination: { outputKey: "out", path: "video" },
			},
		],
		manifests: [],
		generation: { timing: "POST_ENCODING" },
		qc,
	});
}

describe("no-reference banding plan rails and targets", () => {
	it("reuses banding-generated mirrors for a later reference-based request without enabling automatic VMAF", () => {
		const original = plan();
		const existing = enumerateExistingQcMirrorTargets(original);
		expect(existing).toMatchObject([
			{
				renditionKey: "v",
				reference: { inputKey: "in", inputPath: "source.mp4" },
				distorted: { outputKey: "out", path: "video/qc/v.mp4" },
			},
		]);
		expect(enumerateQcTargets(original)).toEqual([]);
		expect(enumerateFrameIndexQcTargets(original)).toEqual(existing);
		expect(original.qc?.vmaf).toBe(false);
	});

	it("keeps missing references and transformed frame-index sources ineligible", () => {
		const original = plan();
		const rendition = original.renditions[0];
		if (!rendition) throw new Error("fixture");
		rendition.ingestKey = "transformed";
		expect(enumerateExistingQcMirrorTargets(original)).toEqual([]);
		expect(enumerateFrameIndexQcTargets(original)).toEqual([]);
		expect(enumerateBandingTargets(original)).toHaveLength(1);
		expect(enumerateExistingQcMirrorTargets(plan({ vmaf: false }))).toEqual([]);
	});

	it("requires a complete nonempty population of the same rendition output assets", () => {
		const first = enumerateBandingTargets(plan())[0];
		if (!first) throw new Error("fixture");
		const second = {
			...first,
			renditionKey: "v2",
			distorted: { ...first.distorted, path: "video/qc/v2.mp4" },
		};
		expect(sameQcTargetPopulation([first, second], [second, first])).toBe(true);
		for (const incomplete of [
			[],
			[first],
			[first, first],
			[
				first,
				{ ...second, distorted: { ...second.distorted, path: "other.mp4" } },
			],
			[
				first,
				{ ...second, distorted: { ...second.distorted, outputKey: "other" } },
			],
		]) {
			expect(sameQcTargetPopulation([first, second], incomplete)).toBe(false);
		}
		expect(sameQcTargetPopulation([], [])).toBe(false);
	});
	it.each([
		{ vmaf: true },
		{ vmaf: false, psnr: true },
		{ vmaf: true, only: true },
	])("reuses existing %j QC mirrors for a manual Banding request", (qc) => {
		const original = plan(qc);
		expect(enumerateBandingTargets(original)).toMatchObject([
			{
				renditionKey: "v",
				distorted: { outputKey: "out", path: "video/qc/v.mp4" },
			},
		]);
		expect(enumerateBandingTargets(original)[0]).not.toHaveProperty(
			"reference",
		);
		expect(enumerateBandingQcTargets(original)).toEqual([]);
		expect(original.qc).not.toHaveProperty("banding");
	});

	it("does not invent existing mirrors for a plan that never requested QC", () => {
		expect(enumerateBandingTargets(plan({ vmaf: false }))).toEqual([]);
	});
	it("verifies banding-only mirrors and measurement without asserting a VMAF model", () => {
		const parsed = plan({ vmaf: false, banding: true, only: true });
		const expected = compileExpectedArtefacts(parsed);
		expect(expected.qc).toMatchObject({
			vmaf: false,
			psnr: false,
			banding: true,
			mirrorRenditionKeys: ["v"],
		});
		expect(expected.qc).not.toHaveProperty("model");
		expect(expected.qc?.mirrors).toHaveLength(1);
		expect(expected.outputKeys).toContain("out");
	});
	it("compiles exactly the enumerated mirrors without activating reference VMAF", () => {
		const parsed = plan();
		const targets = enumerateBandingQcTargets(parsed);
		const mirrors = compilePlan(parsed).filter((op) =>
			op.step.startsWith("qc-muxing:"),
		);
		expect(targets).toHaveLength(1);
		expect(targets[0]).not.toHaveProperty("reference");
		expect(mirrors).toHaveLength(1);
		expect(targets[0]?.distorted.path).toBe(
			`${mirrors[0]?.payload.outputPath}${mirrors[0]?.payload.filename}`,
		);
		expect(enumerateQcTargets(parsed)).toEqual([]);
	});

	it("does not require a readable reference or an available VMAF model", () => {
		expect(
			validatePlan(plan(), { availableVmafModels: [] }).filter(
				(issue) => issue.level === "error",
			),
		).toEqual([]);
		expect(
			validatePlan(plan({ vmaf: true, banding: true })).map(
				(issue) => issue.code,
			),
		).toContain("PLAN_QC_IO_NOT_READABLE");
	});

	it("requires readable banding output and fails a gated unreadable output before encoding", () => {
		const parsed = plan({
			vmaf: false,
			banding: true,
			gate: {
				onFail: "MARK_ONLY",
				rules: [
					{
						metric: "CAMBI_MAX",
						scope: "PER_RENDITION",
						lte: 5,
						severity: "WARN",
					},
				],
			},
		});
		parsed.outputs = [
			{
				key: "out",
				kind: "SFTP",
				credentialId: "00000000-0000-4000-8000-000000000002",
				name: "SFTP",
			},
		];
		expect(
			validatePlan(parsed).filter(
				(issue) => issue.code === "PLAN_QC_IO_NOT_READABLE",
			),
		).toMatchObject([{ level: "error", path: "qc.banding" }]);
	});

	it("allows banding-only QC-only and a banding gate while rejecting unmeasured metrics", () => {
		const gate = {
			onFail: "MARK_ONLY",
			rules: [{ metric: "CAMBI_MAX", scope: "PER_RENDITION", lte: 5 }],
		};
		expect(
			validatePlan(
				plan({ vmaf: false, banding: true, only: true, gate }),
			).filter((issue) => issue.level === "error"),
		).toEqual([]);
		expect(
			validatePlan(plan({ vmaf: true, gate })).map((issue) => issue.code),
		).toContain("PLAN_QC_GATE_BANDING_OFF");
		const invalid = plan({
			vmaf: false,
			banding: true,
			gate: {
				onFail: "MARK_ONLY",
				rules: [{ metric: "VMAF_MEAN", scope: "PER_RENDITION", gte: 80 }],
			},
		});
		expect(validatePlan(invalid).map((issue) => issue.code)).toContain(
			"PLAN_QC_GATE_WITHOUT_VMAF",
		);
	});

	it("rejects cloud banding even when combined with VMAF", () => {
		for (const vmaf of [false, true]) {
			const parsed = plan({
				vmaf,
				banding: true,
				execution: { backend: "CLOUD", profileId: "cloud", budgetUsd: 1 },
			});
			expect(validatePlan(parsed).map((issue) => issue.code)).toContain(
				"PLAN_QC_BANDING_CLOUD",
			);
		}
	});

	it("measures a single clear encoded MP4 even when the source cannot be resolved", () => {
		const parsed = plan();
		const video = parsed.renditions[0];
		if (!video) throw new Error("fixture");
		video.ingestKey = "transformed";
		expect(enumerateExistingBandingMp4Targets(parsed)).toMatchObject([
			{
				renditionKey: "v",
				distorted: { outputKey: "out", path: "video/video.mp4" },
			},
		]);
		const original = parsed.muxings[0];
		if (!original) throw new Error("fixture");
		parsed.muxings.push({ ...original, key: "ambiguous" });
		expect(enumerateExistingBandingMp4Targets(parsed)).toEqual([]);
	});

	it("round-trips banding-only through the wizard without emitting a VMAF request", () => {
		const parsed = plan({ vmaf: false, banding: true, only: true });
		const state = planToWizardState(
			parsed as unknown as Record<string, unknown>,
		);
		expect(state.qc).toMatchObject({ vmaf: false, banding: true, only: true });
		const rebuilt = encodingPlanSchema.parse(buildPlan(state));
		expect(rebuilt.qc).toMatchObject({
			vmaf: false,
			banding: true,
			only: true,
		});
	});
});
