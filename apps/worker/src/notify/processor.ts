import {
	eventMatchesFilter,
	hostMatches,
	notificationRuleFilterSchema,
	notifyJobSchema,
	type ProductEvent,
	secretEgressUrlSchema,
} from "@bitovp/core";
import { renderSlackMessage } from "./slack";

/**
 * Notify queue consumer : fan one product event out to every
 * enabled channel whose enabled rules match it.
 *
 * C22 DUAL ENFORCEMENT, worker end: the URL is re-parsed against
 * secretEgressUrlSchema before every send (https-only, no userinfo — a row
 * written around the route refuses HERE, review-183 I2) and the
 * SECRET_EGRESS_ALLOWED_HOSTS allowlist is re-checked before EVERY post.
 * Allowlist semantics mirror executor.ts, the worker's stated enforcement
 * convention (review-183 I1 — the first cut inverted this): EMPTY means
 * unset-or-blank env, which WARNS and delivers, exactly like the plan
 * validator's PLAN_SECRET_EGRESS_HOST_UNRESTRICTED warning; non-empty
 * enforces. Config errors (malformed allowlist entry, unparsable vault URL)
 * are TYPED refusals, not delivery failures — retrying cannot fix them
 * (review-183 N2).
 *
 * GENERIC_WEBHOOK receives the event JSON verbatim + X-BitOvp-Event header;
 * SLACK_WEBHOOK receives compact blocks (PR2, slack.ts). An UNKNOWN kind —
 * a row written by a newer web — is a visible skip, never a throw.
 */

export type NotifyDeps = {
	prisma: {
		notificationChannel: {
			findMany(args: {
				where: { enabled: boolean };
				include: { rules: { where: { enabled: boolean } } };
			}): Promise<
				Array<{
					id: string;
					name: string;
					kind: string;
					credentialId: string;
					rules: Array<{ events: string[]; filter: unknown }>;
				}>
			>;
		};
	};
	revealWebhookUrl(credentialId: string): Promise<string>;
	/** SECRET_EGRESS_ALLOWED_HOSTS via parseSecretEgressAllowlist — ALWAYS an
	    array; [] = unset/blank (warn-and-deliver, executor.ts parity). */
	egressAllowlist(): string[];
	fetchImpl?: typeof fetch;
};

export type DeliveryResult = {
	channelId: string;
	channelName: string;
	outcome:
		| "DELIVERED"
		| "REFUSED_HOST"
		| "REFUSED_CONFIG"
		| "SKIPPED_KIND"
		| "FAILED";
	detail?: string;
};

export function createNotifyProcessor(deps: NotifyDeps) {
	const doFetch = deps.fetchImpl ?? fetch;
	return async function processNotifyJob(job: {
		data: unknown;
	}): Promise<DeliveryResult[]> {
		// Re-parse at the consumer end: a queue writer cannot smuggle fields
		// past the strict payload contract (the emitter validated too).
		const event: ProductEvent = notifyJobSchema.parse(job.data);
		const channels = await deps.prisma.notificationChannel.findMany({
			where: { enabled: true },
			include: { rules: { where: { enabled: true } } },
		});
		const results: DeliveryResult[] = [];
		for (const channel of channels) {
			const matches = channel.rules.some((rule) => {
				if (!rule.events.includes(event.kind)) {
					return false;
				}
				const filter = notificationRuleFilterSchema.safeParse(
					rule.filter ?? {},
				);
				// An unparsable filter refuses rather than matching everything:
				// a malformed row must not broadcast every event to the channel.
				return filter.success && eventMatchesFilter(event, filter.data);
			});
			if (!matches) {
				continue;
			}
			if (
				channel.kind !== "GENERIC_WEBHOOK" &&
				channel.kind !== "SLACK_WEBHOOK"
			) {
				// A kind this worker version does not know (forward-compat with
				// rows written by a newer web) — visible skip, never a throw.
				results.push({
					channelId: channel.id,
					channelName: channel.name,
					outcome: "SKIPPED_KIND",
					detail: `unknown channel kind ${channel.kind}`,
				});
				continue;
			}
			let url: string;
			try {
				// Inside the try (review-183 N10): a decrypt failure or a
				// url-less secret is a CONFIG error — outside, it would burn
				// all five retry attempts on something no retry can fix.
				url = await deps.revealWebhookUrl(channel.credentialId);
				// Scheme/userinfo re-check (review-183 I2: the save-time schema is
				// the front door; this covers a row written around it).
				secretEgressUrlSchema.parse(url);
				const allowlist = deps.egressAllowlist();
				if (allowlist.length === 0) {
					// Unset/blank env: warn-and-deliver, the executor.ts convention.
					console.warn(
						`[egress] notify: SECRET_EGRESS_ALLOWED_HOSTS is unset — delivering ${event.kind} to ${new URL(url).hostname} on the channel row's authority alone`,
					);
				} else {
					const hostname = new URL(url).hostname.toLowerCase();
					const allowed = allowlist.some((entry) =>
						hostMatches(hostname, entry),
					);
					if (!allowed) {
						results.push({
							channelId: channel.id,
							channelName: channel.name,
							outcome: "REFUSED_HOST",
							detail: `${hostname} is not in SECRET_EGRESS_ALLOWED_HOSTS`,
						});
						continue;
					}
				}
			} catch (err) {
				// Typed refusal (review-183 N2/P2/P3): a malformed allowlist entry
				// or an unparsable/http vault URL is a CONFIG error — retrying
				// burns attempts on something no retry can fix.
				results.push({
					channelId: channel.id,
					channelName: channel.name,
					outcome: "REFUSED_CONFIG",
					detail: err instanceof Error ? err.message : String(err),
				});
				continue;
			}
			try {
				// PR2: Slack rows get compact blocks; generic rows the event
				// verbatim. Both bodies derive from the strict union only.
				const body =
					channel.kind === "SLACK_WEBHOOK"
						? JSON.stringify(renderSlackMessage(event))
						: JSON.stringify(event);
				const res = await doFetch(url, {
					method: "POST",
					headers: {
						"content-type": "application/json",
						"x-bitovp-event": event.kind,
					},
					body,
					// review-183 I3: undici has no overall response timeout — a
					// host that accepts and never responds would pin the worker
					// slot indefinitely (a total notification outage).
					signal: AbortSignal.timeout(10_000),
				});
				if (res.ok) {
					results.push({
						channelId: channel.id,
						channelName: channel.name,
						outcome: "DELIVERED",
					});
				} else {
					results.push({
						channelId: channel.id,
						channelName: channel.name,
						outcome: "FAILED",
						detail: `HTTP ${res.status}`,
					});
				}
			} catch (err) {
				results.push({
					channelId: channel.id,
					channelName: channel.name,
					outcome: "FAILED",
					detail: err instanceof Error ? err.message : String(err),
				});
			}
		}
		// At-least-once with bounded retries (design §7): any FAILED delivery
		// throws so BullMQ retries the whole event; DELIVERED channels get a
		// duplicate on retry — recorded as the at-least-once ledger row.
		const failed = results.filter((r) => r.outcome === "FAILED");
		if (failed.length > 0) {
			throw new Error(
				`notify delivery failed for ${failed
					.map((f) => `${f.channelName} (${f.detail ?? "unknown"})`)
					.join(", ")}`,
			);
		}
		return results;
	};
}
