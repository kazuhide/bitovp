import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import {
	capturePerTitleResults,
	type LocalVmafExecution,
	NATIVE_OFFICIAL_REVISION,
	PER_TITLE_ATTRIBUTION_VERSION,
	PER_TITLE_CAPTURE_STEP,
	PER_TITLE_RESULT_MODE,
	PER_TITLE_SCHEMA_VERSION,
	type PerTitleCapturePort,
	type ScannedMuxing,
	type ScannedStream,
	VMAF_SCORING_VERSION,
} from "@bitovp/core";
import type { AppPrismaClient } from "@bitovp/db";
import { labManualTriggerPrefix } from "@bitovp/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProcessRunner } from "../feeder/supervisor";
import type { ResolvedCredential } from "../orchestrator/executor";
import type { VmafDownload } from "./download";
import {
	createLocalVmafResources,
	type LocalVmafResources,
} from "./local-resources";
import * as localScoring from "./local-score";
import { NativePairRefusal } from "./native-score";
import { createVmafProcessor, type VmafProcessorDeps } from "./processor";
import * as referencePreparation from "./reference-preparation";
import type { VmafResourceLeaseRequest } from "./resource-leases";
import { createSharedVmafExecution } from "./shared-execution";

/**
 * Processor units run WITHOUT ffmpeg (CI has none): an injected
 * ProcessRunner returns canned ffprobe geometry + writes a canned libvmaf
 * JSON to the log path the argv names, an injected download no-ops, and a
 * fake prisma holds the rows in memory. Mirrors the feeder test style.
 */

const VMAF_JOB_ID = "00000000-0000-4000-8000-0000000000a1";
const ENCODING_JOB_ID = "00000000-0000-4000-8000-0000000000e1";
const INPUT_CRED = "00000000-0000-4000-8000-000000000001";
const OUTPUT_CRED = "00000000-0000-4000-8000-000000000002";
const MIRROR_OUTPUT_CRED = "00000000-0000-4000-8000-000000000003";
const PROVIDER_OUTPUT_ID = "provider-output-origin";

function outputStep(
	outputKey = "origin",
	resourceId = PROVIDER_OUTPUT_ID,
): Record<string, unknown> {
	return {
		step: `output:${outputKey}`,
		kind: "CREATE_OUTPUT_S3",
		payload: {},
		refs: {},
		status: "DONE",
		resourceId,
	};
}

// A 3-rendition-equivalent qc plan: 2 video renditions (v360, v540) sharing
// one S3 source + one S3 output, plus 1 audio (no mirror). Mirrors what the
// compiler emits at qc/<key>.mp4.
function qcPlan(): Record<string, unknown> {
	return {
		planVersion: 1,
		name: "vmaf-test",
		bitmovin: {},
		inputs: [
			{
				key: "main",
				kind: "S3",
				credentialId: INPUT_CRED,
				bucket: "src-bucket",
				name: "Src",
			},
		],
		outputs: [
			{
				key: "origin",
				kind: "S3",
				credentialId: OUTPUT_CRED,
				bucket: "out-bucket",
				name: "Out",
			},
		],
		ingest: [
			{
				key: "video",
				inputKey: "main",
				inputPath: "src/master.mkv",
				selectionMode: "VIDEO_RELATIVE",
				position: 0,
			},
			{
				key: "audio",
				inputKey: "main",
				inputPath: "src/master.mkv",
				selectionMode: "AUDIO_RELATIVE",
				position: 0,
			},
		],
		renditions: [
			{
				key: "v360",
				ingestKey: "video",
				codec: "H264",
				height: 360,
				bitrate: 300000,
			},
			{
				key: "v540",
				ingestKey: "video",
				codec: "H264",
				height: 540,
				bitrate: 600000,
			},
			{
				key: "a128",
				ingestKey: "audio",
				codec: "AAC",
				bitrate: 128000,
				rate: 48000,
			},
		],
		muxings: [
			{
				key: "m360",
				kind: "MP4",
				streamKey: "v360",
				filename: "v360.mp4",
				destination: { outputKey: "origin", path: "out/video/360p" },
			},
			{
				key: "m540",
				kind: "MP4",
				streamKey: "v540",
				filename: "v540.mp4",
				destination: { outputKey: "origin", path: "out/video/540p" },
			},
			{
				key: "ma",
				kind: "FMP4",
				streamKey: "a128",
				destination: { outputKey: "origin", path: "out/audio" },
			},
		],
		generation: { timing: "JUST_IN_TIME" },
		qc: { vmaf: true, model: "vmaf_v0.6.1" },
	};
}

/**
 * Canned libvmaf JSON for the given scores. When `psnr` is provided it is
 * attached as metrics.psnr_y per frame (parallel array) + a pooled psnr_y
 * block — mirroring what the real psnr-feature run emits.
 */
function vmafJson(scores: number[], psnr?: number[]): string {
	return JSON.stringify({
		frames: scores.map((vmaf, i) => ({
			frameNum: i,
			metrics: {
				vmaf,
				...(psnr ? { psnr_y: psnr[i] } : {}),
			},
		})),
		pooled_metrics: {
			vmaf: {
				min: Math.min(...scores),
				max: Math.max(...scores),
				mean: scores.reduce((a, b) => a + b, 0) / scores.length,
				harmonic_mean: scores.reduce((a, b) => a + b, 0) / scores.length,
			},
			...(psnr
				? {
						psnr_y: {
							min: Math.min(...psnr),
							max: Math.max(...psnr),
							mean: psnr.reduce((a, b) => a + b, 0) / psnr.length,
							harmonic_mean: psnr.reduce((a, b) => a + b, 0) / psnr.length,
						},
					}
				: {}),
		},
	});
}

const PROBE_JSON = JSON.stringify({
	streams: [
		{
			codec_type: "video",
			width: 1920,
			height: 1080,
			r_frame_rate: "30/1",
		},
		{ codec_type: "audio" },
	],
});

/** Pulls log_path=<file> out of the libvmaf filter_complex argv. */
function logPathFromArgv(argv: string[]): string | undefined {
	const fc = argv[argv.indexOf("-filter_complex") + 1] ?? "";
	const m = fc.match(/log_path=(?:'([^']+)'|([^:]+))/);
	return m?.[1] ?? m?.[2];
}

type Row = Record<string, unknown>;

function setup(
	opts: {
		job?: Row;
		plan?: Record<string, unknown> | null;
		frameScores?: number[];
		bandingScores?: number[];
		bandingVersion?: string;
		/** When set, the canned libvmaf JSON also carries metrics.psnr_y. */
		psnrScores?: number[];
		ffmpegExit?: number;
		/** stderr the canned ffmpeg run emits on a non-zero exit. */
		ffmpegStderr?: string;
		probeExit?: number;
		probeJson?: string;
		localResources?: LocalVmafResources;
		localRunner?: ProcessRunner;
		resolveLocalResources?: VmafProcessorDeps["resolveLocalResources"];
		selectLocalNative?: VmafProcessorDeps["selectLocalNative"];
		nativeSelectionFailure?: VmafProcessorDeps["nativeSelectionFailure"];
		decodePolicy?: VmafProcessorDeps["decodePolicy"];
		scoringBackend?: VmafProcessorDeps["scoringBackend"];
		nativePath?: string;
		download?: VmafDownload;
		concurrency?: number;
		cloudScore?: VmafProcessorDeps["cloudScore"];
		resolveCloudProfile?: VmafProcessorDeps["resolveCloudProfile"];
		cores?: number;
		threads?: number;
		/** libvmaf `n_subsample` — recorded in `params` when > 1. */
		subsample?: number;
		/** Resolver mapping a model name → bundled model-JSON path (model=path=). */
		resolveModelPath?: (model: string) => string | undefined;
		/** Make every vmafJob.update reject — to assert progress writes are best-effort. */
		failProgressWrites?: boolean;
		/** Override the joined encodingJob row: createdAt (per-title time-window
		 * bound), and the captured per-title ladder  as either the
		 * manual `snapshots.perTitleResults` or a CAPTURE step's response. */
		encodingJob?: {
			createdAt?: Date;
			snapshots?: Record<string, unknown> | null;
			stepLog?: unknown[];
		};
		/** Inject the object lister (per-title placeholder + time-window scope). */
		listKeys?: VmafProcessorDeps["listKeys"];
		/** I3: encodingJob.updateMany matches zero rows (parent deleted). */
		missingEncodingRow?: boolean;
	} = {},
) {
	const job: Row = {
		id: VMAF_JOB_ID,
		encodingJobId: ENCODING_JOB_ID,
		triggerKey: `vod-auto:${ENCODING_JOB_ID}`,
		mode: "VOD",
		model: "vmaf_v0.6.1",
		status: "PENDING",
		error: null,
		...opts.job,
	};
	const plan = opts.plan === undefined ? qcPlan() : opts.plan;
	const results: Row[] = [];

	// The joined encodingJob carries createdAt — the per-title over-counting time
	// window's lower bound (mirrors the row the processor selects) — plus the
	// gate emit identity .
	const encodingJobRow =
		plan === null
			? null
			: {
					plan,
					status: "FINISHED",
					createdAt:
						opts.encodingJob?.createdAt ?? new Date("2026-06-18T00:00:00.000Z"),
					snapshots: opts.encodingJob?.snapshots ?? null,
					stepLog: opts.encodingJob?.stepLog ?? [],
					name: "vmaf-test-job",
					labels: ["qc"],
				};

	const vmafJob = {
		findUnique: vi.fn(
			async (): Promise<
				(Row & { encodingJob: typeof encodingJobRow }) | null
			> => ({
				...job,
				encodingJob: encodingJobRow,
			}),
		),
		updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
			const statusOk =
				where.status === undefined || where.status === job.status;
			if (where.id === job.id && statusOk) {
				Object.assign(job, data);
				return { count: 1 };
			}
			return { count: 0 };
		}),
		update: vi.fn(async ({ data, where }: { data: Row; where: Row }) => {
			if (where.status && where.status !== job.status)
				throw new Error("VMAF terminal status changed");
			// A "progress write" carries totalUnits/doneUnits; markTerminal carries
			// status/error. Only progress writes are best-effort, so the failure
			// injection targets just those (markTerminal must still mark the row).
			const isProgress =
				("totalUnits" in data || "doneUnits" in data) && !("status" in data);
			if (opts.failProgressWrites && isProgress) {
				throw new Error("simulated progress write failure");
			}
			for (const [k, v] of Object.entries(data)) {
				// Prisma atomic increment: { doneUnits: { increment: 1 } }.
				if (
					v &&
					typeof v === "object" &&
					"increment" in (v as Record<string, unknown>)
				) {
					const inc = (v as { increment: number }).increment;
					job[k] = ((job[k] as number | undefined) ?? 0) + inc;
				} else {
					job[k] = v;
				}
			}
			return { ...job };
		}),
	};
	const vmafResult = {
		create: vi.fn(async ({ data }: { data: Row }) => {
			results.push(data);
			return { id: `r${results.length}`, ...data };
		}),
		// Gate verdict read : what the run ACTUALLY persisted —
		// the verdict tests measure the same rows the create pushed, so a
		// mapping bug between persisted refs and gate input cannot hide.
		findMany: vi.fn(async () =>
			results.map((r) => ({ renditionRef: r.renditionRef, pooled: r.pooled })),
		),
	};
	// Denormalized qcVerdict writes .
	const encodingJobWrites: Row[] = [];
	const encodingJob = {
		update: vi.fn(async ({ data }: { data: Row }) => {
			if (opts.missingEncodingRow) {
				// Prisma's P2025: update on a missing row THROWS — which is why
				// the denormalization must ride updateMany (review-201 I3). A
				// mutation back to update makes the I3 test's transaction
				// reject and the measurement re-record as ERROR — red.
				const err = new Error("Record to update not found.") as Error & {
					code: string;
				};
				err.code = "P2025";
				throw err;
			}
			encodingJobWrites.push(data);
			return { id: ENCODING_JOB_ID, ...data };
		}),
		// I3: the denormalized copy rides updateMany (no-op on a deleted row).
		// `missingEncodingRow` simulates the SetNull'd parent.
		updateMany: vi.fn(async ({ data }: { data: Row }) => {
			if (opts.missingEncodingRow) {
				return { count: 0 };
			}
			encodingJobWrites.push(data);
			return { count: 1 };
		}),
	};

	// Array form only — the processor's verdict transaction passes started
	// PrismaPromises; the fake just awaits them together.
	const $transaction = vi.fn(async (ops: Promise<unknown>[]) =>
		Promise.all(ops),
	);
	const prisma = {
		vmafJob,
		vmafResult,
		encodingJob,
		$transaction,
	} as unknown as AppPrismaClient;

	// Continuation queue : records adds; getJob answers from
	// what was added so the claim-failed self-heal sees its own history.
	const queueAdds: { name: string; data: Row; opts: Row }[] = [];
	const orchestratorQueue = {
		add: vi.fn(async (name: string, data: Row, opts: Row) => {
			queueAdds.push({ name, data, opts });
			return { id: opts.jobId };
		}),
		getJob: vi.fn(async (jobId: string) =>
			queueAdds.some((a) => a.opts.jobId === jobId) ? { id: jobId } : null,
		),
	};

	const frameScores = opts.frameScores ?? [95, 96, 94, 97, 93];
	const filterComplexArgs: string[] = [];
	const runner: ProcessRunner = {
		spawn: vi.fn(() => {
			throw new Error("spawn not used by the vmaf runner");
		}),
		run: vi.fn(async (_bin: string, argv: string[]) => {
			if (argv.includes("-show_frames"))
				return {
					code: 0,
					stderr: "",
					stdout: JSON.stringify({
						streams: [{ time_base: "1/1000" }],
						frames: (opts.bandingScores ?? frameScores).map((_, index) => ({
							best_effort_timestamp: index * 40,
							duration: 40,
							width: 640,
							height: 360,
							pix_fmt: "yuv420p",
						})),
					}),
				};
			if (argv.includes("-progress"))
				return { code: 0, stdout: "frame=3\nprogress=end\n", stderr: "" };
			// ffprobe call: -show_streams present, no filter_complex.
			if (argv.includes("-show_streams")) {
				if (opts.bandingScores)
					return {
						code: 0,
						stderr: "",
						stdout: JSON.stringify({
							streams: [
								{
									codec_type: "video",
									width: 640,
									height: 360,
									pix_fmt: "yuv420p",
									codec_name: "h264",
									r_frame_rate: "25/1",
									sample_aspect_ratio: "1:1",
									nb_frames: String(opts.bandingScores.length),
									duration: String(opts.bandingScores.length / 25),
								},
							],
							format: {
								bit_rate: "500000",
								duration: String(opts.bandingScores.length / 25),
							},
						}),
					};
				if (opts.probeJson)
					return {
						code: opts.probeExit ?? 0,
						stdout: opts.probeJson,
						stderr: "",
					};
				// Distorted-mirror probe (adds -show_format) → the per-title rung's
				// REAL height + bitrate for the ladder. The reference probe omits it.
				if (argv.includes("-show_format")) {
					return {
						code: 0,
						stdout: JSON.stringify({
							streams: [{ codec_type: "video", height: 360 }],
							format: { bit_rate: "500000" },
						}),
						stderr: "",
					};
				}
				return {
					code: opts.probeExit ?? 0,
					stdout: PROBE_JSON,
					stderr: "",
				};
			}
			// ffmpeg+libvmaf call: capture filter_complex (so tests can assert the
			// psnr feature), then write the canned JSON to the named log path.
			const fcIdx = argv.indexOf("-filter_complex");
			if (fcIdx >= 0) {
				filterComplexArgs.push(argv[fcIdx + 1] as string);
			}
			const logPath = logPathFromArgv(argv);
			if (logPath && (opts.ffmpegExit ?? 0) === 0) {
				await writeFile(
					logPath,
					argv[fcIdx + 1]?.includes("model=:")
						? JSON.stringify({
								version: opts.bandingVersion ?? "3.2.0",
								frames: (opts.bandingScores ?? []).map((cambi, frameNum) => ({
									frameNum,
									metrics: { cambi_encbd_8_ench_360_encw_640: cambi },
								})),
							})
						: vmafJson(frameScores, opts.psnrScores),
				);
			}
			return {
				code: opts.ffmpegExit ?? 0,
				stdout: "",
				stderr: opts.ffmpegExit
					? (opts.ffmpegStderr ?? "x264 [error]: broken pipe\n")
					: "",
			};
		}),
	};

	const resolveCredential = vi.fn(
		async (id: string): Promise<ResolvedCredential> => ({
			provider: "AWS_S3",
			config: { region: "us-east-1" },
			secret: { accessKeyId: `ak-${id}`, secretAccessKey: `sk-${id}` },
		}),
	);

	const downloaded: { bucket: string; key: string; destPath: string }[] = [];
	const download: VmafDownload =
		opts.download ??
		(async (args) => {
			downloaded.push({
				bucket: args.bucket,
				key: args.key,
				destPath: args.destPath,
			});
			// What the real downloader now returns : the
			// object's identity and digest. The fake names the key it "fetched" so
			// a result row's provenance can be checked against the work list.
			return {
				bucket: args.bucket,
				key: args.key,
				identity: { etag: `"etag-${args.key}"`, size: 1234 },
				pinned: true,
				sha256: `sha256-of-${args.key}`,
				bytes: 1234,
			};
		});

	const emitted: Row[] = [];
	const deps: VmafProcessorDeps = {
		decodePolicy: opts.decodePolicy,
		nativePath: opts.nativePath,
		selectLocalNative: opts.selectLocalNative,
		nativeSelectionFailure: opts.nativeSelectionFailure,
		scoringBackend: opts.scoringBackend,
		prisma,
		resolveCredential,
		runner,
		...(opts.localRunner ? { localRunner: opts.localRunner } : {}),
		ffmpegPath: "ffmpeg",
		ffprobePath: "ffprobe",
		workDir,
		now: () => "2026-06-18T00:00:00.000Z",
		download,
		orchestratorQueue,
		emitEvent: async (event) => {
			emitted.push(event as unknown as Row);
		},
		concurrency: opts.concurrency,
		cloudScore: opts.cloudScore,
		resolveCloudProfile: opts.resolveCloudProfile,
		...(opts.cores !== undefined ? { cores: opts.cores } : {}),
		...(opts.threads !== undefined ? { threads: opts.threads } : {}),
		...(opts.subsample !== undefined ? { subsample: opts.subsample } : {}),
		...(opts.listKeys ? { listKeys: opts.listKeys } : {}),
		...(opts.resolveModelPath
			? { resolveModelPath: opts.resolveModelPath }
			: {}),
		...(opts.localResources ? { localResources: opts.localResources } : {}),
		...(opts.resolveLocalResources
			? { resolveLocalResources: opts.resolveLocalResources }
			: {}),
	};

	return {
		processor: createVmafProcessor(deps),
		deps,
		job,
		results,
		runner,
		download,
		downloaded,
		resolveCredential,
		vmafResult,
		vmafJob,
		filterComplexArgs,
		encodingJobWrites,
		queueAdds,
		orchestratorQueue,
		emitted,
		$transaction,
	};
}

let workDir: string;
beforeEach(() => {
	workDir = mkdtempSync(join(tmpdir(), "vmaf-test-"));
});
afterEach(() => {
	rmSync(workDir, { recursive: true, force: true });
});

