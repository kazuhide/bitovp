import { beforeEach, describe, expect, it, vi } from "vitest";

const getAccount = vi.fn();
const revealApiKey = vi.fn();
const writeAuditLog = vi.fn();

const schedulesGet = vi.fn();
const schedulesDelete = vi.fn();

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
				prewarmedEncoderPools: {
					schedules: {
						create: vi.fn(),
						get: schedulesGet,
						delete: schedulesDelete,
						list: vi.fn(),
					},
				},
			},
		};
	},
	PrewarmedEncoderPoolSchedule: class {
		constructor(obj?: Record<string, unknown>) {
			Object.assign(this, obj);
		}
	},
}));

import { DELETE, GET } from "./route";

const ACCOUNT_ID = "3f1f0e8e-2c5b-4a4e-9a64-0f6f4d2c9b11";
const POOL_ID = "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a";
const SCHEDULE_ID = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

function params(poolId = POOL_ID, scheduleId = SCHEDULE_ID) {
	return { params: Promise.resolve({ poolId, scheduleId }) };
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

describe("GET /api/infrastructure/prewarmed-pools/[poolId]/schedules/[scheduleId]", () => {
	it("returns allowlist-sanitized schedule details", async () => {
		schedulesGet.mockResolvedValueOnce({
			id: SCHEDULE_ID,
			action: "START",
			triggerDate: "2026-08-06T14:00:00Z",
			internalField: "GET_ECHO_CANARY",
		});
		const res = await GET(request(), params());
		expect(res.status).toBe(200);
		expect(schedulesGet).toHaveBeenCalledWith(POOL_ID, SCHEDULE_ID);
		const text = JSON.stringify(await res.json());
		expect(text).toContain("START");
		expect(text).not.toContain("GET_ECHO_CANARY");
	});
});

describe("DELETE /api/infrastructure/prewarmed-pools/[poolId]/schedules/[scheduleId]", () => {
	it("deletes the schedule, audits, and never echoes upstream response fields", async () => {
		schedulesDelete.mockResolvedValueOnce({
			id: SCHEDULE_ID,
			// Defensive: the route answers {id} only — nothing else may leak.
			internalToken: "DELETE_ECHO_CANARY",
		});
		const res = await DELETE(request("DELETE"), params());
		expect(res.status).toBe(200);
		expect(schedulesDelete).toHaveBeenCalledWith(POOL_ID, SCHEDULE_ID);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body).toEqual({ id: SCHEDULE_ID });
		expect(JSON.stringify(body)).not.toContain("DELETE_ECHO_CANARY");

		expect(writeAuditLog).toHaveBeenCalledTimes(1);
		const entry = writeAuditLog.mock.calls[0]?.[1] as Record<string, unknown>;
		expect(entry.method).toBe("DELETE");
		expect(entry.path).toBe(
			`/encoding/infrastructure/prewarmed-encoder-pools/${POOL_ID}/schedules/${SCHEDULE_ID}`,
		);
		expect(JSON.stringify(entry)).not.toContain("DELETE_ECHO_CANARY");
	});

	it("rejects a non-uuid schedule id before any SDK call", async () => {
		const res = await DELETE(request("DELETE"), params(POOL_ID, "../sneaky"));
		expect(res.status).toBe(400);
		expect(schedulesDelete).not.toHaveBeenCalled();
	});
});
