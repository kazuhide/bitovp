export type ManifestResource = { value: string; label: string };
export type ManifestResources = {
	muxings: ManifestResource[];
	keyframes: ManifestResource[];
	sprites: ManifestResource[];
	drm: ManifestResource[];
	encodings: ManifestResource[];
};

export type Bag = Record<string, unknown>;
export type Spec = {
	name: string;
	type?:
		| "number"
		| "boolean"
		| "lines"
		| "object"
		| "rows"
		| "texts"
		| "condition";
	values?: readonly string[];
	resource?: keyof ManifestResources;
	fields?: Spec[];
	initial?: Bag;
};
const range: Spec[] = [
	{ name: "startSegmentNumber", type: "number" },
	{ name: "endSegmentNumber", type: "number" },
];
const mediaAttrs: Spec[] = [
	{ name: "assocLanguage" },
	{ name: "characteristics", type: "lines" },
	{ name: "isDefault", type: "boolean" },
	{ name: "autoselect", type: "boolean" },
	{ name: "forced", type: "boolean" },
	...range,
];
export const adaptation: Spec[] = [
	{
		name: "roles",
		type: "lines",
		values: [
			"ALTERNATE",
			"CAPTION",
			"COMMENTARY",
			"DUB",
			"MAIN",
			"SUBTITLE",
			"SUPPLEMENTARY",
		],
	},
	{
		name: "labels",
		type: "rows",
		fields: [{ name: "value" }, { name: "lang" }],
		initial: { value: "" },
	},
	{
		name: "accessibilities",
		type: "rows",
		fields: [{ name: "schemeIdUri" }, { name: "value" }],
		initial: { schemeIdUri: "", value: "" },
	},
	{
		name: "customAttributes",
		type: "rows",
		fields: [{ name: "key" }, { name: "value" }],
		initial: { key: "", value: "" },
	},
];
const tags: Spec[] = [
	{ name: "positionMode", values: ["TIME", "SEGMENT", "KEYFRAME"] },
	{ name: "time", type: "number" },
	{ name: "segment", type: "number" },
	{ name: "keyframeKey", resource: "keyframes" },
	{ name: "data" },
];
const tagSpec = (name: string): Spec => ({
	name,
	type: "rows",
	fields: tags,
	initial: { positionMode: "TIME", time: 0, data: "#EXT-X-" },
});
export const hlsGlobalFields: Spec[] = [
	{
		name: "channelsAttributeForAudio",
		values: ["ALWAYS", "STANDARD_CONFORM", "LEGACY"],
	},
	{
		name: "targetDurationRoundingMode",
		values: ["NORMAL_ROUNDING", "UPWARD_ROUNDING"],
	},
];
export const dashGlobalFields: Spec[] = [
	{ name: "dashEditionCompatibility", values: ["V4"] },
	{ name: "iso8601TimestampFormat", values: ["LONG", "SHORT"] },
	{ name: "minBufferTime", type: "number" },
	{
		name: "namespaces",
		type: "rows",
		fields: [{ name: "prefix" }, { name: "uri" }],
		initial: { prefix: "", uri: "" },
	},
	{
		name: "utcTimings",
		type: "rows",
		fields: [{ name: "schemeIdUri" }, { name: "value" }],
		initial: { schemeIdUri: "urn:mpeg:dash:utc:http-xsdate:2014", value: "" },
	},
];
export const hlsFields: Spec[] = [
	...hlsGlobalFields,
	{ name: "audioMedia", type: "object", fields: mediaAttrs },
	{ name: "subtitleMedia", type: "object", fields: mediaAttrs },
	{
		name: "streams",
		type: "object",
		fields: [
			{ name: "forceFrameRateAttribute", type: "boolean" },
			{ name: "forceVideoRangeAttribute", type: "boolean" },
			...range,
			{ name: "video" },
			{
				name: "audioGroups",
				type: "object",
				fields: [
					{ name: "droppingMode", values: ["STREAM", "AUDIO"] },
					{
						name: "groups",
						type: "rows",
						fields: [{ name: "name" }, { name: "priority", type: "number" }],
						initial: { name: "audio", priority: 0 },
					},
				],
			},
		],
	},
	{
		name: "additionalMedia",
		type: "rows",
		initial: {
			type: "VTT",
			name: "Subtitles",
			groupId: "subtitles",
			vttUrl: "",
			uri: "subtitles.m3u8",
		},
		fields: [
			{ name: "type", values: ["VIDEO", "CLOSED_CAPTIONS", "VTT"] },
			{ name: "name" },
			{ name: "groupId" },
			{ name: "language" },
			...mediaAttrs,
			{ name: "muxingKey", resource: "muxings" },
			{ name: "drmKey", resource: "drm" },
			{ name: "vttUrl" },
			{ name: "uri" },
			{ name: "instreamId" },
			tagSpec("customTags"),
		],
	},
	tagSpec("mediaCustomTags"),
	tagSpec("streamCustomTags"),
];
export const dashFields: Spec[] = [
	...dashGlobalFields,
	{
		name: "period",
		type: "object",
		fields: [
			{ name: "start", type: "number" },
			{ name: "duration", type: "number" },
			{ name: "customXmlElements", type: "texts" },
		],
	},
	{ name: "videoAdaptationSet", type: "object", fields: adaptation },
	{ name: "audioAdaptationSet", type: "object", fields: adaptation },
	{ name: "subtitleAdaptationSet", type: "object", fields: adaptation },
	{
		name: "representations",
		type: "rows",
		initial: { muxingKey: "" },
		fields: [
			{ name: "muxingKey", resource: "muxings" },
			{
				name: "mode",
				values: ["TEMPLATE_REPRESENTATION", "TEMPLATE_ADAPTATION_SET"],
			},
			...range,
			{ name: "startKeyframeKey", resource: "keyframes" },
			{ name: "endKeyframeKey", resource: "keyframes" },
			{ name: "dependencyMuxingKey", resource: "muxings" },
			{ name: "drmRepresentation", type: "boolean" },
			{
				name: "contentProtection",
				values: ["REPRESENTATION", "ADAPTATION_SET"],
			},
		],
	},
	{
		name: "additionalRepresentations",
		type: "rows",
		initial: { type: "VTT", vttUrl: "", lang: "en" },
		fields: [
			{ name: "type", values: ["VTT", "SPRITE", "PROGRESSIVE_WEBM"] },
			{ name: "vttUrl" },
			{ name: "lang" },
			{ name: "spriteKey", resource: "sprites" },
			{ name: "muxingKey", resource: "muxings" },
			{ name: "dependencyMuxingKey", resource: "muxings" },
			...adaptation,
		],
	},
];
