"use client";

import {
	ALERT_METRICS,
	type AlertMetric,
	alertRuleCreateSchema,
} from "@bitovp/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import {
	alertMetricLabelKey,
	metricProvenance,
} from "@/app/live/alert-metric-label";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { apiFetch } from "@/lib/api";
import { RoleAccess } from "@/lib/auth/use-role-access";
import { localizedCustomerError } from "@/lib/customer-error";
import { formatDateTime } from "@/lib/format";
import { useT } from "@/lib/i18n/context";
import { zodIssueMessage } from "@/lib/i18n/zod-issue-message";

/**
 * Channel alert surface : the open-alert banner, the
 * resolved history, and the channel-scoped rule add. The alerts QUERY
 * lives in ChannelDetail (the same data feeds the heartbeat chart's
 * reference dots) — this component presents and mutates.
 */

export type ChannelAlertEvent = {
	id: string;
	openedAt: string;
	resolvedAt: string | null;
	context: Record<string, unknown> | null;
	rule: {
		metric: string;
		severity: "WARN" | "CRIT";
		threshold: number | null;
		windowPolls: number;
	};
};

const SELECT_CLASS =
	"h-9 w-full rounded-md border border-zinc-800 bg-zinc-950 px-2 text-sm text-zinc-200";

const NUMERIC_METRICS: ReadonlySet<string> = new Set([
	"BITRATE_BELOW",
	"FPS_BELOW",
]);

