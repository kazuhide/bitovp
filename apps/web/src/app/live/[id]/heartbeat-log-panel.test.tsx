import { summarizeRunHeartbeats } from "@bitovp/core";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionDto } from "@/lib/auth/dto";
import { renderWithQuery } from "@/test/render";

const apiFetch = vi.fn();
vi.mock("@/lib/api", async (orig) => ({
	...(await orig<Record<string, unknown>>()),
	apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

import { HeartbeatLogPanel } from "./heartbeat-log-panel";
import { RunsPanel } from "./runs-panel";

const CHANNEL_ID = "00000000-0000-4000-8000-0000000000c1";
const RUN_ID = "00000000-0000-4000-8000-0000000000c2";
const OLDER_RUN_ID = "00000000-0000-4000-8000-0000000000c0";
const T0 = Date.parse("2026-09-02T07:44:30.000Z");
const KEYFRAME =
	"At least one input video stream key-frame interval is larger than the threshold: 2167 ms >= 2000 ms!";

function session(role: SessionDto["role"] | "single-owner"): SessionDto {
	return role === "single-owner"
		? {
				mode: "password",
				configured: true,
				authenticated: true,
				loginKind: "password-form",
			}
		: {
				mode: "users",
				configured: true,
				authenticated: true,
				loginKind: "password-form",
				role,
			};
}

const connect = {
	time: "2026-09-02T07:45:19.000Z",
	details: { eventType: "FIRST_CONNECT", message: null },
};
const warning = {
	time: "2026-09-02T07:45:21.000Z",
	details: { eventType: "WARNING", message: KEYFRAME },
};

function row(i: number, events: unknown[], status = "CONNECTED") {
	return {
		id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
		at: new Date(T0 + i * 30_000).toISOString(),
		raw: {
			ingest: {
				status,
				healthy: status === "CONNECTED",
				streams: [
					{
						streamId: "0",
						mediaType: "video",
						rate: 30,
						incomingBitrate: 754_499.56,
						keyFrameIntervalAvg: 3956.93,
						keyFrameIntervalMax: 8334,
					},
				],
			},
			output: { segments: { totalProcessingStatsMs: { mean: 3841 } } },
			events,
		},
		deltas: {
			droppedPacketsVideo: 0,
			droppedPacketsAudio: i === 2 ? 2 : 0,
			corruptPacketsVideo: 0,
			corruptPacketsAudio: 0,
		},
	};
}

const PAGE_ONE = {
	run: {
		id: RUN_ID,
		seq: 3,
		status: "STOPPED",
		createdAt: new Date(T0 - 60_000).toISOString(),
		endedAt: new Date(T0 + 3_600_000).toISOString(),
		summary: null,
	},
	rows: [
		row(0, [], "WAITING_FOR_FIRST_CONNECT"),
		row(1, [connect]),
		row(2, [connect, warning]),
	],
	nextCursor: "00000000-0000-4000-8000-000000000002",
	latestEvents: [
		{ time: connect.time, eventType: "FIRST_CONNECT", message: null, key: "a" },
		{ time: warning.time, eventType: "WARNING", message: KEYFRAME, key: "b" },
	],
};
const PAGE_TWO = {
	run: PAGE_ONE.run,
	rows: [row(3, [connect, warning])],
};

function mockApi(role: SessionDto["role"] | "single-owner") {
	apiFetch.mockImplementation(async (url: string) => {
		if (url === "/api/auth/session") {
			return session(role);
		}
		if (url === `/api/live-channels/${CHANNEL_ID}/runs`) {
			return {
				runs: [
					{
						id: RUN_ID,
						seq: 3,
						status: "STOPPED",
						createdAt: PAGE_ONE.run.createdAt,
						endedAt: PAGE_ONE.run.endedAt,
					},
					{
						id: OLDER_RUN_ID,
						seq: 2,
						status: "STOPPED",
						createdAt: new Date(T0 - 86_400_000).toISOString(),
						endedAt: new Date(T0 - 80_000_000).toISOString(),
					},
				],
			};
		}
		if (
			url.startsWith(
				`/api/live-channels/${CHANNEL_ID}/runs/${RUN_ID}/heartbeats?`,
			)
		) {
			return url.includes("cursor=") ? PAGE_TWO : PAGE_ONE;
		}
		if (
			url.startsWith(
				`/api/live-channels/${CHANNEL_ID}/runs/${OLDER_RUN_ID}/heartbeats?`,
			)
		) {
			return {
				run: { ...PAGE_ONE.run, id: OLDER_RUN_ID, seq: 2 },
				rows: [],
				latestEvents: [],
			};
		}
		throw new Error(`unexpected ${url}`);
	});
}

beforeEach(() => {
	vi.clearAllMocks();
});
afterEach(() => vi.useRealTimers());

describe("HeartbeatLogPanel", () => {
	it.each([
		["ja", "定期取得の要約: 17 サンプル", "Push受信は別表示"],
		[
			"en",
			"Poll history summary: 17 samples",
			"Push receipts shown separately",
		],
	] as const)("labels the ended-run summary as Poll-only in %s", async (locale, prefix, separate) => {
		mockApi("OPERATOR");
		const original = apiFetch.getMockImplementation();
		if (!original) throw new Error("fixture missing");
		const rows = Array.from({ length: 17 }, (_, i) => row(i, [connect]));
		const summary = summarizeRunHeartbeats(rows, {
			computedAt: PAGE_ONE.run.endedAt,
		});
		apiFetch.mockImplementation(async (url: string) => {
			if (url.includes("heartbeat-receipts")) {
				return { run: { id: RUN_ID, status: "STOPPED" }, rows: [] };
			}
			if (url.includes(`/runs/${RUN_ID}/heartbeats?`)) {
				return { ...PAGE_ONE, run: { ...PAGE_ONE.run, summary }, rows };
			}
			return original(url);
		});
		renderWithQuery(
			<HeartbeatLogPanel
				channelId={CHANNEL_ID}
				currentRunId={RUN_ID}
				currentRunStatus="STOPPED"
				open
			/>,
			locale,
		);
		const label = await screen.findByText((text) => text.startsWith(prefix));
		expect(label).toHaveTextContent(separate);
	});

	it("passes exact current-run shutdown status to the Push receipt snapshot query", async () => {
		mockApi("OPERATOR");
		const original = apiFetch.getMockImplementation();
		if (!original) throw new Error("fixture missing");
		let status: "RUNNING" | "STOPPING" | "STOPPED" = "RUNNING";
		apiFetch.mockImplementation(async (url: string) =>
			url.includes("heartbeat-receipts")
				? {
						run: { id: RUN_ID, status },
						rows: [
							{
								id: status,
								receivedAt: `receipt-${status}`,
								sampledAt: null,
								value: {},
							},
						],
					}
				: original(url),
		);
		const panel = () => (
			<HeartbeatLogPanel
				open
				channelId={CHANNEL_ID}
				currentRunId={RUN_ID}
				currentRunStatus={status}
				currentRunActive={status === "RUNNING"}
			/>
		);
		const view = renderWithQuery(panel());
		await screen.findByText("receipt-RUNNING");
		for (const next of ["STOPPING", "STOPPED"] as const) {
			status = next;
			view.rerender(panel());
			await screen.findByText(`receipt-${status}`);
		}
		expect(
			apiFetch.mock.calls.filter(([url]) => url.includes("heartbeat-receipts")),
		).toHaveLength(3);
	});
	it.each([
		"STOPPED",
		"ERROR",
	] as const)("refreshes same-run options and history on %s without polling or losing a historical selection", async (terminal) => {
		mockApi("OPERATOR");
		const original = apiFetch.getMockImplementation();
		if (!original) throw new Error("fixture missing");
		let status: "RUNNING" | "STOPPED" | "ERROR" = "RUNNING";
		apiFetch.mockImplementation(async (url: string) => {
			const result = await original(url);
			return url === `/api/live-channels/${CHANNEL_ID}/runs`
				? {
						runs: result.runs.map((run: { id: string }) =>
							run.id === RUN_ID ? { ...run, status } : run,
						),
					}
				: result;
		});
		const panels = () => (
			<>
				<HeartbeatLogPanel
					channelId={CHANNEL_ID}
					currentRunId={RUN_ID}
					currentRunStatus={status}
					currentRunActive={status === "RUNNING"}
				/>
				<div data-testid="run-history">
					<RunsPanel
						channelId={CHANNEL_ID}
						currentRunId={RUN_ID}
						currentRunStatus={status}
					/>
				</div>
			</>
		);
		const view = renderWithQuery(panels());
		view.client.setDefaultOptions({
			queries: { retry: false, staleTime: Infinity },
		});
		await screen.findByRole("option", { name: /RUNNING/ });
		await userEvent.selectOptions(screen.getByRole("combobox"), OLDER_RUN_ID);
		vi.useFakeTimers();
		const count = apiFetch.mock.calls.filter(
			([url]) => url === `/api/live-channels/${CHANNEL_ID}/runs`,
		).length;
		status = terminal;
		view.rerender(panels());
		await act(async () => {
			await vi.advanceTimersByTimeAsync(20);
		});
		expect(
			screen.getByRole("combobox").querySelector(`option[value="${RUN_ID}"]`),
		).toHaveTextContent(terminal);
		expect(
			within(screen.getByTestId("run-history")).queryByText("RUNNING"),
		).not.toBeInTheDocument();
		expect(screen.getByRole("combobox")).toHaveValue(OLDER_RUN_ID);
		expect(
			apiFetch.mock.calls.filter(
				([url]) => url === `/api/live-channels/${CHANNEL_ID}/runs`,
			),
		).toHaveLength(count + 1);
		view.rerender(panels());
		await act(async () => {
			await vi.advanceTimersByTimeAsync(60_000);
		});
		expect(
			apiFetch.mock.calls.filter(
				([url]) => url === `/api/live-channels/${CHANNEL_ID}/runs`,
			),
		).toHaveLength(count + 1);
	});
	it("follows a new current run, but preserves explicit history selection and keeps Push behind OPERATOR", async () => {
		mockApi("OPERATOR");
		const original = apiFetch.getMockImplementation();
		if (!original) throw new Error("fixture implementation missing");
		apiFetch.mockImplementation(async (url: string) =>
			url.includes("heartbeat-receipts")
				? {
						run: {
							id: url.includes(OLDER_RUN_ID) ? OLDER_RUN_ID : RUN_ID,
							status: "RUNNING",
						},
						rows: [],
					}
				: original(url),
		);
		const view = renderWithQuery(
			<HeartbeatLogPanel
				channelId={CHANNEL_ID}
				currentRunId={RUN_ID}
				open
				currentRunActive
			/>,
		);
		await screen.findByText(
			"No verified Push receipts are stored for this run.",
		);
		view.rerender(
			<HeartbeatLogPanel
				channelId={CHANNEL_ID}
				currentRunId={OLDER_RUN_ID}
				open
				currentRunActive
			/>,
		);
		await waitFor(() =>
			expect(
				apiFetch.mock.calls.some((call) =>
					String(call[0]).includes(`/runs/${OLDER_RUN_ID}/heartbeat-receipts`),
				),
			).toBe(true),
		);
		await waitFor(() =>
			expect(
				screen
					.getByRole("combobox")
					.querySelector(`option[value="${OLDER_RUN_ID}"]`),
			).not.toBeNull(),
		);
		await userEvent.selectOptions(screen.getByRole("combobox"), OLDER_RUN_ID);
		apiFetch.mockClear();
		view.rerender(
			<HeartbeatLogPanel
				channelId={CHANNEL_ID}
				currentRunId={RUN_ID}
				open
				currentRunActive
			/>,
		);
		expect(screen.getByRole("combobox")).toHaveValue(OLDER_RUN_ID);
		expect(
			apiFetch.mock.calls.some((call) =>
				String(call[0]).includes(`/runs/${RUN_ID}/heartbeat-receipts`),
			),
		).toBe(false);
		view.unmount();
		apiFetch.mockClear();
		mockApi("VIEWER");
		renderWithQuery(
			<HeartbeatLogPanel
				channelId={CHANNEL_ID}
				currentRunId={RUN_ID}
				open
				currentRunActive
			/>,
		);
		await screen.findByText("The heartbeat log is available to operators.");
		expect(
			apiFetch.mock.calls.some((call) =>
				String(call[0]).includes("heartbeat-receipts"),
			),
		).toBe(false);
	});
	it("renders the run's rows (time, input, Mbps, fps, keyframe avg/max, deltas, segment mean), each row's NEW events, and the persistent event list", async () => {
		mockApi("OPERATOR");
		renderWithQuery(
			<HeartbeatLogPanel channelId={CHANNEL_ID} currentRunId={RUN_ID} />,
		);
		const rows = await screen.findAllByRole("row");
		// header + 3 data rows
		expect(rows).toHaveLength(4);
		const first = rows[1] as HTMLElement;
		expect(
			within(first).getByText("WAITING_FOR_FIRST_CONNECT"),
		).toBeInTheDocument();
		const third = rows[3] as HTMLElement;
		expect(within(third).getByText("CONNECTED")).toBeInTheDocument();
		expect(within(third).getByText("6.04")).toBeInTheDocument();
		expect(within(third).getByText("30")).toBeInTheDocument();
		expect(within(third).getByText("3957 / 8334")).toBeInTheDocument();
		expect(within(third).getByText("3841")).toBeInTheDocument();
		expect(within(third).getByText("0/+2/0/0")).toBeInTheDocument();
		// Row 2 gained FIRST_CONNECT, row 3 gained the WARNING — and ONLY those.
		expect(
			within(rows[2] as HTMLElement).getByText("FIRST_CONNECT"),
		).toBeInTheDocument();
		expect(within(third).getByText("WARNING")).toBeInTheDocument();
		expect(within(third).queryByText("FIRST_CONNECT")).not.toBeInTheDocument();
		// The persistent event list carries the message verbatim.
		expect(screen.getByText(KEYFRAME)).toBeInTheDocument();
		// The paged request carried the page size and no cursor.
		expect(apiFetch).toHaveBeenCalledWith(
			`/api/live-channels/${CHANNEL_ID}/runs/${RUN_ID}/heartbeats?limit=200`,
		);
	});

	it("the raw drawer shows the persisted sample — provider fields the table does not know included", async () => {
		mockApi("OPERATOR");
		renderWithQuery(
			<HeartbeatLogPanel channelId={CHANNEL_ID} currentRunId={RUN_ID} />,
		);
		const toggles = await screen.findAllByText("JSON");
		await userEvent.click(toggles[2] as HTMLElement);
		expect(
			await screen.findByText(/"totalProcessingStatsMs"/),
		).toBeInTheDocument();
		expect(screen.getByText(/"keyFrameIntervalMax": 8334/)).toBeInTheDocument();
		// Display conversion must not rewrite the stored provider sample.
		expect(
			screen.getByText(/"incomingBitrate": 754499.56/),
		).toBeInTheDocument();
	});

	it("Load more requests the next page by cursor and appends its rows", async () => {
		mockApi("OPERATOR");
		renderWithQuery(
			<HeartbeatLogPanel channelId={CHANNEL_ID} currentRunId={RUN_ID} />,
		);
		await userEvent.click(
			await screen.findByRole("button", { name: "Load more" }),
		);
		await waitFor(() => expect(screen.getAllByRole("row")).toHaveLength(5));
		expect(apiFetch).toHaveBeenCalledWith(
			`/api/live-channels/${CHANNEL_ID}/runs/${RUN_ID}/heartbeats?limit=200&cursor=${PAGE_ONE.nextCursor}`,
		);
		expect(
			screen.queryByRole("button", { name: "Load more" }),
		).not.toBeInTheDocument();
		expect(screen.getByText("4 rows loaded")).toBeInTheDocument();
	});

	it("switching the run selector loads that run's log", async () => {
		mockApi("OPERATOR");
		renderWithQuery(
			<HeartbeatLogPanel channelId={CHANNEL_ID} currentRunId={RUN_ID} />,
		);
		await screen.findAllByRole("row");
		await userEvent.selectOptions(screen.getByRole("combobox"), OLDER_RUN_ID);
		expect(
			await screen.findByText("No heartbeat samples are kept for this run."),
		).toBeInTheDocument();
	});

	it("a VIEWER is told the log is operator-only and no log request is made", async () => {
		mockApi("VIEWER");
		renderWithQuery(
			<HeartbeatLogPanel channelId={CHANNEL_ID} currentRunId={RUN_ID} />,
		);
		expect(
			await screen.findByText("The heartbeat log is available to operators."),
		).toBeInTheDocument();
		expect(
			apiFetch.mock.calls.some((call) =>
				String(call[0]).includes("/heartbeats"),
			),
		).toBe(false);
	});

	it("the export link is ADMIN-only and points at the export route", async () => {
		mockApi("OPERATOR");
		const operator = renderWithQuery(
			<HeartbeatLogPanel channelId={CHANNEL_ID} currentRunId={RUN_ID} />,
		);
		await screen.findAllByRole("row");
		expect(
			screen.queryByRole("link", { name: /Export JSON/ }),
		).not.toBeInTheDocument();
		operator.unmount();
		mockApi("ADMIN");
		renderWithQuery(
			<HeartbeatLogPanel channelId={CHANNEL_ID} currentRunId={RUN_ID} />,
		);
		const link = await screen.findByRole("link", {
			name: "Export JSON (admin)",
		});
		expect(link).toHaveAttribute(
			"href",
			`/api/live-channels/${CHANNEL_ID}/runs/${RUN_ID}/heartbeats/export`,
		);
		expect(link).toHaveAttribute("download");
	});

	it("renders in Japanese", async () => {
		mockApi("ADMIN");
		renderWithQuery(
			<HeartbeatLogPanel channelId={CHANNEL_ID} currentRunId={RUN_ID} />,
			"ja",
		);
		expect(await screen.findByText("受信 Mbps")).toBeInTheDocument();
		expect(screen.getByText("JSON をエクスポート(管理者)")).toBeInTheDocument();
		expect(screen.getByText("3 行を読み込み済み")).toBeInTheDocument();
		for (const english of ["Load more", "rows loaded", "Export JSON"]) {
			expect(
				screen.queryByText(new RegExp(english)),
				english,
			).not.toBeInTheDocument();
		}
	});
});
