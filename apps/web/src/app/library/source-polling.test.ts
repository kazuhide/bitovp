import { expect, it } from "vitest";
import { sourcePollingInterval } from "./source-polling";

it("continues polling across worker ERROR retries and stops only once READY", () => {
	expect(
		(["PENDING", "RUNNING", "ERROR", "RUNNING", "READY"] as const).map(
			sourcePollingInterval,
		),
	).toEqual([2000, 2000, 10000, 2000, false]);
	expect(sourcePollingInterval(undefined)).toBe(false);
});
