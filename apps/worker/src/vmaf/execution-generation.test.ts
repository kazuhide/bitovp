import { describe, expect, it } from "vitest";
import {
	localScoringGeneration,
	ownedScoringSnapshot,
} from "./execution-generation";

describe("local scoring generation migration", () => {
	it.each([
		"cuda",
		"vulkan",
	] as const)("never relabels old VMAFx/NVDEC retries as %s", (scoringBackend) => {
		for (const scoringVersion of [7, 8])
			expect(() =>
				localScoringGeneration({
					scoringVersion,
					scoringBackend,
					isCloud: false,
				}),
			).toThrow(/create a new measurement/i);
	});
	it("retains an existing NVDEC plus CPU job only with the matching decoder policy", () => {
		expect(
			localScoringGeneration({
				scoringVersion: 8,
				scoringBackend: "cpu",
				decodeBackend: "auto",
				isCloud: false,
			}),
		).toBe(8);
		expect(() =>
			localScoringGeneration({
				scoringVersion: 8,
				scoringBackend: "cpu",
				isCloud: false,
			}),
		).toThrow(/configuration changed/i);
	});
	it.each([
		"cuda",
		"vulkan",
	] as const)("records the owned %s method only on a fresh ordinary measurement", (scoringBackend) => {
		const scoringVersion = scoringBackend === "cuda" ? 9 : 10;
		expect(
			localScoringGeneration({
				scoringVersion: 3,
				scoringBackend,
				isCloud: false,
			}),
		).toBe(scoringVersion);
		expect(
			localScoringGeneration({
				scoringVersion,
				scoringBackend,
				isCloud: false,
				storedScoring: ownedScoringSnapshot(scoringBackend),
			}),
		).toBe(scoringVersion);
		expect(() =>
			localScoringGeneration({
				scoringVersion,
				scoringBackend,
				isCloud: false,
			}),
		).toThrow(/saved scoring method/i);
		expect(() =>
			localScoringGeneration({
				scoringVersion,
				scoringBackend: "cpu",
				isCloud: false,
			}),
		).toThrow(/configuration changed/i);
	});
	it("rejects a saved implementation mismatch even when job params omit execution.backend", () => {
		expect(() =>
			localScoringGeneration({
				scoringVersion: 9,
				scoringBackend: "cuda",
				isCloud: false,
				storedScoring: { backend: "cuda", implementation: "vmafx" },
			}),
		).toThrow(/saved scoring method/i);
	});
	it("keeps default CPU and cloud independent of local opt-in settings", () => {
		expect(
			localScoringGeneration({ scoringVersion: 3, isCloud: false }),
		).toBeUndefined();
		expect(
			localScoringGeneration({
				scoringVersion: 6,
				scoringBackend: "vulkan",
				decodeBackend: "cuda",
				isCloud: true,
			}),
		).toBeUndefined();
	});
});
