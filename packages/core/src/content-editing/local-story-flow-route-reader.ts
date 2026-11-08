import { canonicalEditingJson as json } from "./automatic-binding";
import {
	type BoundLocalStoryFlowAcceptedContext,
	type LocalStoryFlowArtifactProposal,
	localStoryFlowAcceptedContextEvidence,
} from "./local-story-flow-artifact-reader";
import {
	admitFlowNativeObservation,
	type LocalStoryFlowNativeObservation,
	localStoryFlowNativeExpectationEvidence,
	localStoryFlowNativeRootEvidence,
} from "./local-story-flow-native";
import {
	type AcceptedLocalStoryFlowRouteStep,
	acceptLocalStoryFlowRouteWork,
	localStoryFlowAcceptedRoutePublication,
	localStoryFlowRouteWorkExpectation,
	nextLocalStoryFlowRouteWork,
} from "./local-story-flow-route-artifacts";
import {
	admitLocalStoryFlowAcceptedOrigin,
	type BoundLocalStoryFlowRuntimeHistory,
	type BoundLocalStoryFlowRuntimeIdentity,
	isLocalStoryFlowRuntimeFailureCode,
	type LocalStoryFlowRuntimeFailureCode,
	localStoryFlowAcceptedOriginEvidence,
	localStoryFlowRuntimeHistoryEvidence,
	localStoryFlowRuntimeIdentityEvidence,
	localStoryFlowRuntimeStartRecord,
} from "./local-story-flow-runtime-history";
import {
	type BoundLocalStoryFlowSealedRecord,
	type LocalStoryFlowRecordKey,
	type LocalStoryFlowRecordRef,
	type LocalStoryFlowSealedRecordEvidence,
	type LocalStoryFlowSourceTuple,
	localStoryFlowRecordIdentity,
	localStoryFlowSealedRecordEvidence,
} from "./local-story-flow-seals";
import {
	type BoundLocalStoryFlowSourceArchive,
	localStoryFlowSourceArchiveEvidence,
} from "./local-story-flow-source-archive";
import { hashEditingEvidence as hash } from "./verify-automatic-binding";

export const LOCAL_STORY_FLOW_ROUTE_READ_POLICY = Object.freeze({
	version: "local-story-flow-route-read-policy-v1",
	originRule: "original-task-start-attempt-accepted-outcome-v1",
	rebuildRule: "scheduled-expectation-original-native-whole-route-v1",
	mirrorRule: "full-observation-step-cache-outcome-prefix-v1",
	maxRouteSteps: 64,
});
export class LocalStoryFlowRouteReadError extends Error {
	constructor(
		readonly code: LocalStoryFlowRuntimeFailureCode = "LOCAL_STORY_ARTIFACT_UNVERIFIED",
	) {
		super(code);
		this.name = "LocalStoryFlowRouteReadError";
	}
}
function requireRead(value: unknown): asserts value {
	if (!value) throw new LocalStoryFlowRouteReadError();
}
function checked<T>(read: () => T): T {
	try {
		return read();
	} catch (error) {
		let code: LocalStoryFlowRuntimeFailureCode =
			"LOCAL_STORY_ARTIFACT_UNVERIFIED";
		try {
			if (error instanceof LocalStoryFlowRouteReadError) {
				const descriptor = Object.getOwnPropertyDescriptor(error, "code");
				if (
					descriptor &&
					"value" in descriptor &&
					isLocalStoryFlowRuntimeFailureCode(descriptor.value)
				)
					code = descriptor.value;
			}
		} catch {
			/* Unknown proxy traps are not diagnostic authority. */
		}
		throw new LocalStoryFlowRouteReadError(code);
	}
}
const same = (a: unknown, b: unknown) => json(a) === json(b);
function fields(value: unknown, expected: readonly string[]) {
	requireRead(
		typeof value === "object" &&
			value !== null &&
			Object.getPrototypeOf(value) === Object.prototype &&
			Object.getOwnPropertySymbols(value).length === 0,
	);
	const d = Object.getOwnPropertyDescriptors(value);
	requireRead(
		Object.keys(d).sort().join(",") === [...expected].sort().join(",") &&
			Object.values(d).every((p) => p.enumerable && "value" in p),
	);
	return Object.fromEntries(
		Object.entries(d).map(([key, p]) => [key, p.value]),
	);
}
function list(value: unknown): unknown[] {
	requireRead(
		Array.isArray(value) &&
			Object.getPrototypeOf(value) === Array.prototype &&
			Object.getOwnPropertySymbols(value).length === 0,
	);
	const d = Object.getOwnPropertyDescriptors(value as object),
		length = d.length?.value;
	requireRead(
		Number.isSafeInteger(length) &&
			length >= 0 &&
			length <= LOCAL_STORY_FLOW_ROUTE_READ_POLICY.maxRouteSteps &&
			Object.keys(d).length === length + 1,
	);
	return Array.from({ length }, (_, index) => {
		const entry = d[String(index)];
		requireRead(entry?.enumerable && "value" in entry);
		return entry.value;
	});
}
export type LocalStoryFlowRouteHydrationSnapshot = {
	steps: readonly BoundLocalStoryFlowSealedRecord[];
	observations: readonly BoundLocalStoryFlowSealedRecord[];
	nativeCaches: readonly BoundLocalStoryFlowSealedRecord[];
	origins: readonly {
		identity: BoundLocalStoryFlowRuntimeIdentity;
		start: BoundLocalStoryFlowSealedRecord;
		attempt: BoundLocalStoryFlowSealedRecord;
		outcome: BoundLocalStoryFlowSealedRecord;
	}[];
};
type Stored = {
	handle: BoundLocalStoryFlowSealedRecord;
	evidence: LocalStoryFlowSealedRecordEvidence;
};
function records(
	value: unknown,
	sourceTuple: LocalStoryFlowSourceTuple,
	purpose: string,
) {
	const map = new Map<string, Stored>();
	for (const unknown of list(value)) {
		const handle = unknown as BoundLocalStoryFlowSealedRecord,
			evidence = localStoryFlowSealedRecordEvidence(handle);
		requireRead(
			evidence.kind === "LOCAL_FLOW_ROUTE_V1" &&
				same(evidence.sourceTuple, sourceTuple) &&
				evidence.key.purpose === purpose &&
				!map.has(evidence.ref.receiptId),
		);
		map.set(evidence.ref.receiptId, { handle, evidence });
	}
	return map;
}
function take(map: Map<string, Stored>, ref: LocalStoryFlowRecordRef) {
	const found = map.get(ref.receiptId);
	requireRead(found && same(found.evidence.ref, ref));
	map.delete(ref.receiptId);
	return found;
}
function matching(actual: Stored, expected: LocalStoryFlowArtifactProposal) {
	const e = actual.evidence;
	requireRead(
		e.kind === expected.kind &&
			same(e.sourceTuple, expected.sourceTuple) &&
			same(e.key, expected.key) &&
			same(e.payload, expected.payload) &&
			same(e.ref, expected.ref),
	);
}

