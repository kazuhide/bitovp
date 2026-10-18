import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	compileExpectedArtefacts,
	type ExpectedArtefacts,
	encodingPlanSchema,
	type ManifestRenditionTopology,
	type PerTitleActualVideoFamilies,
} from "@bitovp/core";
import { describe, expect, it } from "vitest";
import { parseDashText, parseHlsText } from "./adapters";
import {
	bindDashTopology,
	bindHlsTopology,
	ReportBuilder,
	type TopologyContext,
} from "./engine";

/**
 * Manifest binding as the paid re-audit specified it (audit 5c3d97ca §14.5
 * VF-02 + VF-03, row 284), driven through the REAL player-family parsers so the
 * fixtures below are the shapes Bitmovin writes, not a fake's.
 *
 *   HIGH-3  a per-title manifest compiled to an EMPTY video family set, so the
 *           DASH AdaptationSet check FAILed a correct H.264/H.265 MPD as "no
 *           plan family" — the only FAIL in the paid Per-Title outputs. The
 *           family is a plan value on every rendition; only the geometry is the
 *           encoder's. The plan, the RESULT capture and the manifest are now
 *           compared three ways, and a missing capture is an explicit SKIP.
 *   HIGH-5  `nearestByBandwidth` never consumed the child it bound, so one
 *           observed row satisfied every same-height rendition. Binding is now a
 *           one-to-one assignment on the row's identity (URI + AUDIO for HLS,
 *           kind + height / family for DASH), with missing, unexpected and
 *           duplicate rows each a verdict of its own.
 */

const FIXTURES = join(
	import.meta.dirname,
	"../../../../packages/core/src/plan/__fixtures__",
);
const compileFixture = (name: string): ExpectedArtefacts =>
	compileExpectedArtefacts(
		encodingPlanSchema.parse(
			JSON.parse(readFileSync(join(FIXTURES, `${name}.plan.json`), "utf8")),
		),
	);
const manifestOf = (
	expected: ExpectedArtefacts,
	kind: "HLS" | "DASH",
): { topology: ManifestRenditionTopology; ctx: TopologyContext } => {
	const m = expected.manifests.find((x) => x.kind === kind);
	if (!m?.manifestRenditions) {
		throw new Error(`the fixture compiles no ${kind} topology`);
	}
	return { topology: m.manifestRenditions, ctx: { perTitle: m.perTitle } };
};
const verdictOf = (report: ReportBuilder, id: string) =>
	report.checks.find((c) => c.id === id)?.verdict;
const detailOf = (report: ReportBuilder, id: string) =>
	report.checks.find((c) => c.id === id)?.detail ?? "";
const fails = (report: ReportBuilder) =>
	report.checks
		.filter((c) => c.verdict === "FAIL")
		.map((c) => `${c.id}: ${c.detail}`);

// ---- fixture builders, in the shapes the real parsers accept ---------------

const MPD = (inner: string) => `<?xml version="1.0" encoding="utf-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT12S" minBufferTime="PT4S" profiles="urn:mpeg:dash:profile:isoff-live:2011">
  <Period>
${inner}
  </Period>
</MPD>`;
type Rep = { id: string; bw?: number; h: number; codecs?: string };
const videoSet = (setId: string, reps: Rep[]) =>
	`    <AdaptationSet id="${setId}" contentType="video" mimeType="video/mp4" segmentAlignment="true" startWithSAP="1">
${reps
	.map(
		(r) =>
			`      <Representation id="${r.id}"${r.bw !== undefined ? ` bandwidth="${r.bw}"` : ""} width="${Math.round((r.h * 16) / 9)}" height="${r.h}" frameRate="24"${r.codecs !== undefined ? ` codecs="${r.codecs}"` : ""}>
        <SegmentTemplate media="video/${r.id}/segment_$Number$.m4s" initialization="video/${r.id}/init.mp4" duration="4" timescale="1" startNumber="0"/>
      </Representation>`,
	)
	.join("\n")}
    </AdaptationSet>`;
const audioSet = (id: string, bw: number, codecs = "mp4a.40.2") =>
	`    <AdaptationSet id="${id}-set" contentType="audio" mimeType="audio/mp4" lang="en" segmentAlignment="true">
      <Representation id="${id}" bandwidth="${bw}" audioSamplingRate="48000" codecs="${codecs}">
        <SegmentTemplate media="audio/${id}/segment_$Number$.m4s" initialization="audio/${id}/init.mp4" duration="4" timescale="1" startNumber="0"/>
      </Representation>
    </AdaptationSet>`;

type Variant = {
	uri: string;
	bw: number;
	h?: number;
	codecs: string;
	audio?: string;
};
type Media = { group: string; name: string; uri: string };
const master = (variants: Variant[], media: Media[], version = 6) =>
	[
		"#EXTM3U",
		`#EXT-X-VERSION:${version}`,
		...media.map(
			(m) =>
				`#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="${m.group}",NAME="${m.name}",LANGUAGE="en",DEFAULT=YES,AUTOSELECT=YES,URI="${m.uri}"`,
		),
		...variants.flatMap((v) => [
			`#EXT-X-STREAM-INF:BANDWIDTH=${v.bw}${v.h !== undefined ? `,RESOLUTION=${Math.round((v.h * 16) / 9)}x${v.h}` : ""},CODECS="${v.codecs}"${v.audio !== undefined ? `,AUDIO="${v.audio}"` : ""}`,
			v.uri,
		]),
		"",
	].join("\n");

const complete = (
	families: string[],
	results = families.length,
): PerTitleActualVideoFamilies => ({ status: "complete", families, results });

