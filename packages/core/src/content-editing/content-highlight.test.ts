import { describe, expect, it } from "vitest";
import { normalizeSceneAnalysis } from "../content-library/analysis";
import { createPortraitSelectionSearchBudget } from "./auto-portrait";
import {
	buildContentHighlightEvidence,
	selectContentHighlightClips,
} from "./content-highlight";
import {
	buildSpeechContextWindow,
	refinePortraitSelectionBySpeech,
} from "./speech-boundaries";

const a = "11111111-1111-4111-8111-111111111111";
const b = "22222222-2222-4222-8222-222222222222";
const c = "33333333-3333-4333-8333-333333333333";
const map = {
	id: a,
	mediaVersionId: b,
	kind: "CFR",
	sourceStartUs: 0,
	sourceEndUs: 120_000_000,
	editingStartFrame: 0,
	editingEndFrame: 3600,
	fps: { num: 30, den: 1 },
};
const scene = (id: string, from: number, to: number, text = "") => ({
	id,
	startInSeconds: from,
	endInSeconds: to,
	type: "MAIN_CONTENT",
	title: text,
	shots: [
		{ startInSeconds: from, endInSeconds: to, detailedDescription: text },
	],
});
const analysis = (scenes: unknown[]) =>
	normalizeSceneAnalysis({
		metadata: { version: "content-test" },
		duration: 120,
		scenes,
	});

