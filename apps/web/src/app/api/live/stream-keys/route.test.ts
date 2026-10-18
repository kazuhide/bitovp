import { redactSecrets } from "@bitovp/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getAccount = vi.fn();
const revealApiKey = vi.fn();
/** Records what would actually LAND IN THE DB ROW. */
const persistedAudit = vi.fn();

const keysCreate = vi.fn();
const keysList = vi.fn();

vi.mock("@/lib/server/context", () => ({
	getServerContext: () => ({
		bitmovinAccounts: { get: getAccount, revealApiKey },
	}),
}));

/**
 * The audit mock reproduces `packages/db`'s writer faithfully: it pipes
 * request/response/error through the REAL `redactSecrets` before recording, so
 * these tests assert what is persisted, not what the route handed over.
 */
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
			...(entry.error !== undefined
				? { error: redactSecrets(entry.error) }
				: {}),
		});
		return Promise.resolve();
	},
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
				live: {
					streamKeys: {
						create: keysCreate,
						list: keysList,
						delete: vi.fn(),
						actions: { unassign: vi.fn() },
					},
				},
			};
		},
		StreamKey: Resource,
	};
});

import { GET, POST } from "./route";

const ACCOUNT_ID = "3f1f0e8e-2c5b-4a4e-9a64-0f6f4d2c9b11";
const ENCODING_ID = "11112222-3333-4444-8555-666677778888";
const SECRET_VALUE = "sk-live-DO-NOT-PERSIST";

