import { afterEach, expect, it, vi } from "vitest";

vi.mock("@/lib/server/context", () => ({
	getServerContext: async () => ({
		tenant: { role: "ADMIN", isImpersonating: false },
		bitmovinAccounts: {
			get: async () => ({ tenantOrgId: "sdk-tenant" }),
			revealApiKey: async () => "test-only",
		},
	}),
}));
vi.mock("@/lib/server/audit", () => ({ writeAuditLog: async () => {} }));

import { DELETE } from "./route";

const account = "aefbf9bf-1472-465c-9a72-5a0d15b2f20e";
const encoding = "08ce94b8-1656-4a1d-9dfa-3564f16ff8b3";
const mapping = "922ca6a2-53b5-4f2b-a3c0-05808af4198c";
const send = vi.fn();
afterEach(() => {
	vi.unstubAllGlobals();
	send.mockReset();
});

function remove() {
	return DELETE(
		new Request("https://example.test/api/live/dns-mappings", {
			method: "DELETE",
			body: JSON.stringify({
				bitmovinAccountId: account,
				encodingId: encoding,
				confirmMappingIds: [mapping],
			}),
		}),
	);
}

function ok(result: unknown) {
	return Response.json({ status: "SUCCESS", data: { result } });
}

it("deletes only the confirmed DNS mapping IDs after checking the full list", async () => {
	vi.stubGlobal("fetch", send);
	send.mockResolvedValueOnce(
		ok({
			totalCount: 1,
			offset: 0,
			items: [{ id: mapping, encodingId: encoding }],
		}),
	);
	send.mockResolvedValueOnce(ok({ id: mapping }));
	const res = await remove();
	expect(res.status, await res.clone().text()).toBe(200);
	expect(await res.json()).toEqual({ ids: [mapping], unresolvedIds: [] });
	expect(
		send.mock.calls.map(([url, init]) => [init.method, new URL(url).pathname]),
	).toEqual([
		["GET", `/v1/encoding/live/encodings/${encoding}/dns-mappings`],
		[
			"DELETE",
			`/v1/encoding/live/encodings/${encoding}/dns-mappings/${mapping}`,
		],
	]);
	expect(
		new Headers(send.mock.calls[1]?.[1].headers).get("X-Tenant-Org-Id"),
	).toBe("sdk-tenant");
});

it.each([
	{ totalCount: 2, offset: 0, items: [{ id: mapping, encodingId: encoding }] },
	{ totalCount: 1, offset: 0, items: [{ id: mapping, encodingId: account }] },
	{ totalCount: 1, offset: 0, items: [{ id: account, encodingId: encoding }] },
])("does not send a delete for a changed or incomplete list", async (list) => {
	vi.stubGlobal("fetch", send);
	send.mockResolvedValueOnce(ok(list));
	expect((await remove()).status).toBe(409);
	expect(send).toHaveBeenCalledOnce();
});

it("reports only confirmed IDs with an unresolved removal when the provider reply differs", async () => {
	vi.stubGlobal("fetch", send);
	send.mockResolvedValueOnce(
		ok({
			totalCount: 1,
			offset: 0,
			items: [{ id: mapping, encodingId: encoding }],
		}),
	);
	send.mockResolvedValueOnce(ok({ id: account }));
	const res = await remove();
	expect(res.status).toBe(207);
	expect(await res.json()).toEqual({ ids: [], unresolvedIds: [mapping] });
	expect(new URL(send.mock.calls[1]?.[0]).pathname).toBe(
		`/v1/encoding/live/encodings/${encoding}/dns-mappings/${mapping}`,
	);
});
