/**
 * Media attributes of a live ingest and of a candidate file, and the
 * attribute-by-attribute comparison between them.
 *
 * Moved here from `apps/worker/src/feeder/command.ts`  so the
 * web routes can run the same comparison the worker runs: the direct slate
 * registration path (`POST /api/live-channels/[id]/insertable-content`)
 * had no check at all, while the scheduled-source path had one — and the
 * two must agree on the rule, so the rule lives in the one package both
 * import. The worker re-exports every symbol from its old location, so its
 * consumers are unchanged.
 *
 * The comparison is a DATA TABLE (`VIDEO_CHECKS` / `AUDIO_CHECKS`), one row
 * per attribute, each naming how to read the attribute off both sides and
 * when two readings count as the same. Consumers decide which differences
 * BLOCK: the feeder by what its push can normalise away, the slate gate by
 * `SLATE_BLOCKING_ATTRIBUTES` in `slate-compat.ts`.
 *
 * Conservative on every row: an attribute missing on EITHER side is never a
 * difference. References come from two instruments with different
 * vocabularies — an ffprobe-derived reference (profile, level, pixel format)
 * and Bitmovin's heartbeat (resolution, frame rate, channel count and nothing
 * else) — and a gate that treated "the other instrument cannot see this" as a
 * mismatch would refuse every switch on a heartbeat-derived reference.
 */

// ---------------------------------------------------------------------------
// ffprobe JSON (subset)
// ---------------------------------------------------------------------------

export type ProbeStream = {
	codec_type?: string;
	codec_name?: string;
	profile?: string;
	/**
	 * H.264 level as ffprobe reports it: an INTEGER ten times the dotted
	 * form (4.1 → 41), which is also how the Bitmovin heartbeat prints it in
	 * the attribute-change warning that preceded the 2026-08-29 disconnect.
	 */
	level?: number;
	pix_fmt?: string;
	width?: number;
	height?: number;
	/**
	 * Frame rate, as the two RATIONALS ffprobe emits — never a decimal.
	 * `r_frame_rate` is the base rate the container declares, `avg_frame_rate`
	 * the measured average; NTSC rates are exactly `30000/1001`, which is why
	 * the diff text keeps the fraction alongside the parsed number.
	 */
	r_frame_rate?: string;
	avg_frame_rate?: string;
	sample_rate?: string;
	channels?: number;
	/** : stream timing as ffprobe prints it (decimal seconds / integer), read by the feeder's normalizer. */
	start_time?: string;
	duration?: string;
	nb_frames?: string;
	/**
	 * ffprobe's stream disposition. Only `attached_pic` is read: cover art in
	 * an audio file types as `codec_type: "video"`, so without this an
	 * audio-only MP3/M4A with album art satisfies a video+audio plan.
	 */
	disposition?: { attached_pic?: number };
};

export type ProbeResult = {
	streams?: ProbeStream[];
	format?: { duration?: string; format_name?: string; start_time?: string };
};

// ---------------------------------------------------------------------------
// Attributes
// ---------------------------------------------------------------------------

export type VideoAttributes = {
	codec?: string;
	width?: number;
	height?: number;
	/** Frames per second (29.97002997… for the NTSC rational). */
	frameRate?: number;
	/** ffprobe's own rational, kept verbatim for the operator-facing diff. */
	frameRateText?: string;
	profile?: string;
	/** Ten times the dotted form, as ffprobe and the heartbeat both report. */
	level?: number;
	pixelFormat?: string;
};

export type AudioAttributes = {
	codec?: string;
	sampleRate?: number;
	channels?: number;
};

export type MediaAttributes = {
	video?: VideoAttributes;
	/** Audio streams, in the order they will reach the encoder. */
	audio: AudioAttributes[];
};

/** One attribute that differs between a reference and a candidate. */
export type MediaDifference = {
	/** Operator-facing attribute name — one of `MEDIA_ATTRIBUTE`'s values. */
	attribute: MediaAttributeName;
	reference: string;
	candidate: string;
};

