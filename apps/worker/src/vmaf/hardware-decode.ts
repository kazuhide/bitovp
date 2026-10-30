import type { ProcessRunner } from "../feeder/supervisor";
import { isUnresolvableModel } from "./model-error";

export type DecodePolicy = {
	backend: "cpu" | "auto" | "cuda";
	device: number;
};

export type DecodeSelection = {
	cuda?: { device: number; downloadFormat: "nv12" | "p010le" };
	reason?: string;
};

const QUALIFICATION_TIMEOUT_MS = 15_000;
const supportedCodecs = new Set(["h264", "hevc", "vp9", "av1"]);
const formats = new Map<string, { depth: number; format: "nv12" | "p010le" }>([
	["yuv420p", { depth: 8, format: "nv12" }],
	["yuvj420p", { depth: 8, format: "nv12" }],
	["nv12", { depth: 8, format: "nv12" }],
	["yuv420p10le", { depth: 10, format: "p010le" }],
	["p010le", { depth: 10, format: "p010le" }],
]);

const error = (code: string) =>
	new Error(`CUDA decode qualification failed (${code}).`);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Check every fixed-point coefficient: zero rotation can still hide a mirror. */
function identityDisplayMatrix(value: unknown): boolean {
	if (typeof value !== "string") return false;
	const rows = value.trim().split(/\r?\n/);
	const identity = [
		[65536, 0, 0],
		[0, 65536, 0],
		[0, 0, 1073741824],
	];
	if (rows.length !== identity.length) return false;
	return rows.every((row, index) => {
		const fields = /^[\da-f]+:\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s*$/i.exec(
			row.trim(),
		);
		return (
			fields !== null &&
			identity[index]?.every(
				(expected, column) => Number(fields[column + 1]) === expected,
			) === true
		);
	});
}

function presentationTransformReason(
	video: Record<string, unknown>,
): string | undefined {
	const sideData = video.side_data_list;
	if (sideData !== undefined && !Array.isArray(sideData))
		return "CUDA_INVALID_PROBE";
	// Software decoding applies these presentation transforms; NVDEC can leave
	// the coded pixels unchanged. A successful CUDA probe cannot prove parity.
	for (const item of sideData ?? []) {
		if (!isRecord(item)) return "CUDA_INVALID_PROBE";
		if (item.side_data_type === "Frame Cropping") {
			if (
				!["crop_top", "crop_bottom", "crop_left", "crop_right"].every(
					(key) => item[key] === 0,
				)
			)
				return "CUDA_CONTAINER_CROP_REQUIRES_CPU";
		} else if (item.side_data_type === "Display Matrix") {
			if (
				!identityDisplayMatrix(item.displaymatrix) ||
				(item.rotation !== undefined && item.rotation !== 0)
			)
				return "CUDA_DISPLAY_MATRIX_REQUIRES_CPU";
		}
	}
	const tags = video.tags;
	if (isRecord(tags) && Object.hasOwn(tags, "rotate")) {
		const value = tags.rotate;
		const angle =
			typeof value === "number"
				? value
				: typeof value === "string" && value.trim()
					? Number(value)
					: Number.NaN;
		if (!Number.isFinite(angle) || angle % 360 !== 0)
			return "CUDA_DISPLAY_MATRIX_REQUIRES_CPU";
	}
	return undefined;
}

function inputFormat(
	probe: string,
): { format: "nv12" | "p010le" } | { reason: string } {
	let parsed: unknown;
	try {
		parsed = JSON.parse(probe);
	} catch {
		return { reason: "CUDA_INVALID_PROBE" };
	}
	if (typeof parsed !== "object" || parsed === null || !("streams" in parsed))
		return { reason: "CUDA_INVALID_PROBE" };
	const streams = parsed.streams;
	if (!Array.isArray(streams)) return { reason: "CUDA_INVALID_PROBE" };
	const video: Record<string, unknown> | undefined = streams.find(
		(stream) =>
			typeof stream === "object" &&
			stream !== null &&
			stream.codec_type === "video",
	);
	if (!video) return { reason: "CUDA_INVALID_PROBE" };
	if (
		typeof video.codec_name !== "string" ||
		!supportedCodecs.has(video.codec_name)
	)
		return { reason: "CUDA_UNSUPPORTED_CODEC" };
	const pixel =
		typeof video.pix_fmt === "string" ? formats.get(video.pix_fmt) : undefined;
	if (!pixel) return { reason: "CUDA_UNSUPPORTED_PIXEL_FORMAT" };
	const rawDepth = video.bits_per_raw_sample;
	// A zero value is ffprobe's ordinary "not specified" sentinel.
	if (rawDepth !== undefined && rawDepth !== 0 && rawDepth !== "0") {
		if (
			(typeof rawDepth !== "string" && typeof rawDepth !== "number") ||
			!Number.isInteger(Number(rawDepth)) ||
			Number(rawDepth) <= 0
		)
			return { reason: "CUDA_UNKNOWN_BIT_DEPTH" };
		if (Number(rawDepth) !== pixel.depth)
			return { reason: "CUDA_CONFLICTING_BIT_DEPTH" };
	}
	if (video.codec_name === "h264" && pixel.depth !== 8)
		return { reason: "CUDA_UNSUPPORTED_H264_DEPTH" };
	const reason = presentationTransformReason(video);
	if (reason) return { reason };
	return { format: pixel.format };
}

