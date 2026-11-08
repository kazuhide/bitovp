import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AisaResultSnapshot } from "@/lib/aisa-live/contracts";
import { renderWithQuery } from "@/test/render";

const mocks = vi.hoisted(() => ({
	read: vi.fn(),
	org: "00000000-0000-4000-8000-000000000001",
}));
vi.mock("@/lib/aisa-live/recording-timeline", () => ({
	readAisaRecordingTimeline: mocks.read,
}));
vi.mock("@/lib/auth/use-session", () => ({
	useSession: () => ({
		status: "success",
		data: {
			configured: true,
			authenticated: true,
			mode: "users",
			organizationId: mocks.org,
		},
	}),
}));
vi.mock("./aisa-live-player-thumbnail", () => ({
	requestAisaThumbnail: vi.fn().mockResolvedValue(null),
}));
vi.mock("./aisa-live-player", () => ({
	AisaMomentPreview: ({
		moment,
		playRequest,
	}: {
		moment: { id: string };
		playRequest?: { token: number };
	}) => (
		<div
			data-testid="selected-player"
			data-moment-id={moment.id}
			data-play-request={playRequest?.token}
		/>
	),
}));

import { AisaMomentTimeline } from "./aisa-live-timeline";

const origin = 1790000000000;
const snapshot: AisaResultSnapshot = {
	analysisId: "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb",
	encodingId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
	sequence: 1,
	producedAt: "2026-11-08T00:00:00Z",
	mediaTimeOriginUnixMs: origin,
	isFinal: true,
	analyzedStartTimeSeconds: 0,
	analyzedEndTimeSeconds: 100,
	metadata: { version: "synthetic", disclaimer: "Synthetic" },
	sourceGaps: [],
	observations: [
		{
			id: "outside-text",
			text: "Early goal",
			startTimeSeconds: 10,
			endTimeSeconds: 15,
		},
		{
			id: "goal-text",
			text: "Goal in the recording",
			startTimeSeconds: 60,
			endTimeSeconds: 70,
		},
		{
			id: "near-text",
			text: "Nearby replay",
			startTimeSeconds: 65,
			endTimeSeconds: 75,
		},
	],
	keyMoments: [
		{
			id: "outside",
			lastUpdatedSequence: 1,
			importanceLevel: 2,
			startInSeconds: 10,
			endInSeconds: 15,
			anchorInSeconds: 12,
			observations: ["outside-text"],
			categories: ["sport/soccer"],
		},
		{
			id: "goal",
			lastUpdatedSequence: 1,
			importanceLevel: 1,
			startInSeconds: 60,
			endInSeconds: 70,
			anchorInSeconds: 62,
			observations: ["goal-text"],
			categories: ["sport/soccer"],
		},
		{
			id: "near",
			lastUpdatedSequence: 1,
			importanceLevel: 3,
			startInSeconds: 65,
			endInSeconds: 75,
			anchorInSeconds: 67,
			observations: ["near-text"],
			categories: ["sport/soccer"],
		},
	],
};
const props = {
	accountId: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
	analysisId: snapshot.analysisId,
	encodingId: snapshot.encodingId,
	snapshot,
	language: "original" as const,
};
const marker = (id: string) => {
	const node = document.querySelector<HTMLButtonElement>(
		`button[data-aisa-timeline-moment="${id}"]`,
	);
	if (!node) throw new Error(`Marker ${id} is absent`);
	return node;
};

beforeEach(() => {
	mocks.org = "00000000-0000-4000-8000-000000000001";
	mocks.read.mockReset().mockResolvedValue({
		endList: true,
		fragments: [{ start: 0, duration: 30, programDateTime: origin + 50000 }],
	});
});
afterEach(() => {
	cleanup();
	vi.useRealTimers();
});

