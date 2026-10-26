import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	CODEC_OPTIONS,
	compileLiveChannel,
	liveChannelPlanSchema,
	validateLiveChannel,
} from "@bitovp/core";
import { fireEvent, screen, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { renderLocalized } from "@/test/render";
import { buildLiveChannelPlan, type LiveWizardState } from "./build-live-plan";
import { LiveLadderSection } from "./ladder-section";
import { evaluateLiveWizardState } from "./live-plan-preview";
import {
	planToLiveWizardState,
	tryImportLiveChannelIntoWizard,
} from "./live-plan-to-wizard";

function stateFor(codec: "H264" | "H265"): LiveWizardState {
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
	const state = planToLiveWizardState(plan);
	return {
		...state,
		videos: state.videos.map((video) => ({
			...video,
			codec,
			h264: undefined,
			h265: undefined,
		})),
	};
}

describe("Live video preset selection", () => {
	it.each([
		"H264",
		"H265",
	] as const)("uses a saved %s Advanced selection in the preview and SDK request", (codec) => {
		const state = stateFor(codec);
		state.videos = state.videos.map((video) => ({
			...video,
			[codec === "H264" ? "h264" : "h265"]: {
				presetConfiguration: "LIVE_HIGH_QUALITY",
				rate: 30,
			},
		}));
		// JSON persistence is the wizard draft's wire representation.
		const restored = JSON.parse(JSON.stringify(state));
		const evaluation = evaluateLiveWizardState(restored);
		expect(evaluation.ok).toBe(true);
		if (!evaluation.ok) throw new Error(evaluation.zodMessage);
		expect(
			evaluation.issues.filter((issue) => issue.level === "error"),
		).toEqual([]);
		const codecs = evaluation.ops.filter(
			(operation) => operation.kind === `CREATE_CODEC_${codec}`,
		);
		expect(codecs).toHaveLength(state.videos.length);
		for (const operation of codecs)
			expect(operation.payload).toMatchObject({
				presetConfiguration: "LIVE_HIGH_QUALITY",
			});
	});

	it.each([
		"H264",
		"H265",
	] as const)("offers one %s preset selector and keeps a selection after import and reload", (codec) => {
		const initial = stateFor(codec);
		const first = initial.videos[0];
		if (!first) throw new Error("Missing video rendition");
		const startingState: LiveWizardState = {
			...initial,
			videos: [
				{
					...first,
					[codec === "H264" ? "h264" : "h265"]: {
						presetConfiguration: "LIVE_HIGH_QUALITY",
						rate: 30,
					},
				},
			],
		};
		let latest = startingState;
		function Harness() {
			const [state, setState] = useState<LiveWizardState>(startingState);
			latest = state;
			return (
				<LiveLadderSection
					state={state}
					onPatch={(partial) =>
						setState((current) => ({ ...current, ...partial }))
					}
				/>
			);
		}
		const { container } = renderLocalized(<Harness />);
		expect(container.querySelectorAll('select[id*="-preset"]')).toHaveLength(1);
		const select = screen.getByLabelText("Preset configuration");
		expect(select).toHaveValue("LIVE_HIGH_QUALITY");
		const options = within(select).getAllByRole(
			"option",
		) as HTMLOptionElement[];
		expect(
			options
				.filter((option) => option.value)
				.map((option) => option.value)
				.sort(),
		).toEqual(
			[
				...CODEC_OPTIONS.PresetConfiguration.filter((value) =>
					value.startsWith("LIVE_"),
				),
				...[
					"VOD_HIGH_QUALITY",
					"VOD_QUALITY",
					"VOD_STANDARD",
					"VOD_SPEED",
					"VOD_HIGH_SPEED",
				].filter((value) => CODEC_OPTIONS.PresetConfiguration.includes(value)),
			].sort(),
		);
		const vodGroup = within(select).getByRole("group", { name: /VOD/ });
		expect(within(vodGroup).getAllByRole("option")).toHaveLength(5);
		fireEvent.change(select, { target: { value: "LIVE_LOW_LATENCY" } });
		expect(select).toHaveValue("LIVE_LOW_LATENCY");
		const restored: LiveWizardState = JSON.parse(JSON.stringify(latest));
		const video = restored.videos[0];
		if (!video) throw new Error("Missing restored video rendition");
		expect(video.presetConfiguration).toBe("LIVE_LOW_LATENCY");
		expect(video.h264?.presetConfiguration).toBeUndefined();
		expect(video.h265?.presetConfiguration).toBeUndefined();
		const plan = liveChannelPlanSchema.parse(buildLiveChannelPlan(restored));
		expect(
			validateLiveChannel(plan).filter((issue) => issue.level === "error"),
		).toEqual([]);
		expect(tryImportLiveChannelIntoWizard(plan).ok).toBe(true);
		const rebuilt = liveChannelPlanSchema.parse(
			buildLiveChannelPlan(planToLiveWizardState(plan)),
		);
		expect(rebuilt).toEqual(plan);
		expect(
			compileLiveChannel(rebuilt).find(
				(operation) => operation.kind === `CREATE_CODEC_${codec}`,
			)?.payload,
		).toMatchObject({ presetConfiguration: "LIVE_LOW_LATENCY" });
		fireEvent.change(select, { target: { value: "VOD_QUALITY" } });
		const vodEvaluation = evaluateLiveWizardState(latest);
		expect(vodEvaluation.ok).toBe(true);
		if (!vodEvaluation.ok) throw new Error(vodEvaluation.zodMessage);
		expect(vodEvaluation.issues).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ code: "LIVE_PRESET_VOD", level: "warning" }),
			]),
		);
		expect(
			vodEvaluation.ops.find(
				(operation) => operation.kind === `CREATE_CODEC_${codec}`,
			)?.payload,
		).toMatchObject({ presetConfiguration: "VOD_QUALITY" });
	});

	it.each([
		["H264", "VOD_STANDARD"],
		["H265", "VOD_STANDARD"],
		["H264", "LIVE_ULTRALOW_LATENCY"],
		["H265", "LIVE_ULTRALOW_LATENCY"],
	] as const)("displays saved %s preset %s without substituting a valid choice", (codec, presetConfiguration) => {
		const state = stateFor(codec);
		const first = state.videos[0];
		if (!first) throw new Error("Missing video rendition");
		state.videos = [{ ...first, presetConfiguration }];
		renderLocalized(<LiveLadderSection state={state} onPatch={() => {}} />);
		const select = screen.getByLabelText("Preset configuration");
		expect(select).toHaveValue(presetConfiguration);
		expect(
			within(select).getByRole("option", { name: presetConfiguration }),
		).toBeInTheDocument();
		const evaluation = evaluateLiveWizardState(state);
		if (presetConfiguration === "VOD_STANDARD") {
			expect(evaluation.ok).toBe(true);
			if (!evaluation.ok) throw new Error(evaluation.zodMessage);
			expect(evaluation.issues).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ code: "LIVE_PRESET_VOD" }),
				]),
			);
		} else {
			expect(evaluation.ok).toBe(false);
		}
	});

	it("preserves an explicit no-preset selection from an older H264 draft", () => {
		const state = stateFor("H264");
		state.videos = state.videos.map((video) => ({
			...video,
			h264: { presetConfiguration: null },
		}));
		const plan = liveChannelPlanSchema.parse(buildLiveChannelPlan(state));
		expect(
			plan.renditions
				.filter((rendition) => rendition.codec === "H264")
				.every((rendition) => rendition.presetConfiguration === null),
		).toBe(true);
		for (const operation of compileLiveChannel(plan).filter(
			(operation) => operation.kind === "CREATE_CODEC_H264",
		))
			expect(operation.payload).not.toHaveProperty("presetConfiguration");
		expect(tryImportLiveChannelIntoWizard(plan).ok).toBe(true);
	});

	it.each([
		{
			codec: "H264",
			explicitNull: false,
			label: "Default (VOD_HIGH_QUALITY)",
		},
		{ codec: "H265", explicitNull: false, label: "Default (API)" },
		{ codec: "H264", explicitNull: true, label: "None (use encoding mode)" },
	] as const)("describes the actual default for $codec with explicitNull=$explicitNull", ({
		codec,
		explicitNull,
		label,
	}) => {
		const state = stateFor(codec);
		const first = state.videos[0];
		if (!first) throw new Error("Missing video rendition");
		state.videos = [
			{
				...first,
				presetConfiguration: undefined,
				h264: explicitNull ? { presetConfiguration: null } : undefined,
				h265: undefined,
			},
		];
		renderLocalized(<LiveLadderSection state={state} onPatch={() => {}} />);
		const select = screen.getByLabelText("Preset configuration");
		expect(select).toHaveValue("");
		expect(within(select).getByRole("option", { name: label })).toHaveValue("");
		const plan = liveChannelPlanSchema.parse(buildLiveChannelPlan(state));
		const operation = compileLiveChannel(plan).find(
			(operation) => operation.kind === `CREATE_CODEC_${codec}`,
		);
		if (!operation) throw new Error("Missing compiled video codec request");
		if (codec === "H264" && !explicitNull)
			expect(operation.payload).toHaveProperty(
				"presetConfiguration",
				"VOD_HIGH_QUALITY",
			);
		else expect(operation.payload).not.toHaveProperty("presetConfiguration");
	});
});
