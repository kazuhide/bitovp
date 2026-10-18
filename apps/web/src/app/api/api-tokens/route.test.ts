import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
	context: vi.fn(),
	create: vi.fn(),
	findMany: vi.fn(),
	updateMany: vi.fn(),
	findUnique: vi.fn(),
	tenant: vi.fn(),
}));
vi.mock("@bitovp/db", () => ({ getTenantPrisma: fake.tenant }));
vi.mock("@/lib/auth/tenancy", async () => {
	const actual =
		await vi.importActual<typeof import("@/lib/auth/tenancy")>(
			"@/lib/auth/tenancy",
		);
	return {
		...actual,
		requireOrganizationAdmin: fake.context,
		resolveAuthenticatedContext: fake.context,
	};
});

import { DELETE } from "./[id]/route";
import { GET, POST } from "./route";

const ORG = "00000000-0000-4000-8000-000000000001",
	USER = "11111111-2222-4333-8444-555555555555",
	ID = "22222222-2222-4333-8444-555555555555";
function post(body: object) {
	return POST(
		new Request("http://localhost/api/api-tokens", {
			method: "POST",
			body: JSON.stringify(body),
		}),
	);
}
function del() {
	return DELETE(
		new Request(`http://localhost/api/api-tokens/${ID}`, { method: "DELETE" }),
		{ params: Promise.resolve({ id: ID }) },
	);
}
beforeEach(() => {
	vi.clearAllMocks();
	fake.context.mockResolvedValue({
		organizationId: ORG,
		actorUserId: USER,
		actor: `user:${USER}`,
		role: "ADMIN",
		isImpersonating: false,
	});
	fake.tenant.mockReturnValue({
		apiToken: {
			create: fake.create,
			findMany: fake.findMany,
			updateMany: fake.updateMany,
			findUnique: fake.findUnique,
		},
	});
	fake.create.mockImplementation(async ({ data }) => ({ ...data, id: ID }));
	fake.findMany.mockResolvedValue([]);
	fake.updateMany.mockResolvedValue({ count: 1 });
	fake.findUnique.mockResolvedValue({ id: ID });
});
describe("organization API tokens", () => {
	it("binds a newly minted token to the authenticated organization and active issuer", async () => {
		const response = await post({ name: "CI" });
		expect(response.status).toBe(201);
		expect(fake.tenant).toHaveBeenCalledWith(ORG);
		expect(fake.create.mock.calls[0]?.[0].data).toMatchObject({
			organizationId: ORG,
			userId: USER,
			createdBy: `user:${USER}`,
			role: "OPERATOR",
		});
		const body = await response.json();
		expect(body.secret).toMatch(/^bo_/);
		expect(body).not.toHaveProperty("tokenHash");
		expect(response.headers.get("cache-control")).toContain("no-store");
	});
	it("a token cannot mint another durable credential", async () => {
		fake.context.mockResolvedValue({
			organizationId: ORG,
			actor: `token:${ID}`,
			role: "ADMIN",
		});
		expect((await post({ name: "CI" })).status).toBe(403);
		expect(fake.create).not.toHaveBeenCalled();
	});
	it("none-mode cannot mint, even with a forged actor header", async () => {
		fake.context.mockResolvedValue({
			organizationId: ORG,
			actor: "none",
			role: "ADMIN",
		});
		expect((await post({ name: "CI" })).status).toBe(403);
	});
	it("rejects caller-supplied organization/user/role fields", async () => {
		for (const body of [
			{ name: "x", organizationId: ORG },
			{ name: "x", userId: USER },
			{ name: "x", role: "ADMIN" },
			{ name: "" },
		])
			expect((await post(body)).status).toBe(400);
		expect(fake.create).not.toHaveBeenCalled();
	});
	it("inventory explicitly withholds token hashes", async () => {
		await GET(new Request("http://localhost/api/api-tokens"));
		const select = fake.findMany.mock.calls[0]?.[0].select;
		expect(select).not.toHaveProperty("tokenHash");
		expect(select).not.toHaveProperty("secret");
	});
	it("fails closed when there is no fresh authenticated context", async () => {
		const { AuthContextError } = await import("@/lib/auth/tenancy");
		fake.context.mockRejectedValue(
			new AuthContextError(401, "Authentication required"),
		);
		expect((await del()).status).toBe(401);
		expect(fake.tenant).not.toHaveBeenCalled();
	});
	it("organization administrators revoke scoped tokens", async () => {
		expect((await del()).status).toBe(204);
		expect(fake.tenant).toHaveBeenCalledWith(ORG);
		expect(fake.updateMany.mock.calls[0]?.[0].where).toEqual({
			id: ID,
			revokedAt: null,
		});
	});
	it("a token can revoke only itself", async () => {
		fake.context.mockResolvedValue({
			organizationId: ORG,
			actor: `token:${ID}`,
			role: "VIEWER",
		});
		expect((await del()).status).toBe(204);
		fake.context.mockResolvedValue({
			organizationId: ORG,
			actor: `token:${USER}`,
			role: "ADMIN",
		});
		expect((await del()).status).toBe(403);
	});
	it("already-revoked is idempotent and unknown/cross-org id is 404", async () => {
		fake.updateMany.mockResolvedValue({ count: 0 });
		expect((await del()).status).toBe(204);
		fake.findUnique.mockResolvedValue(null);
		expect((await del()).status).toBe(404);
	});
	it("view-as cannot mutate tokens even when the target is ADMIN", async () => {
		fake.context.mockResolvedValue({
			organizationId: ORG,
			actor: `user:${USER}`,
			role: "ADMIN",
			isImpersonating: true,
		});
		expect((await del()).status).toBe(403);
		expect(fake.tenant).not.toHaveBeenCalled();
	});
});
