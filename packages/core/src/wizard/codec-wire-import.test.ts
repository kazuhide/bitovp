import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { encodingPlanSchema } from "../plan/schema";
import { buildPlan } from "./build-plan";
import { tryImportPresetIntoWizard } from "./plan-to-wizard";

describe("VOD form import of API codec values", () => {
	it.each([
		["H264", { level: "4.1" }, { level: "L4_1" }],
		["H265", { level: "4.1" }, { level: "L4_1" }],
		[
			"H265",
			{ maxCtuSize: "64", tuIntraDepth: "2" },
			{ maxCtuSize: "S64", tuIntraDepth: "D2" },
		],
		["AAC", { channelLayout: "4.0" }, { channelLayout: "CL_4_0" }],
	] as const)("normalizes %s wire values in editable state and preserves the plan", (codec, patch, expected) => {
		const raw = JSON.parse(
			readFileSync(
				join(
					__dirname,
					"../plan/__fixtures__/fixed-bitrate-hls-on-aws.plan.json",
				),
				"utf8",
			),
		);
		raw.inputs[0].credentialId = "33333333-3333-4333-8333-333333333333";
		raw.outputs[0].credentialId = "44444444-4444-4444-8444-444444444444";
		if (codec === "H265")
			for (const rendition of raw.renditions)
				if (rendition.codec === "H264") rendition.codec = "H265";
		const target = raw.renditions.find(
			(rendition: { codec: string }) => rendition.codec === codec,
		);
		Object.assign(target, patch);
		const before = structuredClone(raw);
		const result = tryImportPresetIntoWizard(raw);
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("Expected an editable fixture");
		if (codec === "AAC") expect(result.state.audios[0]).toMatchObject(expected);
		else
			expect(
				result.state.videos[0]?.[codec === "H264" ? "h264" : "h265"],
			).toMatchObject(expected);
		expect(encodingPlanSchema.parse(buildPlan(result.state))).toEqual(
			encodingPlanSchema.parse(raw),
		);
		expect(raw).toEqual(before);
	});
});
