"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import type { ReactNode } from "react";
import { CopyableId } from "@/components/copyable-id";
import { Badge } from "@/components/ui/badge";
import { apiFetch } from "@/lib/api";
import { useT } from "@/lib/i18n/context";
import { statusTone, type VerificationRunDetail, verdictTone } from "../types";
import { RefreshStaleNotice } from "../verification-client";

/**
 * One verification run, whole (re-audit 2026-08-29, HIGH-7 / GO 11).
 *
 * The audit's finding was not that these facts were missing — the harness had
 * every one of them — but that they could only be read in the terminal that
 * produced them. So this screen shows the JOIN: what code and schema ran, which
 * bytes it read, what each scenario decided and on which encoding, what the
 * PROVIDER said about the encodings we abandoned, and the seal that says the
 * report on disk is this run's.
 *
 * Presentational, so a test can render it from a fixture row: a detail view
 * that can only be seen by running a paid encode is the shape this whole
 * feature exists to stop repeating.
 */
export function RunDetail({ run }: { run: VerificationRunDetail }) {
	const { t } = useT();
	const outcomes = run.outcomes ?? [];
	const cleanups = run.cleanup ?? [];
	const provider = Object.entries(run.providerReadback ?? {});
	const evidence = run.liveEvidence ?? [];
	return (
		<div className="space-y-6">
			<div className="space-y-2">
				<Link
					href="/verification"
					className="text-xs text-zinc-500 underline decoration-dotted underline-offset-2"
				>
					{t("verification.backToList")}
				</Link>
				<div className="flex flex-wrap items-center gap-2">
					<h1 className="font-medium font-mono text-lg text-zinc-100">
						{run.runId}
					</h1>
					<Badge tone={statusTone(run.status)}>{run.status}</Badge>
					{run.kind ? <Badge>{run.kind}</Badge> : null}
					{run.drift ? (
						<Badge tone="error">{t("verification.drift")}</Badge>
					) : null}
				</div>
			</div>

			<Section title={t("verification.fingerprint")}>
				<Facts>
					<Fact label={t("verification.commit")}>
						<CopyableId value={run.commit} label={t("verification.commit")} />
					</Fact>
					<Fact label={t("verification.checkoutMigration")}>
						{run.checkoutLatestMigration}
					</Fact>
					<Fact label={t("verification.dbMigration")}>
						{run.dbLatestMigration}
					</Fact>
					<Fact label={t("verification.driftLabel")}>
						{run.drift ? t("verification.driftYes") : t("verification.driftNo")}
					</Fact>
					<Fact label={t("verification.startedAt")}>{run.startedAt}</Fact>
					<Fact label={t("verification.finishedAt")}>
						{run.finishedAt ?? "—"}
					</Fact>
					<Fact label={t("verification.baseUrlOrigin")}>
						{run.baseUrlOrigin ?? "—"}
					</Fact>
					<Fact label={t("verification.actor")}>{run.actor ?? "—"}</Fact>
					<Fact label={t("verification.account")}>
						{run.bitmovinAccountId ? (
							<CopyableId
								value={run.bitmovinAccountId}
								label={t("verification.account")}
							/>
						) : (
							"—"
						)}
					</Fact>
					{run.resumedFrom ? (
						<Fact label={t("verification.resumedFrom")}>
							<Link
								href={`/verification/${run.resumedFrom.id}`}
								className="underline decoration-dotted underline-offset-2"
							>
								{run.resumedFrom.runId}
							</Link>
						</Fact>
					) : null}
					{run.resumeDecision ? (
						<Fact label={t("verification.resumeDecision")}>
							{String(run.resumeDecision.decision ?? "—")}:{" "}
							{String(run.resumeDecision.reason ?? "—")}
						</Fact>
					) : null}
				</Facts>
				{run.error ? <p className="text-sm text-red-300">{run.error}</p> : null}
			</Section>

			<Section title={t("verification.source")}>
				<Facts>
					<Fact label={t("verification.sourceObject")}>
						{run.sourceObject ?? "—"}
					</Fact>
					{/* A NAME says nothing about bytes. "unavailable" is
					 * the harness's own word for a source it could not HEAD, and it
					    is shown as such rather than as an empty cell. */}
					<Fact label={t("verification.sourceIdentity")}>
						{run.sourceIdentity ?? t("verification.sourceIdentityUnknown")}
					</Fact>
				</Facts>
			</Section>

			<Section title={t("verification.scenarios")}>
				{outcomes.length === 0 ? (
					<p className="text-sm text-zinc-500">
						{t("verification.noOutcomes")}
					</p>
				) : (
					<div className="overflow-x-auto rounded-lg border border-zinc-800">
						<table className="w-full text-left text-sm">
							<thead className="bg-zinc-900/60 text-[11px] text-zinc-400 uppercase">
								<tr>
									<th className="px-3 py-2 font-medium">
										{t("verification.colScenario")}
									</th>
									<th className="px-3 py-2 font-medium">
										{t("verification.colVerdict")}
									</th>
									<th className="px-3 py-2 font-medium">
										{t("verification.colReason")}
									</th>
									<th className="px-3 py-2 font-medium">
										{t("verification.colEncoding")}
									</th>
									<th className="px-3 py-2 font-medium">
										{t("verification.colChecks")}
									</th>
									<th className="px-3 py-2 font-medium">
										{t("verification.colPlanSha")}
									</th>
								</tr>
							</thead>
							<tbody>
								{outcomes.map((outcome) => (
									<tr
										key={outcome.scenario}
										className="border-zinc-800 border-t align-top"
									>
										<td className="px-3 py-2 text-zinc-200">
											{outcome.scenario}
										</td>
										<td className="px-3 py-2">
											<Badge tone={verdictTone(outcome.verdict)}>
												{outcome.verdict}
											</Badge>
										</td>
										<td className="px-3 py-2 text-xs text-zinc-400">
											{outcome.reason ?? "—"}
										</td>
										<td className="px-3 py-2">
											{outcome.encodingId ? (
												<CopyableId
													value={outcome.encodingId}
													label={t("verification.colEncoding")}
													{...(outcome.jobId
														? { href: `/vod/jobs/${outcome.jobId}` }
														: {})}
												/>
											) : (
												<span className="text-xs text-zinc-600">—</span>
											)}
										</td>
										<td className="px-3 py-2 text-xs text-zinc-400">
											<Checks checks={outcome.checks} />
										</td>
										<td className="px-3 py-2 font-mono text-[11px] text-zinc-500">
											{outcome.planSha256
												? outcome.planSha256.slice(0, 12)
												: "—"}
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)}
			</Section>

			<Section title={t("verification.providerReadback")}>
				{provider.length === 0 ? (
					<p className="text-sm text-zinc-500">
						{t("verification.noProviderReadback")}
					</p>
				) : (
					<ul className="space-y-1">
						{provider.map(([encodingId, status]) => (
							<li key={encodingId} className="flex items-center gap-2">
								<CopyableId
									value={encodingId}
									label={t("verification.colEncoding")}
								/>
								<Badge>{status}</Badge>
							</li>
						))}
					</ul>
				)}
			</Section>

			<Section title={t("verification.cleanup")}>
				{cleanups.length === 0 ? (
					<p className="text-sm text-zinc-500">{t("verification.noCleanup")}</p>
				) : (
					<ul className="space-y-2">
						{cleanups.map((entry) => (
							<li
								key={`${entry.scenario}:${entry.jobId}`}
								className="rounded-lg border border-zinc-800 p-3 text-xs text-zinc-400"
							>
								<div className="flex flex-wrap items-center gap-2">
									<span className="text-zinc-200">{entry.scenario}</span>
									<Badge tone={entry.terminal ? "ok" : "error"}>
										{entry.status}
									</Badge>
									<Badge
										tone={entry.providerTerminal === true ? "ok" : "error"}
									>
										{t("verification.providerTerminal")}:{" "}
										{String(entry.providerTerminal)}
									</Badge>
								</div>
								<div className="mt-1">
									<Link
										href={`/vod/jobs/${entry.jobId}`}
										className="text-emerald-300 underline decoration-dotted underline-offset-2"
									>
										{t("verification.viewJob")}
									</Link>
								</div>
							</li>
						))}
					</ul>
				)}
			</Section>

			{/* The Live/MSL evidence tuples:
			 * one card per output leg, showing the SAME completeness verdict the
			 * harness sealed on — and, when a leg is incomplete, the elements it
			 * lacks, so a reader sees WHY a live PASS was refused rather than a
			    bare INVALID. */}
			<Section title={t("verification.liveEvidence")}>
				{evidence.length === 0 ? (
					<p className="text-sm text-zinc-500">
						{t("verification.noLiveEvidence")}
					</p>
				) : (
					<ul className="space-y-2">
						{evidence.map((row) => {
							const legs = row.tuple.children ?? [];
							const media = legs.reduce(
								(n, c) => n + c.media.filter((m) => m.bytes > 0).length,
								0,
							);
							const bytes = legs.reduce(
								(n, c) => n + c.media.reduce((b, m) => b + m.bytes, 0),
								0,
							);
							return (
								<li
									key={row.id}
									className="rounded-lg border border-zinc-800 p-3 text-xs text-zinc-400"
								>
									<div className="flex flex-wrap items-center gap-2">
										<span className="text-zinc-200">{row.scenario}</span>
										<span className="font-mono text-zinc-300">
											{row.outputLeg}
										</span>
										<Badge>{row.tuple.role}</Badge>
										<Badge tone={row.complete ? "ok" : "error"}>
											{row.complete
												? t("verification.evidenceComplete")
												: t("verification.evidenceIncomplete")}
										</Badge>
									</div>
									<Facts>
										<Fact label={t("verification.evidenceAiring")}>
											{row.liveChannelRunId}
										</Fact>
										<Fact label={t("verification.evidenceProbes")}>
											{row.tuple.probes.length}
										</Fact>
										<Fact label={t("verification.evidenceMedia")}>
											{`${media} (${bytes} B)`}
										</Fact>
										<Fact label={t("verification.evidenceProgression")}>
											{row.tuple.progression.detail}
										</Fact>
									</Facts>
									{row.missing.length > 0 ? (
										<div className="mt-2">
											<p className="text-[11px] text-zinc-500 uppercase">
												{t("verification.evidenceMissing")}
											</p>
											<ul className="list-disc pl-4 text-red-300">
												{row.missing.map((m) => (
													<li key={m}>{m}</li>
												))}
											</ul>
										</div>
									) : null}
								</li>
							);
						})}
					</ul>
				)}
			</Section>

			<Section title={t("verification.seal")}>
				<Facts>
					<Fact label={t("verification.reportPath")}>{run.reportPath}</Fact>
					<Fact label={t("verification.reportSha")}>
						{run.reportSha256 ? (
							<CopyableId
								value={run.reportSha256}
								label={t("verification.reportSha")}
							/>
						) : (
							"—"
						)}
					</Fact>
					<Fact label={t("verification.sealValue")}>
						{run.seal ? (
							<CopyableId
								value={run.seal}
								label={t("verification.sealValue")}
							/>
						) : (
							t("verification.notSealed")
						)}
					</Fact>
					<Fact label={t("verification.sealAlgorithm")}>
						{run.sealAlgorithm ?? "—"}
					</Fact>
					<Fact label={t("verification.sealKeyId")}>
						{run.sealKeyId ?? "—"}
					</Fact>
					<Fact label={t("verification.evidenceVersion")}>
						{run.evidenceVersion ?? "—"}
					</Fact>
					<Fact label={t("verification.retentionUntil")}>
						{run.retentionUntil ?? "—"}
					</Fact>
					<Fact label={t("verification.sealedAt")}>{run.sealedAt ?? "—"}</Fact>
				</Facts>
			</Section>
		</div>
	);
}

function Checks({ checks }: { checks?: Record<string, number> }) {
	const entries = Object.entries(checks ?? {}).filter(([, n]) => n > 0);
	if (entries.length === 0) {
		return <span className="text-zinc-600">—</span>;
	}
	return (
		<span className="flex flex-wrap gap-1">
			{entries.map(([name, n]) => (
				<Badge key={name} tone={name === "failed" ? "error" : "neutral"}>
					{name} {n}
				</Badge>
			))}
		</span>
	);
}

function Section({ title, children }: { title: string; children: ReactNode }) {
	return (
		<section aria-label={title} className="space-y-2">
			<h2 className="font-medium text-sm text-zinc-200">{title}</h2>
			{children}
		</section>
	);
}

function Facts({ children }: { children: ReactNode }) {
	return (
		<dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
			{children}
		</dl>
	);
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div className="flex flex-col gap-0.5">
			<dt className="text-[11px] text-zinc-500 uppercase">{label}</dt>
			<dd className="break-all text-sm text-zinc-300">{children}</dd>
		</div>
	);
}

/**
 * Poll while the run is still RUNNING so a long run reaches SEALED or INCOMPLETE
 * on this screen without a manual reload; stop once it is terminal
 * . A pure function of the data so the stop
 * decision is testable without a wall-clock timer.
 */
export const VERIFICATION_DETAIL_POLL_MS = 5_000;
export function verificationDetailRefetchInterval(
	data: VerificationRunDetail | undefined,
): number | false {
	return data?.status === "RUNNING" ? VERIFICATION_DETAIL_POLL_MS : false;
}

export function RunDetailClient({ id }: { id: string }) {
	const { t } = useT();
	const run = useQuery({
		queryKey: ["verification-run", id],
		queryFn: () =>
			apiFetch<VerificationRunDetail>(`/api/verification-runs/${id}`),
		refetchInterval: (query) =>
			verificationDetailRefetchInterval(query.state.data),
	});
	if (run.isPending) {
		return <p className="text-xs text-zinc-500">{t("verification.loading")}</p>;
	}
	// No data at all — the FIRST load failed, so only the error can be shown.
	if (!run.data) {
		return (
			<p className="text-sm text-red-300">{t("verification.loadFailed")}</p>
		);
	}
	return (
		<div className="space-y-4">
			{/* A poll failed but the row is still the last good one: show it,
			    never as if it were current. */}
			{run.isError ? (
				<RefreshStaleNotice dataUpdatedAt={run.dataUpdatedAt} />
			) : null}
			<RunDetail run={run.data} />
		</div>
	);
}
