import { z } from "zod";
import {
	localStoryBlueprintCoherenceIssues,
	localStorySelectedPlanIssues,
} from "./local-story-coherence";
import {
	type LocalStoryBlueprint,
	type LocalStoryCorpus,
	type LocalStoryInput,
	type LocalStoryMode,
	localStoryCorpusSchema,
	localStoryModeSchema,
} from "./local-story-contracts";
import {
	LocalStoryError,
	validateLocalStoryBlueprint,
	validateLocalStoryCorpusEvents,
} from "./local-story-input";
import {
	createLocalStoryClipSelector,
	type LocalStorySelectionResult,
	selectLocalStoryClips,
} from "./local-story-planner";
import { hashEditingEvidence } from "./verify-automatic-binding";

export const LOCAL_STORY_CHOICE_PROMPT_VERSION =
	"local-story-choice-v1" as const;
export const LOCAL_STORY_CHOICE_POLICY = Object.freeze({
	version: "local-story-feasible-choice-policy-v1",
	maxPlans: 24,
	maxEvaluations: 20_000,
	beamWidth: 96,
	shortTargetFrames: 900,
	shortMaxBeats: 3,
	longMaxBeats: 5,
	preferredDurationFraction: 0.8,
	sourceBands: 6,
});
export const LOCAL_STORY_CHOICE_POLICY_FINGERPRINT = hashEditingEvidence(
	LOCAL_STORY_CHOICE_POLICY,
);
export const localStoryChoiceSchema = z.strictObject({
	planId: z
		.string()
		.regex(/^p(0|[1-9][0-9]*)$/)
		.refine((v) => !/[\r\n]/.test(v)),
	message: z.string().trim().min(1).max(100),
	uncertainty: z.string().max(160),
});
export type LocalStoryChoice = z.infer<typeof localStoryChoiceSchema>;
export type FeasibleStoryPlan = {
	id: string;
	eventIds: string[];
	blueprintSkeleton: Pick<LocalStoryBlueprint, "mode" | "beats">;
	selection: LocalStorySelectionResult;
	actualDurationFrames: number;
};
export type FeasibleStoryChoices = {
	version: "local-story-feasible-choices-v1";
	policyFingerprint: string;
	inputHash: string;
	ledgerHash: string;
	mode: LocalStoryMode;
	targetDurationFrames: number;
	hash: string;
	plans: FeasibleStoryPlan[];
	diagnostics: { evaluated: number; truncated: boolean };
};
type BuildOptions = {
	input: LocalStoryInput;
	ledger: LocalStoryCorpus;
	mode: LocalStoryMode;
	targetDurationFrames: number;
	maxPlans?: number;
	maxEvaluations?: number;
};
type Candidate = Omit<FeasibleStoryPlan, "id"> & {
	indices: number[];
	cohesion: number;
	band: string;
	subjects: string[];
};
function invalid(): never {
	throw new LocalStoryError("LOCAL_STORY_CHOICE_INVALID");
}
function bounded(value: number, maximum: number) {
	if (!Number.isSafeInteger(value) || value < 1 || value > maximum) invalid();
	return value;
}
function signed(
	value: Omit<FeasibleStoryChoices, "hash">,
): FeasibleStoryChoices {
	return { ...value, hash: hashEditingEvidence(value) };
}
function verifyFrontier(choices: FeasibleStoryChoices) {
	const { hash, ...data } = choices;
	if (
		data.version !== "local-story-feasible-choices-v1" ||
		data.policyFingerprint !== LOCAL_STORY_CHOICE_POLICY_FINGERPRINT ||
		hashEditingEvidence(data) !== hash ||
		data.plans.length > 24 ||
		data.plans.some((p, i) => p.id !== `p${i}`)
	)
		invalid();
}
export function sliceFeasibleStoryChoices(
	choices: FeasibleStoryChoices,
	count: number,
): FeasibleStoryChoices {
	verifyFrontier(choices);
	bounded(count, 24);
	const { hash: _hash, ...data } = structuredClone(choices);
	return signed({ ...data, plans: data.plans.slice(0, count) });
}
function checkedPlan(
	options: Pick<BuildOptions, "input" | "ledger" | "targetDurationFrames">,
	blueprint: LocalStoryBlueprint,
	select?: ReturnType<typeof createLocalStoryClipSelector>,
) {
	const parsed = validateLocalStoryBlueprint({
		ledger: options.ledger,
		blueprint,
	});
	if (localStoryBlueprintCoherenceIssues(parsed).length) invalid();
	const selection = select
		? select({
				blueprint: parsed,
				targetDurationFrames: options.targetDurationFrames,
			})
		: selectLocalStoryClips({ ...options, blueprint: parsed });
	if (
		localStorySelectedPlanIssues({ ...options, blueprint: parsed, selection })
			.length
	)
		invalid();
	return { blueprint: parsed, selection };
}
function ownedSkeleton(
	mode: "FLOW" | "THEME",
	eventIds: string[],
	roleById: Map<string, LocalStoryCorpus["events"][number]["role"]>,
): FeasibleStoryPlan["blueprintSkeleton"] {
	return {
		mode,
		beats: eventIds.map((id, i) => ({
			id: `b${i + 1}`,
			role: roleById.get(id) ?? invalid(),
			eventIds: [id],
			requires: i && mode === "FLOW" ? [`b${i}`] : [],
		})),
	};
}

