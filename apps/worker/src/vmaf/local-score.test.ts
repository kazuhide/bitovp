import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildVmafCommand } from "@bitovp/core";
import { describe, expect, it, vi } from "vitest";
import type { ProcessRunner } from "../feeder/supervisor";
import { runLocalVmafScore } from "./local-score";

const OPTIONS = {
	referencePath: "/work/reference.mp4",
	distortedPath: "/work/distorted.mp4",
	model: "vmaf_v1.0.16_3d0h",
	modelPath: "/models/vmaf_v1.0.16_3d0h.json",
	logPath: "/work/scores.json",
	scaleToReference: { width: 1920, height: 1080 },
	psnr: true,
};
const PROBE = JSON.stringify({
	streams: [
		{
			codec_type: "video",
			codec_name: "h264",
			pix_fmt: "yuv420p",
			width: 1920,
			height: 1080,
			bits_per_raw_sample: "8",
		},
	],
});
const ok = { code: 0, stderr: "", stdout: "" };
const noGpu = "Cannot load libcuda.so.1";

function harness(
	score: (argv: string[]) => Promise<typeof ok> = async () => ok,
) {
	const run = vi.fn(async (_bin: string, argv: string[]) => {
		if (argv.includes("-show_streams")) return { ...ok, stdout: PROBE };
		if (argv.includes("-progress"))
			return { ...ok, stdout: "frame=3\nprogress=end\n" };
		return score(argv);
	});
	const runner: ProcessRunner = {
		run,
		spawn() {
			throw new Error("Unexpected spawn");
		},
	};
	return {
		run,
		deps: { runner, ffmpegPath: "ffmpeg", ffprobePath: "ffprobe" },
	};
}

describe("local VMAF execution", () => {
	it("runs the unchanged CPU argv without hardware discovery by default", async () => {
		const h = harness();
		const result = await runLocalVmafScore(h.deps, OPTIONS);
		expect(h.run).toHaveBeenCalledTimes(1);
		expect(h.run.mock.calls[0]?.[1]).toEqual(buildVmafCommand(OPTIONS));
		expect(result.execution).toMatchObject({
			requestedDecode: "cpu",
			decode: { reference: { backend: "cpu" }, distorted: { backend: "cpu" } },
			scoring: {
				backend: "cpu",
				implementation: "libvmaf",
				model: OPTIONS.model,
			},
			attempts: 1,
		});
	});

	it("records successful CUDA decoding separately from CPU v1 scoring", async () => {
		const h = harness();
		const result = await runLocalVmafScore(
			{
				...h.deps,
				decodePolicy: { backend: "auto", device: 0 },
			},
			OPTIONS,
			{ referenceProbe: PROBE, distortedProbe: PROBE },
		);
		expect(h.run).toHaveBeenCalledTimes(3);
		expect(result.execution).toMatchObject({
			decode: {
				reference: { backend: "cuda" },
				distorted: { backend: "cuda" },
			},
			scoring: { backend: "cpu", model: OPTIONS.model },
			attempts: 1,
		});
		const argv = h.run.mock.calls.at(-1)?.[1] ?? [];
		expect(argv.join(" ")).toContain(
			"libvmaf=model=path=/models/vmaf_v1.0.16_3d0h.json",
		);
		expect(argv.join(" ")).toContain("feature=name=psnr");
	});

	it("waits for GPU close and removes its partial log before one CPU retry", async () => {
		const dir = await mkdtemp(join(tmpdir(), "bitovp-decode-retry-"));
		const logPath = join(dir, "scores.json");
		let release!: (result: typeof ok) => void;
		let gpuStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			gpuStarted = resolve;
		});
		const calls: string[][] = [];
		const h = harness(async (argv) => {
			calls.push(argv);
			if (argv.includes("-hwaccel")) {
				await writeFile(logPath, "partial GPU output");
				gpuStarted();
				return new Promise((resolve) => {
					release = resolve;
				});
			}
			await expect(readFile(logPath)).rejects.toMatchObject({ code: "ENOENT" });
			return ok;
		});
		try {
			const pending = runLocalVmafScore(
				{
					...h.deps,
					decodePolicy: { backend: "auto", device: 0 },
				},
				{ ...OPTIONS, logPath },
				{ referenceProbe: PROBE, distortedProbe: PROBE },
			);
			await started;
			expect(calls).toHaveLength(1);
			release({ ...ok, code: 1, stderr: noGpu });
			const result = await pending;
			expect(calls).toHaveLength(2);
			expect(calls[1]).toEqual(buildVmafCommand({ ...OPTIONS, logPath }));
			expect(result.execution.attempts).toBe(2);
			expect(result.execution.fallbackReason).toBeTruthy();
			expect(result.execution.decode.reference.backend).toBe("cpu");
			expect(result.execution.decode.distorted.backend).toBe("cpu");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it.each([
		"Invalid data found when processing input",
		"could not load libvmaf model",
		"Unknown scoring error",
	])("does not hide a non-hardware failure with a CPU retry: %s", async (stderr) => {
		const h = harness(async () => ({ ...ok, code: 1, stderr }));
		const result = await runLocalVmafScore(
			{
				...h.deps,
				decodePolicy: { backend: "auto", device: 0 },
			},
			OPTIONS,
			{ referenceProbe: PROBE, distortedProbe: PROBE },
		);
		expect(h.run).toHaveBeenCalledTimes(3);
		expect(result.run.code).toBe(1);
		expect(result.execution.attempts).toBe(1);
	});

	it("does not retry after cancellation even if stderr contains a CUDA error", async () => {
		const abort = new AbortController();
		const h = harness(async () => {
			abort.abort();
			return { ...ok, code: 1, stderr: noGpu };
		});
		await expect(
			runLocalVmafScore(
				{
					...h.deps,
					decodePolicy: { backend: "auto", device: 0 },
				},
				OPTIONS,
				{ signal: abort.signal, referenceProbe: PROBE, distortedProbe: PROBE },
			),
		).rejects.toMatchObject({ name: "AbortError" });
		expect(h.run).toHaveBeenCalledTimes(3);
	});

	it("does not downgrade explicit CUDA decoding after a runtime failure", async () => {
		const h = harness(async () => ({ ...ok, code: 1, stderr: noGpu }));
		const result = await runLocalVmafScore(
			{
				...h.deps,
				decodePolicy: { backend: "cuda", device: 0 },
			},
			OPTIONS,
			{ referenceProbe: PROBE, distortedProbe: PROBE },
		);
		expect(result.run.code).toBe(1);
		expect(result.execution.attempts).toBe(1);
		expect(h.run).toHaveBeenCalledTimes(3);
	});
});
