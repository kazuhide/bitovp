import { manifestElementEstimate, parseMediaPlaylist } from "@bitovp/core";
import type { AppPrismaClient } from "@bitovp/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getObject = vi.fn();
vi.mock("@bitovp/storage", async (orig) => ({
	...(await orig<Record<string, unknown>>()),
	createBrowserForCredential: () => ({
		listBuckets: async () => [],
		listObjects: async () => ({ objects: [], prefixes: [] }),
		getObject: (input: unknown) => getObject(input),
	}),
}));

import { createOriginObserver, MAX_PLAYLIST_BYTES } from "./origin-observer";

/**
 *  §7 — the observer's seams: per-RUN path resolution, the
 * re-air cursor boundary, the ingest-disconnected suppression, and the
 * two-sweep partition (this sweep opens/resolves ONLY its own DELIVERY
 * metrics — the heartbeat engine's INGEST alerts are untouchable here by
 * construction: every rule query filters on the origin metric names).
 */

const CH = "11111111-1111-4111-8111-111111111111";

function playlist(uris: string[], opts: { endlist?: boolean } = {}): string {
	const lines = [
		"#EXTM3U",
		"#EXT-X-TARGETDURATION:6",
		"#EXT-X-MEDIA-SEQUENCE:0",
	];
	for (const uri of uris) {
		lines.push("#EXTINF:6.0,", uri);
	}
	if (opts.endlist) {
		lines.push("#EXT-X-ENDLIST");
	}
	return lines.join("\n");
}

function streamOf(text: string): AsyncIterable<Buffer> {
	return streamOfChunks([text]);
}

/** 3 h × 2 s × PDT: 5,400 entries per child, within the C8 two-rendition budget. */
function denseDvrPlaylist(): string {
	return [
		"#EXTM3U",
		"#EXT-X-TARGETDURATION:2",
		"#EXT-X-MEDIA-SEQUENCE:0",
		...Array.from(
			{ length: 5400 },
			(_, i) =>
				`#EXT-X-PROGRAM-DATE-TIME:${new Date(i * 2000).toISOString()}\n#EXTINF:2.0,\nsegment_${i}.m4s`,
		),
	].join("\n");
}

/** A body delivered in several chunks — the boundary lives BETWEEN chunks. */
function streamOfChunks(chunks: string[]): AsyncIterable<Buffer> {
	return {
		async *[Symbol.asyncIterator]() {
			for (const chunk of chunks) {
				yield Buffer.from(chunk);
			}
		},
	};
}

const PLAN = {
	planVersion: 1,
	name: "origin-test",
	bitmovin: { cloudRegion: "AWS_AP_NORTHEAST_1", encoderVersion: "STABLE" },
	liveInput: { key: "main", kind: "RTMP" },
	outputs: [
		{
			key: "origin",
			kind: "S3",
			credentialId: "00000000-0000-4000-8000-000000000002",
			bucket: "origin-bucket",
			name: "S3 Output",
		},
	],
	ingest: [
		{ key: "video", inputPath: "live", position: 0 },
		{ key: "audio", inputPath: "live", position: 1 },
	],
	renditions: [
		{
			key: "v360",
			codec: "H264",
			name: "360p",
			ingestKey: "video",
			height: 360,
			bitrate: 800_000,
			level: null,
			presetConfiguration: "LIVE_STANDARD",
			mode: "STANDARD",
		},
		{
			key: "a128",
			codec: "AAC",
			ingestKey: "audio",
			bitrate: 128_000,
			rate: 48_000,
			channelLayout: "CL_STEREO",
		},
	],
	muxings: [
		{
			key: "v360",
			kind: "FMP4",
			streamKey: "v360",
			segmentLength: 6,
			segmentNaming: "segment_%number%.m4s",
			initSegmentName: "init.mp4",
			destination: { outputKey: "origin", path: "live-origin/video/360p" },
		},
		{
			key: "a128",
			kind: "FMP4",
			streamKey: "a128",
			segmentLength: 6,
			segmentNaming: "segment_%number%.m4s",
			initSegmentName: "init.mp4",
			destination: { outputKey: "origin", path: "live-origin/audio/128000" },
		},
	],
	liveManifests: [
		{
			key: "hls",
			kind: "HLS",
			manifestName: "stream.m3u8",
			name: "HLS",
			destination: { outputKey: "origin", path: "live-origin" },
			audioGroupId: "audio",
			audioLanguage: "en",
			closedCaptions: "NONE",
		},
	],
	start: { streamKey: "originlaunch" },
};

