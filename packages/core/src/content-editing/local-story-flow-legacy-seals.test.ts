import { describe, expect, it, vi } from "vitest";
import { canonicalEditingJson } from "./automatic-binding";
import {
	type LocalStoryArtifactCacheInput,
	type LocalStoryArtifactCacheRow,
	type LocalStoryCompatibleArtifactKind,
	type LocalStoryLegacyArtifactRef,
	LocalStoryLegacyArtifactSealError,
	localStoryArtifactCacheHashes,
	readLocalStoryArtifactCacheRow,
	readLocalStoryLegacyCacheRef,
} from "./local-story-flow-legacy-seals";
import { hashEditingEvidence as hash } from "./verify-automatic-binding";

// Synthetic fixtures only; no DB/model/native path.
const org = "00000000-0000-4000-8000-000000000001";
const legacyIds = {
	LOCAL_STORY_TRANSCRIPT_V1: "48344daf-133e-5229-90c2-629e3a2b4974",
	LOCAL_STORY_LEDGER_V1: "14f481b1-9208-57d6-92e4-663263430c3c",
	LOCAL_STORY_BLUEPRINT_V1: "482b50fc-8e17-50c2-9394-fe162d11dea0",
	LOCAL_CAPTION_TRANSLATION_V1: "f21955a5-4bf4-548a-8cdf-57556a251e9e",
} as const;
function fixture(
	kind: LocalStoryCompatibleArtifactKind = "LOCAL_STORY_LEDGER_V1",
) {
	const scope = {
		task: { organizationId: org },
		media: {
			id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
			sourceId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
			sha256: "a".repeat(64),
			timeMap: { marker: "fixed-clock" },
		},
		taskIdentity: {
			analysisRawHash: "b".repeat(64),
			analysisDocumentHash: "c".repeat(64),
		},
		analysisRevisionId:
			kind === "LOCAL_STORY_TRANSCRIPT_V1"
				? null
				: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
	};
	const input: LocalStoryArtifactCacheInput<unknown> = {
		kind,
		key: { model: "fixed", promptHash: "d".repeat(64) },
		parse: vi.fn((value: unknown) => value),
	};
	const identity = localStoryArtifactCacheHashes({ ...scope, input });
	const receiptId =
		kind in legacyIds
			? Reflect.get(legacyIds, kind)
			: "11111111-1111-4111-8111-111111111111";
	if (typeof receiptId !== "string") throw new Error("Missing synthetic ID");
	const proof = {
		version: "local-story-cache-v2",
		cacheHash: identity.cacheHash,
		valueJson: canonicalEditingJson({ text: "grounded fixture" }),
	};
	const row: LocalStoryArtifactCacheRow = {
		id: receiptId,
		organizationId: org,
		sourceId: scope.media.sourceId,
		mediaVersionId: scope.media.id,
		analysisRevisionId: scope.analysisRevisionId,
		kind,
		proof,
		proofHash: hash(proof),
	};
	const check = vi.fn(() => {});
	return { ...scope, input, ...identity, receiptId, row, check };
}
describe("old cache row extraction", () => {
	it.each([
		"LOCAL_STORY_TRANSCRIPT_V1",
		"LOCAL_STORY_LEDGER_V1",
		"LOCAL_STORY_BLUEPRINT_V1",
		"LOCAL_CAPTION_TRANSLATION_V1",
		"LOCAL_FLOW_MANIFEST_V1",
		"LOCAL_FLOW_CONTEXT_V1",
		"LOCAL_FLOW_ROUTE_V1",
		"LOCAL_FLOW_PLAN_V1",
	] as const)("keeps the compatible old-store eight-kind read of %s", (kind) => {
		const f = fixture(kind),
			before = structuredClone(f.row);
		expect(readLocalStoryArtifactCacheRow(f)).toEqual({
			value: { text: "grounded fixture" },
			hash: hash({ text: "grounded fixture" }),
			cached: true,
		});
		expect(f.row).toEqual(before);
		expect(f.input.parse).toHaveBeenCalledOnce();
	});
	it("preserves both key JSON conversions, their order and the original input alias", () => {
		const f = fixture();
		const toJSON = vi
			.fn()
			.mockReturnValueOnce({ pass: 1 })
			.mockReturnValueOnce({ pass: 2 });
		f.input.key = { toJSON };
		const id = localStoryArtifactCacheHashes(f);
		expect(toJSON).toHaveBeenCalledTimes(2);
		expect(id.inputKeyHash).toBe(hash({ pass: 1 }));
		expect(id.cacheHash).toBe(
			hash({
				version: "local-story-cache-identity-v1",
				kind: f.input.kind,
				organizationId: org,
				sourceId: f.media.sourceId,
				mediaVersionId: f.media.id,
				mediaSha256: f.media.sha256,
				timeMapHash: hash(f.media.timeMap),
				analysisRevisionId: f.analysisRevisionId,
				analysisRawHash: f.taskIdentity.analysisRawHash,
				analysisDocumentHash: f.taskIdentity.analysisDocumentHash,
				key: { pass: 2 },
			}),
		);
	});
	it("does not persist or accept a candidate unless the whole ORIGINAL v1 transcript seal matches", () => {
		const f = fixture("LOCAL_STORY_TRANSCRIPT_V1");
		const original = { text: "Synthetic speech", mean: -0.21932977413201898 };
		const proof = {
			version: "local-story-cache-v1",
			cacheHash: f.cacheHash,
			value: original,
		};
		f.row.proofHash = hash(proof);
		f.row.proof = {
			...proof,
			value: { ...original, mean: -0.219329774132019 },
		};
		const persisted = structuredClone(f.row);
		f.input.recoverLegacyTranscriptValue = vi.fn(() =>
			structuredClone(original),
		);
		expect(readLocalStoryArtifactCacheRow(f).value).toEqual(original);
		expect(f.row).toEqual(persisted);
		f.row.proof = {
			...proof,
			value: { text: "tampered", mean: -0.219329774132019 },
		};
		f.input.recoverLegacyTranscriptValue = (value) => {
			if (
				!value ||
				typeof value !== "object" ||
				!("text" in value) ||
				typeof value.text !== "string"
			)
				throw new Error("Bad synthetic value");
			return { text: value.text, mean: original.mean };
		};
		expect(() => readLocalStoryArtifactCacheRow(f)).toThrow(
			LocalStoryLegacyArtifactSealError,
		);
	});
	it("rejects parse normalization and wraps callback errors without leaking the original message", () => {
		const f = fixture();
		f.input.parse = () => ({ text: "normalized" });
		expect(() => readLocalStoryArtifactCacheRow(f)).toThrow(
			"LOCAL_STORY_ARTIFACT_UNVERIFIED",
		);
		f.input.parse = () => {
			throw new Error("PRIVATE_CALLBACK_SENTINEL");
		};
		expect(() => readLocalStoryArtifactCacheRow(f)).toThrow(
			"LOCAL_STORY_ARTIFACT_UNVERIFIED",
		);
	});
	it("does not let a read failure mask the trusted cancellation guard", () => {
		const f = fixture(),
			cancel = new Error("CANCELED");
		f.input.parse = () => {
			throw new Error("PRIVATE_CALLBACK_SENTINEL");
		};
		f.check.mockImplementation(() => {
			throw cancel;
		});
		expect(() => readLocalStoryArtifactCacheRow(f)).toThrow(cancel);
	});
	it("refuses a noncanonical v2 value despite a new outer hash", () => {
		const f = fixture();
		f.row.proof = {
			version: "local-story-cache-v2",
			cacheHash: f.cacheHash,
			valueJson: '{ "text": "grounded fixture" }',
		};
		f.row.proofHash = hash(f.row.proof);
		expect(() => readLocalStoryArtifactCacheRow(f)).toThrow(
			LocalStoryLegacyArtifactSealError,
		);
	});
	it.each([
		"LOCAL_STORY_TRANSCRIPT_V1",
		"LOCAL_STORY_LEDGER_V1",
		"LOCAL_STORY_BLUEPRINT_V1",
		"LOCAL_CAPTION_TRANSLATION_V1",
	] as const)("binds terminal %s to the original full seal and artifact namespace", (kind) => {
		const f = fixture(kind);
		const ref: LocalStoryLegacyArtifactRef = {
			kind,
			receiptId: f.receiptId,
			cacheHash: f.cacheHash,
			inputKeyHash: f.inputKeyHash,
			proofHash: f.row.proofHash,
		};
		expect(readLocalStoryLegacyCacheRef({ ...f, ref }).cached).toBe(true);
		expect(() =>
			readLocalStoryLegacyCacheRef({
				...f,
				ref: { ...ref, receiptId: "288fe5ff-910c-5097-9d7a-726dbcc788c7" },
			}),
		).toThrow(LocalStoryLegacyArtifactSealError);
		const flow = fixture("LOCAL_FLOW_CONTEXT_V1");
		expect(() => readLocalStoryLegacyCacheRef({ ...flow, ref })).toThrow(
			LocalStoryLegacyArtifactSealError,
		);
	});
});

it.each([
	"LOCAL_FLOW_MANIFEST_V1",
	"LOCAL_FLOW_CONTEXT_V1",
	"LOCAL_FLOW_ROUTE_V1",
	"LOCAL_FLOW_PLAN_V1",
] as const)("does not admit a new %s through the terminal legacy ref domain", (kind) => {
	const f = fixture(kind);
	const ref = {
		kind,
		receiptId: f.receiptId,
		cacheHash: f.cacheHash,
		inputKeyHash: f.inputKeyHash,
		proofHash: f.row.proofHash,
	};
	expect(() =>
		Reflect.apply(readLocalStoryLegacyCacheRef, null, [{ ...f, ref }]),
	).toThrow(LocalStoryLegacyArtifactSealError);
});
