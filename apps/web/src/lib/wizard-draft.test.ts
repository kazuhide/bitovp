import { beforeEach, expect, it, vi } from "vitest";
import {
	buildLiveChannelPlan,
	DEFAULT_LIVE_WIZARD_STATE,
} from "@/app/live/new/build-live-plan";
import {
	buildPlan,
	DEFAULT_WIZARD_STATE,
	type WizardState,
} from "@/app/vod/new/build-plan";
import {
	addVodVideo,
	updateVodVideoHeight,
} from "@/app/vod/new/rendition-copy";
import {
	draftIdentity,
	draftKey,
	mergeWizardDraft,
	projectWizardDraft,
	readWizardDraft,
	WIZARD_DRAFT_MAX_SIZE,
	WIZARD_DRAFT_TTL,
	writeWizardDraft,
} from "./wizard-draft";

beforeEach(() => localStorage.clear());
it.each([
	{ backend: "CLOUD", profileId: "gcp-qc", budgetUsd: 12 },
	{ backend: "CLOUD", profileId: "gcp-qc", budgetUsd: 0 },
	{ backend: "LOCAL" },
])("preserves VOD VMAF execution and excludes provider secrets in drafts", (execution) => {
	const state = {
		...DEFAULT_WIZARD_STATE,
		qc: {
			vmaf: true,
			psnr: false,
			model: "vmaf_v0.6.1",
			execution: { ...execution, executionProfile: { secret: "do-not-save" } },
		},
	};
	writeWizardDraft("vmaf-execution", "vod", state, 2);
	const draft = readWizardDraft("vmaf-execution", "vod");
	if (!draft) throw new Error("Missing saved draft");
	const restored = mergeWizardDraft(DEFAULT_WIZARD_STATE, draft.value, "vod");
	expect(restored.qc).toHaveProperty("execution", execution);
	expect(JSON.stringify(draft.value)).not.toContain("do-not-save");
	const cleared = mergeWizardDraft(
		restored,
		projectWizardDraft("vod", DEFAULT_WIZARD_STATE),
		"vod",
	);
	expect(cleared.qc).toBeUndefined();
});
it.each([
	"h264",
	"h265",
	"vp9",
	"av1",
] as const)("restores and clears the %s Per-Title minimum bitrate ratio in browser drafts", (codec) => {
	const state: WizardState = {
		...structuredClone(DEFAULT_WIZARD_STATE),
		startOptions: {
			perTitle: {
				[codec]: { minBitrateStepSize: 1.5, maxBitrateStepSize: 4 },
			},
		},
	};
	writeWizardDraft("ratio", "vod", state, 2);
	const draft = readWizardDraft("ratio", "vod");
	if (!draft) throw new Error("Missing saved draft");
	const restored = mergeWizardDraft(
		structuredClone(DEFAULT_WIZARD_STATE),
		draft.value,
		"vod",
	);
	expect(restored.startOptions?.perTitle?.[codec]).toEqual({
		minBitrateStepSize: 1.5,
		maxBitrateStepSize: 4,
	});
	expect(buildPlan(restored).perTitle?.[`${codec}Configuration`]).toEqual({
		minBitrateStepSize: 1.5,
		maxBitrateStepSize: 4,
	});
	const cleared = {
		...state,
		startOptions: { perTitle: { [codec]: { maxBitrateStepSize: 4 } } },
	};
	const afterClear = mergeWizardDraft(
		state,
		projectWizardDraft("vod", cleared),
		"vod",
	);
	expect(afterClear.startOptions?.perTitle?.[codec]).toEqual({
		maxBitrateStepSize: 4,
	});
	expect(buildPlan(afterClear).perTitle?.[`${codec}Configuration`]).toEqual({
		maxBitrateStepSize: 4,
	});
});

