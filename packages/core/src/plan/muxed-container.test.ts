import { describe, expect, it } from "vitest";
import { compilePlan } from "./compiler";
import { renditionSummaries } from "./detail-view";
import { encodingPlanSchema } from "./schema";
import { planToEncodingTemplateYaml } from "./template";
import { validatePlan } from "./validate";

/**
 * One container, two streams — .
 *
 * `Muxing.streams` is a `MuxingStream[]` in Bitmovin's own model, and this
 * repo pinned it to exactly one from the schema down to the SDK call, where
 * `streams: [new MuxingStream({ streamId })]` was a literal. The consequence
 * was not a missing knob: muxed MPEG-TS (video and audio in every variant's
 * segments) is the classic HLS layout, and a progressive MP4 holding only
 * video is not a deliverable file.
 *
 * These arms hold the three things the change has to keep true at once — the
 * extra streams REACH the wire, the readers that map muxing→rendition still
 * answer correctly, and a container that cannot work is refused before it is
 * built rather than after it is billed.
 */

const CRED = "00000000-0000-4000-8000-00000000000";

type Muxing = Record<string, unknown>;

function planWith(opts: {
	muxings: Muxing[];
	renditions?: Record<string, unknown>[];
	manifests?: Record<string, unknown>[];
	perTitle?: boolean;
}) {
	return encodingPlanSchema.parse({
		planVersion: 1,
		name: "muxed",
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
		renditions: opts.renditions ?? [
			{
				key: "v",
				codec: "H264",
				ingestKey: "video",
				height: 360,
				bitrate: 800000,
				...(opts.perTitle ? { mode: "PER_TITLE_TEMPLATE" } : {}),
			},
			{
				key: "a",
				codec: "AAC",
				ingestKey: "audio",
				bitrate: 128000,
				rate: 48000,
			},
		],
		muxings: opts.muxings,
		manifests: opts.manifests ?? [],
		generation: { timing: "POST_ENCODING" },
	});
}

const ts = (over: Muxing = {}): Muxing => ({
	key: "mux",
	kind: "TS",
	streamKey: "v",
	segmentLength: 6,
	segmentNaming: "seg_%number%.ts",
	destination: { outputKey: "out", path: "x/360p{uuid}" },
	...over,
});

const codesFor = (plan: ReturnType<typeof planWith>): string[] =>
	validatePlan(plan).map((i) => i.code);

describe("a container may carry more than one stream", () => {
	/**
	 * THE READER FIX, and the one a green suite could not have told me about.
	 *
	 * `PLAN_UNMUXED_RENDITION` warns that a rendition "will be encoded but
	 * never packaged". It read `muxing.streamKey` — complete while a container
	 * held one stream, and silently wrong the moment it held two: the audio a
	 * user deliberately muxed into the video would be reported as never
	 * packaged. Nothing throws when a reader like this goes stale, which is
	 * exactly why it gets its own arm.
	 */
	it("does not call a muxed-in rendition unpackaged", () => {
		const codes = codesFor(
			planWith({ muxings: [ts({ additionalStreamKeys: ["a"] })] }),
		);
		expect(codes).not.toContain("PLAN_UNMUXED_RENDITION");
	});

	it("still warns about a rendition nothing packages at all", () => {
		// The counterfactual. Without it the arm above passes on a rail that
		// was deleted rather than a rail that was taught to count.
		expect(codesFor(planWith({ muxings: [ts()] }))).toContain(
			"PLAN_UNMUXED_RENDITION",
		);
	});

	it("resolves the additional refs, and names the one that does not", () => {
		const issues = validatePlan(
			planWith({ muxings: [ts({ additionalStreamKeys: ["nope"] })] }),
		);
		const ref = issues.find((i) => i.code === "PLAN_UNRESOLVED_REF");
		expect(ref?.message).toContain("nope");
		expect(ref?.path).toBe("muxings[0].additionalStreamKeys[0]");
	});

	/**
	 * The container/codec matrix used to judge the PRIMARY only. That was a
	 * complete check of a one-stream container and an incomplete check of a
	 * two-stream one — a WEBVTT or DDPLUS rendition muxed into a TS would have
	 * ridden to the encoder behind a passing H264 primary.
	 */
	it("judges the codec of every packaged stream, not just the primary", () => {
		const issue = validatePlan(
			planWith({
				renditions: [
					{
						key: "v",
						codec: "H264",
						ingestKey: "video",
						height: 360,
						bitrate: 800000,
					},
					{
						key: "a",
						codec: "DDPLUS",
						ingestKey: "audio",
						bitrate: 128000,
						rate: 48000,
					},
				],
				muxings: [ts({ additionalStreamKeys: ["a"] })],
			}),
		).find((i) => i.code === "PLAN_MUXING_CODEC_MISMATCH");
		expect(issue?.message).toContain("DDPLUS");
		expect(issue?.path).toBe("muxings[0].additionalStreamKeys[0]");
	});

	it("refuses a container that lists one rendition twice", () => {
		expect(
			codesFor(planWith({ muxings: [ts({ additionalStreamKeys: ["v"] })] })),
		).toContain("PLAN_MUXING_DUPLICATE_STREAM");
	});

	it("refuses two pictures in one container", () => {
		expect(
			codesFor(
				planWith({
					renditions: [
						{
							key: "v",
							codec: "H264",
							ingestKey: "video",
							height: 360,
							bitrate: 800000,
						},
						{
							key: "v2",
							codec: "H264",
							ingestKey: "video",
							height: 720,
							bitrate: 2400000,
						},
					],
					muxings: [ts({ additionalStreamKeys: ["v2"] })],
				}),
			),
		).toContain("PLAN_MUXING_MULTIPLE_VIDEO");
	});

	/**
	 * The picture must be stream 0 — an invariant four readers depend on
	 * (`vmaf/targets`, `vmaf/live-targets`, `verify/expected`'s qc mirrors and
	 * the detail view all ask `m.streamKey === rendition.key` to find "the
	 * container for this video"). Enforcing it in one rail is cheaper than
	 * teaching each of them to search the additional list.
	 */
	it("refuses video hidden behind a non-video primary", () => {
		expect(
			codesFor(
				planWith({
					muxings: [ts({ streamKey: "a", additionalStreamKeys: ["v"] })],
				}),
			),
		).toContain("PLAN_MUXING_VIDEO_NOT_PRIMARY");
	});

	it("refuses an empty additional list — there is no half-muxed state", () => {
		expect(() =>
			planWith({ muxings: [ts({ additionalStreamKeys: [] })] }),
		).toThrow();
	});
});

