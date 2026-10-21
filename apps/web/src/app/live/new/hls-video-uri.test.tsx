import { readFileSync } from "node:fs";
import { join } from "node:path";
import { liveChannelPlanSchema } from "@bitovp/core";
import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderLocalized as render } from "@/test/render";
import { buildLiveChannelPlan } from "./build-live-plan";
import { LiveLadderSection } from "./ladder-section";
import { planToLiveWizardState } from "./live-plan-to-wizard";

function state() {
	const plan = liveChannelPlanSchema.parse(
		JSON.parse(
			readFileSync(
				join(
					__dirname,
					"../../../../../../packages/core/src/live/__fixtures__/live-rtmp-simple.plan.json",
				),
				"utf8",
			),
		),
	);
	const first = plan.renditions[0];
	if (!first) throw new Error("Missing video fixture");
	first.hlsVariantUri = "live-main.m3u8";
	return planToLiveWizardState(plan);
}

describe("Live video playlist URI form", () => {
	it("copies a video with a distinct filename while preserving existing names", () => {
		const value = state();
		const other = value.videos[1];
		if (!other) throw new Error("Missing video fixture");
		other.extras = { ...other.extras, hlsVariantUri: "video-v1.m3u8" };
		const onPatch = vi.fn();
		render(<LiveLadderSection state={value} onPatch={onPatch} />);
		fireEvent.change(screen.getByLabelText("Video settings to reuse"), {
			target: { value: "v1080" },
		});
		fireEvent.click(screen.getByRole("button", { name: /Add video/ }));
		const videos = onPatch.mock.lastCall?.[0].videos;
		expect(videos[0].extras.hlsVariantUri).toBe("live-main.m3u8");
		expect(videos[3].extras.hlsVariantUri).not.toBe("live-main.m3u8");
		expect(videos[3].extras.hlsVariantUri).not.toBe("video-v1.m3u8");
	});
	it("keeps the filename through Live import and rebuilding", () => {
		const rebuilt = liveChannelPlanSchema.parse(buildLiveChannelPlan(state()));
		expect(rebuilt.renditions[0]?.hlsVariantUri).toBe("live-main.m3u8");
	});
	it("keeps copied filenames clear of additional manifest names", () => {
		const value = state();
		value.manifests.additionalHls = [
			{
				...value.manifests.hls,
				key: "alternate",
				manifestName: "video-v1.m3u8",
				destination: { outputKey: "origin", path: "separate-hls" },
			},
		];
		const onPatch = vi.fn();
		render(<LiveLadderSection state={value} onPatch={onPatch} />);
		fireEvent.change(screen.getByLabelText("Video settings to reuse"), {
			target: { value: "v1080" },
		});
		fireEvent.click(screen.getByRole("button", { name: /Add video/ }));
		const videos = onPatch.mock.lastCall?.[0].videos;
		expect(videos[0].extras.hlsVariantUri).toBe("live-main.m3u8");
		expect(videos[3].extras.hlsVariantUri).not.toBe("video-v1.m3u8");
		expect(videos[3].extras.hlsVariantUri).toBe("video-v1-2.m3u8");
	});
	it("edits the URI in the existing video card", () => {
		const onPatch = vi.fn();
		render(<LiveLadderSection state={state()} onPatch={onPatch} />);
		const input = screen.getAllByLabelText("Video playlist URI")[0];
		if (!input) throw new Error("Missing video URI field");
		expect(input).toHaveValue("live-main.m3u8");
		fireEvent.change(input, { target: { value: "live-custom.m3u8" } });
		expect(onPatch.mock.lastCall?.[0].videos[0].extras).toMatchObject({
			key: "v1080",
			hlsVariantUri: "live-custom.m3u8",
		});
	});
	it("preserves the filename when another video field changes", () => {
		const onPatch = vi.fn();
		render(<LiveLadderSection state={state()} onPatch={onPatch} />);
		const input = screen.getAllByLabelText(/Height/)[0];
		if (!input) throw new Error("Missing height field");
		fireEvent.change(input, { target: { value: "900" } });
		expect(onPatch.mock.lastCall?.[0].videos[0].extras).toMatchObject({
			hlsVariantUri: "live-main.m3u8",
		});
	});
});
