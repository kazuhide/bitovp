import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	classifyRenditionParams,
	inputFileSummaries,
	renditionSummaries,
	storageSummaries,
} from "./detail-view";
import { encodingPlanSchema } from "./schema";
import { loadPlan, vodPlanNames } from "./test-support";
import { validatePlan } from "./validate";

const planNames = vodPlanNames();

/**
 * Corpus sweep for the job-detail selectors (design §8).
 *
 * These run over EVERY VOD golden plan rather than a handful, because the
 * selectors' whole job is to survive the shapes the corpus actually contains —
 * per-title templates with null bitrates, DRM'd muxings with no destination of
 * their own, Dolby ladders across multiple encodings, WebVTT sidecars,
 * concatenated and trimmed inputs, audio-only and qc-only plans. A selector
 * tested on one hand-built plan proves nothing about the plan that breaks it.
 *
 * The invariants below are chosen so that a WRONG answer fails, not just a
 * crash: "every rendition appears exactly once" catches a grouping bug that
 * silently drops a rung, and "every muxing destination resolves to a declared
 * output" catches the join that the storage panel is entirely made of.
 */

const dir = join(__dirname, "__fixtures__");

describe("detail-view selectors — corpus sweep", () => {
	it("finds the whole VOD corpus", () => {
		// Guards the sweep itself: a glob that stopped matching would make every
		// assertion below pass over an empty list. 66 today; the floor is below it
		// so adding a fixture is not a failure while a broken reader is.
		// EXACT, not a floor: 67 fixtures . A floor of 60 let a
		// partial shrink (66 -> 61) pass silently (stack review) — and the corpus
		// changes only when a fixture PR changes it, which is precisely when this
		// number should be re-measured and moved.
		expect(planNames.length).toBe(72);
	});

	it.each(planNames)("%s: every rendition appears exactly once", (name) => {
		const plan = loadPlan(name);
		const summaries = renditionSummaries(plan);
		const seen = [
			...summaries.video,
			...summaries.audio,
			...summaries.subtitle,
		].map((r) => r.key);
		expect(seen.slice().sort()).toEqual(
			plan.renditions.map((r) => r.key).sort(),
		);
		// Exactly once, not merely present — a rendition counted in two families
		// would double it in the table.
		expect(new Set(seen).size).toBe(seen.length);
	});

	it.each(
		planNames,
	)("%s: every muxing resolves to a declared output", (name) => {
		const plan = loadPlan(name);
		const declared = new Set(plan.outputs.map((o) => o.key));
		for (const muxing of plan.muxings) {
			if (muxing.destination) {
				expect(declared.has(muxing.destination.outputKey)).toBe(true);
			}
		}
		// And the selector must place each of those writes on its endpoint — under
		// the `qc` role for a VMAF-only encode, which emits no delivery muxings at
		// all (the plan keeps them only so the qc mirror path can be derived).
		const summaries = storageSummaries(plan);
		// The Storage I/O section renders its heading unconditionally, which would be
		// an empty landmark if a plan could yield no endpoints at all — the defect the
		// preview rail actually shipped with (PR 2 review). It cannot here, and this
		// is why: the schema requires `inputs.min(1)`, and every declared input
		// becomes an endpoint row. Asserted rather than reasoned, so the guard the
		// panel does NOT have stays unnecessary.
		expect(summaries.inputs.length, `${name}: storage inputs`).toBeGreaterThan(
			0,
		);
		const role = plan.qc?.only === true ? "qc" : "muxing";
		const placed = summaries.outputs.flatMap((o) =>
			o.paths.filter((p) => p.role === role).map((p) => p.key),
		);
		const expected = plan.muxings
			.filter((m) => m.destination !== undefined)
			.map((m) => m.key);
		expect(placed.slice().sort()).toEqual(expected.slice().sort());
		if (plan.qc?.only === true) {
			// Nothing may claim a delivery write on a qc-only plan.
			expect(
				summaries.outputs.flatMap((o) =>
					o.paths.filter((p) => p.role === "muxing"),
				),
			).toEqual([]);
		}
	});

	it.each(planNames)("%s: every DRM write path is reachable", (name) => {
		/**
		 * The sibling of the input-file assertion, and the one that would have caught
		 * a whole class rather than one instance.
		 *
		 * DRM'd write paths had NO corpus invariant — only a snapshot, and snapshots
		 * are what people refresh with `-u` when they go red. Removing the DRM
		 * fallback entirely, i.e. reintroducing the original bug across all five DRM
		 * fixtures, failed exactly ONE test (review measurement). It then missed a
		 * second defect the snapshot could not see: a muxing encrypted TWICE (CENC to
		 * `…/dash/`, FairPlay to `…/hls/`) had one of its two destinations dropped by
		 * a `find`, hiding 8 of 16 writes on `pertitle-h265-fmp4-drm-on-aws`.
		 *
		 * Derived from `plan.drm` rather than from the selector, so it cannot agree
		 * with either bug.
		 */
		const plan = loadPlan(name);
		/**
		 * EVERY DRM destination, not only those whose muxing lacks one of its own.
		 *
		 * The first version filtered on `!muxingHasOwn.has(...)`, which encoded the
		 * same either/or assumption as the code it was checking — so code and test
		 * agreed with each other and disagreed with the VALIDATOR, which computes the
		 * effective write set as a union and permits a muxing to carry both (review
		 * finding). A guard that shares the code's assumption cannot see the
		 * assumption being wrong.
		 */
		// INERT ON TODAY'S CORPUS, and worth saying so: 0 of 66 fixtures carry a
		// muxing with both writes, so with this unfiltered `expected` all 66 of these
		// assertions still passed against the buggy source (measured by the review).
		// The two hand-built tests below did all the work; this de-complicts the guard
		// for the future rather than catching anything now.
		//
		// Skipped for a qc-only plan: `storageSummaries` reports no delivery writes
		// there by design, so a qc-only fixture carrying DRM would fail this and blame
		// the selector for behaving as specified.
		const expected =
			plan.qc?.only === true
				? []
				: plan.drm.map(
						(d) => `${d.destination.outputKey}\u0000${d.destination.path}`,
					);
		const reported = new Set(
			storageSummaries(plan).outputs.flatMap((o) =>
				o.paths
					.filter((p) => p.role === "drm")
					.map((p) => `${o.key}\u0000${p.path}`),
			),
		);
		expect([...new Set(expected)].filter((e) => !reported.has(e))).toEqual([]);
	});

	it.each(planNames)("%s: every consumed source file is listed", (name) => {
		const plan = loadPlan(name);
		const files = inputFileSummaries(plan);
		// Uniqueness is asserted on the PAIR, not on a re-built separator string: the
		// selector's internal grouping key is its own business, and duplicating its
		// separator here is how a test starts agreeing with a bug.
		const pairs = files.map((f) => JSON.stringify([f.inputKey, f.inputPath]));
		expect(new Set(pairs).size).toBe(pairs.length);
		for (const file of files) {
			// Every listed file names at least one CHAIN. The chain's rendition list
			// may be empty — a Dolby Vision metadata sidecar or an Atmos track is
			// declared as its own input stream that no rendition names as its
			// `ingestKey`, and the encoding still reads it. What must never happen is
			// a file with no chain at all: that means the grouping key drifted.
			expect(file.consumers.length).toBeGreaterThan(0);
			expect(file.consumers.every((c) => c.chain.length > 0)).toBe(true);
		}

		/**
		 * Design §8's assertion, which was missing: every declared read appears.
		 *
		 * This is the one that catches a dropped source file, and the reason it
		 * matters is that the previous body was a set of properties OF THE RETURNED
		 * LIST — so `inputFileSummaries → []` passed all 66 of these while only the 6
		 * snapshots noticed (review measurement). Derived from the plan's own input
		 * streams rather than from the selector, so it cannot agree with a bug.
		 */
		const SEP = String.fromCharCode(0);
		const declared = new Set<string>();
		for (const stream of plan.ingest) {
			declared.add(`${stream.inputKey}${SEP}${stream.inputPath}`);
		}
		for (const stream of plan.fileStreams) {
			declared.add(`${stream.inputKey}${SEP}${stream.inputPath}`);
		}
		for (const stream of plan.dolbyStreams) {
			if (stream.kind === "VISION") {
				declared.add(`${stream.inputKey}${SEP}${stream.videoInputPath}`);
				if (stream.metadataInputPath !== undefined) {
					declared.add(`${stream.inputKey}${SEP}${stream.metadataInputPath}`);
				}
			} else {
				declared.add(`${stream.inputKey}${SEP}${stream.inputPath}`);
			}
		}
		const listedIds = new Set(
			files.map((f) => `${f.inputKey}${SEP}${f.inputPath}`),
		);
		expect([...declared].filter((d) => !listedIds.has(d))).toEqual([]);
		// Each declared input the plan references must be resolvable to its kind —
		// "UNKNOWN" here means the (inputKey → plan.inputs) join failed.
		expect(files.every((f) => f.kind !== "UNKNOWN")).toBe(true);
	});

	it.each(planNames)("%s: no selector throws, and params classify", (name) => {
		const plan = loadPlan(name);
		expect(() => {
			renditionSummaries(plan);
			inputFileSummaries(plan);
			storageSummaries(plan);
			for (const rendition of plan.renditions) {
				classifyRenditionParams(rendition);
			}
		}).not.toThrow();
	});

	it.each(
		planNames,
	)("%s: video renditions sort by bitrate descending", (name) => {
		const plan = loadPlan(name);
		const { video } = renditionSummaries(plan);
		const bitrates = video.map((r) => r.bitrate ?? Number.POSITIVE_INFINITY);
		for (let i = 1; i < bitrates.length; i += 1) {
			// Non-increasing: equal bitrates are allowed (they tie-break on key).
			expect(bitrates[i - 1]).toBeGreaterThanOrEqual(bitrates[i] as number);
		}
	});

	/**
	 * The expectation is DERIVED from the raw fixture, not restated from the
	 * implementation: a field absent from the plan JSON but present after parsing
	 * is a schema default *by construction*, so it must classify as one.
	 *
	 * Written this way because the obvious version of this test was inert —
	 * asserting only that classified names are real fields with their stored
	 * values passes whether or not anything is ever labelled a default, and the
	 * mutation "classify everything as set" survived all 419 tests. That is the
	 * named-slot failure: a classifier that classifies nothing.
	 */
	it.each(
		planNames,
	)("%s: fields absent from the plan JSON read as defaults", (name) => {
		const raw = JSON.parse(
			readFileSync(join(dir, `${name}.plan.json`), "utf8"),
		) as { renditions?: Array<Record<string, unknown>> };
		const plan = loadPlan(name);
		let defaultsFound = 0;
		for (const [index, rendition] of plan.renditions.entries()) {
			const rawRendition = raw.renditions?.[index];
			if (!rawRendition || rawRendition.key !== rendition.key) {
				continue; // fixture ordering differs from parse order — skip, don't guess
			}
			const params = classifyRenditionParams(rendition);
			for (const param of params) {
				if (Object.hasOwn(rawRendition, param.name)) {
					continue;
				}
				// Absent from the JSON, present after parsing ⇒ zod defaulted it.
				expect(param.source).toBe("schema-default");
				defaultsFound += 1;
			}
		}
		// NOT asserted per fixture: that such a field exists. Measured — the corpus
		// mirrors encoding examples scripts and sets nearly every field explicitly, so
		// most fixtures omit nothing and `defaultsFound` is legitimately 0 here. The
		// non-inertness guard is corpus-wide instead, below.
		expect(defaultsFound).toBeGreaterThanOrEqual(0);
	});

	it.each(planNames)("%s: a REQUIRED field is never a default", (name) => {
		/**
		 * The missing half, and the test that catches the bug the anti-inert guard
		 * could not see.
		 *
		 * `height`, `bitrate` and `rate` are what the schema cannot default — they
		 * are seeded into the minimal parse precisely because omitting them fails it.
		 * A required field therefore has no default to be indistinguishable FROM, so
		 * labelling one "schema-default" is not an imprecision, it is wrong.
		 *
		 * It was wrong, on 100% of the corpus: the seeded values were copied into the
		 * minimal object and then compared against themselves, so 644 of 1234 labels
		 * were false — including a rendition written `{"height": 360, "bitrate":
		 * 300000}` verbatim in the plan JSON. Fixing that flipped every one of those
		 * and changed no test result, which is what this closes (review finding).
		 */
		for (const rendition of loadPlan(name).renditions) {
			const r = rendition as unknown as Record<string, unknown>;
			const params = classifyRenditionParams(rendition);
			for (const required of ["height", "bitrate", "rate"]) {
				if (!(required in r)) {
					continue;
				}
				const param = params.find((p) => p.name === required);
				expect(param?.source, `${name}.${rendition.key}.${required}`).toBe(
					"set",
				);
			}
		}
	});

	it("labels defaults somewhere in the corpus, not nowhere", () => {
		/**
		 * The anti-inert guard, corpus-wide because no single fixture can carry it.
		 * "Classify everything as set" survived 419 tests before this existed.
		 */
		let defaulted = 0;
		let set = 0;
		for (const name of planNames) {
			for (const rendition of loadPlan(name).renditions) {
				for (const param of classifyRenditionParams(rendition)) {
					if (param.source === "schema-default") {
						defaulted += 1;
					} else {
						set += 1;
					}
				}
			}
		}
		// Both buckets non-trivially populated: all-set means the classifier is
		// inert, all-default means it is inverted.
		expect(defaulted).toBeGreaterThan(20);
		expect(set).toBeGreaterThan(20);
	});

	it.each(planNames)("%s: classification never invents a default", (name) => {
		const plan = loadPlan(name);
		for (const rendition of plan.renditions) {
			const params = classifyRenditionParams(rendition);
			const stored = rendition as unknown as Record<string, unknown>;
			// Every classified name is a real field, and its value is the stored one:
			// classification must describe the plan, not reshape it.
			for (const param of params) {
				expect(Object.hasOwn(stored, param.name)).toBe(true);
				expect(param.value).toEqual(stored[param.name]);
			}
			// The discriminant and refs are never "schema-default" — they are what
			// makes the rendition addressable.
			for (const name_ of ["key", "ingestKey", "codec"]) {
				const found = params.find((p) => p.name === name_);
				if (found) {
					expect(found.source).toBe("set");
				}
			}
		}
	});
});