/**
 * The attribute NAMES, as constants: `normalisedAttributes` in the feeder
 * and `SLATE_BLOCKING_ATTRIBUTES` in the slate gate key on these strings,
 * and a renamed row that the consumers did not follow would silently turn a
 * blocking difference into a reported one.
 */
export const MEDIA_ATTRIBUTE = {
	videoStream: "video stream",
	videoCodec: "video codec",
	resolution: "resolution",
	frameRate: "frame rate",
	h264Profile: "H.264 profile",
	h264Level: "H.264 level",
	pixelFormat: "pixel format",
	audioStreams: "audio streams",
	audioCodec: "audio codec",
	audioSampleRate: "audio sample rate",
	audioChannels: "audio channels",
} as const;
export type MediaAttributeName =
	(typeof MEDIA_ATTRIBUTE)[keyof typeof MEDIA_ATTRIBUTE];

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

/**
 * ffprobe reports frame rate ONLY as a rational string (`30000/1001`,
 * `24/1`), and `0/0` for streams that have none. Parsing it is what makes a
 * numeric comparison possible at all — and the fraction is kept beside the
 * number because `29.97` and `30000/1001` are the same rate, but only one of
 * them is what the operator will read in Bitmovin's own warning.
 */
export function parseFrameRate(value: string | undefined): number | undefined {
	if (typeof value !== "string" || value.length === 0) {
		return undefined;
	}
	const [numText, denText] = value.split("/");
	const num = Number.parseFloat(numText ?? "");
	// A bare decimal (`24`) is not what ffprobe emits, but a hand-written
	// fixture or another prober may; treat a missing denominator as 1.
	const den = denText === undefined ? 1 : Number.parseFloat(denText);
	if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0 || num <= 0) {
		return undefined;
	}
	return num / den;
}

/** `29.97` / `24` — trimmed for the diff text and for ffmpeg's `-r`. */
export function formatFrameRate(fps: number): string {
	return Number.isInteger(fps) ? String(fps) : fps.toFixed(2);
}

/**
 * Two frame rates are the SAME rate when they agree to a hundredth of a
 * frame: `r_frame_rate` and `avg_frame_rate` disagree in the last digits on
 * almost every real file, and the heartbeat rounds. A tolerance here is the
 * difference between a gate and a false-refusal generator.
 */
export const FRAME_RATE_EPSILON = 0.01;

/**
 * 8-bit 4:2:0 under two names. ffmpeg tags full-range content `yuvj420p`; it
 * is the same chroma layout the copy path already accepts, so treating them
 * as different pixel formats would refuse switches the encoder handles.
 */
const PIXEL_FORMAT_ALIASES: Record<string, string> = {
	yuvj420p: "yuv420p",
};

export function canonicalPixelFormat(
	value: string | undefined,
): string | undefined {
	return value === undefined
		? undefined
		: (PIXEL_FORMAT_ALIASES[value] ?? value);
}

/**
 * Video streams ffmpeg's default selection would actually push. ffprobe types
 * embedded COVER ART as `codec_type: "video"` with `disposition.attached_pic
 * = 1`; counting it as video makes an audio-only file look like it has video
 * and a real video file look like it has two.
 */
export function pushableVideoStreams(streams: ProbeStream[]): ProbeStream[] {
	return streams.filter(
		(s) => s.codec_type === "video" && s.disposition?.attached_pic !== 1,
	);
}

