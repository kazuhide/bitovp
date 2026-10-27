import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	compileExpectedLiveArtefacts,
	liveChannelPlanSchema,
	validateLiveChannel,
} from "@bitovp/core";
import { describe, expect, it, vi } from "vitest";
import type { IntentHandle, IntentResolution } from "./resource-intent";
import {
	canaryCompletionError,
	createPostCreateResponseLossCanary,
} from "./response-loss-canary";
import {
	collectEdgeClosures,
	collectVodClosures,
	firstVariantUri,
	type LiveIntentHooks,
	type LiveRunnerDeps,
	prepareLiveScenarioForRun,
	readLivePlaylist,
	rewriteLiveForRun,
	runLiveScenario,
	teardownAdoptedChannel,
} from "./runner-live";

/**
 * The live runner, driven without a live channel.
 *
 * Every side effect is injected, so this exercises the whole loop — create, start, await
 * RUNNING, feed, sample twice, stop, roll to VOD, verify — against a fake product. That
 * matters more here than on the VOD side: a real live run costs minutes of encoder time
 * per scenario, so a defect that only shows up at step six is expensive to find twice.
 *
 * The scripted product below is deliberately a state machine rather than a set of canned
 * replies: the runner's correctness is mostly about ORDER (you cannot feed a channel that
 * is not RUNNING, you cannot roll one that was not stopped), and canned replies cannot
 * express order.
 */

const FIXTURES = join(
	import.meta.dirname,
	"../../../../packages/core/src/live/__fixtures__",
);
const ROLL_ATTEMPT_ID = "33333333-3333-4333-8333-333333333333";
const ROLL_RUN_ID = "55555555-5555-4555-8555-555555555555";

function plan(name: string): unknown {
	return JSON.parse(readFileSync(join(FIXTURES, `${name}.plan.json`), "utf8"));
}

/** A product that behaves: the channel starts, feeds, stops and rolls. */
function fakeProduct(
	opts: {
		/** Status sequence the channel reports on successive polls. */
		statuses?: string[];
		/** Refuse the feeder session with this status. */
		feederStatus?: number;
		/** Live-to-VOD terminal status. */
		liveToVod?: string;
		/** Omit the stream key, as a broken provisioning would. */
		noStreamKey?: boolean;
		/** Omit the provider encoding id, which must block an intent closure. */
		noProviderId?: boolean;
		/**
		 * Override the heartbeats body, to exercise an unrecognised shape.
		 *
		 * The real one is `{windowMinutes, points:[…]}`; this exists so a body carrying NEITHER
		 * `points` nor `items` can be tested, which is the case that used to vanish into
		 * `undefined`.
		 */
		heartbeatBody?: Record<string, unknown>;
		/** What the channel reports after a stop was acknowledged (default STOPPED). */
		stoppedStatus?: string;
		/** Response for repeated channel stop; 409 models already stopped. */
		channelStopStatus?: number;
		/** Refuse the live-to-VOD roll with this HTTP status. */
		rollStatus?: number;
		/** Make the live-to-VOD request itself throw (a network fault). */
		rollThrows?: string;
		/**
		 * Cleanup-seal knobs. Defaults model
		 * a CLEAN teardown so a healthy run seals clean; each override models one
		 * unproven element.
		 */
		/** The channel `error` after stop (the worker's stop-confirmation word). */
		channelStopError?: string;
		/** false ⇒ the fed feeder's `processGoneAt` never stamps (pushed, unproven gone). */
		feederProcessGone?: boolean;
		/**
		 * The feeder is proven gone only from the Nth cleanup read on — models a
		 * kill ladder that stamps `processGoneAt` shortly AFTER the channel
		 * stopped, so the seal poll must resume a partial teardown to complete.
		 */
		feederGoneAfterReads?: number;
		/** A non-null pid the fed feeder still holds after stop (host process alive). */
		feederPid?: number;
		/** The feeder queue still holds a pending job for the fed feeder. */
		feederQueued?: boolean;
		/** false models a feeder detail whose exact source seal never landed. */
		sourceSeal?: boolean;
		/** Override the exact terminal record exposed after the roll. */
		vodRecord?: Record<string, unknown>;
	} = {},
) {
	const statuses = opts.statuses ?? ["CREATED", "STARTING", "RUNNING"];
	let stopped = false;
	let poll = 0;
	let mediaSequence = 10;
	const calls: string[] = [];
	const liveToVodRequests: unknown[] = [];
	let clock = 1_760_000_000_000;
	// Row 268: the fed feeder's id, set when the feeder POST succeeds, so the
	// `?queue=1` list reports exactly the session(s) the run created.
	let feederId: string | undefined;
	let submittedPlan: Record<string, unknown> | undefined;
	// How many times the cleanup seal has read the feeder list — drives the
	// resume knob (`feederGoneAfterReads`).
	let feederListReads = 0;
	const feederProven = (): boolean => {
		if (opts.feederProcessGone === false) {
			return false;
		}
		if (opts.feederGoneAfterReads != null) {
			return feederListReads >= opts.feederGoneAfterReads;
		}
		return true;
	};
	const feederRow = () => ({
		id: feederId,
		status: "STOPPED",
		pid: opts.feederPid ?? null,
		// A proven-gone stamp by default; the feeder's kill ladder ran.
		processGoneAt: feederProven() ? new Date(clock).toISOString() : null,
		// It pushed, so it engaged a process — which is why a missing
		// processGoneAt is a hole rather than "never ran".
		startedAt: new Date(clock).toISOString(),
		queued: opts.feederQueued ?? false,
	});

	const deps: LiveRunnerDeps = {
		api: async (path, init) => {
			const method = init?.method ?? "GET";
			calls.push(`${method} ${path.replace(/[0-9a-f-]{36}/, "<id>")}`);
			if (method === "POST" && path === "/api/live-channels") {
				submittedPlan = (
					init?.body as { plan?: Record<string, unknown> } | undefined
				)?.plan;
				return {
					status: 201,
					json: { id: "11111111-1111-4111-8111-111111111111" },
				};
			}
			if (path.endsWith("/heartbeats")) {
				/**
				 * `points`, the shape the ROUTE actually returns.
				 *
				 * The fake used to answer `{ items: [...] }` — mirroring the sampler's bug rather
				 * than the product — so `live:heartbeat` was green here and SKIPped on every real
				 * run with "the heartbeat series could not be read". A fake that agrees with the
				 * code instead of with the product is worse than no fake: it certifies the mistake.
				 *
				 * Verified against the running route:
				 * `{"windowMinutes":120,"points":[{"at":…,"ingestStatus":"CONNECTED",…}]}`.
				 */
				if (opts.heartbeatBody) {
					return { status: 200, json: opts.heartbeatBody };
				}
				return {
					status: 200,
					json: {
						windowMinutes: 120,
						points: Array.from({ length: poll + 1 }, (_, i) => ({
							at: new Date(1_760_000_000_000 + i * 30_000).toISOString(),
							ingestStatus: "CONNECTED",
							droppedPacketsVideo: 0,
							droppedPacketsAudio: 0,
						})),
					},
				};
			}
			if (path === "/api/feeder-sessions") {
				if (opts.feederStatus) {
					return { status: opts.feederStatus, json: {} };
				}
				feederId = "22222222-2222-4222-8222-222222222222";
				return { status: 201, json: { id: feederId } };
			}
			// Row 268: the cleanup seal's feeder read — `?queue=1` list scoped to
			// the channel. Reports the fed session with its process/queue state;
			// empty when the run created no feeder (refused, or non-feedable).
			if (method === "GET" && path.startsWith("/api/feeder-sessions?")) {
				feederListReads += 1;
				return {
					status: 200,
					json: { items: feederId ? [feederRow()] : [] },
				};
			}
			if (
				method === "GET" &&
				feederId !== undefined &&
				path === `/api/feeder-sessions/${feederId}`
			) {
				return {
					status: 200,
					json: {
						...feederRow(),
						...(opts.sourceSeal === false
							? {}
							: {
									sourceEtag: '"source-etag"',
									sourceVersionId: "source-v1",
									sourceGeneration: null,
									sourceSize: "42",
									sourceSha256: "a".repeat(64),
								}),
					},
				};
			}
			if (method === "POST") {
				if (path.endsWith("/live-to-vod")) {
					liveToVodRequests.push(init?.body);
				}
				if (path.endsWith("/live-to-vod") && opts.rollThrows) {
					return Promise.reject(new Error(opts.rollThrows));
				}
				if (path.endsWith("/live-to-vod") && opts.rollStatus) {
					return { status: opts.rollStatus, json: {} };
				}
				if (path.endsWith("/live-to-vod")) {
					return {
						status: 202,
						json: {
							attemptId: ROLL_ATTEMPT_ID,
							liveChannelRunId: ROLL_RUN_ID,
						},
					};
				}
				if (
					path.startsWith("/api/live-channels/") &&
					path.endsWith("/actions") &&
					(init?.body as { action?: string } | undefined)?.action === "stop"
				) {
					stopped = true;
					if (opts.channelStopStatus !== undefined) {
						return { status: opts.channelStopStatus, json: {} };
					}
				}
				return { status: 202, json: {} };
			}
			// GET the channel: walk the status list, then stay at the last — and,
			// once a stop was acknowledged, report what the product would
			// (STOPPED after the worker confirms; a test can pin it elsewhere).
			const status = stopped
				? (opts.stoppedStatus ?? "STOPPED")
				: statuses[Math.min(poll, statuses.length - 1)];
			poll += 1;
			return {
				status: 200,
				json: {
					status,
					// Row 268: the worker's stop-confirmation word. Null before a
					// stop and on a confirmed-clean stop; a message when a stop did
					// not confirm (an encoding not seen terminal, or — this change —
					// a feeder stop that could not be enqueued).
					error: stopped ? (opts.channelStopError ?? null) : null,
					// The airing and the provider encoding the evidence tuple binds
					// to — the detail route's shape: the
					// channel columns dual-written, `currentRun` canonical.
					currentRun: {
						id: "run-1",
						status,
						error: stopped ? (opts.channelStopError ?? null) : null,
						bitmovinEncodingId: opts.noProviderId ? null : "enc-live-1",
						// The airing's start, as the detail route projects it — the
						// freshness reference for every edge object (WP-C6b). The
						// harness clock starts at 0, so the epoch is "when RUNNING
						// began" in this fake world.
						runningSince: new Date(0).toISOString(),
						stepLog: [
							...(
								(submittedPlan?.renditions ?? []) as { key?: string }[]
							).flatMap((rendition) =>
								rendition.key
									? [
											{
												step: `stream:${rendition.key}`,
												resourceId: `provider-stream-${rendition.key}`,
											},
										]
									: [],
							),
							...((submittedPlan?.outputs ?? []) as { key?: string }[]).flatMap(
								(output) =>
									output.key
										? [
												{
													step: `output:${output.key}`,
													resourceId: `provider-output-${output.key}`,
												},
											]
										: [],
							),
						],
					},
					...(opts.noStreamKey ? {} : { streamKey: "sk-live" }),
					...(opts.noProviderId ? {} : { bitmovinEncodingId: "enc-live-1" }),
					encoderIp: "10.1.2.3",
					liveToVod: {
						status: opts.liveToVod ?? "FINISHED",
						attemptId: ROLL_ATTEMPT_ID,
						liveChannelRunId: ROLL_RUN_ID,
						outputKey: "origin",
						manifests: [
							{
								type: "HLS",
								manifestId: "vod-hls",
								url: "archive/exact/vod.m3u8",
							},
							{
								type: "DASH",
								manifestId: "vod-dash",
								url: "archive/exact/vod.mpd",
							},
						],
						families: [
							{
								type: "HLS",
								status: "FINISHED",
								manifestId: "vod-hls",
								url: "archive/exact/vod.m3u8",
							},
							{
								type: "DASH",
								status: "FINISHED",
								manifestId: "vod-dash",
								url: "archive/exact/vod.mpd",
							},
						],
						...(opts.vodRecord ?? {}),
					},
				},
			};
		},
		/**
		 * KEY-ADDRESSED, and it throws on anything it does not recognise.
		 *
		 * The first version took no arguments, so the key was never checked — which is why
		 * reverting the trailing-slash fix and the master-vs-media fix both left this suite
		 * green. A reviewer diagnosed exactly that; I fixed only half of it (`listAll`) and my
		 * own mutation run found the other half.
		 *
		 * A MEDIA playlist for a media key, a MASTER for the master key, the ROLLED playlist
		 * under `/vod/`, and a throw otherwise — the shape the VOD harness already uses. A
		 * fake that answers every question the same way cannot pin which question was asked.
		 */
		readText: async (_outputKey: string, key: string) => {
			if (key === "archive/exact/vod.m3u8") {
				return [
					"#EXTM3U",
					'#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="en",URI="audio_128000.m3u8"',
					'#EXT-X-STREAM-INF:BANDWIDTH=4500000,AUDIO="audio"',
					"video_4500000.m3u8",
				].join("\n");
			}
			if (/^archive\/exact\/(video_4500000|audio_128000)\.m3u8$/.test(key)) {
				const stem = key.includes("audio") ? "audio" : "video";
				return [
					"#EXTM3U",
					"#EXT-X-VERSION:7",
					`#EXT-X-MAP:URI="${stem}_init.mp4"`,
					...Array.from({ length: 5 }, (_, i) => [
						"#EXTINF:6.0,",
						`${stem}_${i + 1}.m4s`,
					]).flat(),
					"#EXT-X-ENDLIST",
				].join("\n");
			}
			if (key === "archive/exact/vod.mpd") {
				return [
					'<?xml version="1.0"?>',
					'<MPD mediaPresentationDuration="PT30S" type="static"><Period>',
					'<AdaptationSet mimeType="video/mp4"><Representation id="v1" bandwidth="1000000" height="720"><SegmentList duration="6"><Initialization sourceURL="dash_video_init.mp4"/><SegmentURL media="dash_video_1.m4s"/><SegmentURL media="dash_video_2.m4s"/></SegmentList></Representation></AdaptationSet>',
					'<AdaptationSet mimeType="audio/mp4"><Representation id="a1" bandwidth="128000"><SegmentList duration="6"><Initialization sourceURL="dash_audio_init.mp4"/><SegmentURL media="dash_audio_1.m4s"/><SegmentURL media="dash_audio_2.m4s"/></SegmentList></Representation></AdaptationSet>',
					"</Period></MPD>",
				].join("\n");
			}
			if (/^archive\/exact\/(video|audio|dash_).+\.(m4s|mp4)$/.test(key)) {
				return "nonempty-media";
			}
			/**
			 * Key-addressed on the FILENAME, not just the directory.
			 *
			 * This matched any `*.m3u8` under `/vod/` and answered with media-playlist
			 * content — including for `stream.m3u8`, which is the rolled MASTER. So it
			 * answered a master key with something the product will never put there, and
			 * that is why reverting the filename half of the fix left the suite green.
			 * Same guessed-world shape as before, one level down (review catch).
			 */
			if (/\/vod\/stream\.m3u8$/.test(key)) {
				// The rolled MASTER: variants only, and none of what a media playlist carries.
				return [
					"#EXTM3U",
					"#EXT-X-VERSION:4",
					"#EXT-X-STREAM-INF:BANDWIDTH=4500000,RESOLUTION=1920x1080",
					"video_4500000.m3u8",
				].join("\n");
			}
			// ONLY the variant its own master lists. Answering any name meant a hardcoded
			// guess in place of `firstVariantUri` also passed — a fake must not know objects
			// its own manifest does not reference.
			if (/\/vod\/video_4500000\.m3u8$/.test(key)) {
				return [
					"#EXTM3U",
					"#EXT-X-VERSION:4",
					"#EXT-X-MEDIA-SEQUENCE:0",
					...Array.from({ length: 5 }, (_, i) => [
						"#EXTINF:6.0,",
						`segment_${i + 1}.m4s`,
					]).flat(),
					"#EXT-X-ENDLIST",
				].join("\n");
			}
			/**
			 * The live MPD, because the engine now verifies it.
			 *
			 * The fake had no `.mpd` at all, and the new `live:manifest:dash` check found that
			 * immediately — which is the fake doing its job: it is key-addressed and refuses
			 * anything its own manifests never named. Four representations, matching the fixture's
			 * four muxing legs, so the entry-count bound is exercised rather than trivially met.
			 */
			if (/\/stream\.mpd$/.test(key)) {
				return [
					'<?xml version="1.0"?>',
					'<MPD mediaPresentationDuration="PT30S" type="dynamic"><Period>',
					// The compiler's real shape : ONE video AdaptationSet
					// holding the ladder, one audio set — the fake used to write a set
					// per representation, which no count-based check could see.
					'  <AdaptationSet mimeType="video/mp4">',
					...Array.from(
						{ length: 3 },
						(_, i) =>
							`    <Representation id="v${i}" height="${[1080, 720, 360][i]}" codecs="avc1.640028"><SegmentTemplate media="$Number$.m4s"/></Representation>`,
					),
					"  </AdaptationSet>",
					'  <AdaptationSet mimeType="audio/mp4"><Representation id="a128" codecs="mp4a.40.2"><SegmentTemplate media="$Number$.m4s"/></Representation></AdaptationSet>',
					"</Period></MPD>",
				].join("\n");
			}
			if (/\/stream\.m3u8$/.test(key)) {
				// A master: variants, and none of what a media playlist carries.
				return [
					"#EXTM3U",
					"#EXT-X-VERSION:4",
					"#EXT-X-STREAM-INF:BANDWIDTH=4500000",
					"video_4500000.m3u8",
				].join("\n");
			}
			// The LIVE media playlists, by the exact names `liveHlsEntryUri` derives from the
			// fixture — not any `video_N`. A regex that accepted any digits let a hardcoded
			// guess stand in for `firstVariantUri` and still pass: the fake knew an object its
			// own manifest never referenced. A bucket does not work that way.
			if (!/\/(video_(4500000|3000000|800000)|audio_128000)\.m3u8$/.test(key)) {
				throw new Error(
					`the fake bucket has no object at ${key} — a malformed key is silently caught in production, so it must be loud here`,
				);
			}
			mediaSequence += 2;
			return [
				"#EXTM3U",
				"#EXT-X-VERSION:4",
				`#EXT-X-MEDIA-SEQUENCE:${mediaSequence}`,
				...Array.from({ length: 5 }, (_, i) => [
					"#EXTINF:6.0,",
					`segment_${i + 1}.m4s`,
				]).flat(),
				"#EXT-X-ENDLIST",
			].join("\n");
		},
		/**
		 * Segments under the prefix ASKED FOR, derived from the request rather than invented.
		 *
		 * The first version returned `out/segment_N.m4s` regardless of the prefix, which is
		 * the guessed-world mistake: `live:ladder` checks each muxing's own prefix, so a fake
		 * that answers with keys belonging to nowhere fails a correct runner. Echoing the
		 * requested prefix is both simpler and the only thing a real bucket could do.
		 */
		listAll: async (_outputKey: string, prefix: string) => [
			{ key: `${prefix}init.mp4`, size: 900 },
			...Array.from({ length: 2 + poll }, (_, i) => ({
				key: `${prefix}segment_${i + 1}.m4s`,
				size: 500_000,
			})),
		],
		// Virtual time: the runner's sleeps advance the clock rather than the wall.
		sleep: async (ms) => {
			clock += ms;
		},
		now: () => clock,
	};
	return { deps, calls, liveToVodRequests };
}

