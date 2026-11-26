import BitmovinApi from "@bitmovin/api-sdk";
import { describe, expect, it, vi } from "vitest";
import { encodingFilterProtocols } from "@/lib/encoding-filter-catalogue";
import { auditedOperationCases } from "../../../../../scripts/api-coverage-test-cases";
import { encodingFilterReader } from "./encoding-filter-catalogue";

const typedProtocols = [
	"audio-mix",
	"audio-volume",
	"azure-speech-to-captions",
	"conform",
	"crop",
	"deinterlace",
	"denoise-hqdn3d",
	"dolby-loudness",
	"ebu-r128-single-pass",
	"enhanced-deinterlace",
	"enhanced-watermark",
	"interlace",
	"rotate",
	"scale",
	"text",
	"unsharp",
	"watermark",
] as const;
const id = "d0e95c41-f7ad-4c3c-b126-739d47a5a89b";
const fixture = { id, name: "Saved filter" };
const filtersPath = "/v1/encoding/filters";

describe("encoding filter catalogue", () => {
	it("exposes the supported subtype choices", () => {
		expect(Object.keys(encodingFilterProtocols).sort()).toEqual(
			[...typedProtocols].sort(),
		);
	});

	it.each(
		auditedOperationCases(
			import.meta.url,
			"native-filter-pairs",
			[
				{ protocol: undefined, path: filtersPath },
				...typedProtocols.map((protocol) => ({
					protocol,
					path: `${filtersPath}/${protocol}`,
				})),
			],
			({ path }) => [
				`GET ${path.slice(3)}`,
				`GET ${path.slice(3)}/{filter_id}`,
			],
		),
	)("reads the official paged collection and detail at $path", async ({
		protocol,
		path,
	}) => {
		const fetch = vi.fn(async (url: string, _init: RequestInit) =>
			Response.json({
				status: "SUCCESS",
				data: {
					result: new URL(url).searchParams.has("offset")
						? { items: [fixture], totalCount: 27 }
						: fixture,
				},
			}),
		);
		const api = new BitmovinApi({
			apiKey: "filter-test-key",
			tenantOrgId: "filter-test-tenant",
			fetch,
		});
		const reader = encodingFilterReader(protocol);
		if (!reader)
			throw new Error(`Missing reader for ${protocol ?? "all filters"}`);
		expect(await reader.list(api, { offset: 24, limit: 3 })).toMatchObject({
			items: [fixture],
			totalCount: 27,
		});
		expect(await reader.get(api, id)).toMatchObject(fixture);
		expect(
			fetch.mock.calls.map(([rawUrl, init]) => {
				const url = new URL(rawUrl);
				const headers = new Headers(init.headers);
				return {
					origin: url.origin,
					path: url.pathname,
					query: Object.fromEntries(url.searchParams),
					method: init.method,
					tenant: headers.get("X-Tenant-Org-Id"),
					apiKey: headers.get("X-Api-Key"),
				};
			}),
		).toEqual([
			{
				origin: "https://api.bitmovin.com",
				path,
				query: { offset: "24", limit: "3" },
				method: "GET",
				tenant: "filter-test-tenant",
				apiKey: "filter-test-key",
			},
			{
				origin: "https://api.bitmovin.com",
				path: `${path}/${id}`,
				query: {},
				method: "GET",
				tenant: "filter-test-tenant",
				apiKey: "filter-test-key",
			},
		]);
	});

	it.each([
		"",
		"type",
		"customData",
		"../crop",
		"constructor",
		"__proto__",
	])("does not dispatch unsupported subtype %j", (protocol) => {
		expect(encodingFilterReader(protocol)).toBeUndefined();
	});
});