function postRequest(body: unknown): Request {
	return new Request("http://test/api/live/stream-keys", {
		method: "POST",
		body: JSON.stringify(body),
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	getAccount.mockResolvedValue({ id: ACCOUNT_ID, tenantOrgId: null });
	revealApiKey.mockResolvedValue("bm-api-key");
});

describe("redaction contract for stream-key material", () => {
	it("SENSITIVE_SUFFIX covers `streamKey` but NOT `value` — hence the explicit strip", () => {
		// The standby-pool ingest points name it `streamKey`: the redactSecrets
		// backstop masks it on its own.
		expect(
			redactSecrets({ ingestPoints: [{ streamKey: SECRET_VALUE }] }),
		).toEqual({ ingestPoints: [{ streamKey: "[REDACTED]" }] });
		// StreamKey names the same material `value`, which the backstop does NOT
		// catch — so this route must strip it from audit snapshots itself.
		expect(redactSecrets({ value: SECRET_VALUE })).toEqual({
			value: SECRET_VALUE,
		});
	});
});

describe("GET /api/live/stream-keys", () => {
	it("clamps limit to 100 (C6)", async () => {
		keysList.mockResolvedValueOnce({ totalCount: 0, items: [] });
		const res = await GET(
			new Request(
				`http://test/api/live/stream-keys?bitmovinAccountId=${ACCOUNT_ID}&limit=1000`,
			),
		);
		expect(res.status).toBe(200);
		expect(keysList).toHaveBeenCalledWith({ offset: 0, limit: 100 });
	});

	it("forwards the SDK's type/status/assignedEncodingId filters", async () => {
		keysList.mockResolvedValueOnce({ totalCount: 0, items: [] });
		await GET(
			new Request(
				`http://test/api/live/stream-keys?bitmovinAccountId=${ACCOUNT_ID}&type=RESERVED&status=ASSIGNED&assignedEncodingId=${ENCODING_ID}`,
			),
		);
		expect(keysList).toHaveBeenCalledWith({
			offset: 0,
			limit: 25,
			type: "RESERVED",
			status: "ASSIGNED",
			assignedEncodingId: ENCODING_ID,
		});
	});

	it("400s an out-of-enum status filter", async () => {
		const res = await GET(
			new Request(
				`http://test/api/live/stream-keys?bitmovinAccountId=${ACCOUNT_ID}&status=PENDING`,
			),
		);
		expect(res.status).toBe(400);
		expect(keysList).not.toHaveBeenCalled();
	});

	it("withholds the key VALUE from the list and drops unknown fields", async () => {
		keysList.mockResolvedValueOnce({
			totalCount: 1,
			items: [
				{
					id: "key-1",
					value: SECRET_VALUE,
					status: "UNASSIGNED",
					type: "RESERVED",
					internalTrace: "leak-me",
				},
			],
		});
		const res = await GET(
			new Request(
				`http://test/api/live/stream-keys?bitmovinAccountId=${ACCOUNT_ID}`,
			),
		);
		const body = JSON.stringify(await res.json());
		// The LIST withholds `value` (review catch M6): a list would otherwise
		// hand out up to 100 live ingest credentials on one unauthenticated,
		// unaudited GET. Metadata still comes through; unknown fields are
		// dropped by the allowlist.
		expect(body).not.toContain(SECRET_VALUE);
		expect(body).toContain("UNASSIGNED");
		expect(body).toContain("RESERVED");
		expect(body).not.toContain("internalTrace");
	});

	it("404s an unknown Bitmovin account", async () => {
		getAccount.mockResolvedValueOnce(null);
		const res = await GET(
			new Request(
				`http://test/api/live/stream-keys?bitmovinAccountId=${ACCOUNT_ID}`,
			),
		);
		expect(res.status).toBe(404);
	});
});

describe("POST /api/live/stream-keys", () => {
	it("rejects a too-short or unsafely-charactered manual value", async () => {
		for (const value of ["short", "has spaces here", "slash/es"]) {
			const res = await POST(
				postRequest({ bitmovinAccountId: ACCOUNT_ID, streamKey: { value } }),
			);
			expect(res.status).toBe(400);
		}
		expect(keysCreate).not.toHaveBeenCalled();
	});

	it("rejects an out-of-enum type and an unknown field (strict)", async () => {
		for (const streamKey of [{ type: "PERMANENT" }, { unexpected: 1 }]) {
			const res = await POST(
				postRequest({ bitmovinAccountId: ACCOUNT_ID, streamKey }),
			);
			expect(res.status).toBe(400);
		}
	});

	it("creates a Bitmovin-generated key and NEVER persists its value in the audit row", async () => {
		keysCreate.mockResolvedValueOnce({
			id: "key-1",
			name: "studio-a",
			value: SECRET_VALUE,
			status: "UNASSIGNED",
			type: "RESERVED",
		});
		const res = await POST(
			postRequest({
				bitmovinAccountId: ACCOUNT_ID,
				streamKey: { name: "studio-a", type: "RESERVED" },
			}),
		);
		expect(res.status).toBe(201);
		// The caller DOES get the value — it is the ingest credential.
		expect(JSON.stringify(await res.json())).toContain(SECRET_VALUE);

		const entry = persistedAudit.mock.calls[0]?.[0] as Record<string, unknown>;
		expect(entry.path).toBe("/encoding/live/stream-keys");
		expect(entry.statusCode).toBe(201);
		expect(JSON.stringify(entry)).not.toContain(SECRET_VALUE);
		expect(entry.response).toEqual(
			expect.objectContaining({ id: "key-1", status: "UNASSIGNED" }),
		);
		expect(entry.response).not.toHaveProperty("value");
	});

	it("records a MANUAL value as a presence flag only", async () => {
		keysCreate.mockResolvedValueOnce({
			id: "key-2",
			value: SECRET_VALUE,
			status: "UNASSIGNED",
		});
		const res = await POST(
			postRequest({
				bitmovinAccountId: ACCOUNT_ID,
				streamKey: { value: SECRET_VALUE },
			}),
		);
		expect(res.status).toBe(201);
		expect(keysCreate).toHaveBeenCalledWith(
			expect.objectContaining({ value: SECRET_VALUE }),
		);
		const entry = persistedAudit.mock.calls[0]?.[0] as Record<string, unknown>;
		expect(JSON.stringify(entry)).not.toContain(SECRET_VALUE);
		expect(entry.request).toEqual({ valueProvided: true });
	});

	it("surfaces a curated upstream 409 (duplicate key value), still audited", async () => {
		keysCreate.mockRejectedValueOnce(
			Object.assign(new Error(`body: {"value":"${SECRET_VALUE}"}`), {
				httpStatusCode: 409,
				shortMessage: "Stream key value already exists",
			}),
		);
		const res = await POST(
			postRequest({
				bitmovinAccountId: ACCOUNT_ID,
				streamKey: { value: SECRET_VALUE },
			}),
		);
		expect(res.status).toBe(409);
		const body = JSON.stringify(await res.json());
		expect(body).toContain("Stream key value already exists");
		expect(body).not.toContain(SECRET_VALUE);
		const entry = persistedAudit.mock.calls[0]?.[0] as Record<string, unknown>;
		expect(JSON.stringify(entry)).not.toContain(SECRET_VALUE);
	});
});
