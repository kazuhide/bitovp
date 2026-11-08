import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
	AutomaticBindingError,
	DEFAULT_ASR_MODEL_SHA256,
	type EditingAnalysisBinding,
	editingMediaStorageSchema,
	type GenerationTaskParameters,
	LOCAL_SPEECH_SELECTION_POLICY_VERSION,
	LOCAL_TRACKING_ALGORITHM_VERSION,
	LOCAL_TRACKING_FRAME_CLOCK_VERSION,
	TRANSCRIPTION_POLICY_FINGERPRINT,
	usesGeneratedCaptions,
} from "@bitovp/core";
import type {
	AppPrismaClient,
	AppTransactionClient,
	LibraryMediaTask,
	LibraryMediaVersion,
} from "@bitovp/db";
import {
	LibraryMediaTaskEvidenceError,
	verifyLibraryMediaTaskEvidence,
} from "@bitovp/db";
import type { ObjectStorageBrowser } from "@bitovp/storage";
import { analysisBudget, analysisScratch, boundedInteger } from "./analysis-io";
import { downloadPinnedEditingMedia } from "./media";
import { MediaOperationError } from "./process";
import {
	type TrackingShot,
	trackingShotFromAnalysis,
	trackShotSubjects,
} from "./tracking";
import { transcriptInOriginalTime } from "./transcript-clock";
import { transcribeLocalAudio } from "./transcription";

export type MediaTaskExecutionDependencies = {
	prisma: AppPrismaClient;
	browserFor(credentialId: string): Promise<ObjectStorageBrowser>;
	model?: { path: string; sha256: string };
	generate?: (input: {
		taskId: string;
		organizationId: string;
		leaseToken: string;
		mediaVersionId: string;
		analysisRevisionId: string;
		parameters: GenerationTaskParameters;
		sourcePath: string;
		media: LibraryMediaVersion;
		createdBy: string | null;
		signal: AbortSignal;
		onProgress(
			phase: string,
			progress?: Record<string, unknown>,
		): Promise<void>;
	}) => Promise<unknown>;
};
export async function verifyMediaTaskEvidence(
	tx: AppTransactionClient,
	task: LibraryMediaTask,
	expectedBinding?: EditingAnalysisBinding,
) {
	try {
		return await verifyLibraryMediaTaskEvidence(tx, task, expectedBinding);
	} catch (error) {
		if (error instanceof LibraryMediaTaskEvidenceError)
			throw new MediaOperationError(error.code);
		throw error;
	}
}

export type VerifiedMediaTask = Awaited<
	ReturnType<typeof verifyMediaTaskEvidence>
>;

/** Shared by claim and execution: cached/follower adoption must obey the same intent version. */
export function trackingIntentFailureCode(
	envelope: VerifiedMediaTask["envelope"],
) {
	const needsTracking =
		envelope.input.kind === "TRACK" ||
		(envelope.input.kind === "GENERATE" && envelope.input.parameters.tracking);
	if (!needsTracking) return undefined;
	if (
		(envelope.identity.trackingAlgorithmVersion ?? "template-ncc-v1") !==
		LOCAL_TRACKING_ALGORITHM_VERSION
	)
		return "TRACKING_ALGORITHM_CHANGED" as const;
	if (
		envelope.identity.trackingFrameClockVersion !==
		LOCAL_TRACKING_FRAME_CLOCK_VERSION
	)
		return "TRACKING_FRAME_CLOCK_CHANGED" as const;
	return undefined;
}

export function speechSelectionIntentFailureCode(
	envelope: VerifiedMediaTask["envelope"],
) {
	if (
		envelope.identity.transcriptionPolicyFingerprint !== undefined &&
		envelope.identity.transcriptionPolicyFingerprint !==
			TRANSCRIPTION_POLICY_FINGERPRINT
	)
		return "ASR_QUALITY_POLICY_CHANGED" as const;
	if (
		envelope.input.kind === "GENERATE" &&
		envelope.input.parameters.policy !== "LOCAL_STORY" &&
		usesGeneratedCaptions(envelope.input.parameters.captions) &&
		envelope.identity.speechSelectionPolicyVersion !==
			LOCAL_SPEECH_SELECTION_POLICY_VERSION
	)
		return "SPEECH_SELECTION_POLICY_CHANGED" as const;
	return undefined;
}

