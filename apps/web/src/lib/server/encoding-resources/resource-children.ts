import type BitmovinApi from "@bitmovin/api-sdk";
import type {
	Child,
	ChildPage,
	Metadata,
	Page,
	ResourceChildCollection,
	ResourceChildren,
} from "./child-collection";
import { inspectChildWindow } from "./child-window";
import { encodingChildren } from "./families/encoding-children";
import { manifestChildren } from "./families/manifest-children";
import { muxingChildren } from "./families/muxing-children";
import { streamChildren } from "./families/stream-children";
import {
	InvalidResourceResponse,
	isResourceId,
	type ResourceAddress,
	type ResourceFields,
} from "./family";

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
	): Promise<Metadata>;
};
export type MuxingChildren = Record<
	string,
	Record<string, MuxingChildCollection>
>;
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

function fields(
	model: Child,
	collection: ResourceChildCollection,
): ResourceFields {
	if (!model.id) throw new InvalidResourceResponse();
	const safe: ResourceFields = { id: model.id };
	for (const key of ["createdAt", "modifiedAt"] as const) {
		const value = model[key];
		if (value instanceof Date && Number.isFinite(value.getTime()))
			safe[key] = value.toISOString();
	}
	if (collection.fields) {
		if (collection.expectedType && model.type === collection.expectedType)
			safe.type = model.type;
		for (const [key, rule] of Object.entries(collection.fields)) {
			const value: unknown = Reflect.get(model, key);
			if (
				(rule === "number" &&
					typeof value === "number" &&
					Number.isFinite(value)) ||
				(rule === "boolean" && typeof value === "boolean") ||
				(rule &&
					typeof rule !== "string" &&
					typeof value === "string" &&
					rule.includes(value))
			)
				safe[key] = value;
		}
		return safe;
	}
	if (typeof model.name === "string") safe.name = model.name;
	if (model.type && visibleTypes.has(model.type)) safe.type = model.type;
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

const muxingIds = (address: ResourceAddress) =>
	[address.parent("encodingId"), address.id] as const;
function muxingCollection(
	collection: MuxingChildCollection,
): ResourceChildCollection {
	const { get, metadata } = collection;
	return {
		label: collection.label,
		wholeCollection: collection.wholeCollection,
		list: (api, address, page) =>
			collection.list(api, ...muxingIds(address), page),
		get: get && ((api, address, id) => get(api, ...muxingIds(address), id)),
		metadata:
			metadata &&
			((api, address, id) => metadata(api, ...muxingIds(address), id)),
	};
}
const children: ResourceChildren = {
	...encodingChildren,
	...streamChildren,
	...manifestChildren,
	...Object.fromEntries(
		Object.entries(muxingChildren).map(([kind, collections]) => [
			kind,
			Object.fromEntries(
				Object.entries(collections).map(([key, collection]) => [
					key,
					muxingCollection(collection),
				]),
			),
		]),
	),
};

export function childCollectionsFor(kind: string) {
	return Object.hasOwn(children, kind) ? children[kind] : undefined;
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
async function verifiedWindow(
	api: BitmovinApi,
	collection: ResourceChildCollection,
	address: ResourceAddress,
	page: Page,
	targetId?: string,
) {
	const window = inspectChildWindow(
		await collection.list(api, address, page),
		page,
		!!collection.wholeCollection,
		isResourceId,
		targetId,
	);
	if (!window) throw new InvalidResourceResponse();
	return window;
}

export async function readChildPage(
	api: BitmovinApi,
	collection: ResourceChildCollection,
	address: ResourceAddress,
	page: Page,
) {
	const { rows, total, available, start, end } = await verifiedWindow(
		api,
		collection,
		address,
		page,
	);
	const items = (
		collection.wholeCollection ? rows.slice(start, end) : rows
	).map((row) => fields(row, collection));
	return { items, total, available, offset: page.offset };
}

export async function childIsOnPage(
	api: BitmovinApi,
	collection: ResourceChildCollection,
	address: ResourceAddress,
	page: Page,
	id: string,
) {
	return (await verifiedWindow(api, collection, address, page, id))
		.containsTarget;
}

export async function readChildDetail(
	api: BitmovinApi,
	collection: ResourceChildCollection,
	address: ResourceAddress,
	id: string,
) {
	const row = await collection.get?.(api, address, id);
	if (row?.id !== id) throw new InvalidResourceResponse();
	return fields(row, collection);
}
