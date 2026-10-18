import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	AAC_FRAME_SAMPLES,
	buildNormalizeCommand,
	loopProfileFromProbe,
	parseProbeJson,
	probeArgs,
	sourceVideoSpan,
} from "./command";

/**
 *  item 1, measured with real ffmpeg: the  sample's shape (video
 * starting 1 s into a 10 s container) is normalized by `buildNormalizeCommand`
 * into a CFR, pts-0 loop trimmed to the video span, and the feeder copy-loops
 * THAT file. The claim the feeder now rests on is that every play is the same
 * frame ring — N plays conform to exactly N × F frames, no duplicated
 * transition frame, no hole. The raw source measured ≈ 300.7 frames per play
 * against F = 270 (`vmaf/live-loop-period-ffmpeg.test.ts`); this is the other
 * half, and its control arm keeps the WHY: with the mp4 edit list honoured,
 * the AAC delay frame's negative pts widens `-stream_loop`'s per-play offset
 * by one audio frame (1024/ar s), which the encoder's fps conform turns into
 * a duplicated frame every second or third play.
 *
 * The production push argv carries `-ignore_editlist 1` (pinned in
 * `command.test.ts`); the push here is the same demux + `-c copy` shape.
 * Skipped, never faked, without ffmpeg/ffprobe on PATH.
 */
