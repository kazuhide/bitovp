import { describe, expect, it } from "vitest";
import {
	matchOneToOne,
	normalizedBitrateCost,
	UNKNOWN_BITRATE_COST,
} from "./one-to-one";

/**
 * The binding algorithm, isolated from the manifest shapes it serves (row 284
 * / audit 5c3d97ca HIGH-5). Every case below is one the non-consuming
 * `nearestByBandwidth` got wrong or could not express: it picked, per expected
 * node, the nearest observed row and never took that row out of the pool.
 */

type E = { key: string; height: number; bitrate: number };
type O = { id: string; height: number; bandwidth?: number };

const run = (expected: E[], observed: O[]) =>
	matchOneToOne<E, O>({
		expected,
		observed,
		expectedKey: (e) => e.key,
		observedKey: (o) => `${o.height}|${o.bandwidth ?? ""}|${o.id}`,
		compatible: (e, o) => e.height === o.height,
		cost: (e, o) => normalizedBitrateCost(e.bitrate, o.bandwidth),
	});

const bound = (r: ReturnType<typeof run>) =>
	r.pairs.map((p) => `${p.expected.key}->${p.observed.id}`).sort();

describe("matchOneToOne — the binding is one-to-one", () => {
	it("2 expected / 1 observed at one height: one binds, one is MISSING — never both green", () => {
		const r = run(
			[
				{ key: "v360-300", height: 360, bitrate: 300_000 },
				{ key: "v360-600", height: 360, bitrate: 600_000 },
			],
			[{ id: "x", height: 360, bandwidth: 600_000 }],
		);
		expect(bound(r)).toEqual(["v360-600->x"]);
		expect(r.unmatchedExpected.map((e) => e.key)).toEqual(["v360-300"]);
		expect(r.unmatchedObserved).toEqual([]);
	});

	it("2 / 2 in reverse input order binds both, each to its own row", () => {
		const expected: E[] = [
			{ key: "v360-300", height: 360, bitrate: 300_000 },
			{ key: "v360-600", height: 360, bitrate: 600_000 },
		];
		const forward = run(expected, [
			{ id: "lo", height: 360, bandwidth: 320_000 },
			{ id: "hi", height: 360, bandwidth: 640_000 },
		]);
		const reversed = run([...expected].reverse(), [
			{ id: "hi", height: 360, bandwidth: 640_000 },
			{ id: "lo", height: 360, bandwidth: 320_000 },
		]);
		expect(bound(forward)).toEqual(["v360-300->lo", "v360-600->hi"]);
		expect(bound(reversed)).toEqual(bound(forward));
		expect(forward.unmatchedExpected).toEqual([]);
		expect(forward.unmatchedObserved).toEqual([]);
	});

	it("an equidistant tie resolves the same way regardless of input order", () => {
		// Both rows sit exactly between the two targets: every assignment has the
		// same total cost, so only the canonical tie-break decides — and it must
		// decide identically for every permutation of the inputs.
		const expected: E[] = [
			{ key: "a", height: 720, bitrate: 1_000_000 },
			{ key: "b", height: 720, bitrate: 3_000_000 },
		];
		const rows: O[] = [
			{ id: "r1", height: 720, bandwidth: 2_000_000 },
			{ id: "r2", height: 720, bandwidth: 2_000_000 },
		];
		const results = [
			run(expected, rows),
			run([...expected].reverse(), rows),
			run(expected, [...rows].reverse()),
			run([...expected].reverse(), [...rows].reverse()),
		].map((r) => r.pairs.map((p) => `${p.expected.key}->${p.observed.id}`));
		// Ordered by expected key (the result's canonical order), not by input.
		expect(results[0]?.map((s) => s.split("->")[0])).toEqual(["a", "b"]);
		for (const other of results.slice(1)) {
			expect(other).toEqual(results[0]);
		}
		expect(results[0]).toHaveLength(2);
	});

	it("an extra observed row that binds to nothing is UNEXPECTED, and the expected nodes still bind", () => {
		const r = run(
			[{ key: "v720", height: 720, bitrate: 2_000_000 }],
			[
				{ id: "ok", height: 720, bandwidth: 2_100_000 },
				{ id: "stray", height: 480, bandwidth: 900_000 },
			],
		);
		expect(bound(r)).toEqual(["v720->ok"]);
		expect(r.unmatchedObserved.map((o) => o.id)).toEqual(["stray"]);
	});

	it("a TRUE duplicate (identical canonical key) is reported before matching and binds once", () => {
		const r = run(
			[{ key: "v720", height: 720, bitrate: 2_000_000 }],
			[
				{ id: "same", height: 720, bandwidth: 2_000_000 },
				{ id: "same", height: 720, bandwidth: 2_000_000 },
			],
		);
		expect(r.duplicates.map((d) => [d.key, d.rows.length])).toEqual([
			["720|2000000|same", 2],
		]);
		expect(bound(r)).toEqual(["v720->same"]);
		// Collapsed to ONE representative: nothing is left over to call unexpected.
		expect(r.unmatchedObserved).toEqual([]);
	});

	it("a missing bandwidth is NOT treated as 0: the row with evidence wins even at 2.5×", () => {
		// nearestByBandwidth read `bandwidth ?? 0`, so a row declaring nothing sat
		// at distance 1.0× and beat a real row at 1.5× away. The unknown cost
		// must exceed any measured distance.
		const r = run(
			[{ key: "v720", height: 720, bitrate: 1_000_000 }],
			[
				{ id: "declared", height: 720, bandwidth: 2_500_000 },
				{ id: "silent", height: 720 },
			],
		);
		expect(bound(r)).toEqual(["v720->declared"]);
		expect(r.unmatchedObserved.map((o) => o.id)).toEqual(["silent"]);
		expect(normalizedBitrateCost(1_000_000, undefined)).toBe(
			UNKNOWN_BITRATE_COST,
		);
		expect(normalizedBitrateCost(1_000_000, 2_500_000)).toBeCloseTo(1.5);
		expect(UNKNOWN_BITRATE_COST).toBeGreaterThan(1.5);
	});

	it("a missing bandwidth ranks behind even an extremely distant declared value", () => {
		const r = run(
			[{ key: "v720", height: 720, bitrate: 1_000_000 }],
			[
				{ id: "declared", height: 720, bandwidth: 2_000_000_000 },
				{ id: "silent", height: 720 },
			],
		);
		expect(bound(r)).toEqual(["v720->declared"]);
		expect(r.unmatchedObserved.map((o) => o.id)).toEqual(["silent"]);
	});

	it("maximum cardinality beats a cheaper partial matching", () => {
		// A greedy pass would give `a` its perfect row and leave `b` with nothing;
		// the assignment takes the slightly dearer pairing that binds BOTH.
		const r = run(
			[
				{ key: "a", height: 360, bitrate: 1_000_000 },
				{ key: "b", height: 360, bitrate: 1_100_000 },
			],
			[
				{ id: "only-a", height: 360, bandwidth: 1_000_000 },
				{ id: "near-both", height: 360, bandwidth: 1_050_000 },
			],
		);
		expect(r.unmatchedExpected).toEqual([]);
		expect(r.unmatchedObserved).toEqual([]);
		expect(r.pairs).toHaveLength(2);
	});

	it("refuses duplicate EXPECTED keys — a check id must name one node", () => {
		expect(() =>
			run(
				[
					{ key: "dup", height: 360, bitrate: 1 },
					{ key: "dup", height: 360, bitrate: 2 },
				],
				[],
			),
		).toThrow(/duplicate expected key/);
	});

	it("empty inputs are empty outputs", () => {
		const r = run([], []);
		expect(r).toEqual({
			pairs: [],
			unmatchedExpected: [],
			unmatchedObserved: [],
			duplicates: [],
		});
	});
});
