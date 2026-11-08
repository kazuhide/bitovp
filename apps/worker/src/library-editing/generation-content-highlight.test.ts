import {
	compositionDocumentSchema,
	GENERATION_POLICY_FINGERPRINT,
	hashEditingEvidence,
	mediaTaskCacheKey,
	mediaTaskIntentHash,
} from "@bitovp/core";
import { describe, expect, it, vi } from "vitest";
import { generationDependencyFixture } from "./generation-dependency-fixture";

function required<T>(value: T | undefined): T {
	if (value === undefined) throw new Error("Missing authored fixture value");
	return value;
}
function fixture(captions: "OFF" | "AUTO" = "OFF") {
	const f = generationDependencyFixture("TRANSCRIBE");
	Object.assign(f.task.parameters.input.parameters, {
		policy: "AUTO",
		renderMode: "DRAFT",
		captions,
		tracking: false,
	});
	if (captions === "OFF")
		delete f.task.parameters.input.parameters.transcriptionTaskId;
	for (const scene of f.analysis.document.scenes) {
		scene.title = "Landscape";
		scene.summary = "A quiet landscape.";
		for (const shot of scene.shots) {
			shot.detailedDescription = "A landscape remains still.";
			shot.mainSubjects = [];
		}
	}
	const keyScene = required(f.analysis.document.scenes[1]);
	keyScene.title = "Robot discovers the missing key";
	keyScene.summary = "The robot discovers the missing key and opens the door.";
	required(keyScene.shots[0]).detailedDescription =
		"The robot discovers the key and opens the locked door, revealing the hidden room.";
	const refresh = () => {
		f.analysis.rawHash = hashEditingEvidence(f.analysis.document);
		Object.assign(f.binding, {
			analysisRawHash: f.analysis.rawHash,
			analysisDocumentHash: hashEditingEvidence(f.analysis.document),
		});
		Object.assign(f.task.parameters.identity, {
			analysisRawHash: f.analysis.rawHash,
			analysisDocumentHash: f.binding.analysisDocumentHash,
			bindingSnapshot: f.binding,
			bindingHash: hashEditingEvidence(f.binding),
		});
		f.task.requestHash = mediaTaskIntentHash(f.task.parameters.input);
		f.task.cacheKey = mediaTaskCacheKey(
			f.task.parameters.input,
			f.task.parameters.identity,
		);
		f.refresh();
	};
	refresh();
	return {
		...f,
		refresh,
		renders: vi.spyOn(f.prisma.renderRun, "create"),
		derivations: vi.spyOn(f.prisma.contentDerivation, "create"),
	};
}

