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

export type EmitProductEvent = (
	input: EmitInput,
	occurredAt?: Date,
) => Promise<void>;

type NotifyQueueLike = {
	add(
		name: string,
		data: unknown,
		opts?: Record<string, unknown>,
	): Promise<unknown>;
};

type EmitterDeps = {
	queue: NotifyQueueLike;
	publicBaseUrl?: string;
	now?: () => Date;
};

/** A durable producer must observe enqueue failure before acknowledging its outbox row. */
export function createEventEnqueuer(deps: EmitterDeps) {
	const base = (deps.publicBaseUrl ?? "").replace(/\/$/, "");
	return async (
		input: EmitInput,
		delivery?: { jobId?: string; occurredAt: Date },
	): Promise<void> => {
		const { path, ...event } = input;
		const parsed = productEventSchema.parse({
			...event,
			eventVersion: EVENT_VERSION,
			occurredAt: (
				delivery?.occurredAt ??
				deps.now?.() ??
				new Date()
			).toISOString(),
			link: `${base || "http://localhost:3000"}${path}`,
		});
		await deps.queue.add(QUEUE_NAMES.notify, parsed, {
			...(delivery?.jobId ? { jobId: delivery.jobId } : {}),
			attempts: 5,
			backoff: { type: "exponential", delay: 1_000 },
			removeOnComplete: 1000,
			removeOnFail: 5000,
		});
	};
}

export function createEventEmitter(deps: EmitterDeps): EmitProductEvent {
	const enqueue = createEventEnqueuer(deps);
	return async (input, occurredAt) => {
		try {
			await enqueue(input, occurredAt ? { occurredAt } : undefined);
		} catch (err) {
			if (err instanceof Error && err.name === "ZodError") {
				console.error(
					`[notify] DROPPED schema-invalid ${input.kind} event (emit-site bug):`,
					err.message,
				);
				return;
			}
			console.error(
				"[notify] emit failed (event dropped, job unaffected):",
				err instanceof Error ? err.message : err,
			);
		}
	};
}
