import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { collectDestinationPaths } from "../plan/destinations";
import { initStepLog } from "../plan/steplog";
import { compileLiveChannel } from "./compiler";
import {
	compileLiveRunStepLog,
	effectiveLivePlanForRun,
	hasMsl5Marker,
	liveRunSegment,
	rebaseLivePlanForRun,
} from "./run-rebase";
import { type LiveChannelPlan, liveChannelPlanSchema } from "./schema";

const dir = join(__dirname, "__fixtures__");

function loadPlan(name: string): LiveChannelPlan {
	return liveChannelPlanSchema.parse(
		JSON.parse(readFileSync(join(dir, `${name}.plan.json`), "utf8")),
	);
}

/** Every live fixture, derived from the tree — not a hand-kept list. */
const ALL_FIXTURES = readdirSync(dir)
	.filter((f) => f.endsWith(".plan.json"))
	.map((f) => f.replace(/\.plan\.json$/, ""));

const RUN = { seq: 2, runId: "ab12cd34-5678-90ef-1234-567890abcdef" };

describe("liveRunSegment", () => {
	it("is runs/<seq>-<first 8 id chars>", () => {
		expect(liveRunSegment(2, RUN.runId)).toBe("runs/2-ab12cd34");
		expect(liveRunSegment(11, "ffffffff-0000-0000-0000-000000000000")).toBe(
			"runs/11-ffffffff",
		);
	});
});

