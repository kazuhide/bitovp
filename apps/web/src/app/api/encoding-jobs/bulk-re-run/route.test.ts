import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const findUnique = vi.fn();
const create = vi.fn();
const update = vi.fn();
const getAccount = vi.fn();
const queueAdd = vi.fn();
const credentialFindMany = vi.fn(
	async () => [] as { id: string; provider: string }[],
);

vi.mock("@/lib/server/context", () => ({
	getServerContext: () => ({
		prisma: {
			encodingJob: { findUnique, create, update },
			credential: { findMany: credentialFindMany },
		},
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
	getOrchestratorQueue: () => ({ add: queueAdd }),
}));

import { POST } from "./route";

const fixturePath = join(
	__dirname,
	"../../../../../../../packages/core/src/plan/__fixtures__/fixed-bitrate-hls-on-aws.plan.json",
);
const basePlan = JSON.parse(readFileSync(fixturePath, "utf8")) as Record<
	string,
	unknown
>;
const ACCOUNT_ID = "00000000-0000-4000-8000-00000000000a";

function planWithAccount(): Record<string, unknown> {
	return {
		...basePlan,
		bitmovin: { ...(basePlan.bitmovin as object), accountId: ACCOUNT_ID },
	};
}

function id(n: number): string {
	return `00000000-0000-4000-8000-0000000000${n.toString().padStart(2, "0")}`;
}

/**
 * `count` distinct SPELLINGS of one uuid. A v4 uuid carries 12–16 hex letters,
 * so treating those positions as bits of a counter yields far more spellings
 * than MAX_BULK_IDS. (Mirrored in lib/bulk-ops.test.ts, which pins the helper
 * itself; kept local here so the route test imports no test module.)
 */
function caseVariants(uuid: string, count: number): string[] {
	const chars = [...uuid];
	const letters = chars.flatMap((c, i) => (/[a-f]/.test(c) ? [i] : []));
	return Array.from({ length: count }, (_, n) => {
		const out = [...chars];
		for (const [bit, at] of letters.entries()) {
			if (n & (1 << bit)) {
				out[at] = (chars[at] as string).toUpperCase();
			}
		}
		return out.join("");
	});
}

/**
 * Each request gets its own rate-limit bucket, so these tests exercise the route's
 * logic and never its rate limit. That works because of the `TRUSTED_PROXY_HOPS`
 * stub below — NOT because "the limiter keys on the first x-forwarded-for hop",
 * which is what this comment used to say and is precisely the bug the block below
 * describes. The limit itself is pinned by its own test, which reuses one key.
 */
let clientSeq = 0;
function postRequest(body: unknown, client?: string): Request {
	return new Request("http://test/api/encoding-jobs/bulk-re-run", {
		method: "POST",
		body: JSON.stringify(body),
		headers: { "x-forwarded-for": client ?? `10.0.0.${++clientSeq}` },
	});
}

let newIdSeq = 0;

beforeEach(() => {
	vi.clearAllMocks();
	vi.stubEnv("MASTER_KEY", Buffer.alloc(32, 7).toString("base64"));
	vi.stubEnv("DEPLOYMENT_PROFILE", "UNRESTRICTED");
	getAccount.mockResolvedValue({ id: ACCOUNT_ID });
	queueAdd.mockResolvedValue({});
	newIdSeq = 0;
	create.mockImplementation(async () => ({ id: `new-${newIdSeq++}` }));
});

afterEach(() => {
	vi.unstubAllEnvs();
});

/**
 * These tests give each caller its own `x-forwarded-for` so one test's limiter
 * state cannot leak into the next. That only works when the app is TOLD how many
 * proxies write the header: `clientKey` returns one shared `"untrusted"` bucket
 * otherwise, because Next fills `x-forwarded-for` from the socket only when it is
 * ABSENT (`??=`), so a client-supplied value wins and keying on it would let any
 * caller mint a fresh bucket per request.
 *
 * The original derivation here took the FIRST hop and was therefore forgeable —
 * found on the login route, where it meant unlimited password guesses, and fixed
 * for every route at once. Declaring the topology is now part of the test, which
 * is the honest version: per-client rate limiting is a deployment property, not
 * something the app can assume.
 */
beforeEach(() => {
	vi.stubEnv("TRUSTED_PROXY_HOPS", "1");
});

describe("POST /api/encoding-jobs/bulk-re-run", () => {
	for (const side of ["inputs", "outputs"] as const) {
		it.each([
			["GENERIC_S3", "GENERIC_S3"],
			["GENERIC_S3", "AKAMAI_OBJECT_STORAGE"],
			["AKAMAI_NETSTORAGE", "AKAMAI_NETSTORAGE"],
		] as const)(`unrestricted saved ${side}: %s / %s`, async (kind, provider) => {
			const candidate = JSON.parse(
				readFileSync(
					fixturePath.replace(
						"fixed-bitrate-hls-on-aws",
						"akamai-netstorage-io",
					),
					"utf8",
				),
			);
			candidate.bitmovin = {
				...candidate.bitmovin,
				accountId: ACCOUNT_ID,
				cloudRegion: "AKAMAI_JP_OSA",
			};
			for (const field of ["inputs", "outputs"] as const) {
				candidate[field][0].kind = kind;
				if (kind === "GENERIC_S3") candidate[field][0].bucket = "media";
			}
			credentialFindMany.mockResolvedValue(
				["inputs", "outputs"].map((field) => ({
					id: candidate[field][0].credentialId,
					provider:
						field === side
							? provider
							: kind === "GENERIC_S3"
								? "AKAMAI_OBJECT_STORAGE"
								: "AKAMAI_NETSTORAGE",
				})),
			);
			findUnique.mockResolvedValue({ id: id(1), plan: candidate });
			const before = await POST(postRequest({ ids: [id(1)] }));
			expect((await before.json()).created).toHaveLength(1);
			vi.clearAllMocks();
			const res = await POST(postRequest({ ids: [id(1)] }));
			expect(res.status).toBe(201); // bulk envelope reports item-level refusals
			const body = await res.json();
			expect(body.created).toHaveLength(1);
			expect(body.failed).toEqual([]);
			expect(credentialFindMany).toHaveBeenCalled();
			expect(create).toHaveBeenCalledOnce();
			expect(queueAdd).toHaveBeenCalledOnce();
			expect(update).not.toHaveBeenCalled();
		});
	}

	it("rejects an empty id list", async () => {
		const res = await POST(postRequest({ ids: [] }));
		expect(res.status).toBe(400);
		expect(create).not.toHaveBeenCalled();
	});

	it("rejects more than 50 ids", async () => {
		const ids = Array.from({ length: 51 }, (_, i) => id(i % 90));
		const res = await POST(postRequest({ ids }));
		expect(res.status).toBe(400);
	});

	it("rejects non-uuid ids", async () => {
		const res = await POST(postRequest({ ids: ["nope"] }));
		expect(res.status).toBe(400);
	});

	it("re-runs every valid id and isolates partial failures", async () => {
		const ok1 = id(1);
		const bad = id(2);
		const ok2 = id(3);
		findUnique.mockImplementation(
			async ({ where }: { where: { id: string } }) => {
				if (where.id === ok1 || where.id === ok2) {
					return { id: where.id, plan: planWithAccount() };
				}
				if (where.id === bad) {
					return null; // missing → reported in failed, doesn't abort
				}
				return null;
			},
		);
		const res = await POST(postRequest({ ids: [ok1, bad, ok2] }));
		expect(res.status).toBe(201);
		const body = (await res.json()) as {
			created: { sourceId: string; newId: string }[];
			failed: { sourceId: string; error: string }[];
		};
		expect(body.created.map((c) => c.sourceId)).toEqual([ok1, ok2]);
		expect(body.failed).toEqual([{ sourceId: bad, error: "Not found" }]);
		// Two new jobs created + enqueued (the bad id created nothing).
		expect(create).toHaveBeenCalledTimes(2);
		expect(queueAdd).toHaveBeenCalledTimes(2);
	});

	it("keeps unexpected details server-side while continuing the batch", async () => {
		const bad = id(1);
		const good = id(2);
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});
		findUnique.mockImplementation(
			async ({ where }: { where: { id: string } }) => {
				if (where.id === bad)
					throw new Error("Database failed at secret-db.internal:5432");
				return { id: good, plan: planWithAccount() };
			},
		);
		try {
			const res = await POST(postRequest({ ids: [bad, good] }));
			expect(res.status).toBe(201);
			const body = await res.json();
			expect(body.created).toHaveLength(1);
			expect(body.created[0].sourceId).toBe(good);
			expect(body.failed).toEqual([{ sourceId: bad, error: "Re-run failed" }]);
			expect(JSON.stringify(body)).not.toContain("secret-db.internal");
			expect(logged).toHaveBeenCalledWith(
				expect.stringContaining(bad),
				expect.stringContaining("secret-db.internal:5432"),
			);
		} finally {
			logged.mockRestore();
		}
	});

	it("isolates an invalid-plan source without aborting the batch", async () => {
		const ok = id(1);
		const broken = id(2);
		findUnique.mockImplementation(
			async ({ where }: { where: { id: string } }) =>
				where.id === ok
					? { id: ok, plan: planWithAccount() }
					: { id: broken, plan: { planVersion: 1 } },
		);
		const res = await POST(postRequest({ ids: [broken, ok] }));
		const body = (await res.json()) as {
			created: { sourceId: string }[];
			failed: { sourceId: string }[];
		};
		expect(body.created.map((c) => c.sourceId)).toEqual([ok]);
		expect(body.failed.map((f) => f.sourceId)).toEqual([broken]);
	});

	it("deduplicates repeated ids so each source re-runs once", async () => {
		const dup = id(1);
		findUnique.mockResolvedValue({ id: dup, plan: planWithAccount() });
		const res = await POST(postRequest({ ids: [dup, dup, dup] }));
		expect(res.status).toBe(201);
		const body = (await res.json()) as { created: unknown[] };
		expect(body.created).toHaveLength(1);
		expect(create).toHaveBeenCalledTimes(1);
	});

	it("deduplicates CASE-VARIANT spellings of one id — 50 variants, 1 encoding", async () => {
		// z.uuid is case-insensitive and Postgres @db.Uuid normalizes case, so
		// every spelling below addresses the SAME row. A case-sensitive Set would
		// pass all 50 through and bill 50 real Bitmovin encodings for one source.
		const base = "a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c4d5";
		const ids = caseVariants(base, 50);
		expect(ids).toHaveLength(50);
		// Sanity: they really are distinct STRINGS (what the old Set saw).
		expect(new Set(ids).size).toBe(50);

		findUnique.mockResolvedValue({ id: base, plan: planWithAccount() });
		const res = await POST(postRequest({ ids }));
		expect(res.status).toBe(201);
		const body = (await res.json()) as { created: unknown[] };
		expect(body.created).toHaveLength(1);
		expect(create).toHaveBeenCalledTimes(1);
		expect(queueAdd).toHaveBeenCalledTimes(1);
	});

	it("rate-limits a re-run loop from one client", async () => {
		const target = id(1);
		findUnique.mockResolvedValue({ id: target, plan: planWithAccount() });
		const CLIENT = "203.0.113.9";
		// The documented budget is 5/min; the 6th request from the same client
		// must be refused BEFORE any encoding is created.
		for (let i = 0; i < 5; i += 1) {
			const ok = await POST(postRequest({ ids: [target] }, CLIENT));
			expect(ok.status).toBe(201);
		}
		const limited = await POST(postRequest({ ids: [target] }, CLIENT));
		expect(limited.status).toBe(429);
		expect(create).toHaveBeenCalledTimes(5);
	});
});
