import { readFileSync } from "node:fs";
import { join } from "node:path";
import { verificationRequestSha256 } from "@bitovp/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const create = vi.fn();
const update = vi.fn();
const updateMany = vi.fn();
const findMany = vi.fn();
const scheduleCreateMany = vi.fn<
	(args: { data: Record<string, unknown>[] }) => Promise<{ count: number }>
>(async () => ({ count: 0 }));
const scheduleFindMany = vi.fn(async () => []);
const getAccount = vi.fn();
const queueAdd = vi.fn();
// review-223 F4: the slate credential is checked at CREATION (422), not
// discovered broken at registration time.
const credFindUnique = vi.fn(async () => ({ provider: "AWS_S3" }));

// The creation is transactional : a channel with half its
// schedule rows would fire a START with no STOP. The tx double hands the
// callback the same delegates so assertions see every write.
const presetFindFirst = vi.fn();
/**
 * open alerts for the whole page come from ONE grouped read. The
 * default is an empty grouping — "looked, found none" — so every pre-existing
 * GET test keeps meaning what it meant.
 */
const alertGroupBy = vi.fn<
	(
		args: unknown,
	) => Promise<{ liveChannelId: string; _count: { _all: number } }[]>
>(async () => []);
/**
 * the newest run per channel is a separate BOUNDED statement
 * (`latestRunsFor`), not a nested `runs: { take: 1 }` on the channel query —
 * Prisma pushes no limit into that one, so it read every airing of every
 * channel on the page. The default is "no channel has run", which is what the
 * projection tests want; the health cases seed it explicitly.
 */
const queryRaw = vi.fn(async (..._args: unknown[]): Promise<unknown[]> => []);
// EV-01: the verification-key pre-check. Default null — "no row carries the
// key" — so every pre-existing case keeps meaning what it meant.
const findUnique = vi.fn(async (_args: unknown): Promise<unknown> => null);
const prismaMock = {
	liveChannel: { create, update, updateMany, findMany, findUnique },
	$queryRaw: queryRaw,
	preset: { findFirst: presetFindFirst },
	liveSchedule: { createMany: scheduleCreateMany, findMany: scheduleFindMany },
	alertEvent: { groupBy: alertGroupBy },
	credential: { findUnique: credFindUnique, findMany: vi.fn(async () => []) },
	$transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
		fn(prismaMock),
	),
	auditLog: { create: vi.fn(async () => ({})) },
};

vi.mock("@/lib/server/context", () => ({
	getServerContext: () => ({
		prisma: prismaMock,
		bitmovinAccounts: { get: getAccount },
		// : rail 3b's resolver. These five route tests are the
		// ones whose route reaches `submitterValidationOptions`, which now
		// REQUIRES it — the other ~85 context mocks in this app are
		// untouched because their routes never ask. An empty set is the
		// honest default here: "looked, found none", which is what a
		// deployment with no MSL credentials returns.
		credentials: {
			publishingAuthCredentialIds: async () => new Set<string>(),
		},
	}),
}));

vi.mock("@/lib/server/queue", () => ({
	getLiveChannelQueue: () => ({ add: queueAdd }),
}));

/**
 * the arm-time SEAL for derived FEEDER rows. This route is the ONLY
 * door that creates them (`liveScheduleArmSchema` refuses a manual arm), so it
 * is the only place an arm-time seal can be taken.
 */
const sealSourceIdentity = vi.fn();
vi.mock("@/lib/server/storage", () => ({
	sealSourceIdentity: (...args: unknown[]) => sealSourceIdentity(...args),
}));

import { ACTOR_HEADER } from "@/lib/auth/api-token-gate";
import { GET, POST } from "./route";

const fixturePath = join(
	__dirname,
	"../../../../../../packages/core/src/live/__fixtures__/live-zixi.plan.json",
);
const plan = JSON.parse(readFileSync(fixturePath, "utf8")) as Record<
	string,
	unknown
>;
const ACCOUNT_ID = "00000000-0000-4000-8000-00000000000a";
const CHANNEL_ID = "00000000-0000-4000-8000-0000000000bb";
const PRESET_ID = "77777777-8888-4999-8aaa-bbbbbbbbbbbb";

function withAccount(base: Record<string, unknown> = plan) {
	return {
		...base,
		bitmovin: { ...(base.bitmovin as object), accountId: ACCOUNT_ID },
	};
}