describe("automatic AISA content highlights remain reviewable drafts", () => {
	it("chooses a late key moment without hints, records its source evidence, and never starts export", async () => {
		const f = fixture(),
			unchangedAnalysis = JSON.stringify(f.analysis.document),
			result = await f.run(),
			document = compositionDocumentSchema.parse(f.projects[0]?.draft);
		expect(result).toMatchObject({
			renderMode: "DRAFT",
			policyVersion: "aisa-content-highlight-v1",
			semanticEvidence: {
				version: "aisa-content-evidence-v1",
				method: "METADATA_HEURISTIC",
				selectionReason: "CONTENT_RANKED",
			},
		});
		expect(result.actualFrames).toBeLessThanOrEqual(result.requestedFrames);
		expect(document.clips.some((clip) => clip.sourceInUs === 4_000_000)).toBe(
			true,
		);
		expect(document.autoGeneration?.semanticEvidence).toEqual(
			result.semanticEvidence,
		);
		expect(document.autoGeneration?.semanticEvidence?.selectedMoments).toEqual(
			document.clips.map((clip) =>
				expect.objectContaining({
					sceneId: clip.evidence?.sceneId,
					shotIndex: clip.evidence?.shotIndex,
				}),
			),
		);
		expect(f.task.parameters.input.parameters.query).toBeUndefined();
		expect(f.renders).not.toHaveBeenCalled();
		expect(f.derivations).not.toHaveBeenCalled();
		expect(f.projects).toHaveLength(1);
		expect(f.revisions).toHaveLength(1);
		expect(JSON.stringify(f.analysis.document)).toBe(unchangedAnalysis);
		await expect(f.run()).resolves.toEqual(result);
		expect(f.projects).toHaveLength(1);
	});
	it("rebuilds the immutable rationale for the final speech-safe shots", async () => {
		const f = fixture("AUTO");
		f.task.parameters.input.parameters.targetDurationFrames = 60;
		const firstScene = required(f.analysis.document.scenes[0]),
			lastScene = required(f.analysis.document.scenes[1]);
		required(firstScene.shots[1]).detailedDescription =
			"The robot discovers the key and reveals the hidden room.";
		lastScene.title = "Landscape";
		lastScene.summary = "A quiet landscape.";
		required(lastScene.shots[0]).detailedDescription =
			"A landscape remains still.";
		// The key shot starts at two seconds inside measured speech. The safe
		// alternative retains a different whole shot and must replace its rationale.
		f.dependency.result.segments = [
			{ startUs: 500_000, endUs: 1_000_000, text: "before" },
			{ startUs: 1_500_000, endUs: 2_500_000, text: "continuous speech" },
		];
		f.refresh();
		const result = await f.run(),
			document = compositionDocumentSchema.parse(f.projects[0]?.draft);
		expect(document.clips.map((clip) => clip.sourceInUs)).toEqual([4_000_000]);
		expect(result.selectionEvidence).toMatchObject({
			status: "FALLBACK",
			reason: "BOUNDARY_COVERAGE_UNKNOWN",
		});
		expect(result.semanticEvidence?.selectedMoments).toEqual(
			document.clips.map((clip) =>
				expect.objectContaining({
					sceneId: clip.evidence?.sceneId,
					shotIndex: clip.evidence?.shotIndex,
				}),
			),
		);
		expect(document.autoGeneration?.semanticEvidence).toEqual(
			result.semanticEvidence,
		);
		expect(f.renders).not.toHaveBeenCalled();
	});
	it("includes the final semantic evidence in generated provenance hashes", async () => {
		const f = fixture(),
			result = await f.run(),
			document = compositionDocumentSchema.parse(f.projects[0]?.draft);
		expect(document.autoGeneration?.requestHash).toBe(
			hashEditingEvidence({
				taskRequestHash: f.task.requestHash,
				generationPolicyFingerprint: GENERATION_POLICY_FINGERPRINT,
				presetId: "portrait-clean",
				mediaSha256: f.media.sha256,
				analysisDocumentHash: f.task.parameters.identity.analysisDocumentHash,
				bindingHash: hashEditingEvidence(f.binding),
				modelSha256: f.task.parameters.identity.modelSha256,
				semanticEvidenceHash: hashEditingEvidence(result.semanticEvidence),
			}),
		);
	});
	it.each([
		"legacy-policy",
		"prepared-policy",
		"missing-evidence",
	] as const)("rejects an AUTO replay containing %s instead of its fixed policy evidence", async (mode) => {
		const f = fixture(),
			result = await f.run();
		const altered = { ...result };
		if (mode === "legacy-policy") {
			Object.assign(altered, { policyVersion: "aisa-scene-cohesion-v2" });
			delete altered.semanticEvidence;
		} else if (mode === "prepared-policy")
			Object.assign(altered, {
				policyVersion: "aisa-prepared-content-highlight-v4",
			});
		else delete altered.semanticEvidence;
		f.task.result = altered;
		await expect(f.run()).rejects.toMatchObject({
			code: "TASK_RESULT_UNVERIFIED",
		});
		expect(f.projects).toHaveLength(1);
		expect(f.renders).not.toHaveBeenCalled();
	});
});
