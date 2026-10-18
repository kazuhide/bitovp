import { beforeEach, describe, expect, it, vi } from "vitest";

const getAccount = vi.fn();
const revealApiKey = vi.fn();
const writeAuditLog = vi.fn();

const awsRegionsGet = vi.fn();
const awsRegionsDelete = vi.fn();

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
	const stub = () => ({
		create: vi.fn(),
		get: vi.fn(),
		delete: vi.fn(),
		list: vi.fn(),
		regions: {
			create: vi.fn(),
			get: vi.fn(),
			delete: vi.fn(),
			list: vi.fn(),
		},
	});
	return {
		default: class MockBitmovinApi {
			encoding = {
				infrastructure: {
					aws: {
						...stub(),
						regions: {
							create: vi.fn(),
							get: awsRegionsGet,
							delete: awsRegionsDelete,
							list: vi.fn(),
						},
					},
					gce: stub(),
					azure: stub(),
					akamai: stub(),
					oci: stub(),
				},
			};
		},
		AwsAccount: Resource,
		GceAccount: Resource,
		AzureAccount: Resource,
		AkamaiAccount: Resource,
		OciAccount: Resource,
		AwsAccountRegionSettings: Resource,
		GceAccountRegionSettings: Resource,
		AzureAccountRegionSettings: Resource,
		AkamaiAccountRegionSettings: Resource,
		OciAccountRegionSettings: Resource,
		StaticIp: Resource,
		PrewarmedEncoderPool: Resource,
		PrewarmedEncoderPoolSchedule: Resource,
	};
});

import { DELETE, GET } from "./route";

const ACCOUNT_ID = "3f1f0e8e-2c5b-4a4e-9a64-0f6f4d2c9b11";
const INFRA_ID = "7a8b6c4d-1e2f-4a5b-8c9d-0e1f2a3b4c5d";

function params(provider: string, region: string, infrastructureId = INFRA_ID) {
	return { params: Promise.resolve({ provider, infrastructureId, region }) };
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

describe("GET /api/infrastructure/cloud-connect/[provider]/[infrastructureId]/regions/[region]", () => {
	it("404s a region outside the provider's enum before any SDK call", async () => {
		const res = await GET(request(), params("aws", "EUROPE_WEST_1"));
		expect(res.status).toBe(404);
		expect(awsRegionsGet).not.toHaveBeenCalled();
	});

	it("returns allowlist-sanitized settings", async () => {
		awsRegionsGet.mockResolvedValueOnce({
			region: "EU_WEST_1",
			securityGroupId: "sg-123",
			subnetId: "subnet-456",
			internalField: "GET_ECHO_CANARY",
		});
		const res = await GET(request(), params("aws", "EU_WEST_1"));
		expect(res.status).toBe(200);
		const text = JSON.stringify(await res.json());
		expect(text).toContain("sg-123");
		expect(text).not.toContain("GET_ECHO_CANARY");
	});
});

describe("DELETE /api/infrastructure/cloud-connect/[provider]/[infrastructureId]/regions/[region]", () => {
	it("deletes, audits, and scrubs non-allowlisted fields from the response", async () => {
		awsRegionsDelete.mockResolvedValueOnce({
			region: "EU_WEST_1",
			securityGroupId: "sg-123",
			// Defensive: anything outside the allowlist must not surface.
			credentials: "DELETE_ECHO_CANARY",
		});
		const res = await DELETE(request("DELETE"), params("aws", "EU_WEST_1"));
		expect(res.status).toBe(200);
		expect(awsRegionsDelete).toHaveBeenCalledWith(INFRA_ID, "EU_WEST_1");
		const text = JSON.stringify(await res.json());
		expect(text).toContain("EU_WEST_1");
		expect(text).not.toContain("DELETE_ECHO_CANARY");

		expect(writeAuditLog).toHaveBeenCalledTimes(1);
		const entry = writeAuditLog.mock.calls[0]?.[1] as Record<string, unknown>;
		expect(entry.method).toBe("DELETE");
		expect(entry.path).toBe(
			`/encoding/infrastructure/aws/${INFRA_ID}/regions/EU_WEST_1`,
		);
		expect(JSON.stringify(entry)).not.toContain("DELETE_ECHO_CANARY");
	});

	it("rejects a non-uuid infrastructure id before any SDK call", async () => {
		const res = await DELETE(
			request("DELETE"),
			params("aws", "EU_WEST_1", "../sneaky"),
		);
		expect(res.status).toBe(400);
		expect(awsRegionsDelete).not.toHaveBeenCalled();
	});
});
