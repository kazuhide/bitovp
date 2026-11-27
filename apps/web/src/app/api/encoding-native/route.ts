import {
	AwsCloudRegion,
	CodecConfigType,
	EncodingTemplateType,
	FilterType,
	GoogleCloudRegion,
	InputType,
	OutputType,
} from "@bitmovin/api-sdk";
import { publicStorageDiagnostic } from "@bitovp/core";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
	type EncodingCatalogueKind,
	encodingCatalogueKinds,
} from "@/lib/encoding-catalogue";
import { projectEncodingMetadata } from "@/lib/encoding-metadata";
import { bitmovinClientFromBinding } from "@/lib/server/bitmovin";
import { getServerContext } from "@/lib/server/context";
import { encodingCodecReader } from "@/lib/server/encoding-codec-catalogue";
import { encodingFilterReader } from "@/lib/server/encoding-filter-catalogue";
import { encodingIoReader } from "@/lib/server/encoding-io-catalogue";
import { jsonError, routeError, validationError } from "@/lib/server/http";

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const TIMEOUT_MS = 15_000;
const uuid = z.uuid().toLowerCase();
const pageNumber = z.string().regex(/^\d+$/).transform(Number);
const templateType = z.enum(["VOD", "LIVE"]);
const watchStatus = z.enum(["STOPPED", "STARTED", "ERROR"]);
const querySchema = z.strictObject({
	kind: z.enum(encodingCatalogueKinds),
	bitmovinAccountId: uuid,
	id: uuid.optional(),
	type: templateType.optional(),
	protocol: z.string().min(1).max(40).optional(),
	view: z.enum(["metadata", "type"]).optional(),
	offset: pageNumber.pipe(z.int().nonnegative()).optional(),
	limit: pageNumber.pipe(z.int().min(1).max(MAX_LIMIT)).optional(),
});

const resourceSchema = z.looseObject({
	id: uuid,
});
const metadataResponse = z.object({
	id: uuid.optional(),
	customData: z.unknown(),
});
const typeResponse = z.object({ id: uuid.optional(), type: z.string() });
const providerPage = z.object({
	items: z.array(resourceSchema).max(MAX_LIMIT),
	totalCount: z.int().nonnegative(),
	offset: z.int().nonnegative().optional(),
});
const providerResponse = z.object({
	status: z.literal("SUCCESS"),
	data: z.object({ result: z.unknown() }),
});
type Resource = z.infer<typeof resourceSchema>;
type Target = Pick<z.infer<typeof querySchema>, "kind" | "protocol">;
const timestamp = z.iso.datetime({ offset: true });
const awsRegion = z.enum(AwsCloudRegion);
const googleRegion = z.enum(GoogleCloudRegion);
const storageRegions: Readonly<Record<string, z.ZodType<string> | undefined>> =
	{
		s3: awsRegion,
		"s3-role-based": awsRegion,
		gcs: googleRegion,
		"gcs-service-account": googleRegion,
	};
const watchInput = z.object({ inputId: uuid });
const watchOutputs = z.array(z.object({ outputId: uuid }));
const positiveInteger = z.int().positive();
const positiveRate = z.number().positive();
const resourceTypes: Partial<Record<EncodingCatalogueKind, z.ZodType<string>>> =
	{
		codecs: z.enum(CodecConfigType),
		inputs: z.enum(InputType),
		outputs: z.enum(OutputType),
		filters: z.enum(FilterType),
	};

function project(item: Resource, { kind, protocol }: Target, detail = false) {
	const id = item.id;
	const name =
		typeof item.name === "string"
			? publicStorageDiagnostic(item.name).trim().slice(0, 240)
			: undefined;
	const createdAt = timestamp.safeParse(item.createdAt).data;
	const modifiedAt = timestamp.safeParse(item.modifiedAt).data;
	const resourceType =
		protocol === undefined
			? resourceTypes[kind]?.safeParse(item.type).data
			: undefined;
	const metadata = {
		id,
		name: name || undefined,
		createdAt,
		modifiedAt,
		resourceType,
	};
	if (kind === "templates") {
		return { ...metadata, type: templateType.safeParse(item.type).data };
	}
	if (kind === "inputs" || kind === "outputs") {
		return {
			...metadata,
			cloudRegion: protocol
				? storageRegions[protocol]?.safeParse(item.cloudRegion).data
				: undefined,
		};
	}
	if (kind === "video-codecs" || kind === "audio-codecs") {
		const bitrateBps = positiveInteger.safeParse(item.bitrate).data;
		if (kind === "audio-codecs") {
			return {
				...metadata,
				bitrateBps,
				sampleRateHz: positiveInteger.safeParse(item.rate).data,
			};
		}
		return {
			...metadata,
			bitrateBps,
			width: positiveInteger.safeParse(item.width).data,
			height: positiveInteger.safeParse(item.height).data,
			frameRate: positiveRate.safeParse(item.rate).data,
		};
	}
	if (kind !== "watch-folders") return metadata;
	return {
		...metadata,
		status: watchStatus.safeParse(item.status).data,
		...(detail && {
			inputId: watchInput.safeParse(item.input).data?.inputId,
			outputCount: watchOutputs.safeParse(item.outputs).data?.length,
		}),
	};
}

