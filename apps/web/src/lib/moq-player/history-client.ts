import { z } from "zod";
import { apiFetch } from "@/lib/api";
import {
	appendMoqObservationEvent,
	MOQ_OBSERVATION_LIMITS as LIMITS,
	MOQ_ARCHIVE_CAPTURE_STARTED_AT_HEADER,
	type MoqObservationEvent,
	type MoqObservationSample,
	type MoqObservationUpdate,
	moqArchiveCaptureStartedAtSchema,
	moqArchiveMetadataSchema,
	moqObservationSampleSchema,
	moqObservationUpdateSchema,
} from "./observations";
import { MoqArchiveSaveUnconfirmed } from "./recording";
import type { MoqVideoStatistics } from "./video-statistics";

export type MoqHistorySaveState = "saving" | "saved" | "failed" | "limit";
type Options = {
	channelId: string;
	runId: string;
	sessionId?: string;
	startedAt?: string;
	startedMonotonicMs?: number;
	analyticsLicenseKeySha256?: string;
	now?: () => number;
	onState(state: MoqHistorySaveState): void;
	onPersisted?(): void;
	onAnalyticsUnavailable?(): void;
};
function withoutAnalytics({
	analyticsImpressionId: _id,
	analyticsLicenseKeySha256: _digest,
	...observations
}: MoqObservationUpdate): MoqObservationUpdate {
	return observations;
}
function errorCode(error: unknown) {
	const details = (error as { details?: unknown } | null)?.details;
	return typeof details === "object" && details
		? Reflect.get(details, "code")
		: undefined;
}
export function moqObservationPath(channelId: string, runId: string) {
	return `/api/live-channels/${encodeURIComponent(channelId)}/runs/${encodeURIComponent(runId)}/moq-observations`;
}
const metric = (value: number | null, max: number) =>
	value !== null && Number.isFinite(value) && value >= 0 && value <= max
		? value
		: null;
const count = (value: number | null) =>
	value !== null && Number.isSafeInteger(value) && value >= 0 ? value : null;
