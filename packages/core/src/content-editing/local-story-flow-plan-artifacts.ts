import { canonicalEditingJson as json } from "./automatic-binding";
import {
	type BoundLocalStoryFlowAcceptedContext,
	type LocalStoryFlowArtifactProposal,
	localStoryFlowAcceptedContextEvidence,
	localStoryFlowAcceptedContextTree,
} from "./local-story-flow-artifact-reader";
import { localStoryFlowContextSourceEvidence } from "./local-story-flow-context";
import { localStoryFlowNativeRootEvidence } from "./local-story-flow-native";
import { localStoryFlowRouteStepEvidence } from "./local-story-flow-route";
import {
	type AcceptedLocalStoryFlowRouteStep,
	localStoryFlowAcceptedRouteCoreStep,
	localStoryFlowAcceptedRoutePublication,
	nextLocalStoryFlowRouteWork,
} from "./local-story-flow-route-artifacts";
import {
	type BoundLocalStoryFlowRuntimeHistory,
	type BoundLocalStoryFlowRuntimeIdentity,
	isLocalStoryFlowRuntimeFailureCode,
	type LocalStoryFlowRuntimeFailureCode,
	type LocalStoryFlowRuntimeIdentityEvidence,
	localStoryFlowRuntimeHistoryEvidence,
	localStoryFlowRuntimeIdentityEvidence,
	localStoryFlowRuntimeKey,
	localStoryFlowRuntimeStartRecord,
} from "./local-story-flow-runtime-history";
import {
	buildLocalStoryFlowScope,
	type LocalStoryFlowPlanEvidence,
	type LocalStoryFlowScopeEvidence,
	localStoryFlowPlanEvidence,
	localStoryFlowScopeEvidence,
	selectLocalStoryFlowPlan,
	validateLocalStoryFlowPlan,
	validateLocalStoryFlowScope,
} from "./local-story-flow-scope";
import {
	type BoundLocalStoryFlowSealedRecord,
	type LocalStoryFlowRecordKey,
	type LocalStoryFlowRecordRef,
	type LocalStoryFlowSourceTuple,
	localStoryFlowRecordIdentity,
	localStoryFlowSealedRecordEvidence,
} from "./local-story-flow-seals";
import {
	type BoundLocalStoryFlowSourceArchive,
	localStoryFlowSourceArchiveContext,
	localStoryFlowSourceArchiveEvidence,
} from "./local-story-flow-source-archive";
import { hashEditingEvidence as hash } from "./verify-automatic-binding";

export const LOCAL_STORY_FLOW_PLAN_ARTIFACT_POLICY = Object.freeze({
	version: "local-story-flow-plan-artifacts-v1",
	inputRule: "original-owned-source-identity-whole-history-complete-route-v1",
	selectorRule: "creator-select-once-terminal-validate-once-v1",
	traceRule: "full-prefix-native-trace-separate-structural-trace-v1",
	stopRule:
		"owned-original-start-stop-before-source-unconfirmed-fail-closed-v1",
	contextNodes: 63,
	routeSteps: 64,
});
export class LocalStoryFlowPlanArtifactError extends Error {
	readonly code: LocalStoryFlowRuntimeFailureCode;
	constructor(
		code: LocalStoryFlowRuntimeFailureCode = "LOCAL_STORY_ARTIFACT_UNVERIFIED",
	) {
		const fixed = isLocalStoryFlowRuntimeFailureCode(code)
			? code
			: "LOCAL_STORY_ARTIFACT_UNVERIFIED";
		super(fixed);
		this.name = "LocalStoryFlowPlanArtifactError";
		this.code = fixed;
	}
}
function requirePlan(value: unknown): asserts value {
	if (!value) throw new LocalStoryFlowPlanArtifactError();
}
function checked<T>(read: () => T): T {
	try {
		return read();
	} catch {
		throw new LocalStoryFlowPlanArtifactError();
	}
}
const same = (a: unknown, b: unknown) => json(a) === json(b);
function fields(value: unknown, names: readonly string[]) {
	requirePlan(
		value !== null &&
			typeof value === "object" &&
			Object.getPrototypeOf(value) === Object.prototype &&
			Object.getOwnPropertySymbols(value).length === 0,
	);
	const d = Object.getOwnPropertyDescriptors(value);
	requirePlan(Object.keys(d).length === names.length);
	return Object.fromEntries(
		names.map((name) => {
			const p = d[name];
			requirePlan(p?.enumerable && "value" in p);
			return [name, p.value];
		}),
	);
}
function routeSteps(value: unknown): AcceptedLocalStoryFlowRouteStep[] {
	requirePlan(
		Array.isArray(value) &&
			Object.getPrototypeOf(value) === Array.prototype &&
			Object.getOwnPropertySymbols(value).length === 0,
	);
	const d = Object.getOwnPropertyDescriptors(value as object),
		n = d.length?.value;
	requirePlan(
		typeof n === "number" &&
			Number.isSafeInteger(n) &&
			n >= 1 &&
			n <= LOCAL_STORY_FLOW_PLAN_ARTIFACT_POLICY.routeSteps &&
			Object.keys(d).length === n + 1,
	);
	return Array.from({ length: n }, (_, index) => {
		const p = d[String(index)];
		requirePlan(p?.enumerable && "value" in p);
		return p.value as AcceptedLocalStoryFlowRouteStep;
	});
}
type Pair = {
	a: ReturnType<typeof localStoryFlowSourceArchiveEvidence>;
	context: ReturnType<typeof localStoryFlowAcceptedContextEvidence>;
	source: ReturnType<typeof localStoryFlowSourceArchiveContext>;
	sourceEvidence: ReturnType<typeof localStoryFlowContextSourceEvidence>;
	tree: ReturnType<typeof localStoryFlowAcceptedContextTree>;
};
const pairs = new WeakMap<
	BoundLocalStoryFlowSourceArchive,
	WeakMap<BoundLocalStoryFlowAcceptedContext, Pair>
