import { describe, expect, it } from "vitest";
import {
	type KnownEncodingIds,
	orphanLiveEncodings,
	type RunningLiveEncoding,
} from "./orphan-encodings";

/**
 * The rule this pins is the one whose absence cost 7h19m of billing: an encoding is
 * accounted for if EITHER the column or the step log names it. Reading the column
 * alone is the original bug, so every test here is written so that a column-only
 * implementation fails it.
 */

const NOW = new Date("2026-08-11T12:00:00.000Z");

const enc = (
	id: string,
	over: Partial<RunningLiveEncoding> = {},
): RunningLiveEncoding => ({ id, status: "RUNNING", ...over });

/**
 * `known([["id","RUNNING"]], …)` — the STATUS is required, because "a row names it"
 * is not what makes an encoding reachable. Defaults to RUNNING so the existing cases
 * read as before.
 */
const known = (
	column: Array<[string, string]> = [],
	stepLog: Array<[string, string]> = [],
): KnownEncodingIds => ({
	fromColumn: new Map(column),
	fromStepLog: new Map(stepLog),
});

describe("orphanLiveEncodings", () => {
	it("reports an encoding no row names at all", () => {
		const report = orphanLiveEncodings([enc("e-1")], known(), NOW);
		expect(report.orphans.map((o) => o.id)).toEqual(["e-1"]);
		expect(report.running).toBe(1);
	});

	it("accounts for one the STEP LOG names but the column does not", () => {
		// The exact shape of the leak: the column held `63c65f0d…` while the step log
		// held `f0c0e872…`, and the one running was the step log's. A column-only
		// implementation calls this an orphan and would have an operator chasing a
		// channel that is working.
		const report = orphanLiveEncodings(
			[enc("f0c0e872")],
			known([["63c65f0d", "RUNNING"]], [["f0c0e872", "RUNNING"]]),
			NOW,
		);
		expect(report.orphans).toEqual([]);
		expect(report.accountedFor).toEqual({
			total: 1,
			byColumn: 0,
			byStepLog: 1,
		});
	});

	it("accounts for one the COLUMN names but the step log does not", () => {
		const report = orphanLiveEncodings(
			[enc("e-1")],
			known([["e-1", "RUNNING"]], []),
			NOW,
		);
		expect(report.orphans).toEqual([]);
		expect(report.accountedFor).toEqual({
			total: 1,
			byColumn: 1,
			byStepLog: 0,
		});
	});

	it("counts an id in BOTH sources under both, not as an else-branch", () => {
		// The two counts answer "how much does each source explain", and an id in both
		// must not make one source look like it covered something the other did. The
		// sources disagreeing is the whole subject of this row.
		const report = orphanLiveEncodings(
			[enc("e-1")],
			known([["e-1", "RUNNING"]], [["e-1", "RUNNING"]]),
			NOW,
		);
		expect(report.accountedFor).toEqual({
			total: 1,
			byColumn: 1,
			byStepLog: 1,
		});
	});

	it("separates the explained from the unexplained in one pass", () => {
		const report = orphanLiveEncodings(
			[enc("known-col"), enc("known-log"), enc("orphan-a"), enc("orphan-b")],
			known([["known-col", "RUNNING"]], [["known-log", "RUNNING"]]),
			NOW,
		);
		expect(report.running).toBe(4);
		expect(report.orphans.map((o) => o.id)).toEqual(["orphan-a", "orphan-b"]);
	});

	it("ages an orphan in whole minutes from its creation time", () => {
		const report = orphanLiveEncodings(
			[enc("e-1", { createdAt: "2026-08-11T04:41:00.000Z" })],
			known(),
			NOW,
		);
		// 7h19m — the age the four leaked encodings actually reached.
		expect(report.orphans[0]?.ageMinutes).toBe(439);
	});

	it("leaves the age UNDEFINED when the API reported none", () => {
		// Not 0. A missing age rendered as "just started" is the reading that makes an
		// orphan look harmless, which is the opposite of what this exists to say.
		const report = orphanLiveEncodings([enc("e-1")], known(), NOW);
		expect(report.orphans[0]?.ageMinutes).toBeUndefined();
	});

	it("leaves the age undefined on an unparseable creation time", () => {
		const report = orphanLiveEncodings(
			[enc("e-1", { createdAt: "not a date" })],
			known(),
			NOW,
		);
		expect(report.orphans[0]?.ageMinutes).toBeUndefined();
	});

	it("clamps a future creation time to zero rather than going negative", () => {
		// Clock skew between us and Bitmovin must not produce "-3 minutes old".
		const report = orphanLiveEncodings(
			[enc("e-1", { createdAt: "2026-08-11T12:05:00.000Z" })],
			known(),
			NOW,
		);
		expect(report.orphans[0]?.ageMinutes).toBe(0);
	});

	it("says nothing is wrong when nothing is running", () => {
		expect(orphanLiveEncodings([], known([["e-1", "RUNNING"]]), NOW)).toEqual({
			running: 0,
			accountedFor: { total: 0, byColumn: 0, byStepLog: 0 },
			orphans: [],
			contradicted: [],
			inFlight: [],
		});
	});
});

