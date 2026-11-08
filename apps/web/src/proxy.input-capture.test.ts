import { createInputCaptureCredentials } from "@bitovp/core";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ ingress: vi.fn(async () => null) }));
vi.mock("@/lib/auth/ingress-allowlist", () => ({
	ingressHostname: state.ingress,
}));
vi.mock("@bitovp/db", () => ({
	getIdentityPrisma: () => {
		throw new Error("No unscoped DB access");
	},
}));
vi.mock("@/lib/server/access-audit", () => ({
	recordAccessNonAdmin: async () => {},
}));

import { proxy } from "./proxy";

const org = "00000000-0000-4000-8000-000000000001";
const receipt = "00000000-0000-4000-8000-000000000002";
const secret = "test-capture-key-0123456789abcdef0123456789";
const path = `/api/encoding-input-captures/${receipt}/content`;
function request(target = path, method = "GET", signed = true) {
	const auth = createInputCaptureCredentials({
		secret,
		organizationId: org,
		receiptId: receipt,
		expiresAt: Math.floor(Date.now() / 1000) + 3600,
	});
	return new NextRequest(`https://capture.example.test${target}`, {
		method,
		headers: {
			host: "capture.example.test",
			...(signed
				? {
						authorization: `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString("base64")}`,
					}
				: {}),
			"x-bitovp-organization": org,
			"x-bitovp-actor": "user:forged",
		},
	});
}
beforeEach(() => {
	vi.stubEnv("BITOVP_CAPTURE_INPUT_BASE_URL", "https://capture.example.test");
	vi.stubEnv("BITOVP_CAPTURE_INPUT_SECRET", secret);
	vi.stubEnv("AUTH_MODE", "password");
	state.ingress.mockClear();
});
afterEach(() => {
	vi.unstubAllEnvs();
});
describe("proxy limits the provider gateway to signed exact reads", () => {
	it.each([
		"GET",
		"HEAD",
	])("forwards a signed %s with forged identity headers removed", async (method) => {
		const response = await proxy(request(path, method));
		expect(response.status).toBe(200);
		expect(response.headers.get("x-middleware-next")).toBe("1");
		expect(response.headers.get("x-middleware-request-x-bitovp-actor")).toBe(
			"anonymous",
		);
		expect(
			response.headers.get("x-middleware-request-x-bitovp-organization"),
		).toBeNull();
		expect(state.ingress).not.toHaveBeenCalled();
	});
	it("refuses unsigned gateway reads before any auth context lookup", async () => {
		const response = await proxy(request(path, "GET", false));
		expect(response.status).toBe(401);
	});
	it.each([
		[path, "POST"],
		[`${path}/suffix`, "GET"],
		[`${path}/`, "GET"],
		["/api/credentials", "GET"],
		["/dashboard", "GET"],
	])("does not exempt %s %s on the capture hostname", async (target, method) => {
		const response = await proxy(request(target, method));
		expect(response.status).toBe(403);
		expect(response.headers.get("x-middleware-next")).toBeNull();
	});
	it("does not turn the capture hostname into a general public origin", async () => {
		vi.stubEnv("AUTH_MODE", "none");
		const response = await proxy(request("/api/encoding-jobs", "GET"));
		expect(response.status).toBe(403);
	});
});
