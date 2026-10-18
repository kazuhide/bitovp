"use client";

import { useEffect, useState } from "react";
import { formatDateTime } from "@/lib/format";
import { useT } from "@/lib/i18n/context";
import type { VmafComputeTaskSummary } from "./vmaf-shared";

/** Percent describes scoring frames only, never download/alignment or the whole job. */
export function CloudProgress({
	tasks,
	active = true,
}: {
	tasks: VmafComputeTaskSummary[];
	active?: boolean;
}) {
	const { t } = useT();
	const current = tasks.filter((task) => task.current && !task.cleanedAt);
	const [now, setNow] = useState(Date.now);
	const clockActive = active && current.some((task) => !!task.progress);
	useEffect(() => {
		if (!clockActive) return;
		setNow(Date.now());
		const timer = setInterval(() => setNow(Date.now()), 15_000);
		return () => clearInterval(timer);
	}, [clockActive]);
	if (!active || !current.length) return null;
	return (
		<ul
			className="mt-2 space-y-1 text-xs text-zinc-400"
			aria-label={t("qc.computeTasks")}
		>
			{current.map((task) => {
				const p = task.progress;
				const stale = p && now - Date.parse(p.updatedAt) > 120_000;
				const percent =
					p?.phase === "SCORING" &&
					p.totalFrames &&
					p.framesProcessed !== undefined
						? Math.min(100, (100 * p.framesProcessed) / p.totalFrames).toFixed(
								1,
							)
						: null;
				return (
					<li key={task.id} className="flex flex-wrap gap-x-2 gap-y-0.5">
						<span className="font-mono">{task.id.slice(0, 8)}</span>
						<span>{p ? t(`qc.computePhase${p.phase}`) : task.state}</span>
						{percent !== null && p ? (
							<span>
								{t("qc.computeScoringFrames", {
									done: p.framesProcessed ?? 0,
									total: p.totalFrames ?? 0,
									percent,
								})}
							</span>
						) : null}
						{task.provisioningModel && (
							<span>
								{task.provisioningModel === "SPOT"
									? "Spot"
									: t("qc.computeStandard")}
							</span>
						)}
						{task.attempt && (
							<span>{t("qc.computeAttempt", { attempt: task.attempt })}</span>
						)}
						{p && (
							<span title={formatDateTime(p.updatedAt)}>
								{t("qc.computeUpdated", { time: formatDateTime(p.updatedAt) })}
								{stale ? ` · ${t("qc.computeStale")}` : ""}
							</span>
						)}
					</li>
				);
			})}
		</ul>
	);
}
