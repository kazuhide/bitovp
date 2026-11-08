/** Explicit native gate: pnpm --filter @bitovp/worker exec tsx --test src/library-editing/render.media.ts */
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { RenderRecipe } from "@bitovp/core";
import { probeEditingMedia } from "./media";
import { runMediaProcess } from "./process";
import { renderEditingRecipe } from "./render";

test("native FFmpeg editing uses identical boundaries, crop, and audio in preview/export", {
	timeout: 60000,
}, async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "bitovp-edit-native-"));
	try {
		const sourcePath = join(dir, "source file.mp4");
		await runMediaProcess("ffmpeg", [
			"-v",
			"error",
			"-nostdin",
			"-f",
			"lavfi",
			"-i",
			"color=red:s=320x180:r=30:d=2,drawbox=x=160:y=0:w=160:h=180:color=blue:t=fill,drawbox=x=0:y=0:w=160:h=180:color=green:t=fill:enable='gte(t,1)',drawbox=x=160:y=0:w=160:h=180:color=yellow:t=fill:enable='gte(t,1)'",
			"-f",
			"lavfi",
			"-i",
			"sine=frequency=440:sample_rate=48000:duration=2",
			"-c:v",
			"libx264",
			"-threads",
			"2",
			"-pix_fmt",
			"yuv420p",
			"-color_primaries",
			"bt709",
			"-color_trc",
			"bt709",
			"-colorspace",
			"bt709",
			"-x264-params",
			"colorprim=bt709:transfer=bt709:colormatrix=bt709",
			"-c:a",
			"aac",
			"-ar",
			"48000",
			"-ac",
			"2",
			sourcePath,
		]);
		const facts = await probeEditingMedia({ sourcePath });
		assert.equal(facts.frameCount, 60);
		assert.equal(facts.hasAudio, true);
		const recipe: RenderRecipe = {
			schemaVersion: 1,
			compilerVersion: "content-editing-v1",
			mediaVersionId: "media",
			timeMapId: "map",
			canvas: { width: 1080, height: 1920 },
			fps: { num: 30, den: 1 },
			durationFrames: 60,
			segments: [
				{
					clipId: "one",
					editingStartFrame: 30,
					editingEndFrame: 60,
					timelineStartFrame: 0,
					durationFrames: 30,
					framing: {
						mode: "CROP",
						rect: { x: 0.65, y: 0, w: 0.31640625, h: 1 },
					},
					audio: { mode: "SOURCE" },
				},
				{
					clipId: "two",
					editingStartFrame: 0,
					editingEndFrame: 30,
					timelineStartFrame: 30,
					durationFrames: 30,
					framing: {
						mode: "CROP",
						rect: { x: 0.05, y: 0, w: 0.31640625, h: 1 },
					},
					audio: { mode: "MUTE" },
				},
			],
		};
		const sample = async (path: string, frame: number, label: string) => {
			const out = join(dir, `${label}-${frame}.rgb`);
			await runMediaProcess("ffmpeg", [
				"-v",
				"error",
				"-nostdin",
				"-i",
				path,
				"-vf",
				`select=eq(n\\,${frame}),scale=1:1`,
				"-frames:v",
				"1",
				"-pix_fmt",
				"rgb24",
				"-f",
				"rawvideo",
				out,
			]);
			const bytes = await readFile(out);
			assert.equal(bytes.length, 3);
			return [
				bytes.readUInt8(0),
				bytes.readUInt8(1),
				bytes.readUInt8(2),
			] as const;
		};
		const colors: Array<Array<readonly [number, number, number]>> = [];
		for (const mode of ["PREVIEW", "EXPORT"] as const) {
			const out = join(dir, `${mode}.mp4`);
			const result = await renderEditingRecipe({
				sourcePath,
				destinationPath: out,
				recipe,
				sourceFacts: facts,
				mode,
			});
			assert.equal(result.frameCount, 60);
			assert.equal(result.durationUs, 2000000);
			assert.equal(result.width, mode === "PREVIEW" ? 360 : 1080);
			assert.equal(result.height, mode === "PREVIEW" ? 640 : 1920);
			const sampled = await Promise.all(
				[0, 29, 30, 59].map((n) => sample(out, n, mode)),
			);
			for (const [red, green, blue] of sampled.slice(0, 2))
				assert.ok(
					red > 180 && green > 180 && blue < 60,
					`yellow framing missing: ${[red, green, blue]}`,
				);
			for (const [red, green, blue] of sampled.slice(2))
				assert.ok(
					red > 180 && green < 60 && blue < 60,
					`red framing missing: ${[red, green, blue]}`,
				);
			colors.push(sampled);
			const pcmPath = join(dir, `${mode}.pcm`);
			await runMediaProcess("ffmpeg", [
				"-v",
				"error",
				"-nostdin",
				"-i",
				out,
				"-vn",
				"-c:a",
				"pcm_s16le",
				"-ar",
				"48000",
				"-ac",
				"2",
				"-f",
				"s16le",
				pcmPath,
			]);
			const pcm = await readFile(pcmPath);
			const rms = (fromSecond: number, toSecond: number) => {
				let sum = 0;
				let count = 0;
				for (
					let index = Math.floor(fromSecond * 48000) * 4;
					index < Math.min(pcm.length, Math.floor(toSecond * 48000) * 4);
					index += 2
				) {
					const value = pcm.readInt16LE(index) / 32768;
					sum += value * value;
					count++;
				}
				return Math.sqrt(sum / count);
			};
			assert.ok(rms(0.3, 0.7) > 0.01, "source audio is missing");
			assert.ok(rms(1.3, 1.7) < 0.001, "muted segment has audible samples");
			assert.ok(
				Math.abs(pcm.length / 4 / 48000 - 2) <= 1 / 30,
				"audio differs from video by more than one frame",
			);
		}
		const [preview, exported] = colors;
		assert.ok(preview && exported);
		for (const [frame, pixel] of preview.entries()) {
			const reference = exported[frame];
			assert.ok(reference);
			for (const [channel, value] of pixel.entries()) {
				const other = reference[channel];
				assert.ok(other !== undefined && Math.abs(value - other) < 5);
			}
		}
		await t.test(
			"timeout removes scratch and never publishes a partial artifact",
			async () => {
				await assert.rejects(
					renderEditingRecipe({
						sourcePath,
						destinationPath: join(dir, "canceled.mp4"),
						recipe,
						sourceFacts: facts,
						mode: "EXPORT",
						timeoutMs: 1,
					}),
					(error: unknown) =>
						!!error &&
						typeof error === "object" &&
						"code" in error &&
						error.code === "TIMED_OUT",
				);
				assert.ok(
					!(await readdir(dir)).some(
						(name) =>
							name.startsWith(".bitovp-render-") || name === "canceled.mp4",
					),
				);
			},
		);
		await t.test(
			"an existing destination survives a failed publication",
			async () => {
				const out = join(dir, "existing.mp4");
				await writeFile(out, "original");
				await assert.rejects(
					renderEditingRecipe({
						sourcePath,
						destinationPath: out,
						recipe,
						sourceFacts: facts,
						mode: "PREVIEW",
					}),
				);
				assert.equal(await readFile(out, "utf8"), "original");
				assert.ok(
					!(await readdir(dir)).some((name) =>
						name.startsWith(".bitovp-render-"),
					),
				);
			},
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("native FFprobe refuses a truncated faststart MP4 instead of shortening its fixed timeline", {
	timeout: 60000,
}, async () => {
	const dir = await mkdtemp(join(tmpdir(), "bitovp-edit-truncated-"));
	try {
		const full = join(dir, "full.mp4");
		await runMediaProcess("ffmpeg", [
			"-v",
			"error",
			"-nostdin",
			"-f",
			"lavfi",
			"-i",
			"testsrc2=size=320x180:rate=30:duration=6",
			"-c:v",
			"libx264",
			"-threads",
			"2",
			"-bf",
			"0",
			"-g",
			"30",
			"-pix_fmt",
			"yuv420p",
			"-color_primaries",
			"bt709",
			"-color_trc",
			"bt709",
			"-colorspace",
			"bt709",
			"-x264-params",
			"colorprim=bt709:transfer=bt709:colormatrix=bt709",
			"-movflags",
			"+faststart",
			full,
		]);
		assert.equal(
			(await probeEditingMedia({ sourcePath: full })).frameCount,
			180,
		);
		const packets = await runMediaProcess("ffprobe", [
			"-v",
			"error",
			"-select_streams",
			"v:0",
			"-show_packets",
			"-show_entries",
			"packet=pos,size",
			"-of",
			"json",
			full,
		]);
		const cutPacket = JSON.parse(packets.stdout).packets[90];
		const position =
			Number(cutPacket.pos) + Math.floor(Number(cutPacket.size) / 2);
		assert.ok(Number.isSafeInteger(position) && position > 0);
		const truncated = join(dir, "truncated.mp4");
		await writeFile(truncated, (await readFile(full)).subarray(0, position));
		const metadata = await runMediaProcess("ffprobe", [
			"-v",
			"error",
			"-show_streams",
			"-of",
			"json",
			truncated,
		]);
		const video = JSON.parse(metadata.stdout).streams.find(
			(stream: { codec_type: string }) => stream.codec_type === "video",
		);
		assert.equal(video.nb_frames, "180");
		assert.equal(video.duration, "6.000000");
		const decoded = await runMediaProcess("ffprobe", [
			"-v",
			"error",
			"-select_streams",
			"v:0",
			"-show_frames",
			"-show_entries",
			"frame=best_effort_timestamp_time",
			"-of",
			"csv=p=0",
			truncated,
		]);
		const decodedCount = decoded.stdout
			.split(/\r?\n/)
			.filter((row) => row.trim()).length;
		assert.ok(decodedCount > 0 && decodedCount < 180);
		assert.ok(
			decoded.stderr.length > 0,
			"truncation must reproduce a zero-exit decoder error",
		);
		await assert.rejects(probeEditingMedia({ sourcePath: truncated }), {
			code: "SOURCE_INCOMPLETE",
		});
		// A packet-boundary cut can produce no decoder stderr at all; declared count still binds it.
		const missingTail = join(dir, "missing-tail.mp4");
		await writeFile(
			missingTail,
			(await readFile(full)).subarray(0, Number(cutPacket.pos)),
		);
		await assert.rejects(probeEditingMedia({ sourcePath: missingTail }), {
			code: "SOURCE_INCOMPLETE",
		});
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("native short complete CFR sources and their preview/export retain 1, 29, 30, and 31 frames", {
	timeout: 60000,
}, async () => {
	const dir = await mkdtemp(join(tmpdir(), "bitovp-edit-short-"));
	try {
		for (const frames of [1, 29, 30, 31]) {
			const sourcePath = join(dir, `source-${frames}.mp4`);
			await runMediaProcess("ffmpeg", [
				"-v",
				"error",
				"-nostdin",
				"-f",
				"lavfi",
				"-i",
				"color=red:size=320x180:rate=30",
				"-frames:v",
				String(frames),
				"-c:v",
				"libx264",
				"-threads",
				"2",
				"-pix_fmt",
				"yuv420p",
				"-color_primaries",
				"bt709",
				"-color_trc",
				"bt709",
				"-colorspace",
				"bt709",
				"-x264-params",
				"colorprim=bt709:transfer=bt709:colormatrix=bt709",
				"-movflags",
				"+faststart",
				sourcePath,
			]);
			const facts = await probeEditingMedia({ sourcePath });
			assert.equal(facts.frameCount, frames);
			const recipe: RenderRecipe = {
				schemaVersion: 1,
				compilerVersion: "content-editing-v1",
				mediaVersionId: "media",
				timeMapId: "map",
				canvas: { width: 1920, height: 1080 },
				fps: { num: 30, den: 1 },
				durationFrames: frames,
				segments: [
					{
						clipId: "one",
						editingStartFrame: 0,
						editingEndFrame: frames,
						timelineStartFrame: 0,
						durationFrames: frames,
						framing: { mode: "FIT" },
						audio: { mode: "SOURCE" },
					},
				],
			};
			for (const mode of ["PREVIEW", "EXPORT"] as const) {
				const output = await renderEditingRecipe({
					sourcePath,
					destinationPath: join(dir, `${mode}-${frames}.mp4`),
					sourceFacts: facts,
					recipe,
					mode,
				});
				assert.equal(output.frameCount, frames);
				assert.equal(output.durationUs, Math.ceil((frames * 1_000_000) / 30));
			}
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
