"use client";

import { CopyableId } from "@/components/copyable-id";
import { formatDateTime } from "@/lib/format";
import { useT } from "@/lib/i18n/context";

type Fact = { label: string; value: string };

/**
 * Finite, not just present: a corrupted step log's arithmetic can hand this
 * NaN/Infinity, and `Math.floor(NaN / 60)` renders "NaNm NaNs".
 */
function formatSeconds(durationSeconds: number | undefined): string {
	if (durationSeconds === undefined || !Number.isFinite(durationSeconds)) {
		return "—";
	}
	// Round the TOTAL first (review-295 S2): floor-minutes + round-seconds
	// rendered 599.8s as "9m 60s" — and 599.8s is literally the ~10-minute
	// Akamai queue the startup fact exists for.
	const total = Math.round(durationSeconds);
	return total >= 60
		? `${Math.floor(total / 60)}m ${total % 60}s`
		: `${total}s`;
}

/**
 * The encoding's facts, as a flat grid.
 *
 * Sourced entirely from the row and the plan — no Bitmovin read (C7: this page
 * must render after the ~90-day purge and for DRAFT jobs with no remote
 * resources at all). bm-xray's equivalent pulls the live API on every visit;
 * here the persisted plan IS the record, which is the whole reason this app
 * snapshots. The one Bitmovin-SOURCED fact, encoder startup ,
 * still honors this: the route burns queuedAt/runningAt into the job's
 * snapshots on first sight, so once seen it renders after the purge too.
 *
 * Flat 2×4 rather than nested cards: it sits above the rendition tables, and a
 * card around four labelled values is chrome that pushes the ladder down.
 */
export function OverviewStrip({
	region,
	encoderVersion,
	encodingMode,
	labels,
	createdAt,
	durationSeconds,
	startupSeconds,
	bitmovinEncodingId,
	presetRevision,
	preset,
}: {
	region: string | null;
	encoderVersion?: string;
	encodingMode?: string;
	labels: string[];
	createdAt: string;
	/** Wall-clock of the encode itself, from the step log's AWAIT timing. */
	durationSeconds?: number;
	/** Bitmovin queuedAt→runningAt  — the queue+allocation wait. */
	startupSeconds?: number;
	bitmovinEncodingId: string | null;
	/**
	 * Template provenance : the revision COPIED at launch. A
	 * non-null revision with a null `preset` means the template was deleted
	 * (SetNull) — the revision survives, the name does not.
	 */
	presetRevision?: number | null;
	/** The template's CURRENT name+revision (for the rev-behind hint). */
	preset?: { name: string; revision: number } | null;
}) {
	const { t } = useT();
	const facts: Fact[] = [
		{ label: t("jobDetail.region"), value: region ?? "—" },
		{ label: t("jobDetail.encoderVersion"), value: encoderVersion ?? "—" },
		{ label: t("jobDetail.encodingMode"), value: encodingMode ?? "—" },
		{
			label: t("jobDetail.labels"),
			value: labels.length > 0 ? labels.join(", ") : "—",
		},
		{
			label: t("jobDetail.created"),
			// The shared formatter, not a bare `new Date(...).toLocaleString`: it
			// renders an unparseable timestamp as "—" instead of "Invalid Date" (the
			// same bug class the live-encodings list hit — an Invalid Date is truthy).
			value: formatDateTime(createdAt),
		},
		{
			label: t("jobDetail.encodeDuration"),
			value: formatSeconds(durationSeconds),
		},
		{
			//  (owner): the run-timeline chart deliberately starts
			// at RUNNING, so the queue wait must be readable HERE as a figure.
			label: t("jobDetail.encoderStartup"),
			value: formatSeconds(startupSeconds),
		},
	];
	// Provenance chip only for template-launched jobs — pre-#109 rows and
	// ad-hoc submissions have neither field and get no empty fact.
	if (presetRevision !== null && presetRevision !== undefined) {
		facts.push({
			label: t("jobDetail.template"),
			value: preset
				? preset.revision > presetRevision
					? t("jobDetail.templateRevBehind", {
							name: preset.name,
							launched: presetRevision,
							current: preset.revision,
						})
					: `${preset.name} (rev ${presetRevision})`
				: t("jobDetail.templateDeleted", { rev: presetRevision }),
		});
	}
	return (
		<section aria-labelledby="overview-strip-heading" className="mt-4">
			<h2 id="overview-strip-heading" className="sr-only">
				{t("ui.overview")}
			</h2>
			<dl className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-3 lg:grid-cols-4">
				{facts.map((fact) => (
					<div key={fact.label}>
						<dt className="text-[11px] text-zinc-500 uppercase tracking-wide">
							{fact.label}
						</dt>
						<dd className="text-sm text-zinc-200">{fact.value}</dd>
					</div>
				))}
				{bitmovinEncodingId ? (
					<div>
						<dt className="text-[11px] text-zinc-500 uppercase tracking-wide">
							{t("jobDetail.encodingId")}
						</dt>
						<dd className="mt-0.5">
							<CopyableId value={bitmovinEncodingId} />
						</dd>
					</div>
				) : null}
			</dl>
		</section>
	);
}
