import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseVmafJson, type VmafCommandOptions } from "@bitovp/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runLocalVmafScore } from "./local-score";
import { NATIVE_OFFICIAL_REVISION } from "./native-contract";
import { fixtureValue, nativeReceipt, SHA } from "./native-fixture.test-helper";

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
			await writeFile(
				fixtureValue(args, args.indexOf("--output") + 1),
				JSON.stringify(receipt),
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
			"--bit-depth",
			"10",
			"--verify-cpu",
			"--model",
			`${h.options.model}=${h.options.modelPath}`,
		])
			expect(args).toContain(token);
		expect(context).toMatchObject({ abortKillAfterMs: 250 });
		expect(result.execution.scoring).toMatchObject({
			implementation: "bitovp-owned",
			backend: "vulkan",
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
		{ r_frame_rate: "24/1", avg_frame_rate: "24/1" },
	])("refuses unqualified input presentation: %j", async (extra) => {
		const h = await setup();
		await expect(
			runLocalVmafScore(h.deps, h.options, {
				...h.context,
				distortedProbe: probe(extra),
			}),
		).rejects.toThrow(/NATIVE_UNSUPPORTED/);
		expect(h.run).not.toHaveBeenCalled();
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
