import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	compileExpectedLiveArtefacts,
	liveChannelPlanSchema,
} from "@bitovp/core";
import { describe, expect, it } from "vitest";
import { HEARTBEAT_SWEEP_INTERVAL_MS } from "../heartbeat-cadence";
import {
	codecFamily,
	type LiveEdgeClosure,
	type LiveEngineDeps,
	type LiveSample,
	MIN_SAMPLE_GAP_SEC,
	verifyLiveChannel,
} from "./engine-live";

/**
 * The live engine, made to fail on purpose — and made to stay green on a correct channel.
 *
 * Same discipline as the VOD self-test, learned the same way: a guard whose failure has
 * never been observed is not evidence. Every check below is driven twice, once on a
 * healthy channel and once with one property broken, and the planted fault must flip its
 * OWN check id.
 *
 * The live-specific trap is the third state. A live channel has three ways to produce no
 * movement — it stalled, it was never fed, or the harness sampled too fast — and only the
 * first is a defect. Conflating them would report a correct SRT-listener provisioning run
 * as a broken encoder, which is why `fed` and the sample gap are separate inputs and each
 * has its own case here.
 */

const FIXTURES = join(
	import.meta.dirname,
	"../../../../packages/core/src/live/__fixtures__",
);

function load(name: string) {
	return compileExpectedLiveArtefacts(
		liveChannelPlanSchema.parse(
			JSON.parse(readFileSync(join(FIXTURES, `${name}.plan.json`), "utf8")),
		),
	);
}

const T0 = 1_760_000_000_000;

describe("progressive MP4 archive obligations", () => {
	it("keeps every archive primary and mirror UNVERIFIED despite healthy live/LiveToVod results", async () => {
		const raw = JSON.parse(
			readFileSync(join(FIXTURES, "live-rtmp-simple.plan.json"), "utf8"),
		);
		raw.outputs.push({ ...raw.outputs[0], key: "archive-copy" });
		raw.deliveryMirrors = [
			{ outputKey: "origin" },
			{ outputKey: "archive-copy" },
		];
		raw.muxings.push({
			key: "archive",
			kind: "MP4",
			streamKey: "v1080",
			additionalStreamKeys: ["a128"],
			filename: "archive.mp4",
			destination: { outputKey: "origin", path: "run-specific/archive" },
		});
		const expected = compileExpectedLiveArtefacts(
			liveChannelPlanSchema.parse(raw),
		);
		const report = await verifyLiveChannel(expected, healthy());
		const checks = report.checks.filter((check) =>
			check.id.startsWith("live:archive:"),
		);
		expect(checks.map((check) => check.id)).toEqual([
			"live:archive:archive:origin",
			"live:archive:archive:archive-copy",
		]);
		for (const check of checks) {
			expect(check.verdict).toBe("SKIP");
			expect(check.detail).toContain("UNVERIFIED");
			expect(check.detail).toContain("exact-run");
		}
		const observed = {
			id: "live:archive:archive:origin",
			area: "hygiene" as const,
			verdict: "PASS" as const,
			detail: "exact-run conditional file/decode proof; lip-sync UNVERIFIED",
		};
		const partial = await verifyLiveChannel(expected, {
			...healthy(),
			archiveChecks: [observed],
		});
		expect(partial.checks.find((c) => c.id === observed.id)?.verdict).toBe(
			"PASS",
		);
		expect(
			partial.checks.find((c) => c.id === "live:archive:archive:archive-copy")
				?.verdict,
		).toBe("SKIP");
		const ambiguous = await verifyLiveChannel(expected, {
			...healthy(),
			archiveChecks: [observed, observed],
		});
		expect(ambiguous.checks.find((c) => c.id === observed.id)?.verdict).toBe(
			"SKIP",
		);
	});
	it("does not add archive obligations to a segmented-only plan", async () => {
		const report = await verifyLiveChannel(load("live-rtmp-simple"), healthy());
		expect(
			report.checks.filter((check) => check.id.startsWith("live:archive:")),
		).toEqual([]);
	});
});

/**
 * Objects a healthy channel would have written — one set per DECLARED muxing prefix.
 *
 * The first version listed 40 files under a single made-up prefix, which was enough for a
 * union count and nothing else. `live:ladder` checks each muxing's own prefix, so it
 * immediately failed this world — correctly: a world that does not write what the plan
 * declared cannot demonstrate a ladder. Derived from the expectation, not guessed, which is
 * the rule the VOD side paid for eight times.
 */
function ladderObjects(count: number): NonNullable<LiveSample["objects"]> {
	const expected = load("live-rtmp-simple");
	const objects: NonNullable<LiveSample["objects"]> = [];
	for (const m of expected.muxings) {
		if (m.initSegment) {
			objects.push({
				outputKey: m.outputKey,
				key: `${m.dir.prefix}${m.initSegment}`,
				size: 900,
			});
		}
		for (let i = 1; i <= count; i++) {
			objects.push({
				outputKey: m.outputKey,
				key: `${m.dir.prefix}${m.segmentNaming.replace(/%number%/g, String(i))}`,
				size: 500_000,
			});
		}
	}
	return objects;
}

/** A channel that is running, fed, and behaving. */
function healthy(): LiveEngineDeps {
	return {
		coordinates: { streamKey: "sk-abc", encoderIp: "10.0.0.7" },
		fed: true,
		samples: [
			{
				at: T0,
				status: "RUNNING",
				mediaSequence: 12,
				playlistSegments: 8,
				heartbeatRows: 3,
				objects: ladderObjects(2),
			},
			{
				at: T0 + HEARTBEAT_SWEEP_INTERVAL_MS,
				status: "RUNNING",
				mediaSequence: 14,
				playlistSegments: 10,
				heartbeatRows: 5,
				objects: ladderObjects(3),
			},
		],
		afterStop: {
			liveToVodStatus: "FINISHED",
			vodManifestText: "#EXTM3U\n#EXT-X-VERSION:4\n#EXT-X-ENDLIST\n",
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
			fedSeconds: 60,
			recordedSeconds: 58,
		},
	};
}

