import { z } from "zod";
import { ApiError } from "./api";

export const CREATE_SESSION_HEADER = "X-BitOVP-Create-Session";
export const CREATE_SESSION_CHANGED = "CREATE_SESSION_CHANGED";
export const CREATE_REQUEST_DIGEST_HEADER = "X-BitOVP-Create-Request-Digest";
export const CREATE_REQUEST_NOT_FOUND = "CREATE_REQUEST_NOT_FOUND";

export function creationErrorCode(error: unknown) {
	if (!(error instanceof ApiError)) return undefined;
	const details = z.object({ code: z.string() }).safeParse(error.details);
	return details.success ? details.data.code : undefined;
}

/** Canonical wire-body identity used by existing server receipts. */
export function canonicalCreateRequestJson(value: unknown): string {
	if (value === null || typeof value !== "object") {
		const encoded = JSON.stringify(value);
		if (encoded === undefined)
			throw new Error("Create requests must contain JSON values");
		return encoded;
	}
	if (Array.isArray(value))
		return `[${value.map(canonicalCreateRequestJson).join(",")}]`;
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.sort()
		.filter((key) => record[key] !== undefined)
		.map(
			(key) =>
				`${JSON.stringify(key)}:${canonicalCreateRequestJson(record[key])}`,
		)
		.join(",")}}`;
}
