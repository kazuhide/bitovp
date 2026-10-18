import { describe, expect, it } from "vitest";
import {
	alertRuleCreateSchema,
	evaluateAlertRules,
	HEARTBEAT_FUTURE_SKEW_TOLERANCE_MS,
	type HeartbeatObservation,
	heartbeatSampleFresh,
	INGEST_CONNECTED_MAX_AGE_MS,
	ingestConnectedFresh,
	ingestConnectedFromHeartbeat,
	ingestConnectedTriState,
	persistedHeartbeatAtMs,
} from "./alerts";

/**
 *  (design §8): pure evaluation table tests per metric incl.
 * windowPolls boundaries, edge-triggering against the open set, and stale
 * detection with a fake clock. The worker's transition application has its
 * own tests; THIS file owns the judgment.
 */

const T0 = Date.parse("2026-08-13T10:00:00.000Z");
const iso = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();

function sample(over: {
	atMs: number;
	status?: string;
	healthy?: boolean;
	streams?: unknown[];
}): HeartbeatObservation {
	return {
		at: iso(over.atMs),
		raw: {
			ingest: {
				...(over.status !== undefined ? { status: over.status } : {}),
				...(over.healthy !== undefined ? { healthy: over.healthy } : {}),
				...(over.streams !== undefined ? { streams: over.streams } : {}),
			},
		},
	};
}

const RULE_ID = "00000000-0000-4000-8000-0000000000r1".replace("r", "a");

function evaluate(over: {
	rules?: Parameters<typeof evaluateAlertRules>[0]["rules"];
	window: HeartbeatObservation[];
	open?: string[];
	status?: string;
	nowMs?: number;
	lastTouchedAtMs?: number;
	programStartAtMs?: number;
	programEndAtMs?: number;
}) {
	return evaluateAlertRules({
		rules: over.rules ?? [
			{
				id: RULE_ID,
				metric: "INPUT_DISCONNECTED",
				threshold: null,
				windowPolls: 2,
			},
		],
		window: over.window,
		openRuleIds: new Set(over.open ?? []),
		channel: {
			status: over.status ?? "RUNNING",
			...(over.lastTouchedAtMs !== undefined
				? { lastTouchedAt: iso(over.lastTouchedAtMs) }
				: {}),
			...(over.programStartAtMs !== undefined
				? { programStartAt: iso(over.programStartAtMs) }
				: {}),
			...(over.programEndAtMs !== undefined
				? { programEndAt: iso(over.programEndAtMs) }
				: {}),
		},
		now: iso(over.nowMs ?? 90_000),
		sweepIntervalMs: 30_000,
	});
}

describe("INPUT_DISCONNECTED", () => {
	it("opens after windowPolls consecutive disconnected samples", () => {
		const result = evaluate({
			window: [
				sample({ atMs: 0, status: "CONNECTED" }),
				sample({ atMs: 30_000, status: "DISCONNECTED" }),
				sample({ atMs: 60_000, status: "DISCONNECTED" }),
			],
		});
		expect(result.open).toHaveLength(1);
		expect(result.open[0]).toMatchObject({
			ruleId: RULE_ID,
			metric: "INPUT_DISCONNECTED",
			context: { status: "DISCONNECTED" },
		});
		expect(result.resolve).toEqual([]);
	});

	it("ONE disconnected sample under windowPolls=2 does not open (flap guard)", () => {
		const result = evaluate({
			window: [
				sample({ atMs: 0, status: "CONNECTED" }),
				sample({ atMs: 30_000, status: "DISCONNECTED" }),
			],
		});
		expect(result.open).toEqual([]);
	});

	it("rev433: WAITING_FOR_FIRST_CONNECT (healthy:false) on an UNSCHEDULED channel never opens — nothing has connected yet, so nothing disconnected", () => {
		const result = evaluate({
			window: [
				sample({
					atMs: 0,
					status: "WAITING_FOR_FIRST_CONNECT",
					healthy: false,
				}),
				sample({
					atMs: 30_000,
					status: "WAITING_FOR_FIRST_CONNECT",
					healthy: false,
				}),
				sample({
					atMs: 60_000,
					status: "WAITING_FOR_FIRST_CONNECT",
					healthy: false,
				}),
			],
		});
		expect(result.open).toEqual([]);
	});

	it("rev433: an OPEN disconnect stays open while a restart cycle re-enters WAITING — nothing has reconnected", () => {
		const result = evaluate({
			open: [RULE_ID],
			window: [
				sample({ atMs: 0, status: "DISCONNECTED" }),
				sample({
					atMs: 30_000,
					status: "WAITING_FOR_FIRST_CONNECT",
					healthy: false,
				}),
				sample({
					atMs: 60_000,
					status: "WAITING_FOR_FIRST_CONNECT",
					healthy: false,
				}),
			],
		});
		expect(result.resolve).toEqual([]);
		expect(result.open).toEqual([]);
	});

	it("healthy:false counts as disconnected even with an unknown status string", () => {
		const result = evaluate({
			window: [
				sample({ atMs: 0, status: "WEIRD_NEW_STATE", healthy: false }),
				sample({ atMs: 30_000, status: "WEIRD_NEW_STATE", healthy: false }),
			],
		});
		expect(result.open).toHaveLength(1);
	});

	it("an unknown status string ALONE never breaches (no false positives on novelty)", () => {
		const result = evaluate({
			window: [
				sample({ atMs: 0, status: "NEW_STATE" }),
				sample({ atMs: 30_000, status: "NEW_STATE" }),
			],
		});
		expect(result.open).toEqual([]);
	});

	it("already-open + still breaching ⇒ neither opens nor resolves (edge-triggered)", () => {
		const result = evaluate({
			window: [
				sample({ atMs: 0, status: "DISCONNECTED" }),
				sample({ atMs: 30_000, status: "DISCONNECTED" }),
			],
			open: [RULE_ID],
		});
		expect(result.open).toEqual([]);
		expect(result.resolve).toEqual([]);
	});

	it("already-open + recovered ⇒ resolves", () => {
		const result = evaluate({
			window: [
				sample({ atMs: 0, status: "DISCONNECTED" }),
				sample({ atMs: 30_000, status: "CONNECTED" }),
			],
			open: [RULE_ID],
		});
		expect(result.open).toEqual([]);
		expect(result.resolve).toEqual([RULE_ID]);
	});
});

