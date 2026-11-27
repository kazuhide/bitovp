import type BitmovinApi from "@bitmovin/api-sdk";
import {
	AdaptationSetType,
	DashRepresentationTypeDiscriminator,
	EncodingMode,
	InputStreamType,
	ManifestGenerator,
	ManifestType,
	MediaInfoType,
	MuxingType,
} from "@bitmovin/api-sdk";
import { z } from "zod";
import { inspectStatisticsPage } from "@/lib/encoding-statistics";
import { bitmovinClientFromBinding } from "../bitmovin";
import type { Page } from "./child-collection";
import { protectedManifests } from "./families/protected-manifests";
import {
	InvalidResourceResponse,
	type ResourceAddress,
	type ResourceFamily,
	type ResourceFields,
	type ResourcePage,
} from "./family";

export type DiagnosticChoice = { key: string; label: string; labelJa: string };
type DiagnosticResult =
	| { fields: ResourceFields }
	| (ResourcePage & { nextOffset: number | null });
type Target = {
	address: ResourceAddress;
	id: string;
	page: Page;
	listedType?: string;
};
type Diagnostic = Omit<DiagnosticChoice, "key"> & {
	resultId?: "nested";
	vodOnly?: true;
	read(api: BitmovinApi, target: Target): Promise<unknown>;
	project(result: unknown, target: Target): DiagnosticResult;
};
type Diagnostics = Record<string, Diagnostic>;

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
	const parsed = schema.safeParse(value);
	if (!parsed.success) throw new InvalidResourceResponse();
	return parsed.data;
}

function fields(
	values: Record<string, ResourceFields[string] | undefined>,
): DiagnosticResult {
	const projected: ResourceFields = {};
	for (const [key, value] of Object.entries(values)) {
		if (value !== undefined) projected[key] = value;
	}
	return { fields: projected };
}

const nonnegative = z.number().finite().nonnegative();
const itemList = z.array(z.object({}));
const optionalCount = itemList.optional();
const manifestOptions = z.object({
	manifestGenerator: z.enum(ManifestGenerator).optional(),
});
const manifestStartProjection = (value: unknown) =>
	fields({ startRequestAvailable: true, ...parse(manifestOptions, value) });
const startOptions = manifestOptions.extend({
	encodingMode: z.enum(EncodingMode).optional(),
	handleVariableInputFps: z.boolean().optional(),
	trimming: z
		.object({
			offset: nonnegative.optional(),
			duration: nonnegative.optional(),
		})
		.optional(),
	vodDashManifests: optionalCount,
	vodHlsManifests: optionalCount,
	vodSmoothManifests: optionalCount,
});
const muxingInformation = z.object({
	fileSize: nonnegative.optional(),
	containerBitrate: nonnegative.nullish(),
	duration: nonnegative.optional(),
	videoTracks: optionalCount,
	audioTracks: optionalCount,
});
function muxingProjection(value: unknown) {
	const info = parse(muxingInformation, value);
	return fields({
		fileSizeBytes: info.fileSize,
		containerBitrateBps: info.containerBitrate ?? undefined,
		durationSeconds: info.duration,
		videoTrackCount: info.videoTracks?.length,
		audioTrackCount: info.audioTracks?.length,
	});
}
const inputDetails = z.object({
	duration: nonnegative.optional(),
	size: nonnegative.optional(),
	bitrate: nonnegative.optional(),
	videoStreams: optionalCount,
	audioStreams: optionalCount,
	subtitleStreams: optionalCount,
	metaStreams: optionalCount,
});
const psnrPage = z.object({
	offset: z.int().nonnegative().optional(),
	totalCount: z.int().nonnegative(),
	items: z.array(
		z.object({
			psnr: z.number().finite(),
			timeSpan: z.object({ from: nonnegative, to: nonnegative }),
		}),
	),
});
const manifestPaths = z.object({
	dashManifests: optionalCount,
	hlsManifests: optionalCount,
	smoothManifests: optionalCount,
});
const muxingInfo: Pick<Diagnostic, "label" | "labelJa" | "project"> = {
	label: "Output information",
	labelJa: "出力情報",
	project: muxingProjection,
};
function typeView(
	schema: z.ZodType<string>,
	read: Diagnostic["read"],
	recordedType?: string,
): Diagnostic {
	const responseType = z.object({ type: schema });
	return {
		label: "Resource type",
		labelJa: "リソース種別",
		read,
		project: (value, { listedType }) => {
			const data = parse(responseType, value);
			const expectedType = recordedType ?? listedType;
			if (expectedType !== undefined && data.type !== expectedType)
				throw new InvalidResourceResponse();
			return { fields: data };
		},
	};
}
const manifestType = (type: ManifestType) =>
	typeView(z.literal(type), (api, { id }) =>
		api.encoding.manifests.type.get(id),
	);
