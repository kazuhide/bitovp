import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseVmafJson, type VmafCommandOptions } from "@bitovp/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runLocalVmafScore } from "./local-score";
import { NATIVE_OFFICIAL_REVISION } from "./native-contract";
import { fixtureValue, nativeReceipt, SHA } from "./native-fixture.test-helper";
import { NativePairRefusal } from "./native-score";

const cleanup = vi.hoisted(() => ({
	afterRemove: undefined as undefined | ((path: unknown) => void),
}));
vi.mock("node:fs/promises", async (original) => {
	const fs = await original<typeof import("node:fs/promises")>();
	return {
		...fs,
		rm: vi.fn(async (...parameters: Parameters<typeof fs.rm>) => {
			await fs.rm(...parameters);
			cleanup.afterRemove?.(parameters[0]);
		}),
	};
});

vi.mock("./native-contract", async (original) => ({
	...(await original<typeof import("./native-contract")>()),
	prepareNativeModel: vi.fn(async () => ({
		modelSha256:
			"e4cf8c147e1368b35497d772920bc92f98c1ad7853c1033d8a836947f427140e",
	})),
}));
const directories: string[] = [];
afterEach(async () => {
	cleanup.afterRemove = undefined;
	await Promise.all(
		directories
			.splice(0)
			.map((path) => rm(path, { recursive: true, force: true })),
	);
});
const source = "a".repeat(64);
const probe = (extra = {}) =>
	JSON.stringify({
		streams: [
			{
				codec_type: "video",
				codec_name: "h264",
				width: 640,
				height: 360,
				pix_fmt: "yuv420p",
				bits_per_raw_sample: "8",
				sample_aspect_ratio: "1:1",
				r_frame_rate: "30/1",
				avg_frame_rate: "30/1",
				nb_frames: "2",
				...extra,
			},
		],
	});

async function setup() {
	const directory = await mkdtemp(join(tmpdir(), "bitovp-native-score-"));
	directories.push(directory);
	const referencePath = join(directory, "reference.mp4"),
		distortedPath = join(directory, "distorted.mp4");
	await writeFile(referencePath, "reference");
	await writeFile(distortedPath, "distorted");
	const options: VmafCommandOptions = {
		referencePath,
		distortedPath,
		model: "vmaf_v1.0.16_3d0h",
		modelPath: "/models/vmaf_v1.0.16_3d0h.json",
		logPath: join(directory, "scores.json"),
		scaleToReference: { width: 640, height: 360 },
		distortedOriginal: { width: 640, height: 360, bitdepth: 8 },
		psnr: true,
		scoring: { backend: "vulkan", device: 0 },
		threads: 2,
		decoderThreads: 2,
	};
	const receipt = nativeReceipt();
	receipt.referenceSha256 = createHash("sha256")
		.update("reference")
		.digest("hex");
	receipt.distortedSha256 = createHash("sha256")
		.update("distorted")
		.digest("hex");
	const run = vi.fn(
		async (_binary: string, args: string[], _context?: unknown) => {
			if (args[0] === "--version")
				return {
					code: 0,
					stdout: `bitovp-vmaf 0.1 owned CUDA/Vulkan; official=${NATIVE_OFFICIAL_REVISION}; source=${source}\n`,
					stderr: "",
				};
			// As the scorer does, it compares at the bit depth that it is told.
			await writeFile(
				fixtureValue(args, args.indexOf("--output") + 1),
				JSON.stringify({
					...receipt,
					bitDepth: Number(fixtureValue(args, args.indexOf("--bit-depth") + 1)),
				}),
			);
			return { code: 0, stdout: "PASS", stderr: "" };
		},
	);
	return {
		options,
		receipt,
		run,
		context: { referenceProbe: probe(), distortedProbe: probe() },
		deps: {
			runner: {
				run,
				spawn() {
					throw new Error("unexpected spawn");
				},
			},
			ffmpegPath: "ffmpeg",
			ffprobePath: "ffprobe",
			nativePath: "bitovp-vmaf",
		},
	};
}

