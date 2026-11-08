import type { z } from "zod";
import { canonicalEditingJson } from "./automatic-binding";
import type { LocalStoryEvent } from "./local-story-contracts";
import {
	localStoryFlowContextSourceEvidence,
	type PreparedLocalStoryFlowContextSource,
	type SourceEvidence,
} from "./local-story-flow-context";
import {
	type BoundLocalStoryFlowContextTree,
	type LocalStoryFlowContextTreeEvidence,
	localStoryFlowContextTreeEvidence,
} from "./local-story-flow-context-tree";
import {
	type LocalStoryFlowClaimRef,
	type LocalStoryFlowRouteOutput,
	type LocalStoryFlowWitnessRef,
	localStoryFlowClaimRefSchema,
	localStoryFlowEventRefSchema,
	type localStoryFlowSummaryRefSchema,
	localStoryFlowWitnessRefSchema,
} from "./local-story-flow-contracts";
import { MAX_EDIT_DURATION_FRAMES } from "./schema";
import { hashEditingEvidence as hash } from "./verify-automatic-binding";

export const LOCAL_STORY_FLOW_CLOSURE_POLICY = Object.freeze({
	version: "local-story-flow-closure-policy-v1",
	eventLimit: 32,
	targetMaxFrames: MAX_EDIT_DURATION_FRAMES,
	guardRule: "exact-event-witness-all-claim-or-union-v1",
	seedRule: "root-all-plus-original-event-seeds-v1",
	hardChoiceRule: "immutable-claim-whole-witness-unused-not-seed-v1",
	pendingRule: "first-origin-after-known-fixed-point-v1",
	temporalRule: "direct-self-reject-same-anchor-union-prerequisites-v1",
	typedCycleRule: "fired-requires-and-exact-proof-realizations-v1",
	emptyCompositeRule: "no-distinct-dependent-after-all-targets-v1",
	diagnosticRule: "all-origins-downward-provenance-either-conflict-end-v1",
	clockRule: "not-evaluated-v1",
});
export type LocalStoryFlowClosureErrorCode =
	| "LOCAL_STORY_FLOW_CLOSURE_INVALID"
	| "LOCAL_STORY_FLOW_CLOSURE_DURATION_INVALID"
	| "LOCAL_STORY_FLOW_CLOSURE_CHOICE_INVALID"
	| "LOCAL_STORY_FLOW_CLOSURE_CHOICE_UNAVAILABLE"
	| "LOCAL_STORY_FLOW_CLOSURE_CHOICE_IMMUTABLE";
export class LocalStoryFlowClosureError extends Error {
	constructor(readonly code: LocalStoryFlowClosureErrorCode) {
		super(code);
		this.name = "LocalStoryFlowClosureError";
	}
}
type EventRef = z.infer<typeof localStoryFlowEventRefSchema>;
type SummaryRef = z.infer<typeof localStoryFlowSummaryRefSchema>;
type ClaimRef = LocalStoryFlowClaimRef;
type WitnessRef = LocalStoryFlowWitnessRef;
type Ref = EventRef | ClaimRef | WitnessRef;
type DiagnosticRef = Ref | SummaryRef;
export type LocalStoryFlowRootGoalChoice = Extract<
	LocalStoryFlowRouteOutput,
	{ phase: "ROOT" }
>["choice"];
export type LocalStoryFlowHardWitnessChoice = Extract<
	LocalStoryFlowRouteOutput,
	{ phase: "WITNESS" }
