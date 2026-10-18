import {
	type AudioAttributes,
	canonicalPixelFormat,
	compareMediaAttributes,
	describeMediaDifferences,
	formatFrameRate,
	heartbeatIngestMedia,
	LIVE_AUDIO_CODECS,
	LIVE_VIDEO_CODECS,
	LOOP_PROFILE_VERSION,
	type LoopProfile,
	loopProfileSchema,
	MEDIA_ATTRIBUTE,
	type MediaAttributes,
	type MediaDifference,
	type ProbeResult,
	type ProbeStream,
	parseFrameRate,
	parseMediaAttributes,
	pushableVideoStreams,
	REDACTED,
	sourceMediaAttributes,
	type VideoAttributes,
} from "@bitovp/core";

/**
 * The probe shapes, the media-attribute types and the attribute comparison
 * table moved to `@bitovp/core` (`live/media-attributes.ts`) so the web
 * routes can run the same check the slate registration path runs (C36).
 * Re-exported from here VERBATIM so every worker consumer keeps its import.
 */
export {
	type AudioAttributes,
	formatFrameRate,
	heartbeatIngestMedia,
	type MediaAttributes,
	type ProbeResult,
	type ProbeStream,
	parseFrameRate,
	parseMediaAttributes,
	pushableVideoStreams,
	sourceMediaAttributes,
	type VideoAttributes,
};

/**
 * Pure ffmpeg/ffprobe command construction for the pseudo-live feeder
 * (P3-PR3). No process interaction here — the supervisor spawns whatever
 * this module builds, so every shape is unit-testable without ffmpeg.
 *
 * Redaction discipline: `buildFeederCommand` returns BOTH the spawnable
 * argv and a redactedArgv with the SRT passphrase and the RTMP stream key
 * masked. Only redactedArgv may ever be logged or persisted; the secrets
 * additionally feed the log-line scrubber (`buildLineRedactor`) so ffmpeg
 * echoing its own output URL onto stderr cannot leak them into the tail.
 */

// ---------------------------------------------------------------------------
// ffprobe
// ---------------------------------------------------------------------------

/** ffprobe argv (binary resolved separately via FFPROBE_PATH). */
export function probeArgs(sourcePath: string): string[] {
	return [
		"-v",
		"error",
		"-print_format",
		"json",
		"-show_streams",
		"-show_format",
		sourcePath,
	];
}

export function parseProbeJson(stdout: string): ProbeResult {
	try {
		const parsed = JSON.parse(stdout) as ProbeResult;
		return typeof parsed === "object" && parsed !== null ? parsed : {};
	} catch {
		throw new Error("ffprobe produced no parseable JSON output");
	}
}

