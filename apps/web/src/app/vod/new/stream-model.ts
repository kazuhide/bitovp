import type { CredentialSummaryWire } from "@bitovp/core";
import {
	implicitTrackKeys,
	type WizardDolbyStream,
	type WizardFileStream,
	type WizardHdr10PlusStream,
	type WizardIngestTrack,
	type WizardInputFile,
	type WizardSources,
	type WizardState,
	type WizardStreamSelectionMode,
} from "./build-plan";

/**
 * Shared predicate: does this credential id back an S3 (browsable) provider?
 * Consolidates the per-call-site copies the browse-default wiring grew (PR-A
 * follow-up) so the "auto-open the picker on select" decision lives in one
 * place.
 */
export function isS3Credential(
	credentials: CredentialSummaryWire[],
	id: string,
): boolean {
	return isBrowsableProvider(credentials.find((c) => c.id === id)?.provider);
}

/**
 * The object-storage providers the StoragePicker can browse AND that map to a
 * plan input/output kind (mirrors packages/storage factory.ts). Azure/SFTP/
 * role-based/DRM/live-ingest providers are excluded (no object browse). This is
 * the single source of truth for the wizard's input/output picker filters.
 */
export const BROWSABLE_STORAGE_PROVIDERS = [
	"AWS_S3",
	"AKAMAI_OBJECT_STORAGE",
	"OCI_OBJECT_STORAGE",
	"GENERIC_S3",
	"GCS_HMAC",
	"GCS_SERVICE_ACCOUNT",
] as const;

export function isBrowsableProvider(provider: string | undefined): boolean {
	return (BROWSABLE_STORAGE_PROVIDERS as readonly string[]).includes(
		provider ?? "",
	);
}

/**
 * Provider → wizard storage kind. Akamai/OCI/GenericS3 all collapse to the one
 * GENERIC_S3 plan kind (C10 — S3-compatible, V4 signing); GCS-HMAC → GCS;
 * GCS-service-account → GCS_SERVICE_ACCOUNT; AWS_S3 → S3; AZURE_BLOB → AZURE;
 * SFTP → SFTP. Returns null for providers with no I/O kind (role-based, DRM,
 * live-ingest) — callers must skip rather than collapse to S3.
 */
export function storageKindForProvider(
	provider: string | undefined,
): WizardState["output"]["kind"] | null {
	switch (provider) {
		case "AWS_S3":
			return "S3";
		case "AZURE_BLOB":
			return "AZURE";
		case "SFTP":
			return "SFTP";
		//  — NOT folded into GENERIC_S3 with AKAMAI_OBJECT_STORAGE
		// below: that is Akamai's S3-compatible service and this is NetStorage,
		// a different protocol with a different credential shape. One dropdown
		// entry apart, and collapsing them would send an upload account where a
		// key pair belongs.
		case "AKAMAI_NETSTORAGE":
			return "AKAMAI_NETSTORAGE";
		case "AKAMAI_OBJECT_STORAGE":
		case "OCI_OBJECT_STORAGE":
		case "GENERIC_S3":
			return "GENERIC_S3";
		case "GCS_HMAC":
			return "GCS";
		case "GCS_SERVICE_ACCOUNT":
			return "GCS_SERVICE_ACCOUNT";
		default:
			return null;
	}
}

/** Input pickers accept any browsable provider (no SFTP — SFTP is output-only). */
export function inputKindForProvider(
	provider: string | undefined,
): WizardInputFile["kind"] | null {
	const kind = storageKindForProvider(provider);
	// SFTP is output-only; the input union also has HTTPS but no provider maps
	// to it (HTTPS inputs are credential-less). Everything else is shared.
	return kind === null || kind === "SFTP" ? null : kind;
}

/** Output pickers additionally accept SFTP. */
export function outputKindForProvider(
	provider: string | undefined,
): WizardState["output"]["kind"] | null {
	return storageKindForProvider(provider);
}