describe("createVmafProcessor", () => {
	it("persists actual NVDEC and CPU scoring facts under a separate experimental generation", async () => {
		const t = setup({
			decodePolicy: { backend: "auto", device: 0 },
			probeJson: JSON.stringify({
				streams: [
					{
						codec_type: "video",
						codec_name: "h264",
						pix_fmt: "yuv420p",
						width: 1920,
						height: 1080,
						r_frame_rate: "30/1",
					},
				],
			}),
		});
		await t.processor.process({ vmafJobId: VMAF_JOB_ID });
		expect(t.job.scoringVersion).toBe(8);
		expect(
			t.filterComplexArgs.every(
				(graph) => graph.includes("hwdownload") && graph.includes("libvmaf="),
			),
		).toBe(true);
		for (const result of t.results)
			expect(result.provenance).toMatchObject({
				localExecution: {
					requestedDecode: "auto",
					decode: {
						reference: { backend: "cuda" },
						distorted: { backend: "cuda" },
					},
					scoring: { backend: "cpu", implementation: "libvmaf" },
				},
			});
	});

	it("keeps experimental hardware measurements out of automatic delivery gates", async () => {
		const plan = qcPlan();
		plan.qc = {
			vmaf: true,
			gate: {
				rules: [{ metric: "VMAF_MEAN", scope: "PER_RENDITION", gte: 80 }],
				onFail: "BLOCK_MANIFESTS",
			},
		};
		const t = setup({ plan, decodePolicy: { backend: "auto", device: 0 } });
		await expect(
			t.processor.process({ vmafJobId: VMAF_JOB_ID }),
		).rejects.toThrow("cannot evaluate delivery gates");
		expect(t.results).toHaveLength(0);
		expect(t.runner.run).not.toHaveBeenCalled();
	});

	it("leaves cloud scoring untouched by local hardware settings", async () => {
		const cloudScore = vi.fn(async (request) => {
			await writeFile(request.options.logPath, vmafJson([96]));
		});
		const t = setup({
			decodePolicy: { backend: "cuda", device: 0 },
			scoringBackend: "vulkan",
			cloudScore,
			job: {
				params: {
					execution: { backend: "CLOUD", profileId: "gcp", budgetUsd: 10 },
				},
			},
		});
		await t.processor.process({ vmafJobId: VMAF_JOB_ID });
		expect(cloudScore).toHaveBeenCalledTimes(2);
		expect(
			cloudScore.mock.calls.every(
				([request]) => !request.options.decode && !request.options.scoring,
			),
		).toBe(true);
		expect(
			t.results.every((result) => !(result.provenance as Row).localExecution),
		).toBe(true);
	});

	it.each([
		7, 8,
	])("refuses to relabel an experimental retry as ordinary CPU scoring: generation %s", async (scoringVersion) => {
		const t = setup({ job: { scoringVersion } });
		await expect(
			t.processor.process({ vmafJobId: VMAF_JOB_ID }),
		).rejects.toThrow("configuration changed");
		expect(t.results).toHaveLength(0);
		expect(t.runner.run).not.toHaveBeenCalled();
	});
	it.each([
		"cuda",
		"vulkan",
	] as const)("refuses old generations with implicit LOCAL params under owned %s scoring", async (scoringBackend) => {
		for (const scoringVersion of [7, 8]) {
			const t = setup({ scoringBackend, job: { scoringVersion, params: {} } });
			await expect(
				t.processor.process({ vmafJobId: VMAF_JOB_ID }),
			).rejects.toThrow(/create a new measurement/i);
			expect(t.job.scoringVersion).toBe(scoringVersion);
			expect(t.results).toHaveLength(0);
			expect(t.runner.run).not.toHaveBeenCalled();
		}
	});
	it("does not relabel an ordinary retry that already contains measured CPU results", async () => {
		const t = setup({ scoringBackend: "vulkan", job: { scoringVersion: 3 } });
		t.results.push({
			renditionRef: { renditionKey: "v720" },
			pooled: { mean: 90 },
		});
		await expect(
			t.processor.process({ vmafJobId: VMAF_JOB_ID }),
		).rejects.toThrow(/existing results.*new measurement/i);
		expect(t.job.scoringVersion).toBe(3);
		expect(t.results).toHaveLength(1);
		expect(t.runner.run).not.toHaveBeenCalled();
	});
	it("limits abort escalation to ordinary local scoring commands", async () => {
		const t = setup();
		await t.processor.process({ vmafJobId: VMAF_JOB_ID });
		const calls = vi.mocked(t.runner.run).mock.calls;
		const scoring = calls.filter(([, argv]) =>
			argv.join(" ").includes("libvmaf"),
		);
		const preparation = calls.filter(
			([, argv]) => !argv.join(" ").includes("libvmaf"),
		);
		expect(scoring).toHaveLength(2);
		expect(preparation.length).toBeGreaterThan(0);
		for (const [, , options] of scoring) {
			expect(options).toMatchObject({
				abortKillAfterMs: 250,
				signal: expect.any(AbortSignal),
			});
		}
		for (const [, , options] of preparation) {
			expect(options).not.toHaveProperty("abortKillAfterMs");
		}
	});

	it("applies the local resource policy through the real processor factory", async () => {
		const localResources = createLocalVmafResources({
			readResources: () => ({
				cpuCapacity: 4,
				budgetBytes: 3 * 1024 ** 3,
				reserveBytes: 512 * 1024 ** 2,
			}),
		});
		const probeJson = JSON.stringify({
			streams: [
				{
					codec_type: "video",
					codec_name: "h264",
					width: 1920,
					height: 1080,
					pix_fmt: "yuv420p",
					r_frame_rate: "30/1",
					duration: "10",
					nb_frames: "300",
				},
			],
		});
		const t = setup({ localResources, probeJson });
		await expect(
			t.processor.process({ vmafJobId: VMAF_JOB_ID }),
		).resolves.toMatchObject({
			status: "FINISHED",
			results: 2,
		});
		expect(t.filterComplexArgs).toHaveLength(2);
		for (const graph of t.filterComplexArgs) {
			expect(graph).toContain("n_threads=4");
			expect(graph).not.toContain("n_subsample");
		}
		const calls = vi
			.mocked(t.runner.run)
			.mock.calls.filter(([, argv]) => argv.includes("-filter_complex"));
		for (const [, argv] of calls) {
			expect(argv.filter((value) => value === "-threads")).toHaveLength(2);
			expect(argv[argv.indexOf("-filter_complex_threads") + 1]).toBe("1");
		}
		expect(t.job).toMatchObject({ cores: 4, threads: 4, concurrency: 1 });
		expect(
			(t.job.params as { localResources: { units: unknown[] } }).localResources
				.units,
		).toHaveLength(2);
	});

	it("scores existing full MP4s through Lab with PSNR and leaves encoding QC untouched", async () => {
		const plan = qcPlan();
		delete plan.qc;
		const t = setup({
			plan,
			job: {
				triggerKey: `lab-manual:${ENCODING_JOB_ID}:output`,
				params: { source: "OUTPUT_MP4", psnr: true },
			},
			psnrScores: [30, 31, 32],
		});
		const result = await t.processor.process({ vmafJobId: VMAF_JOB_ID });
		expect(result).toMatchObject({ status: "FINISHED", results: 2 });
		expect(t.downloaded.map((d) => d.key)).toContain("out/video/360p/v360.mp4");
		expect(t.downloaded.some((d) => d.key.includes("/qc/"))).toBe(false);
		expect(t.encodingJobWrites).toEqual([]);
		expect(t.queueAdds).toEqual([]);
		expect(t.job.gateVerdict).toBeUndefined();
	});

	it("transitions PENDING→RUNNING→FINISHED and writes one result per video rendition", async () => {
		const t = setup();
		const res = await t.processor.process({ vmafJobId: VMAF_JOB_ID });

		expect(res).toMatchObject({ status: "FINISHED", results: 2 });
		expect(t.job.status).toBe("FINISHED");
		expect(t.job.error).toBeNull();
		// PENDING→RUNNING claim happened.
		expect(t.vmafJob.updateMany).toHaveBeenCalledWith({
			where: { id: VMAF_JOB_ID, status: "PENDING" },
			data: { status: "RUNNING", error: null },
		});
		// One VmafResult per VIDEO rendition (audio gets no mirror).
		expect(t.results).toHaveLength(2);
		expect(t.results.map((r) => (r.renditionRef as Row).renditionKey)).toEqual([
			"v360",
			"v540",
		]);
	});

	it("with concurrency>1 scores every target once and shares one reference", async () => {
		const t = setup({ concurrency: 2 });
		const res = await t.processor.process({ vmafJobId: VMAF_JOB_ID });
		expect(res).toMatchObject({ status: "FINISHED", results: 2 });
		// No double-scoring / dropped target under the pool.
		expect(t.results).toHaveLength(2);
		expect(
			t.results.map((r) => (r.renditionRef as Row).renditionKey).sort(),
		).toEqual(["v360", "v540"]);
		// The shared reference is still downloaded exactly once (sequential
		// pre-fetch before the pool), not once per concurrent worker.
		expect(t.downloaded.filter((d) => d.key === "src/master.mkv")).toHaveLength(
			1,
		);
	});

	it("loops a pool worker over the shared index when items > concurrency", async () => {
		// 3 targets, concurrency 2 ⇒ one worker pulls twice — exercises the
		// shared-index increment across multiple pulls per worker.
		const plan = qcPlan();
		(plan.renditions as Row[]).push({
			key: "v720",
			ingestKey: "video",
			codec: "H264",
			height: 720,
			bitrate: 1_200_000,
		});
		(plan.muxings as Row[]).push({
			key: "m720",
			kind: "MP4",
			streamKey: "v720",
			filename: "v720.mp4",
			destination: { outputKey: "origin", path: "out/video/720p" },
		});
		const t = setup({ plan, concurrency: 2 });
		const res = await t.processor.process({ vmafJobId: VMAF_JOB_ID });
		expect(res).toMatchObject({ status: "FINISHED", results: 3 });
		expect(
			t.results.map((r) => (r.renditionRef as Row).renditionKey).sort(),
		).toEqual(["v360", "v540", "v720"]);
		expect(t.downloaded.filter((d) => d.key === "src/master.mkv")).toHaveLength(
			1,
		);
	});

	it("records totalUnits/cores/threads/concurrency and bumps doneUnits per result", async () => {
		const t = setup({ concurrency: 2, cores: 8, threads: 4 });
		const res = await t.processor.process({ vmafJobId: VMAF_JOB_ID });
		expect(res).toMatchObject({ status: "FINISHED", results: 2 });

		// Baseline write after the work list is built: 2 video targets, the
		// execution profile from the deps, doneUnits reset to 0.
		const baseline = t.vmafJob.update.mock.calls.find(
			(c) => (c[0] as { data: Row }).data.totalUnits !== undefined,
		);
		expect(baseline?.[0].data).toMatchObject({
			totalUnits: 2,
			doneUnits: 0,
			cores: 8,
			threads: 4,
			concurrency: 2,
		});

		// Each scoring bumped doneUnits via an ATOMIC increment (not a read-set).
		const increments = t.vmafJob.update.mock.calls.filter((c) => {
			const inc = (c[0] as { data: Row }).data.doneUnits as
				| { increment?: number }
				| undefined;
			return inc?.increment === 1;
		});
		expect(increments).toHaveLength(2);

		// On FINISHED the fake row reflects doneUnits === totalUnits.
		expect(t.job.totalUnits).toBe(2);
		expect(t.job.doneUnits).toBe(2);
		expect(t.job.cores).toBe(8);
	});

	it("omits cores/threads when the deps don't carry them (older worker)", async () => {
		const t = setup(); // no cores/threads in deps
		await t.processor.process({ vmafJobId: VMAF_JOB_ID });
		const baseline = t.vmafJob.update.mock.calls.find(
			(c) => (c[0] as { data: Row }).data.totalUnits !== undefined,
		);
		expect(baseline?.[0].data).toMatchObject({ totalUnits: 2, doneUnits: 0 });
		expect((baseline?.[0].data as Row).cores).toBeUndefined();
		expect((baseline?.[0].data as Row).threads).toBeUndefined();
		// concurrency always present (defaults to 1 inside the processor).
		expect((baseline?.[0].data as Row).concurrency).toBe(1);
	});

	/**
	 * The stride has to be RECORDED, not just applied. `n_subsample=N` scores every
	 * Nth frame, so a subsampled report's `min` is the worst frame of a sample while
	 * the pooled mean barely moves — two reports can share a scoring generation and
	 * still not be comparable on their minima. Nothing recorded which side of that a
	 * report was on, so the QC screens could not say so.
	 */
	it.each([
		undefined,
		4,
	])("cloud automatic scoring forces full-frame despite local stride4 (old metadata=%s)", async (previousStride) => {
		const cloudScore = vi.fn(async (request) => {
			if ((request.options.subsample ?? 1) !== 1)
				throw new Error("Cloud VMAF requires full-frame scoring (subsample=1)");
			await writeFile(request.options.logPath, vmafJson([95, 96, 94, 97, 93]));
		});
		const plan = qcPlan();
		plan.qc = {
			vmaf: true,
			gate: {
				rules: [{ metric: "VMAF_MEAN", scope: "PER_RENDITION", gte: 80 }],
				onFail: "BLOCK_MANIFESTS",
			},
		};
		const t = setup({
			plan,
			subsample: 4,
			cloudScore,
			localResources: {
				begin: () => {
					throw new Error(
						"Cloud scoring must not enter local resource admission",
					);
				},
			},
			job: {
				params: {
					execution: { backend: "CLOUD", profileId: "gcp", budgetUsd: 10 },
					...(previousStride === undefined
						? {}
						: { subsample: previousStride }),
				},
			},
		});
		expect(await t.processor.process({ vmafJobId: VMAF_JOB_ID })).toMatchObject(
			{ status: "FINISHED", results: 2 },
		);
		expect(cloudScore).toHaveBeenCalledTimes(2);
		expect(
			cloudScore.mock.calls.every(
				([request]) => (request.options.subsample ?? 1) === 1,
			),
		).toBe(true);
		expect(t.job.params).toMatchObject({ subsample: 1 });
		expect(t.job.gateVerdict).toMatchObject({ pass: true });
		expect(t.queueAdds).toHaveLength(1);
		expect(t.filterComplexArgs).toEqual([]);
	});

	it("local scoring still applies and records the configured stride4", async () => {
		const t = setup({ subsample: 4 });
		expect(await t.processor.process({ vmafJobId: VMAF_JOB_ID })).toMatchObject(
			{ status: "FINISHED", results: 2 },
		);
		expect(t.filterComplexArgs).toHaveLength(2);
		expect(
			t.filterComplexArgs.every((filter) => filter.includes("n_subsample=4")),
		).toBe(true);
		expect(t.job.params).toMatchObject({ subsample: 4 });
	});

	it("records the subsample stride in params when one is in force", async () => {
		const t = setup({ subsample: 4 });
		await t.processor.process({ vmafJobId: VMAF_JOB_ID });
		const baseline = t.vmafJob.update.mock.calls.find(
			(c) => (c[0] as { data: Row }).data.totalUnits !== undefined,
		);
		expect((baseline?.[0].data as Row).params).toMatchObject({ subsample: 4 });
	});

	/**
	 * The stride must SURVIVE the run, not merely be written once.
	 *
	 * Asserting the write's arguments is not the same claim as asserting the row,
	 * and the difference was a live bug: the reference-geometry write later in the
	 * same run merges into the `params` read at job START, so it reconstructed
	 * `{reference}` from a stale `{}` and wiped the stride it never saw. Every
	 * subsampled report would have ended up looking full-precision — the same
	 * written-then-dropped shape as the scoring-generation bug. This asserts the
	 * FINAL row, and both fields, because either one alone passes while the other
	 * is being clobbered.
	 */
	it("keeps the stride AND the reference geometry after the whole run", async () => {
		const t = setup({ subsample: 4 });
		await t.processor.process({ vmafJobId: VMAF_JOB_ID });
		expect(t.job.params).toMatchObject({
			subsample: 4,
			reference: expect.objectContaining({ width: expect.any(Number) }),
		});
	});

	it("preserves a params field a previous attempt recorded", async () => {
		/**
		 * A retry re-reads the row and both writers rebuild `params`, so the
		 * accumulator has to be SEEDED from what is already there or the retry
		 * silently narrows the row to whatever this attempt happens to write. Uses a
		 * key neither writer sets, so the assertion is about the seed and not about
		 * one writer's ordering relative to the other.
		 */
		const t = setup({ subsample: 4 });
		t.job.params = { carriedOver: "from an earlier attempt" };
		await t.processor.process({ vmafJobId: VMAF_JOB_ID });
		expect(t.job.params).toMatchObject({
			carriedOver: "from an earlier attempt",
			subsample: 4,
			reference: expect.objectContaining({ width: expect.any(Number) }),
		});
	});

	it("writes no params at all for a full-precision run", async () => {
		// Absent, not `subsample: 1`: a full-precision row must stay byte-identical to
		// what it was before this field existed, and the reader treats 1 and null as
		// the same answer anyway.
		for (const deps of [{}, { subsample: 1 }]) {
			const t = setup(deps);
			await t.processor.process({ vmafJobId: VMAF_JOB_ID });
			const baseline = t.vmafJob.update.mock.calls.find(
				(c) => (c[0] as { data: Row }).data.totalUnits !== undefined,
			);
			expect((baseline?.[0].data as Row).params).toBeUndefined();
		}
	});

	it("does NOT fail the run when progress writes throw (best-effort)", async () => {
		const t = setup({ failProgressWrites: true });
		const res = await t.processor.process({ vmafJobId: VMAF_JOB_ID });
		// The run still FINISHES and persists every result — progress is cosmetic.
		expect(res).toMatchObject({ status: "FINISHED", results: 2 });
		expect(t.job.status).toBe("FINISHED");
		expect(t.results).toHaveLength(2);
		// Even though every best-effort increment threw, the authoritative FINISHED
		// write pins doneUnits to the total (the bar reads 100% on success).
		expect(t.job.doneUnits).toBe(2);
	});

	it("fills per-title height/bitrate from the distorted ffprobe (ladder metadata)", async () => {
		// A per-title rendition carries no plan height/bitrate (the algorithm
		// picks them per rung) — so the ladder needs the mirror's real values.
		const plan = qcPlan();
		plan.renditions = [
			{
				key: "vpt",
				ingestKey: "video",
				codec: "H264",
				mode: "PER_TITLE_TEMPLATE",
				height: null,
				bitrate: null,
			},
		];
		plan.muxings = [
			{
				key: "mpt",
				kind: "MP4",
				streamKey: "vpt",
				filename: "vpt.mp4",
				destination: { outputKey: "origin", path: "out/video/pt" },
			},
		];
		const t = setup({ plan });
		const res = await t.processor.process({ vmafJobId: VMAF_JOB_ID });
		expect(res).toMatchObject({ status: "FINISHED", results: 1 });
		const ref = t.results[0]?.renditionRef as Row;
		expect(ref.renditionKey).toBe("vpt");
		// Filled from the distorted probe (360p / 500 kbps), NOT the null plan
		// values — so LadderScatter can place the per-title rung.
		expect(ref.height).toBe(360);
		expect(ref.bitrate).toBe(500000);
	});

	it("computes pooled metrics from the canned frames", async () => {
		const t = setup({ frameScores: [90, 80, 100, 70, 60] });
		await t.processor.process({ vmafJobId: VMAF_JOB_ID });

		const pooled = t.results[0]?.pooled as { mean: number; min: number };
		// mean of [90,80,100,70,60] = 80; min = 60.
		expect(pooled.mean).toBeCloseTo(80, 5);
		expect(pooled.min).toBe(60);
	});

	it("gzips the per-frame array into framesGzip (frames column stays null) and gunzips back", async () => {
		const scores = [95, 96, 94, 97, 93];
		const t = setup({ frameScores: scores });
		await t.processor.process({ vmafJobId: VMAF_JOB_ID });

		const row = t.results[0] as Row;
		expect(row.frames).toBeUndefined(); // never set → column null
		const gz = row.framesGzip as Uint8Array;
		expect(gz).toBeInstanceOf(Uint8Array);
		const frames = JSON.parse(gunzipSync(gz).toString("utf8")) as {
			frameNum: number;
			vmaf: number;
		}[];
		expect(frames).toEqual(scores.map((vmaf, i) => ({ frameNum: i, vmaf })));
	});

	it("downloads the reference ONCE (shared) and each distorted from the output", async () => {
		const t = setup();
		await t.processor.process({ vmafJobId: VMAF_JOB_ID });

		const refs = t.downloaded.filter((d) => d.key === "src/master.mkv");
		const dists = t.downloaded.filter((d) => d.key.startsWith("out/"));
		expect(refs).toHaveLength(1); // one source, downloaded once
		expect(refs[0]?.bucket).toBe("src-bucket");
		expect(dists.map((d) => d.key).sort()).toEqual([
			"out/video/360p/qc/v360.mp4",
			"out/video/540p/qc/v540.mp4",
		]);
		expect(dists.every((d) => d.bucket === "out-bucket")).toBe(true);
	});

	it("fails the job ERROR on a non-zero ffmpeg exit, with a redacted stderr tail", async () => {
		const t = setup({ ffmpegExit: 1 });
		await expect(
			t.processor.process({ vmafJobId: VMAF_JOB_ID }),
		).rejects.toThrow(/libvmaf failed/);
		expect(t.job.status).toBe("ERROR");
		expect(String(t.job.error)).toContain("x264");
	});

	it("surfaces a clear, actionable error when a VMAF v1 model file is not bundled", async () => {
		// A v1 model requested on a worker that does NOT bundle the model file
		// (no resolveModelPath) — ffmpeg can't find it as a built-in either.
		const t = setup({
			job: { model: "vmaf_v1.0.16_3d0h" },
			ffmpegExit: 234,
			ffmpegStderr:
				'libvmaf WARNING no such built-in model: "vmaf_v1.0.16_3d0h"\ncould not load libvmaf model with version: vmaf_v1.0.16_3d0h\nError : Invalid argument\n',
		});
		await expect(
			t.processor.process({ vmafJobId: VMAF_JOB_ID }),
		).rejects.toThrow(/not a libvmaf built-in/);
		// The persisted error names the model + the real fix (bundled model FILE /
		// Docker worker / VMAF_MODEL_DIR), not the cryptic "Invalid argument" tail.
		expect(String(t.job.error)).toMatch(/vmaf_v1\.0\.16_3d0h/);
		expect(String(t.job.error)).toMatch(/VMAF_MODEL_DIR|Docker worker/);
	});

	it("loads a bundled model by path (model=path=) when resolveModelPath finds it", async () => {
		// With a resolver that returns a file, the runner must invoke ffmpeg with
		// `model=path=<file>` (NOT `model=version=`) so VMAF v1 models score.
		const modelFile = "/opt/vmaf/model/vmaf_v1.0.16_3d0h.json";
		const t = setup({
			job: { model: "vmaf_v1.0.16_3d0h" },
			resolveModelPath: (m) =>
				m === "vmaf_v1.0.16_3d0h" ? modelFile : undefined,
		});
		await t.processor.process({ vmafJobId: VMAF_JOB_ID });
		expect(t.job.status).toBe("FINISHED");
		const filter = t.filterComplexArgs.at(-1) ?? "";
		expect(filter).toContain(`model=path=${modelFile}`);
		expect(filter).not.toContain("model=version=");
	});

	it("finishes with zero results when the plan is not qc-enabled", async () => {
		const plan = qcPlan();
		plan.qc = { vmaf: false, model: "vmaf_v0.6.1" };
		const t = setup({ plan });
		const res = await t.processor.process({ vmafJobId: VMAF_JOB_ID });
		expect(res).toMatchObject({ status: "FINISHED", results: 0 });
		expect(t.results).toHaveLength(0);
	});

	it("is idempotent: a non-PENDING job is not re-run", async () => {
		const t = setup({ job: { status: "FINISHED" } });
		const res = await t.processor.process({ vmafJobId: VMAF_JOB_ID });
		expect(res.status).toBe("FINISHED");
		expect(t.results).toHaveLength(0);
		expect(t.runner.run).not.toHaveBeenCalled();
	});

	it("returns MISSING when the job row is gone", async () => {
		const t = setup();
		(
			t.vmafJob.findUnique as unknown as {
				mockResolvedValueOnce(v: null): void;
			}
		).mockResolvedValueOnce(null);
		const res = await t.processor.process({ vmafJobId: VMAF_JOB_ID });
		expect(res.status).toBe("MISSING");
	});

	it("redacts URL-embedded credentials from the ffmpeg stderr in the persisted error", async () => {
		// ffmpeg can echo a credential-bearing URL on stderr; redactSecrets
		// masks the userinfo password (scheme://user:pass@host) before persist.
		const t = setup();
		(t.runner.run as ReturnType<typeof vi.fn>).mockImplementation(
			async (_bin: string, argv: string[]) => {
				if (argv.includes("-show_streams")) {
					return { code: 0, stdout: PROBE_JSON, stderr: "" };
				}
				return {
					code: 1,
					stdout: "",
					stderr: "Failed: https://user:SUPERSECRET@host/obj denied\n",
				};
			},
		);
		await expect(
			t.processor.process({ vmafJobId: VMAF_JOB_ID }),
		).rejects.toThrow(/libvmaf failed/);
		expect(t.job.status).toBe("ERROR");
		expect(String(t.job.error)).not.toContain("SUPERSECRET");
		expect(String(t.job.error)).toContain("[REDACTED]");
	});

	it("uses the source extension faithfully and cleans up (no leak in workDir)", async () => {
		const t = setup();
		await t.processor.process({ vmafJobId: VMAF_JOB_ID });
		// The per-job scratch dir is removed on completion.
		expect(() => readFileSync(join(workDir, VMAF_JOB_ID))).toThrow();
	});

	describe("PSNR (P4-PR5)", () => {
		/** Plan with qc.psnr enabled (rides the same VMAF pass). */
		function psnrPlan(): Record<string, unknown> {
			const plan = qcPlan();
			plan.qc = { vmaf: true, model: "vmaf_v0.6.1", psnr: true };
			return plan;
		}

		it("enables libvmaf's psnr feature in the argv when qc.psnr is set", async () => {
			const t = setup({
				plan: psnrPlan(),
				frameScores: [95, 96, 94],
				psnrScores: [42, 43, 41],
			});
			await t.processor.process({ vmafJobId: VMAF_JOB_ID });
			// every libvmaf invocation (one per video rendition) carries the feature
			expect(t.filterComplexArgs.length).toBe(2);
			for (const fc of t.filterComplexArgs) {
				expect(fc).toContain("feature=name=psnr");
			}
		});

		it("honors a manual PSNR-off override without changing the encoding QC", async () => {
			const t = setup({
				plan: psnrPlan(),
				job: {
					triggerKey: `lab-manual:${ENCODING_JOB_ID}:override`,
					params: { psnr: false },
				},
				frameScores: [95, 96],
				psnrScores: [42, 43],
			});
			await t.processor.process({ vmafJobId: VMAF_JOB_ID });
			expect(t.filterComplexArgs).toHaveLength(2);
			for (const fc of t.filterComplexArgs)
				expect(fc).not.toContain("feature=name=psnr");
			for (const result of t.results)
				expect(result.pooled).not.toHaveProperty("psnr");
			expect(t.encodingJobWrites).toEqual([]);
		});

		it.each([
			false,
			true,
			undefined,
		])("passes manual PSNR %s to cloud scoring while selecting existing MP4s", async (psnr) => {
			const cloudScore = vi.fn(async (request) => {
				await writeFile(
					request.options.logPath,
					vmafJson([95, 96], request.options.psnr ? [42, 43] : undefined),
				);
			});
			const t = setup({
				plan: psnrPlan(),
				cloudScore,
				job: {
					triggerKey: `lab-manual:${ENCODING_JOB_ID}:cloud-override`,
					params: {
						source: "OUTPUT_MP4",
						...(psnr !== undefined ? { psnr } : {}),
						execution: { backend: "CLOUD", profileId: "gcp", budgetUsd: 10 },
					},
				},
			});
			expect(
				await t.processor.process({ vmafJobId: VMAF_JOB_ID }),
			).toMatchObject({ status: "FINISHED", results: 2 });
			expect(cloudScore).toHaveBeenCalledTimes(2);
			for (const [request] of cloudScore.mock.calls)
				expect(request.options.psnr).toBe(psnr === false ? undefined : true);
			expect(t.downloaded.map((d) => d.key)).toContain(
				"out/video/360p/v360.mp4",
			);
			expect(t.downloaded.some((d) => d.key.includes("/qc/"))).toBe(false);
			expect(t.encodingJobWrites).toEqual([]);
		});

		it("stores pooled.psnr (mean/min/max) and per-frame psnr in framesGzip", async () => {
			const t = setup({
				plan: psnrPlan(),
				frameScores: [95, 96, 94],
				psnrScores: [42, 44, 40],
			});
			await t.processor.process({ vmafJobId: VMAF_JOB_ID });

			const row = t.results[0] as Row;
			const pooled = row.pooled as {
				mean: number;
				psnr?: Record<string, number>;
			};
			expect(pooled.psnr).toEqual({
				mean: (42 + 44 + 40) / 3,
				min: 40,
				max: 44,
			});

			const frames = JSON.parse(
				gunzipSync(row.framesGzip as Uint8Array).toString("utf8"),
			) as { frameNum: number; vmaf: number; psnr?: number }[];
			expect(frames).toEqual([
				{ frameNum: 0, vmaf: 95, psnr: 42 },
				{ frameNum: 1, vmaf: 96, psnr: 44 },
				{ frameNum: 2, vmaf: 94, psnr: 40 },
			]);
		});

		it("does NOT request the feature or store psnr when qc.psnr is off", async () => {
			// Default qcPlan has vmaf:true, psnr unset → VMAF-only, unchanged.
			const t = setup({
				frameScores: [90, 80],
				psnrScores: [40, 41], // even if the log carried psnr_y…
			});
			await t.processor.process({ vmafJobId: VMAF_JOB_ID });

			// argv has no feature token (so the real run wouldn't emit psnr_y).
			for (const fc of t.filterComplexArgs) {
				expect(fc).not.toContain("feature=");
			}
			const row = t.results[0] as Row;
			const pooled = row.pooled as { psnr?: unknown };
			// runner only folds psnr when wantPsnr — VMAF-only result omits it.
			expect(pooled.psnr).toBeUndefined();
		});
	});

	describe("per-title scoping to THIS run (over-counting fix)", () => {
		it("scopes PER-TITLE rungs to this run via lastModified ≥ encode start (excludes a stale mirror)", async () => {
			// A per-title plan: ONE templated qc muxing → many resolved rungs in
			// storage. The encoding's createdAt bounds the lister: a prior run's
			// older rung under the same base must NOT be scored.
			const plan = qcPlan();
			plan.renditions = [
				{
					key: "vpt",
					ingestKey: "video",
					codec: "H264",
					mode: "PER_TITLE_TEMPLATE",
					height: null,
					bitrate: null,
				},
			];
			plan.muxings = [
				{
					key: "mpt",
					kind: "MP4",
					streamKey: "vpt",
					filename: "vpt.mp4",
					// Templated destination (constraint C4) → templated qc mirror path.
					destination: {
						outputKey: "origin",
						path: "out/pt/{height}p_{bitrate}_{uuid}",
					},
				},
			];
			const encodeStart = new Date("2026-06-20T12:00:00.000Z");
			const listKeys = vi.fn(async () => [
				// this run's rungs (after start)
				{
					key: "out/pt/360p_500000_thisA/qc/vpt.mp4",
					lastModified: "2026-06-20T12:00:05.000Z",
				},
				{
					key: "out/pt/540p_900000_thisB/qc/vpt.mp4",
					lastModified: "2026-06-20T12:00:06.000Z",
				},
				// a PRIOR run's stale rung under the same base (before start)
				{
					key: "out/pt/360p_500000_oldX/qc/vpt.mp4",
					lastModified: "2026-06-01T00:00:00.000Z",
				},
			]);
			const t = setup({
				plan,
				encodingJob: { createdAt: encodeStart },
				listKeys,
			});
			const res = await t.processor.process({ vmafJobId: VMAF_JOB_ID });

			expect(res).toMatchObject({ status: "FINISHED", results: 2 });
			// The lister was called with the templated prefix (per-title path).
			expect(listKeys).toHaveBeenCalledWith(
				expect.objectContaining({ prefix: "out/pt/" }),
			);
			// The stale rung (oldX) is excluded; only this run's two rungs scored.
			const variants = t.results
				.map((r) => (r.renditionRef as Row).perTitleVariant)
				.sort();
			expect(variants).toEqual(["360p_500000_thisA", "540p_900000_thisB"]);
		});
	});

	describe("the captured ladder is the population (ledger #211, paid audit HIGH-10)", () => {
		function perTitlePlan() {
			const plan = qcPlan();
			plan.renditions = [
				{
					key: "vpt",
					ingestKey: "video",
					codec: "H264",
					mode: "PER_TITLE_TEMPLATE",
					height: null,
					bitrate: null,
				},
			];
			plan.muxings = [
				{
					key: "mpt",
					kind: "MP4",
					streamKey: "vpt",
					filename: "vpt.mp4",
					destination: {
						outputKey: "origin",
						path: "out/pt/{height}p_{bitrate}_{uuid}",
					},
				},
			];
			return plan;
		}
		const rung = (id: string, dir: string, withMirror: boolean) => ({
			streamId: id,
			mode: "PER_TITLE_RESULT",
			templateRendition: "vpt",
			params: {},
			muxings: [
				{
					muxingId: `${id}-fmp4`,
					muxingType: "FMP4",
					outputs: [
						{
							outputId: PROVIDER_OUTPUT_ID,
							outputPath: `out/pt/${dir}/video/`,
						},
					],
					drm: [],
				},
				...(withMirror
					? [
							{
								muxingId: `${id}-qc`,
								muxingType: "MP4",
								filename: "vpt.mp4",
								outputs: [
									{
										outputId: PROVIDER_OUTPUT_ID,
										outputPath: `out/pt/${dir}/qc/`,
									},
								],
								drm: [],
							},
						]
					: []),
			],
		});
		const snapshot = (rungs: ReturnType<typeof rung>[]) => ({
			capturedAt: "2026-06-20T12:05:00.000Z",
			schemaVersion: PER_TITLE_SCHEMA_VERSION,
			attributionVersion: PER_TITLE_ATTRIBUTION_VERSION,
			streams: rungs,
			scan: {
				streamsListed: rungs.length,
				templatesListed: 1,
				templatesDeclared: 1,
				resultsCaptured: rungs.length,
				muxingsListed: rungs.length * 2,
				complete: true,
				codecConfigErrors: 0,
				unattributed: 0,
			},
		});

		it.each([
			"manual",
			"native",
		])("scores every captured Per-Title QC mirror with %s generation6 cloud frame validation", async (kind) => {
			const cloudScore = vi.fn(async (request) => {
				await writeFile(request.options.logPath, vmafJson([96, 97]));
			});
			const listKeys = vi.fn(async () => []);
			const plan = perTitlePlan();
			if (kind === "native")
				plan.qc = {
					...(plan.qc as Row),
					measurementMethod: "FRAME_INDEX_BT709_10BIT",
					execution: { backend: "CLOUD", profileId: "gcp", budgetUsd: 10 },
				};
			const t = setup({
				plan,
				cloudScore,
				listKeys,
				job: {
					scoringVersion: 6,
					triggerKey:
						kind === "native"
							? `vod-auto:${ENCODING_JOB_ID}`
							: `lab-manual:${ENCODING_JOB_ID}:mirror`,
					params: {
						source: "QC_MIRROR",
						measurementMethod: "FRAME_INDEX_BT709_10BIT",
						execution: { backend: "CLOUD", profileId: "gcp", budgetUsd: 10 },
					},
				},
				encodingJob: {
					stepLog: [
						outputStep(),
						{
							step: PER_TITLE_CAPTURE_STEP,
							kind: "CAPTURE_PER_TITLE_RESULTS",
							status: "DONE",
							response: {
								captured: true,
								snapshot: snapshot([
									rung("s1", "360p_500000_capA", true),
									rung("s2", "540p_900000_capB", true),
								]),
							},
						},
					],
				},
			});
			expect(
				await t.processor.process({ vmafJobId: VMAF_JOB_ID }),
			).toMatchObject({ status: "FINISHED", results: 2 });
			expect(listKeys).not.toHaveBeenCalled();
			expect(cloudScore).toHaveBeenCalledTimes(2);
			for (const [, , options] of vi.mocked(t.runner.run).mock.calls)
				expect(options ?? {}).not.toHaveProperty("abortKillAfterMs");
			for (const [request] of cloudScore.mock.calls)
				expect(request.options).toMatchObject({
					measurementMethod: "FRAME_INDEX_BT709_10BIT",
					referenceFrameRate: "30/1",
					subsample: 1,
				});
			expect(
				t.results.map((r) => (r.provenance as Row).providerResult),
			).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ streamId: "s1" }),
					expect.objectContaining({ streamId: "s2" }),
				]),
			);
		});

		it("refuses generation6 Per-Title without a captured population before downloading or submitting", async () => {
			const cloudScore = vi.fn();
			const listKeys = vi.fn(async () => []);
			const t = setup({
				plan: perTitlePlan(),
				cloudScore,
				listKeys,
				job: {
					scoringVersion: 6,
					triggerKey: `lab-manual:${ENCODING_JOB_ID}:mirror`,
					params: {
						source: "QC_MIRROR",
						measurementMethod: "FRAME_INDEX_BT709_10BIT",
						execution: { backend: "CLOUD", profileId: "gcp", budgetUsd: 10 },
					},
				},
			});
			await expect(
				t.processor.process({ vmafJobId: VMAF_JOB_ID }),
			).rejects.toThrow("captured RESULT population");
			expect(t.downloaded).toHaveLength(0);
			expect(listKeys).not.toHaveBeenCalled();
			expect(cloudScore).not.toHaveBeenCalled();
		});

		it("scores exactly the rungs the CAPTURE step recorded — no bucket listing, no time window", async () => {
			const listKeys = vi.fn(async () => []);
			const t = setup({
				plan: perTitlePlan(),
				encodingJob: {
					stepLog: [
						outputStep(),
						{
							step: PER_TITLE_CAPTURE_STEP,
							kind: "CAPTURE_PER_TITLE_RESULTS",
							status: "DONE",
							response: {
								captured: true,
								snapshot: snapshot([
									rung("s1", "360p_500000_capA", true),
									rung("s2", "540p_900000_capB", true),
								]),
							},
						},
					],
				},
				listKeys,
			});
			const res = await t.processor.process({ vmafJobId: VMAF_JOB_ID });
			expect(res).toMatchObject({ status: "FINISHED", results: 2 });
			expect(listKeys).not.toHaveBeenCalled();
			const variants = t.results
				.map((r) => (r.renditionRef as Row).perTitleVariant)
				.sort();
			expect(variants).toEqual(["360p_500000_capA", "540p_900000_capB"]);
		});

		it("binds a reversed delivery-mirror snapshot leg to the exact target output used for download and provenance", async () => {
			const plan = perTitlePlan();
			plan.outputs = [
				{
					key: "mirror-b",
					kind: "S3",
					credentialId: MIRROR_OUTPUT_CRED,
					bucket: "mirror-bucket",
					name: "Mirror B",
				},
				{
					key: "primary-a",
					kind: "S3",
					credentialId: OUTPUT_CRED,
					bucket: "primary-a-bucket",
					name: "Primary A",
				},
			];
			plan.deliveryMirrors = [{ outputKey: "mirror-b" }];
			const muxing = (plan.muxings as unknown[] | undefined)?.[0] as
				| { destination?: { outputKey: string; path: string } }
				| undefined;
			if (!muxing?.destination) {
				throw new Error("per-title test plan has no muxing destination");
			}
			muxing.destination.outputKey = "primary-a";

			const captured = snapshot([
				{
					...rung("s1", "360p_500000_capA", true),
					muxings: [
						{
							muxingId: "s1-qc",
							muxingType: "MP4",
							filename: "vpt.mp4",
							outputs: [
								{
									outputId: "provider-output-b",
									outputPath: "out/pt/360p_500000_capA/qc/",
								},
								{
									outputId: "provider-output-a",
									outputPath: "out/pt/360p_500000_capA/qc/",
								},
							],
							drm: [],
						},
					],
				},
			]);
			const t = setup({
				plan,
				encodingJob: {
					stepLog: [
						{
							step: "output:mirror-b",
							status: "DONE",
							resourceId: "provider-output-b",
						},
						{
							step: "output:primary-a",
							status: "DONE",
							resourceId: "provider-output-a",
						},
						{
							step: PER_TITLE_CAPTURE_STEP,
							kind: "CAPTURE_PER_TITLE_RESULTS",
							status: "DONE",
							response: { captured: true, snapshot: captured },
						},
					],
				},
				listKeys: vi.fn(async () => []),
			});

			const res = await t.processor.process({ vmafJobId: VMAF_JOB_ID });

			expect(res).toMatchObject({ status: "FINISHED", results: 1 });
			expect(t.resolveCredential).toHaveBeenCalledWith(OUTPUT_CRED);
			expect(t.resolveCredential).not.toHaveBeenCalledWith(MIRROR_OUTPUT_CRED);
			expect(t.downloaded).toContainEqual(
				expect.objectContaining({
					bucket: "primary-a-bucket",
					key: "out/pt/360p_500000_capA/qc/vpt.mp4",
				}),
			);
			expect(t.results[0]?.provenance).toMatchObject({
				distorted: {
					bucket: "primary-a-bucket",
					key: "out/pt/360p_500000_capA/qc/vpt.mp4",
				},
				providerResult: {
					streamId: "s1",
					muxingId: "s1-qc",
					outputId: "provider-output-a",
					resolvedPath: "out/pt/360p_500000_capA/qc/",
				},
			});
		});

		it("fails closed when a current per-title snapshot has no DONE provider output identity for its target", async () => {
			const captured = snapshot([
				{
					...rung("s1", "360p_500000_capA", true),
					muxings: [
						{
							muxingId: "s1-qc",
							muxingType: "MP4",
							filename: "vpt.mp4",
							outputs: [
								{
									outputId: "provider-output-origin",
									outputPath: "out/pt/360p_500000_capA/qc/",
								},
							],
							drm: [],
						},
					],
				},
			]);
			const t = setup({
				plan: perTitlePlan(),
				encodingJob: {
					stepLog: [
						{
							step: PER_TITLE_CAPTURE_STEP,
							kind: "CAPTURE_PER_TITLE_RESULTS",
							status: "DONE",
							response: { captured: true, snapshot: captured },
						},
					],
				},
				listKeys: vi.fn(async () => []),
			});

			await expect(
				t.processor.process({ vmafJobId: VMAF_JOB_ID }),
			).rejects.toThrow(/DONE output:origin.*provider output identity/i);
			expect(t.results).toHaveLength(0);
			expect(t.downloaded).toHaveLength(0);
		});

		it("a captured rung with no mirror is UNMEASURED by name — the job finishes PARTIAL, the rung is not invisible", async () => {
			const t = setup({
				plan: perTitlePlan(),
				encodingJob: {
					stepLog: [outputStep()],
					snapshots: {
						perTitleResults: snapshot([
							rung("s1", "360p_500000_capA", true),
							rung("s2", "1080p_4000000_capC", false),
						]),
					},
				},
				listKeys: vi.fn(async () => []),
			});
			const res = await t.processor.process({ vmafJobId: VMAF_JOB_ID });
			expect(res).toMatchObject({ status: "FINISHED", results: 1 });
			const perTitle = (t.job.params as { perTitle?: unknown } | undefined)
				?.perTitle as
				| {
						population: string;
						unmeasured: { variant: string; reason: string }[];
				  }
				| undefined;
			expect(perTitle?.population).toBe("snapshot");
			expect(perTitle?.unmeasured.map((u) => u.variant)).toEqual([
				"1080p_4000000_capC",
			]);
			expect(perTitle?.unmeasured[0]?.reason).toMatch(/none is a QC mirror/);
		});

		// BLOCKER-6, partial half: a FINISHED row whose only signal was
		// `params.perTitle` read as a complete ladder on every screen that shows a
		// status and a result count. The shortfall now rides `error`, which the QC
		// lab and the report both render unconditionally.
		it("a PARTIAL per-title run says so in the job's error: N of M rungs unmeasured, each named", async () => {
			const t = setup({
				plan: perTitlePlan(),
				encodingJob: {
					stepLog: [outputStep()],
					snapshots: {
						perTitleResults: snapshot([
							rung("s1", "360p_500000_capA", true),
							rung("s2", "1080p_4000000_capC", false),
						]),
					},
				},
				listKeys: vi.fn(async () => []),
			});
			await t.processor.process({ vmafJobId: VMAF_JOB_ID });
			expect(t.job.status).toBe("FINISHED");
			expect(t.job.error).toMatch(
				/1 of 2 rung\(s\) unmeasured — this report is PARTIAL/,
			);
			// The rung and WHY, not just a count — the two reasons call for
			// different next moves and only this string separates them.
			expect(t.job.error).toMatch(
				/vpt\[1080p_4000000_capC\]: the captured rung has .* none is a QC mirror/,
			);
		});

		it("a gate plan holds the unmeasured rung to the bar: the verdict FAILS on it", async () => {
			const plan = perTitlePlan();
			plan.qc = {
				vmaf: true,
				model: "vmaf_v0.6.1",
				gate: {
					rules: [{ metric: "VMAF_MEAN", scope: "PER_RENDITION", gte: 80 }],
					onFail: "MARK_ONLY",
				},
			};
			const t = setup({
				plan,
				encodingJob: {
					stepLog: [outputStep()],
					snapshots: {
						perTitleResults: snapshot([
							rung("s1", "360p_500000_capA", true),
							rung("s2", "1080p_4000000_capC", false),
						]),
					},
				},
				listKeys: vi.fn(async () => []),
			});
			const res = await t.processor.process({ vmafJobId: VMAF_JOB_ID });
			expect(res.status).toBe("FINISHED");
			const verdict = t.job.gateVerdict as {
				pass: boolean;
				ruleResults: {
					actuals: { variant?: string; value: number | null; pass: boolean }[];
				}[];
			};
			expect(verdict.pass).toBe(false);
			expect(verdict.ruleResults[0]?.actuals).toContainEqual({
				rendition: "vpt",
				variant: "1080p_4000000_capC",
				value: null,
				pass: false,
			});
		});

		it("a fuller STEP capture beats a shorter manual snapshot — best evidence wins, the same rule as the detail view (review-329 I1)", async () => {
			// A manual "Capture now" that caught a partial scan (2 rungs) sits
			// beside the step's own complete 3-rung capture. The first cut let the
			// manual one win by parsing, so the third rung was never scored and
			// never reported missing.
			const listKeys = vi.fn(async () => []);
			const t = setup({
				plan: perTitlePlan(),
				encodingJob: {
					snapshots: {
						perTitleResults: {
							...snapshot([
								rung("s1", "360p_500000_capA", true),
								rung("s2", "540p_900000_capB", true),
							]),
							scan: {
								streamsListed: 2,
								templatesListed: 1,
								templatesDeclared: 1,
								resultsCaptured: 2,
								muxingsListed: 4,
								complete: false,
								codecConfigErrors: 1,
								unattributed: 0,
							},
						},
					},
					stepLog: [
						outputStep(),
						{
							step: PER_TITLE_CAPTURE_STEP,
							kind: "CAPTURE_PER_TITLE_RESULTS",
							status: "DONE",
							response: {
								captured: true,
								snapshot: snapshot([
									rung("s1", "360p_500000_capA", true),
									rung("s2", "540p_900000_capB", true),
									rung("s3", "1080p_4000000_capC", true),
								]),
							},
						},
					],
				},
				listKeys,
			});
			const res = await t.processor.process({ vmafJobId: VMAF_JOB_ID });
			expect(res).toMatchObject({ status: "FINISHED", results: 3 });
			expect(listKeys).not.toHaveBeenCalled();
		});

		/**
		 * BLOCKER-6. This test used to assert FINISHED with
		 * zero results and call that correct — the pin WAS the defect. A run that
		 * measured none of its population is a failed measurement, and the paid run
		 * `d62708cc` (FINISHED, totalUnits 0, doneUnits 0, results 0, unmeasured 7)
		 * is what a green pin over that shape produced in the real world.
		 */
		it("a rendition whose every captured rung lacks a mirror measures NOTHING — the job ends ERROR, every rung named", async () => {
			const t = setup({
				plan: perTitlePlan(),
				encodingJob: {
					stepLog: [outputStep()],
					snapshots: {
						perTitleResults: snapshot([
							rung("s1", "360p_500000_capA", false),
							rung("s2", "1080p_4000000_capC", false),
						]),
					},
				},
				listKeys: vi.fn(async () => []),
			});
			await expect(
				t.processor.process({ vmafJobId: VMAF_JOB_ID }),
			).rejects.toThrow(/scored 0 of 2 expected rendition unit\(s\)/);
			expect(t.job.status).toBe("ERROR");
			expect(t.job.error).toMatch(/360p_500000_capA/);
			expect(t.job.error).toMatch(/1080p_4000000_capC/);
			expect(t.job.error).toMatch(/none is a QC mirror/);
			// The named rungs stay in params too — the error is the alarm, the
			// column is the record.
			const perTitle = (
				t.job.params as { perTitle?: { unmeasured: { variant: string }[] } }
			)?.perTitle;
			expect(perTitle?.unmeasured.map((u) => u.variant).sort()).toEqual([
				"1080p_4000000_capC",
				"360p_500000_capA",
			]);
		});

		it("a RESULT nothing can place (attributed off-target) keeps the population > 0 and ERRORs — no false FINISHED 0/0", async () => {
			// The plan's one template (vpt) generated no matching RESULT — that is
			// "not generated", not a failure. But the
			// snapshot DID capture a RESULT, attributed to a rendition with no target
			// (vother). It EXISTS, so it must stay in the population as UNMEASURED,
			// and a run that measured none of it ERRORs — never a green 0/0.
			const t = setup({
				plan: perTitlePlan(),
				encodingJob: {
					stepLog: [outputStep()],
					snapshots: {
						perTitleResults: snapshot([
							{
								...rung("s-other", "360p_1_x", true),
								templateRendition: "vother",
							},
						]),
					},
				},
				listKeys: vi.fn(async () => []),
			});
			await expect(
				t.processor.process({ vmafJobId: VMAF_JOB_ID }),
			).rejects.toThrow(/scored 0 of 1 expected rendition unit\(s\)/);
			expect(t.job.status).toBe("ERROR");
			expect(t.job.error).toMatch(
				/vother\[s-other\]: this captured RESULT was attributed to a rendition with no VMAF target/,
			);
			const perTitle = (
				t.job.params as {
					perTitle?: {
						unmeasured: {
							rendition: string;
							variant: string;
							reason: string;
						}[];
						notGenerated: { rendition: string }[];
					};
				}
			)?.perTitle;
			// vpt is "not generated" — shown apart, never a synthetic failed rung.
			expect(perTitle?.notGenerated).toEqual([{ rendition: "vpt" }]);
			expect(perTitle?.unmeasured).toEqual([
				{
					rendition: "vother",
					variant: "s-other",
					reason:
						"this captured RESULT was attributed to a rendition with no VMAF target",
				},
			]);
		});

		it("without a captured ladder the listing remains the fallback, and the report says so", async () => {
			const listKeys = vi.fn(async () => [
				{
					key: "out/pt/360p_500000_listed/qc/vpt.mp4",
					lastModified: "2026-06-20T12:00:05.000Z",
				},
			]);
			const t = setup({
				plan: perTitlePlan(),
				encodingJob: { createdAt: new Date("2026-06-20T12:00:00.000Z") },
				listKeys,
			});
			const res = await t.processor.process({ vmafJobId: VMAF_JOB_ID });
			expect(res).toMatchObject({ status: "FINISHED", results: 1 });
			expect(listKeys).toHaveBeenCalled();
			const perTitle = (t.job.params as { perTitle?: { population: string } })
				?.perTitle;
			expect(perTitle?.population).toBe("listing");
		});
	});
});

