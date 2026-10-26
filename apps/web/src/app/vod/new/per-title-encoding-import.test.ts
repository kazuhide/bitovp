import { describe, expect, it } from "vitest";
import {
	perTitleEncodingImportRequestSchema,
	projectPerTitleEncodingImport,
} from "./per-title-encoding-import";

const encodingId = "66ca342d-00ba-486e-bfcf-e02bb270b373";
const accountId = "fe3d4648-b6d8-4393-99b8-07338fe458ed";
const global = {
	minBitrate: 100_000,
	maxBitrate: 4_000_000,
	minBitrateStepSize: 1.5,
	maxBitrateStepSize: 3,
	targetQualityCrf: 0,
	resolutionScaleFactor: 0,
	autoRepresentations: { adoptConfigurationThreshold: 0 },
	fixedResolutionAndBitrateConfiguration: {
		forcedRenditionAboveHighestFixedRepresentation: 0,
		forcedRenditionAboveHighestFixedRepresentationFactor: 1.2,
		forcedRenditionAboveHighestFixedRepresentationCalculationMode:
			"LAST_CALCULATED_BITRATE",
	},
};
const settings = {
	fixedResolutionAndBitrateSettings: {
		minBitrate: 300_000,
		maxBitrate: 650_000,
		bitrateSelectionMode: "COMPLEXITY_RANGE",
		lowComplexityBoundaryForMaxBitrate: 900_000,
		highComplexityBoundaryForMaxBitrate: 4_000_000,
	},
	codecMaxBitrateFactor: 2,
	codecBufsizeFactor: 3,
};
function snapshot() {
	return {
		startRequest: { perTitle: { h264Configuration: structuredClone(global) } },
		streams: [
			{
				stream: {
					id: "source-fixed",
					mode: "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE",
					perTitleSettings: structuredClone(settings),
					appliedSettings: { height: 240, width: 426 },
				},
				codecType: "H264",
				configuration: { height: 360, bitrate: null },
			},
			{
				stream: { id: "source-template", mode: "PER_TITLE_TEMPLATE" },
				codecType: "H264",
				configuration: {},
			},
		] as const,
	};
}

