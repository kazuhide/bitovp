import { createHash } from "node:crypto";
import {
	applyCompositionTemplate,
	applyTrackedCompositionFraming,
	buildContentHighlightEvidence,
	buildLocalStoryInput,
	buildPreparedShotPartition,
	buildSpeechContextWindow,
	buildStoryModelInput,
	buildStorySelection,
	type CaptionAlignmentReceipt,
	COMPOSITION_TEMPLATE_PRESETS,
	type CompositionSourceFacts,
	type CompositionSourceSegment,
	type CompositionTrackingFallback,
	type CompositionTrackingObservation,
	captionsFromSourceSegments,
	compileComposition,
	compositionDocumentSchema,
	compositionHasUnconfirmedFraming,
	compositionSubjectProtectionContext,
	compositionUsesMainPresentation,
	createCompositionSubjectProtection,
	createPortraitSelectionSearchBudget,
	currentCaptionAlignmentReceiptSchema,
	type DependencySourceClip,
	editingDocumentSchema,
	editingMediaStorageSchema,
	GENERATION_POLICY_FINGERPRINT,
	type GenerationTaskParameters,
	type GenerationTaskResult,
	generationTaskParametersSchema,
	generationTaskResultSchema,
	hashEditingEvidence,
	LOCAL_ASR_ENGINE_VERSION,
	LOCAL_SPEECH_SELECTION_POLICY_VERSION,
	LOCAL_TRACKING_ALGORITHM_VERSION,
	LOCAL_TRACKING_FRAME_CLOCK_VERSION,
	type LocalCaptionModelIdentity,
	type LocalStoryEvidence,
	type LocalStoryModelIdentity,
	localStoryEvidenceSchema,
	matchesFinalCaptionAlignmentMeasurements,
	mediaTaskEnvelopeSchema,
	originalTimeToCfrFrame,
	PreparedShotClockError,
	type PreparedShotPartition,
	preparedShotFraming,
	refinePortraitSelectionBySpeech,
	resolveLocalStorySubjects,
	SpeechBoundarySelectionError,
	type SpeechSelectionEvidence,
	type StoryModelIdentity,
	selectAutoPortraitClips,
	selectContentHighlightClips,
	selectPreparedPortraitClips,
	selectSemanticPortraitClips,
	selectStoryPortraitClips,
	shotCropCandidates,
	speechSelectionEvidenceSchema,
	suggestShotFraming,
	toCompositionDocument,
	usesGeneratedCaptions,
	verifyMediaTaskDependency,
} from "@bitovp/core";
import type { AppPrismaClient, Prisma } from "@bitovp/db";
import {
	type alignSelectedCaptionSegments,
	captionAlignmentInputHash,
} from "./caption-forced-alignment";
import { captionLanguageForSelectedSegments } from "./caption-language";
import { selectedCaptionAudioRanges } from "./caption-source-ranges";
import type { LocalCaptionTranslator } from "./local-caption-translation";
import {
	type LocalStoryEngine,
	type LocalStoryGeneration,
	localStoryArtifactHash,
} from "./local-story-engine";
import type {
	MediaTaskExecutionDependencies,
	VerifiedMediaTask,
} from "./media-task-execution";
import {
	speechSelectionIntentFailureCode,
	verifyMediaTaskEvidence,
} from "./media-task-execution";
import { MediaOperationError } from "./process";
import { loadStoryArtifact, type StoryModel } from "./story-artifact";
import {
	type TrackingShot,
	trackingShotFromAnalysis,
	trackShotSubjects,
} from "./tracking";
import { transcribeLocalAudio } from "./transcription";

type GenerationContext = Parameters<
	NonNullable<MediaTaskExecutionDependencies["generate"]>
>[0];
type Dependencies = {
	prisma: AppPrismaClient;
	model?: { path: string; sha256: string };
	storyModel?: StoryModel;
	localStoryEngine?: LocalStoryEngine;
	captionTranslator?: LocalCaptionTranslator;
	captionAligner?: typeof alignSelectedCaptionSegments;
	ffmpegPath?: string;
	now?: () => Date;
};
const json = (value: unknown): Prisma.InputJsonValue =>
	JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
