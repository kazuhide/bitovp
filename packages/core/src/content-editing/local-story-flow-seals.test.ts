import { describe, expect, it } from "vitest";
import { canonicalEditingJson } from "./automatic-binding";
import {
	LocalStoryFlowSealError,
	localStoryFlowRecordIdentity,
	localStoryFlowSealedRecordEvidence,
	readLocalStoryFlowSealedRecord,
} from "./local-story-flow-seals";
import { hashEditingEvidence as hash } from "./verify-automatic-binding";

const org = "00000000-0000-4000-8000-000000000001";
const taskId = "00000000-0000-4000-8000-000000000002";
const sourceTuple = {
	version: "local-story-flow-source-tuple-v1",
	organizationId: org,
	sourceId: "00000000-0000-4000-8000-000000000003",
	mediaVersionId: "00000000-0000-4000-8000-000000000004",
	mediaSha256: "a".repeat(64),
	timeMapHash: "b".repeat(64),
	analysisRevisionId: "00000000-0000-4000-8000-000000000005",
	analysisRawHash: "c".repeat(64),
	analysisDocumentHash: "d".repeat(64),
	bindingHash: "e".repeat(64),
	preparedShotClockHash: null,
	normalizationReceiptHash: null,
};
const cases = [
	[
		"LOCAL_FLOW_MANIFEST_V1",
		"SOURCE_ARCHIVE",
		"local-story-flow-source-archive-v1",
		{ sourceTuple, taskId },
	],
	[
		"LOCAL_FLOW_CONTEXT_V1",
		"NATIVE_OBSERVATION",
		"local-story-flow-native-observation-v1",
		{ nativeKeyHash: "a".repeat(64), originTaskId: taskId, slot: 1 },
	],
	[
		"LOCAL_FLOW_CONTEXT_V1",
		"NATIVE_CACHE",
		"local-story-flow-native-cache-v1",
		{ nativeKeyHash: "a".repeat(64) },
	],
	[
		"LOCAL_FLOW_CONTEXT_V1",
		"NODE",
		"local-story-flow-node-artifact-v1",
		{
			inputHash: "a".repeat(64),
			observationHash: "b".repeat(64),
			contextPolicyHash: "c".repeat(64),
		},
	],
	[
		"LOCAL_FLOW_CONTEXT_V1",
		"TREE",
		"local-story-flow-tree-artifact-v1",
		{ sourceArchiveRef: "outer-only fixture", orderedNodeRefs: [] },
	],
	[
		"LOCAL_FLOW_ROUTE_V1",
		"NATIVE_OBSERVATION",
		"local-story-flow-native-observation-v1",
		{ nativeKeyHash: "a".repeat(64), originTaskId: taskId, slot: 64 },
	],
	[
		"LOCAL_FLOW_ROUTE_V1",
		"NATIVE_CACHE",
		"local-story-flow-native-cache-v1",
		{ nativeKeyHash: "a".repeat(64) },
	],
	[
		"LOCAL_FLOW_ROUTE_V1",
		"STEP",
		"local-story-flow-step-artifact-v1",
		{
			expectationHash: "a".repeat(64),
			observationHash: "b".repeat(64),
			routePolicyHash: "c".repeat(64),
		},
	],
	[
		"LOCAL_FLOW_PLAN_V1",
		"START",
		"local-story-flow-runtime-start-v1",
		{ taskId },
	],
	[
		"LOCAL_FLOW_PLAN_V1",
		"ATTEMPT",
		"local-story-flow-runtime-attempt-v1",
		{ taskId, slot: 127 },
	],
	[
		"LOCAL_FLOW_PLAN_V1",
		"OUTCOME",
		"local-story-flow-runtime-outcome-v1",
		{ taskId, slot: 1 },
	],
	[
		"LOCAL_FLOW_PLAN_V1",
		"CONTEXT_BINDING",
		"local-story-flow-runtime-context-binding-v1",
		{ taskId, nodeId: "n62" },
	],
	[
		"LOCAL_FLOW_PLAN_V1",
		"ROUTE_PREFIX",
		"local-story-flow-runtime-prefix-v1",
		{ taskId, ordinal: 64 },
	],
	[
		"LOCAL_FLOW_PLAN_V1",
		"PLAN",
		"local-story-flow-plan-artifact-v1",
		{
			taskId,
			startHash: "a".repeat(64),
			finalPrefixHash: "b".repeat(64),
			scopePolicyHash: "c".repeat(64),
		},
	],
] as const;