const adaptationType = (type: string) =>
	typeView(
		z.enum(AdaptationSetType),
		(api, { id, address }) =>
			api.encoding.manifests.dash.periods.adaptationsets.type.get(
				address.parent("manifestId"),
				address.parent("periodId"),
				id,
			),
		type,
	);
const representationType = (type: string) =>
	typeView(
		z.enum(DashRepresentationTypeDiscriminator),
		(api, { id, address }) =>
			api.encoding.manifests.dash.periods.adaptationsets.representations.type.get(
				address.parent("manifestId"),
				address.parent("periodId"),
				address.parent("adaptationSetId"),
				id,
			),
		type,
	);
const mediaType = (type: string) =>
	typeView(
		z.enum(MediaInfoType),
		(api, { id, address }) =>
			api.encoding.manifests.hls.media.type.get(
				address.parent("manifestId"),
				id,
			),
		type,
	);
const manifestStart = {
	label: "Manifest start request",
	labelJa: "マニフェストの開始設定",
	project: manifestStartProjection,
};

const recorded: Record<string, Diagnostics> = {
	CREATE_ENCODING: {
		start: {
			label: "Encoding start request",
			labelJa: "エンコード開始設定",
			vodOnly: true,
			read: (api, { id }) => api.encoding.encodings.getStartRequest(id),
			project: (value) => {
				const config = parse(startOptions, value);
				return fields({
					startRequestAvailable: true,
					encodingMode: config.encodingMode,
					manifestGenerator: config.manifestGenerator,
					handleVariableInputFps: config.handleVariableInputFps,
					vodDashManifestCount: config.vodDashManifests?.length,
					vodHlsManifestCount: config.vodHlsManifests?.length,
					vodSmoothManifestCount: config.vodSmoothManifests?.length,
					trimOffsetSeconds: config.trimming?.offset,
					trimDurationSeconds: config.trimming?.duration,
				});
			},
		},
		kantar: {
			label: "Kantar watermark",
			labelJa: "Kantarウォーターマーク",
			// The SDK model's ID belongs to the watermark under this encoding.
			resultId: "nested",
			read: (api, { id }) => api.encoding.encodings.kantarWatermark.get(id),
			project: (value) => {
				const info = parse(
					z.object({
						licenseId: z.int().positive(),
						reportOutputs: optionalCount,
					}),
					value,
				);
				return fields({
					configured: true,
					reportOutputCount: info.reportOutputs?.length,
				});
			},
		},
		outputPaths: {
			label: "Output destinations",
			labelJa: "出力先の内訳",
			read: (api, { id }) => api.encoding.encodings.outputPaths.get(id),
			project: (value) => {
				const entries = parse(
					z.array(z.object({ paths: manifestPaths.optional() })),
					value,
				);
				const count = (format: keyof z.infer<typeof manifestPaths>) => {
					let total = 0;
					for (const { paths } of entries) {
						const manifests = paths?.[format];
						if (manifests === undefined) return;
						total += manifests.length;
					}
					return total;
				};
				return fields({
					outputCount: entries.length,
					dashManifestCount: count("dashManifests"),
					hlsManifestCount: count("hlsManifests"),
					smoothManifestCount: count("smoothManifests"),
				});
			},
		},
		template: {
			label: "Encoding template availability",
			labelJa: "エンコードテンプレート",
			read: (api, { id }) => api.encoding.encodings.template.get(id),
			project: (value) => {
				parse(z.object({ url: z.url({ protocol: /^https?$/ }) }), value);
				return fields({ available: true });
			},
		},
	},
	CREATE_STREAM: {
		filters: {
			label: "Applied filters",
			labelJa: "適用フィルター",
			read: (api, { id, address }) =>
				api.encoding.encodings.streams.filters.list(
					address.parent("encodingId"),
					id,
				),
			project: (value) => {
				const { filters } = parse(
					z.object({
						filters: z.array(
							z.object({ id: z.uuid(), position: z.int().nonnegative() }),
						),
					}),
					value,
				);
				if (!filters.length) return fields({ filterCount: 0 });
				let firstPosition = Infinity;
				let lastPosition = -Infinity;
				for (const { position } of filters) {
					firstPosition = Math.min(firstPosition, position);
					lastPosition = Math.max(lastPosition, position);
				}
				return fields({
					filterCount: filters.length,
					firstPosition,
					lastPosition,
				});
			},
		},
		input: {
			label: "Input media analysis",
			labelJa: "入力素材の解析",
			read: (api, { id, address }) =>
				api.encoding.encodings.streams.input.get(
					address.parent("encodingId"),
					id,
				),
			project: (value) => {
				const info = parse(inputDetails, value);
				return fields({
					durationSeconds: info.duration,
					fileSizeBytes: info.size,
					bitrateBps: info.bitrate,
					videoTrackCount: info.videoStreams?.length,
					audioTrackCount: info.audioStreams?.length,
					subtitleTrackCount: info.subtitleStreams?.length,
					metadataTrackCount: info.metaStreams?.length,
				});
			},
		},
		inputs: {
			label: "Stream inputs",
			labelJa: "ストリーム入力",
			read: (api, { id, address }) =>
				api.encoding.encodings.streams.inputs.list(
					address.parent("encodingId"),
					id,
				),
			project: (value) => {
				const inputs = parse(
					z.object({
						offset: z.literal(0).optional(),
						totalCount: z.int().nonnegative(),
						items: z.array(
							z.object({ inputId: z.uuid(), details: inputDetails.optional() }),
						),
					}),
					value,
				);
				if (
					inputs.items.length > inputs.totalCount ||
					(!inputs.items.length && inputs.totalCount)
				)
					throw new InvalidResourceResponse();
				return fields({
					inputCount: inputs.totalCount,
					reportedInputs: inputs.items.length,
					analyzedInputs: inputs.items.filter(
						(row) => row.details !== undefined,
					).length,
				});
			},
		},
		psnr: {
			label: "Provider PSNR",
			labelJa: "BitmovinのPSNR",
			read: (api, { id, address, page }) =>
				api.encoding.encodings.streams.qc.psnr.list(
					address.parent("encodingId"),
					id,
					page,
				),
			project: (value, { page: { offset, limit } }) => {
				const result = parse(psnrPage, value);
				const page = inspectStatisticsPage(
					offset,
					result.totalCount,
					result.items.length,
					result.offset,
					true,
				);
				if (!page || result.items.length > limit)
					throw new InvalidResourceResponse();
				const ids = new Set<string>();
				const items = result.items.map(({ psnr, timeSpan: { from, to } }) => {
					const id = `${from}:${to}`;
					if (to < from || ids.has(id)) throw new InvalidResourceResponse();
					ids.add(id);
					return {
						id,
						fromSeconds: from / 1000,
						toSeconds: to / 1000,
						psnrDb: psnr,
					};
				});
				return {
					offset,
					total: result.totalCount,
					items,
					nextOffset: page.nextOffset,
				};
			},
		},
	},
	CREATE_MANIFEST_DASH: {
		type: manifestType(ManifestType.DASH),
		start: {
			...manifestStart,
			read: (api, { id }) => api.encoding.manifests.dash.getStartRequest(id),
		},
	},
	CREATE_MANIFEST_HLS: {
		type: manifestType(ManifestType.HLS),
		start: {
			...manifestStart,
			read: (api, { id }) => api.encoding.manifests.hls.getStartRequest(id),
		},
	},
	CREATE_MANIFEST_SMOOTH: {
		type: manifestType(ManifestType.SMOOTH_STREAMING),
		start: {
			...manifestStart,
			read: (api, { id }) => api.encoding.manifests.smooth.getStartRequest(id),
		},
	},
};