/** A small plan in the shape `engine.test.ts` uses, with the given renditions/muxings/manifests. */
const CRED = "11111111-1111-4111-8111-111111111111";
const planWith = (over: {
	renditions: unknown[];
	muxings: unknown[];
	manifests: unknown[];
	generation?: { timing: "JUST_IN_TIME" | "POST_ENCODING" };
}) =>
	encodingPlanSchema.parse({
		planVersion: 1,
		name: "binding",
		bitmovin: { cloudRegion: "AWS_AP_NORTHEAST_1" },
		generation: over.generation ?? { timing: "JUST_IN_TIME" },
		inputs: [
			{ key: "main", kind: "S3", name: "in", bucket: "in", credentialId: CRED },
		],
		outputs: [
			{
				key: "origin",
				kind: "S3",
				name: "out",
				bucket: "out",
				credentialId: CRED,
			},
		],
		ingest: [
			{
				key: "video",
				inputKey: "main",
				inputPath: "src.mov",
				position: 0,
				selectionMode: "VIDEO_RELATIVE",
			},
			{
				key: "audio",
				inputKey: "main",
				inputPath: "src.mov",
				position: 0,
				selectionMode: "AUDIO_RELATIVE",
			},
		],
		renditions: over.renditions,
		muxings: over.muxings,
		manifests: over.manifests,
	});
const video = (key: string, height: number, bitrate: number) => ({
	key,
	codec: "H264",
	ingestKey: "video",
	height,
	bitrate,
	rate: 24,
});
const audio = (
	key: string,
	bitrate: number,
	hlsMedia?: { groupId: string; name: string; uri: string },
) => ({
	key,
	codec: "AAC",
	ingestKey: "audio",
	bitrate,
	rate: 48_000,
	...(hlsMedia ? { hlsMedia } : {}),
});
const fmp4 = (
	key: string,
	dir: string,
	extra: Record<string, unknown> = {},
) => ({
	key,
	kind: "FMP4",
	streamKey: key,
	segmentLength: 4,
	destination: { outputKey: "origin", path: `out/${dir}/` },
	...extra,
});
const ts = (key: string, dir: string, extra: Record<string, unknown> = {}) => ({
	key: `${key}-ts`,
	kind: "TS",
	streamKey: key,
	segmentLength: 4,
	destination: { outputKey: "origin", path: `out/${dir}/` },
	...extra,
});
const HLS = (extra: Record<string, unknown> = {}) => ({
	key: "hls",
	kind: "HLS",
	manifestName: "stream.m3u8",
	destination: { outputKey: "origin", path: "out/" },
	...extra,
});
const DASH = {
	key: "dash",
	kind: "DASH",
	manifestName: "stream.mpd",
	destination: { outputKey: "origin", path: "out/" },
};

// ===========================================================================
// VF-02 — the per-title family set (HIGH-3)
// ===========================================================================

