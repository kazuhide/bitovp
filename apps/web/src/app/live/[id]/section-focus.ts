/* Move focus to the target heading after navigation so keyboard and screen-reader users reach the same section as sighted users. Explicit scrolling and shared scroll margins keep the focused heading visible. */

/**
 * The element a jump to `targetId` should leave the caret on:
 *
 *  - `${targetId}-h`, the visible heading, for every `sec-*` section and every
 *    `layer-*` landmark (both frames stamp it);
 *  - the target itself as a fallback, which exists for exactly one id —
 *    `sec-actions`, the header's lifecycle controls. It is an `aria-label`led
 *    region with no heading of its own ( moved Start/Stop into the
 *    page header), and it is the busiest jump target on the page: five of the
 *    twelve next-action codes point at it.
 *
 * The fallback only works because that region carries `tabIndex={-1}`:
 * `focus` on an element with no tabindex is a silent no-op, which is the
 * shape of bug this whole function exists to remove.
 */
export function focusLiveSection(targetId: string): boolean {
	if (typeof document === "undefined") {
		return false;
	}
	const target =
		document.getElementById(`${targetId}-h`) ??
		document.getElementById(targetId);
	if (!(target instanceof HTMLElement)) {
		return false;
	}
	target.focus({ preventScroll: false });
	// Not `document.activeElement === target`: jsdom and browsers agree that a
	// focus on a non-focusable element leaves the body focused, and reporting
	// "I moved it" in that case is how the no-op above stayed invisible.
	return document.activeElement === target;
}

/**
 * The bit of a click event this module needs.
 *
 * Structurally typed rather than `React.MouseEvent`: this file is
 * framework-free, and every caller has an event with this much of one. Both
 * `onJump` props take the same shape so a widening here is a compile error at
 * the call sites rather than a silently narrower contract.
 */
export type LiveJumpEvent = {
	preventDefault(): void;
	readonly metaKey: boolean;
	readonly ctrlKey: boolean;
	readonly shiftKey: boolean;
	readonly altKey: boolean;
};

/**
 * What an in-page LINK to a section must do on click — the rail's entries, the
 * next-action CTA, the header's Programme cell.
 *
 * Calling `focusLiveSection` from a click handler is not enough, and
 * review-366 I1 measured why in Chrome: the handler runs, and THEN the anchor's
 * default action runs. Blink focuses the fragment target if it is focusable and
 * otherwise CLEARS the focused element — so the focus we just set is undone.
 *
 * On a CHANGED fragment that does not matter: the navigation fires
 * `hashchange`, and `DeepLinkFocus` puts the caret back on the heading. On a
 * SAME fragment — the operator who scrolled away from the alerts and takes the
 * pointer back — the URL does not change, so no `hashchange` is fired and
 * nothing rescues it. Focus ends on `<body>`.
 *
 * (One target hid this for a while: `sec-actions` is itself `tabIndex={-1}`, so
 * Blink's default action lands on the very element we wanted. Every other jump
 * target is a `<section>`/`<details>` whose HEADING is the focusable thing.)
 *
 * So: cancel the default exactly when there is no navigation to perform, do the
 * scroll ourselves, and then focus. `preventDefault` on the changed-fragment
 * path would be wrong — it would drop the hash from the URL, and the hash is
 * what makes a jump shareable and survivable across a Back.
 */
export function jumpToLiveSection(
	event: LiveJumpEvent,
	targetId: string,
): boolean {
	// A MODIFIER click is a request for a NEW tab or window, not a jump within
	// this one (review-366 S-A). Cancelling it swallowed ⌘/Ctrl-click "open in
	// new tab" on any rail entry whose fragment was already current — and it
	// swallowed it silently, because the same-fragment branch is exactly the
	// one that calls `preventDefault`. Focus stays where the operator left it
	// too: nothing should move on a page they are about to leave open behind a
	// new one. (Middle-click is `auxclick`, which never reaches here.)
	if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
		return false;
	}
	if (
		typeof window !== "undefined" &&
		window.location.hash === `#${targetId}`
	) {
		event.preventDefault();
		// `focusLiveSection` scrolls too (`preventScroll: false`), but only when
		// it finds something focusable; this is what moves the page when it does
		// not. Optional-called because jsdom does not implement it.
		document.getElementById(targetId)?.scrollIntoView?.();
	}
	return focusLiveSection(targetId);
}