const REWRITE = {
	bitmovinAccountId: "44444444-4444-4444-8444-444444444444",
	credentialId: "33333333-3333-4333-8333-333333333333",
	outputBucket: "verify-out",
	prefix: "verify/RUN1/scenario/",
};

const FEED = {
	credentialId: "33333333-3333-4333-8333-333333333333",
	bucket: "verify-in",
	key: "bbb-short.mov",
};

describe("readLivePlaylist", () => {
	it("reads the media sequence and counts segments", () => {
		const out = readLivePlaylist(
			"#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:41\n#EXTINF:6.0,\na.m4s\n#EXTINF:6.0,\nb.m4s\n",
		);
		expect(out).toEqual({ mediaSequence: 41, segments: 2 });
	});

	it("returns undefined rather than zero for a sequence it cannot find", () => {
		// A missing sequence number and a sequence number of zero are different facts, and
		// the engine's SKIP arm depends on telling them apart.
		expect(readLivePlaylist("#EXTM3U\n").mediaSequence).toBeUndefined();
	});

	it("does not mistake a master playlist's variants for segments", () => {
		const master =
			"#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nv0.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=2\nv1.m3u8\n";
		expect(readLivePlaylist(master).segments).toBeUndefined();
	});
});

describe("terminal live-to-VOD closure", () => {
	const terminal = {
		status: "FINISHED",
		outputKey: "origin",
		manifests: [
			{ type: "HLS", manifestId: "vod-hls", url: "archive/exact/vod.m3u8" },
			{ type: "DASH", manifestId: "vod-dash", url: "archive/exact/vod.mpd" },
		],
	};

	it("starts at exact terminal manifests[].url and closes every HLS video/audio playlist and referenced media", async () => {
		const { deps } = fakeProduct();
		const reads: string[] = [];
		const result = await collectVodClosures(
			{
				...deps,
				readText: async (outputKey, key) => {
					reads.push(key);
					return deps.readText(outputKey, key);
				},
			},
			terminal,
		);
		const hls = result.closures.find((closure) => closure.type === "HLS");
		expect(hls).toMatchObject({
			url: "archive/exact/vod.m3u8",
			closed: true,
			childCount: 2,
			segmentCount: 12,
			endlist: true,
		});
		expect(reads).toContain("archive/exact/audio_128000.m3u8");
		expect(reads).toContain("archive/exact/audio_5.m4s");
		expect(reads).toContain("archive/exact/video_5.m4s");
		expect(reads.some((key) => key.includes("live-rtmp-simple/vod"))).toBe(
			false,
		);
	});

	it("fails HLS when any audio segment is empty/missing or any child lacks ENDLIST", async () => {
		const { deps } = fakeProduct();
		const hls = terminal.manifests.find((manifest) => manifest.type === "HLS");
		if (!hls) throw new Error("terminal fixture is missing HLS");
		const result = await collectVodClosures(
			{
				...deps,
				readText: async (outputKey, key) => {
					if (key === "archive/exact/audio_5.m4s") {
						throw new Error("NoSuchKey");
					}
					const text = await deps.readText(outputKey, key);
					return key === "archive/exact/audio_128000.m3u8"
						? text.replace("#EXT-X-ENDLIST", "")
						: text;
				},
			},
			{ ...terminal, manifests: [hls] },
		);
		expect(result.closures[0]).toMatchObject({
			closed: false,
			endlist: false,
			missing: [expect.stringContaining("audio_5.m4s")],
		});
	});

	it("parses DASH and reads every resolved init/media reference, failing one missing object", async () => {
		const { deps } = fakeProduct();
		const dash = terminal.manifests.find(
			(manifest) => manifest.type === "DASH",
		);
		if (!dash) throw new Error("terminal fixture is missing DASH");
		const reads: string[] = [];
		const result = await collectVodClosures(
			{
				...deps,
				readText: async (outputKey, key) => {
					reads.push(key);
					if (key === "archive/exact/dash_audio_2.m4s") {
						throw new Error("404");
					}
					return deps.readText(outputKey, key);
				},
			},
			{ ...terminal, manifests: [dash] },
		);
		expect(result.closures[0]).toMatchObject({
			type: "DASH",
			closed: false,
			childCount: 2,
			segmentCount: 6,
			missing: [expect.stringContaining("dash_audio_2.m4s")],
		});
		for (const key of [
			"dash_video_init.mp4",
			"dash_video_1.m4s",
			"dash_video_2.m4s",
			"dash_audio_init.mp4",
			"dash_audio_1.m4s",
			"dash_audio_2.m4s",
		]) {
			expect(reads).toContain(`archive/exact/${key}`);
		}
	});

	it("does not call an explicitly dynamic DASH MPD a closed VOD asset", async () => {
		const { deps } = fakeProduct();
		const dash = terminal.manifests.find(
			(manifest) => manifest.type === "DASH",
		);
		if (!dash) throw new Error("terminal fixture is missing DASH");
		// SegmentList keeps every referenced object independently resolvable even
		// on a dynamic MPD. Without the explicit presentation-type guard this
		// fixture would therefore close green on init + both media segments.
		const dynamicMpd = `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="dynamic" minBufferTime="PT1S" minimumUpdatePeriod="PT5S" availabilityStartTime="2026-08-31T00:00:00Z">
  <Period start="PT0S">
    <AdaptationSet contentType="video" mimeType="video/mp4">
      <Representation id="v1" bandwidth="1000000" codecs="avc1.4d401f" width="1280" height="720">
        <SegmentList timescale="1" duration="4">
          <Initialization sourceURL="dash_video_init.mp4" />
          <SegmentURL media="dash_video_1.m4s" />
          <SegmentURL media="dash_video_2.m4s" />
        </SegmentList>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`;
		const result = await collectVodClosures(
			{
				...deps,
				readText: async (outputKey, key) => {
					return key === "archive/exact/vod.mpd"
						? dynamicMpd
						: deps.readText(outputKey, key);
				},
			},
			{ ...terminal, manifests: [dash] },
		);

		expect(result.closures[0]).toMatchObject({
			type: "DASH",
			closed: false,
			segmentCount: 3,
			missing: expect.arrayContaining([expect.stringContaining("dynamic")]),
		});
	});

	it("fails closed on invalid or duplicate terminal manifests instead of dropping them", async () => {
		const { deps } = fakeProduct();
		const result = await collectVodClosures(deps, {
			status: "FINISHED",
			outputKey: "origin",
			manifests: [
				terminal.manifests[0],
				null,
				{
					type: "HLS",
					manifestId: "different-id",
					url: "archive/exact/vod.m3u8",
				},
			],
		});
		expect(result.closures).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "UNKNOWN",
					closed: false,
					error: expect.stringContaining("invalid identity"),
				}),
				expect.objectContaining({
					type: "HLS",
					closed: false,
					error: expect.stringContaining("duplicate terminal HLS"),
				}),
			]),
		);
		expect(result.readError).toMatch(/closure\(s\) failed/);
	});

	it("fails when a FINISHED family is absent from manifests[]", async () => {
		const { deps } = fakeProduct();
		const hls = terminal.manifests.find((manifest) => manifest.type === "HLS");
		const dash = terminal.manifests.find(
			(manifest) => manifest.type === "DASH",
		);
		if (!hls || !dash) throw new Error("terminal fixture is incomplete");
		const result = await collectVodClosures(deps, {
			status: "FINISHED",
			outputKey: "origin",
			manifests: [hls],
			families: [
				{ ...hls, status: "FINISHED" },
				{ ...dash, status: "FINISHED" },
			],
		});
		expect(result.closures).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "DASH",
					closed: false,
					error: expect.stringContaining("missing from terminal manifests[]"),
				}),
			]),
		);
	});
});

describe("runLiveScenario — the happy path", () => {
	it("validates, rewrites, and compiles the live plan before any paid create", () => {
		const prepared = prepareLiveScenarioForRun({
			plan: plan("live-rtmp-simple"),
			rewrite: REWRITE,
			startTimeoutSec: 60,
			feedSeconds: 30,
		});

		expect(prepared.submitted.bitmovin.accountId).toBe(
			REWRITE.bitmovinAccountId,
		);
		expect(prepared.expected).toEqual(
			compileExpectedLiveArtefacts(prepared.submitted),
		);
		expect(prepared.expected.muxings.length).toBeGreaterThan(0);
	});

	it("rejects a malformed live plan during preparation, before a create can exist", () => {
		expect(() =>
			prepareLiveScenarioForRun({
				plan: { name: "not-a-live-plan" },
				rewrite: REWRITE,
				startTimeoutSec: 60,
				feedSeconds: 30,
			}),
		).toThrow(/live schema/i);
	});

	it("drives create → start → feed → sample → stop → roll, and verifies green", async () => {
		const { deps, calls } = fakeProduct();
		const result = await runLiveScenario(deps, {
			plan: plan("live-rtmp-simple"),
			scenario: "live-rtmp-simple",
			feed: FEED,
			feedSeconds: 30,
			startTimeoutSec: 60,
			rewrite: REWRITE,
		});
		expect(result.invalid, result.invalid).toBeUndefined();
		expect(result.channelId).toBeDefined();
		expect(result.submittedPlan?.bitmovin.accountId).toBe(
			REWRITE.bitmovinAccountId,
		);
		const fails = result.report?.checks.filter((c) => c.verdict === "FAIL");
		expect(fails?.map((f) => `${f.id}: ${f.detail}`)).toEqual([]);
		expect(result.report?.counts.PASS).toBeGreaterThan(6);

		/**
		 * And the movement checks must PASS, not merely not-FAIL.
		 *
		 * Asserting only `fails === []` let a real defect survive: reading the MASTER playlist
		 * instead of a media one leaves `mediaSequence` undefined, the engine honestly SKIPs,
		 * and an assertion that only forbids failures cannot tell that apart from a channel
		 * whose sequence advanced. My own mutation run found it — the fix was right and
		 * nothing held it. Not-FAIL is not PASS.
		 */
		for (const id of [
			"live:media-sequence",
			"live:heartbeat",
			"live:segments",
			"live:ladder",
			"live:segment-naming",
			"live:to-vod:endlist",
			"live:recorded",
		]) {
			expect(
				result.report?.checks.find((c) => c.id === id)?.verdict,
				`${id} must be evaluated on a healthy run, not skipped`,
			).toBe("PASS");
		}

		// The ORDER is the contract: the feeder must not be created before the channel is
		// RUNNING, and the roll must come after the stop.
		const feeder = calls.indexOf("POST /api/feeder-sessions");
		const start = calls.indexOf("POST /api/live-channels/<id>/actions");
		const roll = calls.indexOf("POST /api/live-channels/<id>/live-to-vod");
		expect(start).toBeGreaterThanOrEqual(0);
		expect(feeder).toBeGreaterThan(start);
		expect(roll).toBeGreaterThan(feeder);
	});

	it("goes through the product's own API, not the orchestrator", async () => {
		// The whole point of layer 2: driving `sdk-ops` directly would verify Bitmovin
		// rather than this product's compiler, queue and step log.
		const { deps, calls } = fakeProduct();
		await runLiveScenario(deps, {
			plan: plan("live-rtmp-simple"),
			scenario: "s",
			feed: FEED,
			feedSeconds: 30,
			startTimeoutSec: 60,
			rewrite: REWRITE,
		});
		expect(calls).toContain("POST /api/live-channels");
		expect(calls).toContain("POST /api/live-channels/<id>/actions");
		expect(calls.every((c) => c.includes("/api/"))).toBe(true);
	});

	it("stops the channel even when the run fails", async () => {
		// A channel left RUNNING costs money. The output is deliberately NOT cleaned up —
		// the artefacts are the evidence.
		const { deps, calls } = fakeProduct({ statuses: ["ERROR"] });
		await runLiveScenario(deps, {
			plan: plan("live-rtmp-simple"),
			scenario: "s",
			feed: FEED,
			feedSeconds: 30,
			startTimeoutSec: 60,
			rewrite: REWRITE,
		});
		expect(
			calls.filter((c) => c === "POST /api/live-channels/<id>/actions").length,
			"start and stop",
		).toBeGreaterThanOrEqual(2);
	});
});

