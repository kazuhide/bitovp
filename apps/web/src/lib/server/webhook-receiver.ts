import "server-only";
import {
	BITMOVIN_SIGNATURE_HEADER,
	deriveScopedToken,
	deriveWebhookKey,
	hashWebhookToken,
	isWebhookScope,
	isWebhookToken,
	loadEnv,
	redactSecrets,
	verifyWebhookSignature,
	type WebhookScope,
	webhookTokenEquals,
} from "@bitovp/core";
import type { Prisma } from "@bitovp/db";
import {
	DEFAULT_ORGANIZATION_ID,
	resolveWebhookMasterSecret,
	resolveWebhookOrganization,
	tenantOrganizationId,
} from "@bitovp/db";
import { NextResponse } from "next/server";
import { contextForOrganization, type ServerContext } from "./context";
import { jsonError, routeError } from "./http";
import { bindHeartbeatRun } from "./live-heartbeat-reception";
import { clientKey, createFixedWindowLimiter } from "./rate-limit";

/**
 * The signed webhook receiver (WP-G G-1) behind
 * `/api/webhooks/bitmovin/[scope]/[token]`.
 *
 * Order of defenses, cheapest first and NOTHING persisted before the last:
 *   1. scope + token SHAPE — a malformed URL is a 404 before any work, metered
 *      by the general bucket like any probe;
 *   2. rate limit (one install-wide bucket without a trusted proxy — a cap,
 *      not a per-client budget; the legacy route's precedent). The larger `hb`
 *      bucket is granted ONLY to the master's derived hb token, compared here
 *      (rev414 R3) — a well-formed unknown token never buys the 10× budget;
 *   3. body-size cap (413) on the DECLARED length before anything is read;
 *   4. token RESOLUTION before the body is read — an unknown token is a 404
 *      (no persistence) that never costs a body read; then the cap again on
 *      the bytes actually read;
 *   5. signature over the RAW body with the key DERIVED from the token —
 *      a mismatch is a 401 (no persistence);
 *   6. JSON shape (400);
 *   7. persist, verified. There is no unverified branch on this route: every
 *      registration made through this app carries a signature, so an unsigned
 *      delivery here is by definition not one of ours.
 *
 * `hb` lands redacted in `WebhookEvent`, stamped processed — the inbound
 * dispatcher must not turn a 1 s heartbeat into a 1 s poll wake. Recognized
 * envelopes bind through the registered hook's account and exact encoding
 * to a run, feeding the separate Push reception view, never the poll mirror.
 * `j` (per-encoding, G-2) resolves through
 * `resolveJobToken` — a `WebhookRegistration` row by token hash — and a
 * verified delivery stamps the row's `lastDeliveryAt` and the event's
 * job/run ids, so the settings list and the payload viewer both know which
 * encoding it belonged to without trusting the body.
 */

/** Bitmovin notifications are tiny; anything near this cap is hostile. */
export const MAX_WEBHOOK_BODY_BYTES = 1_000_000;

/**
 * Same budget as the legacy receiver (120/min, install-wide without a
 * trusted proxy). Module state: the limiter test lives in its own file so
 * its 121 requests never perturb the matrix test's bucket.
 */
const limiter = createFixedWindowLimiter({ limit: 120, windowMs: 60_000 });

/**
 * WP-G G-3: the heartbeat scope gets its OWN, larger bucket. Bitmovin pushes
 * one heartbeat per live encoding per `interval` seconds (C37: min 1), so at
 * the 1 s experiment two encodings alone would exhaust the 120/min bucket
 * and starve every FINISHED/ERROR delivery. 1,200/min = twenty encodings at
 * 1 s. The cap's job is to bound `req.text` + HMAC work, and this keeps it
 * doing that without metering the provider's own cadence.
 */
const heartbeatLimiter = createFixedWindowLimiter({
	limit: 1_200,
	windowMs: 60_000,
});
const heartbeatLookupLimiter = createFixedWindowLimiter({
	limit: 120,
	windowMs: 60_000,
});
const knownHeartbeatTokens = new Map<string, number>();

