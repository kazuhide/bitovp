import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { gunzipSync } from "node:zlib";
import type { AppPrismaClient } from "@bitovp/db";
import type { ObjectStorageBrowser, StorageObject } from "@bitovp/storage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProcessRunner } from "../feeder/supervisor";
import type { ResolvedCredential } from "../orchestrator/executor";
import {
	alignWithFallback,
	type CaptureWindow,
	captureWindowMismatches,
	createLiveVmafProcessor,
	type LiveVmafProcessorDeps,
	spliceDistortedInput,
	windowFromNow,
} from "./live-processor";
import {
	createLocalVmafResources,
	type LocalVmafResources,
} from "./local-resources";
import type { FrameStats } from "./signatures";

/**
 * Live VMAF processor units run WITHOUT ffmpeg/storage: the injected runner
 * returns canned signalstats stdout for the signature passes and writes a
 * canned libvmaf JSON for the score pass; a fake browser scripts the segment
 * listing + bytes; a fake prisma holds rows in memory. Mirrors the VOD
 * processor + feeder test style.
 */

const VMAF_JOB_ID = "00000000-0000-4000-8000-0000000000b1";
const CHANNEL_ID = "00000000-0000-4000-8000-0000000000c1";
const FEEDER_ID = "00000000-0000-4000-8000-0000000000f1";
const SRC_CRED = "00000000-0000-4000-8000-000000000001";
const OUT_CRED = "00000000-0000-4000-8000-000000000002";

/** A minimal one-video-rendition pseudo-live plan (fMP4). */
function livePlan(): Record<string, unknown> {
	return {
		planVersion: 1,
		name: "live-vmaf-test",
		bitmovin: { cloudRegion: "AUTO", encoderVersion: "STABLE" },
		liveInput: { key: "main", kind: "RTMP" },
		outputs: [
			{
				key: "origin",
				kind: "S3",
				credentialId: OUT_CRED,
				bucket: "out-bucket",
				name: "Out",
			},
		],
		ingest: [{ key: "video", inputPath: "live", position: 0 }],
		renditions: [
			{
				key: "v1080",
				codec: "H264",
				ingestKey: "video",
				height: 1080,
				bitrate: 4500000,
			},
		],
		muxings: [
			{
				key: "v1080",
				kind: "FMP4",
				streamKey: "v1080",
				segmentLength: 6,
				segmentNaming: "segment_%number%.m4s",
				initSegmentName: "init.mp4",
				destination: { outputKey: "origin", path: "out/v1080" },
			},
		],
		liveManifests: [
			{
				key: "hls",
				kind: "HLS",
				manifestName: "s.m3u8",
				name: "HLS",
				destination: { outputKey: "origin", path: "out" },
			},
		],
		start: { streamKey: "abcde" },
	};
}

/** Canned signalstats stdout: one block per signature value (as YAVG, no YDIF). */
function signalstats(values: number[]): string {
	return `${values
		.map((v, i) => `frame:${i}\nlavfi.signalstats.YAVG=${v}`)
		.join("\n")}\n`;
}

/** Canned libvmaf JSON for the given scores. */
function vmafJson(scores: number[]): string {
	return JSON.stringify({
		frames: scores.map((vmaf, i) => ({ frameNum: i, metrics: { vmaf } })),
		pooled_metrics: {
			vmaf: {
				min: Math.min(...scores),
				max: Math.max(...scores),
				mean: scores.reduce((a, b) => a + b, 0) / scores.length,
				harmonic_mean: scores.reduce((a, b) => a + b, 0) / scores.length,
			},
		},
	});
}

function logPathFromArgv(argv: string[]): string | undefined {
	const fc = argv[argv.indexOf("-filter_complex") + 1] ?? "";
	return fc.match(/log_path=([^:]+)/)?.[1];
}

function obj(key: string, lastModified?: string): StorageObject {
	return { key, size: 1000, ...(lastModified ? { lastModified } : {}) };
}

type Row = Record<string, unknown>;

