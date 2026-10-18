import {
	FEEDER_ACTIVE_STATUSES,
	FEEDER_MAX_ACTIVE_SESSIONS,
	feederOccupancyWhere,
} from "@bitovp/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sessionCreate = vi.fn();
const runFindFirst = vi.fn<() => Promise<{ id: string } | null>>(async () => ({
	id: "run-1",
}));
const sessionUpdate = vi.fn();
const sessionFindMany = vi.fn();
const sessionCount = vi.fn();
const channelFindUnique = vi.fn();
const getCredential = vi.fn();
const queueAdd = vi.fn();
// Row 268: the cleanup seal's `?queue=1` read looks a session's jobs up by id.
const queueGetJob = vi.fn();

vi.mock("@/lib/server/context", () => ({
	getServerContext: () => ({
		prisma: {
			feederSession: {
				create: sessionCreate,
				update: sessionUpdate,
				findMany: sessionFindMany,
				count: sessionCount,
			},
			liveChannel: { findUnique: channelFindUnique },
			//  PR2 + SC-01: manual start binds to the exact current airing.
			liveChannelRun: { findFirst: runFindFirst },
		},
		credentials: { get: getCredential },
	}),
}));

vi.mock("@/lib/server/queue", () => ({
	getFeederQueue: () => ({ add: queueAdd, getJob: queueGetJob }),
}));

/**
 * : the arm-time SEAL. Mocked at the helper, not at the driver,
 * because what this route owns is the DECISION — write the version onto the
 * session, and refuse the create when the object cannot be read at all.
 * `sealSourceIdentity`'s own three-way contract is pinned in
 * `src/lib/server/storage.test.ts`.
 */
const sealSourceIdentity = vi.fn();
vi.mock("@/lib/server/storage", () => ({
	sealSourceIdentity: (...args: unknown[]) => sealSourceIdentity(...args),
}));

import { GET, POST } from "./route";

const CHANNEL_ID = "00000000-0000-4000-8000-0000000000bb";
const SESSION_ID = "00000000-0000-4000-8000-0000000000f1";
const CRED_ID = "00000000-0000-4000-8000-0000000000c1";
const SRT_CRED_ID = "00000000-0000-4000-8000-0000000000c2";

const rtmpBody = {
	liveChannelId: CHANNEL_ID,
	source: { credentialId: CRED_ID, bucket: "media", key: "loops/src.mp4" },
	protocol: "RTMP",
	target: { url: "rtmp://203.0.113.7/live", streamKey: "sk-secret" },
};

