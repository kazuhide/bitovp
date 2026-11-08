import { describe, expect, it } from "vitest";
import {
	generationTaskResultSchema,
	mediaTaskCacheKey,
	mediaTaskCreateSchema,
	mediaTaskIntentHash,
	mediaTaskViewSchema,
	speechSelectionEvidenceSchema,
} from "./index";

const id = "00000000-0000-4000-8000-000000000001";
function request(renderMode?: unknown) {
	return {
		kind: "GENERATE",
		mediaVersionId: id,
		analysisRevisionId: id,
		requestKey: id,
		parameters: {
			contentId: id,
			targetDurationFrames: 900,
			...(renderMode === undefined ? {} : { renderMode }),
		},
	};
}
const identity = {
	organizationId: id,
	mediaSha256: "a".repeat(64),
	modelSha256: null,
	analysisDocumentHash: "b".repeat(64),
	analysisRawHash: "c".repeat(64),
	timeMapHash: "d".repeat(64),
};
function result() {
	return {
		projectId: id,
		projectIds: [id],
		requestedFrames: 900,
		actualFrames: 870,
		warnings: [],
		policyVersion: "aisa-scene-cohesion-v2",
		presetIds: ["portrait-clean"],
		metrics: {},
		cacheable: true,
	};
}
function review() {
	return {
		schemaVersion: 1,
		policyVersion: "asr-boundary-v1",
		status: "FALLBACK",
		reason: "SPEECH_REVIEW_REQUIRED",
		sourceTimeDomain: "ORIGINAL_PRESENTATION_US",
		mediaSha256: "a".repeat(64),
		timeMapHash: "d".repeat(64),
		modelSha256: "b".repeat(64),
		observedWindow: { fromFrame: 0, toFrame: 900 },
		transcriptFingerprint: "e".repeat(64),
		intervals: [{ startUs: 500000, endUs: 29500000 }],
		rejectedBoundaryCount: 2,
	};
}
describe("draft-first generation contracts without legacy defaults", () => {
	it("preserves exact legacy intent/cache bytes and does not insert a render mode", () => {
		const parsed = mediaTaskCreateSchema.parse(request());
		expect(Object.hasOwn(parsed.parameters, "renderMode")).toBe(false);
		expect(mediaTaskIntentHash(parsed)).toBe(
			"7ddd9fdad5d945682181117edaab0b73a0042105e3fb3a6662d7bae9ea627d13",
		);
		expect(mediaTaskCacheKey(parsed, identity)).toBe(
			"82a4b4b9852498742c4650605063a077d2e1f9fbfc4a47bd11d500d150e704fa",
		);
		expect(generationTaskResultSchema.parse(result())).toEqual(result());
		expect(
			Object.hasOwn(generationTaskResultSchema.parse(result()), "renderMode"),
		).toBe(false);
	});
	it("binds explicit DRAFT and EXPORT to different immutable intents and cache keys", () => {
		const legacy = mediaTaskCreateSchema.parse(request()),
			draft = mediaTaskCreateSchema.parse(request("DRAFT")),
			exported = mediaTaskCreateSchema.parse(request("EXPORT"));
		expect(draft.parameters).toHaveProperty("renderMode", "DRAFT");
		expect(exported.parameters).toHaveProperty("renderMode", "EXPORT");
		expect(
			new Set([legacy, draft, exported].map((x) => mediaTaskIntentHash(x)))
				.size,
		).toBe(3);
		expect(
			new Set(
				[legacy, draft, exported].map((x) => mediaTaskCacheKey(x, identity)),
			).size,
		).toBe(3);
	});
	it.each([
		null,
		"",
		"PREVIEW",
		false,
		{},
		[],
	])("rejects invalid renderMode %j", (mode) => {
		expect(mediaTaskCreateSchema.safeParse(request(mode)).success).toBe(false);
	});
	it.each([
		"DRAFT",
		"EXPORT",
	])("preserves explicit %s in typed results", (renderMode) => {
		expect(
			generationTaskResultSchema.parse({ ...result(), renderMode }),
		).toHaveProperty("renderMode", renderMode);
	});
	it("accepts observed unsafe-cut evidence only as a DRAFT review-needed fallback", () => {
		expect(speechSelectionEvidenceSchema.parse(review())).toEqual(review());
		expect(
			generationTaskResultSchema.parse({
				...result(),
				renderMode: "DRAFT",
				selectionEvidence: review(),
			}),
		).toHaveProperty("selectionEvidence.reason", "SPEECH_REVIEW_REQUIRED");
		for (const renderMode of [undefined, "EXPORT"]) {
			expect(
				generationTaskResultSchema.safeParse({
					...result(),
					...(renderMode ? { renderMode } : {}),
					selectionEvidence: review(),
				}).success,
			).toBe(false);
		}
	});
	it("does not call review-needed speech safe or invent missing observation provenance", () => {
		for (const delta of [
			{ status: "APPLIED" },
			{ modelSha256: null },
			{ transcriptFingerprint: undefined },
			{ intervals: [] },
			{ rejectedBoundaryCount: 0 },
			{ observedWindow: undefined },
		])
			expect(
				speechSelectionEvidenceSchema.safeParse({ ...review(), ...delta })
					.success,
			).toBe(false);
	});
});

describe("optional execution mode on public progress views", () => {
	it("retains an explicit mode without adding one to historical rows", () => {
		const old = {
			taskId: id,
			kind: "GENERATE",
			state: "PENDING",
			mediaVersionId: id,
			analysisRevisionId: id,
			parentTaskId: null,
			phase: "QUEUED",
			progress: null,
			result: null,
			error: null,
			attempts: 0,
			cached: false,
			createdAt: "2026-11-02T00:00:00.000Z",
			finishedAt: null,
		};
		expect(mediaTaskViewSchema.parse(old)).toEqual(old);
		expect(Object.hasOwn(mediaTaskViewSchema.parse(old), "renderMode")).toBe(
			false,
		);
		for (const renderMode of ["DRAFT", "EXPORT"]) {
			expect(mediaTaskViewSchema.parse({ ...old, renderMode })).toHaveProperty(
				"renderMode",
				renderMode,
			);
		}
		expect(
			mediaTaskViewSchema.safeParse({ ...old, renderMode: "PREVIEW" }).success,
		).toBe(false);
	});
});
