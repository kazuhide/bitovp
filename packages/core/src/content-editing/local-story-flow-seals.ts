import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalEditingJson } from "./automatic-binding";
import { localStoryFlowNodeIdSchema } from "./local-story-flow-contracts";
import { hashEditingEvidence as hash } from "./verify-automatic-binding";

/** Outer encoding only. DB authorization and each purpose's semantic reader remain required. */
export const LOCAL_STORY_FLOW_SEAL_POLICY = Object.freeze({
	version: "local-story-flow-outer-seal-policy-v1",
	keyVersion: "local-story-flow-record-key-v1",
	cacheIdentityVersion: "local-story-cache-identity-v1",
	proofVersion: "local-story-cache-v2",
	maxDepth: 128,
	maxNodes: 4_000_000,
	maxValueJsonBytes: 128 * 1024 * 1024,
	maxKeyBytes: 256 * 1024,
});
export class LocalStoryFlowSealError extends Error {
	readonly code = "LOCAL_STORY_ARTIFACT_UNVERIFIED";
	constructor() {
		super("LOCAL_STORY_ARTIFACT_UNVERIFIED");
		this.name = "LocalStoryFlowSealError";
	}
}
function requireSeal(value: unknown): asserts value {
	if (!value) throw new LocalStoryFlowSealError();
}
function checked<T>(work: () => T): T {
	try {
		return work();
	} catch {
		throw new LocalStoryFlowSealError();
	}
}
const bytes = (s: string) => Buffer.byteLength(s, "utf8");

/** Inspect data descriptors before reading values, and copy without invoking accessors. */
function snapshot(input: unknown): unknown {
	let nodes = 0;
	const active = new WeakSet<object>();
	function copy(value: unknown, depth: number): unknown {
		requireSeal(
			++nodes <= LOCAL_STORY_FLOW_SEAL_POLICY.maxNodes &&
				depth <= LOCAL_STORY_FLOW_SEAL_POLICY.maxDepth,
		);
		if (value === null || typeof value === "boolean") return value;
		if (typeof value === "number") {
			requireSeal(Number.isFinite(value));
			return value;
		}
		if (typeof value === "string") {
			requireSeal(
				bytes(value) <= LOCAL_STORY_FLOW_SEAL_POLICY.maxValueJsonBytes,
			);
			return value;
		}
		requireSeal(
			typeof value === "object" && value !== null && !active.has(value),
		);
		const array = Array.isArray(value);
		requireSeal(
			Object.getPrototypeOf(value) ===
				(array ? Array.prototype : Object.prototype),
		);
		requireSeal(Object.getOwnPropertySymbols(value).length === 0);
		const descriptors = Object.getOwnPropertyDescriptors(value);
		active.add(value);
		try {
			if (array) {
				const length = descriptors.length;
				requireSeal(
					length &&
						"value" in length &&
						!length.enumerable &&
						Number.isSafeInteger(length.value) &&
						length.value >= 0 &&
						length.value <= LOCAL_STORY_FLOW_SEAL_POLICY.maxNodes,
				);
				requireSeal(Object.keys(descriptors).length === length.value + 1);
				const output: unknown[] = [];
				for (let i = 0; i < length.value; i++) {
					const d = descriptors[String(i)];
					requireSeal(d?.enumerable && "value" in d && d.value !== undefined);
					output.push(copy(d.value, depth + 1));
				}
				return output;
			}
			const entries: Array<[string, unknown]> = [];
			for (const [name, d] of Object.entries(descriptors)) {
				requireSeal(d.enumerable && "value" in d && d.value !== undefined);
				entries.push([name, copy(d.value, depth + 1)]);
			}
			return Object.fromEntries(entries);
		} finally {
			active.delete(value);
		}
	}
	return copy(input, 0);
}
const uuid = z.uuid().regex(/^[0-9a-f-]+$/);
const digest = z
	.string()
	.length(64)
	.regex(/^[0-9a-f]{64}$/);