it("restores automatic copy ownership through the real draft projection and merge", () => {
	for (const height of [1080, null]) {
		const base: WizardState = {
			...structuredClone(DEFAULT_WIZARD_STATE),
			videos: [
				{
					height: 1080,
					bitrate: 4_000_000,
					extraMuxings: [{ kind: "TS", key: "alternate" }],
				},
			],
		};
		const copied = { ...base, ...addVodVideo(base, 0) };
		const state = { ...copied, ...updateVodVideoHeight(copied, 1, height) };
		writeWizardDraft("height-key", "vod", state, 2);
		const draft = readWizardDraft("height-key", "vod");
		if (!draft) throw new Error("Missing saved draft");
		const restored = mergeWizardDraft(
			structuredClone(DEFAULT_WIZARD_STATE),
			draft.value,
			"vod",
		);
		expect(restored.videos[1]?.autoKey).toBe(
			height === null ? "video2" : "v1080-2",
		);
		expect(restored.videos[1]?.muxing).toMatchObject({
			autoPath: restored.videos[1]?.muxing?.path,
		});
		expect(restored.videos[1]?.extraMuxings?.[0]).toMatchObject({
			autoPath: restored.videos[1]?.extraMuxings?.[0]?.path,
		});
		const edited = { ...restored, ...updateVodVideoHeight(restored, 1, 900) };
		expect(edited.videos[1]?.extras?.key).toBe("v900");
		expect(edited.videos[1]?.muxing?.key).toBe("v900");
		expect(
			buildPlan(edited).muxings.find((row) => row.key === "v900")?.destination
				?.path,
		).toBe("video/v900");
		expect(edited.videos[1]?.extraMuxings?.[0]?.path).toBe("video/v900/ts-2");
		expect(JSON.stringify(buildPlan(edited))).not.toContain("autoKey");
		expect(JSON.stringify(buildPlan(edited))).not.toContain("autoPath");
	}
});

