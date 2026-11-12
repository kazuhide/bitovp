import { encodingPlanSchema, validatePlan } from "@bitovp/core";
import { expect, it } from "vitest";
import { buildPlan, DEFAULT_WIZARD_STATE } from "./build-plan";

it.each([
	"MP4",
	"PROGRESSIVE_TS",
] as const)("keeps ordinary %s packaging for an edited input sequence", (kind) => {
	const initial = fixture();
	initial.videos = initial.videos.map((video) => ({
		...video,
		muxing: { kind, filename: "custom-master", muxedAudioKeys: ["a128"] },
	}));
	initial.audios = initial.audios.map((audio) => ({
		...audio,
		muxing: { ownContainer: false },
	}));
	initial.manifests = { hls: false, dash: false };
	const snapshot = structuredClone(initial);
	const ordinary = encodingPlanSchema.parse(buildPlan(initial));
	const plan = encodingPlanSchema.parse(buildPlan(withTimeline(initial)));

	expect(plan.manifests).toEqual([]);
	expect(plan.muxings).toEqual(ordinary.muxings);
	expect(plan.muxings).toHaveLength(initial.videos.length);
	expect(
		plan.muxings.every(
			(muxing) =>
				muxing.kind === kind &&
				(muxing.additionalStreamKeys?.length ?? 0) === initial.audios.length,
		),
	).toBe(true);
	expect(plan.concatenationStreams).toHaveLength(2);
	expect(validatePlan(plan).filter((issue) => issue.level === "error")).toEqual(
		[],
	);
	expect(initial).toEqual(snapshot);
});

it("retains HLS and DASH outputs while compiling the edited A/B/A input graph", () => {
	const initial = fixture();
	initial.manifests = { hls: true, dash: true };
	const ordinary = encodingPlanSchema.parse(buildPlan(initial));
	const plan = encodingPlanSchema.parse(buildPlan(withTimeline(initial)));

	expect(plan.manifests.map((manifest) => manifest.kind)).toEqual([
		"HLS",
		"DASH",
	]);
	expect(plan.manifests).toEqual(ordinary.manifests);
	expect(plan.muxings).toEqual(ordinary.muxings);
	expect(plan.muxings.every((muxing) => muxing.kind === "FMP4")).toBe(true);
	expect(plan.trimmingStreams).toHaveLength(6);
	expect(plan.concatenationStreams).toHaveLength(2);
	for (const concat of plan.concatenationStreams ?? []) {
		expect(concat.sources.map((part) => part.position)).toEqual([0, 1, 2]);
	}
	expect(plan.renditions.map((rendition) => rendition.ingestKey)).toEqual(
		plan.concatenationStreams?.map((concat) => concat.key),
	);
	expect(validatePlan(plan).filter((issue) => issue.level === "error")).toEqual(
		[],
	);
});

function fixture() {
	const state = structuredClone(DEFAULT_WIZARD_STATE);
	state.name = "Edited sequence";
	const first = state.inputFiles[0];
	if (!first) throw new Error("Default wizard must have a primary file");
	first.path = "a.mov";
	first.credentialId = "00000000-0000-4000-8000-000000000001";
	first.bucket = "input";
	state.output.credentialId = first.credentialId;
	state.output.bucket = "output";
	return state;
}

function withTimeline(initial: typeof DEFAULT_WIZARD_STATE) {
	const first = initial.inputFiles[0];
	if (!first) throw new Error("Fixture requires a primary input");
	return {
		...initial,
		inputFiles: [...initial.inputFiles, { ...first, key: "b", path: "b.mov" }],
		inputTimeline: {
			schemaVersion: 1 as const,
			id: "00000000-0000-4000-8000-000000000001",
			audioEnabled: true,
			clips: [first.key, "b", first.key].map((sourceKey, index) => ({
				id: `00000000-0000-4000-8000-00000000000${index + 2}`,
				sourceKey,
				inMs: index * 1000,
				outMs: index * 1000 + 2000,
			})),
		},
	};
}
