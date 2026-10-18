import type {
	ExpectedArtefacts,
	ExpectedMuxing,
	PerTitleActualPopulations,
} from "@bitovp/core";
import { describe, expect, it } from "vitest";
import type { EngineDeps, ObjectEntry } from "./engine";
import { verifyArtefacts } from "./engine";

const pathPattern = (pattern: string) => ({
	pattern,
	prefix: pattern.slice(0, pattern.indexOf("{")),
	templated: true,
});

const muxing = (key: string): ExpectedMuxing => ({
	muxingKey: key,
	streamKey: key,
	renditionKey: key,
	container: "FMP4_SEGMENTED",
	outputKey: "origin",
	dir: pathPattern("video/shared/{height}p_{bitrate}_{uuid}/"),
	initSegment: "init.mp4",
	segmentNaming: "seg_%number%.m4s",
	segmentLengthSec: 6,
	video: { height: 360, codec: "H264", bitrate: null },
	perTitle: true,
	perTitleMode: "FIXED",
});

const expected = (
	muxings: ExpectedMuxing[],
	overrides: Partial<ExpectedArtefacts> = {},
): ExpectedArtefacts => ({
	planName: "actual population",
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

function engineDeps(
	objects: ObjectEntry[],
	overrides: Partial<EngineDeps>,
): EngineDeps & { calls: string[] } {
	const calls: string[] = [];
	return {
		calls,
		listAll: async (outputKey, prefix) => {
			calls.push(`${outputKey}:${prefix}`);
			return objects.filter((object) => object.key.startsWith(prefix));
		},
		fetchObject: async (_outputKey, key) => key,
		fetchConcatenated: async (_outputKey, keys) => keys.join("+"),
		probe: async () => ({ height: 360, videoCodec: "h264" }),
		scanBoxes: async () => ({ psshSystemIds: [] }),
		readText: async () => "",
		parseHls: async () => ({ variants: [], media: [] }),
		parseDash: async () => ({ representations: [], periods: 0 }),
		...overrides,
	};
}

const twoResults: PerTitleActualPopulations = {
	status: "complete",
	results: [
		{ streamId: "stream-a", templateRendition: "fixed-a" },
		{ streamId: "stream-b", templateRendition: "fixed-b" },
	],
	qc: [
		{
			streamId: "stream-a",
			templateRendition: "fixed-a",
			variant: "360p_400000_a",
			mirrors: [],
		},
		{
			streamId: "stream-b",
			templateRendition: "fixed-b",
			variant: "720p_1800000_b",
			mirrors: [],
		},
	],
	deliveryMuxings: [
		{
			streamId: "stream-a",
			templateRendition: "fixed-a",
			muxingId: "mux-a",
			muxingType: "FMP4",
			legs: [
				{
					streamId: "stream-a",
					templateRendition: "fixed-a",
					muxingId: "mux-a",
					muxingType: "FMP4",
					outputId: "provider-origin",
					resolvedPath: "video/shared/360p_400000_a/",
				},
			],
		},
		{
			streamId: "stream-b",
			templateRendition: "fixed-b",
			muxingId: "mux-b",
			muxingType: "FMP4",
			legs: [
				{
					streamId: "stream-b",
					templateRendition: "fixed-b",
					muxingId: "mux-b",
					muxingType: "FMP4",
					outputId: "provider-origin",
					resolvedPath: "video/shared/720p_1800000_b/",
				},
			],
		},
	],
};

describe("verifyArtefacts — per-title actual RESULT population", () => {
	it("never reports an empty eligible/checked output-leg set as a closed delivery", async () => {
		const flexible = {
			...muxing("flexible"),
			perTitleMode: "TEMPLATE" as const,
		};
		const deps = engineDeps([], {
			perTitlePopulations: {
				status: "complete",
				results: [],
				qc: [],
				deliveryMuxings: [],
			},
			providerOutputIds: { origin: "provider-origin" },
		});
		const report = await verifyArtefacts(expected([flexible]), deps);

		expect(
			report.checks.find((check) => check.id === "pertitle:delivery:closure"),
		).toMatchObject({ verdict: "FAIL" });
	});

	it("does not PASS a flexible template as legitimately pruned while attribution is incomplete", async () => {
		const flexible = {
			...muxing("flexible"),
			perTitleMode: "TEMPLATE" as const,
		};
		const deps = engineDeps([], {
			perTitlePopulations: {
				status: "complete",
				results: [{ streamId: "result-u" }],
				qc: [{ streamId: "result-u", variant: "result-u", mirrors: [] }],
				deliveryMuxings: [],
			},
			providerOutputIds: { origin: "provider-origin" },
		});
		const report = await verifyArtefacts(expected([flexible]), deps);

		expect(
			report.checks.find((check) => check.id === "pertitle:template:flexible"),
		).toMatchObject({ verdict: "SKIP" });
		expect(
			report.checks.find((check) => check.id === "pertitle:delivery:closure"),
		).toMatchObject({ verdict: "FAIL" });
	});

	it("inspects each provider output leg once at its resolved path, never once per shared template prefix", async () => {
		const objects = ["360p_400000_a", "720p_1800000_b"].flatMap((variant) => [
			{ key: `video/shared/${variant}/init.mp4`, size: 100 },
			{ key: `video/shared/${variant}/seg_1.m4s`, size: 1_000 },
		]);
		const deps = engineDeps(objects, {
			perTitlePopulations: twoResults,
			providerOutputIds: { origin: "provider-origin" },
		});
		const report = await verifyArtefacts(
			expected([muxing("fixed-a"), muxing("fixed-b")]),
			deps,
		);

		expect(report.checks.filter((check) => check.verdict === "FAIL")).toEqual(
			[],
		);
		expect(deps.calls).toEqual([
			"origin:video/shared/360p_400000_a/",
			"origin:video/shared/720p_1800000_b/",
		]);
		expect(
			report.checks
				.filter((check) => check.id.startsWith("pertitle:delivery:fixed-"))
				.map((check) => check.id),
		).toEqual([
			"pertitle:delivery:fixed-a:stream-a:mux-a:clear:provider-origin",
			"pertitle:delivery:fixed-b:stream-b:mux-b:clear:provider-origin",
		]);
		expect(
			report.checks.find((check) => check.id === "pertitle:delivery:closure"),
		).toMatchObject({ verdict: "PASS" });
		expect(
			report.checks.find((check) => check.id === "pertitle:delivery:reuse"),
		).toMatchObject({ verdict: "PASS" });
	});

	it("turns an incomplete snapshot into UNVERIFIED and emits no per-title artefact PASS", async () => {
		const deps = engineDeps([], {
			perTitlePopulations: { status: "incomplete", reason: "legacy snapshot" },
			providerOutputIds: { origin: "provider-origin" },
		});
		const report = await verifyArtefacts(expected([muxing("fixed-a")]), deps);

		expect(deps.calls).toEqual([]);
		expect(report.checks).toContainEqual({
			id: "pertitle:population",
			area: "muxing",
			verdict: "SKIP",
			detail: "UNVERIFIED per-title RESULT population: legacy snapshot",
		});
		expect(
			report.checks.some(
				(check) =>
					check.id.startsWith("pertitle:delivery:") && check.verdict === "PASS",
			),
		).toBe(false);
	});

	it("keeps output-leg closure UNVERIFIED when provider output UUIDs are absent", async () => {
		const deps = engineDeps([], {
			perTitlePopulations: twoResults,
			providerOutputIds: {},
		});
		const report = await verifyArtefacts(
			expected([muxing("fixed-a"), muxing("fixed-b")]),
			deps,
		);

		expect(deps.calls).toEqual([]);
		expect(
			report.checks.find((check) => check.id === "pertitle:delivery:closure"),
		).toMatchObject({
			verdict: "SKIP",
			detail: expect.stringMatching(/^UNVERIFIED output-leg closure/),
		});
		expect(
			report.checks.some(
				(check) =>
					check.id.startsWith("pertitle:delivery:fixed-") &&
					check.verdict === "PASS",
			),
		).toBe(false);
	});

	it("checks one QC mirror per RESULT even when each RESULT has a delivery-mirror candidate", async () => {
		const populations: PerTitleActualPopulations = {
			...twoResults,
			status: "complete",
			deliveryMuxings: [],
			qc: [
				{
					streamId: "stream-a",
					templateRendition: "fixed-a",
					variant: "360p_400000_a",
					mirrors: [
						{
							streamId: "stream-a",
							templateRendition: "fixed-a",
							muxingId: "qc-a",
							muxingType: "MP4",
							filename: "fixed-a.mp4",
							outputId: "provider-origin",
							resolvedPath: "video/shared/360p_400000_a/qc/",
						},
						{
							streamId: "stream-a",
							templateRendition: "fixed-a",
							muxingId: "qc-a",
							muxingType: "MP4",
							filename: "fixed-a.mp4",
							outputId: "provider-mirror",
							resolvedPath: "video/shared/360p_400000_a/qc/",
						},
					],
				},
			],
			results: [{ streamId: "stream-a", templateRendition: "fixed-a" }],
		};
		const deps = engineDeps(
			[{ key: "video/shared/360p_400000_a/qc/fixed-a.mp4", size: 200 }],
			{
				perTitlePopulations: populations,
				providerOutputIds: {
					origin: "provider-origin",
					mirror: "provider-mirror",
				},
			},
		);
		const report = await verifyArtefacts(
			expected([muxing("fixed-a")], {
				outputKeys: ["origin", "mirror"],
				deliveryMirrorOutputKeys: ["mirror"],
				qc: {
					vmaf: true,
					psnr: false,
					mirrorRenditionKeys: ["fixed-a"],
					mirrorDirSuffix: "qc/",
					mirrors: [
						{
							renditionKey: "fixed-a",
							outputKey: "origin",
							dir: pathPattern("video/shared/{height}p_{bitrate}_{uuid}/qc/"),
							filename: "fixed-a.mp4",
						},
					],
				},
			}),
			deps,
		);

		expect(deps.calls).toEqual(["origin:video/shared/360p_400000_a/qc/"]);
		expect(
			report.checks.find((check) => check.id === "qc:pertitle:closure"),
		).toMatchObject({ verdict: "PASS" });
		expect(
			report.checks.filter(
				(check) =>
					check.id === "qc:pertitle:unit:fixed-a:stream-a:360p_400000_a",
			),
		).toHaveLength(1);
	});

	it("does not close a QC unit when storage cannot prove a nonzero byte size", async () => {
		const populations: PerTitleActualPopulations = {
			status: "complete",
			results: [{ streamId: "stream-a", templateRendition: "fixed-a" }],
			qc: [
				{
					streamId: "stream-a",
					templateRendition: "fixed-a",
					variant: "360p_400000_a",
					mirrors: [
						{
							streamId: "stream-a",
							templateRendition: "fixed-a",
							muxingId: "qc-a",
							muxingType: "MP4",
							filename: "fixed-a.mp4",
							outputId: "provider-origin",
							resolvedPath: "video/shared/360p_400000_a/qc/",
						},
					],
				},
			],
			deliveryMuxings: [],
		};
		const deps = engineDeps(
			[{ key: "video/shared/360p_400000_a/qc/fixed-a.mp4" }],
			{
				perTitlePopulations: populations,
				providerOutputIds: { origin: "provider-origin" },
			},
		);
		const report = await verifyArtefacts(
			expected([muxing("fixed-a")], {
				qc: {
					vmaf: true,
					psnr: false,
					mirrorRenditionKeys: ["fixed-a"],
					mirrorDirSuffix: "qc/",
					mirrors: [
						{
							renditionKey: "fixed-a",
							outputKey: "origin",
							dir: pathPattern("video/shared/{height}p_{bitrate}_{uuid}/qc/"),
							filename: "fixed-a.mp4",
						},
					],
				},
			}),
			deps,
		);

		expect(
			report.checks.find((check) => check.id.endsWith(":bytes")),
		).toMatchObject({ verdict: "SKIP" });
		expect(
			report.checks.find((check) => check.id === "qc:pertitle:closure"),
		).toMatchObject({ verdict: "FAIL" });
	});

	it("does not close the QC population on an attributed subset while a flexible RESULT is unattributed", async () => {
		const flexible = {
			...muxing("flexible"),
			perTitleMode: "TEMPLATE" as const,
		};
		const populations: PerTitleActualPopulations = {
			status: "complete",
			results: [
				{ streamId: "stream-fixed", templateRendition: "fixed" },
				{ streamId: "stream-flexible" },
			],
			qc: [
				{
					streamId: "stream-fixed",
					templateRendition: "fixed",
					variant: "360p_400000_fixed",
					mirrors: [
						{
							streamId: "stream-fixed",
							templateRendition: "fixed",
							muxingId: "qc-fixed",
							muxingType: "MP4",
							filename: "fixed.mp4",
							outputId: "provider-origin",
							resolvedPath: "video/shared/360p_400000_fixed/qc/",
						},
					],
				},
				{
					streamId: "stream-flexible",
					variant: "1080p_4000000_flexible",
					mirrors: [],
				},
			],
			deliveryMuxings: [],
		};
		const deps = engineDeps(
			[
				{
					key: "video/shared/360p_400000_fixed/qc/fixed.mp4",
					size: 200,
				},
			],
			{
				perTitlePopulations: populations,
				providerOutputIds: { origin: "provider-origin" },
			},
		);
		const report = await verifyArtefacts(
			expected([muxing("fixed"), flexible], {
				qc: {
					vmaf: true,
					psnr: false,
					mirrorRenditionKeys: ["fixed", "flexible"],
					mirrorDirSuffix: "qc/",
					mirrors: [
						{
							renditionKey: "fixed",
							outputKey: "origin",
							dir: pathPattern("video/shared/{height}p_{bitrate}_{uuid}/qc/"),
							filename: "fixed.mp4",
						},
						{
							renditionKey: "flexible",
							outputKey: "origin",
							dir: pathPattern("video/shared/{height}p_{bitrate}_{uuid}/qc/"),
							filename: "flexible.mp4",
						},
					],
				},
			}),
			deps,
		);

		expect(
			report.checks.find((check) => check.id === "qc:pertitle:result-set"),
		).toMatchObject({ verdict: "FAIL" });
		expect(
			report.checks.find((check) => check.id === "qc:pertitle:closure"),
		).toMatchObject({ verdict: "FAIL" });
	});

	it("never reports an empty provider RESULT/QC set as closed", async () => {
		const flexible = {
			...muxing("flexible"),
			perTitleMode: "TEMPLATE" as const,
		};
		const deps = engineDeps([], {
			perTitlePopulations: {
				status: "complete",
				results: [],
				qc: [],
				deliveryMuxings: [],
			},
			providerOutputIds: { origin: "provider-origin" },
		});
		const report = await verifyArtefacts(
			expected([flexible], {
				qc: {
					vmaf: true,
					psnr: false,
					mirrorRenditionKeys: ["flexible"],
					mirrorDirSuffix: "qc/",
					mirrors: [
						{
							renditionKey: "flexible",
							outputKey: "origin",
							dir: pathPattern("video/shared/{height}p_{bitrate}_{uuid}/qc/"),
							filename: "flexible.mp4",
						},
					],
				},
			}),
			deps,
		);

		expect(
			report.checks.find((check) => check.id === "qc:pertitle:result-set"),
		).toMatchObject({ verdict: "FAIL" });
		expect(
			report.checks.find((check) => check.id === "qc:pertitle:closure"),
		).toMatchObject({ verdict: "FAIL" });
	});

	it.each([
		{
			codec: "H264",
			keys: ["v180", "v360-300", "v360-600", "v540", "v720", "v1080"],
		},
		{
			codec: "H265",
			keys: ["v180", "v480-210", "v480-420", "v540", "v720", "v1080"],
		},
	])("closes all six paid $codec RESULT/QC identities, including both flexible templates", async ({
		keys,
	}) => {
		const variants = Object.fromEntries(
			keys.map((key, index) => [
				key,
				`${180 + index * 180}p_${400_000 + index * 400_000}_${key}`,
			]),
		);
		const populations: PerTitleActualPopulations = {
			status: "complete",
			results: keys.map((key) => ({
				streamId: `stream-${key}`,
				templateRendition: key,
			})),
			qc: keys.map((key) => ({
				streamId: `stream-${key}`,
				templateRendition: key,
				variant: variants[key] as string,
				mirrors: [
					{
						streamId: `stream-${key}`,
						templateRendition: key,
						muxingId: `qc-${key}`,
						muxingType: "MP4",
						filename: `${key}.mp4`,
						outputId: "provider-origin",
						resolvedPath: `video/shared/${variants[key]}/qc/`,
					},
				],
			})),
			deliveryMuxings: [],
		};
		const deps = engineDeps(
			keys.map((key) => ({
				key: `video/shared/${variants[key]}/qc/${key}.mp4`,
				size: 200,
			})),
			{
				perTitlePopulations: populations,
				providerOutputIds: { origin: "provider-origin" },
			},
		);
		const report = await verifyArtefacts(
			expected(
				keys.map((key) => ({
					...muxing(key),
					perTitleMode:
						key === "v180" || key === "v1080"
							? ("TEMPLATE" as const)
							: ("FIXED" as const),
				})),
				{
					qc: {
						vmaf: true,
						psnr: false,
						mirrorRenditionKeys: keys,
						mirrorDirSuffix: "qc/",
						mirrors: keys.map((key) => ({
							renditionKey: key,
							outputKey: "origin",
							dir: pathPattern("video/shared/{height}p_{bitrate}_{uuid}/qc/"),
							filename: `${key}.mp4`,
						})),
					},
				},
			),
			deps,
		);

		expect(
			report.checks.find((check) => check.id === "qc:pertitle:result-set"),
		).toMatchObject({ verdict: "PASS" });
		expect(
			report.checks.find((check) => check.id === "qc:pertitle:closure"),
		).toMatchObject({ verdict: "PASS" });
		expect(
			report.checks.filter(
				(check) =>
					check.id.startsWith("qc:pertitle:unit:") &&
					!check.id.includes(":present") &&
					!check.id.includes(":bytes") &&
					!check.id.includes(":video") &&
					!check.id.includes(":duplicate"),
			),
		).toHaveLength(6);
	});
});
