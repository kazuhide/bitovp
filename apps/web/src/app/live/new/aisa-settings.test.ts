import {
	buildAisaManagedCreateRequest,
	isAisaManagedLivePlan,
	liveChannelPlanSchema,
} from "@bitovp/core";
import { describe, expect, it } from "vitest";
import {
	aisaWizardProblem,
	clearAisaUnsupportedSettings,
	setAisaLiveEnabled,
} from "./aisa-settings-model";
import {
	buildLiveChannelPlan,
	DEFAULT_LIVE_WIZARD_STATE,
	type LiveWizardState,
} from "./build-live-plan";
import { evaluateLiveWizardState } from "./live-plan-preview";
import { tryImportLiveChannelIntoWizard } from "./live-plan-to-wizard";

const accountId = "00000000-0000-4000-8000-000000000011";
const outputId = "00000000-0000-4000-8000-000000000012";

function state(): LiveWizardState {
	return {
		...structuredClone(DEFAULT_LIVE_WIZARD_STATE),
		name: "Tennis match",
		accountId,
		inputKind: "RTMP",
		start: {
			...structuredClone(DEFAULT_LIVE_WIZARD_STATE.start),
			streamKey: "TennisMatch",
		},
		aisaLive: {
			enabled: true,
			useManagedGraph: true,
			outputId,
			recordingPath: "tennis/recording",
			analysisPath: "tennis/analysis",
			esVersion: "",
			aicaVersion: "",
		},
	};
}

describe("AISA settings in the shared Live wizard", () => {
	it("requires explicit graph acceptance and restores normal settings when disabled", () => {
		const original = state();
		delete original.aisaLive;
		original.videos = original.videos.map((video) => ({
			...video,
			height: 1080,
		}));
		const normal = buildLiveChannelPlan(original);
		const enabled = setAisaLiveEnabled(original, true);
		expect(enabled.videos).toEqual(original.videos);
		expect(enabled.start).toEqual(original.start);
		expect(aisaWizardProblem(enabled)).toBe("aisaLive.managedGraphRequired");
		expect(() => buildLiveChannelPlan(enabled)).toThrow("managedGraphRequired");
		expect(buildLiveChannelPlan(setAisaLiveEnabled(enabled, false))).toEqual(
			normal,
		);
	});

	it("emits only the explicit managed preset and compiles the AISA lifecycle", () => {
		const source = state();
		const before = structuredClone(source);
		const evaluation = evaluateLiveWizardState(source);
		if (!evaluation.ok) throw new Error(evaluation.zodMessage);
		expect(
			evaluation.issues.filter((issue) => issue.level === "error"),
		).toEqual([]);
		expect(evaluation.plan.outputs).toEqual([]);
		expect(evaluation.plan.ingest).toEqual([]);
		expect(evaluation.plan.renditions).toEqual([]);
		expect(evaluation.plan.muxings).toEqual([]);
		expect(evaluation.plan.liveManifests).toEqual([]);
		expect(evaluation.plan.start.aiSceneAnalysisLive).toEqual({
			preset: "AISA_PREVIEW_MANAGED",
			outputId,
			recordingPath: "tennis/recording",
			analysisPath: "tennis/analysis",
		});
		expect(evaluation.ops.map((operation) => operation.kind)).toEqual([
			"CREATE_AISA_LIVE_ANALYSIS",
			"RESOLVE_AISA_LIVE_ENCODING",
			"START_AISA_LIVE_ANALYSIS",
			"AWAIT_LIVE_RUNNING",
		]);
		expect(buildAisaManagedCreateRequest(evaluation.plan)).toMatchObject({
			input: { type: "RTMP", streamKey: "TennisMatch" },
		});
		expect(source).toEqual(before);
	});

	it("blocks configured advanced settings until explicitly cleared", () => {
		const source = state();
		source.start.autoShutdown = { streamTimeoutMinutes: 90 };
		source.fallbackCloudRegions = ["AWS_EU_WEST_1"];
		source.hlsIn.adMarkersSource = "MANIFEST";
		expect(aisaWizardProblem(source)).toBe("aisaLive.unsupportedSettings");
		expect(evaluateLiveWizardState(source)).toMatchObject({
			ok: false,
			zodMessage: "aisaLive.unsupportedSettings",
		});
		expect(source.start.autoShutdown.streamTimeoutMinutes).toBe(90);
		const cleared = clearAisaUnsupportedSettings(source);
		expect(aisaWizardProblem(cleared)).toBeNull();
		expect(cleared.start.streamKey).toBe("TennisMatch");
		expect(cleared.videos).toEqual(source.videos);
		expect(aisaWizardProblem(setAisaLiveEnabled(source, false))).toBeNull();
	});

	it.each([
		"RTMP",
		"HLS",
	] as const)("round-trips imported managed %s plans through the same form", (kind) => {
		const source = state();
		source.inputKind = kind;
		if (kind === "HLS")
			source.hlsIn = {
				name: "Court 1",
				url: "https://example.test/live/index.m3u8",
				adMarkersSource: "",
			};
		if (kind === "HLS") source.start.streamKey = "";
		if (source.aisaLive) {
			source.aisaLive.esVersion = "1.2.3";
			source.aisaLive.aicaVersion = "2.3.4";
		}
		const plan = liveChannelPlanSchema.parse(buildLiveChannelPlan(source));
		expect(isAisaManagedLivePlan(plan)).toBe(true);
		const imported = tryImportLiveChannelIntoWizard(plan);
		if (!imported.ok) throw new Error(imported.reasonKey);
		expect(imported.state.aisaLive?.enabled).toBe(true);
		expect(
			liveChannelPlanSchema.parse(buildLiveChannelPlan(imported.state)),
		).toEqual(plan);
	});
});
