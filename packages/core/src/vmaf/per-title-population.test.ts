import { describe, expect, it, vi } from "vitest";
import {
	capturePerTitleResults,
	PER_TITLE_RESULT_MODE,
	type PerTitleCapturePort,
	type PerTitleResultsSnapshot,
	type ScannedMuxing,
	type ScannedStream,
} from "../plan/per-title-results";
import {
	perTitleRungDirsFromSnapshot,
	perTitleRungsFromSnapshot,
} from "./per-title-population";

/**
 * Paid audit 893eb66 HIGH-10 : the per-title VMAF population is
 * the ladder the provider BUILT, read from the CAPTURE_PER_TITLE_RESULTS
 * snapshot — not whatever a bucket listing under the template happens to
 * find inside a time window. A rung with no mirror is named, not invisible.
 */
const PROVIDER_OUTPUT_ID = "provider-output-origin";

function stream(
	streamId: string,
	templateRendition: string | undefined,
	muxings: { muxingType: string; outputPath?: string; outputId?: string }[],
): PerTitleResultsSnapshot["streams"][number] {
	return {
		streamId,
		mode: "PER_TITLE_RESULT",
		...(templateRendition !== undefined ? { templateRendition } : {}),
		params: {},
		muxings: muxings.map((m, i) => ({
			muxingId: `${streamId}-m${i}`,
			muxingType: m.muxingType,
			outputs:
				m.outputPath !== undefined
					? [
							{
								outputId: m.outputId ?? PROVIDER_OUTPUT_ID,
								outputPath: m.outputPath,
							},
						]
					: [],
			drm: [],
		})),
	};
}

const SNAPSHOT: PerTitleResultsSnapshot = {
	capturedAt: "2026-08-28T00:00:00.000Z",
	streams: [
		stream("s-1080", "vpt", [
			{ muxingType: "FMP4", outputPath: "out/pt/1080p_4200000_a1b2/video/" },
			{ muxingType: "MP4", outputPath: "out/pt/1080p_4200000_a1b2/qc/" },
		]),
		stream("s-720", "vpt", [
			{ muxingType: "FMP4", outputPath: "out/pt/720p_2400000_c3d4/video/" },
			{ muxingType: "MP4", outputPath: "out/pt/720p_2400000_c3d4/qc" },
		]),
		// The rung whose mirror the provider never created: the listing-based
		// population simply did not see it, and the ladder looked complete.
		stream("s-360", "vpt", [
			{ muxingType: "FMP4", outputPath: "out/pt/360p_500000_e5f6/video/" },
		]),
		// Another template's rung, and an unattributed stream — both not ours.
		stream("s-other", "vother", [
			{ muxingType: "MP4", outputPath: "out/other/540p_1_x/qc/" },
		]),
		stream("s-unattributed", undefined, [
			{ muxingType: "MP4", outputPath: "out/pt/540p_1_y/qc/" },
		]),
	],
	scan: {
		streamsListed: 5,
		templatesListed: 2,
		templatesDeclared: 2,
		resultsCaptured: 5,
		muxingsListed: 6,
		complete: true,
		codecConfigErrors: 0,
		unattributed: 1,
	},
};