describe("INPUT_DISCONNECTED × the PLANNED pre-air window (ledger #243)", () => {
	/**
	 * re-audit proof §9-7: on paid runs #3–#5
	 * this alert opened during the scheduled WAITING_FOR_FIRST_CONNECT —
	 * before the feeder's own start time — and resolved the moment the feed
	 * arrived. Every arm below feeds the SAME two disconnected samples and
	 * varies only the program window, so the window is provably the variable.
	 */
	const window = [
		sample({ atMs: 0, status: "DISCONNECTED" }),
		sample({ atMs: 30_000, status: "DISCONNECTED" }),
	];

	const cases: {
		name: string;
		nowMs: number;
		programStartAtMs?: number;
		programEndAtMs?: number;
		opens: boolean;
	}[] = [
		{
			name: "before air time ⇒ silent: the wait is the thing the operator scheduled",
			nowMs: 50_000,
			programStartAtMs: 60_000,
			programEndAtMs: 200_000,
			opens: false,
		},
		{
			name: "before air time with NO scheduled end ⇒ still silent (an open-ended program pre-airs the same way)",
			nowMs: 50_000,
			programStartAtMs: 60_000,
			opens: false,
		},
		{
			name: "at air time exactly ⇒ armed: the planned wait is over",
			nowMs: 60_000,
			programStartAtMs: 60_000,
			programEndAtMs: 200_000,
			opens: true,
		},
		{
			name: "after air time ⇒ opens, exactly as before",
			nowMs: 90_000,
			programStartAtMs: 60_000,
			programEndAtMs: 200_000,
			opens: true,
		},
		{
			name: "after the scheduled END ⇒ still opens: an overrunning channel is still billing",
			nowMs: 300_000,
			programStartAtMs: 60_000,
			programEndAtMs: 200_000,
			opens: true,
		},
		{
			name: "UNSCHEDULED channel ⇒ opens: no window, so no planned wait to excuse",
			nowMs: 50_000,
			opens: true,
		},
	];

	for (const testCase of cases) {
		it(testCase.name, () => {
			const result = evaluate({
				window,
				nowMs: testCase.nowMs,
				...(testCase.programStartAtMs !== undefined
					? { programStartAtMs: testCase.programStartAtMs }
					: {}),
				...(testCase.programEndAtMs !== undefined
					? { programEndAtMs: testCase.programEndAtMs }
					: {}),
			});
			expect(result.open).toHaveLength(testCase.opens ? 1 : 0);
		});
	}

	it("an UNPARSEABLE programStartAt does not suppress — a gate that cannot read its window stays out of the way", () => {
		const result = evaluateAlertRules({
			rules: [
				{
					id: RULE_ID,
					metric: "INPUT_DISCONNECTED",
					threshold: null,
					windowPolls: 2,
				},
			],
			window,
			openRuleIds: new Set<string>(),
			channel: { status: "RUNNING", programStartAt: "not-a-date" },
			now: iso(50_000),
			sweepIntervalMs: 30_000,
		});
		expect(result.open).toHaveLength(1);
	});

	it("an event already open when air time moves AHEAD of now resolves rather than lingering", () => {
		const result = evaluate({
			window,
			open: [RULE_ID],
			nowMs: 50_000,
			programStartAtMs: 60_000,
		});
		expect(result.open).toEqual([]);
		expect(result.resolve).toEqual([RULE_ID]);
	});

	it("PROGRAM_START_NO_INGEST is the rule that owns the other side of the same window", () => {
		// The pair, evaluated together on ONE pre-air tick and ONE on-air
		// tick: exactly one of them is allowed to be armed at a time, which
		// is why suppressing INPUT_DISCONNECTED before air time loses no
		// coverage.
		const PROGRAM_RULE_ID = "00000000-0000-4000-8000-00000000000b";
		const rules = [
			{
				id: RULE_ID,
				metric: "INPUT_DISCONNECTED",
				threshold: null,
				windowPolls: 2,
			},
			{
				id: PROGRAM_RULE_ID,
				metric: "PROGRAM_START_NO_INGEST",
				threshold: null,
				windowPolls: 2,
			},
		];
		const preAir = evaluate({
			rules,
			window,
			nowMs: 50_000,
			programStartAtMs: 60_000,
			programEndAtMs: 200_000,
		});
		expect(preAir.open).toEqual([]);
		const onAir = evaluate({
			rules,
			window,
			nowMs: 90_000,
			programStartAtMs: 60_000,
			programEndAtMs: 200_000,
		});
		expect(onAir.open.map((breach) => breach.metric).sort()).toEqual([
			"INPUT_DISCONNECTED",
			"PROGRAM_START_NO_INGEST",
		]);
	});

	it("an UNPARSEABLE window leaves the PAIR fail-safe: the program rule goes silent, so this one must NOT (review-347)", () => {
		// The dangerous combination the single-rule arm above cannot see.
		// PROGRAM_START_NO_INGEST refuses an unparseable programStartAt
		// (`Number.isFinite(startAt)` is false ⇒ never in window), so if
		// #243's gate ALSO suppressed on one, a channel whose stored window
		// is corrupt would have NO disconnect alarm at all — silence produced
		// by two independently reasonable refusals. The gate therefore fails
		// OPEN, and the pair keeps exactly one rule able to speak.
		const PROGRAM_RULE_ID = "00000000-0000-4000-8000-00000000000b";
		const result = evaluateAlertRules({
			rules: [
				{
					id: RULE_ID,
					metric: "INPUT_DISCONNECTED",
					threshold: null,
					windowPolls: 2,
				},
				{
					id: PROGRAM_RULE_ID,
					metric: "PROGRAM_START_NO_INGEST",
					threshold: null,
					windowPolls: 2,
				},
			],
			window,
			openRuleIds: new Set<string>(),
			channel: { status: "RUNNING", programStartAt: "not-a-date" },
			now: iso(50_000),
			sweepIntervalMs: 30_000,
		});
		expect(result.open.map((breach) => breach.metric)).toEqual([
			"INPUT_DISCONNECTED",
		]);
	});
});

