"use client";

import type { BandingPooled } from "@bitovp/core";
import Link from "next/link";
import { type ReactNode, useState } from "react";
import {
	CartesianGrid,
	ReferenceLine,
	ResponsiveContainer,
	Scatter,
	ScatterChart,
	Tooltip,
	XAxis,
	YAxis,
} from "recharts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { InfoHint } from "@/components/ui/info-hint";
import { formatDateTime } from "@/lib/format";
import { useT } from "@/lib/i18n/context";
import type { PublicBandingAssessment } from "@/lib/server/banding-public";
import {
	type BandingJobDetail,
	type BandingResultData,
	type RenditionRef,
	renditionLabel,
	shortJobId,
	VMAF_STATUS_TONE,
} from "../vmaf-shared";
import { BandingFrameComparison } from "./banding-frame-comparison";
import { BandingIntervalPlayer } from "./banding-interval-player";
import { ExportButtons } from "./export-buttons";

type Result = BandingResultData & {
	id: string;
	renditionRef: RenditionRef;
	pooled: { banding?: BandingPooled };
};
const fixed = (value: number) => value.toFixed(3).replace(/\.?0+$/, "");

/** Independent CAMBI panel: VMAF frame indices and source FPS never enter its timeline. */
export function BandingPanels({
	results,
	labels,
	initialIds,
	compact = false,
}: {
	results: Result[];
	labels?: Readonly<Record<string, string>>;
	initialIds?: [string, string];
	compact?: boolean;
}) {
	const { t } = useT();
	const heading = (
		<h2 className="font-medium text-sm text-zinc-200">
			{t("banding.title")} · CAMBI
		</h2>
	);
	return (
		<div className={compact ? "space-y-3" : "mt-6 space-y-6"}>
			{compact ? (
				<div className="flex items-center gap-2">
					{heading}
					<InfoHint labelFor={t("banding.title")} text={t("banding.hint")} />
				</div>
			) : (
				heading
			)}
			{!compact ? (
				<p className="text-sm text-zinc-400">{t("banding.hint")}</p>
			) : null}
			<BandingFrameComparison
				results={results}
				labels={labels}
				initialIds={initialIds}
				renderChart={(selection) => (
					<BandingResultPanels
						results={results}
						labels={labels}
						compact={compact}
						{...selection}
					/>
				)}
			/>
		</div>
	);
}

