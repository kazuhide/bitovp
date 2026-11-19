import { screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { MoqHeartbeatPoint } from "@/lib/moq-player/heartbeat";
import { renderLocalized } from "@/test/render";
import { MoqEncoderHistory } from "./moq-encoder-history";
import { MoqViewerMetrics } from "./moq-viewer-metrics";

vi.mock("recharts", () => ({
	ResponsiveContainer: ({ children }: { children: React.ReactNode }) => (
		<div>{children}</div>
	),
	LineChart: ({ children }: { children: React.ReactNode }) => (
		<div>{children}</div>
	),
	Line: ({ dataKey }: { dataKey: string }) => <span data-series={dataKey} />,
	ReferenceLine: () => null,
	XAxis: () => null,
	YAxis: () => null,
	Tooltip: () => null,
	CartesianGrid: () => null,
}));

const startedAt = "2026-11-20T00:00:00.000Z";

describe("MoQ metric panels", () => {
	it("omits empty figures and keeps a measured zero distinct from a missing value", () => {
		const { container, rerender } = renderLocalized(
			<MoqViewerMetrics samples={[]} startedAt={startedAt} />,
		);
		expect(container.querySelector("figure")).toBeNull();
		rerender(
			<MoqViewerMetrics
				samples={[
					{ elapsedMs: 1000, fps: null, latencyMs: 0, bufferSeconds: null },
				]}
				startedAt={startedAt}
			/>,
		);
		expect(container.querySelectorAll("figure")).toHaveLength(1);
		expect(
			container.querySelector('[data-moq-chart="latencyMs"]'),
		).toHaveTextContent("0 ms");
	});

	it("separates Canvas observations and Web X buffer from other sources", () => {
		const { container } = renderLocalized(
			<MoqViewerMetrics
				samples={[
					{
						elapsedMs: 1000,
						fps: 10,
						latencyMs: null,
						bufferSeconds: 1.4,
						renderingSource: "canvas",
						bufferSource: "player",
					},
					{
						elapsedMs: 2000,
						fps: 25,
						latencyMs: null,
						bufferSeconds: 0.9,
						renderingSource: "video",
						bufferSource: "video",
					},
				]}
				startedAt={startedAt}
				playhead={Date.parse(startedAt) + 1500}
			/>,
		);
		expect(container.querySelector('[data-moq-chart="latencyMs"]')).toBeNull();
		const frames = container.querySelector('[data-moq-chart="fps"]');
		expect(frames?.querySelector('[data-series="canvasUpdates"]')).toBeTruthy();
		expect(frames?.querySelector('[data-series="videoFps"]')).toBeTruthy();
		const buffer = container.querySelector('[data-moq-chart="bufferSeconds"]');
		expect(
			buffer?.querySelector('[data-series="playerBufferSeconds"]'),
		).toBeTruthy();
		expect(
			buffer?.querySelector('[data-series="videoBufferSeconds"]'),
		).toBeTruthy();
		expect(buffer?.querySelector("[data-moq-playhead]")).toHaveAttribute(
			"data-moq-playhead",
			String(Date.parse(startedAt) + 1500),
		);
	});

	it("renders only recorded encoder input data and identifies the latest receipt source", () => {
		const observation: MoqHeartbeatPoint = {
			observedAt: startedAt,
			sampledAt: null,
			source: "poll",
			ingestStatus: null,
			ingestHealthy: null,
			videoIncomingBitrateBps: 2_400_000,
			audioIncomingBitrateBps: null,
			videoFps: null,
			droppedPacketsVideo: null,
			droppedPacketsAudio: null,
			corruptPacketsVideo: null,
			corruptPacketsAudio: null,
			segmentProcessingMeanMs: null,
			segmentProcessingMinMs: null,
			segmentProcessingMaxMs: null,
		};
		const { container } = renderLocalized(
			<MoqEncoderHistory
				heartbeat={{
					source: "live-encoder-heartbeat",
					points: [observation],
					truncated: false,
				}}
			/>,
		);
		const encoder = screen.getByRole("region", { name: "Encoder" });
		expect(within(encoder).getByText("Heartbeat · Poll")).toBeVisible();
		expect(within(encoder).getByText("2.40 Mbps")).toBeVisible();
		expect(container.querySelectorAll("figure")).toHaveLength(1);
		expect(container.querySelector('[data-series="audioMbps"]')).toBeNull();
	});
});
