import { beforeEach, describe, expect, it, vi } from "vitest";

const getAccount = vi.fn();
const revealApiKey = vi.fn();
const writeAuditLog = vi.fn();

const awsCreate = vi.fn();
const awsList = vi.fn();
const gceCreate = vi.fn();
const akamaiCreate = vi.fn();

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
					aws: { ...stub(), create: awsCreate, list: awsList },
					gce: { ...stub(), create: gceCreate },
					azure: stub(),
					akamai: { ...stub(), create: akamaiCreate },
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

function params(provider: string) {
	return { params: Promise.resolve({ provider }) };
}

function postRequest(body: unknown): Request {
	return new Request("http://test/api/infrastructure/cloud-connect/aws", {
		method: "POST",
		body: JSON.stringify(body),
	});
}

function getRequest(query: string): Request {
	return new Request(
		`http://test/api/infrastructure/cloud-connect/aws?${query}`,
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	getAccount.mockResolvedValue({ id: ACCOUNT_ID, tenantOrgId: null });
	revealApiKey.mockResolvedValue("bm-api-key");
});

describe("GET /api/infrastructure/cloud-connect/[provider]", () => {
	it("404s unknown providers before touching anything", async () => {
		const res = await GET(getRequest(""), params("k8s"));
		expect(res.status).toBe(404);
		expect(getAccount).not.toHaveBeenCalled();
	});

	it("requires a bitmovinAccountId", async () => {
		const res = await GET(getRequest(""), params("aws"));
		expect(res.status).toBe(400);
	});

	it("clamps limit to 100 (C6) and passes offset through", async () => {
		awsList.mockResolvedValueOnce({
			totalCount: 0,
			offset: 40,
			limit: 100,
			items: [],
		});
		const res = await GET(
			getRequest(`bitmovinAccountId=${ACCOUNT_ID}&offset=40&limit=500`),
			params("aws"),
		);
		expect(res.status).toBe(200);
		expect(awsList).toHaveBeenCalledWith({ offset: 40, limit: 100 });
	});

	it("strips secret fields from listed accounts and drops link fields", async () => {
		awsList.mockResolvedValueOnce({
			totalCount: 1,
			offset: 0,
			limit: 25,
			previous: "https://api.bitmovin.com/should-not-leak",
			items: [
				{
					id: "acc-1",
					name: "byoc",
					accountNumber: "123456789012",
					accessKey: "LEAKED_ACCESS",
					secretKey: "LEAKED_SECRET",
				},
			],
		});
		const res = await GET(
			getRequest(`bitmovinAccountId=${ACCOUNT_ID}`),
			params("aws"),
		);
		expect(res.status).toBe(200);
		const text = JSON.stringify(await res.json());
		expect(text).toContain("123456789012");
		expect(text).not.toContain("LEAKED_ACCESS");
		expect(text).not.toContain("LEAKED_SECRET");
		expect(text).not.toContain("should-not-leak");
	});

	it("404s when the Bitmovin account row does not exist", async () => {
		getAccount.mockResolvedValueOnce(null);
		const res = await GET(
			getRequest(`bitmovinAccountId=${ACCOUNT_ID}`),
			params("aws"),
		);
		expect(res.status).toBe(404);
		expect(revealApiKey).not.toHaveBeenCalled();
	});
});

