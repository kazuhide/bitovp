import { z } from "zod";
import { transcriptionSpeechIntervalSchema } from "../content-production/transcription-quality";
import {
	COMPOSITION_CAPTION_SELECTION_POLICY,
	compositionCaptionClipSnapshot,
} from "./composition-caption-source";
import {
	type CompiledCompositionClip,
	type CompositionSourceFacts,
	compileComposition,
} from "./composition-frame";
import {
	COMPOSITION_LIMITS,
	type CompositionDocument,
	compositionDocumentSchema,
} from "./composition-schema";
import { suggestFixedCrop } from "./framing";
import { type EditFraming, normalizedCropRectSchema } from "./schema";
import {
	measuredSubtitleCues,
	unmeasuredSubtitleWindows,
} from "./subtitle-cues";
import { originalTimeToCfrFrame } from "./time";
import { hashEditingEvidence } from "./verify-automatic-binding";

const us = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const wordSchema = z.strictObject({
	startUs: us,
	endUs: us,
	text: z.string().min(1).max(16000),
	confidence: z.number().min(0).max(1),
	startChar: us,
	endChar: us,
});
const segmentSchema = z
	.strictObject({
		startUs: us,
		endUs: us,
		text: z.string().min(1).max(16000),
		words: z.array(wordSchema).max(2000).optional(),
	})
	.superRefine((segment, ctx) => {
		if (segment.endUs <= segment.startUs)
			ctx.addIssue({
				code: "custom",
				message: "Expected positive measured segment timing",
			});
		let endTime = segment.startUs;
		let endChar = 0;
		for (const word of segment.words ?? []) {
			if (
				word.startUs < endTime ||
				word.endUs <= word.startUs ||
				word.endUs > segment.endUs ||
				word.startChar < endChar ||
				word.endChar <= word.startChar ||
				segment.text.slice(word.startChar, word.endChar) !== word.text
			)
				ctx.addIssue({
					code: "custom",
					message:
						"Word timing and offsets must be measured, ordered and match segment text",
				});
			endTime = word.endUs;
			endChar = word.endChar;
		}
	});
export type CompositionSourceSegment = z.infer<typeof segmentSchema>;
export const compositionSourceSegmentSchema = segmentSchema;

/** First editing-frame sample at or after an actual original presentation time. */
function firstFrameAt(timeUs: number, source: CompositionSourceFacts) {
	const delta = BigInt(timeUs) - BigInt(source.timeMap.sourceStartUs);
	const product = delta * 30n;
	const relative =
		product >= 0n ? (product + 999999n) / 1000000n : product / 1000000n;
	const frame = Number(relative + BigInt(source.timeMap.editingStartFrame));
	if (!Number.isSafeInteger(frame))
		throw new RangeError("Evidence frame exceeds safe integer domain");
	return frame;
}
function trackedFrameAt(
	timeUs: number,
	source: CompositionSourceFacts,
	end = false,
) {
	const floor = originalTimeToCfrFrame(
		timeUs,
		source.timeMap.sourceStartUs,
		"FLOOR",
	);
	const canonical =
		BigInt(source.timeMap.sourceStartUs) + (floor * 1000000n + 29n) / 30n;
	const relative =
		end && canonical !== BigInt(timeUs)
			? originalTimeToCfrFrame(timeUs, source.timeMap.sourceStartUs, "CEIL")
			: floor;
	const frame = Number(relative + BigInt(source.timeMap.editingStartFrame));
	if (!Number.isSafeInteger(frame))
		throw new RangeError("Tracking frame exceeds safe integer domain");
	return frame;
}

/** Exact original clock scaled by30; CFR boundaries need no microsecond rounding. */
function originalTicksAtFrame(source: CompositionSourceFacts, frame: number) {
	return (
		BigInt(source.timeMap.sourceStartUs) * 30n +
		(BigInt(frame) - BigInt(source.timeMap.editingStartFrame)) * 1_000_000n
	);
}

/** Do not display a whole unmeasured utterance from a tiny selected boundary.
 * Compare source-clock intervals before CFR rounding; one output frame alone
 * cannot distinguish a complete short utterance from a long utterance's tail.
 */
