import { createHash } from "node:crypto";
import { z } from "zod";
import {
	type LocalStoryFlowTaskPolicyParts,
	localStoryFlowGenerationPolicyFingerprint,
	localStoryFlowTaskPolicyPartsSchema,
	resolveLocalStoryWorkflow,
} from "../content-production/local-story-workflow";
import {
	type MediaTaskEnvelope,
	mediaTaskEnvelopeSchema,
} from "../content-production/schema";
import { canonicalEditingJson } from "./automatic-binding";
import {
	type BoundLocalStoryFlowNativeExpectation,
	LOCAL_STORY_FLOW_NATIVE_PROMPT_POLICY,
	type LocalStoryFlowNativeOriginContract,
	localStoryFlowNativeExpectationEvidence,
	localStoryFlowNativeRequestIds,
	nativeRequestForOrigin,
} from "./local-story-flow-native";
import {
	type BoundLocalStoryFlowSealedRecord,
	LOCAL_STORY_FLOW_SEAL_POLICY,
	type LocalStoryFlowRecordKey,
	type LocalStoryFlowRecordRef,
	type LocalStoryFlowSourceTuple,
	localStoryFlowRecordIdentity,
	localStoryFlowSealedRecordEvidence,
} from "./local-story-flow-seals";
import { validateLocalStoryFlowWorkflowIdentityForModelPin } from "./local-story-flow-stages";
import { hashEditingEvidence as hash } from "./verify-automatic-binding";
export const LOCAL_STORY_FLOW_RUNTIME_POLICY = Object.freeze({
	version: "local-story-flow-runtime-policy-v1",
	deadlineMs: 90 * 60_000,
	contextReservations: 63,
	routeReservations: 64,
	totalReservations: 127,
	acceptedRouteSteps: 64,
	knownRuntimeKeys: 382,
	reservationRule: "commit-before-native-no-refund-v1",
	recoveryRule: "cleanup-only-no-success-adoption-v1",
	clockRule: "original-task-start-db-clock-v1",
});
const KIND = "LOCAL_FLOW_PLAN_V1" as const;
const failureCodes = new Set([
	"LOCAL_STORY_FLOW_NATIVE_UNCONFIRMED",
	"LOCAL_STORY_FLOW_NO_PROGRESS",
	"LOCAL_STORY_FLOW_BUDGET_EXHAUSTED",
	"LOCAL_STORY_FLOW_DEADLINE_EXCEEDED",
	"LOCAL_STORY_ARTIFACT_UNVERIFIED",
	"LOCAL_SEMANTIC_CANCEL_UNCONFIRMED",
	"LOCAL_SEMANTIC_JOB_FAILED",
	"CANCELED",
	"SOURCE_CHANGED",
]);

export class LocalStoryFlowRuntimeHistoryError extends Error {
	readonly code = "LOCAL_STORY_ARTIFACT_UNVERIFIED";
	constructor() {
		super("LOCAL_STORY_ARTIFACT_UNVERIFIED");
		this.name = "LocalStoryFlowRuntimeHistoryError";
	}
}
function checked<T>(work: () => T): T {
	try {
		return work();
	} catch {
		throw new LocalStoryFlowRuntimeHistoryError();
	}
}
type Ref = LocalStoryFlowRecordRef;
type Payload = Record<string, unknown>;
export type LocalStoryFlowRuntimeFailureCode =
	| "LOCAL_STORY_FLOW_NATIVE_UNCONFIRMED"
	| "LOCAL_STORY_FLOW_NO_PROGRESS"
	| "LOCAL_STORY_FLOW_BUDGET_EXHAUSTED"
	| "LOCAL_STORY_FLOW_DEADLINE_EXCEEDED"
	| "LOCAL_STORY_ARTIFACT_UNVERIFIED"
	| "LOCAL_SEMANTIC_CANCEL_UNCONFIRMED"
	| "LOCAL_SEMANTIC_JOB_FAILED"
	| "CANCELED"
	| "SOURCE_CHANGED";
export function isLocalStoryFlowRuntimeFailureCode(
	value: unknown,
): value is LocalStoryFlowRuntimeFailureCode {
	return typeof value === "string" && failureCodes.has(value);
}
export type LocalStoryFlowRuntimeIdentityInput = {
	taskId: string;
	organizationId: string;
	taskParameters: MediaTaskEnvelope;
	startedAtMs: number;
	sourceTuple: LocalStoryFlowSourceTuple;
	policies: LocalStoryFlowTaskPolicyParts;
};
export type BoundLocalStoryFlowRuntimeIdentity = Readonly<object>;
export type LocalStoryFlowRuntimeIdentityEvidence = {
	taskId: string;
	organizationId: string;
	sourceTuple: LocalStoryFlowSourceTuple;
	taskPin: {
		version: "local-story-flow-task-pin-v1";
		parameters: Extract<
			MediaTaskEnvelope["input"],
			{ kind: "GENERATE" }
		>["parameters"];
		identity: MediaTaskEnvelope["identity"];
		policies: LocalStoryFlowTaskPolicyParts;
	};
	taskPinHash: string;
	taskPayloadHash: string;
	startedAtMs: number;
	deadlineAtMs: number;
};
const identities = new WeakMap<
	BoundLocalStoryFlowRuntimeIdentity,
	LocalStoryFlowRuntimeIdentityEvidence
>();
function identity(handle: BoundLocalStoryFlowRuntimeIdentity) {
	const value = identities.get(handle);
	requireRuntime(value);
	return value;
}
function record(input: unknown, fields?: string[]): Payload {
	requireRuntime(
		input !== null && typeof input === "object" && !Array.isArray(input),
	);
	const value = input as Payload;
	if (fields) exact(value, fields);
	return value;
}
const equal = (a: unknown, b: unknown) =>
	canonicalEditingJson(a) === canonicalEditingJson(b);
