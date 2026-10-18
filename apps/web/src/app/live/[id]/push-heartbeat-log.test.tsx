import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { renderWithQuery } from "@/test/render";

const apiFetch = vi.fn();
vi.mock("@/lib/api", () => ({
	apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

import { PushHeartbeatLog } from "./push-heartbeat-log";

const props = {
	channelId: "channel",
	runId: "run",
	currentRunId: "run",
	currentRunActive: true,
	currentRunStatus: "RUNNING" as const,
	open: true,
};
it("reads the selected current latest page once per stopping/terminal transition, without a new timer", async () => {
	const view = renderWithQuery(<PushHeartbeatLog {...props} />);
	view.client.setDefaultOptions({
		queries: { retry: false, staleTime: 15_000 },
	});
	await screen.findByText("2026-09-07T00:00:02.123Z");
	for (const [status, seconds] of [
		["STOPPING", 4],
		["STOPPED", 6],
	] as const) {
		apiFetch.mockResolvedValue({
			...page,
			run: { id: "run", status },
			rows: [receipt(status, seconds)],
		});
		view.rerender(
			<PushHeartbeatLog
				{...props}
				currentRunActive={false}
				currentRunStatus={status}
			/>,
		);
		await screen.findByText(`2026-09-07T00:00:0${seconds}.123Z`);
	}
	expect(apiFetch).toHaveBeenCalledTimes(3);
	vi.useFakeTimers();
	await act(async () => {
		await vi.advanceTimersByTimeAsync(6000);
	});
	expect(apiFetch).toHaveBeenCalledTimes(3);
});
it("keeps inspected rows frozen through shutdown and shows the terminal snapshot on close", async () => {
	const view = renderWithQuery(<PushHeartbeatLog {...props} />);
	view.client.setDefaultOptions({
		queries: { retry: false, staleTime: 15_000 },
	});
	const toggle = (
		await screen.findAllByText("Details", { selector: "summary" })
	)[0] as HTMLElement;
	await userEvent.click(toggle);
	await screen.findByText(/Close all details to resume/);
	for (const status of ["STOPPING", "STOPPED"] as const) {
		apiFetch.mockResolvedValue({
			...page,
			run: { id: "run", status },
			rows: [receipt("tail", 6)],
		});
		const count = apiFetch.mock.calls.length;
		view.rerender(
			<PushHeartbeatLog
				{...props}
				currentRunActive={false}
				currentRunStatus={status}
			/>,
		);
		await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(count + 1));
		expect(toggle.closest("details")).toHaveAttribute("open");
		expect(
			screen.queryByText("2026-09-07T00:00:06.123Z"),
		).not.toBeInTheDocument();
	}
	await userEvent.click(toggle);
	expect(
		await screen.findByText("2026-09-07T00:00:06.123Z"),
	).toBeInTheDocument();
	expect(
		screen.queryByText(/Close all details to resume/),
	).not.toBeInTheDocument();
});
it.each([
	"history",
	"older",
])("does not replace or refetch the selected %s page on current-run shutdown", async (mode) => {
	const selected = { ...props, runId: mode === "history" ? "old-run" : "run" };
	const view = renderWithQuery(<PushHeartbeatLog {...selected} />);
	await screen.findByText("2026-09-07T00:00:02.123Z");
	if (mode === "older") {
		await userEvent.click(
			screen.getByRole("button", { name: "Older receipts" }),
		);
		await waitFor(() =>
			expect(apiFetch.mock.calls.at(-1)?.[0]).toContain("cursor=older"),
		);
	}
	const count = apiFetch.mock.calls.length;
	view.rerender(
		<PushHeartbeatLog
			{...selected}
			currentRunActive={false}
			currentRunStatus="STOPPED"
		/>,
	);
	vi.useFakeTimers();
	await act(async () => {
		await vi.advanceTimersByTimeAsync(6000);
	});
	expect(apiFetch).toHaveBeenCalledTimes(count);
	expect(screen.getByText("2026-09-07T00:00:02.123Z")).toBeInTheDocument();
	if (mode === "older")
		expect(
			screen.getByRole("button", { name: "Latest receipts" }),
		).toBeInTheDocument();
});
function receipt(id: string, seconds = 0) {
	return {
		id,
		receivedAt: `2026-09-07T00:00:0${seconds}.123Z`,
		sampledAt: `2026-09-07T00:00:0${seconds}.000Z`,
		value: {
			ingest: {
				status: "CONNECTED",
				streams: [{ mediaType: "VIDEO", incomingBitrate: 500000, rate: 30 }],
			},
			output: { segments: { totalProcessingStatsMs: { mean: 45 } } },
		},
	};
}
const page = {
	run: { id: "run", status: "RUNNING" },
	rows: [receipt("b", 2), receipt("a")],
	nextCursor: "older",
};
beforeEach(() => {
	apiFetch.mockReset().mockResolvedValue(page);
	Object.defineProperty(document, "visibilityState", {
		configurable: true,
		value: "visible",
	});
});
afterEach(() => vi.useRealTimers());
it.each(
	(["en", "ja"] as const).flatMap((locale) =>
		["inactive", "terminal", "history", "older"].map((mode) => ({
			locale,
			mode,
		})),
	),
)("does not promise detail-close refresh for $mode in $locale", async ({
	locale,
	mode,
}) => {
	if (mode === "terminal")
		apiFetch.mockResolvedValue({
			...page,
			run: { id: "run", status: "STOPPED" },
		});
	renderWithQuery(
		<PushHeartbeatLog
			{...props}
			currentRunActive={mode !== "inactive"}
			currentRunId={mode === "history" ? "new-run" : "run"}
		/>,
		locale,
	);
	if (mode === "older")
		await userEvent.click(
			await screen.findByRole("button", {
				name: locale === "en" ? "Older receipts" : "古い受信",
			}),
		);
	const toggle = (
		await screen.findAllByText(locale === "en" ? "Details" : "詳細", {
			selector: "summary",
		})
	)[0] as HTMLElement;
	await userEvent.click(toggle);
	await waitFor(() =>
		expect(toggle.closest("details")).toHaveAttribute("open"),
	);
	expect(
		screen.queryByText(
			locale === "en"
				? /Close all details to resume/
				: /すべての詳細を閉じると再開/,
		),
	).not.toBeInTheDocument();
	expect(
		screen.getByText(
			locale === "en" ? /Automatic refresh paused:/ : /自動更新は停止中です/,
		),
	).toBeInTheDocument();
	await userEvent.click(toggle);
	vi.useFakeTimers();
	const count = apiFetch.mock.calls.length;
	await act(async () => {
		await vi.advanceTimersByTimeAsync(6000);
	});
	expect(apiFetch).toHaveBeenCalledTimes(count);
});
it("renders every receipt and both clocks, numeric safe details, without current-health claims", async () => {
	renderWithQuery(<PushHeartbeatLog {...props} />);
	await screen.findByText("Push heartbeat receipts");
	await waitFor(() => expect(screen.getAllByRole("row")).toHaveLength(3));
	expect(screen.getAllByText("4.00")).toHaveLength(2);
	expect(screen.getByText("2026-09-07T00:00:02.123Z")).toBeInTheDocument();
	expect(screen.getByText("2026-09-07T00:00:02.000Z")).toBeInTheDocument();
	await userEvent.click(
		screen.getAllByText("Details", { selector: "summary" })[0] as HTMLElement,
	);
	expect(
		await screen.findByText(/"incomingBitrate": 500000/),
	).toBeInTheDocument();
	expect(screen.queryByText("Healthy")).not.toBeInTheDocument();
});
it("refreshes open current latest foreground at 2s, retaining receipt ids without duplicates", async () => {
	vi.useFakeTimers();
	renderWithQuery(<PushHeartbeatLog {...props} />);
	await act(async () => {
		await vi.advanceTimersByTimeAsync(10);
	});
	const count = apiFetch.mock.calls.length;
	apiFetch.mockResolvedValue({
		...page,
		rows: [receipt("c", 4), ...page.rows],
	});
	await act(async () => {
		await vi.advanceTimersByTimeAsync(2000);
	});
	expect(apiFetch).toHaveBeenCalledTimes(count + 1);
	expect(screen.getAllByRole("row")).toHaveLength(4);
});
it.each([
	{ open: false },
	{ currentRunId: "new-run" },
	{ currentRunActive: false },
])("does not fast-poll closed/historical/terminal %j", async (patch) => {
	vi.useFakeTimers();
	renderWithQuery(<PushHeartbeatLog {...props} {...patch} />);
	await act(async () => {
		await vi.advanceTimersByTimeAsync(10);
	});
	const count = apiFetch.mock.calls.length;
	await act(async () => {
		await vi.advanceTimersByTimeAsync(6000);
	});
	expect(apiFetch).toHaveBeenCalledTimes(count);
});
it("does not fast-poll in background or on an older page; latest returns to live updates", async () => {
	renderWithQuery(<PushHeartbeatLog {...props} />);
	await userEvent.click(
		await screen.findByRole("button", { name: "Older receipts" }),
	);
	await waitFor(() =>
		expect(apiFetch.mock.calls.at(-1)?.[0]).toContain("cursor=older"),
	);
	vi.useFakeTimers();
	const count = apiFetch.mock.calls.length;
	await act(async () => {
		await vi.advanceTimersByTimeAsync(6000);
	});
	expect(apiFetch).toHaveBeenCalledTimes(count);
	fireEvent.click(screen.getByRole("button", { name: "Latest receipts" }));
	await act(async () => {
		await vi.advanceTimersByTimeAsync(10);
	});
	Object.defineProperty(document, "visibilityState", {
		configurable: true,
		value: "hidden",
	});
	fireEvent(document, new Event("visibilitychange"));
	const background = apiFetch.mock.calls.length;
	await act(async () => {
		await vi.advanceTimersByTimeAsync(6000);
	});
	expect(apiFetch).toHaveBeenCalledTimes(background);
});
it("read failure is not an empty-success message, and retry is explicit", async () => {
	apiFetch.mockRejectedValue(new Error("offline"));
	renderWithQuery(<PushHeartbeatLog {...props} />);
	expect(
		await screen.findByRole("button", { name: "Retry" }),
	).toBeInTheDocument();
	expect(
		screen.queryByText("No verified Push receipts are stored for this run."),
	).not.toBeInTheDocument();
});
it("has Japanese copy", async () => {
	renderWithQuery(<PushHeartbeatLog {...props} />, "ja");
	expect(
		await screen.findByText("Push Heartbeat 受信ログ"),
	).toBeInTheDocument();
	expect(await screen.findByText("アプリ受信時刻")).toBeInTheDocument();
});
it("pauses while inspecting a stable receipt drawer and resumes on close", async () => {
	renderWithQuery(<PushHeartbeatLog {...props} />);
	const toggle = (
		await screen.findAllByText("Details", { selector: "summary" })
	)[0] as HTMLElement;
	await userEvent.click(toggle);
	expect(
		await screen.findByText(/Close all details to resume/),
	).toBeInTheDocument();
	const detail = toggle.closest("details") as HTMLDetailsElement;
	vi.useFakeTimers();
	const count = apiFetch.mock.calls.length;
	await act(async () => {
		await vi.advanceTimersByTimeAsync(6000);
	});
	expect(apiFetch).toHaveBeenCalledTimes(count);
	expect(detail.open).toBe(true);
	detail.open = false;
	fireEvent(detail, new Event("toggle"));
	await act(async () => {
		await vi.advanceTimersByTimeAsync(2000);
	});
	expect(apiFetch).toHaveBeenCalledTimes(count + 1);
});
it("stops fast refresh once its own response says terminal, even before channel refresh", async () => {
	apiFetch.mockResolvedValue({
		...page,
		run: { id: "run", status: "STOPPED" },
	});
	vi.useFakeTimers();
	renderWithQuery(<PushHeartbeatLog {...props} />);
	await act(async () => {
		await vi.advanceTimersByTimeAsync(10);
	});
	const count = apiFetch.mock.calls.length;
	await act(async () => {
		await vi.advanceTimersByTimeAsync(6000);
	});
	expect(apiFetch).toHaveBeenCalledTimes(count);
});
it("an already in-flight response cannot remove an inspected receipt or move its scroll position", async () => {
	const view = renderWithQuery(<PushHeartbeatLog {...props} />);
	const toggle = (
		await screen.findAllByText("Details", { selector: "summary" })
	)[0] as HTMLElement;
	let complete: (value: typeof page) => void = () => {
		throw new Error("pending read missing");
	};
	apiFetch.mockImplementationOnce(
		() =>
			new Promise<typeof page>((resolve) => {
				complete = resolve;
			}),
	);
	act(() => {
		void view.client.refetchQueries({
			queryKey: ["live-run-heartbeat-receipts"],
		});
	});
	await userEvent.click(toggle);
	await screen.findByText(/Close all details to resume/);
	const container = screen.getByRole("table").parentElement as HTMLElement;
	container.scrollTop = 40;
	await act(async () => {
		complete({ ...page, rows: [receipt("replacement", 4)] });
	});
	expect(toggle.closest("details")).toHaveAttribute("open");
	expect(screen.getAllByRole("row")).toHaveLength(3);
	expect(
		screen.queryByText("2026-09-07T00:00:04.123Z"),
	).not.toBeInTheDocument();
	expect(container.scrollTop).toBe(40);
});
it("shows newest received first even when provider sample clocks arrive out of order", async () => {
	apiFetch.mockResolvedValue({
		...page,
		rows: [
			{ ...receipt("b", 2), sampledAt: receipt("a").sampledAt },
			{ ...receipt("a"), sampledAt: receipt("b", 2).sampledAt },
		],
	});
	renderWithQuery(<PushHeartbeatLog {...props} />);
	await waitFor(() => expect(screen.getAllByRole("row")).toHaveLength(3));
	expect(screen.getAllByRole("row")[1]).toHaveAttribute("data-receipt-id", "b");
	expect(screen.getAllByRole("row")[2]).toHaveAttribute("data-receipt-id", "a");
});
it("starts polling when the same run becomes active after a cached provisioning receipt page", async () => {
	apiFetch.mockResolvedValue({
		...page,
		run: { id: "run", status: "PROVISIONING" },
		rows: [],
	});
	vi.useFakeTimers();
	const view = renderWithQuery(
		<PushHeartbeatLog {...props} currentRunActive={false} />,
	);
	await act(async () => {
		await vi.advanceTimersByTimeAsync(10);
	});
	const count = apiFetch.mock.calls.length;
	apiFetch.mockResolvedValue(page);
	view.rerender(<PushHeartbeatLog {...props} currentRunActive />);
	await act(async () => {
		await vi.advanceTimersByTimeAsync(2000);
	});
	expect(apiFetch).toHaveBeenCalledTimes(count + 1);
	await act(async () => {
		await vi.advanceTimersByTimeAsync(10);
	});
	expect(screen.getAllByRole("row")).toHaveLength(3);
});
