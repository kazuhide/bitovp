import { expect, it } from "vitest";
import { compileExpectedArtefacts } from "../verify/expected";
import fixture from "./__fixtures__/pertitle-h264-mp4-smooth-drm-on-aws.plan.json";
import { compilePlan } from "./compiler";
import { encodingPlanSchema } from "./schema";
import { validatePlan } from "./validate";

function plan() {
	return encodingPlanSchema.parse({
		...fixture,
		manifests: fixture.manifests.map(({ drmKind: _drmKind, ...manifest }) => ({
			...manifest,
			generationMode: "DEFAULT",
		})),
	});
}

it("compiles an owned provider default Smooth root after the selected encoding finishes", () => {
	const source = plan();
	expect(
		validatePlan(source).filter((issue) => issue.level === "error"),
	).toEqual([]);
	const operations = compilePlan(source);
	const root = operations.findIndex(
		({ kind }) => kind === "CREATE_MANIFEST_SMOOTH",
	);
	const awaited = operations.findIndex(({ kind }) => kind === "AWAIT_ENCODING");
	expect(awaited).toBeGreaterThanOrEqual(0);
	expect(root).toBeGreaterThan(awaited);
	expect(operations[root]).toMatchObject({
		payload: {
			generationMode: "DEFAULT",
			serverManifestName: "stream.ism",
			clientManifestName: "stream.ismc",
		},
		refs: { encodingId: "encoding", outputId: "output:origin" },
	});
	expect(operations.map(({ kind }) => kind)).not.toContain(
		"CREATE_SMOOTH_PER_TITLE_ENTRIES",
	);
	expect(operations.map(({ kind }) => kind)).not.toContain(
		"CREATE_SMOOTH_CONTENT_PROTECTION",
	);
	expect(operations.map(({ kind }) => kind)).not.toContain(
		"CREATE_SMOOTH_REPRESENTATION_MP4",
	);
});

it("requires completed encoding and real Smooth MP4 tracks for provider defaults", () => {
	const source = plan();
	source.generation.timing = "JUST_IN_TIME";
	for (const muxing of source.muxings)
		if (muxing.kind === "MP4") muxing.manifestType = "DASH_ON_DEMAND";
	const messages = validatePlan(source).map(({ message }) => message);
	expect(messages).toEqual(
		expect.arrayContaining([
			expect.stringContaining(
				"Default Smooth manifests must be generated after encoding",
			),
			expect.stringContaining("Default Smooth requires fragmented MP4 muxings"),
		]),
	);
});

it("verifies only tracks packaged for default Smooth, including muxed-in audio", () => {
	const source = plan();
	const video = source.renditions.find((item) => item.codec === "H264");
	const audio = source.renditions.find((item) => item.codec === "AAC");
	const manifest = source.manifests[0];
	if (!video || !audio || !manifest) throw new Error("Missing Smooth fixture");
	const downloadKey = "download-video";
	source.renditions = [
		{ ...video, key: downloadKey, mode: "STANDARD", bitrate: 300_000 },
		{ ...video, mode: "STANDARD", bitrate: 400_000 },
		audio,
	];
	delete source.perTitle;
	source.drm = [];
	source.muxings = [
		{
			kind: "MP4",
			key: "download",
			streamKey: downloadKey,
			filename: "download.mp4",
			destination: { outputKey: "origin", path: "download/" },
		},
		{
			kind: "MP4",
			key: "smooth-media",
			streamKey: video.key,
			additionalStreamKeys: [audio.key],
			filename: "media.ismv",
			fragmentDuration: 6000,
			manifestType: "SMOOTH",
			destination: {
				outputKey: "origin",
				path: `${manifest.destination.path}media/`,
			},
		},
	];
	expect(validatePlan(source).filter(({ level }) => level === "error")).toEqual(
		[],
	);
	const expected = compileExpectedArtefacts(source);
	expect(expected.muxings.map(({ muxingKey }) => muxingKey)).toContain(
		"download",
	);
	expect(expected.manifests).toEqual([
		expect.objectContaining({
			kind: "SMOOTH",
			videoEntries: 1,
			audioEntries: 1,
			perTitle: false,
		}),
	]);
});

it.each([
	["DEFAULT", "fixed"],
	["DEFAULT", "selected"],
	["DEFAULT", "excluded"],
	["MANUAL", "fixed"],
	["MANUAL", "selected"],
	["MANUAL", "excluded"],
] as const)("verifies %s Smooth using only its %s ladder and MP4 audio", (generationMode, ladder) => {
	const source = plan();
	const video = source.renditions.find((item) => item.codec === "H264");
	const audio = source.renditions.find((item) => item.codec === "AAC");
	const manifest = source.manifests[0];
	if (!video || !audio || manifest?.kind !== "SMOOTH")
		throw new Error("Missing Smooth fixture");

	const selected = ladder === "selected";
	const alternateAudio = { ...audio, key: "website-audio", bitrate: 96000 };
	source.renditions = [
		selected ? video : { ...video, mode: "STANDARD", bitrate: 400000 },
		audio,
		alternateAudio,
		...(ladder === "excluded" ? [{ ...video, key: "website-video" }] : []),
	];
	if (ladder === "fixed") delete source.perTitle;
	source.drm = [];
	const destination = {
		outputKey: "origin",
		path: `${manifest.destination.path}media/`,
	};
	source.muxings = [
		{
			kind: "MP4",
			key: "picture",
			streamKey: video.key,
			filename: "picture.ismv",
			fragmentDuration: 6000,
			manifestType: "SMOOTH",
			destination: {
				...destination,
				path: selected ? `${destination.path}{uuid}/` : destination.path,
			},
		},
		{
			kind: "MP4",
			key: "sound",
			streamKey: audio.key,
			filename: "sound.isma",
			fragmentDuration: 6000,
			manifestType: "SMOOTH",
			destination,
		},
		{
			kind: "FMP4",
			key: "separate-audio",
			streamKey: alternateAudio.key,
			segmentLength: 4,
			initSegmentName: "init.mp4",
			segmentNaming: "segment_%number%.m4s",
			destination: { outputKey: "origin", path: "website/audio/" },
		},
	];
	if (ladder === "excluded")
		source.muxings.push({
			kind: "FMP4",
			key: "separate-video",
			streamKey: "website-video",
			segmentLength: 4,
			initSegmentName: "init.mp4",
			segmentNaming: "segment_%number%.m4s",
			destination: { outputKey: "origin", path: "website/video/{uuid}/" },
		});
	source.manifests = [{ ...manifest, generationMode }];
	expect(validatePlan(source).filter(({ level }) => level === "error")).toEqual(
		[],
	);
	const operations = compilePlan(source);
	const tracks = operations
		.filter(({ kind }) => kind === "CREATE_SMOOTH_REPRESENTATION_MP4")
		.map(({ payload, refs }) => [payload.trackName, refs.muxingId]);
	expect(tracks).toEqual(
		generationMode === "DEFAULT"
			? []
			: [
					...(selected ? [] : [["video", "muxing:picture"]]),
					["audio", "muxing:sound"],
				],
	);
	expect(
		operations.filter(({ kind }) => kind === "CREATE_SMOOTH_PER_TITLE_ENTRIES"),
	).toHaveLength(generationMode === "MANUAL" && selected ? 1 : 0);
	expect(compileExpectedArtefacts(source).manifests).toEqual([
		expect.objectContaining({
			kind: "SMOOTH",
			videoEntries: 1,
			audioEntries: 1,
			perTitle: selected,
		}),
	]);
});