function makeWorld(
	opts: {
		runObservation?: unknown;
		outputPrefix?: string;
		/** Plan override — the DASH-only arm needs a channel with no HLS. */
		plan?: unknown;
		heartbeatIngest?: string;
		rules?: Array<{
			id: string;
			metric: string;
			threshold: number | null;
			windowPolls?: number;
		}>;
		openEvents?: Array<{ id: string; ruleId: string }>;
		nowMs?: number;
	} = {},
) {
	const persisted: unknown[] = [];
	const created: Array<Record<string, unknown>> = [];
	const resolved: string[] = [];
	const emitted: Array<Record<string, unknown>> = [];
	const prisma = {
		liveChannel: {
			findMany: vi.fn(async () => [
				{
					id: CH,
					plan: opts.plan ?? PLAN,
					lastHeartbeat: opts.heartbeatIngest
						? { raw: { ingest: { status: opts.heartbeatIngest } } }
						: null,
				},
			]),
		},
		liveChannelRun: {
			findFirst: vi.fn(async () => ({
				id: "run-1",
				seq: 1,
				outputPrefix: opts.outputPrefix ?? "",
				originObservation: opts.runObservation ?? null,
			})),
			updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
				persisted.push(data.originObservation);
				return { count: 1 };
			}),
		},
		alertRule: {
			findMany: vi.fn(async ({ where }: { where: { metric?: string } }) =>
				(opts.rules ?? [])
					.filter((rule) => !where.metric || rule.metric === where.metric)
					// The schema defaults windowPolls to 2 — the fake mirrors it.
					.map((rule) => ({ windowPolls: 2, ...rule })),
			),
		},
		alertEvent: {
			findFirst: vi.fn(
				async ({ where }: { where: { ruleId: string } }) =>
					(opts.openEvents ?? []).find(
						(event) => event.ruleId === where.ruleId,
					) ?? null,
			),
			create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
				created.push(data);
				return { id: `event-${created.length}` };
			}),
			updateMany: vi.fn(async ({ where }: { where: { id: string } }) => {
				resolved.push(where.id);
				return { count: 1 };
			}),
		},
		liveHeartbeat: {
			findMany: vi.fn(async () => []),
		},
	};
	const observer = createOriginObserver({
		prisma: prisma as unknown as AppPrismaClient,
		resolveCredential: async () => ({
			provider: "AWS_S3",
			config: {},
			secret: { accessKeyId: "a", secretAccessKey: "s" },
		}),
		emitEvent: async (event) => {
			emitted.push(event as unknown as Record<string, unknown>);
		},
		now: () => new Date(opts.nowMs ?? 1_000_000),
	});
	return { observer, prisma, persisted, created, resolved, emitted };
}

beforeEach(() => {
	getObject.mockReset();
	getObject.mockImplementation(async () =>
		streamOf(playlist(["segment_1.m4s", "segment_2.m4s"])),
	);
});