describe("the muxed streams reach the wire, in order", () => {
	const plan = planWith({ muxings: [ts({ additionalStreamKeys: ["a"] })] });
	const ops = compilePlan(plan);

	it("carries every stream as a ref, primary first", () => {
		const mux = ops.find((o) => o.kind === "CREATE_MUXING_TS");
		expect(mux?.refs.streamId).toBe("stream:v");
		expect(mux?.refs.additionalStreamIds).toEqual(["stream:a"]);
	});

	/**
	 * The ordering half, which is the one that would have failed at RUNTIME on
	 * a plan that compiled clean: refs resolve against ids created by earlier
	 * steps, and the muxing used to be emitted while iterating its primary —
	 * before the muxed-in rendition's stream existed. `refId` would have thrown
	 * mid-run, after the encoding and several resources had been created.
	 */
	it("emits the container only after every stream it references", () => {
		const at = (step: string) => ops.findIndex((o) => o.step === step);
		expect(at("stream:a")).toBeGreaterThan(-1);
		expect(at("muxing:mux")).toBeGreaterThan(at("stream:a"));
	});

	it("leaves a single-stream container exactly where it was", () => {
		// The no-op claim, asserted rather than assumed: the whole corpus of 80
		// goldens rests on it, and a reordering that only showed up in fixture
		// churn would be found by a diff, not by a test.
		const single = compilePlan(planWith({ muxings: [ts()] }));
		const order = single.map((o) => o.step);
		expect(order.indexOf("muxing:mux")).toBe(order.indexOf("stream:v") + 1);
	});
});

describe("C33 — a self-contained variant names no audio group", () => {
	const hls = [
		{
			key: "hls",
			kind: "HLS",
			manifestName: "stream.m3u8",
			destination: { outputKey: "out", path: "" },
			audioGroupId: "audio",
		},
	];

	it("omits `audio` when the segments already carry it", () => {
		const ops = compilePlan(
			planWith({
				muxings: [ts({ additionalStreamKeys: ["a"] })],
				manifests: hls,
			}),
		);
		const variant = ops.find((o) => o.kind === "CREATE_HLS_STREAM_INFO");
		expect(variant).toBeDefined();
		expect(variant?.payload).not.toHaveProperty("audio");
	});

	it("emits no EXT-X-MEDIA entry for the muxed-in audio", () => {
		const ops = compilePlan(
			planWith({
				muxings: [ts({ additionalStreamKeys: ["a"] })],
				manifests: hls,
			}),
		);
		expect(ops.filter((o) => o.kind === "CREATE_HLS_AUDIO_MEDIA")).toHaveLength(
			0,
		);
	});

	it("still names the group when the audio rides its own container", () => {
		// The counterfactual that makes the two arms above mean something: with
		// a separate audio muxing the group is REQUIRED, and a fix that simply
		// stopped emitting `audio` everywhere would pass the arms above.
		const ops = compilePlan(
			planWith({
				muxings: [
					ts(),
					{
						key: "amux",
						kind: "TS",
						streamKey: "a",
						segmentLength: 6,
						segmentNaming: "seg_%number%.ts",
						destination: { outputKey: "out", path: "x/audio" },
					},
				],
				manifests: hls,
			}),
		);
		const variant = ops.find((o) => o.kind === "CREATE_HLS_STREAM_INFO");
		expect(variant?.payload.audio).toBe("audio");
		expect(ops.filter((o) => o.kind === "CREATE_HLS_AUDIO_MEDIA")).toHaveLength(
			1,
		);
	});

	it("refuses variantsPerAudioGroup on a self-contained variant", () => {
		expect(
			codesFor(
				planWith({
					muxings: [ts({ additionalStreamKeys: ["a"] })],
					manifests: [{ ...hls[0], variantsPerAudioGroup: true }],
				}),
			),
		).toContain("PLAN_HLS_MUXED_VARIANT_GROUPS");
	});
});

