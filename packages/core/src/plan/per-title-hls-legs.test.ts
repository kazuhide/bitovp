import { describe, expect, it } from "vitest";
import { compilePlan } from "./compiler";
import { encodingPlanSchema } from "./schema";
import { loadPlan } from "./test-support";
import { validatePlan } from "./validate";

function tsPlan() {
	const raw = loadPlan("pertitle-h264-fmp4-ts-dash-hls-on-aws");
	return encodingPlanSchema.parse({
		...raw,
		muxings: raw.muxings.filter((m) => m.kind === "TS"),
		manifests: raw.manifests
			.filter((m) => m.kind === "HLS")
			.map((m) => ({ ...m, videoMuxingKind: undefined })),
	});
}

function expansions(plan: ReturnType<typeof tsPlan>) {
	return compilePlan(plan).filter(
		(op) => op.kind === "CREATE_HLS_PER_TITLE_VARIANTS",
	);
}

describe("Per-Title HLS selects the plan's actual video leg", () => {
	it("infers TS for an unpinned TS-only plan instead of querying FMP4 after encoding", () => {
		const plan = tsPlan();
		expect(validatePlan(plan).filter((i) => i.level === "error")).toEqual([]);
		expect(expansions(plan)).toEqual([
			expect.objectContaining({
				step: "hls-pertitle:hls",
				payload: expect.objectContaining({
					muxingKind: "TS",
					audio: "audio",
					streamModeFilter: "PER_TITLE_RESULT",
				}),
			}),
		]);
	});
	it("preserves explicit video pins when the same templates have FMP4 and TS legs", () => {
		const raw = loadPlan("pertitle-h264-fmp4-ts-dash-hls-on-aws");
		for (const kind of ["FMP4", "TS"] as const) {
			const plan = encodingPlanSchema.parse({
				...raw,
				manifests: raw.manifests
					.filter((m) => m.kind === "HLS")
					.map((m) => ({ ...m, videoMuxingKind: kind })),
			});
			expect(expansions(plan)).toEqual([
				expect.objectContaining({
					step: "hls-pertitle:hls",
					payload: expect.objectContaining({ muxingKind: kind }),
				}),
			]);
		}
	});
	it("does not infer the expansion kind from a standard video or audio leg", () => {
		const raw = tsPlan();
		const template = raw.renditions.find((r) => r.codec === "H264");
		const muxing = raw.muxings.find((m) => m.streamKey === template?.key);
		if (!template || !muxing) throw new Error("missing fixture template");
		const plan = encodingPlanSchema.parse({
			...raw,
			renditions: [
				...raw.renditions,
				{ ...template, key: "standard", mode: "STANDARD", bitrate: 1000000 },
			],
			muxings: [
				{ ...muxing, key: "standard", streamKey: "standard", kind: "FMP4" },
				...raw.muxings.map((m) =>
					m.streamKey.startsWith("a") ? { ...m, kind: "FMP4" } : m,
				),
			],
		});
		expect(expansions(plan).map((op) => op.payload.muxingKind)).toEqual(["TS"]);
	});
	it("expands each selected kind for different templates without duplicating operation IDs", () => {
		const raw = tsPlan();
		let changed = false;
		const plan = encodingPlanSchema.parse({
			...raw,
			muxings: raw.muxings.map((m) => {
				if (
					changed ||
					!raw.renditions.some(
						(r) =>
							r.key === m.streamKey &&
							"mode" in r &&
							r.mode === "PER_TITLE_TEMPLATE",
					)
				)
					return m;
				changed = true;
				return { ...m, kind: "FMP4", initSegmentName: "init.mp4" };
			}),
		});
		expect(validatePlan(plan).filter((i) => i.level === "error")).toEqual([]);
		const ops = expansions(plan);
		expect(ops.map((op) => op.payload.muxingKind)).toEqual(["FMP4", "TS"]);
		expect(new Set(ops.map((op) => op.step)).size).toBe(2);
	});
});