describe("runLiveScenario — the failures that are the product's, not the harness's", () => {
	it("FAILs exact VOD delivery closure even when the stopped live stream was otherwise healthy", async () => {
		const missing = {
			type: "HLS",
			manifestId: "missing-vod",
			url: "archive/exact/missing.m3u8",
		};
		const { deps } = fakeProduct({
			vodRecord: {
				manifests: [missing],
				families: [{ ...missing, status: "FINISHED" }],
			},
		});
		const result = await runLiveScenario(deps, {
			plan: plan("live-rtmp-simple"),
			scenario: "s",
			feed: FEED,
			feedSeconds: 30,
			startTimeoutSec: 60,
			rewrite: REWRITE,
		});
		expect(
			result.report?.checks.find((check) => check.id === "live:to-vod")
				?.verdict,
		).toBe("PASS");
		expect(
			result.report?.checks.find((check) => check.id === "live:to-vod:closure")
				?.verdict,
		).toBe("FAIL");
	});

	it("rejects a healthy stale terminal record whose attempt is not the one just requested", async () => {
		const { deps } = fakeProduct({
			vodRecord: { attemptId: "44444444-4444-4444-8444-444444444444" },
		});
		const result = await runLiveScenario(deps, {
			plan: plan("live-rtmp-simple"),
			scenario: "s",
			feed: FEED,
			feedSeconds: 30,
			startTimeoutSec: 60,
			rewrite: REWRITE,
		});
		expect(
			result.report?.checks.find((check) => check.id === "live:to-vod")
				?.verdict,
		).toBe("FAIL");
		expect(
			result.report?.checks.find((check) => check.id === "live:to-vod:closure")
				?.detail,
		).toContain("exposed no manifest identity");
	});

	it("reports a channel that never reached RUNNING as a FAIL, not as INVALID", async () => {
		const { deps } = fakeProduct({ statuses: ["ERROR"] });
		const result = await runLiveScenario(deps, {
			plan: plan("live-rtmp-simple"),
			scenario: "s",
			feed: FEED,
			feedSeconds: 30,
			startTimeoutSec: 60,
			rewrite: REWRITE,
		});
		expect(result.invalid).toBeUndefined();
		expect(
			result.report?.checks.find((c) => c.id === "live:running")?.verdict,
		).toBe("FAIL");
	});

	it("keeps the runner's short start deadline independent of the provider's minimum", async () => {
		const { deps } = fakeProduct({ statuses: ["CREATED"] });
		const before = deps.now();
		let runningWaitEndedAt: number | undefined;
		deps.log = (message) => {
			if (message.includes("channel is CREATED")) {
				runningWaitEndedAt = deps.now();
			}
		};
		const result = await runLiveScenario(deps, {
			plan: plan("live-rtmp-simple"),
			scenario: "s",
			feed: FEED,
			feedSeconds: 30,
			startTimeoutSec: 60,
			rewrite: REWRITE,
		});
		expect(result.invalid).toBeUndefined();
		expect(runningWaitEndedAt).toBe(before + 60_000);
		expect(
			result.report?.checks.find((c) => c.id === "live:running")?.verdict,
		).toBe("FAIL");
	});

	it("reports missing coordinates as a FAIL — a channel you cannot feed", async () => {
		const { deps } = fakeProduct({ noStreamKey: true });
		const result = await runLiveScenario(deps, {
			plan: plan("live-rtmp-simple"),
			scenario: "s",
			feed: FEED,
			feedSeconds: 30,
			startTimeoutSec: 60,
			rewrite: REWRITE,
		});
		expect(
			result.report?.checks.find((c) => c.id === "live:coordinates:streamKey")
				?.verdict,
		).toBe("FAIL");
	});

	it("SKIPs movement when the feeder refused, rather than blaming the encoder", async () => {
		const { deps } = fakeProduct({ feederStatus: 422 });
		const result = await runLiveScenario(deps, {
			plan: plan("live-rtmp-simple"),
			scenario: "s",
			feed: FEED,
			feedSeconds: 30,
			startTimeoutSec: 60,
			rewrite: REWRITE,
		});
		const movement = result.report?.checks.filter((c) =>
			/live:(media-sequence|heartbeat|segments)$/.test(c.id),
		);
		expect(movement?.length, "still emitted").toBe(3);
		expect(movement?.every((c) => c.verdict === "SKIP")).toBe(true);
	});

	it("FAILs a live-to-VOD that errored", async () => {
		const { deps } = fakeProduct({ liveToVod: "ERROR" });
		const result = await runLiveScenario(deps, {
			plan: plan("live-rtmp-simple"),
			scenario: "s",
			feed: FEED,
			feedSeconds: 30,
			startTimeoutSec: 60,
			rewrite: REWRITE,
		});
		expect(
			result.report?.checks.find((c) => c.id === "live:to-vod")?.verdict,
		).toBe("FAIL");
	});

	it("treats PARTIAL as terminal (ledger #283): FAILs it by name without polling to the 10-minute deadline", async () => {
		// One family finished, another failed: the product's record is terminal,
		// and a harness that only knew FINISHED/ERROR would poll it for the whole
		// deadline — ten minutes of virtual time here, ten real ones on a paid run.
		const { deps } = fakeProduct({ liveToVod: "PARTIAL" });
		const before = deps.now();
		const result = await runLiveScenario(deps, {
			plan: plan("live-rtmp-simple"),
			scenario: "s",
			feed: FEED,
			feedSeconds: 30,
			startTimeoutSec: 60,
			rewrite: REWRITE,
		});
		const check = result.report?.checks.find((c) => c.id === "live:to-vod");
		expect(check?.verdict).toBe("FAIL");
		expect(check?.detail).toContain("PARTIAL");
		expect(deps.now() - before).toBeLessThan(5 * 60 * 1000);
	});
});

describe("runLiveScenario — INVALID is reserved for harness faults", () => {
	it("refuses a feed shorter than the engine's own sample gap", async () => {
		// Otherwise the run costs minutes of encoder time to produce a report whose
		// movement checks can only ever SKIP.
		const { deps } = fakeProduct();
		const result = await runLiveScenario(deps, {
			plan: plan("live-rtmp-simple"),
			scenario: "s",
			feed: FEED,
			feedSeconds: 8,
			startTimeoutSec: 60,
			rewrite: REWRITE,
		});
		expect(result.invalid).toMatch(/too short/);
		expect(result.report).toBeUndefined();
	});

	it("refuses a plan that is not a live plan", async () => {
		const { deps } = fakeProduct();
		const result = await runLiveScenario(deps, {
			plan: { planVersion: 1, name: "not a live plan" },
			scenario: "s",
			feedSeconds: 30,
			startTimeoutSec: 60,
			rewrite: REWRITE,
		});
		expect(result.invalid).toMatch(/live schema/);
	});

	it("reports a channel it could not create as INVALID, never as a pass", async () => {
		const { deps } = fakeProduct();
		const broken: LiveRunnerDeps = {
			...deps,
			api: async (path, init) =>
				init?.method === "POST" && path === "/api/live-channels"
					? { status: 500, json: {} }
					: deps.api(path, init),
		};
		const result = await runLiveScenario(broken, {
			plan: plan("live-rtmp-simple"),
			scenario: "s",
			feed: FEED,
			feedSeconds: 30,
			startTimeoutSec: 60,
			rewrite: REWRITE,
		});
		expect(result.invalid).toMatch(/could not create the channel: HTTP 500/);
	});
});

describe("runLiveScenario — an ingest the feeder cannot drive", () => {
	it("still provisions and verifies the ZIXI channel", async () => {
		/**
		 * Zixi, not SRT-listener. The first version used the SRT LISTENER fixture on the
		 * belief that it was the unfeedable one — exactly backwards: SRT mode describes what
		 * BITMOVIN does, so LISTENER is the mode our caller-pushing feeder CAN drive, and a
		 * review caught the inversion. Zixi is genuinely unfeedable: it needs a broadcaster
		 * appliance, which is why `CAP_ZIXI` exists.
		 *
		 * The design's point stands whichever fixture carries it: this scenario is worth
		 * running for its coordinates and its heartbeat, and only the media assertions are
		 * unavailable.
		 */
		const { deps, calls } = fakeProduct();
		const result = await runLiveScenario(deps, {
			plan: plan("live-zixi"),
			scenario: "live-zixi",
			feed: FEED,
			feedSeconds: 30,
			startTimeoutSec: 60,
			rewrite: REWRITE,
		});
		expect(result.invalid).toBeUndefined();
		expect(
			calls.includes("POST /api/feeder-sessions"),
			"no feeder session may be created for an unfeedable ingest",
		).toBe(false);
		expect(
			result.report?.checks.find((c) => c.id === "live:running")?.verdict,
		).toBe("PASS");
		const movement = result.report?.checks.filter((c) =>
			/live:(media-sequence|heartbeat|segments)$/.test(c.id),
		);
		expect(movement?.every((c) => c.verdict === "SKIP")).toBe(true);
	});

	it("DOES drive the SRT listener channel, because that is the mode we can push to", async () => {
		// The corrected direction, asserted rather than left implicit.
		const { deps, calls } = fakeProduct();
		const result = await runLiveScenario(deps, {
			plan: plan("live-srt-listener"),
			scenario: "live-srt-listener",
			feed: FEED,
			feedSeconds: 30,
			startTimeoutSec: 60,
			rewrite: REWRITE,
		});
		expect(result.invalid).toBeUndefined();
		expect(
			calls.includes("POST /api/feeder-sessions"),
			"an SRT LISTENER input is what our caller-pushing feeder connects to",
		).toBe(true);
	});
});

describe("the feed duration is honoured, not approximated", () => {
	it("feeds for the requested seconds and reports THAT as the fed duration", async () => {
		/**
		 * The first version slept a fixed 12s and ignored `feedSeconds`, then reported the
		 * sample gap as the fed duration — so `live:recorded` compared a real recording
		 * against a number that was never the feed length. Its own test caught it: a 30s
		 * request produced a 12s "feed" and a 1.5× ratio on a healthy channel.
		 *
		 * This pins the fix by reading the ratio out of the report's own detail line, which
		 * is the only place the fed duration is visible.
		 */
		const { deps } = fakeProduct();
		const result = await runLiveScenario(deps, {
			plan: plan("live-rtmp-simple"),
			scenario: "s",
			feed: FEED,
			feedSeconds: 30,
			startTimeoutSec: 60,
			rewrite: REWRITE,
		});
		const recorded = result.report?.checks.find(
			(c) => c.id === "live:recorded",
		);
		expect(recorded?.verdict).toBe("PASS");
		expect(
			recorded?.detail,
			"the fed duration must be the requested one, not the sample gap",
		).toMatch(/of the 3[0-9]\.\ds fed/);
	});

	it("never feeds for less than the engine's sample gap, whatever was asked", async () => {
		// A request below the floor is refused up front, so the only way here is a request
		// above it — but the sleep is `max(remaining, floor)` so a slow provisioning cannot
		// shrink the gap below what the movement checks need.
		const { deps } = fakeProduct();
		const result = await runLiveScenario(deps, {
			plan: plan("live-rtmp-simple"),
			scenario: "s",
			feed: FEED,
			feedSeconds: 16,
			startTimeoutSec: 60,
			rewrite: REWRITE,
		});
		expect(
			result.report?.checks.find((c) => c.id === "live:sample-gap")?.verdict,
		).toBe("PASS");
	});
});

describe("rewriteLiveForRun — a fixture submitted verbatim is a guaranteed 400", () => {
	/**
	 * No live fixture carries `bitmovin.accountId`, and `/api/live-channels` requires one.
	 * The phase-B runner rewrote VOD plans and the live branch returned before reaching that
	 * code, so this tier could never have created a single channel. A review found it before
	 * the first real run — the tests could not, because the fake product returned 201 for any
	 * plan and the string `accountId` appeared nowhere in this file.
	 */
	const REW = {
		bitmovinAccountId: "44444444-4444-4444-8444-444444444444",
		credentialId: "55555555-5555-4555-8555-555555555555",
		outputBucket: "verify-out",
		prefix: "verify/RUN9/live-rtmp-simple/",
		// The run's budget: the forced auto-shutdown is derived from it.
		startTimeoutSec: 600,
		feedSeconds: 45,
	};

	it("pins a canary encoder before submission without changing the fixture", () => {
		const before = liveChannelPlanSchema.parse(plan("live-rtmp-simple"));
		expect(
			rewriteLiveForRun(before, { ...REW, encoderVersion: "2.285.0" }).bitmovin
				.encoderVersion,
		).toBe("2.285.0");
		expect(before.bitmovin.encoderVersion).toBe("STABLE");
		expect(rewriteLiveForRun(before, REW).bitmovin.encoderVersion).toBe(
			"STABLE",
		);
		expect(() =>
			rewriteLiveForRun(before, { ...REW, encoderVersion: "bad" }),
		).toThrow("encoder version");
	});

	it("proves the premise: no fixture declares an account id", () => {
		for (const name of [
			"live-rtmp-simple",
			"live-srt-listener",
			"live-zixi",
			"live-static-ip",
		]) {
			const p = plan(name) as { bitmovin: { accountId?: string } };
			expect(p.bitmovin.accountId, name).toBeUndefined();
		}
	});

	it("injects the account id, credential and bucket", () => {
		const out = rewriteLiveForRun(
			liveChannelPlanSchema.parse(plan("live-rtmp-simple")),
			REW,
		);
		expect(out.bitmovin.accountId).toBe(REW.bitmovinAccountId);
		for (const o of out.outputs) {
			if ("credentialId" in o) {
				expect(o.credentialId).toBe(REW.credentialId);
			}
			if ("bucket" in o) {
				expect(o.bucket).toBe(REW.outputBucket);
			}
		}
	});

	it("repoints each output at its OWN family's target — never the S3 one (review-290 I3)", () => {
		// The clobber this pins against was real: the old loop overwrote the
		// AKAMAI_MSL output's credential with the S3 one, which dies at
		// exec-io's provider assert the first time MSL is provisioned — found
		// the night the Akamai set entered the corpus.
		const AKAMAI_STORAGE = {
			credentialId: "66666666-6666-4666-8666-666666666666",
			bucket: "akamai-live-bucket",
		};
		const AKAMAI_MSL = {
			credentialId: "77777777-7777-4777-8777-777777777777",
			streamId: 1,
			eventName: "ev",
		};
		const out = rewriteLiveForRun(
			liveChannelPlanSchema.parse(plan("live-akamai-msl-storage")),
			{ ...REW, akamaiStorage: AKAMAI_STORAGE, akamaiMsl: AKAMAI_MSL },
		);
		const storage = out.outputs.find((o) => o.kind === "GENERIC_S3") as
			| { credentialId?: string; bucket?: string }
			| undefined;
		expect(storage?.credentialId).toBe(AKAMAI_STORAGE.credentialId);
		expect(storage?.bucket).toBe(AKAMAI_STORAGE.bucket);
		const msl = out.outputs.find((o) => o.kind === "AKAMAI_MSL") as
			| { credentialId?: string }
			| undefined;
		expect(msl?.credentialId).toBe(AKAMAI_MSL.credentialId);
		// And the S3 credential reached NEITHER of them.
		expect(storage?.credentialId).not.toBe(REW.credentialId);
		expect(msl?.credentialId).not.toBe(REW.credentialId);
	});

	it("leaves non-S3 outputs as authored when no family target is registered", () => {
		const before = liveChannelPlanSchema.parse(plan("live-akamai-msl-storage"));
		const out = rewriteLiveForRun(before, REW);
		const storage = out.outputs.find((o) => o.kind === "GENERIC_S3") as
			| { credentialId?: string; bucket?: string }
			| undefined;
		const authored = before.outputs.find((o) => o.kind === "GENERIC_S3") as
			| { credentialId?: string; bucket?: string }
			| undefined;
		expect(storage?.credentialId).toBe(authored?.credentialId);
		expect(storage?.bucket).toBe(authored?.bucket);
		const msl = out.outputs.find((o) => o.kind === "AKAMAI_MSL") as
			| { credentialId?: string }
			| undefined;
		const authoredMsl = before.outputs.find((o) => o.kind === "AKAMAI_MSL") as
			| { credentialId?: string }
			| undefined;
		expect(msl?.credentialId).toBe(authoredMsl?.credentialId);
	});

	it("moves every destination under the run prefix, keeping its structure", () => {
		// A PREFIX, not a replacement: the per-rendition folders and the video/audio split
		// have to survive or the expectations and the artefacts describe different trees.
		const before = liveChannelPlanSchema.parse(plan("live-rtmp-simple"));
		const out = rewriteLiveForRun(before, REW);
		for (const [i, m] of out.muxings.entries()) {
			const was = before.muxings[i]?.destination?.path;
			expect(m.destination?.path).toBe(`${REW.prefix}${was}`);
		}
		for (const [i, m] of out.liveManifests.entries()) {
			const was = before.liveManifests[i]?.destination.path;
			expect(m.destination.path).toBe(`${REW.prefix}${was}`);
		}
	});

	it("leaves the input plan untouched", () => {
		const before = liveChannelPlanSchema.parse(plan("live-rtmp-simple"));
		const snapshot = JSON.stringify(before);
		rewriteLiveForRun(before, REW);
		expect(JSON.stringify(before)).toBe(snapshot);
	});

	it("keeps a direct MSL manifest's event-root path EMPTY under the prefix, so the fixture stays valid", () => {
		/**
		 * A DIRECT MSL fixture writes its manifests to the event ROOT — an EMPTY
		 * path (LIVE_MSL_MANIFEST_PATH, C31, row 220). The blanket prefix
		 * rewrite turned `""` into `verify/RUN9/…/`, which is neither empty nor
		 * leading-and-trailing-slash, so the plan failed its OWN validator and
		 * died on the harness's rewrite before the product ever ran. Only the
		 * SEGMENT (muxing) paths take the prefix; the MSL manifest path stays
		 * empty.
		 */
		const before = liveChannelPlanSchema.parse(plan("live-akamai-msl"));
		const prefix = "verify/RUN9/live-akamai-msl/";
		const out = rewriteLiveForRun(before, { ...REW, prefix });
		// The MSL manifests keep their event-root empty path...
		for (const m of out.liveManifests) {
			expect(m.destination.path).toBe("");
		}
		// ...while the segments DID move under the prefix (the exemption is
		// scoped to the manifest-path shape, not to the whole MSL output).
		for (const [i, m] of out.muxings.entries()) {
			const was = before.muxings[i]?.destination?.path;
			expect(m.destination?.path).toBe(`${prefix}${was}`);
		}
		// And the rewritten plan passes its OWN validator — it reaches the
		// product instead of dying on LIVE_MSL_MANIFEST_PATH.
		expect(
			validateLiveChannel(out).filter(
				(i) => i.code === "LIVE_MSL_MANIFEST_PATH",
			),
		).toEqual([]);
	});

	it("rewrites every live fixture into a schema-valid plan", () => {
		for (const name of [
			"live-rtmp-simple",
			"live-redundant-rtmp",
			"live-srt-caller",
			"live-srt-listener",
			"live-static-ip",
			"live-esam-full",
			"live-zixi",
		]) {
			expect(
				() => rewriteLiveForRun(liveChannelPlanSchema.parse(plan(name)), REW),
				name,
			).not.toThrow();
		}
	});

	it("submits the REWRITTEN plan, not the fixture", async () => {
		// The check the fake product could not make before: assert what was POSTed.
		let posted: { bitmovin?: { accountId?: string } } | undefined;
		const { deps } = fakeProduct();
		const spy: LiveRunnerDeps = {
			...deps,
			api: async (path, init) => {
				if (init?.method === "POST" && path === "/api/live-channels") {
					posted = (init.body as { plan?: typeof posted })?.plan;
				}
				return deps.api(path, init);
			},
		};
		await runLiveScenario(spy, {
			plan: plan("live-rtmp-simple"),
			scenario: "live-rtmp-simple",
			feed: FEED,
			feedSeconds: 30,
			startTimeoutSec: 60,
			rewrite: REW,
		});
		expect(
			posted?.bitmovin?.accountId,
			"an unrewritten plan would 400 on every real run",
		).toBe(REW.bitmovinAccountId);
	});
});

