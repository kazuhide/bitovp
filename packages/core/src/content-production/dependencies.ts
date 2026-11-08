import { z } from "zod";
import {
	compositionSourceSegmentSchema,
	compositionTrackingFallbackSchema,
	compositionTrackingObservationSchema,
} from "../content-editing/composition-evidence";
import { cfrTimeMapSchema } from "../content-editing/schema";
import { originalTimeToCfrFrame } from "../content-editing/time";
import { hashEditingEvidence } from "../content-editing/verify-automatic-binding";
import { sceneAnalysisDocumentSchema } from "../content-library/analysis";
import { mediaTaskCacheKey, mediaTaskIntentHash } from "./identity";
import {
	LOCAL_ASR_ENGINE_VERSION,
	LOCAL_TRACKING_ALGORITHM_VERSION,
	LOCAL_TRACKING_FRAME_CLOCK_VERSION,
	type MediaTaskEnvelope,
	mediaTaskEnvelopeSchema,
	usesGeneratedCaptions,
} from "./schema";
import {
	transcriptionRawSegmentSchema,
	transcriptionSpeechIntervalSchema,
} from "./transcription-quality";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const transcriptResultSchema = z
	.strictObject({
		schemaVersion: z.literal(1),
		engine: z.literal("whisper.cpp"),
		engineVersion: z.literal(LOCAL_ASR_ENGINE_VERSION),
		modelSha256: hash,
		mediaSha256: hash,
		language: z.string().regex(/^[a-z]{2,3}$/),
		segments: z.array(compositionSourceSegmentSchema).max(5000),
		warnings: z.array(z.string().min(1).max(128)).max(100),
		cacheKey: hash,
		sourceTimeDomain: z.literal("ORIGINAL_PRESENTATION_US"),
		qualityPolicyFingerprint: hash.optional(),
		rawSegments: z.array(transcriptionRawSegmentSchema).max(10000).optional(),
		speechIntervals: z
			.array(transcriptionSpeechIntervalSchema)
			.max(10000)
			.optional(),
	})
	.refine(
		(v) =>
			(v.qualityPolicyFingerprint !== undefined) ===
				(v.rawSegments !== undefined) &&
			(v.qualityPolicyFingerprint !== undefined) ===
				(v.speechIntervals !== undefined),
	);
const trackingResultSchema = z.strictObject({
	schemaVersion: z.literal(1),
	algorithm: z.literal(LOCAL_TRACKING_ALGORITHM_VERSION),
	frameClockVersion: z.literal(LOCAL_TRACKING_FRAME_CLOCK_VERSION),
	mediaSha256: hash,
	cacheKey: hash,
	sampleFps: z.literal(3),
	observations: z.array(compositionTrackingObservationSchema).max(5000),
	fallbacks: z.array(compositionTrackingFallbackSchema).max(5000),
	bindingKind: z.enum([
		"CAPTURED_INPUT",
		"FIXTURE_AUTHORED",
		"EDITOR_ATTESTED",
	]),
	sourceTimeDomain: z.literal("ORIGINAL_PRESENTATION_US"),
});
const dependencyRowSchema = z.object({
	id: z.uuid(),
	organizationId: z.uuid(),
	mediaVersionId: z.uuid(),
	analysisRevisionId: z.uuid().nullable(),
	kind: z.enum(["TRANSCRIBE", "TRACK"]),
	state: z.literal("SUCCEEDED"),
	requestKey: z.uuid(),
	requestHash: hash,
	cacheKey: hash,
	parentTaskId: z.uuid().nullable(),
	parameters: mediaTaskEnvelopeSchema,
	result: z.unknown(),
});
export class MediaTaskDependencyError extends Error {
	constructor(
		readonly code:
			| "TASK_DEPENDENCY_INVALID"
			| "TASK_RESULT_UNVERIFIED"
			| "TASK_DEPENDENCY_WINDOW_INCOMPLETE",
	) {
		super(code);
		this.name = "MediaTaskDependencyError";
	}
}
const invalid = () => {
	throw new MediaTaskDependencyError("TASK_DEPENDENCY_INVALID");
};
const invalidResult = () => {
	throw new MediaTaskDependencyError("TASK_RESULT_UNVERIFIED");
};
const incomplete = () => {
	throw new MediaTaskDependencyError("TASK_DEPENDENCY_WINDOW_INCOMPLETE");
};
const frameUs = (frame: bigint) => Number((frame * 1_000_000n + 29n) / 30n);

export type DependencySourceClip = {
	sceneId: string;
	shotIndex?: number;
	sourceInUs: number;
	durationFrames: number;
};
type Input = {
	row: unknown;
	kind: "TRANSCRIBE" | "TRACK";
	current: MediaTaskEnvelope;
	timeMap: unknown;
	analysisDocument?: unknown;
	requiredClips?: readonly DependencySourceClip[];
	requiredTranscriptWindow?: { fromFrame: number; toFrame: number };
};

