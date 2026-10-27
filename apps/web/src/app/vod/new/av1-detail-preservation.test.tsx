import { readFileSync } from "node:fs";
import { join } from "node:path";
import { encodingPlanSchema, renditionSchema } from "@bitovp/core";
import { fireEvent, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
	mergeWizardDraft,
	readWizardDraft,
	writeWizardDraft,
} from "@/lib/wizard-draft";
import { renderLocalized as render } from "@/test/render";
import { buildPlan, DEFAULT_WIZARD_STATE } from "./build-plan";
import { parseImportedPlan } from "./plan-import";
import { evaluateWizardState } from "./plan-preview";
import { planToWizardState, tryImportPresetIntoWizard } from "./plan-to-wizard";
import { addVodVideo } from "./rendition-copy";
import { Av1AdvancedEditor } from "./rendition-editors";

afterEach(() => localStorage.clear());

function fixtureState() {
	const plan = encodingPlanSchema.parse(
		JSON.parse(
			readFileSync(
				join(
					__dirname,
					"../../../../../../packages/core/src/plan/__fixtures__/av1-fmp4-dash-hls.plan.json",
				),
				"utf8",
			),
		),
	);
	return planToWizardState(plan);
}

it.each([
	"OFF",
	"AUTO",
	"ON",
	undefined,
])("retains AV1 detail preservation %s in drafts, presets, copies and imports", (mode) => {
	const state = fixtureState();
	state.encoderVersion = "2.291.0";
	state.videos = [
		{
			codec: "AV1",
			height: 360,
			bitrate: 600000,
			av1: mode === undefined ? {} : { detailPreservationMode: mode },
		},
	];
	writeWizardDraft("av1-detail", "vod", state, 2);
	const draft = readWizardDraft("av1-detail", "vod");
	if (!draft) throw new Error("Missing saved AV1 draft");
	const restored = mergeWizardDraft(
		structuredClone(DEFAULT_WIZARD_STATE),
		draft.value,
		"vod",
	);
	expect(restored.videos[0]?.av1).toEqual(state.videos[0]?.av1);
	const plan = encodingPlanSchema.parse(buildPlan(restored));
	const imported = tryImportPresetIntoWizard(plan);
	if (!imported.ok) throw new Error("AV1 preset did not import");
	expect(
		buildPlan(imported.state).renditions.map((row) =>
			renditionSchema.parse(row),
		),
	).toEqual(plan.renditions);
	expect(imported.state.encoderVersion).toBe("2.291.0");
	expect(encodingPlanSchema.parse(buildPlan(planToWizardState(plan)))).toEqual(
		plan,
	);
	const copied = { ...restored, ...addVodVideo(restored, 0) };
	expect(copied.videos.at(-1)?.av1).toEqual(restored.videos[0]?.av1);
	for (const row of plan.renditions.filter((row) => row.codec === "AV1")) {
		if (mode === undefined)
			expect(row).not.toHaveProperty("detailPreservationMode");
		else expect(row).toHaveProperty("detailPreservationMode", mode);
	}
});

it.each([
	"en",
	"ja",
] as const)("edits the optional mode in the existing AV1 section in %s", (locale) => {
	const onChange = vi.fn();
	const { rerender } = render(
		<Av1AdvancedEditor
			idBase="av1"
			value={{ detailPreservationMode: "OFF" }}
			onChange={onChange}
		/>,
		locale,
	);
	const input = screen.getByLabelText(
		locale === "ja" ? "細部の保持" : "Detail preservation",
	);
	const section = input.closest("details");
	if (!section) throw new Error("Missing AV1 advanced section");
	expect(section.querySelector("summary")?.textContent).toBe(
		locale === "ja" ? "詳細設定(AV1)" : "Advanced (AV1)",
	);
	expect(input).toHaveValue("OFF");
	expect(
		within(input).getByRole("option", {
			name:
				locale === "ja"
					? "AUTO — 解像度に応じて適用"
					: "AUTO — Apply by resolution",
		}),
	).toHaveValue("AUTO");
	for (const mode of ["AUTO", "ON", "OFF", ""]) {
		fireEvent.change(input, { target: { value: mode } });
		expect(onChange).toHaveBeenLastCalledWith({
			detailPreservationMode: mode === "" ? undefined : mode,
		});
	}
	// Unknown imported values remain visible until the user corrects them.
	rerender(
		<Av1AdvancedEditor
			idBase="av1"
			value={{ detailPreservationMode: "FUTURE_MODE" }}
			onChange={onChange}
		/>,
	);
	expect(
		screen.getByLabelText(
			locale === "ja" ? "細部の保持" : "Detail preservation",
		),
	).toHaveValue("FUTURE_MODE");
});

it("keeps an invalid imported AV1 detail mode editable and rejects submission", () => {
	const state = fixtureState();
	state.videos = [
		{
			codec: "AV1",
			height: 360,
			bitrate: 600000,
			av1: { detailPreservationMode: "FUTURE_MODE" },
		},
	];
	writeWizardDraft("invalid-av1-detail", "vod", state, 2);
	const draft = readWizardDraft("invalid-av1-detail", "vod");
	if (!draft) throw new Error("Missing invalid AV1 draft");
	const restored = mergeWizardDraft(fixtureState(), draft.value, "vod");
	expect(restored.videos[0]?.av1?.detailPreservationMode).toBe("FUTURE_MODE");
	expect(evaluateWizardState(restored).ok).toBe(false);
	const raw = buildPlan(restored);
	const imported = parseImportedPlan(JSON.stringify(raw));
	if (!imported.ok) throw new Error("Invalid AV1 import was discarded");
	expect(imported.imported.raw).toEqual(raw);
	expect(imported.imported.evaluation.ok).toBe(false);
});