const bytesHash = (s: string) => createHash("sha256").update(s).digest("hex");
function requireRuntime(value: unknown): asserts value {
	if (!value) throw new LocalStoryFlowRuntimeHistoryError();
}
function exact(value: Payload, fields: string[]) {
	requireRuntime(
		Object.keys(value).length === fields.length &&
			fields.every((field) => Object.hasOwn(value, field)),
	);
}
function selfHash(payload: Payload, field: string) {
	const { [field]: stored, ...body } = payload;
	requireRuntime(stored === hash(body));
}
function digest(value: unknown): value is string {
	return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
function reference(value: unknown, kind: Ref["kind"]): asserts value is Ref {
	requireRuntime(value && typeof value === "object" && !Array.isArray(value));
	const ref = value as Payload;
	exact(ref, ["kind", "receiptId", "cacheHash", "inputKeyHash", "proofHash"]);
	requireRuntime(
		ref.kind === kind &&
			typeof ref.receiptId === "string" &&
			/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
				ref.receiptId,
			) &&
			digest(ref.cacheHash) &&
			digest(ref.inputKeyHash) &&
			digest(ref.proofHash),
	);
}
const bytes = (s: string) => Buffer.byteLength(s, "utf8");
function snapshot(input: unknown): unknown {
	let nodes = 0;
	const active = new WeakSet<object>();
	function copy(value: unknown, depth: number): unknown {
		requireRuntime(
			++nodes <= LOCAL_STORY_FLOW_SEAL_POLICY.maxNodes &&
				depth <= LOCAL_STORY_FLOW_SEAL_POLICY.maxDepth,
		);
		if (value === null || typeof value === "boolean") return value;
		if (typeof value === "number") {
			requireRuntime(Number.isFinite(value));
			return value;
		}
		if (typeof value === "string") {
			requireRuntime(
				bytes(value) <= LOCAL_STORY_FLOW_SEAL_POLICY.maxValueJsonBytes,
			);
			return value;
		}
		requireRuntime(
			typeof value === "object" && value !== null && !active.has(value),
		);
		const array = Array.isArray(value);
		requireRuntime(
			Object.getPrototypeOf(value) ===
				(array ? Array.prototype : Object.prototype),
		);
		requireRuntime(Object.getOwnPropertySymbols(value).length === 0);
		const descriptors = Object.getOwnPropertyDescriptors(value);
		active.add(value);
		try {
			if (array) {
				const length = descriptors.length;
				requireRuntime(
					length &&
						"value" in length &&
						!length.enumerable &&
						Number.isSafeInteger(length.value) &&
						length.value >= 0 &&
						length.value <= LOCAL_STORY_FLOW_SEAL_POLICY.maxNodes,
				);
				requireRuntime(Object.keys(descriptors).length === length.value + 1);
				const output: unknown[] = [];
				for (let i = 0; i < length.value; i++) {
					const d = descriptors[String(i)];
					requireRuntime(
						d?.enumerable && "value" in d && d.value !== undefined,
					);
					output.push(copy(d.value, depth + 1));
				}
				return output;
			}
			const entries: Array<[string, unknown]> = [];
			for (const [name, d] of Object.entries(descriptors)) {
				requireRuntime(d.enumerable && "value" in d && d.value !== undefined);
				entries.push([name, copy(d.value, depth + 1)]);
			}
			return Object.fromEntries(entries);
		} finally {
			active.delete(value);
		}
	}
	return copy(input, 0);
}

