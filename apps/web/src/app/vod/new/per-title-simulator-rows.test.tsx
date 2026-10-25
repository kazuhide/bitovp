import { type PerTitleGoal, recommendPerTitleSettings } from "@bitovp/core";
import { fireEvent, screen, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderLocalized } from "@/test/render";
import { autoTunePerTitleGoal } from "./per-title-simulator-auto";
import { PerTitleSimulatorRows } from "./per-title-simulator-rows";
import {
	getPerTitleAdjustment,
	tunePerTitleSettings,
} from "./per-title-simulator-tuning";

const goal: PerTitleGoal = {
	strategy: "fixed-ranges",
	codec: "H264",
	minBitrate: 100000,
	maxBitrate: 2000000,
	countPolicy: { kind: "exact", count: 2 },
	rows: [
		{
			id: "required",
			height: 360,
			width: 640,
			minBitrate: 100000,
			maxBitrate: 400000,
			bitrateSelectionMode: "COMPLEXITY_RANGE",
			lowComplexityBoundaryForMaxBitrate: 600000,
			highComplexityBoundaryForMaxBitrate: 1800000,
		},
	],
	automaticTemplates: [
		{
			id: "candidate",
			height: 720,
			width: 1280,
			minBitrate: 200000,
			maxBitrate: 900000,
			bitrateSelectionMode: "OPTIMIZED",
		},
	],
};
const callbacks = () => ({
	onChange: vi.fn(),
	onBitrateChange: vi.fn(),
	onResetBitrates: vi.fn(),
});

