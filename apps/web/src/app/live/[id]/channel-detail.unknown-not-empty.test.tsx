import type { ManifestPlaybackLink } from "@bitovp/core";
import { act, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithQuery as wrap } from "@/test/render";

/**
 * at the page that composes the summaries.
 *
 * A failed alerts query became `alerts.data?.open.length ?? 0`, so the
 * monitoring strip printed a green `0`, the alerts card summarised "0 open"
 * in emerald, and `liveNextAction` — which cannot ask a number whether it was
 * measured — answered `ON_AIR` for a channel nobody could monitor. A failed
 * schedules query became `schedules.data ?? []`, and the schedule card
 * summarised "none armed" over a list it had never read.
 *
 * The control arm matters as much as the failing one: the same page, the same
 * fixture, alerts RESOLVING with an empty list, must still say `ON_AIR` and
 * `0`. Otherwise the fix would only have moved the lie.
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

import { ChannelDetail } from "./channel-detail";

const CHANNEL = "00000000-0000-4000-8000-0000000000e1";

const HLS: ManifestPlaybackLink = {
	key: "hls",
	kind: "HLS",
	label: "Live HLS Manifest",
	url: "https://cdn.example.com/live/stream.m3u8",
	path: "live/stream.m3u8",
	via: "publicBaseUrls",
};

/** RUNNING, ingest fresh and CONNECTED, one playable manifest: the fixture
 *  whose ONLY remaining question is "are there alerts?" — so ON_AIR is what
 *  the page says the moment that question is answered with zero. */
function channelRow() {
	const now = new Date().toISOString();
	return {
		id: CHANNEL,
		name: "unknown-not-empty",
		status: "RUNNING",
		labels: [],
		region: "ap-northeast-1",
		protocol: "RTMP",
		bitmovinEncodingId: "enc-1",
		bitmovinAccountId: null,
		createdAt: "2026-08-29T00:00:00.000Z",
		updatedAt: "2026-08-29T00:00:00.000Z",
		plan: {},
		stepLog: [],
		streamKey: "k",
		encoderIp: "203.0.113.9",
		programStartAt: null,
		programEndAt: null,
		maxRunMinutes: null,
		lastHeartbeat: {
			at: now,
			raw: { ingest: { status: "CONNECTED", healthy: true, streams: [] } },
			deltas: {},
		},
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
			runningSince: "2026-08-29T00:00:00.000Z",
			endedAt: null,
			programStartAt: null,
			programEndAt: null,
			error: null,
			lastHeartbeat: {
				at: now,
				raw: {
					ingest: { status: "CONNECTED", healthy: true, streams: [] },
				},
				deltas: {},
			},
			lastHeartbeatAt: now,
			stepLog: [],
			liveToVod: null,
			originObservation: null,
			createdAt: "2026-08-29T00:00:00.000Z",
			providerStatus: "RUNNING",
			providerStatusObservedAt: now,
			providerUnknownSince: null,
			providerTerminalAt: null,
		},
	};
}

const runHealth = () => ({
	points: [],
	lanes: { ingest: [], encoder: [], output: [] },
	run: {
		id: "run-1",
		seq: 1,
		status: "RUNNING",
		createdAt: "2026-08-29T00:00:00.000Z",
	},
	truncated: false,
	outputObservable: true,
});

/** `fail` names the ONE endpoint that rejects; everything else answers. */
function mockPage(
	fail: "alerts" | "schedules" | "none",
	readFeeders: () => unknown = () => ({ items: [] }),
) {
	apiFetch.mockImplementation(async (input: string) => {
		if (input.startsWith("/api/feeder-sessions?")) {
			return readFeeders();
		}
		if (input.endsWith("/schedules")) {
			if (fail === "schedules") {
				throw new Error("503 from the schedules route");
			}
			return [];
		}
		if (input.endsWith("/alerts")) {
			if (fail === "alerts") {
				throw new Error("503 from the alerts route");
			}
			return { open: [], history: [] };
		}
		if (input.endsWith("/health")) {
			return runHealth();
		}
		if (input.endsWith("/runs")) {
			return { runs: [] };
		}
		if (input.startsWith(`/api/live-channels/${CHANNEL}`)) {
			return channelRow();
		}
		return { items: [] };
	});
}

