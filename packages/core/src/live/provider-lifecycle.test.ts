import { describe, expect, it } from "vitest";
import {
	classifyProviderLifecycle,
	classifyProviderStatusWord,
	deriveProviderLifecycle,
	PROVIDER_STATUS_TTL_MS,
	PROVIDER_UNKNOWN_GRACE_MS,
	providerEffectIdentityRefusal,
	providerEffectRefusal,
	providerUnknownPastGrace,
} from "./provider-lifecycle";

/**
 * the pure
 * classifier, table-driven. Every arm the audit names: timeout, credential /
 * network error, single 404 and TTL expiry are UNKNOWN; the SDK's terminal
 * words are TERMINAL; only RUNNING is RUNNING; an unrecognised word is UNKNOWN.
 */

const NOW = Date.parse("2026-08-30T12:00:00.000Z");
const at = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

describe("classifyProviderStatusWord — the SDK Status enum, and nothing else", () => {
	it.each([
		["RUNNING", "RUNNING"],
		["CREATED", "TRANSITIONAL"],
		["QUEUED", "TRANSITIONAL"],
		["FINISHED", "TERMINAL"],
		["ERROR", "TERMINAL"],
		["CANCELED", "TERMINAL"],
		["TRANSFER_ERROR", "TERMINAL"],
		// Not in the enum: never alive, never gone.
		["STOPPED", "UNKNOWN"],
		["running", "UNKNOWN"],
		["", "UNKNOWN"],
	] as const)("%s ⇒ %s", (word, expected) => {
		expect(classifyProviderStatusWord(word)).toBe(expected);
	});

	it("a non-string wire value is UNKNOWN", () => {
		expect(classifyProviderStatusWord(undefined)).toBe("UNKNOWN");
		expect(classifyProviderStatusWord(null)).toBe("UNKNOWN");
		expect(classifyProviderStatusWord(200)).toBe("UNKNOWN");
	});
});

describe("classifyProviderLifecycle — observation × clock", () => {
	it.each([
		["timeout", "request timed out after 10000ms"],
		["credential error", "401 Unauthorized"],
		["network error", "ECONNRESET"],
		["single 404", "404 Not Found"],
	])("a failed readback (%s) is UNKNOWN, never TERMINAL", (_label, error) => {
		expect(
			classifyProviderLifecycle({ ok: false, error, observedAt: at(0) }, NOW),
		).toBe("UNKNOWN");
	});

	it("a fresh RUNNING is RUNNING; the same reading past the TTL is UNKNOWN", () => {
		const fresh = { ok: true as const, status: "RUNNING", observedAt: at(-1) };
		expect(classifyProviderLifecycle(fresh, NOW)).toBe("RUNNING");
		const stale = {
			ok: true as const,
			status: "RUNNING",
			observedAt: at(-PROVIDER_STATUS_TTL_MS - 1),
		};
		expect(classifyProviderLifecycle(stale, NOW)).toBe("UNKNOWN");
		// Exactly at the TTL is still inside it (freshness is `age > ttl`).
		const edge = {
			ok: true as const,
			status: "RUNNING",
			observedAt: at(-PROVIDER_STATUS_TTL_MS),
		};
		expect(classifyProviderLifecycle(edge, NOW)).toBe("RUNNING");
	});

	it("a future-stamped reading (clock skew) is fresh, not stale", () => {
		expect(
			classifyProviderLifecycle(
				{ ok: true, status: "RUNNING", observedAt: at(30_000) },
				NOW,
			),
		).toBe("RUNNING");
	});

	it("a fresh terminal word is TERMINAL and a fresh QUEUED is TRANSITIONAL", () => {
		expect(
			classifyProviderLifecycle(
				{ ok: true, status: "FINISHED", observedAt: at(0) },
				NOW,
			),
		).toBe("TERMINAL");
		expect(
			classifyProviderLifecycle(
				{ ok: true, status: "QUEUED", observedAt: at(0) },
				NOW,
			),
		).toBe("TRANSITIONAL");
	});

	it("an unparsable observedAt is UNKNOWN — a claim with no time has no freshness", () => {
		expect(
			classifyProviderLifecycle(
				{ ok: true, status: "RUNNING", observedAt: "not-a-date" },
				NOW,
			),
		).toBe("UNKNOWN");
	});
});