/** Only device availability failures may trigger an automatic CPU retry. */
export function hardwareDecodeFailureReason(
	stderr: string,
): string | undefined {
	if (
		isUnresolvableModel(stderr) ||
		/invalid data found when processing input|\bcorrupt(?:ed|ion)?\b|invalid (?:nal|obu|frame marker)|error splitting the input into nal|moov atom not found|error during demuxing/i.test(
			stderr,
		)
	)
		return undefined;
	// FFmpeg's NVDEC capability check returns EINVAL, not a CUDA_ERROR token.
	if (
		/hardware is lacking required capabilities|video (?:width|height) \d+ not within range from \d+ to \d+|video macroblock count \d+ exceeds maximum of \d+/i.test(
			stderr,
		)
	)
		return "CUDA_NVDEC_CAPABILITY_UNSUPPORTED";
	if (
		/cannot (?:load|dlopen) libcuda\b|could not dynamically load cuda|CUDA_ERROR_(?:INSUFFICIENT_DRIVER|SYSTEM_DRIVER_MISMATCH|SYSTEM_NOT_READY)/i.test(
			stderr,
		)
	)
		return "CUDA_DRIVER_UNAVAILABLE";
	if (
		/CUDA_ERROR_(?:NO_DEVICE|INVALID_DEVICE)|no cuda[ -]capable device|no device available for decoder: device type cuda\b/i.test(
			stderr,
		)
	)
		return "CUDA_DEVICE_UNAVAILABLE";
	if (
		/cannot (?:load|dlopen) libnvcuvid\b|failed loading nvcuvid|cuvidGetDecoderCaps.*failed/i.test(
			stderr,
		)
	)
		return "CUDA_NVDEC_UNAVAILABLE";
	if (
		/(?:unknown|unrecognized) hwaccel: ?cuda\b|hardware accelerator cuda (?:is )?not available/i.test(
			stderr,
		)
	)
		return "CUDA_BUILD_UNAVAILABLE";
	if (
		/CUDA_ERROR_(?:OUT_OF_MEMORY|NOT_SUPPORTED)|\bcuInit\([^)]*\) failed\b/i.test(
			stderr,
		)
	)
		return "CUDA_RUNTIME_UNAVAILABLE";
	return undefined;
}

/** Qualify the selected video's native CUDA surface before scoring on the CPU. */
export async function selectHardwareDecode({
	policy,
	probe,
	path,
	runner,
	ffmpegPath,
	signal,
}: {
	policy: DecodePolicy;
	probe: string;
	path: string;
	runner: ProcessRunner;
	ffmpegPath: string;
	signal?: AbortSignal;
}): Promise<DecodeSelection> {
	signal?.throwIfAborted();
	if (policy.backend === "cpu") return {};
	if (policy.backend !== "auto" && policy.backend !== "cuda")
		throw error("CUDA_INVALID_POLICY");
	if (!Number.isSafeInteger(policy.device) || policy.device < 0)
		throw error("CUDA_INVALID_DEVICE");
	const fallback = (reason: string): DecodeSelection => {
		if (policy.backend === "cuda") throw error(reason);
		return { reason };
	};
	const input = inputFormat(probe);
	if ("reason" in input) return fallback(input.reason);
	const timeout = new AbortController();
	const timer = setTimeout(() => timeout.abort(), QUALIFICATION_TIMEOUT_MS);
	timer.unref();
	try {
		let result: Awaited<ReturnType<ProcessRunner["run"]>>;
		try {
			result = await runner.run(
				ffmpegPath,
				[
					"-hide_banner",
					"-nostdin",
					"-progress",
					"pipe:1",
					"-nostats",
					"-hwaccel",
					"cuda",
					"-hwaccel_device",
					String(policy.device),
					"-hwaccel_output_format",
					"cuda",
					"-i",
					path,
					"-map",
					"0:v:0",
					"-frames:v",
					"3",
					"-vf",
					`hwdownload,format=${input.format}`,
					"-an",
					"-sn",
					"-f",
					"null",
					"-",
				],
				{
					signal: signal
						? AbortSignal.any([signal, timeout.signal])
						: timeout.signal,
					abortKillAfterMs: 250,
				},
			);
		} catch {
			signal?.throwIfAborted();
			throw error(
				timeout.signal.aborted
					? "CUDA_DECODE_PROBE_TIMEOUT"
					: "CUDA_DECODE_PROBE_FAILED",
			);
		}
		signal?.throwIfAborted();
		if (timeout.signal.aborted) throw error("CUDA_DECODE_PROBE_TIMEOUT");
		if (result.code !== 0) {
			const reason = hardwareDecodeFailureReason(result.stderr);
			if (reason) return fallback(reason);
			throw error("CUDA_DECODE_PROBE_FAILED");
		}
		if (!/^frame=[1-9]\d{0,11}\r?$/m.test(result.stdout))
			throw error("CUDA_DECODE_PROBE_EMPTY");
		return { cuda: { device: policy.device, downloadFormat: input.format } };
	} finally {
		clearTimeout(timer);
	}
}
