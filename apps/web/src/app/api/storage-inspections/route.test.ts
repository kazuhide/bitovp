import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const credentialGet = vi.fn();
const inspectionCreate = vi.fn();
const inspectionUpdate = vi.fn();
const inspectionFindFirst = vi.fn();
const inspectionFindMany = vi.fn();
const queueAdd = vi.fn();

vi.mock("@/lib/server/context", () => ({
	getServerContext: () => ({
		prisma: {
			storageInspection: {
				create: inspectionCreate,
				update: inspectionUpdate,
				findFirst: inspectionFindFirst,
				findMany: inspectionFindMany,
			},
		},
		credentials: { get: credentialGet },
	}),
}));

vi.mock("@/lib/server/queue", () => ({
	getStorageInspectQueue: () => ({ add: queueAdd }),
}));

import { GET, POST } from "./route";

const CREDENTIAL_ID = "00000000-0000-4000-8000-0000000000c1";
const INSPECTION_ID = "00000000-0000-4000-8000-0000000000f1";
const BODY = {
	credentialId: CREDENTIAL_ID,
	bucket: "my-bucket",
	objectKey: "videos/raw/bbb.mp4",
};

const ROW = {
	id: INSPECTION_ID,
	status: "PENDING",
	bucket: BODY.bucket,
	objectKey: BODY.objectKey,
	probe: null,
	bytesRead: null,
	error: null,
	createdAt: new Date("2026-08-06T00:00:00Z"),
	updatedAt: new Date("2026-08-06T00:00:00Z"),
};

/** Own rate-limit bucket per request — see the bulk-re-run test for why. */
let clientSeq = 0;
function post(body: unknown = BODY, client?: string) {
	return POST(
		new Request("http://test/api/storage-inspections", {
			method: "POST",
			body: JSON.stringify(body),
			headers: { "x-forwarded-for": client ?? `10.0.0.${++clientSeq}` },
		}),
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.stubEnv("MASTER_KEY", Buffer.alloc(32, 7).toString("base64"));
	credentialGet.mockResolvedValue({ id: CREDENTIAL_ID, provider: "AWS_S3" });
	inspectionCreate.mockResolvedValue(ROW);
	inspectionFindFirst.mockResolvedValue(null);
	queueAdd.mockResolvedValue(undefined);
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

describe("objectSize (ledger #26)", () => {
	it("rides the POST into the row as a BigInt", async () => {
		const res = await post({ ...BODY, objectSize: 524288000 });
		expect(res.status).toBe(201);
		expect(inspectionCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ objectSize: BigInt(524288000) }),
			}),
		);
	});

	it("stays optional — the job-detail cards do not know it", async () => {
		const res = await post();
		expect(res.status).toBe(201);
		expect(inspectionCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ objectSize: null }),
			}),
		);
	});

	it("rejects a negative or fractional size", async () => {
		expect((await post({ ...BODY, objectSize: -1 })).status).toBe(400);
		expect((await post({ ...BODY, objectSize: 1.5 })).status).toBe(400);
	});
});

describe("POST /api/storage-inspections", () => {
	it("creates a PENDING row and enqueues it with jobId = row id", async () => {
		const res = await post();
		expect(res.status).toBe(201);
		expect(await res.json()).toEqual({
			id: INSPECTION_ID,
			status: "PENDING",
			bucket: BODY.bucket,
			objectKey: BODY.objectKey,
			probe: null,
			bytesRead: null,
			error: null,
			createdAt: "2026-08-06T00:00:00.000Z",
			updatedAt: "2026-08-06T00:00:00.000Z",
		});
		expect(inspectionCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				data: {
					credentialId: CREDENTIAL_ID,
					bucket: BODY.bucket,
					objectKey: BODY.objectKey,
					status: "PENDING",
					objectSize: null,
				},
			}),
		);
		// jobId = row id so a redelivered job dedupes at the queue; the payload is
		// exactly core's storageInspectJobSchema.
		expect(queueAdd).toHaveBeenCalledWith(
			"storage-inspect",
			{ storageInspectionId: INSPECTION_ID },
			expect.objectContaining({ jobId: INSPECTION_ID }),
		);
	});

	it("never reads storage or reveals the secret — only a row write + enqueue", async () => {
		await post();
		// The existence check goes through the ciphertext-free summary getter.
		expect(credentialGet).toHaveBeenCalledWith(CREDENTIAL_ID);
		const payload = queueAdd.mock.calls[0]?.[1] as Record<string, unknown>;
		expect(Object.keys(payload)).toEqual(["storageInspectionId"]);
	});

	it("404s an unknown credential without creating a row", async () => {
		credentialGet.mockResolvedValueOnce(null);
		const res = await post();
		expect(res.status).toBe(404);
		expect(inspectionCreate).not.toHaveBeenCalled();
		expect(queueAdd).not.toHaveBeenCalled();
	});

	it("503s on a broken MASTER_KEY before touching the DB (the worker must decrypt)", async () => {
		vi.stubEnv("MASTER_KEY", "not-base64-32-bytes");
		const res = await post();
		expect(res.status).toBe(503);
		expect(credentialGet).not.toHaveBeenCalled();
		expect(inspectionCreate).not.toHaveBeenCalled();
	});

	it("marks the row ERROR with a re-try hint and 500s when the enqueue fails", async () => {
		queueAdd.mockRejectedValueOnce(new Error("redis down"));
		const res = await post();
		expect(res.status).toBe(500);
		expect(inspectionUpdate).toHaveBeenCalledWith({
			where: { id: INSPECTION_ID },
			data: { status: "ERROR", error: "Enqueue failed — inspect again" },
		});
	});

	describe("zod rejection", () => {
		const cases: [string, unknown][] = [
			["a non-uuid credentialId", { ...BODY, credentialId: "nope" }],
			["a missing bucket", { credentialId: CREDENTIAL_ID, objectKey: "a.mp4" }],
			["an empty objectKey", { ...BODY, objectKey: "" }],
			["an over-long objectKey", { ...BODY, objectKey: "x".repeat(1025) }],
			["an over-long bucket", { ...BODY, bucket: "b".repeat(256) }],
			// A trailing slash is a prefix, not an object — nothing to probe.
			["a prefix instead of an object", { ...BODY, objectKey: "videos/raw/" }],
			["an unknown extra field", { ...BODY, download: true }],
			["a non-object body", "nope"],
		];
		for (const [name, body] of cases) {
			it(`400s ${name}`, async () => {
				const res = await post(body);
				expect(res.status).toBe(400);
				expect(inspectionCreate).not.toHaveBeenCalled();
				expect(queueAdd).not.toHaveBeenCalled();
			});
		}
	});
});

