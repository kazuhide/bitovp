import { describe, expect, it } from "vitest";
import {
	isVerificationIntentKind,
	isVerificationIntentState,
	VERIFICATION_INTENT_CLEANUP_STATES,
	VERIFICATION_INTENT_STATES,
	verificationIntentClosureDigest,
	verificationIntentsSealable,
	verificationKeyFor,
	verificationKeyLabel,
	verificationRequestBodySha256,
	verificationRequestSha256,
} from "./resource-intent";

/**
 * The VerificationResourceIntent contract.
 * The DECISIONS the harness makes on these values live in the worker's
 * resource-intent module; this pins the vocabulary and the seal rule.
 */

describe("verificationKeyFor — deterministic, and refuses what it cannot separate", () => {
	it("derives the same key for the same (run, scenario, kind) — a lookup needs no response", () => {
		expect(
			verificationKeyFor(
				"2026-08-31T01-00-00-000-abc123",
				"h264-hls",
				"VOD_JOB",
			),
		).toBe("verify:2026-08-31T01-00-00-000-abc123:h264-hls:VOD_JOB");
		expect(verificationKeyFor("r1", "s", "LIVE_CHANNEL")).toBe(
			verificationKeyFor("r1", "s", "LIVE_CHANNEL"),
		);
	});

	it("differs per kind, so a VOD job and a live channel of one scenario never share a key", () => {
		expect(verificationKeyFor("r1", "s", "VOD_JOB")).not.toBe(
			verificationKeyFor("r1", "s", "LIVE_CHANNEL"),
		);
	});

	it("refuses a run id or scenario carrying the separator — a forgeable key is no key", () => {
		expect(() => verificationKeyFor("r:1", "s", "VOD_JOB")).toThrow(/":"/);
		expect(() => verificationKeyFor("r1", "a:b", "VOD_JOB")).toThrow(/":"/);
		expect(() => verificationKeyFor("", "s", "VOD_JOB")).toThrow(/empty/);
	});

	it("labels the key under a fixed prefix so a resource can be found by its marker", () => {
		expect(verificationKeyLabel("verify:r1:s:VOD_JOB")).toBe(
			"verify-key:verify:r1:s:VOD_JOB",
		);
	});
});

describe("verificationRequestSha256 — the client's statement of the bytes it meant to send", () => {
	it("is stable for equal bodies and changes with any field", () => {
		const a = verificationRequestSha256({ name: "n", plan: { x: 1 } });
		expect(a).toMatch(/^[0-9a-f]{64}$/);
		expect(verificationRequestSha256({ name: "n", plan: { x: 1 } })).toBe(a);
		expect(verificationRequestSha256({ name: "n", plan: { x: 2 } })).not.toBe(
			a,
		);
	});

	it("canonicalizes object keys, so the server can recompute the same semantic request digest", () => {
		expect(
			verificationRequestSha256({
				verificationKey: "verify:r:s:VOD_JOB",
				plan: { z: 1, nested: { b: 2, a: 1 } },
			}),
		).toBe(
			verificationRequestSha256({
				plan: { nested: { a: 1, b: 2 }, z: 1 },
				verificationKey: "verify:r:s:VOD_JOB",
			}),
		);
	});

	it("recomputes an HTTP body's digest without trusting its requestSha256 claim", () => {
		const unsigned = {
			plan: { name: "expected" },
			verificationKey: "verify:r:s:VOD_JOB",
		};
		const claimed = verificationRequestSha256(unsigned);
		expect(
			verificationRequestBodySha256({ ...unsigned, requestSha256: claimed }),
		).toBe(claimed);
		expect(
			verificationRequestBodySha256({
				...unsigned,
				plan: { name: "changed" },
				requestSha256: claimed,
			}),
		).not.toBe(claimed);
	});

	it("excludes the one-time dispatch fence from request identity", () => {
		const unsigned = {
			plan: { name: "expected" },
			verificationKey: "verify:r:s:VOD_JOB",
		};
		const claimed = verificationRequestSha256(unsigned);
		expect(
			verificationRequestBodySha256({
				...unsigned,
				requestSha256: claimed,
				verificationDispatch: {
					verificationRunId: "00000000-0000-4000-8000-000000000001",
					runGeneration: 0,
					intentId: "00000000-0000-4000-8000-000000000002",
					intentGeneration: 1,
					token: "verify-dispatch:one-time-bearer-token",
				},
			}),
		).toBe(claimed);
	});
});

