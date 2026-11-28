import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GET } from "./route";

const { reveal, transport } = vi.hoisted(() => ({
	reveal: vi.fn(),
	transport: vi.fn(),
}));
vi.mock("@/lib/server/context", () => ({
	getServerContext: async () => ({
		bitmovinAccounts: { revealForEncoding: reveal },
		tenant: { role: "ADMIN" },
	}),
}));

const account = "00000000-0000-4000-8000-000000000001";
const organization = "00000000-0000-4000-8000-000000000002";
const id = "00000000-0000-4000-8000-000000000003";
const createdAt = "2026-11-20T12:15:00Z";
const row = {
	id,
	type: "SMOOTH_STREAMING",
	createdAt,
	outputs: [{ outputPath: "PRIVATE_VALUE" }],
	customData: { token: "PRIVATE_VALUE" },
};
const request = (params = "") =>
	new Request(
		`http://fixture.invalid/api/encoding-native/manifests?bitmovinAccountId=${account}${params}`,
	);
const result = (value: unknown, status = "SUCCESS") =>
	Response.json({ status, data: { result: value } });

beforeEach(() => {
	reveal
		.mockReset()
		.mockResolvedValue({ apiKey: "fixture", tenantOrgId: organization });
	transport.mockReset();
	vi.stubGlobal("fetch", transport);
});
afterEach(() => vi.unstubAllGlobals());

it("lists all account manifests through the SDK and only returns inventory fields", async () => {
	transport.mockImplementationOnce(async (url: string, init: RequestInit) => {
		const upstream = new URL(url);
		expect(init.method).toBe("GET");
		expect(upstream.pathname).toBe("/v1/encoding/manifests");
		expect(upstream.searchParams.get("offset")).toBe("25");
		expect(upstream.searchParams.get("limit")).toBe("25");
		expect(upstream.searchParams.get("sort")).toBe("createdAt:desc");
		expect(new Headers(init.headers).get("X-Tenant-Org-Id")).toBe(organization);
		expect(new Headers(init.headers).get("X-Api-Key")).toBe("fixture");
		return result({ offset: 25, totalCount: 29, items: [row] });
	});
	const response = await GET(request("&offset=25"));
	expect(response.status).toBe(200);
	expect(response.headers.get("Cache-Control")).toContain("no-store");
	expect(await response.json()).toEqual({
		items: [{ id, type: "SMOOTH_STREAMING", createdAt }],
		offset: 25,
		totalCount: 29,
		nextOffset: 26,
	});
	expect(reveal).toHaveBeenCalledWith(account);
	expect(transport).toHaveBeenCalledTimes(1);
});

it("checks query ownership and duplicates before calling the provider", async () => {
	expect((await GET(request("&offset=0&offset=2"))).status).toBe(400);
	reveal.mockResolvedValueOnce(null);
	expect((await GET(request())).status).toBe(404);
	expect(transport).not.toHaveBeenCalled();
});

it.each([
	["missing type", "SUCCESS", { totalCount: 1, items: [{ id }] }],
	["duplicate IDs", "SUCCESS", { totalCount: 2, items: [row, row] }],
	["missing rows", "SUCCESS", { totalCount: 3, items: [] }],
	["error envelope", "ERROR", { totalCount: 1, items: [row] }],
] as const)("rejects an inconsistent manifest page %s", async (_name, status, value) => {
	transport.mockResolvedValueOnce(result(value, status));
	const response = await GET(request());
	expect(response.status).toBe(502);
	expect(await response.text()).not.toContain("PRIVATE_VALUE");
});
