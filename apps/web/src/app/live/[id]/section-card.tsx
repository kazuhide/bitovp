"use client";

import { ChevronRight } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { HelpOverlay } from "@/components/ui/help-overlay";
import { InfoHint } from "@/components/ui/info-hint";

/**
 * Choose the control that presents title-level help.
 *
 * One sentence → `InfoHint` (hover + keyboard focus + tap; the body is the
 * trigger's accessible description). Two or more → `HelpOverlay` (click/tap
 * + Enter/Space; Escape closes and returns focus to the trigger). A sentence
 * is counted by its terminator (。．.!?！？); a single sentence past 100 code
 * points is treated as long too, because the hint box is one line wide.
 */
export function helpKind(text: string): "short" | "long" {
	const terminators = text.match(/[。．.!?！？]/g)?.length ?? 0;
	return terminators >= 2 || [...text].length >= 100 ? "long" : "short";
}

/* The help control accessible name includes the section title so screen-reader users know what it explains before opening it. */
export function SectionHelp({ title, help }: { title: string; help: string }) {
	return helpKind(help) === "short" ? (
		<InfoHint text={help} labelFor={title} />
	) : (
		<HelpOverlay labelFor={title}>{help}</HelpOverlay>
	);
}

/* A collapsed section retains a live summary. Native details provides keyboard and screen-reader behavior. Local open state follows defaultOpen only toward opening: changing lifecycle hints must not close an operator-opened section, while a critical alert arriving after initial load must still open its section. */
export function SectionCard({
	id,
	title,
	summary,
	help,
	tone = "neutral",
	defaultOpen = false,
	level = 2,
	children,
	onOpenChange,
}: {
	id: string;
	title: string;
	/** One live line, shown while closed AND while open. Never a placeholder. */
	summary?: ReactNode;
	/* Keep technical terms in secondary help, with an operator-readable title and summary. */
	help?: string;
	/** Colours the summary only — the title stays legible in every state. */
	tone?: "neutral" | "ok" | "warn" | "error";
	defaultOpen?: boolean;
	/** `h3` within body layers; `h4` within delivery-status lane cards. */
	level?: 2 | 3 | 4;
	children: ReactNode;
	onOpenChange?: (open: boolean) => void;
}) {
	const Heading = level === 4 ? "h4" : level === 3 ? "h3" : "h2";
	const summaryTone =
		tone === "ok"
			? "text-emerald-400"
			: tone === "warn"
				? "text-amber-400"
				: tone === "error"
					? "text-red-400"
					: "text-zinc-500";
	const [open, setOpen] = useState(defaultOpen);
	// One-directional: becoming the answer opens the card; ceasing to be it
	// does NOT close it (review-234's refinement — closing under the operator
	// is the defect this whole component has now failed twice).
	useEffect(() => {
		if (defaultOpen) {
			setOpen(true);
		}
	}, [defaultOpen]);
	useEffect(() => {
		onOpenChange?.(open);
	}, [open, onOpenChange]);
	return (
		<details
			id={id}
			open={open}
			onToggle={(event) => setOpen(event.currentTarget.open)}
			className="group scroll-mt-6 rounded-md border border-zinc-800 bg-zinc-900/40 open:bg-zinc-900/60"
		>
			<summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 hover:bg-zinc-800/50">
				<ChevronRight
					aria-hidden
					className="h-3.5 w-3.5 shrink-0 text-zinc-500 transition-transform group-open:rotate-90"
				/>
				{/* A heading inside the summary (review-260 126-A3): FlatSection
				 * made 13 sections heading-navigable; without this the two folds
				 * silently vanish from that navigation.
				 *
				 * gave it the `${id}-h` id and `tabIndex={-1}` its flat
				 * sibling already needed, so a jump lands on the same thing in
				 * both frames. Inside `<summary>` it is always rendered, open or
				 * closed, so a rail link to a CLOSED section still hands focus
				 * to a visible heading — and the operator can open it with the
				    Enter their focus is now one Tab away from. */}
				<Heading
					id={`${id}-h`}
					tabIndex={-1}
					className="font-medium text-sm text-zinc-200 outline-hidden focus-visible:ring-2 focus-visible:ring-zinc-400"
				>
					{title}
				</Heading>
				{help ? <SectionHelp title={title} help={help} /> : null}
				{summary ? (
					<span className={`ml-auto truncate text-xs ${summaryTone}`}>
						{summary}
					</span>
				) : null}
			</summary>
			<div className="border-zinc-800 border-t px-3 py-3">{children}</div>
		</details>
	);
}
