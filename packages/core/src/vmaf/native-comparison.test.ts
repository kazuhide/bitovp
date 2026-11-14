import { describe, expect, it } from "vitest";
import {
	VMAF_GPU_PAIR_REASONS,
	type VmafProbedVideo,
	vmafNativeComparison,
	vmafNativeFrameTimes,
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
 * `f712fa7`) with the command of a Local CPU measurement by the ordinary
 * method, its `fps` filter included, which was on the encode alone then,
 * against the CPU reference of the GPU scorer at the named bit depth, on the
 * same two files. With the filter on both inputs, on 2026-11-14, the command
 * gave the same score for each of these pairs. Each line is one
 * combination of what ffprobe says of the reference and of the encode (pixel
 * format, range, colour matrix), the bit depth given to the scorer, the number
 * of comparisons measured, and the largest difference of the two mean scores.
 * A pair of files that was scored with several models counts once for each.
 * The files were encodes of 128x72 to 640x360 in H.264, AV1 and FFV1 against
 * references of 640x360 in H.264, ProRes and FFV1, and pairs of one size from
 * 160x216 to 1920x1080, of 24 or 48 frames, with three VMAF v1 models. A
 * full-range encode was measured scaled and at the reference's size: FFmpeg
 * converts the two in different ways. "GPU scoring and libvmaf through FFmpeg"
 * in docs/FFMPEG-BUILD.md records them, and ten further comparisons that are
 * not in this list: five that were too small for the model, and five at widths
 * where libvmaf's score depends on its thread count.
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
	[["yuvj420p", "pc"], ["yuv420p10le"], 10, 1, 13.254648],
	[["yuv420p10le", "pc"], ["yuv420p10le"], 10, 1, 3.684738],
	[["yuv420p10le"], ["yuv420p10le", "pc"], 10, 1, 11.641452],
	[["yuv420p"], ["yuvj420p", "pc"], 8, 1, 10.453317],
	[["yuvj420p", "pc"], ["yuvj420p", "pc"], 8, 3, 0.0],
	[["yuvj420p", "pc"], ["yuv420p10le", "pc"], 8, 1, 0.015387],
	[["yuvj420p", "pc"], ["yuvj422p", "pc"], 8, 1, 1.019388],
	[["yuv420p10le", "pc"], ["yuv420p10le", "pc"], 10, 2, 0.0],
	[["yuv420p10le", "pc"], ["yuvj420p", "pc"], 10, 2, 0.0],
	[["yuv420p10le", "pc"], ["yuvj422p", "pc"], 10, 2, 0.0],
	// 8-bit full range under the name `yuv420p`, as ffprobe gives it for a
	// full-range AV1 or FFV1 file (H.264 becomes `yuvj420p`).
	[["yuv420p", "pc"], ["yuv420p", "pc"], 8, 3, 0.0],
	[["yuv420p", "pc"], ["yuvj420p", "pc"], 8, 2, 0.0],
	[["yuvj420p", "pc"], ["yuv420p", "pc"], 8, 2, 0.0],
	[["yuv420p", "pc"], ["yuvj422p", "pc"], 8, 2, 0.0],
	[["yuv420p", "pc"], ["yuv420p10le", "pc"], 8, 2, 0.0],
	[["yuv420p10le", "pc"], ["yuv420p", "pc"], 10, 3, 0.0],
	[["yuv420p", "pc"], ["yuv420p"], 8, 1, 11.673198],
	[["yuv420p"], ["yuv420p", "pc"], 8, 1, 2.149615],
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
		for (const [reference, encode, bits, comparisons, difference] of MEASURED) {
			const comparison = vmafNativeComparison(
				video(...reference),
				video(...encode),
			);
			const label = `${reference.join(" ")} / ${encode.join(" ")}`;
			if (difference === 0) {
				expect(comparison, label).toEqual({ bitDepth: bits });
				equal += comparisons;
			} else {
				expect(comparison, label).toHaveProperty("refusal");
				different += comparisons;
			}
		}
		// The numbers that the module's comment names.
		expect([equal, different]).toEqual([97, 22]);
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
			reason: "GPU_PAIR_PIXEL_FORMAT",
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
			refusal: `${start}the reference's pixel format is yuvj420p and the encode's is yuvj422p, and FFmpeg converts such a reference to the encode's format, which GPU scoring compares for an 8-bit 4:2:0 encode only${end}`,
			reason: "GPU_PAIR_PIXEL_FORMAT",
		});
		expect(
			vmafNativeComparison(video("yuvj420p", "pc"), video(undefined)),
		).toEqual({
			refusal: `${start}the reference's pixel format is yuvj420p and the encode's is not known, and FFmpeg converts such a reference to the encode's format, which GPU scoring compares for an 8-bit 4:2:0 encode only${end}`,
			reason: "GPU_PAIR_PIXEL_FORMAT",
		});
		// The encode's format is then the scorer's 8-bit 4:2:0 picture under
		// either of ffprobe's names, and the range decides.
		for (const encode of ["yuvj420p", "yuv420p"])
			expect(
				vmafNativeComparison(video("yuvj420p", "pc"), video(encode, "pc")),
				encode,
			).toEqual({ bitDepth: 8 });
		expect(
			vmafNativeComparison(video("yuvj420p", "pc"), video("yuv420p")),
		).toEqual({
			refusal: `${start}the reference is full range and the encode is limited range, and FFmpeg converts one of the two before libvmaf compares them${end}`,
			reason: "GPU_PAIR_COLOR_RANGE",
		});
	});

	it("refuses an encode in a format that libvmaf does not take, converted or not", () => {
		const start =
			"GPU scoring cannot compare this pair as libvmaf through FFmpeg does: ";
		expect(vmafNativeComparison(video("yuv420p"), video("gbrp"))).toEqual({
			refusal: `${start}GPU scoring takes no encode in the pixel format gbrp. Use Local CPU for this pair.`,
			reason: "GPU_PAIR_PIXEL_FORMAT",
		});
		expect(vmafNativeComparison(video("yuv420p"), video())).toEqual({
			refusal: `${start}the encode's pixel format is not known. Use Local CPU for this pair.`,
			reason: "GPU_PAIR_PIXEL_FORMAT",
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
			reason: "GPU_PAIR_COLOR_RANGE",
		});
		// ffprobe names an 8-bit full-range file by its format, whatever the tag.
		expect(vmafNativeComparison(video("yuv420p"), video("yuvj420p"))).toEqual({
			refusal: `${start}the reference is limited range and the encode is full range${end}`,
			reason: "GPU_PAIR_COLOR_RANGE",
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
			reason: "GPU_PAIR_COLOR_MATRIX",
		});
		expect(
			vmafNativeComparison(
				video("yuv420p", undefined, "unknown"),
				video("yuv420p", "tv", "smpte170m"),
			),
		).toEqual({
			refusal: `${start}the reference names no colour matrix and the encode names the colour matrix smpte170m${end}`,
			reason: "GPU_PAIR_COLOR_MATRIX",
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

/** A video stream by its frame rates and frame count, as ffprobe gives them. */
const timed = (
	r_frame_rate?: unknown,
	avg_frame_rate?: unknown,
	nb_frames?: unknown,
): VmafProbedVideo => ({
	...(r_frame_rate === undefined ? {} : { r_frame_rate }),
	...(avg_frame_rate === undefined ? {} : { avg_frame_rate }),
	...(nb_frames === undefined ? {} : { nb_frames }),
});

describe("the pairs whose frames the GPU scorer pairs as libvmaf through FFmpeg does", () => {
	const start =
		"GPU scoring cannot compare this pair as libvmaf through FFmpeg does: ";
	const slots =
		", and FFmpeg gives each file one frame per slot of the reference's frame rate, repeating and dropping frames, before libvmaf compares them. Use Local CPU for this pair.";

	it("lets through two files that have a frame in every slot of one frame rate", () => {
		// What ffprobe gave on 2026-11-14 for evenly spaced files of 12 to 60
		// frames a second in MP4, fragmented MP4, QuickTime, Matroska, WebM and
		// MPEG-TS: the two rates equal, and a frame count where the container
		// holds one.
		for (const [rate, value] of [
			["24/1", 24],
			["25/1", 25],
			["24000/1001", 24000 / 1001],
			["30000/1001", 30000 / 1001],
			["60000/1001", 60000 / 1001],
			["12/1", 12],
		] as const) {
			expect(
				vmafNativeFrameTimes(timed(rate, rate, "72"), timed(rate, rate, "72")),
				rate,
			).toEqual({ frameRate: value });
			// Matroska, WebM, MPEG-TS and fragmented MP4 give no frame count.
			expect(
				vmafNativeFrameTimes(timed(rate, rate), timed(rate, rate, "72")),
				rate,
			).toEqual({ frameRate: value });
			expect(
				vmafNativeFrameTimes(timed(rate, rate), timed(rate, rate)),
				rate,
			).toEqual({ frameRate: value });
		}
		// One rate under two spellings.
		expect(
			vmafNativeFrameTimes(timed("30/1", "30/1"), timed("30", "60/2")),
		).toEqual({ frameRate: 30 });
	});

	it("refuses two files for which ffprobe names two frame rates, as the scorer does", () => {
		// The worker image's ffprobe (n8.1.3) on 2026-11-14, for evenly spaced
		// files of 60000/1001 frames a second: 19001/317 for a Matroska and a
		// WebM file, whose frame duration is in nanoseconds, and 60000/1001 for
		// MP4, QuickTime and MPEG-TS. FFmpeg's filter gave each of them 180
		// frames for 180, and the scorer by itself refused the pair of a
		// Matroska and an MP4 file ("Inputs must have the same known frame
		// rate"): its line is a millionth of a frame a second.
		const matroska = timed("19001/317", "19001/317");
		const mp4 = timed("60000/1001", "60000/1001", "180");
		expect(vmafNativeFrameTimes(matroska, mp4)).toEqual({
			refusal: `${start}the reference's frame rate is 19001/317 and the encode's is 60000/1001, and GPU scoring takes two files only where FFmpeg names one frame rate for both. Use Local CPU for this pair.`,
			reason: "GPU_PAIR_FRAME_TIMES",
		});
		expect(vmafNativeFrameTimes(mp4, matroska)).toEqual({
			refusal: `${start}the reference's frame rate is 60000/1001 and the encode's is 19001/317, and GPU scoring takes two files only where FFmpeg names one frame rate for both. Use Local CPU for this pair.`,
			reason: "GPU_PAIR_FRAME_TIMES",
		});
		// Two such files have one name, and the scorer scored the pair.
		expect(
			vmafNativeFrameTimes(matroska, timed("19001/317", "19001/317")),
		).toEqual({ frameRate: 19001 / 317 });
		// 23.976 for 24000/1001 is 0.000024 of a frame a second off.
		expect(
			vmafNativeFrameTimes(
				timed("24000/1001", "24000/1001", "240"),
				timed("2997/125", "2997/125", "240"),
			),
		).toHaveProperty("reason", "GPU_PAIR_FRAME_TIMES");
	});

	it("refuses a file that leaves slots out, the reference first", () => {
		// The files of the measurement of 2026-11-14: 40 frames over 47 slots.
		const uneven = timed("24/1", "960/47", "40");
		const even = timed("24/1", "24/1", "48");
		expect(vmafNativeFrameTimes(uneven, uneven)).toEqual({
			refusal: `${start}the reference's frames are not evenly spaced by what ffprobe says of it (r_frame_rate 24/1, avg_frame_rate 960/47)${slots}`,
			reason: "GPU_PAIR_FRAME_TIMES",
		});
		expect(vmafNativeFrameTimes(uneven, even)).toEqual({
			refusal: `${start}the reference's frames are not evenly spaced by what ffprobe says of it (r_frame_rate 24/1, avg_frame_rate 960/47)${slots}`,
			reason: "GPU_PAIR_FRAME_TIMES",
		});
		expect(vmafNativeFrameTimes(even, uneven)).toEqual({
			refusal: `${start}the encode's frames are not evenly spaced by what ffprobe says of it (r_frame_rate 24/1, avg_frame_rate 960/47)${slots}`,
			reason: "GPU_PAIR_FRAME_TIMES",
		});
	});

	it("refuses a file that leaves a single frame out, and takes one whose duration is a part of a slot off", () => {
		const even = timed("30000/1001", "30000/1001", "300");
		// 300 slots of 30000/1001 with frame 100 left out, as ffprobe gave it
		// for an MP4 file on 2026-11-14: 299 frames over the duration of 300.
		expect(
			vmafNativeFrameTimes(timed("30000/1001", "2300/77", "299"), even),
		).toHaveProperty("reason", "GPU_PAIR_FRAME_TIMES");
		// The same file as fragmented MP4, which gives no frame count.
		expect(
			vmafNativeFrameTimes(even, timed("30000/1001", "2300/77")),
		).toHaveProperty("reason", "GPU_PAIR_FRAME_TIMES");
		// 300 frames whose duration is a third of a slot longer than 300 slots:
		// the two rates differ in their last digits, as on many real files.
		const rounded = timed("30000/1001", "300000/10021", "300");
		expect(vmafNativeFrameTimes(rounded, even)).toEqual({
			frameRate: 30000 / 1001,
		});
		expect(vmafNativeFrameTimes(even, rounded)).toEqual({
			frameRate: 30000 / 1001,
		});
		// Without a frame count nothing says how far off the duration is, and
		// the file is taken to be as long as none is.
		expect(
			vmafNativeFrameTimes(timed("30000/1001", "300000/10021"), even),
		).toHaveProperty("reason", "GPU_PAIR_FRAME_TIMES");
		// Two names of one rate are no such difference.
		expect(
			vmafNativeFrameTimes(
				timed("60000/1001", "19001/317"),
				timed("60000/1001", "60000/1001"),
			),
		).toEqual({ frameRate: 60000 / 1001 });
		// Half a slot is the line: 300 frames over 299.4 slots, and over 299.6.
		const thirty = timed("30/1", "30/1", "300");
		expect(
			vmafNativeFrameTimes(timed("30/1", "15000/499", "300"), thirty),
		).toHaveProperty("reason", "GPU_PAIR_FRAME_TIMES");
		expect(
			vmafNativeFrameTimes(timed("30/1", "22500/749", "300"), thirty),
		).toEqual({ frameRate: 30 });
		// A file whose slots are twice its frames, as ffprobe gives it for some
		// interlaced files.
		expect(
			vmafNativeFrameTimes(timed("50/1", "25/1", "250"), timed("50/1", "50/1")),
		).toHaveProperty("reason", "GPU_PAIR_FRAME_TIMES");
	});

	it("refuses a file of which ffprobe does not say both rates", () => {
		const even = timed("24/1", "24/1");
		for (const [r, average, said] of [
			[undefined, "24/1", "r_frame_rate not given, avg_frame_rate 24/1"],
			["24/1", undefined, "r_frame_rate 24/1, avg_frame_rate not given"],
			["0/0", "24/1", "r_frame_rate 0/0, avg_frame_rate 24/1"],
			["24/1", "0/0", "r_frame_rate 24/1, avg_frame_rate 0/0"],
			["24/0", "24/1", "r_frame_rate 24/0, avg_frame_rate 24/1"],
			["-24/1", "24/1", "r_frame_rate -24/1, avg_frame_rate 24/1"],
			["24.0", "24/1", "r_frame_rate 24.0, avg_frame_rate 24/1"],
			["", "", "r_frame_rate , avg_frame_rate "],
			[24, 24, "r_frame_rate 24, avg_frame_rate 24"],
			[null, {}, "r_frame_rate not given, avg_frame_rate not given"],
		] as const) {
			expect(vmafNativeFrameTimes(timed(r, average), even), said).toEqual({
				refusal: `${start}the reference's frames are not evenly spaced by what ffprobe says of it (${said})${slots}`,
				reason: "GPU_PAIR_FRAME_TIMES",
			});
			expect(vmafNativeFrameTimes(even, timed(r, average)), said).toEqual({
				refusal: `${start}the encode's frames are not evenly spaced by what ffprobe says of it (${said})${slots}`,
				reason: "GPU_PAIR_FRAME_TIMES",
			});
		}
	});

	it("refuses two files of different frame rates", () => {
		expect(
			vmafNativeFrameTimes(timed("24/1", "24/1"), timed("25/1", "25/1")),
		).toEqual({
			refusal: `${start}the reference's frame rate is 24/1 and the encode's is 25/1, and GPU scoring takes two files only where FFmpeg names one frame rate for both. Use Local CPU for this pair.`,
			reason: "GPU_PAIR_FRAME_TIMES",
		});
		// Whatever the count that ffprobe gives or does not give: an encode of
		// half the reference's rate is one of the pairs.
		for (const [reference, encode, frames] of [
			["30000/1001", "30/1", "100"],
			["30/1", "30000/1001", "100"],
			["30000/1001", "30/1", undefined],
			["60/1", "30/1", "2"],
			["60000/1001", "30000/1001", "600"],
			["25/1", "24/1", "13"],
		] as const) {
			const label = `${reference} / ${encode} (${frames})`;
			expect(
				vmafNativeFrameTimes(
					timed(reference, reference, frames),
					timed(encode, encode, frames),
				),
				label,
			).toHaveProperty("reason", "GPU_PAIR_FRAME_TIMES");
			expect(
				vmafNativeFrameTimes(
					timed(reference, reference),
					timed(encode, encode, frames),
				),
				label,
			).toHaveProperty("reason", "GPU_PAIR_FRAME_TIMES");
		}
	});

	it("refuses two files of different frame counts, where ffprobe counts both", () => {
		expect(
			vmafNativeFrameTimes(
				timed("24/1", "24/1", "240"),
				timed("24/1", "24/1", "239"),
			),
		).toEqual({
			refusal: `${start}the reference has 240 frames and the encode 239, and GPU scoring compares two files of the same number of frames. Use Local CPU for this pair.`,
			reason: "GPU_PAIR_FRAME_TIMES",
		});
		// A count is a string in ffprobe's JSON; a number is read as well.
		expect(
			vmafNativeFrameTimes(
				timed("24/1", "24/1", 240),
				timed("24/1", "24/1", "240"),
			),
		).toEqual({ frameRate: 24 });
		for (const count of [undefined, "N/A", "", "0", "-3", "2.5", null])
			expect(
				vmafNativeFrameTimes(
					timed("24/1", "24/1", "240"),
					timed("24/1", "24/1", count),
				),
				String(count),
			).toEqual({ frameRate: 24 });
	});

	it("gives every refusal a kind that a result can keep as the reason of its selection", () => {
		// `localVmafExecutionSchema` takes this form for `selection.reason`.
		for (const reason of VMAF_GPU_PAIR_REASONS)
			expect(reason).toMatch(/^[A-Z][A-Z0-9_]{0,95}$/);
		const refusals = [
			vmafNativeComparison(video("yuv444p"), video("yuv420p")),
			vmafNativeComparison(video("yuv420p"), video("gbrp")),
			vmafNativeComparison(video("yuv420p", "pc"), video("yuv420p")),
			vmafNativeComparison(video("yuv420p", "tv", "bt709"), video("yuv420p")),
			vmafNativeFrameTimes(timed("24/1", "960/47"), timed("24/1", "24/1")),
		];
		expect(
			refusals.map((refusal) => ("reason" in refusal ? refusal.reason : null)),
		).toEqual([
			"GPU_PAIR_PIXEL_FORMAT",
			"GPU_PAIR_PIXEL_FORMAT",
			"GPU_PAIR_COLOR_RANGE",
			"GPU_PAIR_COLOR_MATRIX",
			"GPU_PAIR_FRAME_TIMES",
		]);
		for (const refusal of refusals)
			expect(VMAF_GPU_PAIR_REASONS).toContain(
				"reason" in refusal ? refusal.reason : null,
			);
	});
});
