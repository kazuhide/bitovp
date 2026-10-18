import { InfoHint } from "@/components/ui/info-hint";
import { useT } from "@/lib/i18n/context";
import {
	type LiveReportMetadata,
	renditionLabel,
	type VmafResultDetail,
} from "../vmaf-shared";

/**
 * LIVE-only report panels (P4-PR6b). For each pseudo-live result (`result.live`
 * present), surfaces the PR6a alignment summary that VOD reports don't have:
 *   - CONFIDENCE — the 0–1 alignment confidence + the ±1-frame caveat, with a
 *     low-confidence warning band when below the processor threshold.
 *   - LOOP-OFFSET MAP — the per-loop wrap entries (≥3 for a ≥3-loop capture):
 *     where each source-loop boundary falls in the captured window.
 *   - DRIFT — a warning with maxDriftFrames when slow drift was detected.
 * VOD results render nothing here (the parent only mounts this for LIVE jobs).
 */

function fmtConfidence(c: number): string {
	return Number.isFinite(c) ? c.toFixed(3) : "—";
}

function confidenceTone(lowConfidence: boolean): string {
	return lowConfidence ? "text-amber-400" : "text-emerald-400";
}

function LiveWarnings({ live }: { live: LiveReportMetadata }) {
	const { t } = useT();
	return (
		<>
			{live.lowConfidence || live.pooledWithoutAlignment || live.warning ? (
				<div
					role="alert"
					className="mt-3 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-amber-300 text-xs"
				>
					{live.lowConfidence || live.pooledWithoutAlignment ? (
						<p>{t("qc.alignmentUnverified")}</p>
					) : null}
					{live.warning ? <p>{live.warning}</p> : null}
				</div>
			) : null}
			{live.drift.detected ? (
				<p
					role="alert"
					className="mt-3 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-amber-300 text-xs"
				>
					{t(
						live.drift.maxDriftFrames === 1
							? "uiX.driftDetectedFullOne"
							: "uiX.driftDetectedFullOther",
						{
							count: live.drift.maxDriftFrames,
							offsets: live.drift.perSegmentOffsets.join(", "),
						},
					)}
				</p>
			) : null}
		</>
	);
}

/** Quality caveats stay visible beside scores even when diagnostics are closed. */
export function LiveQualityWarnings({
	results,
}: {
	results: VmafResultDetail[];
}) {
	const { t } = useT();
	return (
		<>
			{results.map((result, index) => {
				const live = result.live;
				if (
					!live ||
					!(
						live.lowConfidence ||
						live.pooledWithoutAlignment ||
						live.warning ||
						live.drift.detected
					)
				)
					return null;
				return (
					<div key={result.id} className="mt-3">
						<p className="text-xs text-zinc-400">
							{renditionLabel(
								result.renditionRef,
								index,
								t("common.renditionNumbered", { n: index + 1 }),
							)}
						</p>
						<LiveWarnings live={live} />
					</div>
				);
			})}
		</>
	);
}

