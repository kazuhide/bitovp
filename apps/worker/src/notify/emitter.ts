import {
	EVENT_VERSION,
	type ProductEvent,
	type ProductEventKind,
	productEventSchema,
	QUEUE_NAMES,
} from "@bitovp/core";

/**
 * Product-event emitter . Fills the envelope (version,
 * occurredAt, absolute UI link), validates against the STRICT union and
 * enqueues one notify job per event.
 *
 * BEST-EFFORT BY CONTRACT: emit never throws — a notify failure must never
 * fail the job that emitted (same discipline as heartbeat-history writes and
 * the onVodFinished hook). A schema-invalid event is a BUG at the call site;
 * it is logged loudly and dropped rather than crashing the transition that
 * produced it.
 */

/** A call site supplies the event minus the envelope, plus the UI path. */
export type EmitInput = {
	[K in ProductEventKind]: Omit<
		Extract<ProductEvent, { kind: K }>,
		"eventVersion" | "occurredAt" | "link"
	> & { path: string };
}[ProductEventKind];

export type EmitProductEvent = (input: EmitInput) => Promise<void>;

type NotifyQueueLike = {
	add(
		name: string,
		data: unknown,
		opts?: Record<string, unknown>,
	): Promise<unknown>;
};

export function createEventEmitter(deps: {
	queue: NotifyQueueLike;
	/** PUBLIC_BASE_URL; undefined ⇒ links fall back to the bare path. */
	publicBaseUrl?: string;
	now?: () => Date;
}): EmitProductEvent {
	const base = (deps.publicBaseUrl ?? "").replace(/\/$/, "");
	return async (input) => {
		try {
			const { path, ...event } = input;
			const candidate = {
				...event,
				eventVersion: EVENT_VERSION,
				occurredAt: (deps.now?.() ?? new Date()).toISOString(),
				// Without PUBLIC_BASE_URL the link is not a valid URL; use a
				// placeholder origin so the schema holds and the path survives —
				// the operator-facing fix is setting the variable.
				link: `${base || "http://localhost:3000"}${path}`,
			};
			const parsed = productEventSchema.safeParse(candidate);
			if (!parsed.success) {
				console.error(
					`[notify] DROPPED schema-invalid ${String(input.kind)} event (emit-site bug):`,
					parsed.error.issues
						.map((issue) => `${issue.path.join(".")}: ${issue.message}`)
						.join("; "),
				);
				return;
			}
			await deps.queue.add(QUEUE_NAMES.notify, parsed.data, {
				// review-183 C1: WITHOUT attempts, BullMQ's default is 0 and a
				// thrown delivery is gone permanently — the bus was at-MOST-once
				// while three artefacts (the processor comment, the retry test's
				// name, ) claimed at-least-once. These two lines are
				// what makes the claim true; duplicate-on-retry to already-
				// delivered channels is the genuine trade #89 records.
				attempts: 5,
				backoff: { type: "exponential", delay: 1_000 },
				removeOnComplete: 1000,
				removeOnFail: 5000,
			});
		} catch (err) {
			console.error(
				"[notify] emit failed (event dropped, job unaffected):",
				err instanceof Error ? err.message : err,
			);
		}
	};
}
