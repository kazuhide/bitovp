import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
	identity: vi.fn(),
	owner: vi.fn(),
	context: vi.fn(),
	proof: vi.fn(),
	backoff: vi.fn(),
	charge: vi.fn(),
	clear: vi.fn(),
	claim: vi.fn(),
	transaction: vi.fn(),
	target: vi.fn(),
	count: vi.fn(),
	update: vi.fn(),
}));
vi.mock("@bitovp/db", () => ({
	getIdentityPrisma: () => ({
		user: { updateMany: fake.claim },
		$transaction: fake.transaction,
	}),
}));
vi.mock("@/lib/auth/tenancy", async () => ({
	...(await vi.importActual<typeof import("@/lib/auth/tenancy")>(
		"@/lib/auth/tenancy",
	)),
	resolveSessionIdentity: fake.identity,
	requirePlatformOwner: fake.owner,
	resolveAuthenticatedContext: fake.context,
}));
vi.mock("@/lib/auth/users", async () => ({
	...(await vi.importActual<typeof import("@/lib/auth/users")>(
		"@/lib/auth/users",
	)),
	verifyUserLogin: fake.proof,
	accountBackoffRemainingMs: fake.backoff,
	chargeAccountFailure: fake.charge,
	clearAccountFailures: fake.clear,
}));

import {
	POST as enterViewAs,
	DELETE as exitViewAs,
} from "../../app/api/account/impersonation/route";
import { POST as switchOrganization } from "../../app/api/account/organization/route";
import { PATCH as editGlobalUser } from "../../app/api/platform/users/[id]/route";
import { issueSession, verifySession } from "./session";

const ACTOR = "11111111-2222-4333-8444-555555555555",
	TARGET = "22222222-2222-4333-8444-555555555555",
	ORG = "33333333-2222-4333-8444-555555555555",
	OTHER = "44444444-2222-4333-8444-555555555555";
const SECRET = "management-tests-session-secret-at-least-32-bytes";
const request = (body: object) =>
	new Request("http://localhost/api/account/organization", {
		method: "POST",
		headers: { "x-bitovp-expected-org": ORG },
		body: JSON.stringify(body),
	});
