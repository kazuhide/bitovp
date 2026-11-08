import { createHash } from "node:crypto";
import {
	hashEditingEvidence,
	type StoryArtifact,
	type StoryGraph,
	type StoryModelIdentity,
	type StoryModelInput,
	storyArtifactSchema,
	storyModelIdentitySchema,
	validateStoryGraph,
} from "@bitovp/core";
import type { AppPrismaClient, LibraryMediaTask, Prisma } from "@bitovp/db";
import {
	type VerifiedMediaTask,
	verifyMediaTaskEvidence,
} from "./media-task-execution";
import { MediaOperationError } from "./process";

export type StoryModel = {
	identity: StoryModelIdentity;
	extract(input: {
		input: StoryModelInput;
		signal: AbortSignal;
	}): Promise<StoryGraph>;
};
type CacheIdentity = {
	organizationId: string;
	mediaVersionId: string;
	analysisRevisionId: string;
	inputHash: string;
	identity: StoryModelIdentity;
};
type StoryReceiptProof = {
	version: "aisa-story-receipt-v1";
	cacheIdentityHash: string;
	artifact: StoryArtifact;
};
const cacheIdentityHash = (identity: CacheIdentity) =>
	hashEditingEvidence({ version: "story-artifact-cache-v1", ...identity });

