import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { renderWithQuery } from "@/test/render";

const apiFetch = vi.fn();
vi.mock("@/lib/api", async (original) => ({
	...(await original<Record<string, unknown>>()),
	apiFetch: (...args: unknown[]) => apiFetch(...args),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

import { CaptureVmafPanel } from "./capture-vmaf-panel";

afterEach(() => vi.resetAllMocks());

it("does not claim no feeder while the session query is still loading", () => {
	apiFetch.mockReturnValue(new Promise(() => {}));
	renderWithQuery(
		<CaptureVmafPanel channelId="channel" channelStatus="RUNNING" />,
	);
	expect(
		screen.queryByText(/No attached pseudo-live feeder/),
	).not.toBeInTheDocument();
	expect(screen.getByRole("status")).toHaveTextContent("Loading");
	expect(screen.getByRole("button", { name: "Capture VMAF" })).toBeDisabled();
});
it("offers session-query retry instead of falsely saying no feeder", async () => {
	apiFetch.mockRejectedValue(new Error("offline"));
	renderWithQuery(
		<CaptureVmafPanel channelId="channel" channelStatus="RUNNING" />,
	);
	await screen.findByText("Failed to load feeder sessions.");
	expect(
		screen.queryByText(/No attached pseudo-live feeder/),
	).not.toBeInTheDocument();
	expect(screen.getByRole("button", { name: "Capture VMAF" })).toBeDisabled();
	apiFetch.mockResolvedValue({ items: [{ id: "session", status: "PUSHING" }] });
	await userEvent.click(screen.getByRole("button", { name: "Retry" }));
	await waitFor(() =>
		expect(screen.getByRole("button", { name: "Capture VMAF" })).toBeEnabled(),
	);
});
it.each([
	"",
	"9",
	"601",
	"10.5",
])("refuses invalid capture duration %s without a POST", async (duration) => {
	apiFetch.mockResolvedValue({ items: [{ id: "session", status: "PUSHING" }] });
	renderWithQuery(
		<CaptureVmafPanel channelId="channel" channelStatus="RUNNING" />,
	);
	await waitFor(() =>
		expect(screen.getByRole("button", { name: "Capture VMAF" })).toBeEnabled(),
	);
	const user = userEvent.setup();
	const input = screen.getByLabelText("Capture window (s)");
	await user.clear(input);
	if (duration) await user.type(input, duration);
	expect(input).toHaveValue(duration ? Number(duration) : null);
	expect(screen.getByRole("button", { name: "Capture VMAF" })).toBeDisabled();
	expect(
		apiFetch.mock.calls.some(([, options]) => options?.method === "POST"),
	).toBe(false);
});
it.each([
	"10",
	"600",
])("accepts boundary duration %s without submitting automatically", async (duration) => {
	apiFetch.mockResolvedValue({ items: [{ id: "session", status: "PUSHING" }] });
	renderWithQuery(
		<CaptureVmafPanel channelId="channel" channelStatus="RUNNING" />,
	);
	await waitFor(() =>
		expect(screen.getByRole("button", { name: "Capture VMAF" })).toBeEnabled(),
	);
	const user = userEvent.setup();
	const input = screen.getByLabelText("Capture window (s)");
	await user.clear(input);
	await user.type(input, duration);
	expect(screen.getByRole("button", { name: "Capture VMAF" })).toBeEnabled();
	expect(
		apiFetch.mock.calls.some(([, options]) => options?.method === "POST"),
	).toBe(false);
});
it("blocks capture when a cached feeder list fails to refresh", async () => {
	apiFetch.mockResolvedValue({ items: [{ id: "session", status: "PUSHING" }] });
	const { client } = renderWithQuery(
		<CaptureVmafPanel channelId="channel" channelStatus="RUNNING" />,
	);
	await waitFor(() =>
		expect(screen.getByRole("button", { name: "Capture VMAF" })).toBeEnabled(),
	);
	apiFetch.mockRejectedValue(new Error("offline"));
	await client.invalidateQueries({ queryKey: ["feeder-sessions", "channel"] });
	await screen.findByText("Failed to load feeder sessions.");
	expect(screen.getByRole("button", { name: "Capture VMAF" })).toBeDisabled();
	expect(
		screen.queryByText(/No attached pseudo-live feeder/),
	).not.toBeInTheDocument();
});
