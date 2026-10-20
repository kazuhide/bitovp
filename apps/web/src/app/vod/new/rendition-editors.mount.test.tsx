import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
	Av1AdvancedEditor,
	ColorConfigEditor,
	ExtrasEditor,
	H264AdvancedEditor,
	H265AdvancedEditor,
	LoudnessEditor,
	Vp9AdvancedEditor,
} from "@/app/vod/new/rendition-editors";
// renderWithQuery, not renderLocalized: the active-NexGuard branch renders
// NewCredentialLink, which reaches for a QueryClient.
import {
	CodesInput,
	OptionsGrid,
	RowRemoveButton,
} from "@/app/vod/new/wizard-fields";
import { renderWithQuery as render } from "@/test/render";

/**
 * The per-codec Advanced editors, mounted for the first time .
 *
 * These seven held ~1,300 lines no test had ever rendered — the API-parity
 * rule lives in exactly these panels, so "the schema can express it" had no
 * check that "a person can reach it". Each test mounts one editor and pushes
 * one change through it, asserting the patch KEEPS sibling keys: every
 * handler here is a hand-written spread, and a dropped `...options` is
 * invisible to a mount alone.
 */

describe("per-codec Advanced editors mount and patch (ledger #149)", () => {
	it("H264 preset selects its effective default and can explicitly omit it", () => {
		const onChange = vi.fn();
		render(
			<H264AdvancedEditor
				idBase="preset"
				value={{ profile: "MAIN" }}
				onChange={onChange}
			/>,
		);
		const preset = screen.getByLabelText("Preset configuration");
		expect(preset.tagName).toBe("SELECT");
		expect(preset).toHaveValue("VOD_HIGH_QUALITY");
		fireEvent.change(preset, { target: { value: "" } });
		expect(onChange).toHaveBeenCalledWith({
			profile: "MAIN",
			presetConfiguration: null,
		});
	});
	it("H265 preset options exclude H264-only quality and preserve imported values", () => {
		const onChange = vi.fn();
		render(
			<H265AdvancedEditor
				idBase="preset"
				value={{ presetConfiguration: "LIVE_STANDARD" }}
				visionMetadataKeys={[]}
				onChange={onChange}
			/>,
		);
		const preset = screen.getByLabelText(
			"Preset configuration",
		) as HTMLSelectElement;
		expect(preset.tagName).toBe("SELECT");
		expect(preset).toHaveValue("LIVE_STANDARD");
		expect([...preset.options].map((option) => option.value)).not.toContain(
			"VOD_QUALITY",
		);
		fireEvent.change(preset, { target: { value: "VOD_STANDARD" } });
		expect(onChange).toHaveBeenCalledWith({
			presetConfiguration: "VOD_STANDARD",
		});
	});
	it("ColorConfigEditor patches colorSpace and keeps sibling flags", () => {
		const onChange = vi.fn();
		render(
			<ColorConfigEditor
				idBase="cc"
				value={{ copyColorSpaceFlag: true }}
				onChange={onChange}
			/>,
		);
		fireEvent.change(screen.getByLabelText("Color space"), {
			target: { value: "BT2020_NCL" },
		});
		expect(onChange).toHaveBeenCalledWith({
			copyColorSpaceFlag: true,
			colorSpace: "BT2020_NCL",
		});
	});

	it("H264AdvancedEditor offers HIGH422 and nests the color config", () => {
		const onChange = vi.fn();
		render(
			<H264AdvancedEditor
				idBase="h264"
				value={{ profile: "MAIN" }}
				onChange={onChange}
			/>,
		);
		const profile = screen.getByLabelText("Profile") as HTMLSelectElement;
		expect([...profile.options].map((o) => o.value)).toContain("HIGH422");
		// The nested ColorConfigEditor must write into options.colorConfig —
		// losing the wrapper object would silently detach every color field.
		fireEvent.change(screen.getByLabelText("Color space"), {
			target: { value: "BT709" },
		});
		expect(onChange).toHaveBeenCalledWith({
			profile: "MAIN",
			colorConfig: { colorSpace: "BT709" },
		});
	});

	it("H265AdvancedEditor: EMBEDDED metadata must not carry a sidecar key", () => {
		const onChange = vi.fn();
		render(
			<H265AdvancedEditor
				idBase="h265"
				value={{
					dolbyVisionMetadata: {
						profile: "DVHE_05",
						metadataSource: "INPUT_STREAM",
						metadataStreamKey: "dv-meta",
					},
				}}
				visionMetadataKeys={["dv-meta"]}
				onChange={onChange}
			/>,
		);
		// INPUT_STREAM exposes the sidecar select, fed by visionMetadataKeys.
		const stream = screen.getByLabelText("Metadata stream");
		expect(
			[...(stream as HTMLSelectElement).options].map((o) => o.value),
		).toContain("dv-meta");
		// The editor's own documented invariant: switching to EMBEDDED strips
		// the stream key in the SAME patch — an EMBEDDED config that kept a
		// stale sidecar pointer is exactly what the SDK refuses downstream.
		fireEvent.change(screen.getByLabelText("Metadata source"), {
			target: { value: "EMBEDDED" },
		});
		expect(onChange).toHaveBeenCalledWith({
			dolbyVisionMetadata: {
				profile: "DVHE_05",
				metadataSource: "EMBEDDED",
				metadataStreamKey: undefined,
			},
		});
	});

	it("Vp9AdvancedEditor patches cpuUsed and keeps siblings", () => {
		const onChange = vi.fn();
		render(
			<Vp9AdvancedEditor
				idBase="vp9"
				value={{ tileColumns: 2 }}
				onChange={onChange}
			/>,
		);
		fireEvent.change(screen.getByLabelText("CPU used"), {
			target: { value: "4" },
		});
		expect(onChange).toHaveBeenCalledWith({ tileColumns: 2, cpuUsed: 4 });
	});

	it("Av1AdvancedEditor offers autoLevelSetup as an enum", () => {
		const onChange = vi.fn();
		render(<Av1AdvancedEditor idBase="av1" value={{}} onChange={onChange} />);
		const control = screen.getByLabelText(
			"Auto level setup",
		) as HTMLSelectElement;
		expect([...control.options].map((o) => o.value)).toEqual(
			expect.arrayContaining(["ENABLED", "DISABLED"]),
		);
		fireEvent.change(control, { target: { value: "DISABLED" } });
		expect(onChange).toHaveBeenCalledWith({ autoLevelSetup: "DISABLED" });
	});

	it("AV1 dynamic range has readable profile labels and an explicit unset choice", () => {
		const onChange = vi.fn();
		const { rerender } = render(
			<Av1AdvancedEditor
				idBase="av1"
				value={{ autoLevelSetup: "ENABLED" }}
				onChange={onChange}
			/>,
		);
		const control = screen.getByLabelText(
			"Dynamic range format",
		) as HTMLSelectElement;
		expect(control).toHaveValue("");
		expect([...control.options].map((o) => [o.value, o.text])).toEqual([
			["", "(default)"],
			["SDR", "SDR"],
			["HDR10", "HDR10"],
			["DOLBY_VISION_PROFILE_10_0", "Dolby Vision Profile 10.0"],
			["DOLBY_VISION_PROFILE_10_1", "Dolby Vision Profile 10.1"],
		]);
		fireEvent.change(control, {
			target: { value: "DOLBY_VISION_PROFILE_10_1" },
		});
		expect(onChange).toHaveBeenLastCalledWith({
			autoLevelSetup: "ENABLED",
			dynamicRangeFormat: "DOLBY_VISION_PROFILE_10_1",
		});
		rerender(
			<Av1AdvancedEditor
				idBase="av1"
				value={{
					autoLevelSetup: "ENABLED",
					dynamicRangeFormat: "DOLBY_VISION_PROFILE_10_1",
				}}
				onChange={onChange}
			/>,
		);
		expect(control).toHaveValue("DOLBY_VISION_PROFILE_10_1");
		fireEvent.change(control, { target: { value: "" } });
		expect(onChange).toHaveBeenLastCalledWith({
			autoLevelSetup: "ENABLED",
			dynamicRangeFormat: undefined,
		});
	});

	it("LoudnessEditor offers the ITU metering modes", () => {
		const onChange = vi.fn();
		render(<LoudnessEditor idBase="loud" value={{}} onChange={onChange} />);
		const mode = screen.getByLabelText("Metering mode") as HTMLSelectElement;
		expect([...mode.options].map((o) => o.value)).toContain("ITU_R_BS_1770_4");
		fireEvent.change(mode, { target: { value: "ITU_R_BS_1770_4" } });
		expect(onChange).toHaveBeenCalledWith({
			meteringMode: "ITU_R_BS_1770_4",
		});
	});
});

