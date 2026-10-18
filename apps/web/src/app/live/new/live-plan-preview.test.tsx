import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderLocalized as renderL } from "@/test/render";
import {
	buildLiveChannelPlan,
	DEFAULT_LIVE_WIZARD_STATE,
	type LiveWizardState,
} from "./build-live-plan";
import {
	evaluateLivePlanDocument,
	evaluateLiveWizardState,
	LivePlanPreview,
} from "./live-plan-preview";

/** Fixture-equivalent state (live-rtmp-simple — 30 compiled ops; streams reference the input directly, no ingest stream). */
const completeState: LiveWizardState = {
	...DEFAULT_LIVE_WIZARD_STATE,
	name: "Live RTMP Channel (live-rtmp-simple)",
	accountId: "00000000-0000-4000-8000-00000000000a",
	inputKind: "RTMP",
	output: {
		publicRead: false,
		credentialId: "00000000-0000-4000-8000-000000000002",
		kind: "S3",
		bucket: "sample-output-bucket",
		basePath: "output/live-rtmp-simple",
		name: "Test S3 Output",
	},
	videos: [
		{
			codec: "H264",
			height: 1080,
			bitrate: 4_500_000,
			presetConfiguration: "LIVE_STANDARD",
		},
		{
			codec: "H264",
			height: 720,
			bitrate: 3_000_000,
			presetConfiguration: "LIVE_STANDARD",
		},
		{
			codec: "H264",
			height: 360,
			bitrate: 800_000,
			presetConfiguration: "LIVE_STANDARD",
		},
	],
	audios: [{ codec: "AAC", bitrate: 128_000, rate: 48_000 }],
	manifests: {
		hls: {
			enabled: true,
			manifestName: "",
			audioGroupId: "",
			audioLanguage: "",
			videoMuxingKind: "",
			audioMuxingKind: "",
			timeshift: 7200,
			liveEdgeOffset: 18,
			insertProgramDateTime: true,
		},
		dash: {
			enabled: true,
			manifestName: "",
			audioLanguage: "",
			representationType: "TEMPLATE",
			timeshift: 7200,
			suggestedPresentationDelay: 12_000,
			minimumUpdatePeriod: 6_000,
			availabilityStartTimeMode: "ON_FIRST_SEGMENT",
		},
	},
	start: {
		streamKey: "myStreamKey",
		liveEncodingMode: "",
		autoRestart: {
			segmentsWrittenTimeout: 60,
			scheduleExpression: "",
			restartOnEncoderError: true,
		},
		autoShutdown: { bytesReadTimeoutSeconds: 3600, streamTimeoutMinutes: 720 },
		reupload: {},
	},
};