export function prepareLocalStoryFlowRuntimeIdentity(
	input: unknown,
): BoundLocalStoryFlowRuntimeIdentity {
	return checked(() => {
		const value = record(snapshot(input), [
			"taskId",
			"organizationId",
			"taskParameters",
			"startedAtMs",
			"sourceTuple",
			"policies",
		]);
		const uuid = z.uuid().regex(/^[a-f0-9-]+$/);
		const taskId = uuid.parse(value.taskId),
			organizationId = uuid.parse(value.organizationId);
		const envelope = mediaTaskEnvelopeSchema.parse(value.taskParameters);
		requireRuntime(equal(envelope, value.taskParameters));
		const policies = localStoryFlowTaskPolicyPartsSchema.parse(value.policies);
		requireRuntime(equal(policies, value.policies));
		const sourceTuple = value.sourceTuple as LocalStoryFlowSourceTuple;
		localStoryFlowRecordIdentity({
			sourceTuple,
			kind: KIND,
			key: {
				version: "local-story-flow-record-key-v1",
				purpose: "START",
				keyBody: { taskId },
			},
		});
		requireRuntime(envelope.input.kind === "GENERATE");
		const i = envelope.identity,
			p = envelope.input;
		requireRuntime(
			resolveLocalStoryWorkflow(p.parameters) === "HIERARCHICAL_FLOW_V1",
		);
		requireRuntime(
			i.organizationId === organizationId &&
				sourceTuple.organizationId === organizationId &&
				p.mediaVersionId === sourceTuple.mediaVersionId &&
				p.analysisRevisionId === sourceTuple.analysisRevisionId &&
				i.mediaSha256 === sourceTuple.mediaSha256 &&
				i.timeMapHash === sourceTuple.timeMapHash &&
				i.analysisRawHash === sourceTuple.analysisRawHash &&
				i.analysisDocumentHash === sourceTuple.analysisDocumentHash &&
				(i.bindingHash === undefined ||
					i.bindingHash === sourceTuple.bindingHash) &&
				sourceTuple.preparedShotClockHash ===
					(i.preparedShotClock ? hash(i.preparedShotClock) : null) &&
				(!i.preparedShotClock ||
					i.preparedShotClock.normalizationReceiptHash ===
						sourceTuple.normalizationReceiptHash),
		);
		requireRuntime(
			i.localStoryModel &&
				i.localStoryWorkflow &&
				i.generationPolicyFingerprint ===
					localStoryFlowGenerationPolicyFingerprint(policies),
		);
		validateLocalStoryFlowWorkflowIdentityForModelPin(
			i.localStoryWorkflow,
			{
				profile: i.localStoryModel.profile,
				configId: i.localStoryModel.configId,
			},
			"FLOW",
		);
		const startedAtMs = value.startedAtMs;
		requireRuntime(
			typeof startedAtMs === "number" && Number.isSafeInteger(startedAtMs),
		);
		const deadlineAtMs =
			startedAtMs + LOCAL_STORY_FLOW_RUNTIME_POLICY.deadlineMs;
		requireRuntime(Number.isSafeInteger(deadlineAtMs));
		const taskPin = {
			version: "local-story-flow-task-pin-v1" as const,
			parameters: p.parameters,
			identity: i,
			policies,
		};
		const state = {
			taskId,
			organizationId,
			sourceTuple,
			taskPin,
			taskPinHash: hash(taskPin),
			taskPayloadHash: hash(value.taskParameters),
			startedAtMs,
			deadlineAtMs,
		};
		const handle = Object.freeze({});
		identities.set(handle, state);
		return handle;
	});
}
export function localStoryFlowRuntimeIdentityEvidence(
	handle: BoundLocalStoryFlowRuntimeIdentity,
): LocalStoryFlowRuntimeIdentityEvidence {
	return checked(() => structuredClone(identity(handle)));
}
export type LocalStoryFlowRuntimeKeyLocator =
	| { purpose: "START" }
	| { purpose: "ATTEMPT" | "OUTCOME"; slot: number }
	| { purpose: "CONTEXT_BINDING"; nodeId: string }
	| { purpose: "ROUTE_PREFIX"; ordinal: number };
const locatorSchema = z.discriminatedUnion("purpose", [
	z.strictObject({ purpose: z.literal("START") }),
	z.strictObject({
		purpose: z.enum(["ATTEMPT", "OUTCOME"]),
		slot: z.number().int().min(1).max(127),
	}),
	z.strictObject({
		purpose: z.literal("CONTEXT_BINDING"),
		nodeId: z.string().regex(/^n(?:[0-9]|[1-5][0-9]|6[0-2])$/),
	}),
	z.strictObject({
		purpose: z.literal("ROUTE_PREFIX"),
		ordinal: z.number().int().min(1).max(64),
	}),
]);
export function localStoryFlowRuntimeKey(
	handle: BoundLocalStoryFlowRuntimeIdentity,
	input: LocalStoryFlowRuntimeKeyLocator,
): LocalStoryFlowRecordKey {
	return checked(() => {
		const { taskId } = identity(handle),
			locator = locatorSchema.parse(snapshot(input));
		return {
			version: "local-story-flow-record-key-v1",
			purpose: locator.purpose,
			keyBody:
				locator.purpose === "START"
					? { taskId }
					: locator.purpose === "CONTEXT_BINDING"
						? { taskId, nodeId: locator.nodeId }
						: locator.purpose === "ROUTE_PREFIX"
							? { taskId, ordinal: locator.ordinal }
							: { taskId, slot: locator.slot },
		};
	});
}
const catalogs = new WeakMap<
	BoundLocalStoryFlowRuntimeIdentity,
	Map<string, LocalStoryFlowRecordKey>
