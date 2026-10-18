/**
 * Storage object inspection (P5 PR-5) — shared wire contract + probe
 * presentation helpers for the storage browser's "Inspect" action.
 *
 * The inspection itself runs in the WORKER (ffprobe lives in that image and the
 * read touches customer storage with vault credentials); the web layer only
 * writes a row, enqueues, and polls. See apps/worker/src/inspect/processor.ts.
 *
 * Everything here is pure and UI-free so both the route handlers and the client
 * dialog can import it (the `@/app/qc/vmaf-shared` precedent).
 */

/** StorageInspection.status — mirrors the Prisma enum. */
export const STORAGE_INSPECTION_STATUSES = [
	"PENDING",
	"RUNNING",
	"FINISHED",
	"ERROR",
] as const;
export type StorageInspectionStatus =
	(typeof STORAGE_INSPECTION_STATUSES)[number];

export const INSPECTION_TONE: Record<
	StorageInspectionStatus,
	"neutral" | "ok" | "error"
> = {
	PENDING: "neutral",
	RUNNING: "neutral",
	FINISHED: "ok",
	ERROR: "error",
};

/** Non-terminal states — the only ones worth polling for. */
export function isInspectionRunning(status: StorageInspectionStatus): boolean {
	return status === "PENDING" || status === "RUNNING";
}

/**
 * Wire projection of one StorageInspection row. The row holds no credential
 * material at all (only `credentialId`), but the projection stays EXPLICIT
 * rather than returning the row so a future column cannot leak by default.
 */
export type StorageInspectionDto = {
	id: string;
	status: StorageInspectionStatus;
	bucket: string;
	objectKey: string;
	/** Raw ffprobe JSON (`-show_format -show_streams`); null until FINISHED. */
	probe: unknown;
	/** Bytes the bounded read actually pulled (head + optional tail). */
	bytesRead: number | null;
	error: string | null;
	createdAt: string;
	updatedAt: string;
};

/** Prisma select for the projection above — keeps both routes in lock-step. */
export const INSPECTION_SELECT = {
	id: true,
	status: true,
	bucket: true,
	objectKey: true,
	probe: true,
	bytesRead: true,
	error: true,
	createdAt: true,
	updatedAt: true,
} as const;

/** Shape `INSPECTION_SELECT` yields — structural, so the routes stay untyped-free. */
export type StorageInspectionRow = {
	id: string;
	status: string;
	bucket: string;
	objectKey: string;
	probe: unknown;
	bytesRead: number | null;
	error: string | null;
	createdAt: Date;
	updatedAt: Date;
};

export function toInspectionDto(
	row: StorageInspectionRow,
): StorageInspectionDto {
	return {
		id: row.id,
		status: row.status as StorageInspectionStatus,
		bucket: row.bucket,
		objectKey: row.objectKey,
		probe: row.probe ?? null,
		bytesRead: row.bytesRead,
		error: row.error,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
	};
}

// ---------------------------------------------------------------------------
// ffprobe output → readable summary
// ---------------------------------------------------------------------------

type ProbeFormat = {
	format_name?: unknown;
	format_long_name?: unknown;
	duration?: unknown;
	bit_rate?: unknown;
	nb_streams?: unknown;
};

type ProbeStreamJson = {
	index?: unknown;
	codec_type?: unknown;
	codec_name?: unknown;
	profile?: unknown;
	width?: unknown;
	height?: unknown;
	r_frame_rate?: unknown;
	avg_frame_rate?: unknown;
	bit_rate?: unknown;
	channels?: unknown;
	channel_layout?: unknown;
	sample_rate?: unknown;
	tags?: unknown;
};

/** One table row — every cell already display-ready (null → "—"). */
export type ProbeStreamRow = {
	key: string;
	index: number | null;
	codecType: string | null;
	codecName: string | null;
	profile: string | null;
	resolution: string | null;
	frameRate: string | null;
	bitRate: string | null;
	channels: string | null;
	sampleRate: string | null;
	language: string | null;
};

export type ProbeSummary = {
	formatName: string | null;
	duration: string | null;
	bitRate: string | null;
	streams: ProbeStreamRow[];
};

const asString = (value: unknown): string | null =>
	typeof value === "string" && value.trim() !== "" ? value : null;

const asNumber = (value: unknown): number | null => {
	const parsed =
		typeof value === "number"
			? value
			: typeof value === "string"
				? Number.parseFloat(value)
				: Number.NaN;
	return Number.isFinite(parsed) ? parsed : null;
};

