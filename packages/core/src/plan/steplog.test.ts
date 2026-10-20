import { describe, expect, it, vi } from "vitest";
import {
	isRuntimeRecordKind,
	OPERATION_KINDS,
	RUNTIME_RECORD_KINDS,
	soleEncodingStepId,
} from "./steplog";

/**
 * `soleEncodingStepId` exists so the web's status gate and the worker's
 * `bitmovinEncodingId` denormalization "cannot drift" — and it had **no tests in
 * the package that owns it**. A reviewer showed that deleting its
 * `CREATE_ENCODING` signal outright left core 994, worker 350 and web 1164 all
 * green: an anti-drift helper pinned only by incidental coverage in one web test
 * file, and only one of its two halves at that.
 *
 * The acceptance bar for this file is that bar: deleting EITHER signal must fail
 * something here, in `packages/core`.
 */

type Entry = Record<string, unknown>;

const create = (step: string): Entry => ({
	step,
	kind: "CREATE_ENCODING",
	payload: {},
	refs: {},
	status: "DONE",
});

const awaited = (encodingId: string): Entry => ({
	step: `await:${encodingId}`,
	kind: "AWAIT_ENCODING",
	payload: {},
	refs: { encodingId },
	status: "DONE",
});

const started = (encodingId: string): Entry => ({
	step: `start:${encodingId}`,
	kind: "START_ENCODING",
	payload: {},
	refs: { encodingId },
	status: "DONE",
});

describe("soleEncodingStepId", () => {
	it("names the encoding when both signals agree", () => {
		// The real shape: `initStepLog` seeds every compiled op, so a persisted log
		// carries the CREATE entry from the moment the row exists, and the compiler
		// emits both ids from the same `enc.step`.
		expect(soleEncodingStepId([create("encoding"), awaited("encoding")])).toBe(
			"encoding",
		);
	});

	it("names an explicitly-keyed single encoding", () => {
		// `plan.encodings` has no `.min(2)`, so one named encoding compiles to
		// `encoding:<key>`. Keying on the literal `"encoding"` used to skip this and
		// leave `bitmovinEncodingId` null.
		expect(
			soleEncodingStepId([create("encoding:main"), awaited("encoding:main")]),
		).toBe("encoding:main");
	});

	it("refuses a LADDER — more than one encoding means no sole encoding", () => {
		// Denormalizing one sibling would point the runtime actions at the wrong
		// encoding, so null is the answer, not a pick.
		expect(
			soleEncodingStepId([
				create("encoding:dv"),
				create("encoding:sdr"),
				awaited("encoding:dv"),
				awaited("encoding:sdr"),
			]),
		).toBeNull();
	});

	it("refuses when the two signals DISAGREE", () => {
		// The case that silently returns null and 409s reprioritize and reschedule while
		// the encoding exists. Cannot happen from a compiled plan — both ids come
		// off the same `enc.step` — so reaching it means the log is inconsistent.
		expect(
			soleEncodingStepId([create("encoding:a"), awaited("encoding:b")]),
		).toBeNull();
	});

	it("refuses a LADDER whose siblings are unevenly referenced", () => {
		// The case an intersection accepted and this must not: two encodings created,
		// only one of them referenced by an AWAIT. Intersecting named that sibling
		// as the sole encoding, which would have denormalized the WRONG encoding of
		// a ladder into the job row (review catch, proved by enumeration).
		expect(
			soleEncodingStepId([
				create("encoding:dv"),
				create("encoding:sdr"),
				awaited("encoding:dv"),
			]),
		).toBeNull();
	});

	it("refuses an id referenced but never created", () => {
		// A union makes any unexpected id enlarge the set, so this fails closed
		// rather than being silently intersected away.
		expect(
			soleEncodingStepId([create("encoding"), awaited("encoding:ghost")]),
		).toBeNull();
	});

	it("WARNS on an inconsistent log, and stays silent on a legitimate one", () => {
		// Null is right for both a ladder and an inconsistent log, but the caller
		// cannot tell them apart — it just renders "no encoding yet" while the
		// encoding exists. Exactly one CREATE entry proves this is not a ladder.
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			// Inconsistent: one encoding created, an extra id referenced.
			soleEncodingStepId([create("encoding"), awaited("encoding:ghost")]);
			expect(warn).toHaveBeenCalledTimes(1);
			expect(warn.mock.calls[0]?.[0]).toContain("encoding:ghost");

			warn.mockClear();
			// A LADDER is not inconsistent — two creates, so no warn.
			soleEncodingStepId([
				create("encoding:dv"),
				create("encoding:sdr"),
				awaited("encoding:dv"),
			]);
			expect(warn).not.toHaveBeenCalled();

			// A live-shaped log (creates, no status entries) resolves cleanly.
			soleEncodingStepId([create("encoding:live")]);
			expect(warn).not.toHaveBeenCalled();
		} finally {
			warn.mockRestore();
		}
	});

	it("works from the CREATE signal alone", () => {
		// This half is currently dead weight for every real caller (the worker
		// passes the full log, which always has an AWAIT for VOD). It becomes
		// load-bearing only for a log with no AWAIT_ENCODING — i.e. live — which
		// does not use this helper yet. Pinned so converting live does not run on
		// unexercised code.
		expect(soleEncodingStepId([create("encoding:only")])).toBe("encoding:only");
	});

	it("works from the refs signal alone", () => {
		expect(soleEncodingStepId([awaited("encoding")])).toBe("encoding");
		expect(soleEncodingStepId([started("encoding")])).toBe("encoding");
	});

	it("ignores entries that are not encoding-status kinds", () => {
		// A muxing's refs must not be mistaken for an encoding id.
		expect(
			soleEncodingStepId([
				create("encoding"),
				{
					step: "muxing:a",
					kind: "CREATE_FMP4_MUXING",
					refs: { encodingId: "encoding", muxingId: "m" },
					payload: {},
					status: "DONE",
				},
				awaited("encoding"),
			]),
		).toBe("encoding");
	});

	it("returns null for nothing to go on", () => {
		expect(soleEncodingStepId([])).toBeNull();
		expect(soleEncodingStepId(null)).toBeNull();
		expect(soleEncodingStepId(undefined)).toBeNull();
		expect(soleEncodingStepId("not an array")).toBeNull();
		expect(soleEncodingStepId([null, 7, "x", {}])).toBeNull();
	});

	it("ignores a non-string step or encodingId", () => {
		expect(
			soleEncodingStepId([
				{ kind: "CREATE_ENCODING", step: 7 },
				{ kind: "AWAIT_ENCODING", refs: { encodingId: 7 } },
			]),
		).toBeNull();
	});
});

