import { fireEvent, screen, waitFor, within } from "@testing-library/react";
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
	ReferenceLine: () => null,
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
		samples: [1_000, 2_000].map((elapsedMs) => ({
			elapsedMs,
			latencyMs: 480,
			fps: null,
			bufferSeconds: null,
			droppedFrames: null,
			decodedFrames: null,
			presentedFrames: null,
			totalFrames: null,
			resolution: null,
		})),
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
	it("distinguishes sessions that start within the same UTC second", async () => {
		const response = await mocks.api();
		mocks.api.mockResolvedValue({
			...response,
			sessions: [
				session(OLDER, "2026-11-18T00:00:00.100Z"),
				session(NEWER, "2026-11-18T00:00:00.900Z"),
			],
		});
		const rendered = renderWithQuery(
			<DocumentOrganizationContext.Provider value={ORG}>
				<MoqHistoryPanel channelId={CHANNEL} runId={RUN} active={false} />
			</DocumentOrganizationContext.Provider>,
		);
		const selector = await screen.findByRole("combobox");
		expect(
			within(selector)
				.getAllByRole("option")
				.map((option) => option.textContent),
		).toEqual(["2026-11-18 00:00:00.900 UTC", "2026-11-18 00:00:00.100 UTC"]);
		const earlier = within(selector).getByRole("option", {
			name: "2026-11-18 00:00:00.100 UTC",
		});
		fireEvent.change(selector, {
			target: { value: earlier.getAttribute("value") },
		});
		expect(
			rendered.container.querySelector("video[data-moq-archive]"),
		).toHaveAttribute("data-moq-archive", OLDER);
	});
	it("numbers only identical timestamps in stable UUID order", async () => {
		const response = await mocks.api();
		const alternate = "00000000-0000-4000-8000-000000000005";
		const sameStart = "2026-11-18T00:00:00.100Z";
		mocks.api.mockResolvedValue({
			...response,
			sessions: [
				session(NEWER, sameStart),
				session(alternate, "2026-11-18T00:00:00.900Z"),
				session(OLDER, sameStart),
			],
		});
		const rendered = renderWithQuery(
			<DocumentOrganizationContext.Provider value={ORG}>
				<MoqHistoryPanel channelId={CHANNEL} runId={RUN} active={false} />
			</DocumentOrganizationContext.Provider>,
		);
		const selector = await screen.findByRole("combobox");
		const options = within(selector).getAllByRole("option");
		expect(
			options.map((option) => [
				option.getAttribute("value"),
				option.textContent,
			]),
		).toEqual([
			[alternate, "2026-11-18 00:00:00.900 UTC"],
			[OLDER, "2026-11-18 00:00:00.100 UTC · 1"],
			[NEWER, "2026-11-18 00:00:00.100 UTC · 2"],
		]);
		fireEvent.change(selector, {
			target: { value: options[2]?.getAttribute("value") },
		});
		expect(
			rendered.container.querySelector("video[data-moq-archive]"),
		).toHaveAttribute("data-moq-archive", NEWER);
	});
	it("replaces the old video and clock together across repeated session changes", async () => {
		const rendered = renderWithQuery(
			<DocumentOrganizationContext.Provider value={ORG}>
				<MoqHistoryPanel channelId={CHANNEL} runId={RUN} active={false} />
			</DocumentOrganizationContext.Provider>,
		);
		await screen.findByText("2026-11-18 00:01:01.222 UTC");
		expect(
			rendered.container.querySelector("[data-moq-playhead]"),
		).toHaveAttribute("data-moq-playhead", String(Date.parse(newerTime)));
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
				const playheads = rendered.container.querySelectorAll(
					"[data-moq-playhead]",
				);
				expect(playheads).toHaveLength(1);
				expect(playheads[0]).toHaveAttribute(
					"data-moq-playhead",
					String(Date.parse(id === OLDER ? olderTime : newerTime)),
				);
			});
			const video = rendered.container.querySelector("video[data-moq-archive]");
			if (!video) throw new Error("Selected archive is unavailable");
			fireEvent.seeking(video);
			expect(
				rendered.container.querySelector("[data-moq-playhead]"),
			).toBeNull();
			for (const video of previousVideos) expect(video.isConnected).toBe(false);
		}
	});
});