/** Container duration in seconds, if ffprobe reported one. */
export function sourceDurationSec(probe: ProbeResult): number | undefined {
	const raw = probe.format?.duration;
	if (typeof raw !== "string") {
		return undefined;
	}
	const parsed = Number.parseFloat(raw);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

// ---------------------------------------------------------------------------
// Copy vs transcode decision
// ---------------------------------------------------------------------------

export type CodecDecision = {
	mode: "copy" | "transcode" | "transcode-audio";
	/** Human-readable reasons, logged into the session tail. */
	reasons: string[];
};

/**
 * Copy rule (the shared contract gotcha: "copy codecs when ingest-compatible,
 * transcode fallback"): `-c copy` only when the source already matches
 * what the Bitmovin live ingest expects from RTMP/SRT —
 *   - exactly one H264 video stream in 8-bit 4:2:0 (yuv420p / yuvj420p;
 *     High 10 / 4:2:2 / 4:4:4 profiles break FLV and most ingests), and
 *   - every audio stream is AAC (FLV cannot carry most other codecs and
 *     the encoder expects AAC from the feeder).
 * Everything else falls back to the libx264/aac transcode below. The
 * decision is data-driven from ffprobe JSON so the table tests pin it.
 */
export function decideCodecMode(
	probe: ProbeResult,
	/**
	 * Output protocol (review-227 I3): the channel-count refusal is an
	 * RTMP/FLV concern — MPEG-TS over SRT carries multichannel audio
	 * natively, so an SRT feed keeps its layout. Defaults to RTMP for
	 * callers that predate the parameter.
	 */
	protocol: "RTMP" | "SRT_CALLER" = "RTMP",
): CodecDecision {
	const reasons: string[] = [];
	const audioOnlyReasons: string[] = [];
	const streams = probe.streams ?? [];
	const video = pushableVideoStreams(streams);
	const audio = streams.filter((s) => s.codec_type === "audio");

	if (video.length !== 1) {
		reasons.push(
			video.length === 0
				? "no video stream in source"
				: `source has ${video.length} video streams (need exactly 1 to copy)`,
		);
	} else {
		const v = video[0];
		if (v?.codec_name !== "h264") {
			reasons.push(`video codec ${v?.codec_name ?? "unknown"} is not h264`);
		}
		if (v?.pix_fmt === undefined) {
			// ffprobe reported no pixel format: the copy contract is VERIFIED
			// 8-bit 4:2:0, so unknown counts as non-copyable (a High-10 source
			// slipping through -c copy breaks the ingest mid-push).
			reasons.push("pixel format unknown — cannot verify 8-bit 4:2:0");
		} else if (v.pix_fmt !== "yuv420p" && v.pix_fmt !== "yuvj420p") {
			reasons.push(`pixel format ${v.pix_fmt} is not 8-bit 4:2:0`);
		}
	}
	for (const a of audio) {
		if (a.codec_name !== "aac") {
			reasons.push(`audio codec ${a.codec_name ?? "unknown"} is not aac`);
		}
		//  (leading hypothesis, see RTMP_STEREO_ARGS): >2-channel
		// audio must not ride FLV — but this is an AUDIO nonconformance, so
		// it accumulates separately: alone it selects the video-copying
		// audio-downmix mode, never the full transcode (review-227 I2 — the
		// full transcode measured 0.998x real-time on 1080p, a cure worse
		// than the disease when only the audio needs fixing). `undefined`
		// channels stays copyable — the LENIENT direction, opposite of
		// pix_fmt's strict default above, because ffprobe reliably reports
		// `channels` for audio streams (review-227 measured) while pix_fmt
		// absence genuinely occurs and hides bit-depth (review-227 S2).
		if (protocol === "RTMP" && a.channels !== undefined && a.channels > 2) {
			audioOnlyReasons.push(
				`audio has ${a.channels} channels — RTMP/FLV ingest is the never-binds class for >stereo, downmixing audio only`,
			);
		}
	}

	if (reasons.length === 0 && audioOnlyReasons.length > 0) {
		return { mode: "transcode-audio", reasons: audioOnlyReasons };
	}
	return reasons.length === 0
		? { mode: "copy", reasons: ["h264 + aac within ingest constraints"] }
		: { mode: "transcode", reasons: [...reasons, ...audioOnlyReasons] };
}

// ---------------------------------------------------------------------------
// Command builder
// ---------------------------------------------------------------------------

export type FeederTarget =
	| {
			protocol: "RTMP";
			/** Base ingest URL incl. app, e.g. rtmp://1.2.3.4/live */
			url: string;
			/** Ledgered connection-routing material (see FeederSession.target). */
			streamKey: string;
	  }
	| {
			protocol: "SRT_CALLER";
			host: string;
			port: number;
			/** Resolved from the vault at spawn — never persisted. */
			passphrase?: string;
	  };

export type BuildCommandInput = {
	/** Local spool path of the downloaded source MP4. */
	sourcePath: string;
	decision: CodecDecision;
	target: FeederTarget;
	/**
	 * : when the run is ALREADY ingesting something, a transcoding
	 * push must land on those exact attributes — a live encoder binds its
	 * input format once and treats a mid-run change as a fault (measured
	 * 2026-08-29: frame rate 30000/1001 → 24/1, profile 77 → 100, resolution
	 * 1920x1080 → 1920x1012, then DISCONNECTED). Absent on the first push of
	 * a run, where there is nothing to match.
	 */
	normalise?: IngestNormalisation;
};

export type BuiltCommand = {
	/** Spawnable args (no binary; spawn(FFMPEG_PATH, argv)). */
	argv: string[];
	/** The ONLY form that may be logged/persisted (secrets masked). */
	redactedArgv: string[];
};

/**
 * Live-sane transcode fallback: 2s-ish GOP without scene-cut keyframes
 * (stable segmenting), 8-bit 4:2:0, capped VBV so the push bitrate stays
 * bounded, 48 kHz AAC. veryfast keeps a single feeder core sufficient.
 */
const TRANSCODE_VIDEO_ARGS = [
	"-c:v",
	"libx264",
	"-preset",
	"veryfast",
	//  hypothesis 2 (the A/B refuted 5.1 — stereo transcode still
	// never bound while copy binds 4/4): the transcode's STARTUP TRICKLE.
	// libx264 at veryfast buffers rc_lookahead=10 (~25–30 frames incl.
	// frame-thread delay — review-229 measured; an earlier "~40" here was
	// asserted) before the first packet, and the cold encoder ramps 6→24fps
	// over ~20s (both unbound runs' logs; review-229 confirmed the ramp is
	// REAL, not an averaging artefact — only the plain-transcode arm shows
	// the rising signature and this tune removes it). NOTE (review-229 I1):
	// zerolatency moves FIVE x264 params at once (bframes 3→0,
	// rc_lookahead 0, sliced_threads on, mbtree off, thread split) — run 4
	// tests the BUNDLE; a bind does not attribute the win to one of them.
	"-tune",
	"zerolatency",
	"-pix_fmt",
	"yuv420p",
	"-g",
	"60",
	"-sc_threshold",
	"0",
	"-b:v",
	"4500k",
	"-maxrate",
	"5000k",
	"-bufsize",
	"10000k",
] as const;

/**
 * The audio half of both transcoding modes, WITHOUT `-ar`: the sample rate is
 * composed in by `audioArgs` so it can lock onto the run's reference instead
 * of the 48 kHz default . Splitting the constant — rather than
 * appending an override — matters because ffmpeg keeps one dictionary entry
 * per option name for an output file, so a second `-ar` silently wins and the
 * logged argv would show two contradicting values.
 */
const TRANSCODE_AUDIO_ARGS = ["-c:a", "aac", "-b:a", "128k"] as const;

/** Push sample rate when nothing says otherwise (the pre-#239 constant). */
export const DEFAULT_PUSH_SAMPLE_RATE = 48_000;

/**
 * : RTMP outputs force STEREO. The leading hypothesis (review-227
 * I1's calibration: a hypothesis until the single-variable re-run, because
 * the recorded arms confound codec-mode/channels/file/load, and #46's b01
 * proves never-binds has other causes too) for the two unbound transcode
 * pushes is 5.1 AAC in FLV — accepted at the TCP level, never bound. This
 * rides ONLY the RTMP/FLV branch: MPEG-TS over SRT carries 5.1 natively and
 * downmixing there would be destruction with a false justification
 * (review-227 I3).
 */
const RTMP_STEREO_ARGS = ["-ac", "2"] as const;

/**
 *  / review-227 I2: when the ONLY thing keeping a source off the
 * copy path is its channel count, re-encoding the VIDEO to fix an AUDIO
 * nonconformance is the wrong trade — the full transcode measured 0.998x
 * real-time on 1080p (row 95), while video-copy + audio-downmix is ~32×
 * cheaper (review-227 measured both with real ffmpeg). Video rides through
 * untouched; audio is re-encoded to stereo AAC.
 */
const AUDIO_ONLY_TRANSCODE_VIDEO_ARGS = ["-c:v", "copy"] as const;

/** Characters that would break ffmpeg's (non-unescaping) SRT query parsing. */
const SRT_URL_UNSAFE = /[&?/#%\s]/;

/**
 * The audio half of a transcoding command, with the sample rate (and, when a
 * reference exists, the channel count) composed in rather than appended.
 */
function audioArgs(normalise: IngestNormalisation | undefined): string[] {
	const args = [
		...TRANSCODE_AUDIO_ARGS,
		"-ar",
		String(normalise?.sampleRate ?? DEFAULT_PUSH_SAMPLE_RATE),
	];
	if (normalise?.channels !== undefined) {
		args.push("-ac", String(normalise.channels));
	}
	return args;
}

/**
 * The video half of the full transcode, plus the geometry the encoder must
 * keep seeing. `-s` / `-r` / `-profile:v` are emitted ONLY when a reference
 * exists : with no reference there is nothing to match and the
 * argv stays byte-identical to the pre-#239 command.
 */
function videoArgs(normalise: IngestNormalisation | undefined): string[] {
	const args: string[] = [...TRANSCODE_VIDEO_ARGS];
	if (normalise?.width !== undefined && normalise.height !== undefined) {
		args.push("-s", `${normalise.width}x${normalise.height}`);
	}
	if (normalise?.frameRate !== undefined) {
		args.push("-r", formatFrameRate(normalise.frameRate));
	}
	if (normalise?.profile !== undefined) {
		args.push("-profile:v", normalise.profile);
	}
	return args;
}

export function buildFeederCommand(input: BuildCommandInput): BuiltCommand {
	const { sourcePath, decision, target } = input;
	// review-#239: normalisation is meaningless under `-c copy` — nothing is
	// re-encoded, so the flags would be silently ignored and the argv would
	// claim a guarantee the command cannot make.
	const normalise = decision.mode === "copy" ? undefined : input.normalise;

	const head = [
		"-hide_banner",
		"-nostdin",
		// -re (realtime pacing) and infinite -stream_loop must precede -i.
		"-re",
		// : the normalized loop's AAC delay frame sits at a NEGATIVE
		// pts under the mp4 edit list, and -stream_loop's per-play offset is
		// max(pts + duration) - min(pts) over both streams — honouring the list stretched
		// every play by one audio frame (1024/ar s, measured as 811 conformed
		// frames for 3 × 270). Ignoring it makes the period exactly frames/fps;
		// the normalizer pre-trimmed 1024 samples so sync stays exact. The
		// argument leans on the normalizer's `-tune zerolatency` (no B-frames,
		// so the loop carries no VIDEO edit list); `normalize-ffmpeg.test.ts`
		// pins the packet steps, so a return of B-frames would fail there.
		"-ignore_editlist",
		"1",
		"-stream_loop",
		"-1",
		"-i",
		sourcePath,
	];
	const codec =
		decision.mode === "copy"
			? ["-c", "copy"]
			: decision.mode === "transcode-audio"
				? [...AUDIO_ONLY_TRANSCODE_VIDEO_ARGS, ...audioArgs(normalise)]
				: [...videoArgs(normalise), ...audioArgs(normalise)];
	// Progress key=value blocks ride stdout; the human log stays on stderr.
	const progress = ["-progress", "pipe:1"];

	if (target.protocol === "RTMP") {
		const base = target.url.replace(/\/+$/, "");
		// #99: stereo enforcement is FLV-scoped; audio-affecting modes get it,
		// -c copy cannot re-layout (the decision already refused >2ch there).
		// #239: a reference already fixed `-ac` to what the encoder is bound
		// to (never above 2 on RTMP, because the reference itself was pushed
		// through this same cap) — appending a second `-ac` would override it.
		const stereo =
			decision.mode === "copy" || normalise?.channels !== undefined
				? []
				: [...RTMP_STEREO_ARGS];
		const out = [...head, ...codec, ...stereo, ...progress, "-f", "flv"];
		return {
			argv: [...out, `${base}/${target.streamKey}`],
			redactedArgv: [...out, `${base}/${REDACTED}`],
		};
	}

	// SRT caller → Bitmovin listener (the shared contract gotcha). The passphrase rides
	// the URL query (libsrt does not unescape, so unsafe characters are a
	// hard error rather than a silently-broken handshake); pbkeylen derives
	// from the vault rule 16 chars ↔ AES-128 / 32 chars ↔ AES-256 — any
	// other length is a hard error (tripwire against vault-rule drift: a
	// silent pbkeylen=32 for a 20-char passphrase would handshake-fail or,
	// worse, downgrade the cipher the operator believes is in use).
	let query = "mode=caller";
	let redactedQuery = query;
	if (target.passphrase !== undefined) {
		if (SRT_URL_UNSAFE.test(target.passphrase)) {
			throw new Error(
				"SRT passphrase contains characters unsafe for URL transport (&?/#% or whitespace) — rotate the vaulted passphrase",
			);
		}
		const pbkeylen =
			target.passphrase.length === 16
				? 16
				: target.passphrase.length === 32
					? 32
					: undefined;
		if (pbkeylen === undefined) {
			throw new Error(
				`SRT passphrase must be exactly 16 (AES-128) or 32 (AES-256) characters, got ${target.passphrase.length} — the vault rule drifted; rotate the vaulted passphrase`,
			);
		}
		query += `&passphrase=${target.passphrase}&pbkeylen=${pbkeylen}`;
		redactedQuery += `&passphrase=${REDACTED}&pbkeylen=${pbkeylen}`;
	}
	const out = [...head, ...codec, ...progress, "-f", "mpegts"];
	return {
		argv: [...out, `srt://${target.host}:${target.port}?${query}`],
		redactedArgv: [
			...out,
			`srt://${target.host}:${target.port}?${redactedQuery}`,
		],
	};
}

// ---------------------------------------------------------------------------
// Log-line scrubbing
// ---------------------------------------------------------------------------

/**
 * Returns a scrubber that masks every known secret literal (plus a generic
 * passphrase=… belt-and-braces) in a log line BEFORE it enters the ring
 * buffer — ffmpeg prints its output URL verbatim on stderr, so the tail
 * would otherwise leak the SRT passphrase / RTMP stream key.
 */
export function buildLineRedactor(
	secrets: (string | undefined)[],
): (line: string) => string {
	const literals = secrets.filter(
		(s): s is string => typeof s === "string" && s.length > 0,
	);
	return (line: string) => {
		let out = line;
		for (const literal of literals) {
			out = out.split(literal).join(REDACTED);
		}
		return out.replace(/(passphrase=)[^&\s'"]+/gi, `$1${REDACTED}`);
	};
}

// ---------------------------------------------------------------------------
// Ingest preflight
// ---------------------------------------------------------------------------

/** What media type a declared ingest position expects, and why we think so. */
export type IngestExpectation = {
	key: string;
	position: number;
	media: "video" | "audio" | "unknown";
};

/**
 * Work out the media type each declared ingest position expects, from the
 * renditions that reference it.
 *
 * A live plan's `ingest` entries carry only `{key, inputPath, position}` — the
 * key is an arbitrary ref, so "audio" is a naming convention, not a type. The
 * renditions are where the type actually lives: each names an `ingestKey` and
 * a codec, and the encoder's own video/audio split (LIVE_*_CODECS, shared from
 * core rather than copied) turns that into the media type the encoder will
 * look for at that stream index.
 *
 * A position no rendition references is `unknown` and never fails the check —
 * this preflight refuses only what it can prove wrong.
 */
export function expectedIngestMedia(
	ingest: { key: string; position: number }[],
	renditions: { ingestKey?: string; codec?: string }[],
): IngestExpectation[] {
	return ingest.map((entry) => {
		let media: IngestExpectation["media"] = "unknown";
		for (const rendition of renditions) {
			if (rendition.ingestKey !== entry.key || !rendition.codec) {
				continue;
			}
			if (LIVE_VIDEO_CODECS.has(rendition.codec)) {
				media = "video";
				break;
			}
			if (LIVE_AUDIO_CODECS.has(rendition.codec)) {
				media = "audio";
				break;
			}
		}
		return { key: entry.key, position: entry.position, media };
	});
}

/**
 * Refuse a source whose streams cannot satisfy the channel's declared ingest.
 *
 * Measured 2026-08-15 : a redundant-RTMP channel declaring video
 * and audio was fed `b01.mov`, which carries h264 and a `tmcd` TIMECODE track
 * and no audio at all. ffmpeg completed the RTMP handshake, the session
 * reported PUSHING, Bitmovin held the ingest at WAITING_FOR_FIRST_CONNECT and
 * closed after ~36s, and the channel published nothing. Every layer that had a
 * status showed a good one.
 *
 * The check is by PRESENCE of each media type, deliberately not by stream
 * index — and the first version got that wrong. `buildFeederCommand` emits no
 * `-map`, so ffmpeg applies DEFAULT STREAM SELECTION: one best video plus one
 * best audio, chosen by quality and independent of position, with data streams
 * like `tmcd` never pushed at all. Indexing the SOURCE layout therefore
 * compared the wrong two things, and refused `[video, tmcd, audio]` — a
 * commonplace broadcast MOV, the same file family as the incident but WITH
 * audio — even though ffmpeg would have pushed video+audio and the channel
 * would have worked (two independent reviews caught this, each by running it).
 *
 * What the plan asks for that default selection genuinely cannot deliver is
 * a SECOND position of the same media type: one video and one audio is all
 * that gets pushed, whatever the source holds. That is now refused by name
 * rather than passing silently.
 *
 * Conservative by construction: a position no rendition references is
 * `unknown` and never fails, and a channel with no readable plan is not
 * checked at all.
 */
export function checkSourceSatisfiesIngest(
	probe: ProbeResult,
	expectations: IngestExpectation[],
): { ok: true } | { ok: false; reason: string } {
	const streams = probe.streams ?? [];
	const problems: string[] = [];

	for (const media of ["video", "audio"] as const) {
		const wanted = expectations.filter((e) => e.media === media);
		if (wanted.length === 0) {
			continue;
		}
		const have =
			media === "video"
				? pushableVideoStreams(streams).length
				: streams.filter((s) => s.codec_type === media).length;
		if (have === 0) {
			const present =
				streams
					.map((s) => s.codec_type ?? "untyped")
					.filter((t, i, all) => all.indexOf(t) === i)
					.join(", ") || "no streams at all";
			problems.push(
				`ingest ${wanted.map((w) => `"${w.key}"`).join(" and ")} needs ${media}, but the source carries ${present}`,
			);
			continue;
		}
		// DISTINCT POSITIONS, not expectation count: two ingest entries reading
		// the SAME position (a ladder and a thumbnail both off stream 0) are
		// both served by the one pushed stream, and refusing them was a false
		// refusal the positional version did not make (review-final). Two
		// entries on DIFFERENT positions — a second language track — genuinely
		// cannot be served, and is still refused by name.
		const positions = new Set(wanted.map((w) => w.position));
		if (positions.size > 1) {
			problems.push(
				`the plan declares ${positions.size} ${media} ingests (${wanted.map((w) => `"${w.key}"`).join(", ")}), but the feeder pushes a single ${media} stream`,
			);
		}
	}

	if (problems.length === 0) {
		return { ok: true };
	}
	// : the operator-facing wrapper prose ("Source cannot satisfy the
	// channel's ingest: … The encoder would accept the connection and publish
	// nothing.") is safety copy and now lives in the i18n catalogue
	// (`feederError.ingestUnsatisfied`). This returns only the DYNAMIC problem
	// detail; the caller stamps it into that code's `detail` param so the panel
	// can translate the sentence around it.
	return {
		ok: false,
		reason: problems.join("; "),
	};
}

// ---------------------------------------------------------------------------
// Source compatibility gate
// ---------------------------------------------------------------------------

/**
 * A live encoding binds its INPUT FORMAT once.
 *
 * Measured 2026-08-29 (paid A/B, audit §3.2): a channel started on an
 * H264 Main / yuv420p / 1920x1080 / 29.97 fps source and switched, at air
 * time, to H264 High / 1920x1012 / 24 fps. Every layer reported success —
 * the schedule FIRED, the new feeder reached PUSHING in 2.1s, the child
 * playlist kept advancing — while Bitmovin's heartbeat warned on frame rate
 * `30000/1001 → 24/1`, profile `77 → 100`, level `41 → 40` and resolution
 * `1920x1080 → 1920x1012`, then DISCONNECTED the ingest. Two extracted PNGs
 * minutes apart hashed IDENTICALLY: the picture had frozen on the OLD input.
 * The control arm — a source matching the first one attribute for attribute —
 * switched with no warning at all and the picture changed.
 *
 * Nothing in this module could have caught it: `ProbeStream` had no frame-rate
 * field at all, `decideCodecMode` reads only codec/pixel-format/channels
 * (which the incompatible source SATISFIED — it went down the copy path), and
 * `checkSourceSatisfiesIngest` compares media PRESENCE, not attributes.
 *
 * `MediaAttributes` (now in `@bitovp/core`, `live/media-attributes.ts`,
 * re-exported at the top of this file together with the comparison table) is
 * that missing comparison. It is deliberately "what the ENCODER sees", not
 * "what the file is": the feeder pushes through ffmpeg's default stream
 * selection and, in transcoding modes, re-encodes — so the file's attributes
 * and the wire's are different things, and only the latter can be compared
 * against what a run is already ingesting. What stays HERE is the feeder's
 * half: which differences a given push normalises away.
 */

/**
 * What a transcoding push must pin so the encoder keeps seeing what it bound
 * to. Every field is optional because the reference itself may be partial —
 * a heartbeat-derived reference knows resolution and frame rate but not
 * profile or sample rate, and pinning a value we do not have is worse than
 * not pinning it.
 */
export type IngestNormalisation = {
	width?: number;
	height?: number;
	frameRate?: number;
	sampleRate?: number;
	channels?: number;
	/** An x264 profile TOKEN (`baseline` | `main` | `high`), not ffprobe's. */
	profile?: string;
};

/** One attribute that differs between the run's ingest and a new source. */
export type SourceDifference = MediaDifference & {
	/**
	 * True when this push cannot fix the difference, so the encoder would see
	 * the change. False when the chosen codec mode normalises it away — the
	 * operator still gets to see it, because "your file is 720p and we are
	 * re-encoding it up" is information, not an error.
	 */
	blocking: boolean;
};

export type SourceCompatibility = {
	compatible: boolean;
	differences: SourceDifference[];
};

/**
 * ffprobe's H.264 profile names → the tokens libx264 accepts on
 * `-profile:v`. Only the 8-bit 4:2:0 family is mapped: everything the copy
 * path admits, plus what a transcode can actually produce. An unmapped
 * profile returns undefined, which is the honest answer — and it makes the
 * profile difference BLOCKING in transcode mode, because a push that cannot
 * pin the profile cannot promise it.
 */
const X264_PROFILE_TOKENS: Record<string, string> = {
	baseline: "baseline",
	"constrained baseline": "baseline",
	main: "main",
	high: "high",
};

export function x264ProfileToken(
	profile: string | undefined,
): string | undefined {
	return profile === undefined
		? undefined
		: X264_PROFILE_TOKENS[profile.trim().toLowerCase()];
}

/**
 * What the ENCODER will receive if we push this source in this mode.
 *
 * Two transformations, both of them things the file itself cannot tell you:
 *  - `buildFeederCommand` emits no `-map`, so ffmpeg's DEFAULT STREAM
 *    SELECTION pushes one best video and one best audio however many the
 *    file holds (the same fact `checkSourceSatisfiesIngest` is built on);
 *  - the transcoding modes REPLACE attributes — libx264/yuv420p, AAC at the
 *    normalised sample rate, RTMP's stereo cap.
 *
 * Comparing files instead of wires would refuse a 3-language mezzanine that
 * pushes exactly one audio track, and would accept a 5.1 source that FLV
 * downmixes to the stereo the encoder is already bound to.
 */
export function pushedMediaAttributes(
	source: MediaAttributes,
	decision: CodecDecision,
	protocol: "RTMP" | "SRT_CALLER",
	normalise?: IngestNormalisation,
): MediaAttributes {
	const firstAudio = source.audio[0];
	if (decision.mode === "copy") {
		return {
			...(source.video ? { video: source.video } : {}),
			audio: firstAudio ? [firstAudio] : [],
		};
	}
	const pushedChannels =
		normalise?.channels ??
		(firstAudio?.channels === undefined
			? undefined
			: protocol === "RTMP"
				? Math.min(firstAudio.channels, 2)
				: firstAudio.channels);
	const pushedAudio: AudioAttributes[] = firstAudio
		? [
				{
					codec: "aac",
					sampleRate: normalise?.sampleRate ?? DEFAULT_PUSH_SAMPLE_RATE,
					...(pushedChannels === undefined ? {} : { channels: pushedChannels }),
				},
			]
		: [];
	if (decision.mode === "transcode-audio") {
		// Video rides through untouched (`-c:v copy`).
		return {
			...(source.video ? { video: source.video } : {}),
			audio: pushedAudio,
		};
	}
	const video = source.video;
	if (video === undefined) {
		return { audio: pushedAudio };
	}
	const width = normalise?.width ?? video.width;
	const height = normalise?.height ?? video.height;
	const frameRate = normalise?.frameRate ?? video.frameRate;
	// The profile falls back to the SOURCE'S, exactly like its siblings above,
	// and the reason is worth stating because the first cut got it wrong (PR
	// #352 BLOCKER). Every caller that judges compatibility asks this function
	// for the candidate WITHOUT pins — pins are what the answer decides — so a
	// field that appears only when pinned is undefined on every real check,
	// and `compareSourceCompatibility` skips any attribute missing on either
	// side. The profile branch therefore never evaluated: a run bound to an
	// unpinnable profile accepted any profile at all, which is the one case
	// the unpinnable rule exists for.
	//
	// Unpinned, x264 picks its own profile rather than the source's, so this
	// value is not a prediction of the wire — it is the only statement about
	// the candidate a comparison can be made against, and it is the safe one:
	// where it differs from the reference the difference is BLOCKING (the
	// reference had no x264 token, or `normalisedAttributes` would have
	// absorbed it), which is the correct verdict for an attribute the command
	// cannot guarantee.
	const profile = normalise?.profile ?? video.profile;
	return {
		video: {
			codec: "h264",
			...(width !== undefined ? { width } : {}),
			...(height !== undefined ? { height } : {}),
			...(frameRate !== undefined ? { frameRate } : {}),
			// TRANSCODE_VIDEO_ARGS pins the pixel format unconditionally.
			pixelFormat: "yuv420p",
			...(profile !== undefined ? { profile } : {}),
		},
		audio: pushedAudio,
	};
}

/**
 * Which attributes this push can NORMALISE — i.e. differences it absorbs
 * before the encoder ever sees them.
 *
 * The rule is not "does the mode re-encode this" but "does the command land
 * on the REFERENCE'S OWN VALUE", and the difference between those two
 * questions is a false accept. A transcode always emits libx264 into
 * `yuv420p` at whatever `normalise` pins: against a run bound to 10-bit
 * 4:2:0 that is a pixel-format CHANGE, not a match, and the first cut of
 * this function called it absorbed because "transcode re-encodes the pixel
 * format" was true in the wrong sense. So each attribute is derived from
 * what the argv will actually produce, checked against the reference:
 *
 *  - `-c:v libx264` / `-c:a aac` match only an h264 / aac reference;
 *  - `-pix_fmt yuv420p` matches only an 8-bit 4:2:0 reference;
 *  - `-s` / `-r` / `-ar` / `-ac` match only when `normalise` actually
 *    carries the reference's value (RTMP's #99 stereo cap is why `-ac` can
 *    fail to: a 6-channel reference cannot be matched over FLV);
 *  - `-profile:v` only when the reference profile mapped to an x264 token.
 *
 * `copy` normalises nothing by construction: `-c copy` hands the encoder the
 * source's own bitstream, which is exactly why the 2026-08-29 incident got
 * through (the incompatible source was h264/yuv420p, so it took the copy
 * path). `transcode-audio` re-encodes only audio; its video rides `-c:v
 * copy` untouched.
 *
 * LEVEL is the one attribute a transcode reports but does not pin. x264
 * DERIVES the level from the geometry, frame rate and bitrate — all of which
 * the normalisation has already fixed to the reference — while `-level`
 * makes the encode FAIL outright when the constraints do not fit. Blocking
 * on a value the push will in all likelihood match would refuse working
 * switches; it is reported instead, in the same list, marked non-blocking.
 */
function normalisedAttributes(
	mode: CodecDecision["mode"],
	reference: MediaAttributes,
	normalise: IngestNormalisation | undefined,
): ReadonlySet<string> {
	const set = new Set<string>();
	if (mode === "copy") {
		return set;
	}
	const refAudio = reference.audio[0];
	if (refAudio?.codec === "aac") {
		set.add(MEDIA_ATTRIBUTE.audioCodec);
	}
	if (
		refAudio?.sampleRate !== undefined &&
		normalise?.sampleRate === refAudio.sampleRate
	) {
		set.add(MEDIA_ATTRIBUTE.audioSampleRate);
	}
	if (
		refAudio?.channels !== undefined &&
		normalise?.channels === refAudio.channels
	) {
		set.add(MEDIA_ATTRIBUTE.audioChannels);
	}
	if (mode === "transcode-audio") {
		return set;
	}
	const video = reference.video;
	if (video?.codec === "h264") {
		set.add(MEDIA_ATTRIBUTE.videoCodec);
	}
	if (canonicalPixelFormat(video?.pixelFormat) === "yuv420p") {
		set.add(MEDIA_ATTRIBUTE.pixelFormat);
	}
	if (
		video?.width !== undefined &&
		video.height !== undefined &&
		normalise?.width === video.width &&
		normalise?.height === video.height
	) {
		set.add(MEDIA_ATTRIBUTE.resolution);
	}
	if (
		video?.frameRate !== undefined &&
		normalise?.frameRate === video.frameRate
	) {
		set.add(MEDIA_ATTRIBUTE.frameRate);
	}
	if (normalise?.profile !== undefined) {
		set.add(MEDIA_ATTRIBUTE.h264Profile);
	}
	set.add(MEDIA_ATTRIBUTE.h264Level);
	return set;
}

/**
 * Compare a candidate source against what the run is already ingesting.
 *
 * The attribute-by-attribute diff is the core table
 * (`compareMediaAttributes`, shared with the slate gate); what this adds is
 * the feeder's own question — which of those differences the chosen codec
 * mode NORMALISES away before the encoder sees them (`normalisedAttributes`).
 * A difference the push cannot land on the reference's own value is
 * BLOCKING; every other one is reported with `blocking: false`.
 */
export function compareSourceCompatibility(
	reference: MediaAttributes,
	candidate: MediaAttributes,
	mode: CodecDecision["mode"],
	/**
	 * The pins this push will actually carry (`normalisationTargets`). Absent
	 * means "nothing is pinned", so every re-encodable difference the command
	 * would not land on the reference stays BLOCKING — the conservative
	 * direction, and the only honest one for a caller that has no pins.
	 */
	normalise?: IngestNormalisation,
): SourceCompatibility {
	const normalises = normalisedAttributes(mode, reference, normalise);
	const differences: SourceDifference[] = compareMediaAttributes(
		reference,
		candidate,
	).map((d) => ({ ...d, blocking: !normalises.has(d.attribute) }));
	return {
		compatible: !differences.some((d) => d.blocking),
		differences,
	};
}

/** One line per attribute: `frame rate 30000/1001 → 24/1`. */
export function describeSourceDifferences(
	differences: SourceDifference[],
): string {
	return describeMediaDifferences(differences);
}

/**
 * What a transcoding push must pin so the encoder keeps seeing the reference.
 * Mirrors `normalisedAttributes` — anything claimed normalisable there has to
 * appear here, or the gate would pass a difference nothing actually fixes.
 */
export function normalisationTargets(
	reference: MediaAttributes,
	mode: CodecDecision["mode"],
	protocol: "RTMP" | "SRT_CALLER",
): IngestNormalisation | undefined {
	if (mode === "copy") {
		return undefined;
	}
	const audio = reference.audio[0];
	// #99's FLV stereo cap still wins over the reference. It cannot bite in
	// practice — a reference pushed over RTMP was itself capped — but a
	// heartbeat-derived reference is the encoder's word, not ours.
	const channels =
		audio?.channels === undefined
			? undefined
			: protocol === "RTMP"
				? Math.min(audio.channels, 2)
				: audio.channels;
	const video = mode === "transcode" ? reference.video : undefined;
	const profile = x264ProfileToken(video?.profile);
	const targets: IngestNormalisation = {
		...(video?.width !== undefined ? { width: video.width } : {}),
		...(video?.height !== undefined ? { height: video.height } : {}),
		...(video?.frameRate !== undefined ? { frameRate: video.frameRate } : {}),
		...(audio?.sampleRate !== undefined
			? { sampleRate: audio.sampleRate }
			: {}),
		...(channels !== undefined ? { channels } : {}),
		...(profile !== undefined ? { profile } : {}),
	};
	return Object.keys(targets).length > 0 ? targets : undefined;
}

// ---------------------------------------------------------------------------
//  (PR-C): the normalized loop
// ---------------------------------------------------------------------------

/** The intermediate the feeder loops instead of the raw source: `<spoolDir>/<sessionId>.loop.mp4` (the session id keeps the pid veto matching). */
export const NORMALIZED_SUFFIX = ".loop.mp4";
export function normalizedSpoolPath(
	spoolDir: string,
	sessionId: string,
): string {
	return `${spoolDir.replace(/\/+$/, "")}/${sessionId}${NORMALIZED_SUFFIX}`;
}

export type BuildNormalizeInput = {
	sourcePath: string;
	destPath: string;
	/** The signature grid the VMAF side reads: the loop's fps. */
	fps: number;
	protocol: "RTMP" | "SRT_CALLER";
	normalise?: IngestNormalisation;
	/** The video's start inside the container (seconds, relative to the container start). */
	videoStartSec: number;
	/** The video's duration (seconds). */
	videoDurationSec: number;
};

/** AAC-LC frames are 1024 samples; the normalizer's audio is cut on that grid. */
export const AAC_FRAME_SAMPLES = 1024;

/**
 * The audio the normalizer keeps: whole AAC frames, the largest count whose
 * packets all END by the last video frame's end. ffmpeg's `-stream_loop`
 * advances each play by `max(pkt.pts + duration) - min(pkt.pts)` over BOTH
 * streams (fftools/ffmpeg_demux.c `ts_fixup` / `seek_to_start`; measured on
 * ffmpeg 9: an audio packet ending 2.7 ms after the video stretched the
 * per-play offset by exactly that), so the encoder's delay frame plus
 * floor(D·ar/1024) − 1 frames of content end ≤ D on the packet grid and the
 * copy-looped period is exactly `frames / fps` (3 plays conform to 3·F
 * frames with one-frame packet steps throughout, `normalize-ffmpeg.test.ts`).
 * The audio therefore ends up to one AAC frame before the video, never after.
 */
export function normalizedAudioSamples(
	videoDurationSec: number,
	sampleRate: number,
): number {
	const wholeFrames = Math.floor(
		(videoDurationSec * sampleRate) / AAC_FRAME_SAMPLES,
	);
	return Math.max(0, wholeFrames - 1) * AAC_FRAME_SAMPLES;
}

/**
 * The one-off transcode that turns any source into a loop the encoder sees
 * exactly as the VMAF side models it : CFR at `fps`, video pts
 * from 0, audio inside the video span. The VIDEO SPAN is the loop —
 * `-ss <videoStart>` / `-t <videoDuration>` trim the container to it, so a
 * source whose video starts late loops without a frozen second (the
 * alternative, padding the head from t=0, pushes a still frame every
 * loop). `aresample=async=1:first_pts=0` re-times the audio from 0, `apad`
 * guarantees enough of it, and `atrim` cuts it on the AAC frame grid: the
 * first 1024 samples go because the AAC encoder's delay frame takes their
 * slot once the push ignores the edit list (`buildFeederCommand`), which
 * keeps audio and video sample-exact; the end is `normalizedAudioSamples`
 * so no audio packet ends after the last video frame and the copy-looped
 * period is exactly `frames / fps`. Video/audio codecs and rates are the
 * push transcode's own (`videoArgs`/`audioArgs`), so the push then runs in
 * `copy` mode against a loop the compatibility gate already accepts.
 */
export function buildNormalizeCommand(input: BuildNormalizeInput): string[] {
	const { normalise } = input;
	const stereo =
		input.protocol === "RTMP" && normalise?.channels === undefined
			? [...RTMP_STEREO_ARGS]
			: [];
	const sampleRate = normalise?.sampleRate ?? DEFAULT_PUSH_SAMPLE_RATE;
	const audioSamples = normalizedAudioSamples(
		input.videoDurationSec,
		sampleRate,
	);
	return [
		"-hide_banner",
		"-nostdin",
		"-v",
		"error",
		"-y",
		"-ss",
		input.videoStartSec.toFixed(6),
		"-i",
		input.sourcePath,
		"-t",
		input.videoDurationSec.toFixed(6),
		"-vf",
		`fps=${formatFrameRate(input.fps)},setpts=N/FRAME_RATE/TB`,
		"-af",
		`aresample=async=1:first_pts=0,apad,atrim=start_sample=${AAC_FRAME_SAMPLES}:end_sample=${AAC_FRAME_SAMPLES + audioSamples},asetpts=PTS-STARTPTS`,
		...videoArgs(normalise),
		...audioArgs(normalise),
		...stereo,
		"-movflags",
		"+faststart",
		"-f",
		"mp4",
		input.destPath,
	];
}

/**
 * Where the video sits inside the raw source: start relative to the
 * container and duration (seconds) — the span the normalizer cuts to.
 */
export function sourceVideoSpan(probe: ProbeResult): {
	videoStartSec: number;
	videoDurationSec: number;
} {
	const video = (probe.streams ?? []).find(
		(st) => st.codec_type === "video" && st.disposition?.attached_pic !== 1,
	);
	if (!video) {
		throw new Error("source has no video stream to normalize");
	}
	const containerStart = probeNumber(probe.format?.start_time) ?? 0;
	const videoStartSec = Math.max(
		0,
		(probeNumber(video.start_time) ?? containerStart) - containerStart,
	);
	const rate =
		parseFrameRate(video.r_frame_rate) ?? parseFrameRate(video.avg_frame_rate);
	const frames = probeNumber(video.nb_frames);
	const containerDuration = probeNumber(probe.format?.duration);
	const videoDurationSec =
		probeNumber(video.duration) ??
		(frames !== undefined && rate ? frames / rate : undefined) ??
		(containerDuration !== undefined
			? Math.max(0, containerDuration - videoStartSec)
			: undefined);
	if (videoDurationSec === undefined || videoDurationSec <= 0) {
		throw new Error("source reports no usable video duration to normalize");
	}
	return { videoStartSec, videoDurationSec };
}

function probeNumber(value: string | number | undefined): number | undefined {
	if (value === undefined) return undefined;
	const n = typeof value === "number" ? value : Number.parseFloat(value);
	return Number.isFinite(n) ? n : undefined;
}

/**
 * Reads the loop profile off the INTERMEDIATE's probe and refuses anything
 * the VMAF side could not model exactly: the video must start within a frame
 * of 0, so must the audio, and the audio must end within a frame of the
 * video (`|audioEnd − D| < 1/fps`; an AAC frame at 48 kHz is 21 ms, under a
 * 30 fps frame). F is the video's frame count, D = F / fps.
 */
export function loopProfileFromProbe(
	probe: ProbeResult,
	fps: number,
	sourceSha256: string,
	recordedAt: string,
	normalise?: IngestNormalisation,
): LoopProfile {
	const streams = probe.streams ?? [];
	const video = streams.find(
		(st) => st.codec_type === "video" && st.disposition?.attached_pic !== 1,
	);
	if (!video) {
		throw new Error("normalized loop has no video stream");
	}
	const frameTolerance = 1 / fps;
	const containerStart = probeNumber(probe.format?.start_time) ?? 0;
	const videoStart =
		(probeNumber(video.start_time) ?? containerStart) - containerStart;
	if (Math.abs(videoStart) >= frameTolerance) {
		throw new Error(
			`normalized loop's video starts at ${videoStart.toFixed(4)} s, not 0`,
		);
	}
	const rate =
		parseFrameRate(video.r_frame_rate) ?? parseFrameRate(video.avg_frame_rate);
	const frames =
		probeNumber(video.nb_frames) ??
		(probeNumber(video.duration) !== undefined && rate
			? Math.round((probeNumber(video.duration) as number) * rate)
			: undefined);
	if (frames === undefined || !Number.isInteger(frames) || frames < 1) {
		throw new Error("normalized loop reports no video frame count");
	}
	const loopSeconds = frames / fps;
	const audio = streams.find((st) => st.codec_type === "audio");
	let audioEndSec = loopSeconds;
	if (audio) {
		const audioStart =
			(probeNumber(audio.start_time) ?? containerStart) - containerStart;
		if (Math.abs(audioStart) >= frameTolerance) {
			throw new Error(
				`normalized loop's audio starts at ${audioStart.toFixed(4)} s, not 0`,
			);
		}
		const audioDuration = probeNumber(audio.duration);
		if (audioDuration === undefined) {
			throw new Error("normalized loop reports no audio duration");
		}
		audioEndSec = audioStart + audioDuration;
		// The normalizer cuts the audio on the AAC frame grid so that no packet
		// ends after the last video frame: the presentation may end up to two
		// AAC frames early, never a frame late (a late end stretches the loop).
		const sampleRate =
			probeNumber(audio.sample_rate) ?? DEFAULT_PUSH_SAMPLE_RATE;
		const earlyTolerance =
			(2 * AAC_FRAME_SAMPLES) / sampleRate + frameTolerance;
		if (
			audioEndSec - loopSeconds >= frameTolerance ||
			loopSeconds - audioEndSec >= earlyTolerance
		) {
			throw new Error(
				`normalized loop's audio ends at ${audioEndSec.toFixed(4)} s but the video loop is ${loopSeconds.toFixed(4)} s`,
			);
		}
	}
	return loopProfileSchema.parse({
		version: LOOP_PROFILE_VERSION,
		mode: "normalized",
		fps,
		frames,
		loopSeconds,
		audioEndSec,
		sourceSha256,
		normalizer: { version: 1 },
		// The pins the loop was encoded with, so the VMAF side can rebuild it
		// (`normalise` carries only the six the normalizer reads).
		...(normalise
			? {
					normalise: {
						...(normalise.width !== undefined
							? { width: normalise.width }
							: {}),
						...(normalise.height !== undefined
							? { height: normalise.height }
							: {}),
						...(normalise.frameRate !== undefined
							? { frameRate: normalise.frameRate }
							: {}),
						...(normalise.sampleRate !== undefined
							? { sampleRate: normalise.sampleRate }
							: {}),
						...(normalise.channels !== undefined
							? { channels: normalise.channels }
							: {}),
						...(normalise.profile !== undefined
							? { profile: normalise.profile }
							: {}),
					},
				}
			: {}),
		recordedAt,
	});
}