/** Compare complete, already validated stories. These signals never rank shots. */
function diverse(candidates: Candidate[], limit: number, target: number) {
	const remaining = [...candidates],
		result: Candidate[] = [];
	const subjects = new Set<string>(),
		bands = new Set<string>(),
		modes = new Set<string>();
	const overlaps = new Map<Candidate, number>();
	const preferred = (p: Candidate) =>
		p.actualDurationFrames >= target * 0.8 ? 1 : 0;
	while (remaining.length && result.length < limit) {
		let best = 0,
			bestValue = -Infinity,
			bestTier = -1;
		for (const [i, candidate] of remaining.entries()) {
			const tier = preferred(candidate);
			const overlap = overlaps.get(candidate) ?? 0;
			const value =
				candidate.cohesion +
				(candidate.actualDurationFrames / target) * 3 +
				candidate.subjects.filter((s) => !subjects.has(s)).length +
				(bands.has(candidate.band) ? 0 : 3) +
				(modes.has(candidate.blueprintSkeleton.mode) ? 0 : 3) -
				overlap * 2;
			if (tier > bestTier || (tier === bestTier && value > bestValue)) {
				best = i;
				bestValue = value;
				bestTier = tier;
			}
		}
		const chosen = remaining.splice(best, 1)[0];
		if (!chosen) invalid();
		result.push(chosen);
		bands.add(chosen.band);
		modes.add(chosen.blueprintSkeleton.mode);
		for (const subject of chosen.subjects) subjects.add(subject);
		for (const candidate of remaining) {
			const overlap =
				chosen.eventIds.filter((id) => candidate.eventIds.includes(id)).length /
				Math.max(chosen.eventIds.length, candidate.eventIds.length);
			overlaps.set(candidate, Math.max(overlaps.get(candidate) ?? 0, overlap));
		}
	}
	return result;
}