>["choice"];
export type LocalStoryFlowClosureOrigin = {
	ownerNodeId: string;
	index: number;
};
export type LocalStoryFlowClosureEventEvidence = {
	ref: EventRef;
	eventHash: string;
	sourceOrder: number;
	role: LocalStoryEvent["role"];
	minimumFrames: number | null;
};
export type LocalStoryFlowClosureStateEvidence = {
	version: "local-story-flow-closure-state-v1";
	sourceBindingHash: string;
	treeHash: string;
	policyHash: string;
	targetFrames: number;
	rootChoice: LocalStoryFlowRootGoalChoice;
	rootGoalText: string;
	rootEvents: LocalStoryFlowClosureEventEvidence[];
	hardChoices: {
		choice: LocalStoryFlowHardWitnessChoice;
		events: LocalStoryFlowClosureEventEvidence[];
	}[];
	structuralStateHash: string;
};
export type BoundLocalStoryFlowClosure = Readonly<object>;
type State = {
	source: SourceEvidence;
	tree: LocalStoryFlowContextTreeEvidence;
	evidence: LocalStoryFlowClosureStateEvidence;
};
const states = new WeakMap<BoundLocalStoryFlowClosure, State>();
const key = (value: unknown) => canonicalEditingJson(value);
const same = (a: unknown, b: unknown) => key(a) === key(b);
function requireClosure(
	value: unknown,
	code: LocalStoryFlowClosureErrorCode = "LOCAL_STORY_FLOW_CLOSURE_INVALID",
): asserts value {
	if (!value) throw new LocalStoryFlowClosureError(code);
}
function plain<T>(
	value: T,
	required: string[],
	optional: string[] = [],
	code: LocalStoryFlowClosureErrorCode = "LOCAL_STORY_FLOW_CLOSURE_INVALID",
): T & Record<string, unknown> {
	try {
		requireClosure(
			value !== null &&
				typeof value === "object" &&
				!Array.isArray(value) &&
				Object.getPrototypeOf(value) === Object.prototype,
			code,
		);
		const descriptors = Object.getOwnPropertyDescriptors(value);
		requireClosure(
			Object.getOwnPropertySymbols(value).length === 0 &&
				Object.keys(descriptors).every(
					(k) => required.includes(k) || optional.includes(k),
				) &&
				required.every((k) => Object.hasOwn(descriptors, k)),
			code,
		);
		for (const [name, descriptor] of Object.entries(descriptors))
			requireClosure(
				"value" in descriptor &&
					descriptor.enumerable &&
					(!optional.includes(name) || descriptor.value !== undefined),
				code,
			);
		return Object.fromEntries(
			Object.entries(descriptors).map(([name, d]) => [name, d.value]),
		) as T & Record<string, unknown>;
	} catch {
		throw new LocalStoryFlowClosureError(code);
	}
}
function dense(
	value: unknown,
	max: number,
	code: LocalStoryFlowClosureErrorCode = "LOCAL_STORY_FLOW_CLOSURE_INVALID",
): unknown[] {
	try {
		requireClosure(
			Array.isArray(value) &&
				Object.getPrototypeOf(value) === Array.prototype &&
				Object.getOwnPropertySymbols(value).length === 0,
			code,
		);
		const descriptors = Object.getOwnPropertyDescriptors(value),
			length = Object.getOwnPropertyDescriptor(value, "length")?.value;
		requireClosure(
			Number.isSafeInteger(length) &&
				length >= 0 &&
				length <= max &&
				Object.keys(descriptors).length === length + 1,
			code,
		);
		const copy: unknown[] = [];
		for (let i = 0; i < length; i++) {
			const d = descriptors[String(i)];
			requireClosure(d && "value" in d && d.enumerable, code);
			copy.push(d.value);
		}
		return copy;
	} catch {
		throw new LocalStoryFlowClosureError(code);
	}
}
function ref<S extends z.ZodType>(
	value: unknown,
	schema: S,
	code: LocalStoryFlowClosureErrorCode = "LOCAL_STORY_FLOW_CLOSURE_INVALID",
): z.infer<S> {
	// Inspect data descriptors before Zod reads any nested reference property.
	const data = plain(
		value,
		[],
		["kind", "nodeId", "claimId", "witnessId", "eventId", "summaryId"],
		code,
	);
	try {
		const parsed = schema.safeParse(data);
		requireClosure(parsed.success, code);
		plain(data, Object.keys(parsed.data as object), [], code);
		return parsed.data;
	} catch {
		throw new LocalStoryFlowClosureError(code);
	}
}
function freeze<T>(value: T): T {
	if (value && typeof value === "object") {
		for (const child of Object.values(value)) freeze(child);
		Object.freeze(value);
	}
	return value;
}
function stateOf(state: BoundLocalStoryFlowClosure): State {
	const value = states.get(state);
	requireClosure(value);
	return value;
}
export function localStoryFlowClosureStateEvidence(
	state: BoundLocalStoryFlowClosure,
): LocalStoryFlowClosureStateEvidence {
	return structuredClone(stateOf(state).evidence);
}
function readChoice<K extends "ROOT_GOAL" | "HARD_REQUIREMENT">(
	value: unknown,
	kind: K,
	tree: LocalStoryFlowContextTreeEvidence,
) {
	const code = "LOCAL_STORY_FLOW_CLOSURE_CHOICE_INVALID";
	const data = plain(value, ["kind", "claim", "witness"], [], code);
	const c = ref(data.claim, localStoryFlowClaimRefSchema, code),
		w = ref(data.witness, localStoryFlowWitnessRefSchema, code);
	requireClosure(
		data.kind === kind && c.nodeId === w.nodeId && c.claimId === w.claimId,
		code,
	);
	const owner = tree.graph.claims.find((r) => same(r.ref, c)),
		proof = tree.graph.witnesses.find((r) => same(r.ref, w));
	requireClosure(
		owner && proof && owner.witnessRefs.some((r) => same(r, w)),
		code,
	);
	if (kind === "ROOT_GOAL") requireClosure(c.nodeId === tree.rootNodeId, code);
	return { choice: { kind, claim: c, witness: w }, proof, owner };
}
function available(
	proof: LocalStoryFlowContextTreeEvidence["graph"]["witnesses"][number],
	target: number,
) {
	return (
		proof.events.length > 0 &&
		proof.eligibility.availability !== "UNAVAILABLE" &&
		(proof.eligibility.minimumFramesLowerBound === null ||
			proof.eligibility.minimumFramesLowerBound <= target)
	);
}
function publish(
	source: SourceEvidence,
	tree: LocalStoryFlowContextTreeEvidence,
	body: Omit<LocalStoryFlowClosureStateEvidence, "structuralStateHash">,
): BoundLocalStoryFlowClosure {
	const handle = Object.freeze({});
	states.set(handle, {
		source,
		tree,
		evidence: freeze(
			structuredClone({ ...body, structuralStateHash: hash(body) }),
		),
	});
	return handle;
}
export function prepareLocalStoryFlowClosure(options: {
	source: PreparedLocalStoryFlowContextSource;
	tree: BoundLocalStoryFlowContextTree;
	targetFrames: number;
	rootChoice: unknown;
	hardChoices?: readonly unknown[];
}): BoundLocalStoryFlowClosure {
	options = plain(
		options,
		["source", "tree", "targetFrames", "rootChoice"],
		["hardChoices"],
	);
	requireClosure(
		Number.isSafeInteger(options.targetFrames) &&
			options.targetFrames >= 1 &&
			options.targetFrames <= MAX_EDIT_DURATION_FRAMES,
		"LOCAL_STORY_FLOW_CLOSURE_DURATION_INVALID",
	);
	const source = freeze(localStoryFlowContextSourceEvidence(options.source)),
		tree = freeze(
			localStoryFlowContextTreeEvidence(options.tree, options.source),
		);
	const root = readChoice(options.rootChoice, "ROOT_GOAL", tree);
	requireClosure(
		available(root.proof, options.targetFrames),
		"LOCAL_STORY_FLOW_CLOSURE_CHOICE_UNAVAILABLE",
	);
	const raw = dense(
		Object.hasOwn(options, "hardChoices") ? options.hardChoices : [],
		tree.graph.claims.length,
		"LOCAL_STORY_FLOW_CLOSURE_CHOICE_INVALID",
	);
	const choices = new Map<
		string,
		LocalStoryFlowClosureStateEvidence["hardChoices"][number]
	>();
	for (const v of raw) {
		const c = readChoice(v, "HARD_REQUIREMENT", tree);
		requireClosure(
			!choices.has(key(c.choice.claim)),
			"LOCAL_STORY_FLOW_CLOSURE_CHOICE_INVALID",
		);
		requireClosure(
			available(c.proof, options.targetFrames),
			"LOCAL_STORY_FLOW_CLOSURE_CHOICE_UNAVAILABLE",
		);
		choices.set(key(c.choice.claim), {
			choice: c.choice,
			events: structuredClone(c.proof.events),
		});
	}
	const hardChoices = tree.graph.claims.flatMap((c) => {
		const value = choices.get(key(c.ref));
		return value ? [value] : [];
	});
	return publish(source, tree, {
		version: "local-story-flow-closure-state-v1",
		sourceBindingHash: source.sourceBindingHash,
		treeHash: tree.treeHash,
		policyHash: hash(LOCAL_STORY_FLOW_CLOSURE_POLICY),
		targetFrames: options.targetFrames,
		rootChoice: root.choice,
		rootGoalText: root.owner.text,
		rootEvents: structuredClone(root.proof.events),
		hardChoices,
	});
}
export function extendLocalStoryFlowHardChoice(options: {
	state: BoundLocalStoryFlowClosure;
	requestedClaim: unknown;
	choice: unknown;
}): BoundLocalStoryFlowClosure {
	options = plain(options, ["state", "requestedClaim", "choice"]);
	const state = stateOf(options.state),
		requested = ref(options.requestedClaim, localStoryFlowClaimRefSchema);
	requireClosure(state.tree.graph.claims.some((c) => same(c.ref, requested)));
	const c = readChoice(options.choice, "HARD_REQUIREMENT", state.tree);
	requireClosure(
		same(requested, c.choice.claim),
		"LOCAL_STORY_FLOW_CLOSURE_CHOICE_INVALID",
	);
	const existing = state.evidence.hardChoices.find((v) =>
		same(v.choice.claim, requested),
	);
	if (existing)
		requireClosure(
			same(existing.choice, c.choice),
			"LOCAL_STORY_FLOW_CLOSURE_CHOICE_IMMUTABLE",
		);
	else
		requireClosure(
			available(c.proof, state.evidence.targetFrames),
			"LOCAL_STORY_FLOW_CLOSURE_CHOICE_UNAVAILABLE",
		);
	const { structuralStateHash: _hash, ...body } = structuredClone(
		state.evidence,
	);
	if (!existing)
		body.hardChoices.push({
			choice: c.choice,
			events: structuredClone(c.proof.events),
		});
	body.hardChoices.sort(
		(a, b) =>
			state.tree.graph.claims.findIndex((c) => same(c.ref, a.choice.claim)) -
			state.tree.graph.claims.findIndex((c) => same(c.ref, b.choice.claim)),
	);
	return publish(state.source, state.tree, body);
}

