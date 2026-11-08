import { createWriteStream } from "node:fs";
import { open, rm } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { Readable } from "node:stream";
import {
	assertCompleteTransfer,
	type ObjectIdentity,
	type ObjectStorageBrowser,
	ObjectVersionMismatchError,
	pipeWithDigest,
	VersionExpectationUnsupportedError,
} from "@bitovp/storage";
import { MediaOperationError, runMediaProcess } from "./process";
import { MAX_EDITING_SOURCE_BYTES } from "./source-limits";

export type EditingMediaFacts = {
	width: number;
	height: number;
	durationUs: number;
	frameCount: number;
	fps: { num: 30; den: 1 };
	hasAudio: boolean;
	probe: Record<string, unknown>;
};

export function assertLocalMediaPath(path: string): void {
	if (!isAbsolute(path) || path.includes("\0"))
		throw new MediaOperationError("INVALID_LOCAL_PATH");
}

function abortable<T>(
	pending: Promise<T>,
	signal: AbortSignal,
	error: () => Error,
	dispose?: (value: T) => void,
): Promise<T> {
	return new Promise((resolve, reject) => {
		const abort = () => reject(error());
		signal.addEventListener("abort", abort, { once: true });
		pending.then(
			(value) => {
				signal.removeEventListener("abort", abort);
				if (signal.aborted) {
					dispose?.(value);
					reject(error());
				} else resolve(value);
			},
			(reason) => {
				signal.removeEventListener("abort", abort);
				reject(signal.aborted ? error() : reason);
			},
		);
		if (signal.aborted) abort();
	});
}

/** A fresh capture records current bytes; a replay additionally checks their stored hash. */
export async function downloadPinnedEditingMedia(input: {
	browser: ObjectStorageBrowser;
	bucket: string;
	key: string;
	destinationPath: string;
	maxBytes?: number;
	expectedIdentity?: ObjectIdentity;
	expectedSha256?: string;
	signal?: AbortSignal;
	timeoutMs?: number;
}): Promise<{ identity: ObjectIdentity; sha256: string; bytes: number }> {
	assertLocalMediaPath(input.destinationPath);
	if (input.signal?.aborted) throw new MediaOperationError("CANCELED");
	const timeoutMs = input.timeoutMs ?? 10 * 60_000;
	if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2 ** 31 - 1)
		throw new RangeError("Invalid media download timeout");
	const signal = AbortSignal.any([
		AbortSignal.timeout(timeoutMs),
		...(input.signal ? [input.signal] : []),
	]);
	const abortError = () =>
		new MediaOperationError(input.signal?.aborted ? "CANCELED" : "TIMED_OUT");
	const maxBytes = input.maxBytes ?? MAX_EDITING_SOURCE_BYTES;
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
		throw new RangeError("Invalid media byte bound");
	if (!input.browser.getObject || !input.browser.headObject)
		throw new MediaOperationError("SOURCE_UNVERIFIED");
	if (input.expectedSha256 && !/^[a-f0-9]{64}$/.test(input.expectedSha256))
		throw new MediaOperationError("SOURCE_UNVERIFIED");
	const identity =
		input.expectedIdentity ??
		(await abortable(
			input.browser.headObject({ bucket: input.bucket, key: input.key }),
			signal,
			abortError,
		));
	if (
		!Number.isSafeInteger(identity.size) ||
		identity.size < 1 ||
		!(identity.etag || identity.versionId || identity.generation)
	)
		throw new MediaOperationError("SOURCE_UNVERIFIED");
	if (identity.size > maxBytes)
		throw new MediaOperationError("SOURCE_TOO_LARGE");
	if (signal.aborted) throw abortError();
	const file = await open(input.destinationPath, "wx", 0o600);
	let complete = false;
	let source: NodeJS.ReadableStream | undefined;
	const stopSource = () => (source as Readable | undefined)?.destroy?.();
	try {
		source = await abortable(
			input.browser.getObject({
				bucket: input.bucket,
				key: input.key,
				expect: {
					etag: identity.etag,
					versionId: identity.versionId,
					generation: identity.generation,
				},
			}),
			signal,
			abortError,
			(late) => (late as Readable).destroy?.(),
		);
		if (signal.aborted) {
			stopSource();
			throw abortError();
		}
		signal.addEventListener("abort", stopSource, { once: true });
		const readable = source;
		const bounded = Readable.from(
			(async function* () {
				let bytes = 0;
				for await (const chunk of readable) {
					const buf =
						typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer);
					bytes += buf.length;
					if (bytes > maxBytes)
						throw new MediaOperationError("SOURCE_TOO_LARGE");
					yield buf;
				}
			})(),
		);
		const transfer = await pipeWithDigest(
			bounded,
			createWriteStream(input.destinationPath, {
				fd: file.fd,
				autoClose: false,
			}),
			{ signal },
		);
		try {
			assertCompleteTransfer(transfer, identity.size);
		} catch {
			throw new MediaOperationError("SOURCE_INCOMPLETE");
		}
		if (input.expectedSha256 && transfer.sha256 !== input.expectedSha256)
			throw new MediaOperationError("SOURCE_CHANGED");
		complete = true;
		return { identity, ...transfer };
	} catch (error) {
		if (signal.aborted) throw abortError();
		if (error instanceof ObjectVersionMismatchError)
			throw new MediaOperationError("SOURCE_CHANGED");
		if (error instanceof VersionExpectationUnsupportedError)
			throw new MediaOperationError("SOURCE_UNVERIFIED");
		throw error;
	} finally {
		signal.removeEventListener("abort", stopSource);
		await file.close();
		if (!complete) await rm(input.destinationPath, { force: true });
	}
}

