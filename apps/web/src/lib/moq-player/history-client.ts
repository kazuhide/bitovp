import { z } from "zod";
import { apiFetch } from "@/lib/api";
import {
	MOQ_OBSERVATION_LIMITS as LIMITS,
	type MoqObservationEvent,
	type MoqObservationSample,
	type MoqObservationUpdate,
	moqArchiveMetadataSchema,
	moqObservationSampleSchema,
	moqObservationUpdateSchema,
} from "./observations";
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
};
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
	const samples: MoqObservationSample[] = [];
	const events: MoqObservationEvent[] = [{ elapsedMs: 0, type: "started" }];
	let finished = false;
	let final: Promise<void> | undefined;
	let analyticsImpressionId: string | undefined;
	const elapsed = () =>
		Math.max(0, Math.min(LIMITS.durationMs, Math.round(now() - origin)));
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
			const receipt = await Promise.race([
				apiFetch(path, {
					method: "PUT",
					cache: "no-store",
					signal: abort.signal,
					body: JSON.stringify(moqObservationUpdateSchema.parse(value)),
				}),
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
			options.onState("saved");
			options.onPersisted?.();
		} catch (error) {
			const details =
				typeof error === "object" && error
					? Reflect.get(error, "details")
					: null;
			options.onState(
				typeof details === "object" &&
					details &&
					Reflect.get(details, "code") === "MOQ_HISTORY_SESSION_LIMIT"
					? "limit"
					: "failed",
			);
			throw new Error("MoQ observations could not be saved");
		} finally {
			if (timer) clearTimeout(timer);
		}
	}
	let queue = send(snapshot());
	const ready = queue;
	void ready.catch(() => {});
	function flush() {
		const value = snapshot();
		queue = queue.catch(() => {}).then(() => send(value));
		return queue;
	}
	const interval = setInterval(() => {
		if (!finished) void flush().catch(() => {});
	}, 5000);
	const maximum = setTimeout(() => {
		void finish("ended").catch(() => {});
	}, LIMITS.durationMs);
	void ready.catch(() => {
		clearInterval(interval);
		clearTimeout(maximum);
	});
	function sample(value: MoqVideoStatistics) {
		if (finished || samples.length >= LIMITS.samples) return;
		const at = elapsed();
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
	function event(type: MoqObservationEvent["type"]) {
		if (
			finished ||
			events.length >= LIMITS.events ||
			events.some((e) => e.type === type)
		)
			return;
		const at = elapsed();
		if ((events.at(-1)?.elapsedMs ?? 0) <= at)
			events.push({ elapsedMs: at, type });
	}
	function finish(reason: "stopped" | "failed" | "ended") {
		if (final) return final;
		event(reason);
		finished = true;
		clearInterval(interval);
		clearTimeout(maximum);
		endedAt = new Date(Date.parse(startedAt) + elapsed()).toISOString();
		final = ready.then(() => flush());
		void final.catch(() => {});
		return final;
	}
	async function archive(blob: Blob, durationMs: number, signal: AbortSignal) {
		try {
			await ready;
			await queue;
			const response = await fetch(`${path}/archive`, {
				method: "PUT",
				cache: "no-store",
				signal,
				headers: {
					"Content-Type": "video/webm",
					"X-BitOVP-Moq-Duration-Ms": String(durationMs),
				},
				body: blob,
			});
			if (!response.ok) throw new Error();
			const value: unknown = await response.json();
			if (
				typeof value !== "object" ||
				!value ||
				Reflect.get(value, "runId") !== options.runId ||
				Reflect.get(value, "sessionId") !== id ||
				!moqArchiveMetadataSchema.safeParse(Reflect.get(value, "archive"))
					.success
			)
				throw new Error();
			options.onPersisted?.();
		} catch {
			throw new Error("MoQ recording could not be saved");
		}
	}
	function setAnalyticsImpressionId(value: string | null) {
		if (
			analyticsLicenseKeySha256 &&
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
		setAnalyticsImpressionId,
	};
}
