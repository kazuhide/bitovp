"use client";

import {
	ALERT_METRICS,
	type AlertMetric,
	alertRuleCreateSchema,
} from "@bitovp/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import {
	alertMetricLabelKey,
	metricProvenance,
} from "@/app/live/alert-metric-label";
import { DeleteResourceButton } from "@/components/delete-resource-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { HelpOverlay } from "@/components/ui/help-overlay";
import { Input } from "@/components/ui/input";
import { apiFetch } from "@/lib/api";
import { RoleAccess } from "@/lib/auth/use-role-access";
import { useT } from "@/lib/i18n/context";
import { zodIssueMessage } from "@/lib/i18n/zod-issue-message";

/**
 * Global alert rules editor . Global rows
 * apply to every channel; channel-scoped rows are created from the channel
 * detail page and listed here read-only-ish (toggle/delete still work —
 * one management surface). Delete WARNS about the event-history cascade.
 */

type AlertRuleRow = {
	id: string;
	liveChannelId: string | null;
	metric: string;
	threshold: number | null;
	windowPolls: number;
	severity: "WARN" | "CRIT";
	enabled: boolean;
};

const SELECT_CLASS =
	"h-9 w-full rounded-md border border-zinc-800 bg-zinc-950 px-2 text-sm text-zinc-200";

const NUMERIC_METRICS: ReadonlySet<string> = new Set([
	"BITRATE_BELOW",
	"FPS_BELOW",
	"ORIGIN_EDGE_DELAY_ABOVE",
]);

