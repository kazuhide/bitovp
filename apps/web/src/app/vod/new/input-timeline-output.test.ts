import { encodingPlanSchema } from "@bitovp/core";
import { expect, it } from "vitest";
import { buildPlan, DEFAULT_WIZARD_STATE } from "./build-plan";
import { vodInputTimelineFileOutput } from "./input-timeline-output";

it.each([
	"MP4",
	"PROGRESSIVE_TS",
] as const)("creates %s files with carried audio and no delivery manifests", (kind) => {
	const initial = structuredClone(DEFAULT_WIZARD_STATE);
	initial.name = "timeline";
	const file = initial.inputFiles[0];
	if (!file) throw new Error("Default wizard must have a primary file");
	file.path = "a.mov";
	file.credentialId = "00000000-0000-4000-8000-000000000001";
	initial.output.credentialId = file.credentialId;
	file.bucket = "input";
	initial.output.bucket = "output";
	const snapshot = structuredClone(initial);
	const plan = encodingPlanSchema.parse(
		buildPlan({ ...initial, ...vodInputTimelineFileOutput(initial, kind) }),
	);
	expect(plan.manifests).toEqual([]);
	expect(plan.muxings).toHaveLength(initial.videos.length);
	expect(
		plan.muxings.every(
			(muxing) =>
				muxing.kind === kind &&
				(muxing.additionalStreamKeys?.length ?? 0) === initial.audios.length,
		),
	).toBe(true);
	expect(initial).toEqual(snapshot);
});
