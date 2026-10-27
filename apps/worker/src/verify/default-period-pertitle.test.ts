import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	compileExpectedArtefacts,
	encodingPlanSchema,
	PER_TITLE_ATTRIBUTION_VERSION,
	PER_TITLE_SCHEMA_VERSION,
	type PerTitleResultsView,
	perTitleActualPopulations,
	perTitleActualVideoFamilies,
} from "@bitovp/core";
import { describe, expect, it } from "vitest";
import { parseDashText } from "./adapters";
import { type EngineDeps, verifyArtefacts } from "./engine";

function plan() {
	const base = encodingPlanSchema.parse(
		JSON.parse(
			readFileSync(
				join(
					import.meta.dirname,
					"../../../../packages/core/src/plan/__fixtures__/pertitle-h264-fmp4-ts-dash-hls-on-aws.plan.json",
				),
				"utf8",
			),
		),
	);
	const input = base.ingest[0];
	if (!input) throw new Error("missing input fixture");
	return encodingPlanSchema.parse({
		...base,
		qc: undefined,
		encodings: ["first", "second"].map((key) => ({ key, name: key })),
		ingest: ["first", "second"].map((key) => ({
			...input,
			key,
			encodingKey: key,
		})),
		renditions: ["H264", "H265"].map((codec, index) => ({
			key: index ? "second-video" : "first-video",
			codec,
			encodingKey: index ? "second" : "first",
			ingestKey: index ? "second" : "first",
			mode: "PER_TITLE_TEMPLATE",
			height: null,
			bitrate: null,
		})),
		muxings: ["first", "second"].map((key) => ({
			key,
			kind: "FMP4",
			streamKey: `${key}-video`,
			segmentLength: 6,
			segmentNaming: "seg_%number%.m4s",
			initSegmentName: "init.mp4",
			destination: {
				outputKey: "origin",
				path: `out/${key}/{height}p_{bitrate}_{uuid}`,
			},
		})),
		manifests: [
			{
				key: "dash",
				kind: "DASH",
				profile: "LIVE",
				generationMode: "DEFAULT",
				destination: { outputKey: "origin", path: "out/" },
				defaultPeriods: ["first", "second"].map((key) => ({
					encodingKeys: [key],
				})),
			},
		],
	});
}

function capture(): Extract<
	PerTitleResultsView,
	{ origin: "step" | "snapshot" }
> {
	return {
		origin: "step",
		snapshot: {
			capturedAt: "2026-10-27T00:00:00.000Z",
			schemaVersion: PER_TITLE_SCHEMA_VERSION,
			attributionVersion: PER_TITLE_ATTRIBUTION_VERSION,
			streams: ["first", "second"].map((key, index) => ({
				streamId: `result-${key}`,
				templateRendition: `${key}-video`,
				mode: "PER_TITLE_RESULT",
				codecType: index ? "H265" : "H264",
				params: { height: 720, bitrate: 2_000_000 },
				muxings: [
					{
						muxingId: `result-muxing-${key}`,
						muxingType: "FMP4",
						outputs: [
							{
								outputId: "provider-origin",
								outputPath: `out/${key}/720p_2000000_${key}/`,
							},
						],
						drm: [],
					},
				],
			})),
			scan: {
				streamsListed: 4,
				templatesListed: 2,
				templatesDeclared: 2,
				resultsCaptured: 2,
				muxingsListed: 2,
				complete: true,
				codecConfigErrors: 0,
				unattributed: 0,
			},
		},
	};
}

const video = (key: string, codec: string) =>
	`<AdaptationSet contentType="video" mimeType="video/mp4" codecs="${codec}"><Representation id="video" height="720" width="1280" bandwidth="2000000"><SegmentTemplate initialization="${key}/720p_2000000_${key}/init.mp4" media="${key}/720p_2000000_${key}/seg_$Number$.m4s" duration="6" startNumber="1"/></Representation></AdaptationSet>`;
const mpd = (...bodies: string[]) =>
	`<MPD type="static" mediaPresentationDuration="PT24S">${bodies.map((body, index) => `<Period id="p${index}" start="PT${index * 12}S" duration="PT12S">${body}</Period>`).join("")}</MPD>`;
const healthyMpd = () =>
	mpd(video("first", "avc1.64001f"), video("second", "hvc1.1.6.L93"));

async function run(
	configured = plan(),
	view: PerTitleResultsView = capture(),
	text = healthyMpd(),
	legacy = false,
) {
	const objects = ["first", "second"].flatMap((key) =>
		["init.mp4", "seg_1.m4s", "seg_2.m4s"].map(
			(name) => `out/${key}/720p_2000000_${key}/${name}`,
		),
	);
	const population = perTitleActualPopulations(view);
	if (legacy && population.status === "complete")
		for (const result of population.results) delete result.codecType;
	const deps: EngineDeps = {
		listAll: async (_output, prefix) =>
			["out/stream.mpd", ...objects]
				.filter((key) => key.startsWith(prefix))
				.map((key) => ({ key, size: 1024 })),
		readText: async () => text,
		fetchObject: async (_output, key) => key,
		fetchConcatenated: async (_output, keys) => keys.join("+"),
		probe: async (path) => ({
			videoCodec: path.includes("/second/") ? "hevc" : "h264",
			height: 720,
			durationSec: 12,
		}),
		scanBoxes: async () => ({ psshSystemIds: [] }),
		parseDash: parseDashText,
		parseHls: async () => ({ variants: [], media: [] }),
		perTitleActual: perTitleActualVideoFamilies(view),
		perTitlePopulations: population,
		providerOutputIds: { origin: "provider-origin" },
	};
	return verifyArtefacts(compileExpectedArtefacts(configured), deps);
}

