import { z } from "zod";

/**
 *  — the LOOP TIMELINE of a pseudo-live source: what the feeder
 * actually pushes, period and holes included.
 *
 * The aligner and the aligned-reference build used to take the loop period
 * from the SOURCE's video frame count. The feeder loops the CONTAINER
 * timeline (`-stream_loop -1 … -c copy`), so a source whose video starts
 * late (video `start_time` 1.0 s, audio 0.01 s) loops every 10.04 s while its
 * video holds 9.03 s of frames: the encoder fills the video-less second by
 * repeating a frame, the pushed period is ≈301 frames at 30 fps, and an
 * aligner assuming 271 slips a second per loop — the  collapse
 * (means 12–50, harmonic 0, a third of the frames scored 0).
 *
 * Two ways to know the timeline: the feeder's NORMALIZED profile (a CFR,
 * pts-0, co-terminous intermediate — no holes, F = D × fps exactly), or, for
 * a session without one, a probe of the container the feeder looped (period
 * = container duration; holes = the video-less head and tail). Frames that
 * fall in a hole have no true reference and must never be scored.
 */
export const LOOP_PROFILE_VERSION = 1;

/** The loop's frame rate when no ingest reference pins one: the live encoder's default and the VMAF signature grid. */
export const DEFAULT_LOOP_FPS = 30;

/** Persisted by the feeder on `FeederSession.loopProfile` after normalization. */
export const loopProfileSchema = z.object({
	version: z.literal(LOOP_PROFILE_VERSION),
	mode: z.literal("normalized"),
	/** Frames per second of the intermediate — the signature grid the VMAF side must use. */
	fps: z.number().positive(),
	/** F: video frames per loop. */
	frames: z.number().int().positive(),
	/** D: seconds per loop — `frames / fps`, within half a frame. */
	loopSeconds: z.number().positive(),
	/**
	 * Where the audio ends (seconds) in the probe's edit-list view; the pushed
	 * packets (edit list ignored) end one AAC frame later. The normalizer keeps
	 * it at or before `loopSeconds`, within two AAC frames. Nothing reads it yet.
	 */
	audioEndSec: z.number().nonnegative(),
	/** The bytes that were normalized . */
	sourceSha256: z.string().min(1),
	normalizer: z.object({ version: z.literal(1) }),
	/**
	 * The ingest-reference pins the normalizer encoded with (geometry, rate,
	 * x264 profile token, audio rate/channels) — enough for the VMAF side to
	 * rebuild the same loop from the same source when the spool copy is gone.
	 * Absent when the feeder had no reference to pin to.
	 */
	normalise: z
		.object({
			width: z.number().int().positive().optional(),
			height: z.number().int().positive().optional(),
			frameRate: z.number().positive().optional(),
			sampleRate: z.number().int().positive().optional(),
			channels: z.number().int().positive().optional(),
			profile: z.string().min(1).optional(),
		})
		.optional(),
	recordedAt: z.string().datetime(),
});
export type LoopProfile = z.infer<typeof loopProfileSchema>;

/** A run of source frames `[fromFrame, toFrame)` with no true reference (the video-less part of a loop). */
export type LoopHole = { fromFrame: number; toFrame: number };

export type LoopTimeline = {
	source: "feeder-profile" | "container-probe";
	fps: number;
	/** F — the pushed period in frames. */
	frames: number;
	/** D — the pushed period in seconds. */
	loopSeconds: number;
	/** Non-overlapping, ascending, inside [0, F). Empty for a normalized profile. */
	holes: LoopHole[];
};

/** Half a frame is the tolerance for "frames and seconds describe the same period". */
const PERIOD_TOLERANCE_FRAMES = 0.5;

