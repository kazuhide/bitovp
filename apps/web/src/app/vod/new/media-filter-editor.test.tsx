import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderWithQuery as render } from "@/test/render";
import {
	buildPlan,
	DEFAULT_WIZARD_STATE,
	type WizardFilter,
} from "./build-plan";
import { editFilter } from "./filter-editing";
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
	it("changes one of two filters sharing a copied logo without replacing the other image", () => {
		const form = structuredClone(DEFAULT_WIZARD_STATE);
		const media = form.inputFiles[0];
		if (!media) throw new Error("missing input");
		const image = {
			...media,
			key: "logo",
			purpose: "FILTER_IMAGE" as const,
			path: "old.png",
		};
		form.inputFiles.push(image);
		const previous: WizardFilter = {
			key: "left",
			kind: "WATERMARK",
			inputKey: image.key,
			imagePath: image.path,
		};
		form.filters = [previous, { ...previous, key: "right" }];
		const next = editFilter(form, 0, { ...previous, imagePath: "new.png" });
		expect(next.filters).toMatchObject([
			{ inputKey: "logo-2", imagePath: "new.png" },
			{ inputKey: "logo", imagePath: "old.png" },
		]);
		expect(
			next.inputFiles?.filter((f) => f.purpose === "FILTER_IMAGE"),
		).toMatchObject([
			{ key: "logo", path: "old.png" },
			{ key: "logo-2", path: "new.png" },
		]);
	});
	it.each([
		["WATERMARK", "other-logo"],
		["WATERMARK", "media"],
		["ENHANCED_WATERMARK", "other-logo"],
		["ENHANCED_WATERMARK", "media"],
	] as const)("moves the same %s logo to the storage selected via %s", (kind, target) => {
		const form = structuredClone(DEFAULT_WIZARD_STATE);
		const first = form.inputFiles[0];
		if (!first) throw new Error("missing media");
		const media = {
			...first,
			key: "media",
			inputKey: "media",
			bucket: "second",
			path: "picture.mp4",
		};
		const logo = {
			...media,
			key: "old-logo",
			bucket: "first",
			purpose: "FILTER_IMAGE" as const,
			path: "original.png",
		};
		const other = {
			...logo,
			key: "other-logo",
			bucket: "second",
			path: "other.png",
		};
		form.inputFiles =
			target === "media" ? [media, logo, other] : [other, media, logo];
		const prior = {
			kind,
			key: "first",
			inputKey: target === "media" ? media.key : logo.key,
			imagePath: logo.path,
		};
		form.filters = [
			prior,
			{ ...prior, key: "second", inputKey: other.key, imagePath: other.path },
		];
		const onChange = (next: WizardFilter, selected?: boolean) =>
			Object.assign(form, editFilter(form, 0, next, false, selected));
		render(
			<MediaFilterEditor
				idBase="logo"
				filter={prior}
				inputFiles={form.inputFiles}
				onChange={onChange}
			/>,
		);
		fireEvent.change(screen.getByLabelText("Image input storage"), {
			target: { value: target },
		});
		const plan = buildPlan(form);
		const results = plan.filters?.map(
			(f) =>
				(f.kind === "WATERMARK" || f.kind === "ENHANCED_WATERMARK") && [
					f.imagePath,
					plan.inputs.find((input) => input.key === f.inputKey),
				],
		);
		expect(results).toMatchObject([
			["original.png", { bucket: "second" }],
			["other.png", { bucket: "second" }],
		]);
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
			target: { value: "file" },
		});
		expect(onChange).toHaveBeenLastCalledWith(
			expect.objectContaining({ inputKey: "file", imagePath: "logo.png" }),
			true,
		);
	});
});
