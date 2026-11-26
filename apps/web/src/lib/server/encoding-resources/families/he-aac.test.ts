import BitmovinApi from "@bitmovin/api-sdk";
import { expect, it, vi } from "vitest";
import { InvalidResourceResponse } from "../family";
import { heAac } from "./he-aac";

const address = {
	id: "dc148ba5-f724-41a8-93ff-04f7829fb1ae",
	parent: () => {
		throw Error("A standalone codec has no parent resource");
	},
};
const name = "shared / programme & comment";
const resource = {
	id: address.id,
	name,
	bitrate: 32000,
	signaling: "EXPLICIT_SBR",
	apiKey: "fixture-private",
};
function sdk(serve: (url: URL, method: string) => unknown) {
	const requests: string[] = [];
	const api = new BitmovinApi({
		apiKey: "unused-offline",
		tenantOrgId: "test-tenant",
		baseUrl: "https://e01.invalid/v1",
		fetch: async (url, init) => {
			const parsed = new URL(String(url));
			expect(parsed.origin).toBe("https://e01.invalid");
			expect(new Headers(init?.headers).get("X-Tenant-Org-Id")).toBe(
				"test-tenant",
			);
			requests.push(parsed.pathname + parsed.search);
			return Response.json({
				status: "SUCCESS",
				data: { result: serve(parsed, init?.method ?? "GET") },
			});
		},
	});
	return { api, requests };
}
it.each([
	1, 2,
] as const)("matches only the V%s execution receipt across name-filtered SDK pages", async (version) => {
	const path = `/v1/encoding/configurations/audio/he-aac-v${version}`;
	const family = heAac[`CREATE_CODEC_HE_AAC_V${version}`];
	const other = Array.from({ length: 100 }, (_, n) => ({
		id: `other-${n}`,
		name,
		description: "sensitive",
	}));
	const { api, requests } = sdk((url, method) => {
		expect(method).toBe("GET");
		if (url.pathname === `${path}/${address.id}`) return resource;
		expect(url.pathname).toBe(path);
		expect(url.searchParams.get("name")).toBe(name);
		expect(url.searchParams.get("limit")).toBe("100");
		const offset = Number(url.searchParams.get("offset"));
		expect([0, 100]).toContain(offset);
		return {
			items: offset === 0 ? other : [resource],
			offset,
			totalCount: 101,
		};
	});
	expect(family.listScope).toBe("linked");
	expect(family.list).toBeDefined();
	expect(await family.list?.(api, address, { offset: 0, limit: 25 })).toEqual({
		offset: 0,
		total: 1,
		items: [
			{ id: address.id, name, bitrate: 32000, signaling: "EXPLICIT_SBR" },
		],
	});
	expect(requests).toHaveLength(3);
	expect(await family.list?.(api, address, { offset: 1, limit: 25 })).toEqual({
		offset: 1,
		total: 1,
		items: [],
	});
});
it.each([
	1, 2,
] as const)("uses the exact V%s resource for detail, custom data, and deletion", async (version) => {
	const path = `/v1/encoding/configurations/audio/he-aac-v${version}/${address.id}`;
	const observed = vi.fn();
	const { api } = sdk((url, method) => {
		observed(url.pathname, method);
		return url.pathname.endsWith("/customData") ||
			url.pathname.endsWith("/customdata")
			? { customData: { fixture: "private" } }
			: resource;
	});
	const family = heAac[`CREATE_CODEC_HE_AAC_V${version}`];
	expect(await family.detail(api, address)).toEqual({
		id: address.id,
		name,
		bitrate: 32000,
		signaling: "EXPLICIT_SBR",
	});
	expect((await family.customData?.(api, address))?.customData).toEqual({
		fixture: "private",
	});
	await family.remove(api, address);
	expect(
		observed.mock.calls.map(([url, method]) => [url.toLowerCase(), method]),
	).toEqual([
		[path, "GET"],
		[`${path}/customdata`, "GET"],
		[path, "DELETE"],
	]);
});
it.each([
	"complete",
	"truncated",
	"cycles",
	"budget",
	"wrong detail",
	"invalid id",
] as const)("distinguishes verified absence from an uncertain provider result (%s)", async (reason) => {
	const { api, requests } = sdk((url) => {
		if (url.pathname.endsWith(`/${address.id}`))
			return reason === "wrong detail"
				? { ...resource, id: "different" }
				: resource;
		const offset = Number(url.searchParams.get("offset"));
		if (reason === "invalid id")
			return { items: [{ id: 7, name }], offset, totalCount: 1 };
		const totalCount = reason === "complete" ? 1 : 600;
		const batchSize = reason === "complete" || reason === "truncated" ? 1 : 100;
		return {
			totalCount,
			offset,
			items: Array.from({ length: batchSize }, (_, n) => ({
				id: `other-${(reason === "cycles" ? 0 : offset) + n}`,
				name,
			})),
		};
	});
	const read = heAac.CREATE_CODEC_HE_AAC_V2.list?.(api, address, {
		offset: 0,
		limit: 25,
	});
	if (reason === "complete")
		expect(await read).toEqual({ offset: 0, total: 0, items: [] });
	else await expect(read).rejects.toBeInstanceOf(InvalidResourceResponse);
	expect(requests.length).toBeLessThanOrEqual(5);
});