function malformedResponse() {
	return jsonError(502, "Invalid Encoding resource response from Bitmovin");
}

function response(data: object) {
	return NextResponse.json(data, {
		headers: { "Cache-Control": "private, no-store" },
	});
}

export async function GET(req: Request) {
	const params = new URL(req.url).searchParams;
	const values = Object.fromEntries(params);
	if (params.size !== Object.keys(values).length) {
		return jsonError(400, "Duplicate query parameter");
	}
	const query = querySchema.safeParse(values);
	if (!query.success) return validationError(query.error);
	const { kind, bitmovinAccountId, id, type, protocol, view } = query.data;
	const native = kind === "templates" || kind === "watch-folders";
	const reader =
		kind === "filters"
			? encodingFilterReader(protocol)
			: (encodingIoReader(kind, protocol) ??
				encodingCodecReader(kind, protocol));
	if (
		(id &&
			(type ||
				query.data.offset !== undefined ||
				query.data.limit !== undefined)) ||
		(type && kind !== "templates") ||
		(view === "metadata" && (!id || !reader?.metadata)) ||
		(view === "type" && (!id || !reader?.readType)) ||
		(native ? protocol !== undefined : !reader)
	) {
		return jsonError(
			400,
			"The selected resource does not accept these filters",
		);
	}
	const { offset = 0, limit = DEFAULT_LIMIT } = query.data;
	const timeout = AbortSignal.timeout(TIMEOUT_MS);
	const signal = AbortSignal.any([req.signal, timeout]);
	try {
		signal.throwIfAborted();
		const ctx = await getServerContext();
		const binding =
			await ctx.bitmovinAccounts.revealForEncoding(bitmovinAccountId);
		signal.throwIfAborted();
		if (!binding) return jsonError(404, "Bitmovin account not found");
		let result: unknown;
		const api = bitmovinClientFromBinding(
			binding,
			signal,
			async (_url, upstream) => {
				if (!upstream.ok) return;
				// Read the original pagination shape. The SDK maps missing items to an empty array.
				const body: unknown = await upstream.clone().json();
				result = providerResponse.safeParse(body).data?.data.result;
			},
		);
		try {
			if (reader && id) {
				await reader.get(api, id);
				if (view) {
					const parent = resourceSchema.safeParse(result).data;
					if (parent?.id !== id) return malformedResponse();
					const parentType = parent.type;
					signal.throwIfAborted();
					result = undefined;
					if (view === "metadata" && reader.metadata) {
						if (parentType !== undefined && parentType !== reader.expectedType)
							return malformedResponse();
						await reader.metadata(api, id);
						signal.throwIfAborted();
						const data = metadataResponse.safeParse(result).data;
						if (!data || (data.id !== undefined && data.id !== id))
							return malformedResponse();
						const metadata = projectEncodingMetadata(data.customData);
						return metadata
							? response({ kind, protocol, id, ...metadata })
							: malformedResponse();
					}
					if (view === "type" && reader.readType) {
						await reader.readType(api, id);
						signal.throwIfAborted();
						// The filter SDK returns a scalar enum, while output wraps its type.
						const data = typeResponse.safeParse(
							kind === "filters" && typeof result === "string"
								? { type: result }
								: result,
						).data;
						const resourceType = resourceTypes[kind]?.safeParse(
							data?.type,
						).data;
						return data &&
							resourceType &&
							(data.id === undefined || data.id === id) &&
							(parentType === undefined || parentType === resourceType)
							? response({ kind, id, resourceType })
							: malformedResponse();
					}
					return malformedResponse();
				}
			} else if (reader) {
				await reader.list(api, { offset, limit });
			} else if (kind === "templates") {
				if (id) await api.encoding.templates.get(id);
				else
					await api.encoding.templates.list({
						offset,
						limit,
						type: type && EncodingTemplateType[type],
					});
			} else if (id) {
				await api.encoding.watchFolders.get(id);
			} else {
				await api.encoding.watchFolders.list({ offset, limit });
			}
		} catch (err) {
			if (signal.aborted) throw err;
			if (
				id &&
				(err as { httpStatusCode?: number } | null)?.httpStatusCode === 404
			) {
				return jsonError(404, "Encoding resource not found");
			}
			return jsonError(502, "Bitmovin could not return the Encoding resource");
		}
		signal.throwIfAborted();
		const target = { kind, protocol };
		if (id) {
			const item = resourceSchema.safeParse(result).data;
			return item?.id === id
				? response({ ...target, item: project(item, target, true) })
				: malformedResponse();
		}
		const page = providerPage.safeParse(result).data;
		if (
			!page ||
			(page.offset !== undefined && page.offset !== offset) ||
			page.items.length > limit ||
			page.items.length > Math.max(0, page.totalCount - offset) ||
			(page.items.length === 0 && offset < page.totalCount) ||
			new Set(page.items.map((item) => item.id)).size !== page.items.length
		) {
			return malformedResponse();
		}
		return response({
			...target,
			offset,
			totalCount: page.totalCount,
			items: page.items.map((item) => project(item, target)),
		});
	} catch (err) {
		if (req.signal.aborted) return jsonError(499, "Request cancelled");
		if (timeout.aborted)
			return jsonError(504, "Encoding resource request timed out");
		return routeError(err);
	}
}
