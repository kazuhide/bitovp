"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { ApiError } from "./api";
import type { SessionDto } from "./auth/dto";
import { SESSION_QUERY_KEY, useSession } from "./auth/use-session";
import {
	type CreationBody,
	type CreationCompatibility,
	type CreationSeed,
	CreationSubmissionError,
	createSubmissionClient,
} from "./creation-submission";
import {
	CREATE_SESSION_CHANGED,
	CREATE_SESSION_HEADER,
	creationErrorCode,
} from "./creation-submission-contract";
import { useT } from "./i18n/context";
import { draftIdentity, type WizardDraftKind } from "./wizard-draft";

export function useCreationSubmission(
	kind: WizardDraftKind,
	context: string,
	prepareSeed = false,
) {
	// The page gate can populate a fresh cache before this form mounts. Its
	// observer still needs its own completed read before it can bind identity.
	const session = useSession({ refetchOnMount: "always" });
	const queryClient = useQueryClient();
	const { t } = useT();
	const identity =
		session.status === "success" &&
		session.isFetchedAfterMount &&
		session.fetchStatus !== "paused" &&
		!session.isFetching
			? draftIdentity(session.data)
			: null;
	const identityKey = identity ? JSON.stringify(identity) : null;
	const boundIdentity = useRef<string | null>(null);
	if (identityKey && !boundIdentity.current)
		boundIdentity.current = identityKey;
	const owner = boundIdentity.current;
	const verified = useRef(identity);
	verified.current = identity;
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
	function sessionStillVerified(verifiedOwner: string | null) {
		// TanStack resumes mutations before paused queries and before React
		// necessarily commits an observer update. Read the live query here.
		const state = queryClient.getQueryState<SessionDto>(SESSION_QUERY_KEY);
		return (
			state?.status === "success" &&
			state.fetchStatus === "idle" &&
			!state.isInvalidated &&
			JSON.stringify(draftIdentity(state.data)) === verifiedOwner
		);
	}
	return {
		seed,
		seedError,
		async submit<T>(
			intent: unknown,
			buildBody?: CreationBody,
			compatibility?: CreationCompatibility,
		): Promise<T> {
			// A paused request keeps its clicked scope; authorize it again with
			// the verified session in effect when transport actually resumes.
			const current = verified.current;
			const expectedScope = current
				? JSON.stringify([...current, kind, context])
				: null;
			if (
				!current ||
				JSON.stringify(current) !== owner ||
				expectedScope !== currentScope.current ||
				!sessionStillVerified(owner)
			)
				throw new ApiError(409, t("creationSubmission.sessionUnavailable"));
			if (prepareSeed && !seed)
				throw (
					seedError ??
					new ApiError(409, t("creationSubmission.sessionUnavailable"))
				);
			try {
				return await createSubmissionClient([...current, kind, context], {
					storage: sessionStorage,
					headers: { [CREATE_SESSION_HEADER]: JSON.stringify(current) },
					beforeSend: () => {
						if (
							currentScope.current !== expectedScope ||
							!sessionStillVerified(owner)
						)
							throw new ApiError(
								409,
								t("creationSubmission.sessionUnavailable"),
							);
					},
				}).submit<T>(intent, buildBody, compatibility);
			} catch (error) {
				if (creationErrorCode(error) === CREATE_SESSION_CHANGED)
					throw new ApiError(409, t("creationSubmission.sessionUnavailable"));
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