function fixture(index = 0) {
	const c = cases[index];
	if (!c) throw new Error("fixture case missing");
	const expected = structuredClone({
		sourceTuple,
		kind: c[0],
		key: {
			version: "local-story-flow-record-key-v1",
			purpose: c[1],
			keyBody: c[3],
		},
	});
	const id = localStoryFlowRecordIdentity(expected);
	const payload = {
		version: c[2],
		purpose: c[1],
		retained: ["日本語\n内側の空白  ", 1 / 3, 1.2345678901234567],
	};
	const proof = {
		version: "local-story-cache-v2",
		cacheHash: id.cacheHash,
		valueJson: canonicalEditingJson(payload),
	};
	const ref = {
		kind: c[0],
		receiptId: id.receiptId,
		cacheHash: id.cacheHash,
		inputKeyHash: id.inputKeyHash,
		proofHash: hash(proof),
	};
	const row = {
		id: id.receiptId,
		organizationId: org,
		sourceId: sourceTuple.sourceId,
		mediaVersionId: sourceTuple.mediaVersionId,
		analysisRevisionId: sourceTuple.analysisRevisionId,
		kind: c[0],
		proof,
		proofHash: hash(proof),
	};
	return { ...expected, ref, row, payload };
}
const read = (f: ReturnType<typeof fixture>) =>
	readLocalStoryFlowSealedRecord({
		sourceTuple: f.sourceTuple,
		kind: f.kind,
		key: f.key,
		ref: f.ref,
		row: f.row,
	});
const identityOf = (f: ReturnType<typeof fixture>) =>
	localStoryFlowRecordIdentity({
		sourceTuple: f.sourceTuple,
		kind: f.kind,
		key: f.key,
	});
const rejected = (work: () => unknown) => {
	let error: unknown;
	try {
		work();
	} catch (caught) {
		error = caught;
	}
	expect(error).toBeInstanceOf(LocalStoryFlowSealError);
	expect(error).toMatchObject({
		code: "LOCAL_STORY_ARTIFACT_UNVERIFIED",
		message: "LOCAL_STORY_ARTIFACT_UNVERIFIED",
	});
	expect(error).not.toHaveProperty("cause");
};

