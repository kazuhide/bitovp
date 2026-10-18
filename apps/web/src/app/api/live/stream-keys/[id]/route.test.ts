import { beforeEach, describe, expect, it, vi } from "vitest";

const getAccount = vi.fn();
const revealApiKey = vi.fn();
const writeAuditLog = vi.fn();

const keysDelete = vi.fn();

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
		encoding = { live: { streamKeys: { delete: keysDelete } } };
	},
}));

import { DELETE } from "./route";

const ACCOUNT_ID = "3f1f0e8e-2c5b-4a4e-9a64-0f6f4d2c9b11";
const KEY_ID = "22223333-4444-4555-8666-777788889999";

const params = { params: Promise.resolve({ id: KEY_ID }) };

function deleteRequest(qs: string): Request {
	return new Request(`http://test/api/live/stream-keys/${KEY_ID}?${qs}`, {
		method: "DELETE",
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	getAccount.mockResolvedValue({ id: ACCOUNT_ID, tenantOrgId: null });
	revealApiKey.mockResolvedValue("bm-api-key");
});

describe("DELETE /api/live/stream-keys/[id]", () => {
	it("400s a non-UUID key id", async () => {
		const res = await DELETE(deleteRequest(`bitmovinAccountId=${ACCOUNT_ID}`), {
			params: Promise.resolve({ id: "studio-a" }),
		});
		expect(res.status).toBe(400);
		expect(keysDelete).not.toHaveBeenCalled();
	});

	it("400s a missing bitmovinAccountId", async () => {
		const res = await DELETE(deleteRequest(""), params);
		expect(res.status).toBe(400);
	});

	it("deletes and audits", async () => {
		keysDelete.mockResolvedValueOnce({ id: KEY_ID });
		const res = await DELETE(
			deleteRequest(`bitmovinAccountId=${ACCOUNT_ID}`),
			params,
		);
		expect(res.status).toBe(200);
		expect(keysDelete).toHaveBeenCalledWith(KEY_ID);
		const entry = writeAuditLog.mock.calls[0]?.[1] as Record<string, unknown>;
		expect(entry.method).toBe("DELETE");
		expect(entry.path).toBe(`/encoding/live/stream-keys/${KEY_ID}`);
	});

	it("passes through the 409 for an ASSIGNED key", async () => {
		keysDelete.mockRejectedValueOnce(
			Object.assign(new Error("body: SHOULD_NOT_LEAK"), {
				httpStatusCode: 409,
				shortMessage: "Stream key is assigned to an encoding",
			}),
		);
		const res = await DELETE(
			deleteRequest(`bitmovinAccountId=${ACCOUNT_ID}`),
			params,
		);
		expect(res.status).toBe(409);
		const body = JSON.stringify(await res.json());
		expect(body).toContain("assigned to an encoding");
		expect(body).not.toContain("SHOULD_NOT_LEAK");
	});

	it("logs and 500s a non-HTTP SDK failure (our bug, not Bitmovin's)", async () => {
		const consoleError = vi
			.spyOn(console, "error")
			.mockImplementation(() => undefined);
		keysDelete.mockRejectedValueOnce(new TypeError("api is not a function"));
		const res = await DELETE(
			deleteRequest(`bitmovinAccountId=${ACCOUNT_ID}`),
			params,
		);
		expect(res.status).toBe(500);
		expect(consoleError).toHaveBeenCalled();
		consoleError.mockRestore();
	});
});
