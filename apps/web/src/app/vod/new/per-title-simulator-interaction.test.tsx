import type { PerTitleGoal } from "@bitovp/core";
import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderLocalized } from "@/test/render";
import { PerTitleSimulator } from "./per-title-simulator";

const goal: PerTitleGoal = {
	strategy: "fixed-ranges",
	codec: "H264",
	minBitrate: 100_000,
	maxBitrate: 2_400_000,
	countPolicy: { kind: "exact", count: 5 },
	rows: [
		{ id: "small", height: 240, minBitrate: 160_000, maxBitrate: 200_000 },
		{ id: "middle", height: 480, minBitrate: 400_000, maxBitrate: 480_000 },
		{ id: "large", height: 720, minBitrate: 1_000_000, maxBitrate: 1_200_000 },
	],
};

function automatic(goal: PerTitleGoal): PerTitleGoal {
	return {
		...goal,
		adjustments: {
			...goal.adjustments,
			global: {
				minBitrateStepSize: { mode: "auto", method: "constraints" },
				maxBitrateStepSize: { mode: "auto", method: "constraints" },
				"fixedResolutionAndBitrateConfiguration.forcedRenditionAboveHighestFixedRepresentation":
					{ mode: "auto", method: "constraints" },
				"fixedResolutionAndBitrateConfiguration.forcedRenditionAboveHighestFixedRepresentationFactor":
					{ mode: "auto", method: "constraints" },
				"fixedResolutionAndBitrateConfiguration.forcedRenditionAboveHighestFixedRepresentationCalculationMode":
					{ mode: "auto", method: "constraints" },
				...goal.adjustments?.global,
			},
			streams: Object.fromEntries(
				(goal.rows ?? []).map(({ id }) => [
					id,
					{
						minBitrate: { mode: "auto", method: "logarithmic" },
						maxBitrate: { mode: "auto", method: "logarithmic" },
						bitrateSelectionMode: { mode: "auto", method: "constraints" },
						lowComplexityBoundaryForMaxBitrate: {
							mode: "auto",
							method: "constraints",
						},
						highComplexityBoundaryForMaxBitrate: {
							mode: "auto",
							method: "constraints",
						},
						...goal.adjustments?.streams?.[id],
					},
				]),
			),
		},
	};
}

function show(initialGoal = goal) {
	const onApply = vi.fn();
	renderLocalized(
		<PerTitleSimulator
			open
			initialGoal={automatic(initialGoal)}
			onOpenChange={vi.fn()}
			onApply={onApply}
		/>,
	);
	return { onApply };
}

function proposedApi() {
	return JSON.parse(
		screen.getByTestId("per-title-api-settings").textContent ?? "",
	);
}

function maximum(value: number) {
	fireEvent.change(
		screen.getByRole("slider", { name: "Maximum bitrate slider (kbps)" }),
		{
			target: { value: String(value) },
		},
	);
}

