import {
	canonicalEditingJson,
	cfrTimeMapSchema,
	hashEditingEvidence,
	TRANSCRIPTION_POLICY_FINGERPRINT,
} from "@bitovp/core";
import type { AppPrismaClient, LibraryMediaTask } from "@bitovp/db";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	createLocalStoryArtifactStore,
	type LocalStoryArtifactStore,
} from "./local-story-artifacts";
import { prepareLocalStoryTranscript } from "./local-story-transcript";
import type { VerifiedMediaTask } from "./media-task-execution";
import { MediaOperationError } from "./process";
import {
	parseWhisperTranscript,
	type TranscriptionInput,
	transcriptionCacheKey,
	WHISPER_CPP_VERSION,
} from "./transcription";

const mocks = vi.hoisted(() => ({
	asr: vi.fn(),
	verify: vi.fn(),
	recipe: vi.fn(),
}));
vi.mock("@bitovp/core/local-story-flow-server", async (original) => {
	const actual =
		await original<typeof import("@bitovp/core/local-story-flow-server")>();
	return {
		...actual,
		createLocalStoryLegacyTranscriptRecipe(
			identity: Parameters<
				typeof actual.createLocalStoryLegacyTranscriptRecipe
			>[0],
		) {
			mocks.recipe(identity);
			return actual.createLocalStoryLegacyTranscriptRecipe(identity);
		},
	};
});
vi.mock("./media-task-execution", () => ({
	verifyMediaTaskEvidence: mocks.verify,
}));
vi.mock("./transcription", async (original) => ({
	...(await original<object>()),
	transcribeLocalAudio: mocks.asr,
}));
function asrResult(input: TranscriptionInput) {
	const start = (input.sourceStartUs ?? 0) + 100_000;
	const result = {
		schemaVersion: 1,
		engine: "whisper.cpp",
		engineVersion: WHISPER_CPP_VERSION,
		modelSha256: input.model.sha256,
		mediaSha256: input.mediaSha256,
		language: input.language === "auto" ? "en" : input.language,
		segments: [
			{
				startUs: start,
				endUs: start + 100_000,
				text: "Hello",
				words: [
					{
						text: "Hello",
						startChar: 0,
						endChar: 5,
						startUs: start,
						endUs: start + 100_000,
						confidence: 0.9,
					},
				],
			},
		],
		warnings: [],
		cacheKey: transcriptionCacheKey({
			...input,
			modelSha256: input.model.sha256,
		}),
	};
	return {
		...result,
		qualityPolicyFingerprint: TRANSCRIPTION_POLICY_FINGERPRINT,
		speechIntervals: [{ startUs: start, endUs: start + 100_000 }],
		rawSegments: [
			{
				startUs: start,
				endUs: start + 100_000,
				text: "Hello",
				tokens: [
					{ text: "Hello", p: 0.9, startUs: start, endUs: start + 100_000 },
				],
				quality: {
					noSpeechProbability: 0.1,
					meanTokenLogProbability: Math.log(0.9),
					speechOverlapUs: 100_000,
					decision: "ADMITTED",
				},
			},
		],
	};
}
function fixture() {
	const values = new Map<string, unknown>(),
		keys: unknown[] = [];
	const store: LocalStoryArtifactStore = {
		async load<T>(request: {
			kind: string;
			key: unknown;
			parse(value: unknown): T;
			build(): Promise<T>;
		}) {
			keys.push(structuredClone(request.key));
			const key = hashEditingEvidence(request.key),
				cached = values.has(key);
			const value = request.parse(
				cached ? values.get(key) : await request.build(),
			);
			if (!cached) values.set(key, structuredClone(value));
			return { value, hash: hashEditingEvidence(value), cached };
		},
	};
	const signal = new AbortController(),
		onProgress = vi.fn(async () => {});
	const timeMap = {
		id: "11111111-1111-4111-8111-111111111111",
		mediaVersionId: "11111111-1111-4111-8111-111111111111",
		kind: "CFR",
		sourceStartUs: 77_000_000,
		sourceEndUs: 811_000_000,
		editingStartFrame: 0,
		editingEndFrame: 22020,
		fps: { num: 30, den: 1 },
	};
	const input = {
		store,
		sourcePath: "/private/source.mp4",
		mediaSha256: "a".repeat(64),
		timeMap,
		model: { path: "/private/model.bin", sha256: "b".repeat(64) },
		language: "en" as const,
		signal: signal.signal,
		onProgress,
		ffmpegPath: "/usr/local/bin/ffmpeg",
		hasAudio: true,
	};
	return { input, values, keys, signal, onProgress, timeMap };
}
beforeEach(() => {
	mocks.recipe.mockClear();
	mocks.verify.mockReset();
	mocks.asr.mockReset();
	mocks.asr.mockImplementation(async (input: TranscriptionInput) =>
		asrResult(input),
	);
});
afterEach(() => vi.restoreAllMocks());

