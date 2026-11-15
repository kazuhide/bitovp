import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ObjectStorageBrowser } from "@bitovp/storage";
import { runMediaProcess } from "../library-editing/process";
import { probeVodInputSources } from "./media";
import { prepareVodInputTimeline } from "./prepare-timeline";

test("full-resolution prepared input preserves five video cuts against three independent audio cuts", {
	timeout: 120_000,
}, async () => {
	const directory = await mkdtemp(join(tmpdir(), "bitovp-av-preparation-"));
	try {
		const paths = new Map<string, string>();
		for (const [name, color, width, height, duration, frequency] of [
			["a", "red", 960, 540, 12, 440],
			["b", "blue", 640, 360, 12, 880],
			["still", "yellow", 1920, 1080, 2, 0],
		] as const) {
			const path = join(directory, `${name}.mp4`);
			paths.set(`${name}.mp4`, path);
			await runMediaProcess(
				"ffmpeg",
				[
					"-v",
					"error",
					"-nostdin",
					"-filter_threads",
					"1",
					"-f",
					"lavfi",
					"-i",
					`color=${color}:s=${width}x${height}:r=30000/1001:d=${duration},setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709`,
					"-f",
					"lavfi",
					"-i",
					`sine=frequency=${frequency}:sample_rate=48000:duration=${duration}`,
					"-c:v",
					"libx264",
					"-preset",
					"ultrafast",
					"-crf",
					"12",
					"-threads",
					"1",
					"-pix_fmt",
					"yuv420p",
					"-color_primaries",
					"bt709",
					"-color_trc",
					"bt709",
					"-colorspace",
					"bt709",
					"-c:a",
					"aac",
					"-ac",
					"2",
					"-movflags",
					"+faststart",
					path,
				],
				{ timeoutMs: 30_000 },
			);
		}
		const browserFor = async (): Promise<ObjectStorageBrowser> => ({
			listBuckets: async () => [],
			listObjects: async () => ({ objects: [], prefixes: [] }),
			headObject: async ({ key }) => ({
				size: (await stat(paths.get(key) ?? "")).size,
				etag: `"${key}"`,
			}),
			getObject: async ({ key, range, expect }) => {
				const path = paths.get(key);
				assert.ok(path);
				assert.ok(expect?.etag);
				return createReadStream(path, { start: range?.start, end: range?.end });
			},
			putObject: async ({ key, filePath }) => {
				const path = join(directory, "uploaded.mp4");
				await copyFile(filePath, path);
				paths.set(key, path);
			},
		});
		const sources = ["a", "b", "still"].map((key) => ({
			key,
			credentialId: "00000000-0000-4000-8000-000000000001",
			bucket: "synthetic",
			objectKey: `${key}.mp4`,
		}));
		const signal = AbortSignal.timeout(110_000);
		const facts = await probeVodInputSources({ browserFor, sources, signal });
		const clip = (
			sourceKey: string,
			startMs: number,
			inMs: number,
			outMs: number,
		) => ({ id: randomUUID(), sourceKey, startMs, inMs, outMs });
		const work = join(directory, "work");
		await mkdir(work);
		const prepared = await prepareVodInputTimeline({
			browserFor,
			sources,
			facts,
			signal,
			directory: work,
			organizationId: randomUUID(),
			taskId: randomUUID(),
			attemptId: randomUUID(),
			request: {
				kind: "TIMELINE_PREPARE",
				probeId: randomUUID(),
				output: {
					credentialId: "00000000-0000-4000-8000-000000000001",
					bucket: "output",
					prefix: "timeline/",
				},
				document: {
					schemaVersion: 2,
					id: randomUUID(),
					durationMs: 24000,
					audioEnabled: true,
					videoClips: [
						clip("a", 0, 0, 8000),
						clip("b", 8000, 0, 2000),
						clip("still", 10000, 0, 2000),
						clip("b", 12000, 2000, 6000),
						clip("a", 16000, 0, 8000),
					],
					audioClips: [
						clip("a", 0, 0, 8000),
						clip("b", 8000, 0, 8000),
						clip("a", 16000, 0, 8000),
					],
				},
			},
		});
		assert.equal(prepared.facts.video?.width, 960);
		assert.equal(prepared.facts.video?.height, 540);
		assert.deepEqual(prepared.facts.video?.frameRate, {
			num: 30000,
			den: 1001,
		});
		assert.ok(Math.abs(prepared.facts.durationMs - 24000) < 60);
		const path = paths.get(prepared.source.objectKey);
		assert.ok(path);
		assert.equal(
			createHash("sha256")
				.update(await readFile(path))
				.digest("hex"),
			prepared.sha256,
		);
		for (const [at, channel] of [
			[7.8, 0],
			[8.2, 2],
			[10.5, 1],
			[12.5, 2],
			[16.3, 0],
		] as const) {
			const frame = join(directory, `at-${at}.rgb`);
			await runMediaProcess("ffmpeg", [
				"-v",
				"error",
				"-ss",
				String(at),
				"-i",
				path,
				"-frames:v",
				"1",
				"-vf",
				"scale=1:1",
				"-f",
				"rawvideo",
				"-pix_fmt",
				"rgb24",
				frame,
			]);
			const pixel = await readFile(frame);
			assert.ok(
				(pixel[channel] ?? -1) > 150,
				`expected picture at ${at}s: ${pixel.toString("hex")}`,
			);
		}
		// The middle still picture must keep the independently selected 880Hz audio, without silence or a swapped source.
		for (const [at, expected] of [
			[7, 440],
			[10.5, 880],
			[17, 440],
		] as const) {
			const audio = join(directory, `at-${at}.pcm`);
			await runMediaProcess("ffmpeg", [
				"-v",
				"error",
				"-ss",
				String(at),
				"-i",
				path,
				"-t",
				"0.2",
				"-vn",
				"-ac",
				"1",
				"-ar",
				"48000",
				"-f",
				"s16le",
				audio,
			]);
			const raw = await readFile(audio);
			const samples = Array.from({ length: raw.length / 2 }, (_, i) =>
				raw.readInt16LE(i * 2),
			);
			const energy = (hz: number) => {
				let re = 0,
					im = 0;
				samples.forEach((sample, index) => {
					re += sample * Math.cos((2 * Math.PI * hz * index) / 48000);
					im += sample * Math.sin((2 * Math.PI * hz * index) / 48000);
				});
				return re * re + im * im;
			};
			assert.ok(
				energy(expected) > 100 * energy(expected === 440 ? 880 : 440),
				`wrong audio at ${at}s`,
			);
		}
		console.log(
			`verified prepared ${prepared.facts.video?.width}x${prepared.facts.video?.height} 30000/1001, 24s, 5V/3A, still and frequency-aligned audio; sha256=${prepared.sha256}`,
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
