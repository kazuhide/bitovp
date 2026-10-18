"use client";

import { type ReactNode, useId, useState } from "react";
import { Button } from "@/components/ui/button";

/**
 * : the one-line progressive disclosure for RARE AUTHORING inside an
 * otherwise-readable section.
 *
 * Audit 4403130 §5.4 named the shape to copy — the feeder panel already
 * "shows session/status and toggles only the creation form"
 * (`feeder-panel.tsx`) — and §5.6 named what that toggle was missing:
 * `aria-expanded` / `aria-controls`. This component is that pattern with the
 * ARIA wired in, so every rare form on the page (arm a schedule, edit the
 * runtime cap, add an alert rule, read the schedule history, list every
 * manifest URL) discloses the same way and announces the same way.
 *
 * Why not `<details>`: `SectionCard` already owns that, one level up, for the
 * SECTION. Nesting a second `<details>` inside an open one reads to a screen
 * reader as two peer groups with no relationship to the control that opened
 * them; a button that OWNS its region via `aria-controls` says which content
 * appeared. The two mechanisms are deliberately at different levels.
 *
 * The controlled region is always in the DOM (`hidden` when closed) so
 * `aria-controls` never dangles, but its children mount only while open — the
 * runtime-cap disclosure holds a cost estimate that issues its own query, and
 * a closed disclosure must not pay for it.
 */
export function Disclosure({
	id,
	label,
	closeLabel,
	defaultOpen = false,
	onOpenChange,
	children,
}: {
	/** Stable id for tests and deep links; the region's id derives from it. */
	id: string;
	/** The trigger's text while CLOSED — a verb, e.g. "Schedule an action". */
	label: string;
	/** The trigger's text while OPEN. */
	closeLabel: string;
	defaultOpen?: boolean;
	/**
	 * Observe the toggle (C36 slate form): a parent whose behaviour depends
	 * on WHICH form is showing — the picked file or the advanced fields —
	 * reads the state from here instead of guessing it from the DOM.
	 */
	onOpenChange?: (open: boolean) => void;
	children: ReactNode;
}) {
	const [open, setOpen] = useState(defaultOpen);
	// useId keeps two disclosures with the same `id` prop (two channels in one
	// test render, a future multi-panel view) from colliding on the region id.
	const uid = useId();
	const regionId = `${id}-region${uid}`;
	return (
		<div data-disclosure={id} className="mt-3">
			<Button
				type="button"
				variant="secondary"
				size="sm"
				aria-expanded={open}
				aria-controls={regionId}
				onClick={() => {
					const next = !open;
					setOpen(next);
					onOpenChange?.(next);
				}}
			>
				{open ? closeLabel : label}
			</Button>
			<div id={regionId} hidden={!open} className="mt-3">
				{open ? children : null}
			</div>
		</div>
	);
}
