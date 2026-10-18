import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { initStepLog, type StepLogEntry } from "../plan/steplog";
import { compileLiveChannel } from "./compiler";
import { liveChannelPlanSchema } from "./schema";
import {
	liveToVodFamilySupport,
	priorRollManifestFiles,
	resolveLiveToVodTarget,
	supportedLiveToVodFamilies,
} from "./vod-manifest-target";

/**
 * Audit 5c3d97ca HIGH-1 / §14.6 LF-02 : the live-to-VOD DEFAULT
 * family set is "every family the recorded muxings are compatible with", not
 * "both". The fixtures are REAL live plans compiled through the real compiler
 * — `live-hls-ts-muxed` is the exact 2×TS + HLS topology the paid run rolled
 * , `live-rtmp-simple` the fMP4 HLS+DASH control.
 */
function compiledLog(fixture: string): StepLogEntry[] {
	const plan = liveChannelPlanSchema.parse(
		JSON.parse(
			readFileSync(
				join(__dirname, `__fixtures__/${fixture}.plan.json`),
				"utf8",
			),
		),
	);
	return initStepLog(compileLiveChannel(plan));
}

const TS_LOG = compiledLog("live-hls-ts-muxed");
const TS_SEPARATED_LOG = compiledLog("live-akamai-msl-ts");
const FMP4_LOG = compiledLog("live-rtmp-simple");

