import { describe, expect, it } from "vitest";
import type { RunReport, ScenarioOutcome } from "./runner";
import { formatRunReport } from "./runner";

/**
 * A PASS is not a quantity, and the report has to say so.
 *
 * Every "green over a population it could not reach" defect in this harness's history had the
 * same shape: a verdict of PASS backed by a handful of checks and a pile of SKIPs. The word
 * PASS is identical either way, so the report ranks the greens by how little they verified.
 *
 * The interesting case is a green whose check counts are ALL ZERO — nothing evaluated and
 * nothing skipped. `0 / 0` is NaN, a NaN comparator leaves the array in whatever order it was
 * already in, and the most worthless green in the run then lands wherever chance put it: the
 * exact failure mode this section exists to expose, hiding inside the tool built to expose it.
 *
 * Worth recording how this test was wrong first. It led with `0 evaluated / 12 skipped` and
 * claimed that divides "into NaN" — it does not, `12 / 0` is `Infinity`, which already sorts
 * first and already prints as ∞. So a mutation to plain `skipped / evaluated` survived, and the
 * test was pinning a property the code did not need to provide. The all-zero case below is the
 * one that actually fails without the guard.
 */

const base: Omit<RunReport, "outcomes" | "counts"> = {
	runId: "T",
	startedAt: "2026-08-10T00:00:00Z",
	finishedAt: "2026-08-10T01:00:00Z",
	fingerprint: {
		commit: "test",
		checkoutLatestMigration: "m",
		dbLatestMigration: "m",
		drift: false,
	},
	preflight: {} as RunReport["preflight"],
};

function reportOf(outcomes: ScenarioOutcome[]): RunReport {
	const counts = { PASS: 0, WARN: 0, FAIL: 0, SKIP: 0, INVALID: 0 };
	for (const o of outcomes) {
		counts[o.verdict]++;
	}
	return { ...base, outcomes, counts };
}

const checks = (PASS: number, SKIP: number, WARN = 0, FAIL = 0) => ({
	PASS,
	WARN,
	FAIL,
	SKIP,
});

