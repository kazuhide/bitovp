import { beforeEach, describe, expect, it, vi } from "vitest";

const getAccount = vi.fn();
const revealApiKey = vi.fn();
const writeAuditLog = vi.fn();

const schedulesCreate = vi.fn();
const schedulesList = vi.fn();

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
					prewarmedEncoderPools: {
						schedules: {
							create: schedulesCreate,
							get: vi.fn(),
							delete: vi.fn(),
							list: schedulesList,
						},
					},
				},
			};
		},
		PrewarmedEncoderPoolSchedule: Resource,
	};
});

import { GET, POST } from "./route";

const ACCOUNT_ID = "3f1f0e8e-2c5b-4a4e-9a64-0f6f4d2c9b11";
const POOL_ID = "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a";

const params = { params: Promise.resolve({ poolId: POOL_ID }) };

function postRequest(body: unknown): Request {
	return new Request("http://test/schedules", {
		method: "POST",
		body: JSON.stringify(body),
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	getAccount.mockResolvedValue({ id: ACCOUNT_ID, tenantOrgId: null });
	revealApiKey.mockResolvedValue("bm-api-key");
});

describe("GET .../schedules", () => {
	it("lists with clamped paging", async () => {
		schedulesList.mockResolvedValueOnce({ totalCount: 0, items: [] });
		const res = await GET(
			new Request(
				`http://test/schedules?bitmovinAccountId=${ACCOUNT_ID}&limit=250`,
			),
			params,
		);
		expect(res.status).toBe(200);
		expect(schedulesList).toHaveBeenCalledWith(POOL_ID, {
			offset: 0,
			limit: 100,
		});
	});
});

describe("POST .../schedules", () => {
	it("rejects a non-ISO triggerDate and unknown actions", async () => {
		const badDate = await POST(
			postRequest({
				bitmovinAccountId: ACCOUNT_ID,
				schedule: { action: "START", triggerDate: "tomorrow at noon" },
			}),
			params,
		);
		expect(badDate.status).toBe(400);

		const badAction = await POST(
			postRequest({
				bitmovinAccountId: ACCOUNT_ID,
				schedule: { action: "PAUSE", triggerDate: "2026-08-06T14:00:00Z" },
			}),
			params,
		);
		expect(badAction.status).toBe(400);
		expect(schedulesCreate).not.toHaveBeenCalled();
	});

	it("creates a schedule (Date on the wire) and audits", async () => {
		schedulesCreate.mockResolvedValueOnce({
			id: "sched-1",
			action: "STOP",
			triggerDate: new Date("2026-08-06T14:00:00.000Z"),
		});
		const res = await POST(
			postRequest({
				bitmovinAccountId: ACCOUNT_ID,
				schedule: { action: "STOP", triggerDate: "2026-08-06T14:00:00Z" },
			}),
			params,
		);
		expect(res.status).toBe(201);
		expect(schedulesCreate).toHaveBeenCalledWith(
			POOL_ID,
			expect.objectContaining({
				action: "STOP",
				triggerDate: new Date("2026-08-06T14:00:00.000Z"),
			}),
		);
		const entry = writeAuditLog.mock.calls[0]?.[1] as Record<string, unknown>;
		expect(entry.path).toBe(
			`/encoding/infrastructure/prewarmed-encoder-pools/${POOL_ID}/schedules`,
		);
	});
});
