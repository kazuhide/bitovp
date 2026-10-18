import { beforeAll, describe, expect, it } from "vitest";
import { appendCheck, ReportBuilder } from "./engine";

/**
 * The exit code must move when a verdict moves.
 *
 * `verify job` returns `report.failed` as its PROCESS exit code, and `build` used to
 * snapshot `failed: counts.FAIL`. Callers that appended a check afterwards — the
 * truncated-listing FAIL, the unbrowsable SKIPs — bumped `counts.FAIL` directly, so the
 * printed summary said `FAIL 1` while the process exited 0 and the nightly job read it
 * as green. A reviewer measured exactly that: `failed=0 counts.FAIL=1`.
 *
 * Worth pinning rather than just fixing, because the bug was invisible in every place a
 * human looks: the report's own text was correct.
 */
/**
 * Load `./job`'s module graph ONCE, before any describe runs.
 *
 * Nine cases across three describes each did `await import("./job")` inline.
 * Import is cached, so only the FIRST pays — but under a full parallel suite
 * that first load crossed vitest's 5s default and turned this file red at
 * 5089ms while passing in isolation (measured in review of an unrelated PR).
 * Hoisting it into one describe was not enough: whichever describe runs first
 * pays, and vitest does not promise an order. A gate that is periodically red
 * on a file nobody touched is how a REAL failure eventually gets waved through
 * as "just the flaky one" — and here the local gate IS the merge gate.
 */
beforeAll(async () => {
	await import("./job");
}, 30_000);

describe("appendCheck", () => {
	function report() {
		const b = new ReportBuilder();
		b.pass("a:one", "muxing", "fine");
		return b.build("p");
	}

	it("moves `failed` when a FAIL is appended after build()", () => {
		const r = report();
		expect(r.failed).toBe(0);
		appendCheck(r, {
			id: "hygiene:listing-truncated",
			area: "hygiene",
			verdict: "FAIL",
			detail: "listing stopped at its bound",
		});
		expect(r.counts.FAIL, "the summary count").toBe(1);
		expect(r.failed, "the number `verify job` returns as its exit code").toBe(
			1,
		);
	});

	it("keeps the other counts in step too", () => {
		const r = report();
		appendCheck(r, {
			id: "hygiene:unbrowsable-output",
			area: "hygiene",
			verdict: "SKIP",
			detail: "SFTP",
		});
		appendCheck(r, {
			id: "note",
			area: "hygiene",
			verdict: "WARN",
			detail: "n",
		});
		expect(r.counts).toEqual({ PASS: 1, WARN: 1, FAIL: 0, SKIP: 1 });
		expect(r.checks.length).toBe(3);
		expect(r.failed).toBe(0);
	});

	it("`failed` tracks `counts.FAIL` however the count was reached", () => {
		// A getter, not a snapshot — so a future caller that mutates counts directly is
		// still consistent, rather than silently detaching the exit code from the report.
		const r = report();
		r.counts.FAIL = 7;
		expect(r.failed).toBe(7);
	});
});

/**
 * `addHygieneChecks` — the post-run assembly, and where the exit-code bug lived.
 *
 * It was inline in `verifyJob`, which needs a database, credentials and a bucket, so
 * nothing could reach it: a reviewer mutated it five ways — never pushing the truncation
 * check, downgrading it to WARN, deleting the zero-PASS guard — and every one survived.
 */
describe("addHygieneChecks", () => {
	/** Bound once; the graph itself is warmed by the file-level hook above. */
	let addHygieneChecks: typeof import("./job")["addHygieneChecks"];
	beforeAll(async () => {
		({ addHygieneChecks } = await import("./job"));
	}, 30_000);

	function base() {
		const b = new ReportBuilder();
		b.pass("a:one", "muxing", "fine");
		return b.build("p");
	}

	it("makes a truncated listing FAIL, and moves the exit code with it", async () => {
		const r = base();
		addHygieneChecks(r, {
			truncations: ["origin:out/video/"],
			unbrowsable: [],
			notes: [],
		});
		const check = r.checks.find((c) => c.id === "hygiene:listing-truncated");
		expect(check?.verdict, "design §8: not a WARN").toBe("FAIL");
		expect(check?.detail).toMatch(/NOT examined/);
		expect(r.failed, "the process exit code").toBe(1);
	});

	it("emits nothing when the listing was complete", async () => {
		const r = base();
		addHygieneChecks(r, { truncations: [], unbrowsable: [], notes: [] });
		expect(r.checks.map((c) => c.id)).toEqual(["a:one"]);
		expect(r.failed).toBe(0);
	});

	it("records an unbrowsable location and a note as named SKIPs", async () => {
		const r = base();
		addHygieneChecks(r, {
			truncations: [],
			unbrowsable: [
				"output is a SFTP location, which has no browsable container",
			],
			notes: ["muxing x references stream y"],
		});
		expect(r.counts.SKIP).toBe(2);
		expect(r.failed, "a SKIP is not a failure").toBe(0);
		// Never an empty reason — design §3 requires every SKIP to name what would open it.
		for (const c of r.checks.filter((x) => x.verdict === "SKIP")) {
			expect(c.detail.trim()).not.toBe("");
		}
	});
});

