import { randomUUID } from "node:crypto";
import { compositionDocumentSchema } from "@bitovp/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { durationReviewFixture as fixture } from "./generation-duration-review-fixture";

const tracking = vi.hoisted(() => ({
	run: vi.fn(
		async (
			_input: Parameters<typeof import("./tracking").trackShotSubjects>[0],
		) => ({ observations: [], fallbacks: [] }),
	),
}));
vi.mock("./tracking", async (original) => ({
	...(await original<object>()),
	trackShotSubjects: tracking.run,
}));
afterEach(() => tracking.run.mockClear());
describe("explicit duration-review-v2 DRAFT speech priority", () => {
	it("retains the observed safe 90f candidate at exactly 90 percent of the 100f anchor", async () => {
		const f = fixture(90),
			result = await f.run();
		expect(result).toMatchObject({
			renderMode: "DRAFT",
			draftPolicyVersion: "duration-review-v2",
			actualFrames: 90,
			requestedFrames: 100,
			selectionEvidence: { status: "APPLIED" },
		});
		expect(result.warnings).not.toContain("SPEECH_DURATION_REVIEW_REQUIRED");
		expect(
			compositionDocumentSchema
				.parse(f.projects[0]?.draft)
				.clips.map((c) => c.durationFrames),
		).toEqual([90]);
		expect(f.runs).toEqual([]);
	});
	it("retains the whole-shot 100f anchor when the safe candidate is 89f and keeps all measured evidence, final captions and tracking", async () => {
		const f = fixture(89, true, "DRAFT", true),
			before = JSON.stringify(f.dependency.result),
			result = await f.run();
		expect(result).toMatchObject({
			renderMode: "DRAFT",
			draftPolicyVersion: "duration-review-v2",
			actualFrames: 100,
			selectionEvidence: {
				status: "FALLBACK",
				reason: "SPEECH_DURATION_REVIEW_REQUIRED",
				draftPolicyVersion: "duration-review-v2",
				modelSha256: "b".repeat(64),
				observedWindow: { fromFrame: 0, toFrame: 170 },
				intervals: [
					{ startUs: 400000, endUs: 600000 },
					{ startUs: 3500000, endUs: 4500000 },
				],
			},
		});
		expect(result.selectionEvidence?.rejectedBoundaryCount).toBeGreaterThan(0);
		expect(result.selectionEvidence?.transcriptFingerprint).toMatch(
			/^[a-f0-9]{64}$/,
		);
		expect(result.warnings).toContain("SPEECH_DURATION_REVIEW_REQUIRED");
		expect(result.warnings).toContain("SPEECH_SELECTION_FALLBACK");
		const document = compositionDocumentSchema.parse(f.projects[0]?.draft);
		expect(document.autoGeneration).toMatchObject({
			renderMode: "DRAFT",
			draftPolicyVersion: "duration-review-v2",
			generatedDurationFrames: 100,
		});
		expect(document.autoGeneration?.reasonCodes).toContain(
			"SPEECH_DURATION_REVIEW_REQUIRED",
		);
		expect(document.clips.map((c) => c.durationFrames)).toEqual([89, 11]);
		expect(document.captions?.map((c) => c.text)).toContain(
			"measured speech across anchor end",
		);
		expect(document.captions?.flatMap((c) => c.words ?? [])).toEqual([]);
		expect(tracking.run).toHaveBeenCalledOnce();
		expect(tracking.run.mock.calls[0]?.[0]).toHaveProperty(
			"shots.1.endFrame",
			110,
		);
		expect(JSON.stringify(f.dependency.result)).toBe(before);
		expect(f.runs).toEqual([]);
		expect(await f.run()).toEqual(result);
		expect(f.projects).toHaveLength(1);
		expect(f.revisions).toHaveLength(1);
	});
	it.each([
		"DRAFT",
		"EXPORT",
	] as const)("keeps missing-version %s speech selection at 89f", async (mode) => {
		const f = fixture(89, false, mode),
			result = await f.run();
		expect(result.actualFrames).toBe(89);
		expect(result.selectionEvidence?.status).toBe("APPLIED");
		expect(result.warnings).not.toContain("SPEECH_DURATION_REVIEW_REQUIRED");
		expect(Object.hasOwn(result, "draftPolicyVersion")).toBe(false);
		expect(
			Object.hasOwn(
				compositionDocumentSchema.parse(f.projects[0]?.draft).autoGeneration ??
					{},
				"draftPolicyVersion",
			),
		).toBe(false);
		expect(f.runs).toHaveLength(mode === "EXPORT" ? 1 : 0);
	});
	it("keeps existing NO_SAFE DRAFT semantics and exact rejection evidence under the new intent", async () => {
		const f = fixture();
		f.dependency.result.segments = [
			{ startUs: 1, endUs: 5900000, text: "measured unsafe all windows" },
		];
		f.refresh();
		const result = await f.run();
		expect(result.actualFrames).toBe(100);
		expect(result.selectionEvidence).toMatchObject({
			status: "FALLBACK",
			reason: "SPEECH_REVIEW_REQUIRED",
		});
		expect(result.selectionEvidence?.rejectedBoundaryCount).toBeGreaterThan(0);
		expect(result.warnings).not.toContain("SPEECH_DURATION_REVIEW_REQUIRED");
		expect(f.runs).toEqual([]);
	});
	it("does not fill a short source when captions are OFF", async () => {
		const f = fixture();
		Object.assign(f.task.parameters.input.parameters, {
			targetDurationFrames: 300,
			captions: "OFF",
		});
		delete f.task.parameters.input.parameters.transcriptionTaskId;
		f.refreshCurrent();
		const result = await f.run();
		expect(result.actualFrames).toBe(170);
		expect(result.selectionEvidence).toBeUndefined();
		expect(result.warnings).not.toContain("SPEECH_DURATION_REVIEW_REQUIRED");
		expect(f.runs).toEqual([]);
	});
	it("rejects a completed result whose version differs from its fixed v2 intent", async () => {
		const f = fixture(),
			result = await f.run();
		const { draftPolicyVersion: _version, ...withoutVersion } = result;
		f.task.result = withoutVersion;
		await expect(f.run()).rejects.toMatchObject({
			code: "TASK_RESULT_UNVERIFIED",
		});
	});
	it("never publishes a versioned draft after cancel or lease loss", async () => {
		for (const code of ["CANCELED", "LEASE_LOST"]) {
			const f = fixture();
			if (code === "CANCELED")
				Object.assign(f.task, { cancelRequestedAt: new Date() });
			else f.task.leaseToken = randomUUID();
			await expect(f.run()).rejects.toMatchObject({ code });
			expect(f.projects).toHaveLength(0);
			expect(f.runs).toEqual([]);
		}
	});
});
