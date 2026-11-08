import { sceneAnalysisDocumentSchema } from "../content-library/analysis";
import {
	type AutoPortraitClip,
	type AutoPortraitSelection,
	AutoPortraitSelectionError,
	type AutoPortraitSelectionInput,
	createPortraitSelectionSearchBudget,
	type PortraitCandidateFrameResolver,
	selectAutoPortraitClips,
} from "./auto-portrait";
import { cfrTimeMapSchema } from "./schema";
import type {
	StoryGraph,
	StoryModelInput,
	StorySelection,
} from "./story-contracts";

const BEAM_WIDTH = 16;
const MAX_BEAM_EXPANSIONS = 4096;
const MAX_MATERIALIZATIONS = 12;
type Story = { input: StoryModelInput; graph: StoryGraph };
export type StorySelectionResult = StorySelection;
export type StoryPortraitSelection = Omit<
	AutoPortraitSelection,
	"policyVersion" | "reasonCodes"
> & {
	policyVersion: "aisa-story-window-v1";
	reasonCodes: string[];
	storySelection: StorySelectionResult;
};
const intervalKey = (interval: { sceneId: string; shotIndex?: number }) =>
	`${interval.sceneId.toLowerCase()}:${interval.shotIndex ?? "scene"}`;
const compare = (a: readonly number[], b: readonly number[]) => {
	for (let index = 0; index < Math.max(a.length, b.length); index++) {
		const difference = (b[index] ?? 0) - (a[index] ?? 0);
		if (difference) return difference;
	}
	return 0;
};
function graphIndex(story: Story) {
	if (
		story.input.intervals.length > 10000 ||
		story.graph.events.length > 128 ||
		story.graph.arcs.length > 128
	)
		throw new RangeError("STORY_METADATA_LIMIT");
	const refs = new Map(story.input.intervals.map((item) => [item.ref, item])),
		events = new Map(story.graph.events.map((item) => [item.id, item]));
	if (
		refs.size !== story.input.intervals.length ||
		events.size !== story.graph.events.length
	)
		throw new RangeError("STORY_REFERENCE_INVALID");
	const closures = new Map<string, Set<string>>();
	const closure = (id: string, visiting = new Set<string>()): Set<string> => {
		const cached = closures.get(id);
		if (cached) return cached;
		const event = events.get(id);
		if (!event || visiting.has(id))
			throw new RangeError("STORY_REFERENCE_INVALID");
		visiting.add(id);
		const result = new Set([id]);
		for (const dependency of event.dependsOn)
			for (const item of closure(dependency, visiting)) result.add(item);
		visiting.delete(id);
		closures.set(id, result);
		return result;
	};
	for (const event of events.values()) {
		if (
			!event.evidence.length ||
			event.evidence.some((item) => !refs.has(item.ref))
		)
			throw new RangeError("STORY_REFERENCE_INVALID");
		closure(event.id);
	}
	for (const arc of story.graph.arcs)
		for (const id of arc.eventIds)
			if (!events.has(id)) throw new RangeError("STORY_REFERENCE_INVALID");
	const starts = new Map(
		[...events].map(([id, event]) => [
			id,
			Math.min(
				...event.evidence.map(
					(item) => refs.get(item.ref)?.startInSeconds ?? Infinity,
				),
			),
		]),
	);
	const start = (id: string) => starts.get(id) ?? Infinity;
	// Compare supplied interval origins, without inventing within-shot event times.
	const ordered = (id: string) =>
		[...closure(id)].every((dependency) =>
			(events.get(dependency)?.dependsOn ?? []).every(
				(previous) => start(previous) <= start(dependency),
			),
		);
	return { refs, events, closure, start, ordered };
}
type Index = ReturnType<typeof graphIndex>;
function coverage(graph: StoryGraph, selected: Set<string>, index: Index) {
	const rank = (ids: readonly string[]) => {
		const covered = ids.filter((id) => selected.has(id)),
			supported = covered.filter(
				(id) =>
					index.ordered(id) &&
					[...index.closure(id)].every((dependency) =>
						selected.has(dependency),
					),
			),
			roles = new Set(supported.map((id) => index.events.get(id)?.role)),
			storyRoles = ["SETUP", "CHANGE", "OUTCOME"] as const,
			roleCount = storyRoles.filter((role) => roles.has(role)).length,
			supportedRefs = new Set(
				supported.flatMap(
					(id) => index.events.get(id)?.evidence.map((item) => item.ref) ?? [],
				),
			),
			weights = new Map<string, number>();
		const connected = supported.some(
			(outcome) =>
				index.events.get(outcome)?.role === "OUTCOME" &&
				supported.some(
					(change) =>
						index.events.get(change)?.role === "CHANGE" &&
						index.closure(outcome).has(change) &&
						supported.some(
							(setup) =>
								index.events.get(setup)?.role === "SETUP" &&
								index.closure(change).has(setup),
						),
				),
		);
		const complete =
			connected &&
			covered.length === ids.length &&
			supported.length === ids.length;
		let evidenceCount = 0;
		for (const id of covered) {
			const event = index.events.get(id);
			if (!event) continue;
			for (const item of event.evidence) {
				evidenceCount++;
				weights.set(
					item.ref,
					Math.max(weights.get(item.ref) ?? 0, event.importance),
				);
			}
		}
		return {
			covered,
			complete,
			score: [
				Number(complete),
				roleCount,
				supportedRefs.size,
				weights.size,
				[...weights.values()].reduce((sum, value) => sum + value, 0),
				-(evidenceCount - weights.size),
			],
		};
	};
	const arcs = graph.arcs
		.map((arc, order) => ({
			...rank([
				...new Set(arc.eventIds.flatMap((id) => [...index.closure(id)])),
			]),
			id: arc.id,
			order,
		}))
		.filter((arc) => arc.covered.length)
		.sort((a, b) => compare(a.score, b.score) || a.order - b.order);
	const best = arcs[0];
	return {
		selectedArcId: best?.id,
		complete: best?.complete ?? false,
		score: best?.score ?? rank([...selected]).score,
	};
}
/** Creation provenance for the final whole clips, including a later speech reselection. */
export function buildStorySelection(
	input: Story & {
		clips: readonly AutoPortraitClip[];
		reason?: StorySelectionResult["reason"];
	},
): StorySelectionResult {
	const index = graphIndex(input),
		clipKeys = new Set(input.clips.map(intervalKey)),
		selectedEventIds = input.graph.events
			.filter((event) =>
				event.evidence.every((item) => {
					const interval = index.refs.get(item.ref);
					return interval !== undefined && clipKeys.has(intervalKey(interval));
				}),
			)
			.map((event) => event.id),
		selected = coverage(input.graph, new Set(selectedEventIds), index);
	return {
		...(selected.selectedArcId
			? { selectedArcId: selected.selectedArcId }
			: {}),
		selectedEventIds,
		reason:
			input.reason === "SEARCH_BUDGET"
				? "SEARCH_BUDGET"
				: !selectedEventIds.length
					? "METADATA_INSUFFICIENT"
					: selected.complete
						? "CONNECTED_ARC"
						: "PARTIAL_ARC",
	};
}

