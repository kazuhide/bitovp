"use client";

import type {
	EncodingPlan,
	PlanRendition,
	RenditionSummary,
} from "@bitovp/core";
import { classifyRenditionParams } from "@bitovp/core";
import { useState } from "react";
import { CodecBadge, MuxingBadge } from "@/components/codec-badge";
import { CopyableId } from "@/components/copyable-id";
import { Badge } from "@/components/ui/badge";
import { DetailPopover, KeyValueRows } from "@/components/ui/detail-popover";
import { useT } from "@/lib/i18n/context";

type RenditionTablesProps = {
	video: RenditionSummary[];
	audio: RenditionSummary[];
	subtitle: RenditionSummary[];
	/** The plan's renditions, for the expanded param sheet (classification). */
	renditions: PlanRendition[];
	/** The plan's filter DEFINITIONS — the chain rendered kinds only while
	    each filter's full config sat unrendered in the plan . */
	filters: EncodingPlan["filters"];
	/** : resolves a runtime resource id to its Resources-tab anchor
	    (undefined when the id has no producing step in the log), plus the
	    navigation that mounts that tab before the jump. */
	anchorForResource?: (resourceId: string) => string | undefined;
	onOpenResource?: (href: string) => void;
};

export function formatBitrate(bitrate: number | null | undefined): string {
	if (bitrate === null || bitrate === undefined) {
		return "—";
	}
	return bitrate >= 1_000_000
		? `${(bitrate / 1_000_000).toFixed(bitrate % 1_000_000 === 0 ? 0 : 1)} Mbps`
		: `${Math.round(bitrate / 1000)} kbps`;
}

/**
 * The expanded sheet: every plan field for this rendition, with `set` vs
 * `schema default`.
 *
 * "schema default" means *indistinguishable from the schema default* — the
 * persisted plan is the parsed plan, so an explicitly-typed default cannot be
 * told apart from an omitted one (see `classifyRenditionParams`). The badge says
 * "default" rather than "not set" for exactly that reason.
 */
function ParamSheet({ rendition }: { rendition: PlanRendition }) {
	const { t } = useT();
	const params = classifyRenditionParams(rendition);
	return (
		<div className="grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-2">
			{params.map((param) => (
				<div
					key={param.name}
					className="flex items-baseline justify-between gap-2 border-zinc-900 border-b py-1"
				>
					<span className="font-mono text-xs text-zinc-400">{param.name}</span>
					<span className="flex items-center gap-2 text-right">
						<span className="font-mono text-xs text-zinc-200">
							{typeof param.value === "object" && param.value !== null
								? JSON.stringify(param.value)
								: String(param.value)}
						</span>
						{param.source === "schema-default" ? (
							<span className="text-[10px] text-zinc-600">
								{t("jobDetail.schemaDefault")}
							</span>
						) : null}
					</span>
				</div>
			))}
		</div>
	);
}