/**
 * LIVE outputs are a superset of VOD's: Akamai MSL is live delivery, and a
 * VOD encoding has nothing to do with it (live-to-VOD refuses an MSL output
 * outright — no bucket, no path, nowhere to write).
 *
 * This exists because sharing the VOD mapping quietly BROKE MSL.
 * shipped a bespoke destination selector, then a refactor deleted it on the
 * correct premise that "MSL is a credential now, so the credential picker sets
 * the kind" — and never added the case that makes that true. The provider
 * mapped to `null`, `outputSelectable` read `null` as "not an output", and the
 * live wizard greyed out the one credential an Akamai customer has. The owner
 * created an MSL4 credential and could not select it.
 *
 * The type is the reason it went unnoticed: `storageKindForProvider` returns
 * the VOD union, so an `AKAMAI_MSL` case could not have been added to it even
 * by someone looking straight at the function. The live step needs its own
 * mapping, and now says so.
 */
export function liveOutputKindForProvider(
	provider: string | undefined,
):
	| WizardState["output"]["kind"]
	| "AKAMAI_MSL"
	| "LIVE_MEDIA_INGEST"
	| "MOQ"
	| null {
	if (provider === "MOQ") return "MOQ";
	if (provider === "LIVE_MEDIA_INGEST") return "LIVE_MEDIA_INGEST";
	return provider === "AKAMAI_MSL"
		? "AKAMAI_MSL"
		: storageKindForProvider(provider);
}

/** Bucket label per output kind ("Container" for Azure, else "Bucket"). */
export function outputLocationLabel(
	kind: WizardState["output"]["kind"] | "LIVE_MEDIA_INGEST",
): string {
	return kind === "AZURE" ? "Container" : "Bucket";
}

/** The default Bitmovin output resource name for a kind. */
export function outputNameForKind(kind: WizardState["output"]["kind"]): string {
	switch (kind) {
		case "SFTP":
			return "SFTP Output";
		case "AZURE":
			return "Azure Output";
		case "GENERIC_S3":
			return "Generic S3 Output";
		case "GCS":
			return "GCS Output";
		case "GCS_SERVICE_ACCOUNT":
			return "GCS Service Account Output";
		default:
			return "S3 Output";
	}
}

/**
 * Whether an output kind carries an object ACL (PUBLIC_READ/PRIVATE). The
 * S3-family and GCS buckets do; Azure containers and SFTP do not.
 */
export function outputKindHasAcl(kind: WizardState["output"]["kind"]): boolean {
	return (
		kind !== "AZURE" &&
		kind !== "SFTP" &&
		//  — NetStorage has no object ACLs and no S3 browse API.
		kind !== "AKAMAI_NETSTORAGE"
	);
}

/** Output kinds whose location is browsable via the StoragePicker. */
export function outputKindIsBrowsable(
	kind: WizardState["output"]["kind"] | "LIVE_MEDIA_INGEST" | "MOQ",
): boolean {
	return (
		kind !== "MOQ" &&
		kind !== "LIVE_MEDIA_INGEST" &&
		kind !== "AZURE" &&
		kind !== "SFTP" &&
		//  — NetStorage has no object ACLs and no S3 browse API.
		kind !== "AKAMAI_NETSTORAGE"
	);
}

/**
 * The unified "Streams" row the Sources UI presents over the WizardSources
 * arrays (ingest tracks, file streams, Dolby and HDR10+ streams).
 * Internal resource keys are hidden from the user; this view-model
 * still carries `key`/`inputKey`/`encodingKey` so every edit maps back to the
 * exact array element and the emitted plan is byte-identical (the round-trip
 * gate is unaffected — this is presentation only).
 */
export type UnifiedStreamType =
	| "INGEST"
	| "WEBVTT"
	| "TTML"
	| "ATMOS"
	| "VISION"
	| "VISION_METADATA"
	| "HDR10_PLUS";

export type UnifiedStreamOrigin =
	| "track"
	| "fileStream"
	| "dolby"
	| "hdr10Plus";

