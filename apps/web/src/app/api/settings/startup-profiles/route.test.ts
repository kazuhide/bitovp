import { PERCENTILE_MIN_N } from "@bitovp/core";
import { describe, expect, it, vi } from "vitest";
import { GET } from "./route";

/**
 *  PR1 — the profile route: buckets by (region, source), keeps
 * CHANNEL and PROBE apart, and serves core's honesty contract (null
 * percentiles below PERCENTILE_MIN_N) untouched.
 */

const sampleFindMany = vi.fn();

vi.mock("@/lib/server/context", () => ({
	getServerContext: () => ({
		prisma: { startupSample: { findMany: sampleFindMany } },
	}),
}));

function sample(over: Record<string, unknown> = {}) {
	return {
		cloudRegion: "AWS_AP_NORTHEAST_1",
		source: "CHANNEL",
		outcome: "RUNNING",
		queueSeconds: 120,
		observedAt: new Date(),
		...over,
	};
}

describe("GET /api/settings/startup-profiles", () => {
	it("buckets by region AND source — a probe never launders a channel's numbers", async () => {
		sampleFindMany.mockResolvedValue([
			sample(),
			sample({ source: "PROBE", queueSeconds: 30 }),
			sample({ cloudRegion: "AKAMAI_JP_OSA", queueSeconds: 500 }),
		]);
		const body = await (
			await GET(new Request("http://x/api/settings/startup-profiles"))
		).json();
		expect(body.windowDays).toBe(30);
		const keys = body.rows.map(
			(r: { region: string; source: string }) => `${r.region}/${r.source}`,
		);
		expect(keys).toContain("AWS_AP_NORTHEAST_1/CHANNEL");
		expect(keys).toContain("AWS_AP_NORTHEAST_1/PROBE");
		expect(keys).toContain("AKAMAI_JP_OSA/CHANNEL");
		expect(body.rows).toHaveLength(3);
	});

	it("small n serves null percentiles and the raw list — core's honesty passes through", async () => {
		sampleFindMany.mockResolvedValue([
			sample({ queueSeconds: 100 }),
			sample({ queueSeconds: 900 }),
			sample({ outcome: "FAILED", queueSeconds: null }),
		]);
		const body = await (
			await GET(new Request("http://x/api/settings/startup-profiles"))
		).json();
		const row = body.rows[0];
		expect(row.profile.n).toBe(2);
		expect(row.profile.failures).toBe(1);
		expect(row.profile.p50Seconds).toBeNull();
		expect(row.profile.p90Seconds).toBeNull();
		expect(row.profile.maxSeconds).toBe(900);
		expect(row.profile.rawSeconds).toEqual([100, 900]);
	});

	it("names percentiles at n ≥ PERCENTILE_MIN_N", async () => {
		sampleFindMany.mockResolvedValue(
			Array.from({ length: PERCENTILE_MIN_N }, (_, i) =>
				sample({ queueSeconds: 100 + i }),
			),
		);
		const body = await (
			await GET(new Request("http://x/api/settings/startup-profiles"))
		).json();
		expect(body.rows[0].profile.p50Seconds).not.toBeNull();
		expect(body.rows[0].profile.p90Seconds).not.toBeNull();
	});

	it("rejects a nonsense window", async () => {
		const res = await GET(
			new Request("http://x/api/settings/startup-profiles?windowDays=0"),
		);
		expect(res.status).toBe(400);
	});
});