/**
 * The fix: with filename attribution the
 * processor scores the RESULTs the provider actually generated, a template that
 * generated none is "not generated" (not a synthetic failed rung), and a RESULT
 * nothing could place still holds the whole-population line. Driven from
 * provider-shaped muxing rows through the REAL capture — no injected
 * `templateRendition`.
 */
describe("per-title population from filename attribution", () => {
	function multiPerTitlePlan(keys: string[]): Record<string, unknown> {
		const plan = qcPlan();
		plan.renditions = keys.map((key) => ({
			key,
			ingestKey: "video",
			codec: "H264",
			mode: "PER_TITLE_TEMPLATE",
			height: null,
			bitrate: null,
		}));
		plan.muxings = keys.map((key) => ({
			key: `m-${key}`,
			kind: "MP4",
			streamKey: key,
			filename: `${key}.mp4`,
			destination: {
				outputKey: "origin",
				path: `out/pt/${key}/{height}p_{bitrate}_{uuid}`,
			},
		}));
		return plan;
	}

	/** Build the capture snapshot the way the run would: SDK-shaped rows in. */
	async function captureSnapshot(
		resultStreams: ScannedStream[],
		muxings: ScannedMuxing[],
		templates: { rendition: string; codec: string }[],
	) {
		const capturePort: PerTitleCapturePort = {
			listStreams: vi.fn(() =>
				Promise.resolve({ items: resultStreams, complete: true }),
			),
			listMuxings: vi.fn(() =>
				Promise.resolve({ items: muxings, complete: true }),
			),
			getCodecConfig: vi.fn(() =>
				Promise.resolve({ codecType: "H264", params: {} }),
			),
		};
		return capturePerTitleResults(capturePort, {
			encodingId: "enc",
			capturedAt: "2026-08-30T00:00:00.000Z",
			templates,
		});
	}

	const resultStream = (key: string): ScannedStream => ({
		streamId: `s-${key}`,
		mode: PER_TITLE_RESULT_MODE,
		codecConfigId: "c",
	});
	const qcMuxing = (key: string, dir: string): ScannedMuxing => ({
		muxingId: `mux-${key}`,
		muxingType: "MP4",
		filename: `${key}.mp4`,
		name: `QC VMAF Mirror ${key}`,
		streamIds: [`s-${key}`],
		outputs: [
			{
				outputId: PROVIDER_OUTPUT_ID,
				outputPath: `out/pt/${key}/${dir}/qc/`,
			},
		],
		drm: [],
	});

	const stepLogWith = (snapshot: unknown) => [
		outputStep(),
		{
			step: PER_TITLE_CAPTURE_STEP,
			kind: "CAPTURE_PER_TITLE_RESULTS",
			status: "DONE",
			response: { captured: true, snapshot },
		},
	];

	it("scores every same-codec RESULT the provider built, and a template with none is 'not generated' — not a failure", async () => {
		// Two H264 templates generated a RESULT, a third (vc) did not — the exact
		// shape that made attribution abstain on all and report 0. No bucket listing.
		const listKeys = vi.fn(async () => []);
		const snapshot = await captureSnapshot(
			[resultStream("va"), resultStream("vb")],
			[qcMuxing("va", "360p_500000_aaa"), qcMuxing("vb", "540p_900000_bbb")],
			[
				{ rendition: "va", codec: "H264" },
				{ rendition: "vb", codec: "H264" },
				{ rendition: "vc", codec: "H264" },
			],
		);
		const t = setup({
			plan: multiPerTitlePlan(["va", "vb", "vc"]),
			encodingJob: { stepLog: stepLogWith(snapshot) },
			listKeys,
		});
		const res = await t.processor.process({ vmafJobId: VMAF_JOB_ID });

		expect(res).toMatchObject({ status: "FINISHED", results: 2 });
		expect(listKeys).not.toHaveBeenCalled();
		const perTitle = t.job.params as {
			perTitle?: {
				population: string;
				unmeasured: unknown[];
				notGenerated: { rendition: string }[];
			};
		};
		expect(perTitle.perTitle?.population).toBe("snapshot");
		// vc is separate, and NOT an unmeasured measurement failure.
		expect(perTitle.perTitle?.notGenerated).toEqual([{ rendition: "vc" }]);
		expect(perTitle.perTitle?.unmeasured).toEqual([]);
		// Each scored rung keyed by its resolved qc dir + exact filename.
		const keys = t.results
			.map((r) => (r.renditionRef as Row).renditionKey)
			.sort();
		expect(keys).toEqual(["va", "vb"]);
		const providerResults = Object.fromEntries(
			t.results.map((row) => [
				(row.renditionRef as Row).renditionKey,
				(row.provenance as Row).providerResult,
			]),
		);
		expect(providerResults).toEqual({
			va: {
				streamId: "s-va",
				muxingId: "mux-va",
				outputId: PROVIDER_OUTPUT_ID,
				resolvedPath: "out/pt/va/360p_500000_aaa/qc/",
			},
			vb: {
				streamId: "s-vb",
				muxingId: "mux-vb",
				outputId: PROVIDER_OUTPUT_ID,
				resolvedPath: "out/pt/vb/540p_900000_bbb/qc/",
			},
		});
	});

	it("an UNATTRIBUTED RESULT keeps expectedUnits > 0 — the run ERRORs, never a false FINISHED 0/0", async () => {
		// The whole-population guard: attribution abstains (a mirror filename that
		// matches no template, plus a same-codec ladder so codec-only also abstains).
		// The RESULT still exists, so the run must not FINISH green with 0 results.
		const snapshot = await captureSnapshot(
			[resultStream("vzz")],
			[qcMuxing("vzz", "360p_500000_zzz")],
			[
				{ rendition: "va", codec: "H264" },
				{ rendition: "vb", codec: "H264" },
			],
		);
		expect(snapshot.scan.unattributed).toBe(1);
		const t = setup({
			plan: multiPerTitlePlan(["va", "vb"]),
			encodingJob: { stepLog: stepLogWith(snapshot) },
			listKeys: vi.fn(async () => []),
		});
		await expect(
			t.processor.process({ vmafJobId: VMAF_JOB_ID }),
		).rejects.toThrow(/scored 0 of 1/);
		expect(t.job.status).toBe("ERROR");
		const perTitle = t.job.params as {
			perTitle?: {
				unmeasured: { rendition: string }[];
				notGenerated: { rendition: string }[];
			};
		};
		expect(perTitle.perTitle?.unmeasured).toEqual([
			expect.objectContaining({ rendition: "(unattributed)" }),
		]);
		expect(perTitle.perTitle?.notGenerated).toEqual([]);
	});

	it("an incomplete RESULT snapshot keeps its missing target unmeasured so a BLOCK gate cannot pass", async () => {
		const plan = multiPerTitlePlan(["va", "vb"]);
		plan.qc = {
			vmaf: true,
			gate: {
				rules: [{ metric: "VMAF_MEAN", scope: "PER_RENDITION", gte: 80 }],
				onFail: "BLOCK_MANIFESTS",
			},
		};
		const captured = await captureSnapshot(
			[resultStream("va")],
			[qcMuxing("va", "360p_500000_aaa")],
			[
				{ rendition: "va", codec: "H264" },
				{ rendition: "vb", codec: "H264" },
			],
		);
		const snapshot = {
			...captured,
			scan: { ...captured.scan, complete: false },
		};
		const t = setup({
			plan,
			encodingJob: { stepLog: stepLogWith(snapshot) },
			listKeys: vi.fn(async () => []),
		});

		const res = await t.processor.process({ vmafJobId: VMAF_JOB_ID });

		expect(res).toMatchObject({ status: "FINISHED", results: 1 });
		const verdict = t.job.gateVerdict as {
			pass: boolean;
			ruleResults: {
				actuals: { rendition: string; value: number | null; pass: boolean }[];
			}[];
		};
		expect(verdict.pass).toBe(false);
		expect(verdict.ruleResults[0]?.actuals).toContainEqual(
			expect.objectContaining({ rendition: "vb", value: null, pass: false }),
		);
		const perTitle = t.job.params as {
			perTitle?: {
				unmeasured: { rendition: string }[];
				notGenerated: { rendition: string }[];
			};
		};
		expect(perTitle.perTitle?.notGenerated).toEqual([]);
		expect(perTitle.perTitle?.unmeasured).toEqual(
			expect.arrayContaining([expect.objectContaining({ rendition: "vb" })]),
		);
		// The continuation carries a FAIL verdict to the parked-job boundary; it
		// cannot take the PASS/release path for this partial population.
		expect(t.queueAdds).toHaveLength(1);
	});

	it("an incomplete scan blocks the gate even when every declared target has a captured rung", async () => {
		const plan = multiPerTitlePlan(["va"]);
		plan.qc = {
			vmaf: true,
			gate: {
				rules: [{ metric: "VMAF_MEAN", scope: "PER_RENDITION", gte: 80 }],
				onFail: "BLOCK_MANIFESTS",
			},
		};
		const captured = await captureSnapshot(
			[resultStream("va")],
			[qcMuxing("va", "360p_500000_aaa")],
			[{ rendition: "va", codec: "H264" }],
		);
		const snapshot = {
			...captured,
			scan: { ...captured.scan, complete: false },
		};
		const t = setup({
			plan,
			encodingJob: { stepLog: stepLogWith(snapshot) },
			listKeys: vi.fn(async () => []),
		});

		await t.processor.process({ vmafJobId: VMAF_JOB_ID });

		expect((t.job.gateVerdict as { pass: boolean }).pass).toBe(false);
		const perTitle = t.job.params as {
			perTitle?: { unmeasured: { rendition: string }[] };
		};
		expect(perTitle.perTitle?.unmeasured).toEqual([
			expect.objectContaining({ rendition: "va" }),
		]);
		expect(t.queueAdds).toHaveLength(1);
	});

	it("a legacy attribution snapshot cannot drive a blocking QC decision", async () => {
		const plan = multiPerTitlePlan(["va"]);
		plan.qc = {
			vmaf: true,
			gate: {
				rules: [{ metric: "VMAF_MEAN", scope: "PER_RENDITION", gte: 80 }],
				onFail: "BLOCK_MANIFESTS",
			},
		};
		const captured = await captureSnapshot(
			[resultStream("va")],
			[qcMuxing("va", "360p_500000_aaa")],
			[{ rendition: "va", codec: "H264" }],
		);
		const snapshot = {
			...captured,
			attributionVersion: PER_TITLE_ATTRIBUTION_VERSION - 1,
		};
		const t = setup({
			plan,
			encodingJob: { stepLog: stepLogWith(snapshot) },
			listKeys: vi.fn(async () => []),
		});

		await expect(
			t.processor.process({ vmafJobId: VMAF_JOB_ID }),
		).rejects.toThrow(/legacy per-title RESULT snapshot/i);
		expect(t.job.status).toBe("ERROR");
		expect(t.job.gateVerdict).toBeUndefined();
		expect(t.queueAdds).toHaveLength(1);
	});

	it("a NOT-GENERATED template does not fail the gate as a synthetic failed rung", async () => {
		// A per-title QC GATE where two templates passed and a third (vc) generated
		// no RESULT. vc must NOT synthesize a failing gate actual (audit §5.4 item 4)
		// — the verdict passes on the rungs the provider actually built.
		const plan = multiPerTitlePlan(["va", "vb", "vc"]);
		plan.qc = {
			vmaf: true,
			gate: {
				rules: [{ metric: "VMAF_MEAN", scope: "PER_RENDITION", gte: 80 }],
				onFail: "MARK_ONLY",
			},
		};
		const snapshot = await captureSnapshot(
			[resultStream("va"), resultStream("vb")],
			[qcMuxing("va", "360p_500000_aaa"), qcMuxing("vb", "540p_900000_bbb")],
			[
				{ rendition: "va", codec: "H264" },
				{ rendition: "vb", codec: "H264" },
				{ rendition: "vc", codec: "H264" },
			],
		);
		const t = setup({
			plan,
			encodingJob: { stepLog: stepLogWith(snapshot) },
			listKeys: vi.fn(async () => []),
		});
		const res = await t.processor.process({ vmafJobId: VMAF_JOB_ID });
		expect(res.status).toBe("FINISHED");
		const verdict = t.job.gateVerdict as {
			pass: boolean;
			ruleResults: { actuals: { rendition: string }[] }[];
		};
		// Frame scores default ~95 → va, vb pass gte 80; vc is not a target.
		expect(verdict.pass).toBe(true);
		expect(
			verdict.ruleResults[0]?.actuals.map((a) => a.rendition).sort(),
		).toEqual(["va", "vb"]);
	});
});

/**
 * QC gate verdict + continuation : the
 * runner is where measurement becomes verdict. FINISHED writes gateVerdict +
 * the denormalized EncodingJob.qcVerdict atomically; MARK_ONLY notifies its
 * own failures; BLOCK_MANIFESTS wakes the parked job via the continuation —
 * on ERROR too, because a parked job with a dead measurement must still exit.
 */
