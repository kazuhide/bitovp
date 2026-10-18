import { beforeEach, describe, expect, it, vi } from "vitest";

const getAccount = vi.fn();
const revealApiKey = vi.fn();
const writeAuditLog = vi.fn();
const findUnique = vi.fn();
const executeRaw = vi.fn(async () => 1);

const mediaPointCreate = vi.fn();

vi.mock("@/lib/server/context", () => ({
	getServerContext: () => ({
		bitmovinAccounts: { get: getAccount, revealApiKey },
		prisma: { liveChannel: { findUnique }, $executeRaw: executeRaw },
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
				encodings: {
					live: { esam: { mediaPoints: { create: mediaPointCreate } } },
				},
			};
		},
		EsamMediaPoint: Resource,
		EsamSignal: Resource,
	};
});

import { POST } from "./route";

const ACCOUNT_ID = "3f1f0e8e-2c5b-4a4e-9a64-0f6f4d2c9b11";
const CHANNEL_ID = "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a";
const ENCODING_ID = "11112222-3333-4444-8555-666677778888";

const params = { params: Promise.resolve({ id: CHANNEL_ID }) };

/** A real (short) SCTE-35 splice_null base64 payload shape. */
const BINARY = "/DAgAAAAAAAAAP/wDwAA";

function postRequest(body: unknown): Request {
	return new Request("http://test/esam-media-point", {
		method: "POST",
		body: JSON.stringify(body),
	});
}

function running(stepLog: unknown[] = []) {
	findUnique.mockResolvedValue({
		status: "RUNNING",
		bitmovinEncodingId: ENCODING_ID,
		bitmovinAccountId: ACCOUNT_ID,
		stepLog,
	});
}

/**
 * The entry the route appended, or undefined if it never wrote.
 *
 * The append is one atomic `jsonb ||` statement (no read-modify-write, so two
 * concurrent insertions cannot lose or revert each other), which means the test
 * inspects the JSON handed to `$executeRaw` rather than a whole rewritten log.
 */
function appendedEntry(): Record<string, unknown> | undefined {
	const values = executeRaw.mock.calls[0]?.slice(1) as unknown[] | undefined;
	const json = values?.find(
		(value) => typeof value === "string" && value.startsWith("["),
	) as string | undefined;
	if (!json) {
		return undefined;
	}
	return (JSON.parse(json) as Record<string, unknown>[])[0];
}

beforeEach(() => {
	vi.clearAllMocks();
	getAccount.mockResolvedValue({ id: ACCOUNT_ID, tenantOrgId: null });
	revealApiKey.mockResolvedValue("bm-api-key");
});

