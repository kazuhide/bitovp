import type {
	ExpectedArtefacts,
	ExpectedDrm,
	ExpectedMuxing,
	PerTitleActualDeliveryMuxing,
	PerTitleActualPopulations,
} from "@bitovp/core";
import { describe, expect, it } from "vitest";
import { bindPerTitleDelivery } from "./per-title-delivery";

const dir = (pattern: string) => ({
	pattern,
	prefix: pattern.slice(
		0,
		pattern.indexOf("{") < 0 ? pattern.length : pattern.indexOf("{"),
	),
	templated: pattern.includes("{"),
});

const muxing = (
	key: string,
	mode: "FIXED" | "TEMPLATE",
	overrides: Partial<ExpectedMuxing> = {},
): ExpectedMuxing => ({
	muxingKey: key,
	streamKey: key,
	renditionKey: key,
	container: "FMP4_SEGMENTED",
	outputKey: "origin",
	dir: dir(`video/${key}/{height}p_{bitrate}_{uuid}/`),
	initSegment: "init.mp4",
	segmentNaming: "seg_%number%.m4s",
	segmentLengthSec: 6,
	video: { height: 360, codec: "H264", bitrate: null },
	perTitle: true,
	perTitleMode: mode,
	...overrides,
});

const artefacts = (
	muxings: ExpectedMuxing[],
	overrides: Partial<ExpectedArtefacts> = {},
): ExpectedArtefacts => ({
	planName: "per-title binding",
	outputKeys: ["origin"],
	muxings,
	manifests: [],
	drm: [],
	thumbnails: [],
	sprites: [],
	multiEncoding: false,
	notes: [],
	...overrides,
});

const actualMuxing = (
	streamId: string,
	templateRendition: string | undefined,
	muxingId: string,
	legs: PerTitleActualDeliveryMuxing["legs"],
	overrides: Partial<PerTitleActualDeliveryMuxing> = {},
): PerTitleActualDeliveryMuxing => ({
	streamId,
	...(templateRendition ? { templateRendition } : {}),
	muxingId,
	muxingType: "FMP4",
	legs,
	...overrides,
});

const leg = (
	streamId: string,
	templateRendition: string | undefined,
	muxingId: string,
	outputId: string,
	resolvedPath: string,
	overrides: Partial<PerTitleActualDeliveryMuxing["legs"][number]> = {},
): PerTitleActualDeliveryMuxing["legs"][number] => ({
	streamId,
	...(templateRendition ? { templateRendition } : {}),
	muxingId,
	muxingType: "FMP4",
	outputId,
	resolvedPath,
	...overrides,
});

const complete = (
	results: Array<{ streamId: string; templateRendition?: string }>,
	deliveryMuxings: PerTitleActualDeliveryMuxing[],
): PerTitleActualPopulations => ({
	status: "complete",
	results,
	qc: results.map((result) => ({
		...result,
		variant: result.streamId,
		mirrors: [],
	})),
	deliveryMuxings,
});

const codes = (result: ReturnType<typeof bindPerTitleDelivery>) =>
	result.status === "complete" ? result.issues.map((issue) => issue.code) : [];

