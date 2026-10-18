import { describe, expect, it } from "vitest";
import {
	bulkIdsSchema,
	bulkSummary,
	dedupeIds,
	MAX_BULK_IDS,
} from "./bulk-ops";

const UUID = "a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c4d5";

/**
 * `count` distinct SPELLINGS of one uuid. A v4 uuid carries 12–16 hex letters,
 * so treating those positions as bits of a counter yields 2^16 spellings —
 * reaching MAX_BULK_IDS (50) needs only the first 50 of them.
 */
function caseVariants(uuid: string, count: number): string[] {
	const chars = [...uuid];
	const letters = chars.flatMap((c, i) => (/[a-f]/.test(c) ? [i] : []));
	return Array.from({ length: count }, (_, n) => {
		const out = [...chars];
		for (const [bit, at] of letters.entries()) {
			if (n & (1 << bit)) {
				out[at] = (chars[at] as string).toUpperCase();
			}
		}
		return out.join("");
	});
}

describe("dedupeIds", () => {
	it("collapses exact repeats", () => {
		expect(dedupeIds([UUID, UUID, UUID])).toEqual([UUID]);
	});

	it("collapses CASE VARIANTS of one id — they address the same row", () => {
		// z.uuid accepts either case and Postgres @db.Uuid normalizes, so these
		// are one target. A case-sensitive Set would return three.
		const variants = [
			UUID,
			UUID.toUpperCase(),
			"A1B2C3D4-e5f6-4a7b-8c9d-E0F1A2B3C4D5",
		];
		expect(dedupeIds(variants)).toEqual([UUID]);
	});

	it("returns the canonical lowercase form", () => {
		expect(dedupeIds([UUID.toUpperCase()])).toEqual([UUID]);
	});

	it("keeps distinct ids and their first-seen order", () => {
		const other = "b2c3d4e5-f6a7-4b8c-9d0e-f1a2b3c4d5e6";
		expect(dedupeIds([other, UUID, other.toUpperCase()])).toEqual([
			other,
			UUID,
		]);
	});

	it("caps a case-variant flood to one target inside MAX_BULK_IDS", () => {
		// The exploit shape: MAX_BULK_IDS spellings of ONE id, each a distinct
		// string, all passing z.uuid and all landing on the same row.
		const ids = caseVariants(UUID, MAX_BULK_IDS);
		expect(ids).toHaveLength(MAX_BULK_IDS);
		// They really are distinct STRINGS — what the old `new Set` saw.
		expect(new Set(ids).size).toBe(MAX_BULK_IDS);
		// Every one is accepted by the request schema...
		expect(bulkIdsSchema.safeParse({ ids }).success).toBe(true);
		// ...and every one is the same target.
		expect(dedupeIds(ids)).toEqual([UUID]);
	});
});

describe("bulkSummary", () => {
	it("mentions skips only when there are any", () => {
		expect(bulkSummary(3, 0, "canceled")).toBe("3 canceled");
		expect(bulkSummary(3, 1, "canceled")).toBe("3 canceled, 1 skipped");
	});
});