describe("QC gate verdict", () => {
	function gatePlan(
		onFail: "MARK_ONLY" | "BLOCK_MANIFESTS",
		gte: number,
	): Record<string, unknown> {
		const plan = qcPlan();
		plan.qc = {
			vmaf: true,
			gate: {
				rules: [{ metric: "VMAF_MEAN", scope: "PER_RENDITION", gte }],
				onFail,
			},
		};
		return plan;
	}
	// Per-measurement id (review-201 I2): a fixed id fires once, ever.
	const CONTINUATION_ID = `${ENCODING_JOB_ID}-resume-post-qc-${VMAF_JOB_ID}`;

	for (const onFail of ["MARK_ONLY", "BLOCK_MANIFESTS"] as const) {
		for (const triggerKey of [
			`lab-manual:${ENCODING_JOB_ID}:rerun`,
			null,
			"vod-auto:another-encoding",
		]) {
			it(`${onFail}: non-AUTO ${triggerKey} scores without changing the original QC decision`, async () => {
				const t = setup({
					plan: gatePlan(onFail, 99.5),
					job: { triggerKey },
				});
				const res = await t.processor.process({ vmafJobId: VMAF_JOB_ID });
				expect(res.status).toBe("FINISHED");
				expect(t.results).toHaveLength(2);
				expect(t.job.gateVerdict).toBeUndefined();
				expect(t.encodingJobWrites).toEqual([]);
				expect(t.queueAdds).toEqual([]);
				expect(t.emitted.map((e) => e.kind)).not.toContain("JOB_QC_FAILED");
				expect(t.emitted.map((e) => e.kind)).toContain("VMAF_FINISHED");
			});
		}
	}

	it("manual scoring ERROR does not wake the original blocking gate", async () => {
		const t = setup({
			plan: gatePlan("BLOCK_MANIFESTS", 80),
			job: { triggerKey: `lab-manual:${ENCODING_JOB_ID}:rerun` },
			ffmpegExit: 1,
		});
		await expect(
			t.processor.process({ vmafJobId: VMAF_JOB_ID }),
		).rejects.toThrow();
		expect(t.job.status).toBe("ERROR");
		expect(t.encodingJobWrites).toEqual([]);
		expect(t.queueAdds).toEqual([]);
		expect(t.emitted.map((e) => e.kind)).toContain("VMAF_ERROR");
	});

	for (const status of ["FINISHED", "ERROR"] as const) {
		it(`manual ${status} redelivery never creates a gate continuation`, async () => {
			const t = setup({
				plan: gatePlan("BLOCK_MANIFESTS", 80),
				job: { triggerKey: `lab-manual:${ENCODING_JOB_ID}:rerun`, status },
			});
			const res = await t.processor.process({ vmafJobId: VMAF_JOB_ID });
			expect(res.status).toBe(status);
			expect(t.results).toEqual([]);
			expect(t.encodingJobWrites).toEqual([]);
			expect(t.queueAdds).toEqual([]);
		});
	}

	it("MARK_ONLY pass: verdict lands on BOTH rows, no wake, no event", async () => {
		// frameScores default to a ~95 mean; gte 80 passes.
		const t = setup({ plan: gatePlan("MARK_ONLY", 80) });
		const res = await t.processor.process({ vmafJobId: VMAF_JOB_ID });
		expect(res.status).toBe("FINISHED");
		const verdict = t.job.gateVerdict as {
			pass: boolean;
			ruleResults: { actuals: { rendition: string }[] }[];
		};
		expect(verdict.pass).toBe(true);
		// One actual per persisted VmafResult — the verdict reads the SAME rows
		// the run created (both video renditions of the qc plan).
		expect(verdict.ruleResults[0]?.actuals.map((a) => a.rendition)).toEqual([
			"v360",
			"v540",
		]);
		// Denormalized copy for the jobs list.
		expect(t.encodingJobWrites).toHaveLength(1);
		expect((t.encodingJobWrites[0]?.qcVerdict as { pass: boolean }).pass).toBe(
			true,
		);
		// Status + verdict + denormalized copy in ONE transaction: the
		// boundary's fail-closed reading (FINISHED-without-verdict refuses)
		// only holds if a torn write is impossible.
		expect(t.$transaction).toHaveBeenCalledTimes(1);
		// MARK_ONLY: nothing is parked, nothing is woken, nothing failed.
		expect(t.queueAdds).toHaveLength(0);
		expect(t.emitted.map((e) => e.kind)).not.toContain("JOB_QC_FAILED");
		expect(t.emitted.map((e) => e.kind)).toContain("VMAF_FINISHED");
	});

	it("MARK_ONLY fail: the runner itself emits JOB_QC_FAILED with the rule count", async () => {
		const t = setup({ plan: gatePlan("MARK_ONLY", 99.5) });
		const res = await t.processor.process({ vmafJobId: VMAF_JOB_ID });
		expect(res.status).toBe("FINISHED");
		expect((t.job.gateVerdict as { pass: boolean }).pass).toBe(false);
		const event = t.emitted.find((e) => e.kind === "JOB_QC_FAILED");
		expect(event).toMatchObject({
			jobId: ENCODING_JOB_ID,
			name: "vmaf-test-job",
			labels: ["qc"],
			reason: "QC gate failed: 1 of 1 rule(s) below threshold",
		});
		expect(t.queueAdds).toHaveLength(0);
	});

	it("BLOCK pass: the continuation is enqueued (dash id) and the runner emits NO gate event", async () => {
		const t = setup({ plan: gatePlan("BLOCK_MANIFESTS", 80) });
		await t.processor.process({ vmafJobId: VMAF_JOB_ID });
		expect(t.queueAdds).toHaveLength(1);
		expect(t.queueAdds[0]).toMatchObject({
			name: "orchestrate",
			data: { encodingJobId: ENCODING_JOB_ID },
			opts: { jobId: CONTINUATION_ID },
		});
		expect(t.queueAdds[0]?.opts.jobId).not.toContain(":");
		expect(t.emitted.map((e) => e.kind)).not.toContain("JOB_QC_FAILED");
	});

	it("BLOCK fail: still ONLY the continuation — the orchestrator owns the transition", async () => {
		const t = setup({ plan: gatePlan("BLOCK_MANIFESTS", 99.5) });
		await t.processor.process({ vmafJobId: VMAF_JOB_ID });
		expect((t.job.gateVerdict as { pass: boolean }).pass).toBe(false);
		expect(t.queueAdds).toHaveLength(1);
		expect(t.emitted.map((e) => e.kind)).not.toContain("JOB_QC_FAILED");
	});

	it("BLOCK + scoring ERROR: no verdict, but the wake still fires", async () => {
		const t = setup({ plan: gatePlan("BLOCK_MANIFESTS", 80), ffmpegExit: 1 });
		await expect(
			t.processor.process({ vmafJobId: VMAF_JOB_ID }),
		).rejects.toThrow();
		expect(t.job.status).toBe("ERROR");
		expect(t.job.gateVerdict).toBeUndefined();
		expect(t.encodingJobWrites).toHaveLength(0);
		// The parked job must still exit — the boundary maps ERROR to
		// QC_FAILED ("measurement failed", design §6).
		expect(t.queueAdds).toHaveLength(1);
	});

	it("MARK_ONLY + scoring ERROR: no verdict, no wake (nothing is parked)", async () => {
		const t = setup({ plan: gatePlan("MARK_ONLY", 80), ffmpegExit: 1 });
		await expect(
			t.processor.process({ vmafJobId: VMAF_JOB_ID }),
		).rejects.toThrow();
		expect(t.queueAdds).toHaveLength(0);
	});

	it("no gate: no verdict writes, no transaction, no wake — byte-identical behavior", async () => {
		const t = setup();
		await t.processor.process({ vmafJobId: VMAF_JOB_ID });
		expect(t.job.gateVerdict).toBeUndefined();
		expect(t.encodingJobWrites).toHaveLength(0);
		expect(t.queueAdds).toHaveLength(0);
	});

	it.each([
		false,
		true,
	])("cloud ERROR redelivery repairs only a missing gate continuation (already queued=%s)", async (alreadyQueued) => {
		const cloudScore = vi.fn();
		const t = setup({
			plan: gatePlan("BLOCK_MANIFESTS", 80),
			cloudScore,
			job: {
				status: "ERROR",
				error: "Cloud task failed",
				params: {
					execution: { backend: "CLOUD", profileId: "gcp", budgetUsd: 10 },
				},
			},
		});
		if (alreadyQueued)
			await t.orchestratorQueue.add(
				"orchestrate",
				{ encodingJobId: ENCODING_JOB_ID },
				{ jobId: CONTINUATION_ID, removeOnComplete: 1000, removeOnFail: 1000 },
			);
		expect(await t.processor.process({ vmafJobId: VMAF_JOB_ID })).toMatchObject(
			{ status: "ERROR", results: 0 },
		);
		expect(t.orchestratorQueue.getJob).toHaveBeenCalledWith(CONTINUATION_ID);
		expect(t.queueAdds).toHaveLength(1);
		expect(t.queueAdds[0]?.opts.jobId).toBe(CONTINUATION_ID);
		expect(t.job).toMatchObject({
			status: "ERROR",
			error: "Cloud task failed",
		});
		expect(cloudScore).not.toHaveBeenCalled();
		expect(t.runner.run).not.toHaveBeenCalled();
		expect(t.downloaded).toEqual([]);
	});

	it("canceled cloud reports remain terminal and never restart scoring", async () => {
		const cloudScore = vi.fn();
		const t = setup({
			cloudScore,
			job: {
				status: "ERROR",
				error: "Canceled",
				triggerKey: `lab-manual:${ENCODING_JOB_ID}:canceled`,
				params: {
					execution: { backend: "CLOUD", profileId: "gcp", budgetUsd: 10 },
				},
			},
		});
		expect(await t.processor.process({ vmafJobId: VMAF_JOB_ID })).toMatchObject(
			{ status: "ERROR", results: 0 },
		);
		expect(t.queueAdds).toEqual([]);
		expect(cloudScore).not.toHaveBeenCalled();
		expect(t.runner.run).not.toHaveBeenCalled();
		expect(t.job).toMatchObject({ status: "ERROR", error: "Canceled" });
	});

	it("claim-failed self-heal: a stalled redelivery re-adds a LOST continuation", async () => {
		// Terminal row (FINISHED) → the PENDING claim fails; the queue holds no
		// continuation (the crash window) → the redelivery adds it.
		const t = setup({
			plan: gatePlan("BLOCK_MANIFESTS", 80),
			job: { status: "FINISHED" },
		});
		const res = await t.processor.process({ vmafJobId: VMAF_JOB_ID });
		expect(res.status).toBe("FINISHED");
		expect(res.results).toBe(0);
		expect(t.queueAdds).toHaveLength(1);
		expect(t.queueAdds[0]?.opts.jobId).toBe(CONTINUATION_ID);
	});

	it("claim-failed self-heal is a no-op when the continuation already landed", async () => {
		const t = setup({
			plan: gatePlan("BLOCK_MANIFESTS", 80),
			job: { status: "FINISHED" },
		});
		// Seed the queue with the continuation (getJob answers from adds).
		await t.orchestratorQueue.add(
			"orchestrate",
			{ encodingJobId: ENCODING_JOB_ID },
			{ jobId: CONTINUATION_ID, removeOnComplete: 1000, removeOnFail: 1000 },
		);
		await t.processor.process({ vmafJobId: VMAF_JOB_ID });
		// Only the seed — the self-heal probed getJob and declined.
		expect(t.queueAdds).toHaveLength(1);
	});

	it("a continuation enqueue failure NEVER flips a green measurement to ERROR", async () => {
		const t = setup({ plan: gatePlan("BLOCK_MANIFESTS", 80) });
		t.orchestratorQueue.add.mockRejectedValueOnce(new Error("redis gone"));
		const res = await t.processor.process({ vmafJobId: VMAF_JOB_ID });
		expect(res.status).toBe("FINISHED");
		expect(t.job.status).toBe("FINISHED");
		expect((t.job.gateVerdict as { pass: boolean }).pass).toBe(true);
	});
});

/**
 * review-201 C2 + I3 folds, measured at the RUNNER (the integration end of
 * the pure-function fix): the verdict's default population is the PLAN's
 * video renditions, and the denormalized copy tolerates a deleted parent.
 */
describe("QC gate verdict — review-201 folds", () => {
	function gatePlanAllRenditions(gte: number): Record<string, unknown> {
		const plan = qcPlan();
		plan.qc = {
			vmaf: true,
			model: "vmaf_v0.6.1",
			gate: {
				// renditions ABSENT — the default-population shape C2 proved
				// fail-open. qcPlan has v360+v540 video; the listKeys below
				// erase v540's mirror so only v360 is measured.
				rules: [{ metric: "VMAF_MEAN", scope: "OVERALL", gte }],
				onFail: "MARK_ONLY",
			},
		};
		return plan;
	}

	it("an unmeasured video rendition FAILS a default-population rule (C2)", async () => {
		// v720 is a VIDEO rendition with NO muxing: resolveMirrorBase finds no
		// destination, enumerateQcTargets silently skips it, the run persists
		// two results and still FINISHES — the exact silent-skip reachability
		// review-201 proved. The verdict must fail with a null actual naming
		// v720, not pass on what happened to score.
		const planWithSkipped = gatePlanAllRenditions(80);
		(planWithSkipped.renditions as Record<string, unknown>[]).push({
			key: "v720",
			ingestKey: "video",
			codec: "H264",
			height: 720,
			bitrate: 900000,
		});
		const t = setup({ plan: planWithSkipped });
		const res = await t.processor.process({ vmafJobId: VMAF_JOB_ID });
		expect(res.status).toBe("FINISHED");
		const verdict = t.job.gateVerdict as {
			pass: boolean;
			ruleResults: {
				actuals: { rendition: string; value: number | null; pass: boolean }[];
			}[];
		};
		expect(verdict.pass).toBe(false);
		expect(verdict.ruleResults[0]?.actuals).toContainEqual({
			rendition: "v720",
			value: null,
			pass: false,
		});
		// And the failure notifies (MARK_ONLY's own emit path).
		expect(t.emitted.map((e) => e.kind)).toContain("JOB_QC_FAILED");
	});

	it("a DELETED encoding row cannot roll back the measurement (I3)", async () => {
		const t = setup({
			plan: gatePlanAllRenditions(80),
			missingEncodingRow: true,
		});
		const res = await t.processor.process({ vmafJobId: VMAF_JOB_ID });
		// The measurement's own terminal write survives the missing parent.
		expect(res.status).toBe("FINISHED");
		expect(t.job.status).toBe("FINISHED");
		expect(t.job.gateVerdict).toBeDefined();
		expect(t.encodingJobWrites).toHaveLength(0);
	});
});

/**
 * The RESOLVER's kind routing.
 *
 * The rule now lives in core (`vmafSourceFor`) and is unit-tested there. These
 * two arms exist because that is not the same thing as the CALL SITE being
 * pinned: reverting `resolveInputSource`/`resolveOutputSource` to the old
 * `kind === "S3" || kind === "AZURE"` allowlist left every core test green,
 * which is how the gap survived in the first place. They drive the real
 * processor over a real plan.
 */
describe("VMAF download resolution routes every streamable kind", () => {
	function planWith(kind: string): Record<string, unknown> {
		const plan = qcPlan();
		const inputs = plan.inputs as Record<string, unknown>[];
		const outputs = plan.outputs as Record<string, unknown>[];
		inputs[0] = { ...inputs[0], kind };
		outputs[0] = { ...outputs[0], kind };
		return plan;
	}

	// Akamai Object Storage is GENERIC_S3 with V4 signing (C10) — the shape the
	// audit ran, and the one that billed an encode before failing here.
	it.each([
		"GENERIC_S3",
		"GCS",
		"GCS_SERVICE_ACCOUNT",
	])("scores a %s plan instead of refusing it after the encode is billed", async (kind) => {
		const t = setup({ plan: planWith(kind) });
		const res = await t.processor.process({ vmafJobId: VMAF_JOB_ID });
		expect(res).toMatchObject({ status: "FINISHED", results: 2 });
		expect(t.job.error).toBeNull();
		// It really went to that bucket, rather than silently skipping.
		expect(t.downloaded.map((d) => d.bucket)).toContain("src-bucket");
		expect(t.downloaded.map((d) => d.bucket)).toContain("out-bucket");
	});

	it("still refuses a kind nothing can GET, and says which and why", async () => {
		const plan = qcPlan();
		const outputs = plan.outputs as Record<string, unknown>[];
		// SFTP carries no bucket at all, so the whole member changes shape.
		outputs[0] = {
			key: outputs[0]?.key,
			kind: "SFTP",
			credentialId: outputs[0]?.credentialId,
			name: "Out",
		};
		const t = setup({ plan });
		// It THROWS rather than recording — the retry ladder above this turns it
		// into the job's ERROR. Asserted as the throw it actually is, after a
		// first cut of this test asserted a `job.error` write that never happens.
		await expect(
			t.processor.process({ vmafJobId: VMAF_JOB_ID }),
		).rejects.toThrow(/output "origin".*encoding output only/s);
	});
});

describe("every result row records WHICH bytes it compared (ledger #199 slice 2)", () => {
	it("a job with TWO reference sources records each rendition's OWN reference (review-332 S1)", async () => {
		// The reference cache is keyed by input key + path; nothing before this
		// arm ever had two distinct keys in one job, so "the right reference per
		// row" was sound by inspection only.
		const plan = qcPlan();
		(plan.inputs as Record<string, unknown>[]).push({
			key: "second",
			kind: "S3",
			credentialId: INPUT_CRED,
			bucket: "src-bucket",
			name: "Src 2",
		});
		(plan.ingest as Record<string, unknown>[]).push({
			key: "video2",
			inputKey: "second",
			inputPath: "src/other.mkv",
			selectionMode: "VIDEO_RELATIVE",
			position: 0,
		});
		const v540 = (plan.renditions as Record<string, unknown>[]).find(
			(r) => r.key === "v540",
		);
		if (!v540) {
			throw new Error("fixture lost v540");
		}
		v540.ingestKey = "video2";
		const t = setup({ plan });
		await t.processor.process({ vmafJobId: VMAF_JOB_ID });
		const byRendition = new Map(
			t.results.map((r) => [
				(r.renditionRef as { renditionKey: string }).renditionKey,
				(r.provenance as { reference: { key: string; sha256: string } })
					.reference,
			]),
		);
		expect(byRendition.get("v360")).toEqual({
			bucket: "src-bucket",
			key: "src/master.mkv",
			identity: expect.objectContaining({ etag: '"etag-src/master.mkv"' }),
			pinned: true,
			sha256: "sha256-of-src/master.mkv",
			bytes: expect.any(Number),
		});
		expect(byRendition.get("v540")).toEqual({
			bucket: "src-bucket",
			key: "src/other.mkv",
			identity: expect.objectContaining({ etag: '"etag-src/other.mkv"' }),
			pinned: true,
			sha256: "sha256-of-src/other.mkv",
			bytes: expect.any(Number),
		});
	});

	it("carries both sides' bucket/key, version identity and digest", async () => {
		const t = setup();
		await t.processor.process({ vmafJobId: VMAF_JOB_ID });
		expect(t.results.length).toBeGreaterThan(0);
		for (const r of t.results) {
			const provenance = r.provenance as {
				reference: {
					bucket: string;
					key: string;
					pinned: boolean;
					sha256: string;
					identity?: { etag?: string };
				};
				distorted: {
					bucket: string;
					key: string;
					pinned: boolean;
					sha256: string;
				};
			};
			// The reference side is the plan's ingest source — a key the fake
			// downloader fetched, and never the mirror.
			expect(t.downloaded.map((d) => d.key)).toContain(
				provenance.reference.key,
			);
			expect(provenance.reference.key).not.toBe(provenance.distorted.key);
			expect(provenance.reference.sha256).toBe(
				`sha256-of-${provenance.reference.key}`,
			);
			expect(provenance.reference.pinned).toBe(true);
			expect(provenance.reference.identity?.etag).toBe(
				`"etag-${provenance.reference.key}"`,
			);
			// The distorted side is the mirror this row scored — the work item's key.
			const ref = r.renditionRef as { renditionKey: string };
			expect(provenance.distorted.key).toContain(`qc/${ref.renditionKey}.`);
			expect(provenance.distorted.sha256).toBe(
				`sha256-of-${provenance.distorted.key}`,
			);
			expect(t.downloaded.map((d) => d.key)).toContain(
				provenance.distorted.key,
			);
		}
	});
});

describe("cloud scoring integration", () => {
	it("starts every selected cloud pair concurrently beyond the local concurrency limit", async () => {
		const plan = qcPlan();
		for (let index = 0; index < 4; index += 1) {
			(plan.renditions as Row[]).push({
				key: `extra${index}`,
				ingestKey: "video",
				codec: "H264",
				height: 720,
				bitrate: 1_200_000,
			});
			(plan.muxings as Row[]).push({
				key: `extra${index}`,
				kind: "MP4",
				streamKey: `extra${index}`,
				filename: `extra${index}.mp4`,
				destination: { outputKey: "origin", path: `out/extra${index}` },
			});
		}
		let release = () => {};
		const barrier = new Promise<void>((resolve) => {
			release = resolve;
		});
		const cloudScore = vi.fn(async (request) => {
			await barrier;
			await writeFile(
				request.options.logPath,
				JSON.stringify({ frames: [{ frameNum: 0, metrics: { vmaf: 96 } }] }),
			);
		});
		const t = setup({
			plan,
			concurrency: 1,
			cores: 24,
			threads: 12,
			cloudScore,
			job: {
				params: {
					execution: { backend: "CLOUD", profileId: "gcp", budgetUsd: 100 },
				},
			},
		});
		const processing = t.processor.process({ vmafJobId: VMAF_JOB_ID });
		try {
			await vi.waitFor(() => expect(cloudScore).toHaveBeenCalledTimes(6), {
				timeout: 1000,
			});
		} finally {
			release();
			await processing;
		}
		expect(t.job.concurrency).toBe(6);
		expect(t.job.cores).toBeNull();
		expect(t.job.threads).toBeNull();
		expect(t.job.params).toMatchObject({
			automaticCompute: true,
			pairCount: 6,
		});
		expect(
			cloudScore.mock.calls.every(([request]) => request.pairCount === 6),
		).toBe(true);
		expect(t.results).toHaveLength(6);
	});
	it("routes explicitly selected cloud scoring through the adapter and keeps result persistence", async () => {
		const cloudScore = vi.fn(async (request) => {
			await writeFile(
				request.options.logPath,
				JSON.stringify({ frames: [{ frameNum: 0, metrics: { vmaf: 96 } }] }),
			);
		});
		const t = setup({
			job: {
				params: {
					execution: { backend: "CLOUD", profileId: "gcp", budgetUsd: 10 },
				},
			},
			cloudScore,
		});
		const res = await t.processor.process({ vmafJobId: VMAF_JOB_ID });
		expect(res).toMatchObject({ status: "FINISHED", results: 2 });
		expect(cloudScore).toHaveBeenCalledTimes(2);
		expect(cloudScore.mock.calls[0]?.[0]).toMatchObject({
			profileId: "gcp",
			budgetUsd: 10,
		});
		expect(t.filterComplexArgs).toHaveLength(0);
		for (const [, , options] of vi.mocked(t.runner.run).mock.calls)
			expect(options ?? {}).not.toHaveProperty("abortKillAfterMs");
	});
	it("does not silently fall back to local when selected cloud is unavailable", async () => {
		const t = setup({
			job: {
				params: {
					execution: { backend: "CLOUD", profileId: "gcp", budgetUsd: 10 },
				},
			},
		});
		await expect(
			t.processor.process({ vmafJobId: VMAF_JOB_ID }),
		).rejects.toThrow("Cloud VMAF is not configured");
		expect(t.job.status).toBe("ERROR");
		expect(t.filterComplexArgs).toHaveLength(0);
	});
});

it("periodic cloud stop aborts in-flight scoring and preserves cancellation", async () => {
	let started = () => {};
	const scoringStarted = new Promise<void>((resolve) => {
		started = resolve;
	});
	const cloudScore: NonNullable<VmafProcessorDeps["cloudScore"]> = async (
		request,
	) => {
		started();
		await new Promise<void>((_resolve, reject) => {
			request.signal?.addEventListener(
				"abort",
				() => reject(request.signal?.reason),
				{ once: true },
			);
		});
	};
	const t = setup({
		cloudScore,
		job: {
			params: {
				execution: { backend: "CLOUD", profileId: "gcp", budgetUsd: 10 },
			},
		},
	});
	const processing = t.processor.process({ vmafJobId: VMAF_JOB_ID });
	await scoringStarted;
	t.job.status = "ERROR";
	t.job.error = "Canceled";
	expect(await processing).toMatchObject({ status: "ERROR", results: 0 });
	expect(t.job).toMatchObject({ status: "ERROR", error: "Canceled" });
	expect(t.results).toEqual([]);
	expect(t.emitted.some((event) => event.kind === "VMAF_FINISHED")).toBe(false);
});

it("a late cloud result cannot overwrite user cancellation with FINISHED", async () => {
	let cancel = () => {};
	const cloudScore: NonNullable<VmafProcessorDeps["cloudScore"]> = async (
		request,
	) => {
		cancel();
		await writeFile(
			request.options.logPath,
			JSON.stringify({ frames: [{ frameNum: 0, metrics: { vmaf: 96 } }] }),
		);
	};
	const t = setup({
		job: {
			params: {
				execution: { backend: "CLOUD", profileId: "gcp", budgetUsd: 10 },
			},
		},
		cloudScore,
	});
	cancel = () => {
		t.job.status = "ERROR";
		t.job.error = "Canceled";
	};
	await expect(t.processor.process({ vmafJobId: VMAF_JOB_ID })).rejects.toThrow(
		"terminal status changed",
	);
	expect(t.job).toMatchObject({ status: "ERROR", error: "Canceled" });
	expect(t.emitted.some((e) => e.kind === "VMAF_FINISHED")).toBe(false);
});

it.each([
	false,
	true,
])("pins one profile for all report targets (already pinned=%s)", async (pinned) => {
	const profile = {
		id: "gcp",
		label: "GCP",
		provider: "GCP_BATCH" as const,
		region: "europe-west1",
		project: "test",
		machineType: "c3-standard-4",
		serviceAccount: "worker@example.com",
		image: `worker@sha256:${"a".repeat(64)}`,
		cpu: 4,
		memoryMiB: 8192,
		diskGiB: 100,
		maxParallel: 2,
		timeoutSeconds: 3600,
		queueTimeoutSeconds: 600,
		maxCostUsdPerHour: 2,
		transferUsdPerGiB: 0.1,
		overheadUsd: 0.5,
		maxStagingGiB: 80,
		staging: { provider: "GCS" as const, bucket: "private" },
		spot: true,
		profileVersion: 7,
		computeCredentialId: "11111111-1111-4111-8111-111111111111",
	};
	const resolveCloudProfile = vi.fn(async () => profile);
	const cloudScore = vi.fn(async (request) => {
		await writeFile(
			request.options.logPath,
			JSON.stringify({ frames: [{ frameNum: 0, metrics: { vmaf: 96 } }] }),
		);
	});
	const t = setup({
		job: {
			params: {
				execution: { backend: "CLOUD", profileId: "gcp", budgetUsd: 10 },
				...(pinned ? { executionProfile: profile } : {}),
			},
		},
		cloudScore,
		resolveCloudProfile,
	});
	expect(await t.processor.process({ vmafJobId: VMAF_JOB_ID })).toMatchObject({
		status: "FINISHED",
		results: 2,
	});
	expect(resolveCloudProfile).toHaveBeenCalledTimes(pinned ? 0 : 1);
	expect(cloudScore).toHaveBeenCalledTimes(2);
	for (const [request] of cloudScore.mock.calls)
		expect(request.profile).toEqual(profile);
	expect((t.job.params as Record<string, unknown>).executionProfile).toEqual(
		profile,
	);
});