describe("HEARTBEAT_STALE (sweep clock, not sample clock)", () => {
	const rule = [
		{
			id: RULE_ID,
			metric: "HEARTBEAT_STALE",
			threshold: null,
			windowPolls: 2,
		},
	];

	it("opens when the last sample is older than windowPolls × interval", () => {
		const result = evaluate({
			rules: rule,
			window: [sample({ atMs: 0, status: "CONNECTED" })],
			nowMs: 61_000, // 61s > 2 × 30s
		});
		expect(result.open).toHaveLength(1);
		expect(result.open[0]?.context).toMatchObject({ staleAfterMs: 60_000 });
	});

	it("fresh sample ⇒ no breach", () => {
		const result = evaluate({
			rules: rule,
			window: [sample({ atMs: 30_000, status: "CONNECTED" })],
			nowMs: 59_000,
		});
		expect(result.open).toEqual([]);
	});

	it("NO samples + a STALE last-touch anchor ⇒ stale (polls failing since RUNNING)", () => {
		// review-83b I3: the empty window is anchored on the channel row's
		// updatedAt (bumped by every successful poll and by the RUNNING
		// transition), so never-succeeded polls still alert — after the SAME
		// windowPolls grace as everything else.
		const result = evaluate({
			rules: rule,
			window: [],
			nowMs: 61_000,
			lastTouchedAtMs: 0,
		});
		expect(result.open).toHaveLength(1);
	});

	it("NO samples + a FRESH anchor ⇒ no breach (first poll failed, grace holds)", () => {
		// The old code was age=∞ ⇒ instant CRIT on the first tick after
		// RUNNING whenever the first poll failed, at ANY windowPolls
		// (review-83b I3's probe: 1/2/10/20 all insta-breached).
		for (const windowPolls of [1, 2, 10, 20]) {
			const result = evaluate({
				rules: [
					{
						id: RULE_ID,
						metric: "HEARTBEAT_STALE",
						threshold: null,
						windowPolls,
					},
				],
				window: [],
				nowMs: 20_000,
				lastTouchedAtMs: 0,
			});
			expect(result.open, `windowPolls=${windowPolls}`).toEqual([]);
		}
	});

	it("NO samples and NO anchor ⇒ no breach (unknowable, fail quiet)", () => {
		const result = evaluate({ rules: rule, window: [], nowMs: 500_000 });
		expect(result.open).toEqual([]);
	});

	it("non-RUNNING channels are never stale (stopped ≠ broken)", () => {
		const result = evaluate({
			rules: rule,
			window: [],
			status: "STOPPED",
			nowMs: 500_000,
		});
		expect(result.open).toEqual([]);
	});

	/**
	 * the anchor was
	 * `window[last]` unconditionally, so ONE sample stamped in the future by a
	 * skewed worker clock produced a negative age and silently suppressed a
	 * breach the rest of the window had earned.
	 */
	it("a FUTURE-stamped sample cannot anchor: the last REAL sample still breaches", () => {
		const result = evaluate({
			rules: rule,
			window: [
				sample({ atMs: 0, status: "CONNECTED" }),
				// One row an hour ahead of `now` — newest by `at`, and the
				// anchor before #243.
				sample({ atMs: 3_600_000, status: "CONNECTED" }),
			],
			nowMs: 61_000,
		});
		expect(result.open).toHaveLength(1);
		// The reported sample is the one the age was measured FROM: naming the
		// future row beside an age computed off another row would be a
		// consistent-looking lie.
		expect(result.open[0]?.context).toMatchObject({
			lastSampleAt: iso(0),
			ageMs: 61_000,
			staleAfterMs: 60_000,
		});
	});

	it("a future stamp INSIDE the skew tolerance still anchors (ordinary drift keeps its grace)", () => {
		const result = evaluate({
			rules: rule,
			// 4s ahead of now — under the 5s tolerance, so this row anchors
			// and the channel reads healthy, exactly as an on-time row would.
			window: [sample({ atMs: 65_000, status: "CONNECTED" })],
			nowMs: 61_000,
		});
		expect(result.open).toEqual([]);
	});

	it("future-stamped BEYOND tolerance with no usable sample falls back to the last-touch anchor", () => {
		const result = evaluate({
			rules: rule,
			window: [sample({ atMs: 3_600_000, status: "CONNECTED" })],
			nowMs: 61_000,
			lastTouchedAtMs: 0,
		});
		expect(result.open).toHaveLength(1);
		expect(result.open[0]?.context).toMatchObject({ lastSampleAt: null });
	});

	it("an UNPARSEABLE stamp is skipped like a future one — older usable samples still anchor", () => {
		const result = evaluate({
			rules: rule,
			window: [
				sample({ atMs: 0, status: "CONNECTED" }),
				{ at: "not-a-date", raw: { ingest: { status: "CONNECTED" } } },
			],
			nowMs: 61_000,
		});
		expect(result.open).toHaveLength(1);
		expect(result.open[0]?.context).toMatchObject({ lastSampleAt: iso(0) });
	});
});

