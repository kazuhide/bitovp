/**
 * Explicit real-media qualification (requires ffmpeg and ffprobe):
 * pnpm --filter @bitovp/worker exec tsx --test src/feeder/single-pass.media.ts
 * The normal unit suite does not silently skip this separate media check.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildFeederCommand } from "./command";
import { createNodeProcessRunner } from "./process-runner";
import { createFeederSupervisor, type ProcessRunner } from "./supervisor";

function exec(bin: string, argv: string[]): string {
	return execFileSync(bin, argv, {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		maxBuffer: 8 * 1024 * 1024,
	});
}

function packetHashes(path: string, stream: string): string[] {
	const data = JSON.parse(
		exec("ffprobe", [
			"-v",
			"error",
			"-select_streams",
			stream,
			"-show_packets",
			"-show_data_hash",
			"sha256",
			"-show_entries",
			"packet=data_hash",
			"-of",
			"json",
			path,
		]),
	) as { packets: { data_hash: string }[] };
	return data.packets.map((packet) => packet.data_hash);
}

test("single pass reaches natural EOF once, preserving every video frame and the longer audio tail", {
	timeout: 20_000,
}, async () => {
	const root = mkdtempSync(join(tmpdir(), "bitovp-once-"));
	try {
		const source = join(root, "source.mp4");
		const output = join(root, "once.flv");
		exec("ffmpeg", [
			"-hide_banner",
			"-v",
			"error",
			"-y",
			"-f",
			"lavfi",
			"-i",
			"testsrc2=size=160x90:rate=30:duration=2",
			"-f",
			"lavfi",
			"-i",
			"sine=frequency=440:sample_rate=44100:duration=2.4",
			"-c:v",
			"libx264",
			"-preset",
			"ultrafast",
			"-bf",
			"2",
			"-g",
			"30",
			"-pix_fmt",
			"yuv420p",
			"-c:a",
			"aac",
			source,
		]);
		const sourceVideo = JSON.parse(
			exec("ffprobe", [
				"-v",
				"error",
				"-select_streams",
				"v:0",
				"-show_entries",
				"stream=has_b_frames",
				"-of",
				"json",
				source,
			]),
		) as { streams: { has_b_frames: number }[] };
		assert.equal(sourceVideo.streams[0]?.has_b_frames, 2);
		const built = buildFeederCommand({
			sourcePath: source,
			playbackMode: "ONCE",
			decision: { mode: "copy", reasons: ["media qualification"] },
			target: {
				protocol: "RTMP",
				url: "rtmp://example.invalid/live",
				streamKey: "qualification",
			},
		});
		// Substitute only the transport destination; the production FLV command,
		// pacing, edit-list handling and stream mapping are otherwise unchanged.
		const argv = [...built.argv.slice(0, -1), output];
		const realRunner = createNodeProcessRunner();
		let spawns = 0;
		const runner: ProcessRunner = {
			...realRunner,
			spawn(bin, args, events) {
				spawns += 1;
				return realRunner.spawn(bin, args, events);
			},
		};
		const tail: string[][] = [];
		const supervisor = createFeederSupervisor({
			runner,
			ffmpegPath: "ffmpeg",
			argv,
			redactedArgv: argv,
			redactLine: (line) => line,
			playbackMode: "ONCE",
			sourceDurationSec: 2.4,
			sourceFrames: 60,
			now: () => new Date().toISOString(),
			sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
			store: {
				beginAttempt: async () => "media-once-attempt",
				attachAttemptProcess: async () => {},
				recordAttemptObservation: async () => {},
				finishAttempt: async () => {},
				setPushing: async () => true,
				appendBoundary: async () => {},
				flushLogTail: async (lines) => {
					tail.push(lines);
				},
			},
		});
		const startedAt = Date.now();
		const result = await supervisor.run();
		const elapsedMs = Date.now() - startedAt;
		assert.equal(
			result.outcome,
			"STOPPED",
			JSON.stringify({ result, tail: tail.at(-1) }),
		);
		assert.equal(result.completion?.reason, "EOF");
		assert.equal(result.completion?.frames, 60);
		assert.equal(spawns, 1);
		// -re permits an initial read burst; a tiny source need not take its
		// full media duration in wall time. EOF, exact packet coverage and the
		// one-spawn count, rather than elapsed time, establish one complete pass.
		assert.ok(
			elapsedMs < 15_000,
			`natural EOF exceeded its bound: ${elapsedMs}ms`,
		);
		assert.deepEqual(packetHashes(output, "v:0"), packetHashes(source, "v:0"));
		assert.deepEqual(packetHashes(output, "a:0"), packetHashes(source, "a:0"));
		const counts = JSON.parse(
			exec("ffprobe", [
				"-v",
				"error",
				"-count_frames",
				"-show_entries",
				"stream=codec_type,nb_read_frames",
				"-of",
				"json",
				output,
			]),
		) as { streams: { codec_type: string; nb_read_frames: string }[] };
		assert.equal(
			Number(
				counts.streams.find((stream) => stream.codec_type === "video")
					?.nb_read_frames,
			),
			60,
		);
		console.log(
			JSON.stringify({
				spawns,
				elapsedMs,
				completion: result.completion,
				videoFrames: 60,
				audioPackets: packetHashes(output, "a:0").length,
			}),
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
