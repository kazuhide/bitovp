import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { auditedOperationCases } from "../../../../../../../scripts/api-coverage-test-cases";
import { GET } from "./route";
import cases from "./statistics-cases.json";

const { binding, transport } = vi.hoisted(() => ({
	binding: vi.fn(),
	transport: vi.fn(),
}));
vi.mock("@/lib/server/context", () => ({
	getServerContext: async () => ({
		bitmovinAccounts: { revealForEncoding: binding },
	}),
}));

const accountId = "00000000-0000-4000-8000-000000000001";
const encodingId = "00000000-0000-4000-8000-000000000002";
const foreignId = "00000000-0000-4000-8000-000000000003";
const tenantOrgId = "00000000-0000-4000-8000-000000000004";
const from = "2026-01-01";
const to = "2026-01-05";
const cdnFrom = "2026-01-01T00:00:00.000Z";
const cdnTo = "2026-01-06T00:00:00.000Z";
const base = "http://fixture.invalid/api/encoding-native/statistics";
const reply = (result: unknown) =>
	Response.json({ status: "SUCCESS", data: { result } });
const request = (query: Record<string, string>) =>
	new Request(`${base}?${new URLSearchParams({ accountId, ...query })}`);

const totalsRow = {
	bytesEncodedTotal: 20,
	timeEncodedTotal: 12,
	bytesEgressTotal: 3,
};
const dailyRow = {
	date: from,
	bytesEncoded: 20,
	timeEncoded: 2,
	billableMinutes: -3.5,
	billableTransmuxingMinutes: -1.25,
};
const encodingRow = {
	date: from,
	bytesEncoded: 20,
	timeEncoded: 2,
	bytesEgress: 1,
	billableTransmuxingMinutes: -2.5,
	billableFeatureMinutes: -144_108.833_333_333_34,
};
const vodRow = { ...encodingRow, timeEnqueued: 8, realtimeFactor: 1.5 };
const labelsRow = {
	label: "Project A",
	billableMinutes: -51.25,
	billableTransmuxingMinutes: -4.75,
};
const dailyLabelRow = {
	date: from,
	label: "Project A",
	billableMinutes: -7.5,
	billableTransmuxingMinutes: -1.5,
};
const liveRow = { encodingId, type: "HD", unitsUsed: 3.75 };
const cdnRow = {
	from: cdnFrom,
	to: "2026-01-02T00:00:00.000Z",
	storageUsage: 80,
	transferUsage: 90,
};
const providerRows = {
	totals: totalsRow,
	daily: dailyRow,
	live: encodingRow,
	vod: vodRow,
	labels: { ...labelsRow, billableFeatureMinutes: [] },
	"daily-labels": {
		date: from,
		labels: [{ ...dailyLabelRow, token: "PRIVATE_TEST_VALUE" }],
	},
	cdn: {
		from: cdnFrom,
		to: cdnTo,
		storageUsageTotal: 80,
		transferUsageTotal: 90,
		usage: [cdnRow],
	},
	"live-options": liveRow,
};

beforeEach(() => {
	vi.stubEnv("TZ", "America/Los_Angeles");
	binding.mockReset().mockResolvedValue({ apiKey: "fixture", tenantOrgId });
	transport.mockReset();
	vi.stubGlobal("fetch", transport);
});
afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});