describe("key moment timeline", () => {
	it("rejects a snapshot from another encoding before reading the recording", () => {
		renderWithQuery(
			<AisaMomentTimeline
				{...props}
				encodingId="dddddddd-dddd-4ddd-8ddd-dddddddddddd"
			/>,
		);
		expect(screen.getByRole("alert")).toBeVisible();
		expect(mocks.read).not.toHaveBeenCalled();
		expect(
			document.querySelectorAll("[data-aisa-timeline-moment]"),
		).toHaveLength(0);
	});

	it("retains every marker and labels full recording coverage before allowing playback", async () => {
		renderWithQuery(<AisaMomentTimeline {...props} />);
		await waitFor(() =>
			expect(marker("goal")).toHaveAttribute("data-playable", "true"),
		);
		expect(
			document.querySelectorAll("[data-aisa-timeline-moment]"),
		).toHaveLength(3);
		expect(marker("outside")).toHaveAttribute("data-playable", "false");
		expect(marker("outside")).toHaveAccessibleName(/Importance 2/);
		expect(screen.queryByTestId("selected-player")).toBeNull();
	});

	it("shows content and importance on focus; outside selection never starts another scene", async () => {
		const user = userEvent.setup();
		renderWithQuery(<AisaMomentTimeline {...props} />);
		await waitFor(() =>
			expect(marker("outside")).toHaveAttribute("data-playable", "false"),
		);
		act(() => marker("outside").focus());
		expect(await screen.findByRole("tooltip")).toHaveTextContent("Early goal");
		expect(screen.getByRole("tooltip")).toHaveTextContent("Importance 2");
		await user.click(marker("outside"));
		const selected = screen.getByRole("region", {
			name: "Selected key moment",
		});
		expect(within(selected).getByText("Early goal")).toBeVisible();
		expect(within(selected).getByText("Outside recording")).toBeVisible();
		expect(screen.queryByTestId("selected-player")).toBeNull();
	});

	it("plays the clicked covered marker and clears it when a later snapshot removes it", async () => {
		const user = userEvent.setup();
		const rendered = renderWithQuery(<AisaMomentTimeline {...props} />);
		await waitFor(() =>
			expect(marker("goal")).toHaveAttribute("data-playable", "true"),
		);
		await user.click(marker("goal"));
		expect(screen.getByTestId("selected-player")).toHaveAttribute(
			"data-moment-id",
			"goal",
		);
		expect(screen.getByTestId("selected-player")).toHaveAttribute(
			"data-play-request",
		);
		rendered.rerender(
			<AisaMomentTimeline
				{...props}
				snapshot={{
					...snapshot,
					sequence: 2,
					keyMoments: snapshot.keyMoments.filter((item) => item.id !== "goal"),
				}}
			/>,
		);
		expect(screen.queryByTestId("selected-player")).toBeNull();
		expect(
			document.querySelectorAll("[data-aisa-timeline-moment]"),
		).toHaveLength(2);
	});

	it("supports arrow and edge-key navigation without starting playback on focus", async () => {
		const user = userEvent.setup();
		renderWithQuery(<AisaMomentTimeline {...props} />);
		act(() => marker("outside").focus());
		await user.keyboard("{ArrowRight}");
		expect(marker("goal")).toHaveFocus();
		await user.keyboard("{End}");
		expect(marker("near")).toHaveFocus();
		await user.keyboard("{Home}");
		expect(marker("outside")).toHaveFocus();
		expect(screen.queryByTestId("selected-player")).toBeNull();
	});

	it("treats a failed recording read as unknown, keeping descriptions without starting playback", async () => {
		mocks.read.mockRejectedValue(new Error("Synthetic failed playlist read"));
		const user = userEvent.setup();
		renderWithQuery(<AisaMomentTimeline {...props} />);
		await screen.findByText("Recording range unavailable");
		expect(marker("goal")).toHaveAttribute("data-playable", "unknown");
		await user.click(marker("goal"));
		expect(screen.queryByTestId("selected-player")).toBeNull();
		expect(
			within(
				screen.getByRole("region", { name: "Selected key moment" }),
			).getByText("Goal in the recording"),
		).toBeVisible();
	});

	it("recovers a failed final recording read without autoplaying the earlier unknown selection", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		mocks.read.mockRejectedValueOnce(new Error("Synthetic temporary failure"));
		const user = userEvent.setup();
		renderWithQuery(<AisaMomentTimeline {...props} />);
		await screen.findByText("Recording range unavailable");
		await user.click(marker("goal"));
		expect(screen.queryByTestId("selected-player")).toBeNull();
		await act(async () => {
			await vi.advanceTimersByTimeAsync(10_000);
		});
		expect(mocks.read).toHaveBeenCalledTimes(2);
		await waitFor(() =>
			expect(marker("goal")).toHaveAttribute("data-playable", "true"),
		);
		expect(screen.getByTestId("selected-player")).not.toHaveAttribute(
			"data-play-request",
		);
		await user.click(marker("goal"));
		expect(screen.getByTestId("selected-player")).toHaveAttribute(
			"data-play-request",
		);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(30_000);
		});
		expect(mocks.read).toHaveBeenCalledTimes(2);
	});

	it("refreshes an unfinished recording after the analysis is final and stops at ENDLIST", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		mocks.read.mockResolvedValueOnce({
			endList: false,
			fragments: [{ start: 0, duration: 10, programDateTime: origin + 50000 }],
		});
		renderWithQuery(<AisaMomentTimeline {...props} />);
		await waitFor(() =>
			expect(marker("goal")).toHaveAttribute("data-playable", "false"),
		);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(10_000);
		});
		expect(mocks.read).toHaveBeenCalledTimes(2);
		await waitFor(() =>
			expect(marker("goal")).toHaveAttribute("data-playable", "true"),
		);
		expect(screen.queryByTestId("selected-player")).toBeNull();
		await act(async () => {
			await vi.advanceTimersByTimeAsync(30_000);
		});
		expect(mocks.read).toHaveBeenCalledTimes(2);
	});

	it("keeps refreshing an ended recording until the analysis snapshot is also final", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		const rendered = renderWithQuery(
			<AisaMomentTimeline
				{...props}
				snapshot={{ ...snapshot, isFinal: false }}
			/>,
		);
		await waitFor(() =>
			expect(marker("goal")).toHaveAttribute("data-playable", "true"),
		);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(10_000);
		});
		expect(mocks.read).toHaveBeenCalledTimes(2);
		rendered.rerender(<AisaMomentTimeline {...props} />);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(30_000);
		});
		expect(mocks.read).toHaveBeenCalledTimes(2);
	});

	it("clears the selected recording when the organization binding changes", async () => {
		const user = userEvent.setup();
		const rendered = renderWithQuery(<AisaMomentTimeline {...props} />);
		await waitFor(() =>
			expect(marker("goal")).toHaveAttribute("data-playable", "true"),
		);
		await user.click(marker("goal"));
		expect(screen.getByTestId("selected-player")).toBeInTheDocument();
		mocks.org = "00000000-0000-4000-8000-000000000002";
		rendered.rerender(<AisaMomentTimeline {...props} />);
		expect(screen.queryByTestId("selected-player")).toBeNull();
		await waitFor(() => expect(mocks.read).toHaveBeenCalledTimes(2));
		expect(mocks.read.mock.calls[1]?.[0]).toContain(
			"expectedOrganizationId=00000000-0000-4000-8000-000000000002",
		);
	});
});
