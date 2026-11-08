import { describe, expect, it } from "vitest";
import { compositionPixelRect } from "./composition-geometry";
import { shotCropCandidates } from "./shot-crop-candidates";

const geometry = {
	sourceWidth: 1920,
	sourceHeight: 1080,
	targetWidth: 1080,
	targetHeight: 1920,
};
describe("bounded static shot crop candidates", () => {
	it("offers left/centre/right when no subject position is available", () => {
		const values = shotCropCandidates(geometry);
		expect(values.map((x) => x.id)).toEqual(["left", "center", "right"]);
		expect(
			values.every((x) => x.kind === "POSITION" && x.coverage === "UNKNOWN"),
		).toBe(true);
		expect(values[0]?.rect.x).toBe(0);
		expect(values[2]?.rect.x).toBeCloseTo(1 - 0.31640625);
	});
	it("ranks a recognizable person before a fitting object and explicitly marks a partial crop", () => {
		const input = {
				...geometry,
				mainSubjects: [
					{ classification: "Lamp", box2d: [200, 100, 400, 200] },
					{ classification: "Person", box2d: [0, 100, 1000, 900] },
				],
			},
			before = structuredClone(input),
			values = shotCropCandidates(input);
		expect(values.slice(0, 2).map((x) => [x.id, x.coverage])).toEqual([
			["aisa-1", "PARTIAL"],
			["aisa-0", "FULL"],
		]);
		expect(values.length).toBeLessThanOrEqual(5);
		expect(input).toEqual(before);
		expect(shotCropCandidates(input)).toEqual(values);
		expect(values[0]?.rect.w).toBeCloseTo(0.31640625);
		expect(values[0]?.rect.h).toBe(1);
		for (const x of values)
			expect(Object.keys(x).sort()).toEqual(
				(x.kind === "AISA"
					? ["id", "kind", "rect", "subjectIndex", "coverage"]
					: ["id", "kind", "rect", "coverage"]
				).sort(),
			);
	});
	it("prefers full box coverage before provider order for equally recognized people", () => {
		const values = shotCropCandidates({
			...geometry,
			mainSubjects: [
				{ classification: "Man", box2d: [0, 0, 1000, 900] },
				{ classification: "Woman", box2d: [100, 600, 700, 750] },
			],
		});
		expect(values.slice(0, 2).map((x) => x.subjectIndex)).toEqual([1, 0]);
		expect(values[0]?.coverage).toBe("FULL");
	});
	it("prefers a reasonably sized box over a tiny box before provider order", () => {
		const values = shotCropCandidates({
			...geometry,
			mainSubjects: [
				{ classification: "Person", box2d: [100, 100, 120, 120] },
				{ classification: "Person", box2d: [200, 400, 600, 550] },
			],
		});
		expect(values[0]?.subjectIndex).toBe(1);
	});
	it("deduplicates near-identical source views before limiting AISA proposals to two", () => {
		const values = shotCropCandidates({
			...geometry,
			mainSubjects: [
				{ centerX: 22, centerY: 50 },
				{ centerX: 22.01, centerY: 50 },
				{ centerX: 70, centerY: 50 },
				{ centerX: 90, centerY: 50 },
			],
		});
		expect(values.filter((x) => x.kind === "AISA").map((x) => x.id)).toEqual([
			"aisa-0",
			"aisa-2",
		]);
	});
	it("retains AISA provenance when it duplicates the central position choice", () => {
		const values = shotCropCandidates({
			...geometry,
			mainSubjects: [{ classification: "Person", centerX: 50, centerY: 50 }],
		});
		expect(values[0]).toMatchObject({
			id: "aisa-0",
			kind: "AISA",
			coverage: "UNKNOWN",
			subjectIndex: 0,
		});
		expect(values.some((x) => x.id === "center")).toBe(false);
	});
	it("skips invalid positions but can use a valid centre when its box is unavailable", () => {
		const values = shotCropCandidates({
			...geometry,
			mainSubjects: [
				{ centerX: -1, centerY: 50 },
				{ centerX: 25, centerY: 50, box2d: [] },
				{ box2d: [0, 0, 1200, 1000] },
			],
		});
		expect(
			values
				.filter((x) => x.kind === "AISA")
				.map((x) => [x.subjectIndex, x.coverage]),
		).toEqual([[1, "UNKNOWN"]]);
	});
	it.each([
		[1600, 714],
		[1600, 900],
		[1080, 1920],
		[640, 360],
	])("keeps every candidate inside %ix%i source pixels", (sourceWidth, sourceHeight) => {
		for (const target of [
			{ targetWidth: 1080, targetHeight: 1920 },
			{ targetWidth: 1920, targetHeight: 1080 },
			{ targetWidth: 1080, targetHeight: 1080 },
		]) {
			const values = shotCropCandidates({
				sourceWidth,
				sourceHeight,
				...target,
				mainSubjects: [
					{ classification: "Person", centerX: 0, centerY: 0 },
					{ classification: "Animal", box2d: [100, 750, 800, 990] },
				],
			});
			expect(values.length).toBeGreaterThan(0);
			expect(values.length).toBeLessThanOrEqual(5);
			for (const c of values) {
				expect(() =>
					compositionPixelRect(c.rect, sourceWidth, sourceHeight),
				).not.toThrow();
				expect(
					(c.rect.w * sourceWidth) / (c.rect.h * sourceHeight),
				).toBeCloseTo(target.targetWidth / target.targetHeight, 10);
			}
		}
	});
	it("retains one central position when all horizontal positions coincide", () => {
		expect(
			shotCropCandidates({
				...geometry,
				sourceWidth: 1080,
				sourceHeight: 1920,
			}).map((x) => x.id),
		).toEqual(["center"]);
	});
	it.each([
		0,
		-1,
		Number.NaN,
		Infinity,
	])("rejects invalid source geometry %s", (sourceWidth) => {
		expect(() => shotCropCandidates({ ...geometry, sourceWidth })).toThrow(
			RangeError,
		);
	});
});
