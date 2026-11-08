import type { AutoPortraitClip } from "./auto-portrait";
import {
	type LocalStoryEvent,
	type LocalStoryInput,
	type LocalStorySelection,
	localStoryCorpusSchema,
	localStoryEvidenceSchema,
	localStoryLedgerSchema,
} from "./local-story-contracts";
import {
	LocalStoryError,
	validateLocalStoryBlueprint,
	validateLocalStoryCorpusEvents,
} from "./local-story-input";
import { MAX_EDIT_CLIPS, MAX_EDIT_DURATION_FRAMES } from "./schema";
import { originalTimeToCfrFrame } from "./time";

type Span = { from: number; to: number };
type State = {
	spans: Span[];
	selectedEventIds: string[];
	selectedBeatIds: string[];
};
export type LocalStorySelectionResult = {
	policyVersion:
		| "aisa-prepared-local-story-window-v1"
		| "aisa-local-story-window-v1";
	requestedDurationFrames: number;
	actualDurationFrames: number;
	clips: AutoPortraitClip[];
	reasonCodes: string[];
	normalizationReceiptHash?: string;
	localStorySelection: LocalStorySelection;
};
export type LocalStorySelectionDescription = {
	mode: "FLOW" | "THEME";
	events: {
		beatId: string;
		eventId: string;
		role: LocalStoryEvent["role"];
		declaredRole: LocalStoryEvent["role"];
		roleMatchesBeat: boolean;
		label: string;
		refs: string[];
		quotes: { ref: string; quote: string }[];
	}[];
};

/** Describe recorded choices, never the unselected alternatives in a native message. */
export function describeLocalStorySelection(
	evidence: unknown,
): LocalStorySelectionDescription {
	const value = localStoryEvidenceSchema.parse(evidence);
	const events = new Map(value.ledger.events.map((event) => [event.id, event]));
	return {
		mode: value.blueprint.mode,
		events: value.selection.selectedEventIds.map((eventId, index) => {
			const event = required(events.get(eventId));
			const beat = required(value.blueprint.beats[index]);
			return {
				beatId: beat.id,
				eventId: event.id,
				role: event.role,
				declaredRole: beat.role,
				roleMatchesBeat: event.role === beat.role,
				label: event.label,
				refs: [...event.refs],
				quotes: event.quotes.map((quote) => ({ ...quote })),
			};
		}),
	};
}
const count = (spans: readonly Span[]) =>
	spans.reduce((sum, s) => sum + s.to - s.from, 0);
function required<T>(value: T | undefined): T {
	if (value === undefined)
		throw new LocalStoryError("LOCAL_STORY_EVIDENCE_INVALID");
	return value;
}
const signature = (s: State) =>
	`${s.spans.map((v) => `${v.from}:${v.to}`).join(",")}|${s.selectedEventIds.join(",")}`;
