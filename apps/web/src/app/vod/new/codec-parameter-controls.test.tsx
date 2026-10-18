import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderWithQuery as render } from "@/test/render";
import {
	ColorConfigEditor,
	H264AdvancedEditor,
	H265AdvancedEditor,
} from "./rendition-editors";

describe("supported codec parameter controls", () => {
	it("offers non-HD color values and keeps an imported value visible", () => {
		const onChange = vi.fn();
		render(
			<ColorConfigEditor
				idBase="color"
				value={{ colorSpace: "SMPTE170M", colorTransfer: "GAMMA22" }}
				onChange={onChange}
			/>,
		);
		expect(screen.getByLabelText("Color space")).toHaveValue("SMPTE170M");
		expect(screen.getByLabelText("Color transfer")).toHaveValue("GAMMA22");
		fireEvent.change(screen.getByLabelText("Color space"), {
			target: { value: "BT470BG" },
		});
		expect(onChange).toHaveBeenCalledWith({
			colorSpace: "BT470BG",
			colorTransfer: "GAMMA22",
		});
	});
	it("offers H265 level without changing sibling settings", () => {
		const onChange = vi.fn();
		render(
			<H265AdvancedEditor
				idBase="hevc"
				value={{ profile: "MAIN10" }}
				visionMetadataKeys={[]}
				onChange={onChange}
			/>,
		);
		fireEvent.change(screen.getByLabelText("Level"), {
			target: { value: "L4_1" },
		});
		expect(onChange).toHaveBeenCalledWith({ profile: "MAIN10", level: "L4_1" });
	});
	it("uses enum choices for motion estimation and retains an imported unknown value", () => {
		const onChange = vi.fn();
		render(
			<H264AdvancedEditor
				idBase="avc"
				value={{ motionEstimationMethod: "FUTURE_METHOD" }}
				onChange={onChange}
			/>,
		);
		const control = screen.getByLabelText("Motion estimation");
		expect(control.tagName).toBe("SELECT");
		expect(control).toHaveValue("FUTURE_METHOD");
		fireEvent.change(control, { target: { value: "HEX" } });
		expect(onChange).toHaveBeenCalledWith({ motionEstimationMethod: "HEX" });
	});
});
