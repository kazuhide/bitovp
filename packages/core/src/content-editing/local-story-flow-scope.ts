import {
	LOCAL_STORY_PLAN_VALIDATION_POLICY,
	localStoryBlueprintCoherenceIssues,
	localStorySelectedPlanIssues,
} from "./local-story-coherence";
import type { LocalStoryBlueprint } from "./local-story-contracts";
import {
	type BoundLocalStoryFlowClosure,
	evaluateLocalStoryFlowClosure,
	LOCAL_STORY_FLOW_CLOSURE_POLICY,
	type LocalStoryFlowClosureResult,
	type LocalStoryFlowClosureStateEvidence,
	localStoryFlowClosureStateEvidence,
	prepareLocalStoryFlowClosure,
} from "./local-story-flow-closure";
import {
	type LocalStoryFlowContextSourceBinding,
	localStoryFlowContextSourceEvidence,
	type PreparedLocalStoryFlowContextSource,
	type SourceEvidence,
} from "./local-story-flow-context";
import {
	type BoundLocalStoryFlowContextTree,
	type LocalStoryFlowContextTreeEvidence,
	localStoryFlowContextTreeEvidence,
} from "./local-story-flow-context-tree";
import type { LocalStoryFlowLeafPage } from "./local-story-flow-manifest";
import {
	type BoundLocalStoryFlowRouteStep,
	buildLocalStoryFlowRouteExpectation,
	buildLocalStoryFlowRouteStep,
	LOCAL_STORY_FLOW_ROUTE_POLICY,
	type LocalStoryFlowRouteStepEvidence,
	localStoryFlowRouteExpectationEvidence,
	localStoryFlowRouteStepEvidence,
} from "./local-story-flow-route";
import {
	LocalStoryError,
	validateLocalStoryBlueprint,
} from "./local-story-input";
import {
	type LocalStorySelectionResult,
	selectLocalStoryClips,
} from "./local-story-planner";
import { hashEditingEvidence as hash } from "./verify-automatic-binding";

export const LOCAL_STORY_FLOW_SCOPE_POLICY = Object.freeze({
	version: "local-story-flow-scope-policy-v1",
	closurePolicyHash: hash(LOCAL_STORY_FLOW_CLOSURE_POLICY),
	routePolicyHash: hash(LOCAL_STORY_FLOW_ROUTE_POLICY),
	legacyPlanValidationPolicy: LOCAL_STORY_PLAN_VALIDATION_POLICY,
	maxAcceptedSteps: 64,
	candidateEventLimit: LOCAL_STORY_FLOW_CLOSURE_POLICY.eventLimit,
	maxAlternatives: 1024,
	traceRule: "rebuild-whole-owned-root-to-finalize-prefix-v1",
	alternativeRule: "all-original-cartesian-tuples-no-filter-v1",
	dependencyRule: "earlier-beat-and-transitive-requires-ancestor-v1",
	scopeClockStatus: "PENDING",
	planClockStatus: "LEGACY_FORWARD_COVERAGE_VALIDATED",
	strictEventMomentOrder: "NOT_PROVEN",
	plannerRule: "unchanged-full-source-selector-and-selected-checks-v1",
});
export type LocalStoryFlowScopeErrorCode =
	| "LOCAL_STORY_FLOW_SCOPE_INVALID"
	| "LOCAL_STORY_FLOW_SCOPE_TRACE_INVALID"
	| "LOCAL_STORY_FLOW_SCOPE_TRACE_LIMIT"
	| "LOCAL_STORY_FLOW_SCOPE_ALTERNATIVE_INVALID"
	| "LOCAL_STORY_FLOW_SCOPE_DEPENDENCY_INVALID"
	| "LOCAL_STORY_FLOW_PLAN_INVALID";