const object = (value: unknown): Record<string, unknown> =>
	value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
const number = (value: unknown): number =>
	typeof value === "number"
		? value
		: typeof value === "string" && value.trim() !== ""
			? Number(value)
			: Number.NaN;
const refuse = (): never => {
	throw new MediaOperationError("UNSUPPORTED_MEDIA");
};

/** Metadata admission is necessary; probeEditingMedia also verifies every decoded PTS. */
export function inspectEditingProbe(raw: unknown): EditingMediaFacts {
	const probe = object(raw);
	const streams = Array.isArray(probe.streams) ? probe.streams.map(object) : [];
	const videos = streams.filter((stream) => stream.codec_type === "video");
	const audios = streams.filter((stream) => stream.codec_type === "audio");
	if (
		videos.length !== 1 ||
		audios.length > 1 ||
		streams.length !== videos.length + audios.length
	)
		return refuse();
	const video = videos[0];
	if (!video) return refuse();
	const format = object(probe.format);
	const width = number(video.width);
	const height = number(video.height);
	// The container duration may include AAC padding; only the indexed video declaration binds the timeline.
	const duration = number(video.duration);
	const declaredFrames = number(video.nb_frames);
	const sideData = Array.isArray(video.side_data_list)
		? video.side_data_list.map(object)
		: [];
	const rotation = object(video.tags).rotate;
	if (
		!String(format.format_name ?? "")
			.split(",")
			.includes("mov") ||
		video.codec_name !== "h264" ||
		video.codec_tag_string !== "avc1" ||
		video.pix_fmt !== "yuv420p" ||
		video.field_order !== "progressive" ||
		video.sample_aspect_ratio !== "1:1" ||
		video.r_frame_rate !== "30/1" ||
		video.avg_frame_rate !== "30/1" ||
		number(video.start_time) !== 0 ||
		(rotation !== undefined && number(rotation) !== 0) ||
		sideData.some(
			(side) => side.rotation !== undefined && number(side.rotation) !== 0,
		) ||
		video.color_transfer !== "bt709" ||
		video.color_primaries !== "bt709" ||
		video.color_space !== "bt709" ||
		!Number.isInteger(width) ||
		!Number.isInteger(height) ||
		width < 2 ||
		height < 2 ||
		width > 8192 ||
		height > 8192 ||
		!Number.isFinite(duration) ||
		duration <= 0 ||
		duration > 3600 ||
		!Number.isSafeInteger(declaredFrames) ||
		declaredFrames < 1 ||
		declaredFrames > 108000
	)
		return refuse();
	if (Math.abs(duration - declaredFrames / 30) > 0.000002)
		throw new MediaOperationError("SOURCE_INCOMPLETE");
	const audio = audios[0];
	if (
		audio &&
		(audio.codec_name !== "aac" ||
			number(audio.start_time) !== 0 ||
			![1, 2].includes(number(audio.channels)) ||
			![44100, 48000].includes(number(audio.sample_rate)))
	)
		return refuse();
	return {
		width,
		height,
		durationUs: Math.round(duration * 1_000_000),
		frameCount: declaredFrames,
		fps: { num: 30, den: 1 },
		hasAudio: !!audio,
		probe,
	};
}

const readInput = (path: string) => [
	"-protocol_whitelist",
	"file,pipe",
	"-format_whitelist",
	"mov",
	"-enable_drefs",
	"0",
	"-use_absolute_path",
	"0",
	"-i",
	path,
];

export async function probeEditingMedia(input: {
	sourcePath: string;
	ffprobePath?: string;
	signal?: AbortSignal;
	timeoutMs?: number;
}): Promise<EditingMediaFacts> {
	assertLocalMediaPath(input.sourcePath);
	const options = { signal: input.signal, timeoutMs: input.timeoutMs };
	const metadata = await runMediaProcess(
		input.ffprobePath ?? "ffprobe",
		[
			"-v",
			"error",
			...readInput(input.sourcePath),
			"-show_streams",
			"-show_format",
			"-of",
			"json",
		],
		options,
	);
	if (metadata.stderr.length > 0)
		throw new MediaOperationError("SOURCE_INCOMPLETE");
	let parsed: unknown;
	try {
		parsed = JSON.parse(metadata.stdout);
	} catch {
		throw new MediaOperationError("INVALID_MEDIA_PROBE");
	}
	const facts = inspectEditingProbe(parsed);
	const timestamps = await runMediaProcess(
		input.ffprobePath ?? "ffprobe",
		[
			"-v",
			"error",
			...readInput(input.sourcePath),
			"-select_streams",
			"v:0",
			"-show_frames",
			"-show_entries",
			"frame=best_effort_timestamp_time",
			"-of",
			"csv=p=0",
		],
		options,
	);
	if (timestamps.stderr.length > 0)
		throw new MediaOperationError("SOURCE_INCOMPLETE");
	let frameCount = 0;
	for (const row of timestamps.stdout.split(/\r?\n/)) {
		if (!row.trim()) continue;
		const pts = number(row.split(",")[0]);
		if (
			!Number.isFinite(pts) ||
			Math.abs(pts - frameCount / 30) > 0.000002 ||
			frameCount >= 108000
		)
			return refuse();
		frameCount++;
	}
	if (frameCount !== facts.frameCount)
		throw new MediaOperationError("SOURCE_INCOMPLETE");
	return {
		...facts,
		frameCount,
		durationUs: Math.ceil((frameCount * 1_000_000) / 30),
	};
}
