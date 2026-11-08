import { createHash } from "node:crypto";
import { canonicalEditingJson } from "./automatic-binding";
import { hashEditingEvidence } from "./verify-automatic-binding";

// Original cache recipe, not P1a FLOW runtime seals or DB authorization.
export type LocalStoryLegacyArtifactKind =
	| "LOCAL_STORY_TRANSCRIPT_V1"
	| "LOCAL_STORY_LEDGER_V1"
	| "LOCAL_STORY_BLUEPRINT_V1"
	| "LOCAL_CAPTION_TRANSLATION_V1";
export type LocalStoryCompatibleArtifactKind =
	| LocalStoryLegacyArtifactKind
	| "LOCAL_STORY_CHOICE_V1"
	| "LOCAL_FLOW_MANIFEST_V1"
	| "LOCAL_FLOW_CONTEXT_V1"
	| "LOCAL_FLOW_ROUTE_V1"
	| "LOCAL_FLOW_PLAN_V1";
type Json =
	| string
	| number
	| boolean
	| null
	| Json[]
	| { [key: string]: Json | undefined };
export type LocalStoryArtifactCacheScope = {
	task: { organizationId: string };
	media: {
		sourceId: string;
		id: string;
		sha256: string | null;
		timeMap: unknown;
	};
	taskIdentity: { analysisRawHash?: unknown; analysisDocumentHash?: unknown };
	analysisRevisionId: string | null;
};
export type LocalStoryArtifactCacheInput<T> = {
	kind: LocalStoryCompatibleArtifactKind;
	key: unknown;
	parse(value: unknown): T;
	recoverLegacyTranscriptValue?(value: unknown): T;
};
export type LocalStoryArtifactCacheRow = {
	id: string;
	organizationId: string;
	sourceId: string | null;
	mediaVersionId: string | null;
	analysisRevisionId: string | null;
	kind: string;
	proof: Json;
	proofHash: string;
};
export type LocalStoryArtifactCacheReadResult<T> = {
	value: T;
	hash: string;
	cached: true;
};
export class LocalStoryLegacyArtifactSealError extends Error {
	readonly code = "LOCAL_STORY_ARTIFACT_UNVERIFIED";
	constructor() {
		super("LOCAL_STORY_ARTIFACT_UNVERIFIED");
		this.name = "LocalStoryLegacyArtifactSealError";
	}
}
const json = (value: unknown): Json => JSON.parse(JSON.stringify(value));

/** Keep BOTH original key JSON conversions in their original order; do not clone input. */
export function localStoryArtifactCacheHashes(
	options: LocalStoryArtifactCacheScope & {
		input: Pick<LocalStoryArtifactCacheInput<unknown>, "kind" | "key">;
	},
): { cacheHash: string; inputKeyHash: string } {
	const { input, task, media, taskIdentity, analysisRevisionId } = options;
	let cacheHash: string, inputKeyHash: string;
	try {
		inputKeyHash = hashEditingEvidence(json(input.key));
		cacheHash = hashEditingEvidence({
			version: "local-story-cache-identity-v1",
			kind: input.kind,
			organizationId: task.organizationId,
			sourceId: media.sourceId,
			mediaVersionId: media.id,
			mediaSha256: media.sha256,
			timeMapHash: hashEditingEvidence(media.timeMap),
			analysisRevisionId,
			analysisRawHash: analysisRevisionId ? taskIdentity.analysisRawHash : null,
			analysisDocumentHash: analysisRevisionId
				? taskIdentity.analysisDocumentHash
				: null,
			key: json(input.key),
		});
	} catch {
		throw new LocalStoryLegacyArtifactSealError();
	}
	return { cacheHash, inputKeyHash };
}

/** Mechanical old-row reader. The worker compatibility domain remains all eight kinds.
 * check is a trusted caller guard, not model metadata. input remains the same live object.
 * Unknown-descriptor admission and independently authorized source facts belong to caller.
 */
