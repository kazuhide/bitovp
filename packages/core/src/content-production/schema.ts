import { z } from "zod";
import {
	canonicalEditingJson,
	editingAnalysisBindingSchema,
} from "../content-editing/automatic-binding";
import { captionAlignmentReceiptSchema } from "../content-editing/caption-alignment";
import { compositionPresentationSchema } from "../content-editing/composition-schema";
import {
	localCaptionModelIdentitySchema,
	localCaptionTranslationResultSchema,
} from "../content-editing/local-caption-translation";
import { isLocalStoryPolicy } from "../content-editing/local-semantic-protocol";
import {
	localStoryEvidenceSchema,
	localStoryModelIdentitySchema,
	localStoryModeSchema,
} from "../content-editing/local-story-contracts";
import { localStoryFlowWorkflowIdentitySchema } from "../content-editing/local-story-flow-contracts";
import {
	isContentHighlightPolicy,
	semanticEvidenceSchema,
} from "../content-editing/semantic-evidence";
import {
	isStoryPolicy,
	storyEvidenceSchema,
	storyModelIdentitySchema,
} from "../content-editing/story-contracts";
import {
	LOCAL_STORY_HIERARCHICAL_WORKFLOW_VERSION,
	resolveLocalStoryWorkflow,
} from "./local-story-workflow";

export const MEDIA_TASK_KINDS = ["TRANSCRIBE", "TRACK", "GENERATE"] as const;
export const MEDIA_TASK_STATES = [
	"PENDING",
	"RUNNING",
	"SUCCEEDED",
	"ERROR",
	"CANCELED",
] as const;
export const DEFAULT_ASR_MODEL_SHA256 =
	"60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe";
export const LOCAL_ASR_ENGINE_VERSION = "1.9.5";
export const LOCAL_TRACKING_ALGORITHM_VERSION = "template-ncc-v2" as const;
export const LOCAL_TRACKING_FRAME_CLOCK_VERSION =
	"cfr30-source-frames-v1" as const;
export const LOCAL_SPEECH_SELECTION_POLICY_VERSION = "asr-boundary-v1" as const;
const language = z.enum(["ja", "en", "auto"]);
const uuid = z.uuid().transform((value) => value.toLowerCase());
const base = { mediaVersionId: uuid, requestKey: uuid };
export const transcriptionTaskParametersSchema = z.strictObject({
	language: language.default("auto"),
	sourceStartUs: z.number().int().min(0).max(3_600_000_000).default(0),
	durationUs: z.number().int().min(1).max(180_000_000).optional(),
});
export const trackingTaskParametersSchema = z.strictObject({
	sceneIds: z.array(uuid).min(1).max(20).optional(),
});
export const generationPresentationSchema = compositionPresentationSchema.omit({
	centerCropConfirmed: true,
});
export const generationTaskParametersSchema = z
	.strictObject({
		contentId: uuid,
		targetDurationFrames: z.number().int().min(30).max(5400),
		renderMode: z.enum(["DRAFT", "EXPORT"]).optional(),
		draftPolicyVersion: z.literal("duration-review-v2").optional(),
		presentation: generationPresentationSchema.optional(),
		policy: z
			.enum(["AUTO", "STORY", "LOCAL_STORY", "COHESION", "DURATION"])
			.default("COHESION"),
		storyMode: localStoryModeSchema.optional(),
		storyPlanner: z.literal("FEASIBLE_CHOICE_V1").optional(),
		storyWorkflowVersion: z
			.literal(LOCAL_STORY_HIERARCHICAL_WORKFLOW_VERSION)
			.optional(),
		query: z.string().trim().max(512).optional(),
		templateId: z
			.enum(["portrait-clean", "landscape-clean", "square-clean"])
			.optional(),
		variants: z.union([z.literal(1), z.literal(2), z.literal(3)]).default(1),
		captions: z.enum(["OFF", "AUTO", "ORIGINAL", "JAPANESE"]).default("OFF"),
		tracking: z.boolean().default(false),
		language: language.default("auto"),
		transcriptionTaskId: uuid.optional(),
		trackingTaskId: uuid.optional(),
	})
	.refine(
		(value) => value.policy === "COHESION" || !value.query,
		"Context query requires the COHESION policy",
	)
	.refine(
		(value) =>
			(value.policy !== "AUTO" &&
				value.policy !== "STORY" &&
				value.policy !== "LOCAL_STORY") ||
			value.query === undefined,
		"Automatic selection does not accept a context query",
	)
	.refine(
		(value) =>
			(value.policy !== "AUTO" &&
				value.policy !== "STORY" &&
				value.policy !== "LOCAL_STORY") ||
			value.renderMode === "DRAFT",
		"Automatic content selection requires an explicit reviewable DRAFT",
	)
	.refine(
		(value) => value.storyMode === undefined || value.policy === "LOCAL_STORY",
		"A local story mode requires the local story policy",
	)
	.refine(
		(value) =>
			value.storyPlanner === undefined ||
			(value.policy === "LOCAL_STORY" &&
				value.renderMode === "DRAFT" &&
				value.storyWorkflowVersion === undefined),
		"A feasible choice planner requires legacy local story DRAFT",
	)
	.refine(
		(value) =>
			value.policy !== "LOCAL_STORY" || value.transcriptionTaskId === undefined,
		"Local story prepares its complete source transcript",
	)
	.refine(
		(value) =>
			value.draftPolicyVersion === undefined || value.renderMode === "DRAFT",
		"A draft duration policy requires an explicit DRAFT intent",
	)
	.refine(
		(value) => value.presentation === undefined || value.renderMode === "DRAFT",
		"Presentation requires an explicit reviewable DRAFT intent",
	)
	.refine((value) => {
		try {
			resolveLocalStoryWorkflow(value);
			return true;
		} catch {
			return false;
		}
	}, "An explicit story workflow requires LOCAL_STORY FLOW DRAFT");