function setup(
	opts: {
		job?: Row;
		localResources?: LocalVmafResources;
		channel?: Row | null;
		feeder?: Row | null;
		plan?: Record<string, unknown> | null;
		sourceSig?: number[];
		distortedSig?: number[];
		vmafScores?: number[];
		ffmpegScoreExit?: number;
		/** Reference source W×H the canned ffprobe reports (default 1920×1080). */
		sourceSize?: [number, number];
		/** Non-zero ⇒ the source ffprobe fails (geometry unavailable). */
		ffprobeExit?: number;
		/**
		 * the container period the canned ffprobe reports, in frames
		 * at 30 fps (default: the source signature's length — a hole-free loop).
		 */
		probeFrames?: number;
		/**
		 * the canned decode of the reproduced push (default: three
		 * plays of `sourceSig`). A longer canned decode lets the period
		 * estimator run — it needs `2·(probeFrames + 60)` frames at 30 fps.
		 */
		pushedSig?: number[];
		/**  follow-up: the feeder row's `loopProfile` (a normalized push). */
		loopProfile?: Row;
		/**  follow-up: place `<spoolDir>/<FEEDER_ID>.loop.mp4` and pass the spool dir. */
		spoolLoop?: boolean;
		/**  follow-up: the frame count the loop's probe reports (default: the profile's). */
		loopProbeFrames?: number;
		now?: string;
		/**
		 * An INJECTED advancing clock : successive `deps.now` calls
		 * return successive values, the last held once the queue drains. Models the
		 * wall-clock drift over a long multi-rendition download/score WITHOUT a
		 * real-time race — the fixed processor reads it ONCE, so only the first
		 * value is consumed and every rendition shares that window.
		 */
		nowValues?: string[];
		resolveModelPath?: (model: string) => string | undefined;
		/** libvmaf `n_subsample` — applied to the command AND recorded in params. */
		subsample?: number;
		/** #155: the latest run the capture resolves (null/absent = never-run). */
		run?: { id: string; seq: number; outputPrefix: string } | null;
		/** review-284 m4: runs served by id for the PINNED-run read. */
		runById?: Record<string, { id: string; seq: number; outputPrefix: string }>;
		/** Where the fixture segment objects live (defaults from `run`). */
		segDir?: string;
	} = {},
) {
	const job: Row = {
		id: VMAF_JOB_ID,
		mode: "LIVE",
		model: "vmaf_v0.6.1",
		status: "PENDING",
		error: null,
		params: { liveChannelId: CHANNEL_ID, windowSeconds: 120 },
		...opts.job,
	};
	const plan = opts.plan === undefined ? livePlan() : opts.plan;
	const channel: Row | null =
		opts.channel === undefined
			? { id: CHANNEL_ID, status: "RUNNING", plan }
			: opts.channel;
	const feeder: Row | null =
		opts.feeder === undefined
			? {
					id: FEEDER_ID,
					liveChannelId: CHANNEL_ID,
					status: "PUSHING",
					protocol: "RTMP",
					sourceCredentialId: SRC_CRED,
					sourceBucket: "src-bucket",
					sourceKey: "src/loop.mp4",
					loopBoundaries: [
						{
							loopIndex: 3,
							wallClock: "2026-06-18T11:59:00.000Z",
							streamTimeSec: 1.0,
						},
					],
					...(opts.loopProfile ? { loopProfile: opts.loopProfile } : {}),
					createdAt: new Date(),
				}
			: opts.feeder;

	const results: Row[] = [];
	const vmafJob = {
		findUnique: vi.fn(async (): Promise<Row | null> => ({ ...job })),
		updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
			const statusOk =
				where.status === undefined || where.status === job.status;
			if (where.id === job.id && statusOk) {
				Object.assign(job, data);
				return { count: 1 };
			}
			return { count: 0 };
		}),
		update: vi.fn(async ({ data }: { data: Row }) => {
			Object.assign(job, data);
			return { ...job };
		}),
	};
	const vmafResult = {
		create: vi.fn(async ({ data }: { data: Row }) => {
			results.push(data);
			return { id: `r${results.length}`, ...data };
		}),
	};
	const liveChannel = {
		findUnique: vi.fn(async () => (channel ? { ...channel } : null)),
	};
	const feederSession = {
		findFirst: vi.fn(async () => (feeder ? { ...feeder } : null)),
	};
	// #155: the capture resolves the latest run to read the paths the run
	// actually wrote; `run` in opts serves it (null = never-run / legacy,
	// which keeps the plan's own paths).
	const liveChannelRun = {
		findFirst: vi.fn(async () => opts.run ?? null),
		findUnique: vi.fn(
			async (args: { where: { id: string } }) =>
				opts.runById?.[args.where.id] ?? null,
		),
	};
	const prisma = {
		vmafJob,
		vmafResult,
		liveChannel,
		feederSession,
		liveChannelRun,
	} as unknown as AppPrismaClient;

	const sourceSig = opts.sourceSig ?? [10, 20, 30, 40, 50, 60, 70, 80];
	const distortedSig = opts.distortedSig ?? [30, 40, 50, 60, 70, 80, 10, 20];
	const vmafScores = opts.vmafScores ?? [97, 98, 96, 99, 95];
	const calls: string[][] = [];
	const runner: ProcessRunner = {
		spawn: vi.fn(() => {
			throw new Error("spawn not used");
		}),
		run: vi.fn(async (_bin: string, argv: string[]) => {
			calls.push(argv);
			const joined = argv.join(" ");
			// ffprobe on the downloaded source → the reference geometry the
			// distorted side is conformed to (HIGH-1). Canned 1080p30 unless the
			// test asks for another source size.
			if (joined.includes("-show_streams") && joined.includes("loop.mp4")) {
				//  follow-up: the reference LOOP's probe — the frame count the
				// feeder's profile must be reproduced by, at the profile's fps.
				const [width, height] = opts.sourceSize ?? [1920, 1080];
				const frames =
					opts.loopProbeFrames ??
					(opts.loopProfile?.frames as number | undefined) ??
					sourceSig.length;
				const seconds = frames / 30;
				return {
					code: 0,
					stdout: JSON.stringify({
						format: { start_time: "0.000000", duration: seconds.toFixed(6) },
						streams: [
							{
								codec_type: "video",
								codec_name: "h264",
								width,
								height,
								r_frame_rate: "30/1",
								avg_frame_rate: "30/1",
								start_time: "0.000000",
								duration: seconds.toFixed(6),
								nb_frames: String(frames),
							},
						],
					}),
					stderr: "",
				};
			}
			// the loop rebuild (feeder/command.ts `buildNormalizeCommand`) → exit 0
			if (joined.includes("-vf fps=") && joined.includes("loop.mp4")) {
				return { code: 0, stdout: "", stderr: "" };
			}
			if (joined.includes("-show_streams")) {
				const [width, height] = opts.sourceSize ?? [1920, 1080];
				const periodSec = (opts.probeFrames ?? sourceSig.length) / 30;
				return {
					code: opts.ffprobeExit ?? 0,
					stdout:
						(opts.ffprobeExit ?? 0) === 0
							? JSON.stringify({
									format: { duration: periodSec.toFixed(6) },
									streams: [
										{
											codec_type: "video",
											...(opts.localResources
												? { codec_name: "h264", pix_fmt: "yuv420p" }
												: {}),
											width,
											height,
											r_frame_rate: "30/1",
											start_time: "0.000000",
											duration: periodSec.toFixed(6),
										},
									],
								})
							: "",
					stderr: opts.ffprobeExit ? "ffprobe: no such file\n" : "",
				};
			}
			// libvmaf score pass → write the canned JSON to its log path.
			if (joined.includes("-filter_complex") && joined.includes("libvmaf")) {
				const logPath = logPathFromArgv(argv);
				if (logPath && (opts.ffmpegScoreExit ?? 0) === 0) {
					await writeFile(logPath, vmafJson(vmafScores));
				}
				return {
					code: opts.ffmpegScoreExit ?? 0,
					stdout: "",
					stderr: opts.ffmpegScoreExit
						? "libvmaf [error]: model load failed\n"
						: "",
				};
			}
			// signalstats passes: distinguish source vs distorted by the input.
			if (joined.includes("signalstats")) {
				// : the ring comes from the reproduced push (three plays
				// of the canned source signature, the second of which is the ring).
				if (joined.includes("pushed.ts")) {
					return {
						code: 0,
						stdout: signalstats(
							opts.pushedSig ?? [...sourceSig, ...sourceSig, ...sourceSig],
						),
						stderr: "",
					};
				}
				return { code: 0, stdout: signalstats(distortedSig), stderr: "" };
			}
			// : the only `-stream_loop` run left is the push reproduction
			// (`-c copy -f mpegts`); signalstats over `pushed.ts` is answered
			// above, so this branch just lets the copy succeed.
			if (joined.includes("-stream_loop")) {
				return { code: 0, stdout: "", stderr: "" };
			}
			return { code: 0, stdout: "", stderr: "" };
		}),
	};

	const resolveCredential = vi.fn(
		async (id: string): Promise<ResolvedCredential> => ({
			provider: "AWS_S3",
			config: { region: "us-east-1" },
			secret: { accessKeyId: `ak-${id}`, secretAccessKey: `sk-${id}` },
		}),
	);

	// #155: when a run with a prefix is served, the encoder "wrote" under the
	// run's subtree — the fixture objects live where the capture must look.
	const segDir =
		opts.segDir ??
		(opts.run?.outputPrefix ? `${opts.run.outputPrefix}/v1080` : "out/v1080");
	const listed: StorageObject[] = [
		obj(`${segDir}/init.mp4`, "2026-06-18T11:59:00.000Z"),
		obj(`${segDir}/segment_1.m4s`, "2026-06-18T11:59:40.000Z"),
		obj(`${segDir}/segment_2.m4s`, "2026-06-18T11:59:50.000Z"),
	];
	const browser: ObjectStorageBrowser = {
		listBuckets: vi.fn(async () => ["b"]),
		listObjects: vi.fn(async () => ({
			prefixes: [],
			objects: listed,
		})),
		getObject: vi.fn(async ({ key }: { key: string }) =>
			Readable.from([Buffer.from(`bytes:${key}`)]),
		),
		dispose: vi.fn(),
	};

	// Injected clock. With `nowValues` it advances (successive values, last held)
	// so a per-target re-derivation would DRIFT; the fixed processor calls it once
	// and only the first value is consumed. Exposed so a test can assert the call
	// count .
	const nowQueue = [...(opts.nowValues ?? [])];
	const nowFn = vi.fn((): string => {
		if (nowQueue.length === 0) {
			return opts.now ?? "2026-06-18T12:00:00.000Z";
		}
		return nowQueue.length > 1
			? (nowQueue.shift() as string)
			: (nowQueue[0] as string);
	});

	const spoolDir = join(workDir, "spool");
	if (opts.spoolLoop) {
		mkdirSync(spoolDir, { recursive: true });
		writeFileSync(join(spoolDir, `${FEEDER_ID}.loop.mp4`), "loop-bytes");
	}
	const deps: LiveVmafProcessorDeps = {
		prisma,
		...(opts.localResources ? { localResources: opts.localResources } : {}),
		resolveCredential,
		runner,
		ffmpegPath: "ffmpeg",
		ffprobePath: "ffprobe",
		workDir,
		...(opts.spoolLoop ? { spoolDir } : {}),
		now: nowFn,
		makeBrowser: () => browser,
		...(opts.resolveModelPath
			? { resolveModelPath: opts.resolveModelPath }
			: {}),
		...(opts.subsample !== undefined ? { subsample: opts.subsample } : {}),
	};

	return {
		processor: createLiveVmafProcessor(deps),
		job,
		results,
		runner,
		calls,
		browser,
		resolveCredential,
		vmafJob,
		nowFn,
	};
}

let workDir: string;
beforeEach(() => {
	workDir = mkdtempSync(join(tmpdir(), "live-vmaf-test-"));
});
afterEach(() => {
	rmSync(workDir, { recursive: true, force: true });
});

describe("live local resource policy", () => {
	it("forwards the abort grace only for scoring while retaining its liveness signal", async () => {
		const t = setup();
		await t.processor.process({ vmafJobId: VMAF_JOB_ID });
		const calls = vi.mocked(t.runner.run).mock.calls;
		const scoring = calls.filter(([, argv]) =>
			argv.join(" ").includes("libvmaf"),
		);
		const preparation = calls.filter(
			([, argv]) => !argv.join(" ").includes("libvmaf"),
		);
		expect(scoring).toHaveLength(1);
		expect(preparation.length).toBeGreaterThan(0);
		for (const [, , options] of scoring) {
			expect(options).toMatchObject({
				abortKillAfterMs: 250,
				signal: expect.any(AbortSignal),
			});
		}
		for (const [, , options] of preparation) {
			expect(options).not.toHaveProperty("abortKillAfterMs");
			expect(options?.signal).toBe(scoring[0]?.[2]?.signal);
		}
	});

	it.each([
		undefined,
		2,
	])("uses automatic or explicit threads (%s) through the real factory", async (threads) => {
		const localResources = createLocalVmafResources({
			threads,
			readResources: () => ({
				cpuCapacity: 4,
				memoryLimitBytes: 4 * 1024 ** 3,
				headroomBytes: 3.5 * 1024 ** 3,
				reserveBytes: 512 * 1024 ** 2,
				budgetBytes: 3 * 1024 ** 3,
			}),
		});
		const t = setup({ localResources });
		await t.processor.process({ vmafJobId: VMAF_JOB_ID });
		const argv = t.calls.find((args) => args.join(" ").includes("libvmaf"));
		expect(argv).toBeDefined();
		expect(argv?.join(" ")).toContain(`n_threads=${threads ?? 4}`);
		expect(argv?.filter((arg) => arg === "-threads")).toHaveLength(2);
		expect(argv?.[argv.indexOf("-filter_complex_threads") + 1]).toBe("1");
		expect(t.job).toMatchObject({
			status: "FINISHED",
			threads: threads ?? 4,
			concurrency: 1,
			params: {
				liveChannelId: CHANNEL_ID,
				localResources: { units: [{ threads: threads ?? 4 }] },
			},
		});
	});
});

