import { encodingPlanSchema, validatePlan } from "@bitovp/core";
import { describe, expect, it } from "vitest";
import { reconcileAutomaticAudioPackaging } from "./automatic-audio-packaging";
import { buildPlan, type WizardState } from "./build-plan";
import {
	addFile,
	collapseToFileOutput,
	defaultFileNames,
	editFile,
	editFileAudio,
	FILE_OUTPUT_DEFAULT_STATE,
	fileOutputBlockers,
	isFileOutputState,
	removeFile,
	renameFileJob,
	setFileAudio,
	sharedFileNames,
} from "./file-output";

/** What the wizard's `patch` does with an edit: merge it, then reconcile the audio rows. */
function apply(state: WizardState, patch: Partial<WizardState>): WizardState {
	const next = { ...state, ...patch };
	return { ...next, audios: reconcileAutomaticAudioPackaging(next) };
}

const started: WizardState = apply(FILE_OUTPUT_DEFAULT_STATE, {
	...renameFileJob(FILE_OUTPUT_DEFAULT_STATE, "clip"),
	cloudRegion: "AWS_AP_NORTHEAST_1",
	encoderVersion: "STABLE",
	inputFiles: [
		{
			key: "main",
			inputKey: "main",
			kind: "S3",
			credentialId: "00000000-0000-4000-8000-000000000001",
			bucket: "in",
			path: "source.mov",
			name: "S3 Input",
		},
	],
	output: {
		...FILE_OUTPUT_DEFAULT_STATE.output,
		credentialId: "00000000-0000-4000-8000-000000000002",
		bucket: "out",
		basePath: "exports",
	},
});

const planOf = (state: WizardState) =>
	encodingPlanSchema.parse(buildPlan(state));
const errorsOf = (state: WizardState) =>
	validatePlan(planOf(state)).filter((issue) => issue.level === "error");
const filesOf = (state: WizardState) =>
	planOf(state).muxings.map((muxing) => ({
		kind: muxing.kind,
		filename: "filename" in muxing ? muxing.filename : undefined,
		path: muxing.destination?.path,
		streams: [
			muxing.streamKey,
			...("additionalStreamKeys" in muxing
				? (muxing.additionalStreamKeys ?? [])
				: []),
		],
	}));

describe("the state the file-output flow starts from", () => {
	it("writes one MP4 with the audio inside and no manifest, once a source and a folder are set", () => {
		expect(filesOf(started)).toEqual([
			{
				kind: "MP4",
				filename: "clip.mp4",
				path: "exports/",
				streams: ["v1080", "a192"],
			},
		]);
		expect(planOf(started).manifests).toEqual([]);
		expect(errorsOf(started)).toEqual([]);
	});

	it("keeps the folder private", () => {
		expect(FILE_OUTPUT_DEFAULT_STATE.output.publicRead).toBe(false);
		expect(planOf(started).muxings[0]?.destination?.acl).not.toBe(
			"PUBLIC_READ",
		);
	});

	it("is already what the wizard's audio reconciliation settles on", () => {
		expect(reconcileAutomaticAudioPackaging(FILE_OUTPUT_DEFAULT_STATE)).toEqual(
			FILE_OUTPUT_DEFAULT_STATE.audios,
		);
	});

	it("can be shown whole by the simple view", () => {
		expect(fileOutputBlockers(FILE_OUTPUT_DEFAULT_STATE)).toEqual([]);
		expect(fileOutputBlockers(started)).toEqual([]);
	});
});

describe("file names", () => {
	it("follow the job name until one is typed", () => {
		const renamed = apply(started, renameFileJob(started, "trailer v2"));
		expect(renamed.videos[0]?.muxing?.filename).toBe("trailer v2.mp4");

		const typed = apply(
			renamed,
			editFile(renamed, 0, { filename: "final.mp4" }),
		);
		const again = apply(typed, renameFileJob(typed, "other"));
		expect(again.videos[0]?.muxing?.filename).toBe("final.mp4");
	});

	it("never carry a directory or a URL suffix from the job name", () => {
		expect(defaultFileNames(" a/b?c#d ", started.videos)).toEqual([
			"a-b-c-d.mp4",
		]);
		expect(defaultFileNames("", started.videos)).toEqual(["output.mp4"]);
	});

	it("differ between files that share the folder", () => {
		const two = apply(started, addFile(started));
		const three = apply(two, editFile(two, 1, { height: 1080 }));
		const four = apply(three, addFile(three));
		const same = apply(four, editFile(four, 2, { height: 1080 }));
		expect(same.videos.map((video) => video.muxing?.filename)).toEqual([
			"clip.mp4",
			"clip-1080p.mp4",
			"clip-1080p-3.mp4",
		]);
		expect(errorsOf(same)).toEqual([]);
	});
});

