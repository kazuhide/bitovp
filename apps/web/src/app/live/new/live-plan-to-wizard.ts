import type { LiveChannelPlan } from "@bitovp/core";
import { liveChannelPlanSchema } from "@bitovp/core";
import { plansDeepEqual, readH26xCodecOptions } from "@bitovp/core/wizard";
import {
	buildLiveChannelPlan,
	collapseGroup,
	DEFAULT_LIVE_WIZARD_STATE,
	ingestInputPath,
	type LiveAdMarkerOptionsState,
	type LiveAudioRendition,
	type LiveDashManifestState,
	type LiveHlsManifestState,
	type LiveInputKind,
	type LiveMuxingOptions,
	type LiveVideoRendition,
	type LiveWizardState,
	liveManifestDestination,
} from "./build-live-plan";

/**
 * Inverse of buildLiveChannelPlan: rebuild an editable LiveWizardState from a
 * stored LiveChannelPlan, so a (typically failed) channel can be DUPLICATED
 * into the New Live Channel form and retried with edits. Round-trip contract
 * pinned by the live goldens:
 *
 *   buildLiveChannelPlan(planToLiveWizardState(plan)) deep-equals plan
 *
 * Real values (account, credentials, stream key) are preserved verbatim — the
 * point is to edit-and-retry, not to scrub. H264/H265 codec option groups use
 * the shared VOD readback; the exact round-trip gate below still rejects
 * structures that the Live form cannot represent.
 */

type Plan = LiveChannelPlan;
type LiveInput = Plan["liveInput"];
type Rendition = Plan["renditions"][number];
type VideoRendition = Extract<Rendition, { codec: "H264" } | { codec: "H265" }>;
type AudioRendition = Extract<
	Rendition,
	{ codec: "AAC" } | { codec: "DDPLUS" } | { codec: "DD" }
>;
// The rendition union is discriminated by codec (video = H264/H265, audio =
// AAC/DDPLUS/DD), so narrow on codec — ingestKey is the same field on both.
// These intentionally narrow to the LIVE-encodable codecs (matching what
// validateLiveChannel accepts); a VOD-only codec (VP9/Atmos/WebVTT) could only
// appear in a plan the live validator already rejects, so it could never have
// provisioned — dropping it on duplicate is moot, not a silent data loss.
const isVideoRendition = (r: Rendition): r is VideoRendition =>
	r.codec === "H264" || r.codec === "H265";
const isAudioRendition = (r: Rendition): r is AudioRendition =>
	r.codec === "AAC" || r.codec === "DDPLUS" || r.codec === "DD";

