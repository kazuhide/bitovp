"use client";

import { useEffect, useRef } from "react";
import { focusLiveSection } from "./section-focus";
import type { LiveSectionId } from "./section-layout";

/**
 *  — the two focus handoffs that are not a click.
 *
 * Both are null-rendering components rather than hooks inside `ChannelDetail`,
 * and that is not a style choice: the page returns a skeleton until three
 * queries settle, so anything expressed as a hook up there would have to run
 * before the sections it wants to focus exist, and would then need its own
 * "has the body rendered yet" gate. Mounting the effect WITH the body makes
 * "the DOM is here" a fact about where the component sits instead of a
 * condition it has to re-derive.
 */

/**
 * A deep link — `/live/{id}#sec-alerts`, the URL an operator pastes into an
 * incident channel — and every later `hashchange`.
 *
 * On arrival the browser scrolls the fragment into view and leaves focus on the
 * body, so a screen-reader user who followed the link hears the top of the page
 * and has to hunt for what they were sent. This moves the caret to the target's
 * heading; the heading's own text is the announcement (`section-focus.ts`).
 *
 * The `hashchange` listener is NOT a fallback for the in-page links — it is the
 * mechanism that actually delivers focus for most of their clicks. Every jump
 * anchor (a rail entry, the next-action CTA, the header's Programme cell) calls
 * `jumpToLiveSection` on click, and on a CHANGED fragment Blink then runs the
 * anchor's default action and clears the focus that helper just set
 * (review-366 I1). What restores it is this listener. The click handler is
 * decisive only on a SAME-fragment click, where it cancels the default because
 * no `hashchange` will fire.
 *
 * It also covers hashes no component of ours produces: a browser Back to a
 * previous fragment, or one typed into the address bar.
 */
export function DeepLinkFocus() {
	useEffect(() => {
		const focusFromHash = () => {
			const hash = window.location.hash.slice(1);
			if (hash.length > 0) {
				focusLiveSection(hash);
			}
		};
		focusFromHash();
		window.addEventListener("hashchange", focusFromHash);
		return () => window.removeEventListener("hashchange", focusFromHash);
	}, []);
	return null;
}

/**
 * An ESCALATION that opens a section — a CRITICAL alert, a FAILED provisioning
 * step — hands focus to that section's heading, ONCE.
 *
 * The three rules, in the order they matter:
 *
 *  1. **Never on mount.** A page that loads with an alert already open has not
 *     revealed anything; the section is simply rendered open, and stealing the
 *     caret from an operator who just navigated here would be the defect §5.6
 *     asks us to fix, pointed the other way. The first effect run records the
 *     baseline and moves nothing.
 *  2. **Once per section, one-way.** The `seen` set is never cleared, so an
 *     alert that opens, resolves and re-opens focuses on its first crossing
 *     only. This mirrors `SectionCard`'s own one-way open — the component that
 *     has already failed twice by acting under the operator ( →
 *     review-234) — because a focus jump is a strictly louder version of the
 *     same interruption.
 *  3. **One per tick.** Two escalations arriving on the same poll produce one
 *     move, to the first in the caller's order; the second is recorded as seen
 *     without a jump, because a caret that lands somewhere and immediately
 *     leaves has told the operator nothing.
 */
export function RevealFocus({
	revealed,
}: {
	/** Sections an escalation is opening RIGHT NOW, in priority order. */
	revealed: readonly LiveSectionId[];
}) {
	const seenRef = useRef<Set<string> | null>(null);
	const key = revealed.join(" ");
	useEffect(() => {
		const ids = key.split(" ").filter(Boolean);
		if (seenRef.current === null) {
			seenRef.current = new Set(ids);
			return;
		}
		const seen = seenRef.current;
		const fresh = ids.filter((id) => !seen.has(id));
		for (const id of ids) {
			seen.add(id);
		}
		const first = fresh[0];
		if (first !== undefined) {
			focusLiveSection(first);
		}
	}, [key]);
	return null;
}