/**
 * First experiment: one source-contiguous coherent microarc, not a multi-window
 * summary. The model supplies evidence-grounded event relations, never cut times.
 * Beam candidates are approximate; all actual windows still use the canonical
 * whole-shot selector, including its exclusion, clock, clip and shared-work caps.
 */
export function selectStoryPortraitClips(
	input: AutoPortraitSelectionInput & { story: Story },
	internalFrameResolver?: PortraitCandidateFrameResolver,
): StoryPortraitSelection {
	const parameters = {
		...input,
		searchBudget: input.searchBudget ?? createPortraitSelectionSearchBudget(),
	};
	// Establish a complete, admissible baseline before optional bounded ranking.
	const baseline = selectAutoPortraitClips(parameters, internalFrameResolver),
		analysis = sceneAnalysisDocumentSchema.parse(input.analysis),
		map = cfrTimeMapSchema.parse(input.timeMap),
		index = graphIndex(input.story),
		origin = map.sourceStartUs / 1_000_000,
		end = map.sourceEndUs / 1_000_000,
		scenes = new Map(
			analysis.scenes.map((scene) => [scene.id.toLowerCase(), scene]),
		),
		bounds = new Map<string, { fromFrame: number; toFrame: number }>();
	const frame = (seconds: number, rounding: "CEIL" | "FLOOR") => {
		const value = (seconds - origin) * 30,
			nearest = Math.round(value);
		return Math.abs(value - nearest) <=
			4 *
				Number.EPSILON *
				Math.max(1, Math.abs(seconds * 30), Math.abs(origin * 30))
			? nearest
			: rounding === "CEIL"
				? Math.ceil(value)
				: Math.floor(value);
	};
	for (const interval of index.refs.values()) {
		const scene = scenes.get(interval.sceneId.toLowerCase()),
			actual = scene?.shots.length
				? interval.shotIndex === undefined
					? undefined
					: scene.shots[interval.shotIndex]
				: interval.shotIndex === undefined
					? scene
					: undefined;
		if (
			!actual ||
			actual.startInSeconds !== interval.startInSeconds ||
			actual.endInSeconds !== interval.endInSeconds
		)
			throw new RangeError("STORY_REFERENCE_INVALID");
		// Do not clamp a genuine raw overrun or consult a prepared entry for it.
		if (interval.startInSeconds < origin || interval.endInSeconds > end)
			continue;
		const resolved = internalFrameResolver?.(
			interval.sceneId,
			interval.shotIndex,
		) ?? {
			fromFrame: frame(interval.startInSeconds, "CEIL"),
			toFrame: frame(interval.endInSeconds, "FLOOR"),
		};
		if (resolved.toFrame > resolved.fromFrame)
			bounds.set(interval.ref, resolved);
	}
	type Bundle = {
		ids: Set<string>;
		fromFrame: number;
		toFrame: number;
		score: number[];
	};
	const bundle = (ids: Set<string>): Bundle | undefined => {
		let fromFrame = Infinity,
			toFrame = -Infinity;
		for (const id of ids) {
			const event = index.events.get(id);
			if (!event) throw new RangeError("STORY_REFERENCE_INVALID");
			for (const item of event.evidence) {
				const range = bounds.get(item.ref);
				if (!range) return undefined;
				fromFrame = Math.min(fromFrame, range.fromFrame);
				toFrame = Math.max(toFrame, range.toFrame);
			}
		}
		if (toFrame - fromFrame > input.targetDurationFrames) return undefined;
		return {
			ids,
			fromFrame,
			toFrame,
			score: coverage(input.story.graph, ids, index).score,
		};
	};
	const bundles = new Map<string, Bundle>(),
		key = (ids: Set<string>) =>
			input.story.graph.events
				.filter((event) => ids.has(event.id))
				.map((event) => event.id)
				.join("\n"),
		compareBundles = (a: Bundle, b: Bundle) =>
			compare(a.score, b.score) ||
			a.fromFrame - b.fromFrame ||
			key(a.ids).localeCompare(key(b.ids), "en");
	let expansions = 0,
		exhausted = false;
	search: for (const arc of input.story.graph.arcs) {
		let beam: Bundle[] = [];
		for (const id of [...arc.eventIds].sort(
			(a, b) => index.start(a) - index.start(b) || a.localeCompare(b, "en"),
		)) {
			const next = new Map(beam.map((item) => [key(item.ids), item]));
			for (const previous of [undefined, ...beam]) {
				if (expansions >= MAX_BEAM_EXPANSIONS) {
					exhausted = true;
					break search;
				}
				expansions++;
				const candidate = bundle(
					new Set([...(previous?.ids ?? []), ...index.closure(id)]),
				);
				if (candidate) next.set(key(candidate.ids), candidate);
			}
			beam = [...next.values()].sort(compareBundles).slice(0, BEAM_WIDTH);
			for (const candidate of beam) bundles.set(key(candidate.ids), candidate);
		}
	}
	let best = baseline;
	const quality = (selection: AutoPortraitSelection) => {
		const selected = buildStorySelection({
			...input.story,
			clips: selection.clips,
		});
		return [
			...coverage(input.story.graph, new Set(selected.selectedEventIds), index)
				.score,
			selection.actualDurationFrames,
			-selection.clips.length,
		];
	};
	if (!exhausted)
		for (const anchor of [...bundles.values()]
			.sort(compareBundles)
			.slice(0, MAX_MATERIALIZATIONS)) {
			try {
				const candidate = selectAutoPortraitClips(
					{
						...parameters,
						acceptWindow: (window) =>
							window.fromFrame <= anchor.fromFrame &&
							window.toFrame >= anchor.toFrame &&
							(input.acceptWindow?.(window) ?? true),
					},
					internalFrameResolver,
				);
				if (
					candidate.actualDurationFrames * 5 >=
						baseline.actualDurationFrames * 4 &&
					compare(quality(candidate), quality(best)) < 0
				)
					best = candidate;
			} catch (error) {
				if (error instanceof AutoPortraitSelectionError) continue;
				if (
					error instanceof RangeError &&
					error.message === "Auto portrait search limit exceeded (200000)"
				) {
					exhausted = true;
					best = baseline;
					break;
				}
				throw error;
			}
		}
	const storySelection = buildStorySelection({
		...input.story,
		clips: best.clips,
		...(exhausted ? { reason: "SEARCH_BUDGET" } : {}),
	});
	return {
		...best,
		policyVersion: "aisa-story-window-v1",
		reasonCodes: [
			...best.reasonCodes,
			"STORY_CONTIGUOUS_MICROARC",
			`STORY_${storySelection.reason}`,
		],
		storySelection,
	};
}
