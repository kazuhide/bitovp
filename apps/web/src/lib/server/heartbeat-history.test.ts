import { describe, expect, it } from "vitest";
import {
	downsampleHeartbeats,
	HEARTBEAT_POINT_CAP,
	type HeartbeatHistoryPoint,
	projectHeartbeatRow,
	pushHeartbeatPoints,
} from "./heartbeat-history";

/**
 * Audit 4403130 IMPORTANT-2, fourth defect: the reducer kept only each
 * bucket's max-packet-delta point, and the chart derives ingest-status
 * TRANSITIONS from whatever survives — so a short disconnect/reconnect inside
 * a long run could be deleted outright, and the operator's post-mortem showed
 * an unbroken CONNECTED line over a real outage. The usual 120-minute window
 * at the 30 s sweep is ~240 points, under the 500 cap, which is why this
 * needed a LONG run to appear.
 */

const BASE = Date.parse("2026-08-29T00:00:00.000Z");

function point(
	index: number,
	over: Partial<HeartbeatHistoryPoint> = {},
): HeartbeatHistoryPoint {
	return {
		at: new Date(BASE + index * 30_000).toISOString(),
		droppedPacketsVideo: 0,
		droppedPacketsAudio: 0,
		corruptPacketsVideo: 0,
		corruptPacketsAudio: 0,
		ingestStatus: "CONNECTED",
		...over,
	};
}

function series(
	n: number,
	shape: (i: number) => Partial<HeartbeatHistoryPoint> = () => ({}),
): HeartbeatHistoryPoint[] {
	return Array.from({ length: n }, (_, i) => point(i, shape(i)));
}

/**
 * The chart's own derivation, replicated byte-for-byte from the `statusChanges`
 * memo in `apps/web/src/app/live/[id]/heartbeat-history.tsx`: a mark wherever
 * `ingestStatus` differs from the PREVIOUS surviving point, the first point
 * always being one. `healthy` is a pure function of the status word there, so
 * pinning the status sequence pins the colour of every dot too.
 *
 * A replica can drift from the component, so `heartbeat-history.test.tsx`
 * renders the real component over a series reduced by the real function and
 * counts the dots it actually draws — this table is the fine-grained half.
 */
function transitions(
	points: HeartbeatHistoryPoint[],
): { at: string; status: string }[] {
	const marks: { at: string; status: string }[] = [];
	let prev: string | undefined;
	for (const p of points) {
		if (p.ingestStatus !== prev) {
			marks.push({ at: p.at, status: p.ingestStatus });
			prev = p.ingestStatus;
		}
	}
	return marks;
}