describe("origin observer", () => {
	it("derives cadence from live segments, never the MP4 archive", async () => {
		const plan = structuredClone(PLAN);
		const mixed = {
			...plan,
			muxings: [
				...plan.muxings.map((muxing) => ({ ...muxing, segmentLength: 20 })),
				{
					key: "archive",
					kind: "MP4",
					streamKey: "v360",
					additionalStreamKeys: ["a128"],
					filename: "archive.mp4",
					destination: { outputKey: "origin", path: "archive" },
				},
			],
		};
		const world = makeWorld({ plan: mixed });
		await world.observer();
		const state = world.persisted.at(-1) as { dueAtMs: number };
		expect(state.dueAtMs).toBe(1_000_000 + 20_000);
		expect(getObject).toHaveBeenCalledTimes(2);
	});
	it("reads the run's MEDIA playlists at their derived keys and persists the cursor", async () => {
		const world = makeWorld();
		await world.observer();
		// Two renditions ⇒ two media playlists under the manifest dir.
		const keys = getObject.mock.calls.map(
			(call) => (call[0] as { key: string }).key,
		);
		expect(keys).toHaveLength(2);
		for (const key of keys) {
			expect(key.startsWith("live-origin/")).toBe(true);
			expect(key.endsWith(".m3u8")).toBe(true);
		}
		const state = world.persisted.at(-1) as {
			playlists: Record<string, unknown>;
			dueAtMs: number;
		};
		expect(Object.keys(state.playlists)).toHaveLength(2);
		expect(state.dueAtMs).toBe(1_000_000 + 10_000);
	});

	it("a re-aired run whose prefix does not re-derive records unavailable — never a guessed path (the positive rebased READ stays a real-contact item, ledger #161)", async () => {
		// seq 2 with the run's own prefix: effectiveLivePlanForRun rebases,
		// and the observer must fetch under runs/…, not the plan path.
		const world = makeWorld({ outputPrefix: "live-origin/runs/002-run1" });
		await world.observer();
		// The identity check inside effectiveLivePlanForRun fails for a
		// mismatched prefix (this fake's prefix is not the real derivation)
		// — the observer must then record unavailable-with-reason, never
		// guess a path.
		expect(getObject).not.toHaveBeenCalled();
		const state = world.persisted.at(-1) as { unavailableReason?: string };
		expect(state.unavailableReason).toContain("underivable");
	});

	it("opens ORIGIN_MANIFEST_STALE through its own rule — and ONLY origin rules are ever queried", async () => {
		const frozen = {
			playlists: {
				"live-origin/video_800000.m3u8": {
					lastSegmentUri: "segment_2.m4s",
					segmentCount: 2,
					mediaSequence: 0,
					lastProgressAtMs: 1_000_000 - 120_000,
				},
				"live-origin/audio_128000.m3u8": {
					lastSegmentUri: "segment_2.m4s",
					segmentCount: 2,
					mediaSequence: 0,
					lastProgressAtMs: 1_000_000 - 120_000,
				},
			},
		};
		const world = makeWorld({
			runObservation: frozen,
			rules: [
				{ id: "rule-stale", metric: "ORIGIN_MANIFEST_STALE", threshold: null },
			],
		});
		await world.observer();
		expect(world.created).toHaveLength(1);
		expect(world.emitted[0]).toMatchObject({
			kind: "ALERT_OPENED",
			rule: "ORIGIN_MANIFEST_STALE",
			source: "BITOVP",
			subject: "DELIVERY",
		});
		// The partition, structurally: every rule query named an ORIGIN metric.
		for (const call of world.prisma.alertRule.findMany.mock.calls) {
			expect(String(call[0]?.where?.metric)).toMatch(/^ORIGIN_/);
		}
	});

	it("suppresses the stale alert while ingest is DISCONNECTED — INPUT_DISCONNECTED owns that failure", async () => {
		const frozen = {
			playlists: {
				"live-origin/video_800000.m3u8": {
					lastSegmentUri: "segment_2.m4s",
					segmentCount: 2,
					mediaSequence: 0,
					lastProgressAtMs: 1_000_000 - 120_000,
				},
			},
		};
		const world = makeWorld({
			runObservation: frozen,
			heartbeatIngest: "DISCONNECTED",
			rules: [
				{ id: "rule-stale", metric: "ORIGIN_MANIFEST_STALE", threshold: null },
			],
		});
		await world.observer();
		expect(world.created).toHaveLength(0);
	});

	it("ENDLIST in a RUNNING channel's media playlist opens its CRIT immediately", async () => {
		getObject.mockImplementation(async () =>
			streamOf(playlist(["segment_1.m4s"], { endlist: true })),
		);
		const world = makeWorld({
			rules: [
				{
					id: "rule-endlist",
					metric: "ORIGIN_ENDLIST_PRESENT",
					threshold: null,
				},
			],
		});
		await world.observer();
		expect(world.created).toHaveLength(1);
		expect(world.emitted[0]).toMatchObject({
			rule: "ORIGIN_ENDLIST_PRESENT",
		});
	});

	it("a FAILED read neither opens nor resolves — and the cursor survives the outage (review-161-162 M2)", async () => {
		getObject.mockImplementation(async () => {
			throw Object.assign(new Error("AccessDenied"), {
				$metadata: { httpStatusCode: 403 },
			});
		});
		const frozen = {
			playlists: {
				"live-origin/video_800000.m3u8": {
					lastSegmentUri: "segment_2.m4s",
					segmentCount: 2,
					mediaSequence: 0,
					lastProgressAtMs: 1_000_000 - 120_000,
				},
			},
		};
		const world = makeWorld({
			runObservation: frozen,
			rules: [
				{ id: "rule-stale", metric: "ORIGIN_MANIFEST_STALE", threshold: null },
			],
			openEvents: [{ id: "open-1", ruleId: "rule-stale" }],
		});
		await world.observer();
		// The open alert is UNTOUCHED (the first cut RESOLVED it — a rotated
		// credential made Slack say "resolved" while the origin stayed
		// frozen), and the cursor's progress epoch survives.
		expect(world.resolved).toEqual([]);
		expect(world.created).toHaveLength(0);
		const state = world.persisted.at(-1) as {
			playlists: Record<string, { lastProgressAtMs: number }>;
			unavailableReason?: string;
		};
		expect(
			state.playlists["live-origin/video_800000.m3u8"]?.lastProgressAtMs,
		).toBe(1_000_000 - 120_000);
		// And the reason is sanitized — a status class, never the raw driver
		// message (C20 / review-161-162 B1).
		expect(state.unavailableReason).toContain("playlist read failed");
		expect(state.unavailableReason).not.toContain("AccessDenied");
	});

	it("each edge-delay rule judges its OWN threshold (review-161-162 M3)", async () => {
		// Measured delay ≈ 36s (approximate path): WARN at 30 opens, the
		// channel-scoped CRIT at 300 does NOT — the first cut opened both on
		// the minimum threshold.
		const frozen = {
			playlists: {
				"live-origin/video_800000.m3u8": {
					lastSegmentUri: "segment_2.m4s",
					segmentCount: 2,
					mediaSequence: 0,
					lastProgressAtMs: 1_000_000 - 30_000,
				},
				"live-origin/audio_128000.m3u8": {
					lastSegmentUri: "segment_2.m4s",
					segmentCount: 2,
					mediaSequence: 0,
					lastProgressAtMs: 1_000_000 - 30_000,
				},
			},
		};
		const world = makeWorld({
			runObservation: frozen,
			rules: [
				{ id: "rule-warn", metric: "ORIGIN_EDGE_DELAY_ABOVE", threshold: 30 },
				{ id: "rule-crit", metric: "ORIGIN_EDGE_DELAY_ABOVE", threshold: 300 },
			],
		});
		await world.observer();
		expect(world.created).toHaveLength(1);
		expect((world.created[0] as { ruleId?: string }).ruleId).toBe("rule-warn");
	});

	it("a rule's OWN windowPolls damps the stale verdict (review-161-162 M4)", async () => {
		// since-progress ≈ 120s, interval 10s: windowPolls 2 breaches,
		// windowPolls 20 (200s window) does not — the first cut passed a
		// literal 2 for every rule while the settings panel offered the knob.
		const frozen = {
			playlists: {
				"live-origin/video_800000.m3u8": {
					lastSegmentUri: "segment_2.m4s",
					segmentCount: 2,
					mediaSequence: 0,
					lastProgressAtMs: 1_000_000 - 120_000,
				},
				"live-origin/audio_128000.m3u8": {
					lastSegmentUri: "segment_2.m4s",
					segmentCount: 2,
					mediaSequence: 0,
					lastProgressAtMs: 1_000_000 - 120_000,
				},
			},
		};
		const world = makeWorld({
			runObservation: frozen,
			rules: [
				{
					id: "rule-tight",
					metric: "ORIGIN_MANIFEST_STALE",
					threshold: null,
					windowPolls: 2,
				},
				{
					id: "rule-damped",
					metric: "ORIGIN_MANIFEST_STALE",
					threshold: null,
					windowPolls: 20,
				},
			],
		});
		await world.observer();
		expect(world.created).toHaveLength(1);
		expect((world.created[0] as { ruleId?: string }).ruleId).toBe("rule-tight");
	});

	it("resolves an open origin alert when progress returns", async () => {
		const world = makeWorld({
			rules: [
				{ id: "rule-stale", metric: "ORIGIN_MANIFEST_STALE", threshold: null },
			],
			openEvents: [{ id: "open-1", ruleId: "rule-stale" }],
		});
		await world.observer();
		expect(world.resolved).toEqual(["open-1"]);
		expect(world.emitted[0]).toMatchObject({ kind: "ALERT_RESOLVED" });
	});
});

