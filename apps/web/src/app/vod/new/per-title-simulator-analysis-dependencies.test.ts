import {
	type PerTitleCodec,
	type PerTitleGoal,
	type PerTitleProposal,
	recommendPerTitleSettings,
} from "@bitovp/core";
import { describe, expect, it } from "vitest";
import {
	assessPerTitleDependencies,
	type PerTitleDependencyAssessment,
} from "./per-title-simulator-analysis-dependencies";
import {
	perTitleGlobalFields,
	perTitleStreamFields,
} from "./per-title-simulator-tuning";

const rule = "fixedResolutionAndBitrateConfiguration.";
const count = `${rule}forcedRenditionAboveHighestFixedRepresentation`;
const factor = `${count}Factor`;
const mode = `${count}CalculationMode`;
const threshold = "autoRepresentations.adoptConfigurationThreshold";
const commonGlobalKeys = [
	"minBitrate",
	"maxBitrate",
	"minBitrateStepSize",
	"maxBitrateStepSize",
	"complexityFactor",
	"resolutionScaleFactor",
	"autoRepresentations",
	threshold,
	count,
	factor,
	mode,
];
const commonStreamKeys = [
	"minBitrate",
	"maxBitrate",
	"bitrateSelectionMode",
	"lowComplexityBoundaryForMaxBitrate",
	"highComplexityBoundaryForMaxBitrate",
];
const goalFor = (codec: PerTitleCodec = "H264"): PerTitleGoal => ({
	strategy: "fixed-ranges",
	codec,
	minBitrate: 200_000,
	maxBitrate: 6_000_000,
	minBitrateStepSize: 1.5,
	maxBitrateStepSize: 1.9,
	countPolicy: { kind: "unrestricted" },
	rows: [
		{ id: "fixed", height: 720, minBitrate: 1_000_000, maxBitrate: 3_000_000 },
	],
});

function proposalFor(goal: PerTitleGoal): PerTitleProposal {
	return {
		id: "baseline",
		codec: goal.codec,
		status: "candidate",
		applicable: true,
		evidence: "model-only",
		countGuarantee: false,
		api: {
			global: {
				minBitrate: goal.minBitrate,
				maxBitrate: goal.maxBitrate,
				minBitrateStepSize: goal.minBitrateStepSize ?? 1.5,
				maxBitrateStepSize: goal.maxBitrateStepSize ?? 1.9,
			},
			streams: (goal.rows ?? []).map(({ id, height, width, ...settings }) => ({
				rowId: id,
				height,
				width,
				mode: "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE",
				perTitleSettings: settings,
			})),
		},
		scenarios: [],
		diagnostics: [],
	};
}

function find(
	entries: PerTitleDependencyAssessment[],
	key: string,
	rowId?: string,
): PerTitleDependencyAssessment {
	const entry = entries.find(
		(item) => item.key === key && item.rowId === rowId,
	);
	if (!entry) throw new Error(`Missing dependency ${rowId ?? "global"}:${key}`);
	return entry;
}

function requiredStream(
	proposal: PerTitleProposal,
	rowId = "fixed",
): PerTitleProposal["api"]["streams"][number] {
	const stream = proposal.api.streams.find((item) => item.rowId === rowId);
	if (!stream) throw new Error(`Missing fixture stream ${rowId}`);
	return stream;
}

