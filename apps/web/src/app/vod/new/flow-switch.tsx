"use client";

import Link from "next/link";
import { useT } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";
import { VOD_FLOWS, type VodFlow, vodFlowHref } from "@/lib/vod-flow";
import { persistVodFlow } from "@/lib/vod-flow-preference";

/**
 * Chooses what the new job is for, at the top of the wizard.
 *
 * Links, not buttons: each flow is its own URL, so a guide or a bookmark can open one
 * directly, and the choice is remembered for the next plain `/vod/new`.
 */
export function VodFlowSwitch({ flow }: { flow: VodFlow }) {
	const { t } = useT();
	return (
		<nav
			aria-label={t("vodFlow.label")}
			className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2"
		>
			<span className="text-xs text-zinc-400">{t("vodFlow.label")}</span>
			<div className="inline-flex gap-0.5 rounded-md border border-zinc-700 p-0.5">
				{VOD_FLOWS.map((candidate) => (
					<Link
						key={candidate}
						href={vodFlowHref(candidate)}
						aria-current={candidate === flow ? "page" : undefined}
						onClick={() => {
							try {
								persistVodFlow(candidate);
							} catch {
								/* The link still opens the flow where cookies are unavailable. */
							}
						}}
						className={cn(
							"inline-flex h-7 items-center whitespace-nowrap rounded px-3 font-medium text-xs transition-colors focus-visible:outline-2 focus-visible:outline-emerald-500 focus-visible:outline-offset-2",
							candidate === flow
								? "bg-zinc-800 text-zinc-50"
								: "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200",
						)}
					>
						{t(`vodFlow.${candidate}`)}
					</Link>
				))}
			</div>
			<p className="text-xs text-zinc-500">{t(`vodFlow.${flow}Hint`)}</p>
		</nav>
	);
}
