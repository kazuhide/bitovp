import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { timelineFromContainerProbe } from "@bitovp/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createNodeProcessRunner } from "../feeder/process-runner";
import { probeContainerLoop } from "./loop-probe";
import { extractStats } from "./signatures";

/**
 * , the reproduction that had to fail before PR-B: a source whose
 * video starts 1 s into the container (`-itsoffset 1`, the  sample's
 * shape) is pushed by the feeder as `-stream_loop … -c copy`, which repeats
 * the CONTAINER span. Measured here with real ffmpeg: two copy-loop plays
 * conformed to 30 fps hold ≈ 2 × 300 frames, while the VMAF side's old
 * period — the source's own frame count after `fps=30` — is 270. The
 * container-probe timeline equals the pushed period; the old assumption is a
 * full second short.
 *
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

function countVideoFrames(args: string[]): number {
	const out = execFileSync(
		"ffprobe",
		[
			"-v",
			"error",
			...args,
			"-count_frames",
			"-select_streams",
			"v",
			"-show_entries",
			"stream=nb_read_frames",
			"-of",
			"csv=p=0",
		],
		{ encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
	).trim();
	return Number(out);
}

describe.skipIf(!HAVE_FFMPEG)(
	"the pushed loop period is the container's, not the video frame count (row #256, real ffmpeg)",
	() => {
		let root = "";
		let src = "";
		beforeAll(() => {
			root = mkdtempSync(join(tmpdir(), "bitovp-loop-period-"));
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
		}, 120_000);
		afterAll(() => {
			rmSync(root, { recursive: true, force: true });
		});

		it("the container-probe timeline equals the copy-loop period the feeder pushes, and the old video-frame-count period is a second short", async () => {
			const runner = createNodeProcessRunner();
			const probe = await probeContainerLoop({
				runner,
				ffprobePath: "ffprobe",
				path: src,
			});
			expect(probe.videoStartSec).toBeGreaterThan(0.9);
			const timeline = timelineFromContainerProbe(probe, FPS);

			// What the feeder pushes: the container copied N times, then conformed
			// to the signature grid the way the encoder's fps filter would. The
			// FIRST play's video-less head is never materialized (nothing precedes
			// the first frame), so the period is what ONE MORE play adds — three
			// plays minus two — not the count divided by the plays.
			const conformedFrames = (plays: number): number => {
				const pushed = join(root, `pushed-${plays}.ts`);
				execFileSync(
					"ffmpeg",
					[
						"-hide_banner",
						"-v",
						"error",
						"-y",
						"-stream_loop",
						String(plays - 1),
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
				const conformed = join(root, `conformed-${plays}.mp4`);
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
						"-c:v",
						"libx264",
						"-preset",
						"ultrafast",
						"-an",
						conformed,
					],
					{ stdio: ["ignore", "ignore", "pipe"] },
				);
				return countVideoFrames(["-i", conformed]);
			};
			const pushedPeriod = conformedFrames(3) - conformedFrames(2);

			// The VMAF side's OLD period: the source's own frames after fps=30.
			const oldPeriod = (
				await extractStats({
					runner,
					ffmpegPath: "ffmpeg",
					path: src,
					options: { fps: FPS },
				})
			).length;

			expect(Math.abs(timeline.frames - pushedPeriod)).toBeLessThanOrEqual(1);
			expect(pushedPeriod - oldPeriod).toBeGreaterThanOrEqual(FPS - 2);
			expect(timeline.holes[0]?.toFrame).toBeGreaterThanOrEqual(FPS - 1);
		}, 120_000);
	},
);
