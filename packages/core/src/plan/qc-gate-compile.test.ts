import { describe, expect, it } from "vitest";
import { compilePlan } from "./compiler";
import { qcGateSchema } from "./qc-gate";
import { encodingPlanSchema } from "./schema";
import { initStepLog, stepLogSchema } from "./steplog";
import { loadPlan } from "./test-support";

/**
 * Deferred-group compilation .
 *
 * Pinned as a unit test, deliberately NOT a 67th golden fixture: the fixture
 * counts are pinned across plan-import, the corpus preflight and three docs,
 * so a synthetic fixture is a repo-wide renumbering — while the bytes under
 * test here are exactly the ones a golden would pin (the compiled ops of a
 * BLOCK_MANIFESTS plan vs the same plan without its gate). Non-gate plans'
 * byte-identity is held by the existing 73-fixture golden suite.
 */

const MANIFEST_FAMILY = /MANIFEST|HLS|DASH|SMOOTH/;

function gatedPlan(onFail: "MARK_ONLY" | "BLOCK_MANIFESTS") {
	// A real corpus plan (HLS + DASH, post-encoding) with the gate grafted on.
	const raw = loadPlan("ai-scene-analysis-pertitle");
	const plan = encodingPlanSchema.parse(raw);
	return encodingPlanSchema.parse({
		...plan,
		qc: {
			...(plan.qc ?? { vmaf: true }),
			vmaf: true,
			gate: qcGateSchema.parse({
				rules: [{ metric: "VMAF_MEAN", scope: "OVERALL", gte: 80 }],
				onFail,
			}),
		},
	});
}

describe("BLOCK_MANIFESTS deferred group", () => {
	it("stamps the ENTIRE manifest family post-qc, and nothing else", () => {
		const ops = compilePlan(gatedPlan("BLOCK_MANIFESTS"));
		const deferred = ops.filter((op) => op.phase === "post-qc");
		const rest = ops.filter((op) => op.phase === undefined);
		expect(deferred.length).toBeGreaterThan(0);
		// Every deferred op is a manifest-family op (creates, tree children,
		// start, await) — and every manifest-family op is deferred: the group
		// is the WHOLE delivery surface or the gate has a hole.
		expect(deferred.every((op) => MANIFEST_FAMILY.test(op.kind))).toBe(true);
		expect(rest.every((op) => !MANIFEST_FAMILY.test(op.kind))).toBe(true);
		// The encoding itself, and the per-title capture, run PRE-gate.
		expect(rest.some((op) => op.kind === "AWAIT_ENCODING")).toBe(true);
		expect(rest.some((op) => op.kind === "CAPTURE_PER_TITLE_RESULTS")).toBe(
			true,
		);
	});

	it("start/await ops are deferred alongside their create trees", () => {
		const ops = compilePlan(gatedPlan("BLOCK_MANIFESTS"));
		for (const kind of [
			"START_MANIFEST_HLS",
			"AWAIT_MANIFEST_HLS",
			"START_MANIFEST_DASH",
			"AWAIT_MANIFEST_DASH",
		] as const) {
			const op = ops.find((entry) => entry.kind === kind);
			expect(op, kind).toBeDefined();
			expect(op?.phase, kind).toBe("post-qc");
		}
	});

	it("MARK_ONLY compiles with NO phase key anywhere — same bytes as gateless", () => {
		const markOnly = compilePlan(gatedPlan("MARK_ONLY"));
		expect(markOnly.every((op) => op.phase === undefined)).toBe(true);
		// Deep-equal against the SAME plan with the gate stripped: MARK_ONLY
		// must be a pure judgment overlay, invisible to the compiler.
		const gateless = gatedPlan("MARK_ONLY");
		const stripped = encodingPlanSchema.parse({
			...gateless,
			qc: { ...gateless.qc, gate: undefined },
		});
		expect(markOnly).toEqual(compilePlan(stripped));
	});

	it("the persisted step log round-trips the phase marker", () => {
		const entries = initStepLog(compilePlan(gatedPlan("BLOCK_MANIFESTS")));
		const parsed = stepLogSchema.parse(JSON.parse(JSON.stringify(entries)));
		const deferred = parsed.filter((entry) => entry.phase === "post-qc");
		expect(deferred.length).toBeGreaterThan(0);
		// strictObject would have thrown if `phase` were unlisted; the equal
		// count proves it also SURVIVES the round-trip rather than being
		// stripped by a lenient parse.
		expect(deferred.length).toBe(
			entries.filter((entry) => entry.phase === "post-qc").length,
		);
	});
});
