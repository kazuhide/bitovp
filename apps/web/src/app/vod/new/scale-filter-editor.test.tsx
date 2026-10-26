import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderLocalized as render } from "@/test/render";
import type { WizardFilter } from "./build-plan";
import { MediaFilterEditor, newFilter } from "./media-filter-editor";

describe("Scale filter editor", () => {
	it("makes Scale opt-in and starts with no invented dimensions or algorithm", () => {
		const onChange = vi.fn();
		render(
			<MediaFilterEditor
				idBase="filter"
				filter={newFilter("deinterlace", "DEINTERLACE")}
				inputFiles={[]}
				onChange={onChange}
			/>,
		);
		expect(
			screen.queryByLabelText("Filter width (px)"),
		).not.toBeInTheDocument();
		fireEvent.change(screen.getByLabelText("Filter type"), {
			target: { value: "SCALE" },
		});
		expect(onChange).toHaveBeenLastCalledWith({
			key: "deinterlace",
			kind: "SCALE",
		});
	});
	it("edits optional dimensions, algorithm and paired SAR without dropping other fields", () => {
		const onChange = vi.fn();
		const filter: WizardFilter = {
			key: "scale",
			kind: "SCALE",
			width: 1280,
			height: 720,
			scalingAlgorithm: "BICUBIC",
			sampleAspectRatioNumerator: 1,
			sampleAspectRatioDenominator: 1,
		};
		render(
			<MediaFilterEditor
				idBase="filter"
				filter={filter}
				inputFiles={[]}
				onChange={onChange}
			/>,
		);
		expect(screen.getByLabelText("Filter width (px)")).toHaveValue(1280);
		expect(screen.getByLabelText("Filter height (px)")).toHaveValue(720);
		expect(screen.getByLabelText("Scaling algorithm").tagName).toBe("SELECT");
		fireEvent.change(screen.getByLabelText("Scaling algorithm"), {
			target: { value: "LANCZOS" },
		});
		expect(onChange).toHaveBeenLastCalledWith({
			...filter,
			scalingAlgorithm: "LANCZOS",
		});
		fireEvent.change(screen.getByLabelText("Filter width (px)"), {
			target: { value: "" },
		});
		expect(onChange).toHaveBeenLastCalledWith({ ...filter, width: undefined });
		fireEvent.change(screen.getByLabelText("Filter width (px)"), {
			target: { value: "0" },
		});
		expect(onChange).toHaveBeenLastCalledWith({ ...filter, width: 0 });
		fireEvent.change(screen.getByLabelText("Scaling algorithm"), {
			target: { value: "" },
		});
		expect(onChange).toHaveBeenLastCalledWith({
			...filter,
			scalingAlgorithm: undefined,
		});
		fireEvent.change(screen.getByLabelText("SAR numerator"), {
			target: { value: "4" },
		});
		expect(onChange).toHaveBeenLastCalledWith({
			...filter,
			sampleAspectRatioNumerator: 4,
		});
		fireEvent.change(screen.getByLabelText("SAR denominator"), {
			target: { value: "3" },
		});
		expect(onChange).toHaveBeenLastCalledWith({
			...filter,
			sampleAspectRatioDenominator: 3,
		});
	});
	it("renders the existing filter controls in Japanese", () => {
		render(
			<MediaFilterEditor
				idBase="filter"
				filter={newFilter("scale", "SCALE")}
				inputFiles={[]}
				onChange={() => {}}
			/>,
			"ja",
		);
		expect(screen.getByLabelText("フィルターの幅 (px)")).toHaveValue(null);
		expect(screen.getByLabelText("フィルターの高さ (px)")).toHaveValue(null);
		expect(screen.getByLabelText("スケーリングアルゴリズム")).toHaveValue("");
		expect(screen.getByLabelText("SAR 分子")).toHaveValue(null);
		expect(screen.getByLabelText("SAR 分母")).toHaveValue(null);
	});
});