const nextActionCode = () =>
	document
		.querySelector("[data-next-action]")
		?.getAttribute("data-next-action") ?? null;

const stripCell = (key: string) =>
	document.querySelector(`[data-status-cell="${key}"]`);

/** The summary ELEMENT, so text and TONE can both be read off it. */
const summaryEl = (id: string) => {
	const section = document.getElementById(id);
	// FlatSection puts title + summary in the heading row; the summary is the
	// last span of that first child.
	const spans = section?.firstElementChild?.querySelectorAll("span");
	return spans?.[spans.length - 1] ?? null;
};

const summaryOf = (id: string) => summaryEl(id)?.textContent ?? null;

/**
 * Review #348 M2: the text assertions alone let a mutant that hardcodes a
 * card's `tone` to "ok" ship green — a summary reading "could not be read" in
 * EMERALD, which is precisely the reassuring-colour half of the defect. The
 * tone class is therefore asserted beside every text assertion. FlatSection's
 * mapping: ok → emerald-400, warn → amber-400, error → red-400, neutral →
 * zinc-500.
 */
const summaryToneOf = (id: string) => {
	const cls = summaryEl(id)?.className ?? "";
	for (const [tone, token] of [
		["ok", "text-emerald-400"],
		["warn", "text-amber-400"],
		["error", "text-red-400"],
		["neutral", "text-zinc-500"],
	] as const) {
		if (cls.includes(token)) {
			return tone;
		}
	}
	return `unrecognised: ${cls}`;
};

beforeEach(() => {
	vi.clearAllMocks();
});