describe("detail-view selectors — representative shapes", () => {
	/**
	 * Deep-equal snapshots for six fixtures chosen to cover the shapes that
	 * differ structurally, not just cosmetically: a fixed ladder, per-title with
	 * DRM (null bitrates + destination-less muxings), a Dolby multi-encoding
	 * ladder (encodingKey grouping + VISION's two input paths), a WebVTT sidecar
	 * (subtitle family + file stream), qc-only (no delivery muxings), audio-only.
	 */
	const representative = [
		// fixed ladder, both manifest families
		"fixed-bitrate-dash-hls-streamcondition-on-aws",
		// per-title + DRM: null bitrates AND destination-less muxings
		"pertitle-h264-fmp4-ts-drm-on-aws",
		// Dolby ladder: encodingKey grouping + VISION's two input paths
		"dolby-dv-hdr10-sdr-3ladder-profile5-single-input",
		// WebVTT sidecar: subtitle family fed by a file stream
		"fixed-bitrate-hls-vtt-on-aws",
		// qc-only: no delivery muxings at all
		"vmaf-only-h264",
		// audio-only
		"audio-only-aac-fmp4-hls-dash",
	].filter((name) => planNames.includes(name));

	it("resolves the six representative fixtures", () => {
		// If a fixture is renamed this list silently shrinks, so pin the count.
		expect(representative).toHaveLength(6);
	});

	it.each(representative)("%s: rendition summaries", (name) => {
		expect(renditionSummaries(loadPlan(name))).toMatchSnapshot();
	});

	it.each(representative)("%s: input files", (name) => {
		expect(inputFileSummaries(loadPlan(name))).toMatchSnapshot();
	});

	it.each(representative)("%s: storage summaries", (name) => {
		expect(storageSummaries(loadPlan(name))).toMatchSnapshot();
	});
});