describe("owned native local scoring", () => {
	it("binds an explicitly prepared reference hash to the native receipt input", async () => {
		const h = await setup();
		const expectedReferenceSha256 = createHash("sha256")
			.update("reference")
			.digest("hex");
		const result = await runLocalVmafScore(h.deps, h.options, {
			...h.context,
			expectedReferenceSha256,
		});
		expect(result.execution.scoring.backend).toBe("vulkan");
		expect(h.receipt.referenceSha256).toBe(expectedReferenceSha256);
	});
	it.each([
		"0".repeat(64),
		"A".repeat(64),
		"",
		"a".repeat(63),
		"a".repeat(65),
	])("rejects a mismatched or malformed prepared reference hash before native execution: %s", async (expectedReferenceSha256) => {
		const h = await setup();
		await expect(
			runLocalVmafScore(h.deps, h.options, {
				...h.context,
				expectedReferenceSha256,
			}),
		).rejects.toThrow("NATIVE_REFERENCE_PREPARATION_SHA256_MISMATCH");
		expect(h.run).not.toHaveBeenCalled();
	});
	it("keeps internal calibration bounded and verifies its frame count and pipeline depth", async () => {
		const h = await setup();
		Object.assign(h.receipt, {
			inflightFrames: 4,
			cpuThreads: 2,
			decodeThreads: 2,
			resourceSnapshotScope: "before-result-serialization",
			memory: { maxRssBytes: 64_000_000, gpuAllocatedBytes: 32_000_000 },
		});
		const result = await runLocalVmafScore(h.deps, h.options, {
			...h.context,
			nativeInflightFrames: 4,
			calibrationFrames: 2,
		});
		const args = h.run.mock.calls[1]?.[1];
		expect(args).toEqual(
			expect.arrayContaining([
				"--inflight-frames",
				"4",
				"--max-frames",
				"2",
				"--verify-cpu",
			]),
		);
		expect(result.resourceSnapshot).toEqual({
			maxRssBytes: 64_000_000,
			gpuOwnedBytes: 32_000_000,
			scope: "before-result-serialization",
		});
		Object.assign(h.receipt, { inflightFrames: 1 });
		await expect(
			runLocalVmafScore(h.deps, h.options, {
				...h.context,
				nativeInflightFrames: 4,
				calibrationFrames: 2,
			}),
		).rejects.toThrow("NATIVE_PIPELINE_DEPTH_MISMATCH");
	});
	it("rejects invalid internal sampling controls before launching a process", async () => {
		const h = await setup();
		for (const calibrationFrames of [0, 257, 1.5]) {
			await expect(
				runLocalVmafScore(h.deps, h.options, {
					...h.context,
					calibrationFrames,
				}),
			).rejects.toThrow("NATIVE_CALIBRATION_FRAME_LIMIT_INVALID");
		}
		expect(h.run).not.toHaveBeenCalled();
	});
	it("rejects cancellation observed during final receipt cleanup", async () => {
		const h = await setup();
		const controller = new AbortController();
		let removals = 0;
		cleanup.afterRemove = (path) => {
			if (path === `${h.options.logPath}.native.json` && ++removals === 2)
				controller.abort();
		};
		await expect(
			runLocalVmafScore(h.deps, h.options, {
				...h.context,
				signal: controller.signal,
			}),
		).rejects.toThrow();
		expect(removals).toBe(2);
	});
	it("uses one complete native run with mandatory CPU verification and preserves the requested model", async () => {
		const h = await setup();
		const result = await runLocalVmafScore(h.deps, h.options, h.context);
		expect(h.run).toHaveBeenCalledTimes(2);
		const [binary, args, context] = fixtureValue(h.run.mock.calls, 1);
		expect(binary).toBe("bitovp-vmaf");
		for (const token of [
			"--reference",
			h.options.referencePath,
			"--distorted",
			h.options.distortedPath,
			"--backend",
			"vulkan",
			"--vendor",
			"amd",
			"--device",
			"0",
			"--verify-cpu",
			"--model",
			`${h.options.model}=${h.options.modelPath}`,
		])
			expect(args).toContain(token);
		// An 8-bit 4:2:0 reference: libvmaf through FFmpeg compares 8-bit pictures.
		expect(fixtureValue(args, args.indexOf("--bit-depth") + 1)).toBe("8");
		expect(context).toMatchObject({ abortKillAfterMs: 250 });
		expect(result.execution.scoring).toMatchObject({
			implementation: "bitovp-owned",
			backend: "vulkan",
			bitDepth: 8,
			modelSha256: SHA,
			cpuParity: { checked: true },
			device: { index: 0, vendorId: 0x1002 },
		});
		expect(parseVmafJson(result.log).frames.map((frame) => frame.vmaf)).toEqual(
			[90, 92],
		);
		expect(JSON.parse(await readFile(h.options.logPath, "utf8"))).toEqual(
			result.log,
		);
	});
	it.each([
		{ subsample: 2 },
		{ fpsConform: 30 },
		{ alignFrames: 1 },
		{ measurementMethod: "FRAME_INDEX_BT709_10BIT" as const },
		{ features: ["float_ssim"] },
		{ filterComplexThreads: 2 },
	])("rejects unsupported transformations before process execution: %j", async (patch) => {
		const h = await setup();
		await expect(
			runLocalVmafScore(h.deps, { ...h.options, ...patch }, h.context),
		).rejects.toThrow(/NATIVE_UNSUPPORTED/);
		expect(h.run).not.toHaveBeenCalled();
	});
	it.each([
		{
			side_data_list: [
				{
					side_data_type: "Frame Cropping",
					crop_top: 1,
					crop_bottom: 0,
					crop_left: 0,
					crop_right: 0,
				},
			],
		},
		{ tags: { rotate: "90" } },
		{ sample_aspect_ratio: "2:1" },
		{ color_transfer: "smpte2084" },
	])("refuses unqualified input presentation: %j", async (extra) => {
		const h = await setup();
		const scored = runLocalVmafScore(h.deps, h.options, {
			...h.context,
			distortedProbe: probe(extra),
		});
		await expect(scored).rejects.toThrow(/NATIVE_UNSUPPORTED/);
		// A file that the scorer does not take, whatever the other file is.
		await expect(scored).rejects.toMatchObject({
			name: "NativePairRefusal",
			reason: "GPU_PAIR_INPUT",
		});
		expect(h.run).not.toHaveBeenCalled();
	});
	it("refuses a pair whose frames FFmpeg would repeat or drop, before any process starts", async () => {
		const start =
			"GPU scoring cannot compare this pair as libvmaf through FFmpeg does: ";
		const slots =
			", and FFmpeg gives each file one frame per slot of the reference's frame rate, repeating and dropping frames, before libvmaf compares them. Use Local CPU for this pair.";
		for (const [reference, encode, message] of [
			// Two frame rates.
			[
				{},
				{ r_frame_rate: "24/1", avg_frame_rate: "24/1" },
				`${start}the reference's frame rate is 30/1 and the encode's is 24/1, and GPU scoring takes two files only where FFmpeg names one frame rate for both. Use Local CPU for this pair.`,
			],
			// A file that leaves slots of its frame rate out.
			[
				{ avg_frame_rate: "20/1" },
				{},
				`${start}the reference's frames are not evenly spaced by what ffprobe says of it (r_frame_rate 30/1, avg_frame_rate 20/1)${slots}`,
			],
			[
				{},
				{ avg_frame_rate: "0/0" },
				`${start}the encode's frames are not evenly spaced by what ffprobe says of it (r_frame_rate 30/1, avg_frame_rate 0/0)${slots}`,
			],
			// Two frame counts.
			[
				{},
				{ nb_frames: "3", avg_frame_rate: "30/1" },
				`${start}the reference has 2 frames and the encode 3, and GPU scoring compares two files of the same number of frames. Use Local CPU for this pair.`,
			],
		] as const) {
			const h = await setup();
			await expect(
				runLocalVmafScore(h.deps, h.options, {
					referenceProbe: probe(reference),
					distortedProbe: probe(encode),
				}),
				JSON.stringify([reference, encode]),
			).rejects.toMatchObject({
				message,
				name: "NativePairRefusal",
				reason: "GPU_PAIR_FRAME_TIMES",
			});
			// Neither the scorer nor FFmpeg in its place.
			expect(h.run).not.toHaveBeenCalled();
		}
	});
	it("times the scorer on the first frames of a pair, whatever ffprobe says of the two cuts", async () => {
		// A calibration run scores cuts of a pair that has passed the check:
		// ffprobe's rates and counts of a short Matroska cut are not the file's.
		const cut = probe({ avg_frame_rate: "0/0", nb_frames: "66" });
		const h = await setup();
		Object.assign(h.receipt, {
			inflightFrames: 1,
			cpuThreads: 2,
			decodeThreads: 2,
			resourceSnapshotScope: "before-result-serialization",
			memory: { maxRssBytes: 64_000_000, gpuAllocatedBytes: 32_000_000 },
		});
		await runLocalVmafScore(h.deps, h.options, {
			referenceProbe: probe(),
			distortedProbe: cut,
			nativeInflightFrames: 1,
			calibrationFrames: 2,
		});
		expect(h.run.mock.calls.map(([binary]) => binary)).toEqual([
			"bitovp-vmaf",
			"bitovp-vmaf",
		]);
		// The same two files as a measurement are refused.
		const measured = await setup();
		await expect(
			runLocalVmafScore(measured.deps, measured.options, {
				referenceProbe: probe(),
				distortedProbe: cut,
			}),
		).rejects.toMatchObject({ reason: "GPU_PAIR_FRAME_TIMES" });
		expect(measured.run).not.toHaveBeenCalled();
	});
	it("names the kind of each refusal, which a result scored on the CPU in the scorer's place keeps", async () => {
		for (const [reference, encode, reason] of [
			[{ pix_fmt: "yuv444p" }, {}, "GPU_PAIR_PIXEL_FORMAT"],
			[{ pix_fmt: "yuvj420p", color_range: "pc" }, {}, "GPU_PAIR_COLOR_RANGE"],
			[{ color_space: "bt709" }, {}, "GPU_PAIR_COLOR_MATRIX"],
			[
				{},
				{ r_frame_rate: "25/1", avg_frame_rate: "25/1" },
				"GPU_PAIR_FRAME_TIMES",
			],
			[{ sample_aspect_ratio: "2:1" }, {}, "GPU_PAIR_INPUT"],
		] as const) {
			const h = await setup();
			await expect(
				runLocalVmafScore(h.deps, h.options, {
					referenceProbe: probe(reference),
					distortedProbe: probe(encode),
				}),
				reason,
			).rejects.toMatchObject({ name: "NativePairRefusal", reason });
			expect(h.run).not.toHaveBeenCalled();
		}
		// A probe that cannot be read is an error of the measurement, not a
		// pair that the ordinary method would score.
		const h = await setup();
		const unreadable = runLocalVmafScore(h.deps, h.options, {
			referenceProbe: "not JSON",
			distortedProbe: probe(),
		});
		await expect(unreadable).rejects.toThrow("NATIVE_UNSUPPORTED_PROBE");
		await expect(unreadable).rejects.not.toHaveProperty("reason");
	});
	it("compares at the bit depth of the reference, whatever the encode's is", async () => {
		const ten = { pix_fmt: "yuv420p10le", bits_per_raw_sample: "10" };
		for (const [reference, encode, depth] of [
			[ten, {}, "10"],
			[ten, ten, "10"],
			[{}, ten, "8"],
			[{}, { pix_fmt: "yuv422p" }, "8"],
			// Full range on both sides, as ffprobe names it for 8 and for 10 bits.
			[
				{ pix_fmt: "yuvj420p", color_range: "pc" },
				{ pix_fmt: "yuvj420p", color_range: "pc" },
				"8",
			],
			[{ pix_fmt: "yuvj420p", color_range: "pc" }, { color_range: "pc" }, "8"],
			[
				{ ...ten, color_range: "pc" },
				{ pix_fmt: "yuvj420p", color_range: "pc" },
				"10",
			],
			// The same colour matrix on both sides.
			[
				{ ...ten, color_range: "tv", color_space: "bt709" },
				{ color_space: "bt709" },
				"10",
			],
		] as const) {
			const h = await setup();
			// The receipt names the encode as it was before the comparison.
			const bitdepth = "bits_per_raw_sample" in encode ? 10 : 8;
			h.receipt.distortedOriginal.bitdepth = bitdepth;
			const result = await runLocalVmafScore(
				h.deps,
				{
					...h.options,
					distortedOriginal: { width: 640, height: 360, bitdepth },
				},
				{ referenceProbe: probe(reference), distortedProbe: probe(encode) },
			);
			const args = fixtureValue(h.run.mock.calls, 1)[1];
			const label = JSON.stringify([reference, encode]);
			expect(fixtureValue(args, args.indexOf("--bit-depth") + 1), label).toBe(
				depth,
			);
			expect(result.execution.scoring, label).toMatchObject({
				bitDepth: Number(depth),
			});
		}
	});
	it("refuses a pair that the scorer cannot compare as libvmaf through FFmpeg does, before any process starts", async () => {
		const start =
			"GPU scoring cannot compare this pair as libvmaf through FFmpeg does: ";
		const ten = { pix_fmt: "yuv420p10le", bits_per_raw_sample: "10" };
		for (const [reference, encode, message] of [
			[
				{ pix_fmt: "yuv422p10le", bits_per_raw_sample: "10" },
				{},
				`${start}the reference's pixel format is yuv422p10le, and GPU scoring compares 8-bit and 10-bit 4:2:0 pictures only, for references in yuv420p and yuv420p10le. Use Local CPU for this pair.`,
			],
			[
				{ pix_fmt: "yuv444p" },
				{},
				`${start}the reference's pixel format is yuv444p, and GPU scoring compares 8-bit and 10-bit 4:2:0 pictures only, for references in yuv420p and yuv420p10le. Use Local CPU for this pair.`,
			],
			[
				{ pix_fmt: "yuv420p12le", bits_per_raw_sample: "12" },
				{},
				`${start}the reference's pixel format is yuv420p12le, and GPU scoring compares 8-bit and 10-bit 4:2:0 pictures only, for references in yuv420p and yuv420p10le. Use Local CPU for this pair.`,
			],
			[
				{ pix_fmt: "yuvj420p", color_range: "pc" },
				{ pix_fmt: "yuvj422p", color_range: "pc" },
				`${start}the reference's pixel format is yuvj420p and the encode's is yuvj422p, and FFmpeg converts such a reference to the encode's format, which GPU scoring compares for an 8-bit 4:2:0 encode only. Use Local CPU for this pair.`,
			],
			[
				{ pix_fmt: "yuvj420p", color_range: "pc" },
				{},
				`${start}the reference is full range and the encode is limited range, and FFmpeg converts one of the two before libvmaf compares them. Use Local CPU for this pair.`,
			],
			[
				{ ...ten, color_range: "pc" },
				ten,
				`${start}the reference is full range and the encode is limited range, and FFmpeg converts one of the two before libvmaf compares them. Use Local CPU for this pair.`,
			],
			[
				{},
				{ pix_fmt: "yuvj420p", color_range: "pc" },
				`${start}the reference is limited range and the encode is full range, and FFmpeg converts one of the two before libvmaf compares them. Use Local CPU for this pair.`,
			],
			[
				{ color_range: "tv", color_space: "bt709" },
				{},
				`${start}the reference names the colour matrix bt709 and the encode names no colour matrix, and FFmpeg, which takes a file that names none for BT.601, converts the encode to the reference's matrix before libvmaf compares them. Use Local CPU for this pair.`,
			],
			[
				{ color_space: "bt709" },
				{ color_space: "smpte170m" },
				`${start}the reference names the colour matrix bt709 and the encode names the colour matrix smpte170m, and FFmpeg, which takes a file that names none for BT.601, converts the encode to the reference's matrix before libvmaf compares them. Use Local CPU for this pair.`,
			],
		] as const) {
			const h = await setup();
			await expect(
				runLocalVmafScore(
					h.deps,
					{
						...h.options,
						distortedOriginal: {
							width: 640,
							height: 360,
							bitdepth: "bits_per_raw_sample" in encode ? 10 : 8,
						},
					},
					{ referenceProbe: probe(reference), distortedProbe: probe(encode) },
				),
				JSON.stringify([reference, encode]),
			).rejects.toMatchObject({ message });
			// Neither the scorer nor FFmpeg in its place.
			expect(h.run).not.toHaveBeenCalled();
		}
	});
	it("takes no result from a scorer that compared at another bit depth or declared the encode to CAMBI", async () => {
		const version = {
			code: 0,
			stdout: `bitovp-vmaf 0.1 owned CUDA/Vulkan; official=${NATIVE_OFFICIAL_REVISION}; source=${source}\n`,
			stderr: "",
		};
		const writes = (h: Awaited<ReturnType<typeof setup>>, receipt: unknown) =>
			h.run.mockImplementation(async (_binary, args) => {
				if (args[0] === "--version") return version;
				await writeFile(
					fixtureValue(args, args.indexOf("--output") + 1),
					JSON.stringify(receipt),
				);
				return { code: 0, stdout: "PASS", stderr: "" };
			});
		// The pictures of generations 9 and 10: 10 bits for an 8-bit reference.
		const other = await setup();
		writes(other, { ...other.receipt, bitDepth: 10 });
		await expect(
			runLocalVmafScore(other.deps, other.options, other.context),
		).rejects.toThrow("NATIVE_RECEIPT_COMPARISON_MISMATCH");
		// A scorer built from an earlier source: the bit depth that it was told,
		// and the encode's size and bit depth declared to CAMBI.
		const earlier = await setup();
		const declared = structuredClone(earlier.receipt);
		fixtureValue(declared.extractors, 0).options = {
			enc_width: "640",
			enc_height: "360",
			enc_bitdepth: "8",
		};
		writes(earlier, { ...declared, bitDepth: 8 });
		await expect(
			runLocalVmafScore(earlier.deps, earlier.options, earlier.context),
		).rejects.toThrow("NATIVE_RECEIPT_COMPARISON_MISMATCH");
		// No CPU scoring in its place, and no log of scores.
		for (const h of [other, earlier]) {
			expect(h.run.mock.calls.map(([binary]) => binary)).toEqual([
				"bitovp-vmaf",
				"bitovp-vmaf",
			]);
			await expect(readFile(h.options.logPath, "utf8")).rejects.toThrow();
		}
	});
	it("gives a failed run in the scorer's own words and starts no CPU scoring in its place", async () => {
		const h = await setup();
		const failsWith = (stderr: string) =>
			h.run.mockImplementation(async (_binary, args) =>
				args[0] === "--version"
					? {
							code: 0,
							stdout: `bitovp-vmaf 0.1 owned CUDA/Vulkan; official=${NATIVE_OFFICIAL_REVISION}; source=${source}\n`,
							stderr: "",
						}
					: { code: 1, stdout: "", stderr },
			);
		// The caller refuses pictures that are too small for the model before
		// this run, with libvmaf's limits for 4:2:0 pictures, so nothing here puts
		// a refusal of the scorer into other words.
		for (const stderr of [
			"bitovp-vmaf: input is too small or too large for official SpEED chroma blocks\n",
			"bitovp-vmaf: invalid Vulkan CAMBI encoding geometry\n",
			"bitovp-vmaf: CUDA error: out of memory\n",
			// Frames that the scorer's two decoders do not give alike are its
			// own failure, and no property of the pair.
			"bitovp-vmaf: CPU/NVDEC reference frame coverage differs\n",
		]) {
			failsWith(stderr);
			await expect(
				runLocalVmafScore(h.deps, h.options, h.context),
			).rejects.toMatchObject({
				name: "Error",
				message: `NATIVE_SCORING_FAILED (1): ${stderr}`,
			});
		}
		// What the scorer says of two files whose frames it does not pair is a
		// refusal of the pair, in the same words: the sentences of
		// `native/vmaf-gpu/src/main.cpp` and `decoder_pair.hpp`, as the scorer
		// gave them on 2026-11-14 for a Matroska and an MP4 file of 60000/1001
		// frames a second, and for a Matroska reference that leaves a frame out
		// against an encode that has it.
		for (const stderr of [
			"bitovp-vmaf: Inputs must have the same known frame rate; conform them before comparison\n",
			"bitovp-vmaf: Comparison presentation timestamps do not align\n",
			"bitovp-vmaf: Comparison inputs have different frame counts\n",
			"[matroska,webm @ 0x55d0] Could not find codec parameters\nbitovp-vmaf: Comparison presentation timestamps do not align\n",
		]) {
			failsWith(stderr);
			const refusal = await runLocalVmafScore(
				h.deps,
				h.options,
				h.context,
			).catch((error: unknown) => error);
			expect(refusal).toBeInstanceOf(NativePairRefusal);
			expect(refusal).toMatchObject({
				name: "NativePairRefusal",
				reason: "GPU_PAIR_FRAME_TIMES",
				message: `NATIVE_SCORING_FAILED (1): ${stderr}`,
			});
		}
		// The sentence in another program's line is not the scorer's.
		failsWith("ffmpeg: Comparison presentation timestamps do not align\n");
		await expect(
			runLocalVmafScore(h.deps, h.options, h.context),
		).rejects.toMatchObject({ name: "Error" });
		// An encode that is smaller than CAMBI's range for a declared encode is
		// started as every other: nothing of it is declared.
		failsWith("bitovp-vmaf: CUDA error: out of memory\n");
		h.run.mockClear();
		await expect(
			runLocalVmafScore(
				h.deps,
				{
					...h.options,
					distortedOriginal: { width: 128, height: 72, bitdepth: 8 },
				},
				{
					...h.context,
					distortedProbe: probe({ width: 128, height: 72 }),
				},
			),
		).rejects.toMatchObject({
			message:
				"NATIVE_SCORING_FAILED (1): bitovp-vmaf: CUDA error: out of memory\n",
		});
		expect(h.run.mock.calls.map(([binary]) => binary)).toEqual([
			"bitovp-vmaf",
			"bitovp-vmaf",
		]);
	});
	it("fails a corrupt receipt without starting a CPU fallback", async () => {
		const h = await setup();
		h.receipt.cpuParity.checked = false;
		await expect(
			runLocalVmafScore(h.deps, h.options, h.context),
		).rejects.toThrow(/NATIVE_RECEIPT/);
		expect(h.run).toHaveBeenCalledTimes(2);
	});
	it("preserves ProcessRunner cancellation and refuses a receipt after abort", async () => {
		const h = await setup(),
			controller = new AbortController();
		h.run.mockImplementationOnce(async () => ({
			code: 0,
			stdout: `bitovp-vmaf 0.1 owned CUDA/Vulkan; official=${NATIVE_OFFICIAL_REVISION}; source=${source}\n`,
			stderr: "",
		}));
		h.run.mockImplementationOnce(async (_binary, args) => {
			await writeFile(
				fixtureValue(args, args.indexOf("--output") + 1),
				JSON.stringify(h.receipt),
			);
			controller.abort();
			return { code: 0, stdout: "", stderr: "" };
		});
		await expect(
			runLocalVmafScore(h.deps, h.options, {
				...h.context,
				signal: controller.signal,
			}),
		).rejects.toMatchObject({ name: "AbortError" });
		expect(h.run.mock.calls[1]?.[2]).toMatchObject({
			signal: controller.signal,
			abortKillAfterMs: 250,
		});
	});
});
