import { describe, expect, it } from "vitest";
import { deriveFeederRtmpTarget } from "./feeder-target";

/**
 * Direct tests (review-226 I5: the module shipped with none — the whole
 * REDUNDANT_RTMP branch was uncovered, and reordering the refusal/pending
 * checks left every suite green while silently demoting a creation-time 422
 * to an air-time failure).
 */

const START = { streamKey: "planKey" };

describe("deriveFeederRtmpTarget (ledger #96)", () => {
	it("RTMP: rtmp://<ip>/live with the channel key winning over the plan key", () => {
		expect(
			deriveFeederRtmpTarget(
				{ liveInput: { key: "main", kind: "RTMP" }, start: START } as never,
				"channelKey",
				"1.2.3.4",
			),
		).toEqual({
			ok: true,
			url: "rtmp://1.2.3.4/live",
			streamKey: "channelKey",
		});
	});

	it("RTMP: falls back to the plan's start key — the panel prefill's own precedence", () => {
		const t = deriveFeederRtmpTarget(
			{ liveInput: { key: "main", kind: "RTMP" }, start: START } as never,
			null,
			"1.2.3.4",
		);
		expect(t).toMatchObject({ ok: true, streamKey: "planKey" });
	});

	it("RTMP without an encoder IP is PENDING — wait, not refuse", () => {
		const t = deriveFeederRtmpTarget(
			{ liveInput: { key: "main", kind: "RTMP" }, start: START } as never,
			null,
			null,
		);
		expect(t.ok).toBe("pending");
	});

	it("REDUNDANT_RTMP targets the FIRST dynamic ingest point", () => {
		expect(
			deriveFeederRtmpTarget(
				{
					liveInput: {
						key: "main",
						kind: "REDUNDANT_RTMP",
						ingestPoints: [
							{ applicationName: "liveA", streamKey: "primaryFeed" },
							{ applicationName: "liveB", streamKey: "backupFeed" },
						],
					},
					start: START,
				} as never,
				null,
				"1.2.3.4",
			),
		).toEqual({
			ok: true,
			url: "rtmp://1.2.3.4/liveA",
			streamKey: "primaryFeed",
		});
	});

	it("REDUNDANT_RTMP with no dynamic points is a NAMED refusal even with NO IP — refusals must precede pending, or the route's creation-time probe silently degrades to an air-time failure", () => {
		const t = deriveFeederRtmpTarget(
			{
				liveInput: { key: "main", kind: "REDUNDANT_RTMP" },
				start: START,
			} as never,
			null,
			null, // the route probes with no runtime columns — exactly here
		);
		expect(t.ok).toBe(false);
		if (t.ok === false) {
			expect(t.reason).toContain("no dynamic ingest points");
		}
	});

	it("non-RTMP-family inputs are NAMED refusals naming the kind", () => {
		const t = deriveFeederRtmpTarget(
			{
				liveInput: { key: "main", kind: "ZIXI" },
				start: START,
			} as never,
			null,
			"1.2.3.4",
		);
		expect(t.ok).toBe(false);
		if (t.ok === false) {
			expect(t.reason).toContain("ZIXI");
		}
	});
});
