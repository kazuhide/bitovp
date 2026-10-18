import { describe, expect, it } from "vitest";
import {
	PER_TITLE_ATTRIBUTION_VERSION,
	PER_TITLE_SCHEMA_VERSION,
	type PerTitleResultsSnapshot,
} from "../plan/per-title-results";
import { perTitleActualPopulations } from "./per-title-actual";

type ResultStream = PerTitleResultsSnapshot["streams"][number];

const output = (outputId: string, outputPath: string) => ({
	outputId,
	outputPath,
});

const snapshot = (
	streams: ResultStream[],
	overrides: Partial<PerTitleResultsSnapshot> = {},
): PerTitleResultsSnapshot => ({
	capturedAt: "2026-08-31T00:00:00.000Z",
	schemaVersion: PER_TITLE_SCHEMA_VERSION,
	attributionVersion: PER_TITLE_ATTRIBUTION_VERSION,
	streams,
	scan: {
		streamsListed: streams.length + 2,
		templatesListed: 2,
		templatesDeclared: 2,
		resultsCaptured: streams.length,
		muxingsListed: streams.reduce((n, stream) => n + stream.muxings.length, 0),
		complete: true,
		codecConfigErrors: 0,
		unattributed: streams.filter(
			(stream) => stream.templateRendition === undefined,
		).length,
	},
	...overrides,
});

const result = (
	streamId: string,
	templateRendition: string | undefined,
	muxings: ResultStream["muxings"],
): ResultStream => ({
	streamId,
	mode: "PER_TITLE_RESULT",
	...(templateRendition !== undefined ? { templateRendition } : {}),
	codecType: "H264",
	params: {},
	muxings,
});

const qc = (
	muxingId: string,
	filename: string,
	variant: string,
	outputs = [output("provider-origin", `video/${variant}/qc/`)],
): ResultStream["muxings"][number] => ({
	muxingId,
	muxingType: "MP4",
	filename,
	outputs,
	drm: [],
});