function isUnmeasuredBoundarySpill(
	segment: CompositionSourceSegment,
	source: CompositionSourceFacts,
	runFromFrame: number,
	runToFrame: number,
	outputFrames: number,
) {
	const maxFrames =
		COMPOSITION_CAPTION_SELECTION_POLICY.unmeasuredBoundarySpillMaxFrames;
	if (segment.words?.length || outputFrames > maxFrames) return false;
	// A frame is exactly 1,000,000/30 microseconds. Scaled original timestamps
	// retain fractional frame boundaries and both nonzero time-map origins.
	const maxSourceTicks = BigInt(maxFrames) * 1_000_000n;
	const start = BigInt(segment.startUs) * 30n;
	const end = BigInt(segment.endUs) * 30n;
	if (end - start <= maxSourceTicks) return false;
	const runStart = originalTicksAtFrame(source, runFromFrame);
	const runEnd = originalTicksAtFrame(source, runToFrame);
	if (start >= runStart && end <= runEnd) return false;
	const overlapStart = start > runStart ? start : runStart;
	const overlapEnd = end < runEnd ? end : runEnd;
	const overlap = overlapEnd - overlapStart;
	return overlap > 0n && overlap <= maxSourceTicks;
}

/** Only measured word timing permits substring selection and reading-cue splits. */
export function captionsFromSourceSegments(input: {
	document: CompositionDocument;
	sources: readonly CompositionSourceFacts[];
	mediaVersionId: string;
	segments: readonly CompositionSourceSegment[];
	/** Verified original-time VAD supports display only, never ASR identity. */
	speechIntervals?: readonly { startUs: number; endUs: number }[];
	/** New automatic generation must not substitute whole ASR paragraphs for aligned text. */
	requireAlignedText?: boolean;
	idFor: (clipId: string, segmentIndex: number) => string;
}): CompositionDocument {
	const segments = z.array(segmentSchema).max(5000).parse(input.segments);
	const transcriptSegmentsHash = hashEditingEvidence(segments);
	if (
		segments.reduce(
			(count, segment) => count + (segment.words?.length ?? 0),
			0,
		) > 20000
	)
		throw new RangeError("Measured word budget exceeded");
	const plan = compileComposition(input.document, input.sources, {
		allowUnconfirmed: true,
	});
	const source = plan.sources.find(
		(item) => item.mediaVersionId === input.mediaVersionId,
	);
	if (!source) throw new RangeError("Missing source geometry");
	const speechIntervals =
		input.speechIntervals === undefined
			? undefined
			: transcriptionSpeechIntervalSchema
					.array()
					.max(10000)
					.parse(input.speechIntervals);
	let previousSpeechEnd = source.timeMap.sourceStartUs;
	for (const interval of speechIntervals ?? []) {
		if (
			interval.startUs < previousSpeechEnd ||
			interval.endUs > source.timeMap.sourceEndUs
		)
			throw new RangeError("Expected ordered VAD inside the source time map");
		previousSpeechEnd = interval.endUs;
	}
	const document = structuredClone(plan.document);
	const captions = [...(document.captions ?? [])];
	const existingCaptions = new Map(
		captions.map((caption) => [caption.id, caption]),
	);
	// A shot boundary does not divide a spoken word. Form runs only when the
	// selected source frames AND output frames touch on the same video track.
	const runs: CompiledCompositionClip[][] = [];
	for (const compiled of plan.clips
		.filter((clip) => clip.mediaVersionId === input.mediaVersionId)
		.sort(
			(a, b) =>
				a.trackOrder - b.trackOrder || a.outputFromFrame - b.outputFromFrame,
		)) {
		const run = runs.at(-1);
		const previous = run?.at(-1);
		if (
			run &&
			previous &&
			previous.trackId === compiled.trackId &&
			previous.outputToFrame === compiled.outputFromFrame &&
			previous.sourceFromFrame + previous.clip.durationFrames ===
				compiled.sourceFromFrame
		)
			run.push(compiled);
		else runs.push([compiled]);
	}
	const nextCueIndices = new Map<string, number>();
	for (const run of runs) {
		const compiled = run[0];
		const last = run.at(-1);
		if (!compiled || !last) throw new RangeError("Missing source subtitle run");
		const runStartTicks = originalTicksAtFrame(
			source,
			compiled.sourceFromFrame,
		);
		const runEndTicks = originalTicksAtFrame(
			source,
			last.sourceFromFrame + last.clip.durationFrames,
		);
		const atOutput = (timeUs: number) =>
			firstFrameAt(timeUs, source) -
			compiled.sourceFromFrame +
			compiled.outputFromFrame;
		for (const [index, segment] of segments.entries()) {
			if (input.requireAlignedText && !segment.words?.length) continue;
			const fromFrame = Math.max(
				compiled.outputFromFrame,
				atOutput(segment.startUs),
			);
			const toFrame = Math.min(last.outputToFrame, atOutput(segment.endUs));
			if (toFrame <= fromFrame) continue;
			if (
				isUnmeasuredBoundarySpill(
					segment,
					source,
					compiled.sourceFromFrame,
					last.sourceFromFrame + last.clip.durationFrames,
					toFrame - fromFrame,
				)
			)
				continue;
			let measuredSpeechIntervals:
				| { fromFrame: number; toFrame: number }[]
				| undefined;
			if (segment.words?.length && speechIntervals !== undefined) {
				measuredSpeechIntervals = [];
				// Search the validated source once per intersecting paragraph/run;
				// never map every source VAD interval for every measured segment.
				let low = 0;
				let high = speechIntervals.length;
				while (low < high) {
					const middle = Math.floor((low + high) / 2);
					const interval = speechIntervals[middle];
					if (!interval) throw new RangeError("Missing VAD interval");
					if (
						interval.endUs <= segment.startUs ||
						BigInt(interval.endUs) * 30n <= runStartTicks
					)
						low = middle + 1;
					else high = middle;
				}
				for (let index = low; index < speechIntervals.length; index++) {
					const interval = speechIntervals[index];
					if (!interval) throw new RangeError("Missing VAD interval");
					if (
						interval.startUs >= segment.endUs ||
						BigInt(interval.startUs) * 30n >= runEndTicks
					)
						break;
					const from = Math.max(fromFrame, atOutput(interval.startUs));
					const floor = Number(
						originalTimeToCfrFrame(
							interval.endUs,
							source.timeMap.sourceStartUs,
							"FLOOR",
						) +
							BigInt(source.timeMap.editingStartFrame) -
							BigInt(compiled.sourceFromFrame) +
							BigInt(compiled.outputFromFrame),
					);
					if (!Number.isSafeInteger(floor))
						throw new RangeError("VAD frame exceeds safe integer domain");
					const to = Math.min(toFrame, floor);
					if (to > from)
						measuredSpeechIntervals.push({ fromFrame: from, toFrame: to });
				}
			}
			const cues = segment.words?.length
				? measuredSubtitleCues({
						requireAlignedText: input.requireAlignedText,
						speechIntervals: measuredSpeechIntervals,
						text: segment.text,
						fromFrame,
						toFrame,
						words: segment.words
							.filter(
								(word) =>
									!input.requireAlignedText ||
									(BigInt(word.startUs) * 30n >= runStartTicks &&
										BigInt(word.endUs) * 30n <= runEndTicks),
							)
							.map((word) => ({
								text: word.text,
								startChar: word.startChar,
								endChar: word.endChar,
								confidence: word.confidence,
								fromFrame: atOutput(word.startUs),
								toFrame: atOutput(word.endUs),
							})),
					})
				: speechIntervals === undefined
					? [{ text: segment.text, fromFrame, toFrame }]
					: unmeasuredSubtitleWindows(segment, speechIntervals).flatMap(
							(window) => {
								const from = Math.max(fromFrame, atOutput(window.startUs));
								const to = Math.min(toFrame, atOutput(window.endUs));
								return to > from
									? [{ text: segment.text, fromFrame: from, toFrame: to }]
									: [];
							},
						);
			for (const [cueIndex, cue] of cues.entries()) {
				const spans = run.flatMap((part) => {
					const from = Math.max(cue.fromFrame, part.outputFromFrame);
					const to = Math.min(cue.toFrame, part.outputToFrame);
					return to > from
						? [
								{
									clipId: part.clip.id,
									sourceFromFrame:
										part.sourceFromFrame + from - part.outputFromFrame,
									sourceToFrame:
										part.sourceFromFrame + to - part.outputFromFrame,
									outputFromFrame: from,
									outputToFrame: to,
									clip: compositionCaptionClipSnapshot(part.clip),
								},
							]
						: [];
				});
				const owner = spans[0]?.clipId;
				if (!owner) throw new RangeError("Missing measured caption span");
				const nextCueIndex = nextCueIndices.get(owner) ?? segments.length;
				const id = input.idFor(owner, cueIndex === 0 ? index : nextCueIndex);
				if (cueIndex !== 0) nextCueIndices.set(owner, nextCueIndex + 1);
				if (existingCaptions.has(id)) continue;
				if (captions.length >= COMPOSITION_LIMITS.captions)
					throw new RangeError("Caption budget exceeded");
				captions.push({
					id,
					...(spans.length === 1 ? { anchorClipId: owner } : {}),
					...cue,
					sourceEvidence: {
						version: "source-caption-v1",
						mediaVersionId: source.mediaVersionId,
						timeMapId: source.timeMap.id,
						segmentIndex: index,
						segmentStartUs: segment.startUs,
						segmentEndUs: segment.endUs,
						segmentTextHash: hashEditingEvidence(segment.text),
						transcriptSegmentsHash,
						caption: structuredClone(cue),
						spans,
					},
				});
			}
		}
	}
	document.captions = captions;
	return compositionDocumentSchema.parse(document);
}

