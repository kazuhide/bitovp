import { describe, expect, it } from "vitest";
import { mediaTaskCacheKey, mediaTaskIntentHash } from "./identity";
import { generationTaskResultSchema, mediaTaskCreateSchema } from "./schema";

const id = "00000000-0000-4000-8000-000000000001";
const presentation = {
	version: "portrait-layout-v1",
	videoFit: "AUTO",
	captionPlacement: "OVERLAY",
	fallbackFraming: "PRESERVE_SOURCE_V1",
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
	analysisDocumentHash: "b".repeat(64),
	analysisRawHash: "c".repeat(64),
	timeMapHash: "d".repeat(64),
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
describe("versioned preserve-source generation intent", () => {
	it("retains request/result provenance and separates cache/intent from every older AUTO marker", () => {
		const next = mediaTaskCreateSchema.parse(request());
		expect(next.parameters).toHaveProperty("presentation", presentation);
		expect(generationTaskResultSchema.parse(result).presentation).toEqual(
			presentation,
		);
		for (const fallbackFraming of [undefined, "AISA_STATIC_V1"] as const) {
			const oldPresentation = { ...presentation, fallbackFraming };
			if (fallbackFraming === undefined)
				Reflect.deleteProperty(oldPresentation, "fallbackFraming");
			const old = mediaTaskCreateSchema.parse(request(oldPresentation));
			expect(mediaTaskIntentHash(next)).not.toBe(mediaTaskIntentHash(old));
			expect(mediaTaskCacheKey(next, identity)).not.toBe(
				mediaTaskCacheKey(old, identity),
			);
		}
	});
	it("keeps omitted legacy presentation omitted rather than silently applying a new default", () => {
		const old = request();
		Reflect.deleteProperty(old.parameters, "presentation");
		expect(
			Object.hasOwn(
				mediaTaskCreateSchema.parse(old).parameters,
				"presentation",
			),
		).toBe(false);
		const oldResult = { ...result };
		Reflect.deleteProperty(oldResult, "presentation");
		expect(
			Object.hasOwn(
				generationTaskResultSchema.parse(oldResult),
				"presentation",
			),
		).toBe(false);
	});
	it.each([
		undefined,
		"EXPORT",
	] as const)("rejects preserve-source presentation on nonexplicit DRAFT %s", (renderMode) => {
		const input = request();
		expect(
			mediaTaskCreateSchema.safeParse({
				...input,
				parameters: { ...input.parameters, renderMode },
			}).success,
		).toBe(false);
		expect(
			generationTaskResultSchema.safeParse({ ...result, renderMode }).success,
		).toBe(false);
	});
	it("does not permit preconfirmation or caller-authored backdrop/source effects", () => {
		for (const settings of [
			{ ...presentation, centerCropConfirmed: true },
			{
				...presentation,
				backdrop: {
					sourceUrl: "https://example.test/other-source",
					blurPx: 999,
				},
			},
		])
			expect(mediaTaskCreateSchema.safeParse(request(settings)).success).toBe(
				false,
			);
	});
});