type Graph = LocalStoryFlowContextTreeEvidence["graph"];
type Requires = Graph["relations"][number] & {
	relation: Extract<
		Graph["relations"][number]["relation"],
		{ kind: "REQUIRES" }
	>;
};
const origin = (
	r: LocalStoryFlowClosureOrigin,
): LocalStoryFlowClosureOrigin => ({
	ownerNodeId: r.ownerNodeId,
	index: r.index,
});
function lookup<K, V>(map: Map<K, V>, id: K): V {
	const value = map.get(id);
	requireClosure(value !== undefined);
	return value;
}
function indexSource(state: State) {
	const { source, tree } = state;
	const events: LocalStoryFlowClosureEventEvidence[] =
		source.manifest.items.flatMap((i) =>
			i.kind === "GROUNDED_LEAF_EVENT_CARD"
				? [
						{
							ref: { kind: "EVENT" as const, eventId: i.id },
							eventHash: i.eventHash,
							sourceOrder: i.sourceOrder,
							role: i.role,
							minimumFrames: i.minimumFrames,
						},
					]
				: [],
		);
	const eventByKey = new Map(events.map((e) => [key(e.ref), e]));
	const claims = new Map(tree.graph.claims.map((c) => [key(c.ref), c])),
		witnesses = new Map(tree.graph.witnesses.map((w) => [key(w.ref), w]));
	const guards = new Map<string, Set<string>>();
	for (const e of events) guards.set(key(e.ref), new Set([key(e.ref)]));
	for (const w of tree.graph.witnesses)
		guards.set(key(w.ref), new Set(w.events.map((e) => key(e.ref))));
	for (const c of tree.graph.claims)
		guards.set(
			key(c.ref),
			new Set(
				c.witnessRefs.flatMap((w) =>
					lookup(witnesses, key(w)).events.map((e) => key(e.ref)),
				),
			),
		);
	const requires = tree.graph.relations.filter(
		(r): r is Requires => r.relation.kind === "REQUIRES",
	);
	return { events, eventByKey, claims, witnesses, guards, requires };
}
type Index = ReturnType<typeof indexSource>;
function knownClosure(state: State, index: Index, seeds: EventRef[]) {
	const { evidence, tree } = state;
	const required = new Set(
		[...seeds, ...evidence.rootEvents.map((e) => e.ref)].map(key),
	);
	const eventOrigins = new Map<string, LocalStoryFlowClosureOrigin | null>(
		[...required].map((r) => [r, null]),
	);
	const committed = new Set<string>(),
		used = new Set<string>(),
		fired = new Set<number>(),
		resolved = new Map<number, EventRef[]>();
	const choices = new Map(
		evidence.hardChoices.map((c) => [key(c.choice.claim), c]),
	);
	let limitOrigin: LocalStoryFlowClosureOrigin | null = null;
	const addEvents = (events: EventRef[], edge: Requires) => {
		const before = required.size;
		for (const event of events) {
			if (!required.has(key(event))) eventOrigins.set(key(event), origin(edge));
			required.add(key(event));
		}
		if (before <= 32 && required.size > 32) limitOrigin = origin(edge);
	};
	const commit = (ref: WitnessRef) => {
		const w = lookup(index.witnesses, key(ref));
		if (committed.has(key(ref))) return;
		committed.add(key(ref));
		committed.add(
			key({ kind: "CLAIM", nodeId: ref.nodeId, claimId: ref.claimId }),
		);
		for (const atom of w.allOf) if (atom.kind === "WITNESS") commit(atom);
	};
	commit(evidence.rootChoice.witness);
	let changed = true;
	while (changed) {
		changed = false;
		for (const [id, edge] of index.requires.entries()) {
			const { from, target } = edge.relation;
			if (
				!fired.has(id) &&
				(committed.has(key(from)) ||
					[...lookup(index.guards, key(from))].some((e) => required.has(e)))
			) {
				fired.add(id);
				changed = true;
			}
			if (!fired.has(id) || resolved.has(id)) continue;
			if (target.kind === "EVENT") {
				addEvents([target], edge);
				resolved.set(id, [target]);
				changed = true;
			} else {
				const choice = choices.get(key(target));
				if (choice) {
					addEvents(
						choice.events.map((e) => e.ref),
						edge,
					);
					commit(choice.choice.witness);
					used.add(key(target));
					resolved.set(
						id,
						choice.events.map((e) => e.ref),
					);
					changed = true;
				}
			}
		}
	}
	const firedRequires = index.requires.filter((_, id) => fired.has(id));
	const missing = index.requires.find(
		(_, id) => fired.has(id) && !resolved.has(id),
	);
	const ordered = (set: Set<string>) =>
		index.events.filter((e) => set.has(key(e.ref))).map((e) => e.ref);
	return {
		required,
		eventOrigins,
		committed,
		used,
		fired,
		resolved,
		firedRequires,
		missing,
		limitOrigin,
		ordered,
		requiredEvents: index.events.filter((e) => required.has(key(e.ref))),
		committedRefs: [...tree.graph.claims, ...tree.graph.witnesses]
			.map((r) => r.ref)
			.filter((r) => committed.has(key(r))),
		usedHardClaims: evidence.hardChoices
			.filter((c) => used.has(key(c.choice.claim)))
			.map((c) => c.choice.claim),
		unusedHardClaims: evidence.hardChoices
			.filter((c) => !used.has(key(c.choice.claim)))
			.map((c) => c.choice.claim),
	};
}