describe("perTitleActualPopulations", () => {
	it("derives one QC unit per RESULT rung while keeping every delivery output leg", () => {
		const actual = perTitleActualPopulations({
			origin: "step",
			snapshot: snapshot([
				result("stream-a", "template-a", [
					qc("qc-a", "template-a.mp4", "360p_400000_a", [
						output("provider-origin", "video/360p_400000_a/qc/"),
						output("provider-mirror", "video/360p_400000_a/qc/"),
					]),
					{
						muxingId: "mux-a",
						muxingType: "FMP4",
						outputs: [
							output("provider-origin", "video/360p_400000_a/dash/"),
							output("provider-mirror", "video/360p_400000_a/dash/"),
						],
						drm: [],
					},
				]),
				result("stream-b", "template-b", [
					qc("qc-b", "template-b.mp4", "720p_1800000_b"),
					{
						muxingId: "mux-b",
						muxingType: "FMP4",
						outputs: [output("provider-origin", "video/720p_1800000_b/dash/")],
						drm: [],
					},
				]),
			]),
		});

		expect(actual.status).toBe("complete");
		if (actual.status !== "complete") return;
		expect(actual.results).toEqual([
			{ streamId: "stream-a", templateRendition: "template-a" },
			{ streamId: "stream-b", templateRendition: "template-b" },
		]);
		expect(
			actual.qc.map(({ streamId, variant, mirrors }) => ({
				streamId,
				variant,
				mirrors: mirrors.length,
				filename: mirrors[0]?.filename,
			})),
		).toEqual([
			{
				streamId: "stream-a",
				variant: "360p_400000_a",
				mirrors: 2,
				filename: "template-a.mp4",
			},
			{
				streamId: "stream-b",
				variant: "720p_1800000_b",
				mirrors: 1,
				filename: "template-b.mp4",
			},
		]);
		expect(
			actual.deliveryMuxings.map(({ muxingId, legs }) => ({
				muxingId,
				legs: legs.map((leg) => [leg.outputId, leg.resolvedPath]),
			})),
		).toEqual([
			{
				muxingId: "mux-a",
				legs: [
					["provider-mirror", "video/360p_400000_a/dash/"],
					["provider-origin", "video/360p_400000_a/dash/"],
				],
			},
			{
				muxingId: "mux-b",
				legs: [["provider-origin", "video/720p_1800000_b/dash/"]],
			},
		]);
	});

	it("does not collapse direct, DRM-only, or clear-plus-DRM fan-out", () => {
		const actual = perTitleActualPopulations({
			origin: "snapshot",
			snapshot: snapshot([
				result("stream-a", "template-a", [
					qc("qc-a", "template-a.mp4", "360p_a"),
					{
						muxingId: "two-direct",
						muxingType: "FMP4",
						outputs: [
							output("out-a", "direct/a/"),
							output("out-b", "direct/a/"),
						],
						drm: [],
					},
					{
						muxingId: "two-drm",
						muxingType: "FMP4",
						outputs: [],
						drm: [
							{
								drmId: "cenc-a",
								drmType: "CENC",
								outputs: [output("out-a", "drm/a/")],
							},
							{
								drmId: "fairplay-b",
								drmType: "FAIRPLAY",
								outputs: [output("out-b", "drm/b/")],
							},
						],
					},
					{
						muxingId: "clear-and-drm",
						muxingType: "FMP4",
						outputs: [output("out-a", "both/clear/")],
						drm: [
							{
								drmId: "cenc-b",
								drmType: "CENC",
								outputs: [output("out-b", "both/drm/")],
							},
						],
					},
				]),
			]),
		});

		expect(actual.status).toBe("complete");
		if (actual.status !== "complete") return;
		const legs = Object.fromEntries(
			actual.deliveryMuxings.map((muxing) => [
				muxing.muxingId,
				muxing.legs.map((leg) => ({
					outputId: leg.outputId,
					drmId: leg.drmId ?? "clear",
				})),
			]),
		);
		expect(legs).toEqual({
			"two-direct": [
				{ outputId: "out-a", drmId: "clear" },
				{ outputId: "out-b", drmId: "clear" },
			],
			"two-drm": [
				{ outputId: "out-a", drmId: "cenc-a" },
				{ outputId: "out-b", drmId: "fairplay-b" },
			],
			"clear-and-drm": [
				{ outputId: "out-a", drmId: "clear" },
				{ outputId: "out-b", drmId: "cenc-b" },
			],
		});
	});

	it("classifies a truncated, legacy, or identity-incomplete snapshot as UNVERIFIED", () => {
		const healthy = result("stream-a", "template-a", [
			qc("qc-a", "template-a.mp4", "360p_a"),
		]);
		const truncated = perTitleActualPopulations({
			origin: "step",
			snapshot: snapshot([healthy], {
				scan: {
					...snapshot([healthy]).scan,
					complete: false,
				},
			}),
		});
		const legacy = perTitleActualPopulations({
			origin: "snapshot",
			snapshot: snapshot([healthy], {
				schemaVersion: undefined,
				attributionVersion: undefined,
			}),
		});
		const noOutputId = perTitleActualPopulations({
			origin: "step",
			snapshot: snapshot([
				result("stream-a", "template-a", [
					{
						...qc("qc-a", "template-a.mp4", "360p_a"),
						outputs: [{ outputPath: "video/360p_a/qc/" }],
					},
				]),
			]),
		});

		expect(truncated).toMatchObject({
			status: "incomplete",
			reason: expect.stringMatching(/complete=false/),
		});
		expect(legacy).toMatchObject({
			status: "incomplete",
			reason: expect.stringMatching(/legacy.*version/i),
		});
		expect(noOutputId).toMatchObject({
			status: "incomplete",
			reason: expect.stringMatching(/outputId/),
		});
	});

	it("keeps an unattributed RESULT in both populations so the engine can fail it explicitly", () => {
		const actual = perTitleActualPopulations({
			origin: "step",
			snapshot: snapshot([
				result("unattributed", undefined, [
					qc("qc-u", "unknown.mp4", "360p_u"),
					{
						muxingId: "mux-u",
						muxingType: "FMP4",
						outputs: [output("out-a", "video/360p_u/")],
						drm: [],
					},
				]),
			]),
		});

		expect(actual.status).toBe("complete");
		if (actual.status !== "complete") return;
		expect(actual.results).toEqual([{ streamId: "unattributed" }]);
		expect(actual.qc[0]).toMatchObject({ streamId: "unattributed" });
		expect(actual.deliveryMuxings[0]).toMatchObject({
			streamId: "unattributed",
			muxingId: "mux-u",
		});
	});
});