/** The timeline of a normalized session: exact period, no holes. */
export function timelineFromProfile(profile: LoopProfile): LoopTimeline {
	const mismatch = Math.abs(profile.frames - profile.loopSeconds * profile.fps);
	if (mismatch > PERIOD_TOLERANCE_FRAMES) {
		throw new Error(
			`loop profile is inconsistent: ${profile.frames} frames but ${profile.loopSeconds} s × ${profile.fps} fps`,
		);
	}
	return {
		source: "feeder-profile",
		fps: profile.fps,
		frames: profile.frames,
		loopSeconds: profile.loopSeconds,
		holes: [],
	};
}

/** What a container probe says about the file the feeder looped (seconds, from ffprobe). */
export type ContainerLoopProbe = {
	/** `format.duration` — the span `-stream_loop` repeats. */
	durationSec: number;
	/**
	 * Where the video starts RELATIVE to the container start:
	 * `video.start_time − format.start_time` (rev427 re-review R2). An MP4's
	 * format start is ≈ 0 so this is the stream's own start_time; an MPEG-TS
	 * source starts both at ≈ 1.4 s and has no hole. A small negative value
	 * (a negative CTS offset, ≈ −1/fps) is a legitimate shape and reads as 0.
	 */
	videoStartSec: number;
	/** The video stream's duration (frames ÷ frame rate). */
	videoDurationSec: number;
};

/**
 * The timeline of a session that pushed the raw container (no profile): the
 * period is the container's duration and the video-less head and tail are
 * holes. Rounded to the fps grid — a 10.04 s container at 30 fps is 301
 * frames, of which the first 30 (a 1.0 s video start) have no reference.
 */
export function timelineFromContainerProbe(
	probe: ContainerLoopProbe,
	fps: number,
): LoopTimeline {
	if (!(fps > 0) || !Number.isFinite(fps)) {
		throw new Error(
			`timelineFromContainerProbe: fps must be positive (${fps})`,
		);
	}
	if (!(probe.durationSec > 0) || !Number.isFinite(probe.durationSec)) {
		throw new Error(
			`timelineFromContainerProbe: container duration must be positive (${probe.durationSec})`,
		);
	}
	// rev427 R2: an absent ffprobe field arrives as NaN, and NaN comparisons
	// are all false — a silent "no holes" is the  assumption again.
	if (!Number.isFinite(probe.videoStartSec) || probe.videoStartSec < -1 / fps) {
		throw new Error(
			`timelineFromContainerProbe: video start must be a finite number no earlier than a frame before the container (${probe.videoStartSec})`,
		);
	}
	const videoStartSec = Math.max(0, probe.videoStartSec);
	if (!Number.isFinite(probe.videoDurationSec) || probe.videoDurationSec < 0) {
		throw new Error(
			`timelineFromContainerProbe: video duration must be a finite non-negative number (${probe.videoDurationSec})`,
		);
	}
	// A container shorter than its own video (by more than a frame) is a probe
	// that contradicts itself; a period built on it would truncate the video.
	if (videoStartSec + probe.videoDurationSec > probe.durationSec + 1 / fps) {
		throw new Error(
			`timelineFromContainerProbe: the video (${videoStartSec} s + ${probe.videoDurationSec} s) outruns the container (${probe.durationSec} s)`,
		);
	}
	const frames = Math.max(1, Math.round(probe.durationSec * fps));
	const clamp = (n: number, lo: number, hi: number) =>
		n < lo ? lo : n > hi ? hi : n;
	const videoStart = clamp(Math.round(videoStartSec * fps), 0, frames);
	const videoEnd = clamp(
		Math.round((videoStartSec + probe.videoDurationSec) * fps),
		videoStart,
		frames,
	);
	const holes: LoopHole[] = [];
	if (videoStart > 0) {
		holes.push({ fromFrame: 0, toFrame: videoStart });
	}
	if (videoEnd < frames) {
		holes.push({ fromFrame: videoEnd, toFrame: frames });
	}
	return {
		source: "container-probe",
		fps,
		frames,
		loopSeconds: probe.durationSec,
		holes,
	};
}

