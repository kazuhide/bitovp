import {
	AutomaticBindingError,
	anyEditingDocumentSchema,
	derivedLibrarySnapshotSchema,
	type EditingObject,
	editingObjectSchema,
	editingRenderProfileSchema,
	verifyAutomaticAnalysisBinding,
} from "@bitovp/core";
import type {
	AppPrismaClient,
	AppTransactionClient,
	Content,
	EditProject,
	EditRevision,
	Prisma,
	RenderRun,
} from "@bitovp/db";

export const LIBRARY_REGISTRATION_PENDING = "LIBRARY_REGISTRATION_PENDING";
const json = (value: unknown): Prisma.InputJsonValue =>
	JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const hashPattern = /^[a-f0-9]{64}$/;

function hasAutomaticPolicy(value: unknown): boolean {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const document = value as Record<string, unknown>;
	if ("autoGeneration" in document) return true;
	return (
		Array.isArray(document.clips) &&
		document.clips.some((clip: unknown) => {
			if (!clip || typeof clip !== "object" || !("framing" in clip))
				return false;
			return (
				Array.isArray(clip.framing) &&
				clip.framing.some(
					(part: unknown) =>
						!!part &&
						typeof part === "object" &&
						"origin" in part &&
						part.origin === "AUTO_POLICY",
				)
			);
		})
	);
}

/** Revalidate before publishing bytes or a Library head, holding proof through commit. */
async function verifyAutomaticArtifactBinding(
	tx: AppTransactionClient,
	run: Pick<RenderRun, "organizationId" | "projectId" | "revisionId"> & {
		project: Pick<EditProject, "id" | "organizationId" | "mediaVersionId">;
		revision: Pick<
			EditRevision,
			"id" | "projectId" | "organizationId" | "document"
		>;
	},
): Promise<void> {
	// Historical manual revisions can contain only locale; retain their admission.
	if (!hasAutomaticPolicy(run.revision.document)) return;
	const parsed = anyEditingDocumentSchema.safeParse(run.revision.document);
	if (!parsed.success || !parsed.data.autoGeneration)
		throw new AutomaticBindingError();
	const binding = parsed.data.autoGeneration.binding;
	const document = parsed.data;
	if (
		run.project.id !== run.projectId ||
		run.revision.id !== run.revisionId ||
		run.revision.projectId !== run.projectId ||
		run.project.organizationId !== run.organizationId ||
		run.revision.organizationId !== run.organizationId ||
		document.mediaVersionId !== run.project.mediaVersionId
	)
		throw new AutomaticBindingError();
	const [media, analysis] = await Promise.all([
		tx.libraryMediaVersion.findUnique({
			where: { id: document.mediaVersionId },
		}),
		tx.sceneAnalysisRevision.findUnique({
			where: { id: binding.analysisRevisionId },
		}),
	]);
	if (media?.state !== "READY" || !analysis) throw new AutomaticBindingError();
	// UPDATE is forbidden, but DELETE remains allowed. Keep the selected proof live
	// until the transaction's artifact/promotion writes have committed or rolled back.
	const proofs = await tx.$queryRaw<Array<{ proof: Prisma.JsonValue }>>`
		SELECT "proof" FROM "LibraryAnalysisBinding"
		WHERE "organizationId" = ${run.organizationId}::uuid
			AND "mediaVersionId" = ${media.id}::uuid
			AND "analysisRevisionId" = ${analysis.id}::uuid
		FOR KEY SHARE`;
	verifyAutomaticAnalysisBinding({
		organizationId: run.organizationId,
		media,
		analysis,
		binding,
		bindings: proofs.map((row) => row.proof),
	});
}

export type EditingArtifactEvidence = {
	storage: EditingObject;
	sha256: string;
	bytes: number;
	probe: Record<string, unknown>;
	recipeHash: string;
};

/** The run fence and immutable artifact are committed together, before Library promotion. */
export async function adoptEditingArtifact(input: {
	prisma: AppPrismaClient;
	runId: string;
	leaseToken: string;
	evidence: EditingArtifactEvidence;
	now?: () => Date;
}): Promise<string | null> {
	const storage = editingObjectSchema.parse(input.evidence.storage);
	if (
		!hashPattern.test(input.evidence.sha256) ||
		!hashPattern.test(input.evidence.recipeHash) ||
		!Number.isSafeInteger(input.evidence.bytes) ||
		input.evidence.bytes < 1 ||
		storage.size !== input.evidence.bytes ||
		!(
			storage.expect?.etag ||
			storage.expect?.versionId ||
			storage.expect?.generation
		)
	)
		throw new Error("INVALID_ARTIFACT_EVIDENCE");
	const now = input.now ?? (() => new Date());
	return input.prisma.$transaction(
		async (tx) => {
			const owned = await tx.renderRun.updateMany({
				where: {
					id: input.runId,
					state: "VALIDATING",
					leaseToken: input.leaseToken,
					leaseUntil: { gt: now() },
					cancelRequestedAt: null,
				},
				data: { error: null },
			});
			if (!owned.count) return null;
			const run = await tx.renderRun.findUnique({
				where: { id: input.runId },
				include: { project: true, revision: true },
			});
			if (!run) throw new Error("RENDER_RUN_MISSING");
			await verifyAutomaticArtifactBinding(tx, run);
			const profile = editingRenderProfileSchema.parse(run.profile);
			const artifact = await tx.renderArtifact.create({
				data: {
					runId: run.id,
					storage: json(storage),
					sha256: input.evidence.sha256,
					size: BigInt(input.evidence.bytes),
					probe: json({
						...input.evidence.probe,
						recipeHash: input.evidence.recipeHash,
					}),
				},
			});
			const completed = await tx.renderRun.updateMany({
				where: {
					id: run.id,
					leaseToken: input.leaseToken,
					state: "VALIDATING",
				},
				data: {
					state: "SUCCEEDED",
					finishedAt: now(),
					leaseToken: null,
					leaseUntil: null,
					pendingArtifactToken: null,
					error:
						profile.kind === "EXPORT" ? LIBRARY_REGISTRATION_PENDING : null,
				},
			});
			if (!completed.count) throw new Error("RENDER_FENCE_LOST");
			return artifact.id;
		},
		{ maxWait: 5_000, timeout: 10_000, statementTimeoutMs: 5_000 },
	);
}