function postRequest(body: unknown, actor?: string): Request {
	return new Request("http://test/api/live-channels", {
		method: "POST",
		headers: actor ? { [ACTOR_HEADER]: actor } : {},
		body: JSON.stringify(body),
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	queryRaw.mockImplementation(async () => []);
	update.mockImplementation(async () => ({}));
	updateMany.mockImplementation(async () => ({ count: 1 }));
	vi.stubEnv("MASTER_KEY", Buffer.alloc(32, 7).toString("base64"));
	getAccount.mockResolvedValue({ id: ACCOUNT_ID });
	// The HEALTHIEST default: every source is there and names a version.
	sealSourceIdentity.mockImplementation(
		async (_ctx: unknown, _cred: string, _bucket: string, key: string) => ({
			ok: true,
			identity: { etag: `"etag-of-${key}"`, size: key.length },
		}),
	);
	create.mockImplementation(async ({ data }) => ({
		id: CHANNEL_ID,
		name: data.name,
		status: data.status,
		// The route's create SELECT carries the derived slot (review-223 F8);
		// the double echoes what a projected row would.
		programStartAt: data.programStartAt ?? null,
		programEndAt: data.programEndAt ?? null,
		maxRunMinutes: data.maxRunMinutes ?? null,
	}));
});

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("POST /api/live-channels", () => {
	it("refuses a BARE plan — the wrapper is required (API-USAGE.md)", async () => {
		/**
		 * The behavioural half of the doc's wrapper claim. `api-usage-doc.test.ts`
		 * pinned it as `route.toContain("plan: z.unknown")`, which review showed
		 * is blind to the widening it exists to catch: `z.unknown.optional`
		 * CONTAINS `z.unknown`, so a route widened to accept both a wrapper and
		 * a bare plan keeps that guard green. This one fails.
		 */
		const res = await POST(postRequest(withAccount()));
		expect(res.status).toBe(400);
	});

	it("rejects malformed plans with field details", async () => {
		const res = await POST(postRequest({ plan: { planVersion: 1 } }));
		expect(res.status).toBe(400);
		expect(create).not.toHaveBeenCalled();
	});

	it("rejects unknown plan keys (strict schema)", async () => {
		const res = await POST(
			postRequest({ plan: { ...withAccount(), surprise: true } }),
		);
		expect(res.status).toBe(400);
	});

	it("rejects plans failing error-level validator rails", async () => {
		const railBroken = structuredClone(withAccount()) as unknown as {
			muxings: { destination?: unknown }[];
		};
		// Live muxings must carry a destination — LIVE_MUXING_NO_DESTINATION.
		delete railBroken.muxings[0]?.destination;
		const res = await POST(postRequest({ plan: railBroken }));
		expect(res.status).toBe(400);
		const body = (await res.json()) as {
			details: { issues: { code: string }[] };
		};
		expect(
			body.details.issues.some((i) => i.code === "LIVE_MUXING_NO_DESTINATION"),
		).toBe(true);
		expect(create).not.toHaveBeenCalled();
	});

	it("rejects plans without a bitmovin account id", async () => {
		const res = await POST(postRequest({ plan }));
		expect(res.status).toBe(400);
		expect((await res.json()).error).toMatch(/accountId/);
	});

	it("rejects when the bitmovin account does not exist", async () => {
		getAccount.mockResolvedValueOnce(null);
		const res = await POST(postRequest({ plan: withAccount() }));
		expect(res.status).toBe(400);
		expect(queueAdd).not.toHaveBeenCalled();
	});

	it("stamps template provenance when both fields arrive (ledger #109 PR4)", async () => {
		presetFindFirst.mockResolvedValueOnce({ id: PRESET_ID });
		const res = await POST(
			postRequest({
				plan: withAccount(),
				presetId: PRESET_ID,
				presetRevision: 5,
			}),
		);
		expect(res.status).toBe(201);
		expect(presetFindFirst).toHaveBeenCalledWith({
			where: { id: PRESET_ID, kind: "LIVE_PLAN" },
			select: { id: true },
		});
		const data = create.mock.calls[0]?.[0]?.data as Record<string, unknown>;
		expect(data.presetId).toBe(PRESET_ID);
		expect(data.presetRevision).toBe(5);
	});

	it("writes NULL provenance for ad-hoc channels; 400s a lone presetId; 400s an unknown or JOB-kind template", async () => {
		let res = await POST(postRequest({ plan: withAccount() }));
		expect(res.status).toBe(201);
		expect(
			(create.mock.calls[0]?.[0]?.data as Record<string, unknown>).presetId,
		).toBeNull();
		expect(presetFindFirst).not.toHaveBeenCalled();

		vi.clearAllMocks();
		getAccount.mockResolvedValue({ defaults: {} });
		res = await POST(postRequest({ plan: withAccount(), presetId: PRESET_ID }));
		expect(res.status).toBe(400);
		expect(create).not.toHaveBeenCalled();

		// A FULL_PLAN id fails the LIVE_PLAN-scoped existence check — the
		// kinds are not interchangeable.
		presetFindFirst.mockResolvedValueOnce(null);
		res = await POST(
			postRequest({
				plan: withAccount(),
				presetId: PRESET_ID,
				presetRevision: 1,
			}),
		);
		expect(res.status).toBe(400);
		expect((await res.json()).error).toMatch(/template/i);
		expect(create).not.toHaveBeenCalled();
	});

	it("persists the parsed plan + initialized step log as CREATED and enqueues provisioning", async () => {
		const res = await POST(postRequest({ plan: withAccount() }));
		expect(res.status).toBe(201);

		const data = create.mock.calls[0]?.[0]?.data as Record<string, unknown>;
		expect(data.status).toBe("CREATED");
		expect(data.bitmovinAccountId).toBe(ACCOUNT_ID);
		const stepLog = data.stepLog as {
			step: string;
			status: string;
			kind: string;
		}[];
		expect(stepLog.length).toBeGreaterThan(10);
		expect(stepLog.every((s) => s.status === "PENDING")).toBe(true);
		expect(stepLog.at(0)?.step).toBe("live-input:main");
		expect(stepLog.at(-1)?.kind).toBe("AWAIT_LIVE_RUNNING");

		expect(queueAdd).toHaveBeenCalledWith(
			"live-channel",
			{ liveChannelId: CHANNEL_ID, action: "provision" },
			expect.objectContaining({ jobId: CHANNEL_ID }),
		);
	});

	it("marks the row ERROR when enqueueing fails (recoverable via start)", async () => {
		queueAdd.mockRejectedValueOnce(new Error("redis down"));
		const res = await POST(postRequest({ plan: withAccount() }));
		expect(res.status).toBe(500);
		expect(updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: CHANNEL_ID, status: "CREATED" },
				data: expect.objectContaining({ status: "ERROR" }),
			}),
		);
	});
});

