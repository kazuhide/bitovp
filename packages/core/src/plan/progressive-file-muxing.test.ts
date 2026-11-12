import { readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { compileExpectedArtefacts } from "../verify/expected";
import {
	buildPlan,
	DEFAULT_WIZARD_STATE,
	type WizardState,
} from "../wizard/build-plan";
import { tryImportPresetIntoWizard } from "../wizard/plan-to-wizard";
import { AKAMAI_MSL_REQUIREMENTS } from "./akamai-msl-constraint";
import { compilePlan } from "./compiler";
import { renditionSummaries } from "./detail-view";
import { hlsLegSelected } from "./hls-legs";
import {
	FILE_ONLY_MUXING_KINDS,
	isFileOnlyMuxingKind,
	muxingKindCarriesAudio,
} from "./muxing-streams";
import { encodingPlanSchema, planMuxingSchema } from "./schema";
import { planToEncodingTemplateYaml } from "./template";
import { MUXING_CODEC_MATRIX, validatePlan } from "./validate";

/**
 * PROGRESSIVE_TS and PROGRESSIVE_MOV — one whole file per rendition.
 *
 * Every other video container in this app is something a manifest lists, and
 * most of the code that reads muxings assumed exactly that: an unpinned HLS
 * manifest enumerates EVERY video muxing, a `drmKind` pin checks every muxing
 * it selects, and the verifier counts every muxing as a manifest entry. A
 * `.ts` or `.mov` file is none of those things, so the risk in adding the two
 * kinds was never the create call — it was a file quietly becoming a playlist
 * variant.
 *
 * So the arms below hold two claims at once: the file reaches the wire with
 * the fields the plan set and nothing invented, and a plan that already works
 * is byte-for-byte the same plan with a file added beside it.
 *
 * NOT covered here, because nothing offline can cover it: whether Bitmovin
 * accepts these requests. Progressive TS follows the shape of Bitmovin's own
 * sample; progressive MOV has no sample and no live run, which is what
 * `PLAN_MUXING_UNMEASURED_KIND` tells the operator.
 */

const CRED = "00000000-0000-4000-8000-00000000000";

type Muxing = Record<string, unknown>;
type FileKind = (typeof FILE_ONLY_MUXING_KINDS)[number];

const H264 = {
	key: "v",
	codec: "H264",
	ingestKey: "video",
	height: 360,
	bitrate: 800000,
};
const AAC = {
	key: "a",
	codec: "AAC",
	ingestKey: "audio",
	bitrate: 128000,
	rate: 48000,
};

function planWith(opts: {
	muxings: Muxing[];
	renditions?: Record<string, unknown>[];
	manifests?: Record<string, unknown>[];
	drm?: Record<string, unknown>[];
}) {
	return encodingPlanSchema.parse({
		planVersion: 1,
		name: "file",
		bitmovin: {},
		inputs: [{ key: "in", kind: "S3", credentialId: `${CRED}1`, bucket: "b" }],
		outputs: [
			{ key: "out", kind: "S3", credentialId: `${CRED}2`, bucket: "b" },
		],
		ingest: [
			{
				key: "video",
				inputKey: "in",
				inputPath: "a.mp4",
				selectionMode: "VIDEO_RELATIVE",
			},
			{
				key: "audio",
				inputKey: "in",
				inputPath: "a.mp4",
				selectionMode: "AUDIO_RELATIVE",
			},
		],
		renditions: opts.renditions ?? [H264, AAC],
		muxings: opts.muxings,
		manifests: opts.manifests ?? [],
		...(opts.drm ? { drm: opts.drm } : {}),
		generation: { timing: "POST_ENCODING" },
	});
}

const file = (kind: FileKind, over: Muxing = {}): Muxing => ({
	key: "file",
	kind,
	streamKey: "v",
	additionalStreamKeys: ["a"],
	filename: kind === "PROGRESSIVE_TS" ? "video.ts" : "video.mov",
	// Deliberately NOT under the manifests' directory below: a segment
	// written there would be flagged, and a file must not be.
	destination: { outputKey: "out", path: "files" },
	...over,
});

/** The same file holding the audio rendition alone. */
const audioFile = (kind: FileKind, over: Muxing = {}): Muxing => {
	const { additionalStreamKeys: _audio, ...alone } = file(kind);
	return { ...alone, streamKey: "a", ...over };
};

/** The same two streams as a real, segmented HLS leg — what a file is not. */
const tsLeg: Muxing = {
	key: "file",
	kind: "TS",
	streamKey: "v",
	additionalStreamKeys: ["a"],
	segmentLength: 4,
	segmentNaming: "seg_%number%.ts",
	destination: { outputKey: "out", path: "files" },
};

const fmp4 = (key: string, streamKey: string, path: string): Muxing => ({
	key,
	kind: "FMP4",
	streamKey,
	segmentLength: 4,
	segmentNaming: "seg_%number%.m4s",
	initSegmentName: "init.mp4",
	destination: { outputKey: "out", path },
});
/** A working streaming ladder: the thing a file must leave untouched. */
const streaming = [fmp4("vmux", "v", "x/video"), fmp4("amux", "a", "x/audio")];
const manifests = [
	{
		key: "hls",
		kind: "HLS",
		manifestName: "stream.m3u8",
		destination: { outputKey: "out", path: "x" },
		audioGroupId: "audio",
	},
	{
		key: "dash",
		kind: "DASH",
		manifestName: "stream.mpd",
		destination: { outputKey: "out", path: "x" },
	},
];
const drmDestination = (muxingKey: string) => ({
	outputKey: "out",
	path: `x/drm/${muxingKey}`,
});
const cenc = (muxingKey: string) => ({
	key: `${muxingKey}-cenc`,
	kind: "CENC",
	muxingKey,
	credentialId: `${CRED}3`,
	kid: "00112233445566778899aabbccddeeff",
	widevine: { pssh: "AAAA" },
	destination: drmDestination(muxingKey),
});

const schemaKinds = planMuxingSchema.options.map(
	(o) => o.shape.kind.value as string,
);

describe("schema — a whole file, named and placed", () => {
	it("parses a progressive TS file with both of its optional numbers", () => {
		expect(
			planMuxingSchema.parse(
				file("PROGRESSIVE_TS", {
					segmentLength: 4,
					startOffset: 10,
					name: "Mezzanine",
				}),
			),
		).toEqual({
			key: "file",
			kind: "PROGRESSIVE_TS",
			streamKey: "v",
			additionalStreamKeys: ["a"],
			filename: "video.ts",
			segmentLength: 4,
			startOffset: 10,
			destination: { outputKey: "out", path: "files" },
			name: "Mezzanine",
		});
	});

	it("parses a progressive MOV file, which has a filename and nothing of its own beside it", () => {
		expect(planMuxingSchema.parse(file("PROGRESSIVE_MOV"))).toEqual({
			key: "file",
			kind: "PROGRESSIVE_MOV",
			streamKey: "v",
			additionalStreamKeys: ["a"],
			filename: "video.mov",
			destination: { outputKey: "out", path: "files" },
		});
	});

	it("invents no default for either number — absent stays absent", () => {
		// Absent means "the encoder decides". A schema default would turn that
		// into a value this app has never measured, sent on every request.
		const parsed = planMuxingSchema.parse(file("PROGRESSIVE_TS"));
		expect(parsed).not.toHaveProperty("segmentLength");
		expect(parsed).not.toHaveProperty("startOffset");
	});

	it.each(
		FILE_ONLY_MUXING_KINDS,
	)("%s must say where the file goes — there is no DRM route to borrow one from", (kind) => {
		const { destination: _destination, ...rest } = file(kind);
		expect(planMuxingSchema.safeParse(rest).success).toBe(false);
	});

	it.each([
		"",
		".",
		"..",
		"dir/video.ts",
		"dir\\video.ts",
		"video.ts?token=1",
		"video.ts#t=1",
	])("refuses the filename %j, as the TEXT muxing does", (filename) => {
		for (const kind of FILE_ONLY_MUXING_KINDS) {
			expect(
				planMuxingSchema.safeParse(file(kind, { filename })).success,
				kind,
			).toBe(false);
		}
	});

	it("holds segmentLength to a positive number and startOffset to a whole number from zero", () => {
		const ok = (over: Muxing) =>
			planMuxingSchema.safeParse(file("PROGRESSIVE_TS", over)).success;
		expect(ok({ segmentLength: 0.5 })).toBe(true);
		expect(ok({ segmentLength: 0 })).toBe(false);
		expect(ok({ segmentLength: -1 })).toBe(false);
		expect(ok({ startOffset: 0 })).toBe(true);
		expect(ok({ startOffset: -1 })).toBe(false);
		// The published template schema types this field `integer`.
		expect(ok({ startOffset: 1.5 })).toBe(false);
	});

	it("gives MOV neither number — the SDK model has only a filename", () => {
		expect(
			planMuxingSchema.safeParse(file("PROGRESSIVE_MOV", { segmentLength: 4 }))
				.success,
		).toBe(false);
		expect(
			planMuxingSchema.safeParse(file("PROGRESSIVE_MOV", { startOffset: 10 }))
				.success,
		).toBe(false);
	});

	it("refuses an empty additional list, the rule MP4 and TS already have", () => {
		for (const kind of FILE_ONLY_MUXING_KINDS) {
			expect(
				planMuxingSchema.safeParse(file(kind, { additionalStreamKeys: [] }))
					.success,
				kind,
			).toBe(false);
		}
	});
});

describe("the two predicates every layer reads", () => {
	it("names exactly the two whole-file kinds", () => {
		expect(schemaKinds.filter(isFileOnlyMuxingKind)).toEqual([
			...FILE_ONLY_MUXING_KINDS,
		]);
		// The DASH representation name, not a muxing kind of this plan.
		expect(isFileOnlyMuxingKind("PROGRESSIVE_WEBM")).toBe(false);
	});

	it("says a kind can hold audio exactly when its schema has additionalStreamKeys", () => {
		// Derived from the schema rather than typed out: a kind that gains the
		// field without joining the predicate would have its audio dropped by
		// the builder and offered by nothing.
		const fromSchema = planMuxingSchema.options
			.filter((o) => "additionalStreamKeys" in o.shape)
			.map((o) => o.shape.kind.value as string);
		expect(schemaKinds.filter(muxingKindCarriesAudio)).toEqual(fromSchema);
		expect(fromSchema).toEqual([
			"MP4",
			"TS",
			"PROGRESSIVE_TS",
			"PROGRESSIVE_MOV",
		]);
		expect(muxingKindCarriesAudio("NOT_A_KIND")).toBe(false);
	});

	it("is never an HLS leg, pinned or not", () => {
		for (const kind of FILE_ONLY_MUXING_KINDS) {
			expect(hlsLegSelected(kind, undefined), kind).toBe(false);
			expect(hlsLegSelected(kind, "TS"), kind).toBe(false);
		}
		// The counterfactual: an unpinned manifest does take a real leg.
		expect(hlsLegSelected("TS", undefined)).toBe(true);
	});
});

describe("compile — one op per file, the audio as additional stream refs", () => {
	it("sends a progressive TS file with exactly the fields the plan set", () => {
		const ops = compilePlan(
			planWith({
				muxings: [file("PROGRESSIVE_TS", { segmentLength: 4, startOffset: 0 })],
			}),
		);
		expect(ops.find((o) => o.step === "muxing:file")).toEqual({
			step: "muxing:file",
			kind: "CREATE_MUXING_PROGRESSIVE_TS",
			payload: {
				filename: "video.ts",
				segmentLength: 4,
				// Zero is a value, not an absence.
				startOffset: 0,
				outputPath: "files",
				name: "Video Progressive TS Muxing 360p",
			},
			refs: {
				encodingId: "encoding",
				streamId: "stream:v",
				additionalStreamIds: ["stream:a"],
				outputId: "output:out",
			},
		});
	});

	it("sends neither number when the plan sets neither", () => {
		const ops = compilePlan(planWith({ muxings: [file("PROGRESSIVE_TS")] }));
		expect(ops.find((o) => o.step === "muxing:file")?.payload).toEqual({
			filename: "video.ts",
			outputPath: "files",
			name: "Video Progressive TS Muxing 360p",
		});
	});

	it("sends a progressive MOV file", () => {
		const ops = compilePlan(planWith({ muxings: [file("PROGRESSIVE_MOV")] }));
		expect(ops.find((o) => o.step === "muxing:file")).toEqual({
			step: "muxing:file",
			kind: "CREATE_MUXING_PROGRESSIVE_MOV",
			payload: {
				filename: "video.mov",
				outputPath: "files",
				name: "Video Progressive MOV Muxing 360p",
			},
			refs: {
				encodingId: "encoding",
				streamId: "stream:v",
				additionalStreamIds: ["stream:a"],
				outputId: "output:out",
			},
		});
	});

	it("carries no additional refs for a video-only file", () => {
		const { additionalStreamKeys: _audio, ...videoOnly } =
			file("PROGRESSIVE_TS");
		const ops = compilePlan(planWith({ muxings: [videoOnly] }));
		expect(ops.find((o) => o.step === "muxing:file")?.refs).not.toHaveProperty(
			"additionalStreamIds",
		);
	});

	it("emits the file only after every stream it references", () => {
		for (const kind of FILE_ONLY_MUXING_KINDS) {
			const order = compilePlan(planWith({ muxings: [file(kind)] })).map(
				(o) => o.step,
			);
			expect(order.indexOf("stream:a"), kind).toBeGreaterThan(-1);
			expect(order.indexOf("muxing:file"), kind).toBeGreaterThan(
				order.indexOf("stream:a"),
			);
			expect(order.indexOf("muxing:file"), kind).toBeGreaterThan(
				order.indexOf("stream:v"),
			);
		}
	});
});

describe("never a manifest leg", () => {
	const without = planWith({ muxings: streaming, manifests });

	/**
	 * Both shapes a file can take. The audio-only one walks the AUDIO leg
	 * selections, which are separate code from the video ones.
	 */
	const shapes = FILE_ONLY_MUXING_KINDS.flatMap((kind) => [
		{ kind, label: `${kind} holding video and audio`, muxing: file(kind) },
		{ kind, label: `${kind} holding audio alone`, muxing: audioFile(kind) },
	]);
	for (const { kind, label, muxing } of shapes) {
		const withFile = planWith({
			muxings: [...streaming, muxing],
			manifests,
		});

		it(`${label}: the compiled plan is the one it was, plus one op`, () => {
			const ops = compilePlan(withFile);
			expect(ops.filter((o) => o.step === "muxing:file")).toHaveLength(1);
			expect(ops.filter((o) => o.step !== "muxing:file")).toEqual(
				compilePlan(without),
			);
		});

		it(`${label}: no manifest rail reads it as a leg`, () => {
			// The file sits outside the manifests' directory and shares its
			// renditions with the streaming legs — the two things that make a
			// REAL second leg trip a rail (see the counterfactual below).
			expect(
				validatePlan(withFile).filter(
					(issue) => issue.code !== "PLAN_MUXING_UNMEASURED_KIND",
				),
			).toEqual(validatePlan(without));
		});

		it(`${label}: the verifier expects the same manifests`, () => {
			expect(compileExpectedArtefacts(withFile).manifests).toEqual(
				compileExpectedArtefacts(without).manifests,
			);
		});

		it(`${label}: the template export gains the muxing and nothing else`, () => {
			const tree = parse(planToEncodingTemplateYaml(withFile));
			const section =
				kind === "PROGRESSIVE_TS" ? "progressiveTs" : "progressiveMov";
			expect(Object.keys(tree.encodings.main.muxings[section])).toEqual([
				"file",
			]);
			delete tree.encodings.main.muxings[section];
			expect(tree).toEqual(parse(planToEncodingTemplateYaml(without)));
		});
	}

	it("the counterfactual — the same two streams as a segmented TS leg DO change the manifest", () => {
		// Without this, every arm above would also pass on a compiler that
		// ignored all extra muxings, file or not.
		const asLeg = planWith({ muxings: [...streaming, tsLeg], manifests });
		const variants = (plan: ReturnType<typeof planWith>) =>
			compilePlan(plan).filter((o) => o.kind === "CREATE_HLS_STREAM_INFO");
		expect(variants(without)).toHaveLength(1);
		expect(variants(asLeg)).toHaveLength(2);
		const codes = validatePlan(asLeg).map((issue) => issue.code);
		expect(codes).toContain("PLAN_HLS_RENDITION_MULTI_LEG");
		expect(codes).toContain("PLAN_SEGMENT_PATH_NOT_UNDER_MANIFEST");
	});

	it("a drmKind pin asks nothing of a file", () => {
		// An unpinned-kind manifest "selects" every video muxing, so before the
		// file was excluded the pin demanded a CENC row for it — a row
		// PLAN_DRM_MUXING_MISMATCH then refuses. No plan could satisfy both.
		const pinned = manifests.map((m) => ({ ...m, drmKind: "CENC" }));
		const drm = [cenc("vmux"), cenc("amux")];
		const protectedLadder = planWith({
			muxings: streaming,
			manifests: pinned,
			drm,
		});
		for (const kind of FILE_ONLY_MUXING_KINDS) {
			const withFile = planWith({
				muxings: [...streaming, file(kind)],
				manifests: pinned,
				drm,
			});
			expect(
				validatePlan(withFile).filter(
					(issue) => issue.code !== "PLAN_MUXING_UNMEASURED_KIND",
				),
				kind,
			).toEqual(validatePlan(protectedLadder));
			expect(
				compilePlan(withFile).filter((o) => o.step !== "muxing:file"),
				kind,
			).toEqual(compilePlan(protectedLadder));
		}
	});

	it("a file with audio beside a video-only ladder is not a half-muxed ladder", () => {
		// An unpinned manifest reads every video muxing as a variant. Counted
		// as one, the file would be "a variant that carries its audio" beside
		// one that does not, with no audio entry for the latter to reference.
		const codes = (muxing: Muxing) =>
			validatePlan(
				planWith({
					muxings: [fmp4("vmux", "v", "x/video"), muxing],
					manifests: manifests.slice(0, 1),
				}),
			).map((issue) => issue.code);
		for (const kind of FILE_ONLY_MUXING_KINDS) {
			expect(codes(file(kind)), kind).not.toContain(
				"PLAN_HLS_PARTIAL_MUXED_LADDER",
			);
		}
		// A segmented leg carrying the same audio IS that ladder.
		expect(codes(tsLeg)).toContain("PLAN_HLS_PARTIAL_MUXED_LADDER");
	});

	it("a playlist is not given its audio by a file: a ladder whose only audio is inside one is refused", () => {
		// The track is packaged, so PLAN_UNMUXED_RENDITION is silent, and the file
		// is no variant, so the half-muxed rail is silent too. What is left is a
		// playlist whose every variant names an audio group nothing creates.
		const ladder = (muxings: Muxing[]) =>
			planWith({ muxings, manifests: manifests.slice(0, 1) });
		const unselected = (plan: ReturnType<typeof planWith>, options = {}) =>
			validatePlan(plan, options).filter(
				(issue) => issue.code === "PLAN_HLS_AUDIO_UNSELECTED",
			);
		for (const kind of FILE_ONLY_MUXING_KINDS) {
			const silent = ladder([fmp4("vmux", "v", "x/video"), file(kind)]);
			expect(unselected(silent), kind).toEqual([
				{
					code: "PLAN_HLS_AUDIO_UNSELECTED",
					level: "error",
					message: `manifest "hls" lists no audio although the plan has audio renditions: no variant carries an audio track and no audio media entry exists — it would play silent. No audio rendition has a container of its own that the manifest could list. A playlist gets its audio from an audio rendition's own container of a kind an HLS playlist lists (fMP4 by default), or from an audio track in every variant it lists`,
					path: "manifests[0]",
				},
			]);
			expect(
				compilePlan(silent).filter((o) => o.kind === "CREATE_HLS_AUDIO_MEDIA"),
				kind,
			).toEqual([]);
			// A job that already ran this way can be run again; it is told why.
			expect(
				unselected(silent, { demoteFileOutputRails: true }).map(
					(issue) => issue.level,
				),
				kind,
			).toEqual(["warning"]);
			// The same file beside a ladder that has its audio is no concern.
			expect(unselected(ladder([...streaming, file(kind)])), kind).toEqual([]);
		}
		// Variants that carry the audio themselves need no audio entry.
		expect(
			unselected(ladder([{ ...tsLeg, key: "vmux", streamKey: "v" }])),
		).toEqual([]);
	});

	it("says why, and where a playlist gets its audio: a pin, no container of its own, or the one encoding a default manifest lists", () => {
		const reason = (plan: ReturnType<typeof planWith>) =>
			validatePlan(plan)
				.filter((issue) => issue.code === "PLAN_HLS_AUDIO_UNSELECTED")
				.map((issue) => issue.message.split("it would play silent. ")[1]);
		const hls = { ...manifests[0] };
		const pinned = (kind: string) =>
			`A playlist gets its audio from an audio rendition's own container in ${kind}, the kind its audioMuxingKind names, or from an audio track in every variant it lists`;
		// The audio has its fMP4 container, and the manifest lists TS audio only.
		expect(
			reason(
				planWith({
					muxings: streaming,
					manifests: [{ ...hls, audioMuxingKind: "TS" }],
				}),
			),
		).toEqual([
			`Its audioMuxingKind (TS) leaves out every container the audio renditions have (FMP4). ${pinned("TS")}`,
		]);
		// Each kind the audio has is named once.
		const audioTs = {
			...tsLeg,
			key: "ats",
			streamKey: "a",
			additionalStreamKeys: undefined,
			destination: { outputKey: "out", path: "x/audio-ts" },
		};
		expect(
			reason(
				planWith({
					muxings: [...streaming, fmp4("amux2", "a", "x/audio-2"), audioTs],
					manifests: [{ ...hls, audioMuxingKind: "MP4" }],
				}),
			),
		).toEqual([
			`Its audioMuxingKind (MP4) leaves out every container the audio renditions have (FMP4, TS). ${pinned("MP4")}`,
		]);
		// A kind no HLS pin can name is named all the same, and no step is told:
		// which change answers it depends on the codec, and its own rule says so.
		const audioLeg = fmp4("amux", "a", "x/audio");
		expect(
			reason(
				planWith({
					muxings: [
						fmp4("vmux", "v", "x/video"),
						{ ...audioLeg, kind: "CMAF" },
					],
					manifests: [{ ...hls, audioMuxingKind: "FMP4" }],
				}),
			),
		).toEqual([
			`Its audioMuxingKind (FMP4) leaves out every container the audio renditions have (CMAF). ${pinned("FMP4")}`,
		]);
		expect(
			reason(
				planWith({
					renditions: [H264, { ...AAC, codec: "OPUS", bitrate: 96000 }],
					muxings: [
						fmp4("vmux", "v", "x/video"),
						{
							...audioLeg,
							kind: "WEBM",
							segmentNaming: "seg_%number%.chk",
							initSegmentName: "init.hdr",
						},
					],
					manifests: [{ ...hls, audioMuxingKind: "FMP4" }],
				}),
			),
		).toEqual([
			`Its audioMuxingKind (FMP4) leaves out every container the audio renditions have (WEBM). ${pinned("FMP4")}`,
		]);
		// The same pin where the audio is inside a file and has no container of
		// its own: the kind to give it is the pinned one, not the default.
		expect(
			reason(
				planWith({
					muxings: [fmp4("vmux", "v", "x/video"), file("PROGRESSIVE_TS")],
					manifests: [{ ...hls, audioMuxingKind: "TS" }],
				}),
			),
		).toEqual([
			`No audio rendition has a container of its own that the manifest could list. ${pinned("TS")}`,
		]);
		// A file that holds the audio alone is a container of its own, and still
		// none a manifest could list: no pin would include it.
		expect(
			reason(
				planWith({
					muxings: [fmp4("vmux", "v", "x/video"), audioFile("PROGRESSIVE_TS")],
					manifests: [{ ...hls, audioMuxingKind: "TS" }],
				}),
			),
		).toEqual([
			`No audio rendition has a container of its own that the manifest could list. ${pinned("TS")}`,
		]);
		// No pin: the default kind is named.
		expect(
			reason(
				planWith({
					muxings: [fmp4("vmux", "v", "x/video"), file("PROGRESSIVE_TS")],
					manifests: [hls],
				}),
			),
		).toEqual([
			"No audio rendition has a container of its own that the manifest could list. A playlist gets its audio from an audio rendition's own container of a kind an HLS playlist lists (fMP4 by default), or from an audio track in every variant it lists",
		]);
		// A default manifest lists the encoding of the first rendition; the audio
		// is in the other one, with a container of its own.
		const split = encodingPlanSchema.parse({
			...planWith({
				muxings: streaming,
				manifests: [{ ...hls, generationMode: "DEFAULT" }],
			}),
			encodings: [
				{ key: "one", name: "one" },
				{ key: "two", name: "two" },
			],
			renditions: [
				{ ...H264, encodingKey: "one" },
				{ ...AAC, encodingKey: "two" },
			],
		});
		expect(reason(split)).toEqual([
			"A default manifest is generated for one encoding, that of the plan's first rendition, and it has no audio rendition: put the audio in that encoding, or generate the manifest manually",
		]);
	});

	it("says nothing about the audio of a manifest that lists no video", () => {
		// With a pin no video muxing meets there is no variant to play silent.
		for (const kind of FILE_ONLY_MUXING_KINDS) {
			const codes = validatePlan(
				planWith({
					muxings: [fmp4("vmux", "v", "x/video"), file(kind)],
					manifests: [{ ...manifests[0], videoMuxingKind: "TS" }],
				}),
			).map((issue) => issue.code);
			expect(codes, kind).not.toContain("PLAN_HLS_AUDIO_UNSELECTED");
		}
	});

	it("a file with audio is not a self-contained variant of a per-audio-group manifest", () => {
		const codes = (muxing: Muxing) =>
			validatePlan(
				planWith({
					muxings: [...streaming, muxing],
					manifests: [{ ...manifests[0], variantsPerAudioGroup: true }],
				}),
			).map((issue) => issue.code);
		for (const kind of FILE_ONLY_MUXING_KINDS) {
			expect(codes(file(kind)), kind).not.toContain(
				"PLAN_HLS_MUXED_VARIANT_GROUPS",
			);
		}
		expect(codes(tsLeg)).toContain("PLAN_HLS_MUXED_VARIANT_GROUPS");
	});

	it("an audio-only file is not the audio entry a silent variant could point at", () => {
		// One audio media entry is what silences the half-muxed-ladder rail. A
		// file counted as that entry would hide a variant with no sound.
		const renditions = [
			H264,
			{ ...H264, key: "v2", height: 720, bitrate: 2000000 },
			AAC,
		];
		const halfMuxed: Muxing[] = [
			{
				...tsLeg,
				key: "carrying",
				destination: { outputKey: "out", path: "x/v" },
			},
			{
				key: "silent",
				kind: "TS",
				streamKey: "v2",
				segmentLength: 4,
				segmentNaming: "seg_%number%.ts",
				destination: { outputKey: "out", path: "x/v2" },
			},
		];
		const codes = (extra: Muxing[]) =>
			validatePlan(
				planWith({
					renditions,
					muxings: [...halfMuxed, ...extra],
					manifests: manifests.slice(0, 1),
				}),
			).map((issue) => issue.code);
		expect(codes([])).toContain("PLAN_HLS_PARTIAL_MUXED_LADDER");
		for (const kind of FILE_ONLY_MUXING_KINDS) {
			expect(codes([audioFile(kind)]), kind).toContain(
				"PLAN_HLS_PARTIAL_MUXED_LADDER",
			);
		}
		// A real standalone audio container is what does silence it.
		expect(codes([fmp4("amux", "a", "x/audio")])).not.toContain(
			"PLAN_HLS_PARTIAL_MUXED_LADDER",
		);
	});

	it("a file is not a DASH video representation — the manifest is refused, not emptied", () => {
		// DASH selects its legs from a closed list, so the file was never going
		// to be listed. What this pins is the other half: a manifest left with
		// audio only is refused in words rather than published without a picture.
		for (const kind of FILE_ONLY_MUXING_KINDS) {
			const plan = planWith({
				muxings: [file(kind), fmp4("amux", "a", "x/audio")],
				manifests: manifests.slice(1),
			});
			expect(
				validatePlan(plan).find(
					(issue) => issue.code === "PLAN_DASH_VIDEO_UNSELECTED",
				),
				kind,
			).toMatchObject({ level: "error", path: "manifests[0]" });
			expect(
				compilePlan(plan)
					.filter((o) => o.kind.startsWith("CREATE_DASH_REPRESENTATION"))
					.map((o) => o.step),
				kind,
			).toEqual(["manifest:dash:rep:amux"]);
		}
	});

	it("a file is not something an HLS manifest can be made of", () => {
		// The wizard's default leaves HLS on; choosing a file kind for the only
		// video container must be refused in words, not compiled into a master
		// playlist with no variants.
		for (const kind of FILE_ONLY_MUXING_KINDS) {
			const issues = validatePlan(
				planWith({
					muxings: [file(kind), fmp4("amux", "a", "x/audio")],
					manifests: manifests.slice(0, 1),
				}),
			);
			expect(
				issues.find((issue) => issue.code === "PLAN_HLS_VIDEO_UNSELECTED"),
				kind,
			).toMatchObject({ level: "error", path: "manifests[0].videoMuxingKind" });
		}
	});

	it("is on every Akamai MSL forbidden list, as MP4 is", () => {
		for (const [format, need] of Object.entries(AKAMAI_MSL_REQUIREMENTS)) {
			for (const kind of FILE_ONLY_MUXING_KINDS) {
				expect(need.forbidden as readonly string[], format).toContain(kind);
			}
		}
	});
});

describe("validation rails", () => {
	it("the codec matrix has a row for every schema kind, and the file rows are H264 with AAC", () => {
		expect(Object.keys(MUXING_CODEC_MATRIX).sort()).toEqual(
			[...schemaKinds].sort(),
		);
		expect(MUXING_CODEC_MATRIX.PROGRESSIVE_TS).toEqual(["H264", "AAC"]);
		expect(MUXING_CODEC_MATRIX.PROGRESSIVE_MOV).toEqual(["H264", "AAC"]);
	});

	it.each(
		FILE_ONLY_MUXING_KINDS,
	)("%s refuses a codec outside its row — every stream in the file, not just the first", (kind) => {
		const mismatches = validatePlan(
			planWith({
				renditions: [
					{ ...H264, codec: "H265" },
					{ ...AAC, codec: "AC3", bitrate: 192000 },
				],
				muxings: [file(kind)],
			}),
		).filter((issue) => issue.code === "PLAN_MUXING_CODEC_MISMATCH");
		expect(mismatches.map((issue) => [issue.level, issue.path])).toEqual([
			["error", "muxings[0].streamKey"],
			["error", "muxings[0].additionalStreamKeys[0]"],
		]);
		expect(mismatches[0]?.message).toContain("allowed: H264/AAC");
	});

	it("says a MOV file is unmeasured — a warning, and the only thing it says", () => {
		expect(
			validatePlan(planWith({ muxings: [file("PROGRESSIVE_MOV")] })).map(
				(issue) => [issue.code, issue.level, issue.path],
			),
		).toEqual([["PLAN_MUXING_UNMEASURED_KIND", "warning", "muxings[0].kind"]]);
	});

	it("says nothing of the kind about a TS file, whose request shape Bitmovin publishes", () => {
		expect(
			validatePlan(planWith({ muxings: [file("PROGRESSIVE_TS")] })),
		).toEqual([]);
	});

	const drmRows: Record<string, (muxingKey: string) => Muxing> = {
		CENC: cenc,
		FAIRPLAY: (muxingKey) => ({
			key: `${muxingKey}-fairplay`,
			kind: "FAIRPLAY",
			muxingKey,
			credentialId: `${CRED}3`,
			iv: "00112233445566778899aabbccddeeff",
			uri: "skd://key",
			destination: drmDestination(muxingKey),
		}),
		SPEKE: (muxingKey) => ({
			key: `${muxingKey}-speke`,
			kind: "SPEKE",
			muxingKey,
			credentialId: `${CRED}3`,
			systemIds: ["edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"],
			destination: drmDestination(muxingKey),
		}),
	};
	for (const [drmKind, row] of Object.entries(drmRows)) {
		it.each(
			FILE_ONLY_MUXING_KINDS,
		)(`refuses ${drmKind} encryption of a %s file`, (kind) => {
			const refusal = validatePlan(
				planWith({ muxings: [file(kind)], drm: [row("file")] }),
			).find((issue) => issue.code === "PLAN_DRM_MUXING_MISMATCH");
			expect(refusal).toMatchObject({
				level: "error",
				path: "drm[0].muxingKey",
			});
			expect(refusal?.message).toContain(kind);
		});
	}

	it("warns about several audio tracks in a file, and blocks them in segmented TS as before", () => {
		const twoTracks = [H264, AAC, { ...AAC, key: "a2", bitrate: 64000 }];
		const multiple = (muxing: Muxing) =>
			validatePlan(planWith({ renditions: twoTracks, muxings: [muxing] })).find(
				(issue) => issue.code === "PLAN_MUXING_MULTIPLE_AUDIO",
			);
		for (const kind of FILE_ONLY_MUXING_KINDS) {
			const issue = multiple(file(kind, { additionalStreamKeys: ["a", "a2"] }));
			expect(issue, kind).toMatchObject({
				level: "warning",
				path: "muxings[0].additionalStreamKeys",
			});
			// A file is on no manifest, so the streaming wording would describe
			// something that does not exist.
			expect(issue?.message, kind).toContain("a file can hold several");
			expect(issue?.message, kind).not.toContain("manifest references");
		}
		expect(
			multiple({ ...tsLeg, additionalStreamKeys: ["a", "a2"] }),
		).toMatchObject({ level: "error" });
	});
});

describe("template export — the official schema's own sections and field names", () => {
	const KEY = "^[A-Za-z0-9_-]+$";
	const schema = JSON.parse(
		readFileSync(
			join(__dirname, "__fixtures__", "bitmovin-encoding-template.schema.json"),
			"utf8",
		),
	);
	/** The field names the vendored schema declares for one muxing section. */
	const declaredFields = (section: string): string[] =>
		Object.keys(
			schema.properties.encodings.patternProperties[KEY].properties.muxings
				.properties[section].patternProperties[KEY].properties.properties
				.properties,
		);
	const exported = (plan: ReturnType<typeof planWith>) =>
		parse(planToEncodingTemplateYaml(plan));

	it("writes a progressive TS file", () => {
		const muxings = exported(
			planWith({
				muxings: [
					file("PROGRESSIVE_TS", { segmentLength: 4, startOffset: 10 }),
				],
			}),
		).encodings.main.muxings;
		expect(muxings).toEqual({
			progressiveTs: {
				file: {
					properties: {
						filename: "video.ts",
						segmentLength: 4,
						startOffset: 10,
						streams: [
							{ streamId: "$/encodings/main/streams/v" },
							{ streamId: "$/encodings/main/streams/a" },
						],
						outputs: [{ outputId: "$/outputs/s3/out", outputPath: "files" }],
					},
				},
			},
		});
	});

	it("writes a progressive MOV file", () => {
		expect(
			exported(planWith({ muxings: [file("PROGRESSIVE_MOV")] })).encodings.main
				.muxings,
		).toEqual({
			progressiveMov: {
				file: {
					properties: {
						filename: "video.mov",
						streams: [
							{ streamId: "$/encodings/main/streams/v" },
							{ streamId: "$/encodings/main/streams/a" },
						],
						outputs: [{ outputId: "$/outputs/s3/out", outputPath: "files" }],
					},
				},
			},
		});
	});

	it("uses only field names the schema declares for that section", () => {
		// The schema has no `additionalProperties: false`, so ajv below would
		// accept a misspelt key. This is the half ajv cannot see.
		const cases = [
			[
				"progressiveTs",
				file("PROGRESSIVE_TS", { segmentLength: 4, startOffset: 10 }),
			],
			["progressiveMov", file("PROGRESSIVE_MOV")],
		] as const;
		for (const [section, muxing] of cases) {
			const written = Object.keys(
				exported(planWith({ muxings: [muxing] })).encodings.main.muxings[
					section
				].file.properties,
			);
			const declared = declaredFields(section);
			expect(
				written.filter((key) => !declared.includes(key)),
				section,
			).toEqual([]);
		}
	});

	it("validates against the official template schema", () => {
		const validateTemplate = new Ajv2020({
			strict: false,
			allErrors: true,
			logger: false,
		}).compile(schema);
		for (const muxing of [
			file("PROGRESSIVE_TS", { segmentLength: 4, startOffset: 10 }),
			file("PROGRESSIVE_MOV"),
		]) {
			validateTemplate(exported(planWith({ muxings: [muxing] })));
			expect(validateTemplate.errors ?? []).toEqual([]);
		}
	});
});

describe("what is expected on storage, and shown on the job page", () => {
	it("one named file, carrying the video and the audio muxed into it", () => {
		for (const kind of FILE_ONLY_MUXING_KINDS) {
			const [expected] = compileExpectedArtefacts(
				planWith({ muxings: [file(kind)] }),
			).muxings;
			expect(expected, kind).toMatchObject({
				muxingKey: "file",
				// The provider's own MuxingType, which per-title delivery matches on.
				container: kind,
				outputKey: "out",
				dir: { prefix: "files/", templated: false },
				filename: kind === "PROGRESSIVE_TS" ? "video.ts" : "video.mov",
				perTitle: false,
				video: { codec: "H264", height: 360 },
				audio: { codec: "AAC" },
			});
			// A whole file has no segments and no init to look for.
			expect(expected, kind).not.toHaveProperty("segmentNaming");
			expect(expected, kind).not.toHaveProperty("initSegment");
		}
	});

	it("is listed under both renditions it holds", () => {
		const summaries = renditionSummaries(
			planWith({ muxings: [file("PROGRESSIVE_TS")] }),
		);
		expect(summaries.video[0]?.muxings).toMatchObject([
			{
				key: "file",
				kind: "PROGRESSIVE_TS",
				filename: "video.ts",
				sharedWith: ["a"],
				destination: { outputKey: "out", path: "files" },
			},
		]);
		expect(summaries.audio[0]?.muxings).toMatchObject([
			{ key: "file", kind: "PROGRESSIVE_TS", carriedBy: "v" },
		]);
	});
});

describe("wizard — build, and reopen in the form", () => {
	const credentialId = "23456789-0123-4567-89ab-0123456789ab";
	const wizardState = (over: Partial<WizardState>): WizardState => ({
		...DEFAULT_WIZARD_STATE,
		name: "File output",
		inputFiles: [
			{
				key: "main",
				inputKey: "main",
				kind: "S3",
				credentialId,
				bucket: "input",
				path: "source.mp4",
			},
		],
		output: {
			...DEFAULT_WIZARD_STATE.output,
			credentialId,
			bucket: "output",
			basePath: "job/",
		},
		...over,
	});
	const carriedAudio: WizardState["audios"] = [
		{
			codec: "AAC",
			bitrate: 128_000,
			rate: 48_000,
			channelLayout: "CL_STEREO",
			muxing: { ownContainer: false },
		},
	];
	const noManifests = { hls: false, dash: false };
	/** Round trip through the importer's own gate: exact, or refused. */
	const reopen = (state: WizardState) => {
		const plan = encodingPlanSchema.parse(buildPlan(state));
		const imported = tryImportPresetIntoWizard(
			plan as unknown as Record<string, unknown>,
		);
		return { plan, imported };
	};

	const tsOnly = wizardState({
		videos: [
			{
				height: 360,
				bitrate: 300_000,
				muxing: {
					kind: "PROGRESSIVE_TS",
					muxedAudioKeys: ["a128"],
					filename: "movie.ts",
					// 6 is what the segmented kinds drop on import as "the default";
					// here it is an explicit choice and must survive.
					segmentLength: 6,
					startOffset: 0,
				},
			},
		],
		audios: carriedAudio,
		manifests: noManifests,
	});

	it("emits the file with its audio inside, and no container beside it", () => {
		expect(buildPlan(tsOnly).muxings).toEqual([
			{
				key: "v360",
				kind: "PROGRESSIVE_TS",
				streamKey: "v360",
				additionalStreamKeys: ["a128"],
				filename: "movie.ts",
				segmentLength: 6,
				startOffset: 0,
				destination: {
					outputKey: "origin",
					path: "job/video/360p",
					acl: "PUBLIC_READ",
				},
			},
		]);
	});

	it("produces a plan with nothing to say about", () => {
		const { plan } = reopen(tsOnly);
		expect(validatePlan(plan)).toEqual([]);
		expect(plan.manifests).toEqual([]);
	});

	it("names the file when the form leaves it blank", () => {
		const built = (kind: FileKind) =>
			buildPlan(
				wizardState({
					videos: [{ height: 360, bitrate: 300_000, muxing: { kind } }],
					audios: [],
					manifests: noManifests,
				}),
			).muxings[0];
		expect(built("PROGRESSIVE_TS")).toMatchObject({ filename: "output.ts" });
		expect(built("PROGRESSIVE_MOV")).toMatchObject({ filename: "output.mov" });
		// …and sends no number the form did not set.
		expect(built("PROGRESSIVE_TS")).not.toHaveProperty("segmentLength");
		expect(built("PROGRESSIVE_TS")).not.toHaveProperty("startOffset");
	});

	it("does not carry a TS file's numbers into another kind when the form switches", () => {
		// The form keeps what was typed when the kind changes. Every muxing
		// schema is strict, so a leftover `startOffset` reaching another kind
		// would fail the whole plan on a field that is not on screen any more.
		const built = (kind: "PROGRESSIVE_MOV" | "FMP4" | "MP4") =>
			buildPlan(
				wizardState({
					videos: [
						{
							height: 360,
							bitrate: 300_000,
							muxing: {
								kind,
								filename: "movie.mov",
								segmentLength: 4,
								startOffset: 10,
							},
						},
					],
					audios: [],
					manifests: noManifests,
				}),
			).muxings[0];
		for (const kind of ["PROGRESSIVE_MOV", "FMP4", "MP4"] as const) {
			expect(built(kind), kind).not.toHaveProperty("startOffset");
			expect(planMuxingSchema.safeParse(built(kind)).success, kind).toBe(true);
		}
		expect(built("PROGRESSIVE_MOV")).not.toHaveProperty("segmentLength");
	});

	it("reopens a TS file exactly — the explicit 6 and the zero included", () => {
		const { plan, imported } = reopen(tsOnly);
		expect(imported.ok).toBe(true);
		if (!imported.ok) return;
		expect(encodingPlanSchema.parse(buildPlan(imported.state))).toEqual(plan);
		expect(imported.state.videos[0]?.muxing).toMatchObject({
			kind: "PROGRESSIVE_TS",
			filename: "movie.ts",
			segmentLength: 6,
			startOffset: 0,
			muxedAudioKeys: ["a128"],
		});
	});

	it("reopens a MOV file added beside a streaming ladder", () => {
		const { plan, imported } = reopen(
			wizardState({
				videos: [
					{
						height: 360,
						bitrate: 300_000,
						extraMuxings: [
							{
								kind: "PROGRESSIVE_MOV",
								key: "v360-leg1",
								muxedAudioKeys: ["a128"],
								filename: "movie.mov",
								path: "files",
							},
						],
					},
				],
			}),
		);
		// The HLS manifest lists the fMP4 leg and not the file.
		expect(
			compilePlan(plan).filter((o) => o.kind === "CREATE_HLS_STREAM_INFO"),
		).toHaveLength(1);
		expect(imported.ok).toBe(true);
		if (!imported.ok) return;
		expect(encodingPlanSchema.parse(buildPlan(imported.state))).toEqual(plan);
		expect(imported.state.videos[0]?.extraMuxings).toMatchObject([
			{
				kind: "PROGRESSIVE_MOV",
				key: "v360-leg1",
				filename: "movie.mov",
				muxedAudioKeys: ["a128"],
			},
		]);
	});

	it("still writes a destination when a DRM row names the file, so the refusal can say why", () => {
		// Every other kind drops its destination when a DRM row owns the
		// output. Doing that here would fail the schema on a missing field and
		// tell the operator nothing about the encryption row that caused it.
		const built = buildPlan(
			wizardState({
				videos: [
					{
						height: 360,
						bitrate: 300_000,
						muxing: { kind: "PROGRESSIVE_TS" },
					},
				],
				audios: [],
				manifests: noManifests,
				drm: [
					{
						kind: "CENC",
						muxingKey: "v360",
						credentialId,
						kid: "00112233445566778899aabbccddeeff",
					},
				] as WizardState["drm"],
			}),
		);
		const parsed = encodingPlanSchema.safeParse(built);
		expect(parsed.success).toBe(true);
		if (!parsed.success) return;
		expect(parsed.data.muxings[0]).toMatchObject({
			destination: { path: "job/video/360p" },
		});
		expect(
			validatePlan(parsed.data)
				.filter((issue) => issue.level === "error")
				.map((issue) => issue.code),
		).toContain("PLAN_DRM_MUXING_MISMATCH");
	});
});
