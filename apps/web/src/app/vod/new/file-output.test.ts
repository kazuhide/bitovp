import {
	encodingPlanSchema,
	INTERNAL_HEVC_V2_BCF_VERSION,
	validatePlan,
} from "@bitovp/core";
import { describe, expect, it } from "vitest";
import {
	draftKey,
	readWizardDraft,
	writeWizardDraft,
} from "@/lib/wizard-draft";
import { reconcileAutomaticAudioPackaging } from "./automatic-audio-packaging";
import { buildPlan, type WizardState } from "./build-plan";
import {
	addFile,
	collapseToFileOutput,
	defaultFileNames,
	editFile,
	editFileAudio,
	FILE_CONTAINERS,
	FILE_OUTPUT_DEFAULT_STATE,
	FILE_OUTPUT_FIELD_HOME,
	type FileOutputBlocker,
	fileAudioCodecs,
	fileJobWrites,
	fileOutputBlockers,
	isFileOutputState,
	removeFile,
	renameFileJob,
	sameStreamFiles,
	setFileAudio,
	sharedFileNames,
} from "./file-output";
import { tryImportPresetIntoWizard } from "./plan-to-wizard";
import { addVodVideo } from "./rendition-copy";

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
		// No access is asked for at all. Ticking the box in Destination is what asks.
		expect(planOf(started).muxings[0]?.destination).toEqual({
			outputKey: "origin",
			path: "exports/",
		});
		expect(
			planOf({ ...started, output: { ...started.output, publicRead: true } })
				.muxings[0]?.destination?.acl,
		).toBe("PUBLIC_READ");
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

	it("come back from a saved draft as they were typed, ? and # taken out on the way in", () => {
		const ts = apply(started, editFile(started, 0, { kind: "PROGRESSIVE_TS" }));
		const typed = apply(ts, editFile(ts, 0, { filename: "sub/take#2?.ts" }));
		// A folder in the name is the user's to give; the two characters are not kept.
		expect(typed.videos[0]?.muxing?.filename).toBe("sub/take-2-.ts");

		const key = draftKey(["org", "user"], "vod", "new:file");
		writeWizardDraft(key, "vod", typed, 2);
		const restored = {
			...FILE_OUTPUT_DEFAULT_STATE,
			...(readWizardDraft(key, "vod")?.value as Partial<WizardState>),
		};
		// Without that, the draft would drop the name and the plan would write
		// "output.ts" in its place.
		expect(restored.videos[0]?.muxing?.filename).toBe("sub/take-2-.ts");
		localStorage.removeItem(key);
	});

	it("lose the other two shapes a draft would drop, and keep a colon it keeps", () => {
		const typed = (name: string) =>
			apply(started, editFile(started, 0, { filename: name }));
		const key = draftKey(["org", "user"], "vod", "new:file");
		for (const [name, taken] of [
			["a://b.ts", "a-//b.ts"],
			["clip:v2@1080.ts", "clip-v2@1080.ts"],
			["cut 12:30.mp4", "cut 12:30.mp4"],
		]) {
			const state = typed(name as string);
			expect(state.videos[0]?.muxing?.filename, name).toBe(taken);
			writeWizardDraft(key, "vod", state, 2);
			expect(
				(readWizardDraft(key, "vod")?.value as Partial<WizardState>).videos?.[0]
					?.muxing?.filename,
				name,
			).toBe(taken);
			localStorage.removeItem(key);
		}
		// A job name that reads as a login gives a derived name a draft keeps too.
		expect(defaultFileNames("user:pass@host", started.videos)).toEqual([
			"user-pass@host.mp4",
		]);
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

describe("the containers the flow offers", () => {
	const inContainer = (kind: string) =>
		apply(started, editFile(started, 0, { kind: kind as never }));
	const issuesOf = (state: WizardState) =>
		validatePlan(planOf(state)).map((issue) => issue.code);

	it("are MP4, MPEG-TS and QuickTime, each with the codecs it can hold", () => {
		expect(
			FILE_CONTAINERS.map(({ kind, extension, video, audio }) => ({
				kind,
				extension,
				video,
				audio,
			})),
		).toEqual([
			{
				kind: "MP4",
				extension: "mp4",
				video: ["H264", "H265"],
				audio: ["AAC", "AC3", "EAC3"],
			},
			{
				kind: "PROGRESSIVE_TS",
				extension: "ts",
				video: ["H264"],
				audio: ["AAC"],
			},
			{
				kind: "PROGRESSIVE_MOV",
				extension: "mov",
				video: ["H264"],
				audio: ["AAC"],
			},
		]);
	});

	it.each(
		FILE_CONTAINERS.flatMap((container) =>
			container.video.flatMap((video) =>
				container.audio.map((audio) => [container.kind, video, audio] as const),
			),
		),
	)("%s with %s and %s passes the plan's validation", (kind, video, audio) => {
		const file = apply(started, editFile(started, 0, { kind, codec: video }));
		const state = apply(file, editFileAudio(file, { codec: audio }));
		expect(filesOf(state)).toEqual([
			expect.objectContaining({ kind, streams: ["v1080", "a192"] }),
		]);
		expect(errorsOf(state)).toEqual([]);
	});

	it("say which one no encode has written yet, as the plan's warning does", () => {
		expect(
			FILE_CONTAINERS.map((container) => [
				container.kind,
				container.unmeasured,
				issuesOf(inContainer(container.kind)).includes(
					"PLAN_MUXING_UNMEASURED_KIND",
				),
			]),
		).toEqual([
			["MP4", false, false],
			["PROGRESSIVE_TS", false, false],
			["PROGRESSIVE_MOV", true, true],
		]);
	});

	it("name the file the plan writes when the name is left empty, or none", () => {
		for (const container of FILE_CONTAINERS) {
			const file = inContainer(container.kind);
			const unnamed = apply(file, editFile(file, 0, { filename: "" }));
			const built = encodingPlanSchema.safeParse(buildPlan(unnamed));
			expect([container.kind, built.success]).toEqual([
				container.kind,
				container.fallbackName !== undefined,
			]);
			if (built.success)
				expect(filesOf(unnamed)[0]?.filename).toBe(container.fallbackName);
		}
	});
});

describe("changing a file's container", () => {
	it("changes the extension of a name that follows the job, which goes on following", () => {
		const ts = apply(started, editFile(started, 0, { kind: "PROGRESSIVE_TS" }));
		expect(filesOf(ts)).toEqual([
			{
				kind: "PROGRESSIVE_TS",
				filename: "clip.ts",
				path: "exports/",
				streams: ["v1080", "a192"],
			},
		]);
		expect(errorsOf(ts)).toEqual([]);
		expect(isFileOutputState(ts)).toBe(true);

		const renamed = apply(ts, renameFileJob(ts, "trailer"));
		expect(renamed.videos[0]?.muxing?.filename).toBe("trailer.ts");
	});

	it("keeps the stem of a typed name, and a name without the extension as it is", () => {
		const named = (filename: string) => {
			const typed = apply(started, editFile(started, 0, { filename }));
			return apply(typed, editFile(typed, 0, { kind: "PROGRESSIVE_MOV" }))
				.videos[0]?.muxing?.filename;
		};
		expect(named("final.MP4")).toBe("final.mov");
		expect(named("final")).toBe("final");
	});

	it("moves to a codec the new container can hold", () => {
		const hevc = apply(started, editFile(started, 0, { codec: "H265" }));
		const ts = apply(hevc, editFile(hevc, 0, { kind: "PROGRESSIVE_TS" }));
		expect(ts.videos[0]?.codec).toBe("H264");
		expect(errorsOf(ts)).toEqual([]);
	});

	it("leaves the audio codec to its own field, which offers what every file can hold", () => {
		const ac3 = apply(started, editFileAudio(started, { codec: "AC3" }));
		const ts = apply(ac3, editFile(ac3, 0, { kind: "PROGRESSIVE_TS" }));
		expect(ts.audios[0]?.codec).toBe("AC3");
		expect(fileAudioCodecs(ts.videos)).toEqual(["AAC"]);
		expect(errorsOf(ts).map((issue) => issue.code)).toEqual([
			"PLAN_MUXING_CODEC_MISMATCH",
		]);

		const aac = apply(ts, editFileAudio(ts, { codec: "AAC" }));
		expect(errorsOf(aac)).toEqual([]);
	});

	it("is kept by the next file that is added", () => {
		const ts = apply(started, editFile(started, 0, { kind: "PROGRESSIVE_TS" }));
		const two = apply(ts, addFile(ts));
		expect(filesOf(two).map((file) => [file.kind, file.filename])).toEqual([
			["PROGRESSIVE_TS", "clip.ts"],
			["PROGRESSIVE_TS", "clip-540p.ts"],
		]);
		expect(errorsOf(two)).toEqual([]);
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

		const same = renamed(["clip.mp4", "clip.mp4"]);
		expect(sharedFileNames(same.videos)).toEqual([true, true]);
		expect(collides(same)).toBe(true);
	});

	it("is not read into another spelling of the name, which the plan warns about", () => {
		// One file only if the storage reads both spellings as one path.
		const spelled = renamed(["clip.mp4", "./clip.mp4"]);
		expect(sharedFileNames(spelled.videos)).toEqual([false, false]);
		expect(collides(spelled)).toBe(false);
		expect(
			validatePlan(planOf(spelled))
				.filter((issue) => issue.code === "PLAN_OUTPUT_FILE_COLLISION")
				.map((issue) => issue.level),
		).toEqual(["warning"]);
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

	it("is read into two empty fields of a container that names its own file", () => {
		const ts = two.videos.reduce(
			(state, _video, index) =>
				apply(
					state,
					editFile(state, index, { kind: "PROGRESSIVE_TS", filename: "" }),
				),
			two,
		);
		expect(filesOf(ts).map((file) => file.filename)).toEqual([
			"output.ts",
			"output.ts",
		]);
		expect(sharedFileNames(ts.videos)).toEqual([true, true]);
		expect(collides(ts)).toBe(true);
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

	it("keeps a typed name on the file it was typed for when another is removed", () => {
		const two = apply(started, addFile(started));
		const names = (state: WizardState) =>
			state.videos.map((video) => video.muxing?.filename);

		const second = apply(two, editFile(two, 1, { filename: "proxy.mp4" }));
		expect(names(apply(second, removeFile(second, 0)))).toEqual(["proxy.mp4"]);

		const first = apply(two, editFile(two, 0, { filename: "master.mp4" }));
		expect(names(apply(first, removeFile(first, 1)))).toEqual(["master.mp4"]);
		// The file that is left followed the job name, and is now the first file.
		expect(names(apply(first, removeFile(first, 0)))).toEqual(["clip.mp4"]);
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
		[
			"post-encoding generation of a manifest",
			{ manifests: { hls: true, dash: false }, timing: "POST_ENCODING" },
			["manifests"],
		],
		[
			"post-encoding generation for several encodings",
			{
				sources: { encodings: [{ key: "second", name: "Second encoding" }] },
				timing: "POST_ENCODING",
			},
			["manifests"],
		],
		[
			"a Per-Title configuration",
			{ startOptions: { perTitle: { h264: { minBitrate: 500_000 } } } },
			["perTitle"],
		],
		[
			"a quality gate that holds the manifests back",
			{
				qc: {
					vmaf: true,
					psnr: false,
					model: "vmaf_v0.6.1",
					gate: {
						rules: [{ metric: "VMAF_MEAN", scope: "OVERALL", gte: 80 }],
						onFail: "BLOCK_MANIFESTS",
					},
				},
			},
			["qualityGate"],
		],
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
		[
			"a timestamp offset in an MPEG-TS file",
			{
				videos: [
					{
						...started.videos[0],
						muxing: {
							...started.videos[0]?.muxing,
							kind: "PROGRESSIVE_TS",
							startOffset: 10,
						},
					} as never,
				],
			},
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

	// The two ways the audio can end up outside a file, each caught by its own guard.
	const [track] = started.audios as [WizardState["audios"][number]];

	it("audio written to a file of its own", () => {
		const apart: WizardState = {
			...started,
			audios: [{ ...track, muxing: { ownContainer: true } }],
		};
		expect(planOf(apart).muxings.map((muxing) => muxing.streamKey)).toEqual([
			"v1080",
			"a192",
		]);
		expect(fileOutputBlockers(apart)).toEqual(["packaging"]);
	});

	it("a file that does not carry the audio track", () => {
		const two = apply(started, addFile(started));
		const bare: WizardState = {
			...two,
			videos: two.videos.map((video, index) =>
				index === 1
					? { ...video, muxing: { ...video.muxing, muxedAudioKeys: [] } }
					: video,
			),
		};
		expect(filesOf(bare).map((item) => item.streams)).toEqual([
			["v1080", "a192"],
			["v540"],
		]);
		expect(fileOutputBlockers(bare)).toEqual(["packaging"]);
	});
});

describe("every field of a step the simple view hides", () => {
	const credentialId = "00000000-0000-4000-8000-000000000003";
	// For each field, a job that uses it and the step that edits it.
	const inUse = {
		internal: [
			{ internal: { hevcV2: { bcfVersion: INTERNAL_HEVC_V2_BCF_VERSION } } },
			"basics",
		],
		audioGuard: [{ audioGuard: true }, "ladder"],
		subtitles: [{ subtitles: [{ source: "captions" }] }, "ladder"],
		filters: [{ filters: [{ key: "deinterlace" }] }, "ladder"],
		// Bookkeeping of the filter editor: it means something only beside a filter.
		manualFilterKeys: [
			{ filters: [{ key: "deinterlace" }], manualFilterKeys: ["deinterlace"] },
			"ladder",
		],
		drm: [
			{
				drm: [
					{
						kind: "CENC",
						muxingKey: "v1080",
						credentialId,
						kid: "0".repeat(32),
					},
				],
			},
			"packaging",
		],
		thumbnails: [
			{
				thumbnails: [
					{ key: "thumb", streamKey: "v1080", height: 320, positions: [10] },
				],
			},
			"packaging",
		],
		sprites: [
			{
				sprites: [
					{
						key: "sprite",
						streamKey: "v1080",
						distance: 10,
						filename: "sprite.jpg",
					},
				],
			},
			"packaging",
		],
		manifests: [{ manifests: { hls: true, dash: false } }, "manifests"],
		// Only while there is a manifest to generate.
		timing: [
			{ manifests: { hls: true, dash: false }, timing: "POST_ENCODING" },
			"manifests",
		],
	} satisfies Partial<
		Record<keyof WizardState, [Partial<WizardState>, FileOutputBlocker]>
	>;

	it("has a case here, so a field added to the state cannot go unnoticed", () => {
		expect(Object.keys(inUse).sort()).toEqual(
			Object.entries(FILE_OUTPUT_FIELD_HOME)
				.filter(([, home]) => home !== "shown")
				.map(([field]) => field)
				.sort(),
		);
	});

	it.each(
		Object.entries(inUse),
	)("%s in use holds the full view, and names its step", (field, [
		patch,
		step,
	]) => {
		expect(FILE_OUTPUT_FIELD_HOME[field as keyof WizardState]).toBe(step);
		expect(fileOutputBlockers({ ...started, ...patch })).toEqual([step]);
	});

	it.each([
		[
			"the options of a manifest that is switched off",
			{
				manifests: {
					hls: false,
					dash: false,
					hlsOptions: { audioGroupId: "audio" },
				},
			},
		],
		[
			"filter bookkeeping with no filter",
			{ manualFilterKeys: ["deinterlace"] },
		],
	] satisfies [
		string,
		Partial<WizardState>,
	][])("does not count %s, and clears it on the way back", (_case, patch) => {
		const left: WizardState = { ...started, ...patch };
		expect(planOf(left)).toEqual(planOf(started));
		expect(fileOutputBlockers(left)).toEqual([]);
		expect(collapseToFileOutput(left)).toEqual(started);
	});
});

describe("the Encoding step, which the simple view shows", () => {
	const credentialId = "00000000-0000-4000-8000-000000000003";
	// For each field the step edits, a job that uses it.
	const inUse = {
		labels: { labels: ["team-a"] },
		infrastructure: {
			infrastructure: {
				infrastructureId: "infrastructure",
				cloudRegion: "AWS_EU_WEST_1",
			},
			// The step sets this with it.
			cloudRegion: "EXTERNAL",
		},
		prewarmedEncoderPoolIds: { prewarmedEncoderPoolIds: ["pool"] },
		startOptions: {
			startOptions: {
				handleVariableInputFps: true,
				aiSceneAnalysis: { filename: "analysis.json", path: "" },
			},
		},
		qc: { qc: { vmaf: true, psnr: false, model: "vmaf_v0.6.1" } },
		kantar: {
			kantar: {
				credentialId,
				licenseId: 1,
				channelName: "channel",
				contentReference: "reference",
				serverUrl: "https://kantar.example",
				reportPath: "kantar",
			},
		},
	} satisfies Partial<Record<keyof WizardState, Partial<WizardState>>>;

	it.each(
		Object.entries(inUse),
	)("%s in use is in the plan, does not hold the full view, and stays on the way back", (field, patch) => {
		const used: WizardState = { ...started, ...patch };
		expect(FILE_OUTPUT_FIELD_HOME[field as keyof WizardState]).toBe("shown");
		expect(planOf(used)).not.toEqual(planOf(started));
		expect(errorsOf(used)).toEqual([]);
		expect(fileOutputBlockers(used)).toEqual([]);
		expect(collapseToFileOutput(used)).toEqual(used);
	});

	it("keeps a quality check with both measures unticked: its own controls are there", () => {
		const left: WizardState = {
			...started,
			qc: { vmaf: false, psnr: false, model: "vmaf_v0.6.1" },
		};
		expect(planOf(left)).toEqual(planOf(started));
		expect(fileOutputBlockers(left)).toEqual([]);
		expect(collapseToFileOutput(left).qc).toEqual(left.qc);
	});
});

describe("the Per-Title configuration, which the simple view's Encoding step leaves out", () => {
	const shown = { handleVariableInputFps: true };

	it("holds the full view while it is set, beside the options the step shows", () => {
		const set: WizardState = {
			...started,
			startOptions: { ...shown, perTitle: { h264: { minBitrate: 500_000 } } },
		};
		expect(planOf(set).perTitle).toEqual({
			h264Configuration: { minBitrate: 500_000 },
		});
		expect(fileOutputBlockers(set)).toEqual(["perTitle"]);
		expect(fileOutputBlockers({ ...set, startOptions: shown })).toEqual([]);
	});

	it("holds the full view for a codec switched on with every field left empty", () => {
		// What ticking a codec's box makes. The plan carries the empty block.
		const on: WizardState = {
			...started,
			startOptions: { perTitle: { h264: {} } },
		};
		expect(planOf(on).perTitle).toEqual({ h264Configuration: {} });
		expect(fileOutputBlockers(on)).toEqual(["perTitle"]);
	});

	it("does not count a codec switched off again, and clears only that on the way back", () => {
		// What unticking the box leaves.
		const left: WizardState = {
			...started,
			startOptions: { ...shown, perTitle: { h264: undefined } },
		};
		expect(planOf(left)).toEqual(planOf({ ...started, startOptions: shown }));
		expect(fileOutputBlockers(left)).toEqual([]);
		expect(collapseToFileOutput(left).startOptions).toEqual(shown);
	});

	it("leaves the start options as the flow starts them when it was the only one", () => {
		const left: WizardState = {
			...started,
			startOptions: { perTitle: { h264: undefined } },
		};
		expect(fileOutputBlockers(left)).toEqual([]);
		expect("startOptions" in collapseToFileOutput(left)).toBe(false);
		expect("startOptions" in FILE_OUTPUT_DEFAULT_STATE).toBe(false);
	});

	it("leaves start options alone that hold no Per-Title configuration", () => {
		const options = { encodingMode: undefined };
		const left: WizardState = { ...started, startOptions: options };
		expect(collapseToFileOutput(left).startOptions).toBe(options);
	});
});

describe("a quality gate, which in the simple view records its verdict and no more", () => {
	const rules = [
		{ metric: "VMAF_MEAN" as const, scope: "OVERALL" as const, gte: 80 },
	];
	const gated = (
		onFail: "MARK_ONLY" | "BLOCK_MANIFESTS",
		vmaf = true,
	): WizardState => ({
		...started,
		qc: { vmaf, psnr: false, model: "vmaf_v0.6.1", gate: { rules, onFail } },
	});

	it("is shown there while it only marks the job", () => {
		expect(planOf(gated("MARK_ONLY")).qc?.gate).toEqual({
			rules,
			onFail: "MARK_ONLY",
		});
		expect(errorsOf(gated("MARK_ONLY"))).toEqual([]);
		expect(fileOutputBlockers(gated("MARK_ONLY"))).toEqual([]);
		expect(collapseToFileOutput(gated("MARK_ONLY"))).toEqual(
			gated("MARK_ONLY"),
		);
	});

	it("holds the full view while it holds the manifests back", () => {
		// Refused as the job stands: the remedy is a setting of the Manifests step.
		expect(
			errorsOf(gated("BLOCK_MANIFESTS")).map((issue) => issue.code),
		).toEqual(["PLAN_QC_GATE_BLOCK_JIT"]);
		expect(fileOutputBlockers(gated("BLOCK_MANIFESTS"))).toEqual([
			"qualityGate",
		]);
		// Accepted with that setting, and still not something the simple view shows.
		const after: WizardState = {
			...gated("BLOCK_MANIFESTS"),
			timing: "POST_ENCODING",
		};
		expect(errorsOf(after)).toEqual([]);
		expect(fileOutputBlockers(after)).toEqual(["qualityGate"]);
	});

	it("goes back to marking on the way back, when no measure is ticked to act on it", () => {
		const idle = gated("BLOCK_MANIFESTS", false);
		expect(planOf(idle)).toEqual(planOf(started));
		expect(fileOutputBlockers(idle)).toEqual([]);
		const back = collapseToFileOutput(idle);
		expect(back.qc).toEqual(gated("MARK_ONLY", false).qc);
		// Ticking a measure in the simple view brings back a gate that can be met.
		expect(errorsOf({ ...back, qc: gated("MARK_ONLY").qc })).toEqual([]);
	});
});

describe("a job that only measures", () => {
	const measuring: WizardState = {
		...started,
		qc: { vmaf: true, psnr: false, model: "vmaf_v0.6.1", only: true },
	};

	it("builds a plan of the video alone, with nothing left to carry", () => {
		// The file carries the audio track, and the plan leaves that track out.
		expect(filesOf(started)[0]?.streams).toEqual(["v1080", "a192"]);
		expect(planOf(measuring).renditions.map((item) => item.key)).toEqual([
			"v1080",
		]);
		expect(filesOf(measuring)[0]?.streams).toEqual(["v1080"]);
		expect(errorsOf(measuring)).toEqual([]);
		expect(fileOutputBlockers(measuring)).toEqual([]);
	});

	// "VMAF only" keeps what it holds back, and the simple view can untick it.
	it.each([
		["a manifest", { manifests: { hls: true, dash: false } }, "manifests"],
		[
			"a thumbnail",
			{
				thumbnails: [
					{ key: "thumb", streamKey: "v1080", height: 320, positions: [10] },
				],
			},
			"packaging",
		],
		["a subtitle", { subtitles: [{ source: "captions" }] }, "ladder"],
	] satisfies [
		string,
		Partial<WizardState>,
		FileOutputBlocker,
	][])("%s it holds back still holds the full view", (_case, patch, step) => {
		const held: WizardState = { ...measuring, ...patch };
		// Not in the plan as it stands...
		expect(JSON.stringify(buildPlan(held))).toBe(
			JSON.stringify(buildPlan(measuring)),
		);
		// ...and in it the moment the option is unticked.
		const unticked = { vmaf: true, psnr: false, model: "vmaf_v0.6.1" };
		const lifted: WizardState = { ...held, qc: unticked };
		expect(JSON.stringify(buildPlan(lifted))).not.toBe(
			JSON.stringify(buildPlan({ ...measuring, qc: unticked })),
		);
		expect(fileOutputBlockers(held)).toEqual([step]);
		expect(fileOutputBlockers(lifted)).toEqual([step]);
	});
});

describe("what the Review step lists", () => {
	const writes = (state: WizardState) =>
		fileJobWrites(planOf(state), state.output.bucket).map(
			(item) => `${item.kind} ${item.path}`,
		);

	it("lists each file by where it lands", () => {
		const two = apply(started, addFile(started));
		expect(writes(started)).toEqual(["file out/exports/clip.mp4"]);
		expect(writes(two)).toEqual([
			"file out/exports/clip.mp4",
			"file out/exports/clip-540p.mp4",
		]);
	});

	it("adds the result of AI Scene Analysis, in the folder or below it", () => {
		const analysed = (path: string): WizardState => ({
			...started,
			startOptions: { aiSceneAnalysis: { filename: "analysis.json", path } },
		});
		expect(writes(analysed(""))).toEqual([
			"file out/exports/clip.mp4",
			"analysis out/exports/analysis.json",
		]);
		expect(writes(analysed("ai"))).toEqual([
			"file out/exports/clip.mp4",
			"analysis out/exports/ai/analysis.json",
		]);
	});

	it("adds one folder for the copies a quality check measures, however many files", () => {
		const two = apply(started, addFile(started));
		const measured: WizardState = {
			...two,
			qc: { vmaf: true, psnr: false, model: "vmaf_v0.6.1" },
		};
		expect(writes(measured)).toEqual([
			"file out/exports/clip.mp4",
			"file out/exports/clip-540p.mp4",
			"qcMirror out/exports/qc/",
		]);
	});

	it("lists no file for a job that only measures, and no analysis", () => {
		const measuring: WizardState = {
			...started,
			startOptions: {
				aiSceneAnalysis: { filename: "analysis.json", path: "" },
			},
			qc: { vmaf: true, psnr: false, model: "vmaf_v0.6.1", only: true },
		};
		expect(planOf(measuring).muxings).toHaveLength(1);
		expect(writes(measuring)).toEqual(["qcMirror out/exports/qc/"]);
	});

	it("adds the folder of the Kantar report", () => {
		const marked: WizardState = {
			...started,
			kantar: {
				credentialId: "00000000-0000-4000-8000-000000000003",
				licenseId: 1,
				channelName: "channel",
				contentReference: "reference",
				serverUrl: "https://kantar.example",
				reportPath: "kantar",
			},
		};
		expect(writes(marked)).toEqual([
			"file out/exports/clip.mp4",
			"kantarReport out/exports/kantar/",
		]);
	});

	it("names no bucket where the storage has none", () => {
		const plan = planOf({
			...started,
			qc: { vmaf: true, psnr: false, model: "vmaf_v0.6.1" },
		});
		expect(fileJobWrites(plan, "").map((item) => item.path)).toEqual([
			"exports/clip.mp4",
			"exports/qc/",
		]);
	});

	it("gives every entry a key of its own", () => {
		const two = apply(started, addFile(started));
		const all = fileJobWrites(
			planOf({
				...two,
				startOptions: {
					aiSceneAnalysis: { filename: "analysis.json", path: "" },
				},
				qc: { vmaf: true, psnr: false, model: "vmaf_v0.6.1" },
			}),
			"out",
		);
		expect(all).toHaveLength(4);
		expect(new Set(all.map((item) => item.key)).size).toBe(4);
	});
});

describe("when the manifests are generated, in a job that generates none", () => {
	// The full view moves it without being asked (a rendition entering Per-Title, a
	// manifest's generation mode) and shows its control only while a manifest is on.
	const left: WizardState = { ...started, timing: "POST_ENCODING" };

	it("is in the plan, and says nothing there", () => {
		expect(planOf(left).generation.timing).toBe("POST_ENCODING");
		expect(planOf(started).generation.timing).toBe("JUST_IN_TIME");
		expect(planOf(left).manifests).toEqual([]);
		expect({
			...planOf(left),
			generation: planOf(started).generation,
		}).toEqual(planOf(started));
	});

	it("does not hold the full view, and is put back on the way back", () => {
		expect(fileOutputBlockers(left)).toEqual([]);
		expect(collapseToFileOutput(left)).toEqual(started);
	});
});

describe("files the plan cannot tell apart", () => {
	const second = (edit: Parameters<typeof editFile>[2]) => {
		const two = apply(started, addFile(started));
		return apply(two, editFile(two, 1, edit));
	};
	const duplicates = (state: WizardState) =>
		validatePlan(planOf(state)).filter(
			(issue) => issue.code === "PLAN_DUPLICATE_KEY",
		).length;

	it("are marked on both, where the plan is refused for a key it names twice", () => {
		// The same video once as MP4 and once as QuickTime.
		const same = second({
			height: 1080,
			bitrate: 8_000_000,
			kind: "PROGRESSIVE_MOV",
		});
		expect(same.videos.map((video) => video.muxing?.filename)).toEqual([
			"clip.mp4",
			"clip-1080p.mov",
		]);
		expect(sameStreamFiles(same.videos)).toEqual([true, true]);
		expect(duplicates(same)).toBeGreaterThan(0);
	});

	it("are told apart by the bitrate in kbps, not by the number typed", () => {
		// 8,000,400 rounds to the 8000 kbps the first file has. 8,000,500 does not.
		const near = second({ height: 1080, bitrate: 8_000_400 });
		expect(sameStreamFiles(near.videos)).toEqual([true, true]);
		expect(duplicates(near)).toBeGreaterThan(0);
		const apart = second({ height: 1080, bitrate: 8_000_500 });
		expect(sameStreamFiles(apart.videos)).toEqual([false, false]);
		expect(duplicates(apart)).toBe(0);
	});

	it.each([
		["the height", { height: 720, bitrate: 8_000_000 }],
		["the bitrate", { height: 1080, bitrate: 7_999_000 }],
		["the codec", { height: 1080, bitrate: 8_000_000, codec: "H265" }],
		["the source's own height", { height: null, bitrate: 8_000_000 }],
	] satisfies [
		string,
		Parameters<typeof editFile>[2],
	][])("are apart once %s differs", (_case, edit) => {
		const apart = second(edit);
		expect(sameStreamFiles(apart.videos)).toEqual([false, false]);
		expect(duplicates(apart)).toBe(0);
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

	it("is allowed after the ladder added a rendition beside two files of one height", () => {
		// Files of one height are keyed by their bitrate as well, and the ladder
		// writes its key into every row as soon as one is added.
		const two = apply(started, addFile(started));
		const twins = apply(two, editFile(two, 1, { height: 1080 }));
		const added = apply(twins, addVodVideo(twins));
		const removed = apply(added, { videos: added.videos.slice(0, 2) });
		expect(removed.videos.map((video) => video.extras?.key)).toEqual([
			"v1080_8000k",
			"v1080_2000k",
		]);
		expect(planOf(removed)).toEqual(planOf(twins));
		expect(fileOutputBlockers(removed)).toEqual([]);
		expect(collapseToFileOutput(removed)).toEqual(twins);
	});

	describe("with a copy the ladder made of a file", () => {
		type Video = WizardState["videos"][number];
		const placed = (state: WizardState, edit: Partial<Video> = {}) => {
			const [first, second] = state.videos as [Video, Video];
			// What Packaging stores when the copy's path is deleted and its file named.
			const muxing = {
				...second.muxing,
				path: "",
				autoPath: undefined,
				filename: "clip-b.mp4",
			};
			return apply(state, { videos: [first, { ...second, ...edit, muxing }] });
		};
		const places = (state: WizardState) =>
			filesOf(state).map(({ streams: _streams, ...file }) => file);
		// "Add video" on a row copies it and numbers the copy's key.
		const copied = placed(apply(started, addVodVideo(started, 0)));

		it("is a job the full view accepts, with the two keys numbered apart", () => {
			expect(copied.videos.map((video) => video.extras?.key)).toEqual([
				"v1080",
				"v1080-2",
			]);
			expect(errorsOf(copied)).toEqual([]);
			expect(fileOutputBlockers(copied)).toEqual([]);
		});

		it("keeps the copy's number, so the job is the same one in the simple view", () => {
			const collapsed = collapseToFileOutput(copied);
			expect(collapsed.videos.map((video) => video.extras?.key)).toEqual([
				undefined,
				"v1080-2",
			]);
			expect(collapsed.videos.map((video) => video.muxing?.key)).toEqual([
				undefined,
				undefined,
			]);
			expect(planOf(collapsed)).toEqual(planOf(copied));
			expect(errorsOf(collapsed)).toEqual([]);
			expect(sameStreamFiles(collapsed.videos)).toEqual([false, false]);
			expect(fileOutputBlockers(collapsed)).toEqual([]);
			expect(collapseToFileOutput(collapsed)).toEqual(collapsed);
		});

		it("numbers a file whose own key another file could derive", () => {
			// Keys written while the bitrates differed, which then became equal.
			const two = apply(started, addFile(started));
			const twins = apply(two, editFile(two, 1, { height: 1080 }));
			const added = apply(twins, addVodVideo(twins));
			const keyed = apply(added, { videos: added.videos.slice(0, 2) });
			const [first, second] = keyed.videos as [Video, Video];
			const equal = apply(keyed, {
				videos: [first, { ...second, bitrate: 8_000_000 }],
			});
			expect(equal.videos.map((video) => video.extras?.key)).toEqual([
				"v1080_8000k",
				"v1080_2000k",
			]);
			expect(errorsOf(equal)).toEqual([]);
			expect(fileOutputBlockers(equal)).toEqual([]);

			const collapsed = collapseToFileOutput(equal);
			// `v1080_2000k` is what a third file of 2 Mbps would derive.
			expect(collapsed.videos.map((video) => video.extras?.key)).toEqual([
				undefined,
				"v1080_8000k_h264-2",
			]);
			expect(places(collapsed)).toEqual(places(equal));
			expect(filesOf(collapsed).map((file) => file.streams[0])).toEqual([
				"v1080",
				"v1080_8000k_h264-2",
			]);
			expect(errorsOf(collapsed)).toEqual([]);
			expect(collapseToFileOutput(collapsed)).toEqual(collapsed);
		});

		it("takes a number no other file has", () => {
			const added = apply(copied, addVodVideo(copied, 0));
			const three = added.videos as [Video, Video, Video];
			// The third file's own key is the one the second is given before it.
			const taken = apply(added, {
				videos: [
					three[0],
					{ ...three[1], extras: { key: "v1080_4000k" } },
					{
						...three[2],
						extras: { key: "v1080_8000k_h264-2" },
						muxing: {
							...three[2].muxing,
							key: undefined,
							path: "",
							autoPath: undefined,
							filename: "clip-c.mp4",
						},
					},
				],
			});
			expect(errorsOf(taken)).toEqual([]);
			const collapsed = collapseToFileOutput(taken);
			expect(collapsed.videos.map((video) => video.extras?.key)).toEqual([
				undefined,
				"v1080_8000k_h264-2",
				"v1080_8000k_h264-3",
			]);
			expect(errorsOf(collapsed)).toEqual([]);
			expect(places(collapsed)).toEqual(places(taken));
		});

		it("leaves files that had one key between them to be refused, as they were", () => {
			const [first, second] = copied.videos as [Video, Video];
			const twice = apply(copied, {
				videos: [first, { ...second, extras: { key: "v1080" } }],
			});
			const refused = (state: WizardState) =>
				validatePlan(planOf(state)).some(
					(issue) => issue.code === "PLAN_DUPLICATE_KEY",
				);
			expect(refused(twice)).toBe(true);
			const collapsed = collapseToFileOutput(twice);
			expect(collapsed.videos.map((video) => video.extras?.key)).toEqual([
				undefined,
				undefined,
			]);
			expect(refused(collapsed)).toBe(true);
			expect(sameStreamFiles(collapsed.videos)).toEqual([true, true]);

			// Two files made equal in the simple view are not parted by a visit either.
			const two = apply(started, addFile(started));
			const same = apply(two, editFile(two, 1, { height: 1080 }));
			const equal = apply(same, editFile(same, 1, { bitrate: 8_000_000 }));
			expect(sameStreamFiles(equal.videos)).toEqual([true, true]);
			expect(collapseToFileOutput(equal)).toEqual(equal);
		});
	});

	it.each([
		"v1080",
		"v1080_8000k",
		"v1080_8000k_h265",
		"video2",
		"v1080-2",
		"v1080_8000k-3",
	])("derives a key the editors wrote again, wherever it came from: %s", (key) => {
		const [file] = started.videos as [WizardState["videos"][number]];
		// No token says the ladder wrote it: a saved template keeps only the key.
		const keyed: WizardState = {
			...started,
			videos: [{ ...file, extras: { key }, muxing: { ...file.muxing, key } }],
		};
		expect(fileOutputBlockers(keyed)).toEqual([]);
		expect(collapseToFileOutput(keyed)).toEqual(started);
	});

	it("leaves a key a loaded plan chose where it is, and is not held by it", () => {
		const [file] = started.videos as [WizardState["videos"][number]];
		const [track] = started.audios as [WizardState["audios"][number]];
		// No step has a field for a key, so there is nothing to send anyone to.
		const chosen: WizardState = {
			...started,
			audios: [{ ...track, extras: { key: "aac" } }],
			videos: [
				{
					...file,
					extras: { key: "mezz" },
					muxing: {
						...file.muxing,
						key: "mezz-file",
						muxedAudioKeys: ["aac"],
					},
				},
			],
		};
		expect(fileOutputBlockers(chosen)).toEqual([]);
		expect(collapseToFileOutput(chosen)).toEqual(chosen);
		expect(planOf(chosen).muxings.map((muxing) => muxing.key)).toEqual([
			"mezz-file",
		]);
		expect(filesOf(chosen)[0]?.streams).toEqual(["mezz", "aac"]);

		// The track's key is the one each file goes on naming after an edit here.
		const louder = apply(chosen, editFileAudio(chosen, { bitrate: 320_000 }));
		expect(filesOf(louder)[0]?.streams).toEqual(["mezz", "aac"]);
		// A container keyed as its stream is was keyed by the editors, not chosen.
		const [video] = chosen.videos as [WizardState["videos"][number]];
		const followed: WizardState = {
			...chosen,
			videos: [{ ...video, muxing: { ...video.muxing, key: "mezz" } }],
		};
		expect(
			collapseToFileOutput(followed).videos[0]?.muxing?.key,
		).toBeUndefined();
		expect(planOf(collapseToFileOutput(followed))).toEqual(planOf(followed));
	});
});

describe("a plan this flow built, loaded again", () => {
	// Ids that do not read as a sample's placeholders, which a load would clear.
	const accountId = "33333333-3333-4333-8333-333333333333";
	const credentialId = "44444444-4444-4444-8444-444444444444";
	const loaded = (state: WizardState) => {
		const built: WizardState = {
			...state,
			accountId,
			inputFiles: state.inputFiles.map((input) => ({ ...input, credentialId })),
			output: { ...state.output, credentialId },
		};
		const mapping = tryImportPresetIntoWizard(
			JSON.parse(JSON.stringify(planOf(built))),
		);
		if (!mapping.ok) throw new Error(mapping.reasonKey);
		return { built, state: mapping.state };
	};
	const two = apply(started, addFile(started));

	it.each([
		["one MP4", started],
		["two files", two],
		[
			"an MPEG-TS file",
			apply(started, editFile(started, 0, { kind: "PROGRESSIVE_TS" })),
		],
		["no audio", apply(started, setFileAudio(started, false))],
	])("%s opens in the simple view, with its folder as the destination", (_case, job) => {
		const { built, state } = loaded(job);
		expect(state.output.basePath).toBe("exports/");
		expect(fileOutputBlockers(state)).toEqual([]);
		expect(planOf(collapseToFileOutput(state))).toEqual(planOf(built));
	});

	it("moves with the destination, as a job made here does", () => {
		const { state } = loaded(two);
		const moved = collapseToFileOutput({
			...state,
			output: { ...state.output, basePath: "archive" },
		});
		expect(filesOf(moved).map((item) => item.path)).toEqual([
			"archive/",
			"archive/",
		]);
	});

	it("keeps whole paths when its files do not share one folder", () => {
		const [first, second] = two.videos as WizardState["videos"];
		const { state } = loaded({
			...two,
			videos: [
				first,
				{ ...second, muxing: { ...second?.muxing, path: "proxy" } },
			] as WizardState["videos"],
		});
		expect(state.output.basePath).toBe("");
		expect(state.videos.map((video) => video.muxing?.path)).toEqual([
			"exports/",
			"exports/proxy",
		]);
	});
});
