import "server-only";
import type {
	MoqHeartbeatHistory,
	MoqHeartbeatPoint,
	MoqPushOutput,
} from "@/lib/moq-player/heartbeat";
import type { ServerContext } from "./context";
import {
	type HeartbeatReceiptValue,
	heartbeatReceiptValue,
	safeHeartbeatReceipt,
} from "./heartbeat-receipt-value";

type Store = Pick<
	ServerContext["prisma"],
	"liveChannelRun" | "liveHeartbeat" | "webhookEvent"
>;
const MAX_POINTS = 600;

function record(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function validTime(value: Date, notBefore: Date, now: Date): boolean {
	return Number.isFinite(value.getTime()) && value >= notBefore && value <= now;
}

function segmentProcessing(raw: HeartbeatReceiptValue) {
	const stats = raw.output?.segments?.totalProcessingStatsMs;
	return {
		segmentProcessingMeanMs: stats?.mean ?? null,
		segmentProcessingMinMs: stats?.min ?? null,
		segmentProcessingMaxMs: stats?.max ?? null,
	};
}

function point(
	at: Date,
	value: unknown,
	source: MoqHeartbeatPoint["source"],
	notBefore: Date,
	now: Date,
): MoqHeartbeatPoint | null {
	if (!validTime(at, notBefore, now)) return null;
	const parsed = heartbeatReceiptValue.safeParse(value);
	if (!parsed.success) return null;
	const raw = parsed.data;
	const ingest = raw.ingest;
	const video = ingest?.streams?.find(
		(stream) => stream.mediaType?.toLowerCase() === "video",
	);
	const audio = ingest?.streams?.find(
		(stream) => stream.mediaType?.toLowerCase() === "audio",
	);
	const sampled = raw.timestamp ? new Date(raw.timestamp) : null;
	const metrics = {
		ingestStatus: ingest?.status ?? null,
		ingestHealthy: ingest?.healthy ?? null,
		videoIncomingBitrateBps: video?.incomingBitrate ?? null,
		audioIncomingBitrateBps: audio?.incomingBitrate ?? null,
		videoFps: video?.rate ?? null,
		droppedPacketsVideo: ingest?.droppedPacketsVideo ?? null,
		droppedPacketsAudio: ingest?.droppedPacketsAudio ?? null,
		corruptPacketsVideo: ingest?.corruptPacketsVideo ?? null,
		corruptPacketsAudio: ingest?.corruptPacketsAudio ?? null,
		...segmentProcessing(raw),
	};
	if (Object.values(metrics).every((value) => value === null)) return null;
	return {
		observedAt: at.toISOString(),
		sampledAt:
			sampled && validTime(sampled, notBefore, now)
				? sampled.toISOString()
				: null,
		source,
		...metrics,
	};
}

/** No provider calls. The authenticated caller supplies its tenant Prisma facade. */
export async function readMoqHeartbeatHistory(
	prisma: Store,
	runId: string,
	encodingId: string,
	{ now = new Date(), includePushOutput = false } = {},
): Promise<MoqHeartbeatHistory> {
	const empty: MoqHeartbeatHistory = {
		source: "live-encoder-heartbeat",
		points: [],
		truncated: false,
	};
	const run = await prisma.liveChannelRun.findFirst({
		where: { id: runId, bitmovinEncodingId: encodingId },
		select: {
			id: true,
			bitmovinEncodingId: true,
			createdAt: true,
			lastHeartbeat: true,
			lastHeartbeatAt: true,
		},
	});
	if (
		!run ||
		run.id !== runId ||
		run.bitmovinEncodingId !== encodingId ||
		!validTime(run.createdAt, run.createdAt, now)
	)
		return empty;
	const [rows, receipts] = await Promise.all([
		prisma.liveHeartbeat.findMany({
			where: { liveChannelRunId: runId },
			orderBy: [{ at: "desc" }, { id: "desc" }],
			take: MAX_POINTS + 1,
			select: { at: true, raw: true },
		}),
		includePushOutput
			? prisma.webhookEvent
					.findMany({
						where: {
							source: "bitmovin",
							eventType: "LIVE_ENCODING_HEARTBEAT",
							signatureValid: true,
							// Only the dedicated heartbeat receiver records this identity.
							receiverTokenHash: { not: null },
							liveChannelRunId: runId,
							raw: { path: ["encoding", "id"], equals: encodingId },
							receivedAt: { gte: run.createdAt, lte: now },
						},
						orderBy: [{ receivedAt: "desc" }, { id: "desc" }],
						take: MAX_POINTS + 1,
						select: { receivedAt: true, raw: true },
					})
					.catch(() => null)
			: Promise.resolve([]),
	]);
	const push = receipts ?? [];
	let truncated = rows.length > MAX_POINTS || push.length > MAX_POINTS;
	const points = rows
		.slice(0, MAX_POINTS)
		.reverse()
		.flatMap((row) => {
			const result = point(row.at, row.raw, "poll", run.createdAt, now);
			return result ? [result] : [];
		})
		.sort((a, b) => a.observedAt.localeCompare(b.observedAt));
	// The run mirror is a wrapper {at, raw, deltas}. Its dedicated anchor must
	// agree; updatedAt or provider timestamps do not establish receipt time.
	const last = record(run.lastHeartbeat);
	if (run.lastHeartbeatAt && last?.at === run.lastHeartbeatAt.toISOString()) {
		const candidate = point(
			run.lastHeartbeatAt,
			last.raw,
			"run-last",
			run.createdAt,
			now,
		);
		const newest = points.at(-1);
		if (candidate && (!newest || candidate.observedAt > newest.observedAt))
			points.push(candidate);
	}
	if (points.length > MAX_POINTS) {
		points.splice(0, points.length - MAX_POINTS);
		truncated = true;
	}
	// Use provider sample time to collapse signed retries. Keep valid times
	// without output measurements so the graph breaks at a recorded gap.
	const output = new Map<string, MoqPushOutput>();
	const measuredTimes = new Set<string>();
	for (const row of push.slice(0, MAX_POINTS).reverse()) {
		if (!validTime(row.receivedAt, run.createdAt, now)) continue;
		const raw = safeHeartbeatReceipt(row.raw, encodingId);
		if (!raw?.timestamp || measuredTimes.has(raw.timestamp)) continue;
		if (!validTime(new Date(raw.timestamp), run.createdAt, now)) continue;
		const measured = segmentProcessing(raw);
		if (Object.values(measured).some((value) => value !== null))
			measuredTimes.add(raw.timestamp);
		output.set(raw.timestamp, { sampledAt: raw.timestamp, ...measured });
	}
	return {
		source: "live-encoder-heartbeat",
		points,
		truncated,
		...(measuredTimes.size ? { pushOutput: [...output.values()] } : {}),
		...(receipts === null ? { pushOutputReadFailed: true as const } : {}),
	};
}