export function readLocalStoryArtifactCacheRow<T>(options: {
	row: LocalStoryArtifactCacheRow;
	input: LocalStoryArtifactCacheInput<T>;
	task: { organizationId: string };
	media: { sourceId: string; id: string };
	analysisRevisionId: string | null;
	cacheHash: string;
	receiptId: string;
	check(): void;
}): LocalStoryArtifactCacheReadResult<T> {
	const {
		row,
		input,
		task,
		media,
		analysisRevisionId,
		cacheHash,
		receiptId,
		check,
	} = options;
	try {
		const proof = row.proof;
		if (
			!proof ||
			typeof proof !== "object" ||
			Array.isArray(proof) ||
			Object.keys(proof).length !== 3 ||
			!("version" in proof && "cacheHash" in proof) ||
			!(
				(proof.version === "local-story-cache-v1" && "value" in proof) ||
				(proof.version === "local-story-cache-v2" && "valueJson" in proof)
			) ||
			proof.cacheHash !== cacheHash ||
			row.id !== receiptId ||
			row.organizationId !== task.organizationId ||
			row.sourceId !== media.sourceId ||
			row.mediaVersionId !== media.id ||
			row.analysisRevisionId !== analysisRevisionId ||
			row.kind !== input.kind
		)
			throw new Error("Unverified artifact");
		let decoded: unknown;
		if (proof.version === "local-story-cache-v2") {
			if (
				hashEditingEvidence(proof) !== row.proofHash ||
				typeof proof.valueJson !== "string"
			)
				throw new Error("Unverified artifact");
			decoded = JSON.parse(proof.valueJson);
			if (canonicalEditingJson(decoded) !== proof.valueJson)
				throw new Error("Noncanonical encoding");
		} else {
			decoded = proof.value;
			if (hashEditingEvidence(proof) !== row.proofHash) {
				if (
					input.kind !== "LOCAL_STORY_TRANSCRIPT_V1" ||
					!input.recoverLegacyTranscriptValue
				)
					throw new Error("Unverified artifact");
				// Never modify the stored proof/hash. Only this trusted transcript
				// hook may propose derived fields, and the entire ORIGINAL seal
				// must match exactly before the ordinary caller parser can run.
				decoded = json(input.recoverLegacyTranscriptValue(json(proof.value)));
				if (hashEditingEvidence({ ...proof, value: decoded }) !== row.proofHash)
					throw new Error("Unverified reconstruction");
			}
		}
		const value = input.parse(decoded);
		if (hashEditingEvidence(value) !== hashEditingEvidence(decoded))
			throw new Error("Noncanonical value");
		check();
		return { value, hash: hashEditingEvidence(value), cached: true };
	} catch {
		check();
		throw new LocalStoryLegacyArtifactSealError();
	}
}

/** Closed OLD ref domain: never cast a FLOW Ref or apply P1a runtime row IDs here. */
export type LocalStoryLegacyArtifactRef = {
	kind: LocalStoryLegacyArtifactKind;
	receiptId: string;
	cacheHash: string;
	inputKeyHash: string;
	proofHash: string;
};
const legacyKinds = new Set<string>([
	"LOCAL_STORY_TRANSCRIPT_V1",
	"LOCAL_STORY_LEDGER_V1",
	"LOCAL_STORY_BLUEPRINT_V1",
	"LOCAL_CAPTION_TRANSLATION_V1",
]);
function legacyReceiptId(organizationId: string, cacheHash: string): string {
	const bytes = createHash("sha1")
		.update(Buffer.from("6ba7b8119dad11d180b400c04fd430c8", "hex"))
		.update(`bitovp-semantic:${organizationId}:artifact:${cacheHash}`)
		.digest()
		.subarray(0, 16);
	bytes[6] = ((bytes[6] ?? 0) & 15) | 0x50;
	bytes[8] = ((bytes[8] ?? 0) & 63) | 0x80;
	const h = bytes.toString("hex");
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
/** Terminal adapter only. Expected scope/key must be independently resolved by a trusted
 * org-scoped reader, which supplies descriptor-safe snapshots. No miss/build/write path.
 */
export function readLocalStoryLegacyCacheRef<T>(
	options: LocalStoryArtifactCacheScope & {
		input: LocalStoryArtifactCacheInput<T>;
		row: LocalStoryArtifactCacheRow;
		ref: LocalStoryLegacyArtifactRef;
		check(): void;
	},
): LocalStoryArtifactCacheReadResult<T> {
	let cacheHash: string, inputKeyHash: string, receiptId: string;
	try {
		const { input, ref, row } = options;
		if (
			!legacyKinds.has(input.kind) ||
			!legacyKinds.has(ref.kind) ||
			ref.kind !== input.kind ||
			Object.keys(ref).sort().join(",") !==
				"cacheHash,inputKeyHash,kind,proofHash,receiptId"
		)
			throw new Error("Legacy ref domain");
		({ cacheHash, inputKeyHash } = localStoryArtifactCacheHashes(options));
		receiptId = legacyReceiptId(options.task.organizationId, cacheHash);
		if (
			ref.cacheHash !== cacheHash ||
			ref.inputKeyHash !== inputKeyHash ||
			ref.receiptId !== receiptId ||
			ref.proofHash !== row.proofHash
		)
			throw new Error("Unverified legacy ref");
	} catch {
		options.check();
		throw new LocalStoryLegacyArtifactSealError();
	}
	return readLocalStoryArtifactCacheRow({ ...options, cacheHash, receiptId });
}