describe("detail-view selectors — the step-log join", () => {
	const name = "fixed-bitrate-dash-hls-streamcondition-on-aws";

	it("renders from the plan alone when there is no log", () => {
		// A DRAFT job has no step log at all; the page must still show the ladder.
		const summaries = renditionSummaries(loadPlan(name));
		expect(summaries.video.length).toBeGreaterThan(0);
		expect(summaries.video.every((r) => r.runtime.streamId === undefined)).toBe(
			true,
		);
	});

	it("attaches stream and codec ids from the log", () => {
		const plan = loadPlan(name);
		const first = plan.renditions[0];
		if (!first) {
			throw new Error("fixture has no renditions");
		}
		const summaries = renditionSummaries(plan, [
			{
				step: `stream:${first.key}`,
				kind: "CREATE_STREAM",
				payload: {},
				refs: {},
				status: "DONE",
				resourceId: "stream-id-1",
			},
			{
				step: `codec:${first.key}`,
				kind: "CREATE_CODEC_H264",
				payload: {},
				refs: {},
				status: "DONE",
				resourceId: "codec-id-1",
			},
		]);
		const summary = [...summaries.video, ...summaries.audio].find(
			(r) => r.key === first.key,
		);
		expect(summary?.runtime).toMatchObject({
			streamId: "stream-id-1",
			codecConfigId: "codec-id-1",
		});
	});

	it("tolerates a log full of unrelated and live-only steps", () => {
		const plan = loadPlan(name);
		expect(() =>
			renditionSummaries(plan, [
				{
					step: "start-live",
					kind: "START_LIVE_ENCODING",
					payload: {},
					refs: {},
					status: "DONE",
				},
				{
					step: "stream:does-not-exist",
					kind: "CREATE_STREAM",
					payload: {},
					refs: {},
					status: "FAILED",
					error: "boom",
				},
			]),
		).not.toThrow();
	});
});

