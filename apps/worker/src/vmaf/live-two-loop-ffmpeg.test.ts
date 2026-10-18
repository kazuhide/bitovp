import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	copyFileSync,
	createReadStream,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { liveChannelPlanSchema } from "@bitovp/core";
import type { AppPrismaClient } from "@bitovp/db";
import type { ObjectStorageBrowser, StorageObject } from "@bitovp/storage";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	buildNormalizeCommand,
	loopProfileFromProbe,
	parseProbeJson,
	probeArgs,
	sourceVideoSpan,
} from "../feeder/command";
import { createNodeProcessRunner } from "../feeder/process-runner";
import type { ResolvedCredential } from "../orchestrator/executor";
import { createLiveVmafProcessor, type LiveMetadata } from "./live-processor";

/**
 * , end to end with real ffmpeg + libvmaf: a source whose video
 * starts 1 s into a 10 s container is pushed for THREE loops the way the
 * feeder pushes it (`-stream_loop … -c copy`), encoded the way the live
 * encoder would (fps conform, 2 s segments), served to the real processor
 * through a browser fake over the local files, and scored. Before this
 * branch the offline shape was mean 35.6 with a third of the frames at 0 and
 * a −30-frame walk per loop; now every 2 s segment aligns, the two loop
 * holes are masked, the loops score alike, and the period the output
 * repeats at agrees with the timeline.
 *
 * Skipped, never faked, without ffmpeg/ffprobe (with libvmaf) on PATH.
 */
