import { describe, expect, it } from "vitest";
import { DELIVERY_SPECS } from "./delivery-presets";
import { inspectSavedPlanCompatibility } from "./saved-plan-compatibility";

function legacyMezzanine(index = 0) {
	const spec = DELIVERY_SPECS[index];
	if (!spec) throw new Error("Missing mezzanine fixture");
	const plan = structuredClone(spec.plan);
	const audio = plan.renditions[1];
	const video = plan.muxings[0];
	if (!audio || !video || video.kind !== "MP4")
		throw new Error("Missing mezzanine MP4 tracks");
	audio.key = "a320";
	plan.muxings = [
		{
			...video,
			key: "mezzV",
			additionalStreamKeys: undefined,
			filename: "video.mp4",
		},
		{
			...video,
			key: "mezzA",
			streamKey: "a320",
			additionalStreamKeys: undefined,
			filename: "audio.mp4",
		},
	];
	plan.delivery = { specId: spec.id, onDeviation: "REFUSE" };
	return plan;
}

describe("saved plan upgrade compatibility", () => {
	it.each([
		0, 1,
	])("identifies a v1.2.1 split mezzanine template before submission (%i)", (index) => {
		const plan = legacyMezzanine(index);
		const original = JSON.stringify(plan);
		const result = inspectSavedPlanCompatibility(plan);
		expect(result.blocking).toBe(true);
		expect(result.issues).toContainEqual({
			code: "PLAN_DELIVERY_DEVIATION",
			level: "error",
			path: "muxings.0.additionalStreamKeys",
		});
		expect(result.action).toBe("RELOAD_DELIVERY_PRESET_AND_RESAVE");
		expect(JSON.stringify(plan)).toBe(original);
	});

	it("keeps explicit WARN commitments advisory", () => {
		const plan = legacyMezzanine();
		if (!plan.delivery) throw new Error("Missing commitment");
		plan.delivery.onDeviation = "WARN";
		const result = inspectSavedPlanCompatibility(plan);
		expect(result.blocking).toBe(false);
		expect(
			result.issues.some(
				(issue) =>
					issue.code === "PLAN_DELIVERY_DEVIATION" && issue.level === "warning",
			),
		).toBe(true);
	});

	it.each(DELIVERY_SPECS)("accepts the current $id preset", (spec) => {
		expect(
			inspectSavedPlanCompatibility({
				...spec.plan,
				delivery: { specId: spec.id, onDeviation: "REFUSE" },
			}).blocking,
		).toBe(false);
	});

	it("does not turn malformed saved plans into a clean preflight", () => {
		const result = inspectSavedPlanCompatibility({ planVersion: 999 });
		expect(result.blocking).toBe(true);
		expect(result.issues[0]?.code).toBe("PLAN_PARSE");
	});

	it("reports structural submission errors even without a delivery commitment", () => {
		const plan = legacyMezzanine();
		delete plan.delivery;
		const [video, audio] = plan.muxings;
		if (!video || !audio || video.kind !== "MP4" || audio.kind !== "MP4")
			throw new Error("Missing mezzanine MP4 muxings");
		audio.filename = video.filename;
		expect(inspectSavedPlanCompatibility(plan).blocking).toBe(true);
	});

	it("never includes plan data or provider locations in its diagnostics", () => {
		const plan = legacyMezzanine();
		plan.name = "private-name";
		const input = plan.inputs[0];
		if (!input) throw new Error("Missing input");
		input.name = "private-location";
		const result = JSON.stringify(inspectSavedPlanCompatibility(plan));
		expect(result).not.toContain("private-");
		expect(result).not.toContain("sample-input-bucket");
	});
});
