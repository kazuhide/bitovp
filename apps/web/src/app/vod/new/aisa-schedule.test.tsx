import { fireEvent, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderWithQuery as render } from "@/test/render";
import {
	DEFAULT_WIZARD_STATE,
	type WizardStartOptions,
	type WizardState,
} from "./build-plan";
import { EncodingOptionsSection } from "./wizard-sections";

type Ai = NonNullable<WizardStartOptions["aiSceneAnalysis"]>;
const imported: Ai = {
	filename: "analysis.json",
	path: "ai",
	outputLanguageCodes: ["en"],
	allSceneBoundaries: { isEnabled: true, insertCueTags: true },
	schedule: [{ position: 12.5, maxDeviation: 0, duration: 0 }],
};

function mount(ai: Ai = imported, locale: "en" | "ja" = "en") {
	const onPatch = vi.fn();
	function Harness() {
		const [state, setState] = useState<WizardState>({
			...DEFAULT_WIZARD_STATE,
			startOptions: { aiSceneAnalysis: ai },
		});
		return (
			<EncodingOptionsSection
				state={state}
				onPatch={(patch) => {
					onPatch(patch);
					setState((prev) => ({ ...prev, ...patch }));
				}}
			/>
		);
	}
	render(<Harness />, locale);
	return onPatch;
}

describe("AISA schedule", () => {
	it("edits imported zero values while preserving scene boundaries and metadata", () => {
		const onPatch = mount();
		expect(screen.getByLabelText("Position (seconds) 1")).toHaveValue(12.5);
		expect(screen.getByLabelText("Max deviation (seconds) 1")).toHaveValue(0);
		expect(screen.getByLabelText("Duration (seconds, optional) 1")).toHaveValue(
			0,
		);
		fireEvent.change(screen.getByLabelText("Position (seconds) 1"), {
			target: { value: "0" },
		});
		expect(onPatch.mock.lastCall?.[0].startOptions.aiSceneAnalysis).toEqual({
			...imported,
			schedule: [{ position: 0, maxDeviation: 0, duration: 0 }],
		});
	});

	it("adds and removes rows without silently disabling an empty schedule", () => {
		const onPatch = mount();
		fireEvent.click(screen.getByText("Add cue point"));
		expect(screen.getByLabelText("Position (seconds) 2")).toHaveValue(null);
		fireEvent.click(screen.getByLabelText("Remove cue point 1"));
		expect(
			onPatch.mock.lastCall?.[0].startOptions.aiSceneAnalysis.schedule,
		).toHaveLength(1);
		fireEvent.click(screen.getByLabelText("Remove cue point 1"));
		expect(
			onPatch.mock.lastCall?.[0].startOptions.aiSceneAnalysis.schedule,
		).toEqual([]);
		expect(screen.getByText("Add at least one cue point.")).toBeInTheDocument();
	});

	it("keeps cleared required values invalid and omits optional duration", () => {
		const onPatch = mount();
		fireEvent.change(screen.getByLabelText("Duration (seconds, optional) 1"), {
			target: { value: "" },
		});
		expect(
			onPatch.mock.lastCall?.[0].startOptions.aiSceneAnalysis.schedule[0]
				.duration,
		).toBeUndefined();
		for (const label of ["Position (seconds) 1", "Max deviation (seconds) 1"]) {
			fireEvent.change(screen.getByLabelText(label), { target: { value: "" } });
			expect(screen.getByLabelText(label)).toHaveValue(null);
			expect(screen.getByLabelText(label)).toHaveAttribute(
				"aria-invalid",
				"true",
			);
		}
		const cue =
			onPatch.mock.lastCall?.[0].startOptions.aiSceneAnalysis.schedule[0];
		expect(Number.isNaN(cue.position)).toBe(true);
		expect(Number.isNaN(cue.maxDeviation)).toBe(true);
	});

	it("keeps native invalid optional input invalid instead of silently omitting it", () => {
		const onPatch = mount();
		const duration = screen.getByLabelText("Duration (seconds, optional) 1");
		// Browsers expose unparseable number input as empty with badInput=true.
		Object.defineProperty(duration, "validity", {
			configurable: true,
			value: { badInput: true },
		});
		fireEvent.change(duration, { target: { value: "" } });
		expect(
			Number.isNaN(
				onPatch.mock.lastCall?.[0].startOptions.aiSceneAnalysis.schedule[0]
					.duration,
			),
		).toBe(true);
		expect(duration).toHaveAttribute("aria-invalid", "true");
	});

	it("toggles scheduling independently of imported all-scene settings", () => {
		const onPatch = mount();
		fireEvent.click(screen.getByLabelText("Scheduled cue points"));
		expect(onPatch.mock.lastCall?.[0].startOptions.aiSceneAnalysis).toEqual({
			...imported,
			schedule: undefined,
		});
		fireEvent.click(screen.getByLabelText("Scheduled cue points"));
		expect(
			onPatch.mock.lastCall?.[0].startOptions.aiSceneAnalysis.schedule,
		).toHaveLength(1);
		expect(
			onPatch.mock.lastCall?.[0].startOptions.aiSceneAnalysis
				.allSceneBoundaries,
		).toEqual(imported.allSceneBoundaries);
	});

	it("labels Japanese fields and flags negative input", () => {
		mount(imported, "ja");
		const position = screen.getByLabelText("位置（秒） 1");
		fireEvent.change(position, { target: { value: "-1" } });
		expect(position).toHaveAttribute("aria-invalid", "true");
		expect(
			screen.getByText("0 以上の数値を入力してください。"),
		).toBeInTheDocument();
	});
});
