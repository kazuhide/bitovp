import {
	notificationRuleFilterSchema,
	PRODUCT_EVENT_KINDS,
} from "@bitovp/core";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerContext } from "@/lib/server/context";
import { jsonError, routeError } from "@/lib/server/http";

/**
 * Notification channels . The webhook URL lives in the
 * Credential vault (provider NOTIFICATION_WEBHOOK, validated by
 * secretEgressUrlSchema at save) — this route stores only the reference, so
 * listing is secret-free by construction. Settings UI lands in PR2; the API
 * is the PR1 path for creating a channel end-to-end.
 */

const createChannelSchema = z.object({
	name: z.string().min(1).max(120),
	/** PR1 delivers GENERIC_WEBHOOK; SLACK_WEBHOOK rows are accepted and
	    visibly skipped by the worker until PR2's rendering. */
	kind: z.enum(["GENERIC_WEBHOOK", "SLACK_WEBHOOK"]),
	credentialId: z.string().uuid(),
	rules: z
		.array(
			z.object({
				events: z
					.array(z.enum(PRODUCT_EVENT_KINDS as [string, ...string[]]))
					.min(1),
				filter: notificationRuleFilterSchema.optional(),
			}),
		)
		.min(1),
});

export async function GET() {
	try {
		const ctx = await getServerContext();
		const channels = await ctx.prisma.notificationChannel.findMany({
			orderBy: { createdAt: "desc" },
			include: { rules: true, credential: { select: { label: true } } },
		});
		return NextResponse.json(
			channels.map((channel) => ({
				id: channel.id,
				name: channel.name,
				kind: channel.kind,
				credentialId: channel.credentialId,
				credentialLabel: channel.credential.label,
				enabled: channel.enabled,
				rules: channel.rules.map((rule) => ({
					id: rule.id,
					events: rule.events,
					filter: rule.filter,
					enabled: rule.enabled,
				})),
			})),
		);
	} catch (err) {
		return routeError(err);
	}
}

export async function POST(req: Request) {
	try {
		const body = createChannelSchema.safeParse(await req.json());
		if (!body.success) {
			return jsonError(
				400,
				body.error.issues
					.map((issue) => `${issue.path.join(".")}: ${issue.message}`)
					.join("; "),
			);
		}
		const ctx = await getServerContext();
		const credential = await ctx.prisma.credential.findUnique({
			where: { id: body.data.credentialId },
			select: { provider: true },
		});
		if (!credential) {
			return jsonError(404, "Credential not found");
		}
		if (credential.provider !== "NOTIFICATION_WEBHOOK") {
			// The C22 rails hang off the provider's secret schema — a channel
			// pointing at (say) an S3 credential would egress nothing useful
			// and bypass the URL validation this feature depends on.
			return jsonError(
				400,
				"Channel credentials must use the NOTIFICATION_WEBHOOK provider",
			);
		}
		const created = await ctx.prisma.notificationChannel.create({
			data: {
				name: body.data.name,
				kind: body.data.kind,
				credentialId: body.data.credentialId,
				rules: {
					create: body.data.rules.map((rule) => ({
						events: rule.events,
						filter: rule.filter ?? {},
					})),
				},
			},
			include: { rules: true },
		});
		return NextResponse.json(
			{
				id: created.id,
				name: created.name,
				kind: created.kind,
				enabled: created.enabled,
				rules: created.rules.map((rule) => ({
					id: rule.id,
					events: rule.events,
				})),
			},
			{ status: 201 },
		);
	} catch (err) {
		return routeError(err);
	}
}