async function registeredHeartbeatToken(ctx: ServerContext, token: string) {
	return ctx.prisma.webhookRegistration.findFirst({
		where: {
			tokenHash: hashWebhookToken(token),
			scope: "hb",
			kind: "liveEncodingHeartbeat",
		},
		select: { id: true },
	});
}

/**
 * rev414 R3: the hb bucket is granted only to the master's DERIVED hb token,
 * compared before any bucket is chosen — so a well-formed but unknown token
 * is metered like any probe and never buys the 10× budget. The derived token
 * is cached per process for 30 s so the compare costs no master-secret read
 * under a flood; a rotation is honoured within that window (the resolution
 * step below always uses the current master).
 */
const HB_TOKEN_CACHE_MS = 30_000;
const hbTokenCache = new Map<string, { token: string; expiresAt: number }>();
async function derivedHbToken(
	ctx: ServerContext,
	nowMs: number,
): Promise<string> {
	const org = tenantOrganizationId(ctx.prisma) ?? DEFAULT_ORGANIZATION_ID;
	const cached = hbTokenCache.get(org);
	if (cached && cached.expiresAt > nowMs) {
		return cached.token;
	}
	const master = await resolveWebhookMasterSecret({
		prisma: ctx.prisma,
		cipher: ctx.cipher,
		envSecret: loadEnv().BITMOVIN_WEBHOOK_SECRET,
	});
	const token = deriveScopedToken(master.secret, "hb");
	if (hbTokenCache.size >= 128) hbTokenCache.clear();
	hbTokenCache.set(org, { token, expiresAt: nowMs + HB_TOKEN_CACHE_MS });
	return token;
}

export type TokenBinding =
	| { scope: "acct" }
	| { scope: "hb"; legacy: boolean }
	| {
			scope: "j";
			encodingJobId: string | null;
			liveChannelRunId: string | null;
			/** The registration's lookup key, for the delivery stamp. */
			tokenHash: string;
	  };

/**
 * WP-G G-2: a `j` token is known when the registrar wrote a row for it —
 * looked up by hash, never by the token. Any status counts EXCEPT a row
 * that never carried a token (SKIPPED): a late delivery for a FINISHED job
 * whose hooks were already retired is still a genuine delivery for that
 * job, and the key it must be signed with is derived from the master
 * either way, so a retired token widens nothing.
 */
export async function resolveJobToken(
	ctx: ServerContext,
	token: string,
): Promise<Extract<TokenBinding, { scope: "j" }> | null> {
	const tokenHash = hashWebhookToken(token);
	const row = await ctx.prisma.webhookRegistration.findFirst({
		where: { tokenHash, scope: "j" },
		select: { encodingJobId: true, liveChannelRunId: true },
	});
	if (!row) {
		return null;
	}
	return {
		scope: "j",
		encodingJobId: row.encodingJobId,
		liveChannelRunId: row.liveChannelRunId,
		tokenHash,
	};
}

/**
 * Who does this token belong to? Returns the binding plus the key to verify
 * with, or null for a token nobody registered. Reads the master secret
 * (env, else the encrypted AppSetting row — generated on first use).
 */
export async function resolveWebhookToken(
	ctx: ServerContext,
	scope: WebhookScope,
	token: string,
): Promise<{ binding: TokenBinding; signatureKey: string } | null> {
	const master = await resolveWebhookMasterSecret({
		prisma: ctx.prisma,
		cipher: ctx.cipher,
		envSecret: loadEnv().BITMOVIN_WEBHOOK_SECRET,
	});
	const signatureKey = deriveWebhookKey(master.secret, token);
	if (scope === "hb") {
		const legacy = webhookTokenEquals(
			token,
			deriveScopedToken(master.secret, scope),
		);
		if (!legacy && !(await registeredHeartbeatToken(ctx, token))) return null;
		return { binding: { scope, legacy }, signatureKey };
	}
	if (scope === "acct") {
		// One derived token per scope: anything else is unknown, in constant
		// time so a probe learns nothing about how close its guess was.
		if (!webhookTokenEquals(token, deriveScopedToken(master.secret, scope))) {
			return null;
		}
		return { binding: { scope }, signatureKey };
	}
	const job = await resolveJobToken(ctx, token);
	return job ? { binding: job, signatureKey } : null;
}