export const mediaTaskCreateSchema = z.discriminatedUnion("kind", [
	z.strictObject({
		...base,
		kind: z.literal("TRANSCRIBE"),
		parameters: transcriptionTaskParametersSchema,
	}),
	z.strictObject({
		...base,
		kind: z.literal("TRACK"),
		analysisRevisionId: uuid,
		parameters: trackingTaskParametersSchema,
	}),
	z.strictObject({
		...base,
		kind: z.literal("GENERATE"),
		analysisRevisionId: uuid,
		parameters: generationTaskParametersSchema,
	}),
]);
export const mediaTaskRetrySchema = z.strictObject({ requestKey: uuid });
export type MediaTaskCreateInput = z.infer<typeof mediaTaskCreateSchema>;
export type GenerationTaskParameters = z.infer<
	typeof generationTaskParametersSchema
>;
export function usesGeneratedCaptions(
	captions: GenerationTaskParameters["captions"],
): boolean {
	return captions !== "OFF";
}
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const mediaTaskIdentitySchema = z.strictObject({
	organizationId: uuid,
	mediaSha256: hash.nullable(),
	modelSha256: hash.nullable(),
	analysisDocumentHash: hash.nullable(),
	analysisRawHash: z.string().max(256).nullable(),
	timeMapHash: hash.nullable(),
	bindingHash: hash.nullable().optional(),
	bindingSnapshot: editingAnalysisBindingSchema.optional(),
	trackingAlgorithmVersion: z
		.enum(["template-ncc-v1", "template-ncc-v2"])
		.optional(),
	trackingFrameClockVersion: z
		.literal(LOCAL_TRACKING_FRAME_CLOCK_VERSION)
		.optional(),
	speechSelectionPolicyVersion: z
		.literal(LOCAL_SPEECH_SELECTION_POLICY_VERSION)
		.optional(),
	preparedShotClock: z
		.strictObject({
			version: z.literal("aisa-prepared-clock-v3"),
			normalizationReceiptHash: hash,
		})
		.optional(),
	storyModel: storyModelIdentitySchema.optional(),
	localStoryModel: localStoryModelIdentitySchema.optional(),
	localStoryWorkflow: localStoryFlowWorkflowIdentitySchema.optional(),
	captionTranslationModel: localCaptionModelIdentitySchema.optional(),
	transcriptionPolicyFingerprint: hash.optional(),
	generationPolicyFingerprint: hash.optional(),
});
export const mediaTaskEnvelopeSchema = z
	.strictObject({
		schemaVersion: z.literal(1),
		input: mediaTaskCreateSchema,
		identity: mediaTaskIdentitySchema,
	})
	.refine(
		(value) =>
			(value.input.kind === "GENERATE" &&
				value.input.parameters.policy === "STORY") ===
			(value.identity.storyModel !== undefined),
		"Only STORY generation requires a pinned story model identity",
	)
	.refine(
		(value) =>
			(value.input.kind === "GENERATE" &&
				value.input.parameters.policy === "LOCAL_STORY") ===
			(value.identity.localStoryModel !== undefined),
		"Only local story generation requires its pinned local model identity",
	)
	.refine(
		(value) =>
			(value.input.kind === "GENERATE" &&
				value.input.parameters.captions === "JAPANESE") ===
			(value.identity.captionTranslationModel !== undefined),
		"Only Japanese captions require a pinned local translation model identity",
	)
	.refine(
		(value) =>
			value.identity.generationPolicyFingerprint === undefined ||
			value.input.kind === "GENERATE",
		"Only GENERATE uses an output-policy fingerprint",
	)
	.refine(
		(value) =>
			(value.input.kind === "GENERATE" &&
				value.input.parameters.storyWorkflowVersion ===
					LOCAL_STORY_HIERARCHICAL_WORKFLOW_VERSION) ===
			Object.hasOwn(value.identity, "localStoryWorkflow"),
		"An explicit story workflow and its pinned identity require each other",
	)
	.refine(
		(value) =>
			!Object.hasOwn(value.identity, "localStoryWorkflow") ||
			(value.identity.localStoryWorkflow !== undefined &&
				value.identity.localStoryModel !== undefined &&
				canonicalEditingJson(value.identity.localStoryWorkflow.baseModel) ===
					canonicalEditingJson(value.identity.localStoryModel)),
		"A story workflow must preserve its exact pinned leaf model identity",
	)
	.refine(
		(value) =>
			value.identity.localStoryWorkflow === undefined ||
			value.identity.generationPolicyFingerprint !== undefined,
		"A pinned story workflow requires its generation-policy fingerprint",
	);
