import { fireEvent, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { renderWithQuery } from "@/test/render";
import { RunsPanel } from "./runs-panel";

const apiFetch = vi.fn();
vi.mock("@/lib/api", () => ({
	apiFetch: (...args: unknown[]) => apiFetch(...args),
}));
it("does not claim the channel never ran when history fails and offers recovery", async () => {
	apiFetch.mockRejectedValue(new Error("offline"));
	renderWithQuery(<RunsPanel channelId="channel" />);
	await screen.findByRole("alert", {}, { timeout: 1000 });
	expect(screen.queryByText(/never been started/i)).toBeNull();
	apiFetch.mockResolvedValue({ runs: [] });
	fireEvent.click(screen.getByRole("button", { name: "Retry" }));
	expect(await screen.findByText(/never been started/i)).toBeInTheDocument();
});
