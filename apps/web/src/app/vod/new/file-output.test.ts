import {
	encodingPlanSchema,
	INTERNAL_HEVC_V2_BCF_VERSION,
	MUXING_CODEC_MATRIX,
	validatePlan,
} from "@bitovp/core";
import { describe, expect, it } from "vitest";
import {
	draftKey,
	readWizardDraft,
	writeWizardDraft,
} from "@/lib/wizard-draft";
import { AUDIO_CHANNEL_LAYOUTS } from "./audio-channel-layouts";
import {
	followRenamedAudioKeys,
	reconcileAutomaticAudioPackaging,
} from "./automatic-audio-packaging";
import { buildPlan, type WizardState } from "./build-plan";
import {
	addFile,
	bcfOverrideAlone,
	collapseToFileOutput,
	defaultFileNames,
	editFile,
	editFileAudio,
	FILE_CONTAINERS,
	FILE_OUTPUT_DEFAULT_STATE,
	FILE_OUTPUT_FIELD_HOME,
	type FileOutputBlocker,
	fileAudios,
	fileCaveats,
	fileJobFolder,
	fileJobWrites,
	fileOutputBlockers,
	filesNeedOneMode,
	hevcV2Lacks,
	hevcV2NotAlone,
	isFileOutputState,
	lacksAtmosSource,
	readsAtmosStream,
	removeFile,
	renameFileJob,
	sameStreamFiles,
	setFileAudio,
	sharedFileNames,
} from "./file-output";
import { tryImportPresetIntoWizard } from "./plan-to-wizard";
import { AUDIO_CODECS, VIDEO_CODECS } from "./rendition-codecs";
import { addVodVideo } from "./rendition-copy";

/**
 * What the wizard's `patch` does with an edit: merge it, let the files follow an
 * audio key that the edit renamed, then reconcile the audio rows.
 */
