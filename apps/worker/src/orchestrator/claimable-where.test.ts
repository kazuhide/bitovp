import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ATTEMPT_LEASE_MS, claimableWhere } from "./processor";

/**
 * The BullMQ `failed` handler and the processor's claim share ONE where-clause
 * (review-322 C2). The handler used to match on status alone, so a doubly-stalled
 * original delivery's belated `failed` event ERRORed the redelivery that had since
 * claimed the row and was running correctly — and on the unattended path stopped its
 * encoding at the provider. This pins the shape both callers receive; `index.ts`'s
 * call site is pinned by text at the bottom because the composition root has no seam.
 */
describe("claimableWhere", () => {
	const now = new Date("2026-08-28T10:00:00.000Z");

	it("admits only an unclaimed row or one whose lease is a full window stale", () => {
		expect(claimableWhere("job-1", ["QUEUED", "RUNNING"], now)).toEqual({
			id: "job-1",
			status: { in: ["QUEUED", "RUNNING"] },
			OR: [
				{ attemptClaimedAt: null },
				{
					attemptClaimedAt: {
						lt: new Date(now.getTime() - ATTEMPT_LEASE_MS),
					},
				},
			],
		});
	});

	it("keeps the caller's status list — the claim admits AWAITING_QC, the failed handler does not", () => {
		expect(
			claimableWhere("job-1", ["QUEUED", "RUNNING", "AWAITING_QC"], now).status,
		).toEqual({ in: ["QUEUED", "RUNNING", "AWAITING_QC"] });
	});

	it("the failed handler in index.ts uses it (pinned by text — the root has no seam)", () => {
		const source = readFileSync(
			new URL("../index.ts", import.meta.url),
			"utf8",
		);
		const handler = source.slice(
			source.indexOf('worker.on("failed"'),
			source.indexOf("// Same wedge prevention for live channels"),
		);
		expect(handler).toMatch(
			/where: claimableWhere\(\s*encodingJobId,\s*\["QUEUED", "RUNNING"\],/,
		);
		expect(handler).not.toMatch(/where:\s*\{\s*id: encodingJobId,\s*status:/);
	});
});