describe("current Per-Title parameter dependencies", () => {
	it.each([
		"H264",
		"H265",
		"H265V2",
		"VP9",
		"AV1",
	] as const)("covers the pinned SDK fields and every control for %s", (codec) => {
		const goal = goalFor(codec);
		const entries = assessPerTitleDependencies(goal, proposalFor(goal));
		const codecKeys = [
			codec === "H265V2" ? "targetQualityQp" : "targetQualityCrf",
			...(["H264", "H265", "H265V2"].includes(codec)
				? ["codecMinBitrateFactor", "codecMaxBitrateFactor"]
				: []),
			...(["H264", "H265"].includes(codec) ? ["codecBufsizeFactor"] : []),
		];
		const expectedGlobal = [...commonGlobalKeys, ...codecKeys].sort();
		const expectedStream = [
			...commonStreamKeys,
			...(["H264", "H265"].includes(codec)
				? ["codecMaxBitrateFactor", "codecBufsizeFactor"]
				: []),
		].sort();
		expect(
			entries
				.filter((item) => item.scope === "global")
				.map((item) => item.key)
				.sort(),
		).toEqual(expectedGlobal);
		expect(
			entries
				.filter((item) => item.rowId === "fixed")
				.map((item) => item.key)
				.sort(),
		).toEqual(expectedStream);
		expect(
			perTitleGlobalFields(codec)
				.map((item) => item.key)
				.sort(),
		).toEqual(expectedGlobal);
		expect(
			perTitleStreamFields(codec)
				.map((item) => item.key)
				.sort(),
		).toEqual(expectedStream);
		for (const entry of entries) {
			expect(entry.explanation.en.length).toBeGreaterThan(20);
			expect(entry.explanation.ja.length).toBeGreaterThan(10);
			expect(entry.sourceUrl).toMatch(
				/^https:\/\/github\.com\/bitmovin\/bitmovin-api-sdk-javascript\/blob\/v1\.285\.0\/src\/models\//,
			);
		}
	});

	it("includes API-only templates and raw automatic rows whose settings were omitted", () => {
		const goal: PerTitleGoal = {
			...goalFor(),
			automaticTemplates: [{ id: "raw", height: 480, minBitrate: 500_000 }],
		};
		const proposal = proposalFor(goal);
		proposal.api.streams.push({
			rowId: "generated",
			mode: "PER_TITLE_TEMPLATE",
		});
		const entries = assessPerTitleDependencies(goal, proposal);
		expect(find(entries, "minBitrate", "raw")).toMatchObject({
			value: 500_000,
			status: "inactive",
		});
		expect(find(entries, "maxBitrate", "generated").status).toBe("inactive");
		expect(
			new Set(
				entries
					.filter((item) => item.scope === "stream")
					.map((item) => item.rowId),
			),
		).toEqual(new Set(["fixed", "raw", "generated"]));
		expect(
			new Set(
				entries.map((item) => `${item.scope}:${item.rowId ?? ""}:${item.key}`),
			).size,
		).toBe(entries.length);
	});

	it("uses emitted values while retaining parked zero and false settings without mutation", () => {
		const goal: PerTitleGoal = {
			...goalFor(),
			resolutionScaleFactor: 0,
			autoRepresentations: false,
			adjustments: { inactiveAutoRepresentationThreshold: 0 },
		};
		const proposal = proposalFor(goal);
		proposal.api.global.minBitrateStepSize = 1.7;
		const snapshot = structuredClone({ goal, proposal });
		const entries = assessPerTitleDependencies(goal, proposal);
		expect(find(entries, "minBitrateStepSize").value).toBe(1.7);
		expect(find(entries, "resolutionScaleFactor").value).toBe(0);
		expect(find(entries, "autoRepresentations").value).toBe(false);
		expect(find(entries, threshold)).toMatchObject({
			value: 0,
			status: "inactive",
		});
		expect({ goal, proposal }).toEqual(snapshot);
	});

	it("requires the fixed bitrate mode, both bounds and COMPLEXITY_RANGE for boundary effects", () => {
		const goal = goalFor();
		const proposal = proposalFor(goal);
		const stream = requiredStream(proposal);
		stream.perTitleSettings = {
			minBitrate: 1_000_000,
			bitrateSelectionMode: "COMPLEXITY_RANGE",
			lowComplexityBoundaryForMaxBitrate: 2_000_000,
			highComplexityBoundaryForMaxBitrate: 6_000_000,
		};
		expect(
			find(
				assessPerTitleDependencies(goal, proposal),
				"lowComplexityBoundaryForMaxBitrate",
				"fixed",
			).status,
		).toBe("inactive");
		stream.perTitleSettings.maxBitrate = 3_000_000;
		expect(
			find(
				assessPerTitleDependencies(goal, proposal),
				"lowComplexityBoundaryForMaxBitrate",
				"fixed",
			).status,
		).toBe("media-dependent");
		stream.perTitleSettings.bitrateSelectionMode = "OPTIMIZED";
		expect(
			find(
				assessPerTitleDependencies(goal, proposal),
				"highComplexityBoundaryForMaxBitrate",
				"fixed",
			).status,
		).toBe("inactive");
		stream.mode = "PER_TITLE_TEMPLATE_FIXED_RESOLUTION";
		expect(
			find(assessPerTitleDependencies(goal, proposal), "minBitrate", "fixed")
				.status,
		).toBe("inactive");
	});

	it("marks H264 minimum factor as ineffective and H265V2 minimum factor as unverified", () => {
		for (const [codec, status] of [
			["H264", "no-effect"],
			["H265", "active"],
			["H265V2", "unverified"],
		] as const) {
			const goal = { ...goalFor(codec), codecMinBitrateFactor: 0.5 };
			expect(
				find(
					assessPerTitleDependencies(goal, proposalFor(goal)),
					"codecMinBitrateFactor",
				).status,
			).toBe(status);
		}
	});

	it("does not invent a per-stream minimum-factor override", () => {
		const goal = { ...goalFor("H265"), codecMinBitrateFactor: 0.5 };
		const minimum = find(
			assessPerTitleDependencies(goal, proposalFor(goal)),
			"codecMinBitrateFactor",
		);
		expect(minimum.dependencies).not.toContain("stream.codecMinBitrateFactor");
		expect(minimum.explanation.en).not.toMatch(/stream override/i);
	});

	it("reports a stream override and keeps a global fallback active for other streams", () => {
		const goal = {
			...goalFor(),
			codecMaxBitrateFactor: 2,
			codecBufsizeFactor: 4,
		};
		const proposal = proposalFor(goal);
		requiredStream(proposal).perTitleSettings = {
			codecMaxBitrateFactor: 1.5,
			codecBufsizeFactor: 3,
		};
		let entries = assessPerTitleDependencies(goal, proposal);
		expect(find(entries, "codecMaxBitrateFactor").status).toBe("inactive");
		expect(
			find(entries, "codecMaxBitrateFactor", "fixed").explanation.en,
		).toMatch(/override/i);
		proposal.api.streams.push({
			rowId: "fallback",
			mode: "PER_TITLE_TEMPLATE",
		});
		entries = assessPerTitleDependencies(goal, proposal);
		expect(find(entries, "codecMaxBitrateFactor").status).toBe("active");
		expect(find(entries, "codecMaxBitrateFactor").explanation.en).toMatch(
			/1.*2|2.*1/,
		);
		expect(
			find(entries, "codecMaxBitrateFactor", "fixed").dependencies,
		).toContain("global.codecMaxBitrateFactor");
	});

	it("retains imported factors whose codec effect is not supported by these controls", () => {
		const goal: PerTitleGoal = {
			...goalFor("AV1"),
			codecMaxBitrateFactor: 2,
			rows: [{ id: "fixed", height: 720, codecBufsizeFactor: 4 }],
		};
		const entries = assessPerTitleDependencies(goal, proposalFor(goal));
		expect(find(entries, "codecMaxBitrateFactor")).toMatchObject({
			value: 2,
			status: "unverified",
		});
		expect(find(entries, "codecBufsizeFactor", "fixed")).toMatchObject({
			value: 4,
			status: "unverified",
		});
	});

	it("does not let unsupported stream factors disable the H265V2 global fallback", () => {
		const goal = { ...goalFor("H265V2"), codecMaxBitrateFactor: 2 };
		const proposal = proposalFor(goal);
		requiredStream(proposal).perTitleSettings = { codecMaxBitrateFactor: 1.5 };
		const entries = assessPerTitleDependencies(goal, proposal);
		expect(find(entries, "codecMaxBitrateFactor").status).toBe("active");
		expect(find(entries, "codecMaxBitrateFactor", "fixed").status).toBe(
			"unverified",
		);
	});

	it("marks raw stream factors inactive when the stream was not emitted", () => {
		const goal: PerTitleGoal = {
			...goalFor(),
			automaticTemplates: [{ id: "parked", codecMaxBitrateFactor: 1.5 }],
		};
		const entry = find(
			assessPerTitleDependencies(goal, proposalFor(goal)),
			"codecMaxBitrateFactor",
			"parked",
		);
		expect(entry).toMatchObject({ value: 1.5, status: "inactive" });
	});

	it("does not invent optional defaults or a universal AV1 target quality", () => {
		const goal = goalFor("AV1");
		const entries = assessPerTitleDependencies(goal, proposalFor(goal));
		expect(find(entries, "targetQualityCrf")).toMatchObject({
			value: undefined,
			status: "unset",
		});
		expect(find(entries, "targetQualityCrf").explanation.en).toMatch(
			/frame rate.*resolution.*dynamic range|resolution.*frame rate.*dynamic range/i,
		);
		expect(find(entries, "autoRepresentations")).toMatchObject({
			value: undefined,
			status: "unset",
		});
		expect(find(entries, "complexityFactor").value).toBeUndefined();
		expect(find(entries, factor).value).toBeUndefined();
	});

	it("distinguishes content calibration from spacing and codec rate-control arithmetic", () => {
		const goal = {
			...goalFor(),
			targetQualityCrf: 22,
			complexityFactor: 1.1,
			resolutionScaleFactor: 0.5,
			codecMaxBitrateFactor: 2,
		};
		const entries = assessPerTitleDependencies(goal, proposalFor(goal));
		for (const key of [
			"targetQualityCrf",
			"complexityFactor",
			"resolutionScaleFactor",
		])
			expect(find(entries, key).status).toBe("media-dependent");
		expect(find(entries, "maxBitrateStepSize").status).toBe("active");
		expect(find(entries, "codecMaxBitrateFactor").explanation.en).toMatch(
			/target.*factor/i,
		);
		expect(find(entries, "codecMaxBitrateFactor").explanation.en).toMatch(
			/measured/i,
		);
	});

	it("keeps forced additions conditional and disables factor and mode when count is zero", () => {
		const goal: PerTitleGoal = {
			...goalFor(),
			fixedResolutionAndBitrateConfiguration: {
				forcedRenditionAboveHighestFixedRepresentation: 1,
				forcedRenditionAboveHighestFixedRepresentationFactor: 1.5,
				forcedRenditionAboveHighestFixedRepresentationCalculationMode:
					"LAST_CALCULATED_BITRATE",
			},
		};
		let entries = assessPerTitleDependencies(goal, proposalFor(goal));
		expect(find(entries, count).status).toBe("media-dependent");
		expect(find(entries, factor).dependencies).toContain(count);
		expect(entries.some((entry) => /Below|belowLowest/.test(entry.key))).toBe(
			false,
		);
		const disabled: PerTitleGoal = {
			...goal,
			fixedResolutionAndBitrateConfiguration: {
				...goal.fixedResolutionAndBitrateConfiguration,
				forcedRenditionAboveHighestFixedRepresentation: 0,
			},
		};
		entries = assessPerTitleDependencies(disabled, proposalFor(disabled));
		expect(find(entries, factor).status).toBe("inactive");
		expect(find(entries, mode).status).toBe("inactive");
	});

	it("reports unusable calibration values without calling them active", () => {
		const goal = {
			...goalFor(),
			complexityFactor: Number.NaN,
			resolutionScaleFactor: 16,
		};
		const entries = assessPerTitleDependencies(goal, proposalFor(goal));
		expect(find(entries, "complexityFactor").status).toBe("unverified");
		expect(find(entries, "resolutionScaleFactor").status).toBe("unverified");
	});

	it("also covers real simulator proposals without asserting provider output or quality", () => {
		const goal = goalFor();
		const entries = assessPerTitleDependencies(
			goal,
			recommendPerTitleSettings(goal),
		);
		expect(find(entries, "maxBitrate").value).toBe(6_000_000);
		expect(find(entries, "maxBitrate").explanation.en).toMatch(
			/target|rendition/i,
		);
		expect(find(entries, "maxBitrate").explanation.en).toMatch(/measured/i);
	});
});
