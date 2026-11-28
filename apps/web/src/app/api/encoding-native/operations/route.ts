import { createHmac } from "node:crypto";
import { masterKeyFromEnv } from "@bitovp/core";
import { NextResponse } from "next/server";
import { z } from "zod";
import { canonicalCreateRequestJson } from "@/lib/creation-submission-contract";
import {
	NATIVE_OPERATION_KEY_CONFLICT,
	type NativeOperationOutcome,
	nativeOperationSchema,
	nativeOperationUuid,
} from "@/lib/native-account-operations";
import { writeAuditLog } from "@/lib/server/audit";
import { getServerContext } from "@/lib/server/context";
import { changedCreationSession } from "@/lib/server/create-request";
import { jsonError, readJson, routeError } from "@/lib/server/http";
import {
	claimNativeOperation,
	getNativeOperation,
	listNativeOperations,
	NativeOperationConflict,
	type NativeOperationRow,
	nativeOperationDispatchBudget,
	nativeOperationExpired,
	ownsNativeResource,
	projectNativeOperation,
	sameNativeOperation,
	settleNativeOperation,
} from "@/lib/server/native-account-journal";
import {
	checkNativeProviderTargets,
	dispatchNativeProviderOperation,
	NativeProviderTargetError,
	providerRefusedNativeOperation,
} from "@/lib/server/native-account-provider";

const path = "/api/encoding-native/operations";
const timeLimit = 15_000;
const readQuery = z.strictObject({ bitmovinAccountId: nativeOperationUuid });

function noStore(response: NextResponse) {
	response.headers.set("Cache-Control", "private, no-store");
	return response;
}

function statusFor(state: string) {
	return state === "PENDING" || state === "UNKNOWN" ? 202 : 200;
}

function responseFor(row: NativeOperationRow, uploadUrl?: string) {
	const receipt = projectNativeOperation(row);
	return NextResponse.json(
		{ ...receipt, ...(uploadUrl && { uploadUrl }) },
		{ status: statusFor(receipt.state) },
	);
}

async function readOperations(req: Request) {
	const ctx = await getServerContext(req.headers);
	if (ctx.tenant?.role !== "ADMIN" || ctx.tenant.isImpersonating)
		return jsonError(403, "Administrator access required.");
	const params = new URL(req.url).searchParams;
	const query = readQuery.safeParse(Object.fromEntries(params));
	if (params.size !== 1 || !query.success)
		return jsonError(400, "Select a Bitmovin account.");
	const { bitmovinAccountId } = query.data;
	const account = await ctx.bitmovinAccounts.get(bitmovinAccountId);
	if (!account) return jsonError(404, "Bitmovin account not found.");
	const scopeVersion = account.resourceScopeVersion;
	const rows = await listNativeOperations(ctx.prisma, {
		bitmovinAccountId,
		scopeVersion,
	});
	return NextResponse.json({
		scopeVersion,
		rows: rows.map(projectNativeOperation),
	});
}

export async function GET(req: Request) {
	try {
		return noStore(await readOperations(req));
	} catch (err) {
		return noStore(routeError(err));
	}
}