it.each([
	"4:3",
	"1:1",
	"4:4",
	undefined,
	"N/A",
	"0:1",
	"-1:1",
])("frame-index reference SAR %s preserves coded metadata and selects the display or legacy canvas", async (sar) => {
	const plan = qcPlan();
	delete plan.qc;
	const codedWidth = sar === "4:3" ? 1440 : 1920;
	const cloudScore = vi.fn(async (request) => {
		await writeFile(request.options.logPath, vmafJson([96, 97]));
	});
	const t = setup({
		plan,
		cloudScore,
		probeJson: JSON.stringify({
			streams: [
				{
					codec_type: "video",
					width: codedWidth,
					height: 1080,
					r_frame_rate: "25/1",
					avg_frame_rate: "25/1",
					pix_fmt: "yuv420p",
					sample_aspect_ratio: sar,
				},
			],
		}),
		job: {
			scoringVersion: 6,
			triggerKey: `lab-manual:${ENCODING_JOB_ID}:output`,
			params: {
				source: "OUTPUT_MP4",
				measurementMethod: "FRAME_INDEX_BT709_10BIT",
				execution: { backend: "CLOUD", profileId: "gcp", budgetUsd: 10 },
			},
		},
	});
	if (sar === "-1:1") {
		await expect(
			t.processor.process({ vmafJobId: VMAF_JOB_ID }),
		).rejects.toThrow("INVALID_SAMPLE_ASPECT_RATIO");
		expect(cloudScore).not.toHaveBeenCalled();
		return;
	}
	expect(await t.processor.process({ vmafJobId: VMAF_JOB_ID })).toMatchObject({
		status: "FINISHED",
		results: 2,
	});
	const known = sar === "4:3" || sar === "1:1" || sar === "4:4";
	for (const [request] of cloudScore.mock.calls) {
		expect(request.options.scaleToReference).toEqual({
			width: 1920,
			height: 1080,
		});
		if (sar === "4:3")
			expect(request.options.referenceGeometry).toEqual({
				width: codedWidth,
				height: 1080,
				sampleAspectRatio: sar,
			});
		// This option is copied into manifest.scoring. Old generation-6 images
		// reject the new field even when its geometry is equivalent to 1:1.
		else expect(request.options).not.toHaveProperty("referenceGeometry");
	}
	expect((t.job.params as Row).reference).toMatchObject({
		width: 1920,
		height: 1080,
		codedWidth,
		codedHeight: 1080,
		sampleAspectRatioPolicy: known ? "reported" : "legacy-square-pixel",
		...(known ? { sampleAspectRatio: sar === "4:4" ? "1:1" : sar } : {}),
	});
});

it("refuses fresh generation-5 frame-index launches without rewriting historical results", async () => {
	const plan = qcPlan();
	delete plan.qc;
	const cloudScore = vi.fn();
	const t = setup({
		plan,
		cloudScore,
		job: {
			scoringVersion: 5,
			triggerKey: `lab-manual:${ENCODING_JOB_ID}:output`,
			params: {
				source: "OUTPUT_MP4",
				measurementMethod: "FRAME_INDEX_BT709_10BIT",
				execution: { backend: "CLOUD", profileId: "gcp", budgetUsd: 10 },
			},
		},
	});
	await expect(t.processor.process({ vmafJobId: VMAF_JOB_ID })).rejects.toThrow(
		"generation changed",
	);
	expect(cloudScore).not.toHaveBeenCalled();
	expect(t.job.scoringVersion).toBe(5);
	expect(t.downloaded).toHaveLength(0);
});

it.each([
	"transformed",
	"automatic",
])("refuses %s QC mirrors for generation6 before paid submit", async (scenario) => {
	const plan = qcPlan();
	if (scenario === "transformed")
		plan.trimmingStreams = [
			{ key: "trim", kind: "TIME_BASED", sourceKey: "video", offset: 1 },
		];
	const cloudScore = vi.fn();
	const t = setup({
		plan,
		cloudScore,
		job: {
			scoringVersion: 6,
			triggerKey:
				scenario === "automatic"
					? `vod-auto:${ENCODING_JOB_ID}`
					: `lab-manual:${ENCODING_JOB_ID}:mirror`,
			params: {
				source: "QC_MIRROR",
				measurementMethod: "FRAME_INDEX_BT709_10BIT",
				execution: { backend: "CLOUD", profileId: "gcp", budgetUsd: 10 },
			},
		},
	});
	await expect(t.processor.process({ vmafJobId: VMAF_JOB_ID })).rejects.toThrow(
		scenario === "automatic" ? "manual FINISHED" : "direct full-length source",
	);
	expect(t.downloaded).toHaveLength(0);
	expect(cloudScore).not.toHaveBeenCalled();
});

describe("measurement reset cadence", () => {
	it.each([
		undefined,
		"LOCAL",
	])("local reset cadence preserves an 850ms physical teardown budget (%s)", async (backend) => {
		vi.useFakeTimers();
		const t = setup(
			backend ? { job: { params: { execution: { backend } } } } : {},
		);
		const original = vi.mocked(t.runner.run).getMockImplementation();
		if (!original) throw new Error("Missing fixture runner");
		let started!: () => void;
		const didStart = new Promise<void>((resolve) => {
			started = resolve;
		});
		let closed = false;
		vi.mocked(t.runner.run).mockImplementation((bin, argv, options) => {
			if (!argv.includes("-filter_complex"))
				return original(bin, argv, options);
			started();
			return new Promise((resolve) =>
				options?.signal?.addEventListener(
					"abort",
					() => {
						setTimeout(() => {
							closed = true;
							resolve({ code: null, stdout: "", stderr: "" });
						}, 850);
					},
					{ once: true },
				),
			);
		});
		const pending = t.processor.process({ vmafJobId: VMAF_JOB_ID });
		pending.catch(() => {});
		try {
			await didStart;
			t.vmafJob.findUnique.mockResolvedValue(null as never);
			await vi.advanceTimersByTimeAsync(949);
			expect(closed).toBe(false);
			await vi.advanceTimersByTimeAsync(1);
			expect(closed).toBe(true);
			await expect(pending).resolves.toMatchObject({
				status: "MISSING",
				results: 0,
			});
			expect(t.results).toEqual([]);
		} finally {
			t.vmafJob.findUnique.mockResolvedValue(null as never);
			await vi.advanceTimersByTimeAsync(3_000);
			await pending.catch(() => {});
			vi.useRealTimers();
		}
	});

	it("cloud reset cadence retains its one-second interval", async () => {
		vi.useFakeTimers();
		let started!: () => void;
		const didStart = new Promise<void>((resolve) => {
			started = resolve;
		});
		let aborted = false;
		const t = setup({
			job: {
				params: {
					execution: { backend: "CLOUD", profileId: "gcp", budgetUsd: 10 },
				},
			},
			cloudScore: async (request) => {
				started();
				await new Promise<void>((_resolve, reject) =>
					request.signal?.addEventListener(
						"abort",
						() => {
							aborted = true;
							reject(request.signal?.reason);
						},
						{ once: true },
					),
				);
			},
		});
		const pending = t.processor.process({ vmafJobId: VMAF_JOB_ID });
		pending.catch(() => {});
		try {
			await didStart;
			t.job.status = "ERROR";
			t.job.error = "Canceled";
			await vi.advanceTimersByTimeAsync(999);
			expect(aborted).toBe(false);
			await vi.advanceTimersByTimeAsync(1);
			expect(aborted).toBe(true);
			await expect(pending).resolves.toMatchObject({
				status: "ERROR",
				results: 0,
			});
			expect(t.results).toEqual([]);
		} finally {
			t.job.status = "ERROR";
			await vi.advanceTimersByTimeAsync(2_000);
			await pending.catch(() => {});
			vi.useRealTimers();
		}
	});
});

function resourceDeferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
const RESOURCE_PROBE_JSON = JSON.stringify({
	streams: [
		{
			codec_type: "video",
			codec_name: "h264",
			width: 1920,
			height: 1080,
			pix_fmt: "yuv420p",
			r_frame_rate: "30/1",
			avg_frame_rate: "30/1",
			duration: "10",
			nb_frames: "300",
		},
	],
});
function sharedTestResources() {
	return createLocalVmafResources({
		readResources: () => ({
			cpuCapacity: 8,
			budgetBytes: 8 * 1024 ** 3,
			reserveBytes: 0,
		}),
	});
}
it("queues VOD jobs before reference or mirror I/O and shares preparation across jobs", async () => {
	const resources = sharedTestResources(),
		holder = resourceDeferred(),
		entered = resourceDeferred();
	const blocker = resources.begin(new AbortController().signal);
	const blocking = blocker.prepared("other-job", async () => {
		entered.resolve();
		await holder.promise;
	});
	await entered.promise;
	const a = setup({
		localResources: resources,
		probeJson: RESOURCE_PROBE_JSON,
	});
	const otherId = "00000000-0000-4000-8000-0000000000a2";
	const b = setup({
		localResources: resources,
		probeJson: RESOURCE_PROBE_JSON,
		job: { id: otherId },
	});
	const first = a.processor.process({ vmafJobId: VMAF_JOB_ID }),
		second = b.processor.process({ vmafJobId: otherId });
	const outcome = Promise.all([first, second]);
	try {
		await vi.waitFor(() =>
			expect(blocker.report().queued > 0 || a.downloaded.length > 0).toBe(true),
		);
		expect(a.downloaded).toHaveLength(0);
		expect(b.downloaded).toHaveLength(0);
		expect(a.runner.run).not.toHaveBeenCalled();
		expect(b.runner.run).not.toHaveBeenCalled();
	} finally {
		holder.resolve();
		await blocking;
	}
	expect(await outcome).toEqual([
		expect.objectContaining({ status: "FINISHED", results: 2 }),
		expect.objectContaining({ status: "FINISHED", results: 2 }),
	]);
	expect(
		a.downloaded.filter((item) => item.key === "src/master.mkv"),
	).toHaveLength(1);
	expect(
		b.downloaded.filter((item) => item.key === "src/master.mkv"),
	).toHaveLength(1);
	expect(blocker.report().queued).toBe(0);
	expect(blocker.report().maxObservedActive).toBeLessThanOrEqual(2);
});

it("removes a cancelled VOD preparation without downloading and lets the next job proceed", async () => {
	const resources = sharedTestResources(),
		holder = resourceDeferred(),
		entered = resourceDeferred();
	const blocker = resources.begin(new AbortController().signal);
	const blocking = blocker.prepared("other-job", async () => {
		entered.resolve();
		await holder.promise;
	});
	await entered.promise;
	const t = setup({
		localResources: resources,
		probeJson: RESOURCE_PROBE_JSON,
	});
	const pending = t.processor.process({ vmafJobId: VMAF_JOB_ID });
	try {
		await vi.waitFor(() =>
			expect(blocker.report().queued > 0 || t.downloaded.length > 0).toBe(true),
		);
		expect(t.downloaded).toHaveLength(0);
		t.vmafJob.findUnique.mockResolvedValue(null);
		expect(await pending).toMatchObject({ status: "MISSING" });
		expect(t.runner.run).not.toHaveBeenCalled();
		expect(blocker.report().queued).toBe(0);
	} finally {
		holder.resolve();
		await blocking;
		await pending.catch(() => {});
	}
	const next = setup({
		localResources: resources,
		probeJson: RESOURCE_PROBE_JSON,
	});
	expect(
		await next.processor.process({ vmafJobId: VMAF_JOB_ID }),
	).toMatchObject({ status: "FINISHED" });
});

it("never publishes a VOD result after execution authority is lost", async () => {
	const authority = vi.fn(async () => {
		throw new Error("Reservation lost before publication");
	});
	const resources = createLocalVmafResources({
		readResources: () => ({
			cpuCapacity: 8,
			budgetBytes: 8 * 1024 ** 3,
			reserveBytes: 0,
		}),
		execute: async (_plan, signal, work) => work(signal, authority),
	});
	const t = setup({
		localResources: resources,
		probeJson: RESOURCE_PROBE_JSON,
		resolveLocalResources: async (request) => {
			expect(request.options.referencePath).toContain("ref-0.mp4");
			expect(request.options.distortedPath).toContain("dist-");
			expect(request.referenceProbe).toBe(RESOURCE_PROBE_JSON);
			return {
				threads: 1,
				concurrency: 2,
				estimatedBytes: 1024,
				exclusive: false,
				manualFallback: false,
				basis: "profile-test",
			};
		},
	});
	await expect(t.processor.process({ vmafJobId: VMAF_JOB_ID })).rejects.toThrow(
		"Reservation lost before publication",
	);
	expect(t.results).toHaveLength(0);
	expect(authority).toHaveBeenCalled();
	const observer = resources.begin(new AbortController().signal);
	expect(observer.report().queued).toBe(0);
	expect(observer.report().active).toBe(0);
	expect((await import("node:fs/promises")).readdir(workDir)).resolves.toEqual(
		[],
	);
});

it("passes the selected native device and pipeline depth through the real processor boundary", async () => {
	const localRunner: ProcessRunner = {
		spawn: vi.fn(() => {
			throw new Error("Unexpected spawn");
		}),
		run: vi.fn(),
	};
	const native = vi
		.spyOn(localScoring, "runLocalVmafScore")
		.mockImplementation(async (_deps, options, context) => {
			expect(_deps.runner).toBe(localRunner);
			expect(options.scoring).toEqual({ backend: "vulkan", device: 2 });
			expect(context?.nativeInflightFrames).toBe(2);
			return {
				run: { code: 0, stderr: "" },
				execution: {
					version: 1,
					requestedDecode: "cpu",
					decode: {
						reference: { backend: "cpu" },
						distorted: { backend: "cpu" },
					},
					scoring: {
						backend: "cpu",
						implementation: "libvmaf",
						model: options.model,
					},
					attempts: 1,
				},
				log: JSON.parse(vmafJson([95])),
			};
		});
	try {
		const t = setup({
			localResources: sharedTestResources(),
			localRunner,
			probeJson: RESOURCE_PROBE_JSON,
			scoringBackend: "vulkan",
			job: { scoringVersion: VMAF_SCORING_VERSION },
			resolveLocalResources: async () => ({
				threads: 1,
				concurrency: 2,
				estimatedBytes: 1024,
				exclusive: false,
				manualFallback: false,
				nativeDevice: 2,
				nativeInflightFrames: 2,
			}),
		});
		const raw = vi.mocked(t.runner.run).getMockImplementation();
		if (!raw) throw new Error("Missing raw runner fixture");
		vi.mocked(localRunner.run).mockImplementation(raw);
		expect(await t.processor.process({ vmafJobId: VMAF_JOB_ID })).toMatchObject(
			{ status: "FINISHED", results: 2 },
		);
		expect(native).toHaveBeenCalledTimes(2);
	} finally {
		native.mockRestore();
	}
});

it("uses the execution lease signal for VOD scoring and does not publish an aborted score", async () => {
	const lease = new AbortController();
	const resources = createLocalVmafResources({
		readResources: () => ({
			cpuCapacity: 8,
			budgetBytes: 8 * 1024 ** 3,
			reserveBytes: 0,
		}),
		execute: async (_plan, _signal, work) => work(lease.signal, async () => {}),
	});
	const t = setup({
		localResources: resources,
		probeJson: RESOURCE_PROBE_JSON,
	});
	const ordinary = vi.mocked(t.runner.run).getMockImplementation();
	if (!ordinary) throw new Error("Missing runner fixture");
	vi.mocked(t.runner.run).mockImplementation(async (bin, argv, options) => {
		if (argv.join(" ").includes("libvmaf")) {
			expect(options?.signal).toBe(lease.signal);
			lease.abort(new Error("Lease execution lost"));
			options?.signal?.throwIfAborted();
		}
		return ordinary(bin, argv, options);
	});
	await expect(t.processor.process({ vmafJobId: VMAF_JOB_ID })).rejects.toThrow(
		"Lease execution lost",
	);
	expect(t.results).toHaveLength(0);
	expect(resources.begin(new AbortController().signal).report().queued).toBe(0);
});

it("cleans a failed reference download before draining queued VOD comparisons and the next job", async () => {
	// Keep later descriptors queued while the first real file write is pending.
	// Another job must not expand this cleanup test's preparation fan-out.
	const resources = createLocalVmafResources({
			concurrency: 1,
			readResources: () => ({
				cpuCapacity: 8,
				budgetBytes: 8 * 1024 ** 3,
				reserveBytes: 0,
			}),
		}),
		plan = qcPlan();
	const ingest = plan.ingest as Row[];
	ingest.push({
		...ingest[0],
		key: "second-video",
		inputPath: "src/second.mkv",
	});
	const secondRendition = (plan.renditions as Row[])[1];
	if (!secondRendition) throw new Error("Missing second fixture rendition");
	secondRendition.ingestKey = "second-video";
	const attempted: string[] = [];
	const bad = setup({
		plan,
		localResources: resources,
		probeJson: RESOURCE_PROBE_JSON,
		download: async (request) => {
			attempted.push(request.key);
			await writeFile(request.destPath, "partial input");
			throw new Error("Source download failed");
		},
	});
	const otherId = "00000000-0000-4000-8000-0000000000a2";
	const good = setup({
		localResources: resources,
		probeJson: RESOURCE_PROBE_JSON,
		job: { id: otherId },
	});
	const failed = bad.processor.process({ vmafJobId: VMAF_JOB_ID });
	const rejected = expect(failed).rejects.toThrow("Source download failed");
	const next = good.processor.process({ vmafJobId: otherId });
	await rejected;
	expect(attempted).toEqual(["src/master.mkv"]);
	expect(await next).toMatchObject({ status: "FINISHED", results: 2 });
	expect(bad.runner.run).not.toHaveBeenCalled();
	await expect(
		(await import("node:fs/promises")).readdir(workDir),
	).resolves.toEqual([]);
	expect(resources.begin(new AbortController().signal).report().queued).toBe(0);
});

function runnerBoundaryPlan() {
	const plan = qcPlan();
	plan.renditions = [
		{
			key: "vpt",
			ingestKey: "video",
			codec: "H264",
			mode: "PER_TITLE_TEMPLATE",
			height: null,
			bitrate: null,
		},
	];
	plan.muxings = [
		{
			key: "mpt",
			kind: "MP4",
			streamKey: "vpt",
			filename: "vpt.mp4",
			destination: { outputKey: "origin", path: "out/video/pt" },
		},
	];
	return plan;
}
it.each([
	false,
	true,
])("routes local reference, target probes and scoring through localRunner (resource policy=%s)", async (withResources) => {
	const localRunner: ProcessRunner = {
		spawn: vi.fn(() => {
			throw new Error("Unexpected spawn");
		}),
		run: vi.fn(),
	};
	const t = setup({
		plan: runnerBoundaryPlan(),
		localRunner,
		...(withResources
			? {
					localResources: sharedTestResources(),
					probeJson: RESOURCE_PROBE_JSON,
				}
			: {}),
	});
	const raw = vi.mocked(t.runner.run).getMockImplementation();
	if (!raw) throw new Error("Missing raw runner fixture");
	vi.mocked(localRunner.run).mockImplementation(raw);
	expect(await t.processor.process({ vmafJobId: VMAF_JOB_ID })).toMatchObject({
		status: "FINISHED",
		results: 1,
	});
	expect(t.runner.run).not.toHaveBeenCalled();
	const calls = vi.mocked(localRunner.run).mock.calls;
	expect(
		calls.filter(([, argv]) => argv.includes("-show_streams")),
	).toHaveLength(2);
	expect(
		calls.filter(([, argv]) => argv.join(" ").includes("libvmaf")),
	).toHaveLength(1);
});

it("keeps every cloud preparation probe on the raw runner without accessing the supervised local path", async () => {
	const localRunner: ProcessRunner = {
		spawn: vi.fn(() => {
			throw new Error("Cloud accessed local supervisor");
		}),
		run: vi.fn(async () => {
			throw new Error("Cloud accessed local supervisor");
		}),
	};
	const cloudScore: NonNullable<VmafProcessorDeps["cloudScore"]> = async (
		request,
	) => {
		await writeFile(request.options.logPath, vmafJson([95]));
	};
	const t = setup({
		plan: runnerBoundaryPlan(),
		localRunner,
		cloudScore,
		scoringBackend: "vulkan",
		decodePolicy: { backend: "cuda", device: 0 },
		job: {
			params: {
				execution: { backend: "CLOUD", profileId: "gcp", budgetUsd: 10 },
			},
		},
		localResources: {
			begin: () => {
				throw new Error("Cloud entered local resource manager");
			},
		},
		resolveLocalResources: async () => {
			throw new Error("Cloud entered native calibration");
		},
	});
	expect(await t.processor.process({ vmafJobId: VMAF_JOB_ID })).toMatchObject({
		status: "FINISHED",
		results: 1,
	});
	expect(localRunner.run).not.toHaveBeenCalled();
	expect(localRunner.spawn).not.toHaveBeenCalled();
	expect(
		vi
			.mocked(t.runner.run)
			.mock.calls.filter(([, argv]) => argv.includes("-show_streams")),
	).toHaveLength(2);
});

describe("per-job local execution", () => {
	const model = "vmaf_v1.0.16_3d0h";
	const chosen = {
		backend: "cuda" as const,
		device: 2,
		identity: {
			sourceSha256: "a".repeat(64),
			binarySha256: "b".repeat(64),
			supervisorBinarySha256: "c".repeat(64),
			deviceUuid: "GPU-fixture",
		},
	};
	it("forces CPU scoring and decoding while retaining a valid supervised runner", async () => {
		const selectLocalNative = vi.fn(async () => chosen);
		const localRunner: ProcessRunner = { spawn: vi.fn(), run: vi.fn() };
		const t = setup({
			scoringBackend: "vulkan",
			decodePolicy: { backend: "cuda", device: 9 },
			localRunner,
			selectLocalNative,
			nativeSelectionFailure: new Error("invalid optional pair"),
			job: {
				scoringVersion: VMAF_SCORING_VERSION,
				params: { execution: { backend: "LOCAL", localMode: "CPU" } },
			},
		});
		const raw = vi.mocked(t.runner.run).getMockImplementation();
		if (!raw) throw new Error("Missing runner fixture");
		vi.mocked(localRunner.run).mockImplementation(raw);
		await t.processor.process({ vmafJobId: VMAF_JOB_ID });
		expect(selectLocalNative).not.toHaveBeenCalled();
		expect(localRunner.run).toHaveBeenCalled();
		expect(t.runner.run).not.toHaveBeenCalled();
		expect(t.job.scoringVersion).toBe(VMAF_SCORING_VERSION);
		expect(
			t.filterComplexArgs.every(
				(graph) => graph.includes("libvmaf=") && !graph.includes("hwdownload"),
			),
		).toBe(true);
		expect((t.job.params as Row).localSelection).toEqual({
			version: 1,
			requested: "CPU",
			model: "vmaf_v0.6.1",
			backend: "cpu",
		});
		expect(t.results).toHaveLength(2);
		for (const result of t.results)
			expect(result.provenance).toMatchObject({
				localExecution: {
					selection: { requested: "CPU" },
					requestedDecode: "cpu",
					scoring: { backend: "cpu", model: "vmaf_v0.6.1" },
				},
			});
	});
	it.each([
		["runtime", model, undefined, "GPU_RUNTIME_UNAVAILABLE"],
		[
			"model",
			"vmaf_v0.6.1",
			vi.fn(async () => chosen),
			"GPU_MODEL_UNSUPPORTED",
		],
		[
			"devices",
			model,
			vi.fn(async () => ({
				backend: "cpu" as const,
				reason: "GPU_NOT_AVAILABLE" as const,
			})),
			"GPU_NOT_AVAILABLE",
		],
	] as const)("records AUTO CPU reason when %s is unavailable without changing the model", async (_name, requestedModel, selectLocalNative, reason) => {
		const t = setup({
			scoringBackend: "cuda",
			decodePolicy: { backend: "auto", device: 4 },
			selectLocalNative,
			job: {
				model: requestedModel,
				scoringVersion: VMAF_SCORING_VERSION,
				params: { execution: { backend: "LOCAL", localMode: "AUTO" } },
			},
		});
		await t.processor.process({ vmafJobId: VMAF_JOB_ID });
		expect((t.job.params as Row).localSelection).toMatchObject({
			requested: "AUTO",
			model: requestedModel,
			backend: "cpu",
			reason,
		});
		for (const result of t.results)
			expect(result.provenance).toMatchObject({
				localExecution: {
					selection: { requested: "AUTO", reason },
					requestedDecode: "cpu",
					scoring: { backend: "cpu", model: requestedModel },
				},
			});
		if (reason === "GPU_MODEL_UNSUPPORTED")
			expect(selectLocalNative).not.toHaveBeenCalled();
	});
	it("uses CPU for an AUTO delivery gate without querying GPU availability", async () => {
		const plan = qcPlan();
		plan.qc = {
			vmaf: true,
			gate: {
				rules: [{ metric: "VMAF_MEAN", scope: "PER_RENDITION", gte: 80 }],
				onFail: "BLOCK_MANIFESTS",
			},
		};
		const selectLocalNative = vi.fn(async () => chosen);
		const t = setup({
			plan,
			selectLocalNative,
			scoringBackend: "cuda",
			decodePolicy: { backend: "auto", device: 0 },
			job: {
				model,
				scoringVersion: VMAF_SCORING_VERSION,
				params: { execution: { backend: "LOCAL", localMode: "AUTO" } },
			},
		});
		await t.processor.process({ vmafJobId: VMAF_JOB_ID });
		expect(selectLocalNative).not.toHaveBeenCalled();
		expect((t.job.params as Row).localSelection).toMatchObject({
			backend: "cpu",
			reason: "GPU_GATE_CPU_ONLY",
		});
		expect(t.results).toHaveLength(2);
	});
	it("keeps AUTO CPU fallback pinned when the row is requeued and a GPU appears", async () => {
		const selectLocalNative = vi.fn(async () => chosen);
		const stored = {
			version: 1,
			requested: "AUTO",
			model,
			backend: "cpu",
			reason: "GPU_NOT_AVAILABLE",
		};
		const t = setup({
			selectLocalNative,
			scoringBackend: "cuda",
			decodePolicy: { backend: "auto", device: 0 },
			job: {
				model,
				scoringVersion: VMAF_SCORING_VERSION,
				params: {
					execution: { backend: "LOCAL", localMode: "AUTO" },
					localSelection: stored,
				},
			},
		});
		await t.processor.process({ vmafJobId: VMAF_JOB_ID });
		expect(selectLocalNative).not.toHaveBeenCalled();
		expect((t.job.params as Row).localSelection).toEqual(stored);
	});
	it("does not pin a new AUTO native method over partial results", async () => {
		const t = setup({
			selectLocalNative: async () => chosen,
			job: {
				model,
				scoringVersion: VMAF_SCORING_VERSION,
				params: { execution: { backend: "LOCAL", localMode: "AUTO" } },
			},
		});
		t.results.push({
			renditionRef: { renditionKey: "v360" },
			pooled: { mean: 90 },
		});
		await expect(
			t.processor.process({ vmafJobId: VMAF_JOB_ID }),
		).rejects.toThrow(/existing results.*new measurement/i);
		expect((t.job.params as Row).localSelection).toBeUndefined();
		expect(t.job.scoringVersion).toBe(VMAF_SCORING_VERSION);
		expect(t.runner.run).not.toHaveBeenCalled();
	});
	it("does not hide invalid runtime selection or retry on CPU", async () => {
		const t = setup({
			selectLocalNative: async () => {
				throw new Error("NATIVE_DEVICE_INFO_BUILD_MISMATCH");
			},
			job: {
				model,
				scoringVersion: VMAF_SCORING_VERSION,
				params: { execution: { backend: "LOCAL", localMode: "AUTO" } },
			},
		});
		await expect(
			t.processor.process({ vmafJobId: VMAF_JOB_ID }),
		).rejects.toThrow("NATIVE_DEVICE_INFO_BUILD_MISMATCH");
		expect(t.runner.run).not.toHaveBeenCalled();
		expect(t.results).toHaveLength(0);
	});
});

