import "server-only";
import { createHash } from "node:crypto";
import { CREDENTIAL_PROVIDER_SHAPES } from "@bitovp/core";
import { NextResponse } from "next/server";
import { z } from "zod";
import { publicContextError } from "@/lib/auth/public-context-error";
import { roleAtLeast } from "@/lib/auth/roles";
import { AuthContextError } from "@/lib/auth/tenancy";
import { writeAuditLog } from "./audit";
import { getServerContext, type ServerContext } from "./context";
import {
	moqPlaybackRunSelect,
	moqStoredOutputSchema,
	readMoqPlaybackBinding,
} from "./moq-playback-run";
import { inspectMoqRelayMetadata } from "./moq-relay-metadata";
import { readPlayerSettings } from "./player-config";

const createAuditSchema = z.object({
	organizationId: z.uuid(),
	bitmovinAccountId: z.uuid(),
	at: z.date(),
	request: z.unknown(),
	response: z.object({ id: z.uuid() }),
});

/** Capabilities come from a versioned credential snapshot, bound to the original
 * output CREATE and stored run graph. Current channel plans are never a source. */
export async function getMoqPlaybackDescriptor(
	req: Request,
	{ id, runId }: { id: string; runId: string },
) {
	let ctx: ServerContext | undefined;
	let encodingId: string | undefined;
	let accountId: string | undefined;
	const finish = async (
		status: number,
		code: string,
		body?: Record<string, unknown>,
	) => {
		const response = NextResponse.json(
			body ?? { error: "MoQ playback is unavailable", details: { code } },
			{ status, headers: { "Cache-Control": "private, no-store" } },
		);
		if (ctx) {
			try {
				await writeAuditLog(
					ctx,
					{
						method: req.method === "HEAD" ? "HEAD" : "GET",
						path: `/api/live-channels/${id}/runs/${runId}/moq-playback`,
						bitmovinAccountId: accountId,
						statusCode: status,
						request: { liveChannelId: id, runId },
						response: {
							runId,
							...(encodingId ? { encodingId } : {}),
							available: status === 200,
							code,
						},
					},
					req,
				);
			} catch {
				return NextResponse.json(
					{
						error: "MoQ playback is unavailable",
						details: { code: "MOQ_PLAYBACK_UNAVAILABLE" },
					},
					{
						status: 503,
						headers: { "Cache-Control": "private, no-store" },
					},
				);
			}
		}
		return response;
	};
	if (
		!z.uuid().safeParse(id).success ||
		!z.uuid().safeParse(runId).success ||
		new URL(req.url).searchParams.size > 0
	)
		return finish(400, "MOQ_PLAYBACK_INVALID_REQUEST");
	try {
		ctx = await getServerContext();
		if (
			!ctx.tenant ||
			ctx.tenant.isImpersonating ||
			!roleAtLeast(ctx.tenant.role, "OPERATOR")
		)
			return finish(403, "MOQ_PLAYBACK_FORBIDDEN");
		const run = await ctx.prisma.liveChannelRun.findFirst({
			where: { liveChannelId: id },
			orderBy: { seq: "desc" },
			select: moqPlaybackRunSelect,
		});
		const binding = readMoqPlaybackBinding(run, {
			channelId: id,
			runId,
			organizationId: ctx.tenant.organizationId,
		});
		encodingId = "encodingId" in binding ? binding.encodingId : undefined;
		if (!binding.ok) return finish(binding.status, binding.code);
		const { outputId, output, startedAt } = binding;
		const select = {
			organizationId: true,
			bitmovinAccountId: true,
			at: true,
			request: true,
			response: true,
		} as const;
		const successful = { method: "POST", statusCode: { gte: 200, lt: 300 } };
		const [encodingRows, outputRows] = await Promise.all([
			ctx.prisma.auditLog.findMany({
				where: {
					...successful,
					path: "/encoding/encodings",
					response: { path: ["id"], equals: encodingId },
				},
				select,
				take: 2,
			}),
			ctx.prisma.auditLog.findMany({
				where: {
					...successful,
					path: "/encoding/outputs/moq",
					response: { path: ["id"], equals: outputId },
				},
				select,
				take: 2,
			}),
		]);
		const encodingProof = z.tuple([createAuditSchema]).safeParse(encodingRows);
		const outputProof = z.tuple([createAuditSchema]).safeParse(outputRows);
		if (!encodingProof.success || !outputProof.success)
			return finish(409, "MOQ_PLAYBACK_PROVENANCE_UNAVAILABLE");
		const createdEncoding = encodingProof.data[0];
		const createdOutput = outputProof.data[0];
		const requestProof = moqStoredOutputSchema
			.omit({ credentialId: true })
			.safeParse(createdOutput.request);
		if (
			createdEncoding.organizationId !== ctx.tenant.organizationId ||
			createdOutput.organizationId !== ctx.tenant.organizationId ||
			createdEncoding.response.id !== encodingId ||
			createdOutput.response.id !== outputId ||
			createdEncoding.bitmovinAccountId !== createdOutput.bitmovinAccountId ||
			!requestProof.success ||
			requestProof.data.draftVersion !== output.draftVersion ||
			requestProof.data.trackNamespace[0] !== output.trackNamespace[0]
		)
			return finish(409, "MOQ_PLAYBACK_PROVENANCE_UNAVAILABLE");
		accountId = createdEncoding.bitmovinAccountId;
		const credential = await ctx.credentials.revealVersioned(
			output.credentialId,
		);
		const updatedAt = credential.updatedAt.getTime();
		if (
			credential.id !== output.credentialId ||
			credential.provider !== "MOQ" ||
			!Number.isFinite(updatedAt) ||
			updatedAt >= Math.min(startedAt, createdOutput.at.getTime())
		)
			return finish(409, "MOQ_PLAYBACK_CREDENTIAL_CHANGED");
		const secret = CREDENTIAL_PROVIDER_SHAPES.MOQ.secret.safeParse(
			JSON.parse(credential.secret),
		);
		if (!secret.success || !secret.data.playbackUrl)
			return finish(503, "MOQ_PLAYBACK_NOT_CONFIGURED");
		const relayMetadata = inspectMoqRelayMetadata(
			secret.data.playbackUrl,
			secret.data.authToken,
		);
		if (relayMetadata.kind === "invalid")
			return finish(409, "MOQ_PLAYBACK_SUBSCRIBE_TOKEN_REQUIRED");
		const settings = await readPlayerSettings(ctx.prisma);
		const analyticsLicenseKey = settings.analyticsLicenseKey;
		if (!settings.playerLicenseKey)
			return finish(503, "MOQ_PLAYBACK_PLAYER_NOT_CONFIGURED");
		return finish(200, "MOQ_PLAYBACK_AVAILABLE", {
			runId,
			encodingId,
			resource: {
				type: "moq",
				url: secret.data.playbackUrl,
				metadata: {
					namespace: output.trackNamespace[0],
					catalogTrackName: "catalog",
					draftVersion: output.draftVersion === "DRAFT_18" ? 18 : 16,
					mediaTypes: ["audio", "video"],
				},
			},
			playerLicenseKey: settings.playerLicenseKey,
			...(analyticsLicenseKey
				? {
						analytics: {
							licenseKey: analyticsLicenseKey,
							licenseKeySha256: createHash("sha256")
								.update(analyticsLicenseKey)
								.digest("hex"),
							videoId: `bitovp-moq:${encodingId}:${runId}`,
							collectorVersion: "2.62.0",
							latencyField: "customData1",
						},
					}
				: {}),
			...(relayMetadata.kind === "cloudflare"
				? { relay: relayMetadata.relay }
				: {}),
		});
	} catch (error) {
		if (error instanceof AuthContextError) {
			const safe = publicContextError(error);
			return finish(error.status, safe.code, {
				error: safe.error,
				details: { code: safe.code },
			});
		}
		if ((error as { code?: unknown } | null)?.code === "P2025")
			return finish(404, "MOQ_PLAYBACK_CREDENTIAL_MISSING");
		// Never log or persist raw crypto, database or credential-bearing errors.
		return finish(503, "MOQ_PLAYBACK_UNAVAILABLE");
	}
}
