import { expect, it } from "vitest";
import { compileExpectedLiveArtefacts } from "../verify/expected-live";
import base from "./__fixtures__/live-srt-listener.plan.json";
import { compileLiveChannel } from "./compiler";
import { resolveLiveEncodingOption } from "./encoding-option";
import { rebaseLivePlanForRun } from "./run-rebase";
import { liveChannelPlanSchema } from "./schema";
import { validateLiveChannel } from "./validate";

const track = {
	key: "jpn",
	position: 2,
	inputPath: "/",
	language: "ja",
	label: "日本語",
	packaging: "CHUNKED_TEXT",
	segmentLength: 6,
	destination: {
		outputKey: "origin",
		path: "output/live-srt-listener/subtitles/jpn",
	},
};
function plan(tracks = [track]) {
	return liveChannelPlanSchema.parse({ ...base, dvbSubtitles: tracks });
}
it("routes the live input through the selected DVB service and a WebVTT codec on both manifests", () => {
	const p = plan();
	expect(validateLiveChannel(p).filter((x) => x.level === "error")).toEqual([]);
	const ops = compileLiveChannel(p);
	expect(
		ops.find((o) => o.kind === "CREATE_DVB_SUBTITLE_INPUT_STREAM"),
	).toMatchObject({
		payload: {
			inputPath: "/",
			position: 2,
			selectionMode: "POSITION_ABSOLUTE",
		},
		refs: { encodingId: "encoding", inputId: "live-input:main" },
	});
	expect(ops.find((o) => o.step === "dvb:jpn:stream")).toMatchObject({
		kind: "CREATE_STREAM",
		refs: { codecConfigId: "dvb:jpn:codec", inputStreamId: "dvb:jpn:input" },
	});
	expect(ops.find((o) => o.step === "dvb:jpn:muxing")).toMatchObject({
		kind: "CREATE_MUXING_CHUNKED_TEXT",
		refs: { outputId: "output:origin", streamId: "dvb:jpn:stream" },
	});
	expect(
		ops.find((o) => o.kind === "CREATE_HLS_SUBTITLES_MEDIA"),
	).toMatchObject({
		payload: { language: "ja", name: "日本語", groupId: "subtitles" },
		refs: { streamId: "dvb:jpn:stream", muxingId: "dvb:jpn:muxing" },
	});
	expect(
		ops
			.filter((o) => o.kind === "CREATE_HLS_STREAM_INFO")
			.every((o) => o.payload.subtitles === "subtitles"),
	).toBe(true);
	expect(
		ops.find((o) => o.kind === "CREATE_DASH_REPRESENTATION_CHUNKED_TEXT"),
	).toMatchObject({ refs: { muxingId: "dvb:jpn:muxing" } });
	const expected = compileExpectedLiveArtefacts(p);
	expect(
		expected.manifests.find((m) => m.kind === "HLS")?.mediaPlaylists,
	).toContain("subtitles_jpn.m3u8");
	const rerun = rebaseLivePlanForRun(p, {
		seq: 2,
		runId: "12345678-1234-1234-1234-123456789abc",
	});
	expect(rerun.plan.dvbSubtitles?.[0]?.destination.path).toContain(
		"runs/2-12345678",
	);
});
it("uses a separate fMP4 subtitle representation while keeping HLS segmented WebVTT language tracks", () => {
	const p = plan([
		track,
		{
			...track,
			key: "en",
			position: 3,
			language: "en",
			label: "English",
			packaging: "FMP4",
			destination: {
				outputKey: "origin",
				path: "output/live-srt-listener/subtitles/en",
			},
		},
	]);
	expect(validateLiveChannel(p).filter((x) => x.level === "error")).toEqual([]);
	const ops = compileLiveChannel(p);
	expect(ops.find((o) => o.step === "dvb:en:muxing")).toMatchObject({
		kind: "CREATE_MUXING_FMP4",
		payload: { initSegmentName: "init.mp4" },
	});
	expect(
		ops.find(
			(o) =>
				o.kind === "CREATE_DASH_REPRESENTATION_FMP4" &&
				o.refs.muxingId === "dvb:en:muxing",
		),
	).toBeDefined();
	expect(
		ops.filter((o) => o.kind === "CREATE_HLS_SUBTITLES_MEDIA"),
	).toHaveLength(1);
});
it("refuses nonabsolute selectors, mismatched source positions, output collisions and unreachable packaging", () => {
	expect(
		liveChannelPlanSchema.safeParse({
			...base,
			dvbSubtitles: [{ ...track, selectionMode: "AUTO" }],
		}).success,
	).toBe(false);
	expect(
		liveChannelPlanSchema.safeParse({
			...base,
			dvbSubtitles: [{ ...track, position: -1 }],
		}).success,
	).toBe(false);
	const errors = (p: ReturnType<typeof plan>) =>
		validateLiveChannel(p)
			.filter((i) => i.level === "error")
			.map((i) => i.path);
	expect(errors(plan([{ ...track, position: 0 }]))).toContain(
		"dvbSubtitles[0].position",
	);
	expect(errors(plan([track, { ...track, key: "en", position: 3 }]))).toContain(
		"dvbSubtitles[1].destination",
	);
	const p = plan([{ ...track, packaging: "FMP4" }]);
	p.liveManifests = p.liveManifests.filter((m) => m.kind === "HLS");
	expect(errors(p)).toContain("dvbSubtitles[0].packaging");
});

