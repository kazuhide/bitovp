import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	VMAF_NATIVE_SIZE_REFUSALS,
	VMAF_SPEED_CHROMA_PRESCALE,
	type VmafChromaLayout,
	vmafChromaLayout,
	vmafConvertedChromaLayout,
	vmafNativeSizeLimitFailureMessage,
	vmafSizeLimitFailureMessage,
	vmafSizeLimitMessage,
} from "./size-limits";

const scores = (
	model: string,
	width: number,
	height: number,
	chroma?: VmafChromaLayout,
) => vmafSizeLimitMessage({ model, width, height, chroma }) === undefined;

describe("libvmaf's picture size limits for the VMAF v1 models", () => {
	it("knows the chroma layout of the twelve pixel formats that FFmpeg's libvmaf filter takes, and of no other", () => {
		for (const [sampling, layout] of [
			["420", "4:2:0"],
			["422", "4:2:2"],
			["444", "4:4:4"],
		] as const)
			for (const depth of ["", "10le", "12le", "16le"])
				expect(vmafChromaLayout(`yuv${sampling}p${depth}`)).toBe(layout);
		// FFmpeg converts these before libvmaf, to a format that the encode decides.
		for (const other of [
			"yuvj420p",
			"yuvj444p",
			"nv12",
			"p010le",
			"yuv420p10be",
			"yuv420p14le",
			"yuv420p9le",
			"yuv410p",
			"yuv411p",
			"yuv440p",
			"yuva420p",
			"gbrp",
			"gray",
			"yuv420",
			"xyuv420p",
			"yuv420p10lex",
			"",
			undefined,
			null,
			420,
		])
			expect(vmafChromaLayout(other), String(other)).toBeUndefined();
	});

	it("knows the layout that an encode gives a reference which FFmpeg converts: the encode's own, also for a full-range encode", () => {
		for (const [sampling, layout] of [
			["420", "4:2:0"],
			["422", "4:2:2"],
			["444", "4:4:4"],
		] as const) {
			for (const depth of ["", "10le", "12le", "16le"])
				expect(vmafConvertedChromaLayout(`yuv${sampling}p${depth}`)).toBe(
					layout,
				);
			expect(vmafConvertedChromaLayout(`yuvj${sampling}p`)).toBe(layout);
		}
		// Encodes of which the conversion is not known.
		for (const other of [
			"nv12",
			"p010le",
			"gbrp",
			"gray",
			"yuv440p",
			"yuvj440p",
			"yuvj411p",
			"yuvj420p10le",
			"yuva420p",
			"yuv420p10be",
			"",
			undefined,
			420,
		])
			expect(vmafConvertedChromaLayout(other), String(other)).toBeUndefined();
	});

	it("has limits for the eight bundled VMAF v1 models and leaves every other model to libvmaf", () => {
		expect([...VMAF_SPEED_CHROMA_PRESCALE.keys()].sort()).toEqual([
			"vmaf_v1.0.16_1d5h_2160",
			"vmaf_v1.0.16_3d0h",
			"vmaf_v1.0.16_3d0h_2160",
			"vmaf_v1.0.16_5d0h",
			"vmaf_v1.0.16_hfr_1d5h_2160",
			"vmaf_v1.0.16_hfr_3d0h",
			"vmaf_v1.0.16_hfr_3d0h_2160",
			"vmaf_v1.0.16_hfr_5d0h",
		]);
		for (const model of VMAF_SPEED_CHROMA_PRESCALE.keys())
			expect(scores(model, 64, 36, "4:2:0"), model).toBe(false);
		for (const model of [
			"vmaf_v0.6.1",
			"vmaf_v0.6.1neg",
			"vmaf_4k_v0.6.1",
			"vmaf_float_v0.6.1",
			// A model file of the same family that the image does not bundle: its
			// features and their options are not known here.
			"vmaf_v1.0.17_3d0h",
			"constructor",
			"",
		]) {
			expect(scores(model, 16, 16, "4:2:0"), model).toBe(true);
			expect(
				vmafSizeLimitMessage({
					model,
					width: 1920,
					height: 1080,
					declaredEncode: { width: 64, height: 36 },
				}),
				model,
			).toBeUndefined();
		}
	});

	// Each row: the smallest chroma side that SpEED takes with the model's
	// prescale, as measured with the image's FFmpeg.
	for (const [models, side] of [
		[
			[
				"vmaf_v1.0.16_3d0h",
				"vmaf_v1.0.16_hfr_3d0h",
				"vmaf_v1.0.16_1d5h_2160",
				"vmaf_v1.0.16_hfr_1d5h_2160",
			],
			80,
		],
		[["vmaf_v1.0.16_5d0h", "vmaf_v1.0.16_hfr_5d0h"], 133],
		[["vmaf_v1.0.16_3d0h_2160", "vmaf_v1.0.16_hfr_3d0h_2160"], 159],
	] as const)
		it(`scores from chroma planes of ${side} samples in each direction with ${models[0]} and the models of its prescale`, () => {
			for (const model of models) {
				// 4:2:0 halves the chroma in both directions.
				expect(scores(model, 400, side * 2, "4:2:0"), model).toBe(true);
				expect(scores(model, 400, side * 2 - 1, "4:2:0"), model).toBe(false);
				expect(scores(model, side * 2, 400, "4:2:0"), model).toBe(true);
				expect(scores(model, side * 2 - 1, 400, "4:2:0"), model).toBe(false);
				// 4:2:2 halves it in width only.
				expect(scores(model, 400, side, "4:2:2"), model).toBe(true);
				expect(scores(model, 400, side - 1, "4:2:2"), model).toBe(false);
				expect(scores(model, side * 2, 400, "4:2:2"), model).toBe(true);
				expect(scores(model, side * 2 - 1, 400, "4:2:2"), model).toBe(false);
				// 4:4:4 has chroma planes of the pictures' size.
				expect(scores(model, 400, side, "4:4:4"), model).toBe(true);
				expect(scores(model, 400, side - 1, "4:4:4"), model).toBe(false);
				expect(scores(model, side, 400, "4:4:4"), model).toBe(true);
				expect(scores(model, side - 1, 400, "4:4:4"), model).toBe(false);
				// An unknown layout is refused only where every layout fails.
				expect(scores(model, 400, side), model).toBe(true);
				expect(scores(model, 400, side - 1), model).toBe(false);
				expect(scores(model, side, 400), model).toBe(true);
				expect(scores(model, side - 1, 400), model).toBe(false);
			}
		});

	it("refuses pictures below 216 pixels in both directions, whatever their chroma layout", () => {
		const model = "vmaf_v1.0.16_3d0h";
		for (const chroma of ["4:2:0", "4:2:2", "4:4:4", undefined] as const) {
			expect(scores(model, 215, 215, chroma), chroma).toBe(false);
			expect(scores(model, 216, 215, chroma), chroma).toBe(true);
			expect(scores(model, 215, 216, chroma), chroma).toBe(true);
			expect(scores(model, 216, 216, chroma), chroma).toBe(true);
			expect(scores(model, 1920, 1080, chroma), chroma).toBe(true);
			expect(scores(model, 7680, 4320, chroma), chroma).toBe(true);
		}
		// The size of a 144p rendition: wide enough, but its 4:2:0 chroma is 72 high.
		expect(scores(model, 256, 144, "4:2:0")).toBe(false);
		expect(scores(model, 256, 144, "4:4:4")).toBe(true);
		expect(scores(model, 320, 180, "4:2:0")).toBe(true);
	});

	it("applies CAMBI's rules to the encode size that the frame-index method declares", () => {
		const declared = (
			canvas: [number, number],
			encode: [number, number],
			model = "vmaf_v1.0.16_3d0h",
		) =>
			vmafSizeLimitMessage({
				model,
				width: canvas[0],
				height: canvas[1],
				chroma: "4:2:0",
				declaredEncode: { width: encode[0], height: encode[1] },
			});
		const hd: [number, number] = [1920, 1080];
		// Each side from 144 to 7680.
		for (const encode of [
			[143, 400],
			[400, 143],
			[1921, 100],
			[100, 1081],
		] as [number, number][])
			expect(declared(hd, encode), String(encode)).toMatch(
				/it takes no encode below 144 pixels in width or in height/,
			);
		for (const encode of [
			[7681, 4320],
			[7680, 7681],
		] as [number, number][])
			expect(declared(hd, encode), String(encode)).toMatch(
				/it takes no encode above 7680 pixels in width or in height/,
			);
		// One side of at least 216, for an encode that fits in the pictures.
		for (const encode of [
			[144, 144],
			[215, 215],
			[144, 215],
		] as [number, number][])
			expect(declared(hd, encode), String(encode)).toMatch(
				/it needs an encode of at least 216 pixels in width or in height/,
			);
		for (const encode of [
			[144, 400],
			[400, 144],
			[216, 144],
			[144, 216],
			[215, 216],
			[216, 215],
			[216, 216],
			[1920, 1080],
			// An encode that exceeds the pictures on a side counts as the pictures.
			[7680, 4320],
			[2000, 1200],
			[2000, 150],
			[150, 1200],
		] as [number, number][])
			expect(declared(hd, encode), String(encode)).toBeUndefined();
		// The pictures' own limits hold beside the declared size.
		expect(declared([640, 360], hd)).toBeUndefined();
		expect(declared([200, 400], hd)).toBeUndefined();
		expect(declared([200, 400], [200, 400])).toBeUndefined();
		// An encode below 216 on both sides that exceeds the pictures on one
		// side is taken as the pictures too.
		expect(declared([200, 400], [210, 150])).toBeUndefined();
		expect(declared([400, 200], [150, 210])).toBeUndefined();
		expect(declared([200, 400], [150, 215])).toMatch(
			/it needs an encode of at least 216 pixels in width or in height/,
		);
		expect(declared([200, 200], hd)).toMatch(/4:2:0 pictures of 200x200/);
		expect(declared([216, 159], [216, 159])).toMatch(
			/4:2:0 pictures of 216x159/,
		);
		expect(declared([216, 160], [216, 160])).toBeUndefined();
		expect(declared([400, 265], [400, 265], "vmaf_v1.0.16_hfr_5d0h")).toMatch(
			/4:2:0 pictures of 400x265/,
		);
	});

	it("says what the pictures need and what to do instead", () => {
		expect(
			vmafSizeLimitMessage({
				model: "vmaf_v1.0.16_3d0h",
				width: 256,
				height: 144,
				chroma: "4:2:0",
			}),
		).toBe(
			'VMAF model "vmaf_v1.0.16_3d0h" cannot score 4:2:0 pictures of 256x144: it needs at least 160 pixels in width and in height, and at least 216 in one of the two. The two pictures are compared at the size of the reference. Use a model of the vmaf_v0.6.1 family, which scores smaller pictures, or a larger reference.',
		);
		// Where the chroma's limit is past 216, CAMBI's adds nothing.
		expect(
			vmafSizeLimitMessage({
				model: "vmaf_v1.0.16_5d0h",
				width: 426,
				height: 240,
				chroma: "4:2:0",
			}),
		).toMatch(
			/cannot score 4:2:0 pictures of 426x240: it needs at least 266 pixels in width and in height\. The two/,
		);
		expect(
			vmafSizeLimitMessage({
				model: "vmaf_v1.0.16_5d0h",
				width: 260,
				height: 240,
				chroma: "4:2:2",
			}),
		).toMatch(
			/4:2:2 pictures of 260x240: it needs at least 266 pixels in width and 133 in height\. The two/,
		);
		expect(
			vmafSizeLimitMessage({
				model: "vmaf_v1.0.16_3d0h",
				width: 200,
				height: 100,
				chroma: "4:2:2",
			}),
		).toMatch(
			/4:2:2 pictures of 200x100: it needs at least 160 pixels in width and 80 in height, and at least 216 in one of the two\. The two/,
		);
		expect(
			vmafSizeLimitMessage({
				model: "vmaf_v1.0.16_3d0h",
				width: 200,
				height: 200,
				chroma: "4:4:4",
			}),
		).toMatch(
			/4:4:4 pictures of 200x200: it needs at least 80 pixels in width and in height, and at least 216 in one of the two\. The two/,
		);
		// An unknown layout: the rule in the chroma's own terms.
		expect(
			vmafSizeLimitMessage({
				model: "vmaf_v1.0.16_3d0h_2160",
				width: 150,
				height: 150,
			}),
		).toBe(
			'VMAF model "vmaf_v1.0.16_3d0h_2160" cannot score pictures of 150x150: it needs chroma planes of at least 159 samples in width and in height, and at least 216 pixels in width or in height. The two pictures are compared at the size of the reference. Use a model of the vmaf_v0.6.1 family, which scores smaller pictures, or a larger reference.',
		);
		expect(
			vmafSizeLimitMessage({
				model: "vmaf_v1.0.16_3d0h",
				width: 1920,
				height: 1080,
				chroma: "4:2:0",
				declaredEncode: { width: 240, height: 134 },
			}),
		).toBe(
			'VMAF model "vmaf_v1.0.16_3d0h" cannot score an encode of 240x134: it takes no encode below 144 pixels in width or in height. Use a model of the vmaf_v0.6.1 family, which scores smaller pictures.',
		);
		expect(
			vmafSizeLimitMessage({
				model: "vmaf_v1.0.16_3d0h",
				width: 1920,
				height: 1080,
				chroma: "4:2:0",
				declaredEncode: { width: 8192, height: 4320 },
			}),
		).toBe(
			'VMAF model "vmaf_v1.0.16_3d0h" cannot score an encode of 8192x4320: it takes no encode above 7680 pixels in width or in height. Use a model of the vmaf_v0.6.1 family.',
		);
	});

	it("names the limit after a run in which libvmaf's SpEED feature refused the pictures, and nothing else", () => {
		const pictures = { model: "vmaf_v1.0.16_3d0h", width: 256, height: 144 };
		expect(
			vmafSizeLimitFailureMessage(
				"[Parsed_libvmaf_4 @ 0x55d0] some line\nlibvmaf ERROR SpEED: image too small, operating width or height is 0\n",
				pictures,
			),
		).toBe(
			'VMAF model "vmaf_v1.0.16_3d0h" cannot score pictures of 256x144: libvmaf reports that they are too small for its SpEED feature. The two pictures are compared at the size of the reference. Use a model of the vmaf_v0.6.1 family, which scores smaller pictures, or a larger reference.',
		);
		for (const stderr of [
			"",
			// CAMBI's refusal: the check before the run knows its rules whatever
			// the layout, so this text after a run has another cause.
			"libvmaf ERROR problem during vmaf_read_pictures.\nlibvmaf ERROR vmaf_predict_score_at_index(): no feature 'cambi_encbd_8_ench_180_encw_320'\n",
			"libvmaf ERROR could not load libvmaf model\n",
			"x264 [error]: broken pipe\n",
			"image too small",
		])
			expect(
				vmafSizeLimitFailureMessage(stderr, pictures),
				stderr,
			).toBeUndefined();
	});

	it("names the limit after a run in which the GPU scorer refused the pictures or the encode, and nothing else", () => {
		const model = "vmaf_v1.0.16_3d0h";
		const advice =
			"Use a model of the vmaf_v0.6.1 family, which scores smaller pictures";
		// Each line as a run on an NVIDIA GPU printed it, with the sizes of that run.
		for (const [stderr, width, height, encode, sentence] of [
			[
				"bitovp-vmaf: input is too small or too large for official SpEED chroma blocks\n",
				256,
				144,
				{ width: 256, height: 144 },
				`cannot score 4:2:0 pictures of 256x144: it needs at least 160 pixels in width and in height, and at least 216 in one of the two. The two pictures are compared at the size of the reference. ${advice}, or a larger reference.`,
			],
			[
				"bitovp-vmaf: override official extractor cambi failed (libvmaf -22)\n",
				640,
				360,
				{ width: 240, height: 134 },
				`cannot score an encode of 240x134: it takes no encode below 144 pixels in width or in height. ${advice}.`,
			],
			[
				"bitovp-vmaf: invalid Vulkan CAMBI encoding geometry\n",
				640,
				360,
				{ width: 200, height: 200 },
				`cannot score an encode of 200x200: it needs an encode of at least 216 pixels in width or in height. ${advice}.`,
			],
		] as const)
			expect(
				vmafNativeSizeLimitFailureMessage(stderr, {
					model,
					width,
					height,
					declaredEncode: encode,
				}),
			).toBe(`VMAF model "${model}" ${sentence}`);

		// The scorer compares in 4:2:0 whatever the reference is: 216x160 is the
		// smallest that it scores, where libvmaf scores 4:4:4 pictures of 216x80.
		const edge = (width: number, height: number) =>
			vmafNativeSizeLimitFailureMessage(
				"bitovp-vmaf: input is too small or too large for official SpEED chroma blocks\n",
				{ model, width, height, declaredEncode: { width, height } },
			);
		expect(edge(216, 158)).toContain("cannot score 4:2:0 pictures of 216x158");
		expect(edge(216, 160)).toBeUndefined();

		const small = {
			model,
			width: 256,
			height: 144,
			declaredEncode: { width: 256, height: 144 },
		};
		for (const refusal of VMAF_NATIVE_SIZE_REFUSALS) {
			expect(
				vmafNativeSizeLimitFailureMessage(`bitovp-vmaf: ${refusal}\n`, small),
				refusal,
			).toContain("cannot score 4:2:0 pictures of 256x144");
			// The same words for sizes that no limit of this file refuses, and for a
			// model whose limits it does not know: the scorer's words stay.
			expect(
				vmafNativeSizeLimitFailureMessage(`bitovp-vmaf: ${refusal}\n`, {
					model,
					width: 1920,
					height: 1080,
					declaredEncode: { width: 1280, height: 720 },
				}),
				refusal,
			).toBeUndefined();
			expect(
				vmafNativeSizeLimitFailureMessage(`bitovp-vmaf: ${refusal}\n`, {
					...small,
					model: "vmaf_v0.6.1",
				}),
				refusal,
			).toBeUndefined();
		}
		// Every other failure on pictures that are too small.
		for (const stderr of [
			"",
			"bitovp-vmaf: CUDA error: out of memory\n",
			// libvmaf's other errors at the same call.
			"bitovp-vmaf: override official extractor cambi failed (libvmaf -12)\n",
			"bitovp-vmaf: load official model vmaf_v1.0.16_3d0h failed (libvmaf -22)\n",
			// libvmaf's own words: the scorer does not print them.
			"libvmaf ERROR SpEED: image too small, operating width or height is 0\n",
			"too small",
		])
			expect(
				vmafNativeSizeLimitFailureMessage(stderr, small),
				stderr,
			).toBeUndefined();
	});

	it("ends the sentence with Local CPU where libvmaf through FFmpeg scores the pair that the GPU scorer refused", () => {
		const wayOut =
			" That holds for GPU scoring, which compares every pair in 4:2:0 and counts the encode's own size: with Local CPU the same model scores this pair.";
		const speed =
			"bitovp-vmaf: input is too small or too large for official SpEED chroma blocks\n";
		const cambi =
			"bitovp-vmaf: override official extractor cambi failed (libvmaf -22)\n";
		const sentence = (
			stderr: string,
			model: string,
			[width, height]: readonly [number, number],
			[encodeWidth, encodeHeight]: readonly [number, number],
			cpuChroma?: VmafChromaLayout,
		) =>
			vmafNativeSizeLimitFailureMessage(stderr, {
				model,
				width,
				height,
				declaredEncode: { width: encodeWidth, height: encodeHeight },
				cpuChroma,
			}) ?? "not named";
		// What runs on an NVIDIA GPU refused and libvmaf through FFmpeg scored.
		// First an encode below CAMBI's range of a 640x360 reference: the
		// ordinary method declares no encode.
		for (const model of [
			"vmaf_v1.0.16_3d0h",
			"vmaf_v1.0.16_5d0h",
			"vmaf_v1.0.16_3d0h_2160",
		]) {
			expect(sentence(cambi, model, [640, 360], [240, 134], "4:2:0")).toBe(
				`VMAF model "${model}" cannot score an encode of 240x134: it takes no encode below 144 pixels in width or in height. Use a model of the vmaf_v0.6.1 family, which scores smaller pictures.${wayOut}`,
			);
			// No way out where the reference's layout is not known,
			const unknown = sentence(cambi, model, [640, 360], [240, 134]);
			expect(unknown).toContain("cannot score an encode of 240x134");
			expect(unknown).not.toContain("Local CPU");
			// nor for pictures that libvmaf refuses in the reference's layout too:
			// 4:2:0 ones of 256x144, and 200x200 in any layout.
			for (const [size, layout] of [
				[[256, 144], "4:2:0"],
				[[200, 200], "4:4:4"],
			] as const) {
				const both = sentence(speed, model, size, size, layout);
				expect(both).toMatch(/^VMAF model "[^"]+" cannot score /);
				expect(both).not.toContain("Local CPU");
			}
		}
		// Then a 4:4:4 reference of 256x144, which the scorer compares in 4:2:0:
		// libvmaf scored it with the two models whose 4:4:4 limit it passes.
		for (const [model, offered] of [
			["vmaf_v1.0.16_3d0h", true],
			["vmaf_v1.0.16_5d0h", true],
			["vmaf_v1.0.16_3d0h_2160", false],
		] as const) {
			const text = sentence(speed, model, [256, 144], [256, 144], "4:4:4");
			expect(text, model).toContain("cannot score 4:2:0 pictures of 256x144");
			expect(text.endsWith(wayOut), model).toBe(offered);
		}
	});

	it("takes for a refusal of the GPU scorer only words that its source holds", () => {
		const source = [
			"main.cpp",
			"model_oracle.cpp",
			"vulkan/cambi_parameters.hpp",
			"vulkan/speed_parameters.hpp",
		]
			.map((file) =>
				readFileSync(
					new URL(`../../../../native/vmaf-gpu/src/${file}`, import.meta.url),
					"utf8",
				),
			)
			.join("\n");
		// The scorer puts this one together: the extractor whose options it
		// sets, the encode's size among them, then the error number. -22 is what
		// its adapter gives for a value outside the range of libvmaf's option.
		const composed = "override official extractor cambi failed (libvmaf -22)";
		expect(VMAF_NATIVE_SIZE_REFUSALS).toContain(composed);
		for (const option of ["enc_width", "enc_height"])
			expect(source).toContain(`feature_overrides["cambi"]["${option}"]`);
		expect(source).toContain('"override official extractor " + extractor');
		expect(source).toContain('operation + " failed (libvmaf " +');
		for (const refusal of VMAF_NATIVE_SIZE_REFUSALS)
			if (refusal !== composed)
				expect(source, refusal).toContain(`"${refusal}"`);
	});
});