describe("the incident this module exists for", () => {
	/**
	 * LEDGER #48, REPRODUCED. Four channels' rows all said STOPPED while Bitmovin had
	 * four different encodings RUNNING, the oldest 7h19m — and the running ids were
	 * the STEP LOG's, not the column's (`live-processor.ts` records the pair:
	 * column `63c65f0d…`, step log `f0c0e872…`, and `f0c0e872…` was the one running).
	 *
	 * The first version of this module answered "0 orphans, all accounted for" to
	 * exactly this input, and the script printed "nothing unaccounted for" (review
	 * catch). It treated "a row names it" as safety, when no code path stops an
	 * encoding whose channel is STOPPED: `stopChannel` claims only
	 * RUNNING/STOPPING/ERROR and the heartbeat sweep queries RUNNING.
	 */
	it("does NOT call a billing encoding accounted-for because a STOPPED row names it", () => {
		const report = orphanLiveEncodings(
			[enc("f0c0e872", { createdAt: "2026-08-11T04:41:00.000Z" })],
			known([["63c65f0d", "STOPPED"]], [["f0c0e872", "STOPPED"]]),
			NOW,
		);
		expect(report.accountedFor.total).toBe(0);
		expect(report.contradicted.map((c) => c.id)).toEqual(["f0c0e872"]);
		expect(report.contradicted[0]?.channelStatus).toBe("STOPPED");
		// 7h19m, the age the real one reached.
		expect(report.contradicted[0]?.ageMinutes).toBe(439);
	});

	it("still accounts for it while the channel is one teardown can act from", () => {
		for (const status of ["RUNNING", "STOPPING", "ERROR"]) {
			const report = orphanLiveEncodings(
				[enc("f0c0e872")],
				known([], [["f0c0e872", status]]),
				NOW,
			);
			expect(report.contradicted, status).toEqual([]);
			expect(report.accountedFor.total, status).toBe(1);
		}
	});

	it("keeps contradicted separate from unexplained — they need different actions", () => {
		// An orphan nothing names may be the owner's own work; a contradicted one is
		// ours and provably unreachable. Folding them together loses that.
		const report = orphanLiveEncodings(
			[enc("ours"), enc("nobodys")],
			known([], [["ours", "STOPPED"]]),
			NOW,
		);
		expect(report.orphans.map((o) => o.id)).toEqual(["nobodys"]);
		expect(report.contradicted.map((c) => c.id)).toEqual(["ours"]);
	});
});

describe("a channel still provisioning is not the #48 shape", () => {
	/**
	 * `live-processor.ts` sets PROVISIONING before the step loop and `CREATE_ENCODING`
	 * writes the id mid-loop, so every routine bring-up has a non-terminal encoding on
	 * a row that is not yet stoppable. Reporting that as CONTRADICTED fired the
	 * loudest line in the tool during the most ordinary live operation — which is how
	 * an operator learns to skip it, and then it is gone when it matters (review
	 * catch). Widening the status filter to QUEUED/CREATED made this fire from the
	 * instant the encoding is created, so the two fixes interact.
	 */
	it("puts a PROVISIONING channel's own encoding in inFlight, not contradicted", () => {
		const report = orphanLiveEncodings(
			[enc("mine", { status: "QUEUED" })],
			known([["mine", "PROVISIONING"]]),
			NOW,
		);
		expect(report.contradicted).toEqual([]);
		expect(report.inFlight.map((e) => e.id)).toEqual(["mine"]);
		expect(report.inFlight[0]?.channelStatus).toBe("PROVISIONING");
	});

	it("still calls a STOPPED row's encoding contradicted — that IS #48", () => {
		const report = orphanLiveEncodings(
			[enc("theirs")],
			known([["theirs", "STOPPED"]]),
			NOW,
		);
		expect(report.inFlight).toEqual([]);
		expect(report.contradicted.map((c) => c.id)).toEqual(["theirs"]);
	});

	it("partitions every running encoding exactly once", () => {
		// The arithmetic an operator reads has to close.
		const report = orphanLiveEncodings(
			[enc("a"), enc("b"), enc("c"), enc("d")],
			known(
				[["a", "RUNNING"]],
				[
					["b", "STOPPED"],
					["c", "PROVISIONING"],
				],
			),
			NOW,
		);
		expect(
			report.accountedFor.total +
				report.contradicted.length +
				report.inFlight.length +
				report.orphans.length,
		).toBe(report.running);
	});
});
