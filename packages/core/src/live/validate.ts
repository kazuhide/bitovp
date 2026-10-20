import { checkAkamaiMslConstraints } from "../plan/akamai-msl-constraint";
import { checkH26xCodecControls } from "../plan/codec-controls";
import { checkSecretEgressHosts, type EgressSite } from "../plan/egress";
import { checkMslEncoderVersion } from "../plan/msl-encoder-version";
import { muxingStreamKeys } from "../plan/muxing-streams";
import { AUDIO_CODECS } from "../plan/schema";
import type { PlanIssue, PlanValidationOptions } from "../plan/validate";
import {
	liveHlsEntryUri,
	liveHlsEntryUris,
	selectLiveManifestMuxings,
} from "./compiler";
import { LIVE_MANIFEST_ELEMENT_BUDGET, manifestElementEstimate } from "./dvr";
import {
	isLiveAacChannelLayout,
	resolveLiveEncodingOption,
} from "./encoding-option";
import { checkLiveHlsVideoUris } from "./hls-video-uri-validation";
import { liveManifestPathIssues } from "./manifest-paths";
import type { LiveChannelPlan } from "./schema";
import { SRT_LISTENER_PORTS } from "./schema";
import { AGGREGATE_CLOUD_REGIONS } from "./startup";

/**
 * Cross-field validation for live channel plans — runs after zod parsing,
 * before compilation (same contract as plan/validate). LIVE_* codes are
 * structural; the SRT and REDUNDANT_RTMP codes duplicate the schema
 * superRefines for plans constructed in TS without parsing; C8 is the DVR
 * element budget.
 *
 * Deliberately schema-covered (no validator duplicate): streamKey format,
 * reupload intervals ≥30, SRT keyLength↔credentialId, the static-ingest
 * GENERATE/ASSIGN refinement.
 *
 * Codecs: the live encoder supports H264/H265 video and AAC/DD/DDPLUS
 * audio. VP9, Dolby Atmos and WebVTT subtitle tracks are VOD-only — the
 * rendition union is shared, so the rail closes the gap.
 */

/**
 * The live encoder's codec support matrix, exported because the feeder's
 * ingest preflight  needs the SAME video/audio split to work out
 * what media type each declared ingest position expects. A second copy in the
 * worker would drift the moment a codec is added here.
 */
export const LIVE_VIDEO_CODECS = new Set(["H264", "H265"]);
export const LIVE_AUDIO_CODECS = new Set(["AAC", "DDPLUS", "DD"]);

/** Container/codec matrix for the live muxing kinds (mirror of VOD's). */
const LIVE_MUXING_ALLOWED: Record<string, string[]> = {
	FMP4: ["H264", "H265", "AAC", "DDPLUS", "DD"],
	CMAF: ["H264", "AAC"],
	TS: ["H264", "AAC"],
	// Deliberately scoped to the provider's HD progressive-archive regression.
	MP4: ["H264", "AAC"],
};

function checkUniqueKeys(
	items: { key: string }[],
	collection: string,
	issues: PlanIssue[],
): void {
	const seen = new Set<string>();
	for (const item of items) {
		if (seen.has(item.key)) {
			issues.push({
				code: "LIVE_DUPLICATE_KEY",
				level: "error",
				message: `Duplicate key "${item.key}" in ${collection}`,
				path: collection,
			});
		}
		seen.add(item.key);
	}
}

type SrtConnectionLike = {
	mode: "LISTENER" | "CALLER";
	host?: string;
	port: number;
};

function checkSrtConnection(
	connection: SrtConnectionLike,
	path: string,
	issues: PlanIssue[],
): void {
	if (connection.mode === "CALLER" && !connection.host) {
		issues.push({
			code: "SRT_CALLER_NEEDS_HOST",
			level: "error",
			message: "SRT CALLER mode requires host (Bitmovin dials the source)",
			path: `${path}.host`,
		});
	}
	if (connection.mode === "LISTENER" && connection.host) {
		// Duplicates the schema refine for TS-constructed plans — the SDK
		// marks host as CALLER-only; a LISTENER host would be silently dead.
		issues.push({
			code: "SRT_LISTENER_HOST_FORBIDDEN",
			level: "error",
			message: "SRT LISTENER mode must not set host (CALLER-only field)",
			path: `${path}.host`,
		});
	}
	if (
		connection.mode === "LISTENER" &&
		!SRT_LISTENER_PORTS.includes(
			connection.port as (typeof SRT_LISTENER_PORTS)[number],
		)
	) {
		issues.push({
			code: "SRT_LISTENER_PORT",
			level: "error",
			message: `SRT LISTENER port must be one of ${SRT_LISTENER_PORTS.join("/")} (got ${connection.port})`,
			path: `${path}.port`,
		});
	}
}

/**
 * Regions that don't pin a concrete datacenter (AUTO + continent/provider
 * aggregates) — a region-bound static IP cannot be guaranteed to match.
 */
// Derived from the hoisted core list ( PR1 closed the
// duplicated-list nit): static-IP contexts use the aggregates as-is —
// EXTERNAL is deliberately NOT here (a Cloud Connect region can hold a
// region-bound static IP; the pool list appends EXTERNAL for its own
// reason at its own site).
const LIVE_UNPINNED_REGIONS = new Set<string>(AGGREGATE_CLOUD_REGIONS);

