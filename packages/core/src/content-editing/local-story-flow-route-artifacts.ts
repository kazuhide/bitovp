import { canonicalEditingJson as json } from "./automatic-binding";
import {
	type BoundLocalStoryFlowAcceptedContext,
	type LocalStoryFlowArtifactProposal,
	localStoryFlowAcceptedContextEvidence,
	localStoryFlowAcceptedContextTree,
} from "./local-story-flow-artifact-reader";
import { localStoryFlowContextSourceEvidence } from "./local-story-flow-context";
import { localStoryFlowContextTreeEvidence } from "./local-story-flow-context-tree";
import {
	type AdmittedFlowNative,
	admittedFlowNativeEvidence,
	admittedFlowNativeOutput,
	type BoundLocalStoryFlowNativeExpectation,
	type BoundLocalStoryFlowNativeRoot,
	bindLocalStoryFlowNativeRoot,
	type LocalStoryFlowNativeObservation,
	localStoryFlowNativeExpectationEvidence,
	routeNativeExpectation,
} from "./local-story-flow-native";
import {
	type BoundLocalStoryFlowRouteExpectation,
	type BoundLocalStoryFlowRouteStep,
	buildLocalStoryFlowRouteStep,
	type LocalStoryFlowRouteStepEvidence,
	localStoryFlowRouteExpectationEvidence,
	localStoryFlowRouteStepEvidence,
} from "./local-story-flow-route";
import {
	localStoryFlowRouteProgressHash,
	nextLocalStoryFlowRoute,
} from "./local-story-flow-scheduler";
import {
	type LocalStoryFlowRecordKey,
	type LocalStoryFlowRecordRef,
	type LocalStoryFlowSourceTuple,
	localStoryFlowRecordIdentity,
} from "./local-story-flow-seals";
import {
	type BoundLocalStoryFlowSourceArchive,
	localStoryFlowSourceArchiveContext,
	localStoryFlowSourceArchiveEvidence,
} from "./local-story-flow-source-archive";
import { hashEditingEvidence as hash } from "./verify-automatic-binding";

export const LOCAL_STORY_FLOW_ROUTE_ARTIFACT_POLICY = Object.freeze({
	version: "local-story-flow-route-artifacts-v1",
	inputRule: "owned-archive-context-scheduled-native-v1",
	outputRule: "original-admitted-native-output-only-v1",
	chainRule: "same-archive-context-previous-handle-v1",
	maxRouteSteps: 64,
});
export class LocalStoryFlowRouteArtifactError extends Error {
	readonly code = "LOCAL_STORY_ARTIFACT_UNVERIFIED";
	constructor() {
		super("LOCAL_STORY_ARTIFACT_UNVERIFIED");
		this.name = "LocalStoryFlowRouteArtifactError";
	}
}
function requireArtifact(value: unknown): asserts value {
	if (!value) throw new LocalStoryFlowRouteArtifactError();
}
function checked<T>(read: () => T): T {
	try {
		return read();
	} catch {
		throw new LocalStoryFlowRouteArtifactError();
	}
}
const same = (a: unknown, b: unknown) => json(a) === json(b);
function fields(value: unknown, expected: readonly string[]) {
	requireArtifact(
		typeof value === "object" &&
			value !== null &&
			Object.getPrototypeOf(value) === Object.prototype &&
			Object.getOwnPropertySymbols(value).length === 0,
	);
	const descriptors = Object.getOwnPropertyDescriptors(value);
	requireArtifact(
		Object.keys(descriptors).sort().join(",") ===
			[...expected].sort().join(",") &&
			Object.values(descriptors).every((d) => d.enumerable && "value" in d),
	);
	return Object.fromEntries(
		Object.entries(descriptors).map(([name, d]) => [name, d.value]),
	);
}
function history(value: unknown): AcceptedLocalStoryFlowRouteStep[] {
	requireArtifact(
		Array.isArray(value) &&
			Object.getPrototypeOf(value) === Array.prototype &&
			Object.getOwnPropertySymbols(value).length === 0,
	);
	const d = Object.getOwnPropertyDescriptors(value as object),
		length = d.length?.value;
	requireArtifact(
		Number.isSafeInteger(length) &&
			length >= 0 &&
			length <= LOCAL_STORY_FLOW_ROUTE_ARTIFACT_POLICY.maxRouteSteps &&
			Object.keys(d).length === length + 1,
	);
	return Array.from({ length }, (_, index) => {
		const row = d[String(index)];
		requireArtifact(row?.enumerable && "value" in row);
		return row.value as AcceptedLocalStoryFlowRouteStep;
	});
}
type ContextState = {
	archive: BoundLocalStoryFlowSourceArchive;
	context: BoundLocalStoryFlowAcceptedContext;
	source: ReturnType<typeof localStoryFlowSourceArchiveContext>;
	tree: ReturnType<typeof localStoryFlowAcceptedContextTree>;
	sourceTuple: LocalStoryFlowSourceTuple;
	targetFrames: number;
	pin: {
		modelPin: { profile: "nvidia" | "amd"; configId: string };
		policies: unknown;
	};
};
// Full source evidence is compared once per actual owned pair, not once per step.
const contextStates = new WeakMap<
	BoundLocalStoryFlowSourceArchive,
	WeakMap<BoundLocalStoryFlowAcceptedContext, ContextState>