function postRequest(body: unknown): Request {
	return new Request("http://test/api/feeder-sessions", {
		method: "POST",
		body: JSON.stringify(body),
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.stubEnv("MASTER_KEY", Buffer.alloc(32, 7).toString("base64"));
	// THREE counts with three populations (LC-02): the global stop-slot cap,
	// the global publisher occupancy cap, and the per-channel single-pusher
	// rule. The default answers 0 for all three;
	// a `mockResolvedValueOnce` in an arm overrides the FIRST call, which is
	// the global cap — the order the route makes them in.
	sessionCount.mockResolvedValue(0);
	// The DRAINED default for the seal read: no job under the looked-up id.
	queueGetJob.mockResolvedValue(null);
	channelFindUnique.mockResolvedValue({ id: CHANNEL_ID, status: "RUNNING" });
	getCredential.mockImplementation(async (id: string) =>
		id === SRT_CRED_ID
			? { id, provider: "SRT_PASSPHRASE" }
			: { id, provider: "AWS_S3" },
	);
	// The HEALTHIEST default: the object is there and names a version.
	sealSourceIdentity.mockResolvedValue({
		ok: true,
		identity: { etag: '"abc123"', versionId: "v-1", size: 4096 },
	});
	sessionCreate.mockImplementation(async ({ data }) => ({
		id: SESSION_ID,
		liveChannelId: data.liveChannelId,
		status: data.status,
		protocol: data.protocol,
	}));
});

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("POST /api/feeder-sessions", () => {
	it("rejects malformed bodies and mismatched protocol/target shapes", async () => {
		expect((await POST(postRequest({}))).status).toBe(400);
		expect(
			(
				await POST(
					postRequest({
						...rtmpBody,
						protocol: "SRT_CALLER", // RTMP-shaped target → 400
					}),
				)
			).status,
		).toBe(400);
		expect(sessionCreate).not.toHaveBeenCalled();
	});

	it("rejects a literal SRT passphrase (vault refs only — strict schema)", async () => {
		const res = await POST(
			postRequest({
				...rtmpBody,
				protocol: "SRT_CALLER",
				target: { host: "h", port: 2090, passphrase: "p".repeat(16) },
			}),
		);
		expect(res.status).toBe(400);
		expect(sessionCreate).not.toHaveBeenCalled();
	});

	it("rejects sessions for channels that do not exist", async () => {
		channelFindUnique.mockResolvedValueOnce(null);
		const res = await POST(postRequest(rtmpBody));
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({
			error: expect.stringMatching(/does not exist/),
			details: { code: "FEEDER_CHANNEL_NOT_FOUND" },
		});
	});

	it.each([
		"CREATED",
		"STOPPING",
		"STOPPED",
		"ERROR",
	])("409s when the channel is %s (RUNNING|PROVISIONING only)", async (status) => {
		channelFindUnique.mockResolvedValueOnce({ id: CHANNEL_ID, status });
		const res = await POST(postRequest(rtmpBody));
		expect(res.status).toBe(409);
		expect(sessionCreate).not.toHaveBeenCalled();
	});

	it("409s once FEEDER_MAX_ACTIVE_SESSIONS rows are active (stop-slot guarantee)", async () => {
		sessionCount.mockResolvedValueOnce(FEEDER_MAX_ACTIVE_SESSIONS);
		const res = await POST(postRequest(rtmpBody));
		expect(res.status).toBe(409);
		expect((await res.json()).error).toMatch(/session limit reached/);
		expect(sessionCreate).not.toHaveBeenCalled();
		expect(queueAdd).not.toHaveBeenCalled();
		// The gate counts non-terminal sessions only — slots free up on stop.
		expect(sessionCount).toHaveBeenCalledWith({
			where: { status: { in: ["CREATED", "DOWNLOADING", "PUSHING"] } },
		});
	});

	it("admits sessions while active rows stay below the cap (boundary: cap − 1)", async () => {
		sessionCount.mockResolvedValueOnce(FEEDER_MAX_ACTIVE_SESSIONS - 1);
		const res = await POST(postRequest(rtmpBody));
		expect(res.status).toBe(201);
		expect(sessionCreate).toHaveBeenCalled();
		// The name is a list-only addition; create's response stays unchanged.
		expect(sessionCreate.mock.calls[0]?.[0]?.select).not.toHaveProperty(
			"liveChannel",
		);
	});

	it("409s once global publisher OCCUPANCY reaches the cap, even when active worker slots are empty", async () => {
		sessionCount
			.mockResolvedValueOnce(0)
			.mockResolvedValueOnce(FEEDER_MAX_ACTIVE_SESSIONS);
		const res = await POST(postRequest(rtmpBody));
		expect(res.status).toBe(409);
		expect((await res.json()).error).toMatch(/concurrent file-input limit/i);
		expect(sessionCreate).not.toHaveBeenCalled();
		expect(queueAdd).not.toHaveBeenCalled();
		expect(sessionCount).toHaveBeenNthCalledWith(2, {
			where: feederOccupancyWhere(),
		});
	});

	it("does not charge a two-phase stage against publisher occupancy — it claims only at commit", async () => {
		sessionCount.mockImplementation(
			async (args: { where?: { liveChannelId?: string; OR?: unknown[] } }) => {
				if (args.where?.liveChannelId === CHANNEL_ID) return 1;
				if (Array.isArray(args.where?.OR)) return FEEDER_MAX_ACTIVE_SESSIONS;
				return 0;
			},
		);
		const res = await POST(
			postRequest({ ...rtmpBody, switchFromActive: true }),
		);
		expect(res.status).toBe(201);
		expect(sessionCreate).toHaveBeenCalled();
		expect(sessionCount).not.toHaveBeenCalledWith({
			where: feederOccupancyWhere(),
		});
	});

	it("rejects missing source credentials and non-SRT passphrase credentials", async () => {
		getCredential.mockResolvedValueOnce(null);
		const missingSource = await POST(postRequest(rtmpBody));
		expect(missingSource.status).toBe(400);
		expect(await missingSource.json()).toMatchObject({
			details: { code: "FEEDER_SOURCE_CREDENTIAL_MISSING" },
		});

		// Source credential resolves, but the passphrase ref points at AWS_S3.
		const res = await POST(
			postRequest({
				...rtmpBody,
				protocol: "SRT_CALLER",
				target: { host: "h", port: 2090, passphraseCredentialId: CRED_ID },
			}),
		);
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({
			error: expect.stringMatching(/SRT_PASSPHRASE/),
			details: { code: "FEEDER_SRT_CREDENTIAL_INVALID" },
		});
	});

	it("persists CREATED and enqueues the start job (jobId = row id dedupe)", async () => {
		const res = await POST(postRequest(rtmpBody));
		expect(res.status).toBe(201);
		const data = sessionCreate.mock.calls[0]?.[0]?.data as Record<
			string,
			unknown
		>;
		expect(data).toMatchObject({
			liveChannelId: CHANNEL_ID,
			liveChannelRunId: "run-1",
			status: "CREATED",
			sourceCredentialId: CRED_ID,
			sourceBucket: "media",
			sourceKey: "loops/src.mp4",
			protocol: "RTMP",
		});
		expect(queueAdd).toHaveBeenCalledWith(
			"feeder",
			{ feederSessionId: SESSION_ID, action: "start" },
			expect.objectContaining({ jobId: SESSION_ID }),
		);
	});

	it("refuses a manual feeder when no exact current run exists", async () => {
		runFindFirst.mockResolvedValueOnce(null);
		const res = await POST(postRequest(rtmpBody));
		expect(res.status).toBe(409);
		expect(((await res.json()) as { error: string }).error).toMatch(
			/current live run/,
		);
		expect(sessionCreate).not.toHaveBeenCalled();
		expect(queueAdd).not.toHaveBeenCalled();
	});

	/**
	 * : the immediate switch is the scheduled switch with lead 0 —
	 * the commit instant is creation and the commit is requested at once, so
	 * the feeder worker stages first and stops the active feeder only when the
	 * new source is READY. Without the flag the create is exactly what it was.
	 */
	/**
	 * rev367 S-1 — the single-pusher rule is the SERVER's, not the panel's.
	 * The ingest takes one publisher; a second ordinary session beside an
	 * active one jams it, and a switch from nothing is a stale checkbox.
	 */
	it("refuses an ordinary create while the channel has an active feeder — a switch or a stop is the way forward", async () => {
		sessionCount.mockImplementation(
			async (args: { where?: { liveChannelId?: string } }) =>
				args?.where?.liveChannelId ? 1 : 0,
		);
		const res = await POST(postRequest(rtmpBody));
		expect(res.status).toBe(409);
		expect(((await res.json()) as { error: string }).error).toContain(
			"already has an active file input",
		);
		expect(sessionCreate).not.toHaveBeenCalled();
		expect(queueAdd).not.toHaveBeenCalled();
	});

	/**
	 * Audit 5c3d97ca BLOCKER-2 / LC-02: the per-channel door counted the STATUS
	 * list, so a terminal row whose ffmpeg was not proven gone (a cross-host
	 * takeover refusal, a not-ours stop, a dead START job) was invisible to it
	 * while its push continued. The door now counts core's ONE occupancy
	 * fragment — a held publisher claim, a process nobody has proven gone, an
	 * active single-phase session. The worker-slot cap counts core's active
	 * list, while the publisher cap asks the same occupancy globally. Pinned
	 * structurally: the fragment's meaning is proven row by row in
	 * core's `occupancy.test.ts`; what this route owns is WHICH question it asks.
	 */
	it("asks active worker slots, global OCCUPANCY, then channel OCCUPANCY — core's fragments, in that order", async () => {
		const res = await POST(postRequest(rtmpBody));
		expect(res.status).toBe(201);
		expect(sessionCount).toHaveBeenNthCalledWith(1, {
			where: { status: { in: [...FEEDER_ACTIVE_STATUSES] } },
		});
		expect(sessionCount).toHaveBeenNthCalledWith(2, {
			where: feederOccupancyWhere(),
		});
		expect(sessionCount).toHaveBeenNthCalledWith(3, {
			where: feederOccupancyWhere(CHANNEL_ID),
		});
		// The occupancy question is NOT the status question: it also names the
		// held-claim and the unproven-pid arms, which the status list cannot.
		const occupancy = sessionCount.mock.calls[2]?.[0] as {
			where: { OR: unknown[] };
		};
		expect(occupancy.where.OR).toEqual(
			expect.arrayContaining([
				{ publisherClaimedAt: { not: null }, publisherReleasedAt: null },
				{ pid: { not: null }, processGoneAt: null },
			]),
		);
	});

	it("refuses an ordinary create while a TERMINAL row still occupies the channel, and says why", async () => {
		// The audit's row: ERROR, pid kept, nothing proven — the door's count
		// answers 1 for the occupancy question and 0 for the status question.
		sessionCount.mockImplementation(
			async (args: { where?: { liveChannelId?: string; OR?: unknown[] } }) =>
				args?.where?.liveChannelId && Array.isArray(args.where.OR) ? 1 : 0,
		);
		const res = await POST(postRequest(rtmpBody));
		expect(res.status).toBe(409);
		expect(((await res.json()) as { error: string }).error).toContain(
			"shutdown is not yet confirmed",
		);
		expect(sessionCreate).not.toHaveBeenCalled();
		// The switch is the coordinated way forward: admitted against the same
		// occupant, because its barrier waits for that process to be proven gone.
		const asSwitch = await POST(
			postRequest({ ...rtmpBody, switchFromActive: true }),
		);
		expect(asSwitch.status).toBe(201);
	});

	/**
	 * The active-row unique-index finding (audit 602ec286 HIGH-1): the
	 * per-channel count above is
	 * check-then-act — two concurrent POSTs both read zero active and both reach
	 * the create. The partial unique index
	 * `FeederSession_one_active_pusher_per_channel` is the ATOMIC backstop:
	 * exactly one INSERT wins, the loser's is a P2002 answered as 409. Modelled
	 * here because a unit test's fake Prisma does not enforce partial indexes —
	 * the create lets ONE active commitAt-null row per channel through and throws
	 * P2002 for a second. The DB↔schema equivalence of the real index is proven
	 * by `prisma migrate diff`, not here.
	 */
	it("two racing creates on one channel yield exactly one 201 and one 409 — the DB constraint is the atomic single-pusher backstop", async () => {
		const activeBarrierless = new Set<string>();
		sessionCreate.mockImplementation(async ({ data }) => {
			// The partial index's population: active AND barrier-less (a switch
			// row carries commitAt and is exempt — it stages behind the barrier).
			if (data.commitAt == null) {
				if (activeBarrierless.has(data.liveChannelId)) {
					throw Object.assign(new Error("Unique constraint failed"), {
						code: "P2002",
						meta: { target: "FeederSession_one_active_pusher_per_channel" },
					});
				}
				activeBarrierless.add(data.liveChannelId);
			}
			return {
				id: SESSION_ID,
				liveChannelId: data.liveChannelId,
				status: data.status,
				protocol: data.protocol,
			};
		});
		// Both POSTs clear the (racy) count check — count stays 0 — so both reach
		// the create; the index decides the winner.
		const [first, second] = await Promise.all([
			POST(postRequest(rtmpBody)),
			POST(postRequest(rtmpBody)),
		]);
		const statuses = [first.status, second.status].sort((a, b) => a - b);
		expect(statuses).toEqual([201, 409]);
		// Exactly one active row survived the race.
		expect(activeBarrierless.size).toBe(1);
		const loser = first.status === 409 ? first : second;
		expect(((await loser.json()) as { error: string }).error).toContain(
			"active file input",
		);
		// The winner enqueued its start job; the loser never did.
		expect(queueAdd).toHaveBeenCalledTimes(1);
	});

	it("an UNRELATED unique violation is NOT masked as the single-pusher 409 (name-checked → 500)", async () => {
		sessionCreate.mockImplementationOnce(async () => {
			throw Object.assign(new Error("Unique constraint failed"), {
				code: "P2002",
				meta: { target: "SomeOther_unique_key" },
			});
		});
		const res = await POST(postRequest(rtmpBody));
		expect(res.status).toBe(500);
	});

	it("admits the same create AS a switch — and refuses the switch flag when there is nothing to switch from", async () => {
		sessionCount.mockImplementation(
			async (args: { where?: { liveChannelId?: string } }) =>
				args?.where?.liveChannelId ? 1 : 0,
		);
		const ok = await POST(postRequest({ ...rtmpBody, switchFromActive: true }));
		expect(ok.status).toBe(201);

		sessionCreate.mockClear();
		sessionCount.mockResolvedValue(0);
		const nothing = await POST(
			postRequest({ ...rtmpBody, switchFromActive: true }),
		);
		expect(nothing.status).toBe(409);
		expect(((await nothing.json()) as { error: string }).error).toContain(
			"needs an active file input",
		);
		expect(sessionCreate).not.toHaveBeenCalled();
	});

	it("switchFromActive stages the session with the commit pre-requested; without it nothing two-phase is written", async () => {
		// An active session on the channel, so the switch is admissible.
		sessionCount.mockImplementation(
			async (args: { where?: { liveChannelId?: string } }) =>
				args?.where?.liveChannelId ? 1 : 0,
		);
		const res = await POST(
			postRequest({ ...rtmpBody, switchFromActive: true }),
		);
		expect(res.status).toBe(201);
		const staged = sessionCreate.mock.calls[0]?.[0]?.data as Record<
			string,
			unknown
		>;
		expect(staged.commitAt).toBeInstanceOf(Date);
		expect(staged.commitRequestedAt).toBeInstanceOf(Date);
		expect(staged.commitAt).toEqual(staged.commitRequestedAt);
		// Still one ordinary start job — the worker's own path does the rest.
		expect(queueAdd).toHaveBeenCalledWith(
			"feeder",
			{ feederSessionId: SESSION_ID, action: "start" },
			expect.objectContaining({ jobId: SESSION_ID }),
		);

		sessionCreate.mockClear();
		// No active session any more: the plain create is admissible again.
		sessionCount.mockResolvedValue(0);
		await POST(postRequest(rtmpBody));
		const plain = sessionCreate.mock.calls[0]?.[0]?.data as Record<
			string,
			unknown
		>;
		expect(plain).not.toHaveProperty("commitAt");
		expect(plain).not.toHaveProperty("commitRequestedAt");
	});

	/**
	 *  (audit 2026-08-29 HIGH-4): bucket/key name a LOCATION, and a
	 * location is not a version. An immediate session is short-lived but not
	 * atomic — the download still runs behind a channel wait, an ffprobe and a
	 * compatibility gate — so this door seals too.
	 */
	it("SEALS the object's version onto the session at creation", async () => {
		await POST(postRequest(rtmpBody));
		expect(sealSourceIdentity).toHaveBeenCalledWith(
			expect.anything(),
			CRED_ID,
			"media",
			"loops/src.mp4",
		);
		expect(sessionCreate.mock.calls[0]?.[0]?.data).toMatchObject({
			sourceEtag: '"abc123"',
			sourceVersionId: "v-1",
			sourceGeneration: null,
			sourceSize: 4096n,
		});
	});

	it("a driver that cannot name a version still creates the session — unsealed, never refused", async () => {
		sealSourceIdentity.mockResolvedValue({ ok: true, identity: null });
		const res = await POST(postRequest(rtmpBody));
		expect(res.status).toBe(201);
		const data = sessionCreate.mock.calls[0]?.[0]?.data as Record<
			string,
			unknown
		>;
		expect(data).not.toHaveProperty("sourceSize");
	});

	it("refuses at the door when the source object cannot be read at all", async () => {
		sealSourceIdentity.mockResolvedValue({
			ok: false,
			message: "Storage request failed: NoSuchKey (upstream 404)",
		});
		const res = await POST(postRequest(rtmpBody));
		expect(res.status).toBe(422);
		await expect(res.json()).resolves.toMatchObject({
			error: expect.stringContaining("NoSuchKey"),
			details: { code: "FEEDER_SOURCE_UNREADABLE" },
		});
		// Never created: a session whose source is unreadable only moves the
		// failure to the worker.
		expect(sessionCreate).not.toHaveBeenCalled();
		expect(queueAdd).not.toHaveBeenCalled();
	});

	it("accepts SRT caller sessions whose passphrase ref is a vault SRT credential", async () => {
		const res = await POST(
			postRequest({
				...rtmpBody,
				protocol: "SRT_CALLER",
				target: {
					host: "srt.example",
					port: 2090,
					passphraseCredentialId: SRT_CRED_ID,
				},
			}),
		);
		expect(res.status).toBe(201);
		expect(getCredential).toHaveBeenCalledWith(SRT_CRED_ID);
	});

	it("marks the row ERROR when enqueueing fails (recreate hint — no start action)", async () => {
		queueAdd.mockRejectedValueOnce(new Error("redis down"));
		const res = await POST(postRequest(rtmpBody));
		expect(res.status).toBe(500);
		expect(sessionUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: SESSION_ID },
				data: expect.objectContaining({ status: "ERROR" }),
			}),
		);
	});
});

