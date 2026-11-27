import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	encodingCatalogueDiagnostic,
	encodingCatalogueKinds,
} from "@/lib/encoding-catalogue";
import { auditedOperationCases } from "../../../../../../scripts/api-coverage-test-cases";
import cases from "./catalogue-read-cases.json";

const { revealForEncoding } = vi.hoisted(() => ({
	revealForEncoding: vi.fn(),
}));
vi.mock("@/lib/server/context", () => ({
	getServerContext: async () => ({ bitmovinAccounts: { revealForEncoding } }),
}));

import { GET } from "./route";

const ACCOUNT = "3f1f0e8e-2c5b-4a4e-9a64-0f6f4d2c9b11";
const RESOURCE = "e96acd24-9ead-42d6-88dd-a706b3dfdeab";
const OTHER = "39d66975-759c-4334-930c-303c0a61e712";
const tenant = "fixture-provider-organization";
const key = "fixture-provider-key";

function request(kind: string, params: Record<string, string> = {}) {
	return new Request(
		`http://test/api/encoding-native?${new URLSearchParams({
			kind,
			bitmovinAccountId: ACCOUNT,
			...params,
		})}`,
	);
}

function transportFor(...replies: unknown[]) {
	const transport = vi.fn(async (_url: string, _init: RequestInit) => {
		if (replies.length === 0) throw new Error("Unexpected provider call");
		return Response.json({
			status: "SUCCESS",
			data: { result: replies.shift() },
		});
	});
	vi.stubGlobal("fetch", transport);
	return transport;
}

function requestPath(path: string) {
	return `/v1${path.replace(/\{[^}]+\}/u, RESOURCE)}`;
}

function assertTransport(
	transport: ReturnType<typeof transportFor>,
	...expected: Array<[path: string, query?: Record<string, string>]>
) {
	expect(transport).toHaveBeenCalledTimes(expected.length);
	expect(revealForEncoding).toHaveBeenCalledExactlyOnceWith(ACCOUNT);
	for (const [index, [path, query]] of expected.entries()) {
		const call = transport.mock.calls[index];
		if (!call) throw new Error("Missing provider request");
		const [url, init] = call;
		const parsed = new URL(url);
		expect(parsed.origin).toBe("https://api.bitmovin.com");
		expect(parsed.pathname).toBe(path);
		expect(Object.fromEntries(parsed.searchParams)).toEqual(query ?? {});
		expect(init.method).toBe("GET");
		expect(init.body).toBeUndefined();
		expect(new Headers(init.headers).get("X-Api-Key")).toBe(key);
		expect(new Headers(init.headers).get("X-Tenant-Org-Id")).toBe(tenant);
		expect(init.signal).toBeInstanceOf(AbortSignal);
	}
}

beforeEach(() => {
	vi.resetAllMocks();
	revealForEncoding.mockResolvedValue({ apiKey: key, tenantOrgId: tenant });
});
afterEach(() => vi.unstubAllGlobals());

