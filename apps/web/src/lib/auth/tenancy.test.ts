import { beforeEach, describe, expect, it, vi } from "vitest";
import { mintToken } from "./api-token";
import { issueSession, signSession } from "./session";
import { resolveAuthenticatedContext } from "./tenancy";

const fake = vi.hoisted(() => ({
	user: { findUnique: vi.fn() },
	organization: { findUnique: vi.fn() },
	membership: { findUnique: vi.fn() },
	apiToken: { findUnique: vi.fn() },
}));
vi.mock("@bitovp/db", () => ({
	getIdentityPrisma: () => fake,
	resolveApiTokenForAuthentication: (prefix: string) =>
		fake.apiToken.findUnique({ where: { prefix } }),
}));
vi.mock("./ip-policy", () => ({
	verifiedClientIp: () => "192.0.2.1",
	ipAllowedByPolicy: (cidrs: string[]) => cidrs.length === 0,
}));

const ACTOR = "11111111-2222-4333-8444-555555555555";
const TARGET = "22222222-2222-4333-8444-555555555555";
const ORG = "33333333-2222-4333-8444-555555555555";
const OTHER = "44444444-2222-4333-8444-555555555555";
const SECRET = "tenant-session-test-secret-at-least-32-bytes";
function headers(extra: Record<string, string> = {}, targetUserId?: string) {
	const payload = issueSession({
		mode: "users",
		now: Date.now(),
		idleMs: 60_000,
		maxMs: 120_000,
		sub: ACTOR,
		sessionGeneration: 1,
		organizationId: ORG,
		...(targetUserId
			? {
					targetUserId,
					impersonationExpiresAt: Date.now() + 30_000,
					returnOrganizationId: OTHER,
				}
			: {}),
	});
	return new Headers({
		cookie: `bitovp_session=${signSession(payload, SECRET)}`,
		...extra,
	});
}
beforeEach(() => {
	vi.stubEnv("AUTH_MODE", "users");
	vi.stubEnv("AUTH_SESSION_SECRET", SECRET);
	vi.stubEnv("AUTH_ALLOW_INSECURE_HTTP", "true");
	fake.user.findUnique.mockReset().mockImplementation(async ({ where }) => ({
		id: where.id,
		email: "user@example.com",
		displayName: where.id === ACTOR ? "Actor" : "Target",
		role: "ADMIN",
		platformOwner: false,
		active: true,
		mustChangePassword: false,
		sessionsValidFrom: new Date(0),
		sessionGeneration: 1,
	}));
	fake.organization.findUnique.mockReset().mockResolvedValue({
		id: ORG,
		name: "One",
		active: true,
		allowedIpCidrs: [],
	});
	fake.membership.findUnique
		.mockReset()
		.mockResolvedValue({ role: "VIEWER", active: true });
	fake.apiToken.findUnique.mockReset();
});
describe("organization-bound tokens", () => {
	function credential(userId: string | null = ACTOR, organizationId = ORG) {
		const minted = mintToken();
		fake.apiToken.findUnique.mockResolvedValue({
			id: TARGET,
			tokenHash: minted.tokenHash,
			role: "ADMIN",
			organizationId,
			userId,
			revokedAt: null,
			expiresAt: null,
			createdBy: "fixture",
		});
		return new Headers({ authorization: `Bearer ${minted.secret}` });
	}
	it("resolves one uncached token row and caps token role at fresh membership role", async () => {
		const context = await resolveAuthenticatedContext(credential());
		expect(context).toMatchObject({
			organizationId: ORG,
			role: "VIEWER",
			actorRole: "VIEWER",
			actorUserId: ACTOR,
			actor: `token:${TARGET}`,
		});
		expect(fake.apiToken.findUnique).toHaveBeenCalledTimes(1);
	});
	it("a token of an organization administrator remains admin-authored for audit exclusion despite its narrower token role", async () => {
		const input = credential();
		fake.apiToken.findUnique.mockResolvedValue({
			...(await fake.apiToken.findUnique()),
			role: "OPERATOR",
		});
		fake.membership.findUnique.mockResolvedValue({
			role: "ADMIN",
			active: true,
		});
		expect(await resolveAuthenticatedContext(input)).toMatchObject({
			role: "OPERATOR",
			actorRole: "ADMIN",
		});
	});
	it("rechecks issuer membership and global activation on every request", async () => {
		const input = credential();
		await resolveAuthenticatedContext(input);
		fake.membership.findUnique.mockResolvedValue({
			role: "ADMIN",
			active: false,
		});
		await expect(resolveAuthenticatedContext(input)).rejects.toMatchObject({
			status: 403,
		});
	});
	it("a presented revoked token cannot fall back to a valid user cookie", async () => {
		const input = credential();
		input.set("cookie", headers().get("cookie") ?? "");
		fake.apiToken.findUnique.mockResolvedValue({
			...(await fake.apiToken.findUnique()),
			revokedAt: new Date(),
		});
		await expect(resolveAuthenticatedContext(input)).rejects.toMatchObject({
			status: 401,
		});
	});
	it("legacy null-issuer tokens are confined to migrated main data", async () => {
		await expect(
			resolveAuthenticatedContext(credential(null)),
		).rejects.toMatchObject({ status: 403 });
	});
	it("legacy authentication cannot admit a new organization's linked token", async () => {
		const input = credential();
		vi.stubEnv("AUTH_MODE", "none");
		await expect(resolveAuthenticatedContext(input)).rejects.toMatchObject({
			status: 403,
		});
	});
	it("fresh owner revocation removes owner privileges on the next request", async () => {
		const input = credential();
		fake.user.findUnique.mockImplementation(async ({ where }) => ({
			id: where.id,
			email: "u@example.com",
			displayName: "Owner",
			active: true,
			platformOwner: true,
			role: "ADMIN",
			mustChangePassword: false,
			sessionsValidFrom: new Date(0),
			sessionGeneration: 1,
		}));
		expect((await resolveAuthenticatedContext(input)).platformOwner).toBe(true);
		fake.user.findUnique.mockResolvedValue({
			id: ACTOR,
			active: false,
			role: "ADMIN",
			platformOwner: true,
			mustChangePassword: false,
			sessionsValidFrom: new Date(0),
			sessionGeneration: 1,
		});
		await expect(resolveAuthenticatedContext(input)).rejects.toMatchObject({
			status: 403,
		});
	});
});
describe("organization authorization", () => {
	it("uses membership role instead of global User.role", async () => {
		const context = await resolveAuthenticatedContext(headers());
		expect(context).toMatchObject({
			organizationId: ORG,
			role: "VIEWER",
			actorUserId: ACTOR,
			effectiveUserId: ACTOR,
		});
	});
	it("refuses stale-tab expected organization", async () => {
		await expect(
			resolveAuthenticatedContext(headers({ "x-bitovp-expected-org": OTHER })),
		).rejects.toMatchObject({ status: 409 });
	});
	it("ignores forged trusted actor/role/organization headers", async () => {
		const context = await resolveAuthenticatedContext(
			headers({
				"x-bitovp-role": "ADMIN",
				"x-bitovp-actor": `user:${TARGET}`,
				"x-bitovp-organization": OTHER,
			}),
		);
		expect(context).toMatchObject({
			organizationId: ORG,
			role: "VIEWER",
			actorUserId: ACTOR,
		});
	});
	it("observes membership revocation on the next request", async () => {
		await resolveAuthenticatedContext(headers());
		fake.membership.findUnique.mockResolvedValue({
			role: "ADMIN",
			active: false,
		});
		await expect(resolveAuthenticatedContext(headers())).rejects.toMatchObject({
			status: 403,
		});
	});
	it("denies a configured IP restriction before tenant data access", async () => {
		fake.organization.findUnique.mockResolvedValue({
			id: ORG,
			name: "One",
			active: true,
			allowedIpCidrs: ["198.51.100.0/24"],
		});
		await expect(resolveAuthenticatedContext(headers())).rejects.toMatchObject({
			status: 403,
		});
	});
	it("cannot impersonate with only organization ADMIN", async () => {
		await expect(
			resolveAuthenticatedContext(headers({}, TARGET)),
		).rejects.toMatchObject({ status: 403 });
	});
	it("owner keeps the real actor and target membership while viewing as", async () => {
		fake.user.findUnique.mockImplementation(async ({ where }) => ({
			id: where.id,
			email: "u@example.com",
			displayName: "User",
			active: true,
			platformOwner: where.id === ACTOR,
			role: "ADMIN",
			mustChangePassword: false,
			sessionsValidFrom: new Date(0),
			sessionGeneration: 1,
		}));
		const context = await resolveAuthenticatedContext(headers({}, TARGET));
		expect(context).toMatchObject({
			actorUserId: ACTOR,
			effectiveUserId: TARGET,
			role: "VIEWER",
			platformOwner: true,
			isImpersonating: true,
		});
	});
});