describe("BITRATE_BELOW / FPS_BELOW", () => {
	const bitrateRule = [
		{
			id: RULE_ID,
			metric: "BITRATE_BELOW",
			threshold: 1_000_000,
			windowPolls: 2,
		},
	];

	it("opens when every reported bitrate is below threshold for the window", () => {
		const low = [{ bitrate: 500_000, width: 1920, height: 1080 }];
		const result = evaluate({
			rules: bitrateRule,
			window: [
				sample({ atMs: 0, streams: low }),
				sample({ atMs: 30_000, streams: low }),
			],
		});
		expect(result.open).toHaveLength(1);
		expect(result.open[0]?.context).toMatchObject({
			threshold: 1_000_000,
			values: [500_000],
		});
	});

	it("ONE healthy stream keeps the alert closed (every-value semantics)", () => {
		const mixed = [{ bitrate: 500_000 }, { bitrate: 2_000_000 }];
		const result = evaluate({
			rules: bitrateRule,
			window: [
				sample({ atMs: 0, streams: mixed }),
				sample({ atMs: 30_000, streams: mixed }),
			],
		});
		expect(result.open).toEqual([]);
	});

	it("a sample reporting NO numbers is no-data, never a breach", () => {
		const result = evaluate({
			rules: bitrateRule,
			window: [
				sample({ atMs: 0, streams: [] }),
				sample({ atMs: 30_000, streams: [] }),
			],
		});
		expect(result.open).toEqual([]);
	});

	it("FPS_BELOW reads video streams only — an audio sampleRate cannot satisfy it", () => {
		const result = evaluate({
			rules: [
				{ id: RULE_ID, metric: "FPS_BELOW", threshold: 24, windowPolls: 1 },
			],
			window: [
				sample({
					atMs: 0,
					streams: [
						{ mediaType: "AUDIO", rate: 48_000 },
						{ mediaType: "VIDEO", rate: 12 },
					],
				}),
			],
		});
		expect(result.open).toHaveLength(1);
		expect(result.open[0]?.context).toMatchObject({ values: [12] });
	});

	it("a rule missing its threshold never breaches", () => {
		const result = evaluate({
			rules: [
				{
					id: RULE_ID,
					metric: "BITRATE_BELOW",
					threshold: null,
					windowPolls: 1,
				},
			],
			window: [sample({ atMs: 0, streams: [{ bitrate: 1 }] })],
		});
		expect(result.open).toEqual([]);
	});
});

