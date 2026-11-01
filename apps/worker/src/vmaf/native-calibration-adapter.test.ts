import {
	mkdtemp,
	readdir,
	readFile,
	rm,
	stat,
	truncate,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { VmafCommandOptions } from "@bitovp/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProcessRunner } from "../feeder/supervisor";
import {
	createNativeCalibrationAdapter,
	type NativeCalibrationRequest,
	nativeCalibrationTemplates,
} from "./native-calibration-adapter";
import { runNativeVmafScore } from "./native-score";

vi.mock("./native-score", () => ({ runNativeVmafScore: vi.fn() }));
const score = vi.mocked(runNativeVmafScore);
const directories: string[] = [];
afterEach(async () => {
	vi.useRealTimers();
	vi.resetAllMocks();
	await Promise.all(
		directories
			.splice(0)
			.map((path) => rm(path, { recursive: true, force: true })),
	);
});
const probe = (extra: Record<string, unknown> = {}) =>
	JSON.stringify({
		streams: [
			{
				codec_type: "video",
				codec_name: "h264",
				width: 1920,
				height: 1080,
				pix_fmt: "yuv420p",
				bits_per_raw_sample: "8",
				avg_frame_rate: "24/1",
				r_frame_rate: "24/1",
				...extra,
			},
		],
	});
const serial = {
	concurrency: 1,
	cpuThreads: 1,
	decoderThreads: 1,
	inflightFrames: 4,
} as const;
const parallel = { ...serial, concurrency: 3 };
function required<T>(value: T | undefined): T {
	if (value === undefined) throw new Error("Missing test value");
	return value;
}
const pause = (ms: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));

function result(frames: number) {
	return {
		run: { code: 0, stdout: "", stderr: "" },
		execution: {
			version: 1,
			requestedDecode: "cpu",
			device: 0,
			decode: { reference: { backend: "cpu" }, distorted: { backend: "cpu" } },
			attempts: 1,
			scoring: {
				backend: "vulkan",
				implementation: "bitovp-owned",
				model: "vmaf_v1.0.16_3d0h",
				modelSha256: "b".repeat(64),
				features: ["a", "b", "c", "d", "e", "f", "g"],
				bitDepth: 10,
				distortedOriginal: { width: 1920, height: 1080, bitdepth: 8 },
				officialRevision: "c".repeat(40),
				sourceSha256: "d".repeat(64),
				device: {
					index: 0,
					name: "device",
					uuid: "uuid",
					vendorId: 0x1002,
					deviceId: 1,
					integrated: true,
				},
				cpuParity: {
					checked: true,
					featureCount: 7 * frames,
					scoreCount: frames,
					maxFeatureError: 0,
					maxScoreError: 0,
				},
			},
		},
		log: {
			frames: Array.from({ length: frames }, (_, frameNum) => ({
				frameNum,
				metrics: { vmaf: 95 },
			})),
			pooled_metrics: {
				vmaf: { min: 95, max: 95, mean: 95, harmonic_mean: 95 },
			},
		},
		resourceSnapshot: {
			maxRssBytes: 1000,
			gpuOwnedBytes: 2000,
			scope: "before-result-serialization",
		},
	} as Awaited<ReturnType<typeof runNativeVmafScore>>;
}