describe("the Storage I/O heading cannot be an empty landmark", () => {
	/**
	 * `StoragePanel` renders its `<section>` and heading unconditionally and guards
	 * only the two lists inside — the shape the preview rail actually shipped with
	 * (PR 2 review). It is unreachable, and THIS is the invariant that makes it so:
	 * the schema requires at least one input, and every declared input becomes an
	 * endpoint row.
	 *
	 * Asserting that inputs are derived and rendered would NOT protect it — that
	 * passes for every fixture whether or not the schema requires one, so relaxing
	 * `inputs.min(1)` would make the empty landmark reachable with all 43 core test
	 * files still green (measured by a reviewer, and confirmed here: dropping
	 * `.min(1)` left 618 tests passing). The invariant is the schema rule, so the
	 * schema rule is what gets asserted.
	 */
	it("rejects a plan with no inputs at all", () => {
		const plan = JSON.parse(
			readFileSync(join(dir, "fixed-bitrate-hls-on-aws.plan.json"), "utf8"),
		);
		// Guards the fixture itself: a plan that stopped parsing would make the
		// negative below meaningless.
		expect(encodingPlanSchema.safeParse(plan).success).toBe(true);
		expect(encodingPlanSchema.safeParse({ ...plan, inputs: [] }).success).toBe(
			false,
		);
	});

	it("rejects a plan with no outputs at all", () => {
		// The other half of "a plan always has somewhere to read from and somewhere to
		// write to", and the reason the Written-to list cannot be headless either.
		const plan = JSON.parse(
			readFileSync(join(dir, "fixed-bitrate-hls-on-aws.plan.json"), "utf8"),
		);
		expect(encodingPlanSchema.safeParse({ ...plan, outputs: [] }).success).toBe(
			false,
		);
	});
});