type EventRef = { kind: "EVENT"; eventId: string };
type Origin = { ownerNodeId: string; index: number };
type Detail = { alternativeIndex: number | null; origin: Origin | null };
export class LocalStoryFlowScopeError extends Error {
	readonly detail: Readonly<Detail>;
	constructor(
		readonly code: LocalStoryFlowScopeErrorCode,
		detail: Detail = { alternativeIndex: null, origin: null },
	) {
		super(code);
		this.name = "LocalStoryFlowScopeError";
		this.detail = Object.freeze({
			alternativeIndex: detail.alternativeIndex,
			origin: detail.origin ? Object.freeze({ ...detail.origin }) : null,
		});
	}
}
function requireScope(
	value: unknown,
	code: LocalStoryFlowScopeErrorCode = "LOCAL_STORY_FLOW_SCOPE_INVALID",
	detail?: Detail,
): asserts value {
	if (!value) throw new LocalStoryFlowScopeError(code, detail);
}
function freeze<T>(value: T): T {
	if (value && typeof value === "object") {
		for (const child of Object.values(value)) freeze(child);
		Object.freeze(value);
	}
	return value;
}
function plain<T>(
	value: T,
	fields: string[],
	code: LocalStoryFlowScopeErrorCode = "LOCAL_STORY_FLOW_SCOPE_INVALID",
): T & Record<string, unknown> {
	try {
		requireScope(
			value !== null &&
				typeof value === "object" &&
				Object.getPrototypeOf(value) === Object.prototype &&
				!Array.isArray(value),
			code,
		);
		const d = Object.getOwnPropertyDescriptors(value);
		requireScope(
			Object.getOwnPropertySymbols(value).length === 0 &&
				Object.keys(d).length === fields.length &&
				fields.every((k) => Object.hasOwn(d, k)),
			code,
		);
		for (const p of Object.values(d))
			requireScope("value" in p && p.enumerable && p.value !== undefined, code);
		return Object.fromEntries(
			Object.entries(d).map(([k, p]) => [k, p.value]),
		) as T & Record<string, unknown>;
	} catch {
		throw new LocalStoryFlowScopeError(code);
	}
}
function equalData(a: unknown, b: unknown): boolean {
	if (a === null || typeof a !== "object") return Object.is(a, b);
	if (
		b === null ||
		typeof b !== "object" ||
		Array.isArray(a) !== Array.isArray(b)
	)
		return false;
	const keys = Object.keys(a).sort(),
		other = Object.keys(b).sort();
	return (
		keys.length === other.length &&
		keys.every(
			(k, i) =>
				k === other[i] && equalData(Reflect.get(a, k), Reflect.get(b, k)),
		)
	);
}
type Options = {
	source: PreparedLocalStoryFlowContextSource;
	tree: BoundLocalStoryFlowContextTree;
	steps: readonly BoundLocalStoryFlowRouteStep[];
};
type Card = Extract<
	LocalStoryFlowLeafPage["data"]["items"][number],
	{ kind: "GROUNDED_LEAF_EVENT_CARD" }
>;
type Exposure =
	LocalStoryFlowRouteStepEvidence["after"]["navigation"]["exposedPages"][number];