describe("per-title codec families — declared, RESULT, manifest (row 284 / HIGH-3)", () => {
	/**
	 * The paid H.264 per-title MPD: six RESULT rungs (v180 / v360-300 /
	 * v360-600 / v540 / v720 / v1080; the flexible v900 was not generated) in one
	 * AdaptationSet, beside the audio set. On main this FAILed
	 * `:adaptationset-codecs` with "no plan family", because the topology's video
	 * list is empty for per-title and the family set was derived from it.
	 */
	const H264_PER_TITLE_MPD = MPD(
		`${videoSet("v", [
			{ id: "r1080", bw: 4_021_000, h: 1080, codecs: "avc1.640028" },
			{ id: "r720", bw: 2_398_000, h: 720, codecs: "avc1.640020" },
			{ id: "r540", bw: 1_402_000, h: 540, codecs: "avc1.4d401f" },
			{ id: "r360b", bw: 603_000, h: 360, codecs: "avc1.4d401e" },
			{ id: "r360a", bw: 301_000, h: 360, codecs: "avc1.4d401e" },
			{ id: "r180", bw: 198_000, h: 180, codecs: "avc1.42c00d" },
		])}\n${audioSet("a128", 128_000)}`,
	);

	it("the paid H.264 per-title MPD binds FAIL 0 with a complete capture", async () => {
		const { topology, ctx } = manifestOf(
			compileFixture("pertitle-h264-fmp4-ts-dash-hls-on-aws"),
			"DASH",
		);
		expect(ctx.perTitle).toBe(true);
		expect(topology.declaredVideoCodecFamilies).toEqual(["H264"]);
		expect(topology.video).toEqual([]);
		const report = new ReportBuilder();
		bindDashTopology(
			report,
			"manifest:dash",
			topology,
			await parseDashText(H264_PER_TITLE_MPD),
			{ ...ctx, perTitleActual: complete(["H264"], 6) },
		);
		expect(fails(report)).toEqual([]);
		expect(verdictOf(report, "manifest:dash:adaptationset-codecs")).toBe(
			"PASS",
		);
		expect(verdictOf(report, "manifest:dash:pertitle-video-families")).toBe(
			"PASS",
		);
		expect(
			detailOf(report, "manifest:dash:representations-unexpected"),
		).toContain("6 encoder-chosen");
		expect(verdictOf(report, "manifest:dash:rep:a128:present")).toBe("PASS");
		expect(verdictOf(report, "manifest:dash:rep:a128:bandwidth")).toBe("PASS");
	});

	it("the paid H.265 per-title MPD binds FAIL 0 with a complete capture", async () => {
		const { topology, ctx } = manifestOf(
			compileFixture("pertitle-h265-fmp4-dash-hls-on-aws"),
			"DASH",
		);
		expect(topology.declaredVideoCodecFamilies).toEqual(["H265"]);
		const mpd = MPD(
			`${videoSet("v", [
				{ id: "r1080", bw: 2_803_000, h: 1080, codecs: "hvc1.1.6.L120.90" },
				{ id: "r720", bw: 1_512_000, h: 720, codecs: "hvc1.1.6.L120.90" },
				{ id: "r540", bw: 905_000, h: 540, codecs: "hvc1.1.6.L120.90" },
				{ id: "r480b", bw: 421_000, h: 480, codecs: "hvc1.1.6.L120.90" },
				{ id: "r480a", bw: 212_000, h: 480, codecs: "hvc1.1.6.L120.90" },
				{ id: "r180", bw: 96_000, h: 180, codecs: "hvc1.1.6.L120.90" },
			])}\n${audioSet("a128", 128_000)}`,
		);
		const report = new ReportBuilder();
		bindDashTopology(
			report,
			"manifest:dash",
			topology,
			await parseDashText(mpd),
			{
				...ctx,
				perTitleActual: complete(["H265"], 6),
			},
		);
		expect(fails(report)).toEqual([]);
		expect(verdictOf(report, "manifest:dash:pertitle-video-families")).toBe(
			"PASS",
		);
	});

	it("the paid H.264 per-title HLS master (video_<avgBitrate> variants) binds FAIL 0", async () => {
		const { topology, ctx } = manifestOf(
			compileFixture("pertitle-h264-fmp4-ts-dash-hls-on-aws"),
			"HLS",
		);
		expect(topology.hlsVariants).toEqual([]); // per-title: no fixed nodes
		const text = master(
			[4_021_000, 2_398_000, 1_402_000, 603_000, 301_000, 198_000].map(
				(bw, i) => ({
					uri: `video_${bw}.m3u8`,
					bw: Math.round(bw * 1.05) + 128_000,
					h: [1080, 720, 540, 360, 360, 180][i] as number,
					codecs: "avc1.640028,mp4a.40.2",
					audio: "audio",
				}),
			),
			[{ group: "audio", name: "HLS Audio Media", uri: "audio_128000.m3u8" }],
		);
		const report = new ReportBuilder();
		bindHlsTopology(
			report,
			"manifest:hls",
			topology,
			await parseHlsText(text),
			{
				...ctx,
				perTitleActual: complete(["H264"], 6),
			},
		);
		expect(fails(report)).toEqual([]);
		expect(verdictOf(report, "manifest:hls:pertitle-video-families")).toBe(
			"PASS",
		);
		expect(detailOf(report, "manifest:hls:variants-unexpected")).toContain(
			"6 encoder-chosen",
		);
		expect(verdictOf(report, "manifest:hls:media:a128:present")).toBe("PASS");
		expect(verdictOf(report, "manifest:hls:media:a128:uri")).toBe("PASS");
	});

	it("an H.264 plan whose MPD carries an AV1 AdaptationSet FAILS — by family, not by an empty set", async () => {
		const { topology, ctx } = manifestOf(
			compileFixture("pertitle-h264-fmp4-ts-dash-hls-on-aws"),
			"DASH",
		);
		const mpd = MPD(
			`${videoSet("v264", [
				{ id: "r720", bw: 2_398_000, h: 720, codecs: "avc1.640020" },
			])}\n${videoSet("vav1", [
				{ id: "r1080av1", bw: 1_900_000, h: 1080, codecs: "av01.0.08M.08" },
			])}\n${audioSet("a128", 128_000)}`,
		);
		const report = new ReportBuilder();
		bindDashTopology(
			report,
			"manifest:dash",
			topology,
			await parseDashText(mpd),
			{
				...ctx,
				perTitleActual: complete(["H264"], 1),
			},
		);
		expect(verdictOf(report, "manifest:dash:adaptationset-codecs")).toBe(
			"FAIL",
		);
		expect(detailOf(report, "manifest:dash:adaptationset-codecs")).toContain(
			"av01.0.08M.08 (no plan family)",
		);
		expect(verdictOf(report, "manifest:dash:pertitle-video-families")).toBe(
			"FAIL",
		);
		expect(detailOf(report, "manifest:dash:pertitle-video-families")).toContain(
			"different family set",
		);
		// The stray AV1 rung is also a representation the plan never asked for.
		expect(verdictOf(report, "manifest:dash:representations-unexpected")).toBe(
			"FAIL",
		);
	});

	it("the manifest is never the expectation: an MPD the capture AGREES with still FAILS when the plan declared another family", async () => {
		// Circular verification — reading the family off the MPD and handing it
		// back as the expectation — would pass this. The plan says H264.
		const { topology, ctx } = manifestOf(
			compileFixture("pertitle-h264-fmp4-ts-dash-hls-on-aws"),
			"DASH",
		);
		const mpd = MPD(
			`${videoSet("v", [
				{ id: "r720", bw: 1_512_000, h: 720, codecs: "hvc1.1.6.L120.90" },
			])}\n${audioSet("a128", 128_000)}`,
		);
		const report = new ReportBuilder();
		bindDashTopology(
			report,
			"manifest:dash",
			topology,
			await parseDashText(mpd),
			{
				...ctx,
				perTitleActual: complete(["H265"], 1),
			},
		);
		expect(verdictOf(report, "manifest:dash:adaptationset-codecs")).toBe(
			"FAIL",
		);
		expect(verdictOf(report, "manifest:dash:pertitle-video-families")).toBe(
			"FAIL",
		);
		expect(detailOf(report, "manifest:dash:pertitle-video-families")).toContain(
			"never declared",
		);
	});

	describe("snapshot incomplete or absent ⇒ explicit UNVERIFIED, never an empty-family FAIL, never a silent PASS", () => {
		const cases: [string, PerTitleActualVideoFamilies | undefined][] = [
			[
				"incomplete",
				{
					status: "incomplete",
					reason:
						"the per-title RESULT capture stopped before the end (scan.complete=false)",
				},
			],
			["absent", { status: "absent", reason: "no capture recorded" }],
			["not handed to the verifier at all", undefined],
		];
		for (const [name, actual] of cases) {
			it(`DASH, capture ${name}`, async () => {
				const { topology, ctx } = manifestOf(
					compileFixture("pertitle-h264-fmp4-ts-dash-hls-on-aws"),
					"DASH",
				);
				const report = new ReportBuilder();
				bindDashTopology(
					report,
					"manifest:dash",
					topology,
					await parseDashText(H264_PER_TITLE_MPD),
					{ ...ctx, ...(actual ? { perTitleActual: actual } : {}) },
				);
				expect(fails(report)).toEqual([]);
				expect(verdictOf(report, "manifest:dash:pertitle-video-families")).toBe(
					"SKIP",
				);
				expect(
					detailOf(report, "manifest:dash:pertitle-video-families"),
				).toMatch(/UNVERIFIED/);
				// The family membership check still ran against the DECLARED set.
				expect(verdictOf(report, "manifest:dash:adaptationset-codecs")).toBe(
					"PASS",
				);
			});
		}
	});

	it("a complete capture whose family set is EMPTY is compared, not skipped — the encoder produced nothing", async () => {
		const { topology, ctx } = manifestOf(
			compileFixture("pertitle-h264-fmp4-ts-dash-hls-on-aws"),
			"DASH",
		);
		const report = new ReportBuilder();
		bindDashTopology(
			report,
			"manifest:dash",
			topology,
			await parseDashText(H264_PER_TITLE_MPD),
			{ ...ctx, perTitleActual: complete([], 0) },
		);
		expect(verdictOf(report, "manifest:dash:pertitle-video-families")).toBe(
			"FAIL",
		);
	});

	it("a per-title representation with no codec keeps the family verdict UNVERIFIED", async () => {
		const { topology, ctx } = manifestOf(
			compileFixture("pertitle-h264-fmp4-ts-dash-hls-on-aws"),
			"DASH",
		);
		const mpd = MPD(
			`${videoSet("v", [
				{ id: "typed", bw: 2_398_000, h: 720, codecs: "avc1.640020" },
				{ id: "unknown", bw: 603_000, h: 360 },
			])}\n${audioSet("a128", 128_000)}`,
		);
		const report = new ReportBuilder();
		bindDashTopology(
			report,
			"manifest:dash",
			topology,
			await parseDashText(mpd),
			{ ...ctx, perTitleActual: complete(["H264"], 2) },
		);
		expect(verdictOf(report, "manifest:dash:pertitle-video-families")).toBe(
			"SKIP",
		);
		expect(detailOf(report, "manifest:dash:pertitle-video-families")).toMatch(
			/UNVERIFIED.*1 of 2/,
		);
	});

	describe("fixed + per-title in one manifest", () => {
		// One fixed 360p rung beside a per-title template; the fixed node binds
		// by geometry and consumes its representation, the encoder's rungs are
		// accepted, and the families are compared over the UNBOUND rows only.
		const plan = planWith({
			generation: { timing: "POST_ENCODING" },
			renditions: [
				video("v360", 360, 600_000),
				{
					key: "vpt",
					codec: "H264",
					ingestKey: "video",
					height: 1080,
					bitrate: null,
					mode: "PER_TITLE_TEMPLATE",
				},
				audio("a128", 128_000),
			],
			muxings: [
				fmp4("v360", "video/360p"),
				fmp4("vpt", "video/{height}p_{bitrate}_{uuid}"),
				fmp4("a128", "audio/128000"),
			],
			manifests: [HLS(), DASH],
		});
		const expected = compileExpectedArtefacts(plan);
		const mixedMpd = MPD(
			`${videoSet("v", [
				{ id: "fixed360", bw: 610_000, h: 360, codecs: "avc1.4d401e" },
				{ id: "pt1080", bw: 4_100_000, h: 1080, codecs: "avc1.640028" },
				{ id: "pt720", bw: 2_400_000, h: 720, codecs: "avc1.640020" },
			])}\n${audioSet("a128", 128_000)}`,
		);

		it("compiles a fixed node AND the family set", () => {
			const { topology, ctx } = manifestOf(expected, "DASH");
			expect(ctx.perTitle).toBe(true);
			expect(topology.video.map((v) => v.renditionKey)).toEqual(["v360"]);
			expect(topology.declaredVideoCodecFamilies).toEqual(["H264"]);
		});

		it("DASH: the fixed rung binds, the per-title rungs are accepted, the families agree", async () => {
			const { topology, ctx } = manifestOf(expected, "DASH");
			const report = new ReportBuilder();
			bindDashTopology(
				report,
				"manifest:dash",
				topology,
				await parseDashText(mixedMpd),
				{ ...ctx, perTitleActual: complete(["H264"], 2) },
			);
			expect(fails(report)).toEqual([]);
			expect(detailOf(report, "manifest:dash:rep:v360:present")).toContain(
				'"fixed360"',
			);
			expect(
				detailOf(report, "manifest:dash:representations-unexpected"),
			).toContain("2 encoder-chosen");
			expect(verdictOf(report, "manifest:dash:pertitle-video-families")).toBe(
				"PASS",
			);
		});

		it("DASH: a capture in another family FAILS the comparison even though every rung is H.264 in the MPD", async () => {
			const { topology, ctx } = manifestOf(expected, "DASH");
			const report = new ReportBuilder();
			bindDashTopology(
				report,
				"manifest:dash",
				topology,
				await parseDashText(mixedMpd),
				{ ...ctx, perTitleActual: complete(["H265"], 2) },
			);
			expect(verdictOf(report, "manifest:dash:pertitle-video-families")).toBe(
				"FAIL",
			);
			expect(verdictOf(report, "manifest:dash:rep:v360:present")).toBe("PASS");
		});

		it("HLS: the fixed variant binds by URI + AUDIO, the per-title rows are accepted", async () => {
			const { topology, ctx } = manifestOf(expected, "HLS");
			expect(topology.hlsVariants?.map((v) => v.key)).toEqual(["v360"]);
			const text = master(
				[
					{
						uri: "video_600000.m3u8",
						bw: 740_000,
						h: 360,
						codecs: "avc1.4d401e,mp4a.40.2",
						audio: "audio",
					},
					{
						uri: "video_4100000.m3u8",
						bw: 4_300_000,
						h: 1080,
						codecs: "avc1.640028,mp4a.40.2",
						audio: "audio",
					},
					{
						uri: "video_2400000.m3u8",
						bw: 2_600_000,
						h: 720,
						codecs: "avc1.640020,mp4a.40.2",
						audio: "audio",
					},
				],
				[{ group: "audio", name: "HLS Audio Media", uri: "audio_128000.m3u8" }],
			);
			const report = new ReportBuilder();
			bindHlsTopology(
				report,
				"manifest:hls",
				topology,
				await parseHlsText(text),
				{ ...ctx, perTitleActual: complete(["H264"], 2) },
			);
			expect(fails(report)).toEqual([]);
			expect(verdictOf(report, "manifest:hls:variant:v360:present")).toBe(
				"PASS",
			);
			expect(detailOf(report, "manifest:hls:variants-unexpected")).toContain(
				"2 encoder-chosen",
			);
			expect(verdictOf(report, "manifest:hls:pertitle-video-families")).toBe(
				"PASS",
			);
		});

		it("HLS: a per-title row in a family the plan never declared is UNEXPECTED and fails the family comparison", async () => {
			const { topology, ctx } = manifestOf(expected, "HLS");
			const text = master(
				[
					{
						uri: "video_600000.m3u8",
						bw: 740_000,
						h: 360,
						codecs: "avc1.4d401e,mp4a.40.2",
						audio: "audio",
					},
					{
						uri: "video_1900000.m3u8",
						bw: 2_000_000,
						h: 1080,
						codecs: "av01.0.08M.08,mp4a.40.2",
						audio: "audio",
					},
				],
				[{ group: "audio", name: "HLS Audio Media", uri: "audio_128000.m3u8" }],
			);
			const report = new ReportBuilder();
			bindHlsTopology(
				report,
				"manifest:hls",
				topology,
				await parseHlsText(text),
				{ ...ctx, perTitleActual: complete(["H264"], 1) },
			);
			expect(verdictOf(report, "manifest:hls:variants-unexpected")).toBe(
				"FAIL",
			);
			expect(verdictOf(report, "manifest:hls:pertitle-video-families")).toBe(
				"FAIL",
			);
		});
	});
});

