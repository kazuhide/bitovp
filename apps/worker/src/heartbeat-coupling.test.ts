import { INGEST_CONNECTED_MAX_AGE_MS } from "@bitovp/core";
import { describe, expect, it } from "vitest";
import { HEARTBEAT_SWEEP_INTERVAL_MS } from "./heartbeat-cadence";

/**
 * review-260 127-A9: the vouching window is "3 × the sweep cadence" by
 * DESIGN, and the two constants live in different packages (core cannot see
 * the worker). This pin imports BOTH real values — change either and decide
 * the relation again here, instead of two comments drifting apart.
 */
describe("ingest vouching window ↔ sweep cadence coupling (ledger #127)", () => {
	it("MAX_AGE is exactly three sweep intervals", () => {
		expect(INGEST_CONNECTED_MAX_AGE_MS).toBe(3 * HEARTBEAT_SWEEP_INTERVAL_MS);
	});
});
