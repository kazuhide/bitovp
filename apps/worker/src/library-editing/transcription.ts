import { createHash } from "node:crypto";
import { readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import {
	hashEditingEvidence,
	TRANSCRIPTION_POLICY_FINGERPRINT,
	TRANSCRIPTION_QUALITY_POLICY,
} from "@bitovp/core";
import {
	type LegacyTranscriptSegment,
	type LegacyTranscriptWord,
	LocalStoryLegacyAsrError,
	parseLegacyWhisperTranscript,
} from "@bitovp/core/local-story-flow-server";
import {
	analysisBudget,
	analysisScratch,
	boundedInteger,
	MAX_ANALYSIS_DURATION_US,
	validDigest,
	verifyAnalysisFile,
	verifyAnalysisSourceFile,
	verifyAsrModelFile,
} from "./analysis-io";
import { MediaOperationError, runMediaProcess } from "./process";
import type {
	RawTranscriptSegment,
	SpeechInterval,
} from "./transcription-quality";

export const WHISPER_CPP_VERSION = "1.9.5";
export const BASE_MODEL_SHA256 =
	"60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe";
export type TranscriptWord = LegacyTranscriptWord;
export type TranscriptSegment = LegacyTranscriptSegment;
export type LocalTranscript = {
	schemaVersion: 1;
	engine: "whisper.cpp";
	engineVersion: typeof WHISPER_CPP_VERSION;
	modelSha256: string;
	mediaSha256: string;
	language: string;
	segments: TranscriptSegment[];
	warnings: string[];
	cacheKey: string;
	qualityPolicyFingerprint: string;
	rawSegments: RawTranscriptSegment[];
	speechIntervals: SpeechInterval[];
};
export type TranscriptionInput = {
	sourcePath: string;
	mediaSha256: string;
	durationUs: number;
	sourceStartUs?: number;
	language: "ja" | "en" | "auto";
	model: { path: string; sha256: string };
	vadModel?: { path: string; sha256: string };
	whisperPath?: string;
	ffmpegPath?: string;
	threads?: number;
	timeoutMs?: number;
	signal?: AbortSignal;
};
/** Compatibility wrapper: keep worker exception classes while sharing only pure JSON rules. */
export function parseWhisperTranscript(
	raw: unknown,
	durationUs: number,
	sourceStartUs = 0,
	options: { requireQuality?: boolean } = {},
): Pick<LocalTranscript, "language" | "segments" | "warnings"> &
	Partial<Pick<LocalTranscript, "rawSegments" | "speechIntervals">> {
	try {
		return parseLegacyWhisperTranscript(
			raw,
			durationUs,
			sourceStartUs,
			options,
		);
	} catch (error) {
		if (error instanceof LocalStoryLegacyAsrError)
			throw new MediaOperationError(error.code);
		throw error;
	}
}
export function transcriptionCacheKey(input: {
	mediaSha256: string;
	modelSha256: string;
	language: string;
	durationUs: number;
	sourceStartUs?: number;
	qualityPolicyFingerprint?: string;
}) {
	return createHash("sha256")
		.update(
			JSON.stringify({
				version: "whisper-transcription-v1",
				engineVersion: WHISPER_CPP_VERSION,
				qualityPolicyFingerprint:
					input.qualityPolicyFingerprint ?? TRANSCRIPTION_POLICY_FINGERPRINT,
				mediaSha256: input.mediaSha256,
				modelSha256: input.modelSha256,
				language: input.language,
				durationUs: input.durationUs,
				sourceStartUs: input.sourceStartUs ?? 0,
			}),
		)
		.digest("hex");
}

/** Verify the file ffmpeg actually produced, including complete interval coverage. */
function pcmEvidence(bytes: Buffer, durationUs: number) {
	const invalid = () => {
		throw new MediaOperationError("ASR_AUDIO_INVALID");
	};
	if (
		bytes.length < 44 ||
		bytes.toString("ascii", 0, 4) !== "RIFF" ||
		bytes.toString("ascii", 8, 12) !== "WAVE" ||
		bytes.readUInt32LE(4) + 8 !== bytes.length
	)
		return invalid();
	let format = false,
		audio: Buffer | undefined;
	for (let offset = 12; offset + 8 <= bytes.length; ) {
		const type = bytes.toString("ascii", offset, offset + 4),
			size = bytes.readUInt32LE(offset + 4),
			start = offset + 8;
		if (size > bytes.length - start) return invalid();
		if (type === "fmt ") {
			if (
				size < 16 ||
				bytes.readUInt16LE(start) !== 1 ||
				bytes.readUInt16LE(start + 2) !== 1 ||
				bytes.readUInt32LE(start + 4) !== 16_000 ||
				bytes.readUInt32LE(start + 8) !== 32_000 ||
				bytes.readUInt16LE(start + 12) !== 2 ||
				bytes.readUInt16LE(start + 14) !== 16
			)
				return invalid();
			format = true;
		} else if (type === "data") {
			if (audio) return invalid();
			audio = bytes.subarray(start, start + size);
		}
		offset = start + size + (size % 2);
	}
	if (
		!format ||
		!audio ||
		audio.length % 2 ||
		Math.abs(audio.length / 2 - Math.round(durationUs * 0.016)) > 2
	)
		return invalid();
	let peak = 0;
	for (let index = 0; index < audio.length; index += 2)
		peak = Math.max(peak, Math.abs(audio.readInt16LE(index)));
	return { silent: peak <= 2 };
}

/** Offline CPU adapter. Model provisioning is a separate, explicit setup action. */
export async function transcribeLocalAudio(
	input: TranscriptionInput,
): Promise<LocalTranscript> {
	const durationUs = boundedInteger(
		input.durationUs,
		1,
		MAX_ANALYSIS_DURATION_US,
	);
	const sourceStartUs = boundedInteger(
		input.sourceStartUs ?? 0,
		0,
		Number.MAX_SAFE_INTEGER - durationUs,
	);
	const threads = boundedInteger(input.threads ?? 4, 1, 8);
	const vadModel = input.vadModel ?? {
		path:
			process.env.WHISPER_VAD_MODEL_PATH ??
			"/editing-models/ggml-silero-v6.2.0.bin",
		sha256: TRANSCRIPTION_QUALITY_POLICY.vadModelSha256,
	};
	if (!validDigest(vadModel.sha256))
		throw new RangeError("Invalid VAD identity");
	const qualityPolicyFingerprint =
		vadModel.sha256 === TRANSCRIPTION_QUALITY_POLICY.vadModelSha256
			? TRANSCRIPTION_POLICY_FINGERPRINT
			: hashEditingEvidence({
					...TRANSCRIPTION_QUALITY_POLICY,
					vadModelSha256: vadModel.sha256,
				});
	if (
		!["ja", "en", "auto"].includes(input.language) ||
		!validDigest(input.mediaSha256)
	)
		throw new RangeError("Invalid transcription identity");
	const budget = analysisBudget(input.signal, input.timeoutMs ?? 10 * 60_000);
	await verifyAsrModelFile(
		input.model.path,
		input.model.sha256,
		"MODEL_CHANGED",
		budget,
	);
	await verifyAnalysisSourceFile(
		input.sourcePath,
		input.mediaSha256,
		"SOURCE_CHANGED",
		budget,
	);
	const binary =
		input.whisperPath ?? process.env.WHISPER_CLI_PATH ?? "whisper-cli";
	const version = await runMediaProcess(binary, ["--version"], {
		signal: input.signal,
		timeoutMs: Math.min(10_000, budget.remaining()),
		maxOutputBytes: 4096,
	});
	if (version.stdout.trim() !== `whisper.cpp version: ${WHISPER_CPP_VERSION}`)
		throw new MediaOperationError("ASR_VERSION_MISMATCH");
	const directory = await analysisScratch("bitovp-asr-");
	const finish = (
		result: Pick<LocalTranscript, "language" | "segments" | "warnings"> &
			Partial<Pick<LocalTranscript, "rawSegments" | "speechIntervals">>,
	): LocalTranscript => ({
		schemaVersion: 1,
		engine: "whisper.cpp",
		engineVersion: WHISPER_CPP_VERSION,
		modelSha256: input.model.sha256,
		mediaSha256: input.mediaSha256,
		qualityPolicyFingerprint,
		rawSegments: result.rawSegments ?? [],
		speechIntervals: result.speechIntervals ?? [],
		...result,
		cacheKey: transcriptionCacheKey({
			...input,
			modelSha256: input.model.sha256,
			qualityPolicyFingerprint,
		}),
	});
	try {
		const pcm = join(directory, "audio.wav"),
			prefix = join(directory, "transcript");
		// Official CLI requires 16 kHz mono signed 16-bit PCM. Keep ffmpeg local.
		// https://github.com/ggml-org/whisper.cpp/tree/v1.9.5#quick-start
		await runMediaProcess(
			input.ffmpegPath ?? process.env.FFMPEG_PATH ?? "ffmpeg",
			[
				"-nostdin",
				"-hide_banner",
				"-loglevel",
				"error",
				"-threads",
				"1",
				"-protocol_whitelist",
				"file,pipe",
				"-ss",
				(sourceStartUs / 1_000_000).toFixed(6),
				"-i",
				input.sourcePath,
				"-map",
				"0:a:0",
				"-vn",
				"-t",
				(durationUs / 1_000_000).toFixed(6),
				"-ac",
				"1",
				"-ar",
				"16000",
				"-c:a",
				"pcm_s16le",
				"-fs",
				String(Math.ceil(durationUs * 0.032) + 4096),
				"-y",
				pcm,
			],
			{
				signal: input.signal,
				timeoutMs: budget.remaining(),
				maxOutputBytes: 1024 * 1024,
			},
		);
		const wav = await stat(pcm);
		if (wav.size < 44 || wav.size > Math.ceil(durationUs * 0.032) + 4096)
			throw new MediaOperationError("ASR_AUDIO_INVALID");
		const audio = pcmEvidence(await readFile(pcm), durationUs);
		if (audio.silent)
			return finish({
				language: input.language === "auto" ? "und" : input.language,
				segments: [],
				warnings: ["NO_SPEECH"],
			});
		await verifyAnalysisFile(
			vadModel.path,
			vadModel.sha256,
			"MODEL_CHANGED",
			budget,
		);
		// Full JSON enables the engine's token timestamp calculation. Never
		// manufacture words by dividing segment duration or text length.
		// https://github.com/ggml-org/whisper.cpp/blob/v1.9.5/examples/cli/cli.cpp
		await runMediaProcess(
			binary,
			[
				"-m",
				input.model.path,
				"-f",
				pcm,
				"-l",
				input.language,
				"--vad",
				"-vm",
				vadModel.path,
				"-vt",
				String(TRANSCRIPTION_QUALITY_POLICY.vad.threshold),
				"-vspd",
				String(TRANSCRIPTION_QUALITY_POLICY.vad.minSpeechMs),
				"-vsd",
				String(TRANSCRIPTION_QUALITY_POLICY.vad.minSilenceMs),
				"-vp",
				String(TRANSCRIPTION_QUALITY_POLICY.vad.padMs),
				"-vo",
				String(TRANSCRIPTION_QUALITY_POLICY.vad.overlapSeconds),
				"-nth",
				String(TRANSCRIPTION_QUALITY_POLICY.admission.noSpeechThreshold),
				"-lpt",
				String(TRANSCRIPTION_QUALITY_POLICY.admission.logProbabilityThreshold),
				"-ng",
				"-t",
				String(threads),
				"-p",
				"1",
				"-nf",
				"-tp",
				String(TRANSCRIPTION_QUALITY_POLICY.decoder.temperature),
				"-bs",
				String(TRANSCRIPTION_QUALITY_POLICY.decoder.beamSize),
				"-bo",
				String(TRANSCRIPTION_QUALITY_POLICY.decoder.bestOf),
				"-mc",
				String(TRANSCRIPTION_QUALITY_POLICY.decoder.maxContext),
				"-sns",
				"-ojf",
				"-of",
				prefix,
			],
			{
				signal: input.signal,
				timeoutMs: budget.remaining(),
				maxOutputBytes: 4 * 1024 * 1024,
			},
		);
		const output = `${prefix}.json`;
		if ((await stat(output)).size > 8 * 1024 * 1024)
			throw new MediaOperationError("TRANSCRIPT_LIMIT");
		budget.check();
		const result = parseWhisperTranscript(
			JSON.parse(await readFile(output, "utf8")),
			durationUs,
			sourceStartUs,
			{ requireQuality: true },
		);
		if (input.language !== "auto" && result.language !== input.language)
			throw new MediaOperationError("ASR_LANGUAGE_MISMATCH");
		return finish(result);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}
