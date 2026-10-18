import { describe, expect, it } from "vitest";
import {
	connectionClientIp,
	ingressHeaders,
} from "../../../runtime/ip-forwarding";

describe("socket-based ingress", () => {
	it("ignores spoofed forwarding from a direct client", () => {
		expect(connectionClientIp("203.0.113.7", "192.0.2.1", [])).toBe(
			"203.0.113.7",
		);
		expect(connectionClientIp("203.0.113.7", "192.0.2.1", ["10.0.0.0/8"])).toBe(
			"203.0.113.7",
		);
	});
	it("walks only trusted proxies from the socket side", () => {
		expect(
			connectionClientIp("10.0.0.4", "192.0.2.8, 10.0.0.3", ["10.0.0.0/8"]),
		).toBe("192.0.2.8");
		expect(
			connectionClientIp("10.0.0.4", "192.0.2.8, 203.0.113.4", ["10.0.0.0/8"]),
		).toBe("203.0.113.4");
		expect(
			connectionClientIp("10.0.0.4", "malformed", ["10.0.0.0/8"]),
		).toBeNull();
		expect(
			connectionClientIp("10.0.0.4", undefined, ["10.0.0.0/8"]),
		).toBeNull();
	});
	it("replaces caller proofs with a proof of the real normalized address", () => {
		const headers = ingressHeaders(
			{
				"x-bitovp-client-ip": "192.0.2.1",
				"x-bitovp-client-ip-proof": "forged",
				"x-forwarded-for": "192.0.2.1",
				"x-real-ip": "192.0.2.1",
			},
			"::ffff:203.0.113.7",
			"test-secret",
			[],
		);
		expect(headers["x-bitovp-client-ip"]).toBe("203.0.113.7");
		expect(headers["x-forwarded-for"]).toBe("203.0.113.7");
		expect(headers["x-bitovp-client-ip-proof"]).toMatch(/^[a-f0-9]{64}$/);
		expect(headers["x-real-ip"]).toBeUndefined();
	});
	it("does not manufacture trusted identity without a socket or signing key", () => {
		expect(
			ingressHeaders(
				{ "x-bitovp-client-ip": "forged" },
				undefined,
				"test-secret",
				[],
			)["x-bitovp-client-ip"],
		).toBeUndefined();
		expect(
			ingressHeaders({}, "192.0.2.1", undefined, [])[
				"x-bitovp-client-ip-proof"
			],
		).toBeUndefined();
	});
});
