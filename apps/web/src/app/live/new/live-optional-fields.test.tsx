import { readFileSync } from "node:fs";
import { join } from "node:path";
import { compileLiveChannel, liveChannelPlanSchema } from "@bitovp/core";
import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderWithQuery } from "@/test/render";
import { buildLiveChannelPlan, type LiveWizardState } from "./build-live-plan";
import { InputSection } from "./input-section";
import {
	planToLiveWizardState,
	tryImportLiveChannelIntoWizard,
} from "./live-plan-to-wizard";
import { LiveManifestsSection } from "./manifests-section";

function fixtureState(): LiveWizardState {
	return planToLiveWizardState(
		liveChannelPlanSchema.parse(
			JSON.parse(
				readFileSync(
					join(
						__dirname,
						"../../../../../../packages/core/src/live/__fixtures__/live-srt-caller.plan.json",
					),
					"utf8",
				),
			),
		),
	);
}

describe("Live optional input and manifest fields", () => {
	it.each([
		"H264",
		"H265",
	] as const)("duplicates %s codec tuning including false, zero and nullable values", (codec) => {
		const state = fixtureState();
		state.videos = [
			{
				codec,
				height: 720,
				bitrate: 3_000_000,
				presetConfiguration: "LIVE_STANDARD",
				...(codec === "H264"
					? {
							h264: {
								profile: "HIGH",
								level: "4.1",
								rate: 25,
								bframes: 0,
								cabac: false,
								adaptiveQuantizationStrength: 0,
								weightedPredictionPFrames: "DISABLED",
							},
						}
					: {
							h265: {
								profile: "MAIN10",
								level: "4.1",
								rate: null,
								subMe: 0,
								sao: false,
								hdr: false,
								levelHighTier: false,
								maxBitrate: 4_000_000,
								dynamicRangeFormat: "SDR",
							},
						}),
			},
		];
		const plan = liveChannelPlanSchema.parse(buildLiveChannelPlan(state));
		expect(plan.renditions[0]).toMatchObject({ level: "4.1" });
		const imported = tryImportLiveChannelIntoWizard(plan);
		expect(imported.ok).toBe(true);
		if (!imported.ok) throw new Error("Expected editable codec tuning");
		expect(
			liveChannelPlanSchema.parse(buildLiveChannelPlan(imported.state)),
		).toEqual(plan);
		expect(
			imported.state.videos[0]?.[codec === "H264" ? "h264" : "h265"],
		).toMatchObject(
			state.videos[0]?.[codec === "H264" ? "h264" : "h265"] ?? {},
		);
	});

	it("edits a backup SRT path, compiles it and preserves it on duplicate", () => {
		const state = fixtureState();
		state.srt.backups = [
			{
				mode: "CALLER",
				host: "backup.example",
				port: 9000,
				credentialId: "",
				keyLength: 256,
			},
		];
		const onPatch = vi.fn();
		renderWithQuery(
			<InputSection state={state} credentials={[]} onPatch={onPatch} />,
		);
		fireEvent.change(screen.getByLabelText("Backup 1 Path"), {
			target: { value: "backup-stream" },
		});
		const edited = { ...state, ...onPatch.mock.calls[0]?.[0] };
		const plan = liveChannelPlanSchema.parse(buildLiveChannelPlan(edited));
		expect(
			compileLiveChannel(plan).find((op) => op.kind === "CREATE_INPUT_SRT")
				?.payload,
		).toMatchObject({
			backupSrtInputs: { srtInputs: [{ path: "backup-stream" }] },
		});
		const imported = tryImportLiveChannelIntoWizard(plan);
		expect(imported.ok).toBe(true);
		if (imported.ok) {
			const backup = imported.state.srt.backups[0];
			expect(backup?.path).toBe("backup-stream");
			if (!backup) throw new Error("Expected the imported backup input");
			backup.path = "";
			const cleared = buildLiveChannelPlan(imported.state);
			if (cleared.liveInput.kind === "SRT") {
				expect(cleared.liveInput.backup?.srtInputs[0]).not.toHaveProperty(
					"path",
				);
			}
		}
	});

	it("edits HLS closed captions, compiles it and preserves it on duplicate", () => {
		const state = fixtureState();
		const onPatch = vi.fn();
		renderWithQuery(<LiveManifestsSection state={state} onPatch={onPatch} />);
		fireEvent.change(screen.getByLabelText("Closed captions"), {
			target: { value: "captions" },
		});
		const edited = { ...state, ...onPatch.mock.calls[0]?.[0] };
		const plan = liveChannelPlanSchema.parse(buildLiveChannelPlan(edited));
		expect(
			compileLiveChannel(plan).some(
				(op) => op.payload.closedCaptions === "captions",
			),
		).toBe(true);
		const imported = tryImportLiveChannelIntoWizard(plan);
		expect(imported.ok).toBe(true);
		if (imported.ok) {
			expect(imported.state.manifests.hls.closedCaptions).toBe("captions");
			imported.state.manifests.hls.closedCaptions = "";
			const cleared = liveChannelPlanSchema.parse(
				buildLiveChannelPlan(imported.state),
			);
			expect(cleared.liveManifests.find((m) => m.kind === "HLS")).toMatchObject(
				{ closedCaptions: "NONE" },
			);
		}
	});
});