describe("bindPerTitleDelivery", () => {
	it.each([
		"CMAF",
		"FMP4",
	])("requires provider CMAF for a dedicated CMAF expectation (%s)", (actualKind) => {
		const expected = artefacts([
			muxing("fixed", "FIXED", { muxingKind: "CMAF" }),
		]);
		const result = bindPerTitleDelivery(
			expected,
			complete(
				[{ streamId: "result", templateRendition: "fixed" }],
				[
					actualMuxing(
						"result",
						"fixed",
						"mux-result",
						[
							leg(
								"result",
								"fixed",
								"mux-result",
								"provider-origin",
								"video/fixed/360p_400000_a/",
								{ muxingType: actualKind },
							),
						],
						{ muxingType: actualKind },
					),
				],
			),
			{ origin: "provider-origin" },
		);
		expect(result.status).toBe("complete");
		if (result.status !== "complete") return;
		if (actualKind === "CMAF") {
			expect(result.issues).toEqual([]);
			expect(result.bindings).toHaveLength(1);
		} else {
			expect(result.issues.length).toBeGreaterThan(0);
			expect(result.bindings).toHaveLength(0);
		}
	});
	it("binds same-codec templates to their own RESULT legs exactly once", () => {
		const expected = artefacts([
			muxing("fixed-a", "FIXED"),
			muxing("fixed-b", "FIXED"),
		]);
		const populations = complete(
			[
				{ streamId: "result-a", templateRendition: "fixed-a" },
				{ streamId: "result-b", templateRendition: "fixed-b" },
			],
			[
				actualMuxing("result-a", "fixed-a", "mux-a", [
					leg(
						"result-a",
						"fixed-a",
						"mux-a",
						"provider-origin",
						"video/fixed-a/360p_400000_a/",
					),
				]),
				actualMuxing("result-b", "fixed-b", "mux-b", [
					leg(
						"result-b",
						"fixed-b",
						"mux-b",
						"provider-origin",
						"video/fixed-b/720p_1800000_b/",
					),
				]),
			],
		);

		const result = bindPerTitleDelivery(expected, populations, {
			origin: "provider-origin",
		});
		expect(result.status).toBe("complete");
		if (result.status !== "complete") return;
		expect(result.issues).toEqual([]);
		expect(result.bindings.map((binding) => binding.id)).toEqual([
			"fixed-a:result-a:mux-a:clear:provider-origin",
			"fixed-b:result-b:mux-b:clear:provider-origin",
		]);
		expect(result.eligibleLegIds).toEqual(result.checkedLegIds);
		expect(new Set(result.checkedLegIds).size).toBe(
			result.checkedLegIds.length,
		);
		expect(result.reusedLegIds).toEqual([]);
	});

	it("reports a pruned flexible template as notGenerated but fails a missing fixed template", () => {
		const expected = artefacts([
			muxing("fixed", "FIXED"),
			muxing("v900", "TEMPLATE"),
		]);
		const result = bindPerTitleDelivery(expected, complete([], []), {
			origin: "provider-origin",
		});

		expect(result.status).toBe("complete");
		if (result.status !== "complete") return;
		expect(result.templates).toEqual([
			{ templateRendition: "fixed", mode: "FIXED", outcome: "missing" },
			{ templateRendition: "v900", mode: "TEMPLATE", outcome: "notGenerated" },
		]);
		expect(codes(result)).toContain("fixed-result-missing");
		expect(codes(result)).not.toContain("flexible-result-missing");
	});

	it("does not call a flexible template pruned while a same-run RESULT remains unattributed", () => {
		const result = bindPerTitleDelivery(
			artefacts([muxing("flexible", "TEMPLATE")]),
			complete([{ streamId: "result-u" }], []),
			{ origin: "provider-origin" },
		);

		expect(result.status).toBe("complete");
		if (result.status !== "complete") return;
		expect(result.templates).toEqual([
			{
				templateRendition: "flexible",
				mode: "TEMPLATE",
				outcome: "unverified",
			},
		]);
		expect(codes(result)).toContain("result-unattributed");
	});

	it("never lets one provider rung satisfy two templates", () => {
		const expected = artefacts([
			muxing("fixed-a", "FIXED"),
			muxing("fixed-b", "FIXED"),
		]);
		const duplicated = complete(
			[
				{ streamId: "same-result", templateRendition: "fixed-a" },
				{ streamId: "same-result", templateRendition: "fixed-b" },
			],
			[
				actualMuxing("same-result", "fixed-a", "same-mux", [
					leg(
						"same-result",
						"fixed-a",
						"same-mux",
						"provider-origin",
						"video/fixed-a/360p_a/",
					),
				]),
			],
		);

		const result = bindPerTitleDelivery(expected, duplicated, {
			origin: "provider-origin",
		});
		expect(result.status).toBe("complete");
		if (result.status !== "complete") return;
		expect(codes(result)).toContain("result-stream-reused");
		expect(result.bindings).toEqual([]);
		expect(result.reusedLegIds).toEqual([]);
	});

	it("makes unattributed results and duplicate paths explicit failures", () => {
		const expected = artefacts([muxing("fixed", "FIXED")]);
		const populations = complete(
			[
				{ streamId: "unattributed" },
				{ streamId: "attributed", templateRendition: "fixed" },
			],
			[
				actualMuxing("unattributed", undefined, "mux-u", [
					leg(
						"unattributed",
						undefined,
						"mux-u",
						"provider-origin",
						"video/shared/",
					),
				]),
				actualMuxing("attributed", "fixed", "mux-a", [
					leg(
						"attributed",
						"fixed",
						"mux-a",
						"provider-origin",
						"video/shared/",
					),
					leg(
						"attributed",
						"fixed",
						"mux-a",
						"provider-origin",
						"video/shared/",
					),
				]),
			],
		);

		const result = bindPerTitleDelivery(expected, populations, {
			origin: "provider-origin",
		});
		expect(result.status).toBe("complete");
		if (result.status !== "complete") return;
		expect(codes(result)).toContain("result-unattributed");
		expect(codes(result)).toContain("delivery-path-duplicate");
		expect(codes(result)).toContain("delivery-leg-id-duplicate");
	});

	it("retains two direct outputs, DRM-only fan-out, and clear-plus-DRM as distinct legs", () => {
		const clear = muxing("clear", "FIXED");
		const drmOnly = muxing("drm-only", "FIXED", {
			outputKey: "",
			dir: dir(""),
			viaDrmKeys: ["drm-cenc", "drm-fairplay"],
		});
		const both = muxing("both", "FIXED");
		const drm = [
			{
				drmKey: "drm-cenc",
				kind: "CENC",
				muxingKeys: ["drm-only"],
				ivSizeBytes: 8,
				outputKey: "origin",
				dir: dir("drm-only/{height}p_{bitrate}_{uuid}/"),
			},
			{
				drmKey: "drm-fairplay",
				kind: "FAIRPLAY",
				muxingKeys: ["drm-only"],
				ivSizeBytes: 16,
				outputKey: "origin",
				dir: dir("drm-only-fp/{height}p_{bitrate}_{uuid}/"),
			},
			{
				drmKey: "both-cenc",
				kind: "CENC",
				muxingKeys: ["both"],
				ivSizeBytes: 8,
				outputKey: "origin",
				dir: dir("video/both/drm/{height}p_{bitrate}_{uuid}/"),
			},
		] satisfies ExpectedDrm[];
		const mirroredDirect = artefacts([clear], {
			outputKeys: ["origin", "mirror"],
			deliveryMirrorOutputKeys: ["mirror"],
		});
		const directResult = bindPerTitleDelivery(
			mirroredDirect,
			complete(
				[{ streamId: "result-clear", templateRendition: "clear" }],
				[
					actualMuxing("result-clear", "clear", "mux-clear", [
						leg(
							"result-clear",
							"clear",
							"mux-clear",
							"provider-origin",
							"video/clear/360p_400000_a/",
						),
						leg(
							"result-clear",
							"clear",
							"mux-clear",
							"provider-mirror",
							"video/clear/360p_400000_a/",
						),
					]),
				],
			),
			{ origin: "provider-origin", mirror: "provider-mirror" },
		);
		expect(directResult.status).toBe("complete");
		if (directResult.status !== "complete") return;
		expect(directResult.issues).toEqual([]);
		expect(directResult.bindings).toHaveLength(2);

		const drmOnlyResult = bindPerTitleDelivery(
			artefacts([drmOnly], { drm: drm.slice(0, 2) }),
			complete(
				[{ streamId: "result-drm", templateRendition: "drm-only" }],
				[
					actualMuxing("result-drm", "drm-only", "mux-drm", [
						leg(
							"result-drm",
							"drm-only",
							"mux-drm",
							"provider-origin",
							"drm-only/360p_400000_a/",
							{
								drmId: "provider-cenc",
								drmType: "CENC",
							},
						),
						leg(
							"result-drm",
							"drm-only",
							"mux-drm",
							"provider-origin",
							"drm-only-fp/360p_400000_a/",
							{
								drmId: "provider-fairplay",
								drmType: "FAIRPLAY",
							},
						),
					]),
				],
			),
			{ origin: "provider-origin" },
		);
		expect(drmOnlyResult.status).toBe("complete");
		if (drmOnlyResult.status !== "complete") return;
		expect(drmOnlyResult.issues).toEqual([]);
		expect(drmOnlyResult.bindings).toHaveLength(2);
		expect(
			drmOnlyResult.bindings.every((binding) => binding.actual.drmId),
		).toBe(true);

		const bothResult = bindPerTitleDelivery(
			artefacts([both], { drm: drm.slice(2) }),
			complete(
				[{ streamId: "result-both", templateRendition: "both" }],
				[
					actualMuxing("result-both", "both", "mux-both", [
						leg(
							"result-both",
							"both",
							"mux-both",
							"provider-origin",
							"video/both/360p_400000_a/",
						),
						leg(
							"result-both",
							"both",
							"mux-both",
							"provider-origin",
							"video/both/drm/360p_400000_a/",
							{
								drmId: "provider-both-cenc",
								drmType: "CENC",
							},
						),
					]),
				],
			),
			{ origin: "provider-origin" },
		);
		expect(bothResult.status).toBe("complete");
		if (bothResult.status !== "complete") return;
		expect(bothResult.issues).toEqual([]);
		expect(bothResult.bindings).toHaveLength(2);

		for (const result of [directResult, drmOnlyResult, bothResult]) {
			expect(result.eligibleLegIds).toEqual(result.checkedLegIds);
			expect(result.reusedLegIds).toEqual([]);
		}
	});

	it("returns incomplete evidence as UNVERIFIED without constructing delivery PASSes", () => {
		const result = bindPerTitleDelivery(
			artefacts([muxing("fixed", "FIXED")]),
			{ status: "incomplete", reason: "legacy snapshot" },
			{ origin: "provider-origin" },
		);
		expect(result).toEqual({ status: "unverified", reason: "legacy snapshot" });
	});

	it("keeps missing provider-output identity UNVERIFIED instead of mislabelling the actual leg unexpected", () => {
		const populations = complete(
			[{ streamId: "result-a", templateRendition: "fixed-a" }],
			[
				actualMuxing("result-a", "fixed-a", "mux-a", [
					leg(
						"result-a",
						"fixed-a",
						"mux-a",
						"provider-origin",
						"video/fixed-a/360p_400000_a/",
					),
				]),
			],
		);
		const result = bindPerTitleDelivery(
			artefacts([muxing("fixed-a", "FIXED")]),
			populations,
			{},
		);
		expect(result.status).toBe("complete");
		if (result.status !== "complete") return;
		expect(result.bindings).toEqual([]);
		expect(result.issues).toEqual([
			{
				code: "provider-output-unverified",
				verdict: "SKIP",
				detail:
					"plan output origin has no provider output id, so fixed-a:clear:origin is UNVERIFIED",
			},
		]);
	});
});
