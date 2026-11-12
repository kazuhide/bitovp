/** Real local FFmpeg coverage for independent V1/A1; all media is synthetic. */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
	copyFile,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	buildVodInputSourcePreviewDocument,
	type VodInputTimelineSource,
	type VodInputTimelineV2Document,
} from "@bitovp/core/vod-input-timeline";
import type { ObjectStorageBrowser } from "@bitovp/storage";
import { runMediaProcess } from "../library-editing/process";
import { probeVodInputSources, renderVodInputPreview } from "./media";

const common = [
	"-v",
	"error",
	"-nostdin",
	"-cpucount",
	"1",
	"-filter_threads",
	"1",
	"-filter_complex_threads",
	"1",
];
const clip = (
	sourceKey: string,
	startMs: number,
	inMs: number,
	outMs: number,
) => ({ id: randomUUID(), sourceKey, startMs, inMs, outMs });
const digest = (bytes: Buffer) =>
	createHash("sha256").update(bytes).digest("hex");

export async function runIndependentOverwriteFixture() {
	const directory = await mkdtemp(
		join(tmpdir(), "bitovp-vod-independent-media-"),
	);
	try {
		const paths = new Map<string, string>();
		for (const [name, video, audio] of [
			[
				"a",
				"color=red:s=320x240:r=30:d=4,drawbox=x=0:y=0:w=iw:h=ih:color=green:t=fill:enable='gte(t,2)'",
				"sine=frequency=440:sample_rate=48000:duration=2[s0];sine=frequency=880:sample_rate=48000:duration=2[s1];[s0][s1]concat=n=2:v=0:a=1",
			],
			[
				"b",
				"color=blue:s=320x180:r=30:d=4",
				"sine=frequency=660:sample_rate=48000:duration=4",
			],
			[
				"e",
				"color=yellow:s=320x180:r=30:d=4",
				"sine=frequency=770:sample_rate=48000:duration=18",
			],
		] as const) {
			const path = join(directory, `${name}.mp4`);
			await runMediaProcess("ffmpeg", [
				...common,
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
			paths.set(`${name}.mp4`, path);
		}
		const wav = join(directory, "c.wav");
		await runMediaProcess("ffmpeg", [
			...common,
			"-f",
			"lavfi",
			"-i",
			"sine=frequency=990:sample_rate=48000:duration=4",
			"-c:a",
			"pcm_s16le",
			"-ar",
			"48000",
			"-ac",
			"2",
			"-map_metadata",
			"-1",
			wav,
		]);
		paths.set("c.wav", wav);
		const mp3 = join(directory, "d.mp3");
		await copyFile(
			fileURLToPath(new URL("./fixtures/tone-660hz.mp3", import.meta.url)),
			mp3,
		);
		paths.set("d.mp3", mp3);
		const sizes = new Map(
			await Promise.all(
				[...paths].map(
					async ([key, path]) => [key, (await stat(path)).size] as const,
				),
			),
		);
		let reads = 0;
		const browserFor = async (): Promise<ObjectStorageBrowser> => ({
			listBuckets: async () => [],
			listObjects: async () => ({ objects: [], prefixes: [] }),
			headObject: async ({ key }) => ({
				size: sizes.get(key) ?? 0,
				etag: '"synthetic-v1"',
			}),
			getObject: async ({ key, range, expect }) => {
				const path = paths.get(key),
					size = sizes.get(key);
				assert.ok(path && size && range?.end !== undefined);
				assert.deepEqual(expect, { size, etag: '"synthetic-v1"' });
				reads++;
				return createReadStream(path, {
					start: range.start,
					end: range.end,
					highWaterMark: 32 * 1024,
				});
			},
		});
		const sources: VodInputTimelineSource[] = [...paths.keys()].map(
			(objectKey) => ({
				key: objectKey.slice(0, 1),
				credentialId: "00000000-0000-4000-8000-000000000001",
				bucket: "synthetic",
				objectKey,
			}),
		);
		const signal = AbortSignal.timeout(75_000);
		const facts = await probeVodInputSources({ sources, browserFor, signal });
		assert.equal(facts.find((fact) => fact.key === "c")?.video, null);
		assert.equal(facts.find((fact) => fact.key === "d")?.video, null);
		const document = (
			videoClips: VodInputTimelineV2Document["videoClips"],
			audioClips: VodInputTimelineV2Document["audioClips"],
			durationMs = 4000,
		): VodInputTimelineV2Document => ({
			schemaVersion: 2,
			id: randomUUID(),
			audioEnabled: true,
			durationMs,
			videoClips,
			audioClips,
		});
		const base = document([clip("a", 0, 0, 4000)], [clip("a", 0, 0, 4000)]);
		const audioOverwrite = {
			...base,
			audioClips: [
				clip("a", 0, 0, 1000),
				clip("c", 1000, 0, 2000),
				clip("a", 3000, 3000, 4000),
			],
		};
		const videoOverwrite = {
			...base,
			videoClips: [
				clip("a", 0, 0, 1000),
				clip("b", 1000, 0, 2000),
				clip("a", 3000, 3000, 4000),
			],
		};
		const render = async (
			name: string,
			doc: VodInputTimelineV2Document,
			startMs = 0,
			durationMs = doc.durationMs,
			sourcePreviewKey?: string,
		) => {
			const outputDirectory = join(directory, name);
			await mkdir(outputDirectory);
			const result = await renderVodInputPreview({
				browserFor,
				signal,
				sources,
				facts,
				directory: outputDirectory,
				request: {
					kind: "PREVIEW",
					probeId: randomUUID(),
					document: doc,
					range: { startMs, durationMs },
					...(sourcePreviewKey ? { sourcePreviewKey } : {}),
				},
			});
			assert.deepEqual(
				await readdir(outputDirectory),
				["preview.mp4"],
				"all intermediate files must be removed",
			);
			return result.path;
		};
		const decode = async (path: string, media: "video" | "audio") => {
			const target = join(
				directory,
				`${randomUUID()}.${media === "video" ? "rgb" : "pcm"}`,
			);
			await runMediaProcess(
				"ffmpeg",
				[
					...common,
					"-i",
					path,
					...(media === "video"
						? ["-map", "0:v:0", "-an", "-pix_fmt", "rgb24", "-f", "rawvideo"]
						: [
								"-map",
								"0:a:0",
								"-vn",
								"-ar",
								"48000",
								"-ac",
								"1",
								"-f",
								"s16le",
							]),
					target,
				],
				{ signal },
			);
			return await readFile(target);
		};
		const basePath = await render("baseline", base),
			audioPath = await render("audio-overwrite", audioOverwrite),
			videoPath = await render("video-overwrite", videoOverwrite);
		const baseVideo = digest(await decode(basePath, "video")),
			baseAudio = digest(await decode(basePath, "audio"));
		assert.equal(
			digest(await decode(audioPath, "video")),
			baseVideo,
			"A1 overwrite must leave every decoded V1 frame identical",
		);
		assert.equal(
			digest(await decode(videoPath, "audio")),
			baseAudio,
			"V1 overwrite must leave every decoded A1 sample identical",
		);
		assert.notEqual(digest(await decode(audioPath, "audio")), baseAudio);
		assert.notEqual(digest(await decode(videoPath, "video")), baseVideo);
		const sample = async (path: string, second: number) => {
			const rgb = join(directory, `${randomUUID()}.rgb`),
				pcm = join(directory, `${randomUUID()}.pcm`);
			await runMediaProcess(
				"ffmpeg",
				[
					...common,
					"-ss",
					String(second),
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
					rgb,
				],
				{ signal },
			);
			await runMediaProcess(
				"ffmpeg",
				[
					...common,
					"-ss",
					String(second),
					"-i",
					path,
					"-t",
					"0.15",
					"-vn",
					"-ac",
					"1",
					"-ar",
					"48000",
					"-f",
					"s16le",
					pcm,
				],
				{ signal },
			);
			const bytes = await readFile(pcm);
			let crossings = 0,
				energy = 0;
			for (let i = 0; i < bytes.length; i += 2) {
				const value = bytes.readInt16LE(i);
				energy += value * value;
				if (i && bytes.readInt16LE(i - 2) <= 0 && value > 0) crossings++;
			}
			return {
				rgb: await readFile(rgb),
				hz: crossings / (bytes.length / 2 / 48000),
				rms: Math.sqrt(energy / (bytes.length / 2)),
			};
		};
		for (const [second, color, hz] of [
			[0.4, 0, 440],
			[1.4, 0, 990],
			[2.4, 1, 990],
			[3.4, 1, 880],
		] as const) {
			const measured = await sample(audioPath, second);
			assert.ok(
				measured.rgb.readUInt8(color) >
					measured.rgb.readUInt8((color + 1) % 3) + 30,
			);
			assert.ok(
				Math.abs(measured.hz - hz) < 30,
				`audio overwrite at ${second}s: ${measured.hz}Hz expected ${hz}`,
			);
		}
		for (const [second, color, hz] of [
			[0.4, 0, 440],
			[1.4, 2, 440],
			[2.4, 2, 880],
			[3.4, 1, 880],
		] as const) {
			const measured = await sample(videoPath, second);
			assert.ok(
				measured.rgb.readUInt8(color) >
					measured.rgb.readUInt8((color + 1) % 3) + 30,
			);
			assert.ok(Math.abs(measured.hz - hz) < 30);
		}
		const gapDocument = document(
			[clip("a", 1000, 0, 1000)],
			[clip("c", 2000, 0, 1000)],
		);
		const gaps = await render("gaps", gapDocument);
		for (const second of [0.3, 3.4]) {
			const measured = await sample(gaps, second);
			assert.ok([...measured.rgb].every((channel) => channel < 10));
			assert.ok(measured.rms < 2, `gap at ${second}s must be silent`);
		}
		const videoOnly = await sample(gaps, 1.4),
			audioOnly = await sample(gaps, 2.4);
		assert.ok(
			videoOnly.rgb[0] !== undefined &&
				videoOnly.rgb[0] > 100 &&
				videoOnly.rms < 2,
		);
		assert.ok(
			[...audioOnly.rgb].every((channel) => channel < 10) &&
				Math.abs(audioOnly.hz - 990) < 30,
		);
		// A later window keeps full-program 4:3 canvas even when only 16:9 B is visible.
		const window = await render("later-window", videoOverwrite, 1500, 1000);
		const metadata = async (path: string) =>
			JSON.parse(
				(
					await runMediaProcess(
						"ffprobe",
						["-v", "error", "-show_streams", "-of", "json", path],
						{ signal },
					)
				).stdout,
			);
		// No source is visible in this window, but the full A1 track still exists.
		const gapWindow = await render("gap-window", gapDocument, 0, 500);
		const silentWindow = await sample(gapWindow, 0.2);
		assert.ok([...silentWindow.rgb].every((channel) => channel < 10));
		assert.ok(silentWindow.rms < 2);
		assert.equal(
			(await metadata(gapWindow)).streams.filter(
				(stream: { codec_type: string }) => stream.codec_type === "audio",
			).length,
			1,
		);
		assert.equal((await metadata(window)).streams[0].width, 480);
		assert.equal((await metadata(window)).streams[0].height, 360);
		const noAudio = await render("empty-audio", document(base.videoClips, []));
		assert.equal(
			(await metadata(noAudio)).streams.filter(
				(stream: { codec_type: string }) => stream.codec_type === "audio",
			).length,
			0,
		);
		for (const key of ["c", "d"]) {
			const black = await render(
				`audio-only-${key}`,
				document([], [clip(key, 0, 0, 1000)], 1000),
			);
			const output = await metadata(black),
				measured = await sample(black, 0.3);
			assert.equal(output.streams[0].width, 640);
			assert.equal(output.streams[0].height, 360);
			assert.ok([...measured.rgb].every((channel) => channel < 10));
			assert.ok(Math.abs(measured.hz - (key === "c" ? 990 : 660)) < 30);
		}
		assert.ok(
			reads > 20,
			"probe and both render passes must use pinned range reads",
		);
		const longSource = facts.find((fact) => fact.key === "e");
		assert.ok(longSource);
		assert.equal(longSource.durationMs, 4000);
		assert.equal(longSource.audio?.durationMs, 18000);
		const natural = buildVodInputSourcePreviewDocument(longSource, {
			documentId: randomUUID(),
			clipId: randomUUID(),
		});
		const longPreview = await render(
			"natural-long-source",
			natural,
			0,
			18000,
			"e",
		);
		const tail = await sample(longPreview, 15);
		assert.ok([...tail.rgb].every((channel) => channel < 10));
		assert.ok(
			Math.abs(tail.hz - 770) < 30,
			"audio continues after source video ends",
		);
		await assert.rejects(render("unmarked-long-project", natural), {
			code: "TIMELINE_GAP_TOO_LONG",
		});
		const edited = structuredClone(natural);
		if (edited.audioClips[0]) edited.audioClips[0].outMs = 17000;
		await assert.rejects(render("forged-long-source", edited, 0, 18000, "e"), {
			code: "SOURCE_PREVIEW_INVALID",
		});
		console.log(
			`independent A/V media: unchanged V1 sha256=${baseVideo}; unchanged A1 sha256=${baseAudio}; WAV/MP3, gaps, source window and cleanup passed`,
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}
