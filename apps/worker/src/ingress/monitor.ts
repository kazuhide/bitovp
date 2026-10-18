import {
	type IngressConfig,
	type IngressResolution,
	type IngressSnapshot,
	ingressChanged,
	nextIngressSnapshot,
	resolveIngress,
} from "@bitovp/core";
import type { AppPrismaClient } from "@bitovp/db";
import { readIngressSnapshot, writeIngressSnapshot } from "@bitovp/db";
import type { EmitProductEvent } from "../notify/emitter";

/**
 * The worker's ingress monitor (WP-G G-1). One tick: read the persisted
 * snapshot, resolve the public base URL in the configured mode, persist the
 * next snapshot, and — only when the URL or mode actually moved — emit
 * `INGRESS_CHANGED` and call the in-process `onChange` hook (G-2 hangs the
 * re-registration of every active webhook there).
 *
 * It runs in the WORKER, not the web app, for the same reason every other
 * sweep does: one process owns the write, the cadence is a timer, and the
 * web app has no place to keep a loop. The web app reads the row.
 *
 * Best-effort like every sweep: a tick that cannot resolve persists
 * `current: null` with the reason (that IS the state), and a tick whose
 * persist fails throws to the loop's error handler — the next tick retries
 * and nothing else is affected.
 */
export type IngressMonitorDeps = {
	prisma: AppPrismaClient;
	config: IngressConfig;
	emitEvent: EmitProductEvent;
	/** Injected so tests drive every mode without a sidecar. */
	resolve?: (config: IngressConfig) => Promise<IngressResolution>;
	/** Called after the persist, only on a change. Never throws into the tick. */
	onChange?: (
		next: IngressSnapshot,
		previous: IngressSnapshot | null,
	) => Promise<void> | void;
	now?: () => Date;
	log?: (message: string) => void;
};

export type IngressMonitor = {
	tick(): Promise<IngressSnapshot>;
};

export function createIngressMonitor(deps: IngressMonitorDeps): IngressMonitor {
	const now = deps.now ?? (() => new Date());
	const resolve = deps.resolve ?? ((config) => resolveIngress(config));
	const log = deps.log ?? ((message: string) => console.log(message));
	return {
		async tick() {
			const previous = await readIngressSnapshot(deps.prisma);
			const resolution = await resolve(deps.config);
			const next = nextIngressSnapshot(
				previous,
				deps.config.mode,
				resolution,
				now(),
			);
			await writeIngressSnapshot(deps.prisma, next);
			if (!ingressChanged(previous, next)) {
				return next;
			}
			const previousUrl = previous?.current?.baseUrl ?? null;
			const nextUrl = next.current?.baseUrl ?? null;
			log(
				`[ingress] public base URL changed: ${previousUrl ?? "(none)"} → ${nextUrl ?? "(none)"} (mode ${next.mode}${
					next.reason ? `, ${next.reason}` : ""
				})`,
			);
			// The emitter is best-effort by contract (never throws).
			await deps.emitEvent({
				kind: "INGRESS_CHANGED",
				mode: next.mode,
				baseUrl: nextUrl,
				previousBaseUrl: previousUrl,
				path: "/settings/webhooks",
			});
			if (deps.onChange) {
				try {
					await deps.onChange(next, previous);
				} catch (err) {
					// A failed reaction must not un-persist the change; the
					// snapshot is already the truth and the next consumer tick
					// (or a manual re-register) recovers.
					log(
						`[ingress] onChange hook failed (snapshot persisted regardless): ${
							err instanceof Error ? err.message : String(err)
						}`,
					);
				}
			}
			return next;
		},
	};
}
