import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
	getVodInputTimelineDurationMs,
	sliceVodInputTimeline,
	type VodInputPreviewRequest,
	type VodInputTimelineSource,
	type VodInputTimelineSourceFacts,
	validateVodInputTimeline,
	vodInputTimelineSourceFactsSchema,
} from "@bitovp/core/vod-input-timeline";
import type { ObjectIdentity } from "@bitovp/storage";
import {
	MediaOperationError,
	runMediaProcess,
} from "../library-editing/process";
import {
	abortableVodOperation,
	assertVodSourceIdentity,
	createVodRangeBridge,
	type VodInputBrowserFactory,
} from "./range-bridge";

export const VOD_INPUT_PREVIEW_MAX_OUTPUT_BYTES = 64 * 1024 ** 2;
export const VOD_INPUT_PREVIEW_MAX_SOURCE_PIXELS = 4096 * 2160;
const record = (value: unknown): Record<string, unknown> =>
	value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
const invalid = (): never => {
	throw new MediaOperationError("SOURCE_UNSUPPORTED");
};

function displayAspectRatio(
	video: Record<string, unknown>,
	width: number,
	height: number,
) {
	const sar = /^(\d+):(\d+)$/.exec(
		String(
			video.sample_aspect_ratio === undefined
				? "1:1"
				: video.sample_aspect_ratio,
		),
	);
	if (!sar) return invalid();
	const sarNum = Number(sar[1]),
		sarDen = Number(sar[2]);
	if (
		![sarNum, sarDen].every(
			(value) =>
				Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647,
		)
	)
		return invalid();
	const angle = (value: unknown) => {
		if (
			(typeof value !== "number" && typeof value !== "string") ||
			!/^[+-]?\d+(?:\.\d+)?$/.test(String(value))
		)
			return invalid();
		const degrees = Number(value),
			snapped = Math.round(degrees / 90) * 90;
		if (!Number.isFinite(degrees) || Math.abs(degrees - snapped) > 0.001)
			return invalid();
		return ((snapped % 360) + 360) % 360;
	};
	const matrices = (
		Array.isArray(video.side_data_list) ? video.side_data_list.map(record) : []
	).filter((side) => side.side_data_type === "Display Matrix");
	const rotations = matrices.map((side) => {
		const rotation = angle(side.rotation);
		if (side.displaymatrix !== undefined) {
			const rows = String(side.displaymatrix)
				.trim()
				.split(/\r?\n/)
				.map((line) =>
					/^\s*[\da-f]{8}:\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s*$/i.exec(line),
				);
			if (rows.length !== 3 || rows.some((row) => !row)) return invalid();
			const values = rows.flatMap((row) =>
				row ? row.slice(1).map(Number) : [],
			);
			const [a = NaN, b = NaN, u, c = NaN, d = NaN, v, x, y, w] = values;
			// Only ordinary quarter-turn rotation matrices; no shear, mirroring, scaling or translation.
			if (
				![a, b, c, d].every((value) => [0, -65536, 65536].includes(value)) ||
				u !== 0 ||
				v !== 0 ||
				x !== 0 ||
				y !== 0 ||
				w !== 1073741824 ||
				a * d - b * c !== 4294967296 ||
				a * a + b * b !== 4294967296 ||
				c * c + d * d !== 4294967296 ||
				(a === 0) !== (rotation % 180 !== 0)
			)
				return invalid();
		}
		return rotation;
	});
	const rotation = rotations[0] ?? 0;
	if (rotations.some((value) => value !== rotation)) return invalid();
	const tag = record(video.tags).rotate;
	if (
		tag !== undefined &&
		(angle(tag) !== rotation || (!matrices.length && angle(tag) !== 0))
	)
		return invalid();
	let num = width * sarNum,
		den = height * sarDen;
	if (rotation === 90 || rotation === 270) [num, den] = [den, num];
	if (
		![num, den].every(Number.isSafeInteger) ||
		num / den > 320 ||
		num / den < 1 / 180
	)
		return invalid();
	const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
	const divisor = gcd(num, den);
	return { num: num / divisor, den: den / divisor };
}