/** The media attributes of the FILE, straight off ffprobe. */
export function sourceMediaAttributes(probe: ProbeResult): MediaAttributes {
	const streams = probe.streams ?? [];
	const video = pushableVideoStreams(streams)[0];
	const audio = streams.filter((s) => s.codec_type === "audio");
	const frameRateText = video?.r_frame_rate ?? video?.avg_frame_rate;
	const frameRate = parseFrameRate(frameRateText);
	return {
		...(video
			? {
					video: {
						...(video.codec_name !== undefined
							? { codec: video.codec_name }
							: {}),
						...(video.width !== undefined ? { width: video.width } : {}),
						...(video.height !== undefined ? { height: video.height } : {}),
						...(frameRate !== undefined ? { frameRate } : {}),
						...(frameRate !== undefined && frameRateText !== undefined
							? { frameRateText }
							: {}),
						...(video.profile !== undefined ? { profile: video.profile } : {}),
						...(video.level !== undefined ? { level: video.level } : {}),
						...(video.pix_fmt !== undefined
							? { pixelFormat: video.pix_fmt }
							: {}),
					},
				}
			: {}),
		audio: audio.map((a) => {
			const sampleRate = Number.parseInt(a.sample_rate ?? "", 10);
			return {
				...(a.codec_name !== undefined ? { codec: a.codec_name } : {}),
				...(Number.isFinite(sampleRate) && sampleRate > 0
					? { sampleRate }
					: {}),
				...(a.channels !== undefined ? { channels: a.channels } : {}),
			};
		}),
	};
}

/**
 * Codec tokens adopted VERBATIM from a heartbeat stream. The persisted samples
 * carry ffprobe's own lowercase names (`aac` on every audio stream of the
 * owner's 116 runs, rev406 — not the SDK enum's `AAC`/`H264` this reader once
 * assumed), so a token that IS an ffprobe name compares directly against the
 * clip's probe. Anything else — an uppercase enum, a label ffprobe would not
 * print — is dropped: no opinion, never a mapping that could invent a refusal.
 */
const HEARTBEAT_CODEC_TOKENS: ReadonlySet<string> = new Set([
	"h264",
	"hevc",
	"av1",
	"vp9",
	"aac",
	"ac3",
	"eac3",
	"mp3",
	"mp2",
	"opus",
]);

/**
 * `audioChannelFormat` → channel count, for the samples where
 * `numberOfAudioChannels` is null (all 116 of the owner's runs, rev406). Only
 * unambiguous labels are mapped; anything else stays unknown.
 */
const AUDIO_CHANNEL_FORMATS: Record<string, number> = {
	mono: 1,
	stereo: 2,
	"5.1": 6,
	"7.1": 8,
};

/** Below this a `rate` is a frame rate; at or above it, a sample rate. */
const MIN_AUDIO_SAMPLE_RATE = 8000;

/**
 * The encoder's OWN word on what it is ingesting, read off a persisted
 * heartbeat sample (`{ at, raw: { ingest: { streams } } }` — the worker's
 * `PersistedHeartbeat` wrapper).
 *
 * What a REAL sample carries (owner DB, 116 runs, read for rev406 — the
 * earlier docblock had this inverted): the video stream has width, height and
 * `rate` (frame rate); the audio stream has `rate` too, and there it is the
 * SAMPLE RATE (`rate: 48000`, 73 runs), plus `codec: "aac"` in ffprobe's own
 * lowercase vocabulary, while `numberOfAudioChannels` was null in every run.
 * Reading only channels off the audio stream left the sample rate invisible,
 * so a 44.1 kHz clip against this 48 kHz ingest compared "OK" — the exact
 * mismatch the 2026-09-02 A/B measured as the cause.
 *
 * Still narrower than the ffprobe-derived reference: no profile, level or
 * pixel format. The comparison skips whatever is missing, and the verdict
 * names what was compared (`compared`) and what could not be
 * (`notComparable`), so an "OK" on this reference never reads as "everything
 * matched".
 */