function onPath(bin: string): boolean {
	try {
		execFileSync("which", [bin], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}
const HAVE_FFMPEG = onPath("ffmpeg") && onPath("ffprobe");
const FPS = 30;
const SAMPLE_RATE = 48_000;
const GRAY_W = 16;
const GRAY_H = 9;

function probe(path: string) {
	return parseProbeJson(
		execFileSync("ffprobe", probeArgs(path), {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}),
	);
}

/** Frames the encoder's fps conform would see: decode → fps=FPS → raw gray, count by size. */
function conformedFrames(input: string, out: string): number {
	execFileSync(
		"ffmpeg",
		[
			"-hide_banner",
			"-v",
			"error",
			"-y",
			"-i",
			input,
			"-vf",
			`fps=${FPS},scale=${GRAY_W}:${GRAY_H}`,
			"-pix_fmt",
			"gray",
			"-f",
			"rawvideo",
			"-an",
			out,
		],
		{ stdio: ["ignore", "ignore", "pipe"] },
	);
	return statSync(out).size / (GRAY_W * GRAY_H);
}

/** Sorted packet pts (seconds) of one stream in a container. */
function packetPts(path: string, stream: "v" | "a"): number[] {
	const out = execFileSync(
		"ffprobe",
		[
			"-v",
			"error",
			"-select_streams",
			stream,
			"-show_entries",
			"packet=pts_time",
			"-of",
			"csv=p=0",
			path,
		],
		{ encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
	);
	return out
		.split(/\s+/)
		.filter((line) => line.length > 0 && !line.startsWith("N/A"))
		.map((line) => Number(line.split(",")[0]))
		.sort((a, b) => a - b);
}

/** The largest step between consecutive packet pts. */
function maxStep(pts: number[]): number {
	let max = 0;
	for (let i = 1; i < pts.length; i += 1) {
		max = Math.max(max, (pts[i] as number) - (pts[i - 1] as number));
	}
	return max;
}

describe.skipIf(!HAVE_FFMPEG)(
	"the normalized loop copy-loops as the same frame ring (row #256, real ffmpeg)",
	() => {
		let root = "";
		let src = "";
		let loop = "";
		let frames = 0;
		beforeAll(() => {
			root = mkdtempSync(join(tmpdir(), "bitovp-normalize-"));
			src = join(root, "src.mp4");
			// 9 s of video starting at t=1 s over 10 s of audio: the  shape.
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
			const span = sourceVideoSpan(probe(src));
			expect(span.videoStartSec).toBeGreaterThan(0.9);
			expect(span.videoStartSec).toBeLessThan(1.1);
			expect(span.videoDurationSec).toBeGreaterThan(8.9);
			expect(span.videoDurationSec).toBeLessThan(9.1);
			loop = join(root, "session.loop.mp4");
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
			frames = Math.round(span.videoDurationSec * FPS);
		}, 120_000);
		afterAll(() => {
			// KEEP_NORMALIZE_FIXTURES=1 leaves the loop and the pushed .ts files
			// behind for ffprobe (prints the directory); the default removes them.
			if (process.env.KEEP_NORMALIZE_FIXTURES) {
				process.stderr.write(`normalize fixtures kept in ${root}\n`);
				return;
			}
			rmSync(root, { recursive: true, force: true });
		});

		/** The feeder's push shape: the loop copied `plays` times into one transport stream. */
		function push(
			name: string,
			plays: number,
			demuxFlags: readonly string[],
		): string {
			const pushed = join(root, `${name}-${plays}.ts`);
			execFileSync(
				"ffmpeg",
				[
					"-hide_banner",
					"-v",
					"error",
					"-y",
					...demuxFlags,
					"-stream_loop",
					String(plays - 1),
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
			return pushed;
		}

		it("trims to the video span, starts both streams at 0, and ends the audio on the AAC grid inside the video", () => {
			// The profile is read from the loop's OWN probe, exactly as START does;
			// `loopProfileFromProbe` refuses a loop whose streams do not start at 0
			// or whose audio ends late or more than two AAC frames early.
			const profile = loopProfileFromProbe(
				probe(loop),
				FPS,
				"a".repeat(64),
				"2026-09-07T00:00:00.000Z",
			);
			expect(profile.fps).toBe(FPS);
			expect(profile.frames).toBe(frames);
			expect(profile.loopSeconds * FPS).toBeCloseTo(profile.frames, 6);
			const audioFrame = AAC_FRAME_SAMPLES / SAMPLE_RATE;
			expect(profile.audioEndSec).toBeLessThanOrEqual(profile.loopSeconds);
			expect(profile.loopSeconds - profile.audioEndSec).toBeLessThan(
				2 * audioFrame,
			);
		});

		it("N copy-loop plays conform to exactly N × F frames with one-frame video steps throughout; the audio pauses under two AAC frames at a transition (edit list ignored, as the push does)", () => {
			const flags = ["-ignore_editlist", "1"];
			const one = conformedFrames(
				push("exact", 1, flags),
				join(root, "g1.raw"),
			);
			const two = conformedFrames(
				push("exact", 2, flags),
				join(root, "g2.raw"),
			);
			const three = push("exact", 3, flags);
			expect(one).toBe(frames);
			expect(two).toBe(2 * frames);
			expect(conformedFrames(three, join(root, "g3.raw"))).toBe(3 * frames);
			// Consecutive video packets are one frame apart everywhere, the
			// transitions included. The audio was cut so its packets END inside
			// the video, so at a transition it pauses for (D·ar mod 1024) + 1024
			// samples — under two AAC frames — and never overlaps the next play.
			expect(maxStep(packetPts(three, "v"))).toBeCloseTo(1 / FPS, 3);
			const audioStep = maxStep(packetPts(three, "a"));
			expect(audioStep).toBeGreaterThan(AAC_FRAME_SAMPLES / SAMPLE_RATE);
			expect(audioStep).toBeLessThan((2 * AAC_FRAME_SAMPLES) / SAMPLE_RATE);
		}, 180_000);

		it("control: honouring the edit list stretches every play by one audio frame — the reason the push ignores it", () => {
			const three = push("editlist", 3, []);
			const audioFrame = AAC_FRAME_SAMPLES / SAMPLE_RATE;
			// Two transitions of 0.64 frame each: one extra conformed frame.
			expect(conformedFrames(three, join(root, "g3-editlist.raw"))).toBe(
				3 * frames + 1,
			);
			expect(maxStep(packetPts(three, "v"))).toBeCloseTo(
				1 / FPS + audioFrame,
				3,
			);
		}, 180_000);
	},
);
