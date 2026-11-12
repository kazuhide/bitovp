import { expect, it } from "vitest";
import { DEFAULT_WIZARD_STATE } from "@/app/vod/new/build-plan";
import { mergeWizardDraft, projectWizardDraft } from "./wizard-draft";

const document = {
	schemaVersion: 1 as const,
	id: "00000000-0000-4000-8000-000000000001",
	audioEnabled: true,
	clips: [
		{
			id: "00000000-0000-4000-8000-000000000002",
			sourceKey: "main",
			inMs: 1234,
			outMs: 5678,
		},
	],
};
it("restores exact timeline order/ranges without transient preview state", () => {
	const saved = projectWizardDraft("vod", {
		...DEFAULT_WIZARD_STATE,
		inputTimeline: document,
		timelinePreviewUrl: "https://private.invalid/secret",
		timelineProbeId: "ephemeral",
	});
	expect(saved.inputTimeline).toEqual(document);
	expect(saved).not.toHaveProperty("timelinePreviewUrl");
	expect(saved).not.toHaveProperty("timelineProbeId");
	expect(
		mergeWizardDraft(DEFAULT_WIZARD_STATE, saved, "vod").inputTimeline,
	).toEqual(document);
});
it("rejects malformed or newer timeline documents rather than submitting an unedited source", () => {
	expect(() =>
		projectWizardDraft("vod", {
			...DEFAULT_WIZARD_STATE,
			inputTimeline: { ...document, schemaVersion: 2 },
		}),
	).toThrow();
	expect(() =>
		projectWizardDraft("vod", {
			...DEFAULT_WIZARD_STATE,
			inputTimeline: { ...document, url: "https://private.invalid" },
		}),
	).toThrow();
});
