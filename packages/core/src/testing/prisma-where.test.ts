import { describe, expect, it } from "vitest";
import { matchesWhere, orderRows, projectSelect } from "./prisma-where";

const T0 = new Date("2026-09-05T09:00:00.000Z");
const row = {
	id: "r1",
	status: "ACTIVE",
	kind: "error",
	nextAttemptAt: null,
	receivedAt: T0,
	liveChannelId: "ch-1",
	note: "provider: 503",
};
const channels = { "ch-1": { id: "ch-1", bitmovinAccountId: "acct-1" } };
const rel = (r: Record<string, unknown>, key: string) =>
	key === "liveChannel"
		? (channels[r.liveChannelId as keyof typeof channels] ?? null)
		: undefined;

describe("matchesWhere — the database's reading of a Prisma where", () => {
	it("scalar equality is NULL-aware: a column the fixture never set equals null, not undefined", () => {
		expect(matchesWhere(row, { status: "ACTIVE" })).toBe(true);
		expect(matchesWhere(row, { status: "DELETED" })).toBe(false);
		expect(matchesWhere(row, { claimedUntil: null })).toBe(true);
		expect(matchesWhere(row, { nextAttemptAt: null })).toBe(true);
		expect(matchesWhere(row, { nextAttemptAt: T0 })).toBe(false);
	});

	it("operators: in / notIn / not / not-null / lt / lte / gt / gte / contains", () => {
		expect(matchesWhere(row, { status: { in: ["SKIPPED", "ACTIVE"] } })).toBe(
			true,
		);
		expect(matchesWhere(row, { status: { notIn: ["ACTIVE"] } })).toBe(false);
		expect(matchesWhere(row, { status: { not: "ACTIVE" } })).toBe(false);
		expect(matchesWhere(row, { note: { not: null } })).toBe(true);
		expect(matchesWhere(row, { nextAttemptAt: { not: null } })).toBe(false);
		expect(
			matchesWhere(row, { receivedAt: { lt: new Date(T0.getTime() + 1) } }),
		).toBe(true);
		expect(matchesWhere(row, { receivedAt: { lte: T0 } })).toBe(true);
		expect(matchesWhere(row, { receivedAt: { gt: T0 } })).toBe(false);
		expect(matchesWhere(row, { receivedAt: { gte: T0 } })).toBe(true);
		// NULL never satisfies an ordering comparison.
		expect(matchesWhere(row, { nextAttemptAt: { lte: T0 } })).toBe(false);
		expect(matchesWhere(row, { note: { contains: "503" } })).toBe(true);
	});

	it("OR / AND / NOT compose, including the CAS shape (status in … AND both windows free)", () => {
		const cas = {
			status: { in: ["SKIPPED", "FAILED", "DELETED"] },
			AND: [
				{ OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: T0 } }] },
				{ OR: [{ claimedUntil: null }, { claimedUntil: { lte: T0 } }] },
			],
		};
		expect(matchesWhere({ ...row, status: "FAILED" }, cas)).toBe(true);
		expect(
			matchesWhere(
				{ ...row, status: "FAILED", claimedUntil: new Date(T0.getTime() + 1) },
				cas,
			),
		).toBe(false);
		expect(matchesWhere(row, cas)).toBe(false); // ACTIVE is not claimable
		expect(matchesWhere(row, { NOT: { status: "ACTIVE" } })).toBe(false);
	});

	it("relation filters resolve through the resolver; a missing relation never matches", () => {
		expect(
			matchesWhere(row, { liveChannel: { bitmovinAccountId: "acct-1" } }, rel),
		).toBe(true);
		expect(
			matchesWhere(row, { liveChannel: { bitmovinAccountId: "acct-2" } }, rel),
		).toBe(false);
		expect(
			matchesWhere(
				{ ...row, liveChannelId: "gone" },
				{ liveChannel: { bitmovinAccountId: "acct-1" } },
				rel,
			),
		).toBe(false);
		expect(
			matchesWhere(
				{ ...row, liveChannelId: "gone" },
				{ liveChannel: { is: null } },
				rel,
			),
		).toBe(true);
	});

	it("an operator this reading does not know THROWS instead of matching everything", () => {
		expect(() => matchesWhere(row, { status: { search: "x" } })).toThrow(
			/unsupported operator/,
		);
	});
});

