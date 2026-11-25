"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSession } from "./auth/use-session";
import {
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
	value,
	step,
	onRestore,
}: {
	kind: WizardDraftKind;
	context: string | null;
	value: unknown;
	step: number;
	onRestore: (draft: WizardDraft) => void;
}) {
	const session = useSession();
	// A warm cache, background read or failed read cannot authorize storage.
	const identity =
		session.status === "success" &&
		session.isFetchedAfterMount &&
		!session.isFetching
			? draftIdentity(session.data)
			: null;
	const identityKey = identity ? JSON.stringify(identity) : null;
	const boundIdentity = useRef<string | null>(null);
	if (identityKey && !boundIdentity.current)
		boundIdentity.current = identityKey;
	// Never migrate a mounted user's form to another user's/organization's draft.
	const key =
		identity && identityKey === boundIdentity.current && context !== null
			? draftKey(identity, kind, context)
			: null;
	const currentKey = useRef(key);
	currentKey.current = key;
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
	const offerChangedDraft = useCallback(
		(state: NonNullable<typeof loaded>, slot: string) => {
			if (unchanged(slot)) return false;
			const saved = readWizardDraftRecord(slot, kind);
			observed.current.set(slot, saved?.serialized ?? null);
			if (!saved) return false;
			setLoaded({
				...state,
				pendingKey: slot,
				pending: saved.draft,
				writeKey: slot,
			});
			return true;
		},
		[kind, unchanged],
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
			const working =
				kind === "vod" ? readWizardDraftRecord(workingKey, kind) : null;
			observed.current.set(key, original?.serialized ?? null);
			if (kind === "vod")
				observed.current.set(workingKey, working?.serialized ?? null);
			const useWorking =
				!!working &&
				(!original ||
					original.draft.legacyVodFilters ||
					working.savedAt >= original.savedAt);
			setLoaded({
				key,
				writeKey: working ? workingKey : key,
				pendingKey: useWorking ? workingKey : key,
				retained:
					working && original?.draft.legacyVodFilters ? original.draft : null,
				pending: (useWorking ? working : original)?.draft ?? null,
				baseline,
			});
		});
		return () => {
			active = false;
		};
	}, [key, kind]);
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
					const snapshot = JSON.parse(serialized);
					const workingKey = `${key}:working`;
					const slot =
						kind === "vod" &&
						loaded.writeKey === key &&
						readWizardDraftRecord(workingKey, kind)
							? workingKey
							: loaded.writeKey;
					if (offerChangedDraft(loaded, slot)) return;
					const written = writeWizardDraft(
						slot,
						kind,
						snapshot.value,
						snapshot.step,
					);
					if (written) {
						observed.current.set(slot, written);
						accepted.current.set(slot, written);
						if (loaded.retained)
							accepted.current.set(key, observed.current.get(key) ?? null);
					}
				}),
			300,
		);
		return () => {
			active = false;
			clearTimeout(timer);
		};
	}, [key, kind, serialized, loaded, offerChangedDraft]);
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
					currentKey.current !== key ||
					completed.current === key
				)
					return;
				// Recheck the offer when it is selected. Another tab may have saved
				// from the same preset while its legacy recovery dialog was open.
				if (kind === "vod" && offerChangedDraft(loaded, `${key}:working`))
					return;
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
				if (retainOriginal && kind === "vod" && offered.legacyVodFilters) {
					setLoaded({
						...loaded,
						pending: null,
						writeKey: `${key}:working`,
						baseline: "",
						retained: offered,
					});
				} else setLoaded({ ...loaded, pending: null });
			});
		},
		discard() {
			if (!key || loaded?.key !== key) return;
			withWizardDraftLock(key, () => {
				if (
					!mounted.current ||
					currentKey.current !== key ||
					completed.current === key
				)
					return;
				const legacy = kind === "vod" && loaded.pending?.legacyVodFilters;
				const workingKey = `${key}:working`;
				const working = legacy ? readWizardDraftRecord(workingKey, kind) : null;
				const keptAsRecovery = !!working;
				if (legacy)
					observed.current.set(workingKey, working?.serialized ?? null);
				if (!keptAsRecovery && unchanged(loaded.pendingKey)) {
					discardWizardDraft(loaded.pendingKey);
					observed.current.set(loaded.pendingKey, null);
				}
				setLoaded({
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
			return () => {
				completed.current = loaded.key;
				withWizardDraftLock(loaded.key, () => {
					// A newer working form still owns its legacy recovery record. The
					// form just submitted can be cleared even if its original was removed.
					if (kind !== "vod" || matchesDraft(workingKey, expectedWorking)) {
						if (kind === "vod") discardWizardDraft(workingKey);
						if (matchesDraft(loaded.key, expectedOriginal))
							discardWizardDraft(loaded.key);
					}
				});
				setLoaded({ ...loaded, pending: null, retained: null });
			};
		},
	};
}