type UnreachedReason =
	| "EVENT_LIMIT"
	| "REQUIRED_EVENT_UNAVAILABLE"
	| "HARD_TARGET_NO_WITNESS"
	| "HARD_TARGET_UNAVAILABLE"
	| "DIRECT_SELF_DEPENDENCY"
	| "TYPED_REQUIREMENT_CYCLE"
	| "RELEVANT_CONTRADICTION"
	| "RELEVANT_ISSUE"
	| "TEMPORAL_DEPENDENCY_CYCLE"
	| "NO_DISTINCT_DEPENDENT";
type Failure = {
	reason: UnreachedReason;
	origin: LocalStoryFlowClosureOrigin | null;
	ref: Ref | null;
	cycle: Ref[] | null;
};
type Known = ReturnType<typeof knownClosure>;
function failure(
	reason: UnreachedReason,
	at: LocalStoryFlowClosureOrigin | null = null,
	ref: Ref | null = null,
	cycle: Ref[] | null = null,
): Failure {
	return { reason, origin: at, ref, cycle };
}
function knownFailure(
	state: State,
	index: Index,
	known: Known,
): Failure | null {
	if (known.required.size > 32)
		return failure("EVENT_LIMIT", known.limitOrigin);
	const badEvent = known.requiredEvents.find(
		(e) =>
			e.minimumFrames === null || e.minimumFrames > state.evidence.targetFrames,
	);
	if (badEvent)
		return failure(
			"REQUIRED_EVENT_UNAVAILABLE",
			known.eventOrigins.get(key(badEvent.ref)) ?? null,
			badEvent.ref,
		);
	for (const edge of known.firedRequires) {
		const { target } = edge.relation;
		if (
			target.kind === "CLAIM" &&
			lookup(index.claims, key(target)).witnessRefs.length === 0
		)
			return failure("HARD_TARGET_NO_WITNESS", origin(edge), target);
	}
	for (const edge of known.firedRequires) {
		const { target } = edge.relation;
		if (
			target.kind === "CLAIM" &&
			!lookup(index.claims, key(target)).witnessRefs.some((w) =>
				available(lookup(index.witnesses, key(w)), state.evidence.targetFrames),
			)
		)
			return failure("HARD_TARGET_UNAVAILABLE", origin(edge), target);
	}
	for (const [id, edge] of index.requires.entries()) {
		const { from } = edge.relation;
		if (
			known.fired.has(id) &&
			from.kind === "EVENT" &&
			known.resolved.get(id)?.some((e) => same(e, from))
		)
			return failure("DIRECT_SELF_DEPENDENCY", origin(edge), from);
	}
	return null;
}

