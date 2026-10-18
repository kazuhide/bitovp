import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const findUnique = vi.fn();
const update = vi.fn();
const credentialFindMany = vi.fn();
const channelDeleteMany = vi.fn();
const vmafDeleteMany = vi.fn();
const vmafFindFirst = vi.fn();
const vmafCount = vi.fn();
const auditCreate = vi.fn();
const heartbeatEvents = vi.fn().mockResolvedValue([]);

// Interactive $transaction: invoke the callback with a tx exposing the model
// methods the route uses. `vmafJob.count` is the in-transaction race re-assert
// the delete grew — the same three-part guard the VOD path has, because a live
// capture keeps scoring for minutes after the channel stops and this path used
// to destroy a PENDING report mid-write while DELETE /api/vmaf-jobs/{id}
// answered 409 for the same row.
const tx = {
	vmafJob: { deleteMany: vmafDeleteMany, count: vmafCount },
	liveChannel: { deleteMany: channelDeleteMany },
};
const $transaction = vi.fn((cb: (t: typeof tx) => Promise<unknown>) => cb(tx));

vi.mock("@/lib/server/context", () => ({
	getServerContext: () => ({
		prisma: {
			webhookRegistration: { findFirst: vi.fn().mockResolvedValue(null) },
			webhookEvent: { findMany: heartbeatEvents },
			appSetting: { findUnique: vi.fn().mockResolvedValue(null) },
			liveChannel: { findUnique, update, deleteMany: channelDeleteMany },
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

import { DELETE, GET, PATCH } from "./route";

const CHANNEL_ID = "00000000-0000-4000-8000-0000000000c0";

function ctx(id: string) {
	return { params: Promise.resolve({ id }) };
}
function delReq() {
	return new Request(`http://test/api/live-channels/${CHANNEL_ID}`, {
		method: "DELETE",
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	// Ordering is cosmetic here, and my earlier comment claiming otherwise was
	// wrong: `vi.clearAllMocks` calls `mockClear`, which resets calls but KEEPS
	// implementations, and this project sets no `clearMocks`/`mockReset` in its
	// vitest config. So these defaults were always `null`/`0`, exactly as their
	// names say — I verified it rather than reasoning about it. The guard went
	// unexercised for the plain reason that no test ever OVERRODE the passive
	// defaults, which is what the cases below fix (review catch).
	vmafFindFirst.mockResolvedValue(null);
	vmafCount.mockResolvedValue(0);
	vmafDeleteMany.mockResolvedValue({ count: 0 });
	// Guarded parent delete affects 1 row by default (terminal row present).
	channelDeleteMany.mockResolvedValue({ count: 1 });
	auditCreate.mockResolvedValue({});
	credentialFindMany.mockResolvedValue([]);
});

describe("GET /api/live-channels/[id]", () => {
	it("adds run-bound Push reception without rewriting the poll observation", async () => {
		const encodingId = "525a5c3b-7116-448e-ad00-4830a509b709";
		const run = {
			id: "run-push",
			seq: 1,
			bitmovinEncodingId: encodingId,
			createdAt: new Date("2026-09-07T07:00:00Z"),
			lastHeartbeat: {
				at: "poll-time",
				raw: { ingest: { status: "WAITING_FOR_FIRST_CONNECT" } },
			},
		};
		findUnique.mockResolvedValueOnce({
			id: CHANNEL_ID,
			status: "RUNNING",
			plan: {},
			runs: [run],
		});
		heartbeatEvents.mockResolvedValueOnce([
			{
				receivedAt: new Date("2026-09-07T07:04:00Z"),
				raw: {
					eventType: "LIVE_ENCODING_HEARTBEAT",
					webhookId: "0a704021-a067-12b7-81a0-7aa96ede7789",
					encoding: { id: encodingId },
					value: {
						timestamp: "2026-09-07T07:03:59Z",
						ingest: { status: "CONNECTED" },
					},
				},
			},
		]);
		const response = await GET(new Request("http://test"), ctx(CHANNEL_ID));
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body.currentRun.lastHeartbeat).toEqual(run.lastHeartbeat);
		expect(body.heartbeatReception).toMatchObject({
			state: "available",
			runId: "run-push",
			latest: {
				sampledAt: "2026-09-07T07:03:59Z",
				raw: { ingest: { status: "CONNECTED" } },
			},
		});
	});

	it("400s a non-uuid id", async () => {
		const res = await GET(
			new Request("http://test/api/live-channels/nope"),
			ctx("nope"),
		);
		expect(res.status).toBe(400);
		expect(findUnique).not.toHaveBeenCalled();
	});

	it("404s a missing channel", async () => {
		findUnique.mockResolvedValueOnce(null);
		const res = await GET(
			new Request(`http://test/api/live-channels/${CHANNEL_ID}`),
			ctx(CHANNEL_ID),
		);
		expect(res.status).toBe(404);
		expect(credentialFindMany).not.toHaveBeenCalled();
	});

	it("the CURRENT run rides the detail response — newest by seq, null for a never-run channel (ledger #108 PR2)", async () => {
		const run = {
			id: "run-2",
			seq: 2,
			status: "RUNNING",
			encoderIp: "203.0.113.9",
			streamKey: "sk-live",
			lastHeartbeatAt: new Date("2026-08-17T04:00:00.000Z"),
		};
		findUnique.mockResolvedValueOnce({
			id: CHANNEL_ID,
			name: "ch",
			status: "RUNNING",
			plan: { planVersion: 1 },
			runs: [run],
		});
		let res = await GET(new Request("http://test"), ctx(CHANNEL_ID));
		let json = (await res.json()) as Record<string, unknown>;
		expect((json.currentRun as Record<string, unknown>).seq).toBe(2);
		// The include is pinned too: newest FIRST, exactly one.
		const args = findUnique.mock.calls[0]?.[0] as {
			include: { runs: { orderBy: unknown; take: number } };
		};
		expect(args.include.runs.orderBy).toEqual({ seq: "desc" });
		expect(args.include.runs.take).toBe(1);

		findUnique.mockResolvedValueOnce({
			id: CHANNEL_ID,
			name: "never-ran",
			status: "CREATED",
			plan: { planVersion: 1 },
			runs: [],
		});
		res = await GET(new Request("http://test"), ctx(CHANNEL_ID));
		json = (await res.json()) as Record<string, unknown>;
		expect(json.currentRun).toBeNull();
	});

	it("reports which live-to-VOD families the recording can carry, with the reason only for ADMIN (row #323)", async () => {
		// The CHANNEL column is judged — the same log the POST route reads —
		// so the run row deliberately carries a different (empty) log here.
		const run = { id: "run-3", seq: 3, status: "STOPPED", stepLog: [] };
		const row = {
			id: CHANNEL_ID,
			name: "ch",
			status: "STOPPED",
			plan: { planVersion: 1 },
			stepLog: [
				{
					step: "muxing:v540",
					kind: "CREATE_MUXING_TS",
					payload: { outputPath: "output/ch/video/540p" },
					refs: {},
					status: "DONE",
				},
				{
					step: "muxing:archive",
					kind: "CREATE_MUXING_MP4",
					payload: { outputPath: "output/ch/archive", filename: "rec.mp4" },
					refs: {},
					status: "DONE",
				},
			],
			runs: [run],
		};
		findUnique.mockResolvedValue(row);
		const viewer = (await (
			await GET(new Request("http://test"), ctx(CHANNEL_ID))
		).json()) as { liveToVodFamilies: unknown };
		expect(viewer.liveToVodFamilies).toEqual({
			supported: ["HLS"],
			unsupported: [{ family: "DASH" }],
		});
		const admin = (await (
			await GET(
				new Request("http://test", {
					headers: { "x-bitovp-actor": "session" },
				}),
				ctx(CHANNEL_ID),
			)
		).json()) as {
			liveToVodFamilies: { unsupported: { technicalDetail?: string }[] };
		};
		expect(admin.liveToVodFamilies.unsupported[0]?.technicalDetail).toMatch(
			/2700/,
		);
		// An unreadable log is null, never a guessed "both": the POST says why.
		findUnique.mockResolvedValue({ ...row, stepLog: "not a step log" });
		const broken = (await (
			await GET(new Request("http://test"), ctx(CHANNEL_ID))
		).json()) as { liveToVodFamilies: unknown };
		expect(broken.liveToVodFamilies).toBeNull();
	});

	it("removes provider diagnostics from VIEWER DTOs and exposes them only after the trusted ADMIN role", async () => {
		const raw = {
			status: "ERROR",
			errorCode: "L2V_PROVIDER_STATUS_FAILED",
			technicalDetail: "provider stack /private/path",
			error: "legacy provider English",
			manifests: [],
			families: [
				{
					type: "HLS",
					status: "ERROR",
					errorCode: "L2V_PROVIDER_STATUS_FAILED",
					technicalDetail: "manifest status 403",
				},
			],
		};
		findUnique.mockResolvedValue({
			id: CHANNEL_ID,
			status: "STOPPED",
			plan: null,
			liveToVod: raw,
			runs: [{ id: "run-1", seq: 1, status: "STOPPED", liveToVod: raw }],
		});

		const viewer = await GET(new Request("http://test"), ctx(CHANNEL_ID));
		const viewerBody = await viewer.json();
		expect(viewerBody.technicalDetailsAllowed).toBe(false);
		expect(JSON.stringify(viewerBody)).not.toMatch(
			/provider stack|private\/path|provider English|manifest status 403/,
		);

		const admin = await GET(
			new Request("http://test", {
				headers: { "x-bitovp-actor": "session" },
			}),
			ctx(CHANNEL_ID),
		);
		const adminBody = await admin.json();
		expect(adminBody.technicalDetailsAllowed).toBe(true);
		expect(adminBody.liveToVod.technicalDetail).toBe(
			"provider stack [PATH_REDACTED]",
		);
		expect(adminBody.currentRun.liveToVod.families[0].technicalDetail).toBe(
			"manifest status 403",
		);

		const usersAdmin = await GET(
			new Request("http://test", {
				headers: {
					"x-bitovp-actor": "user:admin-id",
					"x-bitovp-role": "ADMIN",
				},
			}),
			ctx(CHANNEL_ID),
		);
		expect((await usersAdmin.json()).technicalDetailsAllowed).toBe(true);

		for (const actor of ["none", "anonymous", "token:unresolved"]) {
			const denied = await GET(
				new Request("http://test", {
					headers: {
						"x-bitovp-actor": actor,
						"x-bitovp-role": "ADMIN",
					},
				}),
				ctx(CHANNEL_ID),
			);
			const deniedBody = await denied.json();
			expect(deniedBody.technicalDetailsAllowed).toBe(false);
			expect(JSON.stringify(deniedBody)).not.toMatch(/provider stack/);
		}
	});

	it("derives the channel's playback links server-side", async () => {
		/**
		 * The same move as the VOD route . A live
		 * plan's manifests live under `liveManifests` and its destination paths
		 * carry no trailing slash, so this also pins the directory join: the URL
		 * must be `…/output/live-fixture/stream.m3u8`, not `…/live-fixturestream…`.
		 */
		const credentialId = "00000000-0000-4000-8000-000000000002";
		const plan = JSON.parse(
			readFileSync(
				join(
					__dirname,
					"../../../../../../../packages/core/src/live/__fixtures__/live-rtmp-simple.plan.json",
				),
				"utf8",
			),
		);
		findUnique.mockResolvedValueOnce({
			runs: [],
			id: CHANNEL_ID,
			plan,
		});
		credentialFindMany.mockResolvedValueOnce([
			{
				id: credentialId,
				provider: "AWS_S3",
				config: {
					region: "ap-northeast-1",
					// The live wizard has no ACL field yet, so a declared base is the
					// only route to a playable live URL today.
					publicBaseUrls: { "sample-output-bucket": "https://cdn.example.com" },
				},
			},
		]);

		const res = await GET(
			new Request(`http://test/api/live-channels/${CHANNEL_ID}`),
			ctx(CHANNEL_ID),
		);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.playbackLinks).toEqual([
			{
				key: "hls",
				kind: "HLS",
				label: "Live HLS Manifest",
				path: "output/live-rtmp-simple/stream.m3u8",
				url: "https://cdn.example.com/output/live-rtmp-simple/stream.m3u8",
				via: "publicBaseUrls",
			},
			{
				key: "dash",
				kind: "DASH",
				label: "Live DASH Manifest",
				path: "output/live-rtmp-simple/stream.mpd",
				url: "https://cdn.example.com/output/live-rtmp-simple/stream.mpd",
				via: "publicBaseUrls",
			},
		]);
	});

	it("links follow the CURRENT run's subtree — a re-aired run's manifests are not at the plan's paths (ledger #155)", async () => {
		const credentialId = "00000000-0000-4000-8000-000000000002";
		const plan = JSON.parse(
			readFileSync(
				join(
					__dirname,
					"../../../../../../../packages/core/src/live/__fixtures__/live-rtmp-simple.plan.json",
				),
				"utf8",
			),
		);
		findUnique.mockResolvedValueOnce({
			id: CHANNEL_ID,
			plan,
			runs: [
				{
					id: "cafebabe-0000-4000-8000-000000000000",
					seq: 2,
					status: "RUNNING",
					outputPrefix: "output/live-rtmp-simple/runs/2-cafebabe",
				},
			],
		});
		credentialFindMany.mockResolvedValueOnce([
			{
				id: credentialId,
				provider: "AWS_S3",
				config: {
					region: "ap-northeast-1",
					publicBaseUrls: { "sample-output-bucket": "https://cdn.example.com" },
				},
			},
		]);
		const res = await GET(
			new Request(`http://test/api/live-channels/${CHANNEL_ID}`),
			ctx(CHANNEL_ID),
		);
		const body = await res.json();
		expect(
			(body.playbackLinks as { key: string; url: string }[]).map((l) => l.url),
		).toEqual([
			"https://cdn.example.com/output/live-rtmp-simple/runs/2-cafebabe/stream.m3u8",
			"https://cdn.example.com/output/live-rtmp-simple/runs/2-cafebabe/stream.mpd",
		]);
	});

	it("links go EMPTY when the run's stored prefix cannot be re-derived — never guessed paths (ledger #155)", async () => {
		const plan = JSON.parse(
			readFileSync(
				join(
					__dirname,
					"../../../../../../../packages/core/src/live/__fixtures__/live-rtmp-simple.plan.json",
				),
				"utf8",
			),
		);
		findUnique.mockResolvedValueOnce({
			id: CHANNEL_ID,
			plan,
			runs: [
				{
					id: "cafebabe-0000-4000-8000-000000000000",
					seq: 2,
					status: "RUNNING",
					// A prefix no current derivation produces (e.g. an older
					// build's scheme): the route must refuse to guess.
					outputPrefix: "somewhere/else/runs/2-cafebabe",
				},
			],
		});
		const res = await GET(
			new Request(`http://test/api/live-channels/${CHANNEL_ID}`),
			ctx(CHANNEL_ID),
		);
		const body = await res.json();
		expect(body.playbackLinks).toEqual([]);
		expect(credentialFindMany).not.toHaveBeenCalled();
	});
});

describe("DELETE /api/live-channels/[id] — the live VMAF guard", () => {
	/**
	 * A review deleted all three parts of this guard — pre-check, in-tx
	 * re-assert, and the 409 branch — and the entire web suite still passed,
	 * because the harness seeded the mocks to their passive values and no test
	 * ever overrode them. So the previous round added the guard and nothing
	 * entered it.
	 *
	 * A terminal CHANNEL is not a terminal CAPTURE: `POST …/capture-vmaf` keeps
	 * scoring for minutes after the channel stops, and this path used to destroy
	 * that PENDING/RUNNING report mid-write while `DELETE /api/vmaf-jobs/{id}`
	 * answered 409 for the same row.
	 */
	function terminal() {
		findUnique.mockResolvedValue({
			id: CHANNEL_ID,
			status: "STOPPED",
			bitmovinAccountId: null,
		});
	}

	it("409s and deletes NOTHING when a capture is already scoring", async () => {
		terminal();
		vmafFindFirst.mockResolvedValue({ status: "RUNNING" });
		const res = await DELETE(
			new Request(`http://test/api/live-channels/${CHANNEL_ID}`, {
				method: "DELETE",
			}),
			ctx(CHANNEL_ID),
		);
		expect(res.status).toBe(409);
		expect((await res.json()).error).toContain("still RUNNING");
		expect(vmafDeleteMany).not.toHaveBeenCalled();
		expect(channelDeleteMany).not.toHaveBeenCalled();
	});

	it("409s via the SENTINEL when one starts scoring inside the transaction", async () => {
		// The pre-check sees nothing, the in-tx count sees one. Asserting the body
		// proves the sentinel branch was entered rather than routeError's 500.
		terminal();
		vmafFindFirst.mockResolvedValue(null);
		vmafCount.mockResolvedValue(1);
		const res = await DELETE(
			new Request(`http://test/api/live-channels/${CHANNEL_ID}`, {
				method: "DELETE",
			}),
			ctx(CHANNEL_ID),
		);
		expect(res.status).toBe(409);
		expect((await res.json()).error).toContain("started scoring");
		expect(vmafDeleteMany).not.toHaveBeenCalled();
		expect(channelDeleteMany).not.toHaveBeenCalled();
	});

	it("deletes when nothing is scoring, child rows first", async () => {
		terminal();
		const res = await DELETE(
			new Request(`http://test/api/live-channels/${CHANNEL_ID}`, {
				method: "DELETE",
			}),
			ctx(CHANNEL_ID),
		);
		expect(res.status).toBe(200);
		expect(vmafCount).toHaveBeenCalled();
		expect(vmafDeleteMany).toHaveBeenCalled();
		expect(channelDeleteMany).toHaveBeenCalled();
	});
});

describe("DELETE /api/live-channels/[id]", () => {
	it("400s a non-uuid id before touching the DB", async () => {
		const res = await DELETE(delReq(), ctx("nope"));
		expect(res.status).toBe(400);
		expect(findUnique).not.toHaveBeenCalled();
		expect(channelDeleteMany).not.toHaveBeenCalled();
	});

	it("404s a missing channel", async () => {
		findUnique.mockResolvedValueOnce(null);
		const res = await DELETE(delReq(), ctx(CHANNEL_ID));
		expect(res.status).toBe(404);
		expect(channelDeleteMany).not.toHaveBeenCalled();
	});

	it.each([
		"PROVISIONING",
		"RUNNING",
		"STOPPING",
	])("409s a non-terminal channel (%s) without deleting", async (status) => {
		findUnique.mockResolvedValueOnce({
			id: CHANNEL_ID,
			status,
			bitmovinAccountId: null,
		});
		const res = await DELETE(delReq(), ctx(CHANNEL_ID));
		expect(res.status).toBe(409);
		expect($transaction).not.toHaveBeenCalled();
		expect(channelDeleteMany).not.toHaveBeenCalled();
	});

	it.each([
		"CREATED",
		"STOPPED",
		"ERROR",
	])("deletes a terminal channel (%s) and cascades its live VMAF jobs", async (status) => {
		findUnique.mockResolvedValueOnce({
			id: CHANNEL_ID,
			status,
			bitmovinAccountId: null,
		});
		vmafDeleteMany.mockResolvedValueOnce({ count: 1 });
		const res = await DELETE(delReq(), ctx(CHANNEL_ID));
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ id: CHANNEL_ID, deleted: true });
		// LIVE VmafJobs link via params.liveChannelId (JSON path, no FK) — deleted
		// FIRST; the status-guarded channel delete follows; FeederSessions +
		// LiveHeartbeats cascade by FK.
		// Status-FILTERED, never bare: it must match the guard that ran a line
		// earlier, or a PENDING report gets deleted out from under the scorer while
		// DELETE /api/vmaf-jobs/{id} answers 409 for the same row.
		expect(vmafDeleteMany).toHaveBeenCalledWith({
			where: {
				params: { path: ["liveChannelId"], equals: CHANNEL_ID },
				status: { in: ["FINISHED", "ERROR"] },
			},
		});
		expect(channelDeleteMany).toHaveBeenCalledWith({
			where: {
				id: CHANNEL_ID,
				status: { notIn: ["PROVISIONING", "RUNNING", "STOPPING"] },
			},
		});
		expect($transaction).toHaveBeenCalledTimes(1);
	});

	it("rolls back and 409s when the row races out of a terminal state (guarded delete hits 0 rows)", async () => {
		// findUnique sees a terminal row, but between the read and the atomic
		// deleteMany the channel left the terminal set (e.g. /actions claimed
		// CREATED|ERROR→PROVISIONING concurrently): the guard matches 0 rows → the
		// whole tx rolls back, so dependents are NOT left deleted.
		findUnique.mockResolvedValueOnce({
			id: CHANNEL_ID,
			status: "ERROR",
			bitmovinAccountId: null,
		});
		vmafDeleteMany.mockResolvedValueOnce({ count: 1 });
		channelDeleteMany.mockResolvedValueOnce({ count: 0 });
		const res = await DELETE(delReq(), ctx(CHANNEL_ID));
		expect(res.status).toBe(409);
		expect(await res.json()).toMatchObject({
			error: expect.stringMatching(/changed state/i),
		});
		expect(auditCreate).not.toHaveBeenCalled();
	});

	it("writes an audit record with the cascade count", async () => {
		findUnique.mockResolvedValueOnce({
			id: CHANNEL_ID,
			status: "STOPPED",
			bitmovinAccountId: "00000000-0000-4000-8000-00000000000a",
		});
		vmafDeleteMany.mockResolvedValueOnce({ count: 2 });
		await DELETE(delReq(), ctx(CHANNEL_ID));
		const arg = auditCreate.mock.calls[0]?.[0] as {
			data: Record<string, unknown>;
		};
		expect(arg.data).toMatchObject({
			method: "DELETE",
			path: `/api/live-channels/${CHANNEL_ID}`,
			statusCode: 200,
		});
		expect(arg.data.response).toMatchObject({ deletedVmafJobs: 2 });
	});
});

/**
 *  — the runtime cap against the program it backstops.
 * `program-schedule.ts` sets the precedence: "the STOP row is the intended
 * end; `maxRunMinutes` is the backstop". A backstop that lands FIRST is the
 * misconfiguration, and until now the PATCH accepted any 1…10080 without ever
 * looking at the channel's own programEndAt.
 */
describe("PATCH /api/live-channels/[id] — the cap against the program window", () => {
	const CREATED_AT = new Date("2026-09-01T12:00:00.000Z");

	function patchReq(body: unknown) {
		return new Request(`http://test/api/live-channels/${CHANNEL_ID}`, {
			method: "PATCH",
			body: JSON.stringify(body),
		});
	}

	beforeEach(() => {
		update.mockImplementation(
			async ({ data }: { data: { maxRunMinutes: number | null } }) => ({
				id: CHANNEL_ID,
				maxRunMinutes: data.maxRunMinutes,
			}),
		);
	});

	it("refuses a cap that would stop the channel before its program ends", async () => {
		findUnique.mockResolvedValueOnce({
			id: CHANNEL_ID,
			bitmovinAccountId: null,
			programEndAt: new Date("2026-09-01T13:00:00.000Z"),
			runningSince: null,
			createdAt: CREATED_AT,
		});
		const res = await PATCH(patchReq({ maxRunMinutes: 30 }), ctx(CHANNEL_ID));
		expect(res.status).toBe(422);
		expect(await res.json()).toMatchObject({
			error:
				"maxRunMinutes=30 ends the run by 2026-09-01T12:30:00.000Z; the program end at 2026-09-01T13:00:00.000Z is after that",
		});
		expect(update).not.toHaveBeenCalled();
	});

	/**
	 * The boundary, in THIS suite. Core and the create/arm routes each pin the
	 * inclusive/exclusive edge of `programEndBeyondRunWindow`, and a reviewer's
	 * `<` → `<=` flip died in all three — but not here, because every arm above
	 * sits strictly to one side of the bound. A suite that cannot see the edge
	 * of the rule it exercises is a suite that will pass through the day the
	 * edge moves.
	 *
	 * 12:00 + 60 min lands exactly on a 13:00 program end. Refused: at that
	 * instant the sweep is stopping the channel, so the program does not get
	 * its last moment either way.
	 */
	it("refuses a cap whose deadline lands EXACTLY on programEndAt", async () => {
		findUnique.mockResolvedValueOnce({
			id: CHANNEL_ID,
			bitmovinAccountId: null,
			programEndAt: new Date("2026-09-01T13:00:00.000Z"),
			runningSince: null,
			createdAt: CREATED_AT,
		});
		const res = await PATCH(patchReq({ maxRunMinutes: 60 }), ctx(CHANNEL_ID));
		expect(res.status).toBe(422);
		// The WHOLE sentence, like the create route's boundary arm: a substring
		// on the knob name alone cannot tell this message from any other refusal
		// the same knob could produce.
		expect(await res.json()).toEqual({
			error:
				"maxRunMinutes=60 ends the run by 2026-09-01T13:00:00.000Z; the program end at 2026-09-01T13:00:00.000Z is after that",
			details: { code: "LIVE_CHANNEL_RUNTIME_CAP_BEFORE_PROGRAM_END" },
		});
		expect(update).not.toHaveBeenCalled();
	});

	it("accepts a cap one minute past the program end — the other side of that edge", async () => {
		findUnique.mockResolvedValueOnce({
			id: CHANNEL_ID,
			bitmovinAccountId: null,
			programEndAt: new Date("2026-09-01T13:00:00.000Z"),
			runningSince: null,
			createdAt: CREATED_AT,
		});
		const res = await PATCH(patchReq({ maxRunMinutes: 61 }), ctx(CHANNEL_ID));
		expect(res.status).toBe(200);
		expect(update).toHaveBeenCalledWith(
			expect.objectContaining({ data: { maxRunMinutes: 61 } }),
		);
	});

	it("accepts a cap that outlives the program, measured from runningSince", async () => {
		findUnique.mockResolvedValueOnce({
			id: CHANNEL_ID,
			bitmovinAccountId: null,
			programEndAt: new Date("2026-09-01T13:00:00.000Z"),
			// Running from 12:30, so a 40-minute cap reaches 13:10.
			runningSince: new Date("2026-09-01T12:30:00.000Z"),
			createdAt: CREATED_AT,
		});
		const res = await PATCH(patchReq({ maxRunMinutes: 40 }), ctx(CHANNEL_ID));
		expect(res.status).toBe(200);
		expect(update).toHaveBeenCalledWith(
			expect.objectContaining({ data: { maxRunMinutes: 40 } }),
		);
	});

	it("clearing the cap is never refused — null removes the backstop, it cannot cut a program short", async () => {
		findUnique.mockResolvedValueOnce({
			id: CHANNEL_ID,
			bitmovinAccountId: null,
			programEndAt: new Date("2027-01-01T00:00:00.000Z"),
			runningSince: null,
			createdAt: CREATED_AT,
		});
		const res = await PATCH(patchReq({ maxRunMinutes: null }), ctx(CHANNEL_ID));
		expect(res.status).toBe(200);
	});

	it("a channel with no scheduled program accepts any cap", async () => {
		findUnique.mockResolvedValueOnce({
			id: CHANNEL_ID,
			bitmovinAccountId: null,
			programEndAt: null,
			runningSince: null,
			createdAt: CREATED_AT,
		});
		const res = await PATCH(patchReq({ maxRunMinutes: 1 }), ctx(CHANNEL_ID));
		expect(res.status).toBe(200);
	});
});

it("selects the durable cancellation flag for the detail UI", async () => {
	findUnique.mockResolvedValue({
		id: CHANNEL_ID,
		status: "STOPPING",
		liveEffectFenceVersion: 4,
		plan: {},
		stepLog: [],
		runs: [
			{ id: "run-cancel", seq: 1, status: "STOPPING", cancelRequested: true },
		],
	});
	const response = await GET(
		new Request("http://test/api/live-channels/channel-cancel"),
		{ params: Promise.resolve({ id: CHANNEL_ID }) },
	);
	expect(response.status).toBe(200);
	expect((await response.json()).currentRun.cancelRequested).toBe(true);
	expect(
		findUnique.mock.calls[0]?.[0].include.runs.select.cancelRequested,
	).toBe(true);
});