describe("rewriteLiveForRun and the owner-namespaced ids on the INPUT", () => {
	const REW2 = {
		bitmovinAccountId: "44444444-4444-4444-8444-444444444444",
		credentialId: "55555555-5555-4555-8555-555555555555",
		outputBucket: "verify-out",
		prefix: "verify/RUN9/s/",
		startTimeoutSec: 600,
		feedSeconds: 45,
	};

	it("strips the SRT passphrase credential AND its keyLength together", () => {
		/**
		 * `refineSrtConnection` requires them together, so removing one alone makes the plan
		 * invalid — and the passphrase is not what an SRT scenario verifies, SRT ingest is. A
		 * review enumerated the ids the first rewrite left, and two were on runnable
		 * scenarios, so all of them would have failed for reasons that are not the product's.
		 */
		const before = liveChannelPlanSchema.parse(plan("live-srt-listener"));
		const out = rewriteLiveForRun(before, REW2);
		const input = out.liveInput as {
			credentialId?: string;
			keyLength?: number;
		};
		expect(input.credentialId).toBeUndefined();
		expect(input.keyLength).toBeUndefined();
	});

	it("leaves ZIXI's credential alone, because its schema requires one", () => {
		// My first version stripped it for Zixi too, and the re-parse caught it immediately —
		// which is the argument for re-parsing rather than trusting a rewrite.
		const out = rewriteLiveForRun(
			liveChannelPlanSchema.parse(plan("live-zixi")),
			REW2,
		);
		expect(
			(out.liveInput as { credentialId?: string }).credentialId,
		).toBeDefined();
	});

	it("does NOT strip staticIpId or infrastructure", () => {
		/**
		 * Deliberate. Stripping them turns `live-static-ip` into a byte-identical duplicate of
		 * `live-rtmp-simple` — a scenario that verifies static IP by not using static IP,
		 * which is the named-slot pattern in a new costume. C18 also binds them to
		 * `cloudRegion: "EXTERNAL"` in both directions. It is gated on `LIVE_INFRA` instead:
		 * a named SKIP is honest, a green run that tested nothing is not.
		 */
		const out = rewriteLiveForRun(
			liveChannelPlanSchema.parse(plan("live-static-ip")),
			REW2,
		);
		expect(out.bitmovin.staticIpId).toBeDefined();
		expect(out.bitmovin.infrastructure).toBeDefined();
	});

	it("still produces a schema-valid plan for every fixture after the strips", () => {
		for (const name of [
			"live-rtmp-simple",
			"live-redundant-rtmp",
			"live-srt-caller",
			"live-srt-listener",
			"live-static-ip",
			"live-esam-full",
			"live-zixi",
		]) {
			expect(
				() => rewriteLiveForRun(liveChannelPlanSchema.parse(plan(name)), REW2),
				name,
			).not.toThrow();
		}
	});
});

describe("firstVariantUri — resolve, do not guess", () => {
	/**
	 * The rolled recording's own playlist has a name Bitmovin chose, not one the plan
	 * declares, so `liveHlsEntryUri` cannot help. Following the master is the only way to
	 * find it — and it is the same "resolve variant URIs rather than count them" step §9b
	 * names as what would make the VOD `manifest:hls:endlist` reachable.
	 */
	it("takes the line after #EXT-X-STREAM-INF", () => {
		expect(
			firstVariantUri(
				[
					"#EXTM3U",
					"#EXT-X-VERSION:4",
					"#EXT-X-STREAM-INF:BANDWIDTH=4500000",
					"video_4500000.m3u8",
					"#EXT-X-STREAM-INF:BANDWIDTH=800000",
					"video_800000.m3u8",
				].join("\n"),
			),
		).toBe("video_4500000.m3u8");
	});

	it("skips blank lines between the tag and the uri", () => {
		expect(
			firstVariantUri("#EXT-X-STREAM-INF:BANDWIDTH=1\n\n  \nv.m3u8\n"),
		).toBe("v.m3u8");
	});

	it("returns undefined for a master with no variants", () => {
		// A guessed name would hide the finding. A master with nothing to follow IS the
		// finding, and the runner reports it as such.
		expect(firstVariantUri("#EXTM3U\n#EXT-X-VERSION:4\n")).toBeUndefined();
	});

	it("returns undefined when a comment follows the tag instead of a uri", () => {
		expect(
			firstVariantUri("#EXT-X-STREAM-INF:BANDWIDTH=1\n#EXT-X-ENDLIST\n"),
		).toBeUndefined();
	});

	it("is not fooled by EXT-X-MEDIA, which is a rendition group and not a variant", () => {
		expect(
			firstVariantUri('#EXT-X-MEDIA:TYPE=AUDIO,URI="audio.m3u8"\n'),
		).toBeUndefined();
	});

	it("reports a master with no variants rather than reading nothing", async () => {
		// End to end: `live:readable` must FAIL, naming the master — silence here would mean
		// the post-stop half of the report quietly evaluated nothing.
		const { deps } = fakeProduct();
		const noVariants: LiveRunnerDeps = {
			...deps,
			readText: async (outputKey: string, key: string) =>
				key === "archive/exact/vod.m3u8"
					? "#EXTM3U\n#EXT-X-VERSION:4\n"
					: deps.readText(outputKey, key),
		};
		const result = await runLiveScenario(noVariants, {
			plan: plan("live-rtmp-simple"),
			scenario: "s",
			feed: FEED,
			feedSeconds: 30,
			startTimeoutSec: 60,
			rewrite: REWRITE,
		});
		const readable = result.report?.checks.find(
			(c) => c.id === "live:readable",
		);
		expect(readable?.verdict).toBe("FAIL");
		expect(readable?.detail).toMatch(/terminal manifest closure/);
	});
});

describe("the publish measurement must not consume the feed it measures", () => {
	/**
	 * The instrument broke the experiment, and this is the guard.
	 *
	 * `measureFirstPublish` polls the media playlist from the feed going up until a segment
	 * appears. I capped it at 120s and ran it inside a 45s feed, so it kept polling long after
	 * the feeder had stopped and both movement samples were then taken against a dead channel:
	 * REAL-LIVE-3 reported `live:segments: … 0 → 0` and `live:media-sequence: … 0 → 0` for
	 * `live-redundant-rtmp` and `live-srt-listener`. `live-rtmp-simple` had PASSed 13 checks
	 * before the measurement existed.
	 *
	 * The cap is now `feedSeconds - 2 × MIN_SAMPLE_GAP_SEC`, and a feed too short to spare any
	 * time gets NO measurement rather than a "not observed" — which would blame the origin for
	 * a window it was never given.
	 */
	it("leaves the movement samples their gap, so a fed channel still shows movement", async () => {
		const { deps } = fakeProduct();
		const result = await runLiveScenario(deps, {
			plan: plan("live-rtmp-simple"),
			scenario: "s",
			feed: FEED,
			feedSeconds: 45,
			startTimeoutSec: 60,
			rewrite: REWRITE,
		});
		const movement = (result.report?.checks ?? []).filter((c) =>
			/^live:(segments|media-sequence)$/.test(c.id),
		);
		expect(movement.length, "both movement checks must be present").toBe(2);
		expect(
			movement.filter((c) => c.verdict === "FAIL").map((c) => c.detail),
			"a fed channel must still show movement once the measurement is bounded",
		).toEqual([]);
	});

	it("does not measure at all when the feed is too short to spare the time", async () => {
		// 16s feed, 10s sample gap: nothing left. Reporting "not observed" here would be a
		// finding about the origin derived from a window the harness never gave it.
		const { deps } = fakeProduct();
		const result = await runLiveScenario(deps, {
			plan: plan("live-rtmp-simple"),
			scenario: "s",
			feed: FEED,
			feedSeconds: 16,
			startTimeoutSec: 60,
			rewrite: REWRITE,
		});
		expect(result.firstPublish?.ms).toBeUndefined();
		expect(result.firstPublish?.note).toMatch(/not measured/);
		expect(result.firstPublish?.polls).toBe(0);
	});
});

describe("the heartbeat series is read from the shape the route returns", () => {
	/**
	 * `GET /api/live-channels/:id/heartbeats` answers `{windowMinutes, points:[…]}`, and the
	 * sampler read `items`. So `live:heartbeat` SKIPped with "the heartbeat series could not be
	 * read" on every live run — including the green ones — while the data was right there. The
	 * fake mirrored the bug, which is why nothing caught it.
	 */
	it("counts the points, so live:heartbeat can actually be judged", async () => {
		const { deps } = fakeProduct();
		const result = await runLiveScenario(deps, {
			plan: plan("live-rtmp-simple"),
			scenario: "s",
			feed: FEED,
			feedSeconds: 45,
			startTimeoutSec: 60,
			rewrite: REWRITE,
		});
		const hb = result.report?.checks.find((c) => c.id === "live:heartbeat");
		expect(hb?.verdict, hb?.detail).toBe("PASS");
		expect(hb?.detail).not.toMatch(/could not be read/);
	});

	it("names the keys when the body carries neither shape", async () => {
		/**
		 * The guard against a repeat. Returning `undefined` is what let a field-name mismatch
		 * masquerade as an empty series for this check's whole life, so an unrecognised 200 now
		 * says what keys it DID have.
		 */
		const { deps } = fakeProduct({ heartbeatBody: { windowMinutes: 120 } });
		const result = await runLiveScenario(deps, {
			plan: plan("live-rtmp-simple"),
			scenario: "s",
			feed: FEED,
			feedSeconds: 45,
			startTimeoutSec: 60,
			rewrite: REWRITE,
		});
		const readable = result.report?.checks.find(
			(c) => c.id === "live:readable",
		);
		expect(readable?.detail).toMatch(/keys were \[windowMinutes\]/);
	});
});

describe("verification channels carry a SHORT forced auto-shutdown", () => {
	/**
	 * The owner's suggestion, and the evidence for it is exact.
	 *
	 * Four live encodings billed for up to 7h19m after our teardown said STOPPED, and what each
	 * fixture declared predicted how long each survived:
	 *
	 *   live-redundant-rtmp   no autoShutdown at all                     → 7h01m and 7h19m
	 *   live-srt-listener     waitingForFirstConnectTimeoutMinutes only  → 7h19m
	 *   live-rtmp-simple      bytesRead 3600s + streamTimeout 720min     → 2h31m
	 *
	 * A 12-hour cap is a production value; a verification channel lives for twenty minutes at the
	 * outside. So the run overrides it — and the fixtures keep their production values, because this
	 * is about the harness not leaking, not about changing what the scenarios describe.
	 */
	const REW = {
		bitmovinAccountId: "44444444-4444-4444-8444-444444444444",
		credentialId: "55555555-5555-4555-8555-555555555555",
		outputBucket: "verify-out",
		prefix: "verify/RUN9/x/",
		startTimeoutSec: 600,
		feedSeconds: 45,
	};

	it("caps every live fixture, including the three that declare no autoShutdown", () => {
		for (const name of [
			"live-rtmp-simple",
			"live-redundant-rtmp",
			"live-srt-listener",
			"live-srt-caller",
			"live-zixi",
			"live-esam-full",
			"live-static-ip",
		]) {
			const out = rewriteLiveForRun(
				liveChannelPlanSchema.parse(plan(name)),
				REW,
			);
			const auto = out.start?.autoShutdown;
			expect(auto, `${name} must carry an auto-shutdown`).toBeDefined();
			// (600 + 45)/60 = 11 (ceil) + 5 slack.
			expect(auto?.streamTimeoutMinutes, name).toBe(16);
			expect(auto?.waitingForFirstConnectTimeoutMinutes, name).toBe(11);
			expect(auto?.bytesReadTimeoutSeconds, name).toBe(300);
		}
	});

	it("OVERRIDES a fixture's production cap rather than deferring to it", () => {
		// `live-rtmp-simple` declares 720 minutes. Deferring to it is what cost seven hours.
		const before = liveChannelPlanSchema.parse(plan("live-rtmp-simple"));
		expect(before.start?.autoShutdown?.streamTimeoutMinutes).toBe(720);
		const out = rewriteLiveForRun(before, REW);
		expect(out.start?.autoShutdown?.streamTimeoutMinutes).toBe(16);
	});

	it("scales with the run's budget instead of hardcoding a cap", () => {
		// A 15-minute feed legitimately needs a longer cap than a 45-second one, and a constant
		// would either strangle the first or fail to protect the second.
		const out = rewriteLiveForRun(
			liveChannelPlanSchema.parse(plan("live-rtmp-simple")),
			{ ...REW, startTimeoutSec: 900, feedSeconds: 900 },
		);
		// (900 + 900)/60 = 30 + 5.
		expect(out.start?.autoShutdown?.streamTimeoutMinutes).toBe(35);
	});

	it("uses the provider's five-minute minimum even for a zero budget", () => {
		// Provider caps must remain valid even when the runner's own budget is shorter.
		const out = rewriteLiveForRun(
			liveChannelPlanSchema.parse(plan("live-rtmp-simple")),
			{ ...REW, startTimeoutSec: 0, feedSeconds: 0 },
		);
		expect(out.start?.autoShutdown).toEqual({
			streamTimeoutMinutes: 5,
			waitingForFirstConnectTimeoutMinutes: 5,
			bytesReadTimeoutSeconds: 300,
		});
	});

	it.each([
		[60, 5],
		[240, 5],
		[241, 6],
	] as const)("keeps a %s-second start budget valid and scales above the minimum", (startTimeoutSec, firstConnectMinutes) => {
		const out = rewriteLiveForRun(
			liveChannelPlanSchema.parse(plan("live-rtmp-simple")),
			{ ...REW, startTimeoutSec },
		);
		expect(out.start?.autoShutdown?.waitingForFirstConnectTimeoutMinutes).toBe(
			firstConnectMinutes,
		);
		expect(out.start?.autoShutdown?.streamTimeoutMinutes).toBe(
			Math.ceil((startTimeoutSec + REW.feedSeconds) / 60) + 5,
		);
	});
});

describe("rewriteLiveForRun — publicRead", () => {
	const REW = {
		bitmovinAccountId: "44444444-4444-4444-8444-444444444444",
		credentialId: "55555555-5555-4555-8555-555555555555",
		outputBucket: "verify-out",
		prefix: "verify/RUN-ACL/live-rtmp-simple/",
		startTimeoutSec: 600,
		feedSeconds: 45,
	};

	/**
	 * The live fixtures carry no ACL, deliberately: they mirror encoding examples,
	 * where publishing is the operator's decision. A run that exists to verify a
	 * PLAYER needs the opposite, so it is opt-in — and it has to reach the
	 * segments, not only the manifests, or playback fails after the manifest
	 * loads.
	 */
	const before = () => liveChannelPlanSchema.parse(plan("live-rtmp-simple"));

	it("marks every destination public when asked", () => {
		const out = rewriteLiveForRun(before(), { ...REW, publicRead: true });
		expect(out.liveManifests.length).toBeGreaterThan(0);
		for (const m of out.liveManifests) {
			expect(m.destination.acl, `manifest ${m.key}`).toBe("PUBLIC_READ");
		}
		expect(out.muxings.length).toBeGreaterThan(0);
		for (const m of out.muxings) {
			expect(m.destination?.acl, `muxing ${m.key}`).toBe("PUBLIC_READ");
		}
	});

	it("changes nothing by default", () => {
		const out = rewriteLiveForRun(before(), REW);
		for (const m of out.liveManifests) {
			expect(m.destination).not.toHaveProperty("acl");
		}
		for (const m of out.muxings) {
			expect(m.destination).not.toHaveProperty("acl");
		}
	});

	it("still applies the run prefix — the two rewrites are independent", () => {
		const out = rewriteLiveForRun(before(), { ...REW, publicRead: true });
		for (const m of out.liveManifests) {
			expect(m.destination.path.startsWith(REW.prefix)).toBe(true);
		}
	});
});