>();
function contextState(
	archive: BoundLocalStoryFlowSourceArchive,
	context: BoundLocalStoryFlowAcceptedContext,
) {
	const cached = contextStates.get(archive)?.get(context);
	if (cached) return cached;
	const a = localStoryFlowSourceArchiveEvidence(archive),
		c = localStoryFlowAcceptedContextEvidence(context);
	requireArtifact(
		same(a.key, c.sourceArchive.key) &&
			same(a.payload, c.sourceArchive.payload),
	);
	const source = localStoryFlowSourceArchiveContext(archive),
		tree = localStoryFlowAcceptedContextTree(context),
		s = localStoryFlowContextSourceEvidence(source);
	localStoryFlowContextTreeEvidence(tree, source);
	const pin = a.payload.taskPin as {
		parameters: { targetDurationFrames: number };
		policies: unknown;
	};
	const state: ContextState = {
		archive,
		context,
		source,
		tree,
		sourceTuple: a.payload.sourceTuple as LocalStoryFlowSourceTuple,
		targetFrames: pin.parameters.targetDurationFrames,
		pin: {
			modelPin: {
				profile: s.workflow.baseModel.profile,
				configId: s.workflow.baseModel.configId,
			},
			policies: pin.policies,
		},
	};
	const map = contextStates.get(archive) ?? new WeakMap();
	map.set(context, state);
	contextStates.set(archive, map);
	return state;
}
export type BoundLocalStoryFlowRouteWork = Readonly<object>;
export type AcceptedLocalStoryFlowRouteStep = Readonly<object>;
type WorkState = {
	context: ContextState;
	previous: AcceptedLocalStoryFlowRouteStep | null;
	route: BoundLocalStoryFlowRouteExpectation;
	expectation: BoundLocalStoryFlowNativeExpectation;
};
type StepPayload = {
	version: "local-story-flow-step-artifact-v1";
	purpose: "STEP";
	sourceBindingHash: string;
	treeHash: string;
	observationRef: LocalStoryFlowRecordRef;
	stepEvidence: LocalStoryFlowRouteStepEvidence;
	stepHash: string;
};
type CachePayload = {
	version: "local-story-flow-native-cache-v1";
	purpose: "NATIVE_CACHE";
	nativeKeyHash: string;
	observationRef: LocalStoryFlowRecordRef;
	observationHash: string;
};
type StepState = {
	work: BoundLocalStoryFlowRouteWork;
	w: WorkState;
	native: AdmittedFlowNative;
	core: BoundLocalStoryFlowRouteStep;
	nativeRoot: BoundLocalStoryFlowNativeRoot;
	progressHash: string;
	observation: LocalStoryFlowArtifactProposal<LocalStoryFlowNativeObservation>;
	step: LocalStoryFlowArtifactProposal<StepPayload>;
	cache: LocalStoryFlowArtifactProposal<CachePayload>;
};
const works = new WeakMap<BoundLocalStoryFlowRouteWork, WorkState>(),
	steps = new WeakMap<AcceptedLocalStoryFlowRouteStep, StepState>();
