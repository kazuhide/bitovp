"use client";

import { Menu, X } from "lucide-react";
import { usePathname } from "next/navigation";
import { Dialog as DialogPrimitive } from "radix-ui";
import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n/context";
import { AppBrand } from "./app-brand";
import { NavList } from "./nav-list";
import { SessionMenu } from "./session-menu";

/**
 * Tailwind 4's default `md`, spelled out because JavaScript cannot read a
 * utility class. It must stay in step with `Sidebar`'s `md:flex` and with this
 * bar's own `md:hidden`: the pair is what makes exactly one of the two
 * navigations present at any width.
 */
export const DESKTOP_MEDIA_QUERY = "(min-width: 48rem)";

/**
 * The below-`md` navigation: a compact top bar whose button opens the nav as a
 * left sheet.
 *
 * Why not `ui/dialog.tsx`, which wraps the same Radix primitive: that wrapper is
 * a centred `max-w-lg` card whose body is one `overflow-y-auto` block. A sheet
 * is a full-height edge panel with a fixed header, a scrolling middle and a
 * pinned footer — a different box, not a different width. Giving `Dialog` a
 * `side` prop for this one caller would thread an untested branch through every
 * dialog in the app, so this shares the primitive and not the wrapper.
 *
 * What Radix supplies and this component therefore does not reimplement:
 * Escape and outside-click dismissal (DismissableLayer), the focus trap and the
 * return of focus to the trigger on close (FocusScope), and the trigger's
 * `aria-expanded` / `aria-controls` / `aria-haspopup` wiring to the panel.
 */
export function MobileNav() {
	const { t } = useT();
	const pathname = usePathname();
	const [open, setOpen] = useState(false);

	/*
	 * A link inside the sheet navigates without unmounting the shell, so nothing
	 * else would close it: the operator would land on the new page behind a
	 * panel they then have to dismiss by hand.
	 *
	 * Adjusted DURING RENDER rather than in an effect, which is React's own
	 * answer for "reset state when a value changes" — an effect runs after
	 * paint, so the new route would be drawn once with the old sheet still over
	 * it. It also gives Biome an honest read: `useEffect(…, [pathname])` with a
	 * body that never mentions `pathname` is flagged as an extra dependency,
	 * and the rule is right that the value was not being used, only watched.
	 */
	const [routeAtRender, setRouteAtRender] = useState(pathname);
	if (routeAtRender !== pathname) {
		setRouteAtRender(pathname);
		setOpen(false);
	}

	/*
	 * Crossing into `md` while the sheet is open closes it.
	 *
	 * The bar below is `md:hidden`, but the sheet is PORTALLED to `document.body`
	 * and so sits outside that class: widen the window on an open sheet and the
	 * panel stays, covering the desktop sidebar it exists to replace. CSS cannot
	 * reach it and unmounting is the only honest fix, since a `display:none`
	 * dialog would still hold the focus trap.
	 *
	 * `matchMedia` is feature-detected: jsdom (this repo's test environment) does
	 * not implement it, and a bare call would throw on mount in every suite that
	 * renders the shell.
	 */
	useEffect(() => {
		if (!open || typeof window.matchMedia !== "function") {
			return;
		}
		const query = window.matchMedia(DESKTOP_MEDIA_QUERY);
		if (query.matches) {
			setOpen(false);
			return;
		}
		const onChange = (event: MediaQueryListEvent) => {
			if (event.matches) {
				setOpen(false);
			}
		};
		query.addEventListener("change", onChange);
		return () => query.removeEventListener("change", onChange);
	}, [open]);

	return (
		// `header`, not a div: a shell-level header is the `banner` landmark, and
		// none of the page-level `<header>`s in this app are (each sits inside
		// `<main>`, which strips the role). Sticky so the only way to the
		// navigation stays reachable from the bottom of a long table.
		<header className="sticky top-0 z-30 flex items-center gap-3 border-zinc-800 border-b bg-zinc-950/95 px-4 py-3 backdrop-blur md:hidden">
			<DialogPrimitive.Root open={open} onOpenChange={setOpen}>
				<DialogPrimitive.Trigger
					aria-label={t("nav.openMenu")}
					className="-ml-1 rounded-md p-1.5 text-zinc-400 transition-colors hover:bg-zinc-900 hover:text-zinc-100"
				>
					<Menu aria-hidden className="h-5 w-5" />
				</DialogPrimitive.Trigger>
				<DialogPrimitive.Portal>
					<DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-black/60" />
					<DialogPrimitive.Content className="fixed inset-y-0 left-0 z-50 flex w-72 max-w-[85vw] flex-col border-zinc-800 border-r bg-zinc-950 shadow-xl">
						<div className="flex items-start justify-between gap-4 border-zinc-800 border-b px-5 py-4">
							<div className="min-w-0">
								<DialogPrimitive.Title className="font-semibold text-sm text-zinc-50">
									{t("nav.menu")}
								</DialogPrimitive.Title>
								{/* Radix warns when a dialog has no Description, and
								    the sidebar header this panel stands in for
								    already carries one: the same tagline, under the
								    same brand. Reusing it keeps the two headers
								    saying the same thing in both languages. */}
								<DialogPrimitive.Description className="mt-1 text-xs text-zinc-500">
									{t("nav.tagline")}
								</DialogPrimitive.Description>
							</div>
							<DialogPrimitive.Close
								aria-label={t("common.close")}
								className="rounded-md p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
							>
								<X aria-hidden className="h-4 w-4" />
							</DialogPrimitive.Close>
						</div>
						<NavList />
						<div className="space-y-2 border-zinc-800 border-t px-5 py-3">
							<SessionMenu />
						</div>
					</DialogPrimitive.Content>
				</DialogPrimitive.Portal>
			</DialogPrimitive.Root>
			<AppBrand />
		</header>
	);
}
