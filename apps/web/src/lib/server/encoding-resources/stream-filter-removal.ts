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

export const streamFilterRemovalSchema = z.discriminatedUnion("mode", [
	z.strictObject({ mode: z.literal("one"), filterId: z.uuid() }),
	z.strictObject({
		mode: z.literal("all"),
		filterIds: z
			.array(z.uuid())
			.min(1)
			.max(100)
			.refine(
				(ids) => new Set(ids).size === ids.length,
				"Filter ids must be distinct",
			),
	}),
]);
type Command = z.infer<typeof streamFilterRemovalSchema>;
const filterList = z.array(z.object({ id: z.uuid() }));

export function recordedFilterScopes(
	log: NonNullable<ReturnType<typeof parseResourceLog>>,
	selected: NonNullable<ReturnType<typeof selectResource>>,
	cmd: Command,
): StepLogEntry["resourceAccount"][] | null {
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
	const targets = cmd.mode === "one" ? [cmd.filterId] : cmd.filterIds;
	if (
		new Set(ids).size !== ids.length ||
		targets.some((id) => !ids.includes(id))
	)
		return null;
	return [
		attachment.resourceAccount,
		...filters.map((entry) => entry?.resourceAccount),
	];
}

export function streamFilterChange(
	cmd: Command,
	{ id, parent }: ResourceAddress,
) {
	const encodingId = parent("encodingId");
	const confirmedIds = cmd.mode === "one" ? [cmd.filterId] : cmd.filterIds;
	return {
		path: `/v1/encoding/encodings/${encodingId}/streams/${id}/filters`,
		receiptSuffix:
			cmd.mode === "one"
				? cmd.filterId
				: createHash("sha256")
						.update(cmd.filterIds.toSorted().join(","))
						.digest("hex"),
		async inspect(api: BitmovinApi, requireCompleteMatch: boolean) {
			const observed = new Set<string>();
			const limit = 100;
			for (let offset = 0; ; offset += limit) {
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
			const remaining = confirmedIds.filter((filterId) =>
				observed.has(filterId),
			);
			if (
				cmd.mode === "all" &&
				requireCompleteMatch &&
				remaining.length &&
				!sameConfirmedResourceIds([...observed], confirmedIds)
			)
				throw new InvalidResourceResponse();
			return remaining;
		},
		async remove(api: BitmovinApi, remaining: readonly string[]) {
			for (const filterId of remaining) {
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
