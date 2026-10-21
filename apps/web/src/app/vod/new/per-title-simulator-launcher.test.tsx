import type { PerTitleProposal } from "@bitovp/core";
import { fireEvent, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderLocalized as render } from "@/test/render";
import { DEFAULT_WIZARD_STATE, type WizardState } from "./build-plan";
import { PerTitleSimulatorLauncher } from "./per-title-simulator-launcher";

const mocks = vi.hoisted(() => ({ apply: vi.fn() }));

vi.mock("./per-title-simulator-wizard", () => ({
	perTitleGoalFromWizard: () => ({ codec: "H264", strategy: "automatic" }),
	applyPerTitleProposal: (...args: unknown[]) => mocks.apply(...args),
}));

vi.mock("./per-title-simulator", () => ({
	PerTitleSimulator: ({
		open,
		onApply,
	}: {
		open: boolean;
		onApply: (proposal: PerTitleProposal) => void;
	}) =>
		open ? (
			<button
				type="button"
				onClick={() =>
					onApply({
						codec: "H264",
						applicable: true,
					} as PerTitleProposal)
				}
			>
				Review candidate
			</button>
		) : null,
}));

describe("PerTitleSimulatorLauncher", () => {
	beforeEach(() => {
		mocks.apply.mockReset();
		mocks.apply.mockImplementation((state: WizardState) => ({
			...state,
			name: "Updated draft",
		}));
	});

	it("shows actual plan changes and leaves the draft unchanged until confirmation", () => {
		const onPatch = vi.fn();
		render(
			<PerTitleSimulatorLauncher
				state={structuredClone(DEFAULT_WIZARD_STATE)}
				onPatch={onPatch}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "Open simulator" }));
		fireEvent.click(screen.getByRole("button", { name: "Review candidate" }));
		expect(
			screen.getByRole("dialog", { name: "Review ladder changes" }),
		).toBeInTheDocument();
		expect(screen.getByText("Updated draft")).toBeInTheDocument();
		expect(onPatch).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "Apply to draft" }));
		expect(onPatch).toHaveBeenCalledOnce();
		expect(onPatch.mock.calls[0]?.[0].name).toBe("Updated draft");
	});

	it("cancels the review without modifying the draft", () => {
		const onPatch = vi.fn();
		render(
			<PerTitleSimulatorLauncher
				state={structuredClone(DEFAULT_WIZARD_STATE)}
				onPatch={onPatch}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "Open simulator" }));
		fireEvent.click(screen.getByRole("button", { name: "Review candidate" }));
		fireEvent.click(screen.getByRole("button", { name: "Back to simulator" }));
		expect(
			screen.getByRole("button", { name: "Review candidate" }),
		).toBeInTheDocument();
		expect(onPatch).not.toHaveBeenCalled();
	});

	it("compares streams by key so an added video does not appear to replace audio", () => {
		mocks.apply.mockImplementation((current: WizardState) => ({
			...current,
			videos: [
				...current.videos,
				{ codec: "H265", height: 720, bitrate: 1000000 },
			],
		}));
		render(
			<PerTitleSimulatorLauncher
				state={structuredClone(DEFAULT_WIZARD_STATE)}
				onPatch={vi.fn()}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "Open simulator" }));
		fireEvent.click(screen.getByRole("button", { name: "Review candidate" }));
		expect(screen.getByRole("dialog")).not.toHaveTextContent("AAC");
		expect(screen.getByRole("dialog")).not.toHaveTextContent("a64");
		expect(screen.getByRole("dialog")).toHaveTextContent("H265");
	});

	it("rejects an old proposal when the wizard changes before applying", () => {
		const initial = structuredClone(DEFAULT_WIZARD_STATE);
		const onPatch = vi.fn();
		const view = render(
			<PerTitleSimulatorLauncher state={initial} onPatch={onPatch} />,
		);
		fireEvent.click(screen.getByRole("button", { name: "Open simulator" }));
		fireEvent.click(screen.getByRole("button", { name: "Review candidate" }));
		view.rerender(
			<PerTitleSimulatorLauncher
				state={{ ...initial, name: "Newer edit" }}
				onPatch={onPatch}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "Apply to draft" }));
		expect(screen.getByRole("alert")).toHaveTextContent("The draft changed");
		expect(onPatch).not.toHaveBeenCalled();
	});

	it("explains when upper-rendition settings are removed", () => {
		const state = structuredClone(DEFAULT_WIZARD_STATE);
		state.startOptions = {
			perTitle: { h264: { forcedRenditionAboveHighestFixedRepresentation: 1 } },
		};
		mocks.apply.mockImplementation((current: WizardState) => ({
			...current,
			startOptions: { perTitle: { h264: {} } },
		}));
		render(<PerTitleSimulatorLauncher state={state} onPatch={vi.fn()} />);
		fireEvent.click(screen.getByRole("button", { name: "Open simulator" }));
		fireEvent.click(screen.getByRole("button", { name: "Review candidate" }));
		expect(
			screen.getByText(
				/removes the existing upper-rendition addition settings/,
			),
		).toBeInTheDocument();
	});
});