it("keeps interleaved CPU and AUTO jobs isolated through selection, admission and publication", async () => {
	const model = "vmaf_v1.0.16_3d0h";
	const chosen = {
		backend: "cuda" as const,
		device: 2,
		identity: {
			sourceSha256: "a".repeat(64),
			binarySha256: "b".repeat(64),
			supervisorBinarySha256: "c".repeat(64),
			deviceUuid: "GPU-fixture",
		},
	};
	const entered = resourceDeferred(),
		release = resourceDeferred();
	const selectLocalNative = vi.fn(async () => {
		entered.resolve();
		await release.promise;
		return chosen;
	});
	const assertOwned = vi.fn(async () => {});
	const localResources = createLocalVmafResources({
		readResources: () => ({
			cpuCapacity: 8,
			budgetBytes: 8 * 1024 ** 3,
			reserveBytes: 0,
		}),
		execute: async (_plan, signal, work) => work(signal, assertOwned),
	});
	const localRunner: ProcessRunner = { spawn: vi.fn(), run: vi.fn() };
	const resolveLocalResources = vi.fn<
		NonNullable<VmafProcessorDeps["resolveLocalResources"]>
	>(async (request) => {
		if (request.options.scoring) {
			expect(request.selectedNativeDevice).toBe(2);
			expect(request.selectedNativeIdentity).toEqual(chosen.identity);
		}
		return {
			threads: 1,
			concurrency: 2,
			estimatedBytes: 1024,
			exclusive: false,
			manualFallback: false,
			...(request.options.scoring
				? {
						nativeDevice: 2,
						nativeInflightFrames: 1 as const,
						gpu: { deviceKey: "e".repeat(64), bytes: 1024, computeCredits: 1 },
					}
				: {}),
		};
	});
	const t = setup({
		localResources,
		localRunner,
		resolveLocalResources,
		selectLocalNative,
		nativePath: "/native",
		probeJson: RESOURCE_PROBE_JSON,
		scoringBackend: "vulkan",
		decodePolicy: { backend: "cuda", device: 9 },
		job: {
			model,
			scoringVersion: VMAF_SCORING_VERSION,
			params: { execution: { backend: "LOCAL", localMode: "CPU" } },
		},
	});
	const otherId = "00000000-0000-4000-8000-0000000000a2";
	const encodingJob = (await t.vmafJob.findUnique())?.encodingJob;
	const other: Row = {
		...t.job,
		id: otherId,
		params: { execution: { backend: "LOCAL", localMode: "AUTO" } },
	};
	const jobs = new Map([
		[VMAF_JOB_ID, t.job],
		[otherId, other],
	]);
	t.vmafJob.findUnique.mockImplementation(async (args?: unknown) => {
		const id = (args as { where: { id: string } }).where.id;
		const job = jobs.get(id);
		return job ? { ...job, encodingJob: encodingJob ?? null } : null;
	});
	t.vmafJob.updateMany.mockImplementation(async ({ where, data }) => {
		const job = jobs.get(String(where.id));
		if (!job || (where.status && where.status !== job.status))
			return { count: 0 };
		Object.assign(job, data);
		return { count: 1 };
	});
	t.vmafJob.update.mockImplementation(async ({ where, data }) => {
		const job = jobs.get(String(where.id));
		if (!job) throw new Error("Missing fixture row");
		for (const [key, value] of Object.entries(data)) {
			job[key] =
				value && typeof value === "object" && "increment" in value
					? Number(job[key] ?? 0) + Number(value.increment)
					: value;
		}
		return { ...job };
	});
	t.vmafResult.findMany.mockImplementation(async (args?: unknown) =>
		t.results
			.filter(
				(result) =>
					result.vmafJobId ===
					(args as { where: { vmafJobId: string } }).where.vmafJobId,
			)
			.map((result) => ({
				renditionRef: result.renditionRef,
				pooled: result.pooled,
			})),
	);
	const raw = vi.mocked(t.runner.run).getMockImplementation();
	if (!raw) throw new Error("Missing runner fixture");
	vi.mocked(localRunner.run).mockImplementation(raw);
	const ordinaryScore = localScoring.runLocalVmafScore;
	const score = vi
		.spyOn(localScoring, "runLocalVmafScore")
		.mockImplementation(async (deps, options, context) => {
			expect(deps.decodePolicy).toMatchObject({ backend: "cpu" });
			if (!options.scoring) return ordinaryScore(deps, options, context);
			expect(options.scoring).toEqual({ backend: "cuda", device: 2 });
			expect(deps.runner).toBe(localRunner);
			const execution: LocalVmafExecution = {
				version: 1,
				requestedDecode: "cpu",
				decode: {
					reference: { backend: "cpu" },
					distorted: { backend: "cpu" },
				},
				attempts: 1,
				scoring: {
					backend: "cuda",
					implementation: "bitovp-owned",
					model,
					modelSha256: "f".repeat(64),
					features: ["a", "b", "c", "d", "e", "f", "g"],
					bitDepth: 10,
					distortedOriginal: { width: 1920, height: 1080, bitdepth: 8 },
					officialRevision: NATIVE_OFFICIAL_REVISION,
					sourceSha256: chosen.identity.sourceSha256,
					device: {
						index: 2,
						name: "Fixture GPU",
						uuid: chosen.identity.deviceUuid,
						vendorId: 0x10de,
						deviceId: 1,
						integrated: false,
					},
					cpuParity: {
						checked: true,
						featureCount: 7,
						scoreCount: 1,
						maxFeatureError: 0,
						maxScoreError: 0,
					},
				},
			};
			return {
				run: { code: 0, stderr: "" },
				execution,
				log: JSON.parse(vmafJson([95])),
			};
		});
	try {
		const gpu = t.processor.process({ vmafJobId: otherId });
		await entered.promise;
		expect(await t.processor.process({ vmafJobId: VMAF_JOB_ID })).toMatchObject(
			{ status: "FINISHED", results: 2 },
		);
		release.resolve();
		expect(await gpu).toMatchObject({ status: "FINISHED", results: 2 });
		expect(t.deps.scoringBackend).toBe("vulkan");
		expect(t.deps.decodePolicy).toEqual({ backend: "cuda", device: 9 });
		expect((t.job.params as Row).localSelection).toMatchObject({
			requested: "CPU",
			backend: "cpu",
		});
		expect((other.params as Row).localSelection).toEqual({
			version: 1,
			requested: "AUTO",
			model,
			...chosen,
		});
		for (const result of t.results)
			expect(result.provenance).toMatchObject({
				localExecution: {
					selection: {
						requested: result.vmafJobId === VMAF_JOB_ID ? "CPU" : "AUTO",
					},
					scoring: {
						backend: result.vmafJobId === VMAF_JOB_ID ? "cpu" : "cuda",
					},
				},
			});
		expect(t.job.scoringVersion).toBe(VMAF_SCORING_VERSION);
		expect(other.scoringVersion).not.toBe(VMAF_SCORING_VERSION);
		expect(assertOwned).toHaveBeenCalled();
	} finally {
		release.resolve();
		score.mockRestore();
	}
});

function autoNativeFailureHarness(
	admitGpu = true,
	overrides: {
		download?: VmafDownload;
		job?: Row;
		resolveLocalResources?: VmafProcessorDeps["resolveLocalResources"];
	} = {},
) {
	const chosen = {
		backend: "cuda" as const,
		device: 2,
		identity: {
			sourceSha256: "a".repeat(64),
			binarySha256: "b".repeat(64),
			supervisorBinarySha256: "c".repeat(64),
			deviceUuid: "GPU-fixture",
		},
	};
	const localRunner: ProcessRunner = { spawn: vi.fn(), run: vi.fn() };
	const t = setup({
		download: overrides.download,
		nativePath: "/native",
		localRunner,
		probeJson: RESOURCE_PROBE_JSON,
		selectLocalNative: vi.fn(async () => chosen),
		localResources: createLocalVmafResources({
			readResources: () => ({
				cpuCapacity: 8,
				budgetBytes: 8 * 1024 ** 3,
				reserveBytes: 0,
			}),
			execute: async (_plan, signal, work) => work(signal, async () => {}),
		}),
		resolveLocalResources:
			overrides.resolveLocalResources ??
			(async () => ({
				threads: 1,
				concurrency: 1,
				estimatedBytes: 1024,
				exclusive: false,
				manualFallback: false,
				...(admitGpu
					? {
							nativeDevice: 2,
							gpu: {
								deviceKey: "e".repeat(64),
								bytes: 1024,
								computeCredits: 1,
							},
						}
					: {}),
			})),
		job: {
			model: "vmaf_v1.0.16_3d0h",
			scoringVersion: VMAF_SCORING_VERSION,
			params: { execution: { backend: "LOCAL", localMode: "AUTO" } },
			...overrides.job,
		},
	});
	const raw = vi.mocked(t.runner.run).getMockImplementation();
	if (!raw) throw new Error("Missing runner fixture");
	vi.mocked(localRunner.run).mockImplementation(raw);
	return t;
}
it.each([
	"NATIVE_RECEIPT_CPU_PARITY_MISMATCH",
	"NATIVE_MODEL_SHA256_MISMATCH",
	"NATIVE_INPUT_FRAME_COUNT_MISMATCH",
])("never retries AUTO scoring on CPU after %s", async (code) => {
	const t = autoNativeFailureHarness();
	const score = vi
		.spyOn(localScoring, "runLocalVmafScore")
		.mockRejectedValue(new Error(code));
	try {
		await expect(
			t.processor.process({ vmafJobId: VMAF_JOB_ID }),
		).rejects.toThrow(code);
		expect(score).toHaveBeenCalled();
		expect(
			score.mock.calls.every(
				([, options]) => options.scoring?.backend === "cuda",
			),
		).toBe(true);
		expect(t.results).toHaveLength(0);
		expect((t.job.params as Row).localSelection).toMatchObject({
			requested: "AUTO",
			backend: "cuda",
			device: 2,
		});
	} finally {
		score.mockRestore();
	}
});
it("refuses AUTO GPU execution without an owned GPU admission", async () => {
	const t = autoNativeFailureHarness(false);
	const score = vi.spyOn(localScoring, "runLocalVmafScore");
	try {
		await expect(
			t.processor.process({ vmafJobId: VMAF_JOB_ID }),
		).rejects.toThrow("VMAF_LOCAL_GPU_ADMISSION_REQUIRED");
		expect(score).not.toHaveBeenCalled();
		expect(t.results).toHaveLength(0);
	} finally {
		score.mockRestore();
	}
});
describe("a pair of a Local (GPU if available) measurement that the GPU scorer does not take", () => {
	/** What ffprobe says of a file, as `RESOURCE_PROBE_JSON` with other values. */
	const probeWith = (extra: Row = {}) =>
		JSON.stringify({
			streams: [{ ...JSON.parse(RESOURCE_PROBE_JSON).streams[0], ...extra }],
		});
	/**
	 * A measurement of two encodes, `v360` and `v540`, on a worker with a
	 * qualified GPU. The planner answers as the automatic one does: the GPU
	 * for a pair that asks for the scorer, CPU threads for one that does not.
	 */
	const autoPairs = (probes: {
		reference?: string;
		v360?: string;
		v540?: string;
	}) => {
		const planned = vi.fn<
			NonNullable<VmafProcessorDeps["resolveLocalResources"]>
		>(async (request) => ({
			threads: 1,
			concurrency: 1,
			estimatedBytes: 1024,
			exclusive: false,
			manualFallback: false,
			...(request.options.scoring
				? {
						nativeDevice: 2,
						gpu: { deviceKey: "e".repeat(64), bytes: 1024, computeCredits: 1 },
					}
				: {}),
		}));
		const t = autoNativeFailureHarness(true, {
			resolveLocalResources: planned,
		});
		const raw = vi.mocked(t.runner.run).getMockImplementation();
		const localRunner = t.deps.localRunner;
		if (!raw || !localRunner) throw new Error("Missing runner fixture");
		const probed = async (bin: string, argv: string[], options?: unknown) => {
			const path = argv.at(-1) ?? "";
			return argv.includes("-show_streams")
				? {
						code: 0,
						stderr: "",
						stdout:
							(/\/ref-\d+\./.test(path)
								? probes.reference
								: path.includes("dist-v360-")
									? probes.v360
									: probes.v540) ?? RESOURCE_PROBE_JSON,
					}
				: raw(bin, argv, options as never);
		};
		vi.mocked(t.runner.run).mockImplementation(probed);
		vi.mocked(localRunner.run).mockImplementation(probed);
		// The scorer's stand-in answers a pair that asks for it; a pair that
		// does not goes to the ordinary method, which runs FFmpeg.
		const ordinaryScore = localScoring.runLocalVmafScore;
		const score = vi
			.spyOn(localScoring, "runLocalVmafScore")
			.mockImplementation(async (deps, options, context) =>
				options.scoring
					? {
							run: { code: 0, stderr: "" },
							log: JSON.parse(vmafJson([95, 96, 94, 97, 93])),
							execution: {
								version: 1,
								requestedDecode: "cpu",
								decode: {
									reference: { backend: "cpu" },
									distorted: { backend: "cpu" },
								},
								attempts: 1,
								scoring: {
									backend: "cuda",
									implementation: "bitovp-owned",
									model: options.model,
									modelSha256: "f".repeat(64),
									features: ["a", "b", "c", "d", "e", "f", "g"],
									bitDepth: 8,
									distortedOriginal: { width: 1920, height: 1080, bitdepth: 8 },
									officialRevision: NATIVE_OFFICIAL_REVISION,
									sourceSha256: "a".repeat(64),
									device: {
										index: 2,
										name: "Fixture GPU",
										uuid: "GPU-fixture",
										vendorId: 0x10de,
										deviceId: 1,
										integrated: false,
									},
									cpuParity: {
										checked: true,
										featureCount: 35,
										scoreCount: 5,
										maxFeatureError: 0,
										maxScoreError: 0,
									},
								},
							} satisfies LocalVmafExecution,
						}
					: ordinaryScore(deps, options, context),
			);
		const of = (rendition: string) => {
			const result = t.results.find(
				(row) => (row.renditionRef as Row).renditionKey === rendition,
			);
			if (!result) throw new Error(`No result for ${rendition}`);
			return (result.provenance as Row).localExecution as LocalVmafExecution;
		};
		const scored = (rendition: string) =>
			score.mock.calls.filter(([, options]) =>
				options.distortedPath.includes(`dist-${rendition}-`),
			);
		return Object.assign(t, { planned, score, ordinaryScore, of, scored });
	};

	it("scores that pair with the ordinary method on the CPU and the other pair on the GPU", async () => {
		// The encode of 360 lines is full range and the reference is not.
		const t = autoPairs({ v360: probeWith({ color_range: "pc" }) });
		try {
			expect(
				await t.processor.process({ vmafJobId: VMAF_JOB_ID }),
			).toMatchObject({ status: "FINISHED", results: 2 });
			// The pair that the scorer takes: on the GPU, as before.
			expect(t.scored("v540")).toHaveLength(1);
			expect(t.scored("v540")[0]?.[1]).toMatchObject({
				scoring: { backend: "cuda", device: 2 },
			});
			expect(t.scored("v540")[0]?.[1]).not.toHaveProperty("fpsConform");
			expect(t.of("v540")).toMatchObject({
				selection: { requested: "AUTO" },
				scoring: { backend: "cuda", implementation: "bitovp-owned" },
			});
			expect(t.of("v540").selection).not.toHaveProperty("reason");
			// The other pair: the options of a Local CPU measurement, with
			// nothing of the scorer in them.
			expect(t.scored("v360")).toHaveLength(1);
			const [, options, context] = t.scored("v360")[0] ?? [];
			expect(options).toMatchObject({
				fpsConform: 30,
				scaleToReference: { width: 1920, height: 1080 },
				threads: 1,
			});
			expect(options).not.toHaveProperty("scoring");
			expect(options).not.toHaveProperty("distortedOriginal");
			expect(context).not.toHaveProperty("expectedReferenceSha256");
			expect(context?.nativeInflightFrames).toBeUndefined();
			// One run of FFmpeg, with the ordinary method's graph.
			expect(t.filterComplexArgs).toHaveLength(1);
			expect(t.filterComplexArgs[0]).toMatch(
				/^\[0:v\]scale=1920:1080:flags=bicubic,fps=30,settb=AVTB,setpts=N\/FRAME_RATE\/TB\[dist\];\[1:v\]fps=30,settb=AVTB,setpts=N\/FRAME_RATE\/TB\[ref\];\[dist\]\[ref\]libvmaf=/,
			);
			// The result names the processor and the kind of the reason.
			expect(t.of("v360")).toMatchObject({
				selection: { requested: "AUTO", reason: "GPU_PAIR_COLOR_RANGE" },
				scoring: { backend: "cpu", implementation: "libvmaf" },
			});
			// Resources: CPU threads for that pair and the GPU for the other.
			const plans = new Map(
				t.planned.mock.calls.map(([request]) => [
					request.options.distortedPath.includes("dist-v360-")
						? "v360"
						: "v540",
					request,
				]),
			);
			expect(plans.get("v360")?.options).not.toHaveProperty("scoring");
			expect(plans.get("v360")?.pair).not.toHaveProperty("scoringBackend");
			expect(plans.get("v360")).not.toHaveProperty("selectedNativeDevice");
			expect(plans.get("v360")).not.toHaveProperty("selectedNativeIdentity");
			expect(plans.get("v540")).toMatchObject({
				options: { scoring: { backend: "cuda" } },
				pair: { scoringBackend: "cuda" },
				selectedNativeDevice: 2,
			});
			// The measurement keeps its choice of the GPU and its generation.
			expect((t.job.params as Row).localSelection).toMatchObject({
				requested: "AUTO",
				backend: "cuda",
				device: 2,
			});
			expect((t.job.params as Row).localSelection).not.toHaveProperty("reason");
			expect(t.job.scoringVersion).not.toBe(VMAF_SCORING_VERSION);
			expect(t.job.status).toBe("FINISHED");
		} finally {
			t.score.mockRestore();
		}
	});

	it.each([
		["GPU_PAIR_PIXEL_FORMAT", { pix_fmt: "gbrp" }],
		["GPU_PAIR_COLOR_RANGE", { pix_fmt: "yuvj420p", color_range: "pc" }],
		["GPU_PAIR_COLOR_MATRIX", { color_space: "bt709" }],
		// 299 frames over the duration of 300: one slot is left out.
		["GPU_PAIR_FRAME_TIMES", { avg_frame_rate: "2990/100", nb_frames: "299" }],
		["GPU_PAIR_FRAME_TIMES", { r_frame_rate: "25/1", avg_frame_rate: "25/1" }],
		["GPU_PAIR_FRAME_TIMES", { nb_frames: "301" }],
		["GPU_PAIR_INPUT", { sample_aspect_ratio: "4:3" }],
		["GPU_PAIR_INPUT", { color_transfer: "smpte2084" }],
	] as const)("keeps %s as the reason of the result (%#)", async (reason, encode) => {
		const t = autoPairs({ v360: probeWith(encode) });
		try {
			expect(
				await t.processor.process({ vmafJobId: VMAF_JOB_ID }),
			).toMatchObject({ status: "FINISHED", results: 2 });
			expect(t.of("v360")).toMatchObject({
				selection: { requested: "AUTO", reason },
				scoring: { backend: "cpu" },
			});
			expect(t.scored("v360")[0]?.[1]).not.toHaveProperty("scoring");
			expect(t.of("v540")).toMatchObject({ scoring: { backend: "cuda" } });
		} finally {
			t.score.mockRestore();
		}
	});

	it("scores every pair on the CPU when it is the reference that the scorer does not take", async () => {
		const t = autoPairs({
			reference: probeWith({ pix_fmt: "yuv422p10le" }),
		});
		try {
			expect(
				await t.processor.process({ vmafJobId: VMAF_JOB_ID }),
			).toMatchObject({ status: "FINISHED", results: 2 });
			for (const rendition of ["v360", "v540"]) {
				expect(t.of(rendition)).toMatchObject({
					selection: { requested: "AUTO", reason: "GPU_PAIR_PIXEL_FORMAT" },
					scoring: { backend: "cpu" },
				});
				expect(t.scored(rendition)[0]?.[1]).not.toHaveProperty("scoring");
			}
			expect(t.filterComplexArgs).toHaveLength(2);
			expect((t.job.params as Row).localSelection).toMatchObject({
				requested: "AUTO",
				backend: "cuda",
			});
		} finally {
			t.score.mockRestore();
		}
	});

	it("still ends the measurement when the scorer fails on the pair that it took", async () => {
		// Only a pair that the scorer does not take is scored on the CPU: a
		// run of the scorer that fails is an error, as it was.
		const t = autoPairs({ v360: probeWith({ color_range: "pc" }) });
		t.score.mockImplementation(async (deps, options, context) => {
			if (options.scoring)
				throw new Error("NATIVE_RECEIPT_CPU_PARITY_MISMATCH");
			return t.ordinaryScore(deps, options, context);
		});
		try {
			await expect(
				t.processor.process({ vmafJobId: VMAF_JOB_ID }),
			).rejects.toThrow("NATIVE_RECEIPT_CPU_PARITY_MISMATCH");
			expect(t.job.status).toBe("ERROR");
			// The scorer ran once, and no FFmpeg ran for that pair in its place.
			expect(t.scored("v540")).toHaveLength(1);
			expect(
				t.scored("v540").every(([, options]) => options.scoring !== undefined),
			).toBe(true);
		} finally {
			t.score.mockRestore();
		}
	});

	/** What the scorer says of the encode of 360 lines when it has the pair open. */
	const scorerSays = (said: string) =>
		new NativePairRefusal(
			`NATIVE_SCORING_FAILED (1): bitovp-vmaf: ${said}\n`,
			"GPU_PAIR_FRAME_TIMES",
		);
	const of360 = (path: string) => path.includes("dist-v360-");

	it.each([
		"Inputs must have the same known frame rate; conform them before comparison",
		"Comparison presentation timestamps do not align",
		"Comparison inputs have different frame counts",
	])("scores once more, on the CPU, a pair that the scorer refuses while it runs: %s", async (said) => {
		// ffprobe says the same of every file here, as it does of a Matroska
		// file that leaves frames out: nothing refuses the pair before the run.
		const t = autoPairs({});
		const standIn = t.score.getMockImplementation();
		if (!standIn) throw new Error("Missing scorer stand-in");
		t.score.mockImplementation(async (deps, options, context) => {
			if (options.scoring && of360(options.distortedPath))
				throw scorerSays(said);
			return standIn(deps, options, context);
		});
		try {
			expect(
				await t.processor.process({ vmafJobId: VMAF_JOB_ID }),
			).toMatchObject({ status: "FINISHED", results: 2 });
			// The scorer first, then the ordinary method with the options of a
			// Local CPU measurement.
			const runs = t.scored("v360");
			expect(runs).toHaveLength(2);
			expect(runs[0]?.[1]).toMatchObject({
				scoring: { backend: "cuda", device: 2 },
			});
			expect(runs[1]?.[1]).toMatchObject({ fpsConform: 30, threads: 1 });
			expect(runs[1]?.[1]).not.toHaveProperty("scoring");
			expect(runs[1]?.[1]).not.toHaveProperty("distortedOriginal");
			expect(runs[1]?.[2]?.nativeInflightFrames).toBeUndefined();
			expect(t.filterComplexArgs).toHaveLength(1);
			expect(t.filterComplexArgs[0]).toMatch(
				/^\[0:v\]scale=1920:1080:flags=bicubic,fps=30,settb=AVTB,setpts=N\/FRAME_RATE\/TB\[dist\];\[1:v\]fps=30,/,
			);
			expect(t.of("v360")).toMatchObject({
				selection: { requested: "AUTO", reason: "GPU_PAIR_FRAME_TIMES" },
				scoring: { backend: "cpu", implementation: "libvmaf" },
			});
			// One result for each encode, and the other pair on the GPU.
			expect(t.results).toHaveLength(2);
			expect(t.scored("v540")).toHaveLength(1);
			expect(t.of("v540")).toMatchObject({ scoring: { backend: "cuda" } });
			// Resources: the GPU for the first pass, CPU threads for the second.
			const plans = t.planned.mock.calls
				.map(([request]) => request)
				.filter((request) => of360(request.options.distortedPath));
			expect(plans).toHaveLength(2);
			expect(plans[0]).toMatchObject({
				options: { scoring: { backend: "cuda" } },
				pair: { scoringBackend: "cuda" },
				selectedNativeDevice: 2,
			});
			expect(plans[1]?.options).not.toHaveProperty("scoring");
			expect(plans[1]?.pair).not.toHaveProperty("scoringBackend");
			expect(plans[1]).not.toHaveProperty("selectedNativeDevice");
			// The first pass removed the encode, so the second fetched it again.
			const fetched = (rendition: string) =>
				t.downloaded.filter(({ destPath }) =>
					destPath.includes(`dist-${rendition}-`),
				);
			expect(fetched("v360")).toHaveLength(2);
			expect(fetched("v540")).toHaveLength(1);
			// The measurement keeps its choice of the GPU.
			expect((t.job.params as Row).localSelection).toMatchObject({
				requested: "AUTO",
				backend: "cuda",
				device: 2,
			});
			expect(t.job.status).toBe("FINISHED");
		} finally {
			t.score.mockRestore();
		}
	});

	it("scores a pair no third time", async () => {
		// The ordinary method refuses no pair. Were the second pass to end
		// with a refusal, the measurement ends with it.
		const t = autoPairs({});
		const standIn = t.score.getMockImplementation();
		if (!standIn) throw new Error("Missing scorer stand-in");
		t.score.mockImplementation(async (deps, options, context) => {
			if (of360(options.distortedPath))
				throw scorerSays("Comparison presentation timestamps do not align");
			return standIn(deps, options, context);
		});
		try {
			await expect(
				t.processor.process({ vmafJobId: VMAF_JOB_ID }),
			).rejects.toThrow(
				"NATIVE_SCORING_FAILED (1): bitovp-vmaf: Comparison presentation timestamps do not align",
			);
			expect(t.scored("v360")).toHaveLength(2);
			expect(t.scored("v360")[1]?.[1]).not.toHaveProperty("scoring");
			expect(t.job.status).toBe("ERROR");
		} finally {
			t.score.mockRestore();
		}
	});
});

it("does not score when its CPU selection cannot be persisted", async () => {
	const t = setup({
		job: {
			scoringVersion: VMAF_SCORING_VERSION,
			params: { execution: { backend: "LOCAL", localMode: "CPU" } },
		},
	});
	const update = t.vmafJob.updateMany.getMockImplementation();
	if (!update) throw new Error("Missing update fixture");
	t.vmafJob.updateMany.mockImplementation(async (args) => {
		if ((args.data.params as Row | undefined)?.localSelection)
			return { count: 0 };
		return update(args);
	});
	await expect(t.processor.process({ vmafJobId: VMAF_JOB_ID })).rejects.toThrow(
		"VMAF_LOCAL_SELECTION_NOT_PERSISTED",
	);
	expect(t.runner.run).not.toHaveBeenCalled();
	expect(t.results).toHaveLength(0);
});
it("keeps CLOUD completely outside local selection even with a fatal configured native pair", async () => {
	const selectLocalNative = vi.fn(async () => {
		throw new Error("Cloud inspected GPU");
	});
	const t = setup({
		selectLocalNative,
		nativeSelectionFailure: new Error("invalid configured native pair"),
		cloudScore: async (request) => {
			await writeFile(request.options.logPath, vmafJson([95]));
		},
		job: {
			scoringVersion: VMAF_SCORING_VERSION,
			params: {
				execution: { backend: "CLOUD", profileId: "cloud", budgetUsd: 10 },
			},
		},
	});
	await t.processor.process({ vmafJobId: VMAF_JOB_ID });
	expect(selectLocalNative).not.toHaveBeenCalled();
	expect((t.job.params as Row).localSelection).toBeUndefined();
});

