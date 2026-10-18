import { describe, expect, it } from "vitest";
import {
	ipAllowedByPolicy,
	normalizeClientIp,
	validateIpCidrs,
} from "./ip-policy";

describe("organization IP authorization", () => {
	it("matches only allowed addresses and rejects unknown identities", () => {
		expect(ipAllowedByPolicy(["192.0.2.0/24"], "192.0.2.255")).toBe(true);
		expect(ipAllowedByPolicy(["192.0.2.0/24"], "192.0.3.0")).toBe(false);
		expect(ipAllowedByPolicy(["192.0.2.1"], "192.0.2.2")).toBe(false);
		expect(ipAllowedByPolicy(["192.0.2.0/24"], null)).toBe(false);
		expect(ipAllowedByPolicy([], null)).toBe(true);
	});
	it("normalizes IPv6 and IPv4-mapped clients without broadening ranges", () => {
		expect(normalizeClientIp("::ffff:192.0.2.7")).toBe("192.0.2.7");
		expect(normalizeClientIp("::ffff:c000:207")).toBe("192.0.2.7");
		expect(ipAllowedByPolicy(["192.0.2.0/24"], "::ffff:192.0.2.7")).toBe(true);
		expect(ipAllowedByPolicy(["2001:db8::/32"], "2001:db8:abcd::1")).toBe(true);
		expect(ipAllowedByPolicy(["2001:db8::/32"], "2001:db9::1")).toBe(false);
		expect(ipAllowedByPolicy(["::1/128"], "::2")).toBe(false);
	});
	it.each([
		"192.0.2.1/33",
		"2001:db8::/129",
		"evil.example",
		"127.1",
		"01.2.3.4",
		"1.2.3.4:80",
		"fe80::1%en0",
		"::ffff:192.0.2.1/64",
		":::1",
		"2001:db8::1::2",
	])("rejects malformed allowlist entries: %s", (value) => {
		expect(validateIpCidrs([value])).toBe(false);
		expect(ipAllowedByPolicy([value], "192.0.2.1")).toBe(false);
	});
	it("handles range boundaries and mixed address families", () => {
		expect(ipAllowedByPolicy(["0.0.0.0/0"], "255.255.255.255")).toBe(true);
		expect(ipAllowedByPolicy(["0.0.0.0/0"], "2001:db8::1")).toBe(false);
		expect(ipAllowedByPolicy(["2001:db8::/64"], "2001:db8:0:1::")).toBe(false);
		expect(validateIpCidrs(["192.0.2.0/24", "2001:db8::/32"])).toBe(true);
	});
});
