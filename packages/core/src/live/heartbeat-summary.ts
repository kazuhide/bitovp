import { z } from "zod";
import { isProviderFault, providerHeartbeatEvents } from "./heartbeat-events";
import { deriveRunHealth, type RunHealthSpan } from "./run-health";

/**
 * The per-run heartbeat SUMMARY (`LiveChannelRun.heartbeatSummary`): what a
 * run keeps once retention has pruned its per-poll rows. Computed ONCE by the
 * worker after `endedAt` lands, from the rows that exist at that moment, and
 * parsed back by readers through `runHeartbeatSummarySchema` — the column is
 * Json, so the schema is the contract, not the TypeScript type.
 *
 * Every figure names its derivation so a reader cannot mistake one for
 * another (the lesson of the cumulative-vs-delta packet counters):
 *  - `packets` are the SUM of the worker's per-poll deltas, not the encoder's
 *    lifetime counters — reset-tolerant across an encoder restart, and the
 *    first poll of a run contributes zero by construction;
 *  - `ingest`/`output` spans are the run-health lanes (`deriveRunHealth`,
 *    the same 90 s gap rule the run timeline draws), so the summary and the
 *    chart cannot disagree about how long the input was up;
 *  - `events` are the UNION over every row's cumulative `events[]`, deduped
 *    by identity, so a restart that reset the provider's list loses nothing.
 */

export const RUN_HEARTBEAT_SUMMARY_VERSION = 1;

const countersSchema = z.object({
	droppedVideo: z.number().int().nonnegative(),
	droppedAudio: z.number().int().nonnegative(),
	corruptVideo: z.number().int().nonnegative(),
	corruptAudio: z.number().int().nonnegative(),
});

const eventRefSchema = z.object({
	time: z.string().nullable(),
	eventType: z.string(),
	message: z.string().nullable(),
});

export const runHeartbeatSummarySchema = z.object({
	version: z.literal(RUN_HEARTBEAT_SUMMARY_VERSION),
	/** When the worker computed it (ISO). */
	computedAt: z.string(),
	/** Rows present at computation — 0 with `rowsPruned` means "too late". */
	sampleCount: z.number().int().nonnegative(),
	firstAt: z.string().nullable(),
	lastAt: z.string().nullable(),
	/**
	 * True when the run had recorded heartbeats (`lastHeartbeatAt`) but no
	 * row survived to be summarized — retention won the race (a worker that
	 * was down for longer than the window). The figures below are then all
	 * zero and must be read as "unknown", not as a silent run.
	 */
	rowsPruned: z.boolean(),
	ingest: z.object({
		/** Polls whose sample said CONNECTED/healthy. */
		connectedPolls: z.number().int().nonnegative(),
		/** Continuous connected spans (run-health lanes) and their total length. */
		connectedSpans: z.number().int().nonnegative(),
		connectedSpanMs: z.number().int().nonnegative(),
		firstConnectedAt: z.string().nullable(),
		lastConnectedAt: z.string().nullable(),
		/** Poll count per ingest status word, as reported. */
		statusCounts: z.record(z.string(), z.number().int().nonnegative()),
	}),
	output: z.object({
		/** Polls whose newest manifest update was fresh (run-health lane). */
		flowingPolls: z.number().int().nonnegative(),
		flowingSpanMs: z.number().int().nonnegative(),
	}),
	packets: countersSchema,
	events: z.object({
		total: z.number().int().nonnegative(),
		warning: z.number().int().nonnegative(),
		error: z.number().int().nonnegative(),
		firstConnect: z.number().int().nonnegative(),
		disconnect: z.number().int().nonnegative(),
		reconnect: z.number().int().nonnegative(),
		/** The newest WARNING/ERROR, if any — the one-line diagnosis. */
		lastFault: eventRefSchema.nullable(),
	}),
});

export type RunHeartbeatSummary = z.infer<typeof runHeartbeatSummarySchema>;

/** A persisted LiveHeartbeat row as the worker reads it back. */
export type RunHeartbeatSummaryInputRow = {
	at: Date | string;
	raw: unknown;
	deltas: unknown;
};

const DELTA_KEYS = {
	droppedVideo: "droppedPacketsVideo",
	droppedAudio: "droppedPacketsAudio",
	corruptVideo: "corruptPacketsVideo",
	corruptAudio: "corruptPacketsAudio",
} as const;

function spanTotal(spans: RunHealthSpan[]): number {
	return spans.reduce((sum, span) => sum + (span.toMs - span.fromMs), 0);
}

type FaultRef = {
	time: string | null;
	eventType: string;
	message: string | null;
};

