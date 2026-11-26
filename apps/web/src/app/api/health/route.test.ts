import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { countUsers } = vi.hoisted(() => ({ countUsers: vi.fn() }));
vi.mock("@bitovp/db", () => ({
	getIdentityPrisma: () => ({ user: { count: countUsers } }),
}));
/**
 * : the health route is the runtime half of the SDK-external
 * guard. Three pins:
 *  - the REAL probe passes in this environment (the SDK is installed and
 *    resolvable — exercises the actual import + interop shape check);
 *  - a failing probe turns health into 503 "degraded" carrying the reason;
 *  - a passing probe keeps the pre-#78 contract (200, status "ok", no sdk
 *    key) that the verify smoke's first step reads.
 */
describe("GET /api/health — ledger #78 deployment gate", () => {
	beforeEach(() => {
		countUsers.mockReset().mockResolvedValue(1);
	});
	afterEach(() => {
		vi.resetModules();
		vi.doUnmock("@/lib/server/sdk-probe");
	});

	it("the real probe resolves the installed SDK (no mock)", async () => {
		const { probeSdkExternal, resetSdkProbeForTests } = await import(
			"@/lib/server/sdk-probe"
		);
		resetSdkProbeForTests();
		expect(await probeSdkExternal()).toBeNull();
	});

	it("answers 200 ok without an sdk key when the probe passes", async () => {
		vi.doMock("@/lib/server/sdk-probe", () => ({
			probeSdkExternal: async () => null,
		}));
		const { GET } = await import("./route");
		const res = await GET();
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.status).toBe("ok");
		expect(body).not.toHaveProperty("sdk");
		expect(countUsers).toHaveBeenCalledOnce();
	});

	it("answers 503 degraded WITH the named cause when the probe fails", async () => {
		vi.doMock("@/lib/server/sdk-probe", () => ({
			probeSdkExternal: async () =>
				"@bitmovin/api-sdk failed to resolve at runtime: shim missing",
		}));
		const { GET } = await import("./route");
		const res = await GET();
		expect(res.status).toBe(503);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.status).toBe("degraded");
		expect(body.sdk).toContain("shim missing");
	});

	it("rejects an unreachable bundled Prisma engine without exposing its diagnostics", async () => {
		vi.doMock("@/lib/server/sdk-probe", () => ({
			probeSdkExternal: async () => null,
		}));
		const { GET } = await import("./route");
		const error = new Error(
			"Engine missing at /private/build; postgresql://user:secret@host/db",
		);
		error.name = "PrismaClientInitializationError";
		countUsers.mockRejectedValueOnce(error);
		const result = await GET();
		expect(result.status).toBe(503);
		const body = await result.json();
		expect(body).toMatchObject({ status: "degraded", database: "unavailable" });
		expect(JSON.stringify(body)).not.toMatch(/private|secret|postgresql/);
	});

	it("checks the database again after recovery", async () => {
		vi.doMock("@/lib/server/sdk-probe", () => ({
			probeSdkExternal: async () => null,
		}));
		const { GET } = await import("./route");
		countUsers.mockRejectedValueOnce(new Error("offline"));
		expect((await GET()).status).toBe(503);
		expect((await GET()).status).toBe(200);
	});
});
