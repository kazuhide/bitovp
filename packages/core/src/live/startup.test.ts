import { describe, expect, it } from "vitest";
import {
	AGGREGATE_CLOUD_REGIONS,
	PERCENTILE_MIN_N,
	resolveAutoLead,
	resolveStartupRegion,
	SCHEDULE_DEFAULT_LEAD_SECONDS,
	type StartupSampleInput,
	startupProfile,
} from "./startup";

const NOW = new Date("2026-08-22T00:00:00Z");

function sample(
	queueSeconds: number | null,
	outcome: StartupSampleInput["outcome"] = "RUNNING",
	daysAgo = 1,
): StartupSampleInput {
	return {
		outcome,
		queueSeconds,
		observedAt: new Date(NOW.getTime() - daysAgo * 24 * 60 * 60 * 1000),
	};
}

describe("startupProfile (ledger #160)", () => {
	it("refuses percentile labels below PERCENTILE_MIN_N — max + raw list instead", () => {
		const p = startupProfile(
			[sample(170), sample(150), sample(840), sample(160), sample(155)],
			30,
			NOW,
		);
		expect(p.n).toBe(5);
		expect(p.p50Seconds).toBeNull();
		expect(p.p90Seconds).toBeNull();
		expect(p.maxSeconds).toBe(840);
		expect(p.rawSeconds).toEqual([150, 155, 160, 170, 840]);
	});

	it("names percentiles at n ≥ PERCENTILE_MIN_N (nearest-rank)", () => {
		const samples = Array.from({ length: PERCENTILE_MIN_N }, (_, i) =>
			sample(100 + i * 10),
		);
		const p = startupProfile(samples, 30, NOW);
		expect(p.n).toBe(PERCENTILE_MIN_N);
		expect(p.p50Seconds).toBe(190);
		expect(p.p90Seconds).toBe(270);
	});

	it("counts FAILED and CENSORED beside the percentile — never silently dropped", () => {
		const p = startupProfile(
			[
				sample(120),
				sample(null, "FAILED"),
				sample(null, "CENSORED"),
				sample(null, "CENSORED"),
			],
			30,
			NOW,
		);
		expect(p.n).toBe(1);
		expect(p.failures).toBe(1);
		expect(p.censored).toBe(2);
	});

	it("honors the window — an old sample is outside it", () => {
		const p = startupProfile([sample(120, "RUNNING", 40)], 30, NOW);
		expect(p.n).toBe(0);
		expect(p.maxSeconds).toBeNull();
	});
});

describe("resolveStartupRegion (ledger #160)", () => {
	it("Cloud Connect resolves through the infrastructure block — the EXTERNAL bucket would have collapsed the motivating population", () => {
		expect(
			resolveStartupRegion({
				bitmovin: {
					cloudRegion: "EXTERNAL",
					encoderVersion: "STABLE",
					infrastructure: {
						infrastructureId: "infra-1",
						cloudRegion: "AKAMAI_JP_OSA",
					},
				},
			}),
		).toEqual({ region: "AKAMAI_JP_OSA", infrastructureId: "infra-1" });
	});

	it("AUTO stays its own honest bucket — a placement request is not a region", () => {
		expect(
			resolveStartupRegion({
				bitmovin: { cloudRegion: "AUTO", encoderVersion: "STABLE" },
			}),
		).toEqual({ region: "AUTO", infrastructureId: null });
	});
});

describe("AGGREGATE_CLOUD_REGIONS (the hoisted list)", () => {
	it("carries the nine aggregates and no EXTERNAL — each deriver states its own EXTERNAL decision", () => {
		expect(AGGREGATE_CLOUD_REGIONS).toHaveLength(9);
		expect(AGGREGATE_CLOUD_REGIONS).toContain("AUTO");
		expect(AGGREGATE_CLOUD_REGIONS).not.toContain("EXTERNAL");
	});
});

describe("resolveAutoLead (ledger #160 PR3)", () => {
	const AIR = Date.parse("2026-08-23T15:00:00Z");
	const profileOf = (samples: StartupSampleInput[]) =>
		startupProfile(samples, 30, NOW);

	it("profile-fed: lead = P90 + margin, resolved once from airAt", () => {
		const samples = Array.from({ length: PERCENTILE_MIN_N }, (_, i) =>
			sample(100 + i * 10),
		);
		const r = resolveAutoLead(profileOf(samples), {
			airAtMs: AIR,
			leadMarginSeconds: 180,
		});
		expect(r.source).toBe("P90");
		expect(r.p90Seconds).toBe(270);
		expect(r.leadSeconds).toBe(450);
		expect(r.fireAtMs).toBe(AIR - 450 * 1000);
		expect(r.n).toBe(PERCENTILE_MIN_N);
	});

	it("below the honesty bar: the DEFAULT lead, said out loud — never a lab-coat P90", () => {
		const r = resolveAutoLead(profileOf([sample(120), sample(130)]), {
			airAtMs: AIR,
		});
		expect(r.source).toBe("DEFAULT");
		expect(r.p90Seconds).toBeNull();
		expect(r.leadSeconds).toBe(SCHEDULE_DEFAULT_LEAD_SECONDS);
		expect(r.fireAtMs).toBe(AIR - SCHEDULE_DEFAULT_LEAD_SECONDS * 1000);
	});

	it("zero samples: DEFAULT with n=0 (the caller's insufficient-data line)", () => {
		const r = resolveAutoLead(profileOf([]), { airAtMs: AIR });
		expect(r.source).toBe("DEFAULT");
		expect(r.n).toBe(0);
	});
});
