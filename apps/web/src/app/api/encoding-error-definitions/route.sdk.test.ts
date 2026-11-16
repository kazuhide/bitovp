import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getAccount, revealApiKey } = vi.hoisted(() => ({
	getAccount: vi.fn(),
	revealApiKey: vi.fn(),
}));
vi.mock("@/lib/server/context", () => ({
	getServerContext: async () => ({
		bitmovinAccounts: { get: getAccount, revealApiKey },
	}),
}));

import { GET } from "./route";

const ID = "3f1f0e8e-2c5b-4a4e-9a64-0f6f4d2c9b11";
const req = () =>
	new Request(
		`http://test/api/encoding-error-definitions?bitmovinAccountId=${ID}`,
	);
const providerResponse = (result: unknown) =>
	Response.json({ status: "SUCCESS", data: { result } });

beforeEach(() => {
	vi.resetAllMocks();
	getAccount.mockResolvedValue({ id: ID, tenantOrgId: "fixture-tenant" });
	revealApiKey.mockResolvedValue("synthetic-test-key");
});
afterEach(() => vi.unstubAllGlobals());

describe("Error Definitions through the installed SDK transport", () => {
	it("uses GET, pagination and the selected tenant headers with the real SDK", async () => {
		const transport = vi.fn(async () =>
			providerResponse({
				totalCount: 1,
				offset: 0,
				items: [
					{
						code: 1001,
						category: "INPUT",
						message: "Input {1}",
						retryHint: "RETRY_IN_DIFFERENT_REGION",
					},
				],
			}),
		);
		vi.stubGlobal("fetch", transport);
		const response = await GET(req());
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			totalCount: 1,
			items: [
				{
					code: 1001,
					category: "INPUT",
					message: "Input {1}",
					retryHint: "RETRY_IN_DIFFERENT_REGION",
				},
			],
		});
		expect(transport).toHaveBeenCalledOnce();
		const [url, init] = transport.mock.calls[0] as unknown as [
			string,
			RequestInit,
		];
		expect(new URL(url).origin).toBe("https://api.bitmovin.com");
		expect(new URL(url).pathname).toBe("/v1/encoding/error-definitions");
		expect(Object.fromEntries(new URL(url).searchParams)).toEqual({
			limit: "100",
			offset: "0",
		});
		expect(init.method).toBe("GET");
		expect(init.body).toBeUndefined();
		expect(new Headers(init.headers).get("X-Api-Key")).toBe(
			"synthetic-test-key",
		);
		expect(new Headers(init.headers).get("X-Tenant-Org-Id")).toBe(
			"fixture-tenant",
		);
		expect(init.signal).toBeInstanceOf(AbortSignal);
	});

	it("refuses absent data.result instead of reporting an empty catalogue", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ status: "SUCCESS" })),
		);
		expect((await GET(req())).status).toBe(502);
	});

	it("refuses malformed provider item types after SDK model mapping", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				providerResponse({ totalCount: 1, items: [{ code: "1001" }] }),
			),
		);
		expect((await GET(req())).status).toBe(502);
	});
});