describe("C33 reaches the per-title variants too", () => {
	const hls = [
		{
			key: "hls",
			kind: "HLS",
			manifestName: "stream.m3u8",
			destination: { outputKey: "out", path: "" },
			audioGroupId: "audio",
			videoMuxingKind: "TS",
		},
	];

	/**
	 * The variants that a per-title run produces are created AFTER the encode,
	 * by expanding the template muxing — so they inherit its streams. A muxed
	 * template therefore yields self-contained variants with no EXT-X-MEDIA
	 * group, and this op named one anyway.
	 *
	 * Worse on this path than on the static one: nobody sees these variants
	 * until the encode has finished and been billed, so a dangling GROUP-ID
	 * surfaces as "the ladder has no sound" long after the run.
	 */
	it("omits the group on the expansion when the template carries its audio", () => {
		const ops = compilePlan(
			planWith({
				perTitle: true,
				muxings: [ts({ additionalStreamKeys: ["a"] })],
				manifests: hls,
			}),
		);
		const expansion = ops.find(
			(o) => o.kind === "CREATE_HLS_PER_TITLE_VARIANTS",
		);
		expect(expansion).toBeDefined();
		expect(expansion?.payload).not.toHaveProperty("audio");
	});

	it("still names it when the per-title audio rides its own container", () => {
		const ops = compilePlan(
			planWith({ perTitle: true, muxings: [ts()], manifests: hls }),
		);
		const expansion = ops.find(
			(o) => o.kind === "CREATE_HLS_PER_TITLE_VARIANTS",
		);
		expect(expansion?.payload.audio).toBe("audio");
	});
});

describe("per-title muxed audio is unverified, not forbidden", () => {
	it("warns rather than blocks", () => {
		const issues = validatePlan(
			planWith({
				perTitle: true,
				muxings: [ts({ additionalStreamKeys: ["a"] })],
			}),
		);
		const issue = issues.find((i) => i.code === "PLAN_PER_TITLE_MUXED_AUDIO");
		expect(issue?.level).toBe("warning");
		expect(issue?.message).toContain("unverified");
	});
});

/**
 * THE READERS THAT WERE STILL COUNTING TO ONE.
 *
 * `muxingStreamKeys` exists so this question has one answer, but a rule only
 * helps the readers that ASK it. These two were found by working the review
 * brief myself rather than by any failing test — both were correct for a
 * one-stream container and both went quietly wrong at two, which is the exact
 * failure the rule module was written to end.
 */
describe("the whole container reaches the readers, not just its primary", () => {
	const muxedPlan = () =>
		planWith({ muxings: [ts({ additionalStreamKeys: ["a"] })] });

	/**
	 * The wizard exposes this YAML to the operator as "Template YAML" to copy.
	 * It emitted a one-element `streams` list, so a muxed plan handed them a
	 * template that encodes the video WITHOUT the audio — a silent truncation
	 * of the very thing they had just configured.
	 */
	it("the template YAML lists every stream in the container", () => {
		const yaml = planToEncodingTemplateYaml(muxedPlan());
		expect(yaml).toContain("streams/v");
		expect(yaml).toContain("streams/a");
	});

	it("and still lists exactly one for a plain container", () => {
		const yaml = planToEncodingTemplateYaml(planWith({ muxings: [ts()] }));
		expect(yaml).toContain("streams/v");
		expect(yaml).not.toContain("streams/a");
	});

	/**
	 * The detail view indexed muxings by `streamKey`, so the audio row rendered
	 * with NO muxings — the page told the operator the track was packaged
	 * nowhere, about a plan that packages it inside the video's segments.
	 */
	it("the detail view shows the muxed track its container, and says whose it is", () => {
		const summaries = renditionSummaries(muxedPlan());
		const audio = summaries.audio[0];
		expect(audio?.muxings).toHaveLength(1);
		expect(audio?.muxings[0]?.key).toBe("mux");
		expect(audio?.muxings[0]?.sharedWith).toEqual(["v"]);
		// The video side names its passenger, so the page reads correctly from
		// either row rather than only from the one that was broken.
		expect(summaries.video[0]?.muxings[0]?.sharedWith).toEqual(["a"]);
	});

	it("leaves sharedWith off a container that carries one rendition", () => {
		const summaries = renditionSummaries(planWith({ muxings: [ts()] }));
		expect(summaries.video[0]?.muxings[0]).not.toHaveProperty("sharedWith");
		expect(summaries.video[0]?.muxings[0]).not.toHaveProperty("carriedBy");
	});

	/**
	 * Encryption follows the CONTAINER, so it shows on both rows — a new claim
	 * the detail page makes since the index changed, flagged by review as
	 * defensible and unpinned. It is defensible because it is true: FairPlay on
	 * a muxed TS encrypts the segments, and the audio inside them with it. An
	 * operator reading the audio row needs to know the bytes are encrypted;
	 * `carriedBy` beside it says whose container did the encrypting.
	 */
	it("shows a muxed container's DRM on the passenger's row too", () => {
		const plan = planWith({
			muxings: [ts({ additionalStreamKeys: ["a"], destination: undefined })],
		});
		const withDrm = encodingPlanSchema.parse({
			...plan,
			drm: [
				{
					key: "fp",
					kind: "FAIRPLAY",
					muxingKey: "mux",
					credentialId: `${CRED}3`,
					iv: "00000000000000000000000000000000",
					uri: "skd://example",
					destination: { outputKey: "out", path: "x/enc" },
				},
			],
		});
		const summaries = renditionSummaries(withDrm);
		const audioLeg = summaries.audio[0]?.muxings[0];
		expect(audioLeg?.drm.map((d) => d.kind)).toEqual(["FAIRPLAY"]);
		expect(audioLeg?.carriedBy).toBe("v");
	});
});