describe("isRuntimeRecordKind", () => {
	/**
	 * This test used to say "covers BOTH runtime records" and assert two of
	 * three — the same restatement that let `SLATE_INSERTED` go missing in the
	 * first place, sitting in the direct unit test of the function that decides
	 * it. Removing SLATE_INSERTED from the classification left this file 13/13
	 * green (review-298 F3, mutation-confirmed).
	 *
	 * EQUALITY, not a count floor. A floor (`length > 2`) passes while a kind is
	 * missing as soon as a later kind is added, so it decays the moment it is
	 * needed. This pin names the whole set and fails on any change to it —
	 * which is what a reviewed edit should have to do.
	 */
	it("is exactly the classified runtime-record set — no more, no less", () => {
		expect([...RUNTIME_RECORD_KINDS].sort()).toEqual([
			"ESAM_MEDIA_POINT",
			"LIVE_AUTO_SHUTDOWN_UPDATE",
			"SCTE35_CUE",
			// 's three verdicts join the set: they too are appended
			// after the fact and must never be replayed — re-running one would
			// re-read a provider status, and a mis-seeded PENDING one would
			// otherwise reach `executeLiveStep` and wedge the channel, which is
			// the exact failure SLATE_INSERTED's own omission caused.
			"SLATE_CONFIRMED",
			"SLATE_FAILED",
			"SLATE_INSERTED",
			"SLATE_UNCONFIRMED",
		]);
	});

	it("answers true for every member and false for everything else", () => {
		// Derived from the set, so a fourth kind is covered by whoever adds it.
		for (const kind of RUNTIME_RECORD_KINDS) {
			expect(isRuntimeRecordKind(kind)).toBe(true);
		}
		for (const kind of OPERATION_KINDS) {
			if (!(RUNTIME_RECORD_KINDS as ReadonlySet<string>).has(kind)) {
				expect(isRuntimeRecordKind(kind)).toBe(false);
			}
		}
		expect(isRuntimeRecordKind("")).toBe(false);
		expect(isRuntimeRecordKind("NOT_A_KIND")).toBe(false);
	});
});
