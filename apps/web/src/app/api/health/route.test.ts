import { afterEach, describe, expect, it, vi } from "vitest";

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
});
