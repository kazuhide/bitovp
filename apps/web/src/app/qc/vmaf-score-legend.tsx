"use client";

import { InfoHint } from "@/components/ui/info-hint";
import { useT } from "@/lib/i18n/context";

/** Subjective-scale anchors are not universal pass/fail or interval boundaries. */
export function VmafScoreLegend({ className = "" }: { className?: string }) {
	const { t } = useT();
	return (
		<div className={`space-y-0.5 text-[11px] text-zinc-400 ${className}`}>
			<p className="flex items-center gap-1.5">
				{t("qc.scoreLegend")}
				<InfoHint text={t("qc.scoreLegendDisclaimer")} labelFor="VMAF" />
			</p>
			<p>
				<a
					className="underline hover:text-zinc-200"
					href="https://github.com/Netflix/vmaf/blob/master/resource/doc/models_v0.md"
					target="_blank"
					rel="noreferrer"
				>
					Netflix / VMAF
				</a>
				{" · "}
				<a
					className="underline hover:text-zinc-200"
					href="https://github.com/Netflix/vmaf/blob/master/resource/doc/models_v1.md"
					target="_blank"
					rel="noreferrer"
				>
					VMAF v1
				</a>
			</p>
		</div>
	);
}
