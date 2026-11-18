import {
	CREDENTIAL_PROVIDER_SHAPES,
	moqDraftVersionSchema,
	moqPlaybackUrlSchema,
	moqTrackNamespaceSchema,
} from "@bitovp/core";
import { z } from "zod";
import { publicContextError } from "@/lib/auth/public-context-error";
import { roleAtLeast } from "@/lib/auth/roles";
import { AuthContextError } from "@/lib/auth/tenancy";
import type { MoqReadiness } from "@/lib/moq-player/readiness";
import { getServerContext, type ServerContext } from "@/lib/server/context";
import { readMoqPlayerBundle } from "@/lib/server/moq-player-asset";
import { inspectMoqRelayMetadata } from "@/lib/server/moq-relay-metadata";
import { readPlayerSettings } from "@/lib/server/player-config";

const outputFields = {
	credentialId: z.uuid(),
	draftVersion: moqDraftVersionSchema,
};
const requestSchema = z.union([
	z.strictObject({ channelId: z.uuid() }),
	z.strictObject({
		...outputFields,
		namespaceComponents: z
			.string()
			.regex(/^(?:[1-9]|[12][0-9]|3[0-2])$/)
			.transform(Number),
	}),
]);
const channelPlanSchema = z.object({
	outputs: z.tuple([
		z.object({
			...outputFields,
			kind: z.literal("MOQ"),
			trackNamespace: moqTrackNamespaceSchema,
		}),
	]),
});
const credentialSecretSchema = z.looseObject({
	playbackUrl: z.unknown().optional(),
});

function json(body: unknown, status = 200) {
	return Response.json(body, {
		status,
		headers: { "Cache-Control": "private, no-store" },
	});
}

async function readSettings(
	ctx: ServerContext,
	input: {
		credentialId: string;
		draftVersion: z.infer<typeof moqDraftVersionSchema>;
		namespaceComponents: number;
	},
): Promise<MoqReadiness> {
	const credential = await ctx.credentials.revealVersioned(input.credentialId);
	if (credential.id !== input.credentialId || credential.provider !== "MOQ")
		return {
			status: "needs-configuration",
			issues: ["credential-unavailable"],
		};

	const parsed = credentialSecretSchema.parse(JSON.parse(credential.secret));
	const { playbackUrl, ...publisher } = parsed;
	const publishing = CREDENTIAL_PROVIDER_SHAPES.MOQ.secret.safeParse(publisher);
	if (!publishing.success)
		return {
			status: "needs-configuration",
			issues: ["credential-unavailable"],
		};
	if (input.namespaceComponents !== 1)
		return { status: "publisher-only", issues: ["namespace-unsupported"] };
	if (playbackUrl === undefined)
		return { status: "publisher-only", issues: ["subscriber-url-missing"] };
	const subscriberUrl = moqPlaybackUrlSchema.safeParse(playbackUrl);
	if (!subscriberUrl.success)
		return {
			status: "needs-configuration",
			issues: ["subscriber-url-invalid"],
		};

	const relay = inspectMoqRelayMetadata(
		subscriberUrl.data,
		publishing.data.authToken,
	);
	if (relay.kind === "invalid")
		return {
			status: "needs-configuration",
			issues: ["subscribe-only-required"],
		};
	if (relay.kind === "cloudflare") {
		const draft = relay.relay.endpointOrigin.includes("draft-16")
			? "DRAFT_16"
			: "DRAFT_18";
		if (draft !== input.draftVersion)
			return {
				status: "needs-configuration",
				issues: ["subscriber-draft-mismatch"],
			};
		if (Date.parse(relay.relay.tokenExpiresAt) <= Date.now())
			return { status: "needs-configuration", issues: ["subscriber-expired"] };
	}

	const [player, verifiedBundle] = await Promise.all([
		readPlayerSettings(ctx.prisma),
		readMoqPlayerBundle().then(
			() => true,
			() => false,
		),
	]);
	const issues: MoqReadiness["issues"] = [];
	if (!player.playerLicenseKey) issues.push("player-license-unavailable");
	if (!verifiedBundle) issues.push("player-bundle-unavailable");
	return { status: issues.length ? "needs-configuration" : "ready", issues };
}

/** Advisory configuration check. Reads local settings and never contacts a relay or encoder. */
export async function GET(req: Request) {
	const params = new URL(req.url).searchParams;
	const values = Object.fromEntries(params);
	const parsed = requestSchema.safeParse(values);
	if (!parsed.success || params.size !== Object.keys(values).length)
		return json({ error: "Invalid MoQ preview readiness request" }, 400);

	try {
		const ctx = await getServerContext();
		if (
			!ctx.tenant ||
			ctx.tenant.isImpersonating ||
			!roleAtLeast(ctx.tenant.role, "OPERATOR")
		)
			return json({ error: "MoQ preview readiness is unavailable" }, 403);

		const input = parsed.data;
		if (!("channelId" in input)) return json(await readSettings(ctx, input));

		const channel = await ctx.prisma.liveChannel.findUnique({
			where: { id: input.channelId, organizationId: ctx.tenant.organizationId },
			select: { plan: true },
		});
		const saved = channelPlanSchema.safeParse(channel?.plan);
		if (!saved.success) return json({ error: "MoQ channel not found" }, 404);
		const output = saved.data.outputs[0];
		return json(
			await readSettings(ctx, {
				credentialId: output.credentialId,
				draftVersion: output.draftVersion,
				namespaceComponents: output.trackNamespace.length,
			}),
		);
	} catch (error) {
		if (error instanceof AuthContextError) {
			const safe = publicContextError(error);
			return json(
				{ error: safe.error, details: { code: safe.code } },
				error.status,
			);
		}
		if ((error as { code?: unknown } | null)?.code === "P2025")
			return json({
				status: "needs-configuration",
				issues: ["credential-unavailable"],
			} satisfies MoqReadiness);
		return json({ error: "MoQ preview readiness is unavailable" }, 503);
	}
}
