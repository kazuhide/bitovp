import { beforeEach, describe, expect, it, vi } from "vitest";

const getAccount = vi.fn();
const revealApiKey = vi.fn();
const writeAuditLog = vi.fn();

const ipsCreate = vi.fn();
const ipsList = vi.fn();

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
				infrastructure: {
					staticIps: {
						create: ipsCreate,
						get: vi.fn(),
						delete: vi.fn(),
						list: ipsList,
					},
				},
			};
		},
		StaticIp: Resource,
	};
});

import { GET, POST } from "./route";

const ACCOUNT_ID = "3f1f0e8e-2c5b-4a4e-9a64-0f6f4d2c9b11";
const INFRA_ID = "7a8b6c4d-1e2f-4a5b-8c9d-0e1f2a3b4c5d";

function postRequest(body: unknown): Request {
	return new Request("http://test/api/infrastructure/static-ips", {
		method: "POST",
		body: JSON.stringify(body),
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	getAccount.mockResolvedValue({ id: ACCOUNT_ID, tenantOrgId: null });
	revealApiKey.mockResolvedValue("bm-api-key");
});

describe("GET /api/infrastructure/static-ips", () => {
	it("clamps limit to 100 (C6)", async () => {
		ipsList.mockResolvedValueOnce({ totalCount: 0, items: [] });
		const res = await GET(
			new Request(
				`http://test/api/infrastructure/static-ips?bitmovinAccountId=${ACCOUNT_ID}&limit=999`,
			),
		);
		expect(res.status).toBe(200);
		expect(ipsList).toHaveBeenCalledWith({ offset: 0, limit: 100 });
	});

	it("passes status/ipAddress through the allowlist", async () => {
		ipsList.mockResolvedValueOnce({
			totalCount: 1,
			items: [
				{
					id: "ip-1",
					ipAddress: "203.0.113.10",
					status: "UNUSED",
					region: "AWS_EU_WEST_1",
					unexpectedField: "DROP_ME",
				},
			],
		});
		const res = await GET(
			new Request(
				`http://test/api/infrastructure/static-ips?bitmovinAccountId=${ACCOUNT_ID}`,
			),
		);
		const text = JSON.stringify(await res.json());
		expect(text).toContain("203.0.113.10");
		expect(text).toContain("UNUSED");
		expect(text).not.toContain("DROP_ME");
	});
});

describe("POST /api/infrastructure/static-ips", () => {
	it("requires a CloudRegion enum value", async () => {
		const res = await POST(
			postRequest({
				bitmovinAccountId: ACCOUNT_ID,
				staticIp: { region: "MARS_1" },
			}),
		);
		expect(res.status).toBe(400);
		expect(ipsCreate).not.toHaveBeenCalled();
	});

	it("400s unexpected fields (BitmovinResponse — no name/description)", async () => {
		const res = await POST(
			postRequest({
				bitmovinAccountId: ACCOUNT_ID,
				staticIp: { region: "AWS_EU_WEST_1", name: "my-ip" },
			}),
		);
		expect(res.status).toBe(400);
	});

	it("creates (optionally pinned to an AWS infrastructure) and audits", async () => {
		ipsCreate.mockResolvedValueOnce({
			id: "ip-1",
			region: "AWS_EU_WEST_1",
			infrastructureId: INFRA_ID,
			status: "CREATING",
		});
		const res = await POST(
			postRequest({
				bitmovinAccountId: ACCOUNT_ID,
				staticIp: { region: "AWS_EU_WEST_1", infrastructureId: INFRA_ID },
			}),
		);
		expect(res.status).toBe(201);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.status).toBe("CREATING");

		expect(writeAuditLog).toHaveBeenCalledTimes(1);
		const entry = writeAuditLog.mock.calls[0]?.[1] as Record<string, unknown>;
		expect(entry.method).toBe("POST");
		expect(entry.path).toBe("/encoding/infrastructure/static-ips");
		expect(entry.request).toEqual({
			region: "AWS_EU_WEST_1",
			infrastructureId: INFRA_ID,
		});
	});
});