it.each(
	auditedOperationCases(
		import.meta.url,
		"native-statistics-reads",
		cases,
		(spec) => [`GET ${spec.path}`],
	),
)("uses the documented SDK statistics transport $sdkMethod", async (spec) => {
	if (spec.path.includes("{from}")) expect(new Date(from).getDate()).toBe(31);
	const path = `/v1${spec.path
		.replace("{from}", from)
		.replace("{to}", to)
		.replace("{encoding_id}", encodingId)}`;
	const options = spec.view === "live-options";
	const kind = spec.view as keyof typeof providerRows;
	const page = spec.mode === "page";
	const filtered = spec.view === "labels" || spec.view === "daily-labels";
	const wireRow = { ...providerRows[kind], privateField: "PRIVATE_TEST_VALUE" };
	const result =
		spec.mode === "single"
			? wireRow
			: { items: [wireRow], totalCount: 29, offset: page ? 25 : 0 };
	const observed: string[] = [];
	transport.mockImplementation(async (url: string, init: RequestInit) => {
		const upstream = new URL(url);
		observed.push(upstream.pathname);
		expect(init.method?.toUpperCase()).toBe("GET");
		expect(new Headers(init.headers).get("X-Tenant-Org-Id")).toBe(tenantOrgId);
		expect(new Headers(init.headers).get("X-Api-Key")).toBe("fixture");
		expect(init.signal).toBeInstanceOf(AbortSignal);
		if (options && upstream.pathname === `/v1/encoding/encodings/${encodingId}`)
			return reply({ id: encodingId, type: "LIVE" });
		expect(upstream.pathname).toBe(path);
		expect(upstream.searchParams.get("offset")).toBe(page ? "25" : null);
		expect(upstream.searchParams.get("limit")).toBe(page ? "25" : null);
		if (filtered) expect(upstream.searchParams.get("labels")).toBe("Project A");
		if (spec.view === "cdn") {
			expect(upstream.searchParams.get("from")).toBe("2026-01-01T00:00:00Z");
			expect(upstream.searchParams.get("to")).toBe("2026-01-06T00:00:00Z");
		}
		return reply(result);
	});
	const response = await GET(
		request({
			view: spec.view,
			...(spec.range && { from, to }),
			...(page && { offset: "25" }),
			...(filtered && { label: "Project A" }),
			...(options && { encodingId }),
		}),
	);
	expect(response.status).toBe(200);
	expect(response.headers.get("Cache-Control")).toBe("private, no-store");
	expect(binding).toHaveBeenCalledExactlyOnceWith(accountId);
	const body = await response.json();
	const expected =
		kind === "daily-labels"
			? dailyLabelRow
			: kind === "cdn"
				? cdnRow
				: kind === "labels"
					? labelsRow
					: providerRows[kind];
	expect(body.rows).toEqual([expected]);
	expect(JSON.stringify(body)).not.toContain("PRIVATE_TEST_VALUE");
	if (spec.mode !== "single")
		expect(body.page).toEqual({
			offset: page ? 25 : 0,
			totalCount: 29,
			received: 1,
			nextOffset: page ? 26 : null,
		});
	if (kind === "cdn")
		expect(body.totals).toEqual({
			from: cdnFrom,
			to: cdnTo,
			storageUsageTotal: 80,
			transferUsageTotal: 90,
		});
	expect(observed).toEqual(
		options ? [`/v1/encoding/encodings/${encodingId}`, path] : [path],
	);
});

it("rejects unsupported controls before resolving an account", async () => {
	const invalid = [
		request({ view: "cdn" }),
		request({ view: "cdn", from, to: "2026-04-11" }),
		request({ view: "daily", from }),
		request({ view: "daily", from, to, offset: "25" }),
		request({ view: "vod", from: to, to: from }),
		request({ view: "live", encodingId }),
		request({ view: "daily", label: "Project A" }),
		request({ view: "labels", label: "Studio, East" }),
		new Request(`${base}?view=daily&accountId=${accountId}&view=totals`),
	];
	for (const req of invalid) expect((await GET(req)).status).toBe(400);
	expect(binding).not.toHaveBeenCalled();
	expect(transport).not.toHaveBeenCalled();
});

it("uses no provider credentials when the account is outside the tenant", async () => {
	binding.mockResolvedValue(null);
	expect((await GET(request({ view: "daily" }))).status).toBe(404);
	expect(transport).not.toHaveBeenCalled();
});

it("loads options only for a matching Live encoding", async () => {
	for (const owner of [
		{ id: foreignId, type: "LIVE" },
		{ id: encodingId, type: "VOD" },
	]) {
		transport.mockResolvedValueOnce(reply(owner));
		expect(
			(await GET(request({ view: "live-options", encodingId }))).status,
		).toBe(404);
	}
	expect(transport).toHaveBeenCalledTimes(2);
	transport
		.mockResolvedValueOnce(reply({ id: encodingId, type: "LIVE" }))
		.mockResolvedValueOnce(reply({ ...liveRow, encodingId: foreignId }));
	expect(
		(await GET(request({ view: "live-options", encodingId }))).status,
	).toBe(502);
	expect(transport).toHaveBeenCalledTimes(4);
});