type DirectedEdge = {
	from: Ref;
	to: Ref;
	origin: LocalStoryFlowClosureOrigin | null;
};
function firstCycle(
	vertices: Ref[],
	edges: DirectedEdge[],
): { walk: Ref[]; origin: LocalStoryFlowClosureOrigin | null } | null {
	const outgoing = new Map<string, DirectedEdge[]>();
	for (const edge of edges) {
		const k = key(edge.from);
		const list = outgoing.get(k) ?? [];
		list.push(edge);
		outgoing.set(k, list);
	}
	const color = new Map<string, 1 | 2>(),
		position = new Map<string, number>();
	for (const vertex of vertices) {
		if (color.has(key(vertex))) continue;
		const stack: { ref: Ref; next: number; via: DirectedEdge | null }[] = [
			{ ref: vertex, next: 0, via: null },
		];
		color.set(key(vertex), 1);
		position.set(key(vertex), 0);
		while (stack.length) {
			const frame = stack[stack.length - 1];
			requireClosure(frame);
			const edge = outgoing.get(key(frame.ref))?.[frame.next++];
			if (!edge) {
				color.set(key(frame.ref), 2);
				position.delete(key(frame.ref));
				stack.pop();
				continue;
			}
			if (color.get(key(edge.to)) === 1) {
				const start = position.get(key(edge.to));
				requireClosure(start !== undefined);
				const cycleEdges = [
					...stack.slice(start + 1).flatMap((f) => (f.via ? [f.via] : [])),
					edge,
				];
				const origins = new Set(
					cycleEdges.flatMap((e) => (e.origin ? [key(e.origin)] : [])),
				);
				const at =
					edges.find((e) => e.origin && origins.has(key(e.origin)))?.origin ??
					null;
				return {
					walk: [...stack.slice(start).map((f) => f.ref), edge.to],
					origin: at,
				};
			}
			if (!color.has(key(edge.to))) {
				color.set(key(edge.to), 1);
				position.set(key(edge.to), stack.length);
				stack.push({ ref: edge.to, next: 0, via: edge });
			}
		}
	}
	return null;
}
function typedGraph(
	state: State,
	index: Index,
	known: Known,
	seeds: EventRef[],
) {
	const { evidence: e, tree } = state,
		visited = new Set<string>();
	const trace = (ref: WitnessRef) => {
		if (visited.has(key(ref))) return;
		visited.add(key(ref));
		for (const atom of lookup(index.witnesses, key(ref)).allOf)
			if (atom.kind === "WITNESS") trace(atom);
	};
	const hard = e.hardChoices
		.filter((c) => known.used.has(key(c.choice.claim)))
		.map((c) => c.choice.witness);
	const firedWitnesses = known.firedRequires.flatMap((edge) =>
		edge.relation.from.kind === "WITNESS"
			? [{ origin: origin(edge), witness: edge.relation.from }]
			: [],
	);
	trace(e.rootChoice.witness);
	for (const w of hard) trace(w);
	for (const w of firedWitnesses) trace(w.witness);
	const realizations = tree.graph.witnesses
		.filter((w) => visited.has(key(w.ref)))
		.map((w) => ({
			claim: {
				kind: "CLAIM" as const,
				nodeId: w.ref.nodeId,
				claimId: w.ref.claimId,
			},
			witness: w.ref,
		}));
	const atoms = tree.graph.witnesses
		.filter((w) => visited.has(key(w.ref)))
		.flatMap((w) =>
			w.allOf.map((atom, atomIndex) => ({ witness: w.ref, atomIndex, atom })),
		);
	const requires = known.firedRequires.map((edge) => ({
		origin: origin(edge),
		from: edge.relation.from,
		target: edge.relation.target,
	}));
	const body = {
		version: "local-story-flow-closure-typed-graph-v1",
		sourceBindingHash: e.sourceBindingHash,
		treeHash: e.treeHash,
		policyHash: e.policyHash,
		structuralStateHash: e.structuralStateHash,
		seeds,
		requires,
		proofRoots: { root: e.rootChoice.witness, hard, firedWitnesses },
		realizations,
		atoms,
	};
	const edges: DirectedEdge[] = [
		...requires.map((r) => ({ from: r.from, to: r.target, origin: r.origin })),
		...realizations.map((r) => ({
			from: r.claim,
			to: r.witness,
			origin: null,
		})),
		...atoms.map((r) => ({
			from: r.witness,
			to:
				r.atom.kind === "EVENT"
					? r.atom
					: {
							kind: "CLAIM" as const,
							nodeId: r.atom.nodeId,
							claimId: r.atom.claimId,
						},
			origin: null,
		})),
	];
	const vertices = [
		...index.events.map((e) => e.ref),
		...tree.graph.claims.map((c) => c.ref),
		...tree.graph.witnesses.map((w) => w.ref),
	];
	return { hash: hash(body), cycle: firstCycle(vertices, edges) };
}

