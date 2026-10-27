import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildVmafCommand } from "./command";
import { createContainerCropFixture } from "./crop-fixture.test-helper";

let haveFfmpeg = false;
try {
	execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
	haveFfmpeg = true;
} catch {
	// Real-process coverage is explicitly skipped when ffmpeg is unavailable.
}

// Exercise the production conform/trim/rebase graph with FFmpeg's PSNR
// framesync instead of a model-dependent score. Identical synthetic frames
// must stay identical at EVERY index, including the old 492/494/973/980 zeros.
describe.skipIf(!haveFfmpeg)("VMAF frame pairing (real ffmpeg)", () => {
	for (const [rate, fps] of [
		["30", 30],
		["30000/1001", 30000 / 1001],
	] as const) {
		for (const conform of [false, true]) {
			for (const alignFrames of conform ? [0, 2, -2] : [0]) {
				it(`${rate}, fps conform=${conform}, alignment=${alignFrames}: pairs identical frame indices`, () => {
					const dir = mkdtempSync(join(tmpdir(), "bitovp-vmaf-timebase-"));
					try {
						const stats = join(dir, "psnr.log");
						const source = (timebase: string, drop: number) =>
							`testsrc2=size=64x48:rate=${rate},trim=end_frame=1000,trim=start_frame=${drop},settb=${timebase},setpts=PTS-STARTPTS+5/TB`;
						const argv = buildVmafCommand({
							distortedPath: source("1/30000", Math.max(0, alignFrames)),
							referencePath: source("1/15360", Math.max(0, -alignFrames)),
							model: "vmaf_v0.6.1",
							logPath: join(dir, "unused.json"),
							...(conform ? { fpsConform: fps } : {}),
							alignFrames,
						});
						const graphIndex = argv.indexOf("-filter_complex") + 1;
						const graph = argv[graphIndex];
						if (graphIndex === 0 || !graph)
							throw new Error("Missing scoring graph");
						argv[graphIndex] = graph.replace(
							/libvmaf=.*\[out\]$/,
							`psnr=stats_file=${stats}[out]`,
						);
						execFileSync(
							"ffmpeg",
							[
								"-v",
								"error",
								...argv.flatMap((arg) =>
									arg === "-i" ? ["-f", "lavfi", "-i"] : [arg],
								),
							],
							{ stdio: ["ignore", "ignore", "pipe"], timeout: 20_000 },
						);
						const frames = readFileSync(stats, "utf8").trim().split("\n");
						expect(frames).toHaveLength(1000 - Math.abs(alignFrames));
						expect(
							frames.filter((line) => !line.includes("psnr_avg:inf")),
						).toHaveLength(0);
					} finally {
						rmSync(dir, { recursive: true, force: true });
					}
				}, 30_000);
			}
		}
	}
});

