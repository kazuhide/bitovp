import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { TRANSCRIPTION_POLICY_FINGERPRINT } from "../content-production/transcription-quality";
import { parseLegacyWhisperTranscript } from "./local-story-flow-legacy-asr";
import {
	createLocalStoryLegacyTranscriptRecipe,
	LOCAL_STORY_LEGACY_TRANSCRIPT_RECIPE_POLICY,
	LocalStoryLegacyTranscriptError,
	type LocalStoryLegacyTranscriptIdentityInput,
	type LocalStoryLegacyTranscriptStoredValue,
} from "./local-story-flow-legacy-transcript";
import { hashEditingEvidence as H } from "./verify-automatic-binding";

function item<T>(value: T | undefined): T {
	if (value === undefined) throw new Error("Missing authored fixture");
	return value;
}
function fixture() {
	const map = {
		id: "11111111-1111-4111-8111-111111111111",
		mediaVersionId: "11111111-1111-4111-8111-111111111111",
		kind: "CFR",
		sourceStartUs: 77_000_000,
		sourceEndUs: 79_000_000,
		editingStartFrame: 0,
		editingEndFrame: 60,
		fps: { num: 30, den: 1 },
	};
	const identity: LocalStoryLegacyTranscriptIdentityInput = {
		mediaSha256: "a".repeat(64),
		timeMap: map,
		configuredModel: { sha256: "b".repeat(64) },
		language: "en",
	};
	const value: LocalStoryLegacyTranscriptStoredValue = {
		version: "local-story-transcript-v3",
		retryPolicyVersion: "strict-invalid-30s-10s-v1",
		engineVersion: "1.9.5",
		mediaSha256: identity.mediaSha256,
		modelSha256: "b".repeat(64),
		timeMapHash: H(map),
		language: "en",
		sourceTimeDomain: "ORIGINAL_PRESENTATION_US",
		segments: [
			{
				startUs: 77_100_000,
				endUs: 77_200_000,
				text: "Hello",
				words: [
					{
						text: "Hello",
						startChar: 0,
						endChar: 5,
						startUs: 77_100_000,
						endUs: 77_200_000,
						confidence: 0.9,
					},
				],
			},
		],
		warnings: [],
		mediaWindows: [{ fromUs: 0, toUs: 2_000_000, language: "en" }],
		qualityPolicyFingerprint: TRANSCRIPTION_POLICY_FINGERPRINT,
		rawSegments: [
			{
				startUs: 77_100_000,
				endUs: 77_200_000,
				text: "Hello",
				tokens: [
					{ text: "Hello", p: 0.9, startUs: 77_100_000, endUs: 77_200_000 },
				],
				quality: {
					noSpeechProbability: 0.1,
					meanTokenLogProbability: Math.log(0.9),
					speechOverlapUs: 100_000,
					decision: "ADMITTED",
				},
			},
		],
		speechIntervals: [{ startUs: 77_100_000, endUs: 77_200_000 }],
	};
	return { identity, map, value };
}
const speechHash =
	"00e3e3b0908d6f31f03d733e2654ecbf9bcd281b2030afc0bcff5c6a8f1a1b50";
const noAudioConfigured =
	"e383b76cb666b1e425c5e8e5231b4f89e6321f0f03bf0c46559eeaf4f40e143a";

