import {
	dashAdaptationOptionsSchema,
	dashAdditionalRepresentationSchema,
	dashDetailedOptionsSchema,
	defaultDashPeriodSchema,
	hlsAdditionalMediaSchema,
	hlsDetailedOptionsSchema,
	hlsMediaAttributesSchema,
	hlsStreamOptionsSchema,
	liveDashDetailedOptionsSchema,
	liveHlsDetailedOptionsSchema,
} from "@bitovp/core";
import { z } from "zod";
import type { SessionDto } from "./auth/dto";

export type WizardDraftKind = "vod" | "live";
export type DraftValue = Record<string, unknown>;
type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export const WIZARD_DRAFT_TTL = 7 * 24 * 60 * 60 * 1000;
export const WIZARD_DRAFT_MAX_SIZE = 128_000;

export function draftIdentity(
	session: SessionDto | undefined,
): [string, string] | null {
	if (
		!session?.configured ||
		!session.authenticated ||
		session.isImpersonating ||
		session.organizationUnavailable
	)
		return null;
	if (session.mode === "users") {
		return session.organizationId &&
			session.effectiveUserId &&
			(session.role === "ADMIN" || session.role === "OPERATOR")
			? [session.organizationId, session.effectiveUserId]
			: null;
	}
	return session.mode === "password" || session.mode === "none"
		? [
				session.organizationId ?? "00000000-0000-4000-8000-000000000001",
				`main:${session.mode}`,
			]
		: null;
}

export function draftKey(
	identity: [string, string],
	kind: WizardDraftKind,
	context: string,
) {
	return `bitovp.wizard-draft:${JSON.stringify([...identity, kind, context])}`;
}

/** A local cache discriminator, never an authorization token or stored source document. */
export function draftFingerprint(value: unknown): string {
	let hash = 2166136261;
	for (const char of JSON.stringify(value) ?? "")
		hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
	return (hash >>> 0).toString(16);
}

