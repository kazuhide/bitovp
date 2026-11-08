import "server-only";
import { createHash, randomUUID } from "node:crypto";
import {
	AutoPortraitSelectionError,
	buildPreparedShotPartition,
	editingDocumentSchema,
	editingMediaStorageSchema,
	originalTimeToCfrFrame,
	PreparedShotClockError,
	type PreparedShotPartition,
	preparedShotFraming,
	sceneAnalysisDocumentSchema,
	selectAutoPortraitClips,
	selectPreparedPortraitClips,
	suggestShotFraming,
	verifyAutomaticAnalysisBinding,
} from "@bitovp/core";
import {
	getPreparedNormalizationReceipt,
	LibraryNormalizationClockError,
} from "@bitovp/db";
import { z } from "zod";
import { requestOrganizationId } from "@/lib/passive-request";
import { getServerContext } from "./context";
import {
	assertEditingBinding,
	EditingRequestError,
	hash,
	json,
} from "./library-editing-common";

const requestSchema = z.strictObject({
	contentId: z.uuid(),
	mediaVersionId: z.uuid(),
	analysisRevisionId: z.uuid(),
	targetDurationFrames: z.number().int().min(30).max(5400),
	requestKey: z.uuid(),
});
// This frozen transport hash preserves same-key replay of existing projects.
// The algorithm used for a new project is recorded separately in its document.
const POLICY = "aisa-shot-window-v1" as const;

