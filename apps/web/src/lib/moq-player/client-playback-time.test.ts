import { describe, expect, it, vi } from "vitest";
import {
	moqArchiveClientOrigin,
	moqArchiveClientTime,
} from "./client-playback-time";
import type { MoqObservationSession } from "./observations";

type Session = Pick<MoqObservationSession, "startedAt" | "events" | "archive">;
function session(): Session {
	return {
		startedAt: "2026-11-17T20:37:48.699Z",
		events: [
			{ type: "started", elapsedMs: 0 },
			{ type: "first-frame", elapsedMs: 2459 },
		],
		archive: {
			contentType: "video/webm",
			bytes: 726890,
			sha256: "a".repeat(64),
			durationMs: 21073,
			recordedAt: "2026-11-17T20:38:12.000Z",
		},
	};
}

describe("historical client recording origin", () => {
	it.each([
		["2026-11-17T20:37:26.666Z", 2759, "2026-11-17T20:37:29.425Z"],
		["2026-11-17T20:37:48.699Z", 2459, "2026-11-17T20:37:51.158Z"],
	] as const)("uses startedAt plus first observed frame for %s", (startedAt, elapsedMs, expected) => {
		const value = session();
		value.startedAt = startedAt;
		value.events[1] = { type: "first-frame", elapsedMs };
		expect(moqArchiveClientOrigin(value)).toBe(Date.parse(expected));
	});
	it("uses the recorded capture start when session ownership arrives after first frame", () => {
		const value = session();
		value.events.push({ type: "recording-started", elapsedMs: 5071 });
		expect(moqArchiveClientOrigin(value)).toBe(
			Date.parse("2026-11-17T20:37:53.770Z"),
		);
	});

	it("uses a capture timestamp independently of the capped observation window", () => {
		const value = session();
		value.events = [
			{ type: "started", elapsedMs: 0 },
			{ type: "first-frame", elapsedMs: 599_000 },
			{ type: "observation-limit", elapsedMs: 600_000 },
		];
		if (!value.archive) throw new Error("Missing test archive");
		value.archive.captureStartedAt = "2026-11-17T20:48:01.701Z";
		expect(moqArchiveClientOrigin(value)).toBe(
			Date.parse(value.archive.captureStartedAt),
		);
	});
	it("prefers known clip capture over historical event fallback", () => {
		const value = session();
		value.events.push({ type: "recording-started", elapsedMs: 5071 });
		if (!value.archive) throw new Error("Missing test archive");
		value.archive.captureStartedAt = "2026-11-17T20:37:54.100Z";
		expect(moqArchiveClientOrigin(value)).toBe(
			Date.parse(value.archive.captureStartedAt),
		);
	});
	it("keeps a current clip's origin unknown when capture starts after the observation limit", () => {
		const value = session();
		value.events = [
			{ type: "started", elapsedMs: 0 },
			{ type: "descriptor-ready", elapsedMs: 598800 },
			{ type: "first-frame", elapsedMs: 599000 },
			{ type: "observation-limit", elapsedMs: 600000 },
		];
		expect(moqArchiveClientOrigin(value)).toBeNull();
	});

	it("accepts zero elapsed and UTC epoch zero without a truthiness fallback", () => {
		const value = session();
		value.startedAt = "1970-01-01T00:00:00Z";
		value.events = [{ type: "first-frame", elapsedMs: 0 }];
		expect(moqArchiveClientOrigin(value)).toBe(0);
	});
	it("accepts exact UTC fractions and crosses midnight by elapsed milliseconds", () => {
		const value = session();
		value.startedAt = "2026-11-17T23:59:59.9Z";
		value.events = [{ type: "first-frame", elapsedMs: 250 }];
		expect(moqArchiveClientOrigin(value)).toBe(
			Date.parse("2026-11-18T00:00:00.150Z"),
		);
	});
	it.each([
		"invalid",
		"2026-02-30T20:37:48.699Z",
		"2026-11-17T24:00:00.000Z",
		"2026-11-17T20:37:48.699+00:00",
		"2026-11-17T20:37:48.699",
	])("rejects malformed or non-UTC startedAt: %s", (startedAt) => {
		expect(moqArchiveClientOrigin({ ...session(), startedAt })).toBeNull();
	});
	it.each([
		{ events: [] },
		{ events: [{ type: "started" as const, elapsedMs: 0 }] },
		{
			events: [
				{ type: "first-frame" as const, elapsedMs: 1000 },
				{ type: "first-frame" as const, elapsedMs: 2000 },
			],
		},
	])("requires exactly one first-frame event: $events", ({ events }) => {
		expect(moqArchiveClientOrigin({ ...session(), events })).toBeNull();
	});
	it.each([
		-1,
		Number.NaN,
		Number.POSITIVE_INFINITY,
		600001,
		0.5,
	])("rejects invalid first-frame elapsed time: %s", (elapsedMs) => {
		expect(
			moqArchiveClientOrigin({
				...session(),
				events: [{ type: "first-frame", elapsedMs }],
			}),
		).toBeNull();
	});
	it("requires a saved recording and accepts the observation-budget boundary", () => {
		expect(moqArchiveClientOrigin({ ...session(), archive: null })).toBeNull();
		const value = session();
		value.events = [{ type: "first-frame", elapsedMs: 600000 }];
		expect(moqArchiveClientOrigin(value)).toBe(
			Date.parse(value.startedAt) + 600000,
		);
	});
});

