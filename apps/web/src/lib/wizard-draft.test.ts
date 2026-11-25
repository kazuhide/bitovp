import { liveChannelPlanSchema } from "@bitovp/core";
import { applyVodInputFavorite, planToWizardState } from "@bitovp/core/wizard";
import { beforeEach, expect, it, vi } from "vitest";
import {
	buildLiveChannelPlan,
	DEFAULT_LIVE_WIZARD_STATE,
	type LiveWizardState,
} from "@/app/live/new/build-live-plan";
import { planToLiveWizardState } from "@/app/live/new/live-plan-to-wizard";
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
	["S3", "///reels/take.mxf", "///reels/take.mxf"],
	["GCS", "////reels/take.mxf", "////reels/take.mxf"],
	["HTTPS", "///reels/take.mxf", ""],
	["S3", "///name@fixture.invalid/movie", ""],
	["S3", "///name:pass@fixture.invalid/movie", ""],
	["S3", "///reels/take.mxf?ticket=fixture", ""],
] as const)("round-trips only unsigned repeated-slash object keys (%s %s)", (kind, path, expected) => {
	const base = structuredClone(DEFAULT_WIZARD_STATE);
	const media = base.inputFiles[0];
	if (!media) throw new Error("missing input");
	base.inputFiles = [
		{ ...media, kind, path, bucket: "archive", credentialId: "storage" },
	];
	writeWizardDraft(
		"unsigned",
		"vod",
		{ ...base, name: "edited" },
		1,
		localStorage,
		100,
	);
	const draft = readWizardDraft("unsigned", "vod", localStorage, 101);
	if (!draft) throw new Error("missing draft");
	const restored = mergeWizardDraft(
		base,
		draft.value,
		"vod",
		draft.vodInputOrder,
	);
	expect(restored.inputFiles[0]?.path).toBe(expected);
	expect(restored.name).toBe("edited");
	expect(
		buildPlan(restored).ingest?.find((track) => track.key === "video")
			?.inputPath,
	).toBe(expected);
});

it("never saves or restores a protocol-relative HDR credential, including an older draft envelope", () => {
	const secret =
		"//fixture:FIXTURE_DRAFT_CREDENTIAL@fixture.invalid/sidecar.json";
	const state = structuredClone(DEFAULT_WIZARD_STATE);
	const sources = {
		hdr10PlusStreams: [
			{
				key: "hdr",
				inputKey: "main",
				videoInputPath: "dir/source.mxf",
				metadataInputPath: secret,
			},
		],
	};
	writeWizardDraft("hdr-old", "vod", { ...state, sources }, 2);
	const stored = localStorage.getItem("hdr-old");
	if (!stored) throw new Error("Expected an autosaved draft");
	expect(stored).not.toContain("FIXTURE_DRAFT_CREDENTIAL");
	const legacy = JSON.parse(stored);
	legacy.value.sources = sources;
	localStorage.setItem("hdr-old", JSON.stringify(legacy));
	expect(JSON.stringify(readWizardDraft("hdr-old", "vod"))).not.toContain(
		"FIXTURE_DRAFT_CREDENTIAL",
	);
	expect(localStorage.getItem("hdr-old")).not.toContain(
		"FIXTURE_DRAFT_CREDENTIAL",
	);
	expect(localStorage.getItem("hdr-old")).toContain("dir/source.mxf");
});
it.each([
	"//account:TEST_ONLY@fixture.invalid/picture",
	"https:/account:TEST_ONLY@fixture.invalid/picture",
])("cleans legacy picture rows on read while preserving spaces in unrelated keys", (path) => {
	const state = structuredClone(DEFAULT_WIZARD_STATE);
	const first = state.inputFiles[0];
	if (!first) throw new Error("missing file");
	const picture = {
		...first,
		key: "picture",
		path,
	};
	state.inputFiles = [
		picture,
		{ ...first, key: "other", path: "clips/Scene A.mxf" },
	];
	state.sources = {
		hdr10PlusStreams: [
			{
				key: "hdr",
				videoInputFile: "picture",
				metadataInputPath: " ",
				selectionMode: "AUTO",
			},
		],
	};
	writeWizardDraft("current", "vod", state, 2);
	expect(localStorage.getItem("current")).not.toContain("TEST_ONLY");
	localStorage.setItem(
		"retained",
		JSON.stringify({
			version: 1,
			kind: "vod",
			savedAt: Date.now(),
			step: 2,
			value: state,
		}),
	);
	const restored = readWizardDraft("retained", "vod");
	expect(restored?.value.inputFiles).toMatchObject([
		{ path: "" },
		{ path: "clips/Scene A.mxf" },
	]);
	expect(localStorage.getItem("retained")).not.toContain("TEST_ONLY");
	expect(localStorage.getItem("retained")).toContain("clips/Scene A.mxf");
});
it.each([
	"cut:",
	"show:shot.mxf",
	"s3:scene",
	"s3:/media/scene",
	"s3:/media/scene@take",
	"s3:/media:take@v2",
	"s3:/media&key=take",
	"s3:take 2@",
])("retains unrelated object paths and names containing a partial HDR path %s", (partial) => {
	const state = structuredClone(DEFAULT_WIZARD_STATE);
	const media = state.inputFiles[0];
	if (!media) throw new Error("missing media");
	const other = `archive/${partial}scene.mxf`;
	state.name = partial;
	state.inputFiles = [
		{ ...media, key: "master", path: "source.mxf" },
		{ ...media, key: "other", path: other },
	];
	state.sources = {
		hdr10PlusStreams: [
			{
				key: "hdr",
				videoInputFile: "master",
				metadataInputPath: partial,
				selectionMode: "AUTO",
			},
		],
	};
	writeWizardDraft("typed", "vod", state, 2);
	expect(readWizardDraft("typed", "vod")?.value).toMatchObject({
		name: partial,
		inputFiles: [{ path: "source.mxf" }, { path: other }],
		sources: { hdr10PlusStreams: [{ metadataInputPath: "" }] },
	});
	localStorage.setItem(
		"old",
		JSON.stringify({
			version: 1,
			kind: "vod",
			savedAt: Date.now(),
			step: 2,
			value: state,
		}),
	);
	expect(readWizardDraft("old", "vod")?.value.inputFiles).toMatchObject([
		{ path: "source.mxf" },
		{ path: other },
	]);
	expect(localStorage.getItem("old")).toContain(other);
});
it("restores an edited MoQ copy without erasing a namespace excluded from local storage", () => {
	const source: LiveWizardState = {
		...DEFAULT_LIVE_WIZARD_STATE,
		output: {
			...DEFAULT_LIVE_WIZARD_STATE.output,
			kind: "MOQ",
			moq: {
				key: "relay",
				draftVersion: "DRAFT_16",
				trackNamespace: ["sports#2", "secondary"],
			},
		},
	};
	const saved = projectWizardDraft("live", {
		...source,
		name: "Edited live copy",
	});
	expect(JSON.stringify(saved)).not.toContain("sports#2");
	const restored = mergeWizardDraft(source, saved, "live");
	expect(restored.name).toBe("Edited live copy");
	expect(restored.output.moq).toEqual(source.output.moq);
});

