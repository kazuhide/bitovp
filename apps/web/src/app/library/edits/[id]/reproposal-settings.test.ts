import {
	captionsFromSourceSegments,
	compileComposition,
	evaluateCompositionFrame,
	toCompositionDocument,
} from "@bitovp/core";
import { expect, it } from "vitest";
import { editingProjectFixture } from "../editing-fixtures";
import {
	expectedReproposalSave,
	reframeCurrentComposition,
	reproposalDefaults,
} from "./reproposal-settings";

function fixture() {
	const project = editingProjectFixture();
	if (!project.media.timeMap) throw new Error("Missing fixture clock");
	const document = toCompositionDocument(project.draft);
	return {
		project,
		document,
		source: {
			mediaVersionId: project.media.id,
			timeMap: project.media.timeMap,
			width: 1920,
			height: 1080,
			hasAudio: true,
		},
	};
}

it.each([
	"TEXT",
	"TIME",
	"WORDS",
	"SOURCE",
] as const)("predicts saved source-evidence removal after a manual %s edit", (kind) => {
	const f = fixture();
	const original = captionsFromSourceSegments({
		document: f.document,
		sources: [f.source],
		mediaVersionId: f.source.mediaVersionId,
		idFor: () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
		segments: [
			{
				startUs: 1_000_000,
				endUs: 2_000_000,
				text: "Actual speech",
				words: [
					{
						text: "Actual",
						startChar: 0,
						endChar: 6,
						startUs: 1_000_000,
						endUs: 1_500_000,
						confidence: 0.9,
					},
				],
			},
		],
	});
	expect(original.captions?.[0]?.sourceEvidence).toBeDefined();
	const next = structuredClone(original);
	const caption = next.captions?.[0],
		clip = next.clips[0];
	if (!caption || !clip) throw new Error("Missing source caption fixture");
	if (kind === "TEXT") {
		caption.text = "Manual correction";
		delete caption.words;
	}
	if (kind === "TIME") caption.toFrame++;
	if (kind === "WORDS") delete caption.words;
	if (kind === "SOURCE") clip.sourceInUs++;
	const snapshot = structuredClone(next);
	expect(
		expectedReproposalSave(next, original).captions?.[0]?.sourceEvidence,
	).toBeUndefined();
	expect(next).toEqual(snapshot);
	expect(
		expectedReproposalSave(original, original).captions?.[0]?.sourceEvidence,
	).toEqual(original.captions?.[0]?.sourceEvidence);
});

it("uses a saved requested duration rather than silently keeping an under-length proposal", () => {
	const { document, project } = fixture();
	document.autoGeneration = {
		policyVersion: "aisa-shot-window-v1",
		requestHash: "a".repeat(64),
		requestedDurationFrames: 960,
		generatedDurationFrames: 180,
		reasonCodes: [],
		binding: {
			schemaVersion: 1,
			kind: "FIXTURE_AUTHORED",
			organizationId: "00000000-0000-4000-8000-000000000001",
			sourceId: project.media.sourceId,
			locale: "en",
			analysisRevisionId: "33333333-3333-4333-8333-333333333333",
			analysisRawHash: "a".repeat(64),
			analysisDocumentHash: "a".repeat(64),
			mediaVersionId: project.media.id,
			mediaSha256: "a".repeat(64),
			timeMapId: document.timeMapId,
			timeMapHash: "a".repeat(64),
			sourceStartUs: 0,
			sourceEndUs: 1_000_000_000,
			width: 1920,
			height: 1080,
		},
	};
	const value = reproposalDefaults(document, {
		localStory: true,
		japanese: true,
	});
	expect(value.targetDurationFrames).toBe(960);
	expect(value.settings).toMatchObject({
		policy: "DURATION",
		variants: 1,
		captions: "OFF",
	});
	expect(value.settings).not.toHaveProperty("storyMode");
	document.autoGeneration.policyVersion = "aisa-scene-cohesion-v2";
	document.autoGeneration.query = "prosthetic arm";
	expect(
		reproposalDefaults(document, { localStory: true, japanese: false })
			.settings,
	).toMatchObject({ policy: "COHESION", query: "prosthetic arm" });
	for (const [policyVersion, expected] of [
		["aisa-prepared-scene-cohesion-v3", "COHESION"],
		["aisa-prepared-shot-window-v3", "DURATION"],
		["aisa-prepared-content-highlight-v4", "AUTO"],
	] as const) {
		document.autoGeneration.policyVersion = policyVersion;
		const settings = reproposalDefaults(document, {
			localStory: true,
			japanese: false,
		}).settings;
		expect(settings.policy, policyVersion).toBe(expected);
		if (expected === "COHESION") expect(settings.query).toBe("prosthetic arm");
		else expect(settings.query).toBeUndefined();
	}
});

it("preserves the selected canvas, presentation and caption language without changing the draft", () => {
	const { document } = fixture();
	document.canvas = { width: 1080, height: 1080 };
	document.presentation = {
		version: "portrait-layout-v1",
		videoFit: "FIT",
		fallbackFraming: "PRESERVE_SOURCE_V1",
		captionPlacement: "BANDS",
		centerCropConfirmed: true,
	};
	document.captionDisplayLanguage = "ja";
	document.captions = [
		{
			id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
			fromFrame: 0,
			toFrame: 30,
			text: "Hello",
		},
	];
	const before = structuredClone(document);
	const value = reproposalDefaults(document, {
		localStory: false,
		japanese: true,
	});
	expect(value.settings).toMatchObject({
		policy: "AUTO",
		templateId: "square-clean",
		captions: "JAPANESE",
		presentation: { videoFit: "FIT", captionPlacement: "BANDS" },
	});
	expect(value.settings.presentation).not.toHaveProperty("centerCropConfirmed");
	expect(document).toEqual(before);
	expect(
		reproposalDefaults(document, { localStory: false, japanese: false })
			.settings.captions,
	).toBe("ORIGINAL");
});

it("changes framing immediately while retaining clip order, source time, captions and undo input", () => {
	const { document, source } = fixture();
	document.presentation = {
		version: "portrait-layout-v1",
		videoFit: "AUTO",
		fallbackFraming: "PRESERVE_SOURCE_V1",
		captionPlacement: "OVERLAY",
	};
	const before = structuredClone(document);
	const next = reframeCurrentComposition(document, "FILL");
	expect(document).toEqual(before);
	expect(next.clips).toEqual(before.clips);
	expect(next.captions).toEqual(before.captions);
	expect(next.presentation?.videoFit).toBe("FILL");
	const frame = evaluateCompositionFrame(
		compileComposition(next, [source], { allowUnconfirmed: true }),
		0,
	);
	expect(frame.layers[0]?.drawRect).toEqual({ x: 0, y: 0, w: 1080, h: 1920 });
});

it("keeps custom and picture-in-picture placements when the main framing changes", () => {
	const { document } = fixture();
	const main = document.clips[0];
	if (!main) throw new Error("Missing clip");
	document.videoTracks = [
		{ id: "main", name: "Main", order: 0 },
		{ id: "pip", name: "Picture in picture", order: 1 },
	];
	main.trackId = "main";
	main.videoFit = "FIT";
	const pip = {
		...structuredClone(main),
		id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
		trackId: "pip",
		layout: { x: 0.6, y: 0.1, w: 0.3, h: 0.3 },
	};
	document.clips.push(pip);
	const result = reframeCurrentComposition(document, "FILL");
	expect(result.clips[0]?.videoFit).toBeUndefined();
	expect(result.clips[1]).toEqual(pip);
});
