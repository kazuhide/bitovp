import { beforeEach, describe, expect, it, vi } from "vitest";

const getAccount = vi.fn();
const revealApiKey = vi.fn();
const writeAuditLog = vi.fn();

const unassign = vi.fn();

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
			encoding = { live: { streamKeys: { actions: { unassign } } } };
		},
		StreamKeysUnassignAction: Resource,
	};
});

import { POST } from "./route";

const ACCOUNT_ID = "3f1f0e8e-2c5b-4a4e-9a64-0f6f4d2c9b11";
const ENCODING_ID = "11112222-3333-4444-8555-666677778888";

function postRequest(body: unknown): Request {
	return new Request("http://test/api/live/stream-keys/unassign", {
		method: "POST",
		body: JSON.stringify(body),
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	getAccount.mockResolvedValue({ id: ACCOUNT_ID, tenantOrgId: null });
	revealApiKey.mockResolvedValue("bm-api-key");
});

describe("POST /api/live/stream-keys/unassign", () => {
	it("requires a UUID encodingId", async () => {
		for (const body of [
			{ bitmovinAccountId: ACCOUNT_ID },
			{ bitmovinAccountId: ACCOUNT_ID, encodingId: "enc-1" },
		]) {
			const res = await POST(postRequest(body));
			expect(res.status).toBe(400);
		}
		expect(unassign).not.toHaveBeenCalled();
	});

	it("unassigns every key held by the encoding and audits it", async () => {
		unassign.mockResolvedValueOnce({ encodingId: ENCODING_ID });
		const res = await POST(
			postRequest({
				bitmovinAccountId: ACCOUNT_ID,
				encodingId: ENCODING_ID,
			}),
		);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			encodingId: ENCODING_ID,
			unassigned: true,
		});
		expect(unassign).toHaveBeenCalledWith(
			expect.objectContaining({ encodingId: ENCODING_ID }),
		);
		const entry = writeAuditLog.mock.calls[0]?.[1] as Record<string, unknown>;
		expect(entry.path).toBe("/encoding/live/stream-keys/unassign");
		expect(entry.request).toEqual({ encodingId: ENCODING_ID });
	});

	it("maps an upstream 500 to 502", async () => {
		unassign.mockRejectedValueOnce(
			Object.assign(new Error("boom"), {
				httpStatusCode: 500,
				shortMessage: "Internal server error",
			}),
		);
		const res = await POST(
			postRequest({
				bitmovinAccountId: ACCOUNT_ID,
				encodingId: ENCODING_ID,
			}),
		);
		expect(res.status).toBe(502);
	});
});
