import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
	vi.unstubAllGlobals();
	vi.resetModules();
});
describe("browser organization binding", () => {
	it("pins same-origin API requests, preserves caller headers/body, and ignores foreign origins", async () => {
		const original = vi.fn().mockResolvedValue(new Response("{}"));
		vi.stubGlobal("fetch", original);
		const { installTenantFetch } = await import("./tenant-fetch");
		installTenantFetch("org-A");
		await window.fetch("/api/encoding-jobs", {
			method: "POST",
			body: "payload",
			headers: { "x-custom": "yes", "x-bitovp-expected-org": "forged" },
		});
		const options = original.mock.calls[0]?.[1];
		expect(options.method).toBe("POST");
		expect(options.body).toBe("payload");
		expect(options.headers.get("x-bitovp-expected-org")).toBe("org-A");
		expect(options.headers.get("x-custom")).toBe("yes");
		installTenantFetch("org-B");
		await window.fetch("/api/library");
		expect(
			original.mock.calls[1]?.[1].headers.get("x-bitovp-expected-org"),
		).toBe("org-A");
		await window.fetch("https://example.test/api/check");
		expect(original.mock.calls[2]?.[1]).toBeUndefined();
	});
	it("does not fabricate users-mode scope before an authoritative response", async () => {
		const original = vi.fn();
		vi.stubGlobal("fetch", original);
		const { installTenantFetch } = await import("./tenant-fetch");
		installTenantFetch();
		expect(window.fetch).toBe(original);
		installTenantFetch("org-A");
		expect(window.fetch).not.toBe(original);
	});
});
