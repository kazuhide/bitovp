import type { z } from "zod";
import type { diagnosticsHdStartSchema } from "./schemas";
export type LiveDiagnosticsKind =
	| "summary"
	| "events"
	| "streams"
	| "srt"
	| "hd-start";
export type LiveDiagnosticsSummary = { status?: string };
export type LiveDiagnosticsEvent = {
	time?: string;
	details?: { eventType?: string; source?: string } & Partial<
		Record<
			| "year"
			| "month"
			| "day"
			| "hours"
			| "minutes"
			| "seconds"
			| "microSeconds",
			number
		>
	>;
};
export type LiveDiagnosticsStream = {
	time?: string;
	streamInfos?: ({ id?: string; mediaType?: string; codec?: string } & Partial<
		Record<
			| "width"
			| "height"
			| "rate"
			| `${"samples" | "bytes"}${"Read" | "Backup"}PerSecond${"Min" | "Max" | "Avg"}`,
			number
		>
	>)[];
};
export type LiveDiagnosticsSrt = {
	id?: string;
	createdAt?: string;
	encodingId?: string;
	srtInputId?: string;
	srtInputSelected?: boolean;
	link?: Partial<Record<"bandwidth" | "maxBandwidth" | "rtt", number>>;
	window?: Partial<Record<"congestion" | "flight" | "flow", number>>;
	recv?: Partial<
		Record<
			| "bytes"
			| "bytesDropped"
			| "bytesLost"
			| "mbitRate"
			| "packets"
			| "packetsBelated"
			| "packetsDropped"
			| "packetsLost"
			| "packetsRetransmitted",
			number
		>
	>;
	send?: Partial<
		Record<
			| "bytes"
			| "bytesDropped"
			| "mbitRate"
			| "packets"
			| "packetsDropped"
			| "packetsLost"
			| "packetsRetransmitted",
			number
		>
	>;
};
type Envelope = { runId: string; encodingId: string; fetchedAt: string };
type Page = {
	offset: number;
	limit: number;
	totalCount: number;
	nextOffset: number | null;
};
export type LiveDiagnosticsResponse = Envelope &
	(
		| { kind: "summary"; data: LiveDiagnosticsSummary }
		| { kind: "hd-start"; data: z.infer<typeof diagnosticsHdStartSchema> }
		| (Page & { kind: "events"; data: LiveDiagnosticsEvent[] })
		| (Page & { kind: "streams"; data: LiveDiagnosticsStream[] })
		| (Page & { kind: "srt"; data: LiveDiagnosticsSrt[] })
	);
export type LiveFinalHeartbeatResponse = Envelope & {
	kind: "final-heartbeat";
	data: { url: string };
};