export function createMoqObservationWriter(options: Options) {
	const id = options.sessionId ?? crypto.randomUUID();
	const path = `${moqObservationPath(options.channelId, options.runId)}/${id}`;
	const now = options.now ?? (() => performance.now());
	const origin = options.startedMonotonicMs ?? now();
	const startedAt = options.startedAt ?? new Date().toISOString();
	const descriptorDigest = z
		.string()
		.regex(/^[0-9a-f]{64}$/)
		.safeParse(options.analyticsLicenseKeySha256);
	const analyticsLicenseKeySha256 = descriptorDigest.success
		? descriptorDigest.data
		: undefined;
	let endedAt: string | null = null;
	let captureStartedAt: string | undefined;
	const samples: MoqObservationSample[] = [];
	let events: readonly MoqObservationEvent[] = [
		{ elapsedMs: 0, type: "started" },
	];
	let finished = false;
	let final: Promise<void> | undefined;
	let analyticsImpressionId: string | undefined;
	let analyticsBound = false;
	let analyticsUnavailable = false;
	const elapsed = () => Math.max(0, Math.round(now() - origin));
	const snapshot = (): MoqObservationUpdate => ({
		startedAt,
		endedAt,
		samples: samples.slice(),
		events: events.slice(),
		...(analyticsImpressionId && analyticsLicenseKeySha256
			? { analyticsImpressionId, analyticsLicenseKeySha256 }
			: {}),
	});
	async function send(value: MoqObservationUpdate) {
		const abort = new AbortController();
		let timer: ReturnType<typeof setTimeout> | undefined;
		options.onState("saving");
		try {
			const put = (input: MoqObservationUpdate) =>
				apiFetch(path, {
					method: "PUT",
					cache: "no-store",
					signal: abort.signal,
					body: JSON.stringify(moqObservationUpdateSchema.parse(input)),
				});
			const persist = async () => {
				const payload = analyticsUnavailable ? withoutAnalytics(value) : value;
				try {
					return await put(payload);
				} catch (error) {
					const code = errorCode(error);
					if (
						analyticsBound ||
						!payload.analyticsImpressionId ||
						(error as { status?: number } | null)?.status !== 409 ||
						(code !== "MOQ_HISTORY_ANALYTICS_LICENSE_CHANGED" &&
							code !== "MOQ_HISTORY_ANALYTICS_IMPRESSION_CONFLICT")
					)
						throw error;
					analyticsUnavailable = true;
					analyticsImpressionId = undefined;
					options.onAnalyticsUnavailable?.();
					abort.signal.throwIfAborted();
					return put(withoutAnalytics(payload));
				}
			};
			const receipt = await Promise.race([
				persist(),
				new Promise<never>((_resolve, reject) => {
					timer = setTimeout(() => {
						abort.abort();
						reject(new Error());
					}, 5000);
				}),
			]);
			if (
				typeof receipt !== "object" ||
				!receipt ||
				Reflect.get(receipt, "runId") !== options.runId
			)
				throw new Error();
			const session = Reflect.get(receipt, "session");
			if (
				typeof session !== "object" ||
				!session ||
				Reflect.get(session, "id") !== id
			)
				throw new Error();
			if (
				analyticsImpressionId &&
				Reflect.get(session, "analyticsImpressionId") === analyticsImpressionId
			)
				analyticsBound = true;
			options.onState("saved");
			options.onPersisted?.();
		} catch (error) {
			options.onState(
				errorCode(error) === "MOQ_HISTORY_SESSION_LIMIT" ? "limit" : "failed",
			);
			throw new Error("MoQ observations could not be saved");
		} finally {
			if (timer) clearTimeout(timer);
		}
	}
	let requestOutstanding = true;
	function track(request: Promise<void>) {
		const complete = () => {
			if (queue === request) requestOutstanding = false;
		};
		void request.then(complete, complete);
		return request;
	}
	let queue = track(send(snapshot()));
	const ready = queue;
	void ready.catch(() => {});
	function flush() {
		const value = snapshot();
		requestOutstanding = true;
		queue = track(queue.catch(() => {}).then(() => send(value)));
		return queue;
	}
	const interval = setInterval(() => {
		if (!finished && !requestOutstanding) void flush().catch(() => {});
	}, 5000);
	const maximum = setTimeout(
		() => {
			void finish("observation-limit").catch(() => {});
		},
		Math.max(0, Math.ceil(origin + LIMITS.durationMs - now())),
	);
	void ready.catch(() => {
		clearInterval(interval);
		clearTimeout(maximum);
	});
	function sample(value: MoqVideoStatistics) {
		if (finished || samples.length >= LIMITS.samples) return;
		const at = elapsed();
		if (at > LIMITS.durationMs) return;
		const previous = samples.at(-1);
		if (previous && at - previous.elapsedMs < LIMITS.sampleIntervalMs) return;
		const dimensions = /^(\d+)×(\d+)$/.exec(value.resolution ?? "");
		const candidate = {
			elapsedMs: at,
			latencyMs: metric(
				value.latencySeconds === null ? null : value.latencySeconds * 1000,
				600_000,
			),
			fps: metric(value.fps, 1000),
			bufferSeconds: metric(value.bufferSeconds, 600),
			bufferSource: value.bufferSource,
			renderingSource: value.renderingSource,
			droppedFrames: count(value.droppedFrames),
			decodedFrames: count(value.decodedFrames),
			presentedFrames: count(value.presentedFrames),
			totalFrames: count(value.totalFrames),
			resolution: dimensions
				? { width: Number(dimensions[1]), height: Number(dimensions[2]) }
				: null,
		};
		if (
			candidate.resolution &&
			(candidate.resolution.width < 1 ||
				candidate.resolution.width > 16384 ||
				candidate.resolution.height < 1 ||
				candidate.resolution.height > 16384)
		)
			candidate.resolution = null;
		const parsed = moqObservationSampleSchema.safeParse(candidate);
		if (parsed.success) samples.push(parsed.data);
	}
	function event(type: MoqObservationEvent["type"], elapsedMs = elapsed()) {
		if (!finished)
			events = appendMoqObservationEvent(events, { elapsedMs, type });
	}
	function finish(
		reason: "stopped" | "failed" | "ended" | "observation-limit",
	) {
		if (final) return final;
		const at = elapsed();
		const finishedAt = Math.min(
			LIMITS.durationMs,
			Math.max(at, events.at(-1)?.elapsedMs ?? 0),
		);
		event(at > LIMITS.durationMs ? "observation-limit" : reason, finishedAt);
		finished = true;
		clearInterval(interval);
		clearTimeout(maximum);
		endedAt = new Date(Date.parse(startedAt) + finishedAt).toISOString();
		final = ready.then(() => flush());
		void final.catch(() => {});
		return final;
	}
	function recordingStarted() {
		if (captureStartedAt !== undefined) return;
		const offset = elapsed();
		const stamp = new Date(Date.parse(startedAt) + offset);
		if (!Number.isFinite(stamp.getTime())) return;
		const parsed = moqArchiveCaptureStartedAtSchema.safeParse(
			stamp.toISOString(),
		);
		if (!parsed.success) return;
		captureStartedAt = parsed.data;
		event("recording-started", offset);
	}
	async function archive(blob: Blob, durationMs: number, signal: AbortSignal) {
		await ready;
		signal.throwIfAborted();
		if (captureStartedAt === undefined)
			throw new Error("MoQ recording could not be saved");
		const response = await fetch(`${path}/archive`, {
			method: "PUT",
			cache: "no-store",
			signal,
			headers: {
				"Content-Type": "video/webm",
				"X-BitOVP-Moq-Duration-Ms": String(durationMs),
				[MOQ_ARCHIVE_CAPTURE_STARTED_AT_HEADER]: captureStartedAt,
			},
			body: blob,
		}).catch(() => {
			throw new MoqArchiveSaveUnconfirmed();
		});
		if (!response.ok) {
			if (response.status >= 500) throw new MoqArchiveSaveUnconfirmed();
			throw new Error("MoQ recording could not be saved");
		}
		const value: unknown = await response.json().catch(() => null);
		if (
			typeof value !== "object" ||
			!value ||
			Reflect.get(value, "runId") !== options.runId ||
			Reflect.get(value, "sessionId") !== id
		)
			throw new MoqArchiveSaveUnconfirmed();
		const saved = moqArchiveMetadataSchema.safeParse(
			Reflect.get(value, "archive"),
		);
		if (!saved.success || saved.data.captureStartedAt !== captureStartedAt)
			throw new MoqArchiveSaveUnconfirmed();
		options.onPersisted?.();
	}
	function setAnalyticsImpressionId(value: string | null) {
		if (
			analyticsLicenseKeySha256 &&
			!analyticsUnavailable &&
			!analyticsImpressionId &&
			z.uuid().safeParse(value).success
		)
			analyticsImpressionId = value ?? undefined;
	}
	return {
		id,
		ready,
		sample,
		event,
		flush,
		finish,
		archive,
		recordingStarted,
		setAnalyticsImpressionId,
	};
}
