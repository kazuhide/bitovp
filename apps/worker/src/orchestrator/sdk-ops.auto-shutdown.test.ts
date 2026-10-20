import { afterEach, describe, expect, it, vi } from "vitest";
import { type AuditRecorder, createBitmovinSdkOps } from "./sdk-ops";

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("real SDK running Live automatic stop transport", () => {
	it.each([
		{},
		{
			bytesReadTimeoutSeconds: 30,
			streamTimeoutMinutes: 5,
			waitingForFirstConnectTimeoutMinutes: 5,
		},
	])("sends one full replacement via POST and preserves the accepted stop instant: %j", async (configuration) => {
		const accepted = {
			...configuration,
			scheduledShutdownAt: "2026-10-21T00:05:00.000Z",
		};
		const transport = vi.fn(
			async () =>
				new Response(
					JSON.stringify({ status: "SUCCESS", data: { result: accepted } }),
					{ status: 202, headers: { "content-type": "application/json" } },
				),
		);
		vi.stubGlobal("fetch", transport);
		const audit = vi.fn<AuditRecorder>(async () => undefined);
		const ops = createBitmovinSdkOps(
			{
				apiKey: "fixture-only",
				tenantOrgId: "fixture-org",
				bitmovinAccountId: "fixture-account",
			},
			audit,
		);
		await expect(
			ops.updateLiveAutoShutdown("encoding-owned", configuration),
		).resolves.toEqual({
			configuration,
			scheduledShutdownAt: accepted.scheduledShutdownAt,
		});
		expect(transport).toHaveBeenCalledTimes(1);
		const [url, init] = transport.mock.calls[0] as unknown as [
			string,
			RequestInit,
		];
		expect(new URL(url).pathname).toBe(
			"/v1/encoding/encodings/encoding-owned/live/update-autoshutdown-config",
		);
		expect(init.method).toBe("POST");
		expect(JSON.parse(init.body as string)).toEqual(configuration);
		expect(new Headers(init.headers).get("X-Tenant-Org-Id")).toBe(
			"fixture-org",
		);
		expect(audit.mock.calls[0]?.[0]).toMatchObject({
			method: "POST",
			request: configuration,
			response: { configuration },
		});
	});

	it("never retries a lost response, since another send would restart the runtime timer", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const transport = vi.fn(async () => {
			throw new Error("socket closed");
		});
		vi.stubGlobal("fetch", transport);
		const ops = createBitmovinSdkOps(
			{ apiKey: "fixture-only" },
			async () => undefined,
		);
		await expect(
			ops.updateLiveAutoShutdown("encoding-owned", { streamTimeoutMinutes: 5 }),
		).rejects.toThrow();
		expect(transport).toHaveBeenCalledTimes(1);
		expect(warn).not.toHaveBeenCalled();
	});

	it("does not silently accept a provider response that differs from the complete request", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							status: "SUCCESS",
							data: { result: { streamTimeoutMinutes: 8 } },
						}),
						{ status: 202, headers: { "content-type": "application/json" } },
					),
			),
		);
		const ops = createBitmovinSdkOps(
			{ apiKey: "fixture-only" },
			async () => undefined,
		);
		await expect(
			ops.updateLiveAutoShutdown("encoding-owned", { streamTimeoutMinutes: 5 }),
		).rejects.toThrow("accepted configuration");
	});
});
