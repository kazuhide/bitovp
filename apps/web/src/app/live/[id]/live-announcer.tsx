"use client";

import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useRef,
	useState,
} from "react";
import { useT } from "@/lib/i18n/context";
import {
	type LiveStatusSignal,
	liveStatusAnnouncements,
} from "./status-announce";

/**
 * The live channel page's ONE polite live region, and the change detection that
 * keeps it quiet. Row 251.
 *
 * The row number is written WITHOUT its `#` in this file alone, and that is not
 * a style slip: `ledger-references.test.ts`'s POINTER regex matches the word
 * `status` as well as `ledger`, within about sixty characters of a hash plus
 * digits, so the `./status-announce` import a few lines up turns a hashed row
 * number here into a citation of a registry row — and every citation must
 * resolve to a real one. (Two drafts of this very note put the hashed form back
 * inside the explanation and re-tripped the guard.)
 *
 * Audit 4403130 §5.6: the StatusStrip's material changes (ingest disconnects,
 * the heartbeat goes stale) and the schedule/action success notices are visible
 * and nothing else — a screen-reader operator watching a running channel is
 * told none of it. Open alerts already carry `role="alert"` and keep it (§5.8's
 * keep-list); this region is for everything that is not an alert.
 *
 * The hard part is not the region, it is the NOISE. The page polls every 15s
 * (5s while transitional) and re-renders on each tick, so a region fed from
 * render would read the ingest state aloud four times a minute forever. Two
 * rules, and both are load-bearing:
 *
 *  1. **Announce on CHANGE, never on value.** `status-announce.ts` compares the
 *     previous sample with the next one and returns nothing at all when they
 *     agree. A poll that changes nothing is silent by construction, which is
 *     what makes this safe to leave on during an incident.
 *  2. **At most one announcement per signal per `ANNOUNCE_MIN_INTERVAL_MS`.** A
 *     flapping value — the exact case an operator most needs to hear once and
 *     least needs to hear twenty times — is coalesced: the first crossing
 *     speaks immediately, and anything inside that signal's window is held and
 *     replaced, so what is finally read is the LATEST state rather than a queue
 *     of stale ones.
 *
 *     PER SIGNAL, and the first cut was not (review-366 S1). One window and one
 *     hold slot for the whole page meant a held "Heartbeat has gone stale."
 *     was silently overwritten by whatever arrived next — an unrelated ingest
 *     change, or an action confirmation — and was then never spoken at all.
 *  3. **An operator's own confirmation never waits.** `announce` with no
 *     signal is a direct consequence of a click ("Stop encoder accepted."), so
 *     it is spoken immediately and takes no slot. Holding it behind a status
 *     window could delay the answer to a button press by the full 8 s, which is
 *     long enough for an operator to press it again.
 */

/**
 * The coalescing window. 8s is long enough to swallow a heartbeat flapping on
 * the sweep's 30s cadence when it lands either side of a poll, and short enough
 * that a real disconnect during an incident is spoken while it still matters.
 * ONE constant: the trailing timer and the "speak now" test read the same
 * number, so there is no second threshold to drift.
 */
export const ANNOUNCE_MIN_INTERVAL_MS = 8_000;

/**
 * The default is a NO-OP, not a throw.
 *
 * `useT` throws outside its provider on purpose (a missing locale would
 * render English silently), but an announcement is an enhancement: a panel
 * rendered on its own in a unit test, or embedded on some future screen without
 * this provider, must keep working rather than crash for want of a region to
 * speak into.
 */
const AnnounceContext = createContext<Announce>(() => {});

/**
 * Announce one already-localised sentence, politely.
 *
 * `signal` groups announcements that describe the SAME thing changing, so they
 * coalesce against each other and against nothing else. Omit it for anything an
 * operator just caused: those are spoken immediately (rule 3).
 */
export type Announce = (message: string, signal?: string) => void;

export function useAnnounce(): Announce {
	return useContext(AnnounceContext);
}

