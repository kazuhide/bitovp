import { describe, expect, it } from "vitest";
import { INGEST_CONNECTED_MAX_AGE_MS, ingestConnectedTriState } from "./alerts";

/**
 *  (review-331): the feeder panel's "unconfirmed" notice was
 * unreachable from the detail page (its `ingestConnected` was a boolean, so
 * "no sample" collapsed into "not bound") and a standing false alarm on the
 * picker (which passed nothing). Three answers, derived in one place.
 */
const NOW = Date.parse("2026-08-28T12:00:00.000Z");
const sample = (ageMs: number, status: string) => ({
	at: new Date(NOW - ageMs).toISOString(),
	raw: {
		ingest: { status, healthy: status === "CONNECTED", streams: [] },
		events: [],
	},
	deltas: {},
});

describe("ingestConnectedTriState", () => {
	it("an inactive channel is false — there is no encoder to bind anything", () => {
		expect(ingestConnectedTriState(false, sample(0, "CONNECTED"), NOW)).toBe(
			false,
		);
	});
	it("an active channel with NO sample is unknown, never false", () => {
		expect(ingestConnectedTriState(true, null, NOW)).toBeUndefined();
		expect(ingestConnectedTriState(true, undefined, NOW)).toBeUndefined();
	});
	it("an active channel with a STALE sample is unknown — a frozen CONNECTED cannot vouch either", () => {
		expect(
			ingestConnectedTriState(
				true,
				sample(INGEST_CONNECTED_MAX_AGE_MS + 1, "CONNECTED"),
				NOW,
			),
		).toBeUndefined();
	});
	it("a fresh CONNECTED sample is true", () => {
		expect(ingestConnectedTriState(true, sample(1_000, "CONNECTED"), NOW)).toBe(
			true,
		);
	});
	it("a fresh sample that says otherwise is false — the encoder is up and not receiving", () => {
		expect(
			ingestConnectedTriState(
				true,
				sample(1_000, "WAITING_FOR_FIRST_CONNECT"),
				NOW,
			),
		).toBe(false);
	});
});