function apply(state: WizardState, patch: Partial<WizardState>): WizardState {
	const next = { ...state, ...patch };
	Object.assign(next, followRenamedAudioKeys(state, next));
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

const atmosSource: WizardState["sources"] = {
	dolbyStreams: [
		{ kind: "ATMOS", key: "atmos", inputFile: "main", inputFormat: "ADM" },
	],
};

describe("the containers the flow offers", () => {
	const inContainer = (kind: string) =>
		apply(started, editFile(started, 0, { kind: kind as never }));
	const issuesOf = (state: WizardState) =>
		validatePlan(planOf(state)).map((issue) => issue.code);

	it("are MP4, MPEG-TS, QuickTime and WebM, each with every codec it can hold", () => {
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
				video: ["H264", "H265", "AV1"],
				audio: ["AAC", "AC3", "EAC3", "OPUS", "DOLBY_ATMOS", "DDPLUS", "DD"],
			},
			{
				kind: "PROGRESSIVE_TS",
				extension: "ts",
				video: ["H264", "H265"],
				audio: ["AAC", "AC3", "EAC3", "DDPLUS", "DD"],
			},
			{
				kind: "PROGRESSIVE_MOV",
				extension: "mov",
				video: ["H264", "H265"],
				audio: ["AAC", "AC3", "DD"],
			},
			{
				kind: "PROGRESSIVE_WEBM",
				extension: "webm",
				video: ["VP9", "AV1"],
				audio: ["OPUS"],
			},
		]);
	});

	it("hold every codec of the ladder step that the plan accepts in them, and between them every codec it has", () => {
		for (const container of FILE_CONTAINERS) {
			const row: readonly string[] = MUXING_CODEC_MATRIX[container.kind];
			expect(container.video, container.kind).toEqual(
				VIDEO_CODECS.filter((codec) => row.includes(codec)),
			);
			expect(container.audio, container.kind).toEqual(
				AUDIO_CODECS.filter((codec) => row.includes(codec)),
			);
		}
		const offered = (pick: "video" | "audio") =>
			new Set<string>(FILE_CONTAINERS.flatMap((container) => container[pick]));
		expect(offered("video")).toEqual(new Set(VIDEO_CODECS));
		expect(offered("audio")).toEqual(new Set(AUDIO_CODECS));
	});

	it.each(
		FILE_CONTAINERS.flatMap((container) =>
			container.video.flatMap((video) =>
				container.audio.map((audio) => [container.kind, video, audio] as const),
			),
		),
	)("%s with %s and %s passes the plan's validation", (kind, video, audio) => {
		const file = apply(started, editFile(started, 0, { kind, codec: video }));
		// Dolby Atmos is encoded from an Atmos source, which the Sources step adds.
		const state =
			audio === "DOLBY_ATMOS"
				? apply(
						{ ...file, sources: atmosSource },
						editFileAudio(file, 0, { codec: audio, source: "atmos" }),
					)
				: apply(file, editFileAudio(file, 0, { codec: audio }));
		expect(filesOf(state)).toEqual([
			expect.objectContaining({ kind, streams: ["v1080", "a192"] }),
		]);
		expect(errorsOf(state)).toEqual([]);
	});

	it("say of a Dolby Atmos track that it has no Atmos source, where the plan would be refused for it", () => {
		const atmos = apply(
			started,
			editFileAudio(started, 0, { codec: "DOLBY_ATMOS" }),
		);
		const lacking = (state: WizardState) =>
			lacksAtmosSource(state, fileAudios(state)[0]);
		const refused = (state: WizardState) =>
			errorsOf(state).map((issue) => issue.code);

		expect(lacking(started)).toBe(false);
		expect([lacking(atmos), refused(atmos)]).toEqual([
			true,
			["PLAN_STREAM_SOURCE_MISMATCH"],
		]);
		// A source is not enough: the track has to read it.
		const added = { ...atmos, sources: atmosSource };
		expect([lacking(added), refused(added)]).toEqual([
			true,
			["PLAN_STREAM_SOURCE_MISMATCH"],
		]);
		const read = apply(added, editFileAudio(added, 0, { source: "atmos" }));
		expect([lacking(read), refused(read)]).toEqual([false, []]);
	});

	it.each(
		FILE_CONTAINERS.flatMap((container) =>
			container.video.flatMap((video) =>
				[undefined, ...container.audio].map(
					(audio) => [container.kind, video, audio] as const,
				),
			),
		),
	)("say of %s with %s and %s what the plan's warnings say, and nothing more", (kind, video, audio) => {
		const file = apply(started, editFile(started, 0, { kind, codec: video }));
		const state =
			audio === undefined
				? apply(file, setFileAudio(file, 0, false))
				: apply(
						{ ...file, sources: atmosSource },
						editFileAudio(file, 0, {
							codec: audio,
							...(audio === "DOLBY_ATMOS" ? { source: "atmos" } : {}),
						}),
					);
		const caveats = fileCaveats(
			state.videos[0] as WizardState["videos"][number],
			fileAudios(state)[0],
		);
		const warned = (code: string) =>
			validatePlan(planOf(state)).some((issue) => issue.code === code);
		expect({
			unmeasured: caveats.includes("unmeasured"),
			unverified:
				caveats.includes("unverifiedVideo") ||
				caveats.includes("unverifiedAudio"),
			besideAv1: caveats.includes("av1WebmAudio"),
			notHeld:
				caveats.includes("audioNotHeld") || caveats.includes("videoNotHeld"),
		}).toEqual({
			unmeasured: warned("PLAN_MUXING_UNMEASURED_KIND"),
			unverified: warned("PLAN_MUXING_UNVERIFIED_CODEC"),
			besideAv1: warned("PLAN_MUXING_AV1_NOT_ALONE"),
			notHeld: false,
		});
		expect(errorsOf(state)).toEqual([]);
	});

	it("say something of the pairs this was written for, so the comparison above is not of nothing", () => {
		const said = (
			kind: (typeof FILE_CONTAINERS)[number]["kind"],
			video: WizardState["videos"][number]["codec"],
			audio: WizardState["audios"][number]["codec"],
		) => {
			const file = apply(started, editFile(started, 0, { kind, codec: video }));
			const state = apply(file, editFileAudio(file, 0, { codec: audio }));
			return fileCaveats(
				state.videos[0] as WizardState["videos"][number],
				fileAudios(state)[0],
			);
		};
		expect(said("MP4", "AV1", "AAC")).toEqual([]);
		expect(said("MP4", "H264", "OPUS")).toEqual(["unverifiedAudio"]);
		expect(said("PROGRESSIVE_TS", "H265", "EAC3")).toEqual(["unverifiedAudio"]);
		expect(said("PROGRESSIVE_TS", "H265", "DDPLUS")).toEqual([]);
		expect(said("PROGRESSIVE_MOV", "H264", "AC3")).toEqual([
			"unmeasured",
			"unverifiedAudio",
		]);
		expect(said("PROGRESSIVE_WEBM", "VP9", "OPUS")).toEqual(["unmeasured"]);
		expect(said("PROGRESSIVE_WEBM", "AV1", "OPUS")).toEqual([
			"unmeasured",
			"av1WebmAudio",
		]);
	});

	it("say of a track that leaves Dolby Atmos nothing, because it leaves the Atmos stream with the codec", () => {
		const withSource = { ...started, sources: atmosSource };
		const atmos = apply(
			withSource,
			editFileAudio(withSource, 0, { codec: "DOLBY_ATMOS", source: "atmos" }),
		);
		expect(errorsOf(atmos)).toEqual([]);
		const left = [
			// MPEG-TS holds no Dolby Atmos: the track goes on in AAC.
			apply(atmos, editFile(atmos, 0, { kind: "PROGRESSIVE_TS" })),
			apply(atmos, editFileAudio(atmos, 0, { codec: "AAC" })),
		];
		for (const state of left) {
			expect(state.audios).toEqual([
				expect.objectContaining({ codec: "AAC", bitrate: 192_000 }),
			]);
			expect(state.audios[0]?.extras).toBeUndefined();
			expect(errorsOf(state)).toEqual([]);
			expect(readsAtmosStream(state, fileAudios(state)[0])).toBe(false);
		}
		// Another source is the user's, and stays through a change of codec.
		const other = apply(
			withSource,
			editFileAudio(withSource, 0, { source: "trimmed" }),
		);
		const there = apply(
			other,
			editFileAudio(other, 0, { codec: "DOLBY_ATMOS" }),
		);
		const back = apply(there, editFileAudio(there, 0, { codec: "AC3" }));
		expect(back.audios[0]).toMatchObject({
			codec: "AC3",
			extras: { source: "trimmed" },
		});
	});

	it("say of a track in another codec that it reads a Dolby Atmos stream, where the plan is refused for it", () => {
		const withSource = { ...started, sources: atmosSource };
		const misread = (state: WizardState) =>
			readsAtmosStream(state, fileAudios(state)[0]);
		const refused = (state: WizardState) =>
			errorsOf(state).map((issue) => issue.code);
		expect([misread(withSource), refused(withSource)]).toEqual([false, []]);
		const aac = apply(
			withSource,
			editFileAudio(withSource, 0, { source: "atmos" }),
		);
		expect([misread(aac), refused(aac)]).toEqual([
			true,
			["PLAN_STREAM_SOURCE_MISMATCH"],
		]);
		// The same source is what a Dolby Atmos track reads.
		const atmos = apply(aac, editFileAudio(aac, 0, { codec: "DOLBY_ATMOS" }));
		expect([misread(atmos), refused(atmos)]).toEqual([false, []]);
		// No audio, nothing to say.
		expect(readsAtmosStream(withSource, undefined)).toBe(false);
	});

	it.each(
		FILE_CONTAINERS.flatMap((container) =>
			VIDEO_CODECS.map((codec) => [container.kind, codec] as const),
		),
	)("say of %s with %s that it cannot hold the codec exactly where the plan is refused for it", (kind, codec) => {
		// No edit of the format screen leaves a file here: the Ladder step does.
		const moved = apply(started, editFile(started, 0, { kind }));
		const silent = apply(moved, setFileAudio(moved, 0, false));
		const state: WizardState = {
			...silent,
			videos: silent.videos.map((video) => ({ ...video, codec })),
		};
		const container = FILE_CONTAINERS.find((item) => item.kind === kind);
		const held = container?.video.includes(codec) === true;
		expect([
			fileCaveats(
				state.videos[0] as WizardState["videos"][number],
				undefined,
			).includes("videoNotHeld"),
			errorsOf(state).map((issue) => [issue.code, issue.path]),
		]).toEqual([
			!held,
			held ? [] : [["PLAN_MUXING_CODEC_MISMATCH", "muxings[0].streamKey"]],
		]);
	});

	it.each(
		FILE_CONTAINERS.filter((container) =>
			container.video.includes("H265"),
		).flatMap((container) =>
			(
				[
					"DOLBY_VISION",
					"DOLBY_VISION_PROFILE_5",
					"DOLBY_VISION_PROFILE_8_1",
					"HDR10",
					"HLG",
					"SDR",
					undefined,
				] as const
			).map((format) => [container.kind, format] as const),
		),
	)("say of %s with H.265 in %s what the plan's warning says of Dolby Vision", (kind, dynamicRangeFormat) => {
		const moved = apply(started, editFile(started, 0, { kind, codec: "H265" }));
		const state = apply(
			moved,
			editFile(moved, 0, { h265: { dynamicRangeFormat } }),
		);
		const said = fileCaveats(
			state.videos[0] as WizardState["videos"][number],
			fileAudios(state)[0],
		).includes("unverifiedDolbyVision");
		expect([
			said,
			validatePlan(planOf(state)).some(
				(issue) => issue.code === "PLAN_MUXING_UNVERIFIED_CODEC",
			),
		]).toEqual([said, said]);
		expect(said).toBe(
			kind !== "MP4" && dynamicRangeFormat?.startsWith("DOLBY_VISION") === true,
		);
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
			["PROGRESSIVE_WEBM", true, true],
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

describe("files in more than one video codec", () => {
	const MIXED = "PLAN_ENCODING_MODE_UNPINNED_FOR_MIXED_CODECS";
	const two = apply(started, addFile(started));
	const webm = apply(two, editFile(two, 1, { kind: "PROGRESSIVE_WEBM" }));
	const moded = (
		state: WizardState,
		modes: (WizardState["videos"][number]["encodingMode"] | undefined)[],
	) =>
		modes.reduce(
			(next, encodingMode, index) =>
				apply(next, editFile(next, index, { encodingMode })),
			state,
		);
	const refused = (state: WizardState) =>
		errorsOf(state).some((issue) => issue.code === MIXED);

	it.each([
		["one codec, no mode", two, false],
		["two codecs, no mode", webm, true],
		["two codecs, a mode on one file", moded(webm, ["TWO_PASS"]), true],
		["two codecs, two modes", moded(webm, ["TWO_PASS", "SINGLE_PASS"]), true],
		["two codecs, one mode", moded(webm, ["TWO_PASS", "TWO_PASS"]), false],
	] as const)("are said to need one mode where the plan is refused for it: %s", (_, state, needs) => {
		expect([filesNeedOneMode(state), refused(state)]).toEqual([needs, needs]);
	});

	it("are said to be no job for HEVCv2, which takes every file and its switch, where no plan is built", () => {
		const v2 = (state: WizardState, index: number) =>
			apply(state, editFile(state, index, { codec: "H265V2" }));
		const built = (state: WizardState) => {
			try {
				buildPlan(state);
				return true;
			} catch {
				return false;
			}
		};
		const one = v2(two, 0);
		const both = v2(one, 1);
		const switchedOff = { ...both, internal: undefined };
		// The switch alone, with no file in HEVCv2: no plan either, and nothing for
		// a file's codec to say — the switch is in Basics.
		const switchOnly = { ...two, internal: both.internal };
		expect(both.internal).toEqual({
			hevcV2: { bcfVersion: INTERNAL_HEVC_V2_BCF_VERSION },
		});
		expect(
			[two, one, both, switchedOff, switchOnly].map((state) => [
				hevcV2NotAlone(state),
				built(state),
				// The other message is not for these: the mode is not what is wrong.
				filesNeedOneMode(state),
			]),
		).toEqual([
			[false, true, false],
			[true, false, false],
			[false, true, false],
			[true, false, false],
			[false, false, false],
		]);
		expect(errorsOf(both)).toEqual([]);
	});

	it("leave behind, with HEVCv2, the settings only it has, and keep the rest of H.265's", () => {
		const v2 = apply(two, {
			...editFile(two, 0, { codec: "H265V2" }),
		});
		const tuned = apply(
			v2,
			editFile(v2, 0, {
				h265: {
					crf: 24,
					motionCompensatedTemporalFiltering: "ON",
				} as never,
			}),
		);
		const webm = apply(tuned, editFile(tuned, 0, { kind: "PROGRESSIVE_WEBM" }));
		expect(webm.videos[0]).toMatchObject({ codec: "VP9", h265: { crf: 24 } });
		expect(webm.videos[0]?.encodingMode).toBeUndefined();
		expect(webm.internal).toBeUndefined();
		// Left in, the plan could not be built at all.
		expect(() => buildPlan(webm)).not.toThrow();
		// To H.265 it goes as a ladder rendition does, with all of them.
		const hevc = apply(tuned, editFile(tuned, 0, { codec: "H265" }));
		expect(hevc.videos[0]?.h265).toEqual({
			crf: 24,
			motionCompensatedTemporalFiltering: "ON",
		});
	});

	it("are said to lack the height or the bitrate HEVCv2 needs, where the plan is refused for it", () => {
		const v2 = apply(started, editFile(started, 0, { codec: "H265V2" }));
		const lacks = (state: WizardState) =>
			hevcV2Lacks(state.videos[0] as WizardState["videos"][number]);
		const refused = (state: WizardState) =>
			errorsOf(state).map((issue) => issue.code);
		const without = (
			state: WizardState,
			edit: Parameters<typeof editFile>[2],
		) => apply(state, editFile(state, 0, edit));
		expect([lacks(v2), refused(v2)]).toEqual([
			{ height: false, bitrate: false },
			[],
		]);
		expect([
			lacks(without(v2, { height: null })),
			refused(without(v2, { height: null })),
		]).toEqual([
			{ height: true, bitrate: false },
			["PLAN_INTERNAL_HEVC_V2_UNSUPPORTED"],
		]);
		expect([
			lacks(without(v2, { bitrate: null })),
			refused(without(v2, { bitrate: null })),
		]).toEqual([
			{ height: false, bitrate: true },
			["PLAN_INTERNAL_HEVC_V2_UNSUPPORTED"],
		]);
		// The other codecs take the source's height, and that is not said of them.
		for (const codec of ["H264", "H265", "AV1"] as const) {
			const other = without(without(started, { codec }), { height: null });
			expect([codec, lacks(other), refused(other)]).toEqual([
				codec,
				{ height: false, bitrate: false },
				[],
			]);
		}
	});

	it.each([
		["crf", 24, false],
		["profile", "main10", false],
		["bframes", 3, false],
		["maxBitrate", 9_000_000, false],
		["dynamicRangeFormat", "HDR10", false],
		["dynamicRangeFormat", "SDR", true],
		["rate", 30, true],
		["pixelFormat", "YUV420P10LE", true],
		["levelHighTier", true, true],
		["presetConfiguration", "VOD_STANDARD", true],
		["colorConfig", { colorPrimaries: "BT709" }, true],
		["displayAspectRatio", { numerator: 16, denominator: 9 }, true],
		["motionCompensatedTemporalFiltering", "ON", true],
	] as const)("take into HEVCv2 the H.265 settings it has, and leave the others: %s %j", (key, value, kept) => {
		const h265 = apply(started, editFile(started, 0, { codec: "H265" }));
		const tuned = apply(
			h265,
			editFile(h265, 0, { h265: { [key]: value } as never }),
		);
		const v2 = apply(tuned, editFile(tuned, 0, { codec: "H265V2" }));
		expect(v2.videos[0]?.h265).toEqual(kept ? { [key]: value } : undefined);
		// Left in, the plan is refused for a setting the HEVCv2 editor does not show.
		expect(errorsOf(v2)).toEqual([]);
		expect(fileOutputBlockers(v2)).toEqual([]);
		// The same file as the Ladder step leaves it: the setting is there to see.
		const arrived: WizardState = {
			...v2,
			videos: v2.videos.map((video) => ({
				...video,
				h265: { [key]: value } as never,
			})),
		};
		// (Another dynamic range is in a field the HEVCv2 editor has.)
		expect(fileOutputBlockers(arrived)).toEqual(
			kept || key === "dynamicRangeFormat" ? [] : ["ladder"],
		);
	});

	it("say in Basics that the switch of HEVCv2 is on with no file in it, where no plan is built", () => {
		const v2 = (state: WizardState, index: number) =>
			apply(state, editFile(state, index, { codec: "H265V2" }));
		const built = (state: WizardState) => {
			try {
				buildPlan(state);
				return true;
			} catch {
				return false;
			}
		};
		const both = v2(v2(two, 0), 1);
		const switchOnly = { ...two, internal: both.internal };
		expect(
			[two, v2(two, 0), both, switchOnly].map((state) => [
				bcfOverrideAlone(state),
				built(state),
			]),
		).toEqual([
			[false, true],
			// One file in HEVCv2: the codec field says it, not the switch.
			[false, false],
			[false, true],
			[true, false],
		]);
	});

	it("start once every file has the same mode", () => {
		const settled = moded(webm, ["TWO_PASS", "TWO_PASS"]);
		expect(errorsOf(settled)).toEqual([]);
		expect(fileOutputBlockers(settled)).toEqual([]);
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

	it("moves to a codec the new container can hold, and keeps one it holds", () => {
		const av1 = apply(started, editFile(started, 0, { codec: "AV1" }));
		const ts = apply(av1, editFile(av1, 0, { kind: "PROGRESSIVE_TS" }));
		expect(ts.videos[0]?.codec).toBe("H264");
		expect(errorsOf(ts)).toEqual([]);

		const hevc = apply(started, editFile(started, 0, { codec: "H265" }));
		const kept = apply(hevc, editFile(hevc, 0, { kind: "PROGRESSIVE_TS" }));
		expect(kept.videos[0]?.codec).toBe("H265");
		expect(errorsOf(kept)).toEqual([]);
	});

	it("moves the file's audio to a codec the new container can hold, and keeps one it holds", () => {
		const opus = apply(started, editFileAudio(started, 0, { codec: "OPUS" }));
		const ts = apply(opus, editFile(opus, 0, { kind: "PROGRESSIVE_TS" }));
		expect(ts.audios.map((audio) => audio.codec)).toEqual(["AAC"]);
		expect(errorsOf(ts)).toEqual([]);

		const ac3 = apply(started, editFileAudio(started, 0, { codec: "AC3" }));
		const kept = apply(ac3, editFile(ac3, 0, { kind: "PROGRESSIVE_TS" }));
		expect(kept.audios.map((audio) => audio.codec)).toEqual(["AC3"]);
		expect(errorsOf(kept)).toEqual([]);
	});

	it("turns the default MP4 into a WebM file of VP9 with Opus at 48 kHz, and back into H.264 with AAC", () => {
		const webm = apply(
			started,
			editFile(started, 0, { kind: "PROGRESSIVE_WEBM" }),
		);
		expect(webm.videos[0]).toMatchObject({
			codec: "VP9",
			muxing: { kind: "PROGRESSIVE_WEBM", filename: "clip.webm" },
		});
		expect(webm.audios).toEqual([
			{
				codec: "OPUS",
				bitrate: 192_000,
				rate: 48_000,
				channelLayout: "CL_STEREO",
				muxing: { ownContainer: false, autoOwnContainer: true },
			},
		]);
		expect(errorsOf(webm)).toEqual([]);
		expect(fileOutputBlockers(webm)).toEqual([]);

		const back = apply(webm, editFile(webm, 0, { kind: "MP4" }));
		expect(back.videos[0]).toMatchObject({ codec: "H264" });
		expect(back.audios.map((audio) => audio.codec)).toEqual(["AAC"]);
		expect(errorsOf(back)).toEqual([]);
	});

	it("does not carry a codec into a container no Bitmovin document lists it for, and keeps one that is chosen there", () => {
		const codecsOf = (state: WizardState) => [
			state.videos[0]?.codec,
			...state.audios.map((audio) => audio.codec),
		];
		const moved = (
			from: WizardState,
			to: (typeof FILE_CONTAINERS)[number]["kind"],
		) => apply(from, editFile(from, 0, { kind: to }));
		const withAudio = (codec: WizardState["audios"][number]["codec"]) =>
			apply(started, editFileAudio(started, 0, { codec }));

		// MP4 holds all three; in the container moved to, Bitmovin lists the first and
		// not the other two.
		expect(codecsOf(moved(withAudio("DDPLUS"), "PROGRESSIVE_TS"))).toEqual([
			undefined,
			"DDPLUS",
		]);
		expect(codecsOf(moved(withAudio("EAC3"), "PROGRESSIVE_TS"))).toEqual([
			undefined,
			"AAC",
		]);
		expect(codecsOf(moved(withAudio("AC3"), "PROGRESSIVE_MOV"))).toEqual([
			undefined,
			"AAC",
		]);

		// Chosen in the container, the same pair stays, with its note and the plan's
		// warning, and the job is not refused for it.
		const mov = moved(started, "PROGRESSIVE_MOV");
		const chosen = apply(mov, editFileAudio(mov, 0, { codec: "AC3" }));
		expect(codecsOf(chosen)).toEqual([undefined, "AC3"]);
		expect(
			fileCaveats(
				chosen.videos[0] as WizardState["videos"][number],
				fileAudios(chosen)[0],
			),
		).toContain("unverifiedAudio");
		expect(errorsOf(chosen)).toEqual([]);
		// An edit of something else in the same container leaves it alone.
		const taller = apply(chosen, editFile(chosen, 0, { height: 720 }));
		expect(codecsOf(taller)).toEqual([undefined, "AC3"]);
	});

	it("says so on the file when a state from elsewhere has audio its container cannot hold", () => {
		const [video] = started.videos as [WizardState["videos"][number]];
		const mismatched: WizardState = {
			...started,
			videos: [
				{
					...video,
					codec: "VP9",
					muxing: { ...video.muxing, kind: "PROGRESSIVE_WEBM" },
				},
			],
		};
		const [track] = fileAudios(mismatched);
		expect(track?.codec).toBe("AAC");
		expect(fileCaveats(mismatched.videos[0] as typeof video, track)).toContain(
			"audioNotHeld",
		);
		expect(errorsOf(mismatched).map((issue) => issue.code)).toEqual([
			"PLAN_MUXING_CODEC_MISMATCH",
		]);
		// An edit of something else leaves the codec to its own field.
		const taller = apply(mismatched, editFile(mismatched, 0, { height: 720 }));
		expect(taller.audios.map((audio) => audio.codec)).toEqual(["AAC"]);
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
	it("is the file's own: an edit changes that file alone, and files with the same settings share one track again", () => {
		const two = apply(started, addFile(started));
		expect(two.audios).toHaveLength(1);

		const louder = apply(two, editFileAudio(two, 0, { bitrate: 256_000 }));
		expect(filesOf(louder).map((item) => item.streams)).toEqual([
			["v1080", "a256"],
			["v540", "a192"],
		]);
		// Neither is in every file, so neither may be left to the reconciliation,
		// which would write it to a file of its own as well.
		expect(louder.audios.map((audio) => audio.muxing)).toEqual([
			{ ownContainer: false },
			{ ownContainer: false },
		]);
		expect(errorsOf(louder)).toEqual([]);
		expect(fileOutputBlockers(louder)).toEqual([]);

		const both = apply(louder, editFileAudio(louder, 1, { bitrate: 256_000 }));
		expect(filesOf(both).map((item) => item.streams)).toEqual([
			["v1080", "a256"],
			["v540", "a256"],
		]);
		expect(both.audios).toEqual([{ ...started.audios[0], bitrate: 256_000 }]);
		expect(errorsOf(both)).toEqual([]);
		expect(fileOutputBlockers(both)).toEqual([]);
	});

	it("gets a key of its own beside a track at the same bitrate in another codec, and loses the number when they differ again", () => {
		const two = apply(started, addFile(started));
		const ac3 = apply(two, editFileAudio(two, 1, { codec: "AC3" }));
		expect(filesOf(ac3).map((item) => item.streams)).toEqual([
			["v1080", "a192"],
			["v540", "a192-2"],
		]);
		expect(ac3.audios.map((audio) => [audio.codec, audio.extras?.key])).toEqual(
			[
				["AAC", undefined],
				["AC3", "a192-2"],
			],
		);
		expect(errorsOf(ac3)).toEqual([]);
		expect(fileOutputBlockers(ac3)).toEqual([]);
		// A third in a third codec is numbered on.
		const three = apply(ac3, addFile(ac3));
		const third = apply(three, editFileAudio(three, 2, { codec: "EAC3" }));
		expect(filesOf(third).map((item) => item.streams[1])).toEqual([
			"a192",
			"a192-2",
			"a192-3",
		]);
		expect(errorsOf(third)).toEqual([]);

		const apartAgain = apply(ac3, editFileAudio(ac3, 1, { bitrate: 128_000 }));
		expect(filesOf(apartAgain).map((item) => item.streams)).toEqual([
			["v1080", "a192"],
			["v540", "a128"],
		]);
		expect(apartAgain.audios.map((audio) => audio.extras)).toEqual([
			undefined,
			undefined,
		]);
		// And the way back from the full view derives the same keys.
		expect(collapseToFileOutput(ac3)).toMatchObject({
			videos: ac3.videos,
			audios: ac3.audios,
		});
	});

	it("is Opus at 48 kHz whatever rate it had, as the ladder step makes it", () => {
		const cd = apply(started, editFileAudio(started, 0, { rate: 44_100 }));
		const opus = apply(cd, editFileAudio(cd, 0, { codec: "OPUS" }));
		expect(opus.audios[0]).toMatchObject({ codec: "OPUS", rate: 48_000 });
		const ac3 = apply(cd, editFileAudio(cd, 0, { codec: "AC3" }));
		expect(ac3.audios[0]).toMatchObject({ codec: "AC3", rate: 44_100 });
	});

	it("is put back as the nearest file's where the container holds that, and as the container's first codec where not", () => {
		const two = apply(started, addFile(started));
		const ac3 = apply(two, editFileAudio(two, 0, { codec: "AC3" }));
		const silent = apply(ac3, setFileAudio(ac3, 1, false));
		expect(silent.audios).toHaveLength(1);
		const copied = apply(silent, setFileAudio(silent, 1, true));
		expect(copied.audios.map((audio) => audio.codec)).toEqual(["AC3"]);
		expect(filesOf(copied).map((item) => item.streams[1])).toEqual([
			"a192",
			"a192",
		]);

		// WebM holds no AC-3: the file starts with Opus, a track of its own.
		const webm = apply(
			silent,
			editFile(silent, 1, { kind: "PROGRESSIVE_WEBM" }),
		);
		const own = apply(webm, setFileAudio(webm, 1, true));
		expect(own.audios.map((audio) => audio.codec)).toEqual(["AC3", "OPUS"]);
		expect(
			errorsOf(own).filter(
				(issue) =>
					issue.code !== "PLAN_ENCODING_MODE_UNPINNED_FOR_MIXED_CODECS",
			),
		).toEqual([]);

		// The other way round: MP4 holds Opus, and no Bitmovin document lists the
		// pair. It is one to choose, and a tick does not arrive at it.
		const beside = apply(own, setFileAudio(own, 0, false));
		expect(fileAudios(beside).map((track) => track?.codec)).toEqual([
			undefined,
			"OPUS",
		]);
		const ticked = apply(beside, setFileAudio(beside, 0, true));
		expect(fileAudios(ticked).map((track) => track?.codec)).toEqual([
			"AAC",
			"OPUS",
		]);
		expect(
			fileCaveats(
				ticked.videos[0] as WizardState["videos"][number],
				fileAudios(ticked)[0],
			),
		).toEqual([]);
	});

	it("can be left out, and put back", () => {
		const silent = apply(started, setFileAudio(started, 0, false));
		expect(filesOf(silent).map((item) => item.streams)).toEqual([["v1080"]]);
		expect(errorsOf(silent)).toEqual([]);
		expect(fileOutputBlockers(silent)).toEqual([]);

		const back = apply(silent, setFileAudio(silent, 0, true));
		expect(filesOf(back)).toEqual(filesOf(started));
	});

	it("keeps a channel layout the new codec has too, and drops one that belongs to the codec it leaves", () => {
		const both = AUDIO_CHANNEL_LAYOUTS.AAC.find(
			(layout) =>
				layout !== "NONE" && AUDIO_CHANNEL_LAYOUTS.AC3.includes(layout),
		);
		const aacOnly = AUDIO_CHANNEL_LAYOUTS.AAC.find(
			(layout) => !AUDIO_CHANNEL_LAYOUTS.AC3.includes(layout),
		);
		expect([both, aacOnly]).not.toContain(undefined);
		const recoded = (channelLayout: string | undefined) => {
			const laidOut = apply(
				started,
				editFileAudio(started, 0, { channelLayout }),
			);
			return apply(laidOut, editFileAudio(laidOut, 0, { codec: "AC3" }))
				.audios[0];
		};
		expect(recoded(both)).toMatchObject({ codec: "AC3", channelLayout: both });
		expect(recoded(aacOnly)).toMatchObject({ codec: "AC3" });
		expect(recoded(aacOnly)?.channelLayout).toBeUndefined();
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
			"an encoding the job is split into, which the Sources step adds",
			{ sources: { encodings: [{ key: "second", name: "Second encoding" }] } },
			["encodings"],
		],
		[
			"post-encoding generation for several encodings",
			{
				sources: { encodings: [{ key: "second", name: "Second encoding" }] },
				timing: "POST_ENCODING",
			},
			["encodings", "manifests"],
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
			"a gate rule for one of the files",
			{
				qc: {
					vmaf: true,
					psnr: false,
					model: "vmaf_v0.6.1",
					gate: {
						rules: [
							{
								metric: "VMAF_MEAN",
								scope: "PER_RENDITION",
								gte: 80,
								renditions: ["v1080"],
							},
						],
						onFail: "MARK_ONLY",
					},
				},
			},
			["gateTargets"],
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
			"an audio track that no file holds, which gets a file of its own",
			{
				audios: [
					...started.audios,
					{ codec: "AAC", bitrate: 96_000, rate: 48_000 },
				],
			},
			["packaging"],
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

	it("the audio guard while no file has audio, which the Format step adds in one click", () => {
		const silent = apply(started, setFileAudio(started, 0, false));
		const guarded: WizardState = { ...silent, audioGuard: true };
		// In no plan as the job stands...
		expect(planOf(guarded)).toEqual(planOf(silent));
		expect(fileOutputBlockers(guarded)).toEqual(["ladder"]);
		// ...and on the audio stream as soon as there is one.
		const audible = apply(guarded, setFileAudio(guarded, 0, true));
		expect(planOf(audible)).not.toEqual(
			planOf({ ...audible, audioGuard: false }),
		);
		expect(fileOutputBlockers(audible)).toEqual(["ladder"]);
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

	it("an audio track that no file holds, which the plan then writes to a file of its own", () => {
		const unheld: WizardState = {
			...started,
			videos: started.videos.map((video) => ({
				...video,
				muxing: { ...video.muxing, muxedAudioKeys: [] },
			})),
			audios: [{ ...track, muxing: { ownContainer: false } }],
		};
		expect(planOf(unheld).muxings.map((muxing) => muxing.streamKey)).toEqual([
			"v1080",
			"a192",
		]);
		expect(fileOutputBlockers(unheld)).toEqual(["packaging"]);
	});

	it("two audio tracks in one file", () => {
		const second = { codec: "AAC" as const, bitrate: 96_000, rate: 48_000 };
		const [video] = started.videos as [WizardState["videos"][number]];
		const both: WizardState = {
			...started,
			videos: [
				{
					...video,
					muxing: { ...video.muxing, muxedAudioKeys: ["a192", "a96"] },
				},
			],
			audios: [track, { ...second, muxing: { ownContainer: false } }],
		};
		expect(filesOf(both)[0]?.streams).toEqual(["v1080", "a192", "a96"]);
		expect(fileOutputBlockers(both)).toEqual(["packaging"]);
	});

	it("two audio tracks under one key, which leaves nothing to tell which a file holds", () => {
		const twin: WizardState = {
			...started,
			audios: [track, { ...track, codec: "AC3" }],
		};
		expect(fileOutputBlockers(twin)).toContain("ladder");
	});

	// Not held back: a file is shown with or without a track of its own.
	it("holds nothing back for a file without the audio the other files hold", () => {
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
		expect(fileOutputBlockers(bare)).toEqual([]);
		expect(fileAudios(bare).map((audio) => audio?.codec)).toEqual([
			"AAC",
			undefined,
		]);
	});
});

describe("every field of a step the simple view hides", () => {
	const credentialId = "00000000-0000-4000-8000-000000000003";
	// For each field, a job that uses it and the step that edits it.
	const inUse = {
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

describe("a quality gate, which in the simple view marks the job and holds nothing back", () => {
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

	// The simple view keeps a gate while nothing is measured, and ticks a measure in
	// one click. A gate that would then hold the manifests back is not dropped to
	// marking on the way back without a word: it is named, as it is when measured.
	it("holds the full view with no measure ticked too, a measure being one click away", () => {
		const idle = gated("BLOCK_MANIFESTS", false);
		expect(planOf(idle)).toEqual(planOf(started));
		expect(fileOutputBlockers(idle)).toEqual(["qualityGate"]);
	});

	it("is shown there with no measure ticked while it only marks the job", () => {
		const idle = gated("MARK_ONLY", false);
		expect(planOf(idle)).toEqual(planOf(started));
		expect(fileOutputBlockers(idle)).toEqual([]);
		expect(collapseToFileOutput(idle)).toEqual(idle);
	});
});

describe("the renditions a gate rule is for, which the simple view leaves to the full view", () => {
	const rule = {
		metric: "VMAF_MEAN" as const,
		scope: "PER_RENDITION" as const,
		gte: 80,
	};
	const aimed = (
		state: WizardState,
		renditions: string[],
		vmaf = true,
		onFail: "MARK_ONLY" | "BLOCK_MANIFESTS" = "MARK_ONLY",
	): WizardState => ({
		...state,
		qc: {
			vmaf,
			psnr: false,
			model: "vmaf_v0.6.1",
			gate: { rules: [{ ...rule, renditions }], onFail },
		},
	});

	it("holds the full view while a rule names a file by its key", () => {
		const one = aimed(started, ["v1080"]);
		expect(planOf(one).qc?.gate?.rules[0]?.renditions).toEqual(["v1080"]);
		expect(errorsOf(one)).toEqual([]);
		expect(fileOutputBlockers(one)).toEqual(["gateTargets"]);
	});

	// The way back derives the editors' keys again. A rule taken along would name
	// a key no file has, and a job the full view accepted would be refused.
	it("holds it for a key the ladder editor wrote, which the way back would derive again", () => {
		const fixed: WizardState = aimed(
			{
				...started,
				videos: started.videos.map((video) => ({
					...video,
					extras: { ...video.extras, key: "v1080_8000k" },
				})),
			},
			["v1080_8000k"],
		);
		expect(errorsOf(fixed)).toEqual([]);
		expect(fileOutputBlockers(fixed)).toEqual(["gateTargets"]);
		// What pressing the button would do, were it enabled.
		expect(planOf(collapseToFileOutput(fixed)).renditions[0]?.key).toBe(
			"v1080",
		);
	});

	// Two files of one height are told apart by bitrate, so adding the second
	// renames the first: no rule made in the simple view may depend on a key.
	it("leaves a rule made in the simple view standing when a file's key moves", () => {
		const open: WizardState = {
			...started,
			qc: {
				vmaf: true,
				psnr: false,
				model: "vmaf_v0.6.1",
				gate: { rules: [rule], onFail: "MARK_ONLY" },
			},
		};
		const two = apply(open, addFile(open));
		const same = apply(two, editFile(two, 1, { height: 1080 }));
		expect(
			planOf(same)
				.renditions.filter((item) => item.key.startsWith("v"))
				.map((item) => item.key),
		).toEqual(["v1080_8000k", "v1080_2000k"]);
		expect(errorsOf(same)).toEqual([]);
		expect(fileOutputBlockers(same)).toEqual([]);
		expect(collapseToFileOutput(same)).toEqual(same);
	});

	it("holds the full view with no measure ticked too, a measure being one click away", () => {
		const idle = aimed(started, ["v1080"], false);
		expect(planOf(idle)).toEqual(planOf(started));
		expect(fileOutputBlockers(idle)).toEqual(["gateTargets"]);
	});

	it.each([
		true,
		false,
	])("is named beside a gate that holds the manifests back (a measure ticked: %s)", (vmaf) => {
		expect(
			fileOutputBlockers(aimed(started, ["v1080"], vmaf, "BLOCK_MANIFESTS")),
		).toEqual(["qualityGate", "gateTargets"]);
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
		fileJobWrites(planOf(state)).map((item) => `${item.kind} ${item.path}`);

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

	// The form keeps the bucket it had when the storage is changed to a kind that
	// has none, so the name is read from the plan, where it is gone.
	it.each([
		"SFTP",
		"AKAMAI_NETSTORAGE",
	] as const)("names no bucket for %s, which has none", (kind) => {
		const measured: WizardState = {
			...started,
			output: { ...started.output, kind },
			qc: { vmaf: true, psnr: false, model: "vmaf_v0.6.1" },
		};
		expect(measured.output.bucket).toBe("out");
		expect(writes(measured)).toEqual([
			"file exports/clip.mp4",
			"qcMirror exports/qc/",
		]);
	});

	it("starts with the container of an Azure output", () => {
		expect(
			writes({ ...started, output: { ...started.output, kind: "AZURE" } }),
		).toEqual(["file out/exports/clip.mp4"]);
	});

	it.each([
		["exports", "out/exports/"],
		["exports/", "out/exports/"],
		["/exports/", "out/exports/"],
		["", "out/"],
		["/", "out/"],
	])("reads the same however the folder %j was typed", (basePath, folder) => {
		expect(
			writes({
				...started,
				output: { ...started.output, basePath },
				startOptions: {
					aiSceneAnalysis: { filename: "analysis.json", path: "" },
				},
				qc: { vmaf: true, psnr: false, model: "vmaf_v0.6.1" },
			}),
		).toEqual([
			`file ${folder}clip.mp4`,
			`analysis ${folder}analysis.json`,
			`qcMirror ${folder}qc/`,
		]);
	});

	it("puts the copies where the quality check is told to", () => {
		const two = apply(started, addFile(started));
		expect(
			writes({
				...two,
				qc: {
					vmaf: true,
					psnr: false,
					model: "vmaf_v0.6.1",
					mirrorPath: "clip/",
				},
			}),
		).toEqual([
			"file out/exports/clip.mp4",
			"file out/exports/clip-540p.mp4",
			"qcMirror out/exports/clip/qc/",
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
		);
		expect(all).toHaveLength(4);
		expect(new Set(all.map((item) => item.key)).size).toBe(4);
	});
});

describe("the folder of what a job writes besides its files", () => {
	const kantar = {
		credentialId: "00000000-0000-4000-8000-000000000003",
		licenseId: 1,
		channelName: "channel",
		contentReference: "reference",
		serverUrl: "https://kantar.example",
	};
	// As the Encoding step leaves them when each is switched on in this flow.
	const full: WizardState = {
		...started,
		startOptions: {
			aiSceneAnalysis: {
				filename: "analysis.json",
				path: fileJobFolder(started.name),
			},
		},
		qc: {
			vmaf: true,
			psnr: false,
			model: "vmaf_v0.6.1",
			mirrorPath: fileJobFolder(started.name),
		},
		kantar: { ...kantar, reportPath: fileJobFolder(started.name) },
	};
	const besides = (state: WizardState) =>
		fileJobWrites(planOf(state))
			.filter((item) => item.kind !== "file")
			.map((item) => item.path);

	it("is named after the job, as the files are", () => {
		expect(fileJobFolder("clip")).toBe("clip/");
		expect(fileJobFolder(" a/b?c ")).toBe("a-b-c/");
		expect(fileJobFolder("")).toBe("output/");
	});

	it("keeps two jobs that write to one folder apart", () => {
		expect(errorsOf(full)).toEqual([]);
		expect(besides(full)).toEqual([
			"out/exports/clip/analysis.json",
			"out/exports/clip/qc/",
			"out/exports/clip/",
		]);
		const other = apply(full, renameFileJob(full, "trailer"));
		expect(besides(other)).toEqual([
			"out/exports/trailer/analysis.json",
			"out/exports/trailer/qc/",
			"out/exports/trailer/",
		]);
		// The files are where they were: straight in the folder.
		expect(fileJobWrites(planOf(other))[0]?.path).toBe(
			"out/exports/trailer.mp4",
		);
	});

	it("stays where it was put once somebody chose another", () => {
		const moved: WizardState = {
			...full,
			startOptions: {
				aiSceneAnalysis: { filename: "analysis.json", path: "ai/" },
			},
			qc: { ...full.qc, mirrorPath: "" } as WizardState["qc"],
			kantar: { ...kantar, reportPath: "reports/" },
		};
		const renamed = apply(moved, renameFileJob(moved, "trailer"));
		expect(renamed.startOptions).toEqual(moved.startOptions);
		expect(renamed.qc).toEqual(moved.qc);
		expect(renamed.kantar).toEqual(moved.kantar);
		expect(besides(renamed)).toEqual([
			"out/exports/ai/analysis.json",
			"out/exports/qc/",
			"out/exports/reports/",
		]);
	});

	it("is not invented by a rename for a job that has none of the three", () => {
		const renamed = renameFileJob(started, "trailer");
		expect(Object.keys(renamed).sort()).toEqual(["name", "videos"]);
	});

	it("is a setting the simple view shows, there and back", () => {
		expect(fileOutputBlockers(full)).toEqual([]);
		expect(collapseToFileOutput(full)).toEqual(full);
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
		const louder = apply(
			chosen,
			editFileAudio(chosen, 0, { bitrate: 320_000 }),
		);
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
	// AAC, AC-3 at the same bitrate under a numbered key, no audio, and AAC again.
	const perFileAudio = (() => {
		let state = apply(two, addFile(two));
		state = apply(state, addFile(state));
		state = apply(state, editFileAudio(state, 1, { codec: "AC3" }));
		return apply(state, setFileAudio(state, 2, false));
	})();

	it("is built with each file's own track, a numbered key among them", () => {
		expect(filesOf(perFileAudio).map((item) => item.streams[1])).toEqual([
			"a192",
			"a192-2",
			undefined,
			"a192",
		]);
		const { state } = loaded(perFileAudio);
		expect(
			fileAudios(collapseToFileOutput(state)).map((track) => track?.codec),
		).toEqual(["AAC", "AC3", undefined, "AAC"]);
	});

	it.each([
		["one MP4", started],
		["two files", two],
		[
			"an MPEG-TS file",
			apply(started, editFile(started, 0, { kind: "PROGRESSIVE_TS" })),
		],
		["no audio", apply(started, setFileAudio(started, 0, false))],
		["files that each hold a track of their own, or none", perFileAudio],
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
