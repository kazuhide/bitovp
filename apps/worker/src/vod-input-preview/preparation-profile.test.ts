import { describe, expect, it } from "vitest";
import { vodInputPreparationProfile } from "./media-profile";

const video = {
	streamIndex: 0,
	width: 1920,
	height: 1080,
	displayAspectRatio: { num: 16, den: 9 },
	frameRate: { num: 30000, den: 1001 },
	pixelFormat: "yuv420p",
	colorTransfer: "bt709",
	colorPrimaries: "bt709",
	colorSpace: "bt709",
};
describe("cloud input preparation quality", () => {
	it("keeps full resolution and rational source frame rate", () => {
		expect(vodInputPreparationProfile(video, [video])).toMatchObject({
			width: 1920,
			height: 1080,
			fps: "30000/1001",
			crf: "12",
			audioBitrate: "320k",
		});
	});
	it.each([
		{ pixelFormat: "yuv420p10le" },
		{ colorTransfer: "smpte2084" },
		{ colorTransfer: "arib-std-b67" },
		{ pixelFormat: undefined },
		{ colorSpace: undefined },
		{ frameRate: undefined },
	])("refuses unsupported or unmeasured conversion %o", (patch) => {
		expect(() =>
			vodInputPreparationProfile({ ...video, ...patch }, [
				{ ...video, ...patch },
			]),
		).toThrowError();
	});
});
