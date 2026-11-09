import { createHash } from "node:crypto";
import { lstat, mkdtemp, open, readFile, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { VmafReferencePreparationEvidence } from "@bitovp/core";
import type { ProcessRunner } from "../feeder/supervisor";
import { presentationTransformReason } from "./hardware-decode";
import { hashNativeFile } from "./native-contract";

const LIMIT = 64 * 1024 * 1024;
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const fail = (reason: string): never => {
	throw new Error(`REFERENCE_PREPARATION_${reason}`);
};
type Video = Record<string, unknown>;
function videoOf(probe: string, prepared = false): Video {
	if (Buffer.byteLength(probe) > 1024 * 1024) fail("PROBE_LIMIT");
	const streams = JSON.parse(probe).streams;
	if (!Array.isArray(streams)) return fail("VIDEO_STREAM");
	const videos = streams.filter((stream) => stream?.codec_type === "video");
	if (videos.length !== 1 || (prepared && streams.length !== 1))
		return fail("VIDEO_STREAM");
	return videos[0];
}
function displayScale(
	video: Video,
): VmafReferencePreparationEvidence["sourceDisplayMatrix"] {
	const data = video.side_data_list;
	if (!Array.isArray(data)) return fail("DISPLAY_SCALE_REQUIRED");
	if (
		data.some(
			(entry) =>
				!entry ||
				!["Display Matrix", "Frame Cropping"].includes(entry.side_data_type),
		)
	)
		return fail("UNKNOWN_PRESENTATION_DATA");
	const matrices = data.filter(
		(entry) => entry?.side_data_type === "Display Matrix",
	);
	const matrix = matrices[0];
	if (
		matrices.length !== 1 ||
		matrix.rotation !== 0 ||
		typeof matrix.displaymatrix !== "string"
	)
		return fail("DISPLAY_SCALE_REQUIRED");
	const rows = matrix.displaymatrix.trim().split(/\r?\n/);
	if (rows.length !== 3) return fail("DISPLAY_MATRIX");
	const values: number[] = rows.flatMap((row: string) => {
		const match = /^[\da-f]+:\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s*$/i.exec(
			row.trim(),
		);
		if (!match) return fail("DISPLAY_MATRIX");
		return match.slice(1).map(Number);
	});
	if (
		values.some(
			(value) =>
				!Number.isInteger(value) || value < -(2 ** 31) || value >= 2 ** 31,
		) ||
		(values[0] ?? 0) <= 0 ||
		(values[4] ?? 0) <= 0 ||
		values[8] !== 1073741824 ||
		[1, 2, 3, 5, 6, 7].some((index) => values[index] !== 0) ||
		(values[0] === 65536 && values[4] === 65536)
	)
		return fail("DISPLAY_MATRIX");
	if (
		presentationTransformReason({
			...video,
			side_data_list: data.filter((entry) => entry !== matrix),
		})
	)
		return fail("PRESENTATION_TRANSFORM");
	if (
		video.codec_name !== "h264" ||
		video.pix_fmt !== "yuv420p" ||
		![video.width, video.height].every(
			(value) =>
				typeof value === "number" &&
				Number.isSafeInteger(value) &&
				value > 0 &&
				value <= 16384 &&
				value % 2 === 0,
		) ||
		(video.sample_aspect_ratio !== undefined &&
			video.sample_aspect_ratio !== "1:1") ||
		[video.color_transfer, video.color_primaries, video.color_space].some(
			(value) =>
				/^(?:bt2020|smpte2084|arib-std-b67|smpte428)/.test(String(value)),
		) ||
		typeof video.time_base !== "string" ||
		!/^1\/[1-9]\d{0,9}$/.test(video.time_base) ||
		Number(video.time_base.slice(2)) > 2147483647
	)
		return fail("UNSUPPORTED_INPUT");
	return values as VmafReferencePreparationEvidence["sourceDisplayMatrix"];
}
const identityFields = [
	"codec_name",
	"codec_tag_string",
	"profile",
	"level",
	"width",
	"height",
	"pix_fmt",
	"sample_aspect_ratio",
	"time_base",
	"r_frame_rate",
	"avg_frame_rate",
	"field_order",
	"color_range",
	"color_space",
	"color_transfer",
	"color_primaries",
	"chroma_location",
	"bits_per_raw_sample",
	"has_b_frames",
	"is_avc",
	"nal_length_size",
	"extradata_size",
	"extradata_hash",
	"duration_ts",
	"nb_frames",
];
function identity(video: Video) {
	if (
		typeof video.extradata_hash !== "string" ||
		!/^SHA256:[a-f0-9]{64}$/.test(video.extradata_hash) ||
		typeof video.extradata_size !== "number" ||
		video.extradata_size <= 0
	)
		return fail("CODEC_IDENTITY");
	return JSON.stringify(
		identityFields.map((field) => [field, video[field] ?? null]),
	);
}
function packets(text: string) {
	const rows = JSON.parse(text).packets;
	if (!Array.isArray(rows) || rows.length === 0 || rows.length > 500000)
		return fail("PACKET_COVERAGE");
	return rows.map((row, index) => {
		if (
			row.stream_index !== 0 ||
			![row.pts, row.dts, row.duration].every(Number.isSafeInteger) ||
			row.duration <= 0 ||
			!/^[1-9]\d*$/.test(row.size) ||
			!/^SHA256:[a-f0-9]{64}$/.test(row.data_hash) ||
			(index > 0 && row.dts <= rows[index - 1].dts)
		)
			return fail("PACKET_TIMING");
		return [row.pts, row.dts, row.duration, row.size, row.data_hash];
	});
}
function frames(text: string, video: Video) {
	if (
		!text.includes("#hash: SHA256\n") ||
		!text.includes(`#tb 0: ${video.time_base}\n`) ||
		!text.includes(`#dimensions 0: ${video.width}x${video.height}\n`) ||
		!text.includes("#codec_id 0: rawvideo\n")
	)
		return fail("FRAME_IDENTITY");
	const rows = text
		.split(/\r?\n/)
		.filter((line) => line && !line.startsWith("#"))
		.map((line) => {
			const fields = line.split(",").map((field) => field.trim());
			if (
				fields.length !== 6 ||
				fields[0] !== "0" ||
				!fields.slice(1, 5).every((field) => /^-?\d+$/.test(field)) ||
				!Number.isSafeInteger(Number(fields[1])) ||
				!Number.isSafeInteger(Number(fields[2])) ||
				!Number.isSafeInteger(Number(fields[3])) ||
				Number(fields[3]) <= 0 ||
				Number(fields[4]) !==
					Number(video.width) * Number(video.height) * 1.5 ||
				!/^[a-f0-9]{64}$/.test(fields[5] ?? "")
			)
				return fail("FRAME_TIMING");
			return fields;
		});
	if (
		!rows.length ||
		rows.length > 500000 ||
		rows.some(
			(row, index) =>
				index > 0 &&
				Number(row[2]) <
					Number(rows[index - 1]?.[2]) + Number(rows[index - 1]?.[3]),
		)
	)
		return fail("FRAME_COVERAGE");
	return rows;
}

/** Explicit manual measurement only. Every packet and software-decoded raster must
 * match before the prepared reference can reach the unchanged native guard. */
export async function prepareDisplayScaleReference(input: {
	runner: ProcessRunner;
	ffmpegPath: string;
	ffprobePath: string;
	originalPath: string;
	preparedPath: string;
	originalProbe: string;
	originalSha256: string;
	signal?: AbortSignal;
}): Promise<{
	path: string;
	probe: string;
	evidence: VmafReferencePreparationEvidence;
}> {
	const { runner, originalPath, preparedPath, signal } = input;
	signal?.throwIfAborted();
	const originalVideo = videoOf(input.originalProbe);
	const sourceDisplayMatrix = displayScale(originalVideo);
	if (
		resolve(originalPath) === resolve(preparedPath) ||
		!/^[a-f0-9]{64}$/.test(input.originalSha256) ||
		!(await lstat(originalPath)).isFile() ||
		(await hashNativeFile(originalPath, signal)) !== input.originalSha256
	)
		return fail("INPUT_IDENTITY");
	const sourceSize = (await stat(originalPath)).size;
	if (
		!Number.isSafeInteger(sourceSize) ||
		sourceSize <= 0 ||
		sourceSize > 8 * 1024 ** 3
	)
		return fail("INPUT_LIMIT");
	const outputLimit = sourceSize * 2 + 1024 * 1024;
	const reserved = await open(preparedPath, "wx", 0o600);
	let directory: string | undefined;
	try {
		await reserved.close();
		directory = await mkdtemp(join(dirname(preparedPath), ".reference-proof-"));
		const run = async (
			bin: string,
			args: string[],
			output: string,
			limit = LIMIT,
		) => {
			const cap = new AbortController();
			const combined = AbortSignal.any([
				cap.signal,
				AbortSignal.timeout(15 * 60 * 1000),
				...(signal ? [signal] : []),
			]);
			const timer = setInterval(() => {
				void stat(output)
					.then((file) => {
						if (file.size > limit)
							cap.abort(new Error("REFERENCE_PREPARATION_OUTPUT_LIMIT"));
					})
					.catch((error) => {
						if (error.code !== "ENOENT") cap.abort(error);
					});
			}, 50);
			try {
				const result = await runner.run(bin, args, {
					signal: combined,
					abortKillAfterMs: 250,
				});
				combined.throwIfAborted();
				if (
					result.code !== 0 ||
					result.stdout.length > 65536 ||
					result.stderr.length > 65536
				)
					fail("PROCESS");
				const file = await lstat(output);
				if (!file.isFile() || file.size === 0 || file.size > limit)
					fail("OUTPUT_LIMIT");
			} finally {
				clearInterval(timer);
			}
		};
		const probe = async (path: string, label: string) => {
			const file = join(directory ?? "", `${label}.probe.json`);
			await run(
				input.ffprobePath,
				[
					"-v",
					"quiet",
					"-show_streams",
					"-show_data_hash",
					"sha256",
					"-of",
					"json",
					"-o",
					file,
					path,
				],
				file,
				1024 * 1024,
			);
			return readFile(file, "utf8");
		};
		const freshProbe = await probe(originalPath, "original");
		const freshVideo = videoOf(freshProbe);
		if (
			JSON.stringify(displayScale(freshVideo)) !==
				JSON.stringify(sourceDisplayMatrix) ||
			identityFields
				.filter((field) => field !== "extradata_hash")
				.some(
					(field) =>
						originalVideo[field] !== undefined &&
						originalVideo[field] !== freshVideo[field],
				)
		)
			fail("INPUT_PROBE_CHANGED");
		const streamIdentity = identity(freshVideo);
		const timeBase = String(freshVideo.time_base);
		await run(
			input.ffmpegPath,
			[
				"-v",
				"quiet",
				"-nostdin",
				"-xerror",
				"-y",
				"-noautorotate",
				"-display_rotation:v:0",
				"0",
				"-copyts",
				"-i",
				originalPath,
				"-map",
				"0:v:0",
				"-c:v",
				"copy",
				"-copytb",
				"1",
				"-map_metadata",
				"-1",
				"-avoid_negative_ts",
				"disabled",
				"-video_track_timescale",
				timeBase.slice(2),
				"-fs",
				String(outputLimit),
				"-f",
				"mov",
				preparedPath,
			],
			preparedPath,
			outputLimit,
		);
		const preparedProbe = await probe(preparedPath, "prepared");
		const preparedVideo = videoOf(preparedProbe, true);
		if (
			presentationTransformReason(preparedVideo) ||
			streamIdentity !== identity(preparedVideo)
		)
			fail("PREPARED_IDENTITY");
		const preparedBeforeProof = await hashNativeFile(preparedPath, signal);
		const proof = async (path: string, label: string) => {
			const packetFile = join(directory ?? "", `${label}.packets.json`),
				frameFile = join(directory ?? "", `${label}.framehash`);
			await run(
				input.ffprobePath,
				[
					"-v",
					"quiet",
					"-select_streams",
					"v:0",
					"-show_packets",
					"-show_entries",
					"packet=stream_index,pts,dts,duration,size,data_hash",
					"-show_data_hash",
					"sha256",
					"-of",
					"json",
					"-o",
					packetFile,
					path,
				],
				packetFile,
			);
			await run(
				input.ffmpegPath,
				[
					"-v",
					"quiet",
					"-nostdin",
					"-xerror",
					"-noautorotate",
					"-copyts",
					"-hwaccel",
					"none",
					"-threads",
					"1",
					"-i",
					path,
					"-map",
					"0:v:0",
					"-an",
					"-c:v",
					"rawvideo",
					"-pix_fmt",
					"yuv420p",
					"-fps_mode",
					"passthrough",
					"-enc_time_base",
					timeBase,
					"-fs",
					String(LIMIT),
					"-f",
					"framehash",
					"-hash",
					"sha256",
					frameFile,
				],
				frameFile,
			);
			return {
				packets: packets(await readFile(packetFile, "utf8")),
				frames: frames(await readFile(frameFile, "utf8"), freshVideo),
			};
		};
		const before = await proof(originalPath, "original"),
			after = await proof(preparedPath, "prepared");
		const packetJson = JSON.stringify(before.packets),
			frameJson = JSON.stringify(before.frames);
		if (
			packetJson !== JSON.stringify(after.packets) ||
			frameJson !== JSON.stringify(after.frames) ||
			before.packets.length !== before.frames.length ||
			(freshVideo.nb_frames !== undefined &&
				Number(freshVideo.nb_frames) !== before.frames.length)
		)
			fail("CONTENT_OR_TIMING_MISMATCH");
		if ((await hashNativeFile(originalPath, signal)) !== input.originalSha256)
			fail("INPUT_CHANGED");
		const preparedSha256 = await hashNativeFile(preparedPath, signal),
			preparedBytes = (await stat(preparedPath)).size;
		if (preparedSha256 !== preparedBeforeProof) fail("PREPARED_CHANGED");
		await rm(directory, { recursive: true, force: true });
		signal?.throwIfAborted();
		return {
			path: preparedPath,
			probe: preparedProbe,
			evidence: {
				version: 1,
				method: "LOSSLESS_DISPLAY_SCALE_REMUX",
				comparisonSpace: "CODED_RASTER",
				inputSha256: input.originalSha256,
				preparedSha256,
				preparedBytes,
				sourceDisplayMatrix,
				width: Number(freshVideo.width),
				height: Number(freshVideo.height),
				codec: "h264",
				pixelFormat: "yuv420p",
				timeBase,
				packetCount: before.packets.length,
				frameCount: before.frames.length,
				packetSha256: sha(packetJson),
				frameSha256: sha(frameJson),
				streamIdentitySha256: sha(streamIdentity),
				packetTimingVerified: true,
				frameTimingVerified: true,
			},
		};
	} catch (error) {
		await rm(preparedPath, { force: true });
		throw error;
	} finally {
		if (directory) await rm(directory, { recursive: true, force: true });
	}
}