/** Decode/recognize real pinned objects. No runtime download of executables or models. */
export async function executeMediaTask(input: {
	task: LibraryMediaTask;
	verified: VerifiedMediaTask;
	dependencies: MediaTaskExecutionDependencies;
	signal: AbortSignal;
	timeoutMs: number;
	onProgress(phase: string, progress?: Record<string, unknown>): Promise<void>;
}): Promise<unknown> {
	const { task, verified, dependencies, signal, onProgress } = input;
	const intentFailure =
		trackingIntentFailureCode(verified.envelope) ??
		speechSelectionIntentFailureCode(verified.envelope);
	if (intentFailure) throw new MediaOperationError(intentFailure);
	const request = verified.envelope.input;
	const localStory =
		request.kind === "GENERATE" && request.parameters.policy === "LOCAL_STORY";
	if (localStory) boundedInteger(input.timeoutMs, 1, 120 * 60_000);
	// The leased sweep owns the longer story deadline; source I/O stays bounded.
	const budget = analysisBudget(
		signal,
		localStory ? Math.min(input.timeoutMs, 30 * 60_000) : input.timeoutMs,
	);
	const directory = await analysisScratch("bitovp-media-task-");
	let browser: ObjectStorageBrowser | undefined;
	try {
		await onProgress("DOWNLOADING_SOURCE");
		const prepared = editingMediaStorageSchema.parse(
			verified.media.storage,
		).prepared;
		if (!prepared?.expect || !prepared.size || !verified.media.sha256)
			throw new MediaOperationError("SOURCE_UNVERIFIED");
		browser = await dependencies.browserFor(prepared.credentialId);
		const sourcePath = join(directory, "source.mp4");
		await downloadPinnedEditingMedia({
			browser,
			bucket: prepared.bucket,
			key: prepared.key,
			destinationPath: sourcePath,
			maxBytes: 512 * 1024 * 1024,
			expectedIdentity: { ...prepared.expect, size: prepared.size },
			expectedSha256: verified.media.sha256,
			signal,
			timeoutMs: budget.remaining(),
		});
		if (request.kind === "GENERATE") {
			if (!dependencies.generate || !task.leaseToken)
				throw new MediaOperationError("GENERATION_NOT_CONFIGURED");
			await onProgress("GENERATING");
			// The callback owns sourcePath until it settles; finally must wait too.
			return await dependencies.generate({
				taskId: task.id,
				organizationId: task.organizationId,
				leaseToken: task.leaseToken,
				mediaVersionId: task.mediaVersionId,
				analysisRevisionId: request.analysisRevisionId,
				parameters: request.parameters,
				sourcePath,
				media: verified.media,
				createdBy: task.createdBy,
				signal,
				onProgress,
			});
		}
		if (request.kind === "TRANSCRIBE") {
			const path = dependencies.model?.path ?? process.env.WHISPER_MODEL_PATH;
			const sha256 =
				dependencies.model?.sha256 ??
				process.env.WHISPER_MODEL_SHA256 ??
				DEFAULT_ASR_MODEL_SHA256;
			if (!path) throw new MediaOperationError("ASR_MODEL_NOT_CONFIGURED");
			if (sha256 !== verified.envelope.identity.modelSha256)
				throw new MediaOperationError("ASR_MODEL_CHANGED");
			// Public sourceStartUs is an offset within this prepared version. Convert
			// back to original presentation time only after real audio recognition.
			const start = request.parameters.sourceStartUs;
			const available =
				verified.map.sourceEndUs - verified.map.sourceStartUs - start;
			const durationUs =
				request.parameters.durationUs ?? Math.min(180_000_000, available);
			if (available < durationUs || durationUs < 1)
				throw new MediaOperationError("SOURCE_OUT_OF_BOUNDS");
			await onProgress("TRANSCRIBING");
			const result = await transcribeLocalAudio({
				sourcePath,
				mediaSha256: verified.media.sha256,
				model: { path, sha256 },
				language: request.parameters.language,
				sourceStartUs: start,
				durationUs,
				signal,
				timeoutMs: budget.remaining(),
			});
			const origin = verified.map.sourceStartUs;
			if (
				verified.envelope.identity.transcriptionPolicyFingerprint !==
					undefined &&
				result.qualityPolicyFingerprint !==
					verified.envelope.identity.transcriptionPolicyFingerprint
			)
				throw new MediaOperationError("ASR_QUALITY_POLICY_CHANGED");
			return transcriptInOriginalTime(result, origin);
		}
		const analysis = verified.analysisDocument;
		if (
			!analysis ||
			!verified.binding ||
			!verified.media.width ||
			!verified.media.height
		)
			throw new AutomaticBindingError();
		const selected = request.parameters.sceneIds
			? new Set(request.parameters.sceneIds)
			: null;
		if (
			selected &&
			[...selected].some(
				(id) => !analysis.scenes.some((scene) => scene.id === id),
			)
		)
			throw new MediaOperationError("SCENE_NOT_FOUND");
		const origin = verified.map.sourceStartUs,
			shots: TrackingShot[] = [];
		for (const scene of analysis.scenes) {
			if (selected && !selected.has(scene.id)) continue;
			for (const [shotIndex, shot] of scene.shots.entries()) {
				const startUs = Math.round(shot.startInSeconds * 1_000_000),
					endUs = Math.round(shot.endInSeconds * 1_000_000);
				if (
					startUs < origin ||
					endUs > verified.map.sourceEndUs ||
					endUs <= startUs
				)
					continue;
				const preparedShot = trackingShotFromAnalysis({
					sceneId: scene.id,
					shotIndex,
					shot,
					sourceStartUs: origin,
				});
				if (preparedShot) shots.push(preparedShot);
			}
		}
		if (!shots.length) throw new MediaOperationError("NO_TRACKABLE_SHOTS");
		if (
			shots.length > 20 ||
			shots.reduce((sum, shot) => sum + shot.endUs - shot.startUs, 0) >
				180_000_000
		)
			throw new MediaOperationError("TRACKING_LIMIT_SELECT_SCENES");
		await onProgress("TRACKING", { shotCount: shots.length });
		const result = await trackShotSubjects({
			sourcePath,
			mediaSha256: verified.media.sha256,
			sourceWidth: verified.media.width,
			sourceHeight: verified.media.height,
			shots,
			signal,
			timeoutMs: budget.remaining(),
		});
		return {
			...result,
			sourceTimeDomain: "ORIGINAL_PRESENTATION_US",
			bindingKind: verified.binding.kind,
			observations: result.observations.map((point) => ({
				...point,
				sourceTimeUs: point.sourceTimeUs + origin,
			})),
			fallbacks: result.fallbacks.map((range) => ({
				...range,
				fromUs: range.fromUs + origin,
				toUs: range.toUs + origin,
			})),
		};
	} finally {
		try {
			browser?.dispose?.();
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	}
}
