import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TRANSCRIPTION_POLICY_FINGERPRINT } from "@bitovp/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MediaOperationError } from "./process";
import {
	parseWhisperTranscript,
	transcribeLocalAudio,
	transcriptionCacheKey,
} from "./transcription";

const execute = vi.hoisted(() => vi.fn());
vi.mock("./process", async (original) => ({
	...(await original<object>()),
	runMediaProcess: execute,
}));
const dirs: string[] = [];
afterEach(async () => {
	execute.mockReset();
	await Promise.all(
		dirs.splice(0).map((p) => rm(p, { recursive: true, force: true })),
	);
});
const token = (text: string, from: number, to: number, p = 0.95) => ({
	text,
	offsets: { from, to },
	p,
	id: 42,
});
function pcmWave(seconds: number, silent = false) {
	const bytes = Buffer.alloc(44 + seconds * 32_000);
	bytes.write("RIFF");
	bytes.writeUInt32LE(bytes.length - 8, 4);
	bytes.write("WAVEfmt ", 8);
	bytes.writeUInt32LE(16, 16);
	bytes.writeUInt16LE(1, 20);
	bytes.writeUInt16LE(1, 22);
	bytes.writeUInt32LE(16_000, 24);
	bytes.writeUInt32LE(32_000, 28);
	bytes.writeUInt16LE(2, 32);
	bytes.writeUInt16LE(16, 34);
	bytes.write("data", 36);
	bytes.writeUInt32LE(bytes.length - 44, 40);
	if (!silent)
		for (let i = 44; i < bytes.length; i += 2)
			bytes.writeInt16LE((i % 128) * 100 - 6400, i);
	return bytes;
}
function fixture(
	text = " Hello world.",
	tokens = [
		token(" Hello", 0, 500),
		token(" world", 500, 900),
		token(".", 900, 1000),
	],
) {
	return {
		result: { language: "en" },
		transcription: [{ offsets: { from: 0, to: 1000 }, text, tokens }],
	};
}
function qualityFixture(noSpeech = 0.1, probability = 0.95, speech = true) {
	return {
		...fixture(" Hello world.", [
			token(" Hello", 0, 500, probability),
			token(" world", 500, 900, probability),
			token(".", 900, 1000),
		]),
		bitovp_quality: {
			version: "bitovp-mapped-quality-v1",
			vad: true,
			speech_intervals: speech ? [{ offsets: { from: 0, to: 1000 } }] : [],
		},
		transcription: [
			{
				...fixture(" Hello world.", [
					token(" Hello", 0, 500, probability),
					token(" world", 500, 900, probability),
					token(".", 900, 1000),
				]).transcription[0],
				no_speech_probability: noSpeech,
			},
		],
	};
}
function isolatedSpeechFixture(probability = 0.0672157) {
	// Reduced from the saved Caminandes music-only native result. Its low
	// no-speech probability alone incorrectly suggests that this is dialogue.
	return {
		result: { language: "en" },
		bitovp_quality: {
			version: "bitovp-mapped-quality-v1",
			vad: true,
			speech_intervals: [{ offsets: { from: 1380, to: 1760 } }],
		},
		transcription: [
			{
				offsets: { from: 1380, to: 1760 },
				text: " you",
				no_speech_probability: 0.0000192712,
				tokens: [
					token("[_BEG_]", 1380, 1390, 0.882334),
					token(" you", 1380, 1750, probability),
					token("[_TT_100]", 1760, 1770, 0.429663),
				],
			},
		],
	};
}
describe("speech quality admission preserves raw recognition", () => {
	it("admits EOF speech within the fixed VAD window padding and keeps the source clock", () => {
		const raw = qualityFixture();
		raw.bitovp_quality.speech_intervals = [
			{ offsets: { from: 500, to: 1090 } },
		];
		const segment = raw.transcription[0];
		if (!segment) throw new Error("Missing raw fixture");
		segment.offsets = { from: 500, to: 1090 };
		const value = parseWhisperTranscript(raw, 1_066_667, 77_000_037, {
			requireQuality: true,
		});
		expect(value.speechIntervals).toEqual([
			{ startUs: 77_500_037, endUs: 78_066_704 },
		]);
		expect(value.segments[0]).toMatchObject({
			startUs: 77_500_037,
			endUs: 78_066_704,
		});
		expect(value.rawSegments?.[0]?.endUs).toBe(78_090_037);
		expect(value.warnings).toContain("SEGMENT_END_CLAMPED");
	});
	it.each([
		[1_003_000, true],
		[1_002_999, false],
	])("limits native VAD end padding to 37ms (duration %s)", (duration, valid) => {
		const raw = qualityFixture();
		raw.bitovp_quality.speech_intervals = [{ offsets: { from: 0, to: 1040 } }];
		const parse = () =>
			parseWhisperTranscript(raw, duration, 0, { requireQuality: true });
		if (valid) expect(parse().speechIntervals?.[0]?.endUs).toBe(duration);
		else expect(parse).toThrow("TRANSCRIPT_QUALITY_INVALID");
	});
	it("rejects VAD speech entirely beyond the real audio even within padding", () => {
		const raw = qualityFixture();
		raw.bitovp_quality.speech_intervals = [
			{ offsets: { from: 1000, to: 1030 } },
		];
		expect(() =>
			parseWhisperTranscript(raw, 1_000_000, 0, { requireQuality: true }),
		).toThrow("TRANSCRIPT_QUALITY_INVALID");
	});
	it("withholds the observed isolated music hallucination while retaining its raw evidence", () => {
		const value = parseWhisperTranscript(
			isolatedSpeechFixture(),
			20_000_000,
			0,
			{
				requireQuality: true,
			},
		);
		expect(value.segments).toEqual([]);
		expect(value.speechIntervals).toEqual([
			{ startUs: 1_380_000, endUs: 1_760_000 },
		]);
		expect(value.rawSegments?.[0]).toMatchObject({
			text: " you",
			quality: {
				noSpeechProbability: 0.0000192712,
				speechOverlapUs: 380_000,
				decision: "ISOLATED_LOW_CONFIDENCE",
			},
		});
		expect(value.rawSegments?.[0]?.tokens?.[1]?.p).toBe(0.0672157);
		expect(value.rawSegments?.[0]?.quality.meanTokenLogProbability).toBeCloseTo(
			-2.699848427788113,
		);
		expect(value.warnings).toContain("NO_SPEECH");
	});
	it("keeps short confident speech even when recorded word alignment is unavailable", () => {
		const raw = isolatedSpeechFixture(0.95);
		const lexical = raw.transcription[0]?.tokens[1];
		if (!lexical) throw new Error("Missing raw fixture");
		lexical.offsets = { from: 0, to: 0 };
		const value = parseWhisperTranscript(raw, 20_000_000, 0, {
			requireQuality: true,
		});
		expect(value.segments[0]?.text).toBe(" you");
		expect(value.segments[0]?.words).toBeUndefined();
		expect(value.rawSegments?.[0]?.quality.decision).toBe("ADMITTED");
	});
	it.each([
		"nearby-speech",
		"long-vad",
	])("keeps weak short speech when broader speech evidence exists (%s)", (change) => {
		const raw = isolatedSpeechFixture();
		if (change === "nearby-speech")
			raw.bitovp_quality.speech_intervals.unshift({
				offsets: { from: 300, to: 1000 },
			});
		else
			raw.bitovp_quality.speech_intervals = [
				{ offsets: { from: 1000, to: 2000 } },
			];
		const value = parseWhisperTranscript(raw, 20_000_000, 0, {
			requireQuality: true,
		});
		expect(value.segments[0]?.text).toBe(" you");
		expect(value.rawSegments?.[0]?.quality.decision).toBe("ADMITTED");
	});
	it.each([
		"confidence-boundary",
		"duration-boundary",
		"gap-boundary",
	])("does not withhold isolated speech outside the complete weak-evidence gate (%s)", (change) => {
		const raw = isolatedSpeechFixture(
			change === "confidence-boundary" ? Math.exp(-2) : undefined,
		);
		if (change === "duration-boundary")
			raw.bitovp_quality.speech_intervals = [
				{ offsets: { from: 1380, to: 1881 } },
			];
		if (change === "gap-boundary")
			raw.bitovp_quality.speech_intervals.unshift({
				offsets: { from: 300, to: 880 },
			});
		const value = parseWhisperTranscript(raw, 20_000_000, 0, {
			requireQuality: true,
		});
		expect(value.segments[0]?.text).toBe(" you");
		expect(value.rawSegments?.[0]?.quality.decision).toBe("ADMITTED");
	});
	it("keeps non-speech recognition as raw evidence and emits no caption", () => {
		const value = parseWhisperTranscript(
			qualityFixture(0.1, 0.95, false),
			2_000_000,
			0,
			{ requireQuality: true },
		);
		expect(value.segments).toEqual([]);
		expect(value.rawSegments?.[0]).toMatchObject({
			text: " Hello world.",
			quality: { decision: "NO_VAD_SPEECH" },
		});
		expect(value.warnings).toContain("NO_SPEECH");
	});
	it("rejects high no-speech probability combined with weak lexical evidence", () => {
		const value = parseWhisperTranscript(
			qualityFixture(0.95, 0.1),
			2_000_000,
			0,
			{ requireQuality: true },
		);
		expect(value.segments).toEqual([]);
		expect(value.rawSegments?.[0]?.quality.decision).toBe(
			"NO_SPEECH_LOW_CONFIDENCE",
		);
	});
	it("keeps quiet supported dialogue despite a low individual token confidence", () => {
		const value = parseWhisperTranscript(
			qualityFixture(0.1, 0.1),
			2_000_000,
			0,
			{ requireQuality: true },
		);
		expect(value.segments[0]?.text).toBe(" Hello world.");
		expect(value.segments[0]?.words).toBeUndefined();
		expect(value.rawSegments?.[0]?.quality.decision).toBe("ADMITTED");
	});
	it("does not let low-confidence control tokens reject supported speech", () => {
		const raw = qualityFixture(0.95, 0.95);
		raw.transcription[0]?.tokens?.unshift(token("[_BEG_]", 0, 0, 0.0001));
		const value = parseWhisperTranscript(raw, 2_000_000, 0, {
			requireQuality: true,
		});
		expect(value.segments).toHaveLength(1);
		expect(value.rawSegments?.[0]?.quality.decision).toBe("ADMITTED");
	});
	it("does not invent word alignment for VAD tokens left on a compressed clock", () => {
		const raw = qualityFixture();
		const segment = raw.transcription[0];
		if (!segment) throw new Error("Missing raw fixture");
		segment.offsets = { from: 10000, to: 11000 };
		raw.bitovp_quality.speech_intervals = [
			{ offsets: { from: 10000, to: 11000 } },
		];
		const value = parseWhisperTranscript(raw, 12_000_000, 0, {
			requireQuality: true,
		});
		expect(value.segments[0]?.words).toBeUndefined();
		expect(value.rawSegments?.[0]?.tokens?.[0]?.startUs).toBe(0);
		expect(value.warnings).toContain("WORD_ALIGNMENT_UNAVAILABLE");
	});
	it("refuses old or unqualified JSON when current quality evidence is required", () => {
		expect(() =>
			parseWhisperTranscript(fixture(), 2_000_000, 0, { requireQuality: true }),
		).toThrow("TRANSCRIPT_QUALITY_INVALID");
	});
	it.each([
		"overlap",
		"outside",
		"old-exporter",
		"vad-off",
	])("rejects malformed VAD evidence %s", (change) => {
		const raw = qualityFixture();
		if (change === "overlap")
			raw.bitovp_quality.speech_intervals.push({
				offsets: { from: 500, to: 1500 },
			});
		else if (change === "outside")
			raw.bitovp_quality.speech_intervals[0] = {
				offsets: { from: 0, to: 3000 },
			};
		else if (change === "old-exporter") raw.bitovp_quality.version = "old";
		else raw.bitovp_quality.vad = false;
		expect(() =>
			parseWhisperTranscript(raw, 2_000_000, 0, { requireQuality: true }),
		).toThrow("TRANSCRIPT_QUALITY_INVALID");
	});
	it("keeps original token probabilities and uses mapped original clock exactly once", () => {
		const raw = qualityFixture();
		const segment = raw.transcription[0];
		if (!segment?.offsets || !segment.tokens)
			throw new Error("Missing raw fixture");
		segment.offsets = { from: 10000, to: 11000 };
		for (const t of segment.tokens) {
			t.offsets.from += 10000;
			t.offsets.to += 10000;
		}
		raw.bitovp_quality.speech_intervals = [
			{ offsets: { from: 10000, to: 11000 } },
		];
		const value = parseWhisperTranscript(raw, 12_000_000, 77_000_000, {
			requireQuality: true,
		});
		expect(value.segments[0]?.words?.[0]?.startUs).toBe(87_000_000);
		expect(value.rawSegments?.[0]?.tokens?.[0]).toMatchObject({
			startUs: 87_000_000,
			endUs: 87_500_000,
			p: 0.95,
		});
	});
	it("binds cache identity to quality policy independently of unchanged ASR weights", () => {
		const input = {
			mediaSha256: "a".repeat(64),
			modelSha256: "b".repeat(64),
			language: "en",
			durationUs: 2_000_000,
		};
		expect(
			transcriptionCacheKey({
				...input,
				qualityPolicyFingerprint: TRANSCRIPTION_POLICY_FINGERPRINT,
			}),
		).not.toBe(
			transcriptionCacheKey({
				...input,
				qualityPolicyFingerprint: "c".repeat(64),
			}),
		);
	});
});
describe("real Whisper timestamp admission", () => {
	it("keeps segment text and only exact lexical token boundaries with UTF-16 offsets", () => {
		const value = parseWhisperTranscript(fixture(), 2_000_000, 3_000_000);
		expect(value.segments[0]).toEqual({
			startUs: 3_000_000,
			endUs: 4_000_000,
			text: " Hello world.",
			words: [
				{
					text: "Hello",
					startChar: 1,
					endChar: 6,
					startUs: 3_000_000,
					endUs: 3_500_000,
					confidence: 0.95,
				},
				{
					text: "world",
					startChar: 7,
					endChar: 12,
					startUs: 3_500_000,
					endUs: 3_900_000,
					confidence: 0.95,
				},
			],
		});
	});
	it("preserves Japanese verbatim and never divides one token into invented word times", () => {
		const raw = fixture("こんにちは世界。", [
			token("こんにちは世界。", 0, 1000),
		]);
		raw.result.language = "ja";
		const value = parseWhisperTranscript(raw, 2_000_000);
		expect(value.segments[0]?.text).toBe("こんにちは世界。");
		expect(value.segments[0]?.words).toBeUndefined();
		expect(value.warnings).toContain("WORD_ALIGNMENT_UNAVAILABLE");
	});
	it("bounds a real model's short audio-tail overshoot as segment-only and reports the correction", () => {
		const raw = fixture("字幕と音声を確認してください。", [
			token("字幕と音声を確認してください。", 3800, 7800),
		]);
		raw.result.language = "ja";
		const segment = raw.transcription[0];
		if (!segment) throw new Error("Missing transcript fixture");
		segment.offsets = { from: 3800, to: 7800 };
		const value = parseWhisperTranscript(raw, 7_144_989);
		expect(value.segments[0]).toEqual({
			startUs: 3_800_000,
			endUs: 7_144_989,
			text: "字幕と音声を確認してください。",
		});
		expect(value.warnings).toContain("SEGMENT_END_CLAMPED");
	});
	it.each(
		[
			[token(" wrong", 0, 1000)],
			[
				token(" Hello", 0, 600),
				token(" world", 500, 900),
				token(".", 900, 1000),
			],
			[token(" Hello", -1, 500), token(" world.", 500, 1000)],
			[token(" Hello", 0, 500, 0.1), token(" world.", 500, 1000)],
			[token(" Hello world.", 0, 0)],
			[],
		].map((tokens) => ({ tokens })),
	)("keeps segment-only captions on missing, low-confidence or inconsistent alignment $tokens", ({
		tokens,
	}) => {
		expect(
			parseWhisperTranscript(fixture(" Hello world.", tokens), 2_000_000)
				.segments[0]?.words,
		).toBeUndefined();
	});
	it("merges subword tokens only at observed boundaries", () => {
		const value = parseWhisperTranscript(
			fixture(" Testing", [token(" Test", 0, 400), token("ing", 400, 1000)]),
			2_000_000,
		);
		expect(value.segments[0]?.words).toEqual([
			{
				text: "Testing",
				startChar: 1,
				endChar: 8,
				startUs: 0,
				endUs: 1_000_000,
				confidence: 0.95,
			},
		]);
	});
	it("ignores model control tokens without using their timestamps as speech", () => {
		const raw = fixture();
		raw.transcription[0]?.tokens.unshift(token("[_BEG_]", 0, 0));
		expect(
			parseWhisperTranscript(raw, 2_000_000).segments[0]?.words,
		).toHaveLength(2);
	});
	it("ignores low-probability timestamp controls and unspoken punctuation in lexical confidence", () => {
		const raw = fixture();
		const segment = raw.transcription[0];
		const punctuation = segment?.tokens[2];
		if (!segment || !punctuation) throw new Error("Missing transcript fixture");
		punctuation.p = 0.01;
		segment.tokens.push(token("[_TT_550]", 1100, 1100, 0.01));
		expect(
			parseWhisperTranscript(raw, 2_000_000).segments[0]?.words,
		).toHaveLength(2);
	});
	it.each([
		{
			result: { language: "en" },
			transcription: [{ text: "bad", offsets: { from: 900, to: 300 } }],
		},
		{
			result: { language: "en" },
			transcription: [{ text: "bad", offsets: { from: 0, to: 3000 } }],
		},
		{
			result: { language: "en" },
			transcription: [{ text: "bad", offsets: { from: -1, to: 500 } }],
		},
		{
			result: { language: "en" },
			transcription: [{ text: "bad", offsets: { from: 0.1, to: 500 } }],
		},
		{ result: { language: "en" }, transcription: "invented" },
	])("rejects malformed segment timing instead of repairing it %j", (raw) => {
		expect(() => parseWhisperTranscript(raw, 2_000_000)).toThrow(
			"TRANSCRIPT_INVALID",
		);
	});
	it("returns honest no-speech rather than fabricating empty timed captions", () => {
		expect(
			parseWhisperTranscript(
				{ result: { language: "ja" }, transcription: [] },
				2_000_000,
			),
		).toEqual({ language: "ja", segments: [], warnings: ["NO_SPEECH"] });
	});
	it("binds the cache to bytes, model identity, language and source interval", () => {
		const input = {
			mediaSha256: "a".repeat(64),
			modelSha256: "b".repeat(64),
			language: "ja",
			durationUs: 2_000_000,
			sourceStartUs: 0,
		};
		const base = transcriptionCacheKey(input);
		for (const delta of [
			{ mediaSha256: "c".repeat(64) },
			{ modelSha256: "c".repeat(64) },
			{ language: "en" },
			{ sourceStartUs: 1_000_000 },
			{ durationUs: 3_000_000 },
		])
			expect(transcriptionCacheKey({ ...input, ...delta })).not.toBe(base);
	});
});