/** Narrow returned facts, never return ffprobe's arbitrary tags, paths or diagnostics. */
export function inspectVodInputProbe(
	key: string,
	raw: unknown,
	identity: ObjectIdentity,
): VodInputTimelineSourceFacts {
	assertVodSourceIdentity(identity);
	const probe = record(raw);
	const streams = Array.isArray(probe.streams) ? probe.streams.map(record) : [];
	const video = streams.find((stream) => stream.codec_type === "video");
	if (!video || record(video.disposition).attached_pic === 1) return invalid();
	const width = Number(video.width),
		height = Number(video.height);
	const duration = Number(video.duration ?? record(probe.format).duration);
	if (
		![width, height].every(
			(value) => Number.isSafeInteger(value) && value > 0,
		) ||
		!Number.isFinite(duration) ||
		duration <= 0 ||
		width * height > VOD_INPUT_PREVIEW_MAX_SOURCE_PIXELS ||
		width > 8192 ||
		height > 8192 ||
		["encv", "enca"].includes(String(video.codec_tag_string))
	)
		return invalid();
	const audio = streams.find((stream) => stream.codec_type === "audio");
	if (audio && ["enca", "encv"].includes(String(audio.codec_tag_string)))
		return invalid();
	const ratio = /^(\d+)\/(\d+)$/.exec(String(video.avg_frame_rate));
	const frameRate =
		ratio && Number(ratio[1]) > 0 && Number(ratio[2]) > 0
			? { num: Number(ratio[1]), den: Number(ratio[2]) }
			: undefined;
	const parsed = vodInputTimelineSourceFactsSchema.safeParse({
		key,
		durationMs: Math.floor(duration * 1000),
		video: {
			streamIndex: Number(video.index),
			width,
			height,
			displayAspectRatio: displayAspectRatio(video, width, height),
			...(frameRate ? { frameRate } : {}),
		},
		audio: audio
			? {
					streamIndex: Number(audio.index),
					sampleRate: Number(audio.sample_rate),
					channels: Number(audio.channels),
				}
			: null,
		identity: {
			size: identity.size,
			...(identity.etag ? { etag: identity.etag } : {}),
			...(identity.versionId ? { versionId: identity.versionId } : {}),
			...(identity.generation ? { generation: identity.generation } : {}),
		},
	});
	return parsed.success ? parsed.data : invalid();
}

/** Demuxers admitting playlists/external manifests are deliberately absent.
 * MOV data references remain disabled by the demuxer's default enable_drefs=0. */
export function vodInputPreviewReadArgs(url: string): string[] {
	if (!/^http:\/\/127\.0\.0\.1:\d+\/[a-zA-Z0-9]+\/\d+$/.test(url))
		throw new MediaOperationError("INVALID_SOURCE");
	return [
		"-threads",
		"1",
		"-protocol_whitelist",
		"http,tcp",
		"-format_whitelist",
		"mov,matroska,webm,mpegts",
		"-rw_timeout",
		"15000000",
		"-probesize",
		"8388608",
		"-analyzeduration",
		"5000000",
		"-i",
		url,
	];
}

type MediaDeps = {
	browserFor: VodInputBrowserFactory;
	ffmpegPath?: string;
	ffprobePath?: string;
	signal: AbortSignal;
	timeoutMs?: number;
	execute?: typeof runMediaProcess;
};

export function vodInputPreviewCanvas(
	width: number,
	height: number,
	displayAspectRatio?: { num: number; den: number },
) {
	if (
		![width, height].every((value) => Number.isSafeInteger(value) && value > 0)
	)
		throw new MediaOperationError("SOURCE_UNSUPPORTED");
	const aspect = displayAspectRatio ?? { num: width, den: height };
	if (
		![aspect.num, aspect.den].every(
			(value) => Number.isSafeInteger(value) && value > 0,
		)
	)
		throw new MediaOperationError("SOURCE_UNSUPPORTED");
	const scale = Math.min(640 / aspect.num, 360 / aspect.den);
	return {
		width: Math.max(2, Math.floor((aspect.num * scale) / 2) * 2),
		height: Math.max(2, Math.floor((aspect.den * scale) / 2) * 2),
	};
}

