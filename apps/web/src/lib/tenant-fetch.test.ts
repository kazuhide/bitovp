import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.resetModules();
});
const ORG = "00000000-0000-4000-8000-000000000010";
const RUN = "00000000-0000-4000-8000-000000000020";
const CHANNEL = "00000000-0000-4000-8000-000000000030";
const TELEMETRY = "/api/operation-attempts";
const accepted = () => new Response(null, { status: 204 });

async function startMoqOperation() {
	const { trackMoqPlaybackOperation } = await import(
		"./moq-player/operation-analytics"
	);
	return trackMoqPlaybackOperation(
		{ organizationId: ORG, channelId: CHANNEL, runId: RUN },
		performance.now(),
	);
}

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

	it.each([
		["/api/auth/logout", "POST"],
		["/api/account/organization", "POST"],
		["/api/account/impersonation", "POST"],
		["/api/account/impersonation", "DELETE"],
	])("settles an acknowledged operation before %s %s", async (path, method) => {
		vi.useFakeTimers();
		let acknowledge!: (response: Response) => void;
		const original = vi
			.fn()
			.mockResolvedValueOnce(accepted())
			.mockReturnValueOnce(
				new Promise<Response>((resolve) => {
					acknowledge = resolve;
				}),
			)
			.mockResolvedValue(accepted());
		vi.stubGlobal("fetch", original);
		const { installTenantFetch } = await import("./tenant-fetch");
		installTenantFetch(ORG);
		const finish = await startMoqOperation();
		await vi.advanceTimersByTimeAsync(0);

		const change = window.fetch(path, { method });
		expect(original.mock.calls.map(([url]) => url)).toEqual([
			TELEMETRY,
			TELEMETRY,
		]);
		const [, init] = original.mock.calls[1] ?? [];
		expect(init.headers.get("x-bitovp-expected-org")).toBe(ORG);
		expect(init.keepalive).toBe(true);
		expect(JSON.parse(init.body)).toMatchObject({ stage: "CANCELED" });
		finish?.("FIRST_FRAME");
		acknowledge(accepted());
		await change;
		expect(original.mock.calls.map(([url]) => url)).toEqual([
			TELEMETRY,
			TELEMETRY,
			path,
		]);
	});

	it("bounds the wait jointly for overlapping identity requests", async () => {
		vi.useFakeTimers();
		const original = vi
			.fn()
			.mockResolvedValueOnce(accepted())
			.mockReturnValueOnce(new Promise<Response>(() => {}))
			.mockResolvedValue(accepted());
		vi.stubGlobal("fetch", original);
		const { installTenantFetch } = await import("./tenant-fetch");
		installTenantFetch(ORG);
		await startMoqOperation();
		await vi.advanceTimersByTimeAsync(0);

		const logout = window.fetch("/api/auth/logout", { method: "POST" });
		const change = window.fetch("/api/account/organization", {
			method: "POST",
		});
		await vi.advanceTimersByTimeAsync(249);
		expect(original.mock.calls.map(([url]) => url)).toEqual([
			TELEMETRY,
			TELEMETRY,
		]);
		await vi.advanceTimersByTimeAsync(1);
		await Promise.all([logout, change]);
		expect(original.mock.calls.map(([url]) => url)).toEqual([
			TELEMETRY,
			TELEMETRY,
			"/api/auth/logout",
			"/api/account/organization",
		]);
	});

	it("sends an identity request immediately when no analytics operation exists", async () => {
		const original = vi.fn().mockResolvedValue(accepted());
		vi.stubGlobal("fetch", original);
		const { installTenantFetch } = await import("./tenant-fetch");
		installTenantFetch(ORG);
		const request = window.fetch("/api/auth/logout", { method: "POST" });
		expect(original).toHaveBeenCalledOnce();
		await request;
	});

	it("leaves a pending start unconfirmed without waiting through an identity change", async () => {
		vi.useFakeTimers();
		let acknowledge!: (response: Response) => void;
		const original = vi
			.fn()
			.mockReturnValueOnce(
				new Promise<Response>((resolve) => {
					acknowledge = resolve;
				}),
			)
			.mockResolvedValue(accepted());
		vi.stubGlobal("fetch", original);
		const { installTenantFetch } = await import("./tenant-fetch");
		installTenantFetch(ORG);
		const finish = await startMoqOperation();
		const change = window.fetch("/api/account/organization", {
			method: "POST",
		});
		expect(original).toHaveBeenCalledTimes(2);
		await change;
		acknowledge(accepted());
		await vi.advanceTimersByTimeAsync(0);
		finish?.("FIRST_FRAME");
		expect(original.mock.calls.map(([url]) => url)).toEqual([
			TELEMETRY,
			"/api/account/organization",
		]);
	});
});
