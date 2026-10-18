import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithQuery } from "@/test/render";
import { ChannelDetail } from "./channel-detail";

const apiFetch = vi.fn();
vi.mock("@/lib/api", async () => {
	const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
	return {
		ApiError: actual.ApiError,
		apiFetch: (...args: unknown[]) => apiFetch(...args),
	};
});

vi.mock("next/navigation", () => ({
	useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

afterEach(() => {
	apiFetch.mockReset();
	vi.restoreAllMocks();
});

const ID = "00000000-0000-4000-8000-0000000000d1";

/**
 * The REQUIRED fixture : a channel
 * with NO runs at all — reachable, not theoretical, since #240's backfill
 * gives a created-never-provisioned channel no run row. `IDLE` is
 * deliberately outside the byte-pinned status enum, so an enum-keyed Record
 * or switch silently lacks its branch; the tone map is now keyed by the
 * DERIVED type (tsc demands the entry), and this test proves the RENDER.
 */
describe("ChannelDetail — the never-run channel (IDLE goes live)", () => {
	it("renders the IDLE badge with a real tone, and every panel survives currentRun: null", async () => {
		const consoleError = vi.spyOn(console, "error");
		apiFetch.mockImplementation(async (url: string) => {
			if (url === `/api/live-channels/${ID}`) {
				return {
					id: ID,
					name: "eve-idle",
					status: "CREATED",
					plan: { planVersion: 1, name: "eve-idle" },
					stepLog: [],
					streamKey: null,
					encoderIp: null,
					programStartAt: null,
					programEndAt: null,
					lastHeartbeat: null,
					liveToVod: null,
					playbackLinks: [],
					maxRunMinutes: null,
					bitmovinEncodingId: null,
					bitmovinAccountId: null,
					createdAt: "2026-08-17T00:00:00.000Z",
					updatedAt: "2026-08-17T00:00:00.000Z",
					currentRun: null,
				};
			}
			if (url.includes("/alerts")) {
				return { open: [], history: [] };
			}
			if (url.includes("/schedules")) {
				return [];
			}
			if (url.includes("/feeder")) {
				return { items: [] };
			}
			if (url.includes("/runs")) {
				return { runs: [] };
			}
			return [];
		});
		renderWithQuery(<ChannelDetail id={ID} />);

		// The badge shows the DERIVED status — IDLE, not the channel column's
		// CREATED — with a tone from the widened map (a missing entry would
		// have failed tsc before this test even ran; the render proves the
		// value reaches the operator as a badge, not a blank or a raw key).
		const badge = await screen.findByText("IDLE");
		expect(badge).toBeInTheDocument();
		// And the page did not crash on the null run: the channel name
		// renders, which sits beyond every panel in the tree.
		expect(screen.getByText("eve-idle")).toBeInTheDocument();
		// The Runs card  states the empty history honestly.
		expect(await screen.findByText(/never been started/i)).toBeInTheDocument();
		// Layer section arrays must identify their nodes, not rely on position.
		// This mounted regression catches React's missing-key warning without
		// hiding other console errors from the runner.
		expect(
			consoleError.mock.calls.filter((args) =>
				args.some(
					(arg) => typeof arg === "string" && arg.includes('unique "key"'),
				),
			),
		).toEqual([]);
	});
});

/**
 * The `{}` record (found 2026-08-22 by the real-browser pass): one production
 * row carried `liveToVod: {}` — no current writer produces it, but the reader
 * must survive the column's REAL population. Before normalizeLiveToVod the
 * panel read `record.manifests.length` and the whole page died to the app
 * shell's error boundary; every jsdom fixture carried either null or the
 * complete shape, so 3,900+ tests were green over the crash.
 */
describe("ChannelDetail — malformed liveToVod records", () => {
	it("an empty-object record renders as NO record, not a crash", async () => {
		apiFetch.mockImplementation(async (url: string) => {
			if (url === `/api/live-channels/${ID}`) {
				return {
					id: ID,
					name: "eve-empty-record",
					status: "STOPPED",
					plan: { planVersion: 1, name: "eve-empty-record" },
					stepLog: [],
					streamKey: null,
					encoderIp: null,
					programStartAt: null,
					programEndAt: null,
					lastHeartbeat: null,
					// The real-world datum, verbatim.
					liveToVod: {},
					playbackLinks: [],
					maxRunMinutes: null,
					bitmovinEncodingId: null,
					bitmovinAccountId: null,
					createdAt: "2026-08-17T00:00:00.000Z",
					updatedAt: "2026-08-17T00:00:00.000Z",
					currentRun: null,
				};
			}
			if (url.includes("/alerts")) {
				return { open: [], history: [] };
			}
			if (url.includes("/schedules")) {
				return [];
			}
			if (url.includes("/feeder")) {
				return { items: [] };
			}
			if (url.includes("/runs")) {
				return { runs: [] };
			}
			return [];
		});
		renderWithQuery(<ChannelDetail id={ID} />);
		// The page survives; the record block simply is not there (the
		// negative half — review-uibatch #10: survival alone would also pass
		// if the block rendered garbage).
		expect(await screen.findByText("eve-empty-record")).toBeInTheDocument();
		expect(screen.queryByText("Last run:")).not.toBeInTheDocument();
	});
});

it("offers a retry after the channel detail read fails", async () => {
	apiFetch.mockRejectedValue(new Error("offline"));
	renderWithQuery(<ChannelDetail id={ID} />);
	await screen.findByRole("alert");
	const count = apiFetch.mock.calls.filter(
		([url]) => url === `/api/live-channels/${ID}`,
	).length;
	fireEvent.click(screen.getByRole("button", { name: "Retry" }));
	await waitFor(() =>
		expect(
			apiFetch.mock.calls.filter(([url]) => url === `/api/live-channels/${ID}`)
				.length,
		).toBe(count + 1),
	);
});