const FAULTS: {
	name: string;
	expectFail: string;
	break: (d: LiveEngineDeps) => void;
}[] = [
	{
		name: "the channel never reached RUNNING",
		expectFail: "live:running",
		break: (d) => {
			for (const s of d.samples) {
				s.status = "ERROR";
			}
		},
	},
	{
		name: "no stream key was handed back — the channel is up and unusable",
		expectFail: "live:coordinates:streamKey",
		break: (d) => {
			delete d.coordinates.streamKey;
		},
	},
	{
		name: "no encoder address was handed back",
		expectFail: "live:coordinates:encoderIp",
		break: (d) => {
			d.coordinates.encoderIp = "";
		},
	},
	{
		/**
		 * A stalled sequence is only a defect once segments are ROLLING OFF.
		 *
		 * `#EXT-X-MEDIA-SEQUENCE` is the sequence number of the first segment in the playlist;
		 * it advances when segments are removed from the head, which happens only once the DVR
		 * window is full. `live-srt-listener` FAILed a real run with `0 → 0` on a channel that
		 * was entirely healthy — 7 audio segments, 7 at 360p, 7 at 720p in the bucket, and
		 * `live:segments` PASSing in the same report — because a 90s feed against a multi-minute
		 * window drops nothing.
		 *
		 * So both plants now also stop the playlist growing, which is what "the window is full"
		 * looks like from outside. That is the condition under which a stalled or reversed
		 * sequence really is wrong.
		 */
		name: "the media sequence stalled while segments were rolling off",
		expectFail: "live:media-sequence",
		break: (d) => {
			const last = d.samples.at(-1);
			const first = d.samples.at(0);
			if (last && first) {
				last.mediaSequence = first.mediaSequence;
				last.playlistSegments = first.playlistSegments;
			}
		},
	},
	{
		name: "the media sequence went BACKWARDS while segments were rolling off",
		expectFail: "live:media-sequence",
		break: (d) => {
			const last = d.samples.at(-1);
			const first = d.samples.at(0);
			if (last && first) {
				last.mediaSequence = 1;
				last.playlistSegments = first.playlistSegments;
			}
		},
	},
	{
		name: "heartbeat rows stopped accumulating",
		expectFail: "live:heartbeat",
		break: (d) => {
			const last = d.samples.at(-1);
			const first = d.samples.at(0);
			if (last && first) {
				last.heartbeatRows = first.heartbeatRows;
			}
		},
	},
	{
		name: "segments stopped being written",
		expectFail: "live:segments",
		break: (d) => {
			const last = d.samples.at(-1);
			const first = d.samples.at(0);
			if (last && first) {
				last.objects = first.objects;
			}
		},
	},
	{
		name: "the DVR window overran what the plan declared",
		expectFail: "live:dvr:hls",
		break: (d) => {
			const last = d.samples.at(-1);
			if (last) {
				// The rtmp-simple fixture declares 7200s at 6s = 1200 segments per rendition.
				last.playlistSegments = 5_000;
			}
		},
	},
	{
		name: "live-to-VOD never finished",
		expectFail: "live:to-vod",
		break: (d) => {
			if (d.afterStop) {
				d.afterStop.liveToVodStatus = "ERROR";
			}
		},
	},
	{
		name: "the rolled recording is an unclosed playlist",
		expectFail: "live:to-vod:endlist",
		break: (d) => {
			if (d.afterStop) {
				d.afterStop.vodManifestText = "#EXTM3U\n#EXT-X-VERSION:4\n";
				const hls = d.afterStop.vodClosures?.find(
					(closure) => closure.type === "HLS",
				);
				if (hls) {
					hls.endlist = false;
					hls.closed = false;
				}
			}
		},
	},
	{
		name: "the recording captured a fraction of the feed",
		expectFail: "live:recorded",
		break: (d) => {
			if (d.afterStop) {
				d.afterStop.recordedSeconds = 4;
			}
		},
	},
	{
		name: "the recording ran away past the feed",
		expectFail: "live:recorded",
		break: (d) => {
			if (d.afterStop) {
				d.afterStop.recordedSeconds = 600;
			}
		},
	},
	{
		name: "the harness sampled too fast to judge movement",
		expectFail: "live:sample-gap",
		break: (d) => {
			const last = d.samples.at(-1);
			if (last) {
				last.at = T0 + 2_000;
			}
		},
	},
];

describe("live engine — every check is observed failing", () => {
	const expected = load("live-rtmp-simple");

	for (const fault of FAULTS) {
		it(`catches: ${fault.name}`, async () => {
			const deps = healthy();
			fault.break(deps);
			const report = await verifyLiveChannel(expected, deps);
			const failed = report.checks
				.filter((c) => c.verdict === "FAIL")
				.map((c) => c.id);
			expect(
				failed,
				`planting "${fault.name}" must fail ${fault.expectFail}; failures were [${failed.join(", ")}]`,
			).toContain(fault.expectFail);
		});
	}

	it("plants nothing and stays green — the same code path, so the faults mean something", async () => {
		const report = await verifyLiveChannel(expected, healthy());
		expect(
			report.checks
				.filter((c) => c.verdict === "FAIL")
				.map((c) => `${c.id}: ${c.detail}`),
		).toEqual([]);
		// And it must have actually checked things, not skipped them into silence.
		expect(report.counts.PASS).toBeGreaterThan(8);
	});
});

describe("live:segment-naming — the cheapest of the unread expectations", () => {
	it("recognizes CMAF expanded init and segment templates without treating init as unexpected media", async () => {
		const expected = load("live-rtmp-simple");
		for (const m of expected.muxings) {
			m.muxingKind = "CMAF";
			m.initSegment = undefined;
			m.initSegmentNameTemplate = "init-{rand_chars:8}.mp4";
			m.segmentNaming = "seg-{rand_chars:8}-%number%.m4s";
			m.segmentNamingIsTemplate = true;
		}
		const deps = healthy();
		for (const [index, sample] of deps.samples.entries()) {
			sample.objects = expected.muxings.flatMap((m) => [
				{
					outputKey: m.outputKey,
					key: `${m.dir.prefix}init-Ab12Cd34.mp4`,
					size: 900,
				},
				...Array.from({ length: index + 2 }, (_, n) => ({
					outputKey: m.outputKey,
					key: `${m.dir.prefix}seg-Ab12Cd34-${n + 1}.m4s`,
					size: 500_000,
				})),
			]);
		}
		const report = await verifyLiveChannel(expected, deps);
		expect(
			report.checks.find((c) => c.id === "live:segment-naming")?.verdict,
		).toBe("PASS");
		expect(report.checks.find((c) => c.id === "live:ladder")?.verdict).toBe(
			"PASS",
		);
	});
	it("FAILS an object that matches no declared segment template", async () => {
		/**
		 * A count cannot catch this: a wrong naming template means the manifest references
		 * names the origin never wrote, and `live:segments` counts the files happily. No new
		 * I/O — it is a pattern match on keys the runner already holds, which is why a reviewer
		 * picked it as the first of the five unread expectations worth consuming.
		 */
		const expected = load("live-rtmp-simple");
		const first = expected.muxings[0];
		if (!first) {
			throw new Error("fixture has no muxings");
		}
		const deps = healthy();
		for (const sample of deps.samples) {
			sample.objects = [
				...(sample.objects ?? []),
				{
					outputKey: first.outputKey,
					key: `${first.dir.prefix}chunk-0001.mp4`,
					size: 500_000,
				},
			];
		}
		const report = await verifyLiveChannel(expected, deps);
		const naming = report.checks.find((c) => c.id === "live:segment-naming");
		expect(naming?.verdict).toBe("FAIL");
		expect(naming?.detail).toContain("chunk-0001.mp4");
		// And the count check is blind to it, which is the point.
		expect(report.checks.find((c) => c.id === "live:segments")?.verdict).toBe(
			"PASS",
		);
	});

	it("PASSES when every object matches, and tolerates the init segment", async () => {
		const report = await verifyLiveChannel(load("live-rtmp-simple"), healthy());
		expect(
			report.checks.find((c) => c.id === "live:segment-naming")?.verdict,
		).toBe("PASS");
	});
});

describe("a ladder where one rendition never started", () => {
	it("is caught, which a union segment count cannot do", async () => {
		/**
		 * `live:segments` counts the union across every prefix, so a channel where three of
		 * four renditions keep writing still shows a growing total. That is the shape this
		 * check exists for, and it is why `renditionCount`, `segmentNaming`, `initSegment`
		 * and `container` had to be READ rather than merely compiled — a review counted five
		 * such fields consumed by nothing, which is why three fixtures emitted a
		 * byte-identical check set and verified nothing distinct.
		 */
		const expected = load("live-rtmp-simple");
		const dead = expected.muxings[1];
		if (!dead) {
			throw new Error("fixture has fewer than two muxings");
		}
		const deps = healthy();
		for (const sample of deps.samples) {
			sample.objects = (sample.objects ?? []).filter(
				(o) => !o.key.startsWith(dead.dir.prefix),
			);
		}
		const report = await verifyLiveChannel(expected, deps);
		const ladder = report.checks.find((c) => c.id === "live:ladder");
		expect(ladder?.verdict).toBe("FAIL");
		expect(ladder?.detail).toContain(dead.muxingKey);
		// And the union count still ADVANCES, which is the point: it cannot see this.
		expect(
			report.checks.find((c) => c.id === "live:segments")?.verdict,
			"the union count is blind to a single silent rendition",
		).toBe("PASS");
	});

	it("SKIPs the ladder check when nothing was fed, rather than failing it", async () => {
		const deps = healthy();
		deps.fed = false;
		const report = await verifyLiveChannel(load("live-rtmp-simple"), deps);
		expect(report.checks.find((c) => c.id === "live:ladder")?.verdict).toBe(
			"SKIP",
		);
	});
});