export type UnifiedStream = {
	/** Identity into the underlying WizardSources arrays (valid per render). */
	origin: UnifiedStreamOrigin;
	index: number;
	type: UnifiedStreamType;
	/** Hidden internal resource key. */
	key: string;
	encodingKey?: string;
	/** Input file (object) this stream reads — its path lives on the file. */
	inputFile: string;
	/** VISION only: optional separate metadata-sidecar input file. */
	metadataInputFile?: string;
	/** HDR10_PLUS only: JSON sidecar path on the video's same input. */
	metadataInputPath?: string;
	/** ATMOS only. */
	inputFormat?: "DAMF" | "ADM" | "MXF";
	/** INGEST and HDR10_PLUS; HDR10_PLUS excludes AUDIO_RELATIVE. */
	selectionMode?: WizardStreamSelectionMode;
	position?: number;
};

const TYPE_LABELS: Record<UnifiedStreamType, string> = {
	INGEST: "Ingest track",
	WEBVTT: "WebVTT subtitle",
	TTML: "TTML / IMSC subtitle",
	ATMOS: "Dolby Atmos",
	VISION: "Dolby Vision",
	VISION_METADATA: "Vision metadata",
	HDR10_PLUS: "HDR10+",
};

const KEY_PREFIXES: Record<UnifiedStreamType, string> = {
	INGEST: "track",
	WEBVTT: "vtt",
	TTML: "ttml",
	ATMOS: "atmos",
	VISION: "dv",
	VISION_METADATA: "dv-meta",
	HDR10_PLUS: "hdr10plus",
};

export const UNIFIED_STREAM_TYPES: UnifiedStreamType[] = [
	"INGEST",
	"WEBVTT",
	"TTML",
	"ATMOS",
	"VISION",
	"VISION_METADATA",
	"HDR10_PLUS",
];

export function streamTypeLabel(type: UnifiedStreamType): string {
	return TYPE_LABELS[type];
}

/** Flatten the three source arrays into one ordered, origin-tagged list. */
export function flattenStreams(sources: WizardSources): UnifiedStream[] {
	const rows: UnifiedStream[] = [];
	(sources.tracks ?? []).forEach((t, index) => {
		rows.push({
			origin: "track",
			index,
			type: "INGEST",
			key: t.key,
			encodingKey: t.encodingKey,
			inputFile: t.inputFile,
			selectionMode: t.selectionMode,
			position: t.position,
		});
	});
	(sources.fileStreams ?? []).forEach((s, index) => {
		rows.push({
			origin: "fileStream",
			index,
			type: s.fileType ?? "WEBVTT",
			key: s.key,
			encodingKey: s.encodingKey,
			inputFile: s.inputFile,
		});
	});
	(sources.dolbyStreams ?? []).forEach((s, index) => {
		if (s.kind === "VISION") {
			rows.push({
				origin: "dolby",
				index,
				type: "VISION",
				key: s.key,
				encodingKey: s.encodingKey,
				inputFile: s.videoInputFile,
				metadataInputFile: s.metadataInputFile,
			});
			return;
		}
		rows.push({
			origin: "dolby",
			index,
			type: s.kind === "ATMOS" ? "ATMOS" : "VISION_METADATA",
			key: s.key,
			encodingKey: s.encodingKey,
			inputFile: s.inputFile,
			inputFormat: s.kind === "ATMOS" ? s.inputFormat : undefined,
		});
	});
	(sources.hdr10PlusStreams ?? []).forEach((stream, index) => {
		rows.push({
			origin: "hdr10Plus",
			index,
			type: "HDR10_PLUS",
			key: stream.key,
			encodingKey: stream.encodingKey,
			inputFile: stream.videoInputFile,
			metadataInputPath: stream.metadataInputPath,
			selectionMode: stream.selectionMode,
			position: stream.position,
		});
	});
	return rows;
}

function toHdr10Plus(row: UnifiedStream): WizardHdr10PlusStream {
	return {
		key: row.key,
		videoInputFile: row.inputFile,
		metadataInputPath: row.metadataInputPath ?? "",
		selectionMode: (row.selectionMode ??
			"AUTO") as WizardHdr10PlusStream["selectionMode"],
		...(row.position !== undefined ? { position: row.position } : {}),
		encodingKey: row.encodingKey,
	};
}