describe("projectSelect / orderRows", () => {
	it("projects scalars and one nested relation select; unset columns come back as null", () => {
		expect(
			projectSelect(
				row,
				{
					id: true,
					claimedUntil: true,
					liveChannel: { select: { bitmovinAccountId: true } },
				},
				rel,
			),
		).toEqual({
			id: "r1",
			claimedUntil: null,
			liveChannel: { bitmovinAccountId: "acct-1" },
		});
	});

	it("orders by one or more fields, Dates by time, desc when asked", () => {
		const a = { id: "a", at: new Date(T0.getTime() + 1000) };
		const b = { id: "b", at: T0 };
		const c = { id: "c", at: T0 };
		expect(
			orderRows([a, b, c], [{ at: "asc" }, { id: "asc" }]).map((r) => r.id),
		).toEqual(["b", "c", "a"]);
		expect(orderRows([a, b, c], { at: "desc" }).map((r) => r.id)[0]).toBe("a");
	});
});

describe("matchesWhere — three-valued logic and the shapes rev416 found answered wrongly", () => {
	const set = {
		id: "s",
		kind: "x",
		status: "ACTIVE",
		deletedAt: T0,
		note: "hello",
	};
	const nul = { id: "n", kind: null, status: "ACTIVE" };

	it("`{ col: undefined }` and `{ equals: undefined }` are NO filter, as Prisma drops the key", () => {
		expect(matchesWhere(set, { deletedAt: undefined })).toBe(true);
		expect(matchesWhere(set, { kind: { equals: undefined } })).toBe(true);
		expect(matchesWhere(set, { kind: { in: ["x"], not: undefined } })).toBe(
			true,
		);
	});

	it("not / notIn / NOT never select a NULL column (NULL <> 'y' is UNKNOWN); only IS NULL / IS NOT NULL are defined on it", () => {
		expect(matchesWhere(nul, { kind: { not: "y" } })).toBe(false);
		expect(matchesWhere(nul, { kind: { notIn: ["y"] } })).toBe(false);
		expect(matchesWhere(nul, { NOT: { kind: "y" } })).toBe(false);
		expect(matchesWhere(nul, { kind: { not: null } })).toBe(false);
		expect(matchesWhere(nul, { kind: null })).toBe(true);
		expect(matchesWhere(nul, { NOT: { kind: null } })).toBe(false);
		expect(matchesWhere(set, { NOT: { kind: null } })).toBe(true);
		expect(matchesWhere(nul, { kind: { in: ["x", "y"] } })).toBe(false);
		expect(matchesWhere(nul, { kind: { contains: "x" } })).toBe(false);
		// An UNKNOWN inside OR is rescued by a true sibling; inside AND it is fatal.
		expect(
			matchesWhere(nul, { OR: [{ kind: { not: "y" } }, { status: "ACTIVE" }] }),
		).toBe(true);
		expect(
			matchesWhere(nul, {
				AND: [{ kind: { not: "y" } }, { status: "ACTIVE" }],
			}),
		).toBe(false);
	});

	it("NOT and notIn over TWO alternatives: one matching alternative excludes the row (some, never every)", () => {
		expect(matchesWhere(set, { NOT: [{ kind: "x" }, { status: "z" }] })).toBe(
			false,
		);
		expect(matchesWhere(set, { NOT: [{ kind: "q" }, { status: "z" }] })).toBe(
			true,
		);
		expect(matchesWhere(set, { kind: { notIn: ["x", "q"] } })).toBe(false);
		expect(matchesWhere(set, { kind: { notIn: ["p", "q"] } })).toBe(true);
	});

	it("equals / startsWith / endsWith / contains each do their own comparison", () => {
		expect(matchesWhere(set, { id: { equals: "s" } })).toBe(true);
		expect(matchesWhere(set, { id: { equals: "zzz" } })).toBe(false);
		expect(matchesWhere(set, { deletedAt: { equals: T0 } })).toBe(true);
		expect(matchesWhere(set, { note: { startsWith: "hel" } })).toBe(true);
		expect(matchesWhere(set, { note: { startsWith: "lo" } })).toBe(false);
		expect(matchesWhere(set, { note: { endsWith: "lo" } })).toBe(true);
		expect(matchesWhere(set, { note: { endsWith: "hel" } })).toBe(false);
		expect(matchesWhere(set, { note: { contains: "ell" } })).toBe(true);
		expect(matchesWhere(set, { note: { contains: "xyz" } })).toBe(false);
	});

	it("orderRows puts NULLs last ascending (Postgres), first descending — whichever side of the comparison the NULL lands on", () => {
		const D1 = new Date("2026-09-05T10:00:00Z"); // later than T0 (09:00Z)
		const rows = [
			{ id: "a", at: null },
			{ id: "b", at: D1 },
			{ id: "c", at: null },
			{ id: "d", at: T0 },
		];
		expect(orderRows(rows, { at: "asc" }).map((r) => r.id)).toEqual([
			"d",
			"b",
			"a",
			"c",
		]);
		expect(orderRows(rows, { at: "desc" }).map((r) => r.id)).toEqual([
			"a",
			"c",
			"b",
			"d",
		]);
		expect(
			orderRows([...rows].reverse(), { at: "asc" }).map((r) => r.id),
		).toEqual(["d", "b", "c", "a"]);
		expect(
			orderRows([...rows].reverse(), { at: "desc" }).map((r) => r.id),
		).toEqual(["c", "a", "b", "d"]);
	});
});