describe("shared historical whole-source transcript recipe", () => {
	it("reproduces the captured old key11, stored14 and public7 golden without changing policy", () => {
		const f = fixture(),
			r = createLocalStoryLegacyTranscriptRecipe(f.identity),
			value = r.parse(f.value);
		expect(TRANSCRIPTION_POLICY_FINGERPRINT).toBe(
			"db89d5f6472018246893ab5143682bce27982898070aba68b459531adc40838f",
		);
		expect(r.key).toEqual({
			version: "local-story-transcript-v3",
			qualityPolicyFingerprint: TRANSCRIPTION_POLICY_FINGERPRINT,
			retryPolicyVersion: "strict-invalid-30s-10s-v1",
			engineVersion: "1.9.5",
			mediaSha256: "a".repeat(64),
			timeMapHash:
				"55c85af9b58a3aa5ef460aaf93fe89f616ecd769a0964841b833c6762a5b39cc",
			modelSha256: "b".repeat(64),
			language: "en",
			windowDurationUs: 180_000_000,
			maxAttempts: 500,
			totalBudgetMs: 1_800_000,
		});
		expect(Object.keys(r.key)).toHaveLength(11);
		expect(Object.keys(value)).toHaveLength(14);
		expect(H(value)).toBe(speechHash);
		expect(r.ready({ value, valueHash: H(value), cached: true })).toEqual({
			segments: value.segments,
			status: "READY",
			fingerprint: speechHash,
			warnings: [],
			modelSha256: "b".repeat(64),
			cached: true,
			qualityPolicyFingerprint: TRANSCRIPTION_POLICY_FINGERPRINT,
		});
		expect(
			Object.keys(r.ready({ value, valueHash: H(value), cached: true })),
		).toHaveLength(7);
		expect(r.kind).toBe("LOCAL_STORY_TRANSCRIPT_V1");
		expect(r.totalWindows).toBe(1);
		expect(LOCAL_STORY_LEGACY_TRANSCRIPT_RECIPE_POLICY).toMatchObject({
			version: "local-story-legacy-transcript-recipe-v1",
			maxAttempts: 500,
			totalBudgetMs: 1_800_000,
			windowDurationUs: 180_000_000,
			maxSourceDurationUs: 3_600_000_000,
		});
	});
	it("keeps configured model in NO_AUDIO identity while public null and retry observations stay outside fingerprint", () => {
		const f = fixture(),
			r = createLocalStoryLegacyTranscriptRecipe(f.identity);
		const reason = {
			status: "NO_AUDIO",
			warning: "SOURCE_HAS_NO_AUDIO",
		} as const;
		const plain = r.absent(reason, []);
		expect(r.key.modelSha256).toBe("b".repeat(64));
		expect(plain).toEqual({
			status: "NO_AUDIO",
			segments: [],
			warnings: ["SOURCE_HAS_NO_AUDIO"],
			cached: false,
			qualityPolicyFingerprint: TRANSCRIPTION_POLICY_FINGERPRINT,
			modelSha256: null,
			fingerprint: noAudioConfigured,
		});
		expect(
			r.absent(reason, [
				"LOCAL_STORY_TRANSCRIPT_SHORT_WINDOWS",
				"LOCAL_STORY_TRANSCRIPT_WINDOW_BOUNDARIES",
			]),
		).toEqual({
			...plain,
			warnings: [
				"SOURCE_HAS_NO_AUDIO",
				"LOCAL_STORY_TRANSCRIPT_SHORT_WINDOWS",
				"LOCAL_STORY_TRANSCRIPT_WINDOW_BOUNDARIES",
			],
		});
		f.identity.configuredModel = null;
		const missing = createLocalStoryLegacyTranscriptRecipe(f.identity);
		expect(missing.absent(reason, []).fingerprint).toBe(
			"ea02612e04da7a1ebb0a1cc3b641ec8def2b77bf50d9847a080e2128f8b10e1e",
		);
		expect(
			missing.absent(
				{ status: "UNAVAILABLE", warning: "ASR_MODEL_NOT_CONFIGURED" },
				[],
			),
		).toMatchObject({
			modelSha256: null,
			fingerprint:
				"b1e4217646aa04ff25de2719f4353a59058465d4e889e1c6d6a7926b1b5da550",
		});
		expect(() => missing.parse(f.value)).toThrowError("ASR_MODEL_CHANGED");
	});
	it("treats current read cached:true as an observation, not reconstruction of the original ASR hit/miss", () => {
		const f = fixture(),
			r = createLocalStoryLegacyTranscriptRecipe(f.identity),
			value = r.parse(f.value);
		const original = r.ready({ value, valueHash: H(value), cached: false });
		const read = r.ready({ value, valueHash: H(value), cached: true });
		expect(read).toEqual({ ...original, cached: true });
		expect(read.fingerprint).toBe(speechHash);
		expect(value).not.toHaveProperty("cached");
		expect(r.key).not.toHaveProperty("cached");
	});
	it.each([
		"en",
		"auto",
	] as const)("keeps complete READY empty speech and auto und golden (%s)", (language) => {
		const f = fixture();
		f.identity.language = language;
		f.value.language = language;
		f.value.segments = [];
		f.value.rawSegments = [];
		f.value.speechIntervals = [];
		f.value.warnings = ["NO_SPEECH"];
		item(f.value.mediaWindows[0]).language = language === "auto" ? "und" : "en";
		const r = createLocalStoryLegacyTranscriptRecipe(f.identity),
			value = r.parse(f.value);
		expect(H(value)).toBe(
			language === "auto"
				? "d0da6e12470ebe537c347efd347daf74ef87028907fdd462accbd779d8a6164f"
				: "f1c3a3ef9a889edbe64e97177fec933d5dc147c3fec30519abc29d822200a9f7",
		);
		expect(
			r.ready({ value, valueHash: H(value), cached: false }),
		).toMatchObject({
			status: "READY",
			segments: [],
			modelSha256: "b".repeat(64),
		});
	});
	it("cuts input/key/map aliases without changing the private expected source tuple", () => {
		const f = fixture(),
			r = createLocalStoryLegacyTranscriptRecipe(f.identity),
			before = structuredClone(f.value);
		f.identity.mediaSha256 = "f".repeat(64);
		if (f.identity.configuredModel === null)
			throw new Error("Missing configured fixture");
		f.identity.configuredModel.sha256 = "f".repeat(64);
		f.map.sourceStartUs++;
		r.key.mediaSha256 = "f".repeat(64);
		r.timeMap.id = "22222222-2222-4222-8222-222222222222";
		expect(r.parse(before)).toEqual(before);
	});
	it.each([
		"gap",
		"partial",
		"overlap",
		"reorder",
		"too-many",
		"too-long",
	] as const)("rejects incomplete or illegal window coverage %s", (kind) => {
		const f = fixture();
		if (kind === "gap") item(f.value.mediaWindows[0]).fromUs = 1;
		if (kind === "partial") item(f.value.mediaWindows[0]).toUs = 1_999_999;
		if (kind === "overlap")
			f.value.mediaWindows = [
				{ fromUs: 0, toUs: 1_100_000, language: "en" },
				{ fromUs: 1_000_000, toUs: 2_000_000, language: "en" },
			];
		if (kind === "reorder")
			f.value.mediaWindows = [
				{ fromUs: 1_000_000, toUs: 2_000_000, language: "en" },
				{ fromUs: 0, toUs: 1_000_000, language: "en" },
			];
		if (kind === "too-many")
			f.value.mediaWindows = Array.from({ length: 501 }, () => ({
				fromUs: 0,
				toUs: 2_000_000,
				language: "en",
			}));
		if (kind === "too-long") {
			f.map.sourceEndUs = f.map.sourceStartUs + 200_000_000;
			f.map.editingEndFrame = 6000;
			f.value.timeMapHash = H(f.map);
			item(f.value.mediaWindows[0]).toUs = 200_000_000;
		}
		expect(() =>
			createLocalStoryLegacyTranscriptRecipe(f.identity).parse(f.value),
		).toThrowError("LOCAL_STORY_ARTIFACT_UNVERIFIED");
	});
	it.each([
		"mediaSha256",
		"modelSha256",
		"timeMapHash",
		"qualityPolicyFingerprint",
		"retryPolicyVersion",
		"engineVersion",
		"language",
		"sourceTimeDomain",
	] as const)("rejects saved identity mismatch %s", (field) => {
		const f = fixture();
		Object.assign(f.value, { [field]: "wrong" });
		expect(() =>
			createLocalStoryLegacyTranscriptRecipe(f.identity).parse(f.value),
		).toThrowError("LOCAL_STORY_ARTIFACT_UNVERIFIED");
	});
	it.each([
		"text",
		"p",
		"clock",
		"mean",
		"decision",
		"vad-clock",
		"und",
	] as const)("recomputes exact raw/VAD/word/language evidence for %s", (kind) => {
		const f = fixture(),
			raw = item(f.value.rawSegments[0]);
		if (kind === "text") raw.text = "Wrong";
		if (kind === "p") item(raw.tokens?.[0]).p = 0.8;
		if (kind === "clock") raw.startUs++;
		if (kind === "mean")
			raw.quality.meanTokenLogProbability = Number(
				Math.log(0.9).toPrecision(16),
			);
		if (kind === "decision") raw.quality.decision = "NO_VAD_SPEECH";
		if (kind === "vad-clock") item(f.value.speechIntervals[0]).endUs++;
		if (kind === "und") item(f.value.mediaWindows[0]).language = "und";
		expect(() =>
			createLocalStoryLegacyTranscriptRecipe(f.identity).parse(f.value),
		).toThrow();
	});
	it("returns a detached derived-mean candidate only; changing another accepted field still fails the ORIGINAL whole seal", () => {
		const f = fixture(),
			r = createLocalStoryLegacyTranscriptRecipe(f.identity),
			original = structuredClone(f.value);
		const proof = {
				version: "local-story-cache-v1",
				cacheHash: "c".repeat(64),
				value: original,
			},
			seal = H(proof);
		item(f.value.rawSegments[0]).quality.meanTokenLogProbability = Number(
			Math.log(0.9).toPrecision(16),
		);
		const before = structuredClone(f.value);
		expect(() => r.parse(f.value)).toThrowError(
			"LOCAL_STORY_ARTIFACT_UNVERIFIED",
		);
		const candidate = r.recoverLegacyDerivedMean(f.value);
		expect(H(candidate)).toBe(speechHash);
		expect(H({ ...proof, value: candidate })).toBe(seal);
		expect(f.value).toEqual(before);
		f.value.warnings = ["WORD_ALIGNMENT_UNAVAILABLE"];
		const changed = r.recoverLegacyDerivedMean(f.value);
		expect(H({ ...proof, value: changed })).not.toBe(seal);
	});
	it("keeps fractional EOF raw evidence and admits only the exact qualified VAD clamp", () => {
		const f = fixture();
		f.map.sourceStartUs = 77_000_037;
		f.map.sourceEndUs = f.map.sourceStartUs + 1_066_667;
		f.map.editingEndFrame = 32;
		const observed = parseLegacyWhisperTranscript(
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
			1_066_667,
			f.map.sourceStartUs,
			{ requireQuality: true },
		);
		if (!observed.rawSegments || !observed.speechIntervals)
			throw new Error("Missing authored quality evidence");
		f.value.timeMapHash = H(f.map);
		f.value.segments = observed.segments;
		f.value.rawSegments = observed.rawSegments;
		f.value.speechIntervals = observed.speechIntervals;
		f.value.warnings = observed.warnings;
		f.value.mediaWindows = [{ fromUs: 0, toUs: 1_066_667, language: "en" }];
		const r = createLocalStoryLegacyTranscriptRecipe(f.identity),
			value = r.parse(f.value);
		expect(item(value.segments[0]).endUs).toBe(f.map.sourceEndUs);
		expect(item(value.segments[0]).words).toBeUndefined();
		expect(item(value.rawSegments[0]).endUs).toBe(
			f.map.sourceStartUs + 1_090_000,
		);
		expect(item(value.speechIntervals[0]).endUs).toBe(f.map.sourceEndUs);
		item(f.value.speechIntervals[0]).endUs--;
		expect(() => r.parse(f.value)).toThrow();
	});
	it("preserves context/model error priority, Zod and arbitrary RangeError identity without copying raw text", () => {
		const f = fixture();
		expect(() =>
			createLocalStoryLegacyTranscriptRecipe({
				...f.identity,
				mediaSha256: "bad",
				configuredModel: { sha256: "bad" },
			}),
		).toThrowError("LOCAL_STORY_CONTEXT_LIMIT");
		expect(() =>
			createLocalStoryLegacyTranscriptRecipe({
				...f.identity,
				configuredModel: { sha256: "bad" },
			}),
		).toThrowError("ASR_MODEL_CHANGED");
		expect(() =>
			createLocalStoryLegacyTranscriptRecipe({ ...f.identity, timeMap: {} }),
		).toThrow(ZodError);
		const r = createLocalStoryLegacyTranscriptRecipe(f.identity),
			sentinel = new RangeError("authored range");
		Object.defineProperty(f.value, "version", {
			enumerable: true,
			get() {
				throw sentinel;
			},
		});
		try {
			r.parse(f.value);
			throw new Error("Expected range");
		} catch (error) {
			expect(error).toBe(sentinel);
		}
		const failure = new LocalStoryLegacyTranscriptError("TRANSCRIPT_LIMIT");
		expect(failure.message).toBe("TRANSCRIPT_LIMIT");
		expect(failure).not.toHaveProperty("cause");
	});
	it("keeps the aggregate UTF-16 text limit distinct from individual schema and does not truncate", () => {
		const f = fixture(),
			origin = f.map.sourceStartUs;
		f.value.segments = Array.from({ length: 64 }, (_, i) => ({
			startUs: origin + i * 1000,
			endUs: origin + (i + 1) * 1000,
			text: "x".repeat(16000),
		}));
		expect(() =>
			createLocalStoryLegacyTranscriptRecipe(f.identity).parse(f.value),
		).toThrowError("TRANSCRIPT_LIMIT");
	});
});

it("projects detached VAD only on opt-in while retaining the historical seven-field meaning and seal", () => {
	const f = fixture();
	const recipe = createLocalStoryLegacyTranscriptRecipe(f.identity);
	const value = recipe.parse(f.value);
	const before = H(value);
	const legacy = recipe.ready({ value, valueHash: before, cached: true });
	const projected = recipe.ready({
		value,
		valueHash: before,
		cached: true,
		includeSpeechIntervals: true,
	});
	const { speechIntervals, ...meaning } = projected;
	expect(meaning).toEqual(legacy);
	expect(Object.keys(legacy)).toHaveLength(7);
	expect(speechIntervals).toEqual(value.speechIntervals);
	expect(projected.fingerprint).toBe(speechHash);
	expect(H(value)).toBe(before);
	if (!speechIntervals?.[0]) throw new Error("Missing projected VAD");
	speechIntervals[0].startUs++;
	expect(H(value)).toBe(before);
	expect(recipe.ready({ value, valueHash: before, cached: true })).toEqual(
		legacy,
	);
});