>();
/** The old worker constructed this fixed catalog once; keep that cost scoped to the owned identity. */
function runtimeCatalog(handle: BoundLocalStoryFlowRuntimeIdentity) {
	const state = identity(handle),
		previous = catalogs.get(handle);
	if (previous) return previous;
	const keys: LocalStoryFlowRecordKey[] = [
		localStoryFlowRuntimeKey(handle, { purpose: "START" }),
		...Array.from({ length: 127 }, (_, i) =>
			localStoryFlowRuntimeKey(handle, { purpose: "ATTEMPT", slot: i + 1 }),
		),
		...Array.from({ length: 127 }, (_, i) =>
			localStoryFlowRuntimeKey(handle, { purpose: "OUTCOME", slot: i + 1 }),
		),
		...Array.from({ length: 64 }, (_, i) =>
			localStoryFlowRuntimeKey(handle, {
				purpose: "ROUTE_PREFIX",
				ordinal: i + 1,
			}),
		),
		...Array.from({ length: 63 }, (_, i) =>
			localStoryFlowRuntimeKey(handle, {
				purpose: "CONTEXT_BINDING",
				nodeId: `n${i}`,
			}),
		),
	];
	const catalog = new Map<string, LocalStoryFlowRecordKey>();
	for (const key of keys) {
		const id = localStoryFlowRecordIdentity({
			sourceTuple: state.sourceTuple,
			kind: KIND,
			key,
		}).receiptId;
		catalog.set(id, key);
	}
	catalogs.set(handle, catalog);
	return catalog;
}
export function localStoryFlowRuntimeKeys(
	handle: BoundLocalStoryFlowRuntimeIdentity,
): readonly LocalStoryFlowRecordKey[] {
	return checked(() => structuredClone([...runtimeCatalog(handle).values()]));
}
export function localStoryFlowRuntimeStartRecord(
	handle: BoundLocalStoryFlowRuntimeIdentity,
	nativeConnectionHash: string,
): {
	kind: "LOCAL_FLOW_PLAN_V1";
	key: LocalStoryFlowRecordKey;
	payload: Payload;
} {
	return checked(() => {
		requireRuntime(digest(nativeConnectionHash));
		const {
			taskId,
			organizationId,
			sourceTuple,
			taskPin,
			taskPinHash,
			taskPayloadHash,
			startedAtMs,
			deadlineAtMs,
		} = identity(handle);
		const body = {
			version: "local-story-flow-runtime-start-v1",
			purpose: "START",
			taskId,
			organizationId,
			sourceTuple,
			taskPin,
			taskPinHash,
			taskPayloadHash,
			startedAtMs,
			deadlineAtMs,
			caps: {
				contextReservations: 63,
				routeReservations: 64,
				totalReservations: 127,
				acceptedRouteSteps: 64,
			},
			budgetCategory: "HIERARCHY_CONTEXT_ROUTE_ONLY",
			nativeConnectionHash,
		};
		return {
			kind: KIND,
			key: localStoryFlowRuntimeKey(handle, { purpose: "START" }),
			payload: structuredClone({ ...body, startHash: hash(body) }),
		};
	});
}
export function requireLocalStoryFlowRuntimeNativeKey(
	handle: BoundLocalStoryFlowRuntimeIdentity,
	input: unknown,
): void {
	checked(() => {
		const nativeKey = record(snapshot(input)),
			state = identity(handle),
			policies = state.taskPin.policies,
			envelope = { identity: state.taskPin.identity },
			generationParameters = state.taskPin.parameters;
		requireRuntime(
			nativeKey.stage === "LOCAL_FLOW_CONTEXT_V1" ||
				nativeKey.stage === "LOCAL_FLOW_ROUTE_V1",
		);
		requireRuntime(
			equal(nativeKey.workflowIdentity, envelope.identity.localStoryWorkflow),
		);
		const relevant = {
			workflowPolicyHash: policies.workflowPolicyHash,
			contextPolicyHash: policies.contextPolicyHash,
			promptPolicyHash: policies.promptPolicyHash,
			engineValidationPolicyHash: policies.engineValidationPolicyHash,
			...(nativeKey.stage === "LOCAL_FLOW_ROUTE_V1"
				? {
						closurePolicyHash: policies.closurePolicyHash,
						routePolicyHash: policies.routePolicyHash,
					}
				: {}),
		};
		requireRuntime(equal(nativeKey.relevantPolicyHashes, relevant));
		if (nativeKey.stage === "LOCAL_FLOW_ROUTE_V1") {
			const binding = nativeKey.binding;
			requireRuntime(
				binding && typeof binding === "object" && !Array.isArray(binding),
			);
			requireRuntime(
				(binding as Payload).targetFrames ===
					generationParameters.targetDurationFrames,
			);
		}
	});
}
export function localStoryFlowRuntimeSignature(
	handle: BoundLocalStoryFlowRuntimeIdentity,
	native: unknown,
	body: unknown,
): string {
	return checked(() => {
		const state = identity(handle),
			nativeKey = record(snapshot(native)),
			request = record(snapshot(body)),
			envelope = { identity: state.taskPin.identity };
		const p = LOCAL_STORY_FLOW_NATIVE_PROMPT_POLICY;
		const instruction =
			nativeKey.stage === "LOCAL_FLOW_CONTEXT_V1"
				? p.contextInstruction
				: p.routeInstruction;
		const prefix = instruction + p.controlMarker,
			prompt = request.prompt;
		requireRuntime(typeof prompt === "string" && prompt.startsWith(prefix));
		const split = prompt.indexOf(p.dataMarker, prefix.length);
		requireRuntime(split >= prefix.length);
		const controlText = prompt.slice(prefix.length, split),
			dataText = prompt.slice(split + p.dataMarker.length);
		const control: unknown = JSON.parse(controlText),
			data: unknown = JSON.parse(dataText);
		requireRuntime(
			canonicalEditingJson(control) === controlText &&
				canonicalEditingJson(data) === dataText,
		);
		return hash({
			stage: nativeKey.stage,
			profile: envelope.identity.localStoryModel?.profile,
			modelIdentityHash: hash(envelope.identity.localStoryModel),
			promptVersion: nativeKey.promptVersion,
			schemaHash: nativeKey.schemaHash,
			promptHash: nativeKey.promptHash,
			dataHash: hash(data),
			controlHash: hash(control),
		});
	});
}

export type LocalStoryFlowRuntimePin = {
	organizationId: string;
	taskId: string;
	receiptId: string;
};
export type LocalStoryFlowRuntimeRecord = {
	key: LocalStoryFlowRecordKey;
	ref: LocalStoryFlowRecordRef;
	payload: Payload;
};
export type BoundLocalStoryFlowRuntimeHistory = Readonly<object>;
export type LocalStoryFlowRuntimeHistoryEvidence = {
	start: LocalStoryFlowRuntimeRecord;
	attempts: LocalStoryFlowRuntimeRecord[];
	outcomes: LocalStoryFlowRuntimeRecord[];
	prefixes: LocalStoryFlowRuntimeRecord[];
	bindings: LocalStoryFlowRuntimeRecord[];
	cells: Array<{
		key: LocalStoryFlowRecordKey;
		record: LocalStoryFlowRuntimeRecord | null;
	}>;
	counts: { context: number; route: number; total: number };
	tailRef: Ref | null;
	signatures: string[];
	stopCode: LocalStoryFlowRuntimeFailureCode | null;
	unconfirmedSlot: number | null;
};
const histories = new WeakMap<
	BoundLocalStoryFlowRuntimeHistory,
	LocalStoryFlowRuntimeHistoryEvidence