function BandingResultPanels({
	results,
	labels,
	selectedTime,
	onTimeSelect,
	compact,
}: {
	results: Result[];
	labels?: Readonly<Record<string, string>>;
	selectedTime?: number;
	onTimeSelect: (seconds: number) => void;
	compact: boolean;
}) {
	const { t } = useT();
	const [selection, setSelection] = useState<{
		resultId: string;
		range: PublicBandingAssessment["ranges"][number];
		nonce: number;
		opener: HTMLButtonElement;
	} | null>(null);
	return (
		<div
			className={
				compact
					? "grid min-w-0 grid-cols-1 items-start gap-3 xl:grid-cols-2"
					: "space-y-6"
			}
		>
			{results.map((result, index) => {
				const pooled = result.pooled.banding;
				if (!pooled)
					return (
						<p key={result.id} className="text-sm text-zinc-400">
							{t("banding.unavailable")}
						</p>
					);
				const label =
					labels?.[result.id] ?? renditionLabel(result.renditionRef, index);
				const assessment = result.bandingAssessment;
				const configured =
					assessment?.warningThreshold !== undefined ||
					assessment?.failureThreshold !== undefined;
				const execution = result.bandingExecution;
				const frames = result.bandingFrames ?? [];
				const previewUrl =
					result.bandingPreview && "url" in result.bandingPreview
						? result.bandingPreview.url
						: undefined;
				return (
					<section
						key={result.id}
						aria-label={`${t("banding.title")} — ${label}`}
						className={`rounded-lg border border-zinc-800 bg-zinc-900/30 ${compact ? "min-w-0 p-3" : "p-4"}`}
					>
						<header
							className={`flex flex-wrap items-center ${compact ? "gap-2" : "gap-3"}`}
						>
							<h3 className="font-medium text-sm text-zinc-200">{label}</h3>
							<Badge
								tone={
									configured && assessment?.severity === "FAIL"
										? "error"
										: "neutral"
								}
							>
								{!assessment
									? t("banding.assessmentMissing")
									: configured
										? assessment.severity
										: t("banding.noThreshold")}
							</Badge>
						</header>
						<dl
							className={
								compact
									? "mt-2 grid grid-cols-2 gap-2 text-sm sm:grid-cols-3"
									: "mt-4 grid grid-cols-2 gap-4 text-sm sm:grid-cols-3 lg:grid-cols-5"
							}
						>
							{[
								[t("banding.mean"), fixed(pooled.mean)],
								[t("banding.max"), fixed(pooled.max)],
								[t("banding.min"), fixed(pooled.min)],
								[t("banding.frames"), pooled.frameCount.toLocaleString()],
								[
									t("banding.duration"),
									t("banding.seconds", {
										value: fixed(pooled.durationSeconds),
									}),
								],
							].map(([name, value]) => (
								<div key={name}>
									<dt className="text-xs text-zinc-500">{name}</dt>
									<dd className="mt-1 font-mono text-zinc-200">{value}</dd>
								</div>
							))}
						</dl>
						<p className={`${compact ? "mt-2" : "mt-4"} text-xs text-zinc-400`}>
							{execution
								? t(`banding.${execution.backend}`)
								: t("banding.unknownExecution")}
						</p>
						{execution ? (
							<p className="mt-1 text-xs text-zinc-400">
								{t("banding.decision")}
							</p>
						) : null}
						{execution?.backend === "cpu" && execution.selection?.reason ? (
							<p className="mt-1 text-xs text-zinc-500">
								{t(
									execution.selection.reason === "GPU_NOT_AVAILABLE"
										? "banding.autoNoGpu"
										: "banding.autoNoRuntime",
								)}
							</p>
						) : null}
						{configured && assessment ? (
							<p
								className={`${compact ? "mt-2" : "mt-3"} text-xs text-zinc-400`}
							>
								{t("banding.bounds")}:{" "}
								{assessment.warningThreshold !== undefined
									? `${t("banding.warn")} ≤ ${assessment.warningThreshold}`
									: ""}
								{assessment.warningThreshold !== undefined &&
								assessment.failureThreshold !== undefined
									? " · "
									: ""}
								{assessment.failureThreshold !== undefined
									? `${t("banding.fail")} ≤ ${assessment.failureThreshold}`
									: ""}
							</p>
						) : null}
						{frames.length ? (
							<>
								{compact ? (
									<div className="mt-3 flex items-center gap-2">
										<h4 className="text-sm text-zinc-300">
											{t("banding.plot")}
										</h4>
										<InfoHint
											labelFor={`${t("banding.plot")} — ${label}`}
											text={t("banding.plotHint")}
										/>
									</div>
								) : (
									<h4 className="mt-5 text-sm text-zinc-300">
										{t("banding.plot")}
									</h4>
								)}
								<div
									role="img"
									aria-label={`${t("banding.plot")} — ${label}`}
									className={`mt-2 ${compact ? "h-48" : "h-60"} w-full min-w-0`}
								>
									<ResponsiveContainer
										width="100%"
										height="100%"
										initialDimension={{
											width: 640,
											height: compact ? 192 : 240,
										}}
									>
										<ScatterChart
											margin={{ top: 10, right: 24, left: 8, bottom: 25 }}
										>
											<CartesianGrid
												stroke="currentColor"
												className="text-zinc-700"
												strokeDasharray="3 3"
											/>
											<XAxis
												type="number"
												dataKey="timestampSeconds"
												name={t("banding.time")}
												domain={["dataMin", "dataMax"]}
												tick={{ fill: "var(--color-zinc-400)" }}
												label={{
													value: t("banding.time"),
													position: "bottom",
													fill: "var(--color-zinc-400)",
												}}
											/>
											<YAxis
												type="number"
												dataKey="cambi"
												name="CAMBI"
												domain={[0, "auto"]}
												tick={{ fill: "var(--color-zinc-400)" }}
											/>
											<Tooltip
												contentStyle={{
													background: "var(--color-zinc-900)",
													borderColor: "var(--color-zinc-700)",
													color: "var(--color-zinc-200)",
												}}
											/>
											{assessment?.warningThreshold !== undefined ? (
												<ReferenceLine
													y={assessment.warningThreshold}
													stroke="#d97706"
													strokeDasharray="4 4"
												/>
											) : null}
											{assessment?.failureThreshold !== undefined ? (
												<ReferenceLine
													y={assessment.failureThreshold}
													stroke="#dc2626"
													strokeDasharray="4 4"
												/>
											) : null}
											{selectedTime !== undefined ? (
												<ReferenceLine
													x={selectedTime}
													stroke="var(--color-emerald-400)"
													strokeDasharray="3 3"
												/>
											) : null}
											<Scatter
												name="CAMBI"
												data={frames}
												onClick={(point) => {
													const seconds = point.payload?.timestampSeconds;
													if (typeof seconds === "number")
														onTimeSelect(seconds);
												}}
												fill="#3b82f6"
												isAnimationActive={false}
											/>
										</ScatterChart>
									</ResponsiveContainer>
								</div>
								{!compact ? (
									<p className="mt-1 text-xs text-zinc-500">
										{t("banding.plotHint")}
									</p>
								) : null}
							</>
						) : null}
						{configured && assessment ? (
							<div className={compact ? "mt-3" : "mt-5"}>
								<h4 className="text-sm text-zinc-300">{t("banding.ranges")}</h4>
								{selection?.resultId === result.id && previewUrl ? (
									<BandingIntervalPlayer
										key={`${selection.nonce}:${previewUrl}`}
										url={previewUrl}
										label={label}
										range={selection.range}
										onClose={() => {
											selection.opener.focus();
											setSelection(null);
										}}
									/>
								) : null}
								<p className="mt-1 text-xs text-zinc-400">
									{t("banding.affected", {
										value: fixed(assessment.affectedSeconds),
									})}
								</p>
								{assessment.ranges.length ? (
									<div className="mt-2 overflow-x-auto rounded border border-zinc-800">
										<table className="w-full text-left text-xs tabular-nums">
											<thead>
												<tr>
													{[
														t("banding.start"),
														t("banding.end"),
														t("banding.max"),
														t("banding.severity"),
														t("banding.previewColumn"),
													].map((column) => (
														<th
															key={column}
															scope="col"
															className="px-3 py-2 font-medium text-zinc-400"
														>
															{column}
														</th>
													))}
												</tr>
											</thead>
											<tbody>
												{assessment.ranges.map((range) => (
													<tr
														key={`${range.startFrame}-${range.endFrame}`}
														className="border-zinc-800 border-t text-zinc-200"
													>
														<td className="px-3 py-2">
															{fixed(range.startSeconds)}
														</td>
														<td className="px-3 py-2">
															{fixed(range.endSeconds)}
														</td>
														<td className="px-3 py-2">{fixed(range.peak)}</td>
														<td className="px-3 py-2">{range.severity}</td>
														<td className="px-3 py-2">
															<Button
																size="sm"
																variant="secondary"
																disabled={!previewUrl}
																onClick={(event) => {
																	const opener = event.currentTarget;
																	setSelection((previous) => ({
																		resultId: result.id,
																		range,
																		nonce: (previous?.nonce ?? 0) + 1,
																		opener,
																	}));
																}}
															>
																{t("banding.previewInterval", {
																	start: fixed(range.startSeconds),
																	end: fixed(range.endSeconds),
																})}
															</Button>
														</td>
													</tr>
												))}
											</tbody>
										</table>
									</div>
								) : (
									<p className="mt-2 text-sm text-zinc-400">
										{t("banding.noRanges")}
									</p>
								)}
								{assessment.ranges.length > 0 &&
								!previewUrl &&
								results.some(
									(item) => item.bandingPreview && "url" in item.bandingPreview,
								) ? (
									<p className="mt-2 text-xs text-zinc-400">
										{t("banding.previewUnavailable")}
									</p>
								) : null}
							</div>
						) : null}
					</section>
				);
			})}
		</div>
	);
}

