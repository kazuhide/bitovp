import {
	type ExpectedArtefacts,
	type ExpectedMuxing,
	PER_TITLE_ATTRIBUTION_VERSION,
	PER_TITLE_SCHEMA_VERSION,
	type PerTitleResultsSnapshot,
	perTitleActualPopulations,
	perTitleResultsSnapshotSchema,
} from "@bitovp/core";
import { describe, expect, it } from "vitest";
import {
	type EngineDeps,
	type MediaProbe,
	perTitleUnverifiedChecks,
	verifyArtefacts,
} from "./engine";
import { bindPerTitleDelivery } from "./per-title-delivery";

type StreamMode =
	| "PER_TITLE_TEMPLATE"
	| "PER_TITLE_TEMPLATE_FIXED_RESOLUTION"
	| "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE";

const expectation = (
	mode: StreamMode = "PER_TITLE_TEMPLATE",
	height: number | null = 360,
	width?: number,
): ExpectedArtefacts => {
	const muxing: ExpectedMuxing = {
		muxingKey: "delivery",
		streamKey: "template",
		renditionKey: "template",
		container: "FMP4_SEGMENTED",
		outputKey: "origin",
		dir: {
			pattern: "video/template/{uuid}/",
			prefix: "video/template/",
			templated: true,
		},
		initSegment: "init.mp4",
		segmentNaming: "segment_%number%.m4s",
		segmentLengthSec: 2,
		video: {
			height,
			...(width !== undefined ? { width } : {}),
			codec: "H264",
			bitrate: 2_000_000,
			fps: 24,
		},
		perTitle: true,
		perTitleMode:
			mode === "PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE"
				? "FIXED"
				: "TEMPLATE",
		perTitleStreamMode: mode,
	};
	return {
		planName: "Per-title RESULT geometry",
		outputKeys: ["origin"],
		muxings: [muxing],
		manifests: [],
		drm: [],
		thumbnails: [],
		sprites: [],
		multiEncoding: false,
		notes: [],
	};
};

const snapshot = (
	params: Record<string, unknown> = {
		width: 320,
		height: 180,
		bitrate: 200_000,
	},
	appliedSettings?: { width?: number; height?: number },
): PerTitleResultsSnapshot =>
	perTitleResultsSnapshotSchema.parse({
		capturedAt: "2026-10-01T00:00:00.000Z",
		schemaVersion: PER_TITLE_SCHEMA_VERSION,
		attributionVersion: PER_TITLE_ATTRIBUTION_VERSION,
		streams: [
			{
				streamId: "result-video",
				mode: "PER_TITLE_RESULT",
				templateRendition: "template",
				codecType: "H264",
				params,
				...(appliedSettings ? { appliedSettings } : {}),
				muxings: [
					{
						muxingId: "result-muxing",
						muxingType: "FMP4",
						outputs: [
							{
								outputId: "provider-origin",
								outputPath: "video/template/result/",
							},
						],
						drm: [],
					},
				],
			},
		],
		scan: {
			streamsListed: 2,
			templatesListed: 1,
			templatesDeclared: 1,
			resultsCaptured: 1,
			muxingsListed: 1,
			complete: true,
			codecConfigErrors: 0,
			unattributed: 0,
		},
	});

const providerOutputIds = { origin: "provider-origin" };
const probe: MediaProbe = {
	width: 320,
	height: 180,
	videoCodec: "h264",
	bitrateBps: 200_000,
	fps: 24,
};

async function verify(
	plan = expectation(),
	capture = snapshot(),
	media: MediaProbe = probe,
) {
	const population = perTitleActualPopulations({
		origin: "step",
		snapshot: capture,
	});
	const binding = bindPerTitleDelivery(plan, population, providerOutputIds);
	const deps: EngineDeps = {
		perTitlePopulations: population,
		providerOutputIds,
		listAll: async () => [
			{ key: "video/template/result/init.mp4", size: 100 },
			{ key: "video/template/result/segment_1.m4s", size: 1_000 },
		],
		fetchObject: async (_outputKey, key) => key,
		fetchConcatenated: async (_outputKey, keys) => keys.join("+"),
		probe: async () => media,
		scanBoxes: async () => ({ psshSystemIds: [] }),
		readText: async () => "",
		parseHls: async () => ({ variants: [], media: [] }),
		parseDash: async () => ({ representations: [], periods: 0 }),
	};
	return { population, binding, report: await verifyArtefacts(plan, deps) };
}

