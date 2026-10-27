import { z } from "zod";

const key = z.string().min(1);
const nonnegativeInteger = z.number().int().min(0);
const text = z.string().min(1);
export const EXTERNAL_VTT_URL_REQUIREMENT =
	"Use a public HTTP or HTTPS VTT URL without embedded credentials, a query string, or a fragment; signed URLs are not supported";
// Plans and saved presets are readable configuration, not secret storage.
// Query parameter names are arbitrary, so an allowlist cannot identify every signed URL.
export const externalVttUrlSchema = z.url().refine((value) => {
	try {
		const url = new URL(value);
		return (
			["http:", "https:"].includes(url.protocol) &&
			!url.username &&
			!url.password &&
			!url.search &&
			!url.hash
		);
	} catch {
		return false;
	}
}, EXTERNAL_VTT_URL_REQUIREMENT);
const childPlaylist = z
	.string()
	.regex(
		/^[A-Za-z0-9][A-Za-z0-9._-]*\.m3u8$/,
		"Use a flat .m3u8 playlist filename",
	);

export const hlsGlobalOptionsSchema = z.strictObject({
	channelsAttributeForAudio: z
		.enum(["ALWAYS", "STANDARD_CONFORM", "LEGACY"])
		.optional(),
	targetDurationRoundingMode: z
		.enum(["UPWARD_ROUNDING", "NORMAL_ROUNDING"])
		.optional(),
});
export const dashGlobalOptionsSchema = z.strictObject({
	dashEditionCompatibility: z.enum(["V4"]).optional(),
	iso8601TimestampFormat: z.enum(["LONG", "SHORT"]).optional(),
	minBufferTime: z.number().min(0).optional(),
	namespaces: z
		.array(z.strictObject({ prefix: text, uri: text }))
		.max(64)
		.optional(),
	utcTimings: z
		.array(z.strictObject({ schemeIdUri: text, value: text }))
		.max(64)
		.optional(),
});

export const dashAdaptationOptionsSchema = z.strictObject({
	roles: z
		.array(
			z.enum([
				"ALTERNATE",
				"CAPTION",
				"COMMENTARY",
				"DUB",
				"MAIN",
				"SUBTITLE",
				"SUPPLEMENTARY",
			]),
		)
		.max(64)
		.optional(),
	accessibilities: z
		.array(z.strictObject({ schemeIdUri: text, value: text }))
		.max(64)
		.optional(),
	customAttributes: z
		.array(z.strictObject({ key: text, value: z.string() }))
		.max(64)
		.optional(),
	labels: z
		.array(z.strictObject({ value: text, lang: z.string().optional() }))
		.max(64)
		.optional(),
});

/** Keyframe references name plan keyframes; the compiler resolves provider IDs. */
export const segmentRangeSchema = z
	.strictObject({
		startSegmentNumber: nonnegativeInteger.optional(),
		endSegmentNumber: nonnegativeInteger.optional(),
		startKeyframeKey: key.optional(),
		endKeyframeKey: key.optional(),
	})
	.superRefine((value, ctx) => {
		if (
			value.startSegmentNumber !== undefined &&
			value.endSegmentNumber !== undefined &&
			value.startSegmentNumber > value.endSegmentNumber
		) {
			ctx.addIssue({
				code: "custom",
				path: ["endSegmentNumber"],
				message: "The final segment must not precede the first segment",
			});
		}
	});

export const hlsCustomTagSchema = z.discriminatedUnion("positionMode", [
	z.strictObject({
		positionMode: z.literal("TIME"),
		time: z.number().min(0),
		data: text,
	}),
	z.strictObject({
		positionMode: z.literal("SEGMENT"),
		segment: nonnegativeInteger,
		data: text,
	}),
	z.strictObject({
		positionMode: z.literal("KEYFRAME"),
		keyframeKey: key,
		data: text,
	}),
]);

