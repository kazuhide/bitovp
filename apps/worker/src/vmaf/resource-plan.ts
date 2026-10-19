import { geometryFromProbe } from "./geometry";
import { ResourceUnavailableError } from "./resource-admission";
import type { LocalResources } from "./resources";

const MiB = 1024 ** 2;
const HD = 1920 * 1080;
const UHD = 3840 * 2160;

export type ResourceVideo = {
	width: number;
	height: number;
	fps?: number;
	bitDepth?: number;
	chromaFactor?: number;
	codec?: string;
	durationSeconds?: number;
	frames?: number;
};
export type ResourcePair = {
	reference: ResourceVideo;
	distorted: ResourceVideo;
	model: string;
	psnr?: boolean;
	measurementMethod?: string;
	outputFps?: number;
};
export type LocalResourceOptions = { concurrency?: number; threads?: number };
export type LocalResourcePlan = {
	threads: number;
	concurrency: number;
	estimatedBytes: number;
	frameCount?: number;
	exclusive: boolean;
	manualFallback: boolean;
	decoderThreads?: number;
	filterComplexThreads?: number;
};

const positive = (raw: unknown) => {
	if (typeof raw !== "number" && typeof raw !== "string") return undefined;
	const n = Number(raw);
	return Number.isFinite(n) && n > 0 ? n : undefined;
};

function pixelFormat(raw: unknown) {
	if (typeof raw !== "string") return undefined;
	const planar = raw.match(
		/^yuvj?(420|422|444)p(?:(9|10|12|14|16)(?:le|be))?$/,
	);
	if (planar)
		return {
			depth: Number(planar[2] ?? 8),
			chroma: planar[1] === "420" ? 1 : planar[1] === "422" ? 4 / 3 : 2,
		};
	if (raw === "nv12" || raw === "nv21") return { depth: 8, chroma: 1 };
	const semi = raw.match(/^p0(10|12|16)(?:le|be)$/);
	if (semi) return { depth: Number(semi[1]), chroma: 1 };
	const gray = raw.match(/^gray(?:(9|10|12|14|16)(?:le|be))?$/);
	if (gray) return { depth: Number(gray[1] ?? 8), chroma: 1 };
	const rgb = raw.match(/^gbrp(?:(9|10|12|14|16)(?:le|be))?$/);
	if (rgb) return { depth: Number(rgb[1] ?? 8), chroma: 2 };
	if (["rgb24", "bgr24"].includes(raw)) return { depth: 8, chroma: 2 };
	if (["rgba", "bgra", "argb", "abgr"].includes(raw))
		return { depth: 8, chroma: 3 };
	return undefined;
}

/** Resource metadata never changes the geometry or pixel format used to score. */
export function resourceVideoFromProbe(stdout: string): ResourceVideo {
	const geometry = geometryFromProbe(stdout);
	if (
		![geometry.width, geometry.height].every(
			(n) => Number.isSafeInteger(n) && n > 0,
		)
	)
		throw new ResourceUnavailableError("metadata");
	const parsed = JSON.parse(stdout) as {
		streams?: Record<string, unknown>[];
		format?: { duration?: unknown };
	};
	const stream = parsed.streams?.find((item) => item.codec_type === "video");
	const format = pixelFormat(stream?.pix_fmt);
	const rawDepth = positive(stream?.bits_per_raw_sample);
	const conflicting = rawDepth !== undefined && rawDepth !== format?.depth;
	return {
		...geometry,
		bitDepth: conflicting ? undefined : format?.depth,
		chromaFactor: conflicting ? undefined : format?.chroma,
		codec:
			typeof stream?.codec_name === "string" ? stream.codec_name : undefined,
		durationSeconds:
			positive(stream?.duration) ?? positive(parsed.format?.duration),
		frames: positive(stream?.nb_frames),
	};
}