async function legacyRoundedCache(
	language: "en" | "auto" = "en",
	clock?: { sourceOriginUs: number; durationUs: number },
) {
	const f = fixture();
	if (clock) {
		f.timeMap.sourceStartUs = clock.sourceOriginUs;
		f.timeMap.sourceEndUs = clock.sourceOriginUs + clock.durationUs;
		f.timeMap.editingEndFrame = (clock.durationUs * 30) / 1_000_000;
	}
	const task = {
		id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
		organizationId: "00000000-0000-4000-8000-000000000001",
		mediaVersionId: f.timeMap.mediaVersionId,
		analysisRevisionId: null,
		createdBy: "fixture",
	};
	const media = {
		id: task.mediaVersionId,
		organizationId: task.organizationId,
		sourceId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
		sha256: f.input.mediaSha256,
		timeMap: f.timeMap,
	};
	const verified = {
		media,
		envelope: { identity: {} },
	} as unknown as VerifiedMediaTask;
	const rows: Array<Record<string, unknown>> = [];
	const prisma = {
		libraryEvidenceReceipt: {
			findUnique: vi.fn(
				async ({ where }: { where: { id: string } }) =>
					rows.find((r) => r.id === where.id) ?? null,
			),
			create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
				rows.push(structuredClone(data));
				return data;
			}),
		},
		libraryMediaTask: { updateMany: vi.fn(async () => ({ count: 1 })) },
		$executeRaw: vi.fn(async () => 1),
		$transaction: vi.fn(async (fn: (tx: AppPrismaClient) => Promise<unknown>) =>
			fn(prisma as unknown as AppPrismaClient),
		),
	} as unknown as AppPrismaClient;
	mocks.verify.mockResolvedValue(verified);
	const store = createLocalStoryArtifactStore({
		prisma,
		task: task as unknown as LibraryMediaTask,
		verified,
		leaseToken: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
		signal: f.input.signal,
	});
	const input = { ...f.input, store, language };
	const first = await prepareLocalStoryTranscript(input);
	const row = rows[0];
	if (!row) throw Error("missing fixture");
	const written = row.proof as {
		cacheHash: string;
		value?: unknown;
		valueJson?: string;
	};
	const value = written.valueJson
		? JSON.parse(written.valueJson)
		: structuredClone(written.value);
	row.proof = {
		version: "local-story-cache-v1",
		cacheHash: written.cacheHash,
		value,
	};
	row.proofHash = hashEditingEvidence(row.proof);
	for (const segment of value.rawSegments)
		segment.quality.meanTokenLogProbability = Number(
			segment.quality.meanTokenLogProbability.toPrecision(16),
		);
	mocks.asr.mockClear();
	return { input, first, row, rows, prisma };
}
it("recovers legacy derived-confidence transport loss without changing the native receipt or fingerprint", async () => {
	const f = await legacyRoundedCache(),
		persisted = structuredClone(f.row);
	expect(hashEditingEvidence(f.row.proof)).not.toBe(f.row.proofHash);
	const cached = await prepareLocalStoryTranscript(f.input);
	expect(cached).toEqual({ ...f.first, cached: true });
	expect(f.row).toEqual(persisted);
	expect(f.rows).toHaveLength(1);
	expect(mocks.asr).not.toHaveBeenCalled();
});
it("projects caption-only raw timing evidence from the loaded immutable transcript without resealing or decoding", async () => {
	const f = await legacyRoundedCache();
	const persisted = structuredClone(f.row);
	const projected = await prepareLocalStoryTranscript({
		...f.input,
		includeCaptionLanguage: true,
	});
	const timing = projected.captionTimingEvidence;
	expect(timing).toMatchObject({
		sourceTimeDomain: "ORIGINAL_PRESENTATION_US",
		mediaSha256: f.input.mediaSha256,
		modelSha256: f.input.model.sha256,
		qualityPolicyFingerprint: TRANSCRIPTION_POLICY_FINGERPRINT,
		transcriptHash: f.first.fingerprint,
	});
	expect(timing?.transcriptHash).not.toBe(
		hashEditingEvidence(projected.segments),
	);
	expect(timing?.rawSegments[0]).toMatchObject({
		startUs: 77_100_000,
		endUs: 77_200_000,
		text: "Hello",
	});
	expect(timing?.speechIntervals[0]).toEqual({
		startUs: 77_100_000,
		endUs: 77_200_000,
	});
	const expected = structuredClone(timing);
	const token = timing?.rawSegments[0]?.tokens?.[0];
	if (!token) throw new Error("Missing authored raw timing token");
	Object.assign(token, { text: "tampered", startUs: 0 });
	const again = await prepareLocalStoryTranscript({
		...f.input,
		includeCaptionLanguage: true,
	});
	expect(again.captionTimingEvidence).toEqual(expected);
	await expect(
		prepareLocalStoryTranscript({ ...f.input, includeCaptionLanguage: false }),
	).resolves.toEqual({ ...f.first, cached: true });
	expect(f.first).not.toHaveProperty("captionTimingEvidence");
	expect(f.row).toEqual(persisted);
	expect(f.rows).toHaveLength(1);
	expect(mocks.asr).not.toHaveBeenCalled();
});
it.each([
	0, 77_000_000,
])("projects all nine observed windows at original origin %s once without changing a sealed legacy cache", async (sourceOriginUs) => {
	mocks.asr.mockImplementation(async (input: TranscriptionInput) => ({
		...asrResult(input),
		language:
			input.sourceStartUs === 180_000_000 ||
			input.sourceStartUs === 1_260_000_000
				? "ko"
				: "ja",
	}));
	const f = await legacyRoundedCache("auto", {
		sourceOriginUs,
		durationUs: 1_470_000_000,
	});
	const persisted = structuredClone(f.row);
	const projected = await prepareLocalStoryTranscript({
		...f.input,
		includeCaptionLanguage: true,
	});
	const expected = Array.from({ length: 9 }, (_, index) => ({
		startUs: sourceOriginUs + index * 180_000_000,
		endUs: sourceOriginUs + Math.min((index + 1) * 180_000_000, 1_470_000_000),
		language: index === 1 || index === 7 ? "ko" : "ja",
	}));
	expect(projected.languageWindows).toEqual(expected);
	expect(projected).not.toHaveProperty("language");
	const { languageWindows, captionTimingEvidence, ...historical } = projected;
	expect(captionTimingEvidence?.transcriptHash).toBe(f.first.fingerprint);
	expect(historical).toEqual({ ...f.first, cached: true });
	expect(f.first).not.toHaveProperty("languageWindows");
	expect(projected.fingerprint).toBe(f.first.fingerprint);
	const first = languageWindows?.[0];
	if (!first) throw new Error("Missing caption window projection");
	first.startUs = 1;
	first.language = "tampered";
	const again = await prepareLocalStoryTranscript({
		...f.input,
		includeCaptionLanguage: true,
	});
	expect(again.languageWindows).toEqual(expected);
	await expect(
		prepareLocalStoryTranscript({ ...f.input, includeCaptionLanguage: false }),
	).resolves.toEqual({ ...f.first, cached: true });
	expect(f.row).toEqual(persisted);
	expect(f.rows).toHaveLength(1);
	expect(mocks.asr).not.toHaveBeenCalled();
});
it.each([
	"ja",
	"en",
] as const)("projects observed %s for caption-only metadata from requested-auto legacy cache without resealing", async (language) => {
	mocks.asr.mockImplementation(async (input: TranscriptionInput) => ({
		...asrResult(input),
		language,
	}));
	const f = await legacyRoundedCache("auto");
	const persisted = structuredClone(f.row);
	const value = (
		f.row.proof as {
			value: { language: string; mediaWindows: { language: string }[] };
		}
	).value;
	expect(value.language).toBe("auto");
	expect(value.mediaWindows.every((w) => w.language === language)).toBe(true);
	const projected = await prepareLocalStoryTranscript({
		...f.input,
		includeCaptionLanguage: true,
	});
	const { languageWindows, captionTimingEvidence, ...withoutWindows } =
		projected;
	expect(captionTimingEvidence?.transcriptHash).toBe(f.first.fingerprint);
	expect(withoutWindows).toEqual({ ...f.first, cached: true, language });
	expect(languageWindows?.every((window) => window.language === language)).toBe(
		true,
	);
	expect(projected.fingerprint).toBe(f.first.fingerprint);
	await expect(
		prepareLocalStoryTranscript({ ...f.input, includeCaptionLanguage: false }),
	).resolves.toEqual({ ...f.first, cached: true });
	expect(f.first).not.toHaveProperty("language");
	expect(f.row).toEqual(persisted);
	expect(f.rows).toHaveLength(1);
	expect(mocks.asr).not.toHaveBeenCalled();
});
it.each([
	"mixed",
	"und",
	"other",
	"all-silent",
] as const)("does not invent caption language from requested-auto %s observed windows", async (kind) => {
	mocks.asr.mockImplementation(async (input: TranscriptionInput) => {
		const result = asrResult(input);
		if ((kind === "und" && !input.sourceStartUs) || kind === "all-silent")
			return {
				...result,
				language: "und",
				segments: [],
				rawSegments: [],
				speechIntervals: [],
				warnings: ["NO_SPEECH"],
			};
		return {
			...result,
			language:
				kind === "other"
					? "fr"
					: kind === "mixed" && input.sourceStartUs
						? "en"
						: "ja",
		};
	});
	const f = await legacyRoundedCache("auto");
	const persisted = structuredClone(f.row);
	const result = await prepareLocalStoryTranscript({
		...f.input,
		includeCaptionLanguage: true,
	});
	const { languageWindows, captionTimingEvidence, ...withoutWindows } = result;
	expect(captionTimingEvidence?.transcriptHash).toBe(f.first.fingerprint);
	expect(withoutWindows).toEqual({ ...f.first, cached: true });
	expect(languageWindows).toHaveLength(5);
	expect(result).not.toHaveProperty("language");
	expect(result.fingerprint).toBe(f.first.fingerprint);
	expect(f.row).toEqual(persisted);
	expect(f.rows).toHaveLength(1);
	expect(mocks.asr).not.toHaveBeenCalled();
});
it("keeps empty observed-window cache evidence invalid without exposing a requested caption language", async () => {
	const f = await legacyRoundedCache("auto");
	const proof = f.row.proof as { value: { mediaWindows: unknown[] } };
	proof.value.mediaWindows = [];
	f.row.proofHash = hashEditingEvidence(proof);
	const persisted = structuredClone(f.row);
	await expect(
		prepareLocalStoryTranscript({ ...f.input, includeCaptionLanguage: true }),
	).rejects.toMatchObject({ code: "LOCAL_STORY_ARTIFACT_UNVERIFIED" });
	expect(f.row).toEqual(persisted);
	expect(mocks.asr).not.toHaveBeenCalled();
});
it.each([
	"policy",
	"model",
	"token-p",
	"text",
	"clock",
	"decision",
])("does not reconstruct a legacy transcript with changed %s", async (change) => {
	const f = await legacyRoundedCache();
	const value = (f.row.proof as { value: Record<string, unknown> }).value;
	const raw = value.rawSegments as Array<{
		text: string;
		startUs: number;
		tokens: { p: number }[];
		quality: { decision: string };
	}>;
	const first = raw[0];
	if (!first) throw Error("missing fixture");
	if (change === "policy") value.qualityPolicyFingerprint = "c".repeat(64);
	if (change === "model") value.modelSha256 = "c".repeat(64);
	if (change === "token-p") {
		const token = first.tokens[0];
		if (!token) throw Error("missing token");
		token.p = 0.8;
	}
	if (change === "text") first.text = "Changed speech";
	if (change === "clock") first.startUs++;
	if (change === "decision") first.quality.decision = "NO_VAD_SPEECH";
	const persisted = structuredClone(f.row);
	await expect(prepareLocalStoryTranscript(f.input)).rejects.toMatchObject({
		code: "LOCAL_STORY_ARTIFACT_UNVERIFIED",
	});
	expect(f.row).toEqual(persisted);
	expect(f.rows).toHaveLength(1);
	expect(mocks.asr).not.toHaveBeenCalled();
});

