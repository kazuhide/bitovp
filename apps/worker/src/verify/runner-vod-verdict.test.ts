import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { LiveEvidenceLeg } from "@bitovp/core";
import { describe, expect, it } from "vitest";
import type { VerificationReport } from "./engine";
import {
	outcomeFromLiveResult,
	vodOutcomeForReport,
	vodVerdictForCounts,
} from "./runner";

/**
 * The VOD corpus arm's counts → verdict rule, and the zero-PASS floor it lacked.
 *
 * The live arm (`outcomeFromLiveResult`) and the single-job CLI (`exitCodeFor`)
 * both refuse to call a report green when nothing in it PASSed — design §5. The
 * VOD corpus arm, the one the nightly actually runs, applied neither: it read
 * FAIL and WARN, and anything that was neither fell through to PASS.
 *
 * So a scenario whose every check SKIPped scored PASS. The top-level exit sums
 * FAIL and INVALID only, so the process exited 0 and `verify-nightly.sh` printed
 * "all scenarios green" over a corpus that had verified nothing — the failure
 * mode where the instrument reports on a population it never reached.
 *
 * It was untestable where it lived: inside `runVerification`, past a real
 * encoding. It is a pure function now, for the same reason the live arm is.
 */

const reportOf = (counts: {
	PASS: number;
	WARN: number;
	FAIL: number;
	SKIP: number;
}): VerificationReport =>
	({
		checks: [],
		counts,
		failed: counts.FAIL,
	}) as unknown as VerificationReport;

/** These tests isolate report floors; satisfy the independent EV-02 gate. */
const completeEvidence = [
	{
		version: 1,
		outputLeg: "hls@origin",
		role: "ORIGIN",
		kind: "HLS",
		complete: true,
		missing: [],
		children: [],
		probes: [],
		progression: { detail: "complete fixture" },
	},
] as unknown as LiveEvidenceLeg[];

describe("Live archive-only completeness floor", () => {
	function outcome(archiveVerdicts: ("PASS" | "SKIP" | "WARN" | "FAIL")[]) {
		const report = reportOf({
			PASS: 8,
			WARN: archiveVerdicts.filter((v) => v === "WARN").length,
			FAIL: archiveVerdicts.filter((v) => v === "FAIL").length,
			SKIP: 2 + archiveVerdicts.filter((v) => v === "SKIP").length,
		});
		(report as { checks: unknown[] }).checks = [
			{ id: "live:manifest:hls", verdict: "PASS" },
			{ id: "live:heartbeat", verdict: "SKIP" },
			...archiveVerdicts.map((verdict, index) => ({
				id: `live:archive:archive:storage-${index}`,
				verdict,
				detail: "archive evidence",
			})),
		];
		return outcomeFromLiveResult(
			{ report, evidence: completeEvidence },
			{ scenario: "live-archive" },
			"live-archive",
		);
	}
	it.each([
		["SKIP"],
		["PASS", "SKIP"],
		["WARN"],
	] as const)("refuses whole-run PASS when archive legs are %j", (...verdicts) => {
		const out = outcome([...verdicts]);
		expect(out.verdict).toBe("INVALID");
		expect(out.reason).toContain("MP4 archive evidence is UNVERIFIED");
	});
	it("keeps product FAIL stronger than an unverified archive", () => {
		expect(outcome(["FAIL", "SKIP"]).verdict).toBe("FAIL");
	});
	it("leaves other SKIPs unchanged when no archive is required or every archive is proven", () => {
		expect(outcome([]).verdict).toBe("PASS");
		expect(outcome(["PASS", "PASS"]).verdict).toBe("PASS");
	});
});

