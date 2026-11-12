import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
	resolveVodInputTimeline,
	type VodInputPreviewRequest,
	type VodInputTimelineSegment,
	type VodInputTimelineSource,
	type VodInputTimelineSourceFacts,
	validateVodInputTimeline,
} from "@bitovp/core/vod-input-timeline";
import {
	MediaOperationError,
	runMediaProcess,
} from "../library-editing/process";
import {
	VOD_INPUT_PREVIEW_MAX_OUTPUT_BYTES,
	type VodInputMediaDependencies,
	vodInputPreviewCanvas,
	vodInputPreviewReadArgs,
} from "./media-profile";
import { createVodRangeBridge } from "./range-bridge";

const record = (value: unknown): Record<string, unknown> =>
	value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};

/** V1 and A1 keep independent boundaries; only the final mux combines them. */
export async function renderVodInputPreview(
	input: VodInputMediaDependencies & {
		request: Extract<VodInputPreviewRequest, { kind: "PREVIEW" }>;
		sources: readonly VodInputTimelineSource[];
		facts: readonly VodInputTimelineSourceFacts[];
		directory: string;
	},
): Promise<{
	path: string;
	size: number;
	sha256: string;
	durationMs: number;
	bytesRead: number;
}> {
	if (!isAbsolute(input.directory) || input.directory.includes("\0"))
		throw new MediaOperationError("INVALID_LOCAL_PATH");
	const issues = validateVodInputTimeline(input.request.document, input.facts);
	if (issues[0]) throw new MediaOperationError(issues[0].code);
	const program = resolveVodInputTimeline(
		input.request.document,
		input.request.range,
	);
	if (!program.durationMs)
		throw new MediaOperationError("SOURCE_RANGE_INVALID");
	const byKey = new Map(input.facts.map((fact) => [fact.key, fact]));
	const sourceFacts = (key: string) => {
		const fact = byKey.get(key);
		if (!fact) throw new MediaOperationError("SOURCE_NOT_READY");
		return fact;
	};
	const main = program.mainVideoSourceKey
		? sourceFacts(program.mainVideoSourceKey).video
		: null;
	const videoSegments: VodInputTimelineSegment[] = program.videoSegments.length
		? program.videoSegments
		: [{ kind: "gap", startMs: 0, durationMs: program.durationMs }];
	for (const segment of videoSegments) {
		if (
			segment.kind === "source" &&
			!sourceFacts(segment.sourceKey).video?.displayAspectRatio
		)
			throw new MediaOperationError("PROBE_UNAVAILABLE");
	}
	if (main && !main.displayAspectRatio)
		throw new MediaOperationError("PROBE_UNAVAILABLE");
	const canvas = main
		? vodInputPreviewCanvas(main.width, main.height, main.displayAspectRatio)
		: { width: 640, height: 360 };
	const audioSegments: VodInputTimelineSegment[] = !program.hasAudio
		? []
		: program.audioSegments.length
			? program.audioSegments
			: [{ kind: "gap", startMs: 0, durationMs: program.durationMs }];
	const used = new Set(
		[...videoSegments, ...audioSegments].flatMap((segment) =>
			segment.kind === "source" ? [segment.sourceKey] : [],
		),
	);
	const sources = input.sources.filter((source) => used.has(source.key));
	if (sources.length !== used.size)
		throw new MediaOperationError("SOURCE_NOT_READY");
	const bridge = await createVodRangeBridge({
		sources: sources.map((source) => ({
			source,
			identity: sourceFacts(source.key).identity,
		})),
		browserFor: input.browserFor,
		signal: input.signal,
	});
	const execute = input.execute ?? runMediaProcess;
	const deadline = Date.now() + (input.timeoutMs ?? 180_000);
	const options = () => ({
		signal: input.signal,
		timeoutMs: Math.max(1, deadline - Date.now()),
		maxOutputBytes: 1024 ** 2,
	});
	const common = [
		"-v",
		"error",
		"-nostdin",
		"-cpucount",
		"1",
		"-max_alloc",
		"134217728",
		"-filter_threads",
		"1",
		"-filter_complex_threads",
		"1",
		"-n",
	];
	const temporary = new Set<string>();
	const path = join(input.directory, "preview.mp4");
	let partBytes = 0,
		completed = false;
	const part = async (
		media: "video" | "audio",
		segment: VodInputTimelineSegment,
		index: number,
	) => {
		input.signal.throwIfAborted();
		const seconds = String(segment.durationMs / 1000);
		const name = `${media}-part-${index}.${media === "video" ? "mkv" : "wav"}`;
		const output = join(input.directory, name);
		temporary.add(output);
		let read: string[], selected: string;
		if (segment.kind === "source") {
			const fact = sourceFacts(segment.sourceKey);
			const stream = media === "video" ? fact.video : fact.audio;
			if (!stream)
				throw new MediaOperationError(
					media === "video" ? "SOURCE_VIDEO_MISSING" : "SOURCE_AUDIO_MISSING",
				);
			read = [
				"-ss",
				String(segment.inMs / 1000),
				...vodInputPreviewReadArgs(bridge.urlFor(segment.sourceKey)),
			];
			selected = `0:${stream.streamIndex}`;
		} else {
			read = [
				"-f",
				"lavfi",
				"-i",
				media === "video"
					? `color=c=black:s=${canvas.width}x${canvas.height}:r=30:d=${seconds}`
					: "anullsrc=channel_layout=stereo:sample_rate=48000",
			];
			selected = media === "video" ? "0:v:0" : "0:a:0";
		}
		await execute(
			input.ffmpegPath ?? "ffmpeg",
			[
				...common,
				...read,
				"-t",
				seconds,
				"-map",
				selected,
				"-map_metadata",
				"-1",
				"-map_chapters",
				"-1",
				"-sn",
				"-dn",
				...(media === "video"
					? [
							"-an",
							"-vf",
							`scale=${canvas.width}:${canvas.height}:force_original_aspect_ratio=decrease:force_divisible_by=2:reset_sar=1,pad=${canvas.width}:${canvas.height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30`,
							"-c:v",
							"libx264",
							"-preset",
							"ultrafast",
							"-crf",
							"32",
							"-maxrate",
							"1200k",
							"-bufsize",
							"2400k",
							"-threads",
							"1",
							"-pix_fmt",
							"yuv420p",
							"-f",
							"matroska",
						]
					: [
							"-vn",
							"-af",
							`aresample=48000:async=1:first_pts=0,apad=whole_dur=${seconds},atrim=duration=${seconds},asetpts=N/SR/TB`,
							"-c:a",
							"pcm_s16le",
							"-ar",
							"48000",
							"-ac",
							"2",
							"-threads",
							"1",
							"-f",
							"wav",
						]),
				"-fs",
				String(VOD_INPUT_PREVIEW_MAX_OUTPUT_BYTES),
				output,
			],
			options(),
		);
		bridge.throwIfFailed();
		const size = (await stat(output)).size;
		partBytes += size;
		if (
			size < 1 ||
			size >= VOD_INPUT_PREVIEW_MAX_OUTPUT_BYTES ||
			partBytes > 128 * 1024 ** 2
		)
			throw new MediaOperationError("OUTPUT_LIMIT");
		return name;
	};
	const track = async (
		media: "video" | "audio",
		segments: VodInputTimelineSegment[],
	) => {
		const parts: string[] = [];
		for (const [index, segment] of segments.entries())
			parts.push(await part(media, segment, index));
		const list = join(input.directory, `${media}-parts.txt`);
		temporary.add(list);
		await writeFile(list, parts.map((name) => `file '${name}'\n`).join(""), {
			flag: "wx",
			mode: 0o600,
		});
		return [
			"-protocol_whitelist",
			"file,pipe",
			"-f",
			"concat",
			"-safe",
			"1",
			"-i",
			list,
		];
	};
	try {
		const video = await track("video", videoSegments);
		const audio = program.hasAudio ? await track("audio", audioSegments) : [];
		await execute(
			input.ffmpegPath ?? "ffmpeg",
			[
				...common,
				...video,
				...audio,
				"-map",
				"0:v:0",
				...(program.hasAudio ? ["-map", "1:a:0"] : ["-an"]),
				"-map_metadata",
				"-1",
				"-map_chapters",
				"-1",
				"-c:v",
				"copy",
				...(program.hasAudio
					? ["-c:a", "aac", "-b:a", "64k", "-ar", "48000", "-ac", "2"]
					: []),
				"-threads",
				"1",
				"-t",
				String(program.durationMs / 1000),
				"-movflags",
				"+faststart",
				"-fs",
				String(VOD_INPUT_PREVIEW_MAX_OUTPUT_BYTES),
				path,
			],
			options(),
		);
		const metadata = await execute(
			input.ffprobePath ?? "ffprobe",
			[
				"-v",
				"error",
				"-protocol_whitelist",
				"file,pipe",
				"-format_whitelist",
				"mov",
				"-i",
				path,
				"-show_streams",
				"-show_format",
				"-of",
				"json",
			],
			options(),
		);
		const outputProbe = record(JSON.parse(metadata.stdout));
		const durationMs = Number(record(outputProbe.format).duration) * 1000;
		const streams = Array.isArray(outputProbe.streams)
			? outputProbe.streams.map(record)
			: [];
		if (
			!Number.isFinite(durationMs) ||
			Math.abs(durationMs - program.durationMs) >
				100 + videoSegments.length * (1000 / 30) ||
			streams.filter((stream) => stream.codec_type === "video").length !== 1 ||
			streams.some(
				(stream) =>
					stream.codec_type === "video" &&
					(stream.codec_name !== "h264" ||
						Number(stream.width) !== canvas.width ||
						Number(stream.height) !== canvas.height),
			) ||
			streams.filter((stream) => stream.codec_type === "audio").length !==
				(program.hasAudio ? 1 : 0) ||
			streams.some(
				(stream) =>
					stream.codec_type === "audio" &&
					(stream.codec_name !== "aac" ||
						Number(stream.sample_rate) !== 48000 ||
						Number(stream.channels) !== 2),
			)
		)
			throw new MediaOperationError("OUTPUT_INVALID");
		const size = (await stat(path)).size;
		if (size < 1 || size >= VOD_INPUT_PREVIEW_MAX_OUTPUT_BYTES)
			throw new MediaOperationError("OUTPUT_LIMIT");
		await chmod(path, 0o600);
		const hash = createHash("sha256");
		for await (const bytes of createReadStream(path, { signal: input.signal }))
			hash.update(bytes);
		completed = true;
		return {
			path,
			size,
			sha256: hash.digest("hex"),
			durationMs: program.durationMs,
			bytesRead: bridge.bytesRead,
		};
	} catch (error) {
		bridge.throwIfFailed();
		throw error;
	} finally {
		await bridge.close();
		if (!completed) temporary.add(path);
		await Promise.all([...temporary].map((file) => rm(file, { force: true })));
	}
}
