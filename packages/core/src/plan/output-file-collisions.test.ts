import { describe, expect, it } from "vitest";
import { outputFileCollisions } from "./output-file-collisions";
import { type EncodingPlan, encodingPlanSchema } from "./schema";
import { validatePlan } from "./validate";

/**
 * A plan can be valid in every reference and still write two outputs to one
 * file. These pin where that is caught and — as much — where it is not: a plan
 * whose files only look alike must keep passing.
 */

const IN = "00000000-0000-4000-8000-000000000001";
const OUT = "00000000-0000-4000-8000-000000000002";
const OTHER = "00000000-0000-4000-8000-000000000003";

type Muxing = Record<string, unknown>;

const mp4 = (
	key: string,
	streamKey: string,
	path: string,
	filename: string,
) => ({
	key,
	kind: "MP4",
	streamKey,
	filename,
	destination: { outputKey: "origin", path },
});

function plan(
	muxings: Muxing[],
	extra: Record<string, unknown> = {},
): EncodingPlan {
	return encodingPlanSchema.parse({
		planVersion: 1,
		name: "files",
		bitmovin: {},
		inputs: [{ key: "main", kind: "S3", credentialId: IN, bucket: "in" }],
		outputs: [{ key: "origin", kind: "S3", credentialId: OUT, bucket: "out" }],
		ingest: [
			{
				key: "video",
				inputKey: "main",
				inputPath: "master.mov",
				selectionMode: "VIDEO_RELATIVE",
				position: 0,
			},
		],
		renditions: [
			{
				key: "v1080",
				ingestKey: "video",
				codec: "H264",
				height: 1080,
				bitrate: 8_000_000,
			},
			{
				key: "v540",
				ingestKey: "video",
				codec: "H264",
				height: 540,
				bitrate: 2_000_000,
			},
		],
		muxings,
		manifests: [],
		generation: { timing: "POST_ENCODING" },
		...extra,
	});
}

const collisions = (source: Parameters<typeof outputFileCollisions>[0]) =>
	outputFileCollisions(source).map((issue) => issue.path);