it("restores a fixed output logo with its image-only source and rendition attachments", () => {
	const base = structuredClone(DEFAULT_WIZARD_STATE);
	base.inputFiles[0] = {
		key: "main",
		inputKey: "main",
		kind: "S3",
		credentialId: "44444444-4444-4444-8444-444444444444",
		bucket: "media",
		path: "main.mp4",
	};
	let id = 0;
	const original = applyVodInputFavorite(
		base,
		{
			id: "55555555-5555-4555-8555-555555555555",
			credentialId: base.inputFiles[0].credentialId,
			bucket: "media",
			objectKey: "images/logo.png",
			label: "Logo",
			kind: "IMAGE",
			availability: "AVAILABLE",
			inputKind: "S3",
		},
		() => `key${++id}`,
	).state;
	writeWizardDraft("logo", "vod", original, 1);
	const saved = readWizardDraft("logo", "vod");
	if (!saved) throw new Error("Logo draft was not saved");
	const restored = mergeWizardDraft(DEFAULT_WIZARD_STATE, saved.value, "vod");
	expect(restored.inputFiles).toEqual(original.inputFiles);
	expect(restored.filters).toEqual(original.filters);
	expect(restored.videos.map((video) => video.extras?.filters)).toEqual(
		original.videos.map((video) => video.extras?.filters),
	);
	expect(buildPlan(restored).filters).toEqual(buildPlan(original).filters);
	expect(
		buildPlan(restored).renditions.map((rendition) => rendition.filters),
	).toEqual(
		buildPlan(original).renditions.map((rendition) => rendition.filters),
	);
});

