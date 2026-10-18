import "server-only";
import type { CustomerErrorCode } from "@/lib/customer-error";
import type { AuthContextError } from "./tenancy";

type PublicContextError = { error: string; code: CustomerErrorCode };
const groups: readonly {
	code: CustomerErrorCode;
	reasons: readonly string[];
}[] = [
	{
		code: "AUTH_NOT_CONFIGURED",
		reasons: ["Authentication is not configured"],
	},
	{
		code: "AUTH_PROVIDER_UNAVAILABLE",
		reasons: [
			"Authentication is unavailable (database)",
			"Authentication provider is unavailable",
			"User authentication is unavailable",
			"Token verification is unavailable (database)",
		],
	},
	{
		code: "AUTH_INVALID_CREDENTIALS",
		reasons: [
			"Authentication required",
			"Session is no longer valid",
			"Current password is incorrect",
			"Invalid API token",
			"Invalid API token (malformed)",
			"Invalid API token (unknown)",
			"Invalid API token (mismatch)",
			"Invalid API token (revoked)",
			"Invalid API token (expired)",
		],
	},
	{
		code: "AUTH_CREDENTIALS_CHANGED",
		reasons: ["Credentials changed — sign in again"],
	},
	{
		code: "AUTH_PASSWORD_CHANGE_REQUIRED",
		reasons: ["Password change required"],
	},
	{
		code: "TENANT_IP_DENIED",
		reasons: ["Client IP is not allowed for this organization"],
	},
	{
		code: "TENANT_CHANGED",
		reasons: ["Organization changed — reload before continuing"],
	},
	{
		code: "TENANT_MEMBERSHIP_REQUIRED",
		reasons: [
			"A human user session is required",
			"A user session is required",
			"Legacy authentication is confined to the main organization",
			"Legacy tokens are confined to the main organization",
			"Token owner membership is unavailable",
			"View-as session is not permitted",
			"View-as target is unavailable",
			"Organization membership is required",
			"Organization is unavailable",
			"An organization administrator is required",
			"A platform owner session is required",
			"Organization switching is unavailable",
			"Manage only your current organization",
			"Organization management requires users mode",
			"User membership management requires users mode",
			"No membership in this organization",
			"Promote another active organization administrator first",
			"Use another owner for this account action",
			"User is unavailable",
			"Keep an active platform owner",
			"Queue mutation is not allowed",
			"Queue job operation is not available",
			"Queue job is unavailable",
			"Global queue operation is not available",
		],
	},
];

/** Curated literals only: never send arbitrary exception or token-reason prose. */
export function publicContextError(
	error: Pick<AuthContextError, "status" | "message">,
): PublicContextError {
	for (const group of groups) {
		const reason = group.reasons.find(
			(candidate) => candidate === error.message,
		);
		if (reason !== undefined) return { error: reason, code: group.code };
	}
	if (error.status === 401)
		return { error: "Invalid API token", code: "AUTH_INVALID_CREDENTIALS" };
	if (error.status >= 500)
		return {
			error: "Authentication is unavailable",
			code: "AUTH_PROVIDER_UNAVAILABLE",
		};
	return { error: "Access is not allowed", code: "TENANT_MEMBERSHIP_REQUIRED" };
}
