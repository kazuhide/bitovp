import { sceneAnalysisDocumentSchema } from "../content-library/analysis";
import {
	type AutoPortraitSelection,
	AutoPortraitSelectionError,
	type AutoPortraitSelectionInput,
	type PortraitCandidateFrameResolver,
	selectAutoPortraitClips,
} from "./auto-portrait";

const EXCLUDED = new Set([
	"ADS",
	"LOGO_IDENT",
	"OPENING_CREDITS",
	"END_CREDITS",
	"BREAK_BUMPER",
	"PROMOTION_OTHER_TITLE",
	"PREVIEW_THIS_TITLE",
]);
export type SemanticPortraitSelection = Omit<
	AutoPortraitSelection,
	"policyVersion" | "reasonCodes"
> & {
	policyVersion: "aisa-scene-cohesion-v2";
	reasonCodes: string[];
};
export type SemanticPortraitSelectionInput = AutoPortraitSelectionInput & {
	query?: string;
};
const normalized = (value: string) =>
	value.normalize("NFKC").toLocaleLowerCase("und");

/**
 * Deterministic metadata relevance, not a highlight-quality prediction. A single
 * scene is preferred only when it retains at least 80% of the best whole-shot
 * duration. No advertising score enters this policy. Search is bounded to 128
 * eligible scenes / 10,000 raw intervals. Without searchBudget every delegated
 * search retains v1's 200,000-expansion bound; supplying one shares that bound
 * across all calls. Reaching a bound rejects, never truncates candidates.
 */
export function selectSemanticPortraitClips(
	input: SemanticPortraitSelectionInput,
	internalFrameResolver?: PortraitCandidateFrameResolver,
): SemanticPortraitSelection {
	if (
		input.query !== undefined &&
		(typeof input.query !== "string" || input.query.length > 512)
	)
		throw new RangeError("Expected query up to 512 characters");
	const terms = [
		...new Set(normalized(input.query ?? "").match(/[\p{L}\p{N}]+/gu) ?? []),
	];
	if (terms.length > 32)
		throw new RangeError("Semantic query term limit exceeded (32)");
	if (input.analysis && typeof input.analysis === "object") {
		const scenes = (input.analysis as { scenes?: unknown }).scenes;
		if (Array.isArray(scenes)) {
			let intervals = 0;
			for (const item of scenes) {
				const shots =
					item && typeof item === "object"
						? (item as { shots?: unknown }).shots
						: undefined;
				intervals += Array.isArray(shots) && shots.length ? shots.length : 1;
				if (intervals > 10_000)
					throw new RangeError("Semantic candidate limit exceeded (10000)");
			}
		}
	}
	const analysis = sceneAnalysisDocumentSchema.parse(input.analysis);
	const matches = (parts: string[]) => {
		const text = normalized(parts.join("\n"));
		return terms.every((term) => text.includes(term));
	};
	const originalIndexes = new Map<string, number[]>();
	const scenes = analysis.scenes.flatMap((scene) => {
		if (EXCLUDED.has(scene.type.toUpperCase())) return [scene];
		const contextMatches = matches([
			scene.title,
			scene.summary,
			scene.verboseSummary,
			...scene.keywords,
		]);
		if (!scene.shots.length) return contextMatches ? [scene] : [];
		const indexes: number[] = [];
		const shots = scene.shots.filter((shot, index) => {
			const keep =
				contextMatches ||
				matches([
					shot.detailedDescription,
					...shot.keywords,
					...shot.mainSubjects.flatMap((subject) => [
						subject.classification,
						subject.description,
					]),
				]);
			if (keep) indexes.push(index);
			return keep;
		});
		if (!shots.length) return [];
		originalIndexes.set(scene.id, indexes);
		return [{ ...scene, shots }];
	});
	const eligible = scenes.filter(
		(scene) => !EXCLUDED.has(scene.type.toUpperCase()),
	);
	if (eligible.length > 128)
		throw new RangeError("Semantic scene limit exceeded (128)");
	const projected = { ...analysis, scenes };
	const select = (scenes: typeof analysis.scenes) =>
		selectAutoPortraitClips(
			{ ...input, analysis: { ...projected, scenes } },
			internalFrameResolver
				? (sceneId, index) =>
						internalFrameResolver(
							sceneId,
							index === undefined
								? undefined
								: (originalIndexes.get(sceneId)?.[index] ?? index),
						)
				: undefined,
		);
	const best = select(scenes);
	let cohesive: AutoPortraitSelection | undefined;
	for (const scene of eligible) {
		const excluded = scenes.filter(
			(item) =>
				EXCLUDED.has(item.type.toUpperCase()) &&
				item.startInSeconds < scene.endInSeconds &&
				item.endInSeconds > scene.startInSeconds,
		);
		try {
			const candidate = select([scene, ...excluded]);
			if (
				!cohesive ||
				candidate.actualDurationFrames > cohesive.actualDurationFrames ||
				(candidate.actualDurationFrames === cohesive.actualDurationFrames &&
					(candidate.clips[0]?.sourceInUs ?? Infinity) <
						(cohesive.clips[0]?.sourceInUs ?? Infinity))
			)
				cohesive = candidate;
		} catch (error) {
			if (!(error instanceof AutoPortraitSelectionError)) throw error;
		}
	}
	const useCohesion =
		cohesive !== undefined &&
		cohesive.actualDurationFrames * 5 >= best.actualDurationFrames * 4;
	const chosen = useCohesion && cohesive ? cohesive : best;
	return {
		...chosen,
		policyVersion: "aisa-scene-cohesion-v2",
		clips: chosen.clips.map((clip) => ({
			...clip,
			...(clip.shotIndex !== undefined
				? {
						shotIndex:
							originalIndexes.get(clip.sceneId)?.[clip.shotIndex] ??
							clip.shotIndex,
					}
				: {}),
		})),
		reasonCodes: [
			...chosen.reasonCodes,
			useCohesion ? "SCENE_COHESION" : "DURATION_FALLBACK",
			...(terms.length ? ["QUERY_CONTEXT_MATCH"] : []),
		],
	};
}
