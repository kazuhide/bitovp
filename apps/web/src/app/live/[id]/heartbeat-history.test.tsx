import { fireEvent, screen, waitFor } from "@testing-library/react";
import { cloneElement, isValidElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HeartbeatHistoryResponse } from "@/app/api/live-channels/[id]/heartbeats/route";
// The REAL server-side reducer (vitest aliases `server-only` to a stub), so
// the transition guarantee is proven against the pair that ships, not a
// replica of either half.
import { downsampleHeartbeats } from "@/lib/server/heartbeat-history";
import { renderWithQuery as wrap } from "@/test/render";

// Mock the data layer so the chart renders against a fixed payload.
const apiFetch = vi.fn();
vi.mock("@/lib/api", async (orig) => ({
	...(await orig<Record<string, unknown>>()),
	apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

// Fixed-size ResponsiveContainer so the LineChart mounts under jsdom (0×0
// otherwise) — the standard Recharts-in-vitest workaround (see
// qc/[id]/vmaf-charts.test.tsx).
vi.mock("recharts", async () => {
	const actual = await vi.importActual<typeof import("recharts")>("recharts");
	return {
		...actual,
		ResponsiveContainer: ({ children }: { children: ReactNode }) =>
			isValidElement(children)
				? cloneElement(
						children as React.ReactElement<{
							width?: number;
							height?: number;
						}>,
						{ width: 800, height: 256 },
					)
				: children,
	};
});

import { HeartbeatHistory } from "./heartbeat-history";

const CHANNEL_ID = "00000000-0000-4000-8000-0000000000bb";

function point(
	at: string,
	deltas: Partial<HeartbeatHistoryResponse["points"][number]> = {},
): HeartbeatHistoryResponse["points"][number] {
	return {
		at,
		droppedPacketsVideo: 0,
		droppedPacketsAudio: 0,
		corruptPacketsVideo: 0,
		corruptPacketsAudio: 0,
		ingestStatus: "CONNECTED",
		...deltas,
	};
}

afterEach(() => {
	vi.clearAllMocks();
});

describe("HeartbeatHistory", () => {
	it("renders a line per packet-delta metric over the history", async () => {
		const response: HeartbeatHistoryResponse = {
			windowMinutes: 120,
			source: "poll",
			points: [
				point("2026-06-12T00:00:00.000Z", { droppedPacketsVideo: 1 }),
				point("2026-06-12T00:00:30.000Z", { corruptPacketsAudio: 3 }),
				point("2026-06-12T00:01:00.000Z", { droppedPacketsAudio: 2 }),
			],
		};
		apiFetch.mockResolvedValue(response);
		const { container } = wrap(
			<HeartbeatHistory channelId={CHANNEL_ID} status="RUNNING" />,
		);
		// One <Line> per series (dropped/corrupt × video/audio) = 4 curves.
		await waitFor(() =>
			expect(container.querySelectorAll(".recharts-line-curve").length).toBe(4),
		);
		// Legend labels are present.
		expect(screen.getByText("Dropped video")).toBeInTheDocument();
		expect(screen.getByText("Corrupt audio")).toBeInTheDocument();
		// Fetched from the heartbeats endpoint for this channel.
		expect(apiFetch).toHaveBeenCalledWith(
			`/api/live-channels/${CHANNEL_ID}/heartbeats`,
		);
	});

	it("legend chips are FILTER toggles: clicking one removes its line, clicking again restores (ledger #167)", async () => {
		const response: HeartbeatHistoryResponse = {
			windowMinutes: 120,
			source: "poll",
			points: [
				point("2026-06-12T00:00:00.000Z", { droppedPacketsVideo: 1 }),
				point("2026-06-12T00:00:30.000Z", { corruptPacketsAudio: 3 }),
			],
		};
		apiFetch.mockResolvedValue(response);
		const { container } = wrap(
			<HeartbeatHistory
				channelId={CHANNEL_ID}
				status="STOPPED"
				runId="00000000-0000-4000-8000-0000000000cd"
			/>,
		);
		await waitFor(() =>
			expect(container.querySelectorAll(".recharts-line-curve").length).toBe(4),
		);
		// Run-scoped fetch (the post-mortem: whole run, not the recent window).
		expect(apiFetch).toHaveBeenCalledWith(
			`/api/live-channels/${CHANNEL_ID}/heartbeats?runId=00000000-0000-4000-8000-0000000000cd`,
		);
		/* Run-scoped history uses a whole-run caption rather than a moving-window duration. */
		expect(screen.getByText(/this ENTIRE run/)).toBeInTheDocument();
		expect(screen.queryByText(/last 120 minutes/)).not.toBeInTheDocument();
		const toggle = screen.getByRole("button", { name: /Dropped video/ });
		expect(toggle).toHaveAttribute("aria-pressed", "true");
		fireEvent.click(toggle);
		await waitFor(() =>
			expect(container.querySelectorAll(".recharts-line-curve").length).toBe(3),
		);
		expect(toggle).toHaveAttribute("aria-pressed", "false");
		// WHICH series vanished (review-296 N2: hiding the wrong series also
		// passed a bare count) — identified by stroke: Dropped video is
		// #f59e0b in the SERIES table, and its curve must be the missing one.
		const strokes = [...container.querySelectorAll(".recharts-line-curve")].map(
			(el) => el.getAttribute("stroke"),
		);
		expect(strokes).toHaveLength(3);
		expect(strokes).not.toContain("#f59e0b");
		expect(strokes).toContain("#fbbf24");
		fireEvent.click(toggle);
		await waitFor(() =>
			expect(container.querySelectorAll(".recharts-line-curve").length).toBe(4),
		);
	});

	it("marks ingest-status changes with reference dots", async () => {
		apiFetch.mockResolvedValue({
			windowMinutes: 120,
			source: "poll",
			points: [
				point("2026-06-12T00:00:00.000Z"),
				point("2026-06-12T00:00:30.000Z", { ingestStatus: "DISCONNECTED" }),
				point("2026-06-12T00:01:00.000Z", { ingestStatus: "CONNECTED" }),
			],
		} satisfies HeartbeatHistoryResponse);
		const { container } = wrap(
			<HeartbeatHistory channelId={CHANNEL_ID} status="RUNNING" />,
		);
		// Baseline + the two transitions = 3 status-change dots.
		await waitFor(() =>
			expect(container.querySelectorAll(".recharts-reference-dot").length).toBe(
				3,
			),
		);
	});

	it("positions an OFF-GRID alert dot truthfully — the production case (review-83b C2)", async () => {
		// Alert openedAt comes from the engine's clock, the samples from the
		// poll's — they NEVER match byte-for-byte. On the old category axis
		// every such dot collapsed to the left border (cx=0, plot start 36):
		// the reviewer measured off-by-1ms → cx=0. The numeric epoch axis
		// places it between its neighbours.
		apiFetch.mockResolvedValue({
			windowMinutes: 120,
			source: "poll",
			points: [
				point("2026-06-12T00:00:00.000Z"),
				point("2026-06-12T00:01:00.000Z"),
			],
		} satisfies HeartbeatHistoryResponse);
		const { container } = wrap(
			<HeartbeatHistory
				channelId={CHANNEL_ID}
				status="RUNNING"
				alertMarks={[
					// 30s into a 60s window — matches NO sample timestamp.
					{ id: "ev-1", at: "2026-06-12T00:00:30.123Z", severity: "CRIT" },
				]}
			/>,
		);
		await waitFor(() =>
			expect(container.querySelectorAll(".recharts-reference-dot").length).toBe(
				2, // status baseline + the alert
			),
		);
		const critDot = [...container.querySelectorAll("circle")].find(
			(circle) => circle.getAttribute("fill") === "#ef4444",
		);
		if (!critDot) {
			throw new Error("CRIT dot not rendered");
		}
		const cx = Number(critDot.getAttribute("cx"));
		const width = 600; // the mocked ResponsiveContainer size
		// Strictly inside the plot, roughly midway — never the left border.
		expect(cx).toBeGreaterThan(100);
		expect(cx).toBeLessThan(width);
	});

	it("severity decides WHICH mark is red — the relation, not the count (review-83b I7)", async () => {
		// The old count-based assertion survived a full red/amber inversion.
		apiFetch.mockResolvedValue({
			windowMinutes: 120,
			source: "poll",
			points: [
				point("2026-06-12T00:00:00.000Z"),
				point("2026-06-12T00:01:00.000Z"),
			],
		} satisfies HeartbeatHistoryResponse);
		const { container } = wrap(
			<HeartbeatHistory
				channelId={CHANNEL_ID}
				status="RUNNING"
				alertMarks={[
					{ id: "ev-crit", at: "2026-06-12T00:00:45.000Z", severity: "CRIT" },
					{ id: "ev-warn", at: "2026-06-12T00:00:15.000Z", severity: "WARN" },
				]}
			/>,
		);
		await waitFor(() =>
			expect(container.querySelectorAll(".recharts-reference-dot").length).toBe(
				3,
			),
		);
		const circles = [...container.querySelectorAll("circle")].filter((c) =>
			["#ef4444", "#f59e0b"].includes(c.getAttribute("fill") ?? ""),
		);
		const red = circles.filter((c) => c.getAttribute("fill") === "#ef4444");
		const amber = circles.filter((c) => c.getAttribute("fill") === "#f59e0b");
		expect(red).toHaveLength(1);
		// The RED dot sits at the LATER timestamp (00:00:45 > 00:00:15):
		// its cx must exceed every amber alert dot's. Swapping the severity
		// colors flips this relation and fails here.
		const redCx = Number(red[0]?.getAttribute("cx"));
		for (const amberDot of amber) {
			expect(redCx).toBeGreaterThan(Number(amberDot.getAttribute("cx")));
		}
	});

	it("shows the empty state when there is no history yet", async () => {
		apiFetch.mockResolvedValue({
			windowMinutes: 120,
			source: "poll",
			points: [],
		} satisfies HeartbeatHistoryResponse);
		wrap(<HeartbeatHistory channelId={CHANNEL_ID} status="RUNNING" />);
		expect(
			await screen.findByText(/no heartbeat history yet/i),
		).toBeInTheDocument();
	});

	it("a FAILED fetch reads as unavailable, never as 'no history yet' — audit 4403130 IMPORTANT-2", async () => {
		// The defect: `history.data?.points ?? []` made a rejected query
		// indistinguishable from an empty window, and a post-mortem of a run
		// that HAD heartbeats told its reader there had never been any.
		apiFetch.mockRejectedValue(new Error("502 from the heartbeats route"));
		const { container } = wrap(
			<HeartbeatHistory channelId={CHANNEL_ID} status="RUNNING" />,
		);
		await waitFor(() =>
			expect(
				container.querySelector("[data-heartbeat-unavailable]"),
			).not.toBeNull(),
		);
		expect(screen.queryByText(/no heartbeat history yet/i)).toBeNull();
		expect(screen.getByRole("status")).toHaveTextContent(/could not be read/i);
	});

	it("a short disconnect inside a 2,000-poll run still draws both dots after the SERVER's downsample — audit 4403130 IMPORTANT-2", async () => {
		// End to end over the real pair: the server reducer thins the series,
		// this component derives the status dots from what survives. Before
		// the fix the reducer kept only each bucket's max-packet-delta point,
		// so this excursion — quiet counters, loud spike elsewhere — was
		// deleted and the chart drew ONE dot over an unbroken CONNECTED line.
		const full = Array.from({ length: 2_000 }, (_, i) =>
			point(
				new Date(
					Date.parse("2026-08-29T00:00:00.000Z") + i * 30_000,
				).toISOString(),
				i === 1_000 || i === 1_001
					? { ingestStatus: "DISCONNECTED" }
					: i === 1_500
						? { droppedPacketsVideo: 9_999 }
						: {},
			),
		);
		apiFetch.mockResolvedValue({
			windowMinutes: 360,
			source: "poll",
			points: downsampleHeartbeats(full),
		} satisfies HeartbeatHistoryResponse);
		const { container } = wrap(
			<HeartbeatHistory channelId={CHANNEL_ID} status="RUNNING" />,
		);
		await waitFor(() =>
			expect(container.querySelectorAll(".recharts-line-curve").length).toBe(4),
		);
		// Three status dots — the opening CONNECTED, the drop, the recovery —
		// exactly what the FULL series would have produced. No alert marks
		// are passed, so every reference dot here is a status change.
		expect(container.querySelectorAll(".recharts-reference-dot").length).toBe(
			3,
		);
	});
});

describe("HeartbeatHistory incoming-bitrate overlay", () => {
	it("adds a right-axis incoming-bitrate line when the payload carries it (push cadence)", async () => {
		const response: HeartbeatHistoryResponse = {
			windowMinutes: 120,
			source: "push",
			points: [
				point("2026-06-12T00:00:00.000Z", { incomingBitrate: 5_000_000 }),
				point("2026-06-12T00:00:02.000Z", {
					incomingBitrate: 4_800_000,
					droppedPacketsVideo: 2,
				}),
				point("2026-06-12T00:00:04.000Z", { incomingBitrate: 5_100_000 }),
			],
		};
		apiFetch.mockResolvedValue(response);
		const { container } = wrap(
			<HeartbeatHistory channelId={CHANNEL_ID} status="RUNNING" />,
		);
		// 4 packet lines + 1 incoming-bitrate line = 5 curves.
		await waitFor(() =>
			expect(container.querySelectorAll(".recharts-line-curve").length).toBe(5),
		);
		expect(screen.getByText("In Mbps")).toBeInTheDocument();
	});

	it("omits the incoming line when no sample carries an incoming bitrate", async () => {
		const response: HeartbeatHistoryResponse = {
			windowMinutes: 120,
			source: "poll",
			points: [
				point("2026-06-12T00:00:00.000Z", { droppedPacketsVideo: 1 }),
				point("2026-06-12T00:00:30.000Z", { corruptPacketsAudio: 2 }),
			],
		};
		apiFetch.mockResolvedValue(response);
		const { container } = wrap(
			<HeartbeatHistory channelId={CHANNEL_ID} status="RUNNING" />,
		);
		await waitFor(() =>
			expect(container.querySelectorAll(".recharts-line-curve").length).toBe(4),
		);
		expect(screen.queryByText("In Mbps")).toBeNull();
	});
});
