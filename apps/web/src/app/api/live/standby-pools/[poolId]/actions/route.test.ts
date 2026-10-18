import { redactSecrets } from "@bitovp/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getAccount = vi.fn();
const revealApiKey = vi.fn();
/** Records what would actually LAND IN THE DB ROW (see stream-keys test). */
const persistedAudit = vi.fn();

const acquireEncoding = vi.fn();
const deleteErrorEncodings = vi.fn();

vi.mock("@/lib/server/context", () => ({
	getServerContext: () => ({
		bitmovinAccounts: { get: getAccount, revealApiKey },
	}),
}));

vi.mock("@/lib/server/audit", () => ({
	writeAuditLog: (_ctx: unknown, entry: Record<string, unknown>) => {
		persistedAudit({
			...entry,
			...(entry.request !== undefined
				? { request: redactSecrets(entry.request) }
				: {}),
			...(entry.response !== undefined
				? { response: redactSecrets(entry.response) }
				: {}),
		});
		return Promise.resolve();
	},
}));

vi.mock("@bitmovin/api-sdk", () => ({
	default: class MockBitmovinApi {
		encoding = {
			live: {
				standbyPools: { actions: { acquireEncoding, deleteErrorEncodings } },
			},
		};
	},
}));

import { POST } from "./route";

const ACCOUNT_ID = "3f1f0e8e-2c5b-4a4e-9a64-0f6f4d2c9b11";
const POOL_ID = "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a";
const ENCODING_ID = "11112222-3333-4444-8555-666677778888";
const STREAM_KEY = "sk-standby-DO-NOT-PERSIST";

const params = { params: Promise.resolve({ poolId: POOL_ID }) };

const acquired = {
	id: "pool-enc-1",
	encodingId: ENCODING_ID,
	status: "ACQUIRED",
	ingestPoints: [
		{ streamBaseUrl: "rtmps://live.bitmovin.com/live", streamKey: STREAM_KEY },
	],
	manifests: [
		{
			url: "https://cdn.example.com/live/master.m3u8",
			manifestId: "man-1",
			type: "HLS",
		},
	],
	internalTrace: "leak-me",
};

function postRequest(body: unknown): Request {
	return new Request("http://test/actions", {
		method: "POST",
		body: JSON.stringify(body),
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	getAccount.mockResolvedValue({ id: ACCOUNT_ID, tenantOrgId: null });
	revealApiKey.mockResolvedValue("bm-api-key");
});

describe("POST /api/live/standby-pools/[poolId]/actions", () => {
	it("rejects an unknown action", async () => {
		const res = await POST(
			postRequest({ bitmovinAccountId: ACCOUNT_ID, action: "release" }),
			params,
		);
		expect(res.status).toBe(400);
		expect(acquireEncoding).not.toHaveBeenCalled();
		expect(deleteErrorEncodings).not.toHaveBeenCalled();
	});

	it("acquires with an EMPTY body — ingestPoints is documented not-implemented", async () => {
		acquireEncoding.mockResolvedValueOnce(acquired);
		const res = await POST(
			postRequest({ bitmovinAccountId: ACCOUNT_ID, action: "acquire" }),
			params,
		);
		expect(res.status).toBe(200);
		// Only the poolId — no LiveStandbyPoolAcquireEncoding payload at all.
		expect(acquireEncoding).toHaveBeenCalledWith(POOL_ID);
	});

	it("returns the ingest points + manifest URLs with a READABLE streamKey", async () => {
		acquireEncoding.mockResolvedValueOnce(acquired);
		const res = await POST(
			postRequest({ bitmovinAccountId: ACCOUNT_ID, action: "acquire" }),
			params,
		);
		const body = (await res.json()) as {
			encoding: {
				encodingId: string;
				ingestPoints: { streamKey: string; streamBaseUrl: string }[];
				manifests: { url: string }[];
			};
		};
		expect(body.encoding.encodingId).toBe(ENCODING_ID);
		expect(body.encoding.ingestPoints[0]?.streamKey).toBe(STREAM_KEY);
		expect(body.encoding.manifests[0]?.url).toBe(
			"https://cdn.example.com/live/master.m3u8",
		);
		// Allowlist still applies to everything else.
		expect(JSON.stringify(body)).not.toContain("internalTrace");
	});

	it("MASKS the acquired streamKey in the persisted audit row", async () => {
		acquireEncoding.mockResolvedValueOnce(acquired);
		await POST(
			postRequest({ bitmovinAccountId: ACCOUNT_ID, action: "acquire" }),
			params,
		);
		const entry = persistedAudit.mock.calls[0]?.[0] as Record<string, unknown>;
		expect(entry.path).toBe(`/encoding/live/standby-pools/${POOL_ID}/acquire`);
		const persisted = JSON.stringify(entry);
		expect(persisted).not.toContain(STREAM_KEY);
		expect(persisted).toContain("[REDACTED]");
		// The non-secret coordinates are still there for the trail.
		expect(persisted).toContain("rtmps://live.bitmovin.com/live");
	});

	it("clears error encodings under its own audit path", async () => {
		deleteErrorEncodings.mockResolvedValueOnce({ id: "pool-enc-2" });
		const res = await POST(
			postRequest({
				bitmovinAccountId: ACCOUNT_ID,
				action: "deleteErrorEncodings",
			}),
			params,
		);
		expect(res.status).toBe(200);
		expect(deleteErrorEncodings).toHaveBeenCalledWith(POOL_ID);
		const entry = persistedAudit.mock.calls[0]?.[0] as Record<string, unknown>;
		expect(entry.path).toBe(
			`/encoding/live/standby-pools/${POOL_ID}/delete-error-encodings`,
		);
	});

	it("surfaces a curated 409 when no encoding is ready to acquire", async () => {
		acquireEncoding.mockRejectedValueOnce(
			Object.assign(new Error(`body: {"streamKey":"${STREAM_KEY}"}`), {
				httpStatusCode: 409,
				shortMessage: "No READY encoding available in the pool",
			}),
		);
		const res = await POST(
			postRequest({ bitmovinAccountId: ACCOUNT_ID, action: "acquire" }),
			params,
		);
		expect(res.status).toBe(409);
		const body = JSON.stringify(await res.json());
		expect(body).toContain("No READY encoding available");
		expect(body).not.toContain(STREAM_KEY);
	});
});
