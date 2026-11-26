import {
	AUDIO_MIX_CHANNEL_TYPES,
	audioMixFilterSchema,
	conformFilterSchema,
	dashAdaptationOptionsSchema,
	dashAdditionalRepresentationSchema,
	dashDetailedOptionsSchema,
	defaultDashPeriodSchema,
	deinterlaceFilterSchema,
	dolbyLoudnessFilterSchema,
	enhancedWatermarkFilterSchema,
	HE_AAC_V2_SIGNALING,
	hasPrivateStorageLocator,
	hlsAdditionalMediaSchema,
	hlsDetailedOptionsSchema,
	hlsMediaAttributesSchema,
	hlsStreamOptionsSchema,
	isObjectStorageInput,
	liveDashDetailedOptionsSchema,
	liveHlsDetailedOptionsSchema,
	mediaFilterSchema,
	publicHdrSourceProjection,
	streamConditionSchema,
	textFilterSchema,
	watermarkFilterSchema,
} from "@bitovp/core";
import {
	vodInputTimelineDocumentSchema,
	vodInputTimelinePreparationReferenceSchema,
} from "@bitovp/core/vod-input-timeline";
import {
	availableImplicitTrackKey,
	mainPictureSourceKey,
	type WizardState,
} from "@bitovp/core/wizard";
import { z } from "zod";
import type { SessionDto } from "./auth/dto";
import {
	defaultFileNames,
	draftKeepsText,
	fileJobFolder,
} from "./wizard-file-names";

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

// Explicit form shapes only. URLs, raw DRM keys, arbitrary filter/options JSON and imported plans
// are deliberately absent; even a nested unknown property cannot enter storage.

