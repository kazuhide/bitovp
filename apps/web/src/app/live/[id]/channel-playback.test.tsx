import type { ManifestPlaybackLink } from "@bitovp/core";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithQuery as wrap } from "@/test/render";

const apiFetch = vi.fn();
vi.mock("@/lib/api", () => {
	class ApiError extends Error {
		constructor(
			readonly status: number,
			message: string,
		) {
			super(message);
			this.name = "ApiError";
		}
	}
	return { apiFetch: (...args: unknown[]) => apiFetch(...args), ApiError };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

const loaded: string[] = [];
/** Captured so a live playback failure can actually be driven, not assumed. */
let fatal: (() => void) | null = null;
vi.mock("hls.js", () => {
	class Hls {
		static Events = { ERROR: "hlsError" };
		static isSupported() {
			return true;
		}
		on(event: string, cb: (e: unknown, data: unknown) => void) {
			if (event === "hlsError") {
				fatal = () => cb("hlsError", { fatal: true, type: "networkError" });
			}
		}
		loadSource(url: string) {
			loaded.push(url);
		}
		attachMedia() {}
		startLoad() {}
		stopLoad() {}
		destroy() {}
	}
	return { default: Hls };
});
vi.mock("shaka-player", () => ({
	default: {
		polyfill: { installAll() {} },
		Player: class {
			static isBrowserSupported() {
				return true;
			}
			addEventListener() {}
			removeEventListener() {}
			async attach() {}
			configure() {}
			async load() {}
			async destroy() {}
		},
	},
}));

import { ChannelDetail } from "./channel-detail";

const CHANNEL = "00000000-0000-4000-8000-0000000000bb";
const HLS_URL = "https://cdn.example.com/output/live/stream.m3u8";

function link(over: Partial<ManifestPlaybackLink> = {}): ManifestPlaybackLink {
	return {
		key: "hls",
		kind: "HLS",
		label: "Live HLS Manifest",
		url: HLS_URL,
		path: "output/live/stream.m3u8",
		via: "publicBaseUrls",
		...over,
	};
}

/** A current run whose local lifecycle claims have fresh Bitmovin evidence. */
function confirmedRun(status: "RUNNING" | "ERROR") {
	const now = new Date().toISOString();
	return {
		id: "run-1",
		seq: 1,
		status,
		bitmovinEncodingId: "enc-1",
		encoderIp: null,
		streamKey: null,
		outputPrefix: "output/live/",
		runningSince: status === "RUNNING" ? now : null,
		endedAt: null,
		programStartAt: null,
		programEndAt: null,
		error: status === "ERROR" ? "fixture error" : null,
		lastHeartbeat: null,
		lastHeartbeatAt: null,
		stepLog: [],
		liveToVod: null,
		originObservation: null,
		createdAt: "2026-08-11T00:00:00.000Z",
		providerStatus: "RUNNING",
		providerStatusObservedAt: now,
		providerUnknownSince: null,
		providerTerminalAt: null,
	};
}

/**
 * A RUNNING run whose origin observer has just seen every playlist advance —
 * the minimal shape the other run-bearing fixtures in this file use, so no
 * run-keyed query (health, heartbeats) falls into the channel catch-all.
 */
function advancingRun() {
	return {
		seq: 1,
		status: "RUNNING",
		lastHeartbeat: null,
		originObservation: {
			lastFetchAtMs: Date.now(),
			lastVerdicts: {
				hls: { stale: false, endlist: false, edgeDelaySeconds: null },
			},
		},
	};
}

function channelRow(over: Record<string, unknown> = {}) {
	return {
		id: CHANNEL,
		name: "Verification channel",
		status: "RUNNING",
		labels: [],
		region: "ap-northeast-1",
		protocol: "RTMP",
		bitmovinEncodingId: "enc-1",
		createdAt: "2026-08-11T00:00:00.000Z",
		updatedAt: "2026-08-11T00:00:00.000Z",
		plan: {},
		stepLog: [],
		streamKey: null,
		encoderIp: null,
		lastHeartbeat: null,
		liveToVod: null,
		...over,
	};
}

function mockChannel(over: Record<string, unknown> = {}) {
	apiFetch.mockImplementation(async (input: string) => {
		// The schedules list  shares the channel path prefix and
		// must answer an ARRAY — handing it the channel row crashed the whole
		// detail render when the panel mounted.
		if (input.endsWith("/schedules")) {
			return [];
		}
		// The alerts endpoint  shares the channel path prefix and
		// must answer its own shape — the channel row would crash the panel.
		if (input.endsWith("/alerts")) {
			return { open: [], history: [] };
		}
		if (input.includes("/runs/") && input.endsWith("/health")) {
			// Stream health (2026-08-23): the finished lead mounts StreamHealth,
			// whose fetch must not fall into the channel catch-all below (a
			// channel payload has no points[] and the component throws).
			// timeline : the two provisioning-phase events, so the
			// starting-lead pin below can see the chart + list render.
			return {
				points: [],
				lanes: { ingest: [], encoder: [], output: [] },
				run: {
					id: "run-1",
					seq: 1,
					status: "STOPPED",
					createdAt: "2026-08-23T00:00:00Z",
				},
				truncated: false,
				outputObservable: true,
				timeline: {
					window: { startMs: 1_760_000_000_000 },
					events: [
						{
							kind: "START_REQUESTED",
							atMs: 1_760_000_000_000,
							source: "steplog",
						},
						{
							kind: "ENCODER_QUEUED",
							atMs: 1_760_000_002_000,
							source: "steplog",
						},
					],
				},
			};
		}
		if (input.startsWith(`/api/live-channels/${CHANNEL}`)) {
			return channelRow(over);
		}
		return { items: [] };
	});
}

/**
 * : the full manifest URL list moved behind a disclosure inside the
 * manifests section, which is open by default on air. Tests that assert on a
 * URL or on a not-public REASON open it first.
 */
const openManifestUrls = async () =>
	userEvent.click(
		await screen.findByRole("button", { name: "Show every manifest URL" }),
	);

beforeEach(() => {
	vi.clearAllMocks();
	loaded.length = 0;
	fatal = null;
});

/**
 * Live playback : the same panel as the job page, on
 * the channel page. What is live-specific is WHEN it may appear — a stopped
 * channel's manifest still exists but nothing appends to it, so a player would
 * stall at the last segment and report an error that is not one.
 */
describe("live-screen wording — the owner's intent, not exact copy (ledger #124 / review-260 124-A5)", () => {
	it("renders the ja detail in THREE phases with no surviving ラン/アクション outside the loan-word list", async () => {
		/* Exercise every lifecycle phase because action links differ between phases. */
		const phases: Parameters<typeof mockChannel>[0][] = [
			{
				lastHeartbeat: {
					at: new Date().toISOString(),
					raw: { ingest: { status: "CONNECTED", healthy: true } },
					deltas: {},
				},
			},
			{ status: "STOPPED", bitmovinEncodingId: "enc-1" },
			{ status: "ERROR", bitmovinEncodingId: "enc-1" },
		];
		for (const phase of phases) {
			mockChannel(phase);
			const view = wrap(<ChannelDetail id={CHANNEL} />, "ja");
			await screen.findByRole("region", { name: /チャンネルの状況/ });
			const text = document.body.textContent ?? "";
			/* Remove legitimate borrowed technical terms before checking that the remaining operator copy is localized. */
			const stripped = text.replace(
				/スケジュールアクション|プラン|ブランド|トランス|バランス|ランタイム|ランダム|ランナー|ランディング|フランス|ランキング/g,
				"",
			);
			expect(stripped).not.toMatch(/ラン/);
			expect(stripped).not.toMatch(/アクション/);
			view.unmount();
		}
	});
});

describe("the contextual lead follows the airing's life (ledger #126)", () => {
	it("準備: ingest coordinates lead the page and appear exactly once", async () => {
		mockChannel({ status: "CREATED", bitmovinEncodingId: null });
		const view = wrap(<ChannelDetail id={CHANNEL} />);
		await screen.findByRole("region", { name: /next action/i });
		const ingest = document.querySelectorAll("#sec-ingest");
		expect(ingest).toHaveLength(1);
		// : the lead renders above the BODY LAYERS (the lifecycle
		// controls moved into the fixed header, so `sec-actions` is now first
		// on the page by design and is the wrong thing to compare against).
		const ids = Array.from(
			document.querySelectorAll("[id^='sec-'], [id^='layer-']"),
		).map((el) => el.id);
		expect(ids.indexOf("sec-ingest")).toBeLessThan(
			ids.indexOf("layer-operations"),
		);
		// And it is the always-open FlatSection form, not the foldable one.
		expect(document.getElementById("sec-ingest")?.tagName).toBe("SECTION");
		view.unmount();
	});

	it("起動中: the step progress line joins the lead", async () => {
		mockChannel({ status: "PROVISIONING" });
		const view = wrap(<ChannelDetail id={CHANNEL} />);
		await screen.findByRole("region", { name: /next action/i });
		expect(document.querySelectorAll("#sec-ingest")).toHaveLength(1);
		// review-260 126-A4→B1: the line itself, SCOPED to the lead —
		// summaryStepsDone also renders in the sec-steps fold's summary in
		// every phase, so a body-wide match was satisfied by the wrong node
		// (presence is not association; second miss on this assertion, which
		// is the argument for anchoring to an element).
		const lead = document.querySelector('[data-phase-lead="starting"]');
		expect(lead).not.toBeNull();
		expect((lead as HTMLElement).textContent).toMatch(/0\/0/);
		view.unmount();
	});

	it("終了後: the ONE HeartbeatHistory is run-scoped — the recent-2h window is empty for an old run (review-296 S5/I7)", async () => {
		mockChannel({
			status: "STOPPED",
			currentRun: {
				id: "run-1",
				seq: 3,
				status: "STOPPED",
				lastHeartbeat: null,
			},
		});
		const view = wrap(<ChannelDetail id={CHANNEL} />);
		await screen.findByRole("region", { name: /next action/i });
		await waitFor(() => {
			expect(
				apiFetch.mock.calls.some(
					([url]) =>
						typeof url === "string" && url.includes("/heartbeats?runId=run-1"),
				),
			).toBe(true);
		});
		// And the WINDOWED fetch must not also fire — one instance, one scope.
		expect(
			apiFetch.mock.calls.some(
				([url]) => typeof url === "string" && url.endsWith("/heartbeats"),
			),
		).toBe(false);
		view.unmount();
	});

	it("起動中: the delivery panel shows the ticking startup elapsed figure, and no chart", async () => {
		// The owner's axis-from-RUNNING rule: during allocation there is
		// nothing to chart — the wait is a NUMBER. StreamHealth now mounts in
		// the delivery panel and renders the elapsed figure from the timeline
		// (two pre-RUNNING events, no ENCODER_RUNNING).
		mockChannel({
			status: "PROVISIONING",
			currentRun: {
				id: "run-1",
				seq: 3,
				status: "PROVISIONING",
				lastHeartbeat: null,
			},
		});
		const view = wrap(<ChannelDetail id={CHANNEL} />);
		await screen.findByRole("region", { name: /next action/i });
		const panel = await screen.findByRole("region", {
			name: "Delivery status",
		});
		const { findByText, queryByRole } = within(panel);
		expect(
			await findByText(/Encoder starting — .* elapsed/),
		).toBeInTheDocument();
		expect(
			queryByRole("img", { name: /Broadcast timeline/ }),
		).not.toBeInTheDocument();
		view.unmount();
	});

	it("配信中: no hoisted lead — ingest sits in the body cluster, after operations", async () => {
		mockChannel({
			lastHeartbeat: {
				at: new Date().toISOString(),
				raw: { ingest: { status: "CONNECTED", healthy: true } },
				deltas: {},
			},
		});
		const view = wrap(<ChannelDetail id={CHANNEL} />);
		await screen.findByRole("region", { name: /next action/i });
		// : on air the ingest card sits inside the Input layer, after
		// Operations and after Programme — it is a reference, not the lead.
		const ids = Array.from(
			document.querySelectorAll("[id^='sec-'], [id^='layer-']"),
		).map((el) => el.id);
		expect(ids.indexOf("sec-ingest")).toBeGreaterThan(
			ids.indexOf("layer-operations"),
		);
		// In the body it is the foldable form, inside the Input layer — the
		// lead's always-open FlatSection is the OTHER shape of the same id, and
		// exactly one of them renders per phase.
		const ingestEl = document.getElementById("sec-ingest");
		expect(ingestEl?.tagName).toBe("DETAILS");
		expect(ingestEl?.closest("section")?.id).toBe("layer-input");
		expect(document.getElementById("sec-last-run")).toBeNull();
		view.unmount();
	});

	it("終了後: the last-配信 summary leads", async () => {
		mockChannel({
			status: "STOPPED",
			bitmovinEncodingId: "enc-1",
			currentRun: { seq: 3, status: "STOPPED", lastHeartbeat: null },
		});
		const view = wrap(<ChannelDetail id={CHANNEL} />);
		await screen.findByRole("region", { name: /next action/i });
		const lead = document.getElementById("sec-last-run");
		expect(lead).not.toBeNull();
		expect(lead?.textContent).toMatch(/#3/);
		view.unmount();
	});
});

describe("ChannelDetail — live playback preview", () => {
	/* Verify the current information hierarchy rather than restoring the former all-collapsed layout. */
	it("opens with ONE thing to do, and its anchor points at a section that exists (review-260 126-A2)", async () => {
		// RUNNING + no heartbeat ⇒ ingest unproven ⇒ CONNECT_INPUT.
		mockChannel({ currentRun: confirmedRun("RUNNING") });
		wrap(<ChannelDetail id={CHANNEL} />);
		const panel = await screen.findByRole("region", { name: /next action/i });
		expect(panel.getAttribute("data-next-action")).toBe("CONNECT_INPUT");
		// Measured before this line existed: an href typo left all 246 live
		// tests green.
		const cta = panel.querySelector("a[href^='#sec-']");
		expect(cta?.getAttribute("href")).toBe("#sec-feeders");
		expect(document.getElementById("sec-feeders")).not.toBeNull();
	});

	it("the surviving folds still auto-open when the next action points at them — the last live piece of openByDefault (ledger #126)", async () => {
		// ERROR with NO encoding ⇒ RECOVER_FROM_ERROR points at sec-steps.
		mockChannel({ status: "ERROR", bitmovinEncodingId: null });
		wrap(<ChannelDetail id={CHANNEL} />);
		const panel = await screen.findByRole("region", { name: /next action/i });
		expect(panel.getAttribute("data-next-action")).toBe("RECOVER_FROM_ERROR");
		const steps = document.getElementById("sec-steps") as HTMLDetailsElement;
		expect(steps.open, "the pointed fold must open").toBe(true);
	});

	it("every section heading still carries a LIVE summary — reading on is a choice, not a requirement (ledger #103 → #126)", async () => {
		// NON-DEFAULT data on purpose (review-234 I3): the first version of
		// this test used the all-zero fixture, so a hardcoded "0 open" summary
		// passed it — the reviewer proved that by mutating one and watching
		// 13/13 stay green. Every asserted value here differs from the empty
		// case, so a constant cannot match.
		apiFetch.mockImplementation(async (input: string) => {
			if (input.endsWith("/schedules")) {
				return [
					{
						id: "s1",
						action: "START",
						fireAt: "2026-09-01T01:00:00.000Z",
						status: "ARMED",
						insertableContentId: null,
						slateDurationSeconds: null,
						firedAt: null,
						note: null,
						error: null,
						createdAt: "2026-08-16T00:00:00.000Z",
					},
				];
			}
			if (input.endsWith("/alerts")) {
				return {
					open: [
						{
							id: "a1",
							openedAt: "2026-08-16T00:00:00.000Z",
							rule: { severity: "CRIT", metric: "INPUT_DISCONNECTED" },
						},
						{
							id: "a2",
							openedAt: "2026-08-16T00:01:00.000Z",
							rule: { severity: "WARN", metric: "BITRATE_BELOW" },
						},
					],
					history: [],
				};
			}
			if (input.startsWith("/api/feeder-sessions")) {
				return {
					items: [
						{ id: "f1", status: "PUSHING" },
						{ id: "f2", status: "PUSHING" },
						{ id: "f3", status: "STOPPED" },
					],
				};
			}
			if (input.includes("/runs/") && input.endsWith("/health")) {
				// Stream health (2026-08-23): the finished lead mounts StreamHealth,
				// whose fetch must not fall into the channel catch-all below (a
				// channel payload has no points[] and the component throws).
				return {
					points: [],
					lanes: { ingest: [], encoder: [], output: [] },
					run: {
						id: "run-1",
						seq: 1,
						status: "STOPPED",
						createdAt: "2026-08-23T00:00:00Z",
					},
					truncated: false,
				};
			}
			if (input.startsWith(`/api/live-channels/${CHANNEL}`)) {
				return channelRow({ playbackLinks: [link(), link({ key: "dash" })] });
			}
			return { items: [] };
		});
		wrap(<ChannelDetail id={CHANNEL} />);
		await screen.findByRole("region", { name: /next action/i });

		// #126: flat sections carry the summary in their heading row (the
		// first child div), the two folds keep it in <summary> — one reader
		// for both shapes.
		const summaryOf = (id: string) => {
			const el = document.getElementById(id);
			return (
				(el?.querySelector("summary") ?? el?.firstElementChild)?.textContent ??
				""
			);
		};
		await waitFor(() => {
			expect(summaryOf("sec-alerts")).toMatch(/2 open/);
		});
		expect(summaryOf("sec-manifests")).toMatch(/2 links/);
		// Two PUSHING of three sessions — the count is ACTIVE ones, not rows.
		expect(summaryOf("sec-feeders")).toMatch(/2 running/);
		expect(summaryOf("sec-schedule")).toMatch(/START/);
	});

	it("an armed STOP alone never says 'the schedule will act' — the WIRING, not just the core rule (review-234 C1)", async () => {
		// The core function is pinned in packages/core; this pins the PAGE's
		// mapping into it. Reverting the action filter here (armed.length)
		// leaves the core tests green — measured — so the defect can only be
		// caught at this seam.
		apiFetch.mockImplementation(async (input: string) => {
			if (input.endsWith("/schedules")) {
				return [
					{
						id: "s1",
						action: "STOP",
						fireAt: "2026-09-01T02:00:00.000Z",
						status: "ARMED",
						insertableContentId: null,
						slateDurationSeconds: null,
						firedAt: null,
						note: null,
						error: null,
						createdAt: "2026-08-16T00:00:00.000Z",
					},
				];
			}
			if (input.endsWith("/alerts")) {
				return { open: [], history: [] };
			}
			if (input.includes("/runs/") && input.endsWith("/health")) {
				// Stream health (2026-08-23): the finished lead mounts StreamHealth,
				// whose fetch must not fall into the channel catch-all below (a
				// channel payload has no points[] and the component throws).
				return {
					points: [],
					lanes: { ingest: [], encoder: [], output: [] },
					run: {
						id: "run-1",
						seq: 1,
						status: "STOPPED",
						createdAt: "2026-08-23T00:00:00Z",
					},
					truncated: false,
				};
			}
			if (input.startsWith(`/api/live-channels/${CHANNEL}`)) {
				return channelRow({ status: "STOPPED", bitmovinEncodingId: null });
			}
			return { items: [] };
		});
		wrap(<ChannelDetail id={CHANNEL} />);
		const panel = await screen.findByRole("region", { name: /next action/i });
		await waitFor(() => {
			expect(panel.getAttribute("data-next-action")).not.toBe("SCHEDULED_ONLY");
		});
		// #108 PR3: the honest verb for a STOPPED channel with only an armed
		// STOP is START_NEW_RUN — still NOT "the schedule will act" (the C1
		// property this test protects), and no longer a shrug either.
		expect(panel.getAttribute("data-next-action")).toBe("START_NEW_RUN");
	});

	it("an armed SLATE_IN or FEEDER_START is not a start either — they need a RUNNING channel (review-234 I1)", async () => {
		/* Actions that require an already-running channel must be excluded when it is stopped. */
		for (const action of ["SLATE_IN", "FEEDER_START"] as const) {
			apiFetch.mockImplementation(async (input: string) => {
				if (input.endsWith("/schedules")) {
					return [
						{
							id: `s-${action}`,
							action,
							fireAt: "2026-09-01T03:00:00.000Z",
							status: "ARMED",
							insertableContentId: null,
							slateDurationSeconds: null,
							firedAt: null,
							note: null,
							error: null,
							createdAt: "2026-08-16T00:00:00.000Z",
						},
					];
				}
				if (input.endsWith("/alerts")) {
					return { open: [], history: [] };
				}
				if (input.includes("/runs/") && input.endsWith("/health")) {
					// Stream health (2026-08-23): the finished lead mounts StreamHealth,
					// whose fetch must not fall into the channel catch-all below (a
					// channel payload has no points[] and the component throws).
					return {
						points: [],
						lanes: { ingest: [], encoder: [], output: [] },
						run: {
							id: "run-1",
							seq: 1,
							status: "STOPPED",
							createdAt: "2026-08-23T00:00:00Z",
						},
						truncated: false,
					};
				}
				if (input.startsWith(`/api/live-channels/${CHANNEL}`)) {
					return channelRow({ status: "STOPPED", bitmovinEncodingId: null });
				}
				return { items: [] };
			});
			const view = wrap(<ChannelDetail id={CHANNEL} />);
			const panel = await screen.findByRole("region", {
				name: /next action/i,
			});
			await waitFor(() => {
				expect(
					panel.getAttribute("data-next-action"),
					`${action} must not promise automation on a stopped channel`,
				).not.toBe("SCHEDULED_ONLY");
			});
			view.unmount();
		}
	});

	it("the delivery panel reports measured values when no heartbeat has arrived", async () => {
		mockChannel({ playbackLinks: [link()] });
		wrap(<ChannelDetail id={CHANNEL} />);
		const panel = await screen.findByRole("region", {
			name: "Delivery status",
		});
		const cell = (key: string) =>
			panel.querySelector(`[data-lane-cell="${key}"]`)?.textContent ?? "";
		// lastHeartbeat is null in the harness: the age must say "never", not
		// "0s ago" — the reassuring default this strip exists to avoid.
		expect(cell("ingest-last-seen")).toBe("Last seen never");
		// And ingest, with no heartbeat at all, must not claim connected.
		expect(cell("ingest-state")).toBe("unknown");
	});

	it("lane alerts stay unknown during a pending retry, then show the measured counts", async () => {
		mockChannel();
		const defaultFetch = apiFetch.getMockImplementation();
		let finishAlerts = () => {};
		const delayedAlerts = new Promise((resolve) => {
			finishAlerts = () =>
				resolve({
					open: ["INPUT_DISCONNECTED", "ORIGIN_MANIFEST_STALE"].map(
						(metric) => ({
							id: metric,
							openedAt: new Date().toISOString(),
							resolvedAt: null,
							context: null,
							rule: {
								metric,
								severity: "WARN",
								threshold: null,
								windowPolls: 1,
							},
						}),
					),
					history: [],
				});
		});
		let alertReads = 0;
		apiFetch.mockImplementation((input: string) => {
			if (input.endsWith("/alerts")) {
				alertReads += 1;
				return alertReads === 1
					? Promise.reject(new Error("alerts unavailable"))
					: delayedAlerts;
			}
			return defaultFetch?.(input);
		});
		const view = wrap(<ChannelDetail id={CHANNEL} />);
		const panel = await screen.findByRole("region", {
			name: "Delivery status",
		});
		const counts = () =>
			["ingest", "encoder", "output"].map(
				(lane) =>
					panel.querySelector(`[data-lane-cell="${lane}-alerts"]`)?.textContent,
			);
		expect(counts()).toEqual(Array(3).fill("Open alerts: Unknown"));
		const alertSection = document.getElementById("sec-alerts") as HTMLElement;
		expect(within(alertSection).getByRole("alert")).toBeInTheDocument();
		// An initial pending query is behind the skeleton. A dataless retry
		// keeps isFetched true but changes isError to false and isPending to
		// true: checking only isError would paint three invented zeroes here.
		const queryKey = ["live-channel-alerts", CHANNEL];
		const retry = view.client.refetchQueries({ queryKey });
		await waitFor(() => {
			expect(view.client.getQueryState(queryKey)?.status).toBe("pending");
			expect(alertReads).toBe(2);
			// This removal proves React rendered the pending state before we
			// inspect the lane counts, rather than reading the old error DOM.
			expect(within(alertSection).queryByRole("alert")).toBeNull();
			expect(counts()).toEqual(Array(3).fill("Open alerts: Unknown"));
		});
		finishAlerts();
		await retry;
		await waitFor(() =>
			expect(counts()).toEqual([
				"Open alerts: 1",
				"Open alerts: 0",
				"Open alerts: 1",
			]),
		);
		view.unmount();
	});

	it("a frozen CONNECTED sample cannot vouch: stale age OR a stopped status reads as not connected (ledger #127)", async () => {
		/* Connection status requires both a live provider state and fresh input evidence; verify each gate independently. */
		mockChannel({
			lastHeartbeat: {
				at: new Date(Date.now() - 5 * 60_000).toISOString(),
				raw: { ingest: { status: "CONNECTED", healthy: true } },
				deltas: {},
			},
		});
		const view = wrap(<ChannelDetail id={CHANNEL} />);
		const staleStrip = await screen.findByRole("region", {
			name: "Delivery status",
		});
		expect(
			document
				.querySelector('[data-state="active"]')
				?.getAttribute("data-stage"),
		).toBe("3");
		// review-260 127-A1: the CELL, not just the boolean — the false branch
		// used to render the frozen sample's raw wire word ("CONNECTED"), so
		// the owner's symptom survived the predicate fix and the old
		// case-sensitive not-match was green over it. Exact text now.
		expect(
			staleStrip.querySelector('[data-lane-cell="ingest-state"]')?.textContent,
			// ACTIVE + stale sample = missing observation, not absent ingest —
			// review-296 I5 restored the strip's own invariant here; None is
			// the post-stop arm below.
		).toBe("unknown");
		view.unmount();

		// (2) STOPPED with a FRESH sample — the stop just happened, the last
		//     sample is seconds old and still says CONNECTED; status must win.
		mockChannel({
			status: "STOPPED",
			lastHeartbeat: {
				at: new Date().toISOString(),
				raw: { ingest: { status: "CONNECTED", healthy: true } },
				deltas: {},
			},
		});
		const view2 = wrap(<ChannelDetail id={CHANNEL} />);
		const strip = await screen.findByRole("region", {
			name: "Delivery status",
		});
		expect(
			strip.querySelector('[data-lane-cell="ingest-state"]')?.textContent,
		).toBe("None");
		view2.unmount();

		// (3) The informative case survives: RUNNING with a FRESH sample that
		// says WAITING_FOR_FIRST_CONNECT shows that word — live truth the
		// operator needs during startup, not flattened into "unknown".
		mockChannel({
			lastHeartbeat: {
				at: new Date().toISOString(),
				raw: { ingest: { status: "WAITING_FOR_FIRST_CONNECT" } },
				deltas: {},
			},
		});
		const view3 = wrap(<ChannelDetail id={CHANNEL} />);
		const strip3 = await screen.findByRole("region", {
			name: "Delivery status",
		});
		expect(
			strip3.querySelector('[data-lane-cell="ingest-state"]')?.textContent,
		).toBe("WAITING_FOR_FIRST_CONNECT");
		view3.unmount();
	});

	it("wires the lifecycle strip to the REAL heartbeat wrapper — a constant would pin ③ forever and no other test would notice (review-228 I1)", async () => {
		// The third guard on this exact seam (#95 C1's inverted predicate,
		// #97's invented key): the strip must light ④ from the PRODUCTION
		// `{at, raw, deltas}` shape the route actually returns.
		mockChannel({
			lastHeartbeat: {
				// FRESH —  made age part of the predicate, so this
				// fixture must be inside the 90s vouching window to light ④.
				at: new Date().toISOString(),
				raw: { ingest: { status: "CONNECTED", healthy: true } },
				deltas: {},
			},
		});
		const view = wrap(<ChannelDetail id={CHANNEL} />);
		const active = await screen.findByText(/Input connected/);
		expect(active).toBeInTheDocument();
		expect(
			document
				.querySelector('[data-state="active"]')
				?.getAttribute("data-stage"),
		).toBe("4");
		view.unmount();

		// Disconnected wrapper ⇒ ③, not ④.
		mockChannel({
			lastHeartbeat: {
				at: "2026-08-11T00:00:00.000Z",
				raw: { ingest: { status: "WAITING_FOR_FIRST_CONNECT" } },
				deltas: {},
			},
		});
		const view2 = wrap(<ChannelDetail id={CHANNEL} />);
		await screen.findByText(/Waiting for input/);
		expect(
			document
				.querySelector('[data-state="active"]')
				?.getAttribute("data-stage"),
		).toBe("3");
		view2.unmount();

		// review-228 B1: ERROR with an encoding must render the encoder-may-
		// still-be-up hint THROUGH the wiring — hasEncoding is required now,
		// and this pins the value actually passed.
		mockChannel({
			status: "ERROR",
			bitmovinEncodingId: "enc-1",
			currentRun: confirmedRun("ERROR"),
		});
		wrap(<ChannelDetail id={CHANNEL} />);
		expect(
			await screen.findByText(/may still be up on Bitmovin/),
		).toBeInTheDocument();
	});

	it("withholds the preview until output is confirmed, and lets the operator start it anyway (row #326)", async () => {
		mockChannel({ playbackLinks: [link()] });
		wrap(<ChannelDetail id={CHANNEL} />);
		expect(
			await screen.findByRole("heading", { name: "Playback preview" }),
		).toBeInTheDocument();
		expect(
			screen.getByText(/Playback waits until video output is confirmed/),
		).toBeInTheDocument();
		expect(loaded).toEqual([]);
		await userEvent.click(screen.getByRole("button", { name: "Play now" }));
		await waitFor(() => expect(loaded).toEqual([HLS_URL]));
	});

	it("previews a running channel with no click once the origin observer confirms output (row #326)", async () => {
		mockChannel({ playbackLinks: [link()], currentRun: advancingRun() });
		wrap(<ChannelDetail id={CHANNEL} />);
		expect(
			await screen.findByRole("heading", { name: "Playback preview" }),
		).toBeInTheDocument();
		await waitFor(() => expect(loaded).toEqual([HLS_URL]));
	});

	it("keeps the same airing gated across PROVISIONING to RUNNING until output advances (row #326)", async () => {
		const run = confirmedRun("RUNNING");
		mockChannel({
			status: "PROVISIONING",
			playbackLinks: [link()],
			currentRun: { ...run, status: "PROVISIONING" },
		});
		const { client } = wrap(<ChannelDetail id={CHANNEL} />);
		await screen.findByText("Verification channel");
		expect(loaded).toEqual([]);

		await act(async () => {
			client.setQueryData(
				["live-channel", CHANNEL],
				channelRow({ playbackLinks: [link()], currentRun: run }),
			);
		});
		await screen.findByRole("heading", { name: "Playback preview" });
		expect(loaded).toEqual([]);
		expect(
			await screen.findByText(/Playback waits until video output is confirmed/),
		).toBeInTheDocument();
		expect(loaded).toEqual([]);

		await act(async () => {
			client.setQueryData(
				["live-channel", CHANNEL],
				channelRow({
					playbackLinks: [link()],
					currentRun: { ...run, ...advancingRun() },
				}),
			);
		});
		await waitFor(() => expect(loaded).toEqual([HLS_URL]));
	});

	for (const status of ["STOPPED", "CREATED", "PROVISIONING", "ERROR"]) {
		it(`offers nothing for a ${status} channel`, async () => {
			mockChannel({ status, playbackLinks: [link()] });
			wrap(<ChannelDetail id={CHANNEL} />);
			await screen.findByText("Verification channel");
			expect(
				screen.queryByRole("heading", { name: "Playback preview" }),
			).toBeNull();
		});
	}

	it("explains a channel whose output is not public instead of previewing it", async () => {
		/**
		 * This test used to assert only the ABSENCE of the player, which is how the
		 * page came to show nothing at all: no URL, no path, and no reason — for
		 * every channel authored before the wizard gained its ACL field. The stated
		 * goal of design §19.3 was that "live playback does not work" cannot be
		 * mistaken for a player bug, and an empty page fails it.
		 */
		mockChannel({
			playbackLinks: [
				link({ url: null, via: "none", reason: { code: "NOT_PUBLIC" } }),
			],
		});
		wrap(<ChannelDetail id={CHANNEL} />);
		await screen.findByText("Verification channel");
		expect(
			screen.queryByRole("heading", { name: "Playback preview" }),
		).toBeNull();
		// The reason IS shown, next to the manifest's origin path — one
		// disclosure back since  (§5.7: "manifest summary" open,
		// "every URL" behind a control), never further, because a channel with
		// no public output must still be able to say why.
		await openManifestUrls();
		expect(
			await screen.findByText(/The output ACL is private/),
		).toBeInTheDocument();
		expect(screen.getByText("output/live/stream.m3u8")).toBeInTheDocument();
	});

	it("lists a playable manifest's URL with a Copy button, but no Play", async () => {
		// The live page has no enlarged dialog, so `onPlay` is omitted and no Play
		// button should appear even for a playable link — the inline panel is the
		// player there.
		mockChannel({ playbackLinks: [link()] });
		wrap(<ChannelDetail id={CHANNEL} />);
		await screen.findByText("Verification channel");
		await openManifestUrls();
		expect(await screen.findByText(HLS_URL)).toBeInTheDocument();
		expect(
			screen.getByRole("button", {
				name: `Copy the HLS manifest URL: ${HLS_URL}`,
			}),
		).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Play" })).toBeNull();
	});

	it("renders the DECLARED_BASE copy when playback fails behind a declared base", async () => {
		/**
		 * The I3 case, driven rather than assumed, on the page that has it 100% of the
		 * time. The first version of this test asserted only that the URL rendered —
		 * which the case above already covers — so it passed whether or not
		 * `DECLARED_BASE` existed at all, and nothing in the repo asserted its copy.
		 * That is the same defect this file's other test had, six lines up (review
		 * catch, second instance in one file).
		 */
		apiFetch.mockImplementation(async (input: string) => {
			if (input.includes("/playback-cors")) {
				return {
					supported: false,
					origin: "http://localhost:3100",
					reason: "DECLARED_BASE",
				};
			}
			if (input.endsWith("/schedules")) {
				return []; // the #84 panel needs an array (same as mockChannel)
			}
			if (input.endsWith("/alerts")) {
				return { open: [], history: [] }; // , as in mockChannel
			}
			if (input.includes("/runs/") && input.endsWith("/health")) {
				// Stream health (2026-08-23): the finished lead mounts StreamHealth,
				// whose fetch must not fall into the channel catch-all below (a
				// channel payload has no points[] and the component throws).
				return {
					points: [],
					lanes: { ingest: [], encoder: [], output: [] },
					run: {
						id: "run-1",
						seq: 1,
						status: "STOPPED",
						createdAt: "2026-08-23T00:00:00Z",
					},
					truncated: false,
				};
			}
			if (input.startsWith(`/api/live-channels/${CHANNEL}`)) {
				return channelRow({
					playbackLinks: [link({ via: "publicBaseUrls" })],
					currentRun: advancingRun(),
				});
			}
			return { items: [] };
		});
		wrap(<ChannelDetail id={CHANNEL} />);
		await waitFor(() => expect(fatal).not.toBeNull());
		// An opaque fatal error is not evidence of an unpublished first manifest.
		act(() => fatal?.());

		/**
		 * Asserted on the sentence that carries the point, not on a fragment: review
		 * showed the old copy made three POSITIVE claims that are false in the case
		 * this reason actually fires (self-declaration — the declared host IS the
		 * bucket), so it now states that it cannot tell the two apart. If that
		 * distinction is ever dropped, this fails.
		 */
		expect(
			await screen.findByText(/cannot tell whether the declared host is a CDN/),
		).toBeInTheDocument();
	});

	it("renders without the field at all — a channel from before it existed", async () => {
		mockChannel({});
		wrap(<ChannelDetail id={CHANNEL} />);
		await screen.findByText("Verification channel");
		expect(
			screen.queryByRole("heading", { name: "Playback preview" }),
		).toBeNull();
	});
});
