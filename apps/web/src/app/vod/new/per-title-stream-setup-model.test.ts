import { describe, expect, it } from "vitest";
import { tunePerTitleSettings } from "./per-title-simulator-tuning";
import {
	buildPerTitleStreamSetup,
	type PerTitleStreamSetupInput,
} from "./per-title-stream-setup-model";

const TEMPLATE = "PER_TITLE_TEMPLATE";
const RESOLUTION = "PER_TITLE_TEMPLATE_FIXED_RESOLUTION";
const RANGE = "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE";

const input = (): PerTitleStreamSetupInput => ({
	strategy: "fixed-ranges",
	codec: "H264",
	minBitrate: 160_000,
	maxBitrate: 5_000_000,
	targetQualityCrf: 17,
	streams: [
		{ id: "unconstrained", mode: TEMPLATE },
		{ id: "probe", mode: TEMPLATE, height: 320 },
		{ id: "resolution", mode: RESOLUTION, height: 576 },
		{
			id: "range",
			mode: RANGE,
			height: 768,
			minBitrate: 2_000_000,
			maxBitrate: 2_800_000,
		},
	],
});

describe("Stream-based Per-Title setup", () => {
	it("does not carry transient tuning locks into a fresh configuration", () => {
		const result = buildPerTitleStreamSetup({
			...input(),
			strategy: "automatic",
			streams: [{ id: "ordinary", mode: TEMPLATE }],
		});
		expect(result.goal).not.toHaveProperty("settingLocks");
		expect(result.goal).not.toHaveProperty("adjustments");
	});

	it("calculates count-only spacing before retaining an explicit ordinary Stream", () => {
		const result = buildPerTitleStreamSetup({
			...input(),
			strategy: "count",
			minBitrate: 150_000,
			maxBitrate: 4_000_000,
			count: 4,
			streams: [{ id: "ordinary", mode: TEMPLATE }],
		});
		expect(result.status).toBe("ready");
		expect(result.goal?.countPolicy).toEqual({ kind: "exact", count: 4 });
		expect(result.proposal?.api.streams).toEqual([
			{ rowId: "ordinary", mode: TEMPLATE },
		]);
		expect(result.proposal?.applicable).toBe(true);
	});

	it.each([
		"H264",
		"H265",
		"VP9",
	] as const)("retains all four Stream definitions for %s without inventing dimensions or bands", (codec) => {
		const source = { ...input(), codec };
		const before = structuredClone(source);
		const result = buildPerTitleStreamSetup(source);
		expect(result.status).not.toBe("conflict");
		expect(result.goal?.targetQualityCrf).toBe(17);
		expect(result.proposal?.api.global.targetQualityCrf).toBe(17);
		const streams = result.proposal?.api.streams;
		expect(streams).toHaveLength(4);
		for (const row of source.streams) {
			const actual = streams?.find((stream) => stream.rowId === row.id);
			expect(actual?.mode).toBe(row.mode);
			expect(actual?.height).toBe(row.height);
			expect(actual?.width).toBeUndefined();
			if (row.mode === RANGE) {
				expect(actual?.perTitleSettings).toMatchObject({
					minBitrate: row.minBitrate,
					maxBitrate: row.maxBitrate,
				});
			} else {
				expect(actual?.perTitleSettings?.minBitrate).toBeUndefined();
				expect(actual?.perTitleSettings?.maxBitrate).toBeUndefined();
			}
		}
		expect(result.goal?.countPolicy).toEqual({ kind: "unrestricted" });
		expect(result.proposal?.countGuarantee).toBe(false);
		if (!result.goal) throw new Error("Expected a Stream-based goal.");
		expect(tunePerTitleSettings(result.goal, result.goal).proposal.api).toEqual(
			result.proposal?.api,
		);
		expect(source).toEqual(before);
	});

	it("derives the existing mixed configuration from Stream rows while retaining their IDs", () => {
		const source: PerTitleStreamSetupInput = {
			...input(),
			inputHeight: 1152,
			streams: [
				{ id: "probe-a", mode: TEMPLATE, height: 160 },
				{
					id: "small-a",
					mode: RANGE,
					height: 320,
					minBitrate: 400_000,
					maxBitrate: 640_000,
				},
				{
					id: "small-b",
					mode: RANGE,
					height: 320,
					minBitrate: 750_000,
					maxBitrate: 1_100_000,
				},
				{
					id: "medium",
					mode: RANGE,
					height: 576,
					minBitrate: 1_200_000,
					maxBitrate: 1_700_000,
				},
				{
					id: "large",
					mode: RANGE,
					height: 768,
					minBitrate: 2_000_000,
					maxBitrate: 2_800_000,
				},
				{ id: "probe-b", mode: TEMPLATE, height: 960 },
				{ id: "probe-c", mode: TEMPLATE, height: 1152 },
			],
		};
		const result = buildPerTitleStreamSetup(source);
		expect(result.status).toBe("unverified");
		expect(result.goal?.countPolicy).toEqual({ kind: "exact", count: 6 });
		expect(result.proposal?.api.streams.map((row) => row.rowId).sort()).toEqual(
			source.streams.map((row) => row.id).sort(),
		);
		expect(result.proposal?.api.global).toMatchObject({
			targetQualityCrf: 17,
			minBitrateStepSize: 1.5,
			maxBitrateStepSize: 4,
			fixedResolutionAndBitrateConfiguration: {
				forcedRenditionAboveHighestFixedRepresentation: 1,
				forcedRenditionAboveHighestFixedRepresentationFactor: 1.2,
				forcedRenditionAboveHighestFixedRepresentationCalculationMode:
					"LAST_CALCULATED_BITRATE",
			},
		});
		expect(result.proposal?.countGuarantee).toBe(false);
	});

	it.each([
		undefined,
		320,
	])("does not invent a fixed resolution or fixed band for a template with height %s", (height) => {
		const result = buildPerTitleStreamSetup({
			...input(),
			strategy: "automatic",
			streams: [
				{
					id: "template",
					mode: TEMPLATE,
					...(height === undefined ? {} : { height }),
				},
			],
		});
		expect(result.proposal?.api.streams).toEqual([
			{
				rowId: "template",
				mode: TEMPLATE,
				...(height === undefined ? {} : { height }),
			},
		]);
		expect(result.goal?.countPolicy).toEqual({ kind: "unrestricted" });
	});

	it("keeps a width-only ordinary template free-scaled", () => {
		const result = buildPerTitleStreamSetup({
			...input(),
			streams: [{ id: "width-only", mode: TEMPLATE, width: 1920 }],
		});
		expect(result.proposal?.api.streams).toEqual([
			{ rowId: "width-only", mode: TEMPLATE, width: 1920 },
		]);
	});

	it("allocates only missing fixed-band endpoints and keeps resolution-only rows unbanded", () => {
		const source = input();
		source.streams = source.streams.map((row) =>
			row.mode === RANGE ? { ...row, maxBitrate: undefined } : row,
		);
		const result = buildPerTitleStreamSetup(source);
		expect(result.status).not.toBe("conflict");
		expect(
			result.proposal?.api.streams.find((row) => row.rowId === "range")
				?.perTitleSettings,
		).toMatchObject({ minBitrate: 2_000_000 });
		expect(
			result.proposal?.api.streams.find((row) => row.rowId === "resolution")
				?.perTitleSettings?.minBitrate,
		).toBeUndefined();
	});

	it.each([
		{ id: "bad", mode: RESOLUTION },
		{ id: "bad", mode: RANGE, height: 720.5 },
		{ id: "bad", mode: TEMPLATE, height: Number.NaN },
		{ id: "bad", mode: TEMPLATE, minBitrate: 200_000 },
		{ id: "bad", mode: RESOLUTION, height: 720, maxBitrate: 2_000_000 },
		{ id: "bad", mode: "STANDARD", height: 720 },
	])("rejects invalid or inactive Stream requirements %j", (row) => {
		const result = buildPerTitleStreamSetup({
			...input(),
			streams: [row],
		} as PerTitleStreamSetupInput);
		expect(result.status).toBe("conflict");
		expect(result.goal).toBeNull();
		expect(result.proposal).toBeNull();
		expect(result.issues.length).toBeGreaterThan(0);
	});
});