function RenditionRow({
	summary,
	rendition,
	filters,
	anchorForResource,
	onOpenResource,
	kind,
}: {
	summary: RenditionSummary;
	rendition?: PlanRendition;
	filters: EncodingPlan["filters"];
	anchorForResource?: (resourceId: string) => string | undefined;
	onOpenResource?: (href: string) => void;
	kind: "video" | "audio" | "subtitle";
}) {
	const { t } = useT();
	const [open, setOpen] = useState(false);
	const perTitle = summary.mode?.startsWith("PER_TITLE") === true;
	return (
		<>
			<tr className="border-zinc-900 border-b">
				<td className="py-2 pr-3">
					<button
						type="button"
						aria-expanded={open}
						// Named per ROW. Every expander shared one accessible name, so a
						// screen-reader user listing controls heard N identical "Show
						// details" buttons with nothing to choose between (review nit).
						aria-label={t(
							open ? "jobDetail.collapseRowNamed" : "jobDetail.expandRowNamed",
							{ rendition: summary.key },
						)}
						onClick={() => setOpen(!open)}
						className="text-zinc-500 hover:text-zinc-200"
					>
						{open ? "▾" : "▸"}
					</button>
				</td>
				<td className="py-2 pr-3 font-mono text-xs text-zinc-300">
					{summary.key}
				</td>
				<td className="py-2 pr-3">
					<CodecBadge codec={summary.codec} family={summary.family} />
				</td>
				<td className="py-2 pr-3 text-xs text-zinc-300 tabular-nums">
					{kind === "video"
						? summary.height
							? `${summary.height}p`
							: t("jobDetail.perTitleScaled")
						: kind === "audio"
							? (summary.channelLayout ?? "—")
							: "—"}
				</td>
				<td className="py-2 pr-3 text-xs text-zinc-300 tabular-nums">
					{formatBitrate(summary.bitrate)}
				</td>
				<td className="py-2 pr-3 text-xs text-zinc-400">
					{kind === "video"
						? (summary.profile ?? "—")
						: summary.sampleRate
							? `${(summary.sampleRate / 1000).toFixed(1)} kHz`
							: "—"}
				</td>
				<td className="py-2 pr-3">
					{perTitle ? (
						<Badge>{t("jobDetail.perTitle")}</Badge>
					) : (
						<span className="text-xs text-zinc-600">—</span>
					)}
				</td>
				<td className="py-2">
					<span className="flex flex-wrap gap-1">
						{summary.muxings.length === 0 ? (
							<span className="text-xs text-zinc-600">
								{t("jobDetail.noMuxings")}
							</span>
						) : (
							summary.muxings.map((muxing) => (
								<MuxingBadge key={muxing.key} kind={muxing.kind} />
							))
						)}
					</span>
				</td>
			</tr>
			{open ? (
				<tr className="border-zinc-900 border-b bg-zinc-950/40">
					<td />
					<td colSpan={7} className="py-3 pr-3">
						{/* Muxing legs: where each one writes, and under what DRM. A
						    DRM'd muxing carries no destination of its own — the DRM
						    resource owns the encrypted output — so it says so rather
						    than showing a blank path. */}
						<p className="font-medium text-xs text-zinc-300">
							{t("jobDetail.muxingDetail")}
						</p>
						<ul className="mt-1 space-y-1">
							{summary.muxings.map((muxing) => (
								<li key={muxing.key} className="text-xs text-zinc-400">
									<MuxingBadge kind={muxing.kind} />{" "}
									<span className="font-mono">{muxing.key}</span>
									{muxing.segmentLength !== undefined
										? ` · ${muxing.segmentLength}s`
										: ""}
									{muxing.filename ? ` · ${muxing.filename}` : ""}
									{/* A shared container, said in the direction this row needs
									    . Core computed `sharedWith` and nothing
									    rendered it, so the audio row went from "No muxings" —
									    visibly wrong — to two containers pointing into
									    /video/720p with no explanation, which is worse: it reads
									    as a fact and sends an operator looking for an audio
									    artefact among .ts segments. The destination printed below
									    is the CONTAINER's, so the row has to say whose. */}
									{muxing.carriedBy ? (
										<>
											{" · "}
											<span className="text-amber-400">
												{t("jobDetail.ridesInContainerOf", {
													key: muxing.carriedBy,
												})}
											</span>
										</>
									) : muxing.sharedWith ? (
										<>
											{" · "}
											<span className="text-amber-400">
												{t("jobDetail.alsoCarries", {
													keys: muxing.sharedWith.join(", "),
												})}
											</span>
										</>
									) : null}
									{/* Segment naming and the init segment: the wizard SETS both
									    (300 muxings across the corpus carry them) and the detail
									    page never showed either back, so an operator could not
									    check what they had asked for — design §5 clause 2 names
									    them explicitly (review finding). */}
									{muxing.segmentNaming ? (
										<>
											{" · "}
											<span className="font-mono">{muxing.segmentNaming}</span>
										</>
									) : null}
									{muxing.initSegmentName ? (
										<>
											{" · "}
											<span className="font-mono">
												{muxing.initSegmentName}
											</span>
										</>
									) : null}
									{muxing.destination ? (
										<>
											{" · "}
											{/* Copyable, per §5: an operator pastes this into a CLI. */}
											<CopyableId
												value={`${muxing.destination.outputKey}:${muxing.destination.path}`}
											/>
											{typeof muxing.destination.acl === "string" ? (
												<> · {muxing.destination.acl}</>
											) : null}
										</>
									) : (
										<> · {t("jobDetail.viaDrmOutputs")}</>
									)}
									{/* Each DRM system WITH the output it writes. Showing `kind`
									    alone discarded `drm[].destination`, which core added
									    precisely because five fixtures' encrypted write paths were
									    unreachable from anywhere — reintroducing the same blind
									    spot one layer up (review finding). */}
									{muxing.drm.length > 0 ? (
										<ul className="mt-0.5 ml-4 space-y-0.5">
											{muxing.drm.map((drm) => (
												<li key={drm.key} className="text-zinc-400">
													<Badge className="font-mono">{drm.kind}</Badge>{" "}
													<CopyableId
														value={`${drm.destination.outputKey}:${drm.destination.path}`}
													/>
													{typeof drm.destination.acl === "string" ? (
														<> · {drm.destination.acl}</>
													) : null}
												</li>
											))}
										</ul>
									) : null}
								</li>
							))}
						</ul>

						{summary.filters.length > 0 ? (
							<p className="mt-2 text-xs text-zinc-400">
								{t("jobDetail.filterChain")}:{" "}
								{/* Each element opens the filter's CONFIG  — the
								    chain showed kinds only while plan.filters carried the
								    parameters. Order is the attachment order (position). */}
								{summary.filters.map((attachment, index) => {
									const config = filters.find(
										(f) => f.key === attachment.filterKey,
									);
									const shown = attachment.kind ?? attachment.filterKey;
									return (
										<span key={attachment.filterKey}>
											{index > 0 ? (
												<span className="text-zinc-600"> → </span>
											) : null}
											{config ? (
												<DetailPopover
													summary={
														<>
															<span className="font-mono">{shown}</span>
															{/* Differentiate N identical kind-named
															    triggers without breaking WCAG 2.5.3: the
															    visible text stays a prefix (review-179
															    N4; mono restored per N9 — the fallback
															    span kept it while the trigger lost it). */}
															<span className="sr-only">{`, ${summary.key}`}</span>
														</>
													}
													label={t("jobDetail.filterConfigLabel", {
														key: attachment.filterKey,
													})}
												>
													<div className="max-w-96">
														<KeyValueRows
															record={
																config as unknown as Record<string, unknown>
															}
														/>
													</div>
												</DetailPopover>
											) : (
												<span className="font-mono">{shown}</span>
											)}
										</span>
									);
								})}
							</p>
						) : null}

						{/* Runtime ids cross-link to the Resources tab anchors. */}
						{summary.runtime.streamId || summary.runtime.codecConfigId ? (
							<div className="mt-2 flex flex-wrap items-center gap-3">
								{summary.runtime.streamId ? (
									<CopyableId
										label={t("jobDetail.streamId")}
										value={summary.runtime.streamId}
										href={anchorForResource?.(summary.runtime.streamId)}
										onNavigate={onOpenResource}
									/>
								) : null}
								{summary.runtime.codecConfigId ? (
									<CopyableId
										label={t("jobDetail.codecConfigId")}
										value={summary.runtime.codecConfigId}
										href={anchorForResource?.(summary.runtime.codecConfigId)}
										onNavigate={onOpenResource}
									/>
								) : null}
							</div>
						) : null}

						{rendition ? (
							<div className="mt-3">
								<p className="font-medium text-xs text-zinc-300">
									{t("jobDetail.planParameters")}
								</p>
								<div className="mt-1">
									<ParamSheet rendition={rendition} />
								</div>
							</div>
						) : null}
					</td>
				</tr>
			) : null}
		</>
	);
}