>();
/** Top-level ownership-bearing inputs are inspected without cloning the opaque children. */
function ownFields(input: unknown, fields: string[]): Payload {
	requireRuntime(
		input !== null &&
			typeof input === "object" &&
			Object.getPrototypeOf(input) === Object.prototype &&
			Object.getOwnPropertySymbols(input).length === 0,
	);
	const descriptors = Object.getOwnPropertyDescriptors(input);
	requireRuntime(Object.keys(descriptors).length === fields.length);
	return Object.fromEntries(
		fields.map((field) => {
			const d = descriptors[field];
			requireRuntime(d?.enumerable && "value" in d);
			return [field, d.value];
		}),
	);
}
function ownedArray(input: unknown, max: number): unknown[] {
	requireRuntime(
		Array.isArray(input) &&
			Object.getPrototypeOf(input) === Array.prototype &&
			Object.getOwnPropertySymbols(input).length === 0,
	);
	const d = Object.getOwnPropertyDescriptors(input as object),
		length = d.length;
	requireRuntime(
		length &&
			"value" in length &&
			Number.isSafeInteger(length.value) &&
			length.value >= 0 &&
			length.value <= max &&
			Object.keys(d).length === length.value + 1,
	);
	return Array.from({ length: length.value }, (_, i) => {
		const item = d[String(i)];
		requireRuntime(item?.enumerable && "value" in item);
		return item.value;
	});
}
function runtimeRecord(
	handle: BoundLocalStoryFlowRuntimeIdentity,
	input: unknown,
	expectedKey?: LocalStoryFlowRecordKey,
): LocalStoryFlowRuntimeRecord {
	const state = identity(handle),
		e = localStoryFlowSealedRecordEvidence(
			input as BoundLocalStoryFlowSealedRecord,
		);
	requireRuntime(
		equal(e.sourceTuple, state.sourceTuple) &&
			e.kind === KIND &&
			(!expectedKey || equal(e.key, expectedKey)),
	);
	return { key: e.key, ref: e.ref, payload: e.payload };
}
function validateStart(
	handle: BoundLocalStoryFlowRuntimeIdentity,
	start: LocalStoryFlowRuntimeRecord,
) {
	requireRuntime(
		equal(start.key, localStoryFlowRuntimeKey(handle, { purpose: "START" })),
	);
	requireRuntime(digest(start.payload.nativeConnectionHash));
	const expectedStart = localStoryFlowRuntimeStartRecord(
		handle,
		start.payload.nativeConnectionHash,
	).payload;
	requireRuntime(equal(start.payload, expectedStart));
	selfHash(start.payload, "startHash");
}
function validateAttempt(
	handle: BoundLocalStoryFlowRuntimeIdentity,
	start: LocalStoryFlowRuntimeRecord,
	r: LocalStoryFlowRuntimeRecord,
	slot: number,
) {
	const state = identity(handle),
		task = { id: state.taskId, organizationId: state.organizationId },
		envelope = { identity: state.taskPin.identity },
		startedAtMs = state.startedAtMs,
		deadlineAtMs = state.deadlineAtMs,
		a = r.payload;
	exact(a, [
		"version",
		"purpose",
		"taskId",
		"startRef",
		"slot",
		"category",
		"nativeKeyHash",
		"requestKey",
		"jobId",
		"requestHash",
		"coreInputHash",
		"promptHash",
		"expectedTailPrefixRef",
		"reservedAtMs",
		"nativeKey",
		"requestBody",
		"attemptHash",
	]);
	requireRuntime(
		a.slot === slot &&
			r.key.keyBody.slot === slot &&
			a.taskId === task.id &&
			equal(a.startRef, start.ref),
	);
	requireRuntime(
		Number.isSafeInteger(a.reservedAtMs) &&
			Number(a.reservedAtMs) >= Number(startedAtMs) &&
			Number(a.reservedAtMs) < deadlineAtMs,
	);
	selfHash(a, "attemptHash");
	const n = a.nativeKey as Payload,
		b = a.requestBody as Payload;
	requireRuntime(
		n &&
			b &&
			hash(n) === a.nativeKeyHash &&
			hash(b) === a.requestHash &&
			b.organizationId === task.organizationId &&
			b.requestKey === a.requestKey &&
			b.inputHash === a.coreInputHash &&
			typeof b.prompt === "string" &&
			bytesHash(b.prompt) === a.promptHash &&
			n.coreInputHash === a.coreInputHash &&
			n.promptHash === a.promptHash &&
			n.stage === b.stage &&
			equal(n.workflowIdentity, envelope.identity.localStoryWorkflow),
	);
	requireLocalStoryFlowRuntimeNativeKey(handle, n);
	const ids = localStoryFlowNativeRequestIds({
		organizationId: task.organizationId,
		originTaskId: task.id,
		nativeKeyHash: String(a.nativeKeyHash),
	});
	requireRuntime(a.requestKey === ids.requestKey && a.jobId === ids.jobId);

	return {
		nativeKey: n,
		requestBody: b,
		signature: localStoryFlowRuntimeSignature(handle, n, b),
	};
}