describe("live rendition progress", () => {
	it("initializes the target count and reports only persisted results", async () => {
		const t = setup();
		await t.processor.process({ vmafJobId: VMAF_JOB_ID });
		expect(t.vmafJob.update).toHaveBeenCalledWith({
			where: { id: VMAF_JOB_ID },
			data: { totalUnits: 1, doneUnits: 0 },
		});
		expect(t.job).toMatchObject({
			status: "FINISHED",
			totalUnits: 1,
			doneUnits: 1,
		});
	});
	it("does not count a failed rendition as scored", async () => {
		const t = setup({ ffmpegScoreExit: 1 });
		await expect(
			t.processor.process({ vmafJobId: VMAF_JOB_ID }),
		).rejects.toThrow();
		expect(t.job).toMatchObject({
			status: "ERROR",
			totalUnits: 1,
			doneUnits: 0,
		});
	});
	it("keeps scoring when a non-authoritative progress write fails", async () => {
		const t = setup();
		const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
		t.vmafJob.update.mockRejectedValueOnce(new Error("progress unavailable"));
		await expect(
			t.processor.process({ vmafJobId: VMAF_JOB_ID }),
		).resolves.toMatchObject({
			status: "FINISHED",
			results: 1,
		});
		expect(t.job).toMatchObject({
			status: "FINISHED",
			totalUnits: 1,
			doneUnits: 1,
		});
		expect(warning).toHaveBeenCalledWith(
			JSON.stringify({
				event: "live_vmaf_progress_write_failed",
				entryPoint: "live_vmaf_processor",
				vmafJobId: VMAF_JOB_ID,
			}),
		);
		warning.mockRestore();
	});
});

describe("spliceDistortedInput", () => {
	it("replaces the -i __distorted__ pair with a concat input", () => {
		const base = [
			"-i",
			"__distorted__",
			"-i",
			"/ref.mp4",
			"-filter_complex",
			"x",
		];
		const out = spliceDistortedInput(base, [
			"-f",
			"concat",
			"-safe",
			"0",
			"-i",
			"/list.txt",
		]);
		expect(out).toEqual([
			"-f",
			"concat",
			"-safe",
			"0",
			"-i",
			"/list.txt",
			"-i",
			"/ref.mp4",
			"-filter_complex",
			"x",
		]);
	});

	it("throws when the placeholder is absent", () => {
		expect(() => spliceDistortedInput(["-i", "/x"], ["-i", "/y"])).toThrow(
			/placeholder/,
		);
	});
});

describe("alignWithFallback", () => {
	// : one segment over the whole 8-frame window, no holes.
	const FALLBACK_OPTS = {
		segmentFrames: 8,
		mask: new Array<boolean>(8).fill(false),
		includeThreshold: 0.5,
	};
	function stats(lumas: number[], ydifs?: number[]): FrameStats[] {
		return lumas.map((yavg, i) => ({
			yavg,
			...(ydifs ? { ydif: ydifs[i] } : {}),
		}));
	}

	it("uses the luma signature when luma aligns confidently", () => {
		// Discriminative luma, offset 2 → luma alignment is strong.
		const src = stats([10, 20, 30, 40, 50, 60, 70, 80]);
		const dist = stats([30, 40, 50, 60, 70, 80, 10, 20]);
		const { alignment, signatureMode } = alignWithFallback(
			src,
			dist,
			FALLBACK_OPTS,
		);
		expect(signatureMode).toBe("luma");
		expect(alignment.confidence).toBeGreaterThanOrEqual(0.5);
	});

	it("falls back to the enriched signature when luma is flat", () => {
		// Luma is CONSTANT (no structure) but YDIF carries a discriminative
		// pattern → luma cannot align, enriched can.
		const flat = 50;
		const srcYdif = [0, 2, 8, 1, 9, 3, 7, 4];
		const src = stats(Array(8).fill(flat), srcYdif);
		// Distorted is the source rotated by 3 (same flat luma, rotated ydif).
		const rot = 3;
		const distYdif = srcYdif.map((_, i) => srcYdif[(i + rot) % 8] as number);
		const dist = stats(Array(8).fill(flat), distYdif);
		const { signatureMode } = alignWithFallback(src, dist, FALLBACK_OPTS);
		// Luma alone is hopeless (all 50s → ncc undefined → confidence 0), so the
		// fallback must have engaged.
		expect(signatureMode).toBe("enriched");
	});
});

