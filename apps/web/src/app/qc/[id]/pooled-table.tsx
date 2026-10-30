import { useState } from "react";
import { InfoHint } from "@/components/ui/info-hint";
import { useT } from "@/lib/i18n/context";
import { VmafScoreLegend } from "../vmaf-score-legend";
import {
	anyHasPsnr,
	fmtPsnr,
	fmtScore,
	renditionColor,
	renditionLabel,
	sortedRenditions,
	type VmafResultDetail,
} from "../vmaf-shared";
import { LocalExecutionSummary } from "./local-execution-summary";

/** A column header with an optional InfoHint. */
function Th({
	children,
	hint,
	hintLabel,
}: {
	children: React.ReactNode;
	hint?: string;
	hintLabel?: string;
}) {
	return (
		<th className="px-3 py-2 text-right font-medium first:text-left">
			<span className="inline-flex items-center gap-1">
				{children}
				{hint ? <InfoHint text={hint} label={hintLabel} /> : null}
			</span>
		</th>
	);
}

/** Scores are numeric predictions, not a universal quality verdict. */
function ScoreTd({ value }: { value: number }) {
	return (
		<td
			data-score={fmtScore(value)}
			className="px-3 py-2 text-right text-zinc-300 tabular-nums"
		>
			{fmtScore(value)}
		</td>
	);
}

/**
 * A right-aligned PSNR (dB) cell. PSNR is a different scale/semantics than
 * VMAF, so it is NOT tinted by the VMAF thresholds — neutral zinc, with an
 * em-dash when a rendition has no PSNR (mixed PSNR/non-PSNR results in one job).
 */
function DbTd({ value }: { value: number | undefined }) {
	return (
		<td className="px-3 py-2 text-right text-zinc-300 tabular-nums">
			{fmtPsnr(value)}
		</td>
	);
}

/**
 * Pooled VMAF summary: one row per rendition with the headline aggregates
 * (mean, harmonic mean, 1% low, p1/p5/p10/p25/p50, min/max, worst frame).
 * Column headers carry InfoHint tooltips explaining the trickier aggregates;
 * scores have no arbitrary pass/fail bands. The leading swatch
 * matches each rendition's colour in the charts below.
 *
 * When the run computed PSNR (P4-PR5), three extra dB columns (PSNR mean/min/
 * max) appear after the VMAF aggregates. They render only if at least one
 * result carries PSNR; a result without it shows em-dashes in those cells.
 */
export function PooledTable({ results }: { results: VmafResultDetail[] }) {
	const { t } = useT();
	const [direction, setDirection] = useState<"asc" | "desc">("asc");
	const showPsnr = anyHasPsnr(results);
	return (
		<div className="mt-2 rounded-lg border border-zinc-800">
			<VmafScoreLegend className="border-zinc-800 border-b px-3 py-2" />
			<div className="overflow-x-auto">
				<table className="w-full text-xs">
					<thead>
						<tr className="border-zinc-800 border-b text-zinc-500">
							<th
								className="px-3 py-2 text-left font-medium"
								aria-sort={direction === "asc" ? "ascending" : "descending"}
							>
								<button
									type="button"
									className="whitespace-nowrap rounded hover:text-zinc-200 focus-visible:outline-2 focus-visible:outline-emerald-400"
									title={t(
										direction === "asc"
											? "qc.sortBitrateDescending"
											: "qc.sortBitrateAscending",
									)}
									onClick={() =>
										setDirection(direction === "asc" ? "desc" : "asc")
									}
								>
									{t("qc.rendition")} · {t("inspect.bitrate")}{" "}
									{direction === "asc" ? "↑" : "↓"}
								</button>
							</th>
							<Th hint={t("qc.hintMean")} hintLabel={t("qc.meanHint")}>
								{t("qc.mean")}
							</Th>
							<Th
								hint={t("qc.hintHarmonicMean")}
								hintLabel={t("qc.harmonicHint")}
							>
								{t("qc.harmonic")}
							</Th>
							<Th
								hint={t("qc.hintLow1Percent")}
								hintLabel={t("ui.k1LowMoreInformation")}
							>
								{t("ui.k1Low")}
							</Th>
							<Th
								hint={t("qc.hintPercentiles")}
								hintLabel={t("ui.p1MoreInformation")}
							>
								p1
							</Th>
							<Th>p5</Th>
							<Th>p10</Th>
							<Th>p25</Th>
							<Th>p50</Th>
							<Th
								hint={t("qc.hintMinMax")}
								hintLabel={t("ui.minMoreInformation")}
							>
								{t("ui.min")}
							</Th>
							<Th>{t("qc.max")}</Th>
							<Th
								hint={t("qc.hintWorstFrame")}
								hintLabel={t("qc.worstFrameHint")}
							>
								{t("qc.worstFrame")}
							</Th>
							{showPsnr ? (
								<>
									<Th
										hint={t("qc.hintPsnr")}
										hintLabel={t("ui.psnrMeanMoreInformation")}
									>
										{t("ui.psnrDb")}
									</Th>
									<Th>{t("qc.psnrMin")}</Th>
									<Th>{t("qc.psnrMax")}</Th>
								</>
							) : null}
						</tr>
					</thead>
					<tbody className="divide-y divide-zinc-800/70">
						{sortedRenditions(results, direction).map(
							({ result: r, index: i }) => {
								const p = r.pooled;
								return (
									<tr key={r.id} className="hover:bg-zinc-900/40">
										<td className="px-3 py-2 text-left">
											<span className="inline-flex items-center gap-2">
												<span
													aria-hidden="true"
													className="inline-block h-2.5 w-2.5 rounded-sm"
													style={{ backgroundColor: renditionColor(i) }}
												/>
												<span className="text-zinc-200">
													{renditionLabel(
														r.renditionRef,
														i,
														t("common.renditionNumbered", { n: i + 1 }),
													)}
												</span>
											</span>
											<LocalExecutionSummary execution={r.localExecution} />
										</td>
										<ScoreTd value={p.mean} />
										<ScoreTd value={p.harmonicMean} />
										<ScoreTd value={p.low1Percent} />
										<ScoreTd value={p.percentiles.p1} />
										<ScoreTd value={p.percentiles.p5} />
										<ScoreTd value={p.percentiles.p10} />
										<ScoreTd value={p.percentiles.p25} />
										<ScoreTd value={p.percentiles.p50} />
										<ScoreTd value={p.min} />
										<ScoreTd value={p.max} />
										<td
											data-score={fmtScore(p.worstFrame.vmaf)}
											className="px-3 py-2 text-right text-zinc-400 tabular-nums"
										>
											#{p.worstFrame.frameNum}{" "}
											<span className="text-zinc-300">
												({fmtScore(p.worstFrame.vmaf)})
											</span>
										</td>
										{showPsnr ? (
											<>
												<DbTd value={p.psnr?.mean} />
												<DbTd value={p.psnr?.min} />
												<DbTd value={p.psnr?.max} />
											</>
										) : null}
									</tr>
								);
							},
						)}
					</tbody>
				</table>
			</div>
		</div>
	);
}
