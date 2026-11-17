import {
	qcMirrorDirectory,
	qcMirrorFilename,
	renditionOutputBase,
} from "../plan/compiler";
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
 * output), same `qcMirrorDirectory` + `<key>.mp4` filename. Living next to the
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

/** CAMBI observes the encoded asset; it never needs a source comparison. */
export type BandingTarget = Omit<QcTarget, "reference">;

/** Require the same complete, nonempty set of encoded assets across metrics. */
export function sameQcTargetPopulation(
	left: readonly Pick<QcTarget, "renditionKey" | "distorted">[],
	right: readonly Pick<QcTarget, "renditionKey" | "distorted">[],
): boolean {
	if (left.length === 0 || left.length !== right.length) return false;
	const identity = (target: Pick<QcTarget, "renditionKey" | "distorted">) =>
		JSON.stringify([
			target.renditionKey,
			target.distorted.outputKey,
			target.distorted.path,
		]);
	const expected = new Set(left.map(identity));
	const actual = new Set(right.map(identity));
	return (
		expected.size === left.length &&
		actual.size === right.length &&
		right.every((target) => expected.has(identity(target)))
	);
}

/** Compiler-owned output coordinates do not require a comparison reference. */
export type QcMirrorOutput = {
	rendition: Extract<PlanRendition, { codec: "H264" | "H265" | "VP9" | "AV1" }>;
	destination: NonNullable<ReturnType<typeof renditionOutputBase>>;
	path: string;
};

export function enumerateQcMirrors(plan: EncodingPlan): QcMirrorOutput[] {
	if (!(plan.qc?.vmaf || plan.qc?.psnr || plan.qc?.banding)) return [];
	const mirrors: QcMirrorOutput[] = [];
	for (const rendition of plan.renditions) {
		if (!isVideoCodec(rendition)) continue;
		const destination = renditionOutputBase(plan, rendition.key);
		if (!destination) continue;
		mirrors.push({
			rendition,
			destination,
			path: `${qcMirrorDirectory(plan, destination)}${qcMirrorFilename(rendition.key, rendition.codec)}`,
		});
	}
	return mirrors;
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
 * mirror base or reference source cannot be resolved are skipped. A mirror can
 * exist for a transformed input without a safely resolvable comparison source.
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
	if (!(plan.qc?.vmaf || plan.qc?.psnr)) return [];
	return enumerateExistingQcMirrorTargets(plan);
}

/**
 * The video renditions a VMAF or PSNR pass writes a mirror for and cannot score:
 * the stream the rendition reads is not a source file as it stands (a trimmed or
 * concatenated stream, a Dolby Vision input), so there is nothing to compare the
 * mirror with. `enumerateQcTargets` leaves these out without a word, and a gate
 * rule that expects one fails for the measurement it never gets
 * (`gateExpectedRenditionKeys`). The plan's validation says so before the encode.
 */
export function enumerateQcMirrorsWithoutReference(
	plan: EncodingPlan,
): QcMirrorOutput[] {
	if (!(plan.qc?.vmaf || plan.qc?.psnr)) return [];
	return enumerateQcMirrors(plan).filter(
		({ rendition }) => !resolveReference(plan, rendition),
	);
}

/** A manual comparison can reuse a mirror produced for any original QC metric.
 * Reference resolution stays mandatory; no automatic metric is enabled here. */
export function enumerateExistingQcMirrorTargets(
	plan: EncodingPlan,
): QcTarget[] {
	const targets: QcTarget[] = [];
	for (const { rendition, destination, path } of enumerateQcMirrors(plan)) {
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
				outputKey: destination.outputKey,
				path,
			},
		});
	}
	return targets;
}

export function enumerateBandingQcTargets(plan: EncodingPlan): BandingTarget[] {
	if (!plan.qc?.banding) return [];
	return bandingMirrorTargets(plan);
}

/** Existing QC mirrors are usable by a new no-reference measurement regardless
 * of which metric originally caused the compiler to emit those mirrors. */
function bandingMirrorTargets(plan: EncodingPlan): BandingTarget[] {
	return enumerateQcMirrors(plan).map(({ rendition, destination, path }) => ({
		renditionKey: rendition.key,
		codec: rendition.codec,
		height: rendition.height,
		bitrate: rendition.bitrate,
		...(rendition.streamName ? { streamName: rendition.streamName } : {}),
		distorted: { outputKey: destination.outputKey, path },
	}));
}

/** Manual no-reference QC can reuse unambiguous clear fixed-ladder MP4s. */
export function enumerateExistingBandingMp4Targets(
	plan: EncodingPlan,
): BandingTarget[] {
	const targets: BandingTarget[] = [];
	for (const rendition of plan.renditions.filter(isVideoCodec)) {
		if (rendition.mode !== "STANDARD") return [];
		const muxings = plan.muxings.filter(
			(muxing) =>
				muxing.streamKey === rendition.key &&
				muxing.kind === "MP4" &&
				muxing.destination &&
				!plan.drm.some((drm) => drm.muxingKey === muxing.key),
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
			distorted: {
				outputKey: muxing.destination.outputKey,
				path: `${muxing.destination.path.replace(/\/$/, "")}/${muxing.filename}`,
			},
		});
	}
	return targets;
}

export function enumerateBandingTargets(
	plan: EncodingPlan,
	source: "QC_MIRROR" | "EXISTING_MP4" = "QC_MIRROR",
): BandingTarget[] {
	return source === "EXISTING_MP4"
		? enumerateExistingBandingMp4Targets(plan)
		: bandingMirrorTargets(plan);
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
	const targets = enumerateExistingQcMirrorTargets(plan);
	return targets.length === videos.length ? targets : [];
}

