import { randomUUID } from "node:crypto";
import {
	compositionDocumentSchema,
	mediaTaskCacheKey,
	mediaTaskIntentHash,
} from "@bitovp/core";
import { describe, expect, it, vi } from "vitest";
import { generationDependencyFixture } from "./generation-dependency-fixture";

function fixture(
	mode?: "DRAFT" | "EXPORT",
	kind: "TRACK" | "TRANSCRIBE" = "TRACK",
) {
	const f = generationDependencyFixture(kind);
	if (mode)
		Object.assign(f.task.parameters.input.parameters, { renderMode: mode });
	const refreshCurrent = () => {
		f.task.requestHash = mediaTaskIntentHash(f.task.parameters.input);
		f.task.cacheKey = mediaTaskCacheKey(
			f.task.parameters.input,
			f.task.parameters.identity,
		);
	};
	refreshCurrent();
	const derivations = vi.spyOn(f.prisma.contentDerivation, "create"),
		renders = vi.spyOn(f.prisma.renderRun, "create");
	return { ...f, derivations, renders, refreshCurrent };
}
describe("draft-first project publication", () => {
	it("creates an editable current revision with no render or derived-output reservation and replays the same project", async () => {
		const f = fixture("DRAFT"),
			first = await f.run(),
			second = await f.run();
		expect(first).toMatchObject({
			renderMode: "DRAFT",
			actualFrames: 120,
			requestedFrames: 120,
		});
		expect(second).toEqual(first);
		expect(f.projects).toHaveLength(1);
		expect(f.revisions).toHaveLength(1);
		expect(f.projects[0]?.currentRevisionId).toBe(f.revisions[0]?.id);
		expect(f.projects[0]?.draft).toEqual(f.revisions[0]?.document);
		expect(
			compositionDocumentSchema.parse(f.projects[0]?.draft).clips.length,
		).toBeGreaterThan(0);
		expect(f.runs).toEqual([]);
		expect(f.renders).not.toHaveBeenCalled();
		expect(f.derivations).not.toHaveBeenCalled();
		expect(f.task).toMatchObject({ state: "SUCCEEDED", result: first });
	});
	it.each([
		undefined,
		"EXPORT",
	] as const)("retains legacy/export output publication (%s)", async (mode) => {
		const f = fixture(mode),
			result = await f.run();
		expect(f.runs).toHaveLength(1);
		expect(f.derivations).toHaveBeenCalledTimes(1);
		expect(f.runs[0]).toMatchObject({
			generation: 1,
			profile: { kind: "EXPORT" },
		});
		if (mode) expect(result).toHaveProperty("renderMode", "EXPORT");
		else expect(Object.hasOwn(result, "renderMode")).toBe(false);
	});
	it("publishes all requested draft variants without an export per variant", async () => {
		const f = fixture("DRAFT");
		f.task.parameters.input.parameters.variants = 3;
		f.refreshCurrent();
		const result = await f.run();
		expect(result.projectIds).toHaveLength(3);
		expect(f.projects).toHaveLength(3);
		expect(f.revisions).toHaveLength(3);
		expect(new Set(result.projectIds).size).toBe(3);
		expect(f.renders).not.toHaveBeenCalled();
		expect(f.derivations).not.toHaveBeenCalled();
	});
	it("rejects a completed result whose recorded mode differs from its fixed intent", async () => {
		const f = fixture("DRAFT");
		f.task.state = "SUCCEEDED";
		f.task.result = {
			projectId: f.context.mediaVersionId,
			projectIds: [f.context.mediaVersionId],
			requestedFrames: 120,
			actualFrames: 120,
			warnings: [],
			policyVersion: "aisa-scene-cohesion-v2",
			presetIds: ["portrait-clean"],
			metrics: {},
			cacheable: true,
		};
		await expect(f.run()).rejects.toMatchObject({
			code: "TASK_RESULT_UNVERIFIED",
		});
		expect(f.projects).toHaveLength(0);
	});
	it.each([
		"CANCELED",
		"LEASE_LOST",
	])("cannot publish a draft after %s", async (code) => {
		const f = fixture("DRAFT");
		if (code === "CANCELED")
			Object.assign(f.task, { cancelRequestedAt: new Date() });
		else f.task.leaseToken = randomUUID();
		await expect(f.run()).rejects.toMatchObject({ code });
		expect(f.projects).toHaveLength(0);
		expect(f.renders).not.toHaveBeenCalled();
		expect(f.derivations).not.toHaveBeenCalled();
	});
	it("retains the original whole-shot anchor as an explicitly unsafe draft with real merged speech evidence", async () => {
		const f = fixture("DRAFT", "TRANSCRIBE");
		f.dependency.result.segments = [
			{ startUs: 500000, endUs: 3500000, text: "measured first" },
			{ startUs: 3500000, endUs: 5500000, text: "measured touching" },
		];
		f.refresh();
		const originalSegments = JSON.stringify(f.dependency.result.segments);
		const result = await f.run();
		expect(result).toMatchObject({
			renderMode: "DRAFT",
			actualFrames: 120,
			selectionEvidence: {
				status: "FALLBACK",
				reason: "SPEECH_REVIEW_REQUIRED",
				modelSha256: "b".repeat(64),
				observedWindow: { fromFrame: 0, toFrame: 180 },
				intervals: [{ startUs: 500000, endUs: 5500000 }],
				rejectedBoundaryCount: expect.any(Number),
			},
		});
		expect(result.selectionEvidence?.rejectedBoundaryCount).toBeGreaterThan(0);
		expect(result.selectionEvidence?.transcriptFingerprint).toMatch(
			/^[a-f0-9]{64}$/,
		);
		expect(result.warnings).toContain("SPEECH_REVIEW_REQUIRED");
		expect(result.warnings).toContain("SPEECH_SELECTION_FALLBACK");
		const document = compositionDocumentSchema.parse(f.projects[0]?.draft);
		expect(document.autoGeneration?.reasonCodes).toContain(
			"SPEECH_REVIEW_REQUIRED",
		);
		expect(document.clips.map((c) => [c.sourceInUs, c.durationFrames])).toEqual(
			[
				[0, 60],
				[2000000, 60],
			],
		);
		expect(document.captions).toEqual([]);
		expect(result.warnings).toContain("CAPTION_ALIGNMENT_UNAVAILABLE");
		expect(result.cacheable).toBe(false);
		expect(document.captions?.flatMap((c) => c.words ?? [])).toEqual([]);
		expect(JSON.stringify(f.dependency.result.segments)).toBe(originalSegments);
		expect(f.renders).not.toHaveBeenCalled();
		expect(f.derivations).not.toHaveBeenCalled();
	});
	it("keeps measured unsafe EXPORT rejection and does not publish a project", async () => {
		const f = fixture("EXPORT", "TRANSCRIBE");
		f.dependency.result.segments = [
			{ startUs: 500000, endUs: 5500000, text: "continuous measured speech" },
		];
		f.refresh();
		await expect(f.run()).rejects.toMatchObject({
			code: "NO_SPEECH_SAFE_WINDOW",
		});
		expect(f.projects).toHaveLength(0);
		expect(f.runs).toEqual([]);
	});
	it("does not mislabel unavailable ASR as known unsafe speech", async () => {
		const f = fixture("DRAFT", "TRANSCRIBE");
		delete f.task.parameters.input.parameters.transcriptionTaskId;
		f.refreshCurrent();
		const result = await f.run();
		expect(result.selectionEvidence).toMatchObject({
			status: "FALLBACK",
			reason: "ASR_UNAVAILABLE",
			modelSha256: null,
			rejectedBoundaryCount: 0,
		});
		expect(result.selectionEvidence?.intervals).toBeUndefined();
		expect(result.warnings).not.toContain("SPEECH_REVIEW_REQUIRED");
	});
});