/**
 * THE EMIT POSITION IS PER-MUXING, NOT PER-KEY.
 *
 * My first cut stored it in a `Map` keyed by `muxing.key`, which collapses
 * duplicates: every container sharing a key is gated on whichever registered
 * LAST. `PLAN_DUPLICATE_KEY` refuses such a plan at validation — but
 * `compilePlan` runs on schema-parsed input that has NOT been validated, and
 * the wizard's live preview compiles every keystroke. Two containers briefly
 * sharing a key is an ordinary state to pass through while renaming one.
 *
 * THE ORDER HERE IS THE TEST. My first attempt at this arm listed the earlier
 * rendition's muxing first, and the Map-keyed version PASSED it: collapsing to
 * the LATER position still leaves every ref backward-pointing, so nothing goes
 * wrong. Reversed — the later rendition's container first — the collapse pulls
 * it to the EARLIER position and its `stream:` ref now points at a step that
 * does not exist yet. That is a compile-clean plan that throws mid-run, which
 * is the same failure `muxingEmitsOn` exists to prevent.
 *
 * (Second time I have written the passing arm first. The lesson is that an
 * arm which merely EXERCISES the code is not an arm that would catch its
 * absence — the mutation is what tells them apart, and it said SURVIVED.)
 */
describe("a duplicate muxing key does not misplace a container", () => {
	it("keeps every ref backward-pointing, whatever the key collision", () => {
		const plan = planWith({
			renditions: [
				{
					key: "v",
					codec: "H264",
					ingestKey: "video",
					height: 360,
					bitrate: 800000,
				},
				{
					key: "v2",
					codec: "H264",
					ingestKey: "video",
					height: 720,
					bitrate: 2400000,
				},
			],
			muxings: [
				// LATER rendition's container first — see the docblock.
				ts({
					key: "same",
					streamKey: "v2",
					destination: { outputKey: "out", path: "x/720p{uuid}" },
				}),
				ts({ key: "same", streamKey: "v" }),
			],
		});
		// The plan IS refused — this arm does not weaken that rail.
		expect(codesFor(plan)).toContain("PLAN_DUPLICATE_KEY");

		const ops = compilePlan(plan);
		expect(ops.filter((o) => o.kind === "CREATE_MUXING_TS")).toHaveLength(2);
		// The property the compiler's own golden suite asserts per fixture,
		// asserted here for a plan no fixture has: every referenced step exists
		// by the time the op that names it runs.
		const seen = new Set<string>();
		for (const op of ops) {
			for (const target of Object.values(op.refs).flat()) {
				expect(seen.has(target), `${op.step} references ${target} early`).toBe(
					true,
				);
			}
			seen.add(op.step);
		}
	});
});

/**
 * FINDINGS FROM THE REVIEW OF f66c1f12 — the ones my own census missed.
 *
 * Each of these is a rail I reasoned about instead of mutating. That is the
 * repeat pattern the review named, and it is why they get arms rather than
 * paragraphs.
 */