it("does not persist image URLs, unknown filter JSON or dangling logo attachments", () => {
	const state = structuredClone(DEFAULT_WIZARD_STATE);
	const value = projectWizardDraft("vod", {
		...state,
		inputFiles: [{ ...state.inputFiles[0], purpose: "SECRET_UNKNOWN" }],
		filters: [
			{
				key: "unsafe",
				kind: "WATERMARK",
				inputKey: "main",
				imagePath: "https://host/image.png?token=SECRET_URL",
			},
			{ key: "text", kind: "TEXT", text: "SECRET_OPTIONS", x: "0", y: "0" },
		],
		videos: state.videos.map((video) => ({
			...video,
			extras: {
				filters: [{ filterKey: "unsafe", position: 0 }],
				jsonOptions: "SECRET_JSON",
			},
		})),
	});
	expect(JSON.stringify(value)).not.toMatch(/SECRET|token=|https:\/\//);
	const restored = mergeWizardDraft(DEFAULT_WIZARD_STATE, value, "vod");
	expect(
		restored.videos.flatMap((video) => video.extras?.filters ?? []),
	).toEqual([]);
});

it("keeps a sparse legacy VOD draft on its implicit STABLE version", () => {
	expect(
		mergeWizardDraft(DEFAULT_WIZARD_STATE, { name: "Legacy draft" }, "vod")
			.encoderVersion,
	).toBe("STABLE");
	expect(DEFAULT_WIZARD_STATE.encoderVersion).toBe("2.294.0");
	expect(
		mergeWizardDraft(DEFAULT_LIVE_WIZARD_STATE, { name: "Live draft" }, "live")
			.encoderVersion,
	).toBe("BETA");
});

it.each([
	"STABLE",
	"BETA",
	"2.287.0",
	"2.291.0",
	"2.292.0",
	"custom-version",
])("retains explicit saved VOD encoder %s and per-encoding overrides", (encoderVersion) => {
	const state = structuredClone(DEFAULT_WIZARD_STATE);
	state.encoderVersion = encoderVersion;
	state.sources = {
		...state.sources,
		encodings: [
			{ key: "first", name: "First", encoderVersion: "2.291.0" },
			{ key: "second", name: "Second", encoderVersion: "STABLE" },
		],
	};
	writeWizardDraft("encoder-version", "vod", state, 2);
	const draft = readWizardDraft("encoder-version", "vod");
	if (!draft) throw new Error("Missing encoder version draft");
	const restored = mergeWizardDraft(DEFAULT_WIZARD_STATE, draft.value, "vod");
	expect(restored.encoderVersion).toBe(encoderVersion);
	expect(restored.sources?.encodings).toEqual(state.sources.encodings);
});

it("restores Live video/audio input positions and paths through persisted browser drafts", () => {
	const state: LiveWizardState = structuredClone(DEFAULT_LIVE_WIZARD_STATE);
	const video = state.videos[0],
		audio = state.audios[0];
	if (!video || !audio) throw new Error("Missing default rendition");
	state.videos.push({
		...video,
		width: 640,
		height: 360,
		bitrate: 1000000,
	});
	state.videos = state.videos.map((row, index) => ({
		...row,
		input: { position: index === 0 ? 0 : 2, inputPath: "video-alternate" },
	}));
	state.audios = state.audios.map((row) => ({
		...row,
		input: { position: 0, inputPath: "audio-alternate" },
	}));
	state.audios.push({
		...audio,
		bitrate: 96000,
		input: { position: 2, inputPath: "audio-second" },
	});
	writeWizardDraft("live-inputs", "live", state, 2);
	const saved = readWizardDraft("live-inputs", "live");
	if (!saved) throw new Error("Missing saved draft");
	const restored = mergeWizardDraft(
		DEFAULT_LIVE_WIZARD_STATE,
		saved.value,
		"live",
	);
	expect(restored.videos.map((row) => row.input)).toEqual(
		state.videos.map((row) => row.input),
	);
	expect(restored.audios.map((row) => row.input)).toEqual(
		state.audios.map((row) => row.input),
	);
	expect(buildLiveChannelPlan(restored)).toEqual(buildLiveChannelPlan(state));
});

it("preserves shared imported Live selections and their resource order after a draft reload", () => {
	const source: LiveWizardState = structuredClone(DEFAULT_LIVE_WIZARD_STATE);
	const video = source.videos[0],
		audio = source.audios[0];
	if (!video || !audio) throw new Error("Missing default rendition");
	source.name = "Shared input draft";
	source.output.credentialId = "11111111-1111-4111-8111-111111111111";
	source.output.bucket = "bucket";
	source.videos.push({
		...video,
		width: 640,
		height: 360,
		bitrate: 1000000,
	});
	source.audios.push({ ...audio, bitrate: 96000 });
	source.videos = source.videos.map((row) => ({
		...row,
		input: { key: "shared-video", position: 2, inputPath: "video-alternate" },
	}));
	source.audios = source.audios.map((row) => ({
		...row,
		input: { key: "shared-audio", position: 0, inputPath: "audio-alternate" },
	}));
	source.ingestOrder = ["shared-audio", "shared-video"];
	const plan = liveChannelPlanSchema.parse(buildLiveChannelPlan(source));
	const imported = planToLiveWizardState(plan);
	writeWizardDraft("shared-live-inputs", "live", imported, 2);
	const saved = readWizardDraft("shared-live-inputs", "live");
	if (!saved) throw new Error("Missing saved draft");
	const restored = mergeWizardDraft(
		DEFAULT_LIVE_WIZARD_STATE,
		saved.value,
		"live",
	);
	expect(liveChannelPlanSchema.parse(buildLiveChannelPlan(restored))).toEqual(
		plan,
	);
	expect(restored.ingestOrder).toEqual(["shared-audio", "shared-video"]);
});

it.each([
	undefined,
	{},
])("clears copied Live input selections and ordering when the saved state is blank (%j)", (input) => {
	const source: LiveWizardState = structuredClone(DEFAULT_LIVE_WIZARD_STATE);
	source.videos = source.videos.map((row) => ({
		...row,
		input: { key: "shared-video", position: 2, inputPath: "video-alternate" },
	}));
	source.audios = source.audios.map((row) => ({
		...row,
		input: { key: "shared-audio", position: 0, inputPath: "audio-alternate" },
	}));
	source.ingestOrder = ["shared-audio", "shared-video"];
	const cleared: LiveWizardState = {
		...structuredClone(DEFAULT_LIVE_WIZARD_STATE),
		videos: source.videos.map(({ input: _input, ...row }) => ({
			...row,
			input,
		})),
		audios: source.audios.map(({ input: _input, ...row }) => ({
			...row,
			input,
		})),
	};
	writeWizardDraft("cleared-live-inputs", "live", cleared, 2);
	const saved = readWizardDraft("cleared-live-inputs", "live");
	if (!saved) throw new Error("Missing saved draft");
	const restored = mergeWizardDraft(source, saved.value, "live");
	expect(restored.ingestOrder).toBeUndefined();
	expect(buildLiveChannelPlan(restored)).toEqual(buildLiveChannelPlan(cleared));
	expect(
		buildLiveChannelPlan(restored).ingest.map(
			(selection) => selection.position,
		),
	).toEqual([0, 1]);
});

it("allowlists only Live input selection fields and excludes nested credentials and URLs", () => {
	const value = {
		...DEFAULT_LIVE_WIZARD_STATE,
		videos: [
			{
				...DEFAULT_LIVE_WIZARD_STATE.videos[0],
				input: {
					key: "safe-selection",
					position: 0,
					inputPath: "alternate",
					credentialId: "SECRET_CREDENTIAL",
					secret: "SECRET_VALUE",
					url: "https://user:SECRET_AUTH@host/path",
				},
			},
		],
		audios: [
			{
				...DEFAULT_LIVE_WIZARD_STATE.audios[0],
				input: {
					inputPath: "https://user:SECRET_URL@host/path?token=SECRET_TOKEN",
					password: "SECRET_PASSWORD",
				},
			},
		],
	};
	writeWizardDraft("safe-live-inputs", "live", value, 2);
	const saved = readWizardDraft("safe-live-inputs", "live");
	expect(saved?.value.videos).toMatchObject([
		{ input: { key: "safe-selection", position: 0, inputPath: "alternate" } },
	]);
	expect(localStorage.getItem("safe-live-inputs")).not.toMatch(
		/SECRET|"url"|"secret"|"password"/,
	);
	expect(projectWizardDraft("vod", value).videos).not.toEqual(
		expect.arrayContaining([
			expect.objectContaining({ input: expect.anything() }),
		]),
	);
});
it.each([
	{ backend: "CLOUD", profileId: "gcp-qc", budgetUsd: 12 },
	{ backend: "CLOUD", profileId: "gcp-qc", budgetUsd: 0 },
	{ backend: "LOCAL" },
	{ backend: "LOCAL", localMode: "CPU" },
	{ backend: "LOCAL", localMode: "AUTO" },
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
	expect(buildPlan(restored).qc?.execution).toEqual(execution);
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
it("persists the ninth Live step without remapping it on reload", () => {
	writeWizardDraft(
		"live-review",
		"live",
		{ name: "Ready to review", segmentLength: 6 },
		8,
		localStorage,
		100,
	);
	expect(readWizardDraft("live-review", "live", localStorage, 101)).toEqual({
		step: 8,
		value: { name: "Ready to review", segmentLength: 6 },
	});
	expect(
		JSON.parse(localStorage.getItem("live-review") ?? "null"),
	).toMatchObject({
		version: 2,
		kind: "live",
		step: 8,
	});
});
it.each([
	[0, 0],
	[1, 1],
	[2, 2],
	[3, 3],
	[4, 6],
	[5, 5],
	[6, 7],
	[7, 8],
])("maps legacy Live step %i to step %i without changing the settings", (previous, current) => {
	const value = { name: "Saved channel", segmentLength: 6 };
	localStorage.setItem(
		"legacy-live",
		JSON.stringify({
			version: 1,
			kind: "live",
			savedAt: 100,
			step: previous,
			value,
		}),
	);
	expect(readWizardDraft("legacy-live", "live", localStorage, 101)).toEqual({
		step: current,
		value,
	});
});
it("keeps the eight-step VOD draft format and rejects out-of-range steps", () => {
	writeWizardDraft(
		"vod-review",
		"vod",
		{ name: "Saved job" },
		7,
		localStorage,
		100,
	);
	expect(readWizardDraft("vod-review", "vod", localStorage, 101)).toEqual({
		step: 7,
		value: { name: "Saved job" },
	});
	expect(JSON.parse(localStorage.getItem("vod-review") ?? "null").version).toBe(
		1,
	);
	writeWizardDraft("invalid-vod-step", "vod", {}, 8, localStorage, 100);
	expect(localStorage.getItem("invalid-vod-step")).toBeNull();
	for (const [kind, version, step] of [
		["live", 1, 8],
		["live", 2, 9],
		["vod", 2, 8],
	] as const) {
		localStorage.setItem(
			"invalid-step",
			JSON.stringify({ version, kind, step, savedAt: 100, value: {} }),
		);
		expect(readWizardDraft("invalid-step", kind, localStorage, 101)).toBeNull();
		expect(localStorage.getItem("invalid-step")).toBeNull();
	}
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
	expect(mergeWizardDraft(DEFAULT_WIZARD_STATE, {}, "vod")).toEqual({
		...DEFAULT_WIZARD_STATE,
		encoderVersion: "STABLE",
	});
	expect(buildPlan(mergeWizardDraft(DEFAULT_WIZARD_STATE, {}, "vod"))).toEqual(
		buildPlan({ ...DEFAULT_WIZARD_STATE, encoderVersion: "STABLE" }),
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

it("preserves safe manifest details and drops malformed nested detail groups", () => {
	const draft = projectWizardDraft("vod", {
		name: "Draft",
		manifests: {
			hls: true,
			dash: true,
			hlsOptions: {
				detailed: {
					channelsAttributeForAudio: "ALWAYS",
					audioMedia: { isDefault: false, startSegmentNumber: 0 },
					streams: {
						forceFrameRateAttribute: false,
						audioGroups: {
							droppingMode: "AUDIO",
							groups: [{ name: "audio", priority: 0 }],
						},
					},
					additionalMedia: [
						{
							type: "VTT",
							vttUrl: "https://secret.example/?token=credential",
							uri: "subs.m3u8",
							name: "Subtitles",
							groupId: "subtitles",
						},
					],
					mediaCustomTags: [
						{ positionMode: "TIME", time: 0, data: "#TOKEN:credential" },
					],
				},
			},
			dashOptions: {
				detailed: {
					minBufferTime: 3,
					period: { start: 0, duration: 10 },
					representations: [{ muxingKey: "v720", startSegmentNumber: 0 }],
				},
			},
		},
	});
	expect(draft).toMatchObject({
		name: "Draft",
		manifests: {
			hlsOptions: {
				detailed: {
					channelsAttributeForAudio: "ALWAYS",
					audioMedia: { isDefault: false, startSegmentNumber: 0 },
					streams: { forceFrameRateAttribute: false },
				},
			},
			dashOptions: {
				detailed: { minBufferTime: 3, period: { start: 0, duration: 10 } },
			},
		},
	});
	expect(JSON.stringify(draft)).not.toContain("credential");
	const malformed = projectWizardDraft("vod", {
		name: "Keep",
		manifests: {
			hls: true,
			hlsOptions: {
				masterVersion: "HLS_V6",
				detailed: { streams: { audioGroups: {} } },
			},
			dashOptions: {
				detailed: { representations: [{}] },
				defaultPeriods: [
					{
						encodingKeys: ["default"],
						adaptationSets: [{ type: "AND", conditions: [{}] }],
					},
				],
			},
		},
	});
	expect(malformed).toMatchObject({
		name: "Keep",
		manifests: { hlsOptions: { masterVersion: "HLS_V6" } },
	});
	expect(
		(
			malformed.manifests as {
				hlsOptions: { detailed?: unknown };
				dashOptions: { detailed?: unknown; defaultPeriods?: unknown };
			}
		).hlsOptions.detailed,
	).toBeUndefined();
	expect(
		(
			malformed.manifests as {
				dashOptions: { detailed?: unknown; defaultPeriods?: unknown };
			}
		).dashOptions,
	).toMatchObject({ detailed: undefined, defaultPeriods: undefined });
});

it("restores a copied HDR picture and the original audio master from audio-first legacy rows", () => {
	const base = structuredClone(DEFAULT_WIZARD_STATE);
	const primary = base.inputFiles[0];
	if (!primary) throw new Error("missing file");
	base.inputFiles = [
		{
			...primary,
			key: "picture",
			path: "picture.mxf",
			inputDeclarationIndex: 1,
		},
		{ ...primary, key: "sound", path: "program.wav", inputDeclarationIndex: 0 },
	];
	base.audioInputFile = "sound";
	base.sources = {
		hdr10PlusStreams: [
			{
				key: "hdr",
				videoInputFile: "picture",
				metadataInputPath: "picture.json",
				selectionMode: "AUTO",
			},
		],
	};
	const legacy = projectWizardDraft("vod", base);
	legacy.inputFiles = [base.inputFiles[1], base.inputFiles[0]].map((file) => {
		if (!file) throw new Error("missing");
		const { inputDeclarationIndex: _index, ...rest } = file;
		return rest;
	});
	delete legacy.audioInputFile;
	const restored = mergeWizardDraft(base, legacy, "vod");
	expect(
		restored.inputFiles.map((f) => [f.path, f.inputDeclarationIndex]),
	).toEqual([
		["picture.mxf", 1],
		["program.wav", 0],
	]);
	expect(restored.audioInputFile).toBe("sound");
	const compiled = buildPlan(restored);
	expect(compiled.ingest).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				selectionMode: "AUDIO_RELATIVE",
				inputPath: "program.wav",
			}),
			expect.objectContaining({
				selectionMode: "VIDEO_RELATIVE",
				inputPath: "picture.mxf",
			}),
		]),
	);
});

it.each([
	"replaced-picture",
	"recycled-key",
	"recycled-key-first",
	"same-object",
	"authored-order",
	"removed-hdr",
] as const)("retains edited picture and audio semantics for a copied HDR draft (%s)", (edit) => {
	const base = structuredClone(DEFAULT_WIZARD_STATE);
	const input = base.inputFiles[0];
	if (!input) throw new Error("missing input");
	const file = (key: string, path: string) => ({ ...input, key, path });
	const sound = file("sound", "program.wav"),
		primary = file("picture", "master.mxf"),
		alternate = file("alternate", "secondary.mxf");
	base.inputFiles = [primary, sound, alternate];
	base.audioInputFile = sound.key;
	base.sources = {
		hdr10PlusStreams: [
			{
				key: "hdr",
				videoInputFile: primary.key,
				metadataInputPath: "meta.json",
				selectionMode: "AUTO",
			},
		],
	};
	const saved = structuredClone(base);
	const recycled = {
		...primary,
		credentialId: "new-storage",
		bucket: "other-bucket",
	};
	const replaced =
		edit === "replaced-picture" || edit.startsWith("recycled-key");
	if (replaced) {
		saved.inputFiles =
			edit === "recycled-key-first"
				? [recycled, sound, alternate]
				: edit === "recycled-key"
					? [sound, alternate, recycled]
					: [sound, alternate];
		const stream = saved.sources?.hdr10PlusStreams?.[0];
		if (!stream) throw new Error("missing HDR stream");
		stream.videoInputFile = alternate.key;
	} else saved.inputFiles = [alternate, primary, sound];
	if (edit === "removed-hdr") delete saved.sources;
	delete saved.audioInputFile;
	writeWizardDraft("copy-order", "vod", saved, 1, localStorage, 100);
	if (edit === "same-object" || replaced) {
		const value = projectWizardDraft("vod", saved);
		localStorage.setItem(
			"copy-order",
			JSON.stringify({ kind: "vod", version: 1, savedAt: 100, step: 1, value }),
		);
	}
	const draft = readWizardDraft("copy-order", "vod", localStorage, 101);
	if (!draft) throw new Error("missing saved draft");
	const restored = mergeWizardDraft(
		base,
		draft.value,
		"vod",
		draft.vodInputOrder,
	);
	const picture = edit === "same-object" ? primary : alternate;
	expect(restored.inputFiles[0]?.key).toBe(picture.key);
	expect(restored.audioInputFile).toBe(
		replaced && edit !== "recycled-key-first" ? sound.key : undefined,
	);
	const compiled = buildPlan(restored);
	expect(
		compiled.ingest?.find((row) => row.selectionMode === "VIDEO_RELATIVE")
			?.inputPath,
	).toBe(picture.path);
	expect(
		compiled.ingest?.find((row) => row.selectionMode === "AUDIO_RELATIVE")
			?.inputPath,
	).toBe(replaced && edit !== "recycled-key-first" ? sound.path : picture.path);
});

it.each([
	"ordinary",
	"audio",
] as const)("keeps an edited %s master through Copy and restored legacy input rows", (editedRole) => {
	const authored = structuredClone(DEFAULT_WIZARD_STATE);
	const file = authored.inputFiles[0];
	const rendition = authored.videos[0];
	if (!file || !rendition)
		throw new Error("missing default input or rendition");
	const fileAt = (key: string, path: string) => ({
		...file,
		key,
		inputKey: key,
		path,
	});
	const ordinary = fileAt("footage", "camera.mxf");
	const sound = fileAt("sound", "program.wav");
	const hdr = fileAt("pair", "hdr.mxf");
	authored.inputFiles = [ordinary, sound, hdr];
	authored.audioInputFile = sound.key;
	authored.sources = {
		hdr10PlusStreams: [
			{
				key: "hdr10plus1",
				videoInputFile: hdr.key,
				metadataInputPath: "hdr.json",
				selectionMode: "AUTO",
			},
		],
	};
	authored.videos = [
		{ ...rendition, codec: "H265", extras: { source: "hdr10plus1" } },
		{ ...rendition, height: 720 },
	];
	const native = buildPlan(authored);
	// Older copies used the provider declarations: the WAV led the saved rows.
	native.inputs = [...native.inputs].sort(
		(a, b) => Number(b.key === "sound") - Number(a.key === "sound"),
	);
	const base = planToWizardState(native as unknown as Record<string, unknown>);
	const fix = editedRole === "ordinary" ? "camera.mxf" : "program.wav";
	const saved = projectWizardDraft("vod", base);
	expect(saved).not.toHaveProperty("copiedPictureSource");
	saved.inputFiles = [...base.inputFiles]
		.sort(
			(a, b) =>
				Number(b.path === "program.wav") - Number(a.path === "program.wav"),
		)
		.map((f) => {
			const { inputDeclarationIndex: _rank, ...rest } = f;
			return { ...rest, path: f.path === fix ? `new/${f.path}` : f.path };
		});
	delete saved.audioInputFile;
	const restored = buildPlan(mergeWizardDraft(base, saved, "vod"));
	expect(restored.ingest?.find((x) => x.key === "video")?.inputPath).toBe(
		editedRole === "ordinary" ? "new/camera.mxf" : "camera.mxf",
	);
	expect(restored.ingest?.find((x) => x.key === "audio")?.inputPath).toBe(
		editedRole === "audio" ? "new/program.wav" : "program.wav",
	);
	expect(restored.hdr10PlusStreams?.[0]?.videoInputPath).toBe("hdr.mxf");
});

it.each([
	"direct",
	"wrapped",
	"cleared-binding",
	"kept-binding",
] as const)("keeps the first saved audio object after adding an implicit AAC rendition to a named HDR copy (%s)", (mode) => {
	const authored = structuredClone(DEFAULT_WIZARD_STATE);
	const media = authored.inputFiles[0];
	const video = authored.videos[0],
		audio = authored.audios[0];
	if (!media || !video || !audio) throw new Error("missing base files");
	const picture = { ...media, key: "pic", inputKey: "pic", path: "master.mxf" };
	const sound = {
		...media,
		key: "sound",
		inputKey: "sound",
		path: "program.wav",
	};
	authored.inputFiles = [sound, picture];
	authored.sources = {
		tracks: [
			{
				key: "narration",
				inputFile: sound.key,
				selectionMode: "AUDIO_RELATIVE",
				position: 0,
			},
		],
		hdr10PlusStreams: [
			{
				key: "hdr",
				videoInputFile: picture.key,
				metadataInputPath: "sidecar.json",
				selectionMode: "AUTO",
			},
		],
	};
	authored.videos = [{ ...video, codec: "H265", extras: { source: "hdr" } }];
	authored.audios = [{ ...audio, extras: { source: "narration" } }];
	const previous = {
		...media,
		key: "previous-audio",
		inputKey: "previous-audio",
		path: "previous.wav",
	};
	const separate = mode === "cleared-binding" || mode === "kept-binding";
	if (separate) {
		authored.inputFiles.push(previous);
		authored.audioInputFile = previous.key;
		authored.audios.push({ ...audio, bitrate: 256000 });
	}
	const base = planToWizardState(
		buildPlan(authored) as unknown as Record<string, unknown>,
	);
	const files = [...base.inputFiles].sort(
		(a, b) => Number(b.path === sound.path) - Number(a.path === sound.path),
	);
	expect(files[0]?.path).toBe(sound.path);
	expect(
		base.inputFiles.find((row) => row.key === base.audioInputFile)?.path,
	).toBe(separate ? previous.path : undefined);
	const saved = projectWizardDraft("vod", {
		...base,
		audioInputFile: mode === "kept-binding" ? base.audioInputFile : undefined,
		inputFiles: files,
		sources: {
			...base.sources,
			...(mode === "wrapped" && {
				trimmingStreams: [
					{
						kind: "TIME_BASED",
						key: "trim-sound",
						sourceKey: "audio",
						offset: 0,
						duration: 5,
					},
				],
			}),
		},
		audios: [
			...base.audios,
			{
				...audio,
				bitrate: 320000,
				...(mode === "wrapped" && { extras: { source: "trim-sound" } }),
			},
		],
	});
	const built = buildPlan(mergeWizardDraft(base, saved, "vod"));
	expect(built.hdr10PlusStreams?.[0]?.videoInputPath).toBe(picture.path);
	expect(built.ingest?.find((track) => track.key === "audio")?.inputPath).toBe(
		mode === "kept-binding" ? previous.path : sound.path,
	);
});

it.each([
	"rebound",
	"removed-and-recycled",
	"removed-picture-retained",
	"rebound-picture-retained",
	"edited-picture",
	"new-ordinary-row",
	"wrapped-ordinary",
] as const)("restores edited HDR Copy media bindings (%s)", (edit) => {
	const authored = structuredClone(DEFAULT_WIZARD_STATE);
	const file = authored.inputFiles[0];
	const rendition = authored.videos[0];
	if (!file || !rendition) throw new Error("missing source or rendition");
	file.path = "original.mxf";
	authored.videos = [
		{ ...rendition, codec: "H265", extras: { source: "hdr" } },
	];
	authored.sources = {
		hdr10PlusStreams: [
			{
				key: "hdr",
				videoInputFile: file.key,
				metadataInputPath: "original.json",
				selectionMode: "AUTO",
			},
		],
	};
	const base = planToWizardState(
		buildPlan(authored) as unknown as Record<string, unknown>,
	);
	const original = base.inputFiles[0];
	const hdr = base.sources?.hdr10PlusStreams?.[0];
	if (!original || !hdr) throw new Error("missing copied HDR binding");
	expect(base.audioInputFile).toBeUndefined();
	const replacement = {
		...original,
		key: "replacement",
		path: "replacement.mxf",
	};
	const recycled = edit === "removed-and-recycled";
	const removed = recycled || edit === "removed-picture-retained";
	const hasOrdinary = edit !== "rebound";
	const ordinary =
		edit === "edited-picture" || edit === "wrapped-ordinary"
			? { ...original, path: "edited.mxf" }
			: edit === "new-ordinary-row"
				? { ...original, key: "ordinary", path: "ordinary.mxf" }
				: original;
	const wrapped = edit === "wrapped-ordinary";
	const selected = wrapped
		? { ...hdr, key: "video" }
		: removed
			? { ...hdr, key: "replacementHdr" }
			: hdr;
	const saved = projectWizardDraft("vod", {
		...base,
		inputFiles: recycled
			? [replacement, { ...original, path: "unrelated.mxf" }]
			: [ordinary, replacement],
		sources: {
			...base.sources,
			...(wrapped
				? {
						trimmingStreams: [
							{
								key: "trim-primary",
								kind: "TIME_BASED" as const,
								sourceKey: "video-input-1",
								offset: 0,
								duration: 3,
							},
						],
					}
				: {}),
			hdr10PlusStreams: [
				{
					...selected,
					videoInputFile: replacement.key,
					metadataInputPath: "replacement.json",
				},
			],
		},
		...(hasOrdinary
			? {
					videos: [
						{ ...rendition, codec: "H265", extras: { source: selected.key } },
						{
							...rendition,
							height: 720,
							...(wrapped && { extras: { source: "trim-primary" } }),
						},
					],
				}
			: {}),
	});
	const plan = buildPlan(mergeWizardDraft(base, saved, "vod"));
	expect(plan.hdr10PlusStreams?.[0]).toMatchObject({
		videoInputPath: "replacement.mxf",
		metadataInputPath: "replacement.json",
	});
	if (hasOrdinary) {
		expect(
			plan.ingest?.find(
				(entry) => entry.key === (wrapped ? "video-input-1" : "video"),
			)?.inputPath,
		).toBe(recycled ? "replacement.mxf" : ordinary.path);
	} else {
		expect(plan.ingest?.find((entry) => entry.key === "audio")?.inputPath).toBe(
			"original.mxf",
		);
	}
});
