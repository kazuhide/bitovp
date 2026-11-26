/**
 * Explicit real-media qualification (requires ffmpeg and ffprobe):
 * pnpm --filter @bitovp/worker exec tsx --test src/feeder/single-pass.media.ts
 * The normal unit suite does not silently skip this separate media check.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildFeederCommand } from "./command";
import { inspectSinglePassPackets } from "./packet-coverage";
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

for (const videoOnly of [false, true])
	test(videoOnly
		? "single pass preserves all low-frame-rate B-frame video when progress time ends early"
		: "single pass reaches natural EOF once, preserving every video frame and the longer audio tail", {
		timeout: 20_000,
	}, async () => {
		const root = mkdtempSync(join(tmpdir(), "bitovp-once-"));
		try {
			const source = join(root, "source.mp4");
			const output = join(root, videoOnly ? "once.ts" : "once.flv");
			const expectedFrames = videoOnly ? 8 : 60;
			const durationSec = videoOnly ? 4 : 2.4;
			exec("ffmpeg", [
				"-hide_banner",
				"-v",
				"error",
				"-filter_threads",
				"1",
				"-y",
				"-f",
				"lavfi",
				"-i",
				videoOnly
					? "testsrc2=size=160x90:rate=2:duration=4"
					: "testsrc2=size=160x90:rate=30:duration=2",
				...(videoOnly
					? []
					: [
							"-f",
							"lavfi",
							"-i",
							"sine=frequency=440:sample_rate=44100:duration=2.4",
						]),
				"-c:v",
				"libx264",
				"-threads:v",
				"1",
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
				"-threads:a",
				"1",
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
				target: videoOnly
					? {
							protocol: "SRT_CALLER",
							host: "example.invalid",
							port: 8000,
						}
					: {
							protocol: "RTMP",
							url: "rtmp://example.invalid/live",
							streamKey: "qualification",
						},
			});
			// Substitute only the transport destination; the production muxer,
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
			const sourceVideoPackets = packetHashes(source, "v:0");
			const sourceAudioPackets = videoOnly ? [] : packetHashes(source, "a:0");
			const packetCounts = {
				video: sourceVideoPackets.length,
				audio: sourceAudioPackets.length,
			};
			const tracks = videoOnly ? { video: 0 } : { video: 0, audio: 1 };
			const signal = new AbortController().signal;
			const sourcePackets = await inspectSinglePassPackets(
				realRunner,
				"ffprobe",
				source,
				tracks,
				signal,
			);
			if ("error" in sourcePackets) throw new Error(sourcePackets.error);
			assert.deepEqual(sourcePackets, packetCounts);
			if (!videoOnly) {
				// Retain the sample table and shorten the picture edit mid-GOP.
				// Demux still returns excluded pictures for decode preroll.
				const edited = join(root, "discarded-pictures.mp4");
				const bytes = readFileSync(source);
				const edit = bytes.indexOf("elst");
				assert.ok(edit > 0);
				assert.equal(bytes[edit + 4], 0);
				assert.equal(bytes.readUInt32BE(edit + 8), 1);
				const fullEdit = bytes.readUInt32BE(edit + 12);
				bytes.writeUInt32BE(Math.floor(fullEdit * 0.375), edit + 12);
				writeFileSync(edited, bytes);
				const coverage = await inspectSinglePassPackets(
					realRunner,
					"ffprobe",
					edited,
					tracks,
					signal,
				);
				assert.ok("error" in coverage);
				assert.match(coverage.error, /preserve.*edit list/);
			}
			const tail: string[][] = [];
			const supervisor = createFeederSupervisor({
				runner,
				ffmpegPath: "ffmpeg",
				argv,
				redactedArgv: argv,
				redactLine: (line) => line,
				playbackMode: "ONCE",
				sourceDurationSec: durationSec,
				sourcePackets,
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
			assert.equal(result.completion?.frames, expectedFrames);
			assert.deepEqual(result.completion?.muxedPackets, sourcePackets);
			assert.equal(spawns, 1);
			// -re permits an initial read burst; a tiny source need not take its
			// full media duration in wall time. EOF, exact packet coverage and the
			// one-spawn count, rather than elapsed time, establish one complete pass.
			assert.ok(
				elapsedMs < 15_000,
				`natural EOF exceeded its bound: ${elapsedMs}ms`,
			);
			const outputVideoPackets = packetHashes(output, "v:0");
			assert.equal(outputVideoPackets.length, sourceVideoPackets.length);
			if (!videoOnly) {
				assert.deepEqual(outputVideoPackets, sourceVideoPackets);
				assert.deepEqual(packetHashes(output, "a:0"), sourceAudioPackets);
			}
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
				expectedFrames,
			);
			console.log(
				JSON.stringify({
					spawns,
					elapsedMs,
					completion: result.completion,
					videoFrames: expectedFrames,
					audioPackets: sourcePackets.audio,
				}),
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
