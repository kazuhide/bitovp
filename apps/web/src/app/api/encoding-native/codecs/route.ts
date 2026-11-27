import { NextResponse } from "next/server";
import { z } from "zod";
import {
	type CheckNativeCodec,
	createNativeCodecSchema,
	deleteNativeCodecSchema,
	nativeCodecUuid,
	patchNativeCodecSchema,
} from "@/lib/native-codec-configurations";
import { writeAuditLog } from "@/lib/server/audit";
import { getServerContext, type ServerContext } from "@/lib/server/context";
import {
	changedCreationSession,
	createRequestIdentity,
} from "@/lib/server/create-request";
import {
	jsonError,
	readJson,
	routeError,
	validationError,
} from "@/lib/server/http";
import {
	CodecJournalError,
	claimCodecCreate,
	claimCodecDelete,
	codecReceipt,
	finishCodecCreate,
	finishCodecDelete,
	listCodecReceipts,
	normalizeCodecTenantOrgId,
	readCodecReceipt,
	reserveCodecCreate,
} from "@/lib/server/native-codec-journal";
import {
	createProviderCodec,
	findProviderCodec,
	providerCodecIsMissing,
	providerCodecRefused,
	removeProviderCodec,
	verifyProviderCodec,
} from "@/lib/server/native-codec-provider";

const PATH = "/api/encoding-native/codecs";
const PAGE_SIZE = 25;
const query = z.strictObject({
	bitmovinAccountId: nativeCodecUuid,
	offset: z
		.string()
		.regex(/^\d+$/)
		.transform(Number)
		.pipe(z.int().min(0).max(100_000))
		.optional(),
});

function respond(body: unknown, status = 200) {
	return NextResponse.json(body, {
		status,
		headers: { "Cache-Control": "private, no-store" },
	});
}

function handleError(error: unknown) {
	if (error instanceof CodecJournalError)
		return jsonError(error.status, error.publicMessage);
	return routeError(error);
}

function admin(ctx: ServerContext) {
	return ctx.tenant?.role === "ADMIN" && !ctx.tenant.isImpersonating;
}

async function verifiedBinding(
	ctx: ServerContext,
	target: { bitmovinAccountId: string; scopeVersion: string },
) {
	const binding = await ctx.bitmovinAccounts.revealForEncoding(
		target.bitmovinAccountId,
	);
	if (!binding) throw new CodecJournalError("accountMissing");
	if (binding.resourceScopeVersion !== target.scopeVersion)
		throw new CodecJournalError("accountChanged");
	return {
		...binding,
		tenantOrgId: normalizeCodecTenantOrgId(binding.tenantOrgId),
	};
}

async function sendResult(
	ctx: ServerContext,
	req: Request,
	record: Awaited<ReturnType<typeof readCodecReceipt>>,
	status: number,
) {
	await writeAuditLog(
		ctx,
		{
			actor: ctx.tenant?.actor,
			method: req.method,
			path: PATH,
			bitmovinAccountId: record.bitmovinAccountId,
			request: { receiptId: record.id, codec: record.codec },
			response: { state: record.state },
			statusCode: status,
		},
		req,
	);
	return respond(codecReceipt(record), status);
}

async function dispatchCodecCreate(
	ctx: ServerContext,
	req: Request,
	target: CheckNativeCodec,
	binding: Awaited<ReturnType<typeof verifiedBinding>>,
) {
	req.signal.throwIfAborted();
	const claim = await claimCodecCreate(ctx.prisma, target);
	const { record } = claim;
	if (!claim.send) {
		const status = record.state === "CREATING" ? 202 : 200;
		return respond(codecReceipt(record), status);
	}

	// Settle a claimed dispatch even if the browser disconnects.
	let providerId: string;
	try {
		providerId = await createProviderCodec(
			binding,
			AbortSignal.timeout(15_000),
			record,
			claim.body,
		);
	} catch (error) {
		if (!providerCodecRefused(error)) return sendResult(ctx, req, record, 202);
		const settled = await finishCodecCreate(ctx.prisma, record, null);
		return sendResult(ctx, req, settled, 200);
	}
	const settled = await finishCodecCreate(ctx.prisma, record, providerId);
	return sendResult(ctx, req, settled, 201);
}

export async function GET(req: Request) {
	try {
		const ctx = await getServerContext(req.headers);
		if (!admin(ctx)) return jsonError(403, "Administrator access required.");
		const params = new URL(req.url).searchParams;
		const values = Object.fromEntries(params);
		if (params.size !== Object.keys(values).length)
			return jsonError(400, "Duplicate query parameter.");
		const parsed = query.safeParse(values);
		if (!parsed.success) return validationError(parsed.error);
		const { bitmovinAccountId, offset = 0 } = parsed.data;
		const account = await ctx.bitmovinAccounts.get(bitmovinAccountId);
		if (!account) return jsonError(404, "Bitmovin account not found.");
		return respond(
			await listCodecReceipts(
				ctx.prisma,
				{ bitmovinAccountId, scopeVersion: account.resourceScopeVersion },
				offset,
				PAGE_SIZE,
			),
		);
	} catch (error) {
		return handleError(error);
	}
}

