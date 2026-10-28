"use client";

import type { QcGate, QcVerdict } from "@bitovp/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import { useDocumentOrganization } from "@/components/providers";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/api";
import { RoleAccess } from "@/lib/auth/use-role-access";
import { formatDateTime } from "@/lib/format";
import { useT } from "@/lib/i18n/context";
import type { JobStatus } from "@/lib/job-status";
import { bindPassiveRequestUrl } from "@/lib/passive-request";

/**
 * QC gate panel : the gate's rules beside
 * what was actually measured — actual vs threshold per target, one row per
 * per-title rung (the verdict carries a `variant` per rung), unmeasured
 * targets stated as such rather than hidden. Renders NOTHING for plans
 * without a gate; the VMAF reports list already covers plain measurements.
 *
 * The verdict is read from the job row (denormalized by the vmaf-runner in
 * the same transaction as the measurement's FINISHED), so this panel can
 * never disagree with the jobs list's PASS/FAIL column.
 */

export function QcGatePanel(props: {
	gate: QcGate;
	verdict: QcVerdict | null;
	status: JobStatus;
	jobId: string;
	/** Latest measurement's id, for the report link; null before it exists. */
	vmafJobId: string | null;
	/* The latest measurement status determines this badge. MARK_ONLY can leave a finished encoding with a failed measurement and no quality verdict; the panel must agree with the evidence export. */
	measurementStatus?: string | null;
	/** Delivery-forced timestamp ; null = never overridden. */
	overriddenAt?: string | null;
}) {
	const { t } = useT();
	const organizationId = useDocumentOrganization();
	const reportUrl = (format: string) =>
		organizationId
			? bindPassiveRequestUrl(
					`/api/encoding-jobs/${props.jobId}/qc-report?format=${format}`,
					organizationId,
				)
			: undefined;
	const { gate, verdict, status, jobId, vmafJobId } = props;
	const measurementStatus = props.measurementStatus ?? null;
	const overriddenAt = props.overriddenAt ?? null;
	const queryClient = useQueryClient();
	// Two-click confirm (the review-187 pattern): forcing delivery past a
	// failing gate is exactly the kind of click that must not happen by
	// accident. First click arms, second fires; anything else disarms.
	const [confirmOverride, setConfirmOverride] = useState(false);
	const override = useMutation({
		mutationFn: () =>
			apiFetch(`/api/encoding-jobs/${jobId}/qc-override`, { method: "POST" }),
		onSuccess: () => {
			setConfirmOverride(false);
			queryClient.invalidateQueries({ queryKey: ["encoding-job", jobId] });
		},
	});

	return (
		<section className="mt-8">
			<div className="flex flex-wrap items-center gap-3">
				<h2 className="font-medium text-sm text-zinc-200">
					{t("jobDetail.qcGateTitle")}
				</h2>
				{verdict ? (
					<Badge tone={verdict.pass ? "ok" : "error"}>
						{verdict.pass ? t("jobs.qcPass") : t("jobs.qcFail")}
					</Badge>
				) : measurementStatus === "ERROR" || status === "QC_FAILED" ? (
					// No verdict + a dead measurement = the measurement itself
					// failed — say that, never "FAIL" (which would claim a
					// quality judgement) and never No verdict (which reads as
					// "still coming" when nothing more is; review-202 I2 —
					// mirrors the export's verdictBadge precedence). Covers
					// BOTH routes here: QC_FAILED (BLOCK) and FINISHED with a
					// MARK_ONLY gate whose vmaf run errored.
					<Badge tone="error">{t("jobDetail.qcGateMeasurementFailed")}</Badge>
				) : status === "AWAITING_QC" ? (
					<Badge tone="neutral">{t("jobDetail.qcGateAwaiting")}</Badge>
				) : (
					<Badge tone="neutral">{t("jobDetail.qcGateNoVerdict")}</Badge>
				)}
				<span className="text-xs text-zinc-500">
					{gate.onFail === "BLOCK_MANIFESTS"
						? t("jobDetail.qcGateBlocking")
						: t("jobDetail.qcGateMarkOnly")}
				</span>
				<RoleAccess control="vod.job.qc">
					{status === "QC_FAILED" ? (
						<Button
							variant={confirmOverride ? "destructive" : "secondary"}
							size="sm"
							disabled={override.isPending}
							onClick={() => {
								if (confirmOverride) {
									override.mutate();
								} else {
									setConfirmOverride(true);
								}
							}}
							onBlur={() => setConfirmOverride(false)}
						>
							{override.isPending
								? t("jobDetail.qcGateOverriding")
								: confirmOverride
									? t("jobDetail.qcGateOverrideConfirm")
									: t("jobDetail.qcGateOverrideButton")}
						</Button>
					) : null}
				</RoleAccess>
			</div>

			{overriddenAt ? (
				// A forced delivery is never silent (design §4): the panel says
				// so beside the verdict it was forced past. Distinct wording
				// when there IS no verdict (review-203 N4): a measurement-error
				// override forced past a MISSING result, not a failing one.
				<p className="mt-2 text-xs text-amber-400">
					{t(
						verdict
							? "jobDetail.qcGateOverridden"
							: "jobDetail.qcGateOverriddenNoVerdict",
						{ at: formatDateTime(overriddenAt) },
					)}
				</p>
			) : null}
			{override.isError ? (
				<p role="alert" className="mt-2 text-red-400 text-xs">
					{t("jobDetail.qcGateOverrideFailed", {
						error:
							override.error instanceof Error
								? override.error.message
								: String(override.error),
					})}
				</p>
			) : null}

			{status === "AWAITING_QC" ? (
				<p className="mt-2 text-xs text-zinc-400">
					{t("jobDetail.qcGateAwaitingBody")}
				</p>
			) : null}

			<div className="mt-2 overflow-x-auto rounded-md border border-zinc-800">
				<table className="w-full text-left text-sm">
					<thead>
						<tr className="text-xs text-zinc-500">
							<th className="px-3 py-2 font-medium">
								{t("jobDetail.qcGateMetric")}
							</th>
							<th className="px-3 py-2 font-medium">
								{t("jobDetail.qcGateScope")}
							</th>
							<th className="px-3 py-2 font-medium">
								{t("jobDetail.qcGateThreshold")}
							</th>
							<th className="px-3 py-2 font-medium">
								{t("jobDetail.qcGateTarget")}
							</th>
							<th className="px-3 py-2 font-medium">
								{t("jobDetail.qcGateActual")}
							</th>
							<th className="px-3 py-2 font-medium">
								{t("jobDetail.qcGateResult")}
							</th>
						</tr>
					</thead>
					<tbody className="divide-y divide-zinc-800/70">
						{verdict
							? verdict.ruleResults.flatMap((ruleResult, ruleIndex) =>
									ruleResult.actuals.map((actual, actualIndex) => (
										<tr
											key={`${ruleIndex}-${actual.rendition}-${actual.variant ?? actualIndex}`}
										>
											<td className="px-3 py-2 text-zinc-300">
												{ruleResult.rule.metric}
											</td>
											<td className="px-3 py-2 text-xs text-zinc-400">
												{ruleResult.rule.scope}
											</td>
											<td className="px-3 py-2 tabular-nums text-zinc-300">
												≥ {ruleResult.rule.gte}
											</td>
											<td className="px-3 py-2 text-zinc-300">
												{actual.rendition}
												{actual.variant ? (
													<span className="ml-1 text-xs text-zinc-500">
														({actual.variant})
													</span>
												) : null}
											</td>
											<td className="px-3 py-2 tabular-nums text-zinc-300">
												{/* typeof guard, not === null (review-202 N1): the
												    verdict is a Json cast — a non-number here must
												    render as unmeasured, not throw the page down. */}
												{typeof actual.value === "number"
													? actual.value.toFixed(2)
													: t("jobDetail.qcGateUnmeasured")}
											</td>
											<td className="px-3 py-2">
												<Badge tone={actual.pass ? "ok" : "error"}>
													{actual.pass ? t("jobs.qcPass") : t("jobs.qcFail")}
												</Badge>
											</td>
										</tr>
									)),
								)
							: gate.rules.map((rule, index) => (
									<tr key={`${rule.metric}-${index}`}>
										<td className="px-3 py-2 text-zinc-300">{rule.metric}</td>
										<td className="px-3 py-2 text-xs text-zinc-400">
											{rule.scope}
										</td>
										<td className="px-3 py-2 tabular-nums text-zinc-300">
											≥ {rule.gte}
										</td>
										<td className="px-3 py-2 text-xs text-zinc-500">
											{rule.renditions?.join(", ") ??
												t("jobDetail.qcGateAllRenditions")}
										</td>
										<td className="px-3 py-2 text-xs text-zinc-600">—</td>
										<td className="px-3 py-2 text-xs text-zinc-600">—</td>
									</tr>
								))}
					</tbody>
				</table>
			</div>

			<div className="mt-2 flex flex-wrap items-center gap-3 text-xs">
				{vmafJobId ? (
					<Link
						href={`/qc/${vmafJobId}`}
						className="text-emerald-400 hover:text-emerald-300"
					>
						{t("jobDetail.qcGateViewReport")}
					</Link>
				) : null}
				{/* Evidence export (design §4): json/csv for filing systems, html
				    for print-to-PDF. Plain anchors — these are downloads, not
				    navigations, and the html one opens its own tab. */}
				<a
					href={reportUrl("json")}
					className="text-zinc-400 hover:text-zinc-200"
				>
					{t("jobDetail.qcGateExportJson")}
				</a>
				<a
					href={reportUrl("csv")}
					className="text-zinc-400 hover:text-zinc-200"
				>
					{t("jobDetail.qcGateExportCsv")}
				</a>
				<a
					href={reportUrl("html")}
					target="_blank"
					rel="noreferrer"
					className="text-zinc-400 hover:text-zinc-200"
				>
					{t("jobDetail.qcGateExportHtml")}
				</a>
			</div>
		</section>
	);
}