describe("downsampleHeartbeats — transitions survive the reduction", () => {
	it("a 40 s disconnect inside a 2,000-poll run is kept, deltas and all", () => {
		// The audit's shape: a long healthy run, one two-poll excursion whose
		// packet deltas are unremarkable (so it is NEVER its bucket's worst
		// point), and a loud spike somewhere else to soak up the buckets.
		const full = series(2_000, (i) =>
			i === 1_000 || i === 1_001
				? { ingestStatus: "DISCONNECTED" }
				: i === 1_500
					? { droppedPacketsVideo: 9_999 }
					: {},
		);
		const reduced = downsampleHeartbeats(full);

		// The whole point: the derived marks are IDENTICAL, not merely
		// similar — same timestamps, same status words, same order.
		expect(transitions(reduced)).toEqual(transitions(full));
		// Four marks: the opening CONNECTED, the drop, the recovery… and no
		// more, so an assertion of equality above cannot pass vacuously.
		expect(transitions(full)).toHaveLength(3);
		// Both endpoints of the outage are physically present.
		const kept = new Set(reduced.map((p) => p.at));
		expect(kept.has(point(1_000).at)).toBe(true);
		expect(kept.has(point(1_001).at)).toBe(true);
		// …and the budget still holds.
		expect(reduced.length).toBeLessThanOrEqual(HEARTBEAT_POINT_CAP);
	});

	const shapes: {
		name: string;
		n: number;
		shape: (i: number) => Partial<HeartbeatHistoryPoint>;
	}[] = [
		{ name: "one unbroken run", n: 2_000, shape: () => ({}) },
		{
			name: "an outage at the very start",
			n: 2_000,
			shape: (i) =>
				i < 3 ? { ingestStatus: "WAITING_FOR_FIRST_CONNECT" } : {},
		},
		{
			name: "an outage at the very end",
			n: 2_000,
			shape: (i) => (i > 1_996 ? { ingestStatus: "DISCONNECTED" } : {}),
		},
		{
			name: "a single-poll blip",
			n: 2_000,
			shape: (i) => (i === 777 ? { ingestStatus: "ERROR" } : {}),
		},
		{
			name: "three excursions with loud spikes elsewhere",
			n: 3_000,
			shape: (i) =>
				i === 100 || i === 1_100 || i === 2_100
					? { ingestStatus: "DISCONNECTED" }
					: i % 500 === 7
						? { corruptPacketsAudio: 5_000 }
						: {},
		},
		{
			name: "long alternating bands",
			n: 2_400,
			shape: (i) =>
				Math.floor(i / 100) % 2 === 1 ? { ingestStatus: "DISCONNECTED" } : {},
		},
	];

	for (const { name, n, shape } of shapes) {
		it(`derives the same transitions as the full series — ${name}`, () => {
			const full = series(n, shape);
			const reduced = downsampleHeartbeats(full);
			expect(transitions(reduced)).toEqual(transitions(full));
			// Budget: the mandatory points come out of the cap, so as long as
			// the transitions fit, the reduction still fits.
			expect(reduced.length).toBeLessThanOrEqual(
				HEARTBEAT_POINT_CAP + transitions(full).length,
			);
			expect(reduced.length).toBeLessThan(n);
			// Ascending, and a subsequence of the input (no invented points).
			const ats = full.map((p) => p.at);
			expect(reduced.map((p) => p.at)).toEqual(
				ats.filter((a) => reduced.some((p) => p.at === a)),
			);
		});
	}

	it("a series that flaps more often than the cap keeps every boundary — over budget on purpose", () => {
		// Every poll changes status: 2,000 mandatory points against a 500
		// cap. Dropping transitions is the defect; exceeding the budget is
		// the documented trade.
		const full = series(2_000, (i) =>
			i % 2 === 0 ? {} : { ingestStatus: "DISCONNECTED" },
		);
		const reduced = downsampleHeartbeats(full);
		expect(transitions(reduced)).toEqual(transitions(full));
		expect(reduced.length).toBeGreaterThan(HEARTBEAT_POINT_CAP);
		expect(reduced.length).toBeLessThanOrEqual(full.length);
	});

	it("mandatory boundaries that exactly fill the cap leave NO room for a spike bucket — review #348 M1", () => {
		// The reviewer's reproduction: cap 10 over five alternating runs of
		// 20. The boundaries are 5 runs × (first, last) = exactly 10 indices,
		// i.e. the whole budget — and `Math.max(1, cap - keep.size)` still
		// ran ONE bucket pass over the entire range and appended its worst
		// point, so the reduction returned cap + 1. The budget has to be
		// allowed to reach zero.
		const full = series(100, (i) =>
			Math.floor(i / 20) % 2 === 1
				? { ingestStatus: "DISCONNECTED" }
				: i === 50
					? { droppedPacketsVideo: 9_999 }
					: {},
		);
		const reduced = downsampleHeartbeats(full, 10);
		expect(reduced).toHaveLength(10);
		expect(transitions(reduced)).toEqual(transitions(full));
		// Index 50 sits in the MIDDLE of the third run (40..59), so it is not
		// a boundary — it is exactly the eleventh point the old budget's one
		// surviving bucket appended.
		expect(reduced.some((p) => p.droppedPacketsVideo === 9_999)).toBe(false);
	});

	it("still keeps the worst packet spike, which is what the buckets are for", () => {
		const full = series(600, (i) =>
			i === 300 ? { droppedPacketsVideo: 999 } : {},
		);
		const reduced = downsampleHeartbeats(full);
		expect(reduced.some((p) => p.droppedPacketsVideo === 999)).toBe(true);
		expect(reduced.length).toBeLessThanOrEqual(HEARTBEAT_POINT_CAP);
	});

	it("the newest poll is always the right edge", () => {
		const full = series(2_000, (i) =>
			i === 1_999 ? { ingestStatus: "DISCONNECTED" } : {},
		);
		const reduced = downsampleHeartbeats(full);
		expect(reduced[reduced.length - 1]).toBe(full[1_999]);
	});

	it("a series at or under the cap passes through untouched", () => {
		const full = series(HEARTBEAT_POINT_CAP);
		expect(downsampleHeartbeats(full)).toBe(full);
		const short = series(3, (i) =>
			i === 1 ? { ingestStatus: "DISCONNECTED" } : {},
		);
		expect(downsampleHeartbeats(short)).toBe(short);
		expect(downsampleHeartbeats([])).toEqual([]);
	});

	it("rejects a cap below one rather than looping forever", () => {
		expect(() => downsampleHeartbeats(series(10), 0)).toThrow(/cap must be/);
	});
});

