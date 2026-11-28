import "server-only";
import { classifyProviderStatusWord } from "@bitovp/core";
import type { AppTransactionClient } from "@bitovp/db";
import { NextResponse } from "next/server";
import { z } from "zod";
import { LIST_LIMIT_MAX } from "@/lib/infrastructure/schemas";
import { writeAuditLog } from "./audit";
import { bitmovinClientFromBinding } from "./bitmovin";
import {
	acknowledgedCollectionIds,
	sameConfirmedResourceIds,
} from "./confirmed-resource-ids";
import type { ServerContext } from "./context";
import {
	originalAccess,
	recordedScopeMatches,
} from "./encoding-resources/route";
import {
	parseResourceLog,
	selectResource,
} from "./encoding-resources/selection";
import { jsonError } from "./http";

const envelope = z.object({
	status: z.literal("SUCCESS"),
	data: z.object({ result: z.unknown() }),
});
const page = z.object({
	items: z
		.array(z.object({ id: z.uuid(), encodingId: z.uuid().optional() }))
		.max(LIST_LIMIT_MAX),
	totalCount: z.number().int().nonnegative(),
	offset: z.literal(0).optional(),
});

async function ownedTarget(
	db: Pick<AppTransactionClient, "liveChannelRun">,
	encodingId: string,
) {
	const run = await db.liveChannelRun.findUnique({
		where: { bitmovinEncodingId: encodingId },
		select: {
			id: true,
			liveChannelId: true,
			status: true,
			stepLog: true,
			liveChannel: {
				select: {
					origin: true,
					status: true,
					createdAt: true,
					plan: true,
					bitmovinAccountId: true,
					bitmovinEncodingId: true,
				},
			},
		},
	});
	if (run?.liveChannel.origin !== "MANAGED") return null;
	const log = parseResourceLog(run.stepLog);
	const steps = log?.ids.get(encodingId);
	const step = steps?.length === 1 ? steps[0] : undefined;
	const selected = log && step ? selectResource(log, step.step) : null;
	if (
		selected?.entry.kind !== "CREATE_ENCODING" ||
		!selected.entry.resourceAccount
	)
		return null;
	return { run, selected, channel: run.liveChannel };
}

type Command = {
	bitmovinAccountId: string;
	encodingId: string;
	confirmEncodingId: string;
	confirmMappingIds: string[];
};

export async function deleteDnsMappingCollection(
	req: Request,
	ctx: ServerContext,
	command: Command,
) {
	const {
		bitmovinAccountId,
		encodingId,
		confirmEncodingId,
		confirmMappingIds,
	} = command;
	if (encodingId !== confirmEncodingId)
		return jsonError(409, "Confirm the exact Live encoding ID.");
	const target = await ownedTarget(ctx.prisma, encodingId);
	if (!target) return jsonError(404, "Managed Live encoding not found.");
	if (target.selected.entry.resourceAccount?.id !== bitmovinAccountId)
		return jsonError(409, "The original provider account does not match.");
	const access = await originalAccess(ctx, target.channel, target.selected);
	if (!access) return jsonError(409, "The original provider account changed.");
	const path = `/encoding/live/encodings/${encodingId}/dns-mappings`;
	const startedAt = Date.now();
	let sent = false;
	const response = await ctx.prisma.$transaction(
		async (tx) => {
			const [account] = await tx.$queryRaw<
				{ id: string }[]
			>`SELECT id FROM "BitmovinAccount" WHERE id=${access.id}::uuid AND "resourceScopeVersion"=${access.resourceScopeVersion}::uuid FOR SHARE`;
			if (!account)
				return jsonError(409, "The original provider account changed.");
			// Use the same channel/run lock order as Live Start and Stop.
			await tx.$queryRaw`SELECT id FROM "LiveChannel" WHERE id=${target.run.liveChannelId}::uuid FOR UPDATE`;
			await tx.$queryRaw`SELECT id FROM "LiveChannelRun" WHERE id=${target.run.id}::uuid AND "liveChannelId"=${target.run.liveChannelId}::uuid FOR UPDATE`;
			const current = await ownedTarget(tx, encodingId);
			if (
				!current ||
				current.run.id !== target.run.id ||
				current.run.liveChannelId !== target.run.liveChannelId ||
				!recordedScopeMatches(current.channel, current.selected, access)
			)
				return jsonError(409, "The Live encoding or provider account changed.");
			const currentEncoding = current.channel.bitmovinEncodingId === encodingId;
			const running =
				current.run.status === "RUNNING" &&
				currentEncoding &&
				current.channel.status === "RUNNING";
			const stopped =
				current.run.status === "STOPPED" &&
				(!currentEncoding || current.channel.status === "STOPPED");
			if (!running && !stopped)
				return jsonError(
					409,
					"The Live encoding is changing state. Refresh before removing its DNS mappings.",
				);

			let raw: unknown;
			const api = bitmovinClientFromBinding(
				access,
				AbortSignal.timeout(15_000),
				async (_url, response) => {
					raw = response.ok
						? envelope.parse(await response.clone().json()).data.result
						: undefined;
				},
			);
			const mappings = api.encoding.live.encodings.dnsMappings;
			async function readIds() {
				await mappings.list(encodingId, { offset: 0, limit: LIST_LIMIT_MAX });
				const observed = page.parse(raw);
				if (
					observed.totalCount !== observed.items.length ||
					observed.items.some(
						(item) =>
							item.encodingId !== undefined && item.encodingId !== encodingId,
					)
				)
					throw new Error("The DNS mapping collection is incomplete.");
				return observed.items.map(({ id }) => id);
			}
			try {
				const { status } = await api.encoding.encodings.status(encodingId);
				if (
					running
						? status !== "RUNNING"
						: status !== "CREATED" &&
							classifyProviderStatusWord(status) !== "TERMINAL"
				)
					return jsonError(
						409,
						"The Bitmovin encoder state does not match the selected Live run.",
					);
				if (!sameConfirmedResourceIds(await readIds(), confirmMappingIds))
					return jsonError(
						409,
						"The DNS mappings changed. Refresh the list before removing them.",
					);
				sent = true;
				// This operates on the current provider collection. A provider-side
				// change after the read can affect which mappings it removes.
				await api.encoding.live.encodings.dnsMappings.deleteAll(encodingId);
				if (
					!acknowledgedCollectionIds(raw, confirmMappingIds) ||
					(await readIds()).length !== 0
				)
					throw new Error(
						"The DNS mapping collection removal could not be confirmed.",
					);
				return NextResponse.json({ ids: confirmMappingIds, unresolvedIds: [] });
			} catch {
				return jsonError(
					502,
					sent
						? "The DNS mapping removal could not be confirmed. Refresh the mappings before another attempt."
						: "Could not verify the Live encoding and its DNS mapping collection.",
				);
			}
		},
		{ timeout: 20_000 },
	);
	if (sent)
		await writeAuditLog(
			ctx,
			{
				method: "DELETE",
				path,
				bitmovinAccountId,
				statusCode: response.status,
				durationMs: Date.now() - startedAt,
				request: { mode: "collection", encodingId, confirmMappingIds },
				response: { confirmed: response.ok },
			},
			req,
		);
	response.headers.set("Cache-Control", "private, no-store");
	return response;
}
