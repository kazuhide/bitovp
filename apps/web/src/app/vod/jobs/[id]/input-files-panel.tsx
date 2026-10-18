"use client";

import type { ChainSegment, InputFileSummary } from "@bitovp/core";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import {
	InspectDialog,
	type InspectTarget,
	latestInspectionKey,
} from "@/app/storage/inspect-dialog";
import {
	type StorageInspectionDto,
	summarizeProbe,
} from "@/app/storage/inspect-shared";
import { CopyableId } from "@/components/copyable-id";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/api";
import { RoleAccess } from "@/lib/auth/use-role-access";
import type { MessageKey } from "@/lib/i18n";
import { useT } from "@/lib/i18n/context";

/**
 * Which source files this job read, and which renditions consumed each.
 *
 * The consumer chain is the point. A ladder that reads one mezzanine is obvious;
 * what is not obvious — and what the page could not answer at all — is a plan
 * where 1080p comes from one file, the subtitles from a WebVTT sidecar, and the
 * Dolby Vision metadata from a third. The chain string is built by the core
 * selector and read left-to-right as the data flows: `concat(pos 1) →
 * trim(TIME_BASED) → ingest(AUTO pos 0)`.
 *
 * HTTPS inputs render without a credential row: they are the one credential-less
 * input kind, and showing "deleted credential" for them would be a lie.
 */
/**
 * One chain hop, as display text.
 *
 * The wrappers are copy and go through the catalogue; the enum values (`AUTO`,
 * `TIME_BASED`, `VISION`, `DAMF`) are API tokens the operator meets in the SDK,
 * the step log and Bitmovin's dashboard, so they render verbatim. That split is
 * why core returns structured segments rather than a formatted string: assembling
 * this sentence in core would have put English prose in a UI-free package (review
 * finding).
 */
function formatSegment(
	segment: ChainSegment,
	t: (key: MessageKey, values?: Record<string, string | number>) => string,
): string {
	switch (segment.kind) {
		case "ingest":
			return t("jobDetail.chainIngest", {
				mode: segment.selectionMode,
				position: segment.position,
			});
		case "file":
			return t("jobDetail.chainFile", { type: segment.type });
		case "dolby":
			return t("jobDetail.chainDolby", {
				kind: segment.dolbyKind,
				detail: segment.detail ?? "",
			});
		case "trim":
			return t("jobDetail.chainTrim", { kind: segment.trimKind });
		case "concat":
			return segment.isMain
				? t("jobDetail.chainConcatMain", { position: segment.position })
				: t("jobDetail.chainConcat", { position: segment.position });
		default: {
			// Exhaustive: a new segment kind must be given copy, not silently blanked.
			const exhaustive: never = segment;
			return String(exhaustive);
		}
	}
}

/**
 * What a prior probe found, as a passive one-line summary — container, duration,
 * and each stream's codec (design: "inline summary chips"). Renders NOTHING
 * unless a FINISHED inspection of exactly this object already exists: the read
 * is free (it is our own row), but a card must not look inspected when nobody
 * ever inspected it, and it must never trigger a probe by itself — the bounded
 * ffprobe read is the button's explicit action .
 */
function InspectChips({ target }: { target: InspectTarget }) {
	const latest = useQuery({
		// The DIALOG's key, not a private copy: two keys over one URL left these
		// chips permanently stale — the dialog refreshed its entry, nothing
		// invalidated the copy, and the card looked uninspected until a full page
		// load (stack review, I2). One fact, one cache entry; the dialog
		// invalidates it when a probe reaches a terminal state.
		queryKey: latestInspectionKey(target),
		queryFn: () => {
			const params = new URLSearchParams({
				credentialId: target.credentialId,
				bucket: target.bucket,
				objectKey: target.objectKey,
			});
			return apiFetch<{ latest: StorageInspectionDto | null }>(
				`/api/storage-inspections?${params}`,
			);
		},
		retry: false,
	});
	const row = latest.data?.latest;
	if (row?.status !== "FINISHED") {
		return null;
	}
	const summary = summarizeProbe(row.probe);
	if (!summary) {
		return null;
	}
	const parts = [
		summary.formatName,
		summary.duration,
		...summary.streams.map((stream) =>
			[stream.codecName, stream.resolution].filter(Boolean).join(" "),
		),
	].filter((part): part is string => Boolean(part));
	if (parts.length === 0) {
		return null;
	}
	return (
		<div className="mt-1 font-mono text-[11px] text-zinc-500">
			{parts.join(" · ")}
		</div>
	);
}

