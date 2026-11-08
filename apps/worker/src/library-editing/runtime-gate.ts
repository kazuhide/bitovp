import {
	LOCAL_CLIP_AVAILABILITY_TTL_MS,
	type LocalClipAvailability,
	type LocalSemanticConfiguration,
	localClipAvailabilitySchema,
	readLocalSemanticConfiguration,
} from "@bitovp/core";
import type { LocalCaptionTranslationSelection } from "@bitovp/core/local-caption-config";
import { probeLocalClipGateway } from "@bitovp/core/local-semantic-diagnostic-probe";

/** Shared by claims and heartbeat publication. Metadata only, no Web-originated probes. */
export function createClipEditingRuntimeGate(
	config: LocalSemanticConfiguration,
	captionSelection?: LocalCaptionTranslationSelection,
	options: {
		probe?: typeof probeLocalClipGateway;
		now?: () => number;
	} = {},
) {
	const now = options.now ?? Date.now;
	let latest: LocalClipAvailability = {
		version: "local-clip-availability-v2",
		checkedAt: 0,
		code: "UNAVAILABLE",
	};
	let pending: Promise<void> | undefined;
	let interval: ReturnType<typeof setInterval> | undefined;
	let stopped = false;
	const shutdown = new AbortController();
	const observation = (): LocalClipAvailability =>
		latest.checkedAt <= now() &&
		now() - latest.checkedAt <= LOCAL_CLIP_AVAILABILITY_TTL_MS &&
		!stopped
			? { ...latest }
			: { ...latest, code: "UNAVAILABLE" };
	const refresh = () => {
		if (stopped) return Promise.resolve();
		if (pending) return pending;
		if (
			latest.checkedAt > 0 &&
			now() >= latest.checkedAt &&
			now() - latest.checkedAt < 5_000
		)
			return Promise.resolve();
		const checkedAt = now();
		pending = (async () => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			let ready = false;
			let gpuCheckedAt = checkedAt;
			let authorizedOrganizationId: string | undefined;
			try {
				const result = await Promise.race([
					(options.probe ?? probeLocalClipGateway)(
						config,
						undefined,
						AbortSignal.any([shutdown.signal, AbortSignal.timeout(4_000)]),
						captionSelection,
					),
					new Promise<undefined>((resolve) => {
						timer = setTimeout(() => resolve(undefined), 4_000);
						timer.unref();
					}),
				]);
				ready =
					result?.code === "READY" &&
					typeof result.authorizedOrganizationId === "string" &&
					typeof result.gpuObservedAt === "number" &&
					result.gpuObservedAt >= now() - LOCAL_CLIP_AVAILABILITY_TTL_MS &&
					result.gpuObservedAt <= now() + 5_000;
				if (ready && result?.gpuObservedAt !== undefined) {
					gpuCheckedAt = Math.min(checkedAt, result.gpuObservedAt);
					authorizedOrganizationId = result.authorizedOrganizationId;
				}
			} catch {
				/* Unverified failures remain unavailable, without operator details. */
			} finally {
				if (timer) clearTimeout(timer);
			}
			const checked = localClipAvailabilitySchema.safeParse({
				version: "local-clip-availability-v2",
				checkedAt: gpuCheckedAt,
				code: ready && !stopped ? "READY" : "UNAVAILABLE",
				authorizedOrganizationId,
			});
			latest = checked.success
				? checked.data
				: {
						version: "local-clip-availability-v2",
						checkedAt: gpuCheckedAt,
						code: "UNAVAILABLE",
					};
		})().finally(() => {
			pending = undefined;
		});
		return pending;
	};
	return {
		observation,
		canClaim: async (organizationId: string) => {
			await refresh();
			const current = observation();
			return (
				current.code === "READY" &&
				current.authorizedOrganizationId === organizationId
			);
		},
		start: () => {
			if (!interval && !stopped) {
				void refresh();
				interval = setInterval(() => void refresh(), 5_000);
				interval.unref();
			}
		},
		stop: async () => {
			stopped = true;
			shutdown.abort();
			if (interval) clearInterval(interval);
		},
	};
}

/** Build before scheduling: disabled/invalid local setup never registers clip work.
 * Keep initialization failures (for example an unreadable CA) local to editing.
 * No exception contents or operator secrets cross this boundary.
 */
export function createConfiguredLibraryEditing<T>(
	env: Record<string, string | undefined>,
	create: (config: LocalSemanticConfiguration) => T,
): T | undefined {
	try {
		const config = readLocalSemanticConfiguration(env);
		return config ? create(config) : undefined;
	} catch {
		return undefined;
	}
}
