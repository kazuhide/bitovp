"use client";

import type { StepLogEntry } from "@bitovp/core";
import { CopyableId } from "@/components/copyable-id";
import { Badge } from "@/components/ui/badge";
import { DetailPopover } from "@/components/ui/detail-popover";
import { HelpOverlay } from "@/components/ui/help-overlay";
import { formatDateTime } from "@/lib/format";
import { useT } from "@/lib/i18n/context";

const STEP_TONE: Record<StepLogEntry["status"], "neutral" | "ok" | "error"> = {
	PENDING: "neutral",
	RUNNING: "ok",
	DONE: "ok",
	FAILED: "error",
};

/**
 * Persisted step-log timeline (orchestrator + live-channel workers share
 * the contract): status badge, step key, op kind, resource id and the
 * redacted request/response snapshot expander. Used by the VOD job detail
 * and the live channel detail.
 */
export function StepTimeline({ entries }: { entries: StepLogEntry[] }) {
	const { t } = useT();
	return (
		<ol className="mt-2 space-y-1">
			{entries.map((entry) => (
				<li
					key={entry.step}
					className="rounded-md border border-zinc-800/70 px-3 py-1.5"
				>
					{/* flex-wrap (UI loop 2026-08-21): badge + step key + kind +
					    36-char UUID are all unshrinkable tokens — without wrap the
					    row's min-content (~556px measured) overflows the detail
					    column on every viewport below ~1272px. resources-tab has
					    carried the wrap from the start; this row just missed it. */}
					<div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
						{/* Direct insertion DONE records API acceptance, not media outcome. */}
						{entry.kind === "SLATE_INSERTED" &&
						entry.status === "DONE" &&
						entry.payload.viaDirectRoute === true ? (
							<>
								<Badge tone="neutral">{t("uiX.insertionAccepted")}</Badge>
								<span className="text-xs text-zinc-400">
									{t("uiX.insertionUnverified")}
								</span>
								<HelpOverlay labelFor={t("uiX.insertionAccepted")}>
									{t("uiX.insertionAcceptedHelp")}
								</HelpOverlay>
								<details className="w-full text-[11px] text-zinc-500">
									<summary className="cursor-pointer">
										{t("uiX.insertionProtocol")}
									</summary>
									<div className="flex flex-wrap gap-x-3 font-mono">
										<span>{entry.status}</span>
										<span>{entry.kind}</span>
										<span>{entry.step}</span>
									</div>
								</details>
							</>
						) : (
							<>
								<Badge tone={STEP_TONE[entry.status]}>{entry.status}</Badge>
								<span className="font-mono text-xs text-zinc-300">
									{entry.step}
								</span>
								<span className="text-[11px] text-zinc-600">{entry.kind}</span>
							</>
						)}
						{entry.resourceId ? (
							<span className="ml-auto font-mono text-[11px] text-zinc-500">
								{entry.resourceId}
							</span>
						) : null}
					</div>
					{entry.error ? (
						<p className="mt-1 text-red-400 text-xs">{entry.error}</p>
					) : null}
					{(() => {
						// Multi-encoding failure semantics: a failed AWAIT records
						// the sibling encodings it stopped (VOD-only in practice —
						// one live channel = one encoding).
						const stopped = (
							entry.response as { stoppedSiblings?: unknown[] } | undefined
						)?.stoppedSiblings;
						// A BILLING statement — the ids belong in the sentence, not
						// three clicks away in raw JSON (ux inventory #4): each listed
						// encoding was still costing money when this step failed.
						return Array.isArray(stopped) && stopped.length > 0 ? (
							<p className="mt-1 text-amber-400 text-xs">
								<DetailPopover
									summary={t(
										stopped.length === 1
											? "uiX.stoppedSiblingsOne"
											: "uiX.stoppedSiblingsOther",
										{ count: stopped.length },
									)}
									label={t("uiX.stoppedSiblingsLabel")}
								>
									<ul className="space-y-1">
										{stopped.map((id) => (
											<li key={String(id)}>
												<CopyableId value={String(id)} />
											</li>
										))}
									</ul>
								</DetailPopover>
							</p>
						) : null;
					})()}
					{entry.request !== undefined || entry.response !== undefined ? (
						<details className="mt-1">
							<summary className="cursor-pointer text-[11px] text-zinc-500">
								{t("uiX.requestResponseAt", {
									when: formatDateTime(entry.finishedAt),
								})}
							</summary>
							<pre className="mt-1 overflow-auto rounded bg-zinc-900 p-2 text-[11px] text-zinc-400">
								{JSON.stringify(
									{ request: entry.request, response: entry.response },
									null,
									2,
								)}
							</pre>
						</details>
					) : null}
				</li>
			))}
		</ol>
	);
}
