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
	validatePlan,
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
	extraObjects: string[] = [],
	adjust?: (deps: EngineDeps) => void,
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
			["out/stream.mpd", ...objects, ...extraObjects]
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
	adjust?.(deps);
	return verifyArtefacts(compileExpectedArtefacts(configured), deps);
}

function familyChecks(report: Awaited<ReturnType<typeof run>>) {
	return report.checks.filter((check) =>
		check.id.endsWith(":pertitle-video-families"),
	);
}

describe("Default DASH per-period Per-Title RESULT witnesses", () => {
	it("accepts the captured progressive WebM type for an on-demand Per-Title RESULT", async () => {
		const configured = encodingPlanSchema.parse({
			...plan(),
			encodings: [{ key: "first", name: "First" }],
			ingest: plan().ingest.filter((row) => row.key === "first"),
			renditions: [
				{
					key: "first-video",
					codec: "VP9",
					encodingKey: "first",
					ingestKey: "first",
					mode: "PER_TITLE_TEMPLATE",
					height: null,
					bitrate: null,
				},
			],
			perTitle: { vp9Configuration: {} },
			muxings: [
				{
					key: "first",
					kind: "WEBM",
					streamKey: "first-video",
					progressive: true,
					filename: "video.webm",
					destination: {
						outputKey: "origin",
						path: "out/first/{height}p_{bitrate}_{uuid}/",
					},
				},
			],
			manifests: [
				{
					key: "dash",
					kind: "DASH",
					profile: "ON_DEMAND",
					generationMode: "DEFAULT",
					destination: { outputKey: "origin", path: "out/" },
				},
			],
		});
		// Imported provider metadata can be inspected without enabling this execution topology.
		expect(
			validatePlan(configured).some(
				(issue) =>
					issue.code === "PLAN_MANIFEST_DETAIL_INVALID" &&
					issue.message === "Progressive WebM requires a standard video stream",
			),
		).toBe(true);
		const view = capture();
		view.snapshot.streams.splice(1);
		const result = view.snapshot.streams[0],
			muxing = result?.muxings[0];
		if (!result || !muxing) throw new Error("capture missing");
		result.codecType = "VP9";
		muxing.muxingType = "PROGRESSIVE_WEBM";
		muxing.filename = "video.webm";
		view.snapshot.scan.resultsCaptured = 1;
		view.snapshot.scan.muxingsListed = 1;
		view.snapshot.scan.templatesDeclared = 1;
		view.snapshot.scan.templatesListed = 1;
		const text =
			'<MPD type="static" mediaPresentationDuration="PT12S"><Period><AdaptationSet contentType="video" mimeType="video/webm" codecs="vp09.00.10.08"><Representation id="video" height="720" width="1280" bandwidth="2000000"><BaseURL>first/720p_2000000_first/video.webm</BaseURL><SegmentBase indexRange="0-100"/></Representation></AdaptationSet></Period></MPD>';
		const report = await run(
			configured,
			view,
			text,
			false,
			["out/first/720p_2000000_first/video.webm"],
			(deps) => {
				deps.probe = async () => ({
					videoCodec: "vp9",
					height: 720,
					durationSec: 12,
				});
			},
		);
		expect(report.checks.filter((row) => row.verdict === "FAIL")).toEqual([]);
		expect(
			report.checks.find(
				(row) =>
					row.id ===
					"manifest:dash:period:0:pertitle-result:result-first:present",
			)?.verdict,
		).toBe("PASS");
	});
	it.each([
		"implicit",
		"explicit",
		"codec-condition",
	] as const)("accepts a pruned flexible template in a %s period", async (periodKind) => {
		const configured = plan(),
			manifest = configured.manifests[0];
		const template = configured.renditions[0],
			muxing = configured.muxings[0];
		if (manifest?.kind !== "DASH" || template?.codec !== "H264" || !muxing)
			throw new Error("fixture missing");
		configured.renditions.push({ ...template, key: "pruned", height: 540 });
		configured.muxings.push({
			...muxing,
			key: "pruned",
			streamKey: "pruned",
			destination: { outputKey: "origin", path: "out/pruned/{uuid}/" },
		});
		manifest.defaultPeriods = [{ encodingKeys: ["first"] }];
		const period = manifest.defaultPeriods[0];
		if (!period) throw new Error("period missing");
		if (periodKind === "implicit") delete manifest.defaultPeriods;
		if (periodKind === "codec-condition")
			period.adaptationSets = [
				{
					type: "CONDITION",
					attribute: "video.codec",
					operator: "==",
					value: "H264",
				},
			];
		const report = await run(
			configured,
			capture(),
			mpd(video("first", "avc1.64001f")),
		);
		expect(report.checks.filter((row) => row.verdict === "FAIL")).toEqual([]);
		expect(familyChecks(report).map((row) => row.verdict)).toEqual(["PASS"]);
	});
	it("does not treat an absent fixed template as a pruned flexible template", async () => {
		const configured = plan(),
			template = configured.renditions[0],
			muxing = configured.muxings[0];
		if (template?.codec !== "H264" || !muxing)
			throw new Error("fixture missing");
		configured.renditions.push({
			...template,
			key: "required",
			mode: "PER_TITLE_TEMPLATE_FIXED_RESOLUTION",
			height: 540,
		});
		configured.muxings.push({
			...muxing,
			key: "required",
			streamKey: "required",
			destination: { outputKey: "origin", path: "out/required/{uuid}/" },
		});
		expect(
			(await run(configured)).checks.some((row) => row.verdict === "FAIL"),
		).toBe(true);
	});
	it.each([
		false,
		true,
	])("binds each selected RESULT rather than allowing two aliases of one (omit=%s)", async (omit) => {
		const configured = plan(),
			manifest = configured.manifests[0];
		if (manifest?.kind !== "DASH") throw new Error("fixture missing");
		manifest.defaultPeriods = [{ encodingKeys: ["first"] }];
		const view = capture(),
			original = view.snapshot.streams[0];
		if (!original?.muxings[0]) throw new Error("capture missing");
		const extra = structuredClone(original);
		extra.streamId = "result-first-extra";
		const extraMuxing = extra.muxings[0],
			extraOutput = extraMuxing?.outputs[0];
		if (!extraMuxing || !extraOutput) throw new Error("extra output missing");
		extraMuxing.muxingId = "extra-muxing";
		extraOutput.outputPath = "out/first/720p_2000000_first-extra/";
		view.snapshot.streams.push(extra);
		view.snapshot.scan.resultsCaptured++;
		view.snapshot.scan.muxingsListed++;
		view.snapshot.scan.streamsListed++;
		const body = video("first", "avc1.64001f");
		const alternate = body
			.replace('id="video"', 'id="another"')
			.replace(
				/720p_2000000_first\//g,
				omit ? "720p_2000000_first/" : "720p_2000000_first-extra/",
			);
		const objects = ["init.mp4", "seg_1.m4s", "seg_2.m4s"].map(
			(name) => `out/first/720p_2000000_first-extra/${name}`,
		);
		const report = await run(
			configured,
			view,
			mpd(body + alternate),
			false,
			objects,
		);
		if (omit)
			expect(report.checks.some((row) => row.verdict === "FAIL")).toBe(true);
		else
			expect(report.checks.filter((row) => row.verdict === "FAIL")).toEqual([]);
	});
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