type Choice = { beatId: string; eventId: string };
type Alternative = {
	index: number;
	choices: Choice[];
	closureResultHash: string;
	dependencyCheckHash: string;
};
export type BoundLocalStoryFlowScope = Readonly<object>;
export type LocalStoryFlowScopeEvidence = {
	version: "local-story-flow-scope-v1";
	sourceBinding: LocalStoryFlowContextSourceBinding;
	sourceBindingHash: string;
	treeHash: string;
	fullGraphHash: string;
	policyHash: string;
	targetFrames: number;
	trace: {
		refs: {
			phase: LocalStoryFlowRouteStepEvidence["phase"];
			nodeId: string;
			stepHash: string;
			observationHash: string;
			expectationHash: string;
			inputHash: string;
			rawOutputHash: string;
		}[];
		rootStepHash: string;
		finalStepHash: string;
		acceptedStepCount: number;
		traceHash: string;
	};
	closure: LocalStoryFlowClosureStateEvidence;
	seeds: EventRef[];
	closureResult: LocalStoryFlowClosureResult;
	candidateCards: Card[];
	leafExposures: Exposure[];
	blueprint: LocalStoryBlueprint;
	blueprintHash: string;
	alternatives: Alternative[];
	combinationCount: number;
	alternativeChecksHash: string;
	clockStatus: "PENDING";
	scopeHash: string;
};
export type BoundLocalStoryFlowPlan = Readonly<object>;
export type LocalStoryFlowPlanEvidence = {
	version: "local-story-flow-plan-v1";
	sourceBindingHash: string;
	treeHash: string;
	scopeHash: string;
	policyHash: string;
	targetFrames: number;
	selectedAlternativeIndex: number;
	selection: LocalStorySelectionResult;
	selectionHash: string;
	clock: {
		status: "LEGACY_FORWARD_COVERAGE_VALIDATED";
		strictEventMomentOrder: "NOT_PROVEN";
	};
	planHash: string;
};
type State = {
	source: SourceEvidence;
	tree: LocalStoryFlowContextTreeEvidence;
	options: Options;
	steps: BoundLocalStoryFlowRouteStep[];
	closure: BoundLocalStoryFlowClosure;
	evidence: LocalStoryFlowScopeEvidence;
};
const scopes = new WeakMap<BoundLocalStoryFlowScope, State>();
const plans = new WeakMap<
	BoundLocalStoryFlowPlan,
	{ scope: BoundLocalStoryFlowScope; evidence: LocalStoryFlowPlanEvidence }