export const hlsMediaAttributesSchema = z.strictObject({
	assocLanguage: z.string().optional(),
	characteristics: z.array(text).max(64).optional(),
	isDefault: z.boolean().optional(),
	autoselect: z.boolean().optional(),
	forced: z.boolean().optional(),
	startSegmentNumber: nonnegativeInteger.optional(),
	endSegmentNumber: nonnegativeInteger.optional(),
});

export const hlsStreamOptionsSchema = z.strictObject({
	forceFrameRateAttribute: z.boolean().optional(),
	forceVideoRangeAttribute: z.boolean().optional(),
	startSegmentNumber: nonnegativeInteger.optional(),
	endSegmentNumber: nonnegativeInteger.optional(),
	video: text.optional(),
	audioGroups: z
		.strictObject({
			droppingMode: z.enum(["STREAM", "AUDIO"]),
			groups: z
				.array(z.strictObject({ name: text, priority: z.number().int() }))
				.max(64)
				.min(1),
		})
		.optional(),
});

const hlsMediaBase = {
	name: text,
	groupId: text,
	language: z.string().optional(),
	...hlsMediaAttributesSchema.shape,
	customTags: z.array(hlsCustomTagSchema).max(64).optional(),
};
export const hlsAdditionalMediaSchema = z.discriminatedUnion("type", [
	z.strictObject({
		...hlsMediaBase,
		type: z.literal("VIDEO"),
		forced: z.never().optional(),
		muxingKey: key,
		uri: childPlaylist,
		drmKey: key.optional(),
	}),
	z.strictObject({
		...hlsMediaBase,
		type: z.literal("CLOSED_CAPTIONS"),
		muxingKey: key,
		instreamId: z
			.string()
			.regex(/^(CC[1-4]|SERVICE([1-9]|[1-5][0-9]|6[0-3]))$/),
		drmKey: key.optional(),
	}),
	z.strictObject({
		...hlsMediaBase,
		type: z.literal("VTT"),
		startSegmentNumber: z.never().optional(),
		endSegmentNumber: z.never().optional(),
		vttUrl: externalVttUrlSchema,
		uri: childPlaylist,
	}),
]);

export const dashRepresentationOptionsSchema = z.strictObject({
	muxingKey: key,
	mode: z
		.enum(["TEMPLATE_REPRESENTATION", "TEMPLATE_ADAPTATION_SET"])
		.optional(),
	...segmentRangeSchema.shape,
	dependencyMuxingKey: key.optional(),
	drmRepresentation: z.boolean().optional(),
	contentProtection: z.enum(["REPRESENTATION", "ADAPTATION_SET"]).optional(),
});

export const dashAdditionalRepresentationSchema = z.discriminatedUnion("type", [
	z.strictObject({
		type: z.literal("PROGRESSIVE_WEBM"),
		muxingKey: key,
		dependencyMuxingKey: key.optional(),
		...dashAdaptationOptionsSchema.shape,
	}),
	z.strictObject({
		type: z.literal("VTT"),
		vttUrl: externalVttUrlSchema,
		lang: text,
		...dashAdaptationOptionsSchema.shape,
	}),
	z.strictObject({
		type: z.literal("SPRITE"),
		spriteKey: key,
		...dashAdaptationOptionsSchema.shape,
	}),
]);

const conditionAttributeSchema = z.enum([
	"audio.codec",
	"audio.language",
	"audio.bitrate",
	"subtitle.format",
	"subtitle.language",
	"video.height",
	"video.width",
	"video.codec",
	"video.bitrate",
	"drm.type",
	"muxing.type",
]);
export type ManifestCondition =
	| {
			type: "CONDITION";
			attribute: z.infer<typeof conditionAttributeSchema>;
			operator: "==" | "!=" | "<=" | "<" | ">" | ">=";
			value: string;
	  }
	| { type: "AND" | "OR"; conditions: ManifestCondition[] };
