import "@testing-library/jest-dom/vitest";
import { configure } from "@testing-library/react";
import { afterEach, vi } from "vitest";

// `findBy*` / `waitFor` default to a 1 s budget. That budget measures the
// machine, not the component: under three concurrent gate runs (2026-08-29,
// merging #347) `findByText("studio-a")` in live-settings-views timed out on
// a render that passes solo in well under a second. The queries still resolve
// on the OBSERVED element — only the ceiling moves — so a green run is no
// slower and a genuinely missing element still fails, ten seconds later.
configure({ asyncUtilTimeout: 10_000 });

/**
 * Ledger #98: drain unmount-scheduled timers INSIDE the live realm.
 *
 * Radix's focus-scope returns focus in a `setTimeout(0)` scheduled at
 * unmount. RTL's auto-cleanup unmounts in its own afterEach; when the last
 * test of a file ends, vitest tears the jsdom realm down and that timer
 * fires into it — `TypeError: Failed to execute 'dispatchEvent'` as an
 * UNHANDLED error. The suite then reports every test green and exits 1
 * (the defining count-green/exit-nonzero divergence), intermittently,
 * because it is a scheduling race.
 *
 * Hook order makes this deterministic: afterEach hooks run LIFO, this file
 * registers first, so this hook runs AFTER the test file's own hooks —
 * including RTL's cleanup, which is what schedules the stray timer. One
 * macrotask tick is the timer's own granularity; two covers a re-schedule.
 *
 * Skipped under fake timers: a faked setTimeout cannot leak a REAL timer
 * into teardown (the fake clock dies with the test), and awaiting a faked
 * timeout here would hang the hook instead.
 */
afterEach(async () => {
	window.localStorage.clear();
	if (vi.isFakeTimers()) {
		return;
	}
	for (let tick = 0; tick < 2; tick += 1) {
		await new Promise((resolve) => {
			setTimeout(resolve, 0);
		});
	}
});

// jsdom has no ResizeObserver; Recharts' ResponsiveContainer constructs one.
// Component tests additionally mock ResponsiveContainer to a fixed size so the
// chart children actually mount (jsdom reports 0×0), but the polyfill keeps
// any unmocked Recharts code from throwing on construction.
if (typeof globalThis.ResizeObserver === "undefined") {
	globalThis.ResizeObserver = class {
		observe() {}
		unobserve() {}
		disconnect() {}
	} as unknown as typeof ResizeObserver;
}