function validateOutcome(
	handle: BoundLocalStoryFlowRuntimeIdentity,
	start: LocalStoryFlowRuntimeRecord,
	r: LocalStoryFlowRuntimeRecord,
	outcome: LocalStoryFlowRuntimeRecord,
	isLast: boolean,
) {
	const state = identity(handle),
		task = { id: state.taskId },
		deadlineAtMs = state.deadlineAtMs,
		a = r.payload,
		n = a.nativeKey as Payload,
		slot = Number(a.slot);
	const o = outcome.payload;
	requireRuntime(
		o.taskId === task.id &&
			o.slot === slot &&
			equal(o.startRef, start.ref) &&
			equal(o.attemptRef, r.ref),
	);
	requireRuntime(o.status === "ACCEPTED" || o.status === "FAILED");
	requireRuntime(
		Number.isSafeInteger(o.completedAtMs) &&
			Number(o.completedAtMs) >= Number(a.reservedAtMs),
	);
	if (o.status === "FAILED") {
		exact(o, [
			"version",
			"purpose",
			"taskId",
			"startRef",
			"attemptRef",
			"slot",
			"completedAtMs",
			"status",
			"failureCode",
			"cleanupStatus",
			"observationRef",
		]);
		requireRuntime(
			isLocalStoryFlowRuntimeFailureCode(o.failureCode) &&
				(o.cleanupStatus === "CONFIRMED" ||
					o.cleanupStatus === "UNCONFIRMED") &&
				isLast,
		);
		if (o.observationRef !== null)
			reference(o.observationRef, n.stage as Ref["kind"]);
	} else {
		exact(o, [
			"version",
			"purpose",
			"taskId",
			"startRef",
			"attemptRef",
			"slot",
			"completedAtMs",
			"status",
			"observationRef",
			"acceptedArtifactRef",
			"acceptedArtifactHash",
			...(a.category === "ROUTE" ? ["acceptedOrdinal"] : []),
		]);
		reference(o.observationRef, n.stage as Ref["kind"]);
		reference(o.acceptedArtifactRef, n.stage as Ref["kind"]);
		requireRuntime(digest(o.acceptedArtifactHash));
		requireRuntime(Number(o.completedAtMs) < deadlineAtMs);
	}
}