/**
 * ffprobe reports frame rates as a rational string ("30000/1001"), and "0/0"
 * for streams that have none (audio, data). Renders 29.97 rather than
 * 29.970029970029973, and keeps whole rates whole.
 */
export function formatFrameRate(raw: unknown): string | null {
	const text = asString(raw);
	if (!text) {
		return null;
	}
	const [numText, denText = "1"] = text.split("/");
	const num = Number(numText);
	const den = Number(denText);
	if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0 || num <= 0) {
		return null;
	}
	const fps = num / den;
	return `${Number.isInteger(fps) ? fps : fps.toFixed(2)} fps`;
}

/** `format.duration` (seconds, as a string) → "1:02:15.400" / "2:15.400". */
export function formatProbeDuration(raw: unknown): string | null {
	const seconds = asNumber(raw);
	if (seconds === null || seconds < 0) {
		return null;
	}
	const hours = Math.floor(seconds / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	const rest = seconds - hours * 3600 - minutes * 60;
	const restText = `${rest < 10 ? "0" : ""}${rest.toFixed(3)}`;
	return hours > 0
		? `${hours}:${String(minutes).padStart(2, "0")}:${restText}`
		: `${minutes}:${restText}`;
}

/** bits/second → "4.50 Mbps" / "128 kbps". */
export function formatBitrate(raw: unknown): string | null {
	const bps = asNumber(raw);
	if (bps === null || bps <= 0) {
		return null;
	}
	if (bps >= 1_000_000) {
		return `${(bps / 1_000_000).toFixed(2)} Mbps`;
	}
	if (bps >= 1000) {
		return `${Math.round(bps / 1000)} kbps`;
	}
	return `${Math.round(bps)} bps`;
}

/**
 * Turns the stored ffprobe JSON into the dialog's summary. Defensive by
 * design: `probe` is opaque Json from the DB, so every field is read through a
 * narrowing helper and a malformed/absent probe yields null (the dialog then
 * falls back to the raw disclosure).
 */
export function summarizeProbe(probe: unknown): ProbeSummary | null {
	if (typeof probe !== "object" || probe === null) {
		return null;
	}
	const root = probe as { format?: unknown; streams?: unknown };
	const format = (
		typeof root.format === "object" && root.format !== null ? root.format : {}
	) as ProbeFormat;
	const rawStreams = Array.isArray(root.streams) ? root.streams : [];
	const streams: ProbeStreamRow[] = rawStreams.map((entry, position) => {
		const stream = (
			typeof entry === "object" && entry !== null ? entry : {}
		) as ProbeStreamJson;
		const index = asNumber(stream.index);
		const width = asNumber(stream.width);
		const height = asNumber(stream.height);
		const channels = asNumber(stream.channels);
		const sampleRate = asNumber(stream.sample_rate);
		const tags = (
			typeof stream.tags === "object" && stream.tags !== null ? stream.tags : {}
		) as Record<string, unknown>;
		return {
			key: `${index ?? `pos-${position}`}`,
			index: index === null ? null : Math.trunc(index),
			codecType: asString(stream.codec_type),
			codecName: asString(stream.codec_name),
			profile: asString(stream.profile),
			resolution:
				width !== null && height !== null ? `${width}×${height}` : null,
			// r_frame_rate is the container rate; avg_frame_rate covers VFR files.
			frameRate:
				formatFrameRate(stream.r_frame_rate) ??
				formatFrameRate(stream.avg_frame_rate),
			bitRate: formatBitrate(stream.bit_rate),
			channels:
				channels === null
					? null
					: `${channels}${asString(stream.channel_layout) ? ` (${asString(stream.channel_layout)})` : ""}`,
			sampleRate: sampleRate === null ? null : `${sampleRate} Hz`,
			language: asString(tags.language),
		};
	});
	const formatName =
		asString(format.format_long_name) ?? asString(format.format_name);
	const summary: ProbeSummary = {
		formatName,
		duration: formatProbeDuration(format.duration),
		// Bounded inspection probes a scratch slice, not a proven whole object.
		// ffprobe may divide that slice's size by the full container duration.
		// Keep the raw observation, but never label it as the object's bitrate.
		bitRate: null,
		streams,
	};
	// Nothing recognizable at all → let the caller show the raw JSON instead of
	// a table of dashes.
	return summary.formatName === null && streams.length === 0 ? null : summary;
}