/** Is source frame `index` (in [0, F)) inside a hole? */
export function isMaskedSourceFrame(
	timeline: LoopTimeline,
	index: number,
): boolean {
	for (const hole of timeline.holes) {
		if (index >= hole.fromFrame && index < hole.toFrame) {
			return true;
		}
	}
	return false;
}

/** Per SOURCE frame: true where the frame has no reference — the aligner's `mask`. */
export function sourceMaskOf(timeline: LoopTimeline): boolean[] {
	const mask = new Array<boolean>(timeline.frames).fill(false);
	for (const hole of timeline.holes) {
		for (let i = hole.fromFrame; i < hole.toFrame && i < timeline.frames; i++) {
			mask[i] = true;
		}
	}
	return mask;
}

/**
 * Per OUTPUT frame of a captured window: true where `(i + offset) mod F` lands
 * in a hole — the frames to keep out of pooling once the offset is known.
 */
export function maskedOutputFrames(
	timeline: LoopTimeline,
	offset: number,
	windowFrames: number,
): boolean[] {
	const f = timeline.frames;
	const count = Math.max(0, Math.floor(windowFrames));
	const out = new Array<boolean>(count);
	for (let i = 0; i < count; i++) {
		out[i] = isMaskedSourceFrame(timeline, (((i + offset) % f) + f) % f);
	}
	return out;
}

/**
 * Below this autocorrelation a lag is not THE period. The true period repeats
 * the same content (NCC ≈ 1 modulo encoder noise); a lag near a multiple of a
 * dominant component of the content correlates too, but far less — a sum of
 * sines reaches ≈0.6 at such a lag, real video less. 0.9 keeps only identity.
 */
const PERIOD_PEAK_MIN_NCC = 0.9;

/**
 * Cross-check of the period from the OUTPUT alone: the lag in
 * `[around − radius, around + radius]` whose autocorrelation of the distorted
 * signature is highest, or null when no lag in the range correlates (peak
 * below `PERIOD_PEAK_MIN_NCC`, 0.9) or the window cannot hold two full
 * periods for EVERY lag in the range (rev427 R3: a truncated range would
 * otherwise return its own edge as the period). A 301-frame push read with a
 * 271-frame assumption is caught here even before the aligner runs — the
 * second instrument, so a wrong timeline is a WARNING with a number, not a
 * silent collapse.
 *
 * Contract for callers: a multiple of the true period correlates just as
 * well (2F is a period too), and content that repeats inside a loop has a
 * divisor as a true period — compare by divisibility, not equality, and keep
 * `radius` below `around` when 2F must stay out of range.
 */
export function estimatePeriodFrames(
	distorted: readonly number[],
	around: number,
	radius: number,
): number | null {
	const w = distorted.length;
	const lo = Math.max(1, Math.floor(around - radius));
	const hi = Math.floor(around + radius);
	if (hi < lo || w < 2 * hi) {
		return null;
	}
	let bestLag: number | null = null;
	let bestNcc = PERIOD_PEAK_MIN_NCC;
	for (let lag = lo; lag <= hi; lag++) {
		const n = w - lag;
		let meanA = 0;
		let meanB = 0;
		for (let i = 0; i < n; i++) {
			meanA += distorted[i] as number;
			meanB += distorted[i + lag] as number;
		}
		meanA /= n;
		meanB /= n;
		let dot = 0;
		let ea = 0;
		let eb = 0;
		for (let i = 0; i < n; i++) {
			const a = (distorted[i] as number) - meanA;
			const b = (distorted[i + lag] as number) - meanB;
			dot += a * b;
			ea += a * a;
			eb += b * b;
		}
		const denom = Math.sqrt(ea * eb);
		const ncc = denom === 0 ? 0 : dot / denom;
		if (ncc > bestNcc) {
			bestNcc = ncc;
			bestLag = lag;
		}
	}
	return bestLag;
}
