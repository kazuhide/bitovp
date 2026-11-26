import type {
	HeAacV1AudioConfiguration,
	HeAacV2AudioConfiguration,
	PaginationResponse,
} from "@bitmovin/api-sdk";
import { defineFamily, InvalidResourceResponse } from "../family";

type NamedConfiguration = { id?: string; name?: string };
type NameQuery = { name: string; offset: number; limit: number };
const fields = [
	"name",
	"bitrate",
	"rate",
	"channelLayout",
	"signaling",
	"createdAt",
	"modifiedAt",
] as const;

/** The SDK lists the provider account. Return only the configuration recorded on this execution. */
async function listLinked<T extends NamedConfiguration>(
	id: string,
	localOffset: number,
	get: () => Promise<T>,
	list: (query: NameQuery) => Promise<PaginationResponse<T>>,
) {
	const current = await get();
	if (current?.id !== id || typeof current.name !== "string" || !current.name)
		throw new InvalidResourceResponse();
	const seen = new Set<string>();
	let total: number | undefined;
	const limit = 100;
	for (let offset = 0; offset < 400; offset += limit) {
		const page = await list({ name: current.name, offset, limit });
		const count = page?.totalCount;
		if (
			typeof count !== "number" ||
			!Number.isSafeInteger(count) ||
			count < 0 ||
			(total !== undefined && count !== total) ||
			(page.offset !== undefined && page.offset !== offset) ||
			!Array.isArray(page.items) ||
			page.items.length !== Math.min(limit, Math.max(0, count - offset))
		)
			throw new InvalidResourceResponse();
		total = count;
		let match: T | undefined;
		for (const item of page.items) {
			if (typeof item?.id !== "string" || !item.id || seen.has(item.id))
				throw new InvalidResourceResponse();
			seen.add(item.id);
			if (item.id === id) match = item;
		}
		if (match)
			return {
				offset: localOffset,
				totalCount: 1,
				items: localOffset === 0 ? [match] : [],
			};
		if (offset + limit >= count)
			return { offset: localOffset, totalCount: 0, items: [] };
	}
	throw new InvalidResourceResponse();
}

export const heAac = {
	CREATE_CODEC_HE_AAC_V1: defineFamily<HeAacV1AudioConfiguration>({
		parents: [],
		fields,
		listScope: "linked",
		get: (api, { id }) => api.encoding.configurations.audio.heAacV1.get(id),
		remove: (api, { id }) =>
			api.encoding.configurations.audio.heAacV1.delete(id),
		customData: (api, { id }) =>
			api.encoding.configurations.audio.heAacV1.customdata.get(id),
		list: (api, { id }, page) =>
			listLinked(
				id,
				page.offset,
				() => api.encoding.configurations.audio.heAacV1.get(id),
				(query) => api.encoding.configurations.audio.heAacV1.list(query),
			),
	}),
	CREATE_CODEC_HE_AAC_V2: defineFamily<HeAacV2AudioConfiguration>({
		parents: [],
		fields,
		listScope: "linked",
		get: (api, { id }) => api.encoding.configurations.audio.heAacV2.get(id),
		remove: (api, { id }) =>
			api.encoding.configurations.audio.heAacV2.delete(id),
		customData: (api, { id }) =>
			api.encoding.configurations.audio.heAacV2.customdata.get(id),
		list: (api, { id }, page) =>
			listLinked(
				id,
				page.offset,
				() => api.encoding.configurations.audio.heAacV2.get(id),
				(query) => api.encoding.configurations.audio.heAacV2.list(query),
			),
	}),
};
