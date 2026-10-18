import { liveChannelPlanSchema, validateLiveChannel } from "@bitovp/core";
import { expect, it } from "vitest";
import { liveOutputKindForProvider } from "@/app/vod/new/stream-model";
import {
	buildLiveChannelPlan,
	DEFAULT_LIVE_WIZARD_STATE,
} from "./build-live-plan";
import { planToLiveWizardState } from "./live-plan-to-wizard";

it("authors and duplicates Origin delivery without manifests or bucket", () => {
	const state = structuredClone(DEFAULT_LIVE_WIZARD_STATE);
	state.name = "Origin test";
	state.accountId = "00000000-0000-4000-8000-000000000002";
	state.output = {
		...state.output,
		credentialId: "00000000-0000-4000-8000-000000000001",
		kind: "LIVE_MEDIA_INGEST",
		name: "Origin",
		publicRead: false,
		scte35Passthrough: false,
	};
	state.manifests.hls.enabled = false;
	state.manifests.dash.enabled = false;
	const plan = liveChannelPlanSchema.parse(buildLiveChannelPlan(state));
	expect(validateLiveChannel(plan).filter((x) => x.level === "error")).toEqual(
		[],
	);
	const restored = planToLiveWizardState(plan);
	expect(restored).not.toBeNull();
	expect(liveChannelPlanSchema.parse(buildLiveChannelPlan(restored))).toEqual(
		plan,
	);
	expect(liveOutputKindForProvider("LIVE_MEDIA_INGEST")).toBe(
		"LIVE_MEDIA_INGEST",
	);
});

it("duplicates CMAF Origin delivery with its init template and chunk setting", () => {
	const state = structuredClone(DEFAULT_LIVE_WIZARD_STATE);
	state.name = "CMAF Origin";
	state.accountId = "00000000-0000-4000-8000-000000000002";
	state.output = {
		...state.output,
		credentialId: "00000000-0000-4000-8000-000000000001",
		kind: "LIVE_MEDIA_INGEST",
		name: "Origin",
		publicRead: false,
	};
	state.manifests.hls.enabled = false;
	state.manifests.dash.enabled = false;
	for (const row of [...state.videos, ...state.audios]) {
		row.container = "CMAF";
		row.cmaf = {
			initSegmentNameTemplate: "init_%representation_id%.mp4",
			framesPerCmafChunk: 8,
		};
	}
	const plan = liveChannelPlanSchema.parse(buildLiveChannelPlan(state));
	expect(plan.muxings.every((muxing) => muxing.kind === "CMAF")).toBe(true);
	expect(
		validateLiveChannel(plan).filter((issue) => issue.level === "error"),
	).toEqual([]);
	const restored = planToLiveWizardState(plan);
	expect(liveChannelPlanSchema.parse(buildLiveChannelPlan(restored))).toEqual(
		plan,
	);
	expect(restored.videos[0]?.cmaf?.framesPerCmafChunk).toBe(8);
});
