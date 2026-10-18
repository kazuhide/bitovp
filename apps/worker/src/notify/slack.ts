import type { ProductEvent } from "@bitovp/core";

/**
 * Slack incoming-webhook rendering . Compact blocks: one
 * headline section linking the UI, an optional fenced error, and a context
 * line with the kind + timestamp. The payload is DERIVED from the strict
 * event union — nothing outside it can appear here, so the leak boundary is
 * inherited, not re-argued.
 */

/**
 * GROWTH RULE (review-185 closeout, learned from the FEEDER_ERROR find):
 * when the union gains a kind (#87 watch folders, #83 alerting…), it needs
 * BOTH a headline here AND a subject branch in subjectOf AND a row in the
 * test's per-kind subject table — the table is what caught the missing
 * feeder branch that the negative-only sweep had been hiding.
 */
const HEADLINES: Record<ProductEvent["kind"], string> = {
	JOB_FINISHED: "✅ Encoding finished",
	JOB_ERROR: "🔴 Encoding failed",
	JOB_CANCELED: "⚪ Encoding canceled",
	JOB_QC_FAILED: "🟠 QC gate failed",
	CHANNEL_RUNNING: "🟢 Live channel running",
	CHANNEL_ERROR: "🔴 Live channel error",
	CHANNEL_STOPPED: "⚪ Live channel stopped",
	FEEDER_ERROR: "🔴 Feeder error",
	VMAF_FINISHED: "📊 VMAF finished",
	VMAF_ERROR: "🔴 VMAF failed",
	ALERT_OPENED: "🚨 Alert opened",
	ALERT_RESOLVED: "✅ Alert resolved",
	SCHEDULE_MISSED: "🟠 Schedule missed",
	SCHEDULE_NOT_RUNNING_AT_DEADLINE: "🔴 Not running at deadline",
	SCHEDULE_FIRED: "🕘 Schedule fired",
	WATCH_SUBMITTED: "📥 Watch folder submitted",
	WATCH_ERROR: "🔴 Watch folder error",
	INGRESS_CHANGED: "🌐 Public ingress changed",
};

function subjectOf(event: ProductEvent): string {
	if ("name" in event && event.name) {
		return event.name;
	}
	if ("vmafJobId" in event) {
		return event.vmafJobId;
	}
	// The feeder family: the session id is the operator's handle (review-185
	// N2's pin surfaced this branch was MISSING and FEEDER_ERROR echoed its
	// own kind as the subject).
	if ("feederSessionId" in event) {
		return event.feederSessionId;
	}
	if ("objectPath" in event) {
		return event.objectPath;
	}
	if ("scheduleId" in event) {
		return event.scheduleId;
	}
	if ("alertId" in event) {
		return event.alertId;
	}
	// WP-G G-1: the ingress change's subject is the URL that now (or no
	// longer) receives webhooks; "(none)" is a real state, not a missing one.
	if ("baseUrl" in event) {
		return event.baseUrl ?? "(none)";
	}
	return event.kind;
}

/**
 * Slack mrkdwn escaping (review-185 I1, demonstrated with rendered payloads):
 * an objectPath like `a.mov> <https://evil|CLICK>` closed our link early and
 * rendered a live forged link in the ops channel. objectPath is a CUSTOMER
 * bucket key whose emitter lands with #87 — the renderer must be safe before
 * that wire exists. Slack's documented rule: & < > only.
 */
function esc(raw: string): string {
	return raw.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** A ``` inside a detail would close our fence and let mrkdwn resume. */
function fenceSafe(raw: string): string {
	return esc(raw).replace(/```/g, "ʼʼʼ");
}

export function renderSlackMessage(event: ProductEvent): {
	text: string;
	blocks: unknown[];
} {
	const headline = HEADLINES[event.kind];
	const subject = esc(subjectOf(event));
	const error = "error" in event ? event.error : undefined;
	const reason = "reason" in event ? event.reason : undefined;
	const rawDetail = error ?? reason;
	const detail = rawDetail === undefined ? undefined : fenceSafe(rawDetail);
	const labels =
		"labels" in event && event.labels.length > 0
			? ` · ${event.labels.map(esc).join(", ")}`
			: "";
	// #161 §2: provenance rides the alert notifications — the operator's
	// Slack line says WHOSE signal this is without opening the app.
	const provenance =
		"source" in event && "subject" in event && event.source && event.subject
			? ` [${event.source === "BITOVP" ? "bitovp" : "Bitmovin"} · ${String(event.subject).toLowerCase()}]`
			: "";
	return {
		// The fallback line is what notification previews show.
		text: `${headline}: ${subject}${provenance}${detail ? ` — ${detail}` : ""}`,
		blocks: [
			{
				type: "section",
				text: {
					type: "mrkdwn",
					text: `*${headline}* — <${event.link}|${subject}>${labels}${provenance}`,
				},
			},
			...(detail
				? [
						{
							type: "section",
							text: { type: "mrkdwn", text: `\`\`\`${detail}\`\`\`` },
						},
					]
				: []),
			{
				type: "context",
				elements: [
					{
						type: "mrkdwn",
						text: `${event.kind} · ${event.occurredAt}`,
					},
				],
			},
		],
	};
}
