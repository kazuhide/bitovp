import { describe, expect, it } from "vitest";
import {
	type VmafProbedVideo,
	vmafNativeComparison,
} from "./native-comparison";

const video = (
	pix_fmt?: string,
	color_range?: string,
	color_space?: string,
): VmafProbedVideo => ({
	...(pix_fmt === undefined ? {} : { pix_fmt }),
	...(color_range === undefined ? {} : { color_range }),
	...(color_space === undefined ? {} : { color_space }),
});

/**
 * Comparisons of 2026-11-13: the worker image's FFmpeg (n8.1.3, libvmaf
 * `f712fa7`) with the worker's command of the ordinary method, against the CPU
 * reference of the GPU scorer at the named bit depth, on the same two files.
 * Each line is one combination of what ffprobe says of the reference and of
 * the encode (pixel format, range, colour matrix), the bit depth given to the
 * scorer, the number of pairs measured, and the largest difference of the two
 * mean scores. The pairs were encodes of 128x72 to 640x360 in H.264, AV1 and
 * FFV1 against references of 640x360 in H.264, ProRes and FFV1, and pairs of
 * one size from 240x160 to 1920x1080, of 24 or 48 frames, with three VMAF v1
 * models. "GPU scoring and libvmaf through FFmpeg" in docs/FFMPEG-BUILD.md
 * records them, and ten further comparisons that are not in this list.
 */
const MEASURED = [
	[["yuv420p"], ["yuv420p"], 8, 42, 0.0],
	[["yuv420p"], ["yuv420p10le"], 8, 6, 0.0],
	[["yuv420p"], ["yuv422p"], 8, 3, 0.0],
	[["yuv420p"], ["yuv444p"], 8, 1, 0.0],
	[["yuv420p"], ["yuv422p10le"], 8, 1, 0.0],
	[["yuv420p"], ["yuv420p12le", "tv"], 8, 1, 0.0],
	[["yuv420p"], ["yuv420p", "tv"], 8, 2, 0.0],
	[["yuv420p", "tv"], ["yuv420p"], 8, 1, 0.0],
	[["yuv420p10le"], ["yuv420p"], 10, 5, 0.0],
	[["yuv420p10le"], ["yuv420p10le"], 10, 4, 0.0],
	[["yuv420p10le"], ["yuv422p"], 10, 2, 0.0],
	[["yuv420p10le"], ["yuv444p"], 10, 1, 0.0],
	[["yuv420p10le"], ["yuv422p10le"], 10, 1, 0.0],
	[["yuv420p10le"], ["yuv420p12le", "tv"], 10, 1, 0.0],
	[["yuv420p10le"], ["yuv420p", "tv"], 10, 1, 0.0],
	// A reference in another layout or with more bits.
	[["yuv422p10le", "tv"], ["yuv420p"], 10, 2, 4.412912],
	[["yuv422p"], ["yuv420p"], 8, 2, 3.901499],
	[["yuv444p"], ["yuv420p"], 8, 2, 5.659261],
	[["yuv420p12le", "tv"], ["yuv420p"], 10, 2, 0.04894],
	// Full range on one side, and on both.
	[["yuvj420p", "pc"], ["yuv420p"], 8, 2, 12.542433],
	[["yuvj420p", "pc"], ["yuv420p10le"], 8, 1, 13.244326],
	[["yuvj420p", "pc"], ["yuv420p10le"], 10, 1, 13.130959],
	[["yuv420p10le", "pc"], ["yuv420p10le"], 10, 1, 3.684738],
	[["yuv420p10le"], ["yuv420p10le", "pc"], 10, 1, 11.641452],
	[["yuv420p"], ["yuvj420p", "pc"], 8, 1, 10.453317],
	[["yuvj420p", "pc"], ["yuvj420p", "pc"], 8, 4, 0.0],
	[["yuvj420p", "pc"], ["yuv420p10le", "pc"], 8, 1, 0.015387],
	[["yuvj420p", "pc"], ["yuvj422p", "pc"], 8, 1, 1.019388],
	[["yuv420p10le", "pc"], ["yuv420p10le", "pc"], 10, 1, 0.0],
	[["yuv420p10le", "pc"], ["yuvj420p", "pc"], 10, 1, 0.0],
	[["yuv420p10le", "pc"], ["yuvj422p", "pc"], 10, 1, 0.0],
	// The same pixel data with other colour matrix tags.
	[["yuv420p", "tv", "bt709"], ["yuv420p", "tv", "bt709"], 8, 1, 0.0],
	[["yuv420p", "tv", "smpte170m"], ["yuv420p", "tv", "smpte170m"], 8, 1, 0.0],
	[["yuv420p", "tv", "bt709"], ["yuv420p"], 8, 1, 1.472369],
	[["yuv420p"], ["yuv420p", "tv", "bt709"], 8, 1, 10.10828],
	[["yuv420p", "tv", "bt709"], ["yuv420p", "tv", "smpte170m"], 8, 1, 1.472369],
] as const;