const recursiveManifestConditionSchema: z.ZodType<ManifestCondition> = z.lazy(
	() =>
		z.discriminatedUnion("type", [
			z.strictObject({
				type: z.literal("CONDITION"),
				attribute: conditionAttributeSchema,
				operator: z.enum(["==", "!=", "<=", "<", ">", ">="]),
				value: text,
			}),
			z.strictObject({
				type: z.literal("AND"),
				conditions: z.array(recursiveManifestConditionSchema).min(1).max(32),
			}),
			z.strictObject({
				type: z.literal("OR"),
				conditions: z.array(recursiveManifestConditionSchema).min(1).max(32),
			}),
		]),
);
export const manifestConditionSchema = z.preprocess((value, ctx) => {
	const pending: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
	let nodes = 0;
	while (pending.length) {
		const next = pending.pop();
		if (!next) break;
		if (++nodes > 128 || next.depth > 8) {
			ctx.addIssue({
				code: "custom",
				message:
					"Manifest conditions support at most 128 nodes and 8 nested groups",
			});
			return z.NEVER;
		}
		if (
			next.value &&
			typeof next.value === "object" &&
			"conditions" in next.value &&
			Array.isArray(next.value.conditions)
		) {
			if (next.value.conditions.length > 32) {
				ctx.addIssue({
					code: "custom",
					message: "Each condition group supports at most 32 conditions",
				});
				return z.NEVER;
			}
			for (const child of next.value.conditions)
				pending.push({ value: child, depth: next.depth + 1 });
		}
	}
	return value;
}, recursiveManifestConditionSchema);
export const defaultDashPeriodSchema = z.strictObject({
	encodingKeys: z.array(key).min(1).max(64),
	adaptationSets: z.array(manifestConditionSchema).max(64).optional(),
});

export const hlsDetailedOptionsSchema = z.strictObject({
	...hlsGlobalOptionsSchema.shape,
	audioMedia: hlsMediaAttributesSchema.optional(),
	subtitleMedia: hlsMediaAttributesSchema.optional(),
	streams: hlsStreamOptionsSchema.optional(),
	additionalMedia: z.array(hlsAdditionalMediaSchema).max(64).optional(),
	mediaCustomTags: z.array(hlsCustomTagSchema).max(64).optional(),
	streamCustomTags: z.array(hlsCustomTagSchema).max(64).optional(),
});
export const dashDetailedOptionsSchema = z.strictObject({
	...dashGlobalOptionsSchema.shape,
	period: z
		.strictObject({
			start: z.number().min(0).optional(),
			duration: z.number().positive().optional(),
			customXmlElements: z.array(text).max(64).optional(),
		})
		.optional(),
	videoAdaptationSet: dashAdaptationOptionsSchema.optional(),
	audioAdaptationSet: dashAdaptationOptionsSchema.optional(),
	subtitleAdaptationSet: dashAdaptationOptionsSchema.optional(),
	representations: z.array(dashRepresentationOptionsSchema).max(256).optional(),
	additionalRepresentations: z
		.array(dashAdditionalRepresentationSchema)
		.max(64)
		.optional(),
});

export type HlsGlobalOptions = z.infer<typeof hlsGlobalOptionsSchema>;
export type DashGlobalOptions = z.infer<typeof dashGlobalOptionsSchema>;
export type DashAdaptationOptions = z.infer<typeof dashAdaptationOptionsSchema>;
export type DashRepresentationOptions = z.infer<
	typeof dashRepresentationOptionsSchema
>;
export type HlsMediaAttributes = z.infer<typeof hlsMediaAttributesSchema>;
export type HlsStreamOptions = z.infer<typeof hlsStreamOptionsSchema>;
export type HlsCustomTag = z.infer<typeof hlsCustomTagSchema>;
export type HlsDetailedOptions = z.infer<typeof hlsDetailedOptionsSchema>;
export type DashDetailedOptions = z.infer<typeof dashDetailedOptionsSchema>;
