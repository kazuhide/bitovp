import {
	type CaptionTimingEvidence,
	type CompositionSourceSegment,
	compositionSourceSegmentSchema,
	TRANSCRIPTION_POLICY_FINGERPRINT,
	transcriptionRawSegmentSchema,
	transcriptionSpeechIntervalSchema,
} from "@bitovp/core";
import {
	createLocalStoryLegacyTranscriptRecipe,
	LocalStoryLegacyAsrError,
	type LocalStoryLegacyTranscriptAbsence,
	LocalStoryLegacyTranscriptError,
	type LocalStoryLegacyTranscriptPrepared,
	type LocalStoryLegacyTranscriptStoredValue,
} from "@bitovp/core/local-story-flow-server";
import { analysisBudget, MAX_ANALYSIS_DURATION_US } from "./analysis-io";
import type { LocalStoryArtifactStore } from "./local-story-artifacts";
import { MediaOperationError } from "./process";
import {
	transcribeLocalAudio,
	transcriptionCacheKey,
	WHISPER_CPP_VERSION,
} from "./transcription";
import type {
	RawTranscriptSegment,
	SpeechInterval,
} from "./transcription-quality";

export type PreparedLocalStoryTranscript =
	LocalStoryLegacyTranscriptPrepared & {
		/** Opt-in caption metadata; excluded from the historical receipt and fingerprint. */
		language?: string;
		/** Observed windows on the original presentation clock, without language inference. */
		languageWindows?: readonly {
			startUs: number;
			endUs: number;
			language: string;
		}[];
		/** Caption-only projection; never part of the sealed semantic ASR value. */
		captionTimingEvidence?: CaptionTimingEvidence;
	};
type StoredTranscript = LocalStoryLegacyTranscriptStoredValue;
type RetryWarning =
	| "LOCAL_STORY_TRANSCRIPT_SHORT_WINDOWS"
	| "LOCAL_STORY_TRANSCRIPT_WINDOW_BOUNDARIES";

const RETRY_POLICY_VERSION = "strict-invalid-30s-10s-v1";
const MAX_ATTEMPTS = 500;
const TOTAL_BUDGET_MS = 30 * 60_000;
const warningCodes = new Set([
	"NO_SPEECH",
	"WORD_ALIGNMENT_UNAVAILABLE",
	"SEGMENT_END_CLAMPED",
	"LOCAL_STORY_TRANSCRIPT_WINDOW_BOUNDARIES",
	"LOCAL_STORY_TRANSCRIPT_SHORT_WINDOWS",
]);
const check = (signal: AbortSignal) => {
	if (signal.aborted) throw new MediaOperationError("CANCELED");
};
function shiftRaw(
	segment: RawTranscriptSegment,
	delta: number,
): RawTranscriptSegment {
	return {
		...segment,
		startUs: segment.startUs + delta,
		endUs: segment.endUs + delta,
		...(segment.tokens
			? {
					tokens: segment.tokens.map((t) => ({
						...t,
						...(t.startUs !== undefined && t.endUs !== undefined
							? { startUs: t.startUs + delta, endUs: t.endUs + delta }
							: {}),
					})),
				}
			: {}),
	};
}
class TranscriptUnavailable extends Error {
	constructor(
		readonly warning: Extract<
			LocalStoryLegacyTranscriptAbsence,
			{ status: "UNAVAILABLE" }
		>["warning"],
	) {
		super(warning);
	}
}

function legacyTranscript<T>(read: () => T): T {
	try {
		return read();
	} catch (error) {
		if (
			error instanceof LocalStoryLegacyTranscriptError ||
			error instanceof LocalStoryLegacyAsrError
		)
			throw new MediaOperationError(error.code);
		throw error;
	}
}

