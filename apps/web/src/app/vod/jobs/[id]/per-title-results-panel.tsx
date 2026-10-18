"use client";

import {
	groupPerTitleResults,
	type PerTitleResultStream,
	type PerTitleResultsView,
} from "@bitovp/core";
import { useQueryClient } from "@tanstack/react-query";
import { Check, Copy } from "lucide-react";
import { useState } from "react";
import {
	ClipboardCopyStatus,
	useClipboardCopy,
} from "@/components/copy-button";
import { CopyableId } from "@/components/copyable-id";
import { DetailPopover, KeyValueRows } from "@/components/ui/detail-popover";
import { useMutationAccess } from "@/lib/auth/use-role-access";
import { useT } from "@/lib/i18n/context";
import { formatBitrate } from "./rendition-tables";

/**
 * What the per-title algorithm actually produced — the RESULT half of bm-xray's
 * template↔result distinction.
 *
 * The renditions table above shows INTENT: the templates the operator asked for.
 * This shows what the encoder built, captured at the end of the run (the streams
 * exist only then, and Bitmovin purges them after ~90 days — C7).
 *
 * Every state is stated rather than rendered as emptiness, because "no rows" has
 * four different meanings here and three of them are not "the encoder produced
 * nothing":
 *
 *  - captured    → the table, plus what the scan could not do;
 *  - failed      → the capture ran and could not read; the error, and a retry;
 *  - absent      → nothing captured yet (an older job, or one still running);
 *  - not shown at all when the plan has no per-title renditions.
 */

type Props = {
	view: PerTitleResultsView;
	/** Plan order of the per-title template renditions, for grouping. */
	templateOrder: string[];
	/** Terminal jobs only: the backfill needs a finished encoding to read. */
	canCapture: boolean;
	jobId: string;
};

/**
 * The SAME formatter the renditions table uses, imported rather than re-derived.
 * These two tables sit on one screen and the whole point is comparing intent
 * against result — one rendering `4.8 Mbps` while the other rendered
 * `4,200 kbps` (with a locale-dependent separator the other did not use) made that
 * comparison arithmetic (review finding).
 */

/** `1920×1080` when the encoder reported an applied size; undefined when not. */
function appliedResolution(
	applied: PerTitleResultStream["appliedSettings"],
): string | undefined {
	if (
		!applied ||
		(applied.width === undefined && applied.height === undefined)
	) {
		return undefined;
	}
	return `${applied.width ?? "?"}×${applied.height ?? "?"}`;
}

function formatResolution(
	applied: PerTitleResultStream["appliedSettings"],
): string {
	return appliedResolution(applied) ?? "—";
}

/**
 * How a copy button names the rung it copies for: the applied resolution the
 * row shows, or — when the encoder reported none and the cell shows "—" — the
 * stream id the row is identified by. Never the dash itself: a name that says
 * "rendition —" names nothing.
 */
function renditionLabel(result: PerTitleResultStream): string {
	return appliedResolution(result.appliedSettings) ?? result.streamId;
}

/** Distinct paths only: the capture tolerates duplicate outputs that agree. */
function distinctPaths(
	outputs: { outputPath?: string | undefined }[],
): string[] {
	return [
		...new Set(
			outputs
				.map((o) => o.outputPath)
				.filter((p): p is string => typeof p === "string" && p.length > 0),
		),
	];
}

/**
 * One resolved output path, WRAPPED and COPYABLE (not truncated) so the run's
 * `{height}p_{bitrate}_{uuid}` key is traceable in full — placeholder → RESULT
 * stream → muxing → resolved key in one row. The
 * whole line copies on click (CopyableId's affordance, sized down for a dense
 * list); the tooltip stays the catalogue sentence a `getByTitle` test pins.
 *
 * `name` is the button's ACCESSIBLE name — target and purpose ("Copy the output
 * path of rendition 1920×1080 (FMP4): video/…"), unique per row because the
 * path is in it. Every path button used to be the bare "Copy", so a screen
 * reader listing controls heard N identical buttons and could not tell which
 * rung or leg any of them copied. The
 * `title` stays a description beside it, never the name.
 */