describe("review findings", () => {
	/**
	 * C2 — a container that straddles encodings.
	 *
	 * The compiler emits a muxing on the LAST of its constituent renditions,
	 * inside the per-encoding loop, so `encodingId` follows that rendition
	 * while `streamId` still names the primary's stream. Both step refs
	 * RESOLVE, so the malformed request reaches Bitmovin after both encodings
	 * are created and billed — the mid-run class the emit-position fix removed,
	 * on the axis it did not cover. Impossible before multi-stream containers:
	 * one stream is always in its own encoding.
	 */
	it("refuses a container whose streams live in different encodings", () => {
		const plan = encodingPlanSchema.parse({
			planVersion: 1,
			name: "cross",
			bitmovin: {},
			encodings: [
				{ key: "encA", name: "Encoding A" },
				{ key: "encB", name: "Encoding B" },
			],
			inputs: [
				{ key: "in", kind: "S3", credentialId: `${CRED}1`, bucket: "b" },
			],
			outputs: [
				{ key: "out", kind: "S3", credentialId: `${CRED}2`, bucket: "b" },
			],
			ingest: [
				{
					key: "video",
					inputKey: "in",
					inputPath: "a.mp4",
					selectionMode: "VIDEO_RELATIVE",
					encodingKey: "encA",
				},
				{
					key: "audio",
					inputKey: "in",
					inputPath: "a.mp4",
					selectionMode: "AUDIO_RELATIVE",
					encodingKey: "encB",
				},
			],
			renditions: [
				{
					key: "v",
					codec: "H264",
					ingestKey: "video",
					height: 360,
					bitrate: 800000,
					encodingKey: "encA",
				},
				{
					key: "a",
					codec: "AAC",
					ingestKey: "audio",
					bitrate: 128000,
					rate: 48000,
					encodingKey: "encB",
				},
			],
			muxings: [ts({ additionalStreamKeys: ["a"] })],
			manifests: [],
			generation: { timing: "POST_ENCODING" },
		});
		const issue = validatePlan(plan).find(
			(i) => i.code === "PLAN_MUXING_CROSS_ENCODING",
		);
		expect(issue?.level).toBe("error");
		expect(issue?.message).toContain("encA");
		expect(issue?.message).toContain("encB");
	});

	it("allows a container whose streams share one encoding", () => {
		// The counterfactual: a rail that fired on every multi-encoding plan
		// would pass the arm above while refusing the shape it exists to allow.
		expect(
			codesFor(planWith({ muxings: [ts({ additionalStreamKeys: ["a"] })] })),
		).not.toContain("PLAN_MUXING_CROSS_ENCODING");
	});

	/**
	 * C1's rail half. The builder no longer produces this, but the rail does
	 * not depend on the builder being right — an import, an API token or a
	 * hand-edited plan reaches the same submit boundary.
	 */
	it("a dropped AUDIO track is an error, because the delivery looks healthy and is silent", () => {
		const issue = validatePlan(
			planWith({ muxings: [ts()] }), // no container for "a"
		).find((i) => i.code === "PLAN_UNMUXED_RENDITION");
		expect(issue?.level).toBe("error");
		expect(issue?.message).toContain("play silent");
	});

	it("a dropped VIDEO rendition stays a warning — a missing rung is visible", () => {
		const issue = validatePlan(
			planWith({
				renditions: [
					{
						key: "v",
						codec: "H264",
						ingestKey: "video",
						height: 360,
						bitrate: 800000,
					},
					{
						key: "v2",
						codec: "H264",
						ingestKey: "video",
						height: 720,
						bitrate: 2400000,
					},
					{
						key: "a",
						codec: "AAC",
						ingestKey: "audio",
						bitrate: 128000,
						rate: 48000,
					},
				],
				muxings: [ts({ additionalStreamKeys: ["a"] })], // v2 unpackaged
			}),
		).find((i) => i.code === "PLAN_UNMUXED_RENDITION");
		expect(issue?.level).toBe("warning");
	});

	/**
	 * I3 — the variant-groups rail was plan-wide and refused a legal plan: a
	 * manifest pinned to fMP4 was blocked by an unrelated TS leg it never uses.
	 * Multi-leg is a designed shape; `videoMuxingKind` exists for it.
	 */
	it("does not refuse an fMP4 manifest because some OTHER leg is muxed", () => {
		const codes = codesFor(
			planWith({
				muxings: [
					{
						key: "vfmp4",
						kind: "FMP4",
						streamKey: "v",
						segmentLength: 6,
						segmentNaming: "segment_%number%.m4s",
						initSegmentName: "init.mp4",
						destination: { outputKey: "out", path: "x/fmp4" },
					},
					{
						key: "amux",
						kind: "FMP4",
						streamKey: "a",
						segmentLength: 6,
						segmentNaming: "segment_%number%.m4s",
						initSegmentName: "init.mp4",
						destination: { outputKey: "out", path: "x/audio" },
					},
					ts({ key: "vts", additionalStreamKeys: ["a"] }),
				],
				manifests: [
					{
						key: "hls",
						kind: "HLS",
						manifestName: "stream.m3u8",
						destination: { outputKey: "out", path: "" },
						audioGroupId: "audio",
						videoMuxingKind: "FMP4",
						variantsPerAudioGroup: true,
					},
				],
			}),
		);
		expect(codes).not.toContain("PLAN_HLS_MUXED_VARIANT_GROUPS");
	});

	/**
	 * …and the same rail's other half: `hasMuxedInAudio` claimed in its
	 * docstring to ask about a VIDEO primary and did not check it, so a
	 * container holding two audio tracks was treated as a self-contained
	 * variant.
	 */
	it("an audio-pair container is not a self-contained video variant", () => {
		const plan = planWith({
			renditions: [
				{
					key: "v",
					codec: "H264",
					ingestKey: "video",
					height: 360,
					bitrate: 800000,
				},
				{
					key: "a",
					codec: "AAC",
					ingestKey: "audio",
					bitrate: 128000,
					rate: 48000,
				},
				{
					key: "a2",
					codec: "AAC",
					ingestKey: "audio",
					bitrate: 64000,
					rate: 48000,
				},
			],
			muxings: [
				ts({ key: "vts" }),
				ts({
					key: "apair",
					streamKey: "a",
					additionalStreamKeys: ["a2"],
					destination: { outputKey: "out", path: "x/audio" },
				}),
			],
			manifests: [
				{
					key: "hls",
					kind: "HLS",
					manifestName: "stream.m3u8",
					destination: { outputKey: "out", path: "" },
					audioGroupId: "audio",
					variantsPerAudioGroup: true,
				},
			],
		});
		expect(codesFor(plan)).not.toContain("PLAN_HLS_MUXED_VARIANT_GROUPS");
	});
});

