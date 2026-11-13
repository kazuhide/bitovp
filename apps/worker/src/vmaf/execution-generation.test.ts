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
	it.each([
		["cuda", 9],
		["vulkan", 10],
	] as const)("never continues a %s row of retired generation %i, whose numbers were not those of libvmaf through FFmpeg", (scoringBackend, scoringVersion) => {
		// What such a row holds: the snapshot of the worker that started it.
		const storedScoring = {
			backend: scoringBackend,
			implementation: "bitovp-owned",
			bitDepth: 10,
			officialRevision: ownedScoringSnapshot(scoringBackend).officialRevision,
		};
		for (const backend of [scoringBackend, "cpu"])
			expect(() =>
				localScoringGeneration({
					scoringVersion,
					scoringBackend: backend,
					isCloud: false,
					storedScoring,
				}),
			).toThrow(/configuration changed; create a new measurement/i);
		expect(() =>
			localScoringGeneration({ scoringVersion, isCloud: true }),
		).toThrow(/configuration changed/i);
		// Nor is its snapshot taken for that of a current row.
		expect(() =>
			localScoringGeneration({
				scoringVersion: scoringBackend === "cuda" ? 12 : 13,
				scoringBackend,
				isCloud: false,
				storedScoring,
			}),
		).toThrow(/saved scoring method/i);
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
		const scoringVersion = scoringBackend === "cuda" ? 12 : 13;
		expect(ownedScoringSnapshot(scoringBackend)).toMatchObject({
			backend: scoringBackend,
			implementation: "bitovp-owned",
			comparison: "ffmpeg-libvmaf",
		});
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
				scoringVersion: 12,
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