describe("the ESAM channel now verifies something the others do not", () => {
	it("emits an SCTE-35 check for the ESAM plan and not for the others", async () => {
		// Three fixtures used to emit a byte-identical 14-id set. `live-esam-full` verified
		// exactly as much about ad markers as `live-rtmp-simple` did (review catch).
		const esam = await verifyLiveChannel(load("live-esam-full"), healthy());
		const plain = await verifyLiveChannel(load("live-rtmp-simple"), healthy());
		expect(esam.checks.some((c) => c.id === "live:scte35")).toBe(true);
		expect(plain.checks.some((c) => c.id === "live:scte35")).toBe(false);
		// The two reports must no longer be the same shape.
		expect(esam.checks.map((c) => c.id)).not.toEqual(
			plain.checks.map((c) => c.id),
		);
	});

	it("SKIPs the marker check without a POIS rather than failing every run", async () => {
		// Absence of a marker is expected with no POIS to answer the ESAM request, so a FAIL
		// here would be red on every run until one exists — noise, and noise gets ignored.
		const report = await verifyLiveChannel(load("live-esam-full"), healthy());
		const scte = report.checks.find((c) => c.id === "live:scte35");
		expect(scte?.verdict).toBe("SKIP");
		expect(scte?.detail).toMatch(/CAP_POIS/);
	});

	it("PASSes when markers actually appear", async () => {
		const deps = healthy();
		if (deps.afterStop) {
			deps.afterStop.vodManifestText =
				'#EXTM3U\n#EXT-X-CUE-OUT:30\n#EXT-X-DATERANGE:ID="a"\n#EXT-X-ENDLIST\n';
		}
		const report = await verifyLiveChannel(load("live-esam-full"), deps);
		const scte = report.checks.find((c) => c.id === "live:scte35");
		expect(scte?.verdict).toBe("PASS");
		expect(scte?.detail).toMatch(/2 ad-marker/);
	});
});

describe("a channel that wobbled and recovered", () => {
	it("is reported, not discarded — found by driving the engine, not reading it", async () => {
		/**
		 * `live:running` asserts the LAST status, which is the design's contract. On its own
		 * that meant a channel which was ERROR at the first sample and RUNNING at the last
		 * produced **zero findings of any kind** — I found that by probing the movement
		 * logic, not by reading it.
		 *
		 * It is not a FAIL: Bitmovin's `autoRestart` can legitimately take a channel
		 * ERROR → RUNNING, and failing that would be a false red on a configured recovery.
		 * It is a WARN, because an operator wants to know their channel restarted and a
		 * nightly run that never mentions it cannot tell them.
		 */
		const expected = load("live-rtmp-simple");
		const deps = healthy();
		const first = deps.samples.at(0);
		if (first) {
			first.status = "ERROR";
		}
		const report = await verifyLiveChannel(expected, deps);
		const stability = report.checks.find(
			(c) => c.id === "live:status-stability",
		);
		expect(stability?.verdict, "a recovery is a WARN, not a FAIL").toBe("WARN");
		expect(stability?.detail).toMatch(/recovered/);
		// And the contract check still passes, because the channel did end up RUNNING.
		expect(report.checks.find((c) => c.id === "live:running")?.verdict).toBe(
			"PASS",
		);
		expect(
			report.checks.filter((c) => c.verdict === "FAIL").map((c) => c.id),
			"a recovered channel must not FAIL",
		).toEqual([]);
	});

	it("PASSes stability when the channel held one status throughout", async () => {
		const report = await verifyLiveChannel(load("live-rtmp-simple"), healthy());
		expect(
			report.checks.find((c) => c.id === "live:status-stability")?.verdict,
		).toBe("PASS");
	});
});

describe("the three ways nothing moves, only one of which is a defect", () => {
	it("a channel that was never fed SKIPs its movement checks, naming why", async () => {
		// The SRT-listener case: Bitmovin dials out to us, so the feeder cannot push. The
		// channel is correct and carries no media, and reporting that as a stall would make
		// the report worse than no report.
		const expected = load("live-srt-listener");
		const deps = healthy();
		deps.fed = false;
		delete deps.coordinates.streamKey;
		const report = await verifyLiveChannel(expected, deps);
		const movement = report.checks.filter((c) =>
			/live:(media-sequence|heartbeat|segments)$/.test(c.id),
		);
		expect(movement.length, "the checks must still be emitted").toBe(3);
		expect(movement.every((c) => c.verdict === "SKIP")).toBe(true);
		expect(movement[0]?.detail).toMatch(/no media was pushed/);
		// Provisioning is still verified — that is the whole value of running it.
		expect(report.checks.find((c) => c.id === "live:running")?.verdict).toBe(
			"PASS",
		);
	});

	it("a channel sampled too fast SKIPs movement rather than blaming the channel", async () => {
		const expected = load("live-rtmp-simple");
		const deps = healthy();
		const last = deps.samples.at(-1);
		if (last) {
			last.at = T0 + 1_000;
			last.mediaSequence = deps.samples[0]?.mediaSequence;
		}
		const report = await verifyLiveChannel(expected, deps);
		expect(
			report.checks.find((c) => c.id === "live:media-sequence")?.verdict,
			"a stalled sequence must not be blamed on the channel when the gap is too short",
		).toBe("SKIP");
		expect(report.checks.find((c) => c.id === "live:sample-gap")?.verdict).toBe(
			"FAIL",
		);
	});

	it("a single sample SKIPs movement, because one sample cannot show movement", async () => {
		const expected = load("live-rtmp-simple");
		const deps = healthy();
		deps.samples = deps.samples.slice(0, 1);
		const report = await verifyLiveChannel(expected, deps);
		const movement = report.checks.find((c) => c.id === "live:movement");
		expect(movement?.verdict).toBe("SKIP");
		expect(movement?.detail).toMatch(/at least two samples/);
	});
});

describe("the DVR window and the C8 budget", () => {
	it("accepts a window that is still FILLING — that is not a defect", async () => {
		// A channel fed for 30s cannot show a 2-hour window. The check is one-sided on
		// purpose; making it two-sided would fail every short verification run.
		const expected = load("live-rtmp-simple");
		const deps = healthy();
		for (const s of deps.samples) {
			s.playlistSegments = 4;
		}
		const report = await verifyLiveChannel(expected, deps);
		expect(
			report.checks
				.filter((c) => c.verdict === "FAIL" && /live:dvr:/.test(c.id))
				.map((c) => c.detail),
		).toEqual([]);
	});

	it("checks the C8 budget even on a channel that carried no media", async () => {
		// An over-budget window is an AUTHORING defect, so the useful moment to say so is
		// before a feed is ever pointed at the channel.
		const expected = load("live-rtmp-simple");
		const deps = healthy();
		deps.fed = false;
		const report = await verifyLiveChannel(expected, deps);
		const budget = report.checks.filter((c) => /live:c8:/.test(c.id));
		expect(budget.length, "one per windowed manifest").toBeGreaterThan(0);
		expect(budget.every((c) => c.verdict === "PASS")).toBe(true);
	});

	it("FAILS a plan whose declared window exceeds the 54,000-element budget", async () => {
		const expected = load("live-rtmp-simple");
		// 54,000 elements over 4 renditions at 6s segments is 81,000s of window.
		for (const m of expected.manifests) {
			if (m.elementBudget) {
				(m as { timeshiftSec?: number }).timeshiftSec = 200_000;
				m.elementBudget.totalElements = 133_336;
				m.elementBudget.utilization = 2.47;
				m.elementBudget.level = "over";
			}
		}
		const report = await verifyLiveChannel(expected, healthy());
		const over = report.checks.filter(
			(c) => c.verdict === "FAIL" && /live:c8:/.test(c.id),
		);
		expect(over.length).toBeGreaterThan(0);
		expect(over[0]?.detail).toMatch(/over budget as authored/);
	});
});

