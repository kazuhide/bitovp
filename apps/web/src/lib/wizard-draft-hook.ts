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
	const completed = useRef<string | null>(null);
	const observed = useRef(new Map<string, string | null>());
	const unchanged = useCallback((slot: string): boolean => {
		try {
			return localStorage.getItem(slot) === observed.current.get(slot);
		} catch {
			return false;
		}
	}, []);
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
	useEffect(() => {
		if (!key) return;
		if (completed.current === key) return;
		setLoaded((previous) => {
			if (previous?.key === key) return previous;
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
			return {
				key,
				writeKey: working ? workingKey : key,
				pendingKey: useWorking ? workingKey : key,
				retained:
					working && original?.draft.legacyVodFilters ? original.draft : null,
				pending: (useWorking ? working : original)?.draft ?? null,
				baseline: serialized,
			};
		});
	}, [key, kind, serialized]);
	useEffect(() => {
		if (
			!key ||
			loaded?.key !== key ||
			loaded.pending ||
			completed.current === key ||
			serialized === loaded.baseline
		)
			return;
		const timer = setTimeout(() => {
			if (currentKey.current !== key || completed.current === key) return;
			const snapshot = JSON.parse(serialized);
			const workingKey = `${key}:working`;
			const slot =
				kind === "vod" &&
				loaded.writeKey === key &&
				readWizardDraftRecord(workingKey, kind)
					? workingKey
					: loaded.writeKey;
			if (!unchanged(slot)) {
				if (!offerChangedDraft(loaded, slot))
					setLoaded({ ...loaded, baseline: serialized });
				return;
			}
			const written = writeWizardDraft(
				slot,
				kind,
				snapshot.value,
				snapshot.step,
			);
			if (written) observed.current.set(slot, written);
		}, 300);
		return () => clearTimeout(timer);
	}, [key, kind, serialized, loaded, unchanged, offerChangedDraft]);
	const available = key !== null && loaded?.key === key && !!loaded.pending;
	return {
		available,
		pending: available ? loaded?.pending : null,
		retained: key && key === loaded?.key ? loaded.retained : null,
		restore(retainOriginal = false) {
			if (!available || !loaded?.pending) return;
			// Recheck the offer when it is selected. Another tab may have saved
			// from the same preset while its legacy recovery dialog was open.
			if (kind === "vod" && offerChangedDraft(loaded, `${key}:working`)) return;
			if (offerChangedDraft(loaded, loaded.pendingKey)) return;
			onRestore(loaded.pending);
			// Keep the original v1 record in place, with its original expiry. A
			// separate scoped slot receives normal autosaves after metadata recovery.
			if (retainOriginal && kind === "vod" && loaded.pending.legacyVodFilters) {
				setLoaded({
					...loaded,
					pending: null,
					writeKey: `${key}:working`,
					baseline: "",
					retained: loaded.pending,
				});
			} else setLoaded({ ...loaded, pending: null });
		},
		discard() {
			if (!key || loaded?.key !== key) return;
			const legacy = kind === "vod" && loaded.pending?.legacyVodFilters;
			const workingKey = `${key}:working`;
			const working = legacy ? readWizardDraftRecord(workingKey, kind) : null;
			const keptAsRecovery = !!working;
			if (legacy) observed.current.set(workingKey, working?.serialized ?? null);
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
		},
		clear() {
			if (!loaded) return;
			completed.current = loaded.key;
			// Removal uses only the key already bound to this form, including a
			// successful submit during session refresh or imported-plan mode.
			const workingKey = `${loaded.key}:working`;
			// A newer working form still owns its legacy recovery record. The
			// form just submitted can be cleared even if its original was removed.
			if (kind !== "vod" || unchanged(workingKey)) {
				if (kind === "vod") discardWizardDraft(workingKey);
				if (unchanged(loaded.key)) discardWizardDraft(loaded.key);
			}
			setLoaded({ ...loaded, pending: null, retained: null });
		},
	};
}
