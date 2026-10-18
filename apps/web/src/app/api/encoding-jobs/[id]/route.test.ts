import { beforeEach, describe, expect, it, vi } from "vitest";

const findUnique = vi.fn();
const jobUpdate = vi.fn();
const mergeSnapshot = vi.fn();
const clientFor = vi.fn();
const credentialFindMany = vi.fn();

vi.mock("@/lib/server/bitmovin", () => ({
	bitmovinClientForAccount: (...args: unknown[]) => clientFor(...args),
}));
vi.mock("@bitovp/db", async (orig) => ({
	...(await orig<Record<string, unknown>>()),
	mergeEncodingJobSnapshot: (...args: unknown[]) => mergeSnapshot(...args),
}));
const jobDeleteMany = vi.fn();
const vmafDeleteMany = vi.fn();
const vmafFindFirst = vi.fn();
const vmafCount = vi.fn();
const auditCreate = vi.fn();
const lockJob = vi.fn();
const snapshotJobs = vi.fn();
const findCapturedSource = vi.fn();

// Interactive $transaction: invoke the callback with a tx exposing the same
// model methods the route uses (vmafJob.count/deleteMany, encodingJob.deleteMany).
const tx = {
	$queryRaw: lockJob,
	librarySource: { findUnique: findCapturedSource },
	vmafJob: { deleteMany: vmafDeleteMany, count: vmafCount },
	encodingJob: { deleteMany: jobDeleteMany, findMany: snapshotJobs },
};
const $transaction = vi.fn((cb: (t: typeof tx) => Promise<unknown>) => cb(tx));

vi.mock("@/lib/server/context", () => ({
	getServerContext: () => ({
		prisma: {
			encodingJob: { findUnique, deleteMany: jobDeleteMany, update: jobUpdate },
			credential: { findMany: credentialFindMany },
			vmafJob: {
				deleteMany: vmafDeleteMany,
				findFirst: vmafFindFirst,
				count: vmafCount,
			},
			auditLog: { create: auditCreate },
			$transaction,
		},
	}),
}));

import { DELETE, GET } from "./route";

const JOB_ID = "00000000-0000-4000-8000-0000000000aa";

