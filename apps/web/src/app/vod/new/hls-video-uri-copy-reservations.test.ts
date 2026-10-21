import { encodingPlanSchema, validatePlan } from "@bitovp/core";
import { describe, expect, it } from "vitest";
import {
	buildPlan,
	DEFAULT_WIZARD_STATE,
	type WizardState,
} from "./build-plan";
import { addVodVideo } from "./rendition-copy";

function validState(): WizardState {
	const state = structuredClone(DEFAULT_WIZARD_STATE);
	state.name = "Playlist copy reservation";
	state.accountId = "00000000-0000-4000-8000-000000000001";
	state.inputFiles = [
		{
			key: "main",
			inputKey: "main",
			kind: "S3",
			credentialId: "00000000-0000-4000-8000-000000000002",
			bucket: "synthetic-input",
			path: "video.mp4",
		},
	];
	state.output = {
		...state.output,
		credentialId: "00000000-0000-4000-8000-000000000002",
		bucket: "synthetic-output",
		basePath: "output",
	};
	state.videos = [
		{
			height: 360,
			bitrate: 300000,
			extras: { key: "v360", hlsVariantUri: "main-video.m3u8" },
		},
	];
	state.manifests = { hls: true, dash: false };
	return state;
}

function errors(state: WizardState) {
	return validatePlan(encodingPlanSchema.parse(buildPlan(state))).filter(
		(issue) => issue.level === "error",
	);
}

describe("copied video playlist filenames", () => {
	it.each([
		"primary",
		"additional",
	] as const)("reserves the %s HLS manifest's default audio playlist", (target) => {
		const state = validState();
		const audioUri = "video-v360-2.m3u8";
		state.manifests =
			target === "primary"
				? { hls: true, dash: false, hlsOptions: { audioMediaUri: audioUri } }
				: {
						hls: false,
						dash: false,
						extra: [
							{
								kind: "HLS",
								key: "alternate",
								manifestName: "alternate.m3u8",
								hls: { audioMediaUri: audioUri },
							},
						],
					};
		expect(errors(state)).toEqual([]);
		Object.assign(state, addVodVideo(state, 0));
		expect(state.videos[1]?.extras?.hlsVariantUri).not.toBe(audioUri);
		expect(errors(state)).toEqual([]);
	});

	it.each([
		"DASH master",
		"SMOOTH server",
		"SMOOTH client",
		"FMP4 initialization",
		"CMAF initialization",
		"CMAF segment",
		"MP4 file",
		"DRM initialization",
		"audio CMAF initialization",
	] as const)("keeps a valid plan valid when a %s owns the next copy filename", (target) => {
		const state = validState();
		const filename = "video-v360-2.m3u8";
		const source = state.videos[0];
		if (!source) throw new Error("Missing source video fixture");
		if (target === "DASH master")
			state.manifests.extra = [
				{ kind: "DASH", key: "alternate", manifestName: filename },
			];
		else if (
			target === "SMOOTH server" ||
			target === "SMOOTH client" ||
			target === "MP4 file"
		) {
			state.manifests.hlsOptions = { videoMuxingKind: "FMP4" };
			source.extraMuxings = [
				{
					key: "mp4",
					kind: "MP4",
					path: "",
					manifestType: target === "MP4 file" ? "HLS_BYTE_RANGES" : "SMOOTH",
					filename: target === "MP4 file" ? filename : "archive.ismv",
				},
			];
			if (target !== "MP4 file")
				state.manifests.extra = [
					{
						kind: "SMOOTH",
						key: "alternate",
						serverManifestName:
							target === "SMOOTH server" ? filename : "alternate.ism",
						clientManifestName:
							target === "SMOOTH client" ? filename : "alternate.ismc",
					},
				];
		} else if (
			target === "CMAF initialization" ||
			target === "CMAF segment" ||
			target === "audio CMAF initialization"
		) {
			const rendition =
				target === "audio CMAF initialization" ? state.audios[0] : source;
			if (!rendition) throw new Error("Missing CMAF source fixture");
			rendition.extraMuxings = [
				{
					key: "cmaf",
					kind: "CMAF",
					path: "",
					initSegmentNameTemplate:
						target === "CMAF segment" ? "init-cmaf.mp4" : filename,
					...(target === "CMAF segment"
						? { segmentNamingTemplate: filename }
						: {}),
				},
			];
		} else if (target === "DRM initialization") {
			state.audios = [];
			source.muxing = { initSegmentName: filename };
			state.drm = [
				{
					kind: "CENC",
					muxingKey: "v360",
					path: "",
					credentialId: "00000000-0000-4000-8000-000000000003",
					kid: "0123456789abcdef0123456789abcdef",
				},
			];
			state.manifests.hlsOptions = { drmKind: "CENC" };
		} else source.muxing = { path: "", initSegmentName: filename };
		expect(errors(state)).toEqual([]);
		Object.assign(state, addVodVideo(state, 0));
		expect(errors(state)).toEqual([]);
		expect(state.videos[1]?.extras?.hlsVariantUri).not.toBe(filename);
	});

	it.each([
		["DASH master", "./video-v360-2.m3u8"],
		["DASH master", "nested/../video-v360-2.m3u8"],
		["DASH master", "video-v360-2.m3u8/nested/.."],
		["FMP4 initialization", "./video-v360-2.m3u8"],
		["FMP4 initialization", "nested/../video-v360-2.m3u8"],
		["FMP4 initialization", "video-v360-2.m3u8/nested/.."],
	])("reserves a normalized %s filename: %s", (target, filename) => {
		const state = validState();
		if (target === "DASH master")
			state.manifests.extra = [
				{ kind: "DASH", key: "alternate", manifestName: filename },
			];
		else {
			const source = state.videos[0];
			if (!source) throw new Error("Missing source video fixture");
			source.muxing = { path: "", initSegmentName: filename };
		}
		expect(errors(state)).toEqual([]);
		Object.assign(state, addVodVideo(state, 0));
		expect(errors(state)).toEqual([]);
		expect(state.videos[1]?.extras?.hlsVariantUri).not.toBe(
			"video-v360-2.m3u8",
		);
	});

	it("reserves static filenames while inputs and credentials are incomplete without mutating the source", () => {
		const state = validState();
		state.name = "";
		state.accountId = "";
		state.inputFiles = [];
		state.output.credentialId = "";
		state.manifests.extra = [
			{ kind: "DASH", key: "alternate", manifestName: "video-v360-2.m3u8" },
		];
		const original = structuredClone(state);
		const patch = addVodVideo(state, 0);
		expect(patch.videos[1]?.extras?.hlsVariantUri).toBe("video-v360-2-2.m3u8");
		expect(state).toEqual(original);
		expect(patch.videos[0]?.extras?.hlsVariantUri).toBe("main-video.m3u8");
	});
});