it("separates confirmed users, organizations, kinds and creation revisions", () => {
	const session = {
		mode: "users",
		configured: true,
		authenticated: true,
		loginKind: "password-form",
		effectiveUserId: "user-a",
		organizationId: "org-a",
		role: "OPERATOR",
	} as const;
	expect(draftIdentity(session)).toEqual(["org-a", "user-a"]);
	for (const partial of [
		{ authenticated: false },
		{ isImpersonating: true },
		{ effectiveUserId: undefined },
		{ organizationId: undefined },
		{ role: "VIEWER" },
	])
		expect(
			draftIdentity({ ...session, ...partial } as typeof session),
		).toBeNull();
	const keys = [
		draftKey(["org-a", "user-a"], "vod", "new"),
		draftKey(["org-b", "user-a"], "vod", "new"),
		draftKey(["org-a", "user-b"], "vod", "new"),
		draftKey(["org-a", "user-a"], "live", "new"),
		draftKey(["org-a", "user-a"], "vod", "edit:a:revisionA"),
		draftKey(["org-a", "user-a"], "vod", "edit:a:revisionB"),
	];
	expect(new Set(keys).size).toBe(keys.length);
});
it("stores a typed partial form and step, expiring it after seven days", () => {
	writeWizardDraft(
		"draft",
		"vod",
		{ ...DEFAULT_WIZARD_STATE, name: "unfinished" },
		3,
		localStorage,
		100,
	);
	expect(readWizardDraft("draft", "vod", localStorage, 101)).toMatchObject({
		step: 3,
		value: { name: "unfinished" },
	});
	expect(
		readWizardDraft("draft", "vod", localStorage, 100 + WIZARD_DRAFT_TTL),
	).toBeNull();
	expect(localStorage.getItem("draft")).toBeNull();
});
it("never persists nested secrets, auth URLs or arbitrary imported/options JSON", () => {
	const value = {
		...DEFAULT_LIVE_WIZARD_STATE,
		password: "SECRET_PASSWORD",
		raw: { key: "SECRET_RAW" },
		start: {
			...DEFAULT_LIVE_WIZARD_STATE.start,
			streamKey: "SECRET_STREAM",
			esam: {
				poisEndpoint: "https://u:SECRET_AUTH@host/path?token=SECRET_TOKEN",
			},
		},
		hlsIn: {
			...DEFAULT_LIVE_WIZARD_STATE.hlsIn,
			url: "https://host/file?token=SECRET_URL",
		},
		redundantRtmp: {
			...DEFAULT_LIVE_WIZARD_STATE.redundantRtmp,
			ingestPoints: [{ applicationName: "live", streamKey: "SECRET_POINT" }],
		},
		srt: {
			...DEFAULT_LIVE_WIZARD_STATE.srt,
			credentialId: "ref",
			passphrase: "SECRET_SRT",
		},
		videos: [
			{
				...DEFAULT_LIVE_WIZARD_STATE.videos[0],
				jsonOptions: { key: "SECRET_JSON" },
			},
		],
	};
	writeWizardDraft("draft", "live", value, 2);
	expect(localStorage.getItem("draft")).not.toMatch(
		/SECRET|"streamKey"|poisEndpoint|jsonOptions|"url"/,
	);
	expect(projectWizardDraft("live", value)).toMatchObject({
		srt: { credentialId: "ref" },
	});
	writeWizardDraft(
		"vod",
		"vod",
		{
			...DEFAULT_WIZARD_STATE,
			drm: [{ key: "SECRET_DRM" }],
			inputFiles: [
				{
					...DEFAULT_WIZARD_STATE.inputFiles[0],
					bucket: "u:SECRET@host",
					path: "/file?token=SECRET",
				},
			],
		},
		0,
	);
	expect(localStorage.getItem("vod")).not.toContain("SECRET");
});
it("rejects invalid versions, oversized records and handles unavailable storage", () => {
	localStorage.setItem("draft", JSON.stringify({ version: 99 }));
	expect(readWizardDraft("draft", "vod")).toBeNull();
	localStorage.setItem("draft", "x".repeat(WIZARD_DRAFT_MAX_SIZE + 1));
	expect(readWizardDraft("draft", "vod")).toBeNull();
	const broken = {
		getItem: vi.fn(() => {
			throw new Error("denied");
		}),
		setItem: vi.fn(() => {
			throw new Error("quota");
		}),
		removeItem: vi.fn(),
	};
	expect(() =>
		writeWizardDraft("draft", "vod", DEFAULT_WIZARD_STATE, 0, broken),
	).not.toThrow();
	expect(readWizardDraft("draft", "vod", broken)).toBeNull();
});
it("preserves numeric codec settings and explicit per-title nulls", () => {
	const state = {
		...DEFAULT_WIZARD_STATE,
		videos: [
			{
				...DEFAULT_WIZARD_STATE.videos[0],
				h264: { presetConfiguration: null, subMe: "FULL" },
				h265: { subMe: 3 },
			},
		],
	};
	writeWizardDraft("codec", "vod", state, 2);
	expect(readWizardDraft("codec", "vod")?.value.videos).toMatchObject([
		{ h264: { presetConfiguration: null, subMe: "FULL" }, h265: { subMe: 3 } },
	]);
});
it("clears optional safe leaves from copied state while retaining required fields and excluded secrets", () => {
	const source = {
		...DEFAULT_LIVE_WIZARD_STATE,
		start: {
			...DEFAULT_LIVE_WIZARD_STATE.start,
			streamKey: "fresh-secret",
			autoRestart: {
				...DEFAULT_LIVE_WIZARD_STATE.start.autoRestart,
				segmentsWrittenTimeout: 30,
			},
			autoShutdown: { streamTimeoutMinutes: 5 },
			reupload: { dashManifestInterval: 60 },
		},
		manifests: {
			...DEFAULT_LIVE_WIZARD_STATE.manifests,
			hls: { ...DEFAULT_LIVE_WIZARD_STATE.manifests.hls, timeshift: 30 },
		},
	};
	const saved = projectWizardDraft("live", {
		...source,
		start: {
			...source.start,
			autoRestart: DEFAULT_LIVE_WIZARD_STATE.start.autoRestart,
			autoShutdown: {},
			reupload: {},
		},
		manifests: DEFAULT_LIVE_WIZARD_STATE.manifests,
	});
	const restored = mergeWizardDraft(
		source,
		JSON.parse(JSON.stringify(saved)),
		"live",
	);
	expect(restored.start.autoShutdown).toEqual({});
	expect(restored.start.reupload).toEqual({});
	expect(restored.start.autoRestart).toEqual(
		DEFAULT_LIVE_WIZARD_STATE.start.autoRestart,
	);
	expect(restored.manifests.hls.timeshift).toBeUndefined();
	expect(restored.start.streamKey).toBe("fresh-secret");
	expect(restored.output).toEqual(source.output);
});
it("persists ad marker carrier options, including false, and clears copied overrides", () => {
	const adMarkerOptions = {
		hlsMarkerTypes: ["EXT_X_CUE_OUT_IN", "EXT_X_SCTE35"],
		hlsDisablePreannouncing: false,
		dashPeriodOption: "MULTI_PERIOD",
		dashEventStreamSignalling: "XML",
	};
	const source = {
		...DEFAULT_LIVE_WIZARD_STATE,
		scte35AdMarkers: true,
		adMarkerOptions,
	};
	writeWizardDraft("markers", "live", source, 4);
	expect(readWizardDraft("markers", "live")?.value).toMatchObject({
		adMarkerOptions,
	});
	const cleared = mergeWizardDraft(
		source,
		projectWizardDraft("live", {
			...source,
			adMarkerOptions: { hlsDisablePreannouncing: false },
		}),
		"live",
	);
	expect(cleared.adMarkerOptions).toEqual({ hlsDisablePreannouncing: false });
	expect(
		mergeWizardDraft(
			source,
			projectWizardDraft("live", DEFAULT_LIVE_WIZARD_STATE),
			"live",
		).adMarkerOptions,
	).toBeUndefined();
});
it("restores safe advanced settings without silently disabling BCF, delivery, QC or live archive", () => {
	const advanced = {
		...DEFAULT_WIZARD_STATE,
		internal: { hevcV2: { bcfVersion: "v2.325.0-461-g85df7fd6c6" } },
		delivery: { specId: "delivery", onDeviation: "REFUSE" },
		qc: {
			vmaf: true,
			psnr: true,
			model: "vmaf_v0.6.1",
			gate: {
				onFail: "BLOCK_MANIFESTS",
				rules: [{ metric: "VMAF_MEAN", scope: "PER_RENDITION", gte: 85 }],
			},
		},
		subtitles: [{ codec: "WEBVTT", source: "subtitle", language: "en" }],
		thumbnails: [
			{ key: "thumb", streamKey: "video", height: 100, positions: [1, 2] },
		],
	};
	writeWizardDraft("advanced", "vod", advanced, 7);
	const restored = mergeWizardDraft(
		DEFAULT_WIZARD_STATE,
		readWizardDraft("advanced", "vod")?.value ?? {},
		"vod",
	);
	expect(restored).toMatchObject(advanced);
	const live = {
		...DEFAULT_LIVE_WIZARD_STATE,
		archive: {
			muxing: {
				key: "archive",
				kind: "MP4",
				streamKey: "video",
				additionalStreamKeys: ["audio"],
				filename: "archive.mp4",
				destination: { outputKey: "origin", path: "archive", acl: "PRIVATE" },
			},
		},
	};
	writeWizardDraft("archive", "live", live, 3);
	expect(
		mergeWizardDraft(
			DEFAULT_LIVE_WIZARD_STATE,
			readWizardDraft("archive", "live")?.value ?? {},
			"live",
		),
	).toMatchObject({ archive: live.archive });
	const disabledVod = mergeWizardDraft(
		advanced,
		projectWizardDraft("vod", DEFAULT_WIZARD_STATE),
		"vod",
	);
	expect(disabledVod.internal).toBeUndefined();
	expect(disabledVod.delivery).toBeUndefined();
	expect(disabledVod.qc).toBeUndefined();
	expect(
		mergeWizardDraft(
			live,
			projectWizardDraft("live", DEFAULT_LIVE_WIZARD_STATE),
			"live",
		).archive,
	).toBeUndefined();
	// Absent or malformed required saved leaves retain usable fresh fields.
	const malformed = mergeWizardDraft(
		DEFAULT_LIVE_WIZARD_STATE,
		projectWizardDraft("live", {
			name: {},
			output: "bad",
			videos: "bad",
			start: "bad",
		}),
		"live",
	);
	expect(malformed.output).toEqual(DEFAULT_LIVE_WIZARD_STATE.output);
	expect(malformed.videos).toEqual(DEFAULT_LIVE_WIZARD_STATE.videos);
	expect(malformed.start).toEqual(DEFAULT_LIVE_WIZARD_STATE.start);
	expect(mergeWizardDraft(DEFAULT_WIZARD_STATE, {}, "vod")).toEqual(
		DEFAULT_WIZARD_STATE,
	);
	expect(buildPlan(mergeWizardDraft(DEFAULT_WIZARD_STATE, {}, "vod"))).toEqual(
		buildPlan(DEFAULT_WIZARD_STATE),
	);
	expect(
		buildLiveChannelPlan(
			mergeWizardDraft(DEFAULT_LIVE_WIZARD_STATE, {}, "live"),
		),
	).toEqual(buildLiveChannelPlan(DEFAULT_LIVE_WIZARD_STATE));
	const email = { ...DEFAULT_WIZARD_STATE, name: "test@example" };
	expect(
		mergeWizardDraft(
			DEFAULT_WIZARD_STATE,
			projectWizardDraft("vod", email),
			"vod",
		).name,
	).toBe("test@example");
});