describe("a channel that is still running", () => {
	it("SKIPs the post-stop checks instead of failing them", async () => {
		const expected = load("live-rtmp-simple");
		const deps = healthy();
		delete deps.afterStop;
		const report = await verifyLiveChannel(expected, deps);
		for (const id of [
			"live:to-vod",
			"live:to-vod:closure",
			"live:to-vod:endlist",
			"live:recorded",
		]) {
			const check = report.checks.find((c) => c.id === id);
			expect(check?.verdict, id).toBe("SKIP");
			expect(check?.detail, id).toMatch(/not stopped in this run/);
		}
	});
});

describe("the sample-gap floor is a real number", () => {
	it("is 10 seconds, and a gap exactly at the floor is accepted", async () => {
		expect(MIN_SAMPLE_GAP_SEC).toBe(10);
		const expected = load("live-rtmp-simple");
		const deps = healthy();
		const last = deps.samples.at(-1);
		if (last) {
			last.at = T0 + MIN_SAMPLE_GAP_SEC * 1000;
		}
		const report = await verifyLiveChannel(expected, deps);
		expect(report.checks.find((c) => c.id === "live:sample-gap")?.verdict).toBe(
			"PASS",
		);
	});

	it("does not judge heartbeat movement before one configured sweep, while still judging media movement", async () => {
		const expected = load("live-rtmp-simple");
		const deps = healthy();
		const first = deps.samples.at(0);
		const last = deps.samples.at(-1);
		if (!first || !last)
			throw new Error("healthy fixture has fewer than two samples");
		last.at = T0 + HEARTBEAT_SWEEP_INTERVAL_MS - 1;
		last.heartbeatRows = first.heartbeatRows;

		const report = await verifyLiveChannel(expected, deps);
		const heartbeat = report.checks.find((c) => c.id === "live:heartbeat");
		expect(heartbeat?.verdict).toBe("SKIP");
		expect(heartbeat?.detail).toMatch(/30\.0s heartbeat sweep/);
		expect(report.checks.find((c) => c.id === "live:segments")?.verdict).toBe(
			"PASS",
		);
	});
});

/**
 * The honesty floors, attacked — because a floor that misfires on a healthy channel is
 * worse than no floor: it trains the reader to ignore a FAIL.
 */
describe("live:readable and the startup race", () => {
	it("does NOT fail a healthy channel whose playlist is absent at the FIRST sample", async () => {
		/**
		 * The normal case, not the edge. Sample 1 is taken at t=0 of the feed: handshake,
		 * first GOP, first segment and first manifest write are all still ahead. The floor as
		 * first written FAILed every healthy channel here, and it would have read as "the fix
		 * works" on the first nightly (review catch).
		 */
		const deps = healthy();
		const first = deps.samples.at(0);
		if (first) {
			first.readErrors = ["NOTFOUND out/video_4500000.m3u8: NoSuchKey"];
			delete first.mediaSequence;
		}
		const report = await verifyLiveChannel(load("live-rtmp-simple"), deps);
		expect(
			report.checks.find((c) => c.id === "live:readable")?.verdict,
			"a not-yet-published playlist at t=0 is startup, not a fault",
		).toBe("PASS");
	});

	it("DOES fail a not-found on the LAST sample", async () => {
		// 45s in, that playlist should exist.
		const deps = healthy();
		const last = deps.samples.at(-1);
		if (last) {
			last.readErrors = ["NOTFOUND out/video_4500000.m3u8: NoSuchKey"];
		}
		const report = await verifyLiveChannel(load("live-rtmp-simple"), deps);
		expect(report.checks.find((c) => c.id === "live:readable")?.verdict).toBe(
			"FAIL",
		);
	});

	it("fails an AUTH error at any sample, including the first", async () => {
		const deps = healthy();
		const first = deps.samples.at(0);
		if (first) {
			first.readErrors = ["out/x.m3u8: SignatureDoesNotMatch"];
		}
		const report = await verifyLiveChannel(load("live-rtmp-simple"), deps);
		expect(report.checks.find((c) => c.id === "live:readable")?.verdict).toBe(
			"FAIL",
		);
	});

	it("fails a post-stop read error, which used to sit outside the floor", async () => {
		const deps = healthy();
		if (deps.afterStop) {
			deps.afterStop.readError = "vod/stream.m3u8: AccessDenied";
		}
		const report = await verifyLiveChannel(load("live-rtmp-simple"), deps);
		expect(report.checks.find((c) => c.id === "live:readable")?.verdict).toBe(
			"FAIL",
		);
	});
});

describe("the floors do not double-count the harness's own faults", () => {
	it("does not add live:measured-something when the sample gap already failed", async () => {
		// One harness condition, one finding. Two product FAILs for our own interval would
		// blame the channel twice (review catch).
		const deps = healthy();
		const last = deps.samples.at(-1);
		if (last) {
			last.at = T0 + 1_000;
			delete last.mediaSequence;
			delete last.heartbeatRows;
			delete last.objects;
		}
		const report = await verifyLiveChannel(load("live-rtmp-simple"), deps);
		expect(report.checks.find((c) => c.id === "live:sample-gap")?.verdict).toBe(
			"FAIL",
		);
		expect(
			report.checks.find((c) => c.id === "live:measured-something"),
			"the gap failure is the whole finding",
		).toBeUndefined();
	});

	it("does not claim stability on a channel that was never RUNNING", async () => {
		// "Held one status" is literally true of a channel that was ERROR throughout, and
		// saying it is the reassuring-number shape this check exists to remove.
		const deps = healthy();
		for (const sample of deps.samples) {
			sample.status = "ERROR";
		}
		const report = await verifyLiveChannel(load("live-rtmp-simple"), deps);
		expect(report.checks.find((c) => c.id === "live:running")?.verdict).toBe(
			"FAIL",
		);
		expect(
			report.checks.find((c) => c.id === "live:status-stability")?.verdict,
			"stability has nothing to add about a dead channel",
		).toBe("SKIP");
	});
});

describe("live:media-sequence on a growing playlist (the REAL-LIVE-4 finding)", () => {
	/**
	 * The check that could only ever fail on a short feed.
	 *
	 * `live-srt-listener` was reported FAIL with
	 * `#EXT-X-MEDIA-SEQUENCE must advance while the channel runs — 0 → 0` on a channel whose
	 * bucket, read independently with the AWS CLI, held 7 audio segments and 7 each at 360p and
	 * 720p — and whose `live:segments` check PASSed in the same report. Per the HLS spec the
	 * media sequence is the number of the FIRST segment in the playlist and advances only as
	 * segments roll off the head, so with a 90s feed against a multi-minute DVR window it stays
	 * at 0 by definition.
	 *
	 * This is the pair the fix turns on: SKIP while the playlist is still growing, FAIL once it
	 * has stopped growing (segments rolling off) and the sequence still has not moved.
	 */
	it("SKIPS rather than FAILS while the playlist is still growing", async () => {
		const deps = healthy();
		const first = deps.samples.at(0);
		const last = deps.samples.at(-1);
		if (first && last) {
			// A healthy short feed: segments accumulate, nothing rolls off, sequence stays put.
			first.playlistSegments = 3;
			last.playlistSegments = 7;
			first.mediaSequence = 0;
			last.mediaSequence = 0;
		}
		const report = await verifyLiveChannel(load("live-rtmp-simple"), deps);
		const check = report.checks.find((c) => c.id === "live:media-sequence");
		expect(check?.verdict, check?.detail).toBe("SKIP");
		// The reason has to teach, or the next reader re-files this as a defect.
		expect(check?.detail).toMatch(/counts segments REMOVED from the head/);
		// And movement must still be judged — by the check that can see it.
		expect(
			report.checks.find((c) => c.id === "live:segments")?.verdict,
		).not.toBe("SKIP");
	});

	it("FAILS when the playlist stopped growing and the sequence still did not move", async () => {
		const deps = healthy();
		const first = deps.samples.at(0);
		const last = deps.samples.at(-1);
		if (first && last) {
			first.playlistSegments = 7;
			last.playlistSegments = 7;
			first.mediaSequence = 4;
			last.mediaSequence = 4;
		}
		const report = await verifyLiveChannel(load("live-rtmp-simple"), deps);
		const check = report.checks.find((c) => c.id === "live:media-sequence");
		expect(check?.verdict, check?.detail).toBe("FAIL");
		expect(check?.detail).toMatch(/rolling off/);
	});
});

