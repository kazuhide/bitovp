import { beforeEach, describe, expect, it, vi } from "vitest";

const getAccount = vi.fn();
const revealApiKey = vi.fn();
const writeAuditLog = vi.fn();

const staticIpsGet = vi.fn();
const staticIpsDelete = vi.fn();

vi.mock("@/lib/server/context", () => ({
	getServerContext: () => ({
		bitmovinAccounts: { get: getAccount, revealApiKey },
	}),
}));

vi.mock("@/lib/server/audit", () => ({
	writeAuditLog: (...args: unknown[]) => writeAuditLog(...args),
}));

vi.mock("@bitmovin/api-sdk", () => ({
	default: class MockBitmovinApi {
		encoding = {
			infrastructure: {
				staticIps: {
					create: vi.fn(),
					get: staticIpsGet,
					delete: staticIpsDelete,
					list: vi.fn(),
				},
			},
		};
	},
	StaticIp: class {
		constructor(obj?: Record<string, unknown>) {
			Object.assign(this, obj);
		}
	},
}));

import { DELETE, GET } from "./route";

const ACCOUNT_ID = "3f1f0e8e-2c5b-4a4e-9a64-0f6f4d2c9b11";
const IP_ID = "1b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d";

function params(id = IP_ID) {
	return { params: Promise.resolve({ id }) };
}

function request(method = "GET"): Request {
	return new Request(`http://test/x?bitmovinAccountId=${ACCOUNT_ID}`, {
		method,
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	getAccount.mockResolvedValue({ id: ACCOUNT_ID, tenantOrgId: null });
	revealApiKey.mockResolvedValue("bm-api-key");
});

describe("GET /api/infrastructure/static-ips/[id]", () => {
	it("returns allowlist-sanitized details", async () => {
		staticIpsGet.mockResolvedValueOnce({
			id: IP_ID,
			ipAddress: "203.0.113.10",
			status: "UNUSED",
			internalField: "GET_ECHO_CANARY",
		});
		const res = await GET(request(), params());
		expect(res.status).toBe(200);
		const text = JSON.stringify(await res.json());
		expect(text).toContain("203.0.113.10");
		expect(text).not.toContain("GET_ECHO_CANARY");
	});
});

describe("DELETE /api/infrastructure/static-ips/[id]", () => {
	it("releases the IP, audits, and never echoes upstream response fields", async () => {
		staticIpsDelete.mockResolvedValueOnce({
			id: IP_ID,
			ipAddress: "203.0.113.10",
			// Defensive: the route answers {id} only — nothing else may leak.
			internalToken: "DELETE_ECHO_CANARY",
		});
		const res = await DELETE(request("DELETE"), params());
		expect(res.status).toBe(200);
		expect(staticIpsDelete).toHaveBeenCalledWith(IP_ID);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body).toEqual({ id: IP_ID });
		expect(JSON.stringify(body)).not.toContain("DELETE_ECHO_CANARY");

		expect(writeAuditLog).toHaveBeenCalledTimes(1);
		const entry = writeAuditLog.mock.calls[0]?.[1] as Record<string, unknown>;
		expect(entry.method).toBe("DELETE");
		expect(entry.path).toBe(`/encoding/infrastructure/static-ips/${IP_ID}`);
		expect(entry.statusCode).toBe(200);
		expect(JSON.stringify(entry)).not.toContain("DELETE_ECHO_CANARY");
	});

	it("rejects a non-uuid id before any SDK call", async () => {
		const res = await DELETE(request("DELETE"), params("../sneaky"));
		expect(res.status).toBe(400);
		expect(staticIpsDelete).not.toHaveBeenCalled();
	});

	it("passes an upstream 404 through, still audited", async () => {
		staticIpsDelete.mockRejectedValueOnce(
			Object.assign(new Error("full sdk message"), {
				httpStatusCode: 404,
				shortMessage: "Resource not found",
			}),
		);
		const res = await DELETE(request("DELETE"), params());
		expect(res.status).toBe(404);
		expect(writeAuditLog).toHaveBeenCalledTimes(1);
		const entry = writeAuditLog.mock.calls[0]?.[1] as Record<string, unknown>;
		expect(entry.statusCode).toBe(404);
	});
});
