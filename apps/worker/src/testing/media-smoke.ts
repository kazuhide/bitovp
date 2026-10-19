import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { buildVmafCommand, parseVmafJson } from "@bitovp/core";

type Execute = (binary: string, args: string[]) => Promise<string>;
const exec = promisify(execFile);
const execute: Execute = async (binary, args) =>
	(
		await exec(binary, args, {
			encoding: "utf8",
			timeout: 60_000,
			killSignal: "SIGKILL",
			maxBuffer: 4 * 1024 * 1024,
			env: { PATH: "/usr/local/bin:/usr/bin:/bin", TMPDIR: "/work/tmp" },
		})
	).stdout;
const ffmpeg = (args: string[], run = execute) =>
	run("/usr/local/bin/ffmpeg", ["-v", "error", "-nostdin", "-y", ...args]);
const object = (value: unknown): Record<string, unknown> => {
	assert(value !== null && typeof value === "object" && !Array.isArray(value));
	return value as Record<string, unknown>;
};

export function validateVideoSegments(probes: unknown[]) {
	assert.equal(probes.length, 5, "Five video segments are required");
	let first = 0;
	for (const [segment, probe] of probes.entries()) {
		const frames = object(probe).frames;
		assert(
			Array.isArray(frames) && frames.length === 48,
			"Video segment is incomplete",
		);
		for (const [frame, value] of frames.entries()) {
			const pts = Number(object(value).best_effort_timestamp_time);
			assert(Number.isFinite(pts), "Video timestamp is missing");
			if (segment === 0 && frame === 0) first = pts;
			assert(
				Math.abs(pts - (first + segment * 2 + frame / 24)) < 0.0001,
				"Video segments must contain consecutive 24 fps frames",
			);
		}
	}
}

export function validateAvProbe(probe: unknown) {
	const streams = object(probe).streams;
	assert(
		Array.isArray(streams) && streams.length === 2,
		"Video and audio are required",
	);
	const video = object(
		streams.find((stream) => object(stream).codec_type === "video"),
	);
	const audio = object(
		streams.find((stream) => object(stream).codec_type === "audio"),
	);
	assert.equal(video.codec_name, "h264");
	assert.equal(video.width, 320);
	assert.equal(video.height, 180);
	assert.equal(video.r_frame_rate, "24/1");
	assert.equal(
		Number(video.nb_read_frames),
		240,
		"All video frames must decode",
	);
	assert.equal(audio.codec_name, "aac");
	assert.equal(audio.sample_rate, "48000");
	assert.equal(audio.channels, 2);
	// AAC padding/priming need not match the video's exact frame boundaries.
	const audioFrames = Number(audio.nb_read_frames);
	assert(
		audioFrames >= 468 && audioFrames <= 472,
		"Audio decode is incomplete",
	);
	const decoded = object(probe).frames;
	assert(
		Array.isArray(decoded),
		"Decoded presentation timestamps are required",
	);
	const videos = decoded.filter(
		(frame) => object(frame).media_type === "video",
	);
	const audios = decoded.filter(
		(frame) => object(frame).media_type === "audio",
	);
	assert.equal(videos.length, 240, "All video timestamps are required");
	assert.equal(audios.length, audioFrames, "All audio timestamps are required");
	const timestamp = (frame: unknown) => {
		const raw = object(frame).best_effort_timestamp_time;
		assert(
			typeof raw === "string" && raw.trim(),
			"Decoded timestamps are required",
		);
		const value = Number(raw);
		assert(Number.isFinite(value), "Decoded timestamps must be finite");
		return value;
	};
	const samples = (frame: unknown) => {
		const value = Number(object(frame).nb_samples);
		assert(
			Number.isInteger(value) && value > 0 && value <= 1024,
			"Invalid decoded AAC sample count",
		);
		return value;
	};
	// HLS may quantize timestamps to milliseconds; one missing AAC frame is 21.33 ms.
	const rounding = 0.0011;
	for (let index = 1; index < audios.length; index++)
		assert(
			Math.abs(
				timestamp(audios[index]) -
					timestamp(audios[index - 1]) -
					samples(audios[index - 1]) / 48000,
			) <= rounding,
			"Decoded audio timestamps must be continuous",
		);
	// Allow two H.264 reorder frames and AAC priming/padding at the container edges.
	const edge = 2 / 24 + (2 * 1024) / 48000 + rounding;
	assert(
		Math.abs(timestamp(audios[0]) - timestamp(videos[0])) <= edge &&
			Math.abs(
				timestamp(audios.at(-1)) +
					samples(audios.at(-1)) / 48000 -
					timestamp(videos.at(-1)) -
					1 / 24,
			) <= edge,
		"Decoded audio must span the video presentation within priming and padding bounds",
	);
}