describe("POST /api/live-channels with a program schedule (ledger #94)", () => {
	const CRED = "00000000-0000-4000-8000-0000000000c1";
	/** Tomorrow, so the future check passes without clock games. */
	const at = (h: number, m = 0) => {
		const d = new Date(Date.now() + 24 * 60 * 60_000);
		d.setUTCHours(h, m, 0, 0);
		return d.toISOString();
	};
	const SLOT = {
		streamUpAt: at(20, 45),
		programStartAt: at(21),
		programEndAt: at(22),
		slate: {
			source: { credentialId: CRED, bucket: "in", key: "slate.mp4" },
		},
	};

	it("the cap FORMULA on a literal clock — a bounds check that recomputes production's expression is a mirror and passes for a wrong formula (review-260 lens c)", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-09-01T10:00:30.000Z"));
		try {
			const res = await POST(
				postRequest({
					plan: withAccount(),
					schedule: {
						streamUpAt: "2026-09-01T20:45:00.000Z",
						programStartAt: "2026-09-01T21:00:00.000Z",
						programEndAt: "2026-09-01T22:00:00.000Z",
					},
				}),
			);
			expect(res.status).toBe(201);
			const channelData = create.mock.calls[0]?.[0]?.data as {
				maxRunMinutes?: number;
			};
			// Independent literals: provision 10:00:30 → end 22:00 = 719.5
			// min, ceil ⇒ 720, + 30 margin = 750. NOT derived from the
			// production expression — and the half-minute clock makes ceil
			// and floor DISTINGUISHABLE (review-260: an exact 720 left a
			// ceil→floor mutation green in 43 tests).
			expect(channelData.maxRunMinutes).toBe(750);
		} finally {
			vi.useRealTimers();
		}
	});

	it("creates the derived rows transactionally AND provisions now — 作成=起動中 (ledger #125)", async () => {
		const res = await POST(
			postRequest({ plan: withAccount(), schedule: SLOT }),
		);
		expect(res.status).toBe(201);

		//  (owner): the scheduled path used to wait for its derived
		// START row; now EVERY create provisions immediately — billing starts
		// at creation and the wizard says so. No START row is derived.
		expect(queueAdd).toHaveBeenCalledTimes(1);

		// Derived rows: START and SLATE_IN at stream-up, STOP at end. The
		// slate carries source + slateUntil and NO fixed duration — the sweep
		// computes it at fire time, or a late provision would overrun the
		// program (the whole reason slateUntil exists).
		expect(scheduleCreateMany).toHaveBeenCalledTimes(1);
		const rows = scheduleCreateMany.mock.calls[0]?.[0]?.data as {
			action: string;
			fireAt: Date;
			slateSource?: unknown;
			slateUntil?: Date;
			slateDurationSeconds?: number;
		}[];
		expect(rows.map((r) => r.action)).toEqual(["SLATE_IN", "STOP"]);
		const slate = rows[0];
		expect(slate?.slateSource).toMatchObject({ bucket: "in" });
		expect(slate?.slateUntil?.toISOString()).toBe(SLOT.programStartAt);
		expect(slate?.slateDurationSeconds).toBeUndefined();

		/* The runtime backstop counts from immediate provisioning to program end; using the later input-start time would stop the program too early. */
		const channelData = create.mock.calls[0]?.[0]?.data as {
			maxRunMinutes?: number;
			programStartAt?: Date;
			programEndAt?: Date;
		};
		const expectedCap =
			Math.ceil((Date.parse(SLOT.programEndAt) - Date.now()) / 60_000) + 30;
		expect(channelData.maxRunMinutes).toBeGreaterThanOrEqual(expectedCap - 1);
		expect(channelData.maxRunMinutes).toBeLessThanOrEqual(expectedCap + 1);
		expect(channelData.programStartAt?.toISOString()).toBe(SLOT.programStartAt);
		expect(channelData.programEndAt?.toISOString()).toBe(SLOT.programEndAt);
	});

	it("answers 201 WITH the derived window and cap — no second GET needed (review-223 F8)", async () => {
		const res = await POST(
			postRequest({ plan: withAccount(), schedule: SLOT }),
		);
		expect(res.status).toBe(201);
		const body = (await res.json()) as {
			programStartAt: string | null;
			programEndAt: string | null;
			maxRunMinutes: number | null;
		};
		expect(body.programStartAt).toBe(SLOT.programStartAt);
		expect(body.programEndAt).toBe(SLOT.programEndAt);
		// #125: cap = provision(now)→end + margin; bounded, same arithmetic.
		const expectedCap =
			Math.ceil((Date.parse(SLOT.programEndAt) - Date.now()) / 60_000) + 30;
		expect(body.maxRunMinutes).toBeGreaterThanOrEqual(expectedCap - 1);
		expect(body.maxRunMinutes).toBeLessThanOrEqual(expectedCap + 1);
		// And the select itself asks for them — the double above would echo
		// nothing real if the route stopped selecting the columns.
		const select = create.mock.calls[0]?.[0]?.select as Record<string, unknown>;
		expect(select.programStartAt).toBe(true);
		expect(select.programEndAt).toBe(true);
		expect(select.maxRunMinutes).toBe(true);
	});

	it("rejects a slate whose credential does not exist — 422 at creation, not a scheduled failure (review-223 F4)", async () => {
		credFindUnique.mockResolvedValueOnce(
			null as unknown as { provider: string },
		);
		const res = await POST(
			postRequest({ plan: withAccount(), schedule: SLOT }),
		);
		expect(res.status).toBe(422);
		expect((await res.json()).error).toMatch(/credential does not exist/);
		expect(create).not.toHaveBeenCalled();
		expect(scheduleCreateMany).not.toHaveBeenCalled();
	});

	it("rejects a slate credential on an UNSUPPORTED driver, naming the supported set", async () => {
		credFindUnique.mockResolvedValueOnce({ provider: "SFTP" });
		const res = await POST(
			postRequest({ plan: withAccount(), schedule: SLOT }),
		);
		expect(res.status).toBe(422);
		const error = (await res.json()).error as string;
		expect(error).toContain("SFTP");
		expect(error).toContain("AWS_S3");
		expect(create).not.toHaveBeenCalled();
	});

	/** The route fixture is ZIXI; feeder-chain slots need an RTMP-family plan. */
	function withRtmpInput(base: Record<string, unknown>) {
		return {
			...base,
			liveInput: { key: "main", kind: "RTMP" },
		};
	}

	it("a file-fed slot derives the FEEDER chain rows — no SLATE_IN, sources on the rows (ledger #96)", async () => {
		const res = await POST(
			postRequest({
				plan: withRtmpInput(withAccount()),
				schedule: {
					...SLOT,
					programFeed: {
						source: { credentialId: CRED, bucket: "in", key: "ep1.mp4" },
					},
				},
			}),
		);
		expect(res.status).toBe(201);
		const rows = scheduleCreateMany.mock.calls[0]?.[0]?.data as {
			action: string;
			feederSource?: { key?: string };
		}[];
		expect(rows.map((r) => r.action)).toEqual([
			"FEEDER_START",
			"FEEDER_SWITCH",
			"STOP",
		]);
		expect(rows[0]?.feederSource?.key).toBe("slate.mp4");
		expect(rows[1]?.feederSource?.key).toBe("ep1.mp4");
	});

	/**
	 *  (audit 2026-08-29 HIGH-4). `{credentialId, bucket, key}` names a
	 * LOCATION; a location is not a version. An object replaced under the same
	 * key between arm and air used to be pushed with no trace at all.
	 */
	it("SEALS each derived feeder row's source version onto the row", async () => {
		await POST(
			postRequest({
				plan: withRtmpInput(withAccount()),
				schedule: {
					...SLOT,
					programFeed: {
						source: { credentialId: CRED, bucket: "in", key: "ep1.mp4" },
					},
				},
			}),
		);
		const rows = scheduleCreateMany.mock.calls[0]?.[0]?.data as {
			action: string;
			feederSource?: { key?: string; identity?: Record<string, unknown> };
		}[];
		expect(rows[0]?.feederSource?.identity).toEqual({
			etag: '"etag-of-slate.mp4"',
			size: "slate.mp4".length,
		});
		expect(rows[1]?.feederSource?.identity).toEqual({
			etag: '"etag-of-ep1.mp4"',
			size: "ep1.mp4".length,
		});
		// One HEAD per DISTINCT source: two reads of one object could
		// legitimately disagree, and that would be recorded as two different
		// armings of the same file.
		expect(sealSourceIdentity).toHaveBeenCalledTimes(2);
	});

	it("refuses the whole create when a feed source cannot be read — 422, no channel", async () => {
		sealSourceIdentity.mockResolvedValue({
			ok: false,
			message: "Storage request failed: NoSuchKey (upstream 404)",
		});
		const res = await POST(
			postRequest({
				plan: withRtmpInput(withAccount()),
				schedule: {
					...SLOT,
					programFeed: {
						source: { credentialId: CRED, bucket: "in", key: "ep1.mp4" },
					},
				},
			}),
		);
		expect(res.status).toBe(422);
		await expect(res.json()).resolves.toMatchObject({
			error: expect.stringContaining("NoSuchKey"),
		});
		expect(create).not.toHaveBeenCalled();
	});

	it("a driver that cannot name a version leaves the row UNSEALED rather than refusing it", async () => {
		sealSourceIdentity.mockResolvedValue({ ok: true, identity: null });
		const res = await POST(
			postRequest({
				plan: withRtmpInput(withAccount()),
				schedule: {
					...SLOT,
					programFeed: {
						source: { credentialId: CRED, bucket: "in", key: "ep1.mp4" },
					},
				},
			}),
		);
		expect(res.status).toBe(201);
		const rows = scheduleCreateMany.mock.calls[0]?.[0]?.data as {
			feederSource?: { identity?: unknown };
		}[];
		expect(rows[0]?.feederSource).not.toHaveProperty("identity");
	});

	it("rejects a file-fed slot whose program credential does not exist — 422 at creation (ledger #96)", async () => {
		credFindUnique
			.mockResolvedValueOnce({ provider: "AWS_S3" }) // slate credential
			.mockResolvedValueOnce(null as unknown as { provider: string });
		const res = await POST(
			postRequest({
				plan: withRtmpInput(withAccount()),
				schedule: {
					...SLOT,
					programFeed: {
						source: { credentialId: CRED, bucket: "in", key: "ep1.mp4" },
					},
				},
			}),
		);
		expect(res.status).toBe(422);
		expect((await res.json()).error).toMatch(/program feed credential/);
		expect(create).not.toHaveBeenCalled();
	});

	it("rejects a program feed on a provider the feeder cannot download from — 422 with the set named (review-226 I2)", async () => {
		credFindUnique
			.mockResolvedValueOnce({ provider: "AWS_S3" }) // slate
			.mockResolvedValueOnce({ provider: "SFTP" }); // program feed
		const res = await POST(
			postRequest({
				plan: withRtmpInput(withAccount()),
				schedule: {
					...SLOT,
					programFeed: {
						source: { credentialId: CRED, bucket: "in", key: "ep1.mp4" },
					},
				},
			}),
		);
		expect(res.status).toBe(422);
		const error = (await res.json()).error as string;
		expect(error).toContain("SFTP");
		expect(error).toContain("not supported by the feeder");
		expect(create).not.toHaveBeenCalled();
	});

	it("a CHAIN slate is checked against the FEEDER set, not the splice set — swap, never disable (review-226 I2)", async () => {
		credFindUnique.mockResolvedValueOnce({ provider: "SFTP" }); // slate
		const res = await POST(
			postRequest({
				plan: withRtmpInput(withAccount()),
				schedule: {
					...SLOT,
					programFeed: {
						source: { credentialId: CRED, bucket: "in", key: "ep1.mp4" },
					},
				},
			}),
		);
		expect(res.status).toBe(422);
		expect((await res.json()).error).toContain("not supported by the feeder");
		expect(create).not.toHaveBeenCalled();
	});

	it("the SWAP itself, pinned by the one provider the sets disagree on: a GCS_SERVICE_ACCOUNT chain slate is 201 (feeder set) where the splice predicate would 422 (review-226 follow-up)", async () => {
		// SFTP above is in NEITHER set, so it can only prove "not disabled".
		// GCS_SERVICE_ACCOUNT is feeder-yes / splice-no — the violating
		// fixture this repo's own discipline demands: mutating the chain
		// branch back to isSlateSupportedProvider turns THIS red.
		credFindUnique
			.mockResolvedValueOnce({ provider: "GCS_SERVICE_ACCOUNT" }) // slate
			.mockResolvedValueOnce({ provider: "AWS_S3" }); // program feed
		const res = await POST(
			postRequest({
				plan: withRtmpInput(withAccount()),
				schedule: {
					...SLOT,
					programFeed: {
						source: { credentialId: CRED, bucket: "in", key: "ep1.mp4" },
					},
				},
			}),
		);
		expect(res.status).toBe(201);
	});

	it("rejects a file-fed slot on a non-RTMP-family plan — the worker's own derivation probed at creation (ledger #96)", async () => {
		const res = await POST(
			postRequest({
				plan: withAccount(), // the ZIXI fixture
				schedule: {
					...SLOT,
					programFeed: {
						source: { credentialId: CRED, bucket: "in", key: "ep1.mp4" },
					},
				},
			}),
		);
		expect(res.status).toBe(422);
		expect((await res.json()).error).toMatch(/RTMP-family/);
		expect(create).not.toHaveBeenCalled();
	});

	it("rejects a slot in the past with 422, creating nothing", async () => {
		const res = await POST(
			postRequest({
				plan: withAccount(),
				schedule: {
					streamUpAt: "2020-01-01T20:45:00.000Z",
					programStartAt: "2020-01-01T21:00:00.000Z",
					programEndAt: "2020-01-01T22:00:00.000Z",
				},
			}),
		);
		expect(res.status).toBe(422);
		expect(create).not.toHaveBeenCalled();
		expect(scheduleCreateMany).not.toHaveBeenCalled();
	});

	it("rejects bad ordering at the schema layer (programEnd before start)", async () => {
		const res = await POST(
			postRequest({
				plan: withAccount(),
				schedule: {
					...SLOT,
					programEndAt: SLOT.programStartAt,
				},
			}),
		);
		expect(res.status).toBe(400);
		expect(create).not.toHaveBeenCalled();
	});

	it("an UNSCHEDULED create still provisions immediately — the existing contract", async () => {
		const res = await POST(postRequest({ plan: withAccount() }));
		expect(res.status).toBe(201);
		expect(queueAdd).toHaveBeenCalledWith(
			"live-channel",
			{ liveChannelId: CHANNEL_ID, action: "provision" },
			expect.objectContaining({ jobId: CHANNEL_ID }),
		);
		expect(scheduleCreateMany).not.toHaveBeenCalled();
	});
});

