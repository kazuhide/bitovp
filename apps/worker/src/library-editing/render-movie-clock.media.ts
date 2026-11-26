/** Native gate: pnpm test:editing-media; requires real FFmpeg/FFprobe. */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	compileComposition,
	compositionDocumentSchema,
	type RenderRecipe,
} from "@bitovp/core";
import { renderCompositionRecipe } from "./composition-render";
import { probeEditingMedia } from "./media";
import { runMediaProcess } from "./process";
import { renderEditingRecipe } from "./render";

type Mp4Box = { type: string; payload: number; end: number };
function videoMovieClock(bytes: Buffer) {
	function children(parent: Mp4Box): Mp4Box[] {
		const result: Mp4Box[] = [];
		for (let offset = parent.payload; offset < parent.end; ) {
			assert.ok(offset + 8 <= parent.end);
			let size = bytes.readUInt32BE(offset),
				header = 8;
			const type = bytes.toString("ascii", offset + 4, offset + 8);
			if (size === 1) {
				assert.ok(offset + 16 <= parent.end);
				size = Number(bytes.readBigUInt64BE(offset + 8));
				header = 16;
			} else if (size === 0) size = parent.end - offset;
			assert.ok(
				Number.isSafeInteger(size) &&
					size >= header &&
					offset + size <= parent.end,
			);
			result.push({ type, payload: offset + header, end: offset + size });
			offset += size;
		}
		return result;
	}
	function child(parent: Mp4Box, type: string) {
		const matches = children(parent).filter((box) => box.type === type);
		assert.equal(matches.length, 1, `Expected one ${type} box`);
		const box = matches[0];
		assert.ok(box);
		return box;
	}
	const movie = child({ type: "root", payload: 0, end: bytes.length }, "moov");
	const header = child(movie, "mvhd");
	const version = bytes[header.payload];
	assert.ok(version === 0 || version === 1);
	const timescale = BigInt(
		bytes.readUInt32BE(header.payload + (version === 1 ? 20 : 12)),
	);
	assert.ok(timescale > 0n);
	const video = children(movie)
		.filter((box) => box.type === "trak")
		.find((track) => {
			const handler = child(child(track, "mdia"), "hdlr");
			return (
				bytes.toString("ascii", handler.payload + 8, handler.payload + 12) ===
				"vide"
			);
		});
	assert.ok(video);
	const edits = children(video).find((box) => box.type === "edts");
	if (!edits) {
		const track = child(video, "tkhd");
		return {
			timescale,
			duration:
				bytes[track.payload] === 1
					? bytes.readBigUInt64BE(track.payload + 28)
					: BigInt(bytes.readUInt32BE(track.payload + 20)),
		};
	}
	const list = child(edits, "elst"),
		listVersion = bytes[list.payload];
	assert.ok(listVersion === 0 || listVersion === 1);
	const count = bytes.readUInt32BE(list.payload + 4),
		stride = listVersion === 1 ? 20 : 12;
	assert.ok(count > 0 && list.payload + 8 + count * stride <= list.end);
	let duration = 0n;
	for (let index = 0; index < count; index++) {
		const offset = list.payload + 8 + index * stride;
		duration +=
			listVersion === 1
				? bytes.readBigUInt64BE(offset)
				: BigInt(bytes.readUInt32BE(offset));
	}
	return { timescale, duration };
}

