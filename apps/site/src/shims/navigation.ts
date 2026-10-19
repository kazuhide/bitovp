import { useMemo, useSyncExternalStore } from "react";

const PREFIX = "#/demo";

function subscribe(listener: () => void) {
	window.addEventListener("hashchange", listener);
	return () => window.removeEventListener("hashchange", listener);
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
