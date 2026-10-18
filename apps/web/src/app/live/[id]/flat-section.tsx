import type { ReactNode } from "react";
import { SectionHelp } from "./section-card";

/* Always-open counterpart of SectionCard, retaining its heading, live summary, border, and section anchor. It allows direct navigation to operational information without requiring a disclosure click. */
export function FlatSection({
	id,
	title,
	summary,
	help,
	tone = "neutral",
	level = 2,
	children,
}: {
	id: string;
	title: string;
	/** One live line, right of the heading. Never a placeholder. */
	summary?: ReactNode;
	/**
	 * the same title-level help `SectionCard` carries,
	 * because the input endpoint is HOISTED into this frame before air — the
	 * one phase where an operator most needs to know what the section is.
	 */
	help?: string;
	/** Colours the summary only — the title stays legible in every state. */
	tone?: "neutral" | "ok" | "warn" | "error";
	/**
	 * the page grew a LAYER above the section (Operations,
	 * Programme, …), each an `h2`, so a section nested in one is an `h3`. The
	 * default stays `h2` for the phase leads, which sit directly under the
	 * page title with no layer between them. The landmark itself is unchanged
	 * — a VISIBLE heading names it either way, which is the property #126
	 * bought when it replaced `<summary>` with this frame.
	 */
	level?: 2 | 3;
	children: ReactNode;
}) {
	const Heading = level === 3 ? "h3" : "h2";
	const summaryTone =
		tone === "ok"
			? "text-emerald-400"
			: tone === "warn"
				? "text-amber-400"
				: tone === "error"
					? "text-red-400"
					: "text-zinc-500";
	return (
		<section
			id={id}
			// aria-labelledby, not aria-label (review-260 #126 prep): the
			// visible h2 names the landmark AND stays in the screen reader's
			// heading navigation — the two things <details>/<summary> used to
			// provide natively.
			aria-labelledby={`${id}-h`}
			className="scroll-mt-6 rounded-md border border-zinc-800 bg-zinc-900/40"
		>
			<div className="flex items-center gap-2 border-zinc-800 border-b px-3 py-2">
				<Heading
					id={`${id}-h`}
					// : the jump target. Audit §5.6 measured the gap — the
					// next-action pointer scrolled here and this frame was not
					// focusable, so a keyboard or screen-reader operator was told
					// nothing about where the page had gone. `-1` keeps it out of
					// the Tab sequence (it is not a control) while making
					// `focus` real; the heading's own text is the announcement.
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
			</div>
			<div className="px-3 py-3">{children}</div>
		</section>
	);
}