describe("deriveProviderLifecycle — the persisted run columns", () => {
	it("no run, or a run with null columns, is UNOBSERVED — never UNKNOWN and never RUNNING", () => {
		expect(deriveProviderLifecycle(null, NOW)).toBe("UNOBSERVED");
		expect(deriveProviderLifecycle(undefined, NOW)).toBe("UNOBSERVED");
		expect(
			deriveProviderLifecycle(
				{
					providerStatus: null,
					providerStatusObservedAt: null,
					providerUnknownSince: null,
					providerTerminalAt: null,
				},
				NOW,
			),
		).toBe("UNOBSERVED");
	});

	it("a stamped providerTerminalAt is TERMINAL whatever the last word was", () => {
		expect(
			deriveProviderLifecycle(
				{
					providerStatus: "RUNNING",
					providerStatusObservedAt: new Date(NOW),
					providerUnknownSince: null,
					providerTerminalAt: new Date(NOW - 1),
				},
				NOW,
			),
		).toBe("TERMINAL");
	});

	it("a terminal WORD is TERMINAL even before the stamp lands", () => {
		expect(
			deriveProviderLifecycle(
				{
					providerStatus: "FINISHED",
					providerStatusObservedAt: new Date(NOW),
					providerUnknownSince: null,
					providerTerminalAt: null,
				},
				NOW,
			),
		).toBe("TERMINAL");
	});

	it("an open UNKNOWN window is UNKNOWN even though the last successful word was a fresh RUNNING", () => {
		expect(
			deriveProviderLifecycle(
				{
					providerStatus: "RUNNING",
					providerStatusObservedAt: new Date(NOW - 1000),
					providerUnknownSince: new Date(NOW - 500),
					providerTerminalAt: null,
				},
				NOW,
			),
		).toBe("UNKNOWN");
	});

	it("a confirmed RUNNING is RUNNING while fresh and UNKNOWN once the TTL lapses", () => {
		const confirmed = (ageMs: number) =>
			deriveProviderLifecycle(
				{
					providerStatus: "RUNNING",
					providerStatusObservedAt: new Date(NOW - ageMs),
					providerUnknownSince: null,
					providerTerminalAt: null,
				},
				NOW,
			);
		expect(confirmed(10_000)).toBe("RUNNING");
		expect(confirmed(PROVIDER_STATUS_TTL_MS + 1)).toBe("UNKNOWN");
	});

	it("accepts ISO strings for the timestamps (the JSON the detail route serves)", () => {
		expect(
			deriveProviderLifecycle(
				{
					providerStatus: "QUEUED",
					providerStatusObservedAt: at(-1000),
					providerUnknownSince: null,
					providerTerminalAt: null,
				},
				NOW,
			),
		).toBe("TRANSITIONAL");
	});

	it("a word with no observation time is UNKNOWN", () => {
		expect(
			deriveProviderLifecycle(
				{ providerStatus: "RUNNING", providerStatusObservedAt: null },
				NOW,
			),
		).toBe("UNKNOWN");
	});
});

describe("providerUnknownPastGrace / providerEffectRefusal", () => {
	it("grace is measured from providerUnknownSince and null never alerts", () => {
		expect(providerUnknownPastGrace(null, NOW)).toBe(false);
		expect(
			providerUnknownPastGrace(
				new Date(NOW - PROVIDER_UNKNOWN_GRACE_MS + 1),
				NOW,
			),
		).toBe(false);
		expect(
			providerUnknownPastGrace(new Date(NOW - PROVIDER_UNKNOWN_GRACE_MS), NOW),
		).toBe(true);
	});

	it("only fresh RUNNING permits a new provider/ingest effect", () => {
		expect(providerEffectRefusal("UNKNOWN")).toMatch(/cannot be confirmed/);
		expect(providerEffectRefusal("UNKNOWN")).toMatch(/retry/);
		expect(providerEffectRefusal("TERMINAL")).toMatch(/fresh run/);
		expect(providerEffectRefusal("RUNNING")).toBeNull();
		expect(providerEffectRefusal("TRANSITIONAL")).toMatch(/not RUNNING/);
		expect(providerEffectRefusal("UNOBSERVED")).toMatch(/not been observed/);
	});

	it.each([
		[
			"missing expected run",
			{ expectedRunId: null, expectedEncodingId: "enc-1" },
		],
		[
			"missing expected encoding",
			{ expectedRunId: "run-1", expectedEncodingId: null },
		],
		["missing current run", { currentRunId: null, currentEncodingId: "enc-1" }],
		[
			"missing current encoding",
			{ currentRunId: "run-1", currentEncodingId: null },
		],
		["run mismatch", { currentRunId: "run-2" }],
		["encoding mismatch", { currentEncodingId: "enc-2" }],
	])("refuses an effect for %s", (_label, overrides) => {
		expect(
			providerEffectIdentityRefusal({
				expectedRunId: "run-1",
				expectedEncodingId: "enc-1",
				currentRunId: "run-1",
				currentEncodingId: "enc-1",
				...overrides,
			}),
		).not.toBeNull();
	});

	it("permits only the exact non-null run and encoding identity", () => {
		expect(
			providerEffectIdentityRefusal({
				expectedRunId: "run-1",
				expectedEncodingId: "enc-1",
				currentRunId: "run-1",
				currentEncodingId: "enc-1",
			}),
		).toBeNull();
	});
});