type TemporalRequirement = {
	origin: LocalStoryFlowClosureOrigin;
	prerequisites: EventRef[];
	dependents: EventRef[];
};
function temporalProjection(
	index: Index,
	known: Known,
): { rows: TemporalRequirement[]; failure: Failure | null } {
	// Aggregate every prerequisite for the exact composite anchor before making any T.
	const prerequisitesByFrom = new Map<string, Set<string>>();
	for (const [id, edge] of index.requires.entries()) {
		if (!known.fired.has(id)) continue;
		const p = lookup(known.resolved, id),
			k = key(edge.relation.from),
			union = prerequisitesByFrom.get(k) ?? new Set<string>();
		for (const e of p) union.add(key(e));
		prerequisitesByFrom.set(k, union);
	}
	const rows: TemporalRequirement[] = known.firedRequires.map((edge) => {
		const id = index.requires.indexOf(edge),
			from = edge.relation.from;
		const prerequisites = known.ordered(
			new Set(lookup(known.resolved, id).map(key)),
		);
		const excluded = lookup(prerequisitesByFrom, key(from));
		const dependents =
			from.kind === "EVENT"
				? [from]
				: known.ordered(
						new Set(
							[...lookup(index.guards, key(from))].filter(
								(r) => known.required.has(r) && !excluded.has(r),
							),
						),
					);
		return { origin: origin(edge), prerequisites, dependents };
	});
	const edges = new Map<string, DirectedEdge>();
	for (const row of rows)
		for (const p of row.prerequisites)
			for (const t of row.dependents) {
				const k = key([p, t]);
				if (!edges.has(k)) edges.set(k, { from: p, to: t, origin: row.origin });
			}
	const cycle = firstCycle(
		index.events
			.filter((e) => known.required.has(key(e.ref)))
			.map((e) => e.ref),
		[...edges.values()],
	);
	if (cycle)
		return {
			rows,
			failure: failure(
				"TEMPORAL_DEPENDENCY_CYCLE",
				cycle.origin,
				null,
				cycle.walk,
			),
		};
	const empty = rows.find((r) => r.dependents.length === 0);
	return {
		rows,
		failure: empty ? failure("NO_DISTINCT_DEPENDENT", empty.origin) : null,
	};
}