export function heartbeatIngestMedia(sample: unknown): MediaAttributes | null {
	if (typeof sample !== "object" || sample === null) {
		return null;
	}
	const raw = (sample as { raw?: unknown }).raw;
	if (typeof raw !== "object" || raw === null) {
		return null;
	}
	const ingest = (raw as { ingest?: { streams?: unknown } }).ingest;
	const streams = ingest?.streams;
	if (!Array.isArray(streams) || streams.length === 0) {
		return null;
	}
	let video: VideoAttributes | undefined;
	const audio: AudioAttributes[] = [];
	for (const entry of streams) {
		if (typeof entry !== "object" || entry === null) {
			continue;
		}
		const stream = entry as Record<string, unknown>;
		const mediaType =
			typeof stream.mediaType === "string"
				? stream.mediaType.toLowerCase()
				: undefined;
		const width = typeof stream.width === "number" ? stream.width : undefined;
		const height =
			typeof stream.height === "number" ? stream.height : undefined;
		const rate =
			typeof stream.rate === "number" && stream.rate > 0
				? stream.rate
				: undefined;
		const codecToken =
			typeof stream.codec === "string" &&
			HEARTBEAT_CODEC_TOKENS.has(stream.codec.trim().toLowerCase())
				? stream.codec.trim().toLowerCase()
				: undefined;
		const channelCount =
			typeof stream.numberOfAudioChannels === "number"
				? stream.numberOfAudioChannels
				: typeof stream.audioChannelFormat === "string"
					? AUDIO_CHANNEL_FORMATS[
							stream.audioChannelFormat.trim().toLowerCase()
						]
					: undefined;
		const isVideo =
			mediaType === "video" ||
			(mediaType === undefined &&
				(width !== undefined || height !== undefined));
		// An untyped stream with no geometry and an audio-shaped rate or a
		// channel count is an audio stream; a heartbeat that omits `mediaType`
		// must not lose its audio to the type guard.
		const isAudio =
			mediaType === "audio" ||
			(mediaType === undefined &&
				!isVideo &&
				(channelCount !== undefined ||
					(rate !== undefined && rate >= MIN_AUDIO_SAMPLE_RATE)));
		if (isVideo) {
			if (video !== undefined) {
				continue;
			}
			video = {
				...(codecToken !== undefined ? { codec: codecToken } : {}),
				...(width !== undefined ? { width } : {}),
				...(height !== undefined ? { height } : {}),
				...(rate !== undefined && rate < MIN_AUDIO_SAMPLE_RATE
					? { frameRate: rate }
					: {}),
			};
			continue;
		}
		if (isAudio) {
			audio.push({
				...(codecToken !== undefined ? { codec: codecToken } : {}),
				...(rate !== undefined && rate >= MIN_AUDIO_SAMPLE_RATE
					? { sampleRate: rate }
					: {}),
				...(channelCount !== undefined ? { channels: channelCount } : {}),
			});
		}
	}
	if (video === undefined && audio.length === 0) {
		return null;
	}
	return { ...(video ? { video } : {}), audio };
}

/**
 * Re-read a persisted `MediaAttributes` blob (a `LiveChannelRun.ingestMedia`
 * column) without trusting it: the column is JSON, so a hand-edited or
 * older-shape row must degrade to "no reference" rather than to a comparison
 * against garbage.
 */
export function parseMediaAttributes(value: unknown): MediaAttributes | null {
	if (typeof value !== "object" || value === null) {
		return null;
	}
	const record = value as { video?: unknown; audio?: unknown };
	if (!Array.isArray(record.audio)) {
		return null;
	}
	const video =
		typeof record.video === "object" && record.video !== null
			? (record.video as VideoAttributes)
			: undefined;
	const audio = record.audio.filter(
		(a): a is AudioAttributes => typeof a === "object" && a !== null,
	);
	if (video === undefined && audio.length === 0) {
		return null;
	}
	return { ...(video ? { video } : {}), audio };
}

// ---------------------------------------------------------------------------
// The comparison table
// ---------------------------------------------------------------------------

/** A reading of one attribute: the value compared and the text shown. */
type Reading = { value: string | number; text: string };

type AttributeCheck<T> = {
	attribute: MediaAttributeName;
	/** `undefined` when the side does not carry the attribute — then no check. */
	read(side: T): Reading | undefined;
	/** Defaults to strict equality of `value`. */
	same?(reference: Reading, candidate: Reading): boolean;
};

