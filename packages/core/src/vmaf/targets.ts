import { qcMirrorFilename, qcOutputPath } from "../plan/compiler";
import type { EncodingPlan, PlanRendition } from "../plan/schema";

/**
 * VMAF target enumeration (P4 — our own libvmaf pipeline). The worker's
 * vmaf-runner needs to know, for a FINISHED qc-enabled encoding, WHICH
 * files to compare: per video rendition, the DISTORTED `qc/<key>.mp4`
 * mirror the compiler emitted (its output + path) and the REFERENCE source
 * MP4 the encoding ingested (its input + path).
 *
 * This MUST stay in lockstep with the compiler's qc-mirror emission
 * (plan/compiler.ts §4 "QC mirror"): same video-codec gate, same base
 * resolution (prefer a muxing's own destination, else the encrypting DRM's
 * output), same `qcOutputPath` + `<key>.mp4` filename. Living next to the
 * compiler in core (not the worker) keeps the two from drifting — a
 * compiler change to the mirror path breaks this module's golden test, not
 * a silent runtime mismatch where the runner downloads a 404.
 *
 * Returned as a pure value object (resolved against the SAME EncodingPlan
 * the orchestrator executed, read back off EncodingJob.plan): the worker
 * then maps inputKey/outputKey → vault credentials and streams the bytes.
 */

/** Video codecs the compiler emits a qc mirror for (mirrors isVideoCodec). */
function isVideoCodec(
	rendition: PlanRendition,
): rendition is Extract<
	PlanRendition,
	{ codec: "H264" | "H265" | "VP9" | "AV1" }
> {
	return (
		rendition.codec === "H264" ||
		rendition.codec === "H265" ||
		rendition.codec === "VP9" ||
		rendition.codec === "AV1"
	);
}

/** The reference (source) side of a VMAF comparison. */
export type QcReference = {
	/** plan.inputs[].key — resolve to a vault credential + bucket/container. */
	inputKey: string;
	/** Object path of the source mezzanine inside that input. */
	inputPath: string;
};

/** The distorted (encoded) side: the compiler's `qc/<key>.mp4` mirror. */
export type QcDistorted = {
	/** plan.outputs[].key — resolve to a vault credential + bucket/container. */
	outputKey: string;
	/** Full object path of the mirror MP4 (qc/<key>.mp4 under the base dir). */
	path: string;
};

/** One rendition's VMAF comparison pair plus identity for the result row. */
export type QcTarget = {
	/** Rendition key (== the mirror filename stem, qc/<key>.mp4). */
	renditionKey: string;
	codec: "H264" | "H265" | "VP9" | "AV1";
	/** null for per-title templates (height left to the algorithm). */
	height: number | null;
	/** null for per-title templates (bitrate left to the algorithm). */
	bitrate: number | null;
	/** Stream resource name override, when the plan pinned one. */
	streamName?: string;
	reference: QcReference;
	distorted: QcDistorted;
};

/**
 * Resolves a video rendition's mirror output base, mirroring the compiler:
 * prefer the first muxing that carries its own destination; for a
 * fully-DRM'd rendition (muxing has no destination) fall back to the
 * encrypting DRM's output. Returns undefined when neither exists — the
 * compiler then emits NO mirror, so there is nothing to score.
 */
function resolveMirrorBase(
	plan: EncodingPlan,
	renditionKey: string,
): { outputKey: string; path: string } | undefined {
	const renditionMuxings = plan.muxings.filter(
		(m) => m.streamKey === renditionKey,
	);
	for (const m of renditionMuxings) {
		if (m.destination) {
			return { outputKey: m.destination.outputKey, path: m.destination.path };
		}
		const drm = plan.drm.find((d) => d.muxingKey === m.key);
		if (drm) {
			return {
				outputKey: drm.destination.outputKey,
				path: drm.destination.path,
			};
		}
	}
	return undefined;
}

/**
 * Resolves a video rendition's reference source: the ingest stream named by
 * `rendition.ingestKey` (the video mezzanine — file/dolby ingest keys are
 * sidecars, not the comparison reference). Returns undefined when the
 * rendition's ingestKey is not a plain `ingest` entry (e.g. a Dolby-vision
 * input stream) — the runner skips it rather than guessing a source.
 */
function resolveReference(
	plan: EncodingPlan,
	rendition: Extract<PlanRendition, { codec: "H264" | "H265" | "VP9" | "AV1" }>,
): QcReference | undefined {
	const ingest = plan.ingest.find((i) => i.key === rendition.ingestKey);
	if (!ingest) {
		return undefined;
	}
	return { inputKey: ingest.inputKey, inputPath: ingest.inputPath };
}

/**
 * Enumerates the VMAF comparison targets for a plan. Empty unless QC is
 * requested — `plan.qc?.vmaf` OR `plan.qc?.psnr` (same gate as the compiler's
 * mirror emission; PSNR rides the same libvmaf pass and needs the same
 * distorted mirror). Each entry pairs the compiler-emitted `qc/<key>.mp4`
 * distorted mirror with the rendition's reference source; renditions whose
 * mirror base or reference source cannot be resolved are skipped (the compiler
 * emitted no mirror for them, so there is no distorted file to download).
 */
