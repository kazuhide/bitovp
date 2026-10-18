import { z } from "zod";
import { INGRESS_MODES } from "../ingress/resolver";

/**
 * Product events  — the one typed
 * union every notifier consumes and every emitter must satisfy. STRICT
 * objects throughout: the payload carries ids, names, labels, the terminal
 * error string (already redacted at persist time) and an absolute UI link —
 * never plan JSON, credentials, stream keys or step-log bodies. Leaking a
 * field requires editing this schema in review; that is the point.
 *
 * ALERT, SCHEDULE, WATCH and QC emitters share this union; parallel event
 * schemas would make delivery rules and redaction drift.
 */

export const EVENT_VERSION = 1;

/** Common envelope every event carries. */
const base = {
	eventVersion: z.literal(EVENT_VERSION),
	/** ISO timestamp, supplied by the emit site (workers own the clock). */
	occurredAt: z.string().datetime(),
	/** Absolute UI link built from PUBLIC_BASE_URL at emit time. */
	link: z.string().url(),
} as const;

const jobPayload = {
	...base,
	jobId: z.string().uuid(),
	name: z.string(),
	labels: z.array(z.string()).default([]),
} as const;

const channelPayload = {
	...base,
	liveChannelId: z.string().uuid(),
	name: z.string(),
} as const;

export const productEventSchema = z.discriminatedUnion("kind", [
	z.strictObject({
		kind: z.literal("JOB_FINISHED"),
		...jobPayload,
		/** True when delivery was FORCED past a failing/absent QC verdict
		     — absent for ordinary finishes. */
		overridden: z.boolean().optional(),
	}),
	z.strictObject({
		kind: z.literal("JOB_ERROR"),
		...jobPayload,
		error: z.string(),
	}),
	z.strictObject({ kind: z.literal("JOB_CANCELED"), ...jobPayload }),
	z.strictObject({
		kind: z.literal("JOB_QC_FAILED"),
		...jobPayload,
		/** Which QC gate failed ( owns the emitter). */
		reason: z.string(),
	}),
	z.strictObject({ kind: z.literal("CHANNEL_RUNNING"), ...channelPayload }),
	z.strictObject({
		kind: z.literal("CHANNEL_ERROR"),
		...channelPayload,
		error: z.string(),
	}),
	z.strictObject({ kind: z.literal("CHANNEL_STOPPED"), ...channelPayload }),
	z.strictObject({
		kind: z.literal("FEEDER_ERROR"),
		...base,
		feederSessionId: z.string().uuid(),
		liveChannelId: z.string().uuid(),
		error: z.string(),
	}),
	z.strictObject({
		kind: z.literal("VMAF_FINISHED"),
		...base,
		vmafJobId: z.string().uuid(),
		/** VmafJob rows carry no name of their own; optional until PR2 joins
		    the encoding job's. */
		name: z.string().optional(),
		/** Pooled mean when the run produced one (harmonic pooling). */
		score: z.number().optional(),
	}),
	z.strictObject({
		kind: z.literal("VMAF_ERROR"),
		...base,
		vmafJobId: z.string().uuid(),
		name: z.string().optional(),
		error: z.string(),
	}),
	z.strictObject({
		kind: z.literal("ALERT_OPENED"),
		...base,
		alertId: z.string().uuid(),
		liveChannelId: z.string().uuid(),
		rule: z.string(),
		/**
		 *  §2 — provenance on the wire: a BITMOVIN signal is the
		 * encoder's self-report relayed by bitovp; a BITOVP signal is
		 * bitovp's own measurement and stands even when the self-report
		 * disagrees. Optional for pre-#161 consumers; the emitter always
		 * fills them from METRIC_CLASS.
		 */
		source: z.enum(["BITMOVIN", "BITOVP"]).optional(),
		subject: z.enum(["INGEST", "DELIVERY"]).optional(),
	}),
	z.strictObject({
		kind: z.literal("ALERT_RESOLVED"),
		...base,
		alertId: z.string().uuid(),
		liveChannelId: z.string().uuid(),
		rule: z.string(),
		source: z.enum(["BITMOVIN", "BITOVP"]).optional(),
		subject: z.enum(["INGEST", "DELIVERY"]).optional(),
	}),
	z.strictObject({
		kind: z.literal("SCHEDULE_MISSED"),
		...base,
		scheduleId: z.string().uuid(),
		liveChannelId: z.string().uuid(),
		reason: z.string(),
	}),
	/**
	 *  PR2 — the deadline backstop (#94-F11): the channel is not
	 * RUNNING by `airAt − margin`. Fires ONCE per schedule row, while there
	 * is still margin to act — the honest backstop the percentile lead can
	 * never be.
	 */
	z.strictObject({
		kind: z.literal("SCHEDULE_NOT_RUNNING_AT_DEADLINE"),
		...base,
		scheduleId: z.string().uuid(),
		liveChannelId: z.string().uuid(),
		airAt: z.string(),
		channelStatus: z.string(),
	}),
	z.strictObject({
		kind: z.literal("SCHEDULE_FIRED"),
		...base,
		scheduleId: z.string().uuid(),
		liveChannelId: z.string().uuid(),
	}),
	z.strictObject({
		kind: z.literal("WATCH_SUBMITTED"),
		...base,
		watchFolderId: z.string().uuid(),
		objectPath: z.string(),
		jobId: z.string().uuid(),
	}),
	z.strictObject({
		kind: z.literal("WATCH_ERROR"),
		...base,
		watchFolderId: z.string().uuid(),
		objectPath: z.string(),
		error: z.string(),
	}),
	/**
	 * WP-G G-1: the worker's ingress monitor saw the public base URL change
	 * (a quick tunnel rotated, PUBLIC_BASE_URL edited, the sidecar died).
	 * `null` on either side is "no public ingress". Every webhook registered
	 * at the previous URL is now unreachable until re-registered (G-2 does
	 * that automatically; this event is how an operator learns it happened).
	 */
	z.strictObject({
		kind: z.literal("INGRESS_CHANGED"),
		...base,
		mode: z.enum(INGRESS_MODES),
		baseUrl: z.string().url().nullable(),
		previousBaseUrl: z.string().url().nullable(),
	}),
]);

