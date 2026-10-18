"use client";

import { useMutation } from "@tanstack/react-query";
import { LogOut } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { useSession } from "@/lib/auth/use-session";
import { useT } from "@/lib/i18n/context";
import { Button } from "./ui/button";

/** Sign-out affordance + the AUTH_MODE=none exposure badge, in the sidebar footer. */
export function SessionMenu() {
	const { t } = useT();
	const session = useSession();
	const signOut = useMutation({
		mutationFn: () =>
			apiFetch<{ ok: true }>("/api/auth/logout", { method: "POST" }),
		onSuccess: () => {
			window.location.assign("/login");
		},
	});

	const signOutControl = (identity: string | null) => (
		<div className="space-y-1">
			{identity ? (
				<p className="truncate px-2 text-[11px] text-zinc-400">{identity}</p>
			) : null}
			<Button
				variant="ghost"
				size="sm"
				className="-mx-2 w-full justify-start"
				onClick={() => signOut.mutate()}
				disabled={signOut.isPending}
			>
				<LogOut aria-hidden className="h-3.5 w-3.5" />
				{signOut.isPending ? t("nav.signingOut") : t("nav.signOut")}
			</Button>
		</div>
	);

	// Logout only clears cookies and does not need the user row. If the very
	// first session read fails, this is the one deterministic recovery still
	// available; hiding it traps both desktop and mobile shells behind a broken
	// identity read. We claim no identity in this state — only offer the clear.
	if (session.status === "error") {
		return signOutControl(null);
	}
	const data = session.data;
	if (!data) {
		return null;
	}
	if (data.mode === "none") {
		return (
			<p className="text-[11px] text-amber-500/80">{t("nav.authDisabled")}</p>
		);
	}
	// TanStack retains successful data after a background refetch fails. The
	// error arm above withholds that cached identity while retaining logout.
	const confirmedAuthenticated = data.configured && data.authenticated;
	if (!confirmedAuthenticated) {
		return null;
	}
	// #32 §6: displayName + role, read from the DB-RESOLVED source the session
	// endpoint returns (never a cookie claim — the cookie carries no role).
	const identity =
		session.status === "success" && data.displayName
			? t("nav.signedInAs", {
					name: data.displayName,
					role: data.role ?? "",
				})
			: null;
	return signOutControl(identity);
}