describe("liveToVodFamilySupport", () => {
	it("a segmented-TS recording supports HLS only, and says which muxing rules DASH out", () => {
		// The premise of the test: the fixture really is TS-only.
		const kinds = TS_LOG.filter((e) => e.kind.startsWith("CREATE_MUXING_")).map(
			(e) => e.kind,
		);
		expect(kinds.length).toBeGreaterThan(0);
		expect(new Set(kinds)).toEqual(new Set(["CREATE_MUXING_TS"]));
		expect(
			TS_LOG.filter((entry) => entry.kind.startsWith("CREATE_MANIFEST_")).map(
				(entry) => entry.kind,
			),
		).toEqual(["CREATE_MANIFEST_HLS"]);

		const support = liveToVodFamilySupport(TS_LOG);
		expect(support.supported).toEqual(["HLS"]);
		expect(support.unsupported).toHaveLength(1);
		const dash = support.unsupported[0];
		expect(dash?.family).toBe("DASH");
		// The reason names the offending muxing step, the provider code and the
		// families that DO work — what the 422 and the record's SKIPPED entry show.
		expect(dash?.reason).toMatch(/CREATE_MUXING_TS/);
		expect(dash?.reason).toMatch(/2700/);
		expect(dash?.reason).toMatch(/HLS only/);
		expect(dash?.reason).toMatch(/"muxing:/);
		expect(supportedLiveToVodFamilies(TS_LOG)).toEqual(["HLS"]);
	});

	it("an fMP4 recording keeps HLS + DASH (non-regression boundary §14.2)", () => {
		const kinds = FMP4_LOG.filter((e) =>
			e.kind.startsWith("CREATE_MUXING_"),
		).map((e) => e.kind);
		expect(new Set(kinds)).toEqual(new Set(["CREATE_MUXING_FMP4"]));
		expect(
			new Set(
				FMP4_LOG.filter((entry) =>
					entry.kind.startsWith("CREATE_MANIFEST_"),
				).map((entry) => entry.kind),
			),
		).toEqual(new Set(["CREATE_MANIFEST_HLS", "CREATE_MANIFEST_DASH"]));
		expect(liveToVodFamilySupport(FMP4_LOG)).toEqual({
			supported: ["HLS", "DASH"],
			unsupported: [],
		});
	});

	it("separated video/audio TS renditions still support HLS only", () => {
		const muxings = TS_SEPARATED_LOG.filter((entry) =>
			entry.kind.startsWith("CREATE_MUXING_"),
		);
		// The real Akamai TS fixture has three independent video muxings plus one
		// independent audio muxing. Compatibility is a container-family property;
		// separating audio must not accidentally re-enable DASH or disable HLS.
		expect(muxings).toHaveLength(4);
		expect(new Set(muxings.map((entry) => entry.kind))).toEqual(
			new Set(["CREATE_MUXING_TS"]),
		);
		expect(
			TS_SEPARATED_LOG.filter((entry) =>
				entry.kind.startsWith("CREATE_MANIFEST_"),
			).map((entry) => entry.kind),
		).toEqual(["CREATE_MANIFEST_HLS"]);
		expect(supportedLiveToVodFamilies(TS_SEPARATED_LOG)).toEqual(["HLS"]);
	});

	it("a mixed fMP4 + TS recording is HLS-only — the generator judges the muxing SET", () => {
		const mixed: StepLogEntry[] = [
			...FMP4_LOG,
			{
				step: "muxing:ts-extra",
				kind: "CREATE_MUXING_TS",
				payload: { outputPath: "output/live-rtmp-simple/video/ts" },
				refs: {},
				status: "DONE",
			},
		];
		expect(supportedLiveToVodFamilies(mixed)).toEqual(["HLS"]);
	});

	const ARCHIVE_ENTRY: StepLogEntry = {
		step: "muxing:archive",
		kind: "CREATE_MUXING_MP4",
		payload: { outputPath: "archive/elsewhere", filename: "recording.mp4" },
		refs: {},
		status: "DONE",
	};

	it("a TS recording with a progressive MP4 archive is HLS-only — the archive is not a playlist source (row #323)", () => {
		const archived = [...TS_LOG, ARCHIVE_ENTRY];
		const support = liveToVodFamilySupport(archived);
		expect(support.supported).toEqual(["HLS"]);
		expect(support.unsupported.map((u) => u.family)).toEqual(["DASH"]);
		expect(support.unsupported[0]?.reason).toContain("segmented MPEG-TS");
		expect(support.unsupported[0]?.reason).not.toContain("CREATE_MUXING_MP4");
		// Nor does the archive move the manifest: written elsewhere, it used to
		// drag the common parent up to "" (the output root).
		const plain = resolveLiveToVodTarget(TS_LOG);
		const withArchive = resolveLiveToVodTarget(archived);
		expect(plain.ok && plain.target.path).not.toBe("");
		expect(withArchive.ok && withArchive.target.path).toBe(
			plain.ok && plain.target.path,
		);
	});

	it("an fMP4 recording with an archive keeps HLS + DASH (row #323)", () => {
		expect(supportedLiveToVodFamilies([...FMP4_LOG, ARCHIVE_ENTRY])).toEqual([
			"HLS",
			"DASH",
		]);
	});

	it("an archive-only recording supports nothing, and the resolver refuses for the same reason (row #323)", () => {
		const archiveOnly = [
			...FMP4_LOG.filter((e) => !e.kind.startsWith("CREATE_MUXING_")),
			ARCHIVE_ENTRY,
		];
		const support = liveToVodFamilySupport(archiveOnly);
		expect(support.supported).toEqual([]);
		expect(support.unsupported[0]?.reason).toMatch(
			/no segmented muxing.*muxing:archive.*progressive MP4 archive/,
		);
		const target = resolveLiveToVodTarget(archiveOnly);
		expect(target.ok).toBe(false);
		expect(!target.ok && target.reason).toBe(support.unsupported[0]?.reason);
	});

	it("a step log with no muxing supports nothing, for the same reason the target resolver refuses it", () => {
		const bare = FMP4_LOG.filter((e) => !e.kind.startsWith("CREATE_MUXING_"));
		const support = liveToVodFamilySupport(bare);
		expect(support.supported).toEqual([]);
		expect(support.unsupported.map((u) => u.family)).toEqual(["HLS", "DASH"]);
		expect(support.unsupported[0]?.reason).toMatch(/no muxing/);
		const target = resolveLiveToVodTarget(bare);
		expect(target.ok).toBe(false);
	});

	it("an unknown live muxing kind rules out both families rather than being guessed compatible", () => {
		const odd: StepLogEntry[] = [
			{
				step: "muxing:x",
				kind: "CREATE_MUXING_WEBM",
				payload: { outputPath: "a/b" },
				refs: {},
				status: "DONE",
			},
		];
		expect(supportedLiveToVodFamilies(odd)).toEqual([]);
	});
});

describe("priorRollManifestFiles reads families too (ledger #283)", () => {
	it("counts a family's url even when it never reached manifests[] (created, then failed)", () => {
		// The fixture's own derived destination — the directory a retry rolls into.
		const base = "output/live-rtmp-simple";
		const files = priorRollManifestFiles([
			{
				status: "PARTIAL",
				families: [
					{
						type: "HLS",
						status: "FINISHED",
						manifestId: "h",
						url: `${base}/vod.m3u8`,
					},
					{
						type: "DASH",
						status: "ERROR",
						manifestId: "d",
						url: `/${base}/vod.mpd/`,
						error: "ended ERROR",
					},
				],
				manifests: [{ type: "HLS", manifestId: "h", url: `${base}/vod.m3u8` }],
			},
		]);
		// Both, normalised; the FINISHED one appears via both lists, which the
		// monotonic name counter treats as one taken name.
		expect(files).toContain(`${base}/vod.m3u8`);
		expect(files).toContain(`${base}/vod.mpd`);
		// And the resolver hands the failed family's successor the NEXT index.
		const target = resolveLiveToVodTarget(FMP4_LOG, undefined, files);
		expect(target.ok).toBe(true);
		expect(target.ok && target.target.path).toBe(base);
		expect(target.ok && target.target.nameFor("DASH")).toBe("vod-2.mpd");
		expect(target.ok && target.target.nameFor("HLS")).toBe("vod-2.m3u8");
	});

	it("ignores families entries that carry no url", () => {
		expect(
			priorRollManifestFiles([
				{ families: [{ type: "HLS", status: "PENDING" }, null, 3] },
			]),
		).toEqual([]);
	});
});
