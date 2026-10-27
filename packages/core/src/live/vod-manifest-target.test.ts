import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { initStepLog, type StepLogEntry } from "../plan/steplog";
import { compileLiveChannel } from "./compiler";
import { compileLiveRunStepLog } from "./run-rebase";
import { liveChannelPlanSchema } from "./schema";
import {
	commonPathParent,
	isPathParentOf,
	joinManifestPath,
	priorRollManifestFiles,
	recordedLiveOutputs,
	resolveLiveToVodTarget,
	vodManifestFileName,
} from "./vod-manifest-target";

/**
 * C35 /  — a DEFAULT manifest's `outputPath` must be a PARENT of every
 * muxing's, or Bitmovin refuses the create with `code 2701`.
 *
 * The fixture is a REAL live plan compiled through the real compiler, not a
 * hand-built step log: the whole point of reading the step log is that it is
 * what the executor sends, and a hand-typed one would only prove the helper
 * agrees with the test author.
 */
const PLAN = liveChannelPlanSchema.parse(
	JSON.parse(
		readFileSync(
			join(__dirname, "__fixtures__/live-rtmp-simple.plan.json"),
			"utf8",
		),
	),
);

const LOG = initStepLog(compileLiveChannel(PLAN));

describe("path algebra", () => {
	it("compares by SEGMENT — a shared string prefix is not a parent", () => {
		expect(isPathParentOf("out/video", "out/video/1080p")).toBe(true);
		expect(isPathParentOf("out", "out/video/1080p")).toBe(true);
		expect(isPathParentOf("", "out/video")).toBe(true);
		// Equality counts: a manifest beside its own muxing is a legal "sub path".
		expect(isPathParentOf("out/video", "out/video")).toBe(true);
		// The near-miss `startsWith` gets wrong, and the one that matters here:
		// `vid` is not a parent of `video`, and `<base>/vod` is not a parent of
		// `<base>/video` — which is exactly the defect this module fixes.
		expect(isPathParentOf("out/vid", "out/video/1080p")).toBe(false);
		expect(isPathParentOf("out/vod", "out/video/1080p")).toBe(false);
		// Deeper than the muxing is refused too — a manifest below its segments
		// cannot address them either.
		expect(isPathParentOf("out/video/1080p/x", "out/video/1080p")).toBe(false);
		// Leading/trailing slashes are noise (the Akamai MSL wire form).
		expect(isPathParentOf("/out/video/", "out/video/1080p")).toBe(true);
	});

	it("takes the deepest common parent, and the root when there is none", () => {
		expect(commonPathParent(["a/b/c", "a/b/d"])).toBe("a/b");
		expect(commonPathParent(["a/b/c"])).toBe("a/b/c");
		expect(commonPathParent(["a/b", "c/d"])).toBe("");
		expect(commonPathParent([])).toBe("");
	});

	it("joins a file onto a path, root included", () => {
		expect(joinManifestPath("a/b", "vod.m3u8")).toBe("a/b/vod.m3u8");
		expect(joinManifestPath("a/b/", "vod.m3u8")).toBe("a/b/vod.m3u8");
		expect(joinManifestPath("", "vod.m3u8")).toBe("vod.m3u8");
	});
});

describe("what the step log records", () => {
	it("reads every muxing path and every live manifest FILE from the compiled ops", () => {
		const { muxingPaths, manifestFiles } = recordedLiveOutputs(LOG);
		expect(muxingPaths).toEqual([
			"output/live-rtmp-simple/video/1080p",
			"output/live-rtmp-simple/video/720p",
			"output/live-rtmp-simple/video/360p",
			"output/live-rtmp-simple/audio/128000",
		]);
		expect(manifestFiles).toEqual([
			"output/live-rtmp-simple/stream.m3u8",
			"output/live-rtmp-simple/stream.mpd",
		]);
	});

	it("falls back to the resource `name` when a manifest carries no manifestName (the SDK's own rule)", () => {
		const entries: StepLogEntry[] = [
			{
				step: "manifest:hls",
				kind: "CREATE_MANIFEST_HLS",
				payload: { outputPath: "a/b", name: "master.m3u8" },
				refs: {},
				status: "DONE",
			},
		];
		expect(recordedLiveOutputs(entries).manifestFiles).toEqual([
			"a/b/master.m3u8",
		]);
	});
});