/**
 * ONE PLAN, TWO MANIFESTS, ONE MUXED LEG — review of 85250672, finding (b).
 *
 * The per-title C33 scan asked whether the PLAN contains a muxed per-title
 * container anywhere; the op it decorates expands only containers of ONE kind.
 * A per-title ladder delivering muxed HLS/TS beside demuxed CMAF — the ordinary
 * multi-leg shape `videoMuxingKind` exists to serve — therefore had its CMAF
 * variants omit `audio` while that same manifest emitted a perfectly good
 * EXT-X-MEDIA group. Every CMAF variant plays video-only, with the audio
 * sitting unreferenced beside it, and nothing sees it until after the encode.
 *
 * Same root as I3 and the same fix: scope to what the manifest selects. I fixed
 * I3's site and left this one, three hundred lines away — the "fixed one
 * instance of a class" habit that produced C1 as well.
 */
describe("the per-title group decision is per MANIFEST, not per plan", () => {
	const perTitleTwoLegs = () =>
		encodingPlanSchema.parse({
			planVersion: 1,
			name: "two-legs",
			bitmovin: {},
			inputs: [
				{ key: "in", kind: "S3", credentialId: `${CRED}1`, bucket: "b" },
			],
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
			renditions: [
				{
					key: "vpt",
					codec: "H264",
					ingestKey: "video",
					height: 720,
					bitrate: 2400000,
					mode: "PER_TITLE_TEMPLATE",
				},
				{
					key: "a",
					codec: "AAC",
					ingestKey: "audio",
					bitrate: 128000,
					rate: 48000,
				},
			],
			muxings: [
				// The muxed leg — HLS/TS.
				ts({ key: "vpt-ts", streamKey: "vpt", additionalStreamKeys: ["a"] }),
				// The demuxed leg — CMAF, and its audio group.
				{
					key: "vpt-fmp4",
					kind: "FMP4",
					streamKey: "vpt",
					segmentLength: 6,
					segmentNaming: "segment_%number%.m4s",
					initSegmentName: "init.mp4",
					destination: { outputKey: "out", path: "x/cmaf/{uuid}" },
				},
				{
					key: "a-fmp4",
					kind: "FMP4",
					streamKey: "a",
					segmentLength: 6,
					segmentNaming: "segment_%number%.m4s",
					initSegmentName: "init.mp4",
					destination: { outputKey: "out", path: "x/audio" },
				},
			],
			manifests: [
				{
					key: "hls-ts",
					kind: "HLS",
					manifestName: "ts.m3u8",
					destination: { outputKey: "out", path: "" },
					audioGroupId: "audio",
					videoMuxingKind: "TS",
				},
				{
					key: "hls-cmaf",
					kind: "HLS",
					manifestName: "cmaf.m3u8",
					destination: { outputKey: "out", path: "" },
					audioGroupId: "audio",
					videoMuxingKind: "FMP4",
					audioMuxingKind: "FMP4",
				},
			],
			generation: { timing: "POST_ENCODING" },
		});

	const expansionFor = (manifestKey: string) =>
		compilePlan(perTitleTwoLegs()).find(
			(o) =>
				o.kind === "CREATE_HLS_PER_TITLE_VARIANTS" &&
				o.step === `hls-pertitle:${manifestKey}`,
		);

	it("omits the group on the manifest whose leg IS muxed", () => {
		expect(expansionFor("hls-ts")?.payload).not.toHaveProperty("audio");
	});

	it("keeps it on the manifest whose leg is NOT — its group really exists", () => {
		// The failing half before the fix. This manifest expands `vpt-fmp4`,
		// which carries no muxed audio, and emits its own EXT-X-MEDIA entry —
		// so a variant with no AUDIO= attribute leaves that group unreferenced
		// and every CMAF rung plays silent.
		expect(expansionFor("hls-cmaf")?.payload.audio).toBe("audio");
		const media = compilePlan(perTitleTwoLegs()).filter(
			(o) => o.kind === "CREATE_HLS_AUDIO_MEDIA",
		);
		expect(media.length).toBeGreaterThan(0);
	});
});

