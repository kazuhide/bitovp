import { readFileSync } from "node:fs";
import { join } from "node:path";
import { compileExpectedArtefacts, encodingPlanSchema } from "@bitovp/core";
import { describe, expect, it, vi } from "vitest";
import { parseDashText } from "./adapters";
import { type EngineDeps, type MediaProbe, verifyArtefacts } from "./engine";

function progressivePlan() {
	const plan = encodingPlanSchema.parse(
		JSON.parse(
			readFileSync(
				join(
					import.meta.dirname,
					"../../../../packages/core/src/plan/__fixtures__/vp9-webm-fixed-dash.plan.json",
				),
				"utf8",
			),
		),
	);
	const muxing = plan.muxings.find((row) => row.kind === "WEBM");
	if (muxing?.kind !== "WEBM") throw new Error("missing WebM fixture");
	muxing.progressive = true;
	muxing.filename = "video.webm";
	muxing.destination = { outputKey: "origin", path: "out/video/" };
	plan.muxings = [muxing];
	plan.renditions = plan.renditions.filter(
		(row) => row.key === muxing.streamKey,
	);
	plan.manifests = [];
	plan.qc = undefined;
	return compileExpectedArtefacts(plan);
}

function depsFor(
	objects: string[],
	probe: MediaProbe,
	mpd?: string,
	sizes: Record<string, number> = {},
): EngineDeps {
	return {
		listAll: async (_output, prefix) =>
			objects
				.filter((key) => key.startsWith(prefix))
				.map((key) => ({ key, size: sizes[key] ?? 1024 })),
		fetchObject: async (_output, key) => key,
		fetchConcatenated: vi.fn(async (_output, keys) => keys.join("+")),
		probe: async () => probe,
		scanBoxes: async () => ({ psshSystemIds: [] }),
		readText: async () => {
			if (mpd) return mpd;
			throw new Error("no text fixture");
		},
		parseHls: async () => {
			throw new Error("no HLS fixture");
		},
		parseDash: parseDashText,
		reference: { durationSec: 12 },
	};
}

describe("progressive WebM verification", () => {
	it("rejects a same-suffix sibling filename and an empty complete file", async () => {
		const expected = progressivePlan();
		const sibling = await verifyArtefacts(
			expected,
			depsFor(["out/video/notvideo.webm"], {}),
		);
		expect(
			sibling.checks.find((check) => check.id.endsWith(":file"))?.verdict,
		).toBe("FAIL");
		const empty = await verifyArtefacts(
			expected,
			depsFor(
				["out/video/video.webm"],
				{ videoCodec: "vp9", height: 1080, durationSec: 12 },
				undefined,
				{ "out/video/video.webm": 0 },
			),
		);
		expect(
			empty.checks.find((check) => check.id.endsWith(":file-bytes"))?.verdict,
		).toBe("FAIL");
	});
	it("probes the complete file and does not demand initialization or segment objects", async () => {
		const expected = progressivePlan();
		const deps = depsFor(["out/video/video.webm"], {
			height: 1080,
			videoCodec: "vp9",
			bitrateBps: 3_000_000,
			durationSec: 12,
		});
		const report = await verifyArtefacts(expected, deps);
		expect(report.checks.filter((check) => check.verdict === "FAIL")).toEqual(
			[],
		);
		expect(
			report.checks.some(
				(check) => check.id.endsWith(":init") || check.id.endsWith(":segments"),
			),
		).toBe(false);
		expect(deps.fetchConcatenated).toHaveBeenCalledWith("origin", [
			"out/video/video.webm",
		]);
	});
	it("fails a missing progressive file and a wrong video codec", async () => {
		const expected = progressivePlan();
		const missing = await verifyArtefacts(expected, depsFor([], {}));
		expect(missing.failed).toBeGreaterThan(0);
		const wrong = await verifyArtefacts(
			expected,
			depsFor(["out/video/video.webm"], {
				height: 1080,
				videoCodec: "h264",
				bitrateBps: 3_000_000,
				durationSec: 12,
			}),
		);
		expect(
			wrong.checks.find((check) => check.id.endsWith(":codec"))?.verdict,
		).toBe("FAIL");
	});
});

