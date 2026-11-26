"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSession } from "./auth/use-session";
import {
	copiedJobDraftSlot,
	discardWizardDraft,
	draftIdentity,
	draftKey,
	projectWizardDraft,
	readWizardDraftRecord,
	type WizardDraft,
	type WizardDraftKind,
	writeWizardDraft,
} from "./wizard-draft";

import { withWizardDraftLock } from "./wizard-draft-lock";

function matchesDraft(
	slot: string,
	expected: string | null | undefined,
): boolean {
	try {
		return localStorage.getItem(slot) === expected;
	} catch {
		return false;
	}
}

export function useWizardDraft({
	kind,
	context,
	legacyCopiedJobId,
	value,
	step,
	onRestore,
}: {
	kind: WizardDraftKind;
	context: string | null;
	legacyCopiedJobId?: string;
	value: unknown;
	step: number;
	onRestore: (draft: WizardDraft) => void;
}) {
	const session = useSession();
	// A warm cache, background read or failed read cannot authorize storage.
	const cachedIdentity = draftIdentity(session.data);
	const identity =
		session.status === "success" &&
		session.isFetchedAfterMount &&
		session.fetchStatus !== "paused" &&
		!session.isFetching
			? cachedIdentity
			: null;
	const identityKey = identity ? JSON.stringify(identity) : null;
	const boundIdentity = useRef<string | null>(null);
	if (identityKey && !boundIdentity.current)
		boundIdentity.current = identityKey;
	// Never migrate a mounted user's form to another user's/organization's draft.
	const canonicalKey =
		identity && identityKey === boundIdentity.current && context !== null
			? draftKey(identity, kind, context)
			: null;
	const [copySlot, setCopySlot] = useState<{
		canonicalKey: string;
		key: string;
	}>();
	const key = legacyCopiedJobId
		? copySlot?.canonicalKey === canonicalKey
			? copySlot.key
			: null
		: canonicalKey;
	useEffect(() => {
		if (!legacyCopiedJobId || !canonicalKey || !identityKey) return;
		let slot = canonicalKey;
		try {
			slot = copiedJobDraftSlot(
				JSON.parse(identityKey),
				legacyCopiedJobId,
				canonicalKey,
				localStorage,
			);
		} catch {
			// The browser can deny even access to the storage object.
		}
		setCopySlot((current) =>
			current?.canonicalKey === canonicalKey
				? current
				: { canonicalKey, key: slot },
		);
	}, [legacyCopiedJobId, canonicalKey, identityKey]);
	const currentKey = useRef(key);
	currentKey.current = key;
	// An in-flight submission may finish while the same bound user refreshes.
	// This scope is used only for completing that submission's local draft.
	const completionKey = useRef<string | null>(null);
	const completionContext =
		session.status === "success" &&
		cachedIdentity &&
		JSON.stringify(cachedIdentity) === boundIdentity.current &&
		context !== null
			? draftKey(cachedIdentity, kind, context)
			: null;
	completionKey.current = legacyCopiedJobId
		? copySlot?.canonicalKey === completionContext
			? copySlot.key
			: null
		: completionContext;
	const mounted = useRef(false);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);
	const completed = useRef<string | null>(null);
	const observed = useRef(new Map<string, string | null>());
	const accepted = useRef(new Map<string, string | null>());
	const lastWritten = useRef(
		new Map<string, { form: string; record: string }>(),
	);
	const initialized = useRef<string | null>(null);
	const unchanged = useCallback(
		(slot: string) => matchesDraft(slot, observed.current.get(slot)),
		[],
	);
	const [loaded, setLoaded] = useState<{
		key: string;
		writeKey: string;
		pendingKey: string;
		retained: WizardDraft | null;
		pending: WizardDraft | null;
		baseline: string;
	}>();
	const latest = useRef<typeof loaded>(undefined);
	const present = useCallback((next: NonNullable<typeof loaded>) => {
		latest.current = next;
		setLoaded(next);
	}, []);
	const offerChangedDraft = useCallback(
		(state: NonNullable<typeof loaded>, slot: string) => {
			if (unchanged(slot)) return false;
			const saved = readWizardDraftRecord(slot, kind);
			observed.current.set(slot, saved?.serialized ?? null);
			if (!saved) return false;
			present({
				...state,
				pendingKey: slot,
				pending: saved.draft,
				writeKey: slot,
			});
			return true;
		},
		[kind, unchanged, present],
	);
	const saveForm = useCallback(
		(state: NonNullable<typeof loaded>, contents: string) => {
			const snapshot = JSON.parse(contents);
			const key = state.key;
			const workingKey = `${key}:working`;
			const slot =
				state.writeKey === key && readWizardDraftRecord(workingKey, kind)
					? workingKey
					: state.writeKey;
			if (offerChangedDraft(state, slot)) return;
			const written = writeWizardDraft(
				slot,
				kind,
				snapshot.value,
				snapshot.step,
			);
			if (written) {
				observed.current.set(slot, written);
				accepted.current.set(slot, written);
				lastWritten.current.set(slot, {
					form: contents,
					record: written,
				});
				if (state.retained)
					accepted.current.set(key, observed.current.get(key) ?? null);
			}
		},
		[kind, offerChangedDraft],
	);
	const serialized = JSON.stringify({
		value: projectWizardDraft(kind, value),
		step,
	});
	const form = useRef(serialized);
	form.current = serialized;
	useEffect(() => {
		if (!key || completed.current === key || initialized.current === key)
			return;
		const baseline = form.current;
		let active = true;
		withWizardDraftLock(key, () => {
			if (!active || currentKey.current !== key || completed.current === key)
				return;
			initialized.current = key;
			const original = readWizardDraftRecord(key, kind);
			const workingKey = `${key}:working`;
			const working = readWizardDraftRecord(workingKey, kind);
			observed.current.set(key, original?.serialized ?? null);
			observed.current.set(workingKey, working?.serialized ?? null);
			const legacyOriginal =
				original?.draft.legacyVodFilters || original?.draft.legacyRenditions;
			const useWorking =
				!!working &&
				(!original || legacyOriginal || working.savedAt >= original.savedAt);
			present({
				key,
				writeKey: working ? workingKey : key,
				pendingKey: useWorking ? workingKey : key,
				retained: working && original && legacyOriginal ? original.draft : null,
				pending: (useWorking ? working : original)?.draft ?? null,
				baseline,
			});
		});
		return () => {
			active = false;
		};
	}, [key, kind, present]);
	useEffect(() => {
		if (
			!key ||
			loaded?.key !== key ||
			loaded.pending ||
			completed.current === key ||
			serialized === loaded.baseline
		)
			return;
		let active = true;
		const timer = setTimeout(
			() =>
				withWizardDraftLock(key, () => {
					if (
						!active ||
						currentKey.current !== key ||
						completed.current === key
					)
						return;
					saveForm(loaded, serialized);
				}),
			300,
		);
		return () => {
			active = false;
			clearTimeout(timer);
		};
	}, [key, serialized, loaded, saveForm]);
	const available = key !== null && loaded?.key === key && !!loaded.pending;
	return {
		available,
		pending: available ? loaded?.pending : null,
		retained: key && key === loaded?.key ? loaded.retained : null,
		restore(retainOriginal = false) {
			if (!key || !available || !loaded?.pending) return;
			const offered = loaded.pending;
			withWizardDraftLock(key, () => {
				if (
					!mounted.current ||
					latest.current?.pending !== offered ||
					currentKey.current !== key ||
					completed.current === key
				)
					return;
				// Recheck the offer when it is selected. Another tab may have saved
				// from the same preset while its legacy recovery dialog was open.
				if (offerChangedDraft(loaded, `${key}:working`)) return;
				if (offerChangedDraft(loaded, loaded.pendingKey)) return;
				accepted.current.set(
					loaded.pendingKey,
					observed.current.get(loaded.pendingKey) ?? null,
				);
				if (loaded.retained)
					accepted.current.set(key, observed.current.get(key) ?? null);
				onRestore(offered);
				// Keep the original v1 record in place, with its original expiry. A
				// separate scoped slot receives normal autosaves after metadata recovery.
				if (
					retainOriginal &&
					(offered.legacyVodFilters || offered.legacyRenditions)
				) {
					present({
						...loaded,
						pending: null,
						writeKey: `${key}:working`,
						baseline: "",
						retained: offered,
					});
				} else present({ ...loaded, pending: null });
			});
		},
		discard() {
			if (!key || loaded?.key !== key || !loaded.pending) return;
			const offered = loaded.pending;
			const expected = observed.current.get(loaded.pendingKey);
			withWizardDraftLock(key, () => {
				if (
					!mounted.current ||
					latest.current?.pending !== offered ||
					currentKey.current !== key ||
					completed.current === key
				)
					return;
				const legacy =
					loaded.pending?.legacyVodFilters || loaded.pending?.legacyRenditions;
				const workingKey = `${key}:working`;
				const working = legacy ? readWizardDraftRecord(workingKey, kind) : null;
				const keptAsRecovery = !!working;
				if (legacy)
					observed.current.set(workingKey, working?.serialized ?? null);
				if (
					!keptAsRecovery &&
					!matchesDraft(loaded.pendingKey, expected) &&
					offerChangedDraft(loaded, loaded.pendingKey)
				)
					return;
				if (!keptAsRecovery && matchesDraft(loaded.pendingKey, expected)) {
					discardWizardDraft(loaded.pendingKey);
					observed.current.set(loaded.pendingKey, null);
				}
				present({
					...loaded,
					writeKey: legacy ? workingKey : loaded.writeKey,
					retained: keptAsRecovery ? loaded.pending : loaded.retained,
					pending: null,
				});
			});
		},
		afterSubmission() {
			if (!loaded) return;
			// Removal uses only the key already bound to this form, including a
			// successful submit during session refresh or imported-plan mode.
			const workingKey = `${loaded.key}:working`;
			const expectedWorking = accepted.current.get(workingKey) ?? null;
			const expectedOriginal = accepted.current.get(loaded.key);
			// The debounce can save the submitted form while its request is in flight.
			function submitted(slot: string, expected: string | null | undefined) {
				const written = lastWritten.current.get(slot);
				return (
					matchesDraft(slot, expected) ||
					(written?.form === serialized && matchesDraft(slot, written.record))
				);
			}
			return () => {
				completed.current = loaded.key;
				return withWizardDraftLock(loaded.key, () => {
					const active = latest.current;
					const currentForm = form.current;
					if (
						active?.key === loaded.key &&
						!active.pending &&
						completionKey.current === loaded.key &&
						currentForm !== serialized
					) {
						// A sibling can submit and remove a revision we already saved.
						// Flush only a revision that has never been written by this form.
						const alreadyWritten = [loaded.key, workingKey].some(
							(slot) => lastWritten.current.get(slot)?.form === currentForm,
						);
						if (!alreadyWritten) saveForm(active, currentForm);
						return;
					}

					// A newer working form still owns its legacy recovery record. The
					// form just submitted can be cleared even if its original was removed.
					if (
						matchesDraft(workingKey, null) ||
						submitted(workingKey, expectedWorking)
					) {
						discardWizardDraft(workingKey);
						if (submitted(loaded.key, expectedOriginal))
							discardWizardDraft(loaded.key);
					}
					if (mounted.current && active?.key === loaded.key)
						present({ ...active, pending: null, retained: null });
				});
			};
		},
	};
}