// Reduced verbatim from the public ToS CPU decode: both speech and tokens have
// zero duration. The generic parser must keep rejecting it, never invent times.
const tosZeroDuration = {
	result: { language: "en" },
	transcription: [
		{
			offsets: { from: 7000, to: 7000 },
			text: " 4, 3, 2, 1, GO!",
			tokens: [{ text: " 4", offsets: { from: 7000, to: 7000 }, p: 0.700968 }],
		},
	],
};
function shorterFixture(seconds = 200) {
	const f = fixture();
	f.timeMap.sourceEndUs = f.timeMap.sourceStartUs + seconds * 1_000_000;
	f.timeMap.editingEndFrame = seconds * 30;
	return f;
}
function failLongWindows(input: TranscriptionInput) {
	if (
		input.durationUs > 30_000_000 ||
		(input.sourceStartUs === 0 && input.durationUs === 30_000_000)
	)
		parseWhisperTranscript(tosZeroDuration, input.durationUs);
	return asrResult(input);
}
it("redecodes only invalid windows and stores complete variable coverage with observed source times", async () => {
	const f = shorterFixture();
	mocks.asr.mockImplementation(async (input: TranscriptionInput) =>
		failLongWindows(input),
	);
	const result = await prepareLocalStoryTranscript(f.input);
	expect(result.status).toBe("READY");
	expect(
		mocks.asr.mock.calls.map(([i]) => [i.sourceStartUs, i.durationUs]),
	).toEqual([
		[0, 180_000_000],
		[0, 30_000_000],
		[0, 10_000_000],
		[10_000_000, 10_000_000],
		[20_000_000, 10_000_000],
		[30_000_000, 30_000_000],
		[60_000_000, 30_000_000],
		[90_000_000, 30_000_000],
		[120_000_000, 30_000_000],
		[150_000_000, 30_000_000],
		[180_000_000, 20_000_000],
	]);
	expect(result.segments[1]).toMatchObject({
		startUs: 87_100_000,
		endUs: 87_200_000,
		words: [{ startUs: 87_100_000, endUs: 87_200_000 }],
	});
	expect(result.warnings).toEqual(
		expect.arrayContaining([
			"LOCAL_STORY_TRANSCRIPT_SHORT_WINDOWS",
			"LOCAL_STORY_TRANSCRIPT_WINDOW_BOUNDARIES",
		]),
	);
	const stored = [...f.values.values()][0] as {
		version: string;
		retryPolicyVersion: string;
		mediaWindows: Array<{ fromUs: number; toUs: number }>;
	};
	expect(stored.version).toBe("local-story-transcript-v3");
	expect(stored.retryPolicyVersion).toBe("strict-invalid-30s-10s-v1");
	expect(stored.mediaWindows.map((w) => [w.fromUs, w.toUs])).toEqual([
		[0, 10_000_000],
		[10_000_000, 20_000_000],
		[20_000_000, 30_000_000],
		[30_000_000, 60_000_000],
		[60_000_000, 90_000_000],
		[90_000_000, 120_000_000],
		[120_000_000, 150_000_000],
		[150_000_000, 180_000_000],
		[180_000_000, 200_000_000],
	]);
	await expect(prepareLocalStoryTranscript(f.input)).resolves.toEqual({
		...result,
		cached: true,
	});
	expect(mocks.asr).toHaveBeenCalledTimes(11);
});
it("never caches successful siblings when one minimum child is invalid", async () => {
	const f = shorterFixture(35);
	mocks.asr.mockImplementation(async (input: TranscriptionInput) => {
		if (input.durationUs > 10_000_000 || input.sourceStartUs === 10_000_000)
			parseWhisperTranscript(tosZeroDuration, input.durationUs);
		return asrResult(input);
	});
	const result = await prepareLocalStoryTranscript(f.input);
	expect(result).toMatchObject({
		status: "UNAVAILABLE",
		segments: [],
		cached: false,
	});
	expect(f.values.size).toBe(0);
	expect(
		mocks.asr.mock.calls.map(([i]) => [i.sourceStartUs, i.durationUs]),
	).toEqual([
		[0, 35_000_000],
		[0, 30_000_000],
		[0, 10_000_000],
		[10_000_000, 10_000_000],
	]);
});
it.each([
	"gap",
	"overlap",
	"cross-window",
	"version",
	"retry-policy",
])("rejects cached variable-window evidence with %s", async (change) => {
	const f = shorterFixture();
	mocks.asr.mockImplementation(async (input: TranscriptionInput) =>
		failLongWindows(input),
	);
	await prepareLocalStoryTranscript(f.input);
	const stored = [...f.values.values()][0] as {
		version: string;
		retryPolicyVersion: string;
		mediaWindows: Array<{ fromUs: number; toUs: number }>;
		segments: Array<{ endUs: number }>;
	};
	if (change === "version") stored.version = "local-story-transcript-v1";
	else if (change === "retry-policy") stored.retryPolicyVersion = "unbounded";
	else if (change === "cross-window")
		Object.assign(stored.segments[0] ?? {}, {
			endUs: f.timeMap.sourceStartUs + 10_050_000,
		});
	else
		Object.assign(stored.mediaWindows[1] ?? {}, {
			fromUs: change === "gap" ? 10_000_001 : 9_999_999,
		});
	await expect(prepareLocalStoryTranscript(f.input)).rejects.toBeDefined();
	expect(mocks.asr).toHaveBeenCalledTimes(11);
});
it("shares a single thirty-minute deadline across all source windows", async () => {
	const f = fixture();
	let elapsed = 0;
	vi.spyOn(Date, "now").mockImplementation(() => elapsed);
	mocks.asr.mockImplementation(async (input: TranscriptionInput) => {
		elapsed += 6 * 60_000;
		return asrResult(input);
	});
	const result = await prepareLocalStoryTranscript(f.input);
	expect(result).toMatchObject({
		status: "UNAVAILABLE",
		segments: [],
		cached: false,
	});
	expect(f.values.size).toBe(0);
	expect(mocks.asr.mock.calls.map(([i]) => i.timeoutMs)).toEqual([
		600_000, 600_000, 600_000, 600_000, 360_000,
	]);
});
it("bounds a full hour of invalid-parent retries to five hundred attempts", async () => {
	const f = shorterFixture(3600);
	mocks.asr.mockImplementation(async (input: TranscriptionInput) => {
		if (input.durationUs > 10_000_000)
			parseWhisperTranscript(tosZeroDuration, input.durationUs);
		return asrResult(input);
	});
	const result = await prepareLocalStoryTranscript(f.input);
	expect(result.status).toBe("READY");
	expect(mocks.asr).toHaveBeenCalledTimes(500);
	expect(result.segments).toHaveLength(360);
});
it.each([
	"MODEL_CHANGED",
	"SOURCE_CHANGED",
	"CANCELED",
])("does not retry a fatal child %s", async (code) => {
	const f = shorterFixture();
	mocks.asr.mockImplementation(async (input: TranscriptionInput) => {
		if (input.durationUs > 10_000_000)
			parseWhisperTranscript(tosZeroDuration, input.durationUs);
		throw new MediaOperationError(code, "private diagnostic");
	});
	await expect(prepareLocalStoryTranscript(f.input)).rejects.toMatchObject({
		code,
		message: code,
	});
	expect(mocks.asr).toHaveBeenCalledTimes(3);
	expect(f.values.size).toBe(0);
});
it("keeps auto-language silent children as und without calling the whole film silent", async () => {
	const f = fixture();
	mocks.asr.mockImplementation(async (input: TranscriptionInput) =>
		input.sourceStartUs
			? asrResult(input)
			: {
					...asrResult(input),
					language: "und",
					segments: [],
					rawSegments: [],
					speechIntervals: [],
					warnings: ["NO_SPEECH"],
				},
	);
	const result = await prepareLocalStoryTranscript({
		...f.input,
		language: "auto",
	});
	expect(result.status).toBe("READY");
	expect(result.segments).toHaveLength(4);
	expect(result.warnings).not.toContain("NO_SPEECH");
	await expect(
		prepareLocalStoryTranscript({ ...f.input, language: "auto" }),
	).resolves.toEqual({ ...result, cached: true });
});
it("retains a short final child with complete coverage", async () => {
	const f = shorterFixture(14);
	mocks.asr.mockImplementation(async (input: TranscriptionInput) => {
		if (input.durationUs > 10_000_000)
			parseWhisperTranscript(tosZeroDuration, input.durationUs);
		return asrResult(input);
	});
	const result = await prepareLocalStoryTranscript(f.input);
	expect(result.status).toBe("READY");
	expect(
		mocks.asr.mock.calls.map(([i]) => [i.sourceStartUs, i.durationUs]),
	).toEqual([
		[0, 14_000_000],
		[0, 10_000_000],
		[10_000_000, 4_000_000],
	]);
	expect(result.segments.at(-1)?.endUs).toBe(87_200_000);
});
it.each([
	"ASR_VERSION_MISMATCH",
	"ASR_LANGUAGE_MISMATCH",
	"PROCESS_FAILED",
	"TIMED_OUT",
])("does not retry a non-timing adapter failure %s", async (code) => {
	const f = fixture();
	mocks.asr.mockRejectedValue(new MediaOperationError(code));
	await expect(prepareLocalStoryTranscript(f.input)).resolves.toMatchObject({
		status: "UNAVAILABLE",
		warnings: ["ASR_UNAVAILABLE"],
	});
	expect(mocks.asr).toHaveBeenCalledTimes(1);
	expect(f.values.size).toBe(0);
});
it("keeps all-silent auto detection as und with no invented segments", async () => {
	const f = shorterFixture(30);
	mocks.asr.mockImplementation(async (input: TranscriptionInput) => ({
		...asrResult(input),
		language: "und",
		segments: [],
		rawSegments: [],
		speechIntervals: [],
		warnings: ["NO_SPEECH"],
	}));
	const result = await prepareLocalStoryTranscript({
		...f.input,
		language: "auto",
	});
	expect(result).toMatchObject({
		status: "READY",
		segments: [],
		warnings: ["NO_SPEECH"],
	});
	await expect(
		prepareLocalStoryTranscript({ ...f.input, language: "auto" }),
	).resolves.toEqual({ ...result, cached: true });
});
it.each([
	"explicit-language",
	"spoken-und",
])("rejects invalid und output for %s", async (kind) => {
	const f = shorterFixture(30);
	mocks.asr.mockImplementation(async (input: TranscriptionInput) => ({
		...asrResult(input),
		language: "und",
		...(kind === "explicit-language"
			? { segments: [], warnings: ["NO_SPEECH"] }
			: {}),
	}));
	const result = await prepareLocalStoryTranscript({
		...f.input,
		language: kind === "explicit-language" ? "en" : "auto",
	});
	expect(result).toMatchObject({
		status: "UNAVAILABLE",
		warnings: ["TRANSCRIPT_INVALID"],
	});
	expect(mocks.asr).toHaveBeenCalledTimes(1);
	expect(f.values.size).toBe(0);
});
it("honors abort during a shorter child without caching its result", async () => {
	const f = shorterFixture(35);
	mocks.asr.mockImplementation(async (input: TranscriptionInput) => {
		if (input.durationUs > 10_000_000)
			parseWhisperTranscript(tosZeroDuration, input.durationUs);
		f.signal.abort();
		return asrResult(input);
	});
	await expect(prepareLocalStoryTranscript(f.input)).rejects.toMatchObject({
		code: "CANCELED",
	});
	expect(mocks.asr).toHaveBeenCalledTimes(3);
	expect(f.values.size).toBe(0);
});
it("does not publish after the shared deadline expires while reporting final progress", async () => {
	const f = shorterFixture(30);
	let now = 0;
	vi.spyOn(Date, "now").mockImplementation(() => now);
	f.onProgress.mockImplementation(
		async (progress?: { completedWindows: number }) => {
			if (progress?.completedWindows) now = 30 * 60_000;
		},
	);
	await expect(prepareLocalStoryTranscript(f.input)).resolves.toMatchObject({
		status: "UNAVAILABLE",
		segments: [],
	});
	expect(f.values.size).toBe(0);
});
it("covers all 734 seconds with bounded contiguous windows and adds the original origin exactly once", async () => {
	const f = fixture(),
		result = await prepareLocalStoryTranscript(f.input);
	expect(
		mocks.asr.mock.calls.map(([i]) => [i.sourceStartUs, i.durationUs]),
	).toEqual([
		[0, 180_000_000],
		[180_000_000, 180_000_000],
		[360_000_000, 180_000_000],
		[540_000_000, 180_000_000],
		[720_000_000, 14_000_000],
	]);
	expect(result.status).toBe("READY");
	expect(result.cached).toBe(false);
	expect(result.segments).toHaveLength(5);
	expect(result.segments[1]).toMatchObject({
		startUs: 257_100_000,
		endUs: 257_200_000,
		words: [
			{
				startUs: 257_100_000,
				endUs: 257_200_000,
				text: "Hello",
				startChar: 0,
				endChar: 5,
			},
		],
	});
	expect(result.warnings).toContain("LOCAL_STORY_TRANSCRIPT_WINDOW_BOUNDARIES");
	expect(f.onProgress).toHaveBeenLastCalledWith({
		completedWindows: 5,
		totalWindows: 5,
	});
	expect(JSON.stringify([...f.values.values()])).not.toMatch(
		/private\/source|private\/model/,
	);
});
it("reuses complete source transcripts, and isolates model, clock and language changes", async () => {
	const f = fixture(),
		first = await prepareLocalStoryTranscript(f.input),
		reused = await prepareLocalStoryTranscript(f.input);
	expect(reused).toEqual({ ...first, cached: true });
	expect(mocks.asr).toHaveBeenCalledTimes(5);
	await prepareLocalStoryTranscript({
		...f.input,
		model: { path: "/different/model.bin", sha256: "c".repeat(64) },
	});
	await prepareLocalStoryTranscript({ ...f.input, language: "ja" });
	await prepareLocalStoryTranscript({
		...f.input,
		timeMap: {
			...f.timeMap,
			sourceStartUs: 78_000_000,
			sourceEndUs: 812_000_000,
		},
	});
	expect(mocks.asr).toHaveBeenCalledTimes(20);
	expect(f.values.size).toBe(4);
});
it.each([
	"missing-model",
	"no-audio",
])("returns explicit uncached absence for %s", async (kind) => {
	const f = fixture(),
		result = await prepareLocalStoryTranscript({
			...f.input,
			...(kind === "no-audio" ? { hasAudio: false } : { model: undefined }),
		});
	expect(result).toMatchObject({
		status: kind === "no-audio" ? "NO_AUDIO" : "UNAVAILABLE",
		segments: [],
		cached: false,
		modelSha256: null,
	});
	expect(mocks.asr).not.toHaveBeenCalled();
	expect(f.values.size).toBe(0);
});
it("does not publish partial coverage or a raw adapter error when a later window fails", async () => {
	const f = fixture();
	mocks.asr.mockImplementation(async (input: TranscriptionInput) => {
		if (input.sourceStartUs)
			throw new Error("s3://secret-user:secret-password@example/private-model");
		return asrResult(input);
	});
	const result = await prepareLocalStoryTranscript(f.input);
	expect(result).toMatchObject({
		status: "UNAVAILABLE",
		segments: [],
		warnings: ["ASR_UNAVAILABLE"],
		cached: false,
	});
	expect(JSON.stringify(result)).not.toMatch(
		/secret-user|secret-password|private-model/,
	);
	expect(f.values.size).toBe(0);
});
it.each([
	"model",
	"media",
])("fails closed for a changed %s digest", async (kind) => {
	const f = fixture();
	mocks.asr.mockImplementation(async (input: TranscriptionInput) => ({
		...asrResult(input),
		...(kind === "model"
			? { modelSha256: "f".repeat(64) }
			: { mediaSha256: "f".repeat(64) }),
	}));
	await expect(prepareLocalStoryTranscript(f.input)).rejects.toMatchObject({
		code: kind === "model" ? "ASR_MODEL_CHANGED" : "SOURCE_CHANGED",
	});
	expect(f.values.size).toBe(0);
});
it("preserves fatal digest errors while removing raw diagnostics", async () => {
	const f = fixture();
	mocks.asr.mockRejectedValue(
		new MediaOperationError(
			"MODEL_CHANGED",
			"private model path",
			"secret diagnostic",
		),
	);
	await expect(prepareLocalStoryTranscript(f.input)).rejects.toMatchObject({
		code: "MODEL_CHANGED",
		message: "MODEL_CHANGED",
		diagnostic: undefined,
	});
	expect(f.values.size).toBe(0);
});
it("cancels during ASR before adopting any result", async () => {
	const f = fixture();
	mocks.asr.mockImplementation(async (input: TranscriptionInput) => {
		f.signal.abort(new Error("private abort"));
		return asrResult(input);
	});
	await expect(prepareLocalStoryTranscript(f.input)).rejects.toMatchObject({
		code: "CANCELED",
		message: "CANCELED",
	});
	expect(f.values.size).toBe(0);
});
it("does not turn a cached temporal or word mismatch into valid speech", async () => {
	const f = fixture();
	await prepareLocalStoryTranscript(f.input);
	const stored = [...f.values.values()][0] as {
		segments: Array<{ startUs: number }>;
	};
	if (!stored.segments[0]) throw Error("fixture missing");
	stored.segments[0].startUs = 0;
	await expect(prepareLocalStoryTranscript(f.input)).rejects.toBeDefined();
	expect(mocks.asr).toHaveBeenCalledTimes(5);
});
it("rejects invented or out-of-window words instead of guessing a replacement", async () => {
	const f = fixture();
	mocks.asr.mockImplementation(async (input: TranscriptionInput) => {
		const result = asrResult(input);
		if (result.segments[0]?.words[0])
			result.segments[0].words[0].text = "invented";
		return result;
	});
	const result = await prepareLocalStoryTranscript(f.input);
	expect(result).toMatchObject({
		status: "UNAVAILABLE",
		segments: [],
		warnings: ["TRANSCRIPT_INVALID"],
	});
	expect(f.values.size).toBe(0);
});
it("does not process sources beyond the one-hour bounded contract", async () => {
	const f = fixture();
	await expect(
		prepareLocalStoryTranscript({
			...f.input,
			timeMap: {
				...f.timeMap,
				sourceStartUs: 0,
				sourceEndUs: 3_601_000_000,
				editingEndFrame: 108030,
			},
		}),
	).rejects.toMatchObject({ code: "LOCAL_STORY_CONTEXT_LIMIT" });
	expect(mocks.asr).not.toHaveBeenCalled();
});
it("does not describe the whole source as silent when only one window has no speech", async () => {
	const f = fixture();
	mocks.asr.mockImplementation(async (input: TranscriptionInput) => {
		const result = asrResult(input);
		return input.sourceStartUs
			? result
			: {
					...result,
					segments: [],
					rawSegments: [],
					speechIntervals: [],
					warnings: ["NO_SPEECH"],
				};
	});
	const result = await prepareLocalStoryTranscript(f.input);
	expect(result.segments).toHaveLength(4);
	expect(result.warnings).not.toContain("NO_SPEECH");
});
it("honors cancellation while reporting a cache hit", async () => {
	const f = fixture();
	await prepareLocalStoryTranscript(f.input);
	f.onProgress.mockImplementation(async () => {
		f.signal.abort();
	});
	await expect(prepareLocalStoryTranscript(f.input)).rejects.toMatchObject({
		code: "CANCELED",
	});
});