/**
 * I4 — the field that becomes load-bearing BECAUSE of this feature.
 *
 * `Muxing.streamConditionsMode` is documented as mattering only "for Muxings
 * with more than one Stream". Before this change no muxing had two, so it never
 * mattered and its absence cost nothing. Now a conditional track muxed into a
 * video container hands an UNMEASURED vendor default the choice between
 * dropping that stream and dropping the whole container — between a silent rung
 * and a missing one.
 *
 * Review's framing, which I took: the missing field can wait, the missing
 * SENTENCE cannot. Warning, because the plan may be exactly what was intended.
 */
describe("a conditional stream in a multiplexed container is named, not blocked", () => {
	const conditionalAudio = () =>
		planWith({
			renditions: [
				{
					key: "v",
					codec: "H264",
					ingestKey: "video",
					height: 360,
					bitrate: 800000,
				},
				{
					key: "a",
					codec: "AAC",
					ingestKey: "audio",
					bitrate: 128000,
					rate: 48000,
					conditions: {
						attribute: "AUDIOSTREAMCOUNT",
						operator: "GREATER_THAN",
						value: "0",
					},
				},
			],
			muxings: [ts({ additionalStreamKeys: ["a"] })],
		});

	it("warns, and says which rendition and why", () => {
		const issue = validatePlan(conditionalAudio()).find(
			(i) => i.code === "PLAN_MUXING_CONDITIONAL_STREAM",
		);
		expect(issue?.level).toBe("warning");
		expect(issue?.message).toContain("streamConditionsMode");
		expect(issue?.message).toContain("unmeasured");
	});

	it("stays quiet on a SINGLE-stream container carrying the same condition", () => {
		// The counterfactual, and the reason the rail is scoped this way: a
		// conditional stream in its own container has always been ordinary —
		// `streamConditionsMode` does not apply to it, and four fixtures in the
		// corpus use conditions exactly like that.
		const plan = planWith({
			renditions: [
				{
					key: "v",
					codec: "H264",
					ingestKey: "video",
					height: 360,
					bitrate: 800000,
				},
				{
					key: "a",
					codec: "AAC",
					ingestKey: "audio",
					bitrate: 128000,
					rate: 48000,
					conditions: {
						attribute: "AUDIOSTREAMCOUNT",
						operator: "GREATER_THAN",
						value: "0",
					},
				},
			],
			muxings: [
				ts(),
				ts({
					key: "amux",
					streamKey: "a",
					destination: { outputKey: "out", path: "x/audio" },
				}),
			],
		});
		expect(codesFor(plan)).not.toContain("PLAN_MUXING_CONDITIONAL_STREAM");
	});
});

/**
 * THE RAIL FOR AXIS 3 — the half no builder can cover.
 *
 * Within ONE manifest, every video variant must either carry its own audio or
 * have a group to point at. A partly muxed ladder satisfies neither, and it is
 * invisible to every other rail: the audio IS packaged, so the unmuxed rail is
 * quiet, and C33's omission is CORRECT on the variants that carry it.
 *
 * The builder is fixed, but plans also arrive by import, by API token and by
 * hand. This expresses the rule itself rather than approximating it — per
 * MANIFEST, over the muxings that manifest selects, which is the population
 * that decides the outcome. Scoping narrower than that produced this defect,
 * I3, and the per-title one: three sites, one mistake.
 */
