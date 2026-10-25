import {
	compilePlan,
	encodingPlanSchema,
	type PerTitleGoal,
	validatePlan,
} from "@bitovp/core";
import { describe, expect, it } from "vitest";
import { buildPlan, DEFAULT_WIZARD_STATE } from "./build-plan";
import { autoTunePerTitleGoal } from "./per-title-simulator-auto";
import {
	parsePerTitlePreset,
	serializePerTitlePreset,
} from "./per-title-simulator-preset";
import { tunePerTitleSettings } from "./per-title-simulator-tuning";
import {
	applyPerTitleProposal,
	perTitleGoalFromWizard,
} from "./per-title-simulator-wizard";
import { planToWizardState } from "./plan-to-wizard";

const resolution = "PER_TITLE_TEMPLATE_FIXED_RESOLUTION" as const;
const range = "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE" as const;
function mixed(codec: PerTitleGoal["codec"] = "H264"): PerTitleGoal {
	return {
		strategy: "fixed-ranges",
		codec,
		targetQualityCrf: 17,
		minBitrate: 128_000,
		maxBitrate: 5_000_000,
		minBitrateStepSize: 1.5,
		maxBitrateStepSize: 4,
		countPolicy: { kind: "unrestricted" },
		autoRepresentations: false,
		rows: [
			{ id: "resolution", mode: resolution, height: 320 },
			{
				id: "range",
				mode: range,
				height: 640,
				minBitrate: 1_000_000,
				maxBitrate: 2_000_000,
			},
		],
		automaticTemplates: [
			{ id: "ordinary" },
			{ id: "dimensioned", height: 160 },
		],
	};
}

describe("Per-Title stream-mode persistence", () => {
	it.each([
		"H264",
		"H265",
		"VP9",
	] as const)("applies, compiles and reimports all four %s stream definitions", (codec) => {
		const goal = mixed(codec);
		const { proposal } = tunePerTitleSettings(goal, goal);
		expect(proposal.applicable).toBe(true);
		const state = structuredClone(DEFAULT_WIZARD_STATE);
		state.name = "mixed-stream-modes";
		const input = state.inputFiles[0];
		if (!input) throw new Error("Expected an input file.");
		state.inputFiles[0] = {
			...input,
			credentialId: "00000000-0000-4000-8000-000000000001",
			bucket: "input-bucket",
			path: "clip.mp4",
		};
		state.output = {
			...state.output,
			credentialId: "00000000-0000-4000-8000-000000000002",
			bucket: "output-bucket",
			basePath: "simulation/",
		};
		state.videos = proposal.api.streams.map((stream) => ({
			codec,
			width: stream.width,
			height: stream.height ?? null,
			bitrate: null,
			extras: {
				key: stream.rowId,
				mode: stream.mode,
				...(stream.perTitleSettings
					? { perTitleSettings: stream.perTitleSettings }
					: {}),
			},
			...(codec === "VP9" ? { muxing: { kind: "WEBM" as const } } : {}),
		}));
		if (codec === "VP9") state.manifests = { hls: false, dash: true };
		state.timing = "POST_ENCODING";
		const before = structuredClone(state);
		const applied = applyPerTitleProposal(state, proposal, codec);
		const plan = encodingPlanSchema.parse(buildPlan(applied));
		expect(validatePlan(plan).filter(({ level }) => level === "error")).toEqual(
			[],
		);
		const operations = compilePlan(plan);
		for (const stream of proposal.api.streams) {
			expect(
				operations.find(({ step }) => step === `stream:${stream.rowId}`)
					?.payload.mode,
			).toBe(stream.mode);
		}
		const imported = perTitleGoalFromWizard(planToWizardState(plan), codec);
		const roundtrip = tunePerTitleSettings(imported, imported).proposal;
		expect(roundtrip.api).toEqual(proposal.api);
		expect(imported.targetQualityCrf).toBe(17);
		expect(roundtrip.countGuarantee).toBe(false);
		expect(state).toEqual(before);
	});

	it("round-trips explicit modes and absent dimensions in a requirements file", () => {
		const goal = mixed();
		const imported = parsePerTitlePreset(serializePerTitlePreset(goal), [
			"H264",
		]).goal;
		expect(imported).toEqual(goal);
		expect(tunePerTitleSettings(imported, imported).proposal.api).toEqual(
			tunePerTitleSettings(goal, goal).proposal.api,
		);
	});

	it("imports a reference with both fixed modes without manufacturing inactive bounds", () => {
		const goal = mixed();
		const { api } = tunePerTitleSettings(goal, goal).proposal;
		const imported = parsePerTitlePreset(
			JSON.stringify({
				version: 1,
				reference: {
					codec: goal.codec,
					global: api.global,
					streams: api.streams.map(({ rowId: id, ...stream }) => ({
						id,
						...stream,
					})),
				},
			}),
			["H264"],
		).goal;
		expect(tunePerTitleSettings(imported, imported).proposal.api).toEqual(api);
		expect(imported.rows?.find(({ id }) => id === "resolution")).toMatchObject({
			mode: resolution,
		});
		expect(
			imported.rows?.find(({ id }) => id === "resolution")?.minBitrate,
		).toBeUndefined();
	});

	it("does not allocate bitrate ranges to resolution-only rows during automatic tuning", () => {
		const goal = mixed();
		const tuned = autoTunePerTitleGoal(goal, goal, {});
		expect(tuned.rows?.find(({ id }) => id === "resolution")).toEqual(
			goal.rows?.[0],
		);
	});

	it.each([
		"constraints",
		"proportional",
		"logarithmic",
	] as const)("keeps inactive %s bitrate policies from populating a resolution-only row", (method) => {
		const goal = mixed();
		goal.adjustments = {
			streams: {
				resolution: {
					minBitrate: { mode: "auto", method },
					maxBitrate: { mode: "auto", method },
				},
			},
		};
		const { goal: tuned, proposal } = tunePerTitleSettings(goal, goal);
		expect(
			tuned.rows?.find(({ id }) => id === "resolution")?.minBitrate,
		).toBeUndefined();
		expect(
			tuned.rows?.find(({ id }) => id === "resolution")?.maxBitrate,
		).toBeUndefined();
		expect(
			proposal.api.streams.find(({ rowId }) => rowId === "resolution")
				?.perTitleSettings,
		).toBeUndefined();
	});
});