describe("evaluateLiveWizardState", () => {
	it("accepts AUTO imports with either provider without changing the document", () => {
		const raw = buildLiveChannelPlan({
			...completeState,
			cloudRegion: "AUTO",
			output: { ...completeState.output, kind: "GENERIC_S3" },
		});
		const before = JSON.stringify(raw);
		for (const provider of ["AKAMAI_OBJECT_STORAGE", "AWS_S3"] as const) {
			const evaluation = evaluateLivePlanDocument(raw, undefined, {
				credentialProviders: new Map([
					[completeState.output.credentialId, provider],
				]),
			});
			if (!evaluation.ok) throw Error("parseable fixture");
			expect(evaluation.issues.some((i) => i.level === "error")).toBe(false);
			expect(evaluation.ops.length > 0).toBe(true);
		}
		expect(JSON.stringify(raw)).toBe(before);
	});
	it("compiles AWS storage and region without deployment restrictions", () => {
		const evaluation = evaluateLiveWizardState(completeState);
		if (!evaluation.ok) throw Error("parseable fixture");
		expect(evaluation.issues.some((i) => i.level === "error")).toBe(false);
		expect(evaluation.ops.length).toBeGreaterThan(0);
	});
	it("explains retained Custom Live before starting an existing plan", () => {
		renderL(
			<LivePlanPreview evaluation={evaluateLiveWizardState(completeState)} />,
		);
		expect(
			screen.getByText("This configuration will use Custom Live."),
		).toBeInTheDocument();
		expect(
			screen.getByText(
				"This saved plan retains its original Custom Live start method.",
			),
		).toBeInTheDocument();
	});
	it("reports incomplete for the empty default state without crashing", () => {
		const evaluation = evaluateLiveWizardState(DEFAULT_LIVE_WIZARD_STATE);
		expect(evaluation.ok).toBe(false);
	});

	it("compiles the fixture-equivalent state to the ledgered 30 operations", () => {
		const evaluation = evaluateLiveWizardState(completeState);
		if (!evaluation.ok) {
			throw new Error("expected a valid plan");
		}
		expect(evaluation.issues).toEqual([]);
		expect(evaluation.ops).toHaveLength(30);
		expect(evaluation.ops[0]?.kind).toBe("CREATE_INPUT_RTMP");
		expect(evaluation.ops.at(-1)?.kind).toBe("AWAIT_LIVE_RUNNING");
	});

	it("surfaces the C8 over-budget error inline and compiles nothing (never clamps)", () => {
		const evaluation = evaluateLiveWizardState({
			...completeState,
			manifests: {
				...completeState.manifests,
				hls: { ...completeState.manifests.hls, timeshift: 400_000 },
			},
		});
		if (!evaluation.ok) {
			throw new Error("expected a parseable plan");
		}
		const c8 = evaluation.issues.filter((i) => i.code === "C8");
		expect(c8.some((i) => i.level === "error")).toBe(true);
		expect(evaluation.ops).toEqual([]);
		renderL(<LivePlanPreview evaluation={evaluation} />);
		expect(screen.getByText("blocked")).toBeInTheDocument();
		expect(screen.getAllByText(/\[C8\]/).length).toBeGreaterThan(0);
	});

	it("warns (not errors) on VOD presets via the LIVE_PRESET_VOD rail", () => {
		const evaluation = evaluateLiveWizardState({
			...completeState,
			videos: [
				{
					codec: "H264",
					height: 720,
					bitrate: 3_000_000,
					presetConfiguration: "VOD_HIGH_QUALITY",
				},
			],
		});
		if (!evaluation.ok) {
			throw new Error("expected a valid plan");
		}
		expect(
			evaluation.issues.some(
				(i) => i.code === "LIVE_PRESET_VOD" && i.level === "warning",
			),
		).toBe(true);
		expect(evaluation.ops.length).toBeGreaterThan(0);
	});

	it("evaluates half-filled state without throwing (zod-safe partials)", () => {
		const evaluation = evaluateLiveWizardState({
			...DEFAULT_LIVE_WIZARD_STATE,
			name: "half",
			inputKind: "SRT",
			srt: {
				...DEFAULT_LIVE_WIZARD_STATE.srt,
				mode: "CALLER",
				host: "",
				callerPort: undefined,
				backups: [
					{
						mode: "CALLER",
						host: "",
						port: undefined,
						credentialId: "",
						keyLength: 128,
					},
				],
			},
			videos: [{ codec: "H265", height: null, bitrate: null }],
			audios: [],
			segmentLength: 0,
			manifests: {
				hls: { ...DEFAULT_LIVE_WIZARD_STATE.manifests.hls, enabled: false },
				dash: { ...DEFAULT_LIVE_WIZARD_STATE.manifests.dash, enabled: false },
			},
			start: { ...DEFAULT_LIVE_WIZARD_STATE.start, streamKey: "" },
		});
		expect(evaluation.ok).toBe(false);
		if (evaluation.ok) {
			throw new Error("expected a zod-incomplete evaluation");
		}
		expect(evaluation.zodMessage.length).toBeGreaterThan(0);
		renderL(<LivePlanPreview evaluation={evaluation} />);
		expect(screen.getByText("incomplete")).toBeInTheDocument();
	});
});

describe("LivePlanPreview", () => {
	it("defaults to the ordered operation list with the op-count badge", () => {
		renderL(
			<LivePlanPreview evaluation={evaluateLiveWizardState(completeState)} />,
		);
		expect(screen.getByText("30 operations")).toBeInTheDocument();
		const ops = screen.getByTestId("live-plan-ops");
		expect(ops.textContent).toContain("live-input:main");
		expect(ops.textContent).toContain("START_LIVE_ENCODING");
	});

	it("switches to the canonical Plan JSON tab (no Template YAML for live)", async () => {
		const { default: userEvent } = await import("@testing-library/user-event");
		const user = userEvent.setup();
		renderL(
			<LivePlanPreview evaluation={evaluateLiveWizardState(completeState)} />,
		);
		expect(
			screen.queryByRole("button", { name: "Template YAML" }),
		).not.toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "Plan JSON" }));
		expect(screen.getByTestId("live-plan-json").textContent).toContain(
			'"name": "Live RTMP Channel (live-rtmp-simple)"',
		);
	});
});