it.each([
	"missing-policy",
	"wrong-policy",
	"raw-decision",
	"admitted-text",
	"speech-clock",
])("rejects cached quality crossbinding %s without new inference", async (change) => {
	const f = shorterFixture(30);
	const first = await prepareLocalStoryTranscript(f.input);
	expect(first.status).toBe("READY");
	const stored = [...f.values.values()][0] as Record<string, unknown>;
	if (change === "missing-policy") delete stored.qualityPolicyFingerprint;
	else if (change === "wrong-policy")
		stored.qualityPolicyFingerprint = "c".repeat(64);
	else if (change === "raw-decision") {
		const raw = stored.rawSegments as Array<{ quality: { decision: string } }>;
		if (!raw[0]) throw new Error("Missing raw fixture");
		raw[0].quality.decision = "NO_VAD_SPEECH";
	} else if (change === "admitted-text") {
		const segments = stored.segments as Array<{ text: string }>;
		if (!segments[0]) throw new Error("Missing admitted fixture");
		segments[0].text = "Unsupported words";
	} else {
		const intervals = stored.speechIntervals as Array<{ startUs: number }>;
		if (!intervals[0]) throw new Error("Missing speech fixture");
		intervals[0].startUs += 1000;
	}
	await expect(prepareLocalStoryTranscript(f.input)).rejects.toBeDefined();
	expect(mocks.asr).toHaveBeenCalledTimes(1);
});

