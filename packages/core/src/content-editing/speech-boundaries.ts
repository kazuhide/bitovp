import {
	type AutoPortraitSelection,
	AutoPortraitSelectionError,
	type PortraitSelectionSearchBudget,
	selectAutoPortraitClips,
} from "./auto-portrait";
import {
	type ContentHighlightSelection,
	selectContentHighlightClips,
} from "./content-highlight";
import {
	getPreparedShotPartitionEntry,
	type PreparedPortraitSelection,
	type PreparedShotPartition,
	selectPreparedPortraitClips,
} from "./prepared-shot-partition";
import {
	type CfrTimeMap,
	cfrTimeMapSchema,
	MAX_EDIT_CLIPS,
	MAX_EDIT_DURATION_FRAMES,
} from "./schema";
import {
	type SemanticPortraitSelection,
	selectSemanticPortraitClips,
} from "./semantic-portrait";
import {
	type StoryPortraitSelection,
	selectStoryPortraitClips,
} from "./story-selection";
import { originalTimeToCfrFrame } from "./time";
import { hashEditingEvidence } from "./verify-automatic-binding";

const MAX_SPEECH_SEGMENTS = 5000;
const MAX_BOUNDARY_POINTS = 20_000;
type Selection =
	| AutoPortraitSelection
	| ContentHighlightSelection
	| SemanticPortraitSelection
	| StoryPortraitSelection
	| PreparedPortraitSelection;
export type SpeechContextWindow = {
	/** Prepared-file frame indices, independent of editingStartFrame. */
	fromFrame: number;
	toFrame: number;
	/** Prepared-file local microseconds; do not add the source origin twice. */
	mediaStartUs: number;
	durationUs: number;
	clipped: boolean;
};
export type SpeechBoundaryInterval = { startUs: number; endUs: number };
export type SpeechBoundarySelectionResult = {
	selection: Selection;
	status: "APPLIED" | "FALLBACK";
	reason?: "NO_SPEECH" | "BOUNDARY_COVERAGE_UNKNOWN";
	intervals: SpeechBoundaryInterval[];
	rejectedBoundaryCount: number;
};
export type SpeechBoundaryFailureEvidence = {
	readonly intervals: readonly Readonly<SpeechBoundaryInterval>[];
	readonly rejectedBoundaryCount: number;
};
export class SpeechBoundarySelectionError extends Error {
	readonly evidence?: SpeechBoundaryFailureEvidence;
	constructor(
		readonly code:
			| "SPEECH_EVIDENCE_LIMIT"
			| "NO_SPEECH_SAFE_WINDOW"
			| "SPEECH_SELECTION_SEARCH_LIMIT",
		evidence?: SpeechBoundaryFailureEvidence,
	) {
		super(code);
		this.name = "SpeechBoundarySelectionError";
		if (evidence !== undefined) {
			if (
				(code !== "NO_SPEECH_SAFE_WINDOW" &&
					code !== "SPEECH_SELECTION_SEARCH_LIMIT") ||
				!Array.isArray(evidence.intervals) ||
				evidence.intervals.length > MAX_SPEECH_SEGMENTS ||
				!Number.isSafeInteger(evidence.rejectedBoundaryCount) ||
				evidence.rejectedBoundaryCount < 0 ||
				evidence.rejectedBoundaryCount > MAX_BOUNDARY_POINTS ||
				evidence.intervals.some(
					(interval, index) =>
						!Number.isSafeInteger(interval.startUs) ||
						!Number.isSafeInteger(interval.endUs) ||
						interval.startUs < 0 ||
						interval.endUs <= interval.startUs ||
						(index > 0 &&
							(evidence.intervals[index - 1]?.endUs ?? Infinity) >=
								interval.startUs),
				)
			)
				throw new RangeError("Expected bounded merged speech failure evidence");
			Object.defineProperty(this, "evidence", {
				value: Object.freeze({
					intervals: Object.freeze(
						evidence.intervals.map((interval) =>
							Object.freeze({
								startUs: interval.startUs,
								endUs: interval.endUs,
							}),
						),
					),
					rejectedBoundaryCount: evidence.rejectedBoundaryCount,
				}),
				enumerable: true,
				writable: false,
				configurable: false,
			});
		}
	}
}
const ceilFrameUs = (frame: number) => (BigInt(frame) * 1_000_000n + 29n) / 30n;
const validFrame = (frame: number) => Number.isSafeInteger(frame) && frame >= 0;

