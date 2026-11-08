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
	videoFit: "FILL",
	captionPlacement: "OVERLAY",
} as const;
const request = (
	mode: "DRAFT" | "EXPORT" | undefined = "DRAFT",
	settings: unknown = presentation,
) => ({
	kind: "GENERATE",
	mediaVersionId: id,
	analysisRevisionId: id,
	requestKey: id,
	parameters: {
		contentId: id,
		targetDurationFrames: 90,
		...(mode ? { renderMode: mode } : {}),
		...(settings === undefined ? {} : { presentation: settings }),
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
const result = (
	mode: "DRAFT" | "EXPORT" | undefined = "DRAFT",
	settings: unknown = presentation,
) => ({
	projectId: id,
	projectIds: [id],
	...(mode ? { renderMode: mode } : {}),
	...(settings === undefined ? {} : { presentation: settings }),
	requestedFrames: 90,
	actualFrames: 90,
	warnings: [],
	policyVersion: "aisa-shot-window-v1",
	presetIds: ["portrait-clean"],
	metrics: {},
	cacheable: true,
});
describe("explicit portrait presentation intent", () => {
	it("accepts an explicit DRAFT display intent and distinguishes layout intent/cache hashes", () => {
		const a = mediaTaskCreateSchema.parse(request());
		const b = mediaTaskCreateSchema.parse(
			request("DRAFT", { ...presentation, captionPlacement: "BANDS" }),
		);
		expect(a.parameters).toHaveProperty("presentation", presentation);
		expect(mediaTaskIntentHash(a)).not.toBe(mediaTaskIntentHash(b));
		expect(mediaTaskCacheKey(a, identity)).not.toBe(
			mediaTaskCacheKey(b, identity),
		);
	});
	it.each([
		"EXPORT",
		undefined,
	] as const)("refuses presentation on nonexplicit-DRAFT %s", (mode) => {
		expect(
			mediaTaskCreateSchema.safeParse({
				...request(),
				parameters: { ...request().parameters, renderMode: mode },
			}).success,
		).toBe(false);
		expect(
			generationTaskResultSchema.safeParse({ ...result(), renderMode: mode })
				.success,
		).toBe(false);
	});
	it("never accepts preconfirmed framing or unknown fields in a create intent", () => {
		for (const setting of [
			{ ...presentation, centerCropConfirmed: true },
			{ ...presentation, unexpected: true },
			{ ...presentation, version: "unknown" },
		])
			expect(
				mediaTaskCreateSchema.safeParse(request("DRAFT", setting)).success,
			).toBe(false);
	});
	it("retains presentation result provenance while legacy missing settings stay missing", () => {
		expect(generationTaskResultSchema.parse(result())).toHaveProperty(
			"presentation",
			presentation,
		);
		for (const mode of ["DRAFT", "EXPORT", undefined] as const) {
			const r = request();
			delete (r.parameters as Record<string, unknown>).presentation;
			if (mode === undefined)
				delete (r.parameters as Record<string, unknown>).renderMode;
			else r.parameters.renderMode = mode;
			const parsed = mediaTaskCreateSchema.parse(r);
			expect(Object.hasOwn(parsed.parameters, "presentation")).toBe(false);
			const old = result();
			delete (old as Record<string, unknown>).presentation;
			if (mode === undefined)
				delete (old as Record<string, unknown>).renderMode;
			else old.renderMode = mode;
			expect(
				Object.hasOwn(generationTaskResultSchema.parse(old), "presentation"),
			).toBe(false);
		}
	});
});
