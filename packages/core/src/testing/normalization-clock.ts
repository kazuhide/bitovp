import {
	type NormalizationCaptureReceipt,
	normalizationCaptureReceiptSchema,
} from "../content-editing/normalization-evidence";
import { hashEditingEvidence } from "../content-editing/verify-automatic-binding";

/** Explicitly authored test evidence; this never probes media or writes a receipt. */
export function authoredNormalizationReceipt(input: {
	organizationId: string;
	sourceId: string;
	mediaVersionId: string;
	sourceFrameCount?: number;
	width?: number;
	height?: number;
	preparedSha256?: string;
	hasAudio?: boolean;
}): NormalizationCaptureReceipt {
	const frameCount = input.sourceFrameCount ?? 144;
	if (!Number.isSafeInteger(frameCount) || frameCount < 1 || frameCount > 86400)
		throw new RangeError("Expected a bounded authored CFR24 frame count");
	const outputFrameCount = Number((BigInt(frameCount) * 30n) / 24n);
	const sourceEndUs = Number(
		(BigInt(outputFrameCount) * 1_000_000n + 29n) / 30n,
	);
	const source = {
		width: input.width ?? 640,
		height: input.height ?? 360,
		codec: "h264" as const,
		fps: { num: 24, den: 1 },
		timeBase: { num: 1, den: 12288 },
		frameCount,
		durationUs: Number((BigInt(frameCount) * 1_000_000n + 23n) / 24n),
		videoPtsHash: hashEditingEvidence(
			Array.from({ length: frameCount }, (_, frame) => String(frame * 512)),
		),
		colorProfile: "BT709_8BIT_LIMITED" as const,
		audio: input.hasAudio
			? {
					sampleRate: 48000 as const,
					channels: 2 as const,
					sampleCount: frameCount * 2000,
					ptsHash: hashEditingEvidence({
						authoredAudioSamples: frameCount * 2000,
					}),
				}
			: null,
	};
	const sourceFrameIndex = Array.from(
		{ length: outputFrameCount },
		(_, frame) => Number((BigInt(frame) * 24n) / 30n),
	);
	return normalizationCaptureReceiptSchema.parse({
		schemaVersion: 1,
		profile: "SDR_CFR30_INDEXED_V1",
		mode: "NORMALIZE",
		originalSha256: hashEditingEvidence({ authoredFixture: "CFR24", source }),
		preparedSha256: input.preparedSha256 ?? "a".repeat(64),
		originalBytes: 100,
		preparedBytes: 120,
		source,
		output: {
			width: source.width,
			height: source.height,
			frameCount: outputFrameCount,
			durationUs: sourceEndUs,
			fps: { num: 30, den: 1 },
			hasAudio: source.audio !== null,
		},
		sourceStartUs: 0,
		sourceEndUs,
		sourceFrameIndex,
		indexMapHash: hashEditingEvidence(sourceFrameIndex),
		recipeHash: hashEditingEvidence({
			profile: "SDR_CFR30_INDEXED_V1",
			mode: "NORMALIZE",
			source,
			videoFilter: `fps=fps=30:start_time=0:round=up:eof_action=pass,trim=end_frame=${outputFrameCount},setpts=N/(30*TB),setsar=1/1`,
			audioFilter: source.audio
				? `aresample=48000:async=0:first_pts=0,apad=whole_len=${outputFrameCount * 1600},atrim=end_sample=${outputFrameCount * 1600},asetpts=N/SR/TB`
				: null,
		}),
		organizationId: input.organizationId,
		sourceId: input.sourceId,
		mediaVersionId: input.mediaVersionId,
		timeMapId: input.mediaVersionId,
	});
}
