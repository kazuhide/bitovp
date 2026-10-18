import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The stable prerequisite guide must name every capability preflight can emit.
 * Availability itself is deliberately absent: preflight measures it per run.
 * Population is pinned from the Capability union, not a second hand list.
 */
describe("verification capability prerequisite guide", () => {
	it("lists every Capability the preflight can emit, and nothing else", () => {
		const preflightSrc = readFileSync(join(__dirname, "preflight.ts"), "utf8");
		const union = preflightSrc.match(/export type Capability =([\s\S]*?)\n\n/);
		if (!union?.[1]) {
			throw new Error("Capability union not found in preflight.ts");
		}
		const fromSource = new Set(
			[...union[1].matchAll(/\| "([A-Z_0-9]+)"/g)].map((m) => m[1] as string),
		);
		expect(fromSource.size).toBeGreaterThan(10);

		const doc = readFileSync(
			join(__dirname, "../../../../docs/VERIFY-ENVIRONMENT.md"),
			"utf8",
		);
		const fromDoc = new Set(
			[...doc.matchAll(/^\| ([A-Z_0-9]+) \| /gm)].map((m) => m[1] as string),
		);
		expect([...fromSource].sort()).toEqual([...fromDoc].sort());
	});
});