function fullFrameMean(raw: unknown) {
	const frames = object(raw).frames;
	assert(
		Array.isArray(frames) && frames.length === 240,
		"All VMAF frames are required",
	);
	for (const [index, frame] of frames.entries())
		assert.equal(
			object(frame).frameNum,
			index,
			"VMAF frame indices must be ordered",
		);
	const parsed = parseVmafJson(raw);
	assert.equal(parsed.frames.length, 240, "VMAF scores must not be missing");
	assert(
		parsed.frames.every(
			(frame) =>
				Number.isFinite(frame.vmaf) && frame.vmaf >= 0 && frame.vmaf <= 100,
		),
	);
	assert(parsed.pooled);
	assert(
		Object.values(parsed.pooled).every(
			(value) => Number.isFinite(value) && value >= 0 && value <= 100,
		),
		"Pooled VMAF values must be finite and in range",
	);
	assert(
		parsed.pooled.min <= parsed.pooled.mean &&
			parsed.pooled.mean <= parsed.pooled.max,
	);
	return parsed.pooled.mean;
}

export function validateVmafReports(
	self: unknown,
	encoded: unknown,
	degraded: unknown,
) {
	const means = {
		self: fullFrameMean(self),
		encoded: fullFrameMean(encoded),
		degraded: fullFrameMean(degraded),
	};
	assert(
		means.self >= 90,
		"Self-comparison must remain near the top of the scale",
	);
	assert(
		means.self >= means.encoded,
		"Self-comparison must exceed the encoded result",
	);
	assert(
		means.encoded > means.degraded + 5,
		"The degraded control must score substantially worse",
	);
	return means;
}

export async function decodePresentation(path: string, run = execute) {
	await ffmpeg(
		[
			"-xerror",
			"-err_detect",
			"explode",
			"-threads",
			"1",
			"-i",
			resolve(path),
			"-map",
			"0:v:0",
			"-map",
			"0:a:0",
			"-f",
			"null",
			"-",
		],
		run,
	);
}

async function probe(args: string[]) {
	return JSON.parse(
		await execute("/usr/local/bin/ffprobe", [
			"-v",
			"error",
			"-threads",
			"1",
			...args,
			"-of",
			"json",
		]),
	) as unknown;
}