/** Bounded beam of complete stories; every admitted state passes the existing selector. */
export function buildFeasibleStoryChoices(
	options: BuildOptions,
): FeasibleStoryChoices {
	const mode = localStoryModeSchema.parse(options.mode),
		target = bounded(options.targetDurationFrames, 5400),
		maxPlans = bounded(options.maxPlans ?? 24, 24),
		maxEvaluations = bounded(options.maxEvaluations ?? 20_000, 20_000);
	const ledger = localStoryCorpusSchema.parse(options.ledger);
	validateLocalStoryCorpusEvents(options.input, ledger.events);
	const select = createLocalStoryClipSelector({ input: options.input, ledger });
	const shots = new Map(options.input.shots.map((s) => [s.ref, s]));
	const roleById = new Map(ledger.events.map((e) => [e.id, e.role]));
	const originalOrdinal = new Map(ledger.events.map((e, i) => [e.id, i]));
	const starts = new Map(
		ledger.events.map((e) => [
			e.id,
			Math.min(...e.refs.map((r) => shots.get(r)?.fromFrame ?? Infinity)),
		]),
	);
	const start = (id: string) => starts.get(id) ?? Infinity;
	const events = [...ledger.events].sort(
		(a, b) =>
			start(a.id) - start(b.id) ||
			(originalOrdinal.get(a.id) ?? 0) - (originalOrdinal.get(b.id) ?? 0),
	);
	const modes = mode === "AUTO" ? (["FLOW", "THEME"] as const) : [mode];
	const maxBeats = target <= 900 ? 3 : 5;
	const perLevel = Math.max(1, Math.floor(maxEvaluations / maxBeats));
	let evaluated = 0,
		truncated = false;
	const pool: Candidate[] = [];
	let beam: Candidate[] = [];
	const seen = new Set<string>();
	for (
		let depth = 1;
		depth <= maxBeats && evaluated < maxEvaluations;
		depth++
	) {
		const level: Candidate[] = [];
		const parents: { indices: number[]; mode: "FLOW" | "THEME" }[] =
			depth === 1
				? modes.map((m) => ({ indices: [], mode: m }))
				: beam.map((p) => ({
						indices: p.indices,
						mode: p.blueprintSkeleton.mode,
					}));
		if (!parents.length) break;
		const levelLimit =
			depth === maxBeats
				? maxEvaluations
				: Math.min(maxEvaluations, evaluated + perLevel);
		let stopped = false;
		// Round-robin across source-diverse parents before widening each continuation.
		for (let offset = 1; offset <= events.length && !stopped; offset++) {
			for (const parent of parents) {
				const index = (parent.indices.at(-1) ?? -1) + offset;
				if (index >= events.length) continue;
				if (evaluated >= levelLimit) {
					truncated = true;
					stopped = true;
					break;
				}
				const indices = [...parent.indices, index],
					selected = indices.map((i) => events[i]);
				if (selected.some((e) => !e)) invalid();
				const eventIds = selected.map((e) => e?.id ?? invalid());
				const signature = `${parent.mode}:${eventIds.join(",")}`;
				if (seen.has(signature)) continue;
				seen.add(signature);
				evaluated++;
				const blueprint: LocalStoryBlueprint = {
					...ownedSkeleton(parent.mode, eventIds, roleById),
					message: "出来事を紹介する。",
					uncertainty: "",
				};
				try {
					const { selection } = checkedPlan(
						{ ...options, ledger },
						blueprint,
						select,
					);
					const names = [
						...new Set(selected.flatMap((e) => e?.subjects ?? [])),
					];
					let cohesion = 0;
					for (let i = 1; i < selected.length; i++) {
						const a = selected[i - 1],
							b = selected[i];
						if (!a || !b) invalid();
						cohesion +=
							a.subjects.filter((s) => b.subjects.includes(s)).length * 2;
						const scenesA = new Set(a.refs.map((r) => shots.get(r)?.sceneId));
						if (b.refs.some((r) => scenesA.has(shots.get(r)?.sceneId)))
							cohesion++;
						cohesion +=
							1 / (1 + Math.max(0, start(b.id) - start(a.id)) / target);
						const progression = [
							"CONTEXT",
							"ACTION",
							"CHANGE",
							"OUTCOME",
							"POINT",
						];
						if (a.role !== b.role)
							cohesion +=
								progression.indexOf(b.role) >= progression.indexOf(a.role)
									? 0.5
									: -0.5;
					}
					const duration =
						options.input.timeMap.editingEndFrame -
						options.input.timeMap.editingStartFrame;
					const band = JSON.stringify([
						Math.min(
							5,
							Math.floor(
								(start(eventIds[0] ?? "") / Math.max(1, duration)) * 6,
							),
						),
						names,
					]);
					level.push({
						indices,
						cohesion,
						band,
						subjects: names,
						eventIds,
						blueprintSkeleton: { mode: blueprint.mode, beats: blueprint.beats },
						selection,
						actualDurationFrames: selection.actualDurationFrames,
					});
				} catch (error) {
					if (
						!(error instanceof LocalStoryError) ||
						error.code !== "LOCAL_STORY_NO_FITTING_PLAN"
					)
						throw error;
				}
			}
		}
		pool.push(...level);
		if (level.length > LOCAL_STORY_CHOICE_POLICY.beamWidth) truncated = true;
		beam = diverse(level, LOCAL_STORY_CHOICE_POLICY.beamWidth, target);
	}
	const plans = diverse(pool, maxPlans, target).map((p, i) => ({
		id: `p${i}`,
		eventIds: p.eventIds,
		blueprintSkeleton: p.blueprintSkeleton,
		selection: p.selection,
		actualDurationFrames: p.actualDurationFrames,
	}));
	return signed({
		version: "local-story-feasible-choices-v1",
		policyFingerprint: LOCAL_STORY_CHOICE_POLICY_FINGERPRINT,
		inputHash: hashEditingEvidence(options.input),
		ledgerHash: hashEditingEvidence(options.ledger),
		mode,
		targetDurationFrames: target,
		plans,
		diagnostics: { evaluated, truncated },
	});
}