describe.skipIf(!haveFfmpeg)(
	"Explicit BT709 full-frame method (real ffmpeg)",
	() => {
		it("normalizes an anamorphic reference to circular display proportions without losing frame indices", () => {
			const dir = mkdtempSync(join(tmpdir(), "vmaf-display-geometry-"));
			try {
				const reference = join(dir, "reference.mkv");
				const distorted = join(dir, "display.mkv");
				const stats = join(dir, "psnr.log");
				const args = buildVmafCommand({
					measurementMethod: "FRAME_INDEX_BT709_10BIT",
					referenceFrameRate: "25/1",
					referenceGeometry: {
						width: 144,
						height: 108,
						sampleAspectRatio: "4:3",
					},
					scaleToReference: { width: 192, height: 108 },
					distortedOriginal: { width: 192, height: 108, bitdepth: 10 },
					referencePath: reference,
					distortedPath: distorted,
					model: "vmaf_v0.6.1",
					logPath: join(dir, "unused.json"),
				});
				const graphIndex = args.indexOf("-filter_complex") + 1;
				const graph = args[graphIndex];
				const leg = graph?.match(/\[1:v:0\](.*?)\[ref\]/)?.[1];
				if (!graph || !leg) throw new Error("Missing reference normalization");
				const run = (argv: string[]) =>
					execFileSync("ffmpeg", ["-v", "error", "-nostdin", ...argv], {
						stdio: ["ignore", "pipe", "pipe"],
						timeout: 20_000,
					});
				// The coded ellipse becomes a circle only when the 4:3 SAR is applied.
				run([
					"-f",
					"lavfi",
					"-i",
					"nullsrc=size=144x108:rate=25,geq=lum='if(lte(pow((X-60-N)/18,2)+pow((Y-54)/24,2),1),235,16)':cb=128:cr=128,setsar=4/3",
					"-frames:v",
					"12",
					"-c:v",
					"ffv1",
					reference,
				]);
				run(["-i", reference, "-vf", leg, "-c:v", "ffv1", distorted]);
				const pixels = run([
					"-i",
					reference,
					"-vf",
					`${leg},format=gray`,
					"-frames:v",
					"1",
					"-f",
					"rawvideo",
					"pipe:1",
				]);
				expect(pixels).toHaveLength(192 * 108);
				const xs: number[] = [],
					ys: number[] = [];
				for (let i = 0; i < pixels.length; i++) {
					if ((pixels[i] ?? 0) > 128) {
						xs.push(i % 192);
						ys.push(Math.floor(i / 192));
					}
				}
				const width = Math.max(...xs) - Math.min(...xs) + 1;
				const height = Math.max(...ys) - Math.min(...ys) + 1;
				expect(Math.abs(width - height)).toBeLessThanOrEqual(2);
				expect(width).toBeGreaterThan(45);
				args[graphIndex] = graph.replace(
					/libvmaf=.*\[out\]$/,
					`psnr=stats_file=${stats}:eof_action=endall:shortest=1:repeatlast=0[out]`,
				);
				run(args);
				const frames = readFileSync(stats, "utf8").trim().split("\n");
				expect(frames).toHaveLength(12);
				expect(frames.every((line) => line.includes("psnr_avg:inf"))).toBe(
					true,
				);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		}, 30_000);

		it("preserves all 1000 frame indices across different rounded nominal rates and timebases", () => {
			const dir = mkdtempSync(join(tmpdir(), "vmaf-gen5-"));
			try {
				const stats = join(dir, "psnr.log");
				const args = buildVmafCommand({
					measurementMethod: "FRAME_INDEX_BT709_10BIT",
					referenceFrameRate: "24000/1001",
					scaleToReference: { width: 64, height: 48 },
					distortedOriginal: { width: 64, height: 48, bitdepth: 8 },
					distortedPath:
						"testsrc2=size=64x48:rate=24000/1001,trim=end_frame=1000,settb=1/30000,setpts=N/(2997/125)/TB",
					referencePath:
						"testsrc2=size=64x48:rate=24000/1001,trim=end_frame=1000,settb=1/15360,setpts=PTS+5/TB",
					model: "vmaf_v0.6.1",
					logPath: join(dir, "unused.json"),
				});
				const i = args.indexOf("-filter_complex") + 1;
				const graph = args[i];
				if (!graph) throw new Error("Missing scoring graph");
				args[i] = graph.replace(
					/libvmaf=.*\[out\]$/,
					`psnr=stats_file=${stats}:eof_action=endall:shortest=1:repeatlast=0[out]`,
				);
				execFileSync(
					"ffmpeg",
					[
						"-v",
						"error",
						...args.flatMap((arg) =>
							arg === "-i" ? ["-f", "lavfi", "-i"] : [arg],
						),
					],
					{ stdio: ["ignore", "ignore", "pipe"], timeout: 20000 },
				);
				const frames = readFileSync(stats, "utf8").trim().split("\n");
				expect(frames).toHaveLength(1000);
				expect(
					frames.filter((line) => !line.includes("psnr_avg:inf")),
				).toHaveLength(0);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		}, 30000);
	},
);

describe.skipIf(!haveFfmpeg)(
	"Container aperture regression (real ffmpeg)",
	() => {
		it("compares identical coded pictures despite MOV aperture while retaining codec cropping", () => {
			const dir = mkdtempSync(join(tmpdir(), "vmaf-container-crop-"));
			try {
				const fixture = createContainerCropFixture(dir);
				const decodedBytes = (policy: string[]) =>
					execFileSync(
						"ffmpeg",
						[
							"-v",
							"error",
							...policy,
							"-i",
							fixture.cropped,
							"-frames:v",
							"1",
							"-pix_fmt",
							"gray",
							"-f",
							"rawvideo",
							"pipe:1",
						],
						{ stdio: ["ignore", "pipe", "pipe"] },
					).length;
				expect(decodedBytes([])).toBe(96 * 72);
				expect(decodedBytes(["-apply_cropping", "codec"])).toBe(128 * 90);
				const stats = join(dir, "psnr.log");
				const args = buildVmafCommand({
					measurementMethod: "FRAME_INDEX_BT709_10BIT",
					referenceFrameRate: "24/1",
					scaleToReference: { width: 128, height: 90 },
					distortedOriginal: { width: 128, height: 90, bitdepth: 8 },
					referencePath: fixture.cropped,
					distortedPath: fixture.original,
					model: "vmaf_v0.6.1",
					logPath: join(dir, "unused.json"),
				});
				const i = args.indexOf("-filter_complex") + 1,
					graph = args[i];
				if (!graph) throw Error("Missing scoring graph");
				args[i] = graph.replace(
					/libvmaf=.*\[out\]$/,
					`psnr=stats_file=${stats}:eof_action=endall:shortest=1:repeatlast=0[out]`,
				);
				execFileSync("ffmpeg", args, {
					stdio: ["ignore", "ignore", "pipe"],
					timeout: 20000,
				});
				const frames = readFileSync(stats, "utf8").trim().split("\n");
				expect(frames).toHaveLength(24);
				expect(
					frames.filter((line) => !line.includes("psnr_avg:inf")),
				).toHaveLength(0);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		}, 30000);
	},
);
