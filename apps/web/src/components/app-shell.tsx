"use client";

import { usePathname } from "next/navigation";
import { type ReactNode, useState } from "react";
import { useT } from "@/lib/i18n/context";
import { BrandingProvider } from "./branding-provider";
import { MobileNav } from "./mobile-nav";
import { OrganizationMenu } from "./organization-menu";
import { PageAccessGate } from "./page-access-gate";
import { PageContextSlot } from "./page-context";
import { Sidebar } from "./sidebar";

/** The login screen renders standalone — the shell's nav belongs to signed-in
 * users. /setup (#32 §3c first-boot) and /change-password (forced rotate)
 * join it: both serve people the nav must not pretend are signed in. */
export function AppShell({ children }: { children: ReactNode }) {
	const { t } = useT();
	const pathname = usePathname();
	const [contextSlot, setContextSlot] = useState<HTMLDivElement | null>(null);
	if (
		pathname === "/login" ||
		pathname === "/setup" ||
		pathname === "/change-password"
	) {
		return (
			<main className="flex min-h-screen items-center justify-center px-4 py-10">
				{children}
			</main>
		);
	}
	/*
	 * Two navigations, one visible at a time, chosen by CSS rather than by a
	 * media-query hook — so the server and the first client render agree and
	 * neither shell flashes during hydration.
	 *
	 * `flex-col md:flex-row` is how the stack becomes a column pair: below `md`
	 * the bar sits above `main`, and at `md` the row direction is the flex
	 * default again, which is what this container had before the mobile bar
	 * existed. Likewise `px-4 md:px-8` — `md` and up is the original `px-8`;
	 * only the narrow case, where 64px of horizontal padding was competing with
	 * the content for a 375px screen, changed.
	 */
	/*
	 * The page gate sits HERE, around every page's children, and nowhere
	 * else: a direct URL to a privileged page gets the shared permission
	 * screen from the shell, so no
	 * page carries its own copy and a page added later is covered the moment
	 * its rule lands in PAGE_ACCESS_RULES.
	 */
	return (
		<BrandingProvider>
			<div className="flex min-h-screen flex-col md:flex-row">
				<a
					href="#page-content"
					className="sr-only fixed top-2 left-2 z-[60] rounded-md bg-zinc-100 px-4 py-2 text-sm text-zinc-900 focus:not-sr-only focus:outline-2 focus:outline-emerald-500"
				>
					{t("shell.skipToContent")}
				</a>
				<MobileNav />
				<Sidebar />
				<main
					id="page-content"
					tabIndex={-1}
					className="flow-root min-w-0 flex-1 px-4 py-6 md:px-8"
				>
					<PageContextSlot.Provider value={contextSlot}>
						<OrganizationMenu>
							<div ref={setContextSlot} />
						</OrganizationMenu>
						<PageAccessGate pathname={pathname}>{children}</PageAccessGate>
					</PageContextSlot.Provider>
				</main>
			</div>
		</BrandingProvider>
	);
}
