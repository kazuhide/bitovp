import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compilePlan } from "../plan/compiler";
import { encodingPlanSchema } from "../plan/schema";
import {
	enumerateExistingMp4Targets,
	enumerateFrameIndexQcTargets,
	enumerateQcTargets,
} from "./targets";

/**
 * enumerateQcTargets is the worker's view of the compiler's qc mirror
 * emission. The headline test is the LOCKSTEP one: every distorted path it
 * reports must equal the outputPath+filename the compiler actually emitted
 * for the same plan — if the compiler's mirror path ever changes, this
 * fails instead of the runner silently 404ing on download.
 */

const dir = join(__dirname, "..", "plan", "__fixtures__");

function loadRawPlan(name: string): Record<string, unknown> {
	return JSON.parse(
		readFileSync(join(dir, `${name}.plan.json`), "utf8"),
	) as Record<string, unknown>;
}

describe("enumerateQcTargets", () => {
	it("returns nothing when qc is absent or vmaf is false", () => {
		const raw = loadRawPlan("fixed-bitrate-hls-on-aws");
		expect(enumerateQcTargets(encodingPlanSchema.parse(raw))).toEqual([]);
		expect(
			enumerateQcTargets(
				encodingPlanSchema.parse({ ...raw, qc: { vmaf: false } }),
			),
		).toEqual([]);
	});

	it("emits one target per video rendition with reference + distorted", () => {
		const raw = loadRawPlan("fixed-bitrate-hls-on-aws");
		const plan = encodingPlanSchema.parse({ ...raw, qc: { vmaf: true } });
		const targets = enumerateQcTargets(plan);

		expect(targets).toEqual([
			{
				renditionKey: "v360",
				codec: "H264",
				height: 360,
				bitrate: 300000,
				reference: {
					inputKey: "main",
					inputPath: "sintel/Sintel.2010.1080p.mkv",
				},
				distorted: {
					outputKey: "origin",
					path: "output/h264-aac-fmp4-fixed-bitrate-hls-aws/video/360p/qc/v360.mp4",
				},
			},
			{
				renditionKey: "v540",
				codec: "H264",
				height: 540,
				bitrate: 600000,
				reference: {
					inputKey: "main",
					inputPath: "sintel/Sintel.2010.1080p.mkv",
				},
				distorted: {
					outputKey: "origin",
					path: "output/h264-aac-fmp4-fixed-bitrate-hls-aws/video/540p/qc/v540.mp4",
				},
			},
		]);
	});

	it("stays in lockstep with the compiler's qc mirror outputPath+filename", () => {
		// The contract: for every emitted target, the compiler emitted a
		// CREATE_MUXING_MP4 whose outputPath+filename equals our distorted.path.
		// Two base-resolution branches: muxing-destination (fmp4-ts) and the
		// DRM-output fallback (cenc, where muxings carry no destination).
		for (const name of [
			"pertitle-h264-fmp4-ts-dash-hls-on-aws",
			"cenc-cbc-drm-on-aws",
		]) {
			const raw = loadRawPlan(name);
			const plan = encodingPlanSchema.parse({ ...raw, qc: { vmaf: true } });
			const ops = compilePlan(plan);
			const mirrorByRendition = new Map<string, string>();
			for (const op of ops) {
				if (op.step.startsWith("qc-muxing:")) {
					const key = op.step.slice("qc-muxing:".length);
					mirrorByRendition.set(
						key,
						`${String(op.payload.outputPath)}${String(op.payload.filename)}`,
					);
				}
			}
			const targets = enumerateQcTargets(plan);
			// Same set of renditions, same full object paths.
			expect(targets.map((t) => t.renditionKey).sort()).toEqual(
				[...mirrorByRendition.keys()].sort(),
			);
			for (const t of targets) {
				expect(t.distorted.path).toBe(mirrorByRendition.get(t.renditionKey));
			}
		}
	});

	it("emits nothing for an audio-only plan", () => {
		const raw = loadRawPlan("audio-only-aac-fmp4-hls-dash");
		const plan = encodingPlanSchema.parse({ ...raw, qc: { vmaf: true } });
		expect(enumerateQcTargets(plan)).toEqual([]);
	});

	it("enumerates targets when only psnr is requested (vmaf:false)", () => {
		// Same gate as the compiler mirror: vmaf||psnr. A psnr-only plan still
		// has distorted mirrors to score, so the runner must see the targets.
		const raw = loadRawPlan("fixed-bitrate-hls-on-aws");
		const vmafOnly = enumerateQcTargets(
			encodingPlanSchema.parse({ ...raw, qc: { vmaf: true } }),
		);
		const psnrOnly = enumerateQcTargets(
			encodingPlanSchema.parse({ ...raw, qc: { vmaf: false, psnr: true } }),
		);
		expect(psnrOnly).toEqual(vmafOnly);
		expect(psnrOnly.length).toBeGreaterThan(0);
	});

	it("enumerates the mirror target for a VMAF-only (qc.only) plan", () => {
		// The whole point of qc.only is a cheap VMAF run — the worker must still
		// see the distorted mirror to score. The gate is vmaf||psnr (not only), and
		// the qc mirror op still emits, so a target exists and stays in lockstep.
		const plan = encodingPlanSchema.parse(loadRawPlan("vmaf-only-h264"));
		const targets = enumerateQcTargets(plan);
		expect(targets.map((t) => t.renditionKey)).toEqual(["v540"]);
		const qcMirror = compilePlan(plan).find(
			(op) => op.step === "qc-muxing:v540",
		);
		expect(targets[0]?.distorted.path).toBe(
			`${String(qcMirror?.payload.outputPath)}${String(qcMirror?.payload.filename)}`,
		);
	});
});