describe("vodVerdictForCounts", () => {
	it("a report where NOTHING passed is INVALID, not PASS", () => {
		// The regression, stated at its smallest: every check SKIPped. Before the
		// floor this returned PASS and the run exited 0.
		expect(vodVerdictForCounts({ PASS: 0, WARN: 0, FAIL: 0 })).toBe("INVALID");
	});

	it("zero-PASS outranks a FAIL count — a report that verified nothing is ours, not the encoder's", () => {
		// Matches `exitCodeFor`, which reports `invalid` on a zero-PASS report
		// whatever its failures say: FAIL is a product defect, INVALID is a
		// harness or credential problem, and the two must not be confused.
		expect(vodVerdictForCounts({ PASS: 0, WARN: 0, FAIL: 3 })).toBe("INVALID");
	});

	it("still grades a report that actually verified something", () => {
		expect(vodVerdictForCounts({ PASS: 12, WARN: 0, FAIL: 0 })).toBe("PASS");
		expect(vodVerdictForCounts({ PASS: 12, WARN: 2, FAIL: 0 })).toBe("WARN");
		expect(vodVerdictForCounts({ PASS: 12, WARN: 2, FAIL: 1 })).toBe("FAIL");
		// One PASS is enough to clear the floor — the rule is "verified nothing",
		// not "verified little" (that ranking is the report's separate job).
		expect(vodVerdictForCounts({ PASS: 1, WARN: 0, FAIL: 0 })).toBe("PASS");
	});

	it("agrees with the LIVE arm on the zero-PASS case — one rule, both corpora", () => {
		/**
		 * The pin on the thing that actually went wrong: not the rule, but the
		 * fact that only one of two sibling arms had it. If either side's floor
		 * is removed or drifts, these two stop agreeing.
		 */
		const counts = { PASS: 0, WARN: 0, FAIL: 0, SKIP: 9 };
		const live = outcomeFromLiveResult(
			{ report: reportOf(counts) },
			{ scenario: "live-rtmp-simple" },
			"live-rtmp-simple",
		);
		expect(live.verdict).toBe("INVALID");
		expect(vodVerdictForCounts(counts)).toBe(live.verdict);
	});
});

describe("vodOutcomeForReport", () => {
	it("carries the INVALID reason, not just the verdict", () => {
		const out = vodOutcomeForReport(
			reportOf({ PASS: 0, WARN: 0, FAIL: 0, SKIP: 9 }),
			"vmaf-only-h264",
		);
		expect(out.verdict).toBe("INVALID");
		expect(out.reason).toBe(
			"no check PASSed for vmaf-only-h264 — this report verified nothing, which is not a pass",
		);
	});

	it("names the failing checks on FAIL and the pass count otherwise", () => {
		const failing = reportOf({ PASS: 3, WARN: 0, FAIL: 1, SKIP: 0 });
		(failing as { checks: unknown[] }).checks = [
			{ id: "audio.codec", verdict: "FAIL", detail: "expected aac" },
		];
		expect(vodOutcomeForReport(failing, "x")).toEqual({
			verdict: "FAIL",
			reason: "audio.codec: expected aac",
		});
		expect(
			vodOutcomeForReport(
				reportOf({ PASS: 7, WARN: 0, FAIL: 0, SKIP: 2 }),
				"x",
			),
		).toEqual({ verdict: "PASS", reason: "7 check(s) passed" });
	});

	it("never promotes an explicitly UNVERIFIED per-title population to release PASS", () => {
		const report = reportOf({ PASS: 24, WARN: 0, FAIL: 0, SKIP: 1 });
		(report as { checks: unknown[] }).checks = [
			{ id: "muxing:audio", verdict: "PASS", detail: "checked" },
			{
				id: "pertitle:population",
				verdict: "SKIP",
				detail: "UNVERIFIED per-title RESULT population: legacy snapshot",
			},
		];

		expect(vodOutcomeForReport(report, "pertitle-h264")).toEqual({
			verdict: "INVALID",
			reason:
				"per-title evidence is UNVERIFIED for pertitle-h264 — pertitle:population: UNVERIFIED per-title RESULT population: legacy snapshot",
		});
	});

	it("keeps a product FAIL stronger than an UNVERIFIED per-title population", () => {
		const report = reportOf({ PASS: 24, WARN: 0, FAIL: 1, SKIP: 1 });
		(report as { checks: unknown[] }).checks = [
			{ id: "muxing:audio", verdict: "FAIL", detail: "missing segment" },
			{
				id: "pertitle:population",
				verdict: "SKIP",
				detail: "UNVERIFIED per-title RESULT population: legacy snapshot",
			},
		];

		expect(vodOutcomeForReport(report, "pertitle-h264")).toEqual({
			verdict: "FAIL",
			reason: "muxing:audio: missing segment",
		});
	});

	it("is WIRED into the corpus arm — the fix's only call site", () => {
		/**
		 * The finding this test exists for (review-298 F1, mutation-confirmed by
		 * two reviewers independently): everything above pins the RULE, and the
		 * rule was never where the bug lived. `runVerification` is invoked by
		 * ZERO tests — it needs a real encoding to reach — so reverting its one
		 * call site to the pre-fix inline ternary re-introduced the entire defect
		 * with the full worker suite green, 75 files / 1190 tests.
		 *
		 * So the wiring is pinned the way this repo pins other unreachable
		 * contracts (executor-cases.json, ledger-references): against the source.
		 * POSITIVE and exact — asserting the absence of some other shape would be
		 * a broad matcher, and a matcher broad enough to catch the old ternary is
		 * broad enough to catch its replacement.
		 */
		const source = readFileSync(join(__dirname, "runner.ts"), "utf8");
		expect(source).toContain(
			"...vodOutcomeForReport(verified.report, s.name),",
		);
	});
});

