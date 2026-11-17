import "server-only";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { MOQ_OBSERVATION_LIMITS } from "@/lib/moq-player/observations";

/** Validate the EBML header's actual DocType, not a magic substring in media. */
export function hasWebmHeader(bytes: Uint8Array): boolean {
	try {
		if (Buffer.from(bytes.subarray(0, 4)).toString("hex") !== "1a45dfa3")
			return false;
		const vint = (offset: number, id = false) => {
			const first = bytes[offset];
			if (!first) throw new Error("Invalid EBML");
			let mask = 0x80,
				length = 1;
			while (!(first & mask)) {
				mask >>= 1;
				length++;
			}
			if (length > (id ? 4 : 8) || offset + length > bytes.length)
				throw new Error("Invalid EBML");
			let value = id ? first : first & (mask - 1);
			for (let i = 1; i < length; i++)
				value = value * 256 + (bytes[offset + i] ?? 0);
			if (!Number.isSafeInteger(value)) throw new Error("Invalid EBML");
			return { value, next: offset + length };
		};
		const size = vint(4),
			end = size.next + size.value;
		if (size.value > 4_096 || end > bytes.length) return false;
		let position = size.next;
		while (position < end) {
			const id = vint(position, true),
				field = vint(id.next);
			if (field.next + field.value > end) return false;
			if (id.value === 0x4282)
				return (
					Buffer.from(
						bytes.subarray(field.next, field.next + field.value),
					).toString("utf8") === "webm"
				);
			position = field.next + field.value;
		}
		return false;
	} catch {
		return false;
	}
}
const probeSchema = z.object({
	format: z.object({
		format_name: z.string(),
		duration: z.string().optional(),
	}),
	streams: z
		.array(
			z.object({
				index: z.number().int(),
				codec_type: z.string(),
				codec_name: z.string(),
			}),
		)
		.min(1)
		.max(16),
	packets: z
		.array(
			z.object({
				stream_index: z.number().int(),
				pts_time: z.string(),
				duration_time: z.string().optional(),
			}),
		)
		.min(2)
		.max(40_000),
});
export function validateMoqArchiveProbe(value: unknown): number {
	const probe = probeSchema.parse(value);
	const videos = new Set(
		probe.streams
			.filter(
				(stream) =>
					stream.codec_type === "video" &&
					["vp8", "vp9", "av1"].includes(stream.codec_name),
			)
			.map((stream) => stream.index),
	);
	if (
		!probe.format.format_name
			.split(",")
			.some((name) => name === "webm" || name === "matroska") ||
		videos.size === 0
	)
		throw new Error("Invalid WebM archive");
	let first = Infinity,
		last = -Infinity,
		videoPackets = 0;
	for (const packet of probe.packets) {
		const at = Number(packet.pts_time),
			duration =
				packet.duration_time === undefined ? 0 : Number(packet.duration_time);
		if (!Number.isFinite(at) || !Number.isFinite(duration) || duration < 0)
			throw new Error("Invalid WebM archive");
		first = Math.min(first, at);
		last = Math.max(last, at + duration);
		if (videos.has(packet.stream_index)) videoPackets++;
	}
	const reported = Number(probe.format.duration);
	const durationMs = Math.ceil(
		Math.max(last - first, Number.isFinite(reported) ? reported : 0) * 1_000 -
			0.000_001,
	);
	if (
		videoPackets < 2 ||
		durationMs < 1 ||
		durationMs > MOQ_OBSERVATION_LIMITS.archiveDurationMs
	)
		throw new Error("Invalid WebM archive");
	return durationMs;
}
export async function probeMoqArchive(
	path: string,
	requireSeekableDuration = false,
): Promise<number> {
	const result = await promisify(execFile)(
		process.env.FFPROBE_PATH ?? "ffprobe",
		[
			"-v",
			"error",
			"-protocol_whitelist",
			"file,pipe",
			"-max_alloc",
			"33554432",
			"-threads",
			"1",
			"-probesize",
			String(MOQ_OBSERVATION_LIMITS.archiveBytes),
			"-analyzeduration",
			"90000000",
			"-f",
			"matroska",
			"-i",
			path,
			"-show_packets",
			"-show_entries",
			"format=format_name,duration:stream=index,codec_type,codec_name:packet=stream_index,pts_time,duration_time",
			"-of",
			"json",
		],
		{
			timeout: 15_000,
			killSignal: "SIGKILL",
			maxBuffer: 2 * 1024 * 1024,
			encoding: "utf8",
			windowsHide: true,
		},
	);
	const value: unknown = JSON.parse(result.stdout);
	if (requireSeekableDuration) {
		const parsed = probeSchema.parse(value);
		if (
			!Number.isFinite(Number(parsed.format.duration)) ||
			Number(parsed.format.duration) <= 0
		)
			throw new Error("WebM archive duration is unavailable");
	}
	return validateMoqArchiveProbe(value);
}

/** Copy-remux a bounded browser WebM into a seekable local file with Duration/Cues. */
export async function normalizeMoqArchive(
	source: string,
	target: string,
): Promise<number> {
	const originalDuration = await probeMoqArchive(source);
	await promisify(execFile)(
		process.env.FFMPEG_PATH ?? "ffmpeg",
		[
			"-nostdin",
			"-v",
			"error",
			"-protocol_whitelist",
			"file,pipe",
			"-max_alloc",
			"33554432",
			"-threads",
			"1",
			"-f",
			"matroska",
			"-i",
			source,
			"-map",
			"0:v:0",
			"-map",
			"0:a:0?",
			"-map_metadata",
			"-1",
			"-c",
			"copy",
			"-fs",
			String(MOQ_OBSERVATION_LIMITS.archiveBytes + 1),
			"-f",
			"webm",
			"-y",
			target,
		],
		{
			timeout: 15_000,
			killSignal: "SIGKILL",
			maxBuffer: 128 * 1024,
			encoding: "utf8",
			windowsHide: true,
		},
	);
	const normalizedDuration = await probeMoqArchive(target, true);
	if (normalizedDuration < originalDuration - 100)
		throw new Error("WebM archive was truncated");
	return normalizedDuration;
}
