"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { canAccess } from "@/lib/auth/audience";
import { useRoleView } from "@/lib/auth/use-session";
import { useQcVmafEnabled } from "@/lib/feature-flags/context";
import { useT } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";
import { NAV_SECTIONS } from "./nav-items";

function isActive(pathname: string, href: string): boolean {
	if (href === "/") {
		return pathname === "/";
	}
	return pathname === href || pathname.startsWith(`${href}/`);
}

/** Only the deepest rendered destination describes the current page. */
function activeDestination(
	pathname: string,
	hrefs: readonly string[],
): string | undefined {
	let current: string | undefined;
	for (const href of hrefs) {
		if (
			isActive(pathname, href) &&
			(current === undefined || href.length > current.length)
		) {
			current = href;
		}
	}
	return current;
}

/**
 * The navigation itself — sections, the QC/VMAF flag filter, the ROLE filter
 * and the active-route marking — in ONE component with TWO renderers.
 *
 * The desktop `Sidebar` and the below-`md` `MobileNav` sheet both render this
 * element rather than each building the list from `NAV_SECTIONS`. A second copy
 * of the loop is exactly how the two shells drift: 's flag filter
 * would have to be remembered twice, the role filter (audit 5c3d97ca
 * MEDIUM-5) three times counting the page gate, and the `aria-current` rule
 * with them. The shells own their box (a sticky column versus a dialog
 * panel); they do not own what is in it.
 *
 * The role filter reads the same session cache the page gate and the session
 * menu read (`useRoleView`), so the three agree, and it fails CLOSED: while
 * the session is loading or could not be read, only floor-level links render
 * — a VIEWER never sees the ADMIN entries appear and then vanish.
 *
 * `flex-1 overflow-y-auto` is part of that contract and takes no prop: both
 * shells are full-height flex columns whose middle section scrolls, so a caller
 * that wanted something else would be a caller that had forked the layout.
 */
export function NavList() {
	const pathname = usePathname();
	const { t } = useT();
	const qcVmaf = useQcVmafEnabled();
	const { view } = useRoleView();
	const sections = NAV_SECTIONS.map((section) => ({
		...section,
		items: section.items.filter(
			(item) =>
				// : the QC entry only exists when the
				// deployment has QC/VMAF on.
				(item.href !== "/qc" || qcVmaf) && canAccess(item, view),
		),
	}));
	const activeHref = activeDestination(
		pathname,
		sections.flatMap((section) => section.items.map((item) => item.href)),
	);

	return (
		<nav className="flex-1 overflow-y-auto px-3 py-4">
			{sections.map((section) => {
				const { items } = section;
				// A heading over nothing would announce a section the role
				// cannot enter — the same dead end one level up.
				if (items.length === 0) {
					return null;
				}
				return (
					<div key={section.labelKey} className="mb-6">
						<p className="mb-2 px-2 font-medium text-[11px] text-zinc-500 uppercase tracking-wider">
							{t(section.labelKey)}
						</p>
						<ul className="space-y-0.5">
							{items.map((item) => {
								const active = item.href === activeHref;
								return (
									<li key={item.href}>
										<Link
											href={item.href}
											aria-current={active ? "page" : undefined}
											className={cn(
												"flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm transition-colors",
												active
													? "bg-zinc-800/80 text-zinc-50"
													: "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200",
											)}
										>
											<item.icon aria-hidden className="h-4 w-4" />
											{t(item.labelKey)}
										</Link>
									</li>
								);
							})}
						</ul>
					</div>
				);
			})}
		</nav>
	);
}
