import {
	type EncodingPlan,
	MUXING_CODEC_MATRIX,
	storageSummaries,
	UNMEASURED_MUXING_KINDS,
} from "@bitovp/core";
import { draftKeepsText } from "@/lib/wizard-draft";
import {
	audioKeys,
	buildPlan,
	DEFAULT_WIZARD_STATE,
	videoKeys,
	type WizardAudioCodec,
	type WizardAudioRendition,
	type WizardMuxingKind,
	type WizardRenditionExtras,
	type WizardState,
	type WizardVideoCodec,
	type WizardVideoRendition,
} from "./build-plan";

/**
 * The file-output flow: one file per video stream, the audio muxed into it, no manifest.
 *
 * This is not a second model. The flow edits the `WizardState` the full wizard edits and
 * `buildPlan` reads. What lives here is the state the flow starts from, the edits its one
 * format screen makes, the test for whether a state can be shown in the flow's short
 * view without leaving a setting out of sight, and the list of what such a job writes.
 */

export type FileContainer = {
	kind: WizardMuxingKind;
	/** A format name, the same in every locale. */
	label: string;
	extension: string;
	video: readonly WizardVideoCodec[];
	audio: readonly WizardAudioCodec[];
	/** The name the plan writes when none is given. Without one, a name is required. */
	fallbackName?: string;
	/** No live encode of this app has written one yet; the plan carries a warning. */
	unmeasured: boolean;
};

// What the format screen can configure. A container holds the ones the plan's
// validation accepts for it, read from the table that validation uses.
const VIDEO_CODECS: readonly WizardVideoCodec[] = ["H264", "H265"];
const AUDIO_CODECS: readonly WizardAudioCodec[] = ["AAC", "AC3", "EAC3"];

function container(
	kind: "MP4" | "PROGRESSIVE_TS" | "PROGRESSIVE_MOV",
	label: string,
	extension: string,
	fallbackName?: string,
): FileContainer {
	const holds: readonly string[] = MUXING_CODEC_MATRIX[kind];
	return defined({
		kind,
		label,
		extension,
		video: VIDEO_CODECS.filter((codec) => holds.includes(codec)),
		audio: AUDIO_CODECS.filter((codec) => holds.includes(codec)),
		fallbackName,
		unmeasured: UNMEASURED_MUXING_KINDS.has(kind),
	});
}

/** Containers the flow offers, with the codecs its screen can configure for each. */
export const FILE_CONTAINERS: readonly FileContainer[] = [
	container("MP4", "MP4 (.mp4)", "mp4"),
	container("PROGRESSIVE_TS", "MPEG-TS (.ts)", "ts", "output.ts"),
	container("PROGRESSIVE_MOV", "QuickTime (.mov)", "mov", "output.mov"),
];

export function fileContainer(
	kind: WizardMuxingKind | undefined,
): FileContainer | undefined {
	return FILE_CONTAINERS.find((container) => container.kind === kind);
}

/** Audio codecs every file's container can hold; one track rides in all of them. */
export function fileAudioCodecs(
	videos: readonly WizardVideoRendition[],
): WizardAudioCodec[] {
	const containers = videos.flatMap(
		(video) => fileContainer(video.muxing?.kind) ?? [],
	);
	return [...new Set(FILE_CONTAINERS.flatMap((item) => item.audio))].filter(
		(codec) => containers.every((item) => item.audio.includes(codec)),
	);
}

const DEFAULT_AUDIO: WizardAudioRendition = {
	codec: "AAC",
	bitrate: 192_000,
	rate: 48_000,
	channelLayout: "CL_STEREO",
	// What the wizard's own reconciliation settles on for a track that every file
	// carries. Stated here so the starting state is already the settled one.
	muxing: { ownContainer: false, autoOwnContainer: true },
};

function defined<T extends object>(value: T): T {
	return Object.fromEntries(
		Object.entries(value).filter(([, item]) => item !== undefined),
	) as T;
}

function without<T extends object>(value: T, keys: readonly string[]): T {
	return Object.fromEntries(
		Object.entries(value).filter(([key]) => !keys.includes(key)),
	) as T;
}

/** Unset, or a collection that holds nothing set. `false`, `0`, `""` and `null` are values. */
function isBlank(value: unknown): boolean {
	if (value === undefined) return true;
	if (Array.isArray(value)) return value.length === 0;
	if (value !== null && typeof value === "object")
		return Object.values(value).every(isBlank);
	return false;
}

function settled(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(settled);
	if (value === null || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value)
			.filter(([, item]) => !isBlank(item))
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([key, item]) => [key, settled(item)]),
	);
}

