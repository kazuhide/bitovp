import { ManifestType } from "@bitmovin/api-sdk";
import { NextResponse } from "next/server";
import { z } from "zod";
import { roleAtLeast } from "@/lib/auth/roles";
import {
	inspectStatisticsPage,
	STATISTICS_PAGE_SIZE,
} from "@/lib/encoding-statistics";
import { bitmovinClientFromBinding } from "@/lib/server/bitmovin";
import { getServerContext } from "@/lib/server/context";
import { jsonError, routeError, validationError } from "@/lib/server/http";

const query = z.strictObject({
	bitmovinAccountId: z.uuid().toLowerCase(),
	offset: z
		.string()
		.regex(/^\d+$/)
		.transform(Number)
		.pipe(z.int().nonnegative())
		.optional(),
});
const date = z.iso
	.datetime({ offset: true })
	.nullish()
	.transform((value) => value ?? undefined);
const page = z.object({
	status: z.literal("SUCCESS"),
	data: z.object({
		result: z.object({
			offset: z.int().nonnegative().optional(),
			totalCount: z.int().nonnegative(),
			items: z
				.array(
					z.object({
						id: z.uuid().toLowerCase(),
						type: z.enum(ManifestType),
						createdAt: date,
						modifiedAt: date,
					}),
				)
				.max(STATISTICS_PAGE_SIZE),
		}),
	}),
});

export async function GET(req: Request) {
	const response = await readManifests(req);
	response.headers.set("Cache-Control", "private, no-store");
	return response;
}

async function readManifests(req: Request) {
	const params = new URL(req.url).searchParams;
	const values = Object.fromEntries(params);
	if (params.size !== Object.keys(values).length)
		return jsonError(400, "Duplicate query parameter");
	const parsed = query.safeParse(values);
	if (!parsed.success) return validationError(parsed.error);
	const { bitmovinAccountId, offset = 0 } = parsed.data;
	const timeout = AbortSignal.timeout(15_000);
	const signal = AbortSignal.any([req.signal, timeout]);
	try {
		signal.throwIfAborted();
		const ctx = await getServerContext();
		if (!ctx.tenant || !roleAtLeast(ctx.tenant.role, "ADMIN"))
			return jsonError(403, "Admin access required");
		const binding =
			await ctx.bitmovinAccounts.revealForEncoding(bitmovinAccountId);
		signal.throwIfAborted();
		if (!binding) return jsonError(404, "Bitmovin account not found");
		let wire: z.infer<typeof page> | undefined;
		const api = bitmovinClientFromBinding(
			binding,
			signal,
			async (_url, response) => {
				if (response.ok) wire = page.parse(await response.clone().json());
			},
		);
		try {
			await api.encoding.manifests.list({
				offset,
				limit: STATISTICS_PAGE_SIZE,
				sort: "-createdAt",
			});
			const result = wire?.data.result;
			const paging =
				result &&
				inspectStatisticsPage(
					offset,
					result.totalCount,
					result.items.length,
					result.offset,
					true,
				);
			if (
				!result ||
				!paging ||
				new Set(result.items.map((item) => item.id)).size !==
					result.items.length
			)
				return jsonError(
					502,
					"Invalid manifest inventory response from Bitmovin",
				);
			return NextResponse.json({
				items: result.items,
				offset,
				totalCount: result.totalCount,
				nextOffset: paging.nextOffset,
			});
		} catch (error) {
			if (signal.aborted) throw error;
			return jsonError(502, "Bitmovin manifest inventory unavailable");
		}
	} catch (error) {
		if (timeout.aborted)
			return jsonError(504, "Bitmovin manifest inventory timed out");
		if (req.signal.aborted) return jsonError(499, "Request was cancelled");
		return routeError(error);
	}
}
