import { NextResponse } from "next/server";
import { z } from "zod";
import {
	auditedBitmovinCall,
	bitmovinClientForAccount,
	bitmovinProxyError,
} from "@/lib/server/bitmovin";
import { getServerContext } from "@/lib/server/context";
import { jsonError, routeError } from "@/lib/server/http";
import { accountReceiver, readCurrentIngress } from "@/lib/server/ingress";
import {
	listRegistrations,
	REGISTRATION_KINDS,
	type RegistrationKind,
	unregister,
} from "@/lib/server/webhook-registration";

/**
 * ACCOUNT-LEVEL Bitmovin webhook registrations . Lives at
 * /api/webhook-registration, NOT under /api/webhooks/ — that subtree is the
 * auth gate's PUBLIC exemption (the receiver must be reachable by Bitmovin),
 * and gate-coverage rightly refused a management surface inside it.
 *
 * WP-G G-2: read-and-remove only. The per-ENCODING registrations the worker
 * makes live in `/api/webhook-registrations`; what remains here is the list
 * of hooks the account holds at account level — ours from earlier versions
 * (flagged legacy / signed), or someone else's — and the delete. The POST
 * that registered the account-level "standard set" is gone with it.
 *
 * The endpoint facts come from the PERSISTED public ingress (the worker's
 * monitor row), never from PUBLIC_BASE_URL read here; the response carries
 * endpoints and the ingress state, NEVER a key.
 *
 * Failures route through bitmovinProxyError (review-187 I1: the first cut's
 * hand-rolled 502 turned OUR TypeErrors into "Bitmovin API unreachable" —
 * a false upstream-outage report with no server-side log). Mutations ride
 * auditedBitmovinCall (review-187 I4: who removed a webhook is C7 audit
 * material like every other mutating Bitmovin call).
 */

function accountIdOf(req: Request): string | null {
	const id = new URL(req.url).searchParams.get("bitmovinAccountId");
	return id && z.string().uuid().safeParse(id).success ? id : null;
}

/** The ingress facts the panel shows beside the list — no secrets. */
async function ingressWire(ctx: Awaited<ReturnType<typeof getServerContext>>) {
	const snapshot = await readCurrentIngress(ctx.prisma);
	return snapshot
		? {
				mode: snapshot.mode,
				baseUrl: snapshot.current?.baseUrl ?? null,
				source: snapshot.current?.source ?? null,
				observedAt: snapshot.current?.observedAt ?? null,
				checkedAt: snapshot.checkedAt,
				reason: snapshot.reason ?? null,
			}
		: null;
}

export async function GET(req: Request) {
	const accountId = accountIdOf(req);
	if (!accountId) {
		return jsonError(400, "bitmovinAccountId (uuid) is required");
	}
	let ctx: Awaited<ReturnType<typeof getServerContext>>;
	let receiver: Awaited<ReturnType<typeof accountReceiver>>;
	try {
		ctx = await getServerContext();
		receiver = await accountReceiver(ctx);
	} catch (err) {
		// Master-secret / MASTER_KEY faults are OURS — never "Bitmovin unreachable".
		return routeError(err);
	}
	try {
		const api = await bitmovinClientForAccount(ctx, accountId);
		if (!api) {
			return jsonError(404, "Bitmovin account not found");
		}
		const rows = await listRegistrations(api, {
			current: receiver?.endpoint ?? null,
			legacy: receiver?.legacyEndpoint ?? null,
		});
		return NextResponse.json({
			endpoint: receiver?.endpoint ?? null,
			legacyEndpoint: receiver?.legacyEndpoint ?? null,
			secretSource: receiver?.secretSource ?? null,
			ingress: await ingressWire(ctx),
			rows,
		});
	} catch (err) {
		return bitmovinProxyError(err);
	}
}

const deleteSchema = z.object({
	kind: z.enum(REGISTRATION_KINDS),
	webhookId: z.string().min(1),
});

export async function DELETE(req: Request) {
	const accountId = accountIdOf(req);
	if (!accountId) {
		return jsonError(400, "bitmovinAccountId (uuid) is required");
	}
	try {
		const body = deleteSchema.safeParse(await req.json());
		if (!body.success) {
			return jsonError(400, "Body must be { kind, webhookId }");
		}
		const ctx = await getServerContext();
		const api = await bitmovinClientForAccount(ctx, accountId);
		if (!api) {
			return jsonError(404, "Bitmovin account not found");
		}
		const audited = await auditedBitmovinCall({
			req,
			ctx,
			bitmovinAccountId: accountId,
			method: "DELETE",
			path: `/notifications/webhooks/encoding/encodings/${body.data.kind}/${body.data.webhookId}`,
			call: async () => {
				await unregister(
					api,
					body.data.kind as RegistrationKind,
					body.data.webhookId,
				);
				return { id: body.data.webhookId };
			},
		});
		if (!audited.ok) {
			return audited.response;
		}
		return new NextResponse(null, { status: 204 });
	} catch (err) {
		return bitmovinProxyError(err);
	}
}