describe("ExtrasEditor (ledger #149; #119(b) define-and-attach)", () => {
	const base = {
		idBase: "ex",
		extras: undefined,
		sourceOptions: [
			{ value: "", label: "(implicit)" },
			{ value: "file-1", label: "file-1" },
		],
		encodingKeys: [],
		filterKeys: ["flt-a"],
		nexguardCredentials: [
			{ id: "cred-ng", label: "NexGuard vault", kind: "NEXGUARD" },
		] as never[],
	};

	it("video family: one gesture defines AND attaches the deinterlace filter", () => {
		const onChange = vi.fn();
		const onDefineDeinterlace = vi.fn(() => "flt-new");
		render(
			<ExtrasEditor
				{...base}
				family="video"
				onChange={onChange}
				onDefineDeinterlace={onDefineDeinterlace}
			/>,
		);
		fireEvent.click(
			screen.getByRole("button", {
				name: "Define a deinterlace filter and attach it",
			}),
		);
		expect(onDefineDeinterlace).toHaveBeenCalledOnce();
		// The parent minted the key; the SAME click must attach it — a define
		// that leaves attachment to a second gesture is the #119 defect shape.
		expect(onChange).toHaveBeenCalledWith({
			filters: [{ filterKey: "flt-new", position: 0 }],
		});
	});

	it("video family offers the per-title stream modes; audio must not", () => {
		const onChange = vi.fn();
		const { unmount } = render(
			<ExtrasEditor {...base} family="video" onChange={onChange} />,
		);
		const mode = screen.getByLabelText("Stream mode") as HTMLSelectElement;
		expect([...mode.options].map((o) => o.value)).toContain(
			"PER_TITLE_TEMPLATE",
		);
		// STANDARD is the absent-key default: choosing it must WRITE undefined,
		// not the string — API-parity's "anything unset emits nothing".
		fireEvent.change(mode, { target: { value: "PER_TITLE_TEMPLATE" } });
		expect(onChange).toHaveBeenLastCalledWith({ mode: "PER_TITLE_TEMPLATE" });
		unmount();
		render(<ExtrasEditor {...base} family="audio" onChange={vi.fn()} />);
		expect(screen.queryByLabelText("Stream mode")).not.toBeInTheDocument();
	});

	it("NexGuard: add seeds the OTT default and lists the vault credentials", () => {
		const onChange = vi.fn();
		render(<ExtrasEditor {...base} family="video" onChange={onChange} />);
		fireEvent.click(
			screen.getByRole("button", { name: "Add NexGuard watermarking" }),
		);
		expect(onChange).toHaveBeenCalledWith({
			nexguard: { credentialId: "", watermarkType: "OTT", preset: "" },
		});
		// Re-render as the parent would after that patch: the credential select
		// must list the vault entry (the license itself never enters the form).
		render(
			<ExtrasEditor
				{...base}
				idBase="ex2"
				family="video"
				extras={{
					nexguard: { credentialId: "", watermarkType: "OTT", preset: "" },
				}}
				onChange={vi.fn()}
			/>,
		);
		const cred = screen.getByLabelText("NexGuard license") as HTMLSelectElement;
		expect([...cred.options].map((o) => o.textContent)).toContain(
			"NexGuard vault",
		);
	});
});