it("preserves and clears native HEVCv2 quality controls through browser draft storage", () => {
	const h265 = {
		motionCompensatedTemporalFiltering: "OFF" as const,
		rateControlModeConfig: {
			type: "PERCEPTUAL_QUALITY_MODE" as const,
			perceptualEncodingMode: "OFF" as const,
			perceptualStrength: 0,
			perceptualPenaltyStrength: 1,
			perceptualPenaltyKnee: 0.5,
			perceptualTemporalStrength: 0.2,
			pixelPerDegree: 60,
		},
	};
	const state: WizardState = {
		...structuredClone(DEFAULT_WIZARD_STATE),
		internal: { hevcV2: { bcfVersion: "v2.325.0-461-g85df7fd6c6" } },
		videos: [{ codec: "H265V2", height: 720, bitrate: 1000000, h265 }],
	};
	writeWizardDraft("native-quality", "vod", state, 2);
	const draft = readWizardDraft("native-quality", "vod");
	if (!draft) throw new Error("Missing native HEVCv2 quality draft");
	const restored = mergeWizardDraft(DEFAULT_WIZARD_STATE, draft.value, "vod");
	expect(restored.videos[0]?.h265).toEqual(h265);
	expect(buildPlan(restored).renditions[0]).toMatchObject(h265);
	const cleared = mergeWizardDraft(
		restored,
		projectWizardDraft("vod", {
			...state,
			videos: [{ ...state.videos[0], h265: {} }],
		}),
		"vod",
	);
	expect(buildPlan(cleared).renditions[0]).not.toHaveProperty(
		"motionCompensatedTemporalFiltering",
	);
	expect(buildPlan(cleared).renditions[0]).not.toHaveProperty(
		"rateControlModeConfig",
	);
});