describe("account-scoped Encoding resource diagnostics through the installed SDK", () => {
	it.each(
		auditedOperationCases(
			import.meta.url,
			"native-metadata-reads",
			cases.metadata,
			({ path }) => [`GET ${path}`],
		),
	)("counts custom metadata for $kind/$protocol without returning the contents", async ({
		kind,
		protocol,
		path,
		discriminator,
	}) => {
		const selectedKind = encodingCatalogueKinds.find((value) => value === kind);
		if (!selectedKind) throw new Error("Unknown resource in the SDK fixture");
		expect(encodingCatalogueDiagnostic(selectedKind, protocol)).toBe(
			"metadata",
		);
		const transport = transportFor(
			{ id: RESOURCE, type: discriminator, name: "private-resource-name" },
			{
				createdAt: "2026-01-02T03:04:05Z",
				customData: {
					"private-key-name": "private-value",
					"nested-object": { path: "private-nested-value" },
				},
				unexpected: "private-envelope-value",
			},
		);
		const response = await GET(
			request(kind, { protocol, id: RESOURCE, view: "metadata" }),
		);
		expect(response.status).toBe(200);
		expect(response.headers.get("Cache-Control")).toBe("private, no-store");
		expect(await response.json()).toEqual({
			kind,
			protocol,
			id: RESOURCE,
			keyCount: 2,
		});
		assertTransport(
			transport,
			[requestPath(path).slice(0, -"/customData".length)],
			[requestPath(path)],
		);
	});

	it.each(
		auditedOperationCases(
			import.meta.url,
			"native-generic-reads",
			cases.generic,
			({ path }) => [`GET ${path}`],
		),
	)("projects a bounded $kind $view response from $sdkMethod", async ({
		kind,
		view,
		path,
		discriminator,
	}) => {
		const item = {
			id: RESOURCE,
			name: "Broadcast",
			type: discriminator,
			secretKey: "private-value",
			inputPath: "private-path",
			customData: { "private-key-name": "private-value" },
		};
		if (view === "type") {
			const transport = transportFor(
				item,
				kind === "filters" ? discriminator : { type: discriminator },
			);
			const response = await GET(request(kind, { id: RESOURCE, view }));
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({
				kind,
				id: RESOURCE,
				resourceType: discriminator,
			});
			assertTransport(
				transport,
				[requestPath(path).slice(0, -"/type".length)],
				[requestPath(path)],
			);
			return;
		}
		const resource = {
			id: RESOURCE,
			name: "Broadcast",
			resourceType: discriminator,
		};
		if (view === "detail") {
			const transport = transportFor(item);
			const response = await GET(request(kind, { id: RESOURCE }));
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({ kind, item: resource });
			assertTransport(transport, [requestPath(path)]);
			return;
		}
		const transport = transportFor({ offset: 2, totalCount: 3, items: [item] });
		const response = await GET(request(kind, { offset: "2", limit: "5" }));
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			kind,
			offset: 2,
			totalCount: 3,
			items: [resource],
		});
		assertTransport(transport, [
			requestPath(path),
			{ offset: "2", limit: "5" },
		]);
	});

	it.each([
		{ id: OTHER, type: "S3" },
		{ id: RESOURCE, type: "FTP" },
		{ id: "invalid/resource-id", type: "S3" },
	])("does not read custom metadata after an invalid detail response %#", async (item) => {
		const transport = transportFor(item);
		expect(
			(
				await GET(
					request("inputs", { protocol: "s3", id: RESOURCE, view: "metadata" }),
				)
			).status,
		).toBe(502);
		assertTransport(transport, [`/v1/encoding/inputs/s3/${RESOURCE}`]);
	});

	it.each([
		null,
		[],
		{ customData: [] },
		{ customData: "private-value" },
		{ customData: null },
		{ id: OTHER, customData: {} },
	])("refuses invalid metadata response evidence %#", async (metadata) => {
		transportFor({ id: RESOURCE }, metadata);
		const response = await GET(
			request("filters", { protocol: "crop", id: RESOURCE, view: "metadata" }),
		);
		expect(response.status).toBe(502);
		expect(await response.text()).not.toContain("private-value");
	});

	it("distinguishes an empty custom object from invalid metadata and accepts SDK details without a discriminator", async () => {
		transportFor({ id: RESOURCE }, { customData: {} });
		const response = await GET(
			request("inputs", { protocol: "s3", id: RESOURCE, view: "metadata" }),
		);
		expect(await response.json()).toEqual({
			kind: "inputs",
			protocol: "s3",
			id: RESOURCE,
			keyCount: 0,
		});
	});

	it.each([
		{ type: "FTP" },
		{ type: "UNKNOWN" },
		{ id: OTHER, type: "S3" },
		{ type: ["S3"] },
	])("refuses an invalid or inconsistent output type %#", async (result) => {
		transportFor({ id: RESOURCE, type: "S3" }, result);
		expect(
			(await GET(request("outputs", { id: RESOURCE, view: "type" }))).status,
		).toBe(502);
	});

	it("accepts the filter type as an enum from an object envelope", async () => {
		transportFor({ id: RESOURCE, type: "CROP" }, { type: "CROP" });
		const response = await GET(
			request("filters", { id: RESOURCE, view: "type" }),
		);
		expect(await response.json()).toEqual({
			kind: "filters",
			id: RESOURCE,
			resourceType: "CROP",
		});
	});

	it("refuses diagnostic requests outside the selected provider account", async () => {
		revealForEncoding.mockResolvedValue(null);
		const transport = transportFor();
		expect(
			(
				await GET(
					request("inputs", { protocol: "s3", id: RESOURCE, view: "metadata" }),
				)
			).status,
		).toBe(404);
		expect(transport).not.toHaveBeenCalled();
	});

	it("stops after the detail check when a diagnostic request is cancelled", async () => {
		const controller = new AbortController();
		const transport = transportFor();
		transport.mockImplementationOnce(async () => {
			controller.abort();
			return Response.json({
				status: "SUCCESS",
				data: { result: { id: RESOURCE, type: "S3" } },
			});
		});
		const response = await GET(
			new Request(
				request("inputs", { protocol: "s3", id: RESOURCE, view: "metadata" }),
				{ signal: controller.signal },
			),
		);
		expect(response.status).toBe(499);
		assertTransport(transport, [`/v1/encoding/inputs/s3/${RESOURCE}`]);
	});

	it.each([
		["inputs", { protocol: "rtmp", id: RESOURCE, view: "metadata" }],
		["outputs", { id: RESOURCE, view: "metadata" }],
		["filters", { view: "type" }],
		["filters", { protocol: "crop", id: RESOURCE, view: "type" }],
		["templates", { id: RESOURCE, view: "metadata" }],
		["inputs", { protocol: "s3", id: RESOURCE, view: "metadata", limit: "3" }],
	])("refuses invalid diagnostic scope for %s %# before contacting Bitmovin", async (kind, params) => {
		const transport = transportFor();
		expect(
			(await GET(request(kind, params as Record<string, string>))).status,
		).toBe(400);
		expect(revealForEncoding).not.toHaveBeenCalled();
		expect(transport).not.toHaveBeenCalled();
	});
});