/** Manual HDR QC reads one complete, clear fMP4 video from its VOD playlist.
 * Keep this resolver separate: legacy mirror readers must not infer Dolby
 * sources or claim a nonexistent progressive mirror. */
export type HlsQcTarget = QcTarget & {
	hls: {
		muxingKey: string;
		rootPrefix: string;
		outputPrefix: string;
		initKey: string;
		segmentNaming: string;
	};
};

function hlsPath(path: string, directory = false): string | undefined {
	if (
		path.length > 4096 ||
		!/^[A-Za-z0-9._/-]*$/.test(path) ||
		path.startsWith("/") ||
		path.split("/").some((part) => part === "." || part === "..") ||
		path.includes("//")
	)
		return undefined;
	return directory && path ? `${path.replace(/\/$/, "")}/` : path;
}

export function enumerateExistingHlsQcTargets(
	plan: EncodingPlan,
): HlsQcTarget[] {
	if (
		plan.trimmingStreams.length ||
		plan.concatenationStreams.length ||
		plan.filters.length ||
		plan.drm.length
	)
		return [];
	const videos = plan.renditions.filter(isVideoCodec);
	if (videos.length !== 1) return [];
	const rendition = videos[0];
	if (
		rendition?.mode !== "STANDARD" ||
		rendition.filters?.length ||
		!rendition.height ||
		!rendition.bitrate
	)
		return [];
	if (
		"dynamicRangeFormat" in rendition &&
		rendition.dynamicRangeFormat?.startsWith("DOLBY_VISION") &&
		rendition.dynamicRangeFormat !== "DOLBY_VISION_PROFILE_10_1"
	)
		return [];
	const ingest = plan.ingest.find((item) => item.key === rendition.ingestKey);
	const vision = plan.dolbyStreams.find(
		(item) => item.key === rendition.ingestKey && item.kind === "VISION",
	);
	const hdr10Plus = plan.hdr10PlusStreams.find(
		(item) => item.key === rendition.ingestKey,
	);
	const reference =
		ingest &&
		ingest.position === 0 &&
		["AUTO", "VIDEO_RELATIVE"].includes(ingest.selectionMode)
			? { inputKey: ingest.inputKey, inputPath: ingest.inputPath }
			: vision?.kind === "VISION"
				? { inputKey: vision.inputKey, inputPath: vision.videoInputPath }
				: hdr10Plus &&
						(hdr10Plus.position ?? 0) === 0 &&
						["AUTO", "VIDEO_RELATIVE"].includes(hdr10Plus.selectionMode)
					? {
							inputKey: hdr10Plus.inputKey,
							inputPath: hdr10Plus.videoInputPath,
						}
					: undefined;
	if (!reference) return [];
	const muxings = plan.muxings.filter(
		(item) => item.streamKey === rendition.key,
	);
	const muxing = muxings[0];
	if (
		muxings.length !== 1 ||
		muxing?.kind !== "FMP4" ||
		!muxing.destination ||
		muxing.segmentNamingTemplate
	)
		return [];
	const manifests = plan.manifests.filter((item) => item.kind === "HLS");
	const manifest = manifests[0];
	if (
		manifests.length !== 1 ||
		manifest?.kind !== "HLS" ||
		manifest.drmKind ||
		manifest.detailed ||
		manifest.variantsPerAudioGroup ||
		manifest.audioVariantStreams ||
		(manifest.videoMuxingKind && manifest.videoMuxingKind !== "FMP4") ||
		manifest.destination.outputKey !== muxing.destination.outputKey
	)
		return [];
	const rootPrefix = hlsPath(manifest.destination.path, true);
	const outputPrefix = hlsPath(muxing.destination.path, true);
	const manifestName = hlsPath(manifest.manifestName);
	const init = hlsPath(muxing.initSegmentName);
	const segmentParts = muxing.segmentNaming.split("%number%");
	if (
		rootPrefix === undefined ||
		outputPrefix === undefined ||
		!outputPrefix.startsWith(rootPrefix) ||
		!manifestName?.endsWith(".m3u8") ||
		manifestName.includes("/") ||
		!init ||
		init.includes("/") ||
		segmentParts.length !== 2 ||
		!segmentParts.every((part) => hlsPath(part) !== undefined) ||
		muxing.segmentNaming.includes("/")
	)
		return [];
	return [
		{
			renditionKey: rendition.key,
			codec: rendition.codec,
			height: rendition.height,
			bitrate: rendition.bitrate,
			...(rendition.streamName ? { streamName: rendition.streamName } : {}),
			reference,
			distorted: {
				outputKey: muxing.destination.outputKey,
				path: `${rootPrefix}${manifestName}`,
			},
			hls: {
				muxingKey: muxing.key,
				rootPrefix,
				outputPrefix,
				initKey: `${outputPrefix}${init}`,
				segmentNaming: muxing.segmentNaming,
			},
		},
	];
}

export function retainedHlsQcKey(
	target: HlsQcTarget,
	vmafJobId: string,
	assembledSha256: string,
): string {
	if (
		!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
			vmafJobId,
		) ||
		!/^[A-Za-z0-9_-]+$/.test(target.renditionKey) ||
		!/^[a-f0-9]{64}$/.test(assembledSha256) ||
		hlsPath(target.hls.outputPrefix, true) !== target.hls.outputPrefix
	)
		throw new Error("HLS_QC_IDENTITY_INVALID");
	return `${target.hls.outputPrefix}qc-retained/${vmafJobId}/${target.renditionKey}-${assembledSha256}.mp4`;
}