function merge<T extends number | bigint>(
	spans: readonly { from: T; to: T }[],
): { from: T; to: T }[] {
	const compare = (a: T, b: T) => (a < b ? -1 : a > b ? 1 : 0);
	const sorted = [...spans].sort(
			(a, b) => compare(a.from, b.from) || compare(a.to, b.to),
		),
		result: { from: T; to: T }[] = [];
	for (const span of sorted) {
		const last = result.at(-1);
		if (last && span.from <= last.to) {
			if (span.to > last.to) last.to = span.to;
		} else result.push({ ...span });
	}
	return result;
}
function covered(spans: readonly Span[], from: number, to: number) {
	let cursor = from;
	for (const s of spans) {
		if (s.to <= cursor) continue;
		if (s.from > cursor) return false;
		cursor = Math.max(cursor, s.to);
		if (cursor >= to) return true;
	}
	return cursor >= to;
}
function addForward(
	previous: readonly Span[],
	next: readonly Span[],
): Span[] | undefined {
	const end = previous.at(-1)?.to ?? -1;
	if (
		next.some(
			(s) => s.from < end && !covered(previous, s.from, Math.min(s.to, end)),
		)
	)
		return undefined;
	return merge([...previous, ...next]);
}
function speechSafe(input: LocalStoryInput, spans: readonly Span[]): Span[] {
	const sourceStart = BigInt(input.timeMap.sourceStartUs);
	// Exact 1/30-microsecond ticks keep adjacent original utterances half-open.
	// Rounding every segment first would turn a shared 6.62s boundary into an
	// overlap at frames 198/199 and transitively join unrelated utterances.
	const utterances = input.segments.map((segment) => ({
		from: (BigInt(segment.startUs) - sourceStart) * 30n,
		to: (BigInt(segment.endUs) - sourceStart) * 30n,
	}));
	let result = merge(
		spans.map((span) => ({
			from: BigInt(span.from) * 1_000_000n,
			to: BigInt(span.to) * 1_000_000n,
		})),
	);
	// Genuine source-time overlap can expose another utterance; converge before
	// quantizing the final bounds, keeping the existing speech and footage guards.
	for (let iteration = 0; iteration <= input.segments.length; iteration++) {
		let changed = false;
		result = merge(
			result.map((span) => {
				let { from, to } = span;
				for (const utterance of utterances) {
					if (utterance.from < from && utterance.to > from) {
						from = utterance.from;
						changed = true;
					}
					if (utterance.from < to && utterance.to > to) {
						to = utterance.to;
						changed = true;
					}
				}
				return { from, to };
			}),
		);
		if (!changed)
			return merge(
				result.map((span) => ({
					from: Number(span.from / 1_000_000n),
					to: Number((span.to + 999_999n) / 1_000_000n),
				})),
			);
	}
	throw new LocalStoryError("LOCAL_STORY_SPEECH_LIMIT");
}
/** Every output clip remains inside an actual eligible shot, including speech handles. */
function clipsFor(
	input: LocalStoryInput,
	spans: readonly Span[],
): AutoPortraitClip[] | undefined {
	const clips: AutoPortraitClip[] = [];
	for (const span of spans) {
		let cursor = span.from;
		for (const shot of input.shots) {
			if (shot.toFrame <= cursor || shot.fromFrame >= span.to) continue;
			if (shot.fromFrame > cursor) return undefined;
			const end = Math.min(span.to, shot.toFrame);
			if (end <= cursor) continue;
			const sourceInUs =
				BigInt(input.timeMap.sourceStartUs) +
				(BigInt(cursor) * 1_000_000n + 29n) / 30n;
			if (
				sourceInUs >= BigInt(input.timeMap.sourceEndUs) ||
				sourceInUs > BigInt(Number.MAX_SAFE_INTEGER)
			)
				return undefined;
			clips.push({
				sourceInUs: Number(sourceInUs),
				durationFrames: end - cursor,
				sceneId: shot.sceneId,
				...(shot.shotIndex === undefined ? {} : { shotIndex: shot.shotIndex }),
			});
			cursor = end;
			if (cursor === span.to) break;
		}
		if (cursor !== span.to) return undefined;
	}
	return clips.length <= MAX_EDIT_CLIPS ? clips : undefined;
}
function eventCandidates(
	input: LocalStoryInput,
	event: LocalStoryEvent,
): Span[][] {
	const shots = event.refs.map((ref) =>
		required(input.shots.find((s) => s.ref === ref)),
	);
	const whole = speechSafe(
		input,
		shots.map((s) => ({ from: s.fromFrame, to: s.toFrame })),
	);
	const candidates: Span[][] = [whole];
	// A quoted utterance supplies real timing for a shorter expression. AISA prose alone
	// does not locate the moment inside a shot, so its required span is never center-trimmed.
	const speechFields = event.quotes.map(
		(q) =>
			shots
				.find((s) => s.ref === q.ref)
				?.fields.filter((f) => f.text.includes(q.quote)) ?? [],
	);
	if (
		speechFields.every(
			(fields) =>
				fields.length &&
				fields.every(
					(f) =>
						f.kind === "ASR" &&
						f.startUs !== undefined &&
						f.endUs !== undefined,
				),
		)
	) {
		const spans = speechFields.flat().map((f) => ({
			from: Math.max(
				0,
				Number(
					originalTimeToCfrFrame(
						required(f.startUs),
						input.timeMap.sourceStartUs,
						"FLOOR",
					),
				) - 3,
			),
			to: Math.min(
				input.timeMap.editingEndFrame - input.timeMap.editingStartFrame,
				Number(
					originalTimeToCfrFrame(
						required(f.endUs),
						input.timeMap.sourceStartUs,
						"CEIL",
					),
				) + 3,
			),
		}));
		candidates.push(speechSafe(input, spans));
	}
	return candidates;
}

/** Minimum usable footprint of an already grounded event. This measures the same
 * complete-speech candidates as selection; it does not choose beats or rank events. */
export function localStoryEventMinimumDurationFrames(
	input: LocalStoryInput,
	event: LocalStoryEvent,
): number | undefined {
	let minimum: number | undefined;
	for (const spans of eventCandidates(input, event)) {
		if (!clipsFor(input, spans)) continue;
		const frames = count(spans);
		if (minimum === undefined || frames < minimum) minimum = frames;
	}
	return minimum;
}

function checkedTarget(target: number) {
	if (
		!Number.isSafeInteger(target) ||
		target < 1 ||
		target > MAX_EDIT_DURATION_FRAMES
	)
		throw new LocalStoryError("LOCAL_STORY_DURATION_INVALID");
	return target;
}