>();
export function localStoryFlowScopeEvidence(
	scope: BoundLocalStoryFlowScope,
): LocalStoryFlowScopeEvidence {
	const state = scopes.get(scope);
	requireScope(state);
	return structuredClone(state.evidence);
}
function stepsArray(value: unknown): BoundLocalStoryFlowRouteStep[] {
	const code = "LOCAL_STORY_FLOW_SCOPE_TRACE_INVALID";
	try {
		requireScope(
			Array.isArray(value) &&
				Object.getPrototypeOf(value) === Array.prototype &&
				Object.getOwnPropertySymbols(value).length === 0,
			code,
		);
		const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
		requireScope(Number.isSafeInteger(length) && length >= 3, code);
		requireScope(
			length <= LOCAL_STORY_FLOW_SCOPE_POLICY.maxAcceptedSteps,
			"LOCAL_STORY_FLOW_SCOPE_TRACE_LIMIT",
		);
		const d = Object.getOwnPropertyDescriptors(value);
		requireScope(Object.keys(d).length === length + 1, code);
		return Array.from({ length }, (_, i) => {
			const p = d[String(i)];
			requireScope(p && "value" in p && p.enumerable, code);
			return p.value;
		});
	} catch (error) {
		if (error instanceof LocalStoryFlowScopeError) throw error;
		throw new LocalStoryFlowScopeError(code);
	}
}
function rebuildTrace(options: Options) {
	const original = stepsArray(options.steps),
		rebuilt: BoundLocalStoryFlowRouteStep[] = [],
		rows: LocalStoryFlowRouteStepEvidence[] = [];
	for (const [index, step] of original.entries()) {
		const old = localStoryFlowRouteStepEvidence(step),
			phase = old.phase,
			previous = rebuilt.at(-1),
			previousRow = rows.at(-1);
		requireScope(
			(index === 0
				? phase === "ROOT"
				: index === original.length - 1
					? phase === "FINALIZE"
					: phase !== "ROOT" && phase !== "FINALIZE") &&
				old.rawOutput.unresolved.length === 0,
			"LOCAL_STORY_FLOW_SCOPE_TRACE_INVALID",
		);
		if (previousRow)
			requireScope(
				old.expectation.continuation.kind === "AFTER_STEP" &&
					old.expectation.continuation.previousStepHash ===
						previousRow.stepHash,
				"LOCAL_STORY_FLOW_SCOPE_TRACE_INVALID",
			);
		let expectation: ReturnType<typeof buildLocalStoryFlowRouteExpectation>;
		if (phase === "ROOT")
			expectation = buildLocalStoryFlowRouteExpectation({
				phase,
				source: options.source,
				tree: options.tree,
				targetFrames: old.expectation.input.targetFrames,
			});
		else {
			requireScope(previous, "LOCAL_STORY_FLOW_SCOPE_TRACE_INVALID");
			expectation =
				phase === "BRANCH" || phase === "LEAF"
					? buildLocalStoryFlowRouteExpectation({
							phase,
							previousStep: previous,
							nodeId: old.expectation.input.nodeId,
						})
					: buildLocalStoryFlowRouteExpectation({
							phase,
							previousStep: previous,
						});
		}
		requireScope(
			equalData(
				old.expectation,
				localStoryFlowRouteExpectationEvidence(expectation),
			),
			"LOCAL_STORY_FLOW_SCOPE_TRACE_INVALID",
		);
		const handle = buildLocalStoryFlowRouteStep({
				expectation,
				output: old.rawOutput,
			}),
			row = localStoryFlowRouteStepEvidence(handle);
		requireScope(equalData(row, old), "LOCAL_STORY_FLOW_SCOPE_TRACE_INVALID");
		rebuilt.push(handle);
		rows.push(row);
	}
	return { rebuilt, rows };
}
function alternativeChecks(
	source: SourceEvidence,
	closure: BoundLocalStoryFlowClosure,
	cards: Card[],
	blueprint: LocalStoryBlueprint,
): Alternative[] {
	const code = "LOCAL_STORY_FLOW_SCOPE_ALTERNATIVE_INVALID",
		candidateIds = new Set(cards.map((c) => c.id));
	let combinationCount = 1;
	for (const b of blueprint.beats) combinationCount *= b.eventIds.length;
	requireScope(
		Number.isSafeInteger(combinationCount) &&
			combinationCount <= LOCAL_STORY_FLOW_SCOPE_POLICY.maxAlternatives,
		code,
	);
	const ancestors = new Map<string, Set<string>>();
	for (const b of blueprint.beats) {
		const all = new Set(b.requires);
		for (const parent of b.requires) {
			const earlier = ancestors.get(parent);
			requireScope(earlier, "LOCAL_STORY_FLOW_SCOPE_DEPENDENCY_INVALID");
			for (const id of earlier) all.add(id);
		}
		ancestors.set(b.id, all);
	}
	let tuples: Choice[][] = [[]];
	for (const b of blueprint.beats)
		tuples = tuples.flatMap((prefix) =>
			b.eventIds.map((eventId) => [...prefix, { beatId: b.id, eventId }]),
		);
	return tuples.map((choices, index) => {
		const ids = new Set(choices.map((c) => c.eventId)),
			detail: Detail = { alternativeIndex: index, origin: null };
		requireScope(
			ids.size === choices.length &&
				choices.every((c) => candidateIds.has(c.eventId)),
			code,
			detail,
		);
		const seeds = source.manifest.items.flatMap((i) =>
			i.kind === "GROUNDED_LEAF_EVENT_CARD" && ids.has(i.id)
				? [{ kind: "EVENT" as const, eventId: i.id }]
				: [],
		);
		const result = evaluateLocalStoryFlowClosure({ state: closure, seeds });
		if (result.status !== "COMPLETE")
			detail.origin =
				result.status === "PENDING_HARD_CHOICE"
					? result.pending.origin
					: result.failure.origin;
		requireScope(
			result.status === "COMPLETE" &&
				equalData(
					result.requiredEvents.map((e) => e.ref),
					seeds,
				),
			code,
			detail,
		);
		const rows: {
			origin: Origin;
			prerequisite: EventRef;
			dependent: EventRef;
			prerequisiteBeatId: string;
			dependentBeatId: string;
			ancestorBeatIds: string[];
		}[] = [];
		requireScope(result.temporalRequirements, code, detail);
		for (const r of result.temporalRequirements)
			for (const prerequisite of r.prerequisites)
				for (const dependent of r.dependents) {
					const p = choices.findIndex(
							(c) => c.eventId === prerequisite.eventId,
						),
						t = choices.findIndex((c) => c.eventId === dependent.eventId),
						pc = choices[p],
						tc = choices[t];
					requireScope(
						pc && tc && p < t,
						"LOCAL_STORY_FLOW_SCOPE_DEPENDENCY_INVALID",
						{ alternativeIndex: index, origin: r.origin },
					);
					const set = ancestors.get(tc.beatId);
					requireScope(set, "LOCAL_STORY_FLOW_SCOPE_DEPENDENCY_INVALID", {
						alternativeIndex: index,
						origin: r.origin,
					});
					requireScope(
						set.has(pc.beatId),
						"LOCAL_STORY_FLOW_SCOPE_DEPENDENCY_INVALID",
						{ alternativeIndex: index, origin: r.origin },
					);
					rows.push({
						origin: r.origin,
						prerequisite,
						dependent,
						prerequisiteBeatId: pc.beatId,
						dependentBeatId: tc.beatId,
						ancestorBeatIds: blueprint.beats
							.filter((b) => set.has(b.id))
							.map((b) => b.id),
					});
				}
		return {
			index,
			choices,
			closureResultHash: result.resultHash,
			dependencyCheckHash: hash({
				version: "local-story-flow-alternative-dependencies-v1",
				choices,
				closureResultHash: result.resultHash,
				rows,
			}),
		};
	});
}
function requiredExposures(
	source: SourceEvidence,
	rows: LocalStoryFlowRouteStepEvidence[],
	last: LocalStoryFlowRouteStepEvidence,
): Exposure[] {
	const code = "LOCAL_STORY_FLOW_SCOPE_TRACE_INVALID",
		ids = new Set(
			last.after.closureResult.requiredEvents.map((e) => e.ref.eventId),
		);
	requireScope(last.after.knownRequiredExposureGaps.length === 0, code);
	return source.pages.flatMap((page) => {
		if (
			!page.data.items.some(
				(i) => i.kind === "GROUNDED_LEAF_EVENT_CARD" && ids.has(i.id),
			)
		)
			return [];
		const row = last.after.navigation.exposedPages.find(
			(r) => r.pageId === page.pageId,
		);
		requireScope(
			row &&
				row.pageHash === page.pageHash &&
				row.dataHash === page.dataHash &&
				rows.some((e) => {
					const p = e.expectation.input.orderedInputProofs[0];
					return (
						e.phase === "LEAF" &&
						e.observationHash === row.observationHash &&
						e.rawOutput.nodeId === row.nodeId &&
						p?.kind === "LEAF_PAGE" &&
						p.pageId === page.pageId &&
						p.pageHash === page.pageHash &&
						p.dataHash === page.dataHash
					);
				}),
			code,
		);
		return [row];
	});
}
/** Full structural scope only; native admission and every alternative's clock remain separate. */
export function buildLocalStoryFlowScope(
	options: Options,
): BoundLocalStoryFlowScope {
	options = plain(options, ["source", "tree", "steps"]);
	const source = freeze(localStoryFlowContextSourceEvidence(options.source)),
		tree = freeze(
			localStoryFlowContextTreeEvidence(options.tree, options.source),
		);
	const { rebuilt, rows } = rebuildTrace(options),
		root = rows[0],
		last = rows.at(-1),
		code = "LOCAL_STORY_FLOW_SCOPE_TRACE_INVALID";
	requireScope(root && last && last.rawOutput.phase === "FINALIZE", code);
	const targetFrames = root.expectation.input.targetFrames,
		previous = last.after;
	const closure = prepareLocalStoryFlowClosure({
			source: options.source,
			tree: options.tree,
			targetFrames,
			rootChoice: previous.closure.rootChoice,
			hardChoices: previous.closure.hardChoices.map((c) => c.choice),
		}),
		closureEvidence = localStoryFlowClosureStateEvidence(closure);
	requireScope(equalData(closureEvidence, previous.closure), code);
	const closureResult = evaluateLocalStoryFlowClosure({
		state: closure,
		seeds: previous.seeds,
	});
	requireScope(
		equalData(closureResult, previous.closureResult) &&
			closureResult.status === "COMPLETE" &&
			closureResult.requiredEvents.length > 0 &&
			closureResult.requiredEvents.length <=
				LOCAL_STORY_FLOW_SCOPE_POLICY.candidateEventLimit,
		code,
	);
	const ids = new Set(closureResult.requiredEvents.map((e) => e.ref.eventId));
	const candidateCards = source.pages.flatMap((p) =>
		p.data.items.flatMap((i) =>
			i.kind === "GROUNDED_LEAF_EVENT_CARD" && ids.has(i.id) ? [i] : [],
		),
	);
	requireScope(candidateCards.length === ids.size, code);
	const leafExposures = requiredExposures(source, rows, last),
		blueprint = validateLocalStoryBlueprint({
			ledger: source.manifest.corpus,
			blueprint: last.rawOutput.blueprint,
		});
	requireScope(
		blueprint.mode === "FLOW" && equalData(blueprint, last.rawOutput.blueprint),
		code,
	);
	if (localStoryBlueprintCoherenceIssues(blueprint).length)
		throw new LocalStoryError("LOCAL_STORY_BLUEPRINT_COHERENCE_INVALID");
	const alternatives = alternativeChecks(
		source,
		closure,
		candidateCards,
		blueprint,
	);
	const traceBody = {
		refs: rows.map((r) => ({
			phase: r.phase,
			nodeId: r.expectation.input.nodeId,
			stepHash: r.stepHash,
			observationHash: r.observationHash,
			expectationHash: r.expectation.expectationHash,
			inputHash: r.expectation.input.inputHash,
			rawOutputHash: r.rawOutputHash,
		})),
		rootStepHash: root.stepHash,
		finalStepHash: last.stepHash,
		acceptedStepCount: rows.length,
	};
	const body = {
		version: "local-story-flow-scope-v1" as const,
		sourceBinding: source.sourceBinding,
		sourceBindingHash: source.sourceBindingHash,
		treeHash: tree.treeHash,
		fullGraphHash: hash(tree.graph),
		policyHash: hash(LOCAL_STORY_FLOW_SCOPE_POLICY),
		targetFrames,
		trace: { ...traceBody, traceHash: hash(traceBody) },
		closure: closureEvidence,
		seeds: previous.seeds,
		closureResult,
		candidateCards,
		leafExposures,
		blueprint,
		blueprintHash: hash(blueprint),
		alternatives,
		combinationCount: alternatives.length,
		alternativeChecksHash: hash(alternatives),
		clockStatus: "PENDING" as const,
	};
	const evidence = freeze(structuredClone({ ...body, scopeHash: hash(body) })),
		handle = Object.freeze({});
	scopes.set(handle, {
		source,
		tree,
		options: Object.freeze({
			source: options.source,
			tree: options.tree,
			steps: Object.freeze([...rebuilt]),
		}),
		steps: rebuilt,
		closure,
		evidence,
	});
	return handle;
}
/** One legacy selector call per operation; never retries another tuple or upgrades scope.clockStatus. */
export function selectLocalStoryFlowPlan(options: {
	scope: BoundLocalStoryFlowScope;
}): BoundLocalStoryFlowPlan {
	options = plain(options, ["scope"]);
	const state = scopes.get(options.scope);
	requireScope(state);
	const e = state.evidence,
		target = e.targetFrames;
	const selection = selectLocalStoryClips({
		input: state.source.input,
		ledger: state.source.manifest.corpus,
		blueprint: e.blueprint,
		targetDurationFrames: target,
	});
	if (
		localStorySelectedPlanIssues({
			input: state.source.input,
			ledger: state.source.manifest.corpus,
			blueprint: e.blueprint,
			selection,
		}).length
	)
		throw new LocalStoryError("LOCAL_STORY_SELECTION_COHERENCE_INVALID");
	const matches = e.alternatives.filter(
		(a) =>
			equalData(
				a.choices.map((c) => c.beatId),
				selection.localStorySelection.selectedBeatIds,
			) &&
			equalData(
				a.choices.map((c) => c.eventId),
				selection.localStorySelection.selectedEventIds,
			),
	);
	requireScope(matches.length === 1, "LOCAL_STORY_FLOW_PLAN_INVALID");
	const selected = matches[0];
	requireScope(selected, "LOCAL_STORY_FLOW_PLAN_INVALID");
	requireScope(
		selection.requestedDurationFrames === target &&
			Number.isSafeInteger(selection.actualDurationFrames) &&
			selection.actualDurationFrames > 0 &&
			selection.actualDurationFrames <= target &&
			selection.clips.reduce((sum, c) => sum + c.durationFrames, 0) ===
				selection.actualDurationFrames,
		"LOCAL_STORY_FLOW_PLAN_INVALID",
	);
	const body = {
		version: "local-story-flow-plan-v1" as const,
		sourceBindingHash: e.sourceBindingHash,
		treeHash: e.treeHash,
		scopeHash: e.scopeHash,
		policyHash: e.policyHash,
		targetFrames: target,
		selectedAlternativeIndex: selected.index,
		selection,
		selectionHash: hash(selection),
		clock: {
			status: "LEGACY_FORWARD_COVERAGE_VALIDATED" as const,
			strictEventMomentOrder: "NOT_PROVEN" as const,
		},
	};
	const evidence = freeze(structuredClone({ ...body, planHash: hash(body) })),
		handle = Object.freeze({});
	plans.set(handle, { scope: options.scope, evidence });
	return handle;
}
export function localStoryFlowPlanEvidence(
	plan: BoundLocalStoryFlowPlan,
): LocalStoryFlowPlanEvidence {
	const state = plans.get(plan);
	requireScope(state, "LOCAL_STORY_FLOW_PLAN_INVALID");
	return structuredClone(state.evidence);
}
function safeData(
	value: unknown,
	code: LocalStoryFlowScopeErrorCode,
	active = new Set<object>(),
): unknown {
	try {
		if (
			value === null ||
			typeof value === "string" ||
			typeof value === "boolean"
		)
			return value;
		if (typeof value === "number") {
			requireScope(Number.isFinite(value), code);
			return value;
		}
		requireScope(typeof value === "object" && !active.has(value), code);
		active.add(value);
		requireScope(Object.getOwnPropertySymbols(value).length === 0, code);
		const d = Object.getOwnPropertyDescriptors(value);
		let copy: unknown;
		if (Array.isArray(value)) {
			const length = d.length?.value;
			requireScope(
				Object.getPrototypeOf(value) === Array.prototype &&
					Number.isSafeInteger(length) &&
					length >= 0 &&
					Object.keys(d).length === length + 1,
				code,
			);
			copy = Array.from({ length }, (_, i) => {
				const p = d[String(i)];
				requireScope(p && "value" in p && p.enumerable, code);
				return safeData(p.value, code, active);
			});
		} else {
			requireScope(Object.getPrototypeOf(value) === Object.prototype, code);
			copy = Object.fromEntries(
				Object.entries(d).map(([k, p]) => {
					requireScope("value" in p && p.enumerable, code);
					return [k, safeData(p.value, code, active)];
				}),
			);
		}
		active.delete(value);
		return copy;
	} catch {
		throw new LocalStoryFlowScopeError(code);
	}
}
/** Unknown artifacts never supply their own source, trace or expected output. */
export function validateLocalStoryFlowScope(
	value: unknown,
	options: Options,
): BoundLocalStoryFlowScope {
	const scope = buildLocalStoryFlowScope(options);
	requireScope(
		equalData(
			safeData(value, "LOCAL_STORY_FLOW_SCOPE_INVALID"),
			localStoryFlowScopeEvidence(scope),
		),
	);
	return scope;
}
/** A separate read operation invokes the unchanged selector exactly once through its creator. */
export function validateLocalStoryFlowPlan(
	value: unknown,
	options: { scope: BoundLocalStoryFlowScope },
): BoundLocalStoryFlowPlan {
	const plan = selectLocalStoryFlowPlan(options);
	requireScope(
		equalData(
			safeData(value, "LOCAL_STORY_FLOW_PLAN_INVALID"),
			localStoryFlowPlanEvidence(plan),
		),
		"LOCAL_STORY_FLOW_PLAN_INVALID",
	);
	return plan;
}