test("native MP4 movie clock preserves complete 30 fps frames outside whole milliseconds", {
	timeout: 240000,
}, async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "bitovp-movie-clock-"));
	try {
		const sourcePath = join(directory, "source.mp4");
		await runMediaProcess("ffmpeg", [
			"-v",
			"error",
			"-nostdin",
			"-cpucount",
			"2",
			"-filter_threads",
			"1",
			"-filter_complex_threads",
			"1",
			"-n",
			"-f",
			"lavfi",
			"-threads",
			"1",
			"-i",
			"testsrc2=size=160x90:rate=30",
			"-f",
			"lavfi",
			"-threads",
			"1",
			"-i",
			"sine=frequency=440:sample_rate=48000:duration=30",
			"-frames:v",
			"900",
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
			"-video_track_timescale",
			"30000",
			"-movflags",
			"+faststart",
			sourcePath,
		]);
		const sourceFacts = await probeEditingMedia({ sourcePath });
		assert.equal(sourceFacts.frameCount, 900);
		assert.equal(sourceFacts.hasAudio, true);
		const mediaVersionId = "10000000-0000-4000-8000-000000000001";
		const timeMap = {
			id: mediaVersionId,
			mediaVersionId,
			kind: "CFR" as const,
			sourceStartUs: 0,
			sourceEndUs: 30000000,
			editingStartFrame: 0,
			editingEndFrame: 900,
			fps: { num: 30 as const, den: 1 as const },
		};
		for (const frames of [1, 29, 31, 896, 900]) {
			// The failed BBB export slices SOURCE AAC at these contiguous boundaries.
			// Preserve its first AAC sample phase (12657 source frames modulo 16 = 1).
			const durations =
				frames === 896
					? [73, 63, 32, 54, 45, 88, 73, 133, 47, 32, 48, 208]
					: [frames];
			let cursor = 0;
			const sourceOffset = frames === 896 ? 1 : 0;
			const segments: RenderRecipe["segments"] = durations.map(
				(durationFrames, index) => {
					const from = cursor;
					cursor += durationFrames;
					return {
						clipId: `10000000-0000-4000-8000-${String(index + 10).padStart(12, "0")}`,
						editingStartFrame: from + sourceOffset,
						editingEndFrame: cursor + sourceOffset,
						timelineStartFrame: from,
						durationFrames,
						framing: { mode: "FIT" },
						audio: { mode: "SOURCE" },
					};
				},
			);
			assert.equal(cursor, frames);
			const recipe: RenderRecipe = {
				schemaVersion: 1,
				compilerVersion: "content-editing-v1",
				mediaVersionId,
				timeMapId: mediaVersionId,
				canvas: { width: 1920, height: 1080 },
				fps: { num: 30, den: 1 },
				durationFrames: frames,
				segments,
			};
			const document = compositionDocumentSchema.parse({
				schemaVersion: 2,
				mediaVersionId,
				analysisRevisionId: "10000000-0000-4000-8000-000000000003",
				locale: "en",
				sourceTimeDomain: "ORIGINAL_PRESENTATION_US",
				timeMapId: mediaVersionId,
				canvas: recipe.canvas,
				fps: recipe.fps,
				clips: segments.map((segment) => ({
					id: segment.clipId,
					sourceInUs: Math.ceil((segment.editingStartFrame * 1000000) / 30),
					durationFrames: segment.durationFrames,
					timelineStartFrame: segment.timelineStartFrame,
					framing: [
						{
							fromFrame: 0,
							toFrame: segment.durationFrames,
							origin: "MANUAL",
							mode: "FIT",
						},
					],
					audio: { mode: "SOURCE" },
				})),
			});
			const plan = compileComposition(document, [
				{
					mediaVersionId,
					width: sourceFacts.width,
					height: sourceFacts.height,
					hasAudio: sourceFacts.hasAudio,
					timeMap,
				},
			]);
			for (const renderer of ["V1", "V2"] as const) {
				const modes =
					frames <= 31
						? (["PREVIEW", "EXPORT"] as const)
						: (["PREVIEW"] as const);
				for (const mode of modes) {
					await t.test(`${renderer} ${mode} ${frames} frames`, async () => {
						const destinationPath = join(
							directory,
							`${renderer}-${mode}-${frames}.mp4`,
						);
						const result =
							renderer === "V1"
								? await renderEditingRecipe({
										sourcePath,
										destinationPath,
										recipe,
										sourceFacts,
										mode,
									})
								: await renderCompositionRecipe({
										plan,
										sources: [{ mediaVersionId, sourcePath, sourceFacts }],
										destinationPath,
										mode,
									});
						assert.equal(result.frameCount, frames);
						assert.equal(result.durationUs, Math.ceil((frames * 1000000) / 30));
						const metadata = await runMediaProcess("ffprobe", [
							"-v",
							"error",
							"-threads",
							"1",
							"-i",
							destinationPath,
							"-show_streams",
							"-of",
							"json",
						]);
						assert.equal(metadata.stderr, "");
						const video = JSON.parse(metadata.stdout).streams.find(
							(stream: { codec_type: string }) => stream.codec_type === "video",
						);
						assert.equal(Number(video.nb_frames), frames);
						assert.equal(video.time_base, "1/30000");
						assert.equal(video.duration_ts, frames * 1000);
						assert.ok(
							Math.abs(Number(video.duration) - frames / 30) <= 0.000002,
						);
						const decoded = await runMediaProcess("ffprobe", [
							"-v",
							"error",
							"-threads",
							"1",
							"-i",
							destinationPath,
							"-select_streams",
							"v:0",
							"-show_frames",
							"-show_entries",
							"frame=best_effort_timestamp_time",
							"-of",
							"csv=p=0",
						]);
						assert.equal(decoded.stderr, "");
						const rows = decoded.stdout
							.split(/\r?\n/)
							.filter((row) => row.trim());
						assert.equal(rows.length, frames);
						for (const [frame, row] of rows.entries()) {
							assert.ok(
								Math.abs(Number(row.split(",")[0]) - frame / 30) <= 0.000002,
							);
						}
						// FFprobe can clamp an edit list rounded up to its exact sample span.
						// Check the container presentation fraction itself without prescribing a timescale.
						const clock = videoMovieClock(await readFile(destinationPath));
						assert.equal(
							clock.duration * 30n,
							BigInt(frames) * clock.timescale,
							"MP4 movie edit list must present exactly frames/30",
						);
					});
				}
			}
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