describe("a partly muxed ladder is refused", () => {
	const hls = (over: Record<string, unknown> = {}) => ({
		key: "hls",
		kind: "HLS",
		manifestName: "stream.m3u8",
		destination: { outputKey: "out", path: "" },
		audioGroupId: "audio",
		...over,
	});

	const twoVideo = [
		{
			key: "v",
			codec: "H264",
			ingestKey: "video",
			height: 360,
			bitrate: 800000,
		},
		{
			key: "v2",
			codec: "H264",
			ingestKey: "video",
			height: 720,
			bitrate: 2400000,
		},
		{
			key: "a",
			codec: "AAC",
			ingestKey: "audio",
			bitrate: 128000,
			rate: 48000,
		},
	];

	it("fires when one variant carries its audio and the other has no group", () => {
		const issue = validatePlan(
			planWith({
				renditions: twoVideo,
				muxings: [
					ts({ key: "vts", additionalStreamKeys: ["a"] }),
					ts({
						key: "v2ts",
						streamKey: "v2",
						destination: { outputKey: "out", path: "x/720p{uuid}" },
					}),
				],
				manifests: [hls()],
			}),
		).find((i) => i.code === "PLAN_HLS_PARTIAL_MUXED_LADDER");
		expect(issue?.level).toBe("error");
		expect(issue?.message).toContain("v2ts");
		expect(issue?.message).toContain("play silent");
	});

	it("stays quiet when the stranded variant HAS a group to point at", () => {
		// The counterfactual, and the shape the fixed builder now emits: the
		// audio rides one leg and keeps its own container for the other.
		expect(
			codesFor(
				planWith({
					renditions: twoVideo,
					muxings: [
						ts({ key: "vts", additionalStreamKeys: ["a"] }),
						ts({
							key: "v2ts",
							streamKey: "v2",
							destination: { outputKey: "out", path: "x/720p{uuid}" },
						}),
						ts({
							key: "amux",
							streamKey: "a",
							destination: { outputKey: "out", path: "x/audio" },
						}),
					],
					manifests: [hls()],
				}),
			),
		).not.toContain("PLAN_HLS_PARTIAL_MUXED_LADDER");
	});

	it("stays quiet when EVERY variant carries its own audio", () => {
		expect(
			codesFor(
				planWith({
					renditions: twoVideo,
					muxings: [
						ts({ key: "vts", additionalStreamKeys: ["a"] }),
						ts({
							key: "v2ts",
							streamKey: "v2",
							additionalStreamKeys: ["a"],
							destination: { outputKey: "out", path: "x/720p{uuid}" },
						}),
					],
					manifests: [hls()],
				}),
			),
		).not.toContain("PLAN_HLS_PARTIAL_MUXED_LADDER");
	});

	it("is scoped per manifest — a leg this one never selects cannot trip it", () => {
		// The same mistake this rail exists to fix, applied to the rail itself.
		expect(
			codesFor(
				planWith({
					renditions: twoVideo,
					muxings: [
						ts({ key: "vts", additionalStreamKeys: ["a"] }),
						{
							key: "vfmp4",
							kind: "FMP4",
							streamKey: "v",
							segmentLength: 6,
							segmentNaming: "segment_%number%.m4s",
							initSegmentName: "init.mp4",
							destination: { outputKey: "out", path: "x/cmaf" },
						},
						{
							key: "v2fmp4",
							kind: "FMP4",
							streamKey: "v2",
							segmentLength: 6,
							segmentNaming: "segment_%number%.m4s",
							initSegmentName: "init.mp4",
							destination: { outputKey: "out", path: "x/cmaf2" },
						},
					],
					// Pinned to fMP4: neither selected leg carries muxed audio, so
					// there is nothing partial about THIS manifest's ladder.
					manifests: [hls({ videoMuxingKind: "FMP4" })],
				}),
			),
		).not.toContain("PLAN_HLS_PARTIAL_MUXED_LADDER");
	});
});

/**
 * ONE ADDRESSABLE AUDIO TRACK PER CONTAINER — owner report, .
 *
 * MPEG-TS carries several audio PIDs happily; the container is not the
 * constraint. The MANIFEST is: a variant references the MUXING, and there is no
 * syntax for choosing a track inside it. A second track is encoded, stored,
 * delivered and unreachable.
 *
 * Review raised this as a suggestion — "no `*_MULTIPLE_AUDIO` rail to match the
 * `MULTIPLE_VIDEO` one" — and I recorded it without building it. The owner
 * then reached the state through the wizard, which is the difference between a
 * noted gap and a shipped one.
 */
describe("a container carries at most one addressable audio track", () => {
	const twoTracks = (kind: "TS" | "MP4") =>
		planWith({
			renditions: [
				{
					key: "v",
					codec: "H264",
					ingestKey: "video",
					height: 360,
					bitrate: 800000,
				},
				{
					key: "a",
					codec: "AAC",
					ingestKey: "audio",
					bitrate: 128000,
					rate: 48000,
				},
				{
					key: "a2",
					codec: "AAC",
					ingestKey: "audio",
					bitrate: 64000,
					rate: 48000,
				},
			],
			muxings: [
				kind === "TS"
					? ts({ additionalStreamKeys: ["a", "a2"] })
					: {
							key: "mux",
							kind: "MP4",
							streamKey: "v",
							additionalStreamKeys: ["a", "a2"],
							filename: "out.mp4",
							destination: { outputKey: "out", path: "x/" },
						},
			],
		});

	it("refuses it on TS — every TS delivery here is HLS", () => {
		const issue = validatePlan(twoTracks("TS")).find(
			(i) => i.code === "PLAN_MUXING_MULTIPLE_AUDIO",
		);
		expect(issue?.level).toBe("error");
		expect(issue?.message).toContain("only the first is reachable");
	});

	it("warns on MP4 — a progressive file can legitimately hold two", () => {
		// The asymmetry is the point: a player opening the FILE can choose
		// between its tracks; the manifest families we generate cannot. So the
		// plan may be exactly what was meant, and a block would be a guess.
		const issue = validatePlan(twoTracks("MP4")).find(
			(i) => i.code === "PLAN_MUXING_MULTIPLE_AUDIO",
		);
		expect(issue?.level).toBe("warning");
	});

	it("stays quiet on ONE audio track, which is the whole feature", () => {
		expect(
			codesFor(planWith({ muxings: [ts({ additionalStreamKeys: ["a"] })] })),
		).not.toContain("PLAN_MUXING_MULTIPLE_AUDIO");
	});
});