function ResolvedPath({
	path,
	title,
	name,
	drmType,
}: {
	path: string;
	title: string;
	name: string;
	drmType?: string;
}) {
	const { copied, copy } = useClipboardCopy(path);
	return (
		<>
			<button
				type="button"
				title={title}
				aria-label={name}
				onClick={copy}
				className="group flex w-full items-start gap-1 break-all text-left font-mono text-[10px] text-zinc-500 hover:text-zinc-300"
			>
				{copied ? (
					<Check
						aria-hidden
						className="mt-px h-2.5 w-2.5 shrink-0 text-emerald-400"
					/>
				) : (
					<Copy
						aria-hidden
						className="mt-px h-2.5 w-2.5 shrink-0 text-zinc-600 opacity-0 group-hover:opacity-100"
					/>
				)}
				<span className="min-w-0">
					{drmType ? (
						<span className="text-amber-500/80">{drmType} </span>
					) : null}
					{path}
				</span>
			</button>
			<ClipboardCopyStatus copied={copied} />
		</>
	);
}

/**
 * The resolved output paths of one muxing leg — the one fact about a result the
 * plan can never state (C4 forces `{uuid}`/`{bitrate}` placeholders, so where a
 * rung landed is only knowable after the run), and the whole reason capture
 * must capture the paths before Bitmovin's ~90-day purge. They are
 * rendered here with wrapping and copy controls so
 * the resolved key is traceable in full.
 *
 * DRM'd legs write through the DRM resource (`stream → muxing → drm → output →
 * outputPath`), so those paths are listed under their DRM type. A leg with
 * neither renders nothing rather than an em dash: older snapshots predate path
 * capture, and "—" would claim we looked and found none.
 */
function LegPaths({
	muxing,
	rendition,
}: {
	muxing: NonNullable<PerTitleResultStream["muxings"][number]>;
	/** The rung's label for the copy buttons' accessible names (`renditionLabel`). */
	rendition: string;
}) {
	const { t } = useT();
	const own = distinctPaths(muxing.outputs ?? []);
	const drms = (muxing.drm ?? []).flatMap((drm) =>
		distinctPaths(drm.outputs ?? []).map((path) => ({
			key: `${drm.drmId}:${path}`,
			type: drm.drmType,
			path,
		})),
	);
	if (own.length === 0 && drms.length === 0) {
		return null;
	}
	return (
		<div className="mt-0.5 space-y-0.5">
			{own.map((path) => (
				<ResolvedPath
					key={path}
					path={path}
					title={t("jobDetail.ptPathTitle")}
					name={t("jobDetail.ptCopyPath", {
						rendition,
						muxing: muxing.muxingType,
						path,
					})}
				/>
			))}
			{drms.map((drm) => (
				<ResolvedPath
					key={drm.key}
					path={drm.path}
					drmType={drm.type}
					title={t("jobDetail.ptDrmPathTitle", { type: drm.type })}
					name={t("jobDetail.ptCopyDrmPath", {
						rendition,
						muxing: muxing.muxingType,
						drm: drm.type,
						path: drm.path,
					})}
				/>
			))}
		</div>
	);
}

