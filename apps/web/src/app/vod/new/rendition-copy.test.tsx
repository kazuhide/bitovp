import { encodingPlanSchema, validatePlan } from "@bitovp/core";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
	DEFAULT_LIVE_WIZARD_STATE,
	type LiveWizardState,
} from "@/app/live/new/build-live-plan";
import { LiveLadderSection } from "@/app/live/new/ladder-section";
import { renderWithQuery } from "@/test/render";
import * as automaticPackaging from "./automatic-audio-packaging";
import {
	audioKeys,
	buildPlan,
	DEFAULT_WIZARD_STATE,
	videoKeys,
	type WizardState,
} from "./build-plan";
import {
	addVodAudio,
	addVodVideo,
	updateVodVideoHeight,
} from "./rendition-copy";
import { VodWizard } from "./wizard";
import { LadderSection } from "./wizard-sections";

vi.mock("@/lib/api", async (original) => ({
	...(await original<object>()),
	apiFetch: async () => [],
}));
vi.mock("next/navigation", () => ({
	useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

function vodState(): WizardState {
	const state = structuredClone(DEFAULT_WIZARD_STATE);
	state.videos = [
		{ height: 360, bitrate: 400_000 },
		{
			codec: "H265",
			height: 720,
			bitrate: 1_500_000,
			encodingMode: "THREE_PASS",
			h265: {
				presetConfiguration: "VOD_VERYHIGH_QUALITY",
				rcLookahead: 40,
				colorConfig: { colorSpace: "BT709" },
			},
			extras: {
				key: "configured-video",
				source: "input-video",
				filters: [{ filterKey: "crop", position: 0 }],
			},
			muxing: {
				key: "configured-mux",
				kind: "TS",
				path: "custom/video",
				muxedAudioKeys: ["configured-audio"],
				segmentLength: 4,
			},
			extraMuxings: [
				{
					key: "configured-mp4",
					kind: "MP4",
					path: "custom/archive",
					filename: "video.mp4",
				},
			],
		},
	];
	state.audios = [
		{ bitrate: 64_000, rate: 44100 },
		{
			codec: "DDPLUS",
			bitrate: 192_000,
			rate: 48000,
			channelLayout: "CL_5_1",
			loudness: { speechThreshold: 20 },
			extras: {
				key: "configured-audio",
				source: "audio-mix",
				filters: [{ filterKey: "gain", position: 0 }],
			},
			muxing: { kind: "TS", path: "custom/audio" },
		},
	];
	return state;
}

function liveState(): LiveWizardState {
	const state = structuredClone(DEFAULT_LIVE_WIZARD_STATE);
	state.videos = [
		{ codec: "H264", height: 360, bitrate: 400_000 },
		{
			codec: "H265",
			height: 720,
			bitrate: 1_500_000,
			presetConfiguration: "LIVE_VERYHIGH_QUALITY",
			h265: { rcLookahead: 20, colorConfig: { colorSpace: "BT709" } },
			container: "TS",
			muxedAudioKeys: ["configured-audio"],
			extras: { key: "configured-video" },
		},
	];
	state.audios = [
		{ codec: "AAC", bitrate: 64_000, rate: 44100 },
		{
			codec: "DDPLUS",
			bitrate: 192_000,
			rate: 48000,
			channelLayout: "CL_5_1",
			container: "TS",
			extras: { key: "configured-audio" },
		},
	];
	return state;
}

function validState(): WizardState {
	const state = structuredClone(DEFAULT_WIZARD_STATE);
	state.name = "copy-regression";
	state.inputFiles = [
		{
			key: "main",
			inputKey: "main",
			kind: "S3",
			credentialId: "00000000-0000-4000-8000-000000000001",
			bucket: "input",
			path: "video.mp4",
		},
	];
	state.output = {
		...state.output,
		credentialId: "00000000-0000-4000-8000-000000000002",
		bucket: "output",
		basePath: "copy-test/",
	};
	state.manifests = { hls: false, dash: false };
	return state;
}

describe("rendition Add reuses complete settings", () => {
	it("VOD Add defaults to the last video and audio with independent nested copies", () => {
		const state = vodState();
		const onPatch = vi.fn();
		renderWithQuery(
			<LadderSection state={state} credentials={[]} onPatch={onPatch} />,
		);
		fireEvent.click(screen.getByRole("button", { name: /Add video/ }));
		const video = onPatch.mock.lastCall?.[0].videos[2];
		expect(video).toMatchObject({
			codec: "H265",
			encodingMode: "THREE_PASS",
			h265: state.videos[1]?.h265,
			extras: {
				source: "input-video",
				filters: [{ filterKey: "crop", position: 0 }],
			},
			muxing: {
				kind: "TS",
				muxedAudioKeys: ["configured-audio"],
				segmentLength: 4,
			},
			extraMuxings: [{ kind: "MP4", filename: "video.mp4" }],
		});
		video.h265.colorConfig.colorSpace = "BT2020_NCL";
		video.extras.filters[0].position = 5;
		video.muxing.muxedAudioKeys.push("another-audio");
		expect(state.videos[1]?.h265?.colorConfig?.colorSpace).toBe("BT709");
		expect(state.videos[1]?.extras?.filters?.[0]?.position).toBe(0);
		expect(state.videos[1]?.muxing?.muxedAudioKeys).toEqual([
			"configured-audio",
		]);
		fireEvent.click(screen.getByRole("button", { name: /Add audio/ }));
		const audio = onPatch.mock.lastCall?.[0].audios[2];
		expect(audio).toMatchObject({
			codec: "DDPLUS",
			channelLayout: "CL_5_1",
			loudness: { speechThreshold: 20 },
			extras: {
				source: "audio-mix",
				filters: [{ filterKey: "gain", position: 0 }],
			},
		});
		audio.loudness.speechThreshold = 40;
		expect(state.audios[1]?.loudness?.speechThreshold).toBe(20);
	});
	it("Live Add reuses preset, codec tuning, audio and container settings independently", () => {
		const state = liveState();
		const onPatch = vi.fn();
		renderWithQuery(<LiveLadderSection state={state} onPatch={onPatch} />);
		fireEvent.click(screen.getByRole("button", { name: /Add video/ }));
		const video = onPatch.mock.lastCall?.[0].videos[2];
		expect(video).toMatchObject({
			codec: "H265",
			presetConfiguration: "LIVE_VERYHIGH_QUALITY",
			h265: state.videos[1]?.h265,
			container: "TS",
			muxedAudioKeys: ["configured-audio"],
		});
		video.h265.colorConfig.colorSpace = "BT2020_NCL";
		video.muxedAudioKeys.push("another-audio");
		expect(state.videos[1]?.h265?.colorConfig?.colorSpace).toBe("BT709");
		expect(state.videos[1]?.muxedAudioKeys).toEqual(["configured-audio"]);
		fireEvent.click(screen.getByRole("button", { name: /Add audio/ }));
		expect(onPatch.mock.lastCall?.[0].audios[2]).toMatchObject({
			codec: "DDPLUS",
			bitrate: 192_000,
			rate: 48000,
			channelLayout: "CL_5_1",
			container: "TS",
		});
	});
	for (const kind of ["VOD", "Live"] as const) {
		it(`${kind} lets Add reuse an earlier rendition or start with default settings`, () => {
			const onPatch = vi.fn();
			if (kind === "VOD")
				renderWithQuery(
					<LadderSection
						state={vodState()}
						credentials={[]}
						onPatch={onPatch}
					/>,
				);
			else
				renderWithQuery(
					<LiveLadderSection state={liveState()} onPatch={onPatch} />,
				);
			fireEvent.change(screen.getByLabelText("Video settings to reuse"), {
				target: { value: "v360" },
			});
			fireEvent.click(screen.getByRole("button", { name: /Add video/ }));
			expect(onPatch.mock.lastCall?.[0].videos[2]).toMatchObject({
				height: 360,
				bitrate: 400_000,
			});
			expect(onPatch.mock.lastCall?.[0].videos[2].h265).toBeUndefined();
			fireEvent.change(screen.getByLabelText("Audio settings to reuse"), {
				target: { value: "a64" },
			});
			fireEvent.click(screen.getByRole("button", { name: /Add audio/ }));
			expect(onPatch.mock.lastCall?.[0].audios[2]).toMatchObject({
				bitrate: 64_000,
				rate: 44100,
			});
			fireEvent.change(screen.getByLabelText("Video settings to reuse"), {
				target: { value: "" },
			});
			fireEvent.click(screen.getByRole("button", { name: /Add video/ }));
			expect(onPatch.mock.lastCall?.[0].videos[2]).toMatchObject({
				height: 720,
				bitrate: 1_500_000,
			});
			expect(onPatch.mock.lastCall?.[0].videos[2].h265).toBeUndefined();
			fireEvent.change(screen.getByLabelText("Audio settings to reuse"), {
				target: { value: "" },
			});
			fireEvent.click(screen.getByRole("button", { name: /Add audio/ }));
			expect(onPatch.mock.lastCall?.[0].audios[2]).toMatchObject({
				bitrate: 128_000,
				rate: 48_000,
			});
			expect(
				onPatch.mock.lastCall?.[0].audios[2].channelLayout,
			).toBeUndefined();
		});
		it(`${kind} adds defaults when there is no rendition to copy`, () => {
			const onPatch = vi.fn();
			if (kind === "VOD")
				renderWithQuery(
					<LadderSection
						state={{ ...vodState(), videos: [], audios: [] }}
						credentials={[]}
						onPatch={onPatch}
					/>,
				);
			else
				renderWithQuery(
					<LiveLadderSection
						state={{ ...liveState(), videos: [], audios: [] }}
						onPatch={onPatch}
					/>,
				);
			expect(screen.queryByLabelText("Video settings to reuse")).toBeNull();
			fireEvent.click(screen.getByRole("button", { name: /Add video/ }));
			expect(onPatch.mock.lastCall?.[0].videos[0]).toMatchObject({
				height: 720,
				bitrate: 1_500_000,
			});
			fireEvent.click(screen.getByRole("button", { name: /Add audio/ }));
			expect(onPatch.mock.lastCall?.[0].audios[0]).toMatchObject({
				bitrate: 128_000,
				rate: 48_000,
			});
		});
	}
	it("does not offer privileged HEVCv2 as a copy source without main-user access", () => {
		const state = vodState();
		state.videos = [{ codec: "H265V2", height: 720, bitrate: 1_500_000 }];
		const onPatch = vi.fn();
		renderWithQuery(
			<LadderSection state={state} credentials={[]} onPatch={onPatch} />,
		);
		expect(screen.queryByLabelText("Video settings to reuse")).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: /Add video/ }));
		expect(onPatch.mock.lastCall?.[0].videos[1].codec).not.toBe("H265V2");
	});
});

