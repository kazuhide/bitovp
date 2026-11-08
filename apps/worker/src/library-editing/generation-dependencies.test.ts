import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { generationDependencyFixture } from "./generation-dependency-fixture";

describe("generation revalidates explicit immutable dependencies", () => {
	it("refuses an old tracker result even when its media and analysis IDs match", async () => {
		const f = generationDependencyFixture("TRACK");
		f.dependency.parameters.identity.trackingAlgorithmVersion =
			"template-ncc-v1";
		f.dependency.result.algorithm = "template-ncc-v1";
		f.refresh();
		await expect(f.run()).rejects.toMatchObject({
			code: "TASK_DEPENDENCY_INVALID",
		});
		expect(f.projects).toHaveLength(0);
	});
	it("refuses a tracker dependency that lacks the current frame clock", async () => {
		const f = generationDependencyFixture("TRACK");
		delete f.dependency.parameters.identity.trackingFrameClockVersion;
		delete f.dependency.result.frameClockVersion;
		f.refresh();
		await expect(f.run()).rejects.toMatchObject({
			code: "TASK_DEPENDENCY_INVALID",
		});
		expect(f.runs).toHaveLength(0);
	});
	it("refuses a different ASR model without publishing a project", async () => {
		const f = generationDependencyFixture();
		f.dependency.parameters.identity.modelSha256 = "e".repeat(64);
		f.dependency.result.modelSha256 = "e".repeat(64);
		f.refresh();
		await expect(f.run()).rejects.toMatchObject({
			code: "TASK_DEPENDENCY_INVALID",
		});
		expect(f.projects).toHaveLength(0);
	});
	it("refuses a different requested speech language", async () => {
		const f = generationDependencyFixture();
		if (f.dependency.parameters.input.kind !== "TRANSCRIBE")
			throw new Error("Expected ASR");
		f.dependency.parameters.input.parameters.language = "en";
		f.dependency.result.language = "en";
		f.refresh();
		await expect(f.run()).rejects.toMatchObject({
			code: "TASK_DEPENDENCY_INVALID",
		});
	});
	it("refuses a partial inference window instead of claiming full caption coverage", async () => {
		const f = generationDependencyFixture();
		if (f.dependency.parameters.input.kind !== "TRANSCRIBE")
			throw new Error("Expected ASR");
		f.dependency.parameters.input.parameters.durationUs = 1_000_000;
		f.refresh();
		await expect(f.run()).rejects.toMatchObject({
			code: "TASK_DEPENDENCY_WINDOW_INCOMPLETE",
		});
		expect(f.revisions).toHaveLength(0);
	});
	it("refuses a typed-result model that contradicts its immutable task", async () => {
		const f = generationDependencyFixture();
		f.dependency.result.modelSha256 = "e".repeat(64);
		await expect(f.run()).rejects.toMatchObject({
			code: "TASK_RESULT_UNVERIFIED",
		});
	});
	it("refuses a result missing its measured-engine identity", async () => {
		const f = generationDependencyFixture();
		delete f.dependency.result.engine;
		await expect(f.run()).rejects.toMatchObject({
			code: "TASK_RESULT_UNVERIFIED",
		});
	});
	it("keeps the existing foreign-tenant rejection", async () => {
		const f = generationDependencyFixture();
		f.dependency.organizationId = randomUUID();
		await expect(f.run()).rejects.toMatchObject({
			code: "TASK_DEPENDENCY_INVALID",
		});
		expect(f.projects).toHaveLength(0);
	});
	it("uses a compatible full-window measured transcript without inventing missing speech", async () => {
		const f = generationDependencyFixture("TRANSCRIBE", 4);
		// Explicit authored word evidence is required by automatic caption selection.
		f.dependency.result.segments = [
			{
				startUs: 0,
				endUs: 1_000_000,
				text: "こんにちは",
				words: [
					{
						text: "こんにちは",
						startUs: 0,
						endUs: 1_000_000,
						startChar: 0,
						endChar: 5,
						confidence: 0.9,
					},
				],
			},
		];
		const result = await f.run();
		expect(result.actualFrames).toBe(120);
		expect(f.projects).toHaveLength(1);
		const document = f.projects[0]?.draft as { captions: { text: string }[] };
		expect(document.captions.map((item) => item.text)).toContain("こんにちは");
	});
	it("uses a compatible current tracker dependency", async () => {
		const f = generationDependencyFixture("TRACK");
		await f.run();
		expect(f.projects).toHaveLength(1);
		const document = f.projects[0]?.draft as {
			clips: { cropKeyframes?: unknown[] }[];
		};
		expect(
			document.clips.some((clip) => (clip.cropKeyframes?.length ?? 0) >= 2),
		).toBe(true);
	});
});
