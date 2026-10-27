/**
 * : manifests members extracted VERBATIM from sdk-ops.ts. The
 * Pick<SdkOps, …> return type restores the contextual typing the members had
 * inside the monolithic literal; facade-freeze.test.ts pins the union.
 */
import {
	AdaptationSetRole,
	AudioAdaptationSet,
	AudioMediaInfo,
	ChannelsAttributeForAudio,
	ClosedCaptionsMediaInfo,
	ConditionOperator,
	ContentProtection,
	CustomTag,
	CustomXmlElement,
	DashChunkedTextRepresentation,
	DashCmafRepresentation,
	DashEditionCompatibility,
	DashFmp4DrmRepresentation,
	DashFmp4Representation,
	DashImscRepresentation,
	DashISO8601TimestampFormat,
	DashManifest,
	DashManifestDefault,
	DashManifestDefaultVersion,
	DashMp4DrmRepresentation,
	DashMp4Representation,
	DashOnDemandRepresentationType,
	DashProfile,
	DashProgressiveWebmRepresentation,
	DashRepresentationType,
	DashRepresentationTypeMode,
	DashVttRepresentation,
	DashWebmRepresentation,
	DefaultManifestAndCondition,
	DefaultManifestAttributeCondition,
	DefaultManifestOrCondition,
	HlsManifest,
	HlsManifestDefault,
	HlsManifestDefaultVersion,
	HlsTargetDurationRoundingMode,
	HlsVersion,
	IFramePlaylist,
	ImageAdaptationSet,
	ManifestGenerator,
	Period,
	PositionMode,
	SmoothManifestContentProtection,
	SmoothStreamingManifest,
	SmoothStreamingRepresentation,
	SpriteRepresentation,
	StartManifestRequest,
	StreamInfo,
	SubtitleAdaptationSet,
	SubtitlesMediaInfo,
	VariantStreamDroppingMode,
	VideoAdaptationSet,
	VideoMediaInfo,
	VttMediaInfo,
} from "@bitmovin/api-sdk";
import type {
	DashAdaptationOptions,
	DashGlobalOptions,
	HlsGlobalOptions,
	HlsStreamOptions,
	ManifestCondition,
} from "@bitovp/core";
import {
	EXTERNAL_VTT_URL_REQUIREMENT,
	externalVttUrlSchema,
} from "@bitovp/core";
import type { SdkOps } from "../sdk-ops";
import type { OpsContext } from "./context";
import { createOwnedDefaultDashManifest } from "./default-dash-manifest";
import { createOwnedDefaultHlsManifest } from "./default-hls-manifest";
import {
	adoptOrCreateManifest,
	findManifestByOutput,
	isBitmovinError,
	optEnum,
	outputs,
	sdkEnumValue,
	taskResult,
} from "./shared";

export function createManifestOps(
	ctx: OpsContext,
): Pick<
	SdkOps,
	| "createHlsVideoMedia"
	| "createHlsClosedCaptionsMedia"
	| "createHlsVttMedia"
	| "createHlsCustomTag"
	| "createDashPeriodXml"
	| "createDashImageAdaptationSet"
	| "createDashProgressiveWebmRepresentation"
	| "createDashVttRepresentation"
	| "createDashSpriteRepresentation"
	| "createDefaultHlsManifest"
	| "createDefaultDashManifest"
	| "createHlsManifest"
	| "createHlsAudioMedia"
	| "createHlsStreamInfo"
	| "createHlsSubtitlesMedia"
	| "createHlsIframePlaylist"
	| "createDashManifest"
	| "createDashPeriod"
	| "createDashVideoAdaptationSet"
	| "createDashAudioAdaptationSet"
	| "createDashSubtitleAdaptationSet"
	| "createDashChunkedTextRepresentation"
	| "createDashImscRepresentation"
	| "createDashCmafRepresentation"
	| "createDashFmp4Representation"
	| "createDashWebmRepresentation"
	| "createDashMp4Representation"
	| "createDashContentProtection"
	| "createSmoothManifest"
	| "createSmoothMp4Representation"
	| "createSmoothContentProtection"
	| "startHlsManifest"
	| "getHlsManifestStatus"
	| "deleteHlsManifest"
	| "startDashManifest"
	| "getDashManifestStatus"
	| "deleteDashManifest"
	| "startSmoothManifest"
	| "getSmoothManifestStatus"
