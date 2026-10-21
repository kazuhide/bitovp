import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithQuery } from "@/test/render";
import { ProviderDiagnosticsPanel } from "./provider-diagnostics-panel";

const apiFetch = vi.fn();
vi.mock("@/lib/api", () => ({
	apiFetch: (...args: unknown[]) => apiFetch(...args),
}));
const inputId = "00000000-0000-4000-8000-000000000001";
let role = "ADMIN";
let fail = false;
function response(kind = "summary", data: unknown = { status: "RUNNING" }) {
	return {
		kind,
		runId: "run-a",
		encodingId: "encoding-a",
		fetchedAt: "2026-10-01T10:00:00Z",
		data,
	};
}
function panel(runId = "run-a", status = "STOPPED", open = true) {
	return (
		<ProviderDiagnosticsPanel
			channelId="channel"
			runId={runId}
			status={status}
			open={open}
		/>
	);
}
async function expand() {
	await userEvent.click(await screen.findByText("Provider diagnostics"));
}
beforeEach(() => {
	role = "ADMIN";
	fail = false;
	apiFetch.mockReset();
	apiFetch.mockImplementation(async (url: string) => {
		if (url === "/api/auth/session")
			return {
				mode: "users",
				authenticated: true,
				configured: true,
				role,
				loginKind: "password-form",
			};
		if (fail) throw new Error("provider unavailable");
		if (url.endsWith("final-heartbeat"))
			return response("final-heartbeat", {
				url: "https://example.com/final.json",
			});
		if (url.includes("kind=events"))
			return {
				...response("events", [
					{
						time: "2026-10-01T10:00:00Z",
						details: { eventType: "WARNING", source: "INGEST" },
					},
				]),
				offset: 0,
				limit: 25,
				totalCount: 26,
				nextOffset: url.includes("offset=25") ? undefined : 25,
			};
		if (url.includes("kind=streams"))
			return response("streams", [
				{
					time: "2026-10-01T10:00:00Z",
					streamInfos: [
						{
							id: "video",
							mediaType: "video",
							codec: "H264",
							width: 1920,
							height: 1080,
							rate: 30,
							bytesReadPerSecondAvg: 1000000,
						},
					],
				},
			]);
		if (url.includes("kind=srt"))
			return response("srt", [
				{ srtInputId: inputId, recv: { mbitRate: 8, packetsLost: 2 } },
			]);
		if (url.includes("kind=hd-start"))
			return response("hd-start", {
				manifestGenerator: "V2",
				liveEncodingMode: "STANDARD",
				hlsManifests: [{ manifestId: inputId }],
			});
		return response();
	});
});
afterEach(() => vi.useRealTimers());
describe("ProviderDiagnosticsPanel", () => {
	it("fetches HD start settings on selection without list paging controls", async () => {
		renderWithQuery(panel());
		await expand();
		await userEvent.selectOptions(
			screen.getByRole("combobox", { name: "View" }),
			"hd-start",
		);
		await screen.findByText(/V2 · STANDARD · HLS 1/);
		expect(
			apiFetch.mock.calls.some(([url]) =>
				String(url).includes("kind=hd-start"),
			),
		).toBe(true);
		expect(
			screen.queryByRole("button", { name: "Next" }),
		).not.toBeInTheDocument();
	});
	it("loads on expansion only, preserves data on explicit refresh failure, and does not poll", async () => {
		renderWithQuery(panel());
		await screen.findByText("Provider diagnostics");
		expect(
			apiFetch.mock.calls.filter(([url]) => url.includes("diagnostics")),
		).toHaveLength(0);
		await expand();
		await screen.findByText(/: RUNNING/);
		expect(
			apiFetch.mock.calls.filter(([url]) => url.includes("diagnostics")),
		).toHaveLength(1);
		vi.useFakeTimers();
		await act(async () => {
			await vi.advanceTimersByTimeAsync(60_000);
		});
		expect(
			apiFetch.mock.calls.filter(([url]) => url.includes("diagnostics")),
		).toHaveLength(1);
		vi.useRealTimers();
		fail = true;
		await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
		await screen.findByRole("alert");
		expect(screen.getByText(/: RUNNING/)).toBeInTheDocument();
	});
	it("never requests diagnostics for VIEWER or a closed outer diagnostic area", async () => {
		role = "VIEWER";
		const view = renderWithQuery(panel());
		await waitFor(() => expect(apiFetch).toHaveBeenCalled());
		expect(screen.queryByText("Provider diagnostics")).not.toBeInTheDocument();
		expect(
			apiFetch.mock.calls.some(([url]) => url.includes("diagnostics")),
		).toBe(false);
		view.unmount();
		role = "ADMIN";
		renderWithQuery(panel("run-a", "STOPPED", false));
		await expand();
		expect(
			apiFetch.mock.calls.some(([url]) => url.includes("diagnostics")),
		).toBe(false);
	});
	it("pages events, clears other-kind results, and renders stream units", async () => {
		renderWithQuery(panel());
		await expand();
		await screen.findByText(/: RUNNING/);
		await userEvent.selectOptions(screen.getByLabelText("View"), "events");
		await screen.findByText("INGEST");
		expect(screen.queryByText(/: RUNNING/)).not.toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "Next" }));
		await waitFor(() =>
			expect(
				apiFetch.mock.calls.some(([url]) => url.includes("offset=25")),
			).toBe(true),
		);
		await userEvent.selectOptions(screen.getByLabelText("View"), "streams");
		await screen.findByText(/8.00 Mbps/);
		expect(screen.getByText(/1920 × 1080/)).toBeInTheDocument();
	});
	it("discovers SRT input ids and validates manual filters before requesting", async () => {
		renderWithQuery(panel());
		await expand();
		await screen.findByText(/: RUNNING/);
		await userEvent.selectOptions(screen.getByLabelText("View"), "srt");
		await screen.findByText(/8.00 Mbps/);
		expect(screen.getByRole("option", { name: inputId })).toBeInTheDocument();
		await userEvent.type(screen.getByLabelText("Input ID"), "invalid");
		await userEvent.click(screen.getByRole("button", { name: "Apply" }));
		await screen.findByText("Enter a valid SRT input UUID.");
		expect(
			apiFetch.mock.calls.some(([url]) => url.includes("srtInputId=invalid")),
		).toBe(false);
		await userEvent.clear(screen.getByLabelText("Input ID"));
		await userEvent.type(screen.getByLabelText("Input ID"), inputId);
		await userEvent.click(screen.getByRole("button", { name: "Apply" }));
		await waitFor(() =>
			expect(
				apiFetch.mock.calls.some(([url]) =>
					url.includes(`srtInputId=${inputId}`),
				),
			).toBe(true),
		);
	});
	it("requests the final URL only on ADMIN action and clears it across runs", async () => {
		const view = renderWithQuery(panel());
		await expand();
		await screen.findByText(/: RUNNING/);
		expect(
			apiFetch.mock.calls.some(([url]) => url.endsWith("final-heartbeat")),
		).toBe(false);
		await userEvent.click(
			screen.getByRole("button", { name: "Get final heartbeat" }),
		);
		expect(
			await screen.findByRole("link", { name: "Download final heartbeat" }),
		).toHaveAttribute("href", "https://example.com/final.json");
		view.rerender(panel("run-a", "RUNNING"));
		expect(
			screen.queryByRole("link", { name: "Download final heartbeat" }),
		).not.toBeInTheDocument();
		view.rerender(panel("run-a", "STOPPED"));
		expect(
			screen.queryByRole("link", { name: "Download final heartbeat" }),
		).not.toBeInTheDocument();
		view.rerender(panel("run-b", "RUNNING"));
		expect(
			screen.queryByRole("link", { name: "Download final heartbeat" }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Get final heartbeat" }),
		).not.toBeInTheDocument();
	});
	it("hides final export from OPERATOR and translates the compact controls", async () => {
		role = "OPERATOR";
		renderWithQuery(panel(), "ja");
		await userEvent.click(await screen.findByText("エンコーダの診断"));
		await screen.findByText(/: RUNNING/);
		expect(screen.getByRole("button", { name: "更新" })).toBeInTheDocument();
		expect(screen.queryByText("最終Heartbeatを取得")).not.toBeInTheDocument();
	});
});
