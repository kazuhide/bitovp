import { fireEvent, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { mergeWizardDraft, projectWizardDraft } from "@/lib/wizard-draft";
import { renderWithQuery as render } from "@/test/render";
import { DEFAULT_WIZARD_STATE, type WizardState } from "./build-plan";
import { EncodingOptionsSection } from "./wizard-sections";

describe("AI advisory controls", () => {
	it.each([
		{},
		{ topics: [] },
		{ topics: ["UNKNOWN"] },
		{ topics: ["TOBACCO", "TOBACCO"] },
		{ topics: "TOBACCO" },
	])("discards damaged advisory settings from drafts without losing the AI destination: %j", (regulatoryAdvisories) => {
		const saved = projectWizardDraft("vod", {
			...DEFAULT_WIZARD_STATE,
			startOptions: {
				aiSceneAnalysis: {
					filename: "analysis.json",
					path: "ai",
					regulatoryAdvisories,
				},
			},
		});
		const restored = mergeWizardDraft(DEFAULT_WIZARD_STATE, saved, "vod");
		expect(
			restored.startOptions?.aiSceneAnalysis?.regulatoryAdvisories,
		).toBeUndefined();
		expect(restored.startOptions?.aiSceneAnalysis).toMatchObject({
			filename: "analysis.json",
			path: "ai",
		});
		render(<EncodingOptionsSection state={restored} onPatch={vi.fn()} />, "en");
		expect(screen.getByLabelText("Detect tobacco (TOBACCO)")).not.toBeChecked();
	});
	it.each([
		[
			"en",
			"Detect tobacco (TOBACCO)",
			"Requires this feature to be enabled for your organization. Findings are saved in the asset description; no text is added to the video.",
		],
		[
			"ja",
			"たばこを検出（TOBACCO）",
			"組織でこの機能が有効になっている必要があります。検出結果は解析ファイルに記録され、映像への注意文の挿入は行いません。",
		],
	] as const)("toggles the supported topic without changing other AI settings: %s", (locale, label, help) => {
		const changed = vi.fn();
		function Harness() {
			const [state, setState] = useState<WizardState>({
				...DEFAULT_WIZARD_STATE,
				startOptions: {
					aiSceneAnalysis: {
						filename: "analysis.json",
						path: "ai",
						outputLanguageCodes: ["ja"],
					},
				},
			});
			return (
				<EncodingOptionsSection
					state={state}
					onPatch={(patch) => {
						changed(patch);
						setState((s) => ({ ...s, ...patch }));
					}}
				/>
			);
		}
		render(<Harness />, locale);
		const control = screen.getByLabelText(label);
		expect(control).not.toBeChecked();
		expect(control).toHaveAccessibleDescription(help);
		fireEvent.click(control);
		expect(changed.mock.lastCall?.[0].startOptions.aiSceneAnalysis).toEqual({
			filename: "analysis.json",
			path: "ai",
			outputLanguageCodes: ["ja"],
			regulatoryAdvisories: { topics: ["TOBACCO"] },
		});
		const saved = projectWizardDraft("vod", {
			...DEFAULT_WIZARD_STATE,
			...changed.mock.lastCall?.[0],
		});
		const restored = mergeWizardDraft(DEFAULT_WIZARD_STATE, saved, "vod");
		expect(restored.startOptions?.aiSceneAnalysis).toEqual(
			changed.mock.lastCall?.[0].startOptions.aiSceneAnalysis,
		);
		fireEvent.click(control);
		expect(
			changed.mock.lastCall?.[0].startOptions.aiSceneAnalysis
				.regulatoryAdvisories,
		).toBeUndefined();
	});
});