describe("two outputs written to one file", () => {
	it("is an error on the second muxing, naming the file and the first", () => {
		const issues = outputFileCollisions(
			plan([
				mp4("full", "v1080", "exports/", "clip.mp4"),
				mp4("proxy", "v540", "exports/", "clip.mp4"),
			]),
		);
		expect(issues).toEqual([
			{
				code: "PLAN_OUTPUT_FILE_COLLISION",
				level: "error",
				path: "muxings[1].filename",
				message:
					'muxing "proxy" writes "exports/clip.mp4", the file that muxing "full" writes — one would replace the other. Give each file its own name or folder.',
			},
		]);
	});

	it("stops the plan in validation", () => {
		const errors = (source: EncodingPlan) =>
			validatePlan(source)
				.filter((issue) => issue.level === "error")
				.map((issue) => issue.code);
		expect(
			errors(
				plan([
					mp4("full", "v1080", "exports/", "clip.mp4"),
					mp4("proxy", "v540", "exports/", "clip.mp4"),
				]),
			),
		).toEqual(["PLAN_OUTPUT_FILE_COLLISION"]);
		expect(
			errors(
				plan([
					mp4("full", "v1080", "exports/", "clip.mp4"),
					mp4("proxy", "v540", "exports/", "clip-540p.mp4"),
				]),
			),
		).toEqual([]);
	});

	it("names every earlier muxing a third one collides with", () => {
		const [first, second] = outputFileCollisions(
			plan(
				[
					mp4("a", "v1080", "exports", "clip.mp4"),
					mp4("b", "v540", "exports", "clip.mp4"),
					mp4("c", "v360", "exports", "clip.mp4"),
				],
				{
					renditions: [
						{
							key: "v1080",
							ingestKey: "video",
							codec: "H264",
							height: 1080,
							bitrate: 8e6,
						},
						{
							key: "v540",
							ingestKey: "video",
							codec: "H264",
							height: 540,
							bitrate: 2e6,
						},
						{
							key: "v360",
							ingestKey: "video",
							codec: "H264",
							height: 360,
							bitrate: 1e6,
						},
					],
				},
			),
		);
		expect(first?.path).toBe("muxings[1].filename");
		expect(second?.path).toBe("muxings[2].filename");
		expect(second?.message).toContain('muxing "a" and muxing "b"');
	});

	it("reads a folder with and without its closing slash as one folder", () => {
		expect(
			outputFileCollisions(
				plan([
					mp4("full", "v1080", "exports", "clip.mp4"),
					mp4("proxy", "v540", "exports/", "clip.mp4"),
				]),
			).map((issue) => [issue.path, issue.level]),
		).toEqual([["muxings[1].filename", "error"]]);
	});

	it.each([
		["./exports", "exports"],
		["exports//", "/exports"],
		["exports/tmp/..", "exports"],
	])("warns, and does not refuse, when %j and %j may be one folder", (one, other) => {
		// Whether the storage normalises a path is not measured: if it does, these
		// are one file; if it does not, they are two and the plan works as written.
		const source = plan([
			mp4("full", "v1080", one, "clip.mp4"),
			mp4("proxy", "v540", other, "clip.mp4"),
		]);
		expect(outputFileCollisions(source)).toEqual([
			{
				code: "PLAN_OUTPUT_FILE_COLLISION",
				level: "warning",
				path: "muxings[1].filename",
				message:
					'muxing "proxy" writes "exports/clip.mp4", the file that muxing "full" writes, if the storage reads the two spellings of that path as one — one would then replace the other. Spell the path one way, or give each file its own name or folder.',
			},
		]);
		expect(
			validatePlan(source).filter((issue) => issue.level === "error"),
		).toEqual([]);
	});

	it("is certain as soon as one earlier output spells the path the same way", () => {
		const levels = outputFileCollisions(
			plan(
				[
					mp4("a", "v1080", "./exports", "clip.mp4"),
					mp4("b", "v540", "exports", "clip.mp4"),
					mp4("c", "v360", "exports", "clip.mp4"),
				],
				{
					renditions: [1080, 540, 360].map((height) => ({
						key: `v${height}`,
						ingestKey: "video",
						codec: "H264",
						height,
						bitrate: height * 4000,
					})),
				},
			),
		).map((issue) => [issue.path, issue.level]);
		expect(levels).toEqual([
			["muxings[1].filename", "warning"],
			["muxings[2].filename", "error"],
		]);
	});

	it("is a warning on a re-run, which reproduces what the job already wrote", () => {
		const source = plan([
			mp4("full", "v1080", "exports/", "clip.mp4"),
			mp4("proxy", "v540", "exports/", "clip.mp4"),
		]);
		expect(
			outputFileCollisions(source, "warning").map((issue) => issue.level),
		).toEqual(["warning"]);
		const rerun = validatePlan(source, { demoteFileOutputRails: true }).filter(
			(issue) => issue.code === "PLAN_OUTPUT_FILE_COLLISION",
		);
		expect(rerun.map((issue) => issue.level)).toEqual(["warning"]);
		// The message is the certain one: only the level is lowered.
		expect(rerun[0]?.message).toContain("one would replace the other");
	});

	it("follows the bytes: an output listed under a second key is the same bucket", () => {
		const alias = (bucket: string, credentialId = OUT) =>
			plan(
				[
					mp4("full", "v1080", "exports", "clip.mp4"),
					{
						...mp4("proxy", "v540", "exports", "clip.mp4"),
						destination: { outputKey: "second", path: "exports" },
					},
				],
				{
					outputs: [
						{ key: "origin", kind: "S3", credentialId: OUT, bucket: "out" },
						{ key: "second", kind: "S3", credentialId, bucket },
					],
				},
			);
		// An S3 bucket name is global, whoever's credentials reach it.
		expect(collisions(alias("out", OTHER))).toEqual(["muxings[1].filename"]);
		expect(collisions(alias("elsewhere"))).toEqual([]);
	});

	it("follows the bytes: a delivery mirror receives every destination's files", () => {
		const mirrored = plan(
			[
				mp4("full", "v1080", "exports", "clip.mp4"),
				{
					...mp4("proxy", "v540", "exports", "clip.mp4"),
					destination: { outputKey: "second", path: "exports" },
				},
			],
			{
				outputs: [
					{ key: "origin", kind: "S3", credentialId: OUT, bucket: "out" },
					{ key: "second", kind: "S3", credentialId: OUT, bucket: "elsewhere" },
				],
			},
		);
		expect(collisions(mirrored)).toEqual([]);
		expect(
			collisions({ ...mirrored, deliveryMirrors: [{ outputKey: "second" }] }),
		).toEqual(["muxings[1].filename"]);
	});

	it("counts a file written through a DRM configuration", () => {
		const encrypted = (key: string, streamKey: string) => ({
			key,
			kind: "MP4",
			streamKey,
			filename: "clip.mp4",
		});
		const drm = (key: string, muxingKey: string, path: string) => ({
			key,
			kind: "FAIRPLAY" as const,
			muxingKey,
			credentialId: OTHER,
			iv: "0".repeat(32),
			uri: "skd://key",
			destination: { outputKey: "origin", path },
		});
		const base = plan([encrypted("full", "v1080"), encrypted("proxy", "v540")]);
		expect(
			collisions({
				...base,
				drm: [drm("d1", "full", "drm"), drm("d2", "proxy", "drm")],
			}),
		).toEqual(["muxings[1].filename"]);
		// One muxing, encrypted twice into two folders, is not a collision with itself.
		expect(
			collisions({
				...base,
				drm: [
					drm("d1", "full", "drm/a"),
					drm("d2", "full", "drm/b"),
					drm("d3", "proxy", "drm/c"),
				],
			}),
		).toEqual([]);
	});

	it("counts one muxing that writes the same file from two of its outputs", () => {
		const drm = (key: string, path: string) => ({
			key,
			kind: "FAIRPLAY" as const,
			muxingKey: "full",
			credentialId: OTHER,
			iv: "0".repeat(32),
			uri: "skd://key",
			destination: { outputKey: "origin", path },
		});
		const clear = plan([mp4("full", "v1080", "exports", "clip.mp4")]);
		// Its own copy and its encrypted copy, under the one name the muxing has.
		expect(
			outputFileCollisions({ ...clear, drm: [drm("d1", "exports/")] }),
		).toEqual([
			{
				code: "PLAN_OUTPUT_FILE_COLLISION",
				level: "error",
				path: "muxings[0].filename",
				message:
					'muxing "full" writes "exports/clip.mp4" from two of its outputs — one would replace the other. Give each file its own name or folder.',
			},
		]);
		// Two encrypted copies into one folder.
		const encrypted = plan([
			{ key: "full", kind: "MP4", streamKey: "v1080", filename: "clip.mp4" },
		]);
		expect(
			collisions({ ...encrypted, drm: [drm("d1", "drm"), drm("d2", "drm")] }),
		).toEqual(["muxings[0].filename"]);
		expect(
			collisions({ ...clear, drm: [drm("d1", "exports/encrypted")] }),
		).toEqual([]);
	});

	it("covers every kind that writes one file", () => {
		expect(
			collisions(
				plan([
					mp4("full", "v1080", "exports", "output.webm"),
					{
						key: "web",
						kind: "WEBM",
						progressive: true,
						streamKey: "v540",
						destination: { outputKey: "origin", path: "exports" },
					},
				]),
			),
		).toEqual(["muxings[1].filename"]);
	});
});