/**
 * `exitCodeFor` — the CLI's entire contract with the nightly job.
 *
 * It was four lines inside `main`, which needs a database and credentials, so the
 * mutation deleting the zero-PASS guard survived the suite. An exit code should not be
 * the least reachable line in the file.
 */
describe("exitCodeFor", () => {
	function report(counts: Partial<Record<string, number>>) {
		const b = new ReportBuilder();
		for (let i = 0; i < (counts.PASS ?? 0); i++) {
			b.pass(`p${i}`, "muxing", "ok");
		}
		for (let i = 0; i < (counts.FAIL ?? 0); i++) {
			b.fail(`f${i}`, "muxing", "bad");
		}
		for (let i = 0; i < (counts.SKIP ?? 0); i++) {
			b.skip(`s${i}`, "drm", "no init segment");
		}
		return b.build("p");
	}

	it("exits 0 on a genuinely green report", async () => {
		const { exitCodeFor } = await import("./job");
		expect(exitCodeFor(report({ PASS: 12 }))).toEqual({ code: 0 });
	});

	it("exits on the FAIL count", async () => {
		const { exitCodeFor } = await import("./job");
		expect(exitCodeFor(report({ PASS: 10, FAIL: 3 })).code).toBe(3);
	});

	it("refuses to call a report with ZERO passes green", async () => {
		// Every DRM row SKIPping, or an output that could not be opened at all. There is
		// nothing to fail and nothing was verified — design §5 calls that INVALID.
		const { exitCodeFor } = await import("./job");
		const out = exitCodeFor(report({ SKIP: 8 }));
		expect(out.code, "must not be 0").toBe(1);
		expect(out.invalid).toMatch(/verified nothing/);
	});

	it("keeps a larger FAIL count when there are also no passes", async () => {
		const { exitCodeFor } = await import("./job");
		expect(exitCodeFor(report({ FAIL: 4 })).code).toBe(4);
	});

	it("exits non-zero when per-title evidence is explicitly UNVERIFIED despite other PASSes", async () => {
		const { exitCodeFor } = await import("./job");
		const r = report({ PASS: 20 });
		appendCheck(r, {
			id: "qc:pertitle:unit:fixed:result-a",
			area: "qc",
			verdict: "SKIP",
			detail: "UNVERIFIED: no provider output id is recorded for the QC output",
		});

		expect(exitCodeFor(r)).toEqual({
			code: 1,
			invalid:
				"per-title evidence is UNVERIFIED — qc:pertitle:unit:fixed:result-a: UNVERIFIED: no provider output id is recorded for the QC output",
		});
	});
});

describe("a PASS built mostly on SKIPs", () => {
	function report(counts: { PASS?: number; FAIL?: number; SKIP?: number }) {
		const b = new ReportBuilder();
		for (let i = 0; i < (counts.PASS ?? 0); i++) {
			b.pass(`p${i}`, "muxing", "ok");
		}
		for (let i = 0; i < (counts.FAIL ?? 0); i++) {
			b.fail(`f${i}`, "muxing", "bad");
		}
		for (let i = 0; i < (counts.SKIP ?? 0); i++) {
			b.skip(`s${i}`, "drm", "no init segment");
		}
		return b.build("p");
	}

	it("is flagged — the shape that survives every other floor", async () => {
		/**
		 * The zero-PASS rule catches a report that verified NOTHING. It says nothing about
		 * one that verified 3 things and skipped 12, and none of the other floors fire when
		 * SOME checks evaluated. A reviewer named this as the most likely remaining place for
		 * a false green once real artefacts started arriving.
		 */
		const { exitCodeFor } = await import("./job");
		const out = exitCodeFor(report({ PASS: 3, SKIP: 12 }));
		expect(out.invalid).toMatch(/mostly absences/);
		// Not a FAIL: a capability-limited run has real SKIPs, and failing those would be
		// the false-red mistake this project keeps making.
		expect(out.code).toBe(0);
	});

	it("is not flagged when the balance is reasonable", async () => {
		const { exitCodeFor } = await import("./job");
		expect(exitCodeFor(report({ PASS: 20, SKIP: 8 })).invalid).toBeUndefined();
	});

	it("still reports zero-PASS as verifying nothing, which is the stronger claim", async () => {
		const { exitCodeFor } = await import("./job");
		expect(exitCodeFor(report({ SKIP: 30 })).invalid).toMatch(
			/verified nothing/,
		);
	});
});
