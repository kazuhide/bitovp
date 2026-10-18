import { beforeEach, expect, it, vi } from "vitest";
import { evaluateRole } from "@/lib/auth/roles";

const runFind = vi.fn();
const eventFind = vi.fn();
vi.mock("@/lib/server/context", () => ({
	getServerContext: () => ({
		prisma: {
			liveChannelRun: { findFirst: runFind },
			webhookEvent: { findMany: eventFind },
		},
	}),
}));

import { GET } from "./route";

const channel = "00000000-0000-4000-8000-000000000001";
const runId = "00000000-0000-4000-8000-000000000002";
const encoding = "00000000-0000-4000-8000-000000000003";
const hook = "00000000-0000-4000-8000-000000000004";
const time = Date.parse("2026-09-07T00:00:00Z");
const path = `/api/live-channels/${channel}/runs/${runId}/heartbeat-receipts`;
const get = (query = "") =>
	GET(new Request(`http://test${path}${query}`), {
		params: Promise.resolve({ id: channel, runId }),
	});
function row(i: number) {
	return {
		id: `00000000-0000-4000-8000-${String(i + 10).padStart(12, "0")}`,
		receivedAt: new Date(time + Math.floor(i / 2) * 2000),
		raw: {
			eventType: "LIVE_ENCODING_HEARTBEAT",
			webhookId: hook,
			encoding: { id: encoding },
			value: {
				timestamp: new Date(time + Math.floor(i / 2) * 2000).toISOString(),
				ingest: {
					status: "CONNECTED",
					healthy: true,
					streams: [{ mediaType: "VIDEO", rate: 30, incomingBitrate: 500000 }],
				},
			},
		},
	};
}
beforeEach(() => {
	vi.clearAllMocks();
	runFind.mockResolvedValue({
		id: runId,
		status: "RUNNING",
		bitmovinEncodingId: encoding,
		createdAt: new Date(time),
	});
	eventFind.mockResolvedValue([]);
});
it("has OPERATOR GET/HEAD floor, not the generic VIEWER read floor", () => {
	for (const method of ["GET", "HEAD"]) {
		expect(evaluateRole("VIEWER", path, method).allowed).toBe(false);
		expect(evaluateRole("OPERATOR", path, method).allowed).toBe(true);
	}
});
it("checks channel/run identity and signed source/type/encoding binding in the query", async () => {
	await get();
	expect(runFind).toHaveBeenCalledWith(
		expect.objectContaining({ where: { id: runId, liveChannelId: channel } }),
	);
	expect(eventFind).toHaveBeenCalledWith(
		expect.objectContaining({
			where: expect.objectContaining({
				source: "bitmovin",
				eventType: "LIVE_ENCODING_HEARTBEAT",
				signatureValid: true,
				liveChannelRunId: runId,
				raw: { path: ["encoding", "id"], equals: encoding },
			}),
			take: 101,
			orderBy: [{ receivedAt: "desc" }, { id: "desc" }],
		}),
	);
	runFind.mockResolvedValue(null);
	eventFind.mockClear();
	expect((await get()).status).toBe(404);
	expect(eventFind).not.toHaveBeenCalled();
});
it("walks 113 distinct receipts across same-time ties without dedup or new-arrival drift", async () => {
	const rows = Array.from({ length: 113 }, (_, i) => row(i));
	eventFind.mockImplementation(async ({ where, take }) =>
		rows
			.filter(
				(r) =>
					!where.OR ||
					r.receivedAt < where.OR[0].receivedAt.lt ||
					(+r.receivedAt === +where.OR[1].receivedAt &&
						r.id < where.OR[1].id.lt),
			)
			.sort((a, b) => +b.receivedAt - +a.receivedAt || b.id.localeCompare(a.id))
			.slice(0, take),
	);
	const first = await (await get()).json();
	expect(first.rows).toHaveLength(100);
	rows.push(row(200));
	const second = await (
		await get(`?cursor=${encodeURIComponent(first.nextCursor)}`)
	).json();
	expect(second.rows).toHaveLength(13);
	expect(second.nextCursor).toBeUndefined();
	expect(new Set([...first.rows, ...second.rows].map((r) => r.id)).size).toBe(
		113,
	);
	expect(first.rows[1].sampledAt).toBe(first.rows[2].sampledAt);
});
it("allows only known numeric/enum/time values, never secrets even under recognized keys", async () => {
	const receipt = row(1);
	const value = {
		...receipt.raw.value,
		secret: "SECRET_CANARY",
		ingest: {
			status: "https://SECRET_CANARY",
			healthy: true,
			streams: [
				{
					mediaType: "VIDEO",
					rate: 30,
					codec: "SECRET_CANARY",
					incomingBitrate: "SECRET_CANARY",
					url: "SECRET_CANARY",
				},
			],
		},
		output: {
			manifests: {
				hls: [
					{
						manifestUpdateWallClockTime: "2026-09-07T00:00:00Z",
						url: "SECRET_CANARY",
					},
				],
			},
			segments: {
				totalProcessingStatsMs: { mean: 50, secret: "SECRET_CANARY" },
			},
		},
		events: [{ details: { message: "SECRET_CANARY" } }],
	};
	eventFind.mockResolvedValue([{ ...receipt, raw: { ...receipt.raw, value } }]);
	const response = await get();
	const body = await response.json();
	expect(JSON.stringify(body)).not.toContain("SECRET_CANARY");
	expect(body.rows[0].value.ingest.streams[0]).toEqual({
		mediaType: "VIDEO",
		rate: 30,
	});
	expect(body.rows[0].value.output.segments.totalProcessingStatsMs.mean).toBe(
		50,
	);
	expect(body.rows[0].sampledAt).toBe("2026-09-07T00:00:00.000Z");
});
it("never returns mismatched/malformed envelopes even if the store is inconsistent", async () => {
	const r = row(1);
	eventFind.mockResolvedValue([
		r,
		{ ...r, raw: { ...r.raw, encoding: { id: channel } } },
		{ ...r, raw: { ...r.raw, webhookId: "unknown" } },
		{ ...r, raw: { ...r.raw, eventType: "OTHER" } },
	]);
	expect((await (await get()).json()).rows).toHaveLength(1);
});
it("rejects malformed cursor/limit before querying and does not turn a failed read into empty success", async () => {
	for (const query of ["?cursor=nope", "?limit=201", "?limit=0"])
		expect((await get(query)).status).toBe(400);
	expect(runFind).not.toHaveBeenCalled();
	eventFind.mockRejectedValue(new Error("read failed"));
	expect((await get()).status).toBe(500);
});
