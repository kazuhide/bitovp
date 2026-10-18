import type { LiveEvidenceLeg } from "@bitovp/core";
import { describe, expect, it } from "vitest";
import type { RunReport, ScenarioOutcome } from "./runner";
import { formatRunReport, outcomeFromLiveResult } from "./runner";

/**
 * The origin's publish latency, measured and printed rather than assumed.
 *
 * `MIN_SAMPLE_GAP_SEC = 10` in engine-live.ts decides whether the live movement checks can mean
 * anything: two samples closer than the origin's own publish cadence show no movement on a
 * perfectly healthy channel. It was a reasoned guess, and a reviewer's ask was the right one —
 * make it a measurement.
 *
 * Two properties matter here and neither is about the number itself:
 *
 *   nothing branches on it. A slow origin must not become a FAIL, and a fast one must not
 *   excuse a check. It is an observation the report carries.
 *
 *   "not observed" and "0s" are different facts. A cap expiring with no segment means the
 *   latency is UNKNOWN; reporting the cap as the measurement would invent data, and reporting
 *   zero would invent the opposite.
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

const liveReport = (counts: {
	PASS: number;
	WARN: number;
	FAIL: number;
	SKIP: number;
}) =>
	({ checks: [], counts, failed: counts.FAIL }) as unknown as Parameters<
		typeof outcomeFromLiveResult
	>[0]["report"];

/** This file tests latency only; satisfy the independent EV-02 tuple gate. */
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

describe("outcomeFromLiveResult — carries the measurement", () => {
	it("attaches the latency to a green live outcome", () => {
		const out = outcomeFromLiveResult(
			{
				report: liveReport({ PASS: 13, WARN: 0, FAIL: 0, SKIP: 5 }),
				evidence: completeEvidence,
				firstPublish: {
					ms: 8_400,
					polls: 5,
					note: "first segment visible in stream_0.m3u8 after 8.4s (5 poll(s))",
				},
			},
			{ scenario: "live-rtmp-simple" },
			"live-rtmp-simple",
		);
		expect(out.verdict).toBe("PASS");
		expect(out.firstPublishMs).toBe(8_400);
		expect(out.firstPublishNote).toContain("8.4s");
	});

	it("attaches it to an INVALID outcome too — the channel still measured its origin", () => {
		/**
		 * A channel that came up, published, and then failed to tear down is INVALID as a
		 * verdict and still produced a real latency. Dropping it there would lose exactly the
		 * runs most worth understanding.
		 */
		const out = outcomeFromLiveResult(
			{
				report: liveReport({ PASS: 4, WARN: 0, FAIL: 0, SKIP: 0 }),
				invalid: "the run could not be torn down: stop failed",
				firstPublish: {
					ms: 11_000,
					polls: 6,
					note: "first segment after 11.0s",
				},
			},
			{ scenario: "s" },
			"s",
		);
		expect(out.verdict).toBe("INVALID");
		expect(out.firstPublishMs).toBe(11_000);
	});

	it("records 'not observed' rather than inventing a number when nothing published", () => {
		const out = outcomeFromLiveResult(
			{
				report: liveReport({ PASS: 2, WARN: 0, FAIL: 3, SKIP: 8 }),
				firstPublish: {
					polls: 60,
					note: "no segment appeared in stream_0.m3u8 within 120s (60 poll(s)) — the latency is unknown, not high",
				},
			},
			{ scenario: "s" },
			"s",
		);
		expect(out.firstPublishMs).toBeUndefined();
		expect(out.firstPublishNote).toContain("unknown, not high");
	});

	it("adds nothing when no measurement was taken", () => {
		const out = outcomeFromLiveResult(
			{ report: liveReport({ PASS: 1, WARN: 0, FAIL: 0, SKIP: 0 }) },
			{ scenario: "s" },
			"s",
		);
		expect(out.firstPublishMs).toBeUndefined();
		expect(out.firstPublishNote).toBeUndefined();
	});
});

describe("formatRunReport — the latency section", () => {
	it("prints the measurement and points at the constant it justifies", () => {
		const md = formatRunReport(
			reportOf([
				{
					scenario: "live-rtmp-simple",
					verdict: "PASS",
					reason: "13 live check(s) passed, 5 skipped",
					firstPublishMs: 8_400,
					firstPublishNote: "first segment visible after 8.4s (5 poll(s))",
				},
			]),
		);
		expect(md).toContain("## Origin publish latency (live)");
		expect(md).toContain("8.4s");
		// The comparison is the point: a bare number tells the reader nothing.
		expect(md).toContain("MIN_SAMPLE_GAP_SEC");
	});

	it("distinguishes 'not observed' from a measured zero", () => {
		const md = formatRunReport(
			reportOf([
				{
					scenario: "never-published",
					verdict: "FAIL",
					reason: "no movement",
					firstPublishNote: "no segment appeared within 120s",
				},
				{
					scenario: "instant",
					verdict: "PASS",
					reason: "ok",
					firstPublishMs: 0,
					firstPublishNote: "first segment already present",
				},
			]),
		);
		const section = md.slice(md.indexOf("## Origin publish latency"));
		expect(section).toContain("not observed");
		expect(section).toContain("0.0s");
		// Both rows present, and the unmeasured one is not printed as 120s.
		expect(section).not.toContain("120.0s");
	});

	it("omits the section entirely on a VOD-only run", () => {
		// A heading with no rows would imply the question was asked of a run that never
		// touched a live origin.
		const md = formatRunReport(
			reportOf([{ scenario: "vod", verdict: "PASS", reason: "ok" }]),
		);
		expect(md).not.toContain("## Origin publish latency");
	});
});