describe.each([
	{
		locale: "en",
		unknown: "unknown",
		unavailable: "could not be read",
		empty: "0 running",
		active: "1 running",
	},
	{
		locale: "ja",
		unknown: "不明",
		unavailable: "取得できませんでした",
		empty: "0 稼働",
		active: "1 稼働",
	},
] as const)("feeder summary query state ($locale)", ({
	locale,
	unknown,
	unavailable,
	empty,
	active,
}) => {
	function expectSummary(
		count: string,
		summary: string,
		tone: "neutral" | "warn" | "ok",
	) {
		expect(stripCell("feeders")?.textContent).toBe(count);
		expect(summaryOf("sec-feeders")).toBe(summary);
		expect(summaryToneOf("sec-feeders")).toBe(tone);
		expect(stripCell("feeders")?.className).toContain("text-amber-400");
	}
	it("failed initial read is amber unknown, not zero", async () => {
		mockPage("none", () => {
			throw new Error("feeder unavailable");
		});
		wrap(<ChannelDetail id={CHANNEL} />, locale);
		await waitFor(() => expectSummary(unknown, unavailable, "warn"));
	});
	it.each([
		0, 1,
	])("retry after initial failure stays unknown until count %i really arrives", async (count) => {
		let retry = false;
		let release: ((value: unknown) => void) | undefined;
		mockPage("none", () => {
			if (!retry) throw new Error("feeder unavailable");
			return new Promise((resolve) => {
				release = resolve;
			});
		});
		const { client } = wrap(<ChannelDetail id={CHANNEL} />, locale);
		await waitFor(() => expectSummary(unknown, unavailable, "warn"));
		retry = true;
		let refetch: Promise<void> | undefined;
		await act(async () => {
			refetch = client.refetchQueries({
				queryKey: ["feeder-sessions", CHANNEL],
			});
		});
		await waitFor(() => expect(release).toBeDefined());
		const state = client.getQueryState(["feeder-sessions", CHANNEL]);
		expect(state?.status).toBe("pending");
		expect(state?.fetchStatus).toBe("fetching");
		expect(state?.errorUpdateCount).toBe(1);
		expect(state?.data).toBeUndefined();
		await waitFor(() => expectSummary(unknown, unavailable, "warn"));
		await act(async () => {
			release?.({
				items: count ? [{ id: "feeder-1", status: "PUSHING" }] : [],
			});
			await refetch;
		});
		await waitFor(() =>
			expect(summaryOf("sec-feeders")).toBe(count ? active : empty),
		);
		expect(stripCell("feeders")?.textContent).toBe(String(count));
		expect(summaryToneOf("sec-feeders")).toBe(count ? "ok" : "neutral");
	});
	it.each([
		0, 1,
	])("failed refetch hides stale count %i and recovery restores it", async (count) => {
		let fail = false;
		mockPage("none", () => {
			if (fail) throw new Error("feeder unavailable");
			return { items: count ? [{ id: "feeder-1", status: "PUSHING" }] : [] };
		});
		const { client } = wrap(<ChannelDetail id={CHANNEL} />, locale);
		await waitFor(() =>
			expect(summaryOf("sec-feeders")).toBe(count ? active : empty),
		);
		fail = true;
		await act(() =>
			client.invalidateQueries({ queryKey: ["feeder-sessions", CHANNEL] }),
		);
		await waitFor(() => expectSummary(unknown, unavailable, "warn"));
		expect(client.getQueryData(["feeder-sessions", CHANNEL])).toEqual({
			items: count ? [{ id: "feeder-1", status: "PUSHING" }] : [],
		});
		fail = false;
		await act(() =>
			client.invalidateQueries({ queryKey: ["feeder-sessions", CHANNEL] }),
		);
		await waitFor(() =>
			expect(summaryOf("sec-feeders")).toBe(count ? active : empty),
		);
		expect(stripCell("feeders")?.textContent).toBe(String(count));
		expect(summaryToneOf("sec-feeders")).toBe(count ? "ok" : "neutral");
	});
	it("initial pending remains neutral and successful empty remains a measured zero", async () => {
		let release: ((value: unknown) => void) | undefined;
		mockPage(
			"none",
			() =>
				new Promise((resolve) => {
					release = resolve;
				}),
		);
		wrap(<ChannelDetail id={CHANNEL} />, locale);
		await waitFor(() => expect(summaryOf("sec-feeders")).toBe(empty));
		expect(stripCell("feeders")?.textContent).toBe("0");
		expect(summaryToneOf("sec-feeders")).toBe("neutral");
		expect(release).toBeDefined();
		await act(async () => {
			release?.({ items: [] });
		});
		await waitFor(() => expect(summaryOf("sec-feeders")).toBe(empty));
		expect(summaryToneOf("sec-feeders")).toBe("neutral");
	});
});

