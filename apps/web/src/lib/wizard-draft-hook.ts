"use client";
import { useEffect, useRef, useState } from "react";
import { useSession } from "./auth/use-session";
import {
	discardWizardDraft,
	draftIdentity,
	draftKey,
	projectWizardDraft,
	readWizardDraft,
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
	const [loaded, setLoaded] = useState<{
		key: string;
		pending: WizardDraft | null;
		baseline: string;
	}>();
	const serialized = JSON.stringify({
		value: projectWizardDraft(kind, value),
		step,
	});
	useEffect(() => {
		if (!key) return;
		if (completed.current === key) {
			discardWizardDraft(key);
			return;
		}
		setLoaded((previous) =>
			previous?.key === key
				? previous
				: {
						key,
						pending: readWizardDraft(key, kind),
						baseline: serialized,
					},
		);
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
			writeWizardDraft(key, kind, snapshot.value, snapshot.step);
		}, 300);
		return () => clearTimeout(timer);
	}, [key, kind, serialized, loaded]);
	const available = key !== null && loaded?.key === key && !!loaded.pending;
	return {
		available,
		restore() {
			if (!available || !loaded?.pending) return;
			onRestore(loaded.pending);
			setLoaded({ ...loaded, pending: null });
		},
		discard() {
			if (!key || loaded?.key !== key) return;
			discardWizardDraft(key);
			setLoaded({ ...loaded, pending: null });
		},
		clear() {
			if (!loaded) return;
			completed.current = loaded.key;
			// Removal uses only the key already bound to this form, including a
			// successful submit during session refresh or imported-plan mode.
			discardWizardDraft(loaded.key);
			setLoaded({ ...loaded, pending: null });
		},
	};
}