function Table({
	rows,
	renditions,
	filters,
	anchorForResource,
	onOpenResource,
	kind,
	title,
}: {
	rows: RenditionSummary[];
	renditions: PlanRendition[];
	filters: EncodingPlan["filters"];
	anchorForResource?: (resourceId: string) => string | undefined;
	onOpenResource?: (href: string) => void;
	kind: "video" | "audio" | "subtitle";
	title: string;
}) {
	const { t } = useT();
	if (rows.length === 0) {
		return null;
	}
	return (
		<>
			<h3 className="mt-4 font-medium text-xs text-zinc-400 uppercase tracking-wide">
				{title}
			</h3>
			{/* Its own scroll container: eight columns do not fit a phone, and the
			    page body must never scroll sideways. */}
			<div className="mt-1 overflow-x-auto">
				<table className="w-full min-w-[40rem] text-left">
					<thead>
						<tr className="border-zinc-800 border-b text-[11px] text-zinc-500 uppercase">
							<th className="w-6 py-1" />
							<th className="py-1 pr-3 font-medium">{t("jobDetail.colKey")}</th>
							<th className="py-1 pr-3 font-medium">
								{t("jobDetail.colCodec")}
							</th>
							<th className="py-1 pr-3 font-medium">
								{kind === "audio"
									? t("jobDetail.colChannels")
									: t("jobDetail.colResolution")}
							</th>
							<th className="py-1 pr-3 font-medium">
								{t("jobDetail.colBitrate")}
							</th>
							<th className="py-1 pr-3 font-medium">
								{kind === "audio"
									? t("jobDetail.colSampleRate")
									: t("jobDetail.colProfile")}
							</th>
							<th className="py-1 pr-3 font-medium">
								{t("jobDetail.colMode")}
							</th>
							<th className="py-1 font-medium">{t("jobDetail.colMuxings")}</th>
						</tr>
					</thead>
					<tbody>
						{rows.map((summary) => (
							<RenditionRow
								key={summary.key}
								summary={summary}
								filters={filters}
								anchorForResource={anchorForResource}
								onOpenResource={onOpenResource}
								{...(renditions.find((r) => r.key === summary.key)
									? {
											rendition: renditions.find(
												(r) => r.key === summary.key,
											) as PlanRendition,
										}
									: {})}
								kind={kind}
							/>
						))}
					</tbody>
				</table>
			</div>
		</>
	);
}