describe("PROGRAM_START_NO_INGEST (ledger #94 — air time with no feed)", () => {
	const RULE = [
		{
			id: RULE_ID,
			metric: "PROGRAM_START_NO_INGEST",
			threshold: null,
			windowPolls: 1,
		},
	];

	it("breaches inside the program window when the feed is unhealthy", () => {
		const result = evaluate({
			rules: RULE,
			window: [sample({ atMs: 80_000, healthy: false })],
			nowMs: 90_000,
			programStartAtMs: 60_000,
			programEndAtMs: 200_000,
		});
		expect(result.open.map((b) => b.ruleId)).toEqual([RULE_ID]);
		// The context names the air time — that is the operator's question.
		expect(result.open[0]?.context).toMatchObject({
			programStartAt: iso(60_000),
		});
	});

	it("rev433: breaches on the REAL wire shape of a no-show — WAITING_FOR_FIRST_CONNECT with healthy:false — at windowPolls 1 and 2", () => {
		const waiting = (atMs: number) =>
			sample({ atMs, status: "WAITING_FOR_FIRST_CONNECT", healthy: false });
		const one = evaluate({
			rules: RULE,
			window: [waiting(80_000)],
			nowMs: 90_000,
			programStartAtMs: 60_000,
			programEndAtMs: 200_000,
		});
		expect(one.open.map((b) => b.ruleId)).toEqual([RULE_ID]);
		const two = evaluate({
			rules: [
				{
					id: RULE_ID,
					metric: "PROGRAM_START_NO_INGEST",
					threshold: null,
					windowPolls: 2,
				},
			],
			window: [waiting(50_000), waiting(80_000)],
			nowMs: 90_000,
			programStartAtMs: 60_000,
			programEndAtMs: 200_000,
		});
		expect(two.open.map((b) => b.ruleId)).toEqual([RULE_ID]);
	});

	it("does NOT breach before air time, however unhealthy the feed", () => {
		const result = evaluate({
			rules: RULE,
			window: [sample({ atMs: 40_000, healthy: false })],
			nowMs: 50_000,
			programStartAtMs: 60_000,
			programEndAtMs: 200_000,
		});
		expect(result.open).toHaveLength(0);
	});

	it("does NOT breach after the scheduled end — the STOP row owns that", () => {
		const result = evaluate({
			rules: RULE,
			window: [sample({ atMs: 290_000, healthy: false })],
			nowMs: 300_000,
			programStartAtMs: 60_000,
			programEndAtMs: 200_000,
		});
		expect(result.open).toHaveLength(0);
	});

	it("never fires on an UNSCHEDULED channel — no air time to miss", () => {
		const result = evaluate({
			rules: RULE,
			window: [sample({ atMs: 80_000, healthy: false })],
			nowMs: 90_000,
		});
		expect(result.open).toHaveLength(0);
	});

	it("resolves when the feed arrives mid-window", () => {
		const result = evaluate({
			rules: RULE,
			window: [sample({ atMs: 80_000, healthy: true, status: "CONNECTED" })],
			open: [RULE_ID],
			nowMs: 90_000,
			programStartAtMs: 60_000,
			programEndAtMs: 200_000,
		});
		expect(result.resolve).toEqual([RULE_ID]);
	});

	it("an EMPTY window cannot breach — absence of data is not data", () => {
		const result = evaluate({
			rules: RULE,
			window: [],
			nowMs: 90_000,
			programStartAtMs: 60_000,
			programEndAtMs: 200_000,
		});
		expect(result.open).toHaveLength(0);
	});

	it("stays quiet when the channel is not RUNNING (stopping at air time is its own alarm)", () => {
		const result = evaluate({
			rules: RULE,
			window: [sample({ atMs: 80_000, healthy: false })],
			status: "STOPPED",
			nowMs: 90_000,
			programStartAtMs: 60_000,
			programEndAtMs: 200_000,
		});
		expect(result.open).toHaveLength(0);
	});
});

