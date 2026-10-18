import { fireEvent, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { renderWithQuery } from "@/test/render";
import {
	buildPlan,
	DEFAULT_WIZARD_STATE,
	videoKeys,
	type WizardState,
} from "./build-plan";
import { LadderSection } from "./wizard-sections";

function Harness({ initial }: { initial: WizardState }) {
	const [state, setState] = useState(initial);
	return (
		<>
			<LadderSection
				state={state}
				credentials={[]}
				onPatch={(patch) => setState((current) => ({ ...current, ...patch }))}
			/>
			<output data-testid="keys">
				{JSON.stringify(videoKeys(state.videos))}
			</output>
			<output data-testid="plan">{JSON.stringify(buildPlan(state))}</output>
		</>
	);
}

function initialState(): WizardState {
	return {
		...structuredClone(DEFAULT_WIZARD_STATE),
		videos: [{ height: 1080, bitrate: 6_000_000, extras: { key: "v1080" } }],
	};
}

describe("copied video keys follow height in the ladder", () => {
	it("updates v1080-2 to v900 together with its primary muxing reference", async () => {
		renderWithQuery(<Harness initial={initialState()} />);
		fireEvent.click(screen.getByRole("button", { name: "Add video" }));
		await waitFor(() =>
			expect(screen.getByTestId("keys").textContent).toBe(
				'["v1080","v1080-2"]',
			),
		);
		fireEvent.change(screen.getByLabelText("Video 2 height"), {
			target: { value: "900" },
		});
		expect(screen.getByTestId("keys").textContent).toBe('["v1080","v900"]');
		const plan = JSON.parse(screen.getByTestId("plan").textContent ?? "{}");
		expect(plan.renditions[1]).toMatchObject({ key: "v900", height: 900 });
		expect(plan.muxings[1]).toMatchObject({ key: "v900", streamKey: "v900" });
	});

	it("uses a collision suffix without renaming the existing 900p row", async () => {
		const initial = initialState();
		initial.videos.push({ height: 900, bitrate: 3_000_000 });
		renderWithQuery(<Harness initial={initial} />);
		fireEvent.change(screen.getByLabelText("Video settings to reuse"), {
			target: { value: "v1080" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Add video" }));
		await waitFor(() =>
			expect(screen.getByTestId("keys").textContent).toBe(
				'["v1080","v900","v1080-2"]',
			),
		);
		fireEvent.change(screen.getByLabelText("Video 3 height"), {
			target: { value: "900" },
		});
		expect(screen.getByTestId("keys").textContent).toBe(
			'["v1080","v900","v900-2"]',
		);
	});
});
