import { once } from "node:events";
import { createServer } from "node:http";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

const accountId = "3f1f0e8e-2c5b-4a4e-9a64-0f6f4d2c9b11";
const otherAccount = "3f1f0e8e-2c5b-4a4e-9a64-0f6f4d2c9b12";
const getAccount = vi.fn();
const revealApiKey = vi.fn();
const list = vi.fn();
const findMany = vi.fn();
vi.mock("@/lib/server/context", () => ({
	getServerContext: () => ({
		bitmovinAccounts: { get: getAccount, revealApiKey },
		prisma: { liveChannel: { findMany } },
	}),
}));
vi.mock("@bitmovin/api-sdk", () => ({
	default: class {
		encoding = { encodings: { list } };
	},
}));

import { GET } from "./route";

function request(query = `bitmovinAccountId=${accountId}`) {
	return new Request(`http://test/api/live/orphan-inventory?${query}`);
}
const running = (id: string, status = "RUNNING") => ({ id, status });
beforeEach(() => {
	vi.resetAllMocks();
	getAccount.mockImplementation(async (id) =>
		id === accountId ? { id, tenantOrgId: null } : null,
	);
	revealApiKey.mockResolvedValue("synthetic-key");
	list.mockResolvedValue({ totalCount: 0, items: [] });
	findMany.mockResolvedValue([]);
});

describe("Live inventory: read-only and account-scoped", () => {
	it.each([
		"CREATED",
		"PROVISIONING",
	])("starts from the selected account, preserving %s and step-log-only evidence", async (status) => {
		list.mockResolvedValue({
			items: [
				running("active"),
				running("creating"),
				running("stopped"),
				running("foreign"),
				running("done", "FINISHED"),
			],
			totalCount: 5,
		});
		const rows = [
			{
				bitmovinAccountId: accountId,
				bitmovinEncodingId: "active",
				status: "RUNNING",
				stepLog: [],
			},
			{
				bitmovinAccountId: accountId,
				bitmovinEncodingId: "creating",
				status,
				stepLog: [],
			},
			{
				bitmovinAccountId: accountId,
				bitmovinEncodingId: null,
				status: "STOPPED",
				stepLog: [{ kind: "CREATE_ENCODING", resourceId: "stopped" }],
			},
			{
				bitmovinAccountId: otherAccount,
				bitmovinEncodingId: "foreign",
				status: "RUNNING",
				stepLog: [],
			},
		];
		findMany.mockImplementation(async ({ where }) =>
			rows.filter((row) => row.bitmovinAccountId === where.bitmovinAccountId),
		);
		const response = await GET(request());
		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(await response.json()).toEqual({
			bitmovinAccountId: accountId,
			checkedAt: expect.any(String),
			running: 4,
			unexplained: 1,
			contradicted: 1,
			inFlight: 1,
		});
		expect(getAccount).toHaveBeenCalledWith(accountId);
		expect(revealApiKey).toHaveBeenCalledWith(accountId);
	});

	it("validates account before provider access; a missing account never falls back to the first", async () => {
		expect((await GET(request(""))).status).toBe(400);
		expect(
			(await GET(request(`bitmovinAccountId=${otherAccount}`))).status,
		).toBe(404);
		expect(list).not.toHaveBeenCalled();
		expect(revealApiKey).not.toHaveBeenCalled();
	});

	it("reads all pages with limit 100, including CREATED and QUEUED", async () => {
		const queries: Record<string, unknown>[] = [];
		list.mockImplementation(async (configure) => {
			const values: Record<string, unknown> = {};
			const query = {
				type: (v: string) => {
					values.type = v;
					return query;
				},
				limit: (v: number) => {
					values.limit = v;
					return query;
				},
				offset: (v: number) => {
					values.offset = v;
					return query;
				},
			};
			configure(query);
			queries.push(values);
			return {
				totalCount: 102,
				items:
					values.offset === 0
						? Array.from({ length: 100 }, (_, i) => running(`id-${i}`))
						: [running("new", "CREATED"), running("queued", "QUEUED")],
			};
		});
		expect(await (await GET(request())).json()).toMatchObject({
			running: 102,
			unexplained: 102,
		});
		expect(queries).toEqual([
			{ type: "LIVE", limit: 100, offset: 0 },
			{ type: "LIVE", limit: 100, offset: 100 },
		]);
	});

	it.each([
		{ items: [], totalCount: 1 },
		{ totalCount: 0 },
		{ items: [{ status: "RUNNING" }], totalCount: 1 },
		{ items: [running("same"), running("same")], totalCount: 2 },
	])("never turns incomplete or malformed inventory into zero: %j", async (page) => {
		list.mockResolvedValue(page);
		const response = await GET(request());
		expect(response.status).toBe(502);
		expect(await response.json()).not.toHaveProperty("running");
	});

	it("bounds discovery and does not publish a truncated count", async () => {
		let page = 0;
		// Each full page is distinct, so the cap (not duplicate detection) stops it.
		list.mockImplementation(async () => ({
			totalCount: 1001,
			items: Array.from({ length: 100 }, (_, i) =>
				running(`id-${page++}-${i}`),
			),
		}));
		expect((await GET(request())).status).toBe(502);
		expect(list.mock.calls.length).toBeLessThanOrEqual(10);
	});

	it("provider or DB failure returns unknown with no raw secret/error detail", async () => {
		for (const fail of [list, findMany]) {
			fail.mockRejectedValueOnce(new Error("synthetic-secret-must-not-leak"));
			const response = await GET(request());
			expect(response.status).toBe(502);
			expect(await response.text()).toBe(
				'{"error":"Live inventory unavailable; count unknown"}',
			);
		}
	});
	it("does not classify a truncated local channel population", async () => {
		findMany.mockResolvedValue(
			Array.from({ length: 1001 }, () => ({
				status: "STOPPED",
				bitmovinEncodingId: null,
				stepLog: [],
			})),
		);
		const response = await GET(request());
		expect(response.status).toBe(502);
		expect(await response.json()).not.toHaveProperty("running");
	});
});