function diagnosticScan(state: State, index: Index, known: Known) {
	const { source, tree, evidence } = state,
		relevant = new Set<string>(),
		queue: DiagnosticRef[] = [];
	const add = (ref: DiagnosticRef) => {
		if (!relevant.has(key(ref))) {
			relevant.add(key(ref));
			queue.push(ref);
		}
	};
	for (const e of known.requiredEvents) add(e.ref);
	for (const ref of known.committedRefs) add(ref);
	for (const row of [...tree.graph.claims, ...tree.graph.witnesses])
		if (
			[...lookup(index.guards, key(row.ref))].some((e) => known.required.has(e))
		)
			add(row.ref);
	const requiredChunks = new Set(
		source.manifest.items
			.filter(
				(i) =>
					i.kind === "GROUNDED_LEAF_EVENT_CARD" &&
					known.required.has(key({ kind: "EVENT", eventId: i.id })),
			)
			.map((i) => i.chunkIndex),
	);
	for (const item of source.manifest.items)
		if (
			item.kind === "DERIVED_CHUNK_SUMMARY" &&
			requiredChunks.has(item.chunkIndex)
		)
			add({ kind: "SUMMARY", summaryId: item.id });
	for (let i = 0; i < queue.length; i++) {
		const ref = queue[i];
		requireClosure(ref);
		if (ref.kind === "CLAIM") {
			const c = lookup(index.claims, key(ref));
			for (const r of c.supports) add(r);
			for (const r of c.witnessRefs) add(r);
		} else if (ref.kind === "WITNESS") {
			for (const r of lookup(index.witnesses, key(ref)).allOf) {
				add(r);
				if (r.kind === "WITNESS")
					add({ kind: "CLAIM", nodeId: r.nodeId, claimId: r.claimId });
			}
		}
	}
	const itemRefs = source.manifest.items.map((i) =>
		i.kind === "DERIVED_CHUNK_SUMMARY"
			? { kind: "SUMMARY" as const, summaryId: i.id }
			: { kind: "EVENT" as const, eventId: i.id },
	);
	const relevantRefs = [
		...itemRefs,
		...tree.graph.claims.map((c) => c.ref),
		...tree.graph.witnesses.map((w) => w.ref),
	].filter((r) => relevant.has(key(r)));
	const pageOwners = new Map<string, string>();
	for (const node of tree.layout.nodes)
		if (node.phase === "LEAF") {
			const page = source.pages.find((p) => p.pageId === node.pageId);
			requireClosure(page);
			for (const item of page.data.items) pageOwners.set(item.id, node.nodeId);
		}
	const parents = new Map<string, string>();
	for (const node of tree.layout.nodes)
		if (node.phase === "MERGE")
			for (const child of node.children) parents.set(child, node.nodeId);
	const relevantNodes = new Set<string>();
	for (const ref of relevantRefs) {
		let nodeId =
			ref.kind === "SUMMARY"
				? lookup(pageOwners, ref.summaryId)
				: ref.kind === "EVENT"
					? lookup(pageOwners, ref.eventId)
					: ref.nodeId;
		while (!relevantNodes.has(nodeId)) {
			relevantNodes.add(nodeId);
			const parent = parents.get(nodeId);
			if (parent === undefined) break;
			nodeId = parent;
		}
	}
	const relevantNodeIds = tree.layout.nodes
		.filter((n) => relevantNodes.has(n.nodeId))
		.map((n) => n.nodeId);
	const fired = new Set(known.firedRequires.map((r) => key(origin(r))));
	const relations = tree.graph.relations.map((r) => ({
		origin: origin(r),
		applies:
			r.relation.kind === "REQUIRES"
				? fired.has(key(origin(r)))
				: relevant.has(key(r.relation.from)) ||
					relevant.has(key(r.relation.target)),
	}));
	const issues = tree.graph.unresolved.map((r) => ({
		origin: origin(r),
		applies:
			r.issue.ref.kind === "CHILD_NODE"
				? relevantNodes.has(r.issue.ref.nodeId)
				: relevant.has(key(r.issue.ref)),
	}));
	const blockingRelations = relations
		.filter(
			(r, i) =>
				r.applies && tree.graph.relations[i]?.relation.kind === "CONTRADICTS",
		)
		.map((r) => r.origin);
	const blockingIssues = issues.filter((r) => r.applies).map((r) => r.origin);
	const fullGraphHash = hash(tree.graph);
	const scanHash = hash({
		version: "local-story-flow-closure-diagnostic-scan-v1",
		fullGraphHash,
		structuralStateHash: evidence.structuralStateHash,
		requiredEventRefs: known.requiredEvents.map((e) => e.ref),
		committedRefs: known.committedRefs,
		relevantRefs,
		relevantNodeIds,
		relations,
		issues,
	});
	return {
		fullGraphHash,
		relevantRefs,
		relevantNodeIds,
		blockingRelations,
		blockingIssues,
		relationCount: relations.length,
		issueCount: issues.length,
		scanHash,
	};
}

