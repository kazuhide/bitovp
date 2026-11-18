import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentOrganizationContext } from "@/components/providers";
import { renderWithQuery } from "@/test/render";
import { MOQ_ARCHIVE_SAVE_TIMEOUT_MS } from "../../../../config/moq-policy";
import { type MoqArchiveSave, MoqHistoryPanel } from "./moq-history-panel";

const mocks = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("@/lib/api", () => ({ apiFetch: mocks.api }));
vi.mock("recharts", () => ({
	ResponsiveContainer: ({ children }: { children: React.ReactNode }) => (
		<div>{children}</div>
	),
	LineChart: ({ children }: { children: React.ReactNode }) => (
		<div>{children}</div>
	),
	Line: () => null,
	Legend: () => null,
	XAxis: () => null,
	YAxis: () => null,
	Tooltip: () => null,
	CartesianGrid: () => null,
}));
const CHANNEL = "00000000-0000-4000-8000-000000000001";
const RUN = "00000000-0000-4000-8000-000000000002";
const SESSION = "00000000-0000-4000-8000-000000000003";
const NEWER = "00000000-0000-4000-8000-000000000004";
const ORG = "00000000-0000-4000-8000-000000000010";
const at = "2026-11-18T00:00:00.000Z";
const view = (organizationId: string | undefined = ORG) => (
	<DocumentOrganizationContext.Provider value={organizationId}>
		<MoqHistoryPanel channelId={CHANNEL} runId={RUN} active={false} />
	</DocumentOrganizationContext.Provider>
);
function uncertainArchive(): MoqArchiveSave {
	return {
		sessionId: SESSION,
		startedAt: at,
		state: "unconfirmed",
		confirmUntilMs: performance.now() + MOQ_ARCHIVE_SAVE_TIMEOUT_MS,
	};
}
beforeEach(() => {
	vi.resetAllMocks();
	mocks.api.mockResolvedValue({
		runId: RUN,
		sessions: [
			{
				id: SESSION,
				startedAt: at,
				endedAt: "2026-11-18T00:01:00.000Z",
				createdAt: at,
				updatedAt: at,
				samples: [
					{
						elapsedMs: 1000,
						latencyMs: 400,
						fps: 30,
						bufferSeconds: 1.2,
						droppedFrames: 0,
						decodedFrames: 30,
						presentedFrames: 30,
						totalFrames: 30,
						resolution: { width: 640, height: 360 },
					},
				],
				events: [{ elapsedMs: 0, type: "started" }],
				archive: {
					contentType: "video/webm",
					bytes: 500,
					sha256: "a".repeat(64),
					durationMs: 60_000,
					recordedAt: at,
				},
			},
		],
		heartbeat: {
			source: "live-encoder-heartbeat",
			points: [],
			truncated: false,
		},
	});
});
afterEach(() => {
	vi.useRealTimers();
});
describe("saved MoQ history and received video", () => {
	it("identifies an uncertain older recording while a newer session stays selected", async () => {
		const response = await mocks.api();
		const newerAt = "2026-11-18T00:02:00.000Z";
		response.sessions[0].archive = null;
		response.sessions.push({
			...response.sessions[0],
			id: NEWER,
			startedAt: newerAt,
			createdAt: newerAt,
			updatedAt: newerAt,
			endedAt: null,
		});
		mocks.api.mockResolvedValue(response);
		const rendered = renderWithQuery(
			<MoqHistoryPanel
				channelId={CHANNEL}
				runId={RUN}
				active={false}
				archiveSaves={[uncertainArchive()]}
			/>,
		);
		expect(await screen.findByRole("combobox")).toHaveValue(NEWER);
		const notice = rendered.container.querySelector(
			`[data-moq-recording-session="${SESSION}"]`,
		);
		expect(notice).toBeVisible();
		expect(notice).toHaveTextContent("Recording save could not be confirmed");
		expect(notice?.querySelector("time")).toHaveAttribute("datetime", at);
		fireEvent.change(screen.getByRole("combobox"), {
			target: { value: SESSION },
		});
		expect(notice).toBeVisible();
		expect(screen.queryByText("No received-video recording")).toBeNull();
	});
	it.each([
		{
			name: "stopped reconciliation",
			active: false,
			unresolved: true,
			abort: true,
		},
		{ name: "active history", active: true, unresolved: true, abort: false },
		{
			name: "ordinary stopped history",
			active: false,
			unresolved: false,
			abort: false,
		},
	])("bounds a stalled $name correctly", async ({
		active,
		unresolved,
		abort,
	}) => {
		vi.useFakeTimers();
		const aborted = vi.fn();
		let requestSignal: AbortSignal | undefined;
		mocks.api.mockImplementation((_path: string, init: RequestInit) => {
			const { signal } = init;
			requestSignal = signal ?? undefined;
			return new Promise((_resolve, reject) => {
				signal?.addEventListener(
					"abort",
					() => {
						aborted();
						reject(signal.reason);
					},
					{ once: true },
				);
			});
		});
		const panel = (archiveSaves: MoqArchiveSave[] = []) => (
			<MoqHistoryPanel
				channelId={CHANNEL}
				runId={RUN}
				active={active}
				archiveSaves={archiveSaves}
			/>
		);
		const rendered = renderWithQuery(panel());
		expect(requestSignal).toBeDefined();
		if (unresolved) rendered.rerender(panel([uncertainArchive()]));
		await act(async () => {
			await vi.advanceTimersByTimeAsync(MOQ_ARCHIVE_SAVE_TIMEOUT_MS - 1);
		});
		expect(aborted).not.toHaveBeenCalled();
		await act(async () => {
			await vi.advanceTimersByTimeAsync(1);
		});
		expect(requestSignal?.aborted).toBe(abort);
		expect(aborted).toHaveBeenCalledTimes(abort ? 1 : 0);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(MOQ_ARCHIVE_SAVE_TIMEOUT_MS);
		});
		expect(mocks.api).toHaveBeenCalledOnce();
		if (abort) {
			const queryKey = ["moq-observations", CHANNEL, RUN];
			expect(rendered.client.getQueryState(queryKey)?.fetchStatus).toBe("idle");
			const expiredSignal = requestSignal;
			await act(async () => {
				void rendered.client.invalidateQueries({ queryKey });
			});
			expect(mocks.api).toHaveBeenCalledTimes(2);
			expect(requestSignal).not.toBe(expiredSignal);
			expect(requestSignal?.aborted).toBe(false);
		}
	});
	it("correlates with existing Push/Heartbeat and keeps secondary measurements collapsed", async () => {
		const rendered = renderWithQuery(view());
		await screen.findByText("Video latency (barcode) (ms · UTC)");
		const link = screen.getByRole("link", { name: "Encoder Push / Heartbeat" });
		const destination = new URL(
			link.getAttribute("href") ?? "",
			"http://localhost",
		);
		expect(destination.pathname).toBe(`/live/${CHANNEL}`);
		expect(destination.hash).toBe("#sec-heartbeat-log");
		expect(destination.searchParams.get("heartbeatRunId")).toBe(RUN);
		expect(destination.searchParams.get("heartbeatFrom")).toBe(at);
		expect(destination.searchParams.get("heartbeatTo")).toBe(
			"2026-11-18T00:01:00.000Z",
		);
		expect(link).toHaveAttribute("data-moq-correlate-run", RUN);
		expect(link).toHaveAttribute("data-moq-correlate-start", at);
		expect(
			rendered.container.querySelector("[data-moq-encoder-history]"),
		).toBeNull();
		expect(
			rendered.container.querySelector('[data-moq-chart="latencyMs"]'),
		).toBeVisible();
		expect(
			rendered.container.querySelector('[data-moq-chart="fps"]'),
		).not.toBeVisible();
		expect(
			rendered.container.querySelector('[data-moq-chart="bufferSeconds"]'),
		).not.toBeVisible();
		fireEvent.click(screen.getByText("More observations"));
		for (const plot of rendered.container.querySelectorAll("[data-moq-chart]"))
			expect(plot).toBeVisible();
	});
	it("renders zero-sample history compactly without empty plots or a duplicate encoder dashboard", async () => {
		const response = await mocks.api();
		response.sessions[0].samples = [];
		mocks.api.mockResolvedValue(response);
		const rendered = renderWithQuery(view());
		expect(await screen.findByText("No saved samples")).toBeVisible();
		expect(rendered.container.querySelector("figure")).toBeNull();
		expect(
			rendered.container.querySelector("[data-moq-encoder-history]"),
		).toBeNull();
		expect(rendered.container.querySelector("video")).not.toBeNull();
	});
	it("names saved canvas pixel updates without presenting them as source FPS", async () => {
		const response = await mocks.api();
		response.sessions[0].samples[0].renderingSource = "canvas";
		response.sessions[0].samples[0].fps = 2;
		mocks.api.mockResolvedValue(response);
		renderWithQuery(view());
		expect(
			await screen.findByText("Canvas image updates (/s · UTC)"),
		).not.toBeVisible();
		fireEvent.click(screen.getByText("More observations"));
		expect(screen.getByText("Canvas image updates (/s · UTC)")).toBeVisible();
		expect(screen.getByText("Canvas (video-only capture)")).toBeInTheDocument();
		expect(screen.queryByText("Video FPS (fps · UTC)")).toBeNull();
	});
	it("keeps an ended run's graphs and seekable received archive available on the same authenticated endpoint", async () => {
		const rendered = renderWithQuery(view());
		expect(
			await screen.findByText("Saved MoQ observations"),
		).toBeInTheDocument();
		await waitFor(() =>
			expect(
				rendered.container.querySelector(
					`video[data-moq-archive="${SESSION}"]`,
				),
			).not.toBeNull(),
		);
		const video = rendered.container.querySelector<HTMLVideoElement>(
			`video[data-moq-archive="${SESSION}"]`,
		);
		expect(video).not.toBeNull();
		expect(video?.getAttribute("src")).toBe(
			`/api/live-channels/${CHANNEL}/runs/${RUN}/moq-observations/${SESSION}/archive?expectedOrganizationId=${ORG}`,
		);
		expect(video?.controls).toBe(true);
		expect(
			video?.compareDocumentPosition(
				screen.getByText("Video latency (barcode) (ms · UTC)"),
			),
		).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
		expect(
			screen.getByRole("link", { name: "Download received video" }),
		).toHaveAttribute("href", video?.getAttribute("src"));
		expect(
			rendered.container.querySelector(`[data-moq-history="${RUN}"]`),
		).toBeInTheDocument();
	});
	it("does not emit a native archive URL without a valid document organization", async () => {
		const rendered = renderWithQuery(view("invalid"));
		expect(
			await screen.findByText("MoQ playback unavailable"),
		).toBeInTheDocument();
		expect(rendered.container.querySelector("video")).toBeNull();
		expect(
			screen.queryByRole("link", { name: "Download received video" }),
		).toBeNull();
	});
	it("shows immutable configured namespace, draft and catalog after playback has ended", async () => {
		const response = await mocks.api();
		response.configuration = {
			namespace: ["original-run"],
			draftVersion: 16,
			catalogTrackName: "catalog",
		};
		mocks.api.mockResolvedValue(response);
		renderWithQuery(view());
		expect(await screen.findByText("Configured namespace")).not.toBeVisible();
		fireEvent.click(screen.getByText("Configuration"));
		expect(screen.getByText("Configured namespace")).toBeVisible();
		expect(
			screen.getByText("Configured namespace").nextElementSibling,
		).toHaveTextContent("original-run");
		expect(
			screen.getByText("Configured draft").nextElementSibling,
		).toHaveTextContent("16");
		expect(
			screen.getByText("Catalog track").nextElementSibling,
		).toHaveTextContent("catalog");
	});
	it("does not substitute another input video or claim an archive when recording is absent", async () => {
		const response = await mocks.api();
		response.sessions[0].archive = null;
		mocks.api.mockResolvedValue(response);
		const rendered = renderWithQuery(
			<MoqHistoryPanel channelId={CHANNEL} runId={RUN} active={false} />,
		);
		expect(
			await screen.findByText("No received-video recording"),
		).toBeInTheDocument();
		expect(rendered.container.querySelector("video")).toBeNull();
	});
	it("shows an unmeasured field instead of an empty chart and names the browser UTC clock", async () => {
		const response = await mocks.api();
		response.sessions[0].samples[0].latencyMs = null;
		mocks.api.mockResolvedValue(response);
		renderWithQuery(
			<MoqHistoryPanel channelId={CHANNEL} runId={RUN} active={false} />,
		);
		expect(await screen.findByText("Unmeasured")).toBeInTheDocument();
		expect(screen.queryByText("Video latency (barcode) (ms · UTC)")).toBeNull();
		expect(screen.getByText(/Browser clock UTC/)).not.toBeVisible();
	});
});