export type MediaTaskIdentity = z.infer<typeof mediaTaskIdentitySchema>;
export type MediaTaskEnvelope = z.infer<typeof mediaTaskEnvelopeSchema>;
export const mediaTaskReceiptSchema = z.object({
	taskId: uuid,
	state: z.enum(MEDIA_TASK_STATES),
	cached: z.boolean(),
});
export const mediaTaskViewSchema = z.object({
	taskId: uuid,
	renderMode: z.enum(["DRAFT", "EXPORT"]).optional(),
	kind: z.enum(MEDIA_TASK_KINDS),
	state: z.enum(MEDIA_TASK_STATES),
	mediaVersionId: uuid,
	analysisRevisionId: uuid.nullable(),
	parentTaskId: uuid.nullable(),
	phase: z.string().max(64),
	progress: z.unknown(),
	result: z.unknown(),
	error: z.string().max(128).nullable(),
	attempts: z.number().int().nonnegative(),
	cached: z.boolean(),
	createdAt: z.iso.datetime(),
	finishedAt: z.iso.datetime().nullable(),
});
export type MediaTaskView = z.infer<typeof mediaTaskViewSchema>;
const sourceUs = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const speechSelectionEvidenceSchema = z
	.strictObject({
		schemaVersion: z.literal(1),
		policyVersion: z.literal(LOCAL_SPEECH_SELECTION_POLICY_VERSION),
		draftPolicyVersion: z.literal("duration-review-v2").optional(),
		status: z.enum(["APPLIED", "FALLBACK"]),
		reason: z
			.enum([
				"ASR_UNAVAILABLE",
				"NO_SPEECH",
				"BOUNDARY_COVERAGE_UNKNOWN",
				"EVIDENCE_LIMIT",
				"SPEECH_REVIEW_REQUIRED",
				"SPEECH_DURATION_REVIEW_REQUIRED",
				"SPEECH_SEARCH_LIMIT_REVIEW_REQUIRED",
			])
			.optional(),
		observedWindow: z
			.strictObject({ fromFrame: sourceUs, toFrame: sourceUs })
			.refine(
				(value) =>
					value.toFrame > value.fromFrame &&
					value.toFrame - value.fromFrame <= 5400,
			)
			.optional(),
		sourceTimeDomain: z.literal("ORIGINAL_PRESENTATION_US"),
		mediaSha256: hash,
		timeMapHash: hash,
		modelSha256: hash.nullable(),
		transcriptFingerprint: hash.optional(),
		intervals: z
			.array(
				z
					.strictObject({ startUs: sourceUs, endUs: sourceUs })
					.refine((value) => value.endUs > value.startUs),
			)
			.max(5000)
			.optional(),
		rejectedBoundaryCount: z.number().int().min(0).max(20_000),
	})
	.superRefine((value, ctx) => {
		const observed = value.observedWindow !== undefined;
		if (
			observed !==
				(value.modelSha256 !== null &&
					value.transcriptFingerprint !== undefined &&
					value.intervals !== undefined) ||
			(!observed &&
				(value.modelSha256 !== null ||
					value.transcriptFingerprint !== undefined ||
					value.intervals !== undefined ||
					value.rejectedBoundaryCount !== 0))
		) {
			ctx.addIssue({
				code: "custom",
				message:
					"Observed speech requires its exact model, window, fingerprint and intervals",
			});
		}
		if (
			value.status === "APPLIED" &&
			(!observed || !value.intervals?.length || value.reason !== undefined)
		)
			ctx.addIssue({
				code: "custom",
				message: "Applied speech selection requires nonempty observed evidence",
			});
		if (
			value.status === "FALLBACK" &&
			(!value.reason ||
				(value.reason === "ASR_UNAVAILABLE" && observed) ||
				(value.reason === "NO_SPEECH" &&
					(!observed || value.intervals?.length !== 0)) ||
				(value.reason === "BOUNDARY_COVERAGE_UNKNOWN" &&
					(!observed || !value.intervals?.length)) ||
				(value.reason === "SPEECH_SEARCH_LIMIT_REVIEW_REQUIRED" &&
					(!observed || !value.intervals?.length)) ||
				(value.reason === "SPEECH_REVIEW_REQUIRED" &&
					(!observed ||
						!value.intervals?.length ||
						value.rejectedBoundaryCount < 1)))
		)
			ctx.addIssue({
				code: "custom",
				message: "Fallback reason must describe the available observations",
			});
		if (
			(value.reason === "SPEECH_DURATION_REVIEW_REQUIRED" &&
				(value.draftPolicyVersion !== "duration-review-v2" ||
					value.status !== "FALLBACK" ||
					!observed ||
					!value.intervals?.length)) ||
			(value.draftPolicyVersion !== undefined &&
				value.reason !== "SPEECH_DURATION_REVIEW_REQUIRED")
		)
			ctx.addIssue({
				code: "custom",
				message:
					"Duration review requires its explicit policy and observed fallback evidence",
			});
		let end = -1;
		for (const interval of value.intervals ?? []) {
			if (interval.startUs <= end)
				ctx.addIssue({
					code: "custom",
					message:
						"Speech intervals must be ordered, disjoint and merged when touching",
				});
			end = interval.endUs;
		}
	});