export function generationObjectId(
	organizationId: string,
	taskId: string,
	label: string,
) {
	const bytes = createHash("sha256")
		.update(`bitovp-generation-v1:${organizationId}:${taskId}:${label}`)
		.digest()
		.subarray(0, 16);
	bytes[6] = ((bytes[6] ?? 0) & 15) | 0x80;
	bytes[8] = ((bytes[8] ?? 0) & 63) | 0x80;
	const hex = bytes.toString("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function matchesStoryResult(
	result: GenerationTaskResult,
	expectedModel: StoryModelIdentity,
) {
	const story = result.storyEvidence;
	// The result schema owns graph and selection validity. Replay additionally
	// binds that validated evidence to its pinned model and exact model artifact.
	return (
		story !== undefined &&
		hashEditingEvidence(story.model) === hashEditingEvidence(expectedModel) &&
		hashEditingEvidence({
			version: "aisa-story-artifact-v1",
			identity: story.model,
			inputHash: story.inputHash,
			graph: story.graph,
		}) === story.artifactHash
	);
}
function matchesLocalStoryEvidence(
	evidence: LocalStoryEvidence | undefined,
	expected: LocalStoryModelIdentity,
) {
	return (
		evidence !== undefined &&
		hashEditingEvidence(evidence.model) === hashEditingEvidence(expected) &&
		hashEditingEvidence(evidence.ledger) === evidence.ledgerHash &&
		hashEditingEvidence(evidence.blueprint) === evidence.blueprintHash &&
		localStoryArtifactHash(evidence) === evidence.artifactHash
	);
}
function resultForRenderMode(
	value: unknown,
	mode: "DRAFT" | "EXPORT" | undefined,
	draftPolicyVersion?: GenerationTaskParameters["draftPolicyVersion"],
	presentation?: GenerationTaskParameters["presentation"],
	expectedAutomaticPolicyVersion?: GenerationTaskResult["policyVersion"],
	expectedStoryModel?: StoryModelIdentity,
	expectedLocalStoryModel?: LocalStoryModelIdentity,
	expectedCaptionTranslationModel?: LocalCaptionModelIdentity,
	expectedGenerationPolicyFingerprint?: string,
): GenerationTaskResult {
	const parsed = generationTaskResultSchema.safeParse(value);
	if (
		!parsed.success ||
		(expectedGenerationPolicyFingerprint !== undefined &&
			parsed.data.generationPolicyFingerprint !==
				expectedGenerationPolicyFingerprint) ||
		(parsed.data.renderMode ?? "EXPORT") !== (mode ?? "EXPORT") ||
		parsed.data.draftPolicyVersion !== draftPolicyVersion ||
		(expectedAutomaticPolicyVersion !== undefined &&
			parsed.data.policyVersion !== expectedAutomaticPolicyVersion) ||
		(expectedStoryModel !== undefined &&
			!matchesStoryResult(parsed.data, expectedStoryModel)) ||
		(expectedLocalStoryModel !== undefined &&
			!matchesLocalStoryEvidence(
				parsed.data.localStoryEvidence,
				expectedLocalStoryModel,
			)) ||
		(expectedCaptionTranslationModel !== undefined &&
			(!parsed.data.captionTranslation ||
				hashEditingEvidence(parsed.data.captionTranslation.model) !==
					hashEditingEvidence(expectedCaptionTranslationModel))) ||
		hashEditingEvidence(parsed.data.presentation ?? null) !==
			hashEditingEvidence(presentation ?? null)
	)
		throw new MediaOperationError("TASK_RESULT_UNVERIFIED");
	return parsed.data;
}
function checkSignal(signal: AbortSignal) {
	if (signal.aborted)
		throw signal.reason ?? new MediaOperationError("CANCELED");
}
function resultObject(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new MediaOperationError("TASK_RESULT_UNVERIFIED");
	return value as Record<string, unknown>;
}
async function referencedResult(
	deps: Dependencies,
	id: string,
	kind: "TRANSCRIBE" | "TRACK",
	verified: VerifiedMediaTask,
	requiredClips: readonly DependencySourceClip[],
	requiredTranscriptWindow?: { fromFrame: number; toFrame: number },
) {
	const row = await deps.prisma.libraryMediaTask.findUnique({ where: { id } });
	return verifyMediaTaskDependency({
		row,
		kind,
		current: verified.envelope,
		timeMap: verified.map,
		analysisDocument: verified.analysisDocument,
		requiredClips,
		...(requiredTranscriptWindow ? { requiredTranscriptWindow } : {}),
	});
}

/** The callback's publication transaction also completes its task: one durable result. */
export function createLibraryGenerationHandler(deps: Dependencies) {
	const now = deps.now ?? (() => new Date());
	return async (context: GenerationContext): Promise<GenerationTaskResult> => {
		checkSignal(context.signal);
		const task = await deps.prisma.libraryMediaTask.findUnique({
			where: { id: context.taskId },
		});
		if (
			!task ||
			task.organizationId !== context.organizationId ||
			task.kind !== "GENERATE"
		)
			throw new MediaOperationError("TASK_NOT_FOUND");
		const envelope = mediaTaskEnvelopeSchema.parse(task.parameters),
			parameters = generationTaskParametersSchema.parse(context.parameters);
		const expectedAutomaticPolicyVersion =
			parameters.policy === "LOCAL_STORY"
				? envelope.identity.preparedShotClock
					? "aisa-prepared-local-story-window-v1"
					: "aisa-local-story-window-v1"
				: parameters.policy === "STORY"
					? envelope.identity.preparedShotClock
						? "aisa-prepared-story-window-v1"
						: "aisa-story-window-v1"
					: parameters.policy === "AUTO"
						? envelope.identity.preparedShotClock
							? "aisa-prepared-content-highlight-v4"
							: "aisa-content-highlight-v1"
						: undefined;
		const expectedStoryModel =
			parameters.policy === "STORY" ? envelope.identity.storyModel : undefined;
		const expectedLocalStoryModel =
			parameters.policy === "LOCAL_STORY"
				? envelope.identity.localStoryModel
				: undefined;
		const expectedCaptionTranslationModel =
			parameters.captions === "JAPANESE"
				? envelope.identity.captionTranslationModel
				: undefined;
		const expectedGenerationPolicyFingerprint =
			envelope.identity.generationPolicyFingerprint;
		if (
			envelope.input.kind !== "GENERATE" ||
			hashEditingEvidence(parameters) !==
				hashEditingEvidence(envelope.input.parameters) ||
			context.mediaVersionId !== task.mediaVersionId ||
			context.analysisRevisionId !== task.analysisRevisionId
		)
			throw new MediaOperationError("TASK_INTENT_INVALID");
		if (parameters.policy === "LOCAL_STORY" && !expectedLocalStoryModel)
			throw new MediaOperationError("LOCAL_STORY_MODEL_CHANGED");
		if (task.state === "SUCCEEDED")
			return resultForRenderMode(
				task.result,
				parameters.renderMode,
				parameters.draftPolicyVersion,
				parameters.presentation,
				expectedAutomaticPolicyVersion,
				expectedStoryModel,
				expectedLocalStoryModel,
				expectedCaptionTranslationModel,
				expectedGenerationPolicyFingerprint,
			);
		if (expectedGenerationPolicyFingerprint !== GENERATION_POLICY_FINGERPRINT)
			throw new MediaOperationError("GENERATION_POLICY_CHANGED");
		if (parameters.captions === "JAPANESE") {
			if (!deps.captionTranslator)
				throw new MediaOperationError("LOCAL_CAPTION_TRANSLATION_UNAVAILABLE");
			if (
				!expectedCaptionTranslationModel ||
				hashEditingEvidence(deps.captionTranslator.identity) !==
					hashEditingEvidence(expectedCaptionTranslationModel)
			)
				throw new MediaOperationError("LOCAL_CAPTION_MODEL_CHANGED");
		}
		if (parameters.policy === "STORY") {
			if (!expectedStoryModel)
				throw new MediaOperationError("STORY_MODEL_UNVERIFIED");
			if (!deps.storyModel)
				throw new MediaOperationError("STORY_ENGINE_UNAVAILABLE");
			if (
				hashEditingEvidence(expectedStoryModel) !==
				hashEditingEvidence(deps.storyModel.identity)
			)
				throw new MediaOperationError("STORY_MODEL_CHANGED");
		}
		if (parameters.policy === "LOCAL_STORY") {
			if (!deps.localStoryEngine)
				throw new MediaOperationError("LOCAL_STORY_ENGINE_UNAVAILABLE");
			if (
				hashEditingEvidence(expectedLocalStoryModel) !==
				hashEditingEvidence(deps.localStoryEngine.identity)
			)
				throw new MediaOperationError("LOCAL_STORY_MODEL_CHANGED");
		}
		if (
			parameters.tracking &&
			(envelope.identity.trackingAlgorithmVersion ?? "template-ncc-v1") !==
				LOCAL_TRACKING_ALGORITHM_VERSION
		)
			throw new MediaOperationError("TRACKING_ALGORITHM_CHANGED");
		if (
			parameters.tracking &&
			envelope.identity.trackingFrameClockVersion !==
				LOCAL_TRACKING_FRAME_CLOCK_VERSION
		)
			throw new MediaOperationError("TRACKING_FRAME_CLOCK_CHANGED");
		const speechFailure = speechSelectionIntentFailureCode(envelope);
		if (speechFailure) throw new MediaOperationError(speechFailure);
		if (task.cancelRequestedAt) throw new MediaOperationError("CANCELED");
		if (
			task.state !== "RUNNING" ||
			task.leaseToken !== context.leaseToken ||
			!task.leaseUntil ||
			task.leaseUntil <= now()
		)
			throw new MediaOperationError("LEASE_LOST");
		const verified = await deps.prisma.$transaction((tx) =>
			verifyMediaTaskEvidence(tx, task),
		);
		const analysis = verified.analysisDocument,
			binding = verified.binding;
		if (!analysis || !binding || !verified.media.sha256)
			throw new MediaOperationError("ANALYSIS_BINDING_UNVERIFIED");
		const link = await deps.prisma.contentRevision.findFirst({
			where: {
				contentId: parameters.contentId,
				sourceId: verified.media.sourceId,
			},
			include: { content: true },
		});
		if (!link) throw new MediaOperationError("CONTENT_MEDIA_MISMATCH");
		const warnings = new Set<string>(),
			metrics: Record<string, number> = {};
		let cacheable = true;
		if (binding.kind === "FIXTURE_AUTHORED") warnings.add("FIXTURE_METADATA");
		if (binding.kind === "EDITOR_ATTESTED")
			warnings.add("EDITOR_ATTESTED_ASSOCIATION");
		await context.onProgress(
			parameters.policy === "LOCAL_STORY"
				? "ANALYZING_LOCAL_STORY"
				: parameters.policy === "STORY"
					? "ANALYZING_STORY"
					: "SELECTING_SHOTS",
		);
		const selectorInput = {
			analysis,
			timeMap: verified.media.timeMap,
			targetDurationFrames: parameters.targetDurationFrames,
			...(usesGeneratedCaptions(parameters.captions)
				? { searchBudget: createPortraitSelectionSearchBudget() }
				: {}),
		};
		let preparedPartition: PreparedShotPartition | undefined;
		try {
			if (verified.preparedNormalization)
				preparedPartition = buildPreparedShotPartition({
					analysis,
					timeMap: verified.map,
					normalization: verified.preparedNormalization.proof,
				});
		} catch (error) {
			if (error instanceof PreparedShotClockError)
				throw new MediaOperationError(
					error.message === "PREPARED_CANDIDATE_LIMIT"
						? "AUTO_SELECTION_LIMIT"
						: "NORMALIZATION_EVIDENCE_UNVERIFIED",
				);
			throw error;
		}
		const probe = resultObject(verified.media.probe),
			streams = Array.isArray(probe.streams) ? probe.streams : [];
		const hasAudio = streams.some(
			(stream: unknown) =>
				!!stream &&
				typeof stream === "object" &&
				"codec_type" in stream &&
				stream.codec_type === "audio",
		);
		let storyArtifact:
			| Awaited<ReturnType<typeof loadStoryArtifact>>
			| undefined;
		let story:
			| {
					input: ReturnType<typeof buildStoryModelInput>;
					graph: Awaited<ReturnType<StoryModel["extract"]>>;
			  }
			| undefined;
		if (parameters.policy === "STORY") {
			if (!deps.storyModel)
				throw new MediaOperationError("STORY_ENGINE_UNAVAILABLE");
			const started = performance.now();
			const input = buildStoryModelInput({ analysis, timeMap: verified.map });
			storyArtifact = await loadStoryArtifact({
				prisma: deps.prisma,
				task,
				verified,
				leaseToken: context.leaseToken,
				input,
				model: deps.storyModel,
				signal: context.signal,
				now,
			});
			story = { input, graph: storyArtifact.artifact.graph };
			metrics.storyAnalysisMs = Math.round(performance.now() - started);
			metrics.storyArtifactCached = storyArtifact.cached ? 1 : 0;
			await context.onProgress("SELECTING_STORY");
		}
		const selectionStarted = performance.now();
		let localStory: LocalStoryGeneration | undefined;
		type LegacySelection =
			| ReturnType<typeof selectPreparedPortraitClips>
			| ReturnType<typeof selectAutoPortraitClips>
			| ReturnType<typeof selectContentHighlightClips>
			| ReturnType<typeof selectSemanticPortraitClips>
			| ReturnType<typeof selectStoryPortraitClips>;
		let selection: LegacySelection | LocalStoryGeneration["selection"];
		if (parameters.policy === "LOCAL_STORY") {
			if (!deps.localStoryEngine || !expectedLocalStoryModel)
				throw new MediaOperationError("LOCAL_STORY_ENGINE_UNAVAILABLE");
			localStory = await deps.localStoryEngine.plan({
				task,
				verified,
				parameters,
				leaseToken: context.leaseToken,
				sourcePath: context.sourcePath,
				hasAudio,
				preparedPartition,
				signal: context.signal,
				onProgress: context.onProgress,
			});
			checkSignal(context.signal);
			if (
				hashEditingEvidence(deps.localStoryEngine.identity) !==
				hashEditingEvidence(expectedLocalStoryModel)
			)
				throw new MediaOperationError("LOCAL_STORY_MODEL_CHANGED");
			const evidence = localStoryEvidenceSchema.safeParse(localStory.evidence);
			if (
				!evidence.success ||
				!matchesLocalStoryEvidence(evidence.data, expectedLocalStoryModel) ||
				localStory.selection.policyVersion !== expectedAutomaticPolicyVersion ||
				hashEditingEvidence(evidence.data.selection) !==
					hashEditingEvidence(localStory.selection.localStorySelection)
			)
				throw new MediaOperationError("TASK_RESULT_UNVERIFIED");
			localStory.evidence = evidence.data;
			selection = localStory.selection;
			for (const warning of localStory.warnings) warnings.add(warning);
			Object.assign(metrics, localStory.metrics);
			metrics.localStoryTotalMs = Math.round(
				performance.now() - selectionStarted,
			);
		} else
			selection = preparedPartition
				? selectPreparedPortraitClips({
						partition: preparedPartition,
						targetDurationFrames: parameters.targetDurationFrames,
						policy: parameters.policy,
						query: parameters.query,
						searchBudget: selectorInput.searchBudget,
						...(story ? { story } : {}),
					})
				: story
					? selectStoryPortraitClips({ ...selectorInput, story })
					: parameters.policy === "DURATION"
						? selectAutoPortraitClips(selectorInput)
						: parameters.policy === "AUTO"
							? selectContentHighlightClips(selectorInput)
							: selectSemanticPortraitClips({
									...selectorInput,
									query: parameters.query,
								});
		if (!localStory)
			metrics.selectionMs = Math.round(performance.now() - selectionStarted);
		const sources: CompositionSourceFacts[] = [
			{
				mediaVersionId: verified.media.id,
				timeMap: verified.map,
				width: binding.width,
				height: binding.height,
				hasAudio,
			},
		];
		let segments: CompositionSourceSegment[] =
				usesGeneratedCaptions(parameters.captions) && localStory
					? localStory.segments
					: [],
			observations: CompositionTrackingObservation[] = [],
			fallbacks: CompositionTrackingFallback[] = [];
		let captionLanguage = localStory?.transcriptLanguage;
		let selectionEvidence: SpeechSelectionEvidence | undefined;
		if (
			usesGeneratedCaptions(parameters.captions) &&
			parameters.policy !== "LOCAL_STORY"
		) {
			if ("localStorySelection" in selection)
				throw new MediaOperationError("TASK_INTENT_INVALID");
			const searchBudget = selectorInput.searchBudget;
			if (!searchBudget) throw new MediaOperationError("TASK_INTENT_INVALID");
			const speechContext = buildSpeechContextWindow({
				selection,
				timeMap: verified.map,
			});
			let observedModelSha256: string | null = null;
			let transcriptFingerprint: string | undefined;
			if (parameters.transcriptionTaskId) {
				const result = await referencedResult(
					deps,
					parameters.transcriptionTaskId,
					"TRANSCRIBE",
					verified,
					selection.clips,
					speechContext,
				);
				if (result.kind !== "TRANSCRIBE")
					throw new MediaOperationError("TASK_DEPENDENCY_INVALID");
				segments = result.result.segments;
				captionLanguage = result.result.language;
				observedModelSha256 = result.result.modelSha256;
				transcriptFingerprint = hashEditingEvidence({
					taskId: parameters.transcriptionTaskId,
					cacheKey: result.result.cacheKey,
					parameters: result.envelope.input.parameters,
					segments: segments.map(({ startUs, endUs }) => ({ startUs, endUs })),
				});
				for (const warning of result.result.warnings) warnings.add(warning);
			} else if (!hasAudio) warnings.add("SOURCE_HAS_NO_AUDIO");
			else if (!deps.model?.path) {
				warnings.add("ASR_MODEL_NOT_CONFIGURED");
				cacheable = false;
			} else {
				if (deps.model.sha256 !== envelope.identity.modelSha256)
					throw new MediaOperationError("ASR_MODEL_CHANGED");
				await context.onProgress("TRANSCRIBING");
				const started = performance.now();
				try {
					const result = await transcribeLocalAudio({
						sourcePath: context.sourcePath,
						mediaSha256: verified.media.sha256,
						sourceStartUs: speechContext.mediaStartUs,
						durationUs: speechContext.durationUs,
						language: parameters.language,
						model: deps.model,
						ffmpegPath: deps.ffmpegPath,
						signal: context.signal,
					});
					if (
						envelope.identity.transcriptionPolicyFingerprint !== undefined &&
						result.qualityPolicyFingerprint !==
							envelope.identity.transcriptionPolicyFingerprint
					)
						throw new MediaOperationError("ASR_QUALITY_POLICY_CHANGED");
					const origin = verified.map.sourceStartUs;
					captionLanguage = result.language;
					segments = result.segments.map((segment) => ({
						...segment,
						startUs: segment.startUs + origin,
						endUs: segment.endUs + origin,
						...(segment.words
							? {
									words: segment.words.map((word) => ({
										...word,
										startUs: word.startUs + origin,
										endUs: word.endUs + origin,
									})),
								}
							: {}),
					}));
					observedModelSha256 = deps.model.sha256;
					transcriptFingerprint = hashEditingEvidence({
						engineVersion: LOCAL_ASR_ENGINE_VERSION,
						mediaSha256: verified.media.sha256,
						modelSha256: observedModelSha256,
						cacheKey: result.cacheKey ?? null,
						window: speechContext,
						segments: segments.map(({ startUs, endUs }) => ({
							startUs,
							endUs,
						})),
					});
					for (const warning of result.warnings) warnings.add(warning);
				} catch (error) {
					if (
						error instanceof MediaOperationError &&
						[
							"TRANSCRIPT_INVALID",
							"TRANSCRIPT_LIMIT",
							"ASR_AUDIO_INVALID",
							"ASR_VERSION_MISMATCH",
						].includes(error.code)
					) {
						warnings.add(error.code);
						cacheable = false;
					} else throw error;
				} finally {
					metrics.transcriptionMs = Math.round(performance.now() - started);
				}
			}
			checkSignal(context.signal);
			const evidenceBase = {
				schemaVersion: 1 as const,
				policyVersion: LOCAL_SPEECH_SELECTION_POLICY_VERSION,
				sourceTimeDomain: "ORIGINAL_PRESENTATION_US" as const,
				mediaSha256: verified.media.sha256,
				timeMapHash: hashEditingEvidence(verified.map),
				modelSha256: observedModelSha256,
			};
			if (observedModelSha256 !== null && transcriptFingerprint) {
				await context.onProgress("REFINING_SELECTION");
				const started = performance.now();
				try {
					const refined = refinePortraitSelectionBySpeech({
						...selectorInput,
						searchBudget,
						policy: parameters.policy,
						query: parameters.query,
						anchor: selection,
						context: speechContext,
						segments,
						preparedPartition,
						...(story ? { story } : {}),
					});
					// Integer cross-multiplication keeps exactly 90% on the safe branch.
					const reviewDuration =
						parameters.renderMode === "DRAFT" &&
						parameters.draftPolicyVersion === "duration-review-v2" &&
						refined.selection.actualDurationFrames * 10 <
							selection.actualDurationFrames * 9;
					if (reviewDuration) warnings.add("SPEECH_DURATION_REVIEW_REQUIRED");
					else selection = refined.selection;
					selectionEvidence = speechSelectionEvidenceSchema.parse({
						...evidenceBase,
						...(reviewDuration
							? {
									status: "FALLBACK",
									reason: "SPEECH_DURATION_REVIEW_REQUIRED",
									draftPolicyVersion: parameters.draftPolicyVersion,
								}
							: {
									status: refined.status,
									...(refined.reason ? { reason: refined.reason } : {}),
								}),
						observedWindow: {
							fromFrame: speechContext.fromFrame,
							toFrame: speechContext.toFrame,
						},
						transcriptFingerprint,
						intervals: refined.intervals,
						rejectedBoundaryCount: refined.rejectedBoundaryCount,
					});
				} catch (error) {
					if (error instanceof SpeechBoundarySelectionError) {
						const reviewReason =
							error.code === "NO_SPEECH_SAFE_WINDOW"
								? "SPEECH_REVIEW_REQUIRED"
								: (parameters.policy === "AUTO" ||
											parameters.policy === "STORY") &&
										error.code === "SPEECH_SELECTION_SEARCH_LIMIT"
									? "SPEECH_SEARCH_LIMIT_REVIEW_REQUIRED"
									: undefined;
						if (
							parameters.renderMode === "DRAFT" &&
							reviewReason &&
							error.evidence
						) {
							selectionEvidence = speechSelectionEvidenceSchema.parse({
								...evidenceBase,
								status: "FALLBACK",
								reason: reviewReason,
								observedWindow: {
									fromFrame: speechContext.fromFrame,
									toFrame: speechContext.toFrame,
								},
								transcriptFingerprint,
								intervals: error.evidence.intervals,
								rejectedBoundaryCount: error.evidence.rejectedBoundaryCount,
							});
							warnings.add(reviewReason);
						} else throw new MediaOperationError(error.code);
					} else throw error;
				} finally {
					metrics.speechRefinementMs = Math.round(performance.now() - started);
				}
				metrics.speechObservedFrames =
					speechContext.toFrame - speechContext.fromFrame;
				if (
					speechContext.clipped &&
					speechContext.toFrame - speechContext.fromFrame === 5400
				)
					warnings.add("SPEECH_CONTEXT_LIMIT");
			} else
				selectionEvidence = speechSelectionEvidenceSchema.parse({
					...evidenceBase,
					status: "FALLBACK",
					reason: "ASR_UNAVAILABLE",
					rejectedBoundaryCount: 0,
				});
			if (selectionEvidence.status === "FALLBACK")
				warnings.add("SPEECH_SELECTION_FALLBACK");
			metrics.speechSearchExpansions = searchBudget.usedExpansions;
			checkSignal(context.signal);
		}
		// Speech safety may select a different whole-shot window. Persist the
		// rationale for the final clips, rather than the original ranked anchor.
		const semanticEvidence =
			parameters.policy === "AUTO"
				? buildContentHighlightEvidence({
						analysis,
						clips: selection.clips,
						...("semanticEvidence" in selection && selection.semanticEvidence
							? {
									selectionReason: selection.semanticEvidence.selectionReason,
								}
							: {}),
					})
				: undefined;
		const storyEvidence =
			story && storyArtifact
				? {
						version: "aisa-story-evidence-v1" as const,
						method: "MODEL_EVENT_GRAPH" as const,
						model: storyArtifact.artifact.identity,
						inputHash: storyArtifact.artifact.inputHash,
						artifactHash: storyArtifact.artifactHash,
						graph: story.graph,
						selection: buildStorySelection({
							...story,
							clips: selection.clips,
							...("storySelection" in selection &&
							selection.storySelection?.reason === "SEARCH_BUDGET"
								? { reason: "SEARCH_BUDGET" as const }
								: {}),
						}),
						inputCoverage: story.input.coverage,
					}
				: undefined;
		const localStoryEvidence = localStory?.evidence;
		const subjectTargets = localStory
			? resolveLocalStorySubjects({
					analysis,
					input: buildLocalStoryInput({
						analysis,
						timeMap: verified.map,
						preparedPartition,
						segments: localStory.segments,
					}),
					ledger: localStory.evidence.ledger,
					selection: localStory.evidence.selection,
					geometry: {
						sourceWidth: binding.width,
						sourceHeight: binding.height,
						targetWidth: 1080,
						targetHeight: 1920,
					},
				})
			: [];
		const subjectTarget = (sceneId: string, shotIndex: number | undefined) =>
			subjectTargets.find(
				(target) =>
					target.sceneId === sceneId && target.shotIndex === shotIndex,
			);
		const targetSeeds = new Map<string, number>();
		if (localStory) {
			metrics.localStorySubjectTargetsResolved = subjectTargets.filter(
				(target) => target.decision === "CROP",
			).length;
			metrics.localStorySubjectTargetsFit = subjectTargets.filter(
				(target) => target.decision === "FIT",
			).length;
		}
		let cursor = 0;
		const base = editingDocumentSchema.parse({
			schemaVersion: 1,
			mediaVersionId: verified.media.id,
			timeMapId: verified.map.id,
			analysisRevisionId: task.analysisRevisionId,
			locale: binding.locale,
			sourceTimeDomain: "ORIGINAL_PRESENTATION_US",
			canvas: { width: 1080, height: 1920 },
			fps: { num: 30, den: 1 },
			autoGeneration: {
				...(parameters.policy === "AUTO" ||
				parameters.policy === "STORY" ||
				parameters.policy === "LOCAL_STORY"
					? { renderMode: "DRAFT" }
					: {}),
				...(parameters.draftPolicyVersion
					? {
							renderMode: "DRAFT",
							draftPolicyVersion: parameters.draftPolicyVersion,
						}
					: {}),
				policyVersion: selection.policyVersion,
				requestHash: task.requestHash,
				requestedDurationFrames: parameters.targetDurationFrames,
				generatedDurationFrames: selection.actualDurationFrames,
				reasonCodes: [
					...selection.reasonCodes,
					"FIXED_SHOT_FRAMING",
					...(selectionEvidence?.reason === "SPEECH_REVIEW_REQUIRED" ||
					selectionEvidence?.reason === "SPEECH_DURATION_REVIEW_REQUIRED" ||
					selectionEvidence?.reason === "SPEECH_SEARCH_LIMIT_REVIEW_REQUIRED"
						? [selectionEvidence.reason]
						: []),
				],
				...(semanticEvidence ? { semanticEvidence } : {}),
				...(storyEvidence ? { storyEvidence } : {}),
				...(localStoryEvidence ? { localStoryEvidence } : {}),
				binding,
				...(preparedPartition
					? {
							normalizationReceiptHash:
								preparedPartition.normalizationReceiptHash,
						}
					: {}),
				...(parameters.policy === "COHESION" && parameters.query
					? { query: parameters.query }
					: {}),
			},
			clips: selection.clips.map((clip, index) => {
				const shot =
					clip.shotIndex === undefined
						? undefined
						: analysis.scenes.find((scene) => scene.id === clip.sceneId)?.shots[
								clip.shotIndex
							];
				const target = subjectTarget(clip.sceneId, clip.shotIndex);
				const proposal =
					target?.decision === "CROP" && target.proposal
						? target.proposal
						: suggestShotFraming({
								sourceWidth: binding.width,
								sourceHeight: binding.height,
								targetWidth: 1080,
								targetHeight: 1920,
								mainSubjects: localStory ? [] : (shot?.mainSubjects ?? []),
								coordinateSpaceVerified: true,
							});
				const result = {
					id: generationObjectId(task.organizationId, task.id, `clip:${index}`),
					sourceInUs: clip.sourceInUs,
					durationFrames: clip.durationFrames,
					timelineStartFrame: cursor,
					framing: preparedShotFraming({
						partition: preparedPartition,
						sceneId: clip.sceneId,
						shotIndex: clip.shotIndex,
						fromFrame: Number(
							originalTimeToCfrFrame(
								clip.sourceInUs,
								verified.map.sourceStartUs,
								"FLOOR",
							),
						),
						durationFrames: clip.durationFrames,
						proposal,
					}),
					audio: { mode: hasAudio ? "SOURCE" : "MUTE" },
					evidence: {
						sceneId: clip.sceneId,
						...(clip.shotIndex === undefined
							? {}
							: { shotIndex: clip.shotIndex }),
					},
				};
				cursor += clip.durationFrames;
				return result;
			}),
		});
		if (parameters.tracking) {
			// A historical generic TRACK result cannot prove it followed this selected target.
			if (localStory && parameters.trackingTaskId)
				throw new MediaOperationError("TASK_DEPENDENCY_INVALID");
			if (parameters.trackingTaskId) {
				const result = await referencedResult(
					deps,
					parameters.trackingTaskId,
					"TRACK",
					verified,
					selection.clips,
				);
				if (result.kind !== "TRACK")
					throw new MediaOperationError("TASK_DEPENDENCY_INVALID");
				observations = result.result.observations;
				fallbacks = result.result.fallbacks;
			} else {
				const origin = verified.map.sourceStartUs;
				const shots: TrackingShot[] = selection.clips.flatMap((clip) => {
					if (clip.shotIndex === undefined) return [];
					const target = subjectTarget(clip.sceneId, clip.shotIndex);
					if (localStory && target?.decision !== "CROP") return [];
					const shot = analysis.scenes.find(
						(scene) => scene.id === clip.sceneId,
					)?.shots[clip.shotIndex];
					if (!shot) throw new MediaOperationError("SHOT_EVIDENCE_MISSING");
					const startFrame = Number(
						originalTimeToCfrFrame(clip.sourceInUs, origin, "FLOOR"),
					);
					const preparedShot = trackingShotFromAnalysis({
						...(target
							? {
									target: {
										id: target.targetId,
										subjectIndexes: target.subjectIndexes,
									},
								}
							: {}),
						sceneId: clip.sceneId,
						shotIndex: clip.shotIndex,
						shot,
						sourceStartUs: origin,
						preparedPartition,
						frameWindow: {
							startFrame,
							endFrame: startFrame + clip.durationFrames,
						},
					});
					if (target && preparedShot?.seed)
						targetSeeds.set(
							target.targetId,
							preparedShot.seed.sourceTimeUs + origin,
						);
					return preparedShot ? [preparedShot] : [];
				});
				if (!shots.length) warnings.add("TRACKING_NO_SHOT_EVIDENCE");
				else {
					await context.onProgress("TRACKING");
					const started = performance.now();
					const result = await trackShotSubjects({
						adaptiveRecovery: !!localStory,
						sourcePath: context.sourcePath,
						mediaSha256: verified.media.sha256,
						sourceWidth: binding.width,
						sourceHeight: binding.height,
						shots,
						ffmpegPath: deps.ffmpegPath,
						signal: context.signal,
					});
					metrics.trackingMs = Math.round(performance.now() - started);
					metrics.trackingRefinementSamples =
						result.recoveryMeasurements?.length ?? 0;
					observations = [
						...result.observations,
						...(result.recoveryMeasurements ?? []),
					]
						.sort((a, b) => a.sourceTimeUs - b.sourceTimeUs)
						.map((point) => ({
							...point,
							sourceTimeUs: point.sourceTimeUs + origin,
						}));
					fallbacks = result.fallbacks.map((range) => ({
						...range,
						fromUs: range.fromUs + origin,
						toUs: range.toUs + origin,
					}));
				}
			}
			if (fallbacks.length) warnings.add("TRACKING_FIT_FALLBACK");
		}
		// Keep the semantic/subject transcript immutable. Alignment changes only
		// the caption projection after the final selected clips are known.
		let captionSegments = segments;
		let captionAlignment: CaptionAlignmentReceipt | undefined;
		const selectedRanges = segments.length
			? selectedCaptionAudioRanges(selection.clips, verified.map)
			: [];
		const selectedSegments = segments.filter((segment) =>
			selectedRanges.some(
				(range) =>
					segment.startUs < range.endUs && segment.endUs > range.startUs,
			),
		);
		if (selectedSegments.some((segment) => !segment.words?.length)) {
			if (localStory?.transcriptLanguageWindows !== undefined)
				captionLanguage = captionLanguageForSelectedSegments(
					selectedSegments,
					localStory.transcriptLanguageWindows,
					{
						startUs: verified.map.sourceStartUs,
						endUs: verified.map.sourceEndUs,
					},
				);
			if (
				!deps.captionAligner ||
				(captionLanguage !== "ja" && captionLanguage !== "en")
			) {
				warnings.add("CAPTION_ALIGNMENT_UNAVAILABLE");
				cacheable = false;
			} else {
				await context.onProgress("ALIGNING_CAPTIONS");
				const started = performance.now();
				const request = {
					sourcePath: context.sourcePath,
					mediaSha256: verified.media.sha256,
					sourceOriginUs: verified.map.sourceStartUs,
					sourceDurationUs:
						verified.map.sourceEndUs - verified.map.sourceStartUs,
					segments: structuredClone(segments),
					...(localStory?.captionTimingEvidence
						? {
								captionTimingEvidence: structuredClone(
									localStory.captionTimingEvidence,
								),
							}
						: {}),
					selectedRanges,
					language: captionLanguage,
					signal: context.signal,
					ffmpegPath: deps.ffmpegPath,
					onProgress: (progress: {
						completedWindows: number;
						totalWindows: number;
					}) => context.onProgress("ALIGNING_CAPTIONS", progress),
				} as const;
				const inputHash = captionAlignmentInputHash(request);
				try {
					const aligned = await deps.captionAligner(request);
					checkSignal(context.signal);
					const receipt = currentCaptionAlignmentReceiptSchema.parse(
						aligned.receipt,
					);
					if (
						receipt.mediaSha256 !== verified.media.sha256 ||
						receipt.inputHash !== inputHash ||
						receipt.outputHash !== hashEditingEvidence(aligned.segments) ||
						!matchesFinalCaptionAlignmentMeasurements(receipt, aligned.segments)
					)
						throw new MediaOperationError("CAPTION_ALIGNMENT_UNVERIFIED");
					captionSegments = aligned.segments;
					captionAlignment = receipt;
					for (const warning of aligned.warnings) warnings.add(warning);
					warnings.delete("WORD_ALIGNMENT_UNAVAILABLE");
					metrics.captionAlignmentAudioUs = receipt.sourceAudioUs;
					metrics.captionAlignmentModelLoadMs = receipt.modelLoadMs;
					metrics.captionAlignmentInferenceMs = receipt.alignmentMs;
				} catch (error) {
					checkSignal(context.signal);
					if (!(error instanceof MediaOperationError)) throw error;
					const errorCode = error.code;
					if (
						![
							"CAPTION_ALIGNMENT_UNAVAILABLE",
							"CAPTION_ALIGNMENT_LANGUAGE_UNSUPPORTED",
							"CAPTION_ALIGNMENT_TEXT_MISMATCH",
							"CAPTION_ALIGNMENT_TIMING_INVALID",
							"CAPTION_ALIGNMENT_LIMIT",
						].includes(errorCode)
					)
						throw error;
					try {
						console.warn(
							JSON.stringify({
								event: "caption_alignment_omitted",
								taskId: task.id,
								entryPoint: "library_generation_worker",
								errorCode,
							}),
						);
					} catch {
						// Diagnostics cannot change the existing omission outcome.
					}
					warnings.add("CAPTION_ALIGNMENT_UNAVAILABLE");
					cacheable = false;
				} finally {
					metrics.captionAlignmentTotalMs = Math.round(
						performance.now() - started,
					);
				}
			}
		}
		const firstPreset = parameters.templateId ?? "portrait-clean";
		const presetIds = [
			firstPreset,
			...COMPOSITION_TEMPLATE_PRESETS.map((preset) => preset.id).filter(
				(id) => id !== firstPreset,
			),
		].slice(0, parameters.variants);
		const variants = presetIds.map((presetId) => {
			let document = applyCompositionTemplate(
				toCompositionDocument(base),
				presetId,
				sources,
			);
			// Applying a template interactively is manual. These documents are
			// created by this recorded generation policy, without a human override.
			for (const clip of document.clips)
				clip.framing = clip.framing.map(
					({ manualOverride: _manualOverride, ...part }) => ({
						...part,
						origin: "AUTO_POLICY",
					}),
				);
			if (segments.length)
				document = captionsFromSourceSegments({
					document,
					sources,
					mediaVersionId: verified.media.id,
					segments: captionSegments,
					requireAlignedText: true,
					...(localStory?.speechIntervals
						? { speechIntervals: localStory.speechIntervals }
						: {}),
					idFor: (clipId, index) =>
						generationObjectId(
							task.organizationId,
							task.id,
							`caption:${presetId}:${clipId}:${index}`,
						),
				});
			if (parameters.tracking)
				document = applyTrackedCompositionFraming({
					document,
					sources,
					mediaVersionId: verified.media.id,
					observations,
					fallbacks,
				});
			if (
				parameters.presentation?.fallbackFraming === "AISA_STATIC_V1" ||
				parameters.presentation?.fallbackFraming === "PRESERVE_SOURCE_V1"
			) {
				for (const clip of document.clips) {
					if (!compositionUsesMainPresentation(document, clip)) continue;
					const evidence = clip.evidence;
					const shot =
						evidence?.shotIndex === undefined
							? undefined
							: analysis.scenes.find((scene) => scene.id === evidence.sceneId)
									?.shots[evidence.shotIndex];
					const candidates = shotCropCandidates({
						sourceWidth: binding.width,
						sourceHeight: binding.height,
						targetWidth: document.canvas.width,
						targetHeight: document.canvas.height,
						mainSubjects: shot?.mainSubjects,
					});
					const candidate =
						candidates.find((value) => value.kind === "AISA") ??
						candidates.find((value) => value.id === "center");
					if (candidate) clip.fallbackCrop = { ...candidate.rect };
				}
			}
			if (parameters.presentation) {
				document.presentation = {
					...parameters.presentation,
					centerCropConfirmed: false,
				};
				if (compositionHasUnconfirmedFraming(document))
					warnings.add("CENTER_CROP_REVIEW_REQUIRED");
			}
			if (localStory && parameters.tracking) {
				for (const clip of document.clips) {
					const evidence = clip.evidence,
						target =
							evidence && subjectTarget(evidence.sceneId, evidence.shotIndex);
					const seed = target && targetSeeds.get(target.targetId),
						context = compositionSubjectProtectionContext(document, clip);
					if (
						!evidence ||
						!target ||
						target.decision !== "CROP" ||
						seed === undefined ||
						!context ||
						!clip.framing.some((part) => part.mode === "CROP")
					)
						continue;
					const start = Number(
						originalTimeToCfrFrame(
							clip.sourceInUs,
							binding.sourceStartUs,
							"FLOOR",
						),
					);
					const samples = observations
						.filter(
							(point) =>
								point.sceneId === evidence?.sceneId &&
								point.shotIndex === evidence.shotIndex &&
								Number(
									originalTimeToCfrFrame(
										point.sourceTimeUs,
										binding.sourceStartUs,
										"FLOOR",
									),
								) >= start &&
								Number(
									originalTimeToCfrFrame(
										point.sourceTimeUs,
										binding.sourceStartUs,
										"FLOOR",
									),
								) <
									start + clip.durationFrames,
						)
						.map(({ sourceTimeUs, box, confidence }) => ({
							sourceTimeUs,
							box,
							confidence,
						}));
					clip.subjectProtection = createCompositionSubjectProtection({
						context,
						target,
						seedSourceTimeUs: seed,
						samples,
					});
				}
				metrics.localStoryProtectedClips = document.clips.filter(
					(clip) => clip.subjectProtection,
				).length;
			}
			if (document.autoGeneration)
				document.autoGeneration.requestHash = hashEditingEvidence({
					taskRequestHash: task.requestHash,
					generationPolicyFingerprint: GENERATION_POLICY_FINGERPRINT,
					...(captionAlignment
						? { captionAlignmentHash: hashEditingEvidence(captionAlignment) }
						: {}),
					...(localStory
						? {
								subjectTargetsHash: hashEditingEvidence(subjectTargets),
								subjectProtectionHash: hashEditingEvidence(
									document.clips.map((clip) => clip.subjectProtection ?? null),
								),
							}
						: {}),
					presetId,
					mediaSha256: verified.media.sha256,
					analysisDocumentHash: envelope.identity.analysisDocumentHash,
					bindingHash: hashEditingEvidence(binding),
					modelSha256: envelope.identity.modelSha256,
					...(envelope.identity.transcriptionPolicyFingerprint
						? {
								transcriptionPolicyFingerprint:
									envelope.identity.transcriptionPolicyFingerprint,
							}
						: {}),
					...(semanticEvidence
						? { semanticEvidenceHash: hashEditingEvidence(semanticEvidence) }
						: {}),
					...(selectionEvidence
						? {
								speechSelectionPolicyVersion:
									LOCAL_SPEECH_SELECTION_POLICY_VERSION,
								selectionEvidenceHash: hashEditingEvidence(selectionEvidence),
							}
						: {}),
					...(storyEvidence
						? {
								storyArtifactHash: storyEvidence.artifactHash,
								storySelectionHash: hashEditingEvidence(
									storyEvidence.selection,
								),
							}
						: {}),
					...(localStoryEvidence
						? {
								localStoryArtifactHash: localStoryEvidence.artifactHash,
								localStorySelectionHash: hashEditingEvidence(
									localStoryEvidence.selection,
								),
							}
						: {}),
				});
			document = compositionDocumentSchema.parse(document);
			compileComposition(document, sources, {
				allowUnconfirmed:
					parameters.renderMode === "DRAFT" &&
					parameters.presentation !== undefined,
			});
			return {
				presetId,
				document,
				projectId: generationObjectId(
					task.organizationId,
					task.id,
					`project:${presetId}`,
				),
			};
		});
		let captionTranslation: GenerationTaskResult["captionTranslation"];
		if (parameters.captions === "JAPANESE") {
			const translator = deps.captionTranslator;
			if (!translator || !expectedCaptionTranslationModel)
				throw new MediaOperationError("LOCAL_CAPTION_TRANSLATION_UNAVAILABLE");
			const artifactHashes: string[] = [];
			let captionCount = 0;
			for (const variant of variants) {
				checkSignal(context.signal);
				const result = await translator.translate({
					task,
					verified,
					leaseToken: context.leaseToken,
					document: variant.document,
					sourceLanguage: parameters.language,
					signal: context.signal,
					onProgress: context.onProgress,
				});
				if (
					hashEditingEvidence(translator.identity) !==
					hashEditingEvidence(expectedCaptionTranslationModel)
				)
					throw new MediaOperationError("LOCAL_CAPTION_MODEL_CHANGED");
				variant.document = compositionDocumentSchema.parse(result.document);
				compileComposition(variant.document, sources, {
					allowUnconfirmed:
						parameters.renderMode === "DRAFT" &&
						parameters.presentation !== undefined,
				});
				artifactHashes.push(...result.artifactHashes);
				captionCount +=
					variant.document.captions?.filter(
						(caption) =>
							caption.translation?.origin === "LOCAL_LLM" &&
							result.artifactHashes.includes(
								caption.translation.evidenceHash ?? "",
							),
					).length ?? 0;
				for (const [key, value] of Object.entries(result.metrics))
					metrics[key] = (metrics[key] ?? 0) + value;
				if (variant.document.autoGeneration)
					variant.document.autoGeneration.requestHash = hashEditingEvidence({
						baseRequestHash: variant.document.autoGeneration.requestHash,
						captionTranslationModel: expectedCaptionTranslationModel,
						artifactHashes: result.artifactHashes,
					});
			}
			captionTranslation = {
				version: "local-caption-translation-v1",
				model: expectedCaptionTranslationModel,
				targetLanguage: "ja",
				captionCount,
				artifactHashes,
			};
		}
		checkSignal(context.signal);
		await context.onProgress("PUBLISHING");
		return deps.prisma.$transaction(
			async (tx) => {
				const changed = await tx.libraryMediaTask.updateMany({
					where: {
						id: task.id,
						organizationId: task.organizationId,
						state: "RUNNING",
						leaseToken: context.leaseToken,
						leaseUntil: { gt: now() },
						cancelRequestedAt: null,
					},
					data: { phase: "PUBLISHING" },
				});
				if (!changed.count) {
					const current = await tx.libraryMediaTask.findUnique({
						where: { id: task.id },
					});
					if (current?.state === "SUCCEEDED")
						return resultForRenderMode(
							current.result,
							parameters.renderMode,
							parameters.draftPolicyVersion,
							parameters.presentation,
							expectedAutomaticPolicyVersion,
							expectedStoryModel,
							expectedLocalStoryModel,
							expectedCaptionTranslationModel,
							expectedGenerationPolicyFingerprint,
						);
					throw new MediaOperationError(
						current?.cancelRequestedAt ? "CANCELED" : "LEASE_LOST",
					);
				}
				await verifyMediaTaskEvidence(tx, task, binding);
				const linked = await tx.contentRevision.findFirst({
					where: {
						contentId: parameters.contentId,
						sourceId: verified.media.sourceId,
					},
					include: { content: true },
				});
				if (!linked) throw new MediaOperationError("CONTENT_MEDIA_MISMATCH");
				for (const variant of variants) {
					if (
						await tx.editProject.findUnique({
							where: { id: variant.projectId },
						})
					)
						throw new MediaOperationError("GENERATION_ID_CONFLICT");
					const shape = variant.document.canvas,
						kind =
							shape.height > shape.width
								? "PORTRAIT"
								: shape.height < shape.width
									? "LANDSCAPE"
									: "SQUARE";
					await tx.editProject.create({
						data: {
							id: variant.projectId,
							contentId: parameters.contentId,
							mediaVersionId: verified.media.id,
							title: `${linked.content.title.slice(0, 420)} (${variant.presetId})`,
							variant: kind,
							draft: json(variant.document),
							createdBy: task.createdBy,
						},
					});
					const revision = await tx.editRevision.create({
						data: {
							projectId: variant.projectId,
							revision: 1,
							document: json(variant.document),
							createdBy: task.createdBy,
						},
					});
					await tx.editProject.update({
						where: { id: variant.projectId },
						data: { currentRevisionId: revision.id },
					});
					if (parameters.renderMode !== "DRAFT") {
						const storage = editingMediaStorageSchema.parse(
							verified.media.storage,
						);
						await tx.contentDerivation.create({
							data: {
								projectId: variant.projectId,
								variant: kind,
								desiredGeneration: 1,
							},
						});
						await tx.renderRun.create({
							data: {
								projectId: variant.projectId,
								revisionId: revision.id,
								requestKey: generationObjectId(
									task.organizationId,
									task.id,
									`export:${variant.presetId}`,
								),
								requestHash: hashEditingEvidence({
									revisionId: revision.id,
									kind: "EXPORT",
								}),
								generation: 1,
								profile: json({ kind: "EXPORT" }),
								outputCredentialId: storage.output.credentialId,
								outputBucket: storage.output.bucket,
								outputPrefix: storage.output.prefix,
							},
						});
					}
				}
				const projectIds = variants.map((variant) => variant.projectId),
					projectId = projectIds[0];
				if (!projectId) throw new MediaOperationError("NO_VARIANTS");
				const result = generationTaskResultSchema.parse({
					generationPolicyFingerprint: GENERATION_POLICY_FINGERPRINT,
					...(parameters.presentation
						? { presentation: parameters.presentation }
						: {}),
					...(parameters.draftPolicyVersion
						? { draftPolicyVersion: parameters.draftPolicyVersion }
						: {}),
					...(parameters.renderMode
						? { renderMode: parameters.renderMode }
						: {}),
					projectId,
					projectIds,
					requestedFrames: parameters.targetDurationFrames,
					actualFrames: selection.actualDurationFrames,
					warnings: [...warnings],
					policyVersion: selection.policyVersion,
					presetIds,
					metrics,
					cacheable,
					...(selectionEvidence ? { selectionEvidence } : {}),
					...(semanticEvidence ? { semanticEvidence } : {}),
					...(storyEvidence ? { storyEvidence } : {}),
					...(localStoryEvidence ? { localStoryEvidence } : {}),
					...(captionTranslation ? { captionTranslation } : {}),
					...(captionAlignment ? { captionAlignment } : {}),
				});
				checkSignal(context.signal);
				const completed = await tx.libraryMediaTask.updateMany({
					where: {
						id: task.id,
						organizationId: task.organizationId,
						state: "RUNNING",
						leaseToken: context.leaseToken,
						leaseUntil: { gt: now() },
						cancelRequestedAt: null,
					},
					data: {
						state: "SUCCEEDED",
						phase: "COMPLETE",
						result: json(result),
						progress: json({ variantCount: variants.length, ...metrics }),
						finishedAt: now(),
						leaseToken: null,
						leaseUntil: null,
						error: null,
					},
				});
				if (!completed.count) throw new MediaOperationError("LEASE_LOST");
				return result;
			},
			{ maxWait: 5_000, timeout: 20_000, statementTimeoutMs: 5_000 },
		);
	};
}