type ReceiveDeps = {
	ctx?: () => ServerContext | Promise<ServerContext>;
	now?: () => Date;
};

export async function receiveSignedWebhook(
	req: Request,
	params: { scope: string; token: string },
	deps: ReceiveDeps = {},
): Promise<NextResponse> {
	// 404 for BOTH a bad scope and a bad token shape: the URL names nothing —
	// metered by the general bucket like any probe.
	if (!isWebhookScope(params.scope) || !isWebhookToken(params.token)) {
		if (!limiter.check(clientKey(req))) {
			return jsonError(429, "Too many requests");
		}
		return jsonError(404, "Not found");
	}
	const scope: WebhookScope = params.scope;

	let ctx: ServerContext;
	try {
		if (deps.ctx) ctx = await deps.ctx();
		else {
			const organizationId = await resolveWebhookOrganization(
				hashWebhookToken(params.token),
			);
			// Only historical account/heartbeat derived tokens may resolve against
			// Main without a registration. New per-encoding tokens always own a row.
			if (!organizationId && scope === "j") return jsonError(404, "Not found");
			ctx = contextForOrganization(organizationId ?? DEFAULT_ORGANIZATION_ID);
		}
	} catch (err) {
		return routeError(err);
	}
	// The hb budget is for the provider's own cadence on the DERIVED token
	// (rev414 R3); anything else on the hb path is a probe and pays the
	// general bucket. An unresolvable master falls to the general bucket
	// here and reports its fault at resolution below.
	let bucket = limiter;
	if (scope === "hb") {
		try {
			const expected = await derivedHbToken(ctx, Date.now());
			if (webhookTokenEquals(params.token, expected)) {
				bucket = heartbeatLimiter;
			} else {
				const hash = hashWebhookToken(params.token);
				const cachedUntil = knownHeartbeatTokens.get(hash) ?? 0;
				if (cachedUntil > Date.now()) bucket = heartbeatLimiter;
				else if (
					heartbeatLookupLimiter.check(clientKey(req)) &&
					(await registeredHeartbeatToken(ctx, params.token))
				) {
					// Cache only positive admissions, bounded independently of attacker tokens.
					if (knownHeartbeatTokens.size >= 128) knownHeartbeatTokens.clear();
					knownHeartbeatTokens.set(hash, Date.now() + HB_TOKEN_CACHE_MS);
					bucket = heartbeatLimiter;
				}
			}
		} catch {
			bucket = limiter;
		}
	}
	if (!bucket.check(clientKey(req))) {
		return jsonError(429, "Too many requests");
	}

	// The DECLARED size, before anything is read.
	const contentLength = Number(req.headers.get("content-length") ?? "0");
	if (contentLength > MAX_WEBHOOK_BODY_BYTES) {
		return jsonError(413, "Payload too large");
	}

	// Resolve BEFORE reading the body: an unknown token never costs a read.
	let resolved: Awaited<ReturnType<typeof resolveWebhookToken>>;
	try {
		resolved = await resolveWebhookToken(ctx, scope, params.token);
	} catch (err) {
		// MASTER_KEY missing / DB down: fail CLOSED (503 via routeError), and
		// persist nothing — an unverifiable delivery is not a delivery.
		return routeError(err);
	}
	if (resolved === null) {
		return jsonError(404, "Not found");
	}
	const rawBody = await req.text();
	if (rawBody.length > MAX_WEBHOOK_BODY_BYTES) {
		return jsonError(413, "Payload too large");
	}
	if (
		!verifyWebhookSignature(
			rawBody,
			req.headers.get(BITMOVIN_SIGNATURE_HEADER),
			resolved.signatureKey,
		)
	) {
		// Deliberately no persistence: the signature is the only thing
		// distinguishing Bitmovin from anyone else who found the URL.
		return jsonError(401, "Invalid webhook signature");
	}

	let payload: unknown;
	try {
		payload = JSON.parse(rawBody);
	} catch {
		return jsonError(400, "Body must be JSON");
	}
	if (
		payload === null ||
		typeof payload !== "object" ||
		Array.isArray(payload)
	) {
		return jsonError(400, "Body must be a JSON object");
	}
	const body = payload as Record<string, unknown>;
	const eventType =
		scope === "hb"
			? "LIVE_ENCODING_HEARTBEAT"
			: typeof body.type === "string"
				? body.type
				: typeof body.eventType === "string"
					? body.eventType
					: undefined;
	const providedEventId =
		typeof body.notificationId === "string"
			? body.notificationId
			: typeof body.eventId === "string"
				? body.eventId
				: typeof body.id === "string"
					? body.id
					: undefined;

	const receivedAt = (deps.now ?? (() => new Date()))();
	const binding = resolved.binding;
	let heartbeatBinding: Awaited<ReturnType<typeof bindHeartbeatRun>> = null;
	try {
		if (scope === "hb") {
			heartbeatBinding = await bindHeartbeatRun(
				ctx.prisma,
				body,
				hashWebhookToken(params.token),
				binding.scope === "hb" && binding.legacy,
			);
		}
		await ctx.prisma.webhookEvent.create({
			data: {
				source: "bitmovin",
				eventType,
				// Every row here is verified, so every row may own a dedup slot —
				// except `hb`: until a real delivery pins the envelope (X0), a
				// heartbeat id that turned out STABLE per encoding would make every
				// push after the first a "duplicate" and silently store nothing.
				// Heartbeats are already stamped processed and never dispatched,
				// so a redelivered heartbeat costs one extra row, not a double
				// dispatch.
				externalEventId: scope === "hb" ? undefined : providedEventId,
				raw: (scope === "hb"
					? redactSecrets(body)
					: body) as Prisma.InputJsonValue,
				signatureValid: true,
				...(scope === "hb"
					? { receiverTokenHash: hashWebhookToken(params.token) }
					: {}),
				receivedAt,
				// Heartbeats feed a separate read-only reception view; a
				// 1 s cadence must not become a 1 s poll wake through the
				// inbound dispatcher, which claims only processedAt: null rows.
				...(scope === "hb" ? { processedAt: receivedAt } : {}),
				...(heartbeatBinding
					? { liveChannelRunId: heartbeatBinding.runId }
					: {}),
				// WP-G G-2: the job/run the token was REGISTERED for — from the
				// registration row, never from the body.
				...(binding.scope === "j"
					? {
							encodingJobId: binding.encodingJobId,
							liveChannelRunId: binding.liveChannelRunId,
						}
					: {}),
			},
		});
	} catch (err) {
		if ((err as { code?: string }).code === "P2002") {
			return NextResponse.json({ accepted: true, duplicate: true, scope });
		}
		return routeError(err);
	}
	if (binding.scope === "j") {
		// Best-effort bookkeeping for the settings list; the delivery is
		// already persisted and must not be failed by this.
		try {
			await ctx.prisma.webhookRegistration.updateMany({
				where: { tokenHash: binding.tokenHash },
				data: { lastDeliveryAt: receivedAt },
			});
		} catch (err) {
			console.error(
				"[webhook-receiver] lastDeliveryAt update failed (delivery kept):",
				err instanceof Error ? err.message : err,
			);
		}
	}
	if (heartbeatBinding?.registrationId) {
		try {
			await ctx.prisma.webhookRegistration.updateMany({
				// Do not stamp a newly replaced hook with an old hook's delivery.
				where: {
					id: heartbeatBinding.registrationId,
					providerWebhookId: String(body.webhookId),
				},
				data: { lastDeliveryAt: receivedAt },
			});
		} catch {
			console.error(
				"[webhook-receiver] heartbeat delivery stamp failed (verified event kept)",
			);
		}
	}
	return NextResponse.json({ accepted: true, verified: true, scope });
}