it("revalidates fractional-frame EOF VAD evidence on fresh and cached whole-source ASR", async () => {
	const f = fixture();
	f.timeMap.sourceEndUs = f.timeMap.sourceStartUs + 1_066_667;
	f.timeMap.editingEndFrame = 32;
	mocks.asr.mockImplementation(async (input: TranscriptionInput) => ({
		...asrResult(input),
		...parseWhisperTranscript(
			{
				result: { language: "en" },
				bitovp_quality: {
					version: "bitovp-mapped-quality-v1",
					vad: true,
					speech_intervals: [{ offsets: { from: 500, to: 1090 } }],
				},
				transcription: [
					{
						text: "Hello",
						offsets: { from: 500, to: 1090 },
						no_speech_probability: 0.1,
						tokens: [
							{ text: "Hello", p: 0.95, offsets: { from: 500, to: 1090 } },
						],
					},
				],
			},
			input.durationUs,
			input.sourceStartUs,
			{ requireQuality: true },
		),
	}));
	const first = await prepareLocalStoryTranscript(f.input);
	expect(first.status).toBe("READY");
	expect(first.segments[0]?.endUs).toBe(f.timeMap.sourceEndUs);
	const cached = await prepareLocalStoryTranscript(f.input);
	expect(cached.cached).toBe(true);
	expect(cached.segments).toEqual(first.segments);
	expect(mocks.asr).toHaveBeenCalledTimes(1);
	const stored = [...f.values.values()][0] as {
		rawSegments: { endUs: number }[];
		speechIntervals: { endUs: number }[];
	};
	expect(stored.rawSegments[0]?.endUs).toBe(
		f.timeMap.sourceStartUs + 1_090_000,
	);
	expect(stored.speechIntervals[0]?.endUs).toBe(f.timeMap.sourceEndUs);
});

