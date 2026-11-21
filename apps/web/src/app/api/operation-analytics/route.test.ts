import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	admin: vi.fn(),
	prisma: vi.fn(),
	readFlags: vi.fn(),
	readWeeks: vi.fn(),
}));

vi.mock("@bitovp/db", () => ({ getTenantPrisma: mocks.prisma }));
vi.mock("@/lib/auth/tenancy", async (original) => ({
	...(await original<typeof import("@/lib/auth/tenancy")>()),
	requireOrganizationAdmin: mocks.admin,
}));
vi.mock("@/lib/server/feature-flags", () => ({
	readFeatureFlags: async () => ({ operationAnalytics: false }),
	readStoredFeatureFlags: mocks.readFlags,
}));
vi.mock("@/lib/server/operation-analytics", () => ({
	readWeeklyOperationAnalytics: mocks.readWeeks,
}));

import { AuthContextError } from "@/lib/auth/tenancy";
import { GET } from "./route";

const organizationId = "00000000-0000-4000-8000-000000000111";
const foreignId = "00000000-0000-4000-8000-000000000222";
const url = "https://bitovp.example.test/api/operation-analytics";

describe("GET /api/operation-analytics", () => {
	beforeEach(() => {
		vi.resetAllMocks();
	});

	it.each([
		401, 403, 409,
	] as const)("returns %d without opening a tenant client when the organization admin check fails", async (status) => {
		mocks.admin.mockRejectedValue(new AuthContextError(status, "Denied"));
		const response = await GET(new Request(url));
		expect(response.status).toBe(status);
		expect(response.headers.get("cache-control")).toBe("private, no-store");
		expect(mocks.prisma).not.toHaveBeenCalled();
		expect(mocks.readWeeks).not.toHaveBeenCalled();
	});

	it("only reads the verified tenant and returns history while collection is paused", async () => {
		const prisma = {};
		const weeks = [{ weekStart: "2026-11-16", started: 2 }];
		mocks.admin.mockResolvedValue({ organizationId });
		mocks.prisma.mockReturnValue(prisma);
		mocks.readFlags.mockResolvedValue({ operationAnalytics: false });
		mocks.readWeeks.mockResolvedValue(weeks);
		const request = new Request(`${url}?organizationId=${foreignId}`);
		const response = await GET(request);
		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("private, no-store");
		expect(await response.json()).toEqual({ weeks, isCollecting: false });
		expect(mocks.admin).toHaveBeenCalledWith(request.headers);
		expect(mocks.prisma).toHaveBeenCalledExactlyOnceWith(organizationId, {
			readOnly: true,
		});
		expect(mocks.readFlags).toHaveBeenCalledExactlyOnceWith(prisma);
		expect(mocks.readWeeks).toHaveBeenCalledExactlyOnceWith(
			prisma,
			organizationId,
		);
	});

	it("returns an uncached error when the aggregate is available but settings cannot be read", async () => {
		const prisma = {};
		mocks.admin.mockResolvedValue({ organizationId });
		mocks.prisma.mockReturnValue(prisma);
		mocks.readWeeks.mockResolvedValue([
			{ weekStart: "2026-11-16", started: 2 },
		]);
		mocks.readFlags.mockRejectedValue(new Error("Settings read failed"));

		const response = await GET(new Request(url));
		expect(response.status).toBe(503);
		expect(response.headers.get("cache-control")).toBe("private, no-store");
		expect(await response.json()).not.toHaveProperty("isCollecting");
		expect(mocks.readFlags).toHaveBeenCalledExactlyOnceWith(prisma);
	});
});
