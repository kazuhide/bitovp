import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createBitmovinSdkOps } from "./sdk-ops";

/**
 *  — the FREEZE that precedes the split. The row's own plan:
 * "the facade tests must be the freeze FIRST, and the extraction reviewed
 * as pure moves". These two pins are that freeze:
 *
 *  - the sdk-ops FACADE's member set, read from the constructed object —
 *    an extraction that drops, renames or accidentally adds a member fails
 *    here by name;
 *  - the executor's case-label set, read from the SOURCE — a case lost in
 *    a move fails here by name.
 *
 * Both are set-equality pins (never counts alone): a swap that preserves
 * the count still fails. When the split lands, these tests move to the
 * barrel and keep guarding the same surface.
 */
describe("ledger #76 — the pre-split freeze", () => {
	it("the sdk-ops facade's member set is frozen by name", () => {
		const ops = createBitmovinSdkOps(
			{ apiKey: "freeze-probe" },
			async () => {},
		);
		const members = Object.keys(ops).sort();
		// Snapshot pinned as data, not toMatchSnapshot: a snapshot silently
		// rewrites on -u; this list moves only with a reviewed edit HERE.
		// 97 runtime members (the row's ~113 counted TYPE members).
		expect(members.length).toBeGreaterThan(90);
		const src = readFileSync(join(__dirname, "facade-members.json"), "utf8");
		expect(members).toEqual(JSON.parse(src));
	});

	it("the executor's case-label set is frozen by name", () => {
		const src = readFileSync(join(__dirname, "executor.ts"), "utf8");
		const cases = [...src.matchAll(/^\t\tcase "([A-Z0-9_]+)"/gm)]
			.map((m) => m[1] as string)
			.sort();
		expect(cases.length).toBeGreaterThan(70);
		const pinned = JSON.parse(
			readFileSync(join(__dirname, "executor-cases.json"), "utf8"),
		) as string[];
		expect(cases).toEqual(pinned);
	});
});