describe("a name two files were given", () => {
	const two = apply(started, addFile(started));
	const collides = (state: WizardState) =>
		errorsOf(state).some(
			(issue) => issue.code === "PLAN_OUTPUT_FILE_COLLISION",
		);
	const renamed = (names: string[]) =>
		names.reduce(
			(state, filename, index) =>
				apply(state, editFile(state, index, { filename })),
			two,
		);

	it("is marked on both, where the plan's validation refuses the job", () => {
		expect(sharedFileNames(two.videos)).toEqual([false, false]);
		expect(collides(two)).toBe(false);

		// The folder is one, however the name spells its way there.
		const same = renamed(["clip.mp4", "./clip.mp4"]);
		expect(sharedFileNames(same.videos)).toEqual([true, true]);
		expect(collides(same)).toBe(true);
	});

	it("is marked on the files that share it, not on the rest", () => {
		const three = apply(two, addFile(two));
		const same = apply(three, editFile(three, 2, { filename: "clip.mp4" }));
		expect(sharedFileNames(same.videos)).toEqual([true, false, true]);
	});

	it.each([
		// The provider gives a placeholder its value, per file.
		["a placeholder", ["clip_{bitrate}.mp4", "clip_{bitrate}.mp4"]],
		["a difference in case", ["Clip.mp4", "clip.mp4"]],
	])("is not read into %s, as the plan's validation does not", (_case, names) => {
		const state = renamed(names);
		expect(sharedFileNames(state.videos)).toEqual([false, false]);
		expect(collides(state)).toBe(false);
	});

	it("is not read into two fields left empty, which are missing rather than shared", () => {
		expect(sharedFileNames(renamed(["", ""]).videos)).toEqual([false, false]);
	});
});

describe("files", () => {
	it("adds a smaller copy that carries the same audio", () => {
		const two = apply(started, addFile(started));
		expect(filesOf(two)).toEqual([
			{
				kind: "MP4",
				filename: "clip.mp4",
				path: "exports/",
				streams: ["v1080", "a192"],
			},
			{
				kind: "MP4",
				filename: "clip-540p.mp4",
				path: "exports/",
				streams: ["v540", "a192"],
			},
		]);
		expect(two.videos[1]?.bitrate).toBe(2_000_000);
		expect(errorsOf(two)).toEqual([]);
		expect(fileOutputBlockers(two)).toEqual([]);
	});

	it("renames the files that are left when one is removed", () => {
		const two = apply(started, addFile(started));
		const one = apply(two, removeFile(two, 0));
		expect(filesOf(one).map((item) => item.filename)).toEqual(["clip.mp4"]);
		expect(one.videos[0]?.height).toBe(540);
	});

	it("refuses to remove the last file", () => {
		expect(removeFile(started, 0).videos).toBe(started.videos);
	});

	it("keeps the source height when the height is left empty", () => {
		const source = apply(started, editFile(started, 0, { height: null }));
		expect(planOf(source).renditions[0]).toMatchObject({ height: null });
		expect(errorsOf(source)).toEqual([]);
		expect(fileOutputBlockers(source)).toEqual([]);
	});

	it("reads a source stream chosen for it, and returns to the input's own track", () => {
		const trimmed = apply(started, editFile(started, 0, { source: "trim-1" }));
		expect(trimmed.videos[0]?.extras).toEqual({ source: "trim-1" });
		expect(fileOutputBlockers(trimmed)).toEqual([]);
		const back = apply(trimmed, editFile(trimmed, 0, { source: "" }));
		expect(back.videos[0]).toEqual(started.videos[0]);
	});
});

