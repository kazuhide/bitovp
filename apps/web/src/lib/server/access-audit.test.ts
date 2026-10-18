import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthenticatedContext } from "@/lib/auth/tenancy";

const mocks = vi.hoisted(() => ({ create: vi.fn(), ip: vi.fn() }));
vi.mock("@bitovp/db", () => ({
	getTenantPrisma: () => ({ accessEvent: { create: mocks.create } }),
}));
vi.mock("@/lib/auth/ip-policy", () => ({ verifiedClientIp: mocks.ip }));

import { recordAccessNonAdmin } from "./access-audit";

const context = {
	organizationId: "00000000-0000-4000-8000-000000000002",
	actorUserId: "00000000-0000-4000-8000-000000000003",
	effectiveUserId: "00000000-0000-4000-8000-000000000003",
	role: "OPERATOR",
	actorRole: "OPERATOR",
	platformOwner: false,
	isImpersonating: false,
	organizationName: "Test",
	targetDisplayName: null,
	actor: "user:00000000-0000-4000-8000-000000000003",
	user: { displayName: "Test user" },
} as AuthenticatedContext;
const request = {
	method: "GET",
	url: "http://localhost/vod?secret=hidden",
	headers: new Headers(),
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.create.mockResolvedValue({});
	mocks.ip.mockReturnValue("192.0.2.1");
});
describe("non-admin access history", () => {
	it("records who, when-by-DB, path and decision without query data", async () => {
		await recordAccessNonAdmin(context, request, 200);
		expect(mocks.create).toHaveBeenCalledWith({
			data: {
				userId: context.actorUserId,
				actor: context.actor,
				userDisplayName: "Test user",
				method: "GET",
				path: "/vod",
				clientIp: "192.0.2.1",
				statusCode: 200,
			},
		});
	});
	it.each([
		{ platformOwner: true },
		{ actorRole: "ADMIN", role: "OPERATOR" },
		{ isImpersonating: true },
	])("never writes admin or view-as traffic: %j", async (change) => {
		await recordAccessNonAdmin(
			{ ...context, ...change } as AuthenticatedContext,
			request,
			200,
		);
		expect(mocks.create).not.toHaveBeenCalled();
	});
	it("omits background API reads but records mutations", async () => {
		await recordAccessNonAdmin(
			context,
			{ ...request, url: "http://localhost/api/vod" },
			200,
		);
		expect(mocks.create).not.toHaveBeenCalled();
		await recordAccessNonAdmin(
			context,
			{ ...request, method: "POST", url: "http://localhost/api/vod" },
			403,
		);
		expect(mocks.create).toHaveBeenCalledOnce();
	});
	it("propagates unavailable storage rather than silently losing access records", async () => {
		mocks.create.mockRejectedValue(new Error("unavailable"));
		await expect(recordAccessNonAdmin(context, request, 200)).rejects.toThrow(
			"unavailable",
		);
	});
});