function ResultRows({ results }: { results: PerTitleResultStream[] }) {
	const { t } = useT();
	return (
		<>
			{results.flatMap((result) => {
				// ONE ROW PER MUXING. A rung can have several legs — 33 per-title
				// renditions in the corpus carry FMP4 *and* TS — and the first version
				// read every statistic off `muxings[0]` while joining every
				// `muxingType`, so the row advertised "FMP4, TS" and reported FMP4's
				// numbers under both names, with the TS leg unreachable from the UI
				// (review finding). Same shape as the two DRM bugs core already fixed
				// here, which is why the snapshot models `muxings` as plural.
				const legs = result.muxings.length > 0 ? result.muxings : [undefined];
				// The rung as the row shows it, for the copy buttons' accessible names.
				const rendition = renditionLabel(result);
				return legs.map((muxing, index) => (
					<tr
						key={`${result.streamId}:${muxing?.muxingId ?? "none"}`}
						className="border-zinc-800/60 border-b last:border-0"
					>
						{/* The stream identifies the rung, so it spans its legs. */}
						{index === 0 ? (
							<td
								rowSpan={legs.length}
								className="py-1 pr-3 align-top text-[11px]"
							>
								<CopyableId value={result.streamId} />
							</td>
						) : null}
						{index === 0 ? (
							<td
								rowSpan={legs.length}
								className="py-1 pr-3 align-top tabular-nums"
							>
								{formatResolution(result.appliedSettings)}
							</td>
						) : null}
						<td className="py-1 pr-3 tabular-nums">
							{formatBitrate(muxing?.avgBitrate)}
						</td>
						<td className="py-1 pr-3 tabular-nums">
							{formatBitrate(muxing?.maxBitrate)}
						</td>
						<td className="py-1 pr-3 tabular-nums">
							{muxing?.segmentsMuxed ?? "—"}
						</td>
						<td className="py-1 pr-3">
							{muxing?.muxingType ?? "—"}
							{muxing ? (
								<LegPaths muxing={muxing} rendition={rendition} />
							) : null}
						</td>
						{index === 0 ? (
							<td rowSpan={legs.length} className="py-1 align-top tabular-nums">
								{/* Observed values, so NO set/schema-default badge: nobody set
								    them, the encoder chose them (UI-DESIGN §6). Per RUNG, not
								    per leg — the codec config belongs to the stream. The COUNT
								    alone told an operator nothing ("34 observed" — of what?);
								    the settings themselves are the payload, one click away
								    (owner directive, 2026-08-12). */}
								{Object.keys(result.params).length > 0 ? (
									<DetailPopover
										summary={t("jobDetail.ptResultParamCount", {
											count: String(Object.keys(result.params).length),
										})}
										label={t("jobDetail.ptResultParamsLabel")}
									>
										<KeyValueRows record={result.params} />
									</DetailPopover>
								) : (
									t("jobDetail.ptResultParamsMissing")
								)}
							</td>
						) : null}
					</tr>
				));
			})}
		</>
	);
}

