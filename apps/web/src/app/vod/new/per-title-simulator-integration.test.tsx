import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderLocalized as render } from "@/test/render";
import { DEFAULT_WIZARD_STATE, type WizardState } from "./build-plan";
import { PerTitleSimulatorLauncher } from "./per-title-simulator-launcher";

describe("Per-Title simulator wizard integration", () => {
	it("opens a fresh wizard and retains edits through review without changing the draft", () => {
		const onPatch = vi.fn();
		const state = structuredClone(DEFAULT_WIZARD_STATE);
		render(<PerTitleSimulatorLauncher state={state} onPatch={onPatch} />);
		fireEvent.click(screen.getByRole("button", { name: "Open simulator" }));
		expect(
			screen.getByRole("dialog", { name: "Per-Title simulator" }),
		).toBeInTheDocument();
		fireEvent.change(
			screen.getByRole("spinbutton", { name: "Maximum bitrate (kbps)" }),
			{ target: { value: "8000" } },
		);
		fireEvent.click(screen.getByRole("button", { name: "Review changes" }));
		expect(
			screen.getByRole("dialog", { name: "Review ladder changes" }),
		).toBeInTheDocument();
		expect(onPatch).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "Back to simulator" }));
		expect(
			screen.getByRole("spinbutton", { name: "Maximum bitrate (kbps)" }),
		).toHaveValue(8000);
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		expect(onPatch).not.toHaveBeenCalled();
		expect(state).toEqual(DEFAULT_WIZARD_STATE);
	});

	it("can review and apply a different codec without replacing the original codec", () => {
		const onPatch = vi.fn();
		const state = structuredClone(DEFAULT_WIZARD_STATE);
		render(<PerTitleSimulatorLauncher state={state} onPatch={onPatch} />);
		fireEvent.click(screen.getByRole("button", { name: "Open simulator" }));
		fireEvent.change(screen.getByRole("combobox", { name: "Codec" }), {
			target: { value: "H265" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Review changes" }));
		expect(
			screen.getByRole("dialog", { name: "Review ladder changes" }),
		).toBeInTheDocument();
		expect(onPatch).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "Apply to draft" }));
		expect(onPatch).toHaveBeenCalledOnce();
		const next = onPatch.mock.calls[0]?.[0] as WizardState;
		expect(
			next.videos.filter((row) => (row.codec ?? "H264") === "H264"),
		).toHaveLength(1);
		expect(next.videos.filter((row) => row.codec === "H265")).toMatchObject([
			{ extras: { mode: "PER_TITLE_TEMPLATE" }, bitrate: null },
		]);
		expect(state).toEqual(DEFAULT_WIZARD_STATE);
	});
});
