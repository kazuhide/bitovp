import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
	isVerificationKeyConflict,
	VERIFICATION_KEY_FIELDS,
	verificationDispatchHasKeyPair,
	verificationKeyPairComplete,
	verificationReplay,
} from "./verification-key";

/** EV-01 (audit 5c3d97ca BLOCKER-5): the create routes' idempotency rule. */

describe("verificationReplay — same key, same SHA replays; different SHA conflicts", () => {
	const sha = "a".repeat(64);

	it("answers none when nothing carries the key", () => {
		expect(verificationReplay(null, sha)).toEqual({ kind: "none" });
	});

	it("replays the existing row WITHOUT the bookkeeping column", () => {
		const verdict = verificationReplay(
			{ id: "job-1", status: "QUEUED", verificationRequestSha256: sha },
			sha,
		);
		expect(verdict).toEqual({
			kind: "replay",
			row: { id: "job-1", status: "QUEUED" },
		});
	});

	it("conflicts when the stored SHA differs — the key described another request", () => {
		expect(
			verificationReplay(
				{ id: "job-1", verificationRequestSha256: "b".repeat(64) },
				sha,
			),
		).toEqual({ kind: "conflict" });
		// A row stamped with the key but no SHA (never written by this route)
		// is a conflict too — nothing proves it was this request.
		expect(
			verificationReplay({ id: "job-1", verificationRequestSha256: null }, sha),
		).toEqual({ kind: "conflict" });
	});
});

describe("the body fields", () => {
	const schema = z
		.object(VERIFICATION_KEY_FIELDS)
		.refine(verificationKeyPairComplete)
		.refine(verificationDispatchHasKeyPair);
	const dispatch = {
		verificationRunId: "00000000-0000-4000-8000-000000000001",
		runGeneration: 0,
		intentId: "00000000-0000-4000-8000-000000000002",
		intentGeneration: 1,
		token: "verify-dispatch:11111111-1111-4111-8111-111111111111",
	};

	it("accepts the pair, and neither", () => {
		expect(
			schema.safeParse({
				verificationKey: "verify:r:s:VOD_JOB",
				requestSha256: "0".repeat(64),
				verificationDispatch: dispatch,
			}).success,
		).toBe(true);
		expect(schema.safeParse({}).success).toBe(true);
	});

	it("refuses dispatch metadata without its verification key identity", () => {
		expect(schema.safeParse({ verificationDispatch: dispatch }).success).toBe(
			false,
		);
	});

	it("refuses one without the other, and a non-hex or wrong-length digest", () => {
		expect(schema.safeParse({ verificationKey: "k" }).success).toBe(false);
		expect(schema.safeParse({ requestSha256: "0".repeat(64) }).success).toBe(
			false,
		);
		expect(
			schema.safeParse({ verificationKey: "k", requestSha256: "Z".repeat(64) })
				.success,
		).toBe(false);
		expect(
			schema.safeParse({ verificationKey: "k", requestSha256: "0".repeat(63) })
				.success,
		).toBe(false);
	});
});

describe("isVerificationKeyConflict — only the key's own unique violation", () => {
	it("matches P2002 on verificationKey (array or string target)", () => {
		expect(
			isVerificationKeyConflict({
				code: "P2002",
				meta: { target: ["verificationKey"] },
			}),
		).toBe(true);
		expect(
			isVerificationKeyConflict({
				code: "P2002",
				meta: { target: "EncodingJob_verificationKey_key" },
			}),
		).toBe(true);
	});

	it("does not match another unique column, another code, or a bare error", () => {
		expect(
			isVerificationKeyConflict({
				code: "P2002",
				meta: { target: ["bitmovinEncodingId"] },
			}),
		).toBe(false);
		expect(isVerificationKeyConflict({ code: "P2025" })).toBe(false);
		expect(isVerificationKeyConflict(new Error("P2002"))).toBe(false);
	});
});