describe("persisted-heartbeat column parsers (ledger #95/#97)", () => {
	/**
	 * Direct tests for the two COLUMN readers — until now both were covered
	 * only THROUGH consumers, and review-225 proved the gap: mutating the
	 * unparseable-date guard to `return ms` survived all 5,800 tests, because
	 * nothing fed the parser a malformed date STRING. A malformed `at` must
	 * read STALE (null), never fresh — #97 inverted is under-reporting.
	 */
	const WRAPPER = {
		at: "2026-08-15T01:00:00.000Z",
		raw: { ingest: { status: "CONNECTED", healthy: true } },
		deltas: {},
	};

	it("persistedHeartbeatAtMs: epoch ms from the wrapper's at", () => {
		expect(persistedHeartbeatAtMs(WRAPPER)).toBe(
			Date.parse("2026-08-15T01:00:00.000Z"),
		);
	});

	it("persistedHeartbeatAtMs: null on malformed date STRING — the branch review-225's mutation walked through", () => {
		expect(
			persistedHeartbeatAtMs({ at: "not-a-date", raw: {}, deltas: {} }),
		).toBeNull();
	});

	it("persistedHeartbeatAtMs: null on non-object, bare string, and non-string at", () => {
		expect(persistedHeartbeatAtMs(null)).toBeNull();
		expect(persistedHeartbeatAtMs("x")).toBeNull();
		expect(persistedHeartbeatAtMs({ at: 42, raw: {}, deltas: {} })).toBeNull();
	});

	it("ingestConnectedFromHeartbeat: true only for the PRODUCTION wrapper — the imagined flat shape stays false (the #95 C1 regression pin)", () => {
		expect(ingestConnectedFromHeartbeat(WRAPPER)).toBe(true);
		// The shape the first cut's fixtures invented: ingest at top level.
		expect(
			ingestConnectedFromHeartbeat({
				ingest: { status: "CONNECTED", healthy: true },
			}),
		).toBe(false);
		expect(ingestConnectedFromHeartbeat(null)).toBe(false);
		expect(ingestConnectedFromHeartbeat({ at: "x", raw: {}, deltas: {} })).toBe(
			false,
		);
		// Novel status with no healthy signal: unknown is NOT connected.
		expect(
			ingestConnectedFromHeartbeat({
				at: "x",
				raw: { ingest: { status: "NEGOTIATING" } },
				deltas: {},
			}),
		).toBe(false);
	});
});