describe("Per-Title Encoding API import projection", () => {
	it("retains explicit global and nested Stream settings without tuning", () => {
		const source = snapshot();
		const before = structuredClone(source);
		const result = projectPerTitleEncodingImport(source);
		expect(result.issues).toEqual([]);
		expect(result.configurations).toHaveLength(1);
		const imported = result.configurations[0];
		expect(imported?.reference.global).toEqual(global);
		expect(imported?.reference.streams[0]).toEqual({
			id: "source-fixed",
			codec: "H264",
			mode: "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE",
			height: 360,
			bitrate: null,
			perTitleSettings: {
				...settings.fixedResolutionAndBitrateSettings,
				codecMaxBitrateFactor: 2,
				codecBufsizeFactor: 3,
			},
		});
		expect(imported?.goal.countPolicy).toEqual({ kind: "unrestricted" });
		expect(imported?.goal.targetQualityCrf).toBe(0);
		expect(imported?.goal.resolutionScaleFactor).toBe(0);
		expect(imported?.goal.automaticTemplates).toEqual([
			{ id: "source-template" },
		]);
		expect(source).toEqual(before);
	});

	it("retains a width-only fixed Stream without inventing a height", () => {
		const source = snapshot();
		const result = projectPerTitleEncodingImport({
			...source,
			streams: source.streams.map((entry, index) => ({
				...entry,
				configuration: index === 0 ? { width: 640 } : entry.configuration,
			})),
		});
		expect(result.issues).toEqual([]);
		expect(result.configurations[0]?.goal.rows?.[0]).toMatchObject({
			id: "source-fixed",
			width: 640,
			minBitrate: 300_000,
			maxBitrate: 650_000,
		});
		expect(result.configurations[0]?.goal.rows?.[0]?.height).toBeUndefined();
		expect(
			result.configurations[0]?.reference.streams[0]?.height,
		).toBeUndefined();
	});

	it.each([
		["H264", "h264Configuration"],
		["H265", "h265Configuration"],
		["H265V2", "h265V2Configuration"],
		["VP9", "vp9Configuration"],
		["AV1", "av1Configuration"],
	])("imports %s using its own start configuration", (codec, key) => {
		const quality =
			codec === "H265V2" ? { targetQualityQp: 17 } : { targetQualityCrf: 17 };
		const result = projectPerTitleEncodingImport({
			startRequest: {
				perTitle: {
					[key]: { minBitrate: 200_000, maxBitrate: 5_000_000, ...quality },
				},
			},
			streams: [
				{
					stream: { id: "template", mode: "PER_TITLE_TEMPLATE" },
					codecType: codec,
					configuration: { width: 1920 },
				},
			],
		});
		expect(result.issues).toEqual([]);
		expect(result.configurations[0]?.goal).toMatchObject({
			codec,
			minBitrate: 200_000,
			maxBitrate: 5_000_000,
			...quality,
		});
		expect(result.configurations[0]?.goal.minBitrateStepSize).toBeUndefined();
		expect(result.configurations[0]?.goal.maxBitrateStepSize).toBeUndefined();
		expect(result.configurations[0]?.goal.autoRepresentations).toBe(false);
	});

	it("separates codecs and ignores results, standard streams and audio", () => {
		const source = snapshot();
		const result = projectPerTitleEncodingImport({
			startRequest: {
				perTitle: {
					h264Configuration: global,
					vp9Configuration: { minBitrate: 80_000, maxBitrate: 3_000_000 },
				},
			},
			streams: [
				...source.streams,
				{
					stream: { id: "vp9", mode: "PER_TITLE_TEMPLATE" },
					codecType: "VP9",
					configuration: { height: 720 },
				},
				{
					stream: { id: "result", mode: "PER_TITLE_RESULT" },
					codecType: "H264",
					configuration: { height: 1080 },
				},
				{
					stream: { id: "standard", mode: "STANDARD" },
					codecType: "H264",
					configuration: { height: 720 },
				},
				{
					stream: { id: "audio", mode: "PER_TITLE_TEMPLATE" },
					codecType: "AAC",
					configuration: {},
				},
			],
		});
		expect(result.issues).toEqual([]);
		expect(result.configurations.map((item) => item.codec)).toEqual([
			"H264",
			"VP9",
		]);
		expect(result.configurations[0]?.reference.streams).toHaveLength(2);
		expect(
			result.configurations[1]?.reference.streams.map((item) => item.id),
		).toEqual(["vp9"]);
		expect(result.configurations[1]?.goal.maxBitrate).toBe(3_000_000);
	});

	it.each([
		"global",
		"stream",
	])("reports unknown %s settings without echoing their values", (location) => {
		const source = snapshot();
		const sensitive = "fixture-private-content-not-a-real-secret";
		if (location === "global")
			Object.assign(source.startRequest.perTitle.h264Configuration, {
				unexpected: sensitive,
			});
		else
			Object.assign(source.streams[0].stream.perTitleSettings, {
				unexpected: sensitive,
			});
		const result = projectPerTitleEncodingImport(source);
		expect(result.configurations).toEqual([]);
		expect(result.issues).toEqual([
			{
				codec: "H264",
				code:
					location === "global"
						? "UNSUPPORTED_GLOBAL_SETTINGS"
						: "UNSUPPORTED_STREAM_SETTINGS",
			},
		]);
		expect(JSON.stringify(result)).not.toContain(sensitive);
	});

	it("does not infer missing global bitrate limits", () => {
		const source = snapshot();
		Reflect.deleteProperty(
			source.startRequest.perTitle.h264Configuration,
			"maxBitrate",
		);
		const result = projectPerTitleEncodingImport(source);
		expect(result.configurations).toEqual([]);
		expect(result.issues).toEqual([
			{ codec: "H264", code: "MISSING_BITRATE_LIMITS", fields: ["maxBitrate"] },
		]);
	});
	it("preserves omitted spacing parameters in the source and editable projection", () => {
		const source = snapshot();
		for (const key of ["minBitrateStepSize", "maxBitrateStepSize"])
			Reflect.deleteProperty(
				source.startRequest.perTitle.h264Configuration,
				key,
			);
		const result = projectPerTitleEncodingImport(source);
		expect(result.issues).toEqual([]);
		expect(result.configurations).toHaveLength(1);
		for (const key of ["minBitrateStepSize", "maxBitrateStepSize"]) {
			expect(result.configurations[0]?.reference.global).not.toHaveProperty(
				key,
			);
			expect(result.configurations[0]?.goal).not.toHaveProperty(key);
		}
	});
	it("reports repeated unsupported templates once while retaining supported codecs", () => {
		const source = snapshot();
		const result = projectPerTitleEncodingImport({
			...source,
			streams: [
				...source.streams,
				...Array.from({ length: 80 }, (_, index) => ({
					stream: { id: `unsupported-${index}`, mode: "PER_TITLE_TEMPLATE" },
					codecType: "FUTURE_VIDEO_CODEC",
					configuration: {},
				})),
			],
		});
		expect(result.configurations.map(({ codec }) => codec)).toEqual(["H264"]);
		expect(result.issues).toEqual([{ code: "UNSUPPORTED_CODEC" }]);
	});

	it("drops account, storage and other non-Per-Title fields from the result", () => {
		const source = snapshot();
		Object.assign(source.startRequest, {
			apiKey: "fixture-key",
			input: "private-input",
			output: "private-output",
		});
		Object.assign(source.streams[0].configuration, {
			name: "private-config-name",
			customData: { token: "fixture-token" },
		});
		const result = projectPerTitleEncodingImport(source);
		expect(result.configurations).toHaveLength(1);
		for (const text of [
			"fixture-key",
			"private-input",
			"private-output",
			"private-config-name",
			"fixture-token",
		])
			expect(JSON.stringify(result)).not.toContain(text);
	});

	it("reports a non-Per-Title encoding", () => {
		expect(
			projectPerTitleEncodingImport({ startRequest: {}, streams: [] }),
		).toEqual({
			configurations: [],
			issues: [{ code: "NO_PER_TITLE_CONFIGURATION" }],
		});
	});

	it("does not truncate a codec with too many templates", () => {
		const result = projectPerTitleEncodingImport({
			startRequest: { perTitle: { h264Configuration: global } },
			streams: Array.from({ length: 65 }, (_, index) => ({
				stream: { id: `template-${index}`, mode: "PER_TITLE_TEMPLATE" },
				codecType: "H264",
				configuration: {},
			})),
		});
		expect(result.configurations).toEqual([]);
		expect(result.issues).toEqual([
			{ codec: "H264", code: "TOO_MANY_TEMPLATES" },
		]);
	});

	it.each([
		"__proto__",
		"constructor",
		"FUTURE_CODEC",
	])("reports unsupported codec types such as %s", (codecType) => {
		const source = snapshot();
		const result = projectPerTitleEncodingImport({
			...source,
			streams: [
				...source.streams,
				{
					stream: { id: "unknown", mode: "PER_TITLE_TEMPLATE" },
					codecType,
					configuration: {},
				},
			],
		});
		expect(result.configurations).toHaveLength(1);
		expect(result.issues).toEqual([{ code: "UNSUPPORTED_CODEC" }]);
	});

	it("does not load a partial codec when one Stream contains unsupported settings", () => {
		const source = snapshot();
		const result = projectPerTitleEncodingImport({
			startRequest: {
				perTitle: {
					...source.startRequest.perTitle,
					vp9Configuration: { minBitrate: 80_000, maxBitrate: 3_000_000 },
				},
			},
			streams: [
				...source.streams,
				{
					stream: { id: "invalid-mode", mode: "PER_TITLE_FUTURE_TEMPLATE" },
					codecType: "H264",
					configuration: {},
				},
				{
					stream: { id: "vp9", mode: "PER_TITLE_TEMPLATE" },
					codecType: "VP9",
					configuration: {},
				},
			],
		});
		expect(result.configurations.map((item) => item.codec)).toEqual(["VP9"]);
		expect(result.issues).toEqual([
			{ codec: "H264", code: "UNSUPPORTED_STREAM_SETTINGS" },
		]);
	});

	it("normalizes undefined SDK model properties without erasing zero values", () => {
		const source = snapshot();
		Object.assign(source.startRequest.perTitle.h264Configuration, {
			codecMinBitrateFactor: undefined,
			targetQualityQp: undefined,
		});
		Object.assign(source.streams[0].stream.perTitleSettings, {
			codecMinBitrateFactor: undefined,
		});
		Object.assign(
			source.startRequest.perTitle.h264Configuration.autoRepresentations,
			{ unspecified: undefined },
		);
		const result = projectPerTitleEncodingImport(source);
		expect(result.issues).toEqual([]);
		expect(result.configurations[0]?.reference.global).toEqual(global);
	});

	it("rejects unknown nested global parameters instead of dropping them", () => {
		const source = snapshot();
		Object.assign(
			source.startRequest.perTitle.h264Configuration.autoRepresentations,
			{ futureSetting: 1 },
		);
		const result = projectPerTitleEncodingImport(source);
		expect(result.configurations).toEqual([]);
		expect(result.issues).toEqual([
			{ codec: "H264", code: "UNSUPPORTED_GLOBAL_SETTINGS" },
		]);
	});

	it("rejects malformed values without echoing them", () => {
		const source = snapshot();
		Object.assign(source.startRequest.perTitle.h264Configuration, {
			minBitrate: "fixture-sensitive-value",
		});
		const result = projectPerTitleEncodingImport(source);
		expect(result.configurations).toEqual([]);
		expect(result.issues).toEqual([
			{ codec: "H264", code: "INVALID_CONFIGURATION" },
		]);
		expect(JSON.stringify(result)).not.toContain("fixture-sensitive-value");
	});
});

describe("Per-Title import credentials", () => {
	it("accepts either saved account or temporary credentials", () => {
		expect(
			perTitleEncodingImportRequestSchema.safeParse({
				encodingId,
				bitmovinAccountId: accountId,
			}).success,
		).toBe(true);
		expect(
			perTitleEncodingImportRequestSchema.safeParse({
				encodingId,
				apiKey: "fixture-api-key",
				tenantOrgId: accountId,
			}).success,
		).toBe(true);
	});
	it.each([
		{ encodingId, bitmovinAccountId: accountId, apiKey: "fixture-api-key" },
		{ encodingId, apiKey: "key\r\nheader:value" },
		{ encodingId, apiKey: "x".repeat(513) },
		{ encodingId: "../start", apiKey: "fixture-api-key" },
		{ encodingId, apiKey: "fixture-api-key", tenantOrgId: "not-an-id" },
		{ encodingId },
	])("rejects ambiguous or malformed credential input", (body) => {
		expect(perTitleEncodingImportRequestSchema.safeParse(body).success).toBe(
			false,
		);
	});
});