describe("GET /api/feeder-sessions", () => {
	it("returns a lean projection — never target/logTail/loopBoundaries", async () => {
		sessionFindMany.mockResolvedValueOnce([
			{
				id: SESSION_ID,
				status: "PUSHING",
				protocol: "RTMP",
				liveChannel: { name: "Morning programme" },
			},
		]);
		const res = await GET(new Request("http://test/api/feeder-sessions"));
		expect(res.status).toBe(200);
		const args = sessionFindMany.mock.calls[0]?.[0] as {
			select: Record<string, unknown>;
		};
		// target carries the RTMP streamKey — list exclusion is the contract.
		expect(args.select).not.toHaveProperty("target");
		expect(args.select).not.toHaveProperty("logTail");
		expect(args.select).not.toHaveProperty("loopBoundaries");
		expect(args.select).toHaveProperty("status");
		// The related channel contributes ONLY its human-readable name, not
		// its plan, step log, encoding inputs or provider credentials.
		expect(args.select.liveChannel).toEqual({ select: { name: true } });
		expect((await res.json()).items[0].liveChannel).toEqual({
			name: "Morning programme",
		});
	});

	it("withholds legacy process diagnostics from the customer list payload", async () => {
		sessionFindMany.mockResolvedValueOnce([
			{
				id: SESSION_ID,
				status: "ERROR",
				error: "worker lost ffmpeg PID 4242 while -stream_loop remained active",
			},
		]);
		const res = await GET(new Request("http://test/api/feeder-sessions"));
		const body = (await res.json()) as {
			items: { error: string | null; internalFailure: boolean }[];
		};
		expect(body.items[0]).toMatchObject({
			error: null,
			internalFailure: true,
		});
		expect(JSON.stringify(body)).not.toMatch(/worker|ffmpeg|PID|stream_loop/i);
	});

	it("filters by liveChannelId for channel detail views", async () => {
		sessionFindMany.mockResolvedValueOnce([]);
		await GET(
			new Request(
				`http://test/api/feeder-sessions?liveChannelId=${CHANNEL_ID}`,
			),
		);
		expect(sessionFindMany.mock.calls[0]?.[0]).toMatchObject({
			where: { liveChannelId: CHANNEL_ID },
		});
	});

	// Row 268 (audit 602ec286 BLOCKER-2): the opt-in `queue=1` per-session
	// pending-job read the cleanup seal uses to prove the feeder queue drained.
	it("without queue=1, adds no queued field (the UI list stays Redis-free)", async () => {
		sessionFindMany.mockResolvedValueOnce([
			{ id: SESSION_ID, status: "STOPPED" },
		]);
		const res = await GET(new Request("http://test/api/feeder-sessions"));
		const body = (await res.json()) as { items: Record<string, unknown>[] };
		expect(body.items[0]).not.toHaveProperty("queued");
		expect(queueGetJob).not.toHaveBeenCalled();
	});

	it("with queue=1, marks a session queued when a pending job remains", async () => {
		sessionFindMany.mockResolvedValueOnce([
			{ id: SESSION_ID, status: "STOPPED" },
		]);
		// The stop job is still waiting to run.
		queueGetJob.mockImplementation(async (jobId: string) =>
			jobId === `${SESSION_ID}-stop`
				? { getState: async () => "waiting" }
				: null,
		);
		const res = await GET(
			new Request("http://test/api/feeder-sessions?queue=1"),
		);
		const body = (await res.json()) as {
			items: { id: string; queued: boolean | null }[];
		};
		expect(body.items[0]?.queued).toBe(true);
	});

	it("with queue=1, a session whose jobs are all settled or absent is not queued", async () => {
		sessionFindMany.mockResolvedValueOnce([
			{ id: SESSION_ID, status: "STOPPED" },
		]);
		// A retained completed job is present but DRAINED — not a job still to run.
		queueGetJob.mockImplementation(async (jobId: string) =>
			jobId === SESSION_ID ? { getState: async () => "completed" } : null,
		);
		const res = await GET(
			new Request("http://test/api/feeder-sessions?queue=1"),
		);
		const body = (await res.json()) as {
			items: { id: string; queued: boolean | null }[];
		};
		expect(body.items[0]?.queued).toBe(false);
	});

	it("with queue=1, degrades to queued:null when the queue cannot be read", async () => {
		// A null is UNKNOWN, not drained — the seal must not read a dead broker
		// as an empty queue.
		sessionFindMany.mockResolvedValueOnce([
			{ id: SESSION_ID, status: "STOPPED" },
		]);
		queueGetJob.mockRejectedValue(new Error("redis down"));
		const res = await GET(
			new Request("http://test/api/feeder-sessions?queue=1"),
		);
		const body = (await res.json()) as {
			items: { id: string; queued: boolean | null }[];
		};
		expect(body.items[0]?.queued).toBeNull();
	});
});
