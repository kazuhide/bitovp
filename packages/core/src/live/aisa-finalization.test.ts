import { describe, expect, it } from "vitest";
import { aisaLiveFinalization } from "./aisa-finalization";

const analysisId = "a0000000-0000-4000-8000-000000000001";
const encodingId = "a0000000-0000-4000-8000-000000000002";
const snapshot = {
	analysisId,
	encodingId,
	sequence: 1,
	isFinal: true,
	producedAt: "2026-11-07T00:00:00Z",
	mediaTimeOriginUnixMs: 1,
	analyzedStartTimeSeconds: 0,
	analyzedEndTimeSeconds: 1,
	metadata: { version: "1", disclaimer: "Preview" },
	observations: [],
	keyMoments: [],
	sourceGaps: [],
};
const run = {
	aisaAnalysisId: analysisId,
	bitmovinEncodingId: encodingId,
	aisaStatus: "FINISHED",
	providerStatus: "FINISHED",
	aisaSnapshot: snapshot,
};

describe("independent AISA finalization proof", () => {
	it("leaves ordinary runs unchanged", () =>
		expect(aisaLiveFinalization({})).toBe("UNBOUND"));
	it("requires terminal Analysis and Encoder plus a final result for this pair", () => {
		expect(aisaLiveFinalization(run)).toBe("COMPLETE");
		for (const patch of [
			{ aisaStatus: "RUNNING" },
			{ providerStatus: "RUNNING" },
			{ aisaSnapshot: null },
			{ aisaSnapshot: { ...snapshot, isFinal: false } },
			{ aisaSnapshot: { ...snapshot, encodingId: analysisId } },
		])
			expect(aisaLiveFinalization({ ...run, ...patch })).toBe("PENDING");
	});
	it("keeps final terminal failure distinct from success", () => {
		expect(aisaLiveFinalization({ ...run, aisaStatus: "ERROR" })).toBe(
			"FAILED",
		);
		expect(aisaLiveFinalization({ ...run, providerStatus: "ERROR" })).toBe(
			"FAILED",
		);
		expect(
			aisaLiveFinalization({ ...run, aisaStatus: "ERROR", aisaSnapshot: null }),
		).toBe("PENDING");
		expect(
			aisaLiveFinalization({
				...run,
				aisaStatus: "ERROR",
				aisaSnapshot: null,
				aisaFinalization: {
					analysisId,
					encodingId,
					status: "ERROR",
					result: "UNAVAILABLE_TERMINAL_FAILURE",
					observedAt: "2026-11-07T00:00:00Z",
				},
			}),
		).toBe("FAILED");
	});
});
