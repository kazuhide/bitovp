import { describe, expect, it } from "vitest";
import { encodingProbeSummary } from "../../scripts/probe-encoding-summary";

describe("provider encoding probe conclusions", () => {
	it.each([
		"PROBE FAILED",
		"GONE (404)",
		"undefined",
		"UNRECOGNIZED",
	])("keeps %s unverified instead of reporting a safe deletion", (state) => {
		const summary = encodingProbeSummary(new Map([[state, 1]]));
		expect(summary).toMatch(/HOLD.*unverified/);
		expect(summary).not.toMatch(/safe to delete|nothing is live/i);
	});
	it("preserves uncertainty in a mixed terminal and failed result", () => {
		expect(
			encodingProbeSummary(
				new Map([
					["FINISHED", 2],
					["PROBE FAILED", 1],
				]),
			),
		).toMatch(/HOLD.*unverified/);
	});
	it("does not infer anything from an empty observation set", () => {
		expect(encodingProbeSummary(new Map())).toMatch(/HOLD.*unverified/);
	});
	it.each([
		"RUNNING",
		"QUEUED",
		"STARTING",
		"CREATED",
		"STOPPING",
	])("keeps non-terminal %s rows", (state) => {
		expect(encodingProbeSummary(new Map([[state, 1]]))).toMatch(
			/DO NOT DELETE.*1 /,
		);
	});
	it("reports only explicitly observed terminal states with a local-reference reminder", () => {
		const summary = encodingProbeSummary(
			new Map([
				["FINISHED", 2],
				["ERROR", 1],
				["CANCELED", 1],
				["STOPPED", 1],
			]),
		);
		expect(summary).toMatch(/reported terminal states/);
		expect(summary).toMatch(/local references/);
		expect(summary).not.toMatch(/safe to delete|nothing is live/i);
	});
});
