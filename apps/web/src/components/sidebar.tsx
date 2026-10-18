"use client";

import { useT } from "@/lib/i18n/context";
import { AppBrand } from "./app-brand";
import { NavList } from "./nav-list";
import { SessionMenu } from "./session-menu";

/**
 * The persistent navigation column — `md` (768px) and up ONLY.
 *
 * `hidden md:flex` is load-bearing, not decoration. This column is a fixed
 * `w-60`/240px, and until 2026-08-29 it was rendered unconditionally: on a
 * 375px phone that left 135px of working area for tables the app renders at
 * desktop density (codex re-audit of main@eb7c983, MODERATE-2). Below `md` the
 * same navigation is reached through `MobileNav`'s sheet, which renders the
 * very same `NavList`.
 *
 * At `md` and up nothing about this column changed: `md:flex` restores the
 * `flex` the class list carried before, and every other class is untouched.
 */
export function Sidebar() {
	const { t } = useT();

	return (
		<aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-zinc-800 border-r bg-zinc-900/40 md:flex">
			<div className="border-zinc-800 border-b px-5 py-4">
				<AppBrand />
				<p className="mt-1 text-xs text-zinc-500">{t("nav.tagline")}</p>
			</div>
			<NavList />
			<div className="space-y-2 border-zinc-800 border-t px-5 py-3">
				<SessionMenu />
			</div>
		</aside>
	);
}