async function setup() {
	const directory = await mkdtemp(
		join(tmpdir(), "bitovp-calibration-adapter-"),
	);
	directories.push(directory);
	const workDirectory = join(directory, "work"),
		cacheDirectory = join(directory, "cache");
	const options: VmafCommandOptions = {
		referencePath: join(directory, "reference.mov"),
		distortedPath: join(directory, "distorted.mp4"),
		logPath: join(directory, "actual-job.json"),
		model: "vmaf_v1.0.16_3d0h",
		modelPath: "/models/official.json",
		scaleToReference: { width: 1920, height: 1080 },
		distortedOriginal: { width: 1920, height: 1080, bitdepth: 8 },
		scoring: { backend: "vulkan", device: 0 },
		psnr: true,
	};
	await writeFile(options.referencePath, "original reference");
	await writeFile(options.distortedPath, "original distorted");
	let exclusive = false;
	const lease = new AbortController();
	const run = vi.fn<ProcessRunner["run"]>(async (binary, args, context) => {
		expect(exclusive).toBe(true);
		context?.signal?.throwIfAborted();
		if (binary === "ffmpeg") {
			await writeFile(required(args.at(-1)), "packet-copy prefix");
			return { code: 0, stdout: "", stderr: "" };
		}
		return { code: 0, stdout: probe(), stderr: "" };
	});
	const runner: ProcessRunner = {
		run,
		spawn() {
			throw new Error("unexpected spawn");
		},
	};
	score.mockImplementation(async (_deps, _options, context) => {
		expect(exclusive).toBe(true);
		context.signal?.throwIfAborted();
		await pause(1);
		return result(required(context.calibrationFrames));
	});
	const adapter = createNativeCalibrationAdapter({
		runner,
		ffmpegPath: "ffmpeg",
		ffprobePath: "ffprobe",
		nativePath: "native-vmaf",
		cacheDirectory,
		workDirectory,
	});
	const request: NativeCalibrationRequest = {
		profileKey: "a".repeat(64),
		cacheable: true,
		options,
		referenceProbe: probe(),
		distortedProbe: probe(),
		signal: new AbortController().signal,
		fullFrameCount: 10000,
		templates: [serial, parallel],
		fixedWorkUnits: 3,
		sampleFrames: 4,
		budgetMs: 1000,
		trialTimeoutMs: 1000,
		memoryPadding: {
			hostMarginFactor: 1.25,
			hostPerFrameBytes: 4096,
			gpuPerProcessOverheadBytes: 100,
			gpuMarginFactor: 1.1,
		},
		async withExclusiveCalibration(work, signal) {
			signal.throwIfAborted();
			exclusive = true;
			try {
				return await work(AbortSignal.any([signal, lease.signal]));
			} finally {
				exclusive = false;
			}
		},
	};
	return {
		directory,
		workDirectory,
		cacheDirectory,
		options,
		run,
		runner,
		adapter,
		request,
		lease,
		isExclusive: () => exclusive,
	};
}

describe("native calibration template order", () => {
	it("interleaves compute threads and parallel shapes before the remaining grid", () => {
		const rows = nativeCalibrationTemplates({
			cpuCapacity: 24,
			maxConcurrency: 6,
			supportedInflightFrames: [1, 2, 4],
			workloadMode: "parallel-batch",
		});
		expect(
			rows
				.slice(0, 8)
				.map((t) => [t.concurrency, t.cpuThreads, t.decoderThreads]),
		).toEqual([
			[1, 2, 1],
			[2, 2, 1],
			[3, 4, 1],
			[4, 2, 1],
			[1, 4, 1],
			[6, 1, 1],
			[1, 1, 1],
			[3, 2, 2],
		]);
	});
	it("covers useful non-power-of-two concurrency with bounded CPU cost", () => {
		const templates = nativeCalibrationTemplates({
			cpuCapacity: 24,
			maxConcurrency: 32,
			supportedInflightFrames: [1, 2, 4],
		});
		expect(templates[0]).toEqual(serial);
		expect(templates.slice(0, 5).map((t) => t.concurrency)).toEqual([
			1, 2, 3, 4, 6,
		]);
		expect(templates.some((t) => t.inflightFrames === 1)).toBe(true);
		expect(templates.some((t) => t.inflightFrames === 2)).toBe(true);
		expect(templates.some((t) => t.decoderThreads === 2)).toBe(true);
		expect(templates.some((t) => t.cpuThreads === 2)).toBe(true);
		expect(templates.length).toBeLessThanOrEqual(32);
		for (const t of templates)
			expect(
				t.concurrency * (t.cpuThreads + 2 * t.decoderThreads + 1),
			).toBeLessThanOrEqual(24);
		expect(new Set(templates.map((t) => JSON.stringify(t))).size).toBe(
			templates.length,
		);
	});
	it("does not calibrate unsupported manual settings or sub-minimum CPU quotas", () => {
		for (const cpuCapacity of [NaN, 0, 0.5, 3.99])
			expect(
				nativeCalibrationTemplates({
					cpuCapacity,
					maxConcurrency: 32,
					supportedInflightFrames: [1, 2, 4],
				}),
			).toEqual([]);
		expect(
			nativeCalibrationTemplates({
				cpuCapacity: 24,
				maxConcurrency: 6,
				supportedInflightFrames: [4],
				manualThreads: 3,
			}),
		).toEqual([]);
		expect(
			nativeCalibrationTemplates({
				cpuCapacity: 24,
				maxConcurrency: 6,
				supportedInflightFrames: [1],
				manualThreads: 2,
			}).every((t) => t.cpuThreads === 2 && t.inflightFrames === 1),
		).toBe(true);
	});
	it("keeps all generated templates CPU-safe across capacity changes", () => {
		for (const cpuCapacity of [4, 4.9, 5, 8, 12, 24, 64, 128, 1000]) {
			for (const maxConcurrency of [1, 3, 6, 32, 1000]) {
				const templates = nativeCalibrationTemplates({
					cpuCapacity,
					maxConcurrency,
					supportedInflightFrames: [1, 2, 4],
				});
				expect(templates[0]?.concurrency).toBe(1);
				expect(templates.length).toBeLessThanOrEqual(32);
				for (const template of templates) {
					expect(template.concurrency).toBeLessThanOrEqual(
						Math.min(32, maxConcurrency),
					);
					expect(
						template.concurrency *
							(template.cpuThreads + 2 * template.decoderThreads + 1),
					).toBeLessThanOrEqual(cpuCapacity);
				}
			}
		}
	});
});