const encodingChild: Record<string, Diagnostics> = {
	muxings: {
		type: typeView(z.enum(MuxingType), (api, { id, address }) =>
			api.encoding.encodings.muxings.type.get(address.id, id),
		),
	},
	inputStreams: {
		type: typeView(z.enum(InputStreamType), (api, { id, address }) =>
			api.encoding.encodings.inputStreams.type.get(address.id, id),
		),
	},
	"muxings.broadcastTs": {
		information: {
			...muxingInfo,
			read: (api, { id, address }) =>
				api.encoding.encodings.muxings.broadcastTs.information.get(
					address.id,
					id,
				),
		},
	},
	"muxings.mp3": {
		information: {
			...muxingInfo,
			read: (api, { id, address }) =>
				api.encoding.encodings.muxings.mp3.information.get(address.id, id),
		},
	},
	"muxings.packedAudio": {
		information: {
			...muxingInfo,
			read: (api, { id, address }) =>
				api.encoding.encodings.muxings.packedAudio.information.get(
					address.id,
					id,
				),
		},
	},
};

const protectedRepresentationTypes = new Map([
	[protectedManifests.FMP4_REP, DashRepresentationTypeDiscriminator.DRM_FMP4],
	[protectedManifests.MP4_REP, DashRepresentationTypeDiscriminator.DRM_MP4],
]);

