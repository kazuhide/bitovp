import { act, renderHook, screen, within } from "@testing-library/react";
import { cloneElement, isValidElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderWithQuery as wrap } from "@/test/render";
import type { HeartbeatReception } from "../live-shared";

const apiFetch = vi.fn();
vi.mock("@/lib/api", async (orig) => ({
	...(await orig<Record<string, unknown>>()),
	apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

// Fixed-size ResponsiveContainer so the LineChart mounts under jsdom (0×0
// otherwise) — the standard Recharts-in-vitest workaround (see
// heartbeat-history.test.tsx, which this mirrors).
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
						{ width: 600, height: 224 },
					)
				: children,
	};
});

import { StreamHealth, useTickingNow } from "./stream-health";

/**
 * Stream health (2026-08-23; graph redesigned 2026-08-24, ; axis
 * re-anchored to RUNNING the same day, owner follow-up): the lamps must
 * reflect the DERIVED latest point; the chart's axis starts at ENCODER
 * RUNNING (the queue wait is a FIGURE, not a band); event marks must not
 * collapse to the left border (review-83b C2's category-axis defect,
 * re-pinned because every event time comes from a clock the poll rows never
 * carry); and the event list in words beneath carries ALL events including
 * the pre-RUNNING ones the plot deliberately clips.
 */

// Clock-relative (review-294 S7): live mode derives the axis end from the
// REAL clock, and the old fixed 2025 epoch stretched the zero-heartbeat
// test's axis to ~10 months — a 0.002px band whose presence pins held while
// any geometry assertion would have measured a degenerate chart.
const T0 = Date.now() - 300_000;

function timeline(overrides: Partial<Record<string, unknown>> = {}) {
	return {
		window: { startMs: T0 - 120_000, endMs: T0 + 60_000 },
		events: [
			{ kind: "START_REQUESTED", atMs: T0 - 120_000, source: "steplog" },
			// Deliberately OFF-GRID: 7s past the first sample, matching no
			// poll row — the C2 pin's subject.
			{ kind: "ENCODER_QUEUED", atMs: T0 - 113_000, source: "steplog" },
			{ kind: "ENCODER_RUNNING", atMs: T0 - 30_000, source: "run" },
			{ kind: "INPUT_CONNECTED", atMs: T0, source: "heartbeat" },
			{ kind: "OUTPUT_ACTIVE", atMs: T0, source: "heartbeat" },
			{ kind: "CONTENT_INSERTED", atMs: T0 + 10_000, source: "action" },
			{ kind: "ENCODER_STOPPED", atMs: T0 + 60_000, source: "run" },
		],
		...overrides,
	};
}

function health(overrides: Partial<Record<string, unknown>> = {}) {
	return {
		points: [
			{ atMs: T0, ingest: true, encoder: true, output: true },
			{ atMs: T0 + 30_000, ingest: true, encoder: true, output: false },
		],
		lanes: {
			ingest: [{ fromMs: T0, toMs: T0 + 30_000 }],
			encoder: [{ fromMs: T0, toMs: T0 + 30_000 }],
			output: [{ fromMs: T0, toMs: T0 }],
		},
		latest: { atMs: T0 + 30_000, ingest: true, encoder: true, output: false },
		run: {
			id: "run-1",
			seq: 3,
			status: "RUNNING",
			createdAt: new Date(T0).toISOString(),
			queueSeconds: 90,
		},
		truncated: false,
		outputObservable: true,
		timeline: timeline(),
		...overrides,
	};
}