describe("files that only look alike", () => {
	it.each([
		[
			"the same name in two folders",
			[
				mp4("full", "v1080", "exports/1080", "clip.mp4"),
				mp4("proxy", "v540", "exports/540", "clip.mp4"),
			],
		],
		[
			"a folder whose name starts like the other's",
			[
				mp4("full", "v1080", "exports", "clip.mp4"),
				mp4("proxy", "v540", "exports2", "clip.mp4"),
			],
		],
		[
			"names that differ only in case",
			[
				mp4("full", "v1080", "exports", "Clip.mp4"),
				mp4("proxy", "v540", "exports", "clip.mp4"),
			],
		],
		[
			// The provider gives the placeholder a value per output.
			"a folder with a placeholder",
			[
				mp4("full", "v1080", "exports/{uuid}", "clip.mp4"),
				mp4("proxy", "v540", "exports/{uuid}", "clip.mp4"),
			],
		],
		[
			"a name with a placeholder",
			[
				mp4("full", "v1080", "exports", "clip_{bitrate}.mp4"),
				mp4("proxy", "v540", "exports", "clip_{bitrate}.mp4"),
			],
		],
		[
			// Segments are named by the provider; this rule is about single files.
			"segmented output sharing a folder",
			[
				{
					key: "full",
					kind: "FMP4",
					streamKey: "v1080",
					destination: { outputKey: "origin", path: "exports" },
				},
				{
					key: "proxy",
					kind: "FMP4",
					streamKey: "v540",
					destination: { outputKey: "origin", path: "exports" },
				},
			],
		],
	] satisfies [string, Muxing[]][])("passes %s", (_case, muxings) => {
		expect(collisions(plan(muxings))).toEqual([]);
	});

	it("passes a measurement-only job, which writes none of its muxings", () => {
		const twice = plan([
			mp4("full", "v1080", "exports", "clip.mp4"),
			mp4("proxy", "v540", "exports", "clip.mp4"),
		]);
		expect(collisions({ ...twice, qc: { only: true } })).toEqual([]);
	});
});