describe("readBounded truncation (MODERATE-1, audit 2026-08-29 §9)", () => {
	it("exposes repeated legal over-cap reads and clears the signal on a complete read (#234)", async () => {
		const large = denseDvrPlaylist();
		expect(
			manifestElementEstimate({
				timeshiftSec: 10800,
				segmentLengthSec: 2,
				renditionCount: 2,
			}).level,
		).toBe("ok");
		expect(parseMediaPlaylist(large).segmentCount).toBe(5400);
		expect(Buffer.byteLength(large)).toBeGreaterThan(MAX_PLAYLIST_BYTES);
		let previous: unknown = null;
		for (let tick = 0; tick < 3; tick++) {
			getObject.mockImplementation(async () =>
				streamOf(tick < 2 ? large : playlist(["segment_12000.m4s"])),
			);
			const world = makeWorld({
				runObservation: previous,
				nowMs: 1_000_000 + tick * 20_000,
				rules: [
					{
						id: "rule-stale",
						metric: "ORIGIN_MANIFEST_STALE",
						threshold: null,
					},
				],
				openEvents: [{ id: "open-1", ruleId: "rule-stale" }],
			});
			await world.observer();
			previous = world.persisted.at(-1);
			expect(previous).toMatchObject(
				tick < 2
					? { playlistReadLimitReached: true, lastVerdicts: {} }
					: { lastVerdicts: expect.any(Object) },
			);
			if (tick === 2) {
				expect(previous).not.toHaveProperty("playlistReadLimitReached");
				expect(previous).not.toHaveProperty("unavailableReason");
				expect(
					Object.keys((previous as { lastVerdicts: object }).lastVerdicts),
				).toHaveLength(2);
			}
			if (tick < 2) {
				expect(world.created).toEqual([]);
				expect(world.resolved).toEqual([]);
			}
		}
		for (const [request] of getObject.mock.calls) {
			expect(request.range).toEqual({ start: 0, end: MAX_PLAYLIST_BYTES - 1 });
		}
	});

	it("retains the limit signal alongside a successfully observed child (#234)", async () => {
		getObject.mockImplementation(async ({ key }: { key: string }) =>
			streamOf(
				key.includes("video_") ? denseDvrPlaylist() : playlist(["audio_1.m4s"]),
			),
		);
		const world = makeWorld();
		await world.observer();
		expect(world.persisted.at(-1)).toMatchObject({
			playlistReadLimitReached: true,
		});
		expect(
			Object.keys(
				(world.persisted.at(-1) as { lastVerdicts: object }).lastVerdicts,
			),
		).toHaveLength(1);
	});

	it("does not lose the limit signal when earlier failures fill the reason summary (#234)", async () => {
		let calls = 0;
		getObject.mockImplementation(async () => {
			if (++calls <= 3) throw new Error("unavailable");
			return streamOf(denseDvrPlaylist());
		});
		const world = makeWorld({
			plan: {
				...PLAN,
				liveManifests: [
					PLAN.liveManifests[0],
					{
						...PLAN.liveManifests[0],
						key: "second",
						destination: { outputKey: "origin", path: "second" },
					},
				],
			},
		});
		await world.observer();
		const state = world.persisted.at(-1) as {
			unavailableReason: string;
			playlistReadLimitReached?: true;
		};
		expect(state.unavailableReason).toContain("+1 more");
		expect(state.unavailableReason).not.toContain(
			"PLAYLIST_TRUNCATED_AT_256KIB",
		);
		expect(state.playlistReadLimitReached).toBe(true);
	});

	it("a playlist read that OVERFLOWS the cap is UNOBSERVABLE — no verdict, no open, no resolve, the cursor survives (mirrors a failed read, review-161-162 M2)", async () => {
		getObject.mockImplementation(async () =>
			streamOf("x".repeat(MAX_PLAYLIST_BYTES + 10)),
		);
		const frozen = {
			playlists: {
				"live-origin/video_800000.m3u8": {
					lastSegmentUri: "segment_2.m4s",
					segmentCount: 2,
					mediaSequence: 0,
					lastProgressAtMs: 1_000_000 - 120_000,
				},
			},
		};
		const world = makeWorld({
			runObservation: frozen,
			rules: [
				{ id: "rule-stale", metric: "ORIGIN_MANIFEST_STALE", threshold: null },
				{
					id: "rule-endlist",
					metric: "ORIGIN_ENDLIST_PRESENT",
					threshold: null,
				},
			],
			openEvents: [{ id: "open-1", ruleId: "rule-stale" }],
		});
		await world.observer();
		// Neither opens (ENDLIST has no evidence) nor resolves (STALE has no
		// evidence) — a truncated read is not a verdict either way.
		expect(world.created).toHaveLength(0);
		expect(world.resolved).toEqual([]);
		const state = world.persisted.at(-1) as {
			playlists: Record<string, { lastProgressAtMs: number }>;
			lastVerdicts?: Record<string, unknown>;
			unavailableReason?: string;
		};
		expect(
			state.playlists["live-origin/video_800000.m3u8"]?.lastProgressAtMs,
		).toBe(1_000_000 - 120_000);
		expect(
			state.lastVerdicts?.["live-origin/video_800000.m3u8"],
		).toBeUndefined();
		expect(state.unavailableReason).toContain("truncated");
		expect(state.unavailableReason).toContain("PLAYLIST_TRUNCATED_AT_256KIB");
	});

	it("a playlist body of EXACTLY the cap is ALSO flagged truncated — a range read cannot prove completeness at the boundary", async () => {
		getObject.mockImplementation(async () =>
			streamOf("x".repeat(MAX_PLAYLIST_BYTES)),
		);
		const world = makeWorld();
		await world.observer();
		const state = world.persisted.at(-1) as {
			unavailableReason?: string;
			lastVerdicts?: Record<string, unknown>;
		};
		// Both media playlists in PLAN hit the same exact-cap stream — no
		// verdict was computed for either one.
		expect(state).toHaveProperty("playlistReadLimitReached", true);
		expect(state.unavailableReason).toContain("PLAYLIST_TRUNCATED_AT_256KIB");
		expect(state.lastVerdicts).toEqual({});
	});

	it("two chunks that sum to EXACTLY the cap are flagged truncated — the accumulation loop, not only the single-chunk arms (review-340 S1)", async () => {
		getObject.mockImplementation(async () =>
			streamOfChunks(["x".repeat(MAX_PLAYLIST_BYTES - 5), "x".repeat(5)]),
		);
		const world = makeWorld();
		await world.observer();
		const state = world.persisted.at(-1) as {
			unavailableReason?: string;
			lastVerdicts?: Record<string, unknown>;
		};
		expect(state.unavailableReason).toContain("PLAYLIST_TRUNCATED_AT_256KIB");
		expect(state.lastVerdicts).toEqual({});
	});

	it("two chunks that CROSS the cap are flagged truncated, and the overflow never reaches a parser", async () => {
		getObject.mockImplementation(async () =>
			streamOfChunks(["x".repeat(MAX_PLAYLIST_BYTES - 5), "x".repeat(50)]),
		);
		const world = makeWorld();
		await world.observer();
		const state = world.persisted.at(-1) as {
			unavailableReason?: string;
			lastVerdicts?: Record<string, unknown>;
		};
		expect(state.unavailableReason).toContain("PLAYLIST_TRUNCATED_AT_256KIB");
		expect(state.lastVerdicts).toEqual({});
	});

	it("two chunks UNDER the cap are joined in full — chunking alone is never a truncation", async () => {
		const body = playlist(["segment_1.m4s", "segment_2.m4s"]);
		const cut = Math.floor(body.length / 2);
		getObject.mockImplementation(async () =>
			streamOfChunks([body.slice(0, cut), body.slice(cut)]),
		);
		const world = makeWorld();
		await world.observer();
		const state = world.persisted.at(-1) as {
			unavailableReason?: string;
			lastVerdicts?: Record<string, unknown>;
		};
		expect(state.unavailableReason).toBeUndefined();
		expect(Object.keys(state.lastVerdicts ?? {})).toHaveLength(2);
	});

	it("a playlist body UNDER the cap is read in full — no truncation reason, verdicts computed normally", async () => {
		getObject.mockImplementation(async () =>
			streamOf(playlist(["segment_1.m4s", "segment_2.m4s"])),
		);
		const world = makeWorld();
		await world.observer();
		const state = world.persisted.at(-1) as {
			unavailableReason?: string;
			lastVerdicts?: Record<string, unknown>;
		};
		expect(state.unavailableReason).toBeUndefined();
		expect(Object.keys(state.lastVerdicts ?? {})).toHaveLength(2);
	});

	/**
	 * FIRST PUBLISH  — the fact `capture-vmaf` refuses on. The
	 * billed run of 2026-08-29 accepted a capture ~20 s after RUNNING and the
	 * job died with "no segments"; the encoder's first publish was at
	 * firstPublishMs 36 765. The route can only refuse that click if this
	 * sweep writes the state down, and it can only refuse it SAFELY if "we
	 * looked and there is nothing" is distinguishable from "we could not
	 * look" — which is what these seven arms hold apart.
	 */
	it("records PUBLISHED once a media playlist carries a segment", async () => {
		const world = makeWorld();
		await world.observer();
		expect((world.persisted.at(-1) as { publish?: string }).publish).toBe(
			"PUBLISHED",
		);
	});

	it("records AWAITING when the store has no playlist yet — the pre-first-publish state the capture route refuses on", async () => {
		getObject.mockImplementation(async () => {
			throw Object.assign(new Error("NoSuchKey"), {
				$metadata: { httpStatusCode: 404 },
			});
		});
		const world = makeWorld();
		await world.observer();
		const state = world.persisted.at(-1) as {
			publish?: string;
			playlists: Record<string, unknown>;
		};
		expect(state.publish).toBe("AWAITING");
		// And it is genuinely the empty-origin state, not a parse artefact.
		expect(Object.keys(state.playlists)).toHaveLength(0);
	});

	it("an EMPTY but PRESENT playlist is AWAITING — the pre-publish shape a 404 arm cannot reach (rev361 finding 1)", async () => {
		// The 404 arm above leaves `nextCursors` empty, so it holds only for
		// `nextCursors` being empty — `segmentCount > 0` and `segmentCount >= 0`
		// are indistinguishable over an empty set, and the `>= 0` mutant
		// survived the whole suite. This is also the MORE realistic pre-publish
		// shape: the encoder writes the media playlist at start and fills it in
		// progressively, so the object exists with zero EXTINF entries long
		// before the first segment lands.
		getObject.mockImplementation(async () => streamOf(playlist([])));
		const world = makeWorld();
		await world.observer();
		const state = world.persisted.at(-1) as {
			publish?: string;
			playlists: Record<string, { segmentCount: number }>;
		};
		// A cursor per playlist — the read SUCCEEDED — and every one of them
		// carries zero segments. Presence is not publication.
		expect(Object.keys(state.playlists)).toHaveLength(2);
		expect(Object.values(state.playlists).map((c) => c.segmentCount)).toEqual([
			0, 0,
		]);
		expect(state.publish).toBe("AWAITING");
	});

	it("the next tick that finds segments flips AWAITING to PUBLISHED — the state is not a one-way latch into refusal", async () => {
		const world = makeWorld({
			runObservation: { publish: "AWAITING", playlists: {} },
		});
		await world.observer();
		expect((world.persisted.at(-1) as { publish?: string }).publish).toBe(
			"PUBLISHED",
		);
	});

	it("PUBLISHED survives a tick whose every read fails — a rotated credential must not un-publish a run that went on air", async () => {
		getObject.mockImplementation(async () => {
			throw Object.assign(new Error("AccessDenied"), {
				$metadata: { httpStatusCode: 403 },
			});
		});
		const world = makeWorld({ runObservation: { publish: "PUBLISHED" } });
		await world.observer();
		expect((world.persisted.at(-1) as { publish?: string }).publish).toBe(
			"PUBLISHED",
		);
	});

	it("PUBLISHED survives an UNAVAILABLE tick — an underivable run prefix (#155) never reaches a playlist at all", async () => {
		const world = makeWorld({
			outputPrefix: "live-origin/runs/002-run1",
			runObservation: { publish: "PUBLISHED" },
		});
		await world.observer();
		const state = world.persisted.at(-1) as {
			publish?: string;
			unavailableReason?: string;
		};
		expect(state.unavailableReason).toContain("underivable");
		expect(state.publish).toBe("PUBLISHED");
	});

	it("PUBLISHED survives a DASH-only channel — the observer is HLS-only, and its blind spot is not a retraction", async () => {
		const world = makeWorld({
			plan: {
				...PLAN,
				liveManifests: [
					{
						key: "dash",
						kind: "DASH",
						manifestName: "stream.mpd",
						name: "DASH",
						destination: { outputKey: "origin", path: "live-origin" },
					},
				],
			},
			runObservation: { publish: "PUBLISHED" },
		});
		await world.observer();
		const state = world.persisted.at(-1) as {
			publish?: string;
			unavailableReason?: string;
		};
		expect(state.unavailableReason).toContain("no HLS media playlists");
		expect(state.publish).toBe("PUBLISHED");
	});

	it("AWAITING does NOT survive a tick that could not ask — evidence of absence expires, so a blind observer never locks the capture out", async () => {
		// The asymmetry, stated as a test: PUBLISHED is a fact about the run's
		// history and is sticky; AWAITING is a claim about right now, and a
		// tick that never reached the store has no claim to make. Carrying it
		// would 409 this channel's captures for as long as the observer stays
		// blind.
		const world = makeWorld({
			outputPrefix: "live-origin/runs/002-run1",
			runObservation: { publish: "AWAITING" },
		});
		await world.observer();
		expect(
			(world.persisted.at(-1) as { publish?: string }).publish,
		).toBeUndefined();
	});

	it("a TRUNCATED playlist is indeterminate about first publish — never AWAITING", async () => {
		// A body at the 256 KiB cap has thousands of segments, and the
		// truncation branch deliberately produces no cursor. Counting that as
		// "we asked and saw nothing" would report AWAITING for an hours-old
		// channel the observer is meeting for the first time — and refuse its
		// captures for as long as the playlist stays that big.
		getObject.mockImplementation(async () =>
			streamOf("#EXTM3U\n".padEnd(MAX_PLAYLIST_BYTES + 4_096, "x")),
		);
		const world = makeWorld();
		await world.observer();
		const state = world.persisted.at(-1) as {
			publish?: string;
			unavailableReason?: string;
		};
		expect(state.unavailableReason).toContain("PLAYLIST_TRUNCATED");
		expect(state.publish).toBeUndefined();
	});
});