export async function runMediaCheck() {
	process.chdir("/work");
	for (const path of ["tmp", "hls", "dash"]) await mkdir(path);
	const version = await execute("/usr/local/bin/ffmpeg", ["-version"]);
	assert(
		/^ffmpeg version n?8\.1\.3(?:[-\s]|$)/.test(version),
		"Worker FFmpeg 8.1.3 is required",
	);
	const input = [
		"-ss",
		"30",
		"-threads",
		"1",
		"-i",
		"/input/source.mp4",
		"-t",
		"10",
	];
	await ffmpeg([
		...input,
		"-map",
		"0:v:0",
		"-an",
		"-vf",
		"scale=320:180,fps=24,format=yuv420p",
		"-c:v",
		"ffv1",
		"-threads",
		"1",
		"reference.mkv",
	]);
	await ffmpeg([
		...input,
		"-map",
		"0:v:0",
		"-map",
		"0:a:0",
		"-vf",
		"scale=320:180",
		"-c:v",
		"libx264",
		"-threads",
		"1",
		"-crf",
		"23",
		"-r",
		"24",
		"-g",
		"48",
		"-keyint_min",
		"48",
		"-sc_threshold",
		"0",
		"-force_key_frames",
		"expr:gte(t,n_forced*2)",
		"-c:a",
		"aac",
		"-b:a",
		"128k",
		"-ar",
		"48000",
		"-ac",
		"2",
		"-movflags",
		"+faststart",
		"bbb-10s.mp4",
	]);
	await ffmpeg([
		"-threads",
		"1",
		"-i",
		"reference.mkv",
		"-an",
		"-vf",
		"scale=80:46:flags=bilinear,scale=320:180:flags=bilinear",
		"-c:v",
		"libx264",
		"-threads",
		"1",
		"-crf",
		"45",
		"degraded.mp4",
	]);
	await ffmpeg([
		"-i",
		"bbb-10s.mp4",
		"-map",
		"0",
		"-c",
		"copy",
		"-f",
		"hls",
		"-hls_time",
		"2",
		"-hls_playlist_type",
		"vod",
		"-hls_segment_type",
		"fmp4",
		"-hls_flags",
		"independent_segments",
		"-hls_fmp4_init_filename",
		"init.mp4",
		"-hls_segment_filename",
		"hls/segment-%03d.m4s",
		"hls/index.m3u8",
	]);
	await ffmpeg([
		"-i",
		"bbb-10s.mp4",
		"-map",
		"0",
		"-c",
		"copy",
		"-f",
		"dash",
		"-avoid_negative_ts",
		"make_non_negative",
		"-seg_duration",
		"2",
		"-use_template",
		"1",
		"-use_timeline",
		"1",
		"-format_options",
		"use_editlist=0",
		"-init_seg_name",
		"init-$RepresentationID$.m4s",
		"-media_seg_name",
		"segment-$RepresentationID$-$Number%05d$.m4s",
		"-adaptation_sets",
		"id=0,streams=v id=1,streams=a",
		"dash/manifest.mpd",
	]);
	for (const [directory, init, pattern] of [
		["hls", "init.mp4", /^segment-\d{3}\.m4s$/],
		["dash", "init-0.m4s", /^segment-0-\d{5}\.m4s$/],
	] as const) {
		const names = (await readdir(directory))
			.filter((name) => pattern.test(name))
			.sort();
		const probes: unknown[] = [];
		for (const name of names)
			probes.push(
				await probe([
					"-select_streams",
					"v:0",
					"-show_frames",
					"-show_entries",
					"frame=best_effort_timestamp_time",
					"-i",
					`concat:/work/${directory}/${init}|/work/${directory}/${name}`,
				]),
			);
		validateVideoSegments(probes);
	}
	for (const path of ["bbb-10s.mp4", "hls/index.m3u8", "dash/manifest.mpd"]) {
		await decodePresentation(path);
		validateAvProbe(
			await probe([
				"-count_frames",
				"-show_streams",
				"-show_frames",
				"-show_entries",
				"stream=codec_type,codec_name,width,height,r_frame_rate,nb_read_frames,sample_rate,channels:frame=media_type,best_effort_timestamp_time,nb_samples",
				"-i",
				resolve(path),
			]),
		);
	}
	const logs: unknown[] = [];
	for (const [name, distortedPath] of [
		["self", "reference.mkv"],
		["encoded", "bbb-10s.mp4"],
		["degraded", "degraded.mp4"],
	] as const) {
		await execute(
			"/usr/local/bin/ffmpeg",
			buildVmafCommand({
				measurementMethod: "FRAME_INDEX_BT709_10BIT",
				referenceFrameRate: "24/1",
				distortedOriginal: { width: 320, height: 180, bitdepth: 8 },
				referencePath: "reference.mkv",
				distortedPath,
				model: "vmaf_v0.6.1",
				modelPath: "/opt/vmaf/model/vmaf_v0.6.1.json",
				logPath: `${name}.json`,
				scaleToReference: { width: 320, height: 180 },
				threads: 1,
				subsample: 1,
			}),
		);
		logs.push(JSON.parse(await readFile(`${name}.json`, "utf8")));
	}
	const means = validateVmafReports(logs[0], logs[1], logs[2]);
	return {
		version: 1,
		videoFrames: 240,
		hlsSegments: 5,
		dashSegments: 5,
		decodedPresentations: 3,
		vmafFrames: 240,
		means,
	};
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
	runMediaCheck()
		.then((summary) => console.log(JSON.stringify(summary)))
		.catch(() => {
			console.error("Offline media validation failed");
			process.exitCode = 1;
		});