it("does not accept a cached non-EOF VAD interval rounded onto a different clock", async () => {
	const f = shorterFixture(30);
	await prepareLocalStoryTranscript(f.input);
	const stored = [...f.values.values()][0] as {
		speechIntervals: { endUs: number }[];
	};
	const interval = stored.speechIntervals[0];
	if (!interval) throw new Error("Missing speech fixture");
	// This changes no admitted segment overlap; exact VAD evidence must still
	// be checked instead of accepting a rounded reconstruction.
	interval.endUs += 1;
	await expect(prepareLocalStoryTranscript(f.input)).rejects.toBeDefined();
	expect(mocks.asr).toHaveBeenCalledTimes(1);
});

it("delegates only the deterministic source identity to the shared recipe without IO values", async () => {
	const f = fixture(),
		result = await prepareLocalStoryTranscript(f.input);
	expect(result.status).toBe("READY");
	expect(mocks.recipe).toHaveBeenCalledExactlyOnceWith({
		mediaSha256: f.input.mediaSha256,
		timeMap: f.timeMap,
		configuredModel: { sha256: f.input.model.sha256 },
		language: "en",
	});
	expect(JSON.stringify(mocks.recipe.mock.calls)).not.toMatch(
		/private\/source|private\/model|ffmpeg/,
	);
});
it("maps shared parser errors to the original MediaOperationError without retrying cached corruption", async () => {
	const f = fixture();
	await prepareLocalStoryTranscript(f.input);
	const value = [...f.values.values()][0];
	if (
		!value ||
		typeof value !== "object" ||
		!("mediaWindows" in value) ||
		!Array.isArray(value.mediaWindows)
	)
		throw new Error("Missing authored cache");
	Object.assign(value.mediaWindows[0], { fromUs: 1 });
	const calls = mocks.asr.mock.calls.length;
	const rejected = prepareLocalStoryTranscript(f.input);
	await expect(rejected).rejects.toBeInstanceOf(MediaOperationError);
	await expect(rejected).rejects.toMatchObject({
		code: "LOCAL_STORY_ARTIFACT_UNVERIFIED",
		message: "LOCAL_STORY_ARTIFACT_UNVERIFIED",
	});
	expect(mocks.asr).toHaveBeenCalledTimes(calls);
});
it.each([
	"range",
	"zod",
] as const)("preserves the exact %s exception from the legacy parse callback boundary", async (kind) => {
	const f = fixture();
	await prepareLocalStoryTranscript(f.input);
	let zod: unknown;
	try {
		cfrTimeMapSchema.parse({});
	} catch (error) {
		zod = error;
	}
	const sentinel =
		kind === "range" ? new RangeError("authored legacy range") : zod;
	if (sentinel === undefined) throw new Error("Missing authored exception");
	const value = [...f.values.values()][0];
	if (!value || typeof value !== "object")
		throw new Error("Missing authored cache");
	// This direct store contract fake isolates wrapper exception mapping, not sealed DB admission.
	Object.defineProperty(value, "version", {
		enumerable: true,
		get() {
			throw sentinel;
		},
	});
	const calls = mocks.asr.mock.calls.length;
	await expect(prepareLocalStoryTranscript(f.input)).rejects.toBe(sentinel);
	expect(mocks.asr).toHaveBeenCalledTimes(calls);
});
it("rejects a legacy mean candidate when another accepted warning changes the ORIGINAL wrapper seal", async () => {
	const f = await legacyRoundedCache();
	const proof = f.row.proof;
	if (!proof || typeof proof !== "object" || !("value" in proof))
		throw new Error("Missing authored proof");
	const value = proof.value;
	if (
		!value ||
		typeof value !== "object" ||
		!("warnings" in value) ||
		!Array.isArray(value.warnings)
	)
		throw new Error("Missing authored warnings");
	value.warnings.push("WORD_ALIGNMENT_UNAVAILABLE");
	const before = structuredClone(f.row);
	await expect(prepareLocalStoryTranscript(f.input)).rejects.toMatchObject({
		code: "LOCAL_STORY_ARTIFACT_UNVERIFIED",
	});
	expect(f.row).toEqual(before);
	expect(f.rows).toHaveLength(1);
	expect(mocks.asr).not.toHaveBeenCalled();
});
it("never applies v1 mean recovery to a sealed v2 valueJson with a changed derived float", async () => {
	const f = await legacyRoundedCache();
	const proof = f.row.proof;
	if (
		!proof ||
		typeof proof !== "object" ||
		!("value" in proof) ||
		!("cacheHash" in proof)
	)
		throw new Error("Missing authored proof");
	f.row.proof = {
		version: "local-story-cache-v2",
		cacheHash: proof.cacheHash,
		valueJson: canonicalEditingJson(proof.value),
	};
	f.row.proofHash = hashEditingEvidence(f.row.proof);
	const before = structuredClone(f.row);
	await expect(prepareLocalStoryTranscript(f.input)).rejects.toMatchObject({
		code: "LOCAL_STORY_ARTIFACT_UNVERIFIED",
	});
	expect(f.row).toEqual(before);
	expect(f.rows).toHaveLength(1);
	expect(mocks.asr).not.toHaveBeenCalled();
});