describe("VOD copy delivery identity", () => {
	it("keeps the reference video key as the base for repeated copies", () => {
		const initial = validState();
		initial.videos = [{ height: 1080, bitrate: 4_000_000 }];
		const original = buildPlan(initial);
		let state = initial;
		for (let n = 0; n < 3; n++) state = { ...state, ...addVodVideo(state, 0) };
		expect(videoKeys(state.videos)).toEqual([
			"v1080",
			"v1080-2",
			"v1080-3",
			"v1080-4",
		]);
		const plan = buildPlan(state);
		expect(plan.renditions[0]).toEqual(original.renditions[0]);
		expect(plan.muxings[0]).toEqual(original.muxings[0]);
		expect(
			plan.muxings.slice(1, 4).map((muxing) => muxing.destination?.path),
		).toEqual([
			"copy-test/video/v1080-2",
			"copy-test/video/v1080-3",
			"copy-test/video/v1080-4",
		]);
	});
	it("derives copied keys from explicit names while avoiding sibling resource keys", () => {
		const state = validState();
		state.videos = [
			{
				height: 1080,
				bitrate: 4_000_000,
				extras: { key: "customer-main" },
				extraMuxings: [{ key: "customer-main-2", kind: "MP4" }],
			},
		];
		state.audios = [
			{ bitrate: 128_000, rate: 48000, extras: { key: "customer-main-3" } },
		];
		state.filters = [
			{
				key: "customer-main-4",
				kind: "CROP",
				top: 0,
				bottom: 0,
				left: 0,
				right: 0,
			},
		];
		const patch = addVodVideo(state, 0);
		expect(videoKeys(patch.videos)).toEqual([
			"customer-main",
			"customer-main-5",
		]);
		expect(patch.videos[1]?.extraMuxings?.[0]?.key).toBe(
			"customer-main-5-mux2",
		);
		expect(state.videos[0]?.extras?.key).toBe("customer-main");
	});
	it("keeps the reference audio key as the base for copies", () => {
		const state = validState();
		state.audios = [{ bitrate: 128_000, rate: 48000 }];
		const first = { ...state, ...addVodAudio(state, 0) };
		const second = { ...first, ...addVodAudio(first, 0) };
		expect(audioKeys(second.audios)).toEqual(["a128", "a128-2", "a128-3"]);
	});
	it("the real wizard keeps automatically bundled audio suppressed after copying its video", async () => {
		const state = validState();
		state.accountId = "00000000-0000-4000-8000-000000000004";
		state.output.basePath = "";
		state.videos = [
			{ height: 720, bitrate: 1_500_000, muxing: { kind: "TS" } },
		];
		state.audios = [{ bitrate: 128_000, rate: 48000 }];
		const reconcile = vi.spyOn(
			automaticPackaging,
			"reconcileAutomaticAudioPackaging",
		);
		try {
			renderWithQuery(
				<VodWizard
					copiedJob={{ id: "copy-bundled", plan: buildPlan(state) }}
				/>,
			);
			await screen.findByText(/Settings copied\. Review/);
			const nav = screen.getByRole("navigation", { name: /wizard steps/i });
			fireEvent.click(within(nav).getByRole("button", { name: /Packaging/i }));
			fireEvent.change(
				await screen.findByRole("combobox", { name: "Muxed-in audio" }),
				{ target: { value: "a128" } },
			);
			await waitFor(() =>
				expect(reconcile.mock.lastCall?.[0].audios[0]?.muxing).toMatchObject({
					ownContainer: false,
					autoOwnContainer: true,
				}),
			);
			fireEvent.click(within(nav).getByRole("button", { name: /Ladder/i }));
			fireEvent.click(screen.getByRole("button", { name: /Add video/ }));
			const next = reconcile.mock.lastCall?.[0];
			expect(next?.videos).toHaveLength(2);
			expect(reconcile.mock.results.at(-1)?.value[0]?.muxing).toMatchObject({
				ownContainer: false,
				autoOwnContainer: true,
			});
			expect(next?.audios[0]?.muxing?.path).toBeUndefined();
			if (!next) throw new Error("Wizard patch was not reconciled");
			expect(
				buildPlan(next).muxings.some((muxing) => muxing.streamKey === "a128"),
			).toBe(false);
			expect(next.videos.map((video) => video.muxing?.muxedAudioKeys)).toEqual([
				["a128"],
				["a128"],
			]);
		} finally {
			reconcile.mockRestore();
		}
	});
	it("preserves every existing implicit extra-leg destination when pinning same-height keys", () => {
		const state = validState();
		state.videos = [
			{
				height: 720,
				bitrate: 1_500_000,
				extraMuxings: [{ key: "extra1", kind: "TS" }],
			},
			{
				height: 720,
				bitrate: 2_000_000,
				extraMuxings: [{ key: "extra2", kind: "TS" }],
			},
		];
		const before = buildPlan(state);
		const after = buildPlan({ ...state, ...addVodVideo(state, 0) });
		for (const muxing of before.muxings)
			expect(
				after.muxings.find((candidate) => candidate.key === muxing.key),
			).toEqual(muxing);
		expect(
			validatePlan(encodingPlanSchema.parse(after)).filter(
				(issue) => issue.level === "error",
			),
		).toEqual([]);
	});
	it.each([
		"clear",
		"implicit",
		"encrypted",
	] as const)("keeps Per-Title placeholders in all copied %s primary/extra/DRM destinations", (delivery) => {
		const state = validState();
		state.timing = "POST_ENCODING";
		state.startOptions = { perTitle: { h264: { autoRepresentations: true } } };
		state.videos = [
			{
				height: 720,
				bitrate: null,
				extras: { mode: "PER_TITLE_TEMPLATE" },
				muxing:
					delivery === "clear"
						? { path: "video/{height}p_{bitrate}_{uuid}" }
						: undefined,
				extraMuxings: [
					{
						key: "alternate",
						kind: delivery === "encrypted" ? "FMP4" : "TS",
						...(delivery === "clear"
							? { path: "alternate/{height}_{uuid}" }
							: {}),
					},
				],
			},
		];
		if (delivery === "encrypted")
			state.drm = [
				{
					kind: "CENC",
					muxingKey: "v720",
					credentialId: "00000000-0000-4000-8000-000000000003",
					kid: "0123456789abcdef0123456789abcdef",
					path: "protected/{height}p_{bitrate}_{uuid}",
				},
				{
					kind: "CENC",
					muxingKey: "alternate",
					credentialId: "00000000-0000-4000-8000-000000000003",
					kid: "0123456789abcdef0123456789abcdef",
					path: "protected-extra/{height}_{uuid}",
				},
			];
		const before = buildPlan(state);
		expect(
			validatePlan(encodingPlanSchema.parse(before)).filter(
				(issue) => issue.level === "error",
			),
		).toEqual([]);
		const patch = addVodVideo(state, 0);
		const after = buildPlan({ ...state, ...patch });
		const copyKey = videoKeys(patch.videos).at(-1);
		const destinations =
			delivery !== "encrypted"
				? after.muxings
						.filter((muxing) => muxing.streamKey === copyKey)
						.map((muxing) => muxing.destination?.path)
				: after.drm?.slice(2).map((drm) => drm.destination.path);
		for (const path of destinations ?? []) expect(path).toContain("{uuid}");
		expect(destinations?.[0]).toContain("{bitrate}");
		expect(destinations?.[1]).toContain("{height}");
		const renamed = buildPlan({
			...state,
			...patch,
			...updateVodVideoHeight({ ...state, ...patch }, 1, 900),
		});
		const renamedPaths =
			delivery === "encrypted"
				? renamed.drm?.slice(2).map((row) => row.destination.path)
				: renamed.muxings
						.filter((row) => row.streamKey === "v900")
						.map((row) => row.destination?.path);
		expect(renamedPaths).toHaveLength(2);
		for (const path of renamedPaths ?? []) {
			expect(path).toContain("video/v900/");
			expect(path).toContain("{height}");
			expect(path).toContain("{uuid}");
		}
		expect(renamedPaths?.[0]).toContain("{bitrate}");
		if (delivery === "encrypted")
			for (const row of renamed.muxings.filter(
				(row) => row.streamKey === "v900",
			))
				expect(row.destination).toBeUndefined();
		expect(JSON.stringify(renamed)).not.toContain("autoPath");
		expect(renamed.muxings.slice(0, 2)).toEqual(before.muxings.slice(0, 2));
		expect(renamed.drm?.slice(0, 2)).toEqual(before.drm?.slice(0, 2));
		expect(
			validatePlan(encodingPlanSchema.parse(renamed)).filter(
				(issue) => issue.level === "error",
			),
		).toEqual([]);
	});
	it("copies DRM on video primary/extra legs and audio without creating unintended clear outputs", () => {
		const initial = structuredClone(DEFAULT_WIZARD_STATE);
		initial.videos = [
			{
				height: 720,
				bitrate: 1_500_000,
				extraMuxings: [{ key: "archive-mux", kind: "FMP4" }],
			},
			{ height: 720, bitrate: 2_000_000 },
		];
		initial.audios = [{ bitrate: 128_000, rate: 48000 }];
		const sourceKey = videoKeys(initial.videos)[0] as string;
		initial.drm = [
			{
				kind: "CENC",
				muxingKey: sourceKey,
				credentialId: "vault-cenc",
				kid: "kid",
				encryptionMode: "CBC",
				widevinePssh: "pssh",
			},
			{
				kind: "SPEKE",
				key: "archive-drm",
				muxingKey: "archive-mux",
				credentialId: "vault-speke",
				systemIds: ["widevine", "playready"],
				contentId: "asset",
			},
			{
				kind: "FAIRPLAY",
				muxingKey: "a128",
				credentialId: "vault-fairplay",
				iv: "iv",
				uri: "skd://asset",
				path: "protected/audio",
			},
		];
		const before = buildPlan(initial);
		let state = { ...initial, ...addVodVideo(initial, 0) };
		state = { ...state, ...addVodAudio(state, 0) };
		expect(state.drm).toHaveLength(6);
		const plan = buildPlan(state);
		for (const drm of before.drm ?? [])
			expect(plan.drm?.find((candidate) => candidate.key === drm.key)).toEqual(
				drm,
			);
		const copied = state.drm?.slice(3);
		expect(copied?.map((drm) => drm.kind)).toEqual([
			"CENC",
			"SPEKE",
			"FAIRPLAY",
		]);
		expect(copied?.map((drm) => drm.credentialId)).toEqual([
			"vault-cenc",
			"vault-speke",
			"vault-fairplay",
		]);
		expect(copied?.[0]).toMatchObject({
			kid: "kid",
			encryptionMode: "CBC",
			widevinePssh: "pssh",
		});
		expect(copied?.[1]).toMatchObject({
			systemIds: ["widevine", "playready"],
			contentId: "asset",
		});
		expect(copied?.[2]).toMatchObject({ iv: "iv", uri: "skd://asset" });
		for (const drm of copied ?? []) {
			expect(
				plan.muxings.find((muxing) => muxing.key === drm.muxingKey)
					?.destination,
			).toBeUndefined();
			expect(
				plan.drm?.find((candidate) => candidate.key === drm.key)?.destination,
			).toBeDefined();
		}
		expect(new Set(plan.drm?.map((drm) => drm.key)).size).toBe(6);
		expect(new Set(plan.drm?.map((drm) => drm.destination.path)).size).toBe(6);
		const speke = copied?.[1];
		if (speke?.kind === "SPEKE") speke.systemIds.push("changed");
		expect(initial.drm[1]).toMatchObject({
			systemIds: ["widevine", "playready"],
		});
		expect(initial.drm[0]?.path).toBeUndefined();
	});
	it("keeps original derived identities/paths and allocates unique keys/paths for repeated copies and all legs", () => {
		const initial = structuredClone(DEFAULT_WIZARD_STATE);
		initial.videos = [
			{ height: 720, bitrate: 1_500_000 },
			{
				height: 720,
				bitrate: 2_000_000,
				muxing: {
					key: "v1",
					path: "video/v2",
					kind: "TS",
					muxedAudioKeys: ["a128"],
				},
				extraMuxings: [
					{ key: "v3", path: "video/v4", kind: "MP4", filename: "archive.mp4" },
				],
			},
		];
		initial.audios = [{ bitrate: 128_000, rate: 48000 }];
		const before = buildPlan(initial);
		let state = initial;
		for (let n = 0; n < 3; n++) {
			state = { ...state, ...addVodVideo(state, 1) };
			state = { ...state, ...addVodAudio(state, 0) };
		}
		const after = buildPlan(state);
		expect(after.renditions.slice(0, 2)).toEqual(before.renditions.slice(0, 2));
		for (const muxing of before.muxings)
			expect(
				after.muxings.find((candidate) => candidate.key === muxing.key),
			).toEqual(muxing);
		const keys = [...videoKeys(state.videos), ...audioKeys(state.audios)];
		expect(new Set(keys).size).toBe(keys.length);
		expect(new Set(after.muxings.map((muxing) => muxing.key)).size).toBe(
			after.muxings.length,
		);
		const paths = after.muxings.map((muxing) => muxing.destination?.path);
		expect(new Set(paths).size).toBe(paths.length);
		expect(initial.videos[0]?.extras).toBeUndefined();
	});
	it("copies custom audio media metadata with a unique playlist and one group default", () => {
		const state = structuredClone(DEFAULT_WIZARD_STATE);
		state.audios = [
			{
				bitrate: 128_000,
				rate: 48000,
				extras: {
					hlsMedia: {
						groupId: "english",
						name: "English",
						uri: "audio/main.m3u8",
						isDefault: true,
						autoselect: true,
					},
				},
			},
		];
		state.subtitles = [{ source: "captions", uri: "audio/main-a128-2.m3u8" }];
		const patch = addVodAudio(state, 0);
		expect(patch.audios[0]?.extras?.hlsMedia).toEqual(
			state.audios[0]?.extras?.hlsMedia,
		);
		expect(patch.audios[1]?.extras?.hlsMedia).toMatchObject({
			groupId: "english",
			name: "English",
			autoselect: true,
			isDefault: false,
		});
		expect(patch.audios[1]?.extras?.hlsMedia?.uri).toBe(
			"audio/main-a128-2-2.m3u8",
		);
	});
});