>();
function pair(
	archive: BoundLocalStoryFlowSourceArchive,
	context: BoundLocalStoryFlowAcceptedContext,
) {
	const old = pairs.get(archive)?.get(context);
	if (old) return old;
	const a = localStoryFlowSourceArchiveEvidence(archive),
		c = localStoryFlowAcceptedContextEvidence(context);
	requirePlan(
		same(a.key, c.sourceArchive.key) &&
			same(a.payload, c.sourceArchive.payload),
	);
	const source = localStoryFlowSourceArchiveContext(archive);
	const state: Pair = {
		a,
		context: c,
		source,
		sourceEvidence: localStoryFlowContextSourceEvidence(source),
		tree: localStoryFlowAcceptedContextTree(context),
	};
	const map = pairs.get(archive) ?? new WeakMap();
	map.set(context, state);
	pairs.set(archive, map);
	return state;
}
type Inputs = {
	archive: BoundLocalStoryFlowSourceArchive;
	context: BoundLocalStoryFlowAcceptedContext;
	identity: BoundLocalStoryFlowRuntimeIdentity;
	history: BoundLocalStoryFlowRuntimeHistory;
	steps: readonly AcceptedLocalStoryFlowRouteStep[];
};
function prepareInputs(value: unknown, terminal: boolean) {
	const o = checked(() =>
		fields(value, [
			"archive",
			"context",
			"identity",
			"history",
			"steps",
			...(terminal ? ["plan"] : []),
		]),
	);
	// These fields come only from the real owned history getter, before source checks.
	const history = checked(() =>
		localStoryFlowRuntimeHistoryEvidence(
			o.history as BoundLocalStoryFlowRuntimeHistory,
		),
	);
	const identity = o.identity as BoundLocalStoryFlowRuntimeIdentity;
	const facts = checked(() => localStoryFlowRuntimeIdentityEvidence(identity));
	// Bind the original task/START before promoting its stop code, without reading source.
	checked(() => {
		const original = localStoryFlowRuntimeStartRecord(
			identity,
			history.start.payload.nativeConnectionHash as string,
		);
		requirePlan(
			same(original.key, history.start.key) &&
				same(original.payload, history.start.payload),
		);
	});
	if (history.stopCode !== null)
		throw new LocalStoryFlowPlanArtifactError(history.stopCode);
	if (history.unconfirmedSlot !== null)
		throw new LocalStoryFlowPlanArtifactError(
			"LOCAL_STORY_FLOW_NATIVE_UNCONFIRMED",
		);
	return checked(() => {
		const archive = o.archive as BoundLocalStoryFlowSourceArchive,
			context = o.context as BoundLocalStoryFlowAcceptedContext,
			p = pair(archive, context),
			a = p.a.payload;
		requirePlan(
			facts.taskId === a.taskId &&
				same(facts.sourceTuple, a.sourceTuple) &&
				same(facts.taskPin, a.taskPin) &&
				facts.taskPinHash === hash(a.taskPin) &&
				facts.taskPayloadHash === a.taskPayloadHash,
		);
		requirePlan(
			same(
				facts.taskPin.identity.localStoryWorkflow,
				p.sourceEvidence.workflow,
			) &&
				same(
					facts.taskPin.identity.localStoryModel,
					p.sourceEvidence.workflow.baseModel,
				),
		);
		const nodes = p.context.nodes,
			layout = p.sourceEvidence.layout.nodes;
		requirePlan(
			nodes.length === layout.length &&
				history.bindings.length === layout.length,
		);
		const bindings = new Map(
			history.bindings.map((b) => [b.key.keyBody.nodeId, b]),
		);
		requirePlan(bindings.size === layout.length);
		const orderedContextBindings = layout.map((node, index) => {
			const actual = nodes[index],
				binding = bindings.get(node.nodeId);
			requirePlan(actual && binding && actual.payload.nodeId === node.nodeId);
			requirePlan(
				same(
					binding.key,
					localStoryFlowRuntimeKey(identity, {
						purpose: "CONTEXT_BINDING",
						nodeId: node.nodeId,
					}),
				) &&
					same(binding.payload, {
						version: "local-story-flow-runtime-context-binding-v1",
						purpose: "CONTEXT_BINDING",
						startRef: history.start.ref,
						nodeRef: actual.ref,
						nodeHash: actual.payload.nodeHash,
						observationRef: actual.payload.observationRef,
					}),
			);
			return { nodeId: node.nodeId, bindingRef: binding.ref };
		});
		const steps = routeSteps(o.steps);
		requirePlan(
			nextLocalStoryFlowRouteWork({ archive, context, steps }).status ===
				"COMPLETE",
		);
		requirePlan(history.prefixes.length === steps.length);
		const publications = steps.map(localStoryFlowAcceptedRoutePublication);
		const core = steps.map(localStoryFlowAcceptedRouteCoreStep);
		const rows = core.map(localStoryFlowRouteStepEvidence);
		const root = publications[0];
		requirePlan(root);
		const nativeRootProof = localStoryFlowNativeRootEvidence(
			root.nativeRoot,
		).nativeRootProof;
		for (const [index, publication] of publications.entries()) {
			const prefix = history.prefixes[index],
				row = rows[index];
			requirePlan(
				prefix &&
					row &&
					publication.archive === archive &&
					publication.context === context &&
					publication.previous === (index === 0 ? null : steps[index - 1]) &&
					publication.nativeRoot === root.nativeRoot,
			);
			const body = {
				version: "local-story-flow-runtime-prefix-v1",
				purpose: "ROUTE_PREFIX",
				taskId: facts.taskId,
				startRef: history.start.ref,
				sourceArchiveRef: p.context.sourceArchive.ref,
				treeRef: p.context.tree.ref,
				ordinal: index + 1,
				previousPrefixRef:
					index === 0 ? null : history.prefixes[index - 1]?.ref,
				stepRef: publication.step.ref,
				stepHash: row.stepHash,
				expectationHash: row.expectation.expectationHash,
				observationRef: publication.observation.ref,
				nativeRootProof,
				progressHash: publication.progressHash,
			};
			requirePlan(
				same(
					prefix.key,
					localStoryFlowRuntimeKey(identity, {
						purpose: "ROUTE_PREFIX",
						ordinal: index + 1,
					}),
				) && same(prefix.payload, { ...body, prefixHash: hash(body) }),
			);
		}
		const final = history.prefixes.at(-1);
		requirePlan(final);
		requirePlan(same(history.tailRef, final.ref));
		return {
			o,
			p,
			facts,
			history,
			core,
			rows,
			orderedContextBindings,
			nativeRootProof,
			final,
		};
	});
}
type Prepared = ReturnType<typeof prepareInputs>;
type PlanBody = {
	version: "local-story-flow-plan-artifact-v1";
	purpose: "PLAN";
	taskId: string;
	startRef: LocalStoryFlowRecordRef;
	taskPinHash: string;
	sourceTuple: LocalStoryFlowSourceTuple;
	sourceArchiveRef: LocalStoryFlowRecordRef;
	workflow: Pair["sourceEvidence"]["workflow"];
	baseModel: Pair["sourceEvidence"]["workflow"]["baseModel"];
	sourceBindingHash: string;
	inputHash: string;
	transcriptFingerprint: string;
	corpusHash: string;
	manifestHash: string;
	treeRef: LocalStoryFlowRecordRef;
	treeHash: string;
	orderedContextBindings: {
		nodeId: string;
		bindingRef: LocalStoryFlowRecordRef;
	}[];
	orderedPrefixRefs: LocalStoryFlowRecordRef[];
	nativeTraceHash: string;
	structuralTraceHash: string;
	nativeRootProof: string;
	scopeEvidence: LocalStoryFlowScopeEvidence;
	scopeHash: string;
	planEvidence: LocalStoryFlowPlanEvidence;
	planHash: string;
	originalBlueprint: LocalStoryFlowScopeEvidence["blueprint"];
	originalSelection: LocalStoryFlowPlanEvidence["selection"];
	originalSelectedEventIds: string[];
	clock: LocalStoryFlowPlanEvidence["clock"];
	generationPolicyFingerprint: string;
	compiledPolicyParts: LocalStoryFlowRuntimeIdentityEvidence["taskPin"]["policies"];
	artifactHash: string;
};
export type BoundLocalStoryFlowPlanArtifact = Readonly<object>;
const artifacts = new WeakMap<
	BoundLocalStoryFlowPlanArtifact,
	LocalStoryFlowArtifactProposal<PlanBody>
