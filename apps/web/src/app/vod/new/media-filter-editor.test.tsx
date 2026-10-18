import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderWithQuery as render } from "@/test/render";
import { MediaFilterEditor, newFilter } from "./media-filter-editor";

describe("media filter editor", () => {
	it.each([
		"DENOISE_HQDN3D",
		"UNSHARP",
	] as const)("authors %s and keeps explanations in tooltips", (kind) => {
		const onChange = vi.fn();
		render(
			<MediaFilterEditor
				idBase="new-filter"
				filter={newFilter("f", kind)}
				inputFiles={[]}
				onChange={onChange}
			/>,
		);
		const label = kind === "UNSHARP" ? "Luma strength" : "Spatial luma";
		fireEvent.change(screen.getByLabelText(label), { target: { value: "0" } });
		expect(onChange).toHaveBeenLastCalledWith({
			key: "f",
			kind,
			[kind === "UNSHARP" ? "lumaEffectStrength" : "lumaSpatial"]: 0,
		});
	});
	it("uses enum selectors and switches type without retaining incompatible parameters", () => {
		const onChange = vi.fn();
		render(
			<MediaFilterEditor
				idBase="filter"
				filter={newFilter("filter1", "TEXT")}
				inputFiles={[]}
				onChange={onChange}
			/>,
		);
		expect(screen.getByLabelText("Font").tagName).toBe("SELECT");
		fireEvent.change(screen.getByLabelText("Filter type"), {
			target: { value: "ROTATE" },
		});
		expect(onChange).toHaveBeenCalledWith({
			key: "filter1",
			kind: "ROTATE",
			rotation: 90,
		});
	});
	it("keeps numeric zero and omission distinct", () => {
		const onChange = vi.fn();
		render(
			<MediaFilterEditor
				idBase="filter"
				filter={newFilter("volume", "AUDIO_VOLUME")}
				inputFiles={[]}
				onChange={onChange}
			/>,
		);
		fireEvent.change(screen.getByLabelText("Volume"), {
			target: { value: "0" },
		});
		expect(onChange).toHaveBeenLastCalledWith({
			key: "volume",
			kind: "AUDIO_VOLUME",
			volume: 0,
			unit: "PERCENT",
		});
		fireEvent.change(screen.getByLabelText("Sample format"), {
			target: { value: "FLT" },
		});
		expect(onChange).toHaveBeenLastCalledWith({
			key: "volume",
			kind: "AUDIO_VOLUME",
			volume: 100,
			unit: "PERCENT",
			format: "FLT",
		});
	});
	it("selects credential-backed storage references and preserves a missing selection", () => {
		const onChange = vi.fn();
		render(
			<MediaFilterEditor
				idBase="filter"
				filter={{
					key: "image",
					kind: "WATERMARK",
					inputKey: "missing",
					imagePath: "logo.png",
				}}
				inputFiles={[
					{
						key: "file",
						inputKey: "storage",
						kind: "S3",
						bucket: "bucket",
						path: "video.mp4",
						credentialId: "credential",
					},
				]}
				onChange={onChange}
			/>,
		);
		expect(screen.getByLabelText("Image input storage")).toHaveValue("missing");
		fireEvent.change(screen.getByLabelText("Image input storage"), {
			target: { value: "storage" },
		});
		expect(onChange).toHaveBeenLastCalledWith(
			expect.objectContaining({ inputKey: "storage", imagePath: "logo.png" }),
		);
	});
});