/** Match the raw-second rule of cfr30-source-frames-v1 without an integer-us round trip. */
function rawFrame(
	seconds: number,
	originUs: number,
	rounding: "CEIL" | "FLOOR",
) {
	const origin = originUs / 1_000_000,
		frame = (seconds - origin) * 30,
		nearest = Math.round(frame),
		error =
			4 *
			Number.EPSILON *
			Math.max(1, Math.abs(seconds * 30), Math.abs(origin * 30));
	const result =
		Math.abs(frame - nearest) <= error
			? nearest
			: rounding === "CEIL"
				? Math.ceil(frame)
				: Math.floor(frame);
	if (!Number.isSafeInteger(result)) invalid();
	return result;
}

/** An explicit task ID never bypasses the identities required by a fresh inference. */
export function verifyMediaTaskDependency(input: Input) {
	const parsed = dependencyRowSchema.safeParse(input.row),
		current = mediaTaskEnvelopeSchema.safeParse(input.current),
		mapResult = cfrTimeMapSchema.safeParse(input.timeMap);
	if (!parsed.success || !current.success || !mapResult.success)
		return invalid();
	const row = parsed.data,
		envelope = row.parameters,
		previous = envelope.input,
		identity = envelope.identity,
		currentIdentity = current.data.identity,
		map = mapResult.data,
		request = current.data.input;
	const transcriptWindow = input.requiredTranscriptWindow;
	if (
		transcriptWindow &&
		(input.kind !== "TRANSCRIBE" ||
			!Number.isSafeInteger(transcriptWindow.fromFrame) ||
			!Number.isSafeInteger(transcriptWindow.toFrame) ||
			transcriptWindow.fromFrame < 0 ||
			transcriptWindow.toFrame <= transcriptWindow.fromFrame ||
			transcriptWindow.toFrame > map.editingEndFrame - map.editingStartFrame ||
			transcriptWindow.toFrame - transcriptWindow.fromFrame > 5400)
	)
		return invalid();
	if (
		request.kind !== "GENERATE" ||
		previous.kind !== input.kind ||
		row.kind !== input.kind ||
		row.organizationId !== currentIdentity.organizationId ||
		identity.organizationId !== row.organizationId ||
		row.mediaVersionId !== request.mediaVersionId ||
		previous.mediaVersionId !== row.mediaVersionId ||
		map.mediaVersionId !== request.mediaVersionId ||
		row.requestKey !== previous.requestKey ||
		row.requestHash !== mediaTaskIntentHash(previous, row.parentTaskId) ||
		row.cacheKey !== mediaTaskCacheKey(previous, identity) ||
		!currentIdentity.mediaSha256 ||
		identity.mediaSha256 !== currentIdentity.mediaSha256 ||
		identity.timeMapHash !== hashEditingEvidence(map) ||
		currentIdentity.timeMapHash !== identity.timeMapHash
	)
		return invalid();
	const requiredWindows = (input.requiredClips ?? []).map((clip) => {
		if (!Number.isSafeInteger(clip.durationFrames) || clip.durationFrames < 1)
			return invalid();
		const from = originalTimeToCfrFrame(
				clip.sourceInUs,
				map.sourceStartUs,
				"FLOOR",
			),
			to = from + BigInt(clip.durationFrames);
		if (from < 0n || to > BigInt(map.editingEndFrame - map.editingStartFrame))
			return invalid();
		return { clip, from, to };
	});
	if (previous.kind === "TRANSCRIBE") {
		if (
			!usesGeneratedCaptions(request.parameters.captions) ||
			row.analysisRevisionId !== null ||
			!currentIdentity.modelSha256 ||
			identity.modelSha256 !== currentIdentity.modelSha256 ||
			identity.transcriptionPolicyFingerprint !==
				currentIdentity.transcriptionPolicyFingerprint ||
			identity.analysisDocumentHash !== null ||
			identity.analysisRawHash !== null ||
			identity.bindingHash != null ||
			identity.bindingSnapshot !== undefined ||
			previous.parameters.language !== request.parameters.language
		)
			return invalid();
		const result = transcriptResultSchema.safeParse(row.result);
		if (
			!result.success ||
			result.data.mediaSha256 !== identity.mediaSha256 ||
			result.data.modelSha256 !== identity.modelSha256 ||
			result.data.qualityPolicyFingerprint !==
				identity.transcriptionPolicyFingerprint ||
			(previous.parameters.language !== "auto" &&
				result.data.language !== previous.parameters.language)
		)
			return invalidResult();
		const fromUs = map.sourceStartUs + previous.parameters.sourceStartUs,
			available = map.sourceEndUs - fromUs,
			durationUs =
				previous.parameters.durationUs ?? Math.min(180_000_000, available),
			toUs = fromUs + durationUs;
		if (
			!Number.isSafeInteger(fromUs) ||
			!Number.isSafeInteger(toUs) ||
			durationUs < 1 ||
			toUs > map.sourceEndUs
		)
			return invalid();
		for (const raw of result.data.rawSegments ?? [])
			if (
				raw.startUs < fromUs ||
				raw.startUs >= toUs ||
				raw.endUs - toUs >= 1_000_000
			)
				return invalidResult();
		let priorSpeechEnd = fromUs;
		for (const interval of result.data.speechIntervals ?? []) {
			if (interval.startUs < priorSpeechEnd || interval.endUs > toUs)
				return invalidResult();
			priorSpeechEnd = interval.endUs;
		}
		let end = fromUs;
		for (const segment of result.data.segments) {
			if (segment.startUs < end || segment.endUs > toUs) return invalidResult();
			end = segment.endUs;
		}
		const transcriptWindows = transcriptWindow
			? [
					...requiredWindows,
					{
						from: BigInt(transcriptWindow.fromFrame),
						to: BigInt(transcriptWindow.toFrame),
					},
				]
			: requiredWindows;
		for (const window of transcriptWindows)
			if (
				map.sourceStartUs + frameUs(window.from) < fromUs ||
				map.sourceStartUs + frameUs(window.to) > toUs
			)
				return incomplete();
		return { kind: "TRANSCRIBE" as const, envelope, result: result.data };
	}
	// Standalone TRACK still produces the raw v1 clock. A V3 generation must
	// use fresh inline tracking, not reinterpret those saved observations.
	if (
		previous.kind !== "TRACK" ||
		currentIdentity.preparedShotClock !== undefined ||
		!request.parameters.tracking ||
		row.analysisRevisionId !== request.analysisRevisionId ||
		previous.analysisRevisionId !== request.analysisRevisionId ||
		identity.analysisDocumentHash !== currentIdentity.analysisDocumentHash ||
		identity.analysisRawHash !== currentIdentity.analysisRawHash ||
		!currentIdentity.bindingHash ||
		identity.bindingHash !== currentIdentity.bindingHash ||
		!identity.bindingSnapshot ||
		hashEditingEvidence(identity.bindingSnapshot) !== identity.bindingHash ||
		identity.modelSha256 !== null ||
		identity.trackingAlgorithmVersion !== LOCAL_TRACKING_ALGORITHM_VERSION ||
		identity.trackingAlgorithmVersion !==
			currentIdentity.trackingAlgorithmVersion ||
		identity.trackingFrameClockVersion !== LOCAL_TRACKING_FRAME_CLOCK_VERSION ||
		identity.trackingFrameClockVersion !==
			currentIdentity.trackingFrameClockVersion
	)
		return invalid();
	const result = trackingResultSchema.safeParse(row.result),
		analysis = sceneAnalysisDocumentSchema.safeParse(input.analysisDocument);
	if (
		!result.success ||
		result.data.mediaSha256 !== identity.mediaSha256 ||
		result.data.bindingKind !== identity.bindingSnapshot.kind
	)
		return invalidResult();
	if (
		!analysis.success ||
		hashEditingEvidence(analysis.data) !== currentIdentity.analysisDocumentHash
	)
		return invalid();
	const selected = previous.parameters.sceneIds
		? new Set(previous.parameters.sceneIds)
		: null;
	if (
		selected &&
		[...selected].some(
			(id) => !analysis.data.scenes.some((scene) => scene.id === id),
		)
	)
		return invalid();
	const ranges = new Map<string, { from: number; to: number }>();
	for (const scene of analysis.data.scenes) {
		if (selected && !selected.has(scene.id)) continue;
		for (const [index, shot] of scene.shots.entries()) {
			// The standalone TRACK producer rejects partial source shots before CFR conversion.
			if (
				Math.round(shot.startInSeconds * 1_000_000) < map.sourceStartUs ||
				Math.round(shot.endInSeconds * 1_000_000) > map.sourceEndUs
			)
				continue;
			const from = rawFrame(shot.startInSeconds, map.sourceStartUs, "CEIL"),
				to = rawFrame(shot.endInSeconds, map.sourceStartUs, "FLOOR");
			if (from < 0 || to <= from) continue;
			ranges.set(`${scene.id}:${index}`, { from, to });
		}
	}
	for (const point of result.data.observations) {
		const range = ranges.get(`${point.sceneId}:${point.shotIndex}`);
		if (
			!range ||
			point.sourceTimeUs < map.sourceStartUs + frameUs(BigInt(range.from)) ||
			point.sourceTimeUs >= map.sourceStartUs + frameUs(BigInt(range.to))
		)
			return invalidResult();
	}
	for (const fallback of result.data.fallbacks) {
		const range = ranges.get(`${fallback.sceneId}:${fallback.shotIndex}`);
		if (
			!range ||
			fallback.fromUs < map.sourceStartUs + frameUs(BigInt(range.from)) ||
			fallback.toUs > map.sourceStartUs + frameUs(BigInt(range.to))
		)
			return invalidResult();
	}
	for (const window of requiredWindows) {
		const range = ranges.get(`${window.clip.sceneId}:${window.clip.shotIndex}`);
		if (
			!range ||
			window.from < BigInt(range.from) ||
			window.to > BigInt(range.to)
		)
			return incomplete();
	}
	return { kind: "TRACK" as const, envelope, result: result.data };
}
