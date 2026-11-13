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
			inputTimeline: { ...document, schemaVersion: 3 },
		}),
	).toThrow();
	expect(() =>
		projectWizardDraft("vod", {
			...DEFAULT_WIZARD_STATE,
			inputTimeline: { ...document, url: "https://private.invalid" },
		}),
	).toThrow();
});

it("preserves independent V1/A1 placements and gaps in a v2 draft", () => {
	const independent = {
		schemaVersion: 2,
		id: document.id,
		audioEnabled: true,
		durationMs: 5000,
		videoClips: [{ ...document.clips[0], startMs: 0, inMs: 0, outMs: 5000 }],
		audioClips: [
			{ ...document.clips[0], startMs: 0, inMs: 0, outMs: 1000 },
			{
				id: "00000000-0000-4000-8000-000000000003",
				sourceKey: "voice",
				startMs: 2000,
				inMs: 1000,
				outMs: 4000,
			},
		],
	};
	const saved = projectWizardDraft("vod", {
		...DEFAULT_WIZARD_STATE,
		inputTimeline: independent,
		timelinePreviewUrl: "https://private.invalid/secret",
		timelineProbeId: "ephemeral",
	});
	const restored = mergeWizardDraft(DEFAULT_WIZARD_STATE, saved, "vod");
	expect(restored.inputTimeline).toEqual(independent);
	expect(saved).not.toHaveProperty("timelinePreviewUrl");
	expect(saved).not.toHaveProperty("timelineProbeId");
	expect(() =>
		projectWizardDraft("vod", {
			...DEFAULT_WIZARD_STATE,
			inputTimeline: {
				...independent,
				audioClips: independent.audioClips.map((clip) => ({
					...clip,
					url: "https://private.invalid/secret",
				})),
			},
		}),
	).toThrow();
});