describe("perTitleRungsFromSnapshot", () => {
	it("yields one exact mirror key per captured rung of the rendition, and names the rung that has none", () => {
		expect(
			perTitleRungsFromSnapshot(SNAPSHOT, {
				renditionKey: "vpt",
				codec: "H264",
				providerOutputId: PROVIDER_OUTPUT_ID,
				distorted: { path: "out/pt/{height}p_{bitrate}_{uuid}/qc/vpt.mp4" },
			}),
		).toEqual([
			{
				variant: "1080p_4200000_a1b2",
				streamId: "s-1080",
				key: "out/pt/1080p_4200000_a1b2/qc/vpt.mp4",
				providerResult: {
					streamId: "s-1080",
					muxingId: "s-1080-m1",
					outputId: PROVIDER_OUTPUT_ID,
					resolvedPath: "out/pt/1080p_4200000_a1b2/qc/",
				},
			},
			{
				variant: "720p_2400000_c3d4",
				streamId: "s-720",
				key: "out/pt/720p_2400000_c3d4/qc/vpt.mp4",
				providerResult: {
					streamId: "s-720",
					muxingId: "s-720-m1",
					outputId: PROVIDER_OUTPUT_ID,
					resolvedPath: "out/pt/720p_2400000_c3d4/qc/",
				},
			},
			{
				variant: "360p_500000_e5f6",
				streamId: "s-360",
				missing: true,
				reason: `the captured rung has 1 muxing(s) and none is a QC mirror for provider output ${PROVIDER_OUTPUT_ID} under a qc/ directory`,
			},
		]);
	});

	it("retains the exact provider RESULT, muxing, output and resolved-path tuple for the selected QC mirror", () => {
		const exact: PerTitleResultsSnapshot = {
			...SNAPSHOT,
			streams: [
				{
					streamId: "s-exact",
					mode: PER_TITLE_RESULT_MODE,
					templateRendition: "vpt",
					params: {},
					muxings: [
						{
							muxingId: "m-exact-qc",
							muxingType: "MP4",
							filename: "vpt.mp4",
							outputs: [
								{
									outputId: "out-exact",
									outputPath: "out/pt/720p_2400000_exact/qc",
								},
							],
							drm: [],
						},
					],
				},
			],
		};

		expect(
			perTitleRungsFromSnapshot(exact, {
				renditionKey: "vpt",
				codec: "H264",
				providerOutputId: "out-exact",
			}),
		).toEqual([
			{
				variant: "720p_2400000_exact",
				streamId: "s-exact",
				key: "out/pt/720p_2400000_exact/qc/vpt.mp4",
				providerResult: {
					streamId: "s-exact",
					muxingId: "m-exact-qc",
					outputId: "out-exact",
					resolvedPath: "out/pt/720p_2400000_exact/qc/",
				},
			},
		]);
	});

	it("selects the QC leg whose provider output matches the target instead of the first mirrored leg", () => {
		const mirrored: PerTitleResultsSnapshot = {
			...SNAPSHOT,
			streams: [
				{
					streamId: "s-mirrored",
					mode: PER_TITLE_RESULT_MODE,
					templateRendition: "vpt",
					params: {},
					muxings: [
						{
							muxingId: "m-mirrored-qc",
							muxingType: "MP4",
							filename: "vpt.mp4",
							// Delivery-mirror order is deliberately the opposite of the
							// target output. Both legs use the same key in different buckets.
							outputs: [
								{
									outputId: "provider-output-b",
									outputPath: "out/pt/720p_2400000_mirror/qc/",
								},
								{
									outputId: "provider-output-a",
									outputPath: "out/pt/720p_2400000_mirror/qc/",
								},
							],
							drm: [],
						},
					],
				},
			],
		};

		expect(
			perTitleRungsFromSnapshot(mirrored, {
				renditionKey: "vpt",
				codec: "H264",
				providerOutputId: "provider-output-a",
			}),
		).toEqual([
			{
				variant: "720p_2400000_mirror",
				streamId: "s-mirrored",
				key: "out/pt/720p_2400000_mirror/qc/vpt.mp4",
				providerResult: {
					streamId: "s-mirrored",
					muxingId: "m-mirrored-qc",
					outputId: "provider-output-a",
					resolvedPath: "out/pt/720p_2400000_mirror/qc/",
				},
			},
		]);
	});

	it("names the VP9 mirror as WebM (one definition with the compiler, ledger #205)", () => {
		const rungs = perTitleRungsFromSnapshot(
			{
				...SNAPSHOT,
				streams: [
					stream("s-v", "vp9pt", [
						{
							muxingType: "PROGRESSIVE_WEBM",
							outputPath: "out/w/1080p_1_z/qc/",
						},
					]),
				],
			},
			{
				renditionKey: "vp9pt",
				codec: "VP9",
				providerOutputId: PROVIDER_OUTPUT_ID,
			},
		);
		expect(rungs).toEqual([
			{
				variant: "1080p_1_z",
				streamId: "s-v",
				key: "out/w/1080p_1_z/qc/vp9pt.webm",
				providerResult: {
					streamId: "s-v",
					muxingId: "s-v-m0",
					outputId: PROVIDER_OUTPUT_ID,
					resolvedPath: "out/w/1080p_1_z/qc/",
				},
			},
		]);
	});

	it("is empty for a rendition the snapshot never attributed a rung to", () => {
		expect(
			perTitleRungsFromSnapshot(SNAPSHOT, {
				renditionKey: "vnone",
				codec: "H264",
				providerOutputId: PROVIDER_OUTPUT_ID,
			}),
		).toEqual([]);
	});

	it("a rung with no muxings at all is unmeasured with that reason, labelled by its stream id", () => {
		const rungs = perTitleRungsFromSnapshot(
			{ ...SNAPSHOT, streams: [stream("s-bare", "vpt", [])] },
			{
				renditionKey: "vpt",
				codec: "H264",
				providerOutputId: PROVIDER_OUTPUT_ID,
			},
		);
		expect(rungs).toEqual([
			{
				variant: "s-bare",
				streamId: "s-bare",
				missing: true,
				reason: "the captured rung has no muxings at all",
			},
		]);
	});
});

/**
 * The attribution-free half : a verifier asks "did this run write
 * this object?", which never needs to know which template produced the rung.
 */
