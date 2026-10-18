import { describe, expect, it } from "vitest";
import {
	MAX_SCENE_ANALYSIS_BYTES,
	normalizeSceneAnalysis,
	sceneAnalysisDocumentSchema,
} from "./analysis";

const fixture = () => ({
	metadata: { version: "2026.99" },
	duration: 20.5,
	title: "Example",
	scenes: [
		{
			id: "61cd7f2b-4057-4d21-9475-0bc5bfd78413",
			startInSeconds: 1.25,
			endInSeconds: 19.75,
			content: {
				characters: [
					{ name: "Sam", characterAppearance: { hairColor: "brown" } },
				],
			},
			iab: { contentTaxonomies: ["Arts"] },
			adOpportunityInformation: { score: 0.7, reason: "Scene transition" },
			shots: [
				{
					startInSeconds: 2.5,
					endInSeconds: 5.25,
					detailedDescription: "A person walks",
					mainSubjects: [
						{
							classification: "person",
							description: "Walking",
							appearanceTimeInSeconds: 1.25,
							centerX: 80,
							centerY: 25,
						},
					],
					shotAdvisories: {
						status: "ANALYZED",
						advisories: [
							{
								category: "TOBACCO",
								confidence: "LOW",
								reason: "Unclear object",
							},
						],
					},
				},
			],
		},
	],
});

