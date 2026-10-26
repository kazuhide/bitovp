import type { LiveChannelPlan, LiveMuxing } from "../live/schema";
import { vmafSourceFor } from "./streamable-io";

/**
 * Live VMAF capture targets (P4-PR6b). The VOD VMAF runner scores a
 * `qc/<key>.mp4` mirror the compiler emitted; a LIVE channel has NO such
 * mirror — the live encoder writes only HLS/DASH SEGMENTS to the output
 * storage. So for a pseudo-live capture the "distorted" side is reconstructed
 * by enumerating + concatenating those recent segments. This module is the
 * pure half: from a LiveChannelPlan it resolves, per VIDEO rendition, WHERE
 * (output ref + segment prefix) and HOW (fMP4 init+m4s vs TS) the encoder
 * wrote, so the worker can list and download them. No storage / ffmpeg here.
 *
 * The SOURCE (reference) side is the feeder's looping MP4 (its
 * sourceCredentialId/sourceBucket/sourceKey on the FeederSession) — not a
 * plan input — so it is resolved in the worker, not here.
 */

/** Segment container — drives the concat strategy in the worker. */
export type LiveSegmentKind = "FMP4" | "TS";

/** One video rendition's live segment location + identity for the result row. */
export type LiveCaptureTarget = {
	/** Rendition key (mirrors the VOD QcTarget.renditionKey). */
	renditionKey: string;
	codec: "H264" | "H265";
	/** null only for per-title; live renditions carry a concrete height. */
	height: number | null;
	bitrate: number | null;
	/** plan.outputs[].key — resolve to a vault credential + bucket/container. */
	outputKey: string;
	/**
	 * Prefix under which the encoder wrote this rendition's segments (the
	 * muxing destination path, e.g. "output/live/video/1080p"). Segment objects
	 * are `<prefix>/<segmentNaming-expanded>`; for fMP4 the init is
	 * `<prefix>/<initSegmentName>`.
	 */
	segmentPrefix: string;
	kind: LiveSegmentKind;
	/** fMP4 init object name (e.g. "init.mp4"); undefined for TS. */
	initSegmentName?: string;
	initSegmentNameTemplate?: string;
	/**
	 * The segment filename template (e.g. "segment_%number%.m4s"); used to
	 * recognise segment objects under the prefix and to order them by number.
	 */
	segmentNaming: string;
	/** Random tokens expand only when the muxing used segmentNamingTemplate. */
	segmentNamingIsTemplate?: boolean;
	/**
	 * The muxing's segment length in seconds : the per-segment
	 * aligner splits the captured window on the encoder's real segment size,
	 * never on an assumed cadence.
	 */
	segmentLengthSec: number;
};

/** True for the live video codecs (H264/H265 — VP9 is not a live codec). */
function isLiveVideo(codec: string): codec is "H264" | "H265" {
	return codec === "H264" || codec === "H265";
}

/**
 * Picks the muxing the capture should read for a rendition. A live rendition
 * can have BOTH an fMP4 and a TS muxing (HLS+DASH); fMP4 is preferred (DASH +
 * HLS both consume it and the init-segment concat is well-defined), falling
 * back to TS when only TS exists. Returns the muxing and its kind.
 */
function pickCaptureMuxing(
	muxings: LiveMuxing[],
):
	| { muxing: Exclude<LiveMuxing, { kind: "MP4" }>; kind: LiveSegmentKind }
	| undefined {
	const fmp4 = muxings.find((m) => m.kind === "FMP4");
	if (fmp4) {
		return { muxing: fmp4, kind: "FMP4" };
	}
	const cmaf = muxings.find((m) => m.kind === "CMAF");
	if (cmaf) return { muxing: cmaf, kind: "FMP4" };
	const ts = muxings.find((m) => m.kind === "TS");
	if (ts) {
		return { muxing: ts, kind: "TS" };
	}
	return undefined;
}

/** Mirrors receive the same muxing path/names; never guess between storage legs. */
function captureOutputKey(plan: LiveChannelPlan, primaryKey: string): string {
	const primary = plan.outputs.find((output) => output.key === primaryKey);
	if (!primary || vmafSourceFor(primary).streamable) return primaryKey;
	const mirrors = plan.outputs.filter(
		(output) =>
			output.key !== primaryKey &&
			plan.deliveryMirrors?.some((mirror) => mirror.outputKey === output.key) &&
			vmafSourceFor(output).streamable,
	);
	const [mirror] = mirrors;
	// Retain the unreadable primary so existing callers refuse missing/ambiguous legs.
	return mirrors.length === 1 && mirror ? mirror.key : primaryKey;
}

/**
 * Enumerates the per-video-rendition live capture targets for a channel plan.
 * Each entry names the output ref + segment prefix the live encoder wrote to,
 * the container kind, and (fMP4) the init name — everything the worker needs to
 * LIST recent segments and rebuild a distorted clip. Audio renditions and any
 * rendition whose muxing carries no destination are skipped (no scorable video
 * segments). Renditions are returned in plan order.
 */
export function enumerateLiveCaptureTargets(
	plan: LiveChannelPlan,
): LiveCaptureTarget[] {
	const targets: LiveCaptureTarget[] = [];
	for (const rendition of plan.renditions) {
		if (!isLiveVideo(rendition.codec)) {
			continue;
		}
		const renditionMuxings = plan.muxings.filter(
			(m) => m.streamKey === rendition.key,
		);
		const picked = pickCaptureMuxing(renditionMuxings);
		if (!picked) {
			continue;
		}
		const { muxing, kind } = picked;
		const destination = muxing.destination;
		if (!destination) {
			continue;
		}
		// height/bitrate exist on H264/H265 renditions; narrow defensively.
		const height =
			"height" in rendition && typeof rendition.height === "number"
				? rendition.height
				: null;
		const bitrate =
			"bitrate" in rendition && typeof rendition.bitrate === "number"
				? rendition.bitrate
				: null;
		targets.push({
			renditionKey: rendition.key,
			codec: rendition.codec,
			height,
			bitrate,
			outputKey: captureOutputKey(plan, destination.outputKey),
			segmentPrefix: destination.path,
			kind,
			...(muxing.kind === "CMAF" && muxing.initSegmentNameTemplate
				? { initSegmentNameTemplate: muxing.initSegmentNameTemplate }
				: kind === "FMP4" && "initSegmentName" in muxing
					? { initSegmentName: muxing.initSegmentName }
					: {}),
			segmentNaming: muxing.segmentNamingTemplate ?? muxing.segmentNaming,
			...(muxing.segmentNamingTemplate
				? { segmentNamingIsTemplate: true }
				: {}),
			segmentLengthSec: muxing.segmentLength,
		});
	}
	return targets;
}