/**
 * The newest WARNING/ERROR by the provider's OWN stamp, never by input
 * order: the worker reads rows newest-first, so after a provider-list reset
 * (a restart) an older encoder's fault would sit LAST in the union and a
 * position-based pick reported the 07:49 key-frame WARNING over the 09:00
 * ERROR (rev405 R3). A fault with no parseable stamp only wins when nothing
 * stamped exists, and then the last one encountered — the one documented
 * fallback.
 */
function newestFault(faults: FaultRef[]): FaultRef | null {
	let best: FaultRef | null = null;
	let bestMs = Number.NEGATIVE_INFINITY;
	let unstamped: FaultRef | null = null;
	for (const fault of faults) {
		const ms = fault.time === null ? Number.NaN : Date.parse(fault.time);
		if (!Number.isFinite(ms)) {
			unstamped = fault;
			continue;
		}
		if (ms >= bestMs) {
			best = fault;
			bestMs = ms;
		}
	}
	return best ?? unstamped;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

export function summarizeRunHeartbeats(
	rows: RunHeartbeatSummaryInputRow[],
	options: {
		/** The worker's clock (ISO) — stamped as `computedAt`. */
		computedAt: string;
		/** The run recorded heartbeats but no row is left (see schema). */
		rowsPruned?: boolean;
	},
): RunHeartbeatSummary {
	const computedAtMs = Date.parse(options.computedAt);
	// deriveRunHealth sorts by poll time and drops unparseable stamps; the
	// point list is therefore the population every per-poll figure counts.
	const health = deriveRunHealth(
		rows.map((row) => ({ at: row.at, raw: row.raw })),
		{ nowMs: Number.isFinite(computedAtMs) ? computedAtMs : 0 },
	);
	const packets = {
		droppedVideo: 0,
		droppedAudio: 0,
		corruptVideo: 0,
		corruptAudio: 0,
	};
	const statusCounts: Record<string, number> = {};
	const eventsByKey = new Map<
		string,
		ReturnType<typeof providerHeartbeatEvents>[number]
	>();
	for (const row of rows) {
		const deltas = asRecord(row.deltas);
		for (const [field, key] of Object.entries(DELTA_KEYS) as Array<
			[keyof typeof DELTA_KEYS, string]
		>) {
			const value = deltas?.[key];
			if (typeof value === "number" && Number.isFinite(value) && value > 0) {
				packets[field] += Math.round(value);
			}
		}
		const status = asRecord(asRecord(row.raw)?.ingest)?.status;
		const word =
			typeof status === "string" && status !== "" ? status : "UNKNOWN";
		statusCounts[word] = (statusCounts[word] ?? 0) + 1;
		for (const event of providerHeartbeatEvents(row.raw)) {
			if (!eventsByKey.has(event.key)) {
				eventsByKey.set(event.key, event);
			}
		}
	}
	const events = [...eventsByKey.values()];
	const countType = (type: string) =>
		events.filter((event) => event.eventType === type).length;
	const lastFault = newestFault(events.filter(isProviderFault));
	const connected = health.points.filter((point) => point.ingest);
	const firstConnected = connected[0];
	const lastConnected = connected.at(-1);
	const first = health.points[0];
	const last = health.points.at(-1);
	return {
		version: RUN_HEARTBEAT_SUMMARY_VERSION,
		computedAt: options.computedAt,
		sampleCount: health.points.length,
		firstAt: first ? new Date(first.atMs).toISOString() : null,
		lastAt: last ? new Date(last.atMs).toISOString() : null,
		rowsPruned: options.rowsPruned === true,
		ingest: {
			connectedPolls: connected.length,
			connectedSpans: health.lanes.ingest.length,
			connectedSpanMs: spanTotal(health.lanes.ingest),
			firstConnectedAt: firstConnected
				? new Date(firstConnected.atMs).toISOString()
				: null,
			lastConnectedAt: lastConnected
				? new Date(lastConnected.atMs).toISOString()
				: null,
			statusCounts,
		},
		output: {
			flowingPolls: health.points.filter((point) => point.output).length,
			flowingSpanMs: spanTotal(health.lanes.output),
		},
		packets,
		events: {
			total: events.length,
			warning: countType("WARNING"),
			error: countType("ERROR"),
			firstConnect: countType("FIRST_CONNECT"),
			disconnect: countType("DISCONNECT"),
			reconnect: countType("RECONNECT"),
			lastFault: lastFault
				? {
						time: lastFault.time,
						eventType: lastFault.eventType,
						message: lastFault.message,
					}
				: null,
		},
	};
}

/**
 * Parse a persisted summary column; `null` for a row written before the
 * column existed, a malformed value, or a future version this reader does
 * not understand — never a throw on the read path.
 */
export function parseRunHeartbeatSummary(
	value: unknown,
): RunHeartbeatSummary | null {
	const parsed = runHeartbeatSummarySchema.safeParse(value);
	return parsed.success ? parsed.data : null;
}