describe("ordering and select — rev416 F6 (orderRows answered silently) and the select of a relation", () => {
	const D0 = new Date("2026-09-05T00:00:00Z");
	const D1 = new Date("2026-09-05T01:00:00Z");

	it("orders numbers numerically, never as strings", () => {
		const rows = [
			{ id: "a", n: 10 },
			{ id: "b", n: 9 },
			{ id: "c", n: 100 },
		];
		expect(orderRows(rows, { n: "asc" }).map((r) => r.n)).toEqual([9, 10, 100]);
		expect(orderRows(rows, { n: "desc" }).map((r) => r.n)).toEqual([
			100, 10, 9,
		]);
	});

	it("orders Dates by time and strings lexicographically, through a list of keys", () => {
		const rows = [
			{ id: "b", at: D1 },
			{ id: "a", at: D1 },
			{ id: "c", at: D0 },
		];
		expect(
			orderRows(rows, [{ at: "desc" }, { id: "asc" }]).map((r) => r.id),
		).toEqual(["a", "b", "c"]);
	});

	it("throws on a relation orderBy or an unknown direction instead of silently not ordering", () => {
		expect(() =>
			orderRows([{ id: "a" }], { liveChannel: { name: "asc" } }),
		).toThrow(/orderBy/);
		expect(() => orderRows([{ id: "a" }], { id: "ASC" })).toThrow(/orderBy/);
	});

	it("lt/gt on a number column compare numerically; a number against a string throws", () => {
		expect(matchesWhere({ n: 9 }, { n: { lt: 10 } })).toBe(true);
		expect(matchesWhere({ n: 100 }, { n: { gt: 20 } })).toBe(true);
		expect(matchesWhere({ n: 100 }, { n: { lt: 10 } })).toBe(false);
		expect(() => matchesWhere({ n: 9 }, { n: { gt: "5" } })).toThrow(/order/);
	});

	it("select of a known relation returns the related record, of an unlinked one null, of a scalar the column", () => {
		const ch = { id: "c1", name: "Studio" };
		const rel = (row: Record<string, unknown>, k: string) =>
			k === "liveChannel" ? (row.liveChannelId ? ch : null) : undefined;
		expect(
			projectSelect(
				{ id: "r", liveChannelId: "c1", note: "x" },
				{ liveChannel: true, note: true },
				rel,
			),
		).toEqual({ liveChannel: ch, note: "x" });
		expect(
			projectSelect(
				{ id: "r", liveChannelId: null },
				{ liveChannel: true },
				rel,
			),
		).toEqual({ liveChannel: null });
	});

	it("`{ col: {} }` is no filter, as Prisma reads it", () => {
		expect(matchesWhere({ id: "a" }, { id: {} })).toBe(true);
	});
});