export function LiveAnnouncer({ children }: { children: ReactNode }) {
	const [message, setMessage] = useState("");
	// One window, one hold slot and one timer PER SIGNAL. Three Maps rather than
	// one Map of records because each is read on a different path and an empty
	// Map is the honest "nothing yet" for all three.
	const lastAtRef = useRef(new Map<string, number>());
	const pendingRef = useRef(new Map<string, string>());
	const timersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());

	useEffect(() => {
		const timers = timersRef.current;
		return () => {
			for (const timer of timers.values()) {
				clearTimeout(timer);
			}
			timers.clear();
		};
	}, []);

	const announce = useCallback((next: string, signal?: string) => {
		// Rule 3: an operator's own confirmation is spoken now and holds no slot.
		if (signal === undefined) {
			setMessage(next);
			return;
		}
		const now = Date.now();
		const since = now - (lastAtRef.current.get(signal) ?? 0);
		if (since >= ANNOUNCE_MIN_INTERVAL_MS) {
			lastAtRef.current.set(signal, now);
			setMessage(next);
			return;
		}
		// Inside THIS signal's window: hold the LATEST for it and let its own
		// timer deliver it. Replacing rather than queueing is the point — three
		// flaps of one value inside a window are one announcement of where that
		// value ended up — and keying the slot is what stops a different
		// signal's message from being that replacement (review-366 S1).
		pendingRef.current.set(signal, next);
		if (!timersRef.current.has(signal)) {
			timersRef.current.set(
				signal,
				setTimeout(() => {
					timersRef.current.delete(signal);
					const held = pendingRef.current.get(signal);
					pendingRef.current.delete(signal);
					if (held !== undefined) {
						lastAtRef.current.set(signal, Date.now());
						setMessage(held);
					}
				}, ANNOUNCE_MIN_INTERVAL_MS - since),
			);
		}
	}, []);

	return (
		<AnnounceContext.Provider value={announce}>
			{/*
			    In the DOM from the first render, empty. A live region CREATED at
			    announce time is routinely missed: the assistive technology has to
			    be observing the node before its content changes.

			    Known limit: two IDENTICAL consecutive messages produce no DOM
			    change and so are read once. That is right for a state that did
			    not change and wrong for the same action succeeding twice; the
			    honest fix is a second alternating region, which is more machinery
			    than the case has earned so far.
			*/}
			<p
				role="status"
				aria-live="polite"
				aria-atomic="true"
				data-live-announcer
				className="sr-only"
			>
				{message}
			</p>
			{children}
		</AnnounceContext.Provider>
	);
}

/**
 * Feeds the region from the StatusStrip's own values.
 *
 * Null-rendering, and mounted with the BODY rather than expressed as a hook in
 * `ChannelDetail`: the page returns a skeleton until three queries settle, so a
 * hook up there would take its baseline from the loading state and announce the
 * whole strip the moment the data arrived. Mounting here makes the first real
 * sample the baseline, which is why an operator opening a disconnected channel
 * is told nothing — the disconnect is what the page already SAYS.
 *
 * The comparison itself lives in `status-announce.ts`, one pure function.
 */
export function StatusAnnouncer({ signal }: { signal: LiveStatusSignal }) {
	const { t } = useT();
	const announce = useAnnounce();
	const previousRef = useRef<LiveStatusSignal | null>(null);
	/**
	 * The dependency is the OBJECT, which `ChannelDetail` rebuilds on every
	 * poll — so this effect runs four times a minute on a quiet channel, on
	 * purpose.
	 *
	 * A serialised-values key would memoise the whole comparison away and make
	 * the page silent whether or not `liveStatusAnnouncements` still compares
	 * anything: the guard would be in two places and only one of them
	 * observable. Running every poll leaves exactly ONE guard, the pure
	 * function, and a test that re-renders with an unchanged sample is then a
	 * real assertion about it rather than about React's memoisation.
	 */
	useEffect(() => {
		const previous = previousRef.current;
		previousRef.current = signal;
		if (previous === null) {
			return;
		}
		for (const announcement of liveStatusAnnouncements(previous, signal)) {
			// The SIGNAL, not the message key: an ingest that goes down and back
			// up produces two different message keys for one flapping value, and
			// they have to share a hold slot (review-366 S1).
			announce(t(announcement.key, announcement.values), announcement.signal);
		}
	}, [signal, announce, t]);
	return null;
}