/** Independent of desired duration, generated project IDs and worker attempts. */
export function storyArtifactReceiptId(identity: CacheIdentity) {
	const bytes = createHash("sha256")
		.update(cacheIdentityHash(identity))
		.digest()
		.subarray(0, 16);
	bytes[6] = ((bytes[6] ?? 0) & 15) | 0x80;
	bytes[8] = ((bytes[8] ?? 0) & 63) | 0x80;
	const hex = bytes.toString("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
const lockKey = (receiptId: string) =>
	BigInt.asIntN(
		64,
		BigInt(
			`0x${createHash("sha256").update(`story-artifact:${receiptId}`).digest("hex").slice(0, 16)}`,
		),
	);
const json = (value: unknown): Prisma.InputJsonValue =>
	JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
function checkSignal(signal: AbortSignal) {
	if (signal.aborted)
		throw signal.reason ?? new MediaOperationError("CANCELED");
}

/** Read a server-owned immutable receipt, never a caller-supplied graph. */
function verifiedArtifact(
	row: {
		id: string;
		organizationId: string;
		sourceId: string | null;
		mediaVersionId: string | null;
		analysisRevisionId: string | null;
		kind: string;
		proof: unknown;
		proofHash: string;
	},
	key: CacheIdentity,
	receiptId: string,
	sourceId: string,
	input: StoryModelInput,
): StoryArtifact {
	try {
		const stored = row.proof;
		if (
			!stored ||
			typeof stored !== "object" ||
			Array.isArray(stored) ||
			Object.keys(stored).length !== 3 ||
			!(
				"version" in stored &&
				"cacheIdentityHash" in stored &&
				"artifact" in stored
			) ||
			stored.version !== "aisa-story-receipt-v1" ||
			stored.cacheIdentityHash !== cacheIdentityHash(key)
		)
			throw new Error("Unverified story receipt");
		const proof: StoryReceiptProof = {
			version: "aisa-story-receipt-v1",
			cacheIdentityHash: cacheIdentityHash(key),
			artifact: storyArtifactSchema.parse(stored.artifact),
		};
		const artifact = proof.artifact;
		if (
			row.id !== receiptId ||
			row.organizationId !== key.organizationId ||
			row.sourceId !== sourceId ||
			row.mediaVersionId !== key.mediaVersionId ||
			row.analysisRevisionId !== key.analysisRevisionId ||
			row.kind !== "STORY_GRAPH_V1" ||
			artifact.inputHash !== key.inputHash ||
			hashEditingEvidence(artifact.identity) !==
				hashEditingEvidence(key.identity) ||
			hashEditingEvidence(proof) !== row.proofHash ||
			hashEditingEvidence(row.proof) !== row.proofHash
		)
			throw new Error("Unverified story artifact");
		validateStoryGraph({ input, graph: artifact.graph });
		return artifact;
	} catch {
		throw new MediaOperationError("STORY_ARTIFACT_UNVERIFIED");
	}
}

/** Model work stays outside database transactions; only live owners may publish evidence. */
export async function loadStoryArtifact(options: {
	prisma: AppPrismaClient;
	task: LibraryMediaTask;
	verified: VerifiedMediaTask;
	leaseToken: string;
	input: StoryModelInput;
	model: StoryModel;
	signal: AbortSignal;
	now?: () => Date;
}): Promise<{
	artifact: StoryArtifact;
	artifactHash: string;
	cached: boolean;
}> {
	const { prisma, task, verified, input, model, signal } = options,
		now = options.now ?? (() => new Date());
	checkSignal(signal);
	if (!task.analysisRevisionId || !verified.binding)
		throw new MediaOperationError("ANALYSIS_BINDING_UNVERIFIED");
	const key: CacheIdentity = {
		organizationId: task.organizationId,
		mediaVersionId: task.mediaVersionId,
		analysisRevisionId: task.analysisRevisionId,
		inputHash: hashEditingEvidence(input),
		identity: storyModelIdentitySchema.parse(model.identity),
	};
	const receiptId = storyArtifactReceiptId(key);
	const cached = await prisma.libraryEvidenceReceipt.findUnique({
		where: { id: receiptId },
	});
	if (cached) {
		const artifact = verifiedArtifact(
			cached,
			key,
			receiptId,
			verified.media.sourceId,
			input,
		);
		checkSignal(signal);
		return {
			artifact,
			artifactHash: hashEditingEvidence(artifact),
			cached: true,
		};
	}
	const extracted = await model.extract({ input, signal });
	checkSignal(signal);
	if (hashEditingEvidence(model.identity) !== hashEditingEvidence(key.identity))
		throw new MediaOperationError("STORY_MODEL_CHANGED");
	let graph: StoryGraph;
	try {
		graph = validateStoryGraph({ input, graph: extracted });
	} catch {
		throw new MediaOperationError("STORY_GRAPH_INVALID");
	}
	const proposed: StoryArtifact = {
		version: "aisa-story-artifact-v1",
		identity: key.identity,
		inputHash: key.inputHash,
		graph,
	};
	const artifactHash = hashEditingEvidence(proposed);
	// Receipts are unique by (tenant, kind, proofHash). Bind the wrapper to
	// the source tuple even when two versions have the exact same model artifact.
	const proof: StoryReceiptProof = {
		version: "aisa-story-receipt-v1",
		cacheIdentityHash: cacheIdentityHash(key),
		artifact: proposed,
	};
	return prisma.$transaction(
		async (tx) => {
			await tx.$executeRaw`SELECT pg_advisory_xact_lock(${lockKey(receiptId)})`;
			checkSignal(signal);
			await verifyMediaTaskEvidence(tx, task, verified.binding);
			const fence = () => ({
				id: task.id,
				organizationId: task.organizationId,
				state: "RUNNING",
				leaseToken: options.leaseToken,
				leaseUntil: { gt: now() },
				cancelRequestedAt: null,
			});
			const assertOwned = async () => {
				const changed = await tx.libraryMediaTask.updateMany({
					where: fence(),
					data: { phase: "SELECTING_STORY" },
				});
				if (!changed.count) {
					const current = await tx.libraryMediaTask.findUnique({
						where: { id: task.id },
					});
					throw new MediaOperationError(
						current?.cancelRequestedAt ? "CANCELED" : "LEASE_LOST",
					);
				}
			};
			await assertOwned();
			const winner = await tx.libraryEvidenceReceipt.findUnique({
				where: { id: receiptId },
			});
			if (winner) {
				const artifact = verifiedArtifact(
					winner,
					key,
					receiptId,
					verified.media.sourceId,
					input,
				);
				checkSignal(signal);
				return {
					artifact,
					artifactHash: hashEditingEvidence(artifact),
					cached: true,
				};
			}
			await tx.libraryEvidenceReceipt.create({
				data: {
					id: receiptId,
					organizationId: task.organizationId,
					sourceId: verified.media.sourceId,
					mediaVersionId: task.mediaVersionId,
					analysisRevisionId: task.analysisRevisionId,
					kind: "STORY_GRAPH_V1",
					proof: json(proof),
					proofHash: hashEditingEvidence(proof),
					createdBy: task.createdBy,
				},
			});
			checkSignal(signal);
			await assertOwned();
			return { artifact: proposed, artifactHash, cached: false };
		},
		{ maxWait: 5_000, timeout: 15_000, statementTimeoutMs: 5_000 },
	);
}