function onPath(bin: string): boolean {
	try {
		execFileSync("which", [bin], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}
function hasLibvmaf(): boolean {
	try {
		return execFileSync("ffmpeg", ["-hide_banner", "-filters"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).includes("libvmaf");
	} catch {
		return false;
	}
}
const HAVE_TOOLS = onPath("ffmpeg") && onPath("ffprobe") && hasLibvmaf();
const FPS = 30;
const PLAYS = 3;
const NOW = "2026-09-06T12:00:00.000Z";

type Row = Record<string, unknown>;

describe.skipIf(!HAVE_TOOLS)(
	"live VMAF over three pushed loops of a late-video source (row #256, real ffmpeg + libvmaf)",
	() => {
		let root = "";
		let segDir = "";
		let src = "";
		beforeAll(() => {
			root = mkdtempSync(join(tmpdir(), "bitovp-two-loop-"));
			segDir = join(root, "segments");
			execFileSync("mkdir", ["-p", segDir]);
			src = join(root, "src.mp4");
			execFileSync(
				"ffmpeg",
				[
					"-hide_banner",
					"-v",
					"error",
					"-y",
					"-f",
					"lavfi",
					"-i",
					"sine=frequency=440:duration=10",
					"-itsoffset",
					"1",
					"-f",
					"lavfi",
					"-i",
					`testsrc2=size=320x180:rate=${FPS}:duration=9`,
					"-map",
					"1:v",
					"-map",
					"0:a",
					"-c:v",
					"libx264",
					"-preset",
					"ultrafast",
					"-pix_fmt",
					"yuv420p",
					"-c:a",
					"aac",
					src,
				],
				{ stdio: ["ignore", "ignore", "pipe"] },
			);
			// the feeder's push: the container copied PLAYS times
			const pushed = join(root, "pushed.ts");
			execFileSync(
				"ffmpeg",
				[
					"-hide_banner",
					"-v",
					"error",
					"-y",
					"-stream_loop",
					String(PLAYS - 1),
					"-i",
					src,
					"-c",
					"copy",
					"-f",
					"mpegts",
					pushed,
				],
				{ stdio: ["ignore", "ignore", "pipe"] },
			);
			// the live encoder: conform to 30 fps, encode, 2 s TS segments
			execFileSync(
				"ffmpeg",
				[
					"-hide_banner",
					"-v",
					"error",
					"-y",
					"-i",
					pushed,
					"-vf",
					`fps=${FPS}`,
					"-an",
					"-c:v",
					"libx264",
					"-preset",
					"ultrafast",
					"-crf",
					"28",
					"-pix_fmt",
					"yuv420p",
					"-force_key_frames",
					"expr:gte(t,n_forced*2)",
					"-f",
					"segment",
					"-segment_time",
					"2",
					"-segment_format",
					"mpegts",
					join(segDir, "seg_%d.ts"),
				],
				{ stdio: ["ignore", "ignore", "pipe"] },
			);
		}, 180_000);
		afterAll(() => {
			rmSync(root, { recursive: true, force: true });
		});

		/**
		 *  follow-up: the feeder now pushes a NORMALIZED loop
		 * (feeder/command.ts). Build it the feeder's way, push it the feeder's
		 * way (`-ignore_editlist 1 -stream_loop … -c copy`), encode it the
		 * encoder's way, and hand the processor the feeder's profile + spool.
		 */
		function normalizedFixture(): {
			loop: string;
			segDirNorm: string;
			profile: ReturnType<typeof loopProfileFromProbe>;
			spoolDir: string;
		} {
			const loop = join(root, "loop.mp4");
			const probe = (path: string) =>
				parseProbeJson(
					execFileSync("ffprobe", probeArgs(path), {
						encoding: "utf8",
						stdio: ["ignore", "pipe", "ignore"],
					}),
				);
			const span = sourceVideoSpan(probe(src));
			execFileSync(
				"ffmpeg",
				buildNormalizeCommand({
					sourcePath: src,
					destPath: loop,
					fps: FPS,
					protocol: "RTMP",
					videoStartSec: span.videoStartSec,
					videoDurationSec: span.videoDurationSec,
				}),
				{ stdio: ["ignore", "ignore", "pipe"] },
			);
			const sha = createHash("sha256").update(readFileSync(src)).digest("hex");
			const profile = loopProfileFromProbe(probe(loop), FPS, sha, NOW);
			const pushed = join(root, "pushed-norm.ts");
			execFileSync(
				"ffmpeg",
				[
					"-hide_banner",
					"-v",
					"error",
					"-y",
					"-ignore_editlist",
					"1",
					"-stream_loop",
					String(PLAYS - 1),
					"-i",
					loop,
					"-c",
					"copy",
					"-f",
					"mpegts",
					pushed,
				],
				{ stdio: ["ignore", "ignore", "pipe"] },
			);
			const segDirNorm = join(root, "segments-norm");
			execFileSync("mkdir", ["-p", segDirNorm]);
			execFileSync(
				"ffmpeg",
				[
					"-hide_banner",
					"-v",
					"error",
					"-y",
					"-i",
					pushed,
					"-vf",
					`fps=${FPS}`,
					"-an",
					"-c:v",
					"libx264",
					"-preset",
					"ultrafast",
					"-crf",
					"28",
					"-pix_fmt",
					"yuv420p",
					"-force_key_frames",
					"expr:gte(t,n_forced*2)",
					"-f",
					"segment",
					"-segment_time",
					"2",
					"-segment_format",
					"mpegts",
					join(segDirNorm, "seg_%d.ts"),
				],
				{ stdio: ["ignore", "ignore", "pipe"] },
			);
			const spoolDir = join(root, "spool");
			execFileSync("mkdir", ["-p", spoolDir]);
			copyFileSync(loop, join(spoolDir, "feeder-norm.loop.mp4"));
			return { loop, segDirNorm, profile, spoolDir };
		}

		it("every segment aligns, the loop holes are masked, the loops score alike, and the measured period agrees with the timeline", async () => {
			// The minimal one-rendition pseudo-live plan the processor tests use,
			// with a TS muxing named the way ffmpeg's segment muxer writes.
			const plan = liveChannelPlanSchema.parse({
				planVersion: 1,
				name: "live-vmaf-two-loop",
				bitmovin: { cloudRegion: "AUTO", encoderVersion: "STABLE" },
				liveInput: { key: "main", kind: "RTMP" },
				outputs: [
					{
						key: "origin",
						kind: "S3",
						credentialId: "00000000-0000-4000-8000-000000000002",
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
						key: "v1080ts",
						kind: "TS",
						streamKey: "v1080",
						segmentLength: 2,
						segmentNaming: "seg_%number%.ts",
						destination: { outputKey: "origin", path: "out/v" },
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
			});
			const segments = readdirSync(segDir)
				.filter((n) => /^seg_\d+\.ts$/.test(n))
				.sort((a, b) => Number(a.slice(4, -3)) - Number(b.slice(4, -3)));
			expect(segments.length).toBeGreaterThanOrEqual(12);
			const listed: StorageObject[] = segments.map((n, i) => ({
				key: `out/v/${n}`,
				size: 1,
				// all within the window, newest last
				lastModified: new Date(
					Date.parse(NOW) - (segments.length - i) * 2000,
				).toISOString(),
			}));
			const browser: ObjectStorageBrowser = {
				listBuckets: async () => ["b"],
				listObjects: async () => ({ prefixes: [], objects: listed }),
				getObject: async ({ key }: { key: string }) =>
					createReadStream(
						key === "src/loop.mp4" ? src : join(segDir, basename(key)),
					),
				dispose: () => {},
			};

			const job: Row = {
				id: "00000000-0000-4000-8000-0000000c2560",
				mode: "LIVE",
				model: "vmaf_v0.6.1",
				status: "PENDING",
				error: null,
				params: { liveChannelId: "ch", windowSeconds: 120 },
			};
			const results: Row[] = [];
			const prisma = {
				vmafJob: {
					findUnique: async () => ({ ...job }),
					updateMany: async ({ where, data }: { where: Row; data: Row }) => {
						if (
							where.id === job.id &&
							(where.status === undefined || where.status === job.status)
						) {
							Object.assign(job, data);
							return { count: 1 };
						}
						return { count: 0 };
					},
					update: async ({ data }: { data: Row }) => {
						Object.assign(job, data);
						return { ...job };
					},
				},
				vmafResult: {
					create: async ({ data }: { data: Row }) => {
						results.push(data);
						return { id: `r${results.length}`, ...data };
					},
				},
				liveChannel: {
					findUnique: async () => ({ id: "ch", status: "RUNNING", plan }),
				},
				feederSession: {
					findFirst: async () => ({
						id: "feeder",
						liveChannelId: "ch",
						status: "PUSHING",
						sourceCredentialId: "cred-src",
						sourceBucket: "src-bucket",
						sourceKey: "src/loop.mp4",
						loopBoundaries: [],
						createdAt: new Date(),
					}),
				},
				liveChannelRun: {
					findFirst: async () => null,
					findUnique: async () => null,
				},
			} as unknown as AppPrismaClient;
			const resolveCredential = async (
				id: string,
			): Promise<ResolvedCredential> => ({
				provider: "AWS_S3",
				config: { region: "us-east-1" },
				secret: { accessKeyId: `ak-${id}`, secretAccessKey: `sk-${id}` },
			});
			const processor = createLiveVmafProcessor({
				prisma,
				resolveCredential,
				runner: createNodeProcessRunner(),
				ffmpegPath: "ffmpeg",
				ffprobePath: "ffprobe",
				workDir: join(root, "work"),
				now: () => NOW,
				makeBrowser: () => browser,
				signatureFps: FPS,
			});

			const outcome = await processor.process({ vmafJobId: job.id });
			expect(job.error).toBeNull();
			expect(outcome.status).toBe("FINISHED");
			expect(results).toHaveLength(1);
			const pooled = (
				results[0] as {
					pooled: {
						mean: number;
						harmonicMean: number;
						min: number;
						live: LiveMetadata;
					};
				}
			).pooled;
			const live = pooled.live;

			// the period the encoder sees: 300.7 frames per loop for this source,
			// read off the reproduced push as 300 or 301; the hole is what the
			// container leaves before the video (≈ 1 s), give or take a frame
			expect([300, 301]).toContain(live.timeline.frames);
			expect(live.timeline.holes).toHaveLength(1);
			expect(live.timeline.holes[0]?.fromFrame).toBe(0);
			expect(live.timeline.holes[0]?.toFrame).toBeGreaterThanOrEqual(29);
			expect(live.timeline.holes[0]?.toFrame).toBeLessThanOrEqual(32);
			expect(live.lowConfidence).toBe(false);
			expect(live.confidence).toBeGreaterThanOrEqual(0.9);
			// every 2 s segment aligned on its own
			expect(live.segments.length).toBeGreaterThanOrEqual(12);
			expect(live.segments.every((s) => s.included)).toBe(true);
			expect(live.excluded.segments).toEqual([]);
			expect(live.drift.detected).toBe(false);
			// two loop holes fall inside the window (the first play's head is never emitted)
			expect(live.masked.frames).toBeGreaterThanOrEqual(50);
			expect(live.masked.frames).toBeLessThanOrEqual(70);
			expect(live.includedFrames).toBe(
				live.distortedFrames - live.masked.frames,
			);
			// the period read off the output agrees with the timeline (a multiple is the same period)
			if (live.measuredPeriodFrames !== null) {
				const residue = live.measuredPeriodFrames % live.timeline.frames;
				expect(
					Math.min(residue, live.timeline.frames - residue),
				).toBeLessThanOrEqual(1);
			}
			expect(live.captureSelection.mode).toBe("window");
			expect(live.captureSelection.contiguous).toBe(true);

			// scores: no collapse, no zero share, loops alike
			expect(pooled.mean).toBeGreaterThanOrEqual(70);
			expect(pooled.harmonicMean).toBeGreaterThanOrEqual(60);
			const frames = JSON.parse(
				gunzipSync(
					(results[0] as { framesGzip: Uint8Array }).framesGzip,
				).toString(),
			) as { frameNum: number; vmaf: number }[];
			const F = live.timeline.frames;
			const hole = live.timeline.holes[0]?.toFrame ?? 0;
			const runOf = (n: number) =>
				live.referenceRuns.find((r) => n >= r.frameStart && n < r.frameEnd) ?? {
					offset: live.offset,
				};
			const unmasked = frames.filter(
				(f) => (f.frameNum + runOf(f.frameNum).offset) % F >= hole,
			);
			const zeroShare =
				unmasked.filter((f) => f.vmaf < 1).length / unmasked.length;
			expect(zeroShare).toBeLessThan(0.01);
			const loopMeans: number[] = [];
			for (let k = 0; k < live.loopMap.length; k++) {
				const start = (live.loopMap[k] as { outputFrameStart: number })
					.outputFrameStart;
				const end =
					k + 1 < live.loopMap.length
						? (live.loopMap[k + 1] as { outputFrameStart: number })
								.outputFrameStart
						: live.distortedFrames;
				const inLoop = unmasked.filter(
					(f) => f.frameNum >= start && f.frameNum < end,
				);
				if (inLoop.length >= 150) {
					loopMeans.push(
						inLoop.reduce((a, f) => a + f.vmaf, 0) / inLoop.length,
					);
				}
			}
			expect(loopMeans.length).toBeGreaterThanOrEqual(2);
			expect(
				Math.max(...loopMeans) - Math.min(...loopMeans),
			).toBeLessThanOrEqual(5);
		}, 300_000);

		for (const mode of ["spool-loop", "renormalized-source"] as const) {
			it(`row #256 follow-up (${mode}): the normalized loop is the reference — no hole, every segment included, no drift, the profile's period confirmed by the decode`, async () => {
				const fx = normalizedFixture();
				const plan = liveChannelPlanSchema.parse({
					planVersion: 1,
					name: "live-vmaf-normalized",
					bitmovin: { cloudRegion: "AUTO", encoderVersion: "STABLE" },
					liveInput: { key: "main", kind: "RTMP" },
					outputs: [
						{
							key: "origin",
							kind: "S3",
							credentialId: "00000000-0000-4000-8000-000000000002",
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
							key: "v1080ts",
							kind: "TS",
							streamKey: "v1080",
							segmentLength: 2,
							segmentNaming: "seg_%number%.ts",
							destination: { outputKey: "origin", path: "out/v" },
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
				});
				const segments = readdirSync(fx.segDirNorm)
					.filter((n) => /^seg_\d+\.ts$/.test(n))
					.sort((a, b) => Number(a.slice(4, -3)) - Number(b.slice(4, -3)));
				expect(segments.length).toBeGreaterThanOrEqual(12);
				const listed: StorageObject[] = segments.map((n, i) => ({
					key: `out/v/${n}`,
					size: 1,
					lastModified: new Date(
						Date.parse(NOW) - (segments.length - i) * 2000,
					).toISOString(),
				}));
				const sourceReads: string[] = [];
				const browser: ObjectStorageBrowser = {
					listBuckets: async () => ["b"],
					listObjects: async () => ({ prefixes: [], objects: listed }),
					getObject: async ({ key }: { key: string }) => {
						if (key === "src/loop.mp4") sourceReads.push(key);
						return createReadStream(
							key === "src/loop.mp4" ? src : join(fx.segDirNorm, basename(key)),
						);
					},
					dispose: () => {},
				};
				const job: Row = {
					id: "00000000-0000-4000-8000-0000000c2561",
					mode: "LIVE",
					model: "vmaf_v0.6.1",
					status: "PENDING",
					error: null,
					params: { liveChannelId: "ch", windowSeconds: 120 },
				};
				const results: Row[] = [];
				const prisma = {
					vmafJob: {
						findUnique: async () => ({ ...job }),
						updateMany: async ({ where, data }: { where: Row; data: Row }) => {
							if (
								where.id === job.id &&
								(where.status === undefined || where.status === job.status)
							) {
								Object.assign(job, data);
								return { count: 1 };
							}
							return { count: 0 };
						},
						update: async ({ data }: { data: Row }) => {
							Object.assign(job, data);
							return { ...job };
						},
					},
					vmafResult: {
						create: async ({ data }: { data: Row }) => {
							results.push(data);
							return { id: `r${results.length}`, ...data };
						},
					},
					liveChannel: {
						findUnique: async () => ({ id: "ch", status: "RUNNING", plan }),
					},
					feederSession: {
						findFirst: async () => ({
							id: "feeder-norm",
							liveChannelId: "ch",
							status: "PUSHING",
							protocol: "RTMP",
							sourceCredentialId: "cred-src",
							sourceBucket: "src-bucket",
							sourceKey: "src/loop.mp4",
							loopBoundaries: [],
							loopProfile: fx.profile,
							createdAt: new Date(),
						}),
					},
					liveChannelRun: {
						findFirst: async () => null,
						findUnique: async () => null,
					},
				} as unknown as AppPrismaClient;
				const resolveCredential = async (
					id: string,
				): Promise<ResolvedCredential> => ({
					provider: "AWS_S3",
					config: { region: "us-east-1" },
					secret: { accessKeyId: `ak-${id}`, secretAccessKey: `sk-${id}` },
				});
				const processor = createLiveVmafProcessor({
					prisma,
					resolveCredential,
					runner: createNodeProcessRunner(),
					ffmpegPath: "ffmpeg",
					ffprobePath: "ffprobe",
					workDir: join(root, `work-${mode}`),
					// the spool holds the feeder's loop only in the first mode
					spoolDir:
						mode === "spool-loop" ? fx.spoolDir : join(root, "no-spool"),
					now: () => NOW,
					makeBrowser: () => browser,
					// deliberately NOT the loop's fps: the profile's 30 must win (a
					// processor that kept its own grid would decode at 25, measure
					// 225 ≠ 270 and trip the cross-check warning asserted below)
					signatureFps: 25,
				});

				const outcome = await processor.process({ vmafJobId: job.id });
				expect(job.error).toBeNull();
				expect(outcome.status).toBe("FINISHED");
				expect(results).toHaveLength(1);
				const pooled = (
					results[0] as {
						pooled: { mean: number; harmonicMean: number; live: LiveMetadata };
					}
				).pooled;
				const live = pooled.live;
				expect(live.fps).toBe(FPS);
				expect(live.referenceSource).toBe(mode);
				// the spool copy needs no source download; the rebuild does
				expect(sourceReads.length).toBe(mode === "spool-loop" ? 0 : 1);
				// the profile's period: 270 frames, no hole
				expect(live.timeline).toMatchObject({
					source: "feeder-profile",
					frames: fx.profile.frames,
					holes: [],
				});
				expect(fx.profile.frames).toBe(270);
				expect(live.masked).toEqual({ frames: 0, share: 0 });
				expect(live.lowConfidence).toBe(false);
				expect(live.confidence).toBeGreaterThanOrEqual(0.9);
				expect(live.segments.length).toBeGreaterThanOrEqual(12);
				expect(live.segments.every((s) => s.included)).toBe(true);
				expect(live.excluded).toEqual({ segments: [], frames: 0 });
				// an integral period: the per-loop offset does not walk
				expect(live.drift.detected).toBe(false);
				expect(live.drift.maxDriftFrames).toBeLessThanOrEqual(1);
				// the decode confirmed the profile's period (no cross-check warning)
				expect(live.warning ?? "").not.toContain("measured a");
				expect(live.includedFrames).toBe(live.distortedFrames);
				expect(pooled.mean).toBeGreaterThanOrEqual(70);
				expect(pooled.harmonicMean).toBeGreaterThanOrEqual(60);
			}, 300_000);
		}
	},
);
