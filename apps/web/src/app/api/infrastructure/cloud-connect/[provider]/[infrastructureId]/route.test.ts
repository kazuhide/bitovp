import { beforeEach, describe, expect, it, vi } from "vitest";

const getAccount = vi.fn();
const revealApiKey = vi.fn();
const writeAuditLog = vi.fn();

const gceGet = vi.fn();
const gceDelete = vi.fn();

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
					aws: stub(),
					gce: { ...stub(), get: gceGet, delete: gceDelete },
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

function params(provider: string, infrastructureId = INFRA_ID) {
	return { params: Promise.resolve({ provider, infrastructureId }) };
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

describe("GET /api/infrastructure/cloud-connect/[provider]/[infrastructureId]", () => {
	it("strips GCE secret material defensively on read", async () => {
		gceGet.mockResolvedValueOnce({
			id: INFRA_ID,
			serviceAccountEmail: "sa@p.iam.gserviceaccount.com",
			projectId: "proj",
			privateKey: "SHOULD_NEVER_SURFACE",
			serviceAccountCredentials: "ALSO_NEVER",
		});
		const res = await GET(request(), params("gce"));
		expect(res.status).toBe(200);
		const text = JSON.stringify(await res.json());
		expect(text).toContain("sa@p.iam.gserviceaccount.com");
		expect(text).not.toContain("SHOULD_NEVER_SURFACE");
		expect(text).not.toContain("ALSO_NEVER");
	});

	it("maps an upstream 404 through (id purged upstream)", async () => {
		gceGet.mockRejectedValueOnce(
			Object.assign(new Error("full sdk message"), {
				httpStatusCode: 404,
				shortMessage: "Resource not found",
			}),
		);
		const res = await GET(request(), params("gce"));
		expect(res.status).toBe(404);
	});
});

describe("DELETE /api/infrastructure/cloud-connect/[provider]/[infrastructureId]", () => {
	it("deletes (the only mutation — no update API), audits, and scrubs the response", async () => {
		gceDelete.mockResolvedValueOnce({
			id: INFRA_ID,
			// Defensive: even if Bitmovin echoed secret material on delete,
			// the allowlist sanitizer must strip it.
			privateKey: "DELETE_ECHO_CANARY",
			serviceAccountCredentials: "DELETE_ECHO_CANARY_2",
		});
		const res = await DELETE(request("DELETE"), params("gce"));
		expect(res.status).toBe(200);
		expect(gceDelete).toHaveBeenCalledWith(INFRA_ID);
		const text = JSON.stringify(await res.json());
		expect(text).toContain(INFRA_ID);
		expect(text).not.toContain("DELETE_ECHO_CANARY");
		expect(writeAuditLog).toHaveBeenCalledTimes(1);
		const entry = writeAuditLog.mock.calls[0]?.[1] as Record<string, unknown>;
		expect(entry.method).toBe("DELETE");
		expect(entry.path).toBe(`/encoding/infrastructure/gce/${INFRA_ID}`);
		expect(JSON.stringify(entry)).not.toContain("DELETE_ECHO_CANARY");
	});

	it("rejects a non-uuid id before any SDK call", async () => {
		const res = await DELETE(request("DELETE"), params("gce", "../sneaky"));
		expect(res.status).toBe(400);
		expect(gceDelete).not.toHaveBeenCalled();
	});
});
