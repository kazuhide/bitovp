import { REDACTED } from "@bitovp/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const findUnique = vi.fn();
const sessionDeleteMany = vi.fn();
const auditCreate = vi.fn();

// Interactive $transaction: invoke the callback with a tx exposing the model
// method the route uses (feederSession.deleteMany).
const tx = { feederSession: { deleteMany: sessionDeleteMany } };
const $transaction = vi.fn((cb: (t: typeof tx) => Promise<unknown>) => cb(tx));

vi.mock("@/lib/server/context", () => ({
	getServerContext: () => ({
		prisma: {
			feederSession: { findUnique, deleteMany: sessionDeleteMany },
			auditLog: { create: auditCreate },
			$transaction,
		},
	}),
}));

import { DELETE, GET } from "./route";

const SESSION_ID = "00000000-0000-4000-8000-0000000000f1";

function getDetail(
	id = SESSION_ID,
	options: { diagnostics?: boolean; headers?: HeadersInit } = {},
) {
	return GET(
		new Request(
			`http://test/api/feeder-sessions/${id}${options.diagnostics ? "?diagnostics=1" : ""}`,
			{ headers: options.headers },
		),
		{
			params: Promise.resolve({ id }),
		},
	);
}

function delReq(id = SESSION_ID) {
	return DELETE(
		new Request(`http://test/api/feeder-sessions/${id}`, { method: "DELETE" }),
		{ params: Promise.resolve({ id }) },
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	// Guarded delete affects 1 row by default (terminal row present).
	sessionDeleteMany.mockResolvedValue({ count: 1 });
	auditCreate.mockResolvedValue({});
});

