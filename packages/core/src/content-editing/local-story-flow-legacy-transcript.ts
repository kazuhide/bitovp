import {
	TRANSCRIPTION_POLICY_FINGERPRINT,
	TRANSCRIPTION_QUALITY_POLICY,
	transcriptionRawSegmentSchema,
	transcriptionSpeechIntervalSchema,
} from "../content-production/transcription-quality";
import {
	type CompositionSourceSegment,
	compositionSourceSegmentSchema,
} from "./composition-evidence";
import {
	parseLegacyWhisperTranscript,
	type LegacyRawTranscriptSegment as RawTranscriptSegment,
	type LegacySpeechInterval as SpeechInterval,
} from "./local-story-flow-legacy-asr";
import { cfrTimeMapSchema } from "./schema";
import { hashEditingEvidence } from "./verify-automatic-binding";

export const LOCAL_STORY_LEGACY_TRANSCRIPT_RECIPE_POLICY = Object.freeze({
	version: "local-story-legacy-transcript-recipe-v1",
	storedVersion: "local-story-transcript-v3",
	retryPolicyVersion: "strict-invalid-30s-10s-v1",
	engineVersion: "1.9.5",
	sourceTimeDomain: "ORIGINAL_PRESENTATION_US",
	windowDurationUs: 180_000_000,
	maxSourceDurationUs: 3_600_000_000,
	maxAttempts: 500,
	totalBudgetMs: 30 * 60_000,
	limits: Object.freeze({
		segments: 5000,
		rawSegments: 5000,
		speechIntervals: 10000,
		warnings: 20,
		textCodeUnits: 1_000_000,
		words: 30_000,
	}),
	warningCodes: Object.freeze([
		"NO_SPEECH",
		"WORD_ALIGNMENT_UNAVAILABLE",
		"SEGMENT_END_CLAMPED",
		"LOCAL_STORY_TRANSCRIPT_WINDOW_BOUNDARIES",
		"LOCAL_STORY_TRANSCRIPT_SHORT_WINDOWS",
	] as const),
} as const);
const RETRY_POLICY_VERSION =
	LOCAL_STORY_LEGACY_TRANSCRIPT_RECIPE_POLICY.retryPolicyVersion;
const WHISPER_CPP_VERSION =
	LOCAL_STORY_LEGACY_TRANSCRIPT_RECIPE_POLICY.engineVersion;
const MAX_ANALYSIS_DURATION_US =
	LOCAL_STORY_LEGACY_TRANSCRIPT_RECIPE_POLICY.windowDurationUs;
const MAX_ATTEMPTS = LOCAL_STORY_LEGACY_TRANSCRIPT_RECIPE_POLICY.maxAttempts;
const TOTAL_BUDGET_MS =
	LOCAL_STORY_LEGACY_TRANSCRIPT_RECIPE_POLICY.totalBudgetMs;
const warningCodes = new Set<string>(
	LOCAL_STORY_LEGACY_TRANSCRIPT_RECIPE_POLICY.warningCodes,
);
const object = (v: unknown): v is Record<string, unknown> =>
	!!v && typeof v === "object" && !Array.isArray(v);
const validDigest = (value: string) => /^[a-f0-9]{64}$/.test(value);
export class LocalStoryLegacyTranscriptError extends Error {
	constructor(
		readonly code:
			| "LOCAL_STORY_CONTEXT_LIMIT"
			| "ASR_MODEL_CHANGED"
			| "LOCAL_STORY_ARTIFACT_UNVERIFIED"
			| "TRANSCRIPT_LIMIT",
	) {
		super(code);
		this.name = "LocalStoryLegacyTranscriptError";
	}
}
export type LocalStoryLegacyTranscriptIdentityInput = {
	mediaSha256: string;
	timeMap: unknown;
	configuredModel: null | { sha256: string };
	language: "ja" | "en" | "auto";
};
export type LocalStoryLegacyTranscriptPrepared = {
	segments: CompositionSourceSegment[];
	/** Opt-in display projection; excluded from the historical recipe and fingerprint. */
	speechIntervals?: SpeechInterval[];
	status: "READY" | "UNAVAILABLE" | "NO_AUDIO";
	fingerprint: string;
	warnings: string[];
	modelSha256: string | null;
	cached: boolean;
	qualityPolicyFingerprint: string;
};
export type LocalStoryLegacyTranscriptAbsence =
	| { status: "NO_AUDIO"; warning: "SOURCE_HAS_NO_AUDIO" }
	| {
			status: "UNAVAILABLE";
			warning:
				| "ASR_MODEL_NOT_CONFIGURED"
				| "ASR_UNAVAILABLE"
				| "TRANSCRIPT_INVALID"
				| "TRANSCRIPT_LIMIT";
	  };