describe("GET /api/storage-inspections (latest for one object)", () => {
	function get(query: Record<string, string>) {
		const params = new URLSearchParams(query);
		return GET(new Request(`http://test/api/storage-inspections?${params}`));
	}

	it("returns the newest inspection of that exact object", async () => {
		inspectionFindFirst.mockResolvedValueOnce({
			...ROW,
			status: "FINISHED",
			probe: { format: { format_name: "mov,mp4" }, streams: [] },
			bytesRead: 8_388_608,
		});
		const res = await get(BODY);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.latest).toMatchObject({
			id: INSPECTION_ID,
			status: "FINISHED",
			bytesRead: 8_388_608,
		});
		const arg = inspectionFindFirst.mock.calls[0]?.[0] as {
			where: Record<string, string>;
			orderBy: unknown;
		};
		// Scoped to the full triple — never just the key.
		expect(arg.where).toEqual({
			credentialId: CREDENTIAL_ID,
			bucket: BODY.bucket,
			objectKey: BODY.objectKey,
		});
		expect(arg.orderBy).toEqual([{ createdAt: "desc" }, { id: "desc" }]);
	});

	it("returns latest: null when the object was never inspected", async () => {
		const res = await get(BODY);
		expect(await res.json()).toEqual({ latest: null });
	});

	it("400s a missing/invalid query without touching the DB", async () => {
		expect((await get({ bucket: "b", objectKey: "k" })).status).toBe(400);
		expect((await get({ ...BODY, credentialId: "not-a-uuid" })).status).toBe(
			400,
		);
		expect(inspectionFindFirst).not.toHaveBeenCalled();
	});

	it("rate-limits an inspect loop from one client", async () => {
		const CLIENT = "203.0.113.12";
		// Each accepted POST is a bounded read billed to the CUSTOMER's bucket
		// plus an ffprobe spawn; the 21st in a window must be refused before a
		// row is written or a job enqueued.
		for (let i = 0; i < 20; i += 1) {
			const ok = await post(BODY, CLIENT);
			expect(ok.status).toBe(201);
		}
		const createCalls = inspectionCreate.mock.calls.length;
		const limited = await post(BODY, CLIENT);
		expect(limited.status).toBe(429);
		expect(inspectionCreate.mock.calls.length).toBe(createCalls);
	});
});

describe("history=1 (ledger #25)", () => {
	it("returns the object's prior inspections, lean and bounded", async () => {
		inspectionFindFirst.mockResolvedValue(ROW);
		inspectionFindMany.mockResolvedValue([
			{
				id: ROW.id,
				status: "FINISHED",
				createdAt: new Date("2026-08-14T10:00:00Z"),
				bytesRead: 1024n,
			},
			{
				id: "00000000-0000-4000-8000-00000000000b",
				status: "ERROR",
				createdAt: new Date("2026-08-13T09:00:00Z"),
				bytesRead: null,
			},
		]);
		const res = await GET(
			new Request(
				`http://test/api/storage-inspections?credentialId=${CREDENTIAL_ID}&bucket=b&objectKey=k&history=1`,
			),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			history?: { id: string; bytesRead: number | null }[];
		};
		expect(body.history).toHaveLength(2);
		expect(body.history?.[0]?.bytesRead).toBe(1024);
		expect(inspectionFindMany).toHaveBeenCalledWith(
			expect.objectContaining({ take: 20 }),
		);
	});

	it("without the param the shape is unchanged (no history key)", async () => {
		inspectionFindFirst.mockResolvedValue(null);
		const res = await GET(
			new Request(
				`http://test/api/storage-inspections?credentialId=${CREDENTIAL_ID}&bucket=b&objectKey=k`,
			),
		);
		const body = (await res.json()) as Record<string, unknown>;
		expect("history" in body).toBe(false);
	});
});