// ===========================================================================
// VF-03 — one-to-one binding (HIGH-5)
// ===========================================================================

describe("one-to-one manifest binding (row 284 / HIGH-5)", () => {
	/** Two rungs at ONE height — the shape `nearestByBandwidth` could not tell apart. */
	const twoAt360 = compileExpectedArtefacts(
		planWith({
			renditions: [
				video("v360-300", 360, 300_000),
				video("v360-600", 360, 600_000),
				audio("a128", 128_000),
			],
			muxings: [
				fmp4("v360-300", "video/360p_300"),
				fmp4("v360-600", "video/360p_600"),
				fmp4("a128", "audio/128000"),
			],
			manifests: [HLS(), DASH],
		}),
	);
	const media128 = [
		{ group: "audio", name: "HLS Audio Media", uri: "audio_128000.m3u8" },
	];
	const row = (bw: number, over: Partial<Variant> = {}): Variant => ({
		uri: `video_${bw}.m3u8`,
		bw: bw + 128_000,
		h: 360,
		codecs: "avc1.4d401e,mp4a.40.2",
		audio: "audio",
		...over,
	});

	describe("HLS", () => {
		const bind = async (variants: Variant[], media: Media[] = media128) => {
			const { topology, ctx } = manifestOf(twoAt360, "HLS");
			const report = new ReportBuilder();
			bindHlsTopology(
				report,
				"manifest:hls",
				topology,
				await parseHlsText(master(variants, media)),
				ctx,
			);
			return report;
		};

		it("2 expected / 1 observed: one binds, the other is MISSING — never both green", async () => {
			const report = await bind([row(600_000)]);
			expect(verdictOf(report, "manifest:hls:variant:v360-600:present")).toBe(
				"PASS",
			);
			expect(verdictOf(report, "manifest:hls:variant:v360-300:present")).toBe(
				"FAIL",
			);
			expect(verdictOf(report, "manifest:hls:variants-unexpected")).toBe(
				"PASS",
			);
		});

		it("2 / 2 in reverse order: both bind, each to its own row", async () => {
			const report = await bind([row(600_000), row(300_000)]);
			expect(fails(report)).toEqual([]);
			expect(
				detailOf(report, "manifest:hls:variant:v360-300:present"),
			).toContain("video_300000.m3u8");
			expect(
				detailOf(report, "manifest:hls:variant:v360-600:present"),
			).toContain("video_600000.m3u8");
		});

		it("chooses the row with the expected resolution and codec when URI and AUDIO collide", async () => {
			const report = await bind([
				row(300_000),
				row(600_000, { h: 720, codecs: "av01.0.08M.08,mp4a.40.2" }),
				row(900_000, {
					uri: "video_600000.m3u8",
					h: 360,
					codecs: "avc1.4d401e,mp4a.40.2",
				}),
			]);
			expect(
				verdictOf(report, "manifest:hls:variant:v360-600:resolution"),
			).toBe("PASS");
			expect(verdictOf(report, "manifest:hls:variant:v360-600:codec")).toBe(
				"PASS",
			);
			expect(
				detailOf(report, "manifest:hls:variant:v360-600:present"),
			).toContain("avc1.4d401e");
			// The incompatible collision is still surfaced; it is not silently dropped.
			expect(verdictOf(report, "manifest:hls:variants-unexpected")).toBe(
				"FAIL",
			);
		});

		it("an extra row the plan never asked for is UNEXPECTED, named", async () => {
			const report = await bind([row(300_000), row(600_000), row(900_000)]);
			expect(verdictOf(report, "manifest:hls:variants-unexpected")).toBe(
				"FAIL",
			);
			expect(detailOf(report, "manifest:hls:variants-unexpected")).toContain(
				"video_900000.m3u8",
			);
			// The planned nodes still bind — the stray row costs them nothing.
			expect(verdictOf(report, "manifest:hls:variant:v360-300:present")).toBe(
				"PASS",
			);
		});

		it("a row listed twice, byte for byte, is a DUPLICATE — it binds once", async () => {
			const report = await bind([row(300_000), row(600_000), row(600_000)]);
			expect(verdictOf(report, "manifest:hls:variants-duplicate")).toBe("FAIL");
			expect(detailOf(report, "manifest:hls:variants-duplicate")).toContain(
				"×2",
			);
			expect(verdictOf(report, "manifest:hls:variant:v360-600:present")).toBe(
				"PASS",
			);
			// Collapsed before matching: nothing is left over to call unexpected.
			expect(verdictOf(report, "manifest:hls:variants-unexpected")).toBe(
				"PASS",
			);
		});

		it("the same URI under two AUDIO groups is two rows — identity includes the group", async () => {
			// The 600k row is listed a second time pointing at a group that does
			// not exist on the plan: not a duplicate (different identity), and
			// unexpected.
			const report = await bind([
				row(300_000),
				row(600_000),
				row(600_000, { audio: "commentary" }),
			]);
			expect(verdictOf(report, "manifest:hls:variants-duplicate")).toBe("PASS");
			expect(verdictOf(report, "manifest:hls:variants-unexpected")).toBe(
				"FAIL",
			);
			expect(detailOf(report, "manifest:hls:variants-unexpected")).toContain(
				'AUDIO="commentary"',
			);
		});

		it("an EXT-X-MEDIA entry the plan never asked for is UNEXPECTED; audio is never the encoder's", async () => {
			const report = await bind(
				[row(300_000), row(600_000)],
				[
					...media128,
					{ group: "audio", name: "Commentary", uri: "audio_64000.m3u8" },
				],
			);
			expect(verdictOf(report, "manifest:hls:media-unexpected")).toBe("FAIL");
			expect(verdictOf(report, "manifest:hls:media:a128:present")).toBe("PASS");
		});

		it("an EXT-X-MEDIA entry whose URI is not the compiler's FAILS by name", async () => {
			const report = await bind(
				[row(300_000), row(600_000)],
				[{ group: "audio", name: "HLS Audio Media", uri: "audio/index.m3u8" }],
			);
			expect(verdictOf(report, "manifest:hls:media:a128:present")).toBe("PASS");
			expect(verdictOf(report, "manifest:hls:media:a128:uri")).toBe("FAIL");
		});
	});

	describe("DASH", () => {
		const bind = async (reps: Rep[], extraSets = "") => {
			const { topology, ctx } = manifestOf(twoAt360, "DASH");
			const report = new ReportBuilder();
			bindDashTopology(
				report,
				"manifest:dash",
				topology,
				await parseDashText(
					MPD(
						`${videoSet("v", reps)}\n${audioSet("a128", 128_000)}${extraSets}`,
					),
				),
				ctx,
			);
			return report;
		};
		const rep = (id: string, bw: number | undefined, h = 360): Rep => ({
			id,
			...(bw !== undefined ? { bw } : {}),
			h,
			codecs: "avc1.4d401e",
		});

		it("2 expected / 1 observed at one height: one binds, one is MISSING", async () => {
			const report = await bind([rep("only", 600_000)]);
			expect(verdictOf(report, "manifest:dash:rep:v360-600:present")).toBe(
				"PASS",
			);
			expect(verdictOf(report, "manifest:dash:rep:v360-300:present")).toBe(
				"FAIL",
			);
			// The count floor already reads 1 ≠ 2; the binding names WHICH.
			expect(detailOf(report, "manifest:dash:rep:v360-300:present")).toContain(
				"v360-300",
			);
		});

		it("2 / 2 in reverse order: both bind, each to the representation nearest its bitrate", async () => {
			const report = await bind([rep("hi", 620_000), rep("lo", 310_000)]);
			expect(fails(report)).toEqual([]);
			expect(detailOf(report, "manifest:dash:rep:v360-300:present")).toContain(
				'"lo"',
			);
			expect(detailOf(report, "manifest:dash:rep:v360-600:present")).toContain(
				'"hi"',
			);
		});

		it("does not let a wrong-family representation take the matching rendition from a valid one", async () => {
			const report = await bind([
				rep("v300", 300_000),
				{ ...rep("a-wrong", 600_000), codecs: "av01.0.08M.08" },
				rep("z-right", 1_000_000_000),
			]);
			expect(verdictOf(report, "manifest:dash:rep:v360-600:codec")).toBe(
				"PASS",
			);
			expect(detailOf(report, "manifest:dash:rep:v360-600:present")).toContain(
				'"z-right"',
			);
			expect(
				verdictOf(report, "manifest:dash:representations-unexpected"),
			).toBe("FAIL");
		});

		it("an equidistant tie resolves identically whichever order the MPD lists the rows", async () => {
			const forward = await bind([rep("p", 450_000), rep("q", 450_000)]);
			const reversed = await bind([rep("q", 450_000), rep("p", 450_000)]);
			for (const id of [
				"manifest:dash:rep:v360-300:present",
				"manifest:dash:rep:v360-600:present",
			]) {
				expect(detailOf(reversed, id), id).toBe(detailOf(forward, id));
				expect(verdictOf(forward, id), id).toBe("PASS");
			}
			// And it IS one-to-one: the two nodes name two different representations.
			expect(detailOf(forward, "manifest:dash:rep:v360-300:present")).not.toBe(
				detailOf(forward, "manifest:dash:rep:v360-600:present"),
			);
		});

		it("an extra representation is UNEXPECTED, named by id", async () => {
			const report = await bind([
				rep("a", 300_000),
				rep("b", 600_000),
				rep("stray", 900_000, 720),
			]);
			expect(
				verdictOf(report, "manifest:dash:representations-unexpected"),
			).toBe("FAIL");
			expect(
				detailOf(report, "manifest:dash:representations-unexpected"),
			).toContain('"stray"');
		});

		it("a representation listed twice is a DUPLICATE and binds once", async () => {
			const report = await bind([
				rep("a", 300_000),
				rep("b", 600_000),
				rep("b", 600_000),
			]);
			expect(verdictOf(report, "manifest:dash:representations-duplicate")).toBe(
				"FAIL",
			);
			expect(verdictOf(report, "manifest:dash:rep:v360-600:present")).toBe(
				"PASS",
			);
			expect(
				verdictOf(report, "manifest:dash:representations-unexpected"),
			).toBe("PASS");
		});

		it("a missing bandwidth is NOT treated as 0: the declared row wins even out of band", async () => {
			// One node (v360-600 is the only 600k node; v360-300 gets nothing).
			// `nearestByBandwidth` read `bandwidth ?? 0`: at 1.0× distance the
			// silent row beat a declared row 1.5× away, and its bandwidth check
			// then SKIPped. The row with evidence must bind, and be judged.
			const report = await bind([
				rep("declared", 1_500_000),
				rep("silent", undefined),
			]);
			expect(detailOf(report, "manifest:dash:rep:v360-600:present")).toContain(
				'"declared"',
			);
			expect(verdictOf(report, "manifest:dash:rep:v360-600:bandwidth")).toBe(
				"FAIL",
			);
			// The silent row is then the nearest candidate left for v360-300 and
			// binds there — with an explicit SKIP on the bandwidth it never declared.
			expect(detailOf(report, "manifest:dash:rep:v360-300:present")).toContain(
				'"silent"',
			);
			expect(verdictOf(report, "manifest:dash:rep:v360-300:bandwidth")).toBe(
				"SKIP",
			);
		});

		it("an audio representation the plan never asked for is UNEXPECTED", async () => {
			const report = await bind(
				[rep("a", 300_000), rep("b", 600_000)],
				`\n${audioSet("a64", 64_000)}`,
			);
			expect(
				verdictOf(report, "manifest:dash:representations-unexpected"),
			).toBe("FAIL");
			expect(verdictOf(report, "manifest:dash:rep:a128:present")).toBe("PASS");
		});

		it("two expected audio renditions, one representation: the other is MISSING", async () => {
			const twoAudio = compileExpectedArtefacts(
				planWith({
					renditions: [
						video("v360", 360, 600_000),
						audio("a128", 128_000),
						audio("a64", 64_000),
					],
					muxings: [
						fmp4("v360", "video/360p"),
						fmp4("a128", "audio/128000"),
						fmp4("a64", "audio/64000"),
					],
					manifests: [DASH],
				}),
			);
			const { topology, ctx } = manifestOf(twoAudio, "DASH");
			const report = new ReportBuilder();
			bindDashTopology(
				report,
				"manifest:dash",
				topology,
				await parseDashText(
					MPD(
						`${videoSet("v", [rep("v", 600_000)])}\n${audioSet("a", 128_000)}`,
					),
				),
				ctx,
			);
			expect(verdictOf(report, "manifest:dash:rep:a128:present")).toBe("PASS");
			expect(verdictOf(report, "manifest:dash:rep:a64:present")).toBe("FAIL");
		});
	});

	describe("positives — the shapes the compiler emits bind FAIL 0", () => {
		it("fixed 4V2A separated master (the paid priority topology)", async () => {
			const expected = compileExpectedArtefacts(
				planWith({
					renditions: [
						video("v1080", 1080, 4_500_000),
						video("v720", 720, 2_500_000),
						video("v540", 540, 1_200_000),
						video("v360", 360, 600_000),
						audio("a128", 128_000),
						audio("a64", 64_000),
					],
					muxings: [
						ts("v1080", "video/1080p"),
						ts("v720", "video/720p"),
						ts("v540", "video/540p"),
						ts("v360", "video/360p"),
						ts("a128", "audio/128000"),
						ts("a64", "audio/64000"),
					],
					manifests: [HLS({ masterVersion: "HLS_V4", mediaVersion: "HLS_V4" })],
				}),
			);
			const { topology, ctx } = manifestOf(expected, "HLS");
			expect(topology.hlsVariants).toHaveLength(4);
			const text = master(
				[
					[4_500_000, 1080],
					[2_500_000, 720],
					[1_200_000, 540],
					[600_000, 360],
				].map(([bw, h]) => ({
					uri: `video_${bw}.m3u8`,
					bw: Math.round((bw as number) * 1.08) + 128_000,
					h: h as number,
					codecs: "avc1.640028,mp4a.40.2",
					audio: "audio",
				})),
				[
					{
						group: "audio",
						name: "HLS Audio Media (a128)",
						uri: "audio_128000.m3u8",
					},
					{
						group: "audio",
						name: "HLS Audio Media (a64)",
						uri: "audio_64000.m3u8",
					},
				],
				4,
			);
			const report = new ReportBuilder();
			bindHlsTopology(
				report,
				"manifest:hls",
				topology,
				await parseHlsText(text),
				ctx,
			);
			expect(fails(report)).toEqual([]);
			expect(
				report.checks.filter((c) => /:variant:.*:present$/.test(c.id)),
			).toHaveLength(4);
			expect(
				report.checks.filter((c) => /:media:.*:present$/.test(c.id)),
			).toHaveLength(2);
		});

		describe("`variantsPerAudioGroup`: one video muxing × two audio groups", () => {
			const expected = compileExpectedArtefacts(
				planWith({
					renditions: [
						video("v720", 720, 3_000_000),
						audio("main", 128_000, {
							groupId: "main",
							name: "Main",
							uri: "audio_main_128000.m3u8",
						}),
						audio("alt", 64_000, {
							groupId: "alt",
							name: "Alternate",
							uri: "audio_alt_64000.m3u8",
						}),
					],
					muxings: [
						fmp4("v720", "video/720p"),
						fmp4("main", "audio/main"),
						fmp4("alt", "audio/alt"),
					],
					manifests: [HLS({ variantsPerAudioGroup: true })],
				}),
			);
			const { topology, ctx } = manifestOf(expected, "HLS");
			const rows: Variant[] = [
				{
					uri: "video_video_720p_3000000_alt.m3u8",
					bw: 3_200_000,
					h: 720,
					codecs: "avc1.640028,mp4a.40.2",
					audio: "alt",
				},
				{
					uri: "video_video_720p_3000000_main.m3u8",
					bw: 3_300_000,
					h: 720,
					codecs: "avc1.640028,mp4a.40.2",
					audio: "main",
				},
			];
			const media: Media[] = [
				{ group: "main", name: "Main", uri: "audio_main_128000.m3u8" },
				{ group: "alt", name: "Alternate", uri: "audio_alt_64000.m3u8" },
			];

			it("compiles two nodes for one rendition, keyed by group", () => {
				expect(topology.hlsVariants?.map((v) => v.key).sort()).toEqual([
					"v720:alt",
					"v720:main",
				]);
			});

			it("binds both rows, FAIL 0", async () => {
				const report = new ReportBuilder();
				bindHlsTopology(
					report,
					"manifest:hls",
					topology,
					await parseHlsText(master(rows, media)),
					ctx,
				);
				expect(fails(report)).toEqual([]);
				expect(
					verdictOf(report, "manifest:hls:variant:v720:main:present"),
				).toBe("PASS");
				expect(verdictOf(report, "manifest:hls:variant:v720:alt:present")).toBe(
					"PASS",
				);
			});

			it("with the `alt` row dropped, ONLY the `alt` node is missing — the `main` row is not reused", async () => {
				const report = new ReportBuilder();
				bindHlsTopology(
					report,
					"manifest:hls",
					topology,
					await parseHlsText(master([rows[1] as Variant], media)),
					ctx,
				);
				expect(
					verdictOf(report, "manifest:hls:variant:v720:main:present"),
				).toBe("PASS");
				expect(verdictOf(report, "manifest:hls:variant:v720:alt:present")).toBe(
					"FAIL",
				);
			});
		});

		it("a muxed variant carries no AUDIO — and a row that does is not it", async () => {
			const { topology, ctx } = manifestOf(
				compileFixture("hls-ts-muxed-av"),
				"HLS",
			);
			expect(
				topology.hlsVariants?.every((v) => v.audioGroup === undefined),
			).toBe(true);
			const clean = master(
				[
					{
						uri: "video_800000.m3u8",
						bw: 950_000,
						h: 360,
						codecs: "avc1.4d401e,mp4a.40.2",
					},
					{
						uri: "video_2400000.m3u8",
						bw: 2_600_000,
						h: 720,
						codecs: "avc1.640028,mp4a.40.2",
					},
				],
				[],
			);
			const report = new ReportBuilder();
			bindHlsTopology(
				report,
				"manifest:hls",
				topology,
				await parseHlsText(clean),
				ctx,
			);
			expect(fails(report)).toEqual([]);

			const pointing = master(
				[
					{
						uri: "video_800000.m3u8",
						bw: 950_000,
						h: 360,
						codecs: "avc1.4d401e,mp4a.40.2",
						audio: "audio",
					},
				],
				[],
			);
			const wrong = new ReportBuilder();
			bindHlsTopology(
				wrong,
				"manifest:hls",
				topology,
				await parseHlsText(pointing),
				ctx,
			);
			// C33: naming a group that exists nowhere is the silent-playback defect.
			expect(verdictOf(wrong, "manifest:hls:variant:v360:present")).toBe(
				"FAIL",
			);
			expect(verdictOf(wrong, "manifest:hls:variants-unexpected")).toBe("FAIL");
		});

		it("the seven Dolby `variantsPerAudioGroup` fixtures bind their own masters FAIL 0", async () => {
			const token = (codec: string) =>
				({
					H264: "avc1.640028",
					H265: "hvc1.1.6.L150.90",
					VP9: "vp09.00.10.08",
					AV1: "av01.0.08M.08",
					AAC: "mp4a.40.2",
					DD: "ac-3",
					DDPLUS: "ec-3",
					DOLBY_ATMOS: "ec-3",
				})[codec] ?? "unknown";
			const names = [
				"dolby-dv-atmos-damf-aac",
				"dolby-dv-hdr10-sdr-2ladder-profile81",
				"dolby-dv-hdr10-sdr-2ladder-profile81-test",
				"dolby-dv-hdr10-sdr-3ladder-profile5-dv-sdr-inputs",
				"dolby-dv-hdr10-sdr-3ladder-profile5-dv-sdr-inputs-test",
				"dolby-dv-hdr10-sdr-3ladder-profile5-single-input",
				"dolby-dv-hdr10-sdr-3ladder-profile5-single-input-test",
			];
			for (const name of names) {
				const { topology, ctx } = manifestOf(compileFixture(name), "HLS");
				const nodes = topology.hlsVariants ?? [];
				expect(nodes.length, name).toBeGreaterThan(1);
				const text = master(
					nodes.map((n) => ({
						uri: n.uri,
						bw: Math.round(n.bitrate * 1.1),
						...(n.height !== undefined ? { h: n.height } : {}),
						codecs: `${token(n.codec)},${token(topology.audio[0]?.codec ?? "AAC")}`,
						...(n.audioGroup !== undefined ? { audio: n.audioGroup } : {}),
					})),
					topology.audio.map((a) => ({
						group: a.groupId ?? "audio",
						name: a.name ?? "",
						uri: a.uri ?? "",
					})),
				);
				const report = new ReportBuilder();
				bindHlsTopology(
					report,
					"manifest:hls",
					topology,
					await parseHlsText(text),
					ctx,
				);
				expect(fails(report), name).toEqual([]);
			}
		});
	});
});