describe("loopback HTTP transport (real route; synthetic DB/provider, no Next proxy)", () => {
	const server = createServer(async (req, res) => {
		const response = await GET(new Request(`http://127.0.0.1${req.url}`));
		res.writeHead(response.status, Object.fromEntries(response.headers));
		res.end(await response.text());
	});
	let origin: string;
	beforeAll(async () => {
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		const address = server.address();
		if (!address || typeof address === "string")
			throw new Error("No loopback address");
		origin = `http://127.0.0.1:${address.port}`;
	});
	afterAll(async () => {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});
	it("serializes complete zero and rejects another account over a real socket", async () => {
		const zero = await fetch(
			`${origin}/api/live/orphan-inventory?bitmovinAccountId=${accountId}`,
		);
		expect(zero.status).toBe(200);
		expect(await zero.json()).toMatchObject({
			running: 0,
			unexplained: 0,
			inFlight: 0,
			contradicted: 0,
		});
		const missing = await fetch(
			`${origin}/api/live/orphan-inventory?bitmovinAccountId=${otherAccount}`,
		);
		expect(missing.status).toBe(404);
		expect(list).toHaveBeenCalledTimes(1);
	});
	it("returns nonzero suspicion and failure-without-count through HTTP", async () => {
		list.mockResolvedValueOnce({
			totalCount: 2,
			items: [running("untracked"), running("stopped")],
		});
		findMany.mockResolvedValueOnce([
			{ status: "STOPPED", bitmovinEncodingId: "stopped", stepLog: [] },
		]);
		const found = await fetch(
			`${origin}/api/live/orphan-inventory?bitmovinAccountId=${accountId}`,
		);
		expect(await found.json()).toMatchObject({
			running: 2,
			unexplained: 1,
			contradicted: 1,
		});
		list.mockRejectedValueOnce(new Error("private"));
		const failed = await fetch(
			`${origin}/api/live/orphan-inventory?bitmovinAccountId=${accountId}`,
		);
		expect(failed.status).toBe(502);
		expect(await failed.json()).toEqual({
			error: "Live inventory unavailable; count unknown",
		});
	});
});