function workState(handle: BoundLocalStoryFlowRouteWork) {
	const value = works.get(handle);
	requireArtifact(value);
	return value;
}
function stepState(handle: AcceptedLocalStoryFlowRouteStep) {
	const value = steps.get(handle);
	requireArtifact(value);
	return value;
}
export function nextLocalStoryFlowRouteWork(options: {
	archive: BoundLocalStoryFlowSourceArchive;
	context: BoundLocalStoryFlowAcceptedContext;
	steps: readonly AcceptedLocalStoryFlowRouteStep[];
}) {
	return checked(() => {
		const o = fields(options, ["archive", "context", "steps"]),
			c = contextState(
				o.archive as BoundLocalStoryFlowSourceArchive,
				o.context as BoundLocalStoryFlowAcceptedContext,
			),
			chain = history(o.steps),
			states = chain.map(stepState);
		for (const [index, state] of states.entries()) {
			requireArtifact(
				state.w.context === c &&
					state.w.previous === (index === 0 ? null : chain[index - 1]),
			);
		}
		const next = nextLocalStoryFlowRoute({
			source: c.source,
			tree: c.tree,
			targetFrames: c.targetFrames,
			steps: states.map((s) => s.core),
		});
		if (next.status === "COMPLETE") {
			const terminal = chain.at(-1);
			requireArtifact(terminal);
			return { status: "COMPLETE" as const, terminal };
		}
		const previous = chain.at(-1) ?? null,
			parent = previous ? stepState(previous) : null;
		const expectation = routeNativeExpectation(
			parent
				? {
						routeExpectation: next.expectation,
						pin: c.pin,
						nativeRootProof: parent.nativeRoot,
					}
				: { routeExpectation: next.expectation, pin: c.pin },
		);
		const work = Object.freeze({});
		works.set(work, {
			context: c,
			previous,
			route: next.expectation,
			expectation,
		});
		return { status: "NEXT" as const, work };
	});
}
export function localStoryFlowRouteWorkExpectation(
	work: BoundLocalStoryFlowRouteWork,
) {
	return checked(() => workState(work).expectation);
}
function proposal<P extends object>(
	sourceTuple: LocalStoryFlowSourceTuple,
	key: LocalStoryFlowRecordKey,
	payload: P,
): LocalStoryFlowArtifactProposal<P> {
	const kind = "LOCAL_FLOW_ROUTE_V1" as const,
		identity = localStoryFlowRecordIdentity({ sourceTuple, kind, key }),
		proof = {
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
/** Structural evidence always comes from the original admitted native output. */
export function acceptLocalStoryFlowRouteWork(options: {
	work: BoundLocalStoryFlowRouteWork;
	native: AdmittedFlowNative;
}): AcceptedLocalStoryFlowRouteStep {
	return checked(() => {
		const o = fields(options, ["work", "native"]),
			work = o.work as BoundLocalStoryFlowRouteWork,
			w = workState(work),
			native = o.native as AdmittedFlowNative,
			observed = admittedFlowNativeEvidence(native),
			expected = localStoryFlowNativeExpectationEvidence(w.expectation);
		requireArtifact(same(observed.nativeKey, expected.nativeKey));
		const output = admittedFlowNativeOutput(native),
			core = buildLocalStoryFlowRouteStep({ expectation: w.route, output }),
			evidence = localStoryFlowRouteStepEvidence(core),
			route = localStoryFlowRouteExpectationEvidence(w.route);
		requireArtifact(same(output, evidence.rawOutput));
		const progressHash = localStoryFlowRouteProgressHash(
			w.context.source,
			core,
		);
		if (w.previous)
			requireArtifact(progressHash !== stepState(w.previous).progressHash);
		const observation = proposal(
			w.context.sourceTuple,
			{
				version: "local-story-flow-record-key-v1",
				purpose: "NATIVE_OBSERVATION",
				keyBody: {
					nativeKeyHash: expected.nativeKeyHash,
					originTaskId: observed.origin.originTaskId,
					slot: observed.origin.slot,
				},
			},
			observed,
		);
		const nativeRoot = w.previous
			? stepState(w.previous).nativeRoot
			: bindLocalStoryFlowNativeRoot({
					native,
					rootStep: core,
					observationRef: observation.ref,
				});
		const step = proposal<StepPayload>(
			w.context.sourceTuple,
			{
				version: "local-story-flow-record-key-v1",
				purpose: "STEP",
				keyBody: {
					expectationHash: route.expectationHash,
					observationHash: observed.observationHash,
					routePolicyHash:
						expected.nativeKey.relevantPolicyHashes.routePolicyHash,
				},
			},
			{
				version: "local-story-flow-step-artifact-v1",
				purpose: "STEP",
				sourceBindingHash: route.input.sourceBindingHash,
				treeHash: route.input.treeHash,
				observationRef: observation.ref,
				stepEvidence: evidence,
				stepHash: evidence.stepHash,
			},
		);
		const cache = proposal<CachePayload>(
			w.context.sourceTuple,
			{
				version: "local-story-flow-record-key-v1",
				purpose: "NATIVE_CACHE",
				keyBody: { nativeKeyHash: expected.nativeKeyHash },
			},
			{
				version: "local-story-flow-native-cache-v1",
				purpose: "NATIVE_CACHE",
				nativeKeyHash: expected.nativeKeyHash,
				observationRef: observation.ref,
				observationHash: observed.observationHash,
			},
		);
		const handle = Object.freeze({});
		steps.set(handle, {
			work,
			w,
			native,
			core,
			nativeRoot,
			progressHash,
			observation,
			step,
			cache,
		});
		return handle;
	});
}
export function localStoryFlowAcceptedRoutePublication(
	step: AcceptedLocalStoryFlowRouteStep,
) {
	return checked(() => {
		const s = stepState(step);
		return {
			archive: s.w.context.archive,
			context: s.w.context.context,
			work: s.work,
			expectation: s.w.expectation,
			native: s.native,
			previous: s.w.previous,
			nativeRoot: s.nativeRoot,
			progressHash: s.progressHash,
			observation: structuredClone(s.observation),
			step: structuredClone(s.step),
			cache: structuredClone(s.cache),
		};
	});
}
export function localStoryFlowAcceptedRouteCoreStep(
	step: AcceptedLocalStoryFlowRouteStep,
) {
	return checked(() => stepState(step).core);
}
export function localStoryFlowAcceptedRouteNativeRoot(
	step: AcceptedLocalStoryFlowRouteStep,
) {
	return checked(() => stepState(step).nativeRoot);
}
