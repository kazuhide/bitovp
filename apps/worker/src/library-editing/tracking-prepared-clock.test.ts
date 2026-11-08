import {
	buildPreparedShotPartition,
	getPreparedShotPartitionEntry,
	hashEditingEvidence,
	normalizationCaptureReceiptSchema,
	normalizeSceneAnalysis,
} from "@bitovp/core";
import { describe, expect, it } from "vitest";
import { buildNormalizationRecipe } from "./normalization";
import { trackingCacheKey, trackingShotFromAnalysis } from "./tracking";

const id = (number: number) =>
	`00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
const canonicalUs = (frame: number) =>
	Number((BigInt(frame) * 1_000_000n + 29n) / 30n);

function fixture(cut = 5 / 24, appearance = 0) {
	const mediaVersionId = id(1),
		sceneId = id(2);
	const source = {
		width: 80,
		height: 60,
		codec: "h264" as const,
		fps: { num: 24, den: 1 },
		timeBase: { num: 1, den: 24_000 },
		frameCount: 48,
		durationUs: 2_000_000,
		videoPtsHash: hashEditingEvidence({ fixture: "strict decoded CFR24" }),
		colorProfile: "BT709_8BIT_LIMITED" as const,
		audio: null,
	};
	const recipe = buildNormalizationRecipe(source);
	const normalization = normalizationCaptureReceiptSchema.parse({
		schemaVersion: 1,
		profile: "SDR_CFR30_INDEXED_V1",
		mode: "NORMALIZE",
		organizationId: id(3),
		sourceId: id(4),
		mediaVersionId,
		timeMapId: mediaVersionId,
		originalSha256: "a".repeat(64),
		preparedSha256: "b".repeat(64),
		originalBytes: 100,
		preparedBytes: 120,
		source,
		output: {
			width: source.width,
			height: source.height,
			frameCount: recipe.outputFrameCount,
			durationUs: recipe.sourceEndUs,
			fps: { num: 30, den: 1 },
			hasAudio: false,
		},
		sourceStartUs: 0,
		sourceEndUs: recipe.sourceEndUs,
		sourceFrameIndex: recipe.sourceFrameIndex,
		indexMapHash: hashEditingEvidence(recipe.sourceFrameIndex),
		recipeHash: hashEditingEvidence({
			profile: "SDR_CFR30_INDEXED_V1",
			mode: "NORMALIZE",
			source,
			videoFilter: recipe.videoFilter,
			audioFilter: recipe.audioFilter,
		}),
	});
	const timeMap = {
		id: mediaVersionId,
		mediaVersionId,
		kind: "CFR",
		sourceStartUs: 0,
		sourceEndUs: recipe.sourceEndUs,
		editingStartFrame: 0,
		editingEndFrame: recipe.outputFrameCount,
		fps: { num: 30, den: 1 },
	};
	const analysis = normalizeSceneAnalysis({
		metadata: { version: "authored-prepared-clock-tracking-regression" },
		duration: 2,
		scenes: [
			{
				id: sceneId,
				type: "MAIN_CONTENT",
				startInSeconds: 0,
				endInSeconds: 2,
				shots: [
					{ startInSeconds: 0, endInSeconds: cut },
					{ startInSeconds: cut, endInSeconds: 2 },
				].map((shot) => ({
					...shot,
					mainSubjects: [
						{
							classification: "Person",
							description: "Explicit authored seed, no provider execution",
							appearanceTimeInSeconds: appearance,
							centerX: 35,
							centerY: 40,
							box2d: [333, 250, 533, 450],
						},
					],
				})),
			},
		],
	});
	const preparedPartition = buildPreparedShotPartition({
		analysis,
		timeMap,
		normalization,
	});
	const shots = analysis.scenes[0]?.shots;
	if (!shots?.[0] || !shots[1]) throw new Error("Missing shot fixture");
	return { preparedPartition, shots: [shots[0], shots[1]] as const, sceneId };
}

describe("tracking consumes only a verified prepared-clock partition entry", () => {
	it("retains the exact pre-partition inner tracker cache identity", () => {
		expect(
			trackingCacheKey({
				mediaSha256: "a".repeat(64),
				sourceWidth: 80,
				sourceHeight: 60,
				shots: [
					{
						sceneId: id(2),
						shotIndex: 0,
						startUs: 0,
						endUs: 200_000,
						startFrame: 0,
						endFrame: 6,
						seed: {
							sourceFrame: 0,
							sourceTimeUs: 0,
							box: { x: 0.25, y: 0.333, w: 0.2, h: 0.2 },
						},
					},
				],
			}),
		).toBe("5bcb9a770551972c449b41c0879ac4cc180812ec58e91e293173a3bac2cbbf0c");
	});
	it("accepts the source-backed seventh frame at an exact shared 24fps cut", () => {
		const f = fixture();
		const shot = trackingShotFromAnalysis({
			sceneId: f.sceneId,
			shotIndex: 0,
			shot: f.shots[0],
			sourceStartUs: 0,
			preparedPartition: f.preparedPartition,
			frameWindow: { startFrame: 0, endFrame: 7 },
		});
		expect(shot).toMatchObject({
			startFrame: 0,
			endFrame: 7,
			endUs: canonicalUs(7),
			seed: { sourceFrame: 0, sourceTimeUs: 0 },
		});
	});
	it("retains legacy strict bounds when no partition is supplied", () => {
		const f = fixture();
		expect(
			trackingShotFromAnalysis({
				sceneId: f.sceneId,
				shotIndex: 0,
				shot: f.shots[0],
				sourceStartUs: 0,
			}),
		).toMatchObject({ startFrame: 0, endFrame: 6 });
		expect(() =>
			trackingShotFromAnalysis({
				sceneId: f.sceneId,
				shotIndex: 0,
				shot: f.shots[0],
				sourceStartUs: 0,
				frameWindow: { startFrame: 0, endFrame: 7 },
			}),
		).toThrow("Tracking window exceeds its original shot");
	});
	it.each([
		"scene",
		"index",
		"raw-shot",
		"origin",
		"forged",
	])("rejects a partition that does not attest this consumer input (%s)", (change) => {
		const f = fixture();
		const input = {
			sceneId: f.sceneId,
			shotIndex: 0,
			shot: f.shots[0],
			sourceStartUs: 0,
			preparedPartition: f.preparedPartition,
		};
		if (change === "scene") input.sceneId = id(99);
		if (change === "index") input.shotIndex = 1;
		if (change === "raw-shot")
			input.shot = { ...input.shot, detailedDescription: "Different evidence" };
		if (change === "origin") input.sourceStartUs = 1_000_000;
		if (change === "forged")
			input.preparedPartition = structuredClone(f.preparedPartition);
		expect(() => trackingShotFromAnalysis(input)).toThrow(RangeError);
	});
	it("does not permit an arbitrary window beyond the attested entry", () => {
		const f = fixture();
		expect(() =>
			trackingShotFromAnalysis({
				sceneId: f.sceneId,
				shotIndex: 0,
				shot: f.shots[0],
				sourceStartUs: 0,
				preparedPartition: f.preparedPartition,
				frameWindow: { startFrame: 0, endFrame: 8 },
			}),
		).toThrow(RangeError);
	});
	it("restricts a rounded-cut prefix to the certain interior", () => {
		const f = fixture(0.166667),
			entry = getPreparedShotPartitionEntry(f.preparedPartition, {
				sceneId: f.sceneId,
				shotIndex: 1,
			});
		expect(entry).toMatchObject({
			fromFrame: 5,
			certainFromFrame: 6,
		});
		const shot = trackingShotFromAnalysis({
			sceneId: f.sceneId,
			shotIndex: 1,
			shot: f.shots[1],
			sourceStartUs: 0,
			preparedPartition: f.preparedPartition,
		});
		expect(shot?.startFrame).toBe(6);
		expect(shot?.seed).toBeUndefined();
	});
	it("returns no tracking for a window containing only the uncertain prefix", () => {
		const f = fixture(0.166667);
		expect(
			trackingShotFromAnalysis({
				sceneId: f.sceneId,
				shotIndex: 1,
				shot: f.shots[1],
				sourceStartUs: 0,
				preparedPartition: f.preparedPartition,
				frameWindow: { startFrame: 5, endFrame: 6 },
			}),
		).toBeUndefined();
	});
	it("does not move an earlier appearance seed to a later selected subwindow", () => {
		const f = fixture(1, 1 / 24);
		const shot = trackingShotFromAnalysis({
			sceneId: f.sceneId,
			shotIndex: 0,
			shot: f.shots[0],
			sourceStartUs: 0,
			preparedPartition: f.preparedPartition,
			frameWindow: { startFrame: 3, endFrame: 30 },
		});
		expect(shot).toMatchObject({ startFrame: 3, endFrame: 30 });
		expect(shot?.seed).toBeUndefined();
	});
	it("maps a genuine between-source-frame appearance through original fps only in the new clock", () => {
		const f = fixture(1, 0.1);
		const input = {
			sceneId: f.sceneId,
			shotIndex: 0,
			shot: f.shots[0],
			sourceStartUs: 0,
		};
		expect(trackingShotFromAnalysis(input)?.seed?.sourceFrame).toBe(3);
		expect(
			trackingShotFromAnalysis({
				...input,
				preparedPartition: f.preparedPartition,
			})?.seed,
		).toMatchObject({ sourceFrame: 4, sourceTimeUs: canonicalUs(4) });
	});
	it("uses raw shot start plus relative appearance, not the rounded partition start", () => {
		const f = fixture(5 / 24, 1 / 24);
		const shot = trackingShotFromAnalysis({
			sceneId: f.sceneId,
			shotIndex: 1,
			shot: f.shots[1],
			sourceStartUs: 0,
			preparedPartition: f.preparedPartition,
		});
		expect(shot?.seed).toMatchObject({
			sourceFrame: 8,
			sourceTimeUs: canonicalUs(8),
		});
	});
	it("treats a source appearance beyond the prepared final sample as no seed", () => {
		const f = fixture(1, 0.999999);
		const shot = trackingShotFromAnalysis({
			sceneId: f.sceneId,
			shotIndex: 1,
			shot: f.shots[1],
			sourceStartUs: 0,
			preparedPartition: f.preparedPartition,
		});
		expect(shot).toMatchObject({ startFrame: 30, endFrame: 60 });
		expect(shot?.seed).toBeUndefined();
	});
});
