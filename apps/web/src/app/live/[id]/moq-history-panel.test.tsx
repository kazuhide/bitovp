import { screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentOrganizationContext } from "@/components/providers";
import { renderWithQuery } from "@/test/render";
import { MoqHistoryPanel } from "./moq-history-panel";

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
const ORG = "00000000-0000-4000-8000-000000000010";
const at = "2026-11-18T00:00:00.000Z";
const view = (organizationId: string | undefined = ORG) => (
	<DocumentOrganizationContext.Provider value={organizationId}>
		<MoqHistoryPanel channelId={CHANNEL} runId={RUN} active={false} />
	</DocumentOrganizationContext.Provider>
);
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
describe("saved MoQ history and received video", () => {
	it("names saved canvas pixel updates without presenting them as source FPS", async () => {
		const response = await mocks.api();
		response.sessions[0].samples[0].renderingSource = "canvas";
		response.sessions[0].samples[0].fps = 2;
		mocks.api.mockResolvedValue(response);
		renderWithQuery(view());
		expect(
			await screen.findByText("Canvas image updates (/s · UTC)"),
		).toBeInTheDocument();
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
		expect(await screen.findByText("Configured namespace")).toBeInTheDocument();
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
		expect(screen.getByText(/Browser clock UTC/)).toBeInTheDocument();
	});
});
