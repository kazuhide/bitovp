import assert from "node:assert/strict";
import { test } from "node:test";
import {
	childEnvironment,
	requireCoverage,
	summarizeTrace,
	transitionCoverage,
} from "./bombadil-component.mjs";

test("only actual trace violations qualify; snapshot property names do not", () => {
	const trace = summarizeTrace([
		{
			action: null,
			snapshots: [{ name: "defaultCopySourceIsLast" }],
			violations: [],
		},
	]);
	assert.equal(trace.actions, 0);
	assert.deepEqual(trace.violationNames, []);
	assert.deepEqual(
		summarizeTrace([
			{
				action: { Custom: {} },
				violations: [{ name: "defaultCopySourceIsLast" }],
			},
		]).violationNames,
		["defaultCopySourceIsLast"],
	);
});

test("nonvacuity rejects an unready fixture, short traces and missing operations", () => {
	const evidence = {
		ready: true,
		counts: { select: 1, collision: 1, reorder: 1, add: 1, reset: 1 },
		receipts: [{}],
	};
	assert.throws(() => requireCoverage(undefined, { actions: 20 }), /readiness/);
	assert.throws(() => requireCoverage(evidence, { actions: 0 }), /20 actual/);
	assert.throws(
		() =>
			requireCoverage(
				{ ...evidence, counts: { ...evidence.counts, reorder: 0 } },
				{ actions: 20 },
			),
		/reorder/,
	);
	assert.throws(
		() => requireCoverage({ ...evidence, receipts: [] }, { actions: 20 }),
		/onAdd/,
	);
	requireCoverage(evidence, { actions: 20 });
});

test("the browser and tool receive an allowlisted environment", () => {
	const environment = childEnvironment("/owned/bombadil");
	assert.deepEqual(Object.keys(environment).sort(), [
		"LANG",
		"NO_COLOR",
		"PATH",
		"TMPDIR",
	]);
	assert.equal(environment.TMPDIR, "/owned/bombadil");
});

test("coverage distinguishes a repaired-key reorder from ambiguous positional reorders", () => {
	const state = (collision, select, reorder, add = 0, pristine = false) => ({
		collision,
		pristine,
		intent: { label: "Rendition 2" },
		counts: { select, reorder, add, reset: 0 },
	});
	assert.deepEqual(
		transitionCoverage([
			state(false, 1, 0),
			state(true, 1, 0),
			state(true, 1, 1),
			state(false, 1, 1),
			state(false, 1, 2),
			state(true, 1, 2),
			state(true, 1, 2, 1, true),
		]),
		{
			uniqueKeyReorders: 1,
			resolvedCollisionReorders: 1,
			ambiguousCountResets: 1,
		},
	);
	assert.equal(
		transitionCoverage([
			state(true, 1, 0),
			state(false, 1, 0),
			state(false, 2, 0),
			state(false, 2, 1),
		]).resolvedCollisionReorders,
		0,
		"a fresh user choice must not count as retained repaired-key identity",
	);
});
