import type BitmovinApi from "@bitmovin/api-sdk";

export type ParentRef =
	| "encodingId"
	| "muxingId"
	| "drmId"
	| "representationId"
	| "streamId"
	| "manifestId"
	| "periodId"
	| "adaptationSetId"
	| "streamInfoId";
export type ResourceAddress = {
	id: string;
	parent(ref: ParentRef): string;
};
export type ResourceFields = Record<string, string | number | boolean>;
export type ResourcePage = {
	offset: number;
	total: number;
	items: ResourceFields[];
};
export type ResourceFamily = {
	parents: readonly ParentRef[];
	listScope?: "linked";
	customData?: (
		api: BitmovinApi,
		address: ResourceAddress,
	) => Promise<{ customData?: Record<string, unknown> }>;
	detail(api: BitmovinApi, address: ResourceAddress): Promise<ResourceFields>;
	information?: (
		api: BitmovinApi,
		address: ResourceAddress,
	) => Promise<ResourceFields>;
	list?: (
		api: BitmovinApi,
		address: ResourceAddress,
		page: { offset: number; limit: number },
	) => Promise<ResourcePage>;
	remove?(api: BitmovinApi, address: ResourceAddress): Promise<void>;
};
export class InvalidResourceResponse extends Error {}

type ProviderResource = { id?: string };
type Page = { offset: number; limit: number };

/** Use the model fields listed by each SDK family. Inputs, outputs and their delete responses can contain credentials. */
export function projectResourceFields<T extends ProviderResource>(
	model: T,
	fields: readonly (keyof T & string)[],
): ResourceFields {
	if (!model || typeof model.id !== "string" || !model.id)
		throw new InvalidResourceResponse();
	const safe: ResourceFields = { id: model.id };
	for (const key of fields) {
		const value = model[key];
		if (value instanceof Date && Number.isFinite(value.getTime()))
			safe[key] = value.toISOString();
		else if (
			typeof value === "boolean" ||
			(typeof value === "number" && Number.isFinite(value)) ||
			typeof value === "string"
		)
			safe[key] = value;
	}
	return safe;
}

export function defineFamily<T extends ProviderResource>(definition: {
	parents: readonly ParentRef[];
	fields: readonly (NoInfer<keyof T> & string)[];
	listScope?: "linked";
	customData?: ResourceFamily["customData"];
	get: (api: BitmovinApi, address: ResourceAddress) => Promise<T>;
	information?: ResourceFamily["information"];
	list?: (
		api: BitmovinApi,
		address: ResourceAddress,
		page: Page,
	) => Promise<{ items?: T[]; totalCount?: number; offset?: number }>;
	remove: (
		api: BitmovinApi,
		address: ResourceAddress,
	) => Promise<ProviderResource>;
}): ResourceFamily & Required<Pick<ResourceFamily, "remove">> {
	const list = definition.list;
	return {
		parents: definition.parents,
		listScope: definition.listScope,
		customData: definition.customData,
		information: definition.information,
		async detail(api, address) {
			const model = await definition.get(api, address);
			if (model?.id !== address.id) throw new InvalidResourceResponse();
			return projectResourceFields(model, definition.fields);
		},
		...(list
			? {
					async list(api: BitmovinApi, address: ResourceAddress, page: Page) {
						const result = await list(api, address, page);
						const total = result?.totalCount;
						if (
							typeof total !== "number" ||
							!Number.isSafeInteger(total) ||
							total < 0 ||
							!Array.isArray(result.items) ||
							result.items.length > page.limit ||
							(result.offset !== undefined && result.offset !== page.offset) ||
							result.items.length !==
								Math.min(page.limit, Math.max(total - page.offset, 0))
						)
							throw new InvalidResourceResponse();
						const items = result.items.map((row) =>
							projectResourceFields(row, definition.fields),
						);
						if (
							definition.listScope === "linked" &&
							(total > 1 || items.some((row) => row.id !== address.id))
						)
							throw new InvalidResourceResponse();
						if (new Set(items.map((row) => row.id)).size !== items.length)
							throw new InvalidResourceResponse();
						return { offset: page.offset, total, items };
					},
				}
			: {}),
		async remove(api, address) {
			const result = await definition.remove(api, address);
			if (result?.id !== address.id) throw new InvalidResourceResponse();
		},
	};
}