describe("rebaseLivePlanForRun (ledger #155, design §4)", () => {
	it("inserts the run subtree after the plan's common base — the design's exact layout", () => {
		const plan = loadPlan("live-esam-full");
		const { plan: rebased, outputPrefix } = rebaseLivePlanForRun(plan, RUN);
		expect(outputPrefix).toBe("output/live-esam-full/runs/2-ab12cd34");
		// A muxing keeps its rendition tail under the run subtree…
		expect(rebased.muxings[0]?.destination?.path).toBe(
			"output/live-esam-full/runs/2-ab12cd34/video/1080p",
		);
		// …and a manifest whose path WAS the base lands exactly at the prefix.
		expect(rebased.liveManifests[0]?.destination?.path).toBe(
			"output/live-esam-full/runs/2-ab12cd34",
		);
	});

	it("preserves every path's tail relative to the base — manifests still find their segments", () => {
		const plan = loadPlan("live-esam-full");
		const before = collectDestinationPaths(plan);
		const { plan: rebased, outputPrefix } = rebaseLivePlanForRun(plan, RUN);
		const after = collectDestinationPaths(rebased);
		expect(after).toHaveLength(before.length);
		const baseLen = "output/live-esam-full".split("/").length;
		const prefixLen = outputPrefix.split("/").length;
		for (const [i, path] of after.entries()) {
			expect(path.split("/").slice(prefixLen)).toEqual(
				(before[i] as string)
					.split("/")
					.filter((s) => s !== "")
					.slice(baseLen),
			);
		}
	});

	/**
	 * The manifests an Akamai MSL output publishes — the ONE population the
	 * rebase leaves where the plan put it (WP-C6, measured 2026-09-02). Derived
	 * from the plan, never hand-listed, so a new MSL fixture is covered.
	 */
	function mslManifestPaths(plan: LiveChannelPlan): string[] {
		const msl = new Set(
			plan.outputs.filter((o) => o.kind === "AKAMAI_MSL").map((o) => o.key),
		);
		return plan.liveManifests
			.filter((m) => msl.has(m.destination.outputKey))
			.map((m) => m.destination.path);
	}

	it("INVARIANT over every fixture: each MOVED destination path starts with outputPrefix, and MSL manifests do not move", () => {
		expect(ALL_FIXTURES.length).toBeGreaterThanOrEqual(9);
		let mslFixtures = 0;
		for (const name of ALL_FIXTURES) {
			const plan = loadPlan(name);
			const pinned = mslManifestPaths(plan);
			const { plan: rebased, outputPrefix } = rebaseLivePlanForRun(plan, RUN);
			const paths = collectDestinationPaths(rebased);
			expect(paths.length).toBeGreaterThan(0);
			// Every muxing moves — a muxing is what the run writes.
			for (const muxing of rebased.muxings) {
				const path = muxing.destination?.path ?? "";
				expect(
					path === outputPrefix || path.startsWith(`${outputPrefix}/`),
					`${name}: muxing ${muxing.key} at ${path} does not start with ${outputPrefix}`,
				).toBe(true);
			}
			// An MSL-published manifest keeps the plan's path; every other
			// manifest moves with its segments.
			const msl = new Set(
				plan.outputs.filter((o) => o.kind === "AKAMAI_MSL").map((o) => o.key),
			);
			for (const [i, manifest] of rebased.liveManifests.entries()) {
				const path = manifest.destination.path;
				if (msl.has(manifest.destination.outputKey)) {
					expect(path, `${name}: MSL manifest ${manifest.key} moved`).toBe(
						plan.liveManifests[i]?.destination.path,
					);
				} else {
					expect(
						path === outputPrefix || path.startsWith(`${outputPrefix}/`),
						`${name}: manifest ${manifest.key} at ${path} does not start with ${outputPrefix}`,
					).toBe(true);
				}
			}
			if (pinned.length > 0) {
				mslFixtures += 1;
			}
		}
		// The MSL arm above must have judged something — a fixture set with no
		// MSL-published manifest would make it vacuous.
		expect(mslFixtures).toBeGreaterThanOrEqual(3);
	});

	/**
	 * THE MEASURED SHAPE (channel 0645c2f1, 2026-09-02, measurement doc Part
	 * 9): an MSL primary with its manifests at the event root. The old rule
	 * moved the root manifest to `/runs/3-…/`; Bitmovin wrote the playlist's
	 * segment URIs relative to that path and Akamai published the playlist at
	 * the root anyway, so the URIs named run 1's objects.
	 */
	describe("an Akamai MSL manifest stays at the event root (WP-C6)", () => {
		it("keeps the root manifest at '' and puts the run subtree UNDER the channel folder", () => {
			const plan = loadPlan("live-akamai-msl-ts");
			const { plan: rebased, outputPrefix } = rebaseLivePlanForRun(plan, RUN);
			expect(outputPrefix).toBe("output/live-akamai-msl-ts/runs/2-ab12cd34");
			for (const m of rebased.liveManifests) {
				expect(m.destination.path).toBe("");
			}
			expect(rebased.muxings[0]?.destination?.path).toBe(
				"output/live-akamai-msl-ts/runs/2-ab12cd34/video/1080p",
			);
		});

		it("the playlist's RELATIVE segment path now carries the run subtree — what the edge resolves", () => {
			// The compiled HLS op strips the muxing path against the manifest's
			// (`relativeSegmentPath`): with the manifest pinned at "" the
			// relative path is the full muxing path, run subtree included. The
			// old rule produced `output/live-akamai-msl-ts/video/1080p` for
			// EVERY run — byte-identical, which is the defect.
			const plan = loadPlan("live-akamai-msl-ts");
			const ops = compileLiveChannel(rebaseLivePlanForRun(plan, RUN).plan);
			const HLS_ENTRY_KINDS = new Set([
				"CREATE_HLS_STREAM_INFO",
				"CREATE_HLS_AUDIO_MEDIA",
			]);
			const hls = ops.find((op) => op.kind === "CREATE_MANIFEST_HLS");
			const entries = ops.filter((op) => HLS_ENTRY_KINDS.has(op.kind));
			expect(hls?.payload.outputPath).toBe("");
			expect(entries.length).toBeGreaterThan(0);
			for (const entry of entries) {
				expect(String(entry.payload.segmentPath)).toMatch(
					/^output\/live-akamai-msl-ts\/runs\/2-ab12cd34\/(video|audio)\//,
				);
			}
			// And two runs of the same channel never share a segment path.
			const other = compileLiveChannel(
				rebaseLivePlanForRun(plan, {
					seq: 3,
					runId: "80a8c26b-6e4d-4ecc-ab22-b1994ac42138",
				}).plan,
			);
			const pathsOf = (list: typeof ops) =>
				list
					.filter((op) => HLS_ENTRY_KINDS.has(op.kind))
					.map((op) => String(op.payload.segmentPath));
			const first = new Set(pathsOf(ops));
			for (const path of pathsOf(other)) {
				expect(first.has(path), `${path} shared between runs`).toBe(false);
				expect(path).toMatch(/\/runs\/3-80a8c26b\//);
			}
		});

		it("a CMAF MSL fixture pins BOTH root manifests and moves the muxings", () => {
			const plan = loadPlan("live-akamai-msl");
			const { plan: rebased, outputPrefix } = rebaseLivePlanForRun(plan, RUN);
			expect(outputPrefix).toBe("output/live-akamai-msl/runs/2-ab12cd34");
			expect(rebased.liveManifests.map((m) => m.destination.path)).toEqual([
				"",
				"",
			]);
			for (const m of rebased.muxings) {
				expect(m.destination?.path.startsWith(`${outputPrefix}/`)).toBe(true);
			}
		});

		it("a storage primary with an MSL MIRROR is unchanged — its manifests are bound to storage", () => {
			// The pin is by the manifest's OWN destination. The mirror topology
			// keeps the whole-subtree behaviour it had (the storage half of it is
			// what #155 measured); whether the mirror can play at all with a
			// non-root manifest is a separate, open question (WP-C6 report).
			const plan = loadPlan("live-akamai-msl-storage");
			const { plan: rebased, outputPrefix } = rebaseLivePlanForRun(plan, RUN);
			expect(outputPrefix).toBe(
				"output/live-akamai-msl-storage/runs/2-ab12cd34",
			);
			for (const m of rebased.liveManifests) {
				expect(m.destination.path).toBe(outputPrefix);
			}
		});

		it("effectiveLivePlanForRun recomputes the pinned layout and identity-checks it", () => {
			const plan = loadPlan("live-akamai-msl-ts");
			const effective = effectiveLivePlanForRun(plan, {
				seq: RUN.seq,
				id: RUN.runId,
				outputPrefix: "output/live-akamai-msl-ts/runs/2-ab12cd34",
			});
			expect(effective?.liveManifests[0]?.destination.path).toBe("");
			expect(effective?.muxings[0]?.destination?.path).toBe(
				"output/live-akamai-msl-ts/runs/2-ab12cd34/video/1080p",
			);
			// A run started by the OLD derivation (prefix `runs/<seq>-<id>`,
			// manifest moved) no longer matches — null, never guessed paths.
			expect(
				effectiveLivePlanForRun(plan, {
					seq: RUN.seq,
					id: RUN.runId,
					outputPrefix: "runs/2-ab12cd34",
				}),
			).toBeNull();
		});
	});

	it("degrades to a plain prepend when the paths share no base", () => {
		const plan = loadPlan("live-esam-full");
		// Force disjoint roots: move the first muxing to another top segment.
		const first = plan.muxings[0] as (typeof plan.muxings)[number];
		const disjoint = liveChannelPlanSchema.parse({
			...plan,
			muxings: [
				{
					...first,
					destination: { ...first.destination, path: "elsewhere/video" },
				},
				...plan.muxings.slice(1),
			],
		});
		const { plan: rebased, outputPrefix } = rebaseLivePlanForRun(disjoint, RUN);
		expect(outputPrefix).toBe("runs/2-ab12cd34");
		expect(rebased.muxings[0]?.destination?.path).toBe(
			"runs/2-ab12cd34/elsewhere/video",
		);
		expect(rebased.muxings[1]?.destination?.path).toBe(
			"runs/2-ab12cd34/output/live-esam-full/video/720p",
		);
	});
});

describe("compileLiveRunStepLog — the seq rule, one brain for every fresh-compile site", () => {
	it("seq 1 compiles the plan AS-IS with prefix '' (the create route's own construction)", () => {
		const plan = loadPlan("live-rtmp-simple");
		const { entries, outputPrefix } = compileLiveRunStepLog(plan, {
			seq: 1,
			runId: RUN.runId,
		});
		expect(outputPrefix).toBe("");
		expect(entries).toEqual(initStepLog(compileLiveChannel(plan)));
	});

	it("seq ≥ 2 compiles the REBASED plan — the ops carry the run's paths, not the plan's", () => {
		const plan = loadPlan("live-esam-full");
		const { entries, outputPrefix } = compileLiveRunStepLog(plan, RUN);
		expect(outputPrefix).toBe("output/live-esam-full/runs/2-ab12cd34");
		expect(entries).toEqual(
			initStepLog(compileLiveChannel(rebaseLivePlanForRun(plan, RUN).plan)),
		);
		const wire = JSON.stringify(entries);
		expect(wire).toContain("output/live-esam-full/runs/2-ab12cd34/video/1080p");
		// The ORIGINAL segment path must be gone — its presence is exactly the
		// overwrite-the-previous-run defect this module exists to prevent.
		expect(wire).not.toContain('"output/live-esam-full/video/1080p"');
	});
});

describe("effectiveLivePlanForRun — what a run actually wrote", () => {
	const plan = loadPlan("live-esam-full");

	it("prefix '' means the plan's own paths (seq 1, or a pre-#155 run)", () => {
		expect(
			effectiveLivePlanForRun(plan, {
				seq: 1,
				id: RUN.runId,
				outputPrefix: "",
			}),
		).toEqual(plan);
	});

	it("a stored prefix that matches the recomputation yields the rebased plan", () => {
		expect(
			effectiveLivePlanForRun(plan, {
				seq: 2,
				id: RUN.runId,
				outputPrefix: "output/live-esam-full/runs/2-ab12cd34",
			}),
		).toEqual(rebaseLivePlanForRun(plan, RUN).plan);
	});

	it("a MISMATCHED stored prefix yields null — refuse to guess, never serve wrong paths", () => {
		expect(
			effectiveLivePlanForRun(plan, {
				seq: 2,
				id: RUN.runId,
				outputPrefix: "output/live-esam-full/runs/2-differ00",
			}),
		).toBeNull();
	});

	it("an unparsable plan yields null", () => {
		expect(
			effectiveLivePlanForRun(42, {
				seq: 2,
				id: RUN.runId,
				outputPrefix: "x",
			}),
		).toBeNull();
	});
});

describe("the MSL5 marker predicate (ledger #162 — it outlived the gate it was written for)", () => {
	// Track 2a's experimental gate lived at this choke point and was RETIRED at
	// GA. What the gate proved — that every re-air/revive path funnels through
	// ONE choke rather than three caller checks — is still proved here, by the
	// compiler refusal that shares the choke. Nothing is left
	// unpinned by the removal.
	//
	// The predicate survives the gate because PR 1's rails ask the same
	// question for the opposite reason: a gate asked "is this what we refuse",
	// a rail asks "is this what the extra requirements apply to" (publishing
	// auth is MSL5-only; MSL5 is live-only). This arm holds it to the
	// STRUCTURAL read, which is the part a typed refactor would quietly break —
	// callers hold plans at different stages of parsing, a raw persisted
	// `Job.plan` among them.
	function msl5Marked(): LiveChannelPlan {
		const plan = structuredClone(
			loadPlan("live-akamai-msl"),
		) as LiveChannelPlan;
		const output = plan.outputs.find((o) => o.kind === "AKAMAI_MSL");
		if (!output) {
			throw new Error("fixture lost its MSL output");
		}
		(output as { mslVersion?: string }).mslVersion = "MSL5";
		return plan;
	}

	it("reads MSL5 off an output the schema cannot yet parse", () => {
		expect(hasMsl5Marker(msl5Marked())).toBe(true);
		// The fixture ships MSL4, so the predicate discriminates rather than
		// answering true for every AKAMAI_MSL output.
		expect(hasMsl5Marker(loadPlan("live-akamai-msl"))).toBe(false);
	});

	/**
	 * WHICH lock holds the door, and this arm has now caught two things.
	 *
	 * FIRST, in PR 0.5: I wrote it asserting both arms compile "now that
	 * nothing refuses it", because the experimental gate was gone. The re-air
	 * arm failed — `seq >= 2` goes through `rebaseLivePlanForRun`, which
	 * RE-PARSES, and `AKAMAI_MSL_VERSIONS` was still `["MSL4"]`, so zod refused
	 * at `outputs.0.mslVersion` while the first-run arm (no re-parse) compiled.
	 * The gate's own docblock had said the schema was the outer lock; what it
	 * had not said, and what I assumed, is that the two locks cover the same
	 * doors. They did not.
	 *
	 * SECOND, in PR 1, which is this commit: the asymmetry is GONE, and this
	 * arm is what said so. Widening the enum made the re-air compile, so the
	 * `toThrow` half went red — and its own note asked for exactly that: "PR 1
	 * widens the enum, at which point the second expectation flips to a
	 * successful compile. It should be UPDATED there, deliberately — a failure
	 * here in PR 1 is this test doing its job, not drift."
	 *
	 * So it is updated deliberately, and the arm keeps its job by inverting:
	 * both paths must now compile. If a future change re-introduces a refusal
	 * on either path — a reinstated gate, a narrowed enum, a rail moved into
	 * the compiler — this goes red and names which path.
	 */
	it("BOTH paths compile now that the enum carries MSL5 — the asymmetry is closed", () => {
		for (const seq of [1, 2]) {
			const { entries } = compileLiveRunStepLog(msl5Marked(), {
				seq,
				runId: `run-${seq}`,
			});
			expect(entries.length, `seq ${seq} produced no step log`).toBeGreaterThan(
				3,
			);
		}
	});
});
