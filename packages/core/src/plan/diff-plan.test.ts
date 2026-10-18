import { describe, expect, it } from "vitest";
import { diffPlans } from "./diff-plan";

describe("diffPlans", () => {
	it("returns [] for identical primitives, objects, and arrays", () => {
		expect(diffPlans(1, 1)).toEqual([]);
		expect(diffPlans("a", "a")).toEqual([]);
		expect(diffPlans(null, null)).toEqual([]);
		expect(diffPlans({ a: 1, b: { c: 2 } }, { a: 1, b: { c: 2 } })).toEqual([]);
		// Key order must not matter (stable compare).
		expect(diffPlans({ a: 1, b: 2 }, { b: 2, a: 1 })).toEqual([]);
		expect(diffPlans([1, 2, 3], [1, 2, 3])).toEqual([]);
	});

	it("reports a changed scalar leaf", () => {
		expect(diffPlans({ a: 1 }, { a: 2 })).toEqual([
			{ path: "a", change: "changed", before: 1, after: 2 },
		]);
	});

	it("reports an added key", () => {
		expect(diffPlans({ a: 1 }, { a: 1, b: 2 })).toEqual([
			{ path: "b", change: "added", after: 2 },
		]);
	});

	it("reports a removed key", () => {
		expect(diffPlans({ a: 1, b: 2 }, { a: 1 })).toEqual([
			{ path: "b", change: "removed", before: 2 },
		]);
	});

	it("descends into nested objects with dotted paths", () => {
		expect(
			diffPlans(
				{ outer: { inner: { keep: 1, bump: "old" } } },
				{ outer: { inner: { keep: 1, bump: "new" } } },
			),
		).toEqual([
			{
				path: "outer.inner.bump",
				change: "changed",
				before: "old",
				after: "new",
			},
		]);
	});

	it("compares arrays by index with bracket paths (changed/added/removed)", () => {
		// changed element
		expect(diffPlans({ xs: [1, 2, 3] }, { xs: [1, 9, 3] })).toEqual([
			{ path: "xs[1]", change: "changed", before: 2, after: 9 },
		]);
		// added tail element
		expect(diffPlans([1, 2], [1, 2, 3])).toEqual([
			{ path: "[2]", change: "added", after: 3 },
		]);
		// removed tail element
		expect(diffPlans([1, 2, 3], [1, 2])).toEqual([
			{ path: "[2]", change: "removed", before: 3 },
		]);
	});

	it("descends into objects inside arrays", () => {
		expect(
			diffPlans(
				{ renditions: [{ height: 360, bitrate: 300 }] },
				{ renditions: [{ height: 360, bitrate: 600 }] },
			),
		).toEqual([
			{
				path: "renditions[0].bitrate",
				change: "changed",
				before: 300,
				after: 600,
			},
		]);
	});

	it("treats a shape change (object vs scalar) as one changed leaf", () => {
		expect(diffPlans({ a: { nested: 1 } }, { a: 5 })).toEqual([
			{ path: "a", change: "changed", before: { nested: 1 }, after: 5 },
		]);
		// array vs object at the same node
		expect(diffPlans({ a: [1] }, { a: { 0: 1 } })).toEqual([
			{ path: "a", change: "changed", before: [1], after: { 0: 1 } },
		]);
	});

	it("emits multiple ordered entries for several differences", () => {
		const diff = diffPlans(
			{ a: 1, b: 2, c: { d: 3 } },
			{ a: 1, b: 20, c: { d: 3, e: 4 }, f: 5 },
		);
		// Object keys are walked in sorted order: b, then c.e, then f.
		expect(diff).toEqual([
			{ path: "b", change: "changed", before: 2, after: 20 },
			{ path: "c.e", change: "added", after: 4 },
			{ path: "f", change: "added", after: 5 },
		]);
	});

	it("diffs two realistic plan-shaped objects end to end", () => {
		const before = {
			planVersion: 1,
			name: "sample",
			bitmovin: { cloudRegion: "AWS_EU_WEST_1" },
			renditions: [
				{ key: "v360", height: 360, bitrate: 300_000 },
				{ key: "v720", height: 720, bitrate: 1_500_000 },
			],
		};
		const after = {
			planVersion: 1,
			name: "my-edited",
			bitmovin: { cloudRegion: "AWS_AP_NORTHEAST_1" },
			renditions: [
				{ key: "v360", height: 360, bitrate: 400_000 },
				{ key: "v720", height: 720, bitrate: 1_500_000 },
			],
		};
		expect(diffPlans(before, after)).toEqual([
			{
				path: "bitmovin.cloudRegion",
				change: "changed",
				before: "AWS_EU_WEST_1",
				after: "AWS_AP_NORTHEAST_1",
			},
			{ path: "name", change: "changed", before: "sample", after: "my-edited" },
			{
				path: "renditions[0].bitrate",
				change: "changed",
				before: 300_000,
				after: 400_000,
			},
		]);
	});
});