describe("outputs that depend on the source", () => {
	const video = (key: string, height: number, operator?: string) => ({
		key,
		ingestKey: "video",
		codec: "H264",
		height,
		bitrate: height * 4000,
		...(operator
			? { conditions: { attribute: "HEIGHT", operator, value: "1080" } }
			: {}),
	});
	const audio = {
		key: "a192",
		ingestKey: "video",
		codec: "AAC",
		bitrate: 192_000,
		rate: 48_000,
		conditions: {
			attribute: "AUDIOSTREAMCOUNT",
			operator: "GREATER_THAN",
			value: "0",
		},
	};
	const sameName = [
		mp4("full", "v1080", "exports", "clip.mp4"),
		mp4("proxy", "v540", "exports", "clip.mp4"),
	];

	it("passes two that are each written only when their condition holds", () => {
		// One name for whichever of the two the source calls for.
		expect(
			collisions(
				plan(sameName, {
					renditions: [
						video("v1080", 1080, "GREATER_THAN_OR_EQUAL"),
						video("v540", 540, "LESS_THAN"),
					],
				}),
			),
		).toEqual([]);
	});

	it("passes two that each hold a stream with a condition beside one without", () => {
		// Whether such a file is written at all is the provider's choice
		// (`streamConditionsMode`), which no plan of this app sets.
		const guarded = plan(
			sameName.map((muxing) => ({
				...muxing,
				additionalStreamKeys: ["a192"],
			})),
			{ renditions: [video("v1080", 1080), video("v540", 540), audio] },
		);
		expect(collisions(guarded)).toEqual([]);
		// The same two files without the condition are certain.
		expect(
			collisions({
				...guarded,
				renditions: guarded.renditions.map(
					({ conditions: _conditions, ...rendition }) => rendition,
				) as typeof guarded.renditions,
			}),
		).toEqual(["muxings[1].filename"]);
	});
});
