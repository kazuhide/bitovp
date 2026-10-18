import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api";
import { localizedCustomerError } from "@/lib/customer-error";
import { messagesFor, translate } from "@/lib/i18n";
import { publicContextError } from "./public-context-error";

describe("public authentication context errors", () => {
	it.each([
		[401, "Current password is incorrect", "AUTH_INVALID_CREDENTIALS"],
		[409, "Credentials changed — sign in again", "AUTH_CREDENTIALS_CHANGED"],
		[403, "Password change required", "AUTH_PASSWORD_CHANGE_REQUIRED"],
		[503, "Authentication is not configured", "AUTH_NOT_CONFIGURED"],
		[
			503,
			"Authentication is unavailable (database)",
			"AUTH_PROVIDER_UNAVAILABLE",
		],
		[403, "Client IP is not allowed for this organization", "TENANT_IP_DENIED"],
		[409, "Organization changed — reload before continuing", "TENANT_CHANGED"],
		[403, "Organization membership is required", "TENANT_MEMBERSHIP_REQUIRED"],
	] as const)("keeps the curated %s reason and its stable code", (status, message, code) => {
		expect(publicContextError({ status, message })).toEqual({
			error: message,
			code,
		});
	});
	it.each([
		"malformed",
		"unknown",
		"mismatch",
		"revoked",
		"expired",
	])("preserves the known token rejection %s", (reason) => {
		const message = `Invalid API token (${reason})`;
		expect(publicContextError({ status: 401, message })).toEqual({
			error: message,
			code: "AUTH_INVALID_CREDENTIALS",
		});
	});
	it.each([
		401, 403, 409, 503,
	] as const)("never reflects arbitrary diagnostic text for status%s", (status) => {
		const message =
			"Invalid API token (https://private.example/secret?token=private-value)";
		const response = publicContextError({ status, message });
		expect(JSON.stringify(response)).not.toContain("private");
		expect(response.error).not.toContain("https:");
	});
	it.each([
		"en",
		"ja",
	] as const)("localizes actionable IP and organization failures in%s", (locale) => {
		const messages = messagesFor(locale);
		const t = (key: Parameters<typeof translate>[1]) =>
			translate(messages, key);
		for (const code of [
			"AUTH_PASSWORD_CHANGE_REQUIRED",
			"TENANT_IP_DENIED",
			"TENANT_CHANGED",
			"TENANT_MEMBERSHIP_REQUIRED",
			"TENANT_IP_INVALID",
		]) {
			const visible = localizedCustomerError(
				t,
				new ApiError(403, "private-value", { code }),
				"common.requestFailed",
			);
			expect(visible).not.toBe(t("common.requestFailed"));
			expect(visible).not.toContain("private-value");
		}
	});
});
