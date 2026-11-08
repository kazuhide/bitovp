import "server-only";
import { createHash } from "node:crypto";
import {
	cfrTimeMapSchema,
	DEFAULT_ASR_MODEL_SHA256,
	GENERATION_POLICY_FINGERPRINT,
	hashEditingEvidence,
	LOCAL_SPEECH_SELECTION_POLICY_VERSION,
	LOCAL_TRACKING_ALGORITHM_VERSION,
	LOCAL_TRACKING_FRAME_CLOCK_VERSION,
	localStoryIdentityForConfiguration,
	MEDIA_TASK_KINDS,
	MEDIA_TASK_STATES,
	type MediaTaskCreateInput,
	MediaTaskDependencyError,
	type MediaTaskIdentity,
	type MediaTaskView,
	mediaTaskCacheKey,
	mediaTaskCreateSchema,
	mediaTaskEnvelopeSchema,
	mediaTaskIntentHash,
	mediaTaskResultCacheable,
	mediaTaskRetrySchema,
	readLocalSemanticConfiguration,
	TRANSCRIPTION_POLICY_FINGERPRINT,
	usesGeneratedCaptions,
	verifyAutomaticAnalysisBinding,
	verifyMediaTaskDependency,
} from "@bitovp/core";
import { readLocalCaptionTranslationSelection } from "@bitovp/core/local-caption-config";
import type {
	AppTransactionClient,
	LibraryMediaTask,
	Prisma,
} from "@bitovp/db";
import {
	getPreparedNormalizationReceipt,
	LibraryNormalizationClockError,
} from "@bitovp/db";
import { z } from "zod";
import { requestOrganizationId } from "@/lib/passive-request";
import { getServerContext } from "./context";
import { EditingRequestError, json } from "./library-editing-common";
import { isLocalStoryChoiceReady } from "./local-story-choice-readiness";

function view(row: LibraryMediaTask): MediaTaskView {
	const envelope =
		row.kind === "GENERATE"
			? mediaTaskEnvelopeSchema.safeParse(row.parameters)
			: undefined;
	const renderMode =
		envelope?.success && envelope.data.input.kind === "GENERATE"
			? envelope.data.input.parameters.renderMode
			: undefined;
	return {
		taskId: row.id,
		kind: z.enum(MEDIA_TASK_KINDS).parse(row.kind),
		state: z.enum(MEDIA_TASK_STATES).parse(row.state),
		mediaVersionId: row.mediaVersionId,
		analysisRevisionId: row.analysisRevisionId,
		parentTaskId: row.parentTaskId,
		phase: row.phase,
		progress: row.progress,
		result: row.result,
		error: row.error,
		attempts: row.attempts,
		cached: row.phase === "CACHED",
		createdAt: row.createdAt.toISOString(),
		finishedAt: row.finishedAt?.toISOString() ?? null,
		...(renderMode ? { renderMode } : {}),
	};
}
const receipt = (row: LibraryMediaTask) => ({
	taskId: row.id,
	state: z.enum(MEDIA_TASK_STATES).parse(row.state),
	cached: row.phase === "CACHED",
});
const lockKey = (value: string) =>
	BigInt.asIntN(
		64,
		BigInt(
			`0x${createHash("sha256").update(value).digest("hex").slice(0, 16)}`,
		),
	);

