"use client";

import { Badge } from "@/components/ui/badge";
import { formatDateTime } from "@/lib/format";
import { useT } from "@/lib/i18n/context";

/**
 * Origin observation panel  — what bitovp ITSELF read
 * from the origin's media playlists, rendered as the second opinion beside
 * Bitmovin's heartbeat. Unavailability renders with its reason, never as
 * silence — an unobserved channel must say so ("we were quite blind" is
 * the incident this feature answers).
 */

type Observation = {
	lastFetchAtMs?: number;
	unavailableReason?: string;
	lastVerdicts?: Record<
		string,
		{ stale: boolean; endlist: boolean; edgeDelaySeconds: number | null }
	>;
};

export function OriginPanel({ observation }: { observation: unknown }) {
	const { t } = useT();
	const state = (observation ?? null) as Observation | null;
	if (!state || (!state.lastFetchAtMs && !state.unavailableReason)) {
		return <p className="text-xs text-zinc-500">{t("origin.noneYet")}</p>;
	}
	const verdicts = Object.entries(state.lastVerdicts ?? {});
	return (
		<div className="space-y-2">
			<p className="text-xs text-zinc-500">
				{t("origin.explainer")}
				{state.lastFetchAtMs ? (
					<span className="ml-2 font-mono">
						{t("origin.lastFetch", {
							at: formatDateTime(new Date(state.lastFetchAtMs).toISOString()),
						})}
					</span>
				) : null}
			</p>
			{state.unavailableReason ? (
				<p className="text-amber-400 text-xs">{t("origin.unavailable")}</p>
			) : null}
			{verdicts.length > 0 ? (
				<ul className="space-y-1">
					{verdicts.map(([key, verdict]) => (
						<li
							key={key}
							className="flex flex-wrap items-center gap-2 rounded-md border border-zinc-800 px-3 py-1.5 text-xs"
						>
							<span className="break-all font-mono text-zinc-400">
								{key.split("/").at(-1)}
							</span>
							<Badge tone={verdict.stale ? "error" : "ok"}>
								{verdict.stale ? t("origin.stale") : t("origin.advancing")}
							</Badge>
							{verdict.endlist ? <Badge tone="error">ENDLIST</Badge> : null}
							{verdict.edgeDelaySeconds !== null ? (
								<span className="text-zinc-500">
									{t("origin.edgeDelay", { s: verdict.edgeDelaySeconds })}
								</span>
							) : null}
						</li>
					))}
				</ul>
			) : null}
		</div>
	);
}