describe("GET /api/feeder-sessions/[id]", () => {
	it("rejects invalid ids and 404s unknown sessions", async () => {
		expect((await getDetail("nope")).status).toBe(400);
		findUnique.mockResolvedValueOnce(null);
		expect((await getDetail()).status).toBe(404);
	});

	it("keeps process diagnostics out of the customer detail response", async () => {
		const boundaries = Array.from({ length: 25 }, (_, i) => ({
			loopIndex: i,
			wallClock: "2026-06-12T00:00:00.000Z",
			streamTimeSec: i * 30,
		}));
		findUnique.mockResolvedValueOnce({
			id: SESSION_ID,
			status: "PUSHING",
			protocol: "RTMP",
			target: { url: "rtmp://h/live", streamKey: "sk" },
			loopBoundaries: boundaries,
			logTail: ["2026-06-12T00:00:00.000Z [feeder] spawn: …"],
			pid: 4242,
			error: "worker lost ffmpeg PID 4242 while -stream_loop remained active",
		});
		const res = await getDetail();
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.stoppable).toBe(true);
		for (const field of [
			"pid",
			"processGoneAt",
			"loopBoundaries",
			"loopBoundaryCount",
			"recentLoopBoundaries",
			"logTail",
		]) {
			expect(body).not.toHaveProperty(field);
		}
		expect(body).toMatchObject({ error: null, internalFailure: true });
		expect(JSON.stringify(body)).not.toMatch(/worker|ffmpeg|PID|stream_loop/i);
	});

	it("refuses diagnostics to an OPERATOR before reading the session", async () => {
		const res = await getDetail(SESSION_ID, {
			diagnostics: true,
			headers: {
				"x-bitovp-actor": "user:operator-1",
				"x-bitovp-role": "OPERATOR",
			},
		});
		expect(res.status).toBe(403);
		expect(findUnique).not.toHaveBeenCalled();
	});

	it.each<{ name: string; headers: Record<string, string> }>([
		{
			name: "an ADMIN-looking role without a proxy-resolved actor",
			headers: { "x-bitovp-role": "ADMIN" },
		},
		{
			name: "an unresolved token with an ADMIN-looking role",
			headers: {
				"x-bitovp-actor": "token:unresolved",
				"x-bitovp-role": "ADMIN",
			},
		},
	])("fails closed for $name", async ({ headers }) => {
		const res = await getDetail(SESSION_ID, {
			diagnostics: true,
			headers,
		});
		expect(res.status).toBe(403);
		expect(findUnique).not.toHaveBeenCalled();
	});

	it.each<{ name: string; headers: Record<string, string> }>([
		{
			name: "users ADMIN",
			headers: {
				"x-bitovp-actor": "user:admin-1",
				"x-bitovp-role": "ADMIN",
			},
		},
		{
			name: "single-owner session",
			headers: { "x-bitovp-actor": "session" },
		},
		{
			name: "single-owner no-auth mode",
			headers: { "x-bitovp-actor": "none" },
		},
		{
			name: "ADMIN API token",
			headers: {
				"x-bitovp-actor": "token:00000000-0000-4000-8000-0000000000a1",
				"x-bitovp-role": "ADMIN",
			},
		},
	])("returns bounded diagnostics to $name", async ({ headers }) => {
		const boundaries = Array.from({ length: 25 }, (_, i) => ({
			loopIndex: i,
			wallClock: "2026-06-12T00:00:00.000Z",
			streamTimeSec: i * 30,
		}));
		findUnique.mockResolvedValueOnce({
			pid: 4242,
			ownerHost: "support-host-a",
			processGoneAt: null,
			loopBoundaries: boundaries,
			logTail: ["sanitized diagnostic line"],
			error: "worker lost ffmpeg PID 4242",
		});
		const res = await getDetail(SESSION_ID, { diagnostics: true, headers });
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body).toMatchObject({
			pid: 4242,
			ownerHost: "support-host-a",
			loopBoundaryCount: 25,
		});
		expect(body.recentLoopBoundaries).toHaveLength(20);
		expect(body.logTail).toEqual(["sanitized diagnostic line"]);
		expect(body.error).toBe("worker lost ffmpeg PID 4242");
		expect(body).not.toHaveProperty("target");
	});

	it("masks target.streamKey in the response (RTMP) — the raw key is a worker-only column read", async () => {
		findUnique.mockResolvedValueOnce({
			id: SESSION_ID,
			status: "PUSHING",
			protocol: "RTMP",
			target: { url: "rtmp://203.0.113.7/live", streamKey: "sk-secret-1" },
			loopBoundaries: [],
			logTail: [],
			pid: 4242,
		});
		const res = await getDetail();
		expect(res.status).toBe(200);
		const body = (await res.json()) as { target: Record<string, unknown> };
		// The push coordinates stay readable; the key does not.
		expect(body.target).toEqual({
			url: "rtmp://203.0.113.7/live",
			streamKey: REDACTED,
		});
		expect(JSON.stringify(body)).not.toContain("sk-secret-1");
	});

	it("keeps SRT targets readable (host/port/vault ref carry no secrets)", async () => {
		const passphraseCredentialId = "00000000-0000-4000-8000-0000000000c2";
		findUnique.mockResolvedValueOnce({
			id: SESSION_ID,
			status: "PUSHING",
			protocol: "SRT_CALLER",
			target: { host: "srt.example", port: 2090, passphraseCredentialId },
			loopBoundaries: [],
			logTail: [],
			pid: 4242,
		});
		const body = (await (await getDetail()).json()) as {
			target: Record<string, unknown>;
		};
		expect(body.target).toEqual({
			host: "srt.example",
			port: 2090,
			passphraseCredentialId,
		});
	});

	it("queries the customer detail with an explicit projection that excludes diagnostics", async () => {
		findUnique.mockResolvedValueOnce(null);
		await getDetail();
		const arg = findUnique.mock.calls[0]?.[0] as {
			select?: Record<string, boolean>;
		};
		expect(arg.select).toBeDefined();
		expect(arg.select).toHaveProperty("target");
		expect(arg.select).not.toHaveProperty("loopBoundaries");
		expect(arg.select).not.toHaveProperty("logTail");
		expect(arg.select).toHaveProperty("publisherClaimedAt", true);
		expect(arg.select).toHaveProperty("publisherReleasedAt", true);
		for (const field of [
			"sourceEtag",
			"sourceVersionId",
			"sourceGeneration",
			"sourceSize",
			"sourceSha256",
			"loopProfile",
		]) {
			expect(arg.select).toHaveProperty(field, true);
		}
	});

	it("returns the exact fed-source seal without exposing the source credential", async () => {
		findUnique.mockResolvedValueOnce({
			id: SESSION_ID,
			status: "STOPPED",
			protocol: "RTMP",
			target: { url: "rtmp://h/live", streamKey: "secret" },
			loopBoundaries: [],
			logTail: [],
			pid: null,
			sourceEtag: '"abc"',
			sourceVersionId: "v-1",
			sourceGeneration: null,
			sourceSize: 42n,
			sourceSha256: "a".repeat(64),
			loopProfile: { version: 1, mode: "normalized", frames: 270, fps: 30 },
		});
		const body = (await (await getDetail()).json()) as Record<string, unknown>;
		expect(body).toMatchObject({
			sourceEtag: '"abc"',
			sourceVersionId: "v-1",
			sourceGeneration: null,
			sourceSize: "42",
			sourceSha256: "a".repeat(64),
			// : the pushed loop's profile rides along with the seal.
			loopProfile: { frames: 270, fps: 30 },
		});
		expect(JSON.stringify(body)).not.toContain("secret");
	});
});

