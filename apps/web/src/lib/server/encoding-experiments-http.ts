import "server-only";
import type { AppPrismaClient, UserRole } from "@bitovp/db";
import { NextResponse } from "next/server";
import { z } from "zod";
import { loadAuthConfig } from "@/lib/auth/config";
import { experimentScopeRefusal } from "@/lib/auth/encoding-experiment-scope";
import { publicContextError } from "@/lib/auth/public-context-error";
import { roleAtLeast } from "@/lib/auth/roles";
import { AuthContextError } from "@/lib/auth/tenancy";
import { getServerContext } from "./context";
import { EncodingExperimentError } from "./encoding-experiments";
import { readBoundedJson } from "./request-body";

const headers = { "Cache-Control": "private, no-store" };

class RequestError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
	) {
		super(message);
	}
}

function failure(status: number, code: string, error: string, details = {}) {
	return NextResponse.json(
		{
			error,
			details: {
				code,
				retryable: status === 429 || status === 503,
				...details,
			},
		},
		{ status, headers },
	);
}

type ExperimentContext = {
	organizationId: string;
	prisma: AppPrismaClient;
};

export async function experimentRoute(
	req: Request,
	role: UserRole,
	run: (context: ExperimentContext) => Promise<unknown> | unknown,
	status = 200,
) {
	try {
		const configuration = loadAuthConfig();
		if (!configuration.ok)
			return failure(
				503,
				"AUTH_NOT_CONFIGURED",
				"Authentication is not configured",
			);
		if (configuration.settings.mode === "none")
			return failure(
				403,
				"EXPERIMENT_AUTH_REQUIRED",
				"Encoding experiments require authentication",
			);

		const { tenant, prisma } = await getServerContext(req.headers);
		if (
			!tenant ||
			tenant.actor === "none" ||
			(req.headers.has("authorization") && !tenant.actor.startsWith("token:"))
		)
			return failure(
				401,
				"AUTH_INVALID_CREDENTIALS",
				"Authentication required",
			);
		const refusal = experimentScopeRefusal(
			tenant,
			new URL(req.url).pathname,
			req.method,
			configuration.settings.mode,
		);
		if (refusal)
			return failure(403, refusal, "An encoding experiment token is required");
		if (!roleAtLeast(tenant.role, role) || tenant.isImpersonating)
			return failure(
				403,
				"EXPERIMENT_ROLE_DENIED",
				"This operation is not allowed",
			);
		return NextResponse.json(
			await run({ organizationId: tenant.organizationId, prisma }),
			{ status, headers },
		);
	} catch (error) {
		if (error instanceof AuthContextError) {
			const response = publicContextError(error);
			return failure(error.status, response.code, response.error);
		}
		if (error instanceof RequestError)
			return failure(error.status, error.code, error.message);
		if (error instanceof EncodingExperimentError)
			return failure(error.status, error.code, error.message, {
				...(error.field === undefined ? {} : { field: error.field }),
				...(error.retryable === undefined
					? {}
					: { retryable: error.retryable }),
			});
		// Runtime/DB failures may contain paths or native configuration.
		console.error(
			"[encoding-experiments] request failed",
			error instanceof Error ? error.name : "unknown",
		);
		return failure(
			500,
			"EXPERIMENT_INTERNAL_ERROR",
			"Encoding experiment request failed",
		);
	}
}

export async function experimentBody(req: Request, limit: number) {
	const body = await readBoundedJson(req, limit);
	if (body.tooLarge)
		throw new RequestError(
			413,
			"REQUEST_TOO_LARGE",
			"Request body is too large",
		);
	if (body.value === null)
		throw new RequestError(422, "INVALID_JSON", "A JSON body is required");
	return body.value;
}

export type CampaignParams = { params: Promise<{ id: string }> };

export async function experimentCampaignId({ params }: CampaignParams) {
	const { id } = await params;
	if (!z.uuid().safeParse(id).success)
		throw new RequestError(422, "INVALID_CAMPAIGN_ID", "Invalid campaign ID");
	return id;
}

export function experimentBackend(req: Request): "nvenc" | "software" {
	const values = new URL(req.url).searchParams.getAll("backend");
	if (values.length === 0) return "nvenc";
	if (
		values.length === 1 &&
		(values[0] === "nvenc" || values[0] === "software")
	)
		return values[0];
	throw new RequestError(422, "INVALID_BACKEND", "Choose nvenc or software");
}

export function experimentCursor(req: Request): string | undefined {
	const values = new URL(req.url).searchParams.getAll("cursor");
	if (
		values.length > 1 ||
		(values[0] !== undefined && !/^[A-Za-z0-9._:-]{1,1024}$/.test(values[0]))
	)
		throw new RequestError(422, "INVALID_CURSOR", "Invalid cursor");
	return values[0];
}

const campaignAction = z.strictObject({
	action: z.enum(["pause", "resume", "seal"]),
});

export async function experimentCampaignAction(req: Request) {
	const result = campaignAction.safeParse(await experimentBody(req, 512));
	if (!result.success)
		throw new RequestError(
			422,
			"INVALID_ACTION",
			"Expected pause, resume, or seal",
		);
	return result.data.action;
}