export function readLocalStoryFlowRuntimeHistory(input: {
	identity: BoundLocalStoryFlowRuntimeIdentity;
	records: readonly BoundLocalStoryFlowSealedRecord[];
	pins: readonly LocalStoryFlowRuntimePin[];
}): BoundLocalStoryFlowRuntimeHistory {
	return checked(() => {
		const fields = ownFields(input, ["identity", "records", "pins"]),
			handle = fields.identity as BoundLocalStoryFlowRuntimeIdentity,
			state = identity(handle),
			task = { id: state.taskId },
			keysById = runtimeCatalog(handle);
		const byId = new Map<string, LocalStoryFlowRuntimeRecord>();
		for (const row of ownedArray(fields.records, 382)) {
			const r = runtimeRecord(handle, row),
				k = keysById.get(r.ref.receiptId);
			requireRuntime(k && equal(k, r.key) && !byId.has(r.ref.receiptId));
			byId.set(r.ref.receiptId, r);
		}
		const records = [...keysById.keys()].flatMap((id) => {
			const row = byId.get(id);
			return row ? [row] : [];
		});
		const start = records.find((r) => r.key.purpose === "START");
		requireRuntime(start);
		validateStart(handle, start);
		const attempts = records
			.filter((r) => r.key.purpose === "ATTEMPT")
			.sort((a, b) => Number(a.payload.slot) - Number(b.payload.slot));
		const outcomes = new Map<number, LocalStoryFlowRuntimeRecord>();
		for (const r of records.filter((r) => r.key.purpose === "OUTCOME")) {
			const slot = r.key.keyBody.slot as number;
			requireRuntime(!outcomes.has(slot));
			outcomes.set(slot, r);
		}
		let contextCount = 0,
			routeCount = 0;
		const signatures = new Set<string>();
		for (const [index, r] of attempts.entries()) {
			const a = r.payload,
				slot = index + 1,
				validated = validateAttempt(handle, start, r, slot),
				n = validated.nativeKey;
			if (a.category === "CONTEXT") {
				requireRuntime(
					n.stage === "LOCAL_FLOW_CONTEXT_V1" &&
						a.expectedTailPrefixRef === null &&
						routeCount === 0,
				);
				contextCount++;
			} else {
				requireRuntime(
					a.category === "ROUTE" && n.stage === "LOCAL_FLOW_ROUTE_V1",
				);
				routeCount++;
			}
			const signature = validated.signature;
			requireRuntime(!signatures.has(signature));
			signatures.add(signature);
			const outcome = outcomes.get(slot);
			if (outcome)
				validateOutcome(
					handle,
					start,
					r,
					outcome,
					index === attempts.length - 1,
				);
			else requireRuntime(index === attempts.length - 1);
		}
		requireRuntime(
			contextCount <= 63 &&
				routeCount <= 64 &&
				attempts.length <= 127 &&
				[...outcomes.keys()].every(
					(slot) => slot >= 1 && slot <= attempts.length,
				),
		);
		const prefixes = records
			.filter((r) => r.key.purpose === "ROUTE_PREFIX")
			.sort((a, b) => Number(a.payload.ordinal) - Number(b.payload.ordinal));
		for (const [index, r] of prefixes.entries()) {
			exact(r.payload, [
				"version",
				"purpose",
				"taskId",
				"startRef",
				"sourceArchiveRef",
				"treeRef",
				"ordinal",
				"previousPrefixRef",
				"stepRef",
				"stepHash",
				"expectationHash",
				"observationRef",
				"nativeRootProof",
				"progressHash",
				"prefixHash",
			]);
			requireRuntime(
				r.payload.ordinal === index + 1 &&
					r.key.keyBody.ordinal === index + 1 &&
					r.payload.taskId === task.id &&
					equal(r.payload.startRef, start.ref) &&
					equal(
						r.payload.previousPrefixRef,
						index === 0 ? null : prefixes[index - 1]?.ref,
					),
			);
			reference(r.payload.sourceArchiveRef, "LOCAL_FLOW_MANIFEST_V1");
			reference(r.payload.treeRef, "LOCAL_FLOW_CONTEXT_V1");
			reference(r.payload.stepRef, "LOCAL_FLOW_ROUTE_V1");
			reference(r.payload.observationRef, "LOCAL_FLOW_ROUTE_V1");
			requireRuntime(
				digest(r.payload.stepHash) &&
					digest(r.payload.expectationHash) &&
					digest(r.payload.nativeRootProof) &&
					digest(r.payload.progressHash),
			);
			if (index > 0)
				requireRuntime(
					equal(
						r.payload.sourceArchiveRef,
						prefixes[0]?.payload.sourceArchiveRef,
					) &&
						equal(r.payload.treeRef, prefixes[0]?.payload.treeRef) &&
						r.payload.nativeRootProof === prefixes[0]?.payload.nativeRootProof,
				);
			selfHash(r.payload, "prefixHash");
		}
		const bindings = records.filter((r) => r.key.purpose === "CONTEXT_BINDING");
		for (const r of bindings) {
			exact(r.payload, [
				"version",
				"purpose",
				"startRef",
				"nodeRef",
				"nodeHash",
				"observationRef",
			]);
			requireRuntime(equal(r.payload.startRef, start.ref));
			reference(r.payload.nodeRef, "LOCAL_FLOW_CONTEXT_V1");
			reference(r.payload.observationRef, "LOCAL_FLOW_CONTEXT_V1");
			requireRuntime(digest(r.payload.nodeHash));
		}
		// Only this task's ACCEPTED attempts require a matching atomic publication.
		// Additional bindings/prefixes may come from admitted cache hits with reservation zero.
		for (const attempt of attempts) {
			const outcome = outcomes.get(Number(attempt.payload.slot));
			if (outcome?.payload.status !== "ACCEPTED") continue;
			const o = outcome.payload,
				n = attempt.payload.nativeKey as Payload;
			if (attempt.payload.category === "CONTEXT") {
				const binding = bindings.find((r) => r.key.keyBody.nodeId === n.nodeId);
				requireRuntime(
					binding &&
						equal(binding.payload.nodeRef, o.acceptedArtifactRef) &&
						binding.payload.nodeHash === o.acceptedArtifactHash &&
						equal(binding.payload.observationRef, o.observationRef),
				);
			} else {
				requireRuntime(
					Number.isSafeInteger(o.acceptedOrdinal) &&
						Number(o.acceptedOrdinal) >= 1 &&
						Number(o.acceptedOrdinal) <= 64,
				);
				const ordinal = Number(o.acceptedOrdinal),
					prefix = prefixes[ordinal - 1];
				requireRuntime(
					prefix &&
						equal(prefix.payload.stepRef, o.acceptedArtifactRef) &&
						prefix.payload.stepHash === o.acceptedArtifactHash &&
						equal(prefix.payload.observationRef, o.observationRef) &&
						equal(
							prefix.payload.previousPrefixRef,
							attempt.payload.expectedTailPrefixRef,
						) &&
						(n.phase === "ROOT") === (ordinal === 1),
				);
			}
		}

		const pins = ownedArray(fields.pins, 382).map((p) =>
			ownFields(snapshot(p), ["organizationId", "taskId", "receiptId"]),
		);
		requireRuntime(
			pins.length === records.length &&
				new Set(pins.map((p) => p.receiptId)).size === records.length &&
				records.every((r) =>
					pins.some(
						(p) =>
							p.organizationId === state.organizationId &&
							p.taskId === state.taskId &&
							p.receiptId === r.ref.receiptId,
					),
				),
		);
		const failed = outcomes.get(attempts.length)?.payload;
		let stopCode: LocalStoryFlowRuntimeFailureCode | null = null;
		if (failed?.status === "FAILED") {
			requireRuntime(isLocalStoryFlowRuntimeFailureCode(failed.failureCode));
			stopCode =
				failed.cleanupStatus === "UNCONFIRMED"
					? "LOCAL_SEMANTIC_CANCEL_UNCONFIRMED"
					: failed.failureCode;
		}
		const last = attempts.at(-1),
			unconfirmedSlot =
				last && !outcomes.has(Number(last.payload.slot))
					? Number(last.payload.slot)
					: null;
		const evidence: LocalStoryFlowRuntimeHistoryEvidence = {
			start,
			attempts,
			outcomes: [...outcomes.values()].sort(
				(a, b) => Number(a.payload.slot) - Number(b.payload.slot),
			),
			prefixes,
			bindings,
			cells: [...keysById].map(([id, key]) => ({
				key,
				record: byId.get(id) ?? null,
			})),
			counts: {
				context: contextCount,
				route: routeCount,
				total: attempts.length,
			},
			tailRef: prefixes.at(-1)?.ref ?? null,
			signatures: [...signatures],
			stopCode,
			unconfirmedSlot,
		};
		const bound = Object.freeze({});
		histories.set(bound, evidence);
		return bound;
	});
}
export function localStoryFlowRuntimeHistoryEvidence(
	handle: BoundLocalStoryFlowRuntimeHistory,
): LocalStoryFlowRuntimeHistoryEvidence {
	return checked(() => {
		const state = histories.get(handle);
		requireRuntime(state);
		return structuredClone(state);
	});
}
export type BoundLocalStoryFlowAcceptedOrigin = Readonly<object>;
type AcceptedOrigin = Extract<
	LocalStoryFlowNativeOriginContract,
	{ kind: "SEALED_ACCEPTED" }