function ctx(id: string) {
	return { params: Promise.resolve({ id }) };
}
function delReq() {
	return new Request(`http://test/api/encoding-jobs/${JOB_ID}`, {
		method: "DELETE",
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	lockJob.mockResolvedValue([]);
	snapshotJobs.mockResolvedValue([]);
	findCapturedSource.mockResolvedValue(null);
	vmafDeleteMany.mockResolvedValue({ count: 0 });
	// The guarded parent delete affects 1 row by default (terminal row present).
	jobDeleteMany.mockResolvedValue({ count: 1 });
	// Default: no VMAF report is mid-scoring, so nothing blocks the delete.
	vmafFindFirst.mockResolvedValue(null);
	vmafCount.mockResolvedValue(0);
	auditCreate.mockResolvedValue({});
	credentialFindMany.mockResolvedValue([]);
	jobUpdate.mockResolvedValue({});
	mergeSnapshot.mockResolvedValue(1);
	clientFor.mockResolvedValue(null);
});

/** A row whose enrichment arms are the subject . */
function timesRow(over: Record<string, unknown> = {}) {
	return {
		id: JOB_ID,
		status: "FINISHED",
		plan: {},
		snapshots: null,
		bitmovinEncodingId: "enc-1",
		bitmovinAccountId: "00000000-0000-4000-8000-0000000000bb",
		...over,
	};
}

describe("GET /api/encoding-jobs/[id]", () => {
	it("400s a non-uuid id before touching the DB", async () => {
		const res = await GET(
			new Request("http://test/api/encoding-jobs/nope"),
			ctx("nope"),
		);
		expect(res.status).toBe(400);
		expect(findUnique).not.toHaveBeenCalled();
	});

	it("404s a missing job", async () => {
		findUnique.mockResolvedValueOnce(null);
		const res = await GET(
			new Request(`http://test/api/encoding-jobs/${JOB_ID}`),
			ctx(JOB_ID),
		);
		expect(res.status).toBe(404);
		// Deriving links for a row that does not exist would be a wasted query
		// against a null plan.
		expect(credentialFindMany).not.toHaveBeenCalled();
	});

	it("derives the playback links server-side and returns them with the row", async () => {
		/**
		 * The client used to compute these, which meant fetching every credential
		 * and shipping its config to the browser .
		 */
		const credentialId = "00000000-0000-4000-8000-000000000002";
		findUnique.mockResolvedValueOnce({
			id: JOB_ID,
			status: "FINISHED",
			plan: {
				planVersion: 1,
				name: "j",
				bitmovin: { cloudRegion: "AWS_AP_NORTHEAST_1" },
				generation: { timing: "JUST_IN_TIME" },
				inputs: [
					{ key: "main", kind: "S3", name: "in", bucket: "b", credentialId },
				],
				outputs: [
					{ key: "origin", kind: "S3", name: "out", bucket: "o", credentialId },
				],
				ingest: [
					{
						key: "video",
						inputKey: "main",
						inputPath: "a.mp4",
						position: 0,
						selectionMode: "VIDEO_RELATIVE",
					},
				],
				renditions: [
					{
						key: "v",
						codec: "H264",
						ingestKey: "video",
						height: 360,
						bitrate: 300000,
					},
				],
				muxings: [
					{
						key: "v",
						kind: "FMP4",
						streamKey: "v",
						segmentLength: 4,
						destination: { outputKey: "origin", path: "out/v/" },
					},
				],
				manifests: [
					{
						key: "hls",
						kind: "HLS",
						name: "HLS",
						manifestName: "stream.m3u8",
						destination: {
							outputKey: "origin",
							path: "out/",
							acl: "PUBLIC_READ",
						},
					},
				],
				// `storageSummaries` iterates these unconditionally, so omitting them
				// made it THROW and `credentialRefsForPlan` return `{}` from its catch —
				// my "wiring" assertion was checking the fallback path, and a route that
				// hardcoded `credentialRefs: {}` would have passed it (review finding).
				drm: [],
				thumbnails: [],
				sprites: [],
			},
		});
		credentialFindMany.mockResolvedValue([
			{
				id: credentialId,
				label: "eu-account",
				provider: "AWS_S3",
				config: { region: "eu-west-1" },
				// ON the row, so the no-secret assertion below can actually fail: without
				// it the string could never appear however leaky the implementation, which
				// made that assertion vacuous independently of the path problem above.
				encryptedSecret: "SHOULD-NEVER-APPEAR",
			},
		]);

		const res = await GET(
			new Request(`http://test/api/encoding-jobs/${JOB_ID}`),
			ctx(JOB_ID),
		);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.playbackLinks).toEqual([
			{
				key: "hls",
				kind: "HLS",
				label: "HLS",
				path: "out/stream.m3u8",
				url: "https://o.s3.eu-west-1.amazonaws.com/out/stream.m3u8",
				via: "derived",
			},
		]);
		// The route's OTHER derived field, now on its HAPPY path: the plan above
		// carries every collection `storageSummaries` touches, so the derivation
		// actually runs and this asserts CONTENTS rather than shape.
		expect(body.credentialRefs).toEqual({
			[credentialId]: { label: "eu-account", provider: "AWS_S3" },
		});
		// Load-bearing now: the mocked row carries `encryptedSecret`, so a route that
		// spread the credential row would fail here. It could not before — the row had
		// no such key and the data path never ran.
		expect(JSON.stringify(body)).not.toContain("SHOULD-NEVER-APPEAR");
		expect(JSON.stringify(body)).not.toContain("encryptedSecret");
	});
});

