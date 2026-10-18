import { describe, expect, it } from "vitest";
import { fieldRef, fieldRefs, matchesWhere } from "./prisma-where";

/**
 * Field references (`prisma.model.fields.column`): column against column,
 * the way Postgres evaluates `a = b` / `a <> b` — UNKNOWN when either side
 * is NULL, never true. 's reset predicate is the consumer:
 * `stamp IS NULL OR stamp <> pointer`.
 */
describe("matchesWhere — field references", () => {
	const ref = fieldRef("EncodingJob", "bitmovinEncodingId");

	it("compares the two columns of the same row", () => {
		const where = { stamp: { not: ref } };
		expect(matchesWhere({ stamp: "a", bitmovinEncodingId: "b" }, where)).toBe(
			true,
		);
		expect(matchesWhere({ stamp: "a", bitmovinEncodingId: "a" }, where)).toBe(
			false,
		);
		expect(
			matchesWhere({ stamp: "a", bitmovinEncodingId: "a" }, { stamp: ref }),
		).toBe(true);
		expect(
			matchesWhere(
				{ stamp: "a", bitmovinEncodingId: "b" },
				{ stamp: { equals: ref } },
			),
		).toBe(false);
		// the shape Prisma's types accept: a reference under `not: { equals }`
		expect(
			matchesWhere(
				{ stamp: "a", bitmovinEncodingId: "b" },
				{ stamp: { not: { equals: ref } } },
			),
		).toBe(true);
		expect(
			matchesWhere(
				{ stamp: "a", bitmovinEncodingId: "a" },
				{ stamp: { not: { equals: ref } } },
			),
		).toBe(false);
		expect(
			matchesWhere(
				{ stamp: null, bitmovinEncodingId: "a" },
				{ stamp: { not: { equals: ref } } },
			),
		).toBe(false);
	});

	it("is UNKNOWN (not selected) when either column is NULL", () => {
		expect(
			matchesWhere(
				{ stamp: null, bitmovinEncodingId: "a" },
				{ stamp: { not: ref } },
			),
		).toBe(false);
		expect(
			matchesWhere(
				{ stamp: "a", bitmovinEncodingId: null },
				{ stamp: { not: ref } },
			),
		).toBe(false);
		expect(
			matchesWhere({ stamp: null, bitmovinEncodingId: null }, { stamp: ref }),
		).toBe(false);
	});

	it("serves the reset shape: NULL stamp or a stamp for another encoding selects, a matching stamp does not", () => {
		const where = {
			bitmovinEncodingId: { not: null },
			OR: [{ stamp: null }, { stamp: { not: ref } }],
		};
		expect(matchesWhere({ stamp: null, bitmovinEncodingId: "b" }, where)).toBe(
			true,
		);
		expect(matchesWhere({ stamp: "a", bitmovinEncodingId: "b" }, where)).toBe(
			true,
		);
		expect(matchesWhere({ stamp: "b", bitmovinEncodingId: "b" }, where)).toBe(
			false,
		);
		expect(matchesWhere({ stamp: "b", bitmovinEncodingId: null }, where)).toBe(
			false,
		);
	});

	it("orders column against column and refuses operators it does not model", () => {
		const n = fieldRef("T", "n");
		expect(matchesWhere({ m: 1, n: 2 }, { m: { lt: n } })).toBe(true);
		expect(matchesWhere({ m: 2, n: 2 }, { m: { gte: n } })).toBe(true);
		expect(() =>
			matchesWhere({ m: "ab", n: "a" }, { m: { contains: n } }),
		).toThrow(/field reference/);
		expect(fieldRefs("T", ["m", "n"]).n).toEqual({
			modelName: "T",
			name: "n",
			typeName: "String",
		});
	});
});
