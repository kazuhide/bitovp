import { readFileSync } from "node:fs";
import { join } from "node:path";
import { encodingPlanSchema } from "@bitovp/core";
import { fireEvent, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
	mergeWizardDraft,
	readWizardDraft,
	writeWizardDraft,
} from "@/lib/wizard-draft";
import { renderLocalized as render } from "@/test/render";
import { buildPlan, DEFAULT_WIZARD_STATE } from "./build-plan";
import { projectPerTitleEncodingImport } from "./per-title-encoding-import";
import { parseImportedPlan } from "./plan-import";
import { evaluateWizardState } from "./plan-preview";
import { planToWizardState, tryImportPresetIntoWizard } from "./plan-to-wizard";
import { addVodVideo } from "./rendition-copy";
import { Av1AdvancedEditor } from "./rendition-editors";

afterEach(() => localStorage.clear());

function fixture(name: string) {
	return encodingPlanSchema.parse(
		JSON.parse(
			readFileSync(
				join(
					__dirname,
					"../../../../../../packages/core/src/plan/__fixtures__",
					`${name}.plan.json`,
				),
				"utf8",
			),
		),
	);
}

it.each([
	["VP9", "vp9-webm-fixed-dash"],
	["AV1", "av1-fmp4-dash-hls"],
] as const)("accepts the existing %s output-width control", (codec, name) => {
	const state = planToWizardState(fixture(name));
	const row = state.videos[0];
	if (!row) throw new Error("Missing fixture video");
	state.videos[0] = { ...row, width: 640 };
	const evaluation = evaluateWizardState(state);
	expect(evaluation.ok).toBe(true);
	if (!evaluation.ok) throw new Error(evaluation.zodMessage);
	expect(evaluation.issues.filter((issue) => issue.level === "error")).toEqual(
		[],
	);
	expect(
		evaluation.ops.find((op) => op.kind === `CREATE_CODEC_${codec}`)?.payload,
	).toHaveProperty("width", 640);
});

it("retains AV1 level and HDR10 values through import, draft, copy and reimport", () => {
	const base = fixture("av1-fmp4-dash-hls");
	const values = {
		width: 640,
		maxLevel: "4.1",
		dynamicRangeFormat: "HDR10",
		masterDisplay:
			"G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,1)",
		maxContentLightLevel: 0,
		maxPictureAverageLightLevel: 0,
	};
	const raw = {
		...base,
		renditions: base.renditions.map((row) =>
			row.codec === "AV1" ? { ...row, ...values } : row,
		),
	};
	const imported = tryImportPresetIntoWizard(raw);
	expect(imported.ok).toBe(true);
	if (!imported.ok) throw new Error("Raw API enum value was not editable");
	expect(imported.state.videos[0]?.av1?.maxLevel).toBe("L4_1");
	const plan = encodingPlanSchema.parse(raw);
	expect(tryImportPresetIntoWizard(plan).ok).toBe(true);
	const state = planToWizardState(plan);
	const { width: _width, ...options } = values;
	expect(state.videos[0]?.width).toBe(640);
	expect(state.videos[0]?.av1).toMatchObject({
		...options,
		maxLevel: "L4_1",
	});
	writeWizardDraft("av1-settings", "vod", state, 2);
	const draft = readWizardDraft("av1-settings", "vod");
	if (!draft) throw new Error("Missing AV1 settings draft");
	const restored = mergeWizardDraft(
		structuredClone(DEFAULT_WIZARD_STATE),
		draft.value,
		"vod",
	);
	expect(encodingPlanSchema.parse(buildPlan(restored))).toEqual(plan);
	const copied = { ...restored, ...addVodVideo(restored, 0) };
	expect(copied.videos.at(-1)?.width).toBe(640);
	expect(copied.videos.at(-1)?.av1).toEqual(restored.videos[0]?.av1);
	const rebuilt = encodingPlanSchema.parse(buildPlan(copied));
	expect(
		encodingPlanSchema.parse(buildPlan(planToWizardState(rebuilt))),
	).toEqual(rebuilt);
});

