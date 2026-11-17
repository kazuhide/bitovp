import { describe, expect, it } from "vitest";
import {
	buildHeartbeatCorrelationUrl,
	heartbeatWindowContains,
	parseHeartbeatCorrelation,
} from "./heartbeat-correlation";

const ID = "00000000-0000-4000-8000-000000000001";
const FROM = "2026-11-18T00:00:00.000Z",
	TO = "2026-11-18T00:01:00.000Z";
describe("run and UTC heartbeat navigation", () => {
	it("roundtrips a fixed local route without using the AISA runId parameter", () => {
		const path = buildHeartbeatCorrelationUrl(ID, ID, FROM, TO);
		expect(path).not.toBeNull();
		const url = new URL(path ?? "", "http://localhost");
		expect(url.pathname).toBe(`/live/${ID}`);
		expect(url.hash).toBe("#sec-heartbeat-log");
		expect(url.searchParams.has("runId")).toBe(false);
		expect(parseHeartbeatCorrelation(url.searchParams)).toEqual({
			kind: "requested",
			runId: ID,
			from: FROM,
			to: TO,
		});
		expect(parseHeartbeatCorrelation({ runId: ID })).toEqual({ kind: "none" });
	});
	it.each([
		{ heartbeatRunId: "invalid" },
		{ heartbeatRunId: ID },
		{ heartbeatRunId: [ID, ID], heartbeatFrom: FROM, heartbeatTo: TO },
		{ heartbeatRunId: ID, heartbeatFrom: TO, heartbeatTo: FROM },
		{
			heartbeatRunId: ID,
			heartbeatFrom: FROM,
			heartbeatTo: "2026-11-18T00:10:00.001Z",
		},
		{
			heartbeatRunId: ID,
			heartbeatFrom: "2026-11-18T00:00:00+00:00",
			heartbeatTo: TO,
		},
	])("refuses partial, duplicate, noncanonical or unbounded requests", (query) => {
		expect(parseHeartbeatCorrelation(query)).toEqual({ kind: "invalid" });
	});
	it("keeps inclusive boundaries and rejects unknown sample clocks", () => {
		expect(heartbeatWindowContains({ from: FROM, to: TO }, FROM)).toBe(true);
		expect(heartbeatWindowContains({ from: FROM, to: TO }, TO)).toBe(true);
		expect(heartbeatWindowContains({ from: FROM, to: TO }, null)).toBe(false);
		expect(
			heartbeatWindowContains(
				{ from: FROM, to: TO },
				"2026-11-18T00:01:00.001Z",
			),
		).toBe(false);
	});
});
