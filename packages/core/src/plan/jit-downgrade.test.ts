import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compilePlan } from "./compiler";
import {
	downgradeJitManifests,
	JIT_START_REF_KEYS,
	ridesJitManifests,
} from "./jit-downgrade";
import { encodingPlanSchema } from "./schema";
import { initStepLog } from "./steplog";
import { validatePlan } from "./validate";

/**
 * : the JIT→POST_ENCODING downgrade, driven by the WHOLE fixture
 * corpus rather than one hand-built plan — the failure it recovers from hit
 * every JIT plan the account submitted that day, so the population is "every
 * JIT fixture", derived from disk, never a list typed here.
 */
const dir = join(__dirname, "__fixtures__");
const fixtures = readdirSync(dir)
	.filter((f) => f.endsWith(".plan.json"))
	.map((f) => ({
		name: f.replace(".plan.json", ""),
		plan: encodingPlanSchema.parse(
			JSON.parse(readFileSync(join(dir, f), "utf8")),
		),
	}));
const jitFixtures = fixtures.filter(
	(f) =>
		f.plan.generation.timing === "JUST_IN_TIME" &&
		compilePlan(f.plan).some(ridesJitManifests),
);

describe("JIT downgrade — the population", () => {
	it("finds a real JIT-start population in the corpus (the tests below are non-vacuous)", () => {
		expect(fixtures.length).toBeGreaterThan(60);
		expect(jitFixtures.length).toBeGreaterThan(20);
	});

	it.each(
		jitFixtures.map((f) => [f.name, f] as const),
	)("%s downgrades: start loses its manifest lists, manifest start/await appear", (_name, fixture) => {
		const steps = initStepLog(compilePlan(fixture.plan)).map((e) => e.step);
		const result = downgradeJitManifests(fixture.plan, steps);
		if (!result.ok) {
			throw new Error(
				`a JIT fixture must be downgradable (refused: ${result.reason})`,
			);
		}
		expect(result.plan.generation.timing).toBe("POST_ENCODING");
		/**
		 * The downgraded plan is PERSISTED, so it must satisfy the repo's own
		 * validator — review-208 C1 found this the hard way: leaving
		 * `jitPlacement` on a preview manifest wrote a plan that
		 * PLAN_PREVIEW_REQUIRES_JIT rejects, which made the finished job
		 * un-re-runnable and blamed the operator's plan for it.
		 */
		expect(
			validatePlan(result.plan).filter((i) => i.level === "error"),
		).toEqual([]);

		// Every rewritten start is a start, and none of them still rides a
		// manifest list — the exact property the failing request violated.
		for (const [, op] of result.rewritten) {
			expect(op.kind).toBe("START_ENCODING");
			expect(ridesJitManifests(op)).toBe(false);
		}
		// The appended ops are manifest generation, nothing else: a downgrade
		// that appended a CREATE would mean re-creating an existing resource.
		expect(result.appended.length).toBeGreaterThan(0);
		for (const op of result.appended) {
			expect(op.kind).toMatch(/^(START|AWAIT)_MANIFEST_(HLS|DASH|SMOOTH)$/);
		}
		// Every manifest that rode the start now has BOTH a start and an await.
		const starts = result.appended.filter((o) =>
			o.kind.startsWith("START_MANIFEST"),
		).length;
		const awaits = result.appended.filter((o) =>
			o.kind.startsWith("AWAIT_MANIFEST"),
		).length;
		expect(starts).toBe(awaits);
		expect(starts).toBeGreaterThan(0);
		/**
		 * ORDER, paired BY KEY (review-208 S1). Counting starts and awaits also
		 * passes for a pair belonging to DIFFERENT manifests, and a reversed
		 * append list — await before start — survived every other assertion
		 * here while producing a job that reports FINISHED before the manifest
		 * exists (the fake SDK's status poll answered FINISHED regardless).
		 */
		const appendedSteps = result.appended.map((o) => o.step);
		for (const op of result.appended) {
			if (!op.kind.startsWith("AWAIT_MANIFEST")) {
				continue;
			}
			const key = op.step.replace(/^manifest-await:/, "");
			const startIndex = appendedSteps.indexOf(`manifest-start:${key}`);
			expect(startIndex, `no start for ${op.step}`).toBeGreaterThanOrEqual(0);
			expect(startIndex).toBeLessThan(appendedSteps.indexOf(op.step));
		}
	});

	/**
	 * The load-bearing invariant: the downgrade may only move the manifest
	 * lists. If a compiler change ever made another op differ between the two
	 * timings, applying this fallback mid-run would rewrite a step that has
	 * ALREADY executed — a DONE entry whose snapshot no longer matches what was
	 * sent. This test is where that gets caught, corpus-wide.
	 */
	it.each(
		jitFixtures.map((f) => [f.name, f] as const),
	)("%s: every shared step OTHER than the start compiles byte-identically in both timings", (_name, fixture) => {
		const before = compilePlan(fixture.plan);
		const after = compilePlan({
			...fixture.plan,
			generation: { ...fixture.plan.generation, timing: "POST_ENCODING" },
		});
		const afterByStep = new Map(after.map((op) => [op.step, op]));
		let compared = 0;
		for (const op of before) {
			const twin = afterByStep.get(op.step);
			expect(
				twin,
				`step ${op.step} vanished under POST_ENCODING`,
			).toBeDefined();
			if (op.kind === "START_ENCODING") {
				continue;
			}
			compared += 1;
			expect(twin).toEqual(op);
		}
		expect(compared).toBeGreaterThan(3);
	});
});

