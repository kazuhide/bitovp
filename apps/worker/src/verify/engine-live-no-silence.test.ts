import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	compileExpectedLiveArtefacts,
	liveChannelPlanSchema,
} from "@bitovp/core";
import { describe, expect, it } from "vitest";
import { type LiveEngineDeps, verifyLiveChannel } from "./engine-live";
import { loadScenarios } from "./preflight";

/**
 * The no-silence invariant, applied to the live engine from its first commit.
 *
 * On the VOD side this rule cost five instances across four review rounds before it was
 * stated: **never gate an assertion on a value the artefact under test supplies.** The
 * live engine is more exposed to it, not less — a running channel supplies heartbeat
 * counters, playlist sequence numbers and a segment count that all depend on when the
 * encoder happened to start — so the property goes in before the bugs do rather than after.
 *
 * The property: for one plan, **the set of check IDs is identical whether the channel
 * reports rich facts or almost none.** Verdicts may move PASS→SKIP; nothing may disappear.
 * That is the only assertion SHAPE that can see an absent check — every other test in this
 * directory inspects checks that exist, which is exactly why the class survived four
 * rounds over on the VOD side.
 *
 * Run over all 7 live fixtures, because a cross-section named is not a cross-section
 * filled: the fifth VOD instance survived an identical test whose fixture list never took
 * the code path in question.
 */

const FIXTURES = join(
	import.meta.dirname,
	"../../../../packages/core/src/live/__fixtures__",
);

const planFiles = readdirSync(FIXTURES)
	.filter((f) => f.endsWith(".plan.json"))
	.sort();

const T0 = 1_760_000_000_000;

/** Everything a channel could tell us. */
function rich(): LiveEngineDeps {
	return {
		coordinates: { streamKey: "sk", encoderIp: "10.0.0.1" },
		fed: true,
		samples: [
			{
				at: T0,
				status: "RUNNING",
				mediaSequence: 5,
				playlistSegments: 6,
				heartbeatRows: 2,
				objects: [{ outputKey: "origin", key: "a", size: 1 }],
			},
			{
				at: T0 + 20_000,
				status: "RUNNING",
				mediaSequence: 9,
				playlistSegments: 8,
				heartbeatRows: 4,
				objects: [
					{ outputKey: "origin", key: "a", size: 1 },
					{ outputKey: "origin", key: "b", size: 1 },
				],
			},
		],
		afterStop: {
			liveToVodStatus: "FINISHED",
			vodManifestText: "#EXTM3U\n#EXT-X-ENDLIST\n",
			vodClosures: [
				{
					type: "HLS",
					manifestId: "vod-hls",
					url: "archive/vod.m3u8",
					closed: true,
					childCount: 1,
					segmentCount: 5,
					endlist: true,
				},
			],
			fedSeconds: 30,
			recordedSeconds: 29,
		},
	};
}

/**
 * A channel that is up and says almost nothing — no playlist could be read, no heartbeat
 * rows, no listing, and the post-stop probe returned no durations.
 *
 * This is not a contrived shape: it is what a real run looks like when the origin is slow
 * to publish, or the heartbeat sweep has not fired yet, or ffprobe cannot characterise the
 * rolled recording. Precisely the run whose report you would want to trust.
 */
function sparse(): LiveEngineDeps {
	return {
		coordinates: { streamKey: "sk", encoderIp: "10.0.0.1" },
		fed: true,
		samples: [
			{ at: T0, status: "RUNNING" },
			{ at: T0 + 20_000, status: "RUNNING" },
		],
		afterStop: { liveToVodStatus: "FINISHED" },
	};
}