export function InputFilesPanel({
	files,
	credentialRefs,
}: {
	files: InputFileSummary[];
	credentialRefs: Record<string, { label: string; provider: string }>;
}) {
	const { t } = useT();
	// One dialog for the whole panel, keyed by the card whose button opened it.
	const [inspecting, setInspecting] = useState<InspectTarget | null>(null);
	if (files.length === 0) {
		return null;
	}
	return (
		<section aria-labelledby="input-files-heading" className="mt-8">
			<h2
				id="input-files-heading"
				className="font-medium text-sm text-zinc-200"
			>
				{t("jobDetail.inputFiles")}
			</h2>
			<ul className="mt-2 space-y-2">
				{files.map((file) => {
					const ref =
						file.credentialId !== undefined
							? credentialRefs[file.credentialId]
							: undefined;
					// HTTPS is the one credential-less input kind — there is nothing
					// to sign a storage read with, so no Inspect and no chips (the
					// design's own carve-out, same reason it has no credential row).
					const target: InspectTarget | null =
						file.credentialId !== undefined
							? {
									credentialId: file.credentialId,
									bucket: file.location,
									objectKey: file.inputPath,
								}
							: null;
					return (
						<li
							key={`${file.inputKey}:${file.inputPath}`}
							className="rounded-md border border-zinc-800 px-3 py-2"
						>
							<div className="flex flex-wrap items-center gap-2">
								<Badge className="font-mono">{file.kind}</Badge>
								<span className="min-w-0 break-all font-mono text-xs text-zinc-500">
									{file.inputKey}
								</span>
								{file.credentialId !== undefined ? (
									<span className="text-xs text-zinc-500">
										{ref
											? `${ref.label} (${ref.provider})`
											: t("jobDetail.deletedCredential")}
									</span>
								) : null}
								{target ? (
									<RoleAccess control="vod.job.input-inspect">
										<Button
											variant="secondary"
											size="sm"
											className="ml-auto"
											onClick={() => setInspecting(target)}
										>
											{t("storage.inspect")}
										</Button>
									</RoleAccess>
								) : null}
							</div>
							{target ? <InspectChips target={target} /> : null}
							{/* The full addressable path, copyable — an operator checking a
							    source pastes this into a CLI, so it must be one string. */}
							<div className="mt-1">
								<CopyableId
									value={
										file.location
											? `${file.location}/${file.inputPath}`
											: file.inputPath
									}
								/>
							</div>
							<ul className="mt-1 space-y-0.5">
								{file.consumers.map((consumer) => (
									<li
										key={JSON.stringify(consumer.chain)}
										className="text-xs text-zinc-400"
									>
										{/*
										 * DATA-FLOW order: the chain is reversed so it reads from
										 * this card's own subject (the file) INTO the renditions it
										 * feeds, with one glyph meaning "feeds" throughout.
										 *
										 * Core returns the chain outermost-first, which reads as "how
										 * does this rendition reach the file" — a real framing, but on
										 * a card headed by the file it starts far from the header and
										 * leaves the rendition names stranded at the far end with no
										 * glyph at all. Reversing here is a one-line rendering choice
										 * precisely because the segments are structured rather than a
										 * formatted string (review preference, and the reason the
										 * string was structured in the first place).
										 */}
										<span className="text-zinc-600">
											{[...consumer.chain]
												.reverse()
												.map((segment) => formatSegment(segment, t))
												.join(" → ")}
										</span>{" "}
										→{" "}
										{consumer.renditionKeys.length > 0
											? consumer.renditionKeys.join(", ")
											: t("jobDetail.readByEncoding")}
									</li>
								))}
							</ul>
						</li>
					);
				})}
			</ul>
			<RoleAccess control="vod.job.input-inspect">
				<InspectDialog
					target={inspecting}
					onClose={() => setInspecting(null)}
				/>
			</RoleAccess>
		</section>
	);
}
