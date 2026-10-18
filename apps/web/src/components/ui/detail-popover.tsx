"use client";

import { Popover as PopoverPrimitive } from "radix-ui";
import type { ReactNode } from "react";

/**
 * A CLICK-opened popover for detail that a summary hides — the answer to the
 * "34 observed" class of display (owner directive, 2026-08-12): a count or
 * label whose CONTENT exists in data must make that content reachable from
 * the same spot, without the ceremony of a full dialog.
 *
 * Click, not hover, deliberately: hover tooltips (InfoHint) are for one-line
 * explanations of a CONCEPT; this is for the DATA behind a summary — it must
 * be scrollable, selectable (copy a value out of it), and usable on touch.
 *
 * The trigger is a real button styled as the summary text with an affordance
 * (dotted underline), so "there is more here" is visible rather than a
 * secret.
 */
export function DetailPopover({
	summary,
	label,
	children,
}: {
	/** The collapsed text (e.g. "34 parameters") — becomes the trigger. */
	summary: ReactNode;
	/** Accessible name + heading for the opened panel. */
	label: string;
	children: ReactNode;
}) {
	return (
		<PopoverPrimitive.Root>
			<PopoverPrimitive.Trigger asChild>
				{/* NO aria-label here: it would REPLACE the visible summary as the
				    accessible name — a screen reader lost the dashboard card's
				    number entirely, and voice control ("click 2 settings") failed
				    at every site (review of PR #169, C1 / WCAG 2.5.3). The summary
				    IS the name; the label names the opened panel below. */}
				<button
					type="button"
					className="cursor-pointer rounded-sm text-left underline decoration-dotted decoration-zinc-600 underline-offset-2 hover:text-zinc-200 hover:decoration-zinc-400 focus-visible:outline-2 focus-visible:outline-emerald-500 focus-visible:outline-offset-2"
				>
					{summary}
				</button>
			</PopoverPrimitive.Trigger>
			<PopoverPrimitive.Portal>
				<PopoverPrimitive.Content
					aria-label={label}
					side="bottom"
					align="start"
					sideOffset={6}
					collisionPadding={12}
					className="z-50 max-h-80 w-max min-w-56 max-w-md overflow-y-auto rounded-md border border-zinc-700 bg-zinc-900 p-3 text-xs shadow-xl"
				>
					<div className="mb-2 font-medium text-[11px] text-zinc-400 uppercase tracking-wide">
						{label}
					</div>
					{children}
				</PopoverPrimitive.Content>
			</PopoverPrimitive.Portal>
		</PopoverPrimitive.Root>
	);
}

/**
 * The standard body for a DetailPopover over a record: key → value rows,
 * values mono and selectable. Nested objects/arrays render as compact JSON —
 * visible beats pretty, and a value an operator can copy beats both.
 */
export function KeyValueRows({
	record,
	sort = true,
}: {
	record: Record<string, unknown>;
	/** Insertion order matters for sequences (leg 1 … leg N) — localeCompare
	    scrambled them to 1, 10, 11, 2 (review of PR #169, I5). */
	sort?: boolean;
}) {
	const entries = sort
		? Object.entries(record).sort(([a], [b]) => a.localeCompare(b))
		: Object.entries(record);
	return (
		<dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
			{entries.map(([key, value]) => (
				<div key={key} className="contents">
					<dt className="text-zinc-500">{key}</dt>
					<dd className="select-all whitespace-pre-wrap break-all font-mono text-zinc-200">
						{typeof value === "string"
							? value
							: typeof value === "number" || typeof value === "boolean"
								? String(value)
								: JSON.stringify(value)}
					</dd>
				</div>
			))}
		</dl>
	);
}
