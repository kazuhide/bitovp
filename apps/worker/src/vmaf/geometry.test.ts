import { describe, expect, it } from "vitest";
import { pixelFormatFromProbe } from "./geometry";

describe("pixelFormatFromProbe", () => {
	const probe = (streams: unknown) => JSON.stringify({ streams });

	it("names the pixel format of the first video stream", () => {
		expect(
			pixelFormatFromProbe(
				probe([
					{ codec_type: "audio", pix_fmt: "not a picture" },
					{ codec_type: "video", pix_fmt: "yuv422p10le" },
					{ codec_type: "video", pix_fmt: "yuv420p" },
				]),
			),
		).toBe("yuv422p10le");
	});

	it("names none when ffprobe's output holds none", () => {
		for (const stdout of [
			undefined,
			"",
			"not JSON",
			"null",
			"{}",
			probe([]),
			probe([{ codec_type: "audio", pix_fmt: "yuv420p" }]),
			probe([{ codec_type: "video" }]),
			probe([{ codec_type: "video", pix_fmt: 420 }]),
			probe([{ codec_type: "video", pix_fmt: null }]),
		])
			expect(pixelFormatFromProbe(stdout), String(stdout)).toBeUndefined();
	});
});
