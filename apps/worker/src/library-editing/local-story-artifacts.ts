import { createHash } from "node:crypto";
import { canonicalEditingJson, hashEditingEvidence } from "@bitovp/core";
import {
	LocalStoryLegacyArtifactSealError,
	localStoryArtifactCacheHashes,
	readLocalStoryArtifactCacheRow,
} from "@bitovp/core/local-story-flow-server";
import type {
	AppPrismaClient,
	LibraryEvidenceReceipt,
	LibraryMediaTask,
	Prisma,
} from "@bitovp/db";
import { localSemanticJobId } from "./local-semantic-client";
import {
	type VerifiedMediaTask,
	verifyMediaTaskEvidence,
} from "./media-task-execution";
import { MediaOperationError } from "./process";

export type LocalStoryArtifactKind =
	| "LOCAL_STORY_TRANSCRIPT_V1"
	| "LOCAL_STORY_LEDGER_V1"
	| "LOCAL_STORY_BLUEPRINT_V1"
	| "LOCAL_STORY_CHOICE_V1"
	| "LOCAL_CAPTION_TRANSLATION_V1"
	| "LOCAL_FLOW_MANIFEST_V1"
	| "LOCAL_FLOW_CONTEXT_V1"
	| "LOCAL_FLOW_ROUTE_V1"
	| "LOCAL_FLOW_PLAN_V1";
export type LocalStoryArtifactResult<T> = {
	value: T;
	hash: string;
	cached: boolean;
};
export type LocalStoryArtifactStore = {
	load<T>(input: {
		kind: LocalStoryArtifactKind;
		key: unknown;
		parse(value: unknown): T;
		build(): Promise<T>;
		recoverLegacyTranscriptValue?(value: unknown): T;
	}): Promise<LocalStoryArtifactResult<T>>;
};
const kinds = new Set<LocalStoryArtifactKind>([
	"LOCAL_STORY_TRANSCRIPT_V1",
	"LOCAL_STORY_LEDGER_V1",
	"LOCAL_STORY_BLUEPRINT_V1",
	"LOCAL_STORY_CHOICE_V1",
	"LOCAL_CAPTION_TRANSLATION_V1",
	"LOCAL_FLOW_MANIFEST_V1",
	"LOCAL_FLOW_CONTEXT_V1",
	"LOCAL_FLOW_ROUTE_V1",
	"LOCAL_FLOW_PLAN_V1",
]);
const check = (signal: AbortSignal) => {
	if (signal.aborted) throw new MediaOperationError("CANCELED");
};
const json = (value: unknown): Prisma.InputJsonValue =>
	JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const lockKey = (id: string) =>
	BigInt.asIntN(
		64,
		BigInt(
			`0x${createHash("sha256").update(`local-story-artifact:${id}`).digest("hex").slice(0, 16)}`,
		),
	);

