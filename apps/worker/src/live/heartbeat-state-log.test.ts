import { describe, expect, it, vi } from "vitest";
import {
	heartbeatSampleRef,
	logHeartbeatStateChanges,
} from "./heartbeat-state-log";

const CH = "11111111-1111-4111-8111-111111111111";
const KEYFRAME =
	"At least one input video stream key-frame interval is larger than the threshold: 2167 ms >= 2000 ms!";
const waiting = {
	at: "2026-09-02T07:49:30.000Z",
	raw: { ingest: { status: "WAITING_FOR_FIRST_CONNECT" }, events: [] },
};
const connected = {
	at: "2026-09-02T07:50:00.000Z",
	raw: {
		ingest: { status: "CONNECTED", healthy: true },
		events: [
			{
				time: "2026-09-02T07:49:49.000Z",
				details: { eventType: "FIRST_CONNECT", message: null },
			},
			{
				time: "2026-09-02T07:49:51.000Z",
				details: { eventType: "WARNING", message: KEYFRAME },
			},
		],
	},
};

describe("logHeartbeatStateChanges", () => {
	it("writes one line per change, tagged with the channel id, and the provider's message verbatim", () => {
		const sink = vi.fn();
		expect(logHeartbeatStateChanges(CH, waiting, connected, sink)).toBe(3);
		expect(sink.mock.calls.map((call) => call[0])).toEqual([
			`[live-channel] ${CH} heartbeat ingest WAITING_FOR_FIRST_CONNECT → CONNECTED`,
			`[live-channel] ${CH} heartbeat event FIRST_CONNECT @2026-09-02T07:49:49.000Z`,
			`[live-channel] ${CH} heartbeat event WARNING @2026-09-02T07:49:51.000Z: ${KEYFRAME}`,
		]);
	});

	it("an unchanged poll writes NOTHING — never a line per poll", () => {
		const sink = vi.fn();
		const next = { ...connected, at: "2026-09-02T07:50:30.000Z" };
		expect(logHeartbeatStateChanges(CH, connected, next, sink)).toBe(0);
		expect(sink).not.toHaveBeenCalled();
	});

	it("defaults its sink to console.info", () => {
		const info = vi.spyOn(console, "info").mockImplementation(() => {});
		try {
			logHeartbeatStateChanges(CH, null, waiting);
			expect(info).toHaveBeenCalledWith(
				`[live-channel] ${CH} heartbeat ingest (none) → WAITING_FOR_FIRST_CONNECT`,
			);
		} finally {
			info.mockRestore();
		}
	});
});

describe("heartbeatSampleRef — the persisted column as a sample", () => {
	it("lifts { at, raw } from the worker's wrapper", () => {
		expect(
			heartbeatSampleRef({ at: waiting.at, raw: waiting.raw, deltas: {} }),
		).toEqual({ at: waiting.at, raw: waiting.raw });
	});

	it("is null for no column, a non-object, or an unparseable poll time", () => {
		expect(heartbeatSampleRef(null)).toBeNull();
		expect(heartbeatSampleRef(undefined)).toBeNull();
		expect(heartbeatSampleRef("x")).toBeNull();
		expect(heartbeatSampleRef({ at: "yesterday", raw: {} })).toBeNull();
		expect(heartbeatSampleRef({ raw: {} })).toBeNull();
	});
});
