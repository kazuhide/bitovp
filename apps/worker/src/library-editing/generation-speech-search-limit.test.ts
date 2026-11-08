import {
	compositionDocumentSchema,
	mediaTaskCacheKey,
	mediaTaskIntentHash,
	SpeechBoundarySelectionError,
	selectContentHighlightClips,
} from "@bitovp/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { generationDependencyFixture } from "./generation-dependency-fixture";

const boundary = vi.hoisted(() => ({ refine: vi.fn() }));
vi.mock("@bitovp/core", async (original) => ({
	...(await original<object>()),
	refinePortraitSelectionBySpeech: boundary.refine,
}));
afterEach(() => boundary.refine.mockReset());

function fixture(policy: "AUTO" | "DURATION" = "AUTO") {
	const f = generationDependencyFixture("TRANSCRIBE");
	Object.assign(f.task.parameters.input.parameters, {
		policy,
		renderMode: "DRAFT",
	});
	f.task.requestHash = mediaTaskIntentHash(f.task.parameters.input);
	f.task.cacheKey = mediaTaskCacheKey(
		f.task.parameters.input,
		f.task.parameters.identity,
	);
	return {
		...f,
		renders: vi.spyOn(f.prisma.renderRun, "create"),
		derivations: vi.spyOn(f.prisma.contentDerivation, "create"),
	};
}

describe("AUTO speech refinement search exhaustion", () => {
	it.each([
		0, 1,
	])("retains its validated draft and observed proof without claiming safe cuts (%i classified rejections)", async (rejectedBoundaryCount) => {
		const f = fixture(),
			anchor = selectContentHighlightClips({
				analysis: f.analysis.document,
				timeMap: f.media.timeMap,
				targetDurationFrames: 120,
			});
		boundary.refine.mockImplementation(() => {
			throw new SpeechBoundarySelectionError("SPEECH_SELECTION_SEARCH_LIMIT", {
				intervals: [{ startUs: 0, endUs: 1_000_000 }],
				rejectedBoundaryCount,
			});
		});
		const result = await f.run(),
			document = compositionDocumentSchema.parse(f.projects[0]?.draft);
		expect(result).toMatchObject({
			renderMode: "DRAFT",
			policyVersion: "aisa-content-highlight-v1",
			selectionEvidence: {
				status: "FALLBACK",
				reason: "SPEECH_SEARCH_LIMIT_REVIEW_REQUIRED",
				modelSha256: "b".repeat(64),
				observedWindow: { fromFrame: 0, toFrame: 180 },
				intervals: [{ startUs: 0, endUs: 1_000_000 }],
				rejectedBoundaryCount,
			},
		});
		expect(result.selectionEvidence?.transcriptFingerprint).toMatch(
			/^[a-f0-9]{64}$/,
		);
		expect(result.warnings).toContain("SPEECH_SEARCH_LIMIT_REVIEW_REQUIRED");
		expect(result.warnings).toContain("SPEECH_SELECTION_FALLBACK");
		expect(result.warnings).not.toContain("SPEECH_REVIEW_REQUIRED");
		expect(document.autoGeneration?.reasonCodes).toContain(
			"SPEECH_SEARCH_LIMIT_REVIEW_REQUIRED",
		);
		expect(
			document.clips.map(({ sourceInUs, durationFrames }) => ({
				sourceInUs,
				durationFrames,
			})),
		).toEqual(
			anchor.clips.map(({ sourceInUs, durationFrames }) => ({
				sourceInUs,
				durationFrames,
			})),
		);
		expect(result.semanticEvidence).toEqual(anchor.semanticEvidence);
		expect(document.autoGeneration?.semanticEvidence).toEqual(
			result.semanticEvidence,
		);
		expect(result.metrics.speechSearchExpansions).toBeLessThanOrEqual(200_000);
		expect(boundary.refine).toHaveBeenCalledTimes(1);
		expect(f.projects).toHaveLength(1);
		expect(f.renders).not.toHaveBeenCalled();
		expect(f.derivations).not.toHaveBeenCalled();
	});
	it("keeps a legacy policy search failure closed without publishing a project", async () => {
		const f = fixture("DURATION");
		boundary.refine.mockImplementation(() => {
			throw new SpeechBoundarySelectionError("SPEECH_SELECTION_SEARCH_LIMIT", {
				intervals: [{ startUs: 0, endUs: 1_000_000 }],
				rejectedBoundaryCount: 0,
			});
		});
		await expect(f.run()).rejects.toMatchObject({
			code: "SPEECH_SELECTION_SEARCH_LIMIT",
		});
		expect(f.projects).toHaveLength(0);
		expect(f.revisions).toHaveLength(0);
		expect(f.renders).not.toHaveBeenCalled();
		expect(f.derivations).not.toHaveBeenCalled();
	});
});
