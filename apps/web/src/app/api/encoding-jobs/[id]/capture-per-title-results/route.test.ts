import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const findUnique = vi.fn();
/**
 * `vi.hoisted`, because `vi.mock`'s factory is hoisted above the const it would
 * otherwise close over — and `@bitovp/db` is imported by the route at module
 * load, so the factory runs before any plain top-level assignment. Without this
 * the file reports "no tests", which reads like success.
 */
const mergeSnapshot = vi.hoisted(() => vi.fn());
const getAccount = vi.fn();
const revealApiKey = vi.fn();
const streamsList = vi.fn();
const muxingsList = vi.fn();
const typeGet = vi.fn();
const h264Get = vi.fn();

vi.mock("@/lib/server/context", () => ({
	getServerContext: () => ({
		prisma: { encodingJob: { findUnique } },
		bitmovinAccounts: { get: getAccount, revealApiKey },
	}),
}));

vi.mock("@bitovp/db", () => ({ mergeEncodingJobSnapshot: mergeSnapshot }));

vi.mock("@bitmovin/api-sdk", () => ({
	default: class MockBitmovinApi {
		encoding = {
			encodings: {
				streams: { list: streamsList },
				muxings: { list: muxingsList },
			},
			configurations: {
				type: { get: typeGet },
				video: { h264: { get: h264Get } },
			},
		};
	},
}));

import { POST } from "./route";

const JOB_ID = "00000000-0000-4000-8000-0000000000aa";
const ACCOUNT_ID = "00000000-0000-4000-8000-00000000000a";
const ENCODING_ID = "bm-enc-1";

/** A real per-title plan — the route parses it, so a synthetic stub would not do. */
const PER_TITLE_PLAN = JSON.parse(
	readFileSync(
		join(
			__dirname,
			"../../../../../../../../packages/core/src/plan/__fixtures__/pertitle-h264-openapi.plan.json",
		),
		"utf8",
	),
);
const FIXED_PLAN = JSON.parse(
	readFileSync(
		join(
			__dirname,
			"../../../../../../../../packages/core/src/plan/__fixtures__/fixed-bitrate-hls-on-aws.plan.json",
		),
		"utf8",
	),
);

function ctx(id: string) {
	return { params: Promise.resolve({ id }) };
}
function postRequest(): Request {
	return new Request(
		`http://test/api/encoding-jobs/${JOB_ID}/capture-per-title-results`,
		{ method: "POST" },
	);
}
function jobRow(over: Record<string, unknown> = {}) {
	return {
		status: "FINISHED",
		bitmovinEncodingId: ENCODING_ID,
		bitmovinAccountId: ACCOUNT_ID,
		plan: PER_TITLE_PLAN,
		...over,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	getAccount.mockResolvedValue({ id: ACCOUNT_ID, tenantOrgId: null });
	revealApiKey.mockResolvedValue("bm-api-key");
	findUnique.mockResolvedValue(jobRow());
	mergeSnapshot.mockResolvedValue(1);
	streamsList.mockResolvedValue({
		items: [
			{ id: "s-tpl", mode: "PER_TITLE_TEMPLATE" },
			{
				id: "s-res",
				mode: "PER_TITLE_RESULT",
				codecConfigId: "cfg-1",
				appliedSettings: { width: 1920, height: 1080 },
			},
		],
	});
	muxingsList.mockResolvedValue({
		items: [
			{
				id: "m-1",
				type: "FMP4",
				streams: [{ streamId: "s-res" }],
				avgBitrate: 4_200_000,
				segmentsMuxed: 120,
			},
		],
	});
	typeGet.mockResolvedValue({ type: "H264" });
	h264Get.mockResolvedValue({ bitrate: 4_200_000 });
});

