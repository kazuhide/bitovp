import { encodingPlanSchema } from "@bitovp/core";
import { fireEvent, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
	mergeWizardDraft,
	readWizardDraft,
	writeWizardDraft,
} from "@/lib/wizard-draft";
import { renderLocalized as render } from "@/test/render";
import {
	buildPlan,
	DEFAULT_WIZARD_STATE,
	type WizardH264Options,
	type WizardH265Options,
} from "./build-plan";
import { AudioCutoffEditor, CodecDetailEditor } from "./codec-detail-editor";

afterEach(() => localStorage.clear());

it.each([
	"en",
	"ja",
] as const)("edits and clears detailed H265 settings in %s", (locale) => {
	const onChange = vi.fn();
	render(
		<CodecDetailEditor
			idBase="details"
			codec="H265"
			value={{ maxMerge: 3, earlySkip: false } satisfies WizardH265Options}
			onChange={onChange}
		/>,
		locale,
	);
	fireEvent.change(screen.getByLabelText("maxMerge"), {
		target: { value: "5" },
	});
	expect(onChange).toHaveBeenLastCalledWith({ maxMerge: 5, earlySkip: false });
	fireEvent.change(screen.getByLabelText("maxMerge"), {
		target: { value: "" },
	});
	expect(onChange).toHaveBeenLastCalledWith({
		maxMerge: undefined,
		earlySkip: false,
	});
	fireEvent.change(
		screen.getByLabelText(
			locale === "ja" ? "APIパラメーターを検索" : "Search API parameters",
		),
		{ target: { value: "maxMerge" } },
	);
	expect(screen.queryByLabelText("earlySkip")).not.toBeInTheDocument();
	expect(screen.getByLabelText("maxMerge")).toBeInTheDocument();
});

it("sets a complete caption configuration and can remove it", () => {
	const onChange = vi.fn();
	render(
		<CodecDetailEditor
			idBase="captions"
			codec="H264"
			value={{} as WizardH264Options}
			onChange={onChange}
		/>,
	);
	fireEvent.change(screen.getByLabelText("passthroughActivated"), {
		target: { value: "true" },
	});
	expect(onChange).toHaveBeenLastCalledWith({
		cea608708SubtitleConfig: {
			passthroughActivated: true,
			passthroughMode: "VIDEO_STREAM",
		},
	});
	fireEvent.change(screen.getByLabelText("passthroughActivated"), {
		target: { value: "" },
	});
	expect(onChange).toHaveBeenLastCalledWith({
		cea608708SubtitleConfig: undefined,
	});
});

it.each([
	"en",
	"ja",
] as const)("keeps Hz explicit and makes cutoff optional in %s", (locale) => {
	const onChange = vi.fn();
	render(
		<AudioCutoffEditor id="cutoff" value={16000} onChange={onChange} />,
		locale,
	);
	const input = screen.getByLabelText(
		locale === "ja" ? "カットオフ周波数 (Hz)" : "Cutoff frequency (Hz)",
	);
	fireEvent.change(input, { target: { value: "12000" } });
	expect(onChange).toHaveBeenLastCalledWith(12000);
	fireEvent.change(input, { target: { value: "" } });
	expect(onChange).toHaveBeenLastCalledWith(undefined);
});

it("keeps detailed values and invalid values in the saved draft for correction", () => {
	const state = structuredClone(DEFAULT_WIZARD_STATE);
	state.videos = [
		{
			codec: "H264",
			height: 720,
			bitrate: 1000000,
			h264: {
				deblockAlpha: -2,
				mixedReferences: false,
				partitions: ["P8X8", "I4X4"],
				cea608708SubtitleConfig: {
					passthroughActivated: false,
					passthroughMode: "CAPTION_STREAM",
				},
			},
		},
	];
	state.audios = [
		{ codec: "AC3", bitrate: 128000, rate: 48000, cutoffFrequency: -1 },
	];
	writeWizardDraft("details", "vod", state, 2);
	const draft = readWizardDraft("details", "vod");
	if (!draft) throw new Error("Missing saved details");
	const restored = mergeWizardDraft(
		structuredClone(DEFAULT_WIZARD_STATE),
		draft.value,
		"vod",
	);
	expect(restored.videos).toEqual(state.videos);
	expect(restored.audios).toEqual(state.audios);
	expect(encodingPlanSchema.safeParse(buildPlan(restored)).success).toBe(false);
});

it("renders incomplete nested controls safely after restoring a malformed draft", () => {
	const state = structuredClone(DEFAULT_WIZARD_STATE);
	state.videos = [
		{
			codec: "H264",
			height: 720,
			bitrate: 1000000,
			h264: {
				deblockAlpha: 0,
				cea608708SubtitleConfig: {},
				displayAspectRatio: { numerator: 16 },
				partitions: ["ALL"],
			} as unknown as WizardH264Options,
		},
	];
	writeWizardDraft("incomplete-details", "vod", state, 2);
	const draft = readWizardDraft("incomplete-details", "vod");
	if (!draft) throw new Error("Missing malformed draft");
	const restored = mergeWizardDraft(
		structuredClone(DEFAULT_WIZARD_STATE),
		draft.value,
		"vod",
	);
	expect(restored.videos[0]?.h264?.deblockAlpha).toBe(0);
	expect(() =>
		render(
			<CodecDetailEditor
				idBase="incomplete"
				codec="H264"
				value={restored.videos[0]?.h264 ?? {}}
				onChange={vi.fn()}
			/>,
		),
	).not.toThrow();
	expect(screen.getByLabelText("passthroughActivated")).toHaveValue("");
	expect(encodingPlanSchema.safeParse(buildPlan(restored)).success).toBe(false);
});