const sourceSchema = z.strictObject({
	version: z.literal("local-story-flow-source-tuple-v1"),
	organizationId: uuid,
	sourceId: uuid,
	mediaVersionId: uuid,
	mediaSha256: digest,
	timeMapHash: digest,
	analysisRevisionId: uuid,
	analysisRawHash: digest,
	analysisDocumentHash: digest,
	bindingHash: digest,
	preparedShotClockHash: digest.nullable(),
	normalizationReceiptHash: digest.nullable(),
});
export type LocalStoryFlowSourceTuple = z.infer<typeof sourceSchema>;
const kindSchema = z.enum([
	"LOCAL_FLOW_MANIFEST_V1",
	"LOCAL_FLOW_CONTEXT_V1",
	"LOCAL_FLOW_ROUTE_V1",
	"LOCAL_FLOW_PLAN_V1",
]);
export type LocalStoryFlowRecordKind = z.infer<typeof kindSchema>;
const purposeSchema = z.enum([
	"SOURCE_ARCHIVE",
	"NATIVE_OBSERVATION",
	"NATIVE_CACHE",
	"NODE",
	"TREE",
	"STEP",
	"START",
	"ATTEMPT",
	"OUTCOME",
	"CONTEXT_BINDING",
	"ROUTE_PREFIX",
	"PLAN",
]);
type Purpose = z.infer<typeof purposeSchema>;
const versions: Record<Purpose, string> = {
	SOURCE_ARCHIVE: "local-story-flow-source-archive-v1",
	NATIVE_OBSERVATION: "local-story-flow-native-observation-v1",
	NATIVE_CACHE: "local-story-flow-native-cache-v1",
	NODE: "local-story-flow-node-artifact-v1",
	TREE: "local-story-flow-tree-artifact-v1",
	STEP: "local-story-flow-step-artifact-v1",
	START: "local-story-flow-runtime-start-v1",
	ATTEMPT: "local-story-flow-runtime-attempt-v1",
	OUTCOME: "local-story-flow-runtime-outcome-v1",
	CONTEXT_BINDING: "local-story-flow-runtime-context-binding-v1",
	ROUTE_PREFIX: "local-story-flow-runtime-prefix-v1",
	PLAN: "local-story-flow-plan-artifact-v1",
};
const permitted: Record<LocalStoryFlowRecordKind, readonly Purpose[]> = {
	LOCAL_FLOW_MANIFEST_V1: ["SOURCE_ARCHIVE"],
	LOCAL_FLOW_CONTEXT_V1: ["NATIVE_OBSERVATION", "NATIVE_CACHE", "NODE", "TREE"],
	LOCAL_FLOW_ROUTE_V1: ["NATIVE_OBSERVATION", "NATIVE_CACHE", "STEP"],
	LOCAL_FLOW_PLAN_V1: [
		"START",
		"ATTEMPT",
		"OUTCOME",
		"CONTEXT_BINDING",
		"ROUTE_PREFIX",
		"PLAN",
	],
};
const objectSchema = z.record(z.string(), z.unknown());
const keySchema = z.strictObject({
	version: z.literal("local-story-flow-record-key-v1"),
	purpose: purposeSchema,
	keyBody: objectSchema,
});
export type LocalStoryFlowRecordKey = z.infer<typeof keySchema>;
const expectedSchema = z.strictObject({
	sourceTuple: sourceSchema,
	kind: kindSchema,
	key: keySchema,
});
const refSchema = z.strictObject({
	kind: kindSchema,
	receiptId: uuid,
	cacheHash: digest,
	inputKeyHash: digest,
	proofHash: digest,
});
export type LocalStoryFlowRecordRef = z.infer<typeof refSchema>;

function uuid5Url(name: string): string {
	const b = createHash("sha1")
		.update(Buffer.from("6ba7b8119dad11d180b400c04fd430c8", "hex"))
		.update(name, "utf8")
		.digest()
		.subarray(0, 16);
	b[6] = ((b[6] ?? 0) & 15) | 0x50;
	b[8] = ((b[8] ?? 0) & 63) | 0x80;
	const s = b.toString("hex");
	return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}