const VIDEO_CHECKS: readonly AttributeCheck<VideoAttributes>[] = [
	{
		attribute: MEDIA_ATTRIBUTE.videoCodec,
		read: (v) =>
			v.codec === undefined ? undefined : { value: v.codec, text: v.codec },
	},
	{
		attribute: MEDIA_ATTRIBUTE.resolution,
		read: (v) =>
			v.width === undefined || v.height === undefined
				? undefined
				: { value: `${v.width}×${v.height}`, text: `${v.width}×${v.height}` },
	},
	{
		attribute: MEDIA_ATTRIBUTE.frameRate,
		read: (v) =>
			v.frameRate === undefined
				? undefined
				: {
						value: v.frameRate,
						text: v.frameRateText ?? formatFrameRate(v.frameRate),
					},
		same: (a, b) =>
			Math.abs(Number(a.value) - Number(b.value)) <= FRAME_RATE_EPSILON,
	},
	{
		attribute: MEDIA_ATTRIBUTE.h264Profile,
		read: (v) =>
			v.profile === undefined
				? undefined
				: { value: v.profile.trim().toLowerCase(), text: v.profile },
	},
	{
		attribute: MEDIA_ATTRIBUTE.h264Level,
		read: (v) =>
			v.level === undefined
				? undefined
				: { value: v.level, text: String(v.level) },
	},
	{
		attribute: MEDIA_ATTRIBUTE.pixelFormat,
		read: (v) => {
			const canonical = canonicalPixelFormat(v.pixelFormat);
			return canonical === undefined
				? undefined
				: { value: canonical, text: v.pixelFormat ?? canonical };
		},
	},
];

const AUDIO_CHECKS: readonly AttributeCheck<AudioAttributes>[] = [
	{
		attribute: MEDIA_ATTRIBUTE.audioCodec,
		read: (a) =>
			a.codec === undefined ? undefined : { value: a.codec, text: a.codec },
	},
	{
		attribute: MEDIA_ATTRIBUTE.audioSampleRate,
		read: (a) =>
			a.sampleRate === undefined
				? undefined
				: { value: a.sampleRate, text: `${a.sampleRate} Hz` },
	},
	{
		attribute: MEDIA_ATTRIBUTE.audioChannels,
		read: (a) =>
			a.channels === undefined
				? undefined
				: { value: a.channels, text: String(a.channels) },
	},
];

/** Every attribute name the table can emit, in emission order. */
export const MEDIA_ATTRIBUTE_NAMES: readonly MediaAttributeName[] = [
	MEDIA_ATTRIBUTE.videoStream,
	...VIDEO_CHECKS.map((c) => c.attribute),
	MEDIA_ATTRIBUTE.audioStreams,
	...AUDIO_CHECKS.map((c) => c.attribute),
];

/**
 * What an evaluation could and could not compare, beside what differed. An
 * attribute is `compared` when BOTH sides carried it (a difference or an
 * agreement); `notComparable` when either side did not — the honest half of
 * a verdict, because a heartbeat-derived reference knows nothing of profile,
 * level or pixel format, and a verdict that only listed differences read as
 * "everything matched" (rev406 R1).
 */
export type MediaEvaluation = {
	differences: MediaDifference[];
	compared: MediaAttributeName[];
	notComparable: MediaAttributeName[];
};

function runChecks<T>(
	checks: readonly AttributeCheck<T>[],
	reference: T,
	candidate: T,
	out: MediaEvaluation,
): void {
	for (const check of checks) {
		const ref = check.read(reference);
		const cand = check.read(candidate);
		if (ref === undefined || cand === undefined) {
			out.notComparable.push(check.attribute);
			continue;
		}
		out.compared.push(check.attribute);
		const same = check.same ? check.same(ref, cand) : ref.value === cand.value;
		if (!same) {
			out.differences.push({
				attribute: check.attribute,
				reference: ref.text,
				candidate: cand.text,
			});
		}
	}
}