describe("Per-Title automatic interaction", () => {
	it("recalculates automatic row ranges and dependent settings from the overall minimum slider", () => {
		const { onApply } = show();
		const first = proposedApi();
		fireEvent.change(
			screen.getByRole("slider", { name: "Minimum bitrate slider (kbps)" }),
			{
				target: { value: "200" },
			},
		);
		const second = proposedApi();
		expect(
			screen.getByRole("spinbutton", { name: "Minimum bitrate (kbps)" }),
		).toHaveValue(200);
		expect(second.global.minBitrate).toBe(200_000);
		expect(second.streams[1].perTitleSettings.minBitrate).toBeGreaterThan(
			first.streams[1].perTitleSettings.minBitrate,
		);
		expect(second.streams[1].perTitleSettings.maxBitrate).toBeGreaterThan(
			first.streams[1].perTitleSettings.maxBitrate,
		);
		expect(
			second.streams[1].perTitleSettings.lowComplexityBoundaryForMaxBitrate,
		).not.toBe(
			first.streams[1].perTitleSettings.lowComplexityBoundaryForMaxBitrate,
		);
		expect(second.global.fixedResolutionAndBitrateConfiguration).not.toEqual(
			first.global.fixedResolutionAndBitrateConfiguration,
		);
		expect(onApply).not.toHaveBeenCalled();
	});

	it("keeps row slider edits pinned while both overall sliders recalculate automatic values", () => {
		show();
		const rowMinimum = screen.getByRole("slider", {
			name: "Minimum bitrate slider (kbps), rendition 2",
		});
		const rowMaximum = screen.getByRole("slider", {
			name: "Maximum bitrate slider (kbps), rendition 3",
		});
		fireEvent.change(rowMinimum, { target: { value: "350" } });
		fireEvent.change(rowMaximum, { target: { value: "1250" } });
		fireEvent.change(
			screen.getByRole("slider", { name: "Minimum bitrate slider (kbps)" }),
			{ target: { value: "200" } },
		);
		maximum(4800);
		const api = proposedApi();
		expect(rowMinimum).toHaveValue("350");
		expect(rowMaximum).toHaveValue("1250");
		expect(api.streams[1].perTitleSettings.minBitrate).toBe(350_000);
		expect(api.streams[2].perTitleSettings.maxBitrate).toBe(1_250_000);
		expect(api.streams[0].perTitleSettings.minBitrate).toBeGreaterThan(160_000);
		fireEvent.click(
			screen.getByRole("button", { name: /Reset.*automatic.*2/i }),
		);
		expect(rowMinimum).not.toHaveValue("350");
	});

	it("adjusts an automatic partner when a row slider passes it and retains manual partners", () => {
		show();
		const minimum = screen.getByRole("slider", {
			name: "Minimum bitrate slider (kbps), rendition 2",
		});
		const maximum = screen.getByRole("slider", {
			name: "Maximum bitrate slider (kbps), rendition 2",
		});
		fireEvent.change(minimum, { target: { value: "700" } });
		expect(
			screen.getByRole("spinbutton", {
				name: "Maximum bitrate (kbps), rendition 2",
			}),
		).toHaveValue(700);
		expect(maximum).toHaveAttribute("min", "700");
		fireEvent.change(maximum, { target: { value: "900" } });
		expect(minimum).toHaveAttribute("max", "900");
		fireEvent.keyDown(minimum, { key: "End" });
		expect(
			screen.getByRole("spinbutton", {
				name: "Minimum bitrate (kbps), rendition 2",
			}),
		).toHaveValue(900);
		expect(
			screen.getByRole("spinbutton", {
				name: "Maximum bitrate (kbps), rendition 2",
			}),
		).toHaveValue(900);
	});
	it("represents current limits below the loaded minimum without a keyboard jump", () => {
		show();
		fireEvent.change(
			screen.getByRole("spinbutton", { name: "Minimum bitrate (kbps)" }),
			{ target: { value: "10" } },
		);
		fireEvent.change(
			screen.getByRole("spinbutton", { name: "Maximum bitrate (kbps)" }),
			{ target: { value: "50" } },
		);
		const slider = screen.getByRole("slider", {
			name: "Maximum bitrate slider (kbps)",
		});
		expect(slider).toHaveAttribute("min", "10");
		expect(slider).toHaveValue("50");
		fireEvent.keyDown(slider, { key: "ArrowRight" });
		expect(
			screen.getByRole("spinbutton", { name: "Maximum bitrate (kbps)" }),
		).toHaveValue(51);
	});

	it("keeps the slider domain stable after typing a higher maximum", () => {
		show();
		fireEvent.change(
			screen.getByRole("spinbutton", { name: "Maximum bitrate (kbps)" }),
			{ target: { value: "12000" } },
		);
		const slider = screen.getByRole("slider", {
			name: "Maximum bitrate slider (kbps)",
		});
		expect(slider).toHaveAttribute("max", "12000");
		maximum(9000);
		expect(slider).toHaveAttribute("max", "12000");
		expect(slider).toHaveValue("9000");
	});

	it("recovers both sliders after an invalid maximum is repaired", () => {
		show();
		const field = screen.getByRole("spinbutton", {
			name: "Maximum bitrate (kbps)",
		});
		const minimum = screen.getByRole("slider", {
			name: "Minimum bitrate slider (kbps)",
		});
		const maximum = screen.getByRole("slider", {
			name: "Maximum bitrate slider (kbps)",
		});
		fireEvent.change(field, { target: { value: "3000000" } });
		expect(minimum).toBeDisabled();
		expect(maximum).toBeDisabled();
		expect(field).toHaveValue(3000000);
		fireEvent.change(field, { target: { value: "2400" } });
		expect(minimum).toBeEnabled();
		expect(maximum).toBeEnabled();
		expect(maximum).toHaveAttribute("max", "9600");
	});

	it("inherits displayed ranges when switching to a codec without a saved seed", () => {
		show();
		maximum(4800);
		const before = proposedApi();
		fireEvent.change(screen.getByRole("combobox", { name: "Codec" }), {
			target: { value: "VP9" },
		});
		const after = proposedApi();
		expect(after.global.maxBitrate).toBe(before.global.maxBitrate);
		expect(
			after.streams.map(
				(row: {
					perTitleSettings: { minBitrate: number; maxBitrate: number };
				}) => [
					row.perTitleSettings.minBitrate,
					row.perTitleSettings.maxBitrate,
				],
			),
		).toEqual(
			before.streams.map(
				(row: {
					perTitleSettings: { minBitrate: number; maxBitrate: number };
				}) => [
					row.perTitleSettings.minBitrate,
					row.perTitleSettings.maxBitrate,
				],
			),
		);
		expect(
			after.streams.map((row: { rowId: string }) => row.rowId),
		).not.toEqual(before.streams.map((row: { rowId: string }) => row.rowId));
	});

	it("resets aspect-ratio history when a different codec supplies the same rounded dimensions", () => {
		const tiny: PerTitleGoal = {
			...goal,
			countPolicy: { kind: "exact", count: 1 },
			rows: [
				{
					id: "same",
					height: 9,
					width: 16,
					minBitrate: 160000,
					maxBitrate: 200000,
				},
			],
		};
		renderLocalized(
			<PerTitleSimulator
				open
				initialGoal={automatic(tiny)}
				goalsByCodec={{
					H265: automatic({
						...tiny,
						codec: "H265",
						rows: [{ ...tiny.rows?.[0], id: "same", height: 3, width: 5 }],
					}),
				}}
				onOpenChange={vi.fn()}
				onApply={vi.fn()}
			/>,
		);
		fireEvent.change(
			screen.getByRole("spinbutton", { name: "Height (px), rendition 1" }),
			{ target: { value: "3" } },
		);
		expect(proposedApi().streams[0].width).toBe(5);
		fireEvent.change(screen.getByRole("combobox", { name: "Codec" }), {
			target: { value: "H265" },
		});
		fireEvent.change(
			screen.getByRole("spinbutton", { name: "Height (px), rendition 1" }),
			{ target: { value: "6" } },
		);
		expect(proposedApi().streams[0].width).toBe(10);
	});

	it("recalculates ranges and dependent API parameters from the maximum slider", () => {
		const original = structuredClone(goal);
		const { onApply } = show();
		const first = proposedApi();
		maximum(4800);
		const second = proposedApi();
		expect(
			screen.getByRole("spinbutton", { name: "Maximum bitrate (kbps)" }),
		).toHaveValue(4800);
		expect(
			screen.getByRole("spinbutton", {
				name: "Maximum bitrate (kbps), rendition 2",
			}),
		).not.toHaveValue(480);
		expect(second.global.maxBitrate).toBe(4_800_000);
		expect(second.streams[0].perTitleSettings).not.toEqual(
			first.streams[0].perTitleSettings,
		);
		expect(second.global.fixedResolutionAndBitrateConfiguration).not.toEqual(
			first.global.fixedResolutionAndBitrateConfiguration,
		);
		expect(second.streams.map((row: { rowId: string }) => row.rowId)).toEqual(
			first.streams.map((row: { rowId: string }) => row.rowId),
		);
		maximum(2400);
		expect(proposedApi()).toEqual(first);
		expect(goal).toEqual(original);
		expect(onApply).not.toHaveBeenCalled();
	});

	it("pins an edited bound while other bounds track the slider and supports reset", () => {
		show();
		const min = screen.getByRole("spinbutton", {
			name: "Minimum bitrate (kbps), rendition 2",
		});
		const max = screen.getByRole("spinbutton", {
			name: "Maximum bitrate (kbps), rendition 2",
		});
		fireEvent.change(min, { target: { value: "350" } });
		maximum(4800);
		expect(min).toHaveValue(350);
		expect(max).not.toHaveValue(480);
		fireEvent.click(
			screen.getByRole("button", { name: /Reset.*automatic.*2/i }),
		);
		expect(min).not.toHaveValue(350);
		maximum(2400);
		expect(min).toHaveValue(400);
		expect(max).toHaveValue(480);
	});

	it("keeps an out-of-range manual value visible and prevents review", () => {
		show();
		fireEvent.change(
			screen.getByRole("spinbutton", {
				name: "Maximum bitrate (kbps), rendition 3",
			}),
			{ target: { value: "3000" } },
		);
		expect(
			screen.getByRole("spinbutton", {
				name: "Maximum bitrate (kbps), rendition 3",
			}),
		).toHaveValue(3000);
		expect(
			screen.getByRole("button", { name: "Review changes" }),
		).toBeDisabled();
	});

	it("keeps exact integer limits on the slider and supports useful keyboard steps", () => {
		show({ ...goal, maxBitrate: 2_400_001 });
		const slider = screen.getByRole("slider", {
			name: "Maximum bitrate slider (kbps)",
		});
		expect(slider).toHaveValue("2400.001");
		fireEvent.keyDown(slider, { key: "ArrowRight" });
		expect(
			screen.getByRole("spinbutton", { name: "Maximum bitrate (kbps)" }),
		).toHaveValue(2401.001);
		fireEvent.keyDown(slider, { key: "ArrowLeft" });
		expect(
			screen.getByRole("spinbutton", { name: "Maximum bitrate (kbps)" }),
		).toHaveValue(2400.001);
		fireEvent.change(
			screen.getByRole("spinbutton", { name: "Maximum bitrate (kbps)" }),
			{ target: { value: "" } },
		);
		expect(slider).toBeDisabled();
	});

	it("keeps technical tuning and original template controls out of the form", () => {
		show({
			...goal,
			fixedResolutionAndBitrateConfiguration: {
				forcedRenditionAboveHighestFixedRepresentation: 2,
				forcedRenditionAboveHighestFixedRepresentationFactor: 1.2,
				forcedRenditionAboveHighestFixedRepresentationCalculationMode:
					"LAST_CALCULATED_BITRATE",
			},
		});
		expect(screen.queryByText("Width and bitrate selection")).toBeNull();
		expect(screen.queryByText("Original template settings")).toBeNull();
		expect(
			screen.queryByRole("checkbox", {
				name: "Include original additional-rendition rules",
			}),
		).toBeNull();
		expect(
			screen.queryByRole("combobox", { name: "Bitrate selection mode" }),
		).toBeNull();
	});

	it("proposes missing row ranges and keeps manual bounds separate between codecs", () => {
		renderLocalized(
			<PerTitleSimulator
				open
				initialGoal={automatic(goal)}
				goalsByCodec={{
					H265: automatic({
						...goal,
						codec: "H265",
						rows: goal.rows?.map(
							({ minBitrate: _min, maxBitrate: _max, ...row }) => row,
						),
					}),
				}}
				onOpenChange={vi.fn()}
				onApply={vi.fn()}
			/>,
		);
		const rowMin = () =>
			screen.getByRole("spinbutton", {
				name: "Minimum bitrate (kbps), rendition 2",
			});
		fireEvent.change(rowMin(), { target: { value: "350" } });
		fireEvent.change(screen.getByRole("combobox", { name: "Codec" }), {
			target: { value: "H265" },
		});
		const automaticMinimum = (rowMin() as HTMLInputElement).valueAsNumber;
		expect(automaticMinimum).toBeGreaterThan(100);
		expect(automaticMinimum).toBeLessThan(2400);
		fireEvent.change(rowMin(), { target: { value: "300" } });
		maximum(4800);
		expect(rowMin()).toHaveValue(300);
		fireEvent.change(screen.getByRole("combobox", { name: "Codec" }), {
			target: { value: "H264" },
		});
		expect(rowMin()).toHaveValue(350);
		maximum(4800);
		expect(rowMin()).toHaveValue(350);
		fireEvent.click(
			screen.getByRole("button", { name: /Reset.*automatic.*2/i }),
		);
		expect(rowMin()).not.toHaveValue(350);
		fireEvent.change(screen.getByRole("combobox", { name: "Codec" }), {
			target: { value: "H265" },
		});
		expect(rowMin()).toHaveValue(300);
	});
});