describe("captured Per-title RESULT geometry through delivery verification", () => {
	it("uses the generated dimensions and target bitrate instead of flexible template hints", async () => {
		const { population, binding, report } = await verify(
			expectation("PER_TITLE_TEMPLATE", 360, 640),
			snapshot(undefined, { width: 320, height: 180 }),
		);
		expect(population).toMatchObject({
			status: "complete",
			results: [{ video: { width: 320, height: 180, bitrate: 200_000 } }],
		});
		expect(binding).toMatchObject({
			status: "complete",
			bindings: [
				{ actualVideo: { width: 320, height: 180, bitrate: 200_000 } },
			],
		});
		expect(report.checks.filter((check) => check.verdict === "FAIL")).toEqual(
			[],
		);
		expect(
			report.checks.find((check) => check.id.endsWith(":height")),
		).toMatchObject({
			verdict: "PASS",
			detail: expect.stringContaining("180"),
		});
		expect(
			report.checks.find((check) => check.id.endsWith(":bitrate")),
		).toMatchObject({
			verdict: "PASS",
			detail: expect.stringContaining("200000"),
		});
		expect(perTitleUnverifiedChecks(report)).toEqual([]);
	});

	it.each([
		"height",
		"width",
	] as const)("fails media whose %s disagrees with the captured RESULT", async (axis) => {
		const { report } = await verify(expectation(), snapshot(), {
			...probe,
			[axis]: (probe[axis] ?? 0) * 2,
		});
		expect(
			report.checks.find((check) => check.id.endsWith(`:${axis}`)),
		).toMatchObject({
			verdict: "FAIL",
		});
	});

	it.each([
		"PER_TITLE_TEMPLATE_FIXED_RESOLUTION",
		"PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE",
	] as const)("independently fails a violated %s requirement even when media matches the RESULT", async (mode) => {
		const { report } = await verify(expectation(mode));
		expect(report.checks.filter((check) => check.verdict === "FAIL")).toEqual([
			expect.objectContaining({
				id: expect.stringMatching(/configured-height$/),
				detail: expect.stringMatching(/360.*180/),
			}),
		]);
	});

	it("accepts null flexible hints when captured dimensions are available", async () => {
		const { report } = await verify(expectation("PER_TITLE_TEMPLATE", null));
		expect(report.checks.filter((check) => check.verdict === "FAIL")).toEqual(
			[],
		);
		expect(
			report.checks.find((check) => check.id.endsWith(":height")),
		).toMatchObject({
			verdict: "PASS",
			detail: expect.stringContaining("180"),
		});
	});

	it("leaves missing RESULT dimensions UNVERIFIED without treating the template hint as a requirement", async () => {
		const { report } = await verify(expectation(), snapshot({}));
		expect(report.checks.filter((check) => check.verdict === "FAIL")).toEqual(
			[],
		);
		expect(report.checks).toContainEqual(
			expect.objectContaining({
				id: expect.stringMatching(/^pertitle:result:.*result-height$/),
				verdict: "SKIP",
				detail: expect.stringMatching(/UNVERIFIED.*RESULT.*height/),
			}),
		);
		expect(
			report.checks.find((check) => check.id.endsWith(":codec")),
		).toMatchObject({ verdict: "PASS" });
		expect(
			report.checks.find((check) => check.id.endsWith(":fps")),
		).toMatchObject({ verdict: "PASS" });
		expect(
			report.checks.find((check) => check.id.endsWith(":bitrate")),
		).toBeUndefined();
		expect(perTitleUnverifiedChecks(report).map((check) => check.id)).toEqual([
			expect.stringMatching(/result-width$/),
			expect.stringMatching(/result-height$/),
		]);
	});

	it("fails missing media dimensions when the RESULT supplies them", async () => {
		const { report } = await verify(expectation(), snapshot(), {
			videoCodec: "h264",
			fps: 24,
			bitrateBps: 200_000,
		});
		for (const axis of ["width", "height"]) {
			expect(
				report.checks.find((check) => check.id.endsWith(`:${axis}`)),
			).toMatchObject({
				verdict: "FAIL",
			});
		}
	});

	it("keeps a configured fixed width independent of matching generated media", async () => {
		const plan = expectation("PER_TITLE_TEMPLATE_FIXED_RESOLUTION", 180);
		const video = plan.muxings[0]?.video;
		if (!video) throw new Error("missing test video");
		video.width = 640;
		const { report } = await verify(plan);
		expect(report.checks.filter((check) => check.verdict === "FAIL")).toEqual([
			expect.objectContaining({
				id: expect.stringMatching(/configured-width$/),
				detail: expect.stringMatching(/640.*320/),
			}),
		]);
	});

	it.each([
		"PER_TITLE_TEMPLATE_FIXED_RESOLUTION",
		"PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE",
	] as const)("still checks known %s geometry when RESULT metadata is absent", async (mode) => {
		const { report } = await verify(expectation(mode), snapshot({}));
		expect(
			report.checks.find((check) => check.id.endsWith(":height")),
		).toMatchObject({
			verdict: "FAIL",
			detail: expect.stringMatching(/360.*180/),
		});
		expect(perTitleUnverifiedChecks(report)).toHaveLength(2);
	});

	it("does not guess whether legacy TEMPLATE dimensions were hints or fixed requirements", async () => {
		const plan = expectation();
		delete plan.muxings[0]?.perTitleStreamMode;
		const { report } = await verify(plan);
		expect(report.checks.filter((check) => check.verdict === "FAIL")).toEqual(
			[],
		);
		expect(perTitleUnverifiedChecks(report)).toEqual([
			expect.objectContaining({
				id: expect.stringMatching(/stream-mode$/),
				verdict: "SKIP",
			}),
		]);
	});

	it("retains independently known fixed geometry in a legacy expectation", async () => {
		const plan = expectation("PER_TITLE_TEMPLATE_FIXED_RESOLUTION_AND_BITRATE");
		delete plan.muxings[0]?.perTitleStreamMode;
		const { report } = await verify(plan);
		expect(report.checks.filter((check) => check.verdict === "FAIL")).toEqual([
			expect.objectContaining({
				id: expect.stringMatching(/configured-height$/),
			}),
		]);
	});

	it("retains the legacy capture UNVERIFIED boundary before looking at media", async () => {
		const capture = snapshot();
		delete capture.schemaVersion;
		delete capture.attributionVersion;
		const { population, report } = await verify(expectation(), capture);
		expect(population).toMatchObject({ status: "incomplete" });
		expect(perTitleUnverifiedChecks(report)).toContainEqual(
			expect.objectContaining({
				id: "pertitle:population",
				verdict: "SKIP",
				detail: expect.stringMatching(/legacy.*version/),
			}),
		);
		expect(
			report.checks.some((check) => check.id.startsWith("rendition:")),
		).toBe(false);
	});

	it("does not replace a known plan frame rate with a conflicting RESULT frame rate", async () => {
		const { report } = await verify(
			expectation(),
			snapshot({ width: 320, height: 180, rate: 30 }),
			{ ...probe, fps: 30 },
		);
		expect(report.checks).toContainEqual(
			expect.objectContaining({
				id: expect.stringMatching(/configured-fps$/),
				verdict: "FAIL",
				detail: expect.stringMatching(/24.*30/),
			}),
		);
	});

	it.each([
		["codec", { ...probe, videoCodec: "hevc" }],
		["fps", { ...probe, fps: 30 }],
	] as const)("still enforces a known plan %s", async (axis, media) => {
		const { report } = await verify(expectation(), snapshot({}), media);
		expect(
			report.checks.find((check) => check.id.endsWith(`:${axis}`)),
		).toMatchObject({ verdict: "FAIL" });
	});
});
