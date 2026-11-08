import { describe, expect, it } from "vitest";
import { mediaTaskCacheKey, mediaTaskIntentHash } from "./identity";
import { generationTaskResultSchema, mediaTaskCreateSchema } from "./schema";

const id = "00000000-0000-4000-8000-000000000001";
const plain = {
	version: "portrait-layout-v1",
	videoFit: "FILL",
	captionPlacement: "OVERLAY",
} as const;
const presentation = { ...plain, fallbackFraming: "AISA_STATIC_V1" } as const;
const input = (p: unknown = plain) => ({
	kind: "GENERATE",
	mediaVersionId: id,
	analysisRevisionId: id,
	requestKey: id,
	parameters: {
		contentId: id,
		targetDurationFrames: 90,
		renderMode: "DRAFT",
		presentation: p,
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
describe("versioned static fallback intent", () => {
	it("keeps optional policy in request/result provenance and distinct cache/intent hashes", () => {
		const old = mediaTaskCreateSchema.parse(input()),
			next = mediaTaskCreateSchema.parse(input(presentation));
		expect(next.parameters).toHaveProperty("presentation", presentation);
		expect(mediaTaskIntentHash(next)).not.toBe(mediaTaskIntentHash(old));
		expect(mediaTaskCacheKey(next, identity)).not.toBe(
			mediaTaskCacheKey(old, identity),
		);
		const result = generationTaskResultSchema.parse({
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
		});
		expect(result.presentation).toEqual(presentation);
		expect(mediaTaskCreateSchema.parse(input()).parameters).toHaveProperty(
			"presentation",
			plain,
		);
	});
	it.each([
		undefined,
		"EXPORT",
	])("rejects static fallback policy on non-DRAFT %s", (renderMode) => {
		const request = input(presentation);
		expect(
			mediaTaskCreateSchema.safeParse({
				...request,
				parameters: { ...request.parameters, renderMode },
			}).success,
		).toBe(false);
	});
	it("rejects invented policy versions rather than coercing them", () => {
		expect(
			mediaTaskCreateSchema.safeParse(
				input({ ...plain, fallbackFraming: "latest" }),
			).success,
		).toBe(false);
	});
});