/** Equal once unset leaves are ignored: `{ hls: false, extra: [] }` is `{ hls: false }`. */
function same(a: unknown, b: unknown): boolean {
	if (isBlank(a) || isBlank(b)) return isBlank(a) && isBlank(b);
	return JSON.stringify(settled(a)) === JSON.stringify(settled(b));
}

/**
 * Text a saved draft keeps. A draft drops text that reads as an address or a login,
 * and a file name dropped that way comes back empty: a TS or MOV file would then be
 * written under its container's own name, with nothing said. Both shapes are
 * spelled with ":".
 */
function keptByDraft(text: string): string {
	return draftKeepsText(text) ? text : text.replace(/:+/g, "-");
}

/** The part of a derived file name that comes from the job name. */
export function fileStem(name: string): string {
	return keptByDraft(name.trim().replace(/[/\\?#]+/g, "-")) || "output";
}

/**
 * A name as the format screen takes it. `?` and `#` end the path in a URL, so a file
 * named with one cannot be fetched by its address, and a saved draft drops any text
 * that holds one (`keptByDraft`). A folder in the name is left alone.
 */
export function typedFileName(name: string): string {
	return keptByDraft(name.replace(/[?#]+/g, "-"));
}

/**
 * The name each file gets while nobody has typed one: the job name for the first file,
 * the job name and the height for the rest. All files share one folder, so the names
 * have to differ.
 */
export function defaultFileNames(
	name: string,
	videos: readonly WizardVideoRendition[],
): string[] {
	const stem = fileStem(name);
	const taken = new Set<string>();
	return videos.map((video, index) => {
		const extension = fileContainer(video.muxing?.kind)?.extension ?? "mp4";
		const label =
			index === 0
				? stem
				: `${stem}-${video.height === null ? index + 1 : `${video.height}p`}`;
		let candidate = `${label}.${extension}`;
		for (let n = index + 1; taken.has(candidate); n++)
			candidate = `${label}-${n}.${extension}`;
		taken.add(candidate);
		return candidate;
	});
}

/**
 * The name a file is written under: the one given, or the container's own when it
 * has one. Empty means the plan has no name for the file and is refused.
 */
export function writtenFileName(video: WizardVideoRendition): string {
	return (
		video.muxing?.filename ||
		fileContainer(video.muxing?.kind)?.fallbackName ||
		""
	);
}

/**
 * Files that write the name another file writes. Every file goes to the one folder,
 * so two files with one name are one file, and the plan is refused for it
 * (`PLAN_OUTPUT_FILE_COLLISION`). This says which names to change, and can say so
 * before the rest of the form is complete enough to validate.
 *
 * Only names that are the same as typed. Two spellings of one path ("clip.mp4" and
 * "./clip.mp4") are one file only if the storage reads them as one, which the plan's
 * validation reports as a warning and not as a refusal.
 */
export function sharedFileNames(
	videos: readonly WizardVideoRendition[],
): boolean[] {
	const names = videos.map((video) => {
		const name = writtenFileName(video);
		// A placeholder gets its value at the provider, so nothing is known here.
		return name === "" || /[%{}]/.test(name) ? undefined : name;
	});
	return names.map(
		(name, index) =>
			name !== undefined &&
			names.some((other, at) => at !== index && other === name),
	);
}

/**
 * Files the plan cannot tell apart. Each file is a video stream of its own, and a
 * stream is keyed by its height, its bitrate in kbps and its codec. Two files equal
 * in all three get one key, and the plan is refused for it (`PLAN_DUPLICATE_KEY`) in
 * words that name nothing this screen shows. This says which files to change.
 */
export function sameStreamFiles(
	videos: readonly WizardVideoRendition[],
): boolean[] {
	const keys = videoKeys([...videos]);
	return keys.map((key) => keys.indexOf(key) !== keys.lastIndexOf(key));
}

/** Files whose name is still the derived one, and so follows what it was derived from. */
function derivedNames(state: Pick<WizardState, "name" | "videos">): boolean[] {
	const names = defaultFileNames(state.name, state.videos);
	return state.videos.map(
		(video, index) => video.muxing?.filename === names[index],
	);
}

function named(
	name: string,
	videos: WizardVideoRendition[],
	derived: readonly boolean[],
): WizardVideoRendition[] {
	const names = defaultFileNames(name, videos);
	return videos.map((video, index) =>
		derived[index]
			? { ...video, muxing: { ...video.muxing, filename: names[index] } }
			: video,
	);
}

/** Point every file at the one audio track, or at none. The key follows the bitrate. */
function carrying(
	videos: WizardVideoRendition[],
	audios: WizardAudioRendition[],
): WizardVideoRendition[] {
	const key = audioKeys(audios)[0];
	return videos.map((video) => ({
		...video,
		muxing: defined({
			...video.muxing,
			muxedAudioKeys: key === undefined ? undefined : [key],
		}),
	}));
}

function sourced<T extends { extras?: WizardRenditionExtras }>(
	rendition: T,
	source: string | undefined,
): T {
	if (source === undefined) return rendition;
	const extras = defined({ ...rendition.extras, source: source || undefined });
	return defined({
		...rendition,
		extras: isBlank(extras) ? undefined : extras,
	});
}

function file(
	height: number,
	bitrate: number,
	kind: WizardMuxingKind,
	codec?: WizardVideoCodec,
): WizardVideoRendition {
	return defined({
		height,
		bitrate,
		codec,
		// "" is the output folder itself: files are not sorted into per-stream folders.
		muxing: { kind, filename: "", path: "" },
	});
}

const DEFAULT_VIDEOS = carrying(
	[file(1080, 8_000_000, "MP4")],
	[DEFAULT_AUDIO],
);

/** One 1080p H.264 MP4 with stereo AAC inside, written straight into a private folder. */
export const FILE_OUTPUT_DEFAULT_STATE: WizardState = {
	...DEFAULT_WIZARD_STATE,
	output: { ...DEFAULT_WIZARD_STATE.output, publicRead: false },
	videos: named("", DEFAULT_VIDEOS, [true]),
	audios: [DEFAULT_AUDIO],
	manifests: { hls: false, dash: false },
};

/**
 * The folder, relative to the destination folder, for what a job writes besides its
 * files: the AI Scene Analysis result, the copies the quality check measures and the
 * Kantar report. The files go straight into the destination folder, which other
 * jobs write to as well, and none of the three is named after the job: the result
 * is `analysis.json` unless renamed, and a copy is named by the key of its file's
 * video stream (`v1080.mp4`). Left in the destination folder, the next job would
 * replace them, and a job could be scored on a copy another job wrote.
 */
export function fileJobFolder(name: string): string {
	return `${fileStem(name)}/`;
}

/**
 * Rename the job. What was derived from the old name follows: the file names, and
 * the folder of what the job writes besides them (`fileJobFolder`) wherever that
 * folder is still the derived one.
 */
export function renameFileJob(
	state: WizardState,
	name: string,
): Pick<WizardState, "name" | "videos"> &
	Partial<Pick<WizardState, "startOptions" | "qc" | "kantar">> {
	const from = fileJobFolder(state.name);
	const to = fileJobFolder(name);
	const analysis = state.startOptions?.aiSceneAnalysis;
	return {
		name,
		videos: named(name, state.videos, derivedNames(state)),
		...(analysis?.path === from
			? {
					startOptions: {
						...state.startOptions,
						aiSceneAnalysis: { ...analysis, path: to },
					},
				}
			: {}),
		...(state.qc?.mirrorPath === from
			? { qc: { ...state.qc, mirrorPath: to } }
			: {}),
		...(state.kantar?.reportPath === from
			? { kantar: { ...state.kantar, reportPath: to } }
			: {}),
	};
}

export type FileEdit = Partial<
	Pick<
		WizardVideoRendition,
		"height" | "bitrate" | "codec" | "encodingMode" | "h264" | "h265"
	>
> & {
	kind?: WizardMuxingKind;
	filename?: string;
	/** Source stream key; "" returns to the input's own video track. */
	source?: string;
};

export function editFile(
	state: WizardState,
	index: number,
	edit: FileEdit,
): Pick<WizardState, "videos"> {
	const current = state.videos[index];
	if (!current) return { videos: state.videos };
	const { kind, filename, source, ...rendition } = edit;
	const derived = derivedNames(state);
	const previous = fileContainer(current.muxing?.kind);
	const container = fileContainer(kind) ?? previous;
	let name = current.muxing?.filename ?? "";
	if (filename !== undefined) {
		name = typedFileName(filename);
		derived[index] = false;
	} else if (
		container &&
		previous &&
		container !== previous &&
		name.toLowerCase().endsWith(`.${previous.extension}`)
	) {
		// A typed name keeps its stem; only the extension belongs to the container.
		name = `${name.slice(0, -previous.extension.length)}${container.extension}`;
	}
	const codec = rendition.codec ?? current.codec ?? "H264";
	const next = sourced(
		defined({
			...current,
			...rendition,
			// A codec the new container cannot hold would only surface later as a
			// validation error about a choice the user did not make.
			...(container && !container.video.includes(codec)
				? { codec: container.video[0] }
				: {}),
			muxing: {
				...current.muxing,
				...(container ? { kind: container.kind } : {}),
				filename: name,
			},
		}),
		source,
	);
	const videos = state.videos.map((video, at) => (at === index ? next : video));
	return { videos: named(state.name, videos, derived) };
}

/** A second file is usually a smaller copy of the last: half the height, a quarter of the bitrate. */
export function addFile(state: WizardState): Pick<WizardState, "videos"> {
	const last = state.videos.at(-1);
	const container =
		fileContainer(last?.muxing?.kind) ?? (FILE_CONTAINERS[0] as FileContainer);
	const height = last?.height
		? Math.max(2, Math.round(last.height / 4) * 2)
		: 540;
	const bitrate = last?.bitrate
		? Math.max(100_000, Math.round(last.bitrate / 4))
		: 2_000_000;
	const codec =
		last?.codec && container.video.includes(last.codec)
			? last.codec
			: undefined;
	const videos = carrying(
		[...state.videos, file(height, bitrate, container.kind, codec)],
		state.audios,
	);
	return { videos: named(state.name, videos, [...derivedNames(state), true]) };
}

/** The flow always writes at least one file; removing the last one is refused. */
export function removeFile(
	state: WizardState,
	index: number,
): Pick<WizardState, "videos"> {
	if (state.videos.length <= 1 || !state.videos[index])
		return { videos: state.videos };
	const keep = <T>(items: readonly T[]) =>
		items.filter((_, at) => at !== index);
	return {
		videos: named(state.name, keep(state.videos), keep(derivedNames(state))),
	};
}

export type FileAudioEdit = Partial<
	Pick<WizardAudioRendition, "codec" | "bitrate" | "rate" | "channelLayout">
> & {
	/** Source stream key; "" returns to the input's own audio track. */
	source?: string;
};

/** Turn the one audio track on or off for every file. */
export function setFileAudio(
	state: WizardState,
	enabled: boolean,
): Pick<WizardState, "videos" | "audios"> {
	const audios = enabled
		? state.audios.length > 0
			? state.audios
			: [DEFAULT_AUDIO]
		: [];
	return { audios, videos: carrying(state.videos, audios) };
}

export function editFileAudio(
	state: WizardState,
	edit: FileAudioEdit,
): Pick<WizardState, "videos" | "audios"> {
	const current = state.audios[0];
	if (!current) return { videos: state.videos, audios: state.audios };
	const { source, ...rendition } = edit;
	const audios = [
		sourced(
			defined({
				...current,
				...rendition,
				// Layout names belong to the codec; the encoder default is safe for any.
				...(rendition.codec !== undefined &&
				rendition.codec !== current.codec &&
				rendition.channelLayout === undefined
					? { channelLayout: undefined }
					: {}),
			}),
			source,
		),
		...state.audios.slice(1),
	];
	return { audios, videos: carrying(state.videos, audios) };
}

/**
 * Where a setting lives that the simple view does not show, in wizard order.
 * `basics` is a shown step with one control held back. `encodings` is the one
 * setting held back from the Sources step, and `perTitle`, `qualityGate` and
 * `gateTargets` are the three held back from the Encoding step; both steps are
 * shown too (`HELD_BACK`). The rest are the steps the view leaves out.
 */
export const FILE_OUTPUT_BLOCKERS = [
	"basics",
	"encodings",
	"ladder",
	"packaging",
	"perTitle",
	"qualityGate",
	"gateTargets",
	"manifests",
] as const;
export type FileOutputBlocker = (typeof FILE_OUTPUT_BLOCKERS)[number];

/**
 * Every top-level field is either shown by the simple view or owned by a step it
 * hides. A field added to `WizardState` fails typechecking here until it is placed,
 * which is the point: an unplaced field would be a setting the view could hide.
 */
export const FILE_OUTPUT_FIELD_HOME: Record<
	keyof WizardState,
	"shown" | FileOutputBlocker
> = {
	name: "shown",
	accountId: "shown",
	cloudRegion: "shown",
	encoderVersion: "shown",
	inputFiles: "shown",
	audioInputFile: "shown",
	// Shown but for the setting judged apart (`HELD_BACK`).
	sources: "shown",
	output: "shown",
	additionalOutputs: "shown",
	// Set only by loading a delivery spec, and edited in no step at all.
	delivery: "shown",
	// Judged per rendition below.
	videos: "shown",
	audios: "shown",
	internal: "basics",
	audioGuard: "ladder",
	subtitles: "ladder",
	filters: "ladder",
	manualFilterKeys: "ladder",
	drm: "packaging",
	thumbnails: "packaging",
	sprites: "packaging",
	labels: "shown",
	infrastructure: "shown",
	prewarmedEncoderPoolIds: "shown",
	kantar: "shown",
	// Shown but for the settings judged apart (`HELD_BACK`).
	startOptions: "shown",
	qc: "shown",
	manifests: "manifests",
	timing: "manifests",
};

const HIDDEN_FIELDS = (
	Object.keys(FILE_OUTPUT_FIELD_HOME) as (keyof WizardState)[]
).filter((key) => FILE_OUTPUT_FIELD_HOME[key] !== "shown");

/** The state with the named fields as the flow starts them. */
function reset(
	state: WizardState,
	keys: readonly (keyof WizardState)[],
): WizardState {
	const next = { ...state };
	const put = <K extends keyof WizardState>(key: K) => {
		if (key in FILE_OUTPUT_DEFAULT_STATE)
			next[key] = FILE_OUTPUT_DEFAULT_STATE[key];
		else delete next[key];
	};
	for (const key of keys) put(key);
	return next;
}

function planText(state: WizardState): string | undefined {
	try {
		const plan = buildPlan(state);
		// When the manifests are generated says nothing about one encoding that
		// generates none. The full view sets it without being asked (a rendition
		// entering Per-Title, a manifest's generation mode) and shows its control
		// only while a manifest is on, so left alone it could not be taken back.
		const timed =
			(plan.manifests?.length ?? 0) > 0 || (plan.encodings?.length ?? 0) > 0;
		return JSON.stringify(
			timed
				? plan
				: { ...plan, generation: { ...plan.generation, timing: undefined } },
		);
	} catch {
		// A ladder the plan cannot be built from; nothing to compare against.
		return undefined;
	}
}

/**
 * Of the fields a hidden step has set, the ones the job would be different without.
 * The full view's editors can leave a value behind that does nothing: the options of
 * a manifest that was switched off again, the bookkeeping of a filter that was
 * removed. That is not a setting in use, and it goes when the view is left
 * (`collapseToFileOutput`).
 */
function fieldsInUse(state: WizardState): (keyof WizardState)[] {
	const set = HIDDEN_FIELDS.filter(
		(key) => !same(state[key], FILE_OUTPUT_DEFAULT_STATE[key]),
	);
	if (set.length === 0) return [];
	const plan = planText(state);
	if (plan === undefined) return set;
	const waiting = set.filter((key) => IN_USE_WHEN_SET.includes(key));
	if (planText(reset(state, set)) === plan) return waiting;
	const alone = set.filter(
		(key) => waiting.includes(key) || planText(reset(state, [key])) !== plan,
	);
	// They matter together though none does alone: every one of them is named.
	return alone.length > 0 ? alone : set;
}

/**
 * The state one click of the simple view's Encoding step away, which is what a
 * hidden setting is judged in: a setting that click brings into the plan is in use
 * all the same.
 *
 * "VMAF only" is unticked. That option holds back what the job would otherwise write
 * (a manifest, a thumbnail, a subtitle) and keeps the setting. And a quality gate
 * that waits for a measurement has one: the gate is kept while nothing is measured,
 * and with it the two things about it this view does not show (`HELD_BACK`), which
 * would otherwise be dropped on the way back without being named.
 */
function unsuspended(state: WizardState): WizardState {
	let qc = state.qc;
	if (!qc) return state;
	if (qc.only) qc = without(qc, ["only"]);
	if (qc.gate && !(qc.vmaf || qc.psnr || qc.banding))
		qc = { ...qc, vmaf: true };
	return qc === state.qc ? state : { ...state, qc };
}

/**
 * Hidden fields that are in use whenever they are set, though the plan may not show
 * it yet. The audio guard is a condition on the audio streams: with no audio in the
 * files it is in no plan, and the Format step puts audio in with one click.
 */
const IN_USE_WHEN_SET: readonly (keyof WizardState)[] = ["audioGuard"];

type HeldBackName = "encodings" | "perTitle" | "qualityGate" | "gateTargets";
type HeldBack = {
	/** Switched on, whatever it then holds. */
	set: (state: WizardState) => boolean;
	/** The state without it. */
	strip: (state: WizardState) => WizardState;
};

/**
 * The settings held back from a step the simple view shows: one of the Sources step
 * and three of the Encoding step. Each acts on something the view does not have, so
 * there it would be a control with nothing to act on.
 */
const HELD_BACK: Record<HeldBackName, HeldBack> = {
	// The encodings a job is split into. A stream is put on one of them in the Ladder
	// step, and with more than one the manifests have to be generated after encoding,
	// which the Manifests step sets. A row added here would be refused for both, in
	// words that name two steps this view leaves out.
	encodings: {
		set: (state) => (state.sources?.encodings ?? []).length > 0,
		strip: (state) => {
			const sources = state.sources;
			if (!sources || !("encodings" in sources)) return state;
			const next: WizardState = {
				...state,
				sources: without(sources, ["encodings", "implicitEncodingKeys"]),
			};
			if (isBlank(next.sources)) delete next.sources;
			return next;
		},
	},
	// The Per-Title configuration. A rendition enters Per-Title in the Ladder step.
	// A codec switched on with every field left empty is a configuration too: the
	// plan carries it, and it is switched off where it was switched on.
	perTitle: {
		set: (state) =>
			Object.values(state.startOptions?.perTitle ?? {}).some(
				(codec) => codec !== undefined,
			),
		strip: (state) => {
			const options = state.startOptions;
			if (!options || !("perTitle" in options)) return state;
			const next: WizardState = {
				...state,
				startOptions: without(options, ["perTitle"]),
			};
			// Nothing else is set: the field is as the flow starts it.
			if (isBlank(next.startOptions)) delete next.startOptions;
			return next;
		},
	},
	// A quality gate that holds the manifests back when it fails. Without a manifest
	// to hold back it is refused unless a setting of the Manifests step says when
	// they are generated. So here a failed gate marks the job (and is notified as
	// any failed gate is), and holds nothing back.
	qualityGate: {
		set: (state) => state.qc?.gate?.onFail === "BLOCK_MANIFESTS",
		strip: (state) => {
			const gate = state.qc?.gate;
			return state.qc && gate?.onFail === "BLOCK_MANIFESTS"
				? {
						...state,
						qc: { ...state.qc, gate: { ...gate, onFail: "MARK_ONLY" } },
					}
				: state;
		},
	},
	// The renditions a rule of the gate is for. A rule names them by key, and this
	// view has no keys: it derives the key of a file from its height, bitrate and
	// codec, on every edit and on the way back from the full view. A rule that
	// named one would come to name a key no file has, and the job would be refused
	// for a name this view never shows. So here a rule is for every file.
	gateTargets: {
		set: (state) =>
			(state.qc?.gate?.rules ?? []).some(
				(rule) => (rule.renditions ?? []).length > 0,
			),
		strip: (state) => {
			const gate = state.qc?.gate;
			return state.qc &&
				gate?.rules.some((rule) => rule.renditions !== undefined)
				? {
						...state,
						qc: {
							...state.qc,
							gate: {
								...gate,
								rules: gate.rules.map((rule) => without(rule, ["renditions"])),
							},
						},
					}
				: state;
		},
	},
};

/** As `fieldsInUse`, for a setting held back: set, and the job differs without it. */
function heldBackInUse(state: WizardState): HeldBackName[] {
	const plan = planText(state);
	return (Object.keys(HELD_BACK) as HeldBackName[]).filter(
		(name) =>
			HELD_BACK[name].set(state) &&
			(plan === undefined || planText(HELD_BACK[name].strip(state)) !== plan),
	);
}

/** The state with nothing left in a setting held back. */
function stripHeldBack(state: WizardState): WizardState {
	return Object.values(HELD_BACK).reduce(
		(next, item) => item.strip(next),
		state,
	);
}

// Resource keys and the tokens that track them are bookkeeping of the full wizard's
// editors. They name nothing a file-output job writes, so they neither block the
// simple view nor survive a return to it (`collapseToFileOutput`). A key somebody
// chose is not bookkeeping: see `chosenKey`.
const VIDEO_BOOKKEEPING = ["autoKey"];
const MUXING_BOOKKEEPING = ["key", "autoPath"];
const EXTRAS_BOOKKEEPING = ["key"];

// Every shape the editors give a key on their own: what `videoKeys` and `audioKeys`
// derive (`v1080`, `v1080_8000k`, `v1080_8000k_h265`, `video2`, `a192`,
// `a192_48000`), and any of them numbered to stay apart (`v1080-2`). The ladder
// writes such a key into every row as soon as one is added.
const EDITOR_KEY =
	/^(?:v\d+(?:_\d+k(?:_[a-z0-9]+)?)?|video\d+|a\d+(?:_\d+)?)(?:-\d+)?$/;

/**
 * A key that reads as a name somebody chose, which only a loaded plan can bring: no
 * step has a field for one. The simple view leaves it where it is, as the full view
 * does. `own` is a key the editors are known to have written here.
 */
function chosenKey(key: string | undefined, own?: string): key is string {
	return key !== undefined && key !== own && !EDITOR_KEY.test(key);
}

const VIDEO_FIELDS = [
	"height",
	"bitrate",
	"codec",
	"encodingMode",
	"h264",
	"h265",
	"extras",
	"muxing",
	"extraMuxings",
	...VIDEO_BOOKKEEPING,
];
const AUDIO_FIELDS = [
	"codec",
	"bitrate",
	"rate",
	"channelLayout",
	"extras",
	"muxing",
	"extraMuxings",
];
const FILE_MUXING_FIELDS = [
	"kind",
	"filename",
	"path",
	"muxedAudioKeys",
	...MUXING_BOOKKEEPING,
];
const CARRIED_MUXING_FIELDS = ["ownContainer", "autoOwnContainer"];
const EXTRAS_FIELDS = ["source", ...EXTRAS_BOOKKEEPING];

function setsOnly(value: object | undefined, fields: readonly string[]) {
	return Object.entries(value ?? {}).every(
		([key, item]) => fields.includes(key) || isBlank(item),
	);
}

/**
 * The steps that hold a setting the simple view cannot show, in wizard order.
 * Empty means the whole state is visible there.
 */
export function fileOutputBlockers(state: WizardState): FileOutputBlocker[] {
	const found = new Set<FileOutputBlocker>();
	const lifted = unsuspended(state);
	for (const key of fieldsInUse(lifted)) {
		const home = FILE_OUTPUT_FIELD_HOME[key];
		if (home !== "shown") found.add(home);
	}
	for (const name of heldBackInUse(lifted)) found.add(name);
	if (state.videos.length === 0 || state.audios.length > 1) found.add("ladder");
	const audio = state.audios[0];
	const audioKey = audio ? audioKeys(state.audios)[0] : undefined;
	const videoCodecs = FILE_CONTAINERS.flatMap((item) => item.video);
	const audioCodecs = FILE_CONTAINERS.flatMap((item) => item.audio);
	for (const video of state.videos) {
		if (
			!videoCodecs.includes(video.codec ?? "H264") ||
			!setsOnly(video, VIDEO_FIELDS) ||
			!setsOnly(video.extras, EXTRAS_FIELDS)
		)
			found.add("ladder");
		const carried = (video.muxing?.muxedAudioKeys ?? []).filter(
			(key) => key === audioKey,
		);
		if (
			!fileContainer(video.muxing?.kind) ||
			video.muxing?.path !== "" ||
			!setsOnly(video.muxing, FILE_MUXING_FIELDS) ||
			!isBlank(video.extraMuxings) ||
			carried.length !== (audio ? 1 : 0)
		)
			found.add("packaging");
	}
	if (audio) {
		if (
			!audioCodecs.includes(audio.codec ?? "AAC") ||
			!setsOnly(audio, AUDIO_FIELDS) ||
			!setsOnly(audio.extras, EXTRAS_FIELDS)
		)
			found.add("ladder");
		if (
			audio.muxing?.ownContainer !== false ||
			!setsOnly(audio.muxing, CARRIED_MUXING_FIELDS) ||
			!isBlank(audio.extraMuxings)
		)
			found.add("packaging");
	}
	return FILE_OUTPUT_BLOCKERS.filter((home) => found.has(home));
}

export function isFileOutputState(state: WizardState): boolean {
	return fileOutputBlockers(state).length === 0;
}

/**
 * Return a state the full wizard edited to the form this flow's edits expect: the
 * editors' keys derived again, each file pointing at the audio track's current key,
 * and nothing left in a field or a setting the simple view does not show
 * (`HIDDEN_FIELDS`, `HELD_BACK`). Call it only on a state `isFileOutputState`
 * accepts. The files written do not change, because here every file name and folder
 * is explicit, and what is cleared was doing nothing, one click of the Encoding step
 * later or not (`fieldsInUse`, `unsuspended`). A copy the quality check measures is
 * named by its stream's key, so it can be renamed where a key is derived again. A
 * key a loaded plan chose stays (`chosenKey`), and so does the number that kept a
 * copy apart (`apart`).
 */
export function collapseToFileOutput(state: WizardState): WizardState {
	const unkeyed = <T extends { extras?: WizardRenditionExtras }>(
		item: T,
		own?: string,
	): T => {
		const extras = chosenKey(item.extras?.key, own)
			? (item.extras ?? {})
			: without(item.extras ?? {}, EXTRAS_BOOKKEEPING);
		return defined({ ...item, extras: isBlank(extras) ? undefined : extras });
	};
	const audios = state.audios.map((audio) => unkeyed(audio));
	const videos = state.videos.map((video) => {
		const muxing = without(video.muxing ?? {}, MUXING_BOOKKEEPING);
		return {
			...without(unkeyed(video, video.autoKey), VIDEO_BOOKKEEPING),
			// A container keyed as its stream is, is the editors' doing as well.
			muxing: chosenKey(video.muxing?.key, video.extras?.key)
				? { ...muxing, key: video.muxing.key }
				: muxing,
		};
	});
	return {
		...stripHeldBack(reset(state, HIDDEN_FIELDS)),
		audios,
		videos: carrying(apart(videos, videoKeys(state.videos)), audios),
	};
}

/**
 * The ladder copies a row and numbers the copy's key (`v1080`, `v1080-2`): two files
 * with one height, bitrate and codec, which the plan holds as two streams. Derived
 * again, both would get one key, and a job the full view accepts would be refused
 * here. So a row that had a key of its own (`before`) and would now share one keeps a
 * number: its own key if that is numbered, which no row derives, and the shared key
 * numbered otherwise. Rows that already had one key between them are left to be
 * refused, as they were.
 */
function apart(
	videos: WizardVideoRendition[],
	before: readonly string[],
): WizardVideoRendition[] {
	const keys = videoKeys(videos);
	const taken = new Set(keys);
	const met = new Set<string>();
	return videos.map((video, index) => {
		const key = keys[index] ?? "";
		const own = before[index] ?? "";
		const first = !met.has(key);
		met.add(key);
		if (first || before.indexOf(own) !== before.lastIndexOf(own)) return video;
		let numbered = own;
		for (let n = 2; !/-\d+$/.test(numbered) || taken.has(numbered); n++)
			numbered = `${key}-${n}`;
		taken.add(numbered);
		return { ...video, extras: { ...video.extras, key: numbered } };
	});
}

/** One thing the job leaves in storage. A `path` that ends in "/" is a folder. */
export type FileJobWrite = {
	kind: "file" | "analysis" | "qcMirror" | "kantarReport";
	/** Apart from every other entry of the list, also when two paths are equal. */
	key: string;
	path: string;
};

/**
 * What a file-output job writes to its destination, for the Review step: the files,
 * unless the job only measures (`qc.only`), which writes none of them. After them,
 * what the Encoding step adds: the result of AI Scene Analysis, the folder of the
 * copies the quality check scores, and the folder of the Kantar report.
 *
 * A path starts with the bucket or container of the output it is written to, where
 * that kind of storage has one, and reads the same however its folder was typed
 * ("exports", "exports/", "/exports/").
 */
export function fileJobWrites(plan: EncodingPlan): FileJobWrite[] {
	const root = (outputKey: string) => {
		const output = plan.outputs.find((item) => item.key === outputKey);
		if (!output) return "";
		if ("bucket" in output) return output.bucket;
		return "container" in output ? output.container : "";
	};
	// A path is a folder, with or without its slash.
	const at = (
		destination: { outputKey: string; path: string },
		name?: string,
	) => {
		const parts = [
			root(destination.outputKey),
			...destination.path.split("/"),
		].filter(Boolean);
		return name === undefined
			? `${parts.join("/")}/`
			: [...parts, name].join("/");
	};
	const files = plan.qc?.only
		? []
		: plan.muxings.flatMap((muxing): FileJobWrite[] =>
				"filename" in muxing && muxing.filename && muxing.destination
					? [
							{
								kind: "file",
								key: `file:${muxing.key}`,
								path: at(muxing.destination, muxing.filename),
							},
						]
					: [],
			);
	const analysis = plan.aiSceneAnalysis?.assetDescription;
	const mirrors = new Set(
		storageSummaries(plan).outputs.flatMap((output) =>
			output.paths
				.filter((item) => item.role === "qc")
				.map((item) => at({ outputKey: output.key, path: item.path })),
		),
	);
	return [
		...files,
		...(analysis
			? [
					{
						kind: "analysis" as const,
						key: "analysis",
						path: at(analysis.destination, analysis.filename),
					},
				]
			: []),
		...[...mirrors].map((path) => ({
			kind: "qcMirror" as const,
			key: `qcMirror:${path}`,
			path,
		})),
		...(plan.kantar
			? [
					{
						kind: "kantarReport" as const,
						key: "kantarReport",
						path: at(plan.kantar.reportDestination),
					},
				]
			: []),
	];
}
