import { describe, expect, it } from "vitest";
import {
	buildLiveChannelPlan,
	DEFAULT_LIVE_WIZARD_STATE,
} from "./build-live-plan";

describe("new Live HD defaults", () => {
	it("pins an HD-sized 30fps ladder and automatic start selection without a mode picker", () => {
		const plan = buildLiveChannelPlan(DEFAULT_LIVE_WIZARD_STATE);
		expect(plan.start).toHaveProperty("encodingOption", "AUTO");
		expect(plan.renditions[0]).toMatchObject({
			codec: "H264",
			width: 1280,
			height: 720,
			rate: 30,
		});
	});
});
