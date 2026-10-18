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
