import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { verifiedClientIp } from "./ip-policy";

afterEach(() => vi.unstubAllEnvs());
describe("authenticated client IP proof", () => {
	it("refuses direct forged or unsigned IP headers", () => {
		vi.stubEnv("AUTH_SESSION_SECRET", "test-secret");
		expect(
			verifiedClientIp(new Headers({ "x-forwarded-for": "192.0.2.1" })),
		).toBeNull();
		expect(
			verifiedClientIp(
				new Headers({
					"x-bitovp-client-ip": "192.0.2.1",
					"x-bitovp-client-ip-proof": "0".repeat(64),
				}),
			),
		).toBeNull();
	});
	it("accepts only the signed address and refuses substitution", () => {
		vi.stubEnv("AUTH_SESSION_SECRET", "test-secret");
		const proof = createHmac("sha256", "test-secret")
			.update("client-ip\0" + "192.0.2.1")
			.digest("hex");
		const headers = new Headers({
			"x-bitovp-client-ip": "192.0.2.1",
			"x-bitovp-client-ip-proof": proof,
		});
		expect(verifiedClientIp(headers)).toBe("192.0.2.1");
		headers.set("x-bitovp-client-ip", "192.0.2.2");
		expect(verifiedClientIp(headers)).toBeNull();
	});
});
