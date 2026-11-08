import { expect, it } from "vitest";
import {
	createCompositionSubjectProtection,
	isSubjectProtectionValid,
	type SubjectProtectionContext,
} from "./subject-protection";

function fixtureItem<T>(value: T | null | undefined): T {
	if (value === undefined || value === null)
		throw new Error("Missing authored fixture");
	return value;
}

const context: SubjectProtectionContext = {
	bindingHash: "a".repeat(64),
	mediaVersionId: "11111111-1111-4111-8111-111111111111",
	timeMapId: "22222222-2222-4222-8222-222222222222",
	mediaSha256: "b".repeat(64),
	timeMapHash: "c".repeat(64),
	analysisRevisionId: "33333333-3333-4333-8333-333333333333",
	analysisDocumentHash: "d".repeat(64),
	storyArtifactHash: "e".repeat(64),
	selectionHash: "1".repeat(64),
	sceneId: "44444444-4444-4444-8444-444444444444",
	shotIndex: 0,
	sourceStartUs: 100_000_000,
	sourceEndUs: 110_000_000,
	sourceInUs: 100_000_000,
	durationFrames: 60,
	sourceWidth: 1920,
	sourceHeight: 1080,
	framingHash: "f".repeat(64),
};
function fixture() {
	const box = { x: 0.25, y: 0.3, w: 0.12, h: 0.3 };
	const proof = createCompositionSubjectProtection({
		context,
		target: {
			ref: "s0",
			sceneId: context.sceneId,
			shotIndex: 0,
			targetId: `target-${"a".repeat(64)}`,
			eventIds: ["event"],
			subjectLabels: ["robot"],
			subjectIndexes: [0],
			analysisDocumentHash: context.analysisDocumentHash,
			timeMapHash: context.timeMapHash,
			protectedBoxes: [box],
			decision: "CROP",
			reason: "STORY_SUBJECT_MATCHED",
		},
		seedSourceTimeUs: 100_000_000,
		samples: [
			{ sourceTimeUs: 100_000_000, box, confidence: 0.99 },
			{ sourceTimeUs: 100_333_334, box: { ...box, x: 0.26 }, confidence: 0.99 },
			{ sourceTimeUs: 100_666_667, box: { ...box, x: 0.27 }, confidence: 0.99 },
		],
	});
	return {
		proof,
		context,
		frame: 5,
		rect: { x: 0.2, y: 0.2, w: 0.25, h: 0.5 },
		origin: "AUTO_POLICY",
	};
}
it("permits only a protected crop bracketed by measured samples in the pinned source clock", () => {
	expect(isSubjectProtectionValid(fixture())).toBe(true);
	expect(isSubjectProtectionValid({ ...fixture(), frame: 21 })).toBe(false);
});
it("fails closed on stale media, analysis, source clock, framing, geometry and manual adoption", () => {
	for (const change of [
		{ mediaSha256: "9".repeat(64) },
		{ analysisDocumentHash: "9".repeat(64) },
		{ sourceInUs: 100_033_334 },
		{ framingHash: "9".repeat(64) },
		{ sourceWidth: 1280 },
	])
		expect(
			isSubjectProtectionValid({
				...fixture(),
				context: { ...context, ...change },
			}),
		).toBe(false);
	expect(isSubjectProtectionValid({ ...fixture(), origin: "MANUAL" })).toBe(
		false,
	);
	expect(isSubjectProtectionValid({ ...fixture(), proof: undefined })).toBe(
		false,
	);
});
it("does not allow a crop cutting the protected object or a pan/zoom discontinuity", () => {
	expect(
		isSubjectProtectionValid({
			...fixture(),
			rect: { x: 0.3, y: 0.2, w: 0.25, h: 0.5 },
		}),
	).toBe(false);
	const f = fixture();
	if (!f.proof) throw new Error("Missing fixture proof");
	fixtureItem(f.proof.samples[1]).box.x = 0.7;
	expect(
		isSubjectProtectionValid({ ...f, rect: { x: 0, y: 0, w: 1, h: 1 } }),
	).toBe(false);
});
