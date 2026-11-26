import { useMemo, useSyncExternalStore } from "react";
import { localePath, type SiteLocale } from "../site-config";

const PREFIX = "#/demo";
const BROWSE_REPLACE = "bitovp:demo-browse-replace";

/** Locale links navigate between static documents and retain the active demo screen. */
export function demoLocaleHref(
	locale: SiteLocale,
	location: Pick<Location, "search" | "hash">,
): string {
	return `${localePath(locale)}${location.search}${location.hash}`;
}

function subscribe(listener: () => void) {
	window.addEventListener("hashchange", listener);
	return () => window.removeEventListener("hashchange", listener);
}

export function replaceDemoBrowseUrl(url: string, state: unknown) {
	window.history.replaceState(state, "", url);
	// Update the locale links without remounting the active screen.
	window.dispatchEvent(new Event(BROWSE_REPLACE));
}

function subscribeLocation(listener: () => void) {
	const unsubscribe = subscribe(listener);
	window.addEventListener(BROWSE_REPLACE, listener);
	return () => {
		window.removeEventListener(BROWSE_REPLACE, listener);
		unsubscribe();
	};
}

const currentHref = () =>
	globalThis.window?.location.href ?? "https://demo.invalid/";

export function useDemoLocation() {
	return new URL(
		useSyncExternalStore(subscribeLocation, currentHref, currentHref),
	);
}

function currentRoute() {
	return window.location.hash.startsWith(PREFIX)
		? window.location.hash.slice(PREFIX.length) || "/"
		: "/";
}

export function demoHref(href: string) {
	if (href.startsWith("#") || !href.startsWith("/")) return href;
	return `${PREFIX}${href === "/" ? "" : href}`;
}

export function useDemoRoute() {
	return useSyncExternalStore(subscribe, currentRoute, () => "/");
}

export function usePathname() {
	return useDemoRoute().split("?")[0] || "/";
}

export function useSearchParams() {
	const route = useDemoRoute();
	return useMemo(() => new URLSearchParams(route.split("?")[1]), [route]);
}

const router = {
	push(href: string) {
		window.location.hash = demoHref(href);
	},
	replace(href: string) {
		window.location.replace(demoHref(href));
	},
	back() {
		window.history.back();
	},
	forward() {
		window.history.forward();
	},
	refresh() {
		window.location.reload();
	},
	prefetch() {},
};

export function useRouter() {
	return router;
}