function familyChecks(report: Awaited<ReturnType<typeof run>>) {
	return report.checks.filter((check) =>
		check.id.endsWith(":pertitle-video-families"),
	);
}

describe("Default DASH per-period Per-Title RESULT witnesses", () => {
	it("binds different encodings' complete actual populations to their own periods", async () => {
		const report = await run();
		expect(familyChecks(report).map((check) => check.verdict)).toEqual([
			"PASS",
			"PASS",
		]);
		expect(report.checks.filter((check) => check.verdict === "FAIL")).toEqual(
			[],
		);
	});
	it("also scopes conditions that select different codecs in one encoding", async () => {
		const configured = plan();
		for (const row of configured.renditions) row.encodingKey = "first";
		const manifest = configured.manifests[0];
		if (manifest?.kind !== "DASH") throw new Error("missing DASH");
		manifest.defaultPeriods = ["H264", "H265"].map((codec) => ({
			encodingKeys: ["first"],
			adaptationSets: [
				{
					type: "CONDITION",
					attribute: "video.codec",
					operator: "==",
					value: codec,
				},
			],
		}));
		expect(
			familyChecks(await run(configured)).map((check) => check.verdict),
		).toEqual(["PASS", "PASS"]);
	});
	it("rejects a wrong captured codec instead of replacing it with the template's declared codec", async () => {
		const view = capture();
		const result = view.snapshot.streams[0];
		if (!result) throw new Error("missing result");
		result.codecType = "H265";
		expect(familyChecks(await run(plan(), view))[0]?.verdict).toBe("FAIL");
	});
	it("keeps known codec and count checks when a selected encoding has no captured results", async () => {
		const view = capture();
		view.snapshot.streams.splice(0, 1);
		view.snapshot.scan.resultsCaptured = 1;
		const report = await run(plan(), view);
		expect(familyChecks(report).map((check) => check.verdict)).toEqual([
			"SKIP",
			"PASS",
		]);
		expect(familyChecks(report)[0]?.detail).toContain("UNVERIFIED");
		const missing = await run(
			plan(),
			view,
			mpd("", video("second", "hvc1.1.6.L93")),
		);
		expect(
			missing.checks.find((check) =>
				check.id.endsWith(":period:0:video-representations"),
			)?.verdict,
		).toBe("FAIL");
		const wrong = await run(
			plan(),
			view,
			mpd(video("first", "hvc1.1.6.L93"), video("second", "hvc1.1.6.L93")),
		);
		expect(
			wrong.checks.some(
				(check) => check.id.includes(":period:0:") && check.verdict === "FAIL",
			),
		).toBe(true);
	});
	it("does not borrow a same-codec result attributed to another encoding", async () => {
		const view = capture();
		const result = view.snapshot.streams[0];
		if (!result) throw new Error("missing result");
		result.templateRendition = "foreign-video";
		expect(familyChecks(await run(plan(), view))[0]?.verdict).toBe("SKIP");
	});
	it.each([
		"unattributed",
		"untyped",
		"legacy",
		"incomplete",
		"absent",
	] as const)("reports %s actual identity as unverified without certifying a global union", async (kind) => {
		let view: PerTitleResultsView = capture();
		if (view.origin !== "step") throw new Error("missing capture");
		const result = view.snapshot.streams[0];
		if (!result) throw new Error("missing result");
		if (kind === "unattributed") delete result.templateRendition;
		if (kind === "untyped") delete result.codecType;
		if (kind === "incomplete") view.snapshot.scan.complete = false;
		if (kind === "absent") view = { origin: "absent" };
		const checks = familyChecks(
			await run(plan(), view, healthyMpd(), kind === "legacy"),
		);
		expect(checks[0]?.verdict).toBe("SKIP");
		expect(checks[0]?.detail).toContain("UNVERIFIED");
	});
	it("leaves only the actual-family witness unverified for runtime selection conditions", async () => {
		const configured = plan();
		const manifest = configured.manifests[0];
		if (manifest?.kind !== "DASH" || !manifest.defaultPeriods?.[0])
			throw new Error("missing DASH");
		manifest.defaultPeriods[0].adaptationSets = [
			{
				type: "CONDITION",
				attribute: "video.height",
				operator: ">=",
				value: "720",
			},
		];
		const report = await run(configured);
		expect(familyChecks(report).map((check) => check.verdict)).toEqual([
			"SKIP",
			"PASS",
		]);
		expect(report.checks.filter((check) => check.verdict === "FAIL")).toEqual(
			[],
		);
		const wrong = await run(
			configured,
			capture(),
			mpd(video("first", "hvc1.1.6.L93"), video("second", "hvc1.1.6.L93")),
		);
		expect(
			wrong.checks.some(
				(check) => check.id.includes(":period:0:") && check.verdict === "FAIL",
			),
		).toBe(true);
	});
	it("preserves single-period selection and the existing manual manifest witness behavior", async () => {
		const configured = plan();
		const manifest = configured.manifests[0];
		if (manifest?.kind !== "DASH") throw new Error("missing DASH");
		manifest.defaultPeriods = [{ encodingKeys: ["first"] }];
		expect(
			familyChecks(
				await run(configured, capture(), mpd(video("first", "avc1.64001f"))),
			).map((check) => check.verdict),
		).toEqual(["PASS"]);
		manifest.generationMode = "MANUAL";
		delete manifest.defaultPeriods;
		const report = await run(
			configured,
			capture(),
			mpd(video("first", "avc1.64001f") + video("second", "hvc1.1.6.L93")),
			true,
		);
		expect(familyChecks(report).map((check) => check.verdict)).toEqual([
			"PASS",
		]);
	});
});