/** Reconstructs every route native and structural step without a current gateway or selector. */
export function hydrateLocalStoryFlowRouteArtifacts(options: {
	archive: BoundLocalStoryFlowSourceArchive;
	context: BoundLocalStoryFlowAcceptedContext;
	identity: BoundLocalStoryFlowRuntimeIdentity;
	history: BoundLocalStoryFlowRuntimeHistory;
	snapshot: LocalStoryFlowRouteHydrationSnapshot;
}): AcceptedLocalStoryFlowRouteStep[] {
	return checked(() => {
		const o = fields(options, [
				"archive",
				"context",
				"identity",
				"history",
				"snapshot",
			]),
			archive = o.archive as BoundLocalStoryFlowSourceArchive,
			context = o.context as BoundLocalStoryFlowAcceptedContext,
			identity = o.identity as BoundLocalStoryFlowRuntimeIdentity,
			history = localStoryFlowRuntimeHistoryEvidence(
				o.history as BoundLocalStoryFlowRuntimeHistory,
			);
		const facts = localStoryFlowRuntimeIdentityEvidence(identity),
			sourceTuple = facts.sourceTuple,
			connectionHash = history.start.payload.nativeConnectionHash;
		requireRead(typeof connectionHash === "string");
		const originalStart = localStoryFlowRuntimeStartRecord(
			identity,
			connectionHash,
		);
		requireRead(
			same(history.start.key, originalStart.key) &&
				same(history.start.payload, originalStart.payload),
		);
		if (history.stopCode !== null) {
			requireRead(isLocalStoryFlowRuntimeFailureCode(history.stopCode));
			throw new LocalStoryFlowRouteReadError(history.stopCode);
		}
		if (history.unconfirmedSlot !== null)
			throw new LocalStoryFlowRouteReadError(
				"LOCAL_STORY_FLOW_NATIVE_UNCONFIRMED",
			);
		const a = localStoryFlowSourceArchiveEvidence(archive);
		requireRead(
			a.payload.taskId === facts.taskId &&
				same(a.payload.sourceTuple, sourceTuple) &&
				same(a.payload.taskPin, facts.taskPin) &&
				hash(a.payload.taskPin) === facts.taskPinHash &&
				a.payload.taskPayloadHash === facts.taskPayloadHash,
		);
		const c = localStoryFlowAcceptedContextEvidence(context),
			prefixes = history.prefixes;
		requireRead(
			prefixes.length >= 1 &&
				prefixes.length <= LOCAL_STORY_FLOW_ROUTE_READ_POLICY.maxRouteSteps,
		);
		const snapshot = fields(o.snapshot, [
				"steps",
				"observations",
				"nativeCaches",
				"origins",
			]),
			storedSteps = records(snapshot.steps, sourceTuple, "STEP"),
			observations = records(
				snapshot.observations,
				sourceTuple,
				"NATIVE_OBSERVATION",
			),
			caches = records(snapshot.nativeCaches, sourceTuple, "NATIVE_CACHE");
		requireRead(
			storedSteps.size === prefixes.length &&
				observations.size === prefixes.length &&
				caches.size === prefixes.length,
		);
		const origins = new Map<
			string,
			LocalStoryFlowRouteHydrationSnapshot["origins"][number]
		>();
		for (const input of list(snapshot.origins)) {
			const bundle = fields(input, ["identity", "start", "attempt", "outcome"]),
				originIdentity = bundle.identity as BoundLocalStoryFlowRuntimeIdentity,
				origin = localStoryFlowRuntimeIdentityEvidence(originIdentity),
				attempt = localStoryFlowSealedRecordEvidence(
					bundle.attempt as BoundLocalStoryFlowSealedRecord,
				),
				slot = attempt.payload.slot;
			requireRead(
				typeof slot === "number" &&
					Number.isSafeInteger(slot) &&
					slot >= 1 &&
					slot <= 127,
			);
			const key = `${origin.taskId}:${slot}`;
			requireRead(!origins.has(key));
			origins.set(key, {
				identity: originIdentity,
				start: bundle.start as BoundLocalStoryFlowSealedRecord,
				attempt: bundle.attempt as BoundLocalStoryFlowSealedRecord,
				outcome: bundle.outcome as BoundLocalStoryFlowSealedRecord,
			});
		}
		requireRead(origins.size === prefixes.length);
		const accepted: AcceptedLocalStoryFlowRouteStep[] = [];
		for (const [index, prefix] of prefixes.entries()) {
			const next = nextLocalStoryFlowRouteWork({
				archive,
				context,
				steps: accepted,
			});
			requireRead(next.status === "NEXT");
			const expectation = localStoryFlowRouteWorkExpectation(next.work),
				expected = localStoryFlowNativeExpectationEvidence(expectation),
				cacheKey: LocalStoryFlowRecordKey = {
					version: "local-story-flow-record-key-v1",
					purpose: "NATIVE_CACHE",
					keyBody: { nativeKeyHash: expected.nativeKeyHash },
				},
				cacheId = localStoryFlowRecordIdentity({
					sourceTuple,
					kind: "LOCAL_FLOW_ROUTE_V1",
					key: cacheKey,
				}).receiptId,
				cache = caches.get(cacheId);
			requireRead(cache && same(cache.evidence.key, cacheKey));
			caches.delete(cacheId);
			const observation = take(
					observations,
					prefix.payload.observationRef as LocalStoryFlowRecordRef,
				),
				observed = observation.evidence
					.payload as unknown as LocalStoryFlowNativeObservation,
				originKey = `${observed.origin.originTaskId}:${observed.origin.slot}`,
				origin = origins.get(originKey);
			requireRead(origin);
			origins.delete(originKey);
			const acceptedOrigin = admitLocalStoryFlowAcceptedOrigin({
					...origin,
					expectation,
					observation: observation.handle,
				}),
				native = admitFlowNativeObservation(expectation, {
					resolvedOrigin: localStoryFlowAcceptedOriginEvidence(acceptedOrigin),
					observation: observed,
				}),
				step = acceptLocalStoryFlowRouteWork({ work: next.work, native }),
				publication = localStoryFlowAcceptedRoutePublication(step),
				storedStep = take(
					storedSteps,
					prefix.payload.stepRef as LocalStoryFlowRecordRef,
				);
			matching(observation, publication.observation);
			matching(storedStep, publication.step);
			matching(cache, publication.cache);
			const outcome = localStoryFlowSealedRecordEvidence(
				origin.outcome,
			).payload;
			requireRead(
				same(outcome.acceptedArtifactRef, publication.step.ref) &&
					outcome.acceptedArtifactHash === publication.step.payload.stepHash,
			);
			const p = prefix.payload;
			requireRead(
				p.ordinal === index + 1 &&
					p.taskId === facts.taskId &&
					same(p.startRef, history.start.ref) &&
					same(p.sourceArchiveRef, c.sourceArchive.ref) &&
					same(p.treeRef, c.tree.ref) &&
					same(
						p.previousPrefixRef,
						index === 0 ? null : prefixes[index - 1]?.ref,
					) &&
					same(p.stepRef, publication.step.ref) &&
					p.stepHash === publication.step.payload.stepHash &&
					p.expectationHash ===
						publication.step.payload.stepEvidence.expectation.expectationHash &&
					same(p.observationRef, publication.observation.ref) &&
					p.nativeRootProof ===
						localStoryFlowNativeRootEvidence(publication.nativeRoot)
							.nativeRootProof &&
					p.progressHash === publication.progressHash,
			);
			accepted.push(step);
		}
		requireRead(
			storedSteps.size === 0 &&
				observations.size === 0 &&
				caches.size === 0 &&
				origins.size === 0,
		);
		requireRead(
			nextLocalStoryFlowRouteWork({ archive, context, steps: accepted })
				.status === "COMPLETE",
		);
		return [...accepted];
	});
}
