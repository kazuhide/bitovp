import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	compilePlan,
	encodingPlanSchema,
	INTERNAL_HEVC_V2_BCF_VERSION,
	type PerTitleGoal,
	type PerTitleProposal,
	proposePerTitleSettings,
	recommendPerTitleSettings,
	validatePlan,
} from "@bitovp/core";
import { describe, expect, it } from "vitest";
import {
	buildPlan,
	DEFAULT_WIZARD_STATE,
	videoKeys,
	type WizardState,
} from "./build-plan";
import {
	applyPerTitleProposal,
	perTitleGoalFromWizard,
} from "./per-title-simulator-wizard";
import { planToWizardState } from "./plan-to-wizard";

function required<T>(value: T | undefined | null): T {
	if (value === undefined || value === null)
		throw new Error("Missing test fixture value");
	return value;
}
function state(): WizardState {
	const s = structuredClone(DEFAULT_WIZARD_STATE);
	s.name = "simulator-test";
	s.inputFiles[0] = {
		...required(s.inputFiles[0]),
		credentialId: "00000000-0000-4000-8000-000000000001",
		bucket: "input-bucket",
		path: "clip.mp4",
	};
	s.output = {
		...s.output,
		credentialId: "00000000-0000-4000-8000-000000000002",
		bucket: "output-bucket",
		basePath: "simulation/",
	};
	return s;
}
function proposal(
	streams: PerTitleProposal["api"]["streams"],
	automatic = false,
): PerTitleProposal {
	return {
		codec: "H264",
		id: "baseline",
		status: "candidate",
		applicable: true,
		evidence: "model-only",
		countGuarantee: false,
		api: {
			global: {
				minBitrate: 100000,
				maxBitrate: 5000000,
				minBitrateStepSize: 1.5,
				maxBitrateStepSize: 4,
				...(automatic ? { autoRepresentations: {} } : {}),
			},
			streams,
		},
		scenarios: [],
		diagnostics: [],
	};
}
const fixed = (
	rowId: string,
	height: number,
): PerTitleProposal["api"]["streams"][number] => ({
	rowId,
	height,
	mode: "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE",
	perTitleSettings: {
		minBitrate: 300000,
		maxBitrate: 700000,
		bitrateSelectionMode: "COMPLEXITY_RANGE",
		lowComplexityBoundaryForMaxBitrate: 1000000,
		highComplexityBoundaryForMaxBitrate: 5000000,
	},
});
function compiled(s: WizardState) {
	const p = encodingPlanSchema.parse(buildPlan(s));
	expect(validatePlan(p).filter((i) => i.level === "error")).toEqual([]);
	return { plan: p, operations: compilePlan(p) };
}

