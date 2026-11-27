import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { auditedOperationCases } from "../../../../../../scripts/api-coverage-test-cases";

const { getAccount, revealApiKey, revealForEncoding } = vi.hoisted(() => ({
	getAccount: vi.fn(),
	revealApiKey: vi.fn(),
	revealForEncoding: vi.fn(),
}));
vi.mock("@/lib/server/context", () => ({
	getServerContext: async () => ({
		bitmovinAccounts: { get: getAccount, revealApiKey, revealForEncoding },
	}),
}));

import { evaluateRole } from "@/lib/auth/roles";
import { GET } from "./route";

const ACCOUNT = "3f1f0e8e-2c5b-4a4e-9a64-0f6f4d2c9b11";
const RESOURCE = "e96acd24-9ead-42d6-88dd-a706b3dfdeab";
const INPUT = "39d66975-759c-4334-930c-303c0a61e712";
const secret = "private-upload-token";
const endpoint = "/api/encoding-native";

function request(kind: string, suffix = "") {
	return new Request(
		"http://test" +
			endpoint +
			"?kind=" +
			kind +
			"&bitmovinAccountId=" +
			ACCOUNT +
			suffix,
	);
}

// Fixed wire spellings from SDK 1.289.0. Keep independent of the app dispatcher.
const ioProtocols = {
	inputs: [
		"akamai-netstorage",
		"aspera",
		"azure",
		"direct-file-upload",
		"ftp",
		"gcs",
		"gcs-service-account",
		"generic-s3",
		"hls",
		"http",
		"https",
		"local",
		"redundant-rtmp",
		"rtmp",
		"s3",
		"s3-role-based",
		"sftp",
		"srt",
		"zixi",
	],
	outputs: [
		"akamai-msl",
		"akamai-netstorage",
		"azure",
		"cdn",
		"ftp",
		"gcs",
		"gcs-service-account",
		"generic-s3",
		"live-media-ingest",
		"local",
		"moq",
		"s3",
		"s3-role-based",
		"sftp",
	],
};
const ioCases = Object.entries(ioProtocols).flatMap(([kind, protocols]) =>
	protocols.map((protocol) => ({
		kind,
		protocol,
		path: `/encoding/${kind}/${protocol}`,
	})),
);

function reply(result: unknown) {
	return Response.json({ status: "SUCCESS", data: { result } });
}

function mockTransport(result: unknown) {
	const transport = vi.fn(async (_url: string, _init: RequestInit) =>
		reply(result),
	);
	vi.stubGlobal("fetch", transport);
	return transport;
}

function assertGet(
	transport: ReturnType<typeof mockTransport>,
	path: string,
	query: Record<string, string> = {},
) {
	expect(transport).toHaveBeenCalledOnce();
	const call = transport.mock.calls[0];
	if (!call) throw new Error("No provider request was sent");
	const [url, init] = call;
	expect(new URL(url).origin).toBe("https://api.bitmovin.com");
	expect(new URL(url).pathname).toBe(path);
	expect(Object.fromEntries(new URL(url).searchParams)).toEqual(query);
	expect(init.method).toBe("GET");
	expect(init.body).toBeUndefined();
	expect(new Headers(init.headers).get("X-Tenant-Org-Id")).toBe(
		"fixture-organization",
	);
	expect(new Headers(init.headers).get("X-Api-Key")).toBe("fixture-api-key");
	expect(init.signal).toBeInstanceOf(AbortSignal);
	expect(revealForEncoding).toHaveBeenCalledWith(ACCOUNT);
}

beforeEach(() => {
	vi.resetAllMocks();
	getAccount.mockResolvedValue({
		id: ACCOUNT,
		tenantOrgId: "fixture-organization",
	});
	revealApiKey.mockResolvedValue("fixture-api-key");
	revealForEncoding.mockResolvedValue({
		apiKey: "fixture-api-key",
		tenantOrgId: "fixture-organization",
	});
});
afterEach(() => vi.unstubAllGlobals());