describe("what the GPU scorer compares to give the score of libvmaf through FFmpeg", () => {
	it("lets through exactly the measured combinations in which the two scores were equal, at the measured bit depth", () => {
		let equal = 0;
		let different = 0;
		for (const [reference, encode, bits, pairs, difference] of MEASURED) {
			const comparison = vmafNativeComparison(
				video(...reference),
				video(...encode),
			);
			const label = `${reference.join(" ")} / ${encode.join(" ")}`;
			if (difference === 0) {
				expect(comparison, label).toEqual({ bitDepth: bits });
				equal += pairs;
			} else {
				expect(comparison, label).toHaveProperty("refusal");
				different += pairs;
			}
		}
		// The numbers that the module's comment names.
		expect([equal, different]).toEqual([81, 20]);
	});

	it("compares at the reference's bit depth", () => {
		for (const encode of [
			"yuv420p",
			"yuv422p",
			"yuv444p",
			"yuv420p10le",
			"yuv422p10le",
			"yuv444p10le",
			"yuv420p12le",
			"yuv444p16le",
		]) {
			expect(
				vmafNativeComparison(video("yuv420p"), video(encode)),
				encode,
			).toEqual({ bitDepth: 8 });
			expect(
				vmafNativeComparison(video("yuv420p10le"), video(encode)),
				encode,
			).toEqual({ bitDepth: 10 });
		}
	});

	it("refuses a reference that libvmaf compares in another format, and says what to do", () => {
		const start =
			"GPU scoring cannot compare this pair as libvmaf through FFmpeg does: ";
		const end = ". Use Local CPU for this pair.";
		expect(
			vmafNativeComparison(video("yuv422p10le"), video("yuv420p")),
		).toEqual({
			refusal: `${start}the reference's pixel format is yuv422p10le, and GPU scoring compares 8-bit and 10-bit 4:2:0 pictures only, for references in yuv420p and yuv420p10le${end}`,
		});
		for (const format of [
			"yuv422p",
			"yuv444p",
			"yuv444p10le",
			"yuv420p12le",
			"yuv420p16le",
			"yuv420p10be",
			"yuv411p",
			"nv12",
			"gbrp",
			"gray",
			"unknown",
			"",
			undefined,
		]) {
			const comparison = vmafNativeComparison(video(format), video("yuv420p"));
			expect(comparison, String(format)).toHaveProperty("refusal");
			expect(JSON.stringify(comparison), String(format)).toContain(
				`the reference's pixel format is ${format && format !== "unknown" ? format : "not known"},`,
			);
		}
		// FFmpeg converts a full-range 8-bit reference to the encode's format.
		expect(
			vmafNativeComparison(video("yuvj420p", "pc"), video("yuvj422p", "pc")),
		).toEqual({
			refusal: `${start}the reference's pixel format is yuvj420p and the encode's is yuvj422p, and FFmpeg converts such a reference to the encode's format, which GPU scoring compares for a yuvj420p encode only${end}`,
		});
		expect(
			vmafNativeComparison(video("yuvj420p", "pc"), video(undefined)),
		).toEqual({
			refusal: `${start}the reference's pixel format is yuvj420p and the encode's is not known, and FFmpeg converts such a reference to the encode's format, which GPU scoring compares for a yuvj420p encode only${end}`,
		});
	});

	it("refuses an encode in a format that libvmaf does not take, converted or not", () => {
		const start =
			"GPU scoring cannot compare this pair as libvmaf through FFmpeg does: ";
		expect(vmafNativeComparison(video("yuv420p"), video("gbrp"))).toEqual({
			refusal: `${start}GPU scoring takes no encode in the pixel format gbrp. Use Local CPU for this pair.`,
		});
		expect(vmafNativeComparison(video("yuv420p"), video())).toEqual({
			refusal: `${start}the encode's pixel format is not known. Use Local CPU for this pair.`,
		});
		for (const format of [
			"nv12",
			"gray",
			"yuva420p",
			"yuv420p10be",
			"yuv411p",
			"yuvj411p",
			"rgb24",
			"p010le",
		])
			expect(
				vmafNativeComparison(video("yuv420p10le"), video(format)),
				format,
			).toHaveProperty("refusal");
	});

	it("refuses a pair of which one file is full range and the other is not", () => {
		const start =
			"GPU scoring cannot compare this pair as libvmaf through FFmpeg does: ";
		const end =
			", and FFmpeg converts one of the two before libvmaf compares them. Use Local CPU for this pair.";
		expect(
			vmafNativeComparison(
				video("yuv420p10le", "pc"),
				video("yuv420p10le", "tv"),
			),
		).toEqual({
			refusal: `${start}the reference is full range and the encode is limited range${end}`,
		});
		// ffprobe names an 8-bit full-range file by its format, whatever the tag.
		expect(vmafNativeComparison(video("yuv420p"), video("yuvj420p"))).toEqual({
			refusal: `${start}the reference is limited range and the encode is full range${end}`,
		});
		// A file that names no range counts as limited, as FFmpeg takes it.
		for (const range of [undefined, "tv", "unknown", "unspecified"])
			for (const other of [undefined, "tv", "unknown"])
				expect(
					vmafNativeComparison(
						video("yuv420p", range),
						video("yuv420p", other),
					),
					`${range} / ${other}`,
				).toEqual({ bitDepth: 8 });
		// Full range on both sides, where libvmaf takes the reference as it is.
		expect(
			vmafNativeComparison(video("yuv420p", "pc"), video("yuvj444p", "pc")),
		).toEqual({ bitDepth: 8 });
	});

	it("refuses a pair whose files name different colour matrices, or of which one names none", () => {
		const start =
			"GPU scoring cannot compare this pair as libvmaf through FFmpeg does: ";
		const end =
			", and FFmpeg, which takes a file that names none for BT.601, converts the encode to the reference's matrix before libvmaf compares them. Use Local CPU for this pair.";
		expect(
			vmafNativeComparison(
				video("yuv420p", "tv", "bt709"),
				video("yuv420p", "tv"),
			),
		).toEqual({
			refusal: `${start}the reference names the colour matrix bt709 and the encode names no colour matrix${end}`,
		});
		expect(
			vmafNativeComparison(
				video("yuv420p", undefined, "unknown"),
				video("yuv420p", "tv", "smpte170m"),
			),
		).toEqual({
			refusal: `${start}the reference names no colour matrix and the encode names the colour matrix smpte170m${end}`,
		});
		// Two names for one matrix count as two: such a pair was not measured,
		// and only what was measured equal is let through.
		expect(
			vmafNativeComparison(
				video("yuv420p", "tv", "bt470bg"),
				video("yuv420p", "tv", "smpte170m"),
			),
		).toHaveProperty("refusal");
		for (const matrix of [undefined, "unknown", "unspecified", ""])
			for (const other of [undefined, "unknown"])
				expect(
					vmafNativeComparison(
						video("yuv420p10le", "tv", matrix),
						video("yuv420p", undefined, other),
					),
					`${matrix} / ${other}`,
				).toEqual({ bitDepth: 10 });
	});

	it("reads nothing but strings from a probe", () => {
		expect(
			vmafNativeComparison(
				{ pix_fmt: 420, color_range: null, color_space: {} },
				{ pix_fmt: "yuv420p" },
			),
		).toHaveProperty("refusal");
		expect(
			vmafNativeComparison(
				{ pix_fmt: "yuv420p", color_range: 1, color_space: ["bt709"] },
				{ pix_fmt: "yuv420p", color_space: null },
			),
		).toEqual({ bitDepth: 8 });
	});
});
