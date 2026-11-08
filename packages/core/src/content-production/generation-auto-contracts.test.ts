import { describe, expect, it } from "vitest";
import {
	generationTaskResultSchema,
	mediaTaskCacheKey,
	mediaTaskCreateSchema,
	mediaTaskIntentHash,
} from "./index";

const id = "00000000-0000-4000-8000-000000000001";
const presentation = {
	version: "portrait-layout-v1",
	videoFit: "AUTO",
	captionPlacement: "OVERLAY",
} as const;
const request = (settings: unknown = presentation) => ({
	kind: "GENERATE",
	mediaVersionId: id,
	analysisRevisionId: id,
	requestKey: id,
	parameters: {
		contentId: id,
		targetDurationFrames: 90,
		renderMode: "DRAFT",
		presentation: settings,
	},
});
const identity = {
	organizationId: id,
	mediaSha256: "a".repeat(64),
	modelSha256: null,
	analysisDocumentHash: "c".repeat(64),
	analysisRawHash: "d".repeat(64),
	timeMapHash: "e".repeat(64),
};
const result = {
	projectId: id,
	projectIds: [id],
	renderMode: "DRAFT",
	presentation,
	requestedFrames: 90,
	actualFrames: 90,
	warnings: [],
	policyVersion: "aisa-shot-window-v1",
	presetIds: ["portrait-clean"],
	metrics: {},
	cacheable: true,
};

describe("automatic content-preserving draft intent", () => {
	it("pins AUTO separately from explicit FILL and FIT for cache and replay identity", () => {
		const automatic = mediaTaskCreateSchema.parse(request());
		expect(automatic.parameters).toHaveProperty("presentation", presentation);
		for (const videoFit of ["FILL", "FIT"] as const) {
			const manual = mediaTaskCreateSchema.parse(
				request({ ...presentation, videoFit }),
			);
			expect(mediaTaskIntentHash(automatic)).not.toBe(
				mediaTaskIntentHash(manual),
			);
			expect(mediaTaskCacheKey(automatic, identity)).not.toBe(
				mediaTaskCacheKey(manual, identity),
			);
		}
	});
	it("retains the immutable AUTO result marker", () => {
		expect(generationTaskResultSchema.parse(result)).toHaveProperty(
			"presentation",
			presentation,
		);
	});
	it("still rejects AUTO create/result presentation on a nonexplicit DRAFT", () => {
		for (const renderMode of ["EXPORT", undefined] as const) {
			expect(
				mediaTaskCreateSchema.safeParse({
					...request(),
					parameters: { ...request().parameters, renderMode },
				}).success,
			).toBe(false);
			expect(
				generationTaskResultSchema.safeParse({ ...result, renderMode }).success,
			).toBe(false);
		}
	});
	it("does not let an AUTO caller supply preconfirmation or arbitrary backdrop effects", () => {
		for (const settings of [
			{ ...presentation, centerCropConfirmed: true },
			{
				...presentation,
				backdrop: { sourceUrl: "https://example.test/private", blurPx: 9999 },
			},
		]) {
			expect(mediaTaskCreateSchema.safeParse(request(settings)).success).toBe(
				false,
			);
		}
	});
});