> {
	const { api, audited, id, options, record } = ctx;
	return {
		/**
		 * Default manifests adopt by ENCODING ID — S6's rule from the manifest
		 * docblock above: live outputs are per-CHANNEL, not per-run, so a
		 * name+output key would let the second recording adopt the FIRST
		 * recording's manifest. The encodingId filter is server-side
		 * ({Hls,Dash}ManifestListQueryParams.encodingId, SDK-verified);
		 * manifestName + destination then narrow WITHIN the encoding, so a
		 * deliberate live-to-VOD re-run to a DIFFERENT path still creates
		 * fresh. This endpoint family is also the one OBSERVED losing
		 * responses on a real account ("Premature close", below), so
		 * adopt-before-create unconditionally — the manifest discipline, not
		 * the crash-window one.
		 */
		createHlsVideoMedia: (manifestId, p) =>
			audited(
				"POST",
				`/encoding/manifests/hls/${manifestId}/media/video`,
				p,
				() =>
					api.encoding.manifests.hls.media.video.create(
						manifestId,
						new VideoMediaInfo(p),
					),
				(r) => ({ id: r.id }),
			).then(id),
		createHlsClosedCaptionsMedia: (manifestId, p) =>
			audited(
				"POST",
				`/encoding/manifests/hls/${manifestId}/media/closed-captions`,
				p,
				() =>
					api.encoding.manifests.hls.media.closedCaptions.create(
						manifestId,
						new ClosedCaptionsMediaInfo(p),
					),
				(r) => ({ id: r.id }),
			).then(id),
		createHlsVttMedia: async (manifestId, p) => {
			const request = publicVttRequest(p);
			return audited(
				"POST",
				`/encoding/manifests/hls/${manifestId}/media/vtt`,
				request,
				() =>
					api.encoding.manifests.hls.media.vtt.create(
						manifestId,
						new VttMediaInfo(request),
					),
				(r) => ({ id: r.id }),
			).then(id);
		},
		createHlsCustomTag: (manifestId, parentId, target, p) =>
			audited(
				"POST",
				`/encoding/manifests/hls/${manifestId}/${target === "MEDIA" ? "media" : "streams"}/${parentId}/custom-tags`,
				p,
				() =>
					(target === "MEDIA"
						? api.encoding.manifests.hls.media.customTags
						: api.encoding.manifests.hls.streams.customTags
					).create(
						manifestId,
						parentId,
						new CustomTag({
							...p,
							positionMode: sdkEnumValue(
								PositionMode,
								p.positionMode,
								"PositionMode",
							),
						}),
					),
				(r) => ({ id: r.id }),
			).then(id),
		createDashPeriodXml: (manifestId, periodId, data) =>
			audited(
				"POST",
				`/encoding/manifests/dash/${manifestId}/periods/${periodId}/custom-xml-elements`,
				{ data },
				() =>
					api.encoding.manifests.dash.periods.customXmlElements.create(
						manifestId,
						periodId,
						new CustomXmlElement({ data }),
					),
				(r) => ({ id: r.id }),
			).then(id),
		createDashImageAdaptationSet: (manifestId, periodId, p) =>
			audited(
				"POST",
				`/encoding/manifests/dash/${manifestId}/periods/${periodId}/adaptationsets/image`,
				p,
				() =>
					api.encoding.manifests.dash.periods.adaptationsets.image.create(
						manifestId,
						periodId,
						new ImageAdaptationSet(adaptationOptions(p)),
					),
				(r) => ({ id: r.id }),
			).then(id),
		createDashProgressiveWebmRepresentation: (manifestId, periodId, setId, p) =>
			audited(
				"POST",
				`/encoding/manifests/dash/${manifestId}/periods/${periodId}/adaptationsets/${setId}/representations/progressive-webm`,
				p,
				() =>
					api.encoding.manifests.dash.periods.adaptationsets.representations.progressiveWebm.create(
						manifestId,
						periodId,
						setId,
						new DashProgressiveWebmRepresentation(p),
					),
				(r) => ({ id: r.id }),
			).then(id),
		createDashVttRepresentation: async (manifestId, periodId, setId, p) => {
			const request = publicVttRequest(p);
			return audited(
				"POST",
				`/encoding/manifests/dash/${manifestId}/periods/${periodId}/adaptationsets/${setId}/representations/vtt`,
				request,
				() =>
					api.encoding.manifests.dash.periods.adaptationsets.representations.vtt.create(
						manifestId,
						periodId,
						setId,
						new DashVttRepresentation(request),
					),
				(r) => ({ id: r.id }),
			).then(id);
		},
		createDashSpriteRepresentation: (manifestId, periodId, setId, p) =>
			audited(
				"POST",
				`/encoding/manifests/dash/${manifestId}/periods/${periodId}/adaptationsets/${setId}/representations/sprite`,
				p,
				() =>
					api.encoding.manifests.dash.periods.adaptationsets.representations.sprite.create(
						manifestId,
						periodId,
						setId,
						new SpriteRepresentation(p),
					),
				(r) => ({ id: r.id }),
			).then(id),
		createDefaultHlsManifest: async (p) => {
			const request = new HlsManifestDefault({
				...hlsGlobals(p),
				hlsMasterPlaylistVersion: optEnum(
					HlsVersion,
					p.masterVersion,
					"HlsVersion",
				),
				hlsMediaPlaylistVersion: optEnum(
					HlsVersion,
					p.mediaVersion,
					"HlsVersion",
				),
				encodingId: p.encodingId,
				manifestName: p.manifestName,
				name: p.name,
				outputs: outputs(p.destination),
				version: optEnum(
					HlsManifestDefaultVersion,
					p.version,
					"HlsManifestDefaultVersion",
				),
			});
			return createOwnedDefaultHlsManifest(ctx, p, request);
		},

		createDefaultDashManifest: async (p) => {
			if (p.periods === undefined && !p.encodingId)
				throw new Error(
					"Default DASH requires an encodingId or an explicit period list",
				);
			const request = new DashManifestDefault({
				...dashGlobals(p),
				profile: optEnum(DashProfile, p.profile, "DashProfile"),
				periods: p.periods?.map((period) => ({
					encodingIds: period.encodingIds,
					adaptationSets: period.adaptationSets?.map(sdkCondition),
				})),
				encodingId: p.encodingId,
				manifestName: p.manifestName,
				name: p.name,
				outputs: outputs(p.destination),
				version: optEnum(
					DashManifestDefaultVersion,
					p.version,
					"DashManifestDefaultVersion",
				),
			});
			return createOwnedDefaultDashManifest(ctx, p, request);
		},

		/**
		 * Look BEFORE creating. Observed on a real account: this endpoint creates the
		 * manifest and then loses its RESPONSE — undici reports `Premature close`
		 * while the dashboard shows the manifest present. Nineteen other POSTs in the
		 * same run return normally, so it is specific to this response, not the key,
		 * the payload (docs confirm the version fields are valid on create) or the
		 * transport (the same POST unauthenticated returns 401 with a readable body
		 * from both host and container).
		 *
		 * Retrying cannot fix that: each attempt succeeds server-side and loses its
		 * answer, so it only piles up duplicates. Adopting an existing manifest does
		 * fix it, and doing the lookup FIRST — rather than only after a failure —
		 * means a resumed job stops adding one more orphan per attempt.
		 *
		 * The key is `manifestName` + `outputId` + `outputPath`. The output is created
		 * per job and reused by that job's resumes, so it identifies "this job's
		 * manifest" without threading a job id through `SdkOps`.
		 *
		 * `outputPath` is load-bearing, and its absence was a review catch: every one of
		 * the 66 VOD fixtures names its HLS manifest `stream.m3u8` (it is the schema
		 * default, and the wizard's extra-manifest row hints "Default \"stream.m3u8\""),
		 * and primary and extra manifests share one output. Without the path in the key,
		 * a plan with two HLS manifests at different paths on one output created only
		 * the FIRST and hung the second's variants on it — a silent wrong artefact,
		 * which is worse than the duplicate this adoption exists to prevent.
		 *
		 * The lookup also cannot be allowed to FAIL the step: a delivered 503 or a key
		 * without manifest-list scope would break the very step this hardens, so a
		 * failed list degrades to "create anyway", the pre-adoption behaviour.
		 * .
		 */
		createHlsManifest: async (p) => {
			const lookup = () =>
				findManifestByOutput(
					(q) => api.encoding.manifests.hls.list(q),
					(m: HlsManifest) =>
						m.manifestName === p.manifestName &&
						(m.outputs ?? []).some(
							(o: { outputId?: string; outputPath?: string }) =>
								o.outputId === p.destination.outputId &&
								o.outputPath === p.destination.outputPath,
						),
					"HLS",
				);
			return adoptOrCreateManifest({
				label: "HLS",
				lookup,
				auditAdopt: (adoptedId, phase) =>
					record({
						method: "GET",
						path: "/encoding/manifests/hls",
						statusCode: 200,
						durationMs: 0,
						bitmovinAccountId: options.bitmovinAccountId,
						request: { adopted: p.manifestName, phase },
						response: { id: adoptedId },
					}),
				create: () =>
					audited(
						"POST",
						"/encoding/manifests/hls",
						{
							manifestName: p.manifestName,
							outputPath: p.destination.outputPath,
						},
						() =>
							api.encoding.manifests.hls.create(
								new HlsManifest({
									...hlsGlobals(p),
									manifestName: p.manifestName,
									name: p.name,
									hlsMasterPlaylistVersion: optEnum(
										HlsVersion,
										p.masterVersion,
										"HlsVersion",
									),
									hlsMediaPlaylistVersion: optEnum(
										HlsVersion,
										p.mediaVersion,
										"HlsVersion",
									),
									outputs: outputs(p.destination),
								}),
							),
						(r) => ({ id: r.id }),
					).then(id),
			});
		},

		createHlsAudioMedia: (manifestId, p) =>
			audited(
				"POST",
				`/encoding/manifests/hls/${manifestId}/media/audio`,
				{ groupId: p.groupId, uri: p.uri },
				() =>
					api.encoding.manifests.hls.media.audio.create(
						manifestId,
						new AudioMediaInfo(p),
					),
				(r) => ({ id: r.id }),
			).then(id),

		createHlsStreamInfo: (manifestId, p) =>
			audited(
				"POST",
				`/encoding/manifests/hls/${manifestId}/streams`,
				{ uri: p.uri },
				() =>
					api.encoding.manifests.hls.streams.create(
						manifestId,
						new StreamInfo({ ...p, ...streamOptions(p) }),
					),
				(r) => ({ id: r.id }),
			).then(id),

		createHlsSubtitlesMedia: (manifestId, p) =>
			audited(
				"POST",
				`/encoding/manifests/hls/${manifestId}/media/subtitles`,
				{ groupId: p.groupId, uri: p.uri },
				() =>
					api.encoding.manifests.hls.media.subtitles.create(
						manifestId,
						new SubtitlesMediaInfo(p),
					),
				(r) => ({ id: r.id }),
			).then(id),

		createHlsIframePlaylist: (manifestId, streamInfoId, p) =>
			audited(
				"POST",
				`/encoding/manifests/hls/${manifestId}/streams/${streamInfoId}/iframe`,
				p,
				() =>
					api.encoding.manifests.hls.streams.iframe.create(
						manifestId,
						streamInfoId,
						new IFramePlaylist({ filename: p.filename }),
					),
				(r) => ({ id: r.id }),
			).then(id),

		createDashManifest: async (p) => {
			const lookup = () =>
				findManifestByOutput(
					(q) => api.encoding.manifests.dash.list(q),
					(m: DashManifest) =>
						m.manifestName === p.manifestName &&
						(m.outputs ?? []).some(
							(o: { outputId?: string; outputPath?: string }) =>
								o.outputId === p.destination.outputId &&
								o.outputPath === p.destination.outputPath,
						),
					"DASH",
				);
			return adoptOrCreateManifest({
				label: "DASH",
				lookup,
				auditAdopt: (adoptedId, phase) =>
					record({
						method: "GET",
						path: "/encoding/manifests/dash",
						statusCode: 200,
						durationMs: 0,
						bitmovinAccountId: options.bitmovinAccountId,
						request: { adopted: p.manifestName, phase },
						response: { id: adoptedId },
					}),
				create: () =>
					audited(
						"POST",
						"/encoding/manifests/dash",
						{
							manifestName: p.manifestName,
							outputPath: p.destination.outputPath,
						},
						() =>
							api.encoding.manifests.dash.create(
								new DashManifest({
									...dashGlobals(p),
									manifestName: p.manifestName,
									name: p.name,
									profile: optEnum(DashProfile, p.profile, "DashProfile"),
									outputs: outputs(p.destination),
								}),
							),
						(r) => ({ id: r.id }),
					).then(id),
			});
		},

		createDashPeriod: (manifestId, start, duration) => {
			const payload = {
				...(start === undefined ? {} : { start }),
				...(duration === undefined ? {} : { duration }),
			};
			return audited(
				"POST",
				`/encoding/manifests/dash/${manifestId}/periods`,
				payload,
				() =>
					api.encoding.manifests.dash.periods.create(
						manifestId,
						new Period(payload),
					),
				(r) => ({ id: r.id }),
			).then(id);
		},

		createDashVideoAdaptationSet: (manifestId, periodId, p) =>
			audited(
				"POST",
				`/encoding/manifests/dash/${manifestId}/periods/${periodId}/adaptationsets/video`,
				p ?? {},
				() =>
					api.encoding.manifests.dash.periods.adaptationsets.video.create(
						manifestId,
						periodId,
						new VideoAdaptationSet(adaptationOptions(p)),
					),
				(r) => ({ id: r.id }),
			).then(id),

		createDashAudioAdaptationSet: (manifestId, periodId, p) =>
			audited(
				"POST",
				`/encoding/manifests/dash/${manifestId}/periods/${periodId}/adaptationsets/audio`,
				p,
				() =>
					api.encoding.manifests.dash.periods.adaptationsets.audio.create(
						manifestId,
						periodId,
						new AudioAdaptationSet({
							...adaptationOptions(p),
							lang: p.lang,
						}),
					),
				(r) => ({ id: r.id }),
			).then(id),

		createDashSubtitleAdaptationSet: (manifestId, periodId, p) =>
			audited(
				"POST",
				`/encoding/manifests/dash/${manifestId}/periods/${periodId}/adaptationsets/subtitle`,
				p,
				() =>
					api.encoding.manifests.dash.periods.adaptationsets.subtitle.create(
						manifestId,
						periodId,
						new SubtitleAdaptationSet({
							...adaptationOptions(p),
							lang: p.lang,
						}),
					),
				(r) => ({ id: r.id }),
			).then(id),
		createDashImscRepresentation: (manifestId, periodId, adaptationSetId, p) =>
			audited(
				"POST",
				`/encoding/manifests/dash/${manifestId}/periods/${periodId}/adaptationsets/${adaptationSetId}/representations/imsc`,
				p,
				() =>
					api.encoding.manifests.dash.periods.adaptationsets.representations.imsc.create(
						manifestId,
						periodId,
						adaptationSetId,
						new DashImscRepresentation(p),
					),
				(r) => ({ id: r.id }),
			).then(id),
		createDashChunkedTextRepresentation: (
			manifestId,
			periodId,
			adaptationSetId,
			p,
		) =>
			audited(
				"POST",
				`/encoding/manifests/dash/${manifestId}/periods/${periodId}/adaptationsets/${adaptationSetId}/representations/chunked-text`,
				p,
				() =>
					api.encoding.manifests.dash.periods.adaptationsets.representations.chunkedText.create(
						manifestId,
						periodId,
						adaptationSetId,
						new DashChunkedTextRepresentation({
							...p,
							mode: optEnum(
								DashRepresentationTypeMode,
								p.mode,
								"DashRepresentationTypeMode",
							),
							type: sdkEnumValue(
								DashRepresentationType,
								p.type,
								"DashRepresentationType",
							),
							encodingId: p.encodingId,
							muxingId: p.muxingId,
							segmentPath: p.segmentPath,
						}),
					),
				(r) => ({ id: r.id }),
			).then(id),
		createDashCmafRepresentation: (manifestId, periodId, adaptationSetId, p) =>
			audited(
				"POST",
				`/encoding/manifests/dash/${manifestId}/periods/${periodId}/adaptationsets/${adaptationSetId}/representations/cmaf`,
				{ segmentPath: p.segmentPath, type: p.type },
				() =>
					api.encoding.manifests.dash.periods.adaptationsets.representations.cmaf.create(
						manifestId,
						periodId,
						adaptationSetId,
						new DashCmafRepresentation({
							...p,
							mode: optEnum(
								DashRepresentationTypeMode,
								p.mode,
								"DashRepresentationTypeMode",
							),
							type: sdkEnumValue(
								DashRepresentationType,
								p.type,
								"DashRepresentationType",
							),
							encodingId: p.encodingId,
							muxingId: p.muxingId,
							segmentPath: p.segmentPath,
						}),
					),
				(r) => ({ id: r.id }),
			).then(id),

		createDashFmp4Representation: (manifestId, periodId, adaptationSetId, p) =>
			audited(
				"POST",
				`/encoding/manifests/dash/${manifestId}/periods/${periodId}/adaptationsets/${adaptationSetId}/representations/fmp4${p.drmId ? "/drm" : ""}`,
				{ segmentPath: p.segmentPath, type: p.type },
				() =>
					(p.drmId
						? api.encoding.manifests.dash.periods.adaptationsets.representations.fmp4.drm.create.bind(
								api.encoding.manifests.dash.periods.adaptationsets
									.representations.fmp4.drm,
							)
						: api.encoding.manifests.dash.periods.adaptationsets.representations.fmp4.create.bind(
								api.encoding.manifests.dash.periods.adaptationsets
									.representations.fmp4,
							))(
						manifestId,
						periodId,
						adaptationSetId,
						new (p.drmId ? DashFmp4DrmRepresentation : DashFmp4Representation)({
							...p,
							mode: optEnum(
								DashRepresentationTypeMode,
								p.mode,
								"DashRepresentationTypeMode",
							),
							type: sdkEnumValue(
								DashRepresentationType,
								p.type,
								"DashRepresentationType",
							),
							encodingId: p.encodingId,
							muxingId: p.muxingId,
							segmentPath: p.segmentPath,
						}),
					),
				(r) => ({ id: r.id }),
			).then(id),

		createDashWebmRepresentation: (manifestId, periodId, adaptationSetId, p) =>
			audited(
				"POST",
				`/encoding/manifests/dash/${manifestId}/periods/${periodId}/adaptationsets/${adaptationSetId}/representations/webm`,
				{ segmentPath: p.segmentPath, type: p.type },
				() =>
					api.encoding.manifests.dash.periods.adaptationsets.representations.webm.create(
						manifestId,
						periodId,
						adaptationSetId,
						new DashWebmRepresentation({
							...p,
							mode: optEnum(
								DashRepresentationTypeMode,
								p.mode,
								"DashRepresentationTypeMode",
							),
							type: sdkEnumValue(
								DashRepresentationType,
								p.type,
								"DashRepresentationType",
							),
							encodingId: p.encodingId,
							muxingId: p.muxingId,
							segmentPath: p.segmentPath,
						}),
					),
				(r) => ({ id: r.id }),
			).then(id),

		createDashMp4Representation: (manifestId, periodId, adaptationSetId, p) => {
			return audited(
				"POST",
				`/encoding/manifests/dash/${manifestId}/periods/${periodId}/adaptationsets/${adaptationSetId}/representations/mp4${p.drmId ? "/drm" : ""}`,
				{
					filePath: p.filePath,
					type: p.type,
					...(p.drmId ? { drmId: p.drmId } : {}),
				},
				() =>
					p.drmId
						? api.encoding.manifests.dash.periods.adaptationsets.representations.mp4.drm.create(
								manifestId,
								periodId,
								adaptationSetId,
								new DashMp4DrmRepresentation({
									dependencyId: p.dependencyId,
									type: sdkEnumValue(
										DashOnDemandRepresentationType,
										p.type,
										"DashOnDemandRepresentationType",
									),
									filePath: p.filePath,
									encodingId: p.encodingId,
									muxingId: p.muxingId,
									drmId: p.drmId,
								}),
							)
						: api.encoding.manifests.dash.periods.adaptationsets.representations.mp4.create(
								manifestId,
								periodId,
								adaptationSetId,
								new DashMp4Representation({
									dependencyId: p.dependencyId,
									type: sdkEnumValue(
										DashOnDemandRepresentationType,
										p.type,
										"DashOnDemandRepresentationType",
									),
									filePath: p.filePath,
									encodingId: p.encodingId,
									muxingId: p.muxingId,
								}),
							),
				(r) => ({ id: r.id }),
			).then(id);
		},

		createDashContentProtection: (path, p) => {
			const sets = api.encoding.manifests.dash.periods.adaptationsets;
			const reps = sets.representations;
			const args = [
				path.manifestId,
				path.periodId,
				path.adaptationSetId,
			] as const;
			const create = () => {
				if (path.representationKind === "ADAPTATION_SET")
					return sets.contentprotection.create(
						...args,
						new ContentProtection(p),
					);
				if (!path.representationId)
					throw new Error(
						"Representation content protection needs a representation",
					);
				const child =
					path.representationKind === "WEBM"
						? reps.webm.contentprotection
						: path.representationKind === "CMAF"
							? reps.cmaf.contentprotection
							: path.representationKind === "FMP4_DRM"
								? reps.fmp4.drm.contentprotection
								: reps.fmp4.contentprotection;
				return child.create(
					...args,
					path.representationId,
					new ContentProtection(p),
				);
			};
			const segment =
				path.representationKind === "FMP4_DRM"
					? "fmp4/drm"
					: path.representationKind.toLowerCase();
			return audited(
				"POST",
				`/encoding/manifests/dash/${path.manifestId}/periods/${path.periodId}/adaptationsets/${path.adaptationSetId}/${path.representationKind === "ADAPTATION_SET" ? "" : `representations/${segment}/${path.representationId}/`}contentprotection`,
				p,
				create,
				(r) => ({ id: r.id }),
			).then(id);
		},

		createSmoothManifest: async (p) => {
			const lookup = () =>
				findManifestByOutput(
					(q) => api.encoding.manifests.smooth.list(q),
					(m: SmoothStreamingManifest) =>
						m.serverManifestName === p.serverManifestName &&
						m.clientManifestName === p.clientManifestName &&
						(m.outputs ?? []).some(
							(o: { outputId?: string; outputPath?: string }) =>
								o.outputId === p.destination.outputId &&
								o.outputPath === p.destination.outputPath,
						),
					"Smooth",
				);
			return adoptOrCreateManifest({
				label: "Smooth",
				lookup,
				auditAdopt: (adoptedId, phase) =>
					record({
						method: "GET",
						path: "/encoding/manifests/smooth",
						statusCode: 200,
						durationMs: 0,
						bitmovinAccountId: options.bitmovinAccountId,
						request: { adopted: p.serverManifestName, phase },
						response: { id: adoptedId },
					}),
				create: () =>
					audited(
						"POST",
						"/encoding/manifests/smooth",
						{
							serverManifestName: p.serverManifestName,
							clientManifestName: p.clientManifestName,
							outputPath: p.destination.outputPath,
						},
						() =>
							api.encoding.manifests.smooth.create(
								new SmoothStreamingManifest({
									serverManifestName: p.serverManifestName,
									clientManifestName: p.clientManifestName,
									name: p.name,
									outputs: outputs(p.destination),
								}),
							),
						(r) => ({ id: r.id }),
					).then(id),
			});
		},

		createSmoothMp4Representation: (manifestId, p) =>
			audited(
				"POST",
				`/encoding/manifests/smooth/${manifestId}/representations/mp4`,
				p,
				() =>
					api.encoding.manifests.smooth.representations.mp4.create(
						manifestId,
						new SmoothStreamingRepresentation(p),
					),
				(r) => ({ id: r.id }),
			).then(id),

		createSmoothContentProtection: (manifestId, p) =>
			audited(
				"POST",
				`/encoding/manifests/smooth/${manifestId}/contentprotection`,
				p,
				() =>
					api.encoding.manifests.smooth.contentprotection.create(
						manifestId,
						new SmoothManifestContentProtection(p),
					),
				(r) => ({ id: r.id }),
			).then(id),

		startHlsManifest: (manifestId, p) =>
			audited(
				"POST",
				`/encoding/manifests/hls/${manifestId}/start`,
				p,
				() =>
					api.encoding.manifests.hls.start(
						manifestId,
						new StartManifestRequest({
							manifestGenerator: optEnum(
								ManifestGenerator,
								p.manifestGenerator,
								"ManifestGenerator",
							),
						}),
					),
				() => ({ started: true }),
			).then(() => undefined),

		getHlsManifestStatus: (manifestId) =>
			api.encoding.manifests.hls.status(manifestId).then(taskResult),

		/**
		 *  — compensating terminal cleanup for live-to-VOD. Audited
		 * like every other write (C7), and a 404 is success: the manifest this
		 * cleans up may already be gone, and "gone" is the state wanted.
		 */
		deleteHlsManifest: (manifestId) =>
			audited(
				"DELETE",
				`/encoding/manifests/hls/${manifestId}`,
				{},
				() => api.encoding.manifests.hls.delete(manifestId),
				() => ({ deleted: true }),
			).then(
				() => undefined,
				(err: unknown) => {
					if (isBitmovinError(err) && err.httpStatusCode === 404) {
						return undefined;
					}
					throw err;
				},
			),

		startDashManifest: (manifestId, p) =>
			audited(
				"POST",
				`/encoding/manifests/dash/${manifestId}/start`,
				p,
				() =>
					api.encoding.manifests.dash.start(
						manifestId,
						new StartManifestRequest({
							manifestGenerator: optEnum(
								ManifestGenerator,
								p.manifestGenerator,
								"ManifestGenerator",
							),
						}),
					),
				() => ({ started: true }),
			).then(() => undefined),

		getDashManifestStatus: (manifestId) =>
			api.encoding.manifests.dash.status(manifestId).then(taskResult),

		deleteDashManifest: (manifestId) =>
			audited(
				"DELETE",
				`/encoding/manifests/dash/${manifestId}`,
				{},
				() => api.encoding.manifests.dash.delete(manifestId),
				() => ({ deleted: true }),
			).then(
				() => undefined,
				(err: unknown) => {
					if (isBitmovinError(err) && err.httpStatusCode === 404) {
						return undefined;
					}
					throw err;
				},
			),

		startSmoothManifest: (manifestId, p) =>
			audited(
				"POST",
				`/encoding/manifests/smooth/${manifestId}/start`,
				p,
				() =>
					api.encoding.manifests.smooth.start(
						manifestId,
						new StartManifestRequest({
							manifestGenerator: optEnum(
								ManifestGenerator,
								p.manifestGenerator,
								"ManifestGenerator",
							),
						}),
					),
				() => ({ started: true }),
			).then(() => undefined),

		getSmoothManifestStatus: (manifestId) =>
			api.encoding.manifests.smooth.status(manifestId).then(taskResult),
	};
}

