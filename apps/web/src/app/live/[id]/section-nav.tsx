"use client";

import { useEffect, useId, useState } from "react";
import type { MessageKey } from "@/lib/i18n";
import { useT } from "@/lib/i18n/context";
import { jumpToLiveSection } from "./section-focus";
import {
	LIVE_SECTION_TITLE_KEYS,
	type LiveLayerId,
	type LiveSectionId,
} from "./section-layout";

/* One anchor list serves the wide-screen rail and narrow-screen jump menu. Its sections come from LIVE_LAYERS, so page and navigation change together. Preserve native fragment navigation; only same-fragment clicks cancel the default action and focus directly, because they do not trigger hashchange. */
export function LiveSectionNav({
	layers,
}: {
	layers: readonly {
		id: LiveLayerId;
		titleKey: MessageKey;
		sections: readonly LiveSectionId[];
	}[];
}) {
	const { t } = useT();
	const [open, setOpen] = useState(false);
	const uid = useId();
	const listId = `live-section-nav${uid}`;
	const active = useActiveLiveSection(layers.flatMap((l) => l.sections));

	return (
		<nav
			aria-label={t("liveNav.regionLabel")}
			data-live-section-nav
			className="xl:sticky xl:top-6 xl:w-52 xl:shrink-0 xl:self-start"
		>
			{/*
			    The narrow-screen trigger. `xl:hidden` rather than a second
			    component: at `xl` the list is disclosed by the layout itself, so
			    the control has nothing to control and is removed from the
			    accessibility tree with the rest of its display. Its
			    `aria-expanded` therefore only ever describes the state a viewer
			    can actually see.
			*/}
			<button
				type="button"
				aria-expanded={open}
				aria-controls={listId}
				onClick={() => setOpen((v) => !v)}
				className="inline-flex items-center gap-1.5 rounded-md border border-zinc-800 bg-zinc-900/60 px-2.5 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100 xl:hidden"
			>
				{open ? t("liveNav.jumpToClose") : t("liveNav.jumpTo")}
			</button>
			<ul
				id={listId}
				data-live-section-list
				// The closed state is a CLASS, never the `hidden` ATTRIBUTE, and
				// the first cut of this rail got that wrong badly enough to ship
				// no rail at all (review-366 C1, measured in Chrome at 1512 px:
				// the trigger `display:none` as designed, and the list
				// `display:none` too — at every width ≥ xl).
				//
				// The reasoning that failed was "author declarations beat the UA
				// sheet's `[hidden]`". They do — but nothing here relies on the
				// UA sheet. `globals.css` does `@import "tailwindcss"`, whose
				// preflight declares
				// `[hidden]:where(:not([hidden='until-found'])) { display: none
				// !important }` in `@layer base` (tailwindcss 4.3.0,
				// `preflight.css`). A non-important `xl:block` cannot beat an
				// important declaration, and an important one would lose too:
				// important declarations resolve in REVERSE layer order, so base
				// outranks utilities. The attribute is unconditional here, and
				// `open` is only ever flipped by a trigger that is itself
				// `xl:hidden`.
				//
				// `display:none` from a class removes the links from the tab
				// order and the accessibility tree exactly as the attribute
				// would. What it does NOT do is outrank the breakpoint.
				className={`${open ? "block" : "hidden"} mt-2 space-y-3 rounded-md border border-zinc-800 bg-zinc-900/40 p-3 text-xs xl:mt-0 xl:block xl:max-h-[calc(100vh-4rem)] xl:overflow-y-auto`}
			>
				{layers.map((layer) => (
					<li key={layer.id}>
						<a
							href={`#${layer.id}`}
							onClick={(event) => {
								jumpToLiveSection(event, layer.id);
								setOpen(false);
							}}
							className="block rounded px-1.5 py-1 font-semibold text-[11px] text-zinc-400 uppercase tracking-wide hover:bg-zinc-800 hover:text-zinc-200"
						>
							{t(layer.titleKey)}
						</a>
						<ul className="mt-0.5 space-y-0.5 border-zinc-800 border-l pl-2">
							{layer.sections.map((sectionId) => {
								const current = sectionId === active;
								return (
									<li key={sectionId}>
										<a
											href={`#${sectionId}`}
											// The programmatic half of the highlight.
											// `location`, not `page`: these point inside
											// the document that is already open.
											aria-current={current ? "location" : undefined}
											onClick={(event) => {
												jumpToLiveSection(event, sectionId);
												setOpen(false);
											}}
											// Not colour alone (§5.8 keeps the page's
											// "status has a text value" property): the
											// current entry also gains a left marker and
											// a weight change, both visible in a
											// monochrome rendering.
											className={`-ml-2 block border-l-2 py-1 pl-2.5 hover:bg-zinc-800 hover:text-zinc-100 ${
												current
													? "border-emerald-400 font-medium text-zinc-100"
													: "border-transparent text-zinc-400"
											}`}
										>
											{t(LIVE_SECTION_TITLE_KEYS[sectionId])}
										</a>
									</li>
								);
							})}
						</ul>
					</li>
				))}
			</ul>
		</nav>
	);
}

/**
 * Which section the operator is LOOKING at, from one `IntersectionObserver`.
 *
 * Scroll-position arithmetic was the alternative and it is worse on this page:
 * the body is 5.7 viewports of sections whose heights change under a 15s poll
 * (a heartbeat chart grows, an alert list appears), so any cached offset table
 * is stale by the next tick and recomputing it per scroll event is layout
 * thrash on the one screen an operator watches during an incident.
 *
 * `rootMargin`'s bottom inset shrinks the viewport to its top 45%: without it
 * every section visible on a tall screen intersects at once and "current" would
 * mean "somewhere on screen". The winner is the FIRST id in table order that is
 * currently intersecting, so the answer follows the page's own hierarchy rather
 * than callback arrival order.
 *
 * When nothing intersects — scrolled past the last section, or a section
 * unmounted — the previous answer STANDS. Blanking the rail at the bottom of
 * the page would be a highlight that flickers off exactly where an operator
 * stops scrolling.
 */
export function useActiveLiveSection(ids: readonly string[]): string | null {
	const [active, setActive] = useState<string | null>(null);
	// The array is rebuilt every render, so the effect keys off its CONTENT.
	// Sections carry no spaces in their ids (they are `sec-*` literals), so a
	// join is a faithful encoding rather than a lossy one.
	const key = ids.join(" ");
	useEffect(() => {
		const order = key.split(" ").filter(Boolean);
		// jsdom has no IntersectionObserver, and neither does a server render.
		// The rail still works there — it is a list of anchors — it simply has
		// no "you are here".
		if (order.length === 0 || typeof IntersectionObserver === "undefined") {
			return;
		}
		const visible = new Set<string>();
		const observer = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					if (entry.isIntersecting) {
						visible.add(entry.target.id);
					} else {
						visible.delete(entry.target.id);
					}
				}
				const first = order.find((id) => visible.has(id));
				if (first !== undefined) {
					setActive(first);
				}
			},
			{ rootMargin: "0px 0px -55% 0px" },
		);
		for (const id of order) {
			const element = document.getElementById(id);
			if (element) {
				observer.observe(element);
			}
		}
		return () => observer.disconnect();
	}, [key]);
	return active;
}
