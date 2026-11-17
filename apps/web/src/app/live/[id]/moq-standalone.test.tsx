import { screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithQuery } from "@/test/render";
import { MoqStandalone } from "./moq-standalone";

const mocks = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("@/lib/api", () => ({ apiFetch: mocks.api }));
vi.mock("./moq-player-preview", () => ({
	MoqPlayerPreview: (props: { runId: string; active: boolean }) => (
		<div data-testid="shared-moq" data-active={String(props.active)}>
			{props.runId}
		</div>
	),
}));
const CHANNEL = "00000000-0000-4000-8000-000000000001";
const RUN = "00000000-0000-4000-8000-000000000002";
beforeEach(() => vi.resetAllMocks());
describe("standalone shared MoQ player", () => {
	it("reuses the player for the exact current run and links back to its Live job", async () => {
		mocks.api.mockResolvedValue({
			status: "RUNNING",
			currentRun: { id: RUN, status: "RUNNING" },
		});
		renderWithQuery(<MoqStandalone channelId={CHANNEL} runId={RUN} />);
		await waitFor(() =>
			expect(screen.getByTestId("shared-moq")).toHaveAttribute(
				"data-active",
				"true",
			),
		);
		expect(
			screen.getByRole("link", { name: "Back to Live channel" }),
		).toHaveAttribute("href", `/live/${CHANNEL}`);
		expect(mocks.api).toHaveBeenCalledWith(`/api/live-channels/${CHANNEL}`);
	});
	it("disables playback when the selected run is no longer current", async () => {
		mocks.api.mockResolvedValue({
			status: "RUNNING",
			currentRun: { id: "other-run", status: "RUNNING" },
		});
		renderWithQuery(<MoqStandalone channelId={CHANNEL} runId={RUN} />);
		expect(await screen.findByTestId("shared-moq")).toHaveAttribute(
			"data-active",
			"false",
		);
	});
	it("shows only a fixed error when run status cannot be read", async () => {
		mocks.api.mockRejectedValue(
			new Error("https://private.example/SYNTHETIC_TOKEN"),
		);
		renderWithQuery(<MoqStandalone channelId={CHANNEL} runId={RUN} />);
		expect(await screen.findByRole("alert")).toHaveTextContent(
			"MoQ playback unavailable",
		);
		expect(document.body.innerHTML).not.toContain("SYNTHETIC_TOKEN");
	});
});