describe("PROVIDER_WARNING (the encoder's own WARNING/ERROR entries in events[])", () => {
	const KEYFRAME =
		"At least one input video stream key-frame interval is larger than the threshold: 2167 ms >= 2000 ms! Output video stream may have playback issues.";
	const AVSYNC =
		"AV-Sync issue detected on audio stream 1, desync: -0.281000 seconds.";
	const connect = {
		time: "2026-08-13T09:59:49.000Z",
		details: { eventType: "FIRST_CONNECT", message: null },
	};
	const warning = (message: string, time = "2026-08-13T09:59:51.000Z") => ({
		time,
		details: { eventType: "WARNING", message },
	});
	/** A CONNECTED poll carrying the provider's CUMULATIVE event list. */
	const poll = (atMs: number, events: unknown[]): HeartbeatObservation => ({
		at: iso(atMs),
		raw: { ingest: { status: "CONNECTED", healthy: true }, events },
	});
	const RULE = {
		id: RULE_ID,
		metric: "PROVIDER_WARNING",
		threshold: null,
		windowPolls: 2,
	};
	const run = (over: {
		window: HeartbeatObservation[];
		open?: string[];
		windowPolls?: number;
		windowStartsAtRunStart?: boolean;
	}) =>
		evaluateAlertRules({
			rules: [{ ...RULE, windowPolls: over.windowPolls ?? 2 }],
			window: over.window,
			openRuleIds: new Set(over.open ?? []),
			channel: { status: "RUNNING" },
			now: iso(120_000),
			sweepIntervalMs: 30_000,
			...(over.windowStartsAtRunStart !== undefined
				? { windowStartsAtRunStart: over.windowStartsAtRunStart }
				: {}),
		});

	it("opens on the poll that first carries a WARNING the previous poll did not — message in the context", () => {
		const result = run({
			window: [poll(0, [connect]), poll(30_000, [connect, warning(KEYFRAME)])],
		});
		expect(result.open).toEqual([
			{
				ruleId: RULE_ID,
				metric: "PROVIDER_WARNING",
				context: {
					eventType: "WARNING",
					message: KEYFRAME,
					eventTime: "2026-08-13T09:59:51.000Z",
					at: iso(30_000),
					messages: [KEYFRAME],
				},
			},
		]);
	});

	it("the same entry still present on the next poll is not a second alert while the first is open (the list is cumulative)", () => {
		const result = run({
			window: [
				poll(0, [connect]),
				poll(30_000, [connect, warning(KEYFRAME)]),
				poll(60_000, [connect, warning(KEYFRAME)]),
			],
			open: [RULE_ID],
		});
		expect(result.open).toEqual([]);
		// Still inside the 2-poll silence window (the 30s poll is in the tail).
		expect(result.resolve).toEqual([]);
	});

	it("resolves after windowPolls consecutive polls with no NEW fault, whatever the cumulative list still says", () => {
		const list = [connect, warning(KEYFRAME)];
		const result = run({
			window: [
				poll(0, [connect]),
				poll(30_000, list),
				poll(60_000, list),
				poll(90_000, list),
			],
			open: [RULE_ID],
		});
		expect(result.open).toEqual([]);
		expect(result.resolve).toEqual([RULE_ID]);
	});

	it("a repeated fault with a NEW stamp keeps the alert breaching (the AV-sync WARNING every minute)", () => {
		const first = warning(AVSYNC, "2026-08-13T10:00:20.000Z");
		const second = warning(AVSYNC, "2026-08-13T10:01:20.000Z");
		const result = run({
			window: [
				poll(0, [connect]),
				poll(30_000, [connect, first]),
				poll(60_000, [connect, first]),
				poll(90_000, [connect, first, second]),
			],
			open: [RULE_ID],
		});
		expect(result.resolve).toEqual([]);
	});

	it("the provider's DUPLICATE entry (same time, type and message twice in one list) is one event, not two", () => {
		const entry = warning(AVSYNC, "2026-08-13T10:00:20.000Z");
		const result = run({
			window: [poll(0, [connect]), poll(30_000, [connect, entry, entry])],
		});
		expect(result.open).toHaveLength(1);
		expect(result.open[0]?.context.messages).toEqual([AVSYNC]);
	});

	it("FIRST_CONNECT / DISCONNECT / RECONNECT are not faults", () => {
		const result = run({
			window: [
				poll(0, []),
				poll(30_000, [
					connect,
					{
						time: "2026-08-13T10:00:10.000Z",
						details: { eventType: "DISCONNECT", message: null },
					},
					{
						time: "2026-08-13T10:00:15.000Z",
						details: { eventType: "RECONNECT", message: null },
					},
				]),
			],
		});
		expect(result.open).toEqual([]);
	});

	it("ERROR entries count as faults too", () => {
		const result = run({
			window: [
				poll(0, [connect]),
				poll(30_000, [
					connect,
					{
						time: "2026-08-13T10:00:20.000Z",
						details: { eventType: "ERROR", message: "Encoder failed" },
					},
				]),
			],
		});
		expect(result.open[0]?.context).toMatchObject({
			eventType: "ERROR",
			message: "Encoder failed",
		});
	});

	it("the window's oldest observation cannot claim novelty when its predecessor was not fetched", () => {
		// A 1-poll window whose only row already carries the WARNING: without
		// the predecessor nothing says the entry is new — treating it as new
		// would re-open the alert on every sweep for the rest of the run.
		const result = run({
			window: [poll(30_000, [connect, warning(KEYFRAME)])],
			windowPolls: 1,
		});
		expect(result.open).toEqual([]);
	});

	it("…but the run's FIRST sample's faults are new by definition when the caller says the window starts there", () => {
		const result = run({
			window: [poll(0, [connect, warning(KEYFRAME)])],
			windowPolls: 1,
			windowStartsAtRunStart: true,
		});
		expect(result.open).toHaveLength(1);
		expect(result.open[0]?.context.message).toBe(KEYFRAME);
	});

	it("no events block, or a non-array, is silence", () => {
		const result = run({
			window: [
				{ at: iso(0), raw: { ingest: { status: "CONNECTED" } } },
				{
					at: iso(30_000),
					raw: { ingest: { status: "CONNECTED" }, events: "n/a" },
				},
			],
			open: [RULE_ID],
		});
		expect(result.open).toEqual([]);
		expect(result.resolve).toEqual([RULE_ID]);
	});

	it("is a flag rule: the create schema refuses a threshold", () => {
		expect(
			alertRuleCreateSchema.safeParse({ metric: "PROVIDER_WARNING" }).success,
		).toBe(true);
		expect(
			alertRuleCreateSchema.safeParse({
				metric: "PROVIDER_WARNING",
				threshold: 1,
			}).success,
		).toBe(false);
	});
});

describe("unknown metrics", () => {
	it("a reserved/unknown metric in the DB neither opens nor resolves", () => {
		const result = evaluate({
			rules: [
				{
					id: RULE_ID,
					metric: "PACKET_DELTA_ZERO",
					threshold: null,
					windowPolls: 1,
				},
			],
			window: [sample({ atMs: 0, status: "DISCONNECTED" })],
			open: [RULE_ID],
		});
		expect(result.open).toEqual([]);
		// Deliberate: it does NOT resolve either — an operator investigating
		// a stuck-open unknown-metric event should see it, not have the
		// sweep silently close it.
		expect(result.resolve).toEqual([]);
	});
});

describe("alertRuleCreateSchema", () => {
	it("refuses the reserved PACKET_DELTA_ZERO metric", () => {
		const result = alertRuleCreateSchema.safeParse({
			metric: "PACKET_DELTA_ZERO",
		});
		expect(result.success).toBe(false);
	});

	it("numeric rules need a threshold; flag rules refuse one", () => {
		expect(
			alertRuleCreateSchema.safeParse({ metric: "BITRATE_BELOW" }).success,
		).toBe(false);
		expect(
			alertRuleCreateSchema.safeParse({
				metric: "INPUT_DISCONNECTED",
				threshold: 5,
			}).success,
		).toBe(false);
		expect(
			alertRuleCreateSchema.safeParse({
				metric: "FPS_BELOW",
				threshold: 24,
			}).success,
		).toBe(true);
	});
});