describe("projectHeartbeatRow incoming bitrate", () => {
	it("lifts the first stream's measured incomingBitrate onto the point", () => {
		const projected = projectHeartbeatRow({
			at: new Date("2026-09-08T00:00:00.000Z"),
			raw: {
				ingest: {
					status: "CONNECTED",
					streams: [
						{
							mediaType: "VIDEO",
							incomingBitrate: 5_000_000,
							bitrate: 6_000_000,
						},
					],
				},
			},
			deltas: { droppedPacketsVideo: 2 },
		});
		expect(projected.incomingBitrate).toBe(5_000_000);
		expect(projected.bitrate).toBe(6_000_000);
		expect(projected.droppedPacketsVideo).toBe(2);
	});

	it("leaves incomingBitrate undefined when no stream reports it", () => {
		const projected = projectHeartbeatRow({
			at: new Date("2026-09-08T00:00:00.000Z"),
			raw: {
				ingest: { status: "CONNECTED", streams: [{ mediaType: "VIDEO" }] },
			},
			deltas: {},
		});
		expect(projected.incomingBitrate).toBeUndefined();
	});
});

describe("pushHeartbeatPoints", () => {
	const sample = (
		at: string,
		ingest: Record<string, unknown>,
	): { at: Date; value: unknown } => ({ at: new Date(at), value: { ingest } });

	it("computes per-sample deltas from consecutive cumulative counters", () => {
		const points = pushHeartbeatPoints([
			sample("2026-09-08T00:00:00.000Z", {
				status: "CONNECTED",
				droppedPacketsVideo: 10,
				corruptPacketsAudio: 4,
				streams: [{ mediaType: "VIDEO", incomingBitrate: 5_000_000 }],
			}),
			sample("2026-09-08T00:00:02.000Z", {
				status: "CONNECTED",
				droppedPacketsVideo: 13,
				corruptPacketsAudio: 4,
				streams: [{ mediaType: "VIDEO", incomingBitrate: 4_800_000 }],
			}),
		]);
		// First sample: no predecessor → deltas 0, but status/incoming lifted.
		expect(points[0]).toMatchObject({
			droppedPacketsVideo: 0,
			corruptPacketsAudio: 0,
			ingestStatus: "CONNECTED",
			incomingBitrate: 5_000_000,
		});
		// Second: 13 − 10 = 3 dropped, corrupt unchanged (4 − 4 = 0).
		expect(points[1]).toMatchObject({
			droppedPacketsVideo: 3,
			corruptPacketsAudio: 0,
			incomingBitrate: 4_800_000,
		});
	});

	it("clamps a counter reset (encoder restart) to 0 rather than a negative delta", () => {
		const points = pushHeartbeatPoints([
			sample("2026-09-08T00:00:00.000Z", { droppedPacketsVideo: 100 }),
			sample("2026-09-08T00:00:02.000Z", { droppedPacketsVideo: 2 }),
		]);
		expect(points[1]?.droppedPacketsVideo).toBe(0);
	});

	it("sorts samples by time before differencing, so caller order does not matter", () => {
		const points = pushHeartbeatPoints([
			sample("2026-09-08T00:00:02.000Z", { droppedPacketsVideo: 20 }),
			sample("2026-09-08T00:00:00.000Z", { droppedPacketsVideo: 5 }),
		]);
		expect(points.map((point) => point.at)).toEqual([
			"2026-09-08T00:00:00.000Z",
			"2026-09-08T00:00:02.000Z",
		]);
		expect(points[1]?.droppedPacketsVideo).toBe(15);
	});
});