describe("POST /api/live-channels/[id]/esam-media-point", () => {
	it("requires at least one signal", async () => {
		running();
		const res = await POST(
			postRequest({
				bitmovinAccountId: ACCOUNT_ID,
				mediaPoint: { signals: [] },
			}),
			params,
		);
		expect(res.status).toBe(400);
		expect(mediaPointCreate).not.toHaveBeenCalled();
	});

	it.each([
		["not base64 at all", "not base64!!"],
		["length not a multiple of 4", "AAA"],
		["padding inside the payload", "AA==AAAA"],
	])("rejects a binary that is %s", async (_label, binary) => {
		running();
		const res = await POST(
			postRequest({
				bitmovinAccountId: ACCOUNT_ID,
				mediaPoint: { signals: [{ binary }] },
			}),
			params,
		);
		expect(res.status).toBe(400);
		expect(mediaPointCreate).not.toHaveBeenCalled();
	});

	it("caps the binary at 4096 characters", async () => {
		running();
		const res = await POST(
			postRequest({
				bitmovinAccountId: ACCOUNT_ID,
				mediaPoint: { signals: [{ binary: "A".repeat(4100) }] },
			}),
			params,
		);
		expect(res.status).toBe(400);
	});

	it("rejects an offset that is not an ISO 8601 duration", async () => {
		running();
		const res = await POST(
			postRequest({
				bitmovinAccountId: ACCOUNT_ID,
				mediaPoint: { signals: [{ binary: BINARY, offset: "10s" }] },
			}),
			params,
		);
		expect(res.status).toBe(400);
	});

	it("rejects an unknown field (strict)", async () => {
		running();
		const res = await POST(
			postRequest({
				bitmovinAccountId: ACCOUNT_ID,
				mediaPoint: { signals: [{ binary: BINARY }], spliceCommand: "INSERT" },
			}),
			params,
		);
		expect(res.status).toBe(400);
	});

	it("404s an unknown channel", async () => {
		findUnique.mockResolvedValue(null);
		const res = await POST(
			postRequest({
				bitmovinAccountId: ACCOUNT_ID,
				mediaPoint: { signals: [{ binary: BINARY }] },
			}),
			params,
		);
		expect(res.status).toBe(404);
	});

	it("409s a channel that is not RUNNING", async () => {
		findUnique.mockResolvedValue({
			status: "STOPPED",
			bitmovinEncodingId: ENCODING_ID,
			bitmovinAccountId: ACCOUNT_ID,
		});
		const res = await POST(
			postRequest({
				bitmovinAccountId: ACCOUNT_ID,
				mediaPoint: { signals: [{ binary: BINARY }] },
			}),
			params,
		);
		expect(res.status).toBe(409);
		expect((await res.json()).error).toMatch(/RUNNING/);
		expect(mediaPointCreate).not.toHaveBeenCalled();
	});

	it("400s when the account does not own the channel", async () => {
		findUnique.mockResolvedValue({
			status: "RUNNING",
			bitmovinEncodingId: ENCODING_ID,
			bitmovinAccountId: "00000000-0000-4000-8000-000000000000",
		});
		const res = await POST(
			postRequest({
				bitmovinAccountId: ACCOUNT_ID,
				mediaPoint: { signals: [{ binary: BINARY }] },
			}),
			params,
		);
		expect(res.status).toBe(400);
		expect(mediaPointCreate).not.toHaveBeenCalled();
	});

	it("inserts the media point (matchTime as a Date) and audits it", async () => {
		running();
		mediaPointCreate.mockResolvedValueOnce({
			matchTime: "2026-08-06T12:00:00Z",
			signals: [{ binary: BINARY, offset: "PT2S" }],
		});
		const res = await POST(
			postRequest({
				bitmovinAccountId: ACCOUNT_ID,
				mediaPoint: {
					matchTime: "2026-08-06T12:00:00Z",
					signals: [{ binary: BINARY, offset: "PT2S" }],
				},
			}),
			params,
		);
		expect(res.status).toBe(201);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.encodingId).toBe(ENCODING_ID);
		expect(typeof body.insertedAt).toBe("string");

		const [encodingIdArg, payload] = mediaPointCreate.mock.calls[0] as [
			string,
			{ matchTime: Date; signals: { binary: string }[] },
		];
		expect(encodingIdArg).toBe(ENCODING_ID);
		expect(payload.matchTime).toBeInstanceOf(Date);
		expect(payload.signals).toHaveLength(1);

		const entry = writeAuditLog.mock.calls[0]?.[1] as Record<string, unknown>;
		expect(entry.path).toBe(
			`/encoding/encodings/${ENCODING_ID}/live/esam/media-points`,
		);
		expect(entry.statusCode).toBe(201);
	});

	it("omits matchTime entirely when not supplied (insert ASAP)", async () => {
		running();
		mediaPointCreate.mockResolvedValueOnce({ signals: [{ binary: BINARY }] });
		const res = await POST(
			postRequest({
				bitmovinAccountId: ACCOUNT_ID,
				mediaPoint: { signals: [{ binary: BINARY }] },
			}),
			params,
		);
		expect(res.status).toBe(201);
		const payload = mediaPointCreate.mock.calls[0]?.[1] as Record<
			string,
			unknown
		>;
		expect("matchTime" in payload).toBe(false);
	});

	it("passes through a 422 (ESAM insertion not enabled at start) without leaking the SDK body", async () => {
		running();
		mediaPointCreate.mockRejectedValueOnce(
			Object.assign(new Error("body: SHOULD_NOT_LEAK"), {
				httpStatusCode: 422,
				shortMessage: "ESAM media point insertion is not enabled",
			}),
		);
		const res = await POST(
			postRequest({
				bitmovinAccountId: ACCOUNT_ID,
				mediaPoint: { signals: [{ binary: BINARY }] },
			}),
			params,
		);
		expect(res.status).toBe(422);
		const body = JSON.stringify(await res.json());
		expect(body).toContain("ESAM media point insertion is not enabled");
		expect(body).not.toContain("SHOULD_NOT_LEAK");
		expect(writeAuditLog).toHaveBeenCalledTimes(1);
	});

	it("maps a non-actionable upstream status (401) to 502", async () => {
		running();
		mediaPointCreate.mockRejectedValueOnce(
			Object.assign(new Error("nope"), {
				httpStatusCode: 401,
				shortMessage: "Unauthorized",
			}),
		);
		const res = await POST(
			postRequest({
				bitmovinAccountId: ACCOUNT_ID,
				mediaPoint: { signals: [{ binary: BINARY }] },
			}),
			params,
		);
		expect(res.status).toBe(502);
	});
});