describe("wizard-fields atoms (ledger #149 batch 2h tail)", () => {
	/**
	 * OptionsGrid and RowRemoveButton run inside every editor above; this
	 * closes the file's last never-DIRECTLY-rendered export. CodesInput's
	 * parse rule is the substance: comma-split, trimmed, and an emptied box
	 * writes undefined — not [] — so the plan emits nothing.
	 */
	it("CodesInput parses comma lists and empties to undefined", () => {
		const onChange = vi.fn();
		render(<CodesInput id="codes" value={["ja"]} onChange={onChange} />);
		const box = screen.getByRole("textbox") as HTMLInputElement;
		expect(box.defaultValue).toBe("ja");
		fireEvent.change(box, { target: { value: " ja , ko ,," } });
		expect(onChange).toHaveBeenLastCalledWith(["ja", "ko"]);
		fireEvent.change(box, { target: { value: " , " } });
		expect(onChange).toHaveBeenLastCalledWith(undefined);
	});

	it("OptionsGrid and RowRemoveButton mount directly", () => {
		const onChange = vi.fn();
		const onRemove = vi.fn();
		render(
			<div>
				<OptionsGrid
					idBase="og"
					value={{}}
					fields={[
						{
							key: "profile",
							labelKey: "wizard.profile",
							control: { options: ["MAIN"] },
						},
					]}
					onChange={onChange}
				/>
				<RowRemoveButton label="Remove row 1" onClick={onRemove} />
			</div>,
		);
		fireEvent.change(screen.getByLabelText("Profile"), {
			target: { value: "MAIN" },
		});
		expect(onChange).toHaveBeenCalledWith({ profile: "MAIN" });
		fireEvent.click(screen.getByRole("button", { name: "Remove row 1" }));
		expect(onRemove).toHaveBeenCalledOnce();
	});
});
