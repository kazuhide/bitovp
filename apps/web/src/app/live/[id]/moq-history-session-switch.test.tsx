import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentOrganizationContext } from "@/components/providers";
import { renderWithQuery } from "@/test/render";
import { MoqHistoryPanel } from "./moq-history-panel";

const mocks = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("@/lib/api", () => ({ apiFetch: mocks.api }));
vi.mock("recharts", () => ({
	ResponsiveContainer: ({ children }: { children: React.ReactNode }) =>
		children,
	LineChart: ({ children }: { children: React.ReactNode }) => children,
	Line: () => null,
	XAxis: () => null,
	YAxis: () => null,
	Tooltip: () => null,
	CartesianGrid: () => null,
}));

const CHANNEL = "00000000-0000-4000-8000-000000000001";
const RUN = "00000000-0000-4000-8000-000000000002";
const OLDER = "00000000-0000-4000-8000-000000000003";
const NEWER = "00000000-0000-4000-8000-000000000004";
const ORG = "00000000-0000-4000-8000-000000000010";
const olderTime = "2026-11-18T00:00:01.111Z";
const newerTime = "2026-11-18T00:01:01.222Z";
function session(id: string, startedAt: string) {
	return {
		id,
		startedAt,
		endedAt: new Date(Date.parse(startedAt) + 30_000).toISOString(),
		createdAt: startedAt,
		updatedAt: startedAt,
		samples: [],
		events: [
			{ elapsedMs: 0, type: "started" },
			{ elapsedMs: 1000, type: "first-frame" },
		],
		archive: {
			contentType: "video/webm",
			bytes: 500,
			sha256: "a".repeat(64),
			durationMs: 30_000,
			recordedAt: startedAt,
		},
	};
}
beforeEach(() => {
	vi.resetAllMocks();
	mocks.api.mockResolvedValue({
		runId: RUN,
		sessions: [
			session(OLDER, "2026-11-18T00:00:00.000Z"),
			session(NEWER, "2026-11-18T00:01:00.000Z"),
		],
		heartbeat: {
			source: "live-encoder-heartbeat",
			points: [],
			truncated: false,
		},
	});
	vi.spyOn(HTMLMediaElement.prototype, "readyState", "get").mockReturnValue(2);
	vi.spyOn(HTMLMediaElement.prototype, "currentTime", "get").mockImplementation(
		function (this: HTMLVideoElement) {
			return this.dataset.moqArchive === OLDER ? 0.111 : 0.222;
		},
	);
});
afterEach(() => vi.restoreAllMocks());

describe("received recording selection", () => {
	it("replaces the old video and clock together across repeated session changes", async () => {
		const rendered = renderWithQuery(
			<DocumentOrganizationContext.Provider value={ORG}>
				<MoqHistoryPanel channelId={CHANNEL} runId={RUN} active={false} />
			</DocumentOrganizationContext.Provider>,
		);
		await screen.findByText("2026-11-18 00:01:01.222 UTC");
		const previousVideos: Element[] = [];
		for (const id of [OLDER, NEWER, OLDER]) {
			const oldVideo = rendered.container.querySelector(
				"video[data-moq-archive]",
			);
			if (oldVideo) previousVideos.push(oldVideo);
			fireEvent.change(screen.getByRole("combobox"), { target: { value: id } });
			await waitFor(() => {
				const videos = rendered.container.querySelectorAll(
					"video[data-moq-archive]",
				);
				expect(videos).toHaveLength(1);
				expect(videos[0]).toHaveAttribute("data-moq-archive", id);
				expect(
					rendered.container.querySelectorAll(
						"[data-moq-client-playback-clock]",
					),
				).toHaveLength(1);
				expect(
					rendered.container.querySelector(
						"time[data-moq-client-playback-time]",
					),
				).toHaveAttribute("dateTime", id === OLDER ? olderTime : newerTime);
			});
			for (const video of previousVideos) expect(video.isConnected).toBe(false);
		}
	});
});
