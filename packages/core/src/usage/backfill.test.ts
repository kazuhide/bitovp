import { describe, expect, it } from "vitest";
import { usageDateRangeSchema } from "./backfill";

describe("statistics historical date range", () => {
	it("accepts history older than the routine 90 day sweep", () => {
		expect(
			usageDateRangeSchema.safeParse({ from: "2013-01-01", to: "2020-12-31" })
				.success,
		).toBe(true);
	});
	it.each([
		{ from: "2024-02-30", to: "2024-03-01" },
		{ from: "2024-02-02", to: "2024-02-01" },
		{ from: "2012-12-31", to: "2024-01-01" },
		{ from: "2024-01-01", to: "9999-01-01" },
	])("rejects impossible, reversed, unsupported or future dates %o", (range) => {
		expect(usageDateRangeSchema.safeParse(range).success).toBe(false);
	});
});