describe("DELETE /api/feeder-sessions/[id]", () => {
	it("400s a non-uuid id before touching the DB", async () => {
		const res = await delReq("nope");
		expect(res.status).toBe(400);
		expect(findUnique).not.toHaveBeenCalled();
		expect(sessionDeleteMany).not.toHaveBeenCalled();
	});

	it("404s a missing session", async () => {
		findUnique.mockResolvedValueOnce(null);
		const res = await delReq();
		expect(res.status).toBe(404);
		expect(sessionDeleteMany).not.toHaveBeenCalled();
	});

	it.each([
		"CREATED",
		"DOWNLOADING",
		"PUSHING",
	])("409s an active session (%s) without deleting", async (status) => {
		findUnique.mockResolvedValueOnce({ id: SESSION_ID, status });
		const res = await delReq();
		expect(res.status).toBe(409);
		expect($transaction).not.toHaveBeenCalled();
		expect(sessionDeleteMany).not.toHaveBeenCalled();
	});

	/**
	 * Audit 2026-08-29 CRITICAL-2 — deleting an ERROR row that still records an
	 * ffmpeg pid erased the last reference to a `-stream_loop -1` push nobody
	 * could then find. Terminal is not the same as process-free.
	 */
	it("409s a terminal session that still records an unreclaimed pid, naming the stop action", async () => {
		findUnique.mockResolvedValueOnce({
			id: SESSION_ID,
			status: "ERROR",
			pid: 4242,
			processGoneAt: null,
		});
		const res = await delReq();
		expect(res.status).toBe(409);
		const body = await res.text();
		expect(body).not.toContain("4242");
		expect(body).not.toContain("ffmpeg");
		expect(body).toContain("stop");
		expect($transaction).not.toHaveBeenCalled();
		expect(sessionDeleteMany).not.toHaveBeenCalled();
	});

	it("deletes once the reclaim proved the pid gone", async () => {
		findUnique.mockResolvedValueOnce({
			id: SESSION_ID,
			status: "ERROR",
			pid: 4242,
			processGoneAt: new Date("2026-08-29T00:00:00.000Z"),
		});
		expect((await delReq()).status).toBe(200);
		expect(sessionDeleteMany).toHaveBeenCalled();
	});

	it("enforces the pid guard ATOMICALLY, not only in the pre-read", async () => {
		findUnique.mockResolvedValueOnce({
			id: SESSION_ID,
			status: "STOPPED",
			pid: null,
			processGoneAt: null,
		});
		await delReq();
		const where = (
			sessionDeleteMany.mock.calls[0]?.[0] as { where: Record<string, unknown> }
		).where;
		// A reclaim that has not happened yet must not lose a race with the
		// delete: the guarded deleteMany carries the same condition — and, since
		// LC-02, the claim-released condition beside it (each carries an OR, so
		// they meet under AND).
		expect(where).toMatchObject({
			AND: [
				{ OR: [{ pid: null }, { processGoneAt: { not: null } }] },
				{
					OR: [
						{ publisherClaimedAt: null },
						{ publisherReleasedAt: { not: null } },
					],
				},
			],
		});
	});

	/**
	 * Audit 5c3d97ca BLOCKER-2 / LC-02 — a terminal row can still HOLD the
	 * channel's publisher claim (its owning worker has not yet observed its
	 * child's exit — the lost-stop window). Deleting it would erase the
	 * channel's occupancy record while the push is being torn down.
	 */
	it("409s a terminal session that still holds the publisher claim, even with no pid", async () => {
		findUnique.mockResolvedValueOnce({
			id: SESSION_ID,
			status: "STOPPED",
			pid: null,
			processGoneAt: null,
			publisherClaimedAt: new Date("2026-08-30T00:00:00.000Z"),
			publisherReleasedAt: null,
		});
		const res = await delReq();
		expect(res.status).toBe(409);
		const body = await res.text();
		expect(body).toContain("channel's input");
		expect(body).not.toContain("worker");
		expect(body).not.toContain("ffmpeg");
		expect($transaction).not.toHaveBeenCalled();
		expect(sessionDeleteMany).not.toHaveBeenCalled();
	});

	it("deletes once the claim was released on proof", async () => {
		findUnique.mockResolvedValueOnce({
			id: SESSION_ID,
			status: "STOPPED",
			pid: null,
			processGoneAt: new Date("2026-08-30T00:00:00.000Z"),
			publisherClaimedAt: new Date("2026-08-30T00:00:00.000Z"),
			publisherReleasedAt: new Date("2026-08-30T00:00:00.000Z"),
		});
		expect((await delReq()).status).toBe(200);
		expect(sessionDeleteMany).toHaveBeenCalled();
	});

	it.each([
		"STOPPED",
		"ERROR",
	])("deletes a terminal session (%s) via the atomically-guarded deleteMany", async (status) => {
		findUnique.mockResolvedValueOnce({
			id: SESSION_ID,
			status,
			pid: null,
			processGoneAt: null,
		});
		const res = await delReq();
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ id: SESSION_ID, deleted: true });
		expect(sessionDeleteMany).toHaveBeenCalledWith({
			where: {
				id: SESSION_ID,
				status: { in: ["STOPPED", "ERROR"] },
				// Terminal AND process-free AND claim-free, all enforced in the
				// same write (LC-02 added the third).
				AND: [
					{ OR: [{ pid: null }, { processGoneAt: { not: null } }] },
					{
						OR: [
							{ publisherClaimedAt: null },
							{ publisherReleasedAt: { not: null } },
						],
					},
				],
			},
		});
		expect(auditCreate).toHaveBeenCalledTimes(1);
		const arg = auditCreate.mock.calls[0]?.[0] as {
			data: Record<string, unknown>;
		};
		expect(arg.data).toMatchObject({
			method: "DELETE",
			path: `/api/feeder-sessions/${SESSION_ID}`,
			statusCode: 200,
		});
	});

	it("rolls back and 409s when the row races out of a terminal state (guarded delete hits 0 rows)", async () => {
		// findUnique sees a terminal session, but the atomic deleteMany matches 0
		// rows (the supervisor flipped it back to active between read and write).
		findUnique.mockResolvedValueOnce({
			id: SESSION_ID,
			status: "STOPPED",
			pid: null,
			processGoneAt: null,
		});
		sessionDeleteMany.mockResolvedValueOnce({ count: 0 });
		const res = await delReq();
		expect(res.status).toBe(409);
		expect(await res.json()).toMatchObject({
			error: expect.stringMatching(/changed state/i),
			details: { code: "FEEDER_STATE_CHANGED" },
		});
		// No audit row for a 409 (no deletion happened).
		expect(auditCreate).not.toHaveBeenCalled();
	});
});