describe("an unreadable playlist must not be described as a healthy one", () => {
	/**
	 * REAL-LIVE-5 printed, for a playlist the harness never read:
	 *
	 *   the playlist grew by 0 segment(s) without dropping any, so #EXT-X-MEDIA-SEQUENCE
	 *   stays at unknown by definition
	 *
	 * The bucket's copy of that same playlist holds 22 `#EXTINF` lines and `readLivePlaylist`
	 * parses it correctly, so the message was describing a read failure in the language of a
	 * healthy short feed. `windowFull` needs both segment counts, so "undefined" fell into the
	 * growing branch — the two states must not share a sentence.
	 */
	it("says READ FAILURE when the playlist could not be read at both samples", async () => {
		const deps = healthy();
		for (const sample of deps.samples) {
			sample.mediaSequence = undefined;
			sample.playlistSegments = undefined;
		}
		const report = await verifyLiveChannel(load("live-rtmp-simple"), deps);
		const check = report.checks.find((c) => c.id === "live:media-sequence");
		expect(check?.verdict).toBe("SKIP");
		expect(check?.detail, "must name the read failure").toMatch(
			/could not be read/,
		);
		expect(
			check?.detail,
			"must NOT claim the playlist grew, which was never observed",
		).not.toMatch(/grew by/);
	});

	it("still says GROWING when the playlist was readable and simply short", async () => {
		// The complement, so the read-failure wording cannot swallow the normal case.
		const deps = healthy();
		const first = deps.samples.at(0);
		const last = deps.samples.at(-1);
		if (first && last) {
			first.playlistSegments = 2;
			last.playlistSegments = 9;
			first.mediaSequence = 0;
			last.mediaSequence = 0;
		}
		const check = (
			await verifyLiveChannel(load("live-rtmp-simple"), deps)
		).checks.find((c) => c.id === "live:media-sequence");
		expect(check?.verdict).toBe("SKIP");
		expect(check?.detail).toMatch(/grew by 7 segment/);
		expect(check?.detail).not.toMatch(/could not be read/);
	});
});

describe("live manifests are verified, not inferred from a directory listing", () => {
	/**
	 * The live engine reads only the HLS media playlist, through `samples`. That is right for the
	 * movement checks and it left the MANIFESTS unchecked: `live-srt-listener` writes a
	 * `stream.mpd` that a bucket listing plainly shows, and nothing in the engine looked at it. So
	 * "live DASH works" rested on my having seen a filename, which is not a check.
	 *
	 * Three mutations survived when these checks first landed — deleting them, accepting a
	 * zero-byte manifest, accepting any rendition count — because the happy-path test only asserts
	 * the absence of FAILs. Presence and both directions are pinned here.
	 */
	const expected = load("live-rtmp-simple");
	const legs = expected.muxings.length;

	function withManifests(
		files: NonNullable<LiveEngineDeps["manifestFiles"]>,
	): LiveEngineDeps {
		return { ...healthy(), manifestFiles: files };
	}

	const healthyFiles = () =>
		expected.manifests.map((m) => ({
			manifestKey: m.manifestKey,
			kind: m.kind,
			key: `${m.dir.prefix}${m.files[0]}`,
			bytes: 512,
			entries: legs,
			// A healthy runner also collects the DASH set structure .
			...(m.kind === "DASH" ? { videoCodecSets: [["avc1.640028"]] } : {}),
		}));

	it("emits one check per declared manifest, and passes on a healthy set", async () => {
		const report = await verifyLiveChannel(
			expected,
			withManifests(healthyFiles()),
		);
		const ids = report.checks
			.filter((c) => /^live:manifest:/.test(c.id))
			.map((c) => `${c.id}=${c.verdict}`)
			.sort();
		// One existence check and one entries check per manifest — the fixture has HLS and DASH.
		expect(ids).toEqual([
			"live:manifest:dash:codec-sets=PASS",
			"live:manifest:dash:entries=PASS",
			"live:manifest:dash=PASS",
			"live:manifest:hls:entries=PASS",
			"live:manifest:hls=PASS",
		]);
	});

	it("FAILS a manifest the runner could not read", async () => {
		// Declared in the plan, so its absence is the product's — a FAIL, not a SKIP.
		const files = healthyFiles();
		const dash = files.find((f) => f.kind === "DASH");
		const report = await verifyLiveChannel(
			expected,
			withManifests([
				...files.filter((f) => f.kind !== "DASH"),
				{
					manifestKey: dash?.manifestKey ?? "dash",
					kind: "DASH" as const,
					key: dash?.key ?? "x/stream.mpd",
					error: "NoSuchKey",
				},
			]),
		);
		const c = report.checks.find((x) => x.id === "live:manifest:dash");
		expect(c?.verdict).toBe("FAIL");
		expect(c?.detail).toContain("NoSuchKey");
	});

	it("FAILS a zero-byte manifest", async () => {
		const report = await verifyLiveChannel(
			expected,
			withManifests(healthyFiles().map((f) => ({ ...f, bytes: 0 }))),
		);
		expect(
			report.checks
				.filter((c) => /^live:manifest:[a-z]+$/.test(c.id))
				.map((c) => c.verdict),
		).toEqual(["FAIL", "FAIL"]);
	});

	it("FAILS a manifest enumerating more renditions than the channel has legs", async () => {
		const report = await verifyLiveChannel(
			expected,
			withManifests(healthyFiles().map((f) => ({ ...f, entries: legs + 3 }))),
		);
		expect(
			report.checks.filter((c) => /:entries$/.test(c.id)).map((c) => c.verdict),
		).toEqual(["FAIL", "FAIL"]);
	});

	it("accepts FEWER renditions than declared — a live ladder may still be coming up", async () => {
		// One-sided on purpose: a channel fed for seconds can legitimately publish a partial
		// ladder, and failing that would be the same false red the per-title bound had.
		const report = await verifyLiveChannel(
			expected,
			withManifests(healthyFiles().map((f) => ({ ...f, entries: 1 }))),
		);
		expect(
			report.checks.filter((c) => /:entries$/.test(c.id)).map((c) => c.verdict),
		).toEqual(["PASS", "PASS"]);
	});

	it("SKIPS, rather than passing, when the runner collected nothing", async () => {
		// A runner that did not collect must not read as a healthy manifest set.
		const deps = healthy();
		const report = await verifyLiveChannel(expected, deps);
		const manifestChecks = report.checks.filter((c) =>
			/^live:manifest:/.test(c.id),
		);
		expect(manifestChecks.length).toBeGreaterThan(0);
		expect(manifestChecks.every((c) => c.verdict === "SKIP")).toBe(true);
	});
});