describe("sweep — every RUNNING channel, keyset-paged and tick-bounded (ledger #213, review-331)", () => {
	type FindManyArgs = {
		where: { status: string; purpose: null; id?: { gt?: string } };
		skip?: number;
		take?: number;
	};
	/**
	 * A fake with the REAL query's semantics — `where.id.gt` (keyset) AND
	 * `skip` (offset) are both honoured — so a sweep written either way is
	 * simulated faithfully, and only the keyset one survives the churn arm.
	 */
	function fleet(ids: string[], onPage?: (page: number) => void) {
		const running = new Set(ids);
		let page = 0;
		const findMany = vi.fn(async ({ where, skip, take }: FindManyArgs) => {
			const after = where.id?.gt;
			const rows = [...running]
				.sort()
				.filter((id) => !after || id > after)
				.slice(skip ?? 0, (skip ?? 0) + (take ?? Number.MAX_SAFE_INTEGER))
				.map((id) => ({ id, plan: null, lastHeartbeat: null }));
			onPage?.(page);
			page += 1;
			return rows;
		});
		const observer = createOriginObserver({
			prisma: {
				liveChannel: { findMany },
				liveChannelRun: {
					findFirst: async () => null,
					findMany: async () => [],
				},
				alertRule: { findMany: async () => [] },
				alertEvent: {
					findMany: async () => [],
					create: async () => ({}),
					updateMany: async () => ({ count: 0 }),
				},
			} as never,
			resolveCredential: async () => {
				throw new Error("no credential in this test");
			},
		} as never);
		return { running, findMany, observer };
	}
	const ids = (n: number) =>
		Array.from({ length: n }, (_, i) => `c${String(i).padStart(4, "0")}`);
	const returnedIds = (findMany: ReturnType<typeof vi.fn>) =>
		Promise.all(
			findMany.mock.results.map((r) => r.value as Promise<{ id: string }[]>),
		).then((pages) => pages.flat().map((row) => row.id));

	it("reads past the first fifty by keyset — never by offset — and reports the whole population", async () => {
		const f = fleet(ids(120));
		const result = await f.observer();
		expect(f.findMany).toHaveBeenCalledTimes(3);
		expect(f.findMany.mock.calls.map((c) => c[0].where.id?.gt)).toEqual([
			undefined,
			"c0049",
			"c0099",
		]);
		for (const call of f.findMany.mock.calls) {
			expect(call[0]).toMatchObject({
				where: { status: "RUNNING", purpose: null },
				take: 50,
				orderBy: { id: "asc" },
			});
			expect(call[0].skip).toBeUndefined();
		}
		// Observation is attempted for every channel; with no run rows each
		// returns cleanly, so nothing fails — the count is the population.
		expect(result.total).toBe(120);
		expect(result.observed + result.failed).toBe(120);
		expect(result.resumeAfter).toBeUndefined();
	});

	it("a channel that stops between two pages shifts nothing — the audited 51st-channel gap cannot recur", async () => {
		// After page 1 is read, c0010 stops. Offset paging would then `skip: 50`
		// over a set one shorter and never return c0050; keyset paging starts
		// page 2 after c0049 regardless.
		let f: ReturnType<typeof fleet> | undefined;
		f = fleet(ids(120), (page) => {
			if (page === 0) {
				f?.running.delete("c0010");
			}
		});
		const result = await f.observer();
		const seen = await returnedIds(f.findMany);
		// c0050 is the channel offset paging skips; c0010 was observed on page 1
		// BEFORE it stopped, so every one of the 120 is seen exactly once.
		expect(seen).toContain("c0050");
		expect(new Set(seen).size).toBe(120);
		expect(seen).toHaveLength(120);
		expect(result.total).toBe(120);
	});

	it("bounds a tick to ten pages, resumes from the last id next tick, then starts over", async () => {
		const f = fleet(ids(620));
		const first = await f.observer();
		expect(f.findMany).toHaveBeenCalledTimes(10);
		expect(first.total).toBe(500);
		expect(first.resumeAfter).toBe("c0499");
		const second = await f.observer();
		expect(f.findMany).toHaveBeenCalledTimes(13);
		expect(f.findMany.mock.calls[10]?.[0].where.id?.gt).toBe("c0499");
		expect(second.total).toBe(120);
		expect(second.resumeAfter).toBeUndefined();
		const third = await f.observer();
		expect(f.findMany.mock.calls[13]?.[0].where.id?.gt).toBeUndefined();
		expect(third.total).toBe(500);
		expect(new Set(await returnedIds(f.findMany)).size).toBe(620);
	});
});
