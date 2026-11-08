import { describe, expect, it } from "vitest";
import { isManagedEditingObjectKey } from "./editing-namespace";

describe("reserved Content Library editing output namespace", () => {
	it.each([
		"bitovp-editing",
		"bitovp-editing/prepared.mp4",
		"exports/bitovp-editing/render/one.mp4",
		"exports//bitovp-editing//one.mp4",
		"/bitovp-editing/one.mp4",
		"exports/bitovp-editing/",
		"exports/BITOVP-EDITING/video.mp4",
		"exports/BitOVP-Editing/video.mp4",
	])("reserves the exact path segment regardless of credential or bucket: %s", (key) => {
		expect(isManagedEditingObjectKey(key)).toBe(true);
	});
	it.each([
		"",
		"video.mp4",
		"bitovp-editing-old/video.mp4",
		"not-bitovp-editing/video.mp4",
		"exports/bitovp-editing.mp4",
		"exports/%62itovp-editing/video.mp4",
		"exports/bitovp-editing%2Fvideo.mp4",
		"exports\\bitovp-editing\\video.mp4",
	])("preserves distinct raw storage keys without prefix or URL reinterpretation: %s", (key) => {
		expect(isManagedEditingObjectKey(key)).toBe(false);
	});
});