type RetryWarning =
	| "LOCAL_STORY_TRANSCRIPT_SHORT_WINDOWS"
	| "LOCAL_STORY_TRANSCRIPT_WINDOW_BOUNDARIES";
export type LocalStoryLegacyTranscriptStoredValue = {
	version: "local-story-transcript-v3";
	retryPolicyVersion: typeof RETRY_POLICY_VERSION;
	engineVersion: typeof WHISPER_CPP_VERSION;
	mediaSha256: string;
	modelSha256: string;
	timeMapHash: string;
	language: string;
	sourceTimeDomain: "ORIGINAL_PRESENTATION_US";
	segments: CompositionSourceSegment[];
	warnings: string[];
	mediaWindows: { fromUs: number; toUs: number; language: string }[];
	qualityPolicyFingerprint: string;
	rawSegments: RawTranscriptSegment[];
	speechIntervals: SpeechInterval[];
};
type StoredTranscript = LocalStoryLegacyTranscriptStoredValue;

export function createLocalStoryLegacyTranscriptRecipe(
	values: LocalStoryLegacyTranscriptIdentityInput,
) {
	const input = {
		mediaSha256: values.mediaSha256,
		language: values.language,
		model:
			values.configuredModel === null
				? undefined
				: { sha256: values.configuredModel.sha256 },
	};
	const map = cfrTimeMapSchema.parse(values.timeMap),
		durationUs = map.sourceEndUs - map.sourceStartUs;
	if (
		durationUs < 1 ||
		durationUs > 3_600_000_000 ||
		!validDigest(input.mediaSha256) ||
		!["ja", "en", "auto"].includes(input.language)
	)
		throw new LocalStoryLegacyTranscriptError("LOCAL_STORY_CONTEXT_LIMIT");
	if (input.model && !validDigest(input.model.sha256))
		throw new LocalStoryLegacyTranscriptError("ASR_MODEL_CHANGED");
	const key = {
		version: "local-story-transcript-v3" as const,
		qualityPolicyFingerprint: TRANSCRIPTION_POLICY_FINGERPRINT,
		retryPolicyVersion: RETRY_POLICY_VERSION,
		engineVersion: WHISPER_CPP_VERSION,
		mediaSha256: input.mediaSha256,
		timeMapHash: hashEditingEvidence(map),
		modelSha256: input.model?.sha256 ?? null,
		language: input.language,
		windowDurationUs: MAX_ANALYSIS_DURATION_US,
		maxAttempts: MAX_ATTEMPTS,
		totalBudgetMs: TOTAL_BUDGET_MS,
	};
	const model = input.model;
	const validLanguage = (language: string, hasSegments: boolean) =>
		/^[a-z]{2,3}$/.test(language) &&
		(input.language === "auto"
			? language !== "und" || !hasSegments
			: language === input.language);
	const parse = (
		value: unknown,
		recoverDerivedMean = false,
	): StoredTranscript => {
		if (!model) throw new LocalStoryLegacyTranscriptError("ASR_MODEL_CHANGED");
		if (
			!object(value) ||
			Object.keys(value).length !== 14 ||
			value.version !== key.version ||
			value.retryPolicyVersion !== RETRY_POLICY_VERSION ||
			value.engineVersion !== WHISPER_CPP_VERSION ||
			value.qualityPolicyFingerprint !== TRANSCRIPTION_POLICY_FINGERPRINT ||
			value.mediaSha256 !== input.mediaSha256 ||
			value.modelSha256 !== model.sha256 ||
			value.timeMapHash !== key.timeMapHash ||
			value.language !== input.language ||
			value.sourceTimeDomain !== "ORIGINAL_PRESENTATION_US" ||
			!Array.isArray(value.mediaWindows) ||
			value.mediaWindows.length < 1 ||
			value.mediaWindows.length > MAX_ATTEMPTS ||
			!Array.isArray(value.warnings) ||
			value.warnings.length > 20 ||
			!value.warnings.every((v) => typeof v === "string" && warningCodes.has(v))
		)
			throw new LocalStoryLegacyTranscriptError(
				"LOCAL_STORY_ARTIFACT_UNVERIFIED",
			);
		let coverageEnd = 0;
		const mediaWindows = value.mediaWindows.map((w) => {
			if (
				!object(w) ||
				Object.keys(w).length !== 3 ||
				!Number.isSafeInteger(w.fromUs) ||
				!Number.isSafeInteger(w.toUs) ||
				w.fromUs !== coverageEnd ||
				typeof w.toUs !== "number" ||
				w.toUs <= coverageEnd ||
				w.toUs > durationUs ||
				w.toUs - coverageEnd > MAX_ANALYSIS_DURATION_US ||
				typeof w.language !== "string" ||
				!validLanguage(w.language, false)
			)
				throw new LocalStoryLegacyTranscriptError(
					"LOCAL_STORY_ARTIFACT_UNVERIFIED",
				);
			const fromUs = coverageEnd,
				toUs = w.toUs;
			coverageEnd = toUs;
			return { fromUs, toUs, language: w.language };
		});
		if (coverageEnd !== durationUs)
			throw new LocalStoryLegacyTranscriptError(
				"LOCAL_STORY_ARTIFACT_UNVERIFIED",
			);
		const segments = compositionSourceSegmentSchema
			.array()
			.max(5000)
			.parse(value.segments);
		const rawSegments = transcriptionRawSegmentSchema
			.array()
			.max(5000)
			.parse(value.rawSegments);
		const speechIntervals = transcriptionSpeechIntervalSchema
			.array()
			.max(10000)
			.parse(value.speechIntervals);
		let intervalEnd = map.sourceStartUs;
		for (const interval of speechIntervals) {
			if (interval.startUs < intervalEnd || interval.endUs > map.sourceEndUs)
				throw new LocalStoryLegacyTranscriptError(
					"LOCAL_STORY_ARTIFACT_UNVERIFIED",
				);
			intervalEnd = interval.endUs;
		}
		let end = map.sourceStartUs,
			textLength = 0,
			words = 0,
			windowIndex = 0;
		for (const segment of segments) {
			const relative = segment.startUs - map.sourceStartUs;
			while (
				mediaWindows[windowIndex] &&
				relative >= (mediaWindows[windowIndex]?.toUs ?? Infinity)
			)
				windowIndex++;
			const window = mediaWindows[windowIndex];
			if (
				!window ||
				segment.startUs < end ||
				relative < window.fromUs ||
				window.language === "und" ||
				segment.endUs > map.sourceStartUs + window.toUs ||
				segment.endUs > map.sourceEndUs
			)
				throw new LocalStoryLegacyTranscriptError(
					"LOCAL_STORY_ARTIFACT_UNVERIFIED",
				);
			end = segment.endUs;
			textLength += segment.text.length;
			words += segment.words?.length ?? 0;
		}
		if (textLength > 1_000_000 || words > 30_000)
			throw new LocalStoryLegacyTranscriptError("TRANSCRIPT_LIMIT");
		let rawCount = 0,
			intervalCount = 0;
		for (const window of mediaWindows) {
			const from = map.sourceStartUs + window.fromUs,
				to = map.sourceStartUs + window.toUs;
			const raw = rawSegments.filter(
				(s) => s.startUs >= from && s.startUs < to,
			);
			const speech = speechIntervals.filter(
				(s) => s.startUs >= from && s.endUs <= to,
			);
			rawCount += raw.length;
			intervalCount += speech.length;
			const observed = parseLegacyWhisperTranscript(
				{
					result: { language: window.language },
					bitovp_quality: {
						version: TRANSCRIPTION_QUALITY_POLICY.jsonExporter,
						vad: true,
						speech_intervals: speech.map((s) => ({
							offsets: {
								from: (s.startUs - from) / 1000,
								// A real frame-clock EOF may lie between milliseconds.
								// Reconstruct an integer CLI end, then qualify/clamp it
								// again below; exact interval equality is still required.
								to: Math.ceil((s.endUs - from) / 1000),
							},
						})),
					},
					transcription: raw.map((s) => ({
						text: s.text,
						offsets: {
							from: (s.startUs - from) / 1000,
							to: (s.endUs - from) / 1000,
						},
						no_speech_probability: s.quality.noSpeechProbability,
						tokens: (s.tokens ?? []).map((t) => ({
							text: t.text,
							p: t.p,
							...(t.startUs !== undefined && t.endUs !== undefined
								? {
										offsets: {
											from: (t.startUs - from) / 1000,
											to: (t.endUs - from) / 1000,
										},
									}
								: {}),
						})),
					})),
				},
				to - from,
				from,
				{ requireQuality: true },
			);
			if (recoverDerivedMean) {
				// rawSegments came from strict schema.parse and are detached from the
				// immutable row. Recompute ONLY this derived float with the same
				// policy/model/clock parser, never text, token p, times or decisions.
				for (const [index, segment] of raw.entries()) {
					const reconstructed = observed.rawSegments?.[index];
					if (!reconstructed)
						throw new LocalStoryLegacyTranscriptError(
							"LOCAL_STORY_ARTIFACT_UNVERIFIED",
						);
					segment.quality.meanTokenLogProbability =
						reconstructed.quality.meanTokenLogProbability;
				}
			}
			if (
				hashEditingEvidence(observed.segments) !==
					hashEditingEvidence(
						segments.filter((s) => s.startUs >= from && s.startUs < to),
					) ||
				hashEditingEvidence(observed.rawSegments) !==
					hashEditingEvidence(raw) ||
				hashEditingEvidence(observed.speechIntervals) !==
					hashEditingEvidence(speech)
			)
				throw new LocalStoryLegacyTranscriptError(
					"LOCAL_STORY_ARTIFACT_UNVERIFIED",
				);
		}
		if (
			rawCount !== rawSegments.length ||
			intervalCount !== speechIntervals.length
		)
			throw new LocalStoryLegacyTranscriptError(
				"LOCAL_STORY_ARTIFACT_UNVERIFIED",
			);
		return {
			version: "local-story-transcript-v3",
			qualityPolicyFingerprint: TRANSCRIPTION_POLICY_FINGERPRINT,
			rawSegments,
			speechIntervals,
			retryPolicyVersion: RETRY_POLICY_VERSION,
			engineVersion: WHISPER_CPP_VERSION,
			mediaSha256: input.mediaSha256,
			modelSha256: model.sha256,
			timeMapHash: key.timeMapHash,
			language: input.language,
			sourceTimeDomain: "ORIGINAL_PRESENTATION_US",
			segments,
			warnings: value.warnings as string[],
			mediaWindows,
		};
	};
	return {
		timeMap: structuredClone(map),
		durationUs,
		totalWindows: Math.ceil(durationUs / MAX_ANALYSIS_DURATION_US),
		kind: "LOCAL_STORY_TRANSCRIPT_V1" as const,
		key: structuredClone(key),
		parse: (value: unknown) => parse(value),
		/** Candidate only: the ORIGINAL complete v1 wrapper seal must still match, then normal parse. */
		recoverLegacyDerivedMean: (value: unknown) => parse(value, true),
		absent: (
			reason: LocalStoryLegacyTranscriptAbsence,
			retryWarnings: readonly RetryWarning[],
		): LocalStoryLegacyTranscriptPrepared => {
			const { status, warning } = reason;
			return {
				status,
				segments: [],
				warnings: [warning, ...retryWarnings],
				cached: false,
				qualityPolicyFingerprint: TRANSCRIPTION_POLICY_FINGERPRINT,
				modelSha256:
					status === "NO_AUDIO" ? null : (input.model?.sha256 ?? null),
				fingerprint: hashEditingEvidence({ ...key, status, warning }),
			};
		},
		/** Projection of already-admitted data; cached describes THIS read, never original ASR history. */
		ready: (loaded: {
			value: LocalStoryLegacyTranscriptStoredValue;
			valueHash: string;
			cached: boolean;
			includeSpeechIntervals?: boolean;
		}): LocalStoryLegacyTranscriptPrepared => {
			if (!model)
				throw new LocalStoryLegacyTranscriptError("ASR_MODEL_CHANGED");
			return {
				segments: loaded.value.segments,
				...(loaded.includeSpeechIntervals
					? { speechIntervals: structuredClone(loaded.value.speechIntervals) }
					: {}),
				status: "READY",
				fingerprint: loaded.valueHash,
				warnings: loaded.value.warnings,
				modelSha256: model.sha256,
				cached: loaded.cached,
				qualityPolicyFingerprint: TRANSCRIPTION_POLICY_FINGERPRINT,
			};
		},
	};
}
export type LocalStoryLegacyTranscriptRecipe = ReturnType<
	typeof createLocalStoryLegacyTranscriptRecipe
>;
export type LocalStoryLegacyTranscriptKey =
	LocalStoryLegacyTranscriptRecipe["key"];