describe("resolveLiveToVodTarget", () => {
	it("defaults to the muxings' parent — never the `<base>/vod` sibling that 2701s", () => {
		const result = resolveLiveToVodTarget(LOG);
		expect(result.ok).toBe(true);
		if (!result.ok) {
			return;
		}
		expect(result.target.path).toBe("output/live-rtmp-simple");
		for (const muxing of recordedLiveOutputs(LOG).muxingPaths) {
			expect(muxing.startsWith(`${result.target.path}/`)).toBe(true);
		}
		expect(result.target.nameFor("HLS")).toBe("vod.m3u8");
		expect(result.target.nameFor("DASH")).toBe("vod.mpd");
	});

	it("lands inside the run's own subtree for a run-scoped plan (ledger #155 isolation)", () => {
		const { entries, outputPrefix } = compileLiveRunStepLog(PLAN, {
			seq: 3,
			runId: "0badf00d-0000-4000-8000-000000000003",
		});
		const result = resolveLiveToVodTarget(entries);
		expect(result.ok).toBe(true);
		if (!result.ok) {
			return;
		}
		expect(result.target.path).toBe(outputPrefix);
		expect(outputPrefix).toBe("output/live-rtmp-simple/runs/3-0badf00d");
	});

	it("refuses an explicit path that is not a parent, naming the offender and the usable parent", () => {
		const result = resolveLiveToVodTarget(LOG, "archive/2026/vod");
		expect(result.ok).toBe(false);
		if (result.ok) {
			return;
		}
		expect(result.reason).toContain("archive/2026/vod");
		expect(result.reason).toContain("output/live-rtmp-simple/video/1080p");
		expect(result.reason).toContain("2701");
		expect(result.reason).toContain('Use "output/live-rtmp-simple"');
	});

	it("accepts an explicit ANCESTOR verbatim — the operator's spelling reaches the wire", () => {
		const result = resolveLiveToVodTarget(LOG, "output");
		expect(result.ok).toBe(true);
		if (!result.ok) {
			return;
		}
		expect(result.target.path).toBe("output");
		// A name is free at THIS path even though `stream.*` is taken one
		// level down — the collision set is per directory, not per channel.
		expect(result.target.nameFor("HLS")).toBe("vod.m3u8");
	});

	it("refuses when the step log records no muxing at all, rather than guessing a path", () => {
		const result = resolveLiveToVodTarget(
			LOG.filter((entry) => !entry.kind.startsWith("CREATE_MUXING_")),
		);
		expect(result.ok).toBe(false);
		if (result.ok) {
			return;
		}
		expect(result.reason).toContain("no muxing output path");
	});
});

describe("priorRollManifestFiles", () => {
	it("reads the urls out of persisted records and shrugs off malformed ones", () => {
		expect(
			priorRollManifestFiles([
				{
					status: "FINISHED",
					manifests: [
						{ type: "HLS", manifestId: "a", url: "out/ch/vod.m3u8" },
						{ type: "DASH", manifestId: "b", url: "/out/ch/vod.mpd" },
					],
				},
				// The column's real population is wider than the type: a bare
				// `{}` was observed in production, and a run that never rolled is
				// null. Neither may break a roll — they contribute nothing.
				{},
				null,
				{ manifests: "not an array" },
				{ manifests: [{ url: 7 }, { url: "" }, null] },
			]),
		).toEqual(["out/ch/vod.m3u8", "out/ch/vod.mpd"]);
	});

	it("reads priorManifests retained across an atomic channel+run claim", () => {
		expect(
			priorRollManifestFiles([
				{
					status: "RUNNING",
					manifests: [],
					priorManifests: [
						{
							type: "HLS",
							manifestId: "previous-hls",
							url: "out/ch/vod.m3u8",
						},
					],
				},
			]),
		).toEqual(["out/ch/vod.m3u8"]);
	});
});

