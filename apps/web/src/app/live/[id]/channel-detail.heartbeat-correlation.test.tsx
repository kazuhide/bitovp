import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	buildLiveChannelPlan,
	DEFAULT_LIVE_WIZARD_STATE,
} from "@/app/live/new/build-live-plan";
import { renderWithQuery } from "@/test/render";
import type { HeartbeatCorrelation } from "./heartbeat-correlation";

const apiFetch = vi.fn();
vi.mock("@/lib/api", async (original) => ({
	...(await original<Record<string, unknown>>()),
	apiFetch: (...args: unknown[]) => apiFetch(...args),
}));
vi.mock("next/navigation", () => ({
	useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
// No player is started by these disclosure/navigation tests.
vi.mock("@/app/vod/jobs/[id]/player-preview", () => ({
	PlayerPreview: () => null,
	playableLinks: () => [],
}));

import { ChannelDetail } from "./channel-detail";

const CHANNEL = "00000000-0000-4000-8000-0000000000c1";
const CURRENT_RUN = "00000000-0000-4000-8000-0000000000b2";
const HISTORICAL_RUN = "00000000-0000-4000-8000-0000000000a1";
const NOW = Date.now();
const FROM = new Date(NOW - 40_000).toISOString();
const TO = new Date(NOW - 20_000).toISOString();
const REQUESTED = {
	kind: "requested",
	runId: HISTORICAL_RUN,
	from: FROM,
	to: TO,
} as const satisfies HeartbeatCorrelation;
const PLAN = buildLiveChannelPlan({
	...DEFAULT_LIVE_WIZARD_STATE,
	name: "Heartbeat correlation",
	output: {
		...DEFAULT_LIVE_WIZARD_STATE.output,
		credentialId: "11111111-1111-4111-8111-111111111111",
		bucket: "correlation-fixture",
	},
});

function run(id: string, seq: number, status: "RUNNING" | "STOPPED") {
	return {
		id,
		seq,
		status,
		bitmovinEncodingId: "00000000-0000-4000-8000-0000000000e1",
		createdAt: new Date(NOW - 120_000).toISOString(),
		runningSince: new Date(NOW - 110_000).toISOString(),
		endedAt: status === "STOPPED" ? TO : null,
		encoderIp: null,
		streamKey: null,
		outputPrefix: "correlation-fixture/",
		programStartAt: null,
		programEndAt: null,
		error: null,
		lastHeartbeat: null,
		lastHeartbeatAt: null,
		stepLog: [],
		liveToVod: null,
		originObservation: null,
	};
}

const current = run(CURRENT_RUN, 2, "RUNNING");
const historical = run(HISTORICAL_RUN, 1, "STOPPED");

beforeEach(() => {
	vi.clearAllMocks();
	apiFetch.mockImplementation(async (input: string) => {
		if (input === "/api/auth/session")
			return {
				mode: "users",
				configured: true,
				authenticated: true,
				loginKind: "password-form",
				role: "OPERATOR",
			};
		if (input === `/api/live-channels/${CHANNEL}`)
			return {
				id: CHANNEL,
				name: "Current airing B",
				status: "RUNNING",
				labels: [],
				region: "ap-northeast-1",
				protocol: "RTMP",
				bitmovinEncodingId: current.bitmovinEncodingId,
				bitmovinAccountId: "00000000-0000-4000-8000-0000000000d1",
				createdAt: current.createdAt,
				updatedAt: current.createdAt,
				plan: PLAN,
				stepLog: [],
				streamKey: null,
				encoderIp: null,
				programStartAt: null,
				programEndAt: null,
				lastHeartbeat: null,
				liveToVod: null,
				maxRunMinutes: null,
				currentRun: current,
			};
		if (input === `/api/live-channels/${CHANNEL}/runs`)
			return { runs: [current, historical] };
		if (input.endsWith("/alerts")) return { open: [], history: [] };
		if (input.endsWith("/schedules")) return [];
		if (input.includes("/heartbeats?")) {
			const selected = input.includes(HISTORICAL_RUN) ? historical : current;
			return {
				run: { ...selected, summary: null },
				rows: [
					{
						id: "00000000-0000-4000-8000-0000000000f1",
						at: new Date(NOW - 30_000).toISOString(),
						raw: { ingest: { status: "CONNECTED", healthy: true } },
						deltas: {},
					},
				],
				latestEvents: [],
			};
		}
		if (input.includes("/heartbeat-receipts"))
			return {
				run: input.includes(HISTORICAL_RUN) ? historical : current,
				rows: [],
			};
		if (input.includes("/health"))
			return {
				points: [],
				lanes: { ingest: [], encoder: [], output: [] },
				run: current,
				truncated: false,
				outputObservable: true,
				timeline: { window: { startMs: NOW - 120_000 }, events: [] },
			};
		return { items: [] };
	});
});

async function heartbeatCard() {
	await screen.findByRole("heading", { name: "Heartbeat log" });
	const card = document.getElementById("sec-heartbeat-log");
	if (!(card instanceof HTMLDetailsElement))
		throw new Error("Heartbeat log disclosure missing");
	return card;
}

function collapse(card: HTMLDetailsElement) {
	card.open = false;
	fireEvent(card, new Event("toggle", { bubbles: false }));
}

describe("ChannelDetail heartbeat correlation disclosure", () => {
	it("opens the existing log and shows historical A's receiver while current airing B stays mounted", async () => {
		renderWithQuery(
			<ChannelDetail id={CHANNEL} initialHeartbeatCorrelation={REQUESTED} />,
		);
		const card = await heartbeatCard();
		await waitFor(() =>
			expect(
				card.querySelector(
					`[data-heartbeat-correlated-run="${HISTORICAL_RUN}"]`,
				),
			).toBeInTheDocument(),
		);
		expect(card.open).toBe(true);
		expect(within(card).getByRole("combobox")).toHaveValue(HISTORICAL_RUN);
		expect(
			within(card).getByText(`${FROM} – ${TO}`, { exact: false }),
		).toBeVisible();
		expect(document.querySelectorAll("#sec-heartbeat-log")).toHaveLength(1);
		expect(screen.getByText("Current airing B")).toBeVisible();
	});

	it("opens an invalid correlation so its refusal is visible", async () => {
		renderWithQuery(
			<ChannelDetail
				id={CHANNEL}
				initialHeartbeatCorrelation={{ kind: "invalid" }}
			/>,
		);
		const card = await heartbeatCard();
		expect(card.open).toBe(true);
		expect(
			await within(card).findByText(
				"Requested run or UTC window is unavailable.",
			),
		).toBeVisible();
	});

	it.each([
		undefined,
		{ kind: "none" } as const,
	])("keeps the normal no-query disclosure closed for %j", async (initialHeartbeatCorrelation) => {
		renderWithQuery(
			<ChannelDetail
				id={CHANNEL}
				initialHeartbeatCorrelation={initialHeartbeatCorrelation}
			/>,
		);
		expect((await heartbeatCard()).open).toBe(false);
	});

	it("opens a manually collapsed log on same-channel none-to-A navigation without remounting the console", async () => {
		const view = renderWithQuery(<ChannelDetail id={CHANNEL} />);
		const before = await heartbeatCard();
		const ingest = document.getElementById("sec-ingest");
		before.open = true;
		fireEvent(before, new Event("toggle", { bubbles: false }));
		expect(await within(before).findByRole("combobox")).toHaveValue("");
		await waitFor(() =>
			expect(
				apiFetch.mock.calls.some(([url]) =>
					String(url).includes(`/runs/${CURRENT_RUN}/heartbeats?`),
				),
			).toBe(true),
		);
		collapse(before);
		expect(before.open).toBe(false);

		view.rerender(
			<ChannelDetail id={CHANNEL} initialHeartbeatCorrelation={REQUESTED} />,
		);
		const after = await heartbeatCard();
		expect(after.open).toBe(true);
		expect(await within(after).findByRole("combobox")).toHaveValue(
			HISTORICAL_RUN,
		);
		expect(document.getElementById("sec-ingest")).toBe(ingest);
	});

	it("preserves a manual collapse for the same correlation and reopens on a new UTC window", async () => {
		const view = renderWithQuery(
			<ChannelDetail id={CHANNEL} initialHeartbeatCorrelation={REQUESTED} />,
		);
		const before = await heartbeatCard();
		await waitFor(() =>
			expect(
				before.querySelector("[data-heartbeat-correlated-run]"),
			).not.toBeNull(),
		);
		collapse(before);
		view.rerender(
			<ChannelDetail
				id={CHANNEL}
				initialHeartbeatCorrelation={{
					from: FROM,
					to: TO,
					runId: HISTORICAL_RUN,
					kind: "requested",
				}}
			/>,
		);
		expect(await heartbeatCard()).toBe(before);
		expect(before.open).toBe(false);

		view.rerender(
			<ChannelDetail
				id={CHANNEL}
				initialHeartbeatCorrelation={{
					...REQUESTED,
					from: new Date(NOW - 35_000).toISOString(),
				}}
			/>,
		);
		const after = await heartbeatCard();
		expect(after.open).toBe(true);
		expect(await within(after).findByRole("combobox")).toHaveValue(
			HISTORICAL_RUN,
		);
	});
});
