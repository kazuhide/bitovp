import { type LiveChannelPlan, liveChannelPlanSchema } from "./schema";

/**
 * Startup-probe plan builder .
 *
 * A probe is a MINIMAL live plan — 1× H264 360p + AAC, RTMP input, one fMP4
 * muxing per stream + one HLS manifest (the schema's own floors: "no
 * manifests" was unbuildable) — provisioned through the NORMAL pipeline and
 * stopped the moment RUNNING is observed. It measures queue time, so the
 * ladder is deliberately tiny; the stat card says results reflect this
 * 1-rendition shape.
 *
 * Billing safety baked into the PLAN (not just the runner): a forced
 * `waitingForFirstConnectTimeoutMinutes: 30` makes the ENCODER shut itself
 * down cloud-side after 30 min with no input — a probe never connects an
 * input, so even a dead runner's probe self-terminates (#48's remedy, the
 * design's first billing control; the runner's abandon deadline and the sweep
 * reconciler are the second and third, tighter, controls). The value was 1
 * until a 2026-08-23 billed probe proved Bitmovin rejects the start at 1 with
 * code 1000; 30 is the smallest value the live corpus has observed accepted
 * .
 */
export const PROBE_OUTPUT_KEY = "probe-origin";

/**
 * How long the batch runner waits for a claimed stop to reach a terminal
 * state before reaping anyway. Shared so the UI's worst-case cost quote and
 * the runner enforce the SAME number (review-pr34 M5) — a quote computed
 * from a private copy drifts the first time the runner changes.
 */
export const PROBE_STOP_WAIT_MINUTES = 5;

/**
 * The encoder-side never-connected auto-shutdown, in minutes. Exported for the
 * SAME reason as PROBE_STOP_WAIT_MINUTES (review-pr34 M5): the operator's
 * worst-case cost quote must be computed from the value the plan actually
 * carries, not a private copy. A stranded probe (encoder up cloud-side, DB
 * never records RUNNING) bills until THIS fuse fires, not until the runner's
 * abandon deadline — so the quote's per-probe bound is
 * max(deadline + stopWait, this). 30 is the smallest value the live corpus has
 * OBSERVED Bitmovin accept at live/start (value 1 → code 1000, ,
 * confirmed by the 2026-08-23 billed A/B c2b683b3=1 FAILED vs 4a346088=30 DONE).
 */
export const PROBE_FUSE_MINUTES = 30;

export type ProbeDesignation = {
	credentialId: string;
	bucket: string;
	/** The designated probe AREA — every probe writes below it. */
	prefix: string;
	/** The Bitmovin account a probe runs under. A probe IS a real live
	 * encoder, so provision resolves an account exactly like any channel —
	 * without this the probe row carries no account and provision throws
	 * "no Bitmovin account id" before any billing (the gap the first billed
	 * run surfaced, 2026-08-23). */
	bitmovinAccountId: string;
};

export function probeOutputPrefix(
	designation: Pick<ProbeDesignation, "prefix">,
	probeId: string,
): string {
	const base = designation.prefix.endsWith("/")
		? designation.prefix
		: `${designation.prefix}/`;
	return `${base}${probeId}/`;
}

export function buildProbePlan(opts: {
	name: string;
	cloudRegion: string;
	encoderVersion?: string;
	designation: ProbeDesignation;
	probeId: string;
	/** ^[a-zA-Z]{3,20}$ per the start schema. */
	streamKey: string;
}): LiveChannelPlan {
	const prefix = probeOutputPrefix(opts.designation, opts.probeId);
	const plan = {
		planVersion: 1,
		name: opts.name,
		bitmovin: {
			accountId: opts.designation.bitmovinAccountId,
			cloudRegion: opts.cloudRegion,
			encoderVersion: opts.encoderVersion ?? "STABLE",
		},
		liveInput: { key: "main", kind: "RTMP" },
		outputs: [
			{
				key: PROBE_OUTPUT_KEY,
				kind: "S3",
				credentialId: opts.designation.credentialId,
				bucket: opts.designation.bucket,
				name: "Startup probe output",
			},
		],
		ingest: [
			{ key: "video", inputPath: "live", position: 0 },
			{ key: "audio", inputPath: "live", position: 1 },
		],
		renditions: [
			{
				key: "v360",
				codec: "H264",
				name: "Probe H264 360p",
				ingestKey: "video",
				height: 360,
				bitrate: 800_000,
				level: null,
				presetConfiguration: "LIVE_STANDARD",
				mode: "STANDARD",
			},
			{
				key: "a128",
				codec: "AAC",
				ingestKey: "audio",
				bitrate: 128_000,
				rate: 48_000,
				channelLayout: "CL_STEREO",
			},
		],
		muxings: [
			{
				key: "v360",
				kind: "FMP4",
				streamKey: "v360",
				segmentLength: 6,
				segmentNaming: "segment_%number%.m4s",
				initSegmentName: "init.mp4",
				destination: {
					outputKey: PROBE_OUTPUT_KEY,
					path: `${prefix}video/360p`,
				},
			},
			{
				key: "a128",
				kind: "FMP4",
				streamKey: "a128",
				segmentLength: 6,
				segmentNaming: "segment_%number%.m4s",
				initSegmentName: "init.mp4",
				destination: {
					outputKey: PROBE_OUTPUT_KEY,
					path: `${prefix}audio/128000`,
				},
			},
		],
		liveManifests: [
			{
				key: "hls",
				kind: "HLS",
				manifestName: "stream.m3u8",
				name: "Probe HLS Manifest",
				destination: { outputKey: PROBE_OUTPUT_KEY, path: prefix },
				audioGroupId: "audio",
				audioLanguage: "en",
				closedCaptions: "NONE",
			},
		],
		start: {
			streamKey: opts.streamKey,
			autoShutdown: {
				// Encoder-side never-connected billing fuse (#48's remedy). It
				// covers the one case the worker-side caps cannot: the encoder up
				// cloud-side while our DB never records RUNNING (e.g. a worker
				// killed between a successful START and the status write) — then
				// enforceCaps skips (runningSince null) and the reconciler skips
				// (status neither RUNNING nor ERROR), so only a cloud-side fuse
				// stops the bill. A probe never connects an input, so this fires
				// as that backstop.
				//
				// The VALUE, not the block, is load-bearing here. A billed probe
				// on 2026-08-23 proved Bitmovin REJECTS the live START (400 code
				// 1000) at value 1 — but the same run's corpus reached RUNNING
				// with autoShutdown at accepted values: live-srt-listener at
				// waitingForFirstConnectTimeoutMinutes: 30, live-rtmp-simple at
				// streamTimeoutMinutes: 720 (6 of 10 live fixtures ship the block).
				// So 1 is below Bitmovin's undocumented minimum; 30 is the
				// smallest value this tree has OBSERVED accepted. An earlier fix
				// mis-read this as "remove the block" on an inverted A/B —
				// review-288 C1 corrected it. See . The value is a
				// shared constant so the operator's cost quote can't drift from
				// the plan's actual bound (review-288 N1).
				waitingForFirstConnectTimeoutMinutes: PROBE_FUSE_MINUTES,
			},
		},
	};
	// The builder's own output is schema-validated — a drifted schema fails
	// HERE (loudly, at build) instead of at provision time inside the worker.
	return liveChannelPlanSchema.parse(plan);
}
