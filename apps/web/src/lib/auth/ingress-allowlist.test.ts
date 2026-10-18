import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@bitovp/db", () => ({
	getPrisma: () => {
		throw new Error("no database in this test");
	},
	readIngressSnapshot: async () => null,
}));

import {
	ingressHostname,
	resetIngressHostnameCache,
} from "./ingress-allowlist";

/**
 * The cache contract the proxy relies on (WP-G G-1): a warm hit costs no
 * read; a miss may refresh at most once per floor; a stale entry refreshes;
 * a database fault reads as "no ingress" (fail closed, never open).
 */
const T0 = 1_000_000;

beforeEach(() => {
	resetIngressHostnameCache();
});

describe("ingressHostname cache", () => {
	it("reads once, then serves a warm hit from cache", async () => {
		const read = vi.fn(async () => "abc.trycloudflare.com");
		expect(await ingressHostname("abc.trycloudflare.com", T0, read)).toBe(
			"abc.trycloudflare.com",
		);
		expect(
			await ingressHostname("abc.trycloudflare.com", T0 + 1_000, read),
		).toBe("abc.trycloudflare.com");
		expect(read).toHaveBeenCalledTimes(1);
	});

	it("a miss inside the floor is answered from cache; past the floor it refreshes", async () => {
		const read = vi
			.fn<() => Promise<string | null>>()
			.mockResolvedValueOnce("old.trycloudflare.com")
			.mockResolvedValueOnce("new.trycloudflare.com");
		await ingressHostname("old.trycloudflare.com", T0, read);
		// 2 s later: the new name misses, but the floor (5 s) says "no refresh yet".
		expect(
			await ingressHostname("new.trycloudflare.com", T0 + 2_000, read),
		).toBe("old.trycloudflare.com");
		expect(read).toHaveBeenCalledTimes(1);
		// 6 s later: past the floor — refresh, and the new name is now known.
		expect(
			await ingressHostname("new.trycloudflare.com", T0 + 6_000, read),
		).toBe("new.trycloudflare.com");
		expect(read).toHaveBeenCalledTimes(2);
	});

	it("a warm hit older than the TTL refreshes even without a miss", async () => {
		const read = vi
			.fn<() => Promise<string | null>>()
			.mockResolvedValueOnce("abc.trycloudflare.com")
			.mockResolvedValueOnce(null);
		await ingressHostname("abc.trycloudflare.com", T0, read);
		expect(
			await ingressHostname("abc.trycloudflare.com", T0 + 16_000, read),
		).toBe(null);
		expect(read).toHaveBeenCalledTimes(2);
	});

	it("a bounded flood of unknown hosts costs at most one read per floor window", async () => {
		const read = vi.fn(async () => null);
		for (let i = 0; i < 50; i += 1) {
			await ingressHostname(`evil-${i}.example`, T0 + i * 10, read);
		}
		expect(read).toHaveBeenCalledTimes(1);
	});

	it("the default reader fails CLOSED: a database fault is 'no ingress hostname'", async () => {
		// getPrisma throws in this file's mock — the default reader catches it.
		expect(await ingressHostname("abc.trycloudflare.com", T0)).toBeNull();
	});
});

describe("ingressHostname — concurrent cold misses (security-review #310 finding 3)", () => {
	it("ten concurrent cold misses share ONE read", async () => {
		resetIngressHostnameCache();
		let reads = 0;
		const read = () =>
			new Promise<string | null>((resolve) => {
				reads += 1;
				setTimeout(() => resolve("abc-def.trycloudflare.com"), 5);
			});
		const results = await Promise.all(
			Array.from({ length: 10 }, () =>
				ingressHostname("rebound.example", 1_000, read),
			),
		);
		expect(reads).toBe(1);
		expect(new Set(results)).toEqual(new Set(["abc-def.trycloudflare.com"]));
	});

	it("a rejected read does not wedge the next miss", async () => {
		resetIngressHostnameCache();
		const failing = () => Promise.reject(new Error("db down"));
		await expect(ingressHostname("x.example", 1_000, failing)).rejects.toThrow(
			"db down",
		);
		let reads = 0;
		const ok = () => {
			reads += 1;
			return Promise.resolve(null);
		};
		await expect(ingressHostname("x.example", 20_000, ok)).resolves.toBeNull();
		expect(reads).toBe(1);
	});
});