describe("the vocabulary", () => {
	it("carries exactly the five states and the four cleanup states the audit names", () => {
		expect(VERIFICATION_INTENT_STATES).toEqual([
			"PREPARED",
			"SUBMITTED",
			"CONFIRMED",
			"AMBIGUOUS",
			"TERMINAL",
		]);
		expect(VERIFICATION_INTENT_CLEANUP_STATES).toEqual([
			"PENDING",
			"CLEANED",
			"NEVER_CREATED",
			"UNRESOLVED",
		]);
		expect(isVerificationIntentState("AMBIGUOUS")).toBe(true);
		expect(isVerificationIntentState("RETRYING")).toBe(false);
		expect(isVerificationIntentKind("VOD_JOB")).toBe(true);
		expect(isVerificationIntentKind("ENCODING")).toBe(false);
	});
});

describe("verificationIntentsSealable — possibly-created == terminal-readback-and-cleaned", () => {
	const row = (
		verificationKey: string,
		state: string,
		cleanupState: string,
		overrides: Record<string, unknown> = {},
	) => {
		const base = {
			verificationKey,
			requestSha256: "a".repeat(64),
			state,
			cleanupState,
			possiblyCreatedKeys: ["local:VOD_JOB:job-1"],
			cleanedResourceKeys: ["local:VOD_JOB:job-1"],
			providerIds: [],
			candidates: [],
			readback: { localStatus: "FINISHED" },
			...overrides,
		};
		return {
			...base,
			closureDigest: verificationIntentClosureDigest(base),
		};
	};

	it("seals an empty set and a set where every intent is TERMINAL and CLEANED or NEVER_CREATED", () => {
		expect(verificationIntentsSealable([])).toEqual({
			sealable: true,
			unresolved: [],
		});
		expect(
			verificationIntentsSealable([
				row("k1", "TERMINAL", "CLEANED"),
				row("k2", "TERMINAL", "NEVER_CREATED", {
					possiblyCreatedKeys: [],
					cleanedResourceKeys: [],
					readback: { neverSent: true },
				}),
			]).sealable,
		).toBe(true);
	});

	it("refuses CLEANED when an orphan is in the possibly-created set but not the cleaned set", () => {
		const bad = row("k", "TERMINAL", "CLEANED", {
			possiblyCreatedKeys: [
				"local:VOD_JOB:job-1",
				"provider:BITMOVIN_ENCODING:enc-orphan",
			],
			cleanedResourceKeys: ["local:VOD_JOB:job-1"],
		});
		expect(verificationIntentsSealable([bad])).toMatchObject({
			sealable: false,
			unresolved: [bad],
		});
	});

	it("refuses a status-only closure, a missing direct readback and a stale digest", () => {
		const statusOnly = {
			verificationKey: "k-status",
			state: "TERMINAL",
			cleanupState: "CLEANED",
		};
		const noReadback = row("k-read", "TERMINAL", "CLEANED", {
			readback: null,
		});
		const staleDigest = {
			...row("k-digest", "TERMINAL", "CLEANED"),
			closureDigest: "0".repeat(64),
		};
		const verdict = verificationIntentsSealable([
			statusOnly,
			noReadback,
			staleDigest,
		]);
		expect(verdict.sealable).toBe(false);
		expect(verdict.unresolved).toHaveLength(3);
	});

	it("refuses on ONE unresolved intent, whatever the rest look like", () => {
		for (const bad of [
			row("k", "AMBIGUOUS", "PENDING"),
			row("k", "CONFIRMED", "PENDING"),
			row("k", "SUBMITTED", "PENDING"),
			row("k", "PREPARED", "PENDING"),
			// TERMINAL alone is not enough: the cleanup must have been proven.
			row("k", "TERMINAL", "PENDING"),
			row("k", "TERMINAL", "UNRESOLVED"),
		]) {
			const verdict = verificationIntentsSealable([
				row("ok", "TERMINAL", "CLEANED"),
				bad,
			]);
			expect(verdict.sealable, JSON.stringify(bad)).toBe(false);
			expect(verdict.unresolved).toEqual([bad]);
		}
	});
});