describe("POST /api/encoding-jobs/[id]/capture-per-title-results", () => {
	it("400s a non-uuid id before touching the DB", async () => {
		const res = await POST(postRequest(), ctx("nope"));
		expect(res.status).toBe(400);
		expect(findUnique).not.toHaveBeenCalled();
	});

	it.each([
		"QUEUED",
		"RUNNING",
	])("409s an in-flight job (%s)", async (status) => {
		// The results do not exist yet, and `snapshots` on an active row belongs to
		// the orchestrator — this route must never be its second writer.
		findUnique.mockResolvedValue(jobRow({ status }));
		const res = await POST(postRequest(), ctx(JOB_ID));
		expect(res.status).toBe(409);
		expect(mergeSnapshot).not.toHaveBeenCalled();
		expect(streamsList).not.toHaveBeenCalled();
	});

	it("409s a job that does not use per-title at all", async () => {
		findUnique.mockResolvedValue(jobRow({ plan: FIXED_PLAN }));
		const res = await POST(postRequest(), ctx(JOB_ID));
		expect(res.status).toBe(409);
		expect(await res.json()).toMatchObject({
			error: expect.stringContaining("per-title"),
		});
		expect(streamsList).not.toHaveBeenCalled();
	});

	it("captures, attributes and stores the snapshot", async () => {
		const res = await POST(postRequest(), ctx(JOB_ID));
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.snapshot.streams).toHaveLength(1);
		expect(body.snapshot.streams[0].streamId).toBe("s-res");
		expect(body.snapshot.streams[0].muxings[0].segmentsMuxed).toBe(120);
		// `pertitle-h264-openapi` has SEVEN H264 templates, so the sole-candidate
		// rule cannot resolve this and must abstain — which is the honest answer,
		// and the reason `scan.unattributed` exists.
		expect(body.snapshot.streams[0].templateRendition).toBeUndefined();
		expect(body.snapshot.scan.unattributed).toBe(1);
		const written = mergeSnapshot.mock.calls[0]?.[2];
		expect(written.perTitleResults.streams[0].streamId).toBe("s-res");
	});

	it("writes through the atomic merge, handing it a one-key PATCH", async () => {
		// `snapshots` is a SHARED column, so the route must not read-modify-write it:
		// the read would be taken before a network round-trip to Bitmovin, and a
		// stale copy would drop another writer's key. The helper does `jsonb ||`, so
		// what the route hands it has to be a patch — one key, never a whole column.
		await POST(postRequest(), ctx(JOB_ID));
		expect(mergeSnapshot).toHaveBeenCalledTimes(1);
		const [prismaArg, jobId, patch] = mergeSnapshot.mock.calls[0] ?? [];
		expect(prismaArg).toBeDefined();
		expect(jobId).toBe(JOB_ID);
		expect(Object.keys(patch)).toEqual(["perTitleResults"]);
	});

	it("404s when the job was deleted while Bitmovin was being read", async () => {
		// 0 rows updated. Reporting 200 would claim a snapshot stored nowhere.
		mergeSnapshot.mockResolvedValue(0);
		const res = await POST(postRequest(), ctx(JOB_ID));
		expect(res.status).toBe(404);
	});

	it("hands the snapshot to the helper unserialised, and the helper owns that", async () => {
		// The `undefined`-dropping guarantee MOVED into `mergeEncodingJobSnapshot`
		// when the write became a jsonb merge — see its test in packages/db. What is
		// this route's job is passing the snapshot through untouched; asserting the
		// serialisation here as well would be asserting a mock.
		class SparseH264Config {
			bitrate = 4_200_000;
			profile: string | undefined = undefined;
		}
		h264Get.mockResolvedValue(new SparseH264Config());
		await POST(postRequest(), ctx(JOB_ID));
		const patch = mergeSnapshot.mock.calls[0]?.[2];
		expect(patch.perTitleResults.streams[0].params.bitrate).toBe(4_200_000);
	});

	it("surfaces a purged encoding as the upstream error and writes nothing", async () => {
		// Bitmovin purges encodings after ~90 days (C7). "Gone" is a normal outcome
		// here, and it must not overwrite a snapshot we already hold, nor render as
		// an empty ladder.
		// `httpStatusCode`, not `status`: `bitmovinProxyError` reads the former, so the
		// old fixture took the non-HTTP branch and returned a 500 while the test's own
		// name promised a passed-through 404 — and `>= 400` could not tell them apart
		// (review finding). Every other Bitmovin route test in the tree uses
		// `httpStatusCode`.
		streamsList.mockRejectedValue(
			Object.assign(new Error("Encoding not found"), { httpStatusCode: 404 }),
		);
		const res = await POST(postRequest(), ctx(JOB_ID));
		expect(res.status).toBe(404);
		expect(mergeSnapshot).not.toHaveBeenCalled();
	});

	it("is idempotent — two captures converge on the same stored data", async () => {
		await POST(postRequest(), ctx(JOB_ID));
		const first = mergeSnapshot.mock.calls[0]?.[2]?.perTitleResults;
		mergeSnapshot.mockClear();
		await POST(postRequest(), ctx(JOB_ID));
		const second = mergeSnapshot.mock.calls[0]?.[2]?.perTitleResults;
		// `capturedAt` is the clock, so compare everything else.
		expect({ ...second, capturedAt: first.capturedAt }).toEqual(first);
	});

	it("paginates the streams list (C6) and never asks for more than 100", async () => {
		streamsList.mockImplementation(
			async (_id: string, q: { offset: number; limit: number }) =>
				q.offset === 0
					? {
							items: Array.from({ length: 100 }, (_, i) => ({
								id: `s-${i}`,
								mode: "STANDARD",
							})),
						}
					: { items: [{ id: "s-res", mode: "PER_TITLE_RESULT" }] },
		);
		await POST(postRequest(), ctx(JOB_ID));
		expect(streamsList).toHaveBeenCalledTimes(2);
		for (const [, query] of streamsList.mock.calls) {
			expect(query.limit).toBeLessThanOrEqual(100);
		}
		const written = mergeSnapshot.mock.calls[0]?.[2];
		expect(written.perTitleResults.scan.streamsListed).toBe(101);
		expect(written.perTitleResults.scan.complete).toBe(true);
	});
});