function runtimeLocator(
	key: LocalStoryFlowRecordKey,
): { taskId: string; locator: string } | null {
	const p = key.purpose,
		body = key.keyBody;
	if (p === "START")
		return {
			...z.strictObject({ taskId: uuid }).parse(body),
			locator: "start",
		};
	if (p === "ATTEMPT" || p === "OUTCOME") {
		const value = z
			.strictObject({ taskId: uuid, slot: z.number().int().min(1).max(127) })
			.parse(body);
		return { taskId: value.taskId, locator: String(value.slot) };
	}
	if (p === "CONTEXT_BINDING") {
		const value = z
			.strictObject({ taskId: uuid, nodeId: localStoryFlowNodeIdSchema })
			.parse(body);
		return { taskId: value.taskId, locator: value.nodeId };
	}
	if (p === "ROUTE_PREFIX") {
		const value = z
			.strictObject({ taskId: uuid, ordinal: z.number().int().min(1).max(64) })
			.parse(body);
		return { taskId: value.taskId, locator: String(value.ordinal) };
	}
	return null;
}
function identity(expected: z.infer<typeof expectedSchema>) {
	const { sourceTuple: t, kind, key } = expected;
	requireSeal(permitted[kind].includes(key.purpose));
	requireSeal(
		bytes(canonicalEditingJson(key)) <=
			LOCAL_STORY_FLOW_SEAL_POLICY.maxKeyBytes,
	);
	const inputKeyHash = hash(key);
	const cacheHash = hash({
		version: "local-story-cache-identity-v1",
		kind,
		organizationId: t.organizationId,
		sourceId: t.sourceId,
		mediaVersionId: t.mediaVersionId,
		mediaSha256: t.mediaSha256,
		timeMapHash: t.timeMapHash,
		analysisRevisionId: t.analysisRevisionId,
		analysisRawHash: t.analysisRawHash,
		analysisDocumentHash: t.analysisDocumentHash,
		key,
	});
	const runtime = runtimeLocator(key);
	const requestKey = runtime
		? `flow-runtime-v1:${runtime.taskId}:${key.purpose}:${runtime.locator}`
		: `artifact:${cacheHash}`;
	return {
		cacheHash,
		inputKeyHash,
		receiptId: uuid5Url(`bitovp-semantic:${t.organizationId}:${requestKey}`),
	};
}
export function localStoryFlowRecordIdentity(options: unknown) {
	return checked(() => {
		// Callers may supply only these three expected fields; never derive them from a receipt.
		const copied = snapshot(options);
		const expected = expectedSchema.parse(copied);
		requireSeal(
			canonicalEditingJson(expected) === canonicalEditingJson(copied),
		);
		return identity(expected);
	});
}
const proofSchema = z.strictObject({
	version: z.literal("local-story-cache-v2"),
	cacheHash: digest,
	valueJson: z.string(),
});
const rowSchema = z.strictObject({
	id: uuid,
	organizationId: uuid,
	sourceId: uuid,
	mediaVersionId: uuid,
	analysisRevisionId: uuid,
	kind: kindSchema,
	proof: proofSchema,
	proofHash: digest,
});
const readSchema = expectedSchema.extend({ ref: refSchema, row: rowSchema });
export type BoundLocalStoryFlowSealedRecord = Readonly<object>;
export type LocalStoryFlowSealedRecordEvidence = {
	sourceTuple: LocalStoryFlowSourceTuple;
	kind: LocalStoryFlowRecordKind;
	key: LocalStoryFlowRecordKey;
	ref: LocalStoryFlowRecordRef;
	payload: Record<string, unknown>;
};
const owned = new WeakMap<
	BoundLocalStoryFlowSealedRecord,
	LocalStoryFlowSealedRecordEvidence
>();
export function readLocalStoryFlowSealedRecord(
	options: unknown,
): BoundLocalStoryFlowSealedRecord {
	return checked(() => {
		const copied = snapshot(options) as Record<string, unknown>;
		const input = readSchema.parse(copied);
		requireSeal(
			canonicalEditingJson(input.key) === canonicalEditingJson(copied.key),
		);
		const expected = identity(input),
			{ sourceTuple: t, row, ref } = input;
		requireSeal(
			row.id === expected.receiptId && ref.receiptId === expected.receiptId,
		);
		requireSeal(
			row.organizationId === t.organizationId &&
				row.sourceId === t.sourceId &&
				row.mediaVersionId === t.mediaVersionId &&
				row.analysisRevisionId === t.analysisRevisionId,
		);
		requireSeal(row.kind === input.kind && ref.kind === input.kind);
		requireSeal(
			ref.cacheHash === expected.cacheHash &&
				ref.inputKeyHash === expected.inputKeyHash &&
				row.proof.cacheHash === expected.cacheHash,
		);
		requireSeal(
			hash(row.proof) === row.proofHash && ref.proofHash === row.proofHash,
		);
		const payload = objectSchema.parse(
			snapshot(JSON.parse(row.proof.valueJson)),
		);
		requireSeal(canonicalEditingJson(payload) === row.proof.valueJson);
		requireSeal(
			payload.purpose === input.key.purpose &&
				payload.version === versions[input.key.purpose],
		);
		const handle = Object.freeze({});
		owned.set(handle, {
			sourceTuple: t,
			kind: input.kind,
			key: input.key,
			ref,
			payload,
		});
		return handle;
	});
}
export function localStoryFlowSealedRecordEvidence(
	handle: BoundLocalStoryFlowSealedRecord,
): LocalStoryFlowSealedRecordEvidence {
	return checked(() => {
		const evidence = owned.get(handle);
		requireSeal(evidence);
		return structuredClone(evidence);
	});
}