/** Fully validate each public selection, including callers outside feasible-choice search. */
export function selectLocalStoryClips(options: {
	input: LocalStoryInput;
	ledger: unknown;
	blueprint: unknown;
	targetDurationFrames: number;
}): LocalStorySelectionResult {
	checkedTarget(options.targetDurationFrames);
	return createLocalStoryClipSelector(options)({
		blueprint: options.blueprint,
		targetDurationFrames: options.targetDurationFrames,
	});
}

/** One synchronous search owns a detached, validated source/corpus. No cross-call cache.
 * Every candidate still validates its Blueprint; source-grounded event spans depend
 * only on this private snapshot, so they can be shared across that search's plans.
 */
export function createLocalStoryClipSelector(options: {
	input: LocalStoryInput;
	ledger: unknown;
}) {
	const input = structuredClone(options.input);
	const corpus = localStoryCorpusSchema.safeParse(options.ledger),
		ledger = structuredClone(
			corpus.success
				? corpus.data
				: localStoryLedgerSchema.parse(options.ledger),
		);
	validateLocalStoryCorpusEvents(input, ledger.events);
	const events = new Map(ledger.events.map((e) => [e.id, e]));
	const candidates = new Map<string, Span[][]>();
	return (selection: {
		blueprint: unknown;
		targetDurationFrames: number;
	}): LocalStorySelectionResult => {
		const target = checkedTarget(selection.targetDurationFrames);
		const blueprint = validateLocalStoryBlueprint({
			ledger,
			blueprint: selection.blueprint,
		});
		// Five beats, four event alternatives and at most two timed variants give
		// at most 8^5 states. Keep that bounded space so a long prefix cannot evict
		// a short plan needed by a later mandatory beat.
		const maxStates = 32_768,
			maxExpansions = 40_000;
		let beam: State[] = [
				{ spans: [], selectedEventIds: [], selectedBeatIds: [] },
			],
			expansions = 0;
		for (const beat of blueprint.beats) {
			const next = new Map<string, State>();
			for (const state of beam) {
				if (!beat.requires.every((id) => state.selectedBeatIds.includes(id)))
					continue;
				for (const eventId of beat.eventIds) {
					if (state.selectedEventIds.includes(eventId)) continue;
					let alternatives = candidates.get(eventId);
					if (!alternatives) {
						alternatives = eventCandidates(
							input,
							required(events.get(eventId)),
						);
						candidates.set(eventId, alternatives);
					}
					for (const candidate of alternatives) {
						if (++expansions > maxExpansions)
							throw new LocalStoryError("LOCAL_STORY_SEARCH_LIMIT");
						const spans = addForward(state.spans, candidate);
						if (!spans || count(spans) > target || !clipsFor(input, spans))
							continue;
						const value = {
							spans,
							selectedEventIds: [...state.selectedEventIds, eventId],
							selectedBeatIds: [...state.selectedBeatIds, beat.id],
						};
						next.set(signature(value), value);
					}
				}
			}
			beam = [...next.values()]
				.sort((a, b) => {
					// Compare whole plans: preserve complete beats, use the available duration,
					// then minimize jumps and cuts. No event importance or top-K score exists.
					return (
						count(b.spans) - count(a.spans) ||
						a.spans.length - b.spans.length ||
						signature(a).localeCompare(signature(b), "en")
					);
				})
				.slice(0, maxStates);
			if (!beam.length)
				throw new LocalStoryError("LOCAL_STORY_NO_FITTING_PLAN");
		}
		const selected = required(beam[0]);
		return {
			policyVersion: input.normalizationReceiptHash
				? "aisa-prepared-local-story-window-v1"
				: "aisa-local-story-window-v1",
			requestedDurationFrames: target,
			actualDurationFrames: count(selected.spans),
			clips: required(clipsFor(input, selected.spans)),
			reasonCodes: [
				"LOCAL_LLM_COMPLETE_BEATS",
				"SOURCE_PRESENTATION_ORDER",
				"LOCAL_STORY_VISUAL_GROUNDING_PENDING",
				...(input.segments.length
					? ["COMPLETE_UTTERANCE_BOUNDARIES"]
					: ["TRANSCRIPT_UNAVAILABLE"]),
				...(count(selected.spans) < target ? ["DURATION_UNDER_TARGET"] : []),
			],
			...(input.normalizationReceiptHash
				? { normalizationReceiptHash: input.normalizationReceiptHash }
				: {}),
			localStorySelection: {
				selectedBeatIds: selected.selectedBeatIds,
				selectedEventIds: selected.selectedEventIds,
				reason: "COMPLETE_BEATS",
			},
		};
	};
}