/**
 * Every VIDEO rendition key of a plan — the gate's EXPECTED measurement
 * population . Deliberately WITHOUT
 * enumerateQcTargets' resolvability filters: that function silently skips a
 * rendition three ways (no mirror base, no resolvable reference — e.g. a
 * Dolby-vision input stream — and it is the list the runner measures from),
 * so deriving a gate's default targets from MEASUREMENTS let an unmeasured
 * rendition vanish from the verdict instead of failing it — a BLOCK gate
 * released delivery with an unverified rendition, the #40 failure this
 * feature exists to prevent. A rendition that legitimately cannot be
 * measured is excluded by NAMING it out of the rule (rule.renditions),
 * never by this list shrinking.
 */
export function gateExpectedRenditionKeys(plan: EncodingPlan): string[] {
	return plan.renditions
		.filter((rendition) => isVideoCodec(rendition))
		.map((rendition) => rendition.key);
}

export function enumerateQcTargets(plan: EncodingPlan): QcTarget[] {
	if (!(plan.qc?.vmaf || plan.qc?.psnr)) {
		return [];
	}
	const targets: QcTarget[] = [];
	for (const rendition of plan.renditions) {
		if (!isVideoCodec(rendition)) {
			continue;
		}
		const base = resolveMirrorBase(plan, rendition.key);
		if (!base) {
			continue;
		}
		const reference = resolveReference(plan, rendition);
		if (!reference) {
			continue;
		}
		targets.push({
			renditionKey: rendition.key,
			codec: rendition.codec,
			height: rendition.height,
			bitrate: rendition.bitrate,
			...(rendition.streamName ? { streamName: rendition.streamName } : {}),
			reference,
			distorted: {
				outputKey: base.outputKey,
				// Compiler: outputPath = qcOutputPath(base.path); filename =
				// qcMirrorFilename. The full object path is their join.
				path: `${qcOutputPath(base.path)}${qcMirrorFilename(rendition.key, rendition.codec)}`,
			},
		});
	}
	return targets;
}

/** Existing clear fixed-ladder MP4s can be measured without a QC mirror.
 * Require a direct, first video source and one unambiguous MP4 per rendition.
 * Reject transforms here: the original full source would no longer align.
 */
export function enumerateExistingMp4Targets(plan: EncodingPlan): QcTarget[] {
	if (
		plan.trimmingStreams.length ||
		plan.concatenationStreams.length ||
		plan.filters.length
	)
		return [];
	const videos = plan.renditions.filter(isVideoCodec);
	const targets: QcTarget[] = [];
	for (const rendition of videos) {
		if (rendition.mode !== "STANDARD" || rendition.filters?.length) return [];
		const ingest = plan.ingest.find((i) => i.key === rendition.ingestKey);
		if (
			ingest?.position !== 0 ||
			!["AUTO", "VIDEO_RELATIVE"].includes(ingest.selectionMode)
		)
			return [];
		const muxings = plan.muxings.filter(
			(m) =>
				m.streamKey === rendition.key &&
				m.kind === "MP4" &&
				m.destination &&
				!plan.drm.some((d) => d.muxingKey === m.key),
		);
		if (muxings.length !== 1) return [];
		const muxing = muxings[0];
		if (muxing?.kind !== "MP4" || !muxing.destination) return [];
		targets.push({
			renditionKey: rendition.key,
			codec: rendition.codec,
			height: rendition.height,
			bitrate: rendition.bitrate,
			...(rendition.streamName ? { streamName: rendition.streamName } : {}),
			reference: { inputKey: ingest.inputKey, inputPath: ingest.inputPath },
			distorted: {
				outputKey: muxing.destination.outputKey,
				path: `${muxing.destination.path.replace(/\/$/, "")}/${muxing.filename}`,
			},
		});
	}
	return targets;
}

/** Full-source QC mirrors eligible for explicit frame-index cloud validation.
 * Keep every video template in the population; source transforms and partial
 * target enumeration cannot establish correspondence with the original file.
 */
export function enumerateFrameIndexQcTargets(plan: EncodingPlan): QcTarget[] {
	if (
		plan.trimmingStreams.length ||
		plan.concatenationStreams.length ||
		plan.filters.length
	)
		return [];
	const videos = plan.renditions.filter(isVideoCodec);
	for (const rendition of videos) {
		if (rendition.filters?.length) return [];
		const ingest = plan.ingest.find(
			(entry) => entry.key === rendition.ingestKey,
		);
		if (
			ingest?.position !== 0 ||
			!["AUTO", "VIDEO_RELATIVE"].includes(ingest.selectionMode)
		)
			return [];
	}
	const targets = enumerateQcTargets(plan);
	return targets.length === videos.length ? targets : [];
}