/** Validate before any provider call or audit, including callers that bypass plan parsing. */
function publicVttRequest<T extends { vttUrl: string }>(p: T): T {
	const url = externalVttUrlSchema.safeParse(p.vttUrl);
	if (!url.success) throw new Error(EXTERNAL_VTT_URL_REQUIREMENT);
	// Capture the validated value before an asynchronous caller can change its object.
	return { ...p, vttUrl: url.data };
}

function hlsGlobals(p: HlsGlobalOptions) {
	return {
		channelsAttributeForAudio: optEnum(
			ChannelsAttributeForAudio,
			p.channelsAttributeForAudio,
			"ChannelsAttributeForAudio",
		),
		targetDurationRoundingMode: optEnum(
			HlsTargetDurationRoundingMode,
			p.targetDurationRoundingMode,
			"HlsTargetDurationRoundingMode",
		),
	};
}
function dashGlobals(p: DashGlobalOptions) {
	return {
		dashEditionCompatibility: optEnum(
			DashEditionCompatibility,
			p.dashEditionCompatibility,
			"DashEditionCompatibility",
		),
		iso8601TimestampFormat: optEnum(
			DashISO8601TimestampFormat,
			p.iso8601TimestampFormat,
			"DashISO8601TimestampFormat",
		),
		minBufferTime: p.minBufferTime,
		namespaces: p.namespaces,
		utcTimings: p.utcTimings,
	};
}
function adaptationOptions(p?: DashAdaptationOptions) {
	return {
		labels: p?.labels,
		accessibilities: p?.accessibilities,
		customAttributes: p?.customAttributes,
		roles: p?.roles?.map((r) =>
			sdkEnumValue(AdaptationSetRole, r, "AdaptationSetRole"),
		),
	};
}
function streamOptions(p: HlsStreamOptions) {
	return {
		...p,
		audioGroups: p.audioGroups
			? {
					...p.audioGroups,
					droppingMode: sdkEnumValue(
						VariantStreamDroppingMode,
						p.audioGroups.droppingMode,
						"VariantStreamDroppingMode",
					),
				}
			: undefined,
	};
}
function sdkCondition(
	c: ManifestCondition,
):
	| DefaultManifestAttributeCondition
	| DefaultManifestAndCondition
	| DefaultManifestOrCondition {
	if (c.type === "CONDITION")
		return new DefaultManifestAttributeCondition({
			attribute: c.attribute,
			value: c.value,
			operator: sdkEnumValue(
				ConditionOperator,
				c.operator,
				"ConditionOperator",
			),
		});
	const conditions = c.conditions.map(sdkCondition);
	return c.type === "AND"
		? new DefaultManifestAndCondition({ conditions })
		: new DefaultManifestOrCondition({ conditions });
}
