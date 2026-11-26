import type { AppPrismaClient } from "@bitovp/db";
import { afterEach, expect, it, vi } from "vitest";
import { auditedOperationCases } from "../../../../scripts/api-coverage-test-cases";
import { makeWorkerSdk } from "./make-sdk";

afterEach(() => vi.unstubAllGlobals());

const formats = ["hls", "dash", "smooth"] as const;
const manifestId = "00000000-0000-4000-8000-0000000000ab";

it.each(
	auditedOperationCases(
		import.meta.url,
		"worker-standalone-manifest-stop",
		formats,
		(format) => [`POST /encoding/manifests/${format}/{manifest_id}/stop`],
	),
)("sends the official %s manifest stop once via the worker SDK", async (format) => {
	const audit = vi.fn(async () => {});
	const fetch = vi.fn(async (_raw: string, _init: RequestInit) => {
		throw new TypeError("synthetic lost stop reply");
	});
	vi.stubGlobal("fetch", fetch);
	const sdk = makeWorkerSdk({
		auditLog: { create: audit },
	} as unknown as AppPrismaClient)({
		apiKey: "synthetic-only",
		bitmovinAccountId: "fixture-account",
		tenantOrgId: "fixture-org",
		withholdProviderDetails: true,
	});
	await expect(sdk.stopManifest(format, manifestId)).rejects.toThrow();
	expect(fetch).toHaveBeenCalledOnce();
	const call = fetch.mock.calls[0];
	if (!call) throw new Error("Missing manifest stop request");
	const [raw, init] = call;
	const url = new URL(raw);
	expect(url.origin).toBe("https://api.bitmovin.com");
	expect(url.pathname).toBe(
		`/v1/encoding/manifests/${format}/${manifestId}/stop`,
	);
	expect(init.method).toBe("POST");
	expect(new Headers(init.headers).get("X-Tenant-Org-Id")).toBe("fixture-org");
	expect(audit).toHaveBeenCalledWith(
		expect.objectContaining({
			data: expect.objectContaining({
				method: "POST",
				path: `/encoding/manifests/${format}/${manifestId}/stop`,
				bitmovinAccountId: "fixture-account",
			}),
		}),
	);
});

it.each(
	auditedOperationCases(
		import.meta.url,
		"worker-smooth-manifest-owner",
		["smooth"] as const,
		() => ["GET /encoding/manifests/smooth/{manifest_id}/customData"],
	),
)("reads the official %s manifest owner marker via the worker SDK", async (format) => {
	const fetch = vi.fn(async (raw: string, init: RequestInit) => {
		expect(new URL(raw).pathname).toBe(
			`/v1/encoding/manifests/${format}/${manifestId}/customData`,
		);
		expect(init.method).toBe("GET");
		expect(new Headers(init.headers).get("X-Tenant-Org-Id")).toBe(
			"fixture-org",
		);
		return Response.json({
			data: {
				result: {
					customData: {
						bitovp: { job: "fixture-job", step: "manifest:smooth" },
					},
				},
			},
		});
	});
	vi.stubGlobal("fetch", fetch);
	const sdk = makeWorkerSdk({
		auditLog: { create: vi.fn() },
	} as unknown as AppPrismaClient)({
		apiKey: "synthetic-only",
		bitmovinAccountId: "fixture-account",
		tenantOrgId: "fixture-org",
		withholdProviderDetails: true,
	});
	await expect(
		sdk.ownsManifest(format, manifestId, "fixture-job", "manifest:smooth"),
	).resolves.toBe(true);
	expect(fetch).toHaveBeenCalledOnce();
});