export async function POST(req: Request) {
	try {
		const ctx = await getServerContext(req.headers);
		if (!admin(ctx)) return jsonError(403, "Administrator access required.");
		const sessionFailure = changedCreationSession(req, ctx.tenant);
		if (sessionFailure) return sessionFailure;
		const parsed = createNativeCodecSchema.safeParse(await readJson(req));
		if (!parsed.success) return validationError(parsed.error);
		const key = nativeCodecUuid.safeParse(req.headers.get("Idempotency-Key"));
		if (!key.success)
			return jsonError(400, "A UUID Idempotency-Key is required.");
		const identity = createRequestIdentity(req, parsed.data);
		if (!identity) return jsonError(400, "A UUID Idempotency-Key is required.");
		const body = parsed.data;
		req.signal.throwIfAborted();
		const binding = await verifiedBinding(ctx, body);
		await reserveCodecCreate(
			ctx.prisma,
			body,
			key.data,
			identity.requestSha256,
		);
		return await dispatchCodecCreate(
			ctx,
			req,
			{ id: key.data, ...body },
			binding,
		);
	} catch (error) {
		return handleError(error);
	}
}

export async function PATCH(req: Request) {
	try {
		const ctx = await getServerContext(req.headers);
		if (!admin(ctx)) return jsonError(403, "Administrator access required.");
		const sessionFailure = changedCreationSession(req, ctx.tenant);
		if (sessionFailure) return sessionFailure;
		const parsed = patchNativeCodecSchema.safeParse(await readJson(req));
		if (!parsed.success) return validationError(parsed.error);
		const target = parsed.data;
		const binding = await verifiedBinding(ctx, target);
		const record = await readCodecReceipt(ctx.prisma, target);
		const signal = AbortSignal.any([req.signal, AbortSignal.timeout(15_000)]);
		if (record.state === "CREATING") {
			if (record.pendingCreateRequest !== null) {
				if (target.resume)
					return await dispatchCodecCreate(ctx, req, target, binding);
				return respond(codecReceipt(record), 202);
			}
			let providerId: string | null;
			try {
				providerId = await findProviderCodec(binding, signal, record);
			} catch {
				return sendResult(ctx, req, record, 202);
			}
			if (providerId) {
				const settled = await finishCodecCreate(ctx.prisma, record, providerId);
				return sendResult(ctx, req, settled, 200);
			}
			return sendResult(ctx, req, record, 202);
		}
		if (record.state === "DELETING" && record.providerId) {
			let present: boolean;
			try {
				present = await verifyProviderCodec(
					binding,
					signal,
					record,
					record.providerId,
				);
			} catch {
				return sendResult(ctx, req, record, 202);
			}
			if (!present) {
				const settled = await finishCodecDelete(ctx.prisma, record, "REMOVED");
				return sendResult(ctx, req, settled, 200);
			}
			return sendResult(ctx, req, record, 202);
		}
		return respond(codecReceipt(record));
	} catch (error) {
		return handleError(error);
	}
}

export async function DELETE(req: Request) {
	try {
		const ctx = await getServerContext(req.headers);
		if (!admin(ctx)) return jsonError(403, "Administrator access required.");
		const sessionFailure = changedCreationSession(req, ctx.tenant);
		if (sessionFailure) return sessionFailure;
		const parsed = deleteNativeCodecSchema.safeParse(await readJson(req));
		if (!parsed.success) return validationError(parsed.error);
		const target = parsed.data;
		req.signal.throwIfAborted();
		const binding = await verifiedBinding(ctx, target);
		const operation = await claimCodecDelete(ctx.prisma, target);
		const record = operation.record;
		if (!operation.send)
			return respond(
				codecReceipt(record),
				record.state === "DELETING" ? 202 : 200,
			);
		const signal = AbortSignal.timeout(15_000);
		const providerId = target.confirmProviderId;
		let restored = false;
		let destructiveSend = false;
		try {
			if (await verifyProviderCodec(binding, signal, record, providerId)) {
				destructiveSend = true;
				await removeProviderCodec(binding, signal, record, providerId);
			}
		} catch (error) {
			if (!destructiveSend || !providerCodecIsMissing(error)) {
				if (
					operation.retry ||
					(destructiveSend && !providerCodecRefused(error))
				)
					return sendResult(ctx, req, record, 202);
				restored = true;
			}
		}
		const settled = await finishCodecDelete(
			ctx.prisma,
			record,
			restored ? "ACTIVE" : "REMOVED",
		);
		return sendResult(ctx, req, settled, restored ? 409 : 200);
	} catch (error) {
		return handleError(error);
	}
}