describe("GET /api/live-channels", () => {
	it("returns a lean paginated projection (no plan/stepLog/lastHeartbeat)", async () => {
		// `schedules` is what real Prisma returns for the  relation
		// select; the route folds it to `nextSchedule`.
		findMany.mockResolvedValueOnce([
			{ id: CHANNEL_ID, name: "x", status: "RUNNING", schedules: [] },
		]);
		const res = await GET(new Request("http://test/api/live-channels"));
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			items: { nextSchedule: unknown; schedules?: unknown }[];
		};
		expect(body.items[0]?.nextSchedule).toBeNull();
		// Folded, not forwarded: the raw relation array never crosses.
		expect(body.items[0]).not.toHaveProperty("schedules");
		const args = findMany.mock.calls[0]?.[0] as {
			select: Record<string, boolean>;
		};
		expect(args.select).not.toHaveProperty("plan");
		expect(args.select).not.toHaveProperty("stepLog");
		expect(args.select).not.toHaveProperty("lastHeartbeat");
		expect(args.select).not.toHaveProperty("streamKey");
	});

	it("folds the soonest ARMED row into nextSchedule (ledger #84)", async () => {
		findMany.mockResolvedValueOnce([
			{
				id: CHANNEL_ID,
				name: "x",
				status: "STOPPED",
				schedules: [{ fireAt: "2099-01-01T09:00:00.000Z", action: "START" }],
			},
		]);
		const res = await GET(new Request("http://test/api/live-channels"));
		const body = (await res.json()) as { items: { nextSchedule: unknown }[] };
		expect(body.items[0]?.nextSchedule).toEqual({
			fireAt: "2099-01-01T09:00:00.000Z",
			action: "START",
		});
	});
});

