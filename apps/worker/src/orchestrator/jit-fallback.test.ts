import { readFileSync } from "node:fs";
import { join } from "node:path";
import { compilePlan, encodingPlanSchema, initStepLog } from "@bitovp/core";
import { describe, expect, it } from "vitest";
import { applyJitFallback, planJitFallback } from "./jit-fallback";

/**
 * 's runtime half, unit-tested — review-208 found the module had
 * NO tests of its own: every claim it makes was carried by one happy-path
 * e2e, and three mutations of it survived (dropping the payload rewrite,
 * dropping the refs guard, rewriting a DONE step).
 */
const plan = encodingPlanSchema.parse(
	JSON.parse(
		readFileSync(
			join(
				__dirname,
				"../../../../packages/core/src/plan/__fixtures__/fixed-bitrate-hls-on-aws.plan.json",
			),
			"utf8",
		),
	),
);
const start1004 = Object.assign(new Error("start failed (500) code 1004"), {
	httpStatusCode: 500,
	errorCode: 1004,
});
const entriesFor = () => initStepLog(compilePlan(plan));
const startOf = (entries: ReturnType<typeof entriesFor>) => {
	const entry = entries.find((e) => e.kind === "START_ENCODING");
	if (!entry) {
		throw new Error("fixture must compile a start");
	}
	return entry;
};

describe("planJitFallback — when it applies", () => {
	it("applies for a 1004 on a start that rides manifests", () => {
		const entries = entriesFor();
		expect(
			planJitFallback(start1004, startOf(entries), plan, entries),
		).not.toBeNull();
	});

	it("does NOT apply to a 1004 on a start that rides NO manifest (its own guard, not core's)", () => {
		// The shape the guard exists for: a JIT plan replayed against a step log
		// whose start predates the manifests. Core would still compute a
		// downgrade; this refusal is what keeps the fallback off a start that
		// never carried a manifest list (review-208 S9).
		const entries = entriesFor();
		const start = startOf(entries);
		const stripped = { ...start, refs: { encodingId: "encoding" } };
		expect(planJitFallback(start1004, stripped, plan, entries)).toBeNull();
	});

	it("does NOT apply to a non-1004 failure", () => {
		const entries = entriesFor();
		const other = Object.assign(new Error("bad request"), {
			httpStatusCode: 400,
			errorCode: 1000,
		});
		expect(planJitFallback(other, startOf(entries), plan, entries)).toBeNull();
	});
});

describe("applyJitFallback — what it writes", () => {
	it("rewrites the start's payload AND refs, and appends manifest steps as PENDING", () => {
		const entries = entriesFor();
		const before = entries.length;
		const start = startOf(entries);
		expect(JSON.stringify(start.refs)).toContain("vodHlsManifestIds");
		const downgrade = planJitFallback(start1004, start, plan, entries);
		if (!downgrade?.ok) {
			throw new Error("must apply");
		}
		const note = applyJitFallback(downgrade, entries, "req-42");

		// PAYLOAD, not just refs (review-208 S8): the JIT start carries
		// manifestGenerator, which belongs on the manifest starts once the
		// generation moves after the encode.
		expect(start.payload).toEqual({});
		expect(JSON.stringify(start.refs)).not.toContain("vodHlsManifestIds");
		expect(entries.length).toBeGreaterThan(before);
		const appended = entries.slice(before);
		expect(appended.every((e) => e.status === "PENDING")).toBe(true);
		expect(appended.map((e) => e.step)).toEqual(note.appendedSteps);
		expect(note.requestId).toBe("req-42");
		// The manifest start carries the generator the encoding start lost.
		const manifestStart = appended.find((e) =>
			e.kind.startsWith("START_MANIFEST"),
		);
		expect(manifestStart?.payload).toMatchObject({ manifestGenerator: "V2" });
	});

	it("never rewrites a start that is already DONE", () => {
		const entries = entriesFor();
		const start = startOf(entries);
		const downgrade = planJitFallback(start1004, start, plan, entries);
		if (!downgrade?.ok) {
			throw new Error("must apply");
		}
		start.status = "DONE";
		const originalRefs = JSON.stringify(start.refs);
		applyJitFallback(downgrade, entries);
		expect(JSON.stringify(start.refs)).toBe(originalRefs);
	});
});