/**
 * The rendition ladder — what was actually encoded.
 *
 * The page had no answer to that at all before this: it showed manifests, VMAF
 * reports and a step timeline, but nothing about the ladder itself. Rows are
 * bitrate-descending (the selector's ordering) because the top rung is what an
 * operator looks at first.
 *
 * Per-title rows show a `PER_TITLE` badge and a scaled-by-the-algorithm
 * resolution rather than a fabricated number — the template genuinely has no
 * height until the encoder picks one. This table is INTENT only; what the
 * encoder actually built is the separate per-title results panel, from the
 * captured `PER_TITLE_RESULT` streams. (An earlier draft of this comment pointed
 * at a `runtime.perTitleCreated` count, which a review removed — `CREATE_STREAM`
 * responses are `{id}`, so it could never have been populated.)
 */
export function RenditionTables({
	video,
	audio,
	subtitle,
	renditions,
	filters,
	anchorForResource,
	onOpenResource,
}: RenditionTablesProps) {
	const { t } = useT();
	if (video.length === 0 && audio.length === 0 && subtitle.length === 0) {
		return null;
	}
	return (
		<section aria-labelledby="renditions-heading" className="mt-6">
			<h2 id="renditions-heading" className="font-medium text-sm text-zinc-200">
				{t("jobDetail.renditions")}
			</h2>
			<Table
				rows={video}
				renditions={renditions}
				filters={filters}
				anchorForResource={anchorForResource}
				onOpenResource={onOpenResource}
				kind="video"
				title={t("jobDetail.videoRenditions")}
			/>
			<Table
				rows={audio}
				renditions={renditions}
				filters={filters}
				anchorForResource={anchorForResource}
				onOpenResource={onOpenResource}
				kind="audio"
				title={t("jobDetail.audioRenditions")}
			/>
			<Table
				rows={subtitle}
				renditions={renditions}
				filters={filters}
				anchorForResource={anchorForResource}
				onOpenResource={onOpenResource}
				kind="subtitle"
				title={t("jobDetail.subtitleRenditions")}
			/>
		</section>
	);
}