export function planToLiveWizardState(plan: Plan): LiveWizardState {
	const D = DEFAULT_LIVE_WIZARD_STATE;
	const muxingByKey = new Map(plan.muxings.map((m) => [m.key, m]));
	const containerOf = (key: string): "TS" | "CMAF" | undefined => {
		const kind = muxingByKey.get(key)?.kind;
		return kind === "TS" || kind === "CMAF" ? kind : undefined;
	};
	const cmafOf = (key: string) => {
		const muxing = muxingByKey.get(key);
		return muxing?.kind === "CMAF"
			? collapseGroup({
					initSegmentNameTemplate: muxing.initSegmentNameTemplate,
					framesPerCmafChunk: muxing.framesPerCmafChunk,
				})
			: undefined;
	};
	const firstSegmented = plan.muxings.find((m) => m.kind !== "MP4");
	const segmentLength = firstSegmented?.segmentLength ?? D.segmentLength;

	// Manifests can have independent folders. Recover the media base from its
	// video/{height}p or audio/{bitrate} suffix, not the first manifest's folder.
	const muxPath = plan.muxings.find(
		(muxing) =>
			muxing.kind !== "MP4" &&
			/(?:^|\/)(?:video|audio)\/[^/]+$/.test(muxing.destination?.path ?? ""),
	)?.destination?.path;
	const manifestPath = plan.liveManifests[0]?.destination?.path;
	const base =
		muxPath !== undefined
			? muxPath.split("/").slice(0, -2).join("/")
			: (manifestPath ?? "");
	const selections = new Map(plan.ingest.map((entry) => [entry.key, entry]));
	const inputOf = (rendition: Rendition, key: string, position: number) => {
		const selection = selections.get(rendition.ingestKey);
		return selection &&
			(rendition.ingestKey !== key ||
				selection.position !== position ||
				selection.inputPath !== ingestInputPath(plan.liveInput.kind))
			? { input: { ...selection } }
			: {};
	};

	/**
	 * The relation, copied off the plan .
	 *
	 * `additionalStreamKeys` per muxing IS the wizard's model now, so this
	 * reads rather than reconstructs. The previous version collapsed every
	 * carrier into one set and re-broadcast it, which is why a track carried by
	 * ONE rung came back on all of them and an audio-pair container's second
	 * track was re-homed into the video.
	 */
	const carriedByStreamKey = new Map<string, string[]>();
	for (const m of plan.muxings) {
		if (m.kind === "TS" && m.additionalStreamKeys) {
			carriedByStreamKey.set(m.streamKey, [...m.additionalStreamKeys]);
		}
	}
	const carriedAnywhere = new Set([...carriedByStreamKey.values()].flat());

	const videos: LiveVideoRendition[] = plan.renditions
		.filter(isVideoRendition)
		.map((r) => ({
			...inputOf(r, "video", 0),
			extras: {
				key: r.key,
				...("hlsVariantUri" in r && typeof r.hlsVariantUri === "string"
					? { hlsVariantUri: r.hlsVariantUri }
					: {}),
			},
			codec: r.codec,
			...(r.width !== undefined ? { width: r.width } : {}),
			...readH26xCodecOptions(r),
			height: r.height ?? null,
			bitrate: r.bitrate ?? null,
			// The plan always carries a name (derived or override); keep it — the
			// builder re-emits it as-is, so custom and derived names both round-trip.
			name: r.name,
			...(r.presetConfiguration
				? { presetConfiguration: r.presetConfiguration }
				: {}),
			...(containerOf(r.key) ? { container: containerOf(r.key) } : {}),
			...(cmafOf(r.key) ? { cmaf: cmafOf(r.key) } : {}),
			...(carriedByStreamKey.has(r.key)
				? { muxedAudioKeys: carriedByStreamKey.get(r.key) }
				: {}),
		}));

	/**
	 * Audio keys that ride inside a video container .
	 *
	 * `containerOf` looks a muxing up BY KEY, and a muxed-in track owns no
	 * muxing at all — so without this the readback would find nothing, fall
	 * back to fMP4, and re-open the channel as a DIFFERENT delivery than the
	 * one saved. Losing an operator's choice silently on reload is worse than
	 * failing to offer it.
	 */

	const audios: LiveAudioRendition[] = plan.renditions
		.filter(isAudioRendition)
		.map((r) => ({
			...inputOf(r, "audio", 1),
			extras: { key: r.key },
			codec: r.codec,
			bitrate: r.bitrate ?? 0,
			rate: r.rate ?? 0,
			...("cutoffFrequency" in r && r.cutoffFrequency !== undefined
				? { cutoffFrequency: r.cutoffFrequency }
				: {}),
			...(r.channelLayout ? { channelLayout: r.channelLayout } : {}),
			...(containerOf(r.key) ? { container: containerOf(r.key) } : {}),
			...(cmafOf(r.key) ? { cmaf: cmafOf(r.key) } : {}),
			// Carried but owning no container of its own: the classic muxed
			// layout, and it has to be said explicitly because absent means
			// "build one".
			...(carriedAnywhere.has(r.key) &&
			!plan.muxings.some((m) => m.streamKey === r.key)
				? { container: "TS" as const, ownContainer: false as const }
				: {}),
		}));

	const hlsM = plan.liveManifests.find((m) => m.kind === "HLS");
	const dashM = plan.liveManifests.find((m) => m.kind === "DASH");
	const primaryKey =
		plan.muxings.find((m) => m.kind !== "MP4")?.destination?.outputKey ??
		plan.outputs[0]?.key;
	const primaryOutput = plan.outputs.find(
		(output) => output.key === primaryKey,
	);
	const primaryState = outputState(primaryOutput, base, D, plan);
	const defaultDestination = liveManifestDestination({
		...D,
		output: primaryState,
	});
	const adMarkerOptions = adMarkerOptionsState(plan.adMarkers);

	const state: LiveWizardState = {
		name: plan.name,
		accountId: plan.bitmovin?.accountId ?? "",
		cloudRegion: plan.bitmovin?.cloudRegion ?? D.cloudRegion,
		encoderVersion: plan.bitmovin?.encoderVersion ?? D.encoderVersion,
		// Encoding-level extras: absent plan keys leave the optional state
		// fields undefined so the rebuild emits nothing back (goldens stay
		// byte-identical). Empty labels are not representable (the builder
		// emits only non-empty) — dropping [] is a no-op on the wire.
		...(plan.bitmovin?.staticIpId
			? { staticIpId: plan.bitmovin.staticIpId }
			: {}),
		...(plan.bitmovin?.labels && plan.bitmovin.labels.length > 0
			? { labels: plan.bitmovin.labels }
			: {}),
		...(plan.bitmovin?.infrastructure
			? { infrastructure: plan.bitmovin.infrastructure }
			: {}),
		...inputState(plan.liveInput, D),
		output: primaryState,
		outputOrder: plan.outputs.map((output) => output.key),
		manifestOrder: plan.liveManifests.map((manifest) => manifest.key),
		ingestOrder: plan.ingest.map((selection) => selection.key),
		...(() => {
			const muxing = plan.muxings.find((m) => m.kind === "MP4");
			if (!muxing?.destination || muxing.additionalStreamKeys?.length !== 1)
				return {};
			const key = muxing.destination.outputKey;
			const separate =
				key !== primaryKey &&
				!plan.deliveryMirrors?.some((m) => m.outputKey === key);
			const output = separate
				? plan.outputs.find((o) => o.key === key)
				: undefined;
			return {
				archive: {
					muxing: { ...muxing, destination: muxing.destination },
					...(output
						? { output: outputState(output, muxing.destination.path, D, plan) }
						: {}),
				},
			};
		})(),
		// Live deliveryMirrors (2026-08-23): the mirror destination maps back
		// into the optional `mirror` state so Duplicate carries it — the plan's
		// mirror output is found BY KEY from deliveryMirrors, never by position.
		...(() => {
			const mirrors = (plan as { deliveryMirrors?: { outputKey: string }[] })
				.deliveryMirrors;
			if (!mirrors || mirrors.length === 0) {
				return {};
			}
			const mirrorOutput = plan.outputs.find(
				(o) => o.key === mirrors[0]?.outputKey,
			);
			return mirrorOutput
				? {
						mirror: outputState(mirrorOutput, base, D, plan),
						mirrorKey: mirrors[0]?.outputKey,
						additionalMirrors: mirrors.slice(1).flatMap((mirror) => {
							const output = plan.outputs.find(
								(candidate) => candidate.key === mirror.outputKey,
							);
							return output
								? [
										{
											key: mirror.outputKey,
											output: outputState(output, base, D, plan),
										},
									]
								: [];
						}),
					}
				: {};
		})(),
		videos: videos.length > 0 ? videos : D.videos,
		audios: audios.length > 0 ? audios : D.audios,
		segmentLength,
		manifests: {
			hls: hlsM
				? readHlsManifest(hlsM, defaultDestination)
				: { ...D.manifests.hls, enabled: false },
			dash: dashM
				? readDashManifest(dashM, defaultDestination)
				: { ...D.manifests.dash, enabled: false },
			additionalHls: plan.liveManifests
				.filter(
					(m): m is Extract<Plan["liveManifests"][number], { kind: "HLS" }> =>
						m.kind === "HLS" && m !== hlsM,
				)
				.map((manifest) => readHlsManifest(manifest)),
			additionalDash: plan.liveManifests
				.filter(
					(m): m is Extract<Plan["liveManifests"][number], { kind: "DASH" }> =>
						m.kind === "DASH" && m !== dashM,
				)
				.map((manifest) => readDashManifest(manifest)),
		},
		// Absent adMarkers ⇒ off, so a plain plan rebuilds with no adMarkers key.
		scte35AdMarkers: plan.adMarkers?.scte35 === true,
		...(adMarkerOptions ? { adMarkerOptions } : {}),
		start: startState(plan.start, D),
	};
	const defaults = liveChannelPlanSchema.parse(buildLiveChannelPlan(state));
	for (const row of [...state.videos, ...state.audios]) {
		const muxing = plan.muxings.find((entry) => entry.key === row.extras?.key);
		const original = defaults.muxings.find(
			(entry) => entry.key === row.extras?.key,
		);
		if (
			!muxing ||
			muxing.kind === "MP4" ||
			!original ||
			original.kind === "MP4"
		)
			continue;
		const options: LiveMuxingOptions = {};
		if (muxing.segmentNamingTemplate !== undefined)
			options.segmentNamingTemplate = muxing.segmentNamingTemplate;
		else if (muxing.segmentNaming !== original.segmentNaming)
			options.segmentNaming = muxing.segmentNaming;
		if (
			muxing.kind === "FMP4" &&
			original.kind === "FMP4" &&
			muxing.initSegmentName !== original.initSegmentName
		)
			options.initSegmentName = muxing.initSegmentName;
		if (muxing.destination?.path !== original.destination?.path)
			options.path = muxing.destination?.path;
		if (Object.keys(options).length) row.muxing = options;
	}
	return state;
}

