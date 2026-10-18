import type { ManifestPlaybackLink } from "@bitovp/core";
import {
	act,
	fireEvent,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { formatDateTime } from "@/lib/format";
import { renderWithQuery as wrap } from "@/test/render";
import type { LiveStatusSignal } from "./status-announce";

/**
 *  (audit 5c3d97ca BLOCKER-1 / §14.5 LC-01 item 4), at the page that
 * composes the derived state: a RUNNING channel whose current run's provider
 * view is UNKNOWN must not be ON_AIR, must paint the lifecycle strip amber and
 * must say the provider status cannot be confirmed — with the last successful
 * observation. The control arm is the same page with a fresh confirmed view,
 * which must still be ON_AIR: otherwise the fix would only have moved the lie.
 */

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
vi.mock("next/navigation", () => ({
	useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("hls.js", () => {
	class Hls {
		static Events = { ERROR: "hlsError" };
		static isSupported() {
			return true;
		}
		on() {}
		loadSource() {}
		attachMedia() {}
		startLoad() {}
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
vi.mock("./live-announcer", async () => {
	const actual =
		await vi.importActual<typeof import("./live-announcer")>(
			"./live-announcer",
		);
	return {
		...actual,
		StatusAnnouncer: ({ signal }: { signal: LiveStatusSignal }) => (
			<>
				<actual.StatusAnnouncer signal={signal} />
				<output
					data-provider-on-air={signal.onAir ? "confirmed" : "unconfirmed"}
				/>
			</>
		),
	};
});

import { ChannelDetail } from "./channel-detail";

const CHANNEL = "00000000-0000-4000-8000-0000000000e2";

const HLS: ManifestPlaybackLink = {
	key: "hls",
	kind: "HLS",
	label: "Live HLS Manifest",
	url: "https://cdn.example.com/live/stream.m3u8",
	path: "live/stream.m3u8",
	via: "publicBaseUrls",
};

/**
 * RUNNING, ingest fresh and CONNECTED, one playable manifest, zero alerts —
 * the fixture whose ONLY remaining question is the provider's view.
 */
function channelRow(provider: {
	providerStatus: string | null;
	providerStatusObservedAt: string | null;
	providerUnknownSince: string | null;
	providerTerminalAt: string | null;
}) {
	const now = new Date().toISOString();
	return {
		id: CHANNEL,
		name: "provider-unknown",
		status: "RUNNING",
		labels: [],
		region: "ap-northeast-1",
		protocol: "RTMP",
		bitmovinEncodingId: "enc-1",
		bitmovinAccountId: null,
		createdAt: "2026-08-30T00:00:00.000Z",
		updatedAt: "2026-08-30T00:00:00.000Z",
		plan: {},
		stepLog: [],
		streamKey: "k",
		encoderIp: "203.0.113.9",
		programStartAt: null,
		programEndAt: null,
		maxRunMinutes: null,
		error: null,
		lastHeartbeat: null,
		liveToVod: null,
		playbackLinks: [HLS],
		serverNow: now,
		currentRun: {
			id: "run-1",
			seq: 1,
			status: "RUNNING",
			bitmovinEncodingId: "enc-1",
			encoderIp: "203.0.113.9",
			streamKey: "k",
			outputPrefix: "",
			runningSince: "2026-08-30T00:00:00.000Z",
			endedAt: null,
			programStartAt: null,
			programEndAt: null,
			error: null,
			lastHeartbeat: {
				at: now,
				raw: { ingest: { status: "CONNECTED", healthy: true, streams: [] } },
				deltas: {},
			},
			lastHeartbeatAt: now,
			stepLog: [],
			liveToVod: null,
			originObservation: null,
			createdAt: "2026-08-30T00:00:00.000Z",
			...provider,
		},
	};
}

function mockPage(row: ReturnType<typeof channelRow>) {
	apiFetch.mockImplementation(async (input: string) => {
		if (input.endsWith("/schedules")) {
			return [];
		}
		if (input.endsWith("/alerts")) {
			return { open: [], history: [] };
		}
		// StreamHealth mounts once a currentRun exists (which this fixture is
		// about) and reads `points.length` — it needs the real empty shape.
		if (input.endsWith("/health")) {
			return {
				points: [],
				lanes: { ingest: [], encoder: [], output: [] },
				run: {
					id: "run-1",
					seq: 1,
					status: "RUNNING",
					createdAt: "2026-08-30T00:00:00.000Z",
					queueSeconds: null,
				},
				truncated: false,
				outputObservable: true,
			};
		}
		if (input.endsWith("/runs")) {
			return { runs: [] };
		}
		if (input.startsWith(`/api/live-channels/${CHANNEL}`)) {
			return row;
		}
		return { items: [] };
	});
}

const nextActionCode = () =>
	document
		.querySelector("[data-next-action]")
		?.getAttribute("data-next-action") ?? null;

const strip = () => document.querySelector("figure[aria-label]");
const providerOnAir = () =>
	document
		.querySelector("[data-provider-on-air]")
		?.getAttribute("data-provider-on-air") ?? null;
const statusBadge = (label: string) => {
	// The delivery panel also reports the provider's raw RUNNING word. This
	// assertion concerns the channel badge beside the page title.
	const header = screen.getByRole("heading", { level: 1 }).closest("header");
	expect(header).not.toBeNull();
	return within(header as HTMLElement)
		.getByText(label)
		.closest("span");
};

beforeEach(() => {
	vi.clearAllMocks();
});

describe("ChannelDetail — a lost provider observation is never on air (row #280)", () => {
	it("new Push query data and its clock are coherent before the real announcer effects run", async () => {
		const serverAt = Date.now();
		const clock = vi.spyOn(Date, "now").mockReturnValue(serverAt);
		const stamp = (seconds: number) =>
			new Date(serverAt + seconds * 1000).toISOString();
		const push = (seconds: number) => ({
			state: "available",
			runId: "run-1",
			configuredIntervalS: 20,
			latest: {
				receivedAt: stamp(seconds),
				sampledAt: stamp(seconds),
				raw: {
					timestamp: stamp(seconds),
					ingest: { status: "CONNECTED", healthy: true },
				},
			},
			previousReceivedAt: null,
		});
		try {
			const base = channelRow({
				providerStatus: "RUNNING",
				providerStatusObservedAt: stamp(0),
				providerUnknownSince: null,
				providerTerminalAt: null,
			});
			// No Poll fallback: the current signed Push sample is the display source.
			const row = {
				...base,
				serverNow: stamp(0),
				heartbeatReception: push(0),
				currentRun: { ...base.currentRun, lastHeartbeat: null },
			};
			apiFetch.mockImplementation(async (url: string) => {
				if (url.endsWith("/schedules")) return [];
				if (url.endsWith("/alerts")) return { open: [], history: [] };
				if (url.endsWith("/health"))
					return {
						points: [],
						lanes: { ingest: [], encoder: [], output: [] },
						run: {
							id: "run-1",
							seq: 1,
							status: "RUNNING",
							createdAt: base.currentRun.createdAt,
						},
						truncated: false,
						outputObservable: true,
					};
				if (url.endsWith("/runs")) return { runs: [] };
				return url === `/api/live-channels/${CHANNEL}` ? row : { items: [] };
			});
			const { client, unmount } = wrap(<ChannelDetail id={CHANNEL} />);
			await waitFor(() => expect(nextActionCode()).toBe("ON_AIR"));
			const region = document.querySelector("[data-live-announcer]");
			expect(region).toBeEmptyDOMElement();
			clock.mockReturnValue(serverAt + 20_000);
			await act(async () => {
				client.setQueryData(["live-channel", CHANNEL], {
					...row,
					serverNow: stamp(20),
					heartbeatReception: push(20),
				});
			});
			await waitFor(() =>
				expect(
					screen.getAllByText(formatDateTime(stamp(20))).length,
				).toBeGreaterThan(0),
			);
			expect(nextActionCode()).toBe("ON_AIR");
			expect(region).toBeEmptyDOMElement();
			expect(
				document.querySelector('[data-lane="ingest"] [data-lane-lamp]'),
			).toHaveAttribute("data-lane-lamp", "on");
			// Coherence is not permission to accept a genuinely future sample.
			await act(async () => {
				client.setQueryData(["live-channel", CHANNEL], {
					...row,
					serverNow: stamp(20),
					heartbeatReception: push(40),
				});
			});
			await waitFor(() => expect(nextActionCode()).not.toBe("ON_AIR"));
			expect(
				document.querySelector('[data-lane="ingest"] [data-lane-lamp]'),
			).toHaveAttribute("data-lane-lamp", "unknown");
			unmount();
		} finally {
			clock.mockRestore();
		}
	});
	it.each([
		-300_000, 0, 300_000,
	])("a fresh response between clock ticks has honest lane ages with viewer skew %s", async (viewerSkewMs) => {
		const serverAt = Date.now();
		const clock = vi
			.spyOn(Date, "now")
			.mockReturnValue(serverAt + viewerSkewMs);
		try {
			const row = channelRow({
				providerStatus: "RUNNING",
				providerStatusObservedAt: new Date(serverAt - 1_000).toISOString(),
				providerUnknownSince: null,
				providerTerminalAt: null,
			});
			row.serverNow = new Date(serverAt).toISOString();
			mockPage(row);
			const { client } = wrap(<ChannelDetail id={CHANNEL} />);
			const age = (lane: string) =>
				document.querySelector(`[data-lane-cell="${lane}-last-seen"]`);
			await waitFor(() => expect(age("encoder")).toHaveTextContent("1s ago"));
			// The next channel response arrives at 15s, before the 30s UI tick.
			clock.mockReturnValue(serverAt + viewerSkewMs + 15_000);
			const stamp = new Date(serverAt + 14_000).toISOString();
			const refreshed = {
				...row,
				serverNow: new Date(serverAt + 15_000).toISOString(),
				currentRun: {
					...row.currentRun,
					providerStatusObservedAt: stamp,
					lastHeartbeat: { ...row.currentRun.lastHeartbeat, at: stamp },
					lastHeartbeatAt: stamp,
					originObservation: {
						lastFetchAtMs: serverAt + 14_000,
						lastVerdicts: {
							main: { stale: false, endlist: false, edgeDelaySeconds: null },
						},
					},
				},
			};
			await act(async () => {
				client.setQueryData(["live-channel", CHANNEL], refreshed);
			});
			await waitFor(() => {
				for (const lane of ["ingest", "encoder", "output"]) {
					expect(age(lane)).toHaveTextContent("1s ago");
					expect(age(lane)).not.toHaveTextContent("clock skew");
				}
			});
			// A stamp genuinely beyond this response's server clock stays skewed.
			await act(async () => {
				client.setQueryData(["live-channel", CHANNEL], {
					...refreshed,
					currentRun: {
						...refreshed.currentRun,
						originObservation: {
							lastFetchAtMs: serverAt + 16_000,
							lastVerdicts: {
								main: { stale: false, endlist: false, edgeDelaySeconds: null },
							},
						},
					},
				});
			});
			await waitFor(() =>
				expect(age("output")).toHaveTextContent("clock skew"),
			);
		} finally {
			clock.mockRestore();
		}
	});

	it("control: a fresh confirmed RUNNING view is ON_AIR with the ordinary sky-blue strip", async () => {
		mockPage(
			channelRow({
				providerStatus: "RUNNING",
				providerStatusObservedAt: new Date().toISOString(),
				providerUnknownSince: null,
				providerTerminalAt: null,
			}),
		);
		wrap(<ChannelDetail id={CHANNEL} />);
		await screen.findByRole("region", { name: /channel status/i });
		await waitFor(() => expect(nextActionCode()).toBe("ON_AIR"));
		expect(providerOnAir()).toBe("confirmed");
		expect(statusBadge("RUNNING")?.className).toContain("emerald");
		expect(strip()?.getAttribute("data-provider")).toBeNull();
		expect(
			screen.queryByText(/Provider status cannot be confirmed/),
		).toBeNull();
	});

	it("an open UNKNOWN window on the current run: PROVIDER_UNKNOWN, an amber strip, and the last successful observation named", async () => {
		mockPage(
			channelRow({
				providerStatus: "RUNNING",
				providerStatusObservedAt: "2026-08-30T11:58:00.000Z",
				providerUnknownSince: "2026-08-30T11:59:00.000Z",
				providerTerminalAt: null,
			}),
		);
		wrap(<ChannelDetail id={CHANNEL} />);
		await screen.findByRole("region", { name: /channel status/i });
		await waitFor(() => expect(nextActionCode()).toBe("PROVIDER_UNKNOWN"));
		expect(nextActionCode()).not.toBe("ON_AIR");
		expect(providerOnAir()).toBe("unconfirmed");
		const badge = statusBadge("RUNNING · Bitmovin status unconfirmed");
		expect(badge?.className).toContain("amber");
		expect(badge?.className).not.toContain("emerald");
		expect(strip()?.getAttribute("data-provider")).toBe("unknown");
		const active = strip()?.querySelector('[data-state="active"] span + span');
		expect(active?.className).toContain("amber");
		expect(active?.className).not.toContain("sky");
		fireEvent.click(
			screen.getByRole("button", {
				name: "Encoder lifecycle — more information",
			}),
		);
		expect(
			screen.getByText(/Provider status cannot be confirmed/),
		).toBeInTheDocument();
		expect(
			screen.getByText("Bitmovin encoder status unconfirmed"),
		).toBeInTheDocument();
		// The next-action panel is the amber `act` tone, not emerald `watch`.
		const panel = document.querySelector("[data-next-action]");
		expect(panel?.className).toContain("amber");
		expect(panel?.className).not.toContain("emerald");
	});

	it("a confirmed RUNNING older than the freshness TTL is UNKNOWN too — freshness is part of the claim", async () => {
		mockPage(
			channelRow({
				providerStatus: "RUNNING",
				providerStatusObservedAt: new Date(
					Date.now() - 10 * 60_000,
				).toISOString(),
				providerUnknownSince: null,
				providerTerminalAt: null,
			}),
		);
		wrap(<ChannelDetail id={CHANNEL} />);
		await screen.findByRole("region", { name: /channel status/i });
		await waitFor(() => expect(nextActionCode()).toBe("PROVIDER_UNKNOWN"));
		expect(strip()?.getAttribute("data-provider")).toBe("unknown");
	});

	it("a run with no observation yet is not ON_AIR or green while the first Bitmovin status check is pending", async () => {
		mockPage(
			channelRow({
				providerStatus: null,
				providerStatusObservedAt: null,
				providerUnknownSince: null,
				providerTerminalAt: null,
			}),
		);
		wrap(<ChannelDetail id={CHANNEL} />);
		await screen.findByRole("region", { name: /channel status/i });
		await waitFor(() => expect(nextActionCode()).toBe("PROVIDER_UNKNOWN"));
		expect(providerOnAir()).toBe("unconfirmed");
		const badge = statusBadge("RUNNING · Bitmovin status unconfirmed");
		expect(badge?.className).toContain("amber");
		expect(badge?.className).not.toContain("emerald");
		expect(strip()?.getAttribute("data-provider")).toBe("unobserved");
	});
});
