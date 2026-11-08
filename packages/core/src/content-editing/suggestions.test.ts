import { describe, expect, it } from "vitest";
import { normalizeSceneAnalysis } from "../content-library/analysis";
import {
	proposeHighlightCandidates,
	subjectCenterFromPercent,
	suggestFixedCrop,
	suggestShotFraming,
} from "./index";

const firstId = "11111111-1111-4111-8111-111111111111";
const secondId = "22222222-2222-4222-8222-222222222222";
const document = () =>
	normalizeSceneAnalysis({
		metadata: { version: "fixture" },
		duration: 60,
		scenes: [
			{
				id: secondId,
				startInSeconds: 30,
				endInSeconds: 40,
				type: "MAIN_CONTENT",
				title: "Result",
				summary: "A calm interview",
				adOpportunityInformation: { score: 1 },
			},
			{
				id: firstId,
				startInSeconds: 1.25,
				endInSeconds: 21.25,
				type: "MAIN_CONTENT",
				title: "Interview opening",
				keywords: ["calm"],
				adOpportunityInformation: { score: 0 },
			},
		],
	});
const geometry = {
	sourceWidth: 1920,
	sourceHeight: 1080,
	targetWidth: 1080,
	targetHeight: 1920,
};

describe("subject coordinates and fixed crop", () => {
	it("converts percent explicitly including fractional percent", () => {
		expect(subjectCenterFromPercent(0, 100)).toEqual({ x: 0, y: 1 });
		expect(subjectCenterFromPercent(0.8, 50)).toEqual({ x: 0.008, y: 0.5 });
		for (const value of [
			null,
			undefined,
			"70",
			-1,
			101,
			Number.NaN,
			Infinity,
		]) {
			expect(subjectCenterFromPercent(value, 50)).toBeNull();
		}
	});
	it("makes the documented portrait crop without claiming a subject box", () => {
		const crop = suggestFixedCrop({ ...geometry, centerX: 0.7, centerY: 0.5 });
		expect(crop).toEqual({ x: 0.541796875, y: 0, w: 0.31640625, h: 1 });
		expect(suggestFixedCrop({ ...geometry, centerX: 0, centerY: 0 }).x).toBe(0);
		expect(suggestFixedCrop({ ...geometry, centerX: 1, centerY: 1 }).x).toBe(
			1 - crop.w,
		);
	});
	it("handles a portrait source and rejects invalid geometry", () => {
		const crop = suggestFixedCrop({
			sourceWidth: 1080,
			sourceHeight: 1920,
			targetWidth: 1920,
			targetHeight: 1080,
			centerX: 0.5,
			centerY: 0.7,
		});
		expect(crop).toEqual({ x: 0, y: 0.541796875, w: 1, h: 0.31640625 });
		expect(() =>
			suggestFixedCrop({
				...geometry,
				sourceWidth: 0,
				centerX: 0.5,
				centerY: 0.5,
			}),
		).toThrow();
		expect(() =>
			suggestFixedCrop({
				...geometry,
				targetWidth: 0.5,
				centerX: 0.5,
				centerY: 0.5,
			}),
		).toThrow();
		expect(() =>
			suggestFixedCrop({ ...geometry, centerX: 70, centerY: 0.5 }),
		).toThrow();
	});
	it("requires subject choice and qualified coordinates before crop", () => {
		const subjects = [
			{ centerX: 20, centerY: 50 },
			{ centerX: 70, centerY: 50 },
		];
		expect(
			suggestShotFraming({
				...geometry,
				mainSubjects: subjects,
				coordinateSpaceVerified: true,
			}),
		).toMatchObject({
			mode: "FIT",
			reasonCode: "SUBJECT_SELECTION_REQUIRED",
			requiresConfirmation: true,
		});
		expect(
			suggestShotFraming({
				...geometry,
				mainSubjects: subjects,
				subjectIndex: 1,
				coordinateSpaceVerified: false,
			}),
		).toMatchObject({ mode: "FIT", reasonCode: "DISPLAY_GEOMETRY_UNVERIFIED" });
		expect(
			suggestShotFraming({
				...geometry,
				mainSubjects: subjects,
				subjectIndex: 1,
				coordinateSpaceVerified: true,
			}),
		).toMatchObject({
			mode: "CROP",
			rect: { x: 0.541796875 },
			origin: "AISA_PROPOSAL",
			requiresConfirmation: true,
		});
		expect(
			suggestShotFraming({
				...geometry,
				mainSubjects: [{ centerX: null, centerY: 50 }],
				coordinateSpaceVerified: true,
			}),
		).toMatchObject({ mode: "FIT", reasonCode: "SUBJECT_POSITION_MISSING" });
	});
});

describe("highlight proposals", () => {
	it("does not silently select the best moments without a query or user selection", () => {
		expect(proposeHighlightCandidates(document(), {})).toEqual([]);
	});
	it("uses literal all-term matching and chronological order, not ad score", () => {
		const candidates = proposeHighlightCandidates(document(), {
			query: "CALM interview",
		});
		expect(candidates.map((item) => item.sceneId)).toEqual([firstId, secondId]);
		expect(candidates[0]).toMatchObject({
			sourceInUs: 1_250_000,
			sourceOutUs: 21_250_000,
			durationFrames: 600,
			reasonCodes: ["QUERY_MATCH"],
			binding: "UNVERIFIED",
			requiresConfirmation: true,
		});
		expect(proposeHighlightCandidates(document(), { query: "absent" })).toEqual(
			[],
		);
	});
	it("preserves selected intervals and reports excess duration instead of cutting speech", () => {
		const candidates = proposeHighlightCandidates(document(), {
			selectedSceneIds: [firstId],
			query: "absent",
			targetDurationFrames: 450,
			analysisBinding: "EDITOR_CONFIRMED",
		});
		expect(candidates).toHaveLength(1);
		expect(candidates[0]).toMatchObject({
			sceneId: firstId,
			sourceInUs: 1_250_000,
			sourceOutUs: 21_250_000,
			exceedsTargetDuration: true,
			reasonCodes: ["SCENE_SELECTED"],
			binding: "EDITOR_CONFIRMED",
			requiresConfirmation: true,
		});
	});
	it("honours exclusions, limits, and duplicate interval suppression", () => {
		const input = document();
		const scene = input.scenes[0];
		if (!scene) throw new Error("Missing test fixture scene");
		scene.type = "ADS";
		expect(
			proposeHighlightCandidates(input, { query: "interview" }).map(
				(x) => x.sceneId,
			),
		).toEqual([firstId]);
		expect(
			proposeHighlightCandidates(input, {
				query: "interview",
				excludedSceneTypes: [],
				maxCandidates: 1,
			}),
		).toHaveLength(1);
		scene.startInSeconds = 1.25;
		scene.endInSeconds = 21.25;
		expect(
			proposeHighlightCandidates(input, {
				query: "interview",
				excludedSceneTypes: [],
			}),
		).toHaveLength(1);
	});
});
