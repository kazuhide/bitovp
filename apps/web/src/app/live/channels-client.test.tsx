import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithQuery as wrap } from "@/test/render";

const apiFetch = vi.fn();
vi.mock("@/lib/api", async (orig) => ({
	...(await orig<Record<string, unknown>>()),
	apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

import { ChannelsClient } from "./channels-client";
import type {
	LiveChannelHealthDigest,
	LiveChannelListItem,
} from "./live-shared";

describe("channel list keeps internal inventory out of daily operations", () => {
	it.each([
		"en",
		"ja",
	] as const)("does not show reconciliation controls or request account inventory (%s)", async (locale) => {
		mockList([]);
		wrap(<ChannelsClient />, locale);
		await screen.findByText(
			locale === "ja"
				? /ライブチャンネルがまだありません/
				: /No live channels yet/,
		);
		expect(document.getElementById("live-inventory-title")).toBeNull();
		expect(
			apiFetch.mock.calls.some(([url]) =>
				/^\/api\/(bitmovin-accounts|live\/orphan-inventory)/.test(url),
			),
		).toBe(false);
	});
});

/** The clock every fixture below is written against. */
const NOW = "2026-08-29T12:00:00.000Z";
const nowMs = Date.parse(NOW);

function health(over: Partial<LiveChannelHealthDigest> = {}) {
	return {
		heartbeat: null,
		openAlerts: 0,
		activeFeeders: 0,
		erroredFeeders: 0,
		origin: null,
		runningSince: null,
		endedAt: null,
		maxRunMinutes: null,
		...over,
	} satisfies LiveChannelHealthDigest;
}

/** A heartbeat digest in the shape core's freshness helpers read. */
function heartbeat(agoMs: number, status = "CONNECTED") {
	return {
		at: new Date(nowMs - agoMs).toISOString(),
		raw: { ingest: { status, healthy: status === "CONNECTED" } },
	};
}

function channel(over: Partial<LiveChannelListItem> = {}): LiveChannelListItem {
	return {
		id: "00000000-0000-4000-8000-0000000000c1",
		name: "Channel A",
		status: "STOPPED",
		error: null,
		bitmovinEncodingId: "bm-1",
		bitmovinAccountId: null,
		createdAt: "2026-06-18T00:00:00.000Z",
		updatedAt: "2026-06-18T00:00:00.000Z",
		health: health(),
		...over,
	};
}

function mockList(items: LiveChannelListItem[]) {
	apiFetch.mockImplementation(async (input: string, init?: RequestInit) => {
		if (input === "/api/bitmovin-accounts") return [];
		if (input === "/api/auth/session") {
			return {
				mode: "password",
				configured: true,
				authenticated: true,
				loginKind: "password-form",
			};
		}
		if (init?.method === "DELETE") {
			return { deleted: true };
		}
		return { items, serverNow: NOW };
	});
}

/**
 * The five-channel fleet the cockpit exists for (audit 4403130 §5.5): one of
 * each thing an operator has to be able to tell apart WITHOUT opening a
 * detail page. Names are deliberately alphabetical-against-severity, so an
 * order that merely sorts by name is visibly not an order that sorts by
 * anomaly.
 */
const FLEET: LiveChannelListItem[] = [
	channel({
		id: "00000000-0000-4000-8000-000000000001",
		name: "Bravo healthy",
		status: "RUNNING",
		bitmovinEncodingId: "bm-bravo",
		health: health({
			heartbeat: heartbeat(12_000),
			origin: { observed: 2, stale: 0, endlist: 0, unavailableReason: null },
			runningSince: new Date(nowMs - 3_600_000).toISOString(),
			maxRunMinutes: 120,
		}),
		// Armed, but four hours out: "Scheduled soon" must be a WINDOW, not
		// "has a schedule at all".
		nextSchedule: {
			fireAt: new Date(nowMs + 4 * 3_600_000).toISOString(),
			action: "STOP",
		},
	}),
	channel({
		id: "00000000-0000-4000-8000-000000000002",
		name: "Delta stale",
		status: "RUNNING",
		bitmovinEncodingId: "bm-delta",
		health: health({ heartbeat: heartbeat(600_000) }),
	}),
	channel({
		id: "00000000-0000-4000-8000-000000000003",
		name: "Alpha alerting",
		status: "RUNNING",
		bitmovinEncodingId: "bm-alpha",
		health: health({ heartbeat: heartbeat(9_000), openAlerts: 2 }),
	}),
	channel({
		id: "00000000-0000-4000-8000-000000000004",
		name: "Echo scheduled",
		status: "STOPPED",
		bitmovinEncodingId: "bm-echo",
		nextSchedule: {
			fireAt: new Date(nowMs + 5 * 60_000).toISOString(),
			action: "START",
		},
	}),
	channel({
		id: "00000000-0000-4000-8000-000000000005",
		name: "Charlie broken",
		status: "ERROR",
		bitmovinEncodingId: "bm-charlie",
		error: "start failed",
	}),
];

/** Row order as the operator sees it, header row excluded. */
function renderedOrder(): string[] {
	const rows = screen.getAllByRole("row").slice(1);
	return rows
		.map((row) => within(row).queryAllByRole("link")[0]?.textContent ?? "")
		.filter((name) => name !== "");
}

function rowFor(name: string): HTMLElement {
	const link = screen.getByRole("link", { name });
	const row = link.closest("tr");
	if (!row) {
		throw new Error(`no row for ${name}`);
	}
	return row;
}

function facet(row: HTMLElement, key: string): string {
	const node = row.querySelector(`[data-health-facet="${key}"]`);
	if (!node) {
		throw new Error(`no ${key} facet`);
	}
	return node.textContent ?? "";
}

/**
 * The tone class on a facet's VALUE span. The colour is never the only
 * channel — every facet also carries a word — but a red cell on a row the
 * sort has ranked healthy is the screen disagreeing with itself, so the two
 * are pinned together.
 */
function facetTone(row: HTMLElement, key: string): string {
	const node = row.querySelector(
		`[data-health-facet="${key}"] span:last-of-type`,
	);
	if (!node) {
		throw new Error(`no ${key} facet value`);
	}
	return node.className;
}

beforeEach(() => {
	vi.clearAllMocks();
	window.localStorage.clear();
	// Only Date is faked: the query client's own timers must keep running.
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(nowMs);
});

afterEach(() => {
	vi.useRealTimers();
});

describe("ChannelsClient — delete moved out of the primary columns (audit 4403130 §5.5)", () => {
	it("is not in the row's own cells and is reached through the row menu", async () => {
		mockList([channel({ name: "Stopped one", status: "STOPPED" })]);
		wrap(<ChannelsClient />);
		await screen.findByText("Stopped one");

		// The destructive control is not one mis-click from the row link.
		expect(
			screen.queryByRole("button", { name: "Delete Stopped one" }),
		).toBeNull();

		const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
		const trigger = screen.getByRole("button", {
			name: "Actions for Stopped one",
		});
		expect(trigger).toHaveAttribute("aria-expanded", "false");
		await user.click(trigger);
		expect(trigger).toHaveAttribute("aria-expanded", "true");
		expect(
			screen.getByRole("button", { name: "Delete Stopped one" }),
		).not.toBeDisabled();
	});

	it("still mirrors the route's 409 guard: an active channel's delete is disabled", async () => {
		mockList([
			channel({
				id: "00000000-0000-4000-8000-0000000000c2",
				name: "Running one",
				status: "RUNNING",
			}),
		]);
		wrap(<ChannelsClient />);
		await screen.findByText("Running one");
		const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
		await user.click(
			screen.getByRole("button", { name: "Actions for Running one" }),
		);
		expect(
			screen.getByRole("button", { name: /Delete Running one \(disabled\)/ }),
		).toBeDisabled();
	});

	it("confirms then DELETEs the channel and refetches the list", async () => {
		mockList([channel({ name: "Stopped one", status: "STOPPED" })]);
		wrap(<ChannelsClient />);
		await screen.findByText("Stopped one");

		const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
		await user.click(
			screen.getByRole("button", { name: "Actions for Stopped one" }),
		);
		await user.click(
			screen.getByRole("button", { name: "Delete Stopped one" }),
		);
		await user.click(screen.getByRole("button", { name: "Delete" }));

		await waitFor(() => {
			const call = apiFetch.mock.calls.find(
				(c) =>
					String(c[0]) === `/api/live-channels/${channel().id}` &&
					(c[1] as RequestInit)?.method === "DELETE",
			);
			expect(call).toBeTruthy();
		});
		await waitFor(() => {
			const getCalls = apiFetch.mock.calls.filter(
				(c) => (c[1] as RequestInit)?.method !== "DELETE",
			);
			expect(getCalls.length).toBeGreaterThan(1);
		});
	});
});

describe("ChannelsClient — provider-aware status", () => {
	it.each([
		[
			"provider UNKNOWN",
			{
				providerStatus: "RUNNING",
				providerStatusObservedAt: NOW,
				providerUnknownSince: NOW,
				providerTerminalAt: null,
			},
		],
		[
			"provider UNOBSERVED",
			{
				providerStatus: null,
				providerStatusObservedAt: null,
				providerUnknownSince: null,
				providerTerminalAt: null,
			},
		],
	] as const)("does not show green RUNNING for %s", async (_case, provider) => {
		mockList([
			channel({
				name: "Unconfirmed channel",
				status: "RUNNING",
				health: health({ provider }),
			}),
		]);
		wrap(<ChannelsClient />);
		await screen.findByRole("link", { name: "Unconfirmed channel" });
		const row = rowFor("Unconfirmed channel");
		const badge = within(row).getByText(
			"RUNNING · Bitmovin status unconfirmed",
		);
		expect(badge.className).toContain("amber");
		expect(badge.className).not.toContain("emerald");
		expect(within(row).queryByText("RUNNING")).toBeNull();
	});
});

describe("ChannelsClient — anomaly-first order (audit 4403130 §5.5)", () => {
	it("puts ERROR, then an open alert, then a stale heartbeat above the healthy rows — and orders the rest by name", async () => {
		mockList(FLEET);
		wrap(<ChannelsClient />);
		await screen.findByText("Bravo healthy");
		/*
		 * The pin is the ORDER, not the presence. Sorted by name alone this
		 * would read Alpha, Bravo, Charlie, Delta, Echo — which is what the
		 * mutation that drops the rank comparison produces, and why the
		 * fixture's names run against its severities.
		 */
		expect(renderedOrder()).toEqual([
			"Charlie broken",
			"Alpha alerting",
			"Delta stale",
			"Bravo healthy",
			"Echo scheduled",
		]);
	});

	it("Newest first restores the server's own order — the operator can leave the anomaly view", async () => {
		mockList(FLEET);
		wrap(<ChannelsClient />);
		await screen.findByText("Bravo healthy");
		const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
		await user.selectOptions(screen.getByLabelText("Sort"), "created");
		// Every fixture shares a createdAt, so the tie-break by name is what
		// shows — and it is NOT the anomaly order.
		expect(renderedOrder()).toEqual([
			"Alpha alerting",
			"Bravo healthy",
			"Charlie broken",
			"Delta stale",
			"Echo scheduled",
		]);
	});
});

/**
 * Review of PR #359, reproduced: `FEEDER_ERROR` and `OUTPUT_NOT_ADVANCING`
 * ranked a STOPPED channel above every healthy row forever.
 *
 * The origin observer only polls RUNNING channels and the route reads the
 * newest run unconditionally, so a channel stopped BECAUSE its output stalled
 * — or one that merely caught a stale tick on its final poll — carried its
 * last verdict into the anomaly rank with nothing an operator could do to
 * clear it. Both directions are pinned here: the STOPPED pair must rank
 * healthy AND stay out of Needs attention, and the RUNNING pair must still
 * rank as anomalies, so a gate that suppressed the live case too would fail
 * just as loudly as the missing gate did.
 */
describe("ChannelsClient — a post-mortem is not an anomaly (review-359)", () => {
	const POST_MORTEM: LiveChannelListItem[] = [
		channel({
			id: "00000000-0000-4000-8000-00000000a001",
			name: "A running stalled origin",
			status: "RUNNING",
			health: health({
				heartbeat: heartbeat(5_000),
				origin: { observed: 1, stale: 1, endlist: 0, unavailableReason: null },
			}),
		}),
		channel({
			id: "00000000-0000-4000-8000-00000000a002",
			name: "B running failed feeder",
			status: "RUNNING",
			health: health({ heartbeat: heartbeat(5_000), erroredFeeders: 1 }),
		}),
		channel({
			id: "00000000-0000-4000-8000-00000000a003",
			name: "C stopped stalled origin",
			status: "STOPPED",
			health: health({
				origin: { observed: 1, stale: 1, endlist: 0, unavailableReason: null },
			}),
		}),
		channel({
			id: "00000000-0000-4000-8000-00000000a004",
			name: "D stopped failed feeder",
			status: "STOPPED",
			health: health({ erroredFeeders: 1 }),
		}),
		channel({
			id: "00000000-0000-4000-8000-00000000a005",
			name: "E stopped clean",
			status: "STOPPED",
		}),
	];

	it("ranks the two RUNNING faults above the healthy rows and leaves the two STOPPED post-mortems among them", async () => {
		mockList(POST_MORTEM);
		wrap(<ChannelsClient />);
		await screen.findByText("E stopped clean");
		/*
		 * FEEDER_ERROR outranks OUTPUT_NOT_ADVANCING, so the running pair
		 * comes back B-then-A — already NOT the name order, which is what
		 * makes this array a reading of the rank rather than of the
		 * tie-break. What the gate decides is where the STOPPED pair lands:
		 * with it they sit among the healthy rows in name order (C, D, E);
		 * without it D joins B at rank 3 and C joins A at rank 4, i.e.
		 * [B, D, A, C, E] — a different array either way round.
		 */
		expect(renderedOrder()).toEqual([
			"B running failed feeder",
			"A running stalled origin",
			"C stopped stalled origin",
			"D stopped failed feeder",
			"E stopped clean",
		]);
	});

	it("Needs attention holds exactly the two RUNNING faults — a stopped channel's last verdict is not work", async () => {
		mockList(POST_MORTEM);
		wrap(<ChannelsClient />);
		await screen.findByText("E stopped clean");
		const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
		await user.selectOptions(screen.getByLabelText("Show"), "error");
		// Membership, not order — the order is the previous test's pin.
		expect(renderedOrder().sort()).toEqual([
			"A running stalled origin",
			"B running failed feeder",
		]);
	});

	it("the Health cell agrees with the rank: the same verdict is red while running and neutral after the stop", async () => {
		mockList(POST_MORTEM);
		wrap(<ChannelsClient />);
		await screen.findByText("E stopped clean");
		// The WORD is the same in both rows — the facts are reported either
		// way; only the alarm is withheld.
		expect(facet(rowFor("A running stalled origin"), "output")).toContain(
			"Stalled",
		);
		expect(facet(rowFor("C stopped stalled origin"), "output")).toContain(
			"Stalled",
		);
		expect(facetTone(rowFor("A running stalled origin"), "output")).toContain(
			"text-red-400",
		);
		expect(
			facetTone(rowFor("C stopped stalled origin"), "output"),
		).not.toContain("text-red-400");

		expect(facet(rowFor("B running failed feeder"), "feeder")).toContain(
			"1 failed",
		);
		expect(facet(rowFor("D stopped failed feeder"), "feeder")).toContain(
			"1 failed",
		);
		expect(facetTone(rowFor("B running failed feeder"), "feeder")).toContain(
			"text-red-400",
		);
		expect(
			facetTone(rowFor("D stopped failed feeder"), "feeder"),
		).not.toContain("text-red-400");
	});
});

describe("ChannelsClient — filters (audit 4403130 §5.5)", () => {
	async function selectFilter(value: string) {
		const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
		await user.selectOptions(screen.getByLabelText("Show"), value);
	}

	it("Active narrows to the transitional/running rows", async () => {
		mockList(FLEET);
		wrap(<ChannelsClient />);
		await screen.findByText("Bravo healthy");
		await selectFilter("active");
		expect(renderedOrder().sort()).toEqual([
			"Alpha alerting",
			"Bravo healthy",
			"Delta stale",
		]);
	});

	it("Needs attention narrows to the ERROR row and every health anomaly — never the healthy ones", async () => {
		mockList(FLEET);
		wrap(<ChannelsClient />);
		await screen.findByText("Bravo healthy");
		await selectFilter("error");
		expect(renderedOrder().sort()).toEqual([
			"Alpha alerting",
			"Charlie broken",
			"Delta stale",
		]);
		// The definition is on screen, because "Error" here is wider than the
		// status of that name.
		expect(
			screen.getByText(/Needs attention is wider than the ERROR status/),
		).toBeInTheDocument();
	});

	it("Scheduled soon is a WINDOW: the row firing in 5 minutes, not the one firing in 4 hours", async () => {
		mockList(FLEET);
		wrap(<ChannelsClient />);
		await screen.findByText("Bravo healthy");
		await selectFilter("soon");
		expect(renderedOrder()).toEqual(["Echo scheduled"]);
	});

	it("the name search narrows to a substring, case-insensitively, and says so when nothing matches", async () => {
		mockList(FLEET);
		wrap(<ChannelsClient />);
		await screen.findByText("Bravo healthy");
		const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
		await user.type(screen.getByLabelText("Name"), "alph");
		expect(renderedOrder()).toEqual(["Alpha alerting"]);
		await user.clear(screen.getByLabelText("Name"));
		await user.type(screen.getByLabelText("Name"), "zzz");
		expect(
			screen.getByText("No channel matches this filter."),
		).toBeInTheDocument();
	});

	it("remembers the filter per viewer — and renders correctly with nothing stored", async () => {
		mockList(FLEET);
		const first = wrap(<ChannelsClient />);
		await screen.findByText("Bravo healthy");
		// Nothing stored ⇒ the default view shows the whole fleet.
		expect(renderedOrder()).toHaveLength(5);
		const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
		await user.selectOptions(screen.getByLabelText("Show"), "active");
		first.unmount();

		wrap(<ChannelsClient />);
		await screen.findByText("Bravo healthy");
		await waitFor(() =>
			expect(renderedOrder().sort()).toEqual([
				"Alpha alerting",
				"Bravo healthy",
				"Delta stale",
			]),
		);
	});

	it("a localStorage that throws is not a broken list", async () => {
		const getItem = vi
			.spyOn(Storage.prototype, "getItem")
			.mockImplementation(() => {
				throw new Error("site data blocked");
			});
		try {
			mockList(FLEET);
			wrap(<ChannelsClient />);
			await screen.findByText("Bravo healthy");
			expect(renderedOrder()).toHaveLength(5);
			expect(getItem).toHaveBeenCalled();
		} finally {
			getItem.mockRestore();
		}
	});
});

describe("ChannelsClient — the Health column reads as text (audit 4403130 §5.5)", () => {
	it("gives each row's input, heartbeat, output, alert and feeder state a WORD, not a colour", async () => {
		mockList(FLEET);
		wrap(<ChannelsClient />);
		await screen.findByText("Bravo healthy");

		const healthy = rowFor("Bravo healthy");
		expect(facet(healthy, "ingest")).toContain("Connected");
		expect(facet(healthy, "heartbeat")).toContain("12s ago");
		expect(facet(healthy, "output")).toContain("Advancing");
		expect(facet(healthy, "alerts")).toContain("0");
		expect(facet(healthy, "feeder")).toContain("None");

		// A sample past the vouching window cannot vouch: the wire word is
		// withheld and the ingest reads unknown .
		const stale = rowFor("Delta stale");
		expect(facet(stale, "ingest")).toContain("unknown");
		expect(facet(stale, "heartbeat")).toContain("600s ago");
		// Nothing was ever observed at the origin — unknown, not "no output".
		expect(facet(stale, "output")).toContain("unknown");

		expect(facet(rowFor("Alpha alerting"), "alerts")).toContain("2");
	});

	it("an alert read that FAILED says unknown rather than a green zero", async () => {
		mockList([
			channel({
				name: "Unknowable",
				status: "RUNNING",
				health: health({ heartbeat: heartbeat(5_000), openAlerts: "unknown" }),
			}),
		]);
		wrap(<ChannelsClient />);
		await screen.findByText("Unknowable");
		const cell = facet(rowFor("Unknowable"), "alerts");
		expect(cell).toContain("unknown");
		expect(cell).not.toContain("0");
	});

	it("a run-scoped feeder failure and a stalled origin both surface as words", async () => {
		mockList([
			channel({
				name: "Feeder down",
				status: "RUNNING",
				health: health({
					heartbeat: heartbeat(5_000),
					erroredFeeders: 1,
					origin: {
						observed: 1,
						stale: 1,
						endlist: 0,
						unavailableReason: null,
					},
				}),
			}),
		]);
		wrap(<ChannelsClient />);
		await screen.findByText("Feeder down");
		const row = rowFor("Feeder down");
		expect(facet(row, "feeder")).toContain("1 failed");
		expect(facet(row, "output")).toContain("Stalled");
	});
});

describe("ChannelsClient — Next event and Runtime (audit 4403130 §5.5)", () => {
	it("counts down to the armed fire time on the SERVER's clock", async () => {
		mockList(FLEET);
		wrap(<ChannelsClient />);
		await screen.findByText("Echo scheduled");
		const row = rowFor("Echo scheduled");
		expect(row.textContent).toContain("START");
		expect(
			row.querySelector('[data-next-event="countdown"]')?.textContent,
		).toBe("in 5m 0s");
	});

	it("an armed row past its fire time reads as due, not as a negative duration", async () => {
		mockList([
			channel({
				name: "Overdue",
				status: "STOPPED",
				nextSchedule: {
					fireAt: new Date(nowMs - 90_000).toISOString(),
					action: "START",
				},
			}),
		]);
		wrap(<ChannelsClient />);
		await screen.findByText("Overdue");
		expect(
			rowFor("Overdue").querySelector('[data-next-event="countdown"]')
				?.textContent,
		).toBe("due now");
	});

	it("shows elapsed against the runtime cap while running", async () => {
		mockList(FLEET);
		wrap(<ChannelsClient />);
		await screen.findByText("Bravo healthy");
		const row = rowFor("Bravo healthy");
		expect(row.textContent).toContain("1h 0m elapsed");
		expect(row.querySelector('[data-runtime="remaining"]')?.textContent).toBe(
			"1h 0m to cap",
		);
	});

	it("a FINISHED run's elapsed stops at its end and drops the cap line — no forever-growing clock", async () => {
		mockList([
			channel({
				name: "Yesterday",
				status: "STOPPED",
				health: health({
					runningSince: new Date(nowMs - 86_400_000).toISOString(),
					endedAt: new Date(nowMs - 86_400_000 + 1_800_000).toISOString(),
					maxRunMinutes: 60,
				}),
			}),
		]);
		wrap(<ChannelsClient />);
		await screen.findByText("Yesterday");
		const row = rowFor("Yesterday");
		expect(row.textContent).toContain("30m 0s elapsed");
		expect(row.querySelector('[data-runtime="remaining"]')).toBeNull();
	});
});

describe("ChannelsClient — the encoding id is demoted, not dropped", () => {
	it("loses its column and becomes a copy affordance under the name", async () => {
		mockList([channel({ name: "Stopped one", bitmovinEncodingId: "bm-77" })]);
		wrap(<ChannelsClient />);
		await screen.findByText("Stopped one");
		expect(
			screen.queryByRole("columnheader", { name: "Encoding id" }),
		).toBeNull();
		const copy = screen.getByRole("button", {
			name: "Copy Encoding id: bm-77",
		});
		expect(copy.closest("td")).toBe(rowFor("Stopped one").firstElementChild);
	});
});

/**
 * The channel list in Japanese. Hardcoded literals rather than `t` lookups — an
 * expectation read through the same catalogue as the component moves in lockstep
 * with it and proves nothing.
 */
describe("ChannelsClient — Japanese", () => {
	it("renders the heading, the promoted headers, the filter controls and the empty state in Japanese", async () => {
		mockList([]);
		wrap(<ChannelsClient />, "ja");
		for (const label of [
			"ライブチャンネル",
			"ライブチャンネルを作成",
			"健全性",
			"次の予定",
			"稼働時間",
			"表示",
			"並び順",
			"操作",
		]) {
			expect((await screen.findAllByText(label)).length, label).toBeGreaterThan(
				0,
			);
		}
		expect(
			await screen.findByText(/ライブチャンネルがまだありません/),
		).toBeInTheDocument();
		for (const english of [
			"Live Channels",
			"New Live Channel",
			"Health",
			"Next event",
			"Runtime",
		]) {
			expect(screen.queryByText(english), english).not.toBeInTheDocument();
		}
	});

	it("renders the health words and the row menu in Japanese too", async () => {
		mockList([
			channel({
				name: "日本語チャンネル",
				status: "RUNNING",
				health: health({
					heartbeat: heartbeat(8_000),
					origin: {
						observed: 1,
						stale: 1,
						endlist: 0,
						unavailableReason: null,
					},
					erroredFeeders: 2,
				}),
			}),
		]);
		wrap(<ChannelsClient />, "ja");
		await screen.findByText("日本語チャンネル");
		const row = rowFor("日本語チャンネル");
		expect(facet(row, "ingest")).toContain("接続済み");
		expect(facet(row, "heartbeat")).toContain("8秒前");
		expect(facet(row, "output")).toContain("停止");
		expect(facet(row, "feeder")).toContain("2 件失敗");
		expect(
			screen.getByRole("button", { name: "「日本語チャンネル」の操作" }),
		).toBeInTheDocument();
	});
});

describe("the name column cannot be ballooned by an error sentence (owner report 2026-08-21)", () => {
	it.each([
		"en",
		"ja",
	] as const)("keeps errors on the detail page, not in the list (%s)", async (locale) => {
		const longError =
			"POST /encoding/encodings/xxxx/live/start failed (400): The segment name must be in the format '[prefix]-{rand_chars[:number]}-%number%.[extension]' where '[prefix]' can be any prefix";
		mockList([
			channel({
				id: "00000000-0000-4000-8000-0000000000e1",
				name: "erroring-channel",
				status: "ERROR",
				error: longError,
			}),
		]);
		wrap(<ChannelsClient />, locale);
		const link = await screen.findByText("erroring-channel");
		/*
		 * The MECHANISM is the pin: `truncate` only bites under a width bound,
		 * and in an auto-layout `w-full` table that bound is `max-w-0` on the
		 * cell (which then absorbs the slack via w-full). Without it the error
		 * sentence sets the column's intrinsic width and squeezes
		 * status/encoding-id — the exact symptom the owner reported. jsdom
		 * computes no layout, so the class contract is what a test can hold.
		 */
		const nameCell = link.closest("td");
		expect(nameCell?.className).toContain("max-w-0");
		expect(nameCell?.className).toContain("w-full");
		const customerError =
			"The live operation encountered a problem. Check the activity history and current channel state, then retry if appropriate.";
		expect(
			screen.queryByRole("link", {
				name: locale === "ja" ? "エラー詳細" : "Error details",
			}),
		).not.toBeInTheDocument();
		expect(link).toHaveAttribute(
			"href",
			"/live/00000000-0000-4000-8000-0000000000e1",
		);
		expect(link).not.toHaveAttribute("title");
		expect(screen.queryByText(customerError)).not.toBeInTheDocument();
		expect(
			screen.queryByText(/配信処理で問題が発生しました/),
		).not.toBeInTheDocument();
		expect(screen.queryByText(longError)).not.toBeInTheDocument();
	});
	it("does not add an error link to a channel without a recorded failure", async () => {
		mockList([channel()]);
		wrap(<ChannelsClient />);
		await screen.findByText("Channel A");
		expect(
			screen.queryByRole("link", { name: "Error details" }),
		).not.toBeInTheDocument();
	});
});

it("keeps loaded channels visible when a later page fails and retries that page", async () => {
	let failPage = true;
	apiFetch.mockImplementation(async (url: string) => {
		if (url === "/api/live-channels")
			return { items: [channel()], nextCursor: "older" };
		if (url.includes("cursor=older")) {
			if (failPage) throw new Error("offline");
			return { items: [channel({ id: "older", name: "Older channel" })] };
		}
		return [];
	});
	wrap(<ChannelsClient />);
	await userEvent.click(
		await screen.findByRole("button", { name: "Load more" }),
	);
	await screen.findByRole("alert");
	expect(screen.getByRole("link", { name: "Channel A" })).toBeInTheDocument();
	failPage = false;
	await userEvent.click(screen.getByRole("button", { name: "Retry" }));
	expect(
		await screen.findByRole("link", { name: "Older channel" }),
	).toBeInTheDocument();
});