/** Whole-source ASR for semantic input; each decoder request stays within the existing 180s bound. */
export async function prepareLocalStoryTranscript(input: {
	store: LocalStoryArtifactStore;
	sourcePath: string;
	mediaSha256: string;
	timeMap: unknown;
	model?: { path: string; sha256: string };
	language: "ja" | "en" | "auto";
	signal: AbortSignal;
	onProgress?(progress: {
		completedWindows: number;
		totalWindows: number;
	}): void | Promise<void>;
	ffmpegPath?: string;
	hasAudio: boolean;
	includeSpeechIntervals?: boolean;
	includeCaptionLanguage?: boolean;
}): Promise<PreparedLocalStoryTranscript> {
	check(input.signal);
	const recipe = legacyTranscript(() =>
		createLocalStoryLegacyTranscriptRecipe({
			mediaSha256: input.mediaSha256,
			timeMap: input.timeMap,
			configuredModel: input.model ? { sha256: input.model.sha256 } : null,
			language: input.language,
		}),
	);
	const { timeMap: map, durationUs, key, totalWindows } = recipe;
	const retryWarnings = new Set<RetryWarning>();
	const absent = (
		reason: LocalStoryLegacyTranscriptAbsence,
	): PreparedLocalStoryTranscript =>
		legacyTranscript(() => recipe.absent(reason, [...retryWarnings]));
	if (!input.hasAudio)
		return absent({ status: "NO_AUDIO", warning: "SOURCE_HAS_NO_AUDIO" });
	if (!input.model)
		return absent({
			status: "UNAVAILABLE",
			warning: "ASR_MODEL_NOT_CONFIGURED",
		});
	const model = { ...input.model },
		budget = analysisBudget(input.signal, TOTAL_BUDGET_MS);
	const validLanguage = (language: string, hasSegments: boolean) =>
		/^[a-z]{2,3}$/.test(language) &&
		(input.language === "auto"
			? language !== "und" || !hasSegments
			: language === input.language);
	const parse = (value: unknown): StoredTranscript =>
		legacyTranscript(() => recipe.parse(value));
	try {
		const loaded = await input.store.load({
			kind: "LOCAL_STORY_TRANSCRIPT_V1",
			key,
			parse,
			recoverLegacyTranscriptValue: (value) =>
				legacyTranscript(() => recipe.recoverLegacyDerivedMean(value)),
			build: async () => {
				const segments: CompositionSourceSegment[] = [],
					rawSegments: RawTranscriptSegment[] = [],
					speechIntervals: SpeechInterval[] = [],
					mediaWindows: StoredTranscript["mediaWindows"] = [];
				const warnings = new Set<string>();
				if (totalWindows > 1)
					warnings.add("LOCAL_STORY_TRANSCRIPT_WINDOW_BOUNDARIES");
				await input.onProgress?.({ completedWindows: 0, totalWindows });
				let attempts = 0;
				const decodeWindow = async (
					offset: number,
					length: number,
				): Promise<void> => {
					check(input.signal);
					if (++attempts > MAX_ATTEMPTS)
						throw new TranscriptUnavailable("ASR_UNAVAILABLE");
					let result: Awaited<ReturnType<typeof transcribeLocalAudio>>;
					try {
						result = await transcribeLocalAudio({
							sourcePath: input.sourcePath,
							mediaSha256: input.mediaSha256,
							model,
							language: input.language,
							sourceStartUs: offset,
							durationUs: length,
							timeoutMs: Math.min(10 * 60_000, budget.remaining()),
							signal: input.signal,
							...(input.ffmpegPath ? { ffmpegPath: input.ffmpegPath } : {}),
						});
					} catch (error) {
						check(input.signal);
						if (
							error instanceof MediaOperationError &&
							[
								"MODEL_CHANGED",
								"SOURCE_CHANGED",
								"ASR_MODEL_CHANGED",
								"CANCELED",
								"LEASE_LOST",
							].includes(error.code)
						)
							throw new MediaOperationError(error.code);
						if (
							error instanceof MediaOperationError &&
							error.code === "TRANSCRIPT_INVALID" &&
							length > 10_000_000
						) {
							const childLength = length > 30_000_000 ? 30_000_000 : 10_000_000;
							for (const warning of [
								"LOCAL_STORY_TRANSCRIPT_SHORT_WINDOWS",
								"LOCAL_STORY_TRANSCRIPT_WINDOW_BOUNDARIES",
							] as const) {
								warnings.add(warning);
								retryWarnings.add(warning);
							}
							// Re-run the actual audio, never extend a zero-length timestamp or
							// discard an invalid child. Only complete strict coverage is published.
							for (
								let child = offset;
								child < offset + length;
								child += childLength
							)
								await decodeWindow(
									child,
									Math.min(childLength, offset + length - child),
								);
							return;
						}
						throw new TranscriptUnavailable("ASR_UNAVAILABLE");
					}
					check(input.signal);
					if (result.modelSha256 !== model.sha256)
						throw new MediaOperationError("ASR_MODEL_CHANGED");
					if (result.mediaSha256 !== input.mediaSha256)
						throw new MediaOperationError("SOURCE_CHANGED");
					if (
						result.schemaVersion !== 1 ||
						result.engine !== "whisper.cpp" ||
						result.engineVersion !== WHISPER_CPP_VERSION ||
						result.qualityPolicyFingerprint !==
							TRANSCRIPTION_POLICY_FINGERPRINT ||
						result.cacheKey !==
							transcriptionCacheKey({
								mediaSha256: input.mediaSha256,
								modelSha256: model.sha256,
								language: input.language,
								durationUs: length,
								sourceStartUs: offset,
							}) ||
						!Array.isArray(result.segments) ||
						!validLanguage(result.language, result.segments.length > 0) ||
						!Array.isArray(result.warnings) ||
						!result.warnings.every((w) => warningCodes.has(w)) ||
						(result.language === "und" &&
							!result.warnings.includes("NO_SPEECH"))
					)
						throw new TranscriptUnavailable("TRANSCRIPT_INVALID");
					budget.check();
					const observed = compositionSourceSegmentSchema
						.array()
						.max(5000)
						.safeParse(result.segments);
					if (
						!observed.success ||
						observed.data.some(
							(s) => s.startUs < offset || s.endUs > offset + length,
						)
					)
						throw new TranscriptUnavailable("TRANSCRIPT_INVALID");
					const rawEvidence = transcriptionRawSegmentSchema
						.array()
						.max(5000)
						.safeParse(result.rawSegments);
					const speechEvidence = transcriptionSpeechIntervalSchema
						.array()
						.max(10000)
						.safeParse(result.speechIntervals);
					if (!rawEvidence.success || !speechEvidence.success)
						throw new TranscriptUnavailable("TRANSCRIPT_INVALID");
					for (const raw of rawEvidence.data)
						rawSegments.push(shiftRaw(raw, map.sourceStartUs));
					for (const speech of speechEvidence.data)
						speechIntervals.push({
							startUs: speech.startUs + map.sourceStartUs,
							endUs: speech.endUs + map.sourceStartUs,
						});
					for (const segment of observed.data)
						segments.push({
							...segment,
							startUs: segment.startUs + map.sourceStartUs,
							endUs: segment.endUs + map.sourceStartUs,
							...(segment.words
								? {
										words: segment.words.map((word) => ({
											...word,
											startUs: word.startUs + map.sourceStartUs,
											endUs: word.endUs + map.sourceStartUs,
										})),
									}
								: {}),
						});
					for (const warning of result.warnings) warnings.add(warning);
					mediaWindows.push({
						fromUs: offset,
						toUs: offset + length,
						language: result.language,
					});
				};
				for (
					let offset = 0, completed = 0;
					offset < durationUs;
					offset += MAX_ANALYSIS_DURATION_US
				) {
					await decodeWindow(
						offset,
						Math.min(MAX_ANALYSIS_DURATION_US, durationUs - offset),
					);
					await input.onProgress?.({
						completedWindows: ++completed,
						totalWindows,
					});
				}
				if (segments.length) warnings.delete("NO_SPEECH");
				else warnings.add("NO_SPEECH");
				check(input.signal);
				budget.check();
				try {
					return parse({
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
						warnings: [...warnings],
						mediaWindows,
					});
				} catch (error) {
					throw new TranscriptUnavailable(
						error instanceof MediaOperationError &&
							error.code === "TRANSCRIPT_LIMIT"
							? "TRANSCRIPT_LIMIT"
							: "TRANSCRIPT_INVALID",
					);
				}
			},
		});
		check(input.signal);
		if (loaded.cached)
			await input.onProgress?.({
				completedWindows: totalWindows,
				totalWindows,
			});
		check(input.signal);
		budget.check();
		const prepared = legacyTranscript(() =>
			recipe.ready({
				value: loaded.value,
				valueHash: loaded.hash,
				cached: loaded.cached,
				includeSpeechIntervals: input.includeSpeechIntervals,
			}),
		);
		if (!input.includeCaptionLanguage) return prepared;
		const languageWindows = loaded.value.mediaWindows.map((window) => ({
			startUs: map.sourceStartUs + window.fromUs,
			endUs: map.sourceStartUs + window.toUs,
			language: window.language,
		}));
		const observedLanguage = languageWindows[0]?.language;
		// Preserve the unanimous shortcut while exposing unmodified regional observations.
		return {
			...prepared,
			languageWindows,
			captionTimingEvidence: {
				sourceTimeDomain: loaded.value.sourceTimeDomain,
				mediaSha256: loaded.value.mediaSha256,
				modelSha256: loaded.value.modelSha256,
				qualityPolicyFingerprint: loaded.value.qualityPolicyFingerprint,
				transcriptHash: loaded.hash,
				rawSegments: structuredClone(loaded.value.rawSegments),
				speechIntervals: structuredClone(loaded.value.speechIntervals),
			},
			...((observedLanguage === "ja" || observedLanguage === "en") &&
			languageWindows.every((window) => window.language === observedLanguage)
				? { language: observedLanguage }
				: {}),
		};
	} catch (error) {
		check(input.signal);
		if (error instanceof TranscriptUnavailable)
			return absent({ status: "UNAVAILABLE", warning: error.warning });
		if (error instanceof MediaOperationError && error.code === "TIMED_OUT")
			return absent({ status: "UNAVAILABLE", warning: "ASR_UNAVAILABLE" });
		throw error;
	}
}