function LiveResultPanel({
	result,
	index,
	showWarnings,
}: {
	result: VmafResultDetail;
	index: number;
	showWarnings: boolean;
}) {
	const { t } = useT();
	const live = result.live;
	if (!live) {
		return null;
	}
	const label = renditionLabel(
		result.renditionRef,
		index,
		t("common.renditionNumbered", { n: index + 1 }),
	);

	return (
		<div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
			<div className="flex flex-wrap items-center gap-3">
				<h3 className="font-medium text-sm text-zinc-200">{label}</h3>
				<span className="text-xs text-zinc-500">
					{t("uiX.capturedFramesLine", {
						captured: live.distortedFrames.toLocaleString(),
						source: live.sourceFrames.toLocaleString(),
						fps: live.fps,
					})}
					fps
				</span>
			</div>

			{/* Confidence + offset */}
			<div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
				<div>
					<div className="flex items-center gap-1 text-[11px] text-zinc-500">
						{t("qc.confidence")}
						<InfoHint
							text={t("qc.hintAlignmentConfidence")}
							label={t("qc.confidenceCaveat")}
						/>
					</div>
					<div
						className={`mt-0.5 font-semibold text-lg tabular-nums ${confidenceTone(
							live.lowConfidence,
						)}`}
					>
						{fmtConfidence(live.confidence)}
					</div>
				</div>
				<div>
					<div className="flex items-center gap-1 text-[11px] text-zinc-500">
						{t("qc.offsetFrames")}
						<InfoHint
							text={t("qc.hintFrameOffset")}
							label={t("qc.frameOffset")}
						/>
					</div>
					<div className="mt-0.5 font-semibold text-lg text-zinc-200 tabular-nums">
						{live.offset}
					</div>
				</div>
				<div>
					<div className="text-[11px] text-zinc-500">
						{t("qc.coarseAnchor")}
					</div>
					<div className="mt-0.5 font-semibold text-lg text-zinc-400 tabular-nums">
						{live.coarseOffset === null
							? t("qc.coarseFullSearch")
							: live.coarseOffset}
					</div>
				</div>
			</div>

			{showWarnings ? <LiveWarnings live={live} /> : null}
			{live.excluded ? (
				<p className="mt-2 text-xs text-zinc-400">
					{t("qc.alignmentExcludedFrames")}:{" "}
					{live.excluded.frames.toLocaleString()}
				</p>
			) : null}
			{live.masked ? (
				<p className="mt-2 text-xs text-zinc-400">
					{t("qc.alignmentMaskedFrames")}: {live.masked.frames.toLocaleString()}
				</p>
			) : null}

			{/* Drift */}
			{!live.drift.detected ? (
				<p className="mt-3 text-xs text-zinc-500">
					{t("uiX.noDriftHead")}{" "}
					{live.drift.perSegmentOffsets.join(", ") || "—"}
					{t("uiX.driftSpreadTail")}
				</p>
			) : null}

			{/* Loop-offset map */}
			<div className="mt-3">
				<div className="flex items-center gap-1 text-xs text-zinc-300">
					{t("qc.loopOffsetMap")}
					<InfoHint text={t("qc.hintLoopMap")} label={t("qc.loopOffsetMap")} />
					<span className="text-[11px] text-zinc-500">
						{t(
							live.loopMap.length === 1
								? "uiX.loopsInWindowOne"
								: "uiX.loopsInWindowOther",
							{ count: live.loopMap.length },
						)}
					</span>
				</div>
				<div className="mt-1.5 overflow-x-auto rounded-md border border-zinc-800">
					<table className="w-full text-xs">
						<thead>
							<tr className="border-zinc-800 border-b text-left text-[11px] text-zinc-500">
								<th className="px-3 py-1.5 font-medium">{t("qc.loop")}</th>
								<th className="px-3 py-1.5 font-medium text-right">
									{t("qc.outputFrameStart")}
								</th>
								<th className="px-3 py-1.5 font-medium text-right">
									{t("qc.sourceFrameStart")}
								</th>
							</tr>
						</thead>
						<tbody className="divide-y divide-zinc-800/70">
							{live.loopMap.map((entry) => (
								<tr key={entry.loopIndex} className="text-zinc-300">
									<td className="px-3 py-1.5 tabular-nums">
										{entry.loopIndex}
									</td>
									<td className="px-3 py-1.5 text-right tabular-nums">
										{entry.outputFrameStart.toLocaleString()}
									</td>
									<td className="px-3 py-1.5 text-right tabular-nums">
										{entry.sourceFrameStart.toLocaleString()}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			</div>
		</div>
	);
}

/** All LIVE panels for a job — one block per result that carries live metadata. */
export function LivePanels({
	results,
	showWarnings = true,
}: {
	results: VmafResultDetail[];
	showWarnings?: boolean;
}) {
	const liveResults = results.filter((r) => r.live);
	if (liveResults.length === 0) {
		return null;
	}
	return (
		<div className="mt-4 space-y-4">
			{liveResults.map((result) => (
				<LiveResultPanel
					key={result.id}
					result={result}
					index={results.indexOf(result)}
					showWarnings={showWarnings}
				/>
			))}
		</div>
	);
}