function responsePayload(res: Response) {
	const value = res.headers
		.getSetCookie()[0]
		?.split(";")[0]
		?.split("=")
		.slice(1)
		.join("=");
	const verdict = verifySession(value, SECRET, Date.now(), "users");
	expect(verdict.ok).toBe(true);
	if (!verdict.ok) throw Error("Missing signed response");
	return verdict.payload;
}
beforeEach(() => {
	vi.clearAllMocks();
	vi.stubEnv("AUTH_MODE", "users");
	vi.stubEnv("AUTH_SESSION_SECRET", SECRET);
	vi.stubEnv("AUTH_ALLOW_INSECURE_HTTP", "true");
	const payload = issueSession({
		mode: "users",
		now: Date.now(),
		idleMs: 60_000,
		maxMs: 120_000,
		sub: ACTOR,
		sessionGeneration: 7,
		organizationId: ORG,
	});
	const identity = {
		user: {
			id: ACTOR,
			email: "owner@example.com",
			platformOwner: true,
			mustChangePassword: false,
		},
		payload,
	};
	fake.identity.mockResolvedValue(identity);
	fake.owner.mockResolvedValue(identity);
	fake.context.mockResolvedValue({ organizationId: OTHER });
	fake.backoff.mockReturnValue(0);
	fake.claim.mockResolvedValue({ count: 1 });
	fake.proof.mockResolvedValue({
		ok: true,
		verifiedCredential: { sessionGeneration: 7, passwordHash: "proved-hash" },
	});
	fake.target.mockResolvedValue({
		id: TARGET,
		active: true,
		platformOwner: false,
	});
	fake.count.mockResolvedValue(1);
	fake.update.mockResolvedValue({
		id: TARGET,
		email: "target@example.com",
		active: true,
	});
	fake.transaction.mockImplementation(async (callback) =>
		callback({
			user: { findUnique: fake.target, count: fake.count, update: fake.update },
		}),
	);
});
describe("organization selection and owner view-as", () => {
	it("validates the new membership/IP policy and preserves every session lifetime/generation field on switch", async () => {
		const before = (await fake.identity()).payload;
		const res = await switchOrganization(request({ organizationId: OTHER }));
		expect(res.status).toBe(200);
		expect(responsePayload(res)).toEqual({ ...before, organizationId: OTHER });
		expect(
			fake.context.mock.calls[0]?.[0].get("x-bitovp-expected-org"),
		).toBeNull();
	});
	it("cannot switch to an inaccessible organization", async () => {
		const { AuthContextError } = await import("./tenancy");
		fake.context.mockRejectedValue(new AuthContextError(403, "No membership"));
		const res = await switchOrganization(request({ organizationId: OTHER }));
		expect(res.status).toBe(403);
		expect(res.headers.getSetCookie()).toEqual([]);
	});
	it("cannot switch while viewing as or using forced-rotation credentials", async () => {
		const identity = await fake.identity();
		fake.identity.mockResolvedValue({
			...identity,
			payload: { ...identity.payload, targetUserId: TARGET },
		});
		expect(
			(await switchOrganization(request({ organizationId: OTHER }))).status,
		).toBe(403);
		fake.identity.mockResolvedValue({
			...identity,
			user: { ...identity.user, mustChangePassword: true },
		});
		expect(
			(await switchOrganization(request({ organizationId: OTHER }))).status,
		).toBe(403);
		expect(fake.context).not.toHaveBeenCalled();
	});
	it("re-proves the actual owner password and keeps actor identity/lifetime when entering a short view-as", async () => {
		const before = (await fake.identity()).payload;
		const res = await enterViewAs(
			request({
				organizationId: OTHER,
				targetUserId: TARGET,
				currentPassword: "current",
			}),
		);
		expect(res.status).toBe(200);
		const next = responsePayload(res);
		expect(next).toMatchObject({
			...before,
			organizationId: OTHER,
			returnOrganizationId: ORG,
			targetUserId: TARGET,
		});
		expect(next.mode).toBe("users");
		if (next.mode === "users")
			expect(next.impersonationExpiresAt).toBeLessThanOrEqual(before.abs);
		expect(fake.claim.mock.calls[0]?.[0].where).toMatchObject({
			id: ACTOR,
			active: true,
			platformOwner: true,
			sessionGeneration: 7,
			passwordHash: "proved-hash",
		});
	});
	it("does not grant view-as after owner credential reset wins the CAS race", async () => {
		fake.claim.mockResolvedValue({ count: 0 });
		const res = await enterViewAs(
			request({
				organizationId: OTHER,
				targetUserId: TARGET,
				currentPassword: "current",
			}),
		);
		expect(res.status).toBe(409);
		expect(fake.context).not.toHaveBeenCalled();
		expect(res.headers.getSetCookie()).toEqual([]);
	});
	it("charges wrong password and stops spending re-proofs during backoff", async () => {
		fake.proof.mockResolvedValue({ ok: false, reason: "invalid" });
		expect(
			(
				await enterViewAs(
					request({
						organizationId: OTHER,
						targetUserId: TARGET,
						currentPassword: "wrong",
					}),
				)
			).status,
		).toBe(401);
		expect(fake.charge).toHaveBeenCalledWith("owner@example.com");
		fake.proof.mockClear();
		fake.backoff.mockReturnValue(2_000);
		const res = await enterViewAs(
			request({
				organizationId: OTHER,
				targetUserId: TARGET,
				currentPassword: "wrong",
			}),
		);
		expect(res.status).toBe(429);
		expect(res.headers.get("retry-after")).toBe("2");
		expect(fake.proof).not.toHaveBeenCalled();
	});
	it("exit restores original organization even if the target organization is unavailable", async () => {
		const identity = await fake.identity();
		fake.identity.mockResolvedValue({
			...identity,
			payload: {
				...identity.payload,
				organizationId: OTHER,
				targetUserId: TARGET,
				returnOrganizationId: ORG,
				impersonationExpiresAt: identity.payload.abs,
			},
		});
		fake.context.mockRejectedValue(Error("Target unavailable"));
		const res = await exitViewAs(
			new Request("http://localhost/api/account/impersonation", {
				method: "DELETE",
			}),
		);
		expect(res.status).toBe(200);
		const next = responsePayload(res);
		expect(next).toEqual(identity.payload);
		expect(fake.context).not.toHaveBeenCalled();
	});
});
describe("global password/account control", () => {
	const edit = (body: object, id = TARGET) =>
		editGlobalUser(
			new Request(`http://localhost/api/platform/users/${id}`, {
				method: "PATCH",
				body: JSON.stringify(body),
			}),
			{ params: Promise.resolve({ id }) },
		);
	it("password reissue is owner-only, rotates generation and returns temporary password without caching", async () => {
		const res = await edit({ resetPassword: true });
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.temporaryPassword).toBeTypeOf("string");
		expect(body.user).not.toHaveProperty("passwordHash");
		expect(res.headers.get("cache-control")).toContain("no-store");
		expect(fake.update.mock.calls[0]?.[0].data).toMatchObject({
			mustChangePassword: true,
			sessionGeneration: { increment: 1 },
			sessionsValidFrom: expect.any(Date),
			passwordExpiresAt: expect.any(Date),
		});
		expect(fake.transaction.mock.calls[0]?.[1]).toEqual({
			isolationLevel: "Serializable",
		});
	});
	it("independent owner guard denies organization admins before global identity lookup", async () => {
		const { AuthContextError } = await import("./tenancy");
		fake.owner.mockRejectedValue(new AuthContextError(403, "Owner required"));
		expect((await edit({ resetPassword: true })).status).toBe(403);
		expect(fake.transaction).not.toHaveBeenCalled();
	});
	it("refuses self-disable or self-reset to preserve the only copyable credential", async () => {
		expect((await edit({ resetPassword: true }, ACTOR)).status).toBe(409);
		expect((await edit({ active: false }, ACTOR)).status).toBe(409);
		expect(fake.transaction).not.toHaveBeenCalled();
	});
	it("does not globally deactivate the last active platform owner", async () => {
		fake.target.mockResolvedValue({
			id: TARGET,
			active: true,
			platformOwner: true,
		});
		fake.count.mockResolvedValue(0);
		expect((await edit({ active: false })).status).toBe(409);
		expect(fake.update).not.toHaveBeenCalled();
	});
});