export type ProductEvent = z.infer<typeof productEventSchema>;
export type ProductEventKind = ProductEvent["kind"];

/** Every kind, derived FROM the union so the two can never drift. */
export const PRODUCT_EVENT_KINDS = productEventSchema.options.map(
	(option) => option.shape.kind.value,
) as ProductEventKind[];

/**
 * Rule filter (NotificationRule.filter Json column). Empty object = match
 * everything the rule's `events` list admits.
 */
export const notificationRuleFilterSchema = z
	.strictObject({
		/** Any-overlap on Job labels (job events only; others ignore it). */
		labels: z.array(z.string()).optional(),
		/** Restrict channel/feeder/alert/schedule events to these channels. */
		liveChannelIds: z.array(z.string().uuid()).optional(),
	})
	.default({});

export type NotificationRuleFilter = z.infer<
	typeof notificationRuleFilterSchema
>;

/** Does this event pass a rule's filter? (Kind matching happens upstream.) */
export function eventMatchesFilter(
	event: ProductEvent,
	filter: NotificationRuleFilter,
): boolean {
	if (filter.labels && filter.labels.length > 0) {
		const labels = "labels" in event ? event.labels : [];
		if (!filter.labels.some((label) => labels.includes(label))) {
			return false;
		}
	}
	if (filter.liveChannelIds && filter.liveChannelIds.length > 0) {
		const id = "liveChannelId" in event ? event.liveChannelId : undefined;
		if (id === undefined || !filter.liveChannelIds.includes(id)) {
			return false;
		}
	}
	return true;
}