describe("each fixture verifies something the others do not", () => {
	// Compiles expected-live for every runnable fixture and runs the engine once
	// per fixture: ~2 s alone, 9.7 s when three package suites shared the machine
	// (2026-08-29, twice) — a 5 s budget measured the scheduler, not the guard.
	it("no two runnable live fixtures emit the same check-id set", {
		timeout: 60_000,
	}, async () => {
		/**
		 * A review counted the seventh "named slot is not a filled one" and found it was
		 * FOUR: `live-esam-full`, `live-static-ip` and `live-redundant-rtmp` emitted a
		 * byte-identical 14-id set with `live-rtmp-simple`, and `needsPois`,
		 * `segmentNaming`, `initSegment`, `container` and `renditionCount` were compiled and
		 * read by nothing. Three fixtures existed to verify features no check examined.
		 *
		 * `live-static-ip` is the honest exception: it is gated behind `LIVE_INFRA` because
		 * its static IP and infrastructure ids are owner-specific placeholders, so it never
		 * runs and an identical set costs nothing. Everything else must differ.
		 */
		/**
		 * Which fixtures actually RUN, derived from preflight rather than a hardcoded list.
		 *
		 * Three of the seven can only be provisioned, never fed, and are gated on
		 * capabilities nobody has: `live-static-ip` (owner-specific static IP and Cloud
		 * Connect ids), `live-zixi` (needs a broadcaster) and `live-srt-caller` (CALLER means
		 * Bitmovin dials OUT, so it needs an external sender at a documentation-range
		 * address). Those legitimately verify the same thing as each other, and excluding
		 * them by NAME would be a hardcoded list going stale the moment a capability is
		 * registered — the named-slot mistake, committed inside the test that exists to catch
		 * it. Derived from `capabilitiesFor` instead.
		 */
		/**
		 * `AKAMAI_MSL` joins them for a reason worth stating rather than
		 * assuming : an MSL channel's segments land at Akamai,
		 * which no storage driver in this repo can list or read back. This
		 * engine verifies by READING artefacts, so it can only ever emit the
		 * same ids as the plain RTMP fixture — MSL's own distinguishing facts
		 * (streamId, eventName, streamFormat) are pinned where they can
		 * actually be checked: the compiler golden and the C31 validators.
		 * Gating it is therefore honest; making it emit a unique id here would
		 * mean inventing a check that measures nothing.
		 */
		//
		// Capability availability is runtime state and must not be read from a
		// dated document. Include every fixture here; `needs + check ids` is the
		// stable identity of what a scenario verifies, whether or not today's
		// environment can execute it.
		const sets = new Map<string, string[]>();
		for (const file of planFiles) {
			const name = file.replace(".plan.json", "");
			const raw = readFileSync(join(FIXTURES, file), "utf8");
			const needs = loadScenarios().find((sc) => sc.name === name)?.needs ?? [];
			void raw;
			const expected = compileExpectedLiveArtefacts(
				liveChannelPlanSchema.parse(
					JSON.parse(readFileSync(join(FIXTURES, file), "utf8")),
				),
			);
			const report = await verifyLiveChannel(expected, rich());
			/**
			 * The dedupe key is check-ids PLUS capability needs (2026-08-23).
			 *
			 * Check ids are a function of ladder/manifest/ingest FEATURES — they
			 * cannot see the provider. The Akamai set (live-akamai-msl,
			 * live-akamai-msl-storage) shares live-static-ingest's feature shape
			 * by design (the customer's canonical channel), and under ids alone
			 * the three read as "the same scenario run three times" when they
			 * exercise DIFFERENT infrastructure: S3/Tokyo vs MSL/Osaka vs
			 * storage-primary+MSL-mirror/Osaka. Two fixtures are true duplicates
			 * only when BOTH their check sets AND their capability needs match —
			 * same checks against the same providers. Two S3 fixtures with one
			 * check set still collide, which is the case this guard was built on.
			 */
			const key = `${[...needs].sort().join("+")}::${report.checks
				.map((c) => c.id)
				.sort()
				.join(",")}`;
			sets.set(key, [...(sets.get(key) ?? []), name]);
		}
		const collisions = [...sets.values()].filter((names) => names.length > 1);
		expect(
			collisions,
			"these fixtures verify exactly the same things, so at most one of them is earning its runtime",
		).toEqual([]);
	});

	it("the sweep separates MSL by typed NEEDS, not check ids", () => {
		const needsOf = (name: string) =>
			loadScenarios().find((sc) => sc.name === name)?.needs ?? [];
		expect(needsOf("live-akamai-msl")).toContain("AKAMAI_MSL");
		expect(needsOf("live-akamai-msl-storage")).toContain("AKAMAI_MSL");
		expect(needsOf("live-static-ingest")).not.toContain("AKAMAI_MSL");
	});

	it("the ESAM fixture emits an SCTE-35 check and the plain RTMP one does not", async () => {
		const load = (n: string) =>
			compileExpectedLiveArtefacts(
				liveChannelPlanSchema.parse(
					JSON.parse(readFileSync(join(FIXTURES, `${n}.plan.json`), "utf8")),
				),
			);
		const esam = await verifyLiveChannel(load("live-esam-full"), rich());
		const plain = await verifyLiveChannel(load("live-rtmp-simple"), rich());
		expect(esam.checks.some((c) => c.id === "live:scte35")).toBe(true);
		expect(plain.checks.some((c) => c.id === "live:scte35")).toBe(false);
	});

	it("the redundant fixture checks its ingest points and the plain one has none to check", async () => {
		const load = (n: string) =>
			compileExpectedLiveArtefacts(
				liveChannelPlanSchema.parse(
					JSON.parse(readFileSync(join(FIXTURES, `${n}.plan.json`), "utf8")),
				),
			);
		const red = await verifyLiveChannel(load("live-redundant-rtmp"), rich());
		const plain = await verifyLiveChannel(load("live-rtmp-simple"), rich());
		expect(red.checks.some((c) => c.id === "live:redundancy")).toBe(true);
		expect(red.checks.some((c) => c.id === "live:failover")).toBe(true);
		expect(plain.checks.some((c) => c.id === "live:redundancy")).toBe(false);
	});
});