async function identityFor(
	tx: AppTransactionClient,
	organizationId: string,
	input: MediaTaskCreateInput,
): Promise<MediaTaskIdentity> {
	const media = await tx.libraryMediaVersion.findUnique({
		where: { id: input.mediaVersionId },
	});
	if (!media || media.organizationId !== organizationId)
		throw new EditingRequestError(404, "MEDIA_NOT_FOUND");
	if (!["PENDING", "RUNNING", "READY"].includes(media.state))
		throw new EditingRequestError(422, "MEDIA_PREPARATION_FAILED");
	const usesASR =
		input.kind === "TRANSCRIBE" ||
		(input.kind === "GENERATE" &&
			(usesGeneratedCaptions(input.parameters.captions) ||
				input.parameters.policy === "LOCAL_STORY"));
	const modelSha256 = usesASR
		? (process.env.WHISPER_MODEL_SHA256 ?? DEFAULT_ASR_MODEL_SHA256)
		: null;
	if (modelSha256 && !/^[a-f0-9]{64}$/.test(modelSha256))
		throw new EditingRequestError(503, "ASR_MODEL_UNVERIFIED");
	const identity: MediaTaskIdentity = {
		...(input.kind === "GENERATE"
			? { generationPolicyFingerprint: GENERATION_POLICY_FINGERPRINT }
			: {}),
		organizationId,
		mediaSha256: null,
		modelSha256,
		analysisDocumentHash: null,
		analysisRawHash: null,
		timeMapHash: null,
		bindingHash: null,
		...(usesASR
			? { transcriptionPolicyFingerprint: TRANSCRIPTION_POLICY_FINGERPRINT }
			: {}),
	};
	if (
		input.kind === "GENERATE" &&
		usesGeneratedCaptions(input.parameters.captions) &&
		input.parameters.policy !== "LOCAL_STORY"
	)
		identity.speechSelectionPolicyVersion =
			LOCAL_SPEECH_SELECTION_POLICY_VERSION;
	if (input.kind === "GENERATE" && input.parameters.policy === "LOCAL_STORY") {
		try {
			const config = readLocalSemanticConfiguration(process.env);
			if (!config) throw new Error("disabled");
			identity.localStoryModel = localStoryIdentityForConfiguration(config);
		} catch {
			throw new EditingRequestError(503, "LOCAL_STORY_ENGINE_UNAVAILABLE");
		}
	}
	if (input.kind === "GENERATE" && input.parameters.captions === "JAPANESE") {
		try {
			const config = readLocalSemanticConfiguration(process.env);
			if (!config) throw new Error("disabled");
			identity.captionTranslationModel =
				readLocalCaptionTranslationSelection(config).identity;
		} catch {
			throw new EditingRequestError(
				503,
				"LOCAL_CAPTION_TRANSLATION_UNAVAILABLE",
			);
		}
	}
	if (
		input.kind === "TRACK" ||
		(input.kind === "GENERATE" && input.parameters.tracking)
	) {
		identity.trackingAlgorithmVersion = LOCAL_TRACKING_ALGORITHM_VERSION;
		identity.trackingFrameClockVersion = LOCAL_TRACKING_FRAME_CLOCK_VERSION;
	}
	if (media.state === "READY") {
		const map = cfrTimeMapSchema.safeParse(media.timeMap);
		if (
			!media.sha256 ||
			!/^[a-f0-9]{64}$/.test(media.sha256) ||
			!map.success ||
			map.data.mediaVersionId !== media.id
		)
			throw new EditingRequestError(422, "MEDIA_VERSION_UNVERIFIED");
		identity.mediaSha256 = media.sha256;
		identity.timeMapHash = hashEditingEvidence(media.timeMap);
		if (input.kind === "GENERATE") {
			try {
				const normalization = await getPreparedNormalizationReceipt({
					prisma: tx,
					organizationId,
					media,
				});
				if (normalization)
					identity.preparedShotClock = {
						version: "aisa-prepared-clock-v3",
						normalizationReceiptHash: normalization.proofHash,
					};
			} catch (error) {
				if (error instanceof LibraryNormalizationClockError)
					throw new EditingRequestError(422, error.code);
				throw error;
			}
		}
	}
	if (input.kind !== "TRANSCRIBE") {
		const analysis = await tx.sceneAnalysisRevision.findUnique({
			where: { id: input.analysisRevisionId },
		});
		if (
			!analysis ||
			analysis.organizationId !== organizationId ||
			analysis.sourceId !== media.sourceId
		)
			throw new EditingRequestError(422, "ANALYSIS_BINDING_UNVERIFIED");
		identity.analysisDocumentHash = hashEditingEvidence(analysis.document);
		identity.analysisRawHash = analysis.rawHash;
		if (media.state === "READY") {
			try {
				const rows = await tx.$queryRaw<Array<{ proof: Prisma.JsonValue }>>`
					SELECT "proof" FROM "LibraryAnalysisBinding"
					WHERE "organizationId" = ${organizationId}::uuid AND "mediaVersionId" = ${media.id}::uuid AND "analysisRevisionId" = ${analysis.id}::uuid
					FOR KEY SHARE`;
				identity.bindingSnapshot = verifyAutomaticAnalysisBinding({
					organizationId,
					media,
					analysis,
					bindings: rows.map((row) => row.proof),
				});
				identity.bindingHash = hashEditingEvidence(identity.bindingSnapshot);
			} catch {
				throw new EditingRequestError(422, "ANALYSIS_BINDING_UNVERIFIED");
			}
		}
		if (input.kind === "GENERATE") {
			const contentLink = await tx.contentRevision.findFirst({
				where: {
					contentId: input.parameters.contentId,
					sourceId: media.sourceId,
				},
			});
			if (!contentLink)
				throw new EditingRequestError(422, "CONTENT_MEDIA_MISMATCH");
			for (const [id, kind] of [
				[input.parameters.transcriptionTaskId, "TRANSCRIBE"],
				[input.parameters.trackingTaskId, "TRACK"],
			] as const) {
				if (!id) continue;
				const dependency = await tx.libraryMediaTask.findUnique({
					where: { id },
				});
				try {
					verifyMediaTaskDependency({
						row: dependency,
						kind,
						current: { schemaVersion: 1, input, identity },
						timeMap: media.timeMap,
						analysisDocument: analysis.document,
					});
				} catch (error) {
					throw new EditingRequestError(
						422,
						error instanceof MediaTaskDependencyError
							? error.code
							: "TASK_DEPENDENCY_INVALID",
					);
				}
			}
		}
	}
	return identity;
}