/**
 * the Live list became an operations cockpit,
 * which needs per-channel health the old projection did not carry. The rule
 * these tests hold is the one the audit's finding rests on — the fleet is read
 * in a BOUNDED number of queries, and what crosses is a digest, not the
 * heartbeat column the lean-list contract keeps off the wire.
 */
describe("GET /api/live-channels — health digest (row #250)", () => {
	const RUN_ID = "00000000-0000-4000-8000-00000000d001";
	const OTHER_RUN_ID = "00000000-0000-4000-8000-00000000d002";

	/**
	 * What the CHANNEL query returns. No `runs` relation on it  —
	 * the newest run arrives from `latestRunsFor` below, keyed by channel id.
	 */
	function channelRow(over: Record<string, unknown> = {}) {
		return {
			id: CHANNEL_ID,
			name: "x",
			status: "RUNNING",
			schedules: [],
			feederSessions: [
				{ status: "PUSHING", liveChannelRunId: RUN_ID },
				{ status: "ERROR", liveChannelRunId: RUN_ID },
				// The PREVIOUS airing's dead feeder — not this run's fault.
				{ status: "ERROR", liveChannelRunId: OTHER_RUN_ID },
			],
			maxRunMinutes: 120,
			runningSince: "2026-08-29T10:00:00.000Z",
			...over,
		};
	}

	/**
	 * One row as `latestRunsFor` returns it — the newest run of ONE channel,
	 * fetched with its own per-channel `LIMIT 1` . The heavy JSON
	 * lives here rather than on the channel row precisely because that is where
	 * it now comes from.
	 */
	function runRow(over: Record<string, unknown> = {}) {
		return {
			id: RUN_ID,
			liveChannelId: CHANNEL_ID,
			seq: 2,
			lastHeartbeat: {
				at: "2026-08-29T12:00:00.000Z",
				raw: {
					ingest: {
						status: "CONNECTED",
						healthy: true,
						// Present in the column, and must NOT cross.
						streams: [{ id: "s1", codec: "H264" }],
					},
					events: [{ time: "t", message: "m" }],
				},
				deltas: { droppedPacketsVideo: 3 },
			},
			runningSince: "2026-08-29T11:00:00.000Z",
			endedAt: null,
			originObservation: {
				lastFetchAtMs: 1,
				lastVerdicts: {
					"a.m3u8": { stale: false, endlist: false, edgeDelaySeconds: 2 },
					"b.m3u8": { stale: true, endlist: false, edgeDelaySeconds: null },
				},
			},
			providerStatus: "RUNNING",
			providerStatusObservedAt: "2026-08-29T12:00:00.000Z",
			providerUnknownSince: null,
			providerTerminalAt: null,
			...over,
		};
	}

	/** Seeds the bounded run read for the next GET. */
	function withRuns(...rows: Record<string, unknown>[]) {
		queryRaw.mockResolvedValueOnce(rows);
	}

	async function getItems(): Promise<Record<string, unknown>[]> {
		const res = await GET(new Request("http://test/api/live-channels"));
		expect(res.status).toBe(200);
		const body = (await res.json()) as { items: Record<string, unknown>[] };
		return body.items;
	}

	it("carries every field the cockpit's columns read — the whole digest, not a subset", async () => {
		findMany.mockResolvedValueOnce([channelRow()]);
		withRuns(runRow());
		alertGroupBy.mockResolvedValueOnce([
			{ liveChannelId: CHANNEL_ID, _count: { _all: 4 } },
		]);
		const items = await getItems();
		/*
		 * Deep-equal, deliberately: a per-field `toHaveProperty` sweep passes
		 * for a route that dropped the field the reader actually needed, and
		 * every one of these is a column on screen. Dropping any one of them
		 * from the route fails HERE.
		 */
		expect(items[0]?.health).toEqual({
			heartbeat: {
				at: "2026-08-29T12:00:00.000Z",
				raw: { ingest: { status: "CONNECTED", healthy: true } },
			},
			openAlerts: 4,
			activeFeeders: 1,
			erroredFeeders: 1,
			origin: {
				observed: 2,
				stale: 1,
				endlist: 0,
				unavailableReason: null,
			},
			runningSince: "2026-08-29T11:00:00.000Z",
			endedAt: null,
			maxRunMinutes: 120,
			provider: {
				providerStatus: "RUNNING",
				providerStatusObservedAt: "2026-08-29T12:00:00.000Z",
				providerUnknownSince: null,
				providerTerminalAt: null,
			},
		});
	});

	it("the heartbeat DIGEST crosses, never the column — no streams, events or deltas", async () => {
		findMany.mockResolvedValueOnce([channelRow()]);
		withRuns(runRow());
		const items = await getItems();
		const serialized = JSON.stringify(items[0]);
		expect(serialized).not.toContain("streams");
		expect(serialized).not.toContain("events");
		expect(serialized).not.toContain("deltas");
	});

	/**
	 * . The channel query must carry NO `runs` relation: without
	 * `previewFeatures = ["relationJoins"]` a nested `runs: { take: 1 }`
	 * compiles to a runs read with `ORDER BY "seq" DESC OFFSET $n` and no
	 * LIMIT, so every airing of every channel on the page — heartbeat and
	 * origin JSON included — was read and thrown away in the engine.
	 */
	it("reads the newest run through the BOUNDED helper, not as a nested relation on the page", async () => {
		const second = "00000000-0000-4000-8000-0000000000cc";
		findMany.mockResolvedValueOnce([
			channelRow(),
			channelRow({ id: second, feederSessions: [] }),
		]);
		withRuns(runRow());
		const items = await getItems();
		// The channel query does not ask for runs at all…
		const args = findMany.mock.calls[0]?.[0] as {
			select: Record<string, unknown>;
		};
		expect(args.select).not.toHaveProperty("runs");
		// …a single bounded statement carries the page's ids instead…
		expect(queryRaw).toHaveBeenCalledTimes(1);
		expect(queryRaw.mock.calls[0]?.[1]).toEqual([CHANNEL_ID, second]);
		// …and the run fields on the response came from THAT statement.
		expect((items[0]?.health as { runningSince: unknown }).runningSince).toBe(
			"2026-08-29T11:00:00.000Z",
		);
		// A channel the statement returned no row for reads as "not started",
		// never as its neighbour's run.
		expect((items[1]?.health as { runningSince: unknown }).runningSince).toBe(
			"2026-08-29T10:00:00.000Z",
		);
		expect((items[1]?.health as { heartbeat: unknown }).heartbeat).toBeNull();
	});

	it("reads open alerts ONCE for the whole page, scoped to its ids — never a query per row", async () => {
		const second = "00000000-0000-4000-8000-0000000000cc";
		findMany.mockResolvedValueOnce([
			channelRow(),
			channelRow({ id: second, feederSessions: [] }),
		]);
		alertGroupBy.mockResolvedValueOnce([
			{ liveChannelId: second, _count: { _all: 1 } },
		]);
		const items = await getItems();
		expect(alertGroupBy).toHaveBeenCalledTimes(1);
		expect(alertGroupBy.mock.calls[0]?.[0]).toMatchObject({
			by: ["liveChannelId"],
			where: { resolvedAt: null, liveChannelId: { in: [CHANNEL_ID, second] } },
		});
		// A channel absent from the grouping has zero open alerts, not unknown.
		expect((items[0]?.health as { openAlerts: unknown }).openAlerts).toBe(0);
		expect((items[1]?.health as { openAlerts: unknown }).openAlerts).toBe(1);
	});

	it("an alert read that FAILS answers unknown and still returns the list — never a green zero", async () => {
		findMany.mockResolvedValueOnce([channelRow()]);
		alertGroupBy.mockRejectedValueOnce(new Error("relation does not exist"));
		const items = await getItems();
		expect((items[0]?.health as { openAlerts: unknown }).openAlerts).toBe(
			"unknown",
		);
	});

	it("a run with no heartbeat, no origin state and no feeders degrades to nulls and zeros, not to a throw", async () => {
		findMany.mockResolvedValueOnce([
			{ id: CHANNEL_ID, name: "x", status: "CREATED", schedules: [] },
		]);
		const items = await getItems();
		expect(items[0]?.health).toEqual({
			heartbeat: null,
			openAlerts: 0,
			activeFeeders: 0,
			erroredFeeders: 0,
			origin: null,
			runningSince: null,
			endedAt: null,
			maxRunMinutes: null,
			provider: null,
		});
	});

	it("an unobservable origin keeps its REASON — that is not the same as 'no output'", async () => {
		findMany.mockResolvedValueOnce([channelRow()]);
		withRuns(
			runRow({
				lastHeartbeat: null,
				runningSince: null,
				originObservation: { unavailableReason: "UNSUPPORTED_DRIVER" },
			}),
		);
		const items = await getItems();
		expect((items[0]?.health as { origin: unknown }).origin).toEqual({
			observed: 0,
			stale: 0,
			endlist: 0,
			unavailableReason: "UNSUPPORTED_DRIVER",
		});
	});

	it("hands out the server's clock, so the browser anchors ages to it rather than to the viewer's", async () => {
		findMany.mockResolvedValueOnce([channelRow()]);
		const res = await GET(new Request("http://test/api/live-channels"));
		const body = (await res.json()) as { serverNow?: string };
		expect(
			Number.isFinite(Date.parse(body.serverNow ?? "")),
			body.serverNow,
		).toBe(true);
	});
});