describe("to-one relation filters — the LEFT JOIN reading Prisma 6.19 generates (rev416 R1)", () => {
	const ch = { id: "ch-1", name: "Studio", note: null };
	const rel = (row: Record<string, unknown>, k: string) =>
		k === "liveChannel" ? (row.liveChannelId ? ch : null) : undefined;
	const linked = { id: "r1", liveChannelId: "ch-1" };
	const unlinked = { id: "r2", liveChannelId: null };

	it("plain and `is` are pred(j0) AND j0.id IS NOT NULL: a missing relation never matches, an UNKNOWN on the related row never selects", () => {
		expect(matchesWhere(linked, { liveChannel: { id: "ch-1" } }, rel)).toBe(
			true,
		);
		expect(matchesWhere(unlinked, { liveChannel: { id: "ch-1" } }, rel)).toBe(
			false,
		);
		expect(
			matchesWhere(linked, { liveChannel: { is: { id: "ch-1" } } }, rel),
		).toBe(true);
		expect(
			matchesWhere(unlinked, { liveChannel: { is: { id: "ch-1" } } }, rel),
		).toBe(false);
		expect(
			matchesWhere(linked, { liveChannel: { is: { id: "zzz" } } }, rel),
		).toBe(false);
		expect(
			matchesWhere(linked, { liveChannel: { name: { not: "x" } } }, rel),
		).toBe(true);
		expect(
			matchesWhere(linked, { liveChannel: { note: { not: "x" } } }, rel),
		).toBe(false); // NULL <> 'x' is UNKNOWN
	});

	it("`isNot` is NOT pred(j0) OR j0.id IS NULL: a missing relation IS selected, a matching one is not, an UNKNOWN stays unknown", () => {
		expect(
			matchesWhere(unlinked, { liveChannel: { isNot: { id: "ch-1" } } }, rel),
		).toBe(true);
		expect(
			matchesWhere(linked, { liveChannel: { isNot: { id: "ch-1" } } }, rel),
		).toBe(false);
		expect(
			matchesWhere(linked, { liveChannel: { isNot: { id: "zzz" } } }, rel),
		).toBe(true);
		expect(
			matchesWhere(linked, { liveChannel: { isNot: { note: "x" } } }, rel),
		).toBe(false); // NOT (NULL = 'x') is UNKNOWN
		expect(
			matchesWhere(
				linked,
				{ OR: [{ liveChannel: { isNot: { note: "x" } } }, { id: "r1" }] },
				rel,
			),
		).toBe(true);
	});

	it("an UNKNOWN from the related row propagates through NOT; a missing relation under NOT is definitely selected", () => {
		expect(
			matchesWhere(
				linked,
				{ NOT: { liveChannel: { note: { not: "x" } } } },
				rel,
			),
		).toBe(false);
		expect(
			matchesWhere(unlinked, { NOT: { liveChannel: { id: "ch-1" } } }, rel),
		).toBe(true);
		expect(
			matchesWhere(linked, { NOT: { liveChannel: { id: "zzz" } } }, rel),
		).toBe(true);
	});

	it("`is: null` / `isNot: null` test the foreign key in both directions", () => {
		expect(matchesWhere(linked, { liveChannel: { is: null } }, rel)).toBe(
			false,
		);
		expect(matchesWhere(unlinked, { liveChannel: { is: null } }, rel)).toBe(
			true,
		);
		expect(matchesWhere(linked, { liveChannel: { isNot: null } }, rel)).toBe(
			true,
		);
		expect(matchesWhere(unlinked, { liveChannel: { isNot: null } }, rel)).toBe(
			false,
		);
	});

	it("an UNKNOWN under `is` is observable through NOT; a relation object mixing is/isNot with a field key throws", () => {
		expect(
			matchesWhere(
				linked,
				{ NOT: { liveChannel: { is: { note: { not: "x" } } } } },
				rel,
			),
		).toBe(false);
		expect(
			matchesWhere(
				linked,
				{ NOT: { liveChannel: { is: { id: "zzz" } } } },
				rel,
			),
		).toBe(true);
		expect(() =>
			matchesWhere(
				linked,
				{ liveChannel: { is: { name: "Studio" }, name: "Q" } },
				rel,
			),
		).toThrow(/mixes/);
		// `is: undefined` is dropped by Prisma: the sibling field filter applies alone.
		expect(
			matchesWhere(linked, { liveChannel: { is: undefined, id: "ch-1" } }, rel),
		).toBe(true);
		expect(
			matchesWhere(linked, { liveChannel: { is: undefined, id: "zzz" } }, rel),
		).toBe(false);
	});

	it("an empty relation filter is no condition (Prisma compiles `{ rel: {} }` and `{ rel: { is: undefined } }` to 1=1); `is: {}` is linked-only and `isNot: {}` unlinked-only", () => {
		expect(matchesWhere(unlinked, { liveChannel: {} }, rel)).toBe(true);
		expect(
			matchesWhere(unlinked, { liveChannel: { is: undefined } }, rel),
		).toBe(true);
		expect(matchesWhere(linked, { liveChannel: { is: undefined } }, rel)).toBe(
			true,
		);
		expect(matchesWhere(linked, { liveChannel: { is: {} } }, rel)).toBe(true);
		expect(matchesWhere(unlinked, { liveChannel: { is: {} } }, rel)).toBe(
			false,
		);
		expect(matchesWhere(linked, { liveChannel: { isNot: {} } }, rel)).toBe(
			false,
		);
		expect(matchesWhere(unlinked, { liveChannel: { isNot: {} } }, rel)).toBe(
			true,
		);
	});
});