/**
 * Splits plan.adMarkers into the gate (boolean) + the carrier knobs. A plan
 * carrying only `{scte35}` yields undefined here, so the rebuild emits exactly
 * `{scte35: true}` again and pre-P5 plans stay byte-identical.
 */
function adMarkerOptionsState(
	adMarkers: Plan["adMarkers"],
): LiveAdMarkerOptionsState | undefined {
	if (!adMarkers) {
		return undefined;
	}
	const options: LiveAdMarkerOptionsState = {
		...(adMarkers.hlsMarkerTypes
			? { hlsMarkerTypes: adMarkers.hlsMarkerTypes }
			: {}),
		...(adMarkers.hlsDisablePreannouncing !== undefined
			? { hlsDisablePreannouncing: adMarkers.hlsDisablePreannouncing }
			: {}),
		...(adMarkers.dashPeriodOption
			? { dashPeriodOption: adMarkers.dashPeriodOption }
			: {}),
		...(adMarkers.dashEventStreamSignalling
			? { dashEventStreamSignalling: adMarkers.dashEventStreamSignalling }
			: {}),
	};
	return Object.keys(options).length > 0 ? options : undefined;
}

/** Output (S3 / Azure container / SFTP) → wizard output, with the recovered base. */
function outputState(
	o: Plan["outputs"][number] | undefined,
	base: string,
	D: LiveWizardState,
	plan: Plan,
): LiveWizardState["output"] {
	/**
	 * The ACL is per-destination in the plan but one switch in the form, exactly
	 * as VOD models it. Read it off the manifests: a plan whose manifests are
	 * public-read is a public-read channel, and if only some destinations carry
	 * it the round-trip gate will catch the divergence rather than this silently
	 * flattening it.
	 */
	const media = plan.muxings.filter(
		(m) => m.kind !== "MP4" && m.destination?.outputKey === o?.key,
	);
	const destinations = media.length
		? media
		: plan.liveManifests.filter((m) => m.destination.outputKey === o?.key);
	const publicRead = destinations.some(
		(m) => m.destination?.acl === "PUBLIC_READ",
	);
	// Origins generate their own manifests, so segmented media must also carry
	// this setting through readback. A progressive archive has an independent ACL.
	const privateAcl = destinations.some((m) => m.destination?.acl === "PRIVATE")
		? { explicitPrivateAcl: true }
		: {};
	if (!o) {
		return { ...D.output, basePath: base, publicRead, ...privateAcl };
	}
	/**
	 * AKAMAI_MSL  is carried through verbatim and re-emitted by
	 * `buildOutput`. It became editable on the output step on 2026-08-18; this
	 * mapping is what a Duplicate or an import brings in.
	 *
	 * The first cut returned the form's DEFAULT here and claimed "the
	 * round-trip gate then reports the divergence". It does not: that gate is a
	 * hardcoded list of seven fixture names which never included this one
	 * (review-5 I5). So Duplicate on an MSL channel silently presented a blank
	 * S3 form — asking for a bucket, which the operator would dutifully fill in
	 * — and produced an S3 channel where they meant MSL. Carrying the block
	 * makes the round-trip byte-exact, and the gate now derives its list from
	 * the fixture directory so it cannot go stale again.
	 */
	if (o.kind === "LIVE_MEDIA_INGEST")
		return {
			...D.output,
			basePath: base,
			publicRead: false,
			...privateAcl,
			kind: o.kind,
			credentialId: o.credentialId,
			name: o.name,
			scte35Passthrough: o.scte35Passthrough,
		};
	if (o.kind === "AKAMAI_MSL") {
		// . The identity rides the credential now, so this is the
		// same mapping every other kind gets — plus the delivery format, which
		// is a plan-level choice (C31).
		return {
			...D.output,
			basePath: base,
			publicRead,
			...privateAcl,
			kind: "AKAMAI_MSL" as const,
			credentialId: o.credentialId,
			name: o.name ?? "",
			mslStreamFormat: o.streamFormat,
			//  PR 1. Read back so Duplicate on an MSL5 channel does
			// not silently present an MSL4 form — the blank/wrong-form failure
			// this mapping exists to prevent, and the one the GENERIC_S3 note
			// below records paying for once already.
			mslVersion: o.mslVersion,
		};
	}
	// GENERIC_S3 / GCS / GCS_SERVICE_ACCOUNT joined 2026-08-23 (the Akamai
	// storage-primary fixture surfaced it): they fell through BOTH mappings to
	// empty strings, so Duplicate on such a channel presented a blank
	// credential + bucket — the exact silent-blank-form failure the MSL
	// docblock above records, one kind over.
	const bucket =
		o.kind === "AZURE"
			? o.container
			: o.kind === "S3" ||
					o.kind === "GENERIC_S3" ||
					o.kind === "GCS" ||
					o.kind === "GCS_SERVICE_ACCOUNT"
				? o.bucket
				: "";
	return {
		credentialId:
			o.kind === "SFTP" ||
			o.kind === "AKAMAI_NETSTORAGE" ||
			o.kind === "S3" ||
			o.kind === "AZURE" ||
			o.kind === "GENERIC_S3" ||
			o.kind === "GCS" ||
			o.kind === "GCS_SERVICE_ACCOUNT"
				? (o.credentialId ?? "")
				: "",
		kind: o.kind,
		publicRead,
		...privateAcl,
		bucket: bucket ?? "",
		basePath: base,
		name: o.name ?? "",
	};
}