describe("static-GENERATE feed resolution (the night's most-burned seam)", () => {
	/**
	 * Two real defects shipped in one evening here, both proven by the DB's
	 * feeder targets rather than the logs: (1) the stream-keys list call died
	 * in validation (missing bitmovinAccountId) so "no key" was reported while
	 * the key existed; (2) the "not feeding" log did NOT stop the feed — the
	 * fallback pushed the PLAN key at the encoder IP anyway, which static
	 * ingest always refuses . These pin both ends.
	 */
	function staticFake(opts: { withKey: boolean }) {
		const calls: string[] = [];
		let poll = 0;
		const deps: LiveRunnerDeps = {
			api: async (path, init) => {
				const method = init?.method ?? "GET";
				calls.push(`${method} ${path.replace(/[0-9a-f-]{36}/g, "<id>")}`);
				if (method === "POST" && path === "/api/live-channels") {
					return {
						status: 201,
						json: { id: "11111111-1111-4111-8111-111111111111" },
					};
				}
				if (path.endsWith("/heartbeats")) {
					return { status: 200, json: { windowMinutes: 120, points: [] } };
				}
				if (path.startsWith("/api/live/stream-keys?")) {
					return {
						status: 200,
						json: {
							totalCount: opts.withKey ? 1 : 0,
							items: opts.withKey
								? [
										{
											id: "33333333-3333-4333-8333-333333333333",
											assignedEncodingId: "enc-1",
										},
									]
								: [],
						},
					};
				}
				if (path.startsWith("/api/live/stream-keys/")) {
					return { status: 200, json: { value: "generated-22char-key" } };
				}
				if (path === "/api/feeder-sessions") {
					return {
						status: 201,
						json: { id: "22222222-2222-4222-8222-222222222222" },
					};
				}
				if (method === "POST") {
					return { status: 202, json: {} };
				}
				poll += 1;
				return {
					status: 200,
					json: {
						status: poll < 2 ? "STARTING" : "RUNNING",
						streamKey: "myStreamKey",
						encoderIp: "10.1.2.3",
						bitmovinEncodingId: "enc-1",
					},
				};
			},
			readText: async () => {
				throw new Error("NOTFOUND x: not written in this test");
			},
			listAll: async () => [],
			sleep: async () => {},
			now: (() => {
				let t = 1_760_000_000_000;
				return () => {
					t += 15_000;
					return t;
				};
			})(),
			log: () => {},
		};
		return { deps, calls };
	}

	const REW = {
		bitmovinAccountId: "44444444-4444-4444-8444-444444444444",
		credentialId: "55555555-5555-4555-8555-555555555555",
		outputBucket: "verify-out",
		prefix: "verify/RUN9/live-static-ingest/",
	};

	it("feeds the STATIC FQDN with the revealed key — never the plan key at the encoder IP", async () => {
		const { deps, calls } = staticFake({ withKey: true });
		await runLiveScenario(deps, {
			plan: plan("live-static-ingest"),
			scenario: "live-static-ingest",
			feed: {
				credentialId: REW.credentialId,
				bucket: "in",
				key: "src.mov",
			},
			feedSeconds: 30,
			startTimeoutSec: 60,
			rewrite: REW,
		});
		const feederPost = calls.find((c) => c === "POST /api/feeder-sessions");
		expect(feederPost, "the feeder was posted").toBeDefined();
		// The list call carried the account id (the validation the first
		// version died on) …
		expect(
			calls.some(
				(c) =>
					c.startsWith("GET /api/live/stream-keys?") &&
					c.includes("bitmovinAccountId="),
			),
		).toBe(true);
		// … and the reveal ran.
		expect(
			calls.some((c) => c.startsWith("GET /api/live/stream-keys/<id>")),
		).toBe(true);
	});

	it("does NOT feed when no key can be revealed — the refusal is real, not a log line", async () => {
		const { deps, calls } = staticFake({ withKey: false });
		await runLiveScenario(deps, {
			plan: plan("live-static-ingest"),
			scenario: "live-static-ingest",
			feed: {
				credentialId: REW.credentialId,
				bucket: "in",
				key: "src.mov",
			},
			feedSeconds: 30,
			startTimeoutSec: 60,
			rewrite: REW,
		});
		expect(
			calls.filter((c) => c === "POST /api/feeder-sessions"),
			"no feeder session may be created with the refused plan key",
		).toEqual([]);
	});
});

describe("teardown must be CONFIRMED, not acknowledged (ledger #209, paid audit BLOCKER-4)", () => {
	it("a stop the product acknowledges but never confirms is INVALID — the channel may still bill", async () => {
		const { deps } = fakeProduct({ stoppedStatus: "STOPPING" });
		const result = await runLiveScenario(deps, {
			plan: plan("live-rtmp-simple"),
			scenario: "live-rtmp-simple",
			feed: FEED,
			feedSeconds: 30,
			startTimeoutSec: 60,
			rewrite: REWRITE,
		});
		expect(result.invalid).toMatch(/never CONFIRMED/);
		expect(result.invalid).toMatch(/STOPPING/);
	});

	it("a channel that goes ERROR after the stop is INVALID too", async () => {
		const { deps } = fakeProduct({ stoppedStatus: "ERROR" });
		const result = await runLiveScenario(deps, {
			plan: plan("live-rtmp-simple"),
			scenario: "live-rtmp-simple",
			feed: FEED,
			feedSeconds: 30,
			startTimeoutSec: 60,
			rewrite: REWRITE,
		});
		expect(result.invalid).toMatch(/reported ERROR after the stop/);
	});

	it("a refused live-to-VOD roll FAILs live:to-vod instead of skipping the post-stop checks", async () => {
		const { deps } = fakeProduct({ rollStatus: 409 });
		const result = await runLiveScenario(deps, {
			plan: plan("live-rtmp-simple"),
			scenario: "live-rtmp-simple",
			feed: FEED,
			feedSeconds: 30,
			startTimeoutSec: 60,
			rewrite: REWRITE,
		});
		expect(result.invalid).toBeUndefined();
		const toVod = result.report?.checks.find((c) => c.id === "live:to-vod");
		expect(toVod?.verdict).toBe("FAIL");
		expect(toVod?.detail).toMatch(/REFUSED \(HTTP 409\)/);
	});

	it("does not request storage-backed live-to-VOD for an MSL-only recording", async () => {
		const { deps, calls } = fakeProduct({ rollStatus: 500 });
		const result = await runLiveScenario(deps, {
			plan: plan("live-akamai-msl-ts"),
			scenario: "live-akamai-msl-ts",
			feed: FEED,
			feedSeconds: 30,
			startTimeoutSec: 60,
			rewrite: {
				...REWRITE,
				akamaiMsl: {
					credentialId: "77777777-7777-4777-8777-777777777777",
					streamId: 1,
					eventName: "ev",
				},
			},
		});

		expect(result.invalid).toBeUndefined();
		expect(calls.filter((call) => call.endsWith("/live-to-vod"))).toEqual([]);
		const toVod = result.report?.checks.find(
			(check) => check.id === "live:to-vod",
		);
		expect(toVod?.verdict).toBe("SKIP");
		expect(toVod?.detail).toMatch(/not applicable.*only on Akamai MSL/i);
	});

	it("pins the storage output even when an MSL mirror appears first", async () => {
		const { deps, liveToVodRequests } = fakeProduct();
		const authored = plan("live-akamai-msl-storage") as {
			outputs: unknown[];
		};
		authored.outputs.reverse();
		const result = await runLiveScenario(deps, {
			plan: authored,
			scenario: "live-akamai-msl-storage",
			feed: FEED,
			feedSeconds: 30,
			startTimeoutSec: 60,
			rewrite: {
				...REWRITE,
				akamaiStorage: {
					credentialId: "66666666-6666-4666-8666-666666666666",
					bucket: "akamai-live-bucket",
				},
				akamaiMsl: {
					credentialId: "77777777-7777-4777-8777-777777777777",
					streamId: 1,
					eventName: "ev",
				},
			},
		});

		expect(result.invalid).toBeUndefined();
		expect(liveToVodRequests).toEqual([{ outputKey: "origin" }]);
	});

	it("uses a storage mirror when the primary recording is MSL", async () => {
		const { deps, liveToVodRequests } = fakeProduct();
		const authored = plan("live-akamai-msl-ts") as {
			outputs: unknown[];
			deliveryMirrors?: { outputKey: string }[];
		};
		authored.outputs.push({
			key: "archive",
			kind: "GENERIC_S3",
			credentialId: "66666666-6666-4666-8666-666666666666",
			bucket: "akamai-live-bucket",
			name: "Akamai Object Storage Output",
		});
		authored.deliveryMirrors = [{ outputKey: "archive" }];
		const result = await runLiveScenario(deps, {
			plan: authored,
			scenario: "live-akamai-msl-ts-storage-mirror",
			feed: FEED,
			feedSeconds: 30,
			startTimeoutSec: 60,
			rewrite: {
				...REWRITE,
				akamaiStorage: {
					credentialId: "66666666-6666-4666-8666-666666666666",
					bucket: "akamai-live-bucket",
				},
				akamaiMsl: {
					credentialId: "77777777-7777-4777-8777-777777777777",
					streamId: 1,
					eventName: "ev",
				},
			},
		});

		expect(result.invalid).toBeUndefined();
		expect(liveToVodRequests).toEqual([{ outputKey: "archive" }]);
	});

	it("a live-to-VOD request that THREW is a read error and a failed roll, not a skipped post-stop phase (review-327 I5)", async () => {
		// The narrower trigger of the same BLOCKER-4 class: the request never
		// reached the product (a network fault), which `.catch( => undefined)`
		// used to turn into "the channel was not rolled, skip every post-stop
		// check" — and a PASS.
		const { deps } = fakeProduct({ rollThrows: "ECONNRESET" });
		const result = await runLiveScenario(deps, {
			plan: plan("live-rtmp-simple"),
			scenario: "live-rtmp-simple",
			feed: FEED,
			feedSeconds: 30,
			startTimeoutSec: 60,
			rewrite: REWRITE,
		});
		expect(result.invalid).toBeUndefined();
		const checks = result.report?.checks ?? [];
		const readable = checks.find((c) => c.id === "live:readable");
		expect(readable?.verdict).toBe("FAIL");
		expect(readable?.detail).toMatch(/live-to-VOD request threw: ECONNRESET/);
		const toVod = checks.find((c) => c.id === "live:to-vod");
		expect(toVod?.verdict).toBe("FAIL");
	});
});

describe("the durable cleanup seal", () => {
	const run = (deps: LiveRunnerDeps) =>
		runLiveScenario(deps, {
			plan: plan("live-rtmp-simple"),
			scenario: "live-rtmp-simple",
			feed: FEED,
			feedSeconds: 30,
			startTimeoutSec: 60,
			rewrite: REWRITE,
		});

	it("keeps a healthy local teardown open until exact provider readback", async () => {
		const { deps } = fakeProduct();
		const result = await run(deps);
		expect(result.invalid, result.invalid).toBeUndefined();
		const seal = result.cleanup;
		expect(seal?.localClean).toBe(true);
		expect(seal?.clean).toBe(false);
		expect(seal?.providerTerminal.established).toBe(false);
		expect(seal?.productStopProjection.established).toBe(true);
		expect(seal?.localTerminal.established).toBe(true);
		expect(seal?.feederProcessGone.established).toBe(true);
		expect(seal?.hostProcessGone.established).toBe(true);
		expect(seal?.queueDrained.established).toBe(true);
	});

	it("a feeder never proven gone seals the teardown NOT clean", async () => {
		// The audit's shape, driven through the runner: the channel reads STOPPED
		// but the feeder's processGoneAt never stamps.
		const { deps } = fakeProduct({ feederProcessGone: false });
		const result = await run(deps);
		expect(result.cleanup?.clean).toBe(false);
		expect(result.cleanup?.feederProcessGone.established).toBe(false);
	});

	it("a channel STOPPED with a stop error is not a confirmed provider terminal", async () => {
		// A feeder stop that could not be enqueued (or an encoding not seen
		// terminal) reaches the runner as the channel's `error` — the same field
		// live-processor's stopChannel now folds an enqueue failure into.
		const { deps } = fakeProduct({
			channelStopError:
				"stop did not confirm — feeder stop could not be enqueued (feed-1: redis down)",
		});
		const result = await run(deps);
		expect(result.cleanup?.clean).toBe(false);
		expect(result.cleanup?.providerTerminal.established).toBe(false);
		expect(result.cleanup?.localTerminal.established).toBe(true);
	});

	it("a still-pending feeder queue job seals the teardown NOT clean", async () => {
		const { deps } = fakeProduct({ feederQueued: true });
		const result = await run(deps);
		expect(result.cleanup?.clean).toBe(false);
		expect(result.cleanup?.queueDrained.established).toBe(false);
	});

	it("a feeder still holding an unreclaimed pid is not host-process-gone", async () => {
		const { deps } = fakeProduct({ feederPid: 4242, feederProcessGone: false });
		const result = await run(deps);
		expect(result.cleanup?.clean).toBe(false);
		expect(result.cleanup?.hostProcessGone.established).toBe(false);
	});

	it("resumes a partial teardown into a locally clean seal once the feeder is proven gone", async () => {
		// The kill ladder stamps processGoneAt on the 3rd cleanup read, AFTER the
		// channel stopped. The seal poll must re-read and complete — the idempotent
		// resume. The happy-path test above is the control: a run already clean on
		// the first read seals clean with no polling.
		const { deps } = fakeProduct({ feederGoneAfterReads: 3 });
		const result = await run(deps);
		expect(result.invalid, result.invalid).toBeUndefined();
		expect(result.cleanup?.localClean).toBe(true);
		expect(result.cleanup?.clean).toBe(false);
		expect(result.cleanup?.feederProcessGone.established).toBe(true);
	});

	it("a run that created no feeder seals locally clean on the channel elements alone", async () => {
		// The feeder POST is refused, so nothing pushed — the three feeder-derived
		// elements are vacuously established and the channel stop still seals clean.
		const { deps } = fakeProduct({ feederStatus: 500 });
		const result = await run(deps);
		expect(result.cleanup?.localClean).toBe(true);
		expect(result.cleanup?.clean).toBe(false);
		expect(result.cleanup?.feederProcessGone.established).toBe(true);
		expect(result.cleanup?.hostProcessGone.established).toBe(true);
	});
});