/** A database primary key claims the entire intent atomically, across retries. */
function intentProjectId(organizationId: string, requestKey: string) {
	const bytes = createHash("sha256")
		.update(`bitovp:auto-portrait:v1:${organizationId}:${requestKey}`)
		.digest();
	bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x80;
	bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
	const hex = bytes.subarray(0, 16).toString("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function createAutomaticPortrait(
	value: unknown,
	actor: string | null,
) {
	const input = requestSchema.parse(value);
	const ctx = await getServerContext();
	const organizationId = requestOrganizationId(ctx);
	const projectId = intentProjectId(
		organizationId,
		input.requestKey.toLowerCase(),
	);
	const requestHash = hash({
		policyVersion: POLICY,
		contentId: input.contentId.toLowerCase(),
		mediaVersionId: input.mediaVersionId.toLowerCase(),
		analysisRevisionId: input.analysisRevisionId.toLowerCase(),
		targetDurationFrames: input.targetDurationFrames,
	});
	const replay = async () => {
		const row = await ctx.prisma.editProject.findUnique({
			where: { id: projectId },
		});
		if (!row) return null;
		if (row.archived) throw new EditingRequestError(404, "EDIT_NOT_FOUND");
		const document = editingDocumentSchema.parse(row.draft);
		if (document.autoGeneration?.requestHash !== requestHash)
			throw new EditingRequestError(409, "REQUEST_KEY_REUSED");
		return { id: row.id, projectId: row.id };
	};
	const previous = await replay();
	if (previous) return previous;
	try {
		await ctx.prisma.$transaction(async (tx) => {
			const media = await tx.libraryMediaVersion.findUnique({
				where: { id: input.mediaVersionId },
			});
			if (media?.state !== "READY")
				throw new EditingRequestError(422, "MEDIA_NOT_READY");
			const sourceLink = await tx.contentRevision.findFirst({
				where: { contentId: input.contentId, sourceId: media.sourceId },
				include: { content: true },
			});
			if (!sourceLink)
				throw new EditingRequestError(422, "CONTENT_MEDIA_MISMATCH");
			const analysis = await tx.sceneAnalysisRevision.findFirst({
				where: { id: input.analysisRevisionId, sourceId: media.sourceId },
			});
			if (!analysis)
				throw new EditingRequestError(422, "ANALYSIS_BINDING_UNVERIFIED");
			const analysisDocument = sceneAnalysisDocumentSchema.parse(
				analysis.document,
			);
			let binding: ReturnType<typeof verifyAutomaticAnalysisBinding>;
			try {
				const records = await tx.libraryAnalysisBinding.findMany({
					where: { mediaVersionId: media.id, analysisRevisionId: analysis.id },
					take: 26,
				});
				binding = verifyAutomaticAnalysisBinding({
					organizationId,
					media,
					analysis,
					bindings: records.map((record) => record.proof),
				});
			} catch {
				throw new EditingRequestError(422, "ANALYSIS_BINDING_UNVERIFIED");
			}
			let normalization: Awaited<
				ReturnType<typeof getPreparedNormalizationReceipt>
			>;
			try {
				normalization = await getPreparedNormalizationReceipt({
					prisma: tx,
					organizationId,
					media,
				});
			} catch (error) {
				if (error instanceof LibraryNormalizationClockError)
					throw new EditingRequestError(422, error.code);
				throw error;
			}
			let preparedPartition: PreparedShotPartition | undefined;
			let selection:
				| ReturnType<typeof selectAutoPortraitClips>
				| ReturnType<typeof selectPreparedPortraitClips>;
			try {
				if (normalization)
					preparedPartition = buildPreparedShotPartition({
						analysis: analysisDocument,
						timeMap: media.timeMap,
						normalization: normalization.proof,
					});
				selection = preparedPartition
					? selectPreparedPortraitClips({
							partition: preparedPartition,
							targetDurationFrames: input.targetDurationFrames,
							policy: "DURATION",
						})
					: selectAutoPortraitClips({
							analysis: analysisDocument,
							timeMap: media.timeMap,
							targetDurationFrames: input.targetDurationFrames,
						});
			} catch (error) {
				if (error instanceof PreparedShotClockError)
					throw new EditingRequestError(
						422,
						error.message === "PREPARED_CANDIDATE_LIMIT"
							? "AUTO_SELECTION_LIMIT"
							: "NORMALIZATION_EVIDENCE_UNVERIFIED",
					);
				if (error instanceof AutoPortraitSelectionError)
					throw new EditingRequestError(422, error.code);
				if (error instanceof RangeError)
					throw new EditingRequestError(422, "AUTO_SELECTION_LIMIT");
				throw error;
			}
			let timelineStartFrame = 0;
			const reasons = new Set<string>(selection.reasonCodes);
			reasons.add("FIXED_SHOT_FRAMING");
			if (binding.kind === "FIXTURE_AUTHORED") reasons.add("FIXTURE_METADATA");
			const document = editingDocumentSchema.parse({
				schemaVersion: 1,
				mediaVersionId: media.id,
				timeMapId: binding.timeMapId,
				analysisRevisionId: analysis.id,
				locale: analysis.locale,
				sourceTimeDomain: "ORIGINAL_PRESENTATION_US",
				canvas: { width: 1080, height: 1920 },
				fps: { num: 30, den: 1 },
				autoGeneration: {
					policyVersion: selection.policyVersion,
					requestHash,
					requestedDurationFrames: input.targetDurationFrames,
					generatedDurationFrames: selection.actualDurationFrames,
					reasonCodes: [...reasons],
					binding,
					...(normalization
						? { normalizationReceiptHash: normalization.proofHash }
						: {}),
				},
				clips: selection.clips.map((clip) => {
					const shot =
						clip.shotIndex === undefined
							? undefined
							: analysisDocument.scenes.find(
									(entry) => entry.id === clip.sceneId,
								)?.shots[clip.shotIndex];
					const proposed = suggestShotFraming({
						sourceWidth: binding.width,
						sourceHeight: binding.height,
						targetWidth: 1080,
						targetHeight: 1920,
						mainSubjects: shot?.mainSubjects ?? [],
						coordinateSpaceVerified: true,
					});
					const result = {
						id: randomUUID(),
						sourceInUs: clip.sourceInUs,
						durationFrames: clip.durationFrames,
						timelineStartFrame,
						framing: preparedShotFraming({
							partition: preparedPartition,
							sceneId: clip.sceneId,
							shotIndex: clip.shotIndex,
							fromFrame: Number(
								originalTimeToCfrFrame(
									clip.sourceInUs,
									binding.sourceStartUs,
									"FLOOR",
								),
							),
							durationFrames: clip.durationFrames,
							proposal: proposed,
						}),
						audio: { mode: "SOURCE" },
						evidence: {
							sceneId: clip.sceneId,
							...(clip.shotIndex === undefined
								? {}
								: { shotIndex: clip.shotIndex }),
						},
					};
					timelineStartFrame += clip.durationFrames;
					return result;
				}),
			});
			assertEditingBinding(document, media);
			await tx.editProject.create({
				data: {
					id: projectId,
					contentId: input.contentId,
					mediaVersionId: media.id,
					title: `${sourceLink.content.title.slice(0, 450)} (${(input.targetDurationFrames / 30).toFixed(1)}s)`,
					variant: "PORTRAIT",
					draft: json(document),
					createdBy: actor,
				},
			});
			const revision = await tx.editRevision.create({
				data: {
					projectId,
					revision: 1,
					document: json(document),
					createdBy: actor,
				},
			});
			await tx.editProject.update({
				where: { id: projectId },
				data: { currentRevisionId: revision.id },
			});
			await tx.contentDerivation.create({
				data: { projectId, variant: "PORTRAIT", desiredGeneration: 1 },
			});
			const storage = editingMediaStorageSchema.parse(media.storage);
			await tx.renderRun.create({
				data: {
					projectId,
					revisionId: revision.id,
					requestKey: input.requestKey,
					requestHash: hash({ revisionId: revision.id, kind: "EXPORT" }),
					generation: 1,
					profile: json({ kind: "EXPORT" }),
					outputCredentialId: storage.output.credentialId,
					outputBucket: storage.output.bucket,
					outputPrefix: storage.output.prefix,
				},
			});
		});
	} catch (error) {
		if ((error as { code?: string }).code !== "P2002") throw error;
		const existing = await replay();
		if (existing) return existing;
		throw new EditingRequestError(409, "RENDER_REQUEST_CONFLICT");
	}
	return { id: projectId, projectId };
}
