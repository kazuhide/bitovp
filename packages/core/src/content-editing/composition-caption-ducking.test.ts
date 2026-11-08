import { describe, expect, it } from "vitest";
import {
	compileComposition,
	evaluateCompositionAudio,
} from "./composition-frame";
import { compositionDocumentSchema } from "./composition-schema";
import {
	compositionFixture,
	compositionIds,
} from "./composition-test-fixtures";

const caption = (index: number, fromFrame = 10, toFrame = 20) => ({
	id: `77777777-7777-4777-8777-${String(index).padStart(12, "0")}`,
	fromFrame,
	toFrame,
	text: "Measured or editor-supplied caption",
});
function fixture(linked = true, count = 1) {
	const f = compositionFixture();
	f.document.captions = Array.from({ length: count }, (_, index) =>
		caption(index),
	);
	f.document.audioTracks = [
		{
			id: compositionIds.item,
			mediaVersionId: compositionIds.media,
			sourceInUs: 1_000_000,
			timelineStartFrame: 0,
			durationFrames: 90,
			gainDb: 0,
			fadeInFrames: 0,
			fadeOutFrames: 0,
			ducking: {
				...(linked ? { source: "CAPTIONS" as const } : {}),
				gainDb: -18,
				attackFrames: 0,
				releaseFrames: 0,
				intervals: [{ fromFrame: 60, toFrame: 75 }],
			},
		},
	];
	return f;
}
const gain = (f: ReturnType<typeof fixture>, frame: number) =>
	evaluateCompositionAudio(
		compileComposition(f.document, [f.source]),
		frame,
	).find((item) => item.id === `track:${compositionIds.item}`)?.gain;
const low = 10 ** (-18 / 20);

describe("caption-linked music ducking compiles from the current captions", () => {
	it("follows moved caption boundaries instead of retaining a saved snapshot", () => {
		const f = fixture();
		expect(gain(f, 15)).toBeCloseTo(low);
		f.document.captions = [caption(0, 40, 50)];
		expect(gain(f, 15)).toBe(1);
		expect(gain(f, 45)).toBeCloseTo(low);
		expect(gain(f, 65)).toBe(1);
	});
	it("follows added captions and removes only the deleted caption's region", () => {
		const f = fixture();
		f.document.captions?.push(caption(1, 40, 50));
		expect(gain(f, 15)).toBeCloseTo(low);
		expect(gain(f, 45)).toBeCloseTo(low);
		f.document.captions = f.document.captions?.filter(
			(item) => item.id !== caption(0).id,
		);
		expect(gain(f, 15)).toBe(1);
		expect(gain(f, 45)).toBeCloseTo(low);
	});
	it("has no ducked region after all captions are removed", () => {
		const f = fixture();
		f.document.captions = [];
		expect(gain(f, 15)).toBe(1);
		expect(gain(f, 65)).toBe(1);
		delete f.document.captions;
		expect(gain(f, 15)).toBe(1);
	});
	it("derives automation without changing the stored input or plan document", () => {
		const f = fixture(),
			before = JSON.stringify(f.document);
		const plan = compileComposition(f.document, [f.source]);
		expect(
			plan.audio.find((item) => item.kind === "TRACK")?.automation.ducking
				?.intervals,
		).toEqual([{ fromFrame: 10, toFrame: 20 }]);
		expect(JSON.stringify(f.document)).toBe(before);
		expect(plan.document).toEqual(JSON.parse(before));
	});
	it("keeps absent-source legacy fixed regions unchanged through caption edits", () => {
		const f = fixture(false);
		expect(gain(f, 15)).toBe(1);
		expect(gain(f, 65)).toBeCloseTo(low);
		f.document.captions = [caption(0, 40, 50)];
		expect(gain(f, 45)).toBe(1);
		expect(gain(f, 65)).toBeCloseTo(low);
		f.document.captions = [];
		expect(gain(f, 65)).toBeCloseTo(low);
		expect(
			compositionDocumentSchema.parse(f.document).audioTracks?.[0]?.ducking,
		).not.toHaveProperty("source");
	});
	it("accepts 64 linked captions and rejects 65 with an explicit validation issue", () => {
		const f = fixture(true, 64);
		expect(compositionDocumentSchema.safeParse(f.document).success).toBe(true);
		f.document.captions?.push(caption(64));
		const result = compositionDocumentSchema.safeParse(f.document);
		expect(result.success).toBe(false);
		if (!result.success)
			expect(
				result.error.issues.some((issue) =>
					/64.*caption|caption.*64/i.test(issue.message),
				),
			).toBe(true);
	});
	it("retains 300-caption support for legacy fixed regions and documents without ducking", () => {
		const f = fixture(false, 300);
		expect(compositionDocumentSchema.safeParse(f.document).success).toBe(true);
		const track = f.document.audioTracks?.[0];
		if (!track) throw new Error("Missing audio fixture");
		delete track.ducking;
		expect(compositionDocumentSchema.safeParse(f.document).success).toBe(true);
	});
	it("keeps the explicit interval cap at 64 in both modes", () => {
		for (const linked of [false, true]) {
			const f = fixture(linked),
				ducking = f.document.audioTracks?.[0]?.ducking;
			if (!ducking) throw new Error("Missing ducking fixture");
			ducking.intervals = Array.from({ length: 64 }, () => ({
				fromFrame: 1,
				toFrame: 2,
			}));
			expect(compositionDocumentSchema.safeParse(f.document).success).toBe(
				true,
			);
			ducking.intervals.push({ fromFrame: 1, toFrame: 2 });
			expect(compositionDocumentSchema.safeParse(f.document).success).toBe(
				false,
			);
		}
	});
});