describe("enumerateExistingMp4Targets", () => {
	function mp4Plan() {
		const raw = loadRawPlan("fixed-bitrate-hls-on-aws");
		const plan = encodingPlanSchema.parse(raw);
		plan.muxings = plan.muxings
			.filter((m) =>
				plan.renditions.some(
					(r) => r.key === m.streamKey && r.codec === "H264",
				),
			)
			.map((m) => ({
				key: m.key,
				kind: "MP4" as const,
				streamKey: m.streamKey,
				filename: "video.mp4",
				destination: m.destination,
			}));
		return plan;
	}
	it("uses actual output paths without inventing mirrors or changing the plan", () => {
		const plan = mp4Plan(),
			before = JSON.stringify(plan);
		const targets = enumerateExistingMp4Targets(plan);
		expect(targets).toHaveLength(2);
		expect(targets[0]?.distorted.path).toBe(
			"output/h264-aac-fmp4-fixed-bitrate-hls-aws/video/360p/video.mp4",
		);
		expect(JSON.stringify(plan)).toBe(before);
		expect(enumerateQcTargets(plan)).toEqual([]);
	});
	it("rejects partial and ambiguous ladders rather than silently omitting rungs", () => {
		const plan = mp4Plan();
		plan.muxings.pop();
		expect(enumerateExistingMp4Targets(plan)).toEqual([]);
		const duplicate = mp4Plan();
		const first = duplicate.muxings[0];
		if (!first) throw new Error("missing fixture muxing");
		duplicate.muxings.push({ ...first, key: "duplicate" });
		expect(enumerateExistingMp4Targets(duplicate)).toEqual([]);
	});
	it("rejects a transformed source reference and non-first video selection", () => {
		const plan = mp4Plan();
		for (const rendition of plan.renditions) rendition.ingestKey = "trimmed";
		expect(enumerateExistingMp4Targets(plan)).toEqual([]);
		const selected = mp4Plan();
		for (const ingest of selected.ingest) ingest.position = 1;
		expect(enumerateExistingMp4Targets(selected)).toEqual([]);
	});
});

describe("enumerateFrameIndexQcTargets", () => {
	function fullPlan() {
		return encodingPlanSchema.parse({
			...loadRawPlan("pertitle-h264-fmp4-ts-dash-hls-on-aws"),
			qc: { vmaf: true },
		});
	}
	it("preserves every Per-Title QC template including its provider placeholders", () => {
		const plan = fullPlan();
		expect(enumerateFrameIndexQcTargets(plan)).toEqual(
			enumerateQcTargets(plan),
		);
		expect(enumerateFrameIndexQcTargets(plan).length).toBeGreaterThan(0);
	});
	it.each([
		"trim",
		"concat",
		"filter",
		"rendition-filter",
		"second-video",
		"absolute-stream",
		"unresolved-reference",
		"missing-mirror",
		"no-qc",
	])("refuses %s instead of shrinking the comparison population", (scenario) => {
		const plan = fullPlan();
		const video = plan.renditions.find((r) => r.codec === "H264");
		if (!video) throw new Error("fixture has no video rendition");
		const input = plan.ingest.find((i) => i.key === video.ingestKey);
		if (!input) throw new Error("fixture has no video source");
		switch (scenario) {
			case "trim":
				plan.trimmingStreams.push({
					key: "trim",
					kind: "TIME_BASED",
					sourceKey: input.key,
					offset: 1,
				});
				break;
			case "concat":
				plan.concatenationStreams.push({ key: "concat", sources: [] });
				break;
			case "filter":
				plan.filters.push({ key: "crop", kind: "CROP", top: 1 });
				break;
			case "rendition-filter":
				video.filters = [{ filterKey: "crop", position: 0 }];
				break;
			case "second-video":
				input.position = 1;
				break;
			case "absolute-stream":
				input.selectionMode = "POSITION_ABSOLUTE";
				break;
			case "unresolved-reference":
				video.ingestKey = "trim";
				break;
			case "missing-mirror":
				plan.muxings = plan.muxings.filter((m) => m.streamKey !== video.key);
				break;
			case "no-qc":
				delete plan.qc;
				break;
		}
		expect(enumerateFrameIndexQcTargets(plan)).toEqual([]);
	});
});
