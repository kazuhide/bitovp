import { execFileSync } from "node:child_process";
import {
	createReadStream,
	mkdtempSync,
	readdirSync,
	rmSync,
	statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LiveCaptureTarget } from "@bitovp/core";
import type { ObjectStorageBrowser } from "@bitovp/storage";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ResolvedCredential } from "../orchestrator/executor";
import { captureRenditionWindow } from "./live-capture";

/**
 * Reproduces live VMAF capture failures with real ffmpeg: no packets and zero
 * decoded frames despite every segment being individually readable. Reading
 * individual segments alone therefore cannot prove that the assembled clip
 * can be decoded.
 *
 * ffmpeg's concat DEMUXER opens every list entry as a standalone container. A
 * bare fMP4 fragment (`.m4s`) has no `moov`, so each one fails with "trun track
 * id unknown, no tfhd was found" and the assembled clip has no frames. The fMP4
 * contract is a BYTE concatenation — init, then the fragments in order — which
 * is what a player does and what the capture now writes.
 *
 * Skipped, never faked, when ffmpeg/ffprobe are not on PATH: the worker's
 * Docker image carries both, and a developer machine without them gets a named
 * skip instead of a green that proved nothing.
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

function countFrames(input: string[]): number | "unreadable" {
	try {
		const out = execFileSync(
			"ffprobe",
			[
				"-v",
				"error",
				...input,
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
		const n = Number(out);
		return Number.isFinite(n) && n > 0 ? n : "unreadable";
	} catch {
		return "unreadable";
	}
}

const FRAMES = 75; // 3 s at 25 fps

describe.skipIf(!HAVE_FFMPEG)(
	"live capture assembles fMP4 as one playable clip (ledger #210, real ffmpeg)",
	() => {
		let root = "";
		let segDir = "";
		beforeAll(() => {
			root = mkdtempSync(join(tmpdir(), "live-capture-ffmpeg-"));
			segDir = join(root, "seg");
			const src = join(root, "src.mp4");
			execFileSync("ffmpeg", [
				"-hide_banner",
				"-loglevel",
				"error",
				"-y",
				"-f",
				"lavfi",
				"-i",
				"testsrc=size=320x180:rate=25",
				"-t",
				"3",
				"-c:v",
				"libx264",
				"-g",
				"25",
				"-keyint_min",
				"25",
				"-pix_fmt",
				"yuv420p",
				src,
			]);
			execFileSync("mkdir", ["-p", segDir]);
			execFileSync("ffmpeg", [
				"-hide_banner",
				"-loglevel",
				"error",
				"-y",
				"-i",
				src,
				"-c",
				"copy",
				"-f",
				"hls",
				"-hls_time",
				"1",
				"-hls_playlist_type",
				"vod",
				"-hls_segment_type",
				"fmp4",
				"-hls_fmp4_init_filename",
				"init.mp4",
				"-hls_segment_filename",
				join(segDir, "segment_%d.m4s"),
				join(segDir, "stream.m3u8"),
			]);
		});
		afterAll(() => {
			if (root) {
				rmSync(root, { recursive: true, force: true });
			}
		});

		/** A browser over the local segment directory, keyed like origin storage. */
		function localBrowser(): ObjectStorageBrowser {
			const prefix = "output/live/video/180p";
			return {
				listBuckets: async () => ["b"],
				listObjects: async () => ({
					prefixes: [],
					objects: readdirSync(segDir)
						.filter((n) => n !== "stream.m3u8")
						.map((n) => ({
							key: `${prefix}/${n}`,
							size: statSync(join(segDir, n)).size,
							// Listing happens after the capture cutoff; retain the file's
							// earlier write time so valid fragments do not become future data.
							lastModified: statSync(join(segDir, n)).mtime.toISOString(),
						})),
				}),
				getObject: async ({ key }: { key: string }) =>
					createReadStream(join(segDir, key.slice(prefix.length + 1))),
			} as unknown as ObjectStorageBrowser;
		}

		const target: LiveCaptureTarget = {
			renditionKey: "v180",
			codec: "H264",
			height: 180,
			bitrate: 300000,
			outputKey: "origin",
			segmentPrefix: "output/live/video/180p",
			kind: "FMP4",
			initSegmentName: "init.mp4",
			segmentNaming: "segment_%number%.m4s",
			segmentLengthSec: 6,
		};
		const credential = {
			provider: "S3",
			config: {},
			secret: {},
		} as unknown as ResolvedCredential;

		it("the byte-concatenated clip decodes every source frame; the concat-demuxer list decodes none", async () => {
			const jobDir = join(root, "job");
			execFileSync("mkdir", ["-p", jobDir]);
			const clip = await captureRenditionWindow({
				deps: {
					resolveCredential: async () => credential,
					makeBrowser: () => localBrowser(),
				},
				credential,
				bucket: "b",
				target,
				jobDir,
				windowSeconds: 600,
				now: Date.now(),
				fallbackCount: 10,
			});
			expect(clip.container).toBe("FMP4");
			expect(clip.segmentCount).toBe(3);
			expect(countFrames(["-i", clip.clipPath])).toBe(FRAMES);

			// The counter-proof: the assembly this replaced. Same downloaded parts,
			// listed for the concat demuxer — the way every Live capture used to be
			// handed to signalstats and libvmaf.
			const parts = clip.localPaths.filter(
				(p) => p.endsWith("-init.mp4") || p.endsWith(".m4s"),
			);
			const list = join(jobDir, "old-concat.txt");
			execFileSync("sh", [
				"-c",
				`printf '%s\\n' ${parts.map((p) => `"file '${p}'"`).join(" ")} > "${list}"`,
			]);
			expect(countFrames(["-f", "concat", "-safe", "0", "-i", list])).toBe(
				"unreadable",
			);
		});
	},
);