describe("native calibration adapter", () => {
	it("runs one parallel wave with identical frames per child", async () => {
		const h = await setup();
		const rows = await h.adapter.calibrate({
			...h.request,
			workloadMode: "parallel-batch",
			fixedWorkUnits: 1,
			sampleFrames: 64,
		});
		expect(rows.map((row) => row.trials.map((t) => t.workFrames))).toEqual([
			[64, 64, 64],
			[192, 192, 192],
		]);
		expect(score).toHaveBeenCalledTimes(12);
		expect(
			score.mock.calls.every(
				([, , context]) => context.calibrationFrames === 64,
			),
		).toBe(true);
	});
	it("uses the actual short-input sample in parallel workload metadata", async () => {
		const h = await setup();
		const rows = await h.adapter.calibrate({
			...h.request,
			workloadMode: "parallel-batch",
			fixedWorkUnits: undefined,
			sampleFrames: undefined,
			fullFrameCount: 2,
		});
		expect(rows.every((row) => row.workload?.sampleFrames === 2)).toBe(true);
		expect(
			score.mock.calls.every(
				([, , context]) => context.calibrationFrames === 2,
			),
		).toBe(true);
		await expect(
			h.adapter.calibrate({
				...h.request,
				workloadMode: "parallel-batch",
				fixedWorkUnits: 1,
				sampleFrames: 64,
				fullFrameCount: 2,
			}),
		).rejects.toThrow("NATIVE_CALIBRATION_OPTIONS_INVALID");
	});
	it("copies each input once under its lease and measures identical verified fixed work", async () => {
		const h = await setup();
		const candidates = await h.adapter.calibrate(h.request);
		expect(candidates.map((c) => c.concurrency)).toEqual([1, 3]);
		expect(
			candidates.every(
				(c) =>
					c.trials.length === 3 &&
					c.trials.every((t) => t.workFrames === 12 && t.cpuVerified),
			),
		).toBe(true);
		expect(candidates[0]?.hostBytesPerComparison).toBe(10000 * 4096 + 1250);
		expect(h.run.mock.calls.filter(([bin]) => bin === "ffmpeg")).toHaveLength(
			2,
		);
		expect(score).toHaveBeenCalledTimes(18);
		const paths = new Set<string>();
		for (const [_deps, options, context] of score.mock.calls) {
			paths.add(options.logPath);
			expect(options.referencePath).not.toBe(h.options.referencePath);
			expect(options.distortedPath).not.toBe(h.options.distortedPath);
			expect(options.psnr).toBe(true);
			expect(context).toMatchObject({
				calibrationFrames: 4,
				nativeInflightFrames: 4,
			});
			expect(options.threads).toBe(1);
			expect(options.decoderThreads).toBe(1);
		}
		expect(paths.size).toBe(18);
		for (const [, args] of h.run.mock.calls.filter(
			([bin]) => bin === "ffmpeg",
		)) {
			for (const [key, value] of [
				["-c:v", "copy"],
				["-map", "0:v:0"],
				["-avoid_negative_ts", "disabled"],
				["-frames:v", "68"],
			])
				expect(args[args.indexOf(required(key)) + 1]).toBe(value);
			expect(args).toEqual(
				expect.arrayContaining([
					"-copyts",
					"-start_at_zero",
					"-an",
					"-sn",
					"-dn",
				]),
			);
			expect(Number(args[args.indexOf("-fs") + 1])).toBeLessThanOrEqual(
				32 * 1024 ** 2,
			);
			expect(Number(args[args.indexOf("-t") + 1])).toBeLessThanOrEqual(30);
		}
		expect(await readFile(h.options.referencePath, "utf8")).toBe(
			"original reference",
		);
		await expect(stat(h.options.logPath)).rejects.toMatchObject({
			code: "ENOENT",
		});
		expect(await readdir(h.workDirectory)).toEqual([]);
		expect(h.isExclusive()).toBe(false);
	});
	it("reuses metadata cache without preparing media and filters previously wider templates", async () => {
		const h = await setup();
		await h.adapter.calibrate(h.request);
		h.run.mockClear();
		score.mockClear();
		const candidates = await h.adapter.calibrate({
			...h.request,
			templates: [serial],
			fullFrameCount: 20000,
		});
		expect(candidates).toHaveLength(1);
		expect(candidates[0]?.hostBytesPerComparison).toBe(20000 * 4096 + 1250);
		expect(h.run).not.toHaveBeenCalled();
		expect(score).not.toHaveBeenCalled();
	});
	it("fills a wider template set later without changing fixed work under memory pressure", async () => {
		const h = await setup();
		const first = await h.adapter.calibrate({
			...h.request,
			templates: [serial],
			fixedWorkUnits: 6,
		});
		expect(first[0]?.trials.every((t) => t.workFrames === 24)).toBe(true);
		score.mockClear();
		h.run.mockClear();
		const wider = await h.adapter.calibrate({
			...h.request,
			fixedWorkUnits: 6,
		});
		expect(wider).toHaveLength(2);
		expect(wider.every((c) => c.trials.every((t) => t.workFrames === 24))).toBe(
			true,
		);
		expect(score).toHaveBeenCalledTimes(18);
	});
	it("rejects fixed work smaller than concurrency before any process starts", async () => {
		const h = await setup();
		await expect(
			h.adapter.calibrate({ ...h.request, fixedWorkUnits: 2 }),
		).rejects.toThrow("NATIVE_CALIBRATION_OPTIONS_INVALID");
		expect(h.run).not.toHaveBeenCalled();
		expect(score).not.toHaveBeenCalled();
	});
	it("passes per-template CPU and decoder controls through to every comparison", async () => {
		const h = await setup();
		await h.adapter.calibrate({
			...h.request,
			templates: [
				{ concurrency: 1, cpuThreads: 4, decoderThreads: 2, inflightFrames: 2 },
			],
		});
		for (const [, options, context] of score.mock.calls) {
			expect(options).toMatchObject({ threads: 4, decoderThreads: 2 });
			expect(context.nativeInflightFrames).toBe(2);
		}
	});
	it("caps the default sample to a short real input and never changes actual job options", async () => {
		const h = await setup();
		const original = structuredClone(h.options);
		await h.adapter.calibrate({
			...h.request,
			fullFrameCount: 2,
			sampleFrames: undefined,
			templates: [serial],
		});
		expect(
			score.mock.calls.every(
				([, , context]) => context.calibrationFrames === 2,
			),
		).toBe(true);
		expect(h.options).toEqual(original);
	});
	it("keeps different concurrent profile requests bound to their own input settings", async () => {
		const h = await setup();
		const secondReference = join(h.directory, "second.mov");
		await writeFile(secondReference, "second original");
		const requests = [
			h.request,
			{
				...h.request,
				profileKey: "e".repeat(64),
				options: { ...h.options, referencePath: secondReference },
			},
		];
		let tail = Promise.resolve();
		const exclusive: NativeCalibrationRequest["withExclusiveCalibration"] =
			async (work, signal) => {
				const prior = tail;
				let release = () => {};
				tail = new Promise<void>((resolve) => {
					release = resolve;
				});
				await prior;
				try {
					return await h.request.withExclusiveCalibration(work, signal);
				} finally {
					release();
				}
			};
		await Promise.all(
			requests.map((request) =>
				h.adapter.calibrate({
					...request,
					withExclusiveCalibration: exclusive,
				}),
			),
		);
		const copiedSources = h.run.mock.calls
			.filter(([binary]) => binary === "ffmpeg")
			.map(([, args]) => args[args.indexOf("-i") + 1]);
		expect(copiedSources).toContain(secondReference);
		expect(copiedSources).toContain(h.options.referencePath);
		expect(
			copiedSources.filter((path) => path === h.options.distortedPath),
		).toHaveLength(2);
		expect(await readdir(h.workDirectory)).toEqual([]);
	});
	it("bounds active comparisons while measuring complete process makespan", async () => {
		const h = await setup();
		let active = 0,
			maxActive = 0;
		score.mockImplementation(async (_deps, _options, context) => {
			active++;
			maxActive = Math.max(maxActive, active);
			try {
				await pause(8);
				return result(required(context.calibrationFrames));
			} finally {
				active--;
			}
		});
		const candidates = await h.adapter.calibrate(h.request);
		expect(maxActive).toBe(3);
		expect(active).toBe(0);
		expect(candidates[0]?.trials.every((t) => t.wallMs >= 20)).toBe(true);
		expect(candidates[1]?.trials.every((t) => t.wallMs >= 7)).toBe(true);
	});
	it.each([
		{ width: 1280 },
		{ pix_fmt: "yuv420p10le", bits_per_raw_sample: "10" },
		{ avg_frame_rate: "30/1", r_frame_rate: "30/1" },
		{ codec_name: "hevc" },
	])("rejects a changed packet-copy format %j and removes prefixes", async (change) => {
		const h = await setup();
		h.run.mockImplementation(async (binary, args) => {
			if (binary === "ffmpeg") {
				await writeFile(required(args.at(-1)), "prefix");
				return { code: 0, stdout: "", stderr: "" };
			}
			return { code: 0, stdout: probe(change), stderr: "" };
		});
		await expect(h.adapter.calibrate(h.request)).rejects.toThrow(
			"NATIVE_CALIBRATION_PROXY_FORMAT_MISMATCH",
		);
		expect(score).not.toHaveBeenCalled();
		expect(await readdir(h.workDirectory)).toEqual([]);
	});
	it("rejects oversize prefixes without using them for a native measurement", async () => {
		const h = await setup();
		h.run.mockImplementation(async (binary, args) => {
			if (binary === "ffmpeg") {
				const path = required(args.at(-1));
				await writeFile(path, "");
				await truncate(path, 32 * 1024 ** 2 + 1);
			}
			return { code: 0, stdout: probe(), stderr: "" };
		});
		await expect(h.adapter.calibrate(h.request)).rejects.toThrow(
			"NATIVE_CALIBRATION_PROXY_SIZE_INVALID",
		);
		expect(score).not.toHaveBeenCalled();
		expect(await readdir(h.workDirectory)).toEqual([]);
	});
	it.each([
		"fixed-batch",
		"parallel-batch",
	] as const)("keeps work directories private and drains failed siblings before releasing the lease (%s)", async (workloadMode) => {
		const h = await setup();
		let active = 0,
			failed = false,
			drained = false;
		score.mockImplementation(async (_deps, options, context) => {
			expect((await stat(dirname(options.logPath))).mode & 0o777).toBe(0o700);
			active++;
			try {
				if (score.mock.calls.length <= 9)
					return result(required(context.calibrationFrames));
				if (!failed) {
					failed = true;
					await pause(2);
					throw new Error("parity mismatch");
				}
				await new Promise<void>((resolve) =>
					required(context.signal).addEventListener("abort", () => resolve(), {
						once: true,
					}),
				);
				await pause(10);
				drained = true;
				required(context.signal).throwIfAborted();
				throw new Error("unreachable");
			} finally {
				active--;
			}
		});
		await expect(
			h.adapter.calibrate({
				...h.request,
				workloadMode,
				fixedWorkUnits:
					workloadMode === "parallel-batch" ? 1 : h.request.fixedWorkUnits,
			}),
		).rejects.toThrow("parity mismatch");
		expect(drained).toBe(true);
		expect(active).toBe(0);
		expect(h.isExclusive()).toBe(false);
		expect(await readdir(h.workDirectory)).toEqual([]);
	});
	it("drains the media owner before rejection and lets another job use its own input pair", async () => {
		const h = await setup();
		const secondOptions = {
			...h.options,
			referencePath: join(h.directory, "second-reference.mov"),
			distortedPath: join(h.directory, "second-distorted.mp4"),
		};
		await writeFile(secondOptions.referencePath, "second reference");
		await writeFile(secondOptions.distortedPath, "second distorted");
		const controller = new AbortController();
		let enter = () => {};
		const entered = new Promise<void>((resolve) => {
			enter = resolve;
		});
		let drain = () => {};
		const draining = new Promise<void>((resolve) => {
			drain = resolve;
		});
		let running = false,
			originalPresentDuringDrain = false,
			rejectedWhileRunning = false,
			rejected = false;
		h.run.mockImplementation(async (binary, args, context) => {
			if (binary !== "ffmpeg") return { code: 0, stdout: probe(), stderr: "" };
			const source = required(args[args.indexOf("-i") + 1]);
			if (source === h.options.referencePath) {
				running = true;
				enter();
				try {
					await draining;
					originalPresentDuringDrain =
						(await readFile(source, "utf8")) === "original reference";
					required(context?.signal).throwIfAborted();
				} finally {
					running = false;
				}
			}
			await writeFile(required(args.at(-1)), await readFile(source));
			return { code: 0, stdout: "", stderr: "" };
		});
		let tail = Promise.resolve();
		const exclusive: NativeCalibrationRequest["withExclusiveCalibration"] =
			async (work, signal) => {
				const prior = tail;
				let release = () => {};
				tail = new Promise<void>((resolve) => {
					release = resolve;
				});
				await prior;
				try {
					return await h.request.withExclusiveCalibration(work, signal);
				} finally {
					release();
				}
			};
		const first = h.adapter
			.calibrate({
				...h.request,
				signal: controller.signal,
				withExclusiveCalibration: exclusive,
			})
			.catch(async (error) => {
				rejected = true;
				rejectedWhileRunning = running;
				await Promise.all([
					rm(h.options.referencePath),
					rm(h.options.distortedPath),
				]);
				throw error;
			});
		const rejection = expect(first).rejects.toThrow("owner cancelled");
		await entered;
		const second = h.adapter.calibrate({
			...h.request,
			options: secondOptions,
			withExclusiveCalibration: exclusive,
		});
		controller.abort(new Error("owner cancelled"));
		await pause(5);
		const rejectedBeforeDrain = rejected;
		drain();
		await rejection;
		const remaining = await second;
		expect(rejectedBeforeDrain).toBe(false);
		expect(rejectedWhileRunning).toBe(false);
		expect(originalPresentDuringDrain).toBe(true);
		expect(remaining).toHaveLength(2);
		const sources = h.run.mock.calls
			.filter(([binary]) => binary === "ffmpeg")
			.map(([, args]) => args[args.indexOf("-i") + 1]);
		expect(sources).toEqual([
			h.options.referencePath,
			secondOptions.referencePath,
			secondOptions.distortedPath,
		]);
		expect(await readdir(h.workDirectory)).toEqual([]);
	});
	it("propagates lease loss and waits for native cleanup", async () => {
		const h = await setup();
		let start!: () => void;
		const started = new Promise<void>((resolve) => {
			start = resolve;
		});
		let drained = false;
		score.mockImplementation(async (_deps, _options, context) => {
			start();
			await new Promise<void>((resolve) =>
				required(context.signal).addEventListener("abort", () => resolve(), {
					once: true,
				}),
			);
			await pause(5);
			drained = true;
			required(context.signal).throwIfAborted();
			throw new Error("unreachable");
		});
		const pending = h.adapter.calibrate(h.request);
		await started;
		h.lease.abort(new Error("lease lost"));
		await expect(pending).rejects.toThrow("lease lost");
		expect(drained).toBe(true);
		expect(await readdir(h.workDirectory)).toEqual([]);
		expect(h.isExclusive()).toBe(false);
	});
	it("drains a cancelled packet-copy child and removes the incomplete prefix", async () => {
		const h = await setup();
		let start!: () => void;
		const started = new Promise<void>((resolve) => {
			start = resolve;
		});
		let drained = false;
		h.run.mockImplementation(async (_binary, args, context) => {
			await writeFile(required(args.at(-1)), "partial prefix");
			start();
			await new Promise<void>((resolve) =>
				required(context?.signal).addEventListener("abort", () => resolve(), {
					once: true,
				}),
			);
			await pause(5);
			drained = true;
			required(context?.signal).throwIfAborted();
			throw new Error("unreachable");
		});
		const pending = h.adapter.calibrate(h.request);
		await started;
		h.lease.abort(new Error("lease lost while copying"));
		await expect(pending).rejects.toThrow("lease lost while copying");
		expect(drained).toBe(true);
		expect(score).not.toHaveBeenCalled();
		expect(await readdir(h.workDirectory)).toEqual([]);
		expect(h.isExclusive()).toBe(false);
	});
	it.each([
		"native",
		"proxy",
	] as const)("does not qualify a timed-out comparison after its process settles (%s)", async (stage) => {
		const h = await setup();
		let enter = () => {},
			abortObserved = () => {},
			release = () => {};
		const entered = new Promise<void>((resolve) => {
			enter = resolve;
		});
		const aborted = new Promise<void>((resolve) => {
			abortObserved = resolve;
		});
		const draining = new Promise<void>((resolve) => {
			release = resolve;
		});
		let drained = false;
		const drainChild = async (signal: AbortSignal): Promise<never> => {
			enter();
			await new Promise<void>((resolve) =>
				signal.addEventListener(
					"abort",
					() => {
						abortObserved();
						resolve();
					},
					{
						once: true,
					},
				),
			);
			await draining;
			drained = true;
			signal.throwIfAborted();
			throw new Error("unreachable");
		};
		score.mockImplementation(async (_deps, _options, context) =>
			drainChild(required(context.signal)),
		);
		if (stage === "proxy") {
			const runProcess = required(h.run.getMockImplementation());
			h.run.mockImplementation(async (binary, args, context) =>
				binary === "ffmpeg"
					? drainChild(required(context?.signal))
					: runProcess(binary, args, context),
			);
		}
		// Filesystem preparation is real, but only the native-process timeout
		// advances here; a busy machine cannot expire it before native entry.
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		let settled = false;
		const pending = h.adapter
			.calibrate({
				...h.request,
				trialTimeoutMs: 10,
			})
			.finally(() => {
				settled = true;
			});
		try {
			await entered;
			expect(score).toHaveBeenCalledTimes(stage === "native" ? 1 : 0);
			await vi.advanceTimersByTimeAsync(10);
			await aborted;
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(settled).toBe(false);
			expect(drained).toBe(false);
			expect(h.isExclusive()).toBe(true);
			release();
			expect(await pending).toEqual([]);
			expect(drained).toBe(true);
			expect(h.isExclusive()).toBe(false);
			expect(await readdir(h.cacheDirectory)).toEqual([]);
			expect(await readdir(h.workDirectory)).toEqual([]);
		} finally {
			h.lease.abort(new DOMException("Test cleanup", "AbortError"));
			release();
			await pending.catch(() => undefined);
			vi.useRealTimers();
		}
	});
	it.each([
		"cpu-proof",
		"resource-snapshot",
		"frame-count",
	])("never caches an invalid native result: %s", async (failure) => {
		const h = await setup();
		score.mockImplementation(async () => {
			const value = result(4);
			if (failure === "cpu-proof")
				(
					value.execution.scoring as { cpuParity: { checked: boolean } }
				).cpuParity.checked = false;
			if (failure === "resource-snapshot") value.resourceSnapshot = undefined;
			if (failure === "frame-count") value.log.frames.pop();
			return value;
		});
		await expect(h.adapter.calibrate(h.request)).rejects.toThrow(
			"NATIVE_CALIBRATION_RESULT_INVALID",
		);
		expect(await readdir(h.cacheDirectory)).toEqual([]);
		expect(await readdir(h.workDirectory)).toEqual([]);
	});
});
