import { fireEvent, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderLocalized } from "@/test/render";
import { PerTitleSimulatorBitrateField } from "./per-title-simulator-bitrate-field";

const labels = {
	id: "bitrate",
	label: "Minimum bitrate (kbps)",
	sliderLabel: "Minimum bitrate slider",
};

describe("Per-Title bitrate field", () => {
	it("keeps numeric input and slider synchronized at one-bit precision", () => {
		const onChange = vi.fn();
		function Controlled() {
			const [value, setValue] = useState<number | undefined>(150001);
			return (
				<PerTitleSimulatorBitrateField
					{...labels}
					value={value}
					minimum={100000}
					maximum={1000000}
					onChange={(next) => {
						onChange(next);
						setValue(next);
					}}
				/>
			);
		}
		renderLocalized(<Controlled />);
		const numeric = screen.getByRole("spinbutton", { name: labels.label });
		const slider = screen.getByRole("slider", { name: labels.sliderLabel });
		expect(numeric).toHaveValue(150.001);
		expect(slider).toHaveValue("150.001");
		expect(slider).toHaveAttribute("step", "0.001");
		expect(onChange).not.toHaveBeenCalled();
		fireEvent.change(numeric, { target: { value: "275.003" } });
		expect(onChange).toHaveBeenLastCalledWith(275003);
		expect(slider).toHaveValue("275.003");
		fireEvent.change(slider, { target: { value: "250.007" } });
		expect(onChange).toHaveBeenLastCalledWith(250007);
		expect(numeric).toHaveValue(250.007);
	});

	it.each([
		{ input: "1.001", expected: 1001, sliderEnabled: true },
		{ input: "1.0015", expected: 1001.5, sliderEnabled: false },
	])("removes only multiplication noise from $input kbps", ({
		input,
		expected,
		sliderEnabled,
	}) => {
		const onChange = vi.fn();
		function Controlled() {
			const [value, setValue] = useState<number | undefined>(2000);
			return (
				<PerTitleSimulatorBitrateField
					{...labels}
					value={value}
					minimum={1}
					maximum={5000}
					onChange={(next) => {
						onChange(next);
						setValue(next);
					}}
				/>
			);
		}
		renderLocalized(<Controlled />);
		const numeric = screen.getByRole("spinbutton", { name: labels.label });
		const slider = screen.getByRole("slider", { name: labels.sliderLabel });
		fireEvent.change(numeric, { target: { value: input } });
		expect(onChange).toHaveBeenLastCalledWith(expected);
		expect(numeric).toHaveValue(Number(input));
		if (sliderEnabled) {
			expect(slider).toBeEnabled();
			expect(slider).toHaveValue(input);
		} else {
			expect(slider).toBeDisabled();
		}
	});

	it.each([
		"en",
		"ja",
	] as const)("localizes the slider value and keeps the numeric accessible label (%s)", (locale) => {
		renderLocalized(
			<PerTitleSimulatorBitrateField
				{...labels}
				value={1234567}
				minimum={1}
				maximum={2000000}
				accessibleLabel={
					locale === "en" ? "Rendition minimum" : "レンディションの下限"
				}
				onChange={vi.fn()}
			/>,
			locale,
		);
		expect(
			screen.getByRole("spinbutton", {
				name: locale === "en" ? "Rendition minimum" : "レンディションの下限",
			}),
		).toHaveValue(1234.567);
		expect(
			screen.getByRole("slider", { name: labels.sliderLabel }),
		).toHaveAttribute(
			"aria-valuetext",
			`${new Intl.NumberFormat(locale, { maximumFractionDigits: 3 }).format(1234.567)} kbps`,
		);
	});

	it("retains numeric clearing as invalid and allows correction while the slider is disabled", () => {
		const onChange = vi.fn();
		function Controlled() {
			const [value, setValue] = useState<number | undefined>(200000);
			return (
				<PerTitleSimulatorBitrateField
					{...labels}
					value={value}
					minimum={100000}
					maximum={500000}
					onChange={(next) => {
						onChange(next);
						setValue(next);
					}}
				/>
			);
		}
		renderLocalized(<Controlled />);
		const numeric = screen.getByRole("spinbutton", { name: labels.label });
		const slider = screen.getByRole("slider", { name: labels.sliderLabel });
		fireEvent.change(numeric, { target: { value: "" } });
		expect(onChange).toHaveBeenLastCalledWith(Number.NaN);
		expect(numeric).toHaveValue(null);
		expect(numeric).toBeEnabled();
		expect(slider).toBeDisabled();
		expect(slider).not.toHaveAttribute("aria-valuetext");
		fireEvent.change(numeric, { target: { value: "120.001" } });
		expect(onChange).toHaveBeenLastCalledWith(120001);
		expect(slider).toBeEnabled();
		expect(slider).toHaveValue("120.001");
	});

	it.each([
		{ name: "zero minimum", minimum: 0, maximum: 500000, value: 200000 },
		{
			name: "fractional minimum",
			minimum: 1.5,
			maximum: 500000,
			value: 200000,
		},
		{
			name: "nonfinite maximum",
			minimum: 1,
			maximum: Number.POSITIVE_INFINITY,
			value: 200000,
		},
		{
			name: "oversized maximum",
			minimum: 1,
			maximum: 2147483648,
			value: 200000,
		},
		{
			name: "reversed bounds",
			minimum: 500000,
			maximum: 100000,
			value: 200000,
		},
		{ name: "undefined value", minimum: 1, maximum: 500000, value: undefined },
		{ name: "nonfinite value", minimum: 1, maximum: 500000, value: Number.NaN },
		{ name: "fractional value", minimum: 1, maximum: 500000, value: 200000.5 },
		{
			name: "value below domain",
			minimum: 100000,
			maximum: 500000,
			value: 99999,
		},
		{
			name: "value above domain",
			minimum: 100000,
			maximum: 500000,
			value: 500001,
		},
	])("disables only the slider without rewriting $name", ({
		name: _name,
		...values
	}) => {
		const onChange = vi.fn();
		renderLocalized(
			<PerTitleSimulatorBitrateField
				{...labels}
				{...values}
				onChange={onChange}
			/>,
		);
		const numeric = screen.getByRole("spinbutton", { name: labels.label });
		const slider = screen.getByRole("slider", { name: labels.sliderLabel });
		expect(numeric).toBeEnabled();
		expect(numeric).toHaveValue(
			values.value !== undefined && Number.isFinite(values.value)
				? values.value / 1000
				: null,
		);
		expect(slider).toBeDisabled();
		expect(Number.isFinite(Number(slider.getAttribute("min")))).toBe(true);
		expect(Number.isFinite(Number(slider.getAttribute("max")))).toBe(true);
		expect(Number.isFinite(Number((slider as HTMLInputElement).value))).toBe(
			true,
		);
		fireEvent.keyDown(slider, { key: "ArrowRight" });
		fireEvent.change(slider, { target: { value: "250" } });
		expect(onChange).not.toHaveBeenCalled();
		fireEvent.change(numeric, { target: { value: "300" } });
		expect(onChange).toHaveBeenLastCalledWith(300000);
	});

	it.each([
		{
			name: "explicitly disabled",
			minimum: 100000,
			maximum: 500000,
			value: 200000,
			disabled: true,
		},
		{
			name: "collapsed domain",
			minimum: 200000,
			maximum: 200000,
			value: 200000,
			disabled: false,
		},
	])("keeps a $name slider inert while the numeric field remains editable", ({
		name: _name,
		...props
	}) => {
		const onChange = vi.fn();
		renderLocalized(
			<PerTitleSimulatorBitrateField
				{...labels}
				{...props}
				onChange={onChange}
			/>,
		);
		const slider = screen.getByRole("slider", { name: labels.sliderLabel });
		expect(slider).toBeDisabled();
		fireEvent.keyDown(slider, { key: "End" });
		fireEvent.change(slider, { target: { value: "200" } });
		expect(onChange).not.toHaveBeenCalled();
		const numeric = screen.getByRole("spinbutton", { name: labels.label });
		expect(numeric).toBeEnabled();
		fireEvent.change(numeric, { target: { value: "250" } });
		expect(onChange).toHaveBeenLastCalledWith(250000);
	});

	it("uses a decimal domain-based keyboard increment and tenfold Page increment without losing one-bit precision", () => {
		const onChange = vi.fn();
		function Controlled() {
			const [value, setValue] = useState<number | undefined>(500001);
			return (
				<PerTitleSimulatorBitrateField
					{...labels}
					value={value}
					minimum={100000}
					maximum={1100000}
					onChange={(next) => {
						onChange(next);
						setValue(next);
					}}
				/>
			);
		}
		renderLocalized(<Controlled />);
		const slider = screen.getByRole("slider", { name: labels.sliderLabel });
		for (const [key, value] of [
			["ArrowRight", 501001],
			["PageUp", 511001],
			["ArrowDown", 510001],
			["PageDown", 500001],
		] as const) {
			fireEvent.keyDown(slider, { key });
			expect(onChange).toHaveBeenLastCalledWith(value);
			expect(slider).toHaveValue(String(value / 1000));
		}
	});

	it("supports one-bit domains, clamps keyboard movement, and reaches exact Home and End endpoints", () => {
		const onChange = vi.fn();
		function Controlled() {
			const [value, setValue] = useState<number | undefined>(2);
			return (
				<PerTitleSimulatorBitrateField
					{...labels}
					value={value}
					minimum={1}
					maximum={5}
					onChange={(next) => {
						onChange(next);
						setValue(next);
					}}
				/>
			);
		}
		renderLocalized(<Controlled />);
		const slider = screen.getByRole("slider", { name: labels.sliderLabel });
		for (const [key, value] of [
			["ArrowUp", 3],
			["PageUp", 5],
			["Home", 1],
			["ArrowLeft", 1],
			["End", 5],
		] as const) {
			fireEvent.keyDown(slider, { key });
			expect(slider).toHaveValue(String(value / 1000));
		}
		expect(onChange.mock.calls.map(([value]) => value)).toEqual([3, 5, 1, 5]);
	});

	it("honors a supplied integer keyboard increment at the maximum supported bitrate", () => {
		const onChange = vi.fn();
		function Controlled() {
			const [value, setValue] = useState<number | undefined>(2147483646);
			return (
				<PerTitleSimulatorBitrateField
					{...labels}
					value={value}
					minimum={2147483000}
					maximum={2147483647}
					keyboardStep={10000}
					onChange={(next) => {
						onChange(next);
						setValue(next);
					}}
				/>
			);
		}
		renderLocalized(<Controlled />);
		const slider = screen.getByRole("slider", { name: labels.sliderLabel });
		fireEvent.keyDown(slider, { key: "ArrowRight" });
		expect(onChange).toHaveBeenLastCalledWith(2147483647);
		fireEvent.keyDown(slider, { key: "PageDown" });
		expect(onChange).toHaveBeenLastCalledWith(2147483000);
		expect(screen.getByRole("spinbutton", { name: labels.label })).toHaveValue(
			2147483,
		);
	});
});