function lookup(
	kind: string,
	collection?: string,
	family?: ResourceFamily,
): Diagnostics | undefined {
	if (collection)
		return kind === "CREATE_ENCODING" &&
			Object.hasOwn(encodingChild, collection)
			? encodingChild[collection]
			: undefined;
	if (Object.hasOwn(recorded, kind)) return recorded[kind];
	const adaptationPrefix = "CREATE_DASH_ADAPTATION_SET_";
	if (kind.startsWith(adaptationPrefix))
		return { type: adaptationType(kind.slice(adaptationPrefix.length)) };
	const representationPrefix = "CREATE_DASH_REPRESENTATION_";
	if (kind.startsWith(representationPrefix))
		return {
			type: representationType(
				(family && protectedRepresentationTypes.get(family)) ??
					kind.slice(representationPrefix.length),
			),
		};
	const media =
		/^CREATE_HLS_(AUDIO|CLOSED_CAPTIONS|SUBTITLES|VIDEO|VTT)_MEDIA$/.exec(
			kind,
		)?.[1];
	if (media) return { type: mediaType(media) };
}

export function diagnosticChoices(
	kind: string,
	live: boolean,
	collection?: string,
): DiagnosticChoice[] | undefined {
	const definitions = lookup(kind, collection);
	return (
		definitions &&
		Object.entries(definitions)
			.filter(([, diagnostic]) => !live || !diagnostic.vodOnly)
			.map(([key, { label, labelJa }]) => ({ key, label, labelJa }))
	);
}

export function diagnosticFor(
	kind: string,
	key: string,
	collection: string | undefined,
	family: ResourceFamily,
	live: boolean,
) {
	const definitions = lookup(kind, collection, family);
	if (!definitions || !Object.hasOwn(definitions, key)) return;
	const diagnostic = definitions[key];
	return live && diagnostic?.vodOnly ? undefined : diagnostic;
}

const providerResponse = z.object({
	status: z.literal("SUCCESS"),
	data: z.object({ result: z.unknown() }),
});
const resultIdentity = z.object({ id: z.string().optional() });

/** Read the wire result. Some SDK models discard malformed values or fill in defaults. */
export async function inspectDiagnostic(
	diagnostic: Diagnostic,
	target: Target,
	access: { apiKey: string; tenantOrgId?: string | null },
	signal: AbortSignal,
) {
	let result: unknown;
	const api = bitmovinClientFromBinding(
		access,
		signal,
		async (_url, response) => {
			if (!response.ok) return;
			const responseBody: unknown = await response.clone().json();
			result = parse(providerResponse, responseBody).data.result;
			if (!Array.isArray(result)) {
				const identity = parse(resultIdentity, result).id;
				if (
					identity !== undefined &&
					diagnostic.resultId !== "nested" &&
					identity !== target.id
				)
					throw new InvalidResourceResponse();
			}
		},
	);
	await diagnostic.read(api, target);
	if (result === undefined) throw new InvalidResourceResponse();
	return diagnostic.project(result, target);
}
