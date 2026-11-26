import {
	AwsCloudRegion,
	EncodingTemplateType,
	GoogleCloudRegion,
} from "@bitmovin/api-sdk";
import { publicStorageDiagnostic } from "@bitovp/core";
import { NextResponse } from "next/server";
import { z } from "zod";
import { encodingCatalogueKinds } from "@/lib/encoding-catalogue";
import { bitmovinClientFromBinding } from "@/lib/server/bitmovin";
import { getServerContext } from "@/lib/server/context";
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
	offset: pageNumber.pipe(z.int().nonnegative()).optional(),
	limit: pageNumber.pipe(z.int().min(1).max(MAX_LIMIT)).optional(),
});

const resourceSchema = z.looseObject({
	id: uuid,
});
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

function project(item: Resource, { kind, protocol }: Target, detail = false) {
	const id = item.id;
	const name =
		typeof item.name === "string"
			? publicStorageDiagnostic(item.name).trim().slice(0, 240)
			: undefined;
	const createdAt = timestamp.safeParse(item.createdAt).data;
	const modifiedAt = timestamp.safeParse(item.modifiedAt).data;
	const metadata = { id, name: name || undefined, createdAt, modifiedAt };
	if (kind === "templates") {
		return { ...metadata, type: templateType.safeParse(item.type).data };
	}
	if (kind !== "watch-folders") {
		return {
			...metadata,
			cloudRegion: protocol
				? storageRegions[protocol]?.safeParse(item.cloudRegion).data
				: undefined,
		};
	}
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
	const { kind, bitmovinAccountId, id, type, protocol } = query.data;
	const io = encodingIoReader(kind, protocol);
	if (
		(id &&
			(type ||
				query.data.offset !== undefined ||
				query.data.limit !== undefined)) ||
		(type && kind !== "templates") ||
		(kind === "inputs" || kind === "outputs" ? !io : protocol !== undefined)
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
			if (io) {
				if (id) await io.get(api, id);
				else await io.list(api, { offset, limit });
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
