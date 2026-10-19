"use client";

import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import { installTenantFetch } from "@/lib/tenant-fetch";
import { type RoleView, roleViewFromSession } from "./audience";
import type { SessionDto } from "./dto";

/**
 * The one query key every session reader shares. `SessionMenu` and the Users
 * screen also use this key. Role-sensitive surfaces read the SAME cache entry
 * through this hook, so a role refresh (refetch, invalidation,
 * `setQueryData`) re-filters all of them at once and no surface answers from a
 * stale copy.
 */
export const SESSION_QUERY_KEY = ["auth", "session"] as const;

/**
 * A role change advances `sessionsValidFrom`, so an already-open shell must
 * discover that its cookie is no longer valid without waiting for a remount.
 * Sixty seconds is the product's maximum revocation-observation window; focus
 * revalidation handles a tab that spent that interval in the background.
 */
export const SESSION_REFRESH_INTERVAL_MS = 60_000;

/** Session identity and role must never be satisfied by an HTTP cache. */
export async function fetchSession() {
	const session = await apiFetch<SessionDto>("/api/auth/session", {
		cache: "no-store",
	});
	if (session.configured && session.authenticated)
		installTenantFetch(
			session.organizationId ??
				(session.mode === "password" || session.mode === "none"
					? "00000000-0000-4000-8000-000000000001"
					: undefined),
		);
	return session;
}

export function useSession(options?: { refetchOnMount: "always" }) {
	return useQuery({
		queryKey: SESSION_QUERY_KEY,
		queryFn: fetchSession,
		refetchInterval: SESSION_REFRESH_INTERVAL_MS,
		refetchOnWindowFocus: "always",
		refetchOnMount: options?.refetchOnMount,
	});
}

export type RoleViewState = {
	readonly view: RoleView;
	/** TanStack's own status, kept beside the view because the gate renders
	 * "still checking" and "could not check" differently while `view` is
	 * `unresolved` for both. */
	readonly status: "pending" | "error" | "success";
	/** A successful session read proved the cookie absent, expired, or revoked.
	 * This is different from a transient read error: retry cannot revive it. */
	readonly reauthenticationRequired: boolean;
	readonly refetch: () => void;
};

/** The role view for the current session — see `roleViewFromSession`. */
export function useRoleView(): RoleViewState {
	const session = useSession();
	const trustedSession =
		session.status === "success" ? session.data : undefined;
	const confirmedUnauthenticated =
		session.data?.configured === true &&
		session.data.authenticated === false &&
		session.data.mode !== "none";
	return {
		// TanStack preserves the last successful data when a background refetch
		// fails. Never keep trusting a cached ADMIN answer in that error state,
		// but DO keep a cached authenticated:false answer: a later network error
		// cannot make a cookie that was already proved revoked valid again.
		view: roleViewFromSession(trustedSession),
		status: session.status,
		reauthenticationRequired: confirmedUnauthenticated,
		refetch: () => {
			void session.refetch();
		},
	};
}
