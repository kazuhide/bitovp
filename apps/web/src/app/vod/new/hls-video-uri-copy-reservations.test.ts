import { encodingPlanSchema, validatePlan } from "@bitovp/core";
import { describe, expect, it } from "vitest";
import { buildPlan, DEFAULT_WIZARD_STATE } from "./build-plan";
import { addVodVideo } from "./rendition-copy";

describe("copied video playlist filenames", () => {
	it.each([
		"primary",
		"additional",
	] as const)("reserves the %s HLS manifest's default audio playlist", (target) => {
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
				extras: { hlsVariantUri: "main-video.m3u8" },
			},
		];
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
		expect(
			validatePlan(encodingPlanSchema.parse(buildPlan(state))).filter(
				(issue) => issue.level === "error",
			),
		).toEqual([]);
		Object.assign(state, addVodVideo(state, 0));
		expect(state.videos[1]?.extras?.hlsVariantUri).not.toBe(audioUri);
		expect(
			validatePlan(encodingPlanSchema.parse(buildPlan(state))).filter(
				(issue) => issue.level === "error",
			),
		).toEqual([]);
	});
});
