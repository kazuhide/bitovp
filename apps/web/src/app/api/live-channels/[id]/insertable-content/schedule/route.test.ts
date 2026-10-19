import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getAccount = vi.fn();
const revealApiKey = vi.fn();
const writeAuditLog = vi.fn();
const findUnique = vi.fn();
const runFindFirst = vi.fn();
const beginLiveEffect = vi.fn();
const assertLiveEffectCurrent = vi.fn();
const markLiveEffectAcked = vi.fn();
const markLiveEffectAmbiguous = vi.fn();
const markLiveEffectFailed = vi.fn();
const effectClaimFindUnique = vi.fn();

const scheduleCreate = vi.fn();
/* Scheduled provider insertions and local step-log records must agree so the worker neither suppresses a missing slate nor duplicates an existing one. */
const appendStepLog = vi.fn();
const appendEffectStepLog = vi.fn();
const effectExecuteRaw = vi.fn();

vi.mock("@/lib/server/context", () => ({
	getServerContext: () => ({
		bitmovinAccounts: { get: getAccount, revealApiKey },
		prisma: {
			$transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
				fn({ $executeRaw: effectExecuteRaw, $queryRaw: async () => [] }),
			liveChannel: { findUnique },
			liveChannelRun: { findFirst: runFindFirst },
			liveEffectClaim: { findUnique: effectClaimFindUnique },
		},
	}),
}));

vi.mock("@bitovp/db", async (importOriginal) => ({
	...(await importOriginal<typeof import("@bitovp/db")>()),
	appendLiveChannelStepLogEntry: (...args: unknown[]) => appendStepLog(...args),
	appendLiveEffectStepLogEntry: (...args: unknown[]) =>
		appendEffectStepLog(...args),
	beginLiveEffect: (...args: unknown[]) => beginLiveEffect(...args),
	assertLiveEffectCurrent: (...args: unknown[]) =>
		assertLiveEffectCurrent(...args),
	markLiveEffectAcked: (...args: unknown[]) => markLiveEffectAcked(...args),
	markLiveEffectAmbiguous: (...args: unknown[]) =>
		markLiveEffectAmbiguous(...args),
	markLiveEffectFailed: (...args: unknown[]) => markLiveEffectFailed(...args),
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
					live: {
						insertableContent: { schedule: { create: scheduleCreate } },
					},
				},
			};
		},
		ScheduledInsertableContent: Resource,
	};
});

import { POST } from "./route";

const ACCOUNT_ID = "3f1f0e8e-2c5b-4a4e-9a64-0f6f4d2c9b11";
const OTHER_ACCOUNT_ID = "4a2a1f9f-3d6c-4b5f-8b75-1a7e5c3d8f22";
const CHANNEL_ID = "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a";
const ENCODING_ID = "11112222-3333-4444-8555-666677778888";
const CONTENT_ID = "aaaabbbb-cccc-4ddd-8eee-ffff00001111";
const REQUEST_ID = "ccccdddd-eeee-4fff-8aaa-bbbb00001111";

const params = { params: Promise.resolve({ id: CHANNEL_ID }) };