const observationSchema = z.strictObject({
	sceneId: z.uuid(),
	shotIndex: us.max(4999),
	sourceTimeUs: us,
	box: normalizedCropRectSchema,
	confidence: z.number().finite().min(0).max(1),
});
const fallbackSchema = z
	.strictObject({
		sceneId: z.uuid(),
		shotIndex: us.max(4999),
		fromUs: us,
		toUs: us,
		reason: z.string().min(1).max(128),
	})
	.refine((item) => item.toUs > item.fromUs);
export type CompositionTrackingObservation = z.infer<typeof observationSchema>;
export type CompositionTrackingFallback = z.infer<typeof fallbackSchema>;
export const compositionTrackingObservationSchema = observationSchema;
export const compositionTrackingFallbackSchema = fallbackSchema;

/** Measured samples support interpolation only between samples, never an invented track. */
export function applyTrackedCompositionFraming(input: {
	document: CompositionDocument;
	sources: readonly CompositionSourceFacts[];
	mediaVersionId: string;
	observations: readonly CompositionTrackingObservation[];
	fallbacks: readonly CompositionTrackingFallback[];
	minimumConfidence?: number;
}): CompositionDocument {
	const observations = z
		.array(observationSchema)
		.max(5000)
		.parse(input.observations);
	const fallbacks = z.array(fallbackSchema).max(5000).parse(input.fallbacks);
	const threshold = z
		.number()
		.min(0)
		.max(1)
		.parse(input.minimumConfidence ?? 0.78);
	const plan = compileComposition(input.document, input.sources, {
		allowUnconfirmed: true,
	});
	const source = plan.sources.find(
		(item) => item.mediaVersionId === input.mediaVersionId,
	);
	if (!source) throw new RangeError("Missing source geometry");
	const document = structuredClone(plan.document);
	const targets = new Set(
		plan.clips
			.filter(
				(item) =>
					item.mediaVersionId === input.mediaVersionId &&
					item.clip.evidence?.shotIndex !== undefined,
			)
			.map((item) => item.clip.id),
	);
	const reservedKeys = document.clips
		.filter((clip) => !targets.has(clip.id))
		.reduce((count, clip) => count + (clip.cropKeyframes?.length ?? 0), 0);
	const keyBudget = Math.floor(
		(128 - reservedKeys) / Math.max(1, targets.size),
	);
	if (targets.size && keyBudget < 2)
		throw new RangeError(
			"Insufficient document keyframe budget for measured tracking",
		);
	for (const compiled of plan.clips) {
		const evidence = compiled.clip.evidence;
		if (
			compiled.mediaVersionId !== input.mediaVersionId ||
			!evidence ||
			evidence.shotIndex === undefined
		)
			continue;
		const clip = document.clips.find((item) => item.id === compiled.clip.id);
		if (!clip) throw new RangeError("Missing tracked clip");
		const match = (item: { sceneId: string; shotIndex: number }) =>
			item.sceneId === evidence.sceneId &&
			item.shotIndex === evidence.shotIndex;
		const samples = observations
			.filter((item) => match(item) && item.confidence >= threshold)
			.sort((a, b) => a.sourceTimeUs - b.sourceTimeUs);
		const frames = new Set<number>();
		const layout = clip.layout ?? { x: 0, y: 0, w: 1, h: 1 };
		const geometry = {
			sourceWidth: source.width,
			sourceHeight: source.height,
			targetWidth: Math.max(1, Math.round(document.canvas.width * layout.w)),
			targetHeight: Math.max(1, Math.round(document.canvas.height * layout.h)),
		};
		let oversized = false;
		const measuredKeys = samples.flatMap((sample) => {
			const frame =
				trackedFrameAt(sample.sourceTimeUs, source) - compiled.sourceFromFrame;
			if (frame < 0 || frame >= clip.durationFrames || frames.has(frame))
				return [];
			frames.add(frame);
			const centerX = sample.box.x + sample.box.w / 2;
			const centerY = sample.box.y + sample.box.h / 2;
			const max = suggestFixedCrop({ ...geometry, centerX, centerY });
			const zoom = Math.min(
				3,
				max.w / (sample.box.w / 0.8),
				max.h / (sample.box.h / 0.8),
			);
			if (zoom < 1) oversized = true;
			return [
				{
					frame,
					rect: suggestFixedCrop({
						...geometry,
						centerX,
						centerY,
						zoom: Math.max(1, zoom),
					}),
					easing: "SMOOTH" as const,
				},
			];
		});
		// Retain only actual observations, uniformly by measured-frame order. This is
		// a bounded representation, not a claim that unobserved motion was measured.
		const keys =
			measuredKeys.length <= keyBudget
				? measuredKeys
				: Array.from(
						{ length: keyBudget },
						(_, index) =>
							measuredKeys[
								Math.round(
									(index * (measuredKeys.length - 1)) / (keyBudget - 1),
								)
							],
					).filter((key): key is NonNullable<typeof key> => key !== undefined);
		const first = keys[0]?.frame ?? Infinity;
		const last = keys.at(-1)?.frame ?? -Infinity;
		const loss = fallbacks.filter(match).map((item) => ({
			from: trackedFrameAt(item.fromUs, source) - compiled.sourceFromFrame,
			to: trackedFrameAt(item.toUs, source, true) - compiled.sourceFromFrame,
		}));
		const origin = clip.framing.every((part) => part.origin === "AUTO_POLICY")
			? ("AUTO_POLICY" as const)
			: ("MANUAL" as const);
		const framing: EditFraming[] = [];
		for (let frame = 0; frame < clip.durationFrames; frame++) {
			const crop =
				keys.length >= 2 &&
				!oversized &&
				frame >= first &&
				frame <= last &&
				!loss.some((interval) => frame >= interval.from && frame < interval.to);
			const previous = framing.at(-1);
			if (previous && (previous.mode === "CROP") === crop)
				previous.toFrame = frame + 1;
			else
				framing.push(
					crop
						? {
								fromFrame: frame,
								toFrame: frame + 1,
								mode: "CROP",
								rect: keys[0]?.rect ?? { x: 0, y: 0, w: 1, h: 1 },
								origin,
							}
						: { fromFrame: frame, toFrame: frame + 1, mode: "FIT", origin },
				);
		}
		clip.framing = framing;
		if (keys.length >= 2 && !oversized) clip.cropKeyframes = keys;
		else delete clip.cropKeyframes;
	}
	return compositionDocumentSchema.parse(document);
}
