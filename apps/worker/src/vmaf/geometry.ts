/**
 * Reference geometry, read off ffprobe — shared by BOTH VMAF runners.
 *
 * libvmaf requires its two inputs to agree on W×H *and* frame rate, so every
 * scoring path has to conform the distorted side to the reference before the
 * comparison. The VOD runner has done that since its first commit; the LIVE
 * runner did not, and the paid re-audit measured the cost:
 * only the rendition that happened to match the source geometry (1080p) ever
 * produced a result, and 720/540/360p ERRORed on the mismatch.
 *
 * These three helpers were private to `processor.ts` when only one caller
 * existed. They are here — verbatim — rather than re-derived in the live
 * runner, because a second copy of "what does ffprobe call the frame rate"
 * is exactly how the two paths drift apart again.
 */

/** Reference video geometry libvmaf conforms the distorted side to. */
export type Geometry = { width: number; height: number; fps?: number };

/** ffprobe -show_streams JSON, narrowed to the fields we read. */
type ProbeJson = {
	streams?: {
		codec_type?: string;
		width?: number;
		height?: number;
		r_frame_rate?: string;
		avg_frame_rate?: string;
		pix_fmt?: unknown;
	}[];
};

/** "30000/1001" → 29.97; bare "30" → 30; "0/0"/absent → undefined. */
export function parseFrameRate(raw: string | undefined): number | undefined {
	if (!raw) {
		return undefined;
	}
	if (raw.includes("/")) {
		const [n, d] = raw.split("/");
		const num = Number(n);
		const den = Number(d);
		if (
			Number.isFinite(num) &&
			Number.isFinite(den) &&
			den !== 0 &&
			num !== 0
		) {
			return num / den;
		}
		return undefined;
	}
	const v = Number(raw);
	return Number.isFinite(v) && v > 0 ? v : undefined;
}

/** First video stream's W×H + frame rate from ffprobe JSON. */
export function geometryFromProbe(stdout: string): Geometry {
	let parsed: ProbeJson;
	try {
		parsed = JSON.parse(stdout) as ProbeJson;
	} catch {
		throw new Error("ffprobe produced no parseable JSON output");
	}
	const video = (parsed.streams ?? []).find((s) => s.codec_type === "video");
	if (!video?.width || !video.height) {
		throw new Error("ffprobe reported no video stream with dimensions");
	}
	const fps =
		parseFrameRate(video.r_frame_rate) ?? parseFrameRate(video.avg_frame_rate);
	return {
		width: video.width,
		height: video.height,
		...(fps !== undefined ? { fps } : {}),
	};
}

/**
 * First video stream of ffprobe JSON with the fields as ffprobe names them;
 * `undefined` when there is no output, or none that holds a video stream.
 */
export function videoStreamFromProbe(
	stdout: string | undefined,
): Record<string, unknown> | undefined {
	if (stdout === undefined) return undefined;
	try {
		return ((JSON.parse(stdout) as ProbeJson).streams ?? []).find(
			(s) => s.codec_type === "video",
		);
	} catch {
		return undefined;
	}
}

/**
 * First video stream's pixel format from ffprobe JSON, by ffprobe's name for
 * it; `undefined` when the output names none.
 */
export function pixelFormatFromProbe(
	stdout: string | undefined,
): string | undefined {
	if (stdout === undefined) return undefined;
	try {
		const video = ((JSON.parse(stdout) as ProbeJson).streams ?? []).find(
			(s) => s.codec_type === "video",
		);
		return typeof video?.pix_fmt === "string" ? video.pix_fmt : undefined;
	} catch {
		return undefined;
	}
}