describe("banding measurement integration", () => {
	it.each([
		false,
		true,
	])("measures requested VMAF from older banding-only QC mirrors (combined=%s)", async (combined) => {
		const plan = qcPlan();
		plan.qc = { vmaf: false, banding: true, only: true };
		const t = setup({
			plan,
			bandingScores: [2, 7],
			job: {
				model: "vmaf_v0.6.1",
				scoringVersion: VMAF_SCORING_VERSION,
				triggerKey: `${labManualTriggerPrefix(ENCODING_JOB_ID)}1`,
				params: {
					source: "QC_MIRROR",
					execution: { backend: "LOCAL", localMode: "CPU" },
					...(combined ? { banding: true } : {}),
				},
			},
		});
		await t.processor.process({ vmafJobId: VMAF_JOB_ID });
		expect(t.results).toHaveLength(2);
		for (const result of t.results) {
			expect(result.pooled).toMatchObject({ mean: 95 });
			expect("banding" in (result.pooled as Row)).toBe(combined);
		}
		expect(t.encodingJobWrites).toHaveLength(0);
	});

	const transformedPlan = (
		kind: "trim" | "concat",
		scope: "all" | "partial",
	) => {
		const plan = qcPlan();
		if (kind === "trim")
			plan.trimmingStreams = [
				{
					key: "transformed",
					kind: "TIME_BASED",
					sourceKey: "video",
					offset: 1,
				},
			];
		else
			plan.concatenationStreams = [
				{
					key: "transformed",
					sources: [
						{ sourceKey: "video", position: 0, isMain: true },
						{ sourceKey: "video", position: 1 },
					],
				},
			];
		for (const rendition of plan.renditions as Row[])
			if (
				rendition.codec === "H264" &&
				(scope === "all" || rendition.key === "v360")
			)
				rendition.ingestKey = "transformed";
		return plan;
	};
	const transformations = (["trim", "concat"] as const).flatMap((kind) =>
		(["all", "partial"] as const).map((scope) => ({ kind, scope })),
	);

	it.each(
		transformations,
	)("rejects combined QC before heavy work when comparison references shrink its population (%s)", async ({
		kind,
		scope,
	}) => {
		const plan = transformedPlan(kind, scope);
		plan.qc = { vmaf: true, banding: true, model: "vmaf_v0.6.1" };
		const t = setup({
			plan,
			bandingScores: [2, 7],
			job: { params: { banding: true } },
		});
		await expect(
			t.processor.process({ vmafJobId: VMAF_JOB_ID }),
		).rejects.toThrow("COMBINED_QC_TARGET_POPULATION_MISMATCH");
		expect(t.job.status).toBe("ERROR");
		expect(t.results).toHaveLength(0);
		expect(t.downloaded).toHaveLength(0);
		expect(t.runner.run).not.toHaveBeenCalled();
		expect(t.resolveCredential).not.toHaveBeenCalled();
	});

	it.each(
		transformations,
	)("measures the same transformed output population in banding-only mode (%s)", async ({
		kind,
		scope,
	}) => {
		const plan = transformedPlan(kind, scope);
		plan.qc = { vmaf: false, banding: true };
		const t = setup({
			plan,
			bandingScores: [2, 7],
			job: {
				model: "CAMBI",
				scoringVersion: 11,
				params: { kind: "BANDING", banding: true },
			},
		});
		await t.processor.process({ vmafJobId: VMAF_JOB_ID });
		expect(t.results).toHaveLength(2);
		expect(t.downloaded.every((item) => item.bucket === "out-bucket")).toBe(
			true,
		);
	});

	it("does not finish a banding request that has no eligible outputs", async () => {
		const plan = qcPlan();
		delete plan.qc;
		const t = setup({
			plan,
			job: {
				model: "CAMBI",
				scoringVersion: 11,
				triggerKey: `${labManualTriggerPrefix(ENCODING_JOB_ID)}1`,
				params: { kind: "BANDING", banding: true },
			},
		});
		await expect(
			t.processor.process({ vmafJobId: VMAF_JOB_ID }),
		).rejects.toThrow("BANDING_TARGETS_UNAVAILABLE");
		expect(t.job.status).toBe("ERROR");
		expect(t.results).toHaveLength(0);
		expect(t.runner.run).not.toHaveBeenCalled();
		expect(t.downloaded).toHaveLength(0);
	});

	it.each(
		["LOCAL", "CLOUD"].flatMap((backend) =>
			[undefined, false].map((banding) => ({ backend, banding })),
		),
	)("honors a manual VMAF job's banding intent (%s)", async ({
		backend,
		banding,
	}) => {
		const plan = qcPlan();
		plan.qc = { vmaf: true, banding: true, model: "vmaf_v0.6.1" };
		const execution =
			backend === "CLOUD"
				? { backend: "CLOUD", profileId: "cloud", budgetUsd: 10 }
				: { backend: "LOCAL", localMode: "CPU" };
		const cloudScore = vi.fn(async (request) => {
			await writeFile(request.options.logPath, vmafJson([95]));
		});
		const t = setup({
			plan,
			bandingScores: [6, 12],
			cloudScore,
			job: {
				triggerKey: `${labManualTriggerPrefix(ENCODING_JOB_ID)}1`,
				params: { execution, ...(banding !== undefined ? { banding } : {}) },
			},
		});
		await t.processor.process({ vmafJobId: VMAF_JOB_ID });
		expect(t.results).toHaveLength(2);
		expect(
			t.results.every((result) => !("banding" in (result.pooled as Row))),
		).toBe(true);
		expect((t.job.params as Row).bandingSelection).toBeUndefined();
		expect(t.filterComplexArgs.some((graph) => graph.includes("model=:"))).toBe(
			false,
		);
		if (backend === "CLOUD") expect(cloudScore).toHaveBeenCalledTimes(2);
	});

	it.each([
		"VMAF",
		"PSNR",
	])("measures banding from existing %s QC-only mirrors without adding it to the source plan", async (metric) => {
		const plan = qcPlan();
		plan.qc = {
			vmaf: metric === "VMAF",
			psnr: metric === "PSNR",
			model: "vmaf_v0.6.1",
			only: true,
		};
		const t = setup({
			plan,
			bandingScores: [2, 7],
			job: {
				model: "CAMBI",
				scoringVersion: 11,
				triggerKey: `${labManualTriggerPrefix(ENCODING_JOB_ID)}1`,
				params: { kind: "BANDING", banding: true, source: "QC_MIRROR" },
			},
		});
		await t.processor.process({ vmafJobId: VMAF_JOB_ID });
		expect(t.results).toHaveLength(2);
		expect(
			t.downloaded.every(
				(item) => item.bucket === "out-bucket" && item.key.includes("/qc/"),
			),
		).toBe(true);
		expect(t.encodingJobWrites).toHaveLength(0);
	});

	it("measures an existing manual MP4 without any enabled source QC or reference", async () => {
		const plan = qcPlan();
		delete plan.qc;
		const t = setup({
			plan,
			bandingScores: [2, 7],
			job: {
				model: "CAMBI",
				scoringVersion: 11,
				triggerKey: `${labManualTriggerPrefix(ENCODING_JOB_ID)}1`,
				params: { kind: "BANDING", banding: true, source: "OUTPUT_MP4" },
			},
		});
		await t.processor.process({ vmafJobId: VMAF_JOB_ID });
		expect(t.results).toHaveLength(2);
		expect(
			t.downloaded.every(
				(item) => item.bucket === "out-bucket" && !item.key.includes("/qc/"),
			),
		).toBe(true);
		expect(t.encodingJobWrites).toHaveLength(0);
	});

	it("keeps full timing decode, persistence and private cleanup within one composite lease", async () => {
		let active = false;
		let owned = 0;
		const plans: unknown[] = [];
		const localResources = createLocalVmafResources({
			readResources: () => ({
				cpuCapacity: 8,
				reserveBytes: 0,
				budgetBytes: 8 * 1024 ** 3,
			}),
			execute: async (plan, signal, work) => {
				plans.push(plan);
				active = true;
				try {
					return await work(signal, async () => {
						expect(active).toBe(true);
						owned++;
					});
				} finally {
					expect(
						readdirSync(join(workDir, VMAF_JOB_ID)).some((name) =>
							name.endsWith(".json"),
						),
					).toBe(false);
					active = false;
				}
			},
		});
		const plan = qcPlan();
		plan.qc = { vmaf: true, banding: true, model: "vmaf_v0.6.1" };
		const t = setup({
			plan,
			bandingScores: [0, 6],
			localResources,
			job: { params: { banding: true } },
		});
		t.deps.localRunner = {
			...t.runner,
			run: async (bin, args, options) => {
				if (args.includes("-show_frames")) expect(active).toBe(true);
				return t.runner.run(bin, args, options);
			},
		};
		t.vmafResult.create.mockImplementation(async ({ data }: { data: Row }) => {
			expect(active).toBe(true);
			expect(owned).toBeGreaterThan(0);
			t.results.push(data);
			return { id: `r${t.results.length}`, ...data };
		});
		await t.processor.process({ vmafJobId: VMAF_JOB_ID });
		expect(plans).toHaveLength(2);
		expect(t.results).toHaveLength(2);
	});

	it("does not publish a banding result after losing resource ownership", async () => {
		let checks = 0;
		const localResources = createLocalVmafResources({
			readResources: () => ({
				cpuCapacity: 8,
				reserveBytes: 0,
				budgetBytes: 8 * 1024 ** 3,
			}),
			execute: async (_plan, signal, work) =>
				work(signal, async () => {
					if (++checks > 1) throw new Error("LEASE_LOST");
				}),
		});
		const plan = qcPlan();
		plan.qc = { vmaf: false, banding: true };
		const t = setup({
			plan,
			bandingScores: [0, 6],
			localResources,
			job: {
				model: "CAMBI",
				scoringVersion: 11,
				params: { kind: "BANDING", banding: true },
			},
		});
		await expect(
			t.processor.process({ vmafJobId: VMAF_JOB_ID }),
		).rejects.toThrow("LEASE_LOST");
		expect(t.results).toHaveLength(0);
		expect(t.job.status).toBe("ERROR");
	});

	it("scores every encoded frame without reading a reference or resolving a VMAF model", async () => {
		const plan = qcPlan();
		plan.qc = { vmaf: false, banding: true };
		const resolveModelPath = vi.fn(() => {
			throw new Error("no model allowed");
		});
		const t = setup({
			plan,
			bandingScores: [0, 6, 12],
			bandingVersion: "86da14d",
			subsample: 4,
			resolveModelPath,
			job: {
				model: "CAMBI",
				scoringVersion: 11,
				params: { kind: "BANDING", banding: true },
			},
		});
		const result = await t.processor.process({ vmafJobId: VMAF_JOB_ID });
		expect(result.status).toBe("FINISHED");
		expect(t.results).toHaveLength(2);
		expect(t.downloaded.every((item) => item.bucket === "out-bucket")).toBe(
			true,
		);
		expect(resolveModelPath).not.toHaveBeenCalled();
		const stored = t.results[0];
		if (!stored) throw new Error("banding result was not persisted");
		expect(stored.pooled).toMatchObject({
			banding: { min: 0, max: 12, mean: 6, frameCount: 3 },
		});
		expect(stored.pooled).not.toHaveProperty("mean");
		const frames = JSON.parse(
			gunzipSync(stored.framesGzip as Uint8Array).toString(),
		);
		expect(frames).toMatchObject({ kind: "QC_FRAMES", version: 1 });
		expect(frames.vmaf).toBeUndefined();
		expect(frames.banding).toHaveLength(3);
		expect(stored.provenance).toMatchObject({
			bandingExecution: {
				backend: "cpu",
				libvmafVersion: "86da14d",
				decisionSource: "CPU_REFERENCE",
			},
		});
		expect(stored.provenance).not.toHaveProperty("reference");
	});

	it("stores combined VMAF and banding in one result per rendition and preserves the VMAF generation", async () => {
		const plan = qcPlan();
		plan.qc = { vmaf: true, banding: true, model: "vmaf_v0.6.1" };
		const t = setup({
			plan,
			bandingScores: [0, 6, 12],
			job: { scoringVersion: VMAF_SCORING_VERSION, params: { banding: true } },
		});
		await t.processor.process({ vmafJobId: VMAF_JOB_ID });
		expect(t.results).toHaveLength(2);
		expect(t.job.scoringVersion).toBe(VMAF_SCORING_VERSION);
		const stored = t.results[0];
		if (!stored) throw new Error("combined QC result was not persisted");
		expect(stored.pooled).toMatchObject({ mean: 95, banding: { max: 12 } });
		const frames = JSON.parse(
			gunzipSync(stored.framesGzip as Uint8Array).toString(),
		);
		expect(frames.vmaf).toHaveLength(5);
		expect(frames.banding).toHaveLength(3);
		expect(
			t.downloaded.filter((item) => item.bucket === "src-bucket"),
		).toHaveLength(1);
	});

	it("persists warning ranges and lets a warning-only delivery gate pass", async () => {
		const plan = qcPlan();
		plan.qc = {
			vmaf: false,
			banding: true,
			gate: {
				rules: [
					{
						metric: "CAMBI_MAX",
						scope: "PER_RENDITION",
						lte: 5,
						severity: "WARN",
					},
				],
				onFail: "BLOCK_MANIFESTS",
			},
		};
		const t = setup({
			plan,
			bandingScores: [5, 6, 12],
			job: {
				model: "CAMBI",
				scoringVersion: 11,
				params: { kind: "BANDING", banding: true },
			},
		});
		await t.processor.process({ vmafJobId: VMAF_JOB_ID });
		expect(t.job.gateVerdict).toMatchObject({ pass: true });
		expect(t.results[0]?.pooled).toMatchObject({
			bandingAssessment: {
				severity: "WARN",
				warningThreshold: 5,
				ranges: [
					{
						startFrame: 1,
						endFrame: 2,
						startSeconds: 0.04,
						endSeconds: 0.12,
						peak: 12,
						severity: "WARN",
					},
				],
			},
		});
		expect(t.queueAdds).toHaveLength(1);
	});
});

it("rejects a pinned native selection with an inconsistent CPU generation before changing partial results", async () => {
	const native = {
		backend: "cuda" as const,
		device: 2,
		identity: {
			sourceSha256: "a".repeat(64),
			binarySha256: "b".repeat(64),
			supervisorBinarySha256: "c".repeat(64),
			deviceUuid: "GPU-fixture",
		},
	};
	const model = "vmaf_v1.0.16_3d0h";
	const t = setup({
		selectLocalNative: async () => native,
		job: {
			model,
			scoringVersion: VMAF_SCORING_VERSION,
			params: {
				execution: { backend: "LOCAL", localMode: "AUTO" },
				localSelection: { version: 1, requested: "AUTO", model, ...native },
			},
		},
	});
	t.results.push({
		renditionRef: { renditionKey: "v360" },
		pooled: { mean: 90 },
	});
	await expect(t.processor.process({ vmafJobId: VMAF_JOB_ID })).rejects.toThrow(
		"VMAF_LOCAL_SELECTION_GENERATION_CHANGED",
	);
	expect(t.job.scoringVersion).toBe(VMAF_SCORING_VERSION);
	expect(t.results).toHaveLength(1);
	expect(t.runner.run).not.toHaveBeenCalled();
});

describe("explicit lossless reference preparation", () => {
	const evidence = {
		version: 1 as const,
		method: "LOSSLESS_DISPLAY_SCALE_REMUX" as const,
		comparisonSpace: "CODED_RASTER" as const,
		inputSha256: "d".repeat(64),
		preparedSha256: "e".repeat(64),
		preparedBytes: 1024,
		sourceDisplayMatrix: [34475, 0, 0, 0, 34467, 0, 0, 0, 1073741824] as [
			number,
			number,
			number,
			number,
			number,
			number,
			number,
			number,
			number,
		],
		width: 1920,
		height: 1080,
		codec: "h264",
		pixelFormat: "yuv420p",
		timeBase: "1/2400",
		packetCount: 5,
		frameCount: 5,
		packetSha256: "1".repeat(64),
		frameSha256: "2".repeat(64),
		streamIdentitySha256: "3".repeat(64),
		packetTimingVerified: true as const,
		frameTimingVerified: true as const,
	};

	function preparedHarness() {
		return autoNativeFailureHarness(true, {
			download: async (args) => ({
				bucket: args.bucket,
				key: args.key,
				pinned: true,
				sha256: evidence.inputSha256,
				bytes: 1234,
			}),
			job: {
				triggerKey: `${labManualTriggerPrefix(ENCODING_JOB_ID)}prepared`,
				params: {
					execution: { backend: "LOCAL", localMode: "AUTO" },
					referencePreparation: "LOSSLESS_DISPLAY_SCALE_REMUX",
				},
			},
		});
	}

	function mockScore() {
		return vi
			.spyOn(localScoring, "runLocalVmafScore")
			.mockImplementation(async (_deps, options) => ({
				run: { code: 0, stderr: "" },
				log: JSON.parse(vmafJson([95, 96, 94, 97, 93])),
				execution: {
					version: 1,
					requestedDecode: "cpu",
					decode: {
						reference: { backend: "cpu" },
						distorted: { backend: "cpu" },
					},
					attempts: 1,
					scoring: {
						backend: "cuda",
						implementation: "bitovp-owned",
						model: options.model,
						modelSha256: "f".repeat(64),
						features: ["a", "b", "c", "d", "e", "f", "g"],
						bitDepth: 10,
						distortedOriginal: { width: 1920, height: 1080, bitdepth: 8 },
						officialRevision: NATIVE_OFFICIAL_REVISION,
						sourceSha256: "a".repeat(64),
						device: {
							index: 2,
							name: "Fixture GPU",
							uuid: "GPU-fixture",
							vendorId: 0x10de,
							deviceId: 1,
							integrated: false,
						},
						cpuParity: {
							checked: true,
							featureCount: 35,
							scoreCount: 5,
							maxFeatureError: 0,
							maxScoreError: 0,
						},
					},
				} satisfies LocalVmafExecution,
			}));
	}

	function preparationResources() {
		const requests: VmafResourceLeaseRequest[] = [];
		const events: string[] = [];
		const requested = resourceDeferred(),
			grant = resourceDeferred();
		const lease = new AbortController();
		let cpuHeld = false;
		let denied = false;
		const readResources = () => ({
			cpuCapacity: 8,
			memoryLimitBytes: 8 * 1024 ** 3,
			budgetBytes: 8 * 1024 ** 3,
			reserveBytes: 0,
		});
		const shared = createSharedVmafExecution({
			hostKey: async () => "a".repeat(64),
			readResources,
			leases: {
				async run(request, signal, work) {
					requests.push(request);
					if (request.deviceKey) {
						events.push("gpu-request");
						expect(cpuHeld).toBe(false);
						return work({
							signal,
							assertOwned: async () => signal.throwIfAborted(),
							fitsHeadroom: async () => true,
						});
					}
					events.push("cpu-request");
					requested.resolve();
					await grant.promise;
					if (denied) throw new Error("PREPARATION_ADMISSION_DENIED");
					cpuHeld = true;
					const runSignal = AbortSignal.any([signal, lease.signal]);
					try {
						return await work({
							signal: runSignal,
							assertOwned: async () => {
								expect(cpuHeld).toBe(true);
								runSignal.throwIfAborted();
							},
							fitsHeadroom: async () => true,
						});
					} finally {
						cpuHeld = false;
						events.push("cpu-release");
					}
				},
			},
		});
		shared.registerDevice({
			deviceKey: "e".repeat(64),
			read: async () => ({
				totalBytes: 8 * 1024 ** 3,
				availableBytes: 8 * 1024 ** 3,
			}),
		});
		const resources = createLocalVmafResources({
			concurrency: 1,
			readResources,
			execute: (plan, signal, work) => shared.run(plan, signal, work),
		});
		return {
			resources,
			requests,
			events,
			requested,
			grant,
			lease,
			get cpuHeld() {
				return cpuHeld;
			},
			deny() {
				denied = true;
			},
		};
	}

	it("admits the complete proof under a whole-host CPU lease before capacity-one GPU preparation", async () => {
		const authority = preparationResources(),
			proofEntered = resourceDeferred(),
			finishProof = resourceDeferred();
		const t = preparedHarness();
		t.deps.localResources = authority.resources;
		const prepare = vi
			.spyOn(referencePreparation, "prepareDisplayScaleReference")
			.mockImplementation(async (args) => {
				authority.events.push("proof");
				proofEntered.resolve();
				await finishProof.promise;
				expect(authority.cpuHeld).toBe(true);
				expect(args.signal?.aborted).toBe(false);
				return {
					path: args.preparedPath,
					probe: RESOURCE_PROBE_JSON,
					evidence: {
						...evidence,
						get inputSha256() {
							expect(authority.cpuHeld).toBe(true);
							return evidence.inputSha256;
						},
					},
				};
			});
		const score = mockScore();
		const running = t.processor.process({ vmafJobId: VMAF_JOB_ID });
		const outcome = running.catch((error: unknown) => error);
		try {
			await vi.waitFor(() =>
				expect(authority.events.length).toBeGreaterThan(0),
			);
			expect(authority.events).toEqual(["cpu-request"]);
			expect(prepare).not.toHaveBeenCalled();
			expect(score).not.toHaveBeenCalled();
			expect(authority.requests[0]?.requested).toEqual({
				cpuMilliCores: 8000,
				hostBytes: 8 * 1024 ** 3,
			});
			authority.grant.resolve();
			await proofEntered.promise;
			expect(authority.cpuHeld).toBe(true);
			expect(score).not.toHaveBeenCalled();
			finishProof.resolve();
			expect(await outcome).toMatchObject({ status: "FINISHED", results: 2 });
			expect(prepare).toHaveBeenCalledTimes(1);
			expect(authority.events.slice(0, 4)).toEqual([
				"cpu-request",
				"proof",
				"cpu-release",
				"gpu-request",
			]);
			expect(score).toHaveBeenCalledTimes(2);
		} finally {
			authority.grant.resolve();
			finishProof.resolve();
			t.vmafJob.findUnique.mockResolvedValue(null);
			await outcome;
			prepare.mockRestore();
			score.mockRestore();
		}
	});

	it.each([
		"denied",
		"lost",
		"missing",
	] as const)("does not score or publish when preparation authority is %s", async (failure) => {
		const authority = preparationResources();
		authority.grant.resolve();
		if (failure === "denied") authority.deny();
		const t = preparedHarness();
		t.deps.localResources =
			failure === "missing"
				? {
						begin(signal) {
							return {
								...authority.resources.begin(signal),
								exclusivePrepared: undefined,
							};
						},
					}
				: authority.resources;
		const prepare = vi
			.spyOn(referencePreparation, "prepareDisplayScaleReference")
			.mockImplementation(async (args) => {
				if (failure === "lost") {
					expect(authority.cpuHeld).toBe(true);
					authority.lease.abort(new Error("PREPARATION_LEASE_LOST"));
					expect(args.signal?.aborted).toBe(true);
				}
				return {
					path: args.preparedPath,
					probe: RESOURCE_PROBE_JSON,
					evidence,
				};
			});
		const score = mockScore();
		try {
			await expect(
				t.processor.process({ vmafJobId: VMAF_JOB_ID }),
			).rejects.toThrow(/PREPARATION_(?:ADMISSION|LEASE)/);
			expect(t.job.status).toBe("ERROR");
			expect(t.results).toHaveLength(0);
			expect(score).not.toHaveBeenCalled();
			if (failure !== "lost") expect(prepare).not.toHaveBeenCalled();
		} finally {
			prepare.mockRestore();
			score.mockRestore();
		}
	});

	it("scores the prepared raster once per reference and persists its proof with each unchanged source identity", async () => {
		const t = preparedHarness();
		const prepare = vi
			.spyOn(referencePreparation, "prepareDisplayScaleReference")
			.mockImplementation(async (args) => ({
				path: args.preparedPath,
				probe: RESOURCE_PROBE_JSON,
				evidence,
			}));
		const score = mockScore();
		try {
			expect(
				await t.processor.process({ vmafJobId: VMAF_JOB_ID }),
			).toMatchObject({ status: "FINISHED", results: 2 });
			expect(prepare).toHaveBeenCalledTimes(1);
			const preparedPath = prepare.mock.calls[0]?.[0].preparedPath;
			for (const call of score.mock.calls)
				expect(call[1].referencePath).toBe(preparedPath);
			for (const result of t.results)
				expect(result.provenance).toMatchObject({
					reference: {
						bucket: "src-bucket",
						key: "src/master.mkv",
						sha256: evidence.inputSha256,
					},
					referencePreparation: evidence,
					localExecution: { scoring: { backend: "cuda" } },
				});
		} finally {
			prepare.mockRestore();
			score.mockRestore();
		}
	});

	it("ends with the refusal, and scores nothing on the CPU, when the scorer does not take a pair of a prepared reference", async () => {
		// A prepared reference is a request for the scorer itself: the CPU
		// path takes no prepared reference, so no pair is scored in its place.
		const t = preparedHarness();
		const prepare = vi
			.spyOn(referencePreparation, "prepareDisplayScaleReference")
			.mockImplementation(async (args) => ({
				path: args.preparedPath,
				probe: JSON.stringify({
					streams: [
						{
							...JSON.parse(RESOURCE_PROBE_JSON).streams[0],
							color_range: "pc",
						},
					],
				}),
				evidence,
			}));
		const score = mockScore();
		try {
			await expect(
				t.processor.process({ vmafJobId: VMAF_JOB_ID }),
			).rejects.toThrow(
				"GPU scoring cannot compare this pair as libvmaf through FFmpeg does: the reference is full range and the encode is limited range, and FFmpeg converts one of the two before libvmaf compares them. Use Local CPU for this pair.",
			);
			expect(t.job.status).toBe("ERROR");
			expect(score).not.toHaveBeenCalled();
			expect(t.results).toHaveLength(0);
			expect(t.filterComplexArgs).toHaveLength(0);
		} finally {
			prepare.mockRestore();
			score.mockRestore();
		}
	});

	it("ends with what the scorer says of a pair of a prepared reference while it runs, and scores nothing on the CPU", async () => {
		const t = preparedHarness();
		const prepare = vi
			.spyOn(referencePreparation, "prepareDisplayScaleReference")
			.mockImplementation(async (args) => ({
				path: args.preparedPath,
				probe: RESOURCE_PROBE_JSON,
				evidence,
			}));
		const failure =
			"NATIVE_SCORING_FAILED (1): bitovp-vmaf: Comparison presentation timestamps do not align";
		const score = vi
			.spyOn(localScoring, "runLocalVmafScore")
			.mockRejectedValue(
				new NativePairRefusal(`${failure}\n`, "GPU_PAIR_FRAME_TIMES"),
			);
		try {
			await expect(
				t.processor.process({ vmafJobId: VMAF_JOB_ID }),
			).rejects.toThrow(failure);
			expect(t.job.status).toBe("ERROR");
			expect(score).toHaveBeenCalled();
			expect(
				score.mock.calls.every(
					([, options]) => options.scoring?.backend === "cuda",
				),
			).toBe(true);
			expect(t.results).toHaveLength(0);
			expect(t.filterComplexArgs).toHaveLength(0);
		} finally {
			prepare.mockRestore();
			score.mockRestore();
		}
	});

	it("keeps the measurement failed when verified reference coverage does not match the scores", async () => {
		const t = preparedHarness();
		const prepare = vi
			.spyOn(referencePreparation, "prepareDisplayScaleReference")
			.mockImplementation(async (args) => ({
				path: args.preparedPath,
				probe: RESOURCE_PROBE_JSON,
				evidence: { ...evidence, frameCount: 4 },
			}));
		const score = mockScore();
		try {
			await expect(
				t.processor.process({ vmafJobId: VMAF_JOB_ID }),
			).rejects.toThrow("VMAF_REFERENCE_PREPARATION_FRAME_COUNT_MISMATCH");
			expect(t.job.status).toBe("ERROR");
			expect(t.results).toHaveLength(0);
		} finally {
			prepare.mockRestore();
			score.mockRestore();
		}
	});

	it("stops before scoring if reference preparation fails", async () => {
		const t = preparedHarness();
		const prepare = vi
			.spyOn(referencePreparation, "prepareDisplayScaleReference")
			.mockRejectedValue(
				new Error("REFERENCE_PREPARATION_CONTENT_OR_TIMING_MISMATCH"),
			);
		const score = mockScore();
		try {
			await expect(
				t.processor.process({ vmafJobId: VMAF_JOB_ID }),
			).rejects.toThrow("REFERENCE_PREPARATION_CONTENT_OR_TIMING_MISMATCH");
			expect(t.results).toHaveLength(0);
			expect(score).not.toHaveBeenCalled();
		} finally {
			prepare.mockRestore();
			score.mockRestore();
		}
	});
	it.each([
		{
			name: "unknown policy",
			triggerKey: `${labManualTriggerPrefix(ENCODING_JOB_ID)}test`,
			policy: "IGNORE_ALL_TRANSFORMS",
			localMode: "CPU",
		},
		{
			name: "automatic QC",
			triggerKey: `vod-auto:${ENCODING_JOB_ID}`,
			policy: "LOSSLESS_DISPLAY_SCALE_REMUX",
			localMode: "AUTO",
		},
		{
			name: "explicit CPU mode",
			triggerKey: `${labManualTriggerPrefix(ENCODING_JOB_ID)}test`,
			policy: "LOSSLESS_DISPLAY_SCALE_REMUX",
			localMode: "CPU",
		},
	])("rejects $name before downloading media", async (item) => {
		const t = setup({
			job: {
				triggerKey: item.triggerKey,
				params: {
					referencePreparation: item.policy,
					execution: { backend: "LOCAL", localMode: item.localMode },
				},
			},
		});
		await expect(
			t.processor.process({ vmafJobId: VMAF_JOB_ID }),
		).rejects.toThrow("VMAF_REFERENCE_PREPARATION_POLICY_INVALID");
		expect(t.job.status).toBe("ERROR");
		expect(t.results).toHaveLength(0);
		expect(t.downloaded).toHaveLength(0);
	});

	it("rejects AUTO selecting CPU rather than preparing an unrequested CPU comparison", async () => {
		const t = setup({
			job: {
				triggerKey: `${labManualTriggerPrefix(ENCODING_JOB_ID)}test`,
				params: {
					referencePreparation: "LOSSLESS_DISPLAY_SCALE_REMUX",
					execution: { backend: "LOCAL", localMode: "AUTO" },
				},
			},
		});
		await expect(
			t.processor.process({ vmafJobId: VMAF_JOB_ID }),
		).rejects.toThrow("VMAF_REFERENCE_PREPARATION_GPU_REQUIRED");
		expect(t.job.status).toBe("ERROR");
		expect(t.results).toHaveLength(0);
		expect(t.downloaded).toHaveLength(0);
	});
});

