import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compileLiveRunStepLog } from "../live/run-rebase";
import { liveChannelPlanSchema } from "../live/schema";
import { validateLiveChannel } from "../live/validate";
import { AKAMAI_MSL_VERSION_BEHAVIOR } from "./akamai-msl-constraint";
import { MslEncoderVersionError } from "./msl-encoder-version";

function plan(version: string, mslVersion = "MSL5") {
	const raw = JSON.parse(
		readFileSync(
			join(__dirname, "../live/__fixtures__/live-akamai-msl5.plan.json"),
			"utf8",
		),
	);
	raw.bitmovin.encoderVersion = version;
	raw.outputs[0].mslVersion = mslVersion;
	return liveChannelPlanSchema.parse(raw);
}
function issues(version: string, mslVersion = "MSL5") {
	return validateLiveChannel(plan(version, mslVersion)).filter(
		(i) => i.code === "MSL_ENCODER_VERSION",
	);
}

describe("MSL encoder minimum at the Live validation door", () => {
	it.each([
		"2.9.0",
		"2.281.0",
		"2.282.99",
		"1.999.999",
	])("rejects old fixed %s", (version) => {
		expect(issues(version)).toEqual([
			expect.objectContaining({
				level: "error",
				path: "bitmovin.encoderVersion",
			}),
		]);
	});
	it.each([
		"2.283.0",
		"2.284.0",
		"2.1000.0",
		"3.0.0",
	])("accepts fixed %s", (version) => {
		expect(issues(version)).toEqual([]);
	});
	it.each([
		"STABLE",
		"BETA",
		"LTS",
		"2.283.0-beta",
		"unknown",
	])("warns without pretending to resolve %s", (version) => {
		expect(issues(version)).toEqual([
			expect.objectContaining({
				level: "warning",
				message: expect.stringContaining("Pin"),
			}),
		]);
	});
	it.each([
		"2.9.0",
		"STABLE",
		"BETA",
	])("leaves MSL4 %s unchanged", (version) => {
		expect(issues(version, "MSL4")).toEqual([]);
	});
	it.each([
		1, 2, 3,
	])("rejects old saved plans before compiling run seq %s", (seq) => {
		expect(() =>
			compileLiveRunStepLog(plan("2.281.0"), { seq, runId: "run-new" }),
		).toThrow("2.283.0");
		expect(() =>
			compileLiveRunStepLog(plan("2.281.0"), { seq, runId: "run-new" }),
		).toThrow(MslEncoderVersionError);
	});
	it.each(["2.283.0", "BETA"])("continues compilation for %s", (version) => {
		expect(
			compileLiveRunStepLog(plan(version), { seq: 2, runId: "run-new" }).entries
				.length,
		).toBeGreaterThan(0);
	});
	it("derives the floor from the canonical version record", () => {
		const behavior = AKAMAI_MSL_VERSION_BEHAVIOR.MSL5 as unknown as {
			minEncoderVersion: [number, number, number];
		};
		const original = behavior.minEncoderVersion;
		try {
			behavior.minEncoderVersion = [2, 285, 0];
			expect(issues("2.284.0")[0]?.level).toBe("error");
		} finally {
			behavior.minEncoderVersion = original;
		}
	});
});