it("detects cross-folder subtitle template collisions with both manifests and nested video segments", () => {
	const p = plan();
	const hls = p.liveManifests.find((m) => m.kind === "HLS");
	if (!hls) throw Error("missing HLS");
	hls.destination.path = track.destination.path;
	hls.manifestName = "segment_14.vtt";
	expect(validateLiveChannel(p)).toContainEqual(
		expect.objectContaining({
			code: "LIVE_OUTPUT_NAMESPACE_COLLISION",
			level: "error",
		}),
	);
	hls.manifestName = "master.m3u8";
	const mux = p.muxings[0];
	if (mux?.kind !== "FMP4" || !mux.destination)
		throw Error("missing AV fixture");
	mux.destination.path = track.destination.path
		.split("/")
		.slice(0, -1)
		.join("/");
	mux.segmentNaming = "jpn/segment_%number%.vtt";
	expect(validateLiveChannel(p)).toContainEqual(
		expect.objectContaining({
			code: "LIVE_DRM_OUTPUT_COLLISION",
			level: "error",
		}),
	);
});

it("requires distinct names within the HLS subtitle group, including existing external subtitle tracks", () => {
	const p = plan(),
		hls = p.liveManifests.find((m) => m.kind === "HLS");
	if (!hls) throw Error("missing HLS");
	hls.detailed = {
		additionalMedia: [
			{
				type: "VTT",
				groupId: "accessibility",
				name: track.label,
				language: "ja",
				uri: "external.m3u8",
				vttUrl: "https://example.invalid/subs.vtt",
			},
		],
	};
	expect(validateLiveChannel(p)).toContainEqual(
		expect.objectContaining({ path: "dvbSubtitles[0].label", level: "error" }),
	);
});

it.each([
	"AUTO",
	"HD",
	"CUSTOM",
] as const)("retains the explicit %s encoding option contract with DVB OCR", (choice) => {
	const p = plan();
	for (const r of p.renditions)
		if (r.codec === "H264") {
			r.width = r.height === 720 ? 1280 : 640;
			r.rate = 30;
		}
	p.start.encodingOption = choice;
	expect(resolveLiveEncodingOption(p)).toEqual(
		resolveLiveEncodingOption({ ...p, dvbSubtitles: undefined }),
	);
	expect(
		compileLiveChannel(p).find((op) => op.kind === "START_LIVE_ENCODING")
			?.payload.encodingOption,
	).toBe(choice === "CUSTOM" ? "CUSTOM" : "HD");
});
