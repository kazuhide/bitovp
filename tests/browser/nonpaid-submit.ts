import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { liveChannelPlanSchema } from "../../packages/core/src/live/schema";
import { encodingPlanSchema } from "../../packages/core/src/plan/schema";
import {
	buildPlan,
	DEFAULT_WIZARD_STATE,
} from "../../packages/core/src/wizard/build-plan";

export function nonpaidVodPlan(accountId: string, credentialId: string) {
	return encodingPlanSchema.parse(
		buildPlan({
			...structuredClone(DEFAULT_WIZARD_STATE),
			name: "Nonpaid VOD import",
			accountId,
			inputFiles: [
				{
					key: "main",
					inputKey: "main",
					kind: "S3",
					credentialId,
					bucket: "synthetic-input",
					path: "bbb-10s.mp4",
				},
			],
			output: {
				...DEFAULT_WIZARD_STATE.output,
				credentialId,
				bucket: "synthetic-output",
				basePath: "nonpaid/vod",
				publicRead: false,
				explicitPrivateAcl: true,
			},
			additionalOutputs: [
				{
					kind: "S3",
					credentialId,
					bucket: "synthetic-mirror",
					name: "Synthetic mirror",
				},
			],
			videos: [
				{
					height: 720,
					bitrate: 1_500_000,
					h264: {
						profile: "HIGH",
						level: "4.1",
						minGop: 0,
						openGop: false,
						cabac: false,
						colorConfig: { copyColorSpaceFlag: false },
					},
					extras: { hlsVariantUri: "main-video.m3u8" },
				},
			],
			audios: [{ bitrate: 128_000, rate: 48_000 }],
			manifests: {
				hls: true,
				dash: true,
				hlsOptions: { masterVersion: "HLS_V4", mediaVersion: "HLS_V4" },
			},
		}),
	);
}

export function nonpaidLivePlan(accountId: string, credentialId: string) {
	const plan = liveChannelPlanSchema.parse(
		JSON.parse(
			readFileSync(
				join(
					import.meta.dirname,
					"../../packages/core/src/live/__fixtures__/live-rtmp-simple.plan.json",
				),
				"utf8",
			),
		),
	);
	plan.name = "Nonpaid Live import";
	plan.bitmovin.accountId = accountId;
	plan.bitmovin.cloudRegion = "AUTO";
	for (const output of plan.outputs) {
		if (output.kind !== "S3") throw new Error("Expected an S3 output");
		output.credentialId = credentialId;
		output.bucket = "synthetic-output";
	}
	plan.outputs.push({
		key: "mirror-1",
		kind: "S3",
		credentialId,
		bucket: "synthetic-mirror",
		name: "Synthetic mirror",
	});
	plan.deliveryMirrors = [{ outputKey: "mirror-1" }];
	for (const rendition of plan.renditions) {
		if (rendition.codec !== "H264") continue;
		rendition.minGop = 0;
		rendition.level = "4.1";
		rendition.openGop = false;
		rendition.cabac = false;
		rendition.colorConfig = { copyColorSpaceFlag: false };
	}
	const firstVideo = plan.renditions.find((row) => row.codec === "H264");
	if (!firstVideo) throw new Error("Expected an H264 rendition");
	firstVideo.hlsVariantUri = "main-video.m3u8";
	for (const muxing of plan.muxings) {
		if (muxing.kind === "MP4") throw new Error("Expected segmented media");
		muxing.segmentLength = 2;
		if (!muxing.destination) throw new Error("Expected a destination");
		muxing.destination.acl = "PRIVATE";
	}
	for (const manifest of plan.liveManifests) {
		manifest.destination.acl = "PRIVATE";
		manifest.liveEdgeOffset = 0;
		if (manifest.kind === "HLS") manifest.insertProgramDateTime = false;
		else manifest.suggestedPresentationDelay = 0;
	}
	plan.start.autoRestart = {
		segmentsWrittenTimeout: 60,
		restartOnEncoderError: false,
	};
	return liveChannelPlanSchema.parse(plan);
}

export type NonpaidSubmission = {
	id: string;
	requestPlan: unknown;
	savedPlan: unknown;
};

export function writeNonpaidSubmission(
	directory: string,
	kind: "vod" | "live",
	submission: NonpaidSubmission,
) {
	const path = join(directory, "nonpaid-submissions.json");
	const evidence =
		kind === "vod" ? { version: 1 } : JSON.parse(readFileSync(path, "utf8"));
	writeFileSync(path, JSON.stringify({ ...evidence, [kind]: submission }), {
		mode: 0o600,
		flag: kind === "vod" ? "wx" : "w",
	});
}
