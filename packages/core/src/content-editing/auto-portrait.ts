import { sceneAnalysisDocumentSchema } from "../content-library/analysis";
import {
	cfrTimeMapSchema,
	MAX_EDIT_CLIPS,
	MAX_EDIT_DURATION_FRAMES,
} from "./schema";

const MAX_CANDIDATES = 10_000;
const MAX_SEARCH_EXPANSIONS = 200_000;
const EXCLUDED_TYPES = new Set([
	"ADS",
	"LOGO_IDENT",
	"OPENING_CREDITS",
	"END_CREDITS",
	"BREAK_BUMPER",
	"PROMOTION_OTHER_TITLE",
	"PREVIEW_THIS_TITLE",
]);

/** Factory-owned, in-memory accounting shared by one automatic generation. */
export type PortraitSelectionSearchBudget = {
	readonly usedExpansions: number;
};
const searchBudgets = new WeakMap<
	PortraitSelectionSearchBudget,
	{ used: number }
>();
export function createPortraitSelectionSearchBudget(): PortraitSelectionSearchBudget {
	const state = { used: 0 };
	const budget = Object.freeze({
		get usedExpansions() {
			return state.used;
		},
	});
	searchBudgets.set(budget, state);
	return budget;
}

export type AutoPortraitSelectionInput = {
	analysis: unknown;
	timeMap: unknown;
	targetDurationFrames: number;
	searchBudget?: PortraitSelectionSearchBudget;
	/** Server-owned final-window constraint; never part of a serialized request. */
	acceptWindow?: (window: { fromFrame: number; toFrame: number }) => boolean;
};
/** @internal Only a factory-validated prepared partition supplies replacement candidate bounds. */
export type PortraitCandidateFrameResolver = (
	sceneId: string,
	shotIndex?: number,
) => { fromFrame: number; toFrame: number };
export type AutoPortraitClip = {
	sourceInUs: number;
	durationFrames: number;
	sceneId: string;
	shotIndex?: number;
};
export type AutoPortraitReasonCode =
	| "WHOLE_SHOT_WINDOW"
	| "SCENE_INTERVAL_FALLBACK"
	| "DURATION_UNDER_TARGET"
	| "CLIP_LIMIT_REACHED";
export type AutoPortraitSelection = {
	policyVersion: "aisa-shot-window-v1";
	requestedDurationFrames: number;
	actualDurationFrames: number;
	clips: AutoPortraitClip[];
	reasonCodes: AutoPortraitReasonCode[];
};

export class AutoPortraitSelectionError extends Error {
	readonly code = "NO_ELIGIBLE_WINDOW";
	constructor() {
		super("NO_ELIGIBLE_WINDOW");
		this.name = "AutoPortraitSelectionError";
	}
}

type Candidate = {
	from: number;
	to: number;
	rawFrom: number;
	rawTo: number;
	sceneId: string;
	sceneKey: string;
	sceneStart: number;
	shotIndex?: number;
	rank: number;
};
type Path = {
	from: number;
	to: number;
	changes: number;
	clips: Candidate[];
};
type EndState = {
	position: number;
	best: Path;
	byScene: Map<string, Path>;
};

/** Bound raw observations before schema parsing can clone a scene × shot product. */
function assertCandidateBudget(input: unknown) {
	if (!input || typeof input !== "object") return;
	const scenes = (input as { scenes?: unknown }).scenes;
	if (!Array.isArray(scenes)) return;
	let count = 0;
	for (const scene of scenes) {
		const shots =
			scene && typeof scene === "object"
				? (scene as { shots?: unknown }).shots
				: undefined;
		count += Array.isArray(shots) && shots.length ? shots.length : 1;
		if (count > MAX_CANDIDATES)
			throw new RangeError(
				`Auto portrait candidate limit exceeded (${MAX_CANDIDATES})`,
			);
	}
}

function comparePaths(a: Path, b: Path) {
	const order =
		b.to - b.from - (a.to - a.from) ||
		a.changes - b.changes ||
		a.from - b.from ||
		a.clips.length - b.clips.length;
	if (order) return order;
	for (let index = 0; index < a.clips.length; index++) {
		const difference =
			(a.clips[index]?.rank ?? 0) - (b.clips[index]?.rank ?? 0);
		if (difference) return difference;
	}
	return 0;
}

/**
 * Select real, adjacent source intervals; never claim quality scores or binding proof.
 * At most 10,000 raw intervals and 200,000 search expansions are accepted. Exceeding
 * either budget rejects the selection instead of presenting a partial search as optimal.
 */
