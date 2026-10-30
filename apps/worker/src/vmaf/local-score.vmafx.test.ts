import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { VmafCommandOptions } from "@bitovp/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProcessRunner } from "../feeder/supervisor";

const SHA = "e4cf8c147e1368b35497d772920bc92f98c1ad7853c1033d8a836947f427140e";
vi.mock("./vmafx-contract", async (original) => ({
	...(await original<typeof import("./vmafx-contract")>()),
	// File hashing is tested by the model contract suite; these tests exercise
	// qualification, actual receipt validation and result ownership without a GPU.
	prepareVmafxModel: vi.fn(async () => ({
		modelSha256:
			"e4cf8c147e1368b35497d772920bc92f98c1ad7853c1033d8a836947f427140e",
	})),
}));

import { runLocalVmafScore } from "./local-score";
import { VMAFX_REVISION } from "./vmafx-contract";

// Synthetic CUDA report with the field types observed in the real CPU filter
// report. This is a protocol fixture, not evidence of GPU execution or parity.
function receipt(count = 3) {
	const features = [
		"cambi_cuda",
		"speed_chroma_cuda",
		"adm_cuda",
		"motion_cuda",
		"psnr_cuda",
	];
	return {
		backend_used: "cuda",
		feature_backends: features.map((extractor) => ({
			extractor,
			backend: "cuda",
		})),
		provenance: {
			active_backend: "cuda",
			commit: VMAFX_REVISION,
			n_extractors: 5,
			n_subsample: 1,
			gpumask: "0",
			frame_width: 1920,
			frame_height: 1080,
			bpc: 10,
			n_frames: String(count),
			n_models: 1,
			models: [
				{
					name: "vmaf",
					sha256: SHA,
					flags: "0",
					overrides:
						"cambi.enc_width=1280:cambi.enc_height=720:cambi.enc_bitdepth=8",
				},
			],
		},
		frames: Array.from({ length: count }, (_, frameNum) => ({
			frameNum,
			metrics: {
				vmaf: 90 + frameNum,
				psnr_y: 40,
				psnr_cb: 41,
				psnr_cr: 42,
				cambi_fixture: 0.2,
				speed_chroma_uv_fixture: 0.1,
				integer_adm3_fixture: 0.99,
				integer_motion3_fixture: 1,
			},
		})),
	};
}

const dirs: string[] = [];
afterEach(async () => {
	await Promise.all(
		dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
	);
});

async function setup() {
	const dir = await mkdtemp(join(tmpdir(), "bitovp-vmafx-score-"));
	dirs.push(dir);
	const options: VmafCommandOptions = {
		referencePath: "/work/reference.mp4",
		distortedPath: "/work/distorted.mp4",
		model: "vmaf_v1.0.16_3d0h",
		modelPath: "/models/vmaf_v1.0.16_3d0h.json",
		logPath: join(dir, "scores.json"),
		scaleToReference: { width: 1920, height: 1080 },
		distortedOriginal: { width: 1280, height: 720, bitdepth: 8 },
		psnr: true,
		scoring: { backend: "vmafx-cuda", device: 0 },
	};
	const run = vi.fn(async (_bin: string, argv: string[]) => {
		const graph = argv[argv.indexOf("-filter_complex") + 1] ?? "";
		const path = graph.match(/log_path=([^:]+)/)?.[1];
		if (!path) throw new Error("Missing log path");
		await writeFile(path, JSON.stringify(receipt()));
		return { code: 0, stdout: "", stderr: "" };
	});
	const runner: ProcessRunner = {
		run,
		spawn() {
			throw new Error("Unexpected spawn");
		},
	};
	return {
		options,
		run,
		deps: { runner, ffmpegPath: "vmafx-ffmpeg", ffprobePath: "ffprobe" },
	};
}

describe("external CUDA scorer execution", () => {
	it("qualifies briefly, verifies the final report and reuses its parsed frames", async () => {
		const h = await setup();
		const result = await runLocalVmafScore(h.deps, h.options);
		expect(h.run).toHaveBeenCalledTimes(2);
		expect(h.run.mock.calls[0]?.[1]).toContain("-frames:v");
		expect(h.run.mock.calls[1]?.[1]).not.toContain("-frames:v");
		expect(result.execution).toMatchObject({
			device: 0,
			requestedDecode: "cpu",
			attempts: 1,
			decode: { reference: { backend: "cpu" }, distorted: { backend: "cpu" } },
			scoring: {
				backend: "cuda",
				implementation: "vmafx",
				modelSha256: SHA,
				distortedOriginal: h.options.distortedOriginal,
				bitDepth: 10,
			},
		});
		expect(result.log).toMatchObject({ frames: receipt().frames });
		await expect(
			readFile(`${h.options.logPath}.gpu-check.json`),
		).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("does not replace GPU scoring with CPU scoring when qualification fails", async () => {
		const h = await setup();
		h.run.mockResolvedValueOnce({
			code: 1,
			stdout: "",
			stderr: "No such filter: vmafx",
		});
		await expect(runLocalVmafScore(h.deps, h.options)).rejects.toThrow(
			"VMAFX_GPU_QUALIFICATION_FAILED",
		);
		expect(h.run).toHaveBeenCalledTimes(1);
	});

	it("rejects a CPU feature even when the report labels its overall backend CUDA", async () => {
		const h = await setup();
		h.run.mockImplementationOnce(async () => {
			const report = receipt();
			report.feature_backends = report.feature_backends.map((feature, index) =>
				index === 0 ? { ...feature, backend: "cpu" } : feature,
			);
			await writeFile(
				`${h.options.logPath}.gpu-check.json`,
				JSON.stringify(report),
			);
			return { code: 0, stdout: "", stderr: "" };
		});
		await expect(runLocalVmafScore(h.deps, h.options)).rejects.toThrow(
			"VMAFX_RECEIPT_FEATURE_MISMATCH",
		);
		expect(h.run).toHaveBeenCalledTimes(1);
	});

	it("checks the full execution receipt again after successful qualification", async () => {
		const h = await setup();
		h.run
			.mockImplementationOnce(async () => {
				await writeFile(
					`${h.options.logPath}.gpu-check.json`,
					JSON.stringify(receipt()),
				);
				return { code: 0, stdout: "", stderr: "" };
			})
			.mockImplementationOnce(async () => {
				const report = receipt();
				report.provenance.models = report.provenance.models.map((model) => ({
					...model,
					sha256: "b".repeat(64),
				}));
				await writeFile(h.options.logPath, JSON.stringify(report));
				return { code: 0, stdout: "", stderr: "" };
			});
		await expect(runLocalVmafScore(h.deps, h.options)).rejects.toThrow(
			"VMAFX_RECEIPT_MODEL_MISMATCH",
		);
		expect(h.run).toHaveBeenCalledTimes(2);
	});

	it("waits for qualification close, then honours cancellation without starting the full run", async () => {
		const h = await setup();
		const controller = new AbortController();
		h.run.mockImplementationOnce(async () => {
			await writeFile(
				`${h.options.logPath}.gpu-check.json`,
				JSON.stringify(receipt()),
			);
			controller.abort();
			return { code: 0, stdout: "", stderr: "" };
		});
		await expect(
			runLocalVmafScore(h.deps, h.options, { signal: controller.signal }),
		).rejects.toMatchObject({ name: "AbortError" });
		expect(h.run).toHaveBeenCalledTimes(1);
		await expect(
			readFile(`${h.options.logPath}.gpu-check.json`),
		).rejects.toMatchObject({ code: "ENOENT" });
	});
});