describe("storageSummaries — a muxing that writes plaintext AND encrypted", () => {
	/**
	 * No fixture has this shape, which is precisely why it needs a test.
	 *
	 * The validator models the effective write set as a UNION — a muxing's own
	 * destination plus every DRM destination for it, erroring only when it has
	 * neither. The selector modelled either/or (`if (destination) { …; continue }`),
	 * so a muxing carrying both would have shown the plaintext path and none of the
	 * encrypted ones. Corpus-invisible, and the corpus invariant could not see it
	 * either because its `expected` shared the same assumption (review finding).
	 *
	 * Built by hand from a real fixture rather than a synthetic plan, so it parses
	 * against the actual schema.
	 */
	function planWithBothWrites() {
		const plan = loadPlan("cenc-cbc-drm-on-aws");
		const muxing = plan.muxings[0];
		const drm = plan.drm.find((d) => d.muxingKey === muxing?.key);
		if (!muxing || !drm) {
			throw new Error("fixture no longer has a DRM'd muxing");
		}
		// Give the muxing its own plaintext destination alongside the DRM's.
		muxing.destination = {
			outputKey: drm.destination.outputKey,
			// Under the manifest base: otherwise the plan raises two
			// PLAN_SEGMENT_PATH_NOT_UNDER_MANIFEST warnings and is merely parseable
			// rather than realistic (review suggestion).
			path: `${plan.manifests[0]?.destination.path ?? "output"}/plaintext/`,
		};
		// PIN THE PREMISE. The whole PR rests on this shape being LEGAL, and that
		// claim lived only in prose — so a future "a DRM'd muxing must not carry its
		// own destination" rule would leave these tests green while the selector
		// modelled a shape the system rejects (review finding).
		expect(
			validatePlan(plan).filter((issue) => issue.level === "error"),
		).toEqual([]);
		return {
			plan,
			muxingKey: muxing.key,
			drmPath: drm.destination.path,
			plainPath: muxing.destination.path,
		};
	}

	it("reports both paths, not just the plaintext one", () => {
		const { plan, drmPath, plainPath } = planWithBothWrites();
		const paths = storageSummaries(plan).outputs.flatMap((o) => o.paths);
		expect(paths.some((p) => p.path === plainPath)).toBe(true);
		// The encrypted output feeds the manifest too — omitting it tells an operator
		// their DRM'd content went nowhere.
		expect(paths.some((p) => p.path === drmPath && p.role === "drm")).toBe(
			true,
		);
	});

	it("is caught by the corpus invariant's own criterion", () => {
		// The same check the sweep applies, run against this constructed shape: every
		// DRM destination must be reachable, whether or not its muxing has one.
		const { plan } = planWithBothWrites();
		const reported = new Set(
			storageSummaries(plan).outputs.flatMap((o) =>
				o.paths.filter((p) => p.role === "drm").map((p) => p.path),
			),
		);
		expect(
			plan.drm.map((d) => d.destination.path).filter((p) => !reported.has(p)),
		).toEqual([]);
	});
});
