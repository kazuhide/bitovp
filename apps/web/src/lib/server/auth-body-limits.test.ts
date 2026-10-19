import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { streamedRequest } from "@/__tests__/request-body-stream";
import { hashPassword as passwordHash } from "@/lib/auth/password";

const verify = vi.fn(async () => ({ ok: true }));
const hashPassword = vi.fn(() => "synthetic-password-hash");
const consumeSetupCode = vi.fn(async () => true);
const userCreate = vi.fn(async () => ({
	id: "11111111-2222-4333-8444-555555555555",
	sessionsValidFrom: new Date(0),
	sessionGeneration: 0,
}));
const transaction = vi.fn(async (run: (tx: unknown) => Promise<unknown>) =>
	run({
		user: { count: async () => 0, create: userCreate },
		membership: { create: async () => ({}) },
	}),
);
const getIdentityPrisma = vi.fn(() => ({ $transaction: transaction }));
vi.mock("@bitovp/db", () => ({ getIdentityPrisma: () => getIdentityPrisma() }));
vi.mock("@/lib/auth/provider", () => ({
	resolveProvider: () => ({ readiness: () => ({ ready: true }), verify }),
}));
vi.mock("@/lib/auth/setup-code", () => ({
	consumeSetupCode: () => consumeSetupCode(),
}));
vi.mock("@/lib/auth/users", async (original) => ({
	...(await original<Record<string, unknown>>()),
	hashPassword: () => hashPassword(),
	bumpUsersExist: vi.fn(),
}));

import { POST as login } from "@/app/api/auth/login/route";
import { POST as setup } from "@/app/api/auth/setup/route";

const encoder = new TextEncoder();
const hash = passwordHash("synthetic-login-password");
const validSetup = {
	code: "abcd-efgh-ijkl-mnop",
	email: "admin@example.com",
	displayName: "Admin",
	password: "a-strong-password-12",
};
const routes = [
	{
		name: "login",
		post: login,
		limit: 4096,
		mode: "password",
		body: { password: "valid" },
		status: 200,
	},
	{
		name: "setup",
		post: setup,
		limit: 8192,
		mode: "users",
		body: validSetup,
		status: 201,
	},
] as const;

beforeEach(() => {
	vi.clearAllMocks();
	vi.stubEnv("AUTH_PASSWORD_HASH", hash);
	vi.stubEnv("AUTH_SESSION_SECRET", "0".repeat(48));
	vi.stubEnv("AUTH_ALLOW_INSECURE_HTTP", "true");
});
afterEach(() => vi.unstubAllEnvs());

for (const route of routes) {
	describe(`${route.name} received body limit`, () => {
		beforeEach(() => vi.stubEnv("AUTH_MODE", route.mode));
		it("retains configuration failure precedence without reading the body", async () => {
			vi.stubEnv("AUTH_SESSION_SECRET", "");
			const { request, reads } = streamedRequest(
				`http://test/api/auth/${route.name}`,
				[new Uint8Array(route.limit + 1)],
			);
			expect((await route.post(request)).status).toBe(503);
			expect(reads.pulls).toBe(0);
			expect(verify).not.toHaveBeenCalled();
		});
		it("rejects a declared oversize without pulling any body bytes", async () => {
			const { request, reads } = streamedRequest(
				`http://test/api/auth/${route.name}`,
				[encoder.encode("unread")],
				{ contentLength: String(route.limit + 1) },
			);
			expect((await route.post(request)).status).toBe(413);
			expect(reads).toEqual({ pulls: 0, cancellations: 1 });
			expect(verify).not.toHaveBeenCalled();
			expect(consumeSetupCode).not.toHaveBeenCalled();
		});
		it.each([
			undefined,
			"1",
			"invalid",
		])("rejects bytes beyond the limit with declared length %s before authentication or writes", async (contentLength) => {
			for (const suffix of [" ", "!"]) {
				const first = encoder.encode(JSON.stringify(route.body));
				const { request, reads } = streamedRequest(
					`http://test/api/auth/${route.name}`,
					[
						first,
						encoder.encode(suffix.repeat(route.limit + 1 - first.byteLength)),
						encoder.encode(" "),
					],
					{ contentLength },
				);
				const response = await route.post(request);
				expect(response.status).toBe(413);
				expect(await response.json()).toEqual({
					error: "Request body is too large",
				});
				expect(response.headers.getSetCookie()).toEqual([]);
				expect(reads).toEqual({ pulls: 2, cancellations: 1 });
				expect(request.body?.locked).toBe(false);
			}
			expect(verify).not.toHaveBeenCalled();
			expect(hashPassword).not.toHaveBeenCalled();
			expect(consumeSetupCode).not.toHaveBeenCalled();
			expect(getIdentityPrisma).not.toHaveBeenCalled();
		});
		it("counts multibyte JSON by bytes and leaves the failure budget available", async () => {
			const tooLarge = encoder.encode(
				JSON.stringify({
					...route.body,
					password: "界".repeat(Math.floor(route.limit / 3) + 1),
				}),
			);
			for (let i = 0; i < 45; i += 1) {
				const { request } = streamedRequest(
					`http://test/api/auth/${route.name}`,
					[tooLarge],
				);
				expect((await route.post(request)).status).toBe(413);
			}
			const { request } = streamedRequest(
				`http://test/api/auth/${route.name}`,
				[encoder.encode(JSON.stringify(route.body))],
			);
			expect((await route.post(request)).status).toBe(route.status);
		});
		it("accepts valid JSON exactly at the limit and keeps malformed small JSON at 400", async () => {
			const body = JSON.stringify(route.body);
			const padded =
				body + " ".repeat(route.limit - encoder.encode(body).byteLength);
			const { request } = streamedRequest(
				`http://test/api/auth/${route.name}`,
				[encoder.encode(padded)],
			);
			expect((await route.post(request)).status).toBe(route.status);
			const invalid = streamedRequest(`http://test/api/auth/${route.name}`, [
				encoder.encode("!"),
			]);
			expect((await route.post(invalid.request)).status).toBe(400);
		});
	});
}