/** A retry of this stage only registers existing bytes; it never renders again. */
export async function promoteEditingArtifact(input: {
	prisma: AppPrismaClient;
	runId: string;
	recipeHash?: string;
}): Promise<boolean> {
	return input.prisma.$transaction(
		async (tx) => {
			const run = await tx.renderRun.findUnique({
				where: { id: input.runId },
				include: {
					artifact: true,
					project: { include: { content: true } },
					revision: true,
				},
			});
			if (run?.state !== "SUCCEEDED" || !run.artifact) return false;
			const profile = editingRenderProfileSchema.parse(run.profile);
			if (profile.kind !== "EXPORT") return false;
			await verifyAutomaticArtifactBinding(tx, run);
			const artifact = run.artifact;
			const storage = editingObjectSchema.parse(artifact.storage);
			const recipeHash =
				input.recipeHash ??
				(artifact.probe as { recipeHash?: string })?.recipeHash;
			if (!recipeHash || !hashPattern.test(recipeHash))
				throw new Error("INVALID_RECIPE_HASH");
			const target = await tx.contentDerivation.findFirst({
				where: { projectId: run.projectId, variant: run.project.variant },
			});
			if (!target) throw new Error("DERIVATIVE_TARGET_MISSING");
			const promoted = await tx.contentDerivation.updateMany({
				where: {
					id: target.id,
					desiredGeneration: run.generation,
					activeGeneration: { lt: run.generation },
				},
				data: {
					activeGeneration: run.generation,
					activeArtifactId: artifact.id,
				},
			});
			if (!promoted.count) {
				await tx.renderRun.updateMany({
					where: { id: run.id, state: "SUCCEEDED" },
					data: { error: null },
				});
				return false;
			}
			const fileKey = `render-${artifact.id}`;
			const snapshot = derivedLibrarySnapshotSchema.parse({
				schemaVersion: 2,
				kind: "DERIVED_RENDER",
				name: run.project.title,
				planHash: recipeHash,
				identity: "VERIFIED",
				inputs: [],
				playbackLinks: [
					{
						key: fileKey,
						kind: "MP4",
						label: run.project.title,
						url: null,
						path: storage.key,
						via: "LOCAL_RENDER",
					},
				],
				fileOutputs: [
					{
						key: fileKey,
						kind: "MP4",
						credentialId: storage.credentialId,
						bucket: storage.bucket,
						path: storage.key,
					},
				],
				renderRunId: run.id,
				renderArtifactId: artifact.id,
				qcVerdict: null,
			});
			const source = await tx.librarySource.upsert({
				where: { renderArtifactId: artifact.id },
				update: {},
				create: {
					sourceKey: `render:${run.organizationId}:${artifact.id}`,
					sourceKind: "DERIVED_RENDER",
					jobId: null,
					originalJobId: null,
					encodingId: null,
					accountId: null,
					renderArtifactId: artifact.id,
					snapshot: json(snapshot),
					locales: [],
					state: "READY",
				},
			});
			let content: Content;
			if (target.derivedContentId) {
				// Metadata edits and media-head promotion serialize on the same Content row.
				await tx.$queryRaw`SELECT "id" FROM "Content" WHERE "id" = ${target.derivedContentId}::uuid FOR UPDATE`;
				const current = await tx.content.findUnique({
					where: { id: target.derivedContentId },
				});
				if (!current) throw new Error("DERIVED_CONTENT_MISSING");
				content = current;
				const advanced = await tx.content.updateMany({
					where: { id: content.id, revision: content.revision },
					data: { revision: { increment: 1 } },
				});
				if (!advanced.count) throw new Error("DERIVED_CONTENT_CONFLICT");
				content = { ...content, revision: content.revision + 1 };
			} else {
				content = await tx.content.create({
					data: {
						registrationKey: `edit:${run.organizationId}:${run.projectId}:${run.project.variant}`,
						title: run.project.title,
						description: run.project.content.description,
						tags: run.project.content.tags,
						locale:
							(run.revision.document as { locale?: string }).locale ??
							run.project.content.locale,
					},
				});
				await tx.contentDerivation.update({
					where: { id: target.id },
					data: { derivedContentId: content.id },
				});
			}
			await tx.contentRevision.create({
				data: {
					contentId: content.id,
					revision: content.revision,
					sourceId: source.id,
					title: content.title,
					description: content.description,
					tags: content.tags,
					locale: content.locale,
					createdBy: run.project.createdBy,
				},
			});
			await tx.renderRun.updateMany({
				where: { id: run.id, state: "SUCCEEDED" },
				data: { error: null },
			});
			return true;
		},
		{ maxWait: 5_000, timeout: 10_000, statementTimeoutMs: 5_000 },
	);
}