describe("POST /api/infrastructure/cloud-connect/[provider]", () => {
	it("rejects a missing accountNumber (AWS required field)", async () => {
		const res = await POST(
			postRequest({
				bitmovinAccountId: ACCOUNT_ID,
				account: { roleName: "bitmovin" },
			}),
			params("aws"),
		);
		expect(res.status).toBe(400);
		expect(awsCreate).not.toHaveBeenCalled();
	});

	it("400s an unexpected secret-looking field instead of dropping it (strict)", async () => {
		const res = await POST(
			postRequest({
				bitmovinAccountId: ACCOUNT_ID,
				account: {
					accountNumber: "123456789012",
					password: "should-never-be-silently-dropped",
				},
			}),
			params("aws"),
		);
		expect(res.status).toBe(400);
		expect(awsCreate).not.toHaveBeenCalled();
	});

	it("rejects accessKey without secretKey (legacy keys travel together)", async () => {
		const res = await POST(
			postRequest({
				bitmovinAccountId: ACCOUNT_ID,
				account: { accountNumber: "123456789012", accessKey: "AKIA..." },
			}),
			params("aws"),
		);
		expect(res.status).toBe(400);
	});

	it("creates, audits with presence flags, and never echoes secrets", async () => {
		awsCreate.mockResolvedValueOnce({
			id: "infra-1",
			name: "byoc",
			accountNumber: "123456789012",
			// defensive: even if Bitmovin echoed the key, it must not pass.
			accessKey: "ECHOED_ACCESS_KEY",
			secretKey: "ECHOED_SECRET_KEY",
		});
		const res = await POST(
			postRequest({
				bitmovinAccountId: ACCOUNT_ID,
				account: {
					name: "byoc",
					accountNumber: "123456789012",
					accessKey: "PLAINTEXT_ACCESS",
					secretKey: "PLAINTEXT_SECRET",
				},
			}),
			params("aws"),
		);
		expect(res.status).toBe(201);
		const text = JSON.stringify(await res.json());
		expect(text).toContain("infra-1");
		expect(text).not.toContain("ECHOED_ACCESS_KEY");
		expect(text).not.toContain("PLAINTEXT_ACCESS");

		expect(writeAuditLog).toHaveBeenCalledTimes(1);
		const entry = writeAuditLog.mock.calls[0]?.[1] as Record<string, unknown>;
		expect(entry.method).toBe("POST");
		expect(entry.path).toBe("/encoding/infrastructure/aws");
		expect(entry.bitmovinAccountId).toBe(ACCOUNT_ID);
		const auditText = JSON.stringify(entry);
		expect(auditText).toContain('"accessKeyProvided":true');
		expect(auditText).toContain('"secretKeyProvided":true');
		expect(auditText).not.toContain("PLAINTEXT_ACCESS");
		expect(auditText).not.toContain("PLAINTEXT_SECRET");
	});

	it("enforces the GCE one-of (JSON xor email/key/project)", async () => {
		const both = await POST(
			postRequest({
				bitmovinAccountId: ACCOUNT_ID,
				account: {
					serviceAccountCredentials: "{}",
					serviceAccountEmail: "sa@p.iam.gserviceaccount.com",
					privateKey: "k",
					projectId: "p",
				},
			}),
			params("gce"),
		);
		expect(both.status).toBe(400);

		const partial = await POST(
			postRequest({
				bitmovinAccountId: ACCOUNT_ID,
				account: { serviceAccountEmail: "sa@p.iam.gserviceaccount.com" },
			}),
			params("gce"),
		);
		expect(partial.status).toBe(400);
		expect(gceCreate).not.toHaveBeenCalled();

		gceCreate.mockResolvedValueOnce({ id: "infra-2" });
		const ok = await POST(
			postRequest({
				bitmovinAccountId: ACCOUNT_ID,
				account: { serviceAccountCredentials: '{"type":"service_account"}' },
			}),
			params("gce"),
		);
		expect(ok.status).toBe(201);
	});

	it("maps an upstream 403 to 502 with the curated message and audits it", async () => {
		// An upstream 401/403/429 is OUR standing with Bitmovin, not the
		// browser's — reflecting it could log the operator out once app auth
		// lands. It becomes 502; the audit row keeps the real upstream status.
		const sdkError = Object.assign(
			new Error("request:\n method: POST\n body: {'apiToken':'RAW_BODY_LEAK'}"),
			{ httpStatusCode: 403, shortMessage: "Insufficient permissions" },
		);
		akamaiCreate.mockRejectedValueOnce(sdkError);
		const res = await POST(
			postRequest({
				bitmovinAccountId: ACCOUNT_ID,
				account: { apiToken: "akamai-token" },
			}),
			params("akamai"),
		);
		expect(res.status).toBe(502);
		const body = JSON.stringify(await res.json());
		expect(body).toContain("Insufficient permissions");
		expect(body).not.toContain("RAW_BODY_LEAK");
		expect(body).not.toContain("akamai-token");

		const entry = writeAuditLog.mock.calls[0]?.[1] as Record<string, unknown>;
		expect(entry.statusCode).toBe(403);
		const auditText = JSON.stringify(entry);
		expect(auditText).toContain('"apiTokenProvided":true');
		expect(auditText).not.toContain("akamai-token");
		expect(auditText).not.toContain("RAW_BODY_LEAK");
	});

	it("rejects oversize secret material before it reaches Bitmovin", async () => {
		const res = await POST(
			postRequest({
				bitmovinAccountId: ACCOUNT_ID,
				account: {
					accountNumber: "123456789012",
					accessKey: "A".repeat(8193),
					secretKey: "S",
				},
			}),
			params("aws"),
		);
		expect(res.status).toBe(400);
		expect(awsCreate).not.toHaveBeenCalled();
	});

	it("caps customData at 8192 serialized chars", async () => {
		const res = await POST(
			postRequest({
				bitmovinAccountId: ACCOUNT_ID,
				account: {
					accountNumber: "123456789012",
					customData: { blob: "x".repeat(9000) },
				},
			}),
			params("aws"),
		);
		expect(res.status).toBe(400);
		expect(awsCreate).not.toHaveBeenCalled();
	});
});