it("keeps invalid AV1 values in a draft and a raw import for correction", () => {
	const state = planToWizardState(fixture("av1-fmp4-dash-hls"));
	const row = state.videos[0];
	if (!row) throw new Error("Missing fixture video");
	state.videos[0] = {
		...row,
		width: 0,
		av1: { ...row.av1, maxLevel: "FUTURE_LEVEL", maxContentLightLevel: -1 },
	};
	writeWizardDraft("invalid-av1", "vod", state, 2);
	const draft = readWizardDraft("invalid-av1", "vod");
	if (!draft) throw new Error("Missing invalid AV1 draft");
	const restored = mergeWizardDraft(
		structuredClone(DEFAULT_WIZARD_STATE),
		draft.value,
		"vod",
	);
	expect(restored.videos[0]).toMatchObject({
		width: 0,
		av1: { maxLevel: "FUTURE_LEVEL", maxContentLightLevel: -1 },
	});
	expect(evaluateWizardState(restored).ok).toBe(false);
	const raw = buildPlan(restored);
	const imported = parseImportedPlan(JSON.stringify(raw));
	if (!imported.ok) throw new Error("Raw import was not retained");
	expect(imported.imported.raw).toEqual(raw);
	expect(imported.imported.evaluation.ok).toBe(false);
});

it.each([
	"en",
	"ja",
] as const)("edits optional AV1 settings in the existing advanced section in %s", (locale) => {
	const onChange = vi.fn();
	const value = {
		maxLevel: "L4_1",
		dynamicRangeFormat: "HDR10" as const,
		masterDisplay:
			"G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,1)",
		maxContentLightLevel: 0,
		maxPictureAverageLightLevel: 1000,
	};
	render(
		<Av1AdvancedEditor idBase="av1" value={value} onChange={onChange} />,
		locale,
	);
	const level = screen.getByLabelText(
		locale === "ja" ? "AV1 レベル上限" : "Maximum AV1 level",
	);
	expect(level.closest("details")?.querySelector("summary")?.textContent).toBe(
		locale === "ja" ? "詳細設定(AV1)" : "Advanced (AV1)",
	);
	expect(level).toHaveValue("L4_1");
	fireEvent.change(level, { target: { value: "L5_1" } });
	expect(onChange).toHaveBeenLastCalledWith({ ...value, maxLevel: "L5_1" });
	fireEvent.change(level, { target: { value: "" } });
	expect(onChange).toHaveBeenLastCalledWith({ ...value, maxLevel: undefined });
	const light = screen.getByLabelText("MaxCLL");
	expect(light).toHaveValue(0);
	fireEvent.change(light, { target: { value: "" } });
	expect(onChange).toHaveBeenLastCalledWith({
		...value,
		maxContentLightLevel: undefined,
	});
	fireEvent.change(screen.getByLabelText("MaxFALL"), {
		target: { value: "0" },
	});
	expect(onChange).toHaveBeenLastCalledWith({
		...value,
		maxPictureAverageLightLevel: 0,
	});
	fireEvent.change(
		screen.getByLabelText(
			locale === "ja" ? "マスターディスプレイ" : "Master display",
		),
		{ target: { value: "" } },
	);
	expect(onChange).toHaveBeenLastCalledWith({
		...value,
		masterDisplay: undefined,
	});
});

it.each([
	"VP9",
	"AV1",
] as const)("imports %s width-only Per-Title references without inventing dimensions", (codec) => {
	const field = codec === "VP9" ? "vp9Configuration" : "av1Configuration";
	const result = projectPerTitleEncodingImport({
		startRequest: {
			perTitle: { [field]: { minBitrate: 100_000, maxBitrate: 4_000_000 } },
		},
		streams: [
			{
				stream: {
					id: "width-only",
					mode: "PER_TITLE_TEMPLATE_FIXED_RESOLUTION",
				},
				codecType: codec,
				configuration: { width: 1280, bitrate: null },
			},
		],
	});
	expect(result.issues).toEqual([]);
	expect(result.configurations[0]?.reference.streams[0]).toMatchObject({
		width: 1280,
	});
	expect(result.configurations[0]?.reference.streams[0]).not.toHaveProperty(
		"height",
	);
	expect(result.configurations[0]?.goal.rows?.[0]).toMatchObject({
		width: 1280,
	});
	expect(result.configurations[0]?.goal.rows?.[0]).not.toHaveProperty("height");
});