describe("client clock mapped to native archive position", () => {
	const origin = Date.parse("2026-11-17T20:37:51.158Z");
	it("maps actual recorded zero and five-second positions independently of the image clock", () => {
		expect(moqArchiveClientTime(origin, 0, 21073)).toBe(origin);
		expect(moqArchiveClientTime(origin, 5.003, 21073)).toBe(
			Date.parse("2026-11-17T20:37:56.161Z"),
		);
		expect(moqArchiveClientTime(0, 0, 1)).toBe(0);
	});
	it("follows backward seeking and holds a fixed paused position", () => {
		expect(moqArchiveClientTime(origin, 10, 21073)).toBe(origin + 10000);
		expect(moqArchiveClientTime(origin, 2, 21073)).toBe(origin + 2000);
		expect(moqArchiveClientTime(origin, 2, 21073)).toBe(origin + 2000);
	});
	it("clamps only up to one millisecond of end rounding and rejects larger overrun", () => {
		expect(moqArchiveClientTime(origin, 21.073, 21073)).toBe(origin + 21073);
		expect(moqArchiveClientTime(origin, 21.0735, 21073)).toBe(origin + 21073);
		expect(moqArchiveClientTime(origin, 21.075, 21073)).toBeNull();
	});
	it.each([
		null,
		Number.NaN,
		Number.POSITIVE_INFINITY,
		8640000000000001,
	])("keeps invalid origins unknown: %s", (value) =>
		expect(moqArchiveClientTime(value, 0, 21073)).toBeNull());
	it.each([
		-1,
		Number.NaN,
		Number.POSITIVE_INFINITY,
	])("rejects invalid positions: %s", (value) => {
		expect(moqArchiveClientTime(origin, value, 21073)).toBeNull();
	});
	it.each([
		0,
		-1,
		Number.NaN,
		Number.POSITIVE_INFINITY,
		90001,
	])("rejects invalid recorded durations: %s", (durationMs) => {
		expect(moqArchiveClientTime(origin, 0, durationMs)).toBeNull();
	});
	it("never reads current time, source pixels or SDK latency to manufacture a clock", () => {
		const now = vi.spyOn(Date, "now").mockImplementation(() => {
			throw new Error("Wall clock must not be read");
		});
		expect(
			moqArchiveClientTime(moqArchiveClientOrigin(session()), 5.003, 21073),
		).toBe(Date.parse("2026-11-17T20:37:56.161Z"));
		expect(now).not.toHaveBeenCalled();
		now.mockRestore();
	});
});