/**
 *  PR4 — probes are infrastructure, not content: the default
 * list hides them; the settings probe list asks for them explicitly.
 */
describe("GET /api/live-channels — probe filter", () => {
	it("default excludes probes; probes=only inverts; probes=include drops the filter", async () => {
		findMany.mockResolvedValue([]);
		await GET(new Request("http://test/api/live-channels"));
		expect(findMany.mock.calls.at(-1)?.[0].where).toEqual({ purpose: null });
		await GET(new Request("http://test/api/live-channels?probes=only"));
		expect(findMany.mock.calls.at(-1)?.[0].where).toEqual({
			purpose: "PROBE",
		});
		await GET(new Request("http://test/api/live-channels?probes=include"));
		expect(findMany.mock.calls.at(-1)?.[0].where).toEqual({});
	});
});

describe("createdBy attribution (#32 §5)", () => {
	it("stamps the verified actor onto the created channel", async () => {
		await POST(
			postRequest(
				{ plan: withAccount() },
				"user:11111111-2222-4333-8444-555555555555",
			),
		);
		expect(create).toHaveBeenCalled();
		expect(create.mock.calls[0]?.[0].data.createdBy).toBe(
			"user:11111111-2222-4333-8444-555555555555",
		);
	});

	it("no verified actor ⇒ null", async () => {
		await POST(postRequest({ plan: withAccount() }));
		expect(create.mock.calls[0]?.[0].data.createdBy).toBeNull();
	});
});

/**
 *  — the provider's automatic shutdown against the slot submitted
 * with it. The 2026-08-29 live audit's paid runs #1/#2 configured
 * `streamTimeoutMinutes = 6` and had a full slot's rows accepted; Bitmovin
 * ended the encoding at 6 minutes and every later row fired into nothing.
 */