describe("ChannelDetail — a failed read is not a healthy channel", () => {
	it("alerts RESOLVING with an empty list is still ON_AIR, a green 0, and '0 open'", async () => {
		mockPage("none");
		wrap(<ChannelDetail id={CHANNEL} />);
		await screen.findByRole("region", { name: /channel status/i });
		await waitFor(() => expect(nextActionCode()).toBe("ON_AIR"));
		expect(stripCell("alerts")?.textContent).toBe("0");
		expect(stripCell("alerts")?.className).toContain("text-emerald-400");
		expect(summaryOf("sec-alerts")).toBe("0 open");
		// The healthy control for the TONE too (review #348 M2): the card is
		// green here, so an amber-everywhere mutant cannot pass either.
		expect(summaryToneOf("sec-alerts")).toBe("ok");
	});

	it("a FAILED alerts query cannot be ON_AIR — the strip, the summary and the next action all say unknown", async () => {
		mockPage("alerts");
		wrap(<ChannelDetail id={CHANNEL} />);
		await screen.findByRole("region", { name: /channel status/i });
		await waitFor(() => expect(nextActionCode()).toBe("ALERTS_UNKNOWN"));
		expect(nextActionCode()).not.toBe("ON_AIR");
		// The strip: amber unknown, not a green zero.
		expect(stripCell("alerts")?.textContent).toBe("unknown");
		expect(stripCell("alerts")?.className).toContain("text-amber-400");
		expect(stripCell("alerts")?.className).not.toContain("text-emerald-400");
		// The section summary: the same, in the closed-card line.
		expect(summaryOf("sec-alerts")).toBe("could not be read");
		expect(summaryOf("sec-alerts")).not.toBe("0 open");
		// …in AMBER. Review #348 M2: the reviewer's mutant hardcoded this
		// card's tone to "ok" and survived 17/17 arms — a card whose words
		// say "could not be read" while its colour says healthy.
		expect(summaryToneOf("sec-alerts")).toBe("warn");
		expect(summaryToneOf("sec-alerts")).not.toBe("ok");
		// And the panel names the state in words, so the amber is not the
		// only carrier of the meaning.
		expect(
			within(document.getElementById("sec-alerts") as HTMLElement).getByText(
				/could not be read/i,
			),
		).toBeInTheDocument();
	});

	it("a FAILED schedules query summarises as unreadable, not as 'none armed'", async () => {
		mockPage("schedules");
		wrap(<ChannelDetail id={CHANNEL} />);
		await screen.findByRole("region", { name: /channel status/i });
		await waitFor(() =>
			expect(summaryOf("sec-schedule")).toBe("could not be read"),
		);
		expect(summaryOf("sec-schedule")).not.toBe("none armed");
		expect(summaryToneOf("sec-schedule")).toBe("warn");
		expect(summaryToneOf("sec-schedule")).not.toBe("neutral");
		// The panel below it drops both empty-state claims.
		expect(screen.queryByText("Nothing armed.")).toBeNull();
		expect(screen.queryByText("Nothing has run yet.")).toBeNull();
	});

	it("a healthy schedules query still summarises 'none armed' for an empty list", async () => {
		mockPage("none");
		wrap(<ChannelDetail id={CHANNEL} />);
		await screen.findByRole("region", { name: /channel status/i });
		await waitFor(() => expect(summaryOf("sec-schedule")).toBe("none armed"));
		// The neutral control: an empty-but-READ list is grey, so "warn
		// everywhere" is not a way to pass the arm above.
		expect(summaryToneOf("sec-schedule")).toBe("neutral");
		expect(await screen.findByText("Nothing armed.")).toBeInTheDocument();
	});

	it("the page waits for alerts and schedules before it renders a verdict — review #348 M3", async () => {
		// The window the reviewer reproduced: `channel` settles first, and
		// the old guard lifted the skeleton right there — so for one round
		// trip the page showed the PRE-FIX signature (a green 0 and ON_AIR)
		// off two queries that had returned nothing yet, simply because
		// pending and "read, empty" were the same `?? 0`.
		let releaseAlerts: ((value: unknown) => void) | null = null;
		apiFetch.mockImplementation(async (input: string) => {
			if (input.endsWith("/alerts")) {
				return new Promise((resolve) => {
					releaseAlerts = resolve;
				});
			}
			if (input.endsWith("/schedules")) {
				return [];
			}
			if (input.endsWith("/health")) {
				return runHealth();
			}
			if (input.endsWith("/runs")) {
				return { runs: [] };
			}
			if (input.startsWith(`/api/live-channels/${CHANNEL}`)) {
				return channelRow();
			}
			return { items: [] };
		});
		wrap(<ChannelDetail id={CHANNEL} />);
		// The channel row has resolved (the skeleton's own label proves the
		// page got past its query), yet no verdict is on screen.
		expect(
			await screen.findByRole("status", { name: /loading/i }),
		).toBeInTheDocument();
		await waitFor(() => expect(releaseAlerts).not.toBeNull());
		expect(nextActionCode()).toBeNull();
		expect(stripCell("alerts")).toBeNull();
		expect(
			screen.queryByRole("region", { name: /channel status/i }),
		).toBeNull();

		// Released: the real answer arrives, and only then does the page
		// commit to one.
		(releaseAlerts as unknown as (v: unknown) => void)({
			open: [],
			history: [],
		});
		await screen.findByRole("region", { name: /channel status/i });
		await waitFor(() => expect(nextActionCode()).toBe("ON_AIR"));
	});
});