describe("vodManifestFileName", () => {
	it("suffixes until free, and only against files in the SAME directory", () => {
		expect(vodManifestFileName("HLS", "a/b", [])).toBe("vod.m3u8");
		expect(vodManifestFileName("HLS", "a/b", ["a/b/vod.m3u8"])).toBe(
			"vod-2.m3u8",
		);
		expect(
			vodManifestFileName("HLS", "a/b", ["a/b/vod.m3u8", "a/b/vod-2.m3u8"]),
		).toBe("vod-3.m3u8");
		// Same NAME in another directory is not a collision.
		expect(vodManifestFileName("HLS", "a/b", ["a/c/vod.m3u8"])).toBe(
			"vod.m3u8",
		);
		// The extension keeps the two families apart on their own.
		expect(vodManifestFileName("DASH", "a/b", ["a/b/vod.m3u8"])).toBe(
			"vod.mpd",
		);
	});

	it("cannot be defeated by slash spelling", () => {
		expect(vodManifestFileName("DASH", "/a/b/", ["a/b/vod.mpd"])).toBe(
			"vod-2.mpd",
		);
	});

	/**
	 * The property first-free does NOT have. Only the latest roll per run
	 * survives in the records, so on roll 3 the set reads `{vod-2}` — roll 1's
	 * `vod.m3u8` is gone from the DB but very much still on the storage. Going
	 * one above the highest index cannot hand it back.
	 */
	it("counts past the highest index it can see, never into a gap below it", () => {
		expect(vodManifestFileName("HLS", "a/b", ["a/b/vod-2.m3u8"])).toBe(
			"vod-3.m3u8",
		);
		expect(vodManifestFileName("HLS", "a/b", ["a/b/vod-9.m3u8"])).toBe(
			"vod-10.m3u8",
		);
		// A name that merely starts the same is not one of ours.
		expect(vodManifestFileName("HLS", "a/b", ["a/b/vodcast.m3u8"])).toBe(
			"vod.m3u8",
		);
	});
});

describe("a retry never overwrites a previous roll (review-357)", () => {
	it("counts past the files earlier rolls recorded, per family", () => {
		const first = resolveLiveToVodTarget(LOG, undefined, []);
		expect(first.ok).toBe(true);
		if (!first.ok) {
			return;
		}
		const rollOne = [
			joinManifestPath(first.target.path, first.target.nameFor("HLS")),
			joinManifestPath(first.target.path, first.target.nameFor("DASH")),
		];
		expect(rollOne).toEqual([
			"output/live-rtmp-simple/vod.m3u8",
			"output/live-rtmp-simple/vod.mpd",
		]);

		const second = resolveLiveToVodTarget(LOG, undefined, rollOne);
		expect(second.ok).toBe(true);
		if (!second.ok) {
			return;
		}
		// Same PATH — the muxings did not move — a different FILE.
		expect(second.target.path).toBe(first.target.path);
		expect(second.target.nameFor("HLS")).toBe("vod-2.m3u8");
		expect(second.target.nameFor("DASH")).toBe("vod-2.mpd");

		// Roll 3 sees only roll 2 (one record per run survives) and must still
		// not reach back down to roll 1's name.
		const third = resolveLiveToVodTarget(LOG, undefined, [
			joinManifestPath(second.target.path, second.target.nameFor("HLS")),
		]);
		expect(third.ok).toBe(true);
		if (!third.ok) {
			return;
		}
		expect(third.target.nameFor("HLS")).toBe("vod-3.m3u8");
		// DASH was not rolled the second time, so its counter did not move.
		expect(third.target.nameFor("DASH")).toBe("vod.mpd");
	});

	it("applies to an explicit path too", () => {
		const result = resolveLiveToVodTarget(LOG, "output", ["output/vod.m3u8"]);
		expect(result.ok).toBe(true);
		if (!result.ok) {
			return;
		}
		expect(result.target.nameFor("HLS")).toBe("vod-2.m3u8");
	});
});

it("resolves encrypted-only segmented recordings from DRM destinations, including rebased runs", () => {
	const p = structuredClone(PLAN);
	p.drm = p.muxings.map((m) => {
		if (!m.destination) throw new Error("Missing output");
		return {
			key: `${m.key}-enc`,
			kind: "FAIRPLAY" as const,
			muxingKey: m.key,
			credentialId: "00000000-0000-4000-8000-000000000003",
			iv: "a".repeat(32),
			uri: "skd://synthetic",
			destination: m.destination,
		};
	});
	for (const m of p.muxings) delete m.destination;
	for (const m of p.liveManifests) m.drmKind = "FAIRPLAY";
	for (const run of [
		{ seq: 1, runId: "11111111-1111-4111-8111-111111111111" },
		{ seq: 2, runId: "22222222-2222-4222-8222-222222222222" },
	]) {
		const { entries, outputPrefix } = compileLiveRunStepLog(p, run);
		expect(recordedLiveOutputs(entries).muxingPaths).toHaveLength(
			p.muxings.length,
		);
		const target = resolveLiveToVodTarget(entries);
		expect(target.ok).toBe(true);
		if (target.ok)
			expect(target.target.path).toBe(
				run.seq === 1 ? "output/live-rtmp-simple" : outputPrefix,
			);
	}
});