// Explicit form shapes only. URLs, raw DRM keys, filter/options JSON and imported plans
// are deliberately absent; even a nested unknown property cannot enter storage.
const text = z
	.string()
	.max(2048)
	.refine((value) => !/\w+:\/\/|[?#]|^[^/\s]*:[^/\s]*@/u.test(value))
	.optional()
	.catch("");
const number = z.number().finite().nullable().optional().catch(undefined);
const flag = z.boolean().optional().catch(undefined);
const strings = z
	.array(text)
	.max(100)
	.transform((values) =>
		values.filter((value): value is string => typeof value === "string"),
	)
	.optional()
	.catch(undefined);
function fields(
	texts = "",
	numbers = "",
	flags = "",
	extra: Record<string, z.ZodType> = {},
) {
	const shape: Record<string, z.ZodType> = {};
	for (const [names, schema] of [
		[texts, text],
		[numbers, number],
		[flags, flag],
	] as const)
		for (const key of names.split(" ").filter(Boolean)) shape[key] = schema;
	return z.object({ ...shape, ...extra });
}
const group = (schema: z.ZodType) => schema.optional().catch(undefined);
const rows = (schema: z.ZodType) =>
	z.array(schema).max(100).optional().catch(undefined);
const location = fields(
	"credentialId kind bucket region basePath name mslStreamFormat mslVersion",
	"",
	"publicRead explicitPrivateAcl scte35Passthrough",
);
const cmaf = fields("initSegmentNameTemplate", "framesPerCmafChunk");
const color = fields(
	"colorSpace colorPrimaries colorTransfer",
	"",
	"copyColorPrimariesFlag copyColorTransferFlag copyColorSpaceFlag copyChromaLocationFlag copyColorRangeFlag",
);
const codec = fields(
	"motionCompensatedTemporalFiltering profile level maxLevel detailPreservationMode presetConfiguration trellis subMe motionEstimationMethod adaptiveQuantizationMode mvPredictionMode weightedPredictionPFrames dynamicRangeFormat maxCtuSize motionSearch tuIntraDepth tuInterDepth masterDisplay pixelFormat quality aqMode arnrType autoLevelSetup bAdapt bAdaptiveStrategy bPyramid forceFlush interlaceMode limitReferences limitTransformUnitDepthRecursion maximumTransformUnitSize minCodingUnitSize nalHrd quantizationGroupSize rateDistortionLevelForQuantization rateDistortionPenalty transformSkip videoFormat",
	"crf minBitrate minGop maxGop qp sampleAspectRatioNumerator sampleAspectRatioDenominator rate minKeyframeInterval maxKeyframeInterval slices mvSearchRangeMax rcLookahead sceneCutThreshold adaptiveQuantizationStrength psyRateDistortionOptimization psyTrellis refFrames bframes maxBitrate bufsize motionSearchRange psyRateDistortionOptimizedQuantization qpMin qpMax maxContentLightLevel maxPictureAverageLightLevel cpuUsed tileColumns rateUndershootPct rateOvershootPct arnrMaxFrames arnrStrength allowedRADLBeforeIDR bframeBias biasPct blurComplexity blurQuants clientBufferSize clientInitialBufferSize deblockAlpha deblockBeta dynamicRateDistortionStrength gopLookahead ipRatio lagInFrames lookaheadSlices maxIntraRate maxMerge noiseReductionInter noiseReductionIntra pbRatio qpOffsetChromaCb qpOffsetChromaCr qpStep quantizerCurveCompression quantizerCurveCompressionFactor rateDistortionLevelForModeDecision scenecutBias sharpness staticThresh targetLevel tileRows",
	"openGop strictCbr cabac adaptiveSpatialTransform levelHighTier weightPredictionOnPSlice weightPredictionOnBSlice sao hdr lossless adaptiveQuantizationMotion analyzeSourceFramePixels asymetricMotionPartitionsAnalysis automaticAltRefFramesEnabled codingUnitLossless constrainedIntraPrediction copyPicture cutree earlySkip enableHlgSignaling enableHrdSignaling errorResiliencyEnabled evaluationOfIntraModesInBSlices fastSearchForAngularIntraPredictions fastSkipDetectionPFrames frameParallel grainOptimizedRateControl limitModes limitSao lowpassDct macroblockTreeRatecontrol mixedReferences noiseSensitivity rectangularMotionPartitionsAnalysis recursionSkip refineRateDistortionCost rowMultiThreadingEnabled saoNonDeblock signHide skipSplitRateDistortionAnalysis ssimRateDistortionOptimization strongIntraSmoothing temporalMotionVectorPredictors wavefrontParallelProcessing weightedPredictionBFrames",
	{
		displayAspectRatio: group(fields("", "numerator denominator")),
		partitions: strings,
		cea608708SubtitleConfig: group(
			fields("passthroughMode", "", "passthroughActivated"),
		),
		presetConfiguration: z.union([z.null(), text]),
		subMe: z.union([z.number().finite().nullable(), text]),
		rateControlModeConfig: group(
			fields(
				"type perceptualEncodingMode",
				"perceptualStrength perceptualPenaltyStrength perceptualPenaltyKnee perceptualTemporalStrength pixelPerDegree",
			),
		),
		colorConfig: group(color),
		dolbyVisionMetadata: group(
			fields("profile metadataSource metadataStreamKey"),
		),
	},
);
const muxing = fields(
	"acl kind key name path autoPath segmentNaming segmentNamingTemplate initSegmentName initSegmentNameTemplate filename manifestType dolbyVisionTrackSampleEntryName",
	"segmentLength framesPerCmafChunk fragmentDuration",
	"ownContainer autoOwnContainer progressive",
	{ muxedAudioKeys: strings },
);
const extras = fields(
	"key name streamName source encodingKey hlsVariantLabel hlsVariantUri dashSetKey mode",
	"",
	"",
	{
		perTitleSettings: group(
			fields(
				"bitrateSelectionMode",
				"minBitrate maxBitrate lowComplexityBoundaryForMaxBitrate highComplexityBoundaryForMaxBitrate",
			),
		),
		nexguard: group(fields("credentialId watermarkType preset strength")),
		burnInSrt: group(fields("inputFile characterEncoding")),
		hlsMedia: group(fields("groupId name uri", "", "isDefault autoselect")),
	},
);
const rendition = fields(
	"codec encodingMode channelLayout name presetConfiguration container autoKey",
	"width height bitrate rate cutoffFrequency",
	"ownContainer",
	{
		h264: group(codec),
		h265: group(codec),
		vp9: group(codec),
		av1: group(codec),
		extras: group(extras),
		muxing: group(muxing),
		extraMuxings: rows(muxing),
		muxedAudioKeys: strings,
		cmaf: group(cmaf),
		loudness: group(
			fields("meteringMode dialogueIntelligence", "speechThreshold"),
		),
	},
);
const liveRendition = rendition.extend({
	input: group(fields("key inputPath", "position")),
});
const perTitle = fields(
	"forcedRenditionAboveHighestFixedRepresentationCalculationMode",
	"adoptConfigurationThreshold targetQualityCrf complexityFactor minBitrate maxBitrate minBitrateStepSize maxBitrateStepSize codecMinBitrateFactor codecMaxBitrateFactor codecBufsizeFactor forcedRenditionAboveHighestFixedRepresentation forcedRenditionAboveHighestFixedRepresentationFactor",
	"autoRepresentations",
);
const common = {
	labels: strings,
	infrastructure: group(fields("infrastructureId cloudRegion")),
	output: group(location),
	videos: rows(rendition),
	audios: rows(rendition),
};
const mediaDetails = group(
	fields(
		"assocLanguage",
		"startSegmentNumber endSegmentNumber",
		"isDefault autoselect forced",
		{ characteristics: strings },
	).pipe(hlsMediaAttributesSchema),
);
const adaptationDetails = group(
	fields("", "", "", {
		roles: strings,
		labels: rows(fields("value lang")),
		accessibilities: rows(fields("schemeIdUri value")),
		customAttributes: rows(fields("key value")),
	}).pipe(dashAdaptationOptionsSchema),
);
const safeRows = (schema: z.ZodType) =>
	z
		.array(group(schema))
		.max(64)
		.transform((values) => {
			const valid = values.filter((value) => value !== undefined);
			return valid.length ? valid : undefined;
		})
		.optional()
		.catch(undefined);
const safeMediaRows = safeRows(
	fields(
		"type name groupId language assocLanguage muxingKey uri drmKey instreamId",
		"startSegmentNumber endSegmentNumber",
		"isDefault autoselect forced",
		{ characteristics: strings },
	).pipe(
		z.union([
			hlsAdditionalMediaSchema.options[0].omit({ customTags: true }),
			hlsAdditionalMediaSchema.options[1].omit({ customTags: true }),
		]),
	),
);
const safeRepresentationRows = safeRows(
	fields("type muxingKey dependencyMuxingKey spriteKey", "", "", {
		roles: strings,
		labels: rows(fields("value lang")),
		accessibilities: rows(fields("schemeIdUri value")),
		customAttributes: rows(fields("key value")),
	}).pipe(
		z.union([
			dashAdditionalRepresentationSchema.options[0],
			dashAdditionalRepresentationSchema.options[2],
		]),
	),
);
const hlsDetails = group(
	fields("channelsAttributeForAudio targetDurationRoundingMode", "", "", {
		audioMedia: mediaDetails,
		subtitleMedia: mediaDetails,
		additionalMedia: safeMediaRows,
		streams: group(
			fields(
				"video",
				"startSegmentNumber endSegmentNumber",
				"forceFrameRateAttribute forceVideoRangeAttribute",
				{
					audioGroups: group(
						fields("droppingMode", "", "", {
							groups: rows(fields("name", "priority")),
						}),
					),
				},
			).pipe(hlsStreamOptionsSchema),
		),
	})
		.pipe(hlsDetailedOptionsSchema)
		.transform((value) =>
			Object.values(value).some((entry) => entry !== undefined)
				? value
				: undefined,
		),
);
const dashDetails = group(
	fields(
		"dashEditionCompatibility iso8601TimestampFormat",
		"minBufferTime",
		"",
		{
			period: group(fields("", "start duration")),
			additionalRepresentations: safeRepresentationRows,
			videoAdaptationSet: adaptationDetails,
			audioAdaptationSet: adaptationDetails,
			subtitleAdaptationSet: adaptationDetails,
			representations: rows(
				fields(
					"muxingKey mode startKeyframeKey endKeyframeKey dependencyMuxingKey contentProtection",
					"startSegmentNumber endSegmentNumber",
					"drmRepresentation",
				),
			),
		},
	)
		.pipe(dashDetailedOptionsSchema)
		.transform((value) =>
			Object.values(value).some((entry) => entry !== undefined)
				? value
				: undefined,
		),
);
const hlsOptions = fields(
	"acl masterVersion mediaVersion audioGroupId audioLanguage closedCaptions videoMuxingKind audioMuxingKind audioMediaUri perTitleVariantUri drmKind jitPlacement generationMode",
	"",
	"omitMasterVersion omitMediaVersion variantsPerAudioGroup iframePlaylists audioVariantStreams",
	{ detailed: hlsDetails },
);
const dashOptions = fields(
	"acl audioLanguage representationType videoMuxingKind audioMuxingKind drmKind jitPlacement generationMode",
	"",
	"onDemand",
	{
		adaptationSets: rows(
			fields("key type lang label", "", "", {
				roles: strings,
				labels: rows(fields("value lang")),
				accessibilities: rows(fields("schemeIdUri value")),
				customAttributes: rows(fields("key value")),
			}),
		),
		detailed: dashDetails,
		defaultPeriods: group(
			z
				.array(defaultDashPeriodSchema)
				.max(64)
				.refine((value) => !/\w+:\/\/|[?#]/u.test(JSON.stringify(value))),
		),
	},
);
const padding = group(fields("unit", "duration"));
const vod = fields(
	"name accountId cloudRegion encoderVersion audioInputFile timing",
	"",
	"audioGuard",
	{
		...common,
		prewarmedEncoderPoolIds: strings,
		internal: group(
			fields("", "", "", { hevcV2: group(fields("bcfVersion")) }),
		),
		delivery: group(fields("specId onDeviation")),
		qc: group(
			fields("model", "", "vmaf psnr only", {
				execution: group(fields("backend profileId", "budgetUsd")),
				gate: group(
					fields("onFail", "", "", {
						rules: rows(
							fields("metric scope", "gte", "", { renditions: strings }),
						),
					}),
				),
			}),
		),
		inputFiles: rows(
			fields("key inputKey kind credentialId bucket path region name"),
		),
		additionalOutputs: rows(location),
		sources: group(
			fields("", "", "", {
				tracks: rows(
					fields("key inputFile selectionMode encodingKey", "position"),
				),
				fileStreams: rows(fields("fileType key inputFile encodingKey")),
				dolbyStreams: rows(
					fields(
						"kind key inputFile inputFormat videoInputFile metadataInputFile encodingKey",
					),
				),
				trimmingStreams: rows(
					fields(
						"kind key sourceKey encodingKey startTimeCode endTimeCode startPicTiming endPicTiming",
						"offset duration",
					),
				),
				concatenationStreams: rows(
					fields("key encodingKey", "", "", {
						sources: rows(
							fields("sourceKey aspectMode", "position", "isMain", {
								paddingBefore: padding,
								paddingAfter: padding,
							}),
						),
					}).required({ sources: true }),
				),
				encodings: rows(fields("key name cloudRegion encoderVersion")),
				keyframes: rows(fields("key encodingKey", "time")),
				implicitEncodingKeys: group(fields("video audio")),
				audioMixStreams: rows(
					fields("key channelLayout encodingKey", "", "", {
						audioMixChannels: rows(
							fields("sourceKey outputChannelType", "outputChannelNumber", "", {
								sourceChannels: rows(fields("type", "channelNumber gain")),
							}).required({ sourceChannels: true }),
						),
					}).required({ audioMixChannels: true }),
				),
			}),
		),
		subtitles: rows(
			fields("codec source label language groupId uri", "", "", {
				styling: group(fields("mode")),
				extras: group(extras),
				muxing: group(muxing),
			}),
		),
		thumbnails: rows(
			fields("key streamKey pattern unit path", "height", "", {
				positions: rows(z.number().finite()),
			}),
		),
		sprites: rows(
			fields(
				"key streamKey unit spriteName filename vttName creationMode path",
				"distance width height hTiles vTiles imagesPerFile",
			),
		),
		kantar: group(
			fields(
				"credentialId channelName contentReference reportPath",
				"licenseId",
				"reportPrivate",
			),
		),
		manifests: group(
			fields("", "", "hls dash", {
				hlsOptions: group(hlsOptions),
				dashOptions: group(dashOptions),
				extra: rows(
					fields(
						"kind key manifestName name acl serverManifestName clientManifestName language drmKind",
						"",
						"",
						{ hls: group(hlsOptions), dash: group(dashOptions) },
					),
				),
			}),
		),
		startOptions: group(
			fields("encodingMode audioVideoSyncMode", "", "handleVariableInputFps", {
				perTitle: group(
					fields("", "", "", {
						h264: group(perTitle),
						h265: group(perTitle),
						vp9: group(perTitle),
						av1: group(perTitle),
					}),
				),
				aiSceneAnalysis: group(
					fields("filename path", "", "", {
						allSceneBoundaries: group(
							fields("", "", "isEnabled insertCueTags"),
						),
						schedule: rows(fields("", "position maxDeviation duration")),
						outputLanguageCodes: strings,
						regulatoryAdvisories: group(
							z.object({ topics: z.tuple([z.literal("TOBACCO")]) }),
						),
					}),
				),
			}),
		),
	},
);
const liveManifestDestination = group(
	fields("outputKey path acl").required({ outputKey: true, path: true }),
);
const liveHlsManifest = fields(
	"key name manifestName audioGroupId audioLanguage closedCaptions videoMuxingKind audioMuxingKind drmKind masterVersion mediaVersion",
	"timeshift liveEdgeOffset",
	"enabled insertProgramDateTime insertProgramDateTimeExplicit",
	{
		destination: liveManifestDestination,
		detailed: group(hlsDetails.pipe(liveHlsDetailedOptionsSchema.optional())),
		programDateTimeSettings: group(
			fields("source", "", "", {
				placement: group(fields("mode", "interval")),
			}),
		),
	},
);
const liveDashManifest = fields(
	"key name manifestName audioLanguage representationType availabilityStartTimeMode drmKind",
	"timeshift liveEdgeOffset suggestedPresentationDelay minimumUpdatePeriod",
	"enabled",
	{
		destination: liveManifestDestination,
		detailed: group(dashDetails.pipe(liveDashDetailedOptionsSchema.optional())),
	},
);
// DRM keys remain vault references; URLs still use the URL-excluding text schema.
const liveDrmDestination = z
	.object({
		outputKey: text.default(""),
		path: text.default(""),
		acl: text,
	})
	.default({ outputKey: "", path: "" })
	.catch({ outputKey: "", path: "" });
const liveDrmCommon = {
	key: text.default(""),
	muxingKey: text.default(""),
	credentialId: text.default(""),
	destination: liveDrmDestination,
	name: text,
};
const liveDrm = z.discriminatedUnion("kind", [
	z.object({
		...liveDrmCommon,
		kind: z.literal("CENC"),
		kid: text.default(""),
		encryptionMode: text,
		ivSize: text,
		widevine: group(fields("pssh")),
		playReady: group(fields("pssh laUrl")),
		fairPlay: group(z.object({ iv: text.default(""), uri: text.default("") })),
	}),
	z.object({
		...liveDrmCommon,
		kind: z.literal("FAIRPLAY"),
		iv: text.default(""),
		uri: text.default(""),
	}),
	z.object({
		...liveDrmCommon,
		kind: z.literal("SPEKE"),
		contentId: text,
		kid: text,
		iv: text,
		systemIds: z.array(text.default("")).max(100).default([]).catch([]),
	}),
]);
const live = fields(
	"name accountId cloudRegion encoderVersion staticIpId inputKind mirrorKey",
	"segmentLength",
	"scte35AdMarkers",
	{
		...common,
		fallbackCloudRegions: strings,
		drm: rows(liveDrm),
		unencryptedMuxingKeys: strings,
		videos: rows(liveRendition),
		audios: rows(liveRendition),
		mirror: group(location),
		additionalMirrors: rows(
			fields("key", "", "", { output: group(location) }).required({
				key: true,
				output: true,
			}),
		),
		outputOrder: strings,
		ingestOrder: strings,
		manifestOrder: strings,
		adMarkerOptions: group(
			fields(
				"dashPeriodOption dashEventStreamSignalling",
				"",
				"hlsDisablePreannouncing",
				{ hlsMarkerTypes: strings },
			),
		),
		rtmp: group(fields("inputId")),
		archive: group(
			fields("", "", "", {
				output: group(location),
				muxing: group(
					fields("key kind streamKey name filename", "fragmentDuration", "", {
						additionalStreamKeys: strings,
						destination: group(
							fields("outputKey path acl").required({
								outputKey: true,
								path: true,
								acl: true,
							}),
						),
					}).required({
						key: true,
						kind: true,
						streamKey: true,
						filename: true,
						destination: true,
					}),
				),
			}).required({ muxing: true }),
		),
		redundantRtmp: group(
			fields("name pointsMode", "delayThreshold", "", {
				ingestPoints: rows(fields("applicationName")),
				staticIngestPoints: rows(fields("name streamKeyType streamKeyId")),
			}),
		),
		srt: group(
			fields(
				"name mode host path credentialId",
				"listenerPort callerPort latency keyLength backupDelayThreshold",
				"",
				{
					backups: rows(
						fields("mode host path credentialId", "port latency keyLength"),
					),
				},
			),
		),
		zixi: group(
			fields(
				"name host stream credentialId decryptionType",
				"port latency minBitrate",
			),
		),
		hlsIn: group(fields("name adMarkersSource")),
		manifests: group(
			fields("", "", "", {
				hls: group(liveHlsManifest),
				dash: group(liveDashManifest),
				additionalHls: rows(
					liveHlsManifest.required({
						key: true,
						enabled: true,
						manifestName: true,
						audioGroupId: true,
						audioLanguage: true,
						videoMuxingKind: true,
						audioMuxingKind: true,
						insertProgramDateTime: true,
					}),
				),
				additionalDash: rows(
					liveDashManifest.required({
						key: true,
						enabled: true,
						manifestName: true,
						audioLanguage: true,
						representationType: true,
						availabilityStartTimeMode: true,
					}),
				),
			}),
		),
		start: group(
			fields("encodingOption liveEncodingMode", "", "", {
				autoRestart: group(
					fields(
						"scheduleExpression",
						"segmentsWrittenTimeout bytesWrittenTimeout framesWrittenTimeout hlsManifestsUpdateTimeout dashManifestsUpdateTimeout",
						"restartOnEncoderError",
					),
				),
				autoShutdown: group(
					fields(
						"",
						"bytesReadTimeoutSeconds streamTimeoutMinutes waitingForFirstConnectTimeoutMinutes",
					),
				),
				reupload: group(
					fields("", "dashManifestInterval muxingInitFileInterval"),
				),
				esam: group(
					fields(
						"acquisitionPointIdentity zoneIdentity poisCredentialId",
						"adAvailOffset",
					),
				),
				adInsertion: group(
					fields(
						"clockSynchronizationMode",
						"",
						"enableEsamMediaPointInsertion",
					),
				),
				cacheControl: group(
					fields("", "", "", {
						hls: group(
							fields("", "", "", {
								multiVariantPlaylist: group(fields("cacheControl")),
								variantPlaylist: group(fields("cacheControl")),
							}),
						),
						dash: group(
							fields("", "", "", {
								timelineManifest: group(fields("cacheControl")),
								templateManifest: group(fields("cacheControl")),
							}),
						),
						segments: group(
							fields("", "", "", {
								initSegment: group(fields("cacheControl")),
								mediaSegment: group(fields("cacheControl")),
							}),
						),
					}),
				),
			}),
		),
		schedule: group(
			fields(
				"streamUpLocal programStartLocal programEndLocal",
				"",
				"enabled slateEnabled",
				{
					slateSource: group(fields("credentialId bucket key").nullable()),
				},
			),
		),
	},
);

export function projectWizardDraft(
	kind: WizardDraftKind,
	value: unknown,
): DraftValue {
	return (kind === "vod" ? vod : live).parse(value);
}

/** Missing unsafe leaves retain the fresh base; saved form values never supply secrets. */
export function mergeWizardDraft<T>(
	base: T,
	value: DraftValue,
	kind: WizardDraftKind,
): T {
	// Required form leaves retain the fresh base if a stored snapshot is damaged.
	// Every other allowlisted leaf has snapshot semantics: absent means cleared.
	// Excluded secrets are outside the projected base and are never removed here.
	const outputFields = [
		"credentialId",
		"kind",
		"bucket",
		"basePath",
		"name",
		"publicRead",
	];
	const required: Record<string, readonly string[]> = {
		"": [
			"name",
			"accountId",
			"cloudRegion",
			"encoderVersion",
			"output",
			"videos",
			"audios",
			"manifests",
			...(kind === "vod"
				? ["inputFiles", "additionalOutputs", "audioGuard", "timing"]
				: [
						"inputKind",
						"rtmp",
						"redundantRtmp",
						"srt",
						"zixi",
						"hlsIn",
						"start",
						"segmentLength",
						"scte35AdMarkers",
						"schedule",
					]),
		],
		output: outputFields,
		mirror: outputFields,
		"additionalOutputs.*": outputFields,
		"additionalMirrors.*": ["key", "output"],
		"additionalMirrors.*.output": outputFields,
		"archive.output": outputFields,
		"inputFiles.*": [
			"key",
			"inputKey",
			"kind",
			"credentialId",
			"bucket",
			"path",
		],
		"videos.*": ["height", "bitrate", ...(kind === "live" ? ["codec"] : [])],
		"audios.*": ["bitrate", "rate", ...(kind === "live" ? ["codec"] : [])],
		rtmp: ["inputId"],
		redundantRtmp: ["name", "pointsMode", "ingestPoints", "staticIngestPoints"],
		"redundantRtmp.ingestPoints.*": ["applicationName"],
		"redundantRtmp.staticIngestPoints.*": [
			"name",
			"streamKeyType",
			"streamKeyId",
		],
		srt: [
			"name",
			"mode",
			"host",
			"listenerPort",
			"path",
			"credentialId",
			"keyLength",
			"backups",
		],
		"srt.backups.*": ["mode", "host", "path", "credentialId"],
		zixi: ["name", "host", "stream", "credentialId", "decryptionType"],
		hlsIn: ["name", "adMarkersSource"],
		start: ["autoRestart", "autoShutdown", "reupload"],
		"start.autoRestart": ["scheduleExpression", "restartOnEncoderError"],
		manifests: ["hls", "dash"],
		"manifests.hls": [
			"enabled",
			"manifestName",
			"audioGroupId",
			"audioLanguage",
			"videoMuxingKind",
			"audioMuxingKind",
			"insertProgramDateTime",
		],
		"manifests.dash": [
			"enabled",
			"manifestName",
			"audioLanguage",
			"representationType",
			"availabilityStartTimeMode",
		],
		internal: ["hevcV2"],
		"internal.hevcV2": ["bcfVersion"],
		delivery: ["specId"],
		infrastructure: ["infrastructureId", "cloudRegion"],
		qc: ["vmaf", "psnr", "model"],
		"qc.gate": ["rules", "onFail"],
		"qc.gate.rules.*": ["metric", "scope", "gte"],
		archive: ["muxing"],
		"archive.muxing": [
			"key",
			"kind",
			"streamKey",
			"additionalStreamKeys",
			"filename",
			"destination",
		],
		"archive.muxing.destination": ["outputKey", "path", "acl"],
		"sources.tracks.*": ["key", "inputFile", "selectionMode", "position"],
		"sources.fileStreams.*": ["key", "inputFile"],
		"sources.dolbyStreams.*": ["kind", "key"],
		"sources.trimmingStreams.*": ["kind", "key", "sourceKey"],
		"sources.concatenationStreams.*": ["key", "sources"],
		"sources.concatenationStreams.*.sources.*": ["sourceKey"],
		"sources.encodings.*": ["key", "name"],
		"sources.keyframes.*": ["key", "time"],
		"sources.audioMixStreams.*": ["key", "audioMixChannels"],
		"sources.audioMixStreams.*.audioMixChannels.*": [
			"sourceKey",
			"outputChannelType",
			"sourceChannels",
		],
		"subtitles.*": ["source"],
		"thumbnails.*": ["key", "streamKey", "height", "positions"],
		"sprites.*": ["key", "streamKey", "distance", "filename"],
		kantar: ["credentialId", "channelName", "contentReference", "reportPath"],
		"startOptions.aiSceneAnalysis": ["filename", "path"],
		schedule: [
			"enabled",
			"streamUpLocal",
			"programStartLocal",
			"programEndLocal",
			"slateEnabled",
			"slateSource",
		],
		"schedule.slateSource": ["credentialId", "bucket", "key"],
	};
	const merge = (
		previous: unknown,
		next: unknown,
		safePrevious: unknown,
		path = "",
	): unknown => {
		if (next === undefined) return previous;
		if (Array.isArray(next))
			return next.map((item, index) =>
				merge(
					Array.isArray(previous)
						? (previous[index] ?? previous[0])
						: undefined,
					item,
					Array.isArray(safePrevious)
						? (safePrevious[index] ?? safePrevious[0])
						: undefined,
					`${path}.*`,
				),
			);
		if (next !== null && typeof next === "object") {
			const result: DraftValue =
				previous !== null &&
				typeof previous === "object" &&
				!Array.isArray(previous)
					? { ...previous }
					: {};
			// This is a complete allowlisted snapshot. Missing safe properties mean
			// the operator disabled them; only excluded leaves retain the fresh base.
			const safe =
				safePrevious &&
				typeof safePrevious === "object" &&
				!Array.isArray(safePrevious)
					? (safePrevious as DraftValue)
					: {};
			for (const key of Object.keys(safe))
				if (
					(!Object.hasOwn(next, key) ||
						(next as DraftValue)[key] === undefined) &&
					!required[path]?.includes(key)
				)
					delete result[key];
			for (const [key, item] of Object.entries(next))
				if (item !== undefined)
					result[key] = merge(
						result[key],
						item,
						safe[key],
						path ? `${path}.${key}` : key,
					);
			return result;
		}
		return next;
	};
	// Older VOD drafts without a version used STABLE, independently of new-form defaults.
	const snapshot =
		kind === "vod" && value.encoderVersion === undefined
			? { ...value, encoderVersion: "STABLE" }
			: value;
	return merge(base, snapshot, projectWizardDraft(kind, base)) as T;
}

export type WizardDraft = { step: number; value: DraftValue };
const envelope = z
	.object({
		version: z.union([z.literal(1), z.literal(2)]),
		kind: z.enum(["vod", "live"]),
		savedAt: z.number().finite(),
		step: z.number().int().min(0).max(8),
		value: z.unknown(),
	})
	.refine((record) =>
		record.version === 2 ? record.kind === "live" : record.step <= 7,
	);
// Version 2 separates packaging from manifests in the Live navigation only.
const LEGACY_LIVE_STEPS = [0, 1, 2, 3, 6, 5, 7, 8] as const;
export function discardWizardDraft(key: string, storage?: DraftStorage) {
	try {
		(storage ?? localStorage).removeItem(key);
	} catch {
		/* Browser storage is best effort. */
	}
}
export function writeWizardDraft(
	key: string,
	kind: WizardDraftKind,
	value: unknown,
	step: number,
	storage?: DraftStorage,
	now = Date.now(),
) {
	try {
		const record = envelope.parse({
			version: kind === "live" ? 2 : 1,
			kind,
			savedAt: now,
			step,
			value: projectWizardDraft(kind, value),
		});
		const serialized = JSON.stringify(record);
		if (serialized.length <= WIZARD_DRAFT_MAX_SIZE)
			(storage ?? localStorage).setItem(key, serialized);
	} catch {
		/* Invalid/oversized forms and quota failures must not interrupt editing. */
	}
}
export function readWizardDraft(
	key: string,
	kind: WizardDraftKind,
	storage?: DraftStorage,
	now = Date.now(),
): WizardDraft | null {
	try {
		const serialized = (storage ?? localStorage).getItem(key);
		if (!serialized) return null;
		if (serialized.length > WIZARD_DRAFT_MAX_SIZE) throw new Error("size");
		const record = envelope.parse(JSON.parse(serialized));
		if (
			record.kind !== kind ||
			record.savedAt > now ||
			now - record.savedAt >= WIZARD_DRAFT_TTL
		)
			throw new Error("expired");
		const step =
			kind === "live" && record.version === 1
				? LEGACY_LIVE_STEPS[record.step]
				: record.step;
		if (step === undefined) throw new Error("step");
		return {
			step,
			value: projectWizardDraft(kind, record.value),
		};
	} catch {
		discardWizardDraft(key, storage);
		return null;
	}
}