export function BandingReport({
	job,
	actions,
	loadError,
}: {
	job: BandingJobDetail;
	actions: ReactNode;
	loadError: ReactNode;
}) {
	const { t } = useT();
	return (
		<section>
			{loadError}
			<p className="text-xs text-zinc-500 uppercase tracking-wide">
				{t("banding.report")}
			</p>
			<header className="mt-1 flex flex-wrap items-center gap-3">
				<h1 className="font-semibold text-xl text-zinc-50">
					{job.encodingName ?? shortJobId(job.id)}
				</h1>
				<Badge tone={VMAF_STATUS_TONE[job.status]}>{job.status}</Badge>
				<span className="font-mono text-xs text-zinc-400">
					CAMBI · no-reference
				</span>
				<div className="ml-auto">{actions}</div>
			</header>
			<p className="mt-2 text-xs text-zinc-500">
				{formatDateTime(job.createdAt)}
			</p>
			{job.encodingJobId ? (
				<Link
					href={`/vod/jobs/${job.encodingJobId}`}
					className="mt-2 inline-block text-xs text-emerald-400 underline"
				>
					{t("uiX.fromEncodingJob")} · {shortJobId(job.encodingJobId)}
				</Link>
			) : null}
			{job.error ? (
				<p role="alert" className="mt-4 text-sm text-red-400">
					{job.error}
				</p>
			) : null}
			{job.status === "PENDING" || job.status === "RUNNING" ? (
				<p role="status" className="mt-6 text-sm text-zinc-400">
					{t("banding.running", { done: job.doneUnits, total: job.totalUnits })}
				</p>
			) : null}
			{job.results.length ? (
				<>
					<div className="mt-6 flex justify-end">
						<ExportButtons jobId={job.id} />
					</div>
					<BandingPanels results={job.results} />
				</>
			) : null}
			<Link
				href="/qc"
				className="mt-6 inline-block text-sm text-emerald-400 underline"
			>
				{t("qc.backToLab")}
			</Link>
		</section>
	);
}