describe("FLOW outer seal without DB or native authority", () => {
	it.each(
		cases.map((c, index) => [c[0], c[1], index] as const),
	)("reads %s/%s without modifying canonical full text", (_kind, _purpose, index) => {
		const f = fixture(index),
			handle = read(f);
		const evidence = localStoryFlowSealedRecordEvidence(handle);
		expect(evidence.payload).toEqual(f.payload);
		expect(evidence.key).toEqual(f.key);
		expect(evidence.ref).toEqual(f.ref);
	});
	it("uses the old cache identity formula and a task-fixed runtime row namespace", () => {
		const f = fixture(8);
		const identity = identityOf(f);
		expect(identity.inputKeyHash).toBe(hash(f.key));
		expect(identity.cacheHash).toBe(
			hash({
				version: "local-story-cache-identity-v1",
				kind: f.kind,
				organizationId: org,
				sourceId: f.sourceTuple.sourceId,
				mediaVersionId: f.sourceTuple.mediaVersionId,
				mediaSha256: f.sourceTuple.mediaSha256,
				timeMapHash: f.sourceTuple.timeMapHash,
				analysisRevisionId: f.sourceTuple.analysisRevisionId,
				analysisRawHash: f.sourceTuple.analysisRawHash,
				analysisDocumentHash: f.sourceTuple.analysisDocumentHash,
				key: f.key,
			}),
		);
		// UUID is independently checked against Python's standard uuid5 in the receipt.
		expect(identity.receiptId).toBe("288fe5ff-910c-5097-9d7a-726dbcc788c7");
		expect(identity.receiptId).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
		);
		const changed = structuredClone(f);
		changed.sourceTuple.mediaSha256 = "f".repeat(64);
		expect(identityOf(changed).receiptId).toBe(identity.receiptId);
		expect(identityOf(changed).cacheHash).not.toBe(identity.cacheHash);
	});
	it.each([
		[8, "288fe5ff-910c-5097-9d7a-726dbcc788c7"],
		[9, "cb879d8a-27fb-5a09-94e6-c039d54bd742"],
		[10, "b51f8911-9ece-5712-ba5d-9313591fbd1c"],
		[11, "8e660ba2-7f2f-5dda-9bac-4896bb44fc29"],
		[12, "1599aee4-ab96-512b-b5f5-470f294fa1c8"],
	] as const)("matches Python UUID5 for runtime case %s", (index, expected) => {
		expect(identityOf(fixture(index)).receiptId).toBe(expected);
	});
	it("binds every row identity field and every Ref field", () => {
		for (const field of [
			"id",
			"organizationId",
			"sourceId",
			"mediaVersionId",
			"analysisRevisionId",
			"kind",
			"proofHash",
		] as const) {
			const f = fixture();
			Object.assign(f.row, {
				[field]:
					field === "proofHash"
						? "f".repeat(64)
						: field === "kind"
							? "LOCAL_FLOW_ROUTE_V1"
							: taskId,
			});
			rejected(() => read(f));
		}
		for (const field of [
			"kind",
			"receiptId",
			"cacheHash",
			"inputKeyHash",
			"proofHash",
		] as const) {
			const f = fixture();
			Object.assign(f.ref, {
				[field]:
					field === "kind"
						? "LOCAL_FLOW_ROUTE_V1"
						: field === "receiptId"
							? taskId
							: "f".repeat(64),
			});
			rejected(() => read(f));
		}
	});
	it("rejects missing, extra, wrong-kind, null-analysis and changed independent keys", () => {
		for (const change of [
			(f: ReturnType<typeof fixture>) => {
				Object.assign(f, { kind: "LOCAL_STORY_TRANSCRIPT_V1" });
			},
			(f: ReturnType<typeof fixture>) => {
				Object.assign(f.sourceTuple, { analysisRevisionId: null });
			},
			(f: ReturnType<typeof fixture>) => {
				Object.assign(f.row, { extra: 1 });
			},
			(f: ReturnType<typeof fixture>) => {
				Reflect.deleteProperty(f.ref, "proofHash");
			},
			(f: ReturnType<typeof fixture>) => {
				Object.assign(f.key.keyBody, { changed: true });
			},
		]) {
			const f = fixture();
			change(f);
			rejected(() => read(f));
		}
	});
	it("requires canonical v2 valueJson and the original complete proof hash", () => {
		for (const change of [
			(f: ReturnType<typeof fixture>) => {
				f.row.proof.valueJson = JSON.stringify(f.payload, null, 2);
			},
			(f: ReturnType<typeof fixture>) => {
				f.row.proof.valueJson = "{";
			},
			(f: ReturnType<typeof fixture>) => {
				f.row.proof.valueJson = canonicalEditingJson({
					...f.payload,
					retained: [],
				});
			},
			(f: ReturnType<typeof fixture>) => {
				Object.assign(f.row.proof, {
					version: "local-story-cache-v1",
					value: f.payload,
				});
			},
			(f: ReturnType<typeof fixture>) => {
				Object.assign(f.row.proof, { extra: true });
			},
		]) {
			const f = fixture();
			change(f);
			rejected(() => read(f));
		}
	});
	it("rejects noncanonical encoding after its outer proof is resealed", () => {
		const f = fixture();
		f.row.proof.valueJson = JSON.stringify(f.payload, null, 2);
		f.row.proofHash = hash(f.row.proof);
		f.ref.proofHash = f.row.proofHash;
		rejected(() => read(f));
	});
	it("rejects a legal kind with a purpose from another namespace", () => {
		const f = fixture();
		Object.assign(f, { kind: "LOCAL_FLOW_ROUTE_V1" });
		rejected(() => identityOf(f));
	});
	it("rejects a key when schema parsing would drop a JSON data field", () => {
		const f = fixture();
		Object.assign(f.key, {
			keyBody: JSON.parse('{"__proto__":{"retained":"whole key"}}'),
		});
		rejected(() => identityOf(f));
	});
	it("rejects a self-resealed payload of another version or purpose", () => {
		for (const altered of [{ version: "old-v1" }, { purpose: "START" }]) {
			const f = fixture();
			f.row.proof.valueJson = canonicalEditingJson({
				...f.payload,
				...altered,
			});
			f.row.proofHash = hash(f.row.proof);
			f.ref.proofHash = f.row.proofHash;
			rejected(() => read(f));
		}
	});
	it("checks runtime locator caps and exact body keys", () => {
		for (const [index, changes] of [
			[9, { slot: 0 }],
			[9, { slot: 128 }],
			[9, { slot: 1.5 }],
			[12, { ordinal: 65 }],
			[11, { nodeId: "n63" }],
			[11, { nodeId: "n1\n" }],
			[8, { extra: true }],
		] as const) {
			const f = fixture(index);
			Object.assign(f.key.keyBody, changes);
			rejected(() => identityOf(f));
		}
	});
	it("does not invoke getters or admit symbols, hidden fields, holes or prototypes", () => {
		let invoked = 0;
		const f = fixture();
		Object.defineProperty(f.row.proof, "valueJson", {
			enumerable: true,
			get() {
				invoked++;
				throw new Error("private sentinel");
			},
		});
		rejected(() => read(f));
		expect(invoked).toBe(0);
		for (const bad of [
			Object.assign({}, { [Symbol("private")]: 1 }),
			Object.create({ inherited: 1 }),
			Array(2),
			{ value: undefined },
			{ value: Infinity },
			{ value: new Date() },
			Object.defineProperty({}, "hidden", { value: 1 }),
		]) {
			const g = fixture();
			Object.assign(g.key, { keyBody: { bad } });
			rejected(() => identityOf(g));
		}
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		const g = fixture();
		Object.assign(g.key, { keyBody: circular });
		rejected(() => read(g));
	});
	it("rejects excessive key bytes and nesting without truncating them", () => {
		const f = fixture();
		Object.assign(f.key, { keyBody: { text: "あ".repeat(100_000) } });
		rejected(() => read(f));
		let deep: unknown = null;
		for (let i = 0; i < 130; i++) deep = { deep };
		Object.assign(f.key, { keyBody: { deep } });
		rejected(() => read(f));
	});
	it("keeps private evidence detached and rejects cloned handles", () => {
		const f = fixture(),
			handle = read(f);
		const original = localStoryFlowSealedRecordEvidence(handle);
		f.payload.retained.length = 0;
		f.row.proof.valueJson = "changed";
		Object.assign(original.payload, { retained: "changed" });
		expect(localStoryFlowSealedRecordEvidence(handle).payload).not.toEqual(
			original.payload,
		);
		rejected(() => localStoryFlowSealedRecordEvidence(structuredClone(handle)));
	});
});