/** A native choice never supplies roles, graph structure or executable timing. */
export function compileFeasibleStoryChoice(options: {
	input: LocalStoryInput;
	ledger: LocalStoryCorpus;
	choices: FeasibleStoryChoices;
	choice: unknown;
	requestedMode: LocalStoryMode;
}): { blueprint: LocalStoryBlueprint; selection: LocalStorySelectionResult } {
	const { choices } = options;
	verifyFrontier(choices);
	if (
		choices.inputHash !== hashEditingEvidence(options.input) ||
		choices.ledgerHash !== hashEditingEvidence(options.ledger) ||
		choices.mode !== options.requestedMode
	)
		invalid();
	const choice = localStoryChoiceSchema.parse(options.choice);
	const plan = choices.plans.find((p) => p.id === choice.planId);
	if (
		!plan ||
		(options.requestedMode !== "AUTO" &&
			plan.blueprintSkeleton.mode !== options.requestedMode) ||
		plan.eventIds.length < 1 ||
		plan.eventIds.length > (choices.targetDurationFrames <= 900 ? 3 : 5) ||
		hashEditingEvidence(plan.eventIds) !==
			hashEditingEvidence(
				plan.blueprintSkeleton.beats.flatMap((b) => b.eventIds),
			) ||
		plan.blueprintSkeleton.beats.some((b) => b.eventIds.length !== 1)
	)
		invalid();
	const expectedSkeleton = ownedSkeleton(
		plan.blueprintSkeleton.mode,
		plan.eventIds,
		new Map(options.ledger.events.map((e) => [e.id, e.role])),
	);
	if (
		hashEditingEvidence(expectedSkeleton) !==
		hashEditingEvidence(plan.blueprintSkeleton)
	)
		invalid();
	const result = checkedPlan(
		{ ...options, targetDurationFrames: choices.targetDurationFrames },
		{
			...plan.blueprintSkeleton,
			message: choice.message,
			uncertainty: choice.uncertainty,
		},
	);
	if (
		hashEditingEvidence(result.selection) !==
			hashEditingEvidence(plan.selection) ||
		result.selection.actualDurationFrames !== plan.actualDurationFrames
	)
		invalid();
	return result;
}
