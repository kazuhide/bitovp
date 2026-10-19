"use client";

import { useRef } from "react";
import { ApiError } from "./api";
import { useSession } from "./auth/use-session";
import {
	type CreationBody,
	CreationSubmissionError,
	createSubmissionClient,
} from "./creation-submission";
import { useT } from "./i18n/context";
import { draftIdentity, type WizardDraftKind } from "./wizard-draft";

export function useCreationSubmission(kind: WizardDraftKind, context: string) {
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
	return {
		async submit<T>(intent: unknown, buildBody?: CreationBody): Promise<T> {
			if (!identity || identityKey !== boundIdentity.current)
				throw new ApiError(409, t("creationSubmission.sessionUnavailable"));
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