/** Rebuild the native ingest-track element from a unified row. */
function toTrack(row: UnifiedStream): WizardIngestTrack {
	return {
		key: row.key,
		inputFile: row.inputFile,
		selectionMode: row.selectionMode ?? "AUTO",
		position: row.position ?? 0,
		encodingKey: row.encodingKey,
	};
}

function toFileStream(row: UnifiedStream): WizardFileStream {
	return {
		...(row.type === "TTML" ? { fileType: "TTML" as const } : {}),
		key: row.key,
		inputFile: row.inputFile,
		encodingKey: row.encodingKey,
	};
}

function toDolby(row: UnifiedStream): WizardDolbyStream {
	if (row.type === "VISION") {
		return {
			kind: "VISION",
			key: row.key,
			videoInputFile: row.inputFile,
			metadataInputFile: row.metadataInputFile,
			encodingKey: row.encodingKey,
		};
	}
	if (row.type === "ATMOS") {
		return {
			kind: "ATMOS",
			key: row.key,
			inputFile: row.inputFile,
			inputFormat: row.inputFormat ?? "DAMF",
			encodingKey: row.encodingKey,
		};
	}
	return {
		kind: "VISION_METADATA",
		key: row.key,
		inputFile: row.inputFile,
		encodingKey: row.encodingKey,
	};
}

const originFor = (type: UnifiedStreamType): UnifiedStreamOrigin =>
	type === "INGEST"
		? "track"
		: type === "HDR10_PLUS"
			? "hdr10Plus"
			: type === "WEBVTT" || type === "TTML"
				? "fileStream"
				: "dolby";

/** Write an edited unified row back into its native array (same origin/type). */
export function writeStream(
	sources: WizardSources,
	row: UnifiedStream,
): WizardSources {
	if (row.origin === "hdr10Plus") {
		const hdr10PlusStreams = [...(sources.hdr10PlusStreams ?? [])];
		hdr10PlusStreams[row.index] = toHdr10Plus(row);
		return { ...sources, hdr10PlusStreams };
	}
	if (row.origin === "track") {
		const tracks = [...(sources.tracks ?? [])];
		tracks[row.index] = toTrack(row);
		return { ...sources, tracks };
	}
	if (row.origin === "fileStream") {
		const fileStreams = [...(sources.fileStreams ?? [])];
		fileStreams[row.index] = toFileStream(row);
		return { ...sources, fileStreams };
	}
	const dolbyStreams = [...(sources.dolbyStreams ?? [])];
	dolbyStreams[row.index] = toDolby(row);
	return { ...sources, dolbyStreams };
}

/** Remove a unified row from its native array. */
export function removeStream(
	sources: WizardSources,
	row: UnifiedStream,
): WizardSources {
	if (row.origin === "hdr10Plus") {
		return {
			...sources,
			hdr10PlusStreams: (sources.hdr10PlusStreams ?? []).filter(
				(_, index) => index !== row.index,
			),
		};
	}
	if (row.origin === "track") {
		return {
			...sources,
			tracks: (sources.tracks ?? []).filter((_, i) => i !== row.index),
		};
	}
	if (row.origin === "fileStream") {
		return {
			...sources,
			fileStreams: (sources.fileStreams ?? []).filter(
				(_, i) => i !== row.index,
			),
		};
	}
	return {
		...sources,
		dolbyStreams: (sources.dolbyStreams ?? []).filter(
			(_, i) => i !== row.index,
		),
	};
}

