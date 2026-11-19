import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateLiveActionLayout } from "./live-layout-pilot-probe.mjs";

const button = (action, left, top, right, bottom, hit = true) => ({
	action,
	left,
	top,
	right,
	bottom,
	hit,
});
const start = button("start-new", 16, 100, 136, 132);
const copy = button("copy-settings", 144, 100, 296, 132);
const state = {
	buttons: [start, copy],
	expected: ["start-new", "copy-settings"],
	viewportWidth: 1440,
	scrollWidth: 1440,
	maxGap: 16,
};

test("accepts together and rejects separated actions in the wide case", () => {
	assert.deepEqual(evaluateLiveActionLayout(state).violations, []);
	for (const separated of [
		button("copy-settings", 16, 160, 168, 192),
		button("copy-settings", 600, 100, 752, 132),
	]) {
		assert.deepEqual(
			evaluateLiveActionLayout({ ...state, buttons: [start, separated] })
				.violations,
			["separated-actions"],
		);
	}
});

test("accepts wrapping in a narrow fixture and handles intentional vertical scrolling", () => {
	const result = evaluateLiveActionLayout({
		...state,
		viewportWidth: 320,
		scrollWidth: 320,
		maxGap: null,
		buttons: [start, button("copy-settings", 16, 140, 168, 172, null)],
	});
	assert.equal(result.rows, 2);
	assert.deepEqual(result.violations, []);
});

test("checks each role's exact action set, including duplicates", () => {
	assert.deepEqual(
		evaluateLiveActionLayout({ ...state, expected: [], buttons: [] })
			.violations,
		[],
	);
	assert.deepEqual(
		evaluateLiveActionLayout({ ...state, buttons: [start] }).violations,
		["unexpected-actions"],
	);
	assert.ok(
		evaluateLiveActionLayout({
			...state,
			buttons: [start, copy, copy],
		}).violations.includes("unexpected-actions"),
	);
});

test("detects overlap, obscured hit targets, action clipping and document overflow", () => {
	assert.deepEqual(
		evaluateLiveActionLayout({
			...state,
			maxGap: null,
			viewportWidth: 320,
			scrollWidth: 380,
			buttons: [start, button("copy-settings", 129, 100, 381, 132, false)],
		}).violations,
		[
			"document-overflow",
			"clipped-action",
			"obscured-action",
			"overlapping-actions",
		],
	);
});