function manifestPlan() {
	const credentialId = "11111111-1111-4111-8111-111111111111";
	return encodingPlanSchema.parse({
		planVersion: 1,
		name: "Manifest verification",
		bitmovin: { cloudRegion: "AUTO" },
		generation: { timing: "POST_ENCODING" },
		inputs: [
			{
				key: "source",
				kind: "S3",
				name: "Source",
				bucket: "sample-input",
				credentialId,
			},
		],
		outputs: [
			{
				key: "origin",
				kind: "S3",
				name: "Output",
				bucket: "sample-output",
				credentialId,
			},
		],
		ingest: [
			{
				key: "video",
				inputKey: "source",
				inputPath: "source.mp4",
				selectionMode: "VIDEO_RELATIVE",
				position: 0,
			},
			{
				key: "audio",
				inputKey: "source",
				inputPath: "source.mp4",
				selectionMode: "AUDIO_RELATIVE",
				position: 0,
			},
		],
		renditions: [
			{
				key: "video",
				codec: "H264",
				ingestKey: "video",
				height: 720,
				bitrate: 2_000_000,
			},
			{
				key: "audio",
				codec: "AAC",
				ingestKey: "audio",
				bitrate: 128_000,
				rate: 48_000,
			},
		],
		muxings: [
			{
				key: "video",
				kind: "MP4",
				streamKey: "video",
				filename: "video.mp4",
				fragmentDuration: 4,
				manifestType: "DASH_ON_DEMAND",
				destination: { outputKey: "origin", path: "out/" },
			},
			{
				key: "audio",
				kind: "MP4",
				streamKey: "audio",
				filename: "audio.mp4",
				fragmentDuration: 4,
				manifestType: "DASH_ON_DEMAND",
				destination: { outputKey: "origin", path: "out/" },
			},
		],
		manifests: [
			{
				key: "dash",
				kind: "DASH",
				profile: "ON_DEMAND",
				destination: { outputKey: "origin", path: "out/" },
			},
		],
	});
}
const VIDEO =
	'<AdaptationSet contentType="video" mimeType="video/mp4" codecs="avc1.64001f"><Representation id="video" width="1280" height="720" bandwidth="2000000"><BaseURL>video.mp4</BaseURL><SegmentBase indexRange="100-200"><Initialization range="0-99"/></SegmentBase></Representation></AdaptationSet>';
const AUDIO =
	'<AdaptationSet contentType="audio" mimeType="audio/mp4" codecs="mp4a.40.2"><Representation id="audio" bandwidth="128000" audioSamplingRate="48000"><BaseURL>audio.mp4</BaseURL><SegmentBase indexRange="100-200"><Initialization range="0-99"/></SegmentBase></Representation></AdaptationSet>';
const VTT =
	'<AdaptationSet contentType="text" mimeType="text/vtt" lang="ja"><Representation id="subtitle" bandwidth="256"><BaseURL>https://media.example.test/subs.vtt</BaseURL></Representation></AdaptationSet>';
const mpd = (...periods: string[]) =>
	`<MPD type="static" mediaPresentationDuration="PT12S">${periods.map((body, index) => `<Period id="p${index}" start="PT${index * 6}S" duration="PT6S">${body}</Period>`).join("")}</MPD>`;
const condition = (
	attribute: "video.codec" | "audio.codec" | "audio.language",
	value: string,
) => ({
	type: "CONDITION" as const,
	attribute,
	operator: "==" as const,
	value,
});
async function verifyManifest(
	plan: ReturnType<typeof manifestPlan>,
	text: string,
	objects = [
		"out/stream.mpd",
		"out/video.mp4",
		"out/video.webm",
		"out/audio.mp4",
		"out/sprites/sprite.jpg",
	],
) {
	const expected = compileExpectedArtefacts(plan);
	// This suite tests manifest selection; the complete-file tests cover media probing.
	expected.muxings = [];
	expected.sprites = [];
	return verifyArtefacts(expected, depsFor(objects, { durationSec: 12 }, text));
}