describe("DASH set STRUCTURE — one video AdaptationSet per codec (ledger #229, paid case F)", () => {
	const expected = load("live-rtmp-simple");
	const dash =
		expected.manifests.find((m) => m.kind === "DASH") ??
		(() => {
			throw new Error(
				"live-rtmp-simple must carry a DASH manifest for this suite",
			);
		})();
	const legs = expected.muxings.length;
	function deps(
		videoCodecSets?: string[][],
		videoCodecs?: string[],
	): LiveEngineDeps {
		const exp = {
			...expected,
			manifests: expected.manifests.map((m) =>
				m.manifestKey === dash.manifestKey && videoCodecs
					? { ...m, videoCodecs }
					: m,
			),
		};
		return {
			...healthy(),
			manifestFiles: exp.manifests.map((m) => ({
				manifestKey: m.manifestKey,
				kind: m.kind,
				key: `${m.dir.prefix}${m.files[0]}`,
				bytes: 512,
				entries: legs,
				...(m.kind === "DASH" && videoCodecSets ? { videoCodecSets } : {}),
			})),
		};
	}
	const run = async (videoCodecSets?: string[][], videoCodecs?: string[]) => {
		const exp = {
			...expected,
			manifests: expected.manifests.map((m) =>
				m.manifestKey === dash.manifestKey && videoCodecs
					? { ...m, videoCodecs }
					: m,
			),
		};
		const report = await verifyLiveChannel(
			exp,
			deps(videoCodecSets, videoCodecs),
		);
		const id = `live:manifest:${dash.manifestKey}`;
		return {
			sets: report.checks.find((c) => c.id === `${id}:codec-sets`),
			homogeneous: report.checks.find(
				(c) => c.id === `${id}:codec-sets-homogeneous`,
			),
		};
	};
	it("the fixture's own expectation names its video codec(s)", () => {
		expect(dash.videoCodecs).toEqual(["H264"]);
	});
	it("one H264 set for a single-codec manifest passes, and no homogeneity check is emitted", async () => {
		const r = await run([["avc1.640028"]]);
		expect(r.sets?.verdict).toBe("PASS");
		expect(r.homogeneous).toBeUndefined();
	});
	it("paid case F — two codecs in ONE set — fails both the set count and the homogeneity check", async () => {
		const r = await run(
			[["avc1.640028", "hvc1.1.6.L153.90"]],
			["H264", "H265"],
		);
		expect(r.sets?.verdict).toBe("FAIL");
		expect(r.sets?.detail).toMatch(
			/2 video AdaptationSet\(s\) for H264\+H265 — found 1 set\(s\)/,
		);
		expect(r.homogeneous?.verdict).toBe("FAIL");
		expect(r.homogeneous?.detail).toMatch(/paid case F/);
	});
	it("two homogeneous sets for two codecs pass; a set carrying the WRONG codec fails", async () => {
		const ok = await run(
			[["avc1.640028"], ["hev1.1.6.L153.90"]],
			["H264", "H265"],
		);
		expect(ok.sets?.verdict).toBe("PASS");
		expect(ok.homogeneous?.verdict).toBe("PASS");
		const wrong = await run(
			[["avc1.640028"], ["av01.0.08M.08"]],
			["H264", "H265"],
		);
		expect(wrong.sets?.verdict).toBe("FAIL");
	});
	it("SKIPs by name when the parser exposed no set structure", async () => {
		const r = await run(undefined);
		expect(r.sets?.verdict).toBe("SKIP");
	});
	it("maps RFC 6381 strings to the plan's families", () => {
		expect(
			[
				"avc1.4d401f",
				"avc3.64001f",
				"hvc1.1.6.L93.B0",
				"hev1.2.4.L120.B0",
				"av01.0.05M.08",
				"vp09.00.10.08",
				"mp4a.40.2",
			].map(codecFamily),
		).toEqual(["H264", "H264", "H265", "H265", "AV1", "VP9", "mp4a"]);
	});
});

