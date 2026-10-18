import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderLocalized as renderL } from "@/test/render";
import { HeartbeatPanel } from "./heartbeat-panel";

const base = {
	at: "2026-06-13T10:00:00.000Z",
	raw: {
		ingest: { status: "CONNECTED", healthy: true, streams: [] },
		events: [] as unknown[],
	},
	deltas: {},
};

describe("HeartbeatPanel events section", () => {
	it("renders nothing-to-report copy (not a hidden section) when a healthy stream has no events", () => {
		// The bug it fixes: an empty events array used to hide the whole section,
		// so a healthy stream looked frozen/broken. The header + an explicit line
		// must stay visible — the status/deltas above already prove liveness.
		renderL(<HeartbeatPanel nowMs={Date.now()} lastHeartbeat={base} />);
		expect(screen.getByText("Events")).toBeInTheDocument();
		expect(
			screen.getByText(
				/healthy stream reports none after the initial connect/i,
			),
		).toBeInTheDocument();
	});

	it("lists events and drops the empty-state line once the heartbeat reports any", () => {
		renderL(
			<HeartbeatPanel
				nowMs={Date.now()}
				lastHeartbeat={{
					...base,
					raw: {
						ingest: { status: "CONNECTED", healthy: true, streams: [] },
						events: [
							{ time: "2026-06-13T10:00:00.000Z", message: "First connect" },
						],
					},
				}}
			/>,
		);
		expect(screen.getByText("Events")).toBeInTheDocument();
		expect(screen.getByText("First connect")).toBeInTheDocument();
		expect(
			screen.queryByText(/healthy stream reports none/i),
		).not.toBeInTheDocument();
	});

	it("renders the wire shape — the type word once, the WARNING message verbatim", () => {
		const KEYFRAME =
			"At least one input video stream key-frame interval is larger than the threshold: 2167 ms >= 2000 ms!";
		renderL(
			<HeartbeatPanel
				nowMs={Date.now()}
				lastHeartbeat={{
					...base,
					raw: {
						ingest: { status: "CONNECTED", healthy: true, streams: [] },
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
				}}
			/>,
		);
		expect(screen.getAllByText("FIRST_CONNECT")).toHaveLength(1);
		expect(screen.getByText("WARNING")).toBeInTheDocument();
		expect(screen.getByText(KEYFRAME)).toBeInTheDocument();
		// No JSON of the details object anywhere.
		expect(screen.queryByText(/eventType/)).not.toBeInTheDocument();
	});
});

describe("HeartbeatPanel per-stream keyframe columns (the provider's real fields)", () => {
	it("renders avg / max / last-minute from keyFrameIntervalAvg, Max and the LastMinute pair", () => {
		renderL(
			<HeartbeatPanel
				nowMs={Date.now()}
				lastHeartbeat={{
					...base,
					raw: {
						ingest: {
							status: "CONNECTED",
							healthy: true,
							streams: [
								{
									streamId: "0",
									mediaType: "video",
									codec: "h264",
									width: 1280,
									height: 720,
									rate: 30,
									bitrate: 6_144_000,
									keyFrameIntervalAvg: 3956.93,
									keyFrameIntervalMax: 8334,
									keyFrameIntervalAvgLastMinute: 7418.22,
									keyFrameIntervalMaxLastMinute: 8334,
								},
							],
						},
						events: [],
					},
				}}
			/>,
		);
		expect(screen.getByText("Keyframe avg (ms)")).toBeInTheDocument();
		expect(screen.getByText("Keyframe max (ms)")).toBeInTheDocument();
		expect(screen.getByText("3957")).toBeInTheDocument();
		expect(screen.getByText("8334")).toBeInTheDocument();
		expect(screen.getByText("7418 / 8334")).toBeInTheDocument();
	});
});

/**
 * The live channel's own page — the other reading of "the live channel settings
 * page" the owner named. Its readouts are interpolated (`ingest {status}`,
 * `as of {when} (30s sweep)`, `this poll · lifetime {total}`), so reaching these
 * assertions proves the values were passed: `translate` throws on an unfilled
 * placeholder rather than rendering "{status}".
 */
describe("HeartbeatPanel — Japanese", () => {
	it("renders the ingest badge, the sweep line and the counters in Japanese", () => {
		renderL(
			<HeartbeatPanel
				nowMs={Date.now()}
				lastHeartbeat={{
					...base,
					deltas: { segmentsWritten: 12 },
				}}
			/>,
			"ja",
		);
		expect(screen.getByText("Ingest CONNECTED")).toBeInTheDocument();
		expect(screen.getByText("正常")).toBeInTheDocument();
		expect(screen.getByText(/30 秒間隔で取得/)).toBeInTheDocument();
		expect(screen.getAllByText(/累計/).length).toBeGreaterThan(0);
		for (const english of ["healthy", "30s sweep", "this poll"]) {
			expect(screen.queryByText(english), english).not.toBeInTheDocument();
		}
	});
});

describe("HeartbeatPanel — stale sample handling (review-260 127-A2/B2)", () => {
	it("a FRESH connected sample keeps the ok badge and shows no stale note", () => {
		renderL(
			<HeartbeatPanel
				nowMs={Date.now()}
				lastHeartbeat={{ ...base, at: new Date().toISOString() }}
			/>,
		);
		const badge = screen.getByText(/CONNECTED/);
		// Badge tones are class-encoded: neutral = border-zinc-700. A fresh
		// sample must NOT be neutralised.
		expect(badge.className).not.toContain("border-zinc-700");
		expect(screen.queryByText(/Sample is stale/)).not.toBeInTheDocument();
	});

	it("a sample past the vouching window goes neutral and says so — a green CONNECTED badge on frozen evidence was the #127 lie in a second place", () => {
		renderL(
			<HeartbeatPanel
				nowMs={Date.now()}
				lastHeartbeat={{
					...base,
					at: new Date(Date.now() - 10 * 60_000).toISOString(),
				}}
			/>,
		);
		const badge = screen.getByText(/CONNECTED/);
		expect(badge.className).toContain("border-zinc-700");
		expect(screen.getByText(/Sample is stale/)).toBeInTheDocument();
	});

	it("a sample stamped in the FUTURE beyond the skew tolerance is stale too (ledger #243)", () => {
		// The hand-rolled `now - at > MAX` this panel used to run was
		// one-sided: an hour-ahead stamp scored a NEGATIVE age, read as
		// not-stale, and painted the green CONNECTED badge on a sample that
		// describes no moment that has happened. The shared core helper is
		// symmetric, and this panel now asks IT.
		renderL(
			<HeartbeatPanel
				nowMs={Date.now()}
				lastHeartbeat={{
					...base,
					at: new Date(Date.now() + 60 * 60_000).toISOString(),
				}}
			/>,
		);
		const badge = screen.getByText(/CONNECTED/);
		expect(badge.className).toContain("border-zinc-700");
		expect(screen.getByText(/Sample is stale/)).toBeInTheDocument();
	});

	it("a sample a couple of seconds ahead is ordinary clock drift, not stale", () => {
		renderL(
			<HeartbeatPanel
				nowMs={Date.now()}
				lastHeartbeat={{
					...base,
					at: new Date(Date.now() + 2_000).toISOString(),
				}}
			/>,
		);
		expect(screen.queryByText(/Sample is stale/)).not.toBeInTheDocument();
	});
});

describe("HeartbeatPanel — the comparison clock is the parent's, not the viewer's (review-334, ledger #127)", () => {
	it("a sample fresh on the SERVER's clock is not stale for a viewer whose clock runs five minutes fast", () => {
		const at = "2026-08-28T12:00:00.000Z";
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(Date.parse(at) + 5 * 60_000);
		try {
			renderL(
				<HeartbeatPanel
					lastHeartbeat={{ ...base, at }}
					nowMs={Date.parse(at) + 1_000}
				/>,
			);
			expect(screen.queryByText(/Sample is stale/)).not.toBeInTheDocument();
		} finally {
			vi.useRealTimers();
		}
	});
});
