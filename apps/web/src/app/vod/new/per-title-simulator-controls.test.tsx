import type { PerTitleGoal } from "@bitovp/core";
import { fireEvent, screen, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { renderLocalized } from "@/test/render";
import {
	PerTitleGlobalControls,
	PerTitleSettingControl,
	PerTitleStreamControls,
} from "./per-title-simulator-controls";
import {
	initializePerTitleSettings,
	perTitleGlobalFields,
	perTitleStreamFields,
	tunePerTitleSettings,
} from "./per-title-simulator-tuning";

const anchor: PerTitleGoal = {
	strategy: "fixed-ranges",
	codec: "H264",
	minBitrate: 100000,
	maxBitrate: 2400000,
	countPolicy: { kind: "exact", count: 3 },
	rows: [
		{ id: "a", height: 240, minBitrate: 160000, maxBitrate: 200000 },
		{ id: "b", height: 480, minBitrate: 400000, maxBitrate: 480000 },
		{ id: "c", height: 720, minBitrate: 1000000, maxBitrate: 1200000 },
	],
};

function stored() {
	return JSON.parse(screen.getByTestId("stored-goal").textContent ?? "{}");
}

function Harness({
	fieldKey,
	scope = "global",
	initial = anchor,
}: {
	fieldKey?: string;
	scope?: "global" | "stream";
	initial?: PerTitleGoal;
}) {
	const [draft, setDraft] = useState(() => initializePerTitleSettings(initial));
	const tuned = tunePerTitleSettings(draft, anchor);
	const context = {
		draft,
		anchor,
		proposal: tuned.proposal,
		onChange: setDraft,
	};
	const field = (
		scope === "global"
			? perTitleGlobalFields(draft.codec)
			: perTitleStreamFields(draft.codec)
	).find((item) => item.key === fieldKey);
	return (
		<>
			{field ? (
				<PerTitleSettingControl
					id="setting"
					context={context}
					scope={scope}
					field={field}
					rowId={scope === "stream" ? "a" : undefined}
				/>
			) : scope === "global" ? (
				<PerTitleGlobalControls id="global" context={context} />
			) : (
				<PerTitleStreamControls id="stream" context={context} rowId="a" />
			)}
			<button
				type="button"
				onClick={() =>
					setDraft((current) => ({
						...current,
						countPolicy: { kind: "exact", count: 5 },
					}))
				}
			>
				Change count
			</button>
			<output data-testid="stored-goal">{JSON.stringify(draft)}</output>
		</>
	);
}

describe("Per-Title setting controls", () => {
	it("captures the displayed automatic spacing and retains it after another requirement changes", () => {
		renderLocalized(
			<Harness
				fieldKey="minBitrateStepSize"
				initial={{
					...anchor,
					adjustments: {
						global: {
							minBitrateStepSize: { mode: "auto", method: "constraints" },
						},
					},
				}}
			/>,
		);
		const field = screen.getByRole("spinbutton");
		const displayed = (field as HTMLInputElement).valueAsNumber;
		expect(displayed).toBeGreaterThan(1);
		const mode = screen.getByRole("combobox", { name: /adjustment$/ });
		fireEvent.change(mode, { target: { value: "fixed" } });
		expect(stored().adjustments.global.minBitrateStepSize).toEqual({
			mode: "fixed",
		});
		expect(stored().minBitrateStepSize).toBe(displayed);
		fireEvent.click(screen.getByRole("button", { name: "Change count" }));
		expect(field).toHaveValue(displayed);
		expect(mode).toHaveValue("fixed");
	});

	it("offers automatic methods and switches a manually edited stream value to Fixed", () => {
		renderLocalized(
			<Harness
				fieldKey="minBitrate"
				scope="stream"
				initial={{
					...anchor,
					adjustments: {
						streams: {
							a: { minBitrate: { mode: "auto", method: "logarithmic" } },
						},
					},
				}}
			/>,
		);
		const method = screen.getByRole("combobox", { name: /method$/ });
		for (const value of ["constraints", "proportional", "logarithmic"])
			expect(
				within(method).getByRole("option", {
					name:
						value === "constraints"
							? "From requirements"
							: value === "proportional"
								? "Proportional"
								: "Logarithmic",
				}),
			).toHaveValue(value);
		fireEvent.change(method, { target: { value: "proportional" } });
		expect(stored().adjustments.streams.a.minBitrate).toEqual({
			mode: "auto",
			method: "proportional",
		});
		fireEvent.change(screen.getByRole("spinbutton"), {
			target: { value: "175" },
		});
		expect(stored().rows[0].minBitrate).toBe(175000);
		expect(stored().adjustments.streams.a.minBitrate).toEqual({
			mode: "fixed",
		});
		expect(screen.getByRole("combobox", { name: /adjustment$/ })).toHaveValue(
			"fixed",
		);
	});

	it("keeps optional defaults unset, accepts zero and negative SDK limits, and preserves explicit clearing", () => {
		renderLocalized(
			<Harness
				fieldKey="resolutionScaleFactor"
				initial={{
					...anchor,
					adjustments: {
						global: {
							resolutionScaleFactor: { mode: "auto", method: "default" },
						},
					},
				}}
			/>,
		);
		expect(screen.getByText("Encoder default")).toBeVisible();
		expect(screen.queryByRole("combobox", { name: /method$/ })).toBeNull();
		fireEvent.change(screen.getByRole("spinbutton"), {
			target: { value: "-1" },
		});
		expect(screen.getByRole("spinbutton")).toHaveValue(-1);
		expect(screen.getByRole("spinbutton")).not.toHaveAttribute("aria-invalid");
		fireEvent.change(screen.getByRole("spinbutton"), {
			target: { value: "0" },
		});
		expect(screen.getByRole("spinbutton")).toHaveValue(0);
		expect(screen.getByRole("spinbutton")).not.toHaveAttribute("aria-invalid");
		fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "" } });
		expect(stored().resolutionScaleFactor).toBeUndefined();
		expect(stored().adjustments.global.resolutionScaleFactor).toEqual({
			mode: "fixed",
		});
	});

	it("retains a Fixed inactive boundary while identifying that the emitted mode does not use it", () => {
		const initial: PerTitleGoal = {
			...anchor,
			adjustments: {
				streams: {
					a: {
						bitrateSelectionMode: { mode: "fixed" },
						lowComplexityBoundaryForMaxBitrate: { mode: "fixed" },
					},
				},
			},
			rows: anchor.rows?.map((row) =>
				row.id === "a"
					? {
							...row,
							bitrateSelectionMode: "OPTIMIZED",
							lowComplexityBoundaryForMaxBitrate: 900000,
						}
					: row,
			),
		};
		renderLocalized(
			<Harness
				fieldKey="lowComplexityBoundaryForMaxBitrate"
				scope="stream"
				initial={initial}
			/>,
		);
		expect(screen.getByRole("spinbutton")).toHaveValue(900);
		expect(screen.getByRole("combobox", { name: /adjustment$/ })).toHaveValue(
			"fixed",
		);
		expect(screen.getByText("Not used in this mode")).toBeVisible();
	});

	it("does not enable a fixed-off automatic-representation setting by editing its inactive threshold", () => {
		renderLocalized(
			<Harness
				fieldKey="autoRepresentations.adoptConfigurationThreshold"
				initial={{ ...anchor, autoRepresentations: false }}
			/>,
		);
		const field = screen.getByRole("spinbutton");
		expect(field).toBeDisabled();
		expect(screen.getByText("Not used in this mode")).toBeVisible();
		fireEvent.change(field, { target: { value: "0.5" } });
		expect(stored().autoRepresentations).toBe(false);
		expect(
			stored().adjustments?.global?.[
				"autoRepresentations.adoptConfigurationThreshold"
			],
		).toBeUndefined();
	});

	it("does not invent a numeric lower bound for a quality field without an SDK limit", () => {
		renderLocalized(<Harness fieldKey="targetQualityCrf" />);
		const field = screen.getByRole("spinbutton");
		expect(field).not.toHaveAttribute("min");
		fireEvent.change(field, { target: { value: "-1" } });
		expect(field).toHaveValue(-1);
		expect(field).not.toHaveAttribute("aria-invalid");
		expect(stored().targetQualityCrf).toBe(-1);
		expect(stored().adjustments.global.targetQualityCrf).toEqual({
			mode: "fixed",
		});
	});

	it.each([
		"en",
		"ja",
	] as const)("groups all registered global and stream controls under closed advanced sections (%s)", (locale) => {
		const { container } = renderLocalized(<Harness />, locale);
		const details = container.querySelectorAll("details");
		expect(details.length).toBeGreaterThan(0);
		for (const element of details) expect(element.open).toBe(false);
		for (const field of perTitleGlobalFields("H264").filter(
			(item) => item.group !== "range",
		))
			expect(
				container.querySelector(`[data-setting-key="${field.key}"]`),
			).not.toBeNull();
		for (const field of screen.getAllByRole("spinbutton"))
			expect(field).not.toBeVisible();
	});
});