describe("collectEdgeClosures — reads the MSL mirror back on the delivery edge", () => {
	const EDGE = "https://edge.example.net/cmaf/live/1/ev/";
	const RUN_PREFIX = REWRITE.prefix;
	const EDGE_RUN = `${EDGE}${RUN_PREFIX}`;
	const MSL_OUTPUTS = [
		{
			outputKey: "mirror-1",
			credentialId: "credential-msl",
			streamId: 1,
			eventName: "ev",
			streamFormat: "CMAF" as const,
			mslVersion: "MSL4",
			eventRoot: EDGE,
		},
	];
	const PROVIDER_OUTPUT_IDS = { "mirror-1": "provider-output-mirror-1" };

	// Only `readEdge` is exercised; the rest satisfy the type.
	const baseDeps: LiveRunnerDeps = {
		api: async () => ({ status: 200, json: null }),
		readText: async () => "",
		listAll: async () => [],
		sleep: async () => {},
		now: () => 0,
	};

	// live-akamai-msl-storage's HLS manifest, mirrored to an AKAMAI_MSL output.
	// The DASH leg is filtered out so this test targets exactly the master →
	// children → segments closure the audit names.
	function hlsExpected() {
		const rewritten = rewriteLiveForRun(
			liveChannelPlanSchema.parse(plan("live-akamai-msl-storage")),
			{ ...REWRITE, startTimeoutSec: 60, feedSeconds: 30 },
		);
		const full = compileExpectedLiveArtefacts(rewritten);
		const hls = full.manifests.find((manifest) => manifest.kind === "HLS");
		return {
			...full,
			muxings: full.muxings.slice(0, 1),
			manifests: hls
				? [
						{
							...hls,
							muxingKeys: hls.muxingKeys.slice(0, 1),
							mediaPlaylists: hls.mediaPlaylists.slice(0, 1),
						},
					]
				: [],
		};
	}

	const MASTER =
		"#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=4500000\nvideo_4500000.m3u8\n";
	const CHILD = `#EXTM3U
#EXT-X-MAP:URI="${RUN_PREFIX}output/live-akamai-msl-storage/init.mp4"
#EXTINF:6,
${RUN_PREFIX}output/live-akamai-msl-storage/seg-1.m4s
#EXTINF:6,
${RUN_PREFIX}output/live-akamai-msl-storage/seg-2.m4s
#EXT-X-ENDLIST
`;

	/** A tiny edge that serves master → one child → init + 2 segments. */
	function edge(opts: { segStatus?: number } = {}) {
		const urls: string[] = [];
		const readEdge = async (url: string) => {
			urls.push(url);
			if (url.endsWith("stream.m3u8")) {
				return { status: 200, bytes: MASTER.length, text: MASTER };
			}
			if (url.endsWith(".m3u8")) {
				return { status: 200, bytes: CHILD.length, text: CHILD };
			}
			// A segment (init.mp4 / seg-*.m4s).
			const status = opts.segStatus ?? 200;
			const body = status < 300 ? "mp4-bytes" : "";
			return { status, bytes: body.length, text: body };
		};
		return { urls, readEdge };
	}

	it("closes event-root master → event-root child → current-run init + segments", async () => {
		const { urls, readEdge } = edge();
		const closures = await collectEdgeClosures(
			{ ...baseDeps, readEdge },
			hlsExpected(),
			MSL_OUTPUTS,
			PROVIDER_OUTPUT_IDS,
			RUN_PREFIX,
		);
		expect(closures).toHaveLength(1);
		const c = closures[0];
		expect(c?.closed).toBe(true);
		expect(c?.childCount).toBe(1);
		// init + seg-1 + seg-2 were ACTUALLY read from the edge, not just counted
		// off the playlist — the whole point of a closure. Since
		// EV-02 the init is witnessed separately: `segmentCount` is MEDIA only.
		expect(c?.segmentCount).toBe(2);
		expect(c?.children?.[0]?.served.filter((s) => s.init)).toHaveLength(1);
		expect(
			c?.children?.[0]?.served.every(
				(s) => s.bytes > 0 && /^[0-9a-f]{64}$/.test(s.sha256),
			),
		).toBe(true);
		// Akamai MSL4 publishes playlists directly at the event root. Only init
		// and media URLs are allowed beneath the run-unique prefix.
		expect(urls).toContain(`${EDGE}stream.m3u8`);
		expect(urls).toContain(`${EDGE}video_4500000.m3u8`);
		expect(urls).toContain(
			`${EDGE_RUN}output/live-akamai-msl-storage/seg-1.m4s`,
		);
		expect(urls).toContain(
			`${EDGE_RUN}output/live-akamai-msl-storage/seg-2.m4s`,
		);
		expect(urls.every((u) => u.startsWith(EDGE))).toBe(true);
	});

	it("does NOT close when the edge 404s the segments — a mirror delivering nothing FAILs", async () => {
		const { readEdge } = edge({ segStatus: 404 });
		const closures = await collectEdgeClosures(
			{ ...baseDeps, readEdge },
			hlsExpected(),
			MSL_OUTPUTS,
			PROVIDER_OUTPUT_IDS,
			RUN_PREFIX,
		);
		const c = closures[0];
		expect(c?.closed).toBe(false);
		expect((c?.missing ?? []).length).toBeGreaterThan(0);
		expect(
			c?.missing?.some((m) => /seg-\d\.m4s \(HTTP 404, 0 bytes\)/.test(m)),
			`missing should name a 404 segment; saw ${JSON.stringify(c?.missing)}`,
		).toBe(true);
	});

	it("does not fetch the edge when the current airing has no exact provider output id", async () => {
		const { urls, readEdge } = edge();
		const closures = await collectEdgeClosures(
			{ ...baseDeps, readEdge },
			hlsExpected(),
			MSL_OUTPUTS,
			{},
			RUN_PREFIX,
		);
		expect(urls).toEqual([]);
		expect(closures).toHaveLength(1);
		expect(closures[0]?.closed).toBe(false);
		expect(closures[0]?.error).toMatch(/provider output id.*missing/i);
	});

	it("returns NOTHING (every leg UNOBSERVED) when no edge base URL is configured", async () => {
		const { readEdge } = edge();
		expect(
			await collectEdgeClosures(
				{ ...baseDeps, readEdge },
				hlsExpected(),
				MSL_OUTPUTS.map(({ eventRoot: _eventRoot, ...output }) => output),
				PROVIDER_OUTPUT_IDS,
				RUN_PREFIX,
			),
		).toEqual([]);
		expect(
			await collectEdgeClosures(
				{ ...baseDeps, readEdge },
				hlsExpected(),
				[],
				PROVIDER_OUTPUT_IDS,
				RUN_PREFIX,
			),
		).toEqual([]);
	});

	it("returns NOTHING for a plan with no MSL mirror, whatever the edge holds", async () => {
		const { readEdge } = edge();
		const plain = compileExpectedLiveArtefacts(
			liveChannelPlanSchema.parse(plan("live-rtmp-simple")),
		);
		expect(
			await collectEdgeClosures(
				{ ...baseDeps, readEdge },
				plain,
				MSL_OUTPUTS,
				PROVIDER_OUTPUT_IDS,
				RUN_PREFIX,
			),
		).toEqual([]);
	});
});

/**
 * The durable intent around the channel create.
 * The create used to sit ABOVE the `try/finally`: a POST that
 * threw after the server had created the channel ran no teardown at all, and
 * a channel that bills from creation was nobody's. These drive the runner
 * through a fake intent handle that records every write, and a product whose
 * create can throw, answer 5xx, or answer with no id.
 */
