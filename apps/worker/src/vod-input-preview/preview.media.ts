/** Explicit local-media gate; no provider, GPU or model service is contacted. */
import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, truncate } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { VodInputTimelineSource } from "@bitovp/core/vod-input-timeline";
import {
	type ObjectStorageBrowser,
	ObjectVersionMismatchError,
} from "@bitovp/storage";
import { runMediaProcess } from "../library-editing/process";
import { probeVodInputSources, renderVodInputPreview } from "./media";
import { runIndependentOverwriteFixture } from "./overwrite-fixture";

test(
	"real CPU FFmpeg preserves the untouched channel in V1/A1 overwrite, WAV/MP3 and gaps",
	{
		timeout: 90_000,
	},
	runIndependentOverwriteFixture,
);

test("real CPU FFmpeg previews A latter → B first → A first over pinned sparse Range reads", {
	timeout: 60_000,
}, async () => {
	const directory = await mkdtemp(join(tmpdir(), "bitovp-vod-range-media-"));
	try {
		const paths = new Map<string, string>();
		for (const [name, video, audio] of [
			[
				"a",
				"color=red:s=320x240:r=30:d=2,drawbox=x=0:y=0:w=iw:h=ih:color=green:t=fill:enable='gte(t,1)'",
				"sine=frequency=440:sample_rate=48000:duration=1[s0];sine=frequency=880:sample_rate=48000:duration=1[s1];[s0][s1]concat=n=2:v=0:a=1",
			],
			[
				"b",
				"color=blue:s=320x180:r=30:d=2",
				"sine=frequency=660:sample_rate=48000:duration=2",
			],
		] as const) {
			const path = join(directory, `${name}.mp4`);
			await runMediaProcess("ffmpeg", [
				"-v",
				"error",
				"-nostdin",
				"-cpucount",
				"1",
				"-filter_threads",
				"1",
				"-filter_complex_threads",
				"1",
				"-f",
				"lavfi",
				"-i",
				video,
				"-f",
				"lavfi",
				"-i",
				audio,
				"-c:v",
				"libx264",
				"-threads",
				"1",
				"-pix_fmt",
				"yuv420p",
				"-c:a",
				"aac",
				"-ar",
				"48000",
				"-ac",
				"2",
				"-movflags",
				"+faststart",
				path,
			]);
			// Customer object size can greatly exceed the requested clip; data is sparse.
			await truncate(path, 64 * 1024 ** 2);
			paths.set(`${name}.mp4`, path);
		}
		const sources: VodInputTimelineSource[] = ["a", "b"].map((name) => ({
			key: name,
			credentialId: "00000000-0000-4000-8000-000000000001",
			bucket: "private",
			objectKey: `${name}.mp4`,
		}));
		const reads: { start: number; end: number; expect: unknown }[] = [];
		let actualBytes = 0;
		const browserFor = async (): Promise<ObjectStorageBrowser> => ({
			listBuckets: async () => [],
			listObjects: async () => ({ objects: [], prefixes: [] }),
			headObject: async () => ({
				size: 64 * 1024 ** 2,
				etag: '"fixture-version-1"',
			}),
			getObject: async ({ key, range, expect }) => {
				assert.deepEqual(expect, {
					size: 64 * 1024 ** 2,
					etag: '"fixture-version-1"',
				});
				assert.ok(range && range.end !== undefined);
				reads.push({ start: range.start, end: range.end, expect });
				const sourcePath = paths.get(key);
				assert.ok(sourcePath);
				const stream = createReadStream(sourcePath, {
					start: range.start,
					end: range.end,
					highWaterMark: 32 * 1024,
				});
				stream.on("data", (buffer) => {
					actualBytes += buffer.length;
				});
				return stream;
			},
		});
		const signal = AbortSignal.timeout(50_000);
		const facts = await probeVodInputSources({ sources, browserFor, signal });
		assert.equal(facts.length, 2);
		const result = await renderVodInputPreview({
			browserFor,
			signal,
			sources,
			facts,
			directory,
			request: {
				kind: "PREVIEW",
				probeId: "00000000-0000-4000-8000-000000000002",
				document: {
					schemaVersion: 1,
					id: "00000000-0000-4000-8000-000000000003",
					audioEnabled: true,
					clips: [
						{
							id: "00000000-0000-4000-8000-000000000004",
							sourceKey: "a",
							inMs: 1000,
							outMs: 2000,
						},
						{
							id: "00000000-0000-4000-8000-000000000005",
							sourceKey: "b",
							inMs: 0,
							outMs: 1000,
						},
						{
							id: "00000000-0000-4000-8000-000000000006",
							sourceKey: "a",
							inMs: 0,
							outMs: 1000,
						},
					],
				},
				range: { startMs: 0, durationMs: 3000 },
			},
		});
		assert.equal(result.durationMs, 3000);
		assert.equal(result.size, (await stat(result.path)).size);
		assert.match(result.sha256, /^[a-f0-9]{64}$/);
		const metadata = JSON.parse(
			(
				await runMediaProcess("ffprobe", [
					"-v",
					"error",
					"-show_format",
					"-show_streams",
					"-of",
					"json",
					result.path,
				])
			).stdout,
		);
		assert.ok(Math.abs(Number(metadata.format.duration) - 3) < 0.1);
		assert.equal(metadata.streams[0].width, 480);
		assert.equal(metadata.streams[0].height, 360);
		assert.equal(
			metadata.streams.find(
				(s: { codec_type: string }) => s.codec_type === "audio",
			).codec_name,
			"aac",
		);
		for (const [i, second, color, hz] of [
			[0, 0.3, 1, 880],
			[3, 0.95, 1, 880],
			[1, 1.3, 2, 660],
			[4, 1.05, 2, 660],
			[5, 1.95, 2, 660],
			[2, 2.3, 0, 440],
			[6, 2.05, 0, 440],
		] as const) {
			const rgb = join(directory, `frame-${i}.rgb`),
				pcm = join(directory, `audio-${i}.pcm`);
			await runMediaProcess("ffmpeg", [
				"-v",
				"error",
				"-nostdin",
				"-ss",
				String(second),
				"-i",
				result.path,
				"-frames:v",
				"1",
				"-vf",
				"scale=1:1",
				"-f",
				"rawvideo",
				"-pix_fmt",
				"rgb24",
				rgb,
			]);
			const pixel = await readFile(rgb);
			assert.ok(
				pixel.readUInt8(color) > pixel.readUInt8((color + 1) % 3) + 30 &&
					pixel.readUInt8(color) > pixel.readUInt8((color + 2) % 3) + 30,
				`clip ${i} color ${Array.from(pixel)}`,
			);
			await runMediaProcess("ffmpeg", [
				"-v",
				"error",
				"-nostdin",
				"-ss",
				String(second),
				"-i",
				result.path,
				"-t",
				i < 3 ? "0.2" : "0.04",
				"-vn",
				"-ac",
				"1",
				"-ar",
				"48000",
				"-f",
				"s16le",
				pcm,
			]);
			const samples = await readFile(pcm);
			let crossings = 0;
			for (let pos = 2; pos < samples.length; pos += 2)
				if (samples.readInt16LE(pos - 2) <= 0 && samples.readInt16LE(pos) > 0)
					crossings++;
			assert.ok(
				Math.abs(crossings / (samples.length / 2 / 48000) - hz) <
					(i < 3 ? 20 : 30),
				`clip ${i} audio ${crossings}`,
			);
		}
		assert.ok(reads.length >= 5);
		assert.ok(
			reads.every((read) => read.end - read.start + 1 <= 8 * 1024 ** 2),
		);
		assert.ok(
			actualBytes < 32 * 1024 ** 2,
			`read ${actualBytes} bytes of 128MiB source objects`,
		);
		const firstFacts = facts[0],
			firstSource = sources[0];
		assert.ok(firstFacts && firstSource);
		const changed = async (): Promise<ObjectStorageBrowser> => ({
			...(await browserFor()),
			getObject: async () => {
				throw new ObjectVersionMismatchError(
					"private",
					"a.mp4",
					firstFacts.identity,
				);
			},
		});
		await assert.rejects(
			probeVodInputSources({
				sources: [firstSource],
				browserFor: changed,
				signal,
			}),
			{ code: "SOURCE_CHANGED" },
		);

		// 720x576 coded pixels with SAR16:15 display as 4:3, not coded 5:4.
		const anamorphicPath = join(directory, "anamorphic.mp4");
		const rotatedPath = join(directory, "rotated.mp4");
		await runMediaProcess("ffmpeg", [
			"-v",
			"error",
			"-nostdin",
			"-cpucount",
			"1",
			"-filter_threads",
			"1",
			"-f",
			"lavfi",
			"-i",
			"color=yellow:s=720x576:r=30:d=1,drawbox=x=iw/2:y=0:w=iw/2:h=ih:color=cyan:t=fill",
			"-vf",
			"setsar=16/15",
			"-c:v",
			"libx264",
			"-threads",
			"1",
			"-pix_fmt",
			"yuv420p",
			"-movflags",
			"+faststart",
			anamorphicPath,
		]);
		await runMediaProcess("ffmpeg", [
			"-v",
			"error",
			"-nostdin",
			"-display_rotation",
			"90",
			"-i",
			anamorphicPath,
			"-c",
			"copy",
			"-movflags",
			"+faststart",
			rotatedPath,
		]);
		const rawAnamorphic = JSON.parse(
			(
				await runMediaProcess("ffprobe", [
					"-v",
					"error",
					"-show_streams",
					"-of",
					"json",
					anamorphicPath,
				])
			).stdout,
		).streams[0];
		assert.equal(rawAnamorphic.sample_aspect_ratio, "16:15");
		assert.equal(rawAnamorphic.display_aspect_ratio, "4:3");
		for (const [key, path, width, height] of [
			["anamorphic", anamorphicPath, 480, 360],
			["rotated", rotatedPath, 270, 360],
		] as const) {
			const reference = join(directory, `${key}-reference.rgb`);
			await runMediaProcess("ffmpeg", [
				"-v",
				"error",
				"-nostdin",
				"-i",
				path,
				"-frames:v",
				"1",
				"-vf",
				"scale=2:2:flags=neighbor",
				"-f",
				"rawvideo",
				"-pix_fmt",
				"rgb24",
				reference,
			]);
			await truncate(path, 64 * 1024 ** 2);
			paths.set(`${key}.mp4`, path);
			const source: VodInputTimelineSource = {
				...firstSource,
				key,
				objectKey: `${key}.mp4`,
			};
			const measured = await probeVodInputSources({
				sources: [source],
				browserFor,
				signal,
			});
			const outputDirectory = join(directory, `output-${key}`);
			await mkdir(outputDirectory);
			const rendered = await renderVodInputPreview({
				browserFor,
				signal,
				sources: [source],
				facts: measured,
				directory: outputDirectory,
				request: {
					kind: "PREVIEW",
					probeId: "00000000-0000-4000-8000-000000000002",
					document: {
						schemaVersion: 1,
						id: "00000000-0000-4000-8000-000000000003",
						audioEnabled: false,
						clips: [
							{
								id: "00000000-0000-4000-8000-000000000004",
								sourceKey: key,
								inMs: 0,
								outMs: 1000,
							},
						],
					},
					range: { startMs: 0, durationMs: 1000 },
				},
			});
			const output = JSON.parse(
				(
					await runMediaProcess("ffprobe", [
						"-v",
						"error",
						"-show_streams",
						"-of",
						"json",
						rendered.path,
					])
				).stdout,
			).streams[0];
			console.log(
				`display-aspect fixture ${key}: ${output.width}x${output.height} SAR=${output.sample_aspect_ratio} DAR=${output.display_aspect_ratio}`,
			);
			assert.equal(output.width, width);
			assert.equal(output.height, height);
			assert.equal(output.sample_aspect_ratio, "1:1");
			assert.ok(
				!output.side_data_list?.some(
					(side: { rotation?: number }) => side.rotation,
				),
				"output must not request a second display rotation",
			);
			const actual = join(directory, `${key}-actual.rgb`);
			await runMediaProcess("ffmpeg", [
				"-v",
				"error",
				"-nostdin",
				"-i",
				rendered.path,
				"-frames:v",
				"1",
				"-vf",
				"scale=2:2:flags=neighbor",
				"-f",
				"rawvideo",
				"-pix_fmt",
				"rgb24",
				actual,
			]);
			const expectedPixels = await readFile(reference),
				actualPixels = await readFile(actual);
			assert.equal(actualPixels.length, expectedPixels.length);
			assert.ok(
				Array.from(actualPixels).every(
					(channel, i) => Math.abs(channel - expectedPixels.readUInt8(i)) < 12,
				),
				`${key} preserves displayed orientation`,
			);
			const edge = join(directory, `${key}-edge.rgb`);
			await runMediaProcess("ffmpeg", [
				"-v",
				"error",
				"-nostdin",
				"-i",
				rendered.path,
				"-frames:v",
				"1",
				"-vf",
				"crop=2:2:4:4,scale=1:1",
				"-f",
				"rawvideo",
				"-pix_fmt",
				"rgb24",
				edge,
			]);
			assert.ok(
				Array.from(await readFile(edge)).some((channel) => channel > 100),
				`${key} has no false padding caused by discarded SAR`,
			);
			if (key === "anamorphic") {
				const nextSource = sources[1],
					mainFacts = measured[0],
					nextFacts = facts[1];
				assert.ok(nextSource && mainFacts && nextFacts);
				const windowDirectory = join(directory, "window-after-anamorphic-main");
				await mkdir(windowDirectory);
				const window = await renderVodInputPreview({
					browserFor,
					signal,
					sources: [source, nextSource],
					facts: [mainFacts, nextFacts],
					directory: windowDirectory,
					request: {
						kind: "PREVIEW",
						probeId: "00000000-0000-4000-8000-000000000002",
						document: {
							schemaVersion: 1,
							id: "00000000-0000-4000-8000-000000000003",
							audioEnabled: false,
							clips: [
								{
									id: "00000000-0000-4000-8000-000000000004",
									sourceKey: key,
									inMs: 0,
									outMs: 1000,
								},
								{
									id: "00000000-0000-4000-8000-000000000005",
									sourceKey: nextSource.key,
									inMs: 0,
									outMs: 1000,
								},
							],
						},
						range: { startMs: 1000, durationMs: 1000 },
					},
				});
				const windowVideo = JSON.parse(
					(
						await runMediaProcess("ffprobe", [
							"-v",
							"error",
							"-show_streams",
							"-of",
							"json",
							window.path,
						])
					).stdout,
				).streams[0];
				assert.equal(windowVideo.width, 480);
				assert.equal(windowVideo.height, 360);
				console.log(
					"display-aspect fixture later preview window retained original anamorphic main: 480x360",
				);
			}
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
