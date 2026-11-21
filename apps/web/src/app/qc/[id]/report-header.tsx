"use client";

import { hdrMeasurementOf } from "@bitovp/core";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { formatDateTime } from "@/lib/format";
import { useT } from "@/lib/i18n/context";
import { type QcJobDetail, shortJobId, VMAF_STATUS_TONE } from "../vmaf-shared";
import { ExportButtons } from "./export-buttons";

export function BackToVmafLab() {
	const { t } = useT();
	return (
		<Link
			href="/qc"
			className="inline-flex w-fit items-center gap-1.5 text-sm text-zinc-400 hover:text-zinc-200 focus-visible:outline-2 focus-visible:outline-emerald-500 focus-visible:outline-offset-2"
		>
			<ArrowLeft className="h-4 w-4" aria-hidden="true" />
			{t("qc.backToLab")}
		</Link>
	);
}

export function QcReportHeader({
	job,
	actions,
}: {
	job: QcJobDetail;
	actions: ReactNode;
}) {
	const { t } = useT();
	const count = job.results.length;
	const reportId = shortJobId(job.id);
	// A verified HDR model is shown with its measurement domain in the VMAF panel.
	const model =
		job.kind === "BANDING"
			? "CAMBI"
			: job.results.some(
						(result) => hdrMeasurementOf(result)?.model === job.model,
					)
				? null
				: job.model;
	return (
		<header className="space-y-3">
			<BackToVmafLab />
			<div className="flex flex-wrap items-end justify-between gap-x-5 gap-y-3">
				<div className="min-w-0 flex-1 basis-full sm:basis-64">
					<p className="text-xs text-zinc-400">
						{t(job.kind === "BANDING" ? "banding.report" : "qc.reportTitle")}
					</p>
					<h1
						className="mt-1 font-semibold text-xl text-zinc-50 [overflow-wrap:anywhere]"
						title={t("uiX.reportShortId", { id: reportId })}
					>
						{job.encodingName ?? reportId}
					</h1>
					<div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-400">
						<Badge tone={VMAF_STATUS_TONE[job.status]}>{job.status}</Badge>
						{model ? (
							<span className="break-all font-mono">{model}</span>
						) : null}
						<span>{job.mode}</span>
						{count > 0 ? (
							<span>
								{t(
									count === 1
										? "uiX.renditionCountOne"
										: "uiX.renditionCountOther",
									{ count },
								)}
							</span>
						) : null}
						{job.encodingJobId ? (
							<Link
								href={`/vod/jobs/${job.encodingJobId}`}
								className="text-emerald-400 underline decoration-emerald-500/40 underline-offset-2 hover:decoration-current focus-visible:outline-2 focus-visible:outline-emerald-500 focus-visible:outline-offset-2"
							>
								{t("qc.sourceEncodingJob")}
							</Link>
						) : null}
					</div>
				</div>
				<div className="flex flex-wrap items-center gap-2 empty:hidden">
					{count > 0 ? <ExportButtons jobId={job.id} /> : null}
					{actions}
				</div>
			</div>
		</header>
	);
}

export function QcReportRunDetails({
	job,
	children,
}: {
	job: Pick<QcJobDetail, "createdAt" | "encodingJobId">;
	children?: ReactNode;
}) {
	const { t } = useT();
	return (
		<details className="mt-6 rounded-md border border-zinc-800 px-3 py-2">
			<summary className="cursor-pointer text-sm text-zinc-300 focus-visible:outline-2 focus-visible:outline-emerald-500">
				{t("qc.runDetails")}
			</summary>
			<div className="mt-2 space-y-2 text-xs text-zinc-400">
				<p>
					<time dateTime={job.createdAt}>{formatDateTime(job.createdAt)}</time>
				</p>
				{job.encodingJobId ? (
					<p>
						{t("uiX.fromEncodingJob")}{" "}
						<span className="break-all font-mono">{job.encodingJobId}</span>
					</p>
				) : null}
				{children}
			</div>
		</details>
	);
}