describe("the durable intent around the channel create (EV-01)", () => {
	const KEY = "verify:RUN1:live-rtmp-simple:LIVE_CHANNEL";
	const ADOPTED = "11111111-1111-4111-8111-111111111111";
	const DISPATCH_FENCE = {
		verificationRunId: "00000000-0000-4000-8000-000000000001",
		runGeneration: 0,
		intentId: "00000000-0000-4000-8000-000000000002",
		intentGeneration: 1,
		token: "verify-dispatch:RUN1:123:11111111-1111-4111-8111-111111111111",
	};

	function fakeIntent(
		opts: {
			prepareThrows?: boolean;
			submittedThrows?: boolean;
			confirmedThrows?: boolean;
			captureThrows?: boolean;
			ambiguousThrows?: boolean;
			resolveThrows?: boolean;
			resolveWith?: IntentResolution;
		} = {},
	) {
		const events: string[] = [];
		const terminalInputs: Parameters<IntentHandle["terminal"]>[0][] = [];
		const handle: IntentHandle = {
			key: KEY,
			kind: "LIVE_CHANNEL",
			requestSha256: "",
			submitted: async () => {
				events.push("submitted");
				if (opts.submittedThrows) {
					throw new Error("intent store down");
				}
				return DISPATCH_FENCE;
			},
			confirmed: async (localId) => {
				events.push(`confirmed:${localId}`);
				if (opts.confirmedThrows) {
					throw new Error("intent confirmation write rejected");
				}
			},
			recordCreateResponseId: async (localId) => {
				events.push(`capture:${localId}`);
				if (opts.captureThrows) {
					throw new Error("CREATE response ID write rejected");
				}
			},
			neverSent: async (reason) => {
				events.push(`neverSent:${reason}`);
			},
			refused: async (reason) => {
				events.push(`refused:${reason}`);
			},
			ambiguous: async (reason) => {
				events.push(`ambiguous:${reason}`);
				if (opts.ambiguousThrows) {
					throw new Error("intent ambiguous write rejected");
				}
			},
			resolve: async () => {
				events.push("resolve");
				if (opts.resolveThrows) {
					throw new Error("intent lookup rejected");
				}
				return (
					opts.resolveWith ?? {
						adopted: false,
						reason: "no local row carries its key or marker yet",
						candidates: [],
					}
				);
			},
			terminal: async (input) => {
				terminalInputs.push(input);
				events.push(`terminal:${input.cleanupState}`);
			},
			localId: () => undefined,
		};
		const hooks: LiveIntentHooks = {
			key: KEY,
			prepare: async (input) => {
				events.push(`prepare:${input.resourceName}`);
				if (opts.prepareThrows) {
					throw new Error("intent store down");
				}
				handle.requestSha256 = input.requestSha256;
				return handle;
			},
			resolveTerminal: async (channelId, product) => {
				const localKey = `local:LIVE_CHANNEL:${channelId}`;
				const providerKey = product.providerId
					? `provider:BITMOVIN_ENCODING:${product.providerId}`
					: undefined;
				const clean =
					product.cleanup.localClean &&
					product.stopFailures.length === 0 &&
					providerKey !== undefined;
				return {
					cleanupState: clean ? "CLEANED" : "UNRESOLVED",
					readback: {
						channelId,
						...product,
						providerStatuses: product.providerId
							? [{ encodingId: product.providerId, status: "CANCELED" }]
							: [],
						providerTerminalObservedAt: "2026-08-31T00:00:00.000Z",
						providerIdentityComplete: providerKey !== undefined,
						providerIdentityConflict: false,
						providerProofUncertain: false,
					},
					providerId: product.providerId ?? null,
					providerIds: product.providerId ? [product.providerId] : [],
					possiblyCreatedKeys: [
						localKey,
						...(providerKey ? [providerKey] : []),
					],
					cleanedResourceKeys: [
						...(product.cleanup.localTerminal.established ? [localKey] : []),
						...(providerKey && clean ? [providerKey] : []),
					],
					...(clean
						? {}
						: {
								error: "fake exact provider-set resolver did not prove cleanup",
							}),
				};
			},
		};
		return { hooks, handle, events, terminalInputs };
	}

	/**
	 * The product, with the create POST observable: its body, its position in
	 * the event order, and — when `create` is given — a scripted answer.
	 */
	function observed(
		deps: LiveRunnerDeps,
		events: string[],
		create?: (body: unknown) => Promise<{ status: number; json: unknown }>,
	) {
		const bodies: Record<string, unknown>[] = [];
		const api: LiveRunnerDeps["api"] = async (path, init) => {
			if (init?.method === "POST" && path === "/api/live-channels") {
				events.push("POST /api/live-channels");
				bodies.push(init.body as Record<string, unknown>);
				if (create) {
					return create(init.body);
				}
			}
			return deps.api(path, init);
		};
		return { deps: { ...deps, api }, bodies };
	}

	const run = (
		deps: LiveRunnerDeps,
		hooks: LiveIntentHooks,
		postCreateResponseLossCanary?: ReturnType<
			typeof createPostCreateResponseLossCanary
		>,
	) =>
		runLiveScenario(deps, {
			plan: plan("live-rtmp-simple"),
			scenario: "live-rtmp-simple",
			feed: FEED,
			feedSeconds: 30,
			startTimeoutSec: 60,
			rewrite: { ...REWRITE, channelName: "UC live-rtmp-simple [verify RUN1]" },
			intent: hooks,
			...(postCreateResponseLossCanary ? { postCreateResponseLossCanary } : {}),
		});

	const posts = (events: string[]) =>
		events.filter((e) => e === "POST /api/live-channels").length;

	it("commits PREPARED then SUBMITTED BEFORE the POST, sends the key + SHA, confirms the id and closes CLEANED", async () => {
		const { hooks, handle, events, terminalInputs } = fakeIntent();
		const base = fakeProduct();
		const { deps, bodies } = observed(base.deps, events);
		const result = await run(deps, hooks);
		expect(result.invalid, result.invalid).toBeUndefined();
		expect(events.slice(0, 5)).toEqual([
			"prepare:UC live-rtmp-simple [verify RUN1]",
			"submitted",
			"POST /api/live-channels",
			`capture:${ADOPTED}`,
			`confirmed:${ADOPTED}`,
		]);
		expect(events.at(-1)).toBe("terminal:CLEANED");
		expect(bodies[0]?.verificationKey).toBe(KEY);
		expect(bodies[0]?.requestSha256).toMatch(/^[0-9a-f]{64}$/);
		expect(bodies[0]?.requestSha256).toBe(handle.requestSha256);
		expect(bodies[0]?.verificationDispatch).toEqual(DISPATCH_FENCE);
		expect(
			(
				bodies[0]?.plan as {
					bitmovin?: { labels?: string[] };
				}
			)?.bitmovin?.labels,
		).toContain(`verify-key:${KEY}`);
		expect(terminalInputs.at(-1)).toMatchObject({
			providerIds: ["enc-live-1"],
			possiblyCreatedKeys: [
				`local:LIVE_CHANNEL:${ADOPTED}`,
				"provider:BITMOVIN_ENCODING:enc-live-1",
			],
			cleanedResourceKeys: [
				`local:LIVE_CHANNEL:${ADOPTED}`,
				"provider:BITMOVIN_ENCODING:enc-live-1",
			],
		});
	});

	it("injects response loss only after a successful Live CREATE, adopts and continues, with exactly one POST and clean closure", async () => {
		const { hooks, events } = fakeIntent({
			resolveWith: {
				adopted: true,
				localId: ADOPTED,
				providerId: null,
				candidates: [
					{
						localId: ADOPTED,
						matchedBy: ["key"],
						status: "PROVISIONING",
						providerId: null,
						requestSha256: "a".repeat(64),
					},
				],
			},
		});
		const base = fakeProduct();
		const { deps } = observed(base.deps, events);
		const canary = createPostCreateResponseLossCanary("live-rtmp-simple");

		const result = await run(deps, hooks, canary);

		expect(result.invalid, result.invalid).toBeUndefined();
		expect(posts(events)).toBe(1);
		expect(
			events.some((event) => event.startsWith("ambiguous:fault injection:")),
		).toBe(true);
		expect(events).toContain("resolve");
		const capture = events.indexOf(`capture:${ADOPTED}`);
		const ambiguous = events.findIndex((event) =>
			event.startsWith("ambiguous:fault injection:"),
		);
		const resolve = events.indexOf("resolve");
		expect(capture).toBeGreaterThan(events.indexOf("POST /api/live-channels"));
		expect(capture).toBeLessThan(ambiguous);
		expect(ambiguous).toBeLessThan(resolve);
		expect(base.calls).toContain("POST /api/live-channels/<id>/actions");
		expect(events.at(-1)).toBe("terminal:CLEANED");
		expect(canaryCompletionError(canary)).toBeUndefined();
	});

	it.each([
		["CREATE response ID persistence", { captureThrows: true }],
		["ambiguous persistence", { ambiguousThrows: true }],
		["intent lookup", { resolveThrows: true }],
	] as const)("still tears down the exact known-created Live channel when %s throws after injection", async (_name, failure) => {
		const { hooks, events, terminalInputs } = fakeIntent(failure);
		const base = fakeProduct();
		const { deps } = observed(base.deps, events);
		const canary = createPostCreateResponseLossCanary("live-rtmp-simple");

		const result = await run(deps, hooks, canary);

		expect(result.invalid).toMatch(/harness error/);
		expect(posts(events)).toBe(1);
		expect(
			base.calls.filter(
				(call) => call === "POST /api/live-channels/<id>/actions",
			),
		).toHaveLength(1);
		expect(events.at(-1)).toBe("terminal:CLEANED");
		expect(terminalInputs.at(-1)?.readback).toMatchObject({
			channelId: ADOPTED,
		});
		expect(canaryCompletionError(canary)).toBeDefined();
	});

	it("does not let a failed provider-identity write block teardown of the known-created channel", async () => {
		const { hooks, events, terminalInputs } = fakeIntent({
			ambiguousThrows: true,
			confirmedThrows: true,
		});
		const base = fakeProduct();
		const { deps } = observed(base.deps, events);
		const canary = createPostCreateResponseLossCanary("live-rtmp-simple");

		const result = await run(deps, hooks, canary);

		expect(result.invalid).toMatch(/harness error/);
		expect(posts(events)).toBe(1);
		expect(
			base.calls.filter(
				(call) => call === "POST /api/live-channels/<id>/actions",
			),
		).toHaveLength(1);
		expect(events.at(-1)).toBe("terminal:UNRESOLVED");
		expect(terminalInputs.at(-1)?.readback).toMatchObject({
			channelId: ADOPTED,
		});
	});

	it("fails closed on a mismatched Live adoption and includes both channel ids in bounded cleanup", async () => {
		const createdId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
		const { hooks, events, terminalInputs } = fakeIntent({
			resolveWith: {
				adopted: true,
				localId: ADOPTED,
				providerId: null,
				candidates: [
					{
						localId: ADOPTED,
						matchedBy: ["key"],
						status: "PROVISIONING",
						providerId: null,
						requestSha256: "a".repeat(64),
					},
				],
			},
		});
		const base = fakeProduct();
		const { deps } = observed(base.deps, events, async () => ({
			status: 201,
			json: { id: createdId },
		}));
		const canary = createPostCreateResponseLossCanary("live-rtmp-simple");

		const result = await run(deps, hooks, canary);

		expect(result.invalid).toMatch(/both resources.*bounded cleanup/);
		expect(posts(events)).toBe(1);
		expect(
			base.calls.filter(
				(call) => call === "POST /api/live-channels/<id>/actions",
			),
		).toHaveLength(2);
		expect(canaryCompletionError(canary)).toMatch(
			/not the successfully created/,
		);
		expect(terminalInputs.at(-1)).toMatchObject({
			cleanupState: "CLEANED",
			possiblyCreatedKeys: expect.arrayContaining([
				`local:LIVE_CHANNEL:${createdId}`,
				`local:LIVE_CHANNEL:${ADOPTED}`,
			]),
			cleanedResourceKeys: expect.arrayContaining([
				`local:LIVE_CHANNEL:${createdId}`,
				`local:LIVE_CHANNEL:${ADOPTED}`,
			]),
		});
	});

	it("uses the injected exact-provider-set resolver for normal finally closure", async () => {
		const { hooks, events, terminalInputs } = fakeIntent();
		const resolveTerminal = vi.fn(async () => ({
			cleanupState: "UNRESOLVED" as const,
			readback: {
				providerIdentityConflict: true,
				providerIds: ["enc-live-1", "enc-hidden-duplicate"],
			},
			providerId: "enc-live-1",
			providerIds: ["enc-hidden-duplicate", "enc-live-1"],
			possiblyCreatedKeys: [
				`local:LIVE_CHANNEL:${ADOPTED}`,
				"provider:BITMOVIN_ENCODING:enc-hidden-duplicate",
				"provider:BITMOVIN_ENCODING:enc-live-1",
			],
			cleanedResourceKeys: [`local:LIVE_CHANNEL:${ADOPTED}`],
			error: "duplicate provider identity",
		}));
		hooks.resolveTerminal = resolveTerminal;
		const result = await run(fakeProduct().deps, hooks);

		expect(result.invalid).toBeUndefined();
		expect(resolveTerminal).toHaveBeenCalledWith(
			ADOPTED,
			expect.objectContaining({
				providerId: "enc-live-1",
				stopFailures: [],
				cleanup: expect.objectContaining({
					localClean: true,
					clean: false,
				}),
			}),
		);
		expect(events.at(-1)).toBe("terminal:UNRESOLVED");
		expect(terminalInputs.at(-1)).toMatchObject({
			providerIds: ["enc-hidden-duplicate", "enc-live-1"],
			cleanedResourceKeys: [`local:LIVE_CHANNEL:${ADOPTED}`],
		});
	});

	it("does not invalidate an already-stopped 409 after the exact resolver closes the same resource set CLEANED", async () => {
		const { hooks, events } = fakeIntent();
		hooks.resolveTerminal = async (channelId, product) => {
			expect(product.stopFailures).toEqual([
				`channel ${channelId} refused the stop: HTTP 409`,
			]);
			const localKey = `local:LIVE_CHANNEL:${channelId}`;
			const providerKey = "provider:BITMOVIN_ENCODING:enc-live-1";
			return {
				cleanupState: "CLEANED",
				readback: { ...product, redundantStopFailures: product.stopFailures },
				providerId: "enc-live-1",
				providerIds: ["enc-live-1"],
				possiblyCreatedKeys: [localKey, providerKey],
				cleanedResourceKeys: [localKey, providerKey],
			};
		};

		const result = await run(
			fakeProduct({ channelStopStatus: 409 }).deps,
			hooks,
		);
		expect(result.invalid, result.invalid).toBeUndefined();
		expect(events.at(-1)).toBe("terminal:CLEANED");
		expect(result.cleanup?.localClean).toBe(true);
	});

	it("does not persist provider-terminal or clean claims when local STOPPED/null but EV-01 still reads RUNNING", async () => {
		const { hooks, terminalInputs } = fakeIntent();
		hooks.resolveTerminal = async (channelId, product) => ({
			cleanupState: "UNRESOLVED",
			readback: {
				channelId,
				...product,
				providerStatuses: [{ encodingId: "enc-live-1", status: "RUNNING" }],
				providerTerminalObservedAt: "2026-08-31T00:00:00.000Z",
				providerIdentityComplete: true,
				providerIdentityConflict: false,
				providerProofUncertain: false,
			},
			providerId: "enc-live-1",
			providerIds: ["enc-live-1"],
			possiblyCreatedKeys: [
				`local:LIVE_CHANNEL:${ADOPTED}`,
				"provider:BITMOVIN_ENCODING:enc-live-1",
			],
			cleanedResourceKeys: [`local:LIVE_CHANNEL:${ADOPTED}`],
			error: "exact provider encoding is still RUNNING",
		});

		const result = await run(fakeProduct().deps, hooks);

		expect(result.cleanup).toMatchObject({
			localTerminal: { established: true },
			localClean: true,
			providerTerminal: { established: false },
			clean: false,
		});
		expect(result.cleanup?.providerTerminal.detail).not.toMatch(
			/confirmed the provider stop/i,
		);
		expect(terminalInputs.at(-1)?.readback).toMatchObject({
			cleanup: {
				localClean: true,
				providerTerminal: { established: false },
				clean: false,
			},
			providerStatuses: [{ encodingId: "enc-live-1", status: "RUNNING" }],
		});
		expect(result.evidence?.every((leg) => !leg.complete)).toBe(true);
	});

	it("fails closed when a runtime caller omits the exact-provider-set resolver", async () => {
		const { hooks, events, terminalInputs } = fakeIntent();
		delete (hooks as Partial<LiveIntentHooks>).resolveTerminal;
		await run(fakeProduct().deps, hooks);

		expect(events.at(-1)).toBe("terminal:UNRESOLVED");
		expect(terminalInputs.at(-1)).toMatchObject({
			cleanupState: "UNRESOLVED",
			providerIds: ["enc-live-1"],
			cleanedResourceKeys: [`local:LIVE_CHANNEL:${ADOPTED}`],
			error: expect.stringContaining("provider-set resolver is missing"),
		});
	});

	it("a PREPARED write that fails means NOTHING is posted", async () => {
		const { hooks, events } = fakeIntent({ prepareThrows: true });
		const { deps } = observed(fakeProduct().deps, events);
		const result = await run(deps, hooks);
		expect(result.invalid).toMatch(/durable intent could not be recorded/);
		expect(posts(events)).toBe(0);
	});

	it("a SUBMITTED write that fails means NOTHING is sent", async () => {
		const { hooks, events } = fakeIntent({ submittedThrows: true });
		const { deps } = observed(fakeProduct().deps, events);
		const result = await run(deps, hooks);
		expect(result.invalid).toMatch(/nothing was sent/);
		expect(posts(events)).toBe(0);
		expect(events).not.toContain("resolve");
	});

	it("a create that never left (ECONNREFUSED) is never-sent — no lookup, no stop, no seal", async () => {
		const { hooks, events } = fakeIntent();
		const base = fakeProduct();
		const { deps } = observed(base.deps, events, async () => {
			throw Object.assign(new TypeError("fetch failed"), {
				cause: Object.assign(new Error("connect ECONNREFUSED"), {
					code: "ECONNREFUSED",
				}),
			});
		});
		const result = await run(deps, hooks);
		expect(result.invalid).toMatch(/never left/);
		expect(events.some((e) => e.startsWith("neverSent:"))).toBe(true);
		expect(events).not.toContain("resolve");
		expect(events.some((e) => e.startsWith("terminal:"))).toBe(false);
		expect(base.calls.some((c) => c.includes("/actions"))).toBe(false);
	});

	it("a create whose response was LOST is AMBIGUOUS: looked up by key, adopted, torn down, closed — and NEVER re-posted", async () => {
		const { hooks, events } = fakeIntent({
			resolveWith: {
				adopted: true,
				localId: ADOPTED,
				providerId: null,
				candidates: [
					{
						localId: ADOPTED,
						matchedBy: ["key"],
						status: "PROVISIONING",
						providerId: null,
						requestSha256: "a".repeat(64),
					},
				],
			},
		});
		const base = fakeProduct();
		const { deps } = observed(base.deps, events, async () => {
			throw new Error("socket hang up");
		});
		const result = await run(deps, hooks);
		expect(result.invalid).toMatch(
			/found by its verification key and torn down/,
		);
		expect(result.channelId).toBe(ADOPTED);
		// The mutation "make AMBIGUOUS a retry" goes red HERE: exactly one POST.
		expect(posts(events)).toBe(1);
		const ambiguous = events.findIndex((e) => e.startsWith("ambiguous:"));
		expect(ambiguous).toBeGreaterThan(-1);
		expect(events.indexOf("resolve")).toBeGreaterThan(ambiguous);
		expect(events.at(-1)).toBe("terminal:CLEANED");
		expect(base.calls).toContain("POST /api/live-channels/<id>/actions");
	});

	it("a lost response with NO candidate stays UNRESOLVED — nothing is stopped and the intent is not closed as clean", async () => {
		const { hooks, events } = fakeIntent();
		const base = fakeProduct();
		const { deps } = observed(base.deps, events, async () => {
			throw new Error("socket hang up");
		});
		const result = await run(deps, hooks);
		expect(result.invalid).toMatch(/UNRESOLVED/);
		expect(result.channelId).toBeUndefined();
		expect(events).toContain("resolve");
		expect(events.some((e) => e.startsWith("terminal:"))).toBe(false);
		expect(base.calls.some((c) => c.includes("/actions"))).toBe(false);
		expect(posts(events)).toBe(1);
	});

	it("a 5xx create is ambiguous too (the route marks the row ERROR after an enqueue failure and rethrows — the row EXISTS)", async () => {
		const { hooks, events } = fakeIntent({
			resolveWith: {
				adopted: true,
				localId: ADOPTED,
				providerId: null,
				candidates: [],
			},
		});
		const base = fakeProduct();
		const { deps } = observed(base.deps, events, async () => ({
			status: 500,
			json: { error: "Internal error" },
		}));
		const result = await run(deps, hooks);
		expect(result.invalid).toMatch(/HTTP 500.*found by its verification key/);
		expect(events.some((e) => e.startsWith("ambiguous:HTTP 500"))).toBe(true);
		expect(events).toContain("resolve");
		expect(base.calls).toContain("POST /api/live-channels/<id>/actions");
		expect(events.at(-1)).toMatch(/^terminal:/);
	});

	it("an unknown 4xx is ambiguous — a proxy response cannot prove the route created nothing", async () => {
		const { hooks, events } = fakeIntent();
		const base = fakeProduct();
		const { deps } = observed(base.deps, events, async () => ({
			status: 400,
			json: { error: "Validation failed" },
		}));
		const result = await run(deps, hooks);
		expect(result.invalid).toMatch(/UNRESOLVED/);
		expect(events.some((e) => e.startsWith("ambiguous:HTTP 400"))).toBe(true);
		expect(events).toContain("resolve");
		expect(base.calls.some((c) => c.includes("/actions"))).toBe(false);
	});

	it.each([
		408, 425, 429,
	])("HTTP %i is ambiguous and looked up", async (status) => {
		const { hooks, events } = fakeIntent();
		const { deps } = observed(fakeProduct().deps, events, async () => ({
			status,
			json: { error: "gateway response" },
		}));
		await run(deps, hooks);
		expect(events.some((e) => e.startsWith(`ambiguous:HTTP ${status}`))).toBe(
			true,
		);
		expect(events).toContain("resolve");
	});

	it("a machine-readable different-SHA 409 enters lookup but never adopts the mismatched channel as evidence", async () => {
		const { hooks, events } = fakeIntent({
			resolveWith: {
				adopted: false,
				reason:
					"the exact-key channel carries a different request SHA; teardown owns cleanup only",
				candidates: [
					{
						localId: ADOPTED,
						matchedBy: ["key"],
						status: "RUNNING",
						providerId: null,
						requestSha256: "b".repeat(64),
					},
				],
			},
		});
		const base = fakeProduct();
		const { deps } = observed(base.deps, events, async () => ({
			status: 409,
			json: {
				error: "verificationKey was already used for a different request",
				details: { code: "VERIFICATION_KEY_SHA_CONFLICT" },
			},
		}));
		const result = await run(deps, hooks);
		expect(result.invalid).toMatch(/HTTP 409.*different request SHA/);
		expect(events.some((e) => e.startsWith("ambiguous:HTTP 409"))).toBe(true);
		expect(events.some((e) => e.startsWith("refused:"))).toBe(false);
		expect(events).toContain("resolve");
		expect(base.calls).not.toContain("POST /api/live-channels/<id>/actions");
		expect(events.some((event) => event.startsWith("terminal:"))).toBe(false);
	});

	it("a 2xx with no channel id is ambiguous — the body may simply not have parsed", async () => {
		const { hooks, events } = fakeIntent();
		const { deps } = observed(fakeProduct().deps, events, async () => ({
			status: 201,
			json: null,
		}));
		await run(deps, hooks);
		expect(
			events.some((e) => e.startsWith("ambiguous:HTTP 201 with no channel id")),
		).toBe(true);
		expect(events).toContain("resolve");
	});

	it("an exception AFTER the create still stops the channel and closes the intent through finally", async () => {
		const { hooks, events } = fakeIntent();
		const base = fakeProduct();
		const { deps } = observed(base.deps, events);
		const throwing: LiveRunnerDeps = {
			...deps,
			api: async (path, init) => {
				if (
					init?.method === "POST" &&
					path.endsWith("/actions") &&
					(init.body as { action?: string } | undefined)?.action === "start"
				) {
					throw new Error("start POST reset");
				}
				return deps.api(path, init);
			},
		};
		const result = await run(throwing, hooks);
		expect(result.invalid).toMatch(/harness error: start POST reset/);
		expect(events).toContain(`confirmed:${ADOPTED}`);
		expect(events.at(-1)).toMatch(/^terminal:/);
		expect(base.calls).toContain("POST /api/live-channels/<id>/actions");
	});

	it("a teardown the product never confirmed closes the intent UNRESOLVED, not CLEANED", async () => {
		const { hooks, events } = fakeIntent();
		const { deps } = observed(
			fakeProduct({ stoppedStatus: "STOPPING" }).deps,
			events,
		);
		const result = await run(deps, hooks);
		expect(result.invalid).toMatch(/could not be torn down/);
		expect(events.at(-1)).toBe("terminal:UNRESOLVED");
	});

	it("a clean-looking local stop without an exact provider id stays UNRESOLVED", async () => {
		const { hooks, events } = fakeIntent();
		const { deps } = observed(fakeProduct({ noProviderId: true }).deps, events);
		await run(deps, hooks);
		expect(events.at(-1)).toBe("terminal:UNRESOLVED");
	});
});

describe("teardownAdoptedChannel — the run-level teardown of a channel adopted by its key (EV-01)", () => {
	const CHANNEL = "11111111-1111-4111-8111-111111111111";

	it("stops the channel and returns a locally clean seal awaiting EV-01 readback", async () => {
		const { deps, calls } = fakeProduct();
		const torn = await teardownAdoptedChannel(deps, CHANNEL);
		expect(calls).toContain("POST /api/live-channels/<id>/actions");
		expect(torn.stopFailures).toEqual([]);
		expect(torn.cleanup.localClean).toBe(true);
		expect(torn.cleanup.clean).toBe(false);
		expect(torn.cleanup.providerTerminal.established).toBe(false);
		expect(torn.providerId).toBe("enc-live-1");
	});

	it("stops a feeder the product lists as still pushing BEFORE the channel", async () => {
		const { deps, calls } = fakeProduct();
		const withFeeder: LiveRunnerDeps = {
			...deps,
			api: async (path, init) => {
				if (
					(init?.method ?? "GET") === "GET" &&
					path.startsWith("/api/feeder-sessions?")
				) {
					return {
						status: 200,
						json: {
							items: [
								{
									id: "f1",
									status: "PUSHING",
									pid: null,
									processGoneAt: new Date().toISOString(),
									startedAt: new Date().toISOString(),
									queued: false,
								},
							],
						},
					};
				}
				return deps.api(path, init);
			},
		};
		await teardownAdoptedChannel(withFeeder, CHANNEL);
		const feederStop = calls.indexOf("POST /api/feeder-sessions/f1/actions");
		const channelStop = calls.indexOf("POST /api/live-channels/<id>/actions");
		expect(feederStop).toBeGreaterThan(-1);
		expect(channelStop).toBeGreaterThan(feederStop);
	});

	it("a stop the product never confirms is a recorded failure, and the seal is NOT clean", async () => {
		const { deps } = fakeProduct({ stoppedStatus: "STOPPING" });
		const torn = await teardownAdoptedChannel(deps, CHANNEL);
		expect(torn.stopFailures.join(" ")).toMatch(/never CONFIRMED/);
		expect(torn.cleanup.clean).toBe(false);
	});
});