describe("GET …/[id] — encoder-startup enrichment (ledger #166)", () => {
	it("burned stamps short-circuit: no Bitmovin call, the snapshot answers", async () => {
		findUnique.mockResolvedValueOnce(
			timesRow({
				snapshots: {
					encodingTimes: {
						queuedAt: "2026-08-24T00:00:00.000Z",
						runningAt: "2026-08-24T00:09:32.000Z",
					},
				},
			}),
		);
		const res = await GET(
			new Request(`http://test/api/encoding-jobs/${JOB_ID}`),
			ctx(JOB_ID),
		);
		const body = (await res.json()) as {
			encodingTimes?: { queuedAt?: string; runningAt?: string };
		};
		expect(body.encodingTimes?.runningAt).toBe("2026-08-24T00:09:32.000Z");
		expect(clientFor).not.toHaveBeenCalled();
		expect(mergeSnapshot).not.toHaveBeenCalled();
	});

	it("first sight BURNS queuedAt→runningAt into snapshots (C7: Bitmovin purges, the number must not)", async () => {
		findUnique.mockResolvedValueOnce(timesRow());
		clientFor.mockResolvedValueOnce({
			encoding: {
				encodings: {
					get: vi.fn().mockResolvedValue({
						queuedAt: new Date("2026-08-24T00:00:00Z"),
						runningAt: new Date("2026-08-24T00:09:32Z"),
						finishedAt: new Date("2026-08-24T00:19:00Z"),
					}),
				},
			},
		});
		const res = await GET(
			new Request(`http://test/api/encoding-jobs/${JOB_ID}`),
			ctx(JOB_ID),
		);
		const body = (await res.json()) as {
			encodingTimes?: { queuedAt?: string; runningAt?: string };
		};
		expect(body.encodingTimes).toEqual({
			queuedAt: "2026-08-24T00:00:00.000Z",
			runningAt: "2026-08-24T00:09:32.000Z",
			finishedAt: "2026-08-24T00:19:00.000Z",
		});
		// The burn rides mergeEncodingJobSnapshot (jsonb || merge, terminal-
		// only, no @updatedAt bump) — a plain update would re-commit the
		// three traps its docstring records, so update must stay UNCALLED.
		expect(mergeSnapshot).toHaveBeenCalledTimes(1);
		const [, mergeId, patch] = mergeSnapshot.mock.calls[0] as [
			unknown,
			string,
			Record<string, unknown>,
		];
		expect(mergeId).toBe(JOB_ID);
		expect(patch).toEqual({
			encodingTimes: {
				queuedAt: "2026-08-24T00:00:00.000Z",
				runningAt: "2026-08-24T00:09:32.000Z",
				finishedAt: "2026-08-24T00:19:00.000Z",
			},
		});
		expect(jobUpdate).not.toHaveBeenCalled();
	});

	it("an ACTIVE row (QUEUED/RUNNING) never reaches Bitmovin — the 5s detail poll must not become ~120 gets (review-295 S1)", async () => {
		findUnique.mockResolvedValueOnce(timesRow({ status: "RUNNING" }));
		const res = await GET(
			new Request(`http://test/api/encoding-jobs/${JOB_ID}`),
			ctx(JOB_ID),
		);
		expect(res.status).toBe(200);
		expect(clientFor).not.toHaveBeenCalled();
		expect(mergeSnapshot).not.toHaveBeenCalled();
	});

	it("a merge that applies 0 rows is ignored: the GET still carries the number (review-295 N3)", async () => {
		// The terminal-only predicate (a delete racing the window, or a
		// Retry flipping the row back to QUEUED mid-window) makes the merge
		// a no-op — the response must not care, and nothing must pretend
		// the burn landed. (This test's original second half — "the next
		// read re-asks" with call counts — was VACUOUS: the stub never
		// modeled persistence, so the counts measured the stub, not the
		// route; flipping the merge to 1 left everything green. review-295
		// N7, whose own round-2 probe carried the same hole in verbatim.
		// The discriminating half now lives in the next test.)
		findUnique.mockResolvedValue(timesRow());
		mergeSnapshot.mockResolvedValue(0);
		const encGet = vi.fn().mockResolvedValue({
			queuedAt: new Date("2026-08-24T00:00:00Z"),
			runningAt: new Date("2026-08-24T00:09:32Z"),
		});
		clientFor.mockResolvedValue({
			encoding: { encodings: { get: encGet } },
		});
		const first = await GET(
			new Request(`http://test/api/encoding-jobs/${JOB_ID}`),
			ctx(JOB_ID),
		);
		expect(first.status).toBe(200);
		const firstBody = (await first.json()) as {
			encodingTimes?: { runningAt?: string };
		};
		expect(firstBody.encodingTimes?.runningAt).toBe("2026-08-24T00:09:32.000Z");
	});

	it("a burn that APPLIED short-circuits the next read — the pair discriminates stub from route (review-295 N7)", async () => {
		// The stub models persistence this time: the second findUnique is
		// CONFIGURED to return the burned row — the route never inspects the
		// merge's return value (review-297b N1: the two mocks are
		// independent; mergeSnapshot's 1 below is scenery here and the
		// 0-arm is where that return is load-bearing). One Bitmovin call
		// total — a route that stopped trusting burned stamps would make
		// two and fail here, which is exactly what the vacuous version
		// could not detect.
		const fresh = {
			queuedAt: "2026-08-24T00:00:00.000Z",
			runningAt: "2026-08-24T00:09:32.000Z",
		};
		findUnique
			.mockResolvedValueOnce(timesRow())
			.mockResolvedValueOnce(timesRow({ snapshots: { encodingTimes: fresh } }));
		mergeSnapshot.mockResolvedValue(1);
		const encGet = vi.fn().mockResolvedValue({
			queuedAt: new Date("2026-08-24T00:00:00Z"),
			runningAt: new Date("2026-08-24T00:09:32Z"),
		});
		clientFor.mockResolvedValue({
			encoding: { encodings: { get: encGet } },
		});
		const first = await GET(
			new Request(`http://test/api/encoding-jobs/${JOB_ID}`),
			ctx(JOB_ID),
		);
		expect(first.status).toBe(200);
		const second = await GET(
			new Request(`http://test/api/encoding-jobs/${JOB_ID}`),
			ctx(JOB_ID),
		);
		expect(second.status).toBe(200);
		const secondBody = (await second.json()) as {
			encodingTimes?: { runningAt?: string };
		};
		expect(secondBody.encodingTimes?.runningAt).toBe(
			"2026-08-24T00:09:32.000Z",
		);
		expect(encGet).toHaveBeenCalledTimes(1);
		expect(mergeSnapshot).toHaveBeenCalledTimes(1);
	});

	it("a terminal row whose encoding never reached RUNNING (queuedAt only) returns it without burning", async () => {
		findUnique.mockResolvedValueOnce(timesRow({ status: "ERROR" }));
		clientFor.mockResolvedValueOnce({
			encoding: {
				encodings: {
					get: vi.fn().mockResolvedValue({
						queuedAt: new Date("2026-08-24T00:00:00Z"),
					}),
				},
			},
		});
		const res = await GET(
			new Request(`http://test/api/encoding-jobs/${JOB_ID}`),
			ctx(JOB_ID),
		);
		const body = (await res.json()) as {
			encodingTimes?: { queuedAt?: string; runningAt?: string };
		};
		expect(body.encodingTimes?.queuedAt).toBe("2026-08-24T00:00:00.000Z");
		expect(body.encodingTimes?.runningAt).toBeUndefined();
		expect(mergeSnapshot).not.toHaveBeenCalled();
	});

	it("purged/unreachable → the GET still 200s with the number simply absent", async () => {
		findUnique.mockResolvedValueOnce(timesRow());
		clientFor.mockResolvedValueOnce({
			encoding: {
				encodings: {
					get: vi.fn().mockRejectedValue(new Error("410 gone")),
				},
			},
		});
		const res = await GET(
			new Request(`http://test/api/encoding-jobs/${JOB_ID}`),
			ctx(JOB_ID),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { encodingTimes?: unknown };
		expect(body.encodingTimes).toBeUndefined();
		expect(mergeSnapshot).not.toHaveBeenCalled();
	});

	it("a DRAFT row (no encoding id) never reaches Bitmovin", async () => {
		findUnique.mockResolvedValueOnce(
			timesRow({ bitmovinEncodingId: null, status: "DRAFT" }),
		);
		const res = await GET(
			new Request(`http://test/api/encoding-jobs/${JOB_ID}`),
			ctx(JOB_ID),
		);
		expect(res.status).toBe(200);
		expect(clientFor).not.toHaveBeenCalled();
	});
});

describe("DELETE /api/encoding-jobs/[id]", () => {
	it("requires durable capture before deleting completed AISA history", async () => {
		const job = timesRow({ plan: { aiSceneAnalysis: {} } });
		findUnique.mockResolvedValue(job);
		snapshotJobs.mockResolvedValue([job]);
		const refused = await DELETE(delReq(), ctx(JOB_ID));
		expect(refused.status).toBe(409);
		expect((await refused.json()).error).toMatch(/Capture AI Scene Analysis/);
		expect(jobDeleteMany).not.toHaveBeenCalled();
		expect(vmafDeleteMany).not.toHaveBeenCalled();
		expect(clientFor).not.toHaveBeenCalled();
		findCapturedSource.mockResolvedValue({ id: "source-1" });
		expect((await DELETE(delReq(), ctx(JOB_ID))).status).toBe(200);
		expect(jobDeleteMany).toHaveBeenCalledTimes(1);
		expect(lockJob).toHaveBeenCalledTimes(2);
	});
	it("400s a non-uuid id before touching the DB", async () => {
		const res = await DELETE(delReq(), ctx("nope"));
		expect(res.status).toBe(400);
		expect(findUnique).not.toHaveBeenCalled();
		expect(jobDeleteMany).not.toHaveBeenCalled();
	});

	it("404s a missing job", async () => {
		findUnique.mockResolvedValueOnce(null);
		const res = await DELETE(delReq(), ctx(JOB_ID));
		expect(res.status).toBe(404);
		expect(jobDeleteMany).not.toHaveBeenCalled();
	});

	it.each([
		"QUEUED",
		"RUNNING",
	])("409s an active job (%s) without deleting", async (status) => {
		findUnique.mockResolvedValueOnce({
			id: JOB_ID,
			status,
			bitmovinAccountId: null,
		});
		const res = await DELETE(delReq(), ctx(JOB_ID));
		expect(res.status).toBe(409);
		expect($transaction).not.toHaveBeenCalled();
		expect(jobDeleteMany).not.toHaveBeenCalled();
	});

	it.each([
		"PENDING",
		"RUNNING",
	])("409s a terminal job whose VMAF report is still %s, deleting nothing", async (vmafStatus) => {
		// The encoding job only has to be TERMINAL, so a VMAF run triggered on
		// a just-finished encode makes this the happy path. The old cascade ran
		// an unguarded vmafJob.deleteMany and destroyed the in-flight report —
		// the very row deleteVmafJobLocally refuses to delete directly.
		findUnique.mockResolvedValueOnce({
			id: JOB_ID,
			status: "FINISHED",
			bitmovinAccountId: null,
		});
		vmafFindFirst.mockResolvedValueOnce({ status: vmafStatus });
		const res = await DELETE(delReq(), ctx(JOB_ID));
		expect(res.status).toBe(409);
		expect(await res.json()).toMatchObject({
			error: `A VMAF report for this job is still ${vmafStatus} — wait for it to finish before deleting`,
		});
		expect($transaction).not.toHaveBeenCalled();
		expect(vmafDeleteMany).not.toHaveBeenCalled();
		expect(jobDeleteMany).not.toHaveBeenCalled();
	});

	it.each([
		"DRAFT",
		"FINISHED",
		"ERROR",
		"CANCELED",
	])("deletes a terminal job (%s) and cascades its VMAF jobs", async (status) => {
		findUnique.mockResolvedValueOnce({
			id: JOB_ID,
			status,
			bitmovinAccountId: null,
		});
		vmafDeleteMany.mockResolvedValueOnce({ count: 2 });
		const res = await DELETE(delReq(), ctx(JOB_ID));
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ id: JOB_ID, deleted: true });
		// Dependents (VmafJobs; FK is SetNull, not Cascade) deleted FIRST, then the
		// status-guarded parent delete — both inside one interactive transaction.
		// Only TERMINAL reports go: one still being scored blocks the delete
		// instead of being destroyed mid-run (matches deleteVmafJobLocally).
		expect(vmafDeleteMany).toHaveBeenCalledWith({
			where: {
				encodingJobId: JOB_ID,
				status: { in: ["FINISHED", "ERROR"] },
			},
		});
		expect(jobDeleteMany).toHaveBeenCalledWith({
			where: { id: JOB_ID, status: { notIn: ["QUEUED", "RUNNING"] } },
		});
		expect($transaction).toHaveBeenCalledTimes(1);
	});

	it("rolls back and 409s when the row races out of a terminal state (guarded delete hits 0 rows)", async () => {
		// findUnique still sees a terminal row, but between the read and the atomic
		// deleteMany the row left the terminal set (e.g. /retry claimed ERROR→QUEUED
		// concurrently): the guard matches 0 rows → the whole tx rolls back.
		findUnique.mockResolvedValueOnce({
			id: JOB_ID,
			status: "ERROR",
			bitmovinAccountId: null,
		});
		vmafDeleteMany.mockResolvedValueOnce({ count: 1 });
		jobDeleteMany.mockResolvedValueOnce({ count: 0 });
		const res = await DELETE(delReq(), ctx(JOB_ID));
		expect(res.status).toBe(409);
		expect(await res.json()).toMatchObject({
			error: expect.stringMatching(/changed state/i),
		});
		// The dependents' deleteMany was issued inside the tx, but the rollback
		// (thrown sentinel) undoes it — and no audit row is written for a 409.
		expect(auditCreate).not.toHaveBeenCalled();
	});

	it("writes an audit record (best-effort) with the cascade count", async () => {
		findUnique.mockResolvedValueOnce({
			id: JOB_ID,
			status: "FINISHED",
			bitmovinAccountId: "00000000-0000-4000-8000-00000000000a",
		});
		vmafDeleteMany.mockResolvedValueOnce({ count: 3 });
		await DELETE(delReq(), ctx(JOB_ID));
		expect(auditCreate).toHaveBeenCalledTimes(1);
		const arg = auditCreate.mock.calls[0]?.[0] as {
			data: Record<string, unknown>;
		};
		expect(arg.data).toMatchObject({
			method: "DELETE",
			path: `/api/encoding-jobs/${JOB_ID}`,
			statusCode: 200,
			bitmovinAccountId: "00000000-0000-4000-8000-00000000000a",
		});
		expect(arg.data.response).toMatchObject({ deletedVmafJobs: 3 });
	});
});