function readHlsManifest(
	m: Extract<Plan["liveManifests"][number], { kind: "HLS" }>,
	defaultDestination?: LiveHlsManifestState["destination"],
): LiveHlsManifestState {
	return {
		enabled: true,
		key: m.key,
		name: m.name,
		destination: plansDeepEqual(m.destination, defaultDestination)
			? undefined
			: m.destination,
		manifestName: m.manifestName,
		audioGroupId: m.audioGroupId,
		audioLanguage: m.audioLanguage,
		closedCaptions: m.closedCaptions,
		videoMuxingKind: m.videoMuxingKind ?? "",
		audioMuxingKind: m.audioMuxingKind ?? "",
		timeshift: m.timeshift,
		liveEdgeOffset: m.liveEdgeOffset,
		insertProgramDateTime: m.insertProgramDateTime === true,
		...(m.insertProgramDateTime === false
			? { insertProgramDateTimeExplicit: true }
			: {}),
		programDateTimeSettings: m.programDateTimeSettings,
	};
}

function readDashManifest(
	m: Extract<Plan["liveManifests"][number], { kind: "DASH" }>,
	defaultDestination?: LiveDashManifestState["destination"],
): LiveDashManifestState {
	return {
		enabled: true,
		key: m.key,
		name: m.name,
		destination: plansDeepEqual(m.destination, defaultDestination)
			? undefined
			: m.destination,
		manifestName: m.manifestName,
		audioLanguage: m.audioLanguage,
		representationType: m.representationType,
		timeshift: m.timeshift,
		liveEdgeOffset: m.liveEdgeOffset,
		suggestedPresentationDelay: m.suggestedPresentationDelay,
		minimumUpdatePeriod: m.minimumUpdatePeriod,
		availabilityStartTimeMode: m.availabilityStartTimeMode ?? "",
	};
}

