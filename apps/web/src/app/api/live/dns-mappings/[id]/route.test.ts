import { beforeEach, describe, expect, it, vi } from "vitest";

const getAccount = vi.fn();
const revealApiKey = vi.fn();
const writeAuditLog = vi.fn();

const mappingDelete = vi.fn();

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
			live: { encodings: { dnsMappings: { delete: mappingDelete } } },
		};
	},
}));

import { DELETE } from "./route";

const ACCOUNT_ID = "3f1f0e8e-2c5b-4a4e-9a64-0f6f4d2c9b11";
const ENCODING_ID = "11112222-3333-4444-8555-666677778888";
const MAPPING_ID = "22223333-4444-4555-8666-777788889999";

const params = { params: Promise.resolve({ id: MAPPING_ID }) };

function deleteRequest(qs: string): Request {
	return new Request(`http://test/api/live/dns-mappings/${MAPPING_ID}?${qs}`, {
		method: "DELETE",
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	getAccount.mockResolvedValue({ id: ACCOUNT_ID, tenantOrgId: null });
	revealApiKey.mockResolvedValue("bm-api-key");
});

describe("DELETE /api/live/dns-mappings/[id]", () => {
	it("400s without encodingId — the SDK delete has no account-level form", async () => {
		const res = await DELETE(
			deleteRequest(`bitmovinAccountId=${ACCOUNT_ID}`),
			params,
		);
		expect(res.status).toBe(400);
		expect(mappingDelete).not.toHaveBeenCalled();
	});

	it("deletes with the (encodingId, id) pair and audits", async () => {
		mappingDelete.mockResolvedValueOnce({ id: MAPPING_ID });
		const res = await DELETE(
			deleteRequest(
				`bitmovinAccountId=${ACCOUNT_ID}&encodingId=${ENCODING_ID}`,
			),
			params,
		);
		expect(res.status).toBe(200);
		expect(mappingDelete).toHaveBeenCalledWith(ENCODING_ID, MAPPING_ID);
		const entry = writeAuditLog.mock.calls[0]?.[1] as Record<string, unknown>;
		expect(entry.path).toBe(
			`/encoding/live/encodings/${ENCODING_ID}/dns-mappings/${MAPPING_ID}`,
		);
	});

	it("passes through a 404 for a mapping that is already gone", async () => {
		mappingDelete.mockRejectedValueOnce(
			Object.assign(new Error("nope"), {
				httpStatusCode: 404,
				shortMessage: "DNS mapping not found",
			}),
		);
		const res = await DELETE(
			deleteRequest(
				`bitmovinAccountId=${ACCOUNT_ID}&encodingId=${ENCODING_ID}`,
			),
			params,
		);
		expect(res.status).toBe(404);
	});
});