describe("the audio track", () => {
	it("stays inside every file when its bitrate, and so its key, changes", () => {
		const two = apply(started, addFile(started));
		const louder = apply(two, editFileAudio(two, { bitrate: 256_000 }));
		expect(filesOf(louder).map((item) => item.streams)).toEqual([
			["v1080", "a256"],
			["v540", "a256"],
		]);
		expect(errorsOf(louder)).toEqual([]);
		expect(fileOutputBlockers(louder)).toEqual([]);
	});

	it("can be left out, and put back", () => {
		const silent = apply(started, setFileAudio(started, false));
		expect(filesOf(silent).map((item) => item.streams)).toEqual([["v1080"]]);
		expect(errorsOf(silent)).toEqual([]);
		expect(fileOutputBlockers(silent)).toEqual([]);

		const back = apply(silent, setFileAudio(silent, true));
		expect(filesOf(back)).toEqual(filesOf(started));
	});

	it("drops a channel layout that belongs to the codec it leaves", () => {
		const ac3 = apply(started, editFileAudio(started, { codec: "AC3" }));
		expect(ac3.audios[0]).toMatchObject({ codec: "AC3" });
		expect(ac3.audios[0]?.channelLayout).toBeUndefined();
		expect(errorsOf(ac3)).toEqual([]);
	});
});

describe("what the simple view cannot show", () => {
	const cases: [string, Partial<WizardState>, string[]][] = [
		["a manifest", { manifests: { hls: true, dash: false } }, ["manifests"]],
		["post-encoding generation", { timing: "POST_ENCODING" }, ["manifests"]],
		["an encoding option", { labels: ["team-a"] }, ["encoding"]],
		[
			"a thumbnail",
			{
				thumbnails: [
					{
						key: "thumb",
						streamKey: "v1080",
						height: 320,
						positions: [10],
						pattern: "thumb-%number%.png",
					} as never,
				],
			},
			["packaging"],
		],
		["the audio guard", { audioGuard: true }, ["ladder"]],
		[
			"a second audio track",
			{
				audios: [
					...started.audios,
					{ codec: "AAC", bitrate: 96_000, rate: 48_000 },
				],
			},
			["ladder"],
		],
		[
			"a stream display name",
			{
				videos: [
					{ ...started.videos[0], extras: { streamName: "Main" } } as never,
				],
			},
			["ladder"],
		],
		[
			"a file sorted into its own folder",
			{
				videos: [
					{
						...started.videos[0],
						muxing: { ...started.videos[0]?.muxing, path: "video/1080p" },
					} as never,
				],
			},
			["packaging"],
		],
		[
			"a fragmented MP4",
			{
				videos: [
					{
						...started.videos[0],
						muxing: { ...started.videos[0]?.muxing, fragmentDuration: 4000 },
					} as never,
				],
			},
			["packaging"],
		],
		[
			"a segmented container",
			{ videos: [{ height: 1080, bitrate: 8_000_000 }] },
			["packaging"],
		],
	];
	it.each(cases)("%s", (_name, patch, steps) => {
		expect(fileOutputBlockers(apply(started, patch))).toEqual(steps);
	});

	it("does not count a collection someone emptied again", () => {
		const emptied = apply(started, {
			subtitles: [],
			drm: [],
			startOptions: { encodingMode: undefined },
			manifests: { hls: false, dash: false, extra: [] },
		});
		expect(isFileOutputState(emptied)).toBe(true);
	});
});

describe("returning from the full wizard", () => {
	// What the ladder step leaves behind after a height edit: every key frozen.
	const frozen: WizardState = {
		...started,
		videos: [
			{
				...(started.videos[0] as WizardState["videos"][number]),
				height: 720,
				autoKey: "v720",
				extras: { key: "v720" },
				muxing: { ...started.videos[0]?.muxing, key: "v720" },
			},
		],
		audios: [
			{
				...(started.audios[0] as WizardState["audios"][number]),
				bitrate: 256_000,
				extras: { key: "a192" },
			},
		],
	};

	it("is allowed while only keys were frozen", () => {
		expect(fileOutputBlockers(frozen)).toEqual([]);
	});

	it("derives the keys again without moving a file", () => {
		const collapsed = collapseToFileOutput(frozen);
		expect(collapsed.videos[0]).toEqual({
			height: 720,
			bitrate: 8_000_000,
			muxing: {
				kind: "MP4",
				filename: "clip.mp4",
				path: "",
				muxedAudioKeys: ["a256"],
			},
		});
		expect(collapsed.audios[0]?.extras).toBeUndefined();
		expect(filesOf(collapsed)).toEqual([
			{
				kind: "MP4",
				filename: "clip.mp4",
				path: "exports/",
				streams: ["v720", "a256"],
			},
		]);
		expect(reconcileAutomaticAudioPackaging(collapsed)).toEqual(
			collapsed.audios,
		);
	});

	it("leaves a state this flow made untouched", () => {
		expect(collapseToFileOutput(started)).toEqual(started);
	});
});
