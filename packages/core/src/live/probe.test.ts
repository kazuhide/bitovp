import { describe, expect, it } from "vitest";
import { compileLiveChannel } from "./compiler";
import { buildProbePlan, probeOutputPrefix } from "./probe";

/**
 *  PR4 — the probe plan: schema-valid by construction, COMPILES
 * through the real live compiler (the normal-pipeline requirement is not a
 * slogan), and carries the encoder-side billing fuse.
 */
describe("buildProbePlan", () => {
	const DESIGNATION = {
		credentialId: "00000000-0000-4000-8000-000000000002",
		bitmovinAccountId: "00000000-0000-4000-8000-000000000003",
		bucket: "probe-bucket",
		prefix: "probes/startup",
	};

	it("builds a schema-valid minimal plan that the live compiler accepts", () => {
		const plan = buildProbePlan({
			name: "probe-AWS_AP_NORTHEAST_1-1",
			cloudRegion: "AWS_AP_NORTHEAST_1",
			designation: DESIGNATION,
			probeId: "p-0001",
			streamKey: "probelaunch",
		});
		const ops = compileLiveChannel(plan);
		expect(ops.length).toBeGreaterThan(5);
		// 1-rendition shape: exactly one H264 + one AAC.
		expect(plan.renditions).toHaveLength(2);
		// The plan carries the Bitmovin account — without it provision throws
		// "no Bitmovin account id" before any billing (the gap the first
		// billed run surfaced, 2026-08-23).
		expect(plan.bitmovin.accountId).toBe(
			"00000000-0000-4000-8000-000000000003",
		);
	});

	it("every output path sits under the designated area + probe id — the reaper's whole scope", () => {
		const plan = buildProbePlan({
			name: "probe",
			cloudRegion: "EUROPE",
			designation: DESIGNATION,
			probeId: "p-777",
			streamKey: "probelaunch",
		});
		const prefix = probeOutputPrefix(DESIGNATION, "p-777");
		expect(prefix).toBe("probes/startup/p-777/");
		for (const muxing of plan.muxings) {
			expect(muxing.destination?.path.startsWith(prefix)).toBe(true);
		}
		expect(plan.liveManifests[0]?.destination?.path.startsWith(prefix)).toBe(
			true,
		);
	});

	it("carries the never-connected billing fuse at a Bitmovin-ACCEPTED value, not 1 (ledger #160)", () => {
		// A billed probe (2026-08-23) proved Bitmovin REJECTS the live START with
		// 400 code 1000 when waitingForFirstConnectTimeoutMinutes is 1. The same
		// run's corpus reached RUNNING with the block present at accepted values
		// (live-srt-listener at 30, live-rtmp-simple at streamTimeoutMinutes: 720),
		// so the VALUE 1 — below Bitmovin's undocumented minimum — was the fault,
		// NOT the block itself (an earlier fix mis-read this and removed the block;
		// review-288 C1 caught the inverted A/B). The fuse must survive because it
		// is the ONLY control for the encoder-up-but-DB-never-recorded-RUNNING
		// case (worker killed between START and status write): a value of 1 would
		// re-break every launch, and removing it re-opens that billing hole — so
		// this pins both the presence AND that the value is >= 30.
		const plan = buildProbePlan({
			name: "probe",
			cloudRegion: "AUTO",
			designation: DESIGNATION,
			probeId: "p-1",
			streamKey: "probelaunch",
		});
		expect(plan.start?.streamKey).toBe("probelaunch");
		const waitMinutes =
			plan.start?.autoShutdown?.waitingForFirstConnectTimeoutMinutes;
		expect(waitMinutes).toBeDefined();
		expect(waitMinutes).toBeGreaterThanOrEqual(30);
	});
});