describe("offline transcription adapter", () => {
	async function setup() {
		const dir = await mkdtemp(join(tmpdir(), "bitovp-asr-test-"));
		dirs.push(dir);
		const sourcePath = join(dir, "source.mp4"),
			modelPath = join(dir, "model.bin"),
			vadPath = join(dir, "vad.bin");
		await writeFile(sourcePath, "owned source");
		await writeFile(modelPath, "owned model");
		await writeFile(vadPath, "owned vad");
		const digest = (s: string) => createHash("sha256").update(s).digest("hex");
		const input = {
			sourcePath,
			mediaSha256: digest("owned source"),
			durationUs: 2_000_000,
			language: "en" as const,
			model: { path: modelPath, sha256: digest("owned model") },
			vadModel: { path: vadPath, sha256: digest("owned vad") },
		};
		let scratch = "";
		let pcmBytes: Buffer = pcmWave(2);
		execute.mockImplementation(async (_binary: string, args: string[]) => {
			if (args.includes("--version"))
				return { stdout: "whisper.cpp version: 1.9.5\n", stderr: "" };
			if (args.includes("-of")) {
				const prefix = args[args.indexOf("-of") + 1];
				await writeFile(`${prefix}.json`, JSON.stringify(qualityFixture()));
			} else {
				scratch = args.at(-1) ?? "";
				await writeFile(scratch, pcmBytes);
			}
			return { stdout: "", stderr: "" };
		});
		return {
			input,
			scratch: () => scratch,
			audio: (value: Buffer) => {
				pcmBytes = value;
			},
		};
	}
	it("executes owned PCM preparation and pinned CPU CLI, and removes its scratch", async () => {
		const f = await setup();
		const result = await transcribeLocalAudio(f.input);
		expect(result.engine).toBe("whisper.cpp");
		expect(result.engineVersion).toBe("1.9.5");
		expect(result.segments[0]?.words).toHaveLength(2);
		const decode = execute.mock.calls.find(([, args]) =>
			args.includes("pcm_s16le"),
		);
		expect(decode?.[1]).toEqual(
			expect.arrayContaining([
				"16000",
				"1",
				"-nostdin",
				"-protocol_whitelist",
				"file,pipe",
			]),
		);
		const infer = execute.mock.calls.find(([, args]) => args.includes("-ojf"));
		expect(infer?.[1]).toEqual(
			expect.arrayContaining(["-ng", "-p", "1", "-nf", "-l", "en"]),
		);
		await expect(readFile(f.scratch())).rejects.toThrow();
	});
	it("rejects changed model/media bytes before invoking any process", async () => {
		const f = await setup();
		await writeFile(f.input.model.path, "changed");
		await expect(transcribeLocalAudio(f.input)).rejects.toMatchObject({
			code: "MODEL_CHANGED",
		});
		expect(execute).not.toHaveBeenCalled();
	});
	it("rejects an unexpected CLI version", async () => {
		const f = await setup();
		execute.mockResolvedValue({
			stdout: "whisper.cpp version: 0.0.0",
			stderr: "",
		});
		await expect(transcribeLocalAudio(f.input)).rejects.toMatchObject({
			code: "ASR_VERSION_MISMATCH",
		});
	});
	it("refuses changed VAD bytes before the decoder runs", async () => {
		const f = await setup();
		await writeFile(f.input.vadModel.path, "changed vad");
		await expect(transcribeLocalAudio(f.input)).rejects.toMatchObject({
			code: "MODEL_CHANGED",
		});
		expect(execute.mock.calls.some(([, args]) => args.includes("-ojf"))).toBe(
			false,
		);
	});
	it("rejects malformed or truncated PCM before ASR", async () => {
		for (const pcm of [Buffer.alloc(64_044), pcmWave(1)]) {
			const f = await setup();
			f.audio(pcm);
			await expect(transcribeLocalAudio(f.input)).rejects.toMatchObject({
				code: "ASR_AUDIO_INVALID",
			});
			expect(execute.mock.calls.some(([, args]) => args.includes("-ojf"))).toBe(
				false,
			);
			execute.mockClear();
		}
	});
	it("returns no speech from actual silent PCM without invoking the model decoder", async () => {
		const f = await setup();
		f.audio(pcmWave(2, true));
		const value = await transcribeLocalAudio(f.input);
		expect(value.segments).toEqual([]);
		expect(value.warnings).toEqual(["NO_SPEECH"]);
		expect(execute.mock.calls.some(([, args]) => args.includes("-ojf"))).toBe(
			false,
		);
	});
	it("honors cancellation before source reads or processes", async () => {
		const f = await setup();
		const controller = new AbortController();
		controller.abort();
		await expect(
			transcribeLocalAudio({ ...f.input, signal: controller.signal }),
		).rejects.toMatchObject({ code: "CANCELED" });
		expect(execute).not.toHaveBeenCalled();
	});
});

describe("shared JSON parser worker error compatibility", () => {
	it.each([
		{ raw: {}, code: "TRANSCRIPT_INVALID" },
		{
			raw: { result: { language: "en" }, transcription: [] },
			code: "TRANSCRIPT_QUALITY_INVALID",
		},
	])("retains MediaOperationError for $code", ({ raw, code }) => {
		let observed: unknown;
		try {
			parseWhisperTranscript(raw, 1_000_000, 0, { requireQuality: true });
		} catch (error) {
			observed = error;
		}
		expect(observed).toBeInstanceOf(MediaOperationError);
		expect(observed).toMatchObject({ code, message: code });
	});
});