describe("Per-Title wizard bridge", () => {
	it.each([
		"PER_TITLE_TEMPLATE",
		"PER_TITLE_TEMPLATE_FIXED_RESOLUTION",
	] as const)("refuses fixed-bitrate settings on a %s proposal", (mode) => {
		const before = state();
		const invalid = proposal([
			{
				...fixed("v360", 360),
				mode,
			},
		]);
		expect(() => applyPerTitleProposal(before, invalid, "H264")).toThrow(
			"The proposal is not an applicable candidate for this codec.",
		);
	});
	it("opens fresh and empty ladders without inferring a guaranteed count", () => {
		const before = structuredClone(DEFAULT_WIZARD_STATE);
		const goal = perTitleGoalFromWizard(before);
		expect(goal).toMatchObject({
			codec: "H264",
			strategy: "automatic",
			countPolicy: { kind: "unrestricted" },
		});
		expect(goal.maxBitrate).toBeGreaterThan(goal.minBitrate);
		expect(
			perTitleGoalFromWizard({ ...before, videos: [] }).countPolicy,
		).toEqual({ kind: "unrestricted" });
		expect(before).toEqual(DEFAULT_WIZARD_STATE);
	});
	it("keeps ordinary-template source metadata without using fixed-only bounds as global defaults", () => {
		const before = state();
		const inactive = {
			minBitrate: 850000,
			maxBitrate: 450000,
			bitrateSelectionMode: "COMPLEXITY_RANGE" as const,
			lowComplexityBoundaryForMaxBitrate: 1200000,
		};
		before.videos = [
			{
				height: 240,
				bitrate: null,
				extras: {
					key: "ordinary",
					mode: "PER_TITLE_TEMPLATE",
					perTitleSettings: inactive,
				},
			},
		];
		const clean = structuredClone(before);
		if (clean.videos[0]?.extras) delete clean.videos[0].extras.perTitleSettings;
		const fromSource = perTitleGoalFromWizard(before);
		const withoutMetadata = perTitleGoalFromWizard(clean);
		expect(fromSource.minBitrate).toBe(withoutMetadata.minBitrate);
		expect(fromSource.maxBitrate).toBe(withoutMetadata.maxBitrate);
		expect(fromSource.automaticTemplates).toEqual([
			{ id: "ordinary", height: 240, ...inactive },
		]);
		const result = recommendPerTitleSettings(fromSource);
		expect(result.api.streams).toEqual([
			{ rowId: "ordinary", height: 240, mode: "PER_TITLE_TEMPLATE" },
		]);
		expect(result.diagnostics).toContainEqual(
			expect.objectContaining({ code: "inactive-template-settings" }),
		);
		expect(before.videos[0]?.extras?.perTitleSettings).toEqual(inactive);
	});
	it("retains duplicate resolutions, row identities, bounds and explicit global settings", () => {
		const s = state();
		s.videos = [360, 360].map((height, i) => ({
			height,
			bitrate: null,
			extras: {
				key: `rung-${i}`,
				mode: "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE",
				perTitleSettings: {
					minBitrate: 200000 + i * 300000,
					maxBitrate: 400000 + i * 300000,
					bitrateSelectionMode: "COMPLEXITY_RANGE",
					lowComplexityBoundaryForMaxBitrate: 1000000,
					highComplexityBoundaryForMaxBitrate: 5000000,
				},
			},
		}));
		s.startOptions = {
			perTitle: {
				h264: {
					minBitrate: 128000,
					maxBitrate: 6000000,
					minBitrateStepSize: 1.2,
				},
			},
		};
		const goal = perTitleGoalFromWizard(s);
		expect(goal).toMatchObject({
			strategy: "fixed-ranges",
			minBitrate: 128000,
			maxBitrate: 6000000,
			minBitrateStepSize: 1.2,
		});
		expect(
			goal.rows?.map((r) => [r.id, r.height, r.minBitrate, r.maxBitrate]),
		).toEqual([
			["rung-0", 360, 200000, 400000],
			["rung-1", 360, 500000, 700000],
		]);
	});
	it.each([
		["H264", "h264"],
		["H265", "h265"],
		["H265V2", "h265"],
		["VP9", "vp9"],
		["AV1", "av1"],
	] as const)("retains %s additional-rendition rules and refuses an unmodelled apply", (codec, slot) => {
		const s = state();
		const configuration = {
			forcedRenditionAboveHighestFixedRepresentation: 2,
			forcedRenditionAboveHighestFixedRepresentationFactor: 1.25,
			forcedRenditionAboveHighestFixedRepresentationCalculationMode:
				"MINIMUM" as const,
		};
		s.videos = [
			{
				codec,
				height: 360,
				bitrate: null,
				extras: { key: "automatic", mode: "PER_TITLE_TEMPLATE" },
			},
		];
		s.startOptions = {
			perTitle: {
				[slot]: { minBitrate: 100000, maxBitrate: 5000000, ...configuration },
			},
		};
		const before = structuredClone(s);
		const goal = perTitleGoalFromWizard(s, codec);
		expect(goal.fixedResolutionAndBitrateConfiguration).toEqual(configuration);
		const proposed = recommendPerTitleSettings(goal);
		expect(proposed.api.global.fixedResolutionAndBitrateConfiguration).toEqual(
			configuration,
		);
		expect(proposed.applicable).toBe(false);
		expect(proposed.diagnostics).toContainEqual(
			expect.objectContaining({ code: "forced-count-unknown" }),
		);
		expect(() => applyPerTitleProposal(s, proposed, codec)).toThrow(
			"The proposal is not an applicable candidate for this codec.",
		);
		expect(s).toEqual(before);
	});
	it("keeps recommended additional renditions through the wizard and START_ENCODING", () => {
		const s = state();
		s.videos = [
			{ height: 240, minimum: 160000, maximum: 200000 },
			{ height: 480, minimum: 400000, maximum: 480000 },
			{ height: 720, minimum: 1000000, maximum: 1200000 },
		].map((row) => ({
			codec: "H264",
			height: row.height,
			bitrate: null,
			extras: {
				key: `required-${row.height}`,
				mode: "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE",
				perTitleSettings: { minBitrate: row.minimum, maxBitrate: row.maximum },
			},
		}));
		const quality = {
			targetQualityCrf: 21,
			complexityFactor: 1.1,
			codecMinBitrateFactor: 0.8,
			codecMaxBitrateFactor: 1.2,
			codecBufsizeFactor: 2,
		};
		s.startOptions = {
			perTitle: {
				h264: {
					...quality,
					minBitrate: 100000,
					maxBitrate: 2400000,
					forcedRenditionAboveHighestFixedRepresentation: 1,
					forcedRenditionAboveHighestFixedRepresentationFactor: 1.8,
					forcedRenditionAboveHighestFixedRepresentationCalculationMode:
						"MAXIMUM",
				},
			},
		};
		const before = structuredClone(s);
		const proposed = recommendPerTitleSettings({
			...perTitleGoalFromWizard(s),
			countPolicy: { kind: "exact", count: 5 },
		});
		expect(proposed.derivation?.method).toBe("joint-constraints");
		expect(proposed.derivation?.targetSatisfied).toBe(true);
		expect(proposed.applicable).toBe(true);
		const configuration = required(
			proposed.api.global.fixedResolutionAndBitrateConfiguration,
		);
		expect(configuration.forcedRenditionAboveHighestFixedRepresentation).toBe(
			2,
		);
		const next = applyPerTitleProposal(s, proposed, "H264");
		expect(next.startOptions?.perTitle?.h264).toMatchObject({
			...quality,
			...configuration,
		});
		expect(next.startOptions?.perTitle?.h264).not.toHaveProperty(
			"fixedResolutionAndBitrateConfiguration",
		);
		const { plan, operations } = compiled(next);
		expect(
			plan.perTitle?.h264Configuration?.fixedResolutionAndBitrateConfiguration,
		).toEqual(configuration);
		expect(
			operations.find((operation) => operation.kind === "START_ENCODING")
				?.payload.perTitle,
		).toMatchObject({
			h264Configuration: {
				...quality,
				fixedResolutionAndBitrateConfiguration: configuration,
			},
		});
		expect(
			perTitleGoalFromWizard(planToWizardState(plan))
				.fixedResolutionAndBitrateConfiguration,
		).toEqual(configuration);
		expect(s).toEqual(before);
	});
	it.each([
		{ forcedRenditionAboveHighestFixedRepresentation: 0 },
		{ forcedRenditionAboveHighestFixedRepresentationFactor: 1.75 },
		{
			forcedRenditionAboveHighestFixedRepresentationCalculationMode:
				"MAXIMUM" as const,
		},
	])("preserves explicit zero and partial additional-rendition settings: %j", (configuration) => {
		const s = state();
		s.startOptions = { perTitle: { h264: configuration } };
		const source = buildPlan(s);
		const imported = planToWizardState(source);
		const goal = perTitleGoalFromWizard(imported, "H264");
		expect(goal.fixedResolutionAndBitrateConfiguration).toEqual(configuration);
		expect(buildPlan(imported).perTitle?.h264Configuration).toMatchObject({
			fixedResolutionAndBitrateConfiguration: configuration,
		});
	});
	it.each([
		undefined,
		{},
		{
			forcedRenditionAboveHighestFixedRepresentation: undefined,
			forcedRenditionAboveHighestFixedRepresentationFactor: undefined,
			forcedRenditionAboveHighestFixedRepresentationCalculationMode: undefined,
		},
	])("does not invent an additional-rendition rule for absent fields: %j", (global) => {
		const s = state();
		s.startOptions = { perTitle: { h264: global } };
		expect(perTitleGoalFromWizard(s)).not.toHaveProperty(
			"fixedResolutionAndBitrateConfiguration",
		);
	});
	it("keeps an empty imported additional-rendition block equivalent to omitted settings", () => {
		const source = buildPlan(state());
		source.perTitle = {
			h264Configuration: { fixedResolutionAndBitrateConfiguration: {} },
		};
		const imported = planToWizardState(source);
		expect(perTitleGoalFromWizard(imported)).not.toHaveProperty(
			"fixedResolutionAndBitrateConfiguration",
		);
	});
	it.each([
		true,
		false,
	])("recognizes fixed and partially required resolution ladders (%s)", (allFixed) => {
		const s = state();
		s.videos = [
			{
				height: 360,
				bitrate: null,
				extras: { mode: "PER_TITLE_TEMPLATE_FIXED_RESOLUTION" },
			},
			{
				height: 720,
				bitrate: null,
				extras: {
					mode: allFixed
						? "PER_TITLE_TEMPLATE_FIXED_RESOLUTION"
						: "PER_TITLE_TEMPLATE",
				},
			},
		];
		expect(perTitleGoalFromWizard(s).strategy).toBe(
			allFixed ? "fixed-resolutions" : "required-resolutions",
		);
	});
	it("applies an automatic proposal to a fresh wizard through validated plan and START", () => {
		const s = state();
		const before = structuredClone(s);
		const next = applyPerTitleProposal(
			s,
			proposal(
				[
					{
						rowId: required(videoKeys(s.videos)[0]),
						height: 360,
						mode: "PER_TITLE_TEMPLATE",
					},
				],
				true,
			),
			"H264",
		);
		const { plan, operations } = compiled(next);
		expect(plan.generation.timing).toBe("POST_ENCODING");
		expect(plan.renditions.find((r) => r.codec === "H264")).toMatchObject({
			key: "v360",
			bitrate: null,
			mode: "PER_TITLE_TEMPLATE",
		});
		expect(
			operations.find((o) => o.kind === "START_ENCODING")?.payload.perTitle,
		).toMatchObject({
			h264Configuration: {
				minBitrate: 100000,
				maxBitrate: 5000000,
				minBitrateStepSize: 1.5,
				maxBitrateStepSize: 4,
				autoRepresentations: {},
			},
		});
		expect(s).toEqual(before);
	});
	it("preserves individual multi-container templates and quality while removing model-external forced fields", () => {
		const raw = JSON.parse(
			readFileSync(
				join(
					__dirname,
					"../../../../../../packages/core/src/plan/__fixtures__/pertitle-h264-fmp4-ts-dash-hls-on-aws.plan.json",
				),
				"utf8",
			),
		);
		const s = planToWizardState(raw);
		const before = structuredClone(s);
		const rows = videoKeys(s.videos).map((key, i) =>
			fixed(key, required(required(s.videos[i]).height)),
		);
		const next = applyPerTitleProposal(s, proposal(rows), "H264");
		const { plan, operations } = compiled(next);
		expect(next.startOptions?.perTitle?.h264).toMatchObject({
			targetQualityCrf: s.startOptions?.perTitle?.h264?.targetQualityCrf,
			complexityFactor: s.startOptions?.perTitle?.h264?.complexityFactor,
			codecMinBitrateFactor:
				s.startOptions?.perTitle?.h264?.codecMinBitrateFactor,
		});
		for (const field of [
			"forcedRenditionAboveHighestFixedRepresentation",
			"forcedRenditionAboveHighestFixedRepresentationFactor",
			"forcedRenditionAboveHighestFixedRepresentationCalculationMode",
			"fixedResolutionAndBitrateConfiguration",
		])
			expect(next.startOptions?.perTitle?.h264).not.toHaveProperty(field);
		expect(plan.perTitle?.h264Configuration).not.toHaveProperty(
			"fixedResolutionAndBitrateConfiguration",
		);
		expect(
			next.videos.map((v) => [
				v.extras?.source,
				v.h264,
				v.muxing,
				v.extraMuxings,
			]),
		).toEqual(
			s.videos.map((v) => [v.extras?.source, v.h264, v.muxing, v.extraMuxings]),
		);
		expect(plan.muxings).toEqual(
			encodingPlanSchema.parse(buildPlan(s)).muxings,
		);
		expect(
			operations.find((o) => o.step === `stream:${required(rows[1]).rowId}`)
				?.payload,
		).toMatchObject({
			mode: required(rows[1]).mode,
			perTitleSettings: {
				fixedResolutionAndBitrateSettings: required(rows[1]).perTitleSettings,
			},
		});
		expect(s).toEqual(before);
	});
	it("adds repeated-height rows with allocator identities and all container legs", () => {
		const s = state();
		required(s.videos[0]).extraMuxings = [
			{ key: "ts-leg", kind: "TS", path: "video/ts/{uuid}" },
		];
		s.manifests = { hls: true, dash: true };
		const next = applyPerTitleProposal(
			s,
			proposal([fixed("v360", 360), fixed("new-rung", 360)]),
			"H264",
		);
		const { plan } = compiled(next);
		expect(new Set(videoKeys(next.videos)).size).toBe(2);
		expect(next.videos.map((v) => v.height)).toEqual([360, 360]);
		expect(next.videos.every((v) => v.extraMuxings?.length === 1)).toBe(true);
		expect(
			plan.muxings.filter((m) =>
				next.videos.some((v) => v.extras?.key === m.streamKey),
			),
		).toHaveLength(4);
	});
	it("does not change other codec parameters or audio when editing a matching row", () => {
		const s = state();
		s.videos.push({
			codec: "H265",
			height: 720,
			bitrate: 1500000,
			h265: { crf: 22, minKeyframeInterval: 2, maxBitrate: 2000000 },
		});
		const beforePlan = buildPlan(s);
		const next = applyPerTitleProposal(
			s,
			proposal([fixed(required(videoKeys(s.videos)[0]), 360)]),
			"H264",
		);
		expect(next.audios).toEqual(s.audios);
		expect(
			buildPlan(next).renditions.filter((r) => r.codec === "H265"),
		).toEqual(beforePlan.renditions.filter((r) => r.codec === "H265"));
		expect(s.startOptions).toBeUndefined();
	});
	it("preserves row-specific sources and filters instead of copying the first row over all rows", () => {
		const s = state();
		s.videos = [360, 720].map((height, i) => ({
			height,
			bitrate: 300000,
			h264: {
				crf: 20 + i,
				minBitrate: 100000,
				maxBitrate: 900000,
				bufsize: 1800000,
			},
			extras: {
				key: `row-${i}`,
				source: `source-${i}`,
				filters: [{ filterKey: `filter-${i}`, position: 0 }],
			},
		}));
		const next = applyPerTitleProposal(
			s,
			proposal([fixed("row-0", 360), fixed("row-1", 720)]),
			"H264",
		);
		expect(
			next.videos.map((v) => [v.extras?.source, v.extras?.filters, v.h264]),
		).toEqual(
			s.videos.map((v) => [v.extras?.source, v.extras?.filters, v.h264]),
		);
		expect(() =>
			applyPerTitleProposal(
				s,
				proposal([fixed("row-0", 360), fixed("new-rung", 720)]),
				"H264",
			),
		).toThrow(/reshape/i);
	});
	it("blocks removal of referenced rungs and DRM edits without changing the original", () => {
		const s = state();
		s.videos.push({ height: 720, bitrate: 1500000 });
		s.thumbnails = [
			{
				key: "thumb",
				streamKey: "v720",
				height: 90,
				positions: [0],
				path: "thumbs",
			},
		];
		const before = structuredClone(s);
		expect(() =>
			applyPerTitleProposal(s, proposal([fixed("v360", 360)]), "H264"),
		).toThrow(/reshape/i);
		s.thumbnails = [];
		s.drm = [
			{ kind: "CENC", muxingKey: "v360", credentialId: "key", kid: "kid" },
		];
		expect(() =>
			applyPerTitleProposal(
				s,
				proposal([fixed("v360", 360), fixed("v720", 720)]),
				"H264",
			),
		).toThrow(/DRM/i);
		expect(s.videos).toEqual(before.videos);
	});
	it("rejects conflict proposals and duplicate row identities", () => {
		const s = state();
		expect(() =>
			applyPerTitleProposal(
				s,
				{
					...proposal([fixed("v360", 360)]),
					applicable: false,
					status: "conflict",
				},
				"H264",
			),
		).toThrow();
		expect(() =>
			applyPerTitleProposal(
				s,
				proposal([fixed("v360", 360), fixed("v360", 720)]),
				"H264",
			),
		).toThrow();
	});
	it("opens a freely scaled ordinary template and retains its dimensions on automatic apply", () => {
		const s = state();
		s.videos = [
			{
				width: 1920,
				height: null,
				bitrate: null,
				extras: { mode: "PER_TITLE_TEMPLATE" },
			},
		];
		const goal = perTitleGoalFromWizard(s);
		expect(goal.strategy).toBe("automatic");
		expect(goal.rows).toEqual([]);
		const next = applyPerTitleProposal(
			s,
			proposal(
				[{ rowId: "automatic-template", mode: "PER_TITLE_TEMPLATE" }],
				true,
			),
			"H264",
		);
		expect(next.videos).toHaveLength(1);
		expect(next.videos[0]).toMatchObject({ width: 1920, height: null });
		compiled(next);
	});
	it("can initialize an empty ladder and shrink an unreferenced simple ladder", () => {
		const empty = state();
		empty.videos = [];
		const next = applyPerTitleProposal(
			empty,
			proposal(
				[{ rowId: "automatic-template", mode: "PER_TITLE_TEMPLATE" }],
				true,
			),
			"H264",
		);
		expect(next.videos).toHaveLength(1);
		expect(next.videos[0]?.height).toBeNull();
		compiled(next);
		const s = state();
		s.videos.push({ height: 720, bitrate: 1500000 });
		const reduced = applyPerTitleProposal(
			s,
			proposal([fixed("v360", 360)]),
			"H264",
		);
		expect(videoKeys(reduced.videos)).toEqual(["v360"]);
		expect(reduced.audios).toEqual(s.audios);
		compiled(reduced);
	});
	it("rejects an unsupported manual output path and a mismatched codec before mutating", () => {
		const s = state();
		s.videos[0] = {
			...required(s.videos[0]),
			muxing: { path: "manual/fixed-name" },
		};
		const before = structuredClone(s);
		expect(() =>
			applyPerTitleProposal(s, proposal([fixed("v360", 360)]), "H264"),
		).toThrow(/path/i);
		expect(() =>
			applyPerTitleProposal(s, proposal([fixed("v360", 360)]), "H265"),
		).toThrow(/codec/i);
		expect(s).toEqual(before);
	});
	it.each([
		["H265", "pertitle-h265-fmp4-dash-hls-on-aws"],
		["VP9", "pertitle-vp9-webm-fmp4-dash-on-aws"],
		["AV1", "pertitle-av1-fmp4-dash-on-aws"],
	] as const)("passes %s proposals into the matching compiled START config", (codec, fixture) => {
		const raw = JSON.parse(
			readFileSync(
				join(
					__dirname,
					`../../../../../../packages/core/src/plan/__fixtures__/${fixture}.plan.json`,
				),
				"utf8",
			),
		);
		const s = planToWizardState(raw);
		const rows = videoKeys(s.videos).map((key, index) =>
			fixed(key, required(required(s.videos[index]).height)),
		);
		const next = applyPerTitleProposal(s, { ...proposal(rows), codec }, codec);
		const { operations } = compiled(next);
		const field =
			codec === "H265"
				? "h265Configuration"
				: codec === "VP9"
					? "vp9Configuration"
					: "av1Configuration";
		expect(
			operations.find((o) => o.kind === "START_ENCODING")?.payload.perTitle,
		).toMatchObject({ [field]: { minBitrate: 100000, maxBitrate: 5000000 } });
	});
	it("retains an existing HEVCv2 profile and QP setting instead of enabling a profile implicitly", () => {
		const s = state();
		s.videos = [
			{
				codec: "H265V2",
				height: 720,
				bitrate: null,
				extras: { mode: "PER_TITLE_TEMPLATE" },
			},
		];
		s.internal = { hevcV2: { bcfVersion: INTERNAL_HEVC_V2_BCF_VERSION } };
		s.startOptions = { perTitle: { h265: { targetQualityQp: 20 } } };
		const next = applyPerTitleProposal(
			s,
			{ ...proposal([fixed("v720", 720)]), codec: "H265V2" },
			"H265V2",
		);
		expect(next.internal).toEqual(s.internal);
		expect(next.startOptions?.perTitle?.h265?.targetQualityQp).toBe(20);
		compiled(next);
	});
	it.each([
		"automatic",
		"count",
		"required-resolutions",
		"fixed-resolutions",
		"fixed-ranges",
	] as const)("builds and compiles an actual %s core proposal", (strategy) => {
		const s = state();
		const goal: PerTitleGoal = {
			...perTitleGoalFromWizard(s),
			strategy,
			minBitrate: 100000,
			maxBitrate: 5000000,
			countPolicy:
				strategy === "count"
					? { kind: "maximum", count: 12 }
					: { kind: "unrestricted" },
			rows: [
				{ id: "v360", height: 360, minBitrate: 300000, maxBitrate: 700000 },
				{
					id: "new-720",
					height: 720,
					minBitrate: 1200000,
					maxBitrate: 2000000,
				},
			],
		};
		const candidate = proposePerTitleSettings(goal).find((p) => p.applicable);
		expect(candidate).toBeDefined();
		const next = applyPerTitleProposal(s, required(candidate), "H264");
		const { operations } = compiled(next);
		expect(
			operations.find((o) => o.kind === "START_ENCODING")?.payload.perTitle,
		).toMatchObject({
			h264Configuration: { minBitrate: 100000, maxBitrate: 5000000 },
		});
	});
	it("preserves every unrelated duplicate-height destination when identities are pinned", () => {
		const s = state();
		s.manifests = { hls: false, dash: false };
		s.videos[0] = { ...required(s.videos[0]), encodingMode: "THREE_PASS" };
		s.videos.push(
			{
				codec: "H265",
				encodingMode: "THREE_PASS",
				height: 720,
				bitrate: 1000000,
				extraMuxings: [
					{
						key: "hevc-low-mp4",
						kind: "MP4",
						filename: "low.mp4",
						path: "hevc-low/archive",
					},
				],
			},
			{
				codec: "H265",
				encodingMode: "THREE_PASS",
				height: 720,
				bitrate: 2000000,
				extraMuxings: [
					{
						key: "hevc-high-mp4",
						kind: "MP4",
						filename: "high.mp4",
						path: "hevc-high/archive",
					},
				],
			},
		);
		const before = compiled(s).plan;
		const untouchedKeys = before.renditions
			.filter((r) => r.codec === "H265")
			.map((r) => r.key);
		const oldLegs = before.muxings.filter((m) =>
			untouchedKeys.includes(m.streamKey),
		);
		expect(new Set(oldLegs.map((m) => m.destination?.path)).size).toBe(4);
		const next = applyPerTitleProposal(
			s,
			proposal([fixed("v360", 360)]),
			"H264",
		);
		const { plan, operations } = compiled(next);
		expect(
			plan.muxings.filter((m) => untouchedKeys.includes(m.streamKey)),
		).toEqual(oldLegs);
		expect(plan.renditions.filter((r) => r.codec === "H265")).toEqual(
			before.renditions.filter((r) => r.codec === "H265"),
		);
		expect(
			operations.filter((o) => o.kind === "CREATE_CODEC_H265"),
		).toHaveLength(2);
	});
	function partial(): WizardState {
		const s = state();
		s.videos = [
			{
				height: 360,
				bitrate: null,
				extras: { mode: "PER_TITLE_TEMPLATE_FIXED_RESOLUTION" },
			},
			{
				height: 720,
				bitrate: null,
				extras: { mode: "PER_TITLE_TEMPLATE" },
				extraMuxings: [{ key: "auto-ts", kind: "TS", path: "auto/ts/{uuid}" }],
			},
		];
		s.startOptions = {
			perTitle: {
				h264: {
					minBitrate: 100000,
					maxBitrate: 5000000,
					autoRepresentations: true,
				},
			},
		};
		s.timing = "POST_ENCODING";
		return s;
	}
	it("imports only fixed rows as required resolutions from a partially automatic ladder", () => {
		const goal = perTitleGoalFromWizard(partial());
		expect(goal.strategy).toBe("required-resolutions");
		expect(goal.rows?.map((row) => row.id)).toEqual(["v360"]);
	});
	it("reuses the existing automatic template without adding, removing or collapsing its bindings", () => {
		const s = partial();
		const before = compiled(s).plan;
		const goal = {
			...perTitleGoalFromWizard(s),
			rows: [{ id: "v360", height: 360 }],
		};
		const candidate = required(
			proposePerTitleSettings(goal).find((p) => p.applicable),
		);
		const next = applyPerTitleProposal(s, candidate, "H264");
		const { plan, operations } = compiled(next);
		expect(videoKeys(next.videos)).toEqual(["v360", "v720"]);
		expect(
			plan.renditions
				.filter((r) => r.codec === "H264")
				.map((r) => [r.key, r.mode, r.height]),
		).toEqual([
			["v360", "PER_TITLE_TEMPLATE_FIXED_RESOLUTION", 360],
			["v720", "PER_TITLE_TEMPLATE", 720],
		]);
		expect(plan.muxings).toEqual(before.muxings);
		expect(operations.find((o) => o.step === "stream:v720")?.payload.mode).toBe(
			"PER_TITLE_TEMPLATE",
		);
	});
	it("loads selected-codec seeds without adopting another codec's rows or bounds", () => {
		const s = state();
		s.videos.push({
			codec: "H265",
			height: 720,
			bitrate: null,
			extras: {
				mode: "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE",
				perTitleSettings: { minBitrate: 900000, maxBitrate: 1700000 },
			},
		});
		s.startOptions = {
			perTitle: {
				h264: { minBitrate: 200000, maxBitrate: 600000 },
				h265: { minBitrate: 128000, maxBitrate: 4000000 },
			},
		};
		expect(perTitleGoalFromWizard(s, "H265")).toMatchObject({
			codec: "H265",
			strategy: "fixed-ranges",
			minBitrate: 128000,
			maxBitrate: 4000000,
			rows: [
				{ id: "v720", height: 720, minBitrate: 900000, maxBitrate: 1700000 },
			],
		});
		expect(perTitleGoalFromWizard(s, "AV1")).toMatchObject({
			codec: "AV1",
			strategy: "automatic",
			minBitrate: 100000,
			maxBitrate: 5000000,
			rows: [],
		});
	});
	it("keeps unrelated encrypted destinations and does not enable clear outputs", () => {
		const s = state();
		s.manifests = { hls: false, dash: false };
		s.videos = [
			{ height: 360, bitrate: 300000, encodingMode: "THREE_PASS" },
			{
				codec: "H265",
				height: 720,
				bitrate: 1000000,
				encodingMode: "THREE_PASS",
			},
			{
				codec: "H265",
				height: 720,
				bitrate: 2000000,
				encodingMode: "THREE_PASS",
			},
		];
		s.drm = [
			{
				kind: "CENC",
				muxingKey: "v720_1000k",
				credentialId: "00000000-0000-4000-8000-000000000003",
				kid: "00112233445566778899aabbccddeeff",
			},
		];
		const before = compiled(s).plan;
		const next = applyPerTitleProposal(
			s,
			proposal([fixed("v360", 360)]),
			"H264",
		);
		const after = compiled(next).plan;
		expect(after.drm).toEqual(before.drm);
		expect(after.muxings.filter((m) => m.streamKey.startsWith("v720"))).toEqual(
			before.muxings.filter((m) => m.streamKey.startsWith("v720")),
		);
		expect(
			after.muxings.find((m) => m.streamKey === "v720_1000k")?.destination,
		).toBeUndefined();
	});
	it.each([
		720,
		null,
	])("refuses mixed fixed-range and automatic templates with height %s without converting or deleting rows", (height) => {
		const s = state();
		s.videos = [
			{
				height: 360,
				bitrate: null,
				extras: {
					key: "bounded",
					mode: "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE",
					perTitleSettings: { minBitrate: 300000, maxBitrate: 700000 },
				},
			},
			{
				height,
				bitrate: null,
				extras: { key: "automatic", mode: "PER_TITLE_TEMPLATE" },
			},
		];
		const before = structuredClone(s);
		expect(() => perTitleGoalFromWizard(s)).toThrow(
			expect.objectContaining({ code: "UNSUPPORTED_STATE" }),
		);
		expect(s).toEqual(before);
		expect(videoKeys(s.videos)).toEqual(["bounded", "automatic"]);
		expect(s.videos[1]?.extras?.mode).toBe("PER_TITLE_TEMPLATE");
	});
	it("reuses the automatic binding when a fixed row occupies the generated automatic ID", () => {
		const s = partial();
		s.videos[0] = {
			...required(s.videos[0]),
			extras: { ...s.videos[0]?.extras, key: "automatic-template" },
		};
		const before = compiled(s).plan;
		const goal = perTitleGoalFromWizard(s);
		expect(goal.rows?.map((row) => row.id)).toEqual(["automatic-template"]);
		const candidate = required(
			proposePerTitleSettings(goal).find((p) => p.applicable),
		);
		expect(candidate.api.streams.map((row) => [row.rowId, row.mode])).toEqual([
			["automatic-template", "PER_TITLE_TEMPLATE_FIXED_RESOLUTION"],
			["v720", "PER_TITLE_TEMPLATE"],
		]);
		const next = applyPerTitleProposal(s, candidate, "H264");
		const { plan, operations } = compiled(next);
		expect(videoKeys(next.videos)).toEqual(["automatic-template", "v720"]);
		expect(plan.muxings).toEqual(before.muxings);
		expect(
			operations.find((o) => o.step === "stream:automatic-template")?.payload
				.mode,
		).toBe("PER_TITLE_TEMPLATE_FIXED_RESOLUTION");
		expect(operations.find((o) => o.step === "stream:v720")?.payload.mode).toBe(
			"PER_TITLE_TEMPLATE",
		);
	});

	it("does not reuse a generated automatic ID belonging to a different codec", () => {
		const s = partial();
		s.videos[0] = {
			...required(s.videos[0]),
			extras: { ...s.videos[0]?.extras, key: "automatic-template" },
		};
		s.videos.push({
			codec: "H265",
			height: 1080,
			bitrate: 2000000,
			extras: { key: "automatic-template-1" },
		});
		const candidate = required(
			proposePerTitleSettings(perTitleGoalFromWizard(s, "H264")).find(
				(p) => p.applicable,
			),
		);
		expect(candidate.api.streams.map((row) => row.rowId)).not.toContain(
			"automatic-template-1",
		);
		const colliding = structuredClone(candidate);
		for (const stream of colliding.api.streams) {
			if (stream.mode === "PER_TITLE_TEMPLATE")
				stream.rowId = "automatic-template-1";
		}
		const before = structuredClone(s);
		expect(() => applyPerTitleProposal(s, colliding, "H264")).toThrow(
			expect.objectContaining({ code: "INVALID_PROPOSAL" }),
		);
		expect(s).toEqual(before);
	});
	it("keeps the unsafe reshape guard when automatic bindings are ambiguous", () => {
		const s = partial();
		s.videos.push({
			height: 1080,
			bitrate: null,
			extras: { mode: "PER_TITLE_TEMPLATE" },
		});
		const goal = perTitleGoalFromWizard(s);
		expect(goal.automaticTemplates).toHaveLength(2);
		const candidate = required(
			proposePerTitleSettings({ ...goal, automaticTemplates: undefined }).find(
				(p) => p.applicable,
			),
		);
		expect(() => applyPerTitleProposal(s, candidate, "H264")).toThrow(
			expect.objectContaining({ code: "UNSAFE_RESHAPE" }),
		);
	});
});