it("preserves absent metrics and rejects malformed or out-of-range pages", async () => {
	transport.mockResolvedValueOnce(
		reply({ items: [{ date: from }], totalCount: 1 }),
	);
	const good = await GET(request({ view: "daily", from, to }));
	expect((await good.json()).rows).toEqual([{ date: from }]);
	for (const raw of [
		{ totalCount: 1 },
		{ items: [], totalCount: 1 },
		{ items: [dailyRow], totalCount: 1, offset: 3 },
		{ items: [{ ...dailyRow, date: "2026-01-31" }], totalCount: 1 },
		{ items: [{ ...dailyRow, billableMinutes: "1" }], totalCount: 1 },
		{ items: [{ ...dailyRow, bytesEncoded: -1 }], totalCount: 1 },
		{ items: [{ ...dailyRow, timeEncoded: -1 }], totalCount: 1 },
	]) {
		transport.mockResolvedValueOnce(reply(raw));
		expect((await GET(request({ view: "daily", from, to }))).status).toBe(502);
	}
});

it.each([
	"labels",
	"daily-labels",
])("preserves provider label text in unfiltered %s", async (view) => {
	const labels = [{ ...labelsRow, label: "Studio, East" }];
	const daily = view === "daily-labels";
	transport.mockImplementationOnce(async (url: string) => {
		const upstream = new URL(url);
		expect(upstream.pathname).toBe(
			daily
				? "/v1/encoding/statistics/labels/daily"
				: "/v1/encoding/statistics/labels",
		);
		expect(upstream.searchParams.has("labels")).toBe(false);
		return reply({
			items: daily ? [{ date: from, labels }] : labels,
			totalCount: 1,
		});
	});

	const response = await GET(request({ view }));
	expect(response.status).toBe(200);
	expect((await response.json()).rows).toEqual(
		daily ? labels.map((item) => ({ ...item, date: from })) : labels,
	);
});

it("requires nested daily label dates to agree with the bucket in UTC", async () => {
	const query = { view: "daily-labels", from, to, label: labelsRow.label };
	const withNestedDate = (date: string) =>
		reply({
			items: [{ date: from, labels: [{ ...labelsRow, date }] }],
			totalCount: 1,
		});
	transport.mockResolvedValueOnce(withNestedDate("2026-01-02T00:30:00+09:00"));
	const matching = await GET(request(query));
	expect(matching.status).toBe(200);
	expect((await matching.json()).rows).toEqual([{ ...labelsRow, date: from }]);

	for (const date of ["2026-01-01T20:00:00-05:00", "not-a-date"]) {
		transport.mockResolvedValueOnce(withNestedDate(date));
		expect((await GET(request(query))).status).toBe(502);
	}
});

it("covers one full UTC day of CDN usage and rejects contradictory intervals", async () => {
	const oneDay = { ...providerRows.cdn, to: cdnRow.to };
	transport.mockImplementationOnce(async (url: string) => {
		const params = new URL(url).searchParams;
		expect(params.get("from")).toBe("2026-01-01T00:00:00Z");
		expect(params.get("to")).toBe("2026-01-02T00:00:00Z");
		return reply(oneDay);
	});
	expect((await GET(request({ view: "cdn", from, to: from }))).status).toBe(
		200,
	);
	for (const invalid of [
		{ ...oneDay, to: cdnTo },
		{ ...oneDay, usage: [{ ...cdnRow, to: cdnTo }] },
		{ ...oneDay, usage: [{ ...cdnRow, to: cdnFrom }] },
	]) {
		transport.mockResolvedValueOnce(reply(invalid));
		expect((await GET(request({ view: "cdn", from, to: from }))).status).toBe(
			502,
		);
	}
});