/** liveInput (discriminated by kind) → inputKind + the matching config slice. */
function inputState(
	li: LiveInput,
	D: LiveWizardState,
): Pick<
	LiveWizardState,
	"inputKind" | "rtmp" | "redundantRtmp" | "srt" | "zixi" | "hlsIn"
> {
	const slice = {
		inputKind: li.kind as LiveInputKind,
		rtmp: D.rtmp,
		redundantRtmp: D.redundantRtmp,
		srt: D.srt,
		zixi: D.zixi,
		hlsIn: D.hlsIn,
	};
	if (li.kind === "RTMP") {
		// : a pinned id round-trips verbatim; absent ⇒ "" ⇒ no key.
		slice.rtmp = { inputId: li.inputId ?? "" };
	} else if (li.kind === "REDUNDANT_RTMP") {
		const dynamic = (li.ingestPoints?.length ?? 0) > 0;
		slice.redundantRtmp = {
			name: li.name ?? "",
			...(li.delayThreshold !== undefined
				? { delayThreshold: li.delayThreshold }
				: {}),
			pointsMode: dynamic ? "DYNAMIC" : "STATIC",
			ingestPoints: dynamic
				? (li.ingestPoints ?? []).map((p) => ({
						applicationName: p.applicationName,
						streamKey: p.streamKey,
					}))
				: D.redundantRtmp.ingestPoints,
			staticIngestPoints: dynamic
				? []
				: (li.staticIngestPoints ?? []).map((p) => ({
						name: p.name ?? "",
						streamKeyType: p.streamKeyConfiguration?.type ?? "",
						streamKeyId: p.streamKeyConfiguration?.streamKeyId ?? "",
					})),
		};
	} else if (li.kind === "SRT") {
		slice.srt = {
			name: li.name ?? "",
			mode: li.mode === "CALLER" ? "CALLER" : "LISTENER",
			host: li.host ?? "",
			listenerPort: li.mode === "LISTENER" ? li.port : D.srt.listenerPort,
			...(li.mode === "CALLER" ? { callerPort: li.port } : {}),
			path: li.path ?? "",
			...(li.latency !== undefined ? { latency: li.latency } : {}),
			credentialId: li.credentialId ?? "",
			keyLength: li.keyLength === 128 ? 128 : 256,
			...(li.backup?.delayThreshold !== undefined
				? { backupDelayThreshold: li.backup.delayThreshold }
				: {}),
			backups: (li.backup?.srtInputs ?? []).map((b) => ({
				mode: b.mode === "CALLER" ? "CALLER" : "LISTENER",
				host: b.host ?? "",
				...(b.path !== undefined ? { path: b.path } : {}),
				...(b.port !== undefined ? { port: b.port } : {}),
				...(b.latency !== undefined ? { latency: b.latency } : {}),
				credentialId: b.credentialId ?? "",
				keyLength: b.keyLength === 128 ? 128 : 256,
			})),
		};
	} else if (li.kind === "ZIXI") {
		slice.zixi = {
			name: li.name ?? "",
			host: li.host,
			...(li.port !== undefined ? { port: li.port } : {}),
			stream: li.stream,
			credentialId: li.credentialId ?? "",
			...(li.latency !== undefined ? { latency: li.latency } : {}),
			...(li.minBitrate !== undefined ? { minBitrate: li.minBitrate } : {}),
			decryptionType: li.decryptionType ?? "",
		};
	} else if (li.kind === "HLS") {
		slice.hlsIn = {
			name: li.name ?? "",
			url: li.url ?? "",
			adMarkersSource: li.adMarkersSource ?? "",
		};
	}
	return slice;
}

