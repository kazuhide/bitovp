import {
	LIVE_EVIDENCE_VERSION,
	type LiveEvidenceLeg,
	type LiveEvidenceLegInput,
	sealLiveEvidenceLeg,
} from "@bitovp/core";
import { describe, expect, it } from "vitest";
import type { Check, VerificationReport } from "./engine";
import type { LiveCleanupSeal } from "./live-cleanup-seal";
import { outcomeFromLiveResult } from "./runner";

/**
 * A COMPLETE evidence leg — the tuple a
 * green live outcome must be backed by. `incomplete` drops the progression so
 * the same leg reads as the audited "two identical snapshots".
 */
function leg(
	options: { incomplete?: boolean; edge?: boolean; scenario?: string } = {},
): LiveEvidenceLeg {
	const eventRoot = {
		origin: "https://edge.example",
		path: "/hls/live/1/ev/",
		queryKeys: [],
		urlSha256: "e".repeat(64),
	};
	const url = {
		origin: "https://edge.example",
		path: options.edge ? "/hls/live/1/ev/stream.m3u8" : "/ev/stream.m3u8",
		queryKeys: [],
		urlSha256: "0".repeat(64),
	};
	const edgeRunRoot =
		"https://edge.example/hls/live/1/ev/verify/RUN1/live-rtmp-simple/";
	const edgeObject = (name: string) => ({
		origin: "https://edge.example",
		path: new URL(name, edgeRunRoot).pathname,
		queryKeys: [],
		urlSha256: "1".repeat(64),
	});
	const edgePlaylist = (name: string) => ({
		origin: "https://edge.example",
		path: new URL(name, "https://edge.example/hls/live/1/ev/").pathname,
		queryKeys: [],
		urlSha256: "2".repeat(64),
	});
	const input: LiveEvidenceLegInput = {
		version: LIVE_EVIDENCE_VERSION,
		scenario: options.scenario ?? "live-rtmp-simple",
		outputLeg: "hls@origin",
		manifestKey: "hls",
		outputKey: "origin",
		kind: "HLS",
		role: options.edge ? "EDGE" : "ORIGIN",
		build: {
			commit: "b8c63e35",
			image: `worker@sha256:${"c".repeat(64)}`,
			planSha256: "a".repeat(64),
		},
		source: {
			location: "verify-in/bbb.mov",
			etag: '"1"',
			size: 2,
			sha256: "b".repeat(64),
		},
		channel: {
			channelId: "chan-1",
			liveChannelRunId: "run-1",
			providerEncodingId: "enc-1",
			providerStreamIds: { video: "stream-1" },
			providerOutputIds: { origin: "output-1" },
			requiredProviderStreamKeys: ["video"],
			requiredProviderOutputKeys: ["origin"],
		},
		...(options.edge
			? {
					msl: {
						outputKey: "origin",
						credentialId: "credential-msl",
						providerOutputId: "output-1",
						streamId: 1,
						eventName: "ev",
						streamFormat: "HLS" as const,
						mslVersion: "MSL4",
						eventRoot,
					},
				}
			: {}),
		output: {
			prefix: "verify/RUN1/live-rtmp-simple/",
			...(options.edge ? { edge: url } : {}),
		},
		topology: { expectedChildCount: 1, expectedChildIds: ["v1080"] },
		master: {
			key: "stream.m3u8",
			url,
			bytes: 100,
			...(options.edge ? { sha256: "d".repeat(64) } : {}),
		},
		children: [
			{
				id: "v1080",
				...(options.edge ? { url: edgePlaylist("v1080.m3u8") } : {}),
				requiresInit: false,
				listed: 3,
				media: [
					{
						key: "seg-1.m4s",
						...(options.edge ? { url: edgeObject("seg-1.m4s") } : {}),
						bytes: 500,
						...(options.edge ? { sha256: "f".repeat(64) } : {}),
					},
				],
				missing: [],
			},
		],
		probes: [
			{
				at: "t0",
				children: [
					{
						id: "v1080",
						served: [options.edge ? `${edgeRunRoot}seg-1.m4s` : "seg-1.m4s"],
					},
				],
			},
			{
				at: "t1",
				children: [
					{
						id: "v1080",
						served: [options.edge ? `${edgeRunRoot}seg-2.m4s` : "seg-2.m4s"],
					},
				],
			},
		],
		progression: options.incomplete
			? { observed: false, detail: "identical media served at both probes" }
			: { observed: true, detail: "v1080: served seg-2.m4s at t1" },
		providerTerminal: {
			confirmed: true,
			encodingId: "enc-1",
			status: "CANCELED",
			observedAt: "2026-08-30T10:01:00.000Z",
			detail: "EV-01 exact provider readback",
		},
		cleanup: {
			clean: true,
			queueDrained: true,
			processGone: true,
			storageRetained: true,
			tokenCleanup: {
				required: false,
				confirmed: true,
				detail: "not required",
			},
		},
	};
	return sealLiveEvidenceLeg(input);
}
const EVIDENCE = [leg()];

