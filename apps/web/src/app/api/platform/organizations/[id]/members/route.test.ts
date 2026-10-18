import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
	owner: vi.fn(),
	organization: vi.fn(),
	members: vi.fn(),
}));
vi.mock("@bitovp/db", () => ({
	getIdentityPrisma: () => ({
		organization: { findUnique: fake.organization },
		membership: { findMany: fake.members },
	}),
}));
vi.mock("@/lib/auth/tenancy", async () => ({
	...(await vi.importActual<typeof import("@/lib/auth/tenancy")>(
		"@/lib/auth/tenancy",
	)),
	requirePlatformOwner: fake.owner,
}));

import { GET } from "./route";

const ORG = "00000000-0000-4000-8000-000000000001";
const get = () =>
	GET(
		new Request(`http://localhost/api/platform/organizations/${ORG}/members`),
		{ params: Promise.resolve({ id: ORG }) },
	);
beforeEach(() => {
	vi.clearAllMocks();
	fake.owner.mockResolvedValue({ user: { platformOwner: true } });
	fake.organization.mockResolvedValue({ active: true });
	fake.members.mockResolvedValue([
		{
			role: "VIEWER",
			user: {
				id: ORG,
				displayName: "Target",
				email: "target@example.com",
				active: true,
			},
		},
	]);
});
describe("owner target identity inventory", () => {
	it("returns active human targets only, independently of current-org data scope", async () => {
		const res = await get();
		expect(res.status).toBe(200);
		expect(res.headers.get("cache-control")).toContain("no-store");
		expect(await res.json()).toEqual([
			{
				id: ORG,
				displayName: "Target",
				email: "target@example.com",
				active: true,
				role: "VIEWER",
			},
		]);
		expect(fake.members.mock.calls[0]?.[0].where).toEqual({
			organizationId: ORG,
			active: true,
			user: { active: true, mustChangePassword: false },
		});
		expect(
			fake.members.mock.calls[0]?.[0].select.user.select,
		).not.toHaveProperty("passwordHash");
	});
	it("org administrators and owner view-as sessions fail the independent owner guard", async () => {
		const { AuthContextError } = await import("@/lib/auth/tenancy");
		fake.owner.mockRejectedValue(new AuthContextError(403, "Owner required"));
		expect((await get()).status).toBe(403);
		expect(fake.members).not.toHaveBeenCalled();
	});
	it("does not offer targets in inactive or missing organizations", async () => {
		fake.organization.mockResolvedValue({ active: false });
		expect((await get()).status).toBe(404);
		expect(fake.members).not.toHaveBeenCalled();
	});
});