export function PerTitleResultsPanel({
	view,
	templateOrder,
	canCapture,
	jobId,
}: Props) {
	const { t } = useT();
	const canOperate = useMutationAccess("vod.job.per-title");
	const queryClient = useQueryClient();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function capture() {
		setBusy(true);
		setError(null);
		try {
			const res = await fetch(
				`/api/encoding-jobs/${jobId}/capture-per-title-results`,
				{ method: "POST" },
			);
			if (!res.ok) {
				const body = (await res.json().catch(() => ({}))) as {
					error?: string;
				};
				// The upstream message verbatim — a purged encoding says so, and the
				// operator needs to know it is gone rather than that we found nothing.
				setError(body.error ?? String(res.status));
				return;
			}
			// The snapshot lives on the row now. Invalidate, don't reload (ledger
			// #72): the row re-fetches and renders through the same selector the
			// step-log path uses — one render path — while a reload cost the active
			// tab, every expanded row, and the playing player, and made this success
			// path untestable in jsdom (no navigation).
			await queryClient.invalidateQueries({
				queryKey: ["encoding-job", jobId],
			});
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	}

	const captureButton =
		canCapture && canOperate ? (
			<button
				type="button"
				onClick={capture}
				disabled={busy}
				className="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-200 hover:bg-zinc-800 disabled:opacity-50"
			>
				{busy ? t("jobDetail.ptCapturing") : t("jobDetail.ptCaptureNow")}
			</button>
		) : null;

	return (
		<section aria-labelledby="pertitle-results-heading" className="mt-6">
			<h2
				id="pertitle-results-heading"
				className="font-medium text-sm text-zinc-200"
			>
				{t("jobDetail.ptResults")}
			</h2>

			{view.origin === "absent" ? (
				<div className="mt-1 space-y-2 text-xs text-zinc-400">
					<p>{t("jobDetail.ptAbsent")}</p>
					{captureButton}
				</div>
			) : null}

			{view.origin === "failed" ? (
				<div className="mt-1 space-y-2 text-xs">
					{/* NOT an empty table: the capture ran and could not read. */}
					<p className="text-amber-400">
						{t("jobDetail.ptFailed", { error: view.error })}
					</p>
					{captureButton}
				</div>
			) : null}

			{error !== null ? (
				<p className="mt-2 text-amber-400 text-xs">
					{t("jobDetail.ptCaptureFailed", { error })}
				</p>
			) : null}

			{view.origin === "step" || view.origin === "snapshot" ? (
				<div className="mt-1">
					<p className="text-[11px] text-zinc-500">
						{t(
							view.origin === "snapshot"
								? "jobDetail.ptFromBackfill"
								: "jobDetail.ptFromRun",
							{ at: view.snapshot.capturedAt },
						)}
					</p>
					{/* The scan's own honesty, before the numbers it produced. */}
					{view.snapshot.scan.complete ? null : (
						<p className="mt-1 text-amber-400 text-xs">
							{/* "Stopped early" without the numbers is not actionable —
							    the scan's own accounting says HOW incomplete (ux
							    inventory #7). */}
							<DetailPopover
								summary={t("jobDetail.ptIncomplete")}
								label={t("jobDetail.ptScanDetailLabel")}
							>
								<KeyValueRows
									sort={false}
									record={{
										[t("jobDetail.ptScanStreamsListed")]:
											view.snapshot.scan.streamsListed,
										[t("jobDetail.ptScanResultsCaptured")]:
											view.snapshot.scan.resultsCaptured,
										[t("jobDetail.ptScanMuxingsListed")]:
											view.snapshot.scan.muxingsListed,
										[t("jobDetail.ptScanTemplatesListed")]:
											view.snapshot.scan.templatesListed,
										[t("jobDetail.ptScanTemplatesDeclared")]:
											view.snapshot.scan.templatesDeclared,
										[t("jobDetail.ptScanUnattributed")]:
											view.snapshot.scan.unattributed,
										[t("jobDetail.ptScanConfigErrors")]:
											view.snapshot.scan.codecConfigErrors,
									}}
								/>
							</DetailPopover>
						</p>
					)}
					{view.snapshot.scan.codecConfigErrors > 0 ? (
						<p className="mt-1 text-amber-400 text-xs">
							{t("jobDetail.ptConfigErrors", {
								count: String(view.snapshot.scan.codecConfigErrors),
							})}
						</p>
					) : null}

					{view.snapshot.streams.length === 0 ? (
						<p className="mt-1 text-xs text-zinc-400">
							{t("jobDetail.ptNoResults")}
						</p>
					) : (
						<div className="mt-1 overflow-x-auto">
							<table className="w-full min-w-[42rem] text-left text-xs">
								<thead>
									<tr className="border-zinc-800 border-b text-[11px] text-zinc-500 uppercase">
										<th className="py-1 pr-3 font-medium">
											{t("jobDetail.ptColStream")}
										</th>
										<th className="py-1 pr-3 font-medium">
											{t("jobDetail.ptColApplied")}
										</th>
										<th className="py-1 pr-3 font-medium">
											{t("jobDetail.ptColAvgBitrate")}
										</th>
										<th className="py-1 pr-3 font-medium">
											{t("jobDetail.ptColMaxBitrate")}
										</th>
										<th className="py-1 pr-3 font-medium">
											{t("jobDetail.ptColSegments")}
										</th>
										<th className="py-1 pr-3 font-medium">
											{t("jobDetail.ptColMuxing")}
										</th>
										<th className="py-1 font-medium">
											{t("jobDetail.ptColParams")}
										</th>
									</tr>
								</thead>
								{groupPerTitleResults(view.snapshot, templateOrder).map(
									(group) => (
										<tbody
											// Prefixed rather than a sentinel value: a rendition
											// could legitimately be called "unattributed", and the
											// first version's separator was a raw NUL, which this
											// repo's own no-binary-sources check catches (5th time).
											key={
												group.rendition === null
													? "group:unattributed"
													: `template:${group.rendition}`
											}
										>
											<tr>
												<th
													colSpan={7}
													scope="colgroup"
													className="pt-2 pb-1 text-left font-medium text-[11px] text-zinc-400 uppercase tracking-wide"
												>
													{group.rendition === null
														? t("jobDetail.ptUnattributed", {
																count: String(group.results.length),
															})
														: t("jobDetail.ptFromTemplate", {
																rendition: group.rendition,
															})}
												</th>
											</tr>
											<ResultRows results={group.results} />
										</tbody>
									),
								)}
							</table>
						</div>
					)}

					{/* Why a group is unattributed, stated once, under the table. */}
					{view.snapshot.scan.unattributed > 0 ? (
						<p className="mt-2 text-[11px] text-zinc-500">
							{t("jobDetail.ptWhyUnattributed")}
						</p>
					) : null}
				</div>
			) : null}
		</section>
	);
}