describe("picture sizes that libvmaf cannot score with a VMAF v1 model", () => {
	const v1 = "vmaf_v1.0.16_3d0h";
	/** A probe with other values for its video stream. */
	const streamWith = (probe: string, extra: Row) => {
		const parsed = JSON.parse(probe);
		Object.assign(parsed.streams[0], extra);
		return JSON.stringify(parsed);
	};
	const probeOf = (width: number, height: number, pixelFormat?: string) =>
		JSON.stringify({
			streams: [
				{
					codec_type: "video",
					codec_name: "h264",
					width,
					height,
					...(pixelFormat ? { pix_fmt: pixelFormat } : {}),
					r_frame_rate: "25/1",
					avg_frame_rate: "25/1",
					sample_aspect_ratio: "1:1",
					duration: "10",
					nb_frames: "250",
				},
			],
		});
	const scoringRuns = (t: ReturnType<typeof setup>) =>
		vi
			.mocked(t.runner.run)
			.mock.calls.filter(([, argv]) => argv.includes("-filter_complex"));

	it("refuses a reference that is too small before FFmpeg scores, and says what to do", async () => {
		const t = setup({
			job: { model: v1 },
			probeJson: probeOf(256, 144, "yuv420p"),
			resolveModelPath: () => `/opt/vmaf/model/${v1}.json`,
		});
		await expect(
			t.processor.process({ vmafJobId: VMAF_JOB_ID }),
		).rejects.toThrow(
			`VMAF model "${v1}" cannot score 4:2:0 pictures of 256x144: it needs at least 160 pixels in width and in height, and at least 216 in one of the two. The two pictures are compared at the size of the reference. Use a model of the vmaf_v0.6.1 family, which scores smaller pictures, or a larger reference.`,
		);
		expect(t.job.status).toBe("ERROR");
		expect(String(t.job.error)).toContain("cannot score 4:2:0 pictures");
		expect(scoringRuns(t)).toHaveLength(0);
		expect(t.results).toHaveLength(0);
	});

	it.each([
		// The same reference with a model that has no such limit.
		["vmaf_v0.6.1", 256, 144, "yuv420p"],
		// 4:4:4 chroma planes are as large as the pictures.
		[v1, 256, 144, "yuv444p10le"],
		// The smallest 4:2:0 pictures that the model scores.
		[v1, 216, 160, "yuv420p"],
		// A reference that FFmpeg converts before libvmaf, to a format that
		// follows from an encode of which it is not known: the layout of the
		// comparison is not known, so libvmaf decides. Every file has this
		// format here.
		[v1, 256, 144, "nv12"],
		[v1, 256, 144, undefined],
	] as const)("scores %s at %ix%i (%s)", async (model, width, height, pixelFormat) => {
		const t = setup({
			job: { model },
			probeJson: probeOf(width, height, pixelFormat),
			resolveModelPath: (name) => `/opt/vmaf/model/${name}.json`,
		});
		expect(await t.processor.process({ vmafJobId: VMAF_JOB_ID })).toMatchObject(
			{ status: "FINISHED", results: 2 },
		);
		expect(scoringRuns(t)).toHaveLength(2);
		// The check takes the reference's chroma layout as the comparison's
		// where libvmaf takes the reference's format, and the encode's where
		// FFmpeg converts the reference. Both hold while the encode's leg has a
		// scale filter and the reference's has none: FFmpeg then lets that
		// filter give the encode the reference's format, or converts the
		// reference to the format that the filter gives the encode.
		for (const [, argv] of scoringRuns(t))
			expect(argv[argv.indexOf("-filter_complex") + 1]).toMatch(
				new RegExp(
					`^\\[0:v\\][^;]*scale=${width}:${height}:flags=bicubic[^;]*\\[dist\\];\\[1:v\\](?![^;]*scale=)`,
				),
			);
	});

	it("names the limit when libvmaf meets it in a comparison whose chroma layout was not known", async () => {
		const t = setup({ job: { model: v1 } });
		const crash = (stderr: string) =>
			vi
				.mocked(t.runner.run)
				.mockImplementation(async (_bin: string, argv: string[]) =>
					argv.includes("-show_streams")
						? { code: 0, stdout: probeOf(256, 144, "nv12"), stderr: "" }
						: { code: null, stdout: "", stderr },
				);
		// libvmaf's last words before its segmentation fault.
		crash(
			"[Parsed_libvmaf_4 @ 0x5581] libvmaf WARNING something\nlibvmaf ERROR SpEED: image too small, operating width or height is 0\n",
		);
		await expect(
			t.processor.process({ vmafJobId: VMAF_JOB_ID }),
		).rejects.toThrow(
			`VMAF model "${v1}" cannot score pictures of 256x144: libvmaf reports that they are too small for its SpEED feature. The two pictures are compared at the size of the reference. Use a model of the vmaf_v0.6.1 family, which scores smaller pictures, or a larger reference.`,
		);
		expect(t.job.status).toBe("ERROR");
		expect(scoringRuns(t).length).toBeGreaterThan(0);
	});

	it("leaves every other crash of libvmaf as it reports it", async () => {
		const t = setup({ job: { model: v1 } });
		vi.mocked(t.runner.run).mockImplementation(
			async (_bin: string, argv: string[]) =>
				argv.includes("-show_streams")
					? { code: 0, stdout: probeOf(256, 144, "nv12"), stderr: "" }
					: { code: null, stdout: "", stderr: "double free or corruption\n" },
		);
		await expect(
			t.processor.process({ vmafJobId: VMAF_JOB_ID }),
		).rejects.toThrow(
			/libvmaf failed for rendition v\d+ \(code null\): double free or corruption/,
		);
	});

	const nativeRun = (run: { code: number | null; stderr: string }) =>
		vi
			.spyOn(localScoring, "runLocalVmafScore")
			.mockImplementation(async (_deps, options) => ({
				run,
				execution: {
					version: 1,
					requestedDecode: "cpu",
					decode: {
						reference: { backend: "cpu" },
						distorted: { backend: "cpu" },
					},
					scoring: {
						backend: "cpu",
						implementation: "libvmaf",
						model: options.model,
					},
					attempts: 1,
				},
				log: JSON.parse(vmafJson([95])),
			}));
	const nativeSetup = (
		backend: "cuda" | "vulkan",
		reference: string,
		encode: string = reference,
	) => {
		const localRunner: ProcessRunner = {
			spawn: vi.fn(() => {
				throw new Error("Unexpected spawn");
			}),
			run: vi.fn(),
		};
		const planned = vi.fn<
			NonNullable<VmafProcessorDeps["resolveLocalResources"]>
		>(async () => ({
			threads: 1,
			concurrency: 2,
			estimatedBytes: 1024,
			exclusive: false,
			manualFallback: false,
			nativeDevice: 2,
			nativeInflightFrames: 2,
		}));
		const t = setup({
			localResources: sharedTestResources(),
			localRunner,
			scoringBackend: backend,
			job: { model: v1, scoringVersion: VMAF_SCORING_VERSION },
			resolveModelPath: () => `/opt/vmaf/model/${v1}.json`,
			resolveLocalResources: planned,
		});
		const raw = vi.mocked(t.runner.run).getMockImplementation();
		if (!raw) throw new Error("Missing raw runner fixture");
		const probed = async (bin: string, argv: string[], options?: unknown) =>
			argv.includes("-show_streams")
				? {
						code: 0,
						stderr: "",
						stdout: /\/ref-\d+\./.test(argv.at(-1) ?? "") ? reference : encode,
					}
				: raw(bin, argv, options as never);
		vi.mocked(t.runner.run).mockImplementation(probed);
		vi.mocked(localRunner.run).mockImplementation(probed);
		return Object.assign(t, { planned });
	};

	it.each([
		"cuda",
		"vulkan",
	] as const)("holds the %s scorer to libvmaf's limits for 4:2:0 pictures before it runs", async (backend) => {
		const native = nativeRun({ code: 0, stderr: "" });
		try {
			// The scorer compares 4:2:0 pictures and declares no encode, so its
			// limits are those of libvmaf for that layout. It refuses in words
			// that name none.
			const small = nativeSetup(backend, probeOf(256, 144, "yuv420p"));
			await expect(
				small.processor.process({ vmafJobId: VMAF_JOB_ID }),
			).rejects.toThrow(
				`VMAF model "${v1}" cannot score 4:2:0 pictures of 256x144: it needs at least 160 pixels in width and in height, and at least 216 in one of the two. The two pictures are compared at the size of the reference. Use a model of the vmaf_v0.6.1 family, which scores smaller pictures, or a larger reference.`,
			);
			expect(small.job.status).toBe("ERROR");
			expect(native).not.toHaveBeenCalled();
			expect(small.planned).not.toHaveBeenCalled();

			// The smallest pictures that the model scores, and an encode below
			// CAMBI's range for a declared encode: nothing of it is declared.
			const edge = nativeSetup(
				backend,
				probeOf(216, 160, "yuv420p"),
				probeOf(128, 72, "yuv420p"),
			);
			expect(
				await edge.processor.process({ vmafJobId: VMAF_JOB_ID }),
			).toMatchObject({ status: "FINISHED", results: 2 });
			expect(native).toHaveBeenCalledTimes(2);
			// A pair that is scored has resources planned for it, by the planner
			// that the refusals of this file leave uncalled.
			expect(edge.planned).toHaveBeenCalled();
			for (const [, options] of native.mock.calls)
				expect(options).toMatchObject({
					scoring: { backend },
					distortedOriginal: { width: 128, height: 72, bitdepth: 8 },
				});
		} finally {
			native.mockRestore();
		}
	});

	it.each([
		"cuda",
		"vulkan",
	] as const)("leaves a failure of the %s scorer in its own words", async (backend) => {
		// A run of the scorer that fails throws what the scorer printed
		// (`runNativeVmafScore`). The sentences about libvmaf's limits are for
		// the check before the run and for a run of FFmpeg.
		const failure =
			"NATIVE_SCORING_FAILED (1): bitovp-vmaf: input is too small or too large for official SpEED chroma blocks";
		const native = vi
			.spyOn(localScoring, "runLocalVmafScore")
			.mockRejectedValue(new Error(failure));
		try {
			const t = nativeSetup(backend, probeOf(640, 360, "yuv420p"));
			await expect(
				t.processor.process({ vmafJobId: VMAF_JOB_ID }),
			).rejects.toMatchObject({ message: failure });
			expect(t.job.status).toBe("ERROR");
			expect(native).toHaveBeenCalled();
		} finally {
			native.mockRestore();
		}
	});

	it.each([
		[
			"cuda",
			probeOf(1920, 1080, "yuv422p10le"),
			probeOf(960, 540, "yuv420p"),
			"GPU scoring cannot compare this pair as libvmaf through FFmpeg does: the reference's pixel format is yuv422p10le, and GPU scoring compares 8-bit and 10-bit 4:2:0 pictures only, for references in yuv420p and yuv420p10le. Use Local CPU for this pair.",
		],
		[
			"vulkan",
			probeOf(1920, 1080, "yuvj420p"),
			probeOf(960, 540, "yuv420p"),
			"GPU scoring cannot compare this pair as libvmaf through FFmpeg does: the reference is full range and the encode is limited range, and FFmpeg converts one of the two before libvmaf compares them. Use Local CPU for this pair.",
		],
		[
			"cuda",
			probeOf(1920, 1080, "yuv420p"),
			probeOf(960, 540, "gbrp"),
			"GPU scoring cannot compare this pair as libvmaf through FFmpeg does: GPU scoring takes no encode in the pixel format gbrp. Use Local CPU for this pair.",
		],
		// A pair that is refused so is not held to a size limit first: Local CPU
		// compares it in another layout, with other limits.
		[
			"vulkan",
			probeOf(256, 144, "yuv444p"),
			probeOf(256, 144, "yuv420p"),
			"GPU scoring cannot compare this pair as libvmaf through FFmpeg does: the reference's pixel format is yuv444p, and GPU scoring compares 8-bit and 10-bit 4:2:0 pictures only, for references in yuv420p and yuv420p10le. Use Local CPU for this pair.",
		],
		// Frames that FFmpeg would repeat or drop, which the scorer pairs in
		// their order: an encode that leaves a slot out, and one of another
		// frame rate.
		[
			"cuda",
			probeOf(1920, 1080, "yuv420p"),
			streamWith(probeOf(960, 540, "yuv420p"), {
				avg_frame_rate: "249/10",
				nb_frames: "249",
			}),
			"GPU scoring cannot compare this pair as libvmaf through FFmpeg does: the encode's frames are not evenly spaced by what ffprobe says of it (r_frame_rate 25/1, avg_frame_rate 249/10), and FFmpeg gives each file one frame per slot of the reference's frame rate, repeating and dropping frames, before libvmaf compares them. Use Local CPU for this pair.",
		],
		[
			"vulkan",
			probeOf(1920, 1080, "yuv420p"),
			streamWith(probeOf(960, 540, "yuv420p"), {
				r_frame_rate: "30/1",
				avg_frame_rate: "30/1",
			}),
			"GPU scoring cannot compare this pair as libvmaf through FFmpeg does: the reference's frame rate is 25/1 and the encode's is 30/1, and GPU scoring takes two files only where FFmpeg names one frame rate for both. Use Local CPU for this pair.",
		],
	] as const)("refuses for the %s scorer a pair that it cannot compare as libvmaf through FFmpeg does, before any scorer runs (%#)", async (backend, reference, encode, message) => {
		const native = nativeRun({ code: 0, stderr: "" });
		try {
			const t = nativeSetup(backend, reference, encode);
			await expect(
				t.processor.process({ vmafJobId: VMAF_JOB_ID }),
			).rejects.toThrow(message);
			expect(t.job.status).toBe("ERROR");
			expect(t.job.error).toContain(message);
			// Neither the GPU scorer nor libvmaf in its place, and no resources
			// planned for either.
			expect(native).not.toHaveBeenCalled();
			expect(scoringRuns(t)).toHaveLength(0);
			expect(t.planned).not.toHaveBeenCalled();
		} finally {
			native.mockRestore();
		}
	});

	it.each([
		"cuda",
		"vulkan",
	] as const)("ends with what the %s scorer says of a pair while it runs, on a worker whose environment names the scorer", async (backend) => {
		// No choice of "Local (GPU if available)" is recorded for such a
		// measurement, so nothing is scored in the scorer's place.
		const failure =
			"NATIVE_SCORING_FAILED (1): bitovp-vmaf: Comparison presentation timestamps do not align";
		const native = vi
			.spyOn(localScoring, "runLocalVmafScore")
			.mockRejectedValue(
				new NativePairRefusal(`${failure}\n`, "GPU_PAIR_FRAME_TIMES"),
			);
		try {
			const t = nativeSetup(
				backend,
				probeOf(1920, 1080, "yuv420p"),
				probeOf(960, 540, "yuv420p"),
			);
			await expect(
				t.processor.process({ vmafJobId: VMAF_JOB_ID }),
			).rejects.toThrow(failure);
			expect(t.job.status).toBe("ERROR");
			expect(t.job.error).toContain(failure);
			expect(native).toHaveBeenCalled();
			expect(
				native.mock.calls.every(
					([, options]) => options.scoring?.backend === backend,
				),
			).toBe(true);
			expect(scoringRuns(t)).toHaveLength(0);
			expect(t.results).toHaveLength(0);
			// No second pass: each encode that reached the scorer was fetched
			// once.
			expect(
				t.downloaded.filter(({ destPath }) => destPath.includes("dist-")),
			).toHaveLength(native.mock.calls.length);
		} finally {
			native.mockRestore();
		}
	});

	it("refuses a too small reference of a cloud job before any pair reaches the cloud", async () => {
		const cloudScore = vi.fn();
		const t = setup({
			cloudScore,
			probeJson: probeOf(200, 200, "yuv420p"),
			resolveModelPath: () => `/opt/vmaf/model/${v1}.json`,
			job: {
				model: v1,
				params: {
					execution: { backend: "CLOUD", profileId: "gcp", budgetUsd: 10 },
				},
			},
		});
		await expect(
			t.processor.process({ vmafJobId: VMAF_JOB_ID }),
		).rejects.toThrow(
			/cannot score 4:2:0 pictures of 200x200: it needs at least 160 pixels in width and in height, and at least 216 in one of the two\./,
		);
		expect(cloudScore).not.toHaveBeenCalled();
		expect(t.job.status).toBe("ERROR");
	});

	it("refuses the encode whose size the frame-index method cannot declare, and sends the other pair to the cloud", async () => {
		const plan = qcPlan();
		delete plan.qc;
		const cloudScore = vi.fn(async (request) => {
			await writeFile(request.options.logPath, vmafJson([96, 97]));
		});
		const t = setup({
			plan,
			cloudScore,
			resolveModelPath: () => `/opt/vmaf/model/${v1}.json`,
			job: {
				model: v1,
				scoringVersion: 6,
				triggerKey: `lab-manual:${ENCODING_JOB_ID}:output`,
				params: {
					source: "OUTPUT_MP4",
					measurementMethod: "FRAME_INDEX_BT709_10BIT",
					execution: { backend: "CLOUD", profileId: "gcp", budgetUsd: 10 },
				},
			},
		});
		// The reference is 1080p; the encode of one rendition is below CAMBI's
		// range, the other is in it.
		vi.mocked(t.runner.run).mockImplementation(
			async (_bin: string, argv: string[]) => {
				if (!argv.includes("-show_streams"))
					throw new Error("A cloud job runs no local FFmpeg");
				const path = argv.at(-1) ?? "";
				return {
					code: 0,
					stderr: "",
					stdout: /\/ref-\d+\./.test(path)
						? probeOf(1920, 1080, "yuv422p10le")
						: path.includes("dist-v360-")
							? probeOf(240, 134, "yuv420p")
							: probeOf(960, 540, "yuv420p"),
				};
			},
		);
		await expect(
			t.processor.process({ vmafJobId: VMAF_JOB_ID }),
		).rejects.toThrow(
			`VMAF model "${v1}" cannot score an encode of 240x134: it takes no encode below 144 pixels in width or in height. Use a model of the vmaf_v0.6.1 family, which scores smaller pictures.`,
		);
		expect(t.job.status).toBe("ERROR");
		expect(cloudScore).toHaveBeenCalledTimes(1);
		expect(cloudScore.mock.calls[0]?.[0]).toMatchObject({
			targetKey: expect.stringMatching(/^v540\//),
			options: {
				measurementMethod: "FRAME_INDEX_BT709_10BIT",
				distortedOriginal: { width: 960, height: 540 },
			},
		});
	});

	/** Answers each ffprobe call by the file it names: the reference or an encode. */
	const probeByFile = (
		t: ReturnType<typeof setup>,
		reference: string,
		encode: string,
	) => {
		const raw = vi.mocked(t.runner.run).getMockImplementation();
		if (!raw) throw new Error("Missing runner fixture");
		vi.mocked(t.runner.run).mockImplementation(async (bin, argv, options) =>
			argv.includes("-show_streams")
				? {
						code: 0,
						stderr: "",
						stdout: /\/ref-\d+\./.test(argv.at(-1) ?? "") ? reference : encode,
					}
				: raw(bin, argv, options),
		);
	};
	const cloudJob = {
		execution: { backend: "CLOUD", profileId: "gcp", budgetUsd: 10 },
	};

	it("holds a frame-index comparison to the 4:2:0 that the method converts to, whatever the reference's own layout", async () => {
		const plan = qcPlan();
		delete plan.qc;
		const cloudScore = vi.fn();
		const t = setup({
			plan,
			cloudScore,
			resolveModelPath: () => `/opt/vmaf/model/${v1}.json`,
			job: {
				model: v1,
				scoringVersion: 6,
				triggerKey: `lab-manual:${ENCODING_JOB_ID}:output`,
				params: {
					source: "OUTPUT_MP4",
					measurementMethod: "FRAME_INDEX_BT709_10BIT",
					...cloudJob,
				},
			},
		});
		// The ordinary method scores a 4:4:4 reference of 256x144. Its declared
		// encode passes CAMBI's rules too, so the pictures decide.
		probeByFile(t, probeOf(256, 144, "yuv444p"), probeOf(256, 144, "yuv444p"));
		await expect(
			t.processor.process({ vmafJobId: VMAF_JOB_ID }),
		).rejects.toThrow(
			`VMAF model "${v1}" cannot score 4:2:0 pictures of 256x144: it needs at least 160 pixels in width and in height, and at least 216 in one of the two.`,
		);
		expect(cloudScore).not.toHaveBeenCalled();
	});

	it.each([
		// 256x144 is too small in 4:2:0 and enough in 4:4:4.
		["yuv420p", "yuv444p", false],
		["yuv444p", "yuv420p", true],
	] as const)("takes the layout of a %s reference and not that of its %s encode, when it has probed both", async (reference, encode, scores) => {
		// A job with local resources probes each encode before it scores.
		const t = setup({
			job: { model: v1 },
			localResources: sharedTestResources(),
			resolveModelPath: () => `/opt/vmaf/model/${v1}.json`,
		});
		probeByFile(t, probeOf(256, 144, reference), probeOf(640, 360, encode));
		const processed = t.processor.process({ vmafJobId: VMAF_JOB_ID });
		if (scores) {
			expect(await processed).toMatchObject({ status: "FINISHED", results: 2 });
			expect(scoringRuns(t)).toHaveLength(2);
		} else {
			await expect(processed).rejects.toThrow(
				"cannot score 4:2:0 pictures of 256x144",
			);
			expect(scoringRuns(t)).toHaveLength(0);
		}
	});

	/** The ffprobe runs that named an encode, by the file that each read. */
	const encodeProbes = (t: ReturnType<typeof setup>) =>
		vi
			.mocked(t.runner.run)
			.mock.calls.filter(
				([, argv]) =>
					argv.includes("-show_streams") &&
					!/\/ref-\d+\./.test(argv.at(-1) ?? ""),
			);

	it.each([
		// 256x144 is too small in 4:2:0 and enough in 4:4:4. FFmpeg converts
		// each of these references to the format that the encode's scale filter
		// writes.
		["yuvj420p", "yuv420p", true],
		["yuvj444p", "yuvj420p", true],
		["nv12", "yuv420p10le", true],
		["yuvj420p", "yuv444p", false],
		["gbrp", "yuvj444p", false],
		// An encode of which the conversion is not known: libvmaf decides.
		["yuvj420p", "nv12", false],
		["yuvj420p", undefined, false],
	] as const)("takes the layout of the encode for a %s reference, which libvmaf does not take as it is (encode %s)", async (reference, encode, refused) => {
		const cloudScore = vi.fn(async (request) => {
			await writeFile(request.options.logPath, vmafJson([96, 97]));
		});
		const t = setup({
			cloudScore,
			job: { model: v1, params: cloudJob },
			resolveModelPath: () => `/opt/vmaf/model/${v1}.json`,
		});
		probeByFile(t, probeOf(256, 144, reference), probeOf(256, 144, encode));
		const processed = t.processor.process({ vmafJobId: VMAF_JOB_ID });
		if (refused) {
			await expect(processed).rejects.toThrow(
				`VMAF model "${v1}" cannot score 4:2:0 pictures of 256x144: it needs at least 160 pixels in width and in height, and at least 216 in one of the two.`,
			);
			// Before any pair reaches the cloud.
			expect(cloudScore).not.toHaveBeenCalled();
			expect(t.job.status).toBe("ERROR");
		} else {
			expect(await processed).toMatchObject({ status: "FINISHED", results: 2 });
			expect(cloudScore).toHaveBeenCalledTimes(2);
		}
		expect(encodeProbes(t).length).toBeGreaterThan(0);
	});

	it.each([
		["yuv420p", true],
		["yuv444p", false],
	] as const)("reads the layout from the probe that a job with local resources has made of its %s encode", async (encode, refused) => {
		// Such a job probes each encode before it scores. The check for a
		// converted reference reads that probe and starts no other.
		const t = setup({
			job: { model: v1 },
			localResources: sharedTestResources(),
			resolveModelPath: () => `/opt/vmaf/model/${v1}.json`,
		});
		probeByFile(t, probeOf(256, 144, "yuvj420p"), probeOf(640, 360, encode));
		const processed = t.processor.process({ vmafJobId: VMAF_JOB_ID });
		if (refused) {
			await expect(processed).rejects.toThrow(
				"cannot score 4:2:0 pictures of 256x144",
			);
			expect(scoringRuns(t)).toHaveLength(0);
			expect(encodeProbes(t)).toHaveLength(1);
		} else {
			expect(await processed).toMatchObject({ status: "FINISHED", results: 2 });
			expect(scoringRuns(t)).toHaveLength(2);
			expect(encodeProbes(t)).toHaveLength(2);
		}
	});

	it("leaves the layout unknown when the encode cannot be probed, and libvmaf decides", async () => {
		const t = setup({
			job: { model: v1 },
			resolveModelPath: () => `/opt/vmaf/model/${v1}.json`,
		});
		const raw = vi.mocked(t.runner.run).getMockImplementation();
		if (!raw) throw new Error("Missing runner fixture");
		vi.mocked(t.runner.run).mockImplementation(async (bin, argv, options) =>
			argv.includes("-show_streams")
				? /\/ref-\d+\./.test(argv.at(-1) ?? "")
					? { code: 0, stderr: "", stdout: probeOf(256, 144, "yuvj420p") }
					: { code: 1, stderr: "Invalid data found", stdout: "" }
				: raw(bin, argv, options),
		);
		expect(await t.processor.process({ vmafJobId: VMAF_JOB_ID })).toMatchObject(
			{ status: "FINISHED", results: 2 },
		);
		expect(encodeProbes(t)).toHaveLength(2);
		expect(scoringRuns(t)).toHaveLength(2);
	});

	it.each([
		// The reference's layout is known.
		[256, 144, "yuv444p"],
		// No layout refuses pictures of this size.
		[640, 360, "yuvj420p"],
		// The reference's format is not known, so nothing says that FFmpeg converts it.
		[256, 144, undefined],
	] as const)("does not probe the encode for a %ix%i reference in %s", async (width, height, reference) => {
		const t = setup({
			job: { model: v1 },
			resolveModelPath: () => `/opt/vmaf/model/${v1}.json`,
		});
		probeByFile(
			t,
			probeOf(width, height, reference),
			probeOf(256, 144, "yuv420p"),
		);
		expect(await t.processor.process({ vmafJobId: VMAF_JOB_ID })).toMatchObject(
			{ status: "FINISHED", results: 2 },
		);
		expect(encodeProbes(t)).toHaveLength(0);
	});

	it("scores encodes below CAMBI's range with the ordinary method, which declares no encode", async () => {
		const plan = qcPlan();
		const [first, second] = plan.renditions as { height: number }[];
		if (!first || !second) throw new Error("Missing renditions");
		first.height = 108;
		second.height = 120;
		const t = setup({
			plan,
			job: { model: v1 },
			localResources: sharedTestResources(),
			resolveModelPath: () => `/opt/vmaf/model/${v1}.json`,
		});
		probeByFile(
			t,
			probeOf(1920, 1080, "yuv420p"),
			probeOf(192, 108, "yuv420p"),
		);
		expect(await t.processor.process({ vmafJobId: VMAF_JOB_ID })).toMatchObject(
			{ status: "FINISHED", results: 2 },
		);
		expect(scoringRuns(t)).toHaveLength(2);
	});

	it("holds a cloud job to libvmaf's limits on a worker whose own scorer is the GPU's", async () => {
		const cloudScore = vi.fn();
		const t = setup({
			cloudScore,
			scoringBackend: "vulkan",
			probeJson: probeOf(200, 200, "yuv420p"),
			resolveModelPath: () => `/opt/vmaf/model/${v1}.json`,
			job: { model: v1, params: cloudJob },
		});
		await expect(
			t.processor.process({ vmafJobId: VMAF_JOB_ID }),
		).rejects.toThrow("cannot score 4:2:0 pictures of 200x200");
		expect(cloudScore).not.toHaveBeenCalled();
	});
});
