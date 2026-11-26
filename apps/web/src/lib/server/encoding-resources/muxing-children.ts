import type BitmovinApi from "@bitmovin/api-sdk";
import { z } from "zod";
import { muxingChildren } from "./families/muxing-children";
import { InvalidResourceResponse, type ResourceFields } from "./family";

type Child = {
	id?: string;
	type?: string;
	name?: string;
	createdAt?: Date;
	modifiedAt?: Date;
	positionMode?: string;
	time?: number;
	frame?: number;
	frameId?: string;
	method?: string;
};
type Page = { offset: number; limit: number };
type ChildPage = { items?: Child[]; totalCount?: number; offset?: number };
export type MuxingChildCollection = {
	label: string;
	// The SDK's general DRM list has no paging parameters. Show only the prefix actually returned.
	wholeCollection?: boolean;
	list(
		api: BitmovinApi,
		encodingId: string,
		muxingId: string,
		page: Page,
	): Promise<ChildPage>;
	get?(
		api: BitmovinApi,
		encodingId: string,
		muxingId: string,
		childId: string,
	): Promise<Child>;
	metadata?(
		api: BitmovinApi,
		encodingId: string,
		muxingId: string,
		childId: string,
	): Promise<{ customData?: Record<string, unknown> }>;
};
export type MuxingChildren = Record<
	string,
	Record<string, MuxingChildCollection>
>;
const idSchema = z.uuid();
const visibleTypes = new Set([
	"WIDEVINE",
	"PLAYREADY",
	"PRIMETIME",
	"FAIRPLAY",
	"MARLIN",
	"CLEARKEY",
	"AES",
	"CENC",
	"SPEKE",
	"RAW",
	"FRAME_ID",
	"PLAIN_TEXT",
]);

function fields(model: Child): ResourceFields {
	if (!idSchema.safeParse(model?.id).success || !model.id)
		throw new InvalidResourceResponse();
	const safe: ResourceFields = { id: model.id };
	if (typeof model.name === "string") safe.name = model.name;
	if (model.type && visibleTypes.has(model.type)) safe.type = model.type;
	for (const key of ["createdAt", "modifiedAt"] as const) {
		const value = model[key];
		if (value instanceof Date && Number.isFinite(value.getTime()))
			safe[key] = value.toISOString();
	}
	if (model.positionMode === "TIME" || model.positionMode === "FRAME")
		safe.positionMode = model.positionMode;
	if (model.method === "SAMPLE_AES" || model.method === "AES_128")
		safe.method = model.method;
	if (typeof model.frameId === "string" && /^[A-Z0-9]{4}$/.test(model.frameId))
		safe.frameId = model.frameId;
	for (const key of ["time", "frame"] as const) {
		const value = model[key];
		if (typeof value === "number" && Number.isFinite(value)) safe[key] = value;
	}
	return safe;
}
export function childCollectionsFor(kind: string) {
	return Object.hasOwn(muxingChildren, kind) ? muxingChildren[kind] : undefined;
}
export function childChoices(kind: string) {
	const collections = childCollectionsFor(kind);
	if (!collections) return undefined;
	return Object.entries(collections).map(([key, collection]) => ({
		key,
		label: collection.label,
		hasDetail: !!collection.get,
		hasMetadata: !!collection.metadata,
	}));
}
export async function readChildPage(
	api: BitmovinApi,
	collection: MuxingChildCollection,
	encodingId: string,
	muxingId: string,
	page: Page,
) {
	const result = await collection.list(api, encodingId, muxingId, page);
	const total = result?.totalCount;
	const start = collection.wholeCollection ? 0 : page.offset;
	if (
		typeof total !== "number" ||
		!Number.isSafeInteger(total) ||
		total < 0 ||
		!Array.isArray(result.items) ||
		(result.offset !== undefined && result.offset !== start)
	)
		throw new InvalidResourceResponse();
	const rows = result.items;
	if (
		collection.wholeCollection
			? rows.length > total || (rows.length === 0 && total > 0)
			: rows.length !== Math.min(page.limit, Math.max(0, total - page.offset))
	)
		throw new InvalidResourceResponse();
	const ids = new Set(rows.map((row) => row?.id));
	if (
		ids.size !== rows.length ||
		rows.some((row) => !idSchema.safeParse(row?.id).success)
	)
		throw new InvalidResourceResponse();
	const available = collection.wholeCollection ? rows.length : total;
	const items = (
		collection.wholeCollection
			? rows.slice(page.offset, page.offset + page.limit)
			: rows
	).map(fields);
	return { items, total, available, offset: page.offset };
}
export async function childFields(
	get: NonNullable<MuxingChildCollection["get"]>,
	api: BitmovinApi,
	encodingId: string,
	muxingId: string,
	id: string,
) {
	const row = await get(api, encodingId, muxingId, id);
	if (row?.id !== id) throw new InvalidResourceResponse();
	return fields(row);
}