describe("bounded no-hint metadata highlight policy", () => {
	it("filters anchors against a nonzero original source window before asking its frame resolver", () => {
		const source = analysis([
			scene(a, 0, 1, "The robot discovers the key and rescues a bird"),
			scene(b, 10, 11, "The robot discovers a key"),
			scene(c, 12, 13, "The robot discovers the key and rescues a bird"),
		]);
		const calls: string[] = [];
		const result = selectContentHighlightClips(
			{
				analysis: source,
				timeMap: {
					...map,
					sourceStartUs: 10_000_000,
					sourceEndUs: 12_000_000,
					editingEndFrame: 60,
				},
				targetDurationFrames: 60,
			},
			(sceneId) => {
				calls.push(sceneId);
				if (sceneId !== b)
					throw new Error("No prepared entry outside the source window");
				return { fromFrame: 0, toFrame: 30 };
			},
		);
		expect(result.clips).toEqual([
			{ sceneId: b, shotIndex: 0, sourceInUs: 10_000_000, durationFrames: 30 },
		]);
		expect(new Set(calls)).toEqual(new Set([b]));
	});
	it("chooses a late nonhuman key event over early filler without user hints", () => {
		const input = {
			analysis: analysis([
				scene(a, 0, 15, "A quiet landscape"),
				{
					...scene(
						b,
						30,
						45,
						"The rabbit discovers the trap and rescues the bird",
					),
					content: {
						characters: [
							{ name: "Rabbit", description: "The story protagonist" },
						],
						objects: [
							{ category: "trap", description: "A trap threatening the bird" },
						],
					},
				},
			]),
			timeMap: map,
			targetDurationFrames: 450,
		};
		const before = JSON.stringify(input);
		const result = selectContentHighlightClips(input);
		expect(result.policyVersion).toBe("aisa-content-highlight-v1");
		expect(result.clips.map((clip) => clip.sceneId)).toEqual([b]);
		expect(result.semanticEvidence.selectionReason).toBe("CONTENT_RANKED");
		expect(result.semanticEvidence.keyEntities).toContainEqual({
			kind: "CHARACTER",
			label: "Rabbit",
			sceneIds: [b],
		});
		expect(JSON.stringify(input)).toBe(before);
	});
	it("recognizes quiet state changes and product completion in Japanese", () => {
		const result = selectContentHighlightClips({
			analysis: analysis([
				scene(a, 0, 15, "台所の風景"),
				{
					...scene(b, 30, 45, "料理の盛り付けが完成し、断面を見せる"),
					content: {
						objects: [{ category: "ケーキ", description: "完成した料理" }],
					},
				},
			]),
			timeMap: map,
			targetDurationFrames: 450,
		});
		expect(result.clips[0]?.sceneId).toBe(b);
		expect(result.semanticEvidence.profile).toBe("INSTRUCTION");
		expect(
			result.semanticEvidence.keyEntities.some(
				(entity) => entity.kind === "OBJECT" && entity.label === "ケーキ",
			),
		).toBe(true);
	});
	it("retains a whole useful window around a short moment rather than selecting one second", () => {
		const result = selectContentHighlightClips({
			analysis: analysis([
				scene(a, 0, 15, "Landscape"),
				{
					...scene(b, 30, 45, "Discovery"),
					shots: [
						{
							startInSeconds: 30,
							endInSeconds: 37,
							detailedDescription: "The robot approaches a box",
						},
						{
							startInSeconds: 37,
							endInSeconds: 38,
							detailedDescription: "The robot discovers the missing key",
						},
						{
							startInSeconds: 38,
							endInSeconds: 45,
							detailedDescription: "The robot carries the key away",
						},
					],
				},
			]),
			timeMap: map,
			targetDurationFrames: 450,
		});
		expect(result.actualDurationFrames).toBe(450);
		expect(result.clips.map((clip) => clip.shotIndex)).toEqual([0, 1, 2]);
	});
	it("preserves excluded overlays, caller window predicates and source-shot indices", () => {
		const result = selectContentHighlightClips({
			analysis: analysis([
				scene(a, 0, 15, "The hero wins"),
				{ ...scene(c, 0, 15, "Amazing revelation"), type: "ADS" },
				scene(b, 30, 45, "The robot discovers the key"),
			]),
			timeMap: map,
			targetDurationFrames: 450,
			acceptWindow: (window) => window.fromFrame >= 900,
		});
		expect(result.clips).toEqual([
			{ sceneId: b, shotIndex: 0, sourceInUs: 30_000_000, durationFrames: 450 },
		]);
		expect(
			result.semanticEvidence.selectedMoments.map((moment) => moment.sceneId),
		).toEqual([b]);
	});
	it("uses an explicit metadata-insufficient fallback and ignores advertising scores", () => {
		const first = {
			...scene(a, 0, 15),
			adOpportunityInformation: { score: 0 },
		};
		const second = {
			...scene(b, 30, 45),
			adOpportunityInformation: { score: 1 },
		};
		const result = selectContentHighlightClips({
			analysis: analysis([first, second]),
			timeMap: map,
			targetDurationFrames: 450,
		});
		expect(result.clips[0]?.sceneId).toBe(a);
		expect(result.semanticEvidence).toMatchObject({
			profile: "GENERAL",
			selectionReason: "INSUFFICIENT_METADATA",
			keyEntities: [],
		});
	});
	it("rebuilds provenance from the final chosen clips only and keeps unknown metadata unknown", () => {
		const evidence = buildContentHighlightEvidence({
			analysis: analysis([scene(a, 0, 15, "The hero wins"), scene(b, 30, 45)]),
			clips: [
				{
					sceneId: b,
					shotIndex: 0,
					sourceInUs: 30_000_000,
					durationFrames: 450,
				},
			],
		});
		expect(evidence.selectedMoments.map((moment) => moment.sceneId)).toEqual([
			b,
		]);
		expect(evidence.selectedMoments[0]?.score).toBe(0);
	});
	it("is deterministic with a shared factory budget and rejects oversized metadata before search", () => {
		const input = {
			analysis: analysis([
				scene(a, 0, 15, "The hero wins"),
				scene(b, 30, 45, "The hero wins"),
			]),
			timeMap: map,
			targetDurationFrames: 450,
		};
		expect(
			selectContentHighlightClips({
				...input,
				searchBudget: createPortraitSelectionSearchBudget(),
			}),
		).toEqual(selectContentHighlightClips(input));
		expect(() =>
			selectContentHighlightClips({
				...input,
				analysis: {
					scenes: [{ shots: Array.from({ length: 10001 }, () => ({})) }],
				},
			}),
		).toThrow(/limit/);
	});
	it("falls back to the complete baseline when optional ranking exhausts the shared search budget", () => {
		const scenes = [a, b].map((id, sceneIndex) => ({
			id,
			type: "MAIN_CONTENT",
			startInSeconds: sceneIndex * 5000,
			endInSeconds: (sceneIndex + 1) * 5000,
			shots: Array.from({ length: 5000 }, (_, index) => ({
				startInSeconds: sceneIndex * 5000 + index,
				endInSeconds: sceneIndex * 5000 + index + 1,
				detailedDescription:
					index === 4999 ? "The robot discovers the key" : "",
			})),
		}));
		const source = normalizeSceneAnalysis({
			metadata: { version: "bounded" },
			duration: 10000,
			scenes,
		});
		const result = selectContentHighlightClips({
			analysis: source,
			timeMap: { ...map, sourceEndUs: 10_000_000_000, editingEndFrame: 300000 },
			targetDurationFrames: 600,
		});
		expect(result.semanticEvidence.selectionReason).toBe("SEARCH_BUDGET");
		expect(result.actualDurationFrames).toBe(600);
		expect(result.clips[0]?.sourceInUs).toBe(0);
	});
	it("uses the same AUTO policy when ASR requires a different safe whole-shot window", () => {
		const source = analysis([
			{
				...scene(a, 0, 6, "The robot discovers the key"),
				shots: [
					[0, 1],
					[1, 3],
					[3, 4],
					[4, 6],
				].map(([startInSeconds, endInSeconds]) => ({
					startInSeconds,
					endInSeconds,
				})),
			},
		]);
		const searchBudget = createPortraitSelectionSearchBudget(),
			input = {
				analysis: source,
				timeMap: map,
				targetDurationFrames: 120,
				searchBudget,
			};
		const anchor = selectContentHighlightClips(input);
		expect(anchor.actualDurationFrames).toBe(120);
		const result = refinePortraitSelectionBySpeech({
			...input,
			policy: "AUTO",
			anchor,
			context: buildSpeechContextWindow({ selection: anchor, timeMap: map }),
			segments: [
				{ startUs: 0, endUs: 500_000 },
				{ startUs: 3_500_000, endUs: 4_500_000 },
			],
		});
		expect(result.status).toBe("APPLIED");
		expect(result.selection.policyVersion).toBe("aisa-content-highlight-v1");
		expect(result.selection.clips.map((clip) => clip.shotIndex)).toEqual([1]);
	});
	it("keeps the event's key object ahead of incidental objects in bounded evidence", () => {
		const source = analysis([
			{
				...scene(a, 0, 15, "The robot discovers the missing key"),
				content: {
					objects: [
						...Array.from({ length: 12 }, (_, index) => ({
							category: `Background ${index}`,
							description: "An incidental decoration",
						})),
						{
							category: "key",
							description: "The object needed to unlock the door",
						},
					],
				},
			},
		]);
		const result = selectContentHighlightClips({
			analysis: source,
			timeMap: map,
			targetDurationFrames: 450,
		});
		expect(result.semanticEvidence.keyEntities[0]?.label).toBe("key");
		expect(result.semanticEvidence.keyEntities).toHaveLength(12);
	});
	it("does not claim content-ranked evidence when all meaningful shots exceed the requested duration", () => {
		const result = selectContentHighlightClips({
			analysis: analysis([
				scene(a, 0, 15, "Landscape"),
				scene(b, 30, 60, "The robot discovers a key"),
			]),
			timeMap: map,
			targetDurationFrames: 450,
		});
		expect(result.clips[0]?.sceneId).toBe(a);
		expect(result.semanticEvidence.selectionReason).toBe(
			"INSUFFICIENT_METADATA",
		);
	});
	it("does not classify fictional robots and their devices as a product demo", () => {
		const source = analysis([
			scene(
				a,
				0,
				15,
				"A robot story: a robot discovers a device. The robot repairs the device, the robot examines a device and a character finds another device. The landscape features mountains and features a river.",
			),
		]);
		const result = selectContentHighlightClips({
			analysis: source,
			timeMap: map,
			targetDurationFrames: 450,
		});
		expect(result.semanticEvidence.profile).toBe("NARRATIVE");
		const product = selectContentHighlightClips({
			analysis: analysis([
				scene(
					a,
					0,
					15,
					"Product demonstration: unboxing a new device and demonstrating the product",
				),
			]),
			timeMap: map,
			targetDurationFrames: 450,
		});
		expect(product.semanticEvidence.profile).toBe("PRODUCT");
	});
});