it("adds VAD display support to an existing ASR cache hit without changing its key, value or fingerprint", async () => {
	const f = fixture();
	const legacy = await prepareLocalStoryTranscript(f.input);
	expect(legacy).not.toHaveProperty("speechIntervals");
	const nativeCalls = mocks.asr.mock.calls.length;
	const storedBefore = canonicalEditingJson([...f.values]);
	const keyBefore = canonicalEditingJson(f.keys[0]);
	const projected = await prepareLocalStoryTranscript({
		...f.input,
		includeSpeechIntervals: true,
	});
	const { speechIntervals, ...meaning } = projected;
	expect(meaning).toEqual({ ...legacy, cached: true });
	const stored = [...f.values.values()][0] as {
		speechIntervals: { startUs: number; endUs: number }[];
	};
	expect(speechIntervals).toEqual(stored.speechIntervals);
	expect(canonicalEditingJson(f.keys.at(-1))).toBe(keyBefore);
	expect(canonicalEditingJson([...f.values])).toBe(storedBefore);
	expect(mocks.asr).toHaveBeenCalledTimes(nativeCalls);
	if (!speechIntervals?.[0]) throw new Error("Missing VAD cache projection");
	speechIntervals[0].startUs++;
	expect(canonicalEditingJson([...f.values])).toBe(storedBefore);
});
