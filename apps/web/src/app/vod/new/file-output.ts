import { outputFilePath } from "@bitovp/core";
import {
	audioKeys,
	DEFAULT_WIZARD_STATE,
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
 * format screen makes, and the test for whether a state can be shown on that screen
 * without leaving a setting out of sight.
 */

export type FileContainer = {
	kind: WizardMuxingKind;
	/** A format name, the same in every locale. */
	label: string;
	extension: string;
	video: readonly WizardVideoCodec[];
	audio: readonly WizardAudioCodec[];
};

/** Containers the flow offers, with the codecs its screen can configure for each. */
export const FILE_CONTAINERS: readonly FileContainer[] = [
	{
		kind: "MP4",
		label: "MP4 (.mp4)",
		extension: "mp4",
		video: ["H264", "H265"],
		audio: ["AAC", "AC3", "EAC3"],
	},
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

/** The part of a derived file name that comes from the job name. */
export function fileStem(name: string): string {
	return name.trim().replace(/[/\\?#]+/g, "-") || "output";
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
 * Files that write the name another file writes. Every file goes to the one folder,
 * so two files with one name are one file, and the plan is refused for it
 * (`PLAN_OUTPUT_FILE_COLLISION`). This says which names to change, and can say so
 * before the rest of the form is complete enough to validate.
 */
export function sharedFileNames(
	videos: readonly WizardVideoRendition[],
): boolean[] {
	const names = videos.map((video) => {
		const name = video.muxing?.filename ?? "";
		// A placeholder gets its value at the provider, so nothing is known here.
		return name === "" || /[%{}]/.test(name)
			? undefined
			: outputFilePath("", name);
	});
	return names.map(
		(name, index) =>
			name !== undefined &&
			names.some((other, at) => at !== index && other === name),
	);
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

/** Rename the job; file names that were derived from the old name follow. */
export function renameFileJob(
	state: WizardState,
	name: string,
): Pick<WizardState, "name" | "videos"> {
	return { name, videos: named(name, state.videos, derivedNames(state)) };
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
		name = filename;
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
 * Where a setting lives that the simple view does not show. `basics` is a shown step
 * with one control held back; the rest are the steps the view leaves out.
 */
export const FILE_OUTPUT_BLOCKERS = [
	"basics",
	"ladder",
	"packaging",
	"encoding",
	"manifests",
] as const;
export type FileOutputBlocker = (typeof FILE_OUTPUT_BLOCKERS)[number];

/**
 * Every top-level field is either shown by the simple view or owned by a step it
 * hides. A field added to `WizardState` fails typechecking here until it is placed,
 * which is the point: an unplaced field would be a setting the view could hide.
 */
const FIELD_HOME: Record<keyof WizardState, "shown" | FileOutputBlocker> = {
	name: "shown",
	accountId: "shown",
	cloudRegion: "shown",
	encoderVersion: "shown",
	inputFiles: "shown",
	audioInputFile: "shown",
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
	labels: "encoding",
	infrastructure: "encoding",
	prewarmedEncoderPoolIds: "encoding",
	startOptions: "encoding",
	qc: "encoding",
	kantar: "encoding",
	manifests: "manifests",
	timing: "manifests",
};

// Resource keys and the tokens that track them are bookkeeping of the full wizard's
// editors. They name nothing a file-output job writes, so they neither block the
// simple view nor survive a return to it (`collapseToFileOutput`).
const VIDEO_BOOKKEEPING = ["autoKey"];
const MUXING_BOOKKEEPING = ["key", "autoPath"];
const EXTRAS_BOOKKEEPING = ["key"];

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
	for (const key of Object.keys(state) as (keyof WizardState)[]) {
		const home = FIELD_HOME[key];
		if (home !== "shown" && !same(state[key], FILE_OUTPUT_DEFAULT_STATE[key]))
			found.add(home);
	}
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
 * Return a state the full wizard edited to the form this flow's edits expect: keys
 * derived again, each file pointing at the audio track's current key. Call it only on
 * a state `isFileOutputState` accepts. The files written do not change, because here
 * every file name and folder is explicit.
 */
export function collapseToFileOutput(state: WizardState): WizardState {
	const unkeyed = <T extends { extras?: WizardRenditionExtras }>(
		item: T,
	): T => {
		const extras = without(item.extras ?? {}, EXTRAS_BOOKKEEPING);
		return defined({ ...item, extras: isBlank(extras) ? undefined : extras });
	};
	const audios = state.audios.map(unkeyed);
	const videos = state.videos.map((video) => ({
		...without(unkeyed(video), VIDEO_BOOKKEEPING),
		muxing: without(video.muxing ?? {}, MUXING_BOOKKEEPING),
	}));
	return { ...state, audios, videos: carrying(videos, audios) };
}
