"use client";

import { useId } from "react";
import { CopyableId } from "@/components/copyable-id";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { useT } from "@/lib/i18n/context";

export type ResourceIdCandidate = {
	/** The id the form actually submits. */
	id: string;
	/** Human-identifiable name — never a bare UUID if anything better exists. */
	label: string;
	/** Secondary line telling two same-named candidates apart. */
	detail?: string;
	/** Status chip text (channel status, input type, …). */
	badge?: string;
	tone?: "neutral" | "ok" | "error";
};

/**
 * "Pick a Bitmovin resource, or paste an id" for a SINGLE-value form field —
 * the single-select sibling of `PrewarmedPoolPicker` (which owns a CSV of pool
 * ids).
 *
 * The free-text input IS the field: it carries the DOM id the caller's `Field`
 * labels, holds the value zod validates, and submits. The radio list only
 * writes into it. That ordering is deliberate — every candidate list here is
 * incomplete by construction (another Bitmovin org, a resource this app never
 * provisioned, a list call that 502s), so a picker that OWNED the value would
 * turn "an id I can read off the Bitmovin dashboard" into "an id I cannot
 * enter". Two consequences fall out for free: a preset value outside the list
 * is never cleared (nothing clears the input), and a failed list degrades at
 * worst to the form that shipped before the picker, with the reason on screen.
 * "At worst" because the failure is reported as a banner and `candidates` may
 * come from more than one query — see the comment on it below.
 */
export function ResourceIdPicker({
	inputId,
	value,
	onChange,
	candidates,
	isLoading,
	errorMessage,
	emptyMessage,
	listLabel,
	placeholder,
	truncatedMessage,
	copyLabel,
}: {
	/** DOM id of the free-text input — the caller's `Field htmlFor` target. */
	inputId: string;
	value: string;
	onChange: (value: string) => void;
	/** May merge several sources; `errorMessage` speaks for only one of them. */
	candidates: ResourceIdCandidate[];
	isLoading: boolean;
	/** Set when a list call failed — shown, so the fallback is explained. */
	errorMessage?: string;
	/** Copy for "the list loaded and is empty". */
	emptyMessage: string;
	/** Visible group label, e.g. "Inputs in this account". */
	listLabel: string;
	placeholder?: string;
	/** Set when the list is knowingly partial (route hit its page cap). */
	truncatedMessage?: string;
	/** CopyableId suffix, e.g. "input id". */
	copyLabel: string;
}) {
	const { t } = useT();
	const groupName = useId();
	const trimmed = value.trim();
	const pastedOutsideList =
		trimmed !== "" && !candidates.some((candidate) => candidate.id === trimmed);

	return (
		<div className="space-y-2">
			{/*
			 * A BANNER, not a replacement for the list. `candidates` may merge more
			 * than one source — the unassign dialog adds the encodings holding a
			 * stream key, read off an INDEPENDENT query — so an exclusive error
			 * branch would hide ids the app is still rendering on screen a layer
			 * behind. Whatever survived the failure stays pickable; the message
			 * explains what is missing from the list, not that there is no list.
			 */}
			{errorMessage ? (
				<p role="status" className="text-xs text-zinc-500">
					{t("uiX.pasteAnIdBelow", { message: errorMessage })}
				</p>
			) : null}
			{isLoading ? (
				<div
					role="status"
					aria-busy="true"
					aria-label={t("uiX.loadingList", { list: listLabel })}
					className="h-9 animate-pulse rounded-md bg-zinc-900"
				/>
			) : candidates.length > 0 ? (
				<fieldset>
					<legend className="text-xs text-zinc-500">{listLabel}</legend>
					<ul className="mt-1 max-h-40 space-y-1 overflow-y-auto rounded-md border border-zinc-800 p-2">
						{candidates.map((candidate) => (
							<li key={candidate.id} className="flex items-center gap-2">
								<label className="flex min-w-0 flex-1 items-center gap-2 text-sm text-zinc-300">
									<input
										type="radio"
										name={groupName}
										className="h-4 w-4 shrink-0 accent-emerald-600"
										value={candidate.id}
										checked={trimmed === candidate.id}
										onChange={() => onChange(candidate.id)}
									/>
									<span className="min-w-0 flex-1 truncate">
										{candidate.label}
										{candidate.detail ? (
											<span className="ml-2 text-xs text-zinc-500">
												{candidate.detail}
											</span>
										) : null}
									</span>
								</label>
								{candidate.badge ? (
									<Badge tone={candidate.tone}>{candidate.badge}</Badge>
								) : null}
								<CopyableId
									value={candidate.id}
									label={copyLabel}
									className="max-w-[10rem] shrink-0"
								/>
							</li>
						))}
					</ul>
					{truncatedMessage ? (
						<p className="mt-1 text-xs text-zinc-500">{truncatedMessage}</p>
					) : null}
				</fieldset>
			) : errorMessage ? null : (
				// Only when the list genuinely loaded empty: under an error banner
				// this copy would contradict the reason already on screen.
				//
				// PRECONDITION for suppressing it: the banner above ends with
				// "— paste an id below", and that instruction is hardcoded HERE
				// rather than supplied by the caller's `errorMessage`. If it is ever
				// trimmed to just the reason, or moved into each caller's message
				// string, then error + empty becomes a blank panel with no next step
				// — a silent dead end (review catch). Keep the instruction in this
				// component, or stop suppressing this copy.
				<p role="status" className="text-xs text-zinc-500">
					{emptyMessage}
				</p>
			)}

			<Input
				id={inputId}
				autoComplete="off"
				className="font-mono text-xs"
				placeholder={placeholder}
				value={value}
				onChange={(e) => onChange(e.target.value)}
			/>
			{pastedOutsideList && !isLoading ? (
				<p className="text-xs text-zinc-500">
					{t("ui.usingAPastedIdNotInThe")}
				</p>
			) : null}
		</div>
	);
}