describe("configured DASH artifact verification", () => {
	it("does not let an optional language candidate consume a mandatory audio representation", async () => {
		const original = manifestPlan();
		const audio = original.renditions.find((row) => row.codec === "AAC");
		const muxing = original.muxings.find((row) => row.streamKey === "audio");
		if (!audio || !muxing) throw new Error("missing audio fixture");
		const plan = encodingPlanSchema.parse({
			...original,
			renditions: [
				{ ...audio, key: "optional", bitrate: 127_000 },
				{ ...audio, key: "mandatory", bitrate: 128_000 },
			],
			muxings: ["optional", "mandatory"].map((key) => ({
				...muxing,
				key,
				streamKey: key,
				filename: `${key}.mp4`,
			})),
			manifests: [
				{
					...original.manifests[0],
					generationMode: "DEFAULT",
					defaultPeriods: [
						{
							encodingKeys: ["default"],
							adaptationSets: [
								{
									type: "OR",
									conditions: [
										condition("audio.language", "ja"),
										{
											type: "CONDITION",
											attribute: "audio.bitrate",
											operator: ">=",
											value: "128000",
										},
									],
								},
							],
						},
					],
				},
			],
		});
		const text = mpd(
			AUDIO.replace('bandwidth="128000"', 'bandwidth="127000"').replaceAll(
				"audio.mp4",
				"mandatory.mp4",
			),
		);
		const report = await verifyArtefacts(
			compileExpectedArtefacts(plan),
			depsFor(
				["out/stream.mpd", "out/optional.mp4", "out/mandatory.mp4"],
				{
					audioCodec: "aac",
					audioSampleRate: 48_000,
					bitrateBps: 128_000,
					durationSec: 12,
				},
				text,
			),
		);
		expect(report.checks.filter((row) => row.verdict === "FAIL")).toEqual([]);
		expect(
			report.checks.find(
				(row) =>
					row.id.includes(":rep:mandatory:") && row.id.endsWith(":present"),
			)?.verdict,
		).toBe("PASS");
		expect(
			report.checks.find(
				(row) =>
					row.id.includes(":rep:optional:") && row.id.endsWith(":present"),
			)?.verdict,
		).toBe("SKIP");
	});
	it("checks each repeated representation ID against its own period file", async () => {
		const original = manifestPlan();
		const video = original.renditions[0];
		const muxing = original.muxings[0];
		const input = original.ingest[0];
		if (!video || !muxing || !input) throw new Error("missing fixture");
		const plan = encodingPlanSchema.parse({
			...original,
			encodings: ["first", "second"].map((key) => ({ key, name: key })),
			ingest: ["first", "second"].map((key) => ({
				...input,
				key,
				encodingKey: key,
			})),
			renditions: ["first", "second"].map((key) => ({
				...video,
				key,
				ingestKey: key,
				encodingKey: key,
			})),
			muxings: ["first", "second"].map((key) => ({
				...muxing,
				key,
				streamKey: key,
				filename: `${key}.mp4`,
			})),
			manifests: [
				{
					...original.manifests[0],
					generationMode: "DEFAULT",
					defaultPeriods: ["first", "second"].map((key) => ({
						encodingKeys: [key],
					})),
				},
			],
		});
		const text = mpd(
			VIDEO.replaceAll("video.mp4", "first.mp4"),
			VIDEO.replaceAll("video.mp4", "second.mp4"),
		);
		const expected = compileExpectedArtefacts(plan);
		const probe = {
			videoCodec: "h264",
			height: 720,
			bitrateBps: 2_000_000,
			durationSec: 12,
		};
		const healthy = await verifyArtefacts(
			expected,
			depsFor(
				["out/stream.mpd", "out/first.mp4", "out/second.mp4"],
				probe,
				text,
			),
		);
		expect(healthy.checks.filter((row) => row.verdict === "FAIL")).toEqual([]);
		expect(new Set(healthy.checks.map((row) => row.id)).size).toBe(
			healthy.checks.length,
		);
		expect(
			healthy.checks.filter(
				(row) =>
					row.id.endsWith(":media-closure") && row.id.includes(":playlist:"),
			),
		).toHaveLength(2);
		const missing = await verifyArtefacts(
			expected,
			depsFor(["out/stream.mpd", "out/first.mp4"], probe, text),
		);
		expect(
			missing.checks.filter(
				(row) =>
					row.id.includes(":playlist:") &&
					row.id.endsWith(":media-closure") &&
					row.verdict === "FAIL",
			),
		).toHaveLength(1);
	});
	it("checks a declared progressive file outside the manifest folder without listing unplanned folders", async () => {
		const original = manifestPlan();
		const plan = encodingPlanSchema.parse({
			...original,
			renditions: [
				{
					key: "video",
					codec: "VP9",
					ingestKey: "video",
					height: 720,
					bitrate: 2_000_000,
				},
			],
			muxings: [
				{
					key: "video",
					kind: "WEBM",
					streamKey: "video",
					progressive: true,
					filename: "video.webm",
					destination: { outputKey: "origin", path: "out/video/" },
				},
			],
			manifests: [
				{
					key: "dash",
					kind: "DASH",
					profile: "ON_DEMAND",
					destination: { outputKey: "origin", path: "out/manifests/" },
					detailed: {
						additionalRepresentations: [
							{ type: "PROGRESSIVE_WEBM", muxingKey: "video" },
						],
					},
				},
			],
		});
		const text = mpd(
			VIDEO.replace("avc1.64001f", "vp09.00.40.08").replaceAll(
				"video.mp4",
				"../video/video.webm",
			),
		);
		const expected = compileExpectedArtefacts(plan);
		const probe = {
			videoCodec: "vp9",
			height: 720,
			bitrateBps: 2_000_000,
			durationSec: 12,
		};
		const deps = depsFor(
			["out/manifests/stream.mpd", "out/video/video.webm"],
			probe,
			text,
		);
		const listAll = vi.fn(deps.listAll);
		deps.listAll = listAll;
		const healthy = await verifyArtefacts(expected, deps);
		expect(healthy.checks.filter((row) => row.verdict === "FAIL")).toEqual([]);
		expect(
			healthy.checks.some(
				(row) => row.id.endsWith(":media-closure") && row.verdict === "PASS",
			),
		).toBe(true);
		const missing = await verifyArtefacts(
			expected,
			depsFor(["out/manifests/stream.mpd"], probe, text),
		);
		expect(
			missing.checks.some(
				(row) => row.id.endsWith(":media-closure") && row.verdict === "FAIL",
			),
		).toBe(true);
		const wrongDeps = depsFor(
			["out/manifests/stream.mpd", "out/private/video.webm"],
			probe,
			text.replaceAll("../video/", "../private/"),
		);
		const wrongList = vi.fn(wrongDeps.listAll);
		wrongDeps.listAll = wrongList;
		const wrong = await verifyArtefacts(expected, wrongDeps);
		expect(wrong.failed).toBeGreaterThan(0);
		expect(
			wrongList.mock.calls.every(
				([, prefix]) => !prefix.startsWith("out/private/"),
			),
		).toBe(true);
		expect(wrongDeps.fetchConcatenated).not.toHaveBeenCalledWith("origin", [
			"out/private/video.webm",
		]);
	});
	it("retains a selected Default video whose resolution comes from the source", async () => {
		const plan = manifestPlan();
		const video = plan.renditions.find((row) => row.key === "video");
		if (video?.codec !== "H264") throw new Error("missing video");
		video.height = null;
		video.width = 1280;
		const manifest = plan.manifests[0];
		if (manifest?.kind !== "DASH") throw new Error("missing DASH");
		manifest.generationMode = "DEFAULT";
		const healthy = await verifyManifest(plan, mpd(VIDEO + AUDIO));
		expect(healthy.checks.filter((check) => check.verdict === "FAIL")).toEqual(
			[],
		);
		expect(
			healthy.checks.some(
				(check) => check.id.endsWith(":height") && check.verdict === "SKIP",
			),
		).toBe(true);
		const wrong = await verifyManifest(
			plan,
			mpd(VIDEO.replace("avc1.64001f", "hvc1.1.6.L93") + AUDIO),
		);
		expect(
			wrong.checks.some(
				(check) => check.id.endsWith(":codec") && check.verdict === "FAIL",
			),
		).toBe(true);
		const wrongWidth = await verifyManifest(
			plan,
			mpd(VIDEO.replace('width="1280"', 'width="1920"') + AUDIO),
		);
		expect(
			wrongWidth.checks.some(
				(check) => check.id.endsWith(":present") && check.verdict === "FAIL",
			),
		).toBe(true);
	});
	it("counts an image representation separately and detects its omission", async () => {
		const plan = manifestPlan();
		plan.sprites = [
			{
				key: "sprite",
				streamKey: "video",
				width: 160,
				distance: 10,
				unit: "SECONDS",
				filename: "sprite.jpg",
				destination: { outputKey: "origin", path: "out/sprites/" },
			},
		];
		const manifest = plan.manifests[0];
		if (manifest?.kind !== "DASH") throw new Error("missing DASH");
		manifest.detailed = {
			additionalRepresentations: [{ type: "SPRITE", spriteKey: "sprite" }],
		};
		const image =
			'<AdaptationSet contentType="image" mimeType="image/jpeg"><Representation id="sprite" bandwidth="256"><BaseURL>sprites/sprite.jpg</BaseURL></Representation></AdaptationSet>';
		const healthy = await verifyManifest(plan, mpd(VIDEO + AUDIO + image));
		expect(healthy.checks.filter((check) => check.verdict === "FAIL")).toEqual(
			[],
		);
		const missing = await verifyManifest(plan, mpd(VIDEO + AUDIO));
		expect(
			missing.checks.find((check) =>
				check.id.endsWith(":image-representations"),
			)?.verdict,
		).toBe("FAIL");
		const wrong = await verifyManifest(
			plan,
			mpd(
				VIDEO +
					AUDIO +
					image.replace("sprites/sprite.jpg", "sprites/wrong.jpg"),
			),
		);
		expect(
			wrong.checks.find((check) => check.id.endsWith(":sprite:0:reference"))
				?.verdict,
		).toBe("FAIL");
		const missingFile = await verifyManifest(plan, mpd(VIDEO + AUDIO + image), [
			"out/stream.mpd",
			"out/video.mp4",
			"out/audio.mp4",
		]);
		expect(
			missingFile.checks.find((check) => check.id.endsWith(":sprite:0:file"))
				?.verdict,
		).toBe("FAIL");
		const templatedImage =
			'<AdaptationSet contentType="image" mimeType="image/jpeg"><SegmentTemplate media="$RepresentationID$/sprite.jpg" duration="12" timescale="1" startNumber="0"/><Representation id="sprites" bandwidth="256"/></AdaptationSet>';
		const templated = await verifyManifest(
			plan,
			mpd(VIDEO + AUDIO + templatedImage),
		);
		expect(
			templated.checks.filter((check) => check.verdict === "FAIL"),
		).toEqual([]);
		const wrongTemplate = await verifyManifest(
			plan,
			mpd(VIDEO + AUDIO + templatedImage.replace("/sprite.jpg", "/wrong.jpg")),
		);
		expect(
			wrongTemplate.checks.find((check) =>
				check.id.endsWith(":sprite:0:reference"),
			)?.verdict,
		).toBe("FAIL");
		const sprite = plan.sprites[0];
		if (!sprite) throw new Error("missing sprite");
		sprite.filename = "sprite_%number%.jpg";
		const numbered = templatedImage
			.replace("sprite.jpg", "sprite_$Number$.jpg")
			.replace('duration="12"', 'duration="3"');
		const numberedFiles = [
			"out/stream.mpd",
			"out/video.mp4",
			"out/audio.mp4",
			"out/sprites/sprite_0.jpg",
			"out/sprites/sprite_1.jpg",
		];
		const numberedHealthy = await verifyManifest(
			plan,
			mpd(VIDEO + AUDIO + numbered),
			numberedFiles,
		);
		expect(
			numberedHealthy.checks.filter((check) => check.verdict === "FAIL"),
		).toEqual([]);
		const missingSecond = await verifyManifest(
			plan,
			mpd(VIDEO + AUDIO + numbered),
			numberedFiles.slice(0, -1),
		);
		expect(
			missingSecond.checks.find((check) => check.id.endsWith(":sprite:0:file"))
				?.verdict,
		).toBe("FAIL");
	});
	it("binds a progressive WebM representation to its complete file", async () => {
		const original = manifestPlan();
		const plan = encodingPlanSchema.parse({
			...original,
			renditions: original.renditions.map((row) =>
				row.key === "video"
					? {
							key: "video",
							codec: "VP9",
							ingestKey: "video",
							height: 720,
							bitrate: 2_000_000,
						}
					: row,
			),
			muxings: [
				{
					key: "video",
					kind: "WEBM",
					streamKey: "video",
					progressive: true,
					filename: "video.webm",
					destination: { outputKey: "origin", path: "out/" },
				},
				original.muxings[1],
			],
		});
		const manifest = plan.manifests[0];
		if (manifest?.kind !== "DASH") throw new Error("missing DASH");
		manifest.detailed = {
			additionalRepresentations: [
				{ type: "PROGRESSIVE_WEBM", muxingKey: "video" },
			],
		};
		const video = VIDEO.replace("avc1.64001f", "vp09.00.40.08").replaceAll(
			"video.mp4",
			"video.webm",
		);
		const healthy = await verifyManifest(plan, mpd(video + AUDIO));
		expect(healthy.checks.filter((check) => check.verdict === "FAIL")).toEqual(
			[],
		);
		const wrong = await verifyManifest(
			plan,
			mpd(video.replaceAll("video.webm", "wrong.webm") + AUDIO),
		);
		expect(
			wrong.checks.find((check) => check.id.endsWith(":progressive-file:0"))
				?.verdict,
		).toBe("FAIL");
	});
	it("allows repeated representation IDs in different periods without reusing a period's nodes", async () => {
		const plan = manifestPlan();
		const manifest = plan.manifests[0];
		if (manifest?.kind !== "DASH") throw new Error("missing DASH");
		manifest.generationMode = "DEFAULT";
		manifest.defaultPeriods = [
			{ encodingKeys: ["default"] },
			{ encodingKeys: ["default"] },
		];
		const healthy = await verifyManifest(
			plan,
			mpd(VIDEO + AUDIO, VIDEO + AUDIO),
		);
		expect(healthy.checks.filter((check) => check.verdict === "FAIL")).toEqual(
			[],
		);
		expect(new Set(healthy.checks.map((check) => check.id)).size).toBe(
			healthy.checks.length,
		);
	});
	it("accepts an external VTT representation and rejects its absence or wrong source URL", async () => {
		const plan = manifestPlan();
		const manifest = plan.manifests[0];
		if (manifest?.kind !== "DASH") throw new Error("missing DASH");
		manifest.detailed = {
			additionalRepresentations: [
				{
					type: "VTT",
					vttUrl: "https://media.example.test/subs.vtt",
					lang: "ja",
				},
			],
		};
		const healthy = await verifyManifest(plan, mpd(VIDEO + AUDIO + VTT));
		expect(healthy.checks.filter((check) => check.verdict === "FAIL")).toEqual(
			[],
		);
		const missing = await verifyManifest(plan, mpd(VIDEO + AUDIO));
		expect(
			missing.checks.find((check) => check.id.endsWith(":text-representations"))
				?.verdict,
		).toBe("FAIL");
		const wrong = await verifyManifest(
			plan,
			mpd(VIDEO + AUDIO + VTT.replace("subs.vtt", "different.vtt")),
		);
		expect(
			wrong.checks.find((check) =>
				check.id.endsWith(":external-subtitle:0:reference"),
			)?.verdict,
		).toBe("FAIL");
	});
	it.each([
		["H264", "AAC"],
		["h264", "aac"],
		["H264", "AaC"],
	])("checks each conditional period independently for %s/%s, including missing periods and wrong codec families", async (videoCodec, audioCodec) => {
		const plan = manifestPlan();
		const manifest = plan.manifests[0];
		if (manifest?.kind !== "DASH") throw new Error("missing DASH");
		manifest.generationMode = "DEFAULT";
		manifest.defaultPeriods = [
			{
				encodingKeys: ["default"],
				adaptationSets: [condition("video.codec", videoCodec)],
			},
			{
				encodingKeys: ["default"],
				adaptationSets: [condition("audio.codec", audioCodec)],
			},
		];
		const healthy = await verifyManifest(plan, mpd(VIDEO, AUDIO));
		expect(healthy.checks.filter((check) => check.verdict === "FAIL")).toEqual(
			[],
		);
		expect(
			healthy.checks.find((check) =>
				check.id.endsWith(":period:0:video-representations"),
			)?.verdict,
		).toBe("PASS");
		const missing = await verifyManifest(plan, mpd(VIDEO));
		expect(
			missing.checks.find((check) => check.id.endsWith(":period-count"))
				?.verdict,
		).toBe("FAIL");
		const swapped = await verifyManifest(plan, mpd(AUDIO, VIDEO));
		expect(swapped.failed).toBeGreaterThan(0);
		const wrong = await verifyManifest(
			plan,
			mpd(VIDEO.replace("avc1.64001f", "hvc1.1.6.L93"), AUDIO),
		);
		expect(
			wrong.checks.some(
				(check) => check.id.includes(":period:0:") && check.verdict === "FAIL",
			),
		).toBe(true);
	});
	it("reports an unknown language selection explicitly while rejecting unrelated media", async () => {
		const plan = manifestPlan();
		const manifest = plan.manifests[0];
		if (manifest?.kind !== "DASH") throw new Error("missing DASH");
		manifest.generationMode = "DEFAULT";
		manifest.defaultPeriods = [
			{
				encodingKeys: ["default"],
				adaptationSets: [condition("audio.language", "ja")],
			},
		];
		const healthy = await verifyManifest(plan, mpd(AUDIO));
		expect(healthy.checks.filter((check) => check.verdict === "FAIL")).toEqual(
			[],
		);
		expect(
			healthy.checks.find((check) =>
				check.id.endsWith(":period:0:selection-metadata"),
			)?.verdict,
		).toBe("SKIP");
		const wrong = await verifyManifest(plan, mpd(AUDIO + VIDEO));
		expect(
			wrong.checks.find((check) =>
				check.id.endsWith(":period:0:video-representations"),
			)?.verdict,
		).toBe("FAIL");
	});
});