/** start block (optional groups absent in minimal plans) → wizard start state. */
function startState(
	s: Plan["start"],
	D: LiveWizardState,
): LiveWizardState["start"] {
	const ar = s.autoRestart;
	const as = s.autoShutdown;
	return {
		...(s.encodingOption !== undefined
			? { encodingOption: s.encodingOption }
			: {}),
		streamKey: s.streamKey,
		liveEncodingMode: s.liveEncodingMode ?? "",
		autoRestart: ar
			? {
					...(ar.segmentsWrittenTimeout !== undefined
						? { segmentsWrittenTimeout: ar.segmentsWrittenTimeout }
						: {}),
					...(ar.bytesWrittenTimeout !== undefined
						? { bytesWrittenTimeout: ar.bytesWrittenTimeout }
						: {}),
					...(ar.framesWrittenTimeout !== undefined
						? { framesWrittenTimeout: ar.framesWrittenTimeout }
						: {}),
					...(ar.hlsManifestsUpdateTimeout !== undefined
						? { hlsManifestsUpdateTimeout: ar.hlsManifestsUpdateTimeout }
						: {}),
					...(ar.dashManifestsUpdateTimeout !== undefined
						? { dashManifestsUpdateTimeout: ar.dashManifestsUpdateTimeout }
						: {}),
					scheduleExpression: ar.scheduleExpression ?? "",
					restartOnEncoderError: ar.restartOnEncoderError,
				}
			: D.start.autoRestart,
		autoShutdown: as
			? {
					...(as.bytesReadTimeoutSeconds !== undefined
						? { bytesReadTimeoutSeconds: as.bytesReadTimeoutSeconds }
						: {}),
					...(as.streamTimeoutMinutes !== undefined
						? { streamTimeoutMinutes: as.streamTimeoutMinutes }
						: {}),
					...(as.waitingForFirstConnectTimeoutMinutes !== undefined
						? {
								waitingForFirstConnectTimeoutMinutes:
									as.waitingForFirstConnectTimeoutMinutes,
							}
						: {}),
				}
			: D.start.autoShutdown,
		reupload: s.reupload
			? {
					...(s.reupload.dashManifestInterval !== undefined
						? { dashManifestInterval: s.reupload.dashManifestInterval }
						: {}),
					...(s.reupload.muxingInitFileInterval !== undefined
						? { muxingInitFileInterval: s.reupload.muxingInitFileInterval }
						: {}),
				}
			: D.start.reupload,
		// P5 PR-3 groups: the state IS the SDK shape, so they carry back verbatim
		// (absent ⇒ the field stays unset and the rebuild emits no plan key).
		...(s.esam ? { esam: s.esam } : {}),
		...(s.cacheControl ? { cacheControl: s.cacheControl } : {}),
		...(s.adInsertion ? { adInsertion: s.adInsertion } : {}),
	};
}