/**
 * Every live outcome derived from a report must carry that report's counts.
 *
 * It did not, on all four paths, and the consequence was silent: the run report ranks greens by
 * `skipped ÷ evaluated` and reads exactly this field, so `live-rtmp-simple` — a real green
 * backed by 13 PASSes and 5 SKIPs on a real encoder — could not be ranked, weighed, or
 * distrusted next to the VOD corpus. A live scenario is supposed to be a row in the same table
 * as a VOD one; it has to carry the same columns, and nothing checked that it did.
 *
 * Testing this used to require a live encoder, which is why nothing did. The decision is a pure
 * function now, so the invariant is asserted directly rather than inferred from a real run.
 */

function reportOf(
	counts: { PASS: number; WARN: number; FAIL: number; SKIP: number },
	checks: Check[] = [],
): VerificationReport {
	return {
		checks,
		counts,
		failed: counts.FAIL,
	} as unknown as VerificationReport;
}

const check = (id: string, verdict: Check["verdict"], detail: string): Check =>
	({ id, verdict, detail }) as Check;

describe("outcomeFromLiveResult", () => {
	it("reports PASS with the counts attached — when the evidence tuple is complete", () => {
		const out = outcomeFromLiveResult(
			{
				report: reportOf({ PASS: 13, WARN: 0, FAIL: 0, SKIP: 5 }),
				evidence: EVIDENCE,
			},
			{ scenario: "live-rtmp-simple" },
			"live-rtmp-simple",
		);
		expect(out.verdict).toBe("PASS");
		expect(out.reason).toBe("13 live check(s) passed, 5 skipped");
		// The regression: this was undefined, and the report's ranking silently skipped it.
		expect(out.checks).toEqual({ PASS: 13, WARN: 0, FAIL: 0, SKIP: 5 });
		// The versioned summary rides onto the outcome for the run row.
		expect(out.liveEvidence).toMatchObject({
			version: LIVE_EVIDENCE_VERSION,
			complete: true,
		});
		expect(out.liveEvidence?.legs.map((l) => l.outputLeg)).toEqual([
			"hls@origin",
		]);
	});

	it("reports WARN when anything warned, still with the counts", () => {
		const out = outcomeFromLiveResult(
			{
				report: reportOf({ PASS: 9, WARN: 2, FAIL: 0, SKIP: 1 }),
				evidence: EVIDENCE,
			},
			{ scenario: "s" },
			"s",
		);
		expect(out.verdict).toBe("WARN");
		expect(out.checks?.WARN).toBe(2);
	});

	it("accepts a direct MSL4 run whose storage manifest is unobservable but credential-bound EDGE delivery PASSed", () => {
		const evidence = [leg({ edge: true, scenario: "live-akamai-msl-ts" })];
		const out = outcomeFromLiveResult(
			{
				report: reportOf({ PASS: 2, WARN: 0, FAIL: 0, SKIP: 1 }, [
					check("live:readable", "PASS", "MSL origin is unobservable"),
					check("live:manifest:hls", "SKIP", "MSL ingest has no origin read"),
					check("live:edge:hls:origin", "PASS", "two advancing edge probes"),
				]),
				evidence,
			},
			{ scenario: "live-akamai-msl-ts" },
			"live-akamai-msl-ts",
		);
		expect(out.verdict).toBe("PASS");
		expect(out.liveEvidence?.complete).toBe(true);
	});

	it("keeps a direct MSL4 run INVALID when both the storage manifest and EDGE delivery are unobserved", () => {
		const out = outcomeFromLiveResult(
			{
				report: reportOf({ PASS: 1, WARN: 0, FAIL: 0, SKIP: 2 }, [
					check("live:readable", "PASS", "MSL origin is unobservable"),
					check("live:manifest:hls", "SKIP", "MSL ingest has no origin read"),
					check("live:edge:hls:origin", "SKIP", "edge was not configured"),
				]),
				evidence: [leg({ edge: true, scenario: "live-akamai-msl-ts" })],
			},
			{ scenario: "live-akamai-msl-ts" },
			"live-akamai-msl-ts",
		);
		expect(out.verdict).toBe("INVALID");
		expect(out.reason).toContain("no direct MSL edge was verified");
	});

	/**
	 * The evidence gate: a green report is
	 * NOT a pass until every output leg's tuple is complete. INVALID rather
	 * than FAIL — a verifier gap is not a delivery failure — and AFTER the
	 * report verdict, so a FAIL the engine found stays a FAIL.
	 */
	it("refuses a PASS with NO evidence tuple — INVALID, naming the gap (the audited shape)", () => {
		const out = outcomeFromLiveResult(
			{ report: reportOf({ PASS: 13, WARN: 0, FAIL: 0, SKIP: 5 }) },
			{ scenario: "live-rtmp-simple" },
			"live-rtmp-simple",
		);
		expect(out.verdict).toBe("INVALID");
		expect(out.reason).toContain("live evidence tuple");
		expect(out.reason).toContain("no live evidence tuple was recorded");
		expect(out.checks).toEqual({ PASS: 13, WARN: 0, FAIL: 0, SKIP: 5 });
		expect(out.liveEvidence).toBeUndefined();
	});

	it("refuses a PASS whose tuple has an INCOMPLETE leg — two identical snapshots — and says which element", () => {
		const out = outcomeFromLiveResult(
			{
				report: reportOf({ PASS: 13, WARN: 0, FAIL: 0, SKIP: 5 }),
				evidence: [leg(), leg({ incomplete: true })],
			},
			{ scenario: "live-rtmp-simple" },
			"live-rtmp-simple",
		);
		expect(out.verdict).toBe("INVALID");
		expect(out.reason).toContain("1 of 2 live evidence leg(s) incomplete");
		expect(out.reason).toContain("progression: identical media served");
		expect(out.liveEvidence?.complete).toBe(false);
	});

	it("refuses a WARN the same way — WARN is a green", () => {
		const out = outcomeFromLiveResult(
			{
				report: reportOf({ PASS: 9, WARN: 2, FAIL: 0, SKIP: 1 }),
				evidence: [leg({ incomplete: true })],
			},
			{ scenario: "s" },
			"s",
		);
		expect(out.verdict).toBe("INVALID");
	});

	it("leaves a FAIL a FAIL when the tuple is incomplete — a delivery failure says more than 'unverified'", () => {
		const out = outcomeFromLiveResult(
			{
				report: reportOf({ PASS: 4, WARN: 0, FAIL: 1, SKIP: 0 }, [
					check("live:mirror:hls:mirror-1", "FAIL", "did not close"),
				]),
				evidence: [leg({ incomplete: true })],
			},
			{ scenario: "s" },
			"s",
		);
		expect(out.verdict).toBe("FAIL");
		expect(out.reason).toContain("live:mirror:hls:mirror-1");
		// The (incomplete) summary still rides onto the outcome.
		expect(out.liveEvidence?.complete).toBe(false);
	});

	it("an empty tuple (no legs at all) is no evidence", () => {
		const out = outcomeFromLiveResult(
			{
				report: reportOf({ PASS: 13, WARN: 0, FAIL: 0, SKIP: 5 }),
				evidence: [],
			},
			{ scenario: "s" },
			"s",
		);
		expect(out.verdict).toBe("INVALID");
		expect(out.reason).toContain("no output leg");
	});

	it("reports FAIL naming the first failing check, with the counts", () => {
		const out = outcomeFromLiveResult(
			{
				report: reportOf({ PASS: 4, WARN: 0, FAIL: 2, SKIP: 0 }, [
					check("live:running", "PASS", "up"),
					check("live:segments", "FAIL", "no movement between samples"),
					check("live:dvr:window", "FAIL", "short"),
				]),
			},
			{ scenario: "s" },
			"s",
		);
		expect(out.verdict).toBe("FAIL");
		expect(out.reason).toContain("live:segments");
		expect(out.reason).toContain("no movement between samples");
		expect(out.checks?.FAIL).toBe(2);
	});

	it("calls a report with zero PASS INVALID, not FAIL — and still attaches the counts", () => {
		/**
		 * A report that failed 3 checks and passed none verified nothing; calling it FAIL implies
		 * the harness looked and found the product wanting. The counts matter especially here:
		 * this is the outcome a reader most needs to see the SKIP pile behind.
		 */
		const out = outcomeFromLiveResult(
			{ report: reportOf({ PASS: 0, WARN: 0, FAIL: 3, SKIP: 20 }) },
			{ scenario: "s" },
			"s",
		);
		expect(out.verdict).toBe("INVALID");
		expect(out.reason).toContain("verified nothing");
		expect(out.checks).toEqual({ PASS: 0, WARN: 0, FAIL: 3, SKIP: 20 });
	});

	it("passes an explicit harness fault through verbatim", () => {
		const out = outcomeFromLiveResult(
			{ invalid: "the channel never reached RUNNING within 900s" },
			{ scenario: "s" },
			"s",
		);
		expect(out.verdict).toBe("INVALID");
		expect(out.reason).toBe("the channel never reached RUNNING within 900s");
		// No report existed, so there are no counts to attach — and it must not invent any.
		expect(out.checks).toBeUndefined();
	});

	it("does not silently pass when the runner returns neither a report nor a reason", () => {
		const out = outcomeFromLiveResult({}, { scenario: "s" }, "s");
		expect(out.verdict).toBe("INVALID");
		expect(out.reason).toContain("neither a report nor a reason");
	});

	/**
	 * The durable teardown seal on the outcome
	 * an unclean seal seals the run INVALID before any report-based
	 * verdict, and the seal rides onto every outcome so the run row keeps the
	 * teardown evidence whatever the verdict.
	 */
	function seal(clean: boolean): LiveCleanupSeal {
		const el = (established: boolean) => ({
			established,
			detail: established ? "ok" : "missing",
		});
		return {
			channelId: "chan-1",
			providerStreamIds: {},
			providerOutputIds: {},
			productStopProjection: el(true),
			providerTerminal: el(true),
			localTerminal: el(true),
			// The one that decides `clean` here — a feeder never proven gone.
			feederProcessGone: el(clean),
			hostProcessGone: el(true),
			queueDrained: el(true),
			tokenRequired: false,
			tokenCleanup: el(true),
			localClean: clean,
			clean,
		};
	}

	it("seals INVALID when the cleanup seal is not clean, BEFORE the report verdict", () => {
		const out = outcomeFromLiveResult(
			{
				// A report that would otherwise PASS — the seal must override it.
				report: reportOf({ PASS: 13, WARN: 0, FAIL: 0, SKIP: 5 }),
				cleanup: seal(false),
			},
			{ scenario: "live-rtmp-simple" },
			"live-rtmp-simple",
		);
		expect(out.verdict).toBe("INVALID");
		expect(out.reason).toContain("live cleanup did not seal clean");
		expect(out.reason).toContain("feeder process gone");
		// The seal rides onto the outcome for the run row.
		expect(out.liveCleanup?.clean).toBe(false);
		// A green report over an unclean teardown still carries its counts.
		expect(out.checks).toEqual({ PASS: 13, WARN: 0, FAIL: 0, SKIP: 5 });
	});

	it("keeps the report verdict when the seal is clean, and attaches the seal", () => {
		const out = outcomeFromLiveResult(
			{
				report: reportOf({ PASS: 13, WARN: 0, FAIL: 0, SKIP: 5 }),
				cleanup: seal(true),
				evidence: EVIDENCE,
			},
			{ scenario: "live-rtmp-simple" },
			"live-rtmp-simple",
		);
		expect(out.verdict).toBe("PASS");
		expect(out.liveCleanup?.clean).toBe(true);
	});

	it("lets an explicit harness invalid win over a clean seal, still attaching it", () => {
		const out = outcomeFromLiveResult(
			{ invalid: "the channel never reached RUNNING", cleanup: seal(true) },
			{ scenario: "s" },
			"s",
		);
		expect(out.verdict).toBe("INVALID");
		expect(out.reason).toBe("the channel never reached RUNNING");
		expect(out.liveCleanup?.clean).toBe(true);
	});

	it("attaches counts on EVERY path that had a report — the invariant, stated once", () => {
		/**
		 * The property rather than the instances: whatever the verdict, if a report went in, its
		 * counts come out. This is what actually broke, and it broke on four paths at once.
		 */
		const reports = [
			{ PASS: 13, WARN: 0, FAIL: 0, SKIP: 5 },
			{ PASS: 9, WARN: 2, FAIL: 0, SKIP: 1 },
			{ PASS: 4, WARN: 0, FAIL: 2, SKIP: 0 },
			{ PASS: 0, WARN: 0, FAIL: 3, SKIP: 20 },
			{ PASS: 1, WARN: 0, FAIL: 0, SKIP: 0 },
		];
		for (const counts of reports) {
			const out = outcomeFromLiveResult(
				{ report: reportOf(counts) },
				{ scenario: "s" },
				"s",
			);
			expect(out.checks, JSON.stringify(counts)).toEqual(counts);
		}
	});
});