export function selectAutoPortraitClips(
	input: AutoPortraitSelectionInput,
	internalFrameResolver?: PortraitCandidateFrameResolver,
): AutoPortraitSelection {
	const target = input.targetDurationFrames;
	if (
		!Number.isSafeInteger(target) ||
		target < 1 ||
		target > MAX_EDIT_DURATION_FRAMES
	)
		throw new RangeError("Expected target duration within 1..5400 frames");
	const searchState =
		input.searchBudget === undefined
			? { used: 0 }
			: searchBudgets.get(input.searchBudget);
	if (!searchState)
		throw new RangeError("Expected a factory-owned search budget");
	if (
		input.acceptWindow !== undefined &&
		typeof input.acceptWindow !== "function"
	)
		throw new RangeError("Expected a server-owned window constraint");
	assertCandidateBudget(input.analysis);
	const analysis = sceneAnalysisDocumentSchema.parse(input.analysis);
	const map = cfrTimeMapSchema.parse(input.timeMap);
	if (!Number.isSafeInteger(Math.round(analysis.duration * 1_000_000)))
		throw new RangeError("Analysis time exceeds the safe microsecond domain");
	const origin = map.sourceStartUs / 1_000_000;
	const end = map.sourceEndUs / 1_000_000;
	const frameCount = map.editingEndFrame - map.editingStartFrame;
	const floatError = (a: number, b: number) =>
		4 * Number.EPSILON * Math.max(1, Math.abs(a), Math.abs(b));
	const atFrame = (seconds: number, rounding: "CEIL" | "FLOOR") => {
		const frame = (seconds - origin) * 30;
		const nearest = Math.round(frame);
		const result =
			Math.abs(frame - nearest) <= floatError(seconds * 30, origin * 30)
				? nearest
				: rounding === "CEIL"
					? Math.ceil(frame)
					: Math.floor(frame);
		if (!Number.isSafeInteger(result))
			throw new RangeError("Analysis frame exceeds the safe integer domain");
		return result;
	};

	const excluded: { from: number; to: number }[] = [];
	const exclusions = analysis.scenes
		.filter((scene) => EXCLUDED_TYPES.has(scene.type.toUpperCase()))
		.map((scene) => ({ from: scene.startInSeconds, to: scene.endInSeconds }))
		.sort((a, b) => a.from - b.from || a.to - b.to);
	for (const interval of exclusions) {
		const previous = excluded.at(-1);
		if (previous && previous.to >= interval.from)
			previous.to = Math.max(previous.to, interval.to);
		else excluded.push({ ...interval });
	}
	const overlapsExclusion = (from: number, to: number) => {
		let low = 0;
		let high = excluded.length;
		while (low < high) {
			const middle = Math.floor((low + high) / 2);
			if ((excluded[middle]?.from ?? Infinity) < to) low = middle + 1;
			else high = middle;
		}
		return low > 0 && (excluded[low - 1]?.to ?? -Infinity) > from;
	};
	const unique = new Map<string, Candidate>();
	for (const scene of analysis.scenes) {
		if (EXCLUDED_TYPES.has(scene.type.toUpperCase())) continue;
		const intervals = scene.shots.length ? scene.shots : [scene];
		intervals.forEach((interval, index) => {
			const fromSeconds = interval.startInSeconds;
			const toSeconds = interval.endInSeconds;
			if (
				fromSeconds < origin - floatError(fromSeconds, origin) ||
				toSeconds > end + floatError(toSeconds, end) ||
				overlapsExclusion(fromSeconds, toSeconds)
			)
				return;
			const replacement = internalFrameResolver?.(
				scene.id,
				scene.shots.length ? index : undefined,
			);
			const from = replacement?.fromFrame ?? atFrame(fromSeconds, "CEIL");
			const to = replacement?.toFrame ?? atFrame(toSeconds, "FLOOR");
			if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to))
				throw new RangeError("Prepared candidate frame exceeds safe bounds");
			if (from < 0 || to > frameCount || to <= from || to - from > target)
				return;
			const sceneKey = scene.id.toLowerCase();
			const key = internalFrameResolver
				? `${from}:${to}:${sceneKey}:${fromSeconds}:${toSeconds}`
				: `${from}:${to}:${sceneKey}`;
			// V3 must retain different raw cuts even when their prepared frames match.
			// Exact same-scene duplicates still keep the first original shot index.
			if (!unique.has(key))
				unique.set(key, {
					from,
					to,
					rawFrom: fromSeconds,
					rawTo: toSeconds,
					sceneId: scene.id,
					sceneKey,
					sceneStart: scene.startInSeconds,
					...(scene.shots.length ? { shotIndex: index } : {}),
					rank: 0,
				});
		});
	}
	const candidates = [...unique.values()].sort(
		(a, b) =>
			a.from - b.from ||
			a.to - b.to ||
			a.sceneStart - b.sceneStart ||
			(a.sceneKey < b.sceneKey ? -1 : a.sceneKey > b.sceneKey ? 1 : 0) ||
			(a.shotIndex ?? -1) - (b.shotIndex ?? -1),
	);
	const byStart = new Map<number, Candidate[]>();
	candidates.forEach((candidate, rank) => {
		candidate.rank = rank;
		const group = byStart.get(candidate.from) ?? [];
		group.push(candidate);
		byStart.set(candidate.from, group);
	});
	let best: Path | undefined;
	for (const start of byStart.keys()) {
		const empty: Path = { from: start, to: start, changes: 0, clips: [] };
		let frontier = new Map<number | string, EndState>([
			[start, { position: start, best: empty, byScene: new Map() }],
		]);
		for (let depth = 0; depth < MAX_EDIT_CLIPS && frontier.size; depth++) {
			const next = new Map<number | string, EndState>();
			for (const state of frontier.values()) {
				const position = state.position;
				for (const candidate of byStart.get(position) ?? []) {
					if (searchState.used >= MAX_SEARCH_EXPANSIONS)
						throw new RangeError(
							`Auto portrait search limit exceeded (${MAX_SEARCH_EXPANSIONS})`,
						);
					searchState.used++;
					if (candidate.to - start > target) continue;
					const previousCut = state.best.clips.at(-1)?.rawTo;
					if (
						internalFrameResolver &&
						previousCut !== undefined &&
						previousCut !== candidate.rawFrom
					)
						continue;
					const extend = (previous: Path): Path => ({
						from: start,
						to: candidate.to,
						changes:
							previous.changes +
							(previous.clips.length &&
							previous.clips.at(-1)?.sceneKey !== candidate.sceneKey
								? 1
								: 0),
						clips: [...previous.clips, candidate],
					});
					let path = extend(state.best);
					const sameScene = state.byScene.get(candidate.sceneKey);
					if (sameScene && sameScene !== state.best) {
						const alternative = extend(sameScene);
						if (comparePaths(alternative, path) < 0) path = alternative;
					}
					if (
						(!input.acceptWindow ||
							input.acceptWindow({ fromFrame: path.from, toFrame: path.to })) &&
						(!best || comparePaths(path, best) < 0)
					)
						best = path;
					// Frame aliases are distinct frontier states in V3: only an exact
					// original raw end may connect to the next original raw start.
					const destinationKey = internalFrameResolver
						? `${candidate.to}:${candidate.rawTo}`
						: candidate.to;
					const destination = next.get(destinationKey);
					if (!destination)
						next.set(destinationKey, {
							position: candidate.to,
							best: path,
							byScene: new Map([[candidate.sceneKey, path]]),
						});
					else {
						if (comparePaths(path, destination.best) < 0)
							destination.best = path;
						const previous = destination.byScene.get(candidate.sceneKey);
						if (!previous || comparePaths(path, previous) < 0)
							destination.byScene.set(candidate.sceneKey, path);
					}
				}
			}
			frontier = next;
		}
	}
	if (!best) throw new AutoPortraitSelectionError();
	const clips = best.clips.map((candidate): AutoPortraitClip => {
		// CEIL integer microseconds preserves the chosen frame through compiler FLOOR.
		const sourceInUs =
			BigInt(map.sourceStartUs) +
			(BigInt(candidate.from) * 1_000_000n + 29n) / 30n;
		if (
			sourceInUs >= BigInt(map.sourceEndUs) ||
			sourceInUs > BigInt(Number.MAX_SAFE_INTEGER)
		)
			throw new RangeError("Selected source time exceeds material bounds");
		return {
			sourceInUs: Number(sourceInUs),
			durationFrames: candidate.to - candidate.from,
			sceneId: candidate.sceneId,
			...(candidate.shotIndex === undefined
				? {}
				: { shotIndex: candidate.shotIndex }),
		};
	});
	const actualDurationFrames = best.to - best.from;
	const reasonCodes: AutoPortraitReasonCode[] = [];
	if (clips.some((clip) => clip.shotIndex !== undefined))
		reasonCodes.push("WHOLE_SHOT_WINDOW");
	if (clips.some((clip) => clip.shotIndex === undefined))
		reasonCodes.push("SCENE_INTERVAL_FALLBACK");
	if (actualDurationFrames < target) {
		reasonCodes.push("DURATION_UNDER_TARGET");
		if (clips.length === MAX_EDIT_CLIPS) reasonCodes.push("CLIP_LIMIT_REACHED");
	}
	return {
		policyVersion: "aisa-shot-window-v1",
		requestedDurationFrames: target,
		actualDurationFrames,
		clips,
		reasonCodes,
	};
}
