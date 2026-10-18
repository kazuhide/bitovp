import { describe, expect, it } from "vitest";
import { hashApiTokenSecret } from "./api-token-hash";

/**
 * The algorithm is pinned to a LITERAL, not to a second call of itself.
 *
 * Both consumers (the web gate, the verification harness) now derive their
 * value from this function, so a test that hashed with the same function and
 * compared would agree with any algorithm at all — including a changed one
 * that invalidates every `tokenHash` already in Postgres. The vector below is
 * the only assertion here that a rewrite cannot satisfy by accident.
 */
describe("hashApiTokenSecret", () => {
	it("is SHA-256 hex of the secret, pinned by vector", () => {
		// The published SHA-256 of "abc" — a value nothing in this repo
		// computes, so agreeing with it means agreeing with SHA-256 itself.
		expect(hashApiTokenSecret("abc")).toBe(
			"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
		);
	});

	it("is 64 lowercase hex characters, and distinguishes secrets", () => {
		expect(hashApiTokenSecret("bo_one")).toMatch(/^[0-9a-f]{64}$/);
		expect(hashApiTokenSecret("bo_one")).not.toBe(hashApiTokenSecret("bo_two"));
	});
});