const text = z.string().max(2048).refine(draftKeepsText).optional().catch("");
const host = text
	.refine((value) => value === undefined || !/[@/\\\s\p{Cc}]/u.test(value))
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
	"segmentLength framesPerCmafChunk fragmentDuration startOffset",
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
	"codec encodingMode channelLayout name presetConfiguration container autoKey carriedAs",
	"width height bitrate rate cutoffFrequency",
	"ownContainer",
	{
		conditions: group(streamConditionSchema),
		signaling: group(z.enum(HE_AAC_V2_SIGNALING)),
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
// Drafts retain typed edits, including a channel map in progress. Plan validation
// applies the output layout and cross-channel constraints when submitting.
const draftNumber = z.number().finite().optional();
const audioMixDraft = z.strictObject({
	...audioMixFilterSchema.shape,
	audioMixChannels: z.array(
		z.strictObject({
			channelNumber: draftNumber,
			sourceChannels: z.array(
				z.strictObject({
					type: z.enum(AUDIO_MIX_CHANNEL_TYPES),
					channelNumber: draftNumber,
					gain: draftNumber,
				}),
			),
		}),
	),
});
const draftImagePath = z
	.string()
	.max(1024)
	.catch("")
	.transform((path) =>
		draftKeepsText(path, true) &&
		!path.includes("\\") &&
		!path.split("/").includes("..") &&
		[...path].every((c) => c.charCodeAt(0) >= 32)
			? path
			: "",
	)
	.default("");
const draftImageInput = z.union([
	z.literal(""),
	enhancedWatermarkFilterSchema.shape.inputKey,
]);
const watermarkDraft = z.strictObject({
	...watermarkFilterSchema.shape,
	inputKey: draftImageInput,
	imagePath: draftImagePath,
});
const enhancedWatermarkDraft = z.strictObject({
	...enhancedWatermarkFilterSchema.shape,
	inputKey: draftImageInput,
	imagePath: draftImagePath,
	left: draftNumber,
	right: draftNumber,
	top: draftNumber,
	bottom: draftNumber,
	width: draftNumber,
	height: draftNumber,
	opacity: draftNumber,
});
const conformDraft = z.strictObject({
	...conformFilterSchema.shape,
	targetFps: draftNumber,
});
const dolbyLoudnessDraft = z.strictObject({
	...dolbyLoudnessFilterSchema.shape,
	targetLoudness: draftNumber,
	maximumTruePeakLevel: draftNumber,
	speechDetectionThreshold: draftNumber,
});
function projectFilterDraft(item: unknown): (DraftValue & { key: string })[] {
	if (!draftRecord(item)) return [];
	if (item.kind === "TEXT") {
		const key = textFilterSchema.shape.key.safeParse(item.key);
		return key.success ? [{ key: key.data, kind: "TEXT" }] : [];
	}
	if (item.kind === undefined || item.kind === "DEINTERLACE") {
		const parsed = deinterlaceFilterSchema.safeParse({
			...item,
			kind: "DEINTERLACE",
		});
		if (!parsed.success) return [];
		// An implicit default remains implicit when the wizard reopens.
		return [
			{
				...Object.fromEntries(
					Object.entries(parsed.data).filter(([name]) =>
						Object.hasOwn(item, name),
					),
				),
				key: parsed.data.key,
			},
		];
	}
	const schema =
		item.kind === "AUDIO_MIX"
			? audioMixDraft
			: item.kind === "WATERMARK"
				? watermarkDraft
				: item.kind === "ENHANCED_WATERMARK"
					? enhancedWatermarkDraft
					: item.kind === "CONFORM"
						? conformDraft
						: item.kind === "DOLBY_LOUDNESS"
							? dolbyLoudnessDraft
							: mediaFilterSchema;
	const parsed = schema.safeParse(item);
	return parsed.success ? [parsed.data] : [];
}
const vodFilterDrafts = z
	.array(z.unknown())
	.max(100)
	.transform((items) => items.flatMap(projectFilterDraft))
	.optional()
	.catch(undefined);
const vodRendition = rendition.extend({
	extras: group(
		extras.extend({
			filters: rows(
				z.object({ filterKey: text, position: z.number().int().min(0) }),
			),
		}),
	),
});
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
		videos: rows(vodRendition),
		audioFile: group(
			z.discriminatedUnion("mode", [
				z.object({
					mode: z.literal("PCM"),
					position: z.number().int().nonnegative(),
					filename: text,
					rate: z.number().positive(),
					channelLayout: z.enum(["MONO", "STEREO"]),
					sampleFormat: z.enum(["S16LE", "S24LE", "S32LE"]),
				}),
				z.object({
					mode: z.literal("COPY"),
					position: z.number().int().nonnegative(),
					filename: text,
					container: z.enum(["MP4", "PROGRESSIVE_MOV", "PROGRESSIVE_WAV"]),
					sourceCodec: z.enum(["AAC", "PCM"]),
					inspectionId: z.union([z.uuid(), z.literal("")]),
				}),
			]),
		),
		audios: rows(vodRendition),
		filters: vodFilterDrafts,
		inputTimeline: vodInputTimelineDocumentSchema.optional(),
		inputTimelinePreparation:
			vodInputTimelinePreparationReferenceSchema.optional(),
		prewarmedEncoderPoolIds: strings,
		internal: group(
			fields("", "", "", { hevcV2: group(fields("bcfVersion")) }),
		),
		delivery: group(fields("specId onDeviation")),
		qc: group(
			fields("model mirrorPath", "", "vmaf psnr only", {
				execution: group(fields("backend profileId localMode", "budgetUsd")),
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
			fields(
				"key inputKey kind credentialId bucket region name displayName",
				"inputDeclarationIndex",
				"",
				{
					path: z.string().max(2048).optional().catch(""),
					purpose: z.literal("FILTER_IMAGE").optional().catch(undefined),
				},
			).transform((file) => {
				const path = file.path;
				if (typeof path !== "string") return file;
				if (file.purpose === "FILTER_IMAGE") {
					return { ...file, path: draftImagePath.parse(path) };
				}
				if (draftKeepsText(path)) return file;
				// Repeated leading slashes are significant in bucket keys.
				const unsignedBucketKey =
					typeof file.kind === "string" &&
					isObjectStorageInput(file.kind) &&
					/^\/{3,}[^/]/u.test(path) &&
					!/[\\\p{Cc}]/u.test(path) &&
					draftKeepsText(path.replace(/^\/+/, "")) &&
					!hasPrivateStorageLocator(path);
				return unsignedBucketKey ? file : { ...file, path: "" };
			}),
		),
		additionalOutputs: rows(location),
		sources: group(
			fields("", "", "", {
				tracks: rows(
					fields("key inputFile selectionMode encodingKey", "position"),
				),
				fileStreams: rows(fields("fileType key inputFile encodingKey")),
				captionStreams: rows(
					fields(
						"kind key inputFile encodingKey selectionMode",
						"position",
						"",
						{
							channel: z
								.union([
									z.enum(["CC1", "CC3"]),
									z.number().int().min(1).max(63),
								])
								.optional(),
						},
					),
				),
				dolbyStreams: rows(
					fields(
						"kind key inputFile inputFormat videoInputFile metadataInputFile encodingKey",
					),
				),
				hdr10PlusStreams: rows(
					fields(
						"key videoInputFile metadataInputPath selectionMode encodingKey",
						"position",
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
				conditions: group(streamConditionSchema),
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
	"name accountId cloudRegion encoderVersion staticIpId inputKind inputKey mirrorKey",
	"segmentLength",
	"scte35AdMarkers",
	{
		...common,
		output: group(
			location.extend({
				moq: group(
					fields("key draftVersion", "", "", {
						// The namespace is a tuple. Omit it as a unit if a value
						// cannot be saved, so restore can keep the source tuple.
						trackNamespace: group(
							z.array(z.string().max(2048).refine(draftKeepsText)).max(32),
						),
					}),
				),
			}),
		),
		aisaLive: group(
			fields(
				"outputId recordingPath analysisPath esVersion aicaVersion",
				"",
				"enabled useManagedGraph",
			),
		),
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
		dvbSubtitles: rows(
			fields(
				"key language label packaging inputPath",
				"position segmentLength",
				"",
				{
					destination: group(fields("outputKey path acl")),
				},
			),
		),
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
				"name mode path credentialId",
				"listenerPort callerPort latency keyLength backupDelayThreshold",
				"",
				{
					host,
					backups: rows(
						fields("mode path credentialId", "port latency keyLength", "", {
							host,
						}),
					),
				},
			),
		),
		zixi: group(
			fields(
				"name stream credentialId decryptionType",
				"port latency minBitrate",
				"",
				{ host },
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

// When the title survives screening, its exact generated filenames and directories
// can be reconstructed without admitting any additional text from the draft.
function retainGeneratedFileOutputs(source: unknown, projected: DraftValue) {
	if (
		!draftRecord(source) ||
		!projected.name ||
		typeof projected.name !== "string"
	)
		return;
	const folder = fileJobFolder(projected.name);
	function retain(row: unknown, raw: unknown, key: string, expected: string) {
		if (
			expected.length <= 2048 &&
			draftRecord(row) &&
			draftRecord(raw) &&
			raw[key] === expected
		)
			row[key] = expected;
	}
	const rawOptions = source.startOptions;
	const options = projected.startOptions;
	if (draftRecord(rawOptions) && draftRecord(options))
		retain(options.aiSceneAnalysis, rawOptions.aiSceneAnalysis, "path", folder);
	retain(projected.qc, source.qc, "mirrorPath", folder);
	retain(projected.kantar, source.kantar, "reportPath", folder);
	const rows = projected.videos;
	const rawRows = source.videos;
	if (
		!Array.isArray(rows) ||
		!Array.isArray(rawRows) ||
		rows.length !== rawRows.length
	)
		return;
	const files = rows.map((row) => ({
		height: typeof row?.height === "number" ? row.height : null,
		muxing: {
			kind: typeof row?.muxing?.kind === "string" ? row.muxing.kind : undefined,
		},
	}));
	const names = defaultFileNames(projected.name, files);
	for (const [index, expected] of names.entries())
		retain(rows[index]?.muxing, rawRows[index]?.muxing, "filename", expected);
}
export function projectWizardDraft(
	kind: WizardDraftKind,
	value: unknown,
): DraftValue {
	let source = value;
	// A row reused by the audio selector can still carry its original artwork role.
	if (
		kind === "vod" &&
		draftRecord(value) &&
		typeof value.audioInputFile === "string" &&
		Array.isArray(value.inputFiles)
	) {
		source = {
			...value,
			inputFiles: value.inputFiles.map((row: unknown) => {
				if (!draftRecord(row) || row.key !== value.audioInputFile) return row;
				const { purpose: _outdatedRole, ...media } = row;
				return media;
			}),
		};
	}
	const projected = (kind === "vod" ? vod : live).parse(source);
	if (kind === "vod") {
		retainGeneratedFileOutputs(value, projected);
		const filters = vodFilterDrafts.parse(projected.filters) ?? [];
		const keys = new Set(filters.map((filter) => filter.key));
		for (const renditions of [projected.videos, projected.audios]) {
			if (!Array.isArray(renditions)) continue;
			for (const row of renditions) {
				if (!draftRecord(row) || !draftRecord(row.extras)) continue;
				const attachments = row.extras.filters;
				if (!Array.isArray(attachments)) continue;
				row.extras.filters = attachments.filter(
					(item) =>
						draftRecord(item) &&
						typeof item.filterKey === "string" &&
						keys.has(item.filterKey),
				);
			}
		}
	}
	return projected;
}
function draftRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Missing unsafe leaves retain the fresh base; saved form values never supply secrets. */
export function mergeWizardDraft<T>(
	base: T,
	value: DraftValue,
	kind: WizardDraftKind,
	vodInputOrder?: "authored",
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
		"output.moq": ["key", "draftVersion", "trackNamespace"],
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
		"sources.captionStreams.*": ["key", "inputFile", "kind"],
		"sources.dolbyStreams.*": ["kind", "key"],
		"sources.hdr10PlusStreams.*": [
			"key",
			"videoInputFile",
			"metadataInputPath",
			"selectionMode",
		],
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
		// Each retained definition owns its complete shape. Only text overlays
		// depend on omitted fields: match them against the fresh preset by key
		// and kind. A new overlay stays attached and needs its text re-entered.
		if (kind === "vod" && path === "filters" && Array.isArray(next)) {
			const original = Array.isArray(previous) ? previous : [];
			return next.map((item) => {
				if (!draftRecord(item) || item.kind !== "TEXT") return item;
				return (
					original.find(
						(row) =>
							draftRecord(row) && row.kind === "TEXT" && row.key === item.key,
					) ?? { ...item, text: "", x: "0", y: "0" }
				);
			});
		}
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
	const baseDraft = projectWizardDraft(kind, base);
	const restored =
		kind === "vod" && vodInputOrder !== "authored"
			? restoreCopiedHdrInputs(
					snapshot,
					baseDraft,
					draftRecord(base) ? base.copiedPictureSource : undefined,
				)
			: snapshot;
	return merge(base, restored, baseDraft) as T;
}

/** Old copies used the provider declaration order as the implicit video input. */
function restoreCopiedHdrInputs(
	snapshot: DraftValue,
	base: DraftValue,
	copiedPictureSource: unknown,
): DraftValue {
	if (
		!draftRecord(base.sources) ||
		!Array.isArray(base.sources.hdr10PlusStreams) ||
		!base.sources.hdr10PlusStreams.length ||
		!Array.isArray(base.inputFiles) ||
		!Array.isArray(snapshot.inputFiles)
	)
		return snapshot;
	const primary = base.inputFiles[0];
	const first = snapshot.inputFiles[0];
	if (!draftRecord(primary) || !draftRecord(first)) return snapshot;
	const records = (value: unknown) =>
		Array.isArray(value) ? value.filter(draftRecord) : [];
	const copySources = records(base.sources.hdr10PlusStreams);
	// Fresh Copy identifies what actually supplied row zero: a declared ordinary
	// ingest or the leaf of the named main picture. Editing a file in place
	// cannot turn an independent ordinary ingest into the first HDR rendition.
	const originalSource =
		typeof copiedPictureSource === "string"
			? copiedPictureSource
			: copiedPictureSource === null
				? undefined
				: copySources.find((stream) => stream.videoInputFile === primary.key)
						?.key;
	// The named source carries its own picture binding. If the original
	// first media object survives, implicit renditions still use that object.
	// A file key alone can be recycled for another account, bucket or path.
	const originalPictureStillFirst = [
		"key",
		"inputKey",
		"kind",
		"credentialId",
		"bucket",
		"path",
		"region",
	].every((field) => first[field] === primary[field]);
	let primaryKey = primary.key;
	let firstOwnsImplicitAudio = false;
	if (
		originalSource &&
		!originalPictureStillFirst &&
		draftRecord(snapshot.sources)
	) {
		const sources = snapshot.sources;
		const declarations = [
			"tracks",
			"fileStreams",
			"dolbyStreams",
			"hdr10PlusStreams",
		].flatMap((name) => records(sources[name]));
		const trims = records(sources.trimmingStreams);
		const concats = records(sources.concatenationStreams);
		const mixes = records(sources.audioMixStreams);
		const declaredKeys = new Set(
			[...declarations, ...trims, ...concats, ...mixes].map((row) => row.key),
		);
		const usesImplicit = (kind: "video" | "audio", renditions: unknown) => {
			const key = availableImplicitTrackKey(declaredKeys, kind);
			return (
				records(renditions).some(
					(row) =>
						!draftRecord(row.extras) ||
						row.extras.source === undefined ||
						row.extras.source === key,
				) ||
				trims.some((row) => row.sourceKey === key) ||
				concats.some((row) =>
					records(row.sources).some((part) => part.sourceKey === key),
				) ||
				mixes.some((row) =>
					records(row.audioMixChannels).some((part) => part.sourceKey === key),
				)
			);
		};
		// When the original plan supplied only a named picture, any ordinary
		// ingest authored in the saved form reads its first file. Promoting the
		// named picture must preserve the independent ordinary audio binding.
		const namedPicture = typeof copiedPictureSource === "string";
		const savedOwnsPrimary =
			namedPicture && usesImplicit("video", snapshot.videos);
		firstOwnsImplicitAudio =
			namedPicture && usesImplicit("audio", snapshot.audios);
		if (savedOwnsPrimary) primaryKey = first.key;
		else {
			let binding = declarations.find(
				(source) => source.key === originalSource,
			);
			if (!binding) {
				// A removed stream may leave its file key available for a different
				// object. Prefer the replacement source named by the saved rendition.
				const firstVideo = records(snapshot.videos)[0];
				const selected = mainPictureSourceKey(
					draftRecord(firstVideo?.extras)
						? firstVideo.extras.source
						: undefined,
					sources,
				);
				binding = declarations.find((source) => source.key === selected);
			}
			primaryKey = binding?.videoInputFile ?? binding?.inputFile ?? primary.key;
		}
	}
	const index = snapshot.inputFiles.findIndex(
		(f) => draftRecord(f) && f.key === primaryKey,
	);
	if (index < 0) return snapshot;
	// Declaration order belongs to the provider input, independently of which
	// file on it is currently being edited.
	const originalFiles = records(base.inputFiles);
	const byRow = new Map(originalFiles.map((file) => [file.key, file]));
	const byInput = new Map(
		originalFiles.map((file) => [file.inputKey, file.inputDeclarationIndex]),
	);
	const files = snapshot.inputFiles.map((f) => {
		if (!draftRecord(f)) return f;
		const row = byRow.get(f.key);
		const rank =
			row && row.inputKey === f.inputKey
				? row.inputDeclarationIndex
				: byInput.get(f.inputKey);
		return rank === undefined ? f : { inputDeclarationIndex: rank, ...f };
	});
	if (index > 0) files.unshift(...files.splice(index, 1));
	// Promoting a replacement HDR picture must keep an unchanged copied audio
	// master, including the implicit audio that previously shared the picture.
	const copiedAudioKey = base.audioInputFile ?? primary.key;
	const audioInputFile =
		snapshot.audioInputFile ??
		(index > 0 && (first.key === copiedAudioKey || firstOwnsImplicitAudio)
			? first.key
			: undefined);
	return {
		...snapshot,
		...(audioInputFile !== undefined ? { audioInputFile } : {}),
		inputFiles: files,
	};
}

export type WizardDraft = {
	step: number;
	value: DraftValue;
	vodInputOrder?: "authored";
	legacyVodFilters?: true;
	legacyRenditions?: true;
};

/** Older writers omitted stream conditions and HE-AAC signaling. Only reattach those
 * fields to an identified rendition. A replaced or renamed legacy row is ambiguous. */
function recoverRenditionSettings(
	base: unknown,
	kind: WizardDraftKind,
	draft: WizardDraft,
): DraftValue | null {
	if (!draft.legacyRenditions) return draft.value;
	const original = projectWizardDraft(kind, base);
	const value = { ...draft.value };
	for (const field of ["videos", "audios", "subtitles"]) {
		const rows = original[field],
			saved = value[field];
		if (
			!Array.isArray(rows) ||
			!rows.some((r) => r.conditions !== undefined || r.signaling !== undefined)
		)
			continue;
		if (!Array.isArray(saved)) continue;
		function identity(row: DraftValue): string {
			if (draftRecord(row.extras) && typeof row.extras.key === "string")
				return "key:" + row.extras.key;
			const { conditions: _conditions, signaling: _signaling, ...rest } = row;
			return "row:" + JSON.stringify(rest);
		}
		const byId = new Map(rows.map((row) => [identity(row), row]));
		const savedIds = new Set(saved.map(identity));
		if (byId.size !== rows.length || savedIds.size !== saved.length)
			return null;
		if (
			saved.some((row) => !byId.has(identity(row))) &&
			rows.some(
				(row) =>
					(row.conditions !== undefined || row.signaling !== undefined) &&
					!savedIds.has(identity(row)),
			)
		)
			return null;
		value[field] = saved.map((row) => {
			const prior = byId.get(identity(row));
			if (!prior) return row;
			return {
				...(prior.conditions !== undefined
					? { conditions: prior.conditions }
					: {}),
				...(prior.signaling !== undefined && prior.codec === row.codec
					? { signaling: prior.signaling }
					: {}),
				...row,
			};
		});
	}
	return value;
}

function restoreMetadata<T>(base: T, value: DraftValue): T {
	const { name, labels } = value;
	return {
		...base,
		...(typeof name === "string" ? { name } : {}),
		...(Array.isArray(labels) &&
		labels.every((label) => typeof label === "string")
			? { labels }
			: {}),
	};
}

export function legacyLiveMetadataOnly(
	base: unknown,
	draft?: WizardDraft | null,
): boolean {
	return (
		!!draft?.legacyRenditions &&
		recoverRenditionSettings(base, "live", draft) === null
	);
}
export function restoreLiveWizardDraft<T>(base: T, draft: WizardDraft): T {
	const value = recoverRenditionSettings(base, "live", draft);
	return value === null
		? restoreMetadata(base, draft.value)
		: mergeWizardDraft(base, value, "live");
}

/** V1 omitted non-watermark filters and audio attachments. An edit, detach and
 * unchanged preset can therefore produce exactly the same saved data. */
function missingLegacyFilters(base: WizardState, draft: WizardDraft): boolean {
	return (
		!!draft.legacyVodFilters &&
		(base.filters ?? []).some((f) => f.kind !== "WATERMARK")
	);
}
export function legacyVodMetadataOnly(
	base: WizardState,
	draft?: WizardDraft | null,
): boolean {
	return (
		!!draft &&
		(missingLegacyFilters(base, draft) ||
			recoverRenditionSettings(base, "vod", draft) === null)
	);
}

function copyBurnInFiles(base: WizardState, videos: unknown) {
	const files = new Map<string, string | null>();
	for (const video of records(videos)) {
		const extras = draftRecord(video.extras) ? video.extras : null;
		const burnIn = extras?.burnInSrt;
		if (!draftRecord(burnIn) || typeof burnIn.inputFile !== "string") continue;
		// The generated file key can shift when two replacement paths dedupe.
		// The rendition key still identifies which subtitle the operator filled.
		const matches =
			typeof extras?.key === "string"
				? base.videos.filter((row) => row.extras?.key === extras.key)
				: [];
		const file =
			matches.length === 1
				? (matches[0]?.extras?.burnInSrt?.inputFile ?? null)
				: null;
		const previous = files.get(burnIn.inputFile);
		files.set(
			burnIn.inputFile,
			previous === undefined || previous === file ? file : null,
		);
	}
	return files;
}

export function restoreVodWizardDraft(
	base: WizardState,
	draft: WizardDraft,
	replacementPaths?: readonly { inputKey: string; path: string }[],
): WizardState {
	let value = missingLegacyFilters(base, draft)
		? null
		: recoverRenditionSettings(base, "vod", draft);
	if (Array.isArray(value?.inputFiles) && replacementPaths?.length) {
		const sameInput = [
			"inputKey",
			"kind",
			"credentialId",
			"bucket",
			"region",
		] as const;
		const burnInFiles = copyBurnInFiles(base, value.videos);
		const repairedFiles = new Set<string>();
		const inputFiles = value.inputFiles.map((saved: unknown) => {
			if (
				!draftRecord(saved) ||
				typeof saved.key !== "string" ||
				saved.path !== ""
			)
				return saved;
			const pairedFile = burnInFiles.get(saved.key);
			const fileKey = pairedFile === undefined ? saved.key : pairedFile;
			const replacement = base.inputFiles.find(
				(row) =>
					row.key === fileKey &&
					sameInput.every((field) => row[field] === saved[field]),
			);
			if (
				!replacement ||
				!replacementPaths.some(
					(path) =>
						path.inputKey === replacement.inputKey &&
						path.path === replacement.path,
				)
			)
				return saved;
			repairedFiles.add(saved.key);
			return { ...saved, path: replacement.path };
		});
		const sources = value.sources;
		if (draftRecord(sources) && Array.isArray(sources.hdr10PlusStreams)) {
			const hdr10PlusStreams = sources.hdr10PlusStreams.map(
				(saved: unknown) => {
					if (
						!draftRecord(saved) ||
						typeof saved.videoInputFile !== "string" ||
						!repairedFiles.has(saved.videoInputFile)
					)
						return saved;
					// Reopening sourced a new picture. The cached sidecar only describes
					// the old picture removed by the draft's privacy filter.
					const replacement = base.sources?.hdr10PlusStreams?.find(
						(row) =>
							row.key === saved.key &&
							row.videoInputFile === saved.videoInputFile,
					);
					return {
						...saved,
						metadataInputPath: replacement?.metadataInputPath ?? "",
					};
				},
			);
			value = {
				...value,
				sources: { ...sources, hdr10PlusStreams },
				inputFiles,
			};
		} else value = { ...value, inputFiles };
	}
	return value === null
		? restoreMetadata(base, draft.value)
		: mergeWizardDraft(base, value, "vod", draft.vodInputOrder);
}
const envelope = z
	.object({
		version: z.union([z.literal(1), z.literal(2), z.literal(3)]),
		vodInputOrder: z.literal("authored").optional(),
		renditionSettings: z.literal("complete").optional(),
		kind: z.enum(["vod", "live"]),
		savedAt: z.number().finite(),
		step: z.number().int().min(0).max(8),
		value: z.unknown(),
	})
	.refine((record) =>
		record.version === 2
			? record.kind === "live"
			: record.step <= 7 && (record.version === 1 || record.kind === "vod"),
	);

/** A protected projection changes the old plan fingerprint. The copied job
 * itself still identifies the same draft family within one account. */
export function copiedJobDraftSlot(
	identity: [string, string],
	jobId: string,
	canonicalKey: string,
	storage: Pick<Storage, "getItem" | "key" | "length">,
	now = Date.now(),
) {
	function savedAt(slot: string) {
		try {
			const raw = storage.getItem(slot);
			if (!raw || raw.length > WIZARD_DRAFT_MAX_SIZE) return;
			const record = envelope.parse(JSON.parse(raw));
			if (
				record.kind === "vod" &&
				record.savedAt <= now &&
				now - record.savedAt < WIZARD_DRAFT_TTL &&
				draftRecord(record.value)
			)
				return record.savedAt;
		} catch {
			// Inspection never overwrites a slot owned by another open form.
		}
	}
	const prefix = draftKey(identity, "vod", `job:${jobId}:`).slice(0, -2);
	try {
		if (
			savedAt(canonicalKey) !== undefined ||
			savedAt(`${canonicalKey}:working`) !== undefined
		)
			return canonicalKey;
		let newest = { key: canonicalKey, savedAt: -Infinity };
		for (let index = 0; index < storage.length; index++) {
			const slot = storage.key(index);
			if (
				!slot?.startsWith(prefix) ||
				!/^[a-f\d]{1,8}"\](?::working)?$/u.test(slot.slice(prefix.length))
			)
				continue;
			const time = savedAt(slot);
			if (time !== undefined && time > newest.savedAt)
				newest = { key: slot.replace(/:working$/u, ""), savedAt: time };
		}
		return newest.key;
	} catch {
		return canonicalKey;
	}
}
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
		const projected = projectWizardDraft(
			kind,
			publicHdrSourceProjection(value, "draft"),
		);
		const hasInputOrder = kind === "vod" && Array.isArray(projected.inputFiles);
		const record = envelope.parse({
			version: kind === "live" ? 2 : 3,
			renditionSettings: "complete",
			...(hasInputOrder ? { vodInputOrder: "authored" } : {}),
			kind,
			savedAt: now,
			step,
			value: projected,
		});
		const serialized = JSON.stringify(record);
		if (serialized.length <= WIZARD_DRAFT_MAX_SIZE) {
			(storage ?? localStorage).setItem(key, serialized);
			return serialized;
		}
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
	return readWizardDraftRecord(key, kind, storage, now)?.draft ?? null;
}
export function readWizardDraftRecord(
	key: string,
	kind: WizardDraftKind,
	storage?: DraftStorage,
	now = Date.now(),
): { draft: WizardDraft; serialized: string; savedAt: number } | null {
	try {
		let serialized = (storage ?? localStorage).getItem(key);
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
		const safeValue = publicHdrSourceProjection(record.value, "draft");
		if (safeValue !== record.value) {
			serialized = JSON.stringify({ ...record, value: safeValue });
			(storage ?? localStorage).setItem(key, serialized);
		}
		const value = projectWizardDraft(kind, safeValue);
		return {
			serialized,
			savedAt: record.savedAt,
			draft: {
				step,
				value,
				...(!record.renditionSettings &&
				[value.videos, value.audios, value.subtitles].some(Array.isArray)
					? { legacyRenditions: true as const }
					: {}),
				...(kind === "vod" && record.vodInputOrder
					? { vodInputOrder: record.vodInputOrder }
					: {}),
				...(kind === "vod" && record.version === 1
					? { legacyVodFilters: true as const }
					: {}),
			},
		};
	} catch {
		discardWizardDraft(key, storage);
		return null;
	}
}