describe("native Encoding resources through the installed SDK", () => {
	it("uses the credentials and tenant header from one account snapshot", async () => {
		getAccount.mockResolvedValue({
			id: ACCOUNT,
			tenantOrgId: "old-organization",
		});
		revealApiKey.mockResolvedValue("a-different-key-revision");
		const transport = mockTransport({ totalCount: 0, items: [] });
		expect((await GET(request("templates"))).status).toBe(200);
		expect(revealForEncoding).toHaveBeenCalledOnce();
		expect(revealForEncoding).toHaveBeenCalledWith(ACCOUNT);
		expect(getAccount).not.toHaveBeenCalled();
		expect(revealApiKey).not.toHaveBeenCalled();
		const headers = new Headers(transport.mock.calls[0]?.[1].headers);
		expect(headers.get("X-Api-Key")).toBe("fixture-api-key");
		expect(headers.get("X-Tenant-Org-Id")).toBe("fixture-organization");
	});

	it.each([
		["inputs", "s3", "US_EAST_1"],
		["outputs", "s3-role-based", "US_EAST_1"],
		["inputs", "gcs-service-account", "EUROPE_WEST_1"],
		["outputs", "gcs", "EUROPE_WEST_1"],
	])("keeps the %s/%s storage region %s", async (kind, protocol, cloudRegion) => {
		mockTransport({ id: RESOURCE, cloudRegion });
		const response = await GET(
			request(kind, `&protocol=${protocol}&id=${RESOURCE}`),
		);
		expect(await response.json()).toEqual({
			kind,
			protocol,
			item: { id: RESOURCE, cloudRegion },
		});
	});

	it("sends the template collection GET with its type and paging query", async () => {
		const transport = mockTransport({
			offset: 2,
			totalCount: 3,
			items: [{ id: RESOURCE, name: "Stored template", type: "VOD" }],
		});
		const response = await GET(
			request("templates", "&offset=2&limit=4&type=VOD"),
		);
		expect(response.status).toBe(200);
		expect(response.headers.get("Cache-Control")).toBe("private, no-store");
		expect(await response.json()).toEqual({
			kind: "templates",
			offset: 2,
			totalCount: 3,
			items: [{ id: RESOURCE, name: "Stored template", type: "VOD" }],
		});
		assertGet(transport, "/v1/encoding/templates", {
			offset: "2",
			limit: "4",
			type: "VOD",
		});
	});

	it("sends the template detail GET and projects the provider metadata", async () => {
		const transport = mockTransport({
			id: RESOURCE,
			type: "LIVE",
			url: `https://store.example/signed.yaml?token=${secret}`,
			customData: { privateKey: secret },
		});
		const response = await GET(request("templates", `&id=${RESOURCE}`));
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			kind: "templates",
			item: { id: RESOURCE, type: "LIVE" },
		});
		assertGet(transport, `/v1/encoding/templates/${RESOURCE}`);
	});

	it("sends the watch folder collection GET and strips paths and provider text", async () => {
		const transport = mockTransport({
			totalCount: 1,
			items: [
				{
					id: RESOURCE,
					status: "STARTED",
					statusText: secret,
					input: { inputId: INPUT, inputPath: secret },
				},
			],
		});
		const response = await GET(request("watch-folders"));
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			kind: "watch-folders",
			offset: 0,
			totalCount: 1,
			items: [{ id: RESOURCE, status: "STARTED" }],
		});
		assertGet(transport, "/v1/encoding/watch-folders", {
			offset: "0",
			limit: "25",
		});
	});

	it("sends the watch folder detail GET and returns bounded relationship evidence", async () => {
		const transport = mockTransport({
			id: RESOURCE,
			status: "STOPPED",
			input: { inputId: INPUT, inputPath: secret },
			outputs: [{ outputId: RESOURCE, outputPath: secret }],
			statusText: secret,
		});
		const response = await GET(request("watch-folders", `&id=${RESOURCE}`));
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			kind: "watch-folders",
			item: { id: RESOURCE, status: "STOPPED", inputId: INPUT, outputCount: 1 },
		});
		assertGet(transport, `/v1/encoding/watch-folders/${RESOURCE}`);
	});

	it.each(
		auditedOperationCases(
			import.meta.url,
			"native-io-list",
			ioCases,
			({ path }) => [`GET ${path}`],
		),
	)("lists $kind/$protocol and withholds provider credentials", async ({
		kind,
		protocol,
		path,
	}) => {
		const transport = mockTransport({
			offset: 2,
			totalCount: 3,
			items: [
				{
					id: RESOURCE,
					name: "North archive",
					accessKey: secret,
					customData: { token: secret },
					url: secret,
				},
			],
		});
		const response = await GET(
			request(kind, `&protocol=${protocol}&offset=2&limit=5`),
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			kind,
			protocol,
			offset: 2,
			totalCount: 3,
			items: [{ id: RESOURCE, name: "North archive" }],
		});
		assertGet(transport, `/v1${path}`, {
			offset: "2",
			limit: "5",
		});
	});

	it.each(
		auditedOperationCases(
			import.meta.url,
			"native-io-get",
			ioCases,
			({ kind, path }) => [
				`GET ${path}/{${kind === "inputs" ? "input_id" : "output_id"}}`,
			],
		),
	)("reads $kind/$protocol details without connection secrets", async ({
		kind,
		protocol,
		path,
	}) => {
		const transport = mockTransport({
			id: RESOURCE,
			name: "North archive",
			createdAt: "2026-11-27T12:00:00Z",
			password: secret,
			privateKey: secret,
			connectionString: secret,
			roleArn: secret,
			externalId: secret,
		});
		const response = await GET(
			request(kind, `&protocol=${protocol}&id=${RESOURCE}`),
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			kind,
			protocol,
			item: {
				id: RESOURCE,
				name: "North archive",
				createdAt: "2026-11-27T12:00:00Z",
			},
		});
		assertGet(transport, `/v1${path}/${RESOURCE}`);
	});

	it("rejects a foreign account before sending a provider request", async () => {
		revealForEncoding.mockResolvedValue(null);
		const transport = mockTransport({});
		expect((await GET(request("templates"))).status).toBe(404);
		expect(revealApiKey).not.toHaveBeenCalled();
		expect(transport).not.toHaveBeenCalled();
	});

	it.each([
		["templates", `&id=${RESOURCE}&offset=0`],
		["templates", "&offset=0&offset=1"],
		["templates", "&limit=0"],
		["watch-folders", "&type=LIVE"],
		["inputs", ""],
		["inputs", "&protocol=cdn"],
		["outputs", "&protocol=__proto__"],
		["outputs", "&protocol=s3&type=LIVE"],
		["templates", "&protocol=s3"],
		["unknown", ""],
	])("rejects unsupported query boundaries (%s %s)", async (kind, suffix) => {
		const transport = mockTransport({});
		expect((await GET(request(kind, suffix))).status).toBe(400);
		expect(revealForEncoding).not.toHaveBeenCalled();
		expect(transport).not.toHaveBeenCalled();
	});

	it.each([
		{ totalCount: 0 },
		{ totalCount: 0, items: null },
		{ totalCount: 3, items: [] },
	])("refuses inconsistent provider pages %#", async (result) => {
		mockTransport(result);
		expect((await GET(request("templates"))).status).toBe(502);
	});

	it("refuses a different resource from the one requested", async () => {
		mockTransport({ id: INPUT });
		expect((await GET(request("templates", `&id=${RESOURCE}`))).status).toBe(
			502,
		);
	});

	it.each([
		{
			kind: "video-codecs",
			protocol: "h264",
			path: "configurations/video/h264",
			fields: {
				bitrateBps: 1800000,
				width: 1920,
				height: 1080,
				frameRate: 29.97,
			},
		},
		{
			kind: "audio-codecs",
			protocol: "aac",
			path: "configurations/audio/aac",
			fields: { bitrateBps: 1800000, sampleRateHz: 48000 },
		},
		{
			kind: "subtitle-codecs",
			protocol: "dvb-subtitle",
			path: "configurations/subtitles/dvb-subtitle",
			fields: {},
		},
		{ kind: "filters", protocol: "scale", path: "filters/scale", fields: {} },
		{ kind: "filters", protocol: undefined, path: "filters", fields: {} },
	])("scopes $kind/$protocol and projects curated fields", async ({
		kind,
		protocol,
		path,
		fields,
	}) => {
		const suffix = protocol ? `&protocol=${protocol}` : "";
		const item = {
			id: RESOURCE,
			name: "Broadcast",
			bitrate: 1800000,
			rate: kind === "audio-codecs" ? 48000 : 29.97,
			width: 1920,
			height: 1080,
			subscriptionKey: secret,
			customData: { outputPath: secret },
			description: secret,
		};
		let transport = mockTransport({ totalCount: 1, items: [item] });
		const list = await GET(request(kind, suffix));
		expect(list.status).toBe(200);
		expect(await list.json()).toEqual({
			kind,
			...(protocol && { protocol }),
			offset: 0,
			totalCount: 1,
			items: [{ id: RESOURCE, name: "Broadcast", ...fields }],
		});
		assertGet(transport, `/v1/encoding/${path}`, { offset: "0", limit: "25" });
		transport = mockTransport(item);
		const detail = await GET(request(kind, `${suffix}&id=${RESOURCE}`));
		expect(detail.status).toBe(200);
		expect(await detail.json()).toEqual({
			kind,
			...(protocol && { protocol }),
			item: { id: RESOURCE, name: "Broadcast", ...fields },
		});
		assertGet(transport, `/v1/encoding/${path}/${RESOURCE}`);
	});

	it.each([
		["video-codecs", ""],
		["video-codecs", "&protocol=aac"],
		["subtitle-codecs", "&protocol=h264"],
		["filters", "&protocol=constructor"],
	])("rejects a mismatched configuration type (%s %s)", async (kind, suffix) => {
		const transport = mockTransport({});
		expect((await GET(request(kind, suffix))).status).toBe(400);
		expect(revealForEncoding).not.toHaveBeenCalled();
		expect(transport).not.toHaveBeenCalled();
	});

	it("preserves a genuinely empty page past the end of a shrinking collection", async () => {
		mockTransport({ offset: 55, totalCount: 12, items: [] });
		const response = await GET(request("templates", "&offset=55"));
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			kind: "templates",
			offset: 55,
			totalCount: 12,
			items: [],
		});
	});

	it.each([
		401, 403, 404, 429,
	])("does not forward provider diagnostics for HTTP %i", async (status) => {
		const transport = vi.fn(async () =>
			Response.json({ status: "ERROR", data: { message: secret } }, { status }),
		);
		vi.stubGlobal("fetch", transport);
		const response = await GET(request("templates", `&id=${RESOURCE}`));
		expect(response.status).toBe(status === 404 ? 404 : 502);
		expect(await response.text()).not.toContain(secret);
		expect(transport).toHaveBeenCalledOnce();
	});

	it("applies the Settings administration role at the API boundary", () => {
		expect(evaluateRole("VIEWER", endpoint, "GET").allowed).toBe(false);
		expect(evaluateRole("OPERATOR", endpoint, "GET").allowed).toBe(false);
		expect(evaluateRole("ADMIN", endpoint, "GET").allowed).toBe(true);
	});
});