function estimatedFrames(pair: ResourcePair) {
	const fps = positive(pair.outputFps) ?? positive(pair.reference.fps);
	const duration = (video: ResourceVideo) =>
		video.durationSeconds ??
		(video.frames !== undefined && positive(video.fps)
			? video.frames / (video.fps as number)
			: undefined);
	const reference = duration(pair.reference);
	const distorted = duration(pair.distorted);
	if (fps !== undefined && reference !== undefined && distorted !== undefined)
		return Math.ceil(Math.max(reference, distorted) * fps);
	if (
		pair.reference.frames !== undefined &&
		pair.distorted.frames !== undefined
	)
		return Math.ceil(Math.max(pair.reference.frames, pair.distorted.frames));
	throw new ResourceUnavailableError("metadata");
}

/** Measured RSS upper envelope, padded by 25% and rounded up to 64 MiB. */
function workingMemory(pixels: number, threads: number) {
	if (pixels <= 1280 * 720)
		return (threads <= 2 ? 320 : 448 * Math.max(1, threads / 4)) * MiB;
	if (pixels <= HD)
		return (threads <= 2 ? 640 : 896 * Math.max(1, threads / 4)) * MiB;
	return (
		(1088 + Math.max(0, threads - 1) * 640) * MiB * Math.max(1, pixels / UHD)
	);
}

export function planLocalResources(
	resources: LocalResources,
	pair: ResourcePair,
	options: LocalResourceOptions,
	pairCount: number,
): LocalResourcePlan {
	for (const n of [options.concurrency, options.threads])
		if (n !== undefined && (!Number.isSafeInteger(n) || n <= 0))
			throw new ResourceUnavailableError("estimate");
	const units = Math.max(1, pairCount);
	if (resources.budgetBytes === undefined) {
		if (options.threads === undefined || options.concurrency === undefined)
			throw new ResourceUnavailableError("unknown");
		return {
			threads: options.threads,
			concurrency: Math.min(units, options.concurrency),
			estimatedBytes: 0,
			exclusive: false,
			manualFallback: true,
		};
	}
	const frameCount = estimatedFrames(pair);
	const pixels = Math.max(
		pair.reference.width * pair.reference.height,
		pair.distorted.width * pair.distorted.height,
	);
	const calibrated =
		[pair.reference, pair.distorted].every(
			(video) =>
				video.bitDepth === 8 &&
				video.chromaFactor === 1 &&
				video.codec === "h264",
		) &&
		pair.model === "vmaf_v0.6.1" &&
		!pair.psnr &&
		!pair.measurementMethod &&
		pixels <= UHD;
	const depth = Math.max(
		pair.reference.bitDepth ?? 16,
		pair.distorted.bitDepth ?? 16,
		pair.measurementMethod ? 10 : 8,
	);
	const chroma = Math.max(
		pair.reference.chromaFactor ?? 2,
		pair.distorted.chromaFactor ?? 2,
	);
	const estimate = (threads: number) => {
		const bytes =
			workingMemory(pixels, threads) * Math.ceil(depth / 8) * chroma +
			frameCount * 2048;
		return Math.ceil(bytes / (64 * MiB)) * 64 * MiB;
	};
	const cpu = Math.max(1, Math.floor(resources.cpuCapacity));
	const ceiling = calibrated ? (pixels <= HD ? 4 : 2) : 1;
	let threads =
		options.threads ??
		Math.max(
			1,
			Math.min(ceiling, Math.floor(cpu / (options.concurrency ?? 1))),
		);
	if (options.threads === undefined)
		while (threads > 1 && estimate(threads) > resources.budgetBytes) threads--;
	const minimumBytes = estimate(threads);
	if (
		!Number.isSafeInteger(minimumBytes) ||
		minimumBytes > resources.budgetBytes
	)
		throw new ResourceUnavailableError("estimate");
	const exclusive = !calibrated;
	const estimatedBytes = minimumBytes;
	const automaticConcurrency = exclusive
		? 1
		: Math.max(
				1,
				Math.min(
					Math.floor(cpu / threads),
					Math.floor(resources.budgetBytes / estimatedBytes),
				),
			);
	return {
		threads,
		concurrency: Math.min(units, options.concurrency ?? automaticConcurrency),
		estimatedBytes,
		frameCount,
		exclusive,
		manualFallback: false,
		decoderThreads: 2,
		filterComplexThreads: 1,
	};
}