export function AlertPanel({
	channelId,
	open,
	history,
	fetchError = null,
	mode = "open",
	onChanged,
}: {
	channelId: string;
	open: ChannelAlertEvent[];
	history: ChannelAlertEvent[];
	/**
	 * . `open` = the firing events and the resolve buttons, which is
	 * the Operations readout. `manage` = the channel-scoped rule editor and
	 * the resolved history, which is Diagnostics. The default is the readout:
	 * a caller that forgets to choose gets the monitoring half, never the
	 * authoring half.
	 */
	mode?: "open" | "manage";
	/**
	 * review-83b I5: a failed alerts fetch used to render as "No alerts
	 * firing" — the worst possible default for a monitoring surface. The
	 * caller passes its query error; quiet is claimed only when the fetch
	 * actually succeeded.
	 */
	fetchError?: string | null;
	onChanged: () => void;
}) {
	const { t } = useT();
	const queryClient = useQueryClient();
	const metricId = useId();
	const thresholdId = useId();
	const severityId = useId();

	const [metric, setMetric] = useState<AlertMetric>("INPUT_DISCONNECTED");
	const [threshold, setThreshold] = useState("");
	const [severity, setSeverity] = useState<"WARN" | "CRIT">("WARN");
	const [issues, setIssues] = useState<string[]>([]);

	/** review-83b C1: the operator's escape hatch — resolve a live event
	    they have seen and dealt with. The orphan sweep handles the
	    channel/rule-left cases; this handles the human. */
	const resolveEvent = useMutation({
		mutationFn: (eventId: string) =>
			apiFetch(`/api/live-channels/${channelId}/alerts/${eventId}`, {
				method: "PATCH",
				body: JSON.stringify({ action: "resolve" }),
			}),
		onSuccess: onChanged,
		// A lost race (engine resolved it first) must repaint the truth.
		onError: onChanged,
	});

	const addRule = useMutation({
		mutationFn: (payload: unknown) =>
			apiFetch("/api/alert-rules", {
				method: "POST",
				body: JSON.stringify(payload),
			}),
		onSuccess: () => {
			setThreshold("");
			queryClient.invalidateQueries({ queryKey: ["alert-rules"] });
			onChanged();
		},
	});

	const submitRule = () => {
		setIssues([]);
		const parsed = alertRuleCreateSchema.safeParse({
			liveChannelId: channelId,
			metric,
			severity,
			...(threshold !== "" ? { threshold: Number(threshold) } : {}),
		});
		if (!parsed.success) {
			setIssues(
				parsed.error.issues.map(
					(issue) =>
						`${issue.path.join(".") || "rule"}: ${zodIssueMessage(issue, t)}`,
				),
			);
			return;
		}
		addRule.mutate(parsed.data);
	};

	const metricLabel = (value: string) => {
		// #163: shared exhaustive map — a metric without a label is a tsc
		// error now, never a raw enum string rendered to the operator.
		const key = alertMetricLabelKey(value);
		return key ? t(key) : value;
	};
	/**
	 * PROVIDER_WARNING's whole finding is the encoder's own sentence (the
	 * `2167 ms >= 2000 ms` figure) — the evaluator snapshots it into the
	 * event's context as `message`. Rendered verbatim under the row, for any
	 * metric whose context carries one; never translated.
	 */
	const providerMessage = (event: ChannelAlertEvent) => {
		const message = event.context?.message;
		if (typeof message !== "string" || message === "") {
			return null;
		}
		return (
			<p className="w-full break-words font-mono text-[11px] text-zinc-300">
				<span className="text-zinc-500">{t("alerts.providerMessage")}: </span>
				{message}
			</p>
		);
	};
	// #161 §2: the provenance pair beside every signal — a BITOVP alert
	// never renders unlabeled.
	const provenanceChip = (metricValue: string) => {
		const prov = metricProvenance(metricValue);
		if (!prov) {
			return null;
		}
		return (
			<span
				title={t("alerts.provenanceHelp")}
				className="rounded border border-zinc-700 px-1.5 py-0.5 font-mono text-[10px] text-zinc-400"
			>
				{prov.sourceKey ? t(prov.sourceKey) : prov.sourceName} ·{" "}
				{t(prov.subjectKey)}
			</span>
		);
	};

	return (
		<div className="mt-2 space-y-4">
			{/*
: the OPEN alerts and the rule EDITOR are two different
			    jobs, and they used to be one always-expanded block — the rule
			    form sat directly under the firing events, with the resolved
			    history under that. `mode` splits them
			    across the page instead of duplicating either: "open" is the
			    Operations readout, "manage" is the Diagnostics editor plus the
			    resolved history. One component, one set of mutations, two
			    mounts, no shared state to fork.
			*/}
			{mode === "open" ? (
				<>
					{/* Open banner — severity colored; absent entirely when quiet. */}
					{open.length > 0 ? (
						<div role="alert" className="space-y-2">
							{open.map((event) => (
								<div
									key={event.id}
									className={`flex flex-wrap items-center gap-3 rounded-md border px-3 py-2 ${
										event.rule.severity === "CRIT"
											? "border-red-800 bg-red-950/40"
											: "border-amber-800 bg-amber-950/40"
									}`}
								>
									<Badge
										tone={event.rule.severity === "CRIT" ? "error" : "neutral"}
									>
										{event.rule.severity}
									</Badge>
									<span className="text-sm text-zinc-100">
										{metricLabel(event.rule.metric)}
									</span>
									{provenanceChip(event.rule.metric)}
									<span className="font-mono text-xs text-zinc-400">
										{t("alerts.openedAt", {
											time: formatDateTime(event.openedAt),
										})}
									</span>
									<span className="grow" />
									<RoleAccess control="live.channel.alerts">
										<Button
											type="button"
											variant="secondary"
											size="sm"
											onClick={() => resolveEvent.mutate(event.id)}
											disabled={resolveEvent.isPending}
										>
											{t("alerts.resolveButton")}
										</Button>
									</RoleAccess>
									{providerMessage(event)}
								</div>
							))}
							{resolveEvent.isError ? (
								<p role="alert" className="text-red-400 text-xs">
									{t("alerts.resolveFailed", {
										message: localizedCustomerError(
											t,
											resolveEvent.error,
											"common.requestFailed",
										),
									})}
								</p>
							) : null}
						</div>
					) : fetchError ? (
						<p role="alert" className="text-red-400 text-xs">
							{t("alerts.fetchFailed", { message: fetchError })}
						</p>
					) : (
						<p className="text-xs text-zinc-500">{t("alerts.noneOpen")}</p>
					)}
				</>
			) : (
				<>
					{/* Channel-scoped rule add */}
					<RoleAccess control="live.channel.alerts">
						<div className="rounded-md border border-zinc-800 p-3">
							<p className="text-xs text-zinc-400">
								{t("alerts.addChannelRule")}
							</p>
							<div className="mt-2 grid gap-3 sm:grid-cols-3">
								<Field label={t("alerts.metric")} htmlFor={metricId}>
									<select
										id={metricId}
										value={metric}
										onChange={(e) => {
											const next = e.target.value as AlertMetric;
											setMetric(next);
											// review-83b I8: a threshold typed for BITRATE/FPS
											// then hidden by a metric switch still rode the
											// submit — blocked by a message about a field that
											// was no longer on screen and could not be cleared.
											if (!NUMERIC_METRICS.has(next)) {
												setThreshold("");
											}
										}}
										className={SELECT_CLASS}
									>
										{ALERT_METRICS.map((value) => (
											<option key={value} value={value}>
												{metricLabel(value)}
											</option>
										))}
									</select>
								</Field>
								{NUMERIC_METRICS.has(metric) ? (
									<Field label={t("alerts.threshold")} htmlFor={thresholdId}>
										<Input
											id={thresholdId}
											type="number"
											min={1}
											value={threshold}
											onChange={(e) => setThreshold(e.target.value)}
											placeholder={
												metric === "BITRATE_BELOW" ? "1000000" : "24"
											}
										/>
									</Field>
								) : null}
								<Field label={t("alerts.severity")} htmlFor={severityId}>
									<select
										id={severityId}
										value={severity}
										onChange={(e) =>
											setSeverity(e.target.value as "WARN" | "CRIT")
										}
										className={SELECT_CLASS}
									>
										<option value="WARN">WARN</option>
										<option value="CRIT">CRIT</option>
									</select>
								</Field>
							</div>
							{issues.length > 0 ? (
								<ul role="alert" className="mt-2 space-y-1">
									{issues.map((issue) => (
										<li key={issue} className="text-red-400 text-xs">
											{issue}
										</li>
									))}
								</ul>
							) : null}
							{addRule.isError ? (
								<p role="alert" className="mt-2 text-red-400 text-xs">
									{localizedCustomerError(t, addRule.error, "alerts.addFailed")}
								</p>
							) : null}
							<div className="mt-3">
								<Button
									type="button"
									variant="secondary"
									onClick={submitRule}
									disabled={addRule.isPending}
								>
									{t("alerts.addRuleButton")}
								</Button>
							</div>
						</div>
					</RoleAccess>

					{/* Resolved history */}
					<div>
						<h4 className="font-medium text-xs text-zinc-300">
							{t("alerts.history")}
						</h4>
						{history.length === 0 ? (
							<p className="mt-1 text-xs text-zinc-500">
								{t("alerts.noneHistory")}
							</p>
						) : (
							<ul className="mt-2 space-y-2">
								{history.map((event) => (
									<li
										key={event.id}
										className="flex flex-wrap items-center gap-3 rounded-md border border-zinc-900 px-3 py-2"
									>
										<Badge tone="neutral">{event.rule.severity}</Badge>
										<span className="text-sm text-zinc-300">
											{metricLabel(event.rule.metric)}
										</span>
										{provenanceChip(event.rule.metric)}
										<span className="font-mono text-xs text-zinc-500">
											{formatDateTime(event.openedAt)}
											{" → "}
											{event.resolvedAt
												? formatDateTime(event.resolvedAt)
												: "—"}
										</span>
										{providerMessage(event)}
									</li>
								))}
							</ul>
						)}
					</div>
				</>
			)}
		</div>
	);
}
