import { type PerTitleGoal, recommendPerTitleSettings } from "@bitovp/core";
import { fireEvent, screen, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { renderLocalized } from "@/test/render";
import { PerTitleSimulatorRows } from "./per-title-simulator-rows";

const goal: PerTitleGoal = {
	strategy: "fixed-ranges",
	codec: "H264",
	targetQualityCrf: 17,
	minBitrate: 100_000,
	maxBitrate: 4_000_000,
	countPolicy: { kind: "unrestricted" },
	rows: [
		{
			id: "fixed",
			height: 720,
			width: 1280,
			minBitrate: 1_000_000,
			maxBitrate: 2_000_000,
			bitrateSelectionMode: "COMPLEXITY_RANGE",
			lowComplexityBoundaryForMaxBitrate: 2_000_000,
			highComplexityBoundaryForMaxBitrate: 4_000_000,
		},
	],
	automaticTemplates: [{ id: "ordinary", height: 360, width: 640 }],
};

function Editor({ initial = goal }: { initial?: PerTitleGoal }) {
	const [value, setValue] = useState(initial);
	return (
		<>
			<PerTitleSimulatorRows
				id="unified-streams"
				goal={value}
				onChange={setValue}
				manualBounds={{}}
				onBitrateChange={() => {}}
				onResetBitrates={() => {}}
			/>
			<pre data-testid="goal">{JSON.stringify(value)}</pre>
		</>
	);
}

const readGoal = () =>
	JSON.parse(screen.getByTestId("goal").textContent ?? "{}");

describe("explicit Stream modes in the simulator list", () => {
	it.each([
		"en",
		"ja",
	] as const)("keeps one template mode and preserves its optional height hint across mode changes (%s)", (locale) => {
		renderLocalized(
			<Editor
				initial={{
					...goal,
					strategy: "automatic",
					rows: [],
					automaticTemplates: [{ id: "ordinary" }],
				}}
			/>,
			locale,
		);
		const select = screen.getByRole("combobox", {
			name:
				locale === "en"
					? "Stream mode, rendition 1"
					: "Streamモード, レンディション 1",
		});
		const hintLabel =
			locale === "en"
				? "Height hint (px, optional), rendition 1"
				: "高さのヒント (px・任意), レンディション 1";
		expect(screen.getByRole("spinbutton", { name: hintLabel })).toHaveValue(
			null,
		);
		expect(
			within(select)
				.getAllByRole("option")
				.map((option) => option.textContent),
		).toEqual([
			"PER_TITLE_TEMPLATE",
			"PER_TITLE_TEMPLATE_FIXED_RESOLUTION",
			"PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE",
		]);
		fireEvent.change(screen.getByRole("spinbutton", { name: hintLabel }), {
			target: { value: "480" },
		});
		fireEvent.change(select, { target: { value: "fixed-resolution" } });
		fireEvent.change(select, { target: { value: "template" } });
		expect(screen.getByRole("spinbutton", { name: hintLabel })).toHaveValue(
			480,
		);
		expect(readGoal().automaticTemplates).toEqual([
			{ id: "ordinary", height: 480 },
		]);
		expect(readGoal().targetQualityCrf).toBe(17);
		fireEvent.change(screen.getByRole("spinbutton", { name: hintLabel }), {
			target: { value: "" },
		});
		expect(readGoal().automaticTemplates).toEqual([{ id: "ordinary" }]);
	});

	it("preserves legacy fixed-resolution modes when one row changes the overall strategy", () => {
		const initial: PerTitleGoal = {
			...goal,
			strategy: "fixed-resolutions",
			rows: [{ id: "fixed", height: 720, width: 1280 }],
		};
		renderLocalized(<Editor initial={initial} />);
		fireEvent.change(
			screen.getByRole("combobox", { name: "Stream mode, rendition 1" }),
			{ target: { value: "fixed-range" } },
		);
		const value = readGoal();
		expect(value.strategy).toBe("fixed-ranges");
		expect(
			value.rows.find((row: { id: string }) => row.id === "fixed"),
		).toEqual({
			...initial.rows?.[0],
			mode: "PER_TITLE_TEMPLATE_FIXED_RESOLUTION",
		});
		const emitted = recommendPerTitleSettings(value).api.streams.find(
			(row) => row.rowId === "fixed",
		);
		expect(emitted?.mode).toBe("PER_TITLE_TEMPLATE_FIXED_RESOLUTION");
		expect(emitted?.perTitleSettings).toBeUndefined();
	});

	it("seeds a newly selected fixed bitrate band while retaining other rows", () => {
		renderLocalized(<Editor />);
		fireEvent.change(
			screen.getByRole("combobox", { name: "Stream mode, rendition 1" }),
			{ target: { value: "fixed-range" } },
		);
		const value = readGoal();
		const changed = value.rows.find(
			(row: { id: string }) => row.id === "ordinary",
		);
		expect(changed.mode).toBe(
			"PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE",
		);
		expect(changed.minBitrate).toBeGreaterThanOrEqual(value.minBitrate);
		expect(changed.maxBitrate).toBeLessThanOrEqual(value.maxBitrate);
		expect(changed.minBitrate).toBeLessThanOrEqual(changed.maxBitrate);
		expect(
			value.rows.find((row: { id: string }) => row.id === "fixed"),
		).toEqual(goal.rows?.[0]);
		expect(
			recommendPerTitleSettings(value).api.streams.find(
				(row) => row.rowId === "ordinary",
			)?.mode,
		).toBe("PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE");
	});

	it("clears inactive row policies without changing global quality or source dimensions", () => {
		const initial: PerTitleGoal = {
			...goal,
			inputHeight: 1080,
			inputWidth: 1920,
			adjustments: {
				global: { targetQualityCrf: { mode: "fixed" } },
				streams: {
					fixed: { minBitrate: { mode: "fixed" }, height: { mode: "fixed" } },
				},
			},
			settingLocks: {
				global: ["targetQualityCrf"],
				streams: { fixed: ["minBitrate", "height"] },
			},
		};
		renderLocalized(<Editor initial={initial} />);
		fireEvent.change(
			screen.getByRole("combobox", { name: "Stream mode, rendition 2" }),
			{ target: { value: "fixed-resolution" } },
		);
		let value = readGoal();
		expect(value.adjustments.streams.fixed).toEqual({
			height: { mode: "fixed" },
		});
		expect(value.settingLocks.streams.fixed).toEqual(["height"]);
		fireEvent.change(
			screen.getByRole("combobox", { name: "Stream mode, rendition 2" }),
			{ target: { value: "template" } },
		);
		value = readGoal();
		expect(value.adjustments.streams.fixed).toEqual({
			height: { mode: "fixed" },
		});
		expect(value.settingLocks.streams.fixed).toEqual(["height"]);
		expect(value.adjustments.global).toEqual(initial.adjustments?.global);
		expect(value.settingLocks.global).toEqual(initial.settingLocks?.global);
		expect(value.inputHeight).toBe(1080);
		expect(value.inputWidth).toBe(1920);
		expect(value.targetQualityCrf).toBe(17);
		const emitted = recommendPerTitleSettings(value).api.streams.find(
			(row) => row.rowId === "fixed",
		);
		expect(emitted).toEqual({
			rowId: "fixed",
			mode: "PER_TITLE_TEMPLATE",
			height: 720,
			width: 1280,
		});
	});

	it.each([
		"en",
		"ja",
	] as const)("uses one add action and a mode selector on every row (%s)", (locale) => {
		renderLocalized(<Editor />, locale);
		const section = screen.getByRole("region", {
			name: locale === "en" ? "Renditions" : "レンディション",
		});
		expect(within(section).getAllByRole("list")).toHaveLength(1);
		expect(within(section).getAllByRole("combobox")).toHaveLength(2);
		expect(
			within(section).getAllByRole("button", {
				name: locale === "en" ? /Add/ : /追加/,
			}),
		).toHaveLength(1);
		expect(
			within(section).queryByText(locale === "en" ? "Automatic" : "自動", {
				exact: true,
			}),
		).toBeNull();
	});

	it("changes Stream modes while retaining hints until explicitly cleared", () => {
		renderLocalized(<Editor />);
		const select = () =>
			screen.getByRole("combobox", { name: "Stream mode, rendition 2" });
		fireEvent.change(select(), { target: { value: "fixed-resolution" } });
		let value = readGoal();
		expect(value.rows).toEqual([
			{
				id: "fixed",
				height: 720,
				width: 1280,
				mode: "PER_TITLE_TEMPLATE_FIXED_RESOLUTION",
			},
		]);
		expect(value.targetQualityCrf).toBe(17);
		expect(
			screen.queryByRole("spinbutton", {
				name: "Minimum bitrate (kbps), rendition 2",
			}),
		).toBeNull();
		fireEvent.change(select(), { target: { value: "template" } });
		value = readGoal();
		expect(value.rows).toEqual([]);
		expect(
			value.automaticTemplates.find(
				(row: { id: string }) => row.id === "fixed",
			),
		).toEqual({ id: "fixed", height: 720, width: 1280 });
		fireEvent.change(
			screen.getByRole("spinbutton", {
				name: "Height hint (px, optional), rendition 2",
			}),
			{ target: { value: "" } },
		);
		value = readGoal();
		expect(
			value.automaticTemplates.find(
				(row: { id: string }) => row.id === "fixed",
			),
		).toEqual({ id: "fixed" });
		expect(
			screen.queryByRole("spinbutton", { name: "Height (px), rendition 2" }),
		).toBeNull();
		expect(
			screen.getByRole("spinbutton", {
				name: "Height hint (px, optional), rendition 2",
			}),
		).toHaveValue(null);
	});

	it("keeps an imported width-only ordinary template dimensioned until explicitly cleared", () => {
		renderLocalized(
			<Editor
				initial={{
					...goal,
					rows: [],
					automaticTemplates: [{ id: "width-only", width: 1280 }],
				}}
			/>,
		);
		const select = screen.getByRole("combobox", {
			name: "Stream mode, rendition 1",
		});
		expect(select).toHaveValue("template");
		expect(readGoal().automaticTemplates).toEqual([
			{ id: "width-only", width: 1280 },
		]);
		const hint = screen.getByRole("spinbutton", {
			name: "Width hint (px, optional), rendition 1",
		});
		expect(hint).toHaveValue(1280);
		fireEvent.change(hint, { target: { value: "1920" } });
		expect(readGoal().automaticTemplates).toEqual([
			{ id: "width-only", width: 1920 },
		]);
		fireEvent.change(hint, { target: { value: "" } });
		expect(readGoal().automaticTemplates).toEqual([{ id: "width-only" }]);
	});

	it.each([
		"automatic",
		"count",
	] as const)("keeps ordinary streams editable in %s mode", (strategy) => {
		renderLocalized(
			<Editor
				initial={{
					...goal,
					strategy,
					rows: [],
					automaticTemplates: [{ id: "ordinary" }],
				}}
			/>,
		);
		expect(
			screen.getByRole("combobox", { name: "Stream mode, rendition 1" }),
		).toHaveValue("template");
	});
});