export function AlertsPanel() {
	const { t } = useT();
	const queryClient = useQueryClient();
	const metricId = useId();
	const thresholdId = useId();
	const severityId = useId();
	const windowId = useId();

	const [metric, setMetric] = useState<AlertMetric>("INPUT_DISCONNECTED");
	const [threshold, setThreshold] = useState("");
	const [windowPolls, setWindowPolls] = useState("2");
	const [severity, setSeverity] = useState<"WARN" | "CRIT">("WARN");
	const [issues, setIssues] = useState<string[]>([]);

	const rulesKey = ["alert-rules"];
	const rules = useQuery({
		queryKey: rulesKey,
		queryFn: () => apiFetch<AlertRuleRow[]>("/api/alert-rules"),
	});

	const invalidate = () =>
		queryClient.invalidateQueries({ queryKey: rulesKey });

	const create = useMutation({
		mutationFn: (payload: unknown) =>
			apiFetch("/api/alert-rules", {
				method: "POST",
				body: JSON.stringify(payload),
			}),
		onSuccess: () => {
			setThreshold("");
			invalidate();
		},
	});

	const toggle = useMutation({
		mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
			apiFetch(`/api/alert-rules/${id}`, {
				method: "PATCH",
				body: JSON.stringify({ enabled }),
			}),
		onSuccess: invalidate,
	});

	const remove = useMutation({
		mutationFn: (id: string) =>
			apiFetch(`/api/alert-rules/${id}`, { method: "DELETE" }),
		onSuccess: () => {
			invalidate();
		},
	});

	const submit = () => {
		setIssues([]);
		const parsed = alertRuleCreateSchema.safeParse({
			metric,
			severity,
			windowPolls: Number(windowPolls),
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
		create.mutate(parsed.data);
	};

	const metricLabel = (value: string) => {
		// #163: shared exhaustive map — a metric without a label is a tsc
		// error now, never a raw enum string rendered to the operator.
		const key = alertMetricLabelKey(value);
		return key ? t(key) : value;
	};

	return (
		<section>
			<div className="flex items-center gap-2">
				<h2 className="font-medium text-sm text-zinc-200">
					{t("alerts.settingsTitle")}
				</h2>
				<HelpOverlay labelFor={t("alerts.settingsTitle")}>
					{t("alerts.settingsExplainer")}
				</HelpOverlay>
			</div>

			<RoleAccess control="settings.live.alerts">
				<div className="mt-3 rounded-md border border-zinc-800 p-3">
					<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
						<Field label={t("alerts.metric")} htmlFor={metricId}>
							<select
								id={metricId}
								value={metric}
								onChange={(e) => {
									setMetric(e.target.value as AlertMetric);
									setThreshold("");
									setIssues([]);
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
								/>
							</Field>
						) : null}
						<Field label={t("alerts.windowPolls")} htmlFor={windowId}>
							<Input
								id={windowId}
								type="number"
								min={1}
								max={20}
								value={windowPolls}
								onChange={(e) => setWindowPolls(e.target.value)}
							/>
						</Field>
						<Field label={t("alerts.severity")} htmlFor={severityId}>
							<select
								id={severityId}
								value={severity}
								onChange={(e) => setSeverity(e.target.value as "WARN" | "CRIT")}
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
					{create.isError ? (
						<p role="alert" className="mt-2 text-red-400 text-xs">
							{create.error instanceof Error
								? create.error.message
								: t("alerts.addFailed")}
						</p>
					) : null}
					<div className="mt-3">
						<Button type="button" onClick={submit} disabled={create.isPending}>
							{t("alerts.addGlobalRuleButton")}
						</Button>
					</div>
				</div>
			</RoleAccess>

			{(toggle.isError || remove.isError) && (
				<p role="alert" className="mt-3 text-red-400 text-sm">
					{t("common.requestFailed")}
				</p>
			)}
			{rules.isLoading ? (
				<p className="mt-3 text-xs text-zinc-500">{t("common.loading")}</p>
			) : rules.isError ? (
				<p role="alert" className="mt-3 text-red-400 text-sm">
					{t("common.requestFailed")}{" "}
					<Button
						variant="secondary"
						size="sm"
						disabled={rules.isFetching}
						onClick={() => rules.refetch()}
					>
						{t("settingsForms.retry")}
					</Button>
				</p>
			) : (rules.data ?? []).length === 0 ? (
				<p className="mt-3 text-xs text-zinc-500">{t("alerts.noRules")}</p>
			) : (
				<ul className="mt-3 space-y-2">
					{(rules.data ?? []).map((rule) => (
						<li
							key={rule.id}
							className="flex flex-wrap items-center gap-3 rounded-md border border-zinc-800 px-3 py-2"
						>
							<Badge tone={rule.severity === "CRIT" ? "error" : "neutral"}>
								{rule.severity}
							</Badge>
							<span className="text-sm text-zinc-200">
								{metricLabel(rule.metric)}
							</span>
							{(() => {
								// #161 §2: provenance beside every rule row.
								const prov = metricProvenance(rule.metric);
								return prov ? (
									<span
										title={t("alerts.provenanceHelp")}
										className="rounded border border-zinc-700 px-1.5 py-0.5 font-mono text-[10px] text-zinc-400"
									>
										{prov.sourceKey ? t(prov.sourceKey) : prov.sourceName} ·{" "}
										{t(prov.subjectKey)}
									</span>
								) : null;
							})()}
							{rule.threshold !== null ? (
								<span className="font-mono text-xs text-zinc-400">
									{/* review-161-162 m2: _ABOVE metrics breach when the
									    measurement EXCEEDS the threshold — "<" showed the
									    wrong direction for ORIGIN_EDGE_DELAY_ABOVE. */}
									{rule.metric.endsWith("_ABOVE") ? ">" : "<"} {rule.threshold}
								</span>
							) : null}
							<span className="text-xs text-zinc-500">
								{t(
									rule.windowPolls === 1
										? "alerts.windowLineOne"
										: "alerts.windowLineOther",
									{ polls: rule.windowPolls },
								)}
							</span>
							<Badge tone="neutral">
								{rule.liveChannelId
									? t("alerts.scopeChannel")
									: t("alerts.scopeGlobal")}
							</Badge>
							{!rule.enabled ? (
								<Badge tone="neutral">{t("alerts.disabled")}</Badge>
							) : null}
							<span className="grow" />
							<RoleAccess control="settings.live.alerts">
								<Button
									type="button"
									variant="secondary"
									onClick={() =>
										toggle.mutate({ id: rule.id, enabled: !rule.enabled })
									}
									disabled={toggle.isPending}
								>
									{rule.enabled ? t("alerts.disable") : t("alerts.enable")}
								</Button>
								{/* review-83b I6: the inline two-click pattern rendered both
							    buttons at the same DOM position, so a double-click fired the
							    DELETE — cascade-erasing the rule's whole alert history. The
							    Dialog every other destructive resource uses cannot be
							    double-clicked through. */}
								<DeleteResourceButton
									resourceLabel={metricLabel(rule.metric)}
									confirmTitle={t("alerts.confirmDelete")}
									confirmDescription={t("alerts.deleteCascadeWarning")}
									pending={remove.isPending}
									onConfirm={() => remove.mutate(rule.id)}
								/>
							</RoleAccess>
						</li>
					))}
				</ul>
			)}
		</section>
	);
}