describe("no live check may disappear when the channel says less", () => {
	it("has a corpus to sweep", () => {
		// 9→10 / 77→78 : live-pinned-encoder joins —
		// gated behind PINNED_ENCODER_VERSION until Track 1 supplies the tag.
		// 10→11 (2026-08-23): live-akamai-msl-storage — Akamai Object Storage
		// primary + MSL4 as the first live deliveryMirror.
		// 11→12: live-akamai-msl-ts (HLS/TS half of the MSL pair).
		// 13→14 : live-akamai-msl5.
		// 14→15: live-mixed-codec-dash.
		expect(planFiles.length).toBe(15);
	});

	for (const file of planFiles) {
		const name = file.replace(".plan.json", "");
		it(`${name}: same check ids, rich channel vs sparse`, async () => {
			const expected = compileExpectedLiveArtefacts(
				liveChannelPlanSchema.parse(
					JSON.parse(readFileSync(join(FIXTURES, file), "utf8")),
				),
			);
			const good = await verifyLiveChannel(expected, rich());
			const poor = await verifyLiveChannel(expected, sparse());

			// A real population, or the comparison is vacuous — the mistake that let the
			// fifth VOD instance through an identical test.
			expect(good.checks.length, "checks emitted").toBeGreaterThan(8);

			const ids = (r: typeof good) => new Set(r.checks.map((c) => c.id));
			expect(
				[...ids(good)].filter((x) => !ids(poor).has(x)),
				"these checks VANISHED when the channel reported less — they must SKIP instead",
			).toEqual([]);
		});
	}

	it("and the sparse run SKIPs rather than passing quietly", async () => {
		const expected = compileExpectedLiveArtefacts(
			liveChannelPlanSchema.parse(
				JSON.parse(
					readFileSync(join(FIXTURES, "live-rtmp-simple.plan.json"), "utf8"),
				),
			),
		);
		const poor = await verifyLiveChannel(expected, sparse());
		expect(
			poor.counts.SKIP,
			"a channel that described nothing must produce SKIPs, not passes",
		).toBeGreaterThan(3);
		/**
		 * And it must FAIL `live:measured-something` — which is a change from the first
		 * version of this test, and the change is the point.
		 *
		 * I originally asserted that a sparse channel produces NO failures, reasoning that
		 * an unreadable playlist is not a stalled channel. That is true and it was the wrong
		 * conclusion: `runner.ts` calls any report with `failed === 0` a PASS, so a run
		 * against a bad credential produced a green live row having read nothing. The
		 * honest SKIPs were laundering into a pass one layer up (review catch).
		 *
		 * So the floor: a fed channel where not one movement check could be evaluated is
		 * not a pass. The individual movement checks stay SKIPs — they genuinely could not
		 * be judged — and the FAIL is about the REPORT, not about the channel.
		 */
		const failures = poor.checks.filter((c) => c.verdict === "FAIL");
		expect(failures.map((c) => c.id)).toEqual([
			"live:to-vod:closure",
			"live:measured-something",
		]);
		// The movement checks themselves must still be honest SKIPs, not manufactured FAILs.
		expect(
			poor.checks
				.filter((c) => /^live:(media-sequence|heartbeat|segments)$/.test(c.id))
				.every((c) => c.verdict === "SKIP"),
		).toBe(true);
	});

	it("keeps every id when the HARNESS took only one sample", async () => {
		/**
		 * The third degradation axis, and the one a reviewer noted was untested.
		 *
		 * The sample COUNT is harness-supplied, not artefact-supplied, so the rule does not
		 * strictly demand this — but a report whose id set changes shape with the harness's
		 * own sampling is harder to diff, and "the rule does not demand it" is a poor reason
		 * to leave a hole next to five that were paid for.
		 */
		for (const file of planFiles) {
			const expected = compileExpectedLiveArtefacts(
				liveChannelPlanSchema.parse(
					JSON.parse(readFileSync(join(FIXTURES, file), "utf8")),
				),
			);
			const good = await verifyLiveChannel(expected, rich());
			const one = await verifyLiveChannel(expected, {
				...rich(),
				samples: rich().samples.slice(0, 1),
			});
			const ids = (r: typeof good) => new Set(r.checks.map((c) => c.id));
			expect(
				[...ids(good)].filter((x) => !ids(one).has(x)),
				`${file}: checks VANISHED when only one sample was taken`,
			).toEqual([]);
		}
	});

	it("keeps every id when the channel was never STOPPED", async () => {
		// A fourth axis: a run that verifies a still-running channel must not lose the
		// post-stop check ids, only their verdicts.
		for (const file of planFiles) {
			const expected = compileExpectedLiveArtefacts(
				liveChannelPlanSchema.parse(
					JSON.parse(readFileSync(join(FIXTURES, file), "utf8")),
				),
			);
			const good = await verifyLiveChannel(expected, rich());
			const running = rich();
			delete running.afterStop;
			const live = await verifyLiveChannel(expected, running);
			const ids = (r: typeof good) => new Set(r.checks.map((c) => c.id));
			expect(
				[...ids(good)].filter((x) => !ids(live).has(x)),
				`${file}: checks VANISHED when the channel was still running`,
			).toEqual([]);
		}
	});

	it("degrading only the FEED still keeps every id", async () => {
		// A separate degradation axis: the channel reports everything, but nothing was
		// pushed. The movement checks must SKIP, not vanish — this is the SRT-listener and
		// Zixi path, and it is the one a runner takes most often while credentials are
		// partial.
		for (const file of planFiles) {
			const expected = compileExpectedLiveArtefacts(
				liveChannelPlanSchema.parse(
					JSON.parse(readFileSync(join(FIXTURES, file), "utf8")),
				),
			);
			const good = await verifyLiveChannel(expected, rich());
			const unfed = await verifyLiveChannel(expected, {
				...rich(),
				fed: false,
			});
			const ids = (r: typeof good) => new Set(r.checks.map((c) => c.id));
			expect(
				[...ids(good)].filter((x) => !ids(unfed).has(x)),
				`${file}: checks VANISHED when no feed was pushed`,
			).toEqual([]);
		}
	});
});
