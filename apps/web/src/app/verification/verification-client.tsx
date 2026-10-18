"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { HelpOverlay } from "@/components/ui/help-overlay";
import { apiFetch } from "@/lib/api";
import { useT } from "@/lib/i18n/context";
import { statusTone, type VerificationRunSummary } from "./types";

/**
 * The verification-run list (re-audit 2026-08-29, HIGH-7 / GO 11).
 *
 * Presentational and container are split so the table can be rendered from a
 * fixture row in a test without a fetch — the same reason the report exists at
 * all: evidence you cannot re-read is evidence you have to take on trust.
 */
export function RunTable({ items }: { items: VerificationRunSummary[] }) {
	const { t } = useT();
	if (items.length === 0) {
		return <p className="text-sm text-zinc-500">{t("verification.noRuns")}</p>;
	}
	return (
		<div className="overflow-x-auto rounded-lg border border-zinc-800">
			<table className="w-full text-left text-sm">
				<thead className="bg-zinc-900/60 text-[11px] text-zinc-400 uppercase">
					<tr>
						<th className="px-3 py-2 font-medium">
							{t("verification.colRun")}
						</th>
						<th className="px-3 py-2 font-medium">
							{t("verification.colKind")}
						</th>
						<th className="px-3 py-2 font-medium">
							{t("verification.colStatus")}
						</th>
						<th className="px-3 py-2 font-medium">
							{t("verification.colStarted")}
						</th>
						<th className="px-3 py-2 font-medium">
							{t("verification.colCommit")}
						</th>
						<th className="px-3 py-2 font-medium">
							{t("verification.colCounts")}
						</th>
					</tr>
				</thead>
				<tbody>
					{items.map((run) => (
						<tr key={run.id} className="border-zinc-800 border-t">
							<td className="px-3 py-2">
								<Link
									href={`/verification/${run.id}`}
									className="font-mono text-[11px] text-emerald-300 underline decoration-dotted underline-offset-2"
								>
									{run.runId}
								</Link>
							</td>
							<td className="px-3 py-2 text-zinc-400">{run.kind ?? "—"}</td>
							<td className="px-3 py-2">
								<span className="flex flex-wrap items-center gap-1">
									<Badge tone={statusTone(run.status)}>{run.status}</Badge>
									{run.sealed ? null : (
										<Badge tone="error">{t("verification.notSealed")}</Badge>
									)}
									{run.drift ? (
										<Badge tone="error">{t("verification.drift")}</Badge>
									) : null}
								</span>
							</td>
							<td className="px-3 py-2 text-xs text-zinc-400">
								{run.startedAt}
							</td>
							<td className="px-3 py-2 font-mono text-[11px] text-zinc-400">
								{run.commit.slice(0, 12)}
							</td>
							<td className="px-3 py-2">
								<CountChips counts={run.counts} />
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

function CountChips({ counts }: { counts: Record<string, number> | null }) {
	const entries = Object.entries(counts ?? {}).filter(([, n]) => n > 0);
	if (entries.length === 0) {
		return <span className="text-xs text-zinc-600">—</span>;
	}
	return (
		<span className="flex flex-wrap gap-1">
			{entries.map(([verdict, n]) => (
				<Badge
					key={verdict}
					tone={
						verdict === "FAIL" || verdict === "INVALID"
							? "error"
							: verdict === "PASS"
								? "ok"
								: "neutral"
					}
				>
					{verdict} {n}
				</Badge>
			))}
		</span>
	);
}

type RunsPayload = { items: VerificationRunSummary[] };

/**
 * How the list decides whether to keep polling (audit 602ec286 BLOCKER-1 / row
 * #265). Poll while ANY run is still RUNNING so a long run reaches SEALED or
 * INCOMPLETE on this screen without a manual reload; stop once every row is
 * terminal, so a finished corpus is not polled forever. A pure function of the
 * data on purpose: the wall-clock interval is TanStack's to fire, but the
 * decision to fire it is deterministic and testable without a timer.
 */
export const VERIFICATION_LIST_POLL_MS = 5_000;
export function verificationListRefetchInterval(
	data: RunsPayload | undefined,
): number | false {
	const anyRunning = (data?.items ?? []).some(
		(run) => run.status === "RUNNING",
	);
	return anyRunning ? VERIFICATION_LIST_POLL_MS : false;
}

/* After background refresh failure, keep the last successful data with a stale marker and explicit error. dataUpdatedAt is the last successful load time, not the failed attempt. */
export function RefreshStaleNotice({
	dataUpdatedAt,
}: {
	dataUpdatedAt: number;
}) {
	const { t } = useT();
	const when =
		dataUpdatedAt > 0 ? new Date(dataUpdatedAt).toISOString() : undefined;
	return (
		<p
			role="status"
			className="flex flex-wrap items-center gap-x-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-amber-300 text-xs"
		>
			<span className="font-medium">{t("verification.refreshFailed")}</span>
			{when ? (
				<span className="text-zinc-400">
					{t("verification.lastUpdated")}: <time dateTime={when}>{when}</time>
				</span>
			) : null}
		</p>
	);
}

export function VerificationRunsClient() {
	const { t } = useT();
	const runs = useQuery({
		queryKey: ["verification-runs"],
		queryFn: () => apiFetch<RunsPayload>("/api/verification-runs"),
		refetchInterval: (query) =>
			verificationListRefetchInterval(query.state.data),
	});
	return (
		<section aria-label={t("verification.heading")} className="space-y-4">
			<div className="space-y-1">
				<div className="flex items-center gap-2">
					<h1 className="font-medium text-lg text-zinc-100">
						{t("verification.heading")}
					</h1>
					<HelpOverlay labelFor={t("verification.heading")}>
						{t("verification.caption")}
					</HelpOverlay>
				</div>
			</div>
			{runs.isPending ? (
				<p className="text-xs text-zinc-500">{t("verification.loading")}</p>
			) : runs.data === undefined ? (
				// The FIRST load failed — there is nothing to show but the error.
				<p className="text-sm text-red-300">{t("verification.loadFailed")}</p>
			) : (
				<>
					{/* A poll failed but the rows are still the last good ones:
					    show them, never as if they were current. */}
					{runs.isError ? (
						<RefreshStaleNotice dataUpdatedAt={runs.dataUpdatedAt} />
					) : null}
					<RunTable items={runs.data.items} />
				</>
			)}
		</section>
	);
}