/** Every place this channel makes the encoder POST vault material to a host. */
function secretEgressSites(plan: LiveChannelPlan): EgressSite[] {
	const sites: EgressSite[] = [];
	const poisEndpoint = plan.start.esam?.poisEndpoint;
	// Only when a POIS CREDENTIAL rides. C22 scopes this rail by "does a vaulted
	// secret egress here", explicitly not by "is this field a URL" — and with no
	// credential nothing vaulted egresses. Without this condition the validator
	// blocked an unauthenticated POIS endpoint at submit (400) that the worker
	// then allowed at execution: the two sides disagreed, and the symptom was a
	// false rejection of a case the constraint does not cover (review catch).
	if (poisEndpoint && plan.start.esam?.poisCredentialId !== undefined) {
		sites.push({
			field: "start.esam.poisEndpoint",
			url: poisEndpoint,
			carries: "the ESAM POIS username and password",
		});
	}
	return sites;
}

export function validateLiveChannel(
	plan: LiveChannelPlan,
	options: PlanValidationOptions = {},
): PlanIssue[] {
	const issues: PlanIssue[] = [
		...liveManifestPathIssues(plan),
		...checkLiveHlsVideoUris(plan),
	];
	issues.push(...checkH26xCodecControls(plan.renditions));
	if (plan.start.encodingOption === "HD") {
		const resolution = resolveLiveEncodingOption(plan);
		if (resolution.encodingOption !== "HD")
			issues.push({
				code: "LIVE_HD_INCOMPATIBLE",
				level: "error",
				path: "start.encodingOption",
				message: `Live HD is incompatible: ${resolution.reasons.map((reason) => reason.code).join(", ")}`,
			});
	}

	checkUniqueKeys(plan.outputs, "outputs", issues);
	checkUniqueKeys(plan.ingest, "ingest", issues);
	checkUniqueKeys(plan.renditions, "renditions", issues);
	checkUniqueKeys(plan.muxings, "muxings", issues);
	checkUniqueKeys(plan.liveManifests, "liveManifests", issues);

	// Live deliveryMirrors (2026-08-23, MSL4+Object-Storage simultaneous):
	// Every key resolves and no mirror key appears twice. Unlike VOD, Live
	// excludes a readable storage destination's own output during compilation.
	// Delivery-only outputs retain the overlap refusal: MSL primary/mirror
	// mixed roles need a separate verifier topology contract before admission.
	if (plan.deliveryMirrors) {
		const outputKeys = new Set(plan.outputs.map((o) => o.key));
		const seenMirrors = new Set<string>();
		for (const [index, mirror] of plan.deliveryMirrors.entries()) {
			if (!outputKeys.has(mirror.outputKey)) {
				issues.push({
					code: "PLAN_UNRESOLVED_REF",
					level: "error",
					message: `deliveryMirrors[${index}] references unknown output "${mirror.outputKey}"`,
					path: `deliveryMirrors.${index}.outputKey`,
				});
			}
			if (seenMirrors.has(mirror.outputKey)) {
				issues.push({
					code: "PLAN_DUPLICATE_KEY",
					level: "error",
					message: `deliveryMirrors lists output "${mirror.outputKey}" twice`,
					path: `deliveryMirrors.${index}.outputKey`,
				});
			}
			seenMirrors.add(mirror.outputKey);
		}
		const storageKeys = new Set(
			plan.outputs
				.filter((output) =>
					["S3", "GENERIC_S3", "GCS", "GCS_SERVICE_ACCOUNT", "AZURE"].includes(
						output.kind,
					),
				)
				.map((output) => output.key),
		);
		const sites = [
			...plan.muxings.map((muxing, index) => ({
				path: `muxings.${index}`,
				destination: muxing.destination,
			})),
			...plan.liveManifests.map((manifest, index) => ({
				path: `liveManifests.${index}`,
				destination: manifest.destination,
			})),
		];
		for (const { path, destination } of sites) {
			if (
				destination &&
				seenMirrors.has(destination.outputKey) &&
				!storageKeys.has(destination.outputKey)
			) {
				issues.push({
					code: "PLAN_DUPLICATE_KEY",
					level: "error",
					message: `${path} writes to delivery-only output "${destination.outputKey}" which is ALSO a delivery mirror — self mirrors are supported only for readable storage outputs`,
					path: `${path}.destination.outputKey`,
				});
			}
		}
	}

	if (
		plan.bitmovin.infrastructure &&
		plan.bitmovin.cloudRegion !== "EXTERNAL"
	) {
		// C18 — same contract as the VOD rail: Cloud Connect requires the
		// top-level region to be EXTERNAL; the in-infrastructure region rides
		// InfrastructureSettings.cloudRegion.
		issues.push({
			code: "LIVE_INFRASTRUCTURE_REQUIRES_EXTERNAL_REGION",
			level: "error",
			message: `bitmovin.infrastructure is set but cloudRegion is "${plan.bitmovin.cloudRegion}" — Cloud Connect requires cloudRegion EXTERNAL (the in-infrastructure region rides InfrastructureSettings.cloudRegion)`,
			path: "bitmovin.cloudRegion",
		});
	}
	if (
		!plan.bitmovin.infrastructure &&
		plan.bitmovin.cloudRegion === "EXTERNAL"
	) {
		// C18 inverse — EXTERNAL with no infrastructure block (e.g. the
		// wizard's fill-then-clear path, or an imported plan).
		issues.push({
			code: "LIVE_EXTERNAL_REGION_REQUIRES_INFRASTRUCTURE",
			level: "error",
			message:
				"cloudRegion EXTERNAL declares a Cloud Connect run but no bitmovin.infrastructure block is set — fill the infrastructure pair or pick a managed-cloud region",
			path: "bitmovin.cloudRegion",
		});
	}
	{
		// C19: adInsertion.clockSynchronizationMode vs an HLS manifest's
		// programDateTimeSettings.source — both set and mismatched fails the
		// ENCODING at Bitmovin (SDK doc contract), so it is an error here.
		const clockMode = plan.start.adInsertion?.clockSynchronizationMode;
		if (clockMode) {
			plan.liveManifests.forEach((m, i) => {
				if (m.kind !== "HLS") {
					return;
				}
				const src = m.programDateTimeSettings?.source;
				if (src && src !== clockMode) {
					issues.push({
						code: "LIVE_CLOCK_SYNC_PDT_CONFLICT",
						level: "error",
						message: `adInsertion.clockSynchronizationMode is ${clockMode} but HLS manifest "${m.key}" sets programDateTimeSettings.source ${src} — mismatched modes FAIL the encoding (align them or set only one)`,
						path: `liveManifests[${i}].programDateTimeSettings.source`,
					});
				}
			});
		}
		// CacheControl headers are honoured on S3/GCS/Azure outputs only.
		// GCS_SERVICE_ACCOUNT is GCS (same provider, different credential
		// shape) so it counts as supported (review catch M4). GENERIC_S3 does
		// NOT: Bitmovin models it as a distinct output type, and the doc names
		// only the three above — recorded in C19 rather than left implicit.
		if (plan.start.cacheControl) {
			const CACHE_CONTROL_PROVIDERS = new Set([
				"S3",
				"GCS",
				"GCS_SERVICE_ACCOUNT",
				"AZURE",
			]);
			const unsupported = plan.outputs.filter(
				(o) => !CACHE_CONTROL_PROVIDERS.has(o.kind),
			);
			if (unsupported.length > 0) {
				issues.push({
					code: "LIVE_CACHE_CONTROL_PROVIDER",
					level: "warning",
					message: `cacheControl settings are honoured on S3/GCS/Azure outputs only — output(s) ${unsupported.map((o) => `"${o.key}" (${o.kind})`).join(", ")} will ignore them`,
					path: "start.cacheControl",
				});
			}
		}
	}
	if (
		plan.bitmovin.staticIpId &&
		LIVE_UNPINNED_REGIONS.has(plan.bitmovin.cloudRegion)
	) {
		// C16 — a StaticIp is region-bound; an AUTO/aggregate encoding region
		// can land elsewhere and the encoding errors at start. Warn, never
		// clamp (C8 philosophy).
		issues.push({
			code: "LIVE_STATIC_IP_REGION_UNPINNED",
			level: "warning",
			message: `staticIpId is set but cloudRegion is "${plan.bitmovin.cloudRegion}" — a static IP is region-bound; pin the encoding to the IP's specific region or the encoding goes to ERROR at create`,
			path: "bitmovin.cloudRegion",
		});
	}

	// Live input rails (schema duplicates — cross-field).
	const input = plan.liveInput;
	if (input.kind === "SRT") {
		checkSrtConnection(input, "liveInput", issues);
		input.backup?.srtInputs.forEach((backup, index) => {
			checkSrtConnection(
				backup,
				`liveInput.backup.srtInputs[${index}]`,
				issues,
			);
		});
	}
	if (input.kind === "REDUNDANT_RTMP") {
		if (
			(input.ingestPoints === undefined) ===
			(input.staticIngestPoints === undefined)
		) {
			issues.push({
				code: "REDUNDANT_RTMP_INGEST_XOR",
				level: "error",
				message:
					"REDUNDANT_RTMP requires exactly one of ingestPoints or staticIngestPoints (the SDK forbids mixing)",
				path: "liveInput.ingestPoints",
			});
		}
	}

	const outputKeys = new Set(plan.outputs.map((o) => o.key));
	const ingestKeys = new Set(plan.ingest.map((s) => s.key));
	const renditionKeys = new Set(plan.renditions.map((r) => r.key));

	// Renditions: refs, live codec matrix, VOD-only feature rejection.
	for (const [index, rendition] of plan.renditions.entries()) {
		if (
			rendition.codec === "AAC" &&
			!isLiveAacChannelLayout(rendition.channelLayout)
		) {
			issues.push({
				code: "LIVE_AAC_CHANNEL_LAYOUT",
				level: "error",
				path: `renditions[${index}].channelLayout`,
				message:
					"AAC channelLayout must be a supported SDK enum name, such as MONO or CL_STEREO",
			});
		}
		if (!ingestKeys.has(rendition.ingestKey)) {
			issues.push({
				code: "LIVE_UNRESOLVED_REF",
				level: "error",
				message: `rendition "${rendition.key}" references unknown ingest "${rendition.ingestKey}"`,
				path: `renditions[${index}].ingestKey`,
			});
		}
		const liveCodec =
			LIVE_VIDEO_CODECS.has(rendition.codec) ||
			LIVE_AUDIO_CODECS.has(rendition.codec);
		if (!liveCodec) {
			issues.push({
				code: "LIVE_CODEC_UNSUPPORTED",
				level: "error",
				message: `rendition "${rendition.key}" (${rendition.codec}) is not live-encodable — live supports H264/H265 + AAC/DD/DDPLUS`,
				path: `renditions[${index}].codec`,
			});
			continue; // the rails below assume a live codec shape
		}
		if (LIVE_VIDEO_CODECS.has(rendition.codec)) {
			// Per-title is a VOD start-request feature (C1 family) — live
			// ladders are fixed.
			if (
				("mode" in rendition &&
					typeof rendition.mode === "string" &&
					rendition.mode.startsWith("PER_TITLE")) ||
				("perTitleSettings" in rendition && rendition.perTitleSettings)
			) {
				issues.push({
					code: "LIVE_PER_TITLE_UNSUPPORTED",
					level: "error",
					message: `rendition "${rendition.key}" uses a per-title mode — per-title does not exist for live encodings`,
					path: `renditions[${index}].mode`,
				});
			}
			if ("bitrate" in rendition && rendition.bitrate === null) {
				// Null bitrate is the per-title-template idiom; a live encoder
				// (and the manifest uris) need a fixed ladder.
				issues.push({
					code: "LIVE_RENDITION_BITRATE_REQUIRED",
					level: "error",
					message: `rendition "${rendition.key}" has no bitrate — live ladders are fixed (null is the VOD per-title idiom)`,
					path: `renditions[${index}].bitrate`,
				});
			}
			// The shared schema defaults H264 presetConfiguration to the VOD
			// preset — silently encoding a channel with a VOD preset is the
			// trap this warning disarms (LIVE_STANDARD etc. exist).
			if (
				"presetConfiguration" in rendition &&
				typeof rendition.presetConfiguration === "string" &&
				rendition.presetConfiguration.startsWith("VOD_")
			) {
				issues.push({
					code: "LIVE_PRESET_VOD",
					level: "warning",
					message: `rendition "${rendition.key}" uses VOD preset ${rendition.presetConfiguration} — pick a LIVE_* presetConfiguration for live encodings`,
					path: `renditions[${index}].presetConfiguration`,
				});
			}
		}
		// VOD-only stream attachments the live compiler does not emit —
		// rejecting beats silently dropping plan data.
		const unsupported: [string, boolean][] = [
			[
				"motionCompensatedTemporalFiltering",
				"motionCompensatedTemporalFiltering" in rendition &&
					rendition.motionCompensatedTemporalFiltering !== undefined,
			],
			[
				"rateControlModeConfig",
				"rateControlModeConfig" in rendition &&
					rendition.rateControlModeConfig !== undefined,
			],
			[
				"filters",
				"filters" in rendition && (rendition.filters?.length ?? 0) > 0,
			],
			["nexguard", "nexguard" in rendition && rendition.nexguard !== undefined],
			[
				"encodingKey",
				"encodingKey" in rendition && rendition.encodingKey !== undefined,
			],
			[
				"dashSetKey",
				"dashSetKey" in rendition && rendition.dashSetKey !== undefined,
			],
			["hlsMedia", "hlsMedia" in rendition && rendition.hlsMedia !== undefined],
			[
				"hlsVariantLabel",
				"hlsVariantLabel" in rendition &&
					rendition.hlsVariantLabel !== undefined,
			],
			[
				"dolbyVisionMetadata",
				"dolbyVisionMetadata" in rendition &&
					rendition.dolbyVisionMetadata !== undefined,
			],
		];
		for (const [field, present] of unsupported) {
			if (present) {
				issues.push({
					code: "LIVE_RENDITION_FEATURE_UNSUPPORTED",
					level: "error",
					message: `rendition "${rendition.key}" sets ${field} — a VOD-only feature the live compiler does not emit`,
					path: `renditions[${index}].${field}`,
				});
			}
		}
	}

	// Muxings: refs, destination (no DRM in live PR1 to carry outputs),
	// container/codec matrix.
	const renditionByKey = new Map(plan.renditions.map((r) => [r.key, r]));
	const muxedRenditions = new Set<string>();
	for (const [index, muxing] of plan.muxings.entries()) {
		// Every stream the container packages — see plan/validate.ts for why
		// the unmuxed rail cannot read `streamKey` alone once a container can
		// hold two.
		const containerKeys = muxingStreamKeys(muxing);
		for (const [at, streamKey] of containerKeys.entries()) {
			const path =
				at === 0
					? `muxings[${index}].streamKey`
					: `muxings[${index}].additionalStreamKeys[${at - 1}]`;
			if (!renditionKeys.has(streamKey)) {
				issues.push({
					code: "LIVE_UNRESOLVED_REF",
					level: "error",
					message: `muxing "${muxing.key}" references unknown rendition "${streamKey}"`,
					path,
				});
			}
			muxedRenditions.add(streamKey);
		}
		const duplicated = containerKeys.filter(
			(key, at) => containerKeys.indexOf(key) !== at,
		);
		if (duplicated.length > 0) {
			issues.push({
				code: "LIVE_MUXING_DUPLICATE_STREAM",
				level: "error",
				message: `muxing "${muxing.key}" packages rendition "${duplicated[0]}" more than once`,
				path: `muxings[${index}].additionalStreamKeys`,
			});
		}
		const videoInContainer = containerKeys.filter((key) => {
			const packaged = renditionByKey.get(key);
			return (
				packaged !== undefined &&
				packaged.codec !== "WEBVTT" &&
				!AUDIO_CODECS.has(packaged.codec)
			);
		});
		if (
			videoInContainer.length === 1 &&
			videoInContainer[0] !== muxing.streamKey
		) {
			issues.push({
				code: "LIVE_MUXING_VIDEO_NOT_PRIMARY",
				level: "error",
				message: `muxing "${muxing.key}" muxes video rendition "${videoInContainer[0]}" behind a non-video primary — the video belongs in streamKey, with the audio in additionalStreamKeys`,
				path: `muxings[${index}].streamKey`,
			});
		}
		if (videoInContainer.length > 1) {
			issues.push({
				code: "LIVE_MUXING_MULTIPLE_VIDEO",
				level: "error",
				message: `muxing "${muxing.key}" packages ${videoInContainer.length} video renditions (${videoInContainer.join(", ")}) — a container carries at most one picture, with audio muxed alongside it`,
				path: `muxings[${index}].additionalStreamKeys`,
			});
		}
		if (!muxing.destination) {
			issues.push({
				code: "LIVE_MUXING_NO_DESTINATION",
				level: "error",
				message: `muxing "${muxing.key}" has no destination — live muxings always carry their output (no DRM resource exists to own it)`,
				path: `muxings[${index}]`,
			});
		} else if (!outputKeys.has(muxing.destination.outputKey)) {
			issues.push({
				code: "LIVE_UNRESOLVED_REF",
				level: "error",
				message: `muxing "${muxing.key}" references unknown output "${muxing.destination.outputKey}"`,
				path: `muxings[${index}].destination.outputKey`,
			});
		}
		if (muxing.kind === "MP4") {
			if (
				muxing.fragmentDuration !== undefined ||
				muxing.manifestType !== undefined ||
				muxing.dolbyVisionConfiguration !== undefined
			) {
				issues.push({
					code: "LIVE_MP4_PROGRESSIVE_ONLY",
					level: "error",
					path: `muxings[${index}]`,
					message: `MP4 archive "${muxing.key}" supports plain progressive MP4 only; omit fragmentDuration, manifestType and dolbyVisionConfiguration`,
				});
			}
			// Global mirrors retain their existing meaning; reject unsupported
			// targets rather than silently dropping a requested copy.
			const targets = [
				muxing.destination?.outputKey,
				...(plan.deliveryMirrors ?? []).map((mirror) => mirror.outputKey),
			];
			for (const outputKey of new Set(targets)) {
				const output = plan.outputs.find(
					(candidate) => candidate.key === outputKey,
				);
				if (
					output &&
					!["S3", "GENERIC_S3", "GCS", "GCS_SERVICE_ACCOUNT", "AZURE"].includes(
						output.kind,
					)
				) {
					issues.push({
						code: "LIVE_MP4_STORAGE_ONLY",
						level: "error",
						path: `muxings[${index}].destination`,
						message: `MP4 archive "${muxing.key}" reaches non-storage output "${outputKey}" (${output.kind}); use explicit storage and storage-only delivery mirrors`,
					});
				}
			}
		}
		// The matrix judges every packaged stream, not just the primary.
		for (const [at, streamKey] of containerKeys.entries()) {
			const packaged = renditionByKey.get(streamKey);
			if (
				packaged &&
				!(LIVE_MUXING_ALLOWED[muxing.kind] ?? []).includes(packaged.codec)
			) {
				issues.push({
					code: "LIVE_MUXING_CODEC_MISMATCH",
					level: "error",
					message: `muxing "${muxing.key}" (${muxing.kind}) cannot package the ${packaged.codec} rendition "${packaged.key}" — allowed: ${(LIVE_MUXING_ALLOWED[muxing.kind] ?? []).join("/")}`,
					path:
						at === 0
							? `muxings[${index}].streamKey`
							: `muxings[${index}].additionalStreamKeys[${at - 1}]`,
				});
			}
		}
	}
	for (const rendition of plan.renditions) {
		if (!muxedRenditions.has(rendition.key)) {
			// AUDIO is an error, the rest a warning — see plan/validate.ts for
			// why the asymmetry is principled. Live makes it worse: the channel
			// goes ON AIR silent, and every variant names an EXT-X-MEDIA group
			// that was never created, so the fault is invisible until a viewer
			// says so .
			const silentDrop =
				plan.muxings.length > 0 && AUDIO_CODECS.has(rendition.codec);
			issues.push({
				code: "LIVE_UNMUXED_RENDITION",
				level: silentDrop ? "error" : "warning",
				message: silentDrop
					? `audio rendition "${rendition.key}" is not referenced by any muxing — the channel would go on air silent`
					: `rendition "${rendition.key}" is not referenced by any muxing — it will be encoded but never packaged`,
				path: "renditions",
			});
		}
	}

	// Manifests: refs, non-empty DASH selection, segment-path stripping,
	// C8 budget, DVR-window consistency.
	const timeshiftValues = plan.liveManifests.map((m) => m.timeshift);
	const someTimeshift = timeshiftValues.some((t) => t !== undefined);
	for (const [index, manifest] of plan.liveManifests.entries()) {
		const unsupportedCmaf =
			manifest.kind === "HLS" &&
			plan.muxings.some((muxing) => {
				if (muxing.kind !== "CMAF") return false;
				const rendition = plan.renditions.find(
					(r) => r.key === muxing.streamKey,
				);
				if (!rendition) return false;
				const pin = LIVE_AUDIO_CODECS.has(rendition.codec)
					? manifest.audioMuxingKind
					: manifest.videoMuxingKind;
				return (
					pin === undefined &&
					!plan.muxings.some(
						(leg) =>
							leg.streamKey === muxing.streamKey &&
							["FMP4", "TS"].includes(leg.kind),
					)
				);
			});
		if (unsupportedCmaf) {
			issues.push({
				code: "LIVE_HLS_CMAF_UNSUPPORTED",
				level: "error",
				message:
					"CMAF muxings support DASH Template or Timeline; use fMP4 for HLS",
				path: `liveManifests[${index}]`,
			});
		}
		// Re-audit 2026-08-29 BLOCKER-5 : the Akamai MSL4 contract
		// — a manifest output path is EMPTY, or carries a leading AND a trailing
		// slash. The normal wizard used to send `output/<name>` and the edge
		// served 404 for every segment the master referenced; the compiler now
		// publishes MSL manifests at the event root and the segments keep their
		// own prefix under the muxing destinations.
		const mslPrimary = plan.outputs.find(
			(o) =>
				o.key === manifest.destination.outputKey && o.kind === "AKAMAI_MSL",
		);
		if (mslPrimary) {
			const p = manifest.destination.path;
			if (!(p === "" || /^\/.+\/$/.test(p))) {
				issues.push({
					code: "LIVE_MSL_MANIFEST_PATH",
					level: "error",
					message: `liveManifest "${manifest.key}" writes to Akamai MSL output "${mslPrimary.key}" with manifest path "${p}" — MSL4 requires an EMPTY manifest path (the event root) or one with a leading and a trailing slash; segments keep their own prefix under the muxing destinations`,
					path: `liveManifests[${index}].destination.path`,
				});
			}
		}
		if (!outputKeys.has(manifest.destination.outputKey)) {
			issues.push({
				code: "LIVE_UNRESOLVED_REF",
				level: "error",
				message: `liveManifest "${manifest.key}" references unknown output "${manifest.destination.outputKey}"`,
				path: `liveManifests[${index}].destination.outputKey`,
			});
		}
		const selected = selectLiveManifestMuxings(plan, manifest);
		if (
			manifest.kind === "HLS" &&
			plan.renditions.some((r) => LIVE_VIDEO_CODECS.has(r.codec)) &&
			!selected.some(({ rendition }) => LIVE_VIDEO_CODECS.has(rendition.codec))
		) {
			issues.push({
				code: "LIVE_HLS_VIDEO_UNSELECTED",
				level: "error",
				message: `HLS liveManifest "${manifest.key}" selects no supported video muxing despite video renditions — add an fMP4 or TS video leg matching videoMuxingKind`,
				path: `liveManifests[${index}].videoMuxingKind`,
			});
		}
		if (selected.length === 0) {
			// Both kinds: an empty playback manifest reaching START is the
			// silent-failure mode this codebase bans (DASH: TS legs cannot
			// join an MPD; HLS: muxing-kind pins can deselect every leg).
			issues.push(
				manifest.kind === "DASH"
					? {
							code: "LIVE_DASH_NO_REPRESENTATIONS",
							level: "error",
							message: `DASH liveManifest "${manifest.key}" would contain no representations — it selects fMP4 muxings only and the plan has none for it`,
							path: `liveManifests[${index}]`,
						}
					: {
							code: "LIVE_HLS_NO_ENTRIES",
							level: "error",
							message: `HLS liveManifest "${manifest.key}" would contain no media or variant entries — its videoMuxingKind/audioMuxingKind pins select none of the plan's muxing legs`,
							path: `liveManifests[${index}]`,
						},
			);
		}
		// Derived playlist uris are bitrate-keyed and unique PER RENDITION
		// , so the one collision
		// left is a rendition selected twice — TS+FMP4 legs with no
		// videoMuxingKind/audioMuxingKind pin select BOTH — and two legs on
		// one uri overwrite each other at the origin (silently broken
		// playback). Live has no uri override escape hatch (hlsMedia is
		// VOD-only), so this is an error, not a warning.
		if (manifest.kind === "HLS") {
			const entryUris = liveHlsEntryUris(plan);
			const byUri = new Map<string, string[]>();
			for (const { muxing, rendition } of selected) {
				const uri = entryUris.get(rendition.key) ?? liveHlsEntryUri(rendition);
				byUri.set(uri, [...(byUri.get(uri) ?? []), muxing.key]);
			}
			for (const [uri, muxingKeys] of byUri) {
				if (muxingKeys.length > 1) {
					issues.push({
						code: "LIVE_HLS_URI_COLLISION",
						level: "error",
						message: `HLS liveManifest "${manifest.key}" derives playlist uri "${uri}" for muxings ${muxingKeys.join(", ")} — they would overwrite each other; pin videoMuxingKind/audioMuxingKind so one leg is listed`,
						path: `liveManifests[${index}]`,
					});
				}
			}
		}
		// Mirrors PLAN_SEGMENT_PATH_NOT_UNDER_MANIFEST: segment paths the
		// manifest cannot strip are emitted absolute → broken players.
		const raw = manifest.destination.path;
		const base = raw === "" || raw.endsWith("/") ? raw : `${raw}/`;
		const outside = selected
			.filter(
				({ muxing }) =>
					muxing.destination && !muxing.destination.path.startsWith(base),
			)
			.map(({ muxing }) => muxing.key);
		if (outside.length > 0) {
			issues.push({
				code: "LIVE_SEGMENT_PATH_NOT_UNDER_MANIFEST",
				level: "warning",
				message: `muxing(s) ${outside.join(", ")} write outside liveManifest "${manifest.key}" base path — their segment paths will be emitted absolute`,
				path: `liveManifests[${index}].destination.path`,
			});
		}
		// C8 — element budget per manifest: Σ over enumerated muxing legs of
		// ceil(timeshift / segmentLength). NEVER clamped: the issue carries
		// the math, the author (or the UI gauge) decides.
		const timeshift = manifest.timeshift;
		if (timeshift !== undefined && selected.length > 0) {
			const totalElements = selected.reduce(
				(sum, { muxing }) =>
					sum +
					manifestElementEstimate({
						timeshiftSec: timeshift,
						segmentLengthSec: muxing.segmentLength,
						renditionCount: 1,
					}).totalElements,
				0,
			);
			const utilization = totalElements / LIVE_MANIFEST_ELEMENT_BUDGET;
			if (utilization > 1) {
				issues.push({
					code: "C8",
					level: "error",
					message: `liveManifest "${manifest.key}" needs ~${totalElements} manifest elements (Σ ceil(${timeshift}s timeshift / segmentLength) over ${selected.length} renditions) — over the ~${LIVE_MANIFEST_ELEMENT_BUDGET} budget. Shorten the timeshift, lengthen segments, or trim the ladder`,
					path: `liveManifests[${index}].timeshift`,
				});
			} else if (utilization > 0.8) {
				issues.push({
					code: "C8",
					level: "warning",
					message: `liveManifest "${manifest.key}" needs ~${totalElements} manifest elements (Σ ceil(${timeshift}s timeshift / segmentLength) over ${selected.length} renditions) — ${Math.round(utilization * 100)}% of the ~${LIVE_MANIFEST_ELEMENT_BUDGET} budget`,
					path: `liveManifests[${index}].timeshift`,
				});
			}
		}
		if (someTimeshift && manifest.timeshift === undefined) {
			issues.push({
				code: "LIVE_TIMESHIFT_INCONSISTENT",
				level: "warning",
				message: `liveManifest "${manifest.key}" has no timeshift while other manifests define a DVR window — players on this manifest cannot seek back`,
				path: `liveManifests[${index}].timeshift`,
			});
		}
	}

	// Auto-restart timeouts: schema enforces ≥30 on parse; duplicated for
	// TS-constructed plans (the API rejects shorter values).
	const autoRestart = plan.start.autoRestart;
	if (autoRestart) {
		const timeouts: [string, number | undefined][] = [
			["segmentsWrittenTimeout", autoRestart.segmentsWrittenTimeout],
			["bytesWrittenTimeout", autoRestart.bytesWrittenTimeout],
			["framesWrittenTimeout", autoRestart.framesWrittenTimeout],
			["hlsManifestsUpdateTimeout", autoRestart.hlsManifestsUpdateTimeout],
			["dashManifestsUpdateTimeout", autoRestart.dashManifestsUpdateTimeout],
		];
		for (const [field, value] of timeouts) {
			if (value !== undefined && value < 30) {
				issues.push({
					code: "LIVE_AUTORESTART_TIMEOUT",
					level: "error",
					message: `start.autoRestart.${field} is ${value}s — the API minimum is 30s`,
					path: `start.autoRestart.${field}`,
				});
			}
		}
	}

	/**
	 * LIVE_MUXING_UNREFERENCED  — a muxing
	 * that NO manifest selects.
	 *
	 * `LIVE_HLS_NO_ENTRIES` above only fires when a manifest selects NOTHING,
	 * so a PARTIAL loss was silent: an HLS manifest pinned to TS beside a video
	 * rung that is fMP4 selects the audio leg, stays non-empty, and drops the
	 * rung. The encoding still produces it and still writes it to the origin —
	 * paid for, delivered nowhere, and in no playlist.
	 *
	 * Found by a reviewer walking the real UI path: choose Akamai MSL (which
	 * sets the format's container and, in the first cut, a matching pin), go
	 * back to the ladder step, add a rendition — the new rung carries the
	 * schema default container and vanishes from the playlist with only a
	 * warning. The pins are gone now; this is the rail that catches the class
	 * rather than the instance, including a hand-edited plan that never touched
	 * the wizard.
	 *
	 * An error, not a warning: there is no reading under which encoding a
	 * rendition nobody can play is intended.
	 */
	const referenced = new Set<string>();
	for (const manifest of plan.liveManifests) {
		for (const { muxing } of selectLiveManifestMuxings(plan, manifest)) {
			referenced.add(muxing.key);
		}
	}
	for (const [index, muxing] of plan.muxings.entries()) {
		if (
			muxing.kind === "MP4" ||
			referenced.has(muxing.key) ||
			((muxing.kind === "FMP4" || muxing.kind === "CMAF") &&
				[
					muxing.destination?.outputKey,
					...(plan.deliveryMirrors?.map((m) => m.outputKey) ?? []),
				].some((key) =>
					plan.outputs.some(
						(o) => o.key === key && o.kind === "LIVE_MEDIA_INGEST",
					),
				))
		) {
			continue;
		}
		issues.push({
			code: "LIVE_MUXING_UNREFERENCED",
			level: "error",
			message: `muxing "${muxing.key}" (${muxing.kind}) is selected by no manifest — it would be encoded and written to the origin, and appear in no playlist. Check the manifest families this channel emits and any videoMuxingKind/audioMuxingKind pins`,
			path: `muxings[${index}]`,
		});
	}

	for (const [i, muxing] of plan.muxings.entries()) {
		// CmafMuxing lacks Fmp4Muxing.signalScte35AsEmsg in the pinned SDK.
		if (muxing.kind === "CMAF" && plan.adMarkers?.scte35)
			issues.push({
				code: "LIVE_CMAF_SCTE35_UNSUPPORTED",
				level: "error",
				path: `muxings[${i}]`,
				message:
					"CMAF muxings cannot signal SCTE-35 emsg boxes; use fMP4 for ad markers",
			});
		const targets = [
			muxing.destination?.outputKey,
			...(plan.deliveryMirrors?.map((m) => m.outputKey) ?? []),
		];
		if (
			muxing.kind !== "FMP4" &&
			muxing.kind !== "CMAF" &&
			targets.some((key) =>
				plan.outputs.some(
					(o) => o.key === key && o.kind === "LIVE_MEDIA_INGEST",
				),
			)
		)
			issues.push({
				code: "LIVE_MEDIA_INGEST_FMP4_ONLY",
				level: "error",
				path: `muxings.${i}`,
				message:
					"Live Media Ingest requires fMP4 or CMAF muxings; use a storage destination for archives",
			});
	}
	for (const [i, manifest] of plan.liveManifests.entries()) {
		const targets = [
			manifest.destination.outputKey,
			...(plan.deliveryMirrors?.map((m) => m.outputKey) ?? []),
		];
		if (
			targets.some((key) =>
				plan.outputs.some(
					(o) => o.key === key && o.kind === "LIVE_MEDIA_INGEST",
				),
			)
		)
			issues.push({
				code: "LIVE_MEDIA_INGEST_ORIGIN_MANIFESTS",
				level: "error",
				path: `liveManifests.${i}`,
				message:
					"The receiving Origin generates manifests; use a storage destination for Bitmovin manifests",
			});
	}

	// C31  — the SAME checker the VOD validator runs.
	//
	// This is the path the constraint exists for, and the first cut did not
	// reach it (review-4 #1): `liveChannelPlanSchema` reuses `planOutputSchema`
	// verbatim, so an MSL output parses here exactly as it does for VOD, while
	// validateLiveChannel builds a completely separate issue list. At the time
	// a pasted live plan was the only way to reach MSL at all (the wizard
	// gained a destination selector on 2026-08-18), so the check ran nowhere it
	// mattered. Live muxings always carry a
	// destination (LIVE_MUXING_NO_DESTINATION above), and the live plan has no
	// DRM, which is why that argument is simply absent. deliveryMirrors joined
	// the live schema 2026-08-23 (the MSL4+Object-Storage simultaneous case),
	// so mirrors now flow — an MSL output that receives everything AS A MIRROR
	// satisfies C31 through the checker's own mirror arm.
	issues.push(
		...checkAkamaiMslConstraints({
			encodingKind: "LIVE",
			credentialHasPublishingAuth: options.credentialHasPublishingAuth,
			outputs: plan.outputs,
			muxings: plan.muxings,
			manifests: plan.liveManifests,
			deliveryMirrors: plan.deliveryMirrors,
		}),
		...checkMslEncoderVersion(plan.outputs, plan.bitmovin.encoderVersion),
	);

	checkSecretEgressHosts(
		secretEgressSites(plan),
		options.secretEgressAllowedHosts,
		issues,
	);

	return issues;
}