/** Every request key records its own immutable intent, including cache followers. */
export async function createMediaTask(
	value: unknown,
	actor: string | null,
	parentTaskId: string | null = null,
) {
	const requested = mediaTaskCreateSchema.parse(value),
		ctx = await getServerContext(),
		organizationId = requestOrganizationId(ctx);
	const canPin =
		requested.kind === "GENERATE" &&
		requested.parameters.policy === "LOCAL_STORY" &&
		requested.parameters.renderMode === "DRAFT" &&
		requested.parameters.storyWorkflowVersion === undefined;
	const pinned = canPin
		? mediaTaskCreateSchema.parse({
				...requested,
				parameters: {
					...requested.parameters,
					storyPlanner: "FEASIBLE_CHOICE_V1",
				},
			})
		: requested;
	const input =
		canPin && process.env.BITOVP_LOCAL_STORY_CHOICE_ENABLED === "1"
			? pinned
			: requested;
	const requestHash = mediaTaskIntentHash(input, parentTaskId);
	// A server-defaulted planner does not invalidate immutable intent replays.
	const replayHashes = new Set([requestHash]);
	if (
		canPin &&
		requested.kind === "GENERATE" &&
		!requested.parameters.storyPlanner
	) {
		replayHashes.add(mediaTaskIntentHash(requested, parentTaskId));
		replayHashes.add(mediaTaskIntentHash(pinned, parentTaskId));
	}
	if (
		input.kind === "GENERATE" &&
		input.parameters.storyPlanner === "FEASIBLE_CHOICE_V1"
	) {
		const existing = await ctx.prisma.libraryMediaTask.findUnique({
			where: {
				organizationId_requestKey: {
					organizationId,
					requestKey: input.requestKey,
				},
			},
		});
		if (existing) {
			if (!replayHashes.has(existing.requestHash))
				throw new EditingRequestError(409, "REQUEST_KEY_REUSED");
			return receipt(existing);
		}
		// Connectivity checks finish before opening the publication transaction.
		if (
			process.env.BITOVP_LOCAL_STORY_CHOICE_ENABLED !== "1" ||
			!(await isLocalStoryChoiceReady())
		)
			throw new EditingRequestError(503, "LOCAL_STORY_ENGINE_UNAVAILABLE");
	}
	return ctx.prisma.$transaction(
		async (tx) => {
			await tx.$executeRaw`SELECT pg_advisory_xact_lock(${lockKey(`media-task-intent:${organizationId}:${input.requestKey}`)})`;
			const existing = await tx.libraryMediaTask.findUnique({
				where: {
					organizationId_requestKey: {
						organizationId,
						requestKey: input.requestKey,
					},
				},
			});
			if (existing) {
				if (!replayHashes.has(existing.requestHash))
					throw new EditingRequestError(409, "REQUEST_KEY_REUSED");
				return receipt(existing);
			}
			// Historical receipts remain readable; the withdrawn engine creates no new work.
			if (input.kind === "GENERATE" && input.parameters.policy === "STORY")
				throw new EditingRequestError(503, "STORY_ENGINE_UNAVAILABLE");
			const identity = await identityFor(tx, organizationId, input),
				cacheKey = mediaTaskCacheKey(input, identity);
			await tx.$executeRaw`SELECT pg_advisory_xact_lock(${lockKey(`media-task-cache:${organizationId}:${cacheKey}`)})`;
			const cacheStarted = performance.now();
			// Results contain mutable project IDs; only same-key intent replay may reuse GENERATE.
			const candidate =
				input.kind !== "GENERATE" && identity.mediaSha256
					? await tx.libraryMediaTask.findFirst({
							where: {
								organizationId,
								kind: input.kind,
								cacheKey,
								state: "SUCCEEDED",
							},
							orderBy: { createdAt: "desc" },
						})
					: null;
			const cached =
				candidate && mediaTaskResultCacheable(candidate.result)
					? candidate
					: null;
			const cacheLookupMs = Math.round(performance.now() - cacheStarted);
			const parameters = mediaTaskEnvelopeSchema.parse({
				schemaVersion: 1,
				input,
				identity,
			});
			const row = await tx.libraryMediaTask.create({
				data: {
					organizationId,
					mediaVersionId: input.mediaVersionId,
					analysisRevisionId:
						input.kind === "TRANSCRIBE" ? null : input.analysisRevisionId,
					parentTaskId,
					kind: input.kind,
					requestKey: input.requestKey,
					requestHash,
					cacheKey,
					parameters: json(parameters),
					createdBy: actor,
					...(cached
						? {
								state: "SUCCEEDED",
								phase: "CACHED",
								result: cached.result ?? {},
								finishedAt: new Date(),
								progress: json({ cachedFromTaskId: cached.id, cacheLookupMs }),
							}
						: {
								phase: identity.mediaSha256 ? "QUEUED" : "WAITING_FOR_MEDIA",
								progress: json({ cacheLookupMs }),
							}),
				},
			});
			return receipt(row);
		},
		{ maxWait: 5_000, timeout: 15_000, statementTimeoutMs: 5_000 },
	);
}
export async function readMediaTask(id: string): Promise<MediaTaskView> {
	z.uuid().parse(id);
	const ctx = await getServerContext();
	const row = await ctx.prisma.libraryMediaTask.findUnique({ where: { id } });
	if (!row || row.organizationId !== requestOrganizationId(ctx))
		throw new EditingRequestError(404, "TASK_NOT_FOUND");
	return view(row);
}
export async function listMediaTasks(value: unknown) {
	const input = z
		.strictObject({
			mediaVersionId: z.uuid().optional(),
			offset: z.coerce.number().int().min(0).max(100_000).default(0),
		})
		.parse(value);
	const ctx = await getServerContext();
	const rows = await ctx.prisma.libraryMediaTask.findMany({
		where: {
			organizationId: requestOrganizationId(ctx),
			...(input.mediaVersionId ? { mediaVersionId: input.mediaVersionId } : {}),
		},
		orderBy: [{ createdAt: "desc" }, { id: "desc" }],
		skip: input.offset,
		take: 26,
	});
	return { tasks: rows.slice(0, 25).map(view), hasMore: rows.length > 25 };
}
export async function cancelMediaTask(id: string) {
	const ctx = await getServerContext(),
		organizationId = requestOrganizationId(ctx),
		current = new Date();
	z.uuid().parse(id);
	await ctx.prisma.$transaction(async (tx) => {
		await tx.libraryMediaTask.updateMany({
			where: { id, organizationId, state: "PENDING" },
			data: {
				state: "CANCELED",
				phase: "CANCELED",
				cancelRequestedAt: current,
				finishedAt: current,
			},
		});
		await tx.libraryMediaTask.updateMany({
			where: { id, organizationId, state: "RUNNING" },
			data: { cancelRequestedAt: current },
		});
	});
	return readMediaTask(id);
}
export async function retryMediaTask(
	id: string,
	value: unknown,
	actor: string | null,
) {
	const retry = mediaTaskRetrySchema.parse(value),
		ctx = await getServerContext();
	z.uuid().parse(id);
	const row = await ctx.prisma.libraryMediaTask.findUnique({ where: { id } });
	if (!row || row.organizationId !== requestOrganizationId(ctx))
		throw new EditingRequestError(404, "TASK_NOT_FOUND");
	if (row.state !== "ERROR" && row.state !== "CANCELED")
		throw new EditingRequestError(409, "TASK_NOT_RETRYABLE");
	const envelope = mediaTaskEnvelopeSchema.parse(row.parameters);
	return createMediaTask(
		{ ...envelope.input, requestKey: retry.requestKey },
		actor,
		row.id,
	);
}