describe("POST /api/live-channels — auto-shutdown vs the schedule window", () => {
	const CRED = "00000000-0000-4000-8000-0000000000c1";
	/** A literal clock, so the boundary arms below mean what they say. */
	const NOW = "2026-09-01T10:00:00.000Z";
	const LITERAL_SLOT = {
		streamUpAt: "2026-09-01T20:45:00.000Z",
		programStartAt: "2026-09-01T21:00:00.000Z",
		// 720 minutes after NOW — provisioning is creation since #125.
		programEndAt: "2026-09-01T22:00:00.000Z",
	};

	function planWithAutoShutdown(autoShutdown: Record<string, number>) {
		// `withAccount`'s spread of a Record loses the index signature, so
		// read the fixture's own `start` block off the parsed JSON instead.
		const base = withAccount() as Record<string, unknown>;
		return {
			...base,
			start: { ...(base.start as Record<string, unknown>), autoShutdown },
		};
	}

	async function postAt(
		plan: unknown,
		schedule?: unknown,
	): Promise<{ status: number; body: Record<string, unknown> }> {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(NOW));
		try {
			const res = await POST(
				postRequest(schedule === undefined ? { plan } : { plan, schedule }),
			);
			return {
				status: res.status,
				body: (await res.json()) as Record<string, unknown>,
			};
		} finally {
			vi.useRealTimers();
		}
	}

	it("refuses a slot the provider's streamTimeoutMinutes ends first, naming the knob and both instants", async () => {
		const { status, body } = await postAt(
			planWithAutoShutdown({ streamTimeoutMinutes: 6 }),
			LITERAL_SLOT,
		);
		expect(status).toBe(422);
		expect(body.error).toBe(
			"streamTimeoutMinutes=6 ends the run by 2026-09-01T10:06:00.000Z; the program end at 2026-09-01T22:00:00.000Z is after that",
		);
		expect(create).not.toHaveBeenCalled();
		expect(scheduleCreateMany).not.toHaveBeenCalled();
	});

	it("refuses AT the boundary and accepts one minute past it — the run is over at exactly that instant", async () => {
		// 10:00 → 22:00 is 720 minutes; a 720-minute runtime ends exactly there.
		const at = await postAt(
			planWithAutoShutdown({ streamTimeoutMinutes: 720 }),
			LITERAL_SLOT,
		);
		expect(at.status).toBe(422);
		// The WHOLE sentence, not a substring: the route checks the program end
		// AND every derived row, and the STOP row sits exactly at the program
		// end — so `toContain("streamTimeoutMinutes=720")` passes on either
		// message and cannot tell an inclusive/exclusive flip in the program-end
		// comparison from a working one (measured: that flip survived the
		// substring form while the core table killed it).
		expect(at.body.error).toBe(
			"streamTimeoutMinutes=720 ends the run by 2026-09-01T22:00:00.000Z; the program end at 2026-09-01T22:00:00.000Z is after that",
		);

		const past = await postAt(
			planWithAutoShutdown({ streamTimeoutMinutes: 721 }),
			LITERAL_SLOT,
		);
		expect(past.status).toBe(201);
	});

	it("accepts the slot when nothing HARD bounds it — the conditional knobs ride the 201 as warnings", async () => {
		const { status, body } = await postAt(
			planWithAutoShutdown({
				bytesReadTimeoutSeconds: 3600,
				waitingForFirstConnectTimeoutMinutes: 10,
			}),
			{
				...LITERAL_SLOT,
				slate: {
					source: { credentialId: CRED, bucket: "in", key: "slate.mp4" },
				},
			},
		);
		expect(status).toBe(201);
		const issues = body.issues as { code: string; path: string }[];
		expect(
			issues
				.filter((i) => i.code === "LIVE_AUTO_SHUTDOWN_CONDITIONAL")
				.map((i) => i.path)
				.sort(),
		).toEqual([
			"start.autoShutdown.bytesReadTimeoutSeconds",
			"start.autoShutdown.waitingForFirstConnectTimeoutMinutes",
		]);
		expect(scheduleCreateMany).toHaveBeenCalledTimes(1);
	});

	it("a short streamTimeoutMinutes with NO schedule is still accepted — there is nothing to cross-check", async () => {
		const { status } = await postAt(
			planWithAutoShutdown({ streamTimeoutMinutes: 6 }),
		);
		expect(status).toBe(201);
	});
});

/**
 * EV-01: the verification harness's idempotency
 * key. A channel bills from creation, so a create response lost
 * after the server created it is a billing channel nobody's memory names —
 * the same key must answer with the channel already created, never a twin.
 */