async function runOperation(req: Request) {
	const ctx = await getServerContext(req.headers);
	if (ctx.tenant?.role !== "ADMIN" || ctx.tenant.isImpersonating)
		return jsonError(403, "Administrator access required.");
	const changed = changedCreationSession(req, ctx.tenant);
	if (changed) return changed;
	const parsed = nativeOperationSchema.safeParse(await readJson(req));
	const id = nativeOperationUuid.safeParse(req.headers.get("Idempotency-Key"));
	if (!parsed.success || !id.success)
		return jsonError(400, "Invalid operation fields or confirmation.");
	const command = parsed.data;
	const { bitmovinAccountId, scopeVersion, action } = command;
	const storedBinding =
		await ctx.bitmovinAccounts.revealForEncoding(bitmovinAccountId);
	if (!storedBinding) return jsonError(404, "Bitmovin account not found.");
	const tenantOrgId = storedBinding.tenantOrgId?.trim() ?? null;
	if (storedBinding.resourceScopeVersion !== scopeVersion || tenantOrgId === "")
		return jsonError(409, "The Bitmovin account scope changed or is invalid.");
	const binding = { apiKey: storedBinding.apiKey, tenantOrgId };

	// Keep the digest stable across credentials for the same provider scope.
	// The application key protects guesses about credentials in the command.
	const fingerprint = createHmac("sha256", masterKeyFromEnv())
		.update("bitovp:native-encoding-operation:v1\0")
		.update(id.data)
		.update(canonicalCreateRequestJson(command))
		.digest("hex");
	const proposal = {
		id: id.data,
		bitmovinAccountId,
		scopeVersion,
		action,
		fingerprint,
		targetId:
			"resourceId" in command
				? command.resourceId
				: command.action === "start-template"
					? command.outputId
					: null,
	};
	const existing = await getNativeOperation(ctx.prisma, proposal.id);
	if (existing) {
		if (!sameNativeOperation(existing, proposal))
			return jsonError(
				409,
				"This request already identifies a different operation.",
				{ code: NATIVE_OPERATION_KEY_CONFLICT },
			);
		return responseFor(existing);
	}

	if ("resourceId" in command && action.startsWith("delete-")) {
		const createAction = `create-${action.slice("delete-".length)}`;
		if (
			!(await ownsNativeResource(
				ctx.prisma,
				command,
				createAction,
				command.resourceId,
			))
		)
			return jsonError(
				404,
				"This resource has no creation receipt in the selected account.",
			);
	}

	const claim = await claimNativeOperation(ctx.prisma, proposal);
	if (!claim.send || nativeOperationExpired(claim.row))
		return responseFor(claim.row);

	// Hold the target reservation while reading authoritative provider state.
	// Same-key retries return their receipt without reaching this read.
	const preflight = AbortSignal.any([
		req.signal,
		AbortSignal.timeout(timeLimit),
	]);
	try {
		await checkNativeProviderTargets(binding, command, preflight);
		preflight.throwIfAborted();
	} catch (err) {
		await settleNativeOperation(ctx.prisma, claim.row, { state: "REJECTED" });
		if (err instanceof NativeProviderTargetError)
			return jsonError(
				err.status,
				"The selected Bitmovin resource could not be verified.",
			);
		return jsonError(502, "Could not verify the Bitmovin resource.");
	}

	const budgetMeasuredFrom = performance.now();
	const budget = await nativeOperationDispatchBudget(ctx.prisma, claim.row);
	if (budget === null) {
		const current = await getNativeOperation(ctx.prisma, proposal.id);
		return responseFor(current ?? claim.row);
	}
	const deadline = budgetMeasuredFrom + Math.min(timeLimit, budget);
	const dispatchSignal = AbortSignal.timeout(
		Math.max(0, Math.ceil(deadline - performance.now())),
	);

	let outcome: NativeOperationOutcome;
	let uploadUrl: string | undefined;
	try {
		// A disconnect after the durable claim cannot cancel reconciliation.
		const result = await dispatchNativeProviderOperation(
			binding,
			command,
			proposal.id,
			dispatchSignal,
			() => {
				if (performance.now() >= deadline || nativeOperationExpired(claim.row))
					throw new Error("The operation dispatch window closed.");
				dispatchSignal.throwIfAborted();
			},
		);
		const { uploadUrl: ephemeral, ...safe } = result;
		uploadUrl = ephemeral;
		outcome = { state: "ACCEPTED", ...safe };
	} catch (err) {
		outcome = {
			state: providerRefusedNativeOperation(err, action)
				? "REJECTED"
				: "UNKNOWN",
		};
	}

	const settled = await settleNativeOperation(ctx.prisma, claim.row, outcome);
	await writeAuditLog(
		ctx,
		{
			actor: ctx.tenant.actor,
			method: "POST",
			path,
			bitmovinAccountId,
			request: { id: proposal.id, action },
			response: { state: settled.state },
			statusCode: statusFor(settled.state),
		},
		req,
	);
	return responseFor(settled, uploadUrl);
}

export async function POST(req: Request) {
	try {
		return noStore(await runOperation(req));
	} catch (err) {
		return noStore(
			err instanceof NativeOperationConflict
				? jsonError(
						409,
						"The account or operation changed. Refresh the list before submitting again.",
						err.code ? { code: err.code } : undefined,
					)
				: routeError(err),
		);
	}
}
