import { describe, expect, it } from "vitest";
import {
	assertEditingBinding,
	initialEditingDocument,
} from "./library-editing-common";

const id = "11111111-1111-4111-8111-111111111111";
const map = {
	id,
	mediaVersionId: id,
	kind: "CFR",
	sourceStartUs: 0,
	sourceEndUs: 60_000_000,
	editingStartFrame: 0,
	editingEndFrame: 1800,
	fps: { num: 30, den: 1 },
};
describe("library editing bindings", () => {
	it("starts from fixed media with a bounded manual interval", () => {
		const document = initialEditingDocument({ id, timeMap: map }, "PORTRAIT");
		expect(document.clips[0]?.durationFrames).toBe(900);
		expect(document.analysisRevisionId).toBeNull();
		expect(document.canvas).toEqual({ width: 1080, height: 1920 });
		expect(document.clips[0]?.framing[0]?.origin).toBe("MANUAL");
	});
	it("rejects documents that name a different fixed media version", () => {
		const document = initialEditingDocument({ id, timeMap: map }, "LANDSCAPE");
		expect(() =>
			assertEditingBinding(document, {
				id: "22222222-2222-4222-8222-222222222222",
				timeMap: map,
			}),
		).toThrow();
	});
	it("rejects an interval outside the fixed media mapping", () => {
		const document = initialEditingDocument({ id, timeMap: map }, "LANDSCAPE");
		const clip = document.clips[0];
		if (!clip) throw new Error("An initial clip is required");
		clip.sourceInUs = 59_000_000;
		expect(() =>
			assertEditingBinding(document, { id, timeMap: map }),
		).toThrow();
	});
});