describe("perTitleRungDirsFromSnapshot", () => {
	it("names every rung directory, INCLUDING the ones attribution abstains on", () => {
		// `s-unattributed` and `s-other` are exactly what `perTitleRungsFromSnapshot`
		// drops for the `vpt` target — and both are directories this run wrote into.
		expect(perTitleRungDirsFromSnapshot(SNAPSHOT)).toEqual([
			"out/other/540p_1_x/qc/",
			"out/pt/1080p_4200000_a1b2/qc/",
			"out/pt/1080p_4200000_a1b2/video/",
			"out/pt/360p_500000_e5f6/video/",
			"out/pt/540p_1_y/qc/",
			"out/pt/720p_2400000_c3d4/qc/",
			"out/pt/720p_2400000_c3d4/video/",
		]);
	});

	it("survives a snapshot in which NOTHING is attributed — the #221 shape", () => {
		// Ten of the fourteen per-title fixtures carry two or more templates of one
		// codec, so `attributeResult` abstains on every result and
		// `perTitleRungsFromSnapshot` returns nothing for every rendition. The
		// directories are still all there.
		const blind: PerTitleResultsSnapshot = {
			...SNAPSHOT,
			streams: SNAPSHOT.streams.map(
				({ templateRendition: _drop, ...rest }) => ({
					...rest,
				}),
			),
		};
		expect(
			perTitleRungsFromSnapshot(blind, {
				renditionKey: "vpt",
				codec: "H264",
				providerOutputId: PROVIDER_OUTPUT_ID,
			}),
			"attribution really does abstain on this snapshot",
		).toEqual([]);
		expect(perTitleRungDirsFromSnapshot(blind)).toHaveLength(7);
	});

	it("follows the DRM hop — a DRM'd muxing has no output of its own", () => {
		const drmOnly: PerTitleResultsSnapshot = {
			...SNAPSHOT,
			streams: [
				{
					streamId: "s-drm",
					mode: "PER_TITLE_RESULT",
					params: {},
					muxings: [
						{
							muxingId: "m-drm",
							muxingType: "FMP4",
							outputs: [],
							drm: [
								{
									drmId: "d1",
									drmType: "CENC",
									outputs: [{ outputPath: "out/enc/720p_1_a" }],
								},
							],
						},
					],
				},
			],
		};
		expect(perTitleRungDirsFromSnapshot(drmOnly)).toEqual([
			"out/enc/720p_1_a/",
		]);
	});

	it("is empty for a snapshot that captured nothing", () => {
		expect(perTitleRungDirsFromSnapshot({ ...SNAPSHOT, streams: [] })).toEqual(
			[],
		);
	});
});

/**
 * The FIX (audit 602ec286 §5.4): with filename attribution the population is the
 * ladder the provider BUILT, keyed by each RESULT's resolved output path + exact
 * mirror filename — driven end to end from provider-shaped muxing rows, with NO
 * injected `templateRendition`.
 */
