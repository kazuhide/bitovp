import { createHash } from "node:crypto";
import type BitmovinApi from "@bitmovin/api-sdk";
import type { StepLogEntry } from "@bitovp/core";
import { z } from "zod";
import { sameConfirmedResourceIds } from "../confirmed-resource-ids";
import {
	InvalidResourceResponse,
	isResourceId,
	type ResourceAddress,
} from "./family";
import {
	object,
	type parseResourceLog,
	type selectResource,
} from "./selection";

const limit = 100;
const confirmedFilters = z
	.array(z.uuid())
	.min(1)
	.max(limit)
	.refine(
		(ids) => new Set(ids).size === ids.length,
		"Filter ids must be distinct",
	);
export const streamFilterRemovalSchema = z.discriminatedUnion("mode", [
	z.strictObject({ mode: z.literal("one"), filterId: z.uuid() }),
	z.strictObject({ mode: z.literal("all"), filterIds: confirmedFilters }),
	z.strictObject({
		mode: z.literal("collection"),
		filterIds: confirmedFilters.optional(),
	}),
]);
type Command = z.infer<typeof streamFilterRemovalSchema>;
const filterList = z.array(z.object({ id: z.uuid() }));
type FilterInspection = { present: string[]; complete: boolean };

export function recordedStreamFilters(
	log: NonNullable<ReturnType<typeof parseResourceLog>>,
	selected: NonNullable<ReturnType<typeof selectResource>>,
): { ids: string[]; scopes: StepLogEntry["resourceAccount"][] } | null {
	if (selected.entry.kind !== "CREATE_STREAM") return null;
	const attachments = [...log.steps.values()].filter(
		(entry) =>
			entry.kind === "CREATE_STREAM_FILTERS" &&
			entry.status === "DONE" &&
			entry.refs.streamId === selected.entry.step &&
			entry.refs.encodingId === selected.entry.refs.encodingId,
	);
	if (attachments.length !== 1) return null;
	const attachment = attachments[0];
	if (!attachment || !Array.isArray(attachment.refs.filterIds)) return null;
	const filters = attachment.refs.filterIds.map((step) => log.steps.get(step));
	if (
		filters.some(
			(entry) =>
				entry?.status !== "DONE" ||
				!entry.kind.startsWith("CREATE_FILTER_") ||
				!isResourceId(entry.resourceId),
		)
	)
		return null;
	const ids = filters.flatMap((entry) =>
		entry?.resourceId ? [entry.resourceId] : [],
	);
	const refs = object(object(attachment.request)?.refs);
	if (
		refs &&
		(!Array.isArray(refs.filterIds) ||
			refs.filterIds.length !== ids.length ||
			ids.some((id, index) => id !== (refs.filterIds as unknown[])[index]))
	)
		return null;
	if (new Set(ids).size !== ids.length) return null;
	return {
		ids,
		scopes: [
			attachment.resourceAccount,
			...filters.map((entry) => entry?.resourceAccount),
		],
	};
}

export function streamFilterTargets(cmd: Command): readonly string[] {
	return cmd.mode === "one" ? [cmd.filterId] : (cmd.filterIds ?? []);
}

export function streamFilterPath({ id, parent }: ResourceAddress) {
	return `/v1/encoding/encodings/${parent("encodingId")}/streams/${id}/filters`;
}

export async function readEntireStreamFilterIds(
	api: BitmovinApi,
	{ id, parent }: ResourceAddress,
) {
	const page = await api.encoding.encodings.streams.filters.list(
		parent("encodingId"),
		id,
		{ offset: 0, limit },
	);
	const ids = filterList.parse(page.filters).map((filter) => filter.id);
	// No total is guaranteed by this SDK endpoint. A saturated page is ambiguous.
	if (ids.length >= limit || new Set(ids).size !== ids.length)
		throw new InvalidResourceResponse();
	return ids;
}

export function streamFilterChange(cmd: Command, address: ResourceAddress) {
	const { id, parent } = address;
	const encodingId = parent("encodingId");
	const confirmedIds = streamFilterTargets(cmd);
	const collection = cmd.mode === "collection";
	return {
		path: streamFilterPath(address),
		collection,
		confirmedIds,
		receiptSuffix:
			cmd.mode === "one"
				? cmd.filterId
				: (collection ? "collection:" : "") +
					createHash("sha256")
						.update(confirmedIds.toSorted().join(","))
						.digest("hex"),
		async inspect(
			api: BitmovinApi,
			requireCompleteMatch: boolean,
		): Promise<FilterInspection> {
			if (collection) {
				const present = await readEntireStreamFilterIds(api, address);
				if (
					requireCompleteMatch &&
					present.length !== 0 &&
					!sameConfirmedResourceIds(present, confirmedIds)
				)
					throw new InvalidResourceResponse();
				return { present, complete: true };
			}
			const observed = new Set<string>();
			let offset = 0;
			for (; ; offset += limit) {
				const page = await api.encoding.encodings.streams.filters.list(
					encodingId,
					id,
					{ offset, limit },
				);
				const rows = filterList.parse(page.filters);
				if (rows.length > limit) throw new InvalidResourceResponse();
				for (const filter of rows) {
					if (observed.has(filter.id)) throw new InvalidResourceResponse();
					observed.add(filter.id);
				}
				if (rows.length < limit) break;
			}
			const present = confirmedIds.filter((filterId) => observed.has(filterId));
			// Once a second page is needed, other edits can move an unseen
			// attachment behind the offset. The walk only proves presence.
			const complete = offset === 0;
			if (
				cmd.mode === "all" &&
				requireCompleteMatch &&
				(!complete || present.length > 0) &&
				!sameConfirmedResourceIds([...observed], confirmedIds)
			)
				throw new InvalidResourceResponse();
			return { present, complete };
		},
		async remove(api: BitmovinApi, inspection: FilterInspection) {
			if (collection) {
				await api.encoding.encodings.streams.filters.deleteAll(encodingId, id);
				if ((await readEntireStreamFilterIds(api, address)).length !== 0)
					throw new InvalidResourceResponse();
				return;
			}
			const targets = inspection.complete ? inspection.present : confirmedIds;
			for (const filterId of targets) {
				try {
					const result = await api.encoding.encodings.streams.filters.delete(
						encodingId,
						id,
						filterId,
					);
					if (result.id !== filterId) throw new InvalidResourceResponse();
				} catch (error) {
					const status = object(error);
					if (status?.httpStatusCode === 404 && status.errorCode === 1001)
						continue;
					// A preceding confirmed attachment may have been removed. Recheck
					// the original set on verification or retry.
					throw new InvalidResourceResponse();
				}
			}
		},
	};
}
