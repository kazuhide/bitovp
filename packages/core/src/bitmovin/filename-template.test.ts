import { describe, expect, it } from "vitest";
import {
	expandRandomFilenameTokens,
	initSegmentCandidates,
	segmentNamePattern,
} from "./filename-template";

describe("provider filename templates", () => {
	it("leaves bare random tokens literal by default for generic filenames and paths", () => {
		expect(
			expandRandomFilenameTokens(
				"out/\\{rand_chars\\}/thumb-\\{segment_rand_chars\\}-%number%.jpg",
			),
		).toBe("out/\\{rand_chars\\}/thumb-\\{segment_rand_chars\\}-%number%.jpg");
		expect(expandRandomFilenameTokens("out/\\{rand_chars:8\\}/")).toBe(
			"out/[A-Za-z0-9]{8}/",
		);
	});
	it.each([
		"rand_chars",
		"segment_rand_chars",
	])("matches %s with the SDK's default 32 alphanumeric characters", (token) => {
		const pattern = segmentNamePattern(`v.part+{${token}}_%number%.mp4`);
		expect(pattern.exec(`v.part+${"9".repeat(32)}_17.mp4`)?.[1]).toBe("17");
		for (const random of ["A".repeat(31), "A".repeat(33), "-".repeat(32)])
			expect(pattern.test(`v.part+${random}_17.mp4`)).toBe(false);
		expect(pattern.test(`vXpart+${"A".repeat(32)}_17Xmp4`)).toBe(false);
		expect(pattern.test(`v.part+${"A".repeat(32)}_latest.mp4`)).toBe(false);
		expect(pattern.test(`v.part+${"A".repeat(32)}_17.mp4\n`)).toBe(false);
	});
	it("does not expand random-looking literal names", () => {
		const pattern = segmentNamePattern("seg-{rand_chars:8}-%number%.ts", false);
		expect(pattern.exec("seg-{rand_chars:8}-17.ts")?.[1]).toBe("17");
		expect(pattern.test("seg-Ab12Cd34-17.ts")).toBe(false);
	});
	it.each([
		"0",
		"-1",
		"NaN",
		"8.5",
		"9007199254740992",
		"9".repeat(400),
	])("does not build an unsafe random quantifier from %s", (length) => {
		const pattern = segmentNamePattern(
			`part_{rand_chars:${length}}_%number%.mp4`,
		);
		expect(pattern.test("part_Ab12Cd34_17.mp4")).toBe(false);
	});
	it("bounds random matches by known candidate lengths without changing the template", () => {
		expect(
			expandRandomFilenameTokens("init-\\{rand_chars:1000000\\}.mp4", 100),
		).toBe("init-(?!).mp4");
	});
	it("prefers a CMAF init template to a schema-derived literal default", () => {
		const keys = [
			"run/init.mp4",
			`run/init-${"A".repeat(32)}.mp4`,
			"run/init-short.mp4",
		];
		expect(
			initSegmentCandidates(keys, "init.mp4", "init-{rand_chars}.mp4"),
		).toEqual([keys[1]]);
		expect(initSegmentCandidates(keys, "init.mp4", undefined)).toEqual([
			keys[0],
		]);
	});
});