describe("step-log record (ledger #20)", () => {
	/**
	 * The audit log already holds the reproducible request, but it is a separate
	 * account-keyed screen — the CHANNEL needs its own durable history, or a
	 * reload makes an insertion indistinguishable from one that never happened.
	 */
	beforeEach(() => {
		mediaPointCreate.mockResolvedValue({
			matchTime: "2026-08-06T10:00:00.000Z",
			signals: [{ offset: "PT10S", binary: BINARY }],
		});
	});

	it("appends one DONE ESAM_MEDIA_POINT entry", async () => {
		running();
		const res = await POST(
			postRequest({
				bitmovinAccountId: ACCOUNT_ID,
				mediaPoint: {
					matchTime: "2026-08-06T10:00:00.000Z",
					signals: [{ offset: "PT10S", binary: BINARY }],
				},
			}),
			params,
		);
		expect(res.status).toBe(201);
		const entry = appendedEntry() as
			| {
					kind: string;
					status: string;
					refs: Record<string, unknown>;
					request: {
						matchTime?: string;
						signals: { offset?: string }[];
					};
			  }
			| undefined;
		expect(entry?.kind).toBe("ESAM_MEDIA_POINT");
		// DONE for the reader's benefit; the replay loop now skips by KIND, since
		// the stale-RTMP guard can revive a DONE record as PENDING.
		expect(entry?.status).toBe("DONE");
		expect(entry?.refs.encodingId).toBe(ENCODING_ID);
		// `request` holds the REAL body shape minus the binary — not a summary.
		// copy-as-cURL builds its body from this field, so a summary here would
		// emit a request Bitmovin never accepts if the endpoint is ever mapped.
		expect(entry?.request.matchTime).toBe("2026-08-06T10:00:00.000Z");
		expect(entry?.request.signals).toEqual([{ offset: "PT10S" }]);
		// signalCount is a reader's convenience, so it belongs in payload where it
		// cannot leak into a generated request body.
		expect(
			(entry as unknown as { payload: Record<string, unknown> }).payload
				.signalCount,
		).toBe(1);
	});

	it("does NOT persist the SCTE-35 binary in the step log", async () => {
		running();
		await POST(
			postRequest({
				bitmovinAccountId: ACCOUNT_ID,
				mediaPoint: { signals: [{ binary: BINARY }] },
			}),
			params,
		);
		const entry = appendedEntry();
		// Guard the guard: a missing entry would make the assertion below vacuous.
		expect(entry).toBeDefined();
		expect(JSON.stringify(entry)).not.toContain(BINARY);
	});

	it("appends ATOMICALLY — it never reads or rewrites the existing log", async () => {
		// Read-modify-write on a JSON column loses or REVERTS entries when two
		// writers overlap, and there are real ones: two ESAM insertions, or an
		// insertion racing insertScte35 — whose read happens before its Bitmovin
		// call, so its stale snapshot can overwrite an entry written inside its
		// window (review catch). One `jsonb ||` statement has no window.
		running([
			{
				step: "provision:start",
				kind: "START_LIVE_ENCODING",
				payload: {},
				refs: { encodingId: ENCODING_ID },
				status: "DONE",
			},
		]);
		await POST(
			postRequest({
				bitmovinAccountId: ACCOUNT_ID,
				mediaPoint: { signals: [{ binary: BINARY }] },
			}),
			params,
		);
		expect(executeRaw).toHaveBeenCalledTimes(1);
		// Exactly one entry goes over the wire — not a rewritten whole log.
		const values = executeRaw.mock.calls[0]?.slice(1) as unknown[];
		const json = values.find(
			(value) => typeof value === "string" && value.startsWith("["),
		) as string;
		expect(JSON.parse(json)).toHaveLength(1);
		expect(JSON.stringify(json)).not.toContain("START_LIVE_ENCODING");
	});

	it("still returns 201 when the append fails — the insertion already landed", async () => {
		running();
		executeRaw.mockRejectedValue(new Error("db down"));
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const res = await POST(
			postRequest({
				bitmovinAccountId: ACCOUNT_ID,
				mediaPoint: { signals: [{ binary: BINARY }] },
			}),
			params,
		);
		try {
			expect(res.status).toBe(201);
			// Logged, not swallowed: a missing entry looks like no insertion.
			expect(error).toHaveBeenCalled();
		} finally {
			// clearAllMocks does not restore spies, so a failing assertion above
			// would otherwise leak the stub into later tests (review nit).
			error.mockRestore();
		}
	});

	it("writes nothing when the insertion itself failed", async () => {
		running();
		mediaPointCreate.mockRejectedValue(new Error("422 esam disabled"));
		const res = await POST(
			postRequest({
				bitmovinAccountId: ACCOUNT_ID,
				mediaPoint: { signals: [{ binary: BINARY }] },
			}),
			params,
		);
		expect(res.status).not.toBe(201);
		expect(executeRaw).not.toHaveBeenCalled();
	});
});