>();
function planKey(p: Prepared): LocalStoryFlowRecordKey {
	return {
		version: "local-story-flow-record-key-v1",
		purpose: "PLAN",
		keyBody: {
			taskId: p.facts.taskId,
			startHash: p.history.start.payload.startHash,
			finalPrefixHash: p.final.payload.prefixHash,
			scopePolicyHash: p.facts.taskPin.policies.scopePolicyHash,
		},
	};
}
function proposal(
	p: Prepared,
	scope: LocalStoryFlowScopeEvidence,
	plan: LocalStoryFlowPlanEvidence,
): LocalStoryFlowArtifactProposal<PlanBody> {
	const first = p.rows[0],
		last = p.rows.at(-1);
	requirePlan(first && last);
	const traceBody = {
		refs: p.rows.map((row) => ({
			phase: row.phase,
			nodeId: row.expectation.input.nodeId,
			stepHash: row.stepHash,
			observationHash: row.observationHash,
			expectationHash: row.expectation.expectationHash,
			inputHash: row.expectation.input.inputHash,
			rawOutputHash: row.rawOutputHash,
		})),
		rootStepHash: first.stepHash,
		finalStepHash: last.stepHash,
		acceptedStepCount: p.rows.length,
	};
	requirePlan(same(scope.trace, { ...traceBody, traceHash: hash(traceBody) }));
	const { facts, history } = p,
		source = p.p.sourceEvidence;
	const nativeTraceBody = {
		version: "local-story-flow-native-trace-v1",
		taskId: facts.taskId,
		startRef: history.start.ref,
		sourceArchiveRef: p.p.context.sourceArchive.ref,
		treeRef: p.p.context.tree.ref,
		prefixes: history.prefixes.map((prefix, index) => ({
			ordinal: index + 1,
			prefixRef: prefix.ref,
			prefixHash: prefix.payload.prefixHash,
			stepHash: prefix.payload.stepHash,
			expectationHash: prefix.payload.expectationHash,
			observationRef: prefix.payload.observationRef,
		})),
		structuralTraceHash: scope.trace.traceHash,
	};
	const fingerprint = facts.taskPin.identity.generationPolicyFingerprint;
	requirePlan(typeof fingerprint === "string");
	const body: Omit<PlanBody, "artifactHash"> = {
		version: "local-story-flow-plan-artifact-v1",
		purpose: "PLAN",
		taskId: facts.taskId,
		startRef: history.start.ref,
		taskPinHash: facts.taskPinHash,
		sourceTuple: facts.sourceTuple,
		sourceArchiveRef: p.p.context.sourceArchive.ref,
		workflow: source.workflow,
		baseModel: source.workflow.baseModel,
		sourceBindingHash: source.sourceBindingHash,
		inputHash: source.sourceBinding.inputHash,
		transcriptFingerprint: source.sourceBinding.transcriptFingerprint,
		corpusHash: p.p.a.payload.corpusHash as string,
		manifestHash: source.manifest.manifestHash,
		treeRef: p.p.context.tree.ref,
		treeHash: scope.treeHash,
		orderedContextBindings: p.orderedContextBindings,
		orderedPrefixRefs: history.prefixes.map((prefix) => prefix.ref),
		nativeTraceHash: hash(nativeTraceBody),
		structuralTraceHash: scope.trace.traceHash,
		nativeRootProof: p.nativeRootProof,
		scopeEvidence: scope,
		scopeHash: scope.scopeHash,
		planEvidence: plan,
		planHash: plan.planHash,
		originalBlueprint: scope.blueprint,
		originalSelection: plan.selection,
		originalSelectedEventIds:
			plan.selection.localStorySelection.selectedEventIds,
		clock: plan.clock,
		generationPolicyFingerprint: fingerprint,
		compiledPolicyParts: facts.taskPin.policies,
	};
	const payload = { ...body, artifactHash: hash(body) },
		key = planKey(p);
	const kind = "LOCAL_FLOW_PLAN_V1",
		sourceTuple = facts.sourceTuple;
	const identity = localStoryFlowRecordIdentity({ sourceTuple, kind, key });
	const proof = {
		version: "local-story-cache-v2",
		cacheHash: identity.cacheHash,
		valueJson: json(payload),
	};
	return {
		sourceTuple,
		kind,
		key,
		payload,
		ref: { kind, ...identity, proofHash: hash(proof) },
	};
}
function owned(value: LocalStoryFlowArtifactProposal<PlanBody>) {
	const handle = Object.freeze({});
	artifacts.set(handle, value);
	return handle;
}
/** Pure creator; no DB authority, time check, native call or delivery activation. */
export function buildLocalStoryFlowPlanArtifact(
	options: Inputs,
): BoundLocalStoryFlowPlanArtifact {
	const p = prepareInputs(options, false);
	return checked(() => {
		const scope = buildLocalStoryFlowScope({
			source: p.p.source,
			tree: p.p.tree,
			steps: p.core,
		});
		const plan = selectLocalStoryFlowPlan({ scope });
		return owned(
			proposal(
				p,
				localStoryFlowScopeEvidence(scope),
				localStoryFlowPlanEvidence(plan),
			),
		);
	});
}
/** Unknown PLAN is checked using independent owned inputs, never a stored raw-output expectation. */
export function hydrateLocalStoryFlowPlanArtifact(
	options: Inputs & {
		plan: BoundLocalStoryFlowSealedRecord;
	},
): BoundLocalStoryFlowPlanArtifact {
	const p = prepareInputs(options, true);
	return checked(() => {
		const stored = localStoryFlowSealedRecordEvidence(
			p.o.plan as BoundLocalStoryFlowSealedRecord,
		);
		requirePlan(
			stored.kind === "LOCAL_FLOW_PLAN_V1" &&
				same(stored.sourceTuple, p.facts.sourceTuple) &&
				same(stored.key, planKey(p)),
		);
		const scope = validateLocalStoryFlowScope(stored.payload.scopeEvidence, {
			source: p.p.source,
			tree: p.p.tree,
			steps: p.core,
		});
		const plan = validateLocalStoryFlowPlan(stored.payload.planEvidence, {
			scope,
		});
		const expected = proposal(
			p,
			localStoryFlowScopeEvidence(scope),
			localStoryFlowPlanEvidence(plan),
		);
		requirePlan(same(stored, expected));
		return owned(expected);
	});
}
export function localStoryFlowPlanArtifactEvidence(
	handle: BoundLocalStoryFlowPlanArtifact,
) {
	return checked(() => {
		const value = artifacts.get(handle);
		requirePlan(value);
		return structuredClone(value);
	});
}
