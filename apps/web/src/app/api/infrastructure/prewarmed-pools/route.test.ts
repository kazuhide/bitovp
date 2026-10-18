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
				infrastructure: {
					prewarmedEncoderPools: {
						create: poolsCreate,
						get: vi.fn(),
						delete: vi.fn(),
						list: poolsList,
						start: vi.fn(),
						stop: vi.fn(),
						schedules: {
							create: vi.fn(),
							get: vi.fn(),
							delete: vi.fn(),
							list: vi.fn(),
						},
					},
				},
			};
		},
		PrewarmedEncoderPool: Resource,
		PrewarmedEncoderPoolSchedule: Resource,
	};
});

import { GET, POST } from "./route";

const ACCOUNT_ID = "3f1f0e8e-2c5b-4a4e-9a64-0f6f4d2c9b11";

const validPool = {
	name: "evening-rush",
	encoderVersion: "STABLE",
	cloudRegion: "AWS_EU_WEST_1",
	diskSize: "500",
	targetPoolSize: 2,
};

function postRequest(body: unknown): Request {
	return new Request("http://test/api/infrastructure/prewarmed-pools", {
		method: "POST",
		body: JSON.stringify(body),
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	getAccount.mockResolvedValue({ id: ACCOUNT_ID, tenantOrgId: null });
	revealApiKey.mockResolvedValue("bm-api-key");
});

describe("GET /api/infrastructure/prewarmed-pools", () => {
	it("clamps limit to 100 (C6)", async () => {
		poolsList.mockResolvedValueOnce({ totalCount: 0, items: [] });
		const res = await GET(
			new Request(
				`http://test/api/infrastructure/prewarmed-pools?bitmovinAccountId=${ACCOUNT_ID}&limit=101`,
			),
		);
		expect(res.status).toBe(200);
		expect(poolsList).toHaveBeenCalledWith({ offset: 0, limit: 100 });
	});
});

describe("POST /api/infrastructure/prewarmed-pools", () => {
	it.each([
		"AUTO",
		"EUROPE",
		"GOOGLE",
		"NORTH_AMERICA",
	])("rejects non-specific cloudRegion %s (the API would too)", async (cloudRegion) => {
		const res = await POST(
			postRequest({
				bitmovinAccountId: ACCOUNT_ID,
				pool: { ...validPool, cloudRegion },
			}),
		);
		expect(res.status).toBe(400);
		expect(poolsCreate).not.toHaveBeenCalled();
	});

	it("rejects cloudRegion EXTERNAL without infrastructureId (managed cloud needs a real region)", async () => {
		const res = await POST(
			postRequest({
				bitmovinAccountId: ACCOUNT_ID,
				pool: { ...validPool, cloudRegion: "EXTERNAL" },
			}),
		);
		expect(res.status).toBe(400);
		expect(poolsCreate).not.toHaveBeenCalled();
	});

	it("accepts cloudRegion EXTERNAL WITH infrastructureId (C18-inferred BYOC pool) and calls the SDK", async () => {
		const infrastructureId = "7a8b6c4d-1e2f-4a5b-8c9d-0e1f2a3b4c5d";
		poolsCreate.mockResolvedValueOnce({
			id: "pool-byoc",
			cloudRegion: "EXTERNAL",
			infrastructureId,
			status: "STOPPED",
		});
		const res = await POST(
			postRequest({
				bitmovinAccountId: ACCOUNT_ID,
				pool: { ...validPool, cloudRegion: "EXTERNAL", infrastructureId },
			}),
		);
		expect(res.status).toBe(201);
		expect(poolsCreate).toHaveBeenCalledWith(
			expect.objectContaining({ cloudRegion: "EXTERNAL", infrastructureId }),
		);
	});

	it("rejects a diskSize outside 500/1000/2000", async () => {
		const res = await POST(
			postRequest({
				bitmovinAccountId: ACCOUNT_ID,
				pool: { ...validPool, diskSize: "750" },
			}),
		);
		expect(res.status).toBe(400);
	});

	it("rejects a targetPoolSize below 1, above 100, and non-integers", async () => {
		for (const targetPoolSize of [0, 1.5, 101]) {
			const res = await POST(
				postRequest({
					bitmovinAccountId: ACCOUNT_ID,
					pool: { ...validPool, targetPoolSize },
				}),
			);
			expect(res.status).toBe(400);
		}
	});

	it("creates a pool and audits the snapshot (no secrets exist here)", async () => {
		poolsCreate.mockResolvedValueOnce({
			id: "pool-1",
			...validPool,
			status: "STOPPED",
		});
		const res = await POST(
			postRequest({
				bitmovinAccountId: ACCOUNT_ID,
				pool: { ...validPool, dynamicPool: true, gpuEnabled: false },
			}),
		);
		expect(res.status).toBe(201);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.id).toBe("pool-1");
		expect(body.status).toBe("STOPPED");

		expect(poolsCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				cloudRegion: "AWS_EU_WEST_1",
				diskSize: "500",
				targetPoolSize: 2,
				dynamicPool: true,
			}),
		);
		const entry = writeAuditLog.mock.calls[0]?.[1] as Record<string, unknown>;
		expect(entry.path).toBe("/encoding/infrastructure/prewarmed-encoder-pools");
		expect(entry.statusCode).toBe(201);
	});
});