/** A JSON sidecar belongs to the chosen video object. Re-select it after moving the video. */
export function reconcileHdr10PlusSidecars(
	previous: WizardState,
	next: WizardState,
): WizardState {
	const streams = next.sources?.hdr10PlusStreams;
	if (
		!streams?.length ||
		(previous.inputFiles === next.inputFiles &&
			previous.sources === next.sources)
	)
		return next;
	const changed = streams.map((stream) => {
		const old = previous.sources?.hdr10PlusStreams?.find(
			(row) => row.key === stream.key,
		);
		if (
			!stream.metadataInputPath ||
			old?.metadataInputPath !== stream.metadataInputPath
		)
			return stream;
		const before = previous.inputFiles.find(
			(file) => file.key === old.videoInputFile,
		);
		const after = next.inputFiles.find(
			(file) => file.key === stream.videoInputFile,
		);
		if (
			before &&
			after &&
			before.kind === after.kind &&
			before.credentialId === after.credentialId &&
			before.bucket === after.bucket &&
			before.path === after.path &&
			before.region === after.region
		)
			return stream;
		return { ...stream, metadataInputPath: "" };
	});
	return changed.some((row, index) => row !== streams[index])
		? { ...next, sources: { ...next.sources, hdr10PlusStreams: changed } }
		: next;
}

/** Carry explicit and ordinary source bindings together across a graph edit. */
export function sourceGraphPatch(
	state: WizardState,
	patch: Partial<WizardState> & { sources: WizardSources },
	renamed?: [string, string],
): Partial<WizardState> {
	const implicit = implicitTrackKeys(state.sources ?? {});
	const next = patch.sources;
	const nextImplicit = implicitTrackKeys(next);
	const mapped = new Map<string, string>(renamed ? [renamed] : []);
	for (const kind of ["video", "audio"] as const) {
		if (implicit[kind] !== nextImplicit[kind])
			mapped.set(implicit[kind], nextImplicit[kind]);
	}
	if (!mapped.size) return patch;
	const remap = <T extends { sourceKey: string }>(row: T): T => {
		const sourceKey = mapped.get(row.sourceKey);
		return sourceKey === undefined ? row : { ...row, sourceKey };
	};
	const mapRendition = <T extends { extras?: { source?: string } }>(
		row: T,
	): T =>
		row.extras?.source && mapped.has(row.extras.source)
			? {
					...row,
					extras: { ...row.extras, source: mapped.get(row.extras.source) },
				}
			: row;
	return {
		...patch,
		videos: (patch.videos ?? state.videos).map(mapRendition),
		audios: (patch.audios ?? state.audios).map(mapRendition),
		sources: {
			...next,
			audioMixStreams: next.audioMixStreams?.map((mix) => ({
				...mix,
				audioMixChannels: mix.audioMixChannels.map(remap),
			})),
			trimmingStreams: next.trimmingStreams?.map(remap),
			concatenationStreams: next.concatenationStreams?.map((row) => ({
				...row,
				sources: row.sources.map(remap),
			})),
		},
	};
}

function sourceReferences(sources: WizardSources, state?: WizardState) {
	return new Set([
		...(state?.videos ?? []).map((r) => r.extras?.source),
		...(state?.audios ?? []).map((r) => r.extras?.source),
		...(state?.subtitles ?? []).map((r) => r.source),
		...(sources.trimmingStreams ?? []).map((r) => r.sourceKey),
		...(sources.concatenationStreams ?? []).flatMap((r) =>
			r.sources.map((s) => s.sourceKey),
		),
		...(sources.audioMixStreams ?? []).flatMap((r) =>
			r.audioMixChannels.map((c) => c.sourceKey),
		),
	]);
}

/** Removing a named source must not turn its explicit bindings into ordinary input. */
export function removalCapturesSource(
	state: WizardState,
	next: WizardSources,
	key: string,
): boolean {
	const allocated = implicitTrackKeys(next);
	const isHdrSource = state.sources?.hdr10PlusStreams?.some(
		(row) => row.key === key,
	);
	if (!isHdrSource && key !== allocated.video && key !== allocated.audio)
		return false;
	return sourceReferences(next, state).has(key);
}

/** Auto-generate a unique, hidden resource key across every stream array. */
export function nextStreamKey(
	sources: WizardSources,
	type: UnifiedStreamType,
	state?: WizardState,
): string {
	return nextSharedKey(sources, KEY_PREFIXES[type], state);
}

