import { alertRuleCreateSchema } from "@bitovp/core";
import { NextResponse } from "next/server";
import { z } from "zod";
import { customerErrorDetails } from "@/lib/customer-error";
import { getServerContext } from "@/lib/server/context";
import {
	jsonError,
	readJson,
	routeError,
	validationError,
} from "@/lib/server/http";

/**
 * Alert rules . Global rules (liveChannelId null) apply to
 * every channel; channel-scoped rows come from the channel detail page.
 * Deleting a rule CASCADES its event history — the UI says so before the
 * click, and rows can be disabled instead.
 */

const listQuerySchema = z.object({
	liveChannelId: z.uuid().optional(),
});

export async function GET(req: Request) {
	const url = new URL(req.url);
	const parsed = listQuerySchema.safeParse({
		liveChannelId: url.searchParams.get("liveChannelId") ?? undefined,
	});
	if (!parsed.success) {
		return validationError(parsed.error);
	}
	try {
		const ctx = await getServerContext();
		const rules = await ctx.prisma.alertRule.findMany({
			where: parsed.data.liveChannelId
				? {
						OR: [
							{ liveChannelId: null },
							{ liveChannelId: parsed.data.liveChannelId },
						],
					}
				: {},
			orderBy: [{ createdAt: "asc" }],
			// review-83b N5: the one new list route without a bound.
			take: 200,
		});
		return NextResponse.json(rules);
	} catch (err) {
		return routeError(err);
	}
}

export async function POST(req: Request) {
	const parsed = alertRuleCreateSchema.safeParse(await readJson(req));
	if (!parsed.success) {
		return validationError(parsed.error);
	}
	try {
		const ctx = await getServerContext();
		const rule = await ctx.prisma.alertRule.create({
			data: {
				liveChannelId: parsed.data.liveChannelId,
				metric: parsed.data.metric,
				threshold: parsed.data.threshold ?? null,
				windowPolls: parsed.data.windowPolls,
				severity: parsed.data.severity,
				enabled: parsed.data.enabled,
			},
		});
		return NextResponse.json(rule, { status: 201 });
	} catch (err) {
		// review-83b N6: a well-formed but NONEXISTENT liveChannelId hits the
		// FK (P2003) — a client error, not a server fault.
		if (
			typeof err === "object" &&
			err !== null &&
			(err as { code?: string }).code === "P2003"
		) {
			return jsonError(
				422,
				"liveChannelId does not exist",
				customerErrorDetails("ALERT_CHANNEL_NOT_FOUND"),
			);
		}
		return routeError(err);
	}
}