describe("the evidence tuple rides on the result", () => {
	const EVIDENCE = {
		commit: "b8c63e35",
		image: `worker@sha256:${"c".repeat(64)}`,
	};
	function evidenceIntent(): LiveIntentHooks {
		let requestSha256 = "";
		const handle: IntentHandle = {
			key: "verify:RUN1:evidence:LIVE_CHANNEL",
			kind: "LIVE_CHANNEL",
			requestSha256,
			submitted: async () => ({
				verificationRunId: "00000000-0000-4000-8000-000000000021",
				runGeneration: 0,
				intentId: "00000000-0000-4000-8000-000000000022",
				intentGeneration: 1,
				token: "verify-dispatch:evidence:33333333-3333-4333-8333-333333333333",
			}),
			confirmed: async () => undefined,
			recordCreateResponseId: async () => undefined,
			neverSent: async () => undefined,
			refused: async () => undefined,
			ambiguous: async () => undefined,
			resolve: async () => ({
				adopted: false,
				reason: "unused",
				candidates: [],
			}),
			terminal: async () => undefined,
			localId: () => undefined,
		};
		return {
			key: handle.key,
			prepare: async (input) => {
				requestSha256 = input.requestSha256;
				handle.requestSha256 = requestSha256;
				return handle;
			},
			resolveTerminal: async (channelId, product) => {
				const providerId = product.providerId;
				const clean =
					product.cleanup.localClean &&
					product.stopFailures.length === 0 &&
					providerId !== undefined;
				return {
					cleanupState: clean ? "CLEANED" : "UNRESOLVED",
					readback: {
						channelId,
						...product,
						providerStatuses: providerId
							? [{ encodingId: providerId, status: "CANCELED" }]
							: [],
						providerTerminalObservedAt: "2026-08-31T00:00:00.000Z",
						providerIdentities: [],
						providerIdentityComplete: true,
						providerIdentityConflict: false,
						providerProofUncertain: false,
					},
					providerId: providerId ?? null,
					providerIds: providerId ? [providerId] : [],
					possiblyCreatedKeys: [],
					cleanedResourceKeys: [],
					...(clean ? {} : { error: "provider cleanup unresolved" }),
				};
			},
		};
	}

	it("a healthy origin-only run yields one COMPLETE ORIGIN leg per manifest, bound to the commit, source, airing and provider encoding", async () => {
		const { deps } = fakeProduct();
		const result = await runLiveScenario(deps, {
			plan: plan("live-rtmp-simple"),
			scenario: "live-rtmp-simple",
			feed: FEED,
			feedSeconds: 30,
			startTimeoutSec: 60,
			rewrite: REWRITE,
			evidence: EVIDENCE,
			intent: evidenceIntent(),
		});
		expect(result.invalid).toBeUndefined();
		const legs = result.evidence ?? [];
		expect(legs.length).toBeGreaterThan(0);
		expect(legs.every((l) => l.role === "ORIGIN")).toBe(true);
		expect(
			legs.map((l) => [l.outputLeg, l.complete, l.missing]),
			JSON.stringify(legs.map((l) => l.missing)),
		).toEqual(legs.map((l) => [l.outputLeg, true, []]));
		const first = legs[0];
		expect(first?.build.commit).toBe("b8c63e35");
		expect(first?.build.planSha256).toMatch(/^[0-9a-f]{64}$/);
		expect(first?.source).toEqual({
			location: "verify-in/bbb-short.mov",
			etag: '"source-etag"',
			versionId: "source-v1",
			size: 42,
			sha256: "a".repeat(64),
		});
		expect(first?.channel).toMatchObject({
			liveChannelRunId: "run-1",
			providerEncodingId: "enc-live-1",
		});
		expect(first?.output.prefix).toBe(REWRITE.prefix);
		expect(first?.probes).toHaveLength(2);
		expect(first?.progression.observed).toBe(true);
		expect(first?.master?.sha256).toMatch(/^[0-9a-f]{64}$/);
		// The seal carries the ids the tuple read them from.
		expect(result.cleanup).toMatchObject({
			liveChannelRunId: "run-1",
			providerEncodingId: "enc-live-1",
			localClean: true,
			providerTerminal: { established: true },
			clean: true,
		});
	});

	it("without the run's commit/image and feeder source seal the legs are INCOMPLETE and say which elements", async () => {
		const { deps } = fakeProduct({ sourceSeal: false });
		const result = await runLiveScenario(deps, {
			plan: plan("live-rtmp-simple"),
			scenario: "live-rtmp-simple",
			feed: FEED,
			feedSeconds: 30,
			startTimeoutSec: 60,
			rewrite: REWRITE,
		});
		const first = result.evidence?.[0];
		expect(first?.complete).toBe(false);
		expect(first?.missing.join("\n")).toMatch(/build\.commit/);
		expect(first?.missing.join("\n")).toMatch(/build\.image/);
		expect(first?.missing.join("\n")).toMatch(/source\.(etag|sha256|size)/);
	});

	/**
	 * An MSL mirror with the edge wired: the two SAMPLES probe the edge, the
	 * EDGE leg completes on progression between them, and the engine's mirror
	 * check PASSes on the same probes. The DASH manifest is dropped from the
	 * plan copy so the leg under test is exactly the HLS mirror; the ingest is
	 * swapped for plain RTMP so the static-key resolution path stays out of it.
	 */
	function mslHlsPlan(): unknown {
		const p = plan("live-akamai-msl-storage") as Record<string, unknown>;
		p.liveManifests = (p.liveManifests as { kind: string }[]).filter(
			(m) => m.kind === "HLS",
		);
		p.liveInput = (
			plan("live-rtmp-simple") as Record<string, unknown>
		).liveInput;
		return p;
	}
	function liveEdge(opts: { advance?: boolean } = {}) {
		let seq = 10;
		const urls: string[] = [];
		const readEdge = async (url: string) => {
			urls.push(url);
			if (url.endsWith("/stream.m3u8")) {
				const text = [
					"#EXTM3U",
					"#EXT-X-STREAM-INF:BANDWIDTH=4500000",
					"video_4500000.m3u8",
					"#EXT-X-STREAM-INF:BANDWIDTH=3000000",
					"video_3000000.m3u8",
					"#EXT-X-STREAM-INF:BANDWIDTH=800000",
					"video_800000.m3u8",
					'#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="en",URI="audio_128000.m3u8"',
				].join("\n");
				return { status: 200, bytes: text.length, text };
			}
			if (url.endsWith(".m3u8")) {
				if (opts.advance !== false) {
					seq += 2;
				}
				const mediaRoot = `${REWRITE.prefix}output/live-akamai-msl-storage/`;
				const text = `#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:${seq}\n#EXT-X-MAP:URI="${mediaRoot}init.mp4"\n#EXTINF:6,\n${mediaRoot}seg-${seq}.m4s\n#EXTINF:6,\n${mediaRoot}seg-${seq + 1}.m4s\n`;
				return { status: 200, bytes: text.length, text };
			}
			const body = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70]);
			// A real edge stamps every object; this one stamps it "now" in the
			// harness's world, i.e. after the fake run's epoch start (WP-C6b).
			return {
				status: 200,
				bytes: body.byteLength,
				text: "ftyp",
				body,
				lastModified: new Date(60_000).toUTCString(),
			};
		};
		return { urls, readEdge };
	}
	const EDGE_BASE = "https://edge.akamaized.net/cmaf/live/1/ev/";
	// The rewrite points the AKAMAI_MSL output at this credential; the schema
	// demands a UUID, so a placeholder like "5555" is an INVALID plan.
	const MSL_CREDENTIAL = "55555555-5555-4555-8555-555555555555";

	it("refuses an old MSL event root before creating a paid live channel", async () => {
		const { deps, calls } = fakeProduct();
		const result = await runLiveScenario(deps, {
			plan: mslHlsPlan(),
			scenario: "live-akamai-msl-storage",
			feed: FEED,
			feedSeconds: 30,
			startTimeoutSec: 60,
			rewrite: {
				...REWRITE,
				akamaiMsl: {
					credentialId: MSL_CREDENTIAL,
					streamId: 1,
					eventName: "ev",
					edgeBaseUrl: "https://edge.akamaized.net/cmaf/live/1/old-event/",
				},
			},
		});
		expect(result.invalid).toMatch(/does not match.*eventName/i);
		expect(calls).not.toContain("POST /api/live-channels");
	});

	it("with the edge wired, the samples probe it, the EDGE leg completes on progression, and the mirror check PASSes", async () => {
		const { deps } = fakeProduct();
		const channelPlan = liveChannelPlanSchema.parse(mslHlsPlan());
		const originalListing = deps.listAll;
		// The origin must emit the names this fixture declares, including literal tokens.
		deps.listAll = async (outputKey, prefix) => {
			const muxing = channelPlan.muxings.find(
				(m) => m.destination && prefix.endsWith(`${m.destination.path}/`),
			);
			if (!muxing || muxing.kind === "MP4")
				throw new Error("Unexpected listing route");
			return (await originalListing(outputKey, prefix)).map((object) => {
				const number = /segment_(\d+)\.m4s$/.exec(object.key)?.[1];
				return number
					? {
							...object,
							key: `${prefix}${muxing.segmentNaming.replace(/%number%/g, number)}`,
						}
					: object;
			});
		};
		const { urls, readEdge } = liveEdge();
		const result = await runLiveScenario(
			{ ...deps, readEdge },
			{
				plan: channelPlan,
				scenario: "live-akamai-msl-storage",
				feed: FEED,
				feedSeconds: 30,
				startTimeoutSec: 60,
				rewrite: {
					...REWRITE,
					akamaiMsl: {
						credentialId: MSL_CREDENTIAL,
						streamId: 1,
						eventName: "ev",
						edgeBaseUrl: EDGE_BASE,
					},
				},
				evidence: EVIDENCE,
				intent: evidenceIntent(),
			},
		);
		expect(result.invalid).toBeUndefined();
		const mirror = result.report?.checks.find(
			(c) => c.id === "live:mirror:hls:mirror-1",
		);
		expect(mirror?.verdict, mirror?.detail).toBe("PASS");
		expect(mirror?.detail).toContain("in-run probes");
		const legs = result.evidence ?? [];
		expect(legs.map((l) => [l.outputLeg, l.role, l.complete])).toEqual([
			["hls@origin", "ORIGIN", true],
			["hls@mirror-1", "EDGE", true],
		]);
		const edge = legs[1];
		expect(edge?.output.edge?.origin).toBe("https://edge.akamaized.net");
		expect(edge?.master?.sha256).toMatch(/^[0-9a-f]{64}$/);
		expect(
			edge?.children[0]?.media.every(
				(m) => m.bytes > 0 && /^[0-9a-f]{64}$/.test(m.sha256 ?? ""),
			),
		).toBe(true);
		expect(edge?.probes).toHaveLength(2);
		expect(edge?.progression.detail).toMatch(/media sequence \d+ → \d+/);
		// Every edge read stayed under the base, and the run prefix reached the edge.
		expect(urls.every((u) => u.startsWith(EDGE_BASE))).toBe(true);
		expect(urls.some((u) => u.includes(REWRITE.prefix))).toBe(true);
	});

	it("an edge that never advances leaves the EDGE leg incomplete and FAILs the mirror check — two identical snapshots", async () => {
		const { deps } = fakeProduct();
		const { readEdge } = liveEdge({ advance: false });
		const result = await runLiveScenario(
			{ ...deps, readEdge },
			{
				plan: mslHlsPlan(),
				scenario: "live-akamai-msl-storage",
				feed: FEED,
				feedSeconds: 30,
				startTimeoutSec: 60,
				rewrite: {
					...REWRITE,
					akamaiMsl: {
						credentialId: MSL_CREDENTIAL,
						streamId: 1,
						eventName: "ev",
						edgeBaseUrl: EDGE_BASE,
					},
				},
				evidence: EVIDENCE,
				intent: evidenceIntent(),
			},
		);
		const mirror = result.report?.checks.find(
			(c) => c.id === "live:mirror:hls:mirror-1",
		);
		expect(mirror?.verdict).toBe("FAIL");
		expect(mirror?.detail).toContain("identical media served");
		const edge = result.evidence?.find((l) => l.outputLeg === "hls@mirror-1");
		expect(edge?.complete).toBe(false);
		expect(edge?.missing.join("\n")).toMatch(/progression/);
	});

	it("with the event root configured but no edge reader, the mirror leg stays UNOBSERVED and the EDGE leg is incomplete", async () => {
		const { deps } = fakeProduct();
		const result = await runLiveScenario(deps, {
			plan: mslHlsPlan(),
			scenario: "live-akamai-msl-storage",
			feed: FEED,
			feedSeconds: 30,
			startTimeoutSec: 60,
			rewrite: {
				...REWRITE,
				akamaiMsl: {
					credentialId: MSL_CREDENTIAL,
					streamId: 1,
					eventName: "ev",
					edgeBaseUrl: EDGE_BASE,
				},
			},
			evidence: EVIDENCE,
			intent: evidenceIntent(),
		});
		const mirror = result.report?.checks.find(
			(c) => c.id === "live:mirror:hls:mirror-1",
		);
		expect(mirror?.verdict).toBe("SKIP");
		expect(mirror?.detail).toContain("UNOBSERVED");
		expect(
			result.evidence?.find((l) => l.outputLeg === "hls@mirror-1")?.complete,
		).toBe(false);
	});
});

describe("encrypted edge topology", () => {
	const EDGE = "https://edge.example.net/cmaf/live/1/ev/",
		PREFIX = "verify/route/";
	const binding = [
		{
			outputKey: "mirror-1",
			credentialId: "credential-msl",
			streamId: 1,
			eventName: "ev",
			streamFormat: "CMAF" as const,
			mslVersion: "MSL4",
			eventRoot: EDGE,
		},
	];
	const base: LiveRunnerDeps = {
		api: async () => ({ status: 200, json: null }),
		readText: async () => "",
		listAll: async () => [],
		sleep: async () => {},
		now: () => 0,
	};
	it("counts only the encrypted representations selected by a DASH manifest", async () => {
		const p = liveChannelPlanSchema.parse(plan("live-akamai-msl-storage"));
		p.liveManifests = p.liveManifests
			.filter((m) => m.kind === "DASH")
			.map((m) => ({ ...m, drmKind: "FAIRPLAY" }));
		p.drm = p.muxings.map((m) => {
			if (!m.destination) throw new Error("Missing destination");
			return {
				key: `${m.key}-enc`,
				kind: "FAIRPLAY" as const,
				muxingKey: m.key,
				credentialId: "00000000-0000-4000-8000-000000000003",
				iv: "a".repeat(32),
				uri: "skd://synthetic",
				destination: { ...m.destination, path: `${PREFIX}encrypted/${m.key}` },
			};
		});
		const expected = compileExpectedLiveArtefacts(p);
		const mpd = `<MPD mediaPresentationDuration="PT12S" type="static"><Period><AdaptationSet mimeType="video/mp4">${p.muxings.map((m, i) => `<Representation id="r${i}" bandwidth="1000000"><SegmentList duration="6"><Initialization sourceURL="${PREFIX}encrypted/${m.key}/init.mp4"/><SegmentURL media="${PREFIX}encrypted/${m.key}/seg-1.m4s"/><SegmentURL media="${PREFIX}encrypted/${m.key}/seg-2.m4s"/></SegmentList></Representation>`).join("")}</AdaptationSet></Period></MPD>`;
		const readEdge = async (url: string) => ({
			status: 200,
			bytes: url.endsWith(".mpd") ? mpd.length : 10,
			text: url.endsWith(".mpd") ? mpd : "media-bytes",
		});
		const closures = await collectEdgeClosures(
			{ ...base, readEdge },
			expected,
			binding,
			{ "mirror-1": "provider-output" },
			PREFIX,
		);
		expect(closures).toHaveLength(1);
		expect(closures[0]?.closed, JSON.stringify(closures)).toBe(true);
		expect(closures[0]?.children).toHaveLength(p.muxings.length);
	});
	it("requires init only for the selected fMP4 HLS child, not an unselected fMP4 copy of the TS child", async () => {
		const p = liveChannelPlanSchema.parse(plan("live-akamai-msl-storage"));
		const video = p.muxings.find((m) => m.streamKey.startsWith("v"));
		if (!video?.destination) throw new Error("Missing video");
		p.muxings.push({
			kind: "TS",
			key: "video-ts",
			streamKey: video.streamKey,
			segmentLength: 6,
			segmentNaming: "seg-%number%.ts",
			destination: { ...video.destination, path: `${PREFIX}ts` },
		});
		p.liveManifests = p.liveManifests
			.filter((m) => m.kind === "HLS")
			.map((m) => ({ ...m, videoMuxingKind: "TS", audioMuxingKind: "FMP4" }));
		const e = compileExpectedLiveArtefacts(p),
			manifest = e.manifests[0];
		if (!manifest) throw new Error("Missing HLS");
		const master = `#EXTM3U\n${manifest.mediaPlaylists.map((uri) => `#EXT-X-STREAM-INF:BANDWIDTH=1000000\n${uri}`).join("\n")}\n`;
		const readEdge = async (url: string) => {
			if (url.endsWith("stream.m3u8"))
				return { status: 200, bytes: master.length, text: master };
			if (url.endsWith(".m3u8")) {
				const audio = url.includes("audio_");
				const body = `#EXTM3U\n${audio ? `#EXT-X-MAP:URI="${PREFIX}audio/init.mp4"\n` : ""}#EXTINF:6,\n${PREFIX}${audio ? "audio/seg-1.m4s" : "ts/seg-1.ts"}\n#EXTINF:6,\n${PREFIX}${audio ? "audio/seg-2.m4s" : "ts/seg-2.ts"}\n`;
				return { status: 200, bytes: body.length, text: body };
			}
			return { status: 200, bytes: 10, text: "media-bytes" };
		};
		const closures = await collectEdgeClosures(
			{ ...base, readEdge },
			e,
			binding,
			{ "mirror-1": "provider-output" },
			PREFIX,
		);
		expect(closures).toHaveLength(1);
		expect(closures[0]?.closed).toBe(true);
	});
});