export async function probeVodInputSources(
	input: MediaDeps & { sources: readonly VodInputTimelineSource[] },
): Promise<VodInputTimelineSourceFacts[]> {
	const facts: VodInputTimelineSourceFacts[] = [];
	const execute = input.execute ?? runMediaProcess;
	for (const source of input.sources) {
		input.signal.throwIfAborted();
		const browser = await abortableVodOperation(
			input.browserFor(source.credentialId),
			input.signal,
			(late) => late.dispose?.(),
		);
		let identity: ObjectIdentity;
		try {
			if (!browser.headObject)
				throw new MediaOperationError("SOURCE_UNSUPPORTED");
			identity = await abortableVodOperation(
				browser.headObject({ bucket: source.bucket, key: source.objectKey }),
				AbortSignal.any([input.signal, AbortSignal.timeout(15_000)]),
			);
			assertVodSourceIdentity(identity);
		} finally {
			browser.dispose?.();
		}
		const bridge = await createVodRangeBridge({
			sources: [{ source, identity }],
			browserFor: input.browserFor,
			signal: input.signal,
			maxBytes: 32 * 1024 ** 2,
		});
		try {
			const result = await execute(
				input.ffprobePath ?? "ffprobe",
				[
					"-v",
					"error",
					"-max_alloc",
					"67108864",
					...vodInputPreviewReadArgs(bridge.urlFor(source.key)),
					"-show_streams",
					"-show_format",
					"-of",
					"json",
				],
				{
					signal: input.signal,
					timeoutMs: input.timeoutMs ?? 30_000,
					maxOutputBytes: 1024 ** 2,
				},
			);
			bridge.throwIfFailed();
			facts.push(
				inspectVodInputProbe(source.key, JSON.parse(result.stdout), identity),
			);
		} catch (error) {
			bridge.throwIfFailed();
			throw error;
		} finally {
			await bridge.close();
		}
	}
	return facts;
}