describe("perTitleRungsFromSnapshot — from real filename attribution", () => {
	const CAPTURED_AT = "2026-08-30T00:00:00.000Z";

	function capturePort(
		resultStreams: ScannedStream[],
		muxings: ScannedMuxing[],
	): PerTitleCapturePort {
		return {
			listStreams: vi.fn(() =>
				Promise.resolve({ items: resultStreams, complete: true }),
			),
			listMuxings: vi.fn(() =>
				Promise.resolve({ items: muxings, complete: true }),
			),
			getCodecConfig: vi.fn(() =>
				Promise.resolve({ codecType: "H264", params: {} }),
			),
		};
	}

	it("scores each provider RESULT at its resolved key; a template with no RESULT yields no rung", async () => {
		// Two same-codec templates that DID produce RESULTs, and a third (vc) the
		// provider never expanded — the shape that made attribution abstain on all.
		const snapshot = await capturePerTitleResults(
			capturePort(
				[
					{ streamId: "s-a", mode: PER_TITLE_RESULT_MODE, codecConfigId: "c" },
					{ streamId: "s-b", mode: PER_TITLE_RESULT_MODE, codecConfigId: "c" },
				],
				[
					{
						muxingId: "m-a-qc",
						muxingType: "MP4",
						filename: "va.mp4",
						streamIds: ["s-a"],
						outputs: [
							{
								outputId: PROVIDER_OUTPUT_ID,
								outputPath: "out/pt/360p_500000_aaa/qc/",
							},
						],
						drm: [],
					},
					{
						muxingId: "m-b-qc",
						muxingType: "MP4",
						filename: "vb.mp4",
						streamIds: ["s-b"],
						outputs: [
							{
								outputId: PROVIDER_OUTPUT_ID,
								outputPath: "out/pt/540p_900000_bbb/qc/",
							},
						],
						drm: [],
					},
				],
			),
			{
				encodingId: "enc",
				capturedAt: CAPTURED_AT,
				templates: [
					{ rendition: "va", codec: "H264" },
					{ rendition: "vb", codec: "H264" },
					{ rendition: "vc", codec: "H264" },
				],
			},
		);
		expect(snapshot.scan.unattributed).toBe(0);

		expect(
			perTitleRungsFromSnapshot(snapshot, {
				renditionKey: "va",
				codec: "H264",
				providerOutputId: PROVIDER_OUTPUT_ID,
				distorted: { path: "out/pt/{height}p_{bitrate}_{uuid}/qc/va.mp4" },
			}),
		).toEqual([
			{
				variant: "360p_500000_aaa",
				streamId: "s-a",
				key: "out/pt/360p_500000_aaa/qc/va.mp4",
				providerResult: {
					streamId: "s-a",
					muxingId: "m-a-qc",
					outputId: PROVIDER_OUTPUT_ID,
					resolvedPath: "out/pt/360p_500000_aaa/qc/",
				},
			},
		]);
		// vc produced no RESULT — no rung, no synthetic failure.
		expect(
			perTitleRungsFromSnapshot(snapshot, {
				renditionKey: "vc",
				codec: "H264",
				providerOutputId: PROVIDER_OUTPUT_ID,
			}),
		).toEqual([]);
	});

	it("is ONE score unit per RESULT — a DRM'd delivery leg adds no duplicate", () => {
		const snapshot: PerTitleResultsSnapshot = {
			capturedAt: CAPTURED_AT,
			streams: [
				{
					streamId: "s-1",
					mode: PER_TITLE_RESULT_MODE,
					templateRendition: "vpt",
					params: {},
					muxings: [
						{
							muxingId: "m-fmp4",
							muxingType: "FMP4",
							outputs: [],
							drm: [
								{
									drmId: "d",
									drmType: "CENC",
									outputs: [
										{
											outputId: PROVIDER_OUTPUT_ID,
											outputPath: "out/pt/720p_2400000_c/enc/",
										},
									],
								},
							],
						},
						{
							muxingId: "m-qc",
							muxingType: "MP4",
							filename: "vpt.mp4",
							outputs: [
								{
									outputId: PROVIDER_OUTPUT_ID,
									outputPath: "out/pt/720p_2400000_c/qc/",
								},
							],
							drm: [],
						},
					],
				},
			],
			scan: {
				streamsListed: 1,
				templatesListed: 1,
				templatesDeclared: 1,
				resultsCaptured: 1,
				muxingsListed: 2,
				complete: true,
				codecConfigErrors: 0,
				unattributed: 0,
			},
		};
		const rungs = perTitleRungsFromSnapshot(snapshot, {
			renditionKey: "vpt",
			codec: "H264",
			providerOutputId: PROVIDER_OUTPUT_ID,
		});
		expect(rungs).toEqual([
			{
				variant: "720p_2400000_c",
				streamId: "s-1",
				key: "out/pt/720p_2400000_c/qc/vpt.mp4",
				providerResult: {
					streamId: "s-1",
					muxingId: "m-qc",
					outputId: PROVIDER_OUTPUT_ID,
					resolvedPath: "out/pt/720p_2400000_c/qc/",
				},
			},
		]);
	});

	it("a DRM-only RESULT (no decodable mirror) stays in the population as UNMEASURED", () => {
		// The mirror is written only through DRM (m.outputs empty) — not decodable,
		// so it must be named UNMEASURED, never silently dropped.
		const snapshot: PerTitleResultsSnapshot = {
			capturedAt: CAPTURED_AT,
			streams: [
				{
					streamId: "s-drm",
					mode: PER_TITLE_RESULT_MODE,
					templateRendition: "vpt",
					params: {},
					muxings: [
						{
							muxingId: "m-qc",
							muxingType: "MP4",
							filename: "vpt.mp4",
							outputs: [],
							drm: [
								{
									drmId: "d",
									drmType: "CENC",
									outputs: [
										{
											outputId: PROVIDER_OUTPUT_ID,
											outputPath: "out/pt/1080p_4000000_z/qc/",
										},
									],
								},
							],
						},
					],
				},
			],
			scan: {
				streamsListed: 1,
				templatesListed: 1,
				templatesDeclared: 1,
				resultsCaptured: 1,
				muxingsListed: 1,
				complete: true,
				codecConfigErrors: 0,
				unattributed: 0,
			},
		};
		const rungs = perTitleRungsFromSnapshot(snapshot, {
			renditionKey: "vpt",
			codec: "H264",
			providerOutputId: PROVIDER_OUTPUT_ID,
		});
		expect(rungs).toHaveLength(1);
		expect(rungs[0]).toMatchObject({ streamId: "s-drm", missing: true });
	});
});
