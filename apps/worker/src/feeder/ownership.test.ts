import { describe, expect, it } from "vitest";
import {
	FEEDER_LEASE_RENEWAL_MS,
	FEEDER_LEASE_TAKEOVER_MS,
	feederLeaseIsFresh,
	feederLeaseStaleWhere,
	feederOwnerId,
} from "./ownership";

const NOW = Date.parse("2026-08-29T12:00:00.000Z");

describe("feeder owner id (row #242)", () => {
	it("distinguishes two workers on ONE host, and two boots at one pid", () => {
		const host = "worker-a";
		const twoProcesses = [
			feederOwnerId({ hostname: host, pid: 100, nonce: "aaaa" }),
			feederOwnerId({ hostname: host, pid: 200, nonce: "bbbb" }),
		];
		expect(twoProcesses[0]).not.toBe(twoProcesses[1]);
		// The case the nonce exists for: a restarted worker handed the SAME
		// pid. Without it the new process would inherit the dead one's lease
		// and every fence in the file would pass for the wrong owner.
		expect(feederOwnerId({ hostname: host, pid: 100, nonce: "aaaa" })).not.toBe(
			feederOwnerId({ hostname: host, pid: 100, nonce: "cccc" }),
		);
		// And it stays readable in a log line.
		expect(twoProcesses[0]).toContain(host);
		expect(twoProcesses[0]).toContain("100");
	});
});

describe("feeder lease freshness (row #242)", () => {
	it("is three renewal intervals wide", () => {
		expect(FEEDER_LEASE_TAKEOVER_MS).toBe(3 * FEEDER_LEASE_RENEWAL_MS);
		// Pinned as an inequality, not a number: the window must sit well under
		// BullMQ's stalled-job cadence (`maxStalledCount` 5 × a 30s stalled
		// interval — `stall-policy.ts`), so a lost session is RESUMED rather
		// than left waiting on a postmortem. NOT a claimed ORDER between the
		// two (review-365 S-2): a stalled START job is re-run before it is
		// failed, and a re-run of one whose row is already PUSHING completes
		// instead of failing.
		expect(FEEDER_LEASE_TAKEOVER_MS).toBeLessThan(5 * 30_000);
	});

	/**
	 * The truth table, evaluated by BOTH instruments — the predicate three
	 * callers test one row with, and the `where` fragment the sweep SELECTS
	 * its population with. On every READABLE timestamp they must be exact
	 * negations, because a hand-translated filter that drifts by one key does
	 * not fail: it silently selects the wrong rows, and here that is either a
	 * live push taken from its owner or a dead one nobody resumes
	 * (`packages/core/src/feeder/orphan-process.ts` records the same lesson).
	 * NULL is the one deliberate exception and has its own test below.
	 */
	const rows: { name: string; at: Date | string | null; fresh: boolean }[] = [
		{ name: "just renewed", at: new Date(NOW), fresh: true },
		{
			name: "one interval old",
			at: new Date(NOW - FEEDER_LEASE_RENEWAL_MS),
			fresh: true,
		},
		{
			name: "a millisecond inside the window",
			at: new Date(NOW - FEEDER_LEASE_TAKEOVER_MS + 1),
			fresh: true,
		},
		{
			// The boundary belongs to the OWNER: the sweep takes rows strictly
			// older than the window, so a lease exactly on it must read fresh
			// or there is one tick where a row is neither protected nor
			// takeable. The first cut had `<` here and this row is what found
			// it.
			name: "exactly the window",
			at: new Date(NOW - FEEDER_LEASE_TAKEOVER_MS),
			fresh: true,
		},
		{
			name: "an hour old",
			at: new Date(NOW - 3_600_000),
			fresh: false,
		},
		// A clock skewed FORWARD on the owner's host must not cost it its
		// push; the opposite skew is bounded by the window itself.
		{ name: "in the future", at: new Date(NOW + 60_000), fresh: true },
		{ name: "unparseable", at: "not a date", fresh: false },
	];

	const staleWhere = feederLeaseStaleWhere(NOW);
	/** The fragment, evaluated the way Postgres would. */
	const matchesStaleWhere = (at: Date | string | null): boolean => {
		if (staleWhere.ownerLeaseAt.not === null && at === null) {
			return false;
		}
		if (typeof at === "string") {
			// A non-timestamp cannot reach a DateTime column at all; the
			// predicate has to cope with it because a fake or a JSON round-trip
			// can hand it one.
			return false;
		}
		return at !== null && at < staleWhere.ownerLeaseAt.lt;
	};

	for (const row of rows) {
		it(`${row.name}: fresh=${row.fresh}, and the where fragment agrees`, () => {
			expect(feederLeaseIsFresh(row.at, NOW)).toBe(row.fresh);
			if (typeof row.at !== "string") {
				expect(matchesStaleWhere(row.at)).toBe(!row.fresh);
			}
		});
	}

	/**
	 * The ONE row where the two instruments do not negate each other, stated
	 * rather than smoothed over.
	 *
	 * A NULL lease is neither fresh nor takeable. Not fresh, because the
	 * readers of a `true` (the orphan sweep, the dead-job handler) would stop
	 * dead on it and a pre-column row would become unreclaimable. Not takeable,
	 * because an unclaimed row is a session whose own start job is still in the
	 * queue, and racing it would spawn a second ffmpeg for one session.
	 *
	 * This arm is where `not: null` is PINNED, and it is a shape assertion on
	 * purpose (review-365 S-1). Measured: dropping the key from the fragment
	 * leaves the behavioural arm in `processor.test.ts` GREEN, because SQL's
	 * `NULL < x` is never true and `lt` already excludes an unclaimed row. What
	 * catches it is `tsc` (`FeederLeaseStaleWhere` requires the key) and the
	 * last line here. So the key is a DECLARATION of the population, and this
	 * is what keeps it from being tidied away as redundant.
	 */
	it("a NULL lease is neither fresh NOR takeable — the asymmetry is the design", () => {
		expect(feederLeaseIsFresh(null, NOW)).toBe(false);
		expect(matchesStaleWhere(null)).toBe(false);
		expect(staleWhere.ownerLeaseAt.not).toBeNull();
	});

	it("reads an ISO string as well as a Date (what a fake hands back)", () => {
		expect(feederLeaseIsFresh(new Date(NOW).toISOString(), NOW)).toBe(true);
		expect(
			feederLeaseIsFresh(
				new Date(NOW - FEEDER_LEASE_TAKEOVER_MS - 1).toISOString(),
				NOW,
			),
		).toBe(false);
	});

	it("is false for an unusable NOW rather than freshening everything", () => {
		expect(feederLeaseIsFresh(new Date(NOW), Number.NaN)).toBe(false);
	});
});
