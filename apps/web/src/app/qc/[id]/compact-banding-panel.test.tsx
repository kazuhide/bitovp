import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithQuery } from "@/test/render";
import type { BandingResultDetail } from "../vmaf-shared";
import { BandingPanels } from "./banding-panel";

const hint =
	"CAMBI detects visible contouring in the encoded video. It needs no reference video or VMAF model. Higher scores indicate more banding.";
const result: BandingResultDetail = {
	id: "first",
	renditionRef: { label: "1080p" },
	pooled: {
		banding: {
			mean: 4,
			min: 1,
			max: 12,
			frameCount: 1502,
			durationSeconds: 60.08,
		},
	},
	bandingPreview: { url: "/first.mp4?metric=banding" },
	bandingFrames: [
		{ frameNum: 0, timestampSeconds: 0, durationSeconds: 0.04, cambi: 1 },
		{
			frameNum: 1001,
			timestampSeconds: 40.08,
			durationSeconds: 0.08,
			cambi: 12,
		},
	],
	bandingExecution: {
		version: 1,
		metric: "CAMBI_NR",
		backend: "vulkan",
		implementation: "bitovp-owned",
		decisionSource: "CPU_REFERENCE",
		coverage: { complete: true, frameCount: 1502, durationSeconds: 60.08 },
	},
	bandingAssessment: {
		severity: "FAIL",
		warningThreshold: 5,
		failureThreshold: 10,
		affectedSeconds: 0.12,
		warningSeconds: 0,
		failureSeconds: 0.12,
		ranges: [
			{
				startSeconds: 40.04,
				endSeconds: 40.16,
				startFrame: 1000,
				endFrame: 1001,
				peak: 12,
				severity: "FAIL",
			},
		],
	},
};
const renditions = [
	result,
	...["720p", "360p"].map((label, index) => ({
		...result,
		id: `extra-${index}`,
		renditionRef: { label },
		bandingPreview: { url: `/extra-${index}.mp4?metric=banding` },
	})),
];
const originalFrameCallback = Object.getOwnPropertyDescriptor(
	HTMLVideoElement.prototype,
	"requestVideoFrameCallback",
);
const originalCancelCallback = Object.getOwnPropertyDescriptor(
	HTMLVideoElement.prototype,
	"cancelVideoFrameCallback",
);

beforeEach(() => {
	vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
	vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
	Object.defineProperty(
		HTMLVideoElement.prototype,
		"requestVideoFrameCallback",
		{
			configurable: true,
			value: vi.fn(() => 1),
		},
	);
	Object.defineProperty(
		HTMLVideoElement.prototype,
		"cancelVideoFrameCallback",
		{
			configurable: true,
			value: vi.fn(),
		},
	);
});
afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	for (const [name, descriptor] of [
		["requestVideoFrameCallback", originalFrameCallback],
		["cancelVideoFrameCallback", originalCancelCallback],
	] as const) {
		if (descriptor)
			Object.defineProperty(HTMLVideoElement.prototype, name, descriptor);
		else Reflect.deleteProperty(HTMLVideoElement.prototype, name);
	}
});

