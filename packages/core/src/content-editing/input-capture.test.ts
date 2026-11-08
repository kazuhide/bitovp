import { describe, expect, it } from "vitest";
import {
	createInputCaptureCredentials,
	verifyInputCaptureAuthorization,
} from "./input-capture";

const secret = "test-only-secret-with-at-least-thirty-two-characters";
const organizationId = "00000000-0000-4000-8000-000000000001";
const receiptId = "00000000-0000-4000-8000-000000000002";
const now = 1_800_000_000;
const expiresAt = now + 86400;
const authorization = (username: string, password: string) =>
	`Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;

describe("versioned input gateway credentials", () => {
	it("binds one receipt, tenant and expiration without a secret in the URL or proof", () => {
		const credentials = createInputCaptureCredentials({
			secret,
			organizationId,
			receiptId,
			expiresAt,
			now,
		});
		expect(credentials.username).toBe(`v1.${organizationId}.${expiresAt}`);
		expect(credentials.username).not.toContain(":");
		expect(credentials.password).toMatch(/^[a-f0-9]{64}$/);
		expect(
			verifyInputCaptureAuthorization({
				secret,
				receiptId,
				authorization: authorization(
					credentials.username,
					credentials.password,
				),
				now,
			}),
		).toEqual({ organizationId, expiresAt });
	});
	it.each([
		null,
		"",
		"Bearer token",
		"Basic ???",
		`Basic ${"a".repeat(2048)}`,
	])("rejects malformed or unbounded authorization", (value) => {
		expect(
			verifyInputCaptureAuthorization({
				secret,
				receiptId,
				authorization: value,
				now,
			}),
		).toBeNull();
	});
	it("rejects another receipt, another tenant, an expired token and a rotated secret", () => {
		const credentials = createInputCaptureCredentials({
			secret,
			organizationId,
			receiptId,
			expiresAt,
			now,
		});
		const value = authorization(credentials.username, credentials.password);
		expect(
			verifyInputCaptureAuthorization({
				secret,
				receiptId: organizationId,
				authorization: value,
				now,
			}),
		).toBeNull();
		expect(
			verifyInputCaptureAuthorization({
				secret,
				receiptId,
				authorization: authorization(
					credentials.username.replace(organizationId, receiptId),
					credentials.password,
				),
				now,
			}),
		).toBeNull();
		expect(
			verifyInputCaptureAuthorization({
				secret,
				receiptId,
				authorization: value,
				now: expiresAt,
			}),
		).toBeNull();
		expect(
			verifyInputCaptureAuthorization({
				secret: "x".repeat(40),
				receiptId,
				authorization: value,
				now,
			}),
		).toBeNull();
	});
	it.each([
		now,
		now - 1,
		now + 604801,
	])("does not issue expired or over-seven-day credentials", (expiry) => {
		expect(() =>
			createInputCaptureCredentials({
				secret,
				organizationId,
				receiptId,
				expiresAt: expiry,
				now,
			}),
		).toThrow();
	});
	it("does not issue credentials with a weak or missing server key", () => {
		expect(() =>
			createInputCaptureCredentials({
				secret: "short",
				organizationId,
				receiptId,
				expiresAt,
				now,
			}),
		).toThrow();
	});
});