function selectionRanges(selection: Selection, map: CfrTimeMap) {
	if (
		!selection ||
		!Array.isArray(selection.clips) ||
		!selection.clips.length ||
		selection.clips.length > MAX_EDIT_CLIPS
	)
		throw new RangeError("Expected 1..20 selected whole clips");
	const frames = map.editingEndFrame - map.editingStartFrame;
	let total = 0,
		previousEnd = 0;
	const ranges = selection.clips.map((clip) => {
		if (
			!Number.isSafeInteger(clip.sourceInUs) ||
			clip.sourceInUs < map.sourceStartUs ||
			!Number.isSafeInteger(clip.durationFrames) ||
			clip.durationFrames < 1 ||
			clip.durationFrames > MAX_EDIT_DURATION_FRAMES
		)
			throw new RangeError("Selected clip exceeds the source clock");
		const from = Number(
			originalTimeToCfrFrame(clip.sourceInUs, map.sourceStartUs, "FLOOR"),
		);
		const to = from + clip.durationFrames;
		if (
			!validFrame(from) ||
			!validFrame(to) ||
			from < previousEnd ||
			to > frames ||
			BigInt(clip.sourceInUs) !== BigInt(map.sourceStartUs) + ceilFrameUs(from)
		)
			throw new RangeError("Expected ordered, canonical source-frame clips");
		previousEnd = to;
		total += clip.durationFrames;
		return { from, to };
	});
	if (
		total > MAX_EDIT_DURATION_FRAMES ||
		selection.actualDurationFrames !== total
	)
		throw new RangeError("Selected duration must equal its whole-clip frames");
	return ranges;
}

/** Bounded extraction coordinates only; this grants no ASR or source evidence. */
export function buildSpeechContextWindow(input: {
	selection: Selection;
	timeMap: unknown;
}): SpeechContextWindow {
	const map = cfrTimeMapSchema.parse(input.timeMap);
	const ranges = selectionRanges(input.selection, map);
	const first = ranges[0],
		last = ranges.at(-1);
	if (!first || !last) throw new RangeError("Missing selection window");
	const frames = map.editingEndFrame - map.editingStartFrame;
	let fromFrame = Math.max(0, first.from - 60),
		toFrame = Math.min(frames, last.to + 60);
	if (toFrame - fromFrame > MAX_EDIT_DURATION_FRAMES) {
		fromFrame = Math.max(
			0,
			Math.min(
				frames - MAX_EDIT_DURATION_FRAMES,
				first.from +
					Math.floor((last.to - first.from - MAX_EDIT_DURATION_FRAMES) / 2),
			),
		);
		toFrame = fromFrame + MAX_EDIT_DURATION_FRAMES;
	}
	const mediaStartUs = ceilFrameUs(fromFrame);
	return {
		fromFrame,
		toFrame,
		mediaStartUs: Number(mediaStartUs),
		durationUs: Number(ceilFrameUs(toFrame) - mediaStartUs),
		clipped: fromFrame !== first.from - 60 || toFrame !== last.to + 60,
	};
}

/**
 * Filter final, source-contiguous window ends against verified, original-us ASR
 * observations. A transcript/model/source binding must be verified by the caller.
 * Unknown coverage is never promoted to an observed gap; no times are inferred.
 */
