import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
	requireAdmin: vi.fn(),
	find: vi.fn(),
	count: vi.fn(),
	update: vi.fn(),
	transaction: vi.fn(),
}));
vi.mock("@bitovp/db", () => ({
	getIdentityPrisma: () => ({ $transaction: fake.transaction }),
}));
vi.mock("@/lib/auth/tenancy", async () => {
	const actual =
		await vi.importActual<typeof import("@/lib/auth/tenancy")>(
			"@/lib/auth/tenancy",
		);
	return { ...actual, requireOrganizationAdmin: fake.requireAdmin };
});

import { PATCH } from "./route";

const ORG = "00000000-0000-4000-8000-000000000001";
const USER = "11111111-2222-4333-8444-555555555555";
function patch(body: object, id = USER) {
	return PATCH(
		new Request(`http://localhost/api/users/${id}`, {
			method: "PATCH",
			body: JSON.stringify(body),
		}),
		{ params: Promise.resolve({ id }) },
	);
}
beforeEach(() => {
	vi.clearAllMocks();
	fake.requireAdmin.mockResolvedValue({
		organizationId: ORG,
		actorUserId: USER,
		role: "ADMIN",
	});
	fake.find.mockResolvedValue({
		userId: USER,
		organizationId: ORG,
		active: true,
		role: "ADMIN",
	});
	fake.count.mockResolvedValue(1);
	fake.update.mockImplementation(async ({ data }) => ({
		role: data.role ?? "ADMIN",
		active: data.active ?? true,
		user: {
			id: USER,
			email: "one@example.com",
			displayName: "One",
			mustChangePassword: false,
		},
	}));
	fake.transaction.mockImplementation(async (callback) =>
		callback({
			membership: {
				findUnique: fake.find,
				count: fake.count,
				update: fake.update,
			},
		}),
	);
});
describe("organization membership editing", () => {
	it("demotes only this organization's membership, leaving global credentials untouched", async () => {
		expect((await patch({ role: "VIEWER" })).status).toBe(200);
		expect(fake.update.mock.calls[0]?.[0]).toMatchObject({
			where: { userId_organizationId: { userId: USER, organizationId: ORG } },
			data: { role: "VIEWER" },
		});
		expect(JSON.stringify(fake.update.mock.calls)).not.toMatch(
			/password|sessionGeneration|sessionsValidFrom/,
		);
	});
	it("counts other active admins in the same organization inside the serializable transaction", async () => {
		await patch({ active: false });
		expect(fake.count).toHaveBeenCalledWith({
			where: {
				organizationId: ORG,
				active: true,
				role: "ADMIN",
				userId: { not: USER },
				user: { active: true },
			},
		});
		expect(fake.transaction.mock.calls[0]?.[1]).toEqual({
			isolationLevel: "Serializable",
		});
	});
	it("refuses removing the last active org administrator", async () => {
		fake.count.mockResolvedValue(0);
		expect((await patch({ role: "OPERATOR" })).status).toBe(409);
		expect(fake.update).not.toHaveBeenCalled();
	});
	it("does not permit an administrator to mutate a user without this org's membership", async () => {
		fake.find.mockResolvedValue(null);
		expect((await patch({ active: false })).status).toBe(403);
		expect(fake.update).not.toHaveBeenCalled();
	});
	it("rejects global password reset and display-name changes at this surface", async () => {
		expect((await patch({ resetPassword: true })).status).toBe(400);
		expect((await patch({ displayName: "Changed" })).status).toBe(400);
		expect(fake.transaction).not.toHaveBeenCalled();
	});
	it("re-reads the target's role within the write snapshot", async () => {
		fake.find.mockResolvedValue({ active: true, role: "VIEWER" });
		fake.count.mockResolvedValue(0);
		expect((await patch({ active: false })).status).toBe(200);
		expect(fake.count).not.toHaveBeenCalled();
	});
	it("refuses legacy password/none actors from membership management", async () => {
		fake.requireAdmin.mockResolvedValue({
			organizationId: ORG,
			actorUserId: null,
			role: "ADMIN",
		});
		expect((await patch({ role: "ADMIN" })).status).toBe(403);
		expect(fake.transaction).not.toHaveBeenCalled();
	});
	it("refuses non-admin/view-as contexts before any write", async () => {
		const { AuthContextError } = await import("@/lib/auth/tenancy");
		fake.requireAdmin.mockRejectedValue(new AuthContextError(403, "Forbidden"));
		expect((await patch({ active: false })).status).toBe(403);
		expect(fake.transaction).not.toHaveBeenCalled();
	});
	it("maps serialization races to retryable conflict", async () => {
		fake.transaction.mockRejectedValue({ code: "P2034" });
		expect((await patch({ role: "VIEWER" })).status).toBe(409);
	});
});
