import { readFileSync } from "node:fs";
import { join } from "node:path";
import { liveChannelPlanSchema } from "@bitovp/core";
import { fireEvent, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { renderLocalized } from "@/test/render";
import {
	buildLiveChannelPlan,
	DEFAULT_LIVE_WIZARD_STATE,
} from "./build-live-plan";
import { LiveLadderSection } from "./ladder-section";
import {
	planToLiveWizardState,
	tryImportLiveChannelIntoWizard,
} from "./live-plan-to-wizard";

it.each([
	"H264",
	"H265",
] as const)("exposes supported %s Live controls and leaves CRF to VOD", (codec) => {
	const onPatch = vi.fn();
	const video = DEFAULT_LIVE_WIZARD_STATE.videos[0];
	if (!video) throw new Error("Missing video");
	const { container } = renderLocalized(
		<LiveLadderSection
			state={{ ...DEFAULT_LIVE_WIZARD_STATE, videos: [{ ...video, codec }] }}
			onPatch={onPatch}
		/>,
		"en",
	);
	expect(
		screen.queryByLabelText("Constant rate factor (0–51)"),
	).not.toBeInTheDocument();
	expect(
		screen.getByLabelText("Maximum GOP length (frames)"),
	).toBeInTheDocument();
	expect(container.querySelector("#lw-v-0-width")).not.toBeNull();
	fireEvent.change(screen.getByLabelText("Min bitrate (bps)"), {
		target: { value: "0" },
	});
	expect(
		onPatch.mock.calls.at(-1)?.[0].videos[0][
			codec === "H264" ? "h264" : "h265"
		],
	).toMatchObject({ minBitrate: 0 });
});

it.each([
	"H264",
	"H265",
] as const)("round-trips stored %s Live controls without changing the output paths", (codec) => {
	const raw = JSON.parse(
		readFileSync(
			join(
				__dirname,
				"../../../../../../packages/core/src/live/__fixtures__/live-rtmp-simple.plan.json",
			),
			"utf8",
		),
	);
	const controls = {
		width: 640,
		minBitrate: 0,
		maxBitrate: 6000000,
		bufsize: 12000000,
		minGop: 0,
		maxGop: 48,
		openGop: false,
		displayAspectRatio: { numerator: 16, denominator: 9 },
		...(codec === "H265"
			? { bframes: 0, refFrames: 0, qpMax: 69, strictCbr: false }
			: {}),
	};
	raw.renditions = raw.renditions.map(
		(r: {
			codec: string;
			key: string;
			ingestKey: string;
			height: number;
			bitrate: number;
			rate: number;
			name: string;
		}) =>
			r.codec === "H264"
				? {
						key: r.key,
						ingestKey: r.ingestKey,
						codec,
						height: r.height,
						bitrate: r.bitrate,
						rate: r.rate,
						name: r.name,
						presetConfiguration: "LIVE_STANDARD",
						...controls,
					}
				: r,
	);
	const plan = liveChannelPlanSchema.parse(raw);
	expect(tryImportLiveChannelIntoWizard(plan).ok).toBe(true);
	const state = planToLiveWizardState(plan);
	expect(liveChannelPlanSchema.parse(buildLiveChannelPlan(state))).toEqual(
		plan,
	);
});