export function refinePortraitSelectionBySpeech(input: {
	analysis: unknown;
	timeMap: unknown;
	targetDurationFrames: number;
	policy: "COHESION" | "DURATION" | "AUTO" | "STORY";
	story?: Parameters<typeof selectStoryPortraitClips>[0]["story"];
	query?: string;
	anchor: Selection;
	context: SpeechContextWindow;
	segments: readonly SpeechBoundaryInterval[];
	searchBudget: PortraitSelectionSearchBudget;
	preparedPartition?: PreparedShotPartition;
}): SpeechBoundarySelectionResult {
	if (!Array.isArray(input.segments))
		throw new RangeError("Expected observed ASR segments");
	if (input.segments.length > MAX_SPEECH_SEGMENTS)
		throw new SpeechBoundarySelectionError("SPEECH_EVIDENCE_LIMIT");
	const map = cfrTimeMapSchema.parse(input.timeMap);
	const anchorRanges = selectionRanges(input.anchor, map);
	if (input.preparedPartition) {
		const p = input.preparedPartition;
		if (
			p.analysisDocumentHash !== hashEditingEvidence(input.analysis) ||
			p.timeMapHash !== hashEditingEvidence(map) ||
			!(
				input.anchor.policyVersion === "aisa-prepared-shot-window-v3" ||
				input.anchor.policyVersion === "aisa-prepared-scene-cohesion-v3" ||
				input.anchor.policyVersion === "aisa-prepared-content-highlight-v4" ||
				input.anchor.policyVersion === "aisa-prepared-story-window-v1"
			) ||
			!("normalizationReceiptHash" in input.anchor) ||
			input.anchor.normalizationReceiptHash !== p.normalizationReceiptHash
		)
			throw new RangeError("Prepared speech anchor clock mismatch");
		input.anchor.clips.forEach((clip, index) => {
			const e = getPreparedShotPartitionEntry(p, {
					sceneId: clip.sceneId,
					shotIndex: clip.shotIndex,
				}),
				range = anchorRanges[index];
			if (!e || !range || e.fromFrame !== range.from || e.toFrame !== range.to)
				throw new RangeError("Prepared speech anchor partition mismatch");
		});
	}

	if (
		(input.policy !== "COHESION" &&
			input.policy !== "DURATION" &&
			input.policy !== "AUTO" &&
			input.policy !== "STORY") ||
		(input.policy === "AUTO" && input.query !== undefined) ||
		(input.policy === "STORY" &&
			(!input.story ||
				input.query !== undefined ||
				(input.anchor.policyVersion !== "aisa-story-window-v1" &&
					input.anchor.policyVersion !== "aisa-prepared-story-window-v1"))) ||
		!Number.isSafeInteger(input.targetDurationFrames) ||
		input.targetDurationFrames < 1 ||
		input.targetDurationFrames > MAX_EDIT_DURATION_FRAMES ||
		input.anchor.requestedDurationFrames !== input.targetDurationFrames ||
		!input.searchBudget
	)
		throw new RangeError("Expected the anchor intent and shared search budget");
	const context = input.context;
	if (
		!context ||
		!validFrame(context.fromFrame) ||
		!validFrame(context.toFrame) ||
		context.toFrame <= context.fromFrame ||
		context.toFrame > map.editingEndFrame - map.editingStartFrame ||
		context.toFrame - context.fromFrame > MAX_EDIT_DURATION_FRAMES ||
		typeof context.clipped !== "boolean" ||
		context.mediaStartUs !== Number(ceilFrameUs(context.fromFrame)) ||
		context.durationUs !==
			Number(ceilFrameUs(context.toFrame) - ceilFrameUs(context.fromFrame))
	)
		throw new RangeError("Expected canonical bounded ASR context coordinates");
	const sorted = input.segments
		.map((segment) => {
			if (
				!segment ||
				!Number.isSafeInteger(segment.startUs) ||
				!Number.isSafeInteger(segment.endUs) ||
				segment.startUs < map.sourceStartUs ||
				segment.endUs <= segment.startUs ||
				segment.endUs > map.sourceEndUs
			)
				throw new RangeError(
					"Expected real segment times inside the source map",
				);
			return { startUs: segment.startUs, endUs: segment.endUs };
		})
		.sort((a, b) => a.startUs - b.startUs || a.endUs - b.endUs);
	const intervals: SpeechBoundaryInterval[] = [];
	for (const interval of sorted) {
		const previous = intervals.at(-1);
		if (previous && previous.endUs >= interval.startUs)
			previous.endUs = Math.max(previous.endUs, interval.endUs);
		else intervals.push(interval);
	}
	if (!intervals.length)
		return {
			selection: input.anchor,
			status: "FALLBACK",
			reason: "NO_SPEECH",
			intervals,
			rejectedBoundaryCount: 0,
		};
	const scaled = intervals.map((interval) => ({
		from: (BigInt(interval.startUs) - BigInt(map.sourceStartUs)) * 30n,
		to: (BigInt(interval.endUs) - BigInt(map.sourceStartUs)) * 30n,
	}));
	type Boundary = "UNSAFE" | "OBSERVED_GAP" | "UNKNOWN";
	const boundaries = new Map<number, Boundary>();
	let rejectedBoundaryCount = 0;
	const classify = (frame: number): Boundary => {
		const cached = boundaries.get(frame);
		if (cached) return cached;
		if (boundaries.size >= MAX_BOUNDARY_POINTS)
			throw new SpeechBoundarySelectionError("SPEECH_EVIDENCE_LIMIT");
		const instant = BigInt(frame) * 1_000_000n;
		let low = 0,
			high = scaled.length;
		while (low < high) {
			const middle = Math.floor((low + high) / 2);
			if ((scaled[middle]?.from ?? instant) < instant) low = middle + 1;
			else high = middle;
		}
		const interval = scaled[low - 1];
		const state: Boundary =
			interval && interval.from < instant && instant < interval.to
				? "UNSAFE"
				: frame > context.fromFrame && frame < context.toFrame
					? "OBSERVED_GAP"
					: "UNKNOWN";
		if (state === "UNSAFE") rejectedBoundaryCount++;
		boundaries.set(frame, state);
		return state;
	};
	const anchorStart = anchorRanges[0]?.from,
		anchorEnd = anchorRanges.at(-1)?.to;
	if (
		anchorStart !== undefined &&
		anchorEnd !== undefined &&
		anchorStart >= context.fromFrame &&
		anchorEnd <= context.toFrame
	) {
		const cuts = [anchorStart, anchorEnd];
		for (let index = 1; index < anchorRanges.length; index++) {
			const previous = anchorRanges[index - 1],
				current = anchorRanges[index];
			if (previous && current && previous.to !== current.from)
				cuts.push(previous.to, current.from);
		}
		const states = cuts.map((frame) => ({ frame, state: classify(frame) }));
		const unknown = states.filter((point) => point.state === "UNKNOWN");
		// Preserve existing file edges, without claiming to observe beyond them.
		// Internal context-cap edges and known speech cuts never get this exception.
		if (
			unknown.length &&
			states.every((point) => point.state !== "UNSAFE") &&
			unknown.every(
				(point) =>
					point.frame === 0 ||
					point.frame === map.editingEndFrame - map.editingStartFrame,
			)
		)
			return {
				selection: input.anchor,
				status: "FALLBACK",
				reason: "BOUNDARY_COVERAGE_UNKNOWN",
				intervals,
				rejectedBoundaryCount,
			};
	}
	const select = (allowUnknown: boolean): Selection => {
		const parameters = {
			analysis: input.analysis,
			timeMap: map,
			targetDurationFrames: input.targetDurationFrames,
			searchBudget: input.searchBudget,
			acceptWindow: (window: { fromFrame: number; toFrame: number }) => {
				if (
					window.fromFrame < context.fromFrame ||
					window.toFrame > context.toFrame
				)
					return false;
				const from = classify(window.fromFrame),
					to = classify(window.toFrame);
				return allowUnknown
					? from !== "UNSAFE" && to !== "UNSAFE"
					: from === "OBSERVED_GAP" && to === "OBSERVED_GAP";
			},
		};
		try {
			if (input.preparedPartition)
				return selectPreparedPortraitClips({
					partition: input.preparedPartition,
					targetDurationFrames: input.targetDurationFrames,
					policy: input.policy,
					story: input.story,
					query: input.query,
					searchBudget: input.searchBudget,
					acceptWindow: parameters.acceptWindow,
				});
			if (input.policy === "STORY") {
				if (!input.story)
					throw new RangeError("Expected the anchor story intent");
				return selectStoryPortraitClips({ ...parameters, story: input.story });
			}
			return input.policy === "DURATION"
				? selectAutoPortraitClips(parameters)
				: input.policy === "AUTO"
					? selectContentHighlightClips(parameters)
					: selectSemanticPortraitClips({ ...parameters, query: input.query });
		} catch (error) {
			if (
				(input.policy === "AUTO" || input.policy === "STORY") &&
				error instanceof RangeError &&
				error.message === "Auto portrait search limit exceeded (200000)"
			) {
				throw new SpeechBoundarySelectionError(
					"SPEECH_SELECTION_SEARCH_LIMIT",
					{ intervals, rejectedBoundaryCount },
				);
			}
			throw error;
		}
	};
	try {
		const selection = select(false);
		return { selection, status: "APPLIED", intervals, rejectedBoundaryCount };
	} catch (error) {
		if (!(error instanceof AutoPortraitSelectionError)) throw error;
	}
	try {
		const selection = select(true);
		return {
			selection,
			status: "FALLBACK",
			reason: "BOUNDARY_COVERAGE_UNKNOWN",
			intervals,
			rejectedBoundaryCount,
		};
	} catch (error) {
		if (!(error instanceof AutoPortraitSelectionError)) throw error;
		throw new SpeechBoundarySelectionError("NO_SPEECH_SAFE_WINDOW", {
			intervals,
			rejectedBoundaryCount,
		});
	}
}