describe("formatRunReport — greens ranked by how little they verified", () => {
	it("sorts a green with ALL-ZERO check counts first, instead of NaN-ordering it", () => {
		/**
		 * The case that needs the guard: `0 / 0`. Without it the comparator returns NaN for this
		 * row, the sort leaves it where it started, and it is listed here as the LAST element —
		 * so the assertion is that it comes first, from a starting position that is last.
		 */
		const md = formatRunReport(
			reportOf([
				{
					scenario: "thorough",
					verdict: "PASS",
					reason: "ok",
					checks: checks(34, 0),
				},
				{
					scenario: "thin",
					verdict: "PASS",
					reason: "ok",
					checks: checks(2, 30),
				},
				{
					scenario: "measured-nothing-at-all",
					verdict: "PASS",
					reason: "ok",
					checks: checks(0, 0),
				},
			]),
		);
		const section = md.slice(md.indexOf("## Greens that verified the least"));
		expect(section).not.toContain("NaN");
		expect(section).toContain("∞ (nothing evaluated)");
		expect(
			section.indexOf("measured-nothing-at-all"),
			"the green that measured nothing must be the first thing the reader sees",
		).toBeLessThan(section.indexOf("thin"));
	});

	it("sorts a green that evaluated NOTHING but skipped plenty above the rest", () => {
		const md = formatRunReport(
			reportOf([
				{
					scenario: "thorough",
					verdict: "PASS",
					reason: "ok",
					checks: checks(34, 0),
				},
				{
					scenario: "verified-nothing",
					verdict: "PASS",
					reason: "ok",
					checks: checks(0, 12),
				},
				{
					scenario: "thin",
					verdict: "PASS",
					reason: "ok",
					checks: checks(2, 30),
				},
			]),
		);
		const section = md.slice(md.indexOf("## Greens that verified the least"));
		const order = ["verified-nothing", "thin", "thorough"].map((n) =>
			section.indexOf(n),
		);
		expect(
			order.every((i) => i >= 0),
			"all three listed",
		).toBe(true);
		expect(order[0]).toBeLessThan(order[1] as number);
		expect(order[1]).toBeLessThan(order[2] as number);
		// And it must say why, not print NaN at the reader.
		expect(section).toContain("∞ (nothing evaluated)");
		expect(section).not.toContain("NaN");
	});

	it("ranks by ratio, not by raw skip count", () => {
		/**
		 * The big scenario skipped more checks in absolute terms but verified 40 of them; the
		 * small one verified 1. Ranking by skip count would put the healthy scenario on top and
		 * bury the one that needs attention.
		 */
		const md = formatRunReport(
			reportOf([
				{
					scenario: "big-mostly-verified",
					verdict: "PASS",
					reason: "ok",
					checks: checks(40, 20),
				},
				{
					scenario: "small-barely-verified",
					verdict: "PASS",
					reason: "ok",
					checks: checks(1, 9),
				},
			]),
		);
		const section = md.slice(md.indexOf("## Greens that verified the least"));
		expect(section.indexOf("small-barely-verified")).toBeLessThan(
			section.indexOf("big-mostly-verified"),
		);
	});

	it("ranks WARN alongside PASS — a warned scenario is still reported as non-failing", () => {
		const md = formatRunReport(
			reportOf([
				{
					scenario: "warned",
					verdict: "WARN",
					reason: "hm",
					checks: checks(1, 20, 1),
				},
			]),
		);
		expect(md).toContain("warned");
		expect(md.slice(md.indexOf("## Greens"))).toContain("warned");
	});

	it("never ranks a FAIL, a SKIP or an INVALID — they are not greens", () => {
		const md = formatRunReport(
			reportOf([
				{
					scenario: "failed-scenario",
					verdict: "FAIL",
					reason: "no",
					checks: checks(0, 40, 0, 3),
				},
				{
					scenario: "skipped-scenario",
					verdict: "SKIP",
					reason: "needs a credential",
				},
				{
					scenario: "harness-broke",
					verdict: "INVALID",
					reason: "timed out",
				},
			]),
		);
		// They appear in the main table; they must not appear in the greens ranking.
		expect(md).toContain("failed-scenario");
		expect(md.includes("## Greens that verified the least")).toBe(false);
	});

	it("omits the section entirely when no green carries check counts", () => {
		// A dry run has no checks; a section of nothing would imply the question was asked
		// and answered well.
		const md = formatRunReport(
			reportOf([{ scenario: "dry", verdict: "PASS", reason: "dry run" }]),
		);
		expect(md).not.toContain("## Greens that verified the least");
	});

	it("caps the list, so one bad run cannot bury the counts under 70 rows", () => {
		const many = Array.from({ length: 30 }, (_, i) => ({
			scenario: `s${i}`,
			verdict: "PASS" as const,
			reason: "ok",
			checks: checks(1, 30 - i),
		}));
		const md = formatRunReport(reportOf(many));
		const section = md.slice(md.indexOf("## Greens that verified the least"));
		const rows = section
			.split("\n")
			.filter((l) => /^\| s\d+ \|/.test(l)).length;
		expect(rows).toBe(10);
	});
});

describe("formatRunReport — which wizard path was used", () => {
	/**
	 * "Verified" means something different depending on the path: the FORM path exercises
	 * `buildPlan` (fill in the wizard), the IMPORT path exercises `buildSubmissionPlan` (paste a
	 * plan). Both are real product paths, and a report that does not distinguish them lets the
	 * reader assume the first when it was the second — which is the whole reason the corpus was
	 * routed through the wizard in the first place.
	 */
	it("lists the import-path scenarios and names the field the form cannot author", () => {
		const md = formatRunReport(
			reportOf([
				{
					scenario: "fixed-bitrate-hls-on-aws",
					verdict: "PASS",
					reason: "ok",
					submittedVia: "wizard-form",
				},
				{
					scenario: "gcs-service-account-io",
					verdict: "SKIP",
					reason: "blocked by GCS_SERVICE_ACCOUNT",
					submittedVia: "wizard-import",
					wizardDivergence:
						'inputs.0.region: fixture "EUROPE_WEST_1" vs wizard undefined',
				},
			]),
		);
		const section = md.slice(
			md.indexOf("## Submitted through the wizard's IMPORT"),
		);
		expect(section).toContain("gcs-service-account-io");
		expect(section).toContain("inputs.0.region");
		// The form-path scenario must NOT be listed — 65 identical rows would bury the
		// exceptions this section exists to surface.
		expect(section).not.toContain("fixed-bitrate-hls-on-aws");
	});

	it("omits the section when every scenario used the form", () => {
		const md = formatRunReport(
			reportOf([
				{
					scenario: "a",
					verdict: "PASS",
					reason: "ok",
					submittedVia: "wizard-form",
				},
			]),
		);
		expect(md).not.toContain("## Submitted through the wizard's IMPORT");
	});
});