>;
const acceptedOrigins = new WeakMap<
	BoundLocalStoryFlowAcceptedOrigin,
	AcceptedOrigin
>();
export function admitLocalStoryFlowAcceptedOrigin(input: {
	identity: BoundLocalStoryFlowRuntimeIdentity;
	expectation: BoundLocalStoryFlowNativeExpectation;
	start: BoundLocalStoryFlowSealedRecord;
	attempt: BoundLocalStoryFlowSealedRecord;
	outcome: BoundLocalStoryFlowSealedRecord;
	observation: BoundLocalStoryFlowSealedRecord;
}): BoundLocalStoryFlowAcceptedOrigin {
	return checked(() => {
		const fields = ownFields(input, [
				"identity",
				"expectation",
				"start",
				"attempt",
				"outcome",
				"observation",
			]),
			handle = fields.identity as BoundLocalStoryFlowRuntimeIdentity,
			state = identity(handle),
			expectation = fields.expectation as BoundLocalStoryFlowNativeExpectation,
			expected = localStoryFlowNativeExpectationEvidence(expectation);
		const start = runtimeRecord(
			handle,
			fields.start,
			localStoryFlowRuntimeKey(handle, { purpose: "START" }),
		);
		validateStart(handle, start);
		const attempt = runtimeRecord(handle, fields.attempt),
			slot = attempt.payload.slot;
		requireRuntime(
			typeof slot === "number" &&
				Number.isSafeInteger(slot) &&
				slot >= 1 &&
				slot <= 127,
		);
		requireRuntime(
			equal(
				attempt.key,
				localStoryFlowRuntimeKey(handle, { purpose: "ATTEMPT", slot }),
			),
		);
		const a = attempt.payload,
			validated = validateAttempt(handle, start, attempt, slot);
		requireRuntime(equal(validated.nativeKey, expected.nativeKey));
		const request = nativeRequestForOrigin(expectation, {
			organizationId: state.organizationId,
			originTaskId: state.taskId,
		});
		requireRuntime(
			equal(a.requestBody, request.body) &&
				a.requestHash === request.requestHash &&
				a.jobId === request.jobId,
		);
		if (a.category === "CONTEXT")
			requireRuntime(
				expected.nativeKey.stage === "LOCAL_FLOW_CONTEXT_V1" &&
					a.expectedTailPrefixRef === null,
			);
		else {
			requireRuntime(
				a.category === "ROUTE" &&
					expected.nativeKey.stage === "LOCAL_FLOW_ROUTE_V1",
			);
			if (a.expectedTailPrefixRef !== null)
				reference(a.expectedTailPrefixRef, KIND);
			requireRuntime(
				(expected.nativeKey.phase === "ROOT") ===
					(a.expectedTailPrefixRef === null),
			);
		}
		const outcome = runtimeRecord(
			handle,
			fields.outcome,
			localStoryFlowRuntimeKey(handle, { purpose: "OUTCOME", slot }),
		);
		requireRuntime(outcome.payload.status === "ACCEPTED");
		validateOutcome(handle, start, attempt, outcome, true);
		if (a.category === "ROUTE")
			requireRuntime(
				Number.isSafeInteger(outcome.payload.acceptedOrdinal) &&
					Number(outcome.payload.acceptedOrdinal) >= 1 &&
					Number(outcome.payload.acceptedOrdinal) <= 64 &&
					(expected.nativeKey.phase === "ROOT") ===
						(outcome.payload.acceptedOrdinal === 1),
			);
		const obs = localStoryFlowSealedRecordEvidence(
				fields.observation as BoundLocalStoryFlowSealedRecord,
			),
			o = obs.payload;
		const origin = {
			organizationId: state.organizationId,
			originTaskId: state.taskId,
			startRef: start.ref,
			attemptRef: attempt.ref,
			slot,
		};
		requireRuntime(
			equal(obs.sourceTuple, state.sourceTuple) &&
				obs.kind === expected.nativeKey.stage &&
				equal(obs.key, {
					version: "local-story-flow-record-key-v1",
					purpose: "NATIVE_OBSERVATION",
					keyBody: {
						nativeKeyHash: expected.nativeKeyHash,
						originTaskId: state.taskId,
						slot,
					},
				}) &&
				equal(outcome.payload.observationRef, obs.ref) &&
				equal(o.origin, origin) &&
				equal(o.nativeKey, expected.nativeKey) &&
				equal(o.requestBody, request.body) &&
				o.requestHash === request.requestHash &&
				o.requestKey === request.body.requestKey &&
				o.jobId === request.jobId,
		);
		selfHash(o, "observationHash");
		requireRuntime(digest(o.observationHash));
		const result: AcceptedOrigin = {
			version: "local-story-flow-native-origin-contract-v1",
			kind: "SEALED_ACCEPTED",
			origin,
			sourceBindingHash: expected.nativeKey.sourceBindingHash,
			workflowIdentityHash: hash(expected.nativeKey.workflowIdentity),
			nativeKeyHash: expected.nativeKeyHash,
			coreInputHash: expected.nativeKey.coreInputHash,
			requestHash: request.requestHash,
			accepted: {
				status: "ACCEPTED",
				outcomeRef: outcome.ref,
				observationRef: obs.ref,
				observationHash: o.observationHash,
			},
		};
		const bound = Object.freeze({});
		acceptedOrigins.set(bound, result);
		return bound;
	});
}
export function localStoryFlowAcceptedOriginEvidence(
	handle: BoundLocalStoryFlowAcceptedOrigin,
): AcceptedOrigin {
	return checked(() => {
		const result = acceptedOrigins.get(handle);
		requireRuntime(result);
		return structuredClone(result);
	});
}