describe("normalizeSceneAnalysis", () => {
	it("preserves bounded content credits independently of scene characters", () => {
		const source = {
			...fixture(),
			credits: {
				persons: [
					null,
					{
						name: "Person A",
						role: "Director",
						department: "Production",
						privateToken: "hidden",
					},
				],
				songs: [{ name: "Song A", artist: "Artist A", url: "hidden" }],
				copyright: "Example copyright",
				privatePayload: "hidden",
			},
		};
		const before = JSON.stringify(source);
		const result = normalizeSceneAnalysis(source);
		expect(result).toMatchObject({
			credits: {
				persons: [
					{ name: "Person A", role: "Director", department: "Production" },
				],
				songs: [{ name: "Song A", artist: "Artist A" }],
				copyright: "Example copyright",
			},
		});
		expect(JSON.stringify(result)).not.toContain("hidden");
		expect(JSON.stringify(source)).toBe(before);
		expect(sceneAnalysisDocumentSchema.parse(result)).toEqual(result);
	});
	it("accepts missing and nullable content credits in legacy documents", () => {
		for (const credits of [undefined, null]) {
			const result = normalizeSceneAnalysis({ ...fixture(), credits });
			expect(result).not.toHaveProperty("credits", expect.anything());
			expect(sceneAnalysisDocumentSchema.parse(result)).toEqual(result);
		}
		expect(
			normalizeSceneAnalysis({
				...fixture(),
				credits: { persons: null, songs: [null], copyright: null },
			}),
		).toMatchObject({ credits: { persons: [], songs: [], copyright: "" } });
	});
	it.each([
		{ persons: [{ name: "x".repeat(513) }] },
		{ persons: Array(2001).fill(null) },
		{ songs: Array(1001).fill(null) },
		{ songs: [{ artist: { nested: true } }] },
		{ copyright: "x".repeat(16_001) },
	])("rejects malformed or oversized content credits %#", (credits) => {
		expect(() => normalizeSceneAnalysis({ ...fixture(), credits })).toThrow();
	});
	it("preserves reference-player scene context and character appearance", () => {
		const source = fixture();
		const context = {
			characters: [{ name: "Sam", appearance: "Brown jacket" }],
			dynamics: {
				tension: "FUTURE_TENSION",
				pacing: "Unhurried",
				ignored: "private",
			},
			settings: [
				null,
				{
					location: {
						name: "Garden",
						description: "Behind the house",
						url: "https://private",
					},
					timeOfDay: "Dawn",
					atmosphere: {
						mood: "Quiet",
						lighting: "Soft",
						weather: "Cloudy",
						payload: "private",
					},
				},
			],
		};
		const result = normalizeSceneAnalysis({
			...source,
			scenes: [{ ...source.scenes[0], content: context }],
		});
		expect(result.scenes[0]?.content).toMatchObject({
			characters: [{ name: "Sam", appearance: "Brown jacket" }],
			dynamics: { tension: "FUTURE_TENSION", pacing: "Unhurried" },
			settings: [
				{
					location: { name: "Garden", description: "Behind the house" },
					timeOfDay: "Dawn",
					atmosphere: { mood: "Quiet", lighting: "Soft", weather: "Cloudy" },
				},
			],
		});
		expect(JSON.stringify(result)).not.toContain("private");
		expect(sceneAnalysisDocumentSchema.parse(result)).toEqual(result);
	});
	it("accepts nullable context fields and old documents without inventing an ad score", () => {
		const source = fixture();
		const result = normalizeSceneAnalysis({
			...source,
			scenes: [
				{
					...source.scenes[0],
					adOpportunityInformation: { reason: "Unavailable" },
					content: {
						dynamics: null,
						settings: [
							null,
							{ location: null, timeOfDay: null, atmosphere: null },
						],
						characters: [{ appearance: null }],
					},
				},
			],
		});
		expect(result.scenes[0]?.content).toMatchObject({
			settings: [{ timeOfDay: "" }],
			characters: [{ appearance: undefined }],
		});
		expect(result.scenes[0]?.content?.dynamics).toBeUndefined();
		expect(result.scenes[0]?.adOpportunityInformation?.score).toBeUndefined();
		const old = normalizeSceneAnalysis(source);
		expect(sceneAnalysisDocumentSchema.parse(old)).toEqual(old);
		expect(old.scenes[0]?.content?.settings).toBeUndefined();
	});
	it.each([
		{ dynamics: { tension: "x".repeat(513) } },
		{ settings: [{ atmosphere: { weather: { nested: true } } }] },
		{ settings: Array(201).fill(null) },
		{ characters: [{ appearance: "x".repeat(16_001) }] },
	])("rejects malformed or oversized scene context case %#", (content) => {
		const source = fixture();
		expect(() =>
			normalizeSceneAnalysis({
				...source,
				scenes: [{ ...source.scenes[0], content }],
			}),
		).toThrow();
	});
	it("retains shot-relative zero on late shots and bounds it by shot duration", () => {
		const source = fixture();
		const scene = source.scenes[0];
		const shot = scene?.shots[0];
		const subject = shot?.mainSubjects[0];
		if (!scene || !shot || !subject) throw new Error("Missing subject fixture");
		const raw = (appearanceTimeInSeconds: number) => ({
			...source,
			scenes: [
				{
					...scene,
					shots: [
						{
							...shot,
							startInSeconds: 12,
							endInSeconds: 15,
							mainSubjects: [{ ...subject, appearanceTimeInSeconds }],
						},
					],
				},
			],
		});
		for (const relative of [0, 3]) {
			expect(
				normalizeSceneAnalysis(raw(relative)).scenes[0]?.shots[0]
					?.mainSubjects[0]?.appearanceTimeInSeconds,
			).toBe(relative);
		}
		for (const relative of [-0.01]) {
			expect(() => normalizeSceneAnalysis(raw(relative))).toThrow();
		}
		for (const relative of [3.01, 12]) {
			const input = raw(relative);
			const result = normalizeSceneAnalysis(input);
			expect(result.scenes[0]?.shots[0]?.mainSubjects).toEqual([]);
			expect(result.omittedSubjectCount).toBe(1);
			expect(
				input.scenes[0]?.shots[0]?.mainSubjects[0]?.appearanceTimeInSeconds,
			).toBe(relative);
		}
	});
	it("validates stored normalized documents without requiring provider metadata", () => {
		const normalized = normalizeSceneAnalysis(fixture());
		expect(sceneAnalysisDocumentSchema.parse(normalized)).toEqual(normalized);
		expect(() =>
			sceneAnalysisDocumentSchema.parse({ ...normalized, duration: 1 }),
		).toThrow();
		expect(() =>
			sceneAnalysisDocumentSchema.parse({ ...normalized, providerVersion: "" }),
		).toThrow();
	});
	it("preserves future version, fractional seek times and supported provider metadata", () => {
		const result = normalizeSceneAnalysis(fixture());
		expect(result.providerVersion).toBe("2026.99");
		expect(result.duration).toBe(20.5);
		expect(result.scenes[0]?.startInSeconds).toBe(1.25);
		expect(result.scenes[0]?.shots[0]?.mainSubjects[0]).toMatchObject({
			appearanceTimeInSeconds: 1.25,
			centerX: 80,
		});
		expect(result.scenes[0]?.content?.characters[0]?.name).toBe("Sam");
		expect(result.scenes[0]?.iab?.contentTaxonomies).toEqual(["Arts"]);
		expect(result.scenes[0]?.adOpportunityInformation?.score).toBe(0.7);
		expect(
			result.scenes[0]?.shots[0]?.shotAdvisories?.advisories[0]?.confidence,
		).toBe("LOW");
	});
	it("defaults nullable optional fields and filters null entries at each array boundary", () => {
		const source = fixture();
		const result = normalizeSceneAnalysis({
			...source,
			title: null,
			description: null,
			keywords: [null, "one"],
			scenes: [
				null,
				{ ...source.scenes[0], shots: [null], content: { characters: [null] } },
			],
		});
		expect(result.title).toBe("");
		expect(result.description).toBe("");
		expect(result.keywords).toEqual(["one"]);
		expect(result.scenes).toHaveLength(1);
		expect(result.scenes[0]?.shots).toEqual([]);
		expect(result.scenes[0]?.content?.characters).toEqual([]);
		expect(
			normalizeSceneAnalysis({ metadata: { version: "1" }, duration: 1 })
				.scenes,
		).toEqual([]);
	});
	it("strips unknown fields and provider URLs at every object boundary", () => {
		const source = fixture();
		const result = normalizeSceneAnalysis({
			...source,
			playbackUrl: "https://internal/secret",
			metadata: { version: "1", token: "secret" },
			scenes: [
				{
					...source.scenes[0],
					thumbnailUrl: "https://internal",
					content: {
						characters: [{ name: "Sam", privatePayload: { secret: true } }],
					},
				},
			],
		});
		expect(JSON.stringify(result)).not.toMatch(
			/https:|privatePayload|token|secret/,
		);
	});
	it.each([
		null,
		{},
		{ duration: 1 },
		{ metadata: { version: "" }, duration: 1 },
		{ metadata: { version: 1 }, duration: 1 },
	])("requires a version and valid document: %j", (source) => {
		expect(() => normalizeSceneAnalysis(source)).toThrow();
	});
	it.each([
		0,
		-1,
		Number.NaN,
		Number.POSITIVE_INFINITY,
		"20",
	])("rejects invalid duration %s", (duration) => {
		expect(() => normalizeSceneAnalysis({ ...fixture(), duration })).toThrow();
	});
	it.each([
		{ startInSeconds: -1 },
		{ endInSeconds: 21 },
		{ endInSeconds: 1.25 },
		{ startInSeconds: Number.POSITIVE_INFINITY },
		{ id: "untrusted-id" },
	])("rejects invalid scene fields %j", (fields) => {
		const source = fixture();
		expect(() =>
			normalizeSceneAnalysis({
				...source,
				scenes: [{ ...source.scenes[0], ...fields }],
			}),
		).toThrow();
	});
	it("rejects duplicate IDs while allowing gaps and overlapping scenes", () => {
		const source = fixture();
		expect(() =>
			normalizeSceneAnalysis({
				...source,
				scenes: [source.scenes[0], source.scenes[0]],
			}),
		).toThrow(/unique/);
		expect(
			normalizeSceneAnalysis({
				...source,
				scenes: [
					source.scenes[0],
					{ ...source.scenes[0], id: "04227fbc-22fe-41c1-bf9b-ab2baf6e4848" },
				],
			}).scenes,
		).toHaveLength(2);
	});
	it.each([
		[653.83, 151.3125, 238.875, 149.875, 152.916667],
		[653.83, 428.5, 477, 428.041667, 440.666667],
		[5585.96, 202.8, 371.42, 365.48, 371.72],
	])("preserves an overlapping provider shot across scene boundaries (%j)", (duration, sceneStart, sceneEnd, shotStart, shotEnd) => {
		const subject = {
			classification: "subject",
			description: "",
			appearanceTimeInSeconds: 0.5,
			centerX: 50,
			centerY: 50,
		};
		const raw = {
			metadata: { version: "1.79.0" },
			duration,
			scenes: [
				{
					id: "61cd7f2b-4057-4d21-9475-0bc5bfd78413",
					startInSeconds: sceneStart,
					endInSeconds: sceneEnd,
					shots: [
						{
							startInSeconds: shotStart,
							endInSeconds: shotEnd,
							mainSubjects: [subject],
						},
					],
				},
			],
		};
		const result = normalizeSceneAnalysis(raw);
		expect(result.scenes[0]?.shots[0]).toMatchObject({
			startInSeconds: shotStart,
			endInSeconds: shotEnd,
			mainSubjects: [subject],
		});
		expect(sceneAnalysisDocumentSchema.parse(result)).toEqual(result);
		expect(raw.scenes[0]?.shots[0]?.mainSubjects).toEqual([subject]);
	});
	it.each([
		[-1, 2],
		[0, 1.25],
		[19.75, 20],
		[2.5, 2.5],
		[5, 4],
		[19, 20.51],
	])("rejects invalid shot interval [%s, %s]", (startInSeconds, endInSeconds) => {
		const source = fixture();
		const raw = {
			...source,
			scenes: [
				{ ...source.scenes[0], shots: [{ startInSeconds, endInSeconds }] },
			],
		};
		expect(() => normalizeSceneAnalysis(raw)).toThrow();
		const normalized = normalizeSceneAnalysis(source);
		expect(() =>
			sceneAnalysisDocumentSchema.parse({
				...normalized,
				scenes: [
					{
						...normalized.scenes[0],
						shots: [{ startInSeconds, endInSeconds }],
					},
				],
			}),
		).toThrow();
	});
	it("rejects invalid shot bounds and subject image coordinates", () => {
		const source = fixture();
		const first = source.scenes[0];
		if (!first) throw new Error("Missing scene fixture");
		const firstShot = first.shots[0];
		if (!firstShot) throw new Error("Missing shot fixture");
		for (const fields of [
			{ startInSeconds: -1 },
			{ endInSeconds: 21 },
			{ endInSeconds: 2 },
			{ mainSubjects: [{ ...firstShot.mainSubjects[0], centerX: 101 }] },
		]) {
			expect(() =>
				normalizeSceneAnalysis({
					...source,
					scenes: [{ ...first, shots: [{ ...firstShot, ...fields }] }],
				}),
			).toThrow();
		}
	});
	it("rejects malformed nullable entries instead of silently dropping them", () => {
		expect(() =>
			normalizeSceneAnalysis({ ...fixture(), scenes: [null, "bad"] }),
		).toThrow();
		expect(() =>
			normalizeSceneAnalysis({ ...fixture(), keywords: [null, 42] }),
		).toThrow();
	});
	it("bounds raw bytes, text and collection counts even for unknown payloads", () => {
		expect(() =>
			normalizeSceneAnalysis({
				...fixture(),
				payload: "x".repeat(MAX_SCENE_ANALYSIS_BYTES),
			}),
		).toThrow(/8 MiB/);
		expect(() =>
			normalizeSceneAnalysis({ ...fixture(), title: "x".repeat(1_025) }),
		).toThrow();
		expect(() =>
			normalizeSceneAnalysis({ ...fixture(), scenes: Array(5_001).fill(null) }),
		).toThrow();
		const cycle: Record<string, unknown> = fixture();
		cycle.self = cycle;
		expect(() => normalizeSceneAnalysis(cycle)).toThrow(/JSON/);
	});
});
