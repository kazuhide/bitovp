import { describe, expect, it } from "vitest";
import { deriveRunHealth, RUN_HEALTH_SPAN_GAP_MS } from "./run-health";

/**
 * Rows are built in the PERSISTED shape the production writer emits — the
 * wrapper's `raw` is the SDK sample. review-224 C1's whole class was tests
 * hand-building an imagined flat shape; these mirror live-processor's
 * PersistedHeartbeat.
 */
function row(
	atMs: number,
	opts: {
		ingest?: boolean;
		/** Wall-clock of the newest manifest update, ms. */
		updateMs?: number;
	} = {},
) {
	return {
		at: new Date(atMs),
		raw: {
			timestamp: new Date(atMs).toISOString(),
			...(opts.ingest !== undefined
				? { ingest: { status: opts.ingest ? "CONNECTED" : "DISCONNECTED" } }
				: {}),
			...(opts.updateMs !== undefined
				? {
						output: {
							manifests: {
								hls: [
									{
										manifestUpdates: [
											{
												manifestUpdateWallClockTime: new Date(
													opts.updateMs,
												).toISOString(),
											},
										],
									},
								],
							},
						},
					}
				: {}),
		},
	};
}

const T0 = 1_760_000_000_000;

describe("deriveRunHealth", () => {
	it("derives the three lanes from one healthy run", () => {
		const rows = [
			row(T0, { ingest: true, updateMs: T0 - 5_000 }),
			row(T0 + 30_000, { ingest: true, updateMs: T0 + 25_000 }),
			row(T0 + 60_000, { ingest: true, updateMs: T0 + 55_000 }),
		];
		const health = deriveRunHealth(rows, { nowMs: T0 + 60_000 });
		expect(health.points).toHaveLength(3);
		expect(health.latest?.ingest).toBe(true);
		expect(health.latest?.encoder).toBe(true);
		expect(health.latest?.output).toBe(true);
		// One continuous span per lane, covering first→last poll.
		for (const lane of ["ingest", "encoder", "output"] as const) {
			expect(health.lanes[lane]).toEqual([{ fromMs: T0, toMs: T0 + 60_000 }]);
		}
	});

	it("ingest false and absent both answer false — never inferred from silence", () => {
		const health = deriveRunHealth(
			[
				row(T0, { ingest: false, updateMs: T0 }),
				row(T0 + 30_000, { updateMs: T0 + 30_000 }), // no ingest block at all
			],
			{ nowMs: T0 + 30_000 },
		);
		expect(health.points.map((p) => p.ingest)).toEqual([false, false]);
		expect(health.lanes.ingest).toEqual([]);
		// The encoder lane still spans — the rows exist.
		expect(health.lanes.encoder).toEqual([{ fromMs: T0, toMs: T0 + 30_000 }]);
	});

	it("output is false when the newest manifest update is STALE at the poll", () => {
		const health = deriveRunHealth(
			[
				// The update happened 10 minutes before this poll — the manifest
				// stopped moving; painting output-true would hide exactly the
				// failure the lamp exists to show.
				row(T0, { ingest: true, updateMs: T0 - 600_000 }),
			],
			{ nowMs: T0 },
		);
		expect(health.points[0]?.output).toBe(false);
		expect(health.lanes.output).toEqual([]);
	});

	it("a poll gap beyond the bound SPLITS a span — bridged uptime nobody observed", () => {
		const afterGap = T0 + 30_000 + RUN_HEALTH_SPAN_GAP_MS + 1;
		const health = deriveRunHealth(
			[
				row(T0, { ingest: true, updateMs: T0 }),
				row(T0 + 30_000, { ingest: true, updateMs: T0 + 30_000 }),
				// Encoder silent (no rows) across the gap, then back.
				row(afterGap, { ingest: true, updateMs: afterGap }),
			],
			{ nowMs: afterGap },
		);
		expect(health.lanes.encoder).toEqual([
			{ fromMs: T0, toMs: T0 + 30_000 },
			{ fromMs: afterGap, toMs: afterGap },
		]);
	});

	it("the 'now' lamps EXPIRE — stale and future-dated alike (ledger #127's class)", () => {
		const rows = [row(T0, { ingest: true, updateMs: T0 })];
		// Fresh: latest present.
		expect(deriveRunHealth(rows, { nowMs: T0 + 60_000 }).latest).toBeDefined();
		// Stale (10 min): a dead encoder stopped producing rows — no green lamps.
		expect(
			deriveRunHealth(rows, { nowMs: T0 + 600_000 }).latest,
		).toBeUndefined();
		// Future-dated newest poll (clock skew): |delta| expires it too — the
		// one-sided form lived forever (review-292 follow-up 2).
		expect(
			deriveRunHealth(rows, { nowMs: T0 - 600_000 }).latest,
		).toBeUndefined();
	});

	it("sorts unordered rows and drops unparseable timestamps", () => {
		const health = deriveRunHealth(
			[
				row(T0 + 30_000, { ingest: true }),
				row(T0, { ingest: true }),
				{ at: "not a date", raw: {} },
			],
			{ nowMs: T0 + 30_000 },
		);
		expect(health.points.map((p) => p.atMs)).toEqual([T0, T0 + 30_000]);
	});
});

describe("deriveRunHealth output lane with Push samples (row #328)", () => {
	// Poll every 30 s carries the cumulative newest manifest update; Push
	// every 2 s carries none unless an update fell inside its own window.
	const poll = [
		row(T0, { ingest: true, updateMs: T0 - 5_000 }),
		row(T0 + 30_000, { ingest: true, updateMs: T0 + 25_000 }),
		row(T0 + 60_000, { ingest: true, updateMs: T0 + 55_000 }),
	];
	const pushWithoutUpdates = Array.from({ length: 30 }, (_, i) =>
		row(T0 + 2_000 * (i + 1), { ingest: true }),
	);

	it("keeps output ON across Push samples that carry no manifest update", () => {
		const health = deriveRunHealth([...poll, ...pushWithoutUpdates], {
			nowMs: T0 + 60_000,
		});
		expect(health.points.every((p) => p.output)).toBe(true);
		expect(health.lanes.output).toEqual([{ fromMs: T0, toMs: T0 + 60_000 }]);
	});

	it("still turns output OFF once the newest observed update is stale", () => {
		const stale = Array.from({ length: 5 }, (_, i) =>
			row(T0 + 150_000 + 2_000 * i, { ingest: true }),
		);
		const health = deriveRunHealth([...poll, ...stale], {
			nowMs: T0 + 160_000,
		});
		const late = health.points.filter((p) => p.atMs >= T0 + 150_000);
		expect(late).toHaveLength(5);
		expect(late.every((p) => !p.output)).toBe(true);
		expect(health.lanes.output).toEqual([{ fromMs: T0, toMs: T0 + 60_000 }]);
	});
});