describe("compact CAMBI panels", () => {
	it("keeps a heading and moves the long explanation into accessible keyboard help", async () => {
		renderWithQuery(<BandingPanels results={[result]} compact />, "en");
		expect(
			screen.getByRole("heading", {
				name: "Banding detection · CAMBI",
				level: 2,
			}),
		).toBeVisible();
		expect(screen.queryByText(hint, { selector: "p" })).not.toBeInTheDocument();
		const help = screen.getByRole("button", {
			name: "Banding detection — more information",
		});
		expect(help).toHaveAccessibleDescription(hint);
		await userEvent.tab();
		expect(help).toHaveFocus();
		await userEvent.keyboard("{Enter}");
		expect(screen.getByRole("tooltip")).toHaveTextContent(hint);
		await userEvent.keyboard("{Escape}");
		expect(help).toHaveFocus();
		expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
	});

	it("preserves the default CAMBI-only explanation and full-sized charts", () => {
		const { container } = renderWithQuery(
			<BandingPanels results={[result]} />,
			"en",
		);
		expect(screen.getByText(hint, { selector: "p" })).toBeVisible();
		expect(
			screen.queryByRole("button", {
				name: "Banding detection — more information",
			}),
		).not.toBeInTheDocument();
		expect(container.firstElementChild).toHaveClass("mt-6", "space-y-6");
		expect(
			screen.getByRole("img", { name: "CAMBI by presentation time — 1080p" }),
		).toHaveClass("h-60");
		expect(
			screen.getByText(/interval ends are exclusive/, { selector: "p" }),
		).toBeVisible();
	});

	it("keeps every rendition, statistic, threshold and diagnostic in the compact responsive grid", () => {
		renderWithQuery(<BandingPanels results={renditions} compact />, "en");
		const cards = ["1080p", "720p", "360p"].map((label) =>
			screen.getByRole("region", { name: `Banding detection — ${label}` }),
		);
		expect(cards[0]?.parentElement).toHaveClass(
			"grid",
			"grid-cols-1",
			"xl:grid-cols-2",
			"gap-3",
		);
		for (const card of cards) {
			expect(card).toHaveClass("min-w-0", "p-3");
			expect(
				within(card)
					.getAllByRole("term")
					.map((entry) => entry.textContent),
			).toEqual([
				"Mean CAMBI",
				"Peak CAMBI",
				"Minimum CAMBI",
				"Frames measured",
				"Measured duration",
			]);
			expect(
				within(card)
					.getAllByRole("definition")
					.map((entry) => entry.textContent),
			).toEqual(["4", "12", "1", "1,502", "60.08 s"]);
			expect(
				within(card).getByText("Actual execution: AMD Vulkan"),
			).toBeVisible();
			expect(
				within(card).getByText(
					"Decision source: official CPU reference · full-frame coverage",
				),
			).toBeVisible();
			expect(
				within(card).getByText(/Configured limits: Warning ≤ 5 · Failure ≤ 10/),
			).toBeVisible();
			expect(within(card).getByRole("table")).toHaveTextContent("40.04");
			expect(
				within(card).getByRole("button", { name: "Play 40.04–40.16 s" }),
			).toBeEnabled();
			expect(within(card).getByRole("img")).toHaveClass("h-48");
			expect(
				within(card).getByRole("button", {
					name: /CAMBI by presentation time.*more information/,
				}),
			).toHaveAccessibleDescription(/interval ends are exclusive/);
		}
	});

	it("keeps interval preview selection, decoder cleanup and focus restoration in compact mode", async () => {
		renderWithQuery(<BandingPanels results={renditions} compact />, "en");
		const openers = screen.getAllByRole("button", {
			name: "Play 40.04–40.16 s",
		});
		await userEvent.click(openers[0] as HTMLButtonElement);
		const first = screen.getByLabelText("1080p");
		expect(first).toHaveAttribute("src", "/first.mp4?metric=banding");
		await userEvent.click(openers[1] as HTMLButtonElement);
		expect(first).not.toHaveAttribute("src");
		expect(screen.getByLabelText("720p")).toHaveAttribute(
			"src",
			"/extra-0.mp4?metric=banding",
		);
		expect(document.querySelectorAll("video")).toHaveLength(1);
		await userEvent.click(
			screen.getByRole("button", { name: "Close interval preview" }),
		);
		expect(document.querySelectorAll("video")).toHaveLength(0);
		expect(openers[1]).toHaveFocus();
	});

	it("retains missing evidence and disabled range previews without inventing PASS", () => {
		renderWithQuery(
			<BandingPanels
				results={[
					{
						...result,
						bandingExecution: undefined,
						bandingPreview: { unavailableReason: "MISSING_PROVENANCE" },
					},
					{
						...result,
						id: "unknown",
						renditionRef: { label: "Unknown" },
						bandingExecution: undefined,
						bandingAssessment: undefined,
					},
				]}
				compact
			/>,
			"en",
		);
		expect(
			screen.getAllByText("Execution provenance is unavailable"),
		).toHaveLength(2);
		expect(
			screen.getByText("Full-frame assessment is unavailable"),
		).toBeVisible();
		expect(
			screen.getByRole("button", { name: "Play 40.04–40.16 s" }),
		).toBeDisabled();
		expect(screen.queryByText("PASS")).not.toBeInTheDocument();
	});
});