function postRequest(body: unknown): Request {
	return new Request("http://test/schedule", {
		method: "POST",
		body: JSON.stringify(
			typeof body === "object" && body !== null
				? { requestId: REQUEST_ID, ...body }
				: body,
		),
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	appendEffectStepLog.mockReset();
	appendEffectStepLog.mockResolvedValue({ runUpdated: 1, channelUpdated: 1 });
	effectExecuteRaw.mockReset();
	effectClaimFindUnique.mockResolvedValue(null);
	getAccount.mockResolvedValue({ id: ACCOUNT_ID, tenantOrgId: null });
	revealApiKey.mockResolvedValue("bm-api-key");
	findUnique.mockResolvedValue({
		status: "RUNNING",
		bitmovinEncodingId: ENCODING_ID,
		bitmovinAccountId: ACCOUNT_ID,
		// review-228 I6: manual inserts require a CONNECTED ingest — the
		// PRODUCTION heartbeat wrapper, not an invented shape (#95 C1).
		// FRESH at : age joined the predicate, so this harness
		// default must sit inside the 90s vouching window.
		lastHeartbeat: {
			at: new Date().toISOString(),
			raw: { ingest: { status: "CONNECTED", healthy: true } },
			deltas: {},
		},
		liveEffectFenceVersion: 0,
	});
	runFindFirst.mockResolvedValue({
		id: "run-1",
		bitmovinEncodingId: ENCODING_ID,
	});
	beginLiveEffect.mockResolvedValue({
		kind: "EXECUTE",
		claim: {
			id: "claim-1",
			idempotencyKey: "manual:slate-insert:test",
			token: "token-1",
			liveChannelId: CHANNEL_ID,
			liveChannelRunId: "run-1",
			providerEncodingId: ENCODING_ID,
			action: "SLATE_INSERT",
			generation: 1,
			expiresAt: new Date(Date.now() + 60_000),
		},
	});
	assertLiveEffectCurrent.mockResolvedValue(true);
	markLiveEffectAcked.mockResolvedValue(true);
	markLiveEffectAmbiguous.mockResolvedValue(true);
	markLiveEffectFailed.mockResolvedValue(true);
});

describe("POST /api/live-channels/[id]/insertable-content/schedule", () => {
	it("409s a manual insert while the ingest is NOT connected — accepted-and-renders-nothing was the #95 incident through this door (review-228 I6)", async () => {
		findUnique.mockResolvedValueOnce({
			status: "RUNNING",
			bitmovinEncodingId: ENCODING_ID,
			bitmovinAccountId: ACCOUNT_ID,
			lastHeartbeat: {
				at: "2026-08-15T00:00:00.000Z",
				raw: { ingest: { status: "WAITING_FOR_FIRST_CONNECT" } },
				deltas: {},
			},
		});
		const res = await POST(
			postRequest({
				bitmovinAccountId: ACCOUNT_ID,
				schedule: {
					contentId: "99999999-9999-4999-8999-999999999999",
					durationInSeconds: 30,
				},
			}),
			params,
		);
		expect(res.status).toBe(409);
		expect((await res.json()).error).toMatch(/CONNECTED ingest/);
	});

	it("409s a manual insert on a STALE CONNECTED sample — a revived run's pre-error proof must not admit an insert (ledger #127)", async () => {
		findUnique.mockResolvedValueOnce({
			status: "RUNNING",
			bitmovinEncodingId: ENCODING_ID,
			bitmovinAccountId: ACCOUNT_ID,
			lastHeartbeat: {
				at: new Date(Date.now() - 10 * 60_000).toISOString(),
				raw: { ingest: { status: "CONNECTED", healthy: true } },
				deltas: {},
			},
		});
		const res = await POST(
			postRequest({
				bitmovinAccountId: ACCOUNT_ID,
				schedule: {
					contentId: "99999999-9999-4999-8999-999999999999",
					durationInSeconds: 30,
				},
			}),
			params,
		);
		expect(res.status).toBe(409);
		expect((await res.json()).error).toMatch(/CONNECTED ingest/);
	});

	it("rejects a non-UUID contentId", async () => {
		const res = await POST(
			postRequest({
				bitmovinAccountId: ACCOUNT_ID,
				schedule: { contentId: "slate" },
			}),
			params,
		);
		expect(res.status).toBe(400);
		expect(scheduleCreate).not.toHaveBeenCalled();
	});

	it("rejects a non-ISO runAt and a non-integer duration", async () => {
		for (const schedule of [
			{ contentId: CONTENT_ID, runAt: "tomorrow" },
			{ contentId: CONTENT_ID, durationInSeconds: 1.5 },
			{ contentId: CONTENT_ID, durationInSeconds: 0 },
		]) {
			const res = await POST(
				postRequest({ bitmovinAccountId: ACCOUNT_ID, schedule }),
				params,
			);
			expect(res.status).toBe(400);
		}
		expect(scheduleCreate).not.toHaveBeenCalled();
	});

	it("schedules ASAP when runAt is absent (no runAt on the SDK payload)", async () => {
		scheduleCreate.mockResolvedValueOnce({
			id: "sched-1",
			contentId: CONTENT_ID,
			status: "SCHEDULED",
		});
		const res = await POST(
			postRequest({
				bitmovinAccountId: ACCOUNT_ID,
				schedule: { contentId: CONTENT_ID },
			}),
			params,
		);
		expect(res.status).toBe(201);
		const [encodingIdArg, contentIdArg, payload] = scheduleCreate.mock
			.calls[0] as [string, string, Record<string, unknown>];
		expect(encodingIdArg).toBe(ENCODING_ID);
		expect(contentIdArg).toBe(CONTENT_ID);
		expect("runAt" in payload).toBe(false);
		expect(beginLiveEffect).toHaveBeenCalledTimes(1);
		expect(beginLiveEffect).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				idempotencyKey: `manual:slate-insert:${CHANNEL_ID}:${REQUEST_ID}`,
				requestSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
			}),
		);
		expect(assertLiveEffectCurrent).toHaveBeenCalledTimes(1);
		expect(markLiveEffectAcked).toHaveBeenCalledTimes(1);
		expect(beginLiveEffect.mock.invocationCallOrder[0]).toBeLessThan(
			scheduleCreate.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
		);
	});

	it("returns an idempotent success with the provider identity after response loss", async () => {
		effectClaimFindUnique.mockResolvedValueOnce({
			requestSha256: createHash("sha256")
				.update(
					JSON.stringify({
						bitmovinAccountId: ACCOUNT_ID,
						contentId: CONTENT_ID,
						runAt: null,
						durationInSeconds: 30,
					}),
				)
				.digest("hex"),
			liveChannelRunId: "run-1",
			providerEncodingId: ENCODING_ID,
			action: "SLATE_INSERT",
			state: "ACKED",
			providerResultId: "provider-schedule-1",
		});

		const res = await POST(
			postRequest({
				bitmovinAccountId: ACCOUNT_ID,
				schedule: { contentId: CONTENT_ID, durationInSeconds: 30 },
			}),
			params,
		);

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			id: "provider-schedule-1",
			requestId: REQUEST_ID,
			acknowledged: true,
			idempotentReplay: true,
		});
		expect(scheduleCreate).not.toHaveBeenCalled();
		expect(appendStepLog).not.toHaveBeenCalled();
		expect(appendEffectStepLog).not.toHaveBeenCalled();
	});

	it("never replays an ACK from an older live run as a current insertion", async () => {
		effectClaimFindUnique.mockResolvedValueOnce({
			requestSha256: createHash("sha256")
				.update(
					JSON.stringify({
						bitmovinAccountId: ACCOUNT_ID,
						contentId: CONTENT_ID,
						runAt: null,
						durationInSeconds: 30,
					}),
				)
				.digest("hex"),
			liveChannelRunId: "run-old",
			providerEncodingId: "encoding-old",
			action: "SLATE_INSERT",
			state: "ACKED",
			providerResultId: "provider-schedule-old",
		});

		const res = await POST(
			postRequest({
				bitmovinAccountId: ACCOUNT_ID,
				schedule: { contentId: CONTENT_ID, durationInSeconds: 30 },
			}),
			params,
		);

		expect(res.status).toBe(409);
		expect(await res.json()).toMatchObject({
			details: { code: "CONTENT_REQUEST_CONFLICT" },
		});
		expect(scheduleCreate).not.toHaveBeenCalled();
	});

	it("replays a legacy pre-account digest only after current account and effect identity match", async () => {
		effectClaimFindUnique.mockResolvedValueOnce({
			requestSha256: createHash("sha256")
				.update(
					JSON.stringify({
						contentId: CONTENT_ID,
						runAt: null,
						durationInSeconds: 30,
					}),
				)
				.digest("hex"),
			liveChannelRunId: "run-1",
			providerEncodingId: ENCODING_ID,
			action: "SLATE_INSERT",
			state: "ACKED",
			providerResultId: "provider-schedule-legacy",
		});

		const res = await POST(
			postRequest({
				bitmovinAccountId: ACCOUNT_ID,
				schedule: { contentId: CONTENT_ID, durationInSeconds: 30 },
			}),
			params,
		);

		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({
			id: "provider-schedule-legacy",
			idempotentReplay: true,
		});
		expect(scheduleCreate).not.toHaveBeenCalled();
	});

	it("retries a conclusively FAILED legacy claim without rewriting its digest binding", async () => {
		const legacyDigest = createHash("sha256")
			.update(
				JSON.stringify({
					contentId: CONTENT_ID,
					runAt: null,
					durationInSeconds: 30,
				}),
			)
			.digest("hex");
		effectClaimFindUnique.mockResolvedValueOnce({
			requestSha256: legacyDigest,
			liveChannelRunId: "run-1",
			providerEncodingId: ENCODING_ID,
			action: "SLATE_INSERT",
			state: "FAILED",
			providerResultId: null,
		});
		scheduleCreate.mockResolvedValueOnce({
			id: "provider-schedule-retry",
			contentId: CONTENT_ID,
			status: "SCHEDULED",
		});

		const res = await POST(
			postRequest({
				bitmovinAccountId: ACCOUNT_ID,
				schedule: { contentId: CONTENT_ID, durationInSeconds: 30 },
			}),
			params,
		);

		expect(res.status).toBe(201);
		expect(beginLiveEffect).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ requestSha256: legacyDigest }),
		);
	});

	it("binds a manual insertion request ID to the Bitmovin account", async () => {
		effectClaimFindUnique.mockResolvedValueOnce({
			requestSha256: createHash("sha256")
				.update(
					JSON.stringify({
						contentId: CONTENT_ID,
						runAt: null,
						durationInSeconds: 30,
					}),
				)
				.digest("hex"),
			liveChannelRunId: "run-1",
			providerEncodingId: ENCODING_ID,
			action: "SLATE_INSERT",
			state: "ACKED",
			providerResultId: "provider-schedule-1",
		});

		const res = await POST(
			postRequest({
				bitmovinAccountId: OTHER_ACCOUNT_ID,
				schedule: { contentId: CONTENT_ID, durationInSeconds: 30 },
			}),
			params,
		);

		expect(res.status).toBe(409);
		expect(await res.json()).toMatchObject({
			details: { code: "CONTENT_REQUEST_CONFLICT" },
		});
		expect(scheduleCreate).not.toHaveBeenCalled();
	});

	it("409s when the same request id is rebound to a different payload", async () => {
		beginLiveEffect.mockResolvedValueOnce({
			kind: "CONFLICT",
			reason: "the request id is already bound to a different payload",
		});

		const res = await POST(
			postRequest({
				bitmovinAccountId: ACCOUNT_ID,
				schedule: { contentId: CONTENT_ID, durationInSeconds: 60 },
			}),
			params,
		);

		expect(res.status).toBe(409);
		expect(await res.json()).toMatchObject({
			error: expect.stringMatching(/different payload/),
			details: { code: "CONTENT_REQUEST_BLOCKED" },
		});
		expect(scheduleCreate).not.toHaveBeenCalled();
	});

	it("refuses before provider send when the exact run/generation fence is lost", async () => {
		assertLiveEffectCurrent.mockResolvedValueOnce(false);
		const res = await POST(
			postRequest({
				bitmovinAccountId: ACCOUNT_ID,
				schedule: { contentId: CONTENT_ID },
			}),
			params,
		);
		expect(res.status).toBe(500);
		expect(scheduleCreate).not.toHaveBeenCalled();
		expect(markLiveEffectFailed).toHaveBeenCalledTimes(1);
		expect(markLiveEffectAmbiguous).not.toHaveBeenCalled();
	});

	it.each([
		["current run", 1],
		["same-run generation lost", 0],
		["re-air during provider response", 0],
	])("binds success to the claimed run before ACK: %s", async (scenario, channelUpdated) => {
		const { appendLiveEffectStepLogEntry } =
			await vi.importActual<typeof import("@bitovp/db")>("@bitovp/db");
		appendEffectStepLog.mockImplementationOnce(appendLiveEffectStepLogEntry);
		effectExecuteRaw
			.mockResolvedValueOnce(1)
			.mockResolvedValueOnce(channelUpdated);
		scheduleCreate.mockImplementationOnce(async () => {
			if (scenario !== "current run") {
				findUnique.mockResolvedValue({
					status: "PROVISIONING",
					bitmovinEncodingId: scenario.startsWith("re-air")
						? "new-encoding"
						: ENCODING_ID,
					liveEffectFenceVersion: 2,
				});
				markLiveEffectAcked.mockResolvedValueOnce(false);
			}
			return { id: "sched-1", contentId: CONTENT_ID };
		});
		const res = await POST(
			postRequest({
				bitmovinAccountId: ACCOUNT_ID,
				schedule: { contentId: CONTENT_ID },
			}),
			params,
		);
		expect(res.status).toBe(201);
		expect(appendStepLog).not.toHaveBeenCalled();
		expect(appendEffectStepLog).toHaveBeenCalledOnce();
		expect(appendEffectStepLog.mock.calls[0]?.[1]).toMatchObject({
			liveChannelRunId: "run-1",
			providerEncodingId: ENCODING_ID,
			generation: 1,
		});
		const [runWrite, channelWrite] = effectExecuteRaw.mock.calls;
		expect((runWrite?.[0] as TemplateStringsArray).join("?")).toContain(
			'UPDATE "LiveChannelRun"',
		);
		expect(runWrite?.slice(1)).toEqual(
			expect.arrayContaining(["run-1", ENCODING_ID, "claim-1", "token-1", 1]),
		);
		const channelSql = (channelWrite?.[0] as TemplateStringsArray).join("?");
		expect(channelSql).toContain('channel."liveEffectFenceVersion"');
		expect(channelSql).toContain("effect.state = 'DISPATCHING'");
		expect(channelWrite?.slice(1)).toEqual(
			expect.arrayContaining(["run-1", ENCODING_ID, 1]),
		);
		expect(appendEffectStepLog.mock.invocationCallOrder[0]).toBeLessThan(
			markLiveEffectAcked.mock.invocationCallOrder[0] ?? 0,
		);
		expect(markLiveEffectAcked).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ liveChannelRunId: "run-1" }),
			expect.any(Date),
			{ providerResultId: "sched-1" },
		);
	});

	it("reports missing exact-run evidence but ACKs the known provider success without inviting a resend", async () => {
		appendEffectStepLog.mockResolvedValueOnce({
			runUpdated: 0,
			channelUpdated: 0,
		});
		scheduleCreate.mockResolvedValueOnce({
			id: "sched-1",
			contentId: CONTENT_ID,
		});
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const res = await POST(
				postRequest({
					bitmovinAccountId: ACCOUNT_ID,
					schedule: { contentId: CONTENT_ID },
				}),
				params,
			);
			expect(res.status).toBe(201);
			expect(error).toHaveBeenCalledWith(
				expect.stringContaining("could not be bound to claimed run run-1"),
			);
			expect(markLiveEffectAcked).toHaveBeenCalledWith(
				expect.anything(),
				expect.anything(),
				expect.any(Date),
				{ providerResultId: "sched-1" },
			);
			expect(scheduleCreate).toHaveBeenCalledOnce();
		} finally {
			error.mockRestore();
		}
	});

	it("RECORDS the insertion in the step log — the worker's guard counts these", async () => {
		/* Creating a provider insertion must also retain a local trace that the worker can reconcile. */
		scheduleCreate.mockResolvedValueOnce({
			id: "sched-1",
			contentId: CONTENT_ID,
			status: "SCHEDULED",
		});
		const res = await POST(
			postRequest({
				bitmovinAccountId: ACCOUNT_ID,
				schedule: { contentId: CONTENT_ID, durationInSeconds: 120 },
			}),
			params,
		);
		expect(res.status).toBe(201);
		expect(appendEffectStepLog).toHaveBeenCalledTimes(1);
		const entry = (appendEffectStepLog.mock.calls[0] as unknown[])[2] as {
			kind: string;
			status: string;
			payload: Record<string, unknown>;
		};
		expect(entry.kind).toBe("SLATE_INSERTED");
		// DONE, because the insertion already happened — the same runtime-record
		// contract the worker's own records follow.
		expect(entry.status).toBe("DONE");
		// The fields the guard actually counts on: which slate, and when.
		expect(entry.payload).toMatchObject({
			insertableContentId: CONTENT_ID,
			durationSeconds: 120,
			viaDirectRoute: true,
			/* Reconciliation must attribute each provider insertion to its specific local record rather than relying on a count. */
			providerEntryId: "sched-1",
		});
		expect(typeof entry.payload.at).toBe("string");
	});

	it("still returns 201 when the record cannot be written — the insertion landed", async () => {
		// Failing the request would invite a retry of a call that already
		// succeeded. The record loss is loud (console.error), not fatal.
		scheduleCreate.mockResolvedValueOnce({
			id: "sched-1",
			contentId: CONTENT_ID,
			status: "SCHEDULED",
		});
		appendEffectStepLog.mockRejectedValueOnce(new Error("db down"));
		const res = await POST(
			postRequest({
				bitmovinAccountId: ACCOUNT_ID,
				schedule: { contentId: CONTENT_ID },
			}),
			params,
		);
		expect(res.status).toBe(201);
		expect(markLiveEffectAcked).toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			expect.any(Date),
			{ providerResultId: "sched-1" },
		);
	});

	it("converts runAt to a Date and forwards durationInSeconds", async () => {
		scheduleCreate.mockResolvedValueOnce({
			id: "sched-1",
			status: "SCHEDULED",
		});
		const res = await POST(
			postRequest({
				bitmovinAccountId: ACCOUNT_ID,
				schedule: {
					contentId: CONTENT_ID,
					runAt: "2026-08-06T20:00:00Z",
					durationInSeconds: 15,
				},
			}),
			params,
		);
		expect(res.status).toBe(201);
		const payload = scheduleCreate.mock.calls[0]?.[2] as {
			runAt: Date;
			durationInSeconds: number;
		};
		expect(payload.runAt).toBeInstanceOf(Date);
		expect(payload.durationInSeconds).toBe(15);
		const entry = writeAuditLog.mock.calls[0]?.[1] as Record<string, unknown>;
		expect(entry.path).toBe(
			`/encoding/encodings/${ENCODING_ID}/live/insertable-content/${CONTENT_ID}/schedule`,
		);
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
				schedule: { contentId: CONTENT_ID },
			}),
			params,
		);
		expect(res.status).toBe(409);
	});

	it("passes through Bitmovin's 422 when an image is scheduled without a duration", async () => {
		scheduleCreate.mockRejectedValueOnce(
			Object.assign(new Error("body: SHOULD_NOT_LEAK"), {
				httpStatusCode: 422,
				shortMessage: "durationInSeconds is required for image content",
			}),
		);
		const res = await POST(
			postRequest({
				bitmovinAccountId: ACCOUNT_ID,
				schedule: { contentId: CONTENT_ID },
			}),
			params,
		);
		expect(res.status).toBe(422);
		const body = JSON.stringify(await res.json());
		expect(body).toContain("required for image content");
		expect(body).not.toContain("SHOULD_NOT_LEAK");
		expect(markLiveEffectAmbiguous).toHaveBeenCalledTimes(1);
		expect(markLiveEffectAcked).not.toHaveBeenCalled();
	});
});