export type SpeechSelectionEvidence = z.infer<
	typeof speechSelectionEvidenceSchema
>;
export const generationTaskResultSchema = z
	.object({
		generationPolicyFingerprint: hash.optional(),
		projectId: uuid,
		projectIds: z.array(uuid).min(1).max(3),
		renderMode: z.enum(["DRAFT", "EXPORT"]).optional(),
		draftPolicyVersion: z.literal("duration-review-v2").optional(),
		presentation: generationPresentationSchema.optional(),
		requestedFrames: z.number().int().min(30).max(5400),
		actualFrames: z.number().int().positive().max(5400),
		warnings: z.array(z.string().min(1).max(128)).max(100),
		policyVersion: z.enum([
			"aisa-shot-window-v1",
			"aisa-scene-cohesion-v2",
			"aisa-prepared-shot-window-v3",
			"aisa-prepared-scene-cohesion-v3",
			"aisa-content-highlight-v1",
			"aisa-prepared-content-highlight-v4",
			"aisa-story-window-v1",
			"aisa-prepared-story-window-v1",
			"aisa-local-story-window-v1",
			"aisa-prepared-local-story-window-v1",
		]),
		presetIds: z
			.array(z.enum(["portrait-clean", "landscape-clean", "square-clean"]))
			.min(1)
			.max(3),
		metrics: z.record(z.string().max(64), z.number().finite().nonnegative()),
		cacheable: z.boolean(),
		selectionEvidence: speechSelectionEvidenceSchema.optional(),
		semanticEvidence: semanticEvidenceSchema.optional(),
		storyEvidence: storyEvidenceSchema.optional(),
		localStoryEvidence: localStoryEvidenceSchema.optional(),
		captionTranslation: localCaptionTranslationResultSchema.optional(),
		captionAlignment: captionAlignmentReceiptSchema.optional(),
	})
	.refine(
		(value) =>
			isContentHighlightPolicy(value.policyVersion) ===
				(value.semanticEvidence !== undefined) &&
			(!isContentHighlightPolicy(value.policyVersion) ||
				value.renderMode === "DRAFT"),
		"Content selection requires versioned evidence and an explicit DRAFT",
	)
	.refine(
		(value) =>
			isStoryPolicy(value.policyVersion) ===
				(value.storyEvidence !== undefined) &&
			(!isStoryPolicy(value.policyVersion) || value.renderMode === "DRAFT"),
		"Story selection requires model evidence and an explicit DRAFT",
	)
	.refine(
		(value) =>
			isLocalStoryPolicy(value.policyVersion) ===
				(value.localStoryEvidence !== undefined) &&
			(!isLocalStoryPolicy(value.policyVersion) ||
				value.renderMode === "DRAFT"),
		"Local story requires separate model evidence and an explicit DRAFT",
	)
	.refine(
		(value) =>
			value.selectionEvidence?.reason !==
				"SPEECH_SEARCH_LIMIT_REVIEW_REQUIRED" ||
			(value.renderMode === "DRAFT" &&
				(isContentHighlightPolicy(value.policyVersion) ||
					isStoryPolicy(value.policyVersion))),
		"Search-limit speech evidence belongs to an automatic content DRAFT",
	)
	.refine(
		(value) =>
			value.projectId === value.projectIds[0] &&
			new Set(value.projectIds).size === value.projectIds.length &&
			value.projectIds.length === value.presetIds.length &&
			value.actualFrames <= value.requestedFrames,
		"Generation result identity and duration must match",
	)
	.refine(
		(value) =>
			value.selectionEvidence?.reason !== "SPEECH_REVIEW_REQUIRED" ||
			value.renderMode === "DRAFT",
		"Known unsafe speech can only be retained in an explicitly reviewable draft",
	)
	.refine(
		(value) =>
			(value.draftPolicyVersion === undefined ||
				value.renderMode === "DRAFT") &&
			(value.selectionEvidence?.reason !== "SPEECH_DURATION_REVIEW_REQUIRED" ||
				(value.renderMode === "DRAFT" &&
					value.draftPolicyVersion === "duration-review-v2")) &&
			(value.selectionEvidence?.draftPolicyVersion === undefined ||
				value.selectionEvidence.draftPolicyVersion ===
					value.draftPolicyVersion),
		"Duration review evidence requires the matching explicitly versioned DRAFT result",
	)
	.refine(
		(value) => value.presentation === undefined || value.renderMode === "DRAFT",
		"Presentation requires a matching explicit DRAFT result",
	);
export type GenerationTaskResult = z.infer<typeof generationTaskResultSchema>;
export function mediaTaskResultCacheable(value: unknown): boolean {
	return (
		!!value &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		!("cacheable" in value && value.cacheable === false)
	);
}