describe("JIT downgrade — the refusals", () => {
	const jit = jitFixtures[0];
	if (!jit) {
		throw new Error("no JIT fixture");
	}

	it("refuses a plan that is ALREADY POST_ENCODING (this is what stops a loop)", () => {
		const once = downgradeJitManifests(
			jit.plan,
			initStepLog(compilePlan(jit.plan)).map((e) => e.step),
		);
		if (!once.ok) {
			throw new Error("first downgrade must apply");
		}
		const twice = downgradeJitManifests(
			once.plan,
			initStepLog(compilePlan(once.plan)).map((e) => e.step),
		);
		// The REASON, not just "no": review-208's mutation pass showed this
		// guard could be deleted with every test still green, because a later
		// guard caught the same case — the test named the guard it did not pin.
		expect(twice).toEqual({ ok: false, reason: "ALREADY_POST_ENCODING" });
	});

	it("refuses a JIT plan whose start rides NO manifest (nothing to move)", () => {
		const noManifests = { ...jit.plan, manifests: [] };
		const parsed = encodingPlanSchema.parse(noManifests);
		expect(
			downgradeJitManifests(
				parsed,
				initStepLog(compilePlan(parsed)).map((e) => e.step),
			),
		).toEqual({ ok: false, reason: "NO_JIT_MANIFESTS" });
	});

	it("refuses when the log holds a step the downgraded plan does not compile", () => {
		const steps = initStepLog(compilePlan(jit.plan)).map((e) => e.step);
		expect(
			downgradeJitManifests(jit.plan, [...steps, "muxing:from-another-plan"]),
		).toEqual({ ok: false, reason: "STEP_NOT_COVERED" });
	});

	it("drops jitPlacement and NAMES the manifests whose preview it dropped", () => {
		const preview = jitFixtures.find((f) =>
			f.plan.manifests.some(
				(m) => "jitPlacement" in m && m.jitPlacement !== undefined,
			),
		);
		if (!preview) {
			throw new Error(
				"the corpus must keep a preview-placement fixture — it is the C1 case",
			);
		}
		const result = downgradeJitManifests(
			preview.plan,
			initStepLog(compilePlan(preview.plan)).map((e) => e.step),
		);
		if (!result.ok) {
			throw new Error(`preview fixture must downgrade (${result.reason})`);
		}
		expect(result.droppedPreview.length).toBeGreaterThan(0);
		for (const m of result.plan.manifests) {
			expect("jitPlacement" in m && m.jitPlacement).toBeFalsy();
		}
		expect(
			validatePlan(result.plan).filter((i) => i.level === "error"),
		).toEqual([]);
	});

	it.each(
		JIT_START_REF_KEYS,
	)("ridesJitManifests recognises %s — every key, not only the one the corpus uses", (key) => {
		// review-208 S5/S6/S7: deleting the DASH, SMOOTH or preview keys left
		// every test green, because all 33 fixtures carry the HLS key and
		// `.some` never noticed — a DASH-only JIT plan would silently lose
		// the fallback.
		expect(
			ridesJitManifests({ kind: "START_ENCODING", refs: { [key]: ["m"] } }),
		).toBe(true);
		expect(
			ridesJitManifests({ kind: "START_ENCODING", refs: { [key]: [] } }),
		).toBe(false);
	});

	/**
	 * TOTALITY, not a hand list (review-208b suggestion): `JIT_START_REF_KEYS`
	 * is pinned key-by-key above, but nothing tied it to what the COMPILER
	 * actually emits. A seventh start ref key added to compiler.ts would fall
	 * silently out of `ridesJitManifests` — the fallback would then decline a
	 * start it should have recovered, with no test noticing. Population
	 * derived from the corpus + a forced-JIT sweep, never typed here.
	 */
	it("JIT_START_REF_KEYS covers every manifest-ish ref the compiler puts on a start", () => {
		const emitted = new Set<string>();
		for (const fixture of fixtures) {
			for (const timing of ["JUST_IN_TIME", "POST_ENCODING"] as const) {
				let compiled: ReturnType<typeof compilePlan>;
				try {
					compiled = compilePlan(
						encodingPlanSchema.parse({
							...fixture.plan,
							generation: { ...fixture.plan.generation, timing },
						}),
					);
				} catch {
					continue;
				}
				for (const op of compiled) {
					if (op.kind !== "START_ENCODING") {
						continue;
					}
					for (const key of Object.keys(op.refs)) {
						if (/manifest/i.test(key)) {
							emitted.add(key);
						}
					}
				}
			}
		}
		expect(emitted.size).toBeGreaterThan(0);
		for (const key of emitted) {
			expect(
				JIT_START_REF_KEYS as readonly string[],
				`the compiler emits ${key} on a start but ridesJitManifests cannot see it`,
			).toContain(key);
		}
	});

	it("a DASH-ONLY jit plan downgrades to DASH generation (no fixture covers this shape)", () => {
		const both = fixtures.find(
			(f) =>
				f.plan.generation.timing === "JUST_IN_TIME" &&
				f.plan.manifests.some((m) => m.kind === "DASH") &&
				f.plan.manifests.some((m) => m.kind === "HLS"),
		);
		if (!both) {
			throw new Error("no JIT fixture carries both manifest kinds");
		}
		const dashOnly = encodingPlanSchema.parse({
			...both.plan,
			manifests: both.plan.manifests.filter((m) => m.kind === "DASH"),
		});
		const result = downgradeJitManifests(
			dashOnly,
			initStepLog(compilePlan(dashOnly)).map((e) => e.step),
		);
		if (!result.ok) {
			throw new Error(`DASH-only must downgrade (refused: ${result.reason})`);
		}
		expect(result.appended.map((o) => o.kind).sort()).toEqual([
			"AWAIT_MANIFEST_DASH",
			"START_MANIFEST_DASH",
		]);
	});

	it("EMPTY_TRANSFORM: a log that already covers the POST_ENCODING compile", () => {
		// The guard that stands between "nothing to append" and a job that
		// re-starts plainly, appends nothing, and reports FINISHED with no
		// manifest generated (review-208b I2 — it had no test at all).
		const postSteps = initStepLog(
			compilePlan({
				...jit.plan,
				generation: { ...jit.plan.generation, timing: "POST_ENCODING" },
			}),
		).map((e) => e.step);
		expect(downgradeJitManifests(jit.plan, postSteps)).toEqual({
			ok: false,
			reason: "EMPTY_TRANSFORM",
		});
	});

	it("MULTIPLE_STARTS: a two-encoding JIT plan is refused rather than half-rewritten", () => {
		// PLAN_MULTI_ENCODING_JIT makes this unsubmittable, so it can only
		// arrive as a persisted plan replayed after that rail changes — exactly
		// the hypothetical the guard's own comment describes.
		const dolby = fixtures.find(
			(f) => (f.plan.encodings?.length ?? 0) > 1 && f.plan.manifests.length > 0,
		);
		if (!dolby) {
			throw new Error("no multi-encoding fixture in the corpus");
		}
		const forced = encodingPlanSchema.parse({
			...dolby.plan,
			generation: { ...dolby.plan.generation, timing: "JUST_IN_TIME" },
		});
		const compiled = compilePlan(forced);
		const starts = compiled.filter((op) => op.kind === "START_ENCODING");
		expect(starts.length).toBeGreaterThan(1);
		const result = downgradeJitManifests(
			forced,
			initStepLog(compiled).map((e) => e.step),
		);
		expect(result.ok).toBe(false);
		if (result.ok) {
			throw new Error("must refuse");
		}
		// Measured, not hedged: dolby-dv-3ladder-profile5-dash-ondemand forced
		// to JIT compiles THREE starts and lands on this exact reason.
		expect(result.reason).toBe("MULTIPLE_STARTS");
	});

	it("ridesJitManifests is false for a start with empty lists and for non-starts", () => {
		expect(
			ridesJitManifests({ kind: "START_ENCODING", refs: { encodingId: "e" } }),
		).toBe(false);
		expect(
			ridesJitManifests({
				kind: "START_ENCODING",
				refs: { vodHlsManifestIds: [] },
			}),
		).toBe(false);
		expect(
			ridesJitManifests({
				kind: "AWAIT_ENCODING",
				refs: { vodHlsManifestIds: ["manifest:hls"] },
			}),
		).toBe(false);
		expect(
			ridesJitManifests({
				kind: "START_ENCODING",
				refs: { vodHlsManifestIds: ["manifest:hls"] },
			}),
		).toBe(true);
	});
});