/**
 * Why the reason is a KEY and not a sentence: the caller renders it, and the
 * two failures are different facts. "No longer a valid live plan" is the plan
 * being broken; "uses options the form cannot represent" is the FORM being
 * narrower than the plan, which is not the operator's fault and must not read
 * like corruption.
 */
export type LiveChannelImportReasonKey =
	| "uiX.couldNotDuplicateInvalidPlan"
	| "uiX.couldNotDuplicateUnrepresentedOptions";

export type LiveChannelImportResult =
	| { ok: true; state: LiveWizardState }
	| { ok: false; reasonKey: LiveChannelImportReasonKey };

/**
 * The round-trip gate for Duplicate channel — the LIVE twin of
 * `tryImportPresetIntoWizard` .
 *
 * VOD refused to load a plan the form could not rebuild EXACTLY and said so.
 * Live had no such gate: `live-wizard.tsx` called `planToLiveWizardState` and
 * `setState` directly, so any fact the readback could not carry was dropped in
 * silence and the operator duplicated a DIFFERENT channel than the one they
 * clicked. Three were measured, all validating with zero errors:
 *
 *  - audio muxed into ONE ladder rung came back muxed into ALL of them, adding
 *    a track to rungs the operator never touched;
 *  - a track with both its own container and a muxed ride lost the container,
 *    taking the DASH audio representation with it;
 *  - an audio-primary container's second track was re-homed into the video.
 *
 * The narrow guards close the causes we know about. This closes the CLASS:
 * anything the readback cannot carry — today's or a future field's — is
 * refused with a reason instead of shipped as a silent rewrite. That is the
 * asymmetry worth paying for: refusing a channel the form could have opened
 * costs one manual re-entry, and opening one it could not costs a channel that
 * goes on air different from the one that was duplicated.
 *
 * Compared with `plansDeepEqual` rather than a local equality so the two gates
 * cannot answer differently — it is the same undefined-as-absent rule the VOD
 * side has always used.
 */
export function tryImportLiveChannelIntoWizard(
	raw: unknown,
): LiveChannelImportResult {
	const parsed = liveChannelPlanSchema.safeParse(raw);
	if (!parsed.success) {
		return { ok: false, reasonKey: "uiX.couldNotDuplicateInvalidPlan" };
	}
	let state: LiveWizardState;
	let rebuilt: unknown;
	try {
		state = planToLiveWizardState(parsed.data);
		rebuilt = liveChannelPlanSchema.parse(buildLiveChannelPlan(state));
	} catch {
		// The rebuild not even PARSING is the same answer as a mismatch: the
		// form cannot express this channel. Separating them would give the
		// operator a distinction they cannot act on.
		return {
			ok: false,
			reasonKey: "uiX.couldNotDuplicateUnrepresentedOptions",
		};
	}
	if (!plansDeepEqual(rebuilt, parsed.data)) {
		return {
			ok: false,
			reasonKey: "uiX.couldNotDuplicateUnrepresentedOptions",
		};
	}
	return { ok: true, state };
}