export function nextSharedKey(
	sources: WizardSources,
	prefix: string,
	state?: WizardState,
): string {
	// An older draft can retain bindings to a source it no longer defines.
	const taken = new Set([
		...sourceReferences(sources, state),
		...(sources.tracks ?? []).map((t) => t.key),
		...(sources.fileStreams ?? []).map((s) => s.key),
		...(sources.dolbyStreams ?? []).map((s) => s.key),
		...(sources.hdr10PlusStreams ?? []).map((s) => s.key),
		...(sources.trimmingStreams ?? []).map((s) => s.key),
		...(sources.concatenationStreams ?? []).map((s) => s.key),
		...(sources.audioMixStreams ?? []).map((s) => s.key),
	]);
	let n = 1;
	while (taken.has(`${prefix}${n}`)) {
		n += 1;
	}
	return `${prefix}${n}`;
}

/** A blank stream of the requested type, ready to append to its array. */
export function blankStream(
	sources: WizardSources,
	type: UnifiedStreamType,
	inputFile = "main",
	state?: WizardState,
): WizardSources {
	const key = nextStreamKey(sources, type, state);
	// New streams read the primary input file by default; the user repoints them.
	if (type === "HDR10_PLUS") {
		return {
			...sources,
			hdr10PlusStreams: [
				...(sources.hdr10PlusStreams ?? []),
				{
					key,
					videoInputFile: inputFile,
					metadataInputPath: "",
					selectionMode: "AUTO",
				},
			],
		};
	}

	if (type === "INGEST") {
		return {
			...sources,
			tracks: [
				...(sources.tracks ?? []),
				{ key, inputFile, selectionMode: "AUTO", position: 0 },
			],
		};
	}
	if (type === "WEBVTT" || type === "TTML") {
		return {
			...sources,
			fileStreams: [
				...(sources.fileStreams ?? []),
				{
					key,
					inputFile,
					...(type === "TTML" ? { fileType: "TTML" as const } : {}),
				},
			],
		};
	}
	const dolby: WizardDolbyStream =
		type === "ATMOS"
			? { kind: "ATMOS", key, inputFile, inputFormat: "DAMF" }
			: type === "VISION"
				? { kind: "VISION", key, videoInputFile: inputFile }
				: { kind: "VISION_METADATA", key, inputFile };
	return { ...sources, dolbyStreams: [...(sources.dolbyStreams ?? []), dolby] };
}

/**
 * Change a row's type in place: remove it from its old array and append a
 * reshaped element to the new type's array, preserving key/inputKey/encoding
 * and the primary path where it still makes sense.
 */
export function convertStreamType(
	sources: WizardSources,
	row: UnifiedStream,
	type: UnifiedStreamType,
): WizardSources {
	if (type === row.type) {
		return sources;
	}
	const removed = removeStream(sources, row);
	const reshaped: UnifiedStream = {
		...row,
		origin: originFor(type),
		index: -1,
		type,
		// Reset type-specific fields the new shape may not carry.
		metadataInputFile: type === "VISION" ? row.metadataInputFile : undefined,
		metadataInputPath:
			type === "HDR10_PLUS" ? row.metadataInputPath : undefined,
		inputFormat: type === "ATMOS" ? (row.inputFormat ?? "DAMF") : undefined,
		selectionMode:
			type === "INGEST"
				? (row.selectionMode ?? "AUTO")
				: type === "HDR10_PLUS"
					? row.selectionMode === "AUDIO_RELATIVE"
						? "AUTO"
						: (row.selectionMode ?? "AUTO")
					: undefined,
		position:
			type === "INGEST"
				? (row.position ?? 0)
				: type === "HDR10_PLUS" &&
						row.selectionMode !== "AUTO" &&
						row.selectionMode !== "AUDIO_RELATIVE"
					? row.position
					: undefined,
	};
	if (type === "HDR10_PLUS") {
		return {
			...removed,
			hdr10PlusStreams: [
				...(removed.hdr10PlusStreams ?? []),
				toHdr10Plus(reshaped),
			],
		};
	}
	if (type === "INGEST") {
		return {
			...removed,
			tracks: [...(removed.tracks ?? []), toTrack(reshaped)],
		};
	}
	if (type === "WEBVTT" || type === "TTML") {
		return {
			...removed,
			fileStreams: [...(removed.fileStreams ?? []), toFileStream(reshaped)],
		};
	}
	return {
		...removed,
		dolbyStreams: [...(removed.dolbyStreams ?? []), toDolby(reshaped)],
	};
}