function dedupe(names: MediaAttributeName[]): MediaAttributeName[] {
	return [...new Set(names)];
}

/**
 * Evaluate a candidate against a reference: every measurable difference, in
 * table order, plus which attributes were compared at all. Says nothing about
 * which differences matter — that is the caller's rule.
 *
 * Stream COUNT, not just attributes: Bitmovin's own contract for content
 * played into a live stream is "the number of audio streams must also be the
 * same" (SDK `InsertableContent`). BIDIRECTIONAL, because "the same" is. The
 * one asymmetry is the GUARD: a reference reporting ZERO audio streams says
 * nothing (a heartbeat sample lists what the encoder chose to report), so it
 * is skipped — and every audio attribute is then NOT comparable — rather than
 * read as "this encoder has no audio".
 */
export function evaluateMediaAttributes(
	reference: MediaAttributes,
	candidate: MediaAttributes,
): MediaEvaluation {
	const out: MediaEvaluation = {
		differences: [],
		compared: [],
		notComparable: [],
	};
	const ref = reference.video;
	const cand = candidate.video;
	if (ref === undefined) {
		out.notComparable.push(
			MEDIA_ATTRIBUTE.videoStream,
			...VIDEO_CHECKS.map((c) => c.attribute),
		);
	} else if (cand === undefined) {
		// Not an attribute change but the absence of the stream itself.
		out.compared.push(MEDIA_ATTRIBUTE.videoStream);
		out.notComparable.push(...VIDEO_CHECKS.map((c) => c.attribute));
		out.differences.push({
			attribute: MEDIA_ATTRIBUTE.videoStream,
			reference: "present",
			candidate: "absent",
		});
	} else {
		out.compared.push(MEDIA_ATTRIBUTE.videoStream);
		runChecks(VIDEO_CHECKS, ref, cand, out);
	}
	if (reference.audio.length === 0) {
		out.notComparable.push(
			MEDIA_ATTRIBUTE.audioStreams,
			...AUDIO_CHECKS.map((c) => c.attribute),
		);
	} else {
		out.compared.push(MEDIA_ATTRIBUTE.audioStreams);
		if (candidate.audio.length !== reference.audio.length) {
			out.differences.push({
				attribute: MEDIA_ATTRIBUTE.audioStreams,
				reference: String(reference.audio.length),
				candidate: String(candidate.audio.length),
			});
		}
		const pairs = Math.min(reference.audio.length, candidate.audio.length);
		if (pairs === 0) {
			out.notComparable.push(...AUDIO_CHECKS.map((c) => c.attribute));
		}
		for (let i = 0; i < pairs; i += 1) {
			runChecks(
				AUDIO_CHECKS,
				reference.audio[i] as AudioAttributes,
				candidate.audio[i] as AudioAttributes,
				out,
			);
		}
	}
	const compared = dedupe(out.compared);
	return {
		differences: out.differences,
		compared,
		// An attribute compared on one audio pair and missing on another is
		// compared; only attributes compared nowhere are not comparable.
		notComparable: dedupe(out.notComparable).filter(
			(name) => !compared.includes(name),
		),
	};
}

/** The differences alone — the feeder's gate maps them through its pins. */
export function compareMediaAttributes(
	reference: MediaAttributes,
	candidate: MediaAttributes,
): MediaDifference[] {
	return evaluateMediaAttributes(reference, candidate).differences;
}

/**
 * One line per attribute: `frame rate 30000/1001 → 24/1`. A difference the
 * caller marked NON-blocking carries a planned re-encoding suffix. The
 * comparison happens before transcoding, so it must not claim completion.
 */
export function describeMediaDifferences(
	differences: readonly (Omit<MediaDifference, "attribute"> & {
		attribute: string;
		blocking?: boolean;
	})[],
): string {
	return differences
		.map(
			(d) =>
				`${d.attribute} ${d.reference} → ${d.candidate}${
					d.blocking === false ? " (will be re-encoded to match)" : ""
				}`,
		)
		.join("\n");
}