/**
 * AKR-E57-007, RUNTIME-VERIFIED before this floor existed: an MSL4 TS run
 * reported 8 PASS / 11 SKIP and the scenario read PASS, while a manual closure
 * against the Staging edge found 116 of 116 segments returning 404.
 *
 * The zero-PASS floor could not reach it. An MSL channel's provisioning and
 * heartbeat checks pass HONESTLY; it is the delivery checks that skip, because
 * `AKAMAI_MSL` is Akamai's ingest and no driver can read its origin back. So
 * the report had passes, no failures, and had looked at no delivered byte.
 */
describe("a live run that observed no delivery is not a pass", () => {
	const withChecks = (
		counts: { PASS: number; WARN: number; FAIL: number; SKIP: number },
		checks: { id: string; verdict: string; detail?: string }[],
	): VerificationReport =>
		({ checks, counts, failed: counts.FAIL }) as unknown as VerificationReport;

	const manifestSkips = [
		{ id: "live:manifest:hls", verdict: "SKIP" },
		{ id: "live:manifest:dash", verdict: "SKIP" },
	];

	/**
	 * The INCIDENT's own shape: exactly ONE manifest check, and it SKIPped.
	 *
	 * `live-akamai-msl-ts.expected-live.json` declares a single manifest
	 * (`hls`), so the run that came back 8 PASS / 11 SKIP beside 116/116
	 * segments 404 carried ONE `live:manifest:*` check. The first cut of this
	 * arm used the two-manifest report below under the `live-akamai-msl-ts`
	 * name — a shape that fixture cannot produce — which left the scope guard
	 * unpinned: mutating `manifestChecks.length > 0` to `> 1` passed all 398
	 * worker tests (review of this PR, finding 1). Reproduced before fixing.
	 *
	 * The two-manifest report keeps its own arm below, under
	 * `live-akamai-msl`, which does declare hls + dash.
	 */
	it("INVALID on the incident's own shape — ONE manifest check, skipped", () => {
		const out = outcomeFromLiveResult(
			{
				report: withChecks({ PASS: 8, WARN: 0, FAIL: 0, SKIP: 11 }, [
					{ id: "live:readable", verdict: "PASS" },
					{ id: "live:manifest:hls", verdict: "SKIP" },
				]),
			},
			{ scenario: "live-akamai-msl-ts" },
			"live-akamai-msl-ts",
		);
		expect(out.verdict).toBe("INVALID");
		expect(out.reason).toMatch(/no manifest was verified/);
	});

	it("INVALID when every manifest check skipped, however many others passed", () => {
		const out = outcomeFromLiveResult(
			{
				report: withChecks({ PASS: 8, WARN: 0, FAIL: 0, SKIP: 11 }, [
					{ id: "live:readable", verdict: "PASS" },
					...manifestSkips,
				]),
			},
			// hls + dash: the shape `live-akamai-msl` declares.
			{ scenario: "live-akamai-msl" },
			"live-akamai-msl",
		);
		expect(out.verdict).toBe("INVALID");
		// INVALID, not FAIL: the product may be fine — what is not fine is
		// calling it verified. The reason has to say which.
		expect(out.reason).toMatch(/no manifest was verified/);
		expect(out.reason).toMatch(
			/says nothing about whether anything was delivered/,
		);
	});

	it("PASSes when at least one manifest WAS verified", () => {
		// The accept arm. Without it, a floor that refused every live scenario
		// would satisfy the assertion above.
		const out = outcomeFromLiveResult(
			{
				report: withChecks({ PASS: 8, WARN: 0, FAIL: 0, SKIP: 10 }, [
					{ id: "live:readable", verdict: "PASS" },
					{ id: "live:manifest:hls", verdict: "PASS" },
					{ id: "live:manifest:dash", verdict: "SKIP" },
				]),
				evidence: completeEvidence,
			},
			{ scenario: "live-rtmp-simple" },
			"live-rtmp-simple",
		);
		expect(out.verdict).toBe("PASS");
	});

	it("leaves a report with NO manifest checks to the other floors", () => {
		// Scoped deliberately: this rule is about delivery checks that ran and
		// skipped, not about a report shaped differently. A report with no
		// manifest checks at all is the zero-PASS floor's business, or nobody's.
		const out = outcomeFromLiveResult(
			{
				report: withChecks({ PASS: 3, WARN: 0, FAIL: 0, SKIP: 0 }, [
					{ id: "live:readable", verdict: "PASS" },
				]),
				evidence: completeEvidence,
			},
			{ scenario: "live-rtmp-simple" },
			"live-rtmp-simple",
		);
		expect(out.verdict).toBe("PASS");
	});

	it("still FAILs when a manifest check failed — FAIL outranks unverified", () => {
		const out = outcomeFromLiveResult(
			{
				report: withChecks({ PASS: 8, WARN: 0, FAIL: 1, SKIP: 10 }, [
					{ id: "live:manifest:hls", verdict: "FAIL", detail: "404" },
					{ id: "live:manifest:dash", verdict: "SKIP" },
				]),
			},
			{ scenario: "live-akamai-msl" },
			"live-akamai-msl",
		);
		expect(out.verdict).toBe("FAIL");
	});
});

