import {
	act,
	cleanup,
	fireEvent,
	screen,
	within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderLocalized } from "@/test/render";
import { MeasuredMediaComparison } from "./[id]/measured-media-comparison";
import { QualityMetricTabs } from "./quality-metric-tabs";

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

describe("QualityMetricTabs", () => {
	it("defaults to VMAF and connects the selected tab to its visible panel", async () => {
		renderLocalized(
			<QualityMetricTabs
				vmaf={<p>VMAF analysis</p>}
				cambi={<p>CAMBI analysis</p>}
			/>,
		);
		const list = screen.getByRole("tablist", { name: "Quality metric" });
		const tabs = within(list).getAllByRole("tab");
		expect(tabs.map((tab) => tab.textContent)).toEqual(["VMAF", "CAMBI"]);
		expect(tabs[0]).toHaveAttribute("aria-selected", "true");
		expect(tabs[0]).toHaveAttribute("tabindex", "0");
		expect(tabs[1]).toHaveAttribute("tabindex", "-1");
		const vmaf = screen.getByRole("tabpanel", { name: "VMAF" });
		expect(vmaf).toHaveAttribute("id", tabs[0]?.getAttribute("aria-controls"));
		expect(vmaf).toHaveTextContent("VMAF analysis");
		expect(screen.queryByText("CAMBI analysis")).not.toBeInTheDocument();
		await userEvent.click(tabs[1] as HTMLElement);
		expect(tabs[1]).toHaveAttribute("aria-selected", "true");
		expect(tabs[0]).toHaveAttribute("tabindex", "-1");
		expect(screen.getByRole("tabpanel", { name: "CAMBI" })).toHaveTextContent(
			"CAMBI analysis",
		);
		expect(screen.queryByText("VMAF analysis")).not.toBeInTheDocument();
	});

	it("moves focus and activation with arrows, Home and End using one tab stop", async () => {
		renderLocalized(
			<QualityMetricTabs vmaf="VMAF analysis" cambi="CAMBI analysis" />,
		);
		const user = userEvent.setup();
		const vmaf = screen.getByRole("tab", { name: "VMAF" });
		const cambi = screen.getByRole("tab", { name: "CAMBI" });
		await user.tab();
		expect(vmaf).toHaveFocus();
		for (const [key, expected] of [
			["{ArrowRight}", cambi],
			["{ArrowRight}", vmaf],
			["{ArrowLeft}", cambi],
			["{Home}", vmaf],
			["{End}", cambi],
		] as const) {
			await user.keyboard(key);
			expect(expected).toHaveFocus();
			expect(expected).toHaveAttribute("aria-selected", "true");
			expect(expected).toHaveAttribute("tabindex", "0");
		}
		await user.tab();
		expect(screen.getByRole("tabpanel", { name: "CAMBI" })).toHaveFocus();
	});

	it("uses a Japanese group label and unique ARIA targets for separate reports", () => {
		renderLocalized(
			<>
				<QualityMetricTabs vmaf="First VMAF" cambi="First CAMBI" />
				<QualityMetricTabs vmaf="Second VMAF" cambi="Second CAMBI" />
			</>,
			"ja",
		);
		expect(screen.getAllByRole("tablist", { name: "画質指標" })).toHaveLength(
			2,
		);
		const tabs = screen.getAllByRole("tab");
		const targets = tabs.map((tab) => tab.getAttribute("aria-controls"));
		expect(new Set(targets).size).toBe(4);
		for (const tab of tabs) {
			const panel = document.getElementById(
				tab.getAttribute("aria-controls") ?? "",
			);
			expect(panel).toHaveAttribute("aria-labelledby", tab.id);
		}
	});

	it("returns the VMAF view without tabs when CAMBI is absent", async () => {
		const view = renderLocalized(
			<QualityMetricTabs
				vmaf={<p>VMAF analysis</p>}
				cambi={<p>CAMBI analysis</p>}
			/>,
		);
		await userEvent.click(screen.getByRole("tab", { name: "CAMBI" }));
		view.rerender(<QualityMetricTabs vmaf={<p>VMAF analysis</p>} />);
		expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
		expect(screen.queryByRole("tabpanel")).not.toBeInTheDocument();
		expect(screen.getByText("VMAF analysis")).toBeInTheDocument();
		expect(screen.queryByText("CAMBI analysis")).not.toBeInTheDocument();
	});

	it("shows an unavailable metric as closed while preserving open intent for an available metric", async () => {
		vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
		vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
		const play = vi
			.spyOn(HTMLMediaElement.prototype, "play")
			.mockResolvedValue();
		const previous = Object.getOwnPropertyDescriptor(
			HTMLVideoElement.prototype,
			"requestVideoFrameCallback",
		);
		Object.defineProperty(
			HTMLVideoElement.prototype,
			"requestVideoFrameCallback",
			{
				configurable: true,
				value: vi.fn(() => 1),
			},
		);
		try {
			const player = (metric: "VMAF" | "CAMBI") => (
				<MeasuredMediaComparison
					candidates={["a", "b"].map((id) => ({
						id,
						label: `${metric} ${id}`,
						url: `/${metric.toLowerCase()}-${id}.mp4`,
					}))}
					clock={
						metric === "VMAF" ? null : { kind: "time", timestamps: [0, 1] }
					}
					metric={metric}
					unavailableReason="Missing reference FPS"
					scoreAt={() => undefined}
					renderChart={() => null}
				/>
			);
			renderLocalized(
				<QualityMetricTabs vmaf={player("VMAF")} cambi={player("CAMBI")} />,
			);
			await userEvent.click(screen.getByRole("tab", { name: "CAMBI" }));
			await userEvent.click(
				screen.getByRole("button", { name: "Open comparison preview" }),
			);
			const oldVideos = [...document.querySelectorAll("video")];
			expect(oldVideos).toHaveLength(2);
			await userEvent.click(screen.getByRole("tab", { name: "VMAF" }));
			const unavailable = screen.getByRole("button", {
				name: "Open comparison preview",
			});
			expect(unavailable).toBeDisabled();
			expect(unavailable).toHaveAttribute("aria-expanded", "false");
			expect(document.querySelectorAll("video")).toHaveLength(0);
			for (const video of oldVideos) expect(video).not.toHaveAttribute("src");
			await userEvent.click(screen.getByRole("tab", { name: "CAMBI" }));
			expect(
				screen.getByRole("button", { name: "Close comparison preview" }),
			).toHaveAttribute("aria-expanded", "true");
			expect(document.querySelectorAll("video")).toHaveLength(2);
			expect(
				screen.getByRole("spinbutton", { name: "Presentation time (s)" }),
			).toHaveValue(0);
			expect(play).not.toHaveBeenCalled();
			for (const video of document.querySelectorAll("video"))
				expect(video.paused).toBe(true);
		} finally {
			cleanup();
			if (previous)
				Object.defineProperty(
					HTMLVideoElement.prototype,
					"requestVideoFrameCallback",
					previous,
				);
			else
				Reflect.deleteProperty(
					HTMLVideoElement.prototype,
					"requestVideoFrameCallback",
				);
		}
	});

	it("keeps preview disclosure across metrics while releasing old sources and resetting each clock without autoplay", async () => {
		vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
		vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
		let finishPlay = () => {};
		const pendingPlay = new Promise<void>((resolve) => {
			finishPlay = resolve;
		});
		const play = vi
			.spyOn(HTMLMediaElement.prototype, "play")
			.mockReturnValue(pendingPlay);
		const previous = Object.getOwnPropertyDescriptor(
			HTMLVideoElement.prototype,
			"requestVideoFrameCallback",
		);
		Object.defineProperty(
			HTMLVideoElement.prototype,
			"requestVideoFrameCallback",
			{
				configurable: true,
				value: vi.fn(() => 1),
			},
		);
		try {
			const player = (metric: "VMAF" | "CAMBI") => (
				<MeasuredMediaComparison
					candidates={["a", "b"].map((id) => ({
						id,
						label: `${metric} ${id}`,
						url: `/${metric.toLowerCase()}-${id}.mp4`,
					}))}
					clock={
						metric === "VMAF"
							? { kind: "frame", fps: 24, max: 48 }
							: { kind: "time", timestamps: [0, 0.125, 1] }
					}
					metric={metric}
					unavailableReason="Unavailable"
					scoreAt={() => undefined}
					renderChart={() => null}
				/>
			);
			renderLocalized(
				<QualityMetricTabs vmaf={player("VMAF")} cambi={player("CAMBI")} />,
			);
			await userEvent.click(
				screen.getByRole("button", { name: "Open comparison preview" }),
			);
			const oldVideos = [...document.querySelectorAll("video")];
			expect(oldVideos.map((video) => video.getAttribute("src"))).toEqual([
				"/vmaf-a.mp4",
				"/vmaf-b.mp4",
			]);
			for (const video of oldVideos) {
				Object.defineProperty(video, "readyState", {
					configurable: true,
					value: 4,
				});
				fireEvent.loadedMetadata(video);
				fireEvent.canPlay(video);
			}
			const frame = screen.getByRole("spinbutton", { name: "Selected frame" });
			fireEvent.change(frame, { target: { value: "24" } });
			fireEvent.blur(frame);
			await userEvent.click(screen.getByRole("button", { name: "Play both" }));
			expect(play).toHaveBeenCalledTimes(2);
			await userEvent.click(screen.getByRole("tab", { name: "CAMBI" }));
			expect(document.querySelectorAll("video")).toHaveLength(2);
			for (const video of oldVideos) {
				expect(video.isConnected).toBe(false);
				expect(video).not.toHaveAttribute("src");
			}
			const cambiVideos = [...document.querySelectorAll("video")];
			expect(cambiVideos.map((video) => video.getAttribute("src"))).toEqual([
				"/cambi-a.mp4",
				"/cambi-b.mp4",
			]);
			expect(
				screen.getByRole("spinbutton", { name: "Presentation time (s)" }),
			).toHaveValue(0);
			await act(async () => {
				finishPlay();
				await pendingPlay;
			});
			expect(play).toHaveBeenCalledTimes(2);
			expect(
				screen.queryByRole("button", { name: "Pause both" }),
			).not.toBeInTheDocument();
			await userEvent.click(screen.getByRole("tab", { name: "VMAF" }));
			expect(document.querySelectorAll("video")).toHaveLength(2);
			for (const video of cambiVideos) expect(video).not.toHaveAttribute("src");
			expect(
				screen.getByRole("spinbutton", { name: "Selected frame" }),
			).toHaveValue(0);
			expect(play).toHaveBeenCalledTimes(2);
			await userEvent.click(
				screen.getByRole("button", { name: "Close comparison preview" }),
			);
			await userEvent.click(screen.getByRole("tab", { name: "CAMBI" }));
			expect(document.querySelectorAll("video")).toHaveLength(0);
			expect(
				screen.getByRole("button", { name: "Open comparison preview" }),
			).toBeInTheDocument();
		} finally {
			cleanup();
			if (previous)
				Object.defineProperty(
					HTMLVideoElement.prototype,
					"requestVideoFrameCallback",
					previous,
				);
			else
				Reflect.deleteProperty(
					HTMLVideoElement.prototype,
					"requestVideoFrameCallback",
				);
		}
	});
});
