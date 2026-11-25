import { muxingStreamKeys } from "./muxing-streams";
import type { EncodingPlan } from "./schema";
import type { PlanIssue } from "./validate";

type Muxing = EncodingPlan["muxings"][number];
type AudioFileRendition = Extract<
	EncodingPlan["renditions"][number],
	{ codec: "PCM" | "AUDIO_PASSTHROUGH" }
>;

function minimumEncoderMinor(rendition: AudioFileRendition, row: Muxing) {
	if (rendition.codec === "PCM")
		return row.kind === "PROGRESSIVE_WAV" ? 203 : null;
	switch (row.kind) {
		case "PROGRESSIVE_WAV":
			return rendition.sourceCodec === "PCM" ? 202 : null;
		case "PROGRESSIVE_MOV":
			return rendition.sourceCodec === "AAC" ? 201 : 200;
		case "MP4":
			return rendition.sourceCodec === "AAC" &&
				row.fragmentDuration === undefined &&
				!row.manifestType &&
				!row.dolbyVisionConfiguration
				? 200
				: null;
		default:
			return null;
	}
}

export function checkAudioFileOutputs(plan: EncodingPlan): PlanIssue[] {
	const issues: PlanIssue[] = [];
	for (const [i, rendition] of plan.renditions.entries()) {
		if (rendition.codec !== "PCM" && rendition.codec !== "AUDIO_PASSTHROUGH")
			continue;
		const path = `renditions[${i}]`;
		const reject = (message: string) =>
			issues.push({
				code: "PLAN_AUDIO_FILE_OUTPUT",
				level: "error",
				path,
				message,
			});
		const source = plan.ingest.find((row) => row.key === rendition.ingestKey);
		if (source?.selectionMode !== "AUDIO_RELATIVE")
			reject("Select a specific audio track on a source file.");
		if (rendition.codec === "AUDIO_PASSTHROUGH") {
			const origin = plan.inputs.find((row) => row.key === source?.inputKey);
			if (!origin || !("credentialId" in origin && "bucket" in origin))
				reject("Audio copying requires a versioned storage input.");
			if (
				plan.inputs.length !== 1 ||
				plan.renditions.length !== 1 ||
				plan.ingest.length !== 1 ||
				(plan.encodings?.length ?? 1) !== 1 ||
				plan.trimmingStreams.length ||
				plan.concatenationStreams.length ||
				plan.audioMixStreams.length ||
				plan.fileStreams.length ||
				plan.dolbyStreams.length ||
				plan.hdr10PlusStreams.length ||
				plan.filters.length ||
				plan.manifests.length ||
				plan.drm.length ||
				plan.aiSceneAnalysis ||
				plan.inputTimelinePreparation ||
				plan.perTitle ||
				plan.keyframes.length ||
				plan.generation.audioVideoSyncMode ||
				plan.generation.encodingMode ||
				plan.generation.handleVariableInputFps !== undefined ||
				plan.thumbnails.length ||
				plan.sprites.length ||
				plan.qc
			)
				reject(
					"Audio copying requires one unedited source track and file outputs.",
				);
		}
		if (
			rendition.filters?.length ||
			rendition.nexguard ||
			rendition.burnInSrt ||
			rendition.conditions ||
			rendition.hlsMedia ||
			rendition.hlsVariantLabel ||
			rendition.hlsVariantUri ||
			rendition.dashSetKey ||
			plan.kantar ||
			plan.qc?.only
		)
			reject(
				"Audio file renditions require an unconditional file output without stream processing.",
			);
		const rows = plan.muxings.filter((row) =>
			muxingStreamKeys(row).includes(rendition.key),
		);
		if (!rows.length)
			reject("An audio file rendition needs a file destination.");
		const version =
			plan.encodings?.find((row) => row.key === rendition.encodingKey)
				?.encoderVersion ?? plan.bitmovin.encoderVersion;
		const fixed = /^(\d+)\.(\d+)(?:\.\d+)?(?:[-+].*)?$/.exec(version ?? "");
		for (const row of rows) {
			const minor = minimumEncoderMinor(rendition, row);
			if (
				minor === null ||
				muxingStreamKeys(row).length !== 1 ||
				!row.destination ||
				plan.drm.some((d) => d.muxingKey === row.key)
			) {
				reject(
					"Choose an unencrypted, single-track file in a supported container for this audio format.",
				);
				continue;
			}
			if (row.kind === "MP4" && !/^[^/\\?#]+\.(mp4|m4a)$/i.test(row.filename))
				reject(
					"Use an MP4 or M4A filename without directories for the AAC file.",
				);
			if (
				fixed &&
				(Number(fixed[1]) < 2 ||
					(Number(fixed[1]) === 2 && Number(fixed[2]) < minor))
			)
				reject(`This audio file requires Encoder 2.${minor}.0 or newer.`);
		}
	}
	return issues;
}
