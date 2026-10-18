import { MasterKeyConfigError, SecretDecryptError } from "@bitovp/core";
import { NextResponse } from "next/server";
import { z } from "zod";
import { publicContextError } from "@/lib/auth/public-context-error";
import { AuthContextError } from "@/lib/auth/tenancy";

export function jsonError(status: number, error: string, details?: unknown) {
	return NextResponse.json(
		details === undefined ? { error } : { error, details },
		{ status },
	);
}

export function validationError(error: z.ZodError) {
	return jsonError(400, "Validation failed", z.flattenError(error));
}

export async function readJson(req: Request): Promise<unknown | null> {
	try {
		return await req.json();
	} catch {
		return null;
	}
}

const uuidSchema = z.uuid();

/** Route params come from the URL — reject non-UUIDs before touching the DB. */
export function invalidIdResponse(id: string) {
	return uuidSchema.safeParse(id).success ? null : jsonError(400, "Invalid id");
}

/** Maps store/crypto/config failures to safe HTTP responses. */
export function routeError(err: unknown) {
	if (err instanceof AuthContextError) {
		const response = publicContextError(err);
		return jsonError(err.status, response.error, { code: response.code });
	}
	if (err instanceof SecretDecryptError) {
		return jsonError(
			500,
			"Secret decryption failed — has MASTER_KEY changed since this record was saved?",
		);
	}
	if (err instanceof MasterKeyConfigError) {
		// Config state stays in server logs; clients get a generic 503.
		console.error("[api] master key configuration error:", err.message);
		return jsonError(503, "Server key configuration error");
	}
	if ((err as { code?: string }).code === "P2025") {
		return jsonError(404, "Not found");
	}
	console.error(
		"[api] unhandled route error:",
		err instanceof Error ? `${err.name}: ${err.message}\n${err.stack}` : err,
	);
	return jsonError(500, "Internal error");
}