describe("verifyMirrorDelivery — each delivery-mirror leg is judged on its own", () => {
	// live-akamai-msl-storage: Akamai Object Storage PRIMARY (readable) + an
	// AKAMAI_MSL mirror (Akamai ingest, read back on the edge). hls + dash, each
	// mirrored to `mirror-1` → two mirror legs.
	const MSL_STORAGE = "live-akamai-msl-storage";
	const mirrorChecks = (r: Awaited<ReturnType<typeof verifyLiveChannel>>) =>
		r.checks.filter((c) => c.id.startsWith("live:mirror:"));

	it("emits one mirror leg per (manifest, MSL mirror), and UNOBSERVED without an edge read is a SKIP — never a silent pass", async () => {
		const report = await verifyLiveChannel(load(MSL_STORAGE), healthy());
		const mirror = mirrorChecks(report);
		expect(mirror.map((c) => c.id).sort()).toEqual([
			"live:mirror:dash:mirror-1",
			"live:mirror:hls:mirror-1",
		]);
		// `healthy` supplies no edgeClosures → the mirror was not looked at, so
		// every leg SKIPs UNOBSERVED. A SKIP does not pass the run (the runner's
		// mirror floor refuses the origin-only pass), which is what makes the
		// origin+mirror topology honest.
		expect(mirror.every((c) => c.verdict === "SKIP")).toBe(true);
	});

	it.each([
		["live-akamai-msl-ts", ["live:edge:hls:origin"]],
		["live-akamai-msl", ["live:edge:dash:origin", "live:edge:hls:origin"]],
	] as const)("emits direct MSL4 EDGE checks for %s and no mirror/storage surrogate", async (scenario, ids) => {
		const report = await verifyLiveChannel(load(scenario), healthy());
		const edge = report.checks
			.filter((check) => check.id.startsWith("live:edge:"))
			.map((check) => check.id)
			.sort();
		expect(edge).toEqual([...ids]);
		expect(
			report.checks.filter((check) => check.id.startsWith("live:mirror:")),
		).toEqual([]);
		expect(
			report.checks
				.filter((check) => check.id.startsWith("live:edge:"))
				.every((check) => check.verdict === "SKIP"),
		).toBe(true);
	});

	/**
	 * a leg PASSes only on TWO in-run probes
	 * (`samples[].edge`), each closed — ≥1 child, every child ≥1 nonzero media
	 * segment served with bytes — and media ADVANCING between them. The
	 * post-stop `edgeClosures` entry can no longer pass a leg on its own: a
	 * master that returned 200 after the stop is not delivery. The first cut
	 * of this test passed a leg on exactly that, which is the audited defect.
	 */
	const url = (path: string) => ({
		origin: "https://edge.example",
		path,
		queryKeys: [],
		urlSha256: "0".repeat(64),
	});
	/**
	 * The fake run starts at the epoch and its edge stamps every served object
	 * at the probe's own instant — FRESH by construction. The freshness arms
	 * below override `lastModified` / `runningSince` one at a time (WP-C6b).
	 */
	const RUNNING_SINCE = new Date(0).toISOString();
	const closedAt = (
		manifestKey: "hls" | "dash",
		at: number,
		seq: number,
		freshness: {
			lastModified?: string | null;
			runningSince?: string | null;
		} = {},
	): LiveEdgeClosure => ({
		manifestKey,
		outputKey: "mirror-1",
		masterUrl: `https://edge.example/verify/run/${manifestKey}/stream`,
		closed: true,
		at,
		...(freshness.runningSince === null
			? {}
			: { runningSince: freshness.runningSince ?? RUNNING_SINCE }),
		master: {
			url: url(`/verify/run/${manifestKey}/stream`),
			bytes: 200,
			sha256: "m".repeat(64),
			entries: 1,
		},
		childCount: 1,
		segmentCount: 1,
		children: [
			{
				id: "child-1",
				requiresInit: false,
				url: url(`/verify/run/${manifestKey}/child-1`),
				mediaSequence: seq,
				listed: 5,
				served: [
					{
						key: `seg-${seq}`,
						url: url(`/verify/run/${manifestKey}/seg-${seq}`),
						bytes: 500_000,
						sha256: "s".repeat(64),
						init: false,
						reference: `seg-${seq}`,
						...(freshness.lastModified === null
							? {}
							: {
									lastModified:
										freshness.lastModified ?? new Date(at).toISOString(),
								}),
					},
				],
				missing: [],
			},
		],
		msl: {
			outputKey: "mirror-1",
			credentialId: "00000000-0000-4000-8000-000000000004",
			providerOutputId: "provider-output-mirror-1",
			streamId: 1,
			eventName: "ev",
			streamFormat: "CMAF",
			mslVersion: "MSL4",
			eventRoot: url("/cmaf/live/1/ev/"),
		},
	});
	const withProbes = (probes: [number, number][]) => {
		const deps = healthy();
		deps.samples = deps.samples.map((s, i) => {
			const probe = probes[i];
			return probe
				? {
						...s,
						edge: [
							closedAt("hls", probe[0], probe[1]),
							closedAt("dash", probe[0], probe[1]),
						],
					}
				: s;
		});
		return deps;
	};

	it("PASSes a leg witnessed by two in-run probes with media ADVANCING between them — and every object this airing's", async () => {
		const report = await verifyLiveChannel(
			load(MSL_STORAGE),
			withProbes([
				[1_000, 10],
				[13_000, 12],
			]),
		);
		const mirror = mirrorChecks(report);
		expect(mirror).toHaveLength(2);
		expect(
			mirror.every((c) => c.verdict === "PASS"),
			JSON.stringify(mirror),
		).toBe(true);
		expect(mirror[0]?.detail).toContain("media sequence 10 → 12");
		expect(mirror[0]?.detail).toContain("every served object is this airing's");
		const freshness = report.checks.filter((c) =>
			c.id.startsWith("live:segment-freshness:"),
		);
		expect(freshness.map((c) => [c.id, c.verdict])).toEqual([
			["live:segment-freshness:hls:mirror-1", "PASS"],
			["live:segment-freshness:dash:mirror-1", "PASS"],
		]);
	});

	/**
	 * THE MEASURED SHAPE (WP-C6b, channel 0645c2f1, 2026-09-02, measurement doc
	 * Part 9): the root playlists ADVANCED normally (seq 845 → 904) while every
	 * object they named carried the FIRST airing's Last-Modified (08:18Z) at a
	 * 13:25Z start. Progression alone would have passed exactly this.
	 */
	describe("object freshness — progression alone never passes a rendition", () => {
		const probesWith = (
			freshness: Parameters<typeof closedAt>[3],
			runningSince?: string,
		) => {
			const deps = healthy();
			const probes: [number, number][] = [
				[1_000, 845],
				[13_000, 904],
			];
			deps.samples = deps.samples.map((s, i) => {
				const probe = probes[i];
				return probe
					? {
							...s,
							edge: [
								closedAt("hls", probe[0], probe[1], {
									...freshness,
									...(runningSince !== undefined ? { runningSince } : {}),
								}),
								closedAt("dash", probe[0], probe[1], {
									...freshness,
									...(runningSince !== undefined ? { runningSince } : {}),
								}),
							],
						}
					: s;
			});
			return deps;
		};
		const hlsOf = (report: Awaited<ReturnType<typeof verifyLiveChannel>>) => ({
			mirror: report.checks.find((c) => c.id === "live:mirror:hls:mirror-1"),
			freshness: report.checks.find(
				(c) => c.id === "live:segment-freshness:hls:mirror-1",
			),
		});

		it("FAILs when a served object predates the airing — the stale-object shape", async () => {
			// runningSince 13:25Z, the object's Last-Modified 08:18Z the same day.
			const report = await verifyLiveChannel(
				load(MSL_STORAGE),
				probesWith(
					{ lastModified: "2026-09-02T08:18:11.000Z" },
					"2026-09-02T13:25:15.048Z",
				),
			);
			const { mirror, freshness } = hlsOf(report);
			expect(freshness?.verdict).toBe("FAIL");
			expect(freshness?.detail).toContain("2026-09-02T08:18:11.000Z");
			expect(freshness?.detail).toContain("2026-09-02T13:25:15.048Z");
			expect(freshness?.detail).toContain("previous airing");
			// The leg itself fails too, even though the playlists advanced.
			expect(mirror?.verdict).toBe("FAIL");
			expect(mirror?.detail).toContain("media sequence 845 → 904");
			expect(mirror?.detail).toContain("previous airing");
		});

		it("is UNVERIFIED (never a pass) when the edge sent no Last-Modified — the leg WARNs", async () => {
			const report = await verifyLiveChannel(
				load(MSL_STORAGE),
				probesWith({ lastModified: null }),
			);
			const { mirror, freshness } = hlsOf(report);
			expect(freshness?.verdict).toBe("SKIP");
			expect(freshness?.detail).toContain("UNVERIFIED");
			expect(freshness?.detail).toContain("no readable Last-Modified");
			expect(mirror?.verdict).toBe("WARN");
			expect(mirror?.detail).toContain("progression alone is not delivery");
		});

		it("is UNVERIFIED when the airing's runningSince is unknown", async () => {
			const report = await verifyLiveChannel(
				load(MSL_STORAGE),
				probesWith({ runningSince: null }),
			);
			const { mirror, freshness } = hlsOf(report);
			expect(freshness?.verdict).toBe("SKIP");
			expect(freshness?.detail).toContain("runningSince is unknown");
			expect(mirror?.verdict).toBe("WARN");
		});

		it("tolerates an object stamped up to 60 s BEFORE runningSince, and not one second more", async () => {
			const since = "2026-09-02T13:25:15.000Z";
			const within = await verifyLiveChannel(
				load(MSL_STORAGE),
				probesWith({ lastModified: "2026-09-02T13:24:15.000Z" }, since),
			);
			expect(hlsOf(within).freshness?.verdict).toBe("PASS");
			const beyond = await verifyLiveChannel(
				load(MSL_STORAGE),
				probesWith({ lastModified: "2026-09-02T13:24:14.000Z" }, since),
			);
			expect(hlsOf(beyond).freshness?.verdict).toBe("FAIL");
		});
	});

	it("counts direct MSL edge progression as measured movement when storage is intentionally unobservable", async () => {
		const deps = withProbes([
			[1_000, 10],
			[13_000, 12],
		]);
		deps.samples = deps.samples.map((sample) => ({
			...sample,
			mediaSequence: undefined,
			playlistSegments: undefined,
			heartbeatRows: undefined,
			objects: undefined,
			edge: sample.edge?.map((closure) => ({
				...closure,
				outputKey: "origin",
				msl: closure.msl
					? {
							...closure.msl,
							outputKey: "origin",
							providerOutputId: "provider-output-origin",
						}
					: undefined,
			})),
		}));

		const report = await verifyLiveChannel(load("live-akamai-msl-ts"), deps);
		expect(
			report.checks.find((check) => check.id === "live:edge:hls:origin")
				?.verdict,
		).toBe("PASS");
		expect(
			report.checks.find((check) => check.id === "live:measured-something"),
		).toBeUndefined();
	});

	it("does not reclassify two healthy in-run probes as delivery failure when the optional post-stop read faults", async () => {
		const deps = withProbes([
			[1_000, 10],
			[13_000, 12],
		]);
		deps.edgeClosures = [
			{
				...closedAt("hls", 20_000, 12),
				closed: false,
				error: "post-stop HTTP 503",
			},
			{
				...closedAt("dash", 20_000, 12),
				closed: false,
				error: "post-stop HTTP 503",
			},
		];
		const report = await verifyLiveChannel(load(MSL_STORAGE), deps);
		expect(
			mirrorChecks(report).every((check) => check.verdict === "PASS"),
		).toBe(true);
	});

	it("FAILs two IDENTICAL in-run snapshots — a stalled edge is not delivery", async () => {
		const report = await verifyLiveChannel(
			load(MSL_STORAGE),
			withProbes([
				[1_000, 10],
				[13_000, 10],
			]),
		);
		const hls = report.checks.find((c) => c.id === "live:mirror:hls:mirror-1");
		expect(hls?.verdict).toBe("FAIL");
		expect(hls?.detail).toContain("identical media served");
	});

	it("FAILs a leg probed only ONCE in-run — progression needs two", async () => {
		const report = await verifyLiveChannel(
			load(MSL_STORAGE),
			withProbes([[1_000, 10]]),
		);
		const hls = report.checks.find((c) => c.id === "live:mirror:hls:mirror-1");
		expect(hls?.verdict).toBe("FAIL");
		expect(hls?.detail).toContain("only 1 time(s)");
	});

	it("a CLOSED post-stop closure with NO in-run probe is UNOBSERVED (SKIP), never a pass — the audited shape", async () => {
		const deps = healthy();
		deps.edgeClosures = [
			closedAt("hls", 20_000, 14),
			closedAt("dash", 20_000, 14),
		];
		const report = await verifyLiveChannel(load(MSL_STORAGE), deps);
		const mirror = mirrorChecks(report);
		expect(mirror).toHaveLength(2);
		expect(mirror.every((c) => c.verdict === "SKIP")).toBe(true);
		expect(mirror[0]?.detail).toContain(
			"post-stop closure alone is UNOBSERVED",
		);
	});

	it("FAILs a leg whose in-run probe did not close — one child without media", async () => {
		const deps = withProbes([
			[1_000, 10],
			[13_000, 12],
		]);
		const open = closedAt("hls", 1_000, 10);
		open.closed = false;
		open.segmentCount = 0;
		open.missing = ["child-1: seg-10 (HTTP 404, 0 bytes)"];
		deps.samples[0] = {
			...(deps.samples[0] as LiveSample),
			edge: [open, closedAt("dash", 1_000, 10)],
		};
		const report = await verifyLiveChannel(load(MSL_STORAGE), deps);
		const hls = report.checks.find((c) => c.id === "live:mirror:hls:mirror-1");
		expect(hls?.verdict).toBe("FAIL");
		expect(hls?.detail).toContain("did not close");
		expect(hls?.detail).toContain("seg-10 (HTTP 404");
		// The other leg, fully witnessed, still PASSes on its own.
		expect(
			report.checks.find((c) => c.id === "live:mirror:dash:mirror-1")?.verdict,
		).toBe("PASS");
	});

	it("FAILs a mirror that delivered NOTHING on the edge — not a silent pass (negative fixture)", async () => {
		const deps = healthy();
		deps.edgeClosures = [
			{
				manifestKey: "hls",
				outputKey: "mirror-1",
				masterUrl: "https://edge.example/verify/run/hls/stream.m3u8",
				closed: false,
				childCount: 4,
				segmentCount: 12,
				missing: ["verify/run/hls/video_4500000/seg-1.m4s (HTTP 404)"],
			},
			{
				manifestKey: "dash",
				outputKey: "mirror-1",
				masterUrl: "https://edge.example/verify/run/dash/stream.mpd",
				closed: true,
				childCount: 1,
				segmentCount: 0,
			},
		];
		const report = await verifyLiveChannel(load(MSL_STORAGE), deps);
		const hls = report.checks.find((c) => c.id === "live:mirror:hls:mirror-1");
		expect(hls?.verdict).toBe("FAIL");
		expect(hls?.detail).toContain("not served");
	});

	it("FAILs a leg the edge read THREW on — a fault is a finding, not silence", async () => {
		const deps = healthy();
		deps.edgeClosures = [
			{
				manifestKey: "hls",
				outputKey: "mirror-1",
				masterUrl: "https://edge.example/verify/run/hls/stream.m3u8",
				closed: false,
				error: "master read threw: getaddrinfo ENOTFOUND",
			},
			{
				manifestKey: "dash",
				outputKey: "mirror-1",
				masterUrl: "https://edge.example/verify/run/dash/stream.mpd",
				closed: true,
				childCount: 1,
			},
		];
		const report = await verifyLiveChannel(load(MSL_STORAGE), deps);
		const hls = report.checks.find((c) => c.id === "live:mirror:hls:mirror-1");
		expect(hls?.verdict).toBe("FAIL");
		expect(hls?.detail).toContain("edge read failed");
	});

	it("a fixture with no delivery mirror emits no mirror legs at all", async () => {
		const report = await verifyLiveChannel(load("live-rtmp-simple"), healthy());
		expect(mirrorChecks(report)).toEqual([]);
	});
});

