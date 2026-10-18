import {
	compileLiveChannel,
	liveChannelPlanSchema,
	resolveLiveEncodingOption,
} from "@bitovp/core";
import { describe, expect, it } from "vitest";
import {
	buildLiveChannelPlan,
	DEFAULT_LIVE_WIZARD_STATE,
} from "./build-live-plan";
import { planToLiveWizardState } from "./live-plan-to-wizard";

function newPlan() {
	return liveChannelPlanSchema.parse(
		buildLiveChannelPlan({
			...DEFAULT_LIVE_WIZARD_STATE,
			name: "HD roundtrip test",
			accountId: "00000000-0000-4000-8000-000000000001",
			inputKind: "RTMP",
			output: {
				...DEFAULT_LIVE_WIZARD_STATE.output,
				credentialId: "00000000-0000-4000-8000-000000000002",
				bucket: "test-output",
				basePath: "test/hd-roundtrip",
			},
			start: {
				...DEFAULT_LIVE_WIZARD_STATE.start,
				streamKey: "syntheticTestKey",
			},
		}),
	);
}

describe("Live HD wizard roundtrip with the real schema/compiler", () => {
	it("builds and parses a new AUTO 1280x720 at30 plan that compiles HD", () => {
		const plan = newPlan();
		expect(plan.start.encodingOption).toBe("AUTO");
		expect(plan.renditions[0]).toMatchObject({
			codec: "H264",
			width: 1280,
			height: 720,
			rate: 30,
		});
		expect(resolveLiveEncodingOption(plan)).toEqual({
			encodingOption: "HD",
			reasons: [],
		});
		expect(
			compileLiveChannel(plan).find((op) => op.kind === "START_LIVE_ENCODING")
				?.payload.encodingOption,
		).toBe("HD");
	});

	it("never materializes option, width or fps when duplicating a legacy plan", () => {
		const legacy = newPlan();
		delete legacy.start.encodingOption;
		for (const r of legacy.renditions)
			if (r.codec === "H264") {
				delete r.width;
				delete r.rate;
			}
		const rebuilt = liveChannelPlanSchema.parse(
			buildLiveChannelPlan(planToLiveWizardState(legacy)),
		);
		expect(rebuilt).toEqual(legacy);
		expect(rebuilt.start).not.toHaveProperty("encodingOption");
		expect(rebuilt.renditions[0]).not.toHaveProperty("width");
		expect(rebuilt.renditions[0]).not.toHaveProperty("rate");
		expect(resolveLiveEncodingOption(rebuilt)).toEqual({
			encodingOption: "CUSTOM",
			reasons: [{ code: "LEGACY_CUSTOM" }],
		});
	});

	it.each([
		"AUTO",
		"HD",
		"CUSTOM",
	] as const)("preserves explicit %s with width/fps through edit and rebuild", (option) => {
		const plan = newPlan();
		plan.start.encodingOption = option;
		const video = plan.renditions[0];
		if (video?.codec !== "H264") throw new Error("H264 fixture missing");
		video.width = 960;
		video.rate = 25;
		const rebuilt = liveChannelPlanSchema.parse(
			buildLiveChannelPlan(planToLiveWizardState(plan)),
		);
		expect(rebuilt).toEqual(plan);
		expect(rebuilt.renditions[0]).toMatchObject({
			width: 960,
			height: 720,
			rate: 25,
		});
		expect(resolveLiveEncodingOption(rebuilt).encodingOption).toBe(
			option === "CUSTOM" ? "CUSTOM" : "HD",
		);
	});
});