describe("StreamHealth", () => {
	it("overlays same-run Push events at provider time while retaining Poll lines and provenance", async () => {
		apiFetch.mockResolvedValue(health());
		const reception: HeartbeatReception = {
			state: "available",
			runId: "run-1",
			configuredIntervalS: 20,
			latest: null,
			previousReceivedAt: null,
			timeline: {
				coverage: "recent-receipts",
				truncated: true,
				events: [
					{
						kind: "FIRST_CONNECT",
						eventAt: new Date(T0 - 5_000).toISOString(),
						observedReceivedAt: new Date(T0 + 1_000).toISOString(),
					},
					{
						kind: "DISCONNECT",
						eventAt: new Date(T0 + 10_000).toISOString(),
						observedReceivedAt: new Date(T0 + 11_000).toISOString(),
					},
					{
						kind: "RECONNECT",
						eventAt: new Date(T0 + 20_000).toISOString(),
						observedReceivedAt: new Date(T0 + 21_000).toISOString(),
					},
				],
			},
		};
		const view = wrap(
			<StreamHealth
				channelId="ch-1"
				runId="run-1"
				mode="finished"
				reception={reception}
			/>,
		);
		await screen.findByRole("img", { name: /Broadcast timeline/ });
		const items = within(screen.getByRole("list", { name: "" })).getAllByRole(
			"listitem",
		);
		expect(
			items.filter((li) => li.textContent?.includes("Input connected")),
		).toHaveLength(1);
		expect(
			items.find((li) => li.textContent?.includes("Input connected")),
		).toHaveTextContent("Push");
		expect(
			items.find((li) => li.textContent?.includes("Input reconnected")),
		).toHaveTextContent("Push");
		expect(
			items.find((li) => li.textContent?.includes("Output active")),
		).toHaveTextContent("Poll");
		expect(view.container.querySelectorAll(".recharts-line")).toHaveLength(4);
		expect(
			screen.getByRole("link", { name: "Go to Push receipt log" }),
		).toHaveAttribute("href", "#sec-heartbeat-log");
	});
	it("ignores another run's Push history, including its cap warning", async () => {
		apiFetch.mockResolvedValue(health());
		wrap(
			<StreamHealth
				channelId="ch-1"
				runId="run-1"
				mode="finished"
				reception={{
					state: "available",
					runId: "old-run",
					configuredIntervalS: 20,
					latest: null,
					previousReceivedAt: null,
					timeline: {
						coverage: "recent-receipts",
						truncated: true,
						events: [
							{
								kind: "RECONNECT",
								eventAt: new Date(T0).toISOString(),
								observedReceivedAt: new Date(T0).toISOString(),
							},
						],
					},
				}}
			/>,
		);
		await screen.findByRole("img", { name: /Broadcast timeline/ });
		expect(screen.queryByText("Input reconnected")).not.toBeInTheDocument();
		expect(
			screen.queryByRole("link", { name: "Go to Push receipt log" }),
		).not.toBeInTheDocument();
	});
	it("timeline-only mode hides duplicate lamps but retains stale evidence", async () => {
		apiFetch.mockResolvedValue(health());
		const view = wrap(
			<StreamHealth channelId="ch-1" runId="run-1" mode="live" lamps={false} />,
		);
		await screen.findByRole("img", { name: /Broadcast timeline/ });
		expect(screen.queryByText("Healthy")).not.toBeInTheDocument();
		view.unmount();
		apiFetch.mockResolvedValue(health({ latest: undefined }));
		wrap(
			<StreamHealth channelId="ch-1" runId="run-1" mode="live" lamps={false} />,
		);
		expect(await screen.findByRole("alert")).toHaveTextContent(
			"No Poll status sample within 90 seconds",
		);
	});

	it("live mode: lamps reflect the latest derived point — output down shows red", async () => {
		apiFetch.mockResolvedValue(health());
		wrap(<StreamHealth channelId="ch-1" runId="run-1" mode="live" />);
		// Labels appear in the lamps and again in the chart's y ticks/series,
		// so presence is getAllByText.
		expect((await screen.findAllByText("Input")).length).toBeGreaterThan(0);
		expect(screen.getAllByText("Encoder").length).toBeGreaterThan(0);
		expect(screen.getAllByText("Output").length).toBeGreaterThan(0);
		expect(screen.getAllByText("Healthy")).toHaveLength(2);
		expect(screen.getAllByText("Not detected")).toHaveLength(1);
	});

	it("finished mode: renders the timeline chart and the event list, no lamps", async () => {
		apiFetch.mockResolvedValue(health());
		wrap(<StreamHealth channelId="ch-1" runId="run-1" mode="finished" />);
		expect(
			await screen.findByRole("img", { name: /Broadcast timeline/ }),
		).toBeInTheDocument();
		// The event list carries every event, in words, in order.
		const list = screen.getByRole("list", { name: "" });
		const items = within(list)
			.getAllByRole("listitem")
			.map((li) => li.textContent ?? "");
		expect(items).toHaveLength(7);
		expect(items[0]).toMatch(/Start requested/);
		expect(items[1]).toMatch(/Queued/);
		expect(items[2]).toMatch(/Encoder running/);
		expect(items[3]).toMatch(/Input connected/);
		expect(items[4]).toMatch(/Output active/);
		expect(items[5]).toMatch(/Content insertion scheduled/);
		expect(items[6]).toMatch(/Encoder stopped/);
		// The startup FIGURE (owner: the axis hides the wait, the number must
		// say it): RUNNING(T0-30s) − start request(T0-120s) = 90s.
		expect(
			screen.getByText(/Encoder startup time: 1m 30s/),
		).toBeInTheDocument();
		// No lamp verdict words in finished mode.
		expect(screen.queryByText("Healthy")).not.toBeInTheDocument();
	});

	it("event dots render INSIDE the plot on the numeric axis — never collapsed to the left border (review-83b C2)", async () => {
		apiFetch.mockResolvedValue(health());
		const { container } = wrap(
			<StreamHealth channelId="ch-1" runId="run-1" mode="finished" />,
		);
		await screen.findByRole("img", { name: /Broadcast timeline/ });
		// CONTENT_INSERTED sits at T0+10s — matching NO data row. On a
		// category axis it would collapse to cx=0; on the numeric axis it must
		// land at its numeric position. All 7 events render as DOM circles —
		// ifOverflow=hidden CLIPS via clipPath rather than discarding
		// (review-294 N5, measured), so the two pre-RUNNING dots exist in the
		// DOM while sitting left of the RUNNING-anchored domain's visible
		// plot.
		const dots = [
			...container.querySelectorAll("circle"),
		] as SVGCircleElement[];
		expect(dots.length).toBeGreaterThanOrEqual(7);
		const xs = dots.map((c) => Number(c.getAttribute("cx")));
		// The clipped pre-RUNNING pair maps to NEGATIVE cx (left of the
		// plot, behind the clipPath); the anti-collapse property applies to
		// the in-domain population: five dots, all at positive positions,
		// SPREAD across the axis (a category axis stacks them at cx=0).
		const inPlot = xs.filter((x) => Number.isFinite(x) && x > 0);
		expect(inPlot.length).toBeGreaterThanOrEqual(5);
		expect(new Set(inPlot.map((x) => Math.round(x))).size).toBeGreaterThan(3);
		// The NEGATIVE side is the owner's ask (review-295 I1: without this,
		// reverting the axis anchor to window.startMs survived 3112 tests —
		// with the axis at the start request, all 7 dots sit at x > 0 and
		// the in-plot count still passes). Exactly the two pre-RUNNING dots
		// must fall left of the plot.
		expect(xs.filter((x) => x < 0)).toHaveLength(2);
	});

	it("still allocating (no RUNNING yet): NO chart, a ticking elapsed figure instead (owner follow-up)", async () => {
		// The owner's axis-from-RUNNING rule: the queue wait must not be a
		// picture. Before RUNNING there is nothing to chart — the wait is a
		// NUMBER (elapsed, off the same ticking clock as the axis).
		apiFetch.mockResolvedValue(
			health({
				points: [],
				latest: undefined,
				lanes: { ingest: [], encoder: [], output: [] },
				timeline: timeline({
					window: { startMs: T0 - 120_000 },
					events: [
						{ kind: "START_REQUESTED", atMs: T0 - 120_000, source: "steplog" },
						{ kind: "ENCODER_QUEUED", atMs: T0 - 113_000, source: "steplog" },
					],
				}),
			}),
		);
		wrap(<StreamHealth channelId="ch-1" runId="run-1" mode="live" />);
		expect(
			await screen.findByText(/Encoder starting — .* elapsed/),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("img", { name: /Broadcast timeline/ }),
		).not.toBeInTheDocument();
	});

	it("just-RUNNING with zero heartbeat rows still draws the chart's dots (review-294 C3's mechanism)", async () => {
		// data=[] builds no scales and every ReferenceDot silently returns
		// null (C3) — the _axis anchors keep the scales alive so the RUNNING
		// mark renders before the first poll lands.
		apiFetch.mockResolvedValue(
			health({
				points: [],
				latest: undefined,
				lanes: { ingest: [], encoder: [], output: [] },
				timeline: timeline({
					window: { startMs: T0 - 120_000 },
					events: [
						{ kind: "START_REQUESTED", atMs: T0 - 120_000, source: "steplog" },
						{ kind: "ENCODER_QUEUED", atMs: T0 - 113_000, source: "steplog" },
						{ kind: "ENCODER_RUNNING", atMs: T0 - 30_000, source: "run" },
					],
				}),
			}),
		);
		const { container } = wrap(
			<StreamHealth channelId="ch-1" runId="run-1" mode="live" />,
		);
		await screen.findByRole("img", { name: /Broadcast timeline/ });
		// The wrapper role is NOT the pin (review-294 I3) — the painted dot is.
		const dots = container.querySelectorAll("circle");
		expect(dots.length).toBeGreaterThanOrEqual(1);
		expect(screen.getAllByRole("listitem")).toHaveLength(3);
		// The figure appears the moment RUNNING does — from the MEASURED
		// queueSeconds, the single source (review-295 I3 cut the fallback).
		expect(
			screen.getByText(/Encoder startup time: 1m 30s/),
		).toBeInTheDocument();
	});

	it("the figure's source is queueSeconds, and without it NO figure — never the resumed-provision arithmetic (review-295 I2+I3)", async () => {
		// 12s against what the cut fallback would derive (90s): the render
		// proves the source. Then queueSeconds absent → absence, because the
		// events-derived number reads ~20h on a resumed provision (the
		// recorded startup-sample defect). The ABSENCE half is the load-
		// bearing one (review-295 round 3, measured): `12 ?? derived` is
		// still 12, so the render pin survives a re-added fallback — only
		// the null arm kills it. Do not drop it as redundant.
		apiFetch.mockResolvedValue(
			health({
				run: {
					id: "run-1",
					seq: 3,
					status: "RUNNING",
					createdAt: new Date(T0).toISOString(),
					queueSeconds: 12,
				},
			}),
		);
		const first = wrap(
			<StreamHealth channelId="ch-1" runId="run-1" mode="finished" />,
		);
		expect(
			await screen.findByText(/Encoder startup time: 12s/),
		).toBeInTheDocument();
		first.unmount();
		apiFetch.mockResolvedValue(
			health({
				run: {
					id: "run-1",
					seq: 3,
					status: "RUNNING",
					createdAt: new Date(T0).toISOString(),
					queueSeconds: null,
				},
			}),
		);
		const second = wrap(
			<StreamHealth channelId="ch-2" runId="run-2" mode="finished" />,
		);
		await second.findByRole("img", { name: /Broadcast timeline/ });
		expect(second.queryByText(/Encoder startup time/)).not.toBeInTheDocument();
	});

	it("heartbeats without a recorded RUNNING never claim 'starting' — the chart is the evidence (review-295 I4)", async () => {
		// The legacy population (mirror never wrote runningSince): points
		// exist, no ENCODER_RUNNING event. The chart renders (axis falls
		// back to the window start) and the amber elapsed line must NOT sit
		// above a healthy broadcast.
		apiFetch.mockResolvedValue(
			health({
				latest: undefined,
				timeline: timeline({
					window: { startMs: T0 - 120_000 },
					events: [
						{ kind: "START_REQUESTED", atMs: T0 - 120_000, source: "steplog" },
					],
				}),
			}),
		);
		wrap(<StreamHealth channelId="ch-1" runId="run-1" mode="live" />);
		expect(
			await screen.findByRole("img", { name: /Broadcast timeline/ }),
		).toBeInTheDocument();
		expect(
			screen.queryByText(/Encoder starting — .* elapsed/),
		).not.toBeInTheDocument();
	});

	it("stale ≠ empty: points exist but latest expired → a LOUD alert, not 'nothing yet' (review-293 I1)", async () => {
		apiFetch.mockResolvedValue(health({ latest: undefined }));
		wrap(<StreamHealth channelId="ch-1" runId="run-1" mode="live" />);
		expect(await screen.findByRole("alert")).toHaveTextContent(
			/No Poll status sample within 90 seconds/,
		);
		expect(
			screen.queryByText(/No Poll status samples/),
		).not.toBeInTheDocument();
	});

	it("says so when a finished run has no samples", async () => {
		apiFetch.mockResolvedValue(
			health({
				points: [],
				latest: undefined,
				lanes: { ingest: [], encoder: [], output: [] },
			}),
		);
		wrap(<StreamHealth channelId="ch-1" runId="run-1" mode="finished" />);
		expect(
			await screen.findByText(/No Poll status samples/),
		).toBeInTheDocument();
	});

	it("greys the OUTPUT lamp on a DASH-only plan — unobservable, never red (N3)", async () => {
		apiFetch.mockResolvedValue(health({ outputObservable: false }));
		wrap(<StreamHealth channelId="ch-1" runId="run-1" mode="live" />);
		expect(await screen.findByText(/Not measurable/)).toBeInTheDocument();
		expect(screen.queryAllByText("Not detected")).toHaveLength(0);
	});

	it("surfaces the truncation note — a cut-off timeline must say WHICH end was cut (the route keeps the newest 24 h)", async () => {
		apiFetch.mockResolvedValue(health({ truncated: true }));
		wrap(<StreamHealth channelId="ch-1" runId="run-1" mode="live" />);
		// The route flipped to desc + reverse when retention grew past the cap
		// (review-292 N5 / rev405 R2): the note must say the EARLIER samples
		// are gone, not the later ones.
		expect(
			await screen.findByText(/last 24 hours.*earlier samples were cut off/),
		).toBeInTheDocument();
		expect(screen.queryByText(/first 24 hours/)).not.toBeInTheDocument();
	});

	it("the live axis clock TICKS — and holds still when inactive (owner: リアルタイム描画)", () => {
		// The tick is what advances the chart's right edge between data
		// arrivals; without it the axis end freezes at mount time and the
		// 'live' chart visibly stops. Fake timers drive both the interval
		// and Date.now (vitest fakes Date by default).
		vi.useFakeTimers();
		try {
			const live = renderHook(() => useTickingNow(true, 2_000));
			const first = live.result.current;
			act(() => {
				vi.advanceTimersByTime(6_100);
			});
			expect(live.result.current).toBeGreaterThan(first);
			const finished = renderHook(() => useTickingNow(false, 2_000));
			const initial = finished.result.current;
			act(() => {
				vi.advanceTimersByTime(10_000);
			});
			expect(finished.result.current).toBe(initial);
			// The cleanup line was the one unguarded mutation in review-294's
			// kill battery (C: deleting clearInterval left 9/9 green) — the
			// reviewer's own closer, adopted: after unmount no timer survives.
			live.unmount();
			finished.unmount();
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});
});
