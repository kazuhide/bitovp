import { describe, expect, it } from "vitest";
import {
	DEFAULT_FEATURE_FLAGS,
	featureFlagsPatchSchema,
	featureFlagsSchema,
	parseFeatureFlags,
} from "./feature-flags";

/**
 * : the defaults live in CODE, so an absent row, an empty object
 * and a malformed row are all the same state — that is what makes a fresh
 * install and a deleted row identical, with no seed step.
 */
describe("feature flags (ledger #131)", () => {
	it("defaults QC/VMAF to OFF — the owner's requested default", () => {
		expect(DEFAULT_FEATURE_FLAGS.qcVmaf).toBe(false);
		expect(featureFlagsSchema.parse({}).qcVmaf).toBe(false);
	});

	it("absent, empty and malformed values all read as the defaults", () => {
		for (const value of [
			undefined,
			null,
			{},
			{ qcVmaf: "yes" },
			"not an object",
			42,
			[],
		]) {
			expect(parseFeatureFlags(value)).toEqual(DEFAULT_FEATURE_FLAGS);
		}
	});

	it("an explicit true survives, and unknown keys are dropped rather than rejected", () => {
		expect(parseFeatureFlags({ qcVmaf: true })).toEqual({ qcVmaf: true });
		// A flag written by a NEWER build must not make this build fall back to
		// defaults — that would silently turn QC off on a rollback.
		expect(parseFeatureFlags({ qcVmaf: true, somethingLater: 3 })).toEqual({
			qcVmaf: true,
		});
	});
});

describe("the patch schema (review-265 131-A6)", () => {
	it("describes the SAME flags as the full schema — adding one to either alone fails here", () => {
		expect(Object.keys(featureFlagsPatchSchema.shape).sort()).toEqual(
			Object.keys(featureFlagsSchema.shape).sort(),
		);
	});

	it("leaves an absent flag ABSENT, so a merge cannot silently reset it", () => {
		// featureFlagsSchema.partial returns { qcVmaf: false } here — the
		// defect this schema exists to avoid.
		expect(featureFlagsPatchSchema.parse({})).toEqual({});
		expect(featureFlagsPatchSchema.parse({ qcVmaf: true })).toEqual({
			qcVmaf: true,
		});
	});
});
