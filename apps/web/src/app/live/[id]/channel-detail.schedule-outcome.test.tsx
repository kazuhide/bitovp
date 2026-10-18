import { screen } from "@testing-library/react";
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

afterEach(() => apiFetch.mockReset());

const ID = "00000000-0000-4000-8000-0000000000d2";

/**
 * , the audit's "if cheap" ask: a slate or feeder that fired and
 * did NOT deliver must be visible without opening the schedule panel.
 *
 * It is a summary line on the section header, not a new alert metric — the
 * audit explicitly said a line is enough, and the schedule query it reads is
 * the one `channel-detail` already runs under the panel's own key, so it
 * costs no extra request.
 */
function mountWith(schedules: Record<string, unknown>[]) {
	apiFetch.mockImplementation(async (url: string) => {
		if (url === `/api/live-channels/${ID}`) {
			return {
				id: ID,
				name: "eve-outcome",
				status: "RUNNING",
				plan: { planVersion: 1, name: "eve-outcome" },
				stepLog: [],
				streamKey: null,
				encoderIp: null,
				programStartAt: null,
				programEndAt: null,
				lastHeartbeat: null,
				liveToVod: null,
				playbackLinks: [],
				maxRunMinutes: null,
				bitmovinEncodingId: "enc-1",
				bitmovinAccountId: null,
				createdAt: "2026-08-29T00:00:00.000Z",
				updatedAt: "2026-08-29T00:00:00.000Z",
				currentRun: null,
			};
		}
		if (url.includes("/alerts")) {
			return { open: [], history: [] };
		}
		if (url.includes("/schedules")) {
			return schedules;
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
}

const row = (over: Record<string, unknown>) => ({
	id: "s1",
	action: "SLATE_IN",
	fireAt: "2026-08-29T10:00:00.000Z",
	status: "FIRED",
	insertableContentId: "c-1",
	slateDurationSeconds: 30,
	firedAt: "2026-08-29T10:00:00.000Z",
	note: null,
	error: null,
	createdAt: "2026-08-29T00:00:00.000Z",
	...over,
});

describe("ChannelDetail — undelivered schedules reach the section header (ledger #238)", () => {
	it("summarises a FAILED outcome instead of the next armed row", async () => {
		mountWith([
			row({ id: "bad", outcome: "FAILED", outcomeNote: "provider ERROR" }),
			row({ id: "armed", status: "ARMED", fireAt: "2099-01-01T00:00:00.000Z" }),
		]);
		// The failed airing outranks tomorrow's start: that is the operator's
		// next question, and the armed summary would otherwise hide it.
		expect(
			await screen.findByText("1 fired schedule did not deliver"),
		).toBeInTheDocument();
	});

	it("says nothing when every fired row delivered", async () => {
		mountWith([row({ id: "good", outcome: "DELIVERED" })]);
		// The channel name proves the tree rendered before this negative.
		expect(await screen.findByText("eve-outcome")).toBeInTheDocument();
		expect(
			screen.queryByText(/fired schedules? did not deliver/),
		).not.toBeInTheDocument();
	});

	it("counts each undelivered row — the plural arm", async () => {
		mountWith([
			row({ id: "bad-1", outcome: "FAILED" }),
			row({ id: "bad-2", action: "FEEDER_START", outcome: "FAILED" }),
			row({ id: "amber", outcome: "UNKNOWN" }),
		]);
		// UNKNOWN is amber in the panel but is NOT counted here: this line is
		// about airings that provably did not happen, and folding "we could not
		// confirm" into it would make the header cry wolf on every stall.
		expect(
			await screen.findByText("2 fired schedules did not deliver"),
		).toBeInTheDocument();
	});

	it("a MISSED switch refused as 'not staged' is NOT a fired schedule that did not deliver (rev367 S-6)", async () => {
		//  writes outcome FAILED on a MISSED row (the switch never
		// fired — its session was not READY). The header's sentence says
		// "fired", so its filter must require FIRED, or every refused switch
		// would masquerade as an airing that fired and then failed.
		mountWith([
			row({
				id: "refused",
				action: "FEEDER_SWITCH",
				status: "MISSED",
				firedAt: null,
				outcome: "FAILED",
				outcomeNote:
					"not staged — the staged session has not finished downloading and probing its source",
				note: "not staged — the staged session has not finished downloading and probing its source",
			}),
		]);
		expect(await screen.findByText("eve-outcome")).toBeInTheDocument();
		expect(
			screen.queryByText(/fired schedules? did not deliver/),
		).not.toBeInTheDocument();
	});
});