type ClosureStatus =
	| { status: "COMPLETE" }
	| {
			status: "PENDING_HARD_CHOICE";
			pending: {
				origin: LocalStoryFlowClosureOrigin;
				requestedClaim: ClaimRef;
			};
	  }
	| { status: "UNREACHED"; failure: Failure };
type ClosureCommon = {
	version: "local-story-flow-closure-result-v1";
	sourceBindingHash: string;
	treeHash: string;
	policyHash: string;
	structuralStateHash: string;
	targetFrames: number;
	seeds: EventRef[];
	requiredEvents: LocalStoryFlowClosureEventEvidence[];
	usedHardClaims: ClaimRef[];
	unusedHardClaims: ClaimRef[];
	committedRefs: (ClaimRef | WitnessRef)[];
	firedRequires: LocalStoryFlowClosureOrigin[];
	resolvedRequires: {
		origin: LocalStoryFlowClosureOrigin;
		events: EventRef[];
	}[];
	typedGraphHash: string;
	diagnostics: ReturnType<typeof diagnosticScan>;
	temporalRequirements: TemporalRequirement[] | null;
	clockStatus: "NOT_EVALUATED";
};
export type LocalStoryFlowClosureResult = ClosureCommon &
	ClosureStatus & { resultHash: string };
function finish(
	body: ClosureCommon & ClosureStatus,
): LocalStoryFlowClosureResult {
	return structuredClone({ ...body, resultHash: hash(body) });
}
/** Structural closure only; native admission, joint duration and render permission remain unproven. */
export function evaluateLocalStoryFlowClosure(options: {
	state: BoundLocalStoryFlowClosure;
	seeds: readonly unknown[];
}): LocalStoryFlowClosureResult {
	options = plain(options, ["state", "seeds"]);
	const state = stateOf(options.state),
		index = indexSource(state);
	const seeds = dense(options.seeds, 32).map((v) =>
			ref(v, localStoryFlowEventRefSchema),
		),
		seen = new Set<string>();
	for (const r of seeds) {
		requireClosure(index.eventByKey.has(key(r)) && !seen.has(key(r)));
		seen.add(key(r));
	}
	const orderedSeeds = index.events
			.filter((e) => seen.has(key(e.ref)))
			.map((e) => e.ref),
		known = knownClosure(state, index, orderedSeeds);
	const typed = typedGraph(state, index, known, orderedSeeds),
		diagnostics = diagnosticScan(state, index, known),
		e = state.evidence;
	const common: ClosureCommon = {
		version: "local-story-flow-closure-result-v1",
		sourceBindingHash: e.sourceBindingHash,
		treeHash: e.treeHash,
		policyHash: e.policyHash,
		structuralStateHash: e.structuralStateHash,
		targetFrames: e.targetFrames,
		seeds: orderedSeeds,
		clockStatus: "NOT_EVALUATED",
		diagnostics,
		temporalRequirements: null,
		typedGraphHash: typed.hash,
		requiredEvents: known.requiredEvents,
		usedHardClaims: known.usedHardClaims,
		unusedHardClaims: known.unusedHardClaims,
		committedRefs: known.committedRefs,
		firedRequires: known.firedRequires.map(origin),
		resolvedRequires: index.requires.flatMap((edge, id) => {
			const events = known.resolved.get(id);
			return events ? [{ origin: origin(edge), events }] : [];
		}),
	};
	const issue = knownFailure(state, index, known);
	if (issue) return finish({ ...common, status: "UNREACHED", failure: issue });
	if (typed.cycle)
		return finish({
			...common,
			status: "UNREACHED",
			failure: failure(
				"TYPED_REQUIREMENT_CYCLE",
				typed.cycle.origin,
				null,
				typed.cycle.walk,
			),
		});
	if (diagnostics.blockingRelations[0])
		return finish({
			...common,
			status: "UNREACHED",
			failure: failure(
				"RELEVANT_CONTRADICTION",
				diagnostics.blockingRelations[0],
			),
		});
	if (diagnostics.blockingIssues[0])
		return finish({
			...common,
			status: "UNREACHED",
			failure: failure("RELEVANT_ISSUE", diagnostics.blockingIssues[0]),
		});
	if (known.missing && known.missing.relation.target.kind === "CLAIM")
		return finish({
			...common,
			status: "PENDING_HARD_CHOICE",
			pending: {
				origin: origin(known.missing),
				requestedClaim: known.missing.relation.target,
			},
		});
	const temporal = temporalProjection(index, known);
	if (temporal.failure)
		return finish({
			...common,
			temporalRequirements: temporal.rows,
			status: "UNREACHED",
			failure: temporal.failure,
		});
	return finish({
		...common,
		temporalRequirements: temporal.rows,
		status: "COMPLETE",
	});
}
