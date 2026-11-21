import { expect, it } from "vitest";
import { readMeasurement } from "./receipt";

const identity = "4".repeat(64);
const receipt = {
	schemaVersion: 1,
	scoringProfileId: "official-vmaf-cuda-0.6.1",
	runtimeId: identity,
	scoreMilli: 94100,
	meanVmaf: 94.1,
	frameCount: 300,
	videoBytes: "4062500",
	durationTicks: "300",
	timeBase: { num: 1, den: 30 },
	encodeMs: 1400,
	scoreMs: 100,
};

it("accepts only a complete receipt from the requested runtime and frame window", () => {
	expect(readMeasurement(receipt, identity, 300)).toEqual(receipt);
	expect(() => readMeasurement(receipt, "9".repeat(64), 300)).toThrow();
	expect(() => readMeasurement(receipt, identity, 301)).toThrow();
	expect(() =>
		readMeasurement({ ...receipt, durationTicks: "299" }, identity, 300),
	).toThrow();
});