describe("createLiveVmafProcessor", () => {
	it("PENDING→RUNNING→FINISHED, writes a result with live metadata", async () => {
		const t = setup();
		const res = await t.processor.process({ vmafJobId: VMAF_JOB_ID });

		expect(res).toMatchObject({ status: "FINISHED", results: 1 });
		expect(t.job.status).toBe("FINISHED");
		expect(t.job.error).toBeNull();
		// Atomic claim happened.
		expect(t.vmafJob.updateMany).toHaveBeenCalledWith({
			where: { id: VMAF_JOB_ID, status: "PENDING" },
			data: { status: "RUNNING", error: null },
		});

		expect(t.results).toHaveLength(1);
		const pooled = t.results[0]?.pooled as Row;
		const live = pooled.live as Row;
		expect(live).toMatchObject({
			mode: "LIVE",
			fps: 30,
			sourceFrames: 8,
			distortedFrames: 8,
		});
		// loopMap exists and the offset is a number.
		expect(Array.isArray(live.loopMap)).toBe(true);
		expect(typeof live.offset).toBe("number");
		// Frames gzipped.
		const frames = JSON.parse(
			gunzipSync(t.results[0]?.framesGzip as Uint8Array).toString(),
		);
		expect(frames).toHaveLength(5);
	});

	it("row #256: the period comes from the container probe, never from the signature length — a mismatch fails closed", async () => {
		// the canned push decodes to 24 frames; a 30-frame period needs 60
		const t = setup({ probeFrames: 30 });
		await expect(
			t.processor.process({ vmafJobId: VMAF_JOB_ID }),
		).rejects.toThrow(/but the ring needs 60 \(period 30\)/);
		expect(t.results).toHaveLength(0);
	});

	it("row #256 (rev428 O2): the period the timeline records is MEASURED on the pushed decode — a probe one frame long is overruled", async () => {
		// A 120-frame ring repeated four times (480 frames ≥ 2·(121 + 60)) while
		// the container probe claims 121 frames: the estimator's peak at lag 120
		// must win, so `timeline.frames` is 120 and the ring is loop 2 exactly.
		const ring = Array.from({ length: 120 }, (_, i) => 10 + ((i * 37) % 127));
		const t = setup({
			sourceSig: ring,
			probeFrames: 121,
			pushedSig: [...ring, ...ring, ...ring, ...ring],
			distortedSig: ring.slice(30, 38),
		});
		await t.processor.process({ vmafJobId: VMAF_JOB_ID });
		const live = (t.results[0]?.pooled as Row).live as Row;
		// `timeline.frames` is the decode-measured period (the probe said 121);
		// `measuredPeriodFrames` is the per-rendition cross-check over the
		// DISTORTED clip, null here because 8 frames cannot hold 2·(F + 60).
		expect(live.timeline).toMatchObject({ frames: 120, holes: [] });
		expect(live.measuredPeriodFrames).toBeNull();
		const push = t.calls.find((a) => a.join(" ").includes("-f mpegts"));
		const loopAt = (push as string[]).indexOf("-stream_loop");
		// pushedPlaysFor(121, 30): shortest = max(61, 61, 1) = 61 → 1 + ceil(362/61) = 7
		expect(Number((push as string[])[loopAt + 1])).toBe(6);
	});

	it("row #256: the reference is the feeder's own push decoded like the encoder — the ring, the mask and the reference pieces are cut from it", async () => {
		const t = setup();
		await t.processor.process({ vmafJobId: VMAF_JOB_ID });
		const push = t.calls.find((a) => a.join(" ").includes("-f mpegts"));
		expect(push).toBeDefined();
		const loopAt = (push as string[]).indexOf("-stream_loop");
		expect(Number((push as string[])[loopAt + 1])).toBeGreaterThanOrEqual(2);
		expect(push?.join(" ")).toContain("-c copy -f mpegts");
		expect(push?.join(" ")).toContain("source.mp4");
		const ringSig = t.calls.find(
			(a) =>
				a.join(" ").includes("signalstats") &&
				a.join(" ").includes("pushed.ts"),
		);
		expect(ringSig?.join(" ")).toContain("fps=30,signalstats");
		const refBuild = t.calls.find((a) => a.join(" ").includes("select="));
		expect(refBuild?.join(" ")).toContain("pushed.ts");
		expect(refBuild?.join(" ")).not.toContain("-stream_loop");
		const live = (t.results[0]?.pooled as Row).live as Row;
		expect(live).toMatchObject({
			alignmentVersion: 2,
			coarseOffset: null,
			sourceFrames: 8,
			timeline: { source: "container-probe", frames: 8, holes: [] },
			masked: { frames: 0, share: 0 },
			pooledWithoutAlignment: false,
			captureSelection: { mode: "window" },
		});
		expect((live.segments as unknown[]).length).toBeGreaterThanOrEqual(1);
		expect((live.referenceRuns as unknown[]).length).toBeGreaterThanOrEqual(1);
	});

	it("row #256 (rev427 round 4): a window whose two segments align to different offsets is not trusted — the warning names two alignments, each run scored against its own offset", async () => {
		// a non-monotone ring, so a 6-frame slice is unique at every offset
		// (a ramp's slices all correlate with each other and never align)
		const ring = [10, 80, 30, 60, 20, 70, 40, 50];
		// two 6-frame segments (segmentLength 0.2 s × 30 fps): the first at
		// offset 0, the second at offset 4 — one agreeing segment of two
		const distortedSig = [
			...ring.slice(0, 6),
			...[4, 5, 6, 7, 0, 1].map((k) => ring[k] as number),
		];
		const plan = livePlan();
		const muxing = (plan.muxings as { segmentLength: number }[])[0];
		if (muxing) muxing.segmentLength = 0.2;
		const t = setup({ plan, sourceSig: ring, distortedSig });
		const res = await t.processor.process({ vmafJobId: VMAF_JOB_ID });
		expect(res.status).toBe("FINISHED");
		const live = (t.results[0]?.pooled as Row).live as Row;
		const segments = live.segments as { offset: number; included: boolean }[];
		expect(segments).toHaveLength(2);
		expect(segments.every((s) => s.included)).toBe(true);
		expect(new Set(segments.map((s) => s.offset)).size).toBe(2);
		expect(live.lowConfidence).toBe(true);
		expect(String(live.warning)).toMatch(/two alignments/);
		// and the reference was cut per run: two runs, two offsets
		expect(
			(live.referenceRuns as { offset: number }[]).map((r) => r.offset),
		).toEqual(segments.map((s) => s.offset));
	});

	it("records a low-confidence WARNING when alignment is weak (no fail)", async () => {
		// A distorted signal unrelated to the source → low confidence.
		const t = setup({
			sourceSig: [10, 20, 30, 40, 50, 60, 70, 80],
			distortedSig: [5, 5, 5, 5, 5, 5, 5, 5],
		});
		const res = await t.processor.process({ vmafJobId: VMAF_JOB_ID });
		// Still FINISHED — a bogus alignment is surfaced, not failed.
		expect(res.status).toBe("FINISHED");
		const live = (t.results[0]?.pooled as Row).live as Row;
		expect(live.lowConfidence).toBe(true);
		expect(typeof live.warning).toBe("string");
		// rev428 nit: no segment aligned, so the record says the frames were
		// pooled without an alignment and lists nothing as excluded.
		expect(live.pooledWithoutAlignment).toBe(true);
		expect(live.excluded).toEqual({ segments: [], frames: 0 });
	});

	it("feeds the captured clip to libvmaf as a plain input — never a concat list (ledger #210)", async () => {
		const t = setup();
		await t.processor.process({ vmafJobId: VMAF_JOB_ID });
		// One reference build (select over the pushed decode) ran.
		const refBuild = t.calls.find((a) => a.join(" ").includes("select="));
		expect(refBuild).toBeDefined();
		expect(refBuild?.join(" ")).toMatch(/select='gte\(n/);
		// The libvmaf pass reads the ONE byte-concatenated clip with `-i`; the
		// concat demuxer cannot open a bare fMP4 fragment and decoded every real
		// capture to zero frames .
		const score = t.calls.find(
			(a) => a.join(" ").includes("libvmaf") && a.includes("-filter_complex"),
		);
		expect(score?.join(" ")).not.toContain("-f concat");
		expect(score?.join(" ")).toMatch(/-i \S*cap-[^ ]+\.(mp4|ts)/);
	});

	it("loads a bundled model by path (model=path=) when resolveModelPath finds it", async () => {
		const modelFile = "/opt/vmaf/model/vmaf_v1.0.16_3d0h.json";
		const t = setup({
			job: { model: "vmaf_v1.0.16_3d0h" },
			resolveModelPath: (m) =>
				m === "vmaf_v1.0.16_3d0h" ? modelFile : undefined,
		});
		await t.processor.process({ vmafJobId: VMAF_JOB_ID });
		const score = t.calls.find(
			(a) => a.join(" ").includes("libvmaf") && a.includes("-filter_complex"),
		);
		expect(score?.join(" ")).toContain(`model=path=${modelFile}`);
		expect(score?.join(" ")).not.toContain("model=version=");
	});

	it("ERRORs with a redacted message when the libvmaf score pass fails", async () => {
		const t = setup({ ffmpegScoreExit: 1 });
		await expect(
			t.processor.process({ vmafJobId: VMAF_JOB_ID }),
		).rejects.toThrow();
		expect(t.job.status).toBe("ERROR");
		expect(String(t.job.error)).toMatch(/libvmaf failed/);
	});

	it("ERRORs when the channel has no attached feeder session", async () => {
		const t = setup({ feeder: null });
		await expect(
			t.processor.process({ vmafJobId: VMAF_JOB_ID }),
		).rejects.toThrow(/no attached feeder/);
		expect(t.job.status).toBe("ERROR");
	});

	it("captures under the RUN's subtree — a re-aired run's segments are not at the plan's paths (ledger #155)", async () => {
		const t = setup({
			run: {
				id: "cafebabe-0000-4000-8000-000000000000",
				seq: 2,
				outputPrefix: "out/runs/2-cafebabe",
			},
		});
		await t.processor.process({ vmafJobId: VMAF_JOB_ID });
		expect(t.job.status).toBe("FINISHED");
		// The listing went to the rebased prefix, not the plan's own path —
		// against the plan's paths a re-aired capture finds NOTHING (the
		// encoder wrote the run's subtree) and dies as "no segments" instead.
		const firstList = t.browser.listObjects as ReturnType<typeof vi.fn>;
		expect(firstList.mock.calls[0]?.[0]).toMatchObject({
			// Trailing slash since : the listing is scoped to a
			// DIRECTORY so a sibling rung whose prefix starts with this one
			// (`…/v1080p/`) cannot bleed into this rendition's window. Same
			// directory, same assertion intent — the rebased subtree, not the
			// plan's own path.
			prefix: "out/runs/2-cafebabe/v1080/",
		});
	});

	it("captures the PINNED run's subtree even after a re-air started a newer run (review-284 m4)", async () => {
		const pinned = {
			id: "cafebabe-0000-4000-8000-000000000000",
			seq: 2,
			outputPrefix: "out/runs/2-cafebabe",
		};
		const t = setup({
			job: {
				id: VMAF_JOB_ID,
				mode: "LIVE",
				model: "vmaf_v0.6.1",
				status: "PENDING",
				error: null,
				params: {
					liveChannelId: CHANNEL_ID,
					windowSeconds: 120,
					liveChannelRunId: pinned.id,
				},
			},
			runById: { [pinned.id]: pinned },
			// The LATEST run is already the NEXT airing — a latest-run read
			// here would list run 3's subtree and score the wrong content.
			run: {
				id: "dddddddd-0000-4000-8000-000000000000",
				seq: 3,
				outputPrefix: "out/runs/3-dddddddd",
			},
			segDir: "out/runs/2-cafebabe/v1080",
		});
		await t.processor.process({ vmafJobId: VMAF_JOB_ID });
		expect(t.job.status).toBe("FINISHED");
		const firstList = t.browser.listObjects as ReturnType<typeof vi.fn>;
		expect(firstList.mock.calls[0]?.[0]).toMatchObject({
			// Trailing slash since : the listing is scoped to a
			// DIRECTORY so a sibling rung whose prefix starts with this one
			// (`…/v1080p/`) cannot bleed into this rendition's window. Same
			// directory, same assertion intent — the rebased subtree, not the
			// plan's own path.
			prefix: "out/runs/2-cafebabe/v1080/",
		});
	});

	it("ERRORs when the pinned run row is GONE — its segments went with it (review-284 m4)", async () => {
		const t = setup({
			job: {
				id: VMAF_JOB_ID,
				mode: "LIVE",
				model: "vmaf_v0.6.1",
				status: "PENDING",
				error: null,
				params: {
					liveChannelId: CHANNEL_ID,
					windowSeconds: 120,
					liveChannelRunId: "99999999-0000-4000-8000-000000000000",
				},
			},
		});
		await expect(
			t.processor.process({ vmafJobId: VMAF_JOB_ID }),
		).rejects.toThrow(/no longer exists/);
		expect(t.job.status).toBe("ERROR");
	});

	it("REFUSES a run prefix this build cannot re-derive — named error, never guessed paths (ledger #155)", async () => {
		const t = setup({
			run: {
				id: "cafebabe-0000-4000-8000-000000000000",
				seq: 2,
				outputPrefix: "elsewhere/runs/2-cafebabe",
			},
		});
		await expect(
			t.processor.process({ vmafJobId: VMAF_JOB_ID }),
		).rejects.toThrow(/rebase derivation/);
		expect(t.job.status).toBe("ERROR");
	});

	it("skips a non-PENDING job (idempotent re-delivery)", async () => {
		const t = setup({ job: { status: "RUNNING" } });
		const res = await t.processor.process({ vmafJobId: VMAF_JOB_ID });
		expect(res).toMatchObject({ status: "RUNNING", results: 0 });
		expect(t.results).toHaveLength(0);
	});

	it("does not leak storage secrets into a redacted error", async () => {
		// Force a failure AFTER credentials resolved (score pass) and assert the
		// error string carries no access-key material.
		const t = setup({ ffmpegScoreExit: 1 });
		await expect(
			t.processor.process({ vmafJobId: VMAF_JOB_ID }),
		).rejects.toThrow();
		expect(String(t.job.error)).not.toMatch(/ak-|sk-/);
	});
});

/**
 * The live path applies `n_subsample` exactly as the VOD path does, so a live
 * report can be subsampled — and until this was added it rendered as full
 * precision, i.e. the opposite of what the QC screens now promise. The VOD half
 * shipped first and this was the same defect in the other path.
 */
describe("createLiveVmafProcessor — recording the subsample stride", () => {
	it("records the stride WITHOUT clobbering liveChannelId", async () => {
		/**
		 * The clobber matters more here than on the VOD side: `/api/live-channels/[id]`
		 * finds a channel's VMAF jobs with a JSON-path query on
		 * `params.liveChannelId`, so rebuilding `params` would silently empty that
		 * list rather than merely lose a badge.
		 */
		const t = setup({ subsample: 4 });
		await t.processor.process({ vmafJobId: VMAF_JOB_ID });
		expect(t.job.params).toMatchObject({
			subsample: 4,
			liveChannelId: CHANNEL_ID,
			windowSeconds: 120,
		});
	});

	it("writes nothing for a full-precision live run", async () => {
		for (const opts of [{}, { subsample: 1 }]) {
			const t = setup(opts);
			await t.processor.process({ vmafJobId: VMAF_JOB_ID });
			// Byte-identical to before the field existed: the stride key is absent, not 1.
			expect(t.job.params).not.toHaveProperty("subsample");
			expect(t.job.params).toMatchObject({ liveChannelId: CHANNEL_ID });
		}
	});
});

/**
 * The capture's OUTPUT-KIND gate.
 *
 * The predicate was `kind !== "S3"` while the message it threw said
 * "S3-family". Akamai Object Storage is `GENERIC_S3` with V4 signing (C10),
 * so a RUNNING AOS channel could not have its quality measured in-product at
 * all — even though the capture primitive lists through the provider-agnostic
 * `browser.listObjects` and explicitly handles stores that omit mtimes, and
 * even though the reference download in the same file already accepts the
 * family by asking the browser what it can do rather than the output what it
 * is.
 *
 * These arms drive the real processor, because the rule living in core and
 * being unit-tested there is not the same as this call site being pinned.
 */
describe("live VMAF capture accepts the S3 family, not just AWS", () => {
	it.each([
		1, 2,
	])("uses only a unique storage mirror of the MSL muxing (%i)", async (count) => {
		const plan = planWithOutput({
			kind: "AKAMAI_MSL",
			credentialId: OUT_CRED,
			streamFormat: "HLS",
		});
		const outputs = plan.outputs as Record<string, unknown>[];
		const deliveryMirrors = [];
		for (let i = 0; i < count; i++) {
			outputs.push({
				key: `storage-${i}`,
				kind: "GENERIC_S3",
				credentialId: OUT_CRED,
				bucket: `mirror-bucket-${i}`,
			});
			deliveryMirrors.push({ outputKey: `storage-${i}` });
		}
		plan.deliveryMirrors = deliveryMirrors;
		const t = setup({ plan });
		if (count === 1) {
			expect(
				await t.processor.process({ vmafJobId: VMAF_JOB_ID }),
			).toMatchObject({ status: "FINISHED", results: 1 });
			expect(t.browser.listObjects).toHaveBeenCalledWith(
				expect.objectContaining({
					bucket: "mirror-bucket-0",
					prefix: "out/v1080/",
				}),
			);
		} else {
			await expect(
				t.processor.process({ vmafJobId: VMAF_JOB_ID }),
			).rejects.toThrow(/AKAMAI_MSL.*INGEST target/s);
			expect(t.browser.listObjects).not.toHaveBeenCalled();
		}
	});
	function planWithOutput(patch: Record<string, unknown>) {
		const plan = livePlan();
		const outputs = plan.outputs as Record<string, unknown>[];
		outputs[0] = { key: outputs[0]?.key, name: "Out", ...patch };
		return plan;
	}

	it("scores an Akamai Object Storage (GENERIC_S3) channel", async () => {
		const t = setup({
			plan: planWithOutput({
				kind: "GENERIC_S3",
				credentialId: OUT_CRED,
				bucket: "out-bucket",
			}),
		});
		const res = await t.processor.process({ vmafJobId: VMAF_JOB_ID });
		expect(res).toMatchObject({ status: "FINISHED", results: 1 });
		expect(t.job.error).toBeNull();
	});

	/**
	 * AZURE, the kind I was least sure about — review finding A.
	 *
	 * It is the ONLY kind whose bucket comes from a different field
	 * (`io.container`, resolved by `vmafSourceFor`), which is precisely why the
	 * capture's `bucket:` argument had to stop reading `output.bucket`. Two
	 * mutations survived without this arm: making AZURE refuse in the core
	 * table, and passing a wrong bucket into the capture. It asserts the bucket
	 * that actually reached the listing rather than only that the job finished.
	 */
	it("captures an AZURE channel from its CONTAINER, not a bucket field", async () => {
		const t = setup({
			plan: planWithOutput({
				kind: "AZURE",
				credentialId: OUT_CRED,
				container: "out-container",
			}),
		});
		const res = await t.processor.process({ vmafJobId: VMAF_JOB_ID });
		expect(res).toMatchObject({ status: "FINISHED", results: 1 });
		const firstList = t.browser.listObjects as ReturnType<typeof vi.fn>;
		expect(firstList.mock.calls[0]?.[0]).toMatchObject({
			bucket: "out-container",
		});
	});

	it("still refuses an MSL output, and names the kind and the reason", async () => {
		const t = setup({
			plan: planWithOutput({
				kind: "AKAMAI_MSL",
				credentialId: OUT_CRED,
				streamFormat: "HLS",
			}),
		});
		await expect(
			t.processor.process({ vmafJobId: VMAF_JOB_ID }),
		).rejects.toThrow(/AKAMAI_MSL.*INGEST target with no readable origin/s);
	});
});

/**
 * HIGH-1: the live path built its libvmaf argv without
 * `scaleToReference`/`fpsConform`, so only the rendition that happened to match
 * the source geometry produced a score and 720/540/360p ERRORed on the
 * dimension mismatch. The VOD path has passed both since its first commit.
 */
describe("live libvmaf conforms the distorted side to the reference geometry (HIGH-1)", () => {
	/** A ladder rendition below the source's 1080p — the class that never scored. */
	function ladderPlan(): Record<string, unknown> {
		const plan = livePlan();
		(plan.renditions as Row[]).push({
			key: "v540",
			codec: "H264",
			ingestKey: "video",
			height: 540,
			bitrate: 1200000,
		});
		(plan.muxings as Row[]).push({
			key: "v540",
			kind: "FMP4",
			streamKey: "v540",
			segmentLength: 6,
			segmentNaming: "segment_%number%.m4s",
			initSegmentName: "init.mp4",
			destination: { outputKey: "origin", path: "out/v540" },
		});
		return plan;
	}

	function ladderSetup() {
		const t = setup({ plan: ladderPlan() });
		const list = t.browser.listObjects as ReturnType<typeof vi.fn>;
		list.mockImplementation(async ({ prefix }: { prefix: string }) => {
			const dir = prefix.includes("v540") ? "out/v540" : "out/v1080";
			return {
				prefixes: [],
				objects: [
					obj(`${dir}/init.mp4`, "2026-06-18T11:59:00.000Z"),
					obj(`${dir}/segment_1.m4s`, "2026-06-18T11:59:40.000Z"),
					obj(`${dir}/segment_2.m4s`, "2026-06-18T11:59:50.000Z"),
				],
			};
		});
		return t;
	}

	/** The libvmaf pass for the rendition whose clip is named in the argv. */
	function scoreCall(calls: string[][], rendition: string): string | undefined {
		return calls
			.map((a) => a.join(" "))
			.find(
				(a) =>
					a.includes("libvmaf") &&
					a.includes("-filter_complex") &&
					a.includes(`cap-${rendition}.`),
			);
	}

	it("emits scale-to-reference + fps conform on the DISTORTED pad for a sub-source rendition", async () => {
		const t = ladderSetup();
		const res = await t.processor.process({ vmafJobId: VMAF_JOB_ID });
		expect(res).toMatchObject({ status: "FINISHED", results: 2 });
		expect(
			t.vmafJob.update.mock.calls
				.map(([args]) => args.data)
				.filter((data) => "totalUnits" in data),
		).toEqual([
			{ totalUnits: 2, doneUnits: 0 },
			{ totalUnits: 2, doneUnits: 1 },
			{ totalUnits: 2, doneUnits: 2 },
		]);

		const score = scoreCall(t.calls, "v540");
		expect(score).toBeDefined();
		// The source ffprobe reported 1920×1080; the distorted 540p clip is scaled
		// UP to it, and re-timed to the signature fps the aligned reference was
		// written at. Both nodes sit on [0:v] — the distorted pad — before [dist].
		expect(score).toMatch(
			/\[0:v\]scale=1920:1080:flags=bicubic,fps=30[^[]*\[dist\]/,
		);
	});

	it("scales to the SOURCE's real geometry — a 1280×720 source, not a hardcoded 1080p", async () => {
		// The conform must come from the probe, not from a constant: a 720p
		// feeder source with a 1080p-labelled ladder would otherwise be upscaled
		// to a reference that does not exist.
		const t = setup({ sourceSize: [1280, 720] });
		await t.processor.process({ vmafJobId: VMAF_JOB_ID });
		const score = scoreCall(t.calls, "v1080");
		expect(score).toContain("scale=1280:720:flags=bicubic");
	});

	it("fails the job when the reference source cannot be probed — never scores against an unknown geometry", async () => {
		const t = setup({ ffprobeExit: 1 });
		await expect(
			t.processor.process({ vmafJobId: VMAF_JOB_ID }),
		).rejects.toThrow(/ffprobe failed on the live reference source/);
		expect(t.job.status).toBe("ERROR");
	});
});

/**
 * HIGH-1, second half: live result rows wrote no `provenance` while VOD rows
 * carried both sides' identity + digest . A live score is
 * over a looping source that can be replaced under a running channel and over N
 * segments assembled at read time — the case where "which bytes" matters most.
 */
describe("live results record which bytes they scored (HIGH-1, ledger #199)", () => {
	type Provenance = {
		reference: { bucket: string; key: string; pinned: boolean; sha256: string };
		distorted: {
			bucket: string;
			keys: string[];
			segmentCount: number;
			container: string;
			pinned: boolean;
			sha256: string;
			bytes: number;
		};
	};

	it("names the feeder source and its digest as the reference side", async () => {
		const t = setup();
		await t.processor.process({ vmafJobId: VMAF_JOB_ID });
		const prov = t.results[0]?.provenance as Provenance;
		expect(prov.reference).toMatchObject({
			bucket: "src-bucket",
			key: "src/loop.mp4",
			// The live source read is unconditional (no `expect`), and the row says
			// so rather than implying a pinned version it never demanded.
			pinned: false,
		});
		// The digest of the SOURCE'S OWN BYTES, not merely a well-formed hash: a
		// constant (or the digest of an empty stream) is also 64 hex chars, so a
		// shape assertion would accept a provenance that identifies nothing.
		expect(prov.reference.sha256).toBe(
			createHash("sha256")
				.update(Buffer.from("bytes:src/loop.mp4", "utf8"))
				.digest("hex"),
		);
	});

	it("names the captured segment keys, their count and the ASSEMBLED clip's digest as the distorted side", async () => {
		const t = setup();
		await t.processor.process({ vmafJobId: VMAF_JOB_ID });
		const prov = t.results[0]?.provenance as Provenance;
		expect(prov.distorted).toMatchObject({
			bucket: "out-bucket",
			container: "FMP4",
			segmentCount: 2,
			pinned: false,
		});
		// Ordered as concatenated: the fMP4 init first, then the media fragments.
		expect(prov.distorted.keys).toEqual([
			"out/v1080/init.mp4",
			"out/v1080/segment_1.m4s",
			"out/v1080/segment_2.m4s",
		]);
		expect(prov.distorted.sha256).toMatch(/^[0-9a-f]{64}$/);
		// The digest is of the CLIP, not of one segment: the fake browser returns
		// `bytes:<key>` per object, so the clip is their concatenation.
		const expected = createHash("sha256")
			.update(
				Buffer.from(
					prov.distorted.keys.map((k) => `bytes:${k}`).join(""),
					"utf8",
				),
			)
			.digest("hex");
		expect(prov.distorted.sha256).toBe(expected);
		expect(prov.distorted.bytes).toBe(
			prov.distorted.keys.reduce((n, k) => n + `bytes:${k}`.length, 0),
		);
	});
});

describe("one rendition's failure leaves the others scored (ledger #213, review-331)", () => {
	it("scores v1080, names v720 as unscored with its reason, and ends ERROR with the scored row kept", async () => {
		// The first cut's cap THREW out of the whole job: every rendition after
		// the truncated one went unscored and the earlier rows sat under an
		// ERROR job, while the prose claimed "this rendition is not scored".
		const plan = livePlan();
		(plan.renditions as Row[]).push({
			key: "v720",
			codec: "H264",
			ingestKey: "video",
			height: 720,
			bitrate: 2500000,
		});
		(plan.muxings as Row[]).push({
			key: "v720",
			kind: "FMP4",
			streamKey: "v720",
			segmentLength: 6,
			segmentNaming: "segment_%number%.m4s",
			initSegmentName: "init.mp4",
			destination: { outputKey: "origin", path: "out/v720" },
		});
		const t = setup({ plan });
		const list = t.browser.listObjects as ReturnType<typeof vi.fn>;
		list.mockImplementation(async ({ prefix }: { prefix: string }) => {
			if (prefix.includes("v720")) {
				throw new Error(
					'live capture listing under "out/v720" was truncated at 200000 objects — the window would be a partial guess, so this rendition is not scored',
				);
			}
			return {
				prefixes: [],
				objects: [
					obj("out/v1080/init.mp4", "2026-06-18T11:59:00.000Z"),
					obj("out/v1080/segment_1.m4s", "2026-06-18T11:59:40.000Z"),
					obj("out/v1080/segment_2.m4s", "2026-06-18T11:59:50.000Z"),
				],
			};
		});
		await expect(
			t.processor.process({ vmafJobId: VMAF_JOB_ID }),
		).rejects.toThrow(/1 of 2 rendition\(s\) not scored \(1 scored and kept\)/);
		// The other rendition's row exists and names itself.
		expect(t.results).toHaveLength(1);
		expect(JSON.stringify(t.results[0])).toContain("v1080");
		expect(JSON.stringify(t.results[0])).not.toContain("v720");
		expect(t.job.status).toBe("ERROR");
		expect(String(t.job.error)).toMatch(/v720: .*truncated at 200000 objects/);
		expect(t.job).toMatchObject({ totalUnits: 2, doneUnits: 1 });
	});
});

/**
 * SHARED CAPTURE WINDOW.
 *
 * A live VMAF job used to re-read `deps.now` for the capture endpoint INSIDE
 * the per-rendition loop, so over a long multi-rendition download/score the
 * window drifted between renditions and the set was not compared over the same
 * wall-clock interval / the same scene. The job now seals ONE window and reads
 * every rendition over it. (The reference loop-boundary alignment recorded by
 * row 256 is a separate concern and is untouched here.)
 */
describe("windowFromNow — the job's single sealed window", () => {
	it("derives [now − windowSeconds, now] with a deterministic id", () => {
		const w = windowFromNow(VMAF_JOB_ID, "2026-06-18T12:00:00.000Z", 120);
		expect(w.to).toBe("2026-06-18T12:00:00.000Z");
		expect(w.from).toBe("2026-06-18T11:58:00.000Z");
		expect(w.captureWindowId).toMatch(/^[0-9a-f]{16}$/);
	});

	it("is stable for the same job + bounds and differs when the endpoint drifts", () => {
		const a = windowFromNow(VMAF_JOB_ID, "2026-06-18T12:00:00.000Z", 120);
		const b = windowFromNow(VMAF_JOB_ID, "2026-06-18T12:00:00.000Z", 120);
		const drifted = windowFromNow(VMAF_JOB_ID, "2026-06-18T12:00:05.000Z", 120);
		expect(b.captureWindowId).toBe(a.captureWindowId);
		// A 5s drift in the endpoint is a DIFFERENT comparable set.
		expect(drifted.captureWindowId).not.toBe(a.captureWindowId);
		expect(drifted.to).not.toBe(a.to);
	});
});

describe("captureWindowMismatches — the comparable-set seal (row #273)", () => {
	const w = (id: string, from: string, to: string): CaptureWindow => ({
		captureWindowId: id,
		from,
		to,
	});
	const jw = w(
		"abc0000000000000",
		"2026-06-18T11:58:00.000Z",
		"2026-06-18T12:00:00.000Z",
	);

	it("returns no mismatches when every rendition shares the job window", () => {
		expect(
			captureWindowMismatches(
				[
					{ renditionKey: "v1080", window: jw },
					{ renditionKey: "v720", window: { ...jw } },
					{ renditionKey: "v540", window: { ...jw } },
				],
				jw,
			),
		).toEqual([]);
	});

	it("names a rendition whose endpoint drifted (different `to`)", () => {
		const drift = w(
			"def0000000000000",
			"2026-06-18T11:58:05.000Z",
			"2026-06-18T12:00:05.000Z",
		);
		expect(
			captureWindowMismatches(
				[
					{ renditionKey: "v1080", window: jw },
					{ renditionKey: "v540", window: drift },
				],
				jw,
			),
		).toEqual(["v540"]);
	});

	it("names a rendition whose id drifted even when from/to coincide", () => {
		// The id is part of the identity — a set is not comparable unless all
		// three fields agree.
		expect(
			captureWindowMismatches(
				[
					{
						renditionKey: "v540",
						window: { ...jw, captureWindowId: "XXXXXXXXXXXXXXXX" },
					},
				],
				jw,
			),
		).toEqual(["v540"]);
	});
});

describe("live VMAF seals ONE capture window across all renditions (row #273)", () => {
	/** A 3-rung ladder (1080/720/540) with per-prefix segment listings. */
	function ladder3Plan(): Record<string, unknown> {
		const plan = livePlan();
		for (const [key, height, bitrate] of [
			["v720", 720, 2500000],
			["v540", 540, 1200000],
		] as const) {
			(plan.renditions as Row[]).push({
				key,
				codec: "H264",
				ingestKey: "video",
				height,
				bitrate,
			});
			(plan.muxings as Row[]).push({
				key,
				kind: "FMP4",
				streamKey: key,
				segmentLength: 6,
				segmentNaming: "segment_%number%.m4s",
				initSegmentName: "init.mp4",
				destination: { outputKey: "origin", path: `out/${key}` },
			});
		}
		return plan;
	}

	function ladder3Setup(nowValues: string[]) {
		const t = setup({ plan: ladder3Plan(), nowValues });
		const list = t.browser.listObjects as ReturnType<typeof vi.fn>;
		list.mockImplementation(async ({ prefix }: { prefix: string }) => {
			const dir = prefix.includes("v720")
				? "out/v720"
				: prefix.includes("v540")
					? "out/v540"
					: "out/v1080";
			return {
				prefixes: [],
				objects: [
					obj(`${dir}/init.mp4`, "2026-06-18T11:59:00.000Z"),
					obj(`${dir}/segment_1.m4s`, "2026-06-18T11:59:40.000Z"),
					obj(`${dir}/segment_2.m4s`, "2026-06-18T11:59:50.000Z"),
				],
			};
		});
		return t;
	}

	it("consumes ONE now-reading and stamps the first-tick window on every rendition even as the clock advances", async () => {
		// The clock ADVANCES between the ticks a per-target re-derivation would
		// read. The fixed job reads it once (the FIRST value) and every rendition
		// carries that one window; a drifting endpoint would give three windows.
		const ticks = [
			"2026-06-18T12:00:00.000Z",
			"2026-06-18T12:00:05.000Z",
			"2026-06-18T12:00:11.000Z",
			"2026-06-18T12:00:20.000Z",
		];
		const t = ladder3Setup([...ticks]);
		const res = await t.processor.process({ vmafJobId: VMAF_JOB_ID });

		expect(res).toMatchObject({ status: "FINISHED", results: 3 });
		expect(t.job.status).toBe("FINISHED");
		// Determined ONCE: the clock was read a single time for the whole job.
		expect(t.nowFn).toHaveBeenCalledTimes(1);

		const expected = windowFromNow(VMAF_JOB_ID, ticks[0] as string, 120);
		expect(t.results).toHaveLength(3);
		for (const r of t.results) {
			const live = (r.pooled as Row).live as Row;
			// Each rendition carries the FIRST-tick window — not the 2nd/3rd/4th a
			// per-target `deps.now` would have read.
			expect(live.captureWindow as CaptureWindow).toEqual(expected);
			// And its provenance records the SAME window, so the set is auditable.
			expect((r.provenance as Row).captureWindow as CaptureWindow).toEqual(
				expected,
			);
		}
		// The endpoint used is the FIRST tick, not the last.
		expect(expected.to).toBe(ticks[0]);
	});
});

describe("live VMAF records the window tuple on both the result and its provenance (row #273)", () => {
	it("stamps captureWindow on pooled.live AND provenance, identical, from the job's single now", async () => {
		const t = setup({ now: "2026-06-18T12:00:00.000Z" });
		await t.processor.process({ vmafJobId: VMAF_JOB_ID });

		const expected = windowFromNow(
			VMAF_JOB_ID,
			"2026-06-18T12:00:00.000Z",
			120,
		);
		const live = (t.results[0]?.pooled as Row).live as Row;
		const prov = t.results[0]?.provenance as Row;
		// Result metadata carries the concrete window (not merely a shape): the
		// endpoint is the job's now and `from` trails it by windowSeconds.
		expect(live.captureWindow as CaptureWindow).toEqual(expected);
		expect((live.captureWindow as CaptureWindow).to).toBe(
			"2026-06-18T12:00:00.000Z",
		);
		expect((live.captureWindow as CaptureWindow).from).toBe(
			"2026-06-18T11:58:00.000Z",
		);
		// Provenance carries the SAME tuple — dropping it here leaves the row
		// unable to say which window it scored.
		expect(prov.captureWindow as CaptureWindow).toEqual(
			live.captureWindow as CaptureWindow,
		);
	});
});

describe("row #256 follow-up: the normalized loop is the reference", () => {
	const SOURCE_SHA = createHash("sha256")
		.update(Buffer.from("bytes:src/loop.mp4", "utf8"))
		.digest("hex");
	const PROFILE: Row = {
		version: 1,
		mode: "normalized",
		fps: 30,
		frames: 8,
		loopSeconds: 8 / 30,
		audioEndSec: 8 / 30,
		sourceSha256: SOURCE_SHA,
		normalizer: { version: 1 },
		normalise: {
			width: 1920,
			height: 1080,
			frameRate: 29.97,
			profile: "main",
			sampleRate: 48000,
			channels: 2,
		},
		recordedAt: "2026-06-18T11:00:00.000Z",
	};
	const pushOf = (calls: string[][]) =>
		calls.find((a) => a.join(" ").includes("-f mpegts"))?.join(" ") ?? "";
	const normalizeOf = (calls: string[][]) =>
		calls
			.find(
				(a) =>
					a.join(" ").includes("-vf fps=") && a.join(" ").includes("loop.mp4"),
			)
			?.join(" ");

	it("reads the feeder's own loop from the spool when this process has it: no source download, the push ignores the edit list, the timeline is the profile's", async () => {
		const t = setup({ loopProfile: PROFILE, spoolLoop: true });
		const outcome = await t.processor.process({ vmafJobId: VMAF_JOB_ID });
		expect(outcome.status).toBe("FINISHED");
		const live = (t.results[0]?.pooled as Row).live as Row;
		expect(live).toMatchObject({
			referenceSource: "spool-loop",
			timeline: { source: "feeder-profile", frames: 8, holes: [] },
			masked: { frames: 0, share: 0 },
		});
		const push = pushOf(t.calls);
		expect(push).toContain("-ignore_editlist 1 -stream_loop");
		expect(push).toContain("loop.mp4");
		expect(push).not.toContain("source.mp4");
		expect(normalizeOf(t.calls)).toBeUndefined();
		const sourceReads = (
			t.browser.getObject as ReturnType<typeof vi.fn>
		).mock.calls
			.map((c) => (c[0] as { key: string }).key)
			.filter((k) => k === "src/loop.mp4");
		expect(sourceReads).toEqual([]);
		const prov = t.results[0]?.provenance as Row;
		expect(prov.reference).toBeNull();
		expect(prov.referenceSource).toBe("spool-loop");
	});

	it("rebuilds the loop from the source with the profile's pins when the spool has no copy", async () => {
		const t = setup({ loopProfile: PROFILE });
		const outcome = await t.processor.process({ vmafJobId: VMAF_JOB_ID });
		expect(outcome.status).toBe("FINISHED");
		const live = (t.results[0]?.pooled as Row).live as Row;
		expect(live).toMatchObject({
			referenceSource: "renormalized-source",
			timeline: { source: "feeder-profile", frames: 8 },
		});
		const norm = normalizeOf(t.calls) ?? "";
		expect(norm).toContain("-vf fps=30,setpts=N/FRAME_RATE/TB");
		expect(norm).toContain("-s 1920x1080");
		expect(norm).toContain("-profile:v main");
		expect(norm).toContain("-ar 48000");
		expect(norm).toContain("-ac 2");
		expect(norm).toMatch(/source\.mp4 .*loop\.mp4/);
		expect(pushOf(t.calls)).toContain("-ignore_editlist 1 -stream_loop");
		const prov = t.results[0]?.provenance as Row;
		expect((prov.reference as Row).sha256).toBe(SOURCE_SHA);
		expect(prov.referenceSource).toBe("renormalized-source");
	});

	it("refuses to rebuild from a source whose bytes are not the ones the feeder normalized", async () => {
		const t = setup({
			loopProfile: { ...PROFILE, sourceSha256: "f".repeat(64) },
		});
		await expect(
			t.processor.process({ vmafJobId: VMAF_JOB_ID }),
		).rejects.toThrow(/are not the ones the feeder normalized/);
		expect(t.results).toHaveLength(0);
		expect(normalizeOf(t.calls)).toBeUndefined();
	});

	it("fails closed when the reference loop does not reproduce the profile's frame count", async () => {
		const t = setup({
			loopProfile: PROFILE,
			spoolLoop: true,
			loopProbeFrames: 9,
		});
		await expect(
			t.processor.process({ vmafJobId: VMAF_JOB_ID }),
		).rejects.toThrow(/has 9 frames but the feeder pushed 8 \(spool-loop\)/);
		expect(t.results).toHaveLength(0);
		expect(pushOf(t.calls)).toBe("");
	});

	it("rebuilds an SRT push without the RTMP stereo pin when the profile carries no channel count", async () => {
		const { channels: _omit, ...pins } = PROFILE.normalise as Record<
			string,
			unknown
		>;
		const t = setup({
			loopProfile: { ...PROFILE, normalise: pins },
			feeder: {
				id: FEEDER_ID,
				liveChannelId: CHANNEL_ID,
				status: "PUSHING",
				protocol: "SRT_CALLER",
				sourceCredentialId: SRC_CRED,
				sourceBucket: "src-bucket",
				sourceKey: "src/loop.mp4",
				loopBoundaries: [],
				loopProfile: { ...PROFILE, normalise: pins },
				createdAt: new Date(),
			},
		});
		await t.processor.process({ vmafJobId: VMAF_JOB_ID });
		const norm = normalizeOf(t.calls) ?? "";
		expect(norm).toContain("-s 1920x1080");
		expect(norm).not.toContain("-ac 2");
	});

	it("says so when the reproduced push measures a period other than the profile's (the profile is used)", async () => {
		// a 9-frame ring repeated 16× (144 ≥ 2·(8 + 60)) against a profile of 8
		const ring = [10, 80, 30, 60, 20, 70, 40, 50, 90];
		const t = setup({
			loopProfile: PROFILE,
			spoolLoop: true,
			pushedSig: Array.from({ length: 16 }, () => ring).flat(),
		});
		await t.processor.process({ vmafJobId: VMAF_JOB_ID });
		const live = (t.results[0]?.pooled as Row).live as Row;
		expect(live.timeline).toMatchObject({ frames: 8 });
		expect(String(live.warning)).toContain(
			"measured a 9-frame period but the feeder's loop profile says 8",
		);
	});

	it("a session without a profile keeps the raw-source reproduction (no edit-list flag)", async () => {
		const t = setup();
		await t.processor.process({ vmafJobId: VMAF_JOB_ID });
		const live = (t.results[0]?.pooled as Row).live as Row;
		expect(live.referenceSource).toBe("raw-source");
		expect(live.timeline).toMatchObject({ source: "container-probe" });
		expect(pushOf(t.calls)).not.toContain("-ignore_editlist");
		expect(pushOf(t.calls)).toContain("source.mp4");
	});
});

it("aborts live VMAF child work when reset removes the owning measurement", async () => {
	const t = setup();
	let started!: () => void;
	const didStart = new Promise<void>((resolve) => {
		started = resolve;
	});
	let aborted = false;
	vi.mocked(t.runner.run).mockImplementationOnce(
		async (_bin, _argv, options) => {
			started();
			return new Promise((resolve) => {
				options?.signal?.addEventListener(
					"abort",
					() => {
						aborted = true;
						resolve({ code: null, stdout: "", stderr: "" });
					},
					{ once: true },
				);
			});
		},
	);
	const pending = t.processor.process({ vmafJobId: VMAF_JOB_ID });
	await didStart;
	t.vmafJob.findUnique.mockResolvedValue(null);
	await expect(pending).resolves.toMatchObject({
		status: "MISSING",
		results: 0,
	});
	expect(aborted).toBe(true);
	expect(t.results).toEqual([]);
	expect(t.vmafJob.update).not.toHaveBeenCalledWith(
		expect.objectContaining({
			data: expect.objectContaining({ status: "ERROR" }),
		}),
	);
});

it("live reset cadence detects deletion within one hundred milliseconds", async () => {
	vi.useFakeTimers();
	const t = setup();
	let started!: () => void;
	const didStart = new Promise<void>((resolve) => {
		started = resolve;
	});
	let aborted = false;
	vi.mocked(t.runner.run).mockImplementationOnce(
		async (_bin, _argv, options) => {
			started();
			return new Promise((resolve) =>
				options?.signal?.addEventListener(
					"abort",
					() => {
						aborted = true;
						resolve({ code: null, stdout: "", stderr: "" });
					},
					{ once: true },
				),
			);
		},
	);
	const pending = t.processor.process({ vmafJobId: VMAF_JOB_ID });
	pending.catch(() => {});
	try {
		await didStart;
		t.vmafJob.findUnique.mockResolvedValue(null);
		await vi.advanceTimersByTimeAsync(99);
		expect(aborted).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		expect(aborted).toBe(true);
		await expect(pending).resolves.toMatchObject({
			status: "MISSING",
			results: 0,
		});
		expect(t.results).toEqual([]);
	} finally {
		t.vmafJob.findUnique.mockResolvedValue(null);
		await vi.advanceTimersByTimeAsync(2_000);
		await pending.catch(() => {});
		vi.useRealTimers();
	}
});