/**
 * The PARTIALLY-blind mirror topology the manifest floor above could not see
 * (audit 602ec286 BLOCKER-3, ; the deferred item, row 187(b)).
 *
 * An origin + MSL-mirror plan writes every destination to BOTH a readable
 * origin and an AKAMAI_MSL mirror. The origin's own manifests PASS, and the
 * mirror output is not in `expected.manifests` at all — so the manifest floor
 * passes on the origin alone while nothing looks at the mirror. The incident
 * that named this found the origin green and 116/116 segments 404 on the edge.
 */
describe("an origin + MSL-mirror run must not pass on the origin alone", () => {
	const withChecks = (
		counts: { PASS: number; WARN: number; FAIL: number; SKIP: number },
		checks: { id: string; verdict: string; detail?: string }[],
	): VerificationReport =>
		({ checks, counts, failed: counts.FAIL }) as unknown as VerificationReport;

	it("INVALID when the origin PASSed but the mirror leg is UNOBSERVED", () => {
		// The exact shape of live-akamai-msl-storage: origin (GENERIC_S3) HLS
		// manifest PASSes, and each mirror leg SKIPs because no edge base URL was
		// available to read it back.
		const out = outcomeFromLiveResult(
			{
				report: withChecks({ PASS: 9, WARN: 0, FAIL: 0, SKIP: 3 }, [
					{ id: "live:readable", verdict: "PASS" },
					{ id: "live:manifest:hls", verdict: "PASS" },
					{ id: "live:manifest:dash", verdict: "PASS" },
					{ id: "live:mirror:hls:mirror-1", verdict: "SKIP" },
					{ id: "live:mirror:dash:mirror-1", verdict: "SKIP" },
				]),
			},
			{ scenario: "live-akamai-msl-storage" },
			"live-akamai-msl-storage",
		);
		expect(out.verdict).toBe("INVALID");
		expect(out.reason).toMatch(/delivery-mirror leg was not observed/);
		expect(out.reason).toMatch(/origin PASS says nothing/);
	});

	it("PASSes only when EVERY mirror leg was observed on the edge", () => {
		// The accept arm. Without it, a floor that refused every mirror scenario
		// would satisfy the assertion above.
		const out = outcomeFromLiveResult(
			{
				report: withChecks({ PASS: 11, WARN: 0, FAIL: 0, SKIP: 1 }, [
					{ id: "live:manifest:hls", verdict: "PASS" },
					{ id: "live:mirror:hls:mirror-1", verdict: "PASS" },
					{ id: "live:mirror:dash:mirror-1", verdict: "PASS" },
				]),
				evidence: completeEvidence,
			},
			{ scenario: "live-akamai-msl-storage" },
			"live-akamai-msl-storage",
		);
		expect(out.verdict).toBe("PASS");
	});

	it("INVALID even when SOME mirror legs passed but one did not", () => {
		// Each leg is judged individually: one observed, one not, is still a run
		// that says nothing about the unobserved leg.
		const out = outcomeFromLiveResult(
			{
				report: withChecks({ PASS: 10, WARN: 0, FAIL: 0, SKIP: 1 }, [
					{ id: "live:manifest:hls", verdict: "PASS" },
					{ id: "live:mirror:hls:mirror-1", verdict: "PASS" },
					{ id: "live:mirror:dash:mirror-1", verdict: "SKIP" },
				]),
			},
			{ scenario: "live-akamai-msl-storage" },
			"live-akamai-msl-storage",
		);
		expect(out.verdict).toBe("INVALID");
	});

	it("still FAILs when a mirror leg FAILED — FAIL outranks unverified", () => {
		// A mirror the edge read and found empty is a product FAIL, not INVALID:
		// FAIL says more than "unverified", so it must not be laundered by the
		// mirror floor (the same ordering the manifest floor keeps).
		const out = outcomeFromLiveResult(
			{
				report: withChecks({ PASS: 9, WARN: 0, FAIL: 1, SKIP: 1 }, [
					{ id: "live:manifest:hls", verdict: "PASS" },
					{
						id: "live:mirror:hls:mirror-1",
						verdict: "FAIL",
						detail: "116/116 segments 404 on the edge",
					},
					{ id: "live:mirror:dash:mirror-1", verdict: "PASS" },
				]),
			},
			{ scenario: "live-akamai-msl-storage" },
			"live-akamai-msl-storage",
		);
		expect(out.verdict).toBe("FAIL");
	});

	it("leaves a report with NO mirror checks to the other floors", () => {
		// Scoped deliberately: a plain (non-mirror) report has no live:mirror:*
		// checks, so this floor never fires and the run passes on its manifests.
		const out = outcomeFromLiveResult(
			{
				report: withChecks({ PASS: 8, WARN: 0, FAIL: 0, SKIP: 2 }, [
					{ id: "live:manifest:hls", verdict: "PASS" },
				]),
				evidence: completeEvidence,
			},
			{ scenario: "live-rtmp-simple" },
			"live-rtmp-simple",
		);
		expect(out.verdict).toBe("PASS");
	});
});