export async function renderVodInputPreview(
	input: MediaDeps & {
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
	if (issues.length)
		throw new MediaOperationError(issues[0]?.code ?? "INVALID_TIMELINE");
	const document = sliceVodInputTimeline(
		input.request.document,
		input.request.range,
	);
	if (!document.clips.length)
		throw new MediaOperationError("SOURCE_RANGE_INVALID");
	const durationMs = getVodInputTimelineDurationMs(document);
	const byKey = new Map(input.facts.map((facts) => [facts.key, facts]));
	const sourceFacts = (key: string) => {
		const facts = byKey.get(key);
		if (!facts) throw new MediaOperationError("SOURCE_NOT_READY");
		return facts;
	};
	const firstClip = input.request.document.clips[0];
	if (!firstClip) throw new MediaOperationError("TIMELINE_EMPTY");
	const main = sourceFacts(firstClip.sourceKey);
	if (
		!main.video.displayAspectRatio ||
		document.clips.some(
			(clip) => !sourceFacts(clip.sourceKey).video.displayAspectRatio,
		)
	)
		throw new MediaOperationError("PROBE_UNAVAILABLE");
	const canvas = vodInputPreviewCanvas(
		main.video.width,
		main.video.height,
		main.video.displayAspectRatio,
	);
	const usedKeys = new Set(document.clips.map((clip) => clip.sourceKey));
	const sources = input.sources.filter((source) => usedKeys.has(source.key));
	if (sources.length !== usedKeys.size)
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
	const parts: string[] = [];
	let listWritten = false;
	try {
		let partBytes = 0;
		for (const [index, clip] of document.clips.entries()) {
			input.signal.throwIfAborted();
			const facts = sourceFacts(clip.sourceKey);
			const audio = facts.audio;
			if (document.audioEnabled && !audio)
				throw new MediaOperationError("SOURCE_AUDIO_MISSING");
			const name = `part-${index}.mkv`,
				path = join(input.directory, name);
			const seconds = String((clip.outMs - clip.inMs) / 1000);
			await execute(
				input.ffmpegPath ?? "ffmpeg",
				[
					...common,
					"-ss",
					String(clip.inMs / 1000),
					...vodInputPreviewReadArgs(bridge.urlFor(clip.sourceKey)),
					"-t",
					seconds,
					"-map",
					`0:${facts.video.streamIndex}`,
					...(document.audioEnabled && audio
						? ["-map", `0:${audio.streamIndex}`]
						: ["-an"]),
					"-map_metadata",
					"-1",
					"-map_chapters",
					"-1",
					"-sn",
					"-dn",
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
					...(document.audioEnabled
						? [
								"-af",
								`aresample=48000:async=1:first_pts=0,atrim=duration=${seconds}`,
								"-c:a",
								"pcm_s16le",
								"-ar",
								"48000",
								"-ac",
								"2",
							]
						: []),
					"-fs",
					String(VOD_INPUT_PREVIEW_MAX_OUTPUT_BYTES),
					"-f",
					"matroska",
					path,
				],
				options(),
			);
			bridge.throwIfFailed();
			partBytes += (await stat(path)).size;
			if (partBytes > 128 * 1024 ** 2)
				throw new MediaOperationError("OUTPUT_LIMIT");
			parts.push(name);
		}
		const listPath = join(input.directory, "parts.txt");
		await writeFile(
			listPath,
			parts.map((part) => `file '${part}'\n`).join(""),
			{ flag: "wx", mode: 0o600 },
		);
		listWritten = true;
		const path = join(input.directory, "preview.mp4");
		await execute(
			input.ffmpegPath ?? "ffmpeg",
			[
				...common,
				"-protocol_whitelist",
				"file,pipe",
				"-f",
				"concat",
				"-safe",
				"1",
				"-i",
				listPath,
				"-map",
				"0:v:0",
				...(document.audioEnabled ? ["-map", "0:a:0"] : ["-an"]),
				"-map_metadata",
				"-1",
				"-map_chapters",
				"-1",
				"-c:v",
				"copy",
				...(document.audioEnabled
					? ["-c:a", "aac", "-b:a", "64k", "-ar", "48000", "-ac", "2"]
					: []),
				"-threads",
				"1",
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
		const outputDurationMs = Number(record(outputProbe.format).duration) * 1000;
		const toleranceMs = 100 + document.clips.length * (1000 / 30);
		const streams = Array.isArray(outputProbe.streams)
			? outputProbe.streams.map(record)
			: [];
		if (
			!Number.isFinite(outputDurationMs) ||
			Math.abs(outputDurationMs - durationMs) > toleranceMs ||
			streams.filter((stream) => stream.codec_type === "video").length !== 1 ||
			streams.some(
				(stream) =>
					stream.codec_type === "video" &&
					(stream.codec_name !== "h264" ||
						Number(stream.width) !== canvas.width ||
						Number(stream.height) !== canvas.height),
			) ||
			streams.filter((stream) => stream.codec_type === "audio").length !==
				(document.audioEnabled ? 1 : 0)
		)
			throw new MediaOperationError("OUTPUT_INVALID");
		const size = (await stat(path)).size;
		if (size < 1 || size >= VOD_INPUT_PREVIEW_MAX_OUTPUT_BYTES)
			throw new MediaOperationError("OUTPUT_LIMIT");
		await chmod(path, 0o600);
		const hash = createHash("sha256");
		for await (const bytes of createReadStream(path, { signal: input.signal }))
			hash.update(bytes);
		return {
			path,
			size,
			sha256: hash.digest("hex"),
			durationMs,
			bytesRead: bridge.bytesRead,
		};
	} catch (error) {
		bridge.throwIfFailed();
		throw error;
	} finally {
		await bridge.close();
		await Promise.all(
			[
				...parts.map((part) => join(input.directory, part)),
				...(listWritten ? [join(input.directory, "parts.txt")] : []),
			].map((path) => rm(path, { force: true })),
		);
	}
}