describe("ingestConnectedFresh (ledger #127 — sample truth × time)", () => {
	const T = Date.parse("2026-08-17T12:00:00.000Z");
	const connectedAt = (iso: string) => ({
		at: iso,
		raw: { ingest: { status: "CONNECTED", healthy: true } },
		deltas: {},
	});

	it("fresh CONNECTED vouches; stale CONNECTED does not — the frozen-sample bug", () => {
		expect(
			ingestConnectedFresh(connectedAt("2026-08-17T11:59:30.000Z"), T),
		).toBe(true);
		// The owner's repro: the stop froze the final CONNECTED sample and the
		// page read it as "now" forever. Age retires the proof.
		expect(
			ingestConnectedFresh(connectedAt("2026-08-17T11:00:00.000Z"), T),
		).toBe(false);
	});

	it("the bound is inclusive at exactly MAX_AGE and is caller-overridable (sweep passes its own clock)", () => {
		const atBound = new Date(T - INGEST_CONNECTED_MAX_AGE_MS).toISOString();
		expect(ingestConnectedFresh(connectedAt(atBound), T)).toBe(true);
		expect(ingestConnectedFresh(connectedAt(atBound), T + 1)).toBe(false);
		expect(ingestConnectedFresh(connectedAt(atBound), T, 1_000)).toBe(false);
	});

	it("no timestamp = cannot vouch; a disconnected sample stays false at any age", () => {
		expect(
			ingestConnectedFresh(
				{ raw: { ingest: { status: "CONNECTED", healthy: true } } },
				T,
			),
		).toBe(false);
		expect(
			ingestConnectedFresh(
				{
					at: "2026-08-17T11:59:59.000Z",
					raw: { ingest: { status: "WAITING_FOR_FIRST_CONNECT" } },
					deltas: {},
				},
				T,
			),
		).toBe(false);
	});

	/**
	 * This block
	 * REPLACES a test that asserted the opposite — "a future-dated sample
	 * (clock skew) is tolerated as fresh … the same tolerance HEARTBEAT_STALE's
	 * age math applies". That was the defect written down as a contract: the
	 * window had no lower bound at all, so 30 s ahead and 30 YEARS ahead were
	 * equally "fresh", and both of the readers the sentence appealed to were
	 * wrong in the same direction (HEARTBEAT_STALE's negative age suppressed a
	 * real breach). A bounded tolerance is what that sentence meant; this is
	 * the bound.
	 */
	const skewCases: { name: string; aheadMs: number; fresh: boolean }[] = [
		{ name: "on time", aheadMs: 0, fresh: true },
		{
			name: "ordinary NTP drift, well inside the tolerance",
			aheadMs: 1_000,
			fresh: true,
		},
		{
			name: "exactly at the tolerance (inclusive, like the max-age bound)",
			aheadMs: HEARTBEAT_FUTURE_SKEW_TOLERANCE_MS,
			fresh: true,
		},
		{
			name: "one millisecond past the tolerance",
			aheadMs: HEARTBEAT_FUTURE_SKEW_TOLERANCE_MS + 1,
			fresh: false,
		},
		{
			name: "half a minute ahead — the case the old contract called fresh",
			aheadMs: 30_000,
			fresh: false,
		},
		{
			name: "an hour ahead: a broken clock vouches for nothing",
			aheadMs: 3_600_000,
			fresh: false,
		},
	];

	for (const testCase of skewCases) {
		it(`future stamp ${testCase.name} ⇒ ${testCase.fresh ? "vouches" : "cannot vouch"}`, () => {
			const sampleAt = new Date(T + testCase.aheadMs).toISOString();
			expect(ingestConnectedFresh(connectedAt(sampleAt), T)).toBe(
				testCase.fresh,
			);
			// The freshness half alone moves with it — one window, and the
			// tri-state's "unconfirmed" answer rides the same bound.
			expect(heartbeatSampleFresh(connectedAt(sampleAt), T)).toBe(
				testCase.fresh,
			);
			expect(ingestConnectedTriState(true, connectedAt(sampleAt), T)).toBe(
				testCase.fresh ? true : undefined,
			);
		});
	}

	it("the future bound does NOT move with the caller's maxAge override — it is skew, not age", () => {
		// maxAgeMs widens/narrows how OLD a sample may be; the skew tolerance
		// is a separate, fixed bound, so a caller cannot buy a future sample's
		// vouch by asking for a longer window.
		const ahead = new Date(
			T + HEARTBEAT_FUTURE_SKEW_TOLERANCE_MS + 1,
		).toISOString();
		expect(ingestConnectedFresh(connectedAt(ahead), T, 24 * 3_600_000)).toBe(
			false,
		);
	});
});
