"use client";

import { useEffect, useRef, useState } from "react";
import { ApiError } from "./api";
import { useSession } from "./auth/use-session";
import {
	type CreationBody,
	type CreationSeed,
	CreationSubmissionError,
	createSubmissionClient,
} from "./creation-submission";
import { useT } from "./i18n/context";
import { draftIdentity, type WizardDraftKind } from "./wizard-draft";

export function useCreationSubmission(
	kind: WizardDraftKind,
	context: string,
	prepareSeed = false,
) {
	const session = useSession();
	const { t } = useT();
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
	const currentScope = useRef<string | null>(null);
	const scopeKey = identity
		? JSON.stringify([...identity, kind, context])
		: null;
	currentScope.current = scopeKey;
	const [prepared, setPrepared] = useState<{
		scopeKey: string;
		seed?: CreationSeed;
		error?: ApiError;
	}>();
	const seedScopeKey =
		prepareSeed && identityKey === boundIdentity.current ? scopeKey : null;
	useEffect(() => {
		if (!seedScopeKey) return;
		try {
			const seed = createSubmissionClient(JSON.parse(seedScopeKey), {
				storage: sessionStorage,
			}).getSeed();
			setPrepared({ scopeKey: seedScopeKey, seed });
		} catch {
			setPrepared({
				scopeKey: seedScopeKey,
				error: new ApiError(409, t("creationSubmission.storageUnavailable")),
			});
		}
	}, [seedScopeKey, t]);
	const seed =
		prepared?.scopeKey === seedScopeKey ? (prepared.seed ?? null) : null;
	const seedError =
		prepared?.scopeKey === seedScopeKey ? (prepared.error ?? null) : null;
	return {
		seed,
		seedError,
		async submit<T>(intent: unknown, buildBody?: CreationBody): Promise<T> {
			if (!identity || identityKey !== boundIdentity.current)
				throw new ApiError(409, t("creationSubmission.sessionUnavailable"));
			if (prepareSeed && !seed)
				throw (
					seedError ??
					new ApiError(409, t("creationSubmission.sessionUnavailable"))
				);
			try {
				return await createSubmissionClient([...identity, kind, context], {
					storage: sessionStorage,
					beforeSend: () => {
						if (currentScope.current !== scopeKey)
							throw new ApiError(
								409,
								t("creationSubmission.sessionUnavailable"),
							);
					},
				}).submit<T>(intent, buildBody);
			} catch (error) {
				if (error instanceof CreationSubmissionError)
					throw new ApiError(
						409,
						t(
							error.reason === "response"
								? "creationSubmission.responseUnavailable"
								: error.reason === "pendingLimit"
									? "creationSubmission.pendingLimit"
									: "creationSubmission.storageUnavailable",
						),
					);
				if (error instanceof DOMException && error.name === "SecurityError")
					throw new ApiError(409, t("creationSubmission.storageUnavailable"));
				throw error;
			}
		},
	};
}
