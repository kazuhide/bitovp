import { describe, expect, it } from "vitest";
import { encodingPlanSchema } from "./schema";
import { loadPlan } from "./test-support";
import { validatePlan } from "./validate";

function visionPlan() {
	const base = loadPlan("av1-fmp4-dash-hls");
	return encodingPlanSchema.parse({
		...base,
		dolbyStreams: [
			{
				key: "vision",
				kind: "VISION",
				inputKey: base.inputs[0]?.key,
				videoInputPath: "source.mxf",
				metadataInputPath: "metadata.xml",
			},
		],
		renditions: base.renditions.map((r) =>
			r.codec === "AV1"
				? {
						...r,
						ingestKey: "vision",
						dynamicRangeFormat: "DOLBY_VISION_PROFILE_10_0",
					}
				: r,
		),
	});
}

const conflicts = (plan: ReturnType<typeof visionPlan>) =>
	validatePlan(plan).filter(
		(issue) => issue.code === "PLAN_DOLBY_VISION_FORMAT_CONFLICT",
	);

describe("Dolby Vision conversion formats", () => {
	it.each([
		"DOLBY_VISION_PROFILE_10_1",
		"HDR10",
		"SDR",
	] as const)("rejects %s beside Profile 10.0 from the same input and encoding", (format) => {
		const plan = visionPlan();
		const second = plan.renditions[1];
		if (second?.codec !== "AV1") throw new Error("Missing AV1 fixture");
		second.dynamicRangeFormat = format;
		expect(conflicts(plan)).toEqual([
			expect.objectContaining({
				level: "error",
				path: "renditions[1].dynamicRangeFormat",
				message: expect.stringContaining("separate encoding"),
			}),
		]);
	});

	it("rejects different H265 conversions of the same Dolby Vision input", () => {
		const plan = encodingPlanSchema.parse({
			...visionPlan(),
			renditions: visionPlan().renditions.map((r, i) =>
				r.codec === "AV1"
					? {
							key: r.key,
							codec: "H265",
							ingestKey: r.ingestKey,
							height: r.height,
							bitrate: r.bitrate,
							dynamicRangeFormat: i === 0 ? "DOLBY_VISION_PROFILE_5" : "HDR10",
						}
					: r,
			),
		});
		expect(conflicts(plan)).toHaveLength(1);
	});

	it("follows nested trims back to their shared Dolby Vision input", () => {
		const plan = visionPlan();
		plan.trimmingStreams.push(
			{ key: "clip", kind: "TIME_BASED", sourceKey: "vision", offset: 0 },
			{ key: "nested", kind: "TIME_BASED", sourceKey: "clip", offset: 0 },
		);
		const second = plan.renditions[1];
		if (second?.codec !== "AV1") throw new Error("Missing AV1 fixture");
		second.ingestKey = "nested";
		second.dynamicRangeFormat = "DOLBY_VISION_PROFILE_10_1";
		expect(conflicts(plan)).toHaveLength(1);
	});

	it("finds a shared Dolby Vision ancestor inside a concatenation", () => {
		const plan = visionPlan();
		const source = plan.dolbyStreams[0];
		const second = plan.renditions[1];
		if (!source || second?.codec !== "AV1") throw new Error("Missing fixture");
		plan.dolbyStreams.push({ ...source, key: "other-vision" });
		plan.concatenationStreams.push({
			key: "joined",
			sources: [
				{ sourceKey: "other-vision", isMain: true },
				{ sourceKey: "vision" },
			],
		});
		second.ingestKey = "joined";
		second.dynamicRangeFormat = "DOLBY_VISION_PROFILE_10_1";
		expect(conflicts(plan)).toHaveLength(1);
	});

	it("keeps multiple resolutions of one explicit format", () => {
		expect(
			validatePlan(visionPlan()).filter((issue) => issue.level === "error"),
		).toEqual([]);
	});

	it("does not infer an unset format", () => {
		const plan = visionPlan();
		const second = plan.renditions[1];
		if (second?.codec !== "AV1") throw new Error("Missing AV1 fixture");
		delete second.dynamicRangeFormat;
		expect(conflicts(plan)).toEqual([]);
	});

	it("keeps different formats from independently owned Dolby Vision inputs", () => {
		const plan = visionPlan();
		const source = plan.dolbyStreams[0];
		const second = plan.renditions[1];
		if (!source || second?.codec !== "AV1") throw new Error("Missing fixture");
		plan.dolbyStreams.push({ ...source, key: "other-vision" });
		second.ingestKey = "other-vision";
		second.dynamicRangeFormat = "DOLBY_VISION_PROFILE_10_1";
		expect(
			validatePlan(plan).filter((issue) => issue.level === "error"),
		).toEqual([]);
	});

	it("keeps different formats in separate encoding partitions", () => {
		const base = visionPlan();
		const source = base.dolbyStreams[0];
		if (!source) throw new Error("Missing Dolby Vision fixture");
		const plan = encodingPlanSchema.parse({
			...base,
			encodings: [
				{ key: "first", name: "First" },
				{ key: "second", name: "Second" },
			],
			ingest: base.ingest.map((r) => ({ ...r, encodingKey: "first" })),
			dolbyStreams: [
				{ ...source, key: "vision-first", encodingKey: "first" },
				{ ...source, key: "vision-second", encodingKey: "second" },
			],
			renditions: base.renditions.map((r, i) =>
				r.codec === "AV1"
					? {
							...r,
							encodingKey: i === 0 ? "first" : "second",
							ingestKey: i === 0 ? "vision-first" : "vision-second",
							dynamicRangeFormat:
								i === 0
									? "DOLBY_VISION_PROFILE_10_0"
									: "DOLBY_VISION_PROFILE_10_1",
						}
					: { ...r, encodingKey: "first" },
			),
			generation: { ...base.generation, timing: "POST_ENCODING" },
		});
		expect(
			validatePlan(plan).filter((issue) => issue.level === "error"),
		).toEqual([]);
	});

	it("does not apply the Dolby Vision source restriction to regular AV1 inputs", () => {
		const plan = loadPlan("av1-fmp4-dash-hls");
		const first = plan.renditions[0];
		const second = plan.renditions[1];
		if (first?.codec !== "AV1" || second?.codec !== "AV1")
			throw new Error("Missing AV1 fixture");
		first.dynamicRangeFormat = "SDR";
		second.dynamicRangeFormat = "HDR10";
		expect(conflicts(plan)).toEqual([]);
	});
});
