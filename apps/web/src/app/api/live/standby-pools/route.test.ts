import { beforeEach, describe, expect, it, vi } from "vitest";

const getAccount = vi.fn();
const revealApiKey = vi.fn();
const writeAuditLog = vi.fn();

const poolsCreate = vi.fn();
const poolsList = vi.fn();

vi.mock("@/lib/server/context", () => ({
	getServerContext: () => ({
		bitmovinAccounts: { get: getAccount, revealApiKey },
	}),
}));

vi.mock("@/lib/server/audit", () => ({
	writeAuditLog: (...args: unknown[]) => writeAuditLog(...args),
}));

vi.mock("@bitmovin/api-sdk", () => {
	class Resource {
		constructor(obj?: Record<string, unknown>) {
			Object.assign(this, obj);
		}
	}
	return {
		default: class MockBitmovinApi {
			encoding = {
				live: { standbyPools: { create: poolsCreate, list: poolsList } },
			};
		},
		LiveStandbyPoolRequest: Resource,
	};
});

import { GET, POST } from "./route";

const ACCOUNT_ID = "3f1f0e8e-2c5b-4a4e-9a64-0f6f4d2c9b11";
const TEMPLATE = "encodings:\n  - name: standby-live\n";

const validPool = {
	name: "breaking-news",
	targetPoolSize: 2,
	encodingTemplate: TEMPLATE,
};

function postRequest(body: unknown): Request {
	return new Request("http://test/api/live/standby-pools", {
		method: "POST",
		body: JSON.stringify(body),
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	getAccount.mockResolvedValue({ id: ACCOUNT_ID, tenantOrgId: null });
	revealApiKey.mockResolvedValue("bm-api-key");
});

describe("GET /api/live/standby-pools", () => {
	it("calls list() with NO arguments — the documented C6 exception", async () => {
		poolsList.mockResolvedValueOnce({ totalCount: 1, items: [] });
		const res = await GET(
			new Request(
				`http://test/api/live/standby-pools?bitmovinAccountId=${ACCOUNT_ID}&limit=101&offset=40`,
			),
		);
		expect(res.status).toBe(200);
		// offset/limit are NOT forwarded: this SDK list accepts no query params.
		expect(poolsList).toHaveBeenCalledWith();
	});

	it("projects the ready/preparing/error counts and poolStatus, dropping the template", async () => {
		poolsList.mockResolvedValueOnce({
			totalCount: 1,
			items: [
				{
					id: "pool-1",
					name: "breaking-news",
					targetPoolSize: 3,
					readyEncodings: 2,
					preparingEncodings: 1,
					errorEncodings: 0,
					poolStatus: "HEALTHY",
					encodingTemplate: "c2hvdWxkLW5vdC1iZS1pbi10aGUtbGlzdA==",
				},
			],
		});
		const res = await GET(
			new Request(
				`http://test/api/live/standby-pools?bitmovinAccountId=${ACCOUNT_ID}`,
			),
		);
		const body = (await res.json()) as { items: Record<string, unknown>[] };
		expect(body.items[0]).toEqual({
			id: "pool-1",
			name: "breaking-news",
			targetPoolSize: 3,
			readyEncodings: 2,
			preparingEncodings: 1,
			errorEncodings: 0,
			poolStatus: "HEALTHY",
		});
	});

	it("400s a missing bitmovinAccountId", async () => {
		const res = await GET(new Request("http://test/api/live/standby-pools"));
		expect(res.status).toBe(400);
	});
});

describe("POST /api/live/standby-pools", () => {
	it("requires a name, a template and a 1..100 integer targetPoolSize", async () => {
		for (const pool of [
			{ targetPoolSize: 1, encodingTemplate: TEMPLATE },
			{ name: "x", encodingTemplate: TEMPLATE },
			{ name: "x", targetPoolSize: 0, encodingTemplate: TEMPLATE },
			{ name: "x", targetPoolSize: 101, encodingTemplate: TEMPLATE },
			{ name: "x", targetPoolSize: 1.5, encodingTemplate: TEMPLATE },
			{ name: "x", targetPoolSize: 1, encodingTemplate: "" },
		]) {
			const res = await POST(
				postRequest({ bitmovinAccountId: ACCOUNT_ID, pool }),
			);
			expect(res.status).toBe(400);
		}
		expect(poolsCreate).not.toHaveBeenCalled();
	});

	it("base64-encodes the template server-side and never audits its body", async () => {
		poolsCreate.mockResolvedValueOnce({
			id: "pool-1",
			name: "breaking-news",
			targetPoolSize: 2,
			poolStatus: "HEALTHY",
			encodingTemplate: Buffer.from(TEMPLATE, "utf8").toString("base64"),
		});
		const res = await POST(
			postRequest({ bitmovinAccountId: ACCOUNT_ID, pool: validPool }),
		);
		expect(res.status).toBe(201);

		const payload = poolsCreate.mock.calls[0]?.[0] as {
			encodingTemplate: string;
		};
		expect(payload.encodingTemplate).toBe(
			Buffer.from(TEMPLATE, "utf8").toString("base64"),
		);

		// GET/create responses carry the raw b64 plus the decoded text.
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.encodingTemplateText).toBe(TEMPLATE);

		const entry = writeAuditLog.mock.calls[0]?.[1] as Record<string, unknown>;
		expect(entry.path).toBe("/encoding/live/standby-pools");
		expect(entry.request).toEqual({
			name: "breaking-news",
			targetPoolSize: 2,
			encodingTemplateChars: TEMPLATE.length,
		});
		expect(JSON.stringify(entry)).not.toContain("standby-live");
	});

	it("surfaces a curated upstream 422 for a bad template", async () => {
		poolsCreate.mockRejectedValueOnce(
			Object.assign(new Error("body: SHOULD_NOT_LEAK"), {
				httpStatusCode: 422,
				shortMessage: "encodingTemplate is not a valid encoding template",
			}),
		);
		const res = await POST(
			postRequest({ bitmovinAccountId: ACCOUNT_ID, pool: validPool }),
		);
		expect(res.status).toBe(422);
		const body = JSON.stringify(await res.json());
		expect(body).toContain("not a valid encoding template");
		expect(body).not.toContain("SHOULD_NOT_LEAK");
	});
});