it("rejects a missing encrypted ladder when only a different output contains the same keys", async () => {
	const expected = load("live-rtmp-simple");
	expected.muxings.push(
		...expected.muxings.map((m) => ({
			...m,
			outputKey: "encrypted",
			drmKey: `${m.muxingKey}-enc`,
			drmKind: "FAIRPLAY" as const,
		})),
	);
	const deps = healthy();
	const report = await verifyLiveChannel(expected, deps);
	expect(report.checks.find((c) => c.id === "live:ladder")?.verdict).toBe(
		"FAIL",
	);
	for (const s of deps.samples)
		s.objects?.push(
			...(s.objects ?? []).map((o) => ({ ...o, outputKey: "encrypted" })),
		);
	const correct = await verifyLiveChannel(expected, deps);
	expect(correct.checks.find((c) => c.id === "live:ladder")?.verdict).toBe(
		"PASS",
	);
});

it("does not let a nested encrypted output stand in for a missing clear ladder", async () => {
	const expected = load("live-rtmp-simple");
	expected.muxings.push(
		...expected.muxings.map((m) => ({
			...m,
			dir: { ...m.dir, prefix: `${m.dir.prefix}encrypted/` },
			drmKey: `${m.muxingKey}-enc`,
			drmKind: "FAIRPLAY" as const,
		})),
	);
	const deps = healthy();
	for (const s of deps.samples)
		s.objects = s.objects?.map((o) => ({
			...o,
			key: o.key.replace(/([^/]+)$/, "encrypted/$1"),
		}));
	const missing = await verifyLiveChannel(expected, deps);
	expect(missing.checks.find((c) => c.id === "live:ladder")?.verdict).toBe(
		"FAIL",
	);
	for (const s of deps.samples)
		s.objects?.push(
			...s.objects.map((o) => ({
				...o,
				key: o.key.replace("/encrypted/", "/"),
			})),
		);
	const complete = await verifyLiveChannel(expected, deps);
	expect(complete.checks.find((c) => c.id === "live:ladder")?.verdict).toBe(
		"PASS",
	);
});

it.each([
	"not-init.mp4",
	"encrypted/init.mp4",
	"encrypted/segment_1.m4s",
])("does not admit %s as a writer's own filename", async (name) => {
	const expected = load("live-rtmp-simple");
	const first = expected.muxings[0];
	if (!first) throw new Error("Missing muxing fixture");
	const deps = healthy();
	for (const s of deps.samples)
		s.objects = [
			...(s.objects ?? []).filter((o) => !o.key.startsWith(first.dir.prefix)),
			{
				outputKey: first.outputKey,
				key: `${first.dir.prefix}${name}`,
				size: 900,
			},
		];
	const report = await verifyLiveChannel(expected, deps);
	expect(report.checks.find((c) => c.id === "live:ladder")?.verdict).toBe(
		"FAIL",
	);
});
