import { beforeEach, describe, expect, it, vi } from "vitest";

const getAccount = vi.fn();
const revealApiKey = vi.fn();
const writeAuditLog = vi.fn();

const awsRegionsCreate = vi.fn();
const awsRegionsList = vi.fn();
const akamaiRegionsCreate = vi.fn();

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
							create: awsRegionsCreate,
							get: vi.fn(),
							delete: vi.fn(),
							list: awsRegionsList,
						},
					},
					gce: stub(),
					azure: stub(),
					akamai: {
						...stub(),
						regions: {
							create: akamaiRegionsCreate,
							get: vi.fn(),
							delete: vi.fn(),
							list: vi.fn(),
						},
					},
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

import { GET, POST } from "./route";

const ACCOUNT_ID = "3f1f0e8e-2c5b-4a4e-9a64-0f6f4d2c9b11";
const INFRA_ID = "7a8b6c4d-1e2f-4a5b-8c9d-0e1f2a3b4c5d";

function params(provider: string, infrastructureId = INFRA_ID) {
	return { params: Promise.resolve({ provider, infrastructureId }) };
}

function postRequest(body: unknown): Request {
	return new Request("http://test/regions", {
		method: "POST",
		body: JSON.stringify(body),
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	getAccount.mockResolvedValue({ id: ACCOUNT_ID, tenantOrgId: null });
	revealApiKey.mockResolvedValue("bm-api-key");
});

describe("GET .../regions", () => {
	it("rejects a non-uuid infrastructure id from the URL", async () => {
		const res = await GET(
			new Request(`http://test/regions?bitmovinAccountId=${ACCOUNT_ID}`),
			params("aws", "not-a-uuid"),
		);
		expect(res.status).toBe(400);
	});

	it("lists with clamped paging", async () => {
		awsRegionsList.mockResolvedValueOnce({ totalCount: 0, items: [] });
		const res = await GET(
			new Request(
				`http://test/regions?bitmovinAccountId=${ACCOUNT_ID}&limit=300`,
			),
			params("aws"),
		);
		expect(res.status).toBe(200);
		expect(awsRegionsList).toHaveBeenCalledWith(INFRA_ID, {
			offset: 0,
			limit: 100,
		});
	});
});

describe("POST .../regions", () => {
	it("rejects a region outside the provider's enum", async () => {
		const res = await POST(
			postRequest({
				bitmovinAccountId: ACCOUNT_ID,
				region: "MOON_BASE_1",
				settings: { securityGroupId: "sg-1", subnetId: "subnet-1" },
			}),
			params("aws"),
		);
		expect(res.status).toBe(400);
		expect(awsRegionsCreate).not.toHaveBeenCalled();
	});

	it("rejects an out-of-range sshPort (1–65535)", async () => {
		const res = await POST(
			postRequest({
				bitmovinAccountId: ACCOUNT_ID,
				region: "EU_WEST_1",
				settings: {
					securityGroupId: "sg-1",
					subnetId: "subnet-1",
					sshPort: 70000,
				},
			}),
			params("aws"),
		);
		expect(res.status).toBe(400);
	});

	it("creates AWS region settings (region becomes the path param) and audits", async () => {
		awsRegionsCreate.mockResolvedValueOnce({
			id: "rs-1",
			region: "EU_WEST_1",
			securityGroupId: "sg-1",
			subnetId: "subnet-1",
		});
		const res = await POST(
			postRequest({
				bitmovinAccountId: ACCOUNT_ID,
				region: "EU_WEST_1",
				settings: { securityGroupId: "sg-1", subnetId: "subnet-1" },
			}),
			params("aws"),
		);
		expect(res.status).toBe(201);
		expect(awsRegionsCreate).toHaveBeenCalledWith(
			INFRA_ID,
			"EU_WEST_1",
			expect.objectContaining({
				securityGroupId: "sg-1",
				subnetId: "subnet-1",
			}),
		);
		const entry = writeAuditLog.mock.calls[0]?.[1] as Record<string, unknown>;
		expect(entry.path).toBe(
			`/encoding/infrastructure/aws/${INFRA_ID}/regions/EU_WEST_1`,
		);
	});

	it("types Akamai ids as NUMBERS (strings 400)", async () => {
		const stringy = await POST(
			postRequest({
				bitmovinAccountId: ACCOUNT_ID,
				region: "JP_OSA",
				settings: { subnetId: "123", firewallId: "456" },
			}),
			params("akamai"),
		);
		expect(stringy.status).toBe(400);
		expect(akamaiRegionsCreate).not.toHaveBeenCalled();

		akamaiRegionsCreate.mockResolvedValueOnce({
			id: "rs-2",
			region: "JP_OSA",
			subnetId: 123,
			firewallId: 456,
		});
		const numeric = await POST(
			postRequest({
				bitmovinAccountId: ACCOUNT_ID,
				region: "JP_OSA",
				settings: { subnetId: 123, firewallId: 456 },
			}),
			params("akamai"),
		);
		expect(numeric.status).toBe(201);
		expect(akamaiRegionsCreate).toHaveBeenCalledWith(
			INFRA_ID,
			"JP_OSA",
			expect.objectContaining({ subnetId: 123, firewallId: 456 }),
		);
	});
});