/** Immutable intermediate evidence; model/ASR work never holds a database transaction. */
export function createLocalStoryArtifactStore(options: {
	prisma: AppPrismaClient;
	task: LibraryMediaTask;
	verified: VerifiedMediaTask;
	leaseToken: string;
	signal: AbortSignal;
	now?: () => Date;
}): LocalStoryArtifactStore {
	const { prisma, signal, leaseToken } = options;
	const task = structuredClone(options.task),
		media = structuredClone(options.verified.media);
	const binding =
		options.verified.binding && structuredClone(options.verified.binding);
	const taskIdentity = structuredClone(options.verified.envelope.identity);
	const now = options.now ?? (() => new Date());
	if (
		task.organizationId !== media.organizationId ||
		task.mediaVersionId !== media.id ||
		!media.sha256
	)
		throw new MediaOperationError("LOCAL_STORY_ARTIFACT_UNVERIFIED");
	return {
		async load<T>(input: {
			kind: LocalStoryArtifactKind;
			key: unknown;
			parse(value: unknown): T;
			build(): Promise<T>;
			recoverLegacyTranscriptValue?(value: unknown): T;
		}): Promise<LocalStoryArtifactResult<T>> {
			check(signal);
			if (
				!kinds.has(input.kind) ||
				(input.kind !== "LOCAL_STORY_TRANSCRIPT_V1" &&
					(!task.analysisRevisionId || !binding))
			)
				throw new MediaOperationError("LOCAL_STORY_ARTIFACT_UNVERIFIED");
			const analysisRevisionId =
				input.kind === "LOCAL_STORY_TRANSCRIPT_V1"
					? null
					: task.analysisRevisionId;
			let cacheHash: string, inputKeyHash: string;
			try {
				({ cacheHash, inputKeyHash } = localStoryArtifactCacheHashes({
					input,
					task,
					media,
					taskIdentity,
					analysisRevisionId,
				}));
			} catch {
				throw new MediaOperationError("LOCAL_STORY_ARTIFACT_UNVERIFIED");
			}
			const receiptId = localSemanticJobId(
				task.organizationId,
				`artifact:${cacheHash}`,
			);
			const read = (
				row: LibraryEvidenceReceipt,
			): LocalStoryArtifactResult<T> => {
				try {
					return readLocalStoryArtifactCacheRow({
						row,
						input,
						task,
						media,
						analysisRevisionId,
						cacheHash,
						receiptId,
						check: () => check(signal),
					});
				} catch (error) {
					if (error instanceof LocalStoryLegacyArtifactSealError)
						throw new MediaOperationError("LOCAL_STORY_ARTIFACT_UNVERIFIED");
					throw error;
				}
			};
			const cached = await prisma.libraryEvidenceReceipt.findUnique({
				where: { id: receiptId },
			});
			check(signal);
			if (cached) return read(cached);
			const built = await input.build();
			check(signal);
			if (hashEditingEvidence(json(input.key)) !== inputKeyHash)
				throw new MediaOperationError("LOCAL_STORY_ARTIFACT_UNVERIFIED");
			let value: T;
			try {
				value = input.parse(json(built));
			} catch {
				throw new MediaOperationError("LOCAL_STORY_ARTIFACT_UNVERIFIED");
			}
			const proof = {
				version: "local-story-cache-v2",
				cacheHash,
				// Keep every IEEE754 decimal inside a JSON string across Prisma/PG.
				// The wrapper itself has string fields only; cache keys stay unchanged.
				valueJson: canonicalEditingJson(value),
			};
			const hash = hashEditingEvidence(value);
			return prisma.$transaction(
				async (tx) => {
					await tx.$executeRaw`SELECT pg_advisory_xact_lock(${lockKey(receiptId)})`;
					check(signal);
					const current = await verifyMediaTaskEvidence(tx, task, binding);
					if (
						current.media.sourceId !== media.sourceId ||
						current.media.sha256 !== media.sha256 ||
						hashEditingEvidence(current.media.timeMap) !==
							hashEditingEvidence(media.timeMap)
					)
						throw new MediaOperationError("SOURCE_CHANGED");
					const owned = async () => {
						const changed = await tx.libraryMediaTask.updateMany({
							where: {
								id: task.id,
								organizationId: task.organizationId,
								state: "RUNNING",
								leaseToken,
								leaseUntil: { gt: now() },
								cancelRequestedAt: null,
							},
							data: { leaseToken },
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
					await owned();
					const winner = await tx.libraryEvidenceReceipt.findUnique({
						where: { id: receiptId },
					});
					if (winner) return read(winner);
					await tx.libraryEvidenceReceipt.create({
						data: {
							id: receiptId,
							organizationId: task.organizationId,
							sourceId: media.sourceId,
							mediaVersionId: media.id,
							analysisRevisionId,
							kind: input.kind,
							proof: json(proof),
							proofHash: hashEditingEvidence(proof),
							createdBy: task.createdBy,
						},
					});
					check(signal);
					await owned();
					return { value, hash, cached: false };
				},
				{ maxWait: 5_000, timeout: 15_000, statementTimeoutMs: 5_000 },
			);
		},
	};
}