describe("POST /api/live-channels — the verification key (EV-01)", () => {
	const KEY = "verify:2026-08-31T00-00-00-000-abc123:live-zixi:LIVE_CHANNEL";
	const DISPATCH = {
		verificationRunId: "00000000-0000-4000-8000-000000000011",
		runGeneration: 0,
		intentId: "00000000-0000-4000-8000-000000000012",
		intentGeneration: 1,
		token: "verify-dispatch:run:123:22222222-2222-4222-8222-222222222222",
	};
	const SHA = verificationRequestSha256({
		plan: withAccount(),
		verificationKey: KEY,
	});
	const existingRow = (sha: string | null) => ({
		id: "00000000-0000-4000-8000-00000000ee22",
		name: "UC-live-zixi [verify 2026-08-31T00-00-00-000-abc123]",
		status: "RUNNING",
		programStartAt: null,
		programEndAt: null,
		maxRunMinutes: null,
		verificationRequestSha256: sha,
	});
	const dispatchAuthority = (recovered = false) => {
		queryRaw.mockImplementation(async (strings: unknown) => {
			const sql = Array.from(strings as readonly string[]).join("?");
			if (sql.includes('FROM "VerificationRun"')) {
				return [
					{
						id: DISPATCH.verificationRunId,
						status: recovered ? "INCOMPLETE" : "RUNNING",
						recoveryGeneration: recovered ? 1 : DISPATCH.runGeneration,
						recoveryOwner: null,
					},
				];
			}
			if (sql.includes('FROM "VerificationResourceIntent"')) {
				return [
					{
						id: DISPATCH.intentId,
						verificationRunId: DISPATCH.verificationRunId,
						kind: "LIVE_CHANNEL",
						verificationKey: KEY,
						requestSha256: SHA,
						state: recovered ? "TERMINAL" : "SUBMITTED",
						cleanupState: recovered ? "NEVER_CREATED" : "PENDING",
						recoveryOwner: recovered ? null : DISPATCH.token,
						recoveryGeneration: recovered ? 2 : DISPATCH.intentGeneration,
					},
				];
			}
			return [];
		});
	};

	it("stamps the key and its request SHA in the SAME insert as the row", async () => {
		dispatchAuthority();
		const res = await POST(
			postRequest({
				plan: withAccount(),
				verificationKey: KEY,
				requestSha256: SHA,
				verificationDispatch: DISPATCH,
			}),
		);
		expect(res.status).toBe(201);
		expect(findUnique).toHaveBeenCalledWith(
			expect.objectContaining({ where: { verificationKey: KEY } }),
		);
		const data = create.mock.calls[0]?.[0]?.data as Record<string, unknown>;
		expect(data.verificationKey).toBe(KEY);
		expect(data.verificationRequestSha256).toBe(SHA);
		expect(queueAdd).toHaveBeenCalledTimes(1);
	});

	it("preserves STOPPED when recovery wins after the fenced create and the delayed enqueue rejects", async () => {
		let status = "CREATED";
		update.mockImplementationOnce(async ({ data }) => {
			status = data.status;
			return { id: CHANNEL_ID, status };
		});
		updateMany.mockImplementationOnce(async ({ where, data }) => {
			if (status !== where.status) return { count: 0 };
			status = data.status;
			return { count: 1 };
		});
		queueAdd.mockImplementationOnce(async () => {
			status = "STOPPED";
			throw new Error("redis response lost after recovery stopped the row");
		});
		dispatchAuthority();

		const res = await POST(
			postRequest({
				plan: withAccount(),
				verificationKey: KEY,
				requestSha256: SHA,
				verificationDispatch: DISPATCH,
			}),
		);

		expect(res.status).toBe(500);
		expect(status).toBe("STOPPED");
		expect(updateMany).toHaveBeenCalledWith({
			where: { id: CHANNEL_ID, status: "CREATED" },
			data: {
				status: "ERROR",
				error: "Enqueue failed — start the channel again",
			},
		});
	});

	it("refuses a stale channel producer after recovery changed authority — no channel and no provisioning enqueue", async () => {
		dispatchAuthority(true);
		const res = await POST(
			postRequest({
				plan: withAccount(),
				verificationKey: KEY,
				requestSha256: SHA,
				verificationDispatch: DISPATCH,
			}),
		);
		expect(res.status).toBe(409);
		const response = await res.json();
		expect(response).toMatchObject({
			details: { code: "VERIFICATION_DISPATCH_FENCE_REJECTED" },
		});
		expect(JSON.stringify(response)).not.toContain(DISPATCH.token);
		expect(create).not.toHaveBeenCalled();
		expect(queueAdd).not.toHaveBeenCalled();
	});

	it("requires a dispatch fence only when a new verification-key channel would be created", async () => {
		const res = await POST(
			postRequest({
				plan: withAccount(),
				verificationKey: KEY,
				requestSha256: SHA,
			}),
		);
		expect(res.status).toBe(409);
		expect(await res.json()).toMatchObject({
			details: { code: "VERIFICATION_DISPATCH_FENCE_REQUIRED" },
		});
		expect(create).not.toHaveBeenCalled();
		expect(queueAdd).not.toHaveBeenCalled();
	});

	it("rejects a stale client SHA before lookup/create — the server recomputes the canonical request", async () => {
		const res = await POST(
			postRequest({
				plan: { ...withAccount(), name: "changed-after-hash" },
				verificationKey: KEY,
				requestSha256: SHA,
			}),
		);
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({
			details: { code: "VERIFICATION_REQUEST_SHA_MISMATCH" },
		});
		expect(findUnique).not.toHaveBeenCalled();
		expect(create).not.toHaveBeenCalled();
		expect(queueAdd).not.toHaveBeenCalled();
	});

	it("an ordinary create carries neither column and never looks a key up", async () => {
		const res = await POST(postRequest({ plan: withAccount() }));
		expect(res.status).toBe(201);
		expect(findUnique).not.toHaveBeenCalled();
		const data = create.mock.calls[0]?.[0]?.data as Record<string, unknown>;
		expect(data).not.toHaveProperty("verificationKey");
	});

	it("a repeat with the same key and SHA answers the EXISTING channel with its schedule — 200, replayed, no create, no enqueue", async () => {
		findUnique.mockResolvedValueOnce(existingRow(SHA));
		const res = await POST(
			postRequest({
				plan: withAccount(),
				verificationKey: KEY,
				requestSha256: SHA,
			}),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.id).toBe("00000000-0000-4000-8000-00000000ee22");
		expect(body.replayed).toBe(true);
		expect(body.schedules).toEqual([]);
		expect(body).not.toHaveProperty("verificationRequestSha256");
		expect(create).not.toHaveBeenCalled();
		expect(queueAdd).not.toHaveBeenCalled();
	});

	it("a repeat with the same key and a DIFFERENT SHA is 409 and creates nothing", async () => {
		findUnique.mockResolvedValueOnce(existingRow("d".repeat(64)));
		const res = await POST(
			postRequest({
				plan: withAccount(),
				verificationKey: KEY,
				requestSha256: SHA,
			}),
		);
		expect(res.status).toBe(409);
		expect(await res.json()).toMatchObject({
			details: {
				code: "VERIFICATION_KEY_SHA_CONFLICT",
				verificationKey: KEY,
			},
		});
		expect(create).not.toHaveBeenCalled();
		expect(queueAdd).not.toHaveBeenCalled();
	});

	it("refuses a key without its SHA — 400, nothing created, nothing looked up", async () => {
		const res = await POST(
			postRequest({ plan: withAccount(), verificationKey: KEY }),
		);
		expect(res.status).toBe(400);
		expect(create).not.toHaveBeenCalled();
		expect(findUnique).not.toHaveBeenCalled();
	});

	it("a send that LOSES the unique-insert race re-reads the winner and replays it", async () => {
		findUnique
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce(existingRow(SHA));
		create.mockRejectedValueOnce(
			Object.assign(new Error("Unique constraint failed"), {
				code: "P2002",
				meta: { target: ["verificationKey"] },
			}),
		);
		dispatchAuthority();
		const res = await POST(
			postRequest({
				plan: withAccount(),
				verificationKey: KEY,
				requestSha256: SHA,
				verificationDispatch: DISPATCH,
			}),
		);
		expect(res.status).toBe(200);
		expect((await res.json()).replayed).toBe(true);
		expect(queueAdd).not.toHaveBeenCalled();
	});
});