/**
 * Input-stream keys a trimming/concatenation stream (or a rendition) can wrap
 * by sourceKey: the implicit video/audio pair, every extra ingest track, Dolby
 * streams, and (optionally) other trimming/concat streams. `excludeKey` drops a
 * stream's own key so it cannot reference itself.
 */
export function sourceStreamKeys(
	state: WizardState,
	options: {
		includeTrimming?: boolean;
		includeConcat?: boolean;
		excludeKey?: string;
	} = {},
): string[] {
	const sources = state.sources ?? {};
	const implicit = implicitTrackKeys(sources);
	const keys: string[] = [];
	if (state.videos.length > 0) {
		keys.push(implicit.video);
	}
	if (state.audios.length > 0) {
		keys.push(implicit.audio);
	}
	for (const t of sources.tracks ?? []) {
		keys.push(t.key);
	}
	for (const d of sources.dolbyStreams ?? []) {
		keys.push(d.key);
	}
	const hdrKeys = new Set(
		(sources.hdr10PlusStreams ?? []).map((stream) => stream.key),
	);
	if (options.includeTrimming) {
		for (const t of sources.trimmingStreams ?? []) {
			keys.push(t.key);
		}
	}
	if (options.includeConcat) {
		for (const c of sources.concatenationStreams ?? []) {
			keys.push(c.key);
		}
	}
	return keys.filter(
		(k) => k !== options.excludeKey && k !== "" && !hdrKeys.has(k),
	);
}

/** One selectable input file (object) a stream can read. */
export type InputFileOption = { key: string; label: string; path: string };

const describeFile = (bucket: string, path: string) =>
	`${bucket || "(no bucket)"} / ${path || "(no object path)"}`;

export function inputFileOptions(state: WizardState): InputFileOption[] {
	return state.inputFiles.map((f) => ({
		key: f.key,
		label: describeFile(f.bucket, f.path),
		path: f.path,
	}));
}

/** Short human label for an input file by key (its bucket, or "(missing)"). */
export function inputFileShortLabel(
	state: WizardState,
	fileKey: string | undefined,
): string {
	const key = fileKey ?? state.inputFiles[0]?.key;
	const file = state.inputFiles.find((f) => f.key === key);
	return file ? file.bucket || "input" : `${fileKey} (missing input)`;
}

/**
 * Human-readable label for referencing a stream from renditions/subtitles —
 * "Dolby Vision · bucket / object.mp4" rather than the raw internal key. The
 * select still stores the key; only the visible text changes (no plan impact).
 */
export function streamReferenceLabel(
	state: WizardState,
	stream: UnifiedStream,
): string {
	const file = state.inputFiles.find((f) => f.key === stream.inputFile);
	const where = file ? file.bucket || "input" : "(missing input)";
	const object = file?.path || "(no object path)";
	return `${streamTypeLabel(stream.type)} · ${where} / ${object}`;
}

/**
 * When a stream a rendition reads from leaves the video/audio source family
 * (i.e. becomes WEBVTT, which only subtitles can reference), revert those
 * renditions to the implicit track instead of stranding a dangling
 * `extras.source` the preview would flag as PLAN_UNRESOLVED_REF. Returns only
 * the touched slices so it composes with an existing patch.
 */
export function clearStreamReferences(
	state: WizardState,
	key: string,
): Partial<WizardState> {
	const clear = <R extends { extras?: { source?: string } }>(rends: R[]): R[] =>
		rends.map((r) =>
			r.extras?.source === key
				? { ...r, extras: { ...r.extras, source: undefined } }
				: r,
		);
	const patch: Partial<WizardState> = {};
	if (state.videos.some((v) => v.extras?.source === key)) {
		patch.videos = clear(state.videos);
	}
	if (state.audios.some((a) => a.extras?.source === key)) {
		patch.audios = clear(state.audios);
	}
	return patch;
}