describe("Unified Per-Title rendition inputs", () => {
	it.each([
		false,
		true,
	])("seeds only a newly added fixed-range row once, preserving existing unset limits (%s)", (missingExistingMinimum) => {
		const initial: PerTitleGoal = {
			...goal,
			minBitrateStepSize: 1.2,
			maxBitrateStepSize: 4,
			countPolicy: { kind: "unrestricted" },
			rows: goal.rows?.map((row) => ({
				...row,
				...(missingExistingMinimum ? { minBitrate: undefined } : {}),
			})),
		};
		const snapshot = structuredClone(initial);
		const events = callbacks();
		renderLocalized(
			<PerTitleSimulatorRows
				id="fixed-add"
				goal={initial}
				manualBounds={{}}
				{...events}
				tuning={{
					draft: initial,
					anchor: initial,
					proposal: tunePerTitleSettings(initial, initial).proposal,
					onChange: events.onChange,
				}}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "Add rendition" }));
		const next = events.onChange.mock.lastCall?.[0] as PerTitleGoal;
		const added = next.rows?.at(-1);
		if (!added) throw new Error("Missing added rendition");
		expect(added.minBitrate).toBeTypeOf("number");
		expect(added.maxBitrate).toBeTypeOf("number");
		expect(added.minBitrate).toBeGreaterThanOrEqual(initial.minBitrate);
		expect(added.maxBitrate).toBeLessThanOrEqual(initial.maxBitrate);
		expect(added.minBitrate).toBeLessThanOrEqual(added.maxBitrate ?? 0);
		expect(next.rows?.slice(0, -1)).toEqual(initial.rows);
		expect(next.automaticTemplates).toEqual(initial.automaticTemplates);
		expect(next.minBitrateStepSize).toBe(1.2);
		expect(next.maxBitrateStepSize).toBe(4);
		for (const key of ["minBitrate", "maxBitrate"])
			expect(
				getPerTitleAdjustment(next, initial, "stream", key, added.id),
			).toEqual({ mode: "fixed" });
		const changed = tunePerTitleSettings(
			{ ...next, maxBitrate: 4_000_000 },
			initial,
		);
		expect(changed.goal.rows).toEqual(next.rows);
		expect(initial).toEqual(snapshot);
	});

	it("does not invent initial row bounds while the global range is invalid", () => {
		const initial = { ...goal, maxBitrate: Number.NaN };
		const events = callbacks();
		renderLocalized(
			<PerTitleSimulatorRows
				id="invalid-add"
				goal={initial}
				manualBounds={{}}
				{...events}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "Add rendition" }));
		const next = events.onChange.mock.lastCall?.[0] as PerTitleGoal;
		expect(next.rows?.slice(0, -1)).toEqual(initial.rows);
		expect(next.rows?.at(-1)?.minBitrate).toBeUndefined();
		expect(next.rows?.at(-1)?.maxBitrate).toBeUndefined();
		expect(next.maxBitrate).toBeNaN();
	});

	it("removes a deleted row's fixed-setting policies while preserving a feasible remaining ladder", () => {
		const initial: PerTitleGoal = {
			...goal,
			maxBitrate: 2400000,
			countPolicy: { kind: "unrestricted" },
			automaticTemplates: [],
			adjustments: {
				global: {
					minBitrateStepSize: { mode: "auto", method: "constraints" },
					maxBitrateStepSize: { mode: "auto", method: "constraints" },
				},
				streams: Object.fromEntries(
					["a", "b", "c"].map((id) => [
						id,
						{
							bitrateSelectionMode: { mode: "auto", method: "constraints" },
							lowComplexityBoundaryForMaxBitrate: {
								mode: "auto",
								method: "constraints",
							},
							highComplexityBoundaryForMaxBitrate: {
								mode: "auto",
								method: "constraints",
							},
						},
					]),
				),
			},
			rows: [
				{ id: "a", height: 240, minBitrate: 160000, maxBitrate: 200000 },
				{ id: "b", height: 480, minBitrate: 400000, maxBitrate: 480000 },
				{ id: "c", height: 720, minBitrate: 1000000, maxBitrate: 1200000 },
			],
		};
		const onChange = vi.fn();
		function Controlled() {
			const [draft, setDraft] = useState(initial);
			const tuned = tunePerTitleSettings(draft, initial);
			const change = (next: PerTitleGoal) => {
				onChange(next);
				setDraft(next);
			};
			return (
				<PerTitleSimulatorRows
					id="tuned"
					goal={tuned.goal}
					onChange={change}
					manualBounds={{}}
					onBitrateChange={vi.fn()}
					onResetBitrates={vi.fn()}
					tuning={{
						draft,
						anchor: initial,
						proposal: tuned.proposal,
						onChange: change,
					}}
				/>
			);
		}
		renderLocalized(<Controlled />);
		const first = screen.getByRole("listitem", { name: "Rendition 1" });
		fireEvent.click(within(first).getByText("Per-Title settings"));
		fireEvent.change(
			within(first).getByRole("spinbutton", {
				name: "Codec maximum bitrate factor, rendition 1",
			}),
			{ target: { value: "1.3" } },
		);
		expect(
			onChange.mock.lastCall?.[0].adjustments.streams.a.codecMaxBitrateFactor,
		).toEqual({ mode: "fixed" });
		fireEvent.click(
			within(first).getByRole("button", { name: "Remove rendition 1" }),
		);
		const next = onChange.mock.lastCall?.[0] as PerTitleGoal;
		expect(next.rows?.map((row) => row.id)).toEqual(["b", "c"]);
		expect(next.adjustments?.streams?.a).toBeUndefined();
		expect(next.settingLocks?.streams?.a).toBeUndefined();
		const remaining = tunePerTitleSettings(next, initial).proposal;
		expect(
			remaining.diagnostics.some((item) => item.code === "invalid-setting"),
		).toBe(false);
		expect(remaining.applicable).toBe(true);
	});

	it.each([
		"en",
		"ja",
	] as const)("offers labelled required-bound sliders over global limits (%s)", (locale) => {
		const events = callbacks();
		renderLocalized(
			<PerTitleSimulatorRows
				id="rows"
				goal={goal}
				manualBounds={{}}
				{...events}
			/>,
			locale,
		);
		const minimum = screen.getByRole("slider", {
			name:
				locale === "en"
					? "Minimum bitrate slider (kbps), rendition 1"
					: "最小ビットレートのスライダー (kbps), レンディション 1",
		});
		const maximum = screen.getByRole("slider", {
			name:
				locale === "en"
					? "Maximum bitrate slider (kbps), rendition 1"
					: "最大ビットレートのスライダー (kbps), レンディション 1",
		});
		for (const slider of [minimum, maximum]) {
			expect(slider).toHaveAttribute("min", "100");
			expect(slider).toHaveAttribute("max", "2000");
			expect(slider).toBeEnabled();
		}
		expect(screen.getAllByRole("slider")).toHaveLength(2);
		fireEvent.change(minimum, { target: { value: "650" } });
		expect(events.onBitrateChange).toHaveBeenLastCalledWith(
			"required",
			"min",
			650000,
		);
		fireEvent.change(maximum, { target: { value: "300" } });
		expect(events.onBitrateChange).toHaveBeenLastCalledWith(
			"required",
			"max",
			300000,
		);
		expect(events.onChange).not.toHaveBeenCalled();
	});
	it("restricts a slider only by a valid, manually pinned opposite endpoint", () => {
		const events = callbacks();
		const { rerender } = renderLocalized(
			<PerTitleSimulatorRows
				id="rows"
				goal={goal}
				manualBounds={{ required: { max: true } }}
				{...events}
			/>,
		);
		const min = () =>
			screen.getByRole("slider", {
				name: "Minimum bitrate slider (kbps), rendition 1",
			});
		const max = () =>
			screen.getByRole("slider", {
				name: "Maximum bitrate slider (kbps), rendition 1",
			});
		expect(min()).toHaveAttribute("max", "400");
		expect(max()).toHaveAttribute("min", "100");
		rerender(
			<PerTitleSimulatorRows
				id="rows"
				goal={{
					...goal,
					rows: goal.rows?.map((row) => ({ ...row, minBitrate: 250000 })),
				}}
				manualBounds={{ required: { min: true } }}
				{...events}
			/>,
		);
		expect(max()).toHaveAttribute("min", "250");
		expect(min()).toHaveAttribute("max", "2000");
	});
	it("keeps invalid or crossed manual values visible instead of correcting them through sliders", () => {
		const events = callbacks();
		const invalid = {
			...goal,
			rows: goal.rows?.map((row) => ({
				...row,
				minBitrate: 900000,
				maxBitrate: 400000,
			})),
		};
		const { rerender } = renderLocalized(
			<PerTitleSimulatorRows
				id="rows"
				goal={invalid}
				manualBounds={{ required: { min: true, max: true } }}
				{...events}
			/>,
		);
		for (const slider of screen.getAllByRole("slider"))
			expect(slider).toBeDisabled();
		expect(
			screen.getByRole("spinbutton", {
				name: "Minimum bitrate (kbps), rendition 1",
			}),
		).toHaveValue(900);
		expect(
			screen.getByRole("spinbutton", {
				name: "Maximum bitrate (kbps), rendition 1",
			}),
		).toHaveValue(400);
		const outside = {
			...goal,
			rows: goal.rows?.map((row) => ({ ...row, maxBitrate: 3000000 })),
		};
		rerender(
			<PerTitleSimulatorRows
				id="rows"
				goal={outside}
				manualBounds={{ required: { max: true } }}
				{...events}
			/>,
		);
		expect(
			screen.getByRole("slider", {
				name: "Maximum bitrate slider (kbps), rendition 1",
			}),
		).toBeDisabled();
		expect(
			screen.getByRole("slider", {
				name: "Minimum bitrate slider (kbps), rendition 1",
			}),
		).toHaveAttribute("max", "2000");
		expect(
			screen.getByRole("spinbutton", {
				name: "Maximum bitrate (kbps), rendition 1",
			}),
		).toHaveValue(3000);
		expect(events.onBitrateChange).not.toHaveBeenCalled();
	});
	it("disables both sliders for invalid global limits without disabling numeric repairs", () => {
		const events = callbacks();
		const { rerender } = renderLocalized(
			<PerTitleSimulatorRows
				id="rows"
				goal={goal}
				manualBounds={{}}
				{...events}
			/>,
		);
		for (const limits of [
			{ minBitrate: NaN, maxBitrate: 2000000 },
			{ minBitrate: 2000000, maxBitrate: 100000 },
			{ minBitrate: 100000, maxBitrate: 2147483648 },
		]) {
			rerender(
				<PerTitleSimulatorRows
					id="rows"
					goal={{ ...goal, ...limits }}
					manualBounds={{}}
					{...events}
				/>,
			);
			for (const slider of screen.getAllByRole("slider"))
				expect(slider).toBeDisabled();
			expect(
				screen.getByRole("spinbutton", {
					name: "Minimum bitrate (kbps), rendition 1",
				}),
			).toBeEnabled();
		}
		expect(events.onBitrateChange).not.toHaveBeenCalled();
	});
	it("lets an edited slider cross an automatic counterpart and resets both through the existing adapter", () => {
		const edits = vi.fn();
		function Controlled() {
			const [raw, setRaw] = useState(goal);
			const [manual, setManual] = useState<
				Record<string, { min?: boolean; max?: boolean }>
			>({});
			const effective = autoTunePerTitleGoal(raw, goal, manual);
			return (
				<PerTitleSimulatorRows
					id="rows"
					goal={effective}
					manualBounds={manual}
					onChange={setRaw}
					onBitrateChange={(id, bound, value) => {
						edits(id, bound, value);
						setRaw((current) => ({
							...current,
							rows: current.rows?.map((row) =>
								row.id === id
									? {
											...row,
											[bound === "min" ? "minBitrate" : "maxBitrate"]: value,
										}
									: row,
							),
						}));
						setManual((current) => ({
							...current,
							[id]: { ...current[id], [bound]: true },
						}));
					}}
					onResetBitrates={(id) =>
						setManual((current) => {
							const next = { ...current };
							delete next[id];
							return next;
						})
					}
				/>
			);
		}
		renderLocalized(<Controlled />);
		fireEvent.change(
			screen.getByRole("slider", {
				name: "Minimum bitrate slider (kbps), rendition 1",
			}),
			{ target: { value: "650" } },
		);
		expect(edits).toHaveBeenCalledExactlyOnceWith("required", "min", 650000);
		expect(
			screen.getByRole("spinbutton", {
				name: "Minimum bitrate (kbps), rendition 1",
			}),
		).toHaveValue(650);
		expect(
			screen.getByRole("spinbutton", {
				name: "Maximum bitrate (kbps), rendition 1",
			}),
		).toHaveValue(650);
		expect(screen.getByText("Min Manual")).toBeVisible();
		expect(screen.getByText("Max Auto")).toBeVisible();
		expect(
			screen.getByRole("slider", {
				name: "Maximum bitrate slider (kbps), rendition 1",
			}),
		).toHaveAttribute("min", "650");
		fireEvent.click(
			screen.getByRole("button", { name: "Reset to automatic, rendition 1" }),
		);
		expect(
			screen.getByRole("spinbutton", {
				name: "Minimum bitrate (kbps), rendition 1",
			}),
		).toHaveValue(100);
		expect(
			screen.getByRole("spinbutton", {
				name: "Maximum bitrate (kbps), rendition 1",
			}),
		).toHaveValue(400);
		expect(edits).toHaveBeenCalledTimes(1);
	});
	it.each([
		"en",
		"ja",
	] as const)("shares one compact list and keeps automatic templates free of bitrate controls (%s)", (locale) => {
		const events = callbacks();
		renderLocalized(
			<PerTitleSimulatorRows
				id="rows"
				goal={goal}
				manualBounds={{}}
				{...events}
			/>,
			locale,
		);
		const section = screen.getByRole("region", {
			name: locale === "en" ? "Renditions" : "レンディション",
		});
		expect(within(section).getAllByRole("list")).toHaveLength(1);
		expect(within(section).getAllByRole("listitem")).toHaveLength(2);
		expect(within(section).getAllByRole("spinbutton")).toHaveLength(4);
		expect(within(section).getAllByRole("combobox")).toHaveLength(2);
		expect(
			within(section).getByRole("combobox", {
				name:
					locale === "en"
						? "Stream mode, rendition 1"
						: "Streamモード, レンディション 1",
			}),
		).toHaveValue("fixed-range");
		expect(
			within(section).getByRole("combobox", {
				name:
					locale === "en"
						? "Stream mode, rendition 2"
						: "Streamモード, レンディション 2",
			}),
		).toHaveValue("template-resolution");
		expect(
			within(section).getByText(locale === "en" ? "Min Auto" : "下限 自動"),
		).toBeVisible();
		expect(screen.queryByLabelText(/Width|幅|Complexity|複雑度/)).toBeNull();
		expect(events.onChange).not.toHaveBeenCalled();
	});
	it("routes manual edits and reset through their callbacks without changing structure", () => {
		const events = callbacks();
		renderLocalized(
			<PerTitleSimulatorRows
				id="rows"
				goal={goal}
				manualBounds={{ required: { min: true } }}
				{...events}
			/>,
		);
		expect(screen.getByText("Min Manual")).toBeVisible();
		expect(screen.getByText("Max Auto")).toBeVisible();
		fireEvent.change(
			screen.getByRole("spinbutton", {
				name: "Minimum bitrate (kbps), rendition 1",
			}),
			{ target: { value: "150" } },
		);
		expect(events.onBitrateChange).toHaveBeenLastCalledWith(
			"required",
			"min",
			150000,
		);
		fireEvent.change(
			screen.getByRole("spinbutton", {
				name: "Maximum bitrate (kbps), rendition 1",
			}),
			{ target: { value: "" } },
		);
		expect(events.onBitrateChange).toHaveBeenLastCalledWith(
			"required",
			"max",
			NaN,
		);
		fireEvent.click(
			screen.getByRole("button", { name: "Reset to automatic, rendition 1" }),
		);
		expect(events.onResetBitrates).toHaveBeenCalledExactlyOnceWith("required");
		expect(events.onChange).not.toHaveBeenCalled();
	});
	it("keeps required and automatic metadata when changing height or removing a row", () => {
		const events = callbacks();
		const before = structuredClone(goal);
		renderLocalized(
			<PerTitleSimulatorRows
				id="rows"
				goal={goal}
				manualBounds={{}}
				{...events}
			/>,
		);
		expect(
			screen.queryByRole("button", { name: /Reset to automatic/ }),
		).toBeNull();
		fireEvent.change(
			screen.getByRole("spinbutton", { name: "Height (px), rendition 1" }),
			{ target: { value: "480" } },
		);
		expect(events.onChange.mock.lastCall?.[0]).toEqual({
			...goal,
			rows: [{ ...goal.rows?.[0], height: 480, width: 853 }],
		});
		fireEvent.change(
			screen.getByRole("spinbutton", {
				name: "Height (px, optional), rendition 2",
			}),
			{ target: { value: "" } },
		);
		expect(events.onChange.mock.lastCall?.[0]).toEqual({
			...goal,
			automaticTemplates: [
				{ ...goal.automaticTemplates?.[0], height: undefined },
			],
		});
		fireEvent.click(screen.getByRole("button", { name: "Remove rendition 1" }));
		expect(events.onChange.mock.lastCall?.[0]).toEqual({
			...goal,
			strategy: "count",
			rows: [],
		});
		fireEvent.click(screen.getByRole("button", { name: "Remove rendition 2" }));
		expect(events.onChange.mock.lastCall?.[0]).toEqual({
			...goal,
			automaticTemplates: [],
		});
		expect(goal).toEqual(before);
	});
	it("reserves IDs across both types and adds candidates without forcing a resolution", () => {
		const events = callbacks();
		const { rerender } = renderLocalized(
			<PerTitleSimulatorRows
				id="rows"
				goal={goal}
				manualBounds={{}}
				{...events}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "Add rendition" }));
		const next = events.onChange.mock.lastCall?.[0] as PerTitleGoal;
		const addedId = next.rows?.at(-1)?.id;
		if (!addedId) throw new Error("Missing generated row ID");
		const reservedId = addedId.replace(/-new-\d+$/, "-new-2");
		expect(next.automaticTemplates).toEqual(goal.automaticTemplates);
		rerender(
			<PerTitleSimulatorRows
				id="rows"
				goal={{
					...next,
					automaticTemplates: [
						...(next.automaticTemplates ?? []),
						{ id: reservedId },
					],
				}}
				manualBounds={{}}
				{...events}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "Add rendition" }));
		const added = events.onChange.mock.lastCall?.[0] as PerTitleGoal;
		expect(added.automaticTemplates).toEqual([
			...(goal.automaticTemplates ?? []),
			{ id: reservedId },
		]);
		expect(added.rows?.slice(0, -1)).toEqual(next.rows);
		expect(added.rows?.at(-1)?.id).toBe(addedId.replace(/-new-\d+$/, "-new-3"));
		const ids = [
			...(added.rows ?? []),
			...(added.automaticTemplates ?? []),
		].map((row) => row.id);
		expect(new Set(ids).size).toBe(5);
	});
	it("does not reuse a retired generated row ID after a strategy remount", () => {
		const events = callbacks();
		const { rerender } = renderLocalized(
			<PerTitleSimulatorRows
				id="rows"
				goal={goal}
				manualBounds={{}}
				{...events}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "Add rendition" }));
		const retired = events.onChange.mock.lastCall?.[0].rows.at(-1).id;
		rerender(
			<PerTitleSimulatorRows
				key="remounted"
				id="rows"
				goal={goal}
				manualBounds={{}}
				{...events}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "Add rendition" }));
		expect(events.onChange.mock.lastCall?.[0].rows.at(-1).id).not.toBe(retired);
	});
	it("interleaves required and automatic rows by height without changing source indices or same-height order", () => {
		const events = callbacks();
		const mixed: PerTitleGoal = {
			...goal,
			strategy: "fixed-resolutions",
			rows: [
				{ id: "high", height: 720, width: 1280 },
				{ id: "same-first", height: 360 },
				{ id: "same-second", height: 360 },
			],
			automaticTemplates: [
				{ id: "auto-low", height: 180 },
				{ id: "auto-same", height: 360 },
				{ id: "auto-unspecified" },
			],
		};
		renderLocalized(
			<PerTitleSimulatorRows
				id="rows"
				goal={mixed}
				manualBounds={{}}
				{...events}
			/>,
		);
		expect(
			screen
				.getAllByRole("listitem")
				.map((row) => row.getAttribute("aria-label")),
		).toEqual([
			"Rendition 1",
			"Rendition 2",
			"Rendition 3",
			"Rendition 4",
			"Rendition 5",
			"Rendition 6",
		]);
		fireEvent.change(
			screen.getByRole("spinbutton", { name: "Height (px), rendition 5" }),
			{ target: { value: "540" } },
		);
		expect(events.onChange.mock.lastCall?.[0].rows).toEqual([
			{ id: "high", height: 540, width: 960 },
			{ id: "same-first", height: 360 },
			{ id: "same-second", height: 360 },
		]);
	});
	it("rescales known widths with height while retaining inactive metadata and leaving unspecified widths alone", () => {
		const events = callbacks();
		const sized: PerTitleGoal = {
			...goal,
			rows: [
				{ ...goal.rows?.[0], id: "sized", height: 720, width: 1280 },
				{ id: "derive-width", height: 180 },
			],
		};
		const { rerender } = renderLocalized(
			<PerTitleSimulatorRows
				id="rows"
				goal={sized}
				manualBounds={{}}
				{...events}
			/>,
		);
		fireEvent.change(
			screen.getByRole("spinbutton", { name: "Height (px), rendition 2" }),
			{ target: { value: "360" } },
		);
		expect(events.onChange.mock.lastCall?.[0].rows[0]).toEqual({
			...sized.rows?.[0],
			height: 360,
			width: 640,
		});
		fireEvent.change(
			screen.getByRole("spinbutton", {
				name: "Height (px, optional), rendition 3",
			}),
			{ target: { value: "360" } },
		);
		expect(events.onChange.mock.lastCall?.[0].automaticTemplates).toEqual([
			{ ...goal.automaticTemplates?.[0], height: 360, width: 640 },
		]);
		fireEvent.change(
			screen.getByRole("spinbutton", { name: "Height (px), rendition 1" }),
			{ target: { value: "360" } },
		);
		expect(events.onChange.mock.lastCall?.[0].rows[1]).toEqual({
			id: "derive-width",
			height: 360,
		});
		fireEvent.change(
			screen.getByRole("spinbutton", { name: "Height (px), rendition 2" }),
			{ target: { value: "" } },
		);
		expect(events.onChange.mock.lastCall?.[0].rows[0]).toEqual({
			...sized.rows?.[0],
			height: NaN,
		});
		rerender(
			<PerTitleSimulatorRows
				id="rows"
				goal={{ ...sized, rows: [{ id: "odd", height: 360, width: 641 }] }}
				manualBounds={{}}
				{...events}
			/>,
		);
		fireEvent.change(
			screen.getByRole("spinbutton", { name: "Height (px), rendition 2" }),
			{ target: { value: "360.0" } },
		);
		expect(events.onChange.mock.lastCall?.[0].rows[0]).toEqual({
			id: "odd",
			height: 360,
			width: 641,
		});
	});
	it("keeps the source aspect ratio through controlled clearing and typing, and refreshes it for replaced dimensions", () => {
		const events = callbacks();
		const sized: PerTitleGoal = {
			...goal,
			rows: [{ ...goal.rows?.[0], id: "sized", height: 720, width: 1280 }],
		};
		function Controlled() {
			const [current, setCurrent] = useState(sized);
			return (
				<>
					<PerTitleSimulatorRows
						id="rows"
						goal={current}
						manualBounds={{}}
						{...events}
						onChange={(next) => {
							events.onChange(next);
							setCurrent(next);
						}}
					/>
					<button
						type="button"
						onClick={() =>
							setCurrent({
								...sized,
								rows: [
									{ ...sized.rows?.[0], id: "sized", height: 720, width: 1440 },
								],
							})
						}
					>
						Replace dimensions
					</button>
				</>
			);
		}
		renderLocalized(<Controlled />);
		const change = (name: string) => {
			for (const value of ["", "3", "36", "360"])
				fireEvent.change(screen.getByRole("spinbutton", { name }), {
					target: { value },
				});
		};
		change("Height (px), rendition 1");
		expect(events.onChange.mock.lastCall?.[0].rows[0]).toEqual({
			...sized.rows?.[0],
			height: 360,
			width: 640,
		});
		change("Height (px, optional), rendition 2");
		expect(events.onChange.mock.lastCall?.[0].automaticTemplates).toEqual([
			{ ...goal.automaticTemplates?.[0], height: 360, width: 640 },
		]);
		fireEvent.click(screen.getByRole("button", { name: "Replace dimensions" }));
		change("Height (px), rendition 1");
		expect(events.onChange.mock.lastCall?.[0].rows[0]).toEqual({
			...sized.rows?.[0],
			height: 360,
			width: 720,
		});
	});
	it("infers the added required row width in the controlled tuning flow without creating mixed-width ordering", () => {
		const events = callbacks();
		const sized: PerTitleGoal = {
			...goal,
			countPolicy: { kind: "unrestricted" },
			maxBitrate: 2400000,
			rows: [
				{
					id: "small",
					width: 400,
					height: 240,
					minBitrate: 160000,
					maxBitrate: 200000,
				},
				{
					id: "medium",
					width: 800,
					height: 480,
					minBitrate: 400000,
					maxBitrate: 480000,
				},
			],
			automaticTemplates: [],
		};
		function Controlled() {
			const [current, setCurrent] = useState(sized);
			return (
				<PerTitleSimulatorRows
					id="rows"
					goal={current}
					manualBounds={{}}
					{...events}
					onChange={(next) => {
						const tuned = autoTunePerTitleGoal(next, sized, {});
						events.onChange(tuned);
						setCurrent(tuned);
					}}
				/>
			);
		}
		renderLocalized(<Controlled />);
		fireEvent.click(screen.getByRole("button", { name: "Add rendition" }));
		const next = events.onChange.mock.lastCall?.[0] as PerTitleGoal;
		expect(next.rows?.at(-1)).toMatchObject({ height: 720, width: 1200 });
		expect(next.rows?.slice(0, 2)).toEqual(sized.rows);
		expect(new Set(next.rows?.map((row) => row.width)).size).toBe(3);
		for (const row of next.rows ?? []) {
			expect(row.minBitrate).toBeGreaterThanOrEqual(next.minBitrate);
			expect(row.maxBitrate).toBeGreaterThanOrEqual(row.minBitrate ?? 0);
			expect(row.maxBitrate).toBeLessThanOrEqual(next.maxBitrate);
		}
		expect(
			recommendPerTitleSettings(next).diagnostics.some(
				(item) => item.code === "row-order-unknown",
			),
		).toBe(false);
	});
	it.each([
		{
			name: "consistent source dimensions",
			widths: [401, 801],
			inputWidth: 400,
			inputHeight: 240,
			expected: 1200,
		},
		{
			name: "inconsistent source dimensions",
			widths: [400, 800],
			inputWidth: 1920,
			inputHeight: 1080,
			expected: 1200,
		},
		{ name: "one-pixel explicit rounding", widths: [400, 801], expected: 1200 },
		{
			name: "inconsistent explicit ratios",
			widths: [400, 960],
			expected: undefined,
		},
		{
			name: "omitted explicit widths",
			widths: [undefined, undefined],
			inputWidth: 1920,
			inputHeight: 1080,
			expected: undefined,
		},
	])("uses only reliable geometry for an added required row: $name", ({
		widths,
		inputWidth,
		inputHeight,
		expected,
	}) => {
		const events = callbacks();
		const original: PerTitleGoal = {
			...goal,
			inputWidth,
			inputHeight,
			rows: [
				{
					id: "small",
					height: 240,
					...(widths[0] === undefined ? {} : { width: widths[0] }),
				},
				{
					id: "medium",
					height: 480,
					...(widths[1] === undefined ? {} : { width: widths[1] }),
				},
			],
		};
		const before = structuredClone(original);
		renderLocalized(
			<PerTitleSimulatorRows
				id="rows"
				goal={original}
				manualBounds={{}}
				{...events}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "Add rendition" }));
		const next = events.onChange.mock.lastCall?.[0] as PerTitleGoal;
		expect(next.rows?.at(-1)?.width).toBe(expected);
		expect(next.rows?.slice(0, 2)).toEqual(original.rows);
		expect(next.automaticTemplates).toEqual(original.automaticTemplates);
		expect(original).toEqual(before);
	});
	it("enforces the combined template limit for the unified add action", () => {
		const events = callbacks();
		const full: PerTitleGoal = {
			...goal,
			automaticTemplates: Array.from({ length: 63 }, (_, index) => ({
				id: `candidate-${index}`,
			})),
		};
		renderLocalized(
			<PerTitleSimulatorRows
				id="rows"
				goal={full}
				manualBounds={{}}
				{...events}
			/>,
		);
		for (const name of ["Add rendition"]) {
			const button = screen.getByRole("button", { name });
			expect(button).toBeDisabled();
			fireEvent.click(button);
		}
		expect(events.onChange).not.toHaveBeenCalled();
	});
	it.each([
		"automatic",
		"count",
	] as const)("shows editable ordinary rows without activating parked required rows for %s", (strategy) => {
		const events = callbacks();
		const { container } = renderLocalized(
			<PerTitleSimulatorRows
				id="rows"
				goal={{ ...goal, strategy }}
				manualBounds={{}}
				{...events}
			/>,
		);
		expect(within(container).getAllByRole("listitem")).toHaveLength(1);
		expect(
			within(container).getByRole("combobox", {
				name: "Stream mode, rendition 1",
			}),
		).toHaveValue("template-resolution");
		expect(
			within(container).queryByRole("spinbutton", {
				name: "Height (px), rendition 1",
			}),
		).toBeNull();
		expect(events.onChange).not.toHaveBeenCalled();
	});
	it("preserves parked bitrate metadata without displaying it in a resolution-only strategy", () => {
		const events = callbacks();
		renderLocalized(
			<PerTitleSimulatorRows
				id="rows"
				goal={{ ...goal, strategy: "fixed-resolutions" }}
				manualBounds={{ required: { min: true } }}
				{...events}
			/>,
		);
		expect(screen.getAllByRole("spinbutton")).toHaveLength(2);
		expect(
			screen.queryByRole("button", { name: /Reset to automatic/ }),
		).toBeNull();
		fireEvent.change(
			screen.getByRole("spinbutton", { name: "Height (px), rendition 1" }),
			{ target: { value: "540" } },
		);
		expect(events.onChange.mock.lastCall?.[0].rows).toEqual([
			{ ...goal.rows?.[0], height: 540, width: 960 },
		]);
	});
});
