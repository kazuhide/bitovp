"use client";

import type { UserRole } from "@bitovp/db";
import Link from "next/link";
import type { ReactNode } from "react";
import { canAccess, isFloor, pageAccess } from "@/lib/auth/audience";
import { loginPath } from "@/lib/auth/gate";
import { useRoleView } from "@/lib/auth/use-session";
import { useT } from "@/lib/i18n/context";
import { Button } from "./ui/button";

/**
 * The permission screen a DIRECT URL to a privileged page renders
 * — one component, mounted once by
 * `PageAccessGate`, never copied per page.
 *
 * Exported on its own so a surface that gates something narrower than a
 * route (a card, a panel) can show the same words. The API's 403 is
 * untouched underneath: this explains it, it does not replace it.
 */
export function PermissionDenied({
	required,
	current,
}: {
	required: UserRole;
	current: UserRole;
}) {
	const { t } = useT();
	return (
		<section className="mx-auto max-w-md py-16 text-center">
			<p className="font-mono text-6xl text-zinc-700">403</p>
			<h1 className="mt-4 font-semibold text-lg text-zinc-100">
				{t("permission.title")}
			</h1>
			<p role="alert" className="mt-2 text-sm text-zinc-400">
				{t("permission.body")}
			</p>
			{/* The role names are the model's own enum values, the same spelling
			 * the session menu shows beside the display name and the Users
			 * screen's intro uses — a localized synonym here would give the
			    operator a name the administrator's screen does not. */}
			<p className="mt-3 font-mono text-xs text-zinc-400">
				{t("permission.roles", { required, current })}
			</p>
			<Link
				href="/"
				className="mt-6 inline-block text-sm text-emerald-400 hover:text-emerald-300"
			>
				{t("notFound.backToDashboard")}
			</Link>
		</section>
	);
}

/** A successful session read proved that retrying the dead cookie cannot help. */
function PermissionReauthentication({ returnTo }: { returnTo: string }) {
	const { t } = useT();
	return (
		<section className="mx-auto max-w-md py-16 text-center">
			<h1 className="font-semibold text-lg text-zinc-100">
				{t("permission.reauthenticationTitle")}
			</h1>
			<p role="alert" className="mt-2 text-sm text-zinc-400">
				{t("permission.reauthenticationBody")}
			</p>
			<Link
				href={loginPath(returnTo)}
				className="mt-6 inline-block rounded-md bg-zinc-100 px-3 py-1.5 font-medium text-sm text-zinc-900 hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
			>
				{t("permission.reauthenticationAction")}
			</Link>
		</section>
	);
}

/**
 * `PageAccessGate` receives the pathname from the shell, but a reauthentication
 * round trip must preserve query-driven state too (selected VMAF jobs, wizard
 * presets, list filters). The unauthenticated answer arrives asynchronously in
 * the browser, so `location.search` is available when this branch renders; the
 * server fallback remains the pathname rather than guessing a query.
 */
function reauthenticationReturnTo(pathname: string): string {
	return typeof window === "undefined"
		? pathname
		: `${pathname}${window.location.search}`;
}

/** Fail closed while the role is unknown: a skeleton, not the page. */
function PermissionChecking() {
	const { t } = useT();
	return (
		<div
			role="status"
			aria-busy="true"
			aria-label={t("permission.checking")}
			className="mx-auto max-w-md py-16"
		>
			<div
				aria-hidden
				className="mx-auto h-4 w-40 animate-pulse rounded bg-zinc-800"
			/>
		</div>
	);
}

/**
 * The session could not be read (network, a 5xx, an expired cookie in a stale
 * tab). Still fail closed — but a skeleton that never resolves is its own dead
 * end, so this one says so and offers the retry.
 */
function PermissionUnverified({ onRetry }: { onRetry: () => void }) {
	const { t } = useT();
	return (
		<section className="mx-auto max-w-md py-16 text-center">
			<h1 className="font-semibold text-lg text-zinc-100">
				{t("permission.title")}
			</h1>
			<p role="alert" className="mt-2 text-sm text-zinc-400">
				{t("permission.unverified")}
			</p>
			<Button variant="secondary" size="sm" className="mt-6" onClick={onRetry}>
				{t("permission.retry")}
			</Button>
		</section>
	);
}

/**
 * Decides, from `PAGE_ACCESS_RULES` and the session's role view, whether the
 * page under `pathname` renders or the permission screen does.
 *
 * Floor-level pages (every customer destination, the Settings landing) are
 * never held back — the proxy's page gate already decided the caller is
 * signed in, and holding a list behind a second round trip would slow every
 * page to protect nothing. Only a page whose data sits above the VIEWER
 * floor waits for the role, and it waits CLOSED: the skeleton until the
 * session answers, the retry screen if it cannot, the permission screen if
 * the role is too low, and the page only once the role clears the floor (or
 * the install has no role model at all — single-owner modes keep today's
 * behaviour).
 */
export function PageAccessGate({
	pathname,
	children,
}: {
	pathname: string;
	children: ReactNode;
}) {
	const access = pageAccess(pathname);
	const { view, status, reauthenticationRequired, refetch } = useRoleView();
	// A successful authenticated:false answer is stronger than the page floor:
	// the browser proved this cookie is absent/expired/revoked. AUTH_MODE=none
	// never sets reauthenticationRequired, so its intentionally open behaviour
	// remains below. This must precede BOTH early returns (floor and
	// single-owner/password) or a stale tab keeps rendering cached page content.
	if (reauthenticationRequired) {
		return (
			<PermissionReauthentication
				returnTo={reauthenticationReturnTo(pathname)}
			/>
		);
	}
	if (isFloor(access) || view.kind === "single-owner") {
		return children;
	}
	if (view.kind === "role") {
		return canAccess(access, view) ? (
			children
		) : (
			<PermissionDenied required={access.minRole} current={view.role} />
		);
	}
	return status === "pending" ? (
		<PermissionChecking />
	) : (
		<PermissionUnverified onRetry={refetch} />
	);
}
